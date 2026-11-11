/**
 * Staff views for smart access: the live door & assistance console, the
 * policy/controller settings page, and the "Room access" card shown on a
 * reservation. Views receive plain data and never touch the database.
 */
import {
  csrfField, dateTimeLabel, emptyState, html, money, raw, timeLabel,
} from '../../lib/html.js';
import { adminShell, card, table } from '../layout.js';

const NOT_SET = '—';

function pill(text, tone = 'neutral') {
  return html`<span class="access-pill access-pill--${tone}">${text}</span>`;
}

function percentText(bps) {
  const value = Number(bps) || 0;
  return value % 100 === 0 ? String(value / 100) : (value / 100).toFixed(2).replace(/0$/, '');
}

function lkrInput(cents) {
  if (cents === null || cents === undefined) return '';
  const value = Number(cents);
  return value % 100 === 0 ? String(value / 100) : (value / 100).toFixed(2);
}

/* ------------------------------------------------------------ door status */

const DOOR_REASON_LABEL = Object.freeze({
  CUSTOMER_REQUEST: 'Customer', STAFF_OVERRIDE: 'Staff', AUTO_LOCK: 'Automatic lock', BOOKING_CANCELLED: 'Booking cancelled',
  ACCESS_REVOKED: 'Access revoked', BOOKING_CHANGED: 'Booking changed', DEADLINE_EXTENDED: 'Booking extended',
});
const COMMAND_STATUS = Object.freeze({
  PENDING: ['Waiting', 'warn'], SENDING: ['Sending', 'warn'], ACKNOWLEDGED: ['Sent, unconfirmed', 'warn'],
  CONFIRMED: ['Confirmed', 'ok'], FAILED: ['Failed', 'danger'],
});

/** AdminDoorStatus: what the controller last confirmed, never an assumption. */
export function doorStatePill(door) {
  if (!door.ready) return pill('Not set up', 'neutral');
  if (door.snapshot.pending) return pill(door.snapshot.pending.action === 'OPEN' ? 'Unlocking…' : 'Locking…', 'warn');
  if (!door.snapshot.controllerOnline) return pill('Controller offline', 'danger');
  if (door.snapshot.reportedState === 'UNLOCKED') return pill('Unlocked', 'ok');
  if (door.snapshot.reportedState === 'LOCKED') return pill('Locked', 'neutral');
  return pill('Unconfirmed', 'warn');
}

function doorRow(door, csrfToken) {
  const { space, snapshot, current } = door;
  const deadline = snapshot.autoLockAt
    ? html`${timeLabel(snapshot.autoLockAt)}${snapshot.overdue ? html` ${pill('Overdue', 'danger')}` : ''}`
    : NOT_SET;
  const booking = current
    ? html`<a href="/admin/reservations/${current.id}">${current.reference}</a><span class="hint"> · ${current.customerName} · until ${timeLabel(current.endAt)}</span>`
    : html`<span class="hint">No active booking</span>`;
  const actions = door.ready
    ? html`<div class="cluster">
        <form method="post" action="/admin/access/doors/${space.id}/command" class="inline-form">
          ${csrfField(csrfToken)}<input type="hidden" name="action" value="OPEN">
          <label class="visually-hidden" for="door-minutes-${space.id}">Unlock ${space.code} for</label>
          <select id="door-minutes-${space.id}" name="minutes">
            <option value="5">5 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">60 min</option>
          </select>
          <button class="button button--ghost button--small" type="submit">Unlock</button>
        </form>
        <form method="post" action="/admin/access/doors/${space.id}/command" class="inline-form">
          ${csrfField(csrfToken)}<input type="hidden" name="action" value="CLOSE">
          <button class="button button--primary button--small" type="submit">Lock now</button>
        </form>
      </div>`
    : html`<span class="hint">Configure a controller in settings</span>`;
  return {
    cells: [
      html`<strong>${space.code}</strong><span class="hint"> · ${space.name}</span>`,
      html`${doorStatePill(door)}${snapshot.reportedAt ? html`<span class="hint"> · ${timeLabel(snapshot.reportedAt)}</span>` : ''}
        ${snapshot.lastError && (!snapshot.controllerOnline || snapshot.overdue) ? html`<br><span class="hint">${snapshot.lastError}</span>` : ''}`,
      deadline,
      booking,
      actions,
    ],
  };
}

