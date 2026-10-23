/**
 * Public multi-day availability calendar.
 *
 * This is the visitor-facing view of the same inventory `getSpaceDayGrid()`
 * renders for one space and one day. The difference is scope: a caller may ask
 * for a short date range and (optionally) one space, so this module reads all
 * published spaces, their active resource units and every conflicting
 * occupancy row for the range in a small, fixed number of queries.
 *
 * Privacy boundary
 * ----------------
 * The result is built from an explicit allowlist. Nothing in this module reads
 * a customer row, a reservation reference, a purpose, a payment record or a
 * maintenance reason. Occupancy rows are reduced to "this unit is busy for
 * this interval" before they reach a slot; only counts and instants leave the
 * service. The return shape is exactly the public contract:
 *
 *   { from, to, timezone, spaces[], days[] }
 *
 * Availability is live but provisional. Checkout re-checks the inventory in
 * the booking transaction, so a slot shown here is never a held reservation.
 */
import {
  OCCUPANCY_SOURCE, OCCUPANCY_STATUS, SPACE_STATUS,
} from '../domain/constants.js';
import { notFound, validationError } from '../domain/errors.js';
import { businessLocalToEpoch, formatClock, parseClock } from '../domain/time.js';
import { getSpaceByCode, listSpaces } from './spaceService.js';
import { expireBookingHolds } from './bookingRequestService.js';

export const PUBLIC_CALENDAR_TIMEZONE = 'Asia/Colombo';
export const PUBLIC_CALENDAR_MAX_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_FETCH_LIMIT = 500;
const BUSY_SOURCES = new Set([
  OCCUPANCY_SOURCE.RESERVATION,
  OCCUPANCY_SOURCE.MAINTENANCE,
  'HOLD',
]);

function singleValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function textValue(value, max = 60) {
  const single = singleValue(value);
  if (single === undefined || single === null) return '';
  return String(single).replace(/\u0000/g, '').trim().slice(0, max);
}

