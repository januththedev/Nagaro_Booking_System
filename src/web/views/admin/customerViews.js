/**
 * Customer directory views.
 *
 * Three pages, all rendered inside the admin shell because every byte of
 * customer data is staff-only (ARCHITECTURE.md §8):
 *
 *   customerDirectoryView  list + filters (`q`, `sort`, `hasUpcoming`)
 *   customerFormView       create / edit, including the duplicate panel
 *   customerProfileView    profile, lifetime stats, upcoming bookings,
 *                          full booking history and frequent spaces
 *
 * Views receive plain objects and never query the database. Every input has a
 * matching `<label for>`; fields with errors carry `aria-invalid` and
 * `aria-describedby`. No customer data is ever rendered outside `adminShell`.
 */
import {
  attr, categoryLabel, csrfField, dateTimeLabel, durationLabel, emptyState, fieldError,
  friendlyDate, html, money, pagination, periodLabel, problemList, raw, statusBadge, tag,
} from '../../lib/html.js';
import {
  adminShell, card, pageContainer, table,
} from '../layout.js';

/** The system default currency; spaces may override it, customers do not. */
const CURRENCY = 'LKR';

const PRIVACY_NOTE = 'Customer details are visible only to signed-in staff. They never appear on the public site.';

const DIRECTORY_EMPTY_HINT = 'Customers are created automatically when a reservation is booked, or you can add one manually. Use “New customer” to create a profile before the first booking.';

