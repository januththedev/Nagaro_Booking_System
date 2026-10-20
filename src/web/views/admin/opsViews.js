/**
 * Admin operations views: the dashboard, the inquiry queue, inquiry detail,
 * the maintenance list and the activity log.
 *
 * Rules that live in this file (and only here):
 *   - every timestamp is rendered through the Sri Lanka Standard Time helpers in
 *     `lib/html.js` and wrapped in `<time datetime="...">`; the server's own
 *     locale is never consulted;
 *   - every number shown comes from the props the route handler passes in,
 *     and the route handler gets every number from a service call. Nothing is
 *     hard-coded, estimated or invented in the view layer;
 *   - notification delivery is never softened: an inquiry whose email was not
 *     delivered says so in words, in the stat row, in the queue and on the
 *     detail page.
 *
 * Class names come from `src/web/public/styles.css` and are only ever used,
 * never invented.
 */
import {
  html, RawHtml, statusBadge, tag, periodLabel, relativeDayLabel, emptyState, pagination,
  availabilityPill, categoryLabel, dateLabel, timeLabel, businessDateKey,
  businessTimeLabel, businessDateTimeLabel,
} from '../../lib/html.js';
import { adminShell, card, table } from '../layout.js';
import {
  INQUIRY_EMAIL_STATUS_LABEL, INQUIRY_STATUS, INQUIRY_STATUS_LABEL,
} from '../../../server/domain/constants.js';

/* ------------------------------------------------------------- primitives */

/** `<time datetime="…">` for an instant. `datetime` is ISO-8601 UTC, the
 *  visible text is the Sri Lanka Standard Time label. */
export function timeTag(epochMs, label = null) {
  // Coerced defensively: PostgreSQL drivers may hand back int8 timestamps as
  // strings, and an unparseable value must render as a dash rather than throw
  // while a page is being assembled.
  const ms = Number(epochMs);
  if (!Number.isFinite(ms) || ms === 0) return html`—`;
  const text = label ?? businessDateTimeLabel(ms);
  return html`<time datetime="${new Date(ms).toISOString()}">${text}</time>`;
}

/** Dead-obvious helper so a quantity of records reads correctly. */
function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

function statCard({ label, value, caption, tone = null, actionHref = null, actionLabel = null }) {
  return html`<div class="kpi stat ${tone ? `kpi--${tone} stat--${tone}` : ''}">
    <span class="kpi__value stat__value">${value}</span>
    <span class="kpi__label stat__label">${label}</span>
    ${caption ? html`<span class="kpi__hint hint">${caption}</span>` : ''}
    ${actionHref && actionLabel ? html`<a class="kpi__link stat__action" href="${actionHref}">${actionLabel} →</a>` : ''}
  </div>`;
}

function statGrid(items, modifier = '') {
  return html`<div class="kpi-grid stat-grid ${modifier}">${items.map((item) => item instanceof RawHtml ? item : statCard(item))}</div>`;
}

/** Visual occupancy progress bar (0–100%). Width comes from a 5%-bucket
 *  class so the markup carries no inline style and the page needs no
 *  `style-src 'unsafe-inline'`. The exact figure stays in aria-valuenow. */
function occupancyMeter(percentage, label = null) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(percentage) || 0)));
  const tone = pct >= 90 ? 'meter--danger' : pct >= 65 ? 'meter--warning' : 'meter--ok';
  const bucket = Math.round(pct / 5) * 5;
  return html`<div class="meter ${tone}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${label ?? `${pct}% occupied`}">
    <span class="meter__fill meter__fill--${bucket}"></span>
  </div>`;
}

/** Delivery badge. `title` carries the failure reason so the queue is usable
 *  without opening every record; the detail page states it in full. */
export function deliveryBadge(inquiry) {
  const status = inquiry.emailStatus;
  let title;
  if (status === 'SENT') {
    title = inquiry.emailAttemptedAt
      ? `Notification email delivered ${businessDateTimeLabel(inquiry.emailAttemptedAt)} (Sri Lanka Standard Time).`
      : 'Notification email delivered.';
  } else if (status === 'NOT_CONFIGURED') {
    title = inquiry.emailError
      ?? 'Email is not configured on this server, so no notification email was sent.';
  } else if (status === 'FAILED') {
    title = inquiry.emailError ?? 'The notification email could not be delivered.';
  } else {
    title = inquiry.emailError
      ?? 'Delivery has not been recorded yet. Treat this request as not notified.';
  }
  return html`<span title="${title}">${statusBadge(status)}</span>`;
}

/** The exact honesty wording used wherever an email was not delivered. */
export const NOT_DELIVERED_WARNING =
  'No notification email reached the office for this request. It was saved in the '
  + 'queue below, but nobody was emailed: delivery failed or email is not configured '
  + 'on this server. These requests must be checked manually here — do not assume '
  + 'anyone has been notified.';

function undeliveredBanner(count, listed) {
  return html`<div class="alert alert--error" role="alert" data-notification-undelivered>
    <p><strong>Notification email NOT delivered — ${count}
      request${Number(count) === 1 ? '' : 's'} in this queue.</strong></p>
    <p>${NOT_DELIVERED_WARNING}</p>
    ${listed.length
    ? html`<ul>${listed.map((inquiry) => html`<li>
        <a href="/admin/inquiries/${inquiry.id}">${inquiry.reference}</a>
        — ${inquiry.customerName} (${inquiry.email})
        ${inquiry.spaceName ? html` for ${inquiry.spaceName}` : ''}
        — ${inquiry.emailError ? html`reason: ${inquiry.emailError}` : INQUIRY_EMAIL_STATUS_LABEL[inquiry.emailStatus]}
      </li>`)}</ul>`
    : ''}
  </div>`;
}

/** Reservation columns shared by "today" and "upcoming". */
function reservationTable(reservations, emptyMessage) {
  return table({
    columns: [
      { label: 'Reference' },
      { label: 'Space' },
      { label: 'Customer' },
      { label: 'Period' },
      { label: 'Desks / attendees' },
      { label: 'Status' },
    ],
    rows: reservations.map((reservation) => ({
      cells: [
        html`<a class="rowlink" href="/admin/reservations/${reservation.id}">${reservation.reference}</a>`,
        html`<span>${reservation.spaceName}</span>
          <span class="meta-line">${reservation.spaceCode} · ${categoryLabel(reservation.category)}</span>`,
        html`<span>${reservation.customerName}</span>`,
        html`<span>${periodLabel(reservation.startAt, reservation.endAt)}</span>
          <span class="meta-line"><time datetime="${new Date(reservation.startAt).toISOString()}">${timeLabel(reservation.startAt)}–${timeLabel(reservation.endAt)}</time></span>`,
        html`<span>${reservation.unitCount}</span>
          <span class="meta-line">${reservation.attendees === null || reservation.attendees === undefined
    ? 'attendees not recorded' : `${reservation.attendees} attendees`}</span>`,
        statusBadge(reservation.status),
      ],
    })),
    emptyMessage,
  });
}

