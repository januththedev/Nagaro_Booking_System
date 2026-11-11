/*
 * Customer room-access page.
 *
 * This script only renders what the server says. Every decision - whether the
 * booking is active, whether the door may open, what an extension costs - is
 * made by the backend and arrives in the /api/access/state response. The
 * clock used for scheduling the next refresh is the server's, not the phone's.
 */
import { translate } from './access-i18n.js';

const root = document.getElementById('access-root');
const token = decodeURIComponent(location.pathname.replace(/\/+$/, '').split('/').pop() || '');
const locale = document.documentElement.lang || 'en';
const t = (key, vars) => translate(locale, key, vars);

const ui = { selected: null, busy: null, error: null, offline: false, gone: false };
let state = null;
let clockOffset = 0;
let pollTimer = null;
let lastMarkup = '';
let inFlight = null;
let extendedTimer = null;

/* ------------------------------------------------------------------ icons */

const ICON = {
  door: '<path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M3 21h18"/><path d="M14.5 12.5h.01"/>',
  doorOpen: '<path d="M13 4 6 6v15l7-2z"/><path d="M13 5h3a2 2 0 0 1 2 2v14"/><path d="M3 21h18"/><path d="M10 12.5h.01"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.7"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><path d="M12 15v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  clockAlert: '<path d="M20.5 9.5A9 9 0 1 0 14 20.8"/><path d="M12 7v5l3 2"/><path d="M19.5 14v4"/><path d="M19.5 21.2h.01"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/><path d="M15 15h2"/>',
  headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4.5" height="6.5" rx="1.6"/><rect x="17" y="13" width="4.5" height="6.5" rx="1.6"/><path d="M19.5 19.5c0 1.4-1.6 2.2-4 2.2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  wifiOff: '<path d="M4 4l16 16"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 13a10 10 0 0 1 3.5-2.3"/><path d="M19 13a10 10 0 0 0-5-2.8"/><path d="M12 20h.01"/>',
  shield: '<path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z"/><path d="m9.5 12 2 2 3.5-4"/>',
};
const svg = (name, cls = '') => `<svg ${cls ? `class="${cls}" ` : ''}viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

/* ---------------------------------------------------------------- helpers */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(cents, currency = 'LKR') {
  const value = Math.round(Number(cents) || 0);
  const whole = Math.trunc(value / 100).toLocaleString('en-US');
  return `${currency} ${whole}.${String(Math.abs(value % 100)).padStart(2, '0')}`;
}

function percent(bps) {
  const value = Number(bps) || 0;
  return value % 100 === 0 ? String(value / 100) : (value / 100).toFixed(2).replace(/0$/, '');
}

function newKey() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

function serverNow() { return Date.now() + clockOffset; }

async function api(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(path, {
    method,
    headers: { Accept: 'application/json', 'X-Access-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'same-origin',
    referrerPolicy: 'no-referrer',
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok || !payload || payload.ok === false) {
    const error = new Error(payload?.error?.message || 'Request failed');
    error.status = response.status;
    error.code = payload?.error?.code || 'UNKNOWN';
    throw error;
  }
  return payload;
}

function errorText(error) {
  const known = {
    DOOR_BUSY: 'error.busy', ACCESS_ENDED: 'error.ended', EXTENSION_UNAVAILABLE: 'error.unavailable', RATE_LIMITED: 'error.rate',
    VERIFICATION_FAILED: 'error.verify', ACCESS_REVOKED: 'revoked.text', DOOR_UNAVAILABLE: 'door.sub.none',
  };
  if (known[error?.code]) return t(known[error.code]);
  if (locale === 'en' && error?.status && error.status < 500 && error.message) return error.message;
  return t('error.generic');
}

/* ------------------------------------------------------------- components */

function badge() {
  const map = {
    VERIFY: ['', 'badge.verify'],
    UPCOMING: ['amber', 'badge.upcoming'],
    ACTIVE_LOCKED: ['green', 'badge.active'], ACTIVE_UNLOCKED: ['green', 'badge.active'], ACTIVE_PENDING: ['green', 'badge.active'],
    ACTIVE_UNKNOWN: ['green', 'badge.active'], CONTROLLER_OFFLINE: ['amber', 'badge.offline'], EXTENDED: ['green', 'badge.extended'],
    ENDED: ['red', 'badge.ended'], EXTENSION_PENDING: ['red', 'badge.ended'],
    CANCELLED: ['red', 'badge.cancelled'], ACCESS_REVOKED: ['red', 'badge.revoked'],
  };
  const [tone, key] = map[state.state] ?? ['', 'badge.active'];
  return `<span class="ax-badge${tone ? ` ax-badge--${tone}` : ''}">${esc(t(key))}</span>`;
}

/** BookingAccessHeader */
function header() {
  const booking = state?.booking;
  const space = booking?.spaceName ?? root.dataset.space ?? '';
  const reference = booking?.reference ?? root.dataset.reference ?? '';
  const subtitle = `${esc(space)}${reference ? ` · <span class="ax-nowrap">${esc(reference)}</span>` : ''}`;
  return `<header class="ax-header">
    <div class="ax-header__text"><h1 class="ax-title">${esc(t('title'))}</h1><p class="ax-subtitle">${subtitle}</p></div>
    ${state ? badge() : ''}
  </header>`;
}

function notice(kind, text, icon = kind === 'success' ? 'check' : 'alert') {
  return `<div class="ax-notice ax-notice--${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${svg(icon)}<span>${esc(text)}</span></div>`;
}

