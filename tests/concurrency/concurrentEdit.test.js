/**
 * CASE 17-19 - concurrent edits.
 *
 * A rejected edit must leave the ORIGINAL reservation byte-for-byte unchanged:
 * same reservation row (every column) and same occupancy rows. A successful
 * pair of edits must still leave `unit_count` equal to the number of ACTIVE
 * occupancy rows. Nothing may end up torn.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservation, cancelReservation } from '../../src/server/services/bookingService.js';
import { runWorkers, BOOKING_WORKER } from '../helpers/concurrencyHelpers.js';
import {
  openScenario, attempt, futureDateKey, businessWindow, describeResults,
  reservationSnapshot, activeOccupancyRows, consistencyProblems, countRows,
  peakConcurrentUnits, occupancyRows,
} from '../helpers/bookingScenario.js';

const DATE = futureDateKey(30);

function reserve(db, scenario, { spaceId = scenario.roomSpace.id, window, unitCount = 1, purpose = null }) {
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

test('CASE 17: two processes move different reservations onto the same free slot -> 1 wins, the loser is untouched', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case17-two-edits');
  t.after(cleanup);

  const slotA = businessWindow(DATE, '09:00', '11:00');
  const slotB = businessWindow(DATE, '13:00', '15:00');
  const target = businessWindow(DATE, '11:00', '12:00'); // free, adjacent to both

  const first = reserve(db, scenario, { window: slotA, purpose: 'reservation A' });
  const second = reserve(db, scenario, { window: slotB, purpose: 'reservation B' });
  assert.equal(first.ok, true, `setup A failed: ${first.code} ${first.message}`);
  assert.equal(second.ok, true, `setup B failed: ${second.code} ${second.message}`);

  const beforeA = reservationSnapshot(db, first.result.reservation.id);
  const beforeB = reservationSnapshot(db, second.result.reservation.id);
  const sequenceBefore = db.prepare("SELECT value FROM app_sequence WHERE name = 'reservation'").get().value;

  const reservations = [first.result.reservation.id, second.result.reservation.id];
  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 2,
    action: 'updateReservation',
    payload: (index) => ({
      actor: scenario.actor,
      reservationId: reservations[index],
      patch: { startAt: target.startAt, endAt: target.endAt, purpose: `moved by worker ${index}` },
    }),
  });

  const context = describeResults(results);
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, 1, `exactly one move must succeed\n${context}`);
  assert.equal(losers.length, 1, `exactly one move must fail\n${context}`);
  assert.equal(losers[0].code, 'DOUBLE_BOOKING_CONFLICT', `loser code\n${context}`);

  const loserIndex = losers[0].index;
  const loserId = reservations[loserIndex];
  const before = loserIndex === 0 ? beforeA : beforeB;
  const after = reservationSnapshot(db, loserId);

  assert.deepEqual(after.reservation, before.reservation, 'the losing reservation row must be byte-identical');
  assert.deepEqual(after.occupancy, before.occupancy, 'the losing reservation occupancy rows must be byte-identical');

  const winnerId = reservations[winners[0].index];
  const winnerActive = activeOccupancyRows(db, winnerId);
  assert.equal(winnerActive.length, 1, 'the winner holds exactly one ACTIVE row');
  assert.equal(winnerActive[0].start_at, target.startAt, 'the winner occupies the target slot');
  assert.equal(winnerActive[0].end_at, target.endAt);

  const sequenceAfter = db.prepare("SELECT value FROM app_sequence WHERE name = 'reservation'").get().value;
  assert.equal(sequenceAfter, sequenceBefore, 'an edit does not consume a new reference');

  const activeInTarget = countRows(
    db,
    "SELECT COUNT(*) AS c FROM occupancy WHERE resource_unit_id = ? AND status = 'ACTIVE' AND start_at = ? AND end_at = ?",
    scenario.roomSpace.units[0].id, target.startAt, target.endAt,
  );
  assert.equal(activeInTarget, 1, 'exactly one ACTIVE claim on the contested slot');
  assert.equal(consistencyProblems(db, winnerId).length, 0, 'winner must be internally consistent');
  assert.equal(consistencyProblems(db, loserId).length, 0, 'loser must be internally consistent');
});

test('CASE 18: an edit and a cancellation of the same reservation never tear the state', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case18-edit-vs-cancel');
  t.after(cleanup);

  const base = [
    ['09:00', '11:00', '13:00', '15:00'],
    ['11:30', '13:30', '14:00', '16:00'],
    ['08:00', '10:00', '10:30', '12:30'],
  ];
  const observed = [];

  for (const [bookStart, bookEnd, editStart, editEnd] of base) {
    const reserved = reserve(db, scenario, {
      window: businessWindow(DATE, bookStart, bookEnd),
      purpose: `edit-vs-cancel ${bookStart}`,
    });
    assert.equal(reserved.ok, true, `setup failed: ${reserved.code} ${reserved.message}`);
    const reservationId = reserved.result.reservation.id;
    const editWindow = businessWindow(DATE, editStart, editEnd);

    const results = await runWorkers({
      workerScript: BOOKING_WORKER,
      dbPath,
      count: 2,
      action: (index) => (index === 0 ? 'updateReservation' : 'cancelReservation'),
      payload: (index) => (index === 0
        ? { actor: scenario.actor, reservationId, patch: { startAt: editWindow.startAt, endAt: editWindow.endAt } }
        : { actor: scenario.actor, reservationId, reason: 'Client postponed the session' }),
    });

    const context = describeResults(results);
    const editResult = results[0];
    const cancelResult = results[1];

    assert.ok(editResult.ok || cancelResult.ok, `at least one operation must take effect\n${context}`);

    // The state invariant, checked on committed state.
    const problems = consistencyProblems(db, reservationId);
    assert.deepEqual(problems, [], `torn state after the race\n${context}`);

    const row = db.prepare('SELECT * FROM reservation WHERE id = ?').get(reservationId);
    const active = activeOccupancyRows(db, reservationId);
    if (row.status === 'CANCELLED') {
      assert.equal(active.length, 0, 'a cancelled reservation must hold no ACTIVE occupancy');
      assert.equal(cancelResult.ok, true, 'only a successful cancel may leave status CANCELLED');
    } else {
      assert.equal(row.status, 'CONFIRMED');
      assert.equal(active.length, row.unit_count, 'a confirmed reservation holds unit_count ACTIVE rows');
      assert.equal(active[0].start_at, row.start_at);
      assert.equal(active[0].end_at, row.end_at);
    }

    if (!editResult.ok) {
      assert.equal(editResult.code, 'CONFLICT', `a lost edit must fail with CONFLICT, got ${editResult.code}: ${editResult.error}`);
      assert.equal(cancelResult.ok, true, 'the cancel must be the operation that won');
    }
    observed.push(`[${bookStart}-${bookEnd}] edit=${editResult.code ?? 'OK'} cancel=${cancelResult.code ?? 'OK'} final=${row.status} active=${active.length}`);
  }

  console.log(`CASE 18 edit-vs-cancel outcomes:\n  ${observed.join('\n  ')}`);
  assert.equal(observed.length, 3);
});

test('CASE 19: two concurrent unit_count changes -> unit_count equals the ACTIVE occupancy rows', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case19-unit-count');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '17:00');
  const reserved = reserve(db, scenario, { spaceId: scenario.deskSpace.id, window, unitCount: 1, purpose: 'shared desk plan' });
  assert.equal(reserved.ok, true, `setup failed: ${reserved.code} ${reserved.message}`);
  const reservationId = reserved.result.reservation.id;

  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 2,
    action: 'updateReservation',
    payload: (index) => ({
      actor: scenario.actor,
      reservationId,
      patch: { unitCount: index === 0 ? 5 : 3 },
    }),
  });

  const context = describeResults(results);
  assert.ok(results.some((result) => result.ok), `at least one resize must succeed\n${context}`);
  for (const result of results.filter((entry) => !entry.ok)) {
    assert.equal(result.code, 'DOUBLE_BOOKING_CONFLICT', `resize failure code\n${context}`);
  }

  const row = db.prepare('SELECT * FROM reservation WHERE id = ?').get(reservationId);
  const active = activeOccupancyRows(db, reservationId);
  assert.equal(active.length, row.unit_count, `unit_count=${row.unit_count} must equal the ${active.length} ACTIVE occupancy rows`);
  assert.ok([3, 5].includes(row.unit_count), `final unit_count must be one of the two attempted sizes, got ${row.unit_count}`);
  for (const occupancy of active) {
    assert.equal(occupancy.start_at, window.startAt);
    assert.equal(occupancy.end_at, window.endAt);
  }
  assert.deepEqual(consistencyProblems(db, reservationId), []);

  // The pool ceiling still holds with the enlarged reservation in place.
  const { peak } = peakConcurrentUnits(db, { spaceId: scenario.deskSpace.id, ...window, stepMs: 60000 });
  assert.ok(peak <= 20, `pool ceiling breached: ${peak}`);
  assert.equal(peak, row.unit_count, 'only this reservation holds desks in the window');

  // Every release/edit is auditable: the historical rows are retained, not deleted.
  const allRows = occupancyRows(db, reservationId);
  assert.ok(allRows.length >= row.unit_count, 'edits must keep the released rows for audit');
  console.log(`CASE 19 final unit_count=${row.unit_count}, ACTIVE rows=${active.length}, total occupancy rows=${allRows.length}`);
});
