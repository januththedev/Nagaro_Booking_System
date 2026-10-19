/**
 * Visitor-facing views and the single public projection of a space.
 *
 * ============================ PRIVACY CONTRACT ============================
 * `publicSpaceProjection()` is the ONLY shape of a space a visitor-facing page
 * or JSON response may receive. It returns exactly the keys listed in
 * `PUBLIC_SPACE_KEYS` and nothing else, so a page cannot accidentally render a
 * column that was never meant to be public:
 *
 *   - photographs lose `storedName`, `originalName`, `mimeType` and `byteSize`;
 *   - rates lose their row ids and `space_id`;
 *   - `contactNote`, `currency`, `status`, `units`, timestamps and every
 *     reservation/customer column are not carried at all;
 *   - category attributes whose key looks like a private field (`notes`,
 *     `purpose`, `attendees`, ...) are dropped.
 *
 * `tests/unit/publicPrivacy.test.js` walks the projection and the availability
 * responses recursively and fails on any forbidden key name.
 * =========================================================================
 *
 * Views receive plain objects (already projected) and never query the database.
 */
import {
  html, raw, attr, categoryLabel, pricingUnitLabel, money,
  periodLabel, emptyState, problemList, statusBadge,
} from '../lib/html.js';
import { publicShell } from './layout.js';
import {
  SPACE_CATEGORY, SPACE_CATEGORY_LABEL, SPACE_CATEGORY_ORDER, SPACE_STATUS,
} from '../../server/domain/constants.js';
import { rateSummary as spaceRateSummary } from '../../server/services/spaceService.js';

/* ------------------------------------------------------------------ constants */

/** The complete, frozen public surface of a space. */
export const PUBLIC_SPACE_KEYS = Object.freeze([
  'id', 'code', 'name', 'category', 'categoryLabel', 'shortDescription', 'description',
  'location', 'floor', 'capacity', 'unitCount', 'openTime', 'closeTime',
  'minDurationMinutes', 'maxDurationMinutes', 'bufferMinutes',
  'rates', 'rateList', 'rateSummary', 'amenities', 'attributes', 'images', 'isPublished',
]);

/**
 * Key names that must never appear in a public response. Compared after
 * lower-casing and stripping punctuation, so `customer_name`, `customerName`
 * and `Customer Name` are all caught.
 */
const FORBIDDEN_KEY_NAMES = Object.freeze([
  'customer', 'customerName', 'fullName', 'email', 'phone', 'organization',
  'internalNotes', 'reference', 'reservationId', 'reservationReference',
  'idempotencyKey', 'createdBy', 'notes', 'purpose', 'attendees', 'totalCents',
].map(normalizeKeyName));

const CAVEAT = 'Provisional only — this check does not hold the space. '
  + 'A booking is confirmed only once Nagaro staff confirm it.';

/** Architectural line icons for the three space categories (inline SVG, no external assets). */
const CATEGORY_ICON = Object.freeze({
  [SPACE_CATEGORY.MEETING_ROOM]: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M7 11l2.5-2.5L12 11l3-3"/></svg>',
  [SPACE_CATEGORY.AUDITORIUM]: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18M5 5v5a4 4 0 0 0 8 0V5M11 5v5a4 4 0 0 0 8 0V5M6 19c2-2 4-3 6-3s4 1 6 3M4 22c2.5-2 5.2-3 8-3s5.5 1 8 3"/></svg>',
  [SPACE_CATEGORY.COWORKING]: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="8" height="11" rx="1.5"/><rect x="13" y="8" width="8" height="8" rx="1.5"/><path d="M2 20h20M7 16v4M17 16v4"/></svg>',
});

/** The one sentence every acknowledgement page must carry. */
export const NOT_CONFIRMED_NOTICE = 'This request is not a confirmed booking yet. '
  + 'Nagaro staff will check the calendar and confirm it with you.';

/**
 * Honest delivery wording, keyed by the inquiry's stored `email_status`.
 * A saved inquiry is never described as a delivered email.
 */
export const EMAIL_STATUS_NOTICE = Object.freeze({
  SENT: 'Nagaro staff have been notified by email and will confirm your request.',
  NOT_CONFIGURED: 'Your request has been received and saved. Email delivery is not configured on '
    + 'this server, so Nagaro staff will see your request in the booking queue and contact you directly.',
  FAILED: 'Your request has been received and saved. A notification email could not be delivered, '
    + 'so Nagaro staff will see your request in the booking queue and contact you directly.',
  PENDING: 'Your request has been received and saved. The notification email has not been delivered '
    + 'yet — Nagaro staff will see your request in the booking queue either way.',
});

const UNKNOWN_EMAIL_NOTICE = 'Your request has been received and saved. No delivery confirmation is '
  + 'available, so Nagaro staff will see your request in the booking queue and contact you directly.';

/** Human wording for a form field, used to rewrite "field is required." */
const FIELD_WORDS = Object.freeze({
  customer_name: 'your name',
  email: 'your email address',
  phone: 'your telephone number',
  organization: 'your organisation',
  space_code: 'a space',
  space_id: 'a space',
  date: 'a date',
  start_time: 'a start time',
  end_time: 'an end time',
  start_at: 'a start date and time',
  end_at: 'an end date and time',
  attendees: 'the number of attendees',
  desk_quantity: 'the number of desks',
  message: 'a message',
});

/* ------------------------------------------------------------- small helpers */

