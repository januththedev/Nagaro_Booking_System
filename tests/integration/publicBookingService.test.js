import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDb } from '../helpers/testDb.js';
import { parseBookingWindow } from '../../src/server/domain/validation.js';
import {
  cancelPublicBooking, createPublicBooking, getPublicBooking,
} from '../../src/server/services/publicBookingService.js';
import { listAdminUsers } from '../../src/server/services/adminUserService.js';

function seedSpace(db) {
  const now = Date.now();
  const space = db.prepare(`
    INSERT INTO space
      (code, name, category, short_description, capacity, status, currency,
       pricing_unit, min_duration_minutes, max_duration_minutes, buffer_minutes,
       open_time, close_time, amenities, attributes, created_at, updated_at, published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'PUBLIC-01', 'Public Booking Room', 'MEETING_ROOM', 'Direct booking test room',
    12, 'PUBLISHED', 'LKR', 'HOUR', 60, 480, 15, '08:00', '18:00', '[]', '{}',
    now, now, now,
  );
  const spaceId = Number(space.lastInsertRowid);
  db.prepare('INSERT INTO space_rate (space_id, unit, amount_cents, is_default) VALUES (?,?,?,1)')
    .run(spaceId, 'HOUR', 250000);
  db.prepare(`
    INSERT INTO resource_unit (space_id, code, label, kind, is_active, created_at)
    VALUES (?,?,?,?,1,?)
  `).run(spaceId, 'PUBLIC-01-ROOM', 'Public Booking Room', 'EXCLUSIVE', now);
  return spaceId;
}

function payload(spaceId, idempotencyKey = 'public:test-checkout-0001') {
  const window = parseBookingWindow({ date: '2030-06-18', start_time: '09:00', end_time: '11:00' });
  return {
    spaceId,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount: 1,
    attendees: 8,
    purpose: 'Product workshop',
    idempotencyKey,
    customer: {
      fullName: 'Nimali Fernando',
      email: 'nimali@example.com',
      phone: '+94 77 123 4567',
      organization: 'Example Labs',
    },
  };
}

test('public checkout confirms inventory through the canonical booking service', () => {
  const db = createTestDb();
  const spaceId = seedSpace(db);
  const result = createPublicBooking(db, payload(spaceId));

  assert.equal(result.idempotent, false);
  assert.match(result.reservation.reference, /^NG-\d{4}-\d{5}$/);
  assert.equal(result.reservation.status, 'CONFIRMED');
  assert.equal(result.reservation.totalCents, 500000);
  assert.ok(result.manageToken.length >= 40);

  const row = db.prepare('SELECT booking_channel, manage_token_hash FROM reservation').get();
  assert.equal(row.booking_channel, 'PUBLIC');
  assert.match(row.manage_token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.manage_token_hash, result.manageToken);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM occupancy WHERE status = 'ACTIVE'").get().c, 1);

  const loaded = getPublicBooking(db, {
    reference: result.reservation.reference,
    token: result.manageToken,
  });
  assert.equal(loaded.reference, result.reservation.reference);
  assert.equal(loaded.spaceCode, 'PUBLIC-01');
  assert.equal(Object.hasOwn(loaded, 'customer'), false);
  assert.equal(listAdminUsers(db, { includeInactive: true }).length, 0, 'system principal stays out of staff lists');
  db.close();
});

test('same checkout token is idempotent and a competing checkout loses', () => {
  const db = createTestDb();
  const spaceId = seedSpace(db);
  const first = createPublicBooking(db, payload(spaceId));
  const retry = createPublicBooking(db, payload(spaceId));
  assert.equal(retry.idempotent, true);
  assert.equal(retry.reservation.reference, first.reservation.reference);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reservation').get().c, 1);

  assert.throws(
    () => createPublicBooking(db, {
      ...payload(spaceId, 'public:competitor-0002'),
      customer: { fullName: 'Another Guest', email: 'other@example.com' },
    }),
    (error) => error?.code === 'DOUBLE_BOOKING_CONFLICT',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM reservation').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM customer').get().c, 1, 'failed checkout rolls customer creation back');
  db.close();
});

test('private capability cancels once and releases occupancy', () => {
  const db = createTestDb();
  const spaceId = seedSpace(db);
  const created = createPublicBooking(db, payload(spaceId));
  const cancelled = cancelPublicBooking(db, {
    reference: created.reservation.reference,
    token: created.manageToken,
    now: Date.UTC(2029, 0, 1),
  });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM occupancy WHERE status = 'ACTIVE'").get().c, 0);
  assert.throws(
    () => cancelPublicBooking(db, {
      reference: created.reservation.reference,
      token: created.manageToken,
      now: Date.UTC(2029, 0, 1),
    }),
    (error) => error?.status === 409,
  );
  assert.throws(
    () => getPublicBooking(db, { reference: created.reservation.reference, token: 'wrong-token-value-that-is-long-enough' }),
    (error) => error?.status === 404,
  );
  db.close();
});
