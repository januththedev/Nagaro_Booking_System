/**
 * Admin notifications: persistence, in-app reads, Web Push dispatch and the
 * 30-minute room-preparation reminder scan.
 *
 * Design constraints:
 *   - Persistence happens inside the same synchronous request as the booking
 *     write, but *after* that write has committed. A notification failure is
 *     logged and swallowed by the caller, never allowed to roll back a booking.
 *   - Push payloads are rebuilt from the referenced reservation/request. They
 *     contain space code, time and reference only - never a customer name.
 *   - Reminder notifications are HIGH priority. The bell and the full page pin
 *     unread reminders first and keep them unread until the recipient acts.
 *   - Dispatch is retryable through `notification.pushed_at` and
 *     `notification.email_sent_at`, so a serverless invocation can finish the
 *     work on the next secured cron tick.
 */
import {
  businessDateKey, businessDateTimeLabel, businessTimeLabel,
} from '../domain/time.js';
import { conflict, notFound, validationError } from '../domain/errors.js';
import { mailerConfig, sendMail } from '../mail/mailer.js';
import { reminderEmail } from '../mail/notificationTemplates.js';
import { sendWebPush, vapidConfig } from './pushService.js';

export const NOTIFICATION_TYPE = Object.freeze({
  NEW_BOOKING: 'NEW_BOOKING',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  REMINDER: 'REMINDER',
});

export const NOTIFICATION_PRIORITY = Object.freeze({
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
});

/** Catch-up window: any confirmed booking starting in the next 35 minutes. */
export const REMINDER_WINDOW_MINUTES = 35;
export const REMINDER_LEAD_MINUTES = 30;

const MINUTE_MS = 60 * 1000;
const MAX_SUBSCRIPTIONS_PER_ADMIN = 20;
const BASE64URL_PATTERN = /^[A-Za-z0-9_\-+/]+={0,2}$/;

/* ----------------------------------------------------------------- helpers */

function intOr(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function safeText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function safeAdminPath(value, fallback = '/admin/notifications') {
  const text = safeText(value, 500);
  if (!text || !text.startsWith('/admin') || text.startsWith('//')) return fallback;
  return text;
}

function formatWindow(startAt, endAt) {
  const start = Number(startAt);
  const end = Number(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  if (businessDateKey(start) === businessDateKey(end)) {
    return `${businessTimeLabel(start)}–${businessTimeLabel(end)}`;
  }
  return `${businessDateTimeLabel(start)} – ${businessDateTimeLabel(end)}`;
}

function safeFailure(error) {
  const status = Number(error?.statusCode ?? error?.status ?? 0);
  return {
    statusCode: Number.isFinite(status) && status > 0 ? status : null,
    code: safeText(error?.code ?? error?.name ?? 'PUSH_FAILED', 80),
  };
}

function isGone(error) {
  const status = Number(error?.statusCode ?? error?.status ?? 0);
  return status === 404 || status === 410;
}

function activeAdmins(db, excludeAdminUserId = null) {
  const params = [];
  let sql = "SELECT id FROM admin_user WHERE is_active = 1 AND COALESCE(is_system, 0) = 0";
  if (excludeAdminUserId !== null && excludeAdminUserId !== undefined) {
    sql += ' AND id <> ?';
    params.push(Number(excludeAdminUserId));
  }
  sql += ' ORDER BY id ASC';
  return db.prepare(sql).all(...params).map((row) => Number(row.id));
}

function recipientIsActive(db, adminUserId) {
  const row = db.prepare('SELECT is_active FROM admin_user WHERE id = ?').get(Number(adminUserId));
  return Boolean(row && Number(row.is_active) === 1);
}

/* ------------------------------------------------------------- hydration */

export function hydrateNotification(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    actionUrl: safeAdminPath(row.action_url),
    priority: row.priority,
    dedupeKey: row.dedupe_key,
    createdAt: Number(row.created_at),
    readAt: row.read_at === null || row.read_at === undefined ? null : Number(row.read_at),
    pushedAt: row.pushed_at === null || row.pushed_at === undefined ? null : Number(row.pushed_at),
    emailSentAt: row.email_sent_at === null || row.email_sent_at === undefined
      ? null : Number(row.email_sent_at),
    isRead: row.read_at !== null && row.read_at !== undefined,
    pinned: row.priority === NOTIFICATION_PRIORITY.HIGH,
    startsAt: row.entity_start_at === null || row.entity_start_at === undefined
      ? null : Number(row.entity_start_at),
  };
}

/* --------------------------------------------------------------- reads */

export function unreadNotificationCount(db, adminUserId) {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM notification WHERE admin_user_id = ? AND read_at IS NULL',
  ).get(Number(adminUserId));
  return Number(row?.c ?? 0);
}

