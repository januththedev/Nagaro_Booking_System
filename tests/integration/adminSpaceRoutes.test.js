/**
 * HTTP-level tests for the admin catalogue routes.
 *
 * Real HTTP: a real router, a real `node:http` server on port 0, real `fetch`
 * requests, and a real temp-file SQLite database with the production
 * migrations applied.
 *
 * LIMITATION — session middleware is emulated, not exercised.
 * `app.js`'s session middleware resolves an actor from the `nagaro_session`
 * cookie via the auth routes, and those routes are owned by another
 * workstream. This file therefore registers ONLY the space routes and installs
 * a tiny middleware that sets `ctx.actor`, `ctx.session` and `ctx.csrfToken`
 * from a fixture (unless the request carries `x-test-anonymous: 1`, which
 * simulates an anonymous visitor). Mutations then send the matching `_csrf`
 * body field, so the CSRF wiring and every handler decision are tested for
 * real; only the cookie→actor resolution is stubbed. The fixture administrator
 * row is inserted with a genuine `hashPassword` hash so audit-log foreign keys
 * resolve exactly as they do in production.
 *
 * Photograph *upload* (`POST /admin/spaces/:id/images`, multipart) belongs to
 * `adminUploadRoutes.js`, so image fixtures are inserted with
 * `addImageRecord` directly; the cover/reorder/delete actions this module owns
 * are driven over HTTP.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { AppError } from '../../src/server/domain/errors.js';
import { businessLocalToEpoch, todayBusinessDate } from '../../src/server/domain/time.js';
import { createRouter } from '../../src/server/http/router.js';
import { registerAdminSpaceRoutes } from '../../src/server/routes/adminSpaceRoutes.js';
import { hashPassword } from '../../src/server/security/passwords.js';
import { csrfTokenFor, requireAuth, requireCsrf } from '../../src/server/security/sessions.js';
import { addImageRecord, listImages } from '../../src/server/services/spaceService.js';
import { createReservation } from '../../src/server/services/bookingService.js';

const CSRF_SECRET = 'integration-test-csrf-secret';
const CSRF_TOKEN = csrfTokenFor(CSRF_SECRET);
const ACTOR = {
  id: 1,
  email: 'admin@test.local',
  displayName: 'Routes Tester',
  role: 'ADMIN',
  label: 'Routes Tester (ADMIN)',
};

let dir;
let db;
let server;
let baseUrl;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nagaro-admin-space-routes-'));
  db = new DatabaseSync(join(dir, 'test.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  const now = Date.now();
  db.prepare(`
    INSERT INTO admin_user (id, email, password_hash, display_name, role, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,1,?,?)
  `).run(ACTOR.id, ACTOR.email, hashPassword('TestPassword123'), ACTOR.displayName, ACTOR.role, now, now);

  const started = await startServer({ db, requireAuth, requireCsrf });
  server = started.server;
  baseUrl = started.baseUrl;
});

after(async () => {
  await closeServer(server);
  try { db.close(); } catch { /* already closed */ }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); break; } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

/* ------------------------------------------------------------- test harness */

async function startServer(deps) {
  const router = createRouter();

  // The stand-in for app.js's session middleware. See the file header.
  router.use(async (ctx) => {
    if (ctx.req.headers['x-test-anonymous'] === '1') {
      ctx.flash = null;
      ctx.csrfToken = '';
      return true;
    }
    ctx.actor = ACTOR;
    ctx.session = { sessionId: 1, csrfSecret: CSRF_SECRET, expiresAt: Date.now() + 3600_000 };
    ctx.csrfToken = CSRF_TOKEN;
    ctx.flash = null;
    return true;
  });

  router.onError(async (ctx, error) => {
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    ctx.json({
      ok: false,
      error: {
        code,
        message: error instanceof AppError ? error.message : 'Internal error',
        details: error instanceof AppError ? (error.details ?? null) : null,
      },
    }, status);
  });

  registerAdminSpaceRoutes(router, deps);

  const instance = createServer((req, res) => {
    Promise.resolve(router.handle(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
      } else if (typeof console !== 'undefined') {
        console.error('[test-server]', error);
      }
    });
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return { server: instance, baseUrl: `http://127.0.0.1:${instance.address().port}` };
}

function closeServer(instance) {
  if (!instance) return Promise.resolve();
  return new Promise((resolve) => instance.close(resolve));
}

function formBody(fields) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) form.append(key, String(item));
    else form.set(key, String(value));
  }
  return form.toString();
}

