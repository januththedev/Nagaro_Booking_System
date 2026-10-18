/**
 * Admin booking views: the consolidated reservation list, the booking form,
 * the reservation detail page and the maintenance workspace.
 *
 * Views receive plain data and never touch the database. Markup uses the class
 * vocabulary defined by src/web/public/styles.css and the primitives exported
 * from src/web/lib/html.js; the data-attribute hooks consumed by
 * src/web/public/admin.js are documented next to the markup that provides them.
 */
import {
  csrfField, dateTimeLabel, durationLabel, emptyState, fieldError, friendlyDate, html, money,
  pagination, periodLabel, pricingUnitLabel, problemList, raw, relativeDayLabel, statusBadge, timeLabel,
} from '../../lib/html.js';
import { adminShell, card, table } from '../layout.js';
import {
  ALLOWED_PRICING_UNITS, OCCUPANCY_SOURCE, RESERVATION_STATUS, SPACE_CATEGORY_LABEL,
  SPACE_CATEGORY_ORDER,
} from '../../../server/domain/constants.js';

const NOT_SET = '—';

/* ------------------------------------------------------------------ shared */

/** Conflict rows: the period, the blocking reservation (linked) or maintenance. */
export function conflictList(conflicts = []) {
  if (!conflicts || conflicts.length === 0) return '';
  return html`<ul class="problem-list">
    ${conflicts.map((conflict) => html`<li>
      ${periodLabel(conflict.startAt, conflict.endAt)} \u2014
      ${conflict.reservationId
    ? html`<a href="/admin/reservations/${conflict.reservationId}">${conflict.reservationReference ?? 'existing booking'}</a>`
    : html`<span>${conflict.source === OCCUPANCY_SOURCE.MAINTENANCE
      ? `Maintenance block${conflict.maintenanceReason ? `: ${conflict.maintenanceReason}` : ''}`
      : (conflict.label ?? 'blocked')}</span>`}
      ${conflict.unitCode ? html`<span> \u00b7 unit ${conflict.unitCode}</span>` : ''}
      ${conflict.customerName ? html`<span> \u00b7 ${conflict.customerName}</span>` : ''}
    </li>`)}
  </ul>`;
}

/** Prominent inline alert (used instead of a flash when a form is re-rendered). */
export function alertBlock(alert) {
  if (!alert) return '';
  const kind = alert.kind === 'warning' ? 'alert--warning'
    : alert.kind === 'success' ? 'alert--success' : 'alert--error';
  return html`<div class="alert ${kind}" role="alert">
    ${alert.title ? html`<p><strong>${alert.title}</strong></p>` : ''}
    ${alert.message ? html`<p>${alert.message}</p>` : ''}
    ${alert.note ? html`<p>${alert.note}</p>` : ''}
    ${alert.conflicts && alert.conflicts.length ? conflictList(alert.conflicts) : ''}
    ${alert.problems && alert.problems.length ? problemList(alert.problems) : ''}
  </div>`;
}

function spaceOptionLabel(space, { archived = false } = {}) {
  const rate = space.rates && space.rates[space.pricingUnit] !== undefined
    ? `${money(space.rates[space.pricingUnit], space.currency)} ${pricingUnitLabel(space.pricingUnit)}`
    : 'rate on request';
  return `${space.code} \u2014 ${space.name} (capacity ${space.capacity}, ${rate})${archived ? ' (archived)' : ''}`;
}

/**
 * Grouped space picker. Each option carries the hooks the client uses:
 *   [data-space-code]       the space code, for display and follow-up fetches
 *   [data-available-desks]  active bookable units (courtesy hint only)
 * The form itself mirrors the current selection in the same attributes.
 */
function spaceSelect({ spaces, selectedId, id = 'space_id', required = true, allowArchived = false }) {
  const groups = SPACE_CATEGORY_ORDER
    .map((category) => ({
      category,
      label: SPACE_CATEGORY_LABEL[category],
      spaces: spaces.filter((space) => space.category === category),
    }))
    .filter((group) => group.spaces.length > 0);

  return html`<select id="${id}" name="space_id"${raw(required ? ' required' : '')}>
    <option value="">Choose a space…</option>
    ${groups.map((group) => html`<optgroup label="${group.label}">
      ${group.spaces.map((space) => html`<option value="${space.id}"
        data-space-code="${space.code}"
        data-available-desks="${space.unitCount ?? 0}"
        ${raw(String(space.id) === String(selectedId) ? ' selected' : '')}>${spaceOptionLabel(space, { archived: allowArchived && space.status === 'ARCHIVED' })}</option>`)}
    </optgroup>`)}
  </select>`;
}

/* -------------------------------------------------------------- list page */

