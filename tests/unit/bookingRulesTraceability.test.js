/**
 * Booking-rule traceability guard.
 *
 * This file exists to stop the documented rules from drifting away from the
 * code. Every test name carries the requirement ID it defends, and the numbers
 * asserted here are the worked examples printed in `docs/BOOKING_RULES.md`.
 * If someone changes an algorithm, the matching document edit is forced by a
 * red test.
 *
 * It deliberately does NOT use `tests/helpers/testDb.js` (owned by another
 * workstream): it builds its own in-memory `DatabaseSync` and applies the real
 * migrations through `applyMigrations()`.
 *
 * Run:  .\tools\node.cmd --test tests/unit/bookingRulesTraceability.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { applyMigrations } from '../../src/server/db/migrate.js';
import { businessLocalToEpoch, intervalsOverlap, MS } from '../../src/server/domain/time.js';
import {
  availabilityLabel,
  checkBookingRules,
} from '../../src/server/services/availabilityService.js';
import { billingQuantityFor } from '../../src/server/services/pricingService.js';

/* --------------------------------------------------------------- fixtures */

/**
 * `checkBookingRules(space, …)` reads the RAW snake_case `space` row
 * (`space.open_time`, `space.min_duration_minutes`), not the camelCase object
 * returned by `spaceService.getSpace()`. That asymmetry is defect D-3 in
 * `DATA_MODEL.md` §10; this fixture documents it and pins it down.
 */
const RAW_SPACE = Object.freeze({
  open_time: '08:00',
  close_time: '18:00',
  min_duration_minutes: 60,
  max_duration_minutes: null,
  capacity: 10,
});

const at = (dateKey, clock) => businessLocalToEpoch(dateKey, clock);

/** Mouthful-free alias: 2026-11-10 09:00 SLST. */
const D = '2026-11-10';
const D1 = '2026-11-11';
const D7 = '2026-11-17';

/* --------------------------------------------------------- database helper */

const PRAGMAS = [
  'PRAGMA busy_timeout = 10000',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA trusted_schema = OFF',
];

/** A private in-memory database with the real migrations applied. */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const pragma of PRAGMAS) db.exec(pragma);
  applyMigrations(db);
  return db;
}