async function get(path, { anonymous = false } = {}) {
  return fetch(`${baseUrl}${path}`, {
    headers: anonymous ? { 'x-test-anonymous': '1' } : {},
    redirect: 'manual',
  });
}

async function post(path, fields = {}, { csrf = CSRF_TOKEN } = {}) {
  const body = formBody(csrf === null ? fields : { ...fields, _csrf: csrf });
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
}

/** The one-shot flash cookie written by the route module. */
function flashFrom(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const pair = cookies.map((cookie) => cookie.split(';')[0]).find((cookie) => cookie.startsWith('nagaro_flash='));
  if (!pair) return null;
  return JSON.parse(decodeURIComponent(pair.slice('nagaro_flash='.length)));
}

function spaceRow(code) {
  return db.prepare('SELECT * FROM space WHERE code = ?').get(code);
}

function countSpaces() {
  return db.prepare('SELECT COUNT(*) AS c FROM space').get().c;
}

function spaceIdFromRedirect(response) {
  const location = response.headers.get('location') ?? '';
  const match = /^\/admin\/spaces\/(\d+)$/.exec(location);
  assert.ok(match, `expected a space detail redirect, got ${location || '(none)'}`);
  return { id: Number(match[1]), location };
}

/**
 * The exact field names the create/edit form submits. Everything except the
 * photograph is filled in, so the space is publishable as soon as one image
 * record exists.
 */
function createFields(overrides = {}) {
  return {
    code: 'MR-01',
    name: 'Meeting room 1',
    category: 'MEETING_ROOM',
    short_description: 'A quiet room for four on the second floor.',
    description: 'A quiet meeting room with a table for four, a display screen and a whiteboard.',
    location: 'Trace Expert City, Building A',
    floor: '2nd floor',
    capacity: '4',
    currency: 'LKR',
    pricing_unit: 'HOUR',
    min_duration_minutes: '60',
    max_duration_minutes: '',
    buffer_minutes: '15',
    open_time: '08:00',
    close_time: '18:00',
    contact_note: 'Extension 214',
    rates_HOUR: '1500.00',
    rates_HALF_DAY: '',
    rates_DAY: '',
    rates_WEEK: '',
    rates_MONTH: '',
    'attributes_meeting[layout]': 'Boardroom',
    'attributes_meeting[flipchart]': '1',
    'attributes_auditorium[seating_capacity]': '80',
    'attributes_coworking[desk_area]': 'Open plan',
    desk_count: '12',
    amenities: ['Projector', 'Whiteboard'],
    amenities_other: 'Catering, Rooftop terrace',
    ...overrides,
  };
}

/* ------------------------------------------------------------------- tests */