function feedback() {
  let out = '';
  if (ui.offline) out += notice('warn', t('error.offline'), 'wifiOff');
  if (ui.error) out += notice('error', ui.error);
  return out;
}

/** DoorStatusCard */
function doorStatusCard() {
  const door = state.door;
  const busy = ui.busy === 'OPEN' || ui.busy === 'CLOSE' ? ui.busy : door.pendingAction;
  let icon = 'door'; let title; let sub;
  if (busy) {
    title = t(busy === 'OPEN' ? 'door.unlocking' : 'door.locking');
    sub = t('door.sub.wait');
    icon = busy === 'OPEN' ? 'doorOpen' : 'door';
  } else if (!door.available) {
    title = t('door.unknown'); sub = t('door.sub.none');
  } else if (state.state === 'CONTROLLER_OFFLINE') {
    title = t('door.unknown'); sub = t('door.sub.offline');
  } else if (door.state === 'UNLOCKED') {
    icon = 'doorOpen'; title = t('door.unlocked');
    sub = door.autoLockLabel ? t('door.sub.autolock', { time: door.autoLockLabel }) : t('door.sub.until', { time: state.booking.endLabel });
  } else if (door.state === 'LOCKED') {
    title = t('door.locked'); sub = t('door.sub.until', { time: state.booking.endLabel });
  } else if (door.lastAction?.status === 'ACKNOWLEDGED') {
    title = t(door.lastAction.action === 'OPEN' ? 'door.unlockSent' : 'door.lockSent'); sub = t('door.sub.unconfirmed');
  } else {
    title = t('door.unknown'); sub = t('door.sub.unconfirmed');
  }
  return `<div class="ax-panel ax-panel--center">
    ${busy ? '<div class="ax-spinner ax-spinner--large" aria-hidden="true"></div>' : svg(icon, `ax-panel__icon${door.state === 'UNLOCKED' && !busy ? ' ax-panel__icon--green' : ''}`)}
    <h2 class="ax-panel__title">${esc(title)}</h2>
    <p class="ax-panel__meta">${esc(sub)}</p>
  </div>`;
}

