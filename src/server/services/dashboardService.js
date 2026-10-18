/**
 * Dashboard read model.
 *
 * Everything here is derived from live rows at call time. There are no cached
 * or hard-coded metrics: each number is a simple aggregate that can be
 * reproduced with a single SELECT (the integration tests pair every assertion
 * with an independent hand-written count).
 *
 * Business time: all day boundaries are the *business-local* boundaries from
 * domain/time.js (Asia/Colombo). The server process time zone is never
 * consulted, so a booking at 23:00 SLST on day N belongs to day N.
 *
 * Interval semantics: half-open [start, end); two intervals overlap exactly
 * when `a.start < b.end AND a.end > b.start`.
 */
import {
  OCCUPANCY_STATUS, RESERVATION_STATUS, RESERVATION_STATUS_LABEL,
  SPACE_CATEGORY, SPACE_CATEGORY_LABEL, SPACE_STATUS,
  INQUIRY_EMAIL_STATUS, INQUIRY_STATUS,
} from '../domain/constants.js';
import { validationError } from '../domain/errors.js';
import {
  BUSINESS_TZ, MS, businessDateKey, businessLocalToEpoch, parseClock, startOfBusinessDay,
} from '../domain/time.js';
import { listAudit } from './auditService.js';

const HOUR = MS.HOUR;
const DAY = MS.DAY;

/** "Available now" answers for the next hour. */
const AVAILABLE_WINDOW_MS = HOUR;
/** Upper bound on per-space rows returned by a dashboard list. */
const SPACE_LIST_CAP = 100;
const LIST_HARD_CAP = 200;

function clampLimit(value, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, LIST_HARD_CAP);
}

