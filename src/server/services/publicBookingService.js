/**
 * Guest self-service reservations.
 *
 * This deliberately reuses the staff booking service for every business rule,
 * allocation, price snapshot and overlap guard. The public layer owns only
 * capability tokens, customer resolution and a privacy-safe projection.
 */
import { createHash, randomBytes } from 'node:crypto';
import { notFound, conflict, validationError } from '../domain/errors.js';
import { cancelReservation, createReservation } from './bookingService.js';

function systemActor(db) {
  let row = db.prepare(`
    SELECT id, display_name
      FROM admin_user
     WHERE COALESCE(is_system, 0) = 1
     ORDER BY id ASC
     LIMIT 1
  `).get();
  if (!row) {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO admin_user
        (email, password_hash, display_name, role, is_active, created_at, updated_at, is_system)
      VALUES (?,?,?,?,?,?,?,1)
    `).run(
      'public-booking@system.nagaro',
      '!NO_LOGIN_PUBLIC_BOOKING_PRINCIPAL!',
      'Public booking checkout',
      'STAFF',
      0,
      now,
      now,
    );
    row = db.prepare(`
      SELECT id, display_name FROM admin_user
       WHERE COALESCE(is_system, 0) = 1
       ORDER BY id ASC LIMIT 1
    `).get();
  }
  if (!row) throw new Error('Could not initialise the public booking system principal.');
  return { id: row.id, label: row.display_name || 'Public booking checkout' };
}

function tokenHash(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

function safeReservation(row) {
  if (!row) return null;
  return {
    reference: row.reference,
    status: row.status,
    spaceCode: row.spaceCode,
    spaceName: row.spaceName,
    startAt: row.startAt,
    endAt: row.endAt,
    unitCount: row.unitCount,
    attendees: row.attendees,
    billingUnit: row.billingUnit,
    billingQuantity: row.billingQuantity,
    rateCents: row.rateCents,
    totalCents: row.totalCents,
    currency: row.currency,
  };
}

export function createPublicBooking(db, input = {}) {
  const space = db.prepare('SELECT status FROM space WHERE id = ?').get(Number(input.spaceId));
  if (!space || space.status !== 'PUBLISHED') {
    throw validationError('Choose a published space.', { space_code: 'Choose a published space.' });
  }
  const now = Number(input.now ?? Date.now());
  if (!Number.isFinite(Number(input.startAt)) || Number(input.startAt) <= now) {
    throw validationError('Public bookings must start in the future.', { date: 'Choose a future date and time.' });
  }
  const actor = systemActor(db);
  const manageToken = randomBytes(32).toString('base64url');
  const result = createReservation(db, {
    actor,
    spaceId: input.spaceId,
    customerPayload: {
      full_name: input.customer?.fullName,
      email: input.customer?.email,
      phone: input.customer?.phone || null,
      organization: input.customer?.organization || null,
    },
    startAt: input.startAt,
    endAt: input.endAt,
    unitCount: input.unitCount,
    attendees: input.attendees,
    purpose: input.purpose || null,
    internalNotes: null,
    billingUnit: input.billingUnit || null,
    billingQuantity: null,
    idempotencyKey: input.idempotencyKey,
    source: 'public_checkout',
    bookingChannel: 'PUBLIC',
    manageTokenHash: tokenHash(manageToken),
  });
  return {
    reservation: safeReservation(result.reservation),
    idempotent: result.idempotent,
    manageToken: result.idempotent ? null : manageToken,
  };
}

function loadByCapability(db, reference, token) {
  const ref = String(reference ?? '').trim().toUpperCase();
  const candidate = String(token ?? '').trim();
  if (!ref || candidate.length < 20) throw notFound('Booking not found.');
  const row = db.prepare(`
    SELECT r.id
      FROM reservation r
     WHERE r.reference = ? AND r.manage_token_hash = ? AND r.booking_channel = 'PUBLIC'
  `).get(ref, tokenHash(candidate));
  if (!row) throw notFound('Booking not found.');
  return Number(row.id);
}

export function getPublicBooking(db, { reference, token } = {}) {
  const id = loadByCapability(db, reference, token);
  const row = db.prepare(`
    SELECT r.*, s.code AS space_code, s.name AS space_name
      FROM reservation r JOIN space s ON s.id = r.space_id
     WHERE r.id = ?
  `).get(id);
  return safeReservation({
    ...row,
    spaceCode: row.space_code,
    spaceName: row.space_name,
    startAt: row.start_at,
    endAt: row.end_at,
    unitCount: row.unit_count,
    billingUnit: row.billing_unit,
    billingQuantity: row.billing_quantity,
    rateCents: row.rate_cents,
    totalCents: row.total_cents,
  });
}

export function cancelPublicBooking(db, { reference, token, now = Date.now() } = {}) {
  const id = loadByCapability(db, reference, token);
  const row = db.prepare('SELECT start_at, status FROM reservation WHERE id = ?').get(id);
  if (row.status !== 'CONFIRMED') throw conflict('This booking is no longer active.');
  if (Number(row.start_at) <= Number(now)) {
    throw conflict('A booking cannot be cancelled online after its start time. Contact the operations desk.');
  }
  const result = cancelReservation(db, {
    actor: systemActor(db),
    reservationId: id,
    reason: 'Cancelled by guest through the private booking link.',
  });
  return safeReservation(result.reservation);
}
