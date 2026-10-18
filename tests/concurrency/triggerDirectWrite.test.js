/**
 * CASE 27-30 - defence in depth: the database refuses double booking even when
 * the service layer is bypassed completely.
 *
 * These statements are issued on a raw connection that never imports a
 * service. If the guarantee depended on service-layer checks, this file would
 * be able to create an overlap. It cannot.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservation } from '../../src/server/services/bookingService.js';
import {
  openScenario, attempt, futureDateKey, businessWindow, countRows,
} from '../helpers/bookingScenario.js';

const DATE = futureDateKey(30);

function insertOccupancy(db, { unitId, spaceId, startAt, endAt, status = 'ACTIVE', source = 'MAINTENANCE' }) {
  return attempt(() => db.prepare(`
    INSERT INTO occupancy (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, maintenance_block_id, created_at)
    VALUES (?,?,?,?,?,?,NULL,NULL,?)
  `).run(unitId, spaceId, startAt, endAt, status, source, Date.now()));
}

/** Fresh scenario with one confirmed 09:00-11:00 booking on the exclusive room. */
function scenarioWithBooking(label) {
  const handle = openScenario(label);
  const { db, scenario } = handle;
  const window = businessWindow(DATE, '09:00', '11:00');
  const booked = createReservation(db, {
    actor: scenario.actor,
    spaceId: scenario.roomSpace.id,
    customerId: scenario.customer.id,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount: 1,
    purpose: 'baseline booking',
  });
  return { ...handle, window, unitId: scenario.roomSpace.units[0].id, reservationId: booked.reservation.id };
}

test('CASE 27: a direct INSERT INTO occupancy that overlaps an ACTIVE row is refused by the trigger', (t) => {
  const { db, scenario, cleanup, unitId } = scenarioWithBooking('case27-raw-insert');
  t.after(cleanup);

  const overlapping = businessWindow(DATE, '10:00', '12:00');
  const before = countRows(db, 'SELECT COUNT(*) AS c FROM occupancy');

  const rejected = insertOccupancy(db, {
    unitId, spaceId: scenario.roomSpace.id, startAt: overlapping.startAt, endAt: overlapping.endAt,
  });

  assert.equal(rejected.ok, false, 'the raw INSERT must be refused');
  assert.match(String(rejected.message), /DOUBLE_BOOKING_CONFLICT/, `expected DOUBLE_BOOKING_CONFLICT, got: ${rejected.message}`);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM occupancy'), before, 'the refused row must not exist');

  // Also refused for an identical window and for a one-minute overlap.
  for (const [start, end] of [['09:00', '11:00'], ['10:59', '12:00'], ['08:00', '09:01']]) {
    const partial = businessWindow(DATE, start, end);
    const attemptResult = insertOccupancy(db, {
      unitId, spaceId: scenario.roomSpace.id, startAt: partial.startAt, endAt: partial.endAt,
    });
    assert.equal(attemptResult.ok, false, `raw INSERT ${start}-${end} must be refused`);
    assert.match(String(attemptResult.message), /DOUBLE_BOOKING_CONFLICT/);
  }
});

test('CASE 28: a direct UPDATE that moves an occupancy onto an occupied interval is refused', (t) => {
  const { db, scenario, cleanup, unitId } = scenarioWithBooking('case28-raw-update');
  t.after(cleanup);

  const elsewhere = businessWindow(DATE, '13:00', '15:00');
  const inserted = insertOccupancy(db, {
    unitId, spaceId: scenario.roomSpace.id, startAt: elsewhere.startAt, endAt: elsewhere.endAt,
  });
  assert.equal(inserted.ok, true, `setup insert must succeed: ${inserted.message}`);
  const rowId = Number(db.prepare('SELECT MAX(id) AS id FROM occupancy').get().id);
  const before = db.prepare('SELECT * FROM occupancy WHERE id = ?').get(rowId);

  const target = businessWindow(DATE, '09:30', '10:30'); // overlaps the 09:00-11:00 booking
  const refused = attempt(() => db.prepare('UPDATE occupancy SET start_at = ?, end_at = ? WHERE id = ?')
    .run(target.startAt, target.endAt, rowId));

  assert.equal(refused.ok, false, 'the UPDATE must be refused');
  assert.match(String(refused.message), /DOUBLE_BOOKING_CONFLICT/, `expected DOUBLE_BOOKING_CONFLICT, got: ${refused.message}`);
  assert.deepEqual(
    db.prepare('SELECT * FROM occupancy WHERE id = ?').get(rowId),
    before,
    'the refused UPDATE must leave the row exactly as it was',
  );
});