/** UnlockDurationSelector */
function durationSelector(disabled) {
  const controls = state.controls;
  const selected = ui.selected ?? controls.defaultMinutes;
  const chips = controls.durations.map((minutes) => `<button type="button" class="ax-chip" data-action="select" data-minutes="${minutes}"
      aria-pressed="${selected === minutes}" ${disabled ? 'disabled' : ''}>${esc(t('min', { n: minutes }))}</button>`).join('');
  const allow = controls.allowUntilEnd;
  return `<p class="ax-field-label" id="ax-duration-label">${esc(t('keepFor'))}</p>
    <div class="ax-chips" role="group" aria-labelledby="ax-duration-label">${chips}</div>
    <button type="button" class="ax-option" data-action="select" data-minutes="END" aria-pressed="${allow && selected === 'END'}" ${disabled || !allow ? 'disabled' : ''}>
      <span class="ax-option__label">${svg('clock')}${esc(t('untilEnd'))}</span>
      <span class="ax-option__caption">${esc(allow ? t('untilEnd.caption', { time: state.booking.endLabel }) : t('untilEnd.off'))}</span>
    </button>`;
}

/** DoorActionButton x2 + selector */
function doorControls() {
  const door = state.door;
  if (!door.available) return '';
  const working = Boolean(ui.busy) || Boolean(door.pendingAction) || ui.offline;
  const caption = door.state === 'UNLOCKED' ? t('unlock.captionOpen') : t('unlock.caption');
  return `<button type="button" class="ax-button ax-unlock" data-action="open" ${working ? 'disabled' : ''}>
      <span class="ax-unlock__label">${svg('unlock')}${esc(t('unlock'))}</span>
      <span class="ax-unlock__caption">${esc(caption)}</span>
    </button>
    ${durationSelector(working)}
    <button type="button" class="ax-button ax-button--outline" data-action="close" ${working ? 'disabled' : ''}>${svg('lock')}${esc(t('lock'))}</button>`;
}

/** PaymentStatusView (inside the extension card) */
function pendingExtension(ext) {
  const pending = ext.pending;
  const amount = money(ext.amountCents, ext.currency);
  const cancel = `<button type="button" class="ax-link" data-action="ext-cancel" ${ui.busy ? 'disabled' : ''}>${esc(t('ext.cancel'))}</button>`;
  if (pending.status === 'AWAITING_APPROVAL') {
    return `<div class="ax-extension__head"><h2 class="ax-extension__title">${esc(t('ext.approval.title'))}</h2><div class="ax-spinner" aria-hidden="true"></div></div>
      <p class="ax-extension__message">${esc(t('ext.approval.text', { n: ext.minutes }))}</p><div class="ax-center">${cancel}</div>`;
  }
  if (pending.method === 'DESK') {
    return `<div class="ax-extension__head"><h2 class="ax-extension__title">${esc(t('ext.desk.title'))}</h2><span class="ax-badge ax-badge--green">${esc(t('ext.badge', { n: ext.minutes }))}</span></div>
      <p class="ax-extension__message">${esc(t('ext.desk.text', { amount }))}</p><div class="ax-center">${cancel}</div>`;
  }
  const submitted = wasSubmittedRecently();
  if (pending.status === 'PAYMENT_PENDING' || (submitted && !ui.showPayAgain)) {
    return `<div class="ax-extension__head"><h2 class="ax-extension__title">${esc(t('ext.processing.title'))}</h2><div class="ax-spinner" aria-hidden="true"></div></div>
      <p class="ax-extension__message">${esc(t('ext.processing.text'))}</p>
      ${pending.checkout ? `<div class="ax-center"><button type="button" class="ax-link" data-action="show-pay">${esc(t('ext.stillWaiting'))}</button></div>` : ''}`;
  }
  return `<div class="ax-extension__head"><h2 class="ax-extension__title">${esc(t('ext.title'))}</h2><span class="ax-badge ax-badge--green">${esc(t('ext.badge', { n: ext.minutes }))}</span></div>
    <p class="ax-extension__label">${esc(t('ext.charge'))}</p>
    <div class="ax-extension__price-row"><p class="ax-extension__price">${esc(amount)}</p>${svg('card')}</div>
    <p class="ax-extension__note">${esc(t('ext.held', { time: ext.newEndLabel }))}</p>
    <div class="ax-extension__actions">
      <button type="button" class="ax-button ax-button--pay" data-action="pay" ${ui.busy || !pending.checkout ? 'disabled' : ''}>${svg('card')}${esc(t('ext.continue'))}</button>
      <div class="ax-center">${cancel}</div>
    </div>`;
}

