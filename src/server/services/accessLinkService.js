/**
 * Customer access links.
 *
 * A confirmed booking gets one capability link: /access/<token>. The token is
 * 32 random bytes; only its SHA-256 hash is stored, so the database cannot be
 * replayed as a working link. The raw token exists in `delivery_token` only
 * until email and SMS delivery reach a final outcome, then it is erased.
 *
 * The link and the door permission are different things:
 *   - the LINK stays usable after the booking ends (session-ended view,
 *     extensions, staff assistance) until the retention period passes or an
 *     administrator revokes it;
 *   - DOOR PERMISSION is decided on every request from the booking itself
 *     (status, start, end) and can be revoked on its own.
 */
import { runInBackground } from './backgroundTask.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withWriteTransaction } from '../db/connection.js';
import { loadConfig } from '../config.js';
import { conflict, notFound, validationError } from '../domain/errors.js';
import { sendMail } from '../mail/mailer.js';
import { sendSms } from '../sms/smsSender.js';
import { accessLinkEmail, accessLinkSms } from '../mail/accessTemplates.js';
import { effectiveAccessConfig } from './accessPolicyService.js';
import { DOOR_REASON, queueSystemLock, syncDoorDeadline } from './doorService.js';
import { recordAudit } from './auditService.js';

const MINUTE = 60_000;
const MAX_DELIVERY_ATTEMPTS = 4;
const DELIVERY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

export function hashAccessToken(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

function newToken() {
  return randomBytes(32).toString('base64url');
}

export function accessUrl(baseUrl, token) {
  return `${String(baseUrl ?? '').replace(/\/$/, '')}/access/${token}`;
}

function invalidLink() {
  const error = notFound('This access link is not available.');
  error.code = 'ACCESS_LINK_INVALID';
  return error;
}

function num(value) { return value === null || value === undefined ? null : Number(value); }

function hydrateLink(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reservationId: Number(row.reservation_id),
    customerId: Number(row.customer_id),
    spaceId: Number(row.space_id),
    status: row.status,
    linkRevokedAt: num(row.link_revoked_at),
    doorAccessRevokedAt: num(row.door_access_revoked_at),
    revokeReason: row.revoke_reason ?? null,
    retainUntil: num(row.retain_until),
    emailStatus: row.email_status,
    emailError: row.email_error ?? null,
    emailSentAt: num(row.email_sent_at),
    smsStatus: row.sms_status,
    smsError: row.sms_error ?? null,
    smsSentAt: num(row.sms_sent_at),
    deliveryPending: row.delivery_token !== null && row.delivery_token !== undefined,
    firstOpenedAt: num(row.first_opened_at),
    lastOpenedAt: num(row.last_opened_at),
    openCount: Number(row.open_count ?? 0),
    createdAt: Number(row.created_at),
  };
}

export function getAccessLinkForReservation(db, reservationId) {
  return hydrateLink(db.prepare('SELECT * FROM booking_access_link WHERE reservation_id = ?').get(Number(reservationId)));
}

/* ----------------------------------------------------------------- issue */

/**
 * Create the link for a confirmed booking (idempotent), or rotate its token.
 * Returns `{ link, token }`; `token` is null when an existing link was kept.
 */
