/**
 * Server-side validation and normalisation helpers.
 * Every mutating route funnels user input through these before it reaches a
 * service. Client-side validation is a convenience only.
 */
import { validationError } from './errors.js';
import { coerceEpochMs, businessLocalToEpoch, parseClock, intervalsOverlap } from './time.js';
import {
  PRICING_UNIT, SPACE_CATEGORY, SPACE_STATUS, ALLOWED_PRICING_UNITS,
  INQUIRY_STATUS, RESERVATION_STATUS, ADMIN_ROLE,
} from './constants.js';

const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const LIMITS = Object.freeze({
  maxImageBytes: MAX_IMAGE_BYTES,
  allowedImageTypes: [...ALLOWED_IMAGE_TYPES],
  maxImagesPerSpace: 12,
  maxNameLength: 160,
  maxTextLength: 2000,
  maxLongTextLength: 8000,
  maxEmailLength: 254,
  maxPhoneLength: 40,
  maxQueryLength: 160,
  maxPageSize: 100,
  defaultPageSize: 20,
});

/* ------------------------------------------------------------------ scalars */

export function asTrimmedString(value, { max = LIMITS.maxTextLength, field = 'value' } = {}) {
  if (value === null || value === undefined) return null;
  const str = String(value).replace(/\u0000/g, '').trim();
  if (str.length > max) {
    throw validationError(`${field} must be at most ${max} characters.`, { field });
  }
  return str;
}

export function requiredString(value, { max = LIMITS.maxTextLength, field = 'value', min = 1 } = {}) {
  const str = asTrimmedString(value, { max, field });
  if (str === null || str.length < min) {
    throw validationError(`${field} is required.`, { field });
  }
  return str;
}

export function optionalEmail(value, { field = 'email' } = {}) {
  const str = asTrimmedString(value, { max: LIMITS.maxEmailLength, field });
  if (str === null || str === '') return null;
  if (!EMAIL_RE.test(str)) {
    throw validationError('Enter a valid email address.', { field });
  }
  return str;
}

export function requiredEmail(value, { field = 'email' } = {}) {
  const email = optionalEmail(value, { field });
  if (!email) throw validationError('Email address is required.', { field });
  return email;
}

/** Lower-cased, trimmed email used for duplicate detection. */
export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function optionalPhone(value, { field = 'phone' } = {}) {
  const str = asTrimmedString(value, { max: LIMITS.maxPhoneLength, field });
  if (str === null || str === '') return null;
  if (!/^[+()\-\s\d.]{5,40}$/.test(str)) {
    throw validationError('Enter a valid telephone number.', { field });
  }
  return str;
}

export function asInteger(value, { field = 'value', min = null, max = null, required = false, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw validationError(`${field} is required.`, { field });
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw validationError(`${field} must be a whole number.`, { field });
  }
  if (min !== null && n < min) throw validationError(`${field} must be at least ${min}.`, { field });
  if (max !== null && n > max) throw validationError(`${field} must be at most ${max}.`, { field });
  return n;
}

export function asMoneyCents(value, { field = 'amount', required = false, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw validationError(`${field} is required.`, { field });
    return fallback;
  }
  const raw = String(value).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw validationError(`${field} must be a positive amount with at most 2 decimals.`, { field });
  }
  return Math.round(Number(raw) * 100);
}

export function oneOf(value, allowed, { field = 'value', required = true, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw validationError(`${field} is required.`, { field });
    return fallback;
  }
  const str = String(value).trim();
  if (!allowed.includes(str)) {
    throw validationError(`${field} must be one of: ${allowed.join(', ')}.`, { field });
  }
  return str;
}

export function asBoolean(value, { fallback = false } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const str = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(str)) return true;
  if (['0', 'false', 'no', 'off'].includes(str)) return false;
  return fallback;
}

export function asClock(value, { field = 'time', required = true, fallback = null } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) throw validationError(`${field} is required.`, { field });
    return fallback;
  }
  try {
    const minutes = parseClock(value);
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return `${h}:${m}`;
  } catch {
    throw validationError(`${field} must use HH:MM format.`, { field });
  }
}