export function renderReservationListPage({
  actor, csrfToken, flash = null, reservations = [], filters = {}, spaces = [],
  total = 0, page = 1, pageSize = 20,
}) {
  const extraQuery = {
    status: filters.status ?? 'all',
    space: filters.space ?? '',
    category: filters.category ?? '',
    customer: filters.customer ?? '',
    q: filters.q ?? '',
    from: filters.from ?? '',
    to: filters.to ?? '',
    sort: filters.sort ?? 'start',
  };
  Object.keys(extraQuery).forEach((key) => { if (!extraQuery[key]) delete extraQuery[key]; });

  const rows = reservations.map((reservation) => ({
    cells: [
      html`<a href="/admin/reservations/${reservation.id}">${reservation.reference}</a>`,
      html`<span class="nowrap">${reservation.spaceCode}</span><br><span class="hint">${reservation.spaceName}</span>`,
      categoryLabelText(reservation.category),
      html`${reservation.customerName}<br><span class="hint">${reservation.customerOrganization ?? NOT_SET}</span>`,
      periodLabel(reservation.startAt, reservation.endAt),
      durationLabel(reservation.startAt, reservation.endAt),
      unitSummary(reservation),
      html`<span class="nowrap">${money(reservation.totalCents, reservation.currency)}</span>`,
      statusBadge(reservation.status),
      html`${reservation.createdByName ?? NOT_SET}<br><span class="hint">${relativeDayLabel(reservation.createdAt)} ${timeLabel(reservation.createdAt)}</span>`,
    ],
  }));

  const body = html`
    ${card({
    title: 'Filters',
    description: 'Narrow the list by status, space, category, customer, reference or period.',
    body: html`<form class="filter-bar" method="get" action="/admin/reservations">
      <div class="filter-bar__field">
        <label for="filter-status">Status</label>
        <select id="filter-status" name="status">
          ${[['all', 'All statuses'], ['CONFIRMED', 'Confirmed'], ['COMPLETED', 'Completed'], ['CANCELLED', 'Cancelled']]
        .map(([value, label]) => html`<option value="${value}"${raw((filters.status ?? 'all') === value ? ' selected' : '')}>${label}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="filter-space">Space</label>
        <select id="filter-space" name="space">
          <option value="">All spaces</option>
          ${spaces.map((space) => html`<option value="${space.id}"${raw(String(filters.space ?? '') === String(space.id) ? ' selected' : '')}>${space.code} \u2014 ${space.name}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="filter-category">Category</label>
        <select id="filter-category" name="category">
          <option value="">All categories</option>
          ${SPACE_CATEGORY_ORDER.map((category) => html`<option value="${category}"${raw(filters.category === category ? ' selected' : '')}>${SPACE_CATEGORY_LABEL[category]}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="filter-customer">Customer</label>
        <input id="filter-customer" name="customer" type="search" value="${filters.customer ?? ''}" placeholder="Name, organisation or email">
      </div>
      <div class="filter-bar__field">
        <label for="filter-q">Reference</label>
        <input id="filter-q" name="q" type="search" value="${filters.q ?? ''}" placeholder="NG-2026-00001, customer or space">
      </div>
      <div class="filter-bar__field">
        <label for="filter-from">From</label>
        <input id="filter-from" name="from" type="date" value="${filters.from ?? ''}">
      </div>
      <div class="filter-bar__field">
        <label for="filter-to">To</label>
        <input id="filter-to" name="to" type="date" value="${filters.to ?? ''}">
      </div>
      <div class="filter-bar__field">
        <label for="filter-sort">Sort</label>
        <select id="filter-sort" name="sort">
          ${[['start', 'Period (earliest first)'], ['created', 'Most recently created'], ['reference', 'Reference']]
        .map(([value, label]) => html`<option value="${value}"${raw((filters.sort ?? 'start') === value ? ' selected' : '')}>${label}</option>`)}
        </select>
      </div>
      <div class="filter-bar__actions">
        <button class="button button--primary button--small" type="submit">Apply</button>
        <a class="button button--ghost button--small" href="/admin/reservations">Reset</a>
      </div>
    </form>`,
  })}

    ${card({
    title: `${total} reservation${total === 1 ? '' : 's'}`,
    description: 'Confirmed and completed bookings hold inventory. Cancelled bookings release it and are shown for history.',
    actions: html`<span class="hint">Page ${page} · ${pageSize} per page</span>`,
    body: html`${table({
      columns: [
        { label: 'Reference' }, { label: 'Space' }, { label: 'Category' }, { label: 'Customer' },
        { label: 'Period' }, { label: 'Duration' }, { label: 'Units / attendees' },
        { label: 'Total', align: 'right' }, { label: 'Status' }, { label: 'Created' },
      ],
      rows,
      emptyMessage: 'No reservations match these filters yet. Create the first one with “New reservation”.',
    })}
    ${pagination({ page, pageSize, total, basePath: '/admin/reservations', extraQuery })}`,
  })}`;

  return adminShell({
    title: 'Reservations',
    subtitle: 'Every booking, with filters for status, space, category, customer and period.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/reservations',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Reservations' }],
    pageActions: html`<a class="button button--primary button--small" href="/admin/reservations/new">New reservation</a>`,
    body,
  });
}

function categoryLabelText(category) {
  return SPACE_CATEGORY_LABEL[category] ?? category;
}

function unitSummary(reservation) {
  const units = reservation.unitCount === 1 ? '1 unit' : `${reservation.unitCount} units`;
  const attendees = reservation.attendees === null || reservation.attendees === undefined
    ? '—'
    : `${reservation.attendees} attending`;
  return html`${units}<br><span class="hint">${attendees}</span>`;
}

/* ------------------------------------------------------------- booking form */

export function renderBookingFormPage({
  actor, csrfToken, flash = null, mode = 'create', reservation = null, spaces = [], values = {},
  formToken, customerDisplay = '', preview = null, alert = null, fieldErrors = null,
}) {
  const isEdit = mode === 'edit';
  const selectedSpace = spaces.find((space) => String(space.id) === String(values.space_id)) ?? null;
  // Same fallback the route uses when it builds the server-side preview, so the
  // "× N units" figure always matches the quote the server rendered.
  const previewUnitCount = Math.max(1, Number(values.unit_count) || 1);
  const windowError = firstError(fieldErrors, ['date', 'start_time', 'end_time', 'start_at', 'end_at']);
  const title = isEdit ? `Edit ${reservation.reference}` : 'New reservation';

  const body = html`
    ${alertBlock(alert)}

    <form method="post" action="${isEdit ? `/admin/reservations/${reservation.id}` : '/admin/reservations'}"
          class="form-grid" data-reservation-form data-tz-offset="+03:00"
          data-space-code="${selectedSpace?.code ?? ''}"
          data-available-desks="${selectedSpace?.unitCount ?? ''}">
      ${csrfField(csrfToken)}
      <input type="hidden" name="form_token" value="${formToken}">

      <div class="form-field form-field--full"><h2 class="card__title">Space and period</h2></div>

      <div class="form-field form-field--full">
        <label for="space_id">Space</label>
        ${spaceSelect({ spaces, selectedId: values.space_id ?? '', required: true, allowArchived: isEdit })}
        <p class="hint">Grouped by category. Archived spaces are not bookable.</p>
        ${fieldError(fieldErrors, 'space_id')}
      </div>

      <div class="form-field">
        <label for="date">Date</label>
        <input id="date" name="date" type="date" value="${values.date ?? ''}" required
               ${raw(windowError ? ' aria-invalid="true"' : '')}>
      </div>
      <div class="form-field">
        <label for="start_time">Start time</label>
        <input id="start_time" name="start_time" type="time" value="${values.start_time ?? ''}" required
               ${raw(windowError ? ' aria-invalid="true"' : '')}>
      </div>
      <div class="form-field">
        <label for="end_time">End time</label>
        <input id="end_time" name="end_time" type="time" value="${values.end_time ?? ''}" required
               ${raw(windowError ? ' aria-invalid="true"' : '')}>
        <p class="hint">An end time earlier than the start time rolls over to the next day (overnight bookings).</p>
      </div>
      <div class="form-field">
        <label for="unit_count">${selectedSpace?.category === 'COWORKING' ? 'Desks' : 'Units'}</label>
        ${selectedSpace && selectedSpace.category !== 'COWORKING'
    ? html`<input id="unit_count" name="unit_count" type="number" value="1" min="1" max="1" readonly>
             <p class="hint">This space has a single bookable unit.</p>`
    : html`<input id="unit_count" name="unit_count" type="number" value="${values.unit_count ?? ''}" min="1" max="500"
                  ${raw(selectedSpace ? '' : 'disabled')} data-max-desks="${selectedSpace?.unitCount ?? ''}">
             <p class="hint">${selectedSpace
      ? `${selectedSpace.unitCount} desk${selectedSpace.unitCount === 1 ? '' : 's'} available in this space.`
      : 'Choose a space first.'}</p>`}
        ${fieldError(fieldErrors, 'unit_count')}
      </div>
      <div class="form-field">
        <label for="attendees">Attendees</label>
        <input id="attendees" name="attendees" type="number" min="1" max="100000" value="${values.attendees ?? ''}">
        <p class="hint">Optional. Must not exceed the space capacity.</p>
        ${fieldError(fieldErrors, 'attendees')}
      </div>

      <div class="form-field form-field--full">${windowError ? html`<p class="field-error">${windowError}</p>` : ''}</div>

      <div class="form-field form-field--full">${availabilityPanel(preview, selectedSpace)}</div>

      <div class="form-field form-field--full"><h2 class="card__title">Customer</h2></div>
      <div class="form-field form-field--full">
        <div class="combobox">
          <label for="customer_search">Customer</label>
          <input id="customer_search" name="customer_search" type="search" value="${values.customer_search ?? ''}"
                 data-customer-search role="combobox" aria-expanded="false" aria-controls="customer-search-listbox"
                 aria-autocomplete="list" autocomplete="off"
                 aria-describedby="customer-hint">
          <input type="hidden" name="customer_id" value="${values.customer_id ?? ''}">
          <ul class="combobox__list" id="customer-search-listbox" role="listbox" hidden></ul>
          <p class="hint" id="customer-hint" data-customer-display>${customerDisplay || 'Type at least two letters and pick a customer profile.'}</p>
          <div class="cluster">
            <button class="button button--ghost button--small" type="button" data-new-customer-toggle>New customer</button>
            <button class="button button--ghost button--small" type="button" data-customer-clear>Clear selection</button>
          </div>
          ${fieldError(fieldErrors, 'customer_id')}
        </div>
        <details data-new-customer-fields open>
          <summary>Create a new customer profile</summary>
          <p class="hint">Without JavaScript this is the path that works: complete these fields and the customer is created together with the booking.</p>
          <div class="form-grid">
            <div class="form-field">
              <label for="new_customer_name">Full name</label>
              <input id="new_customer_name" name="new_customer_name" type="text" maxlength="160"
                     value="${values.new_customer_name ?? ''}"${raw(fieldErrors?.new_customer_name ? ' aria-invalid="true"' : '')}>
              ${fieldError(fieldErrors, 'new_customer_name')}
            </div>
            <div class="form-field">
              <label for="new_customer_email">Email</label>
              <input id="new_customer_email" name="new_customer_email" type="email" maxlength="254"
                     value="${values.new_customer_email ?? ''}"${raw(fieldErrors?.new_customer_email ? ' aria-invalid="true"' : '')}>
              ${fieldError(fieldErrors, 'new_customer_email')}
            </div>
            <div class="form-field">
              <label for="new_customer_phone">Telephone</label>
              <input id="new_customer_phone" name="new_customer_phone" type="tel" maxlength="40" value="${values.new_customer_phone ?? ''}">
              ${fieldError(fieldErrors, 'new_customer_phone')}
            </div>
            <div class="form-field">
              <label for="new_customer_organization">Organisation</label>
              <input id="new_customer_organization" name="new_customer_organization" type="text" maxlength="160" value="${values.new_customer_organization ?? ''}">
              ${fieldError(fieldErrors, 'new_customer_organization')}
            </div>
          </div>
        </details>
      </div>

      <div class="form-field form-field--full"><h2 class="card__title">Notes and billing</h2></div>
      <div class="form-field form-field--full">
        <label for="purpose">Purpose of the booking</label>
        <input id="purpose" name="purpose" type="text" maxlength="2000" value="${values.purpose ?? ''}">
        ${fieldError(fieldErrors, 'purpose')}
      </div>
      <div class="form-field form-field--full">
        <label for="internal_notes">Internal notes</label>
        <textarea id="internal_notes" name="internal_notes" rows="3" maxlength="2000">${values.internal_notes ?? ''}</textarea>
        <p class="hint">Staff only. Never shown on the public site or in notification emails.</p>
        ${fieldError(fieldErrors, 'internal_notes')}
      </div>
      <div class="form-field">
        <label for="billing_unit">Billing unit</label>
        <select id="billing_unit" name="billing_unit">
          ${billingUnitOptions(selectedSpace, values.billing_unit ?? '')}
        </select>
        <p class="hint">Leave on the space default to let the server choose.</p>
        ${fieldError(fieldErrors, 'billing_unit')}
      </div>
      <div class="form-field">
        <label for="billing_quantity">Billing quantity</label>
        <input id="billing_quantity" name="billing_quantity" type="number" min="1" max="100000" value="${values.billing_quantity ?? ''}">
        <p class="hint">Optional override. Blank means the server derives the quantity from the period.</p>
        ${fieldError(fieldErrors, 'billing_quantity')}
      </div>

      <div class="form-field form-field--full">${pricingPreview(preview, selectedSpace, previewUnitCount)}</div>

      <div class="form-actions form-field--full">
        <button class="button button--primary" type="submit">${isEdit ? 'Save changes' : 'Create reservation'}</button>
        <a class="button button--ghost" href="${isEdit ? `/admin/reservations/${reservation.id}` : '/admin/reservations'}">Cancel</a>
        ${isEdit ? html`<span class="hint">Saving re-allocates inventory atomically. If the period is taken the change is refused and nothing is written.</span>` : ''}
      </div>
    </form>`;

  return adminShell({
    title,
    subtitle: isEdit
      ? 'Changing the space, period or desk count releases the old allocation and takes the new one in one transaction.'
      : 'Create a confirmed booking. Availability is re-checked inside the booking transaction before anything commits.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/reservations',
    breadcrumbs: isEdit
      ? [{ label: 'Admin', href: '/admin' }, { label: 'Reservations', href: '/admin/reservations' },
        { label: reservation.reference, href: `/admin/reservations/${reservation.id}` }, { label: 'Edit' }]
      : [{ label: 'Admin', href: '/admin' }, { label: 'Reservations', href: '/admin/reservations' }, { label: 'New' }],
    body,
  });
}

function firstError(fieldErrors, fields) {
  if (!fieldErrors) return null;
  for (const field of fields) {
    if (typeof fieldErrors[field] === 'string' && fieldErrors[field]) return fieldErrors[field];
  }
  return null;
}

function billingUnitOptions(space, selected) {
  const units = space ? (ALLOWED_PRICING_UNITS[space.category] ?? []) : Object.values(ALLOWED_PRICING_UNITS).flat();
  const unique = [...new Set(units)];
  return [
    html`<option value=""${raw(selected === '' ? ' selected' : '')}>Space default${space ? ` (${pricingUnitLabel(space.pricingUnit)})` : ''}</option>`,
    ...unique.map((unit) => html`<option value="${unit}"${raw(selected === unit ? ' selected' : '')}>${unitLabel(unit)}${space && space.rates && space.rates[unit] !== undefined ? ` \u2014 ${money(space.rates[unit], space.currency)}` : ''}</option>`),
  ];
}

function unitLabel(unit) {
  return `${unit.replace('_', ' ').toLowerCase()} \u2014 ${pricingUnitLabel(unit)}`;
}

/**
 * Live availability region. `src/web/public/admin.js` re-checks
 * `/api/admin/availability` and rewrites the contents of
 * `[data-availability-result]`; without JavaScript this server-rendered
 * verdict stands. The submit button is never disabled here.
 */
function availabilityPanel(preview, space) {
  const availability = preview?.availability ?? null;
  if (!availability) {
    return html`<div class="availability-result" data-availability-result aria-live="polite">
      <p class="availability-result__headline">Availability not checked yet.</p>
      <p class="hint">The server re-checks availability inside the booking transaction. A free preview reserves nothing.</p>
    </div>`;
  }
  const ok = availability.isAvailable === true;
  return html`<div class="availability-result ${ok ? 'availability-result--ok' : 'availability-result--busy'}"
                    data-availability-result aria-live="polite">
    <p class="availability-result__headline">${ok
    ? `Free for this period: ${availability.freeUnits} of ${availability.totalUnits} ${availability.isPooled ? 'desks' : 'units'} available.`
    : `Not available for this period: ${availability.freeUnits} of ${availability.totalUnits} ${availability.isPooled ? 'desks' : 'units'} free, ${availability.requestedUnits} needed.`}</p>
    ${availability.conflicts && availability.conflicts.length ? conflictList(availability.conflicts) : ''}
    <p class="hint">Provisional preview for ${space ? space.code : 'this space'}. The booking transaction re-checks availability under the write lock — this check reserves nothing.</p>
  </div>`;
}

/**
 * Pricing preview. The numbers come from the server's own `quote()` for the
 * rendered window, so the form can never suggest a price the server would not
 * charge. The authoritative total is recomputed on POST and reported in the
 * confirmation.
 */
function pricingPreview(preview, space, unitCount = 1) {
  const price = preview?.price ?? null;
  const billableUnits = Math.max(1, Number(unitCount) || 1);
  const rates = space?.rates ?? null;
  const rateList = rates && Object.keys(rates).length
    ? Object.entries(rates)
      .sort((a, b) => a[1] - b[1])
      .map(([unit, cents]) => `${money(cents, space.currency)} ${pricingUnitLabel(unit)}`)
      .join(' · ')
    : null;

  if (!price) {
    return html`<div class="card" data-pricing-preview>
      <div class="card__body">
        <h2 class="card__title">Price preview</h2>
        <p class="hint">${rateList
    ? `Rates for this space: ${rateList}. Choose a space and a period to see the estimated total.`
    : 'Choose a space and a period to see the estimated total. Rates are configured per space.'}</p>
      </div>
    </div>`;
  }
  return html`<div class="card" data-pricing-preview
                   data-pricing-unit="${price.billingUnit}"
                   data-pricing-rate="${price.rateCents}"
                   data-pricing-quantity="${price.billingQuantity}"
                   data-pricing-unit-count="${billableUnits}">
    <div class="card__body">
      <h2 class="card__title">Price preview</h2>
      <p>${money(price.rateCents, price.currency)} ${pricingUnitLabel(price.billingUnit)} × ${price.billingQuantity} × ${billableUnits} ${billableUnits === 1 ? 'unit' : 'units'} = <strong>${money(price.totalCents, price.currency)}</strong></p>
      <p class="hint">Computed by the server for this exact window and billing unit. The total is recomputed when you save, and the confirmed total appears in the confirmation message.</p>
    </div>
  </div>`;
}

/* ------------------------------------------------------------ detail page */

export function renderReservationDetailPage({
  actor, csrfToken, flash = null, reservation, customer = null, space = null,
  currentRateCents = null, audit = [], alert = null, fieldErrors = null, cancelReason = '',
}) {
  const cancelled = reservation.status === RESERVATION_STATUS.CANCELLED;
  const completed = reservation.status === RESERVATION_STATUS.COMPLETED;

  const details = html`
    <dl class="detail-list">
      <dt>Reference</dt><dd>${reservation.reference}</dd>
      <dt>Status</dt><dd>${statusBadge(reservation.status)}</dd>
      <dt>Space</dt><dd>${space
    ? html`<a href="/admin/spaces/${space.id}">${reservation.spaceCode} \u2014 ${reservation.spaceName}</a>`
    : html`${reservation.spaceCode} \u2014 ${reservation.spaceName}`}
        <span class="hint"> · ${categoryLabelText(reservation.category)} · space status ${reservation.spaceStatus}</span></dd>
      <dt>Period</dt><dd>${periodLabel(reservation.startAt, reservation.endAt)}
        <span class="hint"> · ${durationLabel(reservation.startAt, reservation.endAt)} · time zone EAT (UTC+03:00)</span></dd>
      <dt>Start</dt><dd>${dateTimeLabel(reservation.startAt)}</dd>
      <dt>End</dt><dd>${dateTimeLabel(reservation.endAt)}</dd>
      <dt>Units</dt><dd>${reservation.unitCount} (${reservation.units.length ? reservation.units.map((unit) => unit.code).join(', ') : 'no active allocation'})</dd>
      <dt>Attendees</dt><dd>${reservation.attendees ?? NOT_SET}</dd>
      <dt>Purpose</dt><dd>${reservation.purpose || NOT_SET}</dd>
      <dt>Internal notes</dt><dd>${reservation.internalNotes || NOT_SET}</dd>
      <dt>Customer</dt><dd><a href="/admin/customers/${reservation.customerId}">${reservation.customer.fullName}</a></dd>
      <dt>Created</dt><dd>${reservation.createdByName ?? NOT_SET} · ${dateTimeLabel(reservation.createdAt)}</dd>
      <dt>Last updated</dt><dd>${reservation.updatedByName ?? NOT_SET} · ${dateTimeLabel(reservation.updatedAt)}</dd>
      <dt>Cancelled</dt><dd>${cancelled
    ? html`${reservation.cancelledByName ?? NOT_SET} · ${dateTimeLabel(reservation.cancelledAt)}<br><span class="hint">Reason: ${reservation.cancellationReason}</span>`
    : NOT_SET}</dd>
      <dt>Idempotency key</dt><dd>${reservation.idempotencyKey ?? NOT_SET}
        <span class="hint"> · the form token that makes a repeated submission safe</span></dd>
      <dt>Record id</dt><dd>${reservation.id}</dd>
    </dl>`;

  const pricing = html`
    <dl class="detail-list">
      <dt>Billing unit</dt><dd>${pricingUnitLabel(reservation.billingUnit)}</dd>
      <dt>Quantity</dt><dd>${reservation.billingQuantity}</dd>
      <dt>Unit rate</dt><dd>${money(reservation.rateCents, reservation.currency)}</dd>
      <dt>Billable units</dt><dd>${reservation.unitCount}</dd>
      <dt>Total</dt><dd><strong>${money(reservation.totalCents, reservation.currency)}</strong></dd>
      <dt>Currency</dt><dd>${reservation.currency}</dd>
    </dl>
    <p class="hint">${money(reservation.rateCents, reservation.currency)} × ${reservation.billingQuantity} × ${reservation.unitCount} = ${money(reservation.totalCents, reservation.currency)}.
      The stored figures are the price that was agreed; later rate changes never rewrite history.</p>
    ${currentRateCents !== null && currentRateCents !== reservation.rateCents
    ? html`<p class="hint">The space's current ${pricingUnitLabel(reservation.billingUnit)} rate is ${money(currentRateCents, reservation.currency)}.</p>`
    : ''}`;

  const unitsBody = reservation.units.length
    ? html`<ul>${reservation.units.map((unit) => html`<li>${unit.code} · ${unit.label} · ${unit.kind}</li>`)}</ul>`
    : emptyState(cancelled ? 'The allocation was released when this booking was cancelled.' : 'No active allocation found for this reservation.');

  const auditRows = audit.map((entry) => ({
    cells: [
      dateTimeLabel(entry.at),
      entry.actorLabel,
      html`<code>${entry.action}</code>`,
      entry.summary,
    ],
  }));

  const timeline = html`
    <ol>
      <li>${statusBadge(RESERVATION_STATUS.CONFIRMED)} ${reservation.createdByName ?? NOT_SET} · ${dateTimeLabel(reservation.createdAt)}</li>
      ${reservation.updatedAt && reservation.updatedAt !== reservation.createdAt
    ? html`<li>Updated by ${reservation.updatedByName ?? NOT_SET} · ${dateTimeLabel(reservation.updatedAt)}</li>` : ''}
      ${cancelled
    ? html`<li>${statusBadge(RESERVATION_STATUS.CANCELLED)} ${reservation.cancelledByName ?? NOT_SET} · ${dateTimeLabel(reservation.cancelledAt)}
             <br><span class="hint">Reason: ${reservation.cancellationReason}</span></li>`
    : completed
      ? html`<li>${statusBadge(RESERVATION_STATUS.COMPLETED)} — the booked period has ended; history preserved.</li>`
      : ''}
    </ol>`;

  const actions = html`<div class="cluster">
    ${cancelled ? '' : html`<a class="button button--primary button--small" href="/admin/reservations/${reservation.id}/edit">Edit booking</a>`}
    <a class="button button--ghost button--small" href="/admin/reservations/new?customer=${reservation.customerId}&space=${reservation.spaceId}">New booking for this customer</a>
    ${space ? html`<a class="button button--ghost button--small" href="/admin/spaces/${space.id}">View space</a>` : ''}
    <a class="button button--ghost button--small" href="/admin/calendar?date=${startDateKey(reservation)}&space=${reservation.spaceId}">Show on calendar</a>
    <a class="button button--ghost button--small" href="/admin/maintenance?space=${reservation.spaceId}">Maintenance</a>
  </div>`;

  const cancelCard = cancelled
    ? card({
      title: 'Cancellation',
      body: html`<p>${reservation.cancelledByName ?? NOT_SET} cancelled this booking on ${dateTimeLabel(reservation.cancelledAt)}.</p>
        <p class="hint">Reason recorded: ${reservation.cancellationReason}</p>
        <p class="hint">The record is permanent: the reservation row and its released occupancy rows are kept for history.</p>`,
    })
    : html`${card({
      title: 'Cancel this reservation',
      description: 'Cancelling releases the space or desks immediately.',
      body: html`<form method="post" action="/admin/reservations/${reservation.id}/cancel"
        data-confirm="Cancel ${reservation.reference}? The cancellation is recorded permanently with your name, the time and the reason you give.">
        ${csrfField(csrfToken)}
        <div class="form-field">
          <label for="cancellation_reason">Cancellation reason (required)</label>
          <textarea id="cancellation_reason" name="cancellation_reason" rows="3" maxlength="1000" required
                    aria-describedby="cancel-hint"${raw(fieldErrors?.cancellation_reason ? ' aria-invalid="true"' : '')}>${cancelReason}</textarea>
          ${fieldError(fieldErrors, 'cancellation_reason')}
          <p class="hint" id="cancel-hint">The booking history is preserved and the inventory is released — the space becomes bookable again
            straight away. <strong>Cancellation is recorded permanently</strong> and cannot be undone; create a new reservation instead.</p>
        </div>
        <div class="form-actions">
          <button class="button button--danger" type="submit">Cancel this reservation</button>
        </div>
      </form>`,
    })}`;

  const body = html`
    ${alertBlock(alert)}
    <div class="split-layout">
      <div>
        ${card({ title: 'Booking', description: 'Every stored field for this reservation.', body: details })}
        ${card({ title: 'Pricing breakdown', body: pricing })}
        ${card({ title: 'Allocated inventory', description: 'The specific units this booking holds.', body: unitsBody })}
        ${card({
      title: 'Activity for this reservation',
      description: 'Immutable audit entries written in the same transaction as each change.',
      body: auditRows.length
        ? table({
          columns: [{ label: 'When' }, { label: 'Actor' }, { label: 'Action' }, { label: 'Summary' }],
          rows: auditRows,
          emptyMessage: 'No audit entries.',
        })
        : emptyState('No audit entries for this reservation yet.'),
    })}
      </div>
      <div>
        ${card({
      title: 'Customer',
      body: html`<dl class="detail-list">
          <dt>Name</dt><dd><a href="/admin/customers/${reservation.customerId}">${reservation.customer.fullName}</a></dd>
          <dt>Email</dt><dd>${reservation.customer.email}</dd>
          <dt>Telephone</dt><dd>${reservation.customer.phone ?? NOT_SET}</dd>
          <dt>Organisation</dt><dd>${reservation.customer.organization ?? NOT_SET}</dd>
          <dt>Bookings</dt><dd>${customer ? `${customer.stats.confirmedReservations} confirmed · ${customer.stats.totalReservations} total` : NOT_SET}</dd>
          ${customer && customer.stats.lastBookingAt
          ? html`<dt>Last booking</dt><dd>${friendlyDate(customer.stats.lastBookingAt)}</dd>` : ''}
        </dl>
        <p class="hint"><a href="/admin/customers/${reservation.customerId}">Open the customer profile</a> for the full history.</p>`,
    })}
        ${card({ title: 'Status timeline', body: timeline })}
        ${card({ title: 'Permitted actions', body: actions })}
        ${cancelCard}
      </div>
    </div>`;

  return adminShell({
    title: `Reservation ${reservation.reference}`,
    subtitle: `${reservation.spaceCode} · ${periodLabel(reservation.startAt, reservation.endAt)}`,
    actor,
    csrfToken,
    flash,
    activePath: '/admin/reservations',
    breadcrumbs: [
      { label: 'Admin', href: '/admin' },
      { label: 'Reservations', href: '/admin/reservations' },
      { label: reservation.reference },
    ],
    body,
  });
}

function startDateKey(reservation) {
  // Business time zone is EAT (UTC+03:00): shift before slicing the ISO date.
  return new Date(reservation.startAt + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* -------------------------------------------------------- maintenance page */

export function renderMaintenancePage({
  actor, csrfToken, flash = null, blocks = [], filters = {}, spaces = [], spacesWithUnits = [],
  values = {}, formToken, alert = null, fieldErrors = null, problems = null,
}) {
  const rows = blocks.map((block) => ({
    cells: [
      html`${block.spaceCode}<br><span class="hint">${block.spaceName}</span>`,
      periodLabel(block.startAt, block.endAt),
      durationLabel(block.startAt, block.endAt),
      block.reason,
      block.unitCodes.length ? block.unitCodes.join(', ') : 'all units',
      statusBadge(block.status === 'ACTIVE' ? 'PUBLISHED' : 'ARCHIVED'),
      html`${block.createdByName ?? NOT_SET}<br><span class="hint">${relativeDayLabel(block.createdAt)} ${timeLabel(block.createdAt)}</span>`,
      block.status === 'ACTIVE'
        ? html`<form method="post" action="/admin/maintenance/${block.id}/cancel" class="inline-form"
                       data-confirm="Cancel this maintenance block? The blocked inventory is released immediately.">
            ${csrfField(csrfToken)}
            <input type="hidden" name="reason" value="Cancelled from the maintenance list">
            <button class="button button--ghost button--small" type="submit">Cancel block</button>
          </form>`
        : html`<span class="hint">Cancelled</span>`,
    ],
  }));

  const body = html`
    ${alertBlock(alert)}
    ${problems && problems.length ? html`<div class="alert alert--error" role="alert">${problemList(problems)}</div>` : ''}

    <div class="split-layout">
      <div>
        ${card({
    title: 'Maintenance blocks',
    description: 'A block claims the space\'s units as occupancy, so the same database rule that stops double bookings also stops maintenance over a confirmed reservation.',
    body: html`${table({
      columns: [
        { label: 'Space' }, { label: 'Period' }, { label: 'Duration' }, { label: 'Reason' },
        { label: 'Units' }, { label: 'Status' }, { label: 'Created' }, { label: 'Action' },
      ],
      rows,
      emptyMessage: 'No maintenance blocks yet. Use the form to block a period.',
    })}`,
  })}
      </div>
      <div>
        ${card({
    title: 'Block a period',
    description: 'Creating a block refuses to overlap a confirmed or completed reservation.',
    body: html`<form method="post" action="/admin/maintenance" class="form-grid" data-maintenance-form>
        ${csrfField(csrfToken)}
        <input type="hidden" name="form_token" value="${formToken}">
        <div class="form-field form-field--full">
          <label for="maintenance_space">Space</label>
          ${spaceSelect({ spaces, selectedId: values.space_id ?? '', id: 'maintenance_space', allowArchived: false })}
          ${fieldError(fieldErrors, 'space_id')}
        </div>
        <div class="form-field">
          <label for="maintenance_date">Date</label>
          <input id="maintenance_date" name="date" type="date" value="${values.date ?? ''}" required>
        </div>
        <div class="form-field">
          <label for="maintenance_start">Start time</label>
          <input id="maintenance_start" name="start_time" type="time" value="${values.start_time ?? ''}" required>
        </div>
        <div class="form-field">
          <label for="maintenance_end">End time</label>
          <input id="maintenance_end" name="end_time" type="time" value="${values.end_time ?? ''}" required>
          <p class="hint">An end earlier than the start rolls over to the next day.</p>
        </div>
        <div class="form-field form-field--full">
          <label for="maintenance_reason">Reason (required)</label>
          <input id="maintenance_reason" name="reason" type="text" maxlength="500" required value="${values.reason ?? ''}"
                 ${raw(fieldErrors?.reason ? ' aria-invalid="true"' : '')}>
          ${fieldError(fieldErrors, 'reason')}
        </div>
        <div class="form-field form-field--full">
          <label for="maintenance_units">Units to block (optional)</label>
          <select id="maintenance_units" name="unit_ids" multiple size="6">
            ${spacesWithUnits.map((entry) => html`<optgroup label="${entry.code}">
              ${entry.units.map((unit) => html`<option value="${unit.id}">${unit.code} \u2014 ${unit.label}</option>`)}
            </optgroup>`)}
          </select>
          <p class="hint">Leave empty to block every unit of the chosen space. Selections for other spaces are ignored.</p>
        </div>
        <div class="form-actions form-field--full">
          <button class="button button--primary" type="submit">Create maintenance block</button>
        </div>
      </form>`,
  })}
      </div>
    </div>`;

  return adminShell({
    title: 'Maintenance',
    subtitle: 'Planned unavailability, materialised as occupancy so it can never collide with a booking.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/maintenance',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Maintenance' }],
    body,
  });
}