export function issueAccessLink(db, { reservationId, now = Date.now(), rotate = false, actor = null } = {}) {
  return withWriteTransaction(db, () => {
    const reservation = db.prepare('SELECT * FROM reservation WHERE id = ?').get(Number(reservationId));
    if (!reservation) throw notFound('Reservation not found.');
    const existing = db.prepare('SELECT * FROM booking_access_link WHERE reservation_id = ?').get(reservation.id);
    if (existing && !rotate) return { link: hydrateLink(existing), token: null, created: false };
    if (reservation.status === 'CANCELLED') throw conflict('A cancelled booking cannot have an access link.');

    const token = newToken();
    if (existing) {
      db.prepare(`UPDATE booking_access_link SET token_hash = ?, delivery_token = ?, status = 'ACTIVE', link_revoked_at = NULL,
          link_revoked_by = NULL, email_status = 'PENDING', email_error = NULL, email_attempts = 0, sms_status = 'PENDING',
          sms_error = NULL, sms_attempts = 0, next_delivery_at = ?, customer_id = ?, space_id = ?, updated_at = ? WHERE id = ?`)
        .run(hashAccessToken(token), token, now, reservation.customer_id, reservation.space_id, now, existing.id);
      db.prepare('DELETE FROM booking_access_device WHERE access_link_id = ?').run(existing.id);
    } else {
      db.prepare(`INSERT INTO booking_access_link
          (reservation_id, customer_id, space_id, token_hash, delivery_token, status, next_delivery_at, created_at, updated_at)
          VALUES (?,?,?,?,?,'ACTIVE',?,?,?)`)
        .run(reservation.id, reservation.customer_id, reservation.space_id, hashAccessToken(token), token, now, now, now);
    }
    recordAudit(db, {
      actorAdminUserId: actor?.id ?? null, actorLabel: actor?.label ?? 'system',
      action: existing ? 'access_link.rotated' : 'access_link.issued', entityType: 'reservation', entityId: reservation.id,
      summary: `${existing ? 'Replaced' : 'Issued'} the room access link for ${reservation.reference}`,
    });
    const row = db.prepare('SELECT * FROM booking_access_link WHERE reservation_id = ?').get(reservation.id);
    return { link: hydrateLink(row), token, created: !existing };
  });
}

/* --------------------------------------------------------------- resolve */

/**
 * Authenticate a token and load everything the customer page needs. Throws a
 * generic 404 for an unknown, revoked or retired link so the response never
 * says which of those it was.
 */
