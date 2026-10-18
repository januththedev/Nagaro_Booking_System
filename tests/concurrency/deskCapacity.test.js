/**
 * CASE 12-16 - pooled co-working inventory.
 *
 * "Never more than N desks at once" is not a counter: it is the same
 * per-resource-unit non-overlap rule that prevents room double booking, with
 * N independent resource units. These tests exercise the pool under real
 * multi-process contention and prove the per-instant ceiling by querying.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservation, cancelReservation } from '../../src/server/services/bookingService.js';
import { runWorkers, BOOKING_WORKER } from '../helpers/concurrencyHelpers.js';
import {
  openScenario, attempt, futureDateKey, businessWindow, describeResults, successIndices,
  activeOccupancyRows, countRows, peakConcurrentUnits,
} from '../helpers/bookingScenario.js';

const DATE = futureDateKey(30);
const DESK_COUNT = 20;

function clock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 30 windows that all contain 10:30 business-local, so they overlap pairwise. */
const DESK_RACE_CLOCKS = Array.from({ length: 30 }, (_, index) => {
  const startMinute = 9 * 60 + ((index * 3) % 88); // 09:00 .. 10:27
  const duration = 100 + (index % 6) * 7;          // 100 .. 135 minutes
  return [clock(startMinute), clock(startMinute + duration)];
});

function reserve(db, scenario, window, unitCount, purpose) {
  return attempt(() => createReservation(db, {
    actor: scenario.actor,
    spaceId: scenario.deskSpace.id,
    customerId: scenario.customer.id,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount,
    purpose,
  }));
}

test('CASE 12: 20 processes, 1 desk each, identical whole-day window -> all 20 succeed on 20 distinct desks', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case12-20-desks', { deskCount: DESK_COUNT });
  t.after(cleanup);

  const window = businessWindow(DATE, '08:00', '18:00');
  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: DESK_COUNT,
    action: 'createReservation',
    payload: (index) => ({
      actor: scenario.actor,
      spaceId: scenario.deskSpace.id,
      customerId: scenario.customer.id,
      startAt: window.startAt,
      endAt: window.endAt,
      unitCount: 1,
      purpose: `desk worker ${index}`,
    }),
  });

  const context = describeResults(results);
  assert.equal(successIndices(results).length, DESK_COUNT, `all 20 one-desk requests must succeed\n${context}`);
  for (const result of results) {
    assert.equal(result.ok, true, `worker #${result.index} failed: ${result.code} ${result.error}\n${context}`);
  }

  const codes = results.map((result) => result.result.reservation.unitCodes[0]);
  assert.equal(new Set(codes).size, DESK_COUNT, `20 distinct desks expected, got ${new Set(codes).size}`);

  const activeRows = db.prepare(
    "SELECT resource_unit_id FROM occupancy WHERE space_id = ? AND status = 'ACTIVE'",
  ).all(scenario.deskSpace.id);
  assert.equal(activeRows.length, DESK_COUNT, 'one ACTIVE row per desk');
  assert.equal(new Set(activeRows.map((row) => row.resource_unit_id)).size, DESK_COUNT, 'distinct desk rows');

  const { peak } = peakConcurrentUnits(db, { spaceId: scenario.deskSpace.id, ...window, stepMs: 60000 });
  assert.equal(peak, DESK_COUNT, 'the whole pool is in use at the peak instant');
});

test('CASE 13: 20 desks all booked, then a 21st one-desk request -> rejected', async (t) => {
  const { db, scenario, cleanup } = openScenario('case13-21st-desk', { deskCount: DESK_COUNT });
  t.after(cleanup);

  const window = businessWindow(DATE, '08:00', '18:00');
  for (let index = 0; index < DESK_COUNT; index += 1) {
    const booked = reserve(db, scenario, window, 1, `fill desk ${index}`);
    assert.equal(booked.ok, true, `setup booking ${index} failed: ${booked.code} ${booked.message}`);
  }

  const overflow = reserve(db, scenario, window, 1, 'the 21st desk');
  assert.equal(overflow.ok, false, 'a 21st desk request must be rejected');
  assert.equal(overflow.code, 'DOUBLE_BOOKING_CONFLICT', `observed ${overflow.code}: ${overflow.message}`);
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ?', scenario.deskSpace.id),
    DESK_COUNT,
    'no reservation row may be created for the rejected request',
  );
  assert.equal(
    countRows(db, "SELECT COUNT(*) AS c FROM occupancy WHERE space_id = ? AND status = 'ACTIVE'", scenario.deskSpace.id),
    DESK_COUNT,
  );
});

test('CASE 14: a 2-desk request needs two real cancellations before it fits', async (t) => {
  const { db, scenario, cleanup } = openScenario('case14-two-cancellations', { deskCount: DESK_COUNT });
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '17:00');
  const reservations = [];
  for (let index = 0; index < DESK_COUNT; index += 1) {
    const booked = reserve(db, scenario, window, 1, `fill desk ${index}`);
    assert.equal(booked.ok, true, `setup booking ${index} failed: ${booked.code} ${booked.message}`);
    reservations.push(booked.result.reservation);
  }

  const whileFull = reserve(db, scenario, window, 2, 'two desks while full');
  assert.equal(whileFull.ok, false);
  assert.equal(whileFull.code, 'DOUBLE_BOOKING_CONFLICT', `observed ${whileFull.code}: ${whileFull.message}`);

  const cancelOne = cancelReservation(db, {
    actor: scenario.actor, reservationId: reservations[0].id, reason: 'Client moved the meeting',
  });
  assert.equal(cancelOne.releasedOccupancyRows, 1);

  const afterOne = reserve(db, scenario, window, 2, 'two desks with one free');
  assert.equal(afterOne.ok, false, 'one free desk cannot satisfy a two-desk request');
  assert.equal(afterOne.code, 'DOUBLE_BOOKING_CONFLICT', `observed ${afterOne.code}: ${afterOne.message}`);

  const cancelTwo = cancelReservation(db, {
    actor: scenario.actor, reservationId: reservations[1].id, reason: 'Client moved the meeting too',
  });
  assert.equal(cancelTwo.releasedOccupancyRows, 1);

  const afterTwo = reserve(db, scenario, window, 2, 'two desks with two free');
  assert.equal(afterTwo.ok, true, `two free desks must satisfy a two-desk request: ${afterTwo.code} ${afterTwo.message}`);
  assert.equal(afterTwo.result.reservation.unitCount, 2);
  assert.equal(activeOccupancyRows(db, afterTwo.result.reservation.id).length, 2);

  const { peak } = peakConcurrentUnits(db, { spaceId: scenario.deskSpace.id, ...window, stepMs: 60000 });
  assert.equal(peak, DESK_COUNT, `the pool must end exactly full, peak was ${peak}`);
});

