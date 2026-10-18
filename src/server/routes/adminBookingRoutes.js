/**
 * Administrative booking lifecycle + availability calendar.
 *
 * Routes (thin: parse input -> call a service -> render or serialise):
 *
 *   GET  /admin/reservations                  consolidated list, filters, sort, paging
 *   GET  /admin/reservations/new              booking form (prefillable)
 *   POST /admin/reservations                  create (idempotent via the form token)
 *   GET  /admin/reservations/:id              detail: every field, pricing, audit, actions
 *   GET  /admin/reservations/:id/edit         edit form
 *   POST /admin/reservations/:id              update (rolls back atomically on conflict)
 *   POST /admin/reservations/:id/cancel       reason-required cancellation
 *   GET  /admin/calendar                      day/week availability projection
 *   GET  /admin/maintenance                   maintenance blocks
 *   POST /admin/maintenance                   create a block
 *   POST /admin/maintenance/:id/cancel        cancel a block
 *   GET  /api/admin/availability              full-detail availability preview (JSON)
 *   GET  /api/admin/calendar/events           calendar feed (JSON)
 *
 * Two behaviours matter more than the rest:
 *
 *  1. A DOUBLE_BOOKING_CONFLICT on a form POST re-renders the form with HTTP
 *     409, the staff member's input preserved and the submit button enabled, so
 *     changing the time and retrying is one step. On a JSON request the error is
 *     re-thrown and `app.js`'s boundary emits the machine-readable envelope.
 *  2. A POST that is repeated (same `form_token`) creates exactly one
 *     reservation: the token becomes `reservation.idempotency_key`, which is
 *     UNIQUE, and `createReservation` returns the existing row.
 *
 * Since the router has no per-route middleware, every handler calls
 * `requireAuth` (and `requireCsrf` after `readBody` on mutations) itself.
 */
import {
  LIMITS, asInteger, asPagination, asTrimmedString, normalizeEmail, optionalEmail,
  optionalPhone, parseBookingWindow,
} from '../domain/validation.js';
import {
  ALLOWED_PRICING_UNITS, OCCUPANCY_SOURCE, PRICING_UNIT_LABEL, RESERVATION_STATUS,
  SPACE_CATEGORY, SPACE_STATUS,
} from '../domain/constants.js';
import { AppError, DoubleBookingError, notFound, validationError } from '../domain/errors.js';
import {
  MS, businessDateKey, businessLocalToEpoch, businessTimeLabel, coerceEpochMs,
  startOfBusinessDay, todayBusinessDate,
} from '../domain/time.js';
import { randomToken } from '../domain/references.js';
import { q } from '../http/request.js';
import { appendCookie, redirect, serializeCookie } from '../http/response.js';
import { FLASH_COOKIE, requireAuth, requireCsrf } from '../security/sessions.js';
import {
  cancelMaintenanceBlock, cancelReservation, createMaintenanceBlock, createReservation,
  listMaintenanceBlocks, loadReservation, updateReservation,
} from '../services/bookingService.js';
import { getSpace, getSpaceByCode, listSpaces } from '../services/spaceService.js';
import { createCustomer, findPossibleDuplicates, getCustomer, searchCustomers } from '../services/customerService.js';
import { activeUnits, getSpaceAvailability, getSpaceDayGrid } from '../services/availabilityService.js';
import { billingQuantityFor, formatMoney, loadRates, quote } from '../services/pricingService.js';
import { listAudit } from '../services/auditService.js';
import { renderReservationListPage, renderBookingFormPage, renderReservationDetailPage, renderMaintenancePage } from '../../web/views/admin/bookingViews.js';
import { renderCalendarPage, renderCalendarWeekPage } from '../../web/views/admin/calendarViews.js';

const LIST_PAGE_SIZE = 20;
const FORM_TOKEN_BYTES = 18;
const MAX_UNITS_PER_BOOKING = 500;
const FLASH_MAX_AGE_SECONDS = 30;

export const RESERVATION_SORT_FIELDS = Object.freeze(['start', 'created', 'reference']);
export const CALENDAR_VIEWS = Object.freeze(['day', 'week']);
export const CALENDAR_STATUS_FILTERS = Object.freeze(['all', 'CONFIRMED', 'COMPLETED', 'CANCELLED']);
export const MAINTENANCE_STATUS_FILTERS = Object.freeze(['all', 'ACTIVE', 'CANCELLED']);

/* ------------------------------------------------------------------ scalars */

