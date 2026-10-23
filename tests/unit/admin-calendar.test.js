import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, closeTestDb } from '../helpers/testDb.js';
import { seedScenario } from '../helpers/concurrencyHelpers.js';
import { createReservation } from '../../src/server/services/bookingService.js';
import {
  approveBookingRequest, createBookingRequest, updateBookingFeePolicy,
} from '../../src/server/services/bookingRequestService.js';
import { loadCalendarData, calendarEvents } from '../../src/server/services/calendarService.js';
import { parseCalendarFilters } from '../../src/server/routes/adminBookingRoutes.js';
import { layoutDayEvents, renderCalendarPage, renderCalendarWeekPage } from '../../src/web/views/admin/calendarViews.js';
import { businessLocalToEpoch } from '../../src/server/domain/time.js';

function futureKey(days) {
  return new Date(Date.now() + days * 86400000 + 330 * 60000).toISOString().slice(0, 10);
}

test('the admin calendar feed combines reservations, maintenance holds and pending requests', () => {
  const db = createTestDb();
  try {
    const scenario = seedScenario(db);
    db.prepare("UPDATE space SET status='PUBLISHED'").run();
    const dateKey = futureKey(6);
    const fromAt = businessLocalToEpoch(dateKey, '00:00');
    const toAt = businessLocalToEpoch(dateKey, '23:59');

    const reservation = createReservation(db, {
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt: businessLocalToEpoch(dateKey, '10:00'),
      endAt: businessLocalToEpoch(dateKey, '11:00'),
      unitCount: 1,
      attendees: 4,
      purpose: 'Calendar feed test',
      source: 'admin',
    }).reservation;

    const request = createBookingRequest(db, {
      spaceId: scenario.auditorium.id,
      startAt: businessLocalToEpoch(dateKey, '14:00'),
      endAt: businessLocalToEpoch(dateKey, '15:00'),
      unitCount: 1,
      customer: { fullName: 'Request Person', email: 'request@example.test' },
      purpose: 'Pending request',
      now: Date.now(),
    }).request;
    assert.equal(request.status, 'REQUESTED');

    const data = loadCalendarData(db, { fromAt, toAt });
    assert.ok(data.reservations.some((row) => row.reference === reservation.reference));
    assert.ok(data.requests.some((row) => row.reference === request.reference));
    const events = calendarEvents(data);
    assert.ok(events.some((event) => event.kind === 'RESERVATION'));
    assert.ok(events.some((event) => event.kind === 'REQUEST'));

    const day = String(renderCalendarPage({
      actor: { ...scenario.actor, role: 'SUPER_ADMIN' },
      csrfToken: 'csrf',
      filters: { date: dateKey, view: 'day' },
      spaces: db.prepare('SELECT * FROM space').all(),
      data,
      events,
      today: dateKey,
    }));
    assert.match(day, /data-ac-create-dialog/);
    assert.match(day, /\/assets\/admin-calendar\.js/);
    assert.match(day, new RegExp(reservation.reference));
    assert.match(day, /class="ac-board-card"/);
  } finally {
    closeTestDb(db);
  }
});

test('an approved request becomes a payment hold event and lane layout never overlaps', () => {
  const db = createTestDb();
  try {
    const scenario = seedScenario(db);
    db.prepare("UPDATE space SET status='PUBLISHED'").run();
    updateBookingFeePolicy(db, {
      actor: scenario.actor, mode: 'FIXED', fixedCents: 50000, now: Date.now(),
    });
    const dateKey = futureKey(7);
    const request = createBookingRequest(db, {
      spaceId: scenario.roomSpace.id,
      startAt: businessLocalToEpoch(dateKey, '10:00'),
      endAt: businessLocalToEpoch(dateKey, '11:00'),
      unitCount: 1,
      customer: { fullName: 'Hold Person', email: 'hold@example.test' },
      now: Date.now(),
    }).request;
    const requestRow = db.prepare('SELECT id FROM booking_request WHERE reference = ?').get(request.reference);
    const approved = approveBookingRequest(db, {
      actor: { ...scenario.actor, role: 'SUPER_ADMIN' }, requestId: requestRow.id, now: Date.now(),
    });
    assert.equal(approved.status, 'APPROVED_AWAITING_PAYMENT');

    const data = loadCalendarData(db, {
      fromAt: businessLocalToEpoch(dateKey, '00:00'),
      toAt: businessLocalToEpoch(dateKey, '23:59'),
    });
    assert.equal(data.holds.length, 1);
    assert.equal(data.holds[0].reference, request.reference);

    const segments = layoutDayEvents([
      { id: 'a', startAt: businessLocalToEpoch(dateKey, '10:00'), endAt: businessLocalToEpoch(dateKey, '12:00') },
      { id: 'b', startAt: businessLocalToEpoch(dateKey, '11:00'), endAt: businessLocalToEpoch(dateKey, '13:00') },
    ], {
      dayStart: businessLocalToEpoch(dateKey, '00:00'),
      dayEnd: businessLocalToEpoch(dateKey, '23:59'),
    });
    assert.equal(segments.length, 2);
    assert.notEqual(segments[0].lane, segments[1].lane);
    assert.ok(segments.every((segment) => segment.laneCount >= 2));
  } finally {
    closeTestDb(db);
  }
});

test('the calendar defaults to week and an explicit empty space filter returns no events', () => {
  const db = createTestDb();
  try {
    const scenario = seedScenario(db);
    const dateKey = futureKey(8);
    createReservation(db, {
      actor: scenario.actor,
      spaceId: scenario.roomSpace.id,
      customerId: scenario.customer.id,
      startAt: businessLocalToEpoch(dateKey, '10:00'),
      endAt: businessLocalToEpoch(dateKey, '11:00'),
      unitCount: 1,
      attendees: 2,
      purpose: 'Filter regression test',
      source: 'admin',
    });
    assert.equal(parseCalendarFilters({ date: dateKey }).view, 'week');
    const data = loadCalendarData(db, {
      fromAt: businessLocalToEpoch(dateKey, '00:00'),
      toAt: businessLocalToEpoch(dateKey, '23:59'),
      spaceIds: [],
    });
    assert.deepEqual(calendarEvents(data), []);
  } finally {
    closeTestDb(db);
  }
});