/**
 * Newest notifications, with unread HIGH-priority reminders pinned first.
 * Read reminders drop back into the normal newest-first stream.
 */
export function listNotifications(db, { adminUserId, limit = 20, offset = 0 } = {}) {
  const id = intOr(adminUserId, null);
  if (id === null || id < 1) throw validationError('A valid staff account is required.');
  const cappedLimit = Math.min(Math.max(intOr(limit, 20), 1), 100);
  const safeOffset = Math.max(intOr(offset, 0), 0);
  const rows = db.prepare(`
    SELECT n.*, r.start_at AS entity_start_at
      FROM notification n
      LEFT JOIN reservation r
        ON n.entity_type = 'reservation' AND n.entity_id = CAST(r.id AS TEXT)
     WHERE n.admin_user_id = ?
     ORDER BY CASE
                WHEN n.priority = 'HIGH' AND n.read_at IS NULL THEN 0
                WHEN n.priority = 'HIGH' THEN 1
                ELSE 2
              END ASC,
              n.created_at DESC,
              n.id DESC
     LIMIT ? OFFSET ?
  `).all(id, cappedLimit, safeOffset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM notification WHERE admin_user_id = ?')
    .get(id);
  return {
    items: rows.map(hydrateNotification),
    unreadCount: unreadNotificationCount(db, id),
    total: Number(total?.c ?? 0),
  };
}

export function getNotificationForAdmin(db, { adminUserId, notificationId } = {}) {
  const row = db.prepare(`
    SELECT n.*, r.start_at AS entity_start_at
      FROM notification n
      LEFT JOIN reservation r
        ON n.entity_type = 'reservation' AND n.entity_id = CAST(r.id AS TEXT)
     WHERE n.id = ? AND n.admin_user_id = ?
  `)
    .get(Number(notificationId), Number(adminUserId));
  return hydrateNotification(row);
}

export function markNotificationRead(db, { adminUserId, notificationId, now = Date.now() } = {}) {
  const uid = intOr(adminUserId, null);
  const id = intOr(notificationId, null);
  if (uid === null || id === null) throw notFound('Notification not found.');
  const row = db.prepare('SELECT * FROM notification WHERE id = ? AND admin_user_id = ?').get(id, uid);
  if (!row) throw notFound('Notification not found.');
  if (row.read_at === null || row.read_at === undefined) {
    db.prepare('UPDATE notification SET read_at = ? WHERE id = ? AND admin_user_id = ? AND read_at IS NULL')
      .run(Number(now), id, uid);
  }
  return {
    notification: getNotificationForAdmin(db, { adminUserId: uid, notificationId: id }),
    unreadCount: unreadNotificationCount(db, uid),
  };
}

export function markAllNotificationsRead(db, { adminUserId, now = Date.now() } = {}) {
  const uid = intOr(adminUserId, null);
  if (uid === null) throw validationError('A valid staff account is required.');
  const result = db.prepare(
    'UPDATE notification SET read_at = ? WHERE admin_user_id = ? AND read_at IS NULL',
  ).run(Number(now), uid);
  return { updated: Number(result.changes ?? 0), unreadCount: 0 };
}

/* ------------------------------------------------------------ creation */

/**
 * Persist one notification per active human administrator.
 *
 * Deduplication is the database's `(admin_user_id, dedupe_key)` uniqueness, so
 * webhook retries and idempotent public submissions cannot create a second
 * copy. Returns the rows that were actually inserted.
 */
export function createNotificationsForAdmins(db, {
  type,
  title,
  body,
  entityType = null,
  entityId = null,
  actionUrl = null,
  priority = NOTIFICATION_PRIORITY.NORMAL,
  dedupeKey,
  excludeAdminUserId = null,
  now = Date.now(),
} = {}) {
  if (!Object.values(NOTIFICATION_TYPE).includes(type)) {
    throw validationError('Unsupported notification type.');
  }
  if (!Object.values(NOTIFICATION_PRIORITY).includes(priority)) {
    throw validationError('Unsupported notification priority.');
  }
  const key = safeText(dedupeKey, 200);
  if (!key) throw validationError('A notification dedupe key is required.');
  const cleanTitle = safeText(title, 200);
  const cleanBody = safeText(body, 2000);
  if (!cleanTitle || !cleanBody) throw validationError('Notification title and body are required.');

  const adminIds = activeAdmins(db, excludeAdminUserId);
  const insert = db.prepare(`
    INSERT INTO notification
      (admin_user_id, type, title, body, entity_type, entity_id, action_url,
       priority, dedupe_key, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (admin_user_id, dedupe_key) DO NOTHING
  `);
  const created = [];
  for (const adminUserId of adminIds) {
    const result = insert.run(
      adminUserId,
      type,
      cleanTitle,
      cleanBody,
      entityType ? safeText(entityType, 60) : null,
      entityId === null || entityId === undefined ? null : safeText(entityId, 120),
      actionUrl ? safeAdminPath(actionUrl) : null,
      priority,
      key,
      Number(now),
    );
    if (Number(result.changes ?? 0) > 0) created.push(adminUserId);
  }
  return { created: created.length, adminCount: adminIds.length, adminUserIds: created };
}

/**
 * Reminders for confirmed reservations starting inside the catch-up window.
 *
 * The primary scheduling target is 30 minutes before start. A five-minute cron
 * naturally lands somewhere in the 30-35 minute band; if a tick was missed, or
 * a booking was created late, the whole `(now, now + 35m]` window is scanned so
 * the reminder still arrives rather than silently disappearing. Dedupe makes
 * repeated ticks harmless.
 */
export function createDueReminders(db, {
  now = Date.now(),
  windowMinutes = REMINDER_WINDOW_MINUTES,
  limit = 200,
} = {}) {
  const from = Number(now);
  const until = from + Math.max(1, intOr(windowMinutes, REMINDER_WINDOW_MINUTES)) * MINUTE_MS;
  const reservations = db.prepare(`
    SELECT r.id, r.reference, r.start_at, r.end_at,
           s.code AS space_code, s.name AS space_name
      FROM reservation r
      JOIN space s ON s.id = r.space_id
     WHERE r.status = 'CONFIRMED'
       AND r.start_at > ?
       AND r.start_at <= ?
     ORDER BY r.start_at ASC, r.id ASC
     LIMIT ?
  `).all(from, until, Math.min(Math.max(intOr(limit, 200), 1), 500));

  let created = 0;
  const reservationIds = [];
  for (const reservation of reservations) {
    const when = formatWindow(reservation.start_at, reservation.end_at);
    const minutesUntilStart = Math.max(1, Math.ceil((Number(reservation.start_at) - from) / MINUTE_MS));
    const result = createNotificationsForAdmins(db, {
      type: NOTIFICATION_TYPE.REMINDER,
      title: `Room prep in ${minutesUntilStart} minute${minutesUntilStart === 1 ? '' : 's'}`,
      body: `${reservation.space_name} (${reservation.space_code}) starts at `
        + `${businessTimeLabel(reservation.start_at)}${when ? ` · ${when}` : ''}. `
        + `Reference ${reservation.reference}. Please make sure the room is ready.`,
      entityType: 'reservation',
      entityId: String(reservation.id),
      actionUrl: `/admin/reservations/${reservation.id}`,
      priority: NOTIFICATION_PRIORITY.HIGH,
      dedupeKey: `reminder:reservation:${reservation.id}`,
      now,
    });
    created += result.created;
    if (result.created > 0) reservationIds.push(Number(reservation.id));
  }
  return {
    scanned: reservations.length,
    created,
    reservationsWithNew: reservationIds.length,
    reservationIds,
  };
}

/* ---------------------------------------------------------- push payload */

function entitySummary(db, notification) {
  const idText = String(notification?.entityId ?? '');
  if (!/^\d+$/.test(idText)) return null;
  const id = Number(idText);
  if (notification.entityType === 'reservation') {
    return db.prepare(`
      SELECT r.reference, r.start_at, r.end_at, s.code AS space_code, s.name AS space_name
        FROM reservation r JOIN space s ON s.id = r.space_id
       WHERE r.id = ?
    `).get(id) ?? null;
  }
  if (notification.entityType === 'booking_request') {
    return db.prepare(`
      SELECT br.reference, br.start_at, br.end_at, s.code AS space_code, s.name AS space_name
        FROM booking_request br JOIN space s ON s.id = br.space_id
       WHERE br.id = ?
    `).get(id) ?? null;
  }
  return null;
}

/**
 * Build the lock-screen payload. This function intentionally never reads
 * `notification.body`: that field may contain a customer name for the in-app
 * card, while the push payload must not.
 */
export function buildPushPayload(db, notification, { now = Date.now() } = {}) {
  const summary = entitySummary(db, notification);
  const windowText = summary ? formatWindow(summary.start_at, summary.end_at) : '';
  const reference = summary?.reference ? String(summary.reference) : '';
  const spaceCode = summary?.space_code ? String(summary.space_code) : '';
  const safeParts = [spaceCode, windowText, reference].filter(Boolean);
  const type = notification.type;

  let title;
  let fallbackBody;
  if (type === NOTIFICATION_TYPE.REMINDER) {
    const minutesUntilStart = summary?.start_at
      ? Math.max(1, Math.ceil((Number(summary.start_at) - Number(now)) / MINUTE_MS))
      : REMINDER_LEAD_MINUTES;
    title = `Room prep in ${minutesUntilStart} minute${minutesUntilStart === 1 ? '' : 's'}`;
    fallbackBody = 'A room-preparation reminder is waiting in the admin console.';
  } else if (type === NOTIFICATION_TYPE.NEW_BOOKING) {
    title = 'New booking';
    fallbackBody = 'A new booking is waiting in the admin console.';
  } else if (type === NOTIFICATION_TYPE.BOOKING_CANCELLED) {
    title = 'Booking cancelled';
    fallbackBody = 'A booking was cancelled. Open the admin console for details.';
  } else {
    title = 'TRACE operations';
    fallbackBody = 'Open the admin console for details.';
  }

  const priority = notification.priority === NOTIFICATION_PRIORITY.HIGH
    ? NOTIFICATION_PRIORITY.HIGH : NOTIFICATION_PRIORITY.NORMAL;
  const payload = {
    type,
    title,
    body: safeParts.length > 0 ? safeParts.join(' · ') : fallbackBody,
    tag: `trace-${String(type || 'notification').toLowerCase()}-${notification.id}`,
    actionUrl: safeAdminPath(notification.actionUrl),
    url: safeAdminPath(notification.actionUrl),
    priority,
    requireInteraction: priority === NOTIFICATION_PRIORITY.HIGH,
    notificationId: Number(notification.id),
    timestamp: Number(now),
  };
  return { payload, urgency: priority === NOTIFICATION_PRIORITY.HIGH ? 'high' : 'normal' };
}

/* ----------------------------------------------------------- push state */

export function activePushSubscriptions(db, adminUserId) {
  return db.prepare(`
    SELECT id, admin_user_id, endpoint, p256dh, auth, user_agent, created_at,
           last_success_at, failure_count, revoked_at
      FROM push_subscription
     WHERE admin_user_id = ? AND revoked_at IS NULL AND failure_count < 5
     ORDER BY id ASC
     LIMIT ?
  `).all(Number(adminUserId), MAX_SUBSCRIPTIONS_PER_ADMIN);
}

export function countActivePushSubscriptions(db, adminUserId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM push_subscription
     WHERE admin_user_id = ? AND revoked_at IS NULL AND failure_count < 5
  `).get(Number(adminUserId));
  return Number(row?.c ?? 0);
}

function recordSubscriptionSuccess(db, subscriptionId, now) {
  db.prepare(`
    UPDATE push_subscription
       SET last_success_at = ?, failure_count = 0
     WHERE id = ?
  `).run(Number(now), Number(subscriptionId));
}

function recordSubscriptionFailure(db, subscriptionId, error, now) {
  if (isGone(error)) {
    db.prepare('UPDATE push_subscription SET failure_count = failure_count + 1, revoked_at = ? WHERE id = ?')
      .run(Number(now), Number(subscriptionId));
    return;
  }
  db.prepare('UPDATE push_subscription SET failure_count = failure_count + 1 WHERE id = ?')
    .run(Number(subscriptionId));
}

function markNotificationPushed(db, notificationId, now) {
  db.prepare('UPDATE notification SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL')
    .run(Number(now), Number(notificationId));
}

/**
 * Send every notification whose `pushed_at` is still NULL, including the ones
 * a previous serverless invocation did not get to. With no active subscription
 * the row is marked as handled so the retry scan does not grow forever; the
 * in-app notification remains available.
 */
export async function dispatchPendingNotifications(db, {
  now = Date.now(),
  limit = 100,
  pushSender = null,
  env = process.env,
} = {}) {
  const vapid = vapidConfig(env);
  if (!vapid.configured) {
    return { configured: false, scanned: 0, delivered: 0, failed: 0, skipped: 0, errors: [] };
  }
  const sender = typeof pushSender === 'function' ? pushSender : sendWebPush;
  const rows = db.prepare(`
    SELECT * FROM notification
     WHERE pushed_at IS NULL AND created_at <= ?
     ORDER BY CASE WHEN priority = 'HIGH' THEN 0 ELSE 1 END, created_at ASC, id ASC
     LIMIT ?
  `).all(Number(now), Math.min(Math.max(intOr(limit, 100), 1), 200));

  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  const errors = [];

  for (const row of rows) {
    if (!recipientIsActive(db, row.admin_user_id)) {
      markNotificationPushed(db, row.id, now);
      skipped += 1;
      continue;
    }
    const subscriptions = activePushSubscriptions(db, row.admin_user_id);
    if (subscriptions.length === 0) {
      markNotificationPushed(db, row.id, now);
      skipped += 1;
      continue;
    }

    let built;
    try {
      built = buildPushPayload(db, hydrateNotification(row), { now });
    } catch (error) {
      failed += 1;
      errors.push({ notificationId: Number(row.id), ...safeFailure(error) });
      continue;
    }

    let sent = 0;
    for (const subscription of subscriptions) {
      try {
        await sender({
          subscription: {
            id: subscription.id,
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
          payload: built.payload,
          urgency: built.urgency,
          vapid,
        });
        recordSubscriptionSuccess(db, subscription.id, now);
        sent += 1;
      } catch (error) {
        recordSubscriptionFailure(db, subscription.id, error, now);
        errors.push({ notificationId: Number(row.id), ...safeFailure(error) });
      }
    }

    if (sent > 0) {
      markNotificationPushed(db, row.id, now);
      delivered += 1;
    } else {
      failed += 1;
    }
  }

  return {
    configured: true,
    scanned: rows.length,
    delivered,
    failed,
    skipped,
    errors: errors.slice(0, 20),
  };
}

/* --------------------------------------------------------- reminder mail */

/**
 * One email per reservation reminder, regardless of how many administrators
 * received the in-app copy. Only used when SMTP and an admin recipient are
 * configured; failures leave `email_sent_at` NULL for the next cron retry.
 */
export async function dispatchPendingReminderEmails(db, {
  now = Date.now(),
  limit = 50,
  mailSender = null,
  env = process.env,
  to = null,
} = {}) {
  const config = mailerConfig();
  const recipient = String(to ?? config.to ?? '').trim();
  const sender = typeof mailSender === 'function' ? mailSender : sendMail;
  if (!mailSender && !config.configured) {
    return { configured: false, reason: 'SMTP_NOT_CONFIGURED', sent: 0, failed: 0, groups: 0 };
  }
  if (!recipient) {
    return { configured: false, reason: 'NO_ADMIN_RECIPIENT', sent: 0, failed: 0, groups: 0 };
  }

  const rows = db.prepare(`
    SELECT n.id, n.entity_id, n.created_at,
           r.id AS reservation_id, r.reference, r.start_at, r.end_at,
           s.code AS space_code, s.name AS space_name
      FROM notification n
      JOIN reservation r
        ON n.entity_type = 'reservation' AND n.entity_id = CAST(r.id AS TEXT)
      JOIN space s ON s.id = r.space_id
     WHERE n.type = 'REMINDER'
       AND n.email_sent_at IS NULL
       AND n.created_at <= ?
     ORDER BY r.start_at ASC, n.id ASC
     LIMIT ?
  `).all(Number(now), Math.min(Math.max(intOr(limit, 50), 1), 200));

  const groups = new Map();
  for (const row of rows) {
    const id = Number(row.reservation_id);
    if (!groups.has(id)) groups.set(id, { rows: [], row });
    groups.get(id).rows.push(row);
  }

  const baseUrl = String(env?.NAGARO_BASE_URL || process.env.NAGARO_BASE_URL || 'http://127.0.0.1:4173')
    .replace(/\/+$/, '');
  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const [reservationId, group] of groups) {
    const row = group.row;
    const content = reminderEmail({
      reservation: {
        id: reservationId,
        reference: row.reference,
        startAt: Number(row.start_at),
        endAt: Number(row.end_at),
      },
      space: { code: row.space_code, name: row.space_name },
      adminUrl: `${baseUrl}/admin/reservations/${reservationId}`,
    });
    try {
      const result = await sender({ to: recipient, ...content });
      const accepted = !result || result.status === 'SENT' || result.status === undefined;
      if (!accepted) {
        failed += 1;
        errors.push({ reservationId, status: safeText(result?.status, 40) });
        continue;
      }
      db.prepare(`
        UPDATE notification
           SET email_sent_at = ?
         WHERE type = 'REMINDER'
           AND entity_type = 'reservation'
           AND entity_id = CAST(? AS TEXT)
           AND email_sent_at IS NULL
      `).run(Number(now), String(reservationId));
      sent += 1;
    } catch (error) {
      failed += 1;
      errors.push({ reservationId, ...safeFailure(error) });
    }
  }

  return {
    configured: true,
    recipient,
    sent,
    failed,
    groups: groups.size,
    errors: errors.slice(0, 20),
  };
}

/* ------------------------------------------------------ subscription CRUD */

export function prunePushSubscriptions(db, { now = Date.now() } = {}) {
  void now;
  const result = db.prepare(
    'DELETE FROM push_subscription WHERE revoked_at IS NOT NULL OR failure_count >= 5',
  ).run();
  return Number(result.changes ?? 0);
}

/** Validate a browser PushSubscription JSON object. */
export function normalisePushSubscription(input, { userAgent = null } = {}) {
  const raw = input?.subscription ?? input ?? {};
  const endpoint = String(raw.endpoint ?? '').trim();
  if (!endpoint) throw validationError('The push subscription endpoint is required.', { endpoint: 'Required.' });
  if (endpoint.length > 2048) {
    throw validationError('The push subscription endpoint is too long.', { endpoint: 'Too long.' });
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw validationError('The push subscription endpoint is not a valid URL.', { endpoint: 'Invalid URL.' });
  }
  const localHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) {
    throw validationError('The push subscription endpoint must use HTTPS.', { endpoint: 'HTTPS required.' });
  }
  if (url.username || url.password) {
    throw validationError('The push subscription endpoint must not contain credentials.', { endpoint: 'Invalid endpoint.' });
  }

  const keys = raw.keys ?? {};
  const p256dh = String(keys.p256dh ?? raw.p256dh ?? '').trim();
  const auth = String(keys.auth ?? raw.auth ?? '').trim();
  if (p256dh.length < 20 || p256dh.length > 200 || !BASE64URL_PATTERN.test(p256dh)) {
    throw validationError('The push subscription public key is invalid.', { keys: 'Invalid p256dh key.' });
  }
  if (auth.length < 8 || auth.length > 100 || !BASE64URL_PATTERN.test(auth)) {
    throw validationError('The push subscription authentication secret is invalid.', { keys: 'Invalid auth secret.' });
  }

  return {
    endpoint,
    p256dh,
    auth,
    userAgent: userAgent ? safeText(userAgent, 300) : null,
  };
}

export function savePushSubscription(db, {
  adminUserId,
  subscription,
  userAgent = null,
  now = Date.now(),
} = {}) {
  const uid = intOr(adminUserId, null);
  if (uid === null || uid < 1) throw validationError('A valid staff account is required.');
  const value = normalisePushSubscription(subscription, { userAgent });
  const endpointOwner = db.prepare('SELECT admin_user_id FROM push_subscription WHERE endpoint = ?')
    .get(value.endpoint);
  if (endpointOwner && Number(endpointOwner.admin_user_id) !== uid) {
    // A browser endpoint is effectively a delivery credential. Never let one
    // authenticated account claim another account's endpoint.
    throw conflict('This desktop-alert subscription belongs to another account.');
  }
  const existing = db.prepare(`
    SELECT id FROM push_subscription
     WHERE admin_user_id = ? AND endpoint <> ?
       AND revoked_at IS NULL AND failure_count < 5
  `).all(uid, value.endpoint);
  if (existing.length >= MAX_SUBSCRIPTIONS_PER_ADMIN) {
    throw validationError('Too many desktop-alert subscriptions for this account. Remove one first.');
  }

  db.prepare(`
    INSERT INTO push_subscription
      (admin_user_id, endpoint, p256dh, auth, user_agent, created_at,
       last_success_at, failure_count, revoked_at)
    VALUES (?,?,?,?,?,?,NULL,0,NULL)
    ON CONFLICT (endpoint) DO UPDATE SET
      admin_user_id = excluded.admin_user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = excluded.user_agent,
      failure_count = 0,
      revoked_at = NULL
  `).run(uid, value.endpoint, value.p256dh, value.auth, value.userAgent, Number(now));

  const row = db.prepare('SELECT id, created_at FROM push_subscription WHERE endpoint = ?')
    .get(value.endpoint);
  return {
    id: Number(row.id),
    createdAt: Number(row.created_at),
    endpointHost: new URL(value.endpoint).host,
  };
}

export function revokePushSubscription(db, {
  adminUserId,
  endpoint,
  now = Date.now(),
} = {}) {
  const uid = intOr(adminUserId, null);
  const value = String(endpoint ?? '').trim();
  if (uid === null || !value) throw validationError('A push subscription endpoint is required.');
  const result = db.prepare(`
    UPDATE push_subscription
       SET revoked_at = ?
     WHERE admin_user_id = ? AND endpoint = ? AND revoked_at IS NULL
  `).run(Number(now), uid, value.slice(0, 2048));
  return { removed: Number(result.changes ?? 0) > 0 };
}

/* ----------------------------------------------------------- test push */

/** Send a test notification to the current administrator's devices. */
export async function sendTestPush(db, {
  adminUserId,
  now = Date.now(),
  pushSender = null,
  env = process.env,
} = {}) {
  const vapid = vapidConfig(env);
  if (!vapid.configured) {
    throw conflict('Desktop alerts are not configured on this server yet (VAPID keys are missing).');
  }
  const subscriptions = activePushSubscriptions(db, adminUserId);
  if (subscriptions.length === 0) {
    throw validationError('Enable desktop alerts on at least one browser first.');
  }
  const sender = typeof pushSender === 'function' ? pushSender : sendWebPush;
  const payload = {
    type: 'TEST',
    title: 'TRACE admin alerts are working',
    body: 'This is a test notification. Room-preparation reminders will look like this.',
    tag: `trace-test-${Number(now)}`,
    actionUrl: '/admin/notifications',
    url: '/admin/notifications',
    priority: NOTIFICATION_PRIORITY.NORMAL,
    requireInteraction: false,
    notificationId: null,
    timestamp: Number(now),
  };
  let sent = 0;
  let failed = 0;
  const errors = [];
  for (const subscription of subscriptions) {
    try {
      await sender({
        subscription: {
          id: subscription.id,
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
        payload,
        urgency: 'normal',
        vapid,
      });
      recordSubscriptionSuccess(db, subscription.id, now);
      sent += 1;
    } catch (error) {
      recordSubscriptionFailure(db, subscription.id, error, now);
      failed += 1;
      errors.push(safeFailure(error));
    }
  }
  return { total: subscriptions.length, sent, failed, errors: errors.slice(0, 10) };
}

/* ------------------------------------------------------ deferred dispatch */

/**
 * Best-effort immediate push after a booking write. The notification is already
 * persisted; if this timer is cut short by a serverless freeze the secured cron
 * tick sends it instead. Timers are unref'd so tests and short-lived CLIs exit.
 */
export function schedulePendingDispatch(db, { now = Date.now() } = {}) {
  if (!vapidConfig().configured) return false;
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM push_subscription
     WHERE revoked_at IS NULL AND failure_count < 5
  `).get();
  if (Number(row?.c ?? 0) === 0) return false;
  const timer = setTimeout(() => {
    dispatchPendingNotifications(db, { now, limit: 25 })
      .catch((error) => console.warn('[notifications] deferred push dispatch failed:', error?.code ?? 'unknown'));
  }, 0);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return true;
}
