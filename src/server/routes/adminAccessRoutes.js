/**
 * Staff console for smart access.
 *
 *   GET  /admin/access                     doors, assistance queue, extensions
 *   GET  /admin/access/settings            policy + per-room controllers (admin)
 *   POST /admin/access/settings/policy
 *   POST /admin/access/settings/spaces/:id
 *   POST /admin/access/doors/:spaceId/command          staff lock / timed unlock
 *   POST /admin/access/assistance/:id/acknowledge|resolve
 *   POST /admin/access/extensions/:id/approve|reject|desk-paid|resolve
 *   POST /admin/reservations/:id/access/issue|reissue|revoke-door|restore-door|revoke-link|extend
 *
 * Every state change requires a signed-in member of staff and a CSRF token;
 * policy and controller settings additionally require an administrator.
 */
import { redirect } from '../http/response.js';
import { forbidden, notFound } from '../domain/errors.js';
import { isAdminRole } from '../domain/constants.js';
import { mailerConfig } from '../mail/mailer.js';
import { smsConfig } from '../sms/smsSender.js';
import {
  effectiveAccessConfig, getAccessPolicy, getSpaceAccessConfig, updateAccessPolicy, updateSpaceAccessConfig,
} from '../services/accessPolicyService.js';
import {
  afterReservationConfirmed, getAccessLinkForReservation, issueAccessLink, deliverAccessLink, reissueAccessLink,
  restoreDoorAccess, revokeAccessLink, revokeDoorAccess,
} from '../services/accessLinkService.js';
import {
  executeDoorCommand, getDoorSnapshot, kickDoorQueue, listDoorActivity, requestStaffDoorCommand,
} from '../services/doorService.js';
import { controllerSecret } from '../services/doorDrivers.js';
import {
  approveExtension, confirmDeskPayment, grantExtension, hourlyEquivalentCents, listExtensions, payHereConfigured,
  rejectExtension, resolveExtensionException,
} from '../services/extensionService.js';
import { acknowledgeAssistance, listAssistanceRequests, resolveAssistance } from '../services/assistanceService.js';
import { runDueDoorWork } from '../services/accessWorker.js';
import { renderAccessConsolePage, renderAccessSettingsPage } from '../../web/views/admin/accessViews.js';

function first(value) { return Array.isArray(value) ? value[0] : value; }

function health(config) {
  const sms = smsConfig();
  return {
    mail: mailerConfig().configured,
    sms: sms.configured,
    smsProvider: sms.provider,
    payHere: payHereConfigured(config.payHere),
    payHereSandbox: config.payHere?.sandbox !== false,
    controllerSecret: Boolean(controllerSecret()),
    scheduler: Boolean(String(process.env.CRON_SECRET ?? '').trim()) || !config.isVercel,
    simulator: process.env.NAGARO_DOOR_SIMULATOR === '1',
  };
}

function doorOverview(db, now) {
  const spaces = db.prepare(`SELECT s.id, s.code, s.name FROM space s JOIN space_access_config c ON c.space_id = s.id
     WHERE s.status <> 'ARCHIVED' AND (c.door_enabled = 1 OR c.driver <> 'NONE') ORDER BY s.code`).all();
  return spaces.map((space) => {
    const config = getSpaceAccessConfig(db, space.id);
    const current = db.prepare(`SELECT r.id, r.reference, r.end_at, c.full_name AS customer_name FROM reservation r JOIN customer c ON c.id = r.customer_id
       WHERE r.space_id = ? AND r.status = 'CONFIRMED' AND r.start_at <= ? AND r.end_at > ? ORDER BY r.start_at LIMIT 1`).get(space.id, now, now);
    return {
      space: { id: Number(space.id), code: space.code, name: space.name },
      config,
      ready: effectiveAccessConfig(db, space.id).doorReady,
      snapshot: getDoorSnapshot(db, space.id, { now }),
      current: current ? { id: Number(current.id), reference: current.reference, endAt: Number(current.end_at), customerName: current.customer_name } : null,
    };
  });
}

