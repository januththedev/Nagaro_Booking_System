/**
 * Availability engine.
 *
 * Every availability question in the application resolves to the same rule:
 *
 *   Two half-open intervals [aStart, aEnd) and [bStart, bEnd) conflict
 *   exactly when  aStart < bEnd  AND  aEnd > bStart.
 *
 * Consequences that the rest of the system relies on:
 *   - a booking ending at 11:00 does NOT conflict with one starting at 11:00
 *   - maintenance blocks consume inventory over their exact interval
 *   - released occupancy (cancelled reservations) never conflicts
 *
 * A per-space `buffer_minutes` widens the *requested* interval symmetrically
 * when comparing against reservation occupancy, so two reservations always
 * keep the configured turnover gap. Maintenance is compared exactly.
 */
import {
  OCCUPANCY_STATUS, OCCUPANCY_SOURCE, RESOURCE_KIND, SPACE_CATEGORY, SPACE_STATUS,
} from '../domain/constants.js';
import { DoubleBookingError, notFound, validationError, conflict } from '../domain/errors.js';
import { parseClock, businessDateKey, startOfBusinessDay, businessLocalToEpoch, inflate } from '../domain/time.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

/* ------------------------------------------------------------------ queries */

/**
 * All ACTIVE occupancy rows on a space that conflict with the requested
 * interval. `bufferMinutes` is applied to the requested interval only, and
 * only against reservation-sourced occupancy.
 */
export function findConflicts(db, {
  spaceId,
  resourceUnitId = null,
  startAt,
  endAt,
  bufferMinutes = 0,
  excludeReservationId = null,
  includeReleased = false,
} = {}) {
  const window = inflate(startAt, endAt, bufferMinutes);
  const clauses = ['o.space_id = ?'];
  const params = [spaceId];

  if (!includeReleased) clauses.push(`o.status = '${OCCUPANCY_STATUS.ACTIVE}'`);
  if (resourceUnitId) { clauses.push('o.resource_unit_id = ?'); params.push(resourceUnitId); }
  if (excludeReservationId) {
    clauses.push('(o.reservation_id IS NULL OR o.reservation_id <> ?)');
    params.push(excludeReservationId);
  }

  clauses.push(`(
      (o.source = '${OCCUPANCY_SOURCE.MAINTENANCE}' AND bh.id IS NULL AND o.start_at < ? AND o.end_at > ?)
   OR ((o.source = '${OCCUPANCY_SOURCE.RESERVATION}' OR bh.id IS NOT NULL) AND o.start_at < ? AND o.end_at > ?)
  )`);
  params.push(endAt, startAt, window.end, window.start);

  return db.prepare(`
    SELECT o.id, o.resource_unit_id, o.space_id, o.start_at, o.end_at, o.status,
           CASE WHEN bh.id IS NOT NULL THEN 'HOLD' ELSE o.source END AS source,
           o.reservation_id, o.maintenance_block_id,
           COALESCE(r.reference, br.reference) AS reservation_reference,
           COALESCE(r.status, br.status) AS reservation_status,
           r.purpose AS reservation_purpose, r.unit_count AS reservation_unit_count,
           c.full_name AS customer_name,
           m.reason AS maintenance_reason,
           u.code AS unit_code, u.label AS unit_label
      FROM occupancy o
      LEFT JOIN reservation r ON r.id = o.reservation_id
      LEFT JOIN customer    c ON c.id = r.customer_id
      LEFT JOIN maintenance_block m ON m.id = o.maintenance_block_id
      LEFT JOIN booking_hold_claim bh ON bh.occupancy_id = o.id AND bh.status = 'ACTIVE'
      LEFT JOIN booking_request br ON br.id = bh.booking_request_id
      LEFT JOIN resource_unit u ON u.id = o.resource_unit_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY o.start_at ASC
  `).all(...params).map(mapConflictRow);
}