/** DoorActivityLog */
export function doorActivityTable(activity, { showSpace = true } = {}) {
  const columns = [{ label: 'When' }, ...(showSpace ? [{ label: 'Room' }] : []), { label: 'Action' }, { label: 'By' }, { label: 'Result' }, ...(showSpace ? [{ label: 'Booking' }] : [])];
  const rows = activity.map((item) => {
    const [label, tone] = COMMAND_STATUS[item.status] ?? [item.status, 'neutral'];
    const by = item.actorType === 'STAFF' ? (item.actorName ?? 'Staff') : (DOOR_REASON_LABEL[item.reason] ?? item.reason);
    return {
      cells: [
        dateTimeLabel(item.createdAt),
        ...(showSpace ? [item.spaceCode ?? NOT_SET] : []),
        html`${item.action === 'OPEN' ? 'Unlock' : 'Lock'}${item.action === 'OPEN' && item.autoLockAt ? html`<span class="hint"> · until ${timeLabel(item.autoLockAt)}</span>` : ''}`,
        by,
        html`${pill(label, tone)}${item.attempts > 1 ? html`<span class="hint"> · ${item.attempts} attempts</span>` : ''}${item.lastError && item.status === 'FAILED' ? html`<br><span class="hint">${item.lastError}</span>` : ''}`,
        ...(showSpace ? [item.reservationReference && item.reservationId ? html`<a href="/admin/reservations/${item.reservationId}">${item.reservationReference}</a>` : NOT_SET] : []),
      ],
    };
  });
  return table({ columns, rows, emptyMessage: 'No door activity yet.', label: 'Door activity' });
}

/* ------------------------------------------------------------- assistance */

/** StaffAssistanceNotification */
function assistanceCard(item, csrfToken) {
  const waiting = item.status === 'OPEN';
  return html`<div class="access-request ${waiting ? 'access-request--open' : ''}">
    <div class="access-request__head">
      <div>
        <strong>${item.spaceName}</strong> <span class="hint">(${item.spaceCode})</span>
        <div class="hint">${item.customerName}${item.customerPhone ? html` · ${item.customerPhone}` : ''} ·
          <a href="/admin/reservations/${item.reservationId}">${item.reservationReference}</a></div>
      </div>
      ${waiting ? pill('Waiting', 'danger') : pill(`Picked up by ${item.acknowledgedByName ?? 'staff'}`, 'warn')}
    </div>
    <p class="hint">Requested ${dateTimeLabel(item.createdAt)}${item.endAt ? html` · booking ends ${timeLabel(item.endAt)}` : ''}</p>
    <div class="cluster">
      ${waiting ? html`<form method="post" action="/admin/access/assistance/${item.id}/acknowledge" class="inline-form">
        ${csrfField(csrfToken)}<button class="button button--primary button--small" type="submit">I'm on my way</button>
      </form>` : ''}
      <form method="post" action="/admin/access/assistance/${item.id}/resolve" class="inline-form">
        ${csrfField(csrfToken)}
        <label class="visually-hidden" for="assist-note-${item.id}">Resolution note</label>
        <input id="assist-note-${item.id}" name="note" type="text" maxlength="500" placeholder="Note (optional)">
        <button class="button button--ghost button--small" type="submit">Mark resolved</button>
      </form>
    </div>
  </div>`;
}

/* ------------------------------------------------------------- extensions */

