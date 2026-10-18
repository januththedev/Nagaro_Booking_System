/**
 * Integration tests for `src/server/routes/adminOpsRoutes.js`.
 *
 * Real HTTP: a real `createRouter()` + `createServer` on an ephemeral port, hit
 * with `fetch`, against a real temporary SQLite FILE database (migrated, WAL)
 * seeded exclusively through the real services. Nothing is mocked except the
 * session middleware, for the reason below.
 *
 * LIMITATION — authentication is injected, not exercised end to end:
 *   The real app resolves the actor from the `nagaro_session` cookie on every
 *   request. `createApp()` cannot be imported here (its assembler imports route
 *   modules owned by other agents that may not exist yet), so this harness
 *   registers `registerAdminOpsRoutes` directly and adds one test-only
 *   `router.use` that sets `ctx.session`, `ctx.actor` and `ctx.csrfToken` for
 *   authenticated requests and leaves all three unset for the unauthenticated
 *   case. Cookie handling, session expiry and the sign-in flow are therefore
 *   NOT covered by this file; `tests/integration/authRoutes.test.js` and the
 *   session unit tests own those. What this file does prove is that the guards
 *   in `adminOpsRoutes` respond correctly to an actor that is present or absent,
 *   and that CSRF is enforced through the real `requireCsrf`.
 *
 * LIMITATION — inquiries are inserted directly:
 *   `src/server/services/inquiryService.js` is owned by another agent, so the
 *   two inquiry rows are inserted with plain SQL to keep this test independent
 *   of that module's internals. The row shape mirrors the schema exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createTestActor, withTempFileDb } from '../helpers/testDb.js';
import { createRouter } from '../../src/server/http/router.js';
import { loadConfig } from '../../src/server/config.js';
import { AppError } from '../../src/server/domain/errors.js';
import { html, raw, escapeHtml } from '../../src/web/lib/html.js';
import { csrfTokenFor, FLASH_COOKIE, requireAuth, requireCsrf } from '../../src/server/security/sessions.js';
import { isJsonRequest, parseCookies } from '../../src/server/http/request.js';
import { redirect } from '../../src/server/http/response.js';
import { registerAdminOpsRoutes, setFlashCookie } from '../../src/server/routes/adminOpsRoutes.js';

import { addImageRecord, createSpace, publishSpace } from '../../src/server/services/spaceService.js';
import { createCustomer } from '../../src/server/services/customerService.js';
import {
  cancelReservation, createMaintenanceBlock, createReservation,
} from '../../src/server/services/bookingService.js';
import { businessDateKey, businessLocalToEpoch, MS } from '../../src/server/domain/time.js';

const CSRF_SECRET = 'integration-test-csrf-secret';
const DAY = MS.DAY;

/**
 * Mirror of `readFlashCookie` from app.js — the assembler module is not
 * importable here (see the file header), so the harness applies the same
 * parsing rules to prove that a flashed message survives one redirect.
 */