/** ExtensionPaymentCard */
function extensionCard() {
  const ext = state.extension;
  if (!ext?.offered) return '';
  let noticeHtml = '';
  if (ext.notice && ext.notice.kind !== 'EXTENDED') {
    const key = { PAYMENT_FAILED: 'notice.failed', PAYMENT_REVIEW: 'notice.review', REJECTED: 'notice.rejected', EXPIRED: 'notice.expired' }[ext.notice.kind];
    if (key) noticeHtml = notice(ext.notice.kind === 'PAYMENT_REVIEW' ? 'warn' : 'error', t(key));
  }
  if (ext.pending) return `${noticeHtml}<section class="ax-outline ax-extension">${pendingExtension(ext)}</section>`;

  const head = `<div class="ax-extension__head"><h2 class="ax-extension__title">${esc(t('ext.title'))}</h2><span class="ax-badge ax-badge--green">${esc(t('ext.badge', { n: ext.minutes }))}</span></div>`;
  if (!ext.available) {
    return `${noticeHtml}<section class="ax-outline ax-extension">${head}<p class="ax-extension__message">${esc(ext.reason === 'UNAVAILABLE' ? t('error.unavailable') : (locale === 'en' && ext.message ? ext.message : t('ext.notAvailable')))}</p></section>`;
  }
  const online = ext.methods.includes('PAYHERE');
  const desk = ext.methods.includes('DESK');
  const note = Number(ext.surchargeBps) > 0
    ? t('ext.note', { pct: percent(ext.surchargeBps), time: ext.newEndLabel })
    : t('ext.noteNoSurcharge', { time: ext.newEndLabel });
  const disabled = ui.busy || ui.offline ? 'disabled' : '';
  const primary = online
    ? `<button type="button" class="ax-button ax-button--pay" data-action="extend" data-method="PAYHERE" ${disabled}>${ui.busy === 'EXTEND' ? '<span class="ax-spinner" aria-hidden="true"></span>' : svg('card')}${esc(t('ext.pay', { n: ext.minutes }))}</button>`
    : `<button type="button" class="ax-button ax-button--pay" data-action="extend" data-method="DESK" ${disabled}>${ui.busy === 'EXTEND' ? '<span class="ax-spinner" aria-hidden="true"></span>' : svg('card')}${esc(t('ext.deskOnly', { n: ext.minutes }))}</button>`;
  const secondary = online && desk
    ? `<div class="ax-center"><button type="button" class="ax-link" data-action="extend" data-method="DESK" ${disabled}>${esc(t('ext.desk'))}</button></div>` : '';
  return `${noticeHtml}<section class="ax-outline ax-extension">${head}
      <p class="ax-extension__label">${esc(t('ext.charge'))}</p>
      <div class="ax-extension__price-row"><p class="ax-extension__price">${esc(money(ext.amountCents, ext.currency))}</p>${svg('card')}</div>
      <p class="ax-extension__note">${esc(note)}${ext.requiresApproval ? ` · ${esc(t('ext.approvalNote'))}` : ''}</p>
      <div class="ax-extension__actions">${primary}${secondary}</div>
    </section>`;
}

/** StaffAssistanceCard */
function assistanceStatus() {
  const assistance = state.assistance;
  if (!assistance) return '';
  const key = assistance.status === 'ACKNOWLEDGED' ? 'assist.ack' : assistance.status === 'RESOLVED' ? 'assist.done' : 'assist.sent';
  return notice('success', t(key), assistance.status === 'OPEN' ? 'headset' : 'check');
}