describe('admin space routes', () => {
  test('an anonymous request is rejected and never reaches the catalogue', async () => {
    const list = await get('/admin/spaces', { anonymous: true });
    assert.equal(list.status, 401);
    const body = await list.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');

    const create = await get('/admin/spaces/new', { anonymous: true });
    assert.equal(create.status, 401);
  });

  test('a mutation without a valid CSRF token is rejected and writes nothing', async () => {
    const before = countSpaces();

    const missing = await post('/admin/spaces', createFields(), { csrf: null });
    assert.equal(missing.status, 403);

    const wrong = await post('/admin/spaces', createFields(), { csrf: 'not-the-right-token' });
    assert.equal(wrong.status, 403);

    assert.equal(countSpaces(), before, 'a rejected CSRF check must not create a row');
  });

  test('GET /admin/spaces renders the catalogue with filters and a New space action', async () => {
    const response = await get('/admin/spaces?status=all&category=MEETING_ROOM&sort=updated&q=room');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /adminShell|admin-shell/);
    assert.match(html, /href="\/admin\/spaces\/new"/);
    assert.match(html, /name="status"/);
    assert.match(html, /name="category"/);
    assert.match(html, /name="sort"/);
    assert.match(html, /name="q"/);
  });

  test('GET /admin/spaces/new renders the create form with the documented field names', async () => {
    const response = await get('/admin/spaces/new');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /action="\/admin\/spaces" method="post"|method="post" action="\/admin\/spaces"/);
    assert.match(html, /name="rates_HOUR"/);
    assert.match(html, /name="rates_MONTH"/);
    assert.match(html, /name="attributes_meeting\[layout\]"/);
    assert.match(html, /name="attributes_auditorium\[seating_capacity\]"/);
    assert.match(html, /name="attributes_coworking\[desk_area\]"/);
    assert.match(html, /name="desk_count"/);
    assert.match(html, /name="amenities"/);
    assert.match(html, /name="amenities_other"/);
    assert.match(html, /name="_csrf"/);
  });

  test('POST /admin/spaces with an invalid payload re-renders the form with 422 and creates nothing', async () => {
    const before = countSpaces();

    const missingName = await post('/admin/spaces', createFields({ name: '', code: 'MR-BAD-1' }));
    assert.equal(missingName.status, 422);
    const nameHtml = await missingName.text();
    assert.match(nameHtml, /id="name-error"/);
    assert.match(nameHtml, /aria-describedby="name-error"/);
    assert.match(nameHtml, /aria-invalid="true"/);
    assert.match(nameHtml, /name is required/i);
    assert.match(nameHtml, /id="rateSummary"|Please correct/);

    const badCapacity = await post('/admin/spaces', createFields({ capacity: '0', code: 'MR-BAD-2' }));
    assert.equal(badCapacity.status, 422);
    const capacityHtml = await badCapacity.text();
    assert.match(capacityHtml, /id="capacity-error"/);
    assert.match(capacityHtml, /at least 1/);
    // Submitted values are preserved so the operator does not retype the form.
    assert.match(capacityHtml, /value="Meeting room 1"/);

    const badRate = await post('/admin/spaces', createFields({ code: 'MR-BAD-3', rates_HOUR: 'free please' }));
    assert.equal(badRate.status, 422);
    assert.match(await badRate.text(), /id="rates_HOUR-error"/);

    assert.equal(spaceRow('MR-BAD-1'), undefined);
    assert.equal(spaceRow('MR-BAD-2'), undefined);
    assert.equal(spaceRow('MR-BAD-3'), undefined);
    assert.equal(countSpaces(), before);
  });

  test('POST /admin/spaces creates exactly one row, stores the rates and redirects', async () => {
    const before = countSpaces();
    const response = await post('/admin/spaces', createFields());
    assert.equal(response.status, 303);

    const { id, location } = spaceIdFromRedirect(response);
    assert.equal(countSpaces(), before + 1);

    const row = spaceRow('MR-01');
    assert.ok(row, 'the space must exist');
    assert.equal(row.id, id);
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.floor, '2nd floor');
    assert.equal(row.attributes_placeholder === undefined, true);

    const rates = db.prepare('SELECT unit, amount_cents FROM space_rate WHERE space_id = ? ORDER BY unit').all(id);
    assert.deepEqual(rates.map((rate) => [rate.unit, rate.amount_cents]), [['HOUR', 150000]]);

    const attributes = JSON.parse(db.prepare('SELECT attributes FROM space WHERE id = ?').get(id).attributes);
    assert.equal(attributes.layout, 'Boardroom');
    assert.equal(attributes.flipchart, true);
    // Only the panel matching the submitted category is stored.
    assert.equal(attributes.seating_capacity, undefined);
    assert.equal(attributes.desk_area, undefined);

    const amenities = JSON.parse(db.prepare('SELECT amenities FROM space WHERE id = ?').get(id).amenities);
    assert.deepEqual([...amenities].sort(), ['Catering', 'Projector', 'Rooftop terrace', 'Whiteboard']);

    // A meeting room ignores the co-working desk inventory it was sent.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM resource_unit WHERE space_id = ? AND is_active = 1').get(id).c,
      1,
    );

    const flash = flashFrom(response);
    assert.equal(flash.kind, 'success');
    assert.match(flash.message, /MR-01/);

    const detail = await get(location);
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /Not ready to publish/);
  });

  test('the detail page shows the checklist, disables publishing and offers the booking links', async () => {
    const id = spaceRow('MR-01').id;
    const response = await get(`/admin/spaces/${id}`);
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /not ready to publish/i);
    assert.match(html, /photograph/i);
    assert.match(html, /disabled aria-disabled="true"/);
    assert.match(html, new RegExp(`action="/admin/spaces/${id}/publish"`));
    assert.match(html, new RegExp(`action="/admin/spaces/${id}/archive"`));
    assert.match(html, /data-confirm=/);
    assert.match(html, new RegExp(`href="/admin/reservations/new\\?space=${id}"`));
    assert.match(html, new RegExp(`href="/admin/calendar\\?space=${id}"`));
    assert.match(html, /enctype="multipart\/form-data"/);
    assert.match(html, /name="images" type="file"|type="file" name="images"/);
    assert.match(html, /accept="image\/jpeg,image\/png,image\/webp"/);
    assert.match(html, /A space cannot be published without a photograph/);
  });

  test('publishing without a photograph fails with an error flash and leaves the space in draft', async () => {
    const id = spaceRow('MR-01').id;
    const response = await post(`/admin/spaces/${id}/publish`);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `/admin/spaces/${id}`);

    const flash = flashFrom(response);
    assert.equal(flash.kind, 'error');
    assert.ok(Array.isArray(flash.problems));
    assert.ok(flash.problems.some((problem) => /photograph/i.test(problem)));
    assert.equal(spaceRow('MR-01').status, 'DRAFT');
  });

  test('editing a space re-renders with 422 on bad input and updates it on success', async () => {
    const id = spaceRow('MR-01').id;

    const invalid = await post(`/admin/spaces/${id}`, createFields({ open_time: '18:00', close_time: '08:00' }));
    assert.equal(invalid.status, 422);
    const invalidHtml = await invalid.text();
    assert.match(invalidHtml, /id="close_time-error"/);
    assert.match(invalidHtml, /after opening time/i);
    assert.equal(db.prepare('SELECT close_time FROM space WHERE id = ?').get(id).close_time, '18:00');

    const valid = await post(`/admin/spaces/${id}`, createFields({
      name: 'Meeting room 1 (renovated)',
      rates_HOUR: '1800.00',
      rates_HALF_DAY: '900.00',
      contact_note: '',
    }));
    assert.equal(valid.status, 303);
    assert.equal(flashFrom(valid).kind, 'success');

    const row = db.prepare('SELECT name, contact_note FROM space WHERE id = ?').get(id);
    assert.equal(row.name, 'Meeting room 1 (renovated)');
    assert.equal(row.contact_note, null, 'clearing an optional field clears the column');

    const rates = db.prepare('SELECT unit, amount_cents FROM space_rate WHERE space_id = ? ORDER BY unit').all(id);
    assert.deepEqual(rates.map((rate) => [rate.unit, rate.amount_cents]), [['HALF_DAY', 90000], ['HOUR', 180000]]);

    const edit = await get(`/admin/spaces/${id}/edit`);
    assert.equal(edit.status, 200);
    const editHtml = await edit.text();
    assert.match(editHtml, /value="Meeting room 1 \(renovated\)"/);
    assert.match(editHtml, /value="1800.00"/);
    // Editing renders only the current category's attribute panel.
    assert.match(editHtml, /name="attributes_meeting\[layout\]"/);
    assert.doesNotMatch(editHtml, /name="attributes_coworking\[desk_area\]"/);
    // MP-01 is a meeting room: no desk inventory field.
    assert.doesNotMatch(editHtml, /name="desk_count"/);
  });

  test('publishing succeeds once a photograph exists', async () => {
    const id = spaceRow('MR-01').id;
    addImageRecord(db, {
      actor: ACTOR,
      spaceId: id,
      storedName: `${'a'.repeat(32)}.jpg`,
      originalName: 'meeting-room.jpg',
      mimeType: 'image/jpeg',
      byteSize: 4096,
      altText: 'A meeting table for four',
    });

    const response = await post(`/admin/spaces/${id}/publish`);
    assert.equal(response.status, 303);
    const flash = flashFrom(response);
    assert.equal(flash.kind, 'success');
    assert.match(flash.message, /published/i);

    const row = db.prepare('SELECT status, published_at FROM space WHERE id = ?').get(id);
    assert.equal(row.status, 'PUBLISHED');
    assert.ok(row.published_at > 0);

    const detail = await get(`/admin/spaces/${id}`);
    const html = await detail.text();
    assert.match(html, /Ready to publish/);
    assert.match(html, /meeting-room\.jpg/);
    assert.match(html, /A meeting table for four/);
    assert.match(html, new RegExp(`action="/admin/spaces/${id}/unpublish"`));
  });

  test('cover, reorder and delete act on the photograph records', async () => {
    const id = spaceRow('MR-01').id;
    addImageRecord(db, {
      actor: ACTOR, spaceId: id, storedName: `${'b'.repeat(32)}.png`,
      originalName: 'second.png', mimeType: 'image/png', byteSize: 2048,
    });
    addImageRecord(db, {
      actor: ACTOR, spaceId: id, storedName: `${'c'.repeat(32)}.webp`,
      originalName: 'third.webp', mimeType: 'image/webp', byteSize: 1024,
    });

    const images = listImages(db, id);
    assert.equal(images.length, 3);

    // The photograph manager offers a thumbnail, the cover marker, a reorder
    // pair carrying the full order, and a confirmed delete form.
    const galleryHtml = await (await get(`/admin/spaces/${id}`)).text();
    assert.match(galleryHtml, new RegExp(`src="/media/${images[0].storedName}"`));
    assert.match(galleryHtml, new RegExp(`action="/admin/spaces/${id}/images/${images[2].id}/delete"`));
    assert.match(galleryHtml, /data-confirm="Delete this photograph\?/);
    assert.match(galleryHtml, /name="orderedIds"/);
    assert.match(galleryHtml, /Make cover/);

    // Delete one: the row disappears (the stored file is best-effort).
    const deleted = await post(`/admin/spaces/${id}/images/${images[0].id}/delete`);
    assert.equal(deleted.status, 303);
    assert.equal(flashFrom(deleted).kind, 'success');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM space_image WHERE id = ?').get(images[0].id).c,
      0,
    );

    // Make the last image the cover.
    const remaining = listImages(db, id);
    const coverTarget = remaining[remaining.length - 1];
    const covered = await post(`/admin/spaces/${id}/images/${coverTarget.id}/cover`);
    assert.equal(covered.status, 303);
    assert.equal(flashFrom(covered).kind, 'success');
    assert.equal(listImages(db, id)[0].id, coverTarget.id, 'the cover is listed first');

    // Reorder with the comma-separated hidden field the detail page posts.
    const ordered = listImages(db, id).map((image) => image.id);
    const reversed = [...ordered].reverse();
    const reordered = await post(`/admin/spaces/${id}/images/reorder`, { orderedIds: reversed.join(',') });
    assert.equal(reordered.status, 303);
    assert.equal(flashFrom(reordered).kind, 'success');
    assert.deepEqual(
      db.prepare('SELECT id FROM space_image WHERE space_id = ? ORDER BY sort_order').all(id).map((row) => row.id),
      reversed,
    );

    // Reorder with repeated fields (the other accepted encoding).
    const repeated = await post(`/admin/spaces/${id}/images/reorder`, { orderedIds: ordered });
    assert.equal(repeated.status, 303);
    assert.deepEqual(
      db.prepare('SELECT id FROM space_image WHERE space_id = ? ORDER BY sort_order').all(id).map((row) => row.id),
      ordered,
    );

    // An incomplete permutation is refused, not half-applied.
    const partial = await post(`/admin/spaces/${id}/images/reorder`, { orderedIds: String(ordered[0]) });
    assert.equal(partial.status, 303);
    const partialFlash = flashFrom(partial);
    assert.equal(partialFlash.kind, 'error');
    assert.match(partialFlash.message, /exactly once/i);
  });

  test('archive and restore round-trip over HTTP', async () => {
    const id = spaceRow('MR-01').id;

    const archived = await post(`/admin/spaces/${id}/archive`, { reason: 'Refurbishment' });
    assert.equal(archived.status, 303);
    assert.equal(flashFrom(archived).kind, 'success');
    let row = db.prepare('SELECT status, archived_at FROM space WHERE id = ?').get(id);
    assert.equal(row.status, 'ARCHIVED');
    assert.ok(row.archived_at > 0);

    const archivedDetail = await get(`/admin/spaces/${id}`);
    assert.match(await archivedDetail.text(), /action="\/admin\/spaces\/\d+\/restore"/);

    const restored = await post(`/admin/spaces/${id}/restore`);
    assert.equal(restored.status, 303);
    assert.equal(flashFrom(restored).kind, 'success');
    row = db.prepare('SELECT status, archived_at FROM space WHERE id = ?').get(id);
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.archived_at, null);
  });

  test('archiving warns when the space still carries upcoming occupancy', async () => {
    const created = await post('/admin/spaces', createFields({
      code: 'CW-01',
      name: 'Co-working floor',
      category: 'COWORKING',
      pricing_unit: 'DAY',
      rates_HOUR: '',
      rates_DAY: '500.00',
      desk_count: '3',
      capacity: '3',
    }));
    assert.equal(created.status, 303);
    const { id } = spaceIdFromRedirect(created);

    const now = Date.now();
    const customerId = Number(db.prepare(`
      INSERT INTO customer (full_name, email, email_normalized, created_at, updated_at)
      VALUES (?,?,?,?,?)
    `).run('Ada Visitor', 'ada@test.local', 'ada@test.local', now, now).lastInsertRowid);

    const startAt = businessLocalToEpoch(todayBusinessDate(now + 7 * 86400000), '09:00');
    createReservation(db, {
      actor: ACTOR, spaceId: id, customerId,
      startAt, endAt: startAt + 60 * 60 * 1000,
      unitCount: 1, billingUnit: 'DAY', purpose: 'Upcoming desk rental',
    });

    const archived = await post(`/admin/spaces/${id}/archive`, { reason: 'Lease ended' });
    assert.equal(archived.status, 303);
    const flash = flashFrom(archived);
    assert.equal(flash.kind, 'warning');
    assert.match(flash.message, /upcoming occupancy/i);
    assert.equal(db.prepare('SELECT status FROM space WHERE id = ?').get(id).status, 'ARCHIVED');

    // The co-working inventory was created from the submitted desk count.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM resource_unit WHERE space_id = ? AND is_active = 1').get(id).c,
      3,
    );
  });

  test('a router configured with deps.setFlash uses it instead of writing the cookie itself', async () => {
    const calls = [];
    const secondary = await startServer({
      db,
      requireAuth,
      requireCsrf,
      setFlash: (ctx, payload) => calls.push(payload),
    });
    try {
      const response = await fetch(`${secondary.baseUrl}/admin/spaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody({ ...createFields({ code: 'MR-SPY' }), _csrf: CSRF_TOKEN }),
        redirect: 'manual',
      });
      assert.equal(response.status, 303);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].kind, 'success');
      assert.match(calls[0].message, /MR-SPY/);
      assert.equal(flashFrom(response), null, 'the app-provided helper owns the cookie');
    } finally {
      await closeServer(secondary.server);
    }
  });
});