test('CASE 15: 30 processes, overlapping windows, 1 desk each -> exactly 20 succeed and never more than 20 desks at any instant', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case15-30-workers', { deskCount: DESK_COUNT });
  t.after(cleanup);

  const windows = DESK_RACE_CLOCKS.map(([start, end]) => businessWindow(DATE, start, end));
  for (const [start, end] of DESK_RACE_CLOCKS) {
    assert.ok(start < '10:30' && end > '10:30', `fixture window ${start}-${end} must contain 10:30`);
  }

  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: windows.length,
    action: 'createReservation',
    payload: (index) => ({
      actor: scenario.actor,
      spaceId: scenario.deskSpace.id,
      customerId: scenario.customer.id,
      startAt: windows[index].startAt,
      endAt: windows[index].endAt,
      unitCount: 1,
      purpose: `overlapping desk worker ${index}`,
    }),
  });

  const context = describeResults(results);
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, DESK_COUNT, `exactly 20 of 30 must succeed\n${context}`);
  assert.equal(losers.length, windows.length - DESK_COUNT, `exactly 10 must fail\n${context}`);
  for (const loser of losers) {
    assert.equal(loser.code, 'DOUBLE_BOOKING_CONFLICT', `loser #${loser.index}\n${context}`);
  }

  const unionWindow = {
    startAt: Math.min(...windows.map((window) => window.startAt)),
    endAt: Math.max(...windows.map((window) => window.endAt)),
  };
  const { peak, peakAt, samples } = peakConcurrentUnits(db, {
    spaceId: scenario.deskSpace.id, ...unionWindow, stepMs: 60000,
  });
  const overfull = samples.filter((sample) => sample.used > DESK_COUNT);
  assert.equal(overfull.length, 0, `instants above the desk ceiling: ${JSON.stringify(overfull.slice(0, 5))}`);
  assert.equal(peak, DESK_COUNT, `the pool must be saturated at the peak (peak was ${peak})`);
  assert.ok(peakAt !== null, 'peak instant expected');

  const allocatedDesks = winners.map((result) => result.result.reservation.unitCodes[0]);
  assert.equal(new Set(allocatedDesks).size, DESK_COUNT, 'the 20 winners hold 20 distinct desks');

  // One sample of the per-instant proof, quoted for the report.
  const sample = samples[Math.floor(samples.length / 2)];
  console.log(`CASE 15 per-instant desk usage: ${samples.length} one-minute instants checked, peak ${peak} desks at ${peakAt}; middle sample ${sample.used}`);
});

test('CASE 16: two concurrent 3-desk requests with only 5 desks free -> exactly 1 succeeds', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case16-two-three-desk', { deskCount: DESK_COUNT });
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '17:00');
  for (let index = 0; index < 15; index += 1) {
    const booked = reserve(db, scenario, window, 1, `fill desk ${index}`);
    assert.equal(booked.ok, true, `setup booking ${index} failed: ${booked.code} ${booked.message}`);
  }
  const before = peakConcurrentUnits(db, { spaceId: scenario.deskSpace.id, ...window, stepMs: 60000 }).peak;
  assert.equal(before, 15, 'setup must leave exactly 15 desks occupied');

  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 2,
    action: 'createReservation',
    payload: (index) => ({
      actor: scenario.actor,
      spaceId: scenario.deskSpace.id,
      customerId: scenario.customer.id,
      startAt: window.startAt,
      endAt: window.endAt,
      unitCount: 3,
      purpose: `three-desk request ${index}`,
    }),
  });

  const context = describeResults(results);
  const winners = results.filter((result) => result.ok);
  const losers = results.filter((result) => !result.ok);
  assert.equal(winners.length, 1, `only one 3-desk request can fit in 5 free desks\n${context}`);
  assert.equal(losers.length, 1, `one request must fail\n${context}`);
  assert.equal(losers[0].code, 'DOUBLE_BOOKING_CONFLICT', `observed ${losers[0].code}: ${losers[0].error}\n${context}`);
  assert.equal(winners[0].result.reservation.unitCount, 3);

  const racingUnitCounts = [winners[0], ...losers].map((result) => (result.ok ? result.result.reservation.unitCount : 0));
  assert.ok(
    racingUnitCounts.reduce((sum, value) => sum + value, 0) <= 5,
    `the two racing requests may consume at most the 5 free desks, got ${racingUnitCounts}`,
  );

  const { peak } = peakConcurrentUnits(db, { spaceId: scenario.deskSpace.id, ...window, stepMs: 60000 });
  assert.equal(peak, 18, `15 pre-booked + 3 from the winner = 18 desks, peak was ${peak}`);
  assert.ok(peak <= DESK_COUNT, 'never above the pool size');
});