test('CASE 29: the trigger permits non-overlap, RELEASED rows and releases', (t) => {
  const { db, scenario, cleanup, unitId, window } = scenarioWithBooking('case29-trigger-permits');
  t.after(cleanup);
  const spaceId = scenario.roomSpace.id;

  // (a) non-overlapping ACTIVE insert -> permitted.
  const nonOverlapping = businessWindow(DATE, '11:00', '13:00');
  const allowed = insertOccupancy(db, {
    unitId, spaceId, startAt: nonOverlapping.startAt, endAt: nonOverlapping.endAt,
  });
  assert.equal(allowed.ok, true, `a non-overlapping ACTIVE insert must be permitted: ${allowed.message}`);

  // (b) overlapping row whose status is RELEASED -> permitted (audit history).
  const releasedOverlap = insertOccupancy(db, {
    unitId, spaceId, startAt: window.startAt, endAt: window.endAt, status: 'RELEASED',
  });
  assert.equal(releasedOverlap.ok, true, `an overlapping RELEASED insert must be permitted: ${releasedOverlap.message}`);

  // (c) updating an ACTIVE row so it becomes RELEASED over an occupied interval -> permitted.
  const activeRowId = Number(allowed.result.lastInsertRowid);
  const overlapping = businessWindow(DATE, '09:15', '09:45');
  const releaseUpdate = attempt(() => db.prepare(
    "UPDATE occupancy SET status = 'RELEASED', start_at = ?, end_at = ?, released_at = ? WHERE id = ?",
  ).run(overlapping.startAt, overlapping.endAt, Date.now(), activeRowId));
  assert.equal(releaseUpdate.ok, true, `a release over an occupied interval must be permitted: ${releaseUpdate.message}`);
  assert.equal(
    db.prepare('SELECT status FROM occupancy WHERE id = ?').get(activeRowId).status,
    'RELEASED',
    'the row must actually have been released',
  );

  // (d) and an interval only ever covered by a RELEASED row is claimable ACTIVE again.
  const freed = businessWindow(DATE, '11:30', '12:30');
  const reclaim = insertOccupancy(db, {
    unitId, spaceId, startAt: freed.startAt, endAt: freed.endAt,
  });
  assert.equal(reclaim.ok, true, 'a freed interval must be claimable again');
});

test('CASE 30: foreign keys are ON and deleting a reservation cascades its occupancy rows', (t) => {
  const { db, scenario, cleanup, reservationId } = scenarioWithBooking('case30-cascade');
  t.after(cleanup);

  const foreignKeys = db.prepare('PRAGMA foreign_keys').get();
  assert.equal(Number(foreignKeys.foreign_keys), 1, 'PRAGMA foreign_keys must be ON');

  const owned = countRows(db, 'SELECT COUNT(*) AS c FROM occupancy WHERE reservation_id = ?', reservationId);
  assert.equal(owned, 1, 'the reservation owns exactly one occupancy row');

  db.prepare('DELETE FROM reservation WHERE id = ?').run(reservationId);

  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM occupancy WHERE reservation_id = ?', reservationId),
    0,
    'deleting a reservation must cascade to its occupancy rows',
  );
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM occupancy WHERE resource_unit_id = ?', scenario.roomSpace.units[0].id),
    0,
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