/** Two-letter avatar monogram derived from a customer's full name. */
function customerMonogram(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'CU';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/* --------------------------------------------------------------- directory */

export function customerDirectoryView({
  actor, csrfToken, flash = null, items = [], total = 0, filters = {},
  page = 1, pageSize = 20, truncated = false, scanLimit = 1000,
}) {
  const columns = [
    { label: 'Customer' },
    { label: 'Organisation' },
    { label: 'Contact' },
    { label: 'Confirmed bookings', align: 'right' },
    { label: 'Last booking' },
    { label: 'Lifetime booked value', align: 'right' },
    { label: 'Created' },
  ];

  const rows = items.map((item) => ({
    cells: [
      html`<div class="cluster">
        <span class="tag" aria-hidden="true">${customerMonogram(item.fullName)}</span>
        <div>
          <a href="/admin/customers/${item.id}">${item.fullName}</a>
        </div>
      </div>`,
      item.organization || '—',
      html`<div>
        <a href="mailto:${item.email}">${item.email}</a>
        ${item.phone ? html`<div class="meta-line">${item.phone}</div>` : html`<div class="meta-line">—</div>`}
      </div>`,
      String(item.stats?.confirmedReservations ?? 0),
      friendlyDate(item.stats?.lastBookingAt),
      html`<span class="price">${money(item.stats?.bookedValueCents ?? 0, CURRENCY)}</span>`,
      friendlyDate(item.createdAt),
    ],
  }));

  const extraQuery = {};
  if (filters.q) extraQuery.q = filters.q;
  if (filters.sort && filters.sort !== 'name') extraQuery.sort = filters.sort;
  if (filters.hasUpcoming === true) extraQuery.hasUpcoming = 'true';
  else if (filters.hasUpcoming === false) extraQuery.hasUpcoming = 'false';

  const body = pageContainer({
    body: html`<div class="stack">
      ${truncated
        ? html`<div class="alert alert--warning" role="status">
            <p>The upcoming-booking filter scans at most ${scanLimit} customer records, so the count below may be
               incomplete. Narrow the search to see an exact total.</p>
          </div>`
        : ''}
      ${card({
        title: 'Find a customer',
        description: 'Search by name, email, organisation or phone. Filter by whether the customer has an upcoming confirmed booking.',
        body: directoryFilterForm(filters),
      })}
      ${card({
        title: `${total} customer${total === 1 ? '' : 's'}`,
        description: PRIVACY_NOTE,
        actions: html`<a class="button button--primary button--small" href="/admin/customers/new">New customer</a>`,
        body: html`<div class="stack">
          ${table({ columns, rows, emptyMessage: DIRECTORY_EMPTY_HINT })}
          ${pagination({
            page, pageSize, total, basePath: '/admin/customers', extraQuery,
          })}
        </div>`,
      })}
    </div>`,
  });

  return adminShell({
    title: 'Customers',
    subtitle: 'One authoritative profile per customer. Records are never merged automatically.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/customers',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Customers' }],
    pageActions: html`<a class="button button--primary button--small" href="/admin/customers/new">New customer</a>`,
    body,
  });
}

function directoryFilterForm(filters = {}) {
  const hasUpcomingValue = filters.hasUpcoming === true ? 'true'
    : filters.hasUpcoming === false ? 'false' : '';
  return html`<form class="filter-bar" method="get" action="/admin/customers" role="search">
    <div class="filter-bar__field">
      <label for="q">Search</label>
      <input id="q" name="q" type="search" value="${filters.q ?? ''}" placeholder="Name, email, organisation or phone…" aria-describedby="q-hint">
      <p class="hint" id="q-hint">Matches name, email, organisation or phone.</p>
    </div>
    <div class="filter-bar__field">
      <label for="sort">Sort by</label>
      <select id="sort" name="sort">
        <option value="name"${attr('selected', (filters.sort ?? 'name') === 'name')}>Name (A–Z)</option>
        <option value="recent"${attr('selected', filters.sort === 'recent')}>Recently added</option>
        <option value="bookings"${attr('selected', filters.sort === 'bookings')}>Most booked</option>
      </select>
    </div>
    <div class="filter-bar__field">
      <label for="hasUpcoming">Upcoming bookings</label>
      <select id="hasUpcoming" name="hasUpcoming">
        <option value=""${attr('selected', hasUpcomingValue === '')}>Any customer</option>
        <option value="true"${attr('selected', hasUpcomingValue === 'true')}>Has an upcoming confirmed booking</option>
        <option value="false"${attr('selected', hasUpcomingValue === 'false')}>No upcoming booking</option>
      </select>
    </div>
    <div class="filter-bar__actions">
      <button class="button button--primary button--small" type="submit">Apply filters</button>
      <a class="button button--ghost button--small" href="/admin/customers">Clear</a>
    </div>
  </form>`;
}

/* --------------------------------------------------------------- form page */

/**
 * The create form's field values, mapped from a hydrated Customer. Field names
 * are the snake_case payload keys `parseCustomerPayload` understands.
 */
export function customerFormValuesFromCustomer(customer) {
  return {
    full_name: customer?.fullName ?? '',
    email: customer?.email ?? '',
    phone: customer?.phone ?? '',
    organization: customer?.organization ?? '',
    notes: customer?.notes ?? '',
  };
}

export function customerFormView({
  actor, csrfToken, flash = null, mode = 'create', customerId = null,
  values = {}, errors = null, duplicates = [], problems = [],
  conflictMessage = null, conflictCustomer = null,
}) {
  const editing = mode === 'edit';
  const action = editing ? `/admin/customers/${customerId}` : '/admin/customers';
  const hasDuplicates = duplicates.length > 0;
  const submitLabel = hasDuplicates ? 'Create a separate record anyway'
    : editing ? 'Save changes' : 'Create customer';

  const body = pageContainer({
    body: html`<div class="stack">
      ${problems.length > 0
        ? html`<div class="alert alert--error" role="alert">
            <p>The record was not saved. Please correct the problems below.</p>
            ${problemList(problems)}
          </div>`
        : ''}
      ${conflictMessage
        ? html`<div class="alert alert--error" role="alert">
            <p>${conflictMessage}</p>
            ${conflictCustomer
              ? html`<p>The email belongs to
                  <a href="/admin/customers/${conflictCustomer.id}">${conflictCustomer.fullName}</a>.
                  Open that profile instead, or use a different email address.</p>`
              : ''}
          </div>`
        : ''}
      ${hasDuplicates ? duplicatePanel({ duplicates }) : ''}
      ${card({
        title: editing ? 'Edit customer' : 'New customer',
        description: editing
          ? 'Changes are kept in the activity log. Emails must be unique across the directory.'
          : 'Create one profile per customer. If a reservation already used this person’s email, the profile may already exist — check the possible duplicates before saving.',
        body: html`<form class="form-grid" method="post" action="${action}">
          ${csrfField(csrfToken)}
          ${textField({
            id: 'full_name', label: 'Full name', value: values.full_name, required: true,
            errors, hint: 'For example: Hanna Tesfaye.',
          })}
          ${textField({
            id: 'email', label: 'Email address', type: 'email', value: values.email, required: true,
            errors, hint: 'Used to detect duplicates. Compared in lower case, ignoring surrounding spaces.',
          })}
          ${textField({
            id: 'phone', label: 'Telephone', value: values.phone, errors,
            hint: 'Optional. Digits, spaces, dashes, parentheses, + and . only.',
          })}
          ${textField({
            id: 'organization', label: 'Organisation', value: values.organization, errors,
            hint: 'Optional. The company or institution the customer books for.',
          })}
          <div class="form-field form-field--full">
            <label for="notes">Private notes</label>
            <textarea id="notes" name="notes" rows="5" aria-describedby="notes-hint">${values.notes ?? ''}</textarea>
            <p class="hint" id="notes-hint">Private — staff only. Never shown to the customer or on the public site.</p>
          </div>
          ${hasDuplicates
            ? html`<div class="form-field form-field--full">
                <label for="confirm_duplicate">
                  <input id="confirm_duplicate" name="confirm_duplicate" type="checkbox" value="1"
                         aria-describedby="confirm_duplicate-hint">
                  Create a separate record anyway
                </label>
                <p class="hint" id="confirm_duplicate-hint">
                  Only tick this when the matches above are genuinely different people. The system does not merge or link records.
                </p>
              </div>`
            : ''}
          <div class="form-actions">
            <button class="button button--primary" type="submit">${submitLabel}</button>
            <a class="button button--ghost" href="${editing ? `/admin/customers/${customerId}` : '/admin/customers'}">Cancel</a>
          </div>
        </form>`,
      })}
    </div>`,
  });

  return adminShell({
    title: editing ? 'Edit customer' : 'New customer',
    subtitle: 'Customer details are visible only to signed-in staff.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/customers',
    breadcrumbs: editing
      ? [
        { label: 'Admin', href: '/admin' },
        { label: 'Customers', href: '/admin/customers' },
        { label: values.full_name || 'Customer', href: `/admin/customers/${customerId}` },
        { label: 'Edit' },
      ]
      : [
        { label: 'Admin', href: '/admin' },
        { label: 'Customers', href: '/admin/customers' },
        { label: 'New customer' },
      ],
    body,
  });
}

/** Possible-duplicate review panel. Never merges: staff choose a record. */
function duplicatePanel({ duplicates }) {
  const columns = [
    { label: 'Name' },
    { label: 'Email' },
    { label: 'Organisation' },
    { label: 'Confirmed bookings', align: 'right' },
    { label: 'Matched on' },
  ];
  const rows = duplicates.map((entry) => {
    const matchLabel = entry.match === 'email'
      ? `Email (exact, ${entry.confidence} confidence)`
      : `Name (possible, ${entry.confidence} confidence)`;
    return {
      cells: [
        html`<a href="/admin/customers/${entry.customer.id}">${entry.customer.fullName}</a>`,
        entry.customer.email || '—',
        entry.customer.organization || '—',
        String(entry.customer.stats?.confirmedReservations ?? 0),
        matchLabel,
      ],
    };
  });

  return card({
    title: `Possible duplicate: ${duplicates.length} existing ${duplicates.length === 1 ? 'record' : 'records'}`,
    description: 'Records are never merged automatically. Review each match and either open the existing profile (and book against it) or create a separate record deliberately.',
    body: html`<div class="stack">
      <div class="alert alert--warning" role="alert">
        <p>Another customer may already match this person. Nothing has been saved yet.</p>
      </div>
      ${table({ columns, rows, emptyMessage: 'No possible duplicates.' })}
    </div>`,
  });
}

function textField({
  id, label, value = '', type = 'text', required = false, errors = null, hint = null,
}) {
  const message = errorMessageFor(errors, id);
  const describedBy = message ? `${id}-error` : (hint ? `${id}-hint` : null);
  return html`<div class="form-field">
    <label for="${id}">${label}</label>
    <input id="${id}" name="${id}" type="${type}" value="${value ?? ''}"
           ${required ? raw('required') : ''}
           ${attr('aria-invalid', message ? 'true' : null)}
           ${attr('aria-describedby', describedBy)}>
    ${hint ? html`<p class="hint" id="${id}-hint">${hint}</p>` : ''}
    ${message ? html`<div id="${id}-error"${attr('aria-live', 'polite')}>${fieldError({ [id]: message }, id)}</div>` : ''}
  </div>`;
}

function errorMessageFor(errors, field) {
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) return null;
  const message = errors[field];
  return typeof message === 'string' && message.length > 0 ? message : null;
}

