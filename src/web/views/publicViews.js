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

/** Simple line icons for the three space categories (inline SVG, no external assets). */
const CATEGORY_ICON = Object.freeze({
  [SPACE_CATEGORY.MEETING_ROOM]: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 20h8M12 17v3M7 12l2.5-3 2.5 3"/></svg>',
  [SPACE_CATEGORY.AUDITORIUM]: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18M5 5v5a4 4 0 0 0 8 0V5M13 5v5a4 4 0 0 0 8 0V5M8 20l1.5-4M16 20l-1.5-4"/></svg>',
  [SPACE_CATEGORY.COWORKING]: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="8" height="12" rx="1.5"/><rect x="13" y="8" width="8" height="9" rx="1.5"/><path d="M3 21h18"/></svg>',
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

function humanMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function attributeValue(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return text(value);
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
        amountLabel: money(amountCents, space.currency ?? 'ETB'),
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
    rateSummary: spaceRateSummary({ rates, currency: space.currency ?? 'ETB' }),
    amenities,
    attributes: safeAttributes(space.attributes),
    images: projectedImages,
    isPublished: space.status === SPACE_STATUS.PUBLISHED,
  };
  return projection;
}

/* ------------------------------------------------------------ shared fragments */

/** Cover image for a card, falling back to the first photograph. */
function coverImage(space) {
  const images = space.images ?? [];
  return images.find((image) => image.isCover) ?? images[0] ?? null;
}

function altFor(image, space) {
  const alt = text(image?.altText).trim();
  return alt || `${space.name} at Nagaro, Trace Expert City`;
}

function spaceCard(space) {
  const cover = coverImage(space);
  const media = cover
    ? html`<a class="space-card__media" href="/spaces/${space.code}" tabindex="-1" aria-hidden="true">
        <img src="${cover.url}" alt="${altFor(cover, space)}" loading="lazy">
        <span class="space-card__badge">${space.categoryLabel}</span>
      </a>`
    : html`<span class="space-card__media" aria-hidden="true">
        <span class="space-card__badge space-card__badge--empty">${space.categoryLabel}</span>
      </span>`;

  return html`<article class="space-card" data-space-code="${space.code}">
    ${media}
    <div class="space-card__body">
      <h3 class="space-card__title"><a href="/spaces/${space.code}">${space.name}</a></h3>
      ${metaLine([
    space.categoryLabel,
    space.capacity ? `Up to ${space.capacity} people` : null,
    [space.location, space.floor ? `Floor ${space.floor}` : null].filter(Boolean).join(', ') || null,
  ])}
      ${space.shortDescription ? html`<p>${space.shortDescription}</p>` : ''}
      <p class="price"><span class="price__label">From</span> ${space.rateSummary}</p>
      <div class="space-card__actions">
        <a class="button button--primary button--small" href="/spaces/${space.code}">View details</a>
        <a class="button button--ghost button--small" href="/booking-request?space=${space.code}">Request</a>
      </div>
    </div>
  </article>`;
}

function spaceGrid(spaces) {
  return html`<div class="space-grid">${spaces.map((space) => spaceCard(space))}</div>`;
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
function field({ id, label, hint = null, error = null, required = false, control }) {
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return html`<div class="form-field">
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
  [SPACE_CATEGORY.MEETING_ROOM]: 'Rooms for meetings, workshops and training, bookable by the hour or the day.',
  [SPACE_CATEGORY.AUDITORIUM]: 'The large hall for launches, screenings and town halls, with stage and sound support.',
  [SPACE_CATEGORY.COWORKING]: 'Individual desks and small team areas, bookable by the day, week or month.',
});

/** `GET /` — hero, three category entry points and up to six featured spaces. */
export function renderHomePage({ featured = [], totalPublished = 0, categoryCounts = {} } = {}) {
  const categories = SPACE_CATEGORY_ORDER.map((category) => ({
    category,
    label: SPACE_CATEGORY_LABEL[category] ?? category,
    tagline: CATEGORY_TAGLINE[category] ?? '',
    count: categoryCounts[category] ?? 0,
  }));

  const body = html`<section class="hero">
    <div class="hero__inner">
      <p class="hero__eyebrow">Nagaro · Trace Expert City</p>
      <h1 class="hero__title">Meeting rooms, an auditorium and co-working desks at Trace Expert City</h1>
      <p class="hero__subtitle">Nagaro rents out practical, well-equipped space in Trace Expert City, Addis Ababa.
        Browse what is available, check a period, and send us a request to book.</p>
      <p class="hero__subtitle"><strong>Availability shown here is provisional.</strong> A request does not hold the
        space and is not a booking until Nagaro staff confirm it.</p>
      <div class="hero__actions">
        <a class="button button--primary" href="/spaces">Browse all spaces</a>
        <a class="button button--ghost" href="/booking-request">Request a booking</a>
      </div>
      <dl class="hero__stats">
        <div class="hero__stat"><dt>Published spaces</dt><dd>${totalPublished}</dd></div>
        <div class="hero__stat"><dt>Categories</dt><dd>${SPACE_CATEGORY_ORDER.length}</dd></div>
        <div class="hero__stat"><dt>Booking desk</dt><dd>Mon–Sat</dd></div>
      </dl>
    </div>
  </section>

  <section class="container stack">
    <div class="section-head">
      <div>
        <h2 class="section-title">What you can book</h2>
        <p class="section-subtitle">Three kinds of space, ${totalPublished === 1 ? '1 space published' : `${totalPublished} spaces published`} right now.</p>
      </div>
    </div>
    <div class="category-grid">
      ${categories.map((item) => html`<a class="category-card" href="/spaces?category=${item.category}">
        <span class="category-card__icon" aria-hidden="true">${raw(CATEGORY_ICON[item.category] ?? '')}</span>
        <span class="category-card__title">${item.label}</span>
        <span class="category-card__meta">${item.tagline}</span>
        <span class="category-card__count">${item.count === 1 ? '1 space available' : `${item.count} spaces available`}</span>
      </a>`)}
    </div>

    <div class="section-head">
      <div>
        <h2 class="section-title">Featured spaces</h2>
        <p class="section-subtitle">Published spaces at Trace Expert City.</p>
      </div>
      <div class="section-actions">
        <a class="button button--ghost button--small" href="/spaces">See everything</a>
      </div>
    </div>
    ${featured.length
    ? spaceGrid(featured)
    : emptyState(
      'No spaces are published yet.',
      'Nagaro staff are still preparing the catalogue. Please check back shortly.',
    )}

    <div class="card">
      <div class="card__body stack">
        <h2 class="section-title">How a request to book works</h2>
        <ol>
          <li>Check a space and a period on its page. The answer is provisional and does not hold the space.</li>
          <li>Send a request with the form. We save it and Nagaro staff see it in the booking queue.</li>
          <li>Staff check the calendar by hand, confirm the booking with you, and only then is the space reserved.</li>
        </ol>
        <p class="hint">Requests are not confirmed bookings, and posting the form never reserves inventory.</p>
        <div class="cluster">
          <a class="button button--primary" href="/booking-request">Request a booking</a>
          <a class="button button--ghost" href="/spaces">Browse spaces</a>
        </div>
      </div>
    </div>
  </section>`;

  return publicShell({
    title: 'Nagaro spaces at Trace Expert City',
    description: 'Book meeting rooms, the auditorium and co-working desks at Nagaro, Trace Expert City, Addis Ababa. '
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

  const body = html`<section class="container stack">
    <div>
      <h1 class="page-title">Spaces</h1>
      <p class="section-subtitle">Every space Nagaro currently publishes at Trace Expert City.
        Availability shown on a space page is provisional.</p>
    </div>

    <form class="filter-bar" method="get" action="/spaces" role="search" aria-label="Filter spaces">
      <div class="filter-bar__field">
        <label for="filter-q">Search</label>
        <input id="filter-q" name="q" type="search" value="${filters.q ?? ''}"
               placeholder="Name, code or location" maxlength="80">
      </div>
      <div class="filter-bar__field">
        <label for="filter-category">Category</label>
        <select id="filter-category" name="category">
          <option value="">All categories</option>
          ${SPACE_CATEGORY_ORDER.map((category) => html`<option value="${category}"
            ${attr('selected', filters.category === category)}>${SPACE_CATEGORY_LABEL[category] ?? category}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="filter-capacity">Minimum capacity</label>
        <input id="filter-capacity" name="min_capacity" type="number" min="1" max="100000"
               value="${filters.minCapacity === null || filters.minCapacity === undefined ? '' : filters.minCapacity}">
      </div>
      <div class="filter-bar__field">
        <label for="filter-pricing">Pricing unit</label>
        <select id="filter-pricing" name="pricing_unit">
          <option value="">Any pricing unit</option>
          ${pricingUnitOptions.map((unit) => html`<option value="${unit}"
            ${attr('selected', filters.pricingUnit === unit)}>${pricingUnitLabel(unit)}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="filter-sort">Sort by</label>
        <select id="filter-sort" name="sort">
          ${[['name', 'Name'], ['capacity', 'Capacity'], ['price', 'Price']].map(([value, label]) => html`<option value="${value}"
            ${attr('selected', (filters.sort ?? 'name') === value)}>${label}</option>`)}
        </select>
      </div>
      <details class="filter-bar__field">
        <summary>Amenities${selected.size ? ` (${selected.size} selected)` : ''}</summary>
        <div class="cluster">
          ${amenityOptions.map((amenity) => html`<label class="hint" for="amenity-${slugId(amenity)}">
            <input id="amenity-${slugId(amenity)}" type="checkbox" name="amenity" value="${amenity}"
                   ${attr('checked', selected.has(amenity))}> ${amenity}
          </label>`)}
        </div>
      </details>
      <div class="filter-bar__actions">
        <button class="button button--primary" type="submit">Apply filters</button>
        <a class="button button--ghost" href="/spaces">Clear</a>
      </div>
    </form>

    <p class="meta-line">
      ${total === 1 ? '1 space matches' : `${total} spaces match`}${summary ? ` ${summary}` : ''}
      · ${publishedTotal} published in total.
    </p>

    ${spaces.length
    ? spaceGrid(spaces)
    : emptyState('No spaces match those filters.', 'Try removing a filter, or browse every published space.')}

    ${paginationNav({ page, pageSize, total, basePath: '/spaces', pairs })}
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

  const body = html`<section class="container stack">
    <div>
      <h1 class="page-title">Request a booking</h1>
      <p class="section-subtitle">Tell us what you need. Nagaro staff check the calendar by hand and
        confirm the booking with you — this form does not reserve the space and carries no payment.</p>
    </div>

    <div class="card">
      <div class="card__body">
        ${problems.length
    ? html`<div class="alert alert--error" role="alert" data-flash>
            <p>Please check ${problems.length === 1 ? 'one field' : `${problems.length} fields`} below and send the request again.</p>
            ${alertProblems.length ? html`<ul>${alertProblems.map((problem) => html`<li>${problem}</li>`)}</ul>` : ''}
            <button type="button" class="alert__close" data-dismiss aria-label="Dismiss">×</button>
          </div>`
    : ''}
        <form method="post" action="/booking-request" class="form-grid" autocomplete="on">
          <h2 class="section-title form-field--full">Your details</h2>
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

          <h2 class="section-title form-field--full">What you need</h2>
          ${field({
    id: 'space_code', label: 'Space', required: true,
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
    id: 'date', label: 'Date', required: true,
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
          ${field({
    id: 'message', label: 'Anything else? (optional)', required: false,
    hint: 'Equipment, layout, accessibility needs, or a preferred contact time.',
    error: errorFor(errors, 'message'),
    control: (described) => html`<textarea id="message" name="message" rows="4" maxlength="2000"
        ${attr('aria-describedby', described || null)}
        ${attr('aria-invalid', errorFor(errors, 'message') ? 'true' : null)}>${values.message ?? ''}</textarea>`,
  })}

          <div class="form-actions form-field--full">
            <button class="button button--primary" type="submit">Send booking request</button>
            <a class="button button--ghost" href="/spaces">Browse spaces</a>
          </div>
          <p class="hint form-field--full">Sending this form saves a request for Nagaro staff. It is not a
            confirmed booking, does not reserve inventory, and nothing is charged.</p>
        </form>
      </div>
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
    <div class="card">
      <div class="card__body stack">
        <p class="tag tag--info">Request received</p>
        <h1 class="page-title">Your booking request has been received</h1>
        <p><strong>${NOT_CONFIRMED_NOTICE}</strong></p>
        <p>${notice}</p>

        <dl class="detail-list">
          <dt>Reference</dt><dd><code>${reference}</code></dd>
          <dt>Space</dt><dd>${inquiry?.spaceName ?? '—'}${inquiry?.categoryLabel ? html` (${inquiry.categoryLabel})` : ''}</dd>
          <dt>Requested period</dt>
          <dd>${inquiry?.startAt && inquiry?.endAt ? periodLabel(inquiry.startAt, inquiry.endAt) : '—'}
            <span class="hint">East Africa Time</span></dd>
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

  const body = html`<section class="container stack">
    <nav class="breadcrumbs" aria-label="Breadcrumb"><ol>
      <li><a href="/">Home</a></li>
      <li><a href="/spaces">Spaces</a></li>
      <li><span aria-current="page">${space.name}</span></li>
    </ol></nav>

    <div>
      <h1 class="page-title">${space.name}</h1>
      <p class="section-subtitle">${[
    space.categoryLabel,
    space.location,
    space.floor ? `Floor ${space.floor}` : null,
    space.isPublished ? null : 'Not published',
  ].filter(Boolean).join(' · ')}</p>
    </div>

    <div class="split-layout">
      <div class="stack">
        ${images.length
    ? html`<div class="gallery">
            <img data-gallery-main class="${main ? '' : 'gallery__main'}"
                 src="${(main ?? images[0]).url}" alt="${altFor(main ?? images[0], space)}">
            ${images.map((image, index) => html`<button type="button" class="gallery__item"
              data-gallery-thumb data-src="${image.url}" data-alt="${altFor(image, space)}"
              aria-current="${index === 0 ? 'true' : 'false'}"
              aria-label="Show photograph ${index + 1} of ${images.length}">
              <img src="${image.url}" alt="${altFor(image, space)}" loading="lazy">
              ${image.isCover ? html`<span class="gallery__cover">Cover</span>` : ''}
            </button>`)}
          </div>`
    : html`<div class="gallery"><span class="hint">No photograph has been added for this space yet.</span></div>`}

        <div class="card">
          <div class="card__body stack">
            <h2 class="section-title">About this space</h2>
            <p>${space.description || space.shortDescription || 'Nagaro staff will describe this space shortly.'}</p>
          </div>
        </div>

        ${space.amenities.length
    ? html`<div class="card">
            <div class="card__body stack">
              <h2 class="section-title">Amenities</h2>
              <ul class="amenity-list">
                ${space.amenities.map((amenity) => html`<li>${amenity}</li>`)}
              </ul>
            </div>
          </div>`
    : ''}

        ${attributes.length
    ? html`<div class="card">
            <div class="card__body stack">
              <h2 class="section-title">Good to know</h2>
              <dl class="detail-list">
                ${attributes.map(([key, value]) => html`<dt>${humaniseKey(key)}</dt><dd>${attributeValue(value)}</dd>`)}
              </dl>
            </div>
          </div>`
    : ''}

        <div class="card">
          <div class="card__body stack">
            <h2 class="section-title">Rates</h2>
            ${space.rateList.length
    ? html`<table class="rate-table">
                <caption class="hint">Rates are quoted in ETB and exclude any agreed extras.</caption>
                <thead>
                  <tr><th scope="col">Billing unit</th><th scope="col">Rate</th></tr>
                </thead>
                <tbody>
                  ${space.rateList.map((rate) => html`<tr>
                    <th scope="row">${rate.unitLabel}${rate.isDefault ? html` <span class="hint">(default)</span>` : ''}</th>
                    <td>${rate.amountLabel}</td>
                  </tr>`)}
                </tbody>
              </table>`
    : html`<p>Rate on request — mention what you need in your request and Nagaro staff will quote you.</p>`}
            <p class="hint">A request to book is not a confirmed booking and carries no payment.</p>
          </div>
        </div>
      </div>

      <aside class="stack">
        <div class="card">
          <div class="card__body stack">
            <h2 class="section-title">Check availability</h2>
            <p class="price price--accent">${space.rateSummary}</p>
            <form class="availability-checker" method="get" action="/spaces/${space.code}"
                  data-availability-form data-space="${space.code}" data-space-code="${space.code}">
              ${field({
    id: 'check-date', label: 'Date', required: false,
    control: (described) => input({
      id: 'check-date', name: 'date', type: 'date', value: values.date ?? '',
      describedBy: described, min: check.today ?? null,
    }),
  })}
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
              ${field({
    id: 'check-desks', label: 'Desks (co-working only)', required: false,
    control: (described) => input({
      id: 'check-desks', name: 'desks', type: 'number', value: values.desks ?? 1,
      describedBy: described, min: '1', max: '500', inputMode: 'numeric',
    }),
  })}
              <div class="form-actions">
                <button class="button button--primary" type="submit">Check availability</button>
              </div>
              ${availabilityResult(check.result)}
            </form>
            <div class="cluster">
              <a class="button button--primary button--block" href="${requestHref}">Request this space</a>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card__body stack">
            <h2 class="section-title">Booking details</h2>
            <dl class="detail-list detail-list--inline">
              <dt>Opening hours</dt><dd>${space.openTime}–${space.closeTime} (East Africa Time)</dd>
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

