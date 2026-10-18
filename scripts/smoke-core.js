/**
 * Core smoke check: migrate, seed minimal data, book, reject overlap.
 * Run: node scripts/smoke-core.js
 */
import { getDb, closeDb } from '../src/server/db/connection.js';
import { applyMigrations } from '../src/server/db/migrate.js';
import { createSpace, getSpace } from '../src/server/services/spaceService.js';
import { createCustomer } from '../src/server/services/customerService.js';
import { createReservation, cancelReservation } from '../src/server/services/bookingService.js';
import { getSpaceAvailability } from '../src/server/services/availabilityService.js';
import { businessLocalToEpoch } from '../src/server/domain/time.js';

const db = getDb();
applyMigrations(db);

db.prepare('DELETE FROM occupancy').run();
db.prepare('DELETE FROM reservation').run();
db.prepare('DELETE FROM space_rate').run();
db.prepare('DELETE FROM space_image').run();
db.prepare('DELETE FROM resource_unit').run();
db.prepare('DELETE FROM space').run();
db.prepare('DELETE FROM customer').run();
db.prepare('DELETE FROM admin_user').run();

const now = Date.now();
const admin = db.prepare(`INSERT INTO admin_user
  (email, password_hash, display_name, role, is_active, created_at, updated_at)
  VALUES (?,?,?,?,1,?,?)`).run('smoke@nagaro.test', 'x', 'Smoke Admin', 'ADMIN', now, now);
const actor = { id: Number(admin.lastInsertRowid), label: 'Smoke Admin (ADMIN)' };

const room = createSpace(db, {
  actor,
  payload: {
    code: 'TRC-MR-01',
    name: 'Trace Meeting Room 1',
    category: 'MEETING_ROOM',
    short_description: 'A tidy meeting room',
    description: 'A tidy meeting room with a projector and whiteboard for up to 12 people.',
    location: 'Trace Expert City, Block A',
    capacity: 12,
    pricing_unit: 'HOUR',
    min_duration_minutes: 30,
    buffer_minutes: 0,
    open_time: '08:00',
    close_time: '18:00',
    amenities: ['Projector', 'Whiteboard'],
    rates: [{ unit: 'HOUR', amount_cents: 150000 }, { unit: 'DAY', amount_cents: 900000 }],
  },
});
console.log('space:', room.code, 'units:', room.unitCount, 'rates:', JSON.stringify(room.rates));

const deskSpace = createSpace(db, {
  actor,
  payload: {
    code: 'TRC-CW-01',
    name: 'Coworking Floor',
    category: 'COWORKING',
    short_description: 'Open desks',
    description: 'Open co-working floor with twenty independent desks available by the day.',
    location: 'Trace Expert City, Block B',
    capacity: 20,
    desk_count: 20,
    pricing_unit: 'DAY',
    rates: [{ unit: 'DAY', amount_cents: 45000 }, { unit: 'MONTH', amount_cents: 800000 }],
  },
});
console.log('desk space units:', deskSpace.unitCount);

const customer = createCustomer(db, {
  actor,
  payload: { full_name: 'Hanna Perera', email: 'hanna@example.com', phone: '+94911000000', organization: 'Acme' },
});
console.log('customer:', customer.id, customer.fullName);

const start = businessLocalToEpoch('2026-11-10', '09:00');
const end = businessLocalToEpoch('2026-11-10', '11:00');

const availBefore = getSpaceAvailability(db, { spaceId: room.id, startAt: start, endAt: end });
console.log('availability before:', availBefore.isAvailable, availBefore.freeUnits, '/', availBefore.totalUnits);

const a = createReservation(db, {
  actor, spaceId: room.id, customerId: customer.id, startAt: start, endAt: end,
  attendees: 8, purpose: 'Planning', idempotencyKey: 'key-1',
});
console.log('created:', a.reservation.reference, a.reservation.status, a.reservation.unitCodes, 'total', a.reservation.totalCents);

let rejected = null;
try {
  createReservation(db, {
    actor, spaceId: room.id, customerId: customer.id,
    startAt: businessLocalToEpoch('2026-11-10', '10:00'),
    endAt: businessLocalToEpoch('2026-11-10', '12:00'),
    purpose: 'Overlap attempt',
  });
} catch (e) {
  rejected = e;
}
console.log('overlap rejected:', rejected?.code, '|', rejected?.message);
console.log('conflicts reported:', rejected?.conflicts?.length, rejected?.conflicts?.[0]?.reservationReference);

const adjacent = createReservation(db, {
  actor, spaceId: room.id, customerId: customer.id,
  startAt: end, endAt: businessLocalToEpoch('2026-11-10', '13:00'),
  purpose: 'Adjacent booking',
});
console.log('adjacent accepted:', adjacent.reservation.reference);

const retry = createReservation(db, {
  actor, spaceId: room.id, customerId: customer.id, startAt: start, endAt: end,
  attendees: 8, purpose: 'Planning', idempotencyKey: 'key-1',
});
console.log('idempotent retry -> same id:', retry.idempotent, retry.reservation.reference === a.reservation.reference);

// Desk capacity
const dStart = businessLocalToEpoch('2026-11-11', '09:00');
const dEnd = businessLocalToEpoch('2026-11-11', '17:00');
const desk1 = createReservation(db, { actor, spaceId: deskSpace.id, customerId: customer.id, startAt: dStart, endAt: dEnd, unitCount: 20 });
console.log('all 20 desks booked:', desk1.reservation.unitCount, 'rows:', desk1.reservation.units.length);
let capErr = null;
try {
  createReservation(db, { actor, spaceId: deskSpace.id, customerId: customer.id, startAt: dStart, endAt: dEnd, unitCount: 1 });
} catch (e) { capErr = e; }
console.log('desk overflow rejected:', capErr?.code, '|', capErr?.message);

// Cancellation releases inventory exactly once
const cancel = cancelReservation(db, { actor, reservationId: a.reservation.id, reason: 'Customer rescheduled' });
console.log('cancelled:', cancel.reservation.status, 'released rows:', cancel.releasedOccupancyRows, 'reason:', cancel.reservation.cancellationReason);
let secondCancel = null;
try { cancelReservation(db, { actor, reservationId: a.reservation.id, reason: 'again' }); } catch (e) { secondCancel = e; }
console.log('second cancel rejected:', secondCancel?.code, '|', secondCancel?.message);

const rebooked = createReservation(db, {
  actor, spaceId: room.id, customerId: customer.id, startAt: start, endAt: end, purpose: 'Rebooked slot',
});
console.log('slot rebookable after cancel:', rebooked.reservation.reference);

let blankReason = null;
try { cancelReservation(db, { actor, reservationId: rebooked.reservation.id, reason: '   ' }); } catch (e) { blankReason = e; }
console.log('blank cancel reason rejected:', blankReason?.code, '|', blankReason?.message);

const finalSpace = getSpace(db, room.id);
console.log('space reload ok:', finalSpace.code, finalSpace.status);
closeDb();
console.log('\nSMOKE CORE: PASS');
