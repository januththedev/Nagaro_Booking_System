/**
 * Integration tests for the admin customer routes over real HTTP.
 *
 * Every request goes through a real `createRouter()` mounted on a real
 * `node:http` server on port 0, against a real temp-file SQLite database with
 * the production migrations applied. Booking history is produced by the real
 * services (`spaceService.createSpace` → `addImageRecord` → `publishSpace`,
 * `customerService.createCustomer`, `bookingService.createReservation`,
 * `bookingService.cancelReservation`), so the profile page is proven against
 * genuine database rows rather than hand-inserted fixtures.
 *
 * LIMITATIONS (deliberate, and why):
 *   1. `src/server/app.js` cannot be imported yet: at least one sibling route
 *      module (currently `src/server/routes/publicRoutes.js`) imports
 *      `../web/lib/html.js`, a path that does not resolve from
 *      `src/server/routes/`. This test therefore builds its own router and
 *      registers ONLY the customer routes, passing the same dependency object
 *      `app.js` passes (`{ db, config, setFlash, renderErrorPage, html, raw,
 *      escapeHtml, requireAuth, requireCsrf }`). The CSRF and auth guards ARE
 *      the real ones from `src/server/security/sessions.js`.
 *   2. Sessions are stubbed by a test-only middleware keyed off the
 *      `x-test-actor` header. With no header the context stays anonymous,
 *      which is what makes the 401 assertion on the search API real rather
 *      than mocked.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applyMigrations } from '../../src/server/db/migrate.js';
import { createRouter } from '../../src/server/http/router.js';
import { AppError } from '../../src/server/domain/errors.js';
import { escapeHtml, html, raw } from '../../src/web/lib/html.js';
import { appendCookie, redirect, serializeCookie } from '../../src/server/http/response.js';
import { isJsonRequest } from '../../src/server/http/request.js';
import {
  FLASH_COOKIE, csrfTokenFor, requireAuth, requireCsrf,
} from '../../src/server/security/sessions.js';
import { registerAdminCustomerRoutes } from '../../src/server/routes/adminCustomerRoutes.js';
import { addImageRecord, createSpace, publishSpace } from '../../src/server/services/spaceService.js';
import { createCustomer } from '../../src/server/services/customerService.js';
import { cancelReservation, createReservation } from '../../src/server/services/bookingService.js';
import { businessDateKey, businessLocalToEpoch } from '../../src/server/domain/time.js';

/* ---------------------------------------------------------------- fixtures */

const CSRF_SECRET = 'integration-test-csrf-secret';
const CSRF_TOKEN = csrfTokenFor(CSRF_SECRET);

const ADMIN_ACTOR = {
  id: 1, email: 'admin@test.local', displayName: 'Ada Admin', role: 'ADMIN', label: 'Ada Admin (ADMIN)',
};
const STAFF_ACTOR = {
  id: 2, email: 'staff@test.local', displayName: 'Sam Staff', role: 'STAFF', label: 'Sam Staff (STAFF)',
};
const ACTORS = { admin: ADMIN_ACTOR, staff: STAFF_ACTOR };

let tempDir = null;
let db = null;
let server = null;
let base = null;
let fixture = null;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'nagaro-customer-routes-'));
  db = new DatabaseSync(join(tempDir, 'test.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA trusted_schema = OFF');
  applyMigrations(db);

  const now = Date.now();
  const insertAdmin = db.prepare(`
    INSERT INTO admin_user (id, email, password_hash, display_name, role, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,1,?,?)
  `);
  for (const actor of [ADMIN_ACTOR, STAFF_ACTOR]) {
    insertAdmin.run(actor.id, actor.email, 'scrypt$16384$8$1$integration$hash', actor.displayName, actor.role, now, now);
  }

  fixture = seedFixture();
  ({ server, base } = await startServer());
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) { try { db.close(); } catch { /* ignore */ } }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
});

