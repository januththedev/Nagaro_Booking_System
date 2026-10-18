/**
 * CASE 24-26 - transaction integrity: no partial writes, ever.
 *
 * A rejected booking must leave nothing behind: no reservation row, no orphan
 * occupancy row, no consumed document reference - and the database must stay
 * internally consistent.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservation } from '../../src/server/services/bookingService.js';
import { setDeskCount } from '../../src/server/services/spaceService.js';
import { runWorkers, BOOKING_WORKER } from '../helpers/concurrencyHelpers.js';
import {
  openScenario, attempt, futureDateKey, businessWindow, describeResults,
  countRows, sequenceValue, activeOccupancyRows,
} from '../helpers/bookingScenario.js';
const DATE = futureDateKey(30);

function reserve(db, scenario, { spaceId, window, unitCount = 1, purpose = null }) {
  return attempt(() => createReservation(db, {
    actor: scenario.actor,
    spaceId,
    customerId: scenario.customer.id,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount,
    purpose,
  }));
}

function counters(db) {
  return {
    reservations: countRows(db, 'SELECT COUNT(*) AS c FROM reservation'),
    occupancy: countRows(db, 'SELECT COUNT(*) AS c FROM occupancy'),
    sequence: sequenceValue(db, 'reservation'),
  };
}

test('CASE 24: a race with 7 losers leaves exactly the winner\'s rows and consumes exactly one reference', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case24-no-partial-writes');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  const before = counters(db);
  assert.deepEqual(before, { reservations: 0, occupancy: 0, sequence: 0 }, 'a fresh scenario has empty counters');

  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 8,
    action: 'createReservation',
    payload: (index) => ({
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt: window.startAt,
      endAt: window.endAt,
      unitCount: 1,
      purpose: `integrity worker ${index}`,
    }),
  });

  const context = describeResults(results);
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1, `exactly one success expected\n${context}`);

  const after = counters(db);
  assert.deepEqual(
    after,
    { reservations: before.reservations + 1, occupancy: before.occupancy + 1, sequence: before.sequence + 1 },
    `7 rejected transactions must leave zero residue\n${context}`,
  );

  // A further, single rejected attempt must change nothing at all.
  const rejected = reserve(db, scenario, { spaceId: scenario.roomSpace.id, window, purpose: 'lone loser' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'DOUBLE_BOOKING_CONFLICT');
  assert.deepEqual(counters(db), after, 'a rejected attempt must not create rows or consume a reference');

  // No half-written rows: every reservation has its allocation.
  const orphans = db.prepare(`
    SELECT r.id FROM reservation r
     WHERE NOT EXISTS (SELECT 1 FROM occupancy o WHERE o.reservation_id = r.id)
  `).all();
  assert.deepEqual(orphans, [], 'every reservation must own at least one occupancy row');
});

test('CASE 25a: allocation failure before the INSERT leaves no reservation row', (t) => {
  const { db, scenario, cleanup } = openScenario('case25a-allocation-fails-first');
  t.after(cleanup);

  const shrunk = setDeskCount(db, { actor: scenario.actor, spaceId: scenario.deskSpace.id, deskCount: 2 });
  assert.equal(shrunk.unitCount, 2, 'setup must leave a 2-desk pool');

  const window = businessWindow(DATE, '09:00', '17:00');
  const first = reserve(db, scenario, { spaceId: scenario.deskSpace.id, window, unitCount: 1, purpose: 'takes one desk' });
  assert.equal(first.ok, true, `setup failed: ${first.code} ${first.message}`);
  const before = counters(db);

  const tooMany = reserve(db, scenario, { spaceId: scenario.deskSpace.id, window, unitCount: 2, purpose: 'wants two desks' });
  assert.equal(tooMany.ok, false, 'two desks cannot fit in a one-desk remainder');
  assert.equal(tooMany.code, 'DOUBLE_BOOKING_CONFLICT', `observed ${tooMany.code}: ${tooMany.message}`);
  assert.deepEqual(counters(db), before, 'the allocation failure must happen before any INSERT');
});

test('CASE 25b: a failure AFTER the reservation INSERT is rolled back completely', (t) => {
  const { db, scenario, cleanup } = openScenario('case25b-rollback-after-insert');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  const unitId = scenario.roomSpace.units[0].id;

  // Pre-seed a conflicting ACTIVE occupancy row directly against the ROOM's
  // resource unit, but scoped to the AUDITORIUM's space id. The service's
  // availability check filters by space_id, so it believes the room is free;
  // the trigger matches on resource_unit_id only, so the occupancy INSERT
  // inside the transaction is refused. That forces the rollback path that a
  // pure allocation failure would not reach.
  const seeded = db.prepare(`
    INSERT INTO occupancy (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, maintenance_block_id, created_at)
    VALUES (?,?,?,?, 'ACTIVE', 'MAINTENANCE', NULL, NULL, ?)
  `).run(unitId, scenario.auditorium.id, window.startAt, window.endAt, Date.now());
  const seededId = Number(seeded.lastInsertRowid);
  const seededBefore = db.prepare('SELECT * FROM occupancy WHERE id = ?').get(seededId);

  const before = counters(db);
  const blocked = reserve(db, scenario, { spaceId: scenario.roomSpace.id, window, purpose: 'must be rolled back' });

  assert.equal(blocked.ok, false, 'the database trigger must refuse the occupancy row');
  assert.equal(blocked.code, 'DOUBLE_BOOKING_CONFLICT', `observed ${blocked.code}: ${blocked.message}`);
  assert.deepEqual(
    counters(db),
    before,
    'the reservation INSERT and the reference allocation must both be rolled back',
  );
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ?', scenario.roomSpace.id),
    0,
    'no reservation row may survive a failed occupancy insert',
  );
  assert.deepEqual(
    db.prepare('SELECT * FROM occupancy WHERE id = ?').get(seededId),
    seededBefore,
    'the pre-existing occupancy row must be untouched',
  );
});

test('CASE 31 (extra): an unclean shutdown mid-transaction leaves nothing behind', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case31-crash-mid-transaction');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 1,
    action: 'crashMidTransaction',
    payload: {
      actorId: scenario.actor.id,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      unitId: scenario.roomSpace.units[0].id,
      startAt: window.startAt,
      endAt: window.endAt,
    },
    startDelayMs: 100,
  });

  // The worker was killed by its own process.exit(7) inside an open write
  // transaction, so it never reported a result - that is the point.
  assert.equal(results[0].ok, false, 'the crashed worker cannot have reported success');
  assert.equal(results[0].exitCode, 7, `expected the deliberate exit code 7, got ${results[0].exitCode}`);

  assert.deepEqual(counters(db), { reservations: 0, occupancy: 0, sequence: 0 },
    'an uncommitted transaction must be discarded on recovery - no rows, no consumed reference');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

  // And the room is still bookable afterwards: the crashed writer holds no lock.
  const after = reserve(db, scenario, { spaceId: scenario.roomSpace.id, window, purpose: 'after the crash' });
  assert.equal(after.ok, true, `the room must still be bookable after the crash: ${after.code} ${after.message}`);
  assert.equal(activeOccupancyRows(db, after.result.reservation.id).length, 1);
  assert.deepEqual(counters(db), { reservations: 1, occupancy: 1, sequence: 1 });
});

test('CASE 26: after all those failures the database is still structurally sound', (t) => {
  const { db, scenario, cleanup } = openScenario('case26-integrity', { deskCount: 20 });
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  const unitId = scenario.roomSpace.units[0].id;

  const good = reserve(db, scenario, { spaceId: scenario.roomSpace.id, window, purpose: 'good booking' });
  assert.equal(good.ok, true);

  const overlapping = reserve(db, scenario, { spaceId: scenario.roomSpace.id, window, purpose: 'overlap' });
  assert.equal(overlapping.ok, false);

  const earlier = reserve(db, scenario, {
    spaceId: scenario.roomSpace.id,
    window: businessWindow(DATE, '11:00', '12:00'),
    purpose: 'adjacent booking',
  });
  assert.equal(earlier.ok, true);

  const triggeredWindow = businessWindow(DATE, '13:00', '14:00');
  db.prepare(`
    INSERT INTO occupancy (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, maintenance_block_id, created_at)
    VALUES (?,?,?,?, 'ACTIVE', 'MAINTENANCE', NULL, NULL, ?)
  `).run(unitId, scenario.auditorium.id, triggeredWindow.startAt, triggeredWindow.endAt, Date.now());
  const triggered = reserve(db, scenario, {
    spaceId: scenario.roomSpace.id,
    window: triggeredWindow,
    purpose: 'trigger refusal',
  });
  assert.equal(triggered.ok, false, 'the mis-scoped row must block the occupancy insert');
  assert.equal(triggered.code, 'DOUBLE_BOOKING_CONFLICT');

  const foreignKeyProblems = db.prepare('PRAGMA foreign_key_check').all();
  assert.deepEqual(foreignKeyProblems, [], 'PRAGMA foreign_key_check must return no rows');

  const integrity = db.prepare('PRAGMA integrity_check').all();
  assert.equal(integrity.length, 1);
  assert.equal(integrity[0].integrity_check, 'ok', `PRAGMA integrity_check: ${JSON.stringify(integrity)}`);

  assert.equal(activeOccupancyRows(db, good.result.reservation.id).length, 1);
});
