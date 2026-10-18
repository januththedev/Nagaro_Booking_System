/**
 * Dashboard integration tests.
 *
 * Runs against a real file-backed SQLite database (withTempFileDb), seeds it
 * exclusively through the real services (spaceService, customerService,
 * bookingService), and then checks every dashboard number against an
 * independent hand-written SQL query - never against the service's own logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import {
  createTestActor, withTempFileDb,
} from '../helpers/testDb.js';
import {
  dashboardSummary, todaysReservations, upcomingReservations, currentOccupancy,
  recentChanges, recentInquiries, spaceUtilisation, bookingFilterOptions,
} from '../../src/server/services/dashboardService.js';
import { listAudit } from '../../src/server/services/auditService.js';
import {
  createSpace, addImageRecord, publishSpace, archiveSpace,
} from '../../src/server/services/spaceService.js';
import { createCustomer } from '../../src/server/services/customerService.js';
import {
  createReservation, cancelReservation, createMaintenanceBlock,
} from '../../src/server/services/bookingService.js';
import { MS, businessLocalToEpoch } from '../../src/server/domain/time.js';

const DATE = '2026-11-10';   // day N (EAT)
const NEXT = '2026-11-11';   // day N+1
const LATER = '2026-11-20';  // day N+10
const HOUR = MS.HOUR;

/** First column of a single-row query. */
const scalar = (db, sql, ...params) => Number(Object.values(db.prepare(sql).get(...params))[0] ?? 0);

