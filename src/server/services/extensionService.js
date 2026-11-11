/**
 * Paid 15-minute session extensions.
 *
 * PRICE (integer cents, no floating point)
 *   15-minute base = hourly rate / 4
 *   total          = base x (1 + surcharge%)            -> rounded half-up
 *   computed in one step as  hourly x units x (10000 + bps) / 40000
 * Hourly-equivalent proration when a room has no HOUR rate:
 *   HALF_DAY rate / 4 hours, else DAY rate / the room's opening hours.
 *   A room may instead carry an explicit 15-minute base amount.
 *
 * AVAILABILITY
 *   Starting an extension writes real `occupancy` rows for the extra interval
 *   (the same mechanism as booking-request holds), so the database overlap
 *   guard - not this code - arbitrates between two customers who want the
 *   same minutes. The hold has a short expiry and is released on failure.
 *
 * PAYMENT
 *   The browser never reports a payment. Only a PayHere notification with a
 *   valid signature, the exact amount and currency of the stored extension,
 *   processed once (fingerprint + status guard), can extend a booking. Money
 *   that arrives but cannot be turned into time becomes REVIEW_REQUIRED and
 *   staff are told; it is never silently kept and never silently dropped.
 *
 * LATE PAYMENT POLICY
 *   The added time is measured from the later of the booking end and the
 *   moment payment is verified, so a customer who pays after the session
 *   ended still receives the full interval when the room is free. If the
 *   room is not free that long, the originally held interval is granted only
 *   when at most `late_grace_minutes` of it have been lost; otherwise the
 *   payment goes to review for a refund.
 */
import { runInBackground } from './backgroundTask.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { withWriteTransaction } from '../db/connection.js';
import { conflict, forbidden, notFound, validationError } from '../domain/errors.js';
import { businessDateKey, businessLocalToEpoch, parseClock, startOfBusinessDay } from '../domain/time.js';
import { sendMail } from '../mail/mailer.js';
import { sendSms } from '../sms/smsSender.js';
import { accessTimeLabel, extensionReceiptEmail, extensionReceiptSms, formatLkr } from '../mail/accessTemplates.js';
import { EXTENSION_MINUTES, effectiveAccessConfig } from './accessPolicyService.js';
import { kickDoorQueue, syncDoorDeadline } from './doorService.js';
import { recordAudit } from './auditService.js';
import { NOTIFICATION_PRIORITY, NOTIFICATION_TYPE, createNotificationsForAdmins, schedulePendingDispatch } from './notificationService.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LIVE = ['AWAITING_APPROVAL', 'AWAITING_PAYMENT', 'PAYMENT_PENDING'];
const UNAVAILABLE_MESSAGE = 'This room is unavailable for another 15 minutes.';

export const EXTENSION_METHOD = Object.freeze({ PAYHERE: 'PAYHERE', DESK: 'DESK', COMPLIMENTARY: 'COMPLIMENTARY' });

