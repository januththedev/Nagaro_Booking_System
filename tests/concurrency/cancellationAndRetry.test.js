/**
 * CASE 20-23 - cancellation, retry safety and cancellation-then-rebook.
 *
 * Cancellation releases inventory exactly once: the status transition is an
 * optimistic `UPDATE ... WHERE status = 'CONFIRMED'`, so a repeated request
 * changes zero rows. Idempotency keys make a retried creation return the
 * original reservation instead of creating a second one.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservation, cancelReservation } from '../../src/server/services/bookingService.js';
import { runWorkers, BOOKING_WORKER } from '../helpers/concurrencyHelpers.js';
import {
  openScenario, attempt, futureDateKey, businessWindow, describeResults,
  activeOccupancyRows, countRows, reservationRow, consistencyProblems,
} from '../helpers/bookingScenario.js';

const DATE = futureDateKey(30);

function reserve(db, scenario, window, unitCount, purpose) {
  return attempt(() => createReservation(db, {
    actor: scenario.actor,
    spaceId: scenario.roomSpace.id,
    customerId: scenario.customer.id,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount,
    purpose,
  }));
}

test('CASE 20: 6 processes cancel the same reservation -> exactly 1 succeeds and inventory is released once', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case20-six-cancels');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '17:00');
  const reserved = attempt(() => createReservation(db, {
    actor: scenario.actor,
    spaceId: scenario.deskSpace.id,
    customerId: scenario.customer.id,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount: 3,
    purpose: 'three desks to cancel',
  }));
  assert.equal(reserved.ok, true, `setup failed: ${reserved.code} ${reserved.message}`);
  const reservationId = reserved.result.reservation.id;
  assert.equal(activeOccupancyRows(db, reservationId).length, 3, 'setup must allocate 3 desks');

  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 6,
    action: 'cancelReservation',
    payload: (index) => ({
      actor: scenario.actor,
      reservationId,
      reason: `Cancellation attempt ${index}`,
    }),
  });

  const context = describeResults(results);
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, 1, `exactly one cancellation may succeed\n${context}`);
  assert.equal(winners[0].result.releasedOccupancyRows, 3, 'the winner releases exactly the original allocation');
  assert.equal(losers.length, 5, `five cancellations must be rejected\n${context}`);
  for (const loser of losers) {
    assert.equal(loser.code, 'CONFLICT', `loser #${loser.index} must fail with CONFLICT\n${context}`);
  }

  const releasedTotal = results.reduce(
    (sum, result) => sum + (result.ok ? Number(result.result.releasedOccupancyRows ?? 0) : 0),
    0,
  );
  assert.equal(releasedTotal, 3, `releasedOccupancyRows must sum to exactly the original allocation (3), got ${releasedTotal}`);

  assert.equal(activeOccupancyRows(db, reservationId).length, 0, 'no ACTIVE occupancy may remain');
  assert.equal(
    countRows(db, "SELECT COUNT(*) AS c FROM occupancy WHERE reservation_id = ? AND status = 'RELEASED'", reservationId),
    3,
    'the three released rows are retained for audit',
  );
  const row = reservationRow(db, reservationId);
  assert.equal(row.status, 'CANCELLED');
  assert.ok(row.cancelled_at);
  assert.ok(row.cancellation_reason.trim().length > 0);
  assert.deepEqual(consistencyProblems(db, reservationId), []);
});

test('CASE 21: 8 processes with the same idempotency key -> one reservation, one reference', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case21-idempotent');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  const idempotencyKey = `retry-${Date.now()}-room-window`;

  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 8,
    action: 'createReservationWithIdempotencyKey',
    payload: (index) => ({
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt: window.startAt,
      endAt: window.endAt,
      unitCount: 1,
      purpose: `retry attempt ${index}`,
      idempotencyKey,
    }),
  });

  const context = describeResults(results);
  for (const result of results) {
    assert.equal(result.ok, true, `worker #${result.index} failed: ${result.code} ${result.error}\n${context}`);
  }

  const references = new Set(results.map((result) => result.result.reservation.reference));
  assert.equal(references.size, 1, `all retries must return the same reference, got ${[...references].join(', ')}\n${context}`);
  const injected = results.filter((result) => result.result.idempotent === false);
  const replayed = results.filter((result) => result.result.idempotent === true);
  assert.equal(injected.length, 1, `exactly one worker may actually insert\n${context}`);
  assert.equal(replayed.length, 7, `the other seven must be reported as idempotent replays\n${context}`);

  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE idempotency_key = ?', idempotencyKey),
    1,
    'exactly one reservation row may exist for the idempotency key',
  );
  assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM reservation'), 1, 'no duplicate reservation');
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ? AND status = ?', scenario.roomSpace.id, 'CONFIRMED'),
    1,
  );
  assert.equal(activeOccupancyRows(db, results[0].result.reservation.id).length, 1);

  // A 9th, sequential call with the same key.
  const ninth = reserve(db, scenario, window, 1, 'sequential retry');
  assert.equal(ninth.ok, false, 'the room is already booked, so the sequential retry must not create a second reservation');

  const sequential = attempt(() => createReservation(db, {
    actor: scenario.actor,
    spaceId: scenario.roomSpace.id,
    customerId: scenario.customer.id,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount: 1,
    purpose: 'sequential retry with key',
    idempotencyKey,
  }));
  assert.equal(sequential.ok, true, `an idempotent retry must succeed: ${sequential.code} ${sequential.message}`);
  assert.equal(sequential.result.idempotent, true, 'the ninth call must be reported as an idempotent replay');
  assert.equal(sequential.result.reservation.reference, [...references][0], 'the ninth call must return the original reference');
  assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM reservation'), 1);
});

test('CASE 22: cancel a room booking, then a 4-process burst for the freed window -> exactly 1 succeeds', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case22-cancel-rebook');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  const original = reserve(db, scenario, window, 1, 'original booking');
  assert.equal(original.ok, true, `setup failed: ${original.code} ${original.message}`);

  const cancelled = cancelReservation(db, {
    actor: scenario.actor,
    reservationId: original.result.reservation.id,
    reason: 'Client cancelled, slot released',
  });
  assert.equal(cancelled.releasedOccupancyRows, 1);

  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 4,
    action: 'createReservation',
    payload: (index) => ({
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt: window.startAt,
      endAt: window.endAt,
      unitCount: 1,
      purpose: `rebook attempt ${index}`,
    }),
  });

  const context = describeResults(results);
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1, `exactly one rebooking may succeed\n${context}`);
  for (const loser of results.filter((result) => !result.ok)) {
    assert.equal(loser.code, 'DOUBLE_BOOKING_CONFLICT', `loser #${loser.index}\n${context}`);
  }
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ? AND status = ?', scenario.roomSpace.id, 'CONFIRMED'),
    1,
  );
  assert.equal(
    countRows(db, "SELECT COUNT(*) AS c FROM occupancy WHERE resource_unit_id = ? AND status = 'ACTIVE'", scenario.roomSpace.units[0].id),
    1,
  );
  assert.equal(
    countRows(db, "SELECT COUNT(*) AS c FROM occupancy WHERE resource_unit_id = ? AND status = 'RELEASED'", scenario.roomSpace.units[0].id),
    1,
    'the cancelled claim is kept as history',
  );
});

test('CASE 23: a whitespace-only cancellation reason is rejected and changes nothing', (t) => {
  const { db, scenario, cleanup } = openScenario('case23-blank-reason');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  const reserved = reserve(db, scenario, window, 1, 'kept booking');
  assert.equal(reserved.ok, true, `setup failed: ${reserved.code} ${reserved.message}`);
  const reservationId = reserved.result.reservation.id;
  const before = reservationRow(db, reservationId);

  for (const reason of ['   ', '\t\n  \r\n', '']) {
    const rejected = attempt(() => cancelReservation(db, { actor: scenario.actor, reservationId, reason }));
    assert.equal(rejected.ok, false, `reason ${JSON.stringify(reason)} must be rejected`);
    assert.equal(rejected.code, 'VALIDATION_ERROR', `observed ${rejected.code}: ${rejected.message}`);
  }

  const after = reservationRow(db, reservationId);
  assert.equal(after.status, 'CONFIRMED', 'the reservation must stay confirmed');
  assert.equal(after.cancelled_at, null, 'cancelled_at must stay NULL');
  assert.equal(after.cancellation_reason, null, 'cancellation_reason must stay NULL');
  assert.equal(after.updated_at, before.updated_at, 'a rejected cancellation must not touch the row');
  assert.equal(activeOccupancyRows(db, reservationId).length, 1, 'occupancy stays ACTIVE');
  assert.equal(
    countRows(db, "SELECT COUNT(*) AS c FROM occupancy WHERE reservation_id = ? AND status = 'RELEASED'", reservationId),
    0,
    'nothing may be released',
  );
  assert.equal(
    countRows(db, "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'reservation.cancelled'"),
    0,
    'a rejected cancellation must not be audited as a cancellation',
  );
});