/** A real calendar date, not just the right shape of digits. */
function realDateKey(value) {
  const single = singleValue(value);
  if (typeof single !== 'string') return '';
  const raw = single.replace(/\u0000/g, '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const [year, month, day] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
    ? raw
    : '';
}

function utcMs(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function dateKeyFromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function placeholders(count) {
  return new Array(count).fill('?').join(',');
}

/**
 * Validate `from`/`to`, enforce the maximum range and expand it into inclusive
 * date keys. Throws `validationError` (422) with field details on bad input.
 */
export function parseCalendarRange(fromValue, toValue) {
  const from = realDateKey(fromValue);
  const to = realDateKey(toValue);
  const details = {};
  if (!from) details.from = 'Use a real date in YYYY-MM-DD form.';
  if (!to) details.to = 'Use a real date in YYYY-MM-DD form.';
  if (Object.keys(details).length > 0) {
    throw validationError('Provide the calendar range as two real dates in YYYY-MM-DD form.', details);
  }

  const startMs = utcMs(from);
  const endMs = utcMs(to);
  if (startMs > endMs) {
    throw validationError('The start date must be on or before the end date.', {
      from: 'The start date must be on or before the end date.',
    });
  }
  const dayCount = Math.round((endMs - startMs) / DAY_MS) + 1;
  if (dayCount > PUBLIC_CALENDAR_MAX_DAYS) {
    throw validationError(
      `Choose a date range of ${PUBLIC_CALENDAR_MAX_DAYS} days or fewer.`,
      { to: `The range cannot exceed ${PUBLIC_CALENDAR_MAX_DAYS} days.` },
    );
  }

  const dateKeys = [];
  for (let index = 0; index < dayCount; index += 1) {
    dateKeys.push(dateKeyFromUtc(startMs + index * DAY_MS));
  }
  return { from, to, dateKeys };
}

/** The selectable published spaces, in catalogue order. */
function publishedSpaces(db, spaceCode) {
  if (spaceCode) {
    const space = getSpaceByCode(db, spaceCode);
    if (!space || space.status !== SPACE_STATUS.PUBLISHED) {
      throw notFound('Space not found.');
    }
    return [space];
  }
  return listSpaces(db, {
    status: SPACE_STATUS.PUBLISHED,
    limit: CALENDAR_FETCH_LIMIT,
    sort: 'name',
  }).items;
}

/** Active units grouped by space id — one query for the whole calendar. */
function unitsBySpace(db, spaceIds) {
  const grouped = new Map(spaceIds.map((id) => [id, []]));
  if (spaceIds.length === 0) return grouped;
  const rows = db.prepare(`
    SELECT id, space_id, code, label, kind, is_active
      FROM resource_unit
     WHERE is_active = 1
       AND space_id IN (${placeholders(spaceIds.length)})
     ORDER BY code ASC
  `).all(...spaceIds);
  for (const row of rows) {
    const list = grouped.get(row.space_id);
    if (list) list.push(row);
  }
  return grouped;
}

/**
 * Every occupancy row that can affect the range, reduced to the columns the
 * slot calculation needs. The hold join turns a temporary payment hold into
 * `HOLD`, exactly like `getSpaceDayGrid()`.
 */
function occupancyBySpace(db, spaceIds, rangeStart, rangeEnd) {
  const grouped = new Map(spaceIds.map((id) => [id, []]));
  if (spaceIds.length === 0) return grouped;
  const rows = db.prepare(`
    SELECT o.space_id, o.resource_unit_id, o.start_at, o.end_at,
           CASE WHEN bh.id IS NOT NULL THEN 'HOLD' ELSE o.source END AS source
      FROM occupancy o
      LEFT JOIN booking_hold_claim bh
             ON bh.occupancy_id = o.id AND bh.status = 'ACTIVE'
     WHERE o.space_id IN (${placeholders(spaceIds.length)})
       AND o.status = '${OCCUPANCY_STATUS.ACTIVE}'
       AND o.start_at < ? AND o.end_at > ?
     ORDER BY o.start_at ASC
  `).all(...spaceIds, rangeEnd, rangeStart);
  for (const row of rows) {
    const list = grouped.get(row.space_id);
    if (list) list.push(row);
  }
  return grouped;
}

/**
 * Hourly slots for one space/day, with the same boundaries and half-open
 * overlap rule as `getSpaceDayGrid()`.
 */
function daySlots({ dateKey, units, rows }) {
  const dayStart = businessLocalToEpoch(dateKey, '00:00');
  const dayEnd = dayStart + DAY_MS;
  const openMinutes = parseClock(units.openTime);
  const closeMinutes = parseClock(units.closeTime);
  const totalUnits = units.units.length;
  const dayRows = rows.filter((row) => row.start_at < dayEnd && row.end_at > dayStart);

  const slots = [];
  for (let minute = openMinutes; minute < closeMinutes; minute += 60) {
    const slotStart = businessLocalToEpoch(dateKey, formatClock(minute));
    const slotEnd = Math.min(
      businessLocalToEpoch(dateKey, formatClock(Math.min(minute + 60, closeMinutes))),
      dayEnd,
    );
    const busyUnitIds = new Set(
      dayRows
        .filter((row) => BUSY_SOURCES.has(row.source)
          && row.start_at < slotEnd && row.end_at > slotStart)
        .map((row) => row.resource_unit_id),
    );
    slots.push({
      startAt: slotStart,
      endAt: slotEnd,
      freeUnits: Math.max(0, totalUnits - busyUnitIds.size),
      totalUnits,
      isFree: busyUnitIds.size < totalUnits,
    });
  }
  return slots;
}

/**
 * Build the public calendar payload. `spaceCode` is optional; when present it
 * must identify a PUBLISHED space or the caller gets a 404.
 */
export function buildPublicCalendar(db, { from, to, spaceCode = null } = {}) {
  // A payment hold that passed its deadline must not appear busy forever.
  expireBookingHolds(db);
  const range = parseCalendarRange(from, to);
  const code = textValue(spaceCode, 60);
  const spaces = publishedSpaces(db, code);
  const spaceIds = spaces.map((space) => space.id);
  const units = unitsBySpace(db, spaceIds);
  const rangeStart = businessLocalToEpoch(range.from, '00:00');
  const rangeEnd = businessLocalToEpoch(range.to, '00:00') + DAY_MS;
  const occupancy = occupancyBySpace(db, spaceIds, rangeStart, rangeEnd);

  const summaries = spaces.map((space) => ({
    code: space.code,
    name: space.name,
    category: space.category,
    openTime: space.openTime,
    closeTime: space.closeTime,
    totalUnits: (units.get(space.id) ?? []).length,
  }));

  const days = range.dateKeys.map((dateKey) => ({
    dateKey,
    spaces: spaces.map((space) => ({
      spaceCode: space.code,
      openTime: space.openTime,
      closeTime: space.closeTime,
      totalUnits: (units.get(space.id) ?? []).length,
      slots: daySlots({
        dateKey,
        units: {
          openTime: space.openTime,
          closeTime: space.closeTime,
          units: units.get(space.id) ?? [],
        },
        rows: occupancy.get(space.id) ?? [],
      }),
    })),
  }));

  return {
    from: range.from,
    to: range.to,
    timezone: PUBLIC_CALENDAR_TIMEZONE,
    spaces: summaries,
    days,
  };
}
