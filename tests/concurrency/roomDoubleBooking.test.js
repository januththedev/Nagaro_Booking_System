/**
 * CASE 1-4 - the headline guarantee.
 *
 * An EXCLUSIVE meeting room has exactly one bookable resource unit. Real child
 * processes, each with its own connection to the same on-disk database, all
 * attempt the booking at the same wall-clock instant. Exactly one may win.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkers, BOOKING_WORKER } from '../helpers/concurrencyHelpers.js';
import {
  openScenario, futureDateKey, businessWindow, describeResults, successIndices,
  confirmedReservationsInWindow, countRows, activeOccupancyRows, sequenceValue,
} from '../helpers/bookingScenario.js';

const DATE = futureDateKey(30);

/** All eight windows below contain 09:30 and therefore overlap each other pairwise. */
const OVERLAPPING_CLOCKS = [
  ['08:00', '09:45'],
  ['08:30', '09:31'],
  ['09:00', '11:00'],
  ['09:15', '10:15'],
  ['09:29', '10:30'],
  ['09:30', '12:00'],
  ['09:00', '10:00'],
  ['08:45', '10:15'],
];

/** Six half-open adjacent windows: 08-09, 09-10, ... 13-14. */
const ADJACENT_CLOCKS = [
  ['08:00', '09:00'],
  ['09:00', '10:00'],
  ['10:00', '11:00'],
  ['11:00', '12:00'],
  ['12:00', '13:00'],
  ['13:00', '14:00'],
];

function roomJob(scenario, window, index, extra = {}) {
  return {
    actor: scenario.actor,
    spaceId: scenario.roomSpace.id,
    customerId: scenario.customer.id,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount: 1,
    purpose: `concurrency case worker ${index}`,
    ...extra,
  };
}

function activeRoomRows(db, scenario) {
  return countRows(
    db,
    "SELECT COUNT(*) AS c FROM occupancy WHERE resource_unit_id = ? AND status = 'ACTIVE'",
    scenario.roomSpace.units[0].id,
  );
}

test('CASE 1: 8 processes, identical room and identical window -> exactly 1 confirmed', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case1-identical');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 8,
    action: 'createReservation',
    payload: (index) => roomJob(scenario, window, index),
  });

  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  const context = describeResults(results);

  // Every worker really did start at the same moment (evidence, not decoration).
  const startedAt = results.map((result) => result.startedAt).filter((value) => Number.isFinite(value));
  const skewMs = startedAt.length > 1 ? Math.max(...startedAt) - Math.min(...startedAt) : 0;
  console.log(`CASE 1 start skew across 8 OS processes: ${skewMs} ms`);

  assert.equal(winners.length, 1, `expected exactly 1 success\n${context}`);
  assert.equal(losers.length, 7, `expected exactly 7 failures\n${context}`);
  for (const loser of losers) {
    assert.equal(loser.code, 'DOUBLE_BOOKING_CONFLICT', `loser #${loser.index} code\n${context}`);
  }
  assert.ok(skewMs <= 1000, `workers did not fire together (skew ${skewMs} ms)\n${context}`);

  // Each rejection can name what beat it - the winner's own reference.
  const winnerReference = winners[0].result.reservation.reference;
  for (const loser of losers) {
    assert.ok(Array.isArray(loser.conflicts) && loser.conflicts.length > 0,
      `loser #${loser.index} reported no conflicting booking\n${context}`);
    assert.ok(loser.conflicts.some((conflict) => conflict.reservationReference === winnerReference),
      `loser #${loser.index} did not name the winning reference ${winnerReference}\n${context}`);
  }

  // Committed state, read by the parent.
  const confirmed = confirmedReservationsInWindow(db, { spaceId: scenario.roomSpace.id, ...window });
  assert.equal(confirmed.length, 1, 'exactly one CONFIRMED reservation must exist for the window');
  assert.equal(confirmed[0].reference, winnerReference);
  assert.equal(activeRoomRows(db, scenario), 1, 'the room must hold exactly one ACTIVE occupancy row');
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ?', scenario.roomSpace.id),
    1,
    'no losing attempt may leave a reservation row behind',
  );
  assert.equal(sequenceValue(db, 'reservation'), 1, 'only the winning booking may consume a reference');
});

