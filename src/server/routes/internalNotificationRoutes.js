/**
 * Secured scheduler endpoint.
 *
 * Vercel Cron (Pro) or an external scheduler calls this every five minutes.
 * The endpoint is intentionally not part of the public API: it requires
 * `CRON_SECRET` in an `Authorization: Bearer ...` header or `x-cron-secret`.
 *
 * Work performed in one tick:
 *   1. create 30-minute room-preparation reminders (idempotent);
 *   2. deliver any pending Web Push notifications;
 *   3. send reminder email fallback when SMTP is configured;
 *   4. prune revoked/failed push subscriptions;
 *   5. purge recycle-bin accounts whose 30-day window elapsed.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { forbidden, unauthorized } from '../domain/errors.js';
import { purgeDeletedAdmins } from '../services/adminUserService.js';
import {
  createDueReminders,
  dispatchPendingNotifications,
  dispatchPendingReminderEmails,
  prunePushSubscriptions,
} from '../services/notificationService.js';

function secretMatches(given, expected) {
  const left = createHash('sha256').update(String(given ?? ''), 'utf8').digest();
  const right = createHash('sha256').update(String(expected ?? ''), 'utf8').digest();
  return timingSafeEqual(left, right);
}

function authorized(ctx) {
  const expected = String(process.env.CRON_SECRET ?? '').trim();
  if (!expected) {
    if (process.env.NAGARO_ALLOW_INSECURE_CRON === '1') return true;
    throw forbidden('The notification scheduler is not configured. Set CRON_SECRET.');
  }
  const header = String(ctx.req.headers.authorization ?? '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const supplied = bearer || String(ctx.req.headers['x-cron-secret'] ?? '').trim();
  if (!supplied || !secretMatches(supplied, expected)) throw unauthorized('Invalid scheduler credentials.');
  return true;
}

async function tick(ctx, db) {
  authorized(ctx);
  const now = Date.now();
  const reminders = createDueReminders(db, { now });
  const push = await dispatchPendingNotifications(db, { now });
  const email = await dispatchPendingReminderEmails(db, { now });
  const prunedSubscriptions = prunePushSubscriptions(db, { now });
  let purge = { count: 0, purged: [] };
  try {
    purge = purgeDeletedAdmins(db, { now });
  } catch (error) {
    // A purge failure must not stop reminder delivery. The next tick retries.
    console.warn('[notifications] recycle-bin purge failed:', error?.code ?? error?.message ?? 'unknown');
  }
  ctx.json({
    ok: true,
    at: now,
    reminders,
    push,
    email,
    prunedSubscriptions,
    purgedAdmins: purge.count,
  });
}

export function registerInternalNotificationRoutes(router, deps = {}) {
  const { db } = deps;
  router.post('/api/internal/notifications/tick', async (ctx) => {
    await ctx.readBody();
    await tick(ctx, db);
  });
  // Vercel Cron sends GET by default. Supporting both keeps the endpoint easy
  // to schedule with either Vercel or an external HTTP scheduler.
  router.get('/api/internal/notifications/tick', async (ctx) => {
    await tick(ctx, db);
  });
}