export function asDateKey(value, { field = 'date', required = true, fallback = null } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) throw validationError(`${field} is required.`, { field });
    return fallback;
  }
  const str = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    throw validationError(`${field} must use YYYY-MM-DD format.`, { field });
  }
  return str;
}

/** Accepts epoch ms, ISO-8601, or `{date, time}` pairs normalised by callers. */
export function asEpoch(value, { field = 'value', required = true, fallback = null } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) throw validationError(`${field} is required.`, { field });
    return fallback;
  }
  const ms = coerceEpochMs(value);
  if (ms === null) throw validationError(`${field} must be a valid date and time.`, { field });
  return ms;
}

/**
 * Build an epoch-ms instant from a business-local date + clock time.
 * `dateKey` is YYYY-MM-DD, `clock` is HH:MM.
 */
export function localDateTime(dateKey, clock, field = 'value') {
  try {
    return businessLocalToEpoch(dateKey, clock);
  } catch {
    throw validationError(`${field} must be a valid date and time.`, { field });
  }
}

export function asStringArray(value, { field = 'values', maxItems = 40, maxLength = 80 } = {}) {
  if (value === null || value === undefined || value === '') return [];
  let list = value;
  if (!Array.isArray(list)) {
    if (typeof list === 'string') {
      const trimmed = list.trim();
      if (trimmed.startsWith('[')) {
        try { list = JSON.parse(trimmed); } catch { list = trimmed.split(','); }
      } else {
        list = trimmed.split(',');
      }
    } else {
      list = [list];
    }
  }
  const out = [];
  for (const item of list) {
    const str = asTrimmedString(item, { max: maxLength, field });
    if (str) out.push(str);
    if (out.length >= maxItems) break;
  }
  return [...new Set(out)];
}

/* --------------------------------------------------------------- pagination */

export function asPagination(query = {}) {
  const page = Math.max(1, asInteger(query.page, { field: 'page', min: 1, fallback: 1 }) ?? 1);
  const requested = asInteger(query.pageSize, {
    field: 'pageSize', min: 1, max: LIMITS.maxPageSize, fallback: LIMITS.defaultPageSize,
  }) ?? LIMITS.defaultPageSize;
  return { page, pageSize: requested, offset: (page - 1) * requested };
}

/* --------------------------------------------------- space form validation */

/**
 * Category-aware space payload validation.
 * Only fields relevant to the chosen category are required; irrelevant
 * category attributes are simply not demanded.
 */
