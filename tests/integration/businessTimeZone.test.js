/**
 * End-to-end business-locale test: reservations, maintenance blocks and the
 * availability/grid read models all agree on one business time zone,
 * Asia/Colombo (SLST, fixed UTC+05:30).
 *
 * Runs against a real in-memory SQLite database seeded only through the real
 * services, so nothing here can pass by hard-coding an offset in the test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb, createTestActor, closeTestDb } from '../helpers/testDb.js';
import {
  createSpace, addImageRecord, publishSpace,
} from '../../src/server/services/spaceService.js';
import { createCustomer } from '../../src/server/services/customerService.js';
import { createReservation, createMaintenanceBlock } from '../../src/server/services/bookingService.js';
import {
  checkBookingRules, getPublicAvailability, getSpaceAvailability, getSpaceDayGrid,
} from '../../src/server/services/availabilityService.js';
import { dashboardSummary } from '../../src/server/services/dashboardService.js';
import {
  businessDateKey, businessLocalToEpoch, businessTimeLabel,
} from '../../src/server/domain/time.js';

const DATE = '2026-11-10'; // a Tuesday
const AT = (clock) => businessLocalToEpoch(DATE, clock);

test('reservations, maintenance and availability share Asia/Colombo', () => {
  const db = createTestDb();
  try {
    const actor = createTestActor(db);
    const space = createSpace(db, {
      actor,
      payload: {
        code: 'TRC-MR-01',
        name: 'Baobab Meeting Room',
        category: 'MEETING_ROOM',
        short_description: 'A bright meeting room',
        description: 'A bright meeting room with a projector and whiteboard for twelve people.',
        location: 'Trace Expert City, Block A',
        capacity: 12,
        pricing_unit: 'HOUR',
        open_time: '08:00',
        close_time: '18:00',
        rates: [{ unit: 'HOUR', amount_cents: 150000 }],
      },
    });
    addImageRecord(db, {
      actor,
      spaceId: space.id,
      storedName: 'a'.repeat(32) + '.jpg',
      originalName: 'room.jpg',
      mimeType: 'image/jpeg',
      byteSize: 2048,
    });
    publishSpace(db, { actor, spaceId: space.id });

    const customer = createCustomer(db, {
      actor,
      payload: { full_name: 'Hasini Perera', email: 'hasini@example.com' },
    });

    /* ------------------------------------------------ reservation instants */
    const reservation = createReservation(db, {
      actor,
      spaceId: space.id,
      customerId: customer.id,
      startAt: AT('09:00'),
      endAt: AT('11:00'),
      attendees: 6,
      purpose: 'Sprint review',
    }).reservation;

    // 09:00 SLST is 03:30 UTC; the stored instant is the same number the
    // pure helper produces, not a server-local reinterpretation.
    assert.equal(reservation.startAt, Date.UTC(2026, 10, 10, 3, 30));
    assert.equal(reservation.endAt, Date.UTC(2026, 10, 10, 5, 30));
    assert.equal(businessDateKey(reservation.startAt), DATE);
    assert.equal(businessTimeLabel(reservation.startAt), '09:00');
    assert.equal(businessTimeLabel(reservation.endAt), '11:00');

    /* ------------------------------------------------ availability windows */
    const clash = getSpaceAvailability(db, {
      spaceId: space.id, startAt: AT('10:00'), endAt: AT('11:00'),
    });
    assert.equal(clash.isAvailable, false, 'a window inside the booking is busy');
    assert.equal(clash.conflicts.length, 1);
    assert.equal(businessTimeLabel(clash.conflicts[0].startAt), '09:00');
    assert.equal(businessTimeLabel(clash.conflicts[0].endAt), '11:00');

    const free = getSpaceAvailability(db, {
      spaceId: space.id, startAt: AT('12:00'), endAt: AT('13:00'),
    });
    assert.equal(free.isAvailable, true, 'a window after the booking is free');

    // Adjacency: 11:00-12:00 starts exactly when the booking ends -> no clash.
    const adjacent = getSpaceAvailability(db, {
      spaceId: space.id, startAt: AT('11:00'), endAt: AT('12:00'),
    });
    assert.equal(adjacent.isAvailable, true, 'half-open intervals do not clash at an endpoint');

    /* ------------------------------------------------------- maintenance */
    createMaintenanceBlock(db, {
      actor,
      spaceId: space.id,
      startAt: AT('14:00'),
      endAt: AT('15:00'),
      reason: 'Projector lamp replacement',
    });

    const publicBlocked = getPublicAvailability(db, {
      spaceId: space.id, startAt: AT('14:30'), endAt: AT('14:45'),
    });
    assert.equal(publicBlocked.isAvailable, false);
    assert.equal(publicBlocked.blockedPeriods.length, 1);
    assert.equal(publicBlocked.blockedPeriods[0].kind, 'MAINTENANCE');
    assert.equal(businessTimeLabel(publicBlocked.blockedPeriods[0].startAt), '14:00');
    assert.equal(businessTimeLabel(publicBlocked.blockedPeriods[0].endAt), '15:00');

    /* ------------------------------------------------------------- grid */
    const grid = getSpaceDayGrid(db, { spaceId: space.id, dateKey: DATE });
    assert.equal(grid.dateKey, DATE);
    assert.equal(grid.slots.length, 10, '08:00-18:00 is ten hourly slots');
    assert.equal(businessTimeLabel(grid.slots[0].startAt), '08:00');
    assert.equal(businessDateKey(grid.slots.at(-1).startAt), DATE);
    for (const slot of grid.slots) {
      assert.equal(businessDateKey(slot.startAt), DATE, 'every slot is labelled with the same business day');
    }
    assert.equal(grid.allDayBlocks.length, 2, 'one reservation and one maintenance block');

    /* ------------------------------------------------- dashboard business day */
    const summary = dashboardSummary(db, { now: AT('15:30') });
    assert.equal(summary.businessDate, DATE);
    assert.equal(summary.today.bookings, 1, 'one confirmed reservation today');
    assert.equal(summary.today.confirmed, 1);

    /* -------------------------------------------- opening-hours message text */
    const problems = checkBookingRules(
      db.prepare('SELECT * FROM space WHERE id = ?').get(space.id),
      { startAt: AT('19:00'), endAt: AT('20:00') },
    );
    assert.ok(problems.length > 0, 'a booking after close is refused');
    assert.match(problems[0], /Sri Lanka Standard Time/);
  } finally {
    closeTestDb(db);
  }
});