/** First value of a possibly repeated body/query key. */
export function firstValue(value) {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function text(value) {
  const raw = firstValue(value);
  return raw === null || raw === undefined ? '' : String(raw).trim();
}

function parsePositiveInt(value) {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** A fresh single-use token embedded in a rendered form. */
export function newFormToken() {
  return randomToken(FORM_TOKEN_BYTES);
}

/* --------------------------------------------------------- calendar date maths */

/** `dateKey` shifted by whole business-local days (no DST in SLST). */
export function addDaysToDateKey(dateKey, days) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** Monday of the week containing `dateKey`. */
export function startOfWeekKey(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysToDateKey(dateKey, -((weekday + 6) % 7));
}

/* ------------------------------------------------------ booking form parsing */

const UNIT_LABEL = (category) => ALLOWED_PRICING_UNITS[category] ?? [];

function pricingUnitWords(unit) {
  return PRICING_UNIT_LABEL[unit] ?? unit;
}

/**
 * Resolve and validate the submitted space id. Throws immediately (the rest of
 * the form cannot be interpreted without a space).
 */
function resolveSubmittedSpaceId(input, space) {
  const raw = text(input.space_id ?? input.space);
  if (raw === '') {
    throw validationError('Choose the space this booking is for.', { field: 'space_id' });
  }
  if (!/^\d+$/.test(raw)) {
    throw validationError('Choose a space from the list; that value is not a space id.', { field: 'space_id' });
  }
  const spaceId = Number(raw);
  if (!space || !space.id) {
    throw validationError('That space does not exist. It may have been removed or archived.', { field: 'space_id' });
  }
  if (Number(space.id) !== spaceId) {
    throw validationError('That space does not match the booking you are editing.', { field: 'space_id' });
  }
  if (space.status === SPACE_STATUS.ARCHIVED) {
    throw validationError('Archived spaces cannot take new or changed bookings. Choose another space.', { field: 'space_id' });
  }
  return spaceId;
}

/** Desk/unit count. Exclusive spaces have exactly one bookable unit. */
function resolveUnitCount(input, space) {
  const raw = firstValue(input.unit_count ?? input.desks);
  if (space.category === SPACE_CATEGORY.COWORKING) {
    return asInteger(raw, { field: 'unit_count', min: 1, max: MAX_UNITS_PER_BOOKING, required: true });
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') return 1;
  const value = asInteger(raw, { field: 'unit_count', min: 1, max: MAX_UNITS_PER_BOOKING, required: false });
  if (value !== 1) {
    throw validationError('This space has a single bookable unit, so the count must be 1.', { field: 'unit_count' });
  }
  return 1;
}

function resolveAttendees(input) {
  return asInteger(firstValue(input.attendees), { field: 'attendees', min: 1, max: 100000, fallback: null });
}

function resolveBillingUnit(input, space) {
  const raw = text(input.billing_unit);
  if (raw === '') return null; // the service falls back to space.pricing_unit
  const allowed = UNIT_LABEL(space.category);
  if (!allowed.includes(raw)) {
    const options = allowed.length ? allowed.map(pricingUnitWords).join(', ') : 'no configured rate';
    throw validationError(`This space is billed ${options} only. Choose one of those billing units.`, { field: 'billing_unit' });
  }
  return raw;
}

function resolveBillingQuantity(input) {
  return asInteger(firstValue(input.billing_quantity), { field: 'billing_quantity', min: 1, max: 100000, fallback: null });
}

/**
 * Customer selection: an existing id, or the inline new-customer block, or a
 * bare search string (the no-JavaScript path) resolved against the directory.
 * Pure: whoever calls this decides whether to create a customer.
 */
export function parseCustomerChoice(input = {}) {
  const raw = text(input.customer_id);
  if (raw !== '') {
    if (!/^\d+$/.test(raw)) {
      throw validationError('Choose a customer from the search results.', { field: 'customer_id' });
    }
    return { customerId: Number(raw), newCustomer: null, search: null };
  }
  const fullName = asTrimmedString(firstValue(input.new_customer_name), { max: LIMITS.maxNameLength, field: 'new_customer_name' });
  const email = optionalEmail(firstValue(input.new_customer_email), { field: 'new_customer_email' });
  const phone = optionalPhone(firstValue(input.new_customer_phone), { field: 'new_customer_phone' });
  const organization = asTrimmedString(firstValue(input.new_customer_organization), { max: LIMITS.maxNameLength, field: 'new_customer_organization' });
  if (fullName || email) {
    if (!fullName) throw validationError('Enter the new customer\u2019s full name.', { field: 'new_customer_name' });
    if (!email) throw validationError('Enter an email address for the new customer.', { field: 'new_customer_email' });
    return { customerId: null, newCustomer: { full_name: fullName, email, phone, organization }, search: null };
  }
  const search = asTrimmedString(firstValue(input.customer_search), { max: LIMITS.maxQueryLength, field: 'customer_search' });
  return { customerId: null, newCustomer: null, search: search || null };
}

/**
 * Parse the booking form (or the JSON equivalent). Returns plain data only;
 * business rules (opening hours, capacity, continuity) stay in the service.
 *
 * Accepted window inputs:
 *   - `date` + `start_time` + `end_time`  (the rendered form)
 *   - `start_at` / `end_at` epoch or ISO  (advanced / JSON path)
 *
 * Throws a validationError whose `details` is either `{ field: message }` for a
 * single problem or a whole field map, so the form can highlight everything at
 * once and `app.js` can render `problems` for the API caller.
 */
export function parseBookingFormInput(body = {}, space = null) {
  const input = body && typeof body === 'object' ? body : {};
  const spaceId = resolveSubmittedSpaceId(input, space);

  const errors = {};
  const take = (field, fn, fallback) => {
    try {
      return fn();
    } catch (error) {
      const details = error instanceof AppError ? error.details : null;
      if (details && typeof details === 'object') {
        if (typeof details.field === 'string') errors[details.field] = error.message;
        else if (Array.isArray(details.problems) && details.problems.length) errors[field] = details.problems[0];
        else errors[field] = error.message;
        return fallback;
      }
      throw error;
    }
  };

  const window = take('start_at', () => parseBookingWindow({
    start_at: firstValue(input.start_at),
    end_at: firstValue(input.end_at),
    date: firstValue(input.date),
    start_time: firstValue(input.start_time),
    end_time: firstValue(input.end_time),
  }), null);

  const unitCount = take('unit_count', () => resolveUnitCount(input, space), 1);
  const attendees = take('attendees', () => resolveAttendees(input), null);
  const billingUnit = take('billing_unit', () => resolveBillingUnit(input, space), null);
  const billingQuantity = take('billing_quantity', () => resolveBillingQuantity(input), null);
  const purpose = take('purpose', () => asTrimmedString(firstValue(input.purpose), { max: LIMITS.maxTextLength, field: 'purpose' }), null);
  const internalNotes = take('internal_notes', () => asTrimmedString(firstValue(input.internal_notes), { max: LIMITS.maxTextLength, field: 'internal_notes' }), null);
  const customer = take('customer_id', () => parseCustomerChoice(input), { customerId: null, newCustomer: null, search: null });

  const formToken = asTrimmedString(firstValue(input.form_token), { max: 200, field: 'form_token' });

  if (Object.keys(errors).length > 0) {
    throw validationError('Please correct the highlighted fields.', errors);
  }

  return {
    spaceId,
    startAt: window.startAt,
    endAt: window.endAt,
    durationMinutes: window.durationMinutes,
    unitCount,
    attendees,
    purpose: purpose || null,
    internalNotes: internalNotes || null,
    billingUnit,
    billingQuantity,
    idempotencyKey: formToken && formToken.length ? formToken : null,
    customerId: customer.customerId,
    newCustomer: customer.newCustomer,
    customerSearch: customer.search,
  };
}

/** Maintenance window + reason + optional unit subset. */
export function parseMaintenanceFormInput(body = {}, space = null) {
  const spaceId = resolveSubmittedSpaceId(body, space);
  const errors = {};
  const take = (field, fn, fallback) => {
    try { return fn(); } catch (error) {
      const details = error instanceof AppError ? error.details : null;
      if (details && typeof details === 'object') {
        errors[typeof details.field === 'string' ? details.field : field] = error.message;
        return fallback;
      }
      throw error;
    }
  };
  const window = take('start_at', () => parseBookingWindow({
    start_at: firstValue(body.start_at),
    end_at: firstValue(body.end_at),
    date: firstValue(body.date),
    start_time: firstValue(body.start_time),
    end_time: firstValue(body.end_time),
  }), null);
  const reason = take('reason', () => asTrimmedString(firstValue(body.reason), { max: 500, field: 'reason' }), null) || '';
  const unitIds = [];
  const rawUnits = body.unit_ids ?? body.resource_unit_ids;
  for (const entry of Array.isArray(rawUnits) ? rawUnits : [rawUnits]) {
    const id = parsePositiveInt(entry);
    if (id && !unitIds.includes(id)) unitIds.push(id);
  }
  if (Object.keys(errors).length > 0) throw validationError('Please correct the highlighted fields.', errors);
  if (!reason.trim()) throw validationError('A reason is required for a maintenance block.', { field: 'reason' });
  return { spaceId, startAt: window.startAt, endAt: window.endAt, durationMinutes: window.durationMinutes, reason: reason.trim(), resourceUnitIds: unitIds };
}

/* --------------------------------------------------------- form value states */

/** Raw strings from a submitted body, so a rejected form keeps every keystroke. */
export function valuesFromBookingBody(body = {}) {
  const pick = (key) => text(body[key]);
  return {
    space_id: pick('space_id'),
    customer_id: pick('customer_id'),
    customer_search: pick('customer_search'),
    new_customer_name: pick('new_customer_name'),
    new_customer_email: pick('new_customer_email'),
    new_customer_phone: pick('new_customer_phone'),
    new_customer_organization: pick('new_customer_organization'),
    date: pick('date'),
    start_time: pick('start_time'),
    end_time: pick('end_time'),
    start_at: pick('start_at'),
    end_at: pick('end_at'),
    unit_count: pick('unit_count'),
    attendees: pick('attendees'),
    purpose: pick('purpose'),
    internal_notes: pick('internal_notes'),
    billing_unit: pick('billing_unit'),
    billing_quantity: pick('billing_quantity'),
  };
}

/** Values for the edit form, derived from the stored reservation. */
export function valuesFromReservation(reservation) {
  return {
    space_id: String(reservation.spaceId ?? ''),
    customer_id: String(reservation.customerId ?? ''),
    customer_search: reservation.customer?.fullName ?? '',
    new_customer_name: '',
    new_customer_email: '',
    new_customer_phone: '',
    new_customer_organization: '',
    date: businessDateKey(reservation.startAt),
    start_time: businessTimeLabel(reservation.startAt),
    end_time: businessTimeLabel(reservation.endAt),
    start_at: '',
    end_at: '',
    unit_count: String(reservation.unitCount ?? 1),
    attendees: reservation.attendees === null || reservation.attendees === undefined ? '' : String(reservation.attendees),
    purpose: reservation.purpose ?? '',
    internal_notes: reservation.internalNotes ?? '',
    billing_unit: reservation.billingUnit ?? '',
    billing_quantity: String(reservation.billingQuantity ?? ''),
  };
}

/* -------------------------------------------------------------- read models */

/** Bookable (non-archived) spaces, plus the reservation's own space if archived. */
export function bookableSpaces(db, { includeSpaceId = null } = {}) {
  const { items } = listSpaces(db, { includeArchived: false, limit: 500, sort: 'name' });
  if (includeSpaceId && !items.some((space) => space.id === Number(includeSpaceId))) {
    const extra = getSpace(db, includeSpaceId);
    if (extra) items.push(extra);
  }
  return items;
}

/** Resolve a `?space=` value that may be an id or a code. */
export function resolveSpaceReference(db, value) {
  const raw = text(value);
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return getSpace(db, Number(raw));
  return getSpaceByCode(db, raw);
}

export function parseReservationFilters(query = {}) {
  const status = text(query.status);
  const rawCategory = text(query.category);
  const sort = text(query.sort);
  const fromRaw = text(query.from);
  const toRaw = text(query.to);
  return {
    status: ['all', ...Object.values(RESERVATION_STATUS)].includes(status) ? status : 'all',
    space: text(query.space) || null,
    category: Object.values(SPACE_CATEGORY).includes(rawCategory) ? rawCategory : null,
    customer: text(query.customer) || null,
    q: (text(query.q) || '').slice(0, LIMITS.maxQueryLength) || null,
    from: /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : null,
    to: /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : null,
    sort: RESERVATION_SORT_FIELDS.includes(sort) ? sort : 'start',
  };
}

const RESERVATION_LIST_SELECT = `
  SELECT r.id, r.reference, r.status, r.start_at, r.end_at, r.unit_count, r.attendees,
         r.purpose, r.cancellation_reason, r.cancelled_at, r.created_at, r.updated_at,
         r.total_cents, r.currency, r.billing_unit, r.billing_quantity,
         s.id AS space_id, s.code AS space_code, s.name AS space_name, s.category AS space_category,
         c.id AS customer_id, c.full_name AS customer_name, c.organization AS customer_organization,
         u.display_name AS created_by_name
    FROM reservation r
    JOIN space s ON s.id = r.space_id
    JOIN customer c ON c.id = r.customer_id
    LEFT JOIN admin_user u ON u.id = r.created_by
`;

function mapReservationListRow(row) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    spaceId: row.space_id,
    spaceCode: row.space_code,
    spaceName: row.space_name,
    category: row.space_category,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerOrganization: row.customer_organization,
    startAt: row.start_at,
    endAt: row.end_at,
    unitCount: row.unit_count,
    attendees: row.attendees,
    purpose: row.purpose,
    cancellationReason: row.cancellation_reason,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totalCents: row.total_cents,
    currency: row.currency,
    billingUnit: row.billing_unit,
    billingQuantity: row.billing_quantity,
    createdByName: row.created_by_name,
  };
}

/**
 * The consolidated booking list. Read-only projection: every filter is applied
 * in SQL so pagination totals are honest.
 */
export function listReservations(db, {
  status = 'all', space = null, category = null, customer = null, q: search = null,
  from = null, to = null, sort = 'start', limit = LIST_PAGE_SIZE, offset = 0,
} = {}) {
  const where = [];
  const params = [];
  if (status && status !== 'all') { where.push('r.status = ?'); params.push(status); }
  if (category) { where.push('s.category = ?'); params.push(category); }
  if (space) {
    if (/^\d+$/.test(String(space))) { where.push('s.id = ?'); params.push(Number(space)); }
    else { where.push('s.code = ? COLLATE NOCASE'); params.push(String(space)); }
  }
  if (customer) {
    if (/^\d+$/.test(String(customer))) { where.push('c.id = ?'); params.push(Number(customer)); }
    else {
      const like = `%${String(customer).replace(/[%_]/g, (m) => `\\${m}`)}%`;
      where.push('(c.full_name LIKE ? COLLATE NOCASE OR c.organization LIKE ? COLLATE NOCASE OR c.email LIKE ? COLLATE NOCASE)');
      params.push(like, like, like);
    }
  }
  if (search) {
    const like = `%${String(search).replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push('(r.reference LIKE ? COLLATE NOCASE OR c.full_name LIKE ? COLLATE NOCASE OR s.name LIKE ? COLLATE NOCASE OR s.code LIKE ? COLLATE NOCASE)');
    params.push(like, like, like, like);
  }
  if (from) { where.push('r.end_at > ?'); params.push(startOfBusinessDay(businessLocalToEpoch(from, '00:00'))); }
  if (to) { where.push('r.start_at < ?'); params.push(businessLocalToEpoch(addDaysToDateKey(to, 1), '00:00')); }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy = {
    start: 'r.start_at ASC, r.id ASC',
    created: 'r.created_at DESC, r.id DESC',
    reference: 'r.reference ASC',
  }[sort] ?? 'r.start_at ASC, r.id ASC';

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM reservation r
      JOIN space s ON s.id = r.space_id
      JOIN customer c ON c.id = r.customer_id
    ${clause}
  `).get(...params).c;

  const rows = db.prepare(`${RESERVATION_LIST_SELECT} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, Math.min(Number(limit) || LIST_PAGE_SIZE, 100), Number(offset) || 0);

  return { total, items: rows.map(mapReservationListRow) };
}

/* --------------------------------------------------------------- price preview */

/**
 * Server-side quote for the form. Returns `null` (never a guess) when the
 * inputs are incomplete or unpriceable, so the form can only ever show a total
 * the server itself would charge.
 */
export function previewQuote(db, space, window, { billingUnit = null, billingQuantity = null, unitCount = 1 } = {}) {
  if (!space || !window || !Number.isFinite(window.startAt) || !Number.isFinite(window.endAt)) return null;
  if (window.endAt <= window.startAt) return null;
  try {
    const rates = loadRates(db, space.id);
    const unit = billingUnit || space.pricingUnit;
    const quantity = billingQuantityFor({
      unit, startAt: window.startAt, endAt: window.endAt, billingQuantityOverride: billingQuantity,
    });
    const priced = quote({
      space, rates, startAt: window.startAt, endAt: window.endAt,
      unitCount: Math.max(1, Number(unitCount) || 1),
      billingUnit, billingQuantityOverride: billingQuantity,
    });
    return { ...priced, rateLabel: formatMoney(priced.rateCents, priced.currency), totalLabel: formatMoney(priced.totalCents, priced.currency), quantity };
  } catch {
    return null;
  }
}

/** The availability + pricing panels rendered inside the booking form. */
export function buildFormPreview(db, space, window, { unitCount = 1, billingUnit = null, billingQuantity = null } = {}) {
  const availability = space && window && window.endAt > window.startAt
    ? getSpaceAvailability(db, {
      spaceId: space.id, startAt: window.startAt, endAt: window.endAt, deskCount: unitCount, includeConflicts: true,
    })
    : null;
  return {
    availability,
    price: previewQuote(db, space, window, { billingUnit, billingQuantity, unitCount }),
  };
}

/* ------------------------------------------------------------- calendar feed */

export function parseCalendarFilters(query = {}) {
  const view = CALENDAR_VIEWS.includes(text(query.view)) ? text(query.view) : 'day';
  const rawDate = text(query.date);
  const category = text(query.category);
  const status = text(query.status);
  return {
    view,
    date: /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : todayBusinessDate(),
    space: text(query.space) || null,
    category: Object.values(SPACE_CATEGORY).includes(category) ? category : null,
    status: CALENDAR_STATUS_FILTERS.includes(status) ? status : 'all',
  };
}

function statusesForFilter(status) {
  if (status === 'all') return [RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.COMPLETED];
  return [status];
}

/**
 * One query for the range's reservations plus one for its maintenance blocks,
 * each with its allocated unit codes, so the HTML projection and the JSON feed
 * are built from exactly the same data.
 */
export function loadCalendarData(db, { fromAt, toAt, spaceIds = null, statuses = null }) {
  const statusList = statuses && statuses.length ? statuses : statusesForFilter('all');
  const where = ['r.start_at < ?', 'r.end_at > ?', `r.status IN (${statusList.map(() => '?').join(',')})`];
  const params = [toAt, fromAt, ...statusList];
  if (spaceIds && spaceIds.length) {
    where.push(`r.space_id IN (${spaceIds.map(() => '?').join(',')})`);
    params.push(...spaceIds);
  }
  const reservations = db.prepare(`
    SELECT r.id, r.reference, r.status, r.start_at, r.end_at, r.unit_count, r.attendees, r.purpose,
           s.id AS space_id, s.code AS space_code, s.name AS space_name, s.category AS space_category,
           c.full_name AS customer_name
      FROM reservation r
      JOIN space s ON s.id = r.space_id
      JOIN customer c ON c.id = r.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.start_at ASC, r.id ASC
  `).all(...params);

  const reservationIds = reservations.map((row) => row.id);
  const unitCodes = groupUnitCodes(db, 'reservation_id', reservationIds);

  const blockWhere = ['m.status = ?', 'm.start_at < ?', 'm.end_at > ?'];
  const blockParams = ['ACTIVE', toAt, fromAt];
  if (spaceIds && spaceIds.length) {
    blockWhere.push(`m.space_id IN (${spaceIds.map(() => '?').join(',')})`);
    blockParams.push(...spaceIds);
  }
  const blocks = db.prepare(`
    SELECT m.id, m.space_id, m.start_at, m.end_at, m.reason, m.status,
           s.code AS space_code, s.name AS space_name, s.category AS space_category
      FROM maintenance_block m
      JOIN space s ON s.id = m.space_id
     WHERE ${blockWhere.join(' AND ')}
     ORDER BY m.start_at ASC, m.id ASC
  `).all(...blockParams);
  const blockUnitCodes = groupUnitCodes(db, 'maintenance_block_id', blocks.map((row) => row.id));

  return {
    reservations: reservations.map((row) => ({
      id: row.id,
      reference: row.reference,
      status: row.status,
      startAt: row.start_at,
      endAt: row.end_at,
      unitCount: row.unit_count,
      attendees: row.attendees,
      purpose: row.purpose,
      spaceId: row.space_id,
      spaceCode: row.space_code,
      spaceName: row.space_name,
      category: row.space_category,
      customerName: row.customer_name,
      unitCodes: unitCodes.get(row.id) ?? [],
      url: `/admin/reservations/${row.id}`,
    })),
    maintenance: blocks.map((row) => ({
      id: row.id,
      startAt: row.start_at,
      endAt: row.end_at,
      reason: row.reason,
      status: row.status,
      spaceId: row.space_id,
      spaceCode: row.space_code,
      spaceName: row.space_name,
      category: row.space_category,
      unitCodes: blockUnitCodes.get(row.id) ?? [],
      url: '/admin/maintenance',
    })),
  };
}

function groupUnitCodes(db, column, ids) {
  const grouped = new Map();
  if (!ids || ids.length === 0) return grouped;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT o.${column} AS owner_id, u.code
      FROM occupancy o
      JOIN resource_unit u ON u.id = o.resource_unit_id
     WHERE o.status = 'ACTIVE' AND o.${column} IN (${placeholders})
     ORDER BY u.code ASC
  `).all(...ids);
  for (const row of rows) {
    if (!grouped.has(row.owner_id)) grouped.set(row.owner_id, []);
    const list = grouped.get(row.owner_id);
    if (!list.includes(row.code)) list.push(row.code);
  }
  return grouped;
}

/** The calendar JSON feed event shape (documented; consumed by admin.js). */
export function calendarEvents(data) {
  return [
    ...data.reservations.map((r) => ({
      id: `reservation:${r.id}`,
      kind: 'RESERVATION',
      reference: r.reference,
      title: `${r.reference} · ${r.spaceCode} · ${r.customerName}`,
      spaceId: r.spaceId,
      spaceCode: r.spaceCode,
      spaceName: r.spaceName,
      category: r.category,
      customerName: r.customerName,
      startAt: r.startAt,
      endAt: r.endAt,
      status: r.status,
      unitCount: r.unitCount,
      unitCodes: r.unitCodes,
      url: r.url,
    })),
    ...data.maintenance.map((m) => ({
      id: `maintenance:${m.id}`,
      kind: 'MAINTENANCE',
      reference: null,
      title: `Maintenance · ${m.spaceCode} · ${m.reason}`,
      spaceId: m.spaceId,
      spaceCode: m.spaceCode,
      spaceName: m.spaceName,
      category: m.category,
      customerName: null,
      startAt: m.startAt,
      endAt: m.endAt,
      status: 'MAINTENANCE',
      unitCount: m.unitCodes.length,
      unitCodes: m.unitCodes,
      url: m.url,
      reason: m.reason,
    })),
  ].sort((a, b) => a.startAt - b.startAt);
}

/** Resolve a calendar `space` filter to a concrete list of space ids. */
export function calendarSpaceIds(db, filters) {
  const all = listSpaces(db, { includeArchived: false, limit: 500, sort: 'name' }).items;
  const filtered = all.filter((space) => {
    if (filters.space) {
      const raw = String(filters.space);
      if (/^\d+$/.test(raw) ? space.id !== Number(raw) : space.code.toUpperCase() !== raw.toUpperCase()) return false;
    }
    if (filters.category && space.category !== filters.category) return false;
    return true;
  });
  return { spaces: filtered, ids: filtered.map((space) => space.id), unknownSpace: Boolean(filters.space) && filtered.length === 0 };
}

/** `from`/`to` for the JSON feed: date keys, ISO strings or epoch milliseconds. */
export function parseCalendarRange(query = {}, now = Date.now()) {
  const resolve = (raw, fallback) => {
    const value = text(raw);
    if (value === '') return fallback;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return businessLocalToEpoch(value, '00:00');
    const epoch = coerceEpochMs(value);
    return epoch === null ? fallback : epoch;
  };
  const fromAt = resolve(query.from, startOfBusinessDay(now));
  const toAt = resolve(query.to, fromAt + 7 * MS.DAY);
  return { fromAt, toAt: toAt > fromAt ? toAt : fromAt + MS.DAY };
}

/* ------------------------------------------------------------- maintenance */

/** Unit codes claimed by each maintenance block, for the list table. */
export function maintenanceUnitCodes(db, ids) {
  const grouped = groupUnitCodes(db, 'maintenance_block_id', ids);
  return grouped;
}

export const _internals = {
  text, parsePositiveInt, resolveSubmittedSpaceId, resolveUnitCount, resolveBillingUnit,
  statusesForFilter, groupUnitCodes, pricingUnitWords, LIST_PAGE_SIZE,
};

/* ================================================================== routes */

export function registerAdminBookingRoutes(router, deps = {}) {
  const db = deps.db;

  const flashRedirect = (ctx, location, flash) => {
    writeFlash(ctx, deps, flash);
    redirect(ctx.res, location, 303);
    ctx.responded = true;
  };

  /* --------------------------------------------------- consolidated list */

  router.get('/admin/reservations', async (ctx) => {
    guard(ctx, deps);
    const filters = parseReservationFilters(ctx.query);
    const { page, pageSize, offset } = asPagination(ctx.query);
    const result = listReservations(db, { ...filters, limit: pageSize, offset });

    ctx.html(renderReservationListPage({
      actor: ctx.actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      reservations: result.items,
      filters,
      spaces: bookableSpaces(db),
      total: result.total,
      page,
      pageSize,
      query: ctx.query,
    }));
  });

  /* -------------------------------------------------------- booking form */

  router.get('/admin/reservations/new', async (ctx) => {
    guard(ctx, deps);
    const values = createFormValuesFromQuery(db, ctx.query);
    const space = resolveSpaceReference(db, values.space_id);
    const window = safeWindow(values);
    const preview = buildFormPreview(db, space, window, {
      unitCount: Math.max(1, Number(values.unit_count) || 1),
      billingUnit: values.billing_unit || null,
      billingQuantity: asInteger(values.billing_quantity, { field: 'billing_quantity', min: 1, fallback: null }),
    });

    ctx.html(renderBookingFormPage({
      actor: ctx.actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      mode: 'create',
      reservation: null,
      spaces: bookableSpaces(db),
      values,
      formToken: newFormToken(),
      customerDisplay: values.customer_display ?? '',
      preview,
      alert: null,
      fieldErrors: null,
      problems: null,
    }));
  });

  router.post('/admin/reservations', async (ctx) => {
    guard(ctx, deps);
    await ctx.readBody();
    requireCsrfGuard(ctx, deps);

    const values = valuesFromBookingBody(ctx.body);
    const space = resolveSpaceReference(db, values.space_id);
    const spaces = bookableSpaces(db, { includeSpaceId: space?.id ?? null });

    let parsed;
    try {
      parsed = parseBookingFormInput(ctx.body, space);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (ctx.wantsJson) throw error;
      reRenderBookingForm(ctx, deps, db, {
        status: error.status, mode: 'create', reservation: null, spaces, values,
        fieldErrors: fieldMapFrom(error.details), problems: problemsFrom(error.details),
        alert: { kind: 'error', title: error.message },
      });
      return;
    }

    let customer;
    try {
      customer = resolveCustomerForBooking(db, { actor: ctx.actor, parsed });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (ctx.wantsJson) throw error;
      reRenderBookingForm(ctx, deps, db, {
        status: error.status, mode: 'create', reservation: null, spaces, values,
        fieldErrors: fieldMapFrom(error.details), problems: problemsFrom(error.details),
        alert: { kind: 'error', title: error.message },
      });
      return;
    }

    let result;
    try {
      result = createReservation(db, {
        actor: ctx.actor,
        spaceId: parsed.spaceId,
        customerId: customer.customerId,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        unitCount: parsed.unitCount,
        attendees: parsed.attendees,
        purpose: parsed.purpose,
        internalNotes: parsed.internalNotes,
        billingUnit: parsed.billingUnit,
        billingQuantity: parsed.billingQuantity,
        idempotencyKey: parsed.idempotencyKey,
        source: 'admin',
      });
    } catch (error) {
      if (ctx.wantsJson) throw error; // app.js emits the JSON error envelope
      if (!(error instanceof AppError)) throw error;
      reRenderBookingForm(ctx, deps, db, {
        status: error.status, mode: 'create', reservation: null, spaces, values,
        fieldErrors: fieldMapFrom(error.details), problems: problemsFrom(error.details),
        conflicts: error instanceof DoubleBookingError ? error.conflicts : null,
        alert: conflictAlert(error, { action: 'create' }),
      });
      return;
    }

    const reservation = result.reservation;
    if (result.idempotent) {
      flashRedirect(ctx, `/admin/reservations/${reservation.id}`, {
        kind: 'warning',
        message: `This form had already been submitted \u2014 no second reservation was created. ${reservation.reference} is the only booking for this submission.`,
      });
      return;
    }
    const fallback = customer.fallback
      ? ` A customer with that email already existed (${customer.fallback.fullName}), so the booking was linked to that existing profile instead of creating a duplicate.`
      : '';
    flashRedirect(ctx, `/admin/reservations/${reservation.id}`, {
      kind: customer.fallback ? 'warning' : 'success',
      message: `Created ${reservation.reference} for ${reservation.customer.fullName} \u00b7 ${reservation.spaceCode} \u00b7 ${formatMoney(reservation.totalCents, reservation.currency)}.${fallback}`,
    });
  });

  /* ------------------------------------------------------- detail / edit */

  router.get('/admin/reservations/:id', async (ctx) => {
    guard(ctx, deps);
    const reservation = loadReservationOrThrow(db, ctx.params.id);
    ctx.html(renderDetail(ctx, db, { reservation }));
  });

  router.get('/admin/reservations/:id/edit', async (ctx) => {
    guard(ctx, deps);
    const reservation = loadReservationOrThrow(db, ctx.params.id);
    if (reservation.status === RESERVATION_STATUS.CANCELLED) {
      flashRedirect(ctx, `/admin/reservations/${reservation.id}`, {
        kind: 'error',
        message: `${reservation.reference} is cancelled. Cancelled reservations cannot be edited \u2014 create a new booking instead.`,
      });
      return;
    }
    const values = valuesFromReservation(reservation);
    const space = resolveSpaceReference(db, values.space_id);
    const window = { startAt: reservation.startAt, endAt: reservation.endAt };

    ctx.html(renderBookingFormPage({
      actor: ctx.actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      mode: 'edit',
      reservation,
      spaces: bookableSpaces(db, { includeSpaceId: reservation.spaceId }),
      values,
      formToken: newFormToken(),
      customerDisplay: reservation.customer.fullName,
      preview: buildFormPreview(db, space, window, {
        unitCount: reservation.unitCount,
        billingUnit: reservation.billingUnit,
        billingQuantity: reservation.billingQuantity,
      }),
      alert: null,
      fieldErrors: null,
      problems: null,
    }));
  });

  router.post('/admin/reservations/:id', async (ctx) => {
    guard(ctx, deps);
    await ctx.readBody();
    requireCsrfGuard(ctx, deps);

    const reservation = loadReservationOrThrow(db, ctx.params.id);
    if (reservation.status === RESERVATION_STATUS.CANCELLED) {
      flashRedirect(ctx, `/admin/reservations/${reservation.id}`, {
        kind: 'error',
        message: `${reservation.reference} is cancelled and cannot be edited.`,
      });
      return;
    }

    const values = valuesFromBookingBody(ctx.body);
    if (!values.space_id) values.space_id = String(reservation.spaceId);
    const space = resolveSpaceReference(db, values.space_id);
    const spaces = bookableSpaces(db, { includeSpaceId: space?.id ?? reservation.spaceId });
    const formContext = { mode: 'edit', reservation, spaces, values };

    let parsed;
    try {
      parsed = parseBookingFormInput(ctx.body, space);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (ctx.wantsJson) throw error;
      reRenderBookingForm(ctx, deps, db, {
        ...formContext, status: error.status,
        fieldErrors: fieldMapFrom(error.details), problems: problemsFrom(error.details),
        alert: { kind: 'error', title: error.message },
      });
      return;
    }

    let customer;
    try {
      customer = resolveCustomerForBooking(db, { actor: ctx.actor, parsed });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (ctx.wantsJson) throw error;
      reRenderBookingForm(ctx, deps, db, {
        ...formContext, status: error.status,
        fieldErrors: fieldMapFrom(error.details), problems: problemsFrom(error.details),
        alert: { kind: 'error', title: error.message },
      });
      return;
    }

    try {
      const updated = updateReservation(db, {
        actor: ctx.actor,
        reservationId: reservation.id,
        patch: {
          spaceId: parsed.spaceId,
          customerId: customer.customerId,
          startAt: parsed.startAt,
          endAt: parsed.endAt,
          unitCount: parsed.unitCount,
          attendees: parsed.attendees,
          purpose: parsed.purpose,
          internalNotes: parsed.internalNotes,
          billingUnit: parsed.billingUnit,
          billingQuantity: parsed.billingQuantity,
        },
      });
      flashRedirect(ctx, `/admin/reservations/${updated.reservation.id}`, {
        kind: 'success',
        message: `Updated ${updated.reservation.reference} \u00b7 ${updated.reservation.unitCodes.length} unit(s) allocated \u00b7 ${formatMoney(updated.reservation.totalCents, updated.reservation.currency)}.`,
      });
    } catch (error) {
      if (ctx.wantsJson) throw error;
      if (!(error instanceof AppError)) throw error;
      // The service rolled the whole transaction back: the stored reservation
      // and its allocations are exactly as they were before this request.
      reRenderBookingForm(ctx, deps, db, {
        ...formContext, status: error.status,
        fieldErrors: fieldMapFrom(error.details), problems: problemsFrom(error.details),
        conflicts: error instanceof DoubleBookingError ? error.conflicts : null,
        alert: conflictAlert(error, { action: 'update', reservation }),
      });
    }
  });

  router.post('/admin/reservations/:id/cancel', async (ctx) => {
    guard(ctx, deps);
    await ctx.readBody();
    requireCsrfGuard(ctx, deps);

    const reservation = loadReservationOrThrow(db, ctx.params.id);
    const reason = text(ctx.body.cancellation_reason);

    try {
      const result = cancelReservation(db, { actor: ctx.actor, reservationId: reservation.id, reason });
      flashRedirect(ctx, `/admin/reservations/${reservation.id}`, {
        kind: 'success',
        message: `Cancelled ${result.reservation.reference}. ${result.releasedOccupancyRows} inventory claim(s) released; the booking history is preserved.`,
      });
    } catch (error) {
      if (ctx.wantsJson) throw error;
      if (!(error instanceof AppError)) throw error;
      const fresh = loadReservation(db, reservation.id) ?? reservation;
      ctx.html(renderReservationDetailPage({
        actor: ctx.actor,
        csrfToken: ctx.csrfToken,
        flash: ctx.flash,
        reservation: fresh,
        customer: safeCustomer(db, fresh.customerId),
        space: getSpace(db, fresh.spaceId),
        audit: listAudit(db, { entityType: 'reservation', entityId: fresh.id }),
        alert: { kind: 'error', title: error.message, note: error.status === 409 ? 'Nothing was changed by that request.' : null },
        fieldErrors: fieldMapFrom(error.details),
        cancelReason: reason,
      }), error.status);
    }
  });

  /* ------------------------------------------------------------- calendar */

  router.get('/admin/calendar', async (ctx) => {
    guard(ctx, deps);
    const filters = parseCalendarFilters(ctx.query);
    const { spaces, unknownSpace } = calendarSpaceIds(db, filters);
    const nav = calendarNav(filters);

    if (filters.view === 'week') {
      const weekStart = startOfWeekKey(filters.date);
      const fromAt = businessLocalToEpoch(weekStart, '00:00');
      const toAt = businessLocalToEpoch(addDaysToDateKey(weekStart, 7), '00:00');
      const data = loadCalendarData(db, {
        fromAt, toAt, spaceIds: spaces.map((space) => space.id), statuses: statusesForFilter(filters.status),
      });
      const days = [];
      for (let index = 0; index < 7; index += 1) {
        const dateKey = addDaysToDateKey(weekStart, index);
        const dayStart = businessLocalToEpoch(dateKey, '00:00');
        const dayEnd = businessLocalToEpoch(addDaysToDateKey(dateKey, 1), '00:00');
        days.push({
          dateKey,
          startAt: dayStart,
          endAt: dayEnd,
          reservations: data.reservations.filter((r) => r.startAt < dayEnd && r.endAt > dayStart),
          maintenance: data.maintenance.filter((m) => m.startAt < dayEnd && m.endAt > dayStart),
        });
      }
      ctx.html(renderCalendarWeekPage({
        actor: ctx.actor, csrfToken: ctx.csrfToken, flash: ctx.flash,
        filters, spaces, days, nav, unknownSpace,
        eventsUrl: '/api/admin/calendar/events',
      }));
      return;
    }

    const dayGrids = spaces.map((space) => ({
      space,
      grid: getSpaceDayGrid(db, { spaceId: space.id, dateKey: filters.date, includeDetails: true }),
    }));
    ctx.html(renderCalendarPage({
      actor: ctx.actor, csrfToken: ctx.csrfToken, flash: ctx.flash,
      filters, spaces, dayGrids, nav, unknownSpace,
      eventsUrl: '/api/admin/calendar/events',
    }));
  });

  /* --------------------------------------------------------- maintenance */

  router.get('/admin/maintenance', async (ctx) => {
    guard(ctx, deps);
    const filters = parseMaintenanceFilters(ctx.query);
    const blocks = maintenanceList(db, filters);
    ctx.html(renderMaintenancePage({
      actor: ctx.actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      blocks,
      filters,
      spaces: bookableSpaces(db),
      spacesWithUnits: maintenanceSpaceOptions(db),
      values: valuesFromQuery(ctx.query),
      formToken: newFormToken(),
      alert: null,
      fieldErrors: null,
      problems: null,
    }));
  });

  router.post('/admin/maintenance', async (ctx) => {
    guard(ctx, deps);
    await ctx.readBody();
    requireCsrfGuard(ctx, deps);

    const values = valuesFromQuery(ctx.body);
    const space = resolveSpaceReference(db, values.space_id);
    const pageContext = {
      spaces: bookableSpaces(db),
      spacesWithUnits: maintenanceSpaceOptions(db),
      filters: parseMaintenanceFilters({}),
    };

    let parsed;
    try {
      parsed = parseMaintenanceFormInput(ctx.body, space);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (ctx.wantsJson) throw error;
      ctx.html(renderMaintenancePage({
        actor: ctx.actor, csrfToken: ctx.csrfToken, flash: ctx.flash,
        blocks: maintenanceList(db, pageContext.filters),
        values, formToken: newFormToken(),
        fieldErrors: fieldMapFrom(error.details), problems: problemsFrom(error.details),
        alert: { kind: 'error', title: error.message },
        ...pageContext,
      }), error.status);
      return;
    }

    try {
      const created = createMaintenanceBlock(db, {
        actor: ctx.actor,
        spaceId: parsed.spaceId,
        startAt: parsed.startAt,
        endAt: parsed.endAt,
        reason: parsed.reason,
        resourceUnitIds: parsed.resourceUnitIds.length ? parsed.resourceUnitIds : null,
        idempotencyKey: values.form_token || null,
      });
      flashRedirect(ctx, '/admin/maintenance', {
        kind: 'success',
        message: `Blocked ${created.units.length} unit(s) on ${space.code} from ${businessTimeLabel(parsed.startAt)}\u2013${businessTimeLabel(parsed.endAt)} on ${businessDateKey(parsed.startAt)}: ${parsed.reason}`,
      });
    } catch (error) {
      if (ctx.wantsJson) throw error;
      if (!(error instanceof AppError)) throw error;
      ctx.html(renderMaintenancePage({
        actor: ctx.actor, csrfToken: ctx.csrfToken, flash: ctx.flash,
        blocks: maintenanceList(db, pageContext.filters),
        values, formToken: newFormToken(),
        fieldErrors: fieldMapFrom(error.details), problems: problemsFrom(error.details),
        conflicts: error instanceof DoubleBookingError ? error.conflicts : null,
        alert: conflictAlert(error, { action: 'maintenance' }),
        ...pageContext,
      }), error.status);
    }
  });

  router.post('/admin/maintenance/:id/cancel', async (ctx) => {
    guard(ctx, deps);
    await ctx.readBody();
    requireCsrfGuard(ctx, deps);

    const id = parsePositiveInt(ctx.params.id);
    if (id === null) throw notFound('Maintenance block not found.');
    try {
      const result = cancelMaintenanceBlock(db, { actor: ctx.actor, maintenanceBlockId: id, reason: text(ctx.body.reason) || null });
      flashRedirect(ctx, '/admin/maintenance', {
        kind: 'success',
        message: `Maintenance block cancelled; ${result.releasedOccupancyRows} inventory claim(s) released.`,
      });
    } catch (error) {
      if (ctx.wantsJson) throw error;
      if (!(error instanceof AppError)) throw error;
      flashRedirect(ctx, '/admin/maintenance', { kind: 'error', message: error.message });
    }
  });

  /* ------------------------------------------------------------ JSON APIs */

  router.get('/api/admin/availability', async (ctx) => {
    guard(ctx, deps);
    const space = resolveSpaceReference(db, q(ctx.query, 'space'));
    if (!space) throw validationError('Provide a valid space id or code.', { field: 'space' });
    const startAt = coerceEpochMs(q(ctx.query, 'start'));
    const endAt = coerceEpochMs(q(ctx.query, 'end'));
    if (startAt === null) throw validationError('Provide a valid ISO 8601 or epoch-millisecond start.', { field: 'start' });
    if (endAt === null) throw validationError('Provide a valid ISO 8601 or epoch-millisecond end.', { field: 'end' });
    if (endAt <= startAt) throw validationError('The end time must be after the start time.', { field: 'end' });
    const desks = asInteger(q(ctx.query, 'desks'), { field: 'desks', min: 1, max: MAX_UNITS_PER_BOOKING, fallback: 1 });

    // Authenticated staff endpoint: full conflict detail is deliberate here.
    ctx.json(getSpaceAvailability(db, {
      spaceId: space.id, startAt, endAt, deskCount: desks, includeConflicts: true,
    }));
  });

  router.get('/api/admin/calendar/events', async (ctx) => {
    guard(ctx, deps);
    const { fromAt, toAt } = parseCalendarRange(ctx.query);
    const filters = parseCalendarFilters(ctx.query);
    const { spaces } = calendarSpaceIds(db, filters);
    const data = loadCalendarData(db, {
      fromAt,
      toAt,
      spaceIds: spaces.map((space) => space.id),
      statuses: statusesForFilter(filters.status),
    });
    ctx.json({ events: calendarEvents(data) });
  });
}

/* ---------------------------------------------------------------- helpers */

/**
 * Queue the one-shot flash message. `deps.setFlash` is provided by `app.js`;
 * the local fallback mirrors the same cookie contract so this module can be
 * registered on a bare router (as the integration tests do).
 */
function writeFlash(ctx, deps, { kind = 'success', message, problems = null }) {
  const payload = { kind, message };
  if (Array.isArray(problems) && problems.length > 0) payload.problems = problems.map(String);
  if (typeof deps.setFlash === 'function') {
    deps.setFlash(ctx, payload);
    return;
  }
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, JSON.stringify(payload), {
    maxAgeSeconds: FLASH_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: 'Lax',
    secure: ctx.secure ?? Boolean(ctx.req?.socket?.encrypted),
  }));
}