/** Build real spaces, customers and reservations so the views read real joins. */
function seedFixture() {
  const space = createSpace(db, {
    actor: ADMIN_ACTOR,
    payload: {
      name: 'Kifle Meeting Room',
      code: 'ITC-ROOM',
      category: 'MEETING_ROOM',
      short_description: 'A quiet room for small meetings.',
      description: 'A quiet meeting room used by the integration test fixture for customer history.',
      location: 'Trace Expert City, Block B',
      capacity: 12,
      pricing_unit: 'HOUR',
      rates: [{ unit: 'HOUR', amount_cents: 45000 }],
      min_duration_minutes: 60,
    },
  });
  addImageRecord(db, {
    actor: ADMIN_ACTOR,
    spaceId: space.id,
    storedName: `${'a'.repeat(32)}.png`,
    originalName: 'meeting-room.png',
    mimeType: 'image/png',
    byteSize: 2048,
    altText: 'Meeting room',
  });
  publishSpace(db, { actor: ADMIN_ACTOR, spaceId: space.id });

  const customer = createCustomer(db, {
    actor: ADMIN_ACTOR,
    payload: {
      full_name: 'Hanna Tesfaye',
      email: 'hanna@example.com',
      phone: '+94 91 123 4567',
      organization: 'Blue Nile Consulting',
      notes: 'Prefers morning bookings. Invoiced to head office.',
    },
  });
  const other = createCustomer(db, {
    actor: ADMIN_ACTOR,
    payload: { full_name: 'Yonas Bekele', email: 'yonas@example.com' },
  });

  const dateKey = businessDateKey(Date.now() + 3 * 86_400_000);
  const confirmed = createReservation(db, {
    actor: ADMIN_ACTOR,
    spaceId: space.id,
    customerId: customer.id,
    startAt: businessLocalToEpoch(dateKey, '09:00'),
    endAt: businessLocalToEpoch(dateKey, '11:00'),
    attendees: 6,
    purpose: 'Quarterly review',
  }).reservation;

  const cancelled = createReservation(db, {
    actor: ADMIN_ACTOR,
    spaceId: space.id,
    customerId: customer.id,
    startAt: businessLocalToEpoch(dateKey, '13:00'),
    endAt: businessLocalToEpoch(dateKey, '15:00'),
    attendees: 4,
    purpose: 'Supplier workshop',
  }).reservation;
  cancelReservation(db, {
    actor: STAFF_ACTOR,
    reservationId: cancelled.id,
    reason: 'Client postponed the workshop.',
  });

  return { space, customer, other, confirmed, cancelled };
}

