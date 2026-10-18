/**
 * CASE 5-11d - interval semantics at the boundaries, the turnover buffer and
 * across local midnight.
 *
 * These are sequential semantics, so they run in-process against a real
 * database: the question here is "where exactly is the edge?", not "do two
 * processes race safely?" (that is roomDoubleBooking.test.js).
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReservation, cancelReservation, createMaintenanceBlock, cancelMaintenanceBlock } from '../../src/server/services/bookingService.js';
import { runWorkers, BOOKING_WORKER } from '../helpers/concurrencyHelpers.js';
import {
  openScenario, attempt, futureDateKey, businessWindow, clockLabel,
  confirmedReservationsInWindow, activeOccupancyRows, countRows, describeResults,
} from '../helpers/bookingScenario.js';

const DATE = futureDateKey(30);
const NEXT_DATE = futureDateKey(31);

function book(db, scenario, spaceId, window, extra = {}) {
  return attempt(() => createReservation(db, {
    actor: scenario.actor,
    spaceId,
    customerId: scenario.customer.id,
    unitCount: 1,
    ...window,
    ...extra,
  }));
}

test('CASE 5: 09:00-11:00 then 11:00-13:00 -> both succeed (half-open adjacency)', (t) => {
  const { db, scenario, cleanup } = openScenario('case5-adjacent');
  t.after(cleanup);

  const first = book(db, scenario, scenario.roomSpace.id, businessWindow(DATE, '09:00', '11:00'));
  assert.equal(first.ok, true, `first booking failed: ${first.code} ${first.message}`);
  const second = book(db, scenario, scenario.roomSpace.id, businessWindow(DATE, '11:00', '13:00'));
  assert.equal(second.ok, true, `adjacent booking rejected: ${second.code} ${second.message}`);

  assert.equal(
    countRows(db, "SELECT COUNT(*) AS c FROM occupancy WHERE status = 'ACTIVE' AND resource_unit_id = ?", scenario.roomSpace.units[0].id),
    2,
    'two ACTIVE occupancy rows, touching but not overlapping',
  );
  // Sanity: a touching pair is precisely the case a naive `<=` check would reject.
  const rows = db.prepare("SELECT start_at, end_at FROM occupancy WHERE resource_unit_id = ? ORDER BY start_at").all(scenario.roomSpace.units[0].id);
  assert.equal(rows[0].end_at, rows[1].start_at, 'end of the first must equal the start of the second');
});

test('CASE 6: 09:00-11:00 then 10:59-12:00 -> second rejected', (t) => {
  const { db, scenario, cleanup } = openScenario('case6-1min-overlap');
  t.after(cleanup);

  const first = book(db, scenario, scenario.roomSpace.id, businessWindow(DATE, '09:00', '11:00'));
  assert.equal(first.ok, true, `first booking failed: ${first.code} ${first.message}`);
  const second = book(db, scenario, scenario.roomSpace.id, businessWindow(DATE, '10:59', '12:00'));
  assert.equal(second.ok, false, 'a one-minute overlap must be rejected');
  assert.equal(second.code, 'DOUBLE_BOOKING_CONFLICT');
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ?', scenario.roomSpace.id),
    1,
    'the rejected attempt must leave no reservation row',
  );
});

test('CASE 7: identical window twice -> second rejected', (t) => {
  const { db, scenario, cleanup } = openScenario('case7-identical');
  t.after(cleanup);

  const window = businessWindow(DATE, '09:00', '11:00');
  assert.equal(book(db, scenario, scenario.roomSpace.id, window).ok, true);
  const second = book(db, scenario, scenario.roomSpace.id, window);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'DOUBLE_BOOKING_CONFLICT');
});

test('CASE 8: 11:00-13:00 first, then 09:00-11:00 -> the earlier booking still succeeds', (t) => {
  const { db, scenario, cleanup } = openScenario('case8-order-independence');
  t.after(cleanup);

  const later = book(db, scenario, scenario.roomSpace.id, businessWindow(DATE, '11:00', '13:00'));
  assert.equal(later.ok, true, `later booking failed: ${later.code} ${later.message}`);
  const earlier = book(db, scenario, scenario.roomSpace.id, businessWindow(DATE, '09:00', '11:00'));
  assert.equal(earlier.ok, true, `earlier booking rejected out of order: ${earlier.code} ${earlier.message}`);

  const confirmed = confirmedReservationsInWindow(db, {
    spaceId: scenario.roomSpace.id,
    startAt: businessWindow(DATE, '08:00', '14:00').startAt,
    endAt: businessWindow(DATE, '08:00', '14:00').endAt,
  });
  assert.equal(confirmed.length, 2);
});

test('CASE 9: zero-length window (start === end) -> VALIDATION_ERROR', (t) => {
  const { db, scenario, cleanup } = openScenario('case9-zero-length');
  t.after(cleanup);

  const at09 = businessWindow(DATE, '09:00', '09:00');
  const result = book(db, scenario, scenario.roomSpace.id, at09);
  assert.equal(result.ok, false, 'a zero-length booking must be rejected');
  assert.equal(result.code, 'VALIDATION_ERROR', `observed ${result.code}: ${result.message}`);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM reservation', ), 0);
  assert.equal(countRows(db, 'SELECT COUNT(*) AS c FROM occupancy'), 0);
});

test('CASE 10a: buffer_minutes = 30 -> 11:00 start after an 11:00 end is rejected, 11:30 is accepted', (t) => {
  const { db, scenario, cleanup } = openScenario('case10-buffer');
  t.after(cleanup);

  const spaceId = scenario.bufferedRoom.id;
  const first = book(db, scenario, spaceId, businessWindow(DATE, '09:00', '11:00'));
  assert.equal(first.ok, true, `setup booking failed: ${first.code} ${first.message}`);

  const noGap = book(db, scenario, spaceId, businessWindow(DATE, '11:00', '12:00'));
  assert.equal(noGap.ok, false, 'a back-to-back booking must be rejected when buffer_minutes = 30');
  assert.equal(noGap.code, 'DOUBLE_BOOKING_CONFLICT', `observed ${noGap.code}: ${noGap.message}`);

  const exactGap = book(db, scenario, spaceId, businessWindow(DATE, '11:30', '12:30'));
  assert.equal(exactGap.ok, true, `a booking exactly one buffer (30 min) away must be accepted: ${exactGap.code} ${exactGap.message}`);

  assert.equal(
    countRows(
      db,
      "SELECT COUNT(*) AS c FROM occupancy WHERE resource_unit_id = ? AND status = 'ACTIVE'",
      scenario.bufferedRoom.units[0].id,
    ),
    2,
  );
});

test('CASE 10b: maintenance occupancy ignores the buffer (allowed adjacent to a booking end)', (t) => {
  const { db, scenario, cleanup } = openScenario('case10b-maintenance-buffer');
  t.after(cleanup);

  const spaceId = scenario.bufferedRoom.id;
  const unitId = scenario.bufferedRoom.units[0].id;
  const booked = book(db, scenario, spaceId, businessWindow(DATE, '09:00', '11:00'));
  assert.equal(booked.ok, true, `setup booking failed: ${booked.code} ${booked.message}`);

  // Raw maintenance occupancy, exactly adjacent to the booking end. The trigger
  // compares maintenance exactly (no buffer), so this must be permitted.
  const maintenance = businessWindow(DATE, '11:00', '11:30');
  const inserted = attempt(() => db.prepare(`
    INSERT INTO occupancy (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, maintenance_block_id, created_at)
    VALUES (?,?,?,?, 'ACTIVE', 'MAINTENANCE', NULL, NULL, ?)
  `).run(unitId, spaceId, maintenance.startAt, maintenance.endAt, Date.now()));
  assert.equal(
    inserted.ok,
    true,
    `maintenance adjacent to a booking end must be allowed despite buffer_minutes=30: ${inserted.code} ${inserted.message}`,
  );

  // ...and a booking that would now collide with that maintenance is rejected.
  const colliding = book(db, scenario, spaceId, businessWindow(DATE, '11:00', '12:00'));
  assert.equal(colliding.ok, false, 'a booking over the maintenance slot must be rejected');
  assert.equal(colliding.code, 'DOUBLE_BOOKING_CONFLICT');
});

test('CASE 10c: createMaintenanceBlock (service path) blocks bookings and releases cleanly', (t) => {
  const { db, scenario, cleanup } = openScenario('case10c-maintenance-service');
  t.after(cleanup);

  // Regression guard: on the first run of this suite this path threw
  //   ERR_SQLITE_ERROR "column index out of range"
  // (the occupancy INSERT declared 9 columns but bound 8 values to 7
  // placeholders). It works now; this test keeps it working.
  const maintenance = businessWindow(DATE, '13:00', '14:00');
  const created = attempt(() => createMaintenanceBlock(db, {
    actor: scenario.actor,
    spaceId: scenario.roomSpace.id,
    startAt: maintenance.startAt,
    endAt: maintenance.endAt,
    reason: 'Projector service',
  }));
  assert.equal(created.ok, true, `createMaintenanceBlock must create a block, but it threw ${created.code}: ${created.message}`);

  const rows = db.prepare('SELECT * FROM occupancy WHERE maintenance_block_id = ?')
    .all(created.result.maintenanceBlockId);
  assert.equal(rows.length, 1, 'one occupancy row per blocked resource unit');
  assert.equal(rows[0].status, 'ACTIVE');
  assert.equal(rows[0].source, 'MAINTENANCE');
  assert.equal(rows[0].reservation_id, null);

  const overMaintenance = businessWindow(DATE, '13:30', '14:30');
  const blocked = book(db, scenario, scenario.roomSpace.id, overMaintenance);
  assert.equal(blocked.ok, false, 'a booking over a maintenance block must be rejected');
  assert.equal(blocked.code, 'DOUBLE_BOOKING_CONFLICT', `observed ${blocked.code}: ${blocked.message}`);
  assert.ok(
    blocked.conflicts.some((conflict) => conflict.maintenanceBlockId === created.result.maintenanceBlockId),
    'the rejection must name the maintenance block',
  );

  const released = cancelMaintenanceBlock(db, {
    actor: scenario.actor, maintenanceBlockId: created.result.maintenanceBlockId, reason: 'Works postponed',
  });
  assert.equal(released.releasedOccupancyRows, 1);

  const afterRelease = book(db, scenario, scenario.roomSpace.id, overMaintenance);
  assert.equal(afterRelease.ok, true, `the slot must be bookable after cancelling maintenance: ${afterRelease.code} ${afterRelease.message}`);
});

test('CASE 11a: cross-midnight interval - an overlap on the second local day is rejected', (t) => {
  const { db, scenario, cleanup } = openScenario('case11a-midnight', { deskOpenTime: '00:00', deskCloseTime: '23:59' });
  t.after(cleanup);

  // Two-local-day maintenance occupancy [22:00 -> 12:00 next day), inserted
  // directly: the maintenance SERVICE path is a separate test (CASE 10c) and
  // multi-day BOOKINGS go through the rules layer (CASE 11c below), so a
  // direct insert is the only way to obtain a real cross-midnight interval
  // independent of the rules layer.
  const block = {
    startAt: businessWindow(DATE, '22:00', '23:59').startAt,
    endAt: businessWindow(NEXT_DATE, '00:00', '12:00').endAt,
  };
  const insert = db.prepare(`
    INSERT INTO occupancy (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, maintenance_block_id, created_at)
    VALUES (?,?,?,?, 'ACTIVE', 'MAINTENANCE', NULL, NULL, ?)
  `);
  for (const unit of scenario.deskSpace.units) {
    insert.run(unit.id, scenario.deskSpace.id, block.startAt, block.endAt, Date.now());
  }

  // A day-2 window inside opening hours that falls on the maintenance tail.
  const overlapping = book(db, scenario, scenario.deskSpace.id, businessWindow(NEXT_DATE, '09:00', '11:00'));
  assert.equal(overlapping.ok, false, 'a booking on the second day must collide with the cross-midnight block');
  assert.equal(overlapping.code, 'DOUBLE_BOOKING_CONFLICT', `observed ${overlapping.code}: ${overlapping.message}`);
  assert.ok(overlapping.conflicts.length > 0, 'the rejection must name the blocking interval');
  assert.equal(overlapping.conflicts[0].startAt, block.startAt);
  assert.equal(overlapping.conflicts[0].endAt, block.endAt);
  assert.equal(overlapping.conflicts[0].source, 'MAINTENANCE');

  // Same day, after the block ends: must be free (half-open, no over-blocking).
  const after = book(db, scenario, scenario.deskSpace.id, businessWindow(NEXT_DATE, '12:00', '13:00'));
  assert.equal(after.ok, true, `12:00 is exactly the block end and must be free: ${after.code} ${after.message}`);

  assert.equal(activeOccupancyRows(db, after.result.reservation.id).length, 1);
  assert.equal(clockLabel(block.endAt, NEXT_DATE), '12:00');
});

test('CASE 11b (extra): a booking and 3 maintenance blocks race for the same window -> exactly 1 wins', async (t) => {
  const { db, dbPath, scenario, cleanup } = openScenario('case11b-booking-vs-maintenance');
  t.after(cleanup);

  const window = businessWindow(DATE, '11:00', '12:00');
  const results = await runWorkers({
    workerScript: BOOKING_WORKER,
    dbPath,
    count: 4,
    action: (index) => (index === 0 ? 'createReservation' : 'createMaintenanceBlock'),
    payload: (index) => (index === 0
      ? {
        actor: scenario.actor,
        spaceId: scenario.roomSpace.id,
        customerId: scenario.customer.id,
        startAt: window.startAt,
        endAt: window.endAt,
        unitCount: 1,
        purpose: 'booking versus maintenance',
      }
      : {
        actor: scenario.actor,
        spaceId: scenario.roomSpace.id,
        startAt: window.startAt,
        endAt: window.endAt,
        reason: `maintenance attempt ${index}`,
      }),
  });

  const context = describeResults(results);
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1, `exactly one of the four must win\n${context}`);
  for (const loser of results.filter((result) => !result.ok)) {
    assert.equal(loser.code, 'DOUBLE_BOOKING_CONFLICT', `loser #${loser.index}\n${context}`);
  }

  // Whatever won, there is exactly ONE claim on the room in that window...
  assert.equal(
    countRows(
      db,
      "SELECT COUNT(*) AS c FROM occupancy WHERE resource_unit_id = ? AND status = 'ACTIVE' AND start_at < ? AND end_at > ?",
      scenario.roomSpace.units[0].id, window.endAt, window.startAt,
    ),
    1,
  );
  // ...the losing maintenance attempts left no maintenance_block row behind...
  assert.equal(
    countRows(db, "SELECT COUNT(*) AS c FROM maintenance_block WHERE start_at = ? AND end_at = ?", window.startAt, window.endAt),
    winners[0].job.action === 'createMaintenanceBlock' ? 1 : 0,
  );
  // ...and the room holds exactly one reservation row at most (zero if maintenance won).
  assert.equal(
    countRows(db, 'SELECT COUNT(*) AS c FROM reservation WHERE space_id = ?', scenario.roomSpace.id),
    winners[0].job.action === 'createReservation' ? 1 : 0,
  );
  console.log(`CASE 11b winner: ${winners[0].job.action} (worker #${winners[0].index})`);
});

test('CASE 11c (regression guard, reported as DEFECT-2): a multi-day booking crossing local midnight is accepted', (t) => {
  const { db, scenario, cleanup } = openScenario('case11c-multi-day', { deskOpenTime: '00:00', deskCloseTime: '23:59' });
  t.after(cleanup);

  // A 24-hour co-working space (open 00:00, close 23:59) with a two-day rental
  // that crosses local midnight. Both calendar days are fully inside opening
  // hours, so this must be bookable; ARCHITECTURE.md §4 and the comment on
  // checkBookingRules ("Handles multi-day desk rentals too") both require it.
  //
  // HISTORY: this test FAILED when originally written (reported as DEFECT-2).
  // Root cause at the time (availabilityService.js, checkBookingRules loop):
  //   const dayClose = businessLocalToEpoch(businessDateKey(cursor), space.close_time);
  //   ...
  //   cursor = dayClose;          // <- always inside the SAME local day
  // so the second iteration recomputed the same dateKey, the segment became
  // empty (segmentStart === segmentEnd) and the loop pushed
  // "Requested time <close_time> falls outside opening hours on <day 1>".
  // Any window ending after the start day's close_time was therefore refused,
  // whatever the later days' opening hours were. The rules layer has since
  // been fixed (the cursor now advances by calendar day); this test stays on
  // as a regression guard for that fix.
  const multiDay = {
    startAt: businessWindow(DATE, '22:00', '23:59').startAt,
    endAt: businessWindow(NEXT_DATE, '00:00', '02:00').endAt,
  };
  const result = book(db, scenario, scenario.deskSpace.id, multiDay);

  assert.equal(
    result.ok,
    true,
    `a 4-hour rental spanning midnight on a 24h space must be bookable, but it was rejected with ${result.code}: ${result.message}`,
  );
});

test('CASE 11d (regression guard, reported as DEFECT-3): a booking that starts before opening hours is refused', (t) => {
  const { db, scenario, cleanup } = openScenario('case11d-before-opening');
  t.after(cleanup);

  // The seeded room opens 08:00 and closes 18:00. The window below spills two
  // hours outside opening hours and must be refused.
  //
  // HISTORY: this test FAILED when originally written (reported as DEFECT-3).
  // The same checkBookingRules loop's "segment sits inside opening hours -
  // fine" branch accepted it because the INTERSECTION with [dayOpen, dayClose)
  // was non-empty. The rules layer has since been fixed (a cursor < dayOpen
  // check now emits outsideOpeningHours); this test stays on as a regression
  // guard for that fix.
  const beforeOpening = businessWindow(DATE, '06:00', '10:00');
  const result = book(db, scenario, scenario.roomSpace.id, beforeOpening);

  assert.equal(
    result.ok,
    false,
    `a 06:00 booking on an 08:00-18:00 space must be refused, but it was confirmed as ${result.result?.reservation?.reference}`,
  );
  assert.equal(result.code, 'VALIDATION_ERROR', `expected VALIDATION_ERROR, got ${result.code}: ${result.message}`);
});