function guard(ctx, deps) {
  const requireAuthGuard = typeof deps.requireAuth === 'function' ? deps.requireAuth : requireAuth;
  return requireAuthGuard(ctx);
}

function requireCsrfGuard(ctx, deps) {
  const csrfGuard = typeof deps.requireCsrf === 'function' ? deps.requireCsrf : requireCsrf;
  return csrfGuard(ctx);
}

function loadReservationOrThrow(db, rawId) {
  const id = parsePositiveInt(rawId);
  const reservation = id === null ? null : loadReservation(db, id);
  if (!reservation) throw notFound('Reservation not found.');
  return reservation;
}

function safeCustomer(db, customerId) {
  try {
    return customerId ? getCustomer(db, customerId) : null;
  } catch {
    return null;
  }
}

/** `{ field: message }` when the error carries a field map, else null. */
function fieldMapFrom(details) {
  if (!details || typeof details !== 'object') return null;
  const map = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === 'problems' || key === 'conflicts') continue;
    if (typeof value === 'string') map[key] = value;
  }
  return Object.keys(map).length ? map : null;
}

function problemsFrom(details) {
  return details && Array.isArray(details.problems) && details.problems.length ? details.problems : null;
}

/**
 * The alert shown when a write was refused. For a double booking this is the
 * demonstration surface: the period, who holds it, and - on an edit - an
 * explicit statement that nothing was written.
 */
