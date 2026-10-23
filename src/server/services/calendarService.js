/**
 * Unified admin calendar feed.
 *
 * The calendar is an operations surface, not just a list of confirmed
 * reservations. It deliberately shows every item that can affect a day:
 *
 *   RESERVATION  confirmed/completed (and cancelled when explicitly asked)
 *   MAINTENANCE  active maintenance blocks
 *   HOLD         active payment holds created from booking_hold_claim
 *   REQUEST      pending booking requests (annotations, never occupancy)
 *
 * The service is read-only. Writes still go through bookingService so the
 * atomic availability check and the database overlap trigger remain the only
 * authorities.
 */
import {
  BOOKING_REQUEST_STATUS, CONSUMING_RESERVATION_STATUSES, OCCUPANCY_STATUS,
  RESERVATION_STATUS,
} from '../domain/constants.js';
import { expireBookingHolds } from './bookingRequestService.js';

export const CALENDAR_EVENT_KIND = Object.freeze({
  RESERVATION: 'RESERVATION',
  MAINTENANCE: 'MAINTENANCE',
  HOLD: 'HOLD',
  REQUEST: 'REQUEST',
});

const HOLD_REQUEST_STATUSES = Object.freeze([
  BOOKING_REQUEST_STATUS.APPROVED_AWAITING_PAYMENT,
  BOOKING_REQUEST_STATUS.PAYMENT_REVIEW_REQUIRED,
]);

function placeholders(count) {
  return new Array(count).fill('?').join(',');
}

function normalizeRange(fromAt, toAt) {
  const start = Number(fromAt);
  const end = Number(toAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('A valid calendar range is required.');
  }
  return { fromAt: start, toAt: end };
}

/**
 * The legacy reservation shape returned by `loadCalendarData`, extended with
 * the fields the interactive calendar needs. Keeping this shape means old
 * imports and tests keep working while the feed grows.
 */
function mapReservationRow(row) {
  return {
    kind: CALENDAR_EVENT_KIND.RESERVATION,
    id: `reservation:${row.id}`,
    recordId: row.id,
    reservationId: row.id,
    reference: row.reference,
    status: row.status,
    startAt: Number(row.start_at),
    endAt: Number(row.end_at),
    unitCount: Number(row.unit_count),
    attendees: row.attendees === null || row.attendees === undefined ? null : Number(row.attendees),
    purpose: row.purpose,
    spaceId: Number(row.space_id),
    spaceCode: row.space_code,
    spaceName: row.space_name,
    category: row.space_category,
    customerId: row.customer_id === null || row.customer_id === undefined ? null : Number(row.customer_id),
    customerName: row.customer_name,
    unitCodes: row.unit_codes ?? [],
    totalCents: row.total_cents === null || row.total_cents === undefined ? null : Number(row.total_cents),
    currency: row.currency ?? 'LKR',
    billingUnit: row.billing_unit ?? null,
    billingQuantity: row.billing_quantity === null || row.billing_quantity === undefined
      ? null : Number(row.billing_quantity),
    bookingChannel: row.booking_channel ?? 'STAFF',
    createdAt: row.created_at === null || row.created_at === undefined ? null : Number(row.created_at),
    updatedAt: row.updated_at === null || row.updated_at === undefined ? null : Number(row.updated_at),
    editable: row.status === RESERVATION_STATUS.CONFIRMED,
    canMove: row.status === RESERVATION_STATUS.CONFIRMED,
    canResize: row.status === RESERVATION_STATUS.CONFIRMED,
    url: `/admin/reservations/${row.id}`,
    editUrl: `/admin/reservations/${row.id}/edit`,
  };
}

function mapMaintenanceRow(row) {
  return {
    kind: CALENDAR_EVENT_KIND.MAINTENANCE,
    id: `maintenance:${row.id}`,
    recordId: row.id,
    maintenanceId: row.id,
    reference: null,
    status: row.status,
    startAt: Number(row.start_at),
    endAt: Number(row.end_at),
    reason: row.reason,
    spaceId: Number(row.space_id),
    spaceCode: row.space_code,
    spaceName: row.space_name,
    category: row.space_category,
    unitCount: (row.unit_codes ?? []).length,
    unitCodes: row.unit_codes ?? [],
    customerName: null,
    editable: false,
    canMove: false,
    canResize: false,
    url: '/admin/maintenance',
    editUrl: null,
  };
}