function normalizeKeyName(key) {
  return String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isForbiddenKeyName(key) {
  return FORBIDDEN_KEY_NAMES.includes(normalizeKeyName(key));
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function humaniseKey(key) {
  const spaced = String(key ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

const humanMinutes = formatMinutes;

function attributeValue(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return text(value);
}

function locationLine(space) {
  return [
    space?.location || 'Trace Expert City',
    space?.floor ? `Floor ${space.floor}` : null,
  ].filter(Boolean).join(' · ');
}

function metaLine(parts) {
  const clean = parts.filter((part) => part !== null && part !== undefined && part !== '');
  if (clean.length === 0) return '';
  return html`<p class="space-card__meta">${clean.map((part) => html`<span>${part}</span>`)}</p>`;
}

/* ------------------------------------------------------------- the projection */

/** Category attributes are staff-authored: drop anything shaped like a private field. */
function safeAttributes(attributes) {
  const out = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (isForbiddenKeyName(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue; // never project nested structures
    out[key] = value;
  }
  return out;
}

function projectRateList(space, rates) {
  const source = Array.isArray(space.rateList) && space.rateList.length > 0
    ? space.rateList
    : Object.entries(rates).map(([unit, amountCents]) => ({ unit, amount_cents: amountCents }));
  return source
    .filter((rate) => rate && rate.unit)
    .map((rate) => {
      const raw = rate.amount_cents ?? rate.amountCents ?? 0;
      const amountCents = Number.isFinite(Number(raw)) ? Number(raw) : 0;
      return {
        unit: rate.unit,
        unitLabel: pricingUnitLabel(rate.unit),
        amountCents,
        amountLabel: money(amountCents, space.currency ?? 'LKR'),
        isDefault: (rate.is_default ?? rate.isDefault ?? 0) === 1 || (rate.is_default ?? rate.isDefault) === true,
      };
    })
    .sort((a, b) => a.amountCents - b.amountCents);
}

/**
 * Public projection of a space. Emits exactly `PUBLIC_SPACE_KEYS`.
 *
 * `availability` and `now` are accepted so every call site can pass the same
 * context, but they are deliberately NOT emitted: availability has its own
 * shape (counts and anonymous blocked periods only) and is served by
 * `getPublicAvailability()` / `/api/public/availability`.
 */
export function publicSpaceProjection(space, { images = [], availability = null, now = Date.now() } = {}) {
  if (!space) return null;
  void availability;
  void now;

  const rates = { ...(space.rates ?? {}) };
  const projectedImages = (Array.isArray(images) ? images : [])
    .filter((image) => image && image.id !== undefined)
    .map((image) => ({
      id: image.id,
      url: image.url ?? (image.storedName ? `/media/${image.storedName}` : null),
      altText: image.altText ?? null,
      isCover: Boolean(image.isCover),
    }));
  const amenities = Array.isArray(space.amenities)
    ? space.amenities.filter((item) => typeof item === 'string' && item.trim() !== '')
    : [];
  const category = space.category;
  const rateList = projectRateList(space, rates);

  const projection = {
    id: space.id,
    code: space.code,
    name: space.name,
    category,
    categoryLabel: space.categoryLabel ?? SPACE_CATEGORY_LABEL[category] ?? category,
    shortDescription: space.shortDescription ?? null,
    description: space.description ?? null,
    location: space.location ?? null,
    floor: space.floor ?? null,
    capacity: space.capacity,
    unitCount: space.unitCount ?? (Array.isArray(space.units) ? space.units.length : 0),
    openTime: space.openTime,
    closeTime: space.closeTime,
    minDurationMinutes: space.minDurationMinutes,
    maxDurationMinutes: space.maxDurationMinutes ?? null,
    bufferMinutes: space.bufferMinutes ?? 0,
    rates,
    rateList,
    rateSummary: spaceRateSummary({ rates, currency: space.currency ?? 'LKR' }),
    amenities,
    attributes: safeAttributes(space.attributes),
    images: projectedImages,
    isPublished: space.status === SPACE_STATUS.PUBLISHED,
  };
  return projection;
}

/* ------------------------------------------------------------ shared fragments */

/** Fallback artwork when a space has no photographs yet. */
const PLACEHOLDER_IMAGE = '/assets/placeholder-space.svg';

/** Cover image for a card, falling back to the first photograph. */
function coverImage(space) {
  const images = space?.images ?? [];
  return images.find((image) => image.isCover) ?? images[0] ?? null;
}

function altFor(image, space) {
  const alt = text(image?.altText).trim();
  return alt || `${space.name} at Nagaro, Trace Expert City`;
}

/**
 * Contract card: `.venue-grid > .venue-card`. Only real photograph URLs are
 * used; spaces without photographs render the bundled SVG placeholder.
 */
function venueCard(space) {
  const cover = coverImage(space);
  const src = cover?.url ?? PLACEHOLDER_IMAGE;
  const alt = cover ? altFor(cover, space) : `${space.name} at Nagaro, Trace Expert City (illustration placeholder)`;
  const meta = [
    space.location || 'Trace Expert City',
    space.floor ? `Floor ${space.floor}` : null,
    space.capacity ? `Up to ${space.capacity} people` : null,
    space.openTime && space.closeTime ? `${space.openTime}–${space.closeTime} SLST` : null,
  ].filter(Boolean).join(' · ');

  return html`<article class="venue-card" data-space-code="${space.code}" data-reveal>
    <a class="venue-card__media" href="/spaces/${space.code}" tabindex="-1" aria-hidden="true">
      <img src="${src}" alt="${alt}" loading="lazy">
      <span class="venue-card__tag">${space.categoryLabel}</span>
      <span class="venue-card__price">${space.rateSummary}</span>
    </a>
    <div class="venue-card__body">
      <h3 class="venue-card__name"><a href="/spaces/${space.code}">${space.name}</a></h3>
      <p class="venue-card__meta">${meta} · <code>${space.code}</code></p>
      ${space.shortDescription ? html`<p class="venue-card__blurb">${space.shortDescription}</p>` : ''}
      <div class="venue-card__foot">
        <a href="/spaces/${space.code}">View space →</a>
        <a href="/booking-request?space=${space.code}">Inquire →</a>
      </div>
    </div>
  </article>`;
}

function spaceGrid(spaces) {
  return html`<div class="venue-grid">${spaces.map((space) => venueCard(space))}</div>`;
}

/** Availability region. Mirrors the markup `public.js` writes after a JSON check. */
function availabilityResult(result) {
  const kind = result?.kind ?? 'idle';
  const classes = ['availability-result'];
  if (kind === 'ok') classes.push('availability-result--ok');
  if (kind === 'busy' || kind === 'error') classes.push('availability-result--busy');
  return html`<div class="${classes.join(' ')}" data-availability-result aria-live="polite">
    ${kind === 'idle'
    ? html`<p class="availability-result__headline">Check a date and time</p>
        <p class="hint availability-result__caveat">${CAVEAT}</p>`
    : html`<p class="availability-result__headline">${result.headline}</p>
        ${(result.details ?? []).filter(Boolean).map((detail) => html`<p class="availability-result__detail">${detail}</p>`)}
        ${result.problems && result.problems.length ? problemList(result.problems) : ''}
        <p class="hint availability-result__caveat">${CAVEAT}</p>`}
  </div>`;
}

/* ------------------------------------------------------------------ form parts */

function fieldMessage(field, message) {
  const value = text(message).trim();
  if (!value) return null;
  // "customer_name is required." -> "Your name is required."
  const required = /^([a-z0-9_]+) is required\.?$/.exec(value);
  if (required) {
    const words = FIELD_WORDS[field] ?? field.replace(/_/g, ' ');
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} is required.`;
  }
  return value;
}

/**
 * One labelled field. `control(describedBy)` renders the input and receives the
 * id list it must put in `aria-describedby`; errors get their own id so screen
 * readers announce them.
 */
function field({ id, label, hint = null, error = null, required = false, className = '', control }) {
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return html`<div class="form-field ${className}">
    <label for="${id}">${label}${required ? html` <span class="required-mark" aria-hidden="true">*</span>` : ''}</label>
    ${control(described)}
    ${hint ? html`<p class="hint" id="${id}-hint">${hint}</p>` : ''}
    ${error ? html`<p class="field-error" id="${id}-error" role="alert">${error}</p>` : ''}
  </div>`;
}

function input({ id, name, type = 'text', value = '', describedBy = '', invalid = false, ...rest }) {
  return html`<input id="${id}" name="${name}" type="${type}" value="${value}"
    ${attr('aria-describedby', describedBy || null)} ${attr('aria-invalid', invalid ? 'true' : null)}
    ${attr('required', rest.required === true)}
    ${attr('min', rest.min ?? null)} ${attr('max', rest.max ?? null)}
    ${attr('step', rest.step ?? null)} ${attr('minlength', rest.minLength ?? null)}
    ${attr('maxlength', rest.maxLength ?? null)}
    ${attr('placeholder', rest.placeholder ?? null)}
    ${attr('autocomplete', rest.autocomplete ?? null)}
    ${attr('inputmode', rest.inputMode ?? null)}>`;
}

function errorFor(details, fieldName, ...aliases) {
  if (!details || typeof details !== 'object') return null;
  for (const name of [fieldName, ...aliases]) {
    const message = details[name];
    if (typeof message === 'string' && message.trim()) return fieldMessage(fieldName, message);
  }
  return null;
}

function paginationNav({ page, pageSize, total, basePath, pairs = [] }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return '';
  const href = (target) => {
    const params = new URLSearchParams();
    for (const [key, value] of pairs) params.append(key, value);
    params.set('page', String(target));
    return `${basePath}?${params.toString()}`;
  };
  return html`<nav class="pagination" aria-label="Pagination">
    ${page > 1
    ? html`<a class="pagination__link" href="${href(page - 1)}" rel="prev">← Previous</a>`
    : html`<span class="pagination__spacer"></span>`}
    <span class="pagination__status">Page ${page} of ${pages} · ${total} total</span>
    ${page < pages
    ? html`<a class="pagination__link" href="${href(page + 1)}" rel="next">Next →</a>`
    : html`<span class="pagination__spacer"></span>`}
  </nav>`;
}

/* ==================================================================== pages */

const CATEGORY_TAGLINE = Object.freeze({
  [SPACE_CATEGORY.MEETING_ROOM]: 'Architecturally quiet boardrooms, executive suites and modular training studios equipped with high-lumen projection, acoustic treatment and enterprise Wi-Fi.',
  [SPACE_CATEGORY.AUDITORIUM]: 'A landmark tiered hall at Trace Expert City engineered for product keynotes, screenings, symposiums and full-company town halls with stage lighting and PA.',
  [SPACE_CATEGORY.COWORKING]: 'Ergonomic individual workstations and dedicated team benches in a daylight-filled studio floor, ready for focused daily, weekly or monthly residencies.',
});

const CATEGORY_UNITS = Object.freeze({
  [SPACE_CATEGORY.MEETING_ROOM]: 'Hourly · Half-day · Full-day',
  [SPACE_CATEGORY.AUDITORIUM]: 'Hourly · Half-day · Full-day',
  [SPACE_CATEGORY.COWORKING]: 'Daily · Weekly · Monthly',
});

/** First two real photograph URLs across featured spaces, padded with the placeholder. */
function heroPhotos(featured) {
  const urls = [];
  for (const space of featured ?? []) {
    for (const image of space.images ?? []) {
      if (image?.url && !urls.some((entry) => entry.url === image.url)) {
        urls.push({ url: image.url, alt: altFor(image, space), name: space.name, code: space.code });
      }
      if (urls.length >= 2) break;
    }
    if (urls.length >= 2) break;
  }
  while (urls.length < 2) {
    urls.push({
      url: PLACEHOLDER_IMAGE,
      alt: 'Illustration placeholder for Nagaro venues at Trace Expert City',
      name: null,
      code: null,
    });
  }
  return urls;
}

/** Earliest open to latest close across featured spaces, or null when unknown. */
function heroWindow(featured) {
  const opens = (featured ?? []).map((space) => space.openTime).filter(Boolean).sort();
  const closes = (featured ?? []).map((space) => space.closeTime).filter(Boolean).sort();
  if (!opens.length || !closes.length) return null;
  return `${opens[0]}–${closes[closes.length - 1]} SLST`;
}

/** Highest published capacity per category, from the featured (published) list. */
function maxCapacityByCategory(featured) {
  const out = {};
  for (const space of featured ?? []) {
    if (Number.isFinite(Number(space.capacity)) && Number(space.capacity) > 0) {
      out[space.category] = Math.max(out[space.category] ?? 0, Number(space.capacity));
    }
  }
  return out;
}

/** `GET /` — hero-premium, category rows, featured venue grid, steps, CTA band. */
export function renderHomePage({ featured = [], totalPublished = 0, categoryCounts = {} } = {}) {
  const categories = SPACE_CATEGORY_ORDER.map((category) => ({
    category,
    label: SPACE_CATEGORY_LABEL[category] ?? category,
    tagline: CATEGORY_TAGLINE[category] ?? '',
    units: CATEGORY_UNITS[category] ?? 'Flexible billing',
    count: categoryCounts[category] ?? 0,
  }));

  const photos = heroPhotos(featured);
  const window = heroWindow(featured);
  const capacityByCategory = maxCapacityByCategory(featured);
  const caption = photos[0].name
    ? { name: photos[0].name, code: photos[0].code }
    : (featured[0] ? { name: featured[0].name, code: featured[0].code } : null);

  const body = html`<section class="hero-premium" data-reveal>
    <div class="hero__grid">
      <div class="hero__copy">
        <p class="hero__eyebrow">Trace Expert City · Nagaro Venue Collection</p>
        <h1 class="hero__title">Rooms for <em>focused work</em>, halls for landmark events.</h1>
        <p class="hero__lede">Meeting rooms, executive training suites, the grand auditorium and co-working
          studios at Trace Expert City, Colombo — live provisional schedules, honest LKR rates and a
          staff-confirmed booking desk.</p>
        <form class="hero__search" method="get" action="/spaces" role="search" aria-label="Search spaces">
          <label class="hero__search-field">
            <span>Keyword</span>
            <input type="search" name="q" placeholder="Name, code or building" maxlength="80">
          </label>
          <label class="hero__search-field">
            <span>Date</span>
            <input type="date" name="date">
          </label>
          <label class="hero__search-field">
            <span>From</span>
            <input type="time" name="start_time" step="900">
          </label>
          <label class="hero__search-field">
            <span>To</span>
            <input type="time" name="end_time" step="900">
          </label>
          <button class="button button--primary" type="submit">Search spaces</button>
        </form>
        <dl class="hero__stats">
          <div><dt>Published venues</dt><dd>${totalPublished}</dd></div>
          <div><dt>Spatial typologies</dt><dd>${SPACE_CATEGORY_ORDER.length}</dd></div>
          ${window ? html`<div><dt>Opening window</dt><dd>${window}</dd></div>` : ''}
        </dl>
        <p class="hint">Online availability checks reflect the live calendar but never lock inventory —
          every reservation is verified and confirmed by the Nagaro operations desk.</p>
      </div>
      <div class="hero__media">
        <img class="hero__photo--a" src="${photos[0].url}" alt="${photos[0].alt}" loading="eager">
        <img class="hero__photo--b" src="${photos[1].url}" alt="${photos[1].alt}" loading="lazy">
        <span class="hero__stamp" aria-hidden="true">
          <svg viewBox="0 0 120 120" focusable="false">
            <defs><path id="hero-stamp-ring" d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0"/></defs>
            <text><textPath href="#hero-stamp-ring">TRACE EXPERT CITY · NAGARO VENUES ·&#160;</textPath></text>
          </svg>
        </span>
        ${caption
    ? html`<p class="hero__caption">Pictured: <a href="/spaces/${caption.code}">${caption.name}</a> at Trace Expert City</p>`
    : html`<p class="hero__caption">New venues are being prepared at Trace Expert City</p>`}
      </div>
    </div>
  </section>

  <section class="section" data-reveal>
    <div class="section__head">
      <span class="section__index">01</span>
      <h2 class="section__title">What you can book</h2>
      <p class="section__lede">Three distinct spatial typologies across Trace Expert City, with
        ${totalPublished === 1 ? '1 venue published' : `${totalPublished} venues published`} right now.</p>
    </div>
    ${categories.map((item, index) => {
    const representative = featured.find((space) => space.category === item.category) ?? null;
    const repCover = representative ? coverImage(representative) : null;
    const src = repCover?.url ?? PLACEHOLDER_IMAGE;
    const alt = repCover && representative ? altFor(repCover, representative)
      : `${item.label} at Nagaro, Trace Expert City (illustration placeholder)`;
    const maxCap = capacityByCategory[item.category] ?? null;
    return html`<article class="cat-row ${index % 2 === 1 ? 'cat-row--flip' : ''}" data-reveal>
      <a class="cat-row__media" href="/spaces?category=${item.category}" tabindex="-1" aria-hidden="true">
        <img src="${src}" alt="${alt}" loading="lazy">
      </a>
      <div class="cat-row__body">
        <p class="cat-row__kicker">Typology · ${item.count === 1 ? '1 venue published' : `${item.count} venues published`}</p>
        <h3 class="cat-row__title">${item.label}</h3>
        <p class="cat-row__text">${item.tagline}</p>
        <ul class="cat-row__facts">
          <li>${item.count === 1 ? '1 published venue' : `${item.count} published venues`}</li>
          <li>${item.units}</li>
          ${maxCap ? html`<li>Up to ${maxCap} people</li>` : ''}
        </ul>
        <a href="/spaces?category=${item.category}">Explore ${item.label} →</a>
      </div>
    </article>`;
  })}
  </section>

  <section class="section" data-reveal>
    <div class="section__head">
      <span class="section__index">02</span>
      <h2 class="section__title">Featured spaces</h2>
      <p class="section__lede">Published architectural rooms, halls and desk studios at Trace Expert City,
        with capacities and transparent LKR rates.</p>
    </div>
    ${featured.length
    ? html`${spaceGrid(featured)}
      <p><a href="/spaces">View full directory →</a></p>`
    : emptyState(
      'No spaces are published yet.',
      'Nagaro staff are still preparing the catalogue. Please check back shortly.',
    )}
  </section>

  <section class="section" data-reveal>
    <div class="section__head">
      <span class="section__index">03</span>
      <h2 class="section__title">How a request to book works</h2>
      <p class="section__lede">Live calendar transparency paired with human operational review, so every room
        setup, turnaround buffer and desk allocation is guaranteed.</p>
    </div>
    <div class="steps">
      <article class="step" data-reveal>
        <span class="step__num">01</span>
        <h3 class="step__title">Inspect space &amp; provisional schedule</h3>
        <p class="step__text">Explore room capacities, technical amenities, turnaround buffers and LKR rate
          schedules. Run a live provisional check for your preferred date and time window.</p>
      </article>
      <article class="step" data-reveal>
        <span class="step__num">02</span>
        <h3 class="step__title">Submit a booking inquiry</h3>
        <p class="step__text">Send your preferred schedule, attendee count and setup notes. You receive an
          immediate reference code (<code>INQ-YYYY-NNNNN</code>) and a private self-service withdrawal link.</p>
      </article>
      <article class="step" data-reveal>
        <span class="step__num">03</span>
        <h3 class="step__title">Operations desk confirmation</h3>
        <p class="step__text">Nagaro staff review the calendar, verify layout and catering or AV requirements
          with you, and issue a formal confirmed reservation that locks the inventory.</p>
      </article>
    </div>
    <div class="cta-band" data-reveal>
      <p class="cta-band__title">Requests carry no payment and no automatic hold — confirmation is always human.</p>
      <p><a class="button button--primary" href="/booking-request">Request a booking</a>
        <a class="button button--ghost" href="/spaces">Browse spaces</a></p>
    </div>
  </section>`;

  return publicShell({
    title: 'Nagaro spaces at Trace Expert City',
    description: 'Book meeting rooms, the auditorium and co-working desks at Nagaro, Trace Expert City, Colombo. '
      + 'Check availability and send a request to book.',
    activePath: '/',
    pageClass: 'page--home',
    body,
  });
}

/** `GET /spaces` — the published directory with filters and pagination. */
export function renderSpaceDirectoryPage({
  spaces = [], total = 0, publishedTotal = 0, page = 1, pageSize = 12,
  filters = {}, amenityOptions = [], pricingUnitOptions = [],
} = {}) {
  const pairs = filterPairs(filters);
  const selected = new Set(filters.amenities ?? []);
  const summary = filterSummary(filters);
  const hasActiveFilters = pairs.length > 0;

  const categoryChips = [
    { code: '', label: `All venues (${publishedTotal})` },
    { code: SPACE_CATEGORY.MEETING_ROOM, label: 'Meeting & training rooms' },
    { code: SPACE_CATEGORY.AUDITORIUM, label: 'Auditorium' },
    { code: SPACE_CATEGORY.COWORKING, label: 'Co-working desks' },
  ];

  const body = html`<section class="container">
    <header data-reveal>
      <p class="section-eyebrow">Trace Expert City · Venue Directory</p>
      <h1 class="page-title">Spaces &amp; Architectural Venues</h1>
      <p class="section-subtitle">Every published room, hall and co-working studio managed by Nagaro at Trace
        Expert City. Filter by capacity, billing unit or technical amenity. Availability shown on any venue
        page is provisional.</p>
    </header>

    <div class="discover">
      <aside class="discover__filters" data-reveal>
        <h2>Refine venues</h2>
        <nav class="chip-group" aria-label="Quick category filter">
          ${categoryChips.map((item) => {
    const active = (filters.category ?? '') === item.code;
    const href = item.code ? `/spaces?category=${item.code}` : '/spaces';
    return html`<a href="${href}" class="chip ${active ? 'is-active' : ''}"
              ${active ? raw('aria-current="page"') : ''}>${item.label}</a>`;
  })}
        </nav>
        <form method="get" action="/spaces" role="search" aria-label="Filter spaces">
          <div class="filter-group">
            <label for="filter-q">Keyword search</label>
            <input id="filter-q" name="q" type="search" value="${filters.q ?? ''}"
                   placeholder="Name, code or building" maxlength="80">
          </div>

          <div class="filter-group">
            <label for="filter-category">Category</label>
            <select id="filter-category" name="category">
              <option value="">All categories</option>
              ${SPACE_CATEGORY_ORDER.map((category) => html`<option value="${category}"
                ${attr('selected', filters.category === category)}>${SPACE_CATEGORY_LABEL[category] ?? category}</option>`)}
            </select>
          </div>

          <div class="filter-group">
            <label for="filter-capacity">Minimum capacity</label>
            <input id="filter-capacity" name="min_capacity" type="number" min="1" max="100000"
                   placeholder="e.g. 12 people"
                   value="${filters.minCapacity === null || filters.minCapacity === undefined ? '' : filters.minCapacity}">
          </div>

          <div class="filter-group">
            <label for="filter-pricing">Pricing unit</label>
            <select id="filter-pricing" name="pricing_unit">
              <option value="">Any pricing unit</option>
              ${pricingUnitOptions.map((unit) => html`<option value="${unit}"
                ${attr('selected', filters.pricingUnit === unit)}>${pricingUnitLabel(unit)}</option>`)}
            </select>
          </div>

          <div class="filter-group">
            <label for="filter-sort">Sort order</label>
            <select id="filter-sort" name="sort">
              ${[['name', 'Name (A–Z)'], ['capacity', 'Capacity (high to low)'], ['price', 'Starting rate (low to high)']].map(([value, label]) => html`<option value="${value}"
                ${attr('selected', (filters.sort ?? 'name') === value)}>${label}</option>`)}
            </select>
          </div>

          ${amenityOptions.length
    ? html`<fieldset class="filter-group">
              <legend>Amenities${selected.size ? ` (${selected.size} selected)` : ''}</legend>
              ${amenityOptions.map((amenity) => html`<label for="amenity-${slugId(amenity)}">
                <input id="amenity-${slugId(amenity)}" type="checkbox" name="amenity" value="${amenity}"
                       ${attr('checked', selected.has(amenity))}>
                <span>${amenity}</span>
              </label>`)}
            </fieldset>`
    : ''}

          <div>
            <button class="button button--primary button--block" type="submit">Apply filters</button>
            <a href="/spaces">Reset filters</a>
          </div>
        </form>
      </aside>

      <div class="discover__results" data-reveal>
        <p class="result-count">
          <strong>${total === 1 ? '1 space matches' : `${total} spaces match`}</strong>${summary ? ` ${summary}` : ''}
          · ${publishedTotal} published in total.
        </p>
        ${hasActiveFilters
    ? html`<p><a href="/spaces">Clear active filters</a></p>`
    : ''}

        ${spaces.length
    ? spaceGrid(spaces)
    : emptyState('No spaces match those filters.', 'Try removing a filter, or reset to browse every published space at Trace Expert City.')}

        ${paginationNav({ page, pageSize, total, basePath: '/spaces', pairs })}
      </div>
    </div>
  </section>`;

  return publicShell({
    title: 'Spaces',
    description: 'The published Nagaro spaces at Trace Expert City: meeting rooms, the auditorium and '
      + 'co-working desks, with capacity, amenities and rates.',
    activePath: '/spaces',
    pageClass: 'page--directory',
    body,
  });
}

function slugId(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'amenity';
}

function filterPairs(filters) {
  const pairs = [];
  if (filters.q) pairs.push(['q', filters.q]);
  if (filters.category) pairs.push(['category', filters.category]);
  if (filters.minCapacity !== null && filters.minCapacity !== undefined) {
    pairs.push(['min_capacity', String(filters.minCapacity)]);
  }
  for (const amenity of filters.amenities ?? []) pairs.push(['amenity', amenity]);
  if (filters.pricingUnit) pairs.push(['pricing_unit', filters.pricingUnit]);
  if (filters.sort && filters.sort !== 'name') pairs.push(['sort', filters.sort]);
  return pairs;
}

function filterSummary(filters) {
  const parts = [];
  if (filters.q) parts.push(`matching “${filters.q}”`);
  if (filters.category) parts.push(`in ${categoryLabel(filters.category).toLowerCase()}`);
  if (filters.minCapacity) parts.push(`for ${filters.minCapacity} people or more`);
  for (const amenity of filters.amenities ?? []) parts.push(`with ${amenity}`);
  if (filters.pricingUnit) parts.push(`priced ${pricingUnitLabel(filters.pricingUnit)}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

function renderSelectedVenuePreview(chosen) {
  if (!chosen) {
    return html`<div class="card card--preview">
      <div class="card__body stack">
        <p class="section-eyebrow">Venue Selection</p>
        <h2 class="section-title">Choosing the right space</h2>
        <p class="hint">Select a published venue from the menu on the left to attach your inquiry to a specific room, auditorium or co-working desk pool.</p>
        <dl class="detail-list detail-list--inline">
          <dt>Meeting rooms</dt><dd>Hourly, half-day &amp; full-day sessions</dd>
          <dt>Auditorium</dt><dd>Conferences, launches &amp; town halls</dd>
          <dt>Co-working</dt><dd>1 or more desks by day, week or month</dd>
        </dl>
        <a class="button button--ghost button--small" href="/spaces">Compare spaces in directory →</a>
      </div>
    </div>`;
  }

  const cover = coverImage(chosen);
  return html`<div class="card card--preview">
    ${cover
    ? html`<a class="space-card__media" href="/spaces/${chosen.code}">
        <img src="${cover.url}" alt="${altFor(cover, chosen)}" loading="lazy">
        <span class="space-card__badge">${chosen.categoryLabel}</span>
      </a>`
    : ''}
    <div class="card__body stack">
      <div>
        <p class="section-eyebrow">Selected Venue · <code>${chosen.code}</code></p>
        <h2 class="section-title"><a href="/spaces/${chosen.code}">${chosen.name}</a></h2>
        <p class="hint">${chosen.categoryLabel}${chosen.location ? ` · ${locationLine(chosen)}` : ' · Trace Expert City'}</p>
      </div>
      <dl class="detail-list detail-list--inline">
        ${chosen.capacity ? html`<dt>Capacity</dt><dd>Up to ${chosen.capacity} people</dd>` : ''}
        <dt>Operating window</dt>
        <dd>${chosen.openTime && chosen.closeTime ? `${chosen.openTime}–${chosen.closeTime} SLST` : 'Standard campus hours (SLST)'}</dd>
        ${chosen.rateSummary ? html`<dt>Rates</dt><dd>${chosen.rateSummary}</dd>` : ''}
      </dl>
      <a class="button button--ghost button--small" href="/spaces/${chosen.code}">View venue images &amp; live schedule →</a>
    </div>
  </div>`;
}

/** `GET /booking-request` — the request-to-book form (pre-fillable, re-renderable). */
export function renderBookingRequestPage({
  spaces = [], values = {}, errors = null, problems = [], status = 200,
} = {}) {
  void status;
  const alertProblems = problems.length > 0 && problems.length <= 8 ? problems : [];
  const chosenCode = text(values.space_code).toUpperCase();
  const chosen = spaces.find((space) => space.code.toUpperCase() === chosenCode) ?? null;
  const desksHint = chosen && chosen.category === SPACE_CATEGORY.COWORKING
    ? 'How many desks do you need? Leave blank for one.'
    : 'Only used for co-working desk requests.';

  const body = html`<section class="container booking-flow" data-reveal>
    <header class="venue-hero">
      <div>
        <p class="section-eyebrow">Nagaro Concierge Desk · Trace Expert City</p>
        <h1 class="page-title">Request a booking</h1>
        <p class="section-subtitle">Tell us which venue and schedule you need. Nagaro staff verify every calendar request by hand and confirm the reservation with you — submitting this inquiry does not lock inventory and carries no payment.</p>
      </div>
      <ol class="flow-progress" aria-label="Request progress">
        <li class="is-current"><span class="flow-progress__num">1</span> Space &amp; schedule</li>
        <li><span class="flow-progress__num">2</span> Contact details</li>
        <li><span class="flow-progress__num">3</span> Review &amp; send</li>
      </ol>
    </header>

    ${problems.length
    ? html`<div class="alert alert--error" role="alert" data-flash>
        <p>Please check ${problems.length === 1 ? 'one field' : `${problems.length} fields`} below and send the request again.</p>
        ${alertProblems.length ? html`<ul>${alertProblems.map((problem) => html`<li>${problem}</li>`)}</ul>` : ''}
        <button type="button" class="alert__close" data-dismiss aria-label="Dismiss">×</button>
      </div>`
    : ''}

    <div class="split-layout inquiry-layout">
      <div class="inquiry-main">
        <div class="card form-card">
          <div class="card__body">
            <form method="post" action="/booking-request" class="stack" autocomplete="on" data-submit-once>
              <fieldset class="form-section">
                <legend class="form-section__title">01 · Space &amp; Preferred Schedule</legend>
                <p class="form-section__desc hint">All times are in Sri Lanka Standard Time (UTC+5:30). Single requests must start and finish on the same calendar day.</p>
                <div class="form-grid">
                  ${field({
    id: 'space_code', label: 'Space', required: true, className: 'form-field--full',
    hint: 'Only published spaces can be requested.',
    error: errorFor(errors, 'space_code', 'space_id'),
    control: (described) => html`<select id="space_code" name="space_code" required
        ${attr('aria-describedby', described || null)}
        ${attr('aria-invalid', errorFor(errors, 'space_code', 'space_id') ? 'true' : null)}>
      <option value="">Choose a space…</option>
      ${spaces.map((space) => html`<option value="${space.code}"
        ${attr('selected', space.code.toUpperCase() === chosenCode)}>${space.name} — ${space.categoryLabel}</option>`)}
    </select>`,
  })}
                  ${field({
    id: 'date', label: 'Date', required: true, className: 'form-field--full',
    hint: 'Your booking cannot span more than one day in a single request.',
    error: errorFor(errors, 'date', 'start_at', 'end_at'),
    control: (described) => input({
      id: 'date', name: 'date', type: 'date', value: values.date ?? '',
      describedBy: described, required: true, min: values.today ?? null,
      invalid: Boolean(errorFor(errors, 'date', 'start_at')),
    }),
  })}
                  ${field({
    id: 'start_time', label: 'Start time', required: true,
    error: errorFor(errors, 'start_time', 'start_at'),
    control: (described) => input({
      id: 'start_time', name: 'start_time', type: 'time', value: values.start_time ?? '',
      describedBy: described, required: true, step: '900',
      invalid: Boolean(errorFor(errors, 'start_time', 'start_at')),
    }),
  })}
                  ${field({
    id: 'end_time', label: 'End time', required: true,
    error: errorFor(errors, 'end_time', 'end_at'),
    control: (described) => input({
      id: 'end_time', name: 'end_time', type: 'time', value: values.end_time ?? '',
      describedBy: described, required: true, step: '900',
      invalid: Boolean(errorFor(errors, 'end_time', 'end_at')),
    }),
  })}
                  ${field({
    id: 'desks', label: 'Desks (optional)', required: false,
    hint: desksHint,
    error: errorFor(errors, 'desks', 'desk_quantity'),
    control: (described) => input({
      id: 'desks', name: 'desks', type: 'number', value: values.desks ?? '',
      describedBy: described, min: '1', max: '500', inputMode: 'numeric',
      invalid: Boolean(errorFor(errors, 'desks', 'desk_quantity')),
    }),
  })}
                  ${field({
    id: 'attendees', label: 'Expected attendees (optional)', required: false,
    error: errorFor(errors, 'attendees'),
    control: (described) => input({
      id: 'attendees', name: 'attendees', type: 'number', value: values.attendees ?? '',
      describedBy: described, min: '0', max: '100000', inputMode: 'numeric',
      invalid: Boolean(errorFor(errors, 'attendees')),
    }),
  })}
                </div>
              </fieldset>

              <fieldset class="form-section">
                <legend class="form-section__title">02 · Your Contact Details</legend>
                <p class="form-section__desc hint">Used exclusively by Nagaro staff to verify and confirm this booking request.</p>
                <div class="form-grid">
                  ${field({
    id: 'customer_name', label: 'Your name', required: true,
    error: errorFor(errors, 'customer_name'),
    control: (described) => input({
      id: 'customer_name', name: 'customer_name', value: values.customer_name ?? '',
      describedBy: described, required: true, maxLength: 160, autocomplete: 'name',
      invalid: Boolean(errorFor(errors, 'customer_name')),
    }),
  })}
                  ${field({
    id: 'email', label: 'Email address', required: true,
    hint: 'We send the confirmation here.',
    error: errorFor(errors, 'email'),
    control: (described) => input({
      id: 'email', name: 'email', type: 'email', value: values.email ?? '',
      describedBy: described, required: true, maxLength: 254, autocomplete: 'email',
      invalid: Boolean(errorFor(errors, 'email')),
    }),
  })}
                  ${field({
    id: 'phone', label: 'Telephone (optional)', required: false,
    error: errorFor(errors, 'phone'),
    control: (described) => input({
      id: 'phone', name: 'phone', type: 'tel', value: values.phone ?? '',
      describedBy: described, maxLength: 40, autocomplete: 'tel',
      invalid: Boolean(errorFor(errors, 'phone')),
    }),
  })}
                  ${field({
    id: 'organization', label: 'Organisation (optional)', required: false,
    error: errorFor(errors, 'organization'),
    control: (described) => input({
      id: 'organization', name: 'organization', value: values.organization ?? '',
      describedBy: described, maxLength: 160, autocomplete: 'organization',
      invalid: Boolean(errorFor(errors, 'organization')),
    }),
  })}
                </div>
              </fieldset>

              <fieldset class="form-section">
                <legend class="form-section__title">03 · Event Notes &amp; Requirements</legend>
                <div class="form-grid">
                  ${field({
    id: 'message', label: 'Anything else? (optional)', required: false, className: 'form-field--full',
    hint: 'Equipment, layout, accessibility needs, or a preferred contact time.',
    error: errorFor(errors, 'message'),
    control: (described) => html`<textarea id="message" name="message" rows="4" maxlength="2000"
        ${attr('aria-describedby', described || null)}
        ${attr('aria-invalid', errorFor(errors, 'message') ? 'true' : null)}>${values.message ?? ''}</textarea>`,
  })}
                </div>
                <div class="form-actions">
                  <button class="button button--primary button--large" type="submit">Send booking request</button>
                  <a class="button button--ghost button--large" href="/spaces">Browse spaces</a>
                </div>
                <p class="hint">Sending this form saves a request for Nagaro staff. It is not a
                  confirmed booking, does not reserve inventory, and nothing is charged.</p>
              </fieldset>
            </form>
          </div>
        </div>
      </div>

      <aside class="inquiry-aside stack">
        ${renderSelectedVenuePreview(chosen)}

        <div class="card">
          <div class="card__body stack">
            <p class="section-eyebrow">Verification Protocol</p>
            <h2 class="section-title">What happens next</h2>
            <ol class="inquiry-steps">
              <li><strong>Instant reference issued:</strong> Your request is recorded in the Nagaro operations queue with a unique <code>INQ-YYYY-NNNNN</code> reference.</li>
              <li><strong>Calendar &amp; buffer review:</strong> Our team checks turnaround buffers, room configuration and desk pool capacity for your requested window.</li>
              <li><strong>Direct confirmation:</strong> Staff contact you to finalise billing and issue a confirmed reservation. Only then is the space held.</li>
            </ol>
            <p class="hint">Need to cancel an inquiry before staff respond? Use the private withdrawal link provided on your acknowledgement screen.</p>
          </div>
        </div>
      </aside>
    </div>
  </section>`;

  return publicShell({
    title: 'Request a booking',
    description: 'Send Nagaro a request to book a meeting room, the auditorium or co-working desks at '
      + 'Trace Expert City. Staff confirm every booking by hand.',
    activePath: '/booking-request',
    pageClass: 'page--request',
    body,
  });
}

/** `GET /booking-request/received` — truthful acknowledgement of a submitted request. */
export function renderBookingReceivedPage({ inquiry, token = null } = {}) {
  const notice = EMAIL_STATUS_NOTICE[inquiry?.emailStatus] ?? UNKNOWN_EMAIL_NOTICE;
  const reference = inquiry?.reference ?? '';
  const withdrawHref = token
    ? `/booking-request/withdraw?ref=${encodeURIComponent(reference)}&token=${encodeURIComponent(token)}`
    : null;

  const body = html`<section class="container stack">
    <div class="card card--acknowledgement">
      <div class="card__body stack">
        <div class="cluster">
          <p class="tag tag--info">Request received</p>
          <span class="hint">Reference <code>${reference}</code></span>
        </div>
        <h1 class="page-title">Your booking request has been received</h1>
        <div class="alert alert--warning" role="status">
          <p><strong>${NOT_CONFIRMED_NOTICE}</strong></p>
          <p>${notice}</p>
        </div>

        <dl class="detail-list">
          <dt>Reference</dt><dd><code>${reference}</code></dd>
          <dt>Space</dt><dd>${inquiry?.spaceName ?? '—'}${inquiry?.categoryLabel ? html` (${inquiry.categoryLabel})` : ''}</dd>
          <dt>Requested period</dt>
          <dd>${inquiry?.startAt && inquiry?.endAt ? periodLabel(inquiry.startAt, inquiry.endAt) : '—'}
            <span class="hint">Sri Lanka Standard Time</span></dd>
          ${inquiry?.deskQuantity
    ? html`<dt>Desks requested</dt><dd>${inquiry.deskQuantity}</dd>`
    : ''}
          <dt>Status of this request</dt>
          <dd>${inquiry?.status ? statusBadge(inquiry.status) : '—'}</dd>
        </dl>

        <p class="hint">Keep this reference. Nagaro staff use it when they contact you, and the
          withdrawal link below is the only way to cancel the request yourself.</p>

        <div class="cluster">
          <a class="button button--primary" href="/spaces">Browse more spaces</a>
          <a class="button button--ghost" href="/booking-request">Send another request</a>
          ${withdrawHref
    ? html`<a class="button button--danger button--small" href="${withdrawHref}">Withdraw this request</a>`
    : ''}
        </div>
        ${withdrawHref ? '' : html`<p class="hint">If you need to withdraw this request, use the
          withdrawal link in the acknowledgement email from Nagaro.</p>`}
      </div>
    </div>
  </section>`;

  return publicShell({
    title: 'Request received',
    description: `Your booking request ${reference} has been received by Nagaro. `
      + 'It is not a confirmed booking until staff confirm it.',
    activePath: '/booking-request',
    pageClass: 'page--received',
    body,
  });
}

/** `GET /booking-request/withdraw` — the confirmation form (only with ref + token). */
export function renderWithdrawFormPage({ reference = '', token = '' } = {}) {
  const body = html`<section class="container stack">
    <div class="card">
      <div class="card__body stack">
        <p class="tag tag--warn">Self-service withdrawal</p>
        <h1 class="page-title">Withdraw a booking request</h1>
        <p>You are about to withdraw request <code>${reference}</code>.</p>
        <p>Withdrawing tells Nagaro staff you no longer need this space. It cannot be undone here —
          you would have to send a new request.</p>
        <form method="post" action="/booking-request/withdraw"
              data-confirm="Withdraw this booking request? It cannot be undone.">
          <input type="hidden" name="reference" value="${reference}">
          <input type="hidden" name="token" value="${token}">
          <div class="form-actions">
            <button class="button button--danger" type="submit">Withdraw this request</button>
            <a class="button button--ghost" href="/">Keep the request</a>
          </div>
        </form>
        <p class="hint">For privacy we do not show the details of the request on this page.</p>
      </div>
    </div>
  </section>`;

  return publicShell({
    title: 'Withdraw a request',
    description: 'Confirm the withdrawal of a Nagaro booking request made with your reference and withdrawal link.',
    activePath: '/booking-request',
    pageClass: 'page--withdraw',
    body,
  });
}

/** Result of a successful `POST /booking-request/withdraw`. */
export function renderWithdrawalConfirmedPage({ reference = '', status = 'WITHDRAWN' } = {}) {
  const body = html`<section class="container stack">
    <div class="card">
      <div class="card__body stack">
        <p class="tag">Request withdrawn</p>
        <h1 class="page-title">Booking request withdrawn</h1>
        <p>Request <code>${reference}</code> is now marked
          ${status === 'WITHDRAWN' ? html`<strong>withdrawn</strong>` : html`<strong>${status}</strong>`}.
          Nagaro staff will not treat it as a booking request.</p>
        <p>Nothing was reserved, so there is nothing to release. If this was a mistake, please send a
          new request or contact Nagaro reception at Trace Expert City.</p>
        <div class="cluster">
          <a class="button button--primary" href="/spaces">Browse spaces</a>
          <a class="button button--ghost" href="/booking-request">Send a new request</a>
        </div>
      </div>
    </div>
  </section>`;

  return publicShell({
    title: 'Request withdrawn',
    description: `Booking request ${reference} has been withdrawn.`,
    activePath: '/booking-request',
    pageClass: 'page--withdraw',
    body,
  });
}

/**
 * `GET /spaces/:code` — one published space: gallery, description, amenities,
 * category attributes, rates, the availability checker and the request CTA.
 * `space` is a `publicSpaceProjection()` result; `check` is the server-rendered
 * answer for the no-JavaScript checker.
 */
export function renderSpaceDetailPage({ space, check = {}, requestHref = '/booking-request' } = {}) {
  const values = check.values ?? {};
  const images = space.images ?? [];
  const main = coverImage(space);
  const attributes = Object.entries(space.attributes ?? {});

  const durationText = `${formatMinutes(space.minDurationMinutes)}${space.maxDurationMinutes ? ` – ${formatMinutes(space.maxDurationMinutes)}` : ' min'}`;
  const bufferText = space.bufferMinutes > 0 ? `${space.bufferMinutes}m prep buffer` : 'Back-to-back allowed';
  const inventoryText = space.category === SPACE_CATEGORY.COWORKING
    ? `${space.unitCount} individual desks`
    : '1 exclusive venue';

  const body = html`<section class="container stack">
    <header class="venue-hero" data-reveal>
      <nav class="breadcrumbs" aria-label="Breadcrumb"><ol>
        <li><a href="/">Home</a></li>
        <li><a href="/spaces">Spaces</a></li>
        <li><span aria-current="page">${space.name}</span></li>
      </ol></nav>

      <div class="venue-header__main">
        <div class="venue-header__copy">
          <div class="venue-header__badges cluster">
            <span class="tag tag--info">${space.categoryLabel}</span>
            <span class="venue-code">Code <code>${space.code}</code></span>
            ${space.isPublished ? '' : html`<span class="tag tag--warn">Not published</span>`}
          </div>
          <h1 class="page-title">${space.name}</h1>
          <ul class="venue-facts">
            <li>${space.location || 'Trace Expert City'}</li>
            ${space.floor ? html`<li>Floor ${space.floor}</li>` : ''}
            ${space.capacity ? html`<li>Up to ${space.capacity} people</li>` : ''}
          </ul>
        </div>
        <div class="venue-header__actions cluster">
          <a class="button button--primary" href="${requestHref}">Request this space</a>
          <a class="button button--ghost" href="/spaces">All spaces</a>
        </div>
      </div>
    </header>

    ${images.length
    ? html`<div class="gallery gallery-premium gallery--venue" data-reveal>
        <div class="gallery__stage">
          <img data-gallery-main class="gallery__main"
               src="${(main ?? images[0]).url}" alt="${altFor(main ?? images[0], space)}">
        </div>
        ${images.length > 1
    ? html`<div class="gallery__thumbs" role="group" aria-label="Venue images">
            ${images.map((image, index) => html`<button type="button" class="gallery__item ${index === 0 ? 'is-active' : ''}"
              data-gallery-thumb data-src="${image.url}" data-alt="${altFor(image, space)}"
              aria-current="${index === 0 ? 'true' : 'false'}"
              aria-label="Show image ${index + 1} of ${images.length}: ${altFor(image, space)}${image.isCover ? ' (Cover)' : ''}">
              <img src="${image.url}" alt="${altFor(image, space)}" loading="lazy">
              ${image.isCover ? html`<span class="gallery__cover">Cover</span>` : ''}
            </button>`)}
          </div>`
    : html`<div class="gallery__thumbs" hidden>
            <button type="button" class="gallery__item is-active"
              data-gallery-thumb data-src="${images[0].url}" data-alt="${altFor(images[0], space)}"
              aria-current="true"
              aria-label="Show image 1 of 1: ${altFor(images[0], space)}">
              <img src="${images[0].url}" alt="${altFor(images[0], space)}" loading="lazy">
            </button>
          </div>`}
      </div>`
    : html`<div class="gallery gallery--venue gallery--empty"><span class="hint">No image has been added for this space yet.</span></div>`}

    <dl class="spec-strip spec-ribbon" aria-label="Key venue specifications" data-reveal>
      <div class="spec spec-ribbon__item">
        <dt class="spec__k">Capacity</dt>
        <dd class="spec__v">Up to ${space.capacity} people</dd>
      </div>
      <div class="spec spec-ribbon__item">
        <dt class="spec__k">Inventory</dt>
        <dd class="spec__v">${inventoryText}</dd>
      </div>
      <div class="spec spec-ribbon__item">
        <dt class="spec__k">Operating Hours</dt>
        <dd class="spec__v">${space.openTime}–${space.closeTime} SLST</dd>
      </div>
      <div class="spec spec-ribbon__item">
        <dt class="spec__k">Booking Duration</dt>
        <dd class="spec__v">${durationText}</dd>
      </div>
      <div class="spec spec-ribbon__item">
        <dt class="spec__k">Turnaround Buffer</dt>
        <dd class="spec__v">${bufferText}</dd>
      </div>
    </dl>

    <div class="detail-grid split-layout venue-layout" data-reveal>
      <div class="venue-main stack">
        <article class="card">
          <div class="card__body stack">
            <p class="section-eyebrow">Architectural Overview</p>
            <h2 class="section-title">About this space</h2>
            <p class="venue-lead">${space.description || space.shortDescription || 'Nagaro staff will describe this space shortly.'}</p>
          </div>
        </article>

        ${space.amenities.length
    ? html`<article class="card">
            <div class="card__body stack">
              <p class="section-eyebrow">Included Equipment &amp; Services</p>
              <h2 class="section-title">Facilities &amp; Amenities</h2>
              <ul class="amenity-list">
                ${space.amenities.map((amenity) => html`<li class="amenity-list__item">${amenity}</li>`)}
              </ul>
            </div>
          </article>`
    : ''}

        ${attributes.length
    ? html`<article class="card">
            <div class="card__body stack">
              <p class="section-eyebrow">Technical &amp; Spatial Specifications</p>
              <h2 class="section-title">Good to know</h2>
              <dl class="detail-list">
                ${attributes.map(([key, value]) => html`<dt>${humaniseKey(key)}</dt><dd>${attributeValue(value)}</dd>`)}
              </dl>
            </div>
          </article>`
    : ''}

        <article class="card">
          <div class="card__body stack">
            <p class="section-eyebrow">Transparent Pricing</p>
            <h2 class="section-title">Rate Schedule</h2>
            ${space.rateList.length
    ? html`<table class="rate-table">
                <caption class="hint">Rates are quoted in LKR and exclude any agreed extras.</caption>
                <thead>
                  <tr><th scope="col">Billing unit</th><th scope="col">Rate</th></tr>
                </thead>
                <tbody>
                  ${space.rateList.map((rate) => html`<tr class="${rate.isDefault ? 'rate-table__default' : ''}">
                    <th scope="row">${rate.unitLabel}${rate.isDefault ? html` <span class="tag tag--info">Default unit</span>` : ''}</th>
                    <td><strong>${rate.amountLabel}</strong></td>
                  </tr>`)}
                </tbody>
              </table>`
    : html`<p>Rate on request — mention what you need in your request and Nagaro staff will quote you.</p>`}
            <p class="hint">A request to book is not a confirmed booking and carries no payment.</p>
          </div>
        </article>
      </div>

      <aside class="venue-aside stack">
        <div class="card card--concierge book-panel">
          <div class="card__body stack">
            <div>
              <p class="section-eyebrow">Provisional Schedule Check</p>
              <h2 class="section-title">Check availability &amp; inquire</h2>
              <p class="book-panel__price price price--accent">${space.rateSummary}</p>
            </div>
            <form class="availability-checker" method="get" action="/spaces/${space.code}"
                  data-availability-form data-space="${space.code}" data-space-code="${space.code}">
              ${field({
    id: 'check-date', label: 'Date', required: false,
    control: (described) => input({
      id: 'check-date', name: 'date', type: 'date', value: values.date ?? '',
      describedBy: described, min: check.today ?? null,
    }),
  })}
              <div class="form-grid">
                ${field({
    id: 'check-start', label: 'From', required: false,
    control: (described) => input({
      id: 'check-start', name: 'start_time', type: 'time', value: values.startTime ?? '',
      describedBy: described, step: '900',
    }),
  })}
                ${field({
    id: 'check-end', label: 'To', required: false,
    control: (described) => input({
      id: 'check-end', name: 'end_time', type: 'time', value: values.endTime ?? '',
      describedBy: described, step: '900',
    }),
  })}
              </div>
              ${field({
    id: 'check-desks', label: 'Desks (co-working only)', required: false,
    control: (described) => input({
      id: 'check-desks', name: 'desks', type: 'number', value: values.desks ?? 1,
      describedBy: described, min: '1', max: '500', inputMode: 'numeric',
    }),
  })}
              <div class="form-actions">
                <button class="button button--primary button--block" type="submit">Check availability</button>
              </div>
              ${availabilityResult(check.result)}
            </form>
            <div class="cluster request-cta">
              <a class="button button--primary button--block" href="${requestHref}">Request this space</a>
            </div>
            <p class="book-panel__note hint">Checking a window or submitting an inquiry does not lock the room. Nagaro operations staff confirm all bookings.</p>
          </div>
        </div>

        <div class="card">
          <div class="card__body stack">
            <p class="section-eyebrow">Operational Rules</p>
            <h2 class="section-title">Booking conditions</h2>
            <dl class="detail-list detail-list--inline">
              <dt>Opening hours</dt><dd>${space.openTime}–${space.closeTime} (Sri Lanka Standard Time)</dd>
              <dt>Minimum booking</dt><dd>${humanMinutes(space.minDurationMinutes)}</dd>
              <dt>Maximum booking</dt>
              <dd>${space.maxDurationMinutes ? humanMinutes(space.maxDurationMinutes) : 'No maximum'}</dd>
              <dt>Turnaround buffer</dt>
              <dd>${space.bufferMinutes ? `${humanMinutes(space.bufferMinutes)} between bookings` : 'None'}</dd>
              <dt>Capacity</dt><dd>Up to ${space.capacity} people</dd>
              <dt>Bookable units</dt>
              <dd>${space.category === SPACE_CATEGORY.COWORKING
    ? `${space.unitCount} ${space.unitCount === 1 ? 'desk' : 'desks'}`
    : 'One exclusive room'}</dd>
            </dl>
            <p class="hint">Availability answers are provisional and one inquiry is not a reservation.
              Nagaro staff confirm every booking by hand.</p>
          </div>
        </div>
      </aside>
    </div>
  </section>`;

  return publicShell({
    title: space.name,
    description: space.shortDescription
      || `${space.categoryLabel} at Nagaro, Trace Expert City. Capacity ${space.capacity}, ${space.openTime}–${space.closeTime}.`,
    activePath: '/spaces',
    pageClass: 'page--space',
    body,
  });
}

/* ---------------------------------------------------------------- error pages */

/**
 * Friendly public error page. Never contains a stack trace, SQL, or an
 * existence hint: `message` is written for a visitor, not a developer.
 */
export function publicErrorPage({
  status = 400, title = 'Something went wrong', message = '', hint = null, problems = null,
} = {}) {
  const failure = status >= 500
    ? 'Something went wrong on our side. Nothing was changed — please try again in a moment.'
    : message;
  const body = html`<section class="container stack">
    <div class="card">
      <div class="card__body stack">
        <p class="tag tag--warn">Error ${status}</p>
        <h1 class="page-title">${title}</h1>
        <p>${failure}</p>
        ${problems && problems.length ? problemList(problems) : ''}
        ${hint ? html`<p class="hint">${hint}</p>` : ''}
        <div class="cluster">
          <a class="button button--primary" href="/spaces">Browse spaces</a>
          <a class="button button--ghost" href="/booking-request">Send a booking request</a>
        </div>
      </div>
    </div>
  </section>`;

  return publicShell({
    title,
    description: failure || title,
    activePath: '',
    pageClass: 'page--error',
    body,
  });
}