function conflictAlert(error, { action, reservation = null } = {}) {
  const conflicts = error instanceof DoubleBookingError ? (error.conflicts ?? []) : [];
  const maintenanceOnly = conflicts.length > 0 && conflicts.every((conflict) => conflict.source === OCCUPANCY_SOURCE.MAINTENANCE);
  const title = maintenanceOnly
    ? 'This period is blocked for maintenance'
    : 'This period is already booked';
  const note = action === 'update' && reservation
    ? `The original reservation ${reservation.reference} was left unchanged: the whole change was rolled back, and its period and allocated units are exactly as they were.`
    : action === 'maintenance'
      ? 'No maintenance block was created. Choose a period that is free, or cancel the conflicting booking first.'
      : 'Nothing was created. Change the space, time or desk count and submit again.';
  return {
    kind: 'error',
    title: error instanceof DoubleBookingError ? title : error.message,
    message: error instanceof DoubleBookingError ? error.message : null,
    note,
    conflicts,
  };
}

function reRenderBookingForm(ctx, deps, db, options) {
  const { status, mode, reservation, spaces, values, alert, fieldErrors, problems, conflicts } = options;
  const space = resolveSpaceReference(db, values.space_id);
  const window = safeWindow(values);
  ctx.html(renderBookingFormPage({
    actor: ctx.actor,
    csrfToken: ctx.csrfToken,
    flash: ctx.flash,
    mode,
    reservation,
    spaces,
    values,
    formToken: newFormToken(),
    customerDisplay: values.customer_search ?? '',
    preview: buildFormPreview(db, space, window, {
      unitCount: Math.max(1, Number(values.unit_count) || 1),
      billingUnit: values.billing_unit || null,
      billingQuantity: asInteger(values.billing_quantity, { field: 'billing_quantity', min: 1, fallback: null }),
    }),
    alert: conflicts && conflicts.length ? { ...alert, conflicts } : alert,
    fieldErrors,
    problems,
  }), status);
}

