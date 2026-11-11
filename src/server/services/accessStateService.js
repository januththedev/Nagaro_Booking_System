/**
 * The customer page's view of a booking, computed on the server from the
 * booking, the door and the clock. The browser renders this and nothing else:
 * it never works out for itself whether a door may be opened.
 *
 * States
 *   UPCOMING            the access window has not started
 *   ACTIVE_LOCKED       active, controller confirmed locked
 *   ACTIVE_UNLOCKED     active, controller confirmed unlocked
 *   ACTIVE_PENDING      a command was sent and its outcome is not known yet
 *   ACTIVE_UNKNOWN      active, but the physical state is not confirmed
 *   CONTROLLER_OFFLINE  active, but the door cannot take commands right now
 *   ENDED               booking over; door controls gone
 *   EXTENSION_PENDING   an extension is awaiting approval or payment
 *   EXTENDED            an extension was just applied (shown once)
 *   CANCELLED           booking cancelled, access revoked
 *   ACCESS_REVOKED      staff turned off door control for this booking
 */
import { UNLOCK_MINUTE_OPTIONS } from './accessPolicyService.js';
import { getDoorSnapshot } from './doorService.js';
import { currentExtension, extensionCheckout, quoteExtension } from './extensionService.js';
import { latestAssistance } from './assistanceService.js';
import { accessDateLabel, accessTimeLabel } from '../mail/accessTemplates.js';

const MINUTE = 60_000;
export const ACCESS_STATE = Object.freeze({
  UPCOMING: 'UPCOMING', ACTIVE_LOCKED: 'ACTIVE_LOCKED', ACTIVE_UNLOCKED: 'ACTIVE_UNLOCKED', ACTIVE_PENDING: 'ACTIVE_PENDING',
  ACTIVE_UNKNOWN: 'ACTIVE_UNKNOWN', CONTROLLER_OFFLINE: 'CONTROLLER_OFFLINE', ENDED: 'ENDED', EXTENSION_PENDING: 'EXTENSION_PENDING',
  EXTENDED: 'EXTENDED', CANCELLED: 'CANCELLED', ACCESS_REVOKED: 'ACCESS_REVOKED',
});