function mapHoldRow(row) {
  const expiresAt = row.expires_at === null || row.expires_at === undefined
    ? null : Number(row.expires_at);
  const reference = row.reference;
  return {
    kind: CALENDAR_EVENT_KIND.HOLD,
    id: `hold:${row.request_id}`,
    recordId: Number(row.request_id),
    bookingRequestId: Number(row.request_id),
    bookingRequestReference: reference,
    reservationId: null,
    reference,
    status: row.request_status,
    paymentStatus: row.payment_status ?? null,
    startAt: Number(row.start_at),
    endAt: Number(row.end_at),
    unitCount: Number(row.unit_count ?? (row.unit_codes ?? []).length ?? 1),
    unitCodes: row.unit_codes ?? [],
    purpose: row.purpose,
    spaceId: Number(row.space_id),
    spaceCode: row.space_code,
    spaceName: row.space_name,
    category: row.space_category,
    customerName: row.customer_name,
    expiresAt,
    heldUntil: expiresAt,
    editable: false,
    canMove: false,
    canResize: false,
    url: `/admin/booking-requests?status=open&q=${encodeURIComponent(reference)}`,
    editUrl: null,
  };
}

function mapRequestRow(row) {
  const reference = row.reference;
  return {
    kind: CALENDAR_EVENT_KIND.REQUEST,
    id: `request:${row.id}`,
    recordId: Number(row.id),
    bookingRequestId: Number(row.id),
    bookingRequestReference: reference,
    reservationId: null,
    reference,
    status: BOOKING_REQUEST_STATUS.REQUESTED,
    paymentStatus: row.payment_status ?? null,
    startAt: Number(row.start_at),
    endAt: Number(row.end_at),
    unitCount: Number(row.unit_count ?? 1),
    unitCodes: [],
    purpose: row.purpose,
    spaceId: Number(row.space_id),
    spaceCode: row.space_code,
    spaceName: row.space_name,
    category: row.space_category,
    customerName: row.customer_name,
    customerEmail: row.email ?? null,
    customerPhone: row.phone ?? null,
    attendees: row.attendees === null || row.attendees === undefined ? null : Number(row.attendees),
    expiresAt: null,
    editable: false,
    canMove: false,
    canResize: false,
    actionable: true,
    url: `/admin/booking-requests?status=open&q=${encodeURIComponent(reference)}`,
    editUrl: null,
  };
}

function groupCodes(db, ownerColumn, ids, { table = 'occupancy', join = 'resource_unit' } = {}) {
  const grouped = new Map();
  if (!ids || ids.length === 0) return grouped;
  const rows = db.prepare(`
    SELECT o.${ownerColumn} AS owner_id, u.code
      FROM ${table} o
      JOIN ${join} u ON u.id = o.resource_unit_id
     WHERE o.status = '${OCCUPANCY_STATUS.ACTIVE}'
       AND o.${ownerColumn} IN (${placeholders(ids.length)})
     ORDER BY u.code ASC
  `).all(...ids);
  for (const row of rows) {
    if (!grouped.has(row.owner_id)) grouped.set(row.owner_id, []);
    const list = grouped.get(row.owner_id);
    if (!list.includes(row.code)) list.push(row.code);
  }
  return grouped;
}

function groupHoldCodes(db, requestIds) {
  const grouped = new Map();
  if (!requestIds || requestIds.length === 0) return grouped;
  const rows = db.prepare(`
    SELECT h.booking_request_id AS owner_id, u.code
      FROM booking_hold_claim h
      JOIN occupancy o ON o.id = h.occupancy_id
      JOIN resource_unit u ON u.id = o.resource_unit_id
     WHERE h.status = 'ACTIVE'
       AND o.status = '${OCCUPANCY_STATUS.ACTIVE}'
       AND h.booking_request_id IN (${placeholders(requestIds.length)})
     ORDER BY u.code ASC
  `).all(...requestIds);
  for (const row of rows) {
    if (!grouped.has(row.owner_id)) grouped.set(row.owner_id, []);
    const list = grouped.get(row.owner_id);
    if (!list.includes(row.code)) list.push(row.code);
  }
  return grouped;
}

