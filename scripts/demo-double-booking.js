#!/usr/bin/env node
/**
 * Live demo: "two people cannot book the same room at the same time".
 *
 * Run:  node scripts/demo-double-booking.js
 *
 * Narrative:
 *   1. a throwaway database with one exclusive meeting room is created;
 *   2. a 09:00-11:00 booking is confirmed, and its reference is shown;
 *   3. a single-process overlap attempt is rejected, naming the blocking booking;
 *   4. the real thing: 6 child processes on the same file race for a FREE window,
 *      released at one shared wall-clock instant. One wins, five are refused by
 *      the database. Every process outcome is printed.
 *   5. verdict; the script exits non-zero if the guarantee is ever violated.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import {
  cleanupDb, runWorkers, BOOKING_WORKER,
} from '../tests/helpers/concurrencyHelpers.js';
import {
  openScenario, futureDateKey, businessWindow, clockLabel,
} from '../tests/helpers/bookingScenario.js';
import { createReservation } from '../src/server/services/bookingService.js';

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

function title(text) {
  console.log(`\n${RULE}\n${text}\n${RULE}`);
}

function step(number, text) {
  console.log(`\n[${number}] ${text}\n${THIN}`);
}

const DATE = futureDateKey(30);
const BOOKED = businessWindow(DATE, '09:00', '11:00'); // used in steps 2-3
const RACE = businessWindow(DATE, '13:00', '15:00');   // free; used in step 4
const label = (epochMs) => clockLabel(epochMs, DATE);

title('TRACE DOUBLE-BOOKING DEMO - one room, one window, many processes');
console.log(`Room window : ${DATE} ${label(RACE.startAt)}-${label(RACE.endAt)} (Asia/Colombo, half-open)`);
console.log('Engine      : node:sqlite / SQLite, WAL, busy_timeout = 10000, BEGIN IMMEDIATE + DB triggers');

/* ------------------------------------------------------- 1. temp database */
step(1, 'Create a throwaway database and seed one exclusive room + one customer');
const { db, dbPath, scenario, cleanup } = openScenario('demo-double-booking');
console.log(`database file : ${dbPath}`);
console.log(`room          : #${scenario.roomSpace.id} ${scenario.roomSpace.code} (${scenario.roomSpace.units.length} bookable resource unit: ${scenario.roomSpace.units[0].code})`);
console.log(`customer      : #${scenario.customer.id} ${scenario.customer.fullName}`);