/**
 * Resolve the customer for a booking: an existing profile, an inline new
 * profile (with a duplicate-email fallback that is reported to staff), or a
 * single unambiguous directory match for the no-JavaScript search field.
 */
export function resolveCustomerForBooking(db, { actor, parsed }) {
  if (parsed.customerId) {
    const customer = getCustomer(db, parsed.customerId);
    if (!customer) {
      throw validationError('That customer no longer exists. Search again or create a new profile.', { field: 'customer_id' });
    }
    return { customerId: customer.id, customer, fallback: null };
  }

  if (parsed.newCustomer) {
    try {
      const created = createCustomer(db, { actor, payload: parsed.newCustomer });
      return { customerId: created.id, customer: created, fallback: null };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'CONFLICT') throw error;
      const existing = findCustomerByEmail(db, parsed.newCustomer.email);
      if (!existing) throw error;
      return { customerId: existing.id, customer: existing, fallback: existing };
    }
  }

  if (parsed.customerSearch) {
    const matches = searchCustomers(db, { query: parsed.customerSearch, limit: 2 });
    if (matches.items.length === 1) {
      return { customerId: matches.items[0].id, customer: matches.items[0], fallback: null };
    }
    throw validationError(
      matches.items.length === 0
        ? 'No customer matches that name. Open \u201cNew customer\u201d below and enter their details.'
        : 'Several customers match that name. Pick the right profile from the search results.',
      { field: 'customer_id' },
    );
  }

  throw validationError('Select an existing customer, or complete the new customer details.', { field: 'customer_id' });
}