function clockOf(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ------------------------------------------------------------- pure helpers */

/**
 * Hourly buckets for one business-local day between a space's own opening and
 * closing clocks. Each bucket is half-open `[startAt, endAt)`; the final bucket
 * is shortened when the opening hours are not a whole number of hours.
 *
 * Guards:
 *   - malformed clocks -> []
 *   - closeTime <= openTime -> [] (never silently spans midnight; the schema
 *     already rejects such a space configuration)
 *   - the loop can never exceed a 24-hour day
 *
 * @returns {{startAt: number, endAt: number}[]}
 */
export function hourlyBuckets({ dateKey, openTime, closeTime }) {
  let open;
  let close;
  try {
    open = parseClock(openTime);
    close = parseClock(closeTime);
  } catch {
    return [];
  }
  if (!(close > open)) return [];
  const buckets = [];
  const span = close - open;
  for (let offset = 0; offset < span; offset += 60) {
    const startMinutes = open + offset;
    const endMinutes = Math.min(startMinutes + 60, close);
    buckets.push({
      startAt: businessLocalToEpoch(dateKey, clockOf(startMinutes)),
      endAt: businessLocalToEpoch(dateKey, clockOf(endMinutes)),
    });
  }
  return buckets;
}

/**
 * occupied / total as a 0..1 fraction rounded to 3 decimal places.
 * Returns null when there is nothing to measure (total <= 0).
 * Zero occupied units with real inventory is a meaningful 0, not null.
 */
export function occupancyRate(occupied, total) {
  const denominator = Number(total) || 0;
  if (!(denominator > 0)) return null;
  const numerator = Math.max(0, Math.min(denominator, Number(occupied) || 0));
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Pure per-space occupancy summary for the window [windowStart, windowEnd).
 *
 * `spaceRows`     [{ spaceId, code, name, category, status, totalUnits }]
 * `occupancyRows` [{ spaceId, resourceUnitId, startAt, endAt }]
 *
 * A resource unit is occupied when an occupancy row satisfies the half-open
 * overlap rule `startAt < windowEnd AND endAt > windowStart`. Duplicate rows
 * for the same unit count once. Input order is preserved.
 */
export function summariseSpaces(spaceRows, occupancyRows, windowStart, windowEnd) {
  const occupiedUnitsBySpace = new Map();
  for (const row of occupancyRows ?? []) {
    if (!(Number(row.startAt) < windowEnd && Number(row.endAt) > windowStart)) continue;
    let units = occupiedUnitsBySpace.get(row.spaceId);
    if (!units) {
      units = new Set();
      occupiedUnitsBySpace.set(row.spaceId, units);
    }
    units.add(row.resourceUnitId);
  }

  return (spaceRows ?? []).map((space) => {
    const totalUnits = Math.max(0, Number(space.totalUnits) || 0);
    const occupiedUnits = Math.min(totalUnits, occupiedUnitsBySpace.get(space.spaceId)?.size ?? 0);
    return {
      spaceId: space.spaceId,
      code: space.code,
      name: space.name,
      category: space.category,
      status: space.status,
      totalUnits,
      freeUnits: totalUnits - occupiedUnits,
      occupiedUnits,
    };
  });
}

/* ---------------------------------------------------------------- queries */

const SPACE_WITH_UNITS_SELECT = `
  SELECT s.id AS space_id, s.code, s.name, s.category, s.status, s.open_time, s.close_time,
         (SELECT COUNT(*) FROM resource_unit u
           WHERE u.space_id = s.id AND u.is_active = 1) AS total_units
    FROM space s
   WHERE s.status <> '${SPACE_STATUS.ARCHIVED}'
`;

function loadSpaceRows(db) {
  return db.prepare(`${SPACE_WITH_UNITS_SELECT} ORDER BY s.name COLLATE NOCASE ASC, s.id ASC`)
    .all()
    .map((row) => ({
      spaceId: row.space_id,
      code: row.code,
      name: row.name,
      category: row.category,
      status: row.status,
      openTime: row.open_time,
      closeTime: row.close_time,
      totalUnits: Number(row.total_units),
    }));
}

/** ACTIVE occupancy rows on active units of non-archived spaces. */
function loadOccupancyRows(db, startAt, endAt, { spaceId = null } = {}) {
  const params = [endAt, startAt];
  const spaceClause = spaceId === null ? '' : ' AND o.space_id = ?';
  if (spaceId !== null) params.push(Number(spaceId));
  return db.prepare(`
    SELECT o.space_id, o.resource_unit_id, o.start_at, o.end_at
      FROM occupancy o
      JOIN resource_unit u ON u.id = o.resource_unit_id AND u.is_active = 1
      JOIN space s ON s.id = o.space_id AND s.status <> '${SPACE_STATUS.ARCHIVED}'
     WHERE o.status = '${OCCUPANCY_STATUS.ACTIVE}'
       AND o.start_at < ? AND o.end_at > ?
       ${spaceClause}
  `).all(...params).map((row) => ({
    spaceId: row.space_id,
    resourceUnitId: row.resource_unit_id,
    startAt: row.start_at,
    endAt: row.end_at,
  }));
}

/** Inventory totals computed in SQL so they stay exact beyond the list cap. */
function inventoryTotals(db, startAt, endAt) {
  const totalUnits = Number(db.prepare(`
    SELECT COUNT(*) AS c
      FROM resource_unit u
      JOIN space s ON s.id = u.space_id
     WHERE u.is_active = 1
       AND s.status <> '${SPACE_STATUS.ARCHIVED}'
  `).get().c);

  const occupiedUnits = Number(db.prepare(`
    SELECT COUNT(DISTINCT o.resource_unit_id) AS c
      FROM occupancy o
      JOIN resource_unit u ON u.id = o.resource_unit_id AND u.is_active = 1
      JOIN space s ON s.id = o.space_id AND s.status <> '${SPACE_STATUS.ARCHIVED}'
     WHERE o.status = '${OCCUPANCY_STATUS.ACTIVE}'
       AND o.start_at < ? AND o.end_at > ?
  `).get(endAt, startAt).c);

  const occupied = Math.min(totalUnits, occupiedUnits);
  return { totalUnits, occupiedUnits: occupied, freeUnits: Math.max(0, totalUnits - occupied) };
}

const RESERVATION_SUMMARY_SELECT = `
  SELECT r.id, r.reference, r.status, r.space_id, r.customer_id,
         r.start_at, r.end_at, r.unit_count, r.attendees, r.purpose,
         r.total_cents, r.currency, r.cancelled_at, r.cancellation_reason,
         s.code AS space_code, s.name AS space_name, s.category AS space_category,
         c.full_name AS customer_name
    FROM reservation r
    JOIN space s ON s.id = r.space_id
    JOIN customer c ON c.id = r.customer_id
`;

function mapReservationSummary(row) {
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
    startAt: row.start_at,
    endAt: row.end_at,
    unitCount: row.unit_count,
    attendees: row.attendees,
    purpose: row.purpose,
    totalCents: row.total_cents,
    currency: row.currency,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
  };
}

function businessDayWindow(now) {
  const start = businessLocalToEpoch(businessDateKey(now), '00:00');
  return { start, end: start + DAY };
}

/* ---------------------------------------------------------------- metrics */

/**
 * Peak hourly occupancy rate for one business day.
 *
 * For every non-archived space, today is cut into that space's own hourly
 * open hours (`hourlyBuckets`). Buckets that share the same wall-clock hour
 * are pooled: `rate = occupied units / total units of the spaces open then`.
 * The maximum such rate is returned (0..1, rounded to 3 dp), or null when no
 * space has measurable open hours today.
 */
function peakHourlyRate(spaces, occupancyRows, dateKey) {
  const bySpace = new Map();
  for (const row of occupancyRows) {
    let rows = bySpace.get(row.spaceId);
    if (!rows) { rows = []; bySpace.set(row.spaceId, rows); }
    rows.push(row);
  }

  // bucketStart -> { occupied, totalUnits }
  const totalsByBucket = new Map();
  for (const space of spaces) {
    if (space.totalUnits <= 0) continue;
    const buckets = hourlyBuckets({ dateKey, openTime: space.openTime, closeTime: space.closeTime });
    if (buckets.length === 0) continue;
    const rows = bySpace.get(space.spaceId) ?? [];
    for (const bucket of buckets) {
      const occupied = new Set();
      for (const row of rows) {
        if (row.startAt < bucket.endAt && row.endAt > bucket.startAt) occupied.add(row.resourceUnitId);
      }
      const entry = totalsByBucket.get(bucket.startAt) ?? { occupied: 0, totalUnits: 0 };
      entry.occupied += Math.min(space.totalUnits, occupied.size);
      entry.totalUnits += space.totalUnits;
      totalsByBucket.set(bucket.startAt, entry);
    }
  }

  let peak = null;
  for (const bucketStart of [...totalsByBucket.keys()].sort((a, b) => a - b)) {
    const entry = totalsByBucket.get(bucketStart);
    const rate = occupancyRate(entry.occupied, entry.totalUnits);
    if (rate === null) continue;
    peak = peak === null ? rate : Math.max(peak, rate);
  }
  return peak;
}

/* ----------------------------------------------------------- public reads */

/**
 * Today's reservations (all statuses) that touch the business-local day,
 * ordered by start time. A cancelled booking stays visible here because the
 * dashboard must explain why a slot is free again.
 */
export function todaysReservations(db, { now = Date.now() } = {}) {
  const { start, end } = businessDayWindow(now);
  return db.prepare(`${RESERVATION_SUMMARY_SELECT}
     WHERE r.start_at < ? AND r.end_at > ?
     ORDER BY r.start_at ASC, r.id ASC
     LIMIT ?
  `).all(end, start, LIST_HARD_CAP).map(mapReservationSummary);
}

/** Confirmed reservations starting within the next `days` days. */
export function upcomingReservations(db, { now = Date.now(), limit = 10, days = 30 } = {}) {
  const from = Number(now);
  const horizon = from + Math.max(1, Number(days) || 30) * DAY;
  return db.prepare(`${RESERVATION_SUMMARY_SELECT}
     WHERE r.status = '${RESERVATION_STATUS.CONFIRMED}'
       AND r.start_at >= ? AND r.start_at < ?
     ORDER BY r.start_at ASC, r.id ASC
     LIMIT ?
  `).all(from, horizon, clampLimit(limit, 10)).map(mapReservationSummary);
}

/**
 * Per-space availability right now: a unit is free when no ACTIVE occupancy
 * overlaps [now, now + 60 minutes). `occupiedSpaces` counts spaces with at
 * least one occupied unit; `freeSpaces` counts spaces with no occupied units,
 * so the two always sum to `totalSpaces`. The per-space rows carry the unit
 * detail needed to show a partly booked co-working floor.
 */
export function currentOccupancy(db, { now = Date.now() } = {}) {
  const windowStart = Number(now);
  const windowEnd = windowStart + AVAILABLE_WINDOW_MS;
  const spaces = summariseSpaces(
    loadSpaceRows(db),
    loadOccupancyRows(db, windowStart, windowEnd),
    windowStart,
    windowEnd,
  ).slice(0, SPACE_LIST_CAP);

  const occupiedSpaces = spaces.filter((space) => space.occupiedUnits > 0).length;
  return {
    spaces,
    totalSpaces: spaces.length,
    occupiedSpaces,
    freeSpaces: spaces.length - occupiedSpaces,
  };
}

/** Recent activity, newest first (auditService ordering: at DESC, id DESC). */
export function recentChanges(db, { limit = 12 } = {}) {
  return listAudit(db, { limit: clampLimit(limit, 12) });
}

/** Inquiry queue summaries, newest first. */
export function recentInquiries(db, { limit = 8 } = {}) {
  return db.prepare(`
    SELECT i.id, i.reference, i.status, i.email_status,
           i.customer_name, i.email, i.organization,
           i.space_id, i.requested_start_at, i.requested_end_at,
           i.attendees, i.desk_quantity, i.created_at, i.updated_at, i.email_attempted_at,
           s.code AS space_code, s.name AS space_name
      FROM inquiry i
      LEFT JOIN space s ON s.id = i.space_id
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ?
  `).all(clampLimit(limit, 8)).map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    emailStatus: row.email_status,
    customerName: row.customer_name,
    email: row.email,
    organization: row.organization,
    spaceId: row.space_id,
    spaceCode: row.space_code,
    spaceName: row.space_name,
    requestedStartAt: row.requested_start_at,
    requestedEndAt: row.requested_end_at,
    attendees: row.attendees,
    deskQuantity: row.desk_quantity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    emailAttemptedAt: row.email_attempted_at,
  }));
}