const EXTENSION_STATUS = Object.freeze({
  AWAITING_APPROVAL: ['Needs approval', 'warn'], AWAITING_PAYMENT: ['Awaiting payment', 'warn'], PAYMENT_PENDING: ['Payment pending', 'warn'],
  CONFIRMED: ['Confirmed', 'ok'], FAILED: ['Payment failed', 'danger'], EXPIRED: ['Expired', 'neutral'], CANCELLED: ['Cancelled', 'neutral'],
  REJECTED: ['Declined', 'neutral'], REVIEW_REQUIRED: ['Payment review', 'danger'], RESOLVED: ['Resolved', 'neutral'],
});
const METHOD_LABEL = Object.freeze({ PAYHERE: 'PayHere', DESK: 'Front desk', COMPLIMENTARY: 'Complimentary' });

export function extensionStatusPill(status) {
  const [label, tone] = EXTENSION_STATUS[status] ?? [status, 'neutral'];
  return pill(label, tone);
}

function extensionAttentionCard(item, csrfToken) {
  const head = html`<div class="access-request__head">
      <div>
        <strong>${item.spaceName}</strong> <span class="hint">(${item.spaceCode})</span>
        <div class="hint">${item.customerName} · <a href="/admin/reservations/${item.reservationId}">${item.reservationReference}</a> ·
          +${item.minutes} min to ${timeLabel(item.newEndAt)} · ${money(item.amountCents, item.currency)} · ${METHOD_LABEL[item.method] ?? item.method}</div>
      </div>
      ${extensionStatusPill(item.status)}
    </div>`;
  let actions;
  if (item.status === 'AWAITING_APPROVAL') {
    actions = html`<div class="cluster">
      <form method="post" action="/admin/access/extensions/${item.id}/approve" class="inline-form">${csrfField(csrfToken)}<button class="button button--primary button--small" type="submit">Approve</button></form>
      <form method="post" action="/admin/access/extensions/${item.id}/reject" class="inline-form">${csrfField(csrfToken)}<button class="button button--ghost button--small" type="submit">Decline</button></form>
    </div>`;
  } else if (item.status === 'REVIEW_REQUIRED') {
    actions = html`<p class="hint"><strong>Why:</strong> ${item.reviewReason ?? 'See the payment record.'}
        ${item.providerPaymentId ? html` · PayHere payment <code>${item.providerPaymentId}</code>` : ''}${item.orderId ? html` · order <code>${item.orderId}</code>` : ''}</p>
      <form method="post" action="/admin/access/extensions/${item.id}/resolve" class="form-grid">
        ${csrfField(csrfToken)}
        <div class="form-field">
          <label for="ext-outcome-${item.id}">Outcome</label>
          <select id="ext-outcome-${item.id}" name="outcome" required>
            <option value="REFUND_RECORDED">Refunded in PayHere (record it)</option>
            <option value="TIME_GRANTED">Add the 15 minutes now</option>
            <option value="PAYMENT_KEPT">Payment kept (agreed with customer)</option>
          </select>
        </div>
        <div class="form-field">
          <label for="ext-note-${item.id}">Note (required)</label>
          <input id="ext-note-${item.id}" name="note" type="text" maxlength="1000" required>
        </div>
        <div class="form-actions"><button class="button button--primary button--small" type="submit">Resolve</button></div>
      </form>
      <p class="hint">A refund is always made in the PayHere merchant portal. This form only records what was done.</p>`;
  } else {
    actions = html`<div class="cluster">
      <form method="post" action="/admin/access/extensions/${item.id}/desk-paid" class="inline-form"
            data-confirm="Confirm that ${money(item.amountCents, item.currency)} was received at the desk for ${item.reservationReference}?">
        ${csrfField(csrfToken)}<button class="button button--primary button--small" type="submit">Payment received · add time</button></form>
      <form method="post" action="/admin/access/extensions/${item.id}/reject" class="inline-form">${csrfField(csrfToken)}<button class="button button--ghost button--small" type="submit">Decline</button></form>
    </div>`;
  }
  return html`<div class="access-request ${item.status === 'REVIEW_REQUIRED' ? 'access-request--open' : ''}">${head}${actions}</div>`;
}