function assistanceCard({ titleKey = 'assist.title', textKey = 'assist.text' } = {}) {
  const requested = state.assistance && state.assistance.status !== 'RESOLVED';
  return `<h2 class="ax-section__title">${esc(t(titleKey))}</h2>
    <p class="ax-section__text">${esc(t(textKey))}</p>
    ${assistanceStatus()}
    ${requested ? '' : `<button type="button" class="ax-button ax-button--outline" data-action="assist" ${ui.busy || ui.offline ? 'disabled' : ''}>${ui.busy === 'ASSIST' ? '<span class="ax-spinner" aria-hidden="true"></span>' : svg('headset')}${esc(t('assist.button'))}</button>`}`;
}

function assistanceLink() {
  if (state.assistance && state.assistance.status !== 'RESOLVED') return assistanceStatus();
  return `<div class="ax-center"><button type="button" class="ax-link" data-action="assist" ${ui.busy || ui.offline ? 'disabled' : ''}>${svg('headset')}${esc(t('assist.link'))}</button></div>`;
}

/* ------------------------------------------------------------------ views */

function messagePanel({ icon, titleKey, text, tone = 'muted' }) {
  return `<div class="ax-panel ax-panel--center">${svg(icon, `ax-panel__icon ax-panel__icon--${tone}`)}
    <h2 class="ax-panel__title">${esc(t(titleKey))}</h2><p class="ax-panel__text">${esc(text)}</p></div>`;
}

function activeView() {
  const lateOffer = state.extension?.offered ? `<hr class="ax-divider">${extensionCard()}` : '';
  const help = !state.door.available || state.state === 'CONTROLLER_OFFLINE'
    ? `<hr class="ax-divider">${assistanceCard({ titleKey: 'assist.helpTitle', textKey: 'assist.helpText' })}`
    : assistanceLink();
  return `${doorStatusCard()}${feedback()}${doorControls()}${lateOffer}${help}`;
}

/** SessionEndedCard + extension + assistance */
function endedView() {
  const ext = state.extension;
  const offer = ext?.offered && (ext.available || ext.pending);
  return `${messagePanel({ icon: 'clockAlert', titleKey: 'ended.title', text: t(offer ? 'ended.text' : 'ended.textPlain') })}
    ${feedback()}${extensionCard()}<hr class="ax-divider">${assistanceCard()}`;
}

function extendedView() {
  const info = state.extension.notice;
  return `<div class="ax-panel ax-panel--center">${svg('check', 'ax-panel__icon ax-panel__icon--green ax-pop')}
      <h2 class="ax-panel__title">${esc(t('extended.title'))}</h2>
      <p class="ax-panel__text">${esc(t('extended.text', { n: info.minutes }))}</p>
      <p class="ax-panel__meta">${esc(t('extended.until', { time: info.newEndLabel }))}</p>
    </div>
    <button type="button" class="ax-button" data-action="ext-seen" ${ui.busy ? 'disabled' : ''}>${esc(t('extended.continue'))}</button>`;
}

function verifyView() {
  return `${messagePanel({ icon: 'shield', titleKey: 'verify.title', text: t('verify.text') })}${feedback()}
    <form data-form="verify" novalidate>
      <label class="ax-visually-hidden" for="ax-last-four">${esc(t('verify.title'))}</label>
      <input class="ax-input" id="ax-last-four" name="lastFour" inputmode="numeric" autocomplete="off" pattern="[0-9]{4}" maxlength="4" placeholder="••••" required>
      <div class="ax-gap"></div>
      <button type="submit" class="ax-button" ${ui.busy ? 'disabled' : ''}>${esc(t('verify.button'))}</button>
    </form>`;
}

