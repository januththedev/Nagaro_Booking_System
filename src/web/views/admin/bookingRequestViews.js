/**
 * Staff booking-request inbox.
 *
 * This replaces the original one-table dump with a scan-friendly queue:
 * status tabs, a search box, per-request cards, one-click approval and
 * collapsible rejection/payment-resolution forms. Views never query the
 * database; the route passes hydrated requests in.
 */
import {
  csrfField, dateTimeLabel, emptyState, html, money, timeLabel,
} from '../../lib/html.js';
import { adminShell } from '../layout.js';

const REQUEST_STATUS_LABEL = Object.freeze({
  REQUESTED: 'New request',
  APPROVED_AWAITING_PAYMENT: 'Awaiting payment',
  PAYMENT_REVIEW_REQUIRED: 'Payment review',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
});

const PAYMENT_STATUS_LABEL = Object.freeze({
  NOT_REQUIRED: 'No payment required',
  UNPAID: 'Unpaid',
  PENDING: 'Payment pending',
  PAID: 'Paid',
  FAILED: 'Payment failed',
  REVIEW_REQUIRED: 'Review required',
  REFUNDED: 'Refunded',
});

const TABS = Object.freeze([
  { value: 'open', label: 'Open' },
  { value: 'REQUESTED', label: 'New' },
  { value: 'APPROVED_AWAITING_PAYMENT', label: 'Awaiting payment' },
  { value: 'PAYMENT_REVIEW_REQUIRED', label: 'Payment review' },
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]);

const OPEN_STATUSES = new Set(['REQUESTED', 'APPROVED_AWAITING_PAYMENT', 'PAYMENT_REVIEW_REQUIRED']);
const CLOSED_STATUSES = new Set(['REJECTED', 'CANCELLED', 'EXPIRED']);

function requestStatusBadge(status) {
  const tone = status === 'CONFIRMED' ? 'badge--confirmed'
    : status === 'REQUESTED' ? 'badge--new'
      : status === 'APPROVED_AWAITING_PAYMENT' ? 'badge--draft'
        : status === 'PAYMENT_REVIEW_REQUIRED' ? 'badge--draft'
          : status === 'REJECTED' || status === 'CANCELLED' || status === 'EXPIRED' ? 'badge--cancelled'
            : '';
  return html`<span class="badge ${tone}">${REQUEST_STATUS_LABEL[status] ?? status}</span>`;
}

function paymentStatusBadge(status) {
  const tone = status === 'PAID' || status === 'NOT_REQUIRED' ? 'badge--confirmed'
    : status === 'FAILED' ? 'badge--cancelled'
      : status === 'REVIEW_REQUIRED' ? 'badge--draft'
        : 'badge--contacted';
  return html`<span class="badge ${tone}">${PAYMENT_STATUS_LABEL[status] ?? status}</span>`;
}

function deadlineLine(item) {
  if (!item.holdExpiresAt) return null;
  return html`<p class="hint">Inventory is held until ${dateTimeLabel(item.holdExpiresAt)}.</p>`;
}