export function extensionHistoryTable(extensions, { showBooking = true } = {}) {
  const columns = [{ label: 'When' }, ...(showBooking ? [{ label: 'Booking' }] : []), { label: 'Added' }, { label: 'Amount', align: 'right' }, { label: 'Method' }, { label: 'Status' }];
  const rows = extensions.map((item) => ({
    cells: [
      dateTimeLabel(item.createdAt),
      ...(showBooking ? [html`<a href="/admin/reservations/${item.reservationId}">${item.reservationReference}</a><span class="hint"> · ${item.spaceCode}</span>`] : []),
      html`+${item.minutes} min<span class="hint"> · to ${timeLabel(item.newEndAt)}</span>`,
      money(item.amountCents, item.currency),
      METHOD_LABEL[item.method] ?? item.method,
      html`${extensionStatusPill(item.status)}${item.resolution ? html`<span class="hint"> · ${item.resolution.replace(/_/g, ' ').toLowerCase()}</span>` : ''}`,
    ],
  }));
  return table({ columns, rows, emptyMessage: 'No extensions yet.', label: 'Session extensions' });
}

/* ---------------------------------------------------------------- console */

export function renderAccessConsolePage({
  actor, csrfToken, flash = null, assistance = [], attention = [], doors = [], activity = [], recentExtensions = [], isAdmin = false, health = {},
}) {
  const warnings = [];
  if (!health.controllerSecret && doors.some((d) => d.config.driver === 'HTTP')) warnings.push('DOOR_CONTROLLER_SECRET is not set, so door commands cannot be signed or sent.');
  if (!health.scheduler) warnings.push('No scheduler secret (CRON_SECRET) is set. On a serverless deployment, automatic locking depends on the scheduler calling /api/internal/access/tick every minute.');

  const body = html`<div class="stack" data-access-live>
    ${warnings.length ? html`<div class="alert alert--warning" role="status"><ul>${warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
    <div data-live-region="assistance">
    ${card({
    title: `Staff assistance${assistance.length ? ` · ${assistance.length}` : ''}`,
    description: 'Customers who tapped "Get Staff Assistance" on their access page.',
    body: assistance.length
      ? html`<div class="stack">${assistance.map((item) => assistanceCard(item, csrfToken))}</div>`
      : emptyState('Nobody is waiting for assistance.'),
  })}
    </div>
    <div data-live-region="extensions">
    ${attention.length ? card({
    title: `Extensions needing attention · ${attention.length}`,
    description: 'Approvals, front-desk payments and payments that could not be applied.',
    body: html`<div class="stack">${attention.map((item) => extensionAttentionCard(item, csrfToken))}</div>`,
  }) : ''}
    </div>
    <div data-live-region="doors">
    ${card({
    title: 'Doors',
    description: 'State is what the controller last confirmed. Every unlock carries an automatic lock time.',
    actions: isAdmin ? html`<a class="button button--ghost button--small" href="/admin/access/settings">Settings</a>` : null,
    body: doors.length
      ? table({
        columns: [{ label: 'Room' }, { label: 'Door' }, { label: 'Locks at' }, { label: 'Current booking' }, { label: 'Staff override' }],
        rows: doors.map((door) => doorRow(door, csrfToken)),
        label: 'Door status',
      })
      : emptyState('No room has door access set up yet.', isAdmin ? 'Open Settings to connect a door controller to a room.' : null),
  })}
    </div>
    <div data-live-region="activity">
    ${card({ title: 'Door activity', description: 'The last 40 lock and unlock commands, newest first.', body: doorActivityTable(activity) })}
    </div>
    ${card({ title: 'Recent extensions', body: extensionHistoryTable(recentExtensions) })}
  </div>`;

  return adminShell({
    title: 'Door access',
    subtitle: 'Live door state, staff assistance and session extensions',
    actor, csrfToken, flash,
    activePath: '/admin/access',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Door access' }],
    extraStyles: ['/assets/admin-access.css'],
    extraScripts: ['/assets/admin-access.js'],
    body,
  });
}

/* --------------------------------------------------------------- settings */

function check({ name, label, checked, hint = null }) {
  return html`<div class="form-field form-field--checkbox">
    <label><input type="checkbox" name="${name}" value="1"${raw(checked ? ' checked' : '')}> ${label}</label>
    ${hint ? html`<p class="hint">${hint}</p>` : ''}
  </div>`;
}

function number({ name, label, value, min, max, hint = null, suffix = '' }) {
  return html`<div class="form-field">
    <label for="policy-${name}">${label}${suffix ? html` <span class="hint">(${suffix})</span>` : ''}</label>
    <input id="policy-${name}" name="${name}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${value}" required>
    ${hint ? html`<p class="hint">${hint}</p>` : ''}
  </div>`;
}

function tri({ id, name, label, value }) {
  const current = value === null ? 'inherit' : value ? '1' : '0';
  const option = (v, text) => html`<option value="${v}"${raw(current === v ? ' selected' : '')}>${text}</option>`;
  return html`<div class="form-field">
    <label for="${id}">${label}</label>
    <select id="${id}" name="${name}">${option('inherit', 'Use the general setting')}${option('1', 'Yes')}${option('0', 'No')}</select>
  </div>`;
}

function spaceConfigCard({ space, config, hourlyCents }, csrfToken, health) {
  const driverOption = (value, text, disabled = false) => html`<option value="${value}"${raw(config.driver === value ? ' selected' : '')}${raw(disabled ? ' disabled' : '')}>${text}</option>`;
  return card({
    title: `${space.code} — ${space.name}`,
    description: hourlyCents === null && config.extensionBaseCents === null
      ? 'No hourly, half-day or day rate: enter a 15-minute base price to allow extensions.'
      : hourlyCents !== null ? `Hourly rate used for extensions: ${money(hourlyCents, space.currency)}` : null,
    actions: config.doorEnabled ? pill('Door control on', 'ok') : pill('Door control off', 'neutral'),
    body: html`<form method="post" action="/admin/access/settings/spaces/${space.id}">
      ${csrfField(csrfToken)}
      <div class="form-grid">
        <div class="form-field">
          <label for="driver-${space.id}">Door controller</label>
          <select id="driver-${space.id}" name="driver">
            ${driverOption('NONE', 'None')}
            ${driverOption('HTTP', 'HTTP controller / bridge')}
            ${driverOption('SIMULATED', health.simulator ? 'Simulator (no real door)' : 'Simulator (disabled here)', !health.simulator && config.driver !== 'SIMULATED')}
          </select>
        </div>
        <div class="form-field">
          <label for="endpoint-${space.id}">Controller URL</label>
          <input id="endpoint-${space.id}" name="endpoint_url" type="url" maxlength="500" placeholder="https://controller.example/doors/command" value="${config.endpointUrl ?? ''}">
        </div>
        <div class="form-field">
          <label for="door-id-${space.id}">Door identifier</label>
          <input id="door-id-${space.id}" name="door_identifier" type="text" maxlength="80" placeholder="${space.code}" value="${config.doorIdentifier ?? ''}">
          <p class="hint">The name the controller uses for this door.</p>
        </div>
        ${tri({ id: `links-${space.id}`, name: 'links_enabled', label: 'Send access links', value: config.linksEnabled })}
        ${tri({ id: `until-${space.id}`, name: 'allow_until_end', label: '"Keep unlocked until booking ends"', value: config.allowUntilEnd })}
        ${tri({ id: `ext-${space.id}`, name: 'extensions_enabled', label: 'Paid extensions', value: config.extensionsEnabled })}
        <div class="form-field">
          <label for="surcharge-${space.id}">Surcharge override <span class="hint">(%)</span></label>
          <input id="surcharge-${space.id}" name="surcharge_percent" type="text" inputmode="decimal" maxlength="6" placeholder="General setting" value="${config.surchargeBps === null ? '' : percentText(config.surchargeBps)}">
        </div>
        <div class="form-field">
          <label for="base-${space.id}">15-minute base price <span class="hint">(LKR, optional)</span></label>
          <input id="base-${space.id}" name="extension_base_lkr" type="text" inputmode="decimal" maxlength="12" placeholder="Hourly rate ÷ 4" value="${lkrInput(config.extensionBaseCents)}">
        </div>
      </div>
      ${check({ name: 'door_enabled', label: 'Enable door control for this room', checked: config.doorEnabled })}
      ${check({ name: 'confirms_state', label: 'This controller confirms the lock state', checked: config.confirmsState, hint: 'Leave on when the controller answers with "LOCKED"/"UNLOCKED". When off, the page says "sent" instead of claiming a state.' })}
      <div class="form-actions"><button class="button button--primary button--small" type="submit">Save ${space.code}</button></div>
    </form>`,
  });
}

export function renderAccessSettingsPage({ actor, csrfToken, flash = null, policy, spaces = [], health = {} }) {
  const status = (ok, yes, no) => (ok ? pill(yes, 'ok') : pill(no, 'warn'));
  const healthCard = card({
    title: 'Connections',
    description: 'Set through environment variables; shown here so a missing one is obvious.',
    body: html`<dl class="detail-list">
      <dt>Email</dt><dd>${status(health.mail, 'Configured', 'Not configured — links are not emailed')}</dd>
      <dt>SMS</dt><dd>${status(health.sms, `Configured (${health.smsProvider})`, 'Not configured — links are not sent by SMS')}</dd>
      <dt>PayHere</dt><dd>${status(health.payHere, health.payHereSandbox ? 'Configured (sandbox)' : 'Configured (live)', 'Not configured — online extension payments are off')}</dd>
      <dt>Door controller secret</dt><dd>${status(health.controllerSecret, 'Configured', 'DOOR_CONTROLLER_SECRET is not set')}</dd>
      <dt>Scheduler</dt><dd>${status(health.scheduler, 'CRON_SECRET set', 'CRON_SECRET not set')}
        <span class="hint"> · call <code>/api/internal/access/tick</code> every minute on serverless hosting</span></dd>
    </dl>`,
  });

  const policyCard = card({
    title: 'Access links and door control',
    body: html`<form method="post" action="/admin/access/settings/policy">
      ${csrfField(csrfToken)}
      ${check({ name: 'links_enabled', label: 'Send an access link when a booking is confirmed', checked: policy.linksEnabled })}
      ${check({ name: 'allow_until_end', label: 'Allow "Keep unlocked until booking ends"', checked: policy.allowUntilEnd, hint: 'The door still locks automatically at the end of the booking.' })}
      ${check({ name: 'require_phone_check', label: 'Ask for the last 4 digits of the booking phone number', checked: policy.requirePhoneCheck, hint: 'An extra check before door controls appear. Skipped for bookings without a phone number.' })}
      <div class="form-grid">
        ${number({ name: 'early_access_minutes', label: 'Early access', suffix: 'minutes', value: policy.earlyAccessMinutes, min: 0, max: 120, hint: 'How long before the start time the door can be unlocked.' })}
        <div class="form-field">
          <label for="policy-default_unlock_minutes">Default unlock duration</label>
          <select id="policy-default_unlock_minutes" name="default_unlock_minutes">
            ${[5, 15, 30].map((m) => html`<option value="${m}"${raw(policy.defaultUnlockMinutes === m ? ' selected' : '')}>${m} minutes</option>`)}
          </select>
        </div>
        ${number({ name: 'link_retention_hours', label: 'Keep the link working after the booking', suffix: 'hours', value: Math.max(1, Math.round(policy.linkRetentionMinutes / 60)), min: 1, max: 720, hint: 'For extensions and staff assistance. Door controls always stop at the end of the booking.' })}
      </div>
      <h3 class="card__title">Paid extensions</h3>
      ${check({ name: 'extensions_enabled', label: 'Offer 15-minute extensions', checked: policy.extensionsEnabled })}
      ${check({ name: 'require_approval', label: 'Staff must approve each extension before payment', checked: policy.requireApproval })}
      ${check({ name: 'pay_online_enabled', label: 'Accept online payment (PayHere)', checked: policy.payOnlineEnabled })}
      ${check({ name: 'pay_desk_enabled', label: 'Accept payment at the front desk', checked: policy.payDeskEnabled, hint: 'Staff confirm the payment here before the time is added.' })}
      <div class="form-grid">
        <div class="form-field">
          <label for="policy-surcharge_percent">Surcharge <span class="hint">(%)</span></label>
          <input id="policy-surcharge_percent" name="surcharge_percent" type="text" inputmode="decimal" maxlength="6" value="${percentText(policy.surchargeBps)}" required>
          <p class="hint">Price = hourly rate ÷ 4 × (1 + surcharge).</p>
        </div>
        ${number({ name: 'max_extensions', label: 'Maximum extensions per booking', value: policy.maxExtensions, min: 0, max: 48 })}
        ${number({ name: 'max_extension_minutes', label: 'Maximum added time per booking', suffix: 'minutes', value: policy.maxExtensionMinutes, min: 0, max: 720 })}
        <div class="form-field">
          <label for="policy-min_payment_lkr">Minimum payment <span class="hint">(LKR)</span></label>
          <input id="policy-min_payment_lkr" name="min_payment_lkr" type="text" inputmode="decimal" maxlength="12" value="${lkrInput(policy.minPaymentCents)}" required>
        </div>
        ${number({ name: 'offer_before_end_minutes', label: 'Offer extensions before the end', suffix: 'minutes', value: policy.offerBeforeEndMinutes, min: 0, max: 120 })}
        ${number({ name: 'late_window_minutes', label: 'Offer extensions after the end', suffix: 'minutes', value: policy.lateWindowMinutes, min: 0, max: 720 })}
        ${number({ name: 'payment_hold_minutes', label: 'Hold the room while paying', suffix: 'minutes', value: policy.paymentHoldMinutes, min: 3, max: 60 })}
        ${number({ name: 'late_grace_minutes', label: 'Late-payment tolerance', suffix: 'minutes', value: policy.lateGraceMinutes, min: 0, max: 14, hint: 'If the room is not free for a full 15 minutes after a late payment, the time is still added when no more than this many minutes were lost. Otherwise the payment goes to review for a refund.' })}
      </div>
      <div class="form-actions"><button class="button button--primary" type="submit">Save policy</button></div>
    </form>`,
  });

  const body = html`<div class="stack">
    ${healthCard}
    ${policyCard}
    <h2 class="section-title">Rooms</h2>
    ${spaces.length ? spaces.map((entry) => spaceConfigCard(entry, csrfToken, health)) : emptyState('No spaces yet.')}
  </div>`;

  return adminShell({
    title: 'Door access settings',
    subtitle: 'Access links, door controllers and extension pricing',
    actor, csrfToken, flash,
    activePath: '/admin/access',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Door access', href: '/admin/access' }, { label: 'Settings' }],
    extraStyles: ['/assets/admin-access.css'],
    body,
  });
}

/* ------------------------------------------------ reservation detail card */

const DELIVERY_LABEL = Object.freeze({
  PENDING: ['Sending', 'warn'], SENT: ['Sent', 'ok'], FAILED: ['Failed', 'danger'],
  NOT_CONFIGURED: ['Not configured', 'neutral'], NO_ADDRESS: ['No address on file', 'neutral'],
});

function delivery(status, error) {
  const [label, tone] = DELIVERY_LABEL[status] ?? [status, 'neutral'];
  return html`${pill(label, tone)}${error && status === 'FAILED' ? html`<span class="hint"> · ${error}</span>` : ''}`;
}

/**
 * "Room access" card for the reservation page: link status and delivery, door
 * permission, extensions and the staff actions that go with them.
 */
export function reservationAccessCard({ reservation, link, extensions = [], doorActivity = [], doorReady = false, csrfToken }) {
  const cancelled = reservation.status === 'CANCELLED';
  const base = `/admin/reservations/${reservation.id}/access`;
  const post = (path, label, { style = 'ghost', confirm = null, method = null } = {}) => {
    const inner = html`${csrfField(csrfToken)}${method ? html`<input type="hidden" name="method" value="${method}">` : ''}<button class="button button--${style} button--small" type="submit">${label}</button>`;
    return confirm
      ? html`<form method="post" action="${base}/${path}" class="inline-form" data-confirm="${confirm}">${inner}</form>`
      : html`<form method="post" action="${base}/${path}" class="inline-form">${inner}</form>`;
  };

  let summary;
  let actions;
  if (!link) {
    summary = html`<p class="hint">No access link has been issued for this booking.</p>`;
    actions = cancelled ? '' : post('issue', 'Issue and send access link', { style: 'primary' });
  } else {
    const revokedLink = link.status !== 'ACTIVE';
    const revokedDoor = link.doorAccessRevokedAt !== null;
    summary = html`<dl class="detail-list">
      <dt>Link</dt><dd>${revokedLink ? pill('Revoked', 'danger') : pill('Active', 'ok')}
        <span class="hint"> · issued ${dateTimeLabel(link.createdAt)}${link.openCount ? html` · opened ${link.openCount}× (last ${dateTimeLabel(link.lastOpenedAt)})` : ' · not opened yet'}</span></dd>
      <dt>Email</dt><dd>${delivery(link.emailStatus, link.emailError)}</dd>
      <dt>SMS</dt><dd>${delivery(link.smsStatus, link.smsError)}</dd>
      <dt>Door control</dt><dd>${!doorReady ? pill('No door controller for this room', 'neutral')
    : revokedDoor ? html`${pill('Turned off by staff', 'danger')}${link.revokeReason ? html`<span class="hint"> · ${link.revokeReason}</span>` : ''}`
      : pill('Allowed during the booking', 'ok')}</dd>
    </dl>`;
    actions = cancelled ? '' : html`<div class="cluster">
      ${post('reissue', 'Send a new link', { confirm: 'Send a new access link? The current link stops working immediately.' })}
      ${revokedDoor ? post('restore-door', 'Restore door access') : post('revoke-door', 'Turn off door access', { confirm: 'Turn off door control for this booking? If the door is unlocked it is locked now.' })}
      ${revokedLink ? '' : post('revoke-link', 'Revoke link', { confirm: 'Revoke this link? The customer page stops loading. Use "Send a new link" to replace it.' })}
    </div>`;
  }

  const extend = cancelled ? '' : html`<div class="cluster">
    ${post('extend', 'Add 15 min · paid at desk', { method: 'DESK', confirm: 'Add 15 minutes and record a front-desk payment?' })}
    ${post('extend', 'Add 15 min · complimentary', { method: 'COMPLIMENTARY', confirm: 'Add 15 complimentary minutes to this booking?' })}
  </div>`;

  return card({
    title: 'Room access',
    description: 'The customer\'s access link, door permission and session extensions.',
    body: html`<div class="stack">
      ${summary}
      ${actions}
      <h3 class="card__title">Extensions</h3>
      ${extensions.length ? extensionHistoryTable(extensions, { showBooking: false }) : html`<p class="hint">No extensions for this booking.</p>`}
      ${extend}
      ${doorActivity.length ? html`<h3 class="card__title">Door activity</h3>${doorActivityTable(doorActivity, { showSpace: false })}` : ''}
    </div>`,
  });
}