export function parseSpacePayload(input, { partial = false, existing = null } = {}) {
  const errors = {};
  const value = {};
  const get = (key) => (input[key] === undefined ? (existing ? existing[key] : undefined) : input[key]);
  const provided = (key) => input[key] !== undefined;

  try {
    if (provided('name') || !partial) value.name = requiredString(get('name'), { field: 'name', max: LIMITS.maxNameLength });
    if (provided('code') || !partial) {
      const code = requiredString(get('code'), { field: 'code', max: 40 });
      if (!/^[A-Za-z0-9][A-Za-z0-9\-_]*$/.test(code)) {
        throw validationError('Space code may contain letters, numbers, dashes and underscores only.', { field: 'code' });
      }
      value.code = code.toUpperCase();
    }
    if (provided('category') || !partial) {
      value.category = oneOf(get('category'), Object.values(SPACE_CATEGORY), { field: 'category' });
    }
    if (provided('short_description') || !partial) {
      value.short_description = requiredString(get('short_description'), { field: 'short_description', max: 300 });
    }
    if (provided('description') || !partial) {
      value.description = requiredString(get('description'), { field: 'description', max: LIMITS.maxLongTextLength });
    }
    if (provided('location') || !partial) {
      value.location = requiredString(get('location'), { field: 'location', max: 200 });
    }
    if (provided('floor')) value.floor = asTrimmedString(input.floor, { max: 80, field: 'floor' });
    if (provided('capacity') || !partial) {
      value.capacity = asInteger(get('capacity'), { field: 'capacity', min: 1, max: 100000, required: true });
    }
    if (provided('currency')) value.currency = oneOf(input.currency, ['ETB', 'USD', 'EUR'], { field: 'currency', required: false, fallback: 'ETB' });
    if (provided('pricing_unit')) {
      value.pricing_unit = oneOf(input.pricing_unit, Object.values(PRICING_UNIT), { field: 'pricing_unit' });
    }
    if (provided('min_duration_minutes')) value.min_duration_minutes = asInteger(input.min_duration_minutes, { field: 'min_duration_minutes', min: 15, max: 43200, fallback: 60 });
    if (provided('max_duration_minutes')) value.max_duration_minutes = asInteger(input.max_duration_minutes, { field: 'max_duration_minutes', min: 15, max: 129600 });
    if (provided('buffer_minutes')) value.buffer_minutes = asInteger(input.buffer_minutes, { field: 'buffer_minutes', min: 0, max: 240, fallback: 0 });
    if (provided('open_time')) value.open_time = asClock(input.open_time, { field: 'open_time' });
    if (provided('close_time')) value.close_time = asClock(input.close_time, { field: 'close_time' });
    if (provided('amenities')) value.amenities = asStringArray(input.amenities, { field: 'amenities' });
    if (provided('contact_note')) value.contact_note = asTrimmedString(input.contact_note, { max: LIMITS.maxTextLength, field: 'contact_note' });
    if (provided('attributes')) value.attributes = normalizeAttributes(input.attributes);
    if (provided('desk_count')) {
      value.desk_count = asInteger(input.desk_count, { field: 'desk_count', min: 1, max: 500, required: true });
    }
    if (provided('rates')) value.rates = Array.isArray(input.rates) ? input.rates : [];
  } catch (error) {
    if (error.code === 'VALIDATION_ERROR' && error.details?.field) errors[error.details.field] = error.message;
    else errors._ = error.message;
  }

  const category = value.category ?? existing?.category;
  if (category) {
    const allowed = ALLOWED_PRICING_UNITS[category];
    const unit = value.pricing_unit ?? existing?.pricing_unit;
    if (unit && !allowed.includes(unit)) {
      errors.pricing_unit = `${category.replace(/_/g, ' ').toLowerCase()} spaces support: ${allowed.map((u) => u.toLowerCase().replace('_', ' ')).join(', ')}.`;
    }
  }

  const openTime = value.open_time ?? existing?.open_time;
  const closeTime = value.close_time ?? existing?.close_time;
  if (openTime && closeTime && parseClock(openTime) >= parseClock(closeTime)) {
    errors.close_time = 'Closing time must be after opening time.';
  }

  const minDur = value.min_duration_minutes ?? existing?.min_duration_minutes ?? 60;
  const maxDur = value.max_duration_minutes ?? existing?.max_duration_minutes ?? null;
  if (maxDur !== null && maxDur !== undefined && maxDur < minDur) {
    errors.max_duration_minutes = 'Maximum duration cannot be shorter than the minimum duration.';
  }

  const attrs = value.attributes ?? (existing?.attributes ? safeJson(existing.attributes) : {});
  if (category === SPACE_CATEGORY.AUDITORIUM && attrs && attrs.seating_capacity !== undefined && attrs.seating_capacity !== null && attrs.seating_capacity !== '') {
    const seating = asInteger(attrs.seating_capacity, { field: 'seating_capacity', min: 1, max: 100000 });
    value.attributes = { ...attrs, seating_capacity: seating };
  }

  if (Object.keys(errors).length > 0) {
    throw validationError('Please correct the highlighted fields.', errors);
  }
  return value;
}