function findCustomerByEmail(db, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const row = db.prepare('SELECT id FROM customer WHERE email_normalized = ?').get(normalized);
  if (row) return getCustomer(db, row.id);
  const candidates = findPossibleDuplicates(db, { email });
  const exact = candidates.find((entry) => entry.match === 'email');
  return exact ? exact.customer : null;
}

function safeWindow(values) {
  try {
    const window = parseBookingWindow({
      start_at: values.start_at || undefined,
      end_at: values.end_at || undefined,
      date: values.date || undefined,
      start_time: values.start_time || undefined,
      end_time: values.end_time || undefined,
    });
    return { startAt: window.startAt, endAt: window.endAt };
  } catch {
    return null;
  }
}

function renderDetail(ctx, db, { reservation, alert = null, fieldErrors = null, cancelReason = '' }) {
  const space = getSpace(db, reservation.spaceId);
  let currentRateCents = null;
  if (space) {
    try {
      currentRateCents = loadRates(db, space.id).get(reservation.billingUnit) ?? null;
    } catch {
      currentRateCents = null;
    }
  }
  return renderReservationDetailPage({
    actor: ctx.actor,
    csrfToken: ctx.csrfToken,
    flash: ctx.flash,
    reservation,
    customer: safeCustomer(db, reservation.customerId),
    space,
    currentRateCents,
    audit: listAudit(db, { entityType: 'reservation', entityId: reservation.id, limit: 50 }),
    alert,
    fieldErrors,
    cancelReason,
  });
}