function readFlashFromCookieHeader(cookieHeader) {
  const raw = parseCookies({ headers: { cookie: cookieHeader } })[FLASH_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.message !== 'string') return null;
    return {
      kind: ['success', 'error', 'warning'].includes(parsed.kind) ? parsed.kind : 'success',
      message: parsed.message.slice(0, 500),
      problems: Array.isArray(parsed.problems) ? parsed.problems.slice(0, 20).map(String) : null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ harness */

/**
 * A miniature stand-in for `createApp()`: same deps shape, same error-boundary
 * behaviour (JSON for /api/*, 401 -> sign-in redirect for pages, referer bounce
 * with a flash for POSTs), minus the route modules this agent does not own.
 */
function buildHarness(db, { authenticated, actor = null }) {
  const router = createRouter();
  const deps = {
    db,
    config: loadConfig(),
    setFlash: setFlashCookie,
    renderErrorPage: (ctx, { status, code, message }) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${status}</title></head>
<body><h1>${message}</h1><p>Reference: <code>${code}</code></p></body></html>`,
    html,
    raw,
    escapeHtml,
    requireAuth,
    requireCsrf,
  };

  /* Test-only session middleware (see the file header for the limitation). */
  router.use(async (ctx) => {
    ctx.secure = false;
    // Flash is exercised for real: the cookie a POST set is read back on the
    // next request exactly as app.js would read it.
    ctx.flash = readFlashFromCookieHeader(ctx.req.headers.cookie);
    ctx.wantsJson = isJsonRequest(ctx.req);
    if (authenticated) {
      ctx.session = {
        sessionId: 1,
        csrfSecret: CSRF_SECRET,
        expiresAt: Date.now() + 12 * 3600 * 1000,
      };
      ctx.actor = actor;
    }
    ctx.csrfToken = authenticated ? csrfTokenFor(CSRF_SECRET) : '';
    return true;
  });

  registerAdminOpsRoutes(router, deps);

  router.onError(async (ctx, error) => {
    if (ctx.res.headersSent || ctx.res.writableEnded) return;
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof AppError
      ? error.message
      : 'Something went wrong on our side. The operation was not completed.';
    if (ctx.wantsJson || ctx.url.pathname.startsWith('/api/')) {
      ctx.json({ ok: false, error: { code, message, details: error.details ?? null } }, status);
      return;
    }
    if (status === 401) {
      redirect(ctx.res, `/admin/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
      ctx.responded = true;
      return;
    }
    const referer = ctx.req.headers.referer;
    if (ctx.method === 'POST' && referer) {
      deps.setFlash(ctx, { kind: 'error', message, problems: error.details?.problems ?? null });
      try {
        const target = new URL(referer);
        if (target.host === ctx.req.headers.host) {
          redirect(ctx.res, `${target.pathname}${target.search}`);
          ctx.responded = true;
          return;
        }
      } catch { /* fall through */ }
    }
    ctx.html(deps.renderErrorPage(ctx, { status, code, message }), status);
  });

  router.setNotFound((ctx) => {
    ctx.html(html`<!doctype html><html lang="en"><body><h1>404</h1></body></html>`, 404);
  });

  return createServer((req, res) => {
    router.handle(req, res).catch(() => {
      if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); }
    });
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Slice the rendered page between two markers (used to prove a row is absent
 *  from one section while still present in another). */
function sectionBetween(markup, startMarker, endMarker) {
  const start = markup.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `marker ${startMarker} should be rendered`);
  const end = endMarker ? markup.indexOf(endMarker, start) : -1;
  return markup.slice(start, end === -1 ? markup.length : end);
}

/* ------------------------------------------------------------------- seeding */

