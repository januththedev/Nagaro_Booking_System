/**
 * Admin notification routes and Web Push subscription endpoints.
 *
 * All reads require an authenticated administrator. Mutations additionally
 * require the same CSRF token as the rest of the console; browser code sends
 * it in the `x-csrf-token` header.
 */
import { requireAuth, requireCsrf } from '../security/sessions.js';
import {
  countActivePushSubscriptions,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  normalisePushSubscription,
  revokePushSubscription,
  savePushSubscription,
  sendTestPush,
} from '../services/notificationService.js';
import { vapidConfig, vapidPublicKey } from '../services/pushService.js';
import { renderNotificationsPage } from '../../web/views/admin/notificationViews.js';

function firstValue(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === null || first === undefined) return '';
  return String(first);
}

function intValue(value, fallback, min, max) {
  const number = Number(firstValue(value));
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function guard(ctx, deps) {
  return typeof deps.requireAuth === 'function' ? deps.requireAuth(ctx) : requireAuth(ctx);
}

function guardCsrf(ctx, deps) {
  return typeof deps.requireCsrf === 'function' ? deps.requireCsrf(ctx) : requireCsrf(ctx);
}

function currentPushState(db, adminUserId) {
  const vapid = vapidConfig();
  return {
    configured: vapid.configured,
    subscriptions: countActivePushSubscriptions(db, adminUserId),
  };
}

export function registerAdminNotificationRoutes(router, deps = {}) {
  const { db } = deps;

  router.get('/admin/notifications', async (ctx) => {
    const actor = guard(ctx, deps);
    const result = listNotifications(db, { adminUserId: actor.id, limit: 50, offset: 0 });
    const push = currentPushState(db, actor.id);
    ctx.html(renderNotificationsPage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      items: result.items,
      unreadCount: result.unreadCount,
      pushConfigured: push.configured,
      subscriptions: push.subscriptions,
    }));
  });

  router.get('/api/admin/notifications', async (ctx) => {
    const actor = guard(ctx, deps);
    const limit = intValue(ctx.query.limit, 20, 1, 100);
    const offset = intValue(ctx.query.offset, 0, 0, 100000);
    const result = listNotifications(db, { adminUserId: actor.id, limit, offset });
    const push = currentPushState(db, actor.id);
    ctx.json({
      ok: true,
      ...result,
      push: {
        configured: push.configured,
        publicKey: vapidPublicKey(),
        subscriptions: push.subscriptions,
      },
    });
  });

  router.get('/api/admin/notifications/vapid-public-key', async (ctx) => {
    guard(ctx, deps);
    const publicKey = vapidPublicKey();
    ctx.json({ ok: true, configured: Boolean(publicKey), publicKey });
  });

  router.post('/api/admin/notifications/:id/read', async (ctx) => {
    const actor = guard(ctx, deps);
    await ctx.readBody();
    guardCsrf(ctx, deps);
    const result = markNotificationRead(db, {
      adminUserId: actor.id,
      notificationId: ctx.params.id,
    });
    ctx.json({ ok: true, ...result });
  });

  router.post('/api/admin/notifications/read-all', async (ctx) => {
    const actor = guard(ctx, deps);
    await ctx.readBody();
    guardCsrf(ctx, deps);
    const result = markAllNotificationsRead(db, { adminUserId: actor.id });
    ctx.json({ ok: true, ...result });
  });

  router.post('/api/admin/notifications/subscribe', async (ctx) => {
    const actor = guard(ctx, deps);
    await ctx.readBody();
    guardCsrf(ctx, deps);
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const subscription = body.subscription ?? body;
    normalisePushSubscription(subscription, { userAgent: body.userAgent ?? ctx.req.headers['user-agent'] });
    const saved = savePushSubscription(db, {
      adminUserId: actor.id,
      subscription,
      userAgent: body.userAgent ?? ctx.req.headers['user-agent'],
    });
    ctx.json({ ok: true, subscription: saved, subscriptions: countActivePushSubscriptions(db, actor.id) });
  });

  router.post('/api/admin/notifications/unsubscribe', async (ctx) => {
    const actor = guard(ctx, deps);
    await ctx.readBody();
    guardCsrf(ctx, deps);
    const result = revokePushSubscription(db, {
      adminUserId: actor.id,
      endpoint: firstValue(ctx.body?.endpoint),
    });
    ctx.json({ ok: true, ...result, subscriptions: countActivePushSubscriptions(db, actor.id) });
  });

  router.post('/api/admin/notifications/test', async (ctx) => {
    const actor = guard(ctx, deps);
    await ctx.readBody();
    guardCsrf(ctx, deps);
    const result = await sendTestPush(db, { adminUserId: actor.id });
    ctx.json({ ok: true, ...result });
  });
}