function matchesSearch(item, needle) {
  if (!needle) return true;
  const haystack = [
    item.reference,
    item.spaceCode,
    item.spaceName,
    item.customer?.fullName,
    item.customer?.email,
    item.customer?.organization,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

function matchesTab(item, tab) {
  if (tab === 'open') return OPEN_STATUSES.has(item.status);
  if (tab === 'closed') return CLOSED_STATUSES.has(item.status);
  if (tab === 'all') return true;
  return item.status === tab;
}

function tabHref(tab, filters) {
  const params = new URLSearchParams();
  if (tab !== 'open') params.set('status', tab);
  if (filters.q) params.set('q', filters.q);
  const query = params.toString();
  return query ? `/admin/booking-requests?${query}` : '/admin/booking-requests';
}

function decisionPanel(item, csrfToken) {
  if (item.status === 'REQUESTED') {
    return html`<div class="cluster request-card__actions">
      <form method="post" action="/admin/booking-requests/${item.reference}/approve" class="inline-form">
        ${csrfField(csrfToken)}
        <button class="button button--primary button--small" type="submit">Approve request</button>
      </form>
      <details class="request-decision">
        <summary class="button button--ghost button--small">Reject…</summary>
        <form method="post" action="/admin/booking-requests/${item.reference}/reject" class="stack request-decision__form">
          ${csrfField(csrfToken)}
          <div class="form-field">
            <label for="reject-${item.reference}">Reason for rejection</label>
            <textarea id="reject-${item.reference}" name="reason" rows="3" required maxlength="1000"
                      placeholder="Tell the customer why this request cannot be approved."></textarea>
          </div>
          <button class="button button--danger button--small" type="submit">Reject request</button>
        </form>
      </details>
    </div>`;
  }

  if (item.status === 'PAYMENT_REVIEW_REQUIRED') {
    return html`<details class="request-decision">
      <summary class="button button--primary button--small">Resolve payment…</summary>
      <form method="post" action="/admin/booking-requests/${item.reference}/resolve-payment" class="stack request-decision__form">
        ${csrfField(csrfToken)}
        <div class="form-field">
          <label for="outcome-${item.reference}">Outcome</label>
          <select id="outcome-${item.reference}" name="outcome">
            <option value="REFUND_RECORDED">Refund recorded</option>
            <option value="PAYMENT_KEPT">Payment kept</option>
          </select>
        </div>
        <div class="form-field">
          <label for="note-${item.reference}">Note</label>
          <textarea id="note-${item.reference}" name="note" rows="3" required maxlength="1000"
                    placeholder="What was verified, and what happens next?"></textarea>
        </div>
        <button class="button button--primary button--small" type="submit">Resolve payment</button>
      </form>
    </details>`;
  }

  return null;
}

function requestCard(item, csrfToken) {
  const payment = item.payment;
  const latestAttempt = payment?.latestAttempt;
  const decision = decisionPanel(item, csrfToken);
  const reservationLink = item.reservationReference
    ? html`<a href="/admin/reservations?q=${encodeURIComponent(item.reservationReference)}">Open ${item.reservationReference}</a>`
    : '';

  return html`<article class="card request-card">
    <header class="card__head">
      <div>
        <p class="section-eyebrow">${item.reference}</p>
        <h2 class="card__title">${item.spaceName}</h2>
        <p class="card__description">${dateTimeLabel(item.startAt)} – ${timeLabel(item.endAt)} · ${item.unitCount} ${item.unitCount === 1 ? 'unit' : 'units'}${item.attendees ? ` · ${item.attendees} attending` : ''}</p>
      </div>
      <div class="cluster">
        ${requestStatusBadge(item.status)}
        ${paymentStatusBadge(item.paymentStatus)}
      </div>
    </header>
    <div class="card__body stack">
      <dl class="detail-list">
        <dt>Customer</dt>
        <dd>${item.customer?.fullName ?? '—'}${item.customer?.email ? html`<br><span class="hint">${item.customer.email}</span>` : ''}${item.customer?.organization ? html`<br><span class="hint">${item.customer.organization}</span>` : ''}</dd>
        <dt>Space</dt>
        <dd><code>${item.spaceCode}</code> · ${item.spaceName}</dd>
        <dt>Venue total</dt>
        <dd>${money(item.venueTotalCents, item.currency)}${payment ? html` <span class="hint">· registration ${money(payment.bookingFeeCents, payment.currency)}</span>` : ''}</dd>
        ${payment ? html`<dt>Payments</dt>
        <dd>Advance paid ${money(payment.advancePaidCents, payment.currency)} · balance ${money(payment.remainingBalanceCents, payment.currency)}${latestAttempt ? html`<br><span class="hint">${latestAttempt.orderId} · ${latestAttempt.status}${latestAttempt.paymentId ? ` · PayHere ${latestAttempt.paymentId}` : ''}</span>` : ''}</dd>` : ''}
        ${item.purpose ? html`<dt>Purpose</dt><dd>${item.purpose}</dd>` : ''}
        ${item.rejectionReason ? html`<dt>Rejection reason</dt><dd>${item.rejectionReason}</dd>` : ''}
      </dl>
      ${deadlineLine(item)}
      ${reservationLink ? html`<p class="hint">${reservationLink}</p>` : ''}
      ${decision ?? ''}
    </div>
  </article>`;
}

function feePolicyPanel(policy, csrfToken) {
  return html`<details class="card request-policy">
    <summary class="card__head">
      <div>
        <p class="section-eyebrow">Settings</p>
        <h2 class="card__title">Registration fee policy</h2>
        <p class="card__description">Disabled by default. The fee is snapshotted on approval and credited toward the venue total.</p>
      </div>
      <span class="button button--ghost button--small" aria-hidden="true">Configure</span>
    </summary>
    <div class="card__body">
      <form method="post" action="/admin/booking-requests/fee-policy" class="form-grid">
        ${csrfField(csrfToken)}
        <div class="form-field">
          <label for="fee-mode">Mode</label>
          <select id="fee-mode" name="mode">
            <option value="DISABLED" ${policy?.mode === 'DISABLED' ? 'selected' : ''}>Disabled (no registration fee)</option>
            <option value="FIXED" ${policy?.mode === 'FIXED' ? 'selected' : ''}>Fixed amount (LKR)</option>
            <option value="PERCENTAGE" ${policy?.mode === 'PERCENTAGE' ? 'selected' : ''}>Percentage of venue total</option>
          </select>
        </div>
        <div class="form-field">
          <label for="fixed-lkr">Fixed fee (LKR)</label>
          <input id="fixed-lkr" name="fixed_lkr" type="number" min="0" step="0.01" value="${((policy?.fixedCents ?? 0) / 100).toFixed(2)}">
        </div>
        <div class="form-field">
          <label for="fee-percentage">Percentage</label>
          <input id="fee-percentage" name="percentage" type="number" min="0" max="100" step="0.01" value="${((policy?.percentageBps ?? 0) / 100).toFixed(2)}">
        </div>
        <div class="form-field">
          <label for="payment-window">Payment window (minutes)</label>
          <input id="payment-window" name="payment_window_minutes" type="number" min="5" max="10080" value="${policy?.paymentWindowMinutes ?? 120}">
        </div>
        <div class="form-actions form-field--full">
          <button class="button button--primary" type="submit">Save registration fee</button>
        </div>
      </form>
    </div>
  </details>`;
}

export function renderBookingRequestsPage({
  actor, csrfToken, flash = null, items = [], policy = null, filters = {},
}) {
  const tab = filters.status ?? 'open';
  const needle = String(filters.q ?? '').trim().toLowerCase();
  const byTab = (value) => items.filter((item) => matchesTab(item, value));
  const counts = {
    open: byTab('open').length,
    REQUESTED: byTab('REQUESTED').length,
    APPROVED_AWAITING_PAYMENT: byTab('APPROVED_AWAITING_PAYMENT').length,
    PAYMENT_REVIEW_REQUIRED: byTab('PAYMENT_REVIEW_REQUIRED').length,
    CONFIRMED: byTab('CONFIRMED').length,
    closed: byTab('closed').length,
    all: items.length,
  };
  const visible = byTab(tab).filter((item) => matchesSearch(item, needle));

  const tabs = html`<nav class="cluster request-tabs" aria-label="Filter booking requests">
    ${TABS.map((entry) => {
    const active = entry.value === tab;
    return html`<a class="button button--ghost button--small ${active ? 'is-active' : ''}"
                   href="${tabHref(entry.value, { q: filters.q ?? '' })}"
                   ${active ? html`aria-current="page"` : ''}>${entry.label} <span class="tag">${counts[entry.value] ?? 0}</span></a>`;
  })}
  </nav>`;

  const search = html`<form method="get" action="/admin/booking-requests" class="filter-bar">
    ${tab !== 'open' ? html`<input type="hidden" name="status" value="${tab}">` : ''}
    <div class="filter-bar__field">
      <label for="request-search">Search requests</label>
      <input id="request-search" name="q" type="search" value="${filters.q ?? ''}" placeholder="Reference, customer, email, space…">
    </div>
    <div class="filter-bar__actions">
      <button class="button button--primary button--small" type="submit">Search</button>
      <a class="button button--ghost button--small" href="/admin/booking-requests">Reset</a>
    </div>
  </form>`;

  const list = visible.length
    ? html`<div class="stack">${visible.map((item) => requestCard(item, csrfToken))}</div>`
    : emptyState(
      needle ? 'No requests match that search.' : 'Nothing in this queue.',
      needle ? 'Try a different reference, customer or space.' : 'New customer requests will appear here as soon as they arrive.',
    );

  const canManageFees = actor?.role === 'ADMIN' || actor?.role === 'SUPER_ADMIN';

  return adminShell({
    title: 'Booking requests',
    subtitle: 'Review customer requests, approve the schedule and keep payment holds moving. Approval is one click; rejection always records a reason.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/booking-requests',
    extraStyles: ['/assets/admin-ux.css'],
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Booking requests' }],
    pageActions: html`
      <a class="button button--ghost button--small" href="/admin/calendar">Open calendar</a>
      <a class="button button--primary button--small" href="/admin/reservations/new">New reservation</a>`,
    body: html`<div class="stack">
      ${tabs}
      ${search}
      ${list}
      ${canManageFees ? feePolicyPanel(policy, csrfToken) : ''}
    </div>`,
  });
}
