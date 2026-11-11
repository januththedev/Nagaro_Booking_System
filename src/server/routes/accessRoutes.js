/**
 * Customer smart-access endpoints.
 *
 *   GET  /access/:token                 the room-access page (capability URL)
 *   GET  /access/return                 where PayHere sends the browser back
 *   GET  /api/access/state              server-authoritative state (polled)
 *   POST /api/access/door               OPEN / CLOSE
 *   POST /api/access/extension          start a 15-minute extension
 *   POST /api/access/extension/cancel   abandon an unpaid extension
 *   POST /api/access/extension/seen     dismiss the one-time result notice
 *   POST /api/access/assistance         ask staff for help
 *   POST /api/access/verify             optional phone check
 *   POST /api/public/payments/payhere/extension-notify   PayHere server callback
 *   POST /api/internal/door/status      signed controller state report
 *
 * The API takes the token in the `X-Access-Token` header, never in a query
 * string, so it cannot leak through logs, analytics or a Referer header.
 * Every response is `no-store` with `Referrer-Policy: no-referrer`.
 */
import { clientIp, readRawBody } from '../http/request.js';
import { appendCookie, redirect, serializeCookie } from '../http/response.js';
import { enforce, ipBucket } from '../security/rateLimit.js';
import { AppError, validationError } from '../domain/errors.js';
import {
  isDeviceVerified, markAccessOpened, resolveAccess, verifyPhoneLastFour,
} from '../services/accessLinkService.js';
import { buildAccessState } from '../services/accessStateService.js';
import { executeDoorCommand, recordControllerStatus, requestCustomerDoorCommand } from '../services/doorService.js';
import { controllerSecret, verifyControllerSignature } from '../services/doorDrivers.js';
import {
  cancelExtension, markExtensionSeen, processExtensionNotification, startExtension,
} from '../services/extensionService.js';
import { requestAssistance } from '../services/assistanceService.js';
import { runDueDoorWork } from '../services/accessWorker.js';
import { renderAccessPage, renderAccessUnavailablePage, resolveAccessLocale } from '../../web/views/accessViews.js';

const ACCESS_COOKIE = 'nagaro_access';
const DEVICE_COOKIE = 'nagaro_access_device';
const DAY_SECONDS = 24 * 60 * 60;

function first(value) { return Array.isArray(value) ? value[0] : value; }

/** Headers for every capability response. PayHere's checkout host is the only allowed external form target. */
function protect(ctx, { html = false } = {}) {
  ctx.setHeader('Cache-Control', 'no-store, private');
  ctx.setHeader('Referrer-Policy', 'no-referrer');
  ctx.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  if (html) {
    ctx.setHeader('Content-Security-Policy', [
      "default-src 'self'", "img-src 'self' data:", "style-src 'self'", "script-src 'self'", "connect-src 'self'",
      "form-action 'self' https://sandbox.payhere.lk https://www.payhere.lk", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    ].join('; '));
  }
}

function tokenFrom(ctx) {
  return String(ctx.req.headers['x-access-token'] ?? '').trim();
}