/* -------------------------------------------------------------- dashboard */

export function renderDashboardPage({
  actor, csrfToken, flash = null,
  summary, today, cancelledToday, upcoming, availability, utilisation,
  attention, undelivered, reservationChanges, recentChanges,
}) {
  const businessDate = summary.businessDate;
  const currentRate = summary.occupancy.currentRate;
  const peakRate = summary.occupancy.todayPeakRate;
  const occupied = summary.availableNow.occupied;
  const totalUnits = summary.availableNow.total;

  /* Tier 1: Primary Executive KPIs (4 most actionable daily operational signals) */
  const primaryMetrics = [
    statCard({
      label: "Today's bookings",
      value: summary.today.bookings,
      caption: `Business day ${businessDate} (SLST) · cancelled excluded`,
      actionHref: `/admin/calendar?date=${businessDate}`,
      actionLabel: 'Open day schedule',
    }),
    statCard({
      label: 'Spaces free right now',
      value: `${availability.freeSpaces} of ${availability.totalSpaces}`,
      caption: 'No booked unit in the 60 minutes after page load',
      actionHref: '/admin/spaces',
      actionLabel: 'Manage spaces',
    }),
    statCard({
      label: 'New inquiries',
      value: summary.inquiries.new,
      caption: 'All time · every request with status NEW',
      tone: summary.inquiries.new > 0 ? 'warning' : null,
      actionHref: '/admin/inquiries?status=NEW',
      actionLabel: 'Review new requests',
    }),
    statCard({
      label: 'Notifications not delivered',
      value: summary.inquiries.awaitingEmailDelivery,
      caption: 'All time · delivery failed or email not configured, not closed or withdrawn',
      tone: summary.inquiries.awaitingEmailDelivery > 0 ? 'danger' : null,
      actionHref: '/admin/inquiries',
      actionLabel: 'Inspect delivery queue',
    }),
  ];

  /* Tier 2: Secondary Operational Context Strip (6 supporting capacity & horizon metrics) */
  const secondaryMetrics = [
    statCard({
      label: 'Active spaces',
      value: summary.activeSpaces.total,
      caption: `Right now · ${summary.activeSpaces.published} published, `
        + `${summary.activeSpaces.draft} draft, ${summary.activeSpaces.archived} archived`,
    }),
    statCard({
      label: 'Bookable units free',
      value: `${summary.availableNow.free} of ${totalUnits}`,
      caption: 'Next 60 minutes from page load',
    }),
    statCard({
      label: "Today's attendees",
      value: summary.today.attendees,
      caption: `Business day ${businessDate} (SLST) · cancelled excluded`,
    }),
    statCard({
      label: 'Bookings in the next 7 days',
      value: summary.upcoming.next7Days,
      caption: 'Confirmed, starting within 7 days of page load',
    }),
    statCard({
      label: 'Bookings in the next 30 days',
      value: summary.upcoming.next30Days,
      caption: 'Confirmed, starting within 30 days of page load',
    }),
    statCard({
      label: 'Active maintenance blocks',
      value: summary.maintenance.activeNow,
      caption: `In progress at page load · ${summary.maintenance.upcoming} starting later`,
      tone: summary.maintenance.activeNow > 0 ? 'warning' : null,
    }),
  ];

  return adminShell({
    title: 'Dashboard',
    subtitle: `Live operations view for business day ${businessDate} (Sri Lanka Standard Time).`,
    actor,
    csrfToken,
    flash,
    activePath: '/admin',
    pageActions: html`
      <a class="button button--ghost button--small" href="/admin/calendar?date=${businessDate}">Today's calendar</a>
      <a class="button button--primary button--small" href="/admin/reservations/new">New reservation</a>`,
    body: html`<div class="stack" data-dashboard="admin" data-summary-url="/api/admin/dashboard/summary" data-reveal>

      ${statGrid(primaryMetrics, 'stat-grid--primary')}
      ${statGrid(secondaryMetrics, 'stat-grid--secondary')}

      <p class="hint">All figures are read live from the booking database. Generated
        ${timeTag(summary.generatedAt)} (Sri Lanka Standard Time).</p>

      ${card({
    title: 'Available now',
    description: 'Per-space bookable units blocked by a reservation or a maintenance block in the next 60 minutes.',
    actions: html`<a class="button button--ghost button--small" href="/admin/calendar?date=${businessDate}">Full day timeline</a>`,
    body: table({
      columns: [
        { label: 'Space' },
        { label: 'Units free' },
        { label: 'Units occupied' },
        { label: 'Occupancy load' },
        { label: 'Availability' },
        { label: 'Calendar' },
      ],
      rows: availability.spaces.map((space) => {
        const occupiedPct = space.totalUnits > 0
          ? Math.round((space.occupiedUnits / space.totalUnits) * 100)
          : 0;
        return {
          cells: [
            html`<a href="/admin/spaces/${space.spaceId}">${space.name}</a>
                  <span class="meta-line">${space.code} · ${categoryLabel(space.category)}</span>`,
            html`${space.freeUnits} of ${space.totalUnits}`,
            html`${space.occupiedUnits} of ${space.totalUnits}`,
            html`<div class="stack">
                  <span class="meta-line">${occupiedPct}% occupied</span>
                  ${occupancyMeter(occupiedPct, `${space.name}: ${occupiedPct}% occupied`)}
                </div>`,
            availabilityPill(
              space.freeUnits > 0,
              space.occupiedUnits === 0
                ? 'Free'
                : `${space.freeUnits} of ${space.totalUnits} free`,
            ),
            html`<a class="button button--ghost button--small" href="/admin/calendar?space=${space.spaceId}&amp;date=${businessDate}">Day view</a>`,
          ],
        };
      }),
      emptyMessage: 'No bookable spaces yet. Create a space and publish it to take bookings.',
    }),
  })}

      <div data-today-confirmed data-reveal>
        ${card({
    title: "Today's confirmed bookings",
    description: `Business day ${businessDate}. Cancelled bookings are listed separately below.`,
    actions: html`<a class="button button--ghost button--small" href="/admin/reservations?from=${businessDate}&amp;to=${businessDate}">All today's records</a>`,
    body: reservationTable(today, 'No confirmed bookings touch today yet.'),
  })}
      </div>

      <div data-today-cancelled data-reveal>
        ${cancelledToday.length
    ? card({
      title: 'Cancelled today',
      description: 'Kept visible so it is clear why a slot is free again. Cancelled bookings hold no inventory.',
      body: reservationTable(cancelledToday, 'No cancelled bookings today.'),
    })
    : ''}
      </div>

      ${card({
    title: 'Upcoming (next 30 days)',
    description: `Confirmed bookings starting in the next 30 days. Showing ${upcoming.shown} of ${upcoming.total}.`,
    actions: html`<a class="button button--ghost button--small" href="/admin/reservations">View all reservations</a>`,
    body: upcoming.groups.length
      ? html`<div class="stack">
          ${upcoming.groups.map((group) => html`<div>
            <h3 class="card__title">${relativeDayLabel(group.startAt)}</h3>
            ${reservationTable(group.items, 'Nothing booked.')}
          </div>`)}
        </div>`
      : emptyState('No confirmed bookings in the next 30 days.',
        'Create a reservation to fill the calendar.'),
  })}

      ${card({
    title: 'Current and upcoming occupancy',
    description: 'Occupancy is measured on bookable resource units, not on spaces.',
    body: html`<div class="stack">
      <div class="cluster">
        <p class="stat__value">${currentRate === null ? '—' : `${Math.round(currentRate * 1000) / 10}%`}</p>
        <div>
          <p>${totalUnits > 0
    ? `${occupied} of ${totalUnits} bookable units ${occupied === 1 ? 'is' : 'are'} occupied right now (the 60 minutes after page load).`
    : 'No bookable units are configured yet, so there is nothing to measure.'}</p>
          <p class="hint">Today's peak hourly occupancy: ${peakRate === null
    ? 'not measurable — no space has opening hours configured for today.'
    : `${Math.round(peakRate * 1000) / 10}%`} (business day ${businessDate}, per hourly open-hours bucket).</p>
        </div>
      </div>
      ${currentRate !== null ? occupancyMeter(currentRate * 100, 'Current overall unit occupancy') : ''}
      ${utilisation.length
    ? html`<div class="stack">
      <h3 class="card__title">Booked unit-hours, today to 30 days ahead</h3>
      ${table({
      columns: [
        { label: 'Space' },
        { label: 'Booked unit-hours', align: 'right' },
        { label: 'Bookable unit-hours', align: 'right' },
        { label: 'Utilisation', align: 'right' },
      ],
      rows: utilisation.map((row) => {
        const pct = row.utilisationRate === null ? null : Math.round(row.utilisationRate * 1000) / 10;
        return {
          cells: [
            html`<a href="/admin/spaces/${row.spaceId}">${row.name}</a>`,
            html`${row.bookedUnitHours}`,
            html`${row.bookableUnitHours}`,
            html`<div class="stack">
              <span>${pct === null ? '—' : `${pct}%`}</span>
              ${pct !== null ? occupancyMeter(pct, `${row.name}: ${pct}% utilisation`) : ''}
            </div>`,
          ],
        };
      }),
      emptyMessage: 'No spaces to measure.',
    })}
      <p class="hint">Booked unit-hours divide bookable unit-hours (units × the hours the space is
        actually open inside the window). Maintenance blocks count as occupied time.</p>
    </div>`
    : ''}
    </div>`,
  })}

      ${card({
    title: 'Inquiries needing attention',
    description: 'Every NEW or CONTACTED request. Nothing in this queue has reserved a space — conversion is manual.',
    actions: html`<a class="button button--ghost button--small" href="/admin/inquiries">Open inquiry queue</a>`,
    body: html`<div class="stack">
      ${(undelivered.count > 0) ? undeliveredBanner(undelivered.count, undelivered.items) : ''}
      ${attention.length
    ? table({
      columns: [
        { label: 'Reference' },
        { label: 'Requested space' },
        { label: 'Requested window' },
        { label: 'Contact' },
        { label: 'Attendees / desks' },
        { label: 'Requested' },
        { label: 'Status' },
        { label: 'Notification' },
      ],
      rows: attention.map((inquiry) => ({
        cells: [
          html`<a class="rowlink" href="/admin/inquiries/${inquiry.id}">${inquiry.reference}</a>`,
          inquiry.spaceName
            ? html`<span>${inquiry.spaceName}</span><span class="meta-line">${inquiry.spaceCode}</span>`
            : html`<span>Space removed</span>`,
          html`${periodLabel(inquiry.startAt, inquiry.endAt)}`,
          html`<span>${inquiry.customerName}</span>
                <span class="meta-line">${inquiry.email}</span>
                ${inquiry.phone ? html`<span class="meta-line">${inquiry.phone}</span>` : ''}`,
          html`${inquiry.attendees === null ? '—' : inquiry.attendees}
                ${inquiry.deskQuantity ? html`<span class="meta-line">${inquiry.deskQuantity} desks</span>` : ''}`,
          timeTag(inquiry.createdAt),
          statusBadge(inquiry.status),
          deliveryBadge(inquiry),
        ],
      })),
      emptyMessage: 'No open inquiries match.',
    })
    : emptyState('No NEW or CONTACTED inquiries.',
      'Requests submitted through the public request-to-book form land here automatically.')}
    </div>`,
  })}

      <div class="split-layout">
        ${card({
    title: 'Recent reservation changes',
    description: 'Written to the append-only activity log inside the same transaction as the change.',
    actions: html`<a class="button button--ghost button--small" href="/admin/audit?entityType=reservation">View all</a>`,
    body: auditList(reservationChanges, 'No reservation changes recorded yet.'),
  })}

        ${card({
    title: 'Other recent activity',
    description: 'The most recent activity-log entries across every record type.',
    actions: html`<a class="button button--ghost button--small" href="/admin/audit">Full audit log</a>`,
    body: auditList(recentChanges, 'No activity recorded yet.'),
  })}
      </div>

      ${card({
    title: 'Quick actions',
    body: html`<div class="cluster">
      <a class="button button--primary" href="/admin/reservations/new">New reservation</a>
      <a class="button button--ghost" href="/admin/spaces/new">New space</a>
      <a class="button button--ghost" href="/admin/customers/new">New customer</a>
      <a class="button button--ghost" href="/admin/calendar">Calendar</a>
      <a class="button button--ghost" href="/admin/inquiries">Inquiry queue</a>
      <a class="button button--ghost" href="/admin/maintenance">Maintenance blocks</a>
    </div>`,
  })}
    </div>`,
  });
}

/** Shared activity-list renderer for the dashboard and the activity log. */
function auditList(entries, emptyMessage) {
  if (!entries || entries.length === 0) return emptyState(emptyMessage);
  return html`<ol class="stack">
    ${entries.map((entry) => html`<li>
      ${timeTag(entry.at)} — ${entry.actorLabel} — ${tag(entry.action)}
      ${auditEntity(entry)}
      <span class="meta-line">${entry.summary}</span>
    </li>`)}
  </ol>`;
}

const ENTITY_PATHS = {
  reservation: '/admin/reservations/',
  space: '/admin/spaces/',
  customer: '/admin/customers/',
  inquiry: '/admin/inquiries/',
};

function auditEntity(entry) {
  const base = ENTITY_PATHS[entry.entityType];
  if (!entry.entityId) return html`<span class="meta-line">${entry.entityType}</span>`;
  if (!base) return html`<span class="meta-line">${entry.entityType} #${entry.entityId}</span>`;
  return html`<a class="rowlink" href="${base}${encodeURIComponent(entry.entityId)}">${entry.entityType} #${entry.entityId}</a>`;
}