export function resolveAccess(db, token, { now = Date.now() } = {}) {
  const candidate = String(token ?? '').trim();
  if (!TOKEN_PATTERN.test(candidate)) throw invalidLink();
  const hash = hashAccessToken(candidate);
  const row = db.prepare('SELECT * FROM booking_access_link WHERE token_hash = ?').get(hash);
  if (!row) throw invalidLink();
  const expected = Buffer.from(String(row.token_hash), 'utf8');
  const actual = Buffer.from(hash, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalidLink();
  if (row.status !== 'ACTIVE') throw invalidLink();

  const reservation = db.prepare(`
    SELECT r.*, s.code AS space_code, s.name AS space_name, s.close_time AS space_close_time,
           s.open_time AS space_open_time, s.buffer_minutes AS space_buffer_minutes, s.pricing_unit AS space_pricing_unit,
           c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
      FROM reservation r JOIN space s ON s.id = r.space_id JOIN customer c ON c.id = r.customer_id
     WHERE r.id = ?`).get(Number(row.reservation_id));
  if (!reservation) throw invalidLink();

  const config = effectiveAccessConfig(db, reservation.space_id);
  const retention = Number(reservation.end_at) + config.policy.linkRetentionMinutes * MINUTE;
  const retainUntil = Math.max(retention, Number(row.retain_until ?? 0));
  if (now > retainUntil) throw invalidLink();

  return { linkId: Number(row.id), link: hydrateLink(row), reservation, config, retainUntil };
}

export function markAccessOpened(db, linkId, now = Date.now()) {
  try {
    db.prepare(`UPDATE booking_access_link SET open_count = open_count + 1, last_opened_at = ?,
        first_opened_at = COALESCE(first_opened_at, ?) WHERE id = ?`).run(now, now, Number(linkId));
  } catch { /* opening statistics are best effort */ }
}

/* -------------------------------------------------------------- delivery */

function nextStatus(result, attempts) {
  if (result.status === 'SENT') return { status: 'SENT', final: true };
  if (result.status === 'NOT_CONFIGURED') return { status: 'NOT_CONFIGURED', final: true };
  if (result.status === 'NO_ADDRESS') return { status: 'NO_ADDRESS', final: true };
  return attempts >= MAX_DELIVERY_ATTEMPTS ? { status: 'FAILED', final: true } : { status: 'PENDING', final: false };
}

/**
 * Send the link by email and SMS. Each channel is attempted until it reaches a
 * final outcome; the raw token is erased once both have. Never throws.
 */
export async function deliverAccessLink(db, { linkId, baseUrl = loadConfig().baseUrl, now = Date.now() } = {}) {
  let row;
  try {
    row = db.prepare(`
      SELECT l.*, r.reference, r.start_at, r.end_at, r.status AS reservation_status,
             s.name AS space_name, c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
        FROM booking_access_link l
        JOIN reservation r ON r.id = l.reservation_id
        JOIN space s ON s.id = l.space_id
        JOIN customer c ON c.id = l.customer_id
       WHERE l.id = ?`).get(Number(linkId));
  } catch { return null; }
  if (!row || !row.delivery_token) return null;
  if (row.status !== 'ACTIVE' || row.reservation_status === 'CANCELLED' || Number(row.end_at) <= now) {
    try { db.prepare('UPDATE booking_access_link SET delivery_token = NULL, next_delivery_at = NULL, updated_at = ? WHERE id = ?').run(now, row.id); } catch { /* ignore */ }
    return null;
  }

  const config = effectiveAccessConfig(db, row.space_id);
  const url = accessUrl(baseUrl, row.delivery_token);
  const details = {
    customerName: row.customer_name, spaceName: row.space_name, reference: row.reference,
    startAt: Number(row.start_at), endAt: Number(row.end_at), url, doorControl: config.doorReady,
  };

  let email = { status: row.email_status, final: row.email_status !== 'PENDING' };
  let emailError = row.email_error ?? null;
  let emailAttempts = Number(row.email_attempts);
  if (row.email_status === 'PENDING') {
    const address = String(row.customer_email ?? '').trim();
    const result = address ? await sendMail({ to: address, ...accessLinkEmail(details) }) : { status: 'NO_ADDRESS', error: 'No email address is on file.' };
    emailAttempts += 1;
    email = nextStatus(result, emailAttempts);
    emailError = result.error ?? null;
  }

  let sms = { status: row.sms_status, final: row.sms_status !== 'PENDING' };
  let smsError = row.sms_error ?? null;
  let smsAttempts = Number(row.sms_attempts);
  if (row.sms_status === 'PENDING') {
    const result = await sendSms({ to: row.customer_phone, message: accessLinkSms(details) });
    smsAttempts += 1;
    sms = nextStatus(result, smsAttempts);
    smsError = result.error ?? null;
  }

  const done = email.final && sms.final;
  const attempts = Math.max(emailAttempts, smsAttempts);
  const retryAt = done ? null : now + DELIVERY_BACKOFF_MS[Math.min(attempts - 1, DELIVERY_BACKOFF_MS.length - 1)];
  try {
    // The token hash guard keeps a slow send from overwriting a link that was
    // rotated while this delivery was in flight.
    db.prepare(`UPDATE booking_access_link SET email_status = ?, email_error = ?, email_attempts = ?,
        email_sent_at = CASE WHEN ? = 'SENT' THEN COALESCE(email_sent_at, ?) ELSE email_sent_at END,
        sms_status = ?, sms_error = ?, sms_attempts = ?,
        sms_sent_at = CASE WHEN ? = 'SENT' THEN COALESCE(sms_sent_at, ?) ELSE sms_sent_at END,
        delivery_token = CASE WHEN ? = 1 THEN NULL ELSE delivery_token END, next_delivery_at = ?, updated_at = ?
        WHERE id = ? AND token_hash = ?`)
      .run(email.status, email.status === 'SENT' ? null : emailError, emailAttempts, email.status, now,
        sms.status, sms.status === 'SENT' ? null : smsError, smsAttempts, sms.status, now,
        done ? 1 : 0, retryAt, now, row.id, row.token_hash);
  } catch (error) {
    console.warn('[access] could not record link delivery:', error?.code ?? error?.message ?? 'unknown');
  }
  return { email: email.status, sms: sms.status, done };
}

export async function deliverPendingAccessLinks(db, { baseUrl = loadConfig().baseUrl, now = Date.now(), limit = 20 } = {}) {
  const rows = db.prepare(`SELECT id FROM booking_access_link
     WHERE delivery_token IS NOT NULL AND (next_delivery_at IS NULL OR next_delivery_at <= ?) ORDER BY id LIMIT ?`).all(now, limit);
  let processed = 0;
  for (const row of rows) {
    await deliverAccessLink(db, { linkId: Number(row.id), baseUrl, now });
    processed += 1;
  }
  return { processed };
}

function deliverSoon(db, linkId) {
  // Failures are retried by the scheduler; on Vercel the send is kept alive past the response.
  runInBackground('access-link', () => deliverAccessLink(db, { linkId }));
}

/* ------------------------------------------------------------ revocation */

function requireLink(db, reservationId) {
  const row = db.prepare('SELECT * FROM booking_access_link WHERE reservation_id = ?').get(Number(reservationId));
  if (!row) throw notFound('This booking has no access link.');
  return row;
}

/** Turn off door control for one booking; the page stays reachable. */
export function revokeDoorAccess(db, { actor, reservationId, reason = null, now = Date.now() } = {}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  return withWriteTransaction(db, () => {
    const row = requireLink(db, reservationId);
    const note = String(reason ?? '').trim().slice(0, 300) || null;
    db.prepare('UPDATE booking_access_link SET door_access_revoked_at = ?, door_access_revoked_by = ?, revoke_reason = ?, updated_at = ? WHERE id = ?')
      .run(now, actor.id, note, now, row.id);
    queueSystemLock(db, { spaceId: row.space_id, reservationId: row.reservation_id, reason: DOOR_REASON.ACCESS_REVOKED, now });
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'access_link.door_revoked',
      entityType: 'reservation', entityId: row.reservation_id, summary: 'Revoked customer door access', details: { reason: note },
    });
    return hydrateLink(db.prepare('SELECT * FROM booking_access_link WHERE id = ?').get(row.id));
  });
}