/** Router + HTTP server. Mirrors the app.js middleware chain for this module. */
async function startServer() {
  const router = createRouter();

  /*
   * Test-only session shim. The real chain resolves the actor from the session
   * cookie in app.js; here the actor is chosen by a header the test controls.
   * No header -> no actor, exactly like a signed-out visitor.
   */
  router.use(async (ctx) => {
    const header = ctx.req.headers['x-test-actor'];
    const key = Array.isArray(header) ? header[0] : header;
    if (key && ACTORS[key]) {
      ctx.actor = ACTORS[key];
      ctx.session = { sessionId: 1, csrfSecret: CSRF_SECRET, expiresAt: Date.now() + 3_600_000 };
      ctx.csrfToken = CSRF_TOKEN;
    }
    ctx.secure = false;
    ctx.flash = null;
    ctx.wantsJson = isJsonRequest(ctx.req);
    return true;
  });

  registerAdminCustomerRoutes(router, {
    db,
    config: {},
    setFlash: testSetFlash,
    renderErrorPage: null,
    html,
    raw,
    escapeHtml,
    requireAuth,
    requireCsrf,
  });

  // Error boundary mirroring app.js: JSON for /api/*, a login redirect for 401
  // HTML, a plain error page otherwise.
  router.onError(async (ctx, error) => {
    if (ctx.res.headersSent || ctx.res.writableEnded) return;
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (ctx.wantsJson || ctx.url.pathname.startsWith('/api/')) {
      ctx.json({
        ok: false,
        error: {
          code,
          message: status >= 500
            ? 'Something went wrong on our side. The operation was not completed.'
            : error.message,
          details: error.details ?? null,
        },
      }, status);
      return;
    }
    if (status === 401) {
      redirect(ctx.res, `/admin/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
      return;
    }
    ctx.html(`<h1>${status} ${code}</h1><p>${escapeHtml(error.message)}</p>`, status);
  });

  router.setNotFound((ctx) => ctx.text('Not found', 404));

  const httpServer = createServer((req, res) => {
    Promise.resolve(router.handle(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('');
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return { server: httpServer, base: `http://127.0.0.1:${httpServer.address().port}` };
}

/** The app.js flash contract, re-implemented here because app.js cannot load. */
function testSetFlash(ctx, { kind = 'success', message, problems = null }) {
  if (!ctx || !ctx.res) return;
  const payload = JSON.stringify({ kind, message, problems: problems ?? undefined });
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, payload, {
    maxAgeSeconds: 30, httpOnly: true, secure: false,
  }));
}

/* ---------------------------------------------------------------- requests */

/** `actor: null` deliberately produces an anonymous request. */
async function request(path, { actor = 'admin', method = 'GET', form = null, headers = {} } = {}) {
  const sent = { accept: 'text/html', ...headers };
  if (actor) sent['x-test-actor'] = actor;
  let body;
  if (form) {
    body = new URLSearchParams({ _csrf: CSRF_TOKEN, ...form }).toString();
    sent['content-type'] = 'application/x-www-form-urlencoded';
  }
  return fetch(`${base}${path}`, { method, headers: sent, body, redirect: 'manual' });
}

async function json(path, options) {
  const response = await request(path, { ...options, headers: { accept: 'application/json' } });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  return { response, payload, text };
}

const countCustomers = () => db.prepare('SELECT COUNT(*) AS c FROM customer').get().c;
const customerRow = (id) => db.prepare('SELECT * FROM customer WHERE id = ?').get(id);

/* ------------------------------------------------------------------- tests */

test('GET /api/admin/customers/search without an actor returns 401', async () => {
  const { response, payload, text } = await json('/api/admin/customers/search?q=Tesfaye', { actor: null });

  assert.equal(response.status, 401, 'the customer search API must never be reachable unauthenticated');
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNAUTHORIZED');
  assert.equal(
    text.includes('hanna@example.com'), false,
    'a rejected request must not leak customer data in the body',
  );
  // Sanity: the same request with an actor is NOT rejected.
  const authenticated = await json('/api/admin/customers/search?q=Tesfaye');
  assert.equal(authenticated.response.status, 200);
});

test('an unauthenticated directory request is redirected to the staff sign-in page', async () => {
  const response = await request('/admin/customers', { actor: null });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location') ?? '', /^\/admin\/login/);
});

test('with an actor, a 1-character query returns { items: [] } instead of the whole table', async () => {
  const short = await json('/api/admin/customers/search?q=H');
  assert.equal(short.response.status, 200);
  assert.deepEqual(short.payload, { items: [] });
  assert.equal(short.text.includes('hanna@example.com'), false, 'a short query must not dump rows');

  const empty = await json('/api/admin/customers/search?q=');
  assert.deepEqual(empty.payload, { items: [] });
});

test("with an actor, searching a seeded customer's surname returns exactly that customer", async () => {
  const { response, payload } = await json('/api/admin/customers/search?q=Tesfaye');

  assert.equal(response.status, 200);
  assert.equal(payload.items.length, 1);
  const [item] = payload.items;
  assert.deepEqual(
    Object.keys(item).sort(),
    ['confirmedReservations', 'email', 'fullName', 'id', 'organization', 'phone'],
    'the typeahead exposes exactly the contracted fields',
  );
  assert.equal(item.id, fixture.customer.id);
  assert.equal(item.fullName, 'Hanna Tesfaye');
  assert.equal(item.email, 'hanna@example.com');
  assert.equal(item.phone, '+94 91 123 4567');
  assert.equal(item.organization, 'Blue Nile Consulting');
  assert.equal(item.confirmedReservations, 1, 'the cancelled booking is not counted as confirmed');
  assert.equal(
    JSON.stringify(payload).includes('Prefers morning bookings'), false,
    'private notes never leave the staff-only profile page',
  );
});

test('POST /admin/customers with an existing email returns 422 and creates no second row', async () => {
  const before = countCustomers();

  const response = await request('/admin/customers', {
    method: 'POST',
    form: {
      full_name: 'Hanna T.',
      email: ' Hanna@Example.COM ', // different case and whitespace: still the same person
      phone: '',
      organization: '',
      notes: '',
    },
  });
  const body = await response.text();

  assert.equal(response.status, 422, 'the duplicate gate must refuse the create');
  assert.equal(countCustomers(), before, 'no second customer row may be created');

  assert.match(body, /Possible duplicate/);
  assert.match(body, /name="confirm_duplicate"/);
  assert.match(body, /never merged automatically/);
  assert.ok(body.includes(`/admin/customers/${fixture.customer.id}`), 'each match links to its profile');
  assert.match(body, /hanna@example\.com/);
  assert.match(body, /Blue Nile Consulting/);
  assert.match(body, /value="Hanna T\."/, 'the entered values are preserved for correction');
});

test('the same POST with confirm_duplicate=1 creates the second row', async () => {
  const before = countCustomers();

  // Same email as the rejected attempt above, this time explicitly confirmed.
  const response = await request('/admin/customers', {
    method: 'POST',
    form: {
      full_name: 'Hanna T. (personal)',
      email: ' Hanna@Example.COM ',
      phone: '',
      organization: 'Freelance',
      notes: '',
      confirm_duplicate: '1',
    },
  });

  assert.equal(response.status, 303, 'a confirmed duplicate-create flashes and redirects');
  const location = response.headers.get('location') ?? '';
  assert.match(location, /^\/admin\/customers\/\d+$/);
  const createdId = Number(location.split('/').pop());
  assert.notEqual(createdId, fixture.customer.id);
  assert.equal(countCustomers(), before + 1, 'exactly one new row when the duplicate is confirmed');

  const cookies = response.headers.getSetCookie();
  assert.ok(
    cookies.some((cookie) => cookie.startsWith(`${FLASH_COOKIE}=`)),
    'the success flash cookie is set on the redirect',
  );

  const created = customerRow(createdId);
  assert.equal(created.full_name, 'Hanna T. (personal)');
  assert.equal(created.email, 'Hanna@Example.COM', 'the typed spelling is stored verbatim');
  assert.equal(
    created.email_normalized, 'hanna@example.com',
    'both records exist, deliberately, under the same normalised email',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM customer WHERE email_normalized = ?').get('hanna@example.com').c,
    2,
    'the confirmation is what allowed the second row through',
  );
});

test('POST /admin/customers with a fresh email creates the customer without any confirmation', async () => {
  const before = countCustomers();

  const response = await request('/admin/customers', {
    method: 'POST',
    form: {
      full_name: 'Marta Girma',
      email: 'marta@example.com',
      phone: '+94 92 000 1111',
      organization: 'Lanka Analytics',
      notes: '',
    },
  });

  assert.equal(response.status, 303);
  assert.match(response.headers.get('location') ?? '', /^\/admin\/customers\/\d+$/);
  assert.equal(countCustomers(), before + 1);
  const created = db.prepare('SELECT * FROM customer WHERE email_normalized = ?').get('marta@example.com');
  assert.equal(created.full_name, 'Marta Girma');
  assert.equal(created.organization, 'Lanka Analytics');
  assert.equal(created.phone, '+94 92 000 1111');
});

test('POST /admin/customers with an invalid email returns 422 with a field error and creates no row', async () => {
  const before = countCustomers();

  const response = await request('/admin/customers', {
    method: 'POST',
    form: { full_name: 'Broken Email', email: 'not-an-email', phone: '', organization: '', notes: '' },
  });
  const body = await response.text();

  assert.equal(response.status, 422);
  assert.equal(countCustomers(), before, 'a rejected payload must not reach the database');
  assert.match(body, /Enter a valid email address\./);
  assert.match(body, /id="email-error"/, 'the error is wired to the input');
  assert.match(body, /aria-invalid="true"/);
  assert.match(body, /for="email"/, 'the email input keeps its label');
});

test('POST /admin/customers/:id with another customer email returns 409 and leaves both rows unchanged', async () => {
  const hannaBefore = customerRow(fixture.customer.id);
  const yonasBefore = customerRow(fixture.other.id);

  const response = await request(`/admin/customers/${fixture.customer.id}`, {
    method: 'POST',
    form: {
      full_name: 'Hanna Tesfaye',
      email: 'yonas@example.com',
      phone: '+94 91 123 4567',
      organization: 'Blue Nile Consulting',
      notes: '',
    },
  });
  const body = await response.text();

  assert.equal(response.status, 409);
  assert.match(body, /Another customer already uses this email/);
  assert.ok(
    body.includes(`/admin/customers/${fixture.other.id}`),
    'the conflict names and links the customer that owns the email',
  );

  assert.deepEqual(customerRow(fixture.customer.id), hannaBefore, 'the edited row is untouched');
  assert.deepEqual(customerRow(fixture.other.id), yonasBefore, 'the conflicting row is untouched');
});

test("the profile page renders the customer's booking history including a cancelled reservation's reason", async () => {
  const response = await request(`/admin/customers/${fixture.customer.id}`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Booking history/);
  assert.ok(body.includes(fixture.confirmed.reference), 'the confirmed booking appears in the history');
  assert.ok(body.includes(fixture.cancelled.reference), 'the cancelled booking stays in the history');
  assert.match(body, /Client postponed the workshop\./, 'the cancellation reason is rendered');
  assert.match(body, /Cancelled/, 'the cancelled row carries its status');
  assert.ok(
    body.includes(`/admin/reservations/${fixture.cancelled.id}`),
    'history rows link to the reservation',
  );
  assert.ok(
    body.includes(`/admin/reservations/new?customer=${fixture.customer.id}`),
    'the profile offers "Create reservation for this customer"',
  );
  assert.match(body, /Private notes/);
  assert.match(body, /staff only/);
  assert.match(body, /Prefers morning bookings\./);
  assert.match(body, /visible only to signed-in staff/);
});

test('GET /admin/customers filters by q', async () => {
  const hanna = await (await request('/admin/customers?q=Tesfaye')).text();
  assert.match(hanna, /Hanna Tesfaye/);
  assert.equal(hanna.includes('Yonas Bekele'), false, 'a filtered directory must not list other customers');
  assert.match(hanna, /visible only to signed-in staff/);
  assert.equal(
    hanna.includes('Prefers morning bookings'), false,
    'the directory does not expose private customer notes',
  );

  const yonas = await (await request('/admin/customers?q=yonas')).text();
  assert.match(yonas, /Yonas Bekele/);
  assert.equal(yonas.includes('Hanna Tesfaye'), false);
});

test('GET /admin/customers filters by hasUpcoming', async () => {
  const withUpcoming = await (await request('/admin/customers?hasUpcoming=true')).text();
  assert.match(withUpcoming, /Hanna Tesfaye/);
  assert.equal(withUpcoming.includes('Yonas Bekele'), false);

  const withoutUpcoming = await (await request('/admin/customers?hasUpcoming=false')).text();
  assert.match(withoutUpcoming, /Yonas Bekele/);
  assert.equal(withoutUpcoming.includes('Hanna Tesfaye'), false);
});

test('GET /admin/customers/new pre-fills from an inquiry and offers no duplicate checkbox', async () => {
  const response = await request(
    '/admin/customers/new?name=Hanna%20Tesfaye&email=hanna%40example.com&phone=%2B94911234567&organization=Blue%20Nile%20Consulting',
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /value="Hanna Tesfaye"/);
  assert.match(body, /value="hanna@example.com"/);
  assert.match(body, /value="\+94911234567"/);
  assert.match(body, /value="Blue Nile Consulting"/);
  assert.match(body, /for="full_name"/);
  assert.equal(
    body.includes('name="confirm_duplicate"'), false,
    'the duplicate confirmation only appears after a duplicate was actually detected',
  );
});