function extensionView(db, { access, payHere, now, active }) {
  const quote = quoteExtension(db, { reservation: access.reservation, config: access.config, link: access.link, payHere, now });
  const current = currentExtension(db, access.reservation.id);
  const live = current && ['AWAITING_APPROVAL', 'AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(current.status) ? current : null;
  const recent = current && !live && current.seenAt === null && now - current.updatedAt < 30 * MINUTE ? current : null;
  const view = {
    offered: quote.offered || Boolean(live),
    available: quote.available,
    reason: quote.reason,
    message: quote.message,
    minutes: quote.minutes,
    amountCents: live?.amountCents ?? quote.amountCents ?? null,
    currency: live?.currency ?? quote.currency ?? 'LKR',
    surchargeBps: live?.surchargeBps ?? quote.surchargeBps ?? null,
    newEndAt: live?.newEndAt ?? quote.newEndAt ?? null,
    newEndLabel: (live?.newEndAt ?? quote.newEndAt) ? accessTimeLabel(live?.newEndAt ?? quote.newEndAt) : null,
    methods: quote.methods ?? [],
    requiresApproval: Boolean(quote.requiresApproval),
    pending: null,
    notice: null,
    beforeEnd: active,
  };
  if (live) {
    view.pending = {
      status: live.status, method: live.method, holdExpiresAt: live.holdExpiresAt,
      checkout: live.status === 'AWAITING_PAYMENT' || live.status === 'PAYMENT_PENDING' ? extensionCheckout(db, { extensionId: live.id, payHere, now }) : null,
    };
  } else if (recent) {
    if (recent.status === 'CONFIRMED') view.notice = { kind: 'EXTENDED', minutes: recent.minutes, newEndLabel: accessTimeLabel(recent.newEndAt) };
    else if (recent.status === 'FAILED') view.notice = { kind: 'PAYMENT_FAILED' };
    else if (recent.status === 'REVIEW_REQUIRED') view.notice = { kind: 'PAYMENT_REVIEW' };
    else if (recent.status === 'REJECTED') view.notice = { kind: 'REJECTED' };
    else if (recent.status === 'EXPIRED') view.notice = { kind: 'EXPIRED' };
  }
  return view;
}

/**
 * @param {object} access       result of accessLinkService.resolveAccess
 * @param {boolean} verified    the device passed the optional phone check
 */
export function buildAccessState(db, { access, payHere = null, verified = true, now = Date.now() } = {}) {
  const { reservation, config, link } = access;
  const startAt = Number(reservation.start_at);
  const endAt = Number(reservation.end_at);
  const accessStartAt = startAt - config.policy.earlyAccessMinutes * MINUTE;

  const booking = {
    reference: reservation.reference,
    spaceName: reservation.space_name,
    startAt, endAt, accessStartAt,
    dateLabel: accessDateLabel(startAt),
    startLabel: accessTimeLabel(startAt),
    endLabel: accessTimeLabel(endAt),
  };
  const base = { ok: true, serverNow: now, booking, verificationRequired: !verified };
  if (!verified) return { ...base, state: 'VERIFY' };

  const assistanceRow = latestAssistance(db, reservation.id);
  const assistance = assistanceRow && (assistanceRow.status !== 'RESOLVED' || now - (assistanceRow.resolvedAt ?? 0) < 10 * MINUTE)
    ? { status: assistanceRow.status, requestedAt: assistanceRow.createdAt } : null;

  if (reservation.status === 'CANCELLED') {
    return { ...base, state: ACCESS_STATE.CANCELLED, door: null, controls: null, extension: { offered: false }, assistance };
  }

  const active = now >= accessStartAt && now < endAt && reservation.status === 'CONFIRMED';
  const extension = extensionView(db, { access, payHere, now, active });
  const revoked = link.doorAccessRevokedAt !== null;

  if (revoked) return { ...base, state: ACCESS_STATE.ACCESS_REVOKED, door: null, controls: null, extension: { offered: false }, assistance };
  if (now < accessStartAt) return { ...base, state: ACCESS_STATE.UPCOMING, door: null, controls: null, extension: { offered: false }, assistance };

  if (!active) {
    const state = extension.pending ? ACCESS_STATE.EXTENSION_PENDING : ACCESS_STATE.ENDED;
    return { ...base, state, door: null, controls: null, extension, assistance };
  }

  // Active booking.
  const snapshot = getDoorSnapshot(db, reservation.space_id, { now });
  const mine = snapshot.unlockedReservationId === Number(reservation.id);
  const door = {
    available: config.doorReady,
    state: snapshot.reportedState,
    pendingAction: snapshot.pending?.action ?? null,
    lastAction: snapshot.latest && ['ACKNOWLEDGED', 'FAILED'].includes(snapshot.latest.status) && now - snapshot.latest.updatedAt < 2 * MINUTE
      ? { action: snapshot.latest.action, status: snapshot.latest.status } : null,
    autoLockAt: mine && snapshot.autoLockAt && snapshot.autoLockAt > now ? snapshot.autoLockAt : null,
    autoLockLabel: mine && snapshot.autoLockAt && snapshot.autoLockAt > now ? accessTimeLabel(snapshot.autoLockAt) : null,
    untilEnd: mine && snapshot.autoLockMode === 'UNTIL_END',
  };
  const controls = {
    durations: UNLOCK_MINUTE_OPTIONS,
    defaultMinutes: config.policy.defaultUnlockMinutes,
    allowUntilEnd: config.allowUntilEnd,
  };

  let state;
  if (!config.doorReady) state = ACCESS_STATE.CONTROLLER_OFFLINE;
  else if (snapshot.pending) state = ACCESS_STATE.ACTIVE_PENDING;
  else if (!snapshot.controllerOnline) state = ACCESS_STATE.CONTROLLER_OFFLINE;
  else if (snapshot.reportedState === 'UNLOCKED') state = ACCESS_STATE.ACTIVE_UNLOCKED;
  else if (snapshot.reportedState === 'LOCKED') state = ACCESS_STATE.ACTIVE_LOCKED;
  else state = ACCESS_STATE.ACTIVE_UNKNOWN;

  if (extension.notice?.kind === 'EXTENDED') {
    return { ...base, state: ACCESS_STATE.EXTENDED, activeState: state, door, controls, extension, assistance };
  }
  return { ...base, state, door, controls, extension, assistance };
}