function insertInquiry(db, {
  reference, spaceId, customerName, email, status, emailStatus,
  startAt, endAt, atendees = 6, deskQuantity = null, message = null,
  emailError = null, attemptedAt = null, createdAt = Date.now(),
}) {
  const info = db.prepare(`
    INSERT INTO inquiry
      (reference, space_id, customer_name, email, email_normalized, phone, organization,
       requested_start_at, requested_end_at, attendees, desk_quantity, message,
       status, withdraw_token_hash, email_status, email_error, email_attempted_at,
       internal_notes, converted_reservation_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    reference, spaceId, customerName, email, email.trim().toLowerCase(),
    '+94 911 222 333', 'Example Ltd', startAt, endAt, atendees, deskQuantity, message,
    status, null, emailStatus, emailError, attemptedAt, null, null, createdAt, createdAt,
  );
  return Number(info.lastInsertRowid);
}

function seed(db, actor) {
  const now = Date.now();
  const dateKey = businessDateKey(now);
  const dayStart = businessLocalToEpoch(dateKey, '00:00');

  // Real services only: catalogue, publication gate, customer, bookings,
  // cancellation and maintenance all go through the modules under test's deps.
  const space = createSpace(db, {
    actor,
    payload: {
      code: 'AURORA',
      name: 'Aurora Meeting Room',
      category: 'MEETING_ROOM',
      short_description: 'Bright meeting room at Trace Expert City',
      description: 'A bright meeting room with projector, whiteboard and video conferencing.',
      location: 'Trace Expert City, Colombo',
      floor: '2',
      capacity: 12,
      pricing_unit: 'HOUR',
      open_time: '08:00',
      close_time: '18:00',
      rates: [{ unit: 'HOUR', amount_cents: 45000 }],
    },
  });
  addImageRecord(db, {
    actor,
    spaceId: space.id,
    storedName: `${'a'.repeat(32)}.jpg`,
    originalName: 'aurora.jpg',
    mimeType: 'image/jpeg',
    byteSize: 2048,
    altText: 'Aurora meeting room',
  });
  const published = publishSpace(db, { actor, spaceId: space.id });
  assert.equal(published.status, 'PUBLISHED', 'seed space should be published');

  const customer = createCustomer(db, {
    actor,
    payload: {
      full_name: 'Selam Bekele',
      email: 'selam@example.com',
      phone: '+94 911 111 111',
      organization: 'Example Ltd',
    },
  });

  const window = { startAt: dayStart + 9 * MS.HOUR, endAt: dayStart + 11 * MS.HOUR };
  const { reservation } = createReservation(db, {
    actor,
    spaceId: space.id,
    customerId: customer.id,
    startAt: window.startAt,
    endAt: window.endAt,
    attendees: 6,
    purpose: 'Quarterly review',
  });

  const doomedWindow = { startAt: dayStart + 13 * MS.HOUR, endAt: dayStart + 14 * MS.HOUR };
  const doomed = createReservation(db, {
    actor,
    spaceId: space.id,
    customerId: customer.id,
    startAt: doomedWindow.startAt,
    endAt: doomedWindow.endAt,
    attendees: 3,
    purpose: 'Will be cancelled',
  });
  cancelReservation(db, {
    actor,
    reservationId: doomed.reservation.id,
    reason: 'Customer rescheduled.',
  });

  const maintenanceStart = dayStart + DAY + 10 * MS.HOUR;
  const maintenance = createMaintenanceBlock(db, {
    actor,
    spaceId: space.id,
    startAt: maintenanceStart,
    endAt: maintenanceStart + 2 * MS.HOUR,
    reason: 'Projector replacement',
  });

  // Direct inserts: inquiryService.js is owned by another agent.
  const inquiryId = insertInquiry(db, {
    reference: 'NG-INQ-000900',
    spaceId: space.id,
    customerName: 'Hanna Tesfaye',
    email: 'hanna@example.com',
    status: 'NEW',
    emailStatus: 'NOT_CONFIGURED',
    emailError: 'Email is not configured on this server (no SMTP_HOST).',
    attemptedAt: now,
    startAt: maintenanceStart + DAY,
    endAt: maintenanceStart + DAY + 2 * MS.HOUR,
    message: 'Please reserve the room with a projector.',
    createdAt: now,
  });
  const closedInquiryId = insertInquiry(db, {
    reference: 'NG-INQ-000899',
    spaceId: space.id,
    customerName: 'Closed Visitor',
    email: 'closed@example.com',
    status: 'CLOSED',
    emailStatus: 'NOT_CONFIGURED',
    emailError: 'Email is not configured on this server (no SMTP_HOST).',
    attemptedAt: now,
    startAt: maintenanceStart + DAY,
    endAt: maintenanceStart + DAY + MS.HOUR,
    createdAt: now - 60000,
  });

  return {
    now, dateKey, dayStart, dayEnd: dayStart + DAY,
    space, customer, reservation, cancelledReservation: doomed.reservation,
    maintenance, inquiryId, closedInquiryId,
    inquiryStartAt: maintenanceStart + DAY,
    inquiryEndAt: maintenanceStart + DAY + 2 * MS.HOUR,
  };
}

/* --------------------------------------------------------------------- tests */

test('admin operations routes: dashboard, inquiries, maintenance, activity log', async (t) => {
  await withTempFileDb(async (db) => {
    const testActor = createTestActor(db);
    const actor = {
      id: testActor.id,
      label: testActor.label,
      email: 'admin@test.local',
      displayName: testActor.label,
      role: testActor.role,
    };
    const data = seed(db, actor);

    const authServer = buildHarness(db, { authenticated: true, actor });
    const guestServer = buildHarness(db, { authenticated: false });
    const authBase = await listen(authServer);
    const guestBase = await listen(guestServer);

    try {
      await t.test('unauthenticated GET /admin is refused (redirect to sign-in)', async () => {
        const res = await fetch(`${guestBase}/admin`, { redirect: 'manual' });
        assert.equal(res.status, 303, 'page request should bounce to the sign-in page');
        assert.match(res.headers.get('location') ?? '', /^\/admin\/login\?next=%2Fadmin/);

        const api = await fetch(`${guestBase}/api/admin/dashboard/summary`);
        assert.equal(api.status, 401, 'API request should be 401, not a redirect');
        const payload = await api.json();
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, 'UNAUTHORIZED');
      });

      await t.test('GET /admin renders live figures and the seeded records', async () => {
        const res = await fetch(`${authBase}/admin`);
        assert.equal(res.status, 200);
        const body = await res.text();

        assert.ok(body.includes(data.reservation.reference), 'today\'s reservation reference');
        assert.ok(body.includes(data.customer.fullName), 'seeded customer name');
        assert.ok(body.includes('data-dashboard="admin"'), 'dashboard container hook');
        assert.ok(body.includes('data-summary-url="/api/admin/dashboard/summary"'), 'refresh URL hook');
        assert.ok(body.includes('All figures are read live from the booking database.'), 'honesty note');

        // The undelivered-notification banner, in the exact honesty wording.
        assert.ok(body.includes('data-notification-undelivered'), 'undelivered banner');
        assert.ok(body.includes('Notification email NOT delivered'), 'banner headline');
        assert.ok(
          body.includes('No notification email reached the office for this request.'),
          'banner must not claim an email was sent',
        );
        assert.ok(!body.includes('notification email was sent'), 'no false delivery claim');

        // Cancelled reservations are visible but not in the confirmed list.
        const confirmedSection = sectionBetween(body, 'data-today-confirmed', 'data-today-cancelled');
        const cancelledSection = sectionBetween(body, 'data-today-cancelled', 'Upcoming (next 30 days)');
        assert.ok(
          !confirmedSection.includes(data.cancelledReservation.reference),
          'a cancelled booking must not appear in today\'s confirmed list',
        );
        assert.ok(
          cancelledSection.includes(data.cancelledReservation.reference),
          'the cancelled booking is still shown, in its own section',
        );
      });

      await t.test('GET /api/admin/dashboard/summary matches independent SQL counts', async () => {
        const res = await fetch(`${authBase}/api/admin/dashboard/summary`, {
          headers: { accept: 'application/json' },
        });
        assert.equal(res.status, 200);
        const summary = await res.json();

        const activeSpaces = db.prepare(
          "SELECT COUNT(*) AS c FROM space WHERE status <> 'ARCHIVED'",
        ).get().c;
        assert.equal(summary.activeSpaces.total, activeSpaces);
        assert.equal(summary.activeSpaces.published, 1);
        assert.equal(summary.activeSpaces.draft, 0);
        assert.equal(summary.activeSpaces.archived, 0);

        const todaysBookings = db.prepare(`
          SELECT COUNT(*) AS c FROM reservation
           WHERE start_at < ? AND end_at > ? AND status <> 'CANCELLED'
        `).get(data.dayEnd, data.dayStart).c;
        assert.equal(summary.today.bookings, todaysBookings);
        assert.equal(summary.today.bookings, 1, 'only the confirmed booking counts today');
        assert.equal(summary.today.cancelled, 1, 'the cancelled booking is counted separately');
        assert.equal(summary.today.attendees, 6);

        const undelivered = db.prepare(`
          SELECT COUNT(*) AS c FROM inquiry
           WHERE email_status IN ('FAILED','NOT_CONFIGURED')
             AND status NOT IN ('CLOSED','WITHDRAWN')
        `).get().c;
        assert.equal(summary.inquiries.awaitingEmailDelivery, undelivered);
        assert.equal(summary.inquiries.awaitingEmailDelivery, 1, 'the closed inquiry is excluded');
        assert.equal(summary.inquiries.new, 1);
      });

      await t.test('inquiry queue filters by status', async () => {
        const newRes = await fetch(`${authBase}/admin/inquiries?status=NEW`);
        assert.equal(newRes.status, 200);
        const newBody = await newRes.text();
        assert.ok(newBody.includes('NG-INQ-000900'), 'NEW inquiry is listed');
        assert.ok(!newBody.includes('NG-INQ-000899'), 'the CLOSED inquiry is filtered out');

        const closedRes = await fetch(`${authBase}/admin/inquiries?status=CLOSED`);
        assert.equal(closedRes.status, 200);
        const closedBody = await closedRes.text();
        assert.ok(!closedBody.includes('NG-INQ-000900'), 'NEW inquiry is not in the CLOSED list');
        assert.ok(closedBody.includes('NG-INQ-000899'), 'CLOSED inquiry is listed');

        const badStatus = await fetch(`${authBase}/admin/inquiries?status=NOPE`);
        assert.equal(badStatus.status, 422, 'an unknown status is a validation error');

        const emailFilter = await fetch(`${authBase}/admin/inquiries?emailStatus=NOT_CONFIGURED`);
        assert.equal(emailFilter.status, 200);
        const emailBody = await emailFilter.text();
        assert.ok(emailBody.includes('NG-INQ-000900') && emailBody.includes('NG-INQ-000899'));
        assert.ok(
          emailBody.includes('the newest 200 requests'),
          'the page states the delivery filter is applied inside a window',
        );
      });

      await t.test('inquiry detail states that no inventory is reserved', async () => {
        const res = await fetch(`${authBase}/admin/inquiries/${data.inquiryId}`);
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.ok(body.includes('NG-INQ-000900'), 'reference');
        assert.ok(body.includes('has not reserved any inventory'), 'no-inventory statement');
        assert.ok(body.includes('Notification email NOT delivered'), 'delivery honesty');
        assert.ok(body.includes('Email is not configured on this server'), 'recorded error text');
        assert.ok(
          body.includes(`date=${businessDateKey(data.inquiryStartAt)}`),
          'convert link carries the requested date',
        );
        assert.ok(body.includes(`inquiry=${data.inquiryId}`), 'convert link carries the inquiry id');
        assert.ok(body.includes('data-notification-undelivered'), 'detail banner');

        const api = await fetch(`${authBase}/api/admin/inquiries/${data.inquiryId}`, {
          headers: { accept: 'application/json' },
        });
        assert.equal(api.status, 200);
        const payload = await api.json();
        assert.equal(payload.inquiry.reference, 'NG-INQ-000900');
        assert.equal(payload.inquiry.emailStatus, 'NOT_CONFIGURED');
      });

      await t.test('POST status change flips the row; an invalid status does not', async () => {
        const okRes = await fetch(`${authBase}/admin/inquiries/${data.inquiryId}/status`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            _csrf: csrfTokenFor(CSRF_SECRET),
            status: 'CONTACTED',
            internal_notes: 'Called the visitor on the phone.',
          }).toString(),
        });
        assert.equal(okRes.status, 303);
        assert.equal(okRes.headers.get('location'), `/admin/inquiries/${data.inquiryId}`);

        const row = db.prepare('SELECT status, internal_notes FROM inquiry WHERE id = ?')
          .get(data.inquiryId);
        assert.equal(row.status, 'CONTACTED', 'row really changed');
        assert.equal(row.internal_notes, 'Called the visitor on the phone.');

        const audit = db.prepare(`
          SELECT COUNT(*) AS c FROM audit_log
           WHERE entity_type = 'inquiry' AND entity_id = ? AND action = 'inquiry.status_changed'
        `).get(String(data.inquiryId)).c;
        assert.equal(audit, 1, 'the change is recorded in the activity log');

        const badRes = await fetch(`${authBase}/admin/inquiries/${data.inquiryId}/status`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            _csrf: csrfTokenFor(CSRF_SECRET),
            status: 'NOT_A_REAL_STATUS',
          }).toString(),
        });
        assert.equal(badRes.status, 422, 'invalid status is refused with 422');
        const after = db.prepare('SELECT status, internal_notes FROM inquiry WHERE id = ?')
          .get(data.inquiryId);
        assert.equal(after.status, 'CONTACTED', 'nothing changed');
        assert.equal(after.internal_notes, 'Called the visitor on the phone.', 'notes untouched');

        const convertedRes = await fetch(`${authBase}/admin/inquiries/${data.inquiryId}/status`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            _csrf: csrfTokenFor(CSRF_SECRET),
            status: 'CONVERTED',
          }).toString(),
        });
        assert.equal(convertedRes.status, 303, 'refusal is flashed and redirected');
        const stillNotConverted = db.prepare('SELECT status, converted_reservation_id FROM inquiry WHERE id = ?')
          .get(data.inquiryId);
        assert.equal(stillNotConverted.status, 'CONTACTED');
        assert.equal(stillNotConverted.converted_reservation_id, null);

        const noCsrf = await fetch(`${authBase}/admin/inquiries/${data.inquiryId}/status`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ status: 'CLOSED' }).toString(),
        });
        assert.equal(noCsrf.status, 403, 'CSRF is enforced by the real guard');
        assert.equal(
          db.prepare('SELECT status FROM inquiry WHERE id = ?').get(data.inquiryId).status,
          'CONTACTED',
        );
      });

      await t.test('GET /admin/audit renders the seeded activity log', async () => {
        const res = await fetch(`${authBase}/admin/audit`);
        assert.equal(res.status, 200);
        const body = await res.text();
        // `>action<` targets the rendered `<span class="tag">` cell: the filter form's
        // datalist always carries every known action name, so a plain substring check
        // would pass even when the table rendered nothing.
        assert.ok(body.includes('>reservation.created<'), 'booking audit entry');
        assert.ok(body.includes('>space.published<'), 'publication audit entry');
        assert.ok(body.includes(data.reservation.reference), 'reservation reference in a summary');
        assert.ok(body.includes('<details'), 'details are collapsed');
        assert.ok(body.includes('&quot;reference&quot;'), 'details JSON is HTML-escaped');
        assert.ok(!body.includes('"reference":'), 'details JSON is never emitted raw');
        assert.ok(body.includes('append-only'), 'the page explains the log is append-only');

        const filtered = await fetch(`${authBase}/admin/audit?action=reservation.created`);
        assert.equal(filtered.status, 200);
        const filteredBody = await filtered.text();
        assert.ok(filteredBody.includes('>reservation.created<'));
        assert.ok(!filteredBody.includes('>space.published<'), 'the action filter really filters');
      });

      await t.test('GET /admin/maintenance lists the seeded block and the form', async () => {
        const res = await fetch(`${authBase}/admin/maintenance`);
        assert.equal(res.status, 200);
        const body = await res.text();
        assert.ok(body.includes('Projector replacement'), 'blocked period reason');
        assert.ok(body.includes(data.space.name), 'blocked space');
        assert.ok(body.includes('/admin/maintenance'), 'creation form posts to this route module');
        assert.ok(body.includes('cannot'), 'helper text warns about confirmed reservations');

        // Form-flow semantics: a well-formed but unknown id flashes an error
        // and bounces back to the list (303), never a 500; a malformed id is a
        // hard 404 from the error boundary. Both paths are asserted below.
        const missing = await fetch(`${authBase}/admin/maintenance/999999/cancel`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _csrf: csrfTokenFor(CSRF_SECRET) }).toString(),
        });
        assert.equal(missing.status, 303, 'unknown block ids flash and bounce, never 500');
        assert.equal(missing.headers.get('location'), '/admin/maintenance');

        const flashPair = (missing.headers.get('set-cookie') ?? '').split(';')[0];
        assert.ok(flashPair.startsWith(`${FLASH_COOKIE}=`), 'the bounce carries a flash cookie');
        const flashed = await fetch(`${authBase}/admin/maintenance`, {
          headers: { cookie: flashPair },
        });
        assert.equal(flashed.status, 200);
        const flashedBody = await flashed.text();
        assert.ok(flashedBody.includes('data-flash'), 'the flashed alert is rendered');
        assert.ok(flashedBody.includes('Maintenance block not found.'), 'the flash says what happened');

        const malformed = await fetch(`${authBase}/admin/maintenance/abc/cancel`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _csrf: csrfTokenFor(CSRF_SECRET) }).toString(),
        });
        assert.equal(malformed.status, 404, 'malformed block ids are a hard 404');
      });
    } finally {
      await close(authServer);
      await close(guestServer);
    }
  });
});
