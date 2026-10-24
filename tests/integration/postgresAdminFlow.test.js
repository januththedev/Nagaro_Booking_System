import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPostgresTestDb } from '../helpers/postgresTestDb.js';
import { createTestActor, TEST_PASSWORD } from '../helpers/testDb.js';
import { createApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { provisionProductionCatalogue } from '../../src/server/db/provisionCatalogue.js';
import { seedDemoContent } from '../../src/server/db/seed.js';
import { assertPostgresSchemaReady } from '../../src/server/db/schemaReadiness.js';
import { createSession, resolveSession, csrfTokenFor } from '../../src/server/security/sessions.js';

test('PostgreSQL release: actual migrations, real sign-in and every reachable staff GET', { timeout: 120000 }, async (t) => {
  const db = await createPostgresTestDb();
  t.after(() => db.close());
  assertPostgresSchemaReady(db);
  const actor = createTestActor(db, { role: 'SUPER_ADMIN' });
  provisionProductionCatalogue(db, { actor });
  seedDemoContent(db, { actor });
  const app = createApp({ db, config: loadConfig() });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(origin + '/admin/login', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ email: 'ADMIN@test.local', password: TEST_PASSWORD }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.match(cookie, /nagaro_session=/);
  const queue = ['/admin', '/admin/calendar', '/admin/calendar?view=week', '/admin/reservations',
    '/admin/reservations/new', '/admin/spaces', '/admin/spaces/new', '/admin/customers',
    '/admin/customers/new', '/admin/inquiries', '/admin/booking-requests', '/admin/maintenance',
    '/admin/search?q=Acacia', '/admin/team', '/admin/notifications', '/admin/guider-knowledge', '/admin/audit', '/admin/account',
    '/api/admin/dashboard/summary', '/api/admin/notifications'];
  const visited = new Set();
  const actions = new Set();
  while (queue.length) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    assert.ok(visited.size <= 180, 'bounded staff navigation crawl');
    const res = await fetch(origin + path, { headers: { cookie }, redirect: 'manual' });
    const text = await res.text();
    await t.test(`GET ${path}`, () => {
      assert.ok(res.status < 400, `${res.status}: ${text.slice(0, 180)}`);
      assert.doesNotMatch(text, /Reference: <code>INTERNAL_ERROR/);
    });
    if (res.status !== 200 || !res.headers.get('content-type')?.includes('text/html')) continue;
    for (const form of text.matchAll(/<form\b([^>]*)>/g)) {
      const method = /method="([^"]+)"/i.exec(form[1])?.[1]?.toUpperCase() || 'GET';
      const action = /action="([^"]+)"/i.exec(form[1])?.[1]?.replaceAll('&amp;', '&') || path;
      if (method === 'DIALOG' || !action.startsWith('/admin')) continue;
      const target = new URL(action, origin).pathname;
      assert.ok(app.match(method, target)?.route, `${method} ${target} must have a registered handler`);
      if (method === 'POST') actions.add(target);
    }
    for (const match of text.matchAll(/href="(\/admin[^"#]*)"/g)) {
      const link = match[1].replaceAll('&amp;', '&');
      // Crawl detail/form links once. Paging/filter combinations are covered by route suites.
      if (!link.includes('?') && !visited.has(link)) queue.push(link);
    }
  }
  for (const action of actions) {
    const response = await fetch(origin + action, { method: 'POST', headers: { cookie, Accept: 'application/json' }, redirect: 'manual' });
    assert.equal(response.status, 403, `${action} rejects a form submission without CSRF`);
  }
  const sessionToken = /nagaro_session=([^;]+)/.exec(cookie)[1];
  const csrf = csrfTokenFor(resolveSession(db, sessionToken).csrfSecret);
  const reservation = db.prepare("SELECT r.* FROM reservation r JOIN space s ON s.id=r.space_id WHERE r.status='CONFIRMED' AND s.category='MEETING_ROOM' ORDER BY r.id LIMIT 1").get();
  const startAt = Date.parse('2035-03-20T09:00:00+05:30');
  const endAt = Date.parse('2035-03-20T11:00:00+05:30');
  const move = await fetch(origin + '/api/admin/calendar/reschedule', {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ id: reservation.id, startAt, endAt }),
  });
  assert.equal(move.status, 200, await move.clone().text());
  const saved = db.prepare('SELECT start_at,end_at FROM reservation WHERE id=?').get(reservation.id);
  assert.equal(Number(saved.start_at), startAt);
  assert.equal(Number(saved.end_at), endAt);
  const occupancy = db.prepare("SELECT start_at,end_at FROM occupancy WHERE reservation_id=? AND status='ACTIVE'").get(reservation.id);
  assert.equal(Number(occupancy.start_at), startAt, 'calendar move updates the actual blocking inventory');
  const invalidMove = await fetch(origin + '/api/admin/calendar/reschedule', {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ id: reservation.id, startAt: endAt, endAt: startAt }),
  });
  assert.equal(invalidMove.status, 422);
  assert.equal(Number(db.prepare('SELECT start_at FROM reservation WHERE id=?').get(reservation.id).start_at), startAt);
  t.diagnostic('Calendar reschedule changes reservation and active occupancy; invalid move leaves data unchanged.');
  t.diagnostic(`Validated ${actions.size} rendered admin mutation targets and their CSRF boundary.`);
  t.diagnostic(`Exercised ${visited.size} authenticated staff destinations against PostgreSQL.`);
});

test('outdated PostgreSQL account schema reproduces post-login crash and is caught by readiness', { timeout: 60000 }, async (t) => {
  const db = await createPostgresTestDb();
  t.after(() => db.close());
  const actor = createTestActor(db, { role: 'SUPER_ADMIN' });
  const session = createSession(db, { adminUserId: actor.id });
  db.exec('ALTER TABLE admin_user DROP COLUMN must_change_password');
  assert.throws(() => resolveSession(db, session.token), /must_change_password/);
  assert.throws(() => assertPostgresSchemaReady(db), /schema is out of date.*migrate:postgres/);
  const app = createApp({ db, config: loadConfig() });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `nagaro_session=${session.token}` };
  const publicResponse = await fetch(origin + '/api/public/spaces', { headers });
  assert.equal(publicResponse.status, 200, 'broken staff session must not break public APIs');
  const staffResponse = await fetch(origin + '/admin', { headers });
  assert.equal(staffResponse.status, 503);
  assert.match(await staffResponse.text(), /SCHEMA_OUTDATED/);
  db.exec('ALTER TABLE admin_user ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  const recovered = await fetch(origin + '/admin', { headers });
  assert.equal(recovered.status, 200, 'staff console recovers after schema repair without restart');
});
