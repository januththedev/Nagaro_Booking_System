/**
 * Business time helpers.
 *
 * Storage: epoch milliseconds, UTC.
 * Business time zone: Trace Expert City operates on EAT (Africa/Addis_Ababa),
 * a fixed UTC+03:00 offset with no daylight saving. We never rely on the
 * server process time zone.
 */
export const BUSINESS_TZ = 'Africa/Addis_Ababa';
export const BUSINESS_TZ_OFFSET_MINUTES = 180; // fixed UTC+03:00

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const MS = { MINUTE, HOUR, DAY };

/** Parse `HH:MM` into minutes past local midnight. Throws on malformed input. */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) throw new Error(`Invalid clock value: ${value}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Invalid clock value: ${value}`);
  return hours * 60 + minutes;
}

export function formatClock(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const mm = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Calendar date parts in the business time zone for an epoch-ms instant.
 * Implemented with Intl so the offset rule lives in one place.
 */
const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function businessParts(epochMs) {
  const parts = {};
  for (const p of partsFormatter.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // Intl can render midnight as hour "24" in some ICU builds.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** `YYYY-MM-DD` in the business time zone. */
export function businessDateKey(epochMs) {
  const p = businessParts(epochMs);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD HH:MM` in the business time zone (for display and CSV). */
export function businessDateTimeLabel(epochMs) {
  const p = businessParts(epochMs);
  return `${businessDateKey(epochMs)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function businessTimeLabel(epochMs) {
  const p = businessParts(epochMs);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Convert a business-local calendar date + clock time into epoch ms.
 * Uses the fixed EAT offset, so no DST ambiguity can occur.
 */
export function businessLocalToEpoch(dateKey, clock = '00:00') {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? '').trim());
  if (!dm) throw new Error(`Invalid date: ${dateKey}`);
  const minutes = parseClock(clock);
  const utcMs = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0, 0)
    + minutes * MINUTE
    - BUSINESS_TZ_OFFSET_MINUTES * MINUTE;
  return utcMs;
}

/** Epoch ms for the start of a business-local day. */
export function startOfBusinessDay(epochMs) {
  return businessLocalToEpoch(businessDateKey(epochMs), '00:00');
}

export function addDays(epochMs, days) {
  return epochMs + days * DAY;
}

/** Number of distinct business-local calendar dates an interval touches. */
export function businessDaySpan(startAt, endAt) {
  const startDay = startOfBusinessDay(startAt);
  const endDay = startOfBusinessDay(endAt === startAt ? endAt : endAt - 1);
  return Math.max(1, Math.round((endDay - startDay) / DAY) + 1);
}

export function minutesBetween(startAt, endAt) {
  return Math.round((endAt - startAt) / MINUTE);
}

export function hoursBetween(startAt, endAt) {
  return (endAt - startAt) / HOUR;
}

/** Duration in minutes rendered as `2h 30m`. */
export function formatDuration(startAt, endAt) {
  const total = Math.max(0, minutesBetween(startAt, endAt));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Does interval [aStart,aEnd) overlap [bStart,bEnd)?
 * Half-open semantics: touching endpoints do NOT overlap.
 */
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/** Expand an interval by `minutes` on both sides (used for booking buffers). */
export function inflate(startAt, endAt, minutes) {
  const pad = minutes * MINUTE;
  return pad === 0 ? { start: startAt, end: endAt } : { start: startAt - pad, end: endAt + pad };
}

export function nowMs() {
  return Date.now();
}

export function isValidEpochMs(value) {
  return Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) < 8.64e15;
}

/** Parse an ISO-8601 date-time or epoch-ms value into epoch ms, or null. */
export function coerceEpochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && isValidEpochMs(value)) return value;
  const raw = String(value).trim();
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    return isValidEpochMs(n) ? n : null;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Today's business-local date key. */
export function todayBusinessDate(clockMs = Date.now()) {
  return businessDateKey(clockMs);
}