test('dashboard summary, lists and utilisation all match independent SQL counts', async () => {
  await withTempFileDb(async (db, path) => {
    assert.ok(existsSync(path), 'the test database is a real file on disk');

    /* ----------------------------------------------------------- fixture */
    const actor = createTestActor(db, { email: 'dash-admin@test.local', name: 'Dash Admin' });
    const photo = (name) => ({
      actor,
      storedName: `${name.repeat(32).slice(0, 32).replace(/[^a-f0-9]/g, 'a')}.jpg`,
      originalName: `${name}.jpg`,
      mimeType: 'image/jpeg',
      byteSize: 2048,
    });

    const room = createSpace(db, {
      actor,
      payload: {
        code: 'TRC-MR-01',
        name: 'Kaldi Room',
        category: 'MEETING_ROOM',
        short_description: 'A tidy meeting room',
        description: 'A tidy meeting room with a projector for up to twelve people.',
        location: 'Trace Expert City, Block A',
        capacity: 12,
        pricing_unit: 'HOUR',
        open_time: '08:00',
        close_time: '18:00',
        rates: [{ unit: 'HOUR', amount_cents: 150000 }],
      },
    });
    addImageRecord(db, { spaceId: room.id, ...photo('room') });
    publishSpace(db, { actor, spaceId: room.id });

    const coworking = createSpace(db, {
      actor,
      payload: {
        code: 'TRC-CW-01',
        name: 'Coworking Floor',
        category: 'COWORKING',
        short_description: 'Open desks',
        description: 'Open co-working floor with four independent desks available by the day.',
        location: 'Trace Expert City, Block B',
        capacity: 20,
        desk_count: 4,
        pricing_unit: 'DAY',
        open_time: '08:00',
        close_time: '18:00',
        rates: [{ unit: 'DAY', amount_cents: 45000 }],
      },
    });
    addImageRecord(db, { spaceId: coworking.id, ...photo('desk') });
    publishSpace(db, { actor, spaceId: coworking.id });

    // Archived third space: must not contribute to any dashboard number.
    const archived = createSpace(db, {
      actor,
      payload: {
        code: 'TRC-MR-02',
        name: 'Old Room',
        category: 'MEETING_ROOM',
        short_description: 'Retired room',
        description: 'A retired meeting room kept only for historical reference.',
        location: 'Trace Expert City, Block C',
        capacity: 8,
        pricing_unit: 'HOUR',
        rates: [{ unit: 'HOUR', amount_cents: 100000 }],
      },
    });
    archiveSpace(db, { actor, spaceId: archived.id, reason: 'no longer offered' });

    const hanna = createCustomer(db, {
      actor,
      payload: { full_name: 'Hanna Bekele', email: 'hanna@example.com', organization: 'Acme' },
    });
    const dawit = createCustomer(db, {
      actor,
      payload: { full_name: 'Dawit Tesfaye', email: 'dawit@example.com' },
    });

    const desks = db.prepare(
      'SELECT id, code FROM resource_unit WHERE space_id = ? AND is_active = 1 ORDER BY code',
    ).all(coworking.id);

    const now = businessLocalToEpoch(DATE, '15:30');
    const mk = (spaceId, customerId, dateKey, from, to, extra = {}) => createReservation(db, {
      actor,
      spaceId,
      customerId,
      startAt: businessLocalToEpoch(dateKey, from),
      endAt: businessLocalToEpoch(dateKey, to),
      ...extra,
    }).reservation;

    const r1 = mk(room.id, hanna.id, DATE, '09:00', '11:00', { attendees: 6, purpose: 'Planning' });
    const r2 = mk(coworking.id, hanna.id, DATE, '10:00', '12:00', { unitCount: 2, attendees: 2 });
    const r3 = mk(coworking.id, dawit.id, DATE, '14:00', '15:00', { unitCount: 1 });
    cancelReservation(db, { actor, reservationId: r3.id, reason: 'Client rescheduled' });
    const r4 = mk(room.id, dawit.id, NEXT, '09:00', '10:00');
    const r5 = mk(room.id, dawit.id, LATER, '09:00', '10:00');

    const maintenance = createMaintenanceBlock(db, {
      actor, spaceId: coworking.id, resourceUnitIds: [desks[0].id],
      startAt: businessLocalToEpoch(DATE, '15:00'),
      endAt: businessLocalToEpoch(DATE, '16:00'),
      reason: 'Desk repair',
    });
    const maintenanceUpcoming = createMaintenanceBlock(db, {
      actor, spaceId: coworking.id, resourceUnitIds: [desks[2].id, desks[3].id],
      startAt: businessLocalToEpoch(DATE, '16:00'),
      endAt: businessLocalToEpoch(DATE, '17:00'),
      reason: 'Carpet cleaning',
    });

    // Inquiries are inserted directly: no inquiry service is in scope here.
    const inqStmt = db.prepare(`
      INSERT INTO inquiry
        (reference, space_id, customer_name, email, email_normalized, organization,
         requested_start_at, requested_end_at, attendees, desk_quantity, message,
         status, email_status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const base = now;
    inqStmt.run('INQ-TEST-01', null, 'Sara K', 'sara@example.com', 'sara@example.com', null,
      businessLocalToEpoch(NEXT, '09:00'), businessLocalToEpoch(NEXT, '11:00'), 4, null, 'Hello',
      'NEW', 'NOT_CONFIGURED', base + 100, base + 100);
    inqStmt.run('INQ-TEST-02', null, 'Tom A', 'tom@example.com', 'tom@example.com', 'NGO',
      businessLocalToEpoch(NEXT, '13:00'), businessLocalToEpoch(NEXT, '15:00'), null, 3, 'Desks?',
      'CONTACTED', 'FAILED', base + 200, base + 200);
    inqStmt.run('INQ-TEST-03', null, 'Liya M', 'liya@example.com', 'liya@example.com', null,
      businessLocalToEpoch(LATER, '09:00'), businessLocalToEpoch(LATER, '12:00'), 10, null, null,
      'CLOSED', 'FAILED', base + 300, base + 300);
    inqStmt.run('INQ-TEST-04', null, 'Rob G', 'rob@example.com', 'rob@example.com', null,
      businessLocalToEpoch(LATER, '10:00'), businessLocalToEpoch(LATER, '11:00'), null, null, null,
      'WITHDRAWN', 'NOT_CONFIGURED', base + 400, base + 400);
    inqStmt.run('INQ-TEST-05', room.id, 'Mimi T', 'mimi@example.com', 'mimi@example.com', 'Studio',
      businessLocalToEpoch(LATER, '14:00'), businessLocalToEpoch(LATER, '16:00'), 3, null, 'Thanks',
      'CONVERTED', 'SENT', base + 500, base + 500);

    /* -------------------------------------------------- summary counters */
    const summary = dashboardSummary(db, { now });
    assert.deepEqual(
      Object.keys(summary).sort(),
      ['activeSpaces', 'availableNow', 'businessDate', 'generatedAt', 'inquiries',
        'maintenance', 'occupancy', 'recentChanges', 'recentInquiries', 'today', 'upcoming'].sort(),
    );
    assert.equal(summary.generatedAt, now);
    assert.equal(summary.businessDate, DATE);

    /* activeSpaces: raw GROUP BY status */
    const rawStatus = Object.fromEntries(
      db.prepare('SELECT status, COUNT(*) AS c FROM space GROUP BY status').all()
        .map((row) => [row.status, Number(row.c)]),
    );
    assert.equal(summary.activeSpaces.archived, rawStatus.ARCHIVED ?? 0);
    assert.equal(summary.activeSpaces.published, rawStatus.PUBLISHED ?? 0);
    assert.equal(summary.activeSpaces.draft, rawStatus.DRAFT ?? 0);
    assert.equal(summary.activeSpaces.total, (rawStatus.PUBLISHED ?? 0) + (rawStatus.DRAFT ?? 0));
    assert.equal(summary.activeSpaces.total, 2);
    assert.equal(summary.activeSpaces.archived, 1);

    /* availableNow: [now, now + 60min), half-open */
    const windowStart = now;
    const windowEnd = now + HOUR;
    const rawTotalUnits = scalar(db, `
      SELECT COUNT(*) FROM resource_unit u JOIN space s ON s.id = u.space_id
       WHERE u.is_active = 1 AND s.status <> 'ARCHIVED'
    `);
    const rawOccupiedUnits = scalar(db, `
      SELECT COUNT(DISTINCT o.resource_unit_id)
        FROM occupancy o
        JOIN resource_unit u ON u.id = o.resource_unit_id AND u.is_active = 1
        JOIN space s ON s.id = o.space_id AND s.status <> 'ARCHIVED'
       WHERE o.status = 'ACTIVE' AND o.start_at < ? AND o.end_at > ?
    `, windowEnd, windowStart);
    assert.equal(rawTotalUnits, 5);
    assert.equal(rawOccupiedUnits, 3);
    assert.deepEqual(
      { total: summary.availableNow.total, free: summary.availableNow.free, occupied: summary.availableNow.occupied },
      { total: rawTotalUnits, free: rawTotalUnits - rawOccupiedUnits, occupied: rawOccupiedUnits },
    );

    const cwRow = summary.availableNow.spaces.find((s) => s.spaceId === coworking.id);
    const roomRow = summary.availableNow.spaces.find((s) => s.spaceId === room.id);
    assert.equal(summary.availableNow.spaces.length, 2, 'archived spaces are excluded');
    assert.deepEqual(
      { totalUnits: cwRow.totalUnits, freeUnits: cwRow.freeUnits, occupiedUnits: cwRow.occupiedUnits },
      { totalUnits: 4, freeUnits: 1, occupiedUnits: 3 },
    );
    assert.deepEqual(
      { totalUnits: roomRow.totalUnits, freeUnits: roomRow.freeUnits, occupiedUnits: roomRow.occupiedUnits },
      { totalUnits: 1, freeUnits: 1, occupiedUnits: 0 },
    );
    assert.equal(cwRow.status, 'PUBLISHED');
    assert.equal(cwRow.category, 'COWORKING');

    /* today: business-local day boundaries */
    const dayStart = businessLocalToEpoch(DATE, '00:00');
    const dayEnd = businessLocalToEpoch(NEXT, '00:00');
    const todaySql = `
      SELECT COUNT(*) FROM reservation r JOIN space s ON s.id = r.space_id
       WHERE r.start_at < ? AND r.end_at > ?
    `;
    const rawBookings = scalar(db, `
      SELECT COUNT(*) FROM reservation
       WHERE status <> 'CANCELLED' AND start_at < ? AND end_at > ?
    `, dayEnd, dayStart);
    const rawAttendees = scalar(db, `
      SELECT COALESCE(SUM(attendees), 0) FROM reservation
       WHERE status <> 'CANCELLED' AND start_at < ? AND end_at > ?
    `, dayEnd, dayStart);
    const rawDeskDays = scalar(db, `
      SELECT COALESCE(SUM(r.unit_count), 0)
        FROM reservation r JOIN space s ON s.id = r.space_id
       WHERE r.status <> 'CANCELLED' AND s.category = 'COWORKING'
         AND r.start_at < ? AND r.end_at > ?
    `, dayEnd, dayStart);
    const rawConfirmed = scalar(db, `
      SELECT COUNT(*) FROM reservation
       WHERE status = 'CONFIRMED' AND start_at < ? AND end_at > ?
    `, dayEnd, dayStart);
    const rawCancelled = scalar(db, `
      SELECT COUNT(*) FROM reservation
       WHERE status = 'CANCELLED' AND start_at < ? AND end_at > ?
    `, dayEnd, dayStart);
    assert.equal(scalar(db, todaySql, dayEnd, dayStart), 3, 'three reservations touch today');
    assert.equal(rawBookings, 2);
    assert.equal(rawCancelled, 1); // r3
    assert.deepEqual(summary.today, {
      bookings: rawBookings,
      attendees: rawAttendees,
      deskDays: rawDeskDays,
      cancelled: rawCancelled,
      confirmed: rawConfirmed,
    });
    assert.equal(summary.today.attendees, 8);   // 6 + 2
    assert.equal(summary.today.deskDays, 2);    // only the live 2-desk booking
    assert.equal(summary.today.confirmed, 2);

    // the cancelled reservation is excluded from today.confirmed and included in today.cancelled
    const cancelledRef = r3.reference;
    assert.equal(scalar(db, `
      SELECT COUNT(*) FROM reservation
       WHERE reference = ? AND status = 'CANCELLED' AND start_at < ? AND end_at > ?
    `, cancelledRef, dayEnd, dayStart), 1);
    assert.equal(scalar(db, `
      SELECT COUNT(*) FROM reservation WHERE reference = ? AND status = 'CONFIRMED'
    `, cancelledRef), 0);
    assert.equal(summary.today.cancelled, 1, 'exactly the cancelled reservation');
    assert.equal(summary.today.bookings, summary.today.confirmed, 'no completed leftovers polluting today');

    /* upcoming: CONFIRMED reservations starting in the next 7 / 30 days */
    const raw7 = scalar(db, `
      SELECT COUNT(*) FROM reservation
       WHERE status = 'CONFIRMED' AND start_at >= ? AND start_at < ?
    `, now, now + 7 * MS.DAY);
    const raw30 = scalar(db, `
      SELECT COUNT(*) FROM reservation
       WHERE status = 'CONFIRMED' AND start_at >= ? AND start_at < ?
    `, now, now + 30 * MS.DAY);
    assert.equal(raw7, 1);
    assert.equal(raw30, 2);
    assert.deepEqual(summary.upcoming, { next7Days: raw7, next30Days: raw30 });

    /* occupancy: current rate over the next hour */
    assert.equal(summary.occupancy.currentRate, Math.round((rawOccupiedUnits / rawTotalUnits) * 1000) / 1000);
    assert.equal(summary.occupancy.currentRate, 0.6);

    // peak hourly rate, recomputed with a hand-written SQL loop over 24 hours
    let peak = null;
    for (let hour = 0; hour < 24; hour += 1) {
      const start = dayStart + hour * HOUR;
      const end = start + HOUR;
      const occupied = scalar(db, `
        SELECT COUNT(DISTINCT o.resource_unit_id)
          FROM occupancy o
          JOIN resource_unit u ON u.id = o.resource_unit_id AND u.is_active = 1
          JOIN space s ON s.id = o.space_id AND s.status <> 'ARCHIVED'
         WHERE o.status = 'ACTIVE' AND o.start_at < ? AND o.end_at > ?
      `, end, start);
      const rate = Math.round((occupied / rawTotalUnits) * 1000) / 1000;
      peak = peak === null ? rate : Math.max(peak, rate);
    }
    assert.equal(summary.occupancy.todayPeakRate, peak);
    assert.equal(summary.occupancy.todayPeakRate, 0.6, 'the 10:00 business hour is the busiest');

    /* inquiries */
    const rawInquiryTotal = scalar(db, 'SELECT COUNT(*) FROM inquiry');
    const rawInquiryNew = scalar(db, "SELECT COUNT(*) FROM inquiry WHERE status = 'NEW'");
    const rawAwaiting = scalar(db, `
      SELECT COUNT(*) FROM inquiry
       WHERE email_status IN ('FAILED','NOT_CONFIGURED') AND status NOT IN ('CLOSED','WITHDRAWN')
    `);
    assert.equal(rawInquiryTotal, 5);
    assert.equal(rawInquiryNew, 1);
    assert.equal(rawAwaiting, 2);
    assert.deepEqual(summary.inquiries, {
      new: rawInquiryNew,
      total: rawInquiryTotal,
      awaitingEmailDelivery: rawAwaiting,
    });

    /* maintenance */
    const rawActiveNow = scalar(db, `
      SELECT COUNT(*) FROM maintenance_block
       WHERE status = 'ACTIVE' AND start_at <= ? AND end_at > ?
    `, now, now);
    const rawUpcoming = scalar(db, `
      SELECT COUNT(*) FROM maintenance_block
       WHERE status = 'ACTIVE' AND start_at > ?
    `, now);
    assert.equal(rawActiveNow, 1);
    assert.equal(rawUpcoming, 1);
    assert.deepEqual(summary.maintenance, { activeNow: rawActiveNow, upcoming: rawUpcoming });
    assert.ok(maintenance.maintenanceBlockId && maintenanceUpcoming.maintenanceBlockId);

    /* recent changes mirror the audit log */
    const expectedAudit = listAudit(db, { limit: 12 });
    assert.equal(expectedAudit.length, 12);
    assert.deepEqual(summary.recentChanges.map((e) => e.id), expectedAudit.map((e) => e.id));
    assert.ok(summary.recentChanges.every((e) => e.action && e.summary && typeof e.at === 'number'));

    /* recent inquiries mirror the inquiry table */
    const expectedInquiries = recentInquiries(db, { limit: 8 });
    assert.equal(expectedInquiries.length, 5);
    assert.deepEqual(summary.recentInquiries.map((i) => i.reference), expectedInquiries.map((i) => i.reference));
    assert.equal(expectedInquiries[0].reference, 'INQ-TEST-05', 'newest first');
    assert.deepEqual(
      { status: expectedInquiries[0].status, emailStatus: expectedInquiries[0].emailStatus },
      { status: 'CONVERTED', emailStatus: 'SENT' },
    );
    assert.equal(expectedInquiries[0].spaceCode, 'TRC-MR-01');

    /* ------------------------------------------------ list functions */
    const today = todaysReservations(db, { now });
    assert.deepEqual(today.map((r) => r.reference), [r1.reference, r2.reference, r3.reference]);
    assert.deepEqual(today.map((r) => r.status), ['CONFIRMED', 'CONFIRMED', 'CANCELLED']);
    assert.equal(today[2].cancellationReason, 'Client rescheduled');
    assert.deepEqual(
      Object.keys(today[0]).sort(),
      ['attendees', 'cancellationReason', 'cancelledAt', 'category', 'currency', 'customerId',
        'customerName', 'endAt', 'id', 'purpose', 'reference', 'spaceCode', 'spaceId', 'spaceName',
        'startAt', 'status', 'totalCents', 'unitCount'].sort(),
    );

    const upcoming30 = upcomingReservations(db, { now, limit: 10, days: 30 });
    assert.deepEqual(upcoming30.map((r) => r.reference), [r4.reference, r5.reference]);
    assert.deepEqual(upcomingReservations(db, { now, limit: 10, days: 7 }).map((r) => r.reference), [r4.reference]);
    assert.deepEqual(upcomingReservations(db, { now, limit: 1, days: 30 }).map((r) => r.reference), [r4.reference]);

    const occupancyNow = currentOccupancy(db, { now });
    assert.equal(occupancyNow.totalSpaces, 2, 'archived spaces are excluded');
    assert.equal(occupancyNow.occupiedSpaces, 1); // the co-working floor
    assert.equal(occupancyNow.freeSpaces, 1);     // the room
    assert.equal(occupancyNow.spaces.length, 2);
    const cwNow = occupancyNow.spaces.find((s) => s.spaceId === coworking.id);
    assert.deepEqual(
      { totalUnits: cwNow.totalUnits, occupiedUnits: cwNow.occupiedUnits, freeUnits: cwNow.freeUnits },
      { totalUnits: 4, occupiedUnits: 3, freeUnits: 1 },
    );

    const changes = recentChanges(db, { limit: 5 });
    assert.equal(changes.length, 5);
    assert.equal(changes[0].id, listAudit(db, { limit: 1 })[0].id, 'newest first');
    assert.ok(changes.some((e) => e.action === 'maintenance.created'));

    /* ------------------------------------------------ spaceUtilisation */
    const utilisation = spaceUtilisation(db, { fromAt: dayStart, toAt: dayEnd, limit: 20 });
    assert.deepEqual(utilisation.map((u) => u.code), ['TRC-MR-01', 'TRC-CW-01'], 'room has the higher rate');

    const roomUtil = utilisation[0];
    // Room: one 2h booking over a 10h open day with 1 unit.
    assert.equal(roomUtil.bookedUnitHours, 2);
    assert.equal(roomUtil.bookableUnitHours, 10);
    assert.equal(roomUtil.utilisationRate, 0.2);

    const cwUtil = utilisation[1];
    // Coworking: (2 desks x 2h) + (1 desk x 1h) + (2 desks x 1h) = 7 unit-hours
    // over 4 desks x 10h = 40 bookable unit-hours.
    assert.equal(cwUtil.bookedUnitHours, 7);
    assert.equal(cwUtil.bookableUnitHours, 40);
    assert.equal(cwUtil.utilisationRate, 0.175);

    const rawRoomBooked = scalar(db, `
      SELECT COALESCE(SUM(MAX(0, MIN(end_at, ?) - MAX(start_at, ?))), 0)
        FROM occupancy WHERE status = 'ACTIVE' AND space_id = ? AND start_at < ? AND end_at > ?
    `, dayEnd, dayStart, room.id, dayEnd, dayStart);
    assert.equal(roomUtil.bookedUnitHours, Math.round((rawRoomBooked / HOUR) * 100) / 100);
    assert.ok(utilisation.every((u) => u.code !== 'TRC-MR-02'), 'archived spaces are not ranked');

    /* ------------------------------------------- bookingFilterOptions */
    const options = bookingFilterOptions(db);
    assert.deepEqual(options.spaces.map((s) => s.code), ['TRC-CW-01', 'TRC-MR-01', 'TRC-MR-02']);
    assert.equal(options.spaces.find((s) => s.code === 'TRC-MR-02').status, 'ARCHIVED');
    assert.equal(options.categories.length, 3);
    assert.deepEqual(options.categories.map((c) => c.value).sort(), ['AUDITORIUM', 'COWORKING', 'MEETING_ROOM']);
    assert.deepEqual(options.statuses.map((s) => s.value), ['CONFIRMED', 'CANCELLED', 'COMPLETED']);
    assert.ok(options.categories.every((c) => typeof c.label === 'string' && c.label.length > 0));
    assert.ok(options.statuses.every((s) => typeof s.label === 'string' && s.label.length > 0));
  });
});

test('an empty database reports real zeroes, never invented numbers', async () => {
  await withTempFileDb(async (db) => {
    const now = businessLocalToEpoch(DATE, '12:00');
    const summary = dashboardSummary(db, { now });

    assert.deepEqual(summary.activeSpaces, { total: 0, published: 0, draft: 0, archived: 0 });
    assert.deepEqual(summary.availableNow, { total: 0, free: 0, occupied: 0, spaces: [] });
    assert.deepEqual(summary.today, { bookings: 0, attendees: 0, deskDays: 0, cancelled: 0, confirmed: 0 });
    assert.deepEqual(summary.upcoming, { next7Days: 0, next30Days: 0 });
    assert.deepEqual(summary.occupancy, { currentRate: null, todayPeakRate: null });
    assert.deepEqual(summary.inquiries, { new: 0, total: 0, awaitingEmailDelivery: 0 });
    assert.deepEqual(summary.maintenance, { activeNow: 0, upcoming: 0 });
    assert.deepEqual(summary.recentChanges, []);
    assert.deepEqual(summary.recentInquiries, []);

    assert.deepEqual(todaysReservations(db, { now }), []);
    assert.deepEqual(upcomingReservations(db, { now }), []);
    assert.deepEqual(currentOccupancy(db, { now }), { spaces: [], totalSpaces: 0, occupiedSpaces: 0, freeSpaces: 0 });
    assert.deepEqual(spaceUtilisation(db, {
      fromAt: businessLocalToEpoch(DATE, '00:00'),
      toAt: businessLocalToEpoch(NEXT, '00:00'),
    }), []);
  });
});
