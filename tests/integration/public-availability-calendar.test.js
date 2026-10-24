/**
 * HTTP contract for GET /api/public/availability/calendar.
 *
 * A real router, a real node:http server and a migrated SQLite database. The
 * fixtures are created through the real booking services (reservation and
 * maintenance) so the calendar is proved against the same occupancy rows the
 * rest of the system writes.
 *
 * The privacy assertions are deliberately strict: every object in the payload
 * is compared against an allowlist of keys, and the serialized response must
 * not contain a customer name, email, purpose, reservation reference or a
 * maintenance reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTestActor, createTestDb, closeTestDb } from '../helpers/testDb.js';
import { AppError } from '../../src/server/domain/errors.js';
import { businessLocalToEpoch } from '../../src/server/domain/time.js';
import { createRouter } from '../../src/server/http/router.js';
import { registerPublicRoutes } from '../../src/server/routes/publicRoutes.js';
import { createMaintenanceBlock, createReservation } from '../../src/server/services/bookingService.js';

const DATE = '2031-03-10';
const NEXT_DATE = '2031-03-11';
const END_DATE = '2031-03-12';
const at = (clock) => businessLocalToEpoch(DATE, clock);

let db;
let server;
let baseUrl;
let actor;
let meetingId;
let coworkingId;

function insertSpace({
  code, name, category, units = 1, pricingUnit = 'HOUR', openTime = '08:00', closeTime = '18:00',
  status = 'PUBLISHED',
}) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO space
      (code, name, category, short_description, capacity, status, currency,
       pricing_unit, min_duration_minutes, max_duration_minutes, buffer_minutes,
       open_time, close_time, amenities, attributes, created_at, updated_at, published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    code, name, category, `${name} test fixture`, category === 'COWORKING' ? 40 : 12,
    status, 'LKR', pricingUnit, 60, null, 0, openTime, closeTime, '[]', '{}',
    now, now, status === 'PUBLISHED' ? now : null,
  );
  const spaceId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO space_rate (space_id, unit, amount_cents, is_default) VALUES (?,?,?,1)')
    .run(spaceId, pricingUnit, 250000);
  const unitStmt = db.prepare(`
    INSERT INTO resource_unit (space_id, code, label, kind, is_active, created_at)
    VALUES (?,?,?,?,1,?)
  `);
  for (let index = 1; index <= units; index += 1) {
    const unitCode = category === 'COWORKING' ? `DESK-${index}` : `${code}-ROOM`;
    unitStmt.run(
      spaceId,
      unitCode,
      category === 'COWORKING' ? `Desk ${index}` : name,
      category === 'COWORKING' ? 'DESK' : 'EXCLUSIVE',
      now,
    );
  }
  return spaceId;
}

async function startServer() {
  const router = createRouter();
  router.onError((ctx, error) => {
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
  registerPublicRoutes(router, { db, config: {}, now: () => Date.now() });

  const instance = createServer((req, res) => {
    Promise.resolve(router.handle(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
      }
    });
  });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return { instance, url: `http://127.0.0.1:${instance.address().port}` };
}

function get(path) {
  return fetch(`${baseUrl}${path}`, { headers: { Accept: 'application/json' } });
}

test.before(async () => {
  db = createTestDb();
  actor = createTestActor(db);

  meetingId = insertSpace({ code: 'MEETING-ROOM', name: 'Meeting Room', category: 'MEETING_ROOM' });
  coworkingId = insertSpace({
    code: 'COWORK-DESKS',
    name: 'Co-working Hall',
    category: 'COWORKING',
    units: 4,
    pricingUnit: 'DAY',
  });
  insertSpace({
    code: 'HIDDEN-DRAFT',
    name: 'Hidden Draft',
    category: 'MEETING_ROOM',
    status: 'DRAFT',
  });

  createReservation(db, {
    actor,
    spaceId: meetingId,
    customerPayload: {
      fullName: 'Nimali Fernando',
      email: 'nimali@example.com',
      phone: '+94 77 123 4567',
      organization: 'Example Labs',
    },
    startAt: at('09:00'),
    endAt: at('11:00'),
    unitCount: 1,
    attendees: 8,
    purpose: 'Secret board review',
  });

  createReservation(db, {
    actor,
    spaceId: coworkingId,
    customerPayload: {
      fullName: 'Ravi Perera',
      email: 'ravi@example.com',
      phone: '+94 71 222 3333',
    },
    startAt: at('10:00'),
    endAt: at('12:00'),
    unitCount: 2,
  });

  createMaintenanceBlock(db, {
    actor,
    spaceId: meetingId,
    startAt: at('14:00'),
    endAt: at('15:00'),
    reason: 'Private maintenance reason',
  });

  const started = await startServer();
  server = started.instance;
  baseUrl = started.url;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  closeTestDb(db);
});

test('returns a privacy-safe Monday-to-Sunday-shaped calendar for published spaces only', async () => {
  const response = await get(`/api/public/availability/calendar?from=${DATE}&to=${END_DATE}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /public/);
  assert.match(response.headers.get('cache-control') ?? '', /max-age=30/);

  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['days', 'from', 'spaces', 'timezone', 'to']);
  assert.equal(body.from, DATE);
  assert.equal(body.to, END_DATE);
  assert.equal(body.timezone, 'Asia/Colombo');
  assert.deepEqual(body.spaces.map((space) => space.code), ['COWORK-DESKS', 'MEETING-ROOM']);
  assert.equal(body.days.length, 3);
  assert.deepEqual(body.days.map((day) => day.dateKey), [DATE, NEXT_DATE, END_DATE]);

  for (const space of body.spaces) {
    assert.deepEqual(
      Object.keys(space).sort(),
      ['category', 'closeTime', 'code', 'name', 'openTime', 'totalUnits'],
    );
  }
  for (const day of body.days) {
    assert.deepEqual(Object.keys(day).sort(), ['dateKey', 'spaces']);
    for (const daySpace of day.spaces) {
      assert.deepEqual(
        Object.keys(daySpace).sort(),
        ['closeTime', 'openTime', 'slots', 'spaceCode', 'totalUnits'],
      );
      for (const slot of daySpace.slots) {
        assert.deepEqual(
          Object.keys(slot).sort(),
          ['bookingEndAt', 'bookingFreeUnits', 'canBook', 'endAt', 'freeUnits', 'isFree', 'startAt', 'totalUnits'],
        );
      }
    }
  }

  const serialized = JSON.stringify(body);
  const references = db.prepare('SELECT reference FROM reservation').all().map((row) => row.reference);
  assert.ok(references.length > 0, 'the fixtures created real reservation references');
  for (const secret of [
    'Nimali',
    'nimali@example.com',
    'Ravi',
    'ravi@example.com',
    'Secret board review',
    'Private maintenance reason',
    ...references,
  ]) {
    assert.equal(serialized.includes(secret), false, `the public calendar leaked ${secret}`);
  }
});

test('hourly slots reflect confirmed reservations, holds-free inventory and maintenance', async () => {
  const body = await (await get(`/api/public/availability/calendar?from=${DATE}&to=${DATE}`)).json();
  const day = body.days[0];
  const meeting = day.spaces.find((space) => space.spaceCode === 'MEETING-ROOM');
  const coworking = day.spaces.find((space) => space.spaceCode === 'COWORK-DESKS');

  assert.equal(meeting.openTime, '08:00');
  assert.equal(meeting.closeTime, '18:00');
  assert.equal(meeting.totalUnits, 1);
  assert.equal(meeting.slots.length, 10);

  const meetingSlot = (clock) => meeting.slots.find((slot) => slot.startAt === at(clock));
  assert.equal(meetingSlot('08:00').isFree, true);
  assert.deepEqual(meetingSlot('09:00'), {
    startAt: at('09:00'), endAt: at('10:00'), bookingEndAt: at('10:00'), bookingFreeUnits: 0, canBook: false, freeUnits: 0, totalUnits: 1, isFree: false,
  });
  assert.equal(meetingSlot('10:00').isFree, false, 'a reservation spanning two hours blocks both');
  assert.equal(meetingSlot('11:00').isFree, true, 'half-open intervals free the boundary');
  assert.equal(meetingSlot('14:00').isFree, false, 'maintenance blocks inventory');
  assert.equal(meetingSlot('15:00').isFree, true);

  assert.equal(coworking.totalUnits, 4);
  const coworkingSlot = (clock) => coworking.slots.find((slot) => slot.startAt === at(clock));
  assert.equal(coworkingSlot('09:00').freeUnits, 4);
  assert.deepEqual(coworkingSlot('10:00'), {
    startAt: at('10:00'), endAt: at('11:00'), bookingEndAt: at('11:00'), bookingFreeUnits: 2, canBook: true, freeUnits: 2, totalUnits: 4, isFree: true,
  });
  assert.equal(coworkingSlot('11:00').freeUnits, 2);
  assert.equal(coworkingSlot('12:00').freeUnits, 4);
});

test('space filter is case-insensitive and narrows both spaces and days', async () => {
  const body = await (
    await get(`/api/public/availability/calendar?from=${DATE}&to=${DATE}&space=meeting-room`)
  ).json();
  assert.deepEqual(body.spaces.map((space) => space.code), ['MEETING-ROOM']);
  assert.equal(body.days.length, 1);
  assert.deepEqual(body.days[0].spaces.map((space) => space.spaceCode), ['MEETING-ROOM']);
});

test('draft and unknown space codes are indistinguishable 404s', async () => {
  for (const code of ['HIDDEN-DRAFT', 'NO-SUCH-SPACE']) {
    const response = await get(
      `/api/public/availability/calendar?from=${DATE}&to=${DATE}&space=${code}`,
    );
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.message, 'Space not found.');
  }
});

test('invalid dates, reversed ranges and ranges over 31 days are rejected', async () => {
  const cases = [
    ['from=2031-02-30&to=2031-03-02', 'a non-existent date'],
    ['from=2031-03-10&to=2031-03-09', 'a reversed range'],
    ['from=2031-03-10junk&to=2031-03-11', 'a date with trailing characters'],
    ['from=2031-3-10&to=2031-03-11', 'a non-padded date'],
    ['from=2031-03-10', 'a missing end date'],
    ['to=2031-03-10', 'a missing start date'],
    ['from=2031-01-01&to=2031-02-01', 'a 32-day range'],
  ];
  for (const [query, label] of cases) {
    const response = await get(`/api/public/availability/calendar?${query}`);
    assert.equal(response.status, 422, `${label} should be refused`);
    const body = await response.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
});

test('a full 31-day range is accepted and capped exactly', async () => {
  const response = await get('/api/public/availability/calendar?from=2031-01-01&to=2031-01-31');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.days.length, 31);
  assert.equal(body.days[0].dateKey, '2031-01-01');
  assert.equal(body.days[30].dateKey, '2031-01-31');
});

test('booking links cover the minimum duration, closing time, buffers and past slots', async (t) => {
  const { buildPublicCalendar } = await import('../../src/server/services/publicCalendarService.js');
  db.prepare('UPDATE space SET min_duration_minutes=120, buffer_minutes=30 WHERE id=?').run(meetingId);
  t.after(() => db.prepare('UPDATE space SET min_duration_minutes=60, buffer_minutes=0 WHERE id=?').run(meetingId));
  const payload = buildPublicCalendar(db, { from: DATE, to: DATE, spaceCode:'MEETING-ROOM',now:at('08:00') });
  const slots = payload.days[0].spaces[0].slots;
  const slot = (time) => slots.find((item) => item.startAt===at(time));
  assert.equal(slot('08:00').canBook,false,'start at or before now is never offered');
  assert.equal(slot('11:00').canBook,false,'turnover buffer after 09–11 reservation is respected');
  assert.equal(slot('12:00').bookingEndAt,at('14:00'),'a free link selects the full minimum duration');
  assert.equal(slot('12:00').canBook,true,'maintenance beginning exactly at end does not inflate the buffer');
  assert.equal(slot('13:00').canBook,false,'minimum window crosses maintenance');
  assert.equal(slot('17:00').canBook,false,'a two-hour booking cannot run past closing');
});
