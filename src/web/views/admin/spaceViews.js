/**
 * Admin catalogue views: the space list, the create/edit form and the space
 * detail page (publish checklist, photographs, rates, inventory).
 *
 * Category-conditional fields without client-side scripting
 * ---------------------------------------------------------
 * A space may only be asked for the fields its category actually uses, and
 * these pages must work with JavaScript disabled: `src/web/public/admin.js` is
 * progressive enhancement only and is owned by a different workstream, so no
 * behaviour here depends on a script. The approach is:
 *
 *   * Creating a space renders all three category attribute panels inside
 *     `<details>` elements, one per category, each labelled with the category
 *     it belongs to. The panel that matches the selected category opens by
 *     default, but every panel is reachable in one pass because the whole
 *     vocabulary is listed.
 *   * Editing a space renders only the panel for the space's current category,
 *     and only the pricing units that `ALLOWED_PRICING_UNITS` permits for it.
 *     Nothing that cannot apply is rendered.
 *   * Attribute inputs are named `attributes_<panel>[<key>]`
 *     (`attributes_meeting[...]`, `attributes_auditorium[...]`,
 *     `attributes_coworking[...]`). The route reads only the panel matching the
 *     submitted `category`, so a value typed into another category's panel is
 *     ignored rather than stored, and `attributes` never accumulates stale
 *     keys from a previous category.
 *   * The co-working desk inventory (`desk_count`) is only submitted when the
 *     category is `COWORKING`; the route drops it otherwise.
 *
 * The server remains authoritative: `parseSpacePayload`, `normaliseRates` and
 * `ALLOWED_PRICING_UNITS` re-validate every value, so a hand-made POST that
 * ignores these panels cannot produce a valid space anyway.
 *
 * Error rendering: `fieldError(details, field)` emits a `<p class="field-error">`
 * without an id, so each error paragraph is wrapped in a container that
 * carries the id named by the input's `aria-describedby` (`<id>-error`), and
 * the input gains `aria-invalid="true"`. A summary alert at the top of the
 * form lists every problem and links to the offending field where one is
 * rendered.
 */
import {
  ALLOWED_PRICING_UNITS, AMENITY_CATALOG, PRICING_UNIT, PRICING_UNIT_LABEL,
  SPACE_CATEGORY, SPACE_CATEGORY_LABEL, SPACE_CATEGORY_ORDER, SPACE_STATUS, SPACE_STATUS_LABEL,
} from '../../../server/domain/constants.js';
import { rateSummary } from '../../../server/services/spaceService.js';
import {
  attr, categoryLabel, csrfField, emptyState, fieldError, friendlyDate, html,
  money, pagination, pricingUnitLabel, problemList, raw, statusBadge, tag,
} from '../../lib/html.js';
import { adminShell, card, table } from '../layout.js';

/* ---------------------------------------------------- attribute vocabulary */

/**
 * The category-specific attribute keys this UI can edit, grouped by panel.
 * `key` is the JSON key stored in `space.attributes` (must match
 * `normalizeAttributes`' `^[a-z0-9_]{1,40}$` allow-list) and is also the DOM
 * id of the input, which lets a server field error be linked directly.
 */
export const ATTRIBUTE_FIELDS = Object.freeze({
  meeting: [
    { key: 'layout', label: 'Seating layout', type: 'text', placeholder: 'Boardroom / U-shape / Theatre' },
    { key: 'partition_wall', label: 'Movable partition wall', type: 'checkbox' },
    { key: 'flipchart', label: 'Flip chart on request', type: 'checkbox' },
  ],
  auditorium: [
    { key: 'seating_capacity', label: 'Seating capacity', type: 'number', hint: 'Maximum seats, including any balcony.' },
    { key: 'stage_size', label: 'Stage size', type: 'text', placeholder: 'e.g. 6 m × 4 m' },
    { key: 'tiered_seating', label: 'Tiered (raked) seating', type: 'checkbox' },
  ],
  coworking: [
    { key: 'desk_area', label: 'Desk area', type: 'text', placeholder: 'Open plan / quiet zone / window side' },
    { key: 'phone_booth', label: 'Phone booth nearby', type: 'checkbox' },
    { key: 'meeting_room_credits', label: 'Monthly meeting-room credits', type: 'number' },
  ],
});

export const ATTRIBUTE_PANEL_FOR_CATEGORY = Object.freeze({
  [SPACE_CATEGORY.MEETING_ROOM]: 'meeting',
  [SPACE_CATEGORY.AUDITORIUM]: 'auditorium',
  [SPACE_CATEGORY.COWORKING]: 'coworking',
});

const PRICING_UNITS = Object.freeze(Object.values(PRICING_UNIT));
const CURRENCIES = Object.freeze(['ETB', 'USD', 'EUR']);
const SORT_OPTIONS = Object.freeze([
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'newest', label: 'Newest first' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'capacity', label: 'Largest capacity' },
]);
const STATUS_OPTIONS = Object.freeze([
  { value: 'active', label: 'Draft and published' },
  { value: SPACE_STATUS.DRAFT, label: 'Draft only' },
  { value: SPACE_STATUS.PUBLISHED, label: 'Published only' },
  { value: SPACE_STATUS.ARCHIVED, label: 'Archived only' },
  { value: 'all', label: 'All statuses' },
]);

const QUICK_STATUS_PILLS = Object.freeze([
  { value: 'all', label: 'All' },
  { value: SPACE_STATUS.PUBLISHED, label: 'Published' },
  { value: SPACE_STATUS.DRAFT, label: 'Draft' },
  { value: SPACE_STATUS.ARCHIVED, label: 'Archived' },
  { value: 'active', label: 'Active (Draft & Published)' },
]);