/* ------------------------------------------------- prefill + filter states */

function createFormValuesFromQuery(db, query) {
  const values = {
    ...emptyBookingValues(),
    space_id: '',
    date: text(query.date) || '',
    start_time: text(query.start) || '',
    end_time: text(query.end) || '',
    unit_count: text(query.desks) || '',
    customer_id: '',
    customer_search: '',
    customer_display: '',
    inquiry_id: text(query.inquiry) || '',
  };

  const space = resolveSpaceReference(db, query.space);
  if (space) values.space_id = String(space.id);

  const customerId = parsePositiveInt(query.customer);
  if (customerId) {
    const record = safeCustomer(db, customerId);
    if (record) {
      values.customer_id = String(record.id);
      values.customer_search = record.fullName;
      values.customer_display = [record.fullName, record.email, record.organization].filter(Boolean).join(' \u2014 ');
    }
  }

  if (values.inquiry_id) {
    let inquiry = null;
    try {
      inquiry = db.prepare('SELECT * FROM inquiry WHERE id = ?').get(Number(values.inquiry_id));
    } catch {
      inquiry = null;
    }
    if (inquiry) {
      if (!values.space_id && inquiry.space_id) values.space_id = String(inquiry.space_id);
      values.date = values.date || businessDateKey(inquiry.requested_start_at);
      values.start_time = values.start_time || businessTimeLabel(inquiry.requested_start_at);
      values.end_time = values.end_time || businessTimeLabel(inquiry.requested_end_at);
      values.unit_count = values.unit_count || (inquiry.desk_quantity ? String(inquiry.desk_quantity) : '');
      if (!values.customer_id) {
        values.new_customer_name = inquiry.customer_name ?? '';
        values.new_customer_email = inquiry.email ?? '';
        values.new_customer_phone = inquiry.phone ?? '';
        values.new_customer_organization = inquiry.organization ?? '';
        values.customer_search = inquiry.customer_name ?? '';
        values.customer_display = [inquiry.customer_name, inquiry.email, inquiry.organization].filter(Boolean).join(' \u2014 ');
      }
      values.purpose = inquiry.message ? String(inquiry.message).slice(0, 300) : '';
    }
  }
  return values;
}