/* ------------------------------------------------------------ profile page */

export function customerProfileView({
  actor, csrfToken, flash = null, customer, history = [], upcoming = [], frequentSpaces = [],
}) {
  const monogram = customerMonogram(customer.fullName);

  const kpiStrip = html`<div class="stat-grid stat-grid--primary">
    <div class="stat">
      <span class="stat__value">${money(customer.stats.bookedValueCents, CURRENCY)}</span>
      <span class="stat__label">Lifetime booked value</span>
      <span class="hint">Excludes cancelled reservations</span>
    </div>
    <div class="stat">
      <span class="stat__value">${customer.stats.confirmedReservations}</span>
      <span class="stat__label">Confirmed bookings</span>
      <span class="hint">Of ${customer.stats.totalReservations} total recorded</span>
    </div>
    <div class="stat">
      <span class="stat__value">${upcoming.length}</span>
      <span class="stat__label">Upcoming confirmed</span>
      <span class="hint">Active future reservations</span>
    </div>
    <div class="stat">
      <span class="stat__value">${customer.stats.cancelledReservations}</span>
      <span class="stat__label">Cancelled</span>
      <span class="hint">Last booked: ${friendlyDate(customer.stats.lastBookingAt)}</span>
    </div>
  </div>`;

  const body = pageContainer({
    body: html`<div class="stack">
      ${kpiStrip}

      <div class="split-layout">
        <div class="stack">
          ${card({
            title: 'Customer identity & contact details',
            description: PRIVACY_NOTE,
            actions: html`<a class="button button--ghost button--small" href="/admin/customers/${customer.id}/edit">Edit</a>`,
            body: html`<div class="stack">
              <div class="cluster">
                <span class="brand__mark" aria-hidden="true">${monogram}</span>
                <div>
                  <h3 class="card__title">${customer.fullName}</h3>
                  <p class="meta-line">${customer.organization || 'Independent / no organisation listed'}</p>
                </div>
              </div>
              <dl class="detail-list">
                <dt>Full name</dt><dd>${customer.fullName}</dd>
                <dt>Email</dt><dd><a href="mailto:${customer.email}">${customer.email}</a></dd>
                <dt>Telephone</dt><dd>${customer.phone || '—'}</dd>
                <dt>Organisation</dt><dd>${customer.organization || '—'}</dd>
                <dt>Created</dt><dd>${friendlyDate(customer.createdAt)}</dd>
                <dt>Last updated</dt><dd>${friendlyDate(customer.updatedAt)}</dd>
              </dl>
              <div class="cluster">
                <a class="button button--primary button--small" href="/admin/reservations/new?customer=${customer.id}">Create reservation for this customer</a>
                <a class="button button--ghost button--small" href="/admin/customers/${customer.id}/edit">Edit profile</a>
              </div>
            </div>`,
          })}

          ${card({
            title: 'Private notes — staff only',
            description: 'Never shown to the customer, to other customers, or on the public site.',
            actions: html`<a class="button button--ghost button--small" href="/admin/customers/${customer.id}/edit#notes">Update notes</a>`,
            body: customer.notes
              ? html`<blockquote><p>${customer.notes}</p></blockquote>`
              : html`<p class="hint">No notes recorded for this customer.</p>`,
          })}

          ${card({
            title: 'Lifetime activity',
            description: 'Totals across every reservation recorded for this customer, including cancelled ones.',
            body: html`<div class="stack">
              <dl class="detail-list">
                <dt>Total reservations</dt><dd>${customer.stats.totalReservations}</dd>
                <dt>Confirmed</dt><dd>${customer.stats.confirmedReservations}</dd>
                <dt>Cancelled</dt><dd>${customer.stats.cancelledReservations}</dd>
                <dt>Last booking</dt><dd>${friendlyDate(customer.stats.lastBookingAt)}</dd>
                <dt>Lifetime booked value</dt><dd><span class="price">${money(customer.stats.bookedValueCents, CURRENCY)}</span></dd>
              </dl>
              <p class="hint">Lifetime value excludes cancelled reservations.</p>
            </div>`,
          })}

          ${card({
            title: 'Frequent spaces',
            description: 'The spaces this customer books most, for quick re-booking.',
            body: table({
              columns: [
                { label: 'Space' },
                { label: 'Category' },
                { label: 'Reservations', align: 'right' },
              ],
              rows: frequentSpaces.map((space) => ({
                cells: [
                  html`<a href="/admin/spaces/${space.id}">${space.name}</a> <code>${space.code}</code>`,
                  categoryLabel(space.category),
                  String(space.bookings),
                ],
              })),
              emptyMessage: 'No space has been booked for this customer yet.',
            }),
          })}
        </div>

        <div class="stack">
          ${card({
            title: 'Upcoming reservations',
            description: 'Confirmed reservations whose end time has not passed.',
            actions: html`<a class="button button--primary button--small" href="/admin/reservations/new?customer=${customer.id}">New booking</a>`,
            body: table({
              columns: [
                { label: 'Reference' },
                { label: 'Space' },
                { label: 'Period' },
                { label: 'Status' },
                { label: 'Actions' },
              ],
              rows: upcoming.map((entry) => ({
                cells: [
                  html`<a href="/admin/reservations/${entry.id}">${entry.reference}</a>`,
                  html`${entry.spaceName} <code>${entry.spaceCode}</code>`,
                  periodLabel(entry.startAt, entry.endAt),
                  statusBadge(entry.status),
                  html`<a class="button button--ghost button--small" href="/admin/reservations/${entry.id}">Open booking</a>`,
                ],
              })),
              emptyMessage: 'No upcoming confirmed reservations for this customer.',
            }),
          })}

          ${card({
            title: 'Booking history',
            description: 'Newest first. Cancelled reservations stay in the history with their cancellation reason.',
            body: table({
              columns: [
                { label: 'Reference' },
                { label: 'Space' },
                { label: 'Period' },
                { label: 'Duration' },
                { label: 'Status' },
                { label: 'Total', align: 'right' },
                { label: 'Cancellation' },
              ],
              rows: history.map((entry) => ({
                cells: [
                  html`<a href="/admin/reservations/${entry.id}">${entry.reference}</a>`,
                  html`${entry.spaceName} <code>${entry.spaceCode}</code>`,
                  periodLabel(entry.startAt, entry.endAt),
                  durationLabel(entry.startAt, entry.endAt),
                  statusBadge(entry.status),
                  money(entry.totalCents, entry.currency || CURRENCY),
                  entry.status === 'CANCELLED'
                    ? html`<span>${entry.cancellationReason || 'No reason recorded.'}</span>
                        ${entry.cancelledAt ? html`<span class="hint">Cancelled ${dateTimeLabel(entry.cancelledAt)}</span>` : ''}`
                    : '—',
                ],
              })),
              emptyMessage: html`${emptyState(
                'This customer has no reservations yet.',
                'Create one from the button above, or wait for the first booking.',
              )}`,
            }),
          })}
        </div>
      </div>
    </div>`,
  });

  return adminShell({
    title: customer.fullName,
    subtitle: 'Customer profile · private staff record',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/customers',
    breadcrumbs: [
      { label: 'Admin', href: '/admin' },
      { label: 'Customers', href: '/admin/customers' },
      { label: customer.fullName },
    ],
    pageActions: html`
      <a class="button button--ghost button--small" href="/admin/customers">Back to directory</a>
      <a class="button button--ghost button--small" href="/admin/customers/${customer.id}/edit">Edit customer</a>
      <a class="button button--primary button--small" href="/admin/reservations/new?customer=${customer.id}">Create reservation for this customer</a>`,
    body,
  });
}

export const renderCustomerDirectoryPage = customerDirectoryView;
export const renderCustomerFormPage = customerFormView;
export const renderCustomerProfilePage = customerProfileView;