export function restoreDoorAccess(db, { actor, reservationId, now = Date.now() } = {}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  return withWriteTransaction(db, () => {
    const row = requireLink(db, reservationId);
    db.prepare('UPDATE booking_access_link SET door_access_revoked_at = NULL, door_access_revoked_by = NULL, revoke_reason = NULL, updated_at = ? WHERE id = ?')
      .run(now, row.id);
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'access_link.door_restored',
      entityType: 'reservation', entityId: row.reservation_id, summary: 'Restored customer door access',
    });
    return hydrateLink(db.prepare('SELECT * FROM booking_access_link WHERE id = ?').get(row.id));
  });
}

/** Kill the link itself: the page stops loading for the customer. */
export function revokeAccessLink(db, { actor, reservationId, now = Date.now() } = {}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  return withWriteTransaction(db, () => {
    const row = requireLink(db, reservationId);
    db.prepare(`UPDATE booking_access_link SET status = 'REVOKED', link_revoked_at = ?, link_revoked_by = ?, delivery_token = NULL,
        next_delivery_at = NULL, updated_at = ? WHERE id = ?`).run(now, actor.id, now, row.id);
    db.prepare('DELETE FROM booking_access_device WHERE access_link_id = ?').run(row.id);
    queueSystemLock(db, { spaceId: row.space_id, reservationId: row.reservation_id, reason: DOOR_REASON.ACCESS_REVOKED, now });
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'access_link.revoked',
      entityType: 'reservation', entityId: row.reservation_id, summary: 'Revoked the room access link',
    });
    return hydrateLink(db.prepare('SELECT * FROM booking_access_link WHERE id = ?').get(row.id));
  });
}

/**
 * Issue a fresh token (the old link stops working) and send it again. The new
 * URL is returned once so staff can hand it to the customer directly.
 */
export function reissueAccessLink(db, { actor, reservationId, baseUrl = loadConfig().baseUrl, now = Date.now() } = {}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  const reservation = db.prepare('SELECT end_at, status FROM reservation WHERE id = ?').get(Number(reservationId));
  if (!reservation) throw notFound('Reservation not found.');
  const result = issueAccessLink(db, { reservationId, now, rotate: true, actor });
  deliverSoon(db, result.link.id);
  return { link: result.link, url: accessUrl(baseUrl, result.token) };
}

/* ---------------------------------------------------- phone verification */

function digits(value) { return String(value ?? '').replace(/\D/g, ''); }

export function phoneCheckRequired(access) {
  return access.config.policy.requirePhoneCheck && digits(access.reservation.customer_phone).length >= 4;
}