/**
 * Utilisation over [fromAt, toAt): booked unit-hours divided by the unit-hours
 * the space was actually open for. Archived spaces are excluded. Ordered by
 * utilisation desc, then name.
 */
export function spaceUtilisation(db, { fromAt = null, toAt = null, limit = 20 } = {}) {
  const now = Date.now();
  const from = fromAt === null || fromAt === undefined ? startOfBusinessDay(now) : Number(fromAt);
  const to = toAt === null || toAt === undefined ? from + 30 * DAY : Number(toAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw validationError('A utilisation window with an end after the start is required.');
  }

  const bookedMsBySpace = new Map();
  const bookedRows = db.prepare(`
    SELECT o.space_id,
           SUM(MAX(0, MIN(o.end_at, ?) - MAX(o.start_at, ?))) AS booked_ms
      FROM occupancy o
      JOIN resource_unit u ON u.id = o.resource_unit_id AND u.is_active = 1
      JOIN space s ON s.id = o.space_id AND s.status <> '${SPACE_STATUS.ARCHIVED}'
     WHERE o.status = '${OCCUPANCY_STATUS.ACTIVE}'
       AND o.start_at < ? AND o.end_at > ?
     GROUP BY o.space_id
  `).all(to, from, to, from);
  for (const row of bookedRows) {
    bookedMsBySpace.set(row.space_id, Number(row.booked_ms) || 0);
  }

  const items = loadSpaceRows(db).map((space) => {
    const openHours = openHoursInWindow(space, from, to);
    const bookableUnitHours = space.totalUnits * openHours;
    const bookedUnitHours = Math.round(((bookedMsBySpace.get(space.spaceId) ?? 0) / HOUR) * 100) / 100;
    return {
      spaceId: space.spaceId,
      code: space.code,
      name: space.name,
      category: space.category,
      status: space.status,
      totalUnits: space.totalUnits,
      openHours: Math.round(openHours * 100) / 100,
      bookedUnitHours,
      bookableUnitHours: Math.round(bookableUnitHours * 100) / 100,
      utilisationRate: occupancyRate(bookedUnitHours, bookableUnitHours),
    };
  });

  items.sort((a, b) => {
    const ra = a.utilisationRate ?? 0;
    const rb = b.utilisationRate ?? 0;
    if (rb !== ra) return rb - ra;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.spaceId - b.spaceId;
  });
  return items.slice(0, clampLimit(limit, 20));
}