/* ------------------------------------------------------------------ helpers */

function errorMessage(details, field) {
  if (!details || typeof details !== 'object') return null;
  const value = details[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The DOM id a server field key addresses (`rates.HOUR` -> `rates_HOUR`). */
function formFieldId(field) {
  if (!field) return null;
  if (field.startsWith('rates.')) return `rates_${field.slice('rates.'.length)}`;
  return field;
}

/**
 * `aria-invalid`, `aria-describedby` and the id-carrying error container for
 * one field. `lookupField` is the key the server used in `details` (which may
 * differ from the input's id, e.g. `rates.HALF_DAY` vs `rates_HALF_DAY`).
 */
function fieldMeta({ details, field, id = field, hintId = null }) {
  const message = errorMessage(details, field);
  const describedBy = [message ? `${id}-error` : null, hintId].filter(Boolean);
  return {
    invalid: attr('aria-invalid', message ? 'true' : null),
    describedBy: attr('aria-describedby', describedBy.length ? describedBy.join(' ') : null),
    error: message
      ? html`<div id="${id}-error">${fieldError(details, field)}</div>`
      : '',
  };
}

function problemsSummary(details, { renderedIds = new Set(), title = 'Please correct the following before saving:' } = {}) {
  if (!details || typeof details !== 'object') return '';
  const problems = Array.isArray(details.problems)
    ? details.problems.filter((problem) => typeof problem === 'string' && problem.trim() !== '')
    : [];
  const fields = Object.entries(details)
    .filter(([key, value]) => key !== 'problems' && typeof value === 'string' && value.trim() !== '');
  if (problems.length === 0 && fields.length === 0) return '';

  return html`<div class="alert alert--error" role="alert">
    <p>${title}</p>
    ${problemList(problems)}
    ${fields.length
      ? html`<ul>
          ${fields.map(([field, message]) => {
    const id = formFieldId(field);
    return html`<li>${id && renderedIds.has(id)
      ? html`<a href="#${id}">${message}</a>`
      : message}</li>`;
  })}
        </ul>`
      : ''}
  </div>`;
}

function inputField({
  id, name = id, label, value = '', details = null, type = 'text', hint = null,
  required = false, inputmode = null, placeholder = null, min = null, max = null,
  step = null, autocomplete = null, hintId = null, lookup = null, className = '',
}) {
  const resolvedHintId = hint ? (hintId ?? `${id}-hint`) : null;
  const meta = fieldMeta({ details, field: lookup ?? id, id, hintId: resolvedHintId });
  return html`<div class="form-field ${className}">
    <label for="${id}">${label}${required ? html` <span class="required-mark" aria-hidden="true">*</span>` : ''}</label>
    <input id="${id}" name="${name}" type="${type}" value="${value ?? ''}"
      ${attr('required', required ? true : null)}
      ${attr('inputmode', inputmode)}
      ${attr('placeholder', placeholder)}
      ${attr('min', min)}${attr('max', max)}${attr('step', step)}
      ${attr('autocomplete', autocomplete)}
      ${meta.invalid}${meta.describedBy}>
    ${hint ? html`<p class="hint" id="${resolvedHintId}">${hint}</p>` : ''}
    ${meta.error}
  </div>`;
}

function textareaField({ id, name = id, label, value = '', details = null, hint = null, rows = 4, required = false, maxlength = null, className = '' }) {
  const hintId = hint ? `${id}-hint` : null;
  const meta = fieldMeta({ details, field: id, id, hintId });
  return html`<div class="form-field ${className}">
    <label for="${id}">${label}${required ? html` <span class="required-mark" aria-hidden="true">*</span>` : ''}</label>
    <textarea id="${id}" name="${name}" rows="${rows}" ${attr('required', required ? true : null)}${attr('maxlength', maxlength)} ${meta.invalid}${meta.describedBy}>${value ?? ''}</textarea>
    ${hint ? html`<p class="hint" id="${hintId}">${hint}</p>` : ''}
    ${meta.error}
  </div>`;
}

function selectField({ id, name = id, label, value, options, details = null, hint = null, required = false, className = '' }) {
  const hintId = hint ? `${id}-hint` : null;
  const meta = fieldMeta({ details, field: id, id, hintId });
  return html`<div class="form-field ${className}">
    <label for="${id}">${label}${required ? html` <span class="required-mark" aria-hidden="true">*</span>` : ''}</label>
    <select id="${id}" name="${name}" ${attr('required', required ? true : null)}${meta.invalid}${meta.describedBy}>
      ${options.map((option) => html`<option value="${option.value}"${attr('selected', String(option.value) === String(value) ? true : null)}>${option.label}</option>`)}
    </select>
    ${hint ? html`<p class="hint" id="${hintId}">${hint}</p>` : ''}
    ${meta.error}
  </div>`;
}

function checkboxField({ id, name, value = '1', label, checked = false, hint = null }) {
  return html`<div class="form-field form-field--checkbox">
    <input id="${id}" name="${name}" type="checkbox" value="${value}" ${attr('checked', checked ? true : null)}>
    <label for="${id}">${label}</label>
    ${hint ? html`<p class="hint">${hint}</p>` : ''}
  </div>`;
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function durationMinutesLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1440 && value % 1440 === 0) {
    const days = value / 1440;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (hours > 0 && rest > 0) return `${hours}h ${rest}m`;
  if (hours > 0) return `${hours}h`;
  return `${rest}m`;
}

/** One catalogue row per category that allows the unit, for the create form. */
function pricingUnitOptionLabel(unit) {
  const categories = SPACE_CATEGORY_ORDER
    .filter((category) => (ALLOWED_PRICING_UNITS[category] ?? []).includes(unit))
    .map((category) => SPACE_CATEGORY_LABEL[category]);
  return `${PRICING_UNIT_LABEL[unit] ?? unit} — ${categories.join(', ') || 'no category'}`;
}

function unitLabel(category) {
  return category === SPACE_CATEGORY.COWORKING ? 'desks' : 'bookable units';
}

function inventoryIndicator(space) {
  if (space.category === SPACE_CATEGORY.COWORKING) {
    return `${space.unitCount} Co-working ${space.unitCount === 1 ? 'Desk' : 'Desks'}`;
  }
  return `${space.unitCount} Exclusive ${space.unitCount === 1 ? 'Unit' : 'Units'}`;
}

function spaceThumbnail(space) {
  if (space.coverImage) {
    return html`<img src="/media/${space.coverImage}" alt="${space.name}" width="48" height="32" loading="lazy" decoding="async">`;
  }
  return html`<span class="tag" aria-hidden="true">${space.code}</span>`;
}

function statusFilterHref(statusValue, filters) {
  const params = new URLSearchParams();
  params.set('status', statusValue);
  if (filters.category) params.set('category', filters.category);
  if (filters.sort && filters.sort !== 'name') params.set('sort', filters.sort);
  if (filters.search) params.set('q', filters.search);
  return `/admin/spaces?${params.toString()}`;
}

/* ---------------------------------------------------------- list of spaces */

export function renderSpaceListPage({
  actor, csrfToken, flash, spaces, total, filters, page, pageSize,
}) {
  const currentStatus = filters.status || 'active';

  const statusPills = html`<nav class="cluster" aria-label="Quick status filters">
    ${QUICK_STATUS_PILLS.map((pill) => {
      const isActive = currentStatus === pill.value;
      return html`<a class="button ${isActive ? 'button--primary' : 'button--ghost'} button--small"
        href="${statusFilterHref(pill.value, filters)}"
        ${isActive ? raw('aria-current="page"') : ''}>${pill.label}</a>`;
    })}
  </nav>`;

  const rows = spaces.map((space) => ({
    cells: [
      html`<div class="cluster">
        ${spaceThumbnail(space)}
        <div>
          <a href="/admin/spaces/${space.id}"><strong>${space.name}</strong></a>
          <div class="meta-line"><code>${space.code}</code>${space.location ? ` · ${space.location}` : ''}${space.floor ? `, ${space.floor}` : ''}</div>
        </div>
      </div>`,
      tag(categoryLabel(space.category)),
      html`<span><strong>${inventoryIndicator(space)}</strong></span>
        <div class="meta-line">Capacity: ${space.capacity} ${space.capacity === 1 ? 'person' : 'people'} · ${space.unitCount} ${unitLabel(space.category)}</div>`,
      html`<span class="price">${rateSummary(space)}</span>`,
      space.imageCount > 0
        ? tag(`${space.imageCount} ${space.imageCount === 1 ? 'photo' : 'photos'}`, 'ok')
        : tag('No photograph', 'warn'),
      statusBadge(space.status),
      friendlyDate(space.updatedAt),
      html`<span class="cluster">
        <a class="button button--primary button--small" href="/admin/spaces/${space.id}">Manage</a>
        <a class="button button--ghost button--small" href="/admin/spaces/${space.id}/edit">Edit</a>
        <a class="button button--ghost button--small" href="/admin/calendar?space=${space.id}">Calendar</a>
      </span>`,
    ],
  }));

  const body = html`<div class="stack">
    <div class="cluster">
      ${statusPills}
    </div>

    <form method="get" action="/admin/spaces" class="filter-bar admin-filter-form">
      <div class="filter-bar__field">
        <label for="q">Search</label>
        <input id="q" name="q" type="search" value="${filters.search}" maxlength="160"
               placeholder="Name, code, location or summary">
      </div>
      <div class="filter-bar__field">
        <label for="status">Status</label>
        <select id="status" name="status">
          ${STATUS_OPTIONS.map((option) => html`<option value="${option.value}"${attr('selected', option.value === filters.status ? true : null)}>${option.label}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="category">Category</label>
        <select id="category" name="category">
          <option value="">All categories</option>
          ${SPACE_CATEGORY_ORDER.map((category) => html`<option value="${category}"${attr('selected', category === filters.category ? true : null)}>${SPACE_CATEGORY_LABEL[category]}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="sort">Sort</label>
        <select id="sort" name="sort">
          ${SORT_OPTIONS.map((option) => html`<option value="${option.value}"${attr('selected', option.value === filters.sort ? true : null)}>${option.label}</option>`)}
        </select>
      </div>
      <div class="filter-bar__actions">
        <button class="button button--primary" type="submit">Apply filters</button>
        <a class="button button--ghost" href="/admin/spaces">Reset</a>
      </div>
    </form>

    ${card({
    title: 'Space Directory',
    description: `${total} space${total === 1 ? '' : 's'} match the current filters.`,
    actions: html`<a class="button button--primary button--small" href="/admin/spaces/new">New space</a>`,
    body: html`${table({
      columns: [
        { label: 'Space' }, { label: 'Category' }, { label: 'Inventory & Capacity' },
        { label: 'Rates' }, { label: 'Photos' }, { label: 'Status' },
        { label: 'Updated' }, { label: 'Actions' },
      ],
      rows,
      emptyMessage: 'No spaces match these filters. Clear the filters or create a new space.',
    })}
    ${pagination({
      page, pageSize, total, basePath: '/admin/spaces',
      extraQuery: {
        q: filters.search || undefined,
        status: filters.status || undefined,
        category: filters.category || undefined,
        sort: filters.sort || undefined,
      },
    })}`,
  })}

    <p class="hint">Archived spaces stay in the catalogue for history but are hidden from the public site and cannot receive new reservations.</p>
  </div>`;

  return adminShell({
    title: 'Spaces',
    subtitle: 'The bookable catalogue: meeting rooms, auditorium and co-working desks.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/spaces',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Spaces' }],
    pageActions: html`<a class="button button--primary button--small" href="/admin/spaces/new">New space</a>`,
    body,
  });
}

/* --------------------------------------------------------- create/edit form */

export function renderSpaceFormPage({
  actor, csrfToken, flash = null, mode = 'create', space = null, values, details = null,
  errorMessage: summaryMessage = null,
}) {
  const isEdit = mode === 'edit';
  const action = isEdit ? `/admin/spaces/${space.id}` : '/admin/spaces';
  const cancelHref = isEdit ? `/admin/spaces/${space.id}` : '/admin/spaces';
  const category = values.category;
  const allowedUnits = ALLOWED_PRICING_UNITS[category] ?? PRICING_UNITS;
  const visibleUnits = isEdit
    ? [...new Set([...allowedUnits, values.pricing_unit].filter(Boolean))]
    : PRICING_UNITS;
  const currentPanel = ATTRIBUTE_PANEL_FOR_CATEGORY[category];
  const editingAttributes = isEdit ? (currentPanel ? [currentPanel] : []) : Object.keys(ATTRIBUTE_FIELDS);

  const pricingUnitOptions = visibleUnits.map((unit) => ({
    value: unit,
    label: isEdit ? (PRICING_UNIT_LABEL[unit] ?? unit) : pricingUnitOptionLabel(unit),
  }));

  const renderedIds = new Set([
    'code', 'name', 'category', 'short_description', 'description', 'location', 'floor',
    'capacity', 'currency', 'pricing_unit', 'min_duration_minutes', 'max_duration_minutes',
    'buffer_minutes', 'open_time', 'close_time', 'contact_note', 'amenities_other',
    ...visibleUnits.map((unit) => `rates_${unit}`),
    ...editingAttributes.flatMap((panel) => (ATTRIBUTE_FIELDS[panel] ?? []).map((field) => field.key)),
    ...(isEdit ? (category === SPACE_CATEGORY.COWORKING ? ['desk_count'] : []) : ['desk_count']),
  ]);

  const ratesHint = isEdit
    ? `Allowed units for ${categoryLabel(category)}: ${allowedUnits.map((unit) => (PRICING_UNIT_LABEL[unit] ?? unit).replace('per ', '')).join(', ')}. Leave a unit blank to remove that rate. Amounts are in ${values.currency}, with up to two decimals.`
    : `Enter the units you want to offer. Meeting & training room and Auditorium support: ${ALLOWED_PRICING_UNITS.MEETING_ROOM.map((unit) => (PRICING_UNIT_LABEL[unit] ?? unit).replace('per ', '')).join(', ')}. Co-working supports: ${ALLOWED_PRICING_UNITS.COWORKING.map((unit) => (PRICING_UNIT_LABEL[unit] ?? unit).replace('per ', '')).join(', ')}. Units the chosen category does not support are ignored by the server.`;

  const ratesFieldset = html`<div class="stack">
    <div class="form-grid">
      ${visibleUnits.map((unit) => {
    const id = `rates_${unit}`;
    return inputField({
      id, label: pricingUnitLabel(unit).replace(/^per /, 'Price per '),
      value: values.rates?.[unit] ?? '', details, type: 'text', inputmode: 'decimal',
      placeholder: '0.00', hintId: 'rates-hint', lookup: `rates.${unit}`,
    });
  })}
    </div>
    <p class="hint" id="rates-hint">${ratesHint}</p>
    <p class="hint">At least one rate is required before the space can be published.</p>
  </div>`;

  const pricingUnitHint = isEdit
    ? `The unit used when a booking does not choose one. ${categoryLabel(category)} supports: ${allowedUnits.map((unit) => (PRICING_UNIT_LABEL[unit] ?? unit).replace('per ', '')).join(', ')}.`
    : 'The unit used when a booking does not choose one. It must be one of the units your chosen category supports, otherwise the server rejects the form with the allowed list.';

  const attributesBody = (panel) => html`<div class="stack">
    <div class="form-grid">
      ${(ATTRIBUTE_FIELDS[panel] ?? []).map((field) => {
    const name = `attributes_${panel}[${field.key}]`;
    const value = values.attributes?.[panel]?.[field.key];
    if (field.type === 'checkbox') {
      return checkboxField({ id: field.key, name, label: field.label, checked: value === true });
    }
    return inputField({
      id: field.key, name, label: field.label, value: value ?? '',
      details, type: field.type === 'number' ? 'number' : 'text',
      hint: field.hint ?? null, placeholder: field.placeholder ?? null,
      min: field.type === 'number' ? '0' : null, step: field.type === 'number' ? '1' : null,
    });
  })}
    </div>
    ${panel === 'coworking' && (isEdit ? category === SPACE_CATEGORY.COWORKING : true)
      ? inputField({
        id: 'desk_count', label: 'Desks in this space (bookable desk inventory)', value: values.desk_count ?? '1',
        details, type: 'number', min: '1', max: '500', step: '1', required: true,
        hint: 'Each desk is an individually bookable unit, so a booking of three desks consumes three desk rows. Reducing the desk count is refused while a desk still holds active occupancy — cancel or move those reservations first.',
      })
      : ''}
  </div>`;

  const categoryDetails = isEdit
    ? html`<fieldset class="stack">
        <legend>${categoryLabel(category)} specifications</legend>
        ${attributesBody(currentPanel)}
      </fieldset>`
    : html`<div class="stack">
        ${SPACE_CATEGORY_ORDER.map((option) => {
      const panel = ATTRIBUTE_PANEL_FOR_CATEGORY[option];
      return html`<details ${attr('open', option === category ? true : null)}>
        <summary>${SPACE_CATEGORY_LABEL[option]} details <span class="hint">(used only when the category is ${SPACE_CATEGORY_LABEL[option]})</span></summary>
        ${attributesBody(panel)}
      </details>`;
    })}
      </div>`;

  const amenitiesBody = html`<div class="stack">
    <p class="hint">Facilities shown on the public space page and used by the visitor amenity filter.</p>
    <div class="form-field--checkboxes">
      ${AMENITY_CATALOG.map((amenity) => checkboxField({
    id: `amenity_${amenity.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: 'amenities', value: amenity, label: amenity,
    checked: Array.isArray(values.amenities) && values.amenities.includes(amenity),
  }))}
    </div>
    ${inputField({
    id: 'amenities_other', label: 'Other amenities',
    value: values.amenities_other ?? '', details,
    hint: 'Comma-separated, merged with the checkboxes above. For example: Catering, Rooftop terrace.',
  })}
  </div>`;

  const body = html`<form method="post" action="${action}" class="stack">
    ${csrfField(csrfToken)}
    ${problemsSummary(details, {
    renderedIds,
    title: summaryMessage || 'Please correct the following before saving:',
  })}

    ${card({
    modifiers: 'form-section',
    title: '01 · Identity & Category',
    description: 'How the space is identified, classified, and introduced in the public directory.',
    body: html`<div class="stack">
      <div class="form-grid">
        ${inputField({ id: 'code', label: 'Space code', value: values.code, details, required: true, placeholder: 'e.g. MR-01', hint: 'Letters, numbers, dashes and underscores. Shown on bookings and invoices.' })}
        ${inputField({ id: 'name', label: 'Name', value: values.name, details, required: true, placeholder: 'e.g. Meeting room 1' })}
        ${selectField({
        id: 'category', label: 'Category', value: category, required: true, details,
        options: SPACE_CATEGORY_ORDER.map((option) => ({ value: option, label: SPACE_CATEGORY_LABEL[option] })),
        hint: 'Meeting rooms and auditoriums book as 1 exclusive unit; co-working spaces book as pooled individual desks. Category cannot be changed while active occupancy exists.',
      })}
      </div>
      ${inputField({ id: 'short_description', label: 'Short summary', value: values.short_description, details, required: true, hint: 'One concise line (up to 300 characters) shown on directory cards.' })}
      ${textareaField({ id: 'description', label: 'Detailed description', value: values.description, details, required: true, rows: 6, hint: 'At least 20 characters. Required before the space can be published.' })}
    </div>`,
  })}

    ${card({
    modifiers: 'form-section',
    title: '02 · Location & Capacity',
    description: 'Physical placement, maximum group size, and visitor access instructions.',
    body: html`<div class="stack">
      <div class="form-grid">
        ${inputField({ id: 'location', label: 'Location', value: values.location, details, required: true, placeholder: 'e.g. Trace Expert City, Building A', hint: 'Building or wing name shown to visitors.' })}
        ${inputField({ id: 'floor', label: 'Floor', value: values.floor, details, placeholder: 'e.g. 2nd floor' })}
        ${inputField({ id: 'capacity', label: 'Capacity (people)', value: values.capacity, details, required: true, type: 'number', min: '1', step: '1', hint: 'The largest group the space can hold. The booking engine refuses reservations with more attendees than this limit.' })}
      </div>
      ${inputField({ id: 'contact_note', label: 'Contact & access note', value: values.contact_note, details, hint: 'Optional. Phone extension, reception check-in instructions, or key collection note.' })}
    </div>`,
  })}

    ${card({
    modifiers: 'form-section',
    title: '03 · Operating Hours & Booking Rules',
    description: 'Daily East Africa Time (UTC+03:00) operating hours, booking length bounds, and turnaround buffers.',
    body: html`<div class="form-grid">
      ${inputField({ id: 'open_time', label: 'Opens at (EAT)', value: values.open_time, details, type: 'time', required: true })}
      ${inputField({ id: 'close_time', label: 'Closes at (EAT)', value: values.close_time, details, type: 'time', required: true, hint: 'Closing time must be after opening time.' })}
      ${inputField({ id: 'min_duration_minutes', label: 'Minimum duration (minutes)', value: values.min_duration_minutes, details, type: 'number', min: '15', step: '15', hint: 'Shortest reservation allowed (in 15-minute increments).' })}
      ${inputField({ id: 'max_duration_minutes', label: 'Maximum duration (minutes)', value: values.max_duration_minutes, details, type: 'number', min: '15', step: '15', hint: 'Leave blank for no maximum duration.' })}
      ${inputField({ id: 'buffer_minutes', label: 'Turnaround buffer between bookings (minutes)', value: values.buffer_minutes, details, type: 'number', min: '0', max: '240', step: '5', hint: 'Kept free before and after each reservation for room reset/cleaning.' })}
    </div>`,
  })}

    ${card({
    modifiers: 'form-section',
    title: '04 · Pricing & Billing Units',
    description: 'Configure currency, default billing unit, and the rate schedule. At least one rate is required to publish.',
    body: html`<div class="stack">
      <div class="form-grid">
        ${selectField({ id: 'currency', label: 'Currency', value: values.currency, options: CURRENCIES.map((code) => ({ value: code, label: code })), details })}
        ${selectField({ id: 'pricing_unit', label: 'Default pricing unit', value: values.pricing_unit, required: true, options: pricingUnitOptions, details, hint: pricingUnitHint })}
      </div>
      ${ratesFieldset}
    </div>`,
  })}

    ${card({
    modifiers: 'form-section',
    title: '05 · Category Specifications & Amenities',
    description: 'Category-specific room layout, pooled desk inventory, and visitor-facing amenities.',
    body: html`<div class="stack">
      ${categoryDetails}
      <hr>
      ${amenitiesBody}
    </div>`,
  })}

    <div class="form-actions">
      <button class="button button--primary" type="submit">${isEdit ? 'Save changes' : 'Create space'}</button>
      <a class="button button--ghost" href="${cancelHref}">Cancel</a>
    </div>
  </form>`;

  return adminShell({
    title: isEdit ? `Edit ${space.name}` : 'New space',
    subtitle: isEdit ? `${space.code} · ${categoryLabel(space.category)}` : 'Create a catalogue entry. It starts as a draft until it is published.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/spaces',
    breadcrumbs: isEdit
      ? [{ label: 'Admin', href: '/admin' }, { label: 'Spaces', href: '/admin/spaces' }, { label: space.code, href: `/admin/spaces/${space.id}` }, { label: 'Edit' }]
      : [{ label: 'Admin', href: '/admin' }, { label: 'Spaces', href: '/admin/spaces' }, { label: 'New space' }],
    body,
  });
}

/* --------------------------------------------------------------- detail page */

export function renderSpaceDetailPage({
  actor, csrfToken, flash = null, space, images, issues,
}) {
  const base = `/admin/spaces/${space.id}`;
  const isCoworking = space.category === SPACE_CATEGORY.COWORKING;
  const isDraft = space.status === SPACE_STATUS.DRAFT;
  const isPublished = space.status === SPACE_STATUS.PUBLISHED;
  const isArchived = space.status === SPACE_STATUS.ARCHIVED;
  const ready = issues.length === 0;
  const canPublish = isDraft && ready;

  /* --------------------------------------------------- publish readiness */
  const checklistItems = [
    { label: 'At least one photograph uploaded', ok: space.imageCount >= 1 },
    { label: 'Detailed description (20+ characters)', ok: Boolean(space.description && space.description.length >= 20) },
    { label: 'Short summary and location configured', ok: Boolean(space.shortDescription && space.location) },
    { label: 'Rate schedule configured', ok: Boolean(space.rates && Object.keys(space.rates).length > 0) },
    { label: 'Active bookable resource units', ok: space.unitCount >= 1 },
  ];

  const publishForm = canPublish
    ? html`<form method="post" action="${base}/publish" class="inline-form">
        ${csrfField(csrfToken)}
        <button class="button button--primary" type="submit">Publish this space</button>
      </form>`
    : isDraft
      ? html`<div class="stack">
          <form method="post" action="${base}/publish" class="inline-form">
            ${csrfField(csrfToken)}
            <button class="button button--primary" type="submit" disabled aria-disabled="true">Publish this space</button>
          </form>
          <p class="hint">Publishing is blocked until the checklist above is clear. The server enforces the same rule, so the button cannot be forced.</p>
        </div>`
      : '';

  const unpublishForm = isPublished
    ? html`<form method="post" action="${base}/unpublish" class="inline-form" data-confirm="Move this space back to draft? It will disappear from the public directory until it is published again.">
        ${csrfField(csrfToken)}
        <button class="button button--ghost" type="submit">Move back to draft</button>
      </form>`
    : '';

  const archiveForm = isArchived ? '' : html`<details>
    <summary class="hint">Archive this space…</summary>
    <form method="post" action="${base}/archive" class="stack" data-confirm="Archive this space? It will be hidden from the public site and will not accept new reservations.">
      ${csrfField(csrfToken)}
      <div class="form-field">
        <label for="archive_reason">Archive reason (optional)</label>
        <input id="archive_reason" name="reason" maxlength="300" placeholder="e.g. Refurbishment, replaced by a larger room">
      </div>
      <div class="form-actions">
        <button class="button button--danger button--small" type="submit">Archive this space</button>
      </div>
    </form>
  </details>`;

  const restoreForm = isArchived
    ? html`<form method="post" action="${base}/restore" class="inline-form" data-confirm="Restore this space to draft? It stays hidden until it is published again.">
        ${csrfField(csrfToken)}
        <button class="button button--primary" type="submit">Restore from archive</button>
      </form>`
    : '';

  const statusBannerCard = card({
    title: 'Status & Publish Readiness',
    description: 'A space cannot be published until every checklist item is clear.',
    actions: html`<div class="cluster">
      ${statusBadge(space.status)}
      ${tag(inventoryIndicator(space), 'info')}
    </div>`,
    body: html`<div class="stack">
      <dl class="detail-list detail-list--inline">
        <dt>Status</dt><dd>${SPACE_STATUS_LABEL[space.status] ?? space.status}</dd>
        <dt>First published</dt><dd>${space.publishedAt ? friendlyDate(space.publishedAt) : 'Not published yet'}</dd>
        <dt>Archived</dt><dd>${space.archivedAt ? friendlyDate(space.archivedAt) : '—'}</dd>
        <dt>Last updated</dt><dd>${friendlyDate(space.updatedAt)}</dd>
      </dl>
      <div class="cluster">
        ${checklistItems.map((item) => tag(`${item.ok ? '✓' : '✕'} ${item.label}`, item.ok ? 'ok' : 'warn'))}
      </div>
      ${ready
      ? html`<div class="alert alert--success" role="status">
            <p>Ready to publish: every requirement is met.</p>
          </div>`
      : html`<div class="alert alert--warning" role="status">
            <p>Not ready to publish. Resolve the following first:</p>
            ${problemList(issues)}
          </div>`}
      <div class="cluster">
        ${publishForm}
        ${unpublishForm}
        ${restoreForm}
      </div>
      ${archiveForm}
    </div>`,
  });

  /* --------------------------------------------------------- photographs card */
  const imageIds = images.map((image) => image.id);
  const reorderValue = (index, target) => {
    if (target < 0 || target >= imageIds.length) return null;
    const next = [...imageIds];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next.join(',');
  };

  const imageList = images.length === 0
    ? emptyState('No photographs yet.', 'A space cannot be published until at least one photograph has been uploaded.')
    : html`<div class="space-grid">
        ${images.map((image, index) => {
      const upValue = reorderValue(index, index - 1);
      const downValue = reorderValue(index, index + 1);
      return html`<article class="space-card">
        <div class="space-card__media">
          <img src="${image.url}" alt="${image.altText ?? image.originalName}" width="320" height="180" loading="lazy" decoding="async">
          ${image.isCover ? html`<span class="space-card__badge">Cover</span>` : ''}
        </div>
        <div class="space-card__body">
          <p class="meta-line">
            ${image.isCover ? tag('Cover', 'info') : tag(`#${index + 1}`)}
            <strong>${image.originalName}</strong>
          </p>
          <p class="hint">${image.mimeType} · ${formatBytes(image.byteSize)} · position ${index + 1} of ${images.length}</p>
          <p class="hint">${image.altText ? `Alt text: ${image.altText}` : 'No alt text recorded.'}</p>
          <div class="space-card__actions">
            ${image.isCover ? '' : html`<form method="post" action="${base}/images/${image.id}/cover" class="inline-form">
              ${csrfField(csrfToken)}
              <button class="button button--ghost button--small" type="submit">Make cover</button>
            </form>`}
            ${upValue ? html`<form method="post" action="${base}/images/reorder" class="inline-form">
              ${csrfField(csrfToken)}
              <input type="hidden" name="orderedIds" value="${upValue}">
              <button class="button button--ghost button--small" type="submit">Move up</button>
            </form>` : ''}
            ${downValue ? html`<form method="post" action="${base}/images/reorder" class="inline-form">
              ${csrfField(csrfToken)}
              <input type="hidden" name="orderedIds" value="${downValue}">
              <button class="button button--ghost button--small" type="submit">Move down</button>
            </form>` : ''}
            <form method="post" action="${base}/images/${image.id}/delete" class="inline-form"
                  data-confirm="Delete this photograph? The file is removed and cannot be recovered.">
              ${csrfField(csrfToken)}
              <button class="button button--danger button--small" type="submit">Delete</button>
            </form>
          </div>
        </div>
      </article>`;
    })}
      </div>`;

  const photographsCard = card({
    title: 'Photograph Gallery & Upload Manager',
    description: `${images.length} of 12 uploaded · the photograph marked as the cover is shown first in the public directory.`,
    body: html`<div class="stack">
      ${imageList}
      <form method="post" action="${base}/images" enctype="multipart/form-data" class="stack">
        ${csrfField(csrfToken)}
        <div class="form-grid">
          <div class="form-field">
            <label for="images">Add photographs</label>
            <input id="images" name="images" type="file" multiple accept="image/jpeg,image/png,image/webp"
                   aria-describedby="images-hint">
            <p class="hint" id="images-hint">JPEG, PNG or WebP, up to 5 MB each, at most 12 per space. A space cannot be published without a photograph.</p>
          </div>
          <div class="form-field">
            <label for="alt_text">Alt text for the new photographs (optional)</label>
            <input id="alt_text" name="alt_text" maxlength="300" aria-describedby="alt_text-hint"
                   placeholder="e.g. Boardroom table with 10 chairs and natural light">
            <p class="hint" id="alt_text-hint">Describe the photographs for visitors using screen readers.</p>
          </div>
        </div>
        <div class="form-actions">
          <button class="button button--primary" type="submit">Upload photographs</button>
        </div>
      </form>
    </div>`,
  });

  /* ---------------------------------------------------------------- rates card */
  const rateEntries = Object.entries(space.rates ?? {}).sort((a, b) => a[1] - b[1]);
  const ratesCard = card({
    title: 'Rate Schedule',
    description: `${rateSummary(space)} · Default unit: ${pricingUnitLabel(space.pricingUnit)}`,
    actions: html`<a class="button button--ghost button--small" href="${base}/edit">Edit rates</a>`,
    body: rateEntries.length === 0
      ? emptyState('No rates configured.', 'Add at least one rate before publishing this space.')
      : table({
        columns: [{ label: 'Pricing unit' }, { label: 'Amount', align: 'right' }],
        rows: rateEntries.map(([unit, cents]) => ({
          cells: [
            html`${pricingUnitLabel(unit)} ${unit === space.pricingUnit ? tag('Default', 'info') : ''}`,
            html`<span class="price">${money(cents, space.currency)}</span>`,
          ],
        })),
      }),
  });

  /* ------------------------------------------------------------ inventory card */
  const inventoryCard = card({
    title: isCoworking ? 'Desk Inventory (Pooled Units)' : 'Bookable Resource Units',
    description: isCoworking
      ? `${space.unitCount} individually bookable co-working ${space.unitCount === 1 ? 'desk' : 'desks'}.`
      : 'Exclusive room allocation; only one active booking can hold this unit at any given time.',
    actions: html`<a class="button button--ghost button--small" href="${base}/edit">Configure</a>`,
    body: html`<div class="stack">
      <dl class="detail-list">
        <dt>${isCoworking ? 'Pooled Desks' : 'Exclusive Units'}</dt>
        <dd><strong>${inventoryIndicator(space)}</strong></dd>
        <dt>Max Capacity</dt>
        <dd>${space.capacity} ${space.capacity === 1 ? 'person' : 'people'}</dd>
      </dl>
      ${isCoworking
      ? html`<p class="hint">Each desk is an individually bookable resource unit, so a reservation of three desks claims three desk rows and overlapping desk bookings are refused. Reducing the desk count is refused while a desk still holds active occupancy.</p>`
      : html`<p class="hint">This category books one exclusive unit at a time. Capacity (${space.capacity}) limits attendee headcount, not concurrent bookings.</p>`}
      ${table({
        columns: [{ label: 'Unit code' }, { label: 'Label' }, { label: 'Kind' }],
        rows: space.units.map((unit) => ({
          cells: [html`<code>${unit.code}</code>`, unit.label, tag(unit.kind)],
        })),
        emptyMessage: 'No active units — configure the inventory before publishing.',
      })}
    </div>`,
  });

  /* -------------------------------------------------------------- details card */
  const amenityList = space.amenities?.length
    ? html`<ul class="amenity-list">${space.amenities.map((amenity) => html`<li>${tag(amenity)}</li>`)}</ul>`
    : html`<p class="hint">No amenities recorded.</p>`;
  const attributeEntries = Object.entries(space.attributes ?? {});
  const attributeList = attributeEntries.length === 0
    ? html`<p class="hint">No category details recorded.</p>`
    : html`<dl class="detail-list">
        ${attributeEntries.map(([key, value]) => html`<dt>${key.replace(/_/g, ' ')}</dt><dd>${String(value)}</dd>`)}
      </dl>`;

  const detailsCard = card({
    title: 'Space Overview & Specifications',
    description: 'Core catalogue metadata, operating hours, duration limits, and amenities.',
    actions: html`<a class="button button--ghost button--small" href="${base}/edit">Edit details</a>`,
    body: html`<div class="stack">
      <dl class="detail-list">
        <dt>Code</dt><dd><code>${space.code}</code></dd>
        <dt>Name</dt><dd>${space.name}</dd>
        <dt>Category</dt><dd>${categoryLabel(space.category)}</dd>
        <dt>Short summary</dt><dd>${space.shortDescription ?? '—'}</dd>
        <dt>Description</dt><dd>${space.description ?? '—'}</dd>
        <dt>Location</dt><dd>${space.location ?? '—'}</dd>
        <dt>Floor</dt><dd>${space.floor ?? '—'}</dd>
        <dt>Capacity</dt><dd>${space.capacity} ${space.capacity === 1 ? 'person' : 'people'}</dd>
        <dt>Currency</dt><dd>${space.currency}</dd>
        <dt>Default pricing unit</dt><dd>${pricingUnitLabel(space.pricingUnit)}</dd>
        <dt>Minimum duration</dt><dd>${durationMinutesLabel(space.minDurationMinutes)}</dd>
        <dt>Maximum duration</dt><dd>${space.maxDurationMinutes ? durationMinutesLabel(space.maxDurationMinutes) : 'No maximum'}</dd>
        <dt>Buffer between bookings</dt><dd>${durationMinutesLabel(space.bufferMinutes === 0 ? 0 : space.bufferMinutes) === '—' ? 'None' : durationMinutesLabel(space.bufferMinutes)}</dd>
        <dt>Opening hours</dt><dd>${space.openTime}–${space.closeTime} (East Africa Time)</dd>
        <dt>Contact note</dt><dd>${space.contactNote ?? '—'}</dd>
        <dt>Created</dt><dd>${friendlyDate(space.createdAt)}</dd>
      </dl>
      <div>
        <h4 class="card__title">Amenities</h4>
        ${amenityList}
      </div>
      <div>
        <h4 class="card__title">Category details</h4>
        ${attributeList}
      </div>
    </div>`,
  });

  const body = html`<div class="stack">
    ${statusBannerCard}
    <div class="split-layout">
      <div class="stack">
        ${photographsCard}
        ${detailsCard}
      </div>
      <div class="stack">
        ${ratesCard}
        ${inventoryCard}
      </div>
    </div>
  </div>`;

  return adminShell({
    title: space.name,
    subtitle: `${space.code} · ${categoryLabel(space.category)} · ${space.unitCount} ${unitLabel(space.category)}`,
    actor,
    csrfToken,
    flash,
    activePath: '/admin/spaces',
    breadcrumbs: [
      { label: 'Admin', href: '/admin' },
      { label: 'Spaces', href: '/admin/spaces' },
      { label: space.code },
    ],
    pageActions: html`<a class="button button--ghost button--small" href="${base}/edit">Edit space</a>
      <a class="button button--primary button--small" href="/admin/reservations/new?space=${space.id}">Create reservation for this space</a>
      <a class="button button--ghost button--small" href="/admin/calendar?space=${space.id}">View in calendar</a>`,
    body,
  });
}