export function registerAdminAccessRoutes(router, deps = {}) {
  const { db, config, setFlash, requireAuth, requireCsrf } = deps;

  const staff = async (ctx) => { const actor = requireAuth(ctx); await ctx.readBody(); requireCsrf(ctx); return actor; };
  const done = (ctx, target, message, kind = 'success') => {
    if (message) setFlash(ctx, { kind, message });
    redirect(ctx.res, target);
    ctx.responded = true;
  };
  const reservationOr404 = (id) => {
    const row = /^\d+$/.test(String(id)) ? db.prepare('SELECT id, reference, status FROM reservation WHERE id = ?').get(Number(id)) : null;
    if (!row) throw notFound('Reservation not found.');
    return row;
  };

  /* --------------------------------------------------------------- console */

  router.get('/admin/access', async (ctx) => {
    const actor = requireAuth(ctx);
    await runDueDoorWork(db);
    const now = Date.now();
    ctx.html(renderAccessConsolePage({
      actor, csrfToken: ctx.csrfToken, flash: ctx.flash, isAdmin: isAdminRole(actor.role), health: health(config),
      assistance: listAssistanceRequests(db, { open: true }),
      attention: [
        ...listExtensions(db, { statuses: ['REVIEW_REQUIRED'], limit: 50 }),
        ...listExtensions(db, { statuses: ['AWAITING_APPROVAL'], limit: 50 }),
        ...listExtensions(db, { statuses: ['AWAITING_PAYMENT'], limit: 50 }).filter((item) => item.method === 'DESK'),
      ],
      doors: doorOverview(db, now),
      activity: listDoorActivity(db, { limit: 40 }),
      recentExtensions: listExtensions(db, { limit: 20 }),
    }));
  });

  router.post('/admin/access/doors/:spaceId/command', async (ctx) => {
    const actor = await staff(ctx);
    const { command } = requestStaffDoorCommand(db, { actor, spaceId: ctx.params.spaceId, action: first(ctx.body.action), minutes: first(ctx.body.minutes) ?? 5 });
    const outcome = await executeDoorCommand(db, command.id);
    const verb = command.action === 'OPEN' ? 'unlock' : 'lock';
    if (outcome?.status === 'CONFIRMED') done(ctx, '/admin/access', `The door confirmed the ${verb}.`);
    else if (outcome?.status === 'ACKNOWLEDGED') done(ctx, '/admin/access', `The ${verb} command was sent. This controller does not confirm the door state.`, 'warning');
    else if (outcome?.status === 'PENDING') done(ctx, '/admin/access', 'The door did not confirm yet. The system keeps retrying; check the door if this persists.', 'warning');
    else done(ctx, '/admin/access', `The door did not accept the ${verb} command: ${outcome?.lastError ?? 'no response'}`, 'error');
  });

  /* ------------------------------------------------------------ assistance */

  router.post('/admin/access/assistance/:id/acknowledge', async (ctx) => {
    const actor = await staff(ctx);
    acknowledgeAssistance(db, { actor, requestId: ctx.params.id });
    done(ctx, '/admin/access', 'The customer can see that you are on your way.');
  });

  router.post('/admin/access/assistance/:id/resolve', async (ctx) => {
    const actor = await staff(ctx);
    resolveAssistance(db, { actor, requestId: ctx.params.id, note: first(ctx.body.note) });
    done(ctx, '/admin/access', 'Assistance request resolved.');
  });

  /* ------------------------------------------------------------ extensions */

  router.post('/admin/access/extensions/:id/approve', async (ctx) => {
    const actor = await staff(ctx);
    approveExtension(db, { actor, extensionId: ctx.params.id });
    done(ctx, '/admin/access', 'Extension approved. The customer can pay now.');
  });

  router.post('/admin/access/extensions/:id/reject', async (ctx) => {
    const actor = await staff(ctx);
    rejectExtension(db, { actor, extensionId: ctx.params.id });
    done(ctx, '/admin/access', 'Extension declined and the held time released.');
  });

  router.post('/admin/access/extensions/:id/desk-paid', async (ctx) => {
    const actor = await staff(ctx);
    const extension = confirmDeskPayment(db, { actor, extensionId: ctx.params.id });
    done(ctx, '/admin/access', `Payment recorded. ${extension.reservationReference} now ends at a later time.`);
  });

  router.post('/admin/access/extensions/:id/resolve', async (ctx) => {
    const actor = await staff(ctx);
    resolveExtensionException(db, { actor, extensionId: ctx.params.id, outcome: first(ctx.body.outcome), note: first(ctx.body.note) });
    done(ctx, '/admin/access', 'Payment exception resolved.');
  });

  /* --------------------------------------------------------------- settings */

  const requireAdministrator = (ctx) => {
    const actor = requireAuth(ctx);
    if (!isAdminRole(actor.role)) throw forbidden('This page requires an administrator role.');
    return actor;
  };

  router.get('/admin/access/settings', async (ctx) => {
    const actor = requireAdministrator(ctx);
    const spaces = db.prepare("SELECT * FROM space WHERE status <> 'ARCHIVED' ORDER BY code").all().map((space) => ({
      space: { id: Number(space.id), code: space.code, name: space.name, currency: space.currency },
      config: getSpaceAccessConfig(db, space.id),
      hourlyCents: hourlyEquivalentCents(db, space),
    }));
    ctx.html(renderAccessSettingsPage({ actor, csrfToken: ctx.csrfToken, flash: ctx.flash, policy: getAccessPolicy(db), spaces, health: health(config) }));
  });

  router.post('/admin/access/settings/policy', async (ctx) => {
    const actor = await staff(ctx);
    updateAccessPolicy(db, { actor, body: ctx.body });
    done(ctx, '/admin/access/settings', 'Access policy saved.');
  });

  router.post('/admin/access/settings/spaces/:id', async (ctx) => {
    const actor = await staff(ctx);
    updateSpaceAccessConfig(db, { actor, spaceId: ctx.params.id, body: ctx.body });
    done(ctx, '/admin/access/settings', 'Room access settings saved.');
  });

  /* ------------------------------------------- reservation-level actions */

  router.post('/admin/reservations/:id/access/issue', async (ctx) => {
    const actor = await staff(ctx);
    const reservation = reservationOr404(ctx.params.id);
    const result = issueAccessLink(db, { reservationId: reservation.id, actor });
    if (result.created) await deliverAccessLink(db, { linkId: result.link.id, baseUrl: config.baseUrl });
    done(ctx, `/admin/reservations/${reservation.id}`, result.created ? 'Access link issued and sent to the customer.' : 'This booking already has an access link.');
  });

  router.post('/admin/reservations/:id/access/reissue', async (ctx) => {
    const actor = await staff(ctx);
    const reservation = reservationOr404(ctx.params.id);
    if (!getAccessLinkForReservation(db, reservation.id)) afterReservationConfirmed(db, { reservationId: reservation.id });
    const { url } = reissueAccessLink(db, { actor, reservationId: reservation.id, baseUrl: config.baseUrl });
    // Shown once so staff can hand it over directly if the customer has no signal.
    done(ctx, `/admin/reservations/${reservation.id}`, `A new access link was sent and the old one no longer works. New link: ${url}`);
  });

  router.post('/admin/reservations/:id/access/revoke-door', async (ctx) => {
    const actor = await staff(ctx);
    const reservation = reservationOr404(ctx.params.id);
    revokeDoorAccess(db, { actor, reservationId: reservation.id, reason: first(ctx.body.reason) });
    kickDoorQueue(db);
    done(ctx, `/admin/reservations/${reservation.id}`, 'Door access turned off for this booking.');
  });

  router.post('/admin/reservations/:id/access/restore-door', async (ctx) => {
    const actor = await staff(ctx);
    const reservation = reservationOr404(ctx.params.id);
    restoreDoorAccess(db, { actor, reservationId: reservation.id });
    done(ctx, `/admin/reservations/${reservation.id}`, 'Door access restored for this booking.');
  });

  router.post('/admin/reservations/:id/access/revoke-link', async (ctx) => {
    const actor = await staff(ctx);
    const reservation = reservationOr404(ctx.params.id);
    revokeAccessLink(db, { actor, reservationId: reservation.id });
    kickDoorQueue(db);
    done(ctx, `/admin/reservations/${reservation.id}`, 'Access link revoked.');
  });

  router.post('/admin/reservations/:id/access/extend', async (ctx) => {
    const actor = await staff(ctx);
    const reservation = reservationOr404(ctx.params.id);
    grantExtension(db, { actor, reservationId: reservation.id, method: first(ctx.body.method) });
    done(ctx, `/admin/reservations/${reservation.id}`, '15 minutes added to this booking.');
  });
}