/** Total open hours a space contributes inside [fromAt, toAt). */
function openHoursInWindow(space, fromAt, toAt) {
  let minutes = 0;
  for (let cursor = startOfBusinessDay(fromAt); cursor < toAt; cursor += DAY) {
    const dateKey = businessDateKey(cursor);
    let open;
    let close;
    try {
      open = businessLocalToEpoch(dateKey, space.openTime);
      close = businessLocalToEpoch(dateKey, space.closeTime);
    } catch {
      continue;
    }
    const overlap = Math.min(toAt, close) - Math.max(fromAt, open);
    if (overlap > 0) minutes += overlap / MS.MINUTE;
  }
  return minutes / 60;
}

/**
 * Dropdown options for the reservation list filters. `spaces` includes
 * archived spaces because historical bookings still point at them; each entry
 * carries its status so views can label it. Capped at 500 rows.
 */
export function bookingFilterOptions(db) {
  const spaces = db.prepare(`
    SELECT s.id, s.code, s.name, s.category, s.status
      FROM space s
     ORDER BY s.name COLLATE NOCASE ASC, s.id ASC
     LIMIT 500
  `).all().map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    status: row.status,
  }));

  return {
    spaces,
    categories: Object.entries(SPACE_CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
    statuses: Object.entries(RESERVATION_STATUS_LABEL).map(([value, label]) => ({ value, label })),
  };
}

