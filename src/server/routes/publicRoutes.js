/**
 * Public (visitor-facing) routes: home, space directory, space detail, the
 * request-to-book inquiry form, and the public JSON API.
 *
 * Boundaries this module guarantees, by construction:
 *
 *   - **Published only.** DRAFT and ARCHIVED space codes are indistinguishable
 *     from an unknown code: 404, never a partial page or a hint that the space
 *     exists.
 *   - **No customer data.** Availability answers come from
 *     `getPublicAvailability()` (counts plus anonymous blocked periods) and
 *     `getSpaceDayGrid(..., { includeDetails: false })` only. There is no code
 *     path here that can reach a customer name, a reservation reference or an
 *     internal note.
 *   - **Two explicit booking channels.** `/booking-request` remains a durable
 *     inquiry that consumes no inventory. `/book` delegates to the public
 *     booking service, which uses the canonical atomic booking core and a
 *     private capability token for guest management.
 *   - **Honest email wording.** A saved inquiry is never described as a
 *     delivered email; see `EMAIL_STATUS_NOTICE` in `publicViews.js`.
 *   - Every rendered value passes through the `html` tagged template.
 */
import { randomBytes } from 'node:crypto';
import { clientIp } from '../http/request.js';
import { redirect } from '../http/response.js';
import { AppError, notFound, validationError } from '../domain/errors.js';
import {
  AMENITY_CATALOG, ERROR_CODE as ERROR_CODES, PRICING_UNIT, SPACE_CATEGORY, SPACE_CATEGORY_LABEL,
  SPACE_STATUS,
} from '../domain/constants.js';
import { parseBookingWindow } from '../domain/validation.js';
import { businessDateKey, coerceEpochMs, formatClock, parseClock } from '../domain/time.js';
import { enforcePublicInquiryLimits, enforcePublicReadLimit } from '../security/rateLimit.js';
import { getSpaceByCode, listImages, listSpaces } from '../services/spaceService.js';
import {
  availabilityLabel, checkBookingRules, getPublicAvailability, getSpaceDayGrid,
} from '../services/availabilityService.js';
import {
  getInquiryByReference, submitInquiry, withdrawInquiry,
} from '../services/inquiryService.js';
import { buildPublicCalendar } from '../services/publicCalendarService.js';
import {
  cancelPublicBooking, getPublicBooking,
} from '../services/publicBookingService.js';
import { createSelfServiceBooking } from '../services/bookingRequestService.js';
import {
  publicErrorPage, publicSpaceProjection, renderBookingReceivedPage, renderBookingRequestPage,
  renderHomePage, renderPublicBookingConfirmedPage, renderPublicBookingManagePage,
  renderSelfBookingPage, renderSpaceDetailPage, renderSpaceDirectoryPage, renderWithdrawFormPage,
  renderWithdrawalConfirmedPage,
} from '../../web/views/publicViews.js';

const DIRECTORY_PAGE_SIZE = 12;
const DIRECTORY_PAGE_SIZE_MAX = 48;
/** `listSpaces` caps `limit` at 500; the catalogue is far smaller than that. */
const DIRECTORY_FETCH_LIMIT = 500;
const PUBLIC_SORTS = ['name', 'capacity', 'price'];
const FEATURED_LIMIT = 6;
const CAVEAT = 'Availability is live but not held until checkout. '
  + 'The final booking transaction checks the inventory again before confirming.';

/* ------------------------------------------------------------------- parsing */

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function textValue(value, max = 200) {
  const single = firstValue(value);
  if (single === undefined || single === null) return '';
  return String(single).replace(/\u0000/g, '').trim().slice(0, max);
}

function listValues(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean);
}

/** Lenient whole number: anything unusable falls back instead of erroring. */
function intValue(value, { min = null, max = null, fallback = null } = {}) {
  const raw = firstValue(value);
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (min !== null && n < min) return fallback;
  if (max !== null && n > max) return fallback;
  return n;
}

