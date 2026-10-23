import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTestDb, closeTestDb, createTestActor } from '../helpers/testDb.js';
import { createApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { createSession, csrfTokenFor } from '../../src/server/security/sessions.js';
import { createNotificationsForAdmins, listNotifications } from '../../src/server/services/notificationService.js';

async function startApp(db) {
  const config = { ...loadConfig(), port: 0, host: '127.0.0.1', forceSecureCookies: false };
  const app = createApp({ db, config });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function sessionFor(db, actor) {
  const session = createSession(db, { adminUserId: actor.id });
  return {
    cookie: `nagaro_session=${encodeURIComponent(session.token)}`,
    csrf: csrfTokenFor(session.csrfSecret),
  };
}

test('notification API is authenticated, CSRF-protected and isolated per administrator', async () => {
  const db = createTestDb();
  let server;
  try {
    const first = createTestActor(db, { email: 'first@test.local', role: 'ADMIN' });
    const second = createTestActor(db, { email: 'second@test.local', role: 'ADMIN' });
    createNotificationsForAdmins(db, {
      type: 'NEW_BOOKING', title: 'First only', body: 'Hello', dedupeKey: 'first:only',
      excludeAdminUserId: second.id,
    });
    const started = await startApp(db);
    server = started.server;
    const base = started.baseUrl;

    let response = await fetch(`${base}/api/admin/notifications`);
    assert.equal(response.status, 401);

    const firstSession = sessionFor(db, first);
    response = await fetch(`${base}/api/admin/notifications`, { headers: { cookie: firstSession.cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.unreadCount, 1);

    response = await fetch(`${base}/api/admin/notifications/read-all`, {
      method: 'POST', headers: { cookie: firstSession.cookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 403, 'missing CSRF token is refused');

    response = await fetch(`${base}/api/admin/notifications/read-all`, {
      method: 'POST',
      headers: { cookie: firstSession.cookie, 'content-type': 'application/json', 'x-csrf-token': firstSession.csrf },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(listNotifications(db, { adminUserId: first.id }).unreadCount, 0);
    assert.equal(listNotifications(db, { adminUserId: second.id }).items.length, 0, 'other admins never see the notification');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeTestDb(db);
  }
});

test('team routes are Super Admin only and enforce the three-seat cap', async () => {
  const db = createTestDb();
  let server;
  try {
    const superAdmin = createTestActor(db, { email: 'super@test.local', role: 'SUPER_ADMIN' });
    const ordinary = createTestActor(db, { email: 'ordinary@test.local', role: 'ADMIN' });
    const started = await startApp(db);
    server = started.server;
    const base = started.baseUrl;
    const superSession = sessionFor(db, superAdmin);
    const ordinarySession = sessionFor(db, ordinary);

    let response = await fetch(`${base}/admin/team`, { headers: { cookie: ordinarySession.cookie } });
    assert.equal(response.status, 403);

    response = await fetch(`${base}/admin/team`, { headers: { cookie: superSession.cookie } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Team &amp; access|Super Admin/);

    const create = async (email, role) => {
      const res = await fetch(`${base}/admin/team`, {
        method: 'POST',
        headers: { cookie: superSession.cookie, 'content-type': 'application/json', 'x-csrf-token': superSession.csrf },
        body: JSON.stringify({ email, display_name: email, role, generate: '1' }),
      });
      return { status: res.status, text: await res.text() };
    };

    assert.equal((await create('second-super@test.local', 'SUPER_ADMIN')).status, 200);
    assert.equal((await create('third-super@test.local', 'SUPER_ADMIN')).status, 200);
    const capped = await create('fourth-super@test.local', 'SUPER_ADMIN');
    assert.equal(capped.status, 409);
    assert.match(capped.text, /at most 3 active Super Admins/i);

    const created = await create('delete-me@test.local', 'ADMIN');
    assert.equal(created.status, 200);
    const row = db.prepare('SELECT id FROM admin_user WHERE email = ?').get('delete-me@test.local');
    response = await fetch(`${base}/admin/team/${row.id}/delete`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: superSession.cookie, 'content-type': 'application/json', 'x-csrf-token': superSession.csrf },
      body: '{}',
    });
    assert.equal(response.status, 303);
    assert.ok(db.prepare('SELECT deleted_at FROM admin_user WHERE id = ?').get(row.id).deleted_at);

    response = await fetch(`${base}/admin/team/${row.id}/restore`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: superSession.cookie, 'content-type': 'application/json', 'x-csrf-token': superSession.csrf },
      body: '{}',
    });
    assert.equal(response.status, 303);
    assert.equal(db.prepare('SELECT deleted_at FROM admin_user WHERE id = ?').get(row.id).deleted_at, null);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeTestDb(db);
  }
});