export function registerAccessRoutes(router, deps = {}) {
  const { db, config } = deps;

  /** Authenticate the API caller; guessing attempts are throttled per address. */
  function authenticate(ctx, now) {
    try {
      return resolveAccess(db, tokenFrom(ctx), { now });
    } catch (error) {
      if (error instanceof AppError && error.code === 'ACCESS_LINK_INVALID') {
        enforce(db, ipBucket('access-miss', clientIp(ctx.req)), { limit: 30, windowMs: 10 * 60_000 });
      }
      throw error;
    }
  }

  function stateFor(ctx, access, now) {
    const verified = isDeviceVerified(db, access, ctx.cookies?.[DEVICE_COOKIE]);
    return buildAccessState(db, { access, payHere: config.payHere, verified, now });
  }

  function requireVerified(ctx, access) {
    if (!isDeviceVerified(db, access, ctx.cookies?.[DEVICE_COOKIE])) {
      const error = new AppError('VERIFICATION_REQUIRED', 'Confirm the phone number on this booking first.', { status: 403 });
      throw error;
    }
  }

  /* ---------------------------------------------------------------- pages */

  router.get('/access/return', async (ctx) => {
    protect(ctx, { html: true });
    const token = String(ctx.cookies?.[ACCESS_COOKIE] ?? '');
    if (/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      redirect(ctx.res, `/access/${token}`, 303, ctx.headers);
      ctx.responded = true;
      return;
    }
    ctx.html(renderAccessUnavailablePage({
      locale: resolveAccessLocale(ctx),
      heading: 'Return to your access link',
      message: 'Open the room access link from your SMS or email to continue. If you just paid, your extension will appear there.',
    }));
  });

  router.get('/access/:token', async (ctx) => {
    protect(ctx, { html: true });
    const now = Date.now();
    let access;
    try {
      access = resolveAccess(db, ctx.params.token, { now });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'ACCESS_LINK_INVALID') throw error;
      enforce(db, ipBucket('access-miss', clientIp(ctx.req)), { limit: 30, windowMs: 10 * 60_000 });
      ctx.html(renderAccessUnavailablePage({ locale: resolveAccessLocale(ctx) }), 404);
      return;
    }
    markAccessOpened(db, access.linkId, now);
    appendCookie(ctx.res, serializeCookie(ACCESS_COOKIE, ctx.params.token, {
      maxAgeSeconds: DAY_SECONDS, path: '/access', httpOnly: true, secure: ctx.secure ?? false, sameSite: 'Lax',
    }));
    ctx.html(renderAccessPage({
      locale: resolveAccessLocale(ctx),
      spaceName: access.reservation.space_name,
      reference: access.reservation.reference,
    }));
  });

  /* ------------------------------------------------------------------ API */

  router.get('/api/access/state', async (ctx) => {
    protect(ctx);
    authenticate(ctx, Date.now());
    // A lock that is due must not wait for the next scheduler tick while the
    // customer is looking at the page.
    await runDueDoorWork(db);
    const now = Date.now();
    ctx.json(stateFor(ctx, resolveAccess(db, tokenFrom(ctx), { now }), now));
  });

  router.post('/api/access/door', async (ctx) => {
    protect(ctx);
    const body = await ctx.readBody();
    const now = Date.now();
    const access = authenticate(ctx, now);
    requireVerified(ctx, access);
    enforce(db, `access-door:${access.linkId}`, { limit: 20, windowMs: 60_000, message: 'Too many door requests. Please wait a moment.' });
    const { command } = requestCustomerDoorCommand(db, {
      access, action: first(body.action), minutes: first(body.minutes), idempotencyKey: first(body.idempotencyKey), now,
    });
    const outcome = command.status === 'PENDING' ? await executeDoorCommand(db, command.id, { now: Date.now() }) : command;
    const after = Date.now();
    ctx.json({
      ...stateFor(ctx, resolveAccess(db, tokenFrom(ctx), { now: after }), after),
      command: { action: outcome?.action ?? command.action, status: outcome?.status ?? command.status },
    });
  });

  router.post('/api/access/extension', async (ctx) => {
    protect(ctx);
    const body = await ctx.readBody();
    const now = Date.now();
    const access = authenticate(ctx, now);
    requireVerified(ctx, access);
    enforce(db, `access-extension:${access.linkId}`, { limit: 10, windowMs: 10 * 60_000 });
    startExtension(db, { access, method: first(body.method), idempotencyKey: first(body.idempotencyKey), payHere: config.payHere, now });
    const after = Date.now();
    ctx.json(stateFor(ctx, resolveAccess(db, tokenFrom(ctx), { now: after }), after));
  });

  router.post('/api/access/extension/cancel', async (ctx) => {
    protect(ctx);
    await ctx.readBody();
    const now = Date.now();
    const access = authenticate(ctx, now);
    requireVerified(ctx, access);
    cancelExtension(db, { access, now });
    ctx.json(stateFor(ctx, resolveAccess(db, tokenFrom(ctx), { now }), now));
  });

  router.post('/api/access/extension/seen', async (ctx) => {
    protect(ctx);
    await ctx.readBody();
    const now = Date.now();
    const access = authenticate(ctx, now);
    markExtensionSeen(db, { access, now });
    ctx.json(stateFor(ctx, resolveAccess(db, tokenFrom(ctx), { now }), now));
  });

  router.post('/api/access/assistance', async (ctx) => {
    protect(ctx);
    const body = await ctx.readBody();
    const now = Date.now();
    const access = authenticate(ctx, now);
    enforce(db, `access-assist:${access.linkId}`, { limit: 6, windowMs: 10 * 60_000 });
    requestAssistance(db, { access, contextState: first(body.state), now });
    ctx.json(stateFor(ctx, resolveAccess(db, tokenFrom(ctx), { now }), now));
  });

  router.post('/api/access/verify', async (ctx) => {
    protect(ctx);
    const body = await ctx.readBody();
    const now = Date.now();
    const access = authenticate(ctx, now);
    enforce(db, `access-verify:${access.linkId}`, { limit: 5, windowMs: 15 * 60_000, message: 'Too many attempts. Please wait a few minutes or ask our staff for help.' });
    const secret = verifyPhoneLastFour(db, { access, lastFour: first(body.lastFour), now });
    appendCookie(ctx.res, serializeCookie(DEVICE_COOKIE, secret, {
      maxAgeSeconds: 7 * DAY_SECONDS, path: '/', httpOnly: true, secure: ctx.secure ?? false, sameSite: 'Lax',
    }));
    ctx.json(buildAccessState(db, { access, payHere: config.payHere, verified: true, now }));
  });

  /* ------------------------------------------------- provider / hardware */

  // PayHere server-to-server notification for extension orders. The browser
  // return URL is never treated as proof of payment.
  router.post('/api/public/payments/payhere/extension-notify', async (ctx) => {
    const body = await ctx.readBody();
    const flat = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, first(value)]));
    const result = processExtensionNotification(db, flat, config.payHere);
    ctx.text(result.accepted ? 'OK' : 'INVALID', result.accepted ? 200 : 400);
  });

  // A door controller reporting its state. Authenticated by an HMAC over the
  // raw body with the shared controller secret.
  router.post('/api/internal/door/status', async (ctx) => {
    const raw = (await readRawBody(ctx.req, { limit: 16 * 1024 })).toString('utf8');
    const secret = controllerSecret();
    const valid = verifyControllerSignature({
      secret, timestamp: ctx.req.headers['x-nagaro-timestamp'], signature: ctx.req.headers['x-nagaro-signature'], body: raw,
    });
    if (!valid) {
      ctx.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid controller signature.', details: null } }, 401);
      return;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { throw validationError('The request body is not valid JSON.'); }
    recordControllerStatus(db, { doorIdentifier: payload?.door, state: payload?.state, commandId: payload?.commandId ?? null });
    ctx.json({ ok: true });
  });
}
