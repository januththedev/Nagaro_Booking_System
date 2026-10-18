/**
 * HTML templating primitives.
 *
 * `html` is a tagged template that escapes every interpolation by default.
 * Raw markup must be wrapped explicitly with `raw()`, which makes unescaped
 * output easy to audit with a grep.
 */
import { businessDateKey, businessTimeLabel, businessDateTimeLabel, formatDuration } from '../../server/domain/time.js';
import { formatMoney, formatMoneyCompact } from '../../server/services/pricingService.js';
import {
  RESERVATION_STATUS_LABEL, SPACE_CATEGORY_LABEL, SPACE_STATUS_LABEL,
  PRICING_UNIT_LABEL, INQUIRY_STATUS_LABEL, INQUIRY_EMAIL_STATUS_LABEL,
} from '../../server/domain/constants.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export class RawHtml {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}

export function raw(value) {
  return value instanceof RawHtml ? value : new RawHtml(value);
}

function render(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof RawHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + strings[i + 1];
  }
  return new RawHtml(out);
}

export function join(list, separator = '') {
  return raw(list.filter(Boolean).map((item) => render(item)).join(typeof separator === 'string' ? separator : render(separator)));
}

/* ------------------------------------------------------------- formatting */

export function money(cents, currency = 'ETB') {
  return formatMoney(cents, currency);
}

export function moneyCompact(cents, currency = 'ETB') {
  return formatMoneyCompact(cents, currency);
}

export function dateLabel(epochMs) {
  return businessDateKey(epochMs);
}

export function timeLabel(epochMs) {
  return businessTimeLabel(epochMs);
}

export function dateTimeLabel(epochMs) {
  return businessDateTimeLabel(epochMs);
}

/** `10 Nov 2026` */
export function friendlyDate(epochMs) {
  if (!epochMs) return '—';
  const [y, m, d] = businessDateKey(epochMs).split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

/** `10 Nov 2026, 09:00–11:00` within one day, otherwise with both dates. */
export function periodLabel(startAt, endAt) {
  if (!startAt || !endAt) return '—';
  const sameDay = businessDateKey(startAt) === businessDateKey(endAt)
    || (businessDateKey(endAt) === businessDateKey(startAt) && businessTimeLabel(endAt) === '00:00');
  if (sameDay) {
    return `${friendlyDate(startAt)}, ${businessTimeLabel(startAt)}–${businessTimeLabel(endAt)}`;
  }
  return `${friendlyDate(startAt)} ${businessTimeLabel(startAt)} → ${friendlyDate(endAt)} ${businessTimeLabel(endAt)}`;
}

export function relativeDayLabel(epochMs, nowMs = Date.now()) {
  const key = businessDateKey(epochMs);
  const today = businessDateKey(nowMs);
  if (key === today) return 'Today';
  const tomorrow = businessDateKey(nowMs + 86400000);
  if (key === tomorrow) return 'Tomorrow';
  const yesterday = businessDateKey(nowMs - 86400000);
  if (key === yesterday) return 'Yesterday';
  return friendlyDate(epochMs);
}

export function durationLabel(startAt, endAt) {
  return formatDuration(startAt, endAt);
}

/* ----------------------------------------------------------------- comps */

export function statusBadge(status) {
  const map = {
    CONFIRMED: 'badge badge--confirmed',
    CANCELLED: 'badge badge--cancelled',
    COMPLETED: 'badge badge--completed',
    DRAFT: 'badge badge--draft',
    PUBLISHED: 'badge badge--published',
    ARCHIVED: 'badge badge--archived',
    NEW: 'badge badge--new',
    CONTACTED: 'badge badge--contacted',
    CONVERTED: 'badge badge--converted',
    CLOSED: 'badge badge--closed',
    WITHDRAWN: 'badge badge--withdrawn',
    SENT: 'badge badge--published',
    PENDING: 'badge badge--draft',
    FAILED: 'badge badge--cancelled',
    NOT_CONFIGURED: 'badge badge--archived',
  };
  const label = RESERVATION_STATUS_LABEL[status]
    ?? SPACE_STATUS_LABEL[status]
    ?? INQUIRY_STATUS_LABEL[status]
    ?? INQUIRY_EMAIL_STATUS_LABEL[status]
    ?? status;
  return html`<span class="${map[status] ?? 'badge'}">${label}</span>`;
}

export function categoryLabel(category) {
  return SPACE_CATEGORY_LABEL[category] ?? category;
}

export function pricingUnitLabel(unit) {
  return PRICING_UNIT_LABEL[unit] ?? unit;
}

export function tag(text, variant = '') {
  return html`<span class="tag ${variant ? `tag--${variant}` : ''}">${text}</span>`;
}

/** Available / provisional availability pill used across public pages. */
export function availabilityPill(isAvailable, label) {
  return html`<span class="pill ${isAvailable ? 'pill--ok' : 'pill--busy'}">${label}</span>`;
}

/** Renders `field` errors from a validation details object. */
export function fieldError(details, field) {
  if (!details) return '';
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const message = details[field];
    if (typeof message === 'string' && message.length) return html`<p class="field-error">${message}</p>`;
  }
  return '';
}

export function problemList(problems) {
  if (!problems || problems.length === 0) return '';
  return html`<ul class="problem-list">${problems.map((p) => html`<li>${p}</li>`)}</ul>`;
}

export function emptyState(message, hint = null) {
  return html`<div class="empty-state">
    <p class="empty-state__message">${message}</p>
    ${hint ? html`<p class="empty-state__hint">${hint}</p>` : ''}
  </div>`;
}

export function pagination({ page, pageSize, total, basePath, extraQuery = {} }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return '';
  const buildUrl = (targetPage) => {
    const params = new URLSearchParams({ ...extraQuery, page: String(targetPage) });
    return `${basePath}?${params.toString()}`;
  };
  return html`<nav class="pagination" aria-label="Pagination">
    ${page > 1 ? html`<a class="pagination__link" href="${buildUrl(page - 1)}" rel="prev">← Previous</a>` : html`<span class="pagination__spacer"></span>`}
    <span class="pagination__status">Page ${page} of ${pages} · ${total} total</span>
    ${page < pages ? html`<a class="pagination__link" href="${buildUrl(page + 1)}" rel="next">Next →</a>` : html`<span class="pagination__spacer"></span>`}
  </nav>`;
}

export function csrfField(token) {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

export function attr(name, value) {
  if (value === null || value === undefined || value === false) return raw('');
  if (value === true) return raw(` ${name}`);
  return raw(` ${name}="${escapeHtml(value)}"`);
}

export { businessDateKey, businessTimeLabel, businessDateTimeLabel };