function dateValue(value) {
  const raw = textValue(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function clockValue(value) {
  const raw = textValue(value, 5);
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return '';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function pickEnum(raw, enumObject) {
  const options = Object.values(enumObject);
  return typeof raw === 'string' && options.includes(raw) ? raw : null;
}

function readPagination(query) {
  const page = intValue(query.page, { min: 1, max: 100000, fallback: 1 }) ?? 1;
  const pageSize = intValue(query.pageSize ?? query.page_size, {
    min: 1, max: DIRECTORY_PAGE_SIZE_MAX, fallback: DIRECTORY_PAGE_SIZE,
  }) ?? DIRECTORY_PAGE_SIZE;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function readDirectoryFilters(query) {
  const sort = textValue(query.sort, 20).toLowerCase();
  return {
    q: textValue(query.q ?? query.search, 80),
    category: pickEnum(textValue(query.category, 40).toUpperCase(), SPACE_CATEGORY),
    minCapacity: intValue(query.min_capacity ?? query.minCapacity, { min: 1, max: 100000, fallback: null }),
    amenities: listValues(query.amenity ?? query.amenities).slice(0, 20),
    pricingUnit: pickEnum(textValue(query.pricing_unit, 40).toUpperCase(), PRICING_UNIT),
    sort: PUBLIC_SORTS.includes(sort) ? sort : 'name',
  };
}

function spaceMatchesFilters(space, filters) {
  if (filters.category && space.category !== filters.category) return false;
  if (filters.pricingUnit) {
    const offers = space.pricingUnit === filters.pricingUnit
      || Object.prototype.hasOwnProperty.call(space.rates ?? {}, filters.pricingUnit);
    if (!offers) return false;
  }
  if (filters.minCapacity !== null && Number(space.capacity) < filters.minCapacity) return false;
  if (filters.amenities.length > 0) {
    const present = new Set((space.amenities ?? []).map((item) => String(item).toLowerCase()));
    if (!filters.amenities.every((item) => present.has(item.toLowerCase()))) return false;
  }
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    const haystack = [space.name, space.code, space.location, space.shortDescription]
      .filter(Boolean).map(String).join(' \u0000 ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** Cheapest comparable rate: the space's own billing unit, else its lowest rate. */
function spacePriceCents(space) {
  const primary = (space.rates ?? {})[space.pricingUnit];
  if (Number.isFinite(Number(primary))) return Number(primary);
  const values = Object.values(space.rates ?? {}).map(Number).filter((n) => Number.isFinite(n));
  return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
}

function sortPublicSpaces(spaces, sort) {
  const list = [...spaces];
  if (sort === 'capacity') {
    list.sort((a, b) => (Number(b.capacity) || 0) - (Number(a.capacity) || 0)
      || String(a.name).localeCompare(String(b.name)));
  } else if (sort === 'price') {
    list.sort((a, b) => spacePriceCents(a) - spacePriceCents(b)
      || String(a.name).localeCompare(String(b.name)));
  } else {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return list;
}

/** The one place a public space list is produced: PUBLISHED, filtered, sorted. */
function selectPublicSpaces(db, query) {
  const filters = readDirectoryFilters(query);
  const { items } = listSpaces(db, { status: SPACE_STATUS.PUBLISHED, limit: DIRECTORY_FETCH_LIMIT, sort: 'name' });
  const matches = sortPublicSpaces(items.filter((space) => spaceMatchesFilters(space, filters)), filters.sort);
  return { filters, matches, publishedTotal: items.length, published: items };
}

/** Amenities actually offered by published spaces, plus any currently filtered on. */
function amenityOptions(published, requested = []) {
  const offered = new Set();
  for (const space of published) for (const item of space.amenities ?? []) offered.add(String(item));
  for (const item of requested) offered.add(String(item));
  const catalogueOrder = AMENITY_CATALOG.filter((item) => offered.has(item));
  const extra = [...offered]
    .filter((item) => !AMENITY_CATALOG.includes(item))
    .sort((a, b) => a.localeCompare(b));
  return [...catalogueOrder, ...extra];
}

function pricingUnitOptions(published) {
  const offered = new Set();
  for (const space of published) {
    if (space.pricingUnit) offered.add(space.pricingUnit);
    for (const unit of Object.keys(space.rates ?? {})) offered.add(unit);
  }
  return Object.values(PRICING_UNIT).filter((unit) => offered.has(unit));
}

/** One published space by code, or null. Never reveals existence of others. */
function findPublishedSpace(db, code) {
  const raw = textValue(code, 60);
  if (!raw) return null;
  const space = getSpaceByCode(db, raw);
  if (!space || space.status !== SPACE_STATUS.PUBLISHED) return null;
  return space;
}

/** The select options for the request form: projection keys only. */
function publishedSpaceOptions(db) {
  const { items } = listSpaces(db, { status: SPACE_STATUS.PUBLISHED, limit: DIRECTORY_FETCH_LIMIT, sort: 'name' });
  return items.map((space) => ({
    code: space.code,
    name: space.name,
    category: space.category,
    categoryLabel: space.categoryLabel ?? SPACE_CATEGORY_LABEL[space.category] ?? space.category,
  }));
}

/* --------------------------------------------------------- availability check */

function safeMessage(error) {
  if (error instanceof AppError && error.status < 500) return error.message;
  return 'Please check the date and times and try again.';
}

/**
 * The raw `space` table row. `checkBookingRules()` and the day grid read
 * snake_case columns, while `spaceService` hydrates camelCase objects; this
 * helper is the one bridge between the two, and the row never leaves the route.
 */
function rawSpaceRow(db, spaceId) {
  return db.prepare('SELECT * FROM space WHERE id = ?').get(Number(spaceId)) ?? null;
}

/** Opening-hours defaults for the checker form, read from a raw space row. */
function defaultWindow(row) {
  const open = (() => { try { return parseClock(row.open_time); } catch { return 8 * 60; } })();
  const close = (() => { try { return parseClock(row.close_time); } catch { return 18 * 60; } })();
  const minimum = Math.max(15, Number(row.min_duration_minutes) || 60);
  const end = Math.min(open + minimum, close > open ? close : open + minimum);
  return { start: formatClock(open), end: formatClock(end) };
}

/**
 * The server-rendered answer for the no-JavaScript availability checker.
 * Runs on `GET /spaces/:code?date=&start_time=&end_time=&desks=`.
 */
function buildAvailabilityCheck(db, row, query) {
  const defaults = defaultWindow(row);
  const date = dateValue(query.date);
  const startTime = clockValue(query.start_time ?? query.start) || defaults.start;
  const endTime = clockValue(query.end_time ?? query.end) || defaults.end;
  const desks = intValue(query.desks ?? query.desk_count, { min: 1, max: 500, fallback: 1 }) ?? 1;

  const check = {
    today: businessDateKey(Date.now()),
    values: { date, startTime, endTime, desks },
    window: null,
    result: null,
  };
  if (!date) return check;

  let window;
  try {
    window = parseBookingWindow({ date, start_time: startTime, end_time: endTime });
  } catch (error) {
    check.result = {
      kind: 'error',
      headline: 'We could not read that date and time.',
      details: [safeMessage(error)],
    };
    return check;
  }
  check.window = window;

  const problems = checkBookingRules(row, { startAt: window.startAt, endAt: window.endAt });
  if (problems.length > 0) {
    check.result = {
      kind: 'busy',
      headline: 'That period cannot be requested as entered.',
      details: [],
      problems,
    };
    return check;
  }

  try {
    const availability = getPublicAvailability(db, {
      spaceId: row.id, startAt: window.startAt, endAt: window.endAt, deskCount: desks,
    });
    check.result = {
      kind: availability.isAvailable ? 'ok' : 'busy',
      headline: availability.isAvailable
        ? (availability.isPooled
          ? `Available — ${availability.freeUnits} of ${availability.totalUnits} desks free for the selected period.`
          : 'Available for the selected period.')
        : 'Not available for the selected period.',
      details: [availabilityLabel(availability)],
    };
  } catch (error) {
    check.result = {
      kind: 'error',
      headline: 'Availability could not be checked.',
      details: [safeMessage(error)],
    };
  }
  return check;
}

function requestHrefFor(space, values) {
  const params = new URLSearchParams();
  params.set('space', space.code);
  if (values.date) {
    params.set('date', values.date);
    params.set('start', values.startTime);
    params.set('end', values.endTime);
    if (space.category === SPACE_CATEGORY.COWORKING && Number(values.desks) > 1) {
      params.set('desks', String(values.desks));
    }
  }
  return `/book?${params.toString()}`;
}

/* ------------------------------------------------------------ inquiry helpers */

function formValues(body) {
  const source = body ?? {};
  return {
    customer_name: textValue(source.customer_name ?? source.customerName ?? source.full_name ?? source.fullName ?? source.name, 160),
    email: textValue(source.email, 254),
    phone: textValue(source.phone, 40),
    organization: textValue(source.organization, 160),
    space_code: textValue(source.space_code ?? source.spaceCode, 60).toUpperCase(),
    date: dateValue(source.date),
    start_time: clockValue(source.start_time ?? source.startTime ?? source.start),
    end_time: clockValue(source.end_time ?? source.endTime ?? source.end),
    start_at: textValue(source.requested_start_at ?? source.start_at ?? source.requestedStartAt ?? source.startAt, 40),
    end_at: textValue(source.requested_end_at ?? source.end_at ?? source.requestedEndAt ?? source.endAt, 40),
    desks: textValue(source.desks ?? source.desk_quantity ?? source.deskQuantity ?? source.unit_count ?? source.unitCount, 6),
    attendees: textValue(source.attendees, 8),
    message: textValue(source.message ?? source.purpose, 2000),
  };
}

/** Pre-fill the request form from `?space=&date=&start=&end=&desks=`. */
function prefillValues(query) {
  return {
    customer_name: '',
    email: '',
    phone: '',
    organization: '',
    space_code: textValue(query.space ?? query.space_code, 60).toUpperCase(),
    date: dateValue(query.date),
    start_time: clockValue(query.start_time ?? query.start),
    end_time: clockValue(query.end_time ?? query.end),
    desks: textValue(query.desks ?? query.desk_quantity, 6),
    attendees: textValue(query.attendees, 8),
    message: '',
  };
}

/**
 * Map the public form onto the inquiry service payload. Field names are the
 * service's (`desk_quantity`, not `desks`); the route never computes business
 * rules itself.
 */
function payloadFromValues(values) {
  return {
    customer_name: values.customer_name,
    email: values.email,
    phone: values.phone,
    organization: values.organization,
    space_code: values.space_code,
    requested_start_at: values.start_at || null,
    requested_end_at: values.end_at || null,
    date: values.date,
    start_time: values.start_time,
    end_time: values.end_time,
    desk_quantity: values.desks,
    attendees: values.attendees,
    message: values.message,
  };
}

function newPublicBookingToken() {
  return randomBytes(24).toString('base64url');
}

function publicBookingInput(db, values, formToken, now = Date.now()) {
  const space = findPublishedSpace(db, values.space_code);
  if (!space) throw validationError('Choose a published space.', { space_code: 'Choose a published space.' });
  const window = parseBookingWindow({
    start_at: values.start_at || null,
    end_at: values.end_at || null,
    date: values.date,
    start_time: values.start_time,
    end_time: values.end_time,
  });
  const token = textValue(formToken, 120);
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(token)) {
    throw validationError('This booking form has expired. Reload the page and try again.', {
      form_token: 'Reload the booking form before submitting.',
    });
  }
  const units = space.category === SPACE_CATEGORY.COWORKING
    ? intValue(values.desks, { min: 1, max: 500, fallback: 1 })
    : 1;
  const attendees = values.attendees === ''
    ? null
    : intValue(values.attendees, { min: 0, max: 100000, fallback: null });
  return {
    spaceId: space.id,
    startAt: window.startAt,
    endAt: window.endAt,
    unitCount: units,
    attendees,
    purpose: values.message || null,
    idempotencyKey: `public:${token}`,
    now,
    customer: {
      fullName: values.customer_name,
      email: values.email,
      phone: values.phone,
      organization: values.organization,
    },
  };
}

/**
 * Read the private booking capability without forcing it into a URL. The
 * bearer header is the preferred API transport; the explicit header and token
 * query/body aliases keep the browser management links backwards compatible.
 */
function bookingCapability(ctx, body = null) {
  const authorization = String(ctx.req.headers.authorization ?? '');
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? '';
  return textValue(
    body?.token
      ?? body?.manage_token
      ?? body?.manageToken
      ?? ctx.req.headers['x-booking-capability']
      ?? ctx.query.token
      ?? bearer,
    200,
  );
}

function publicBookingFormToken(ctx, body) {
  return body?.form_token
    ?? body?.formToken
    ?? body?.idempotency_key
    ?? body?.idempotencyKey
    ?? ctx.req.headers['idempotency-key'];
}

function protectCapabilityResponse(ctx) {
  ctx.setHeader('Referrer-Policy', 'no-referrer');
  ctx.setHeader('Cache-Control', 'no-store, private');
}

function selfServiceBookingResponse(result) {
  const request = result.request;
  const confirmed = request.status === 'CONFIRMED' && request.reservationReference;
  const reference = confirmed ? request.reservationReference : request.reference;
  const destination = confirmed ? '/book/confirmed' : '/book/manage';
  const managePath = result.manageToken
    ? `${destination}?ref=${encodeURIComponent(reference)}&token=${encodeURIComponent(result.manageToken)}`
    : null;
  return {
    request,
    manageToken: result.manageToken,
    managePath,
    outcome: confirmed ? 'CONFIRMED' : 'PAYMENT_REQUIRED',
    idempotent: result.idempotent,
  };
}

function reservationFromCheckout(request) {
  return {
    reference: request.reservationReference ?? request.reference,
    status: request.status,
    spaceCode: request.spaceCode,
    spaceName: request.spaceName,
    startAt: request.startAt,
    endAt: request.endAt,
    unitCount: request.unitCount,
    attendees: request.attendees,
    billingUnit: request.billingUnit,
    billingQuantity: request.billingQuantity,
    rateCents: request.rateCents,
    totalCents: request.venueTotalCents,
    currency: request.currency,
  };
}

function problemStrings(details) {
  if (!details || typeof details !== 'object') return [];
  if (Array.isArray(details.problems)) return details.problems.map(String).slice(0, 8);
  const seen = new Set();
  const out = [];
  for (const value of Object.values(details)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.slice(0, 8);
}

/** Exactly what the acknowledgement page needs — and no visitor PII. */
function inquirySummary(inquiry) {
  return {
    reference: inquiry.reference,
    spaceCode: inquiry.spaceCode,
    spaceName: inquiry.spaceName,
    categoryLabel: inquiry.categoryLabel,
    startAt: inquiry.startAt,
    endAt: inquiry.endAt,
    deskQuantity: inquiry.deskQuantity,
    status: inquiry.status,
    emailStatus: inquiry.emailStatus,
  };
}

function renderNotFoundSpace(ctx) {
  ctx.html(publicErrorPage({
    status: 404,
    title: 'Space not found',
    message: 'That space does not exist, or it is not published at the moment.',
    hint: 'It may have been renamed or taken off the public catalogue. Browse the published spaces instead.',
  }), 404);
}

/* ----------------------------------------------------------- day projection */

/**
 * Flatten a day grid into the public shape. Only counts and instants survive;
 * `occupancy` and `allDayBlocks` (which carry reservation references and
 * customer names) are dropped here, by name.
 */
export function publicDayProjection(spaceCode, grid) {
  return {
    spaceCode,
    dateKey: grid.dateKey,
    openTime: grid.openTime,
    closeTime: grid.closeTime,
    totalUnits: grid.totalUnits,
    slots: (grid.slots ?? []).map((slot) => ({
      startAt: slot.startAt,
      endAt: slot.endAt,
      freeUnits: slot.freeUnits,
      totalUnits: slot.totalUnits,
      isFree: slot.isFree,
    })),
  };
}

/* -------------------------------------------------------------- API parsing */

/** A real calendar date, not just the right shape of digits. */
function realDateKey(value) {
  const raw = dateValue(value);
  if (!raw) return '';
  const [year, month, day] = raw.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day ? raw : '';
}

function requiredSpaceCode(query) {
  const code = textValue(query.space ?? query.space_code ?? query.code, 60);
  if (!code) {
    throw validationError('Provide the code of a space to check.', { space: 'Choose a space to check.' });
  }
  return code;
}

function parseAvailabilityWindow(query, fallbackDesks = 1) {
  const startAt = coerceEpochMs(textValue(query.start ?? query.start_at, 40));
  const endAt = coerceEpochMs(textValue(query.end ?? query.end_at, 40));
  const errors = {};
  if (startAt === null) errors.start = 'Provide the start of the period as an ISO-8601 date and time.';
  if (endAt === null) errors.end = 'Provide the end of the period as an ISO-8601 date and time.';
  if (Object.keys(errors).length > 0) {
    throw validationError('Provide a valid period to check.', errors);
  }
  if (endAt <= startAt) {
    throw validationError('The end of the period must be after the start.', {
      end: 'The end of the period must be after the start.',
    });
  }
  const desks = intValue(query.desks ?? query.desk_count, { min: 1, max: 500, fallback: null })
    ?? fallbackDesks;
  return { startAt, endAt, desks };
}

/* ------------------------------------------------------------------- routes */

/**
 * Register every visitor-facing route on `router`.
 *
 * `deps` mirrors `app.js`: `{ db, config }` plus the optional test seams
 * `mailer` (anything shaped like `{ sendMail, mailerConfig }`), `baseUrl`
 * (absolute origin used in notification emails) and `now` (clock injection).
 *
 * Errors are thrown, never rendered ad hoc: the router's error boundary turns
 * them into `{ ok: false, error: { code, message, details } }` for JSON
 * requests and a friendly page for browsers.
 */
export function registerPublicRoutes(router, deps = {}) {
  const db = deps.db;
  if (!db) throw new Error('registerPublicRoutes requires deps.db');

  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const mailer = deps.mailer ?? undefined;
  const baseUrl = deps.baseUrl ?? deps.config?.baseUrl ?? null;

  /** The only way a space row becomes something a public view may touch. */
  const projectSpace = (space) => publicSpaceProjection(space, { images: listImages(db, space.id) });

  /* ---------------------------------------------------------------- home */

  router.get('/', async (ctx) => {
    const { items } = listSpaces(db, {
      status: SPACE_STATUS.PUBLISHED, limit: DIRECTORY_FETCH_LIMIT, sort: 'name',
    });
    const categoryCounts = {};
    for (const space of items) {
      categoryCounts[space.category] = (categoryCounts[space.category] ?? 0) + 1;
    }
    ctx.html(renderHomePage({
      featured: items.slice(0, FEATURED_LIMIT).map(projectSpace),
      totalPublished: items.length,
      categoryCounts,
    }));
  });

  /* ----------------------------------------------------------- directory */

  router.get('/spaces', async (ctx) => {
    const { filters, matches, publishedTotal, published } = selectPublicSpaces(db, ctx.query);
    const { page, pageSize, offset } = readPagination(ctx.query);
    ctx.html(renderSpaceDirectoryPage({
      spaces: matches.slice(offset, offset + pageSize).map(projectSpace),
      total: matches.length,
      publishedTotal,
      page,
      pageSize,
      filters,
      amenityOptions: amenityOptions(published, filters.amenities),
      pricingUnitOptions: pricingUnitOptions(published),
    }));
  });

  /* --------------------------------------------------------- space detail */

  router.get('/spaces/:code', async (ctx) => {
    const space = findPublishedSpace(db, ctx.params.code);
    if (!space) { renderNotFoundSpace(ctx); return; }
    const row = rawSpaceRow(db, space.id);
    if (!row) { renderNotFoundSpace(ctx); return; }
    const check = buildAvailabilityCheck(db, row, ctx.query);
    ctx.html(renderSpaceDetailPage({
      space: projectSpace(space),
      check,
      requestHref: requestHrefFor(space, check.values),
    }));
  });

  /* ------------------------------------------------ direct guest booking
   * Checkout allocates inventory immediately under the canonical transaction.
   * A configured registration fee creates a guarded payment hold; otherwise
   * the reservation is confirmed in the same checkout response. */

  const retirePublicFlow = (ctx) => {
    if (ctx.wantsJson) {
      ctx.json({
        ok: false,
        error: {
          code: 'RETIRED',
          message: 'This legacy form has been retired. Choose a published space and use the secure booking checkout instead.',
          details: { use: '/spaces' },
        },
      }, 410);
      return;
    }
    redirect(ctx.res, '/spaces', 303);
    ctx.responded = true;
  };

  router.get('/book', async (ctx) => {
    redirect(ctx.res, '/spaces', 308);
    ctx.responded = true;
  });

  router.post('/book', async (ctx) => {
    const body = await ctx.readBody();
    const values = formValues(body);
    const spaces = selectPublicSpaces(db, {}).published.map(projectSpace);
    const renderProblems = (error) => {
      const problems = problemStrings(error?.details);
      ctx.html(renderSelfBookingPage({
        spaces,
        values: { ...values, today: businessDateKey(clock()) },
        errors: error?.details ?? null,
        problems: problems.length ? problems : [error?.message ?? 'Please check the booking details.'],
        formToken: textValue(body.form_token, 120) || newPublicBookingToken(),
        status: error?.status ?? 422,
      }), error?.status ?? 422);
    };

    try {
      protectCapabilityResponse(ctx);
      enforcePublicInquiryLimits(db, { ip: clientIp(ctx.req), email: values.email, now: clock() });
      const result = createSelfServiceBooking(
        db,
        publicBookingInput(db, values, publicBookingFormToken(ctx, body), clock()),
      );
      const response = selfServiceBookingResponse(result);

      if (ctx.wantsJson) {
        ctx.json({ ok: true, data: response }, result.idempotent ? 200 : 201);
        return;
      }
      if (response.managePath) {
        redirect(ctx.res, response.managePath, 303);
        ctx.responded = true;
        return;
      }
      if (response.outcome === 'CONFIRMED') {
        ctx.html(renderPublicBookingConfirmedPage({
          reservation: reservationFromCheckout(result.request),
          managePath: null,
        }), 200);
        return;
      }
      ctx.html(publicErrorPage({
        status: 409,
        title: 'The booking is awaiting payment',
        message: `Booking ${result.request.reference} is holding the selected time, but this retry cannot reopen its private payment link.`,
        hint: 'Use the original private link or contact the TRACE operations desk with the booking reference.',
      }), 409);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (ctx.wantsJson) throw error;
      renderProblems(error);
    }
  });

  router.get('/book/confirmed', async (ctx) => {
    ctx.setHeader('Referrer-Policy', 'no-referrer');
    ctx.setHeader('Cache-Control', 'no-store, private');
    const reference = textValue(ctx.query.ref ?? ctx.query.reference, 40);
    const token = textValue(ctx.query.token, 200);
    try {
      const reservation = getPublicBooking(db, { reference, token });
      const managePath = `/book/manage?ref=${encodeURIComponent(reference)}&token=${encodeURIComponent(token)}`;
      ctx.html(renderPublicBookingConfirmedPage({ reservation, managePath }));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      ctx.html(publicErrorPage({
        status: 404,
        title: 'That private booking link was not recognised',
        message: 'We could not open a confirmed booking with this link.',
        hint: 'Use the complete private link from the booking confirmation, or contact the operations desk.',
      }), 404);
    }
  });

  router.get('/book/manage', async (ctx) => {
    ctx.setHeader('Referrer-Policy', 'no-referrer');
    ctx.setHeader('Cache-Control', 'no-store, private');
    const reference = textValue(ctx.query.ref ?? ctx.query.reference, 40);
    const token = textValue(ctx.query.token, 200);
    try {
      const reservation = getPublicBooking(db, { reference, token });
      ctx.html(renderPublicBookingManagePage({
        reservation,
        reference,
        token,
        cancelled: textValue(ctx.query.cancelled, 5) === '1',
      }));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      ctx.html(publicErrorPage({
        status: 404,
        title: 'That private booking link was not recognised',
        message: 'We could not open a booking with this link.',
        hint: 'Use the complete private link from your confirmation screen.',
      }), 404);
    }
  });

  router.post('/book/cancel', async (ctx) => {
    ctx.setHeader('Referrer-Policy', 'no-referrer');
    ctx.setHeader('Cache-Control', 'no-store, private');
    const body = await ctx.readBody();
    const reference = textValue(body.reference ?? body.ref, 40);
    const token = textValue(body.token, 200);
    try {
      const reservation = cancelPublicBooking(db, { reference, token, now: clock() });
      if (ctx.wantsJson) { ctx.json({ ok: true, data: { reservation } }); return; }
      redirect(ctx.res, `/book/manage?ref=${encodeURIComponent(reference)}&token=${encodeURIComponent(token)}&cancelled=1`, 303);
      ctx.responded = true;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (ctx.wantsJson) throw error;
      ctx.html(publicErrorPage({
        status: error.status,
        title: error.status === 409 ? 'This booking cannot be cancelled online' : 'That private booking link was not recognised',
        message: error.message,
        hint: 'Contact the operations desk and quote the booking reference if you need help.',
      }), error.status);
    }
  });

  /* ---------------------------------------- retired: concierge inquiry form
   * The separate concierge channel is retired in favour of the unified
   * request flow; existing inquiry withdrawal links keep working. */

  router.get('/booking-request', async (ctx) => {
    redirect(ctx.res, '/spaces', 308);
    ctx.responded = true;
  });

  router.post('/booking-request', async (ctx) => {
    await ctx.readBody();
    retirePublicFlow(ctx);
  });

  /* ---------------------------------------------------------- acknowledgement */

  router.get('/booking-request/received', async (ctx) => {
    const reference = textValue(ctx.query.ref ?? ctx.query.reference, 40);
    const token = textValue(ctx.query.token, 200);
    const inquiry = reference ? getInquiryByReference(db, reference) : null;
    if (!inquiry) {
      // No existence hint: an unknown reference reads the same as a mistyped one.
      ctx.html(publicErrorPage({
        status: 404,
        title: 'No request found for that reference',
        message: 'We could not find a booking request with that reference.',
        hint: 'Check the reference in the acknowledgement message from TRACE, or send a new request.',
      }), 404);
      return;
    }
    // `inquirySummary` carries no name, email, phone or note: the page cannot
    // echo visitor details back even by mistake.
    ctx.html(renderBookingReceivedPage({ inquiry: inquirySummary(inquiry), token: token || null }));
  });

  /* ------------------------------------------------------------- withdrawal */

  router.get('/booking-request/withdraw', async (ctx) => {
    const reference = textValue(ctx.query.ref ?? ctx.query.reference, 40);
    const token = textValue(ctx.query.token, 200);
    if (!reference || !token) {
      // Never touches the database, so there is nothing to hint at either.
      ctx.html(publicErrorPage({
        status: 400,
        title: 'That withdrawal link is incomplete',
        message: 'This page needs both the request reference and the withdrawal token from your acknowledgement message.',
        hint: 'Open the withdrawal link from the message TRACE sent you, or send a new booking request.',
      }), 400);
      return;
    }
    ctx.html(renderWithdrawFormPage({ reference, token }));
  });

  router.post('/booking-request/withdraw', async (ctx) => {
    const body = await ctx.readBody();
    const reference = textValue(body.reference ?? body.ref, 40);
    const token = textValue(body.token, 200);
    if (!reference || !token) {
      ctx.html(publicErrorPage({
        status: 400,
        title: 'That withdrawal link is incomplete',
        message: 'This page needs both the request reference and the withdrawal token from your acknowledgement message.',
        hint: 'Open the withdrawal link from the message TRACE sent you, or send a new booking request.',
      }), 400);
      return;
    }

    let inquiry;
    try {
      inquiry = withdrawInquiry(db, { reference, token });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        // One page for a wrong token and for an unknown reference alike.
        ctx.html(publicErrorPage({
          status: 404,
          title: 'That withdrawal link was not recognised',
          message: 'We could not find a booking request for that reference and withdrawal link.',
          hint: 'Open the withdrawal link exactly as it appears in the message from TRACE. If it still fails, contact TRACE reception.',
        }), 404);
        return;
      }
      if (error instanceof AppError && error.status === 409) {
        ctx.html(publicErrorPage({
          status: 409,
          title: 'This request can no longer be withdrawn here',
          message: error.message,
          hint: 'Please contact TRACE reception at Trace Expert City and quote your reference.',
        }), 409);
        return;
      }
      if (error instanceof AppError && error.status === 422) {
        ctx.html(publicErrorPage({
          status: 400,
          title: 'That withdrawal link is incomplete',
          message: error.message,
          hint: 'Open the withdrawal link from the message TRACE sent you.',
        }), 400);
        return;
      }
      throw error;
    }

    ctx.html(renderWithdrawalConfirmedPage({ reference: inquiry.reference, status: inquiry.status }));
  });

  /* --------------------------------------------------------------- JSON API */

  router.get('/api/public/spaces', async (ctx) => {
    const { filters, matches, publishedTotal, published } = selectPublicSpaces(db, ctx.query);
    const { page, pageSize, offset } = readPagination(ctx.query);
    ctx.json({
      items: matches.slice(offset, offset + pageSize).map(projectSpace),
      total: matches.length,
      publishedTotal,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(matches.length / pageSize)),
      filters: {
        q: filters.q || null,
        category: filters.category,
        minCapacity: filters.minCapacity,
        amenities: filters.amenities,
        pricingUnit: filters.pricingUnit,
        sort: filters.sort,
      },
    });
  });

  router.get('/api/public/spaces/:code', async (ctx) => {
    const space = findPublishedSpace(db, ctx.params.code);
    if (!space) throw notFound('Space not found.');
    ctx.json(projectSpace(space));
  });

  router.get('/api/public/availability', async (ctx) => {
    const space = findPublishedSpace(db, requiredSpaceCode(ctx.query));
    if (!space) throw notFound('Space not found.');
    const { startAt, endAt, desks } = parseAvailabilityWindow(ctx.query);
    const row = rawSpaceRow(db, space.id);
    const problems = checkBookingRules(row, { startAt, endAt });
    if (problems.length > 0) throw validationError(problems[0], { problems });
    // The only availability function public code may call: counts, anonymous
    // blocked periods, and nothing that names a customer or a reference.
    ctx.json(getPublicAvailability(db, { spaceId: space.id, startAt, endAt, deskCount: desks }));
  });

  /**
   * Multi-day, optionally single-space calendar. The service validates the
   * range (real dates, max 31 days) and returns counts only: no reservation
   * reference, customer detail, purpose, payment data or maintenance reason
   * ever reaches this projection. A short shared cache keeps repeat visits
   * cheap without pretending availability is immutable.
   */
  router.get('/api/public/availability/calendar', async (ctx) => {
    enforcePublicReadLimit(db, {
      ip: clientIp(ctx.req),
      scope: 'public-availability-calendar',
      now: clock(),
    });
    const payload = buildPublicCalendar(db, {
      from: firstValue(ctx.query.from),
      to: firstValue(ctx.query.to),
      spaceCode: firstValue(ctx.query.space ?? ctx.query.space_code),
    });
    ctx.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=120');
    ctx.json(payload);
  });

  router.get('/api/public/availability/day', async (ctx) => {
    const space = findPublishedSpace(db, requiredSpaceCode(ctx.query));
    if (!space) throw notFound('Space not found.');
    const dateKey = realDateKey(ctx.query.date);
    if (!dateKey) {
      throw validationError('Provide the day to check as YYYY-MM-DD.', { date: 'Use YYYY-MM-DD.' });
    }
    const grid = getSpaceDayGrid(db, { spaceId: space.id, dateKey, includeDetails: false });
    ctx.json(publicDayProjection(space.code, grid));
  });

  router.post('/api/public/bookings', async (ctx) => {
    protectCapabilityResponse(ctx);
    const body = await ctx.readBody();
    const values = formValues(body);
    const formToken = publicBookingFormToken(ctx, body);
    enforcePublicInquiryLimits(db, { ip: clientIp(ctx.req), email: values.email, now: clock() });
    const result = createSelfServiceBooking(db, publicBookingInput(db, values, formToken, clock()));
    ctx.json({ ok: true, data: selfServiceBookingResponse(result) }, result.idempotent ? 200 : 201);
  });

  router.get('/api/public/bookings/:reference', async (ctx) => {
    protectCapabilityResponse(ctx);
    const reference = textValue(ctx.params.reference, 40);
    const token = bookingCapability(ctx);
    const reservation = getPublicBooking(db, { reference, token });
    ctx.json({ ok: true, data: { reservation } });
  });

  router.post('/api/public/bookings/:reference/cancel', async (ctx) => {
    protectCapabilityResponse(ctx);
    const body = await ctx.readBody();
    const reference = textValue(ctx.params.reference ?? body.reference ?? body.ref, 40);
    const token = bookingCapability(ctx, body);
    const reservation = cancelPublicBooking(db, { reference, token, now: clock() });
    ctx.json({ ok: true, data: { reservation } });
  });

  router.post('/api/public/inquiries', async (ctx) => {
    await ctx.readBody();
    retirePublicFlow(ctx);
  });
}