function view() {
  if (ui.gone) return messagePanel({ icon: 'ban', titleKey: 'gone.title', text: t('gone.text') });
  if (!state) return `${feedback()}<div class="ax-skeleton" aria-hidden="true"><span class="ax-bone ax-bone--panel"></span><span class="ax-bone ax-bone--button"></span><span class="ax-bone ax-bone--button"></span></div>`;
  switch (state.state) {
    case 'VERIFY': return verifyView();
    case 'UPCOMING':
      return `${messagePanel({ icon: 'calendar', titleKey: 'upcoming.title', text: t('upcoming.text', { time: state.booking.startLabel, date: state.booking.dateLabel }) })}${feedback()}${assistanceLink()}`;
    case 'CANCELLED':
      return `${messagePanel({ icon: 'ban', titleKey: 'cancelled.title', text: t('cancelled.text') })}${feedback()}${assistanceLink()}`;
    case 'ACCESS_REVOKED':
      return `${messagePanel({ icon: 'ban', titleKey: 'revoked.title', text: t('revoked.text') })}${feedback()}<hr class="ax-divider">${assistanceCard({ titleKey: 'assist.helpTitle', textKey: 'assist.helpText' })}`;
    case 'ENDED':
    case 'EXTENSION_PENDING': return endedView();
    case 'EXTENDED': return extendedView();
    default: return activeView();
  }
}