/* ---------------------------------------------------------- inquiry queue */

export function renderInquiryListPage({
  actor, csrfToken, flash = null, inquiries, stats, filters, spaces, page, pageSize,
  total, filteredWithinWindow = false,
}) {
  const extraQuery = { ...filters.query };
  const statusOptions = Object.values(INQUIRY_STATUS);

  const primaryInquiryStats = [
    statCard({
      label: 'New',
      value: stats.new,
      caption: 'All time · waiting for first contact',
      tone: stats.new > 0 ? 'warning' : null,
      actionHref: '/admin/inquiries?status=NEW',
      actionLabel: 'Filter new',
    }),
    statCard({
      label: 'Contacted',
      value: stats.contacted,
      caption: 'All time · in conversation',
      actionHref: '/admin/inquiries?status=CONTACTED',
      actionLabel: 'Filter contacted',
    }),
    statCard({
      label: 'Notifications not delivered',
      value: stats.emailNotDelivered,
      caption: 'All time · FAILED or email not configured',
      tone: stats.emailNotDelivered > 0 ? 'danger' : null,
    }),
    statCard({
      label: 'Converted',
      value: stats.converted,
      caption: 'All time · linked to a reservation',
      actionHref: '/admin/inquiries?status=CONVERTED',
      actionLabel: 'View converted',
    }),
  ];

  const secondaryInquiryStats = [
    statCard({ label: 'Closed', value: stats.closed, caption: 'All time · no booking made' }),
    statCard({ label: 'Withdrawn', value: stats.withdrawn, caption: 'All time · withdrawn by the visitor' }),
    statCard({ label: 'Total requests', value: stats.total, caption: 'All time' }),
  ];

  return adminShell({
    title: 'Inquiries',
    subtitle: 'Requests submitted through the public request-to-book form. '
      + 'An inquiry never reserves inventory; staff convert it into a reservation manually.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/inquiries',
    breadcrumbs: [
      { label: 'Admin', href: '/admin' },
      { label: 'Inquiries' },
    ],
    pageActions: html`<a class="button button--primary button--small" href="/admin/reservations/new">New reservation</a>`,
    body: html`<div class="stack">

      ${statGrid(primaryInquiryStats, 'stat-grid--primary')}
      ${statGrid(secondaryInquiryStats, 'stat-grid--secondary')}

      <nav class="quick-tabs cluster" aria-label="Quick inquiry filters">
        <a class="button ${!filters.status ? 'button--primary' : 'button--ghost'} button--small" href="/admin/inquiries">All open</a>
        <a class="button ${filters.status === 'NEW' ? 'button--primary' : 'button--ghost'} button--small" href="/admin/inquiries?status=NEW">New</a>
        <a class="button ${filters.status === 'CONTACTED' ? 'button--primary' : 'button--ghost'} button--small" href="/admin/inquiries?status=CONTACTED">Contacted</a>
        <a class="button ${filters.status === 'CONVERTED' ? 'button--primary' : 'button--ghost'} button--small" href="/admin/inquiries?status=CONVERTED">Converted</a>
        <a class="button ${filters.status === 'CLOSED' ? 'button--primary' : 'button--ghost'} button--small" href="/admin/inquiries?status=CLOSED">Closed</a>
      </nav>

      ${stats.emailNotDelivered > 0
    ? html`<div class="alert alert--error" role="alert" data-notification-undelivered>
        <p><strong>Notification email NOT delivered — ${stats.emailNotDelivered}
          request${stats.emailNotDelivered === 1 ? '' : 's'} could not be notified by email.</strong></p>
        <p>${NOT_DELIVERED_WARNING}</p>
      </div>`
    : ''}

      ${card({
    title: 'Filter the queue',
    description: 'Search by visitor name, email, or reference, and narrow by lifecycle status, space, or email delivery outcome.',
    body: html`<form class="filters-bar filter-bar" method="get" action="/admin/inquiries">
        <div class="filter-bar__field">
          <label for="filter-q">Name, email or reference</label>
          <input id="filter-q" name="q" type="search" value="${filters.q ?? ''}" maxlength="160">
        </div>
        <div class="filter-bar__field">
          <label for="filter-status">Status</label>
          <select id="filter-status" name="status">
            <option value="">Any status</option>
            ${statusOptions.map((value) => html`<option value="${value}"
              ${filters.status === value ? 'selected' : ''}>${INQUIRY_STATUS_LABEL[value]}</option>`)}
          </select>
        </div>
        <div class="filter-bar__field">
          <label for="filter-space">Requested space</label>
          <select id="filter-space" name="space">
            <option value="">Any space</option>
            ${spaces.map((space) => html`<option value="${space.id}"
              ${String(filters.space ?? '') === String(space.id) ? 'selected' : ''}>
              ${space.name}${space.status === 'ARCHIVED' ? ' (archived)' : ''}
            </option>`)}
          </select>
        </div>
        <div class="filter-bar__field">
          <label for="filter-email-status">Notification delivery</label>
          <select id="filter-email-status" name="emailStatus">
            <option value="">Any delivery state</option>
            ${Object.entries(INQUIRY_EMAIL_STATUS_LABEL).map(([value, label]) => html`<option value="${value}"
              ${filters.emailStatus === value ? 'selected' : ''}>${label}</option>`)}
          </select>
        </div>
        <div class="filter-bar__field">
          <label for="filter-from">Requested from</label>
          <input id="filter-from" name="from" type="date" value="${filters.from ?? ''}">
        </div>
        <div class="filter-bar__field">
          <label for="filter-to">Requested to</label>
          <input id="filter-to" name="to" type="date" value="${filters.to ?? ''}">
        </div>
        <div class="filter-bar__actions">
          <button class="button button--primary button--small" type="submit">Apply filters</button>
          <a class="button button--ghost button--small" href="/admin/inquiries">Clear</a>
        </div>
      </form>
      ${filteredWithinWindow
    ? html`<p class="hint">The delivery filter is applied to the newest 200 requests that match the
        other filters, because the queue service filters delivery state in JS rather than in SQL.
        Total shown counts requests inside that window.</p>`
    : ''}`,
  })}

      ${card({
    title: 'Requests',
    description: `${total} request${total === 1 ? '' : 's'} match. Page ${page} of
      ${Math.max(1, Math.ceil(total / pageSize))}.`,
    body: html`<div class="stack">
      ${table({
      columns: [
        { label: 'Reference' },
        { label: 'Requested space' },
        { label: 'Requested window' },
        { label: 'Visitor' },
        { label: 'Attendees / desks' },
        { label: 'Requested at' },
        { label: 'Status' },
        { label: 'Notification' },
      ],
      rows: inquiries.map((inquiry) => ({
        cells: [
          html`<a class="rowlink" href="/admin/inquiries/${inquiry.id}">${inquiry.reference}</a>`,
          inquiry.spaceName
            ? html`<span>${inquiry.spaceName}</span><span class="meta-line">${inquiry.spaceCode}</span>`
            : html`<span>Space removed</span>`,
          html`${periodLabel(inquiry.startAt, inquiry.endAt)}
                ${inquiry.message ? html`<span class="meta-line">${inquiry.message.length > 80
      ? `${inquiry.message.slice(0, 80)}…` : inquiry.message}</span>` : ''}`,
          html`<span>${inquiry.customerName}</span>
                <span class="meta-line">${inquiry.email}</span>
                ${inquiry.phone ? html`<span class="meta-line">${inquiry.phone}</span>` : ''}`,
          html`${inquiry.attendees === null ? '—' : inquiry.attendees}
                ${inquiry.deskQuantity ? html`<span class="meta-line">${inquiry.deskQuantity} desks</span>` : ''}`,
          timeTag(inquiry.createdAt),
          statusBadge(inquiry.status),
          deliveryBadge(inquiry),
        ],
      })),
      emptyMessage: 'No inquiries match these filters.',
    })}
      ${inquiries.length === 0
    ? emptyState('No requests to show.',
      'This queue is fed by the public request-to-book form. Every submission is stored here, even when the notification email could not be delivered.')
    : ''}
      ${pagination({
      page, pageSize, total, basePath: '/admin/inquiries', extraQuery,
    })}
    </div>`,
  })}
    </div>`,
  });
}