function spaceClause(column, spaceIds, params) {
  if (!Array.isArray(spaceIds)) return '';
  // An explicit empty filter means "no matching spaces", not "all spaces".
  // This matters when a stale/unknown space code or an empty category is sent
  // to the calendar feed.
  if (spaceIds.length === 0) return ' AND 1 = 0';
  params.push(...spaceIds);
  return ` AND ${column} IN (${placeholders(spaceIds.length)})`;
}

/**
 * Load the unified range feed.
 *
 * @param {object} db
 * @param {{fromAt:number,toAt:number,spaceIds?:number[]|null,statuses?:string[]|null}} options
 * @returns {{reservations:object[],maintenance:object[],holds:object[],requests:object[]}}
 */
export function loadCalendarData(db, {
  fromAt, toAt, spaceIds = null, statuses = null,
} = {}) {
  const { fromAt: start, toAt: end } = normalizeRange(fromAt, toAt);
  // Expired payment holds must stop blocking the grid even if the five-minute
  // scheduler has not run yet.
  expireBookingHolds(db);
  const statusList = Array.isArray(statuses) && statuses.length
    ? statuses
    : CONSUMING_RESERVATION_STATUSES;

  const reservationWhere = [
    'r.start_at < ?',
    'r.end_at > ?',
    `r.status IN (${placeholders(statusList.length)})`,
  ];
  const reservationParams = [end, start, ...statusList];
  reservationWhere.push(spaceClause('r.space_id', spaceIds, reservationParams).replace(/^ AND /, ''));
  const reservationRows = db.prepare(`
    SELECT r.id, r.reference, r.status, r.start_at, r.end_at, r.unit_count, r.attendees,
           r.purpose, r.customer_id, r.total_cents, r.currency, r.billing_unit,
           r.billing_quantity, r.booking_channel, r.created_at, r.updated_at,
           s.id AS space_id, s.code AS space_code, s.name AS space_name,
           s.category AS space_category,
           c.full_name AS customer_name
      FROM reservation r
      JOIN space s ON s.id = r.space_id
      JOIN customer c ON c.id = r.customer_id
     WHERE ${reservationWhere.filter(Boolean).join(' AND ')}
     ORDER BY r.start_at ASC, r.id ASC
  `).all(...reservationParams);

  const reservationUnitCodes = groupCodes(db, 'reservation_id', reservationRows.map((row) => row.id));
  const reservations = reservationRows.map((row) => mapReservationRow({
    ...row,
    unit_codes: reservationUnitCodes.get(row.id) ?? [],
  }));

  const blockWhere = ['m.status = ?', 'm.start_at < ?', 'm.end_at > ?'];
  const blockParams = ['ACTIVE', end, start];
  blockWhere.push(spaceClause('m.space_id', spaceIds, blockParams).replace(/^ AND /, ''));
  const blockRows = db.prepare(`
    SELECT m.id, m.space_id, m.start_at, m.end_at, m.reason, m.status,
           s.code AS space_code, s.name AS space_name, s.category AS space_category
      FROM maintenance_block m
      JOIN space s ON s.id = m.space_id
     WHERE ${blockWhere.filter(Boolean).join(' AND ')}
     ORDER BY m.start_at ASC, m.id ASC
  `).all(...blockParams);
  const blockUnitCodes = groupCodes(db, 'maintenance_block_id', blockRows.map((row) => row.id));
  const maintenance = blockRows.map((row) => mapMaintenanceRow({
    ...row,
    unit_codes: blockUnitCodes.get(row.id) ?? [],
  }));

  // A hold is one event per booking request even when several units were
  // claimed. Occupancy is the inventory truth; booking_hold_claim supplies the
  // request reference and expiry.
  const holdWhere = [
    `h.status = 'ACTIVE'`,
    `o.status = '${OCCUPANCY_STATUS.ACTIVE}'`,
    'o.start_at < ?',
    'o.end_at > ?',
    `br.status IN (${placeholders(HOLD_REQUEST_STATUSES.length)})`,
  ];
  const holdParams = [end, start, ...HOLD_REQUEST_STATUSES];
  holdWhere.push(spaceClause('o.space_id', spaceIds, holdParams).replace(/^ AND /, ''));
  const holdRows = db.prepare(`
    SELECT br.id AS request_id, br.reference, br.status AS request_status,
           br.payment_status, br.customer_name, br.unit_count, br.purpose,
           br.hold_expires_at, MIN(h.expires_at) AS expires_at,
           MIN(o.start_at) AS start_at, MAX(o.end_at) AS end_at,
           o.space_id, s.code AS space_code, s.name AS space_name,
           s.category AS space_category
      FROM booking_hold_claim h
      JOIN occupancy o ON o.id = h.occupancy_id
      JOIN booking_request br ON br.id = h.booking_request_id
      JOIN space s ON s.id = o.space_id
     WHERE ${holdWhere.filter(Boolean).join(' AND ')}
     GROUP BY br.id, o.space_id, s.id, s.code, s.name, s.category
     ORDER BY start_at ASC, br.id ASC
  `).all(...holdParams);
  const holdUnitCodes = groupHoldCodes(db, [...new Set(holdRows.map((row) => row.request_id))]);
  const holds = holdRows.map((row) => mapHoldRow({
    ...row,
    unit_codes: holdUnitCodes.get(row.request_id) ?? [],
  }));

  // REQUESTED requests do not consume inventory. They are annotations so the
  // team can see demand before deciding to approve (which creates a hold).
  const requestWhere = [
    `br.status = '${BOOKING_REQUEST_STATUS.REQUESTED}'`,
    'br.start_at < ?',
    'br.end_at > ?',
  ];
  const requestParams = [end, start];
  requestWhere.push(spaceClause('br.space_id', spaceIds, requestParams).replace(/^ AND /, ''));
  const requestRows = db.prepare(`
    SELECT br.id, br.reference, br.status, br.payment_status, br.customer_name,
           br.email, br.phone, br.start_at, br.end_at, br.unit_count,
           br.attendees, br.purpose, br.space_id,
           s.code AS space_code, s.name AS space_name, s.category AS space_category
      FROM booking_request br
      JOIN space s ON s.id = br.space_id
     WHERE ${requestWhere.filter(Boolean).join(' AND ')}
     ORDER BY br.start_at ASC, br.id ASC
  `).all(...requestParams);
  const requests = requestRows.map(mapRequestRow);

  return { reservations, maintenance, holds, requests };
}