export function normalizeAttributes(input) {
  let obj = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') return {};
    if (trimmed.startsWith('{')) {
      try { obj = JSON.parse(trimmed); } catch { throw validationError('Category details must be valid JSON.'); }
    } else {
      throw validationError('Category details must be valid JSON.');
    }
  }
  if (obj === null || obj === undefined) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    throw validationError('Category details must be an object.');
  }
  const clean = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
    if (raw === null || raw === undefined || raw === '') continue;
    if (typeof raw === 'boolean') { clean[key] = raw; continue; }
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) continue;
      clean[key] = raw;
      continue;
    }
    clean[key] = asTrimmedString(raw, { max: 600, field: key });
  }
  return clean;
}

export function safeJson(raw, fallback = {}) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/* ----------------------------------------------------------- booking input */

/**
 * Validate a booking window. Enforces half-open intervals with end > start
 * and rejects absurd durations. Opening-hours and buffer rules are applied by
 * the booking service, which also knows the space configuration.
 */
export function parseBookingWindow({ start_at, end_at, date, start_time, end_time, fallbackDate = null }) {
  let start = coerceEpochMs(start_at);
  let end = coerceEpochMs(end_at);

  if (start === null && date) {
    start = localDateTime(asDateKey(date, { field: 'date' }), asClock(start_time ?? '09:00', { field: 'start_time' }), 'start');
  }
  if (end === null && (end_time || date)) {
    const endDate = asDateKey(date ?? fallbackDate, { field: 'date' });
    const clock = asClock(end_time ?? '10:00', { field: 'end_time' });
    const sameDay = localDateTime(endDate, clock, 'end');
    // An end time that is not after the start rolls over to the next local day,
    // which is how a visitor expresses an overnight or `24:00`-style end.
    end = start !== null && sameDay <= start
      ? localDateTime(nextDateKey(endDate), clock, 'end')
      : sameDay;
  }

  if (start === null) throw validationError('A start date and time is required.', { field: 'start_at' });
  if (end === null) throw validationError('An end date and time is required.', { field: 'end_at' });
  if (end <= start) throw validationError('The end time must be after the start time.', { field: 'end_at' });

  const minutes = Math.round((end - start) / 60000);
  if (minutes > 60 * 24 * 400) {
    throw validationError('Booking periods longer than 400 days are not supported.', { field: 'end_at' });
  }
  return { startAt: start, endAt: end, durationMinutes: minutes };
}

function nextDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

export function assertInquiryStatus(value) {
  return oneOf(value, Object.values(INQUIRY_STATUS), { field: 'status' });
}

export function assertReservationStatus(value) {
  return oneOf(value, Object.values(RESERVATION_STATUS), { field: 'status' });
}

export function assertAdminRole(value) {
  return oneOf(value, Object.values(ADMIN_ROLE), { field: 'role' });
}

export function assertSpaceStatus(value) {
  return oneOf(value, Object.values(SPACE_STATUS), { field: 'status' });
}

/* -------------------------------------------------------------- images */

/**
 * Sniff real image type from magic bytes. Content-Type headers are attacker
 * controlled, so the stored MIME type comes from the bytes themselves.
 * SVG is deliberately not accepted (script execution risk).
 */
export function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
    && buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function assertUploadableImage(buffer, declaredType, { field = 'image' } = {}) {
  if (!buffer || buffer.length === 0) {
    throw validationError('The uploaded image is empty.', { field });
  }
  if (buffer.length > LIMITS.maxImageBytes) {
    throw validationError(`Images must be ${Math.floor(LIMITS.maxImageBytes / (1024 * 1024))} MB or smaller.`, { field });
  }
  const sniffed = sniffImageType(buffer);
  if (!sniffed || !ALLOWED_IMAGE_TYPES.has(sniffed)) {
    throw validationError('Upload a JPEG, PNG or WebP image.', { field });
  }
  if (declaredType && !ALLOWED_IMAGE_TYPES.has(declaredType) && declaredType !== sniffed) {
    throw validationError('The uploaded file content does not match a supported image type.', { field });
  }
  return sniffed;
}

export { intervalsOverlap };
