/**
 * Booking-lifecycle notification hooks.
 *
 * Each hook is called *after* the booking write has committed. It is a
 * best-effort side effect: a notification failure is logged and swallowed so
 * it can never turn a successful reservation into an error response. The
 * secured cron tick dispatches any push/email work that an immediate attempt
 * did not finish.
 *
 * In-app copy may include the customer name (staff are already allowed to see
 * it). Push payloads are rebuilt in `notificationService` from space code,
 * time and reference only, so nothing private reaches a lock screen.
 */
import {
  businessDateKey, businessDateTimeLabel, businessTimeLabel,
} from '../domain/time.js';
import {
  NOTIFICATION_PRIORITY, NOTIFICATION_TYPE, createNotificationsForAdmins,
  schedulePendingDispatch,
} from './notificationService.js';

function safeText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function windowLabel(startAt, endAt) {
  const start = Number(startAt);
  const end = Number(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  if (businessDateKey(start) === businessDateKey(end)) {
    return `${businessTimeLabel(start)}–${businessTimeLabel(end)}`;
  }
  return `${businessDateTimeLabel(start)} – ${businessDateTimeLabel(end)}`;
}

function customerName(row) {
  return safeText(row?.customer_name, 160) || 'A customer';
}

function safeNotify(db, action, fn) {
  try {
    const result = fn();
    if (result && Number(result.created) > 0) schedulePendingDispatch(db);
    return result;
  } catch (error) {
    console.warn(`[notifications] ${action} hook failed:`, error?.code ?? error?.message ?? 'unknown');
    return null;
  }
}

function loadBookingRequest(db, reference) {
  const ref = safeText(reference, 80).toUpperCase();
  if (!ref) return null;
  return db.prepare(`
    SELECT br.id, br.reference, br.status, br.customer_name,
           br.start_at, br.end_at, br.reservation_id,
           s.code AS space_code, s.name AS space_name
      FROM booking_request br
      JOIN space s ON s.id = br.space_id
     WHERE br.reference = ?
  `).get(ref) ?? null;
}

function loadReservation(db, reservationId) {
  const id = Number(reservationId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return db.prepare(`
    SELECT r.id, r.reference, r.status, r.start_at, r.end_at,
           c.full_name AS customer_name,
           s.code AS space_code, s.name AS space_name
      FROM reservation r
      JOIN space s ON s.id = r.space_id
      LEFT JOIN customer c ON c.id = r.customer_id
     WHERE r.id = ?
  `).get(id) ?? null;
}

/** A visitor submitted a concierge booking request. */
export function afterBookingRequestCreated(db, { reference, now = Date.now() } = {}) {
  return safeNotify(db, 'booking_request.created', () => {
    const row = loadBookingRequest(db, reference);
    if (!row || row.status !== 'REQUESTED') return null;
    return createNotificationsForAdmins(db, {
      type: NOTIFICATION_TYPE.NEW_BOOKING,
      title: 'New booking request',
      body: `${customerName(row)} requested ${row.space_name} (${row.space_code}) for `
        + `${windowLabel(row.start_at, row.end_at)}. Reference ${row.reference}.`,
      entityType: 'booking_request',
      entityId: String(row.id),
      actionUrl: '/admin/booking-requests',
      priority: NOTIFICATION_PRIORITY.NORMAL,
      dedupeKey: `booking-request:created:${row.id}`,
      now,
    });
  });
}

/** A self-service checkout confirmed without a staff approval step. */
export function afterBookingRequestConfirmed(db, {
  reference, now = Date.now(), excludeAdminUserId = null,
} = {}) {
  return safeNotify(db, 'booking_request.confirmed', () => {
    const request = loadBookingRequest(db, reference);
    if (!request || request.status !== 'CONFIRMED' || !request.reservation_id) return null;
    const reservation = loadReservation(db, request.reservation_id);
    if (!reservation) return null;
    return createNotificationsForAdmins(db, {
      type: NOTIFICATION_TYPE.NEW_BOOKING,
      title: 'New confirmed booking',
      body: `${customerName(reservation)} booked ${reservation.space_name} `
        + `(${reservation.space_code}) for ${windowLabel(reservation.start_at, reservation.end_at)}. `
        + `Reference ${reservation.reference}.`,
      entityType: 'reservation',
      entityId: String(reservation.id),
      actionUrl: `/admin/reservations/${reservation.id}`,
      priority: NOTIFICATION_PRIORITY.NORMAL,
      dedupeKey: `booking-request:confirmed:${request.id}`,
      excludeAdminUserId,
      now,
    });
  });
}

/** A visitor cancelled their booking request through the private link. */
export function afterBookingRequestCancelled(db, { reference, now = Date.now() } = {}) {
  return safeNotify(db, 'booking_request.cancelled', () => {
    const row = loadBookingRequest(db, reference);
    if (!row || row.status !== 'CANCELLED') return null;
    return createNotificationsForAdmins(db, {
      type: NOTIFICATION_TYPE.BOOKING_CANCELLED,
      title: 'Booking request cancelled',
      body: `${customerName(row)} cancelled ${row.space_name} (${row.space_code}) for `
        + `${windowLabel(row.start_at, row.end_at)}. Reference ${row.reference}.`,
      entityType: 'booking_request',
      entityId: String(row.id),
      actionUrl: '/admin/booking-requests',
      priority: NOTIFICATION_PRIORITY.NORMAL,
      dedupeKey: `booking-request:cancelled:${row.id}`,
      now,
    });
  });
}

/** A guest created a confirmed self-service reservation. */
export function afterPublicReservationCreated(db, {
  reservationId, now = Date.now(), excludeAdminUserId = null,
} = {}) {
  return safeNotify(db, 'reservation.public_created', () => {
    const row = loadReservation(db, reservationId);
    if (!row || row.status !== 'CONFIRMED') return null;
    return createNotificationsForAdmins(db, {
      type: NOTIFICATION_TYPE.NEW_BOOKING,
      title: 'New confirmed booking',
      body: `${customerName(row)} booked ${row.space_name} (${row.space_code}) for `
        + `${windowLabel(row.start_at, row.end_at)}. Reference ${row.reference}.`,
      entityType: 'reservation',
      entityId: String(row.id),
      actionUrl: `/admin/reservations/${row.id}`,
      priority: NOTIFICATION_PRIORITY.NORMAL,
      dedupeKey: `reservation:created:${row.id}`,
      excludeAdminUserId,
      now,
    });
  });
}

/** A guest cancelled a confirmed reservation through the private link. */
export function afterPublicReservationCancelled(db, {
  reservationId, now = Date.now(), excludeAdminUserId = null,
} = {}) {
  return safeNotify(db, 'reservation.public_cancelled', () => {
    const row = loadReservation(db, reservationId);
    if (!row || row.status !== 'CANCELLED') return null;
    return createNotificationsForAdmins(db, {
      type: NOTIFICATION_TYPE.BOOKING_CANCELLED,
      title: 'Booking cancelled by guest',
      body: `${customerName(row)} cancelled ${row.space_name} (${row.space_code}) for `
        + `${windowLabel(row.start_at, row.end_at)}. Reference ${row.reference}.`,
      entityType: 'reservation',
      entityId: String(row.id),
      actionUrl: `/admin/reservations/${row.id}`,
      priority: NOTIFICATION_PRIORITY.NORMAL,
      dedupeKey: `reservation:cancelled:${row.id}`,
      excludeAdminUserId,
      now,
    });
  });
}