export function isDeviceVerified(db, access, deviceSecret) {
  if (!phoneCheckRequired(access)) return true;
  const secret = String(deviceSecret ?? '');
  if (secret.length < 20) return false;
  const row = db.prepare('SELECT id FROM booking_access_device WHERE access_link_id = ? AND device_hash = ?').get(access.linkId, hashAccessToken(secret));
  return Boolean(row);
}

/** Check the last four digits of the booking telephone number. Returns a device secret for the cookie. */
export function verifyPhoneLastFour(db, { access, lastFour, now = Date.now() } = {}) {
  const expected = digits(access.reservation.customer_phone).slice(-4);
  const given = digits(lastFour);
  const a = Buffer.from(expected.padEnd(4, 'x'), 'utf8');
  const b = Buffer.from(given.padEnd(4, 'y').slice(0, 4), 'utf8');
  if (expected.length !== 4 || given.length !== 4 || !timingSafeEqual(a, b)) {
    const error = validationError('Those digits do not match the phone number on this booking.', { lastFour: 'Check the number and try again.' });
    error.code = 'VERIFICATION_FAILED';
    throw error;
  }
  const secret = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO booking_access_device (access_link_id, device_hash, verified_at) VALUES (?,?,?)').run(access.linkId, hashAccessToken(secret), now);
  return secret;
}

/* ------------------------------------------------------- lifecycle hooks */

function safely(label, fn) {
  try { return fn(); } catch (error) {
    console.warn(`[access] ${label} failed:`, error?.code ?? error?.message ?? 'unknown');
    return null;
  }
}

/**
 * Called after a booking is confirmed (any channel). Best effort by design: a
 * problem here must never turn a committed booking into an error.
 */
export function afterReservationConfirmed(db, { reservationId, now = Date.now() } = {}) {
  return safely('link issue', () => {
    const reservation = db.prepare('SELECT id, status, end_at, space_id FROM reservation WHERE id = ?').get(Number(reservationId));
    if (!reservation || reservation.status !== 'CONFIRMED' || Number(reservation.end_at) <= now) return null;
    if (!effectiveAccessConfig(db, reservation.space_id).linksEnabled) return null;
    const result = issueAccessLink(db, { reservationId: reservation.id, now });
    if (result.created) deliverSoon(db, result.link.id);
    return result.link;
  });
}

/** Called after an edit. Keeps the link's room/customer and the door deadline in step with the booking. */
export function afterReservationChanged(db, { reservationId, previousSpaceId = null, now = Date.now() } = {}) {
  return safely('link sync', () => withWriteTransaction(db, () => {
    const reservation = db.prepare('SELECT * FROM reservation WHERE id = ?').get(Number(reservationId));
    if (!reservation) return null;
    const link = db.prepare('SELECT * FROM booking_access_link WHERE reservation_id = ?').get(reservation.id);
    const oldSpaceId = Number(previousSpaceId ?? link?.space_id ?? reservation.space_id);
    if (oldSpaceId !== Number(reservation.space_id)) {
      queueSystemLock(db, { spaceId: oldSpaceId, reservationId: reservation.id, reason: DOOR_REASON.BOOKING_CHANGED, now });
    } else {
      syncDoorDeadline(db, { reservationId: reservation.id, spaceId: reservation.space_id, newEndAt: reservation.end_at, now });
    }
    if (link) {
      db.prepare('UPDATE booking_access_link SET space_id = ?, customer_id = ?, updated_at = ? WHERE id = ?')
        .run(reservation.space_id, reservation.customer_id, now, link.id);
    }
    return true;
  }));
}

/** Called after a cancellation: lock the door if this booking left it open. */
export function afterReservationCancelled(db, { reservationId, now = Date.now() } = {}) {
  return safely('cancel sync', () => withWriteTransaction(db, () => {
    const reservation = db.prepare('SELECT id, space_id FROM reservation WHERE id = ?').get(Number(reservationId));
    if (!reservation) return null;
    db.prepare('UPDATE booking_access_link SET delivery_token = NULL, next_delivery_at = NULL, updated_at = ? WHERE reservation_id = ?').run(now, reservation.id);
    queueSystemLock(db, { spaceId: reservation.space_id, reservationId: reservation.id, reason: DOOR_REASON.BOOKING_CANCELLED, now });
    return true;
  }));
}