export const renderInquiryQueuePage = renderInquiryListPage;

/* --------------------------------------------------------- inquiry detail */

function convertUrl(inquiry) {
  const params = new URLSearchParams();
  if (inquiry.spaceId) params.set('space', String(inquiry.spaceId));
  params.set('date', businessDateKey(inquiry.startAt));
  params.set('start', businessTimeLabel(inquiry.startAt));
  params.set('end', businessTimeLabel(inquiry.endAt));
  if (inquiry.deskQuantity) params.set('desks', String(inquiry.deskQuantity));
  if (inquiry.customerName) params.set('customer_name', inquiry.customerName);
  if (inquiry.email) params.set('customer_email', inquiry.email);
  params.set('inquiry', String(inquiry.id));
  return `/admin/reservations/new?${params.toString()}`;
}

export function renderInquiryDetailPage({
  actor, csrfToken, flash = null, inquiry, availability, timeline, statuses,
}) {
  const multiDay = businessDateKey(inquiry.startAt) !== businessDateKey(inquiry.endAt - 1);
  const delivered = inquiry.emailStatus === 'SENT';
  const occupiedUnits = availability
    ? Math.max(0, Number(availability.totalUnits || 0) - Number(availability.freeUnits || 0))
    : 0;
  const occupiedPct = availability && availability.totalUnits > 0
    ? Math.round((occupiedUnits / availability.totalUnits) * 100)
    : 0;

  return adminShell({
    title: `Inquiry ${inquiry.reference}`,
    subtitle: 'A request, not a booking. This record reserves no inventory until staff create a reservation.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/inquiries',
    breadcrumbs: [
      { label: 'Admin', href: '/admin' },
      { label: 'Inquiries', href: '/admin/inquiries' },
      { label: inquiry.reference },
    ],
    pageActions: html`
      <a class="button button--ghost button--small" href="/admin/inquiries">Back to queue</a>
      ${inquiry.spaceId
    ? html`<a class="button button--primary button--small" href="${convertUrl(inquiry)}">Create reservation from this inquiry</a>`
    : ''}`,
    body: html`<div class="stack">

      ${!delivered
    ? html`<div class="alert alert--error" role="alert" data-notification-undelivered>
        <p><strong>Notification email NOT delivered (${INQUIRY_EMAIL_STATUS_LABEL[inquiry.emailStatus]}).</strong></p>
        <p>${NOT_DELIVERED_WARNING}</p>
        ${inquiry.emailError ? html`<p>Server reported: <code>${inquiry.emailError}</code></p>` : ''}
      </div>`
    : html`<div class="alert alert--success" role="status">
        <p>Notification email delivered${inquiry.emailAttemptedAt
    ? html` ${timeTag(inquiry.emailAttemptedAt)}` : ''}.</p>
      </div>`}

      <div class="split-layout">
        <div class="stack">
          ${card({
    title: 'Visitor request & message',
    description: 'Submitted through the public booking request form.',
    actions: statusBadge(inquiry.status),
    body: html`<div class="stack">
      <dl class="detail-list">
        <dt>Reference</dt><dd><code>${inquiry.reference}</code></dd>
        <dt>Received</dt><dd>${timeTag(inquiry.createdAt)}</dd>
        <dt>Status</dt><dd>${statusBadge(inquiry.status)}</dd>
        <dt>Requested space</dt><dd>${inquiry.spaceName
    ? html`<a class="rowlink" href="/admin/spaces/${inquiry.spaceId}">${inquiry.spaceName}</a>
        <span class="meta-line">${inquiry.spaceCode} · ${inquiry.categoryLabel ?? ''}</span>`
    : html`<span>The requested space is no longer in the catalogue.</span>`}</dd>
        <dt>Requested window</dt><dd>${periodLabel(inquiry.startAt, inquiry.endAt)}
          <span class="meta-line">${dateLabel(inquiry.startAt)}
            ${timeLabel(inquiry.startAt)}–${timeLabel(inquiry.endAt)} (Sri Lanka Standard Time)</span></dd>
        <dt>Attendees</dt><dd>${inquiry.attendees === null ? 'Not stated' : inquiry.attendees}</dd>
        <dt>Desks requested</dt><dd>${inquiry.deskQuantity === null ? 'Not stated' : inquiry.deskQuantity}</dd>
        <dt>Visitor message</dt><dd>${inquiry.message ? html`<blockquote>${inquiry.message}</blockquote>` : html`<span class="meta-line">No message sent.</span>`}</dd>
        ${inquiry.convertedReservationId
    ? html`<dt>Converted reservation</dt><dd>
            <a class="rowlink" href="/admin/reservations/${inquiry.convertedReservationId}">${inquiry.convertedReservationReference ?? `#${inquiry.convertedReservationId}`}</a>
            ${inquiry.convertedReservationStatus ? html` ${statusBadge(inquiry.convertedReservationStatus)}` : ''}
          </dd>`
    : ''}
      </dl>
      ${multiDay
    ? html`<p class="hint">This window spans more than one business day. Check the dates on the
        booking form before saving — the link above carries only the first day.</p>`
    : ''}
    </div>`,
  })}

          ${card({
    title: 'Visitor contact details',
    actions: html`<a class="button button--ghost button--small" href="/admin/customers?q=${encodeURIComponent(inquiry.email)}">Look up in customer directory</a>`,
    body: html`<dl class="detail-list">
      <dt>Name</dt><dd>${inquiry.customerName}</dd>
      <dt>Email</dt><dd><a href="mailto:${inquiry.email}">${inquiry.email}</a></dd>
      <dt>Phone</dt><dd>${inquiry.phone ?? html`<span class="meta-line">Not provided</span>`}</dd>
      <dt>Organisation</dt><dd>${inquiry.organization ?? html`<span class="meta-line">Not provided</span>`}</dd>
    </dl>`,
  })}

          ${card({
    title: 'Availability for the requested window (read-only)',
    description: 'A preview computed at page load. The authority is the check inside the transaction that commits a booking.',
    body: availability
      ? html`<div class="stack">
          <div class="cluster">
            ${availabilityPill(availability.isAvailable, availability.label)}
            <span class="meta-line">${availability.freeUnits} of ${availability.totalUnits} bookable units free</span>
          </div>
          ${occupancyMeter(occupiedPct, `Requested window occupancy: ${occupiedPct}%`)}
          <dl class="detail-list">
            <dt>Bookable units</dt><dd>${availability.totalUnits}</dd>
            <dt>Free in this window</dt><dd>${availability.freeUnits}</dd>
            <dt>Units this request needs</dt><dd>${availability.requestedUnits}</dd>
            <dt>Checked</dt><dd>${timeTag(availability.checkedAt)}</dd>
          </dl>
          <p class="hint">Provisional only: another confirmed booking can change this before a
            reservation is created.</p>
        </div>`
      : html`<p class="hint">Availability could not be computed for this request (the space may have
          been removed or archived).</p>`,
  })}

          ${card({
    title: 'Activity for this inquiry',
    description: 'Append-only. Every entry was written in the same transaction as the change it describes.',
    body: timeline.length
      ? html`<ol class="stack">${timeline.map((entry) => html`<li>
          ${timeTag(entry.at)} — ${entry.actorLabel} — ${tag(entry.action)}
          <span class="meta-line">${entry.summary}</span>
          ${entry.details
      ? html`<details><summary>Details</summary><pre>${JSON.stringify(entry.details, null, 2)}</pre></details>`
      : ''}
        </li>`)}</ol>`
      : emptyState('No activity recorded for this inquiry yet.'),
  })}
        </div>

        <div class="stack">
          ${card({
    title: 'Convert to Confirmed Reservation',
    description: 'This inquiry holds no inventory until a staff reservation is committed.',
    body: html`<div class="stack">
      <p>This request <strong>has not reserved any inventory</strong> and holds no occupancy row
        in the database. The space may be booked by someone else at any time until staff press
        “Create reservation from this inquiry” and the booking commits.</p>
      ${inquiry.convertedReservationId
    ? html`<div class="alert alert--success" role="status">
          <p>Already linked to reservation <a class="rowlink" href="/admin/reservations/${inquiry.convertedReservationId}">${inquiry.convertedReservationReference ?? `#${inquiry.convertedReservationId}`}</a>.</p>
        </div>`
    : ''}
      <div class="stack">
        <a class="button button--primary button--block" href="${convertUrl(inquiry)}">Create reservation from this inquiry</a>
        <a class="button button--ghost button--block" href="/admin/customers/new?name=${encodeURIComponent(inquiry.customerName ?? '')}&amp;email=${encodeURIComponent(inquiry.email ?? '')}&amp;phone=${encodeURIComponent(inquiry.phone ?? '')}&amp;organization=${encodeURIComponent(inquiry.organization ?? '')}">Create customer profile first</a>
      </div>
    </div>`,
  })}

          ${card({
    title: 'Update this inquiry',
    description: 'Record follow-up progress and internal staff notes.',
    body: html`<form method="post" action="/admin/inquiries/${inquiry.id}/status" class="form-grid form-card" data-submit-once>
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <div class="form-field form-field--full">
        <label for="inquiry-status">Status</label>
        <select id="inquiry-status" name="status" aria-describedby="inquiry-status-hint">
          ${statuses.map((value) => html`<option value="${value}"
            ${value === inquiry.status ? 'selected' : ''}>${INQUIRY_STATUS_LABEL[value]}</option>`)}
        </select>
        <p class="hint" id="inquiry-status-hint">“Converted to reservation” requires a linked
          reservation. Create the reservation from this page first, then link it; the system
          refuses a conversion without one.</p>
      </div>
      <div class="form-field form-field--full">
        <label for="inquiry-notes">Internal notes</label>
        <textarea id="inquiry-notes" name="internal_notes" rows="5"
          aria-describedby="inquiry-notes-hint">${inquiry.internalNotes ?? ''}</textarea>
        <p class="hint" id="inquiry-notes-hint">Visible to staff only. Saved with the status change in
          one transaction, so the activity log always matches the row.</p>
      </div>
      <div class="form-actions">
        <button class="button button--primary" type="submit">Save update</button>
        <a class="button button--ghost" href="/admin/inquiries">Back to the queue</a>
      </div>
    </form>`,
  })}

          ${card({
    title: 'Notification delivery diagnostic',
    description: 'Recorded exactly as it happened. A stored request is never reported as a delivered email.',
    body: html`<div class="stack">
      <dl class="detail-list">
        <dt>Delivery status</dt><dd>${deliveryBadge(inquiry)} ${INQUIRY_EMAIL_STATUS_LABEL[inquiry.emailStatus]}</dd>
        <dt>Attempted</dt><dd>${inquiry.emailAttemptedAt
    ? timeTag(inquiry.emailAttemptedAt)
    : html`<span class="meta-line">No delivery attempt recorded.</span>`}</dd>
        <dt>Error</dt><dd>${inquiry.emailError
    ? html`<code>${inquiry.emailError}</code>`
    : html`<span class="meta-line">None recorded.</span>`}</dd>
        ${inquiry.emailMessageId
    ? html`<dt>Message id</dt><dd><code>${inquiry.emailMessageId}</code></dd>`
    : ''}
      </dl>
      ${!delivered
    ? html`<p class="hint">Contact this visitor by phone or another channel. Nothing was sent
          automatically from this system.</p>`
    : ''}
    </div>`,
  })}
        </div>
      </div>
    </div>`,
  });
}

/* ----------------------------------------------------------- maintenance */

export function renderMaintenancePage({
  actor, csrfToken, flash = null, blocks, spaces, filters, canCreate, canCancel,
}) {
  const activeBlocks = blocks.filter((block) => block.status === 'ACTIVE');
  const cancelledBlocks = blocks.filter((block) => block.status !== 'ACTIVE');

  const blockTable = (rows, emptyMessage) => table({
    columns: [
      { label: 'Space' },
      { label: 'Period' },
      { label: 'Reason' },
      { label: 'Status' },
      { label: 'Created by' },
      { label: 'Cancelled' },
      ...(canCancel ? [{ label: 'Actions' }] : []),
    ],
    rows: rows.map((block) => ({
      cells: [
        html`<a class="rowlink" href="/admin/spaces/${block.spaceId}">${block.spaceName}</a>
          <span class="meta-line">${block.spaceCode}</span>`,
        html`${periodLabel(block.startAt, block.endAt)}`,
        html`${block.reason}`,
        block.status === 'ACTIVE' ? tag('Active', 'busy') : tag('Cancelled', 'ok'),
        html`${block.createdByName ?? 'Staff account removed'}
          <span class="meta-line">${timeTag(block.createdAt)}</span>`,
        block.cancelledAt ? timeTag(block.cancelledAt) : html`<span class="meta-line">—</span>`,
        ...(canCancel
          ? [block.status === 'ACTIVE'
            ? html`<form method="post" action="/admin/maintenance/${block.id}/cancel" class="inline-form"
                  data-confirm="Cancel this maintenance block and release the blocked inventory?">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <input type="hidden" name="reason" value="Cancelled from the maintenance list">
                <button class="button button--danger button--small" type="submit">Cancel block</button>
              </form>`
            : html`<span class="meta-line">—</span>`]
          : []),
      ],
    })),
    emptyMessage,
  });

  return adminShell({
    title: 'Maintenance',
    subtitle: 'Blocks of planned unavailability. A block consumes the same bookable inventory as a booking.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/maintenance',
    breadcrumbs: [
      { label: 'Admin', href: '/admin' },
      { label: 'Maintenance' },
    ],
    body: html`<div class="stack">

      ${statGrid([
    statCard({
      label: 'Active blocks',
      value: activeBlocks.length,
      caption: 'In the current filter, not yet cancelled',
      tone: activeBlocks.length > 0 ? 'warning' : null,
    }),
    statCard({ label: 'Cancelled blocks', value: cancelledBlocks.length, caption: 'In the current filter, inventory released' }),
    statCard({ label: 'Blocks listed', value: blocks.length, caption: 'Matching the filters below' }),
  ], 'stat-grid--primary')}

      ${card({
    title: 'Filter',
    body: html`<form class="filters-bar filter-bar" method="get" action="/admin/maintenance">
      <div class="filter-bar__field">
        <label for="maint-space-filter">Space</label>
        <select id="maint-space-filter" name="space">
          <option value="">Any space</option>
          ${spaces.map((space) => html`<option value="${space.id}"
            ${String(filters.spaceId ?? '') === String(space.id) ? 'selected' : ''}>${space.name}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="maint-from">Overlapping from</label>
        <input id="maint-from" name="from" type="date" value="${filters.from ?? ''}">
      </div>
      <div class="filter-bar__field">
        <label for="maint-to">Overlapping to</label>
        <input id="maint-to" name="to" type="date" value="${filters.to ?? ''}">
      </div>
      <div class="filter-bar__actions">
        <button class="button button--primary button--small" type="submit">Apply</button>
        <a class="button button--ghost button--small" href="/admin/maintenance">Clear</a>
      </div>
    </form>`,
  })}

      ${card({
    title: 'Active maintenance blocks',
    body: blockTable(activeBlocks, 'No active maintenance blocks match these filters.'),
  })}

      ${cancelledBlocks.length
    ? card({
      title: 'Cancelled maintenance blocks',
      description: 'Kept for history. The inventory they blocked has been released.',
      body: blockTable(cancelledBlocks, 'None.'),
    })
    : ''}

      ${card({
    title: 'Create a maintenance block',
    description: 'Blocks every active bookable unit of the chosen space for the whole period.',
    body: canCreate
      ? html`<form method="post" action="/admin/maintenance" class="form-grid form-card" data-submit-once>
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <div class="form-field">
          <label for="maint-space">Space</label>
          <select id="maint-space" name="space_id" required aria-describedby="maint-space-hint">
            <option value="">Choose a space…</option>
            ${spaces.map((space) => html`<option value="${space.id}">${space.name} (${space.code})</option>`)}
          </select>
          <p class="hint" id="maint-space-hint">Only spaces with active bookable units can be blocked.</p>
        </div>
        <div class="form-field">
          <label for="maint-date">Date</label>
          <input id="maint-date" name="date" type="date" required>
        </div>
        <div class="form-field">
          <label for="maint-start">Start time</label>
          <input id="maint-start" name="start_time" type="time" required>
        </div>
        <div class="form-field">
          <label for="maint-end">End time</label>
          <input id="maint-end" name="end_time" type="time" required
                 aria-describedby="maint-window-hint">
          <p class="hint" id="maint-window-hint">An end time that is not after the start time rolls
            over to the next day, so overnight blocks are possible.</p>
        </div>
        <div class="form-field form-field--full">
          <label for="maint-reason">Reason</label>
          <textarea id="maint-reason" name="reason" rows="3" required
            aria-describedby="maint-reason-hint"></textarea>
          <p class="hint" id="maint-reason-hint">Required. Staff reading the calendar see this text.</p>
        </div>
        <div class="form-actions">
          <button class="button button--primary" type="submit">Block the space</button>
        </div>
      </form>
      <p class="hint">A maintenance block <strong>cannot</strong> be created over a confirmed
        reservation — the attempt is rejected and nothing is written. The block also consumes the
        same inventory as a booking, so the space cannot be booked for that period.</p>`
      : html`<p class="hint">Maintenance creation is registered by another admin route module in
          this build. Use it there; this page only lists and filters blocks.</p>`,
  })}
    </div>`,
  });
}

/* ----------------------------------------------------------- activity log */

export function renderAuditPage({
  actor, csrfToken, flash = null, entries, actors, filters, page, pageSize, total,
  windowLimited = false,
}) {
  const entityTypes = ['reservation', 'space', 'customer', 'inquiry', 'maintenance_block', 'admin_user'];
  const knownActions = [
    'reservation.created', 'reservation.updated', 'reservation.cancelled',
    'space.created', 'space.updated', 'space.published', 'space.unpublished',
    'space.archived', 'space.restored', 'space.inventory_changed', 'space.image_added',
    'space.image_removed', 'space.cover_set', 'space.images_reordered',
    'customer.created', 'customer.updated', 'maintenance.created', 'maintenance.cancelled',
    'inquiry.received', 'inquiry.status_changed', 'inquiry.withdrawn', 'auth.login',
    'auth.login_failed', 'auth.logout', 'admin_user.created', 'admin_user.updated',
  ];

  return adminShell({
    title: 'Activity log',
    subtitle: 'Append-only. Every entry is written inside the same transaction as the change it describes, '
      + 'so a committed change always has its history and a rolled-back change never does.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/audit',
    breadcrumbs: [
      { label: 'Admin', href: '/admin' },
      { label: 'Activity log' },
    ],
    body: html`<div class="stack" data-reveal>

      <nav class="quick-tabs cluster" aria-label="Quick activity filters">
        <a class="button ${!filters.entityType ? 'button--primary' : 'button--ghost'} button--small" href="/admin/audit">All entries</a>
        <a class="button ${filters.entityType === 'reservation' ? 'button--primary' : 'button--ghost'} button--small" href="/admin/audit?entityType=reservation">Reservations</a>
        <a class="button ${filters.entityType === 'inquiry' ? 'button--primary' : 'button--ghost'} button--small" href="/admin/audit?entityType=inquiry">Inquiries</a>
        <a class="button ${filters.entityType === 'space' ? 'button--primary' : 'button--ghost'} button--small" href="/admin/audit?entityType=space">Spaces</a>
      </nav>

      ${card({
    title: 'Filter the log',
    description: 'Inspect immutable operational records by entity type, action name, or staff member.',
    body: html`<form class="filters-bar filter-bar" method="get" action="/admin/audit">
      <div class="filter-bar__field">
        <label for="audit-entity">Entity type</label>
        <select id="audit-entity" name="entityType">
          <option value="">Any entity</option>
          ${entityTypes.map((value) => html`<option value="${value}"
            ${filters.entityType === value ? 'selected' : ''}>${value}</option>`)}
        </select>
      </div>
      <div class="filter-bar__field">
        <label for="audit-action">Action contains</label>
        <input id="audit-action" name="action" type="search" value="${filters.action ?? ''}"
               list="audit-action-options" maxlength="80">
        <datalist id="audit-action-options">
          ${knownActions.map((value) => html`<option value="${value}"></option>`)}
        </datalist>
      </div>
      <div class="filter-bar__field">
        <label for="audit-actor">Actor</label>
        <select id="audit-actor" name="actor">
          <option value="">Any actor</option>
          ${actors.map((adminUser) => html`<option value="${adminUser.id}"
            ${String(filters.actor ?? '') === String(adminUser.id) ? 'selected' : ''}>
            ${adminUser.displayName}${adminUser.isActive ? '' : ' (inactive)'}
          </option>`)}
        </select>
      </div>
      <div class="filter-bar__actions">
        <button class="button button--primary button--small" type="submit">Apply</button>
        <a class="button button--ghost button--small" href="/admin/audit">Clear</a>
      </div>
    </form>`,
  })}

      ${card({
    title: 'Entries',
    description: `${total} entr${total === 1 ? 'y' : 'ies'} match. Page ${page} of
      ${Math.max(1, Math.ceil(total / pageSize))}.`,
    body: html`<div class="stack">
      ${table({
      columns: [
        { label: 'When' },
        { label: 'Actor' },
        { label: 'Action' },
        { label: 'Entity' },
        { label: 'Summary' },
        { label: 'Details' },
      ],
      rows: entries.map((entry) => ({
        cells: [
          timeTag(entry.at),
          html`<span>${entry.actorLabel}</span>`,
          tag(entry.action),
          auditEntity(entry),
          html`${entry.summary}`,
          entry.details
            ? html`<details><summary>JSON</summary><pre>${JSON.stringify(entry.details, null, 2)}</pre></details>`
            : html`<span class="meta-line">—</span>`,
        ],
      })),
      emptyMessage: 'No activity-log entries match these filters.',
    })}
      ${entries.length === 0
    ? emptyState('Nothing matches these filters.',
      'The log records space, customer, reservation, maintenance and inquiry changes, plus sign-in events.')
    : ''}
      ${pagination({ page, pageSize, total, basePath: '/admin/audit', extraQuery: filters.query })}
    </div>`,
  })}

      ${windowLimited
    ? html`<p class="hint">Filters are applied to the newest 200 activity entries, the hard cap of
        the audit service reader. Narrow the filters to reach older entries reliably.</p>`
    : html`<p class="hint">The activity log is append-only: entries are never edited or deleted, and
        each is written in the same transaction as the change it describes.</p>`}
    </div>`,
  });
}