/**
 * The dashboard payload. Every field is measured at `now`; `businessDate` is
 * the business-local calendar day.
 */
export function dashboardSummary(db, { now = Date.now(), timeZone = BUSINESS_TZ } = {}) {
  if (timeZone !== BUSINESS_TZ) {
    throw validationError(
      `Dashboard calculations are pinned to the business time zone (${BUSINESS_TZ}).`,
      { field: 'timeZone' },
    );
  }

  const generatedAt = Number(now);
  const businessDate = businessDateKey(generatedAt);
  const day = businessDayWindow(generatedAt);

  /* spaces by status */
  const statusCounts = { DRAFT: 0, PUBLISHED: 0, ARCHIVED: 0 };
  for (const row of db.prepare('SELECT status, COUNT(*) AS c FROM space GROUP BY status').all()) {
    statusCounts[row.status] = Number(row.c);
  }
  const activeSpaces = {
    total: statusCounts.DRAFT + statusCounts.PUBLISHED,
    published: statusCounts.PUBLISHED,
    draft: statusCounts.DRAFT,
    archived: statusCounts.ARCHIVED,
  };

  /* availability in the next hour */
  const availableWindowEnd = generatedAt + AVAILABLE_WINDOW_MS;
  const spaceRows = loadSpaceRows(db);
  const availabilityRows = summariseSpaces(
    spaceRows,
    loadOccupancyRows(db, generatedAt, availableWindowEnd),
    generatedAt,
    availableWindowEnd,
  );
  const inventory = inventoryTotals(db, generatedAt, availableWindowEnd);
  const availableNow = {
    total: inventory.totalUnits,
    free: inventory.freeUnits,
    occupied: inventory.occupiedUnits,
    spaces: availabilityRows.slice(0, SPACE_LIST_CAP),
  };

  /* today, in business-local boundaries */
  const todayRow = db.prepare(`
    SELECT
      SUM(CASE WHEN r.status <> '${RESERVATION_STATUS.CANCELLED}' THEN 1 ELSE 0 END) AS bookings,
      COALESCE(SUM(CASE WHEN r.status <> '${RESERVATION_STATUS.CANCELLED}' THEN r.attendees ELSE 0 END), 0) AS attendees,
      COALESCE(SUM(CASE WHEN r.status <> '${RESERVATION_STATUS.CANCELLED}'
                         AND s.category = '${SPACE_CATEGORY.COWORKING}'
                        THEN r.unit_count ELSE 0 END), 0) AS desk_days,
      SUM(CASE WHEN r.status = '${RESERVATION_STATUS.CONFIRMED}' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN r.status = '${RESERVATION_STATUS.CANCELLED}' THEN 1 ELSE 0 END) AS cancelled
    FROM reservation r
    JOIN space s ON s.id = r.space_id
    WHERE r.start_at < ? AND r.end_at > ?
  `).get(day.end, day.start);
  const today = {
    bookings: Number(todayRow.bookings) || 0,
    attendees: Number(todayRow.attendees) || 0,
    deskDays: Number(todayRow.desk_days) || 0,
    cancelled: Number(todayRow.cancelled) || 0,
    confirmed: Number(todayRow.confirmed) || 0,
  };

  /* upcoming confirmed bookings */
  const sevenDayHorizon = generatedAt + 7 * DAY;
  const thirtyDayHorizon = generatedAt + 30 * DAY;
  const upcomingRow = db.prepare(`
    SELECT
      SUM(CASE WHEN r.start_at < ? THEN 1 ELSE 0 END) AS next7,
      SUM(CASE WHEN r.start_at < ? THEN 1 ELSE 0 END) AS next30
    FROM reservation r
    WHERE r.status = '${RESERVATION_STATUS.CONFIRMED}'
      AND r.start_at >= ? AND r.start_at < ?
  `).get(sevenDayHorizon, thirtyDayHorizon, generatedAt, thirtyDayHorizon);
  const upcoming = {
    next7Days: Number(upcomingRow.next7) || 0,
    next30Days: Number(upcomingRow.next30) || 0,
  };

  /* occupancy */
  const occupancy = {
    currentRate: occupancyRate(availableNow.occupied, availableNow.total),
    todayPeakRate: peakHourlyRate(
      spaceRows,
      loadOccupancyRows(db, day.start, day.end),
      businessDate,
    ),
  };

  /* inquiries */
  const inquiryRow = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = '${INQUIRY_STATUS.NEW}' THEN 1 ELSE 0 END) AS new_count,
           SUM(CASE WHEN email_status IN ('${INQUIRY_EMAIL_STATUS.FAILED}', '${INQUIRY_EMAIL_STATUS.NOT_CONFIGURED}')
                     AND status NOT IN ('${INQUIRY_STATUS.CLOSED}', '${INQUIRY_STATUS.WITHDRAWN}')
                    THEN 1 ELSE 0 END) AS awaiting_email
      FROM inquiry
  `).get();
  const inquiries = {
    new: Number(inquiryRow.new_count) || 0,
    total: Number(inquiryRow.total) || 0,
    awaitingEmailDelivery: Number(inquiryRow.awaiting_email) || 0,
  };

  /* maintenance */
  const maintenanceRow = db.prepare(`
    SELECT
      SUM(CASE WHEN start_at <= ? AND end_at > ? THEN 1 ELSE 0 END) AS active_now,
      SUM(CASE WHEN start_at > ? THEN 1 ELSE 0 END) AS upcoming
    FROM maintenance_block
    WHERE status = 'ACTIVE'
  `).get(generatedAt, generatedAt, generatedAt);
  const maintenance = {
    activeNow: Number(maintenanceRow.active_now) || 0,
    upcoming: Number(maintenanceRow.upcoming) || 0,
  };

  return {
    generatedAt,
    businessDate,
    activeSpaces,
    availableNow,
    today,
    upcoming,
    occupancy,
    inquiries,
    maintenance,
    recentChanges: recentChanges(db, { limit: 12 }),
    recentInquiries: recentInquiries(db, { limit: 8 }),
  };
}