function render() {
  const markup = `${header()}<div class="ax-view" data-state="${esc(state?.state ?? (ui.gone ? 'GONE' : 'LOADING'))}">${view()}</div>`;
  if (markup === lastMarkup) return;
  const focused = document.activeElement?.dataset?.action ? `[data-action="${document.activeElement.dataset.action}"]${document.activeElement.dataset.minutes ? `[data-minutes="${document.activeElement.dataset.minutes}"]` : ''}` : null;
  const typed = root.querySelector('#ax-last-four')?.value ?? '';
  const sameView = lastMarkup && root.querySelector('.ax-view')?.dataset.state === (state?.state ?? '');
  lastMarkup = markup;
  root.innerHTML = markup;
  root.setAttribute('aria-busy', state || ui.gone ? 'false' : 'true');
  // Only a change of screen animates; in-place updates must not flicker.
  if (sameView) root.querySelector('.ax-view').style.animation = 'none';
  const input = root.querySelector('#ax-last-four');
  if (input && typed) input.value = typed;
  if (focused) root.querySelector(focused)?.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------- data */

function accept(next) {
  state = next;
  clockOffset = Number(next.serverNow) - Date.now();
  ui.offline = false;
  if (state.controls && ui.selected === null) ui.selected = state.controls.defaultMinutes;
  if (state.controls && ui.selected === 'END' && !state.controls.allowUntilEnd) ui.selected = state.controls.defaultMinutes;
  if (!state.extension?.pending) clearSubmitted();
  render();
  schedule();
  // The success screen is shown once, then gives way to the door controls.
  clearTimeout(extendedTimer);
  if (state.state === 'EXTENDED') {
    extendedTimer = setTimeout(() => { if (state?.state === 'EXTENDED' && !ui.busy) act('SEEN', '/api/access/extension/seen', {}); }, 6000);
  }
}

function pollDelay() {
  if (!state) return 4000;
  if (ui.busy || state.door?.pendingAction) return 1000;
  if (state.extension?.pending) return 3000;
  switch (state.state) {
    case 'ENDED': return 8000;
    case 'UPCOMING': return 15000;
    case 'CANCELLED': case 'ACCESS_REVOKED': return 30000;
    default: return 5000;
  }
}

/** Refresh on the usual cadence, and precisely when the server-side picture is due to change. */
function schedule() {
  clearTimeout(pollTimer);
  if (ui.gone || document.hidden) return;
  let delay = pollDelay();
  if (state) {
    const now = serverNow();
    const moments = [state.booking?.accessStartAt, state.booking?.endAt, state.door?.autoLockAt, state.extension?.pending?.holdExpiresAt];
    for (const moment of moments) {
      if (moment && moment > now) delay = Math.min(delay, moment - now + 400);
    }
  }
  pollTimer = setTimeout(refresh, Math.max(400, delay));
}

async function refresh() {
  if (ui.gone) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      accept(await api('/api/access/state'));
    } catch (error) {
      if (error.status === 404) { ui.gone = true; state = null; render(); return; }
      if (error.status === 429) { schedule(); return; }
      ui.offline = true;
      render();
      schedule();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function act(busy, path, body) {
  if (ui.busy) return;
  ui.busy = busy;
  ui.error = null;
  render();
  const payload = { ...body, idempotencyKey: newKey() };
  try {
    let result;
    try {
      result = await api(path, { method: 'POST', body: payload });
    } catch (error) {
      // One retry for a dropped connection; the idempotency key makes it safe.
      if (error.status) throw error;
      await new Promise((resolve) => setTimeout(resolve, 900));
      result = await api(path, { method: 'POST', body: payload });
    }
    ui.busy = null;
    if (result.command?.status === 'FAILED') ui.error = t('error.door');
    accept(result);
    return result;
  } catch (error) {
    ui.busy = null;
    if (error.status === 404) { ui.gone = true; state = null; render(); return null; }
    ui.error = error.status ? errorText(error) : t('error.connection');
    render();
    refresh();
    return null;
  }
}

/* ----------------------------------------------------------------- payment */

const SUBMIT_KEY = 'trace-access-ext-submitted';
function wasSubmittedRecently() {
  try { return Date.now() - Number(sessionStorage.getItem(SUBMIT_KEY) || 0) < 3 * 60_000; } catch { return false; }
}
function clearSubmitted() { try { sessionStorage.removeItem(SUBMIT_KEY); } catch { /* ignore */ } ui.showPayAgain = false; }

/** Hand the browser to PayHere's hosted checkout. The fields were signed by the server. */
function goToCheckout(checkout) {
  if (!checkout?.action || !checkout.fields) return;
  try { sessionStorage.setItem(SUBMIT_KEY, String(Date.now())); } catch { /* ignore */ }
  const form = document.createElement('form');
  form.method = 'post';
  form.action = checkout.action;
  form.referrerPolicy = 'no-referrer';
  form.hidden = true;
  for (const [name, value] of Object.entries(checkout.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden'; input.name = name; input.value = String(value);
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

/* ------------------------------------------------------------------ events */

root.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  if (action === 'select') {
    ui.selected = target.dataset.minutes === 'END' ? 'END' : Number(target.dataset.minutes);
    render();
  } else if (action === 'open') {
    await act('OPEN', '/api/access/door', { action: 'OPEN', minutes: ui.selected ?? state.controls.defaultMinutes });
  } else if (action === 'close') {
    await act('CLOSE', '/api/access/door', { action: 'CLOSE' });
  } else if (action === 'extend') {
    const method = target.dataset.method;
    const result = await act('EXTEND', '/api/access/extension', { method });
    const pending = result?.extension?.pending;
    if (pending?.method === 'PAYHERE' && pending.status === 'AWAITING_PAYMENT' && pending.checkout) goToCheckout(pending.checkout);
  } else if (action === 'pay') {
    goToCheckout(state.extension?.pending?.checkout);
  } else if (action === 'show-pay') {
    ui.showPayAgain = true; try { sessionStorage.removeItem(SUBMIT_KEY); } catch { /* ignore */ }
    lastMarkup = ''; render();
  } else if (action === 'ext-cancel') {
    clearSubmitted();
    await act('CANCEL', '/api/access/extension/cancel', {});
  } else if (action === 'ext-seen') {
    await act('SEEN', '/api/access/extension/seen', {});
  } else if (action === 'assist') {
    await act('ASSIST', '/api/access/assistance', { state: state?.state });
  }
});

root.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form="verify"]');
  if (!form) return;
  event.preventDefault();
  const lastFour = String(new FormData(form).get('lastFour') || '').replace(/\D/g, '');
  if (lastFour.length !== 4) { ui.error = t('error.verify'); render(); return; }
  await act('VERIFY', '/api/access/verify', { lastFour });
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else clearTimeout(pollTimer); });
window.addEventListener('online', refresh);
window.addEventListener('pageshow', (event) => { if (event.persisted) refresh(); });

render();
refresh();