export function mapConflictRow(row) {
  return {
    occupancyId: row.id,
    resourceUnitId: row.resource_unit_id,
    unitCode: row.unit_code,
    unitLabel: row.unit_label,
    spaceId: row.space_id,
    startAt: row.start_at,
    endAt: row.end_at,
    source: row.source,
    status: row.status,
    reservationId: row.reservation_id,
    reservationReference: row.reservation_reference,
    reservationStatus: row.reservation_status,
    customerName: row.customer_name,
    maintenanceBlockId: row.maintenance_block_id,
    maintenanceReason: row.maintenance_reason,
    label: row.source === 'HOLD'
      ? 'Temporarily held for an approved request'
      : row.source === OCCUPANCY_SOURCE.MAINTENANCE
      ? `Maintenance block${row.maintenance_reason ? `: ${row.maintenance_reason}` : ''}`
      : `Reservation ${row.reservation_reference ?? ''}${row.customer_name ? ` (${row.customer_name})` : ''}`.trim(),
  };
}

export function activeUnits(db, spaceId) {
  return db.prepare(
    'SELECT * FROM resource_unit WHERE space_id = ? AND is_active = 1 ORDER BY code ASC',
  ).all(spaceId);
}

/**
 * Which of `unitIds` are free for [startAt, endAt) on this space?
 * Returns the free subset and the blocking rows.
 */
export function inspectUnits(db, {
  spaceId, unitIds, startAt, endAt, bufferMinutes = 0, excludeReservationId = null,
}) {
  if (unitIds.length === 0) return { freeUnitIds: [], conflicts: [] };
  const window = inflate(startAt, endAt, bufferMinutes);
  const clauses = [
    'o.space_id = ?',
    `o.status = '${OCCUPANCY_STATUS.ACTIVE}'`,
    `o.resource_unit_id IN (${placeholders(unitIds.length)})`,
  ];
  const params = [spaceId, ...unitIds];
  if (excludeReservationId) {
    clauses.push('(o.reservation_id IS NULL OR o.reservation_id <> ?)');
    params.push(excludeReservationId);
  }
  clauses.push(`(
      (o.source = '${OCCUPANCY_SOURCE.MAINTENANCE}' AND bh.id IS NULL AND o.start_at < ? AND o.end_at > ?)
   OR ((o.source = '${OCCUPANCY_SOURCE.RESERVATION}' OR bh.id IS NOT NULL) AND o.start_at < ? AND o.end_at > ?)
  )`);
  params.push(endAt, startAt, window.end, window.start);

  const rows = db.prepare(`
    SELECT o.id, o.resource_unit_id, o.start_at, o.end_at,
           CASE WHEN bh.id IS NOT NULL THEN 'HOLD' ELSE o.source END AS source,
           o.reservation_id,
           o.maintenance_block_id,
           COALESCE(r.reference, br.reference) AS reservation_reference,
           COALESCE(r.status, br.status) AS reservation_status,
           c.full_name AS customer_name,
           m.reason AS maintenance_reason,
           u.code AS unit_code, u.label AS unit_label
      FROM occupancy o
      LEFT JOIN reservation r ON r.id = o.reservation_id
      LEFT JOIN customer    c ON c.id = r.customer_id
      LEFT JOIN maintenance_block m ON m.id = o.maintenance_block_id
      LEFT JOIN booking_hold_claim bh ON bh.occupancy_id = o.id AND bh.status = 'ACTIVE'
      LEFT JOIN booking_request br ON br.id = bh.booking_request_id
      LEFT JOIN resource_unit u ON u.id = o.resource_unit_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY o.start_at ASC
  `).all(...params).map(mapConflictRow);

  const busy = new Set(rows.map((r) => r.resourceUnitId));
  return {
    freeUnitIds: unitIds.filter((id) => !busy.has(id)),
    conflicts: rows,
  };
}

/**
 * Choose `requiredCount` free units deterministically.
 *
 * Ordering preference:
 *   1. units this reservation already holds (keeps edits stable)
 *   2. units with the fewest existing ACTIVE rows (spreads wear/usage evenly)
 *   3. unit code, so the result is reproducible
 *
 * Throws DoubleBookingError when fewer than `requiredCount` units are free.
 */