test('CASE 2: 8 processes, mutually overlapping (but not identical) windows -> exactly 1 confirmed', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case2-overlapping');
  t.after(cleanup);

  const windows = OVERLAPPING_CLOCKS.map(([start, end]) => businessWindow(DATE, start, end));
  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: windows.length,
    action: 'createReservation',
    payload: (index) => roomJob(scenario, windows[index], index),
  });

  const context = describeResults(results);
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1, `expected exactly 1 success\n${context}`);
  for (const loser of results.filter((result) => !result.ok)) {
    assert.equal(loser.code, 'DOUBLE_BOOKING_CONFLICT', `loser #${loser.index}\n${context}`);
  }

  // Every requested window intersects the winner, so nothing else can be committed.
  const winnerWindow = windows[winners[0].index];
  for (const window of windows) {
    assert.ok(window.startAt < winnerWindow.endAt && window.endAt > winnerWindow.startAt,
      'the fixture windows must all overlap the winner');
  }
  assert.equal(activeRoomRows(db, scenario), 1);
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ?', scenario.roomSpace.id),
    1,
  );
  assert.equal(sequenceValue(db, 'reservation'), 1);
});

test('CASE 3: 6 processes on distinct non-overlapping windows -> all 6 succeed', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case3-adjacent');
  t.after(cleanup);

  const windows = ADJACENT_CLOCKS.map(([start, end]) => businessWindow(DATE, start, end));
  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: windows.length,
    action: 'createReservation',
    payload: (index) => roomJob(scenario, windows[index], index),
  });

  const context = describeResults(results);
  assert.deepEqual(successIndices(results).length, windows.length, `all 6 adjacent bookings must succeed\n${context}`);
  for (const result of results) {
    assert.equal(result.ok, true, `worker #${result.index} failed with ${result.code}: ${result.error}\n${context}`);
  }

  const references = results.map((result) => result.result.reservation.reference);
  assert.equal(new Set(references).size, windows.length, 'references must be unique');
  assert.equal(activeRoomRows(db, scenario), windows.length, 'one ACTIVE row per booking');
  assert.equal(sequenceValue(db, 'reservation'), windows.length);
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ?', scenario.roomSpace.id),
    windows.length,
  );
});

test('CASE 4: 10 rounds x 8 processes on 10 fresh databases -> exactly 1 winner every round', async (t) => {
  t.diagnostic('each round: 8 real OS processes, identical room, identical window, fresh database file');
  const successesPerRound = [];

  for (let round = 0; round < 10; round += 1) {
    const { db, dbPath, scenario, cleanup } = openScenario(`case4-round${round}`);
    try {
      const window = businessWindow(DATE, '09:00', '11:00');
      const results = await runWorkers({
        workerScript: BOOKING_WORKER,
        dbPath,
        count: 8,
        action: 'createReservation',
        payload: (index) => roomJob(scenario, window, index),
      });
      const context = describeResults(results);
      const winners = results.filter((result) => result.ok);
      successesPerRound.push(winners.length);

      assert.equal(winners.length, 1, `round ${round}: expected exactly 1 success\n${context}`);
      for (const loser of results.filter((result) => !result.ok)) {
        assert.equal(loser.code, 'DOUBLE_BOOKING_CONFLICT', `round ${round} loser #${loser.index}\n${context}`);
      }
      assert.equal(activeRoomRows(db, scenario), 1, `round ${round}: exactly one ACTIVE row`);
      assert.equal(
        countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ?', scenario.roomSpace.id),
        1,
        `round ${round}: exactly one reservation row`,
      );
      assert.equal(sequenceValue(db, 'reservation'), 1, `round ${round}: exactly one reference consumed`);
    } finally {
      cleanup();
    }
  }

  console.log(`CASE 4 successes per round (10 rounds x 8 processes): [${successesPerRound.join(', ')}]`);
  t.diagnostic(`successes per round: [${successesPerRound.join(', ')}]`);
  assert.deepEqual(successesPerRound, new Array(10).fill(1));
});