function sha256(value) { return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex'); }
function md5Upper(value) { return createHash('md5').update(String(value), 'utf8').digest('hex').toUpperCase(); }
function secureEqual(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
function num(value) { return value === null || value === undefined ? null : Number(value); }
function ceilMinute(ms) { return Math.ceil(Number(ms) / MINUTE) * MINUTE; }
function roundDiv(numerator, denominator) { return Math.floor((numerator + Math.floor(denominator / 2)) / denominator); }
function isOverlapError(error) { return String(error?.message ?? '').includes('DOUBLE_BOOKING_CONFLICT'); }

export function payHereConfigured(payHere) {
  return Boolean(String(payHere?.merchantId ?? '').trim() && String(payHere?.merchantSecret ?? '').trim());
}

/* ----------------------------------------------------------------- price */

/** Hourly-equivalent rate for a room, or null when none can be derived. */
export function hourlyEquivalentCents(db, space) {
  const rates = new Map(db.prepare('SELECT unit, amount_cents FROM space_rate WHERE space_id = ?').all(space.id).map((r) => [r.unit, Number(r.amount_cents)]));
  if (rates.has('HOUR')) return rates.get('HOUR');
  if (rates.has('HALF_DAY')) return roundDiv(rates.get('HALF_DAY'), 4);
  if (rates.has('DAY')) {
    let minutes = 0;
    try { minutes = parseClock(space.close_time) - parseClock(space.open_time); } catch { minutes = 0; }
    if (minutes >= 23 * 60) minutes = 24 * 60;
    const hours = Math.max(1, Math.round(minutes / 60));
    return roundDiv(rates.get('DAY'), hours);
  }
  return null;
}

/**
 * @returns {{baseCents:number, amountCents:number}} for one 15-minute interval
 */
export function extensionPrice({ hourlyCents = null, baseOverrideCents = null, surchargeBps, unitCount = 1, minPaymentCents = 0 }) {
  const units = Math.max(1, Number(unitCount) || 1);
  let baseCents;
  let amountCents;
  if (baseOverrideCents !== null && baseOverrideCents !== undefined) {
    baseCents = Number(baseOverrideCents) * units;
    amountCents = roundDiv(baseCents * (10000 + Number(surchargeBps)), 10000);
  } else {
    baseCents = roundDiv(Number(hourlyCents) * units, 4);
    amountCents = roundDiv(Number(hourlyCents) * units * (10000 + Number(surchargeBps)), 40000);
  }
  if (amountCents < Number(minPaymentCents)) amountCents = Number(minPaymentCents);
  if (!Number.isSafeInteger(amountCents) || amountCents > 1e11) throw validationError('The extension price is out of range. Check the configured rates.');
  return { baseCents, amountCents };
}

/* ---------------------------------------------------------- availability */

function reservationUnits(db, reservationId) {
  return db.prepare("SELECT resource_unit_id FROM occupancy WHERE reservation_id = ? AND status = 'ACTIVE'").all(Number(reservationId))
    .map((row) => Number(row.resource_unit_id));
}

function ownHoldOccupancyIds(db, reservationId) {
  return db.prepare(`SELECT h.occupancy_id FROM booking_extension_hold h JOIN booking_extension e ON e.id = h.extension_id
     WHERE e.reservation_id = ? AND h.status = 'ACTIVE'`).all(Number(reservationId)).map((row) => Number(row.occupancy_id));
}

/** True when [fromAt, toAt) is free on every unit this booking occupies. */
function intervalFree(db, { reservationId, fromAt, toAt, bufferMinutes = 0 }) {
  const units = reservationUnits(db, reservationId);
  if (units.length === 0) return false;
  const own = new Set(ownHoldOccupancyIds(db, reservationId));
  const buffered = Number(toAt) + Math.max(0, Number(bufferMinutes) || 0) * MINUTE;
  for (const unitId of units) {
    const rows = db.prepare(`SELECT id, source, start_at FROM occupancy
       WHERE resource_unit_id = ? AND status = 'ACTIVE' AND (reservation_id IS NULL OR reservation_id <> ?)
         AND end_at > ? AND start_at < ?`).all(unitId, Number(reservationId), Number(fromAt), buffered);
    for (const row of rows) {
      if (own.has(Number(row.id))) continue;
      // The turnaround buffer only applies against another reservation.
      if (Number(row.start_at) < Number(toAt) || row.source === 'RESERVATION') return false;
    }
  }
  return true;
}

function withinOpeningHours(space, endAt) {
  let closeMinutes;
  try { closeMinutes = parseClock(space.close_time); } catch { return true; }
  if (closeMinutes >= 23 * 60 + 59) return true;
  // The instant just before the new end decides which business day applies.
  const dayClose = businessLocalToEpoch(businessDateKey(Number(endAt) - 1), space.close_time);
  const dayStart = startOfBusinessDay(Number(endAt) - 1);
  return Number(endAt) <= dayClose && Number(endAt) <= dayStart + DAY;
}

function confirmedTotals(db, reservationId) {
  const row = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(minutes), 0) AS m FROM booking_extension WHERE reservation_id = ? AND status = 'CONFIRMED'").get(Number(reservationId));
  return { count: Number(row?.c ?? 0), minutes: Number(row?.m ?? 0) };
}

/* ----------------------------------------------------------------- quote */

/**
 * The authoritative offer for one more interval. Read-only; `startExtension`
 * calls it again under the write lock before anything is reserved.
 *
 * `offered`   the extension card should be shown at all
 * `available` the customer can start one right now
 */
export function quoteExtension(db, { reservation, config, link = null, payHere = null, now = Date.now() } = {}) {
  const policy = config.policy;
  const endAt = Number(reservation.end_at);
  const base = { offered: false, available: false, reason: null, message: null, minutes: EXTENSION_MINUTES };
  if (reservation.status === 'CANCELLED') return { ...base, reason: 'BOOKING_CANCELLED' };
  if (!config.extensionsEnabled) return { ...base, reason: 'DISABLED' };
  if (link && link.doorAccessRevokedAt !== null) return { ...base, reason: 'ACCESS_REVOKED' };
  if (now < endAt - policy.offerBeforeEndMinutes * MINUTE) return { ...base, reason: 'TOO_EARLY' };

  const offered = { ...base, offered: true };
  if (now > endAt + policy.lateWindowMinutes * MINUTE) {
    return { ...offered, reason: 'WINDOW_PASSED', message: 'Extensions are no longer available for this booking.' };
  }
  const totals = confirmedTotals(db, reservation.id);
  if (totals.count >= policy.maxExtensions || totals.minutes + EXTENSION_MINUTES > policy.maxExtensionMinutes) {
    return { ...offered, reason: 'LIMIT_REACHED', message: 'This booking has reached its extension limit.' };
  }

  const space = db.prepare('SELECT * FROM space WHERE id = ?').get(Number(reservation.space_id));
  if (!space) return { ...offered, reason: 'UNAVAILABLE', message: UNAVAILABLE_MESSAGE };
  const hourly = hourlyEquivalentCents(db, space);
  if (hourly === null && config.room.extensionBaseCents === null) {
    return { ...offered, reason: 'NO_PRICE', message: 'Extensions cannot be purchased online for this room. Please ask our staff.' };
  }
  const price = extensionPrice({
    hourlyCents: hourly, baseOverrideCents: config.room.extensionBaseCents, surchargeBps: config.surchargeBps,
    unitCount: reservation.unit_count, minPaymentCents: policy.minPaymentCents,
  });

  const methods = [];
  if (policy.payOnlineEnabled && payHereConfigured(payHere)) methods.push(EXTENSION_METHOD.PAYHERE);
  if (policy.payDeskEnabled) methods.push(EXTENSION_METHOD.DESK);

  const newEndAt = Math.max(endAt, ceilMinute(now)) + EXTENSION_MINUTES * MINUTE;
  const priced = {
    ...offered, newEndAt, fromEndAt: endAt, baseCents: price.baseCents, amountCents: price.amountCents,
    surchargeBps: config.surchargeBps, currency: reservation.currency ?? space.currency ?? 'LKR', methods,
    requiresApproval: policy.requireApproval,
  };
  if (methods.length === 0) {
    return { ...priced, reason: 'NO_PAYMENT_METHOD', message: 'Online payment is not available right now. Please ask our staff to extend your session.' };
  }
  if (!withinOpeningHours(space, newEndAt)) {
    return { ...priced, reason: 'CLOSING', message: 'This room closes soon, so the session cannot be extended.' };
  }
  if (!intervalFree(db, { reservationId: reservation.id, fromAt: endAt, toAt: newEndAt, bufferMinutes: space.buffer_minutes })) {
    return { ...priced, reason: 'UNAVAILABLE', message: UNAVAILABLE_MESSAGE };
  }
  return { ...priced, available: true };
}

/* -------------------------------------------------------------- hydration */

function hydrate(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reservationId: Number(row.reservation_id),
    status: row.status,
    minutes: Number(row.minutes),
    fromEndAt: Number(row.from_end_at),
    newEndAt: Number(row.new_end_at),
    baseCents: Number(row.base_cents),
    surchargeBps: Number(row.surcharge_bps),
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    method: row.method,
    orderId: row.order_id ?? null,
    holdExpiresAt: num(row.hold_expires_at),
    providerPaymentId: row.provider_payment_id ?? null,
    providerMessage: row.provider_message ?? null,
    reviewReason: row.review_reason ?? null,
    resolution: row.resolution ?? null,
    resolutionNote: row.resolution_note ?? null,
    seenAt: num(row.seen_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    confirmedAt: num(row.confirmed_at),
    reservationReference: row.reservation_reference ?? null,
    spaceCode: row.space_code ?? null,
    spaceName: row.space_name ?? null,
    customerName: row.customer_name ?? null,
  };
}

const SELECT = `SELECT e.*, r.reference AS reservation_reference, s.code AS space_code, s.name AS space_name, c.full_name AS customer_name
  FROM booking_extension e JOIN reservation r ON r.id = e.reservation_id
  JOIN space s ON s.id = r.space_id JOIN customer c ON c.id = r.customer_id`;

export function getExtension(db, id) {
  return hydrate(db.prepare(`${SELECT} WHERE e.id = ?`).get(Number(id)));
}

export function listExtensions(db, { reservationId = null, statuses = null, limit = 100 } = {}) {
  const where = []; const params = [];
  if (reservationId !== null) { where.push('e.reservation_id = ?'); params.push(Number(reservationId)); }
  if (Array.isArray(statuses) && statuses.length) { where.push(`e.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
  return db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT ?`).all(...params, limit).map(hydrate);
}

/** The extension the customer page should talk about: the live one, else the most recent. */
export function currentExtension(db, reservationId) {
  const live = db.prepare(`SELECT * FROM booking_extension WHERE reservation_id = ? AND status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING') ORDER BY id DESC LIMIT 1`).get(Number(reservationId));
  if (live) return hydrate(live);
  return hydrate(db.prepare('SELECT * FROM booking_extension WHERE reservation_id = ? ORDER BY id DESC LIMIT 1').get(Number(reservationId)));
}

/* ------------------------------------------------------------------ holds */

function releaseHolds(db, extensionId, now) {
  db.prepare(`UPDATE occupancy SET status = 'RELEASED', released_at = ? WHERE status = 'ACTIVE' AND id IN
    (SELECT occupancy_id FROM booking_extension_hold WHERE extension_id = ? AND status = 'ACTIVE')`).run(now, Number(extensionId));
  db.prepare("UPDATE booking_extension_hold SET status = 'RELEASED', released_at = ? WHERE extension_id = ? AND status = 'ACTIVE'").run(now, Number(extensionId));
}

function placeHolds(db, { extensionId, reservation, fromAt, toAt, now }) {
  const insertOccupancy = db.prepare(`INSERT INTO occupancy
      (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, maintenance_block_id, created_at)
      VALUES (?,?,?,?,'ACTIVE','MAINTENANCE',NULL,NULL,?)`);
  const insertHold = db.prepare("INSERT INTO booking_extension_hold (extension_id, occupancy_id, status, created_at) VALUES (?,?,'ACTIVE',?)");
  for (const unitId of reservationUnits(db, reservation.id)) {
    const occupancy = insertOccupancy.run(unitId, reservation.space_id, Number(fromAt), Number(toAt), now);
    insertHold.run(Number(extensionId), Number(occupancy.lastInsertRowid), now);
  }
}

/** Release the holds of extensions whose payment window lapsed. Lazy, like booking-request holds. */
export function expireExtensionHolds(db, now = Date.now()) {
  return withWriteTransaction(db, () => {
    const rows = db.prepare(`SELECT id, status FROM booking_extension
       WHERE status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING') AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?`).all(now);
    for (const row of rows) {
      releaseHolds(db, row.id, now);
      db.prepare("UPDATE booking_extension SET status = 'EXPIRED', updated_at = ? WHERE id = ?").run(now, row.id);
    }
    return rows.length;
  });
}

/* ------------------------------------------------------------ notifications */

function notifyAdmins(db, { extensionId, title, body, priority = NOTIFICATION_PRIORITY.NORMAL, key, now }) {
  try {
    const result = createNotificationsForAdmins(db, {
      type: NOTIFICATION_TYPE.EXTENSION, title, body, entityType: 'booking_extension', entityId: String(extensionId),
      actionUrl: '/admin/access', priority, dedupeKey: `extension:${key}:${extensionId}`, now,
    });
    if (result.created > 0) schedulePendingDispatch(db);
  } catch (error) {
    console.warn('[extension] could not notify staff:', error?.code ?? error?.message ?? 'unknown');
  }
}

function sendReceiptSoon(db, extensionId) {
  runInBackground('extension-receipt', () => sendExtensionReceipt(db, extensionId));
}

/** Email and SMS confirmation of a granted extension. Never throws. */
export async function sendExtensionReceipt(db, extensionId) {
  try {
    const row = db.prepare(`SELECT e.*, r.reference, s.name AS space_name, c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
        FROM booking_extension e JOIN reservation r ON r.id = e.reservation_id JOIN space s ON s.id = r.space_id JOIN customer c ON c.id = r.customer_id
       WHERE e.id = ? AND e.status = 'CONFIRMED'`).get(Number(extensionId));
    if (!row) return null;
    const details = {
      customerName: row.customer_name, spaceName: row.space_name, reference: row.reference, minutes: Number(row.minutes),
      newEndAt: Number(row.new_end_at), amountCents: Number(row.amount_cents), currency: row.currency, method: row.method, orderId: row.order_id,
    };
    const email = row.customer_email ? await sendMail({ to: row.customer_email, ...extensionReceiptEmail(details) }) : { status: 'NO_ADDRESS' };
    const sms = await sendSms({ to: row.customer_phone, message: extensionReceiptSms(details) });
    return { email: email.status, sms: sms.status };
  } catch { return null; }
}

/* ------------------------------------------------------------------ start */

/**
 * The customer asks for 15 more minutes. Everything is re-validated under the
 * write lock; the result is a held interval awaiting approval or payment.
 */
export function startExtension(db, { access, method, idempotencyKey = null, payHere = null, now = Date.now() } = {}) {
  const chosen = String(method ?? '').toUpperCase();
  if (![EXTENSION_METHOD.PAYHERE, EXTENSION_METHOD.DESK].includes(chosen)) throw validationError('Choose how you would like to pay.');
  const key = String(idempotencyKey ?? '').trim();
  if (key && !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw validationError('The request could not be verified. Reload the page and try again.');
  expireExtensionHolds(db, now);

  let created = false;
  let extension;
  try {
    extension = withWriteTransaction(db, () => {
      const link = db.prepare('SELECT * FROM booking_access_link WHERE id = ?').get(Number(access.linkId));
      if (!link || link.status !== 'ACTIVE') throw notFound('This access link is no longer available.');
      const reservation = db.prepare('SELECT * FROM reservation WHERE id = ?').get(Number(link.reservation_id));
      if (!reservation) throw notFound('Booking not found.');

      const live = db.prepare(`SELECT * FROM booking_extension WHERE reservation_id = ? AND status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING')`).get(reservation.id);
      if (live) return hydrate(live);
      if (key) {
        const repeat = db.prepare('SELECT * FROM booking_extension WHERE idempotency_key = ?').get(`cust:${link.id}:${key}`);
        if (repeat) return hydrate(repeat);
      }

      const config = effectiveAccessConfig(db, reservation.space_id);
      const quote = quoteExtension(db, {
        reservation, config, payHere, now,
        link: { doorAccessRevokedAt: num(link.door_access_revoked_at) },
      });
      if (!quote.offered || !quote.available) {
        const error = conflict(quote.message ?? 'An extension is not available for this booking right now.');
        error.code = quote.reason === 'UNAVAILABLE' ? 'EXTENSION_UNAVAILABLE' : 'EXTENSION_NOT_AVAILABLE';
        throw error;
      }
      if (!quote.methods.includes(chosen)) throw validationError('That payment method is not available.');

      const status = config.policy.requireApproval ? 'AWAITING_APPROVAL' : 'AWAITING_PAYMENT';
      const holdMinutes = config.policy.requireApproval ? Math.max(config.policy.paymentHoldMinutes, 15) : config.policy.paymentHoldMinutes;
      const info = db.prepare(`INSERT INTO booking_extension
          (reservation_id, access_link_id, status, minutes, from_end_at, new_end_at, base_cents, surcharge_bps, amount_cents, currency,
           method, idempotency_key, hold_expires_at, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(reservation.id, link.id, status, EXTENSION_MINUTES, quote.fromEndAt, quote.newEndAt, quote.baseCents, quote.surchargeBps,
          quote.amountCents, quote.currency, chosen, key ? `cust:${link.id}:${key}` : null, now + holdMinutes * MINUTE, now, now);
      const id = Number(info.lastInsertRowid);
      db.prepare('UPDATE booking_extension SET order_id = ? WHERE id = ?').run(`EXT-${reservation.reference}-${id}`, id);
      placeHolds(db, { extensionId: id, reservation, fromAt: quote.fromEndAt, toAt: quote.newEndAt, now });
      recordAudit(db, {
        actorLabel: 'customer access link', action: 'booking_extension.started', entityType: 'reservation', entityId: reservation.id,
        summary: `Extension requested for ${reservation.reference}`,
        details: { extensionId: id, method: chosen, amountCents: quote.amountCents, newEndAt: quote.newEndAt, status },
      });
      created = true;
      return hydrate(db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(id));
    });
  } catch (error) {
    if (isOverlapError(error)) {
      const unavailable = conflict(UNAVAILABLE_MESSAGE);
      unavailable.code = 'EXTENSION_UNAVAILABLE';
      throw unavailable;
    }
    throw error;
  }

  if (created && (extension.status === 'AWAITING_APPROVAL' || extension.method === EXTENSION_METHOD.DESK)) {
    const full = getExtension(db, extension.id);
    notifyAdmins(db, {
      extensionId: extension.id, key: 'requested', now, priority: NOTIFICATION_PRIORITY.HIGH,
      title: extension.status === 'AWAITING_APPROVAL' ? 'Extension needs approval' : 'Extension payment at the desk',
      body: `${full.customerName} asked for ${EXTENSION_MINUTES} more minutes in ${full.spaceName} (${full.spaceCode}), `
        + `until ${accessTimeLabel(full.newEndAt)}. ${formatLkr(full.amountCents, full.currency)}. Booking ${full.reservationReference}.`,
    });
  }
  return extension;
}

/** PayHere checkout form for an extension that is awaiting online payment. */
export function extensionCheckout(db, { extensionId, payHere, now = Date.now() } = {}) {
  const row = db.prepare(`SELECT e.*, r.reference, s.name AS space_name, c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
      FROM booking_extension e JOIN reservation r ON r.id = e.reservation_id JOIN space s ON s.id = r.space_id JOIN customer c ON c.id = r.customer_id
     WHERE e.id = ?`).get(Number(extensionId));
  if (!row || row.method !== EXTENSION_METHOD.PAYHERE || !['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(row.status)) return null;
  if (row.hold_expires_at !== null && Number(row.hold_expires_at) <= now) return null;
  if (!payHereConfigured(payHere)) return null;
  const merchantId = String(payHere.merchantId).trim();
  const amount = (Number(row.amount_cents) / 100).toFixed(2);
  const base = String(payHere.baseUrl ?? '').replace(/\/$/, '');
  const name = String(row.customer_name ?? '').trim();
  return {
    action: payHere.sandbox === false ? 'https://www.payhere.lk/pay/checkout' : 'https://sandbox.payhere.lk/pay/checkout',
    fields: {
      merchant_id: merchantId,
      // Neither URL carries the access token: the customer's browser finds its
      // way back to the page through an HttpOnly cookie.
      return_url: `${base}/access/return`,
      cancel_url: `${base}/access/return?cancelled=1`,
      notify_url: `${base}/api/public/payments/payhere/extension-notify`,
      first_name: name.split(/\s+/)[0] || 'Guest',
      last_name: name.split(/\s+/).slice(1).join(' ') || '-',
      email: row.customer_email || 'no-reply@trace.local',
      phone: row.customer_phone || '0000000000',
      address: 'Not supplied', city: 'Colombo', country: 'Sri Lanka',
      order_id: row.order_id,
      items: `${row.minutes}-minute session extension - ${row.space_name}`,
      currency: row.currency,
      amount,
      hash: md5Upper(`${merchantId}${row.order_id}${amount}${row.currency}${md5Upper(String(payHere.merchantSecret).trim())}`),
    },
  };
}

/** The customer changed their mind before paying. */
export function cancelExtension(db, { access, now = Date.now() } = {}) {
  return withWriteTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM booking_extension WHERE reservation_id = ? AND status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT')`).get(Number(access.reservation.id));
    if (!row) return null;
    releaseHolds(db, row.id, now);
    db.prepare("UPDATE booking_extension SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, row.id);
    return hydrate(db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(row.id));
  });
}

export function markExtensionSeen(db, { access, now = Date.now() } = {}) {
  db.prepare('UPDATE booking_extension SET seen_at = ? WHERE reservation_id = ? AND seen_at IS NULL AND status NOT IN (\'AWAITING_APPROVAL\',\'AWAITING_PAYMENT\',\'PAYMENT_PENDING\')')
    .run(now, Number(access.reservation.id));
}

/* ----------------------------------------------------------------- commit */

/**
 * Turn an extension into booked time. Call inside a write transaction.
 * Returns `{ ok: true, newEndAt }` or `{ ok: false, reason }` and never
 * throws for a business reason, so the caller can route money to review.
 */
function commitExtension(db, row, { now, graceMinutes, ignoreLimits = false }) {
  const reservation = db.prepare('SELECT * FROM reservation WHERE id = ?').get(Number(row.reservation_id));
  if (!reservation) return { ok: false, reason: 'The booking no longer exists.' };
  if (reservation.status === 'CANCELLED') return { ok: false, reason: 'The booking was cancelled before the extension could be applied.' };
  const space = db.prepare('SELECT * FROM space WHERE id = ?').get(Number(reservation.space_id));
  const minutes = Number(row.minutes);
  const currentEnd = Number(reservation.end_at);

  // Another in-flight extension for the same booking is superseded.
  const others = db.prepare(`SELECT id FROM booking_extension WHERE reservation_id = ? AND id <> ? AND status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING')`).all(reservation.id, row.id);
  for (const other of others) {
    releaseHolds(db, other.id, now);
    db.prepare("UPDATE booking_extension SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, other.id);
  }

  const ideal = Math.max(currentEnd, ceilMinute(now)) + minutes * MINUTE;
  const held = currentEnd === Number(row.from_end_at) ? Number(row.new_end_at) : null;
  const candidates = [ideal];
  if (held !== null && held < ideal && held - now >= (minutes - graceMinutes) * MINUTE) candidates.push(held);

  let newEndAt = null;
  for (const candidate of candidates) {
    if (candidate <= currentEnd) continue;
    if (!ignoreLimits && space && !withinOpeningHours(space, candidate)) continue;
    if (intervalFree(db, { reservationId: reservation.id, fromAt: currentEnd, toAt: candidate, bufferMinutes: space?.buffer_minutes ?? 0 })) {
      newEndAt = candidate;
      break;
    }
  }
  if (newEndAt === null) return { ok: false, reason: 'The room was no longer free for the paid interval.' };

  releaseHolds(db, row.id, now);
  db.prepare("UPDATE occupancy SET end_at = ? WHERE reservation_id = ? AND status = 'ACTIVE'").run(newEndAt, reservation.id);
  db.prepare("UPDATE reservation SET end_at = ?, status = 'CONFIRMED', total_cents = total_cents + ?, updated_at = ? WHERE id = ?")
    .run(newEndAt, Number(row.amount_cents), now, reservation.id);
  db.prepare("UPDATE booking_extension SET status = 'CONFIRMED', new_end_at = ?, confirmed_at = ?, seen_at = NULL, updated_at = ? WHERE id = ?")
    .run(newEndAt, now, now, row.id);
  // Door control returns with the new end time; an expired unlock is not revived.
  syncDoorDeadline(db, { reservationId: reservation.id, spaceId: reservation.space_id, newEndAt, now });
  recordAudit(db, {
    actorLabel: 'session extension', action: 'booking_extension.confirmed', entityType: 'reservation', entityId: reservation.id,
    summary: `Extended ${reservation.reference} by ${minutes} minutes`,
    details: { extensionId: Number(row.id), previousEndAt: currentEnd, newEndAt, amountCents: Number(row.amount_cents), method: row.method },
  });
  return { ok: true, newEndAt, reservationId: Number(reservation.id) };
}

function toReview(db, row, reason, now) {
  releaseHolds(db, row.id, now);
  db.prepare("UPDATE booking_extension SET status = 'REVIEW_REQUIRED', review_reason = ?, seen_at = NULL, updated_at = ? WHERE id = ?")
    .run(String(reason).slice(0, 300), now, row.id);
}

function afterConfirmed(db, extensionId, now) {
  const full = getExtension(db, extensionId);
  if (!full) return;
  notifyAdmins(db, {
    extensionId, key: 'confirmed', now, title: 'Session extended',
    body: `${full.customerName} extended ${full.spaceName} (${full.spaceCode}) until ${accessTimeLabel(full.newEndAt)}. `
      + `${full.method === 'COMPLIMENTARY' ? 'No charge' : formatLkr(full.amountCents, full.currency)}. Booking ${full.reservationReference}.`,
  });
  sendReceiptSoon(db, extensionId);
  kickDoorQueue(db);
}

function afterReview(db, extensionId, now) {
  const full = getExtension(db, extensionId);
  if (!full) return;
  notifyAdmins(db, {
    extensionId, key: 'review', now, priority: NOTIFICATION_PRIORITY.HIGH, title: 'Extension payment needs review',
    body: `A payment of ${formatLkr(full.amountCents, full.currency)} for ${full.spaceName} (${full.spaceCode}) could not be applied: `
      + `${full.reviewReason ?? 'see the console'}. Booking ${full.reservationReference}. A refund may be due.`,
  });
}

/* --------------------------------------------------------- PayHere notify */

/**
 * Server-to-server PayHere notification for an extension order. Idempotent:
 * the same notification, or a second "paid" for an order already applied,
 * never adds time twice.
 */
export function processExtensionNotification(db, payload = {}, payHere = {}, now = Date.now()) {
  const merchantId = String(payload.merchant_id ?? '');
  const orderId = String(payload.order_id ?? '');
  const statusCode = String(payload.status_code ?? '');
  const amount = String(payload.payhere_amount ?? '');
  const currency = String(payload.payhere_currency ?? '');
  const paymentId = String(payload.payment_id ?? '');
  const expected = md5Upper(`${merchantId}${orderId}${amount}${currency}${statusCode}${md5Upper(payHere.merchantSecret ?? '')}`);
  const signatureValid = Boolean(payHere.merchantSecret) && merchantId === String(payHere.merchantId ?? '')
    && secureEqual(expected, String(payload.md5sig ?? '').toUpperCase());
  const fingerprint = sha256([orderId, paymentId, statusCode, amount, currency, payload.md5sig].join('|'));

  const result = withWriteTransaction(db, () => {
    if (db.prepare('SELECT id FROM extension_payment_event WHERE event_fingerprint = ?').get(fingerprint)) return { accepted: true, idempotent: true };
    const row = db.prepare('SELECT * FROM booking_extension WHERE order_id = ?').get(orderId);
    const sanitized = JSON.stringify({
      merchant_id: merchantId, order_id: orderId, payment_id: paymentId, payhere_amount: amount, payhere_currency: currency,
      status_code: statusCode, method: String(payload.method ?? ''), status_message: String(payload.status_message ?? '').slice(0, 300),
    });
    db.prepare(`INSERT INTO extension_payment_event (extension_id, event_fingerprint, signature_valid, provider_payment_id, provider_status_code, sanitized_payload, received_at)
        VALUES (?,?,?,?,?,?,?)`).run(row?.id ?? null, fingerprint, signatureValid ? 1 : 0, paymentId || null, statusCode, sanitized, now);
    if (!row || !signatureValid) return { accepted: false };

    const provider = (message) => db.prepare('UPDATE booking_extension SET provider_payment_id = ?, provider_method = ?, provider_status_code = ?, provider_message = ?, updated_at = ? WHERE id = ?')
      .run(paymentId || null, String(payload.method ?? '') || null, statusCode, String(message ?? payload.status_message ?? '').slice(0, 300) || null, now, row.id);
    const exact = amount === (Number(row.amount_cents) / 100).toFixed(2) && currency === row.currency;

    if (statusCode === '2') {
      if (row.status === 'CONFIRMED') {
        if (row.provider_payment_id && row.provider_payment_id === paymentId) return { accepted: true, idempotent: true };
        // A second, different payment for an order that was already applied.
        db.prepare(`INSERT INTO booking_extension
            (reservation_id, access_link_id, status, minutes, from_end_at, new_end_at, base_cents, surcharge_bps, amount_cents, currency, method,
             provider_payment_id, provider_method, provider_status_code, review_reason, created_at, updated_at)
            VALUES (?,?,'REVIEW_REQUIRED',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(row.reservation_id, row.access_link_id, row.minutes, row.from_end_at, row.new_end_at, row.base_cents, row.surcharge_bps,
            row.amount_cents, row.currency, row.method, paymentId || null, String(payload.method ?? '') || null, statusCode,
            `A second payment arrived for ${row.order_id}, which was already applied.`, now, now);
        const duplicate = db.prepare("SELECT id FROM booking_extension WHERE reservation_id = ? AND status = 'REVIEW_REQUIRED' ORDER BY id DESC LIMIT 1").get(row.reservation_id);
        return { accepted: true, reviewId: Number(duplicate.id) };
      }
      if (['REVIEW_REQUIRED', 'RESOLVED'].includes(row.status)) { provider(); return { accepted: true, idempotent: true }; }
      provider();
      if (!exact) {
        toReview(db, row, 'The paid amount or currency did not match the extension price.', now);
        return { accepted: true, reviewId: Number(row.id) };
      }
      const grace = Number(db.prepare('SELECT late_grace_minutes FROM access_policy WHERE id = 1').get()?.late_grace_minutes ?? 5);
      const outcome = commitExtension(db, row, { now, graceMinutes: grace });
      if (!outcome.ok) {
        toReview(db, row, outcome.reason, now);
        return { accepted: true, reviewId: Number(row.id) };
      }
      return { accepted: true, confirmedId: Number(row.id) };
    }

    if (statusCode === '-3') {
      provider('Chargeback');
      if (row.status === 'CONFIRMED') {
        db.prepare("UPDATE booking_extension SET status = 'REVIEW_REQUIRED', review_reason = ?, updated_at = ? WHERE id = ?")
          .run('The card payment was charged back after the extension was applied.', now, row.id);
      } else if (LIVE.includes(row.status)) {
        toReview(db, row, 'The card payment was charged back.', now);
      }
      return { accepted: true, reviewId: Number(row.id) };
    }

    if (!LIVE.includes(row.status)) { provider(); return { accepted: true }; }
    if (statusCode === '0') {
      provider();
      // Keep the interval held a little longer while the bank decides.
      db.prepare("UPDATE booking_extension SET status = 'PAYMENT_PENDING', hold_expires_at = CASE WHEN hold_expires_at < ? THEN ? ELSE hold_expires_at END, updated_at = ? WHERE id = ?")
        .run(now + 5 * MINUTE, now + 5 * MINUTE, now, row.id);
      return { accepted: true };
    }
    provider();
    releaseHolds(db, row.id, now);
    db.prepare("UPDATE booking_extension SET status = 'FAILED', seen_at = NULL, updated_at = ? WHERE id = ?").run(now, row.id);
    return { accepted: true };
  });

  if (result.confirmedId) afterConfirmed(db, result.confirmedId, now);
  if (result.reviewId) afterReview(db, result.reviewId, now);
  return result;
}

/* ------------------------------------------------------------ staff actions */

function requireActor(actor) {
  if (!actor?.id) throw forbidden('Sign in to manage extensions.');
}

export function approveExtension(db, { actor, extensionId, now = Date.now() } = {}) {
  requireActor(actor);
  return withWriteTransaction(db, () => {
    const row = db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(Number(extensionId));
    if (!row) throw notFound('Extension not found.');
    if (row.status !== 'AWAITING_APPROVAL') throw conflict('This extension is not waiting for approval.');
    const hold = Number(db.prepare('SELECT payment_hold_minutes FROM access_policy WHERE id = 1').get().payment_hold_minutes);
    db.prepare("UPDATE booking_extension SET status = 'AWAITING_PAYMENT', approved_by = ?, approved_at = ?, hold_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(actor.id, now, now + hold * MINUTE, now, row.id);
    recordAudit(db, { actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'booking_extension.approved', entityType: 'reservation', entityId: row.reservation_id, summary: 'Approved a session extension', details: { extensionId: Number(row.id) } });
    return hydrate(db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(row.id));
  });
}

export function rejectExtension(db, { actor, extensionId, now = Date.now() } = {}) {
  requireActor(actor);
  return withWriteTransaction(db, () => {
    const row = db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(Number(extensionId));
    if (!row) throw notFound('Extension not found.');
    if (!['AWAITING_APPROVAL', 'AWAITING_PAYMENT'].includes(row.status)) throw conflict('This extension can no longer be declined.');
    releaseHolds(db, row.id, now);
    db.prepare("UPDATE booking_extension SET status = 'REJECTED', resolved_by = ?, resolved_at = ?, seen_at = NULL, updated_at = ? WHERE id = ?").run(actor.id, now, now, row.id);
    recordAudit(db, { actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'booking_extension.rejected', entityType: 'reservation', entityId: row.reservation_id, summary: 'Declined a session extension', details: { extensionId: Number(row.id) } });
    return hydrate(db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(row.id));
  });
}

/** Staff took the money at the desk: apply the waiting extension. */
export function confirmDeskPayment(db, { actor, extensionId, now = Date.now() } = {}) {
  requireActor(actor);
  const result = withWriteTransaction(db, () => {
    const row = db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(Number(extensionId));
    if (!row) throw notFound('Extension not found.');
    if (row.method !== EXTENSION_METHOD.DESK || !['AWAITING_PAYMENT', 'EXPIRED'].includes(row.status)) throw conflict('This extension is not waiting for a front-desk payment.');
    const outcome = commitExtension(db, row, { now, graceMinutes: 14 });
    if (!outcome.ok) throw conflict(outcome.reason);
    db.prepare('UPDATE booking_extension SET resolved_by = ?, resolved_at = ?, provider_message = ? WHERE id = ?').run(actor.id, now, 'Paid at the front desk', row.id);
    recordAudit(db, { actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'booking_extension.desk_paid', entityType: 'reservation', entityId: row.reservation_id, summary: 'Recorded a front-desk extension payment', details: { extensionId: Number(row.id), amountCents: Number(row.amount_cents) } });
    return Number(row.id);
  });
  afterConfirmed(db, result, now);
  return getExtension(db, result);
}

/**
 * Staff add 15 minutes directly (paid at the desk, or complimentary). The room
 * must still be free; the customer-facing limits do not apply to staff.
 */
export function grantExtension(db, { actor, reservationId, method = EXTENSION_METHOD.DESK, now = Date.now() } = {}) {
  requireActor(actor);
  const chosen = String(method ?? '').toUpperCase();
  if (![EXTENSION_METHOD.DESK, EXTENSION_METHOD.COMPLIMENTARY].includes(chosen)) throw validationError('Choose front-desk payment or complimentary.');
  expireExtensionHolds(db, now);
  const id = withWriteTransaction(db, () => {
    const reservation = db.prepare('SELECT * FROM reservation WHERE id = ?').get(Number(reservationId));
    if (!reservation) throw notFound('Reservation not found.');
    if (reservation.status === 'CANCELLED') throw conflict('A cancelled booking cannot be extended.');
    const config = effectiveAccessConfig(db, reservation.space_id);
    const space = db.prepare('SELECT * FROM space WHERE id = ?').get(reservation.space_id);
    let amountCents = 0; let baseCents = 0;
    if (chosen === EXTENSION_METHOD.DESK) {
      const hourly = hourlyEquivalentCents(db, space);
      if (hourly === null && config.room.extensionBaseCents === null) throw conflict('No rate is configured to price an extension for this room.');
      ({ amountCents, baseCents } = extensionPrice({ hourlyCents: hourly, baseOverrideCents: config.room.extensionBaseCents, surchargeBps: config.surchargeBps, unitCount: reservation.unit_count }));
    }
    const endAt = Number(reservation.end_at);
    // A staff grant replaces whatever the customer had in flight.
    for (const other of db.prepare(`SELECT id FROM booking_extension WHERE reservation_id = ? AND status IN ('AWAITING_APPROVAL','AWAITING_PAYMENT','PAYMENT_PENDING')`).all(reservation.id)) {
      releaseHolds(db, other.id, now);
      db.prepare("UPDATE booking_extension SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, other.id);
    }
    const info = db.prepare(`INSERT INTO booking_extension
        (reservation_id, status, minutes, from_end_at, new_end_at, base_cents, surcharge_bps, amount_cents, currency, method, created_by_admin, created_at, updated_at)
        VALUES (?,'AWAITING_PAYMENT',?,?,?,?,?,?,?,?,?,?,?)`)
      .run(reservation.id, EXTENSION_MINUTES, endAt, Math.max(endAt, ceilMinute(now)) + EXTENSION_MINUTES * MINUTE, baseCents,
        chosen === EXTENSION_METHOD.DESK ? config.surchargeBps : 0, amountCents, reservation.currency ?? 'LKR', chosen, actor.id, now, now);
    const row = db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(Number(info.lastInsertRowid));
    const outcome = commitExtension(db, row, { now, graceMinutes: 14, ignoreLimits: true });
    if (!outcome.ok) throw conflict(UNAVAILABLE_MESSAGE);
    db.prepare('UPDATE booking_extension SET resolved_by = ?, resolved_at = ? WHERE id = ?').run(actor.id, now, row.id);
    recordAudit(db, { actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'booking_extension.granted', entityType: 'reservation', entityId: reservation.id, summary: `Added ${EXTENSION_MINUTES} minutes (${chosen === EXTENSION_METHOD.DESK ? 'paid at desk' : 'complimentary'})`, details: { extensionId: Number(row.id), amountCents } });
    return Number(row.id);
  });
  afterConfirmed(db, id, now);
  return getExtension(db, id);
}

/**
 * Close a payment exception. A provider refund is always a manual PayHere
 * action; this records that it was done (or that the money was kept, or that
 * the time was granted after all) with an audited note.
 */
export function resolveExtensionException(db, { actor, extensionId, outcome, note, now = Date.now() } = {}) {
  requireActor(actor);
  const next = String(outcome ?? '').trim().toUpperCase();
  if (!['REFUND_RECORDED', 'PAYMENT_KEPT', 'TIME_GRANTED'].includes(next)) throw validationError('Choose how the exception was resolved.', { outcome: 'Choose an outcome.' });
  const reason = String(note ?? '').trim();
  if (!reason) throw validationError('Add a short note about what was done.', { note: 'A note is required.' });
  let granted = null;
  withWriteTransaction(db, () => {
    const row = db.prepare('SELECT * FROM booking_extension WHERE id = ?').get(Number(extensionId));
    if (!row) throw notFound('Extension not found.');
    if (row.status !== 'REVIEW_REQUIRED') throw conflict('This extension has no payment exception to resolve.');
    if (next === 'TIME_GRANTED') {
      const result = commitExtension(db, row, { now, graceMinutes: 14, ignoreLimits: true });
      if (!result.ok) throw conflict(UNAVAILABLE_MESSAGE);
      db.prepare('UPDATE booking_extension SET resolution = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(next, reason.slice(0, 1000), actor.id, now, row.id);
      granted = Number(row.id);
    } else {
      db.prepare("UPDATE booking_extension SET status = 'RESOLVED', resolution = ?, resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
        .run(next, reason.slice(0, 1000), actor.id, now, now, row.id);
    }
    recordAudit(db, { actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'booking_extension.exception_resolved', entityType: 'reservation', entityId: row.reservation_id, summary: `Extension payment exception: ${next}`, details: { extensionId: Number(row.id), outcome: next, note: reason.slice(0, 1000) } });
  });
  if (granted) afterConfirmed(db, granted, now);
  return getExtension(db, extensionId);
}