export function emptyBookingValues() {
  return {
    space_id: '', customer_id: '', customer_search: '', customer_display: '',
    new_customer_name: '', new_customer_email: '', new_customer_phone: '', new_customer_organization: '',
    date: '', start_time: '', end_time: '', start_at: '', end_at: '',
    unit_count: '', attendees: '', purpose: '', internal_notes: '',
    billing_unit: '', billing_quantity: '', inquiry_id: '',
  };
}

function valuesFromQuery(source = {}) {
  return {
    ...emptyBookingValues(),
    space_id: text(source.space_id ?? source.space),
    date: text(source.date),
    start_time: text(source.start_time ?? source.start),
    end_time: text(source.end_time ?? source.end),
    attendees: text(source.attendees),
    reason: text(source.reason),
    unit_ids: (Array.isArray(source.unit_ids) ? source.unit_ids : [source.unit_ids]).filter(Boolean).map(String),
    form_token: text(source.form_token),
  };
}

export function parseMaintenanceFilters(query = {}) {
  const status = text(query.status);
  const fromRaw = text(query.from);
  const toRaw = text(query.to);
  return {
    space: text(query.space) || null,
    status: MAINTENANCE_STATUS_FILTERS.includes(status) ? status : 'all',
    from: /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : null,
    to: /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : null,
  };
}

/** Maintenance blocks + the units each one claims. */
export function maintenanceList(db, filters = {}) {
  const space = resolveSpaceReference(db, filters.space);
  if (filters.space && !space) return [];
  const rows = listMaintenanceBlocks(db, {
    spaceId: space ? space.id : null,
    fromAt: filters.from ? businessLocalToEpoch(filters.from, '00:00') : null,
    toAt: filters.to ? businessLocalToEpoch(addDaysToDateKey(filters.to, 1), '00:00') : null,
    limit: 200,
  });
  const filtered = filters.status && filters.status !== 'all'
    ? rows.filter((row) => row.status === filters.status)
    : rows;
  const codes = maintenanceUnitCodes(db, filtered.map((row) => row.id));
  return filtered.map((row) => ({ ...row, unitCodes: codes.get(row.id) ?? [] }));
}

/** Space -> active units, for the maintenance unit picker. */
export function maintenanceSpaceOptions(db) {
  return bookableSpaces(db).map((space) => {
    let units = [];
    try {
      units = activeUnits(db, space.id).map((unit) => ({ id: unit.id, code: unit.code, label: unit.label }));
    } catch {
      units = [];
    }
    return { spaceId: space.id, code: space.code, units: units.slice(0, 60), truncated: units.length > 60 };
  });
}

function calendarNav(filters) {
  const isWeek = filters.view === 'week';
  const step = isWeek ? 7 : 1;
  const href = (dateKey) => {
    const params = new URLSearchParams();
    params.set('view', filters.view);
    params.set('date', dateKey);
    if (filters.space) params.set('space', filters.space);
    if (filters.category) params.set('category', filters.category);
    if (filters.status && filters.status !== 'all') params.set('status', filters.status);
    return `/admin/calendar?${params.toString()}`;
  };
  return {
    previous: { href: href(addDaysToDateKey(filters.date, -step)), label: isWeek ? '\u2190 Previous week' : '\u2190 Previous day' },
    next: { href: href(addDaysToDateKey(filters.date, step)), label: isWeek ? 'Next week \u2192' : 'Next day \u2192' },
    today: { href: href(todayBusinessDate()), label: 'Today' },
  };
}