/** Seed one published space with exactly one EXCLUSIVE bookable unit. */
function seedSpaceWithUnit(db, { code = 'TRACE-01' } = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO space
      (code, name, category, capacity, status, currency, pricing_unit,
       min_duration_minutes, buffer_minutes, open_time, close_time,
       amenities, attributes, created_at, updated_at)
    VALUES (?, ?, 'MEETING_ROOM', 10, 'PUBLISHED', 'LKR', 'HOUR', 60, 0, '08:00', '18:00',
            '[]', '{}', ?, ?)
  `).run(code, 'Trace Room 1', now, now);
  const spaceId = Number(db.prepare('SELECT id FROM space WHERE code = ?').get(code).id);
  db.prepare(`
    INSERT INTO resource_unit (space_id, code, label, kind, is_active, created_at)
    VALUES (?, 'UNIT-01', 'Trace Room 1', 'EXCLUSIVE', 1, ?)
  `).run(spaceId, now);
  const unitId = Number(db.prepare('SELECT id FROM resource_unit WHERE space_id = ?').get(spaceId).id);
  return { spaceId, unitId };
}

const INSERT_OCCUPANCY = `
  INSERT INTO occupancy
    (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, created_at)
  VALUES (?, ?, ?, ?, ?, 'MAINTENANCE', NULL, ?)
`;

function insertMaintenanceOccupancy(db, { unitId, spaceId, startAt, endAt, status = 'ACTIVE' }) {
  db.prepare(INSERT_OCCUPANCY).run(unitId, spaceId, startAt, endAt, status, Date.now());
}

/** Capture the SQLite error a statement produced, or null. */
function catchError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/* ==================================================================== tests */

/* ------------------------------------------------ R-AVAIL-001 / R-AVAIL-002 */

test('R-AVAIL-001/002 half-open conflict predicate matches intervalsOverlap across an interval matrix', () => {
  // Every pair is [startA, endA, startB, endB] in minutes past 09:00, chosen to
  // cover disjoint, abutting, partially overlapping, contained, containing and
  // identical intervals.
  const pairs = [
    [0, 60, 120, 180],   // disjoint, gap
    [0, 60, 60, 120],    // abutting at the end (no conflict)
    [60, 120, 0, 60],    // abutting at the start (no conflict)
    [0, 60, 59, 120],    // one minute of overlap
    [0, 120, 60, 180],   // partial overlap, later
    [60, 180, 0, 120],   // partial overlap, earlier
    [0, 180, 60, 90],    // containment
    [60, 90, 0, 180],    // engulfment
    [0, 60, 0, 60],      // identical
    [0, 60, 0, 30],      // shared start, shorter
  ];

  for (const [aStart, aEnd, bStart, bEnd] of pairs) {
    const documented = aStart < bEnd && aEnd > bStart;
    assert.equal(
      intervalsOverlap(aStart, aEnd, bStart, bEnd),
      documented,
      `predicate disagreement for [${aStart},${aEnd}) vs [${bStart},${bEnd})`,
    );
  }
});

/* ------------------------------------------------------------- R-AVAIL-003 */

test('R-AVAIL-003 an 11:00 end never conflicts with an 11:00 start', () => {
  const nineToEleven = [at(D, '09:00'), at(D, '11:00')];
  const elevenToThirteen = [at(D, '11:00'), at(D, '13:00')];
  const tenFiftyNineToThirteen = [at(D, '10:59'), at(D, '13:00')];

  assert.equal(
    intervalsOverlap(...nineToEleven, ...elevenToThirteen),
    false,
    'the 11:00 boundary is a hand-over, not an overlap',
  );
  assert.equal(
    intervalsOverlap(...nineToEleven, ...tenFiftyNineToThirteen),
    true,
    'one minute of overlap is a real overlap',
  );
  // The same property must hold when the roles are reversed.
  assert.equal(intervalsOverlap(...elevenToThirteen, ...nineToEleven), false);
});

test('R-AVAIL-003 adjacency is accepted by the database trigger; a one-minute overlap is rejected', () => {
  const db = freshDb();
  const { spaceId, unitId } = seedSpaceWithUnit(db);

  insertMaintenanceOccupancy(db, { unitId, spaceId, startAt: at(D, '09:00'), endAt: at(D, '11:00') });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM occupancy').get().c, 1);

  // [09:00,11:00) then [11:00,13:00) — half-open, no conflict.
  insertMaintenanceOccupancy(db, { unitId, spaceId, startAt: at(D, '11:00'), endAt: at(D, '13:00') });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM occupancy').get().c, 2);

  // [10:59,13:00) overlaps the first row by one minute — must be refused.
  const error = catchError(() => insertMaintenanceOccupancy(db, {
    unitId, spaceId, startAt: at(D, '10:59'), endAt: at(D, '13:00'),
  }));
  assert.ok(error, 'the trigger must reject a one-minute overlap');
  assert.match(String(error.message), /DOUBLE_BOOKING_CONFLICT/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM occupancy').get().c, 2, 'nothing was written');

  db.close();
});

/* ------------------------------------------------------------- R-AVAIL-004 */

test('R-AVAIL-004 opening hours are enforced in Sri Lanka Standard Time', () => {
  // Entirely inside 08:00-18:00.
  assert.deepEqual(
    checkBookingRules(RAW_SPACE, { startAt: at(D, '09:00'), endAt: at(D, '17:00'), attendees: 4 }),
    [],
  );
  // Ending exactly at close_time is allowed: [start, end) never needs 18:00 itself.
  assert.deepEqual(
    checkBookingRules(RAW_SPACE, { startAt: at(D, '09:00'), endAt: at(D, '18:00'), attendees: 4 }),
    [],
  );
  // Running past close_time is refused, and the space's own hours are named.
  const problems = checkBookingRules(RAW_SPACE, {
    startAt: at(D, '17:30'), endAt: at(D, '18:30'), attendees: 4,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /08:00-18:00/);
  assert.match(problems[0], /Sri Lanka Standard Time/);
});

/* ------------------------------------------------------------- R-AVAIL-005 */

test('R-AVAIL-005 minimum duration is enforced', () => {
  const tooShort = checkBookingRules(RAW_SPACE, {
    startAt: at(D, '09:00'), endAt: at(D, '09:30'), attendees: 2,
  });
  assert.equal(tooShort.length, 1);
  assert.match(tooShort[0], /Minimum booking duration for this space is 1h/);

  assert.deepEqual(
    checkBookingRules(RAW_SPACE, { startAt: at(D, '09:00'), endAt: at(D, '10:00'), attendees: 2 }),
    [],
    'exactly the minimum is allowed',
  );
});

/* ------------------------------------------------------------- R-AVAIL-006 */

test('R-AVAIL-006 maximum duration is enforced only when configured', () => {
  const capped = { ...RAW_SPACE, max_duration_minutes: 120 };
  const problems = checkBookingRules(capped, {
    startAt: at(D, '09:00'), endAt: at(D, '12:00'), attendees: 2,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Maximum booking duration for this space is 2h/);

  assert.deepEqual(
    checkBookingRules(capped, { startAt: at(D, '09:00'), endAt: at(D, '11:00'), attendees: 2 }),
    [],
    'exactly the maximum is allowed',
  );

  assert.deepEqual(
    checkBookingRules(RAW_SPACE, { startAt: at(D, '09:00'), endAt: at(D, '13:00'), attendees: 2 }),
    [],
    'with no maximum configured, longer bookings are accepted',
  );
});

/* ------------------------------------------------------------- R-AVAIL-017 */

test('R-AVAIL-017 multi-day and overnight windows are allowed only when every covered minute is open', () => {
  // A space that is open around the clock: `23:59` closes at the next local midnight.
  const aroundTheClock = {
    open_time: '00:00', close_time: '23:59',
    min_duration_minutes: 60, max_duration_minutes: null, capacity: 10,
  };

  // Three full days are accepted while every minute is inside opening hours.
  assert.deepEqual(
    checkBookingRules(aroundTheClock, {
      startAt: at(D, '10:00'), endAt: at('2026-11-13', '12:00'), attendees: 2,
    }),
    [],
    'a multi-day window on an around-the-clock space is bookable',
  );

  // Crossing local midnight is likewise a hand-over, not a closure.
  assert.deepEqual(
    checkBookingRules(aroundTheClock, {
      startAt: at(D, '22:00'), endAt: at(D1, '02:00'), attendees: 2,
    }),
    [],
    'an overnight window on an around-the-clock space is bookable',
  );

  // On a 08:00-18:00 space the nightly gap is genuinely closed, so a window
  // that would sit in it is refused even though the space is open on both days.
  const acrossTheNight = checkBookingRules(RAW_SPACE, {
    startAt: at(D, '17:00'), endAt: at(D1, '09:00'), attendees: 2,
  });
  assert.equal(acrossTheNight.length, 1);
  assert.match(acrossTheNight[0], /outside opening hours/);

  // A start before the space opens is refused on the first covered day.
  const tooEarly = checkBookingRules(RAW_SPACE, {
    startAt: at(D, '06:00'), endAt: at(D, '07:00'), attendees: 2,
  });
  assert.equal(tooEarly.length, 1);
  assert.match(tooEarly[0], /outside opening hours/);
});

/* ------------------------------------------------------------- R-AVAIL-012 */

test('R-AVAIL-012 released occupancy rows never conflict with an ACTIVE row', () => {
  const db = freshDb();
  const { spaceId, unitId } = seedSpaceWithUnit(db);

  // A live booking on [09:00,11:00) plus a RELEASED row for the very same
  // window: released rows are audit history, not inventory.
  const window = { startAt: at(D, '09:00'), endAt: at(D, '11:00') };
  insertMaintenanceOccupancy(db, { unitId, spaceId, ...window });
  insertMaintenanceOccupancy(db, { unitId, spaceId, ...window, status: 'RELEASED' });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM occupancy').get().c, 2);

  // Cancel the booking: the update trigger only fires while a row is ACTIVE,
  // so moving it to RELEASED is accepted.
  db.prepare(
    "UPDATE occupancy SET status = 'RELEASED' WHERE resource_unit_id = ? AND status = 'ACTIVE' AND start_at = ?",
  ).run(unitId, window.startAt);

  // The window the RELEASED rows used to hold may be rebooked.
  insertMaintenanceOccupancy(db, { unitId, spaceId, ...window });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM occupancy').get().c, 3);

  // But the new ACTIVE row must block an overlapping claim.
  const error = catchError(() => insertMaintenanceOccupancy(db, {
    unitId, spaceId, startAt: at(D, '10:00'), endAt: at(D, '12:00'),
  }));
  assert.ok(error);
  assert.match(String(error.message), /DOUBLE_BOOKING_CONFLICT/);

  db.close();
});

/* ------------------------------------------------------------- R-AVAIL-016 */

test('R-AVAIL-016 availability labels report counts, not optimism', () => {
  assert.equal(
    availabilityLabel({ isAvailable: true, isPooled: false, freeUnits: 1, totalUnits: 1 }),
    'Available',
  );
  assert.equal(
    availabilityLabel({ isAvailable: true, isPooled: true, freeUnits: 5, totalUnits: 20 }),
    '5 of 20 desks free',
  );
  assert.equal(
    availabilityLabel({ isAvailable: false, isPooled: false, freeUnits: 0, totalUnits: 1 }),
    'Fully booked',
  );
  assert.equal(
    availabilityLabel({ isAvailable: false, isPooled: true, freeUnits: 1, requestedUnits: 5 }),
    'Only 1 of 5 requested desks free',
  );
});

/* -------------------------------------------------------------- R-BOOK-018 */

test('R-BOOK-018 attendee count may not exceed space capacity', () => {
  const over = checkBookingRules(RAW_SPACE, {
    startAt: at(D, '09:00'), endAt: at(D, '10:00'), attendees: 25,
  });
  assert.equal(over.length, 1);
  assert.match(over[0], /exceeds this space's capacity of 10/);

  assert.deepEqual(
    checkBookingRules(RAW_SPACE, { startAt: at(D, '09:00'), endAt: at(D, '10:00'), attendees: 10 }),
    [],
    'exactly capacity is allowed',
  );
  assert.deepEqual(
    checkBookingRules(RAW_SPACE, { startAt: at(D, '09:00'), endAt: at(D, '10:00') }),
    [],
    'an omitted attendee count skips the capacity check',
  );
});

/* ------------------------------ R-BOOK-012 … R-BOOK-016: documented pricing */

test('R-BOOK-012 HOUR quantity matches the worked example in docs/BOOKING_RULES.md', () => {
  const cases = [
    ['09:00-10:00 (60 min)', '10:00', 1],
    ['09:00-10:01 (61 min)', '10:01', 2],
    ['09:00-11:30 (150 min)', '11:30', 3],
    ['09:00-13:00 (240 min)', '13:00', 4],
  ];
  for (const [label, endClock, expected] of cases) {
    assert.equal(
      billingQuantityFor({ unit: 'HOUR', startAt: at(D, '09:00'), endAt: at(D, endClock) }),
      expected,
      `${label} must bill ${expected} hour(s)`,
    );
  }
  // The rate itself, from the same document: LKR 1,500.00/hour.
  assert.equal(
    150000 * billingQuantityFor({ unit: 'HOUR', startAt: at(D, '09:00'), endAt: at(D, '11:30') }),
    450000,
  );
});

test('R-BOOK-013 HALF_DAY is 4 hours and matches the worked example', () => {
  // 240 min = one half day; one minute more = two.
  assert.equal(billingQuantityFor({ unit: 'HALF_DAY', startAt: at(D, '09:00'), endAt: at(D, '13:00') }), 1);
  assert.equal(billingQuantityFor({ unit: 'HALF_DAY', startAt: at(D, '09:00'), endAt: at(D, '13:01') }), 2);
  assert.equal(billingQuantityFor({ unit: 'HALF_DAY', startAt: at(D, '09:00'), endAt: at(D, '17:00') }), 2);
  // A sub-4h booking still bills one half day (the minimum-1 rule).
  assert.equal(billingQuantityFor({ unit: 'HALF_DAY', startAt: at(D, '09:00'), endAt: at(D, '10:00') }), 1);
});

test('R-BOOK-014 DAY quantity counts business-local dates touched', () => {
  // One date, 09:00-17:00.
  assert.equal(billingQuantityFor({ unit: 'DAY', startAt: at(D, '09:00'), endAt: at(D, '17:00') }), 1);
  // Two dates, 09:00 Tuesday to 17:00 Wednesday.
  assert.equal(billingQuantityFor({ unit: 'DAY', startAt: at(D, '09:00'), endAt: at(D1, '17:00') }), 2);
  // The documented caution: an exact 7x24h block touches EIGHT date headers
  // (Monday through the following Monday), so it is billed as eight days.
  assert.equal(billingQuantityFor({ unit: 'DAY', startAt: at(D, '09:00'), endAt: at(D7, '09:00') }), 8);
});

test('R-BOOK-015 WEEK quantity matches the worked example', () => {
  // Seven dates touched -> one week.
  assert.equal(billingQuantityFor({ unit: 'WEEK', startAt: at(D, '09:00'), endAt: at('2026-11-16', '17:00') }), 1);
  // Eight dates touched (the 168-hour trap) -> two weeks.
  assert.equal(billingQuantityFor({ unit: 'WEEK', startAt: at(D, '09:00'), endAt: at(D7, '09:00') }), 2);
  // The 1st to the 29th is twenty-nine dates -> five weeks.
  assert.equal(billingQuantityFor({ unit: 'WEEK', startAt: at('2026-11-01', '09:00'), endAt: at('2026-11-29', '17:00') }), 5);
});

test('R-BOOK-016 MONTH quantity matches the worked example', () => {
  // Thirty dates touched -> one month-unit (a 30-date "month").
  assert.equal(
    billingQuantityFor({ unit: 'MONTH', startAt: at('2026-11-01', '00:00'), endAt: at('2026-11-30', '00:00') }),
    1,
  );
  // Thirty-one dates -> two month-units.
  assert.equal(
    billingQuantityFor({ unit: 'MONTH', startAt: at('2026-11-01', '00:00'), endAt: at('2026-12-02', '00:00') }),
    2,
  );
  // Sixty dates -> two month-units.
  assert.equal(
    billingQuantityFor({ unit: 'MONTH', startAt: at('2026-11-01', '00:00'), endAt: at('2026-12-31', '00:00') }),
    2,
  );
});

/* -------------------------------------------------------------- R-SEC-012 */

test('R-SEC-012 both occupancy triggers exist after migrations', () => {
  const db = freshDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all().map((row) => row.name);
  assert.deepEqual(names, [
    'trg_occupancy_no_overlap_insert',
    'trg_occupancy_no_overlap_update',
  ]);
  // The migration ledger must agree that the schema was applied.
  assert.deepEqual(
    db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name),
    [
      '0001_init.sql',
      '0002_blob_columns.sql',
    '0003_currency_sri_lanka.sql',
      '0004_public_self_booking.sql',
      '0005_booking_request_payments_ai.sql',
      '0006_guider_knowledge.sql',
      '0007_optional_advances.sql',
      '0008_admin_roles_recycle_bin.sql',
      '0009_notifications.sql',
    ],
  );
  db.close();
});

test("R-SEC-012 both trigger bodies still contain RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')", () => {
  const db = freshDb();
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  assert.equal(triggers.length, 2);
  for (const trigger of triggers) {
    const sql = String(trigger.sql);
    assert.ok(
      sql.includes("RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')"),
      `${trigger.name} no longer aborts with DOUBLE_BOOKING_CONFLICT`,
    );
    // Guard the half-open predicate itself: a change of `<` to `<=` (or `>` to
    // `>=`) would silently start rejecting abutting bookings.
    const normalised = sql.replace(/\s+/g, ' ');
    assert.ok(
      normalised.includes('o.start_at < NEW.end_at') && normalised.includes('o.end_at > NEW.start_at'),
      `${trigger.name} no longer uses the documented half-open conflict predicate`,
    );
    // And guard the guards: only ACTIVE rows participate in the comparison.
    assert.ok(
      normalised.includes("o.status = 'ACTIVE'") && normalised.includes("NEW.status = 'ACTIVE'"),
      `${trigger.name} no longer restricts itself to ACTIVE rows`,
    );
  }
  db.close();
});

test('R-SEC-012 the insert trigger rejects an overlapping ACTIVE row and writes nothing', () => {
  const db = freshDb();
  const { spaceId, unitId } = seedSpaceWithUnit(db);

  insertMaintenanceOccupancy(db, { unitId, spaceId, startAt: at(D, '09:00'), endAt: at(D, '11:00') });
  const before = db.prepare('SELECT COUNT(*) AS c FROM occupancy').get().c;

  const error = catchError(() => insertMaintenanceOccupancy(db, {
    unitId, spaceId, startAt: at(D, '10:00'), endAt: at(D, '12:00'),
  }));

  assert.ok(error, 'an overlapping ACTIVE insert must be refused');
  assert.match(String(error.message), /DOUBLE_BOOKING_CONFLICT/);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM occupancy').get().c,
    before,
    'the rejected row must not be present',
  );

  // A different unit is unaffected: the guard is per resource unit.
  db.prepare(`
    INSERT INTO resource_unit (space_id, code, label, kind, is_active, created_at)
    VALUES (?, 'UNIT-02', 'Second unit', 'EXCLUSIVE', 1, ?)
  `).run(spaceId, Date.now());
  const otherUnit = Number(db.prepare("SELECT id FROM resource_unit WHERE code = 'UNIT-02'").get().id);
  insertMaintenanceOccupancy(db, { unitId: otherUnit, spaceId, startAt: at(D, '09:00'), endAt: at(D, '11:00') });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM occupancy').get().c, before + 1);

  db.close();
});

test('R-SEC-012 the update trigger rejects an overlap and leaves the row unchanged', () => {
  const db = freshDb();
  const { spaceId, unitId } = seedSpaceWithUnit(db);

  insertMaintenanceOccupancy(db, { unitId, spaceId, startAt: at(D, '09:00'), endAt: at(D, '11:00') });
  insertMaintenanceOccupancy(db, { unitId, spaceId, startAt: at(D, '13:00'), endAt: at(D, '14:00') });
  const moveable = db.prepare("SELECT id FROM occupancy WHERE start_at = ?").get(at(D, '13:00')).id;

  // Trying to slide the second claim onto the first must fail...
  const error = catchError(() => {
    db.prepare('UPDATE occupancy SET start_at = ?, end_at = ? WHERE id = ?')
      .run(at(D, '10:00'), at(D, '12:00'), moveable);
  });
  assert.ok(error, 'an overlapping UPDATE must be refused');
  assert.match(String(error.message), /DOUBLE_BOOKING_CONFLICT/);

  // ...and the row must be exactly where it was.
  const row = db.prepare('SELECT start_at, end_at FROM occupancy WHERE id = ?').get(moveable);
  assert.equal(row.start_at, at(D, '13:00'));
  assert.equal(row.end_at, at(D, '14:00'));

  // Moving it onto an abutting boundary is allowed, because the interval is half-open.
  db.prepare('UPDATE occupancy SET start_at = ?, end_at = ? WHERE id = ?')
    .run(at(D, '11:00'), at(D, '12:00'), moveable);
  const moved = db.prepare('SELECT start_at FROM occupancy WHERE id = ?').get(moveable);
  assert.equal(moved.start_at, at(D, '11:00'));

  // Releasing is never blocked by the update trigger.
  db.prepare("UPDATE occupancy SET status = 'RELEASED', released_at = ? WHERE id = ?")
    .run(Date.now(), moveable);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM occupancy WHERE status = 'ACTIVE'").get().c, 1);

  db.close();
});

/* ------------------------------------------------------------ sanity guard */

test('R-AVAIL-001 the project time constants are the documented ones', () => {
  // A guard against a silently redefined-hour: every pricing example above
  // depends on these two numbers.
  assert.equal(MS.MINUTE, 60_000);
  assert.equal(MS.HOUR, 3_600_000);
});