let exitCode = 0;
try {
  /* --------------------------------------------------- 2. a valid booking */
  step(2, `Confirm a legitimate booking, ${label(BOOKED.startAt)}-${label(BOOKED.endAt)}`);
  const first = createReservation(db, {
    actor: scenario.actor,
    spaceId: scenario.roomSpace.id,
    customerId: scenario.customer.id,
    startAt: BOOKED.startAt,
    endAt: BOOKED.endAt,
    unitCount: 1,
    purpose: 'Quarterly review',
  });
  console.log(`CONFIRMED ${first.reservation.reference}  units: ${first.reservation.unitCodes.join(', ')}  status: ${first.reservation.status}`);

  /* ------------------------------------ 3. the single-process rejection */
  step(3, 'A second, overlapping request from the same process');
  let conflictReference = '(no conflict reference returned)';
  try {
    createReservation(db, {
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt: BOOKED.startAt,
      endAt: businessWindow(DATE, '10:00', '12:00').endAt,
      unitCount: 1,
      purpose: 'Overlapping request',
    });
    console.log('!! UNEXPECTED: the overlapping request was confirmed.');
    exitCode = 1;
  } catch (error) {
    const conflicts = error?.conflicts ?? error?.details?.conflicts ?? [];
    conflictReference = conflicts.map((entry) => entry.reservationReference ?? entry.label).filter(Boolean).join(', ')
      || '(conflict list empty)';
    console.log(`REJECTED  code=${error.code}`);
    console.log(`          message="${error.message}"`);
    console.log(`          blocked by: ${conflictReference}`);
  }
  console.log(`confirmed reservations for the room: ${db.prepare(
    "SELECT COUNT(*) AS c FROM reservation WHERE space_id = ? AND status = 'CONFIRMED'",
  ).get(scenario.roomSpace.id).c}`);

  /* --------------------------------------------- 4. the real multiprocess */
  step(4, `The real test: 6 separate OS processes race for the FREE window ${label(RACE.startAt)}-${label(RACE.endAt)}`);
  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 6,
    action: 'createReservation',
    payload: (index) => ({
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt: RACE.startAt,
      endAt: RACE.endAt,
      unitCount: 1,
      purpose: `Simultaneous request #${index}`,
    }),
  });

  const starts = results.map((result) => result.startedAt).filter((value) => Number.isFinite(value));
  const skew = starts.length > 1 ? Math.max(...starts) - Math.min(...starts) : 0;
  const raceZero = starts.length ? Math.min(...starts) : 0;

  console.log('process #  pid      start offset  outcome    code / detail');
  console.log(THIN);
  for (const result of results) {
    const offset = result.startedAt ? `+${result.startedAt - raceZero} ms` : '?';
    const outcome = result.ok ? 'CONFIRMED' : 'REFUSED';
    const blockedBy = !result.ok && Array.isArray(result.conflicts) && result.conflicts.length
      ? ` blocked by ${result.conflicts.map((entry) => entry.reservationReference ?? entry.label).filter(Boolean).join(', ')}`
      : '';
    const detail = result.ok
      ? `${result.result.reservation.reference} on ${result.result.reservation.unitCodes.join(', ')}`
      : `${result.code} — ${result.error ?? ''}${blockedBy}`;
    console.log(`${String(result.index).padStart(7)}  ${String(result.pid ?? '-').padEnd(8)}  ${offset.padStart(11)}  ${outcome.padEnd(10)} ${detail}`);
  }
  console.log(THIN);
  console.log(`all six processes opened the SAME database file: ${dbPath}`);
  console.log(`start-time skew across the 6 processes: ${skew} ms`);

  /* --------------------------------------------------------- 5. verdict */
  const raceConfirmed = db.prepare(`
    SELECT reference, start_at, end_at FROM reservation
     WHERE space_id = ? AND status = 'CONFIRMED' AND start_at < ? AND end_at > ?
     ORDER BY id
  `).all(scenario.roomSpace.id, RACE.endAt, RACE.startAt);
  const raceActiveRows = db.prepare(`
    SELECT COUNT(*) AS c FROM occupancy
     WHERE resource_unit_id = ? AND status = 'ACTIVE' AND start_at < ? AND end_at > ?
  `).get(scenario.roomSpace.units[0].id, RACE.endAt, RACE.startAt).c;
  const confirmedCount = results.filter((result) => result.ok).length;
  const refusedCount = results.filter((result) => !result.ok).length;

  step(5, 'Verdict');
  console.log(`processes that confirmed : ${confirmedCount} (expected 1)`);
  console.log(`processes refused        : ${refusedCount} (expected 5)`);
  console.log(`CONFIRMED for the raced window : ${raceConfirmed.length} ${JSON.stringify(raceConfirmed)}`);
  console.log(`ACTIVE occupancy rows, raced window : ${raceActiveRows} (expected 1)`);

  const ok = confirmedCount === 1
    && refusedCount === 5
    && results.every((result) => result.ok || result.code === 'DOUBLE_BOOKING_CONFLICT')
    && raceConfirmed.length === 1
    && raceActiveRows === 1;

  if (ok) {
    console.log('\nGUARANTEE HOLDS: six simultaneous OS processes, exactly one confirmed booking,');
    console.log('no second reservation row, no second occupancy claim.');
  } else {
    console.log('\n!! GUARANTEE VIOLATED - inspect the outcomes above.');
    exitCode = 1;
  }

  const winner = results.find((result) => result.ok);
  console.log(`\n(single winner: ${winner?.result.reservation.reference ?? 'n/a'}; step 3 rejection was blocked by: ${conflictReference})`);
} catch (error) {
  console.error('\nDemo failed unexpectedly:', error);
  exitCode = 1;
} finally {
  cleanup();
  console.log('\nTemporary database removed. Demo complete.');
}

process.exit(exitCode);