export function allocateUnits(db, {
  spaceId, startAt, endAt, requiredCount, bufferMinutes = 0,
  excludeReservationId = null, preferredUnitIds = [],
}) {
  const units = activeUnits(db, spaceId);
  if (units.length === 0) {
    throw conflict('This space has no active bookable inventory configured.');
  }
  const allIds = units.map((u) => u.id);
  const { freeUnitIds, conflicts } = inspectUnits(db, {
    spaceId, unitIds: allIds, startAt, endAt, bufferMinutes, excludeReservationId,
  });
  const free = new Set(freeUnitIds);
  const preferred = new Set(preferredUnitIds);

  const loadRows = db.prepare(`
    SELECT resource_unit_id, COUNT(*) AS active_count
      FROM occupancy WHERE space_id = ? AND status = 'ACTIVE'
     GROUP BY resource_unit_id
  `).all(spaceId);
  const load = new Map(loadRows.map((r) => [r.resource_unit_id, r.active_count]));

  const ordered = units
    .filter((u) => free.has(u.id))
    .sort((a, b) => {
      const pa = preferred.has(a.id) ? 0 : 1;
      const pb = preferred.has(b.id) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const la = load.get(a.id) ?? 0;
      const lb = load.get(b.id) ?? 0;
      if (la !== lb) return la - lb;
      return a.code.localeCompare(b.code);
    });

  if (ordered.length < requiredCount) {
    throw new DoubleBookingError(
      buildAllocationMessage(requiredCount, ordered.length, units.length, conflicts),
      conflicts,
    );
  }
  return { units: ordered.slice(0, requiredCount), conflicts, totalUnits: units.length, freeCount: ordered.length };
}

function buildAllocationMessage(required, available, total, conflicts) {
  const maintenance = conflicts.filter((c) => c.source === OCCUPANCY_SOURCE.MAINTENANCE);
  if (available === 0 && maintenance.length > 0 && conflicts.length === maintenance.length) {
    return 'This period is blocked for maintenance.';
  }
  if (total === 1) {
    const refs = conflicts.map((c) => c.reservationReference).filter(Boolean);
    return refs.length
      ? `This space is already booked for the requested period (${refs.join(', ')}).`
      : 'This space is already booked for the requested period.';
  }
  return `Only ${available} of ${required} required desks are free for the requested period.`;
}

/* ------------------------------------------------- availability computation */

/**
 * Provisional availability for one space over an interval.
 *
 * IMPORTANT: this is a *read-only preview*. It is never the authority.
 * createReservation()/updateReservation() re-check availability inside the
 * write transaction that commits the booking.
 */
export function getSpaceAvailability(db, { spaceId, startAt, endAt, deskCount = 1, includeConflicts = true }) {
  const space = db.prepare('SELECT * FROM space WHERE id = ?').get(spaceId);
  if (!space) throw notFound('Space not found.');

  const units = activeUnits(db, spaceId);
  const isPooled = space.category === SPACE_CATEGORY.COWORKING;
  const bufferMinutes = space.buffer_minutes ?? 0;

  const requested = isPooled ? Math.max(1, deskCount) : 1;
  const { freeUnitIds, conflicts } = inspectUnits(db, {
    spaceId, unitIds: units.map((u) => u.id), startAt, endAt, bufferMinutes,
  });

  const totalUnits = units.length;
  const freeCount = freeUnitIds.length;
  const canFulfil = freeCount >= requested;

  return {
    spaceId,
    spaceCode: space.code,
    spaceName: space.name,
    category: space.category,
    startAt,
    endAt,
    isPooled,
    bufferMinutes,
    totalUnits,
    freeUnits: freeCount,
    bookedUnits: totalUnits - freeCount,
    requestedUnits: requested,
    canFulfil,
    isAvailable: canFulfil,
    conflicts: includeConflicts ? conflicts : conflicts.map((c) => ({ ...c, customerName: undefined })),
    checkedAt: Date.now(),
    provisional: true,
  };
}

/**
 * Public availability answer with no customer-identifying data. Used by the
 * visitor-facing availability endpoint.
 */
export function getPublicAvailability(db, { spaceId, startAt, endAt, deskCount = 1 }) {
  const space = db.prepare('SELECT * FROM space WHERE id = ?').get(spaceId);
  if (!space) throw notFound('Space not found.');
  if (space.status !== SPACE_STATUS.PUBLISHED) {
    throw notFound('Space not found.');
  }
  const availability = getSpaceAvailability(db, { spaceId, startAt, endAt, deskCount });
  return {
    spaceId: availability.spaceId,
    spaceCode: availability.spaceCode,
    spaceName: availability.spaceName,
    category: availability.category,
    startAt: availability.startAt,
    endAt: availability.endAt,
    isPooled: availability.isPooled,
    totalUnits: availability.totalUnits,
    freeUnits: availability.freeUnits,
    requestedUnits: availability.requestedUnits,
    isAvailable: availability.isAvailable,
    label: availabilityLabel(availability),
    checkedAt: availability.checkedAt,
    provisional: true,
    // Privacy: never expose customer names, references, or internal notes.
    blockedPeriods: availability.conflicts.map((c) => ({
      startAt: c.startAt,
      endAt: c.endAt,
      kind: c.source === OCCUPANCY_SOURCE.MAINTENANCE ? 'MAINTENANCE' : 'BOOKED',
    })),
  };
}