/** Build the hydrated reservation event shape used by create/reschedule JSON. */
export function reservationToEvent(reservation) {
  if (!reservation) return null;
  return mapReservationRow({
    id: reservation.id,
    reference: reservation.reference,
    status: reservation.status,
    start_at: reservation.startAt,
    end_at: reservation.endAt,
    unit_count: reservation.unitCount,
    attendees: reservation.attendees,
    purpose: reservation.purpose,
    space_id: reservation.spaceId,
    space_code: reservation.spaceCode,
    space_name: reservation.spaceName,
    space_category: reservation.category,
    customer_id: reservation.customerId,
    customer_name: reservation.customer?.fullName ?? reservation.customerName,
    unit_codes: reservation.unitCodes ?? (reservation.units ?? []).map((unit) => unit.code),
    total_cents: reservation.totalCents,
    currency: reservation.currency,
    billing_unit: reservation.billingUnit,
    billing_quantity: reservation.billingQuantity,
    booking_channel: reservation.bookingChannel,
    created_at: reservation.createdAt,
    updated_at: reservation.updatedAt,
  });
}

/** Flat unified, time-sorted feed consumed by GET /api/admin/calendar/events. */
export function calendarEvents(data) {
  const reservations = data?.reservations ?? [];
  const maintenance = data?.maintenance ?? [];
  const holds = data?.holds ?? [];
  const requests = data?.requests ?? [];
  return [...reservations, ...maintenance, ...holds, ...requests]
    .sort((a, b) => (a.startAt - b.startAt) || String(a.id).localeCompare(String(b.id)));
}