export function availabilityLabel(availability) {
  if (availability.isAvailable) {
    if (availability.isPooled) {
      return `${availability.freeUnits} of ${availability.totalUnits} desh free`.replace('desh', 'desks');
    }
    return 'Available';
  }
  if (availability.freeUnits === 0) return 'Fully booked';
  return `Only ${availability.freeUnits} of ${availability.requestedUnits} requested desks free`;
}

/**
 * Hour-by-hour occupancy grid for one business day, used by the admin
 * calendar and by the public "is it free that day" panel.
 */
export function getSpaceDayGrid(db, { spaceId, dateKey, includeDetails = true }) {
  const space = db.prepare('SELECT * FROM space WHERE id = ?').get(spaceId);
  if (!space) throw notFound('Space not found.');

  const dayStart = businessLocalToEpoch(dateKey, '00:00');
  const dayEnd = dayStart + DAY_MS;
  const units = activeUnits(db, spaceId);
  const openMinutes = parseClock(space.open_time);
  const closeMinutes = parseClock(space.close_time);

  const rows = units.length === 0 ? [] : db.prepare(`
    SELECT o.id, o.resource_unit_id, o.start_at, o.end_at,
           CASE WHEN bh.id IS NOT NULL THEN 'HOLD' ELSE o.source END AS source,
           o.reservation_id,
           o.maintenance_block_id,
           COALESCE(r.reference, br.reference) AS reservation_reference,
           COALESCE(r.status, br.status) AS reservation_status,
           r.attendees, r.purpose, r.unit_count,
           c.full_name AS customer_name,
           m.reason AS maintenance_reason,
           u.code AS unit_code, u.label AS unit_label
      FROM occupancy o
      LEFT JOIN reservation r ON r.id = o.reservation_id
      LEFT JOIN customer    c ON c.id = r.customer_id
      LEFT JOIN maintenance_block m ON m.id = o.maintenance_block_id
      LEFT JOIN booking_hold_claim bh ON bh.occupancy_id=o.id AND bh.status='ACTIVE'
      LEFT JOIN booking_request br ON br.id=bh.booking_request_id
      LEFT JOIN resource_unit u ON u.id = o.resource_unit_id
     WHERE o.space_id = ?
       AND o.status = '${OCCUPANCY_STATUS.ACTIVE}'
       AND o.start_at < ? AND o.end_at > ?
     ORDER BY o.start_at ASC
  `).all(spaceId, dayEnd, dayStart);

  const slots = [];
  for (let m = openMinutes; m < closeMinutes; m += 60) {
    const slotStart = businessLocalToEpoch(dateKey, minutesToClock(m));
    const slotEnd = Math.min(businessLocalToEpoch(dateKey, minutesToClock(Math.min(m + 60, closeMinutes))), dayEnd);
    const overlapping = rows.filter((r) => r.start_at < slotEnd && r.end_at > slotStart);
    const busyUnitIds = new Set(overlapping.filter((r) => r.source === OCCUPANCY_SOURCE.RESERVATION || r.source === OCCUPANCY_SOURCE.MAINTENANCE || r.source === 'HOLD').map((r) => r.resource_unit_id));
    slots.push({
      startAt: slotStart,
      endAt: slotEnd,
      freeUnits: Math.max(0, units.length - busyUnitIds.size),
      totalUnits: units.length,
      isFree: busyUnitIds.size < units.length,
      occupancy: includeDetails ? overlapping.map(mapGridRow) : [],
    });
  }

  return {
    spaceId,
    dateKey,
    openTime: space.open_time,
    closeTime: space.close_time,
    totalUnits: units.length,
    bufferMinutes: space.buffer_minutes ?? 0,
    slots,
    allDayBlocks: includeDetails ? rows.map(mapGridRow) : [],
  };
}

function minutesToClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function mapGridRow(r) {
  return {
    occupancyId: r.id,
    resourceUnitId: r.resource_unit_id,
    unitCode: r.unit_code,
    unitLabel: r.unit_label,
    startAt: r.start_at,
    endAt: r.end_at,
    source: r.source,
    reservationId: r.reservation_id,
    reference: r.reservation_reference,
    reservationStatus: r.reservation_status,
    customerName: r.customer_name,
    attendees: r.attendees,
    purpose: r.purpose,
    unitCount: r.unit_count,
    maintenanceReason: r.maintenance_reason,
  };
}

/* ------------------------------------------------------- opening hours rules */

/**
 * Opening-hours, duration and advance-notice validation for a requested
 * booking window. Returns a list of human-readable violations (empty = OK).
 */
export function checkBookingRules(space, { startAt, endAt, attendees = null }) {
  const problems = [];
  const durationMinutes = Math.round((endAt - startAt) / 60000);

  if (durationMinutes <= 0) {
    problems.push('The end time must be after the start time.');
    return problems;
  }
  if (durationMinutes < space.min_duration_minutes) {
    problems.push(`Minimum booking duration for this space is ${formatMinutes(space.min_duration_minutes)}.`);
  }
  if (space.max_duration_minutes && durationMinutes > space.max_duration_minutes) {
    problems.push(`Maximum booking duration for this space is ${formatMinutes(space.max_duration_minutes)}.`);
  }
  if (attendees !== null && attendees !== undefined && Number(attendees) > space.capacity) {
    problems.push(`Attendee count ${attendees} exceeds this space's capacity of ${space.capacity}.`);
  }

  const openMinutes = parseClock(space.open_time);
  const closeMinutes = parseClock(space.close_time);

  // Walk each business day the interval touches and require every covered
  // minute to sit inside that day's opening hours. Multi-day desk rentals work
  // because each iteration advances to the next day's opening, and a booking
  // that spills into a closed gap (a night, or before opening) is refused.
  //
  // A close time of 23:59 is the catalogue's way of saying "open until
  // midnight" (the seed and the co-working form both use it), so that single
  // minute is extended to the next local midnight instead of being treated as
  // a hard stop with a one-minute nightly closure.
  const closesAtMidnight = closeMinutes >= 23 * 60 + 59;
  let cursor = startAt;
  let guard = 0;
  while (cursor < endAt && guard < 400) {
    guard += 1;
    const dateKey = businessDateKey(cursor);
    const dayOpen = businessLocalToEpoch(dateKey, space.open_time);
    const dayClose = closesAtMidnight
      ? startOfBusinessDay(cursor) + DAY_MS
      : businessLocalToEpoch(dateKey, space.close_time);

    if (dayClose <= dayOpen) {
      problems.push('This space has an invalid opening-hours configuration.');
      break;
    }
    if (cursor < dayOpen) {
      // The requested interval starts (or resumes) before the space opens.
      problems.push(outsideOpeningHours(space, cursor, dateKey));
      break;
    }
    if (cursor < dayClose) {
      cursor = Math.min(dayClose, endAt);
      continue;
    }
    // The cursor sits in the closed gap between this day's close and the next
    // day's opening, and the requested interval extends into it.
    problems.push(outsideOpeningHours(space, cursor, dateKey));
    break;
  }

  if (openMinutes >= closeMinutes) problems.push('This space has an invalid opening-hours configuration.');
  return problems;
}

function outsideOpeningHours(space, epochMs, dateKey) {
  return `This space is available ${space.open_time}-${space.close_time} (Sri Lanka Standard Time). Requested time ${clockOf(epochMs)} falls outside opening hours on ${dateKey}.`;
}

function clockOf(epochMs) {
  const parts = businessDateKey(epochMs);
  const dayStart = businessLocalToEpoch(parts, '00:00');
  const mins = Math.round((epochMs - dayStart) / 60000);
  return minutesToClock(mins);
}

function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Convenience guard used by services: throws validationError listing problems. */
export function assertBookingRules(space, window, attendees) {
  const problems = checkBookingRules(space, { ...window, attendees });
  if (problems.length) {
    throw validationError(problems[0], { problems });
  }
  return true;
}

export const _internals = { placeholders, minutesToClock, buildAllocationMessage, startOfBusinessDay };
