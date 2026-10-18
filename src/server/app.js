/**
 * Application assembly.
 *
 * The middleware chain, in order:
 *   1. static assets            (never touches the database)
 *   2. session resolution        (database-resolved actor; never trusts the client)
 *   3. flash + view helpers
 *   4. route handlers
 *   5. error boundary            (HTML page for pages, JSON for /api/*)
 */
import { createRouter } from './http/router.js';
import { getDb } from './db/connection.js';
import { loadConfig } from './config.js';
import { join, sep } from 'node:path';
import {
  appendCookie, mimeForExtension, redirect, sendFileStream, sendHtml, serializeCookie,
} from './http/response.js';
import { isJsonRequest } from './http/request.js';
import {
  CSRF_COOKIE, FLASH_COOKIE, SESSION_COOKIE, csrfTokenFor, resolveSession,
  requireAuth as requireAuthFromSessions, requireCsrf as requireCsrfFromSessions,
} from './security/sessions.js';
import { AppError } from './domain/errors.js';
import { html, raw, escapeHtml } from '../web/lib/html.js';
import { publicShell } from '../web/views/layout.js';

import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerPublicRoutes } from './routes/publicRoutes.js';
import { registerAdminSpaceRoutes } from './routes/adminSpaceRoutes.js';
import { registerAdminBookingRoutes } from './routes/adminBookingRoutes.js';
import { registerAdminCustomerRoutes } from './routes/adminCustomerRoutes.js';
import { registerAdminOpsRoutes } from './routes/adminOpsRoutes.js';
import { registerMediaRoutes } from './routes/mediaRoutes.js';
import { registerAdminUploadRoutes } from './routes/adminUploadRoutes.js';

const STATIC_PREFIX = '/assets/';
const FLASH_MAX_AGE_SECONDS = 30;

/* ----------------------------------------------------------------- flash */

/** Queue a one-shot message for the next rendered page. */
export function setFlash(ctx, { kind = 'success', message, problems = null }) {
  if (!ctx || !ctx.res) return;
  const payload = JSON.stringify({ kind, message, problems: problems ?? undefined });
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, payload, {
    maxAgeSeconds: FLASH_MAX_AGE_SECONDS,
    httpOnly: true,
    secure: ctx.secure ?? false,
  }));
}

export function clearFlashCookie(ctx) {
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true }));
}

export function readFlashCookie(rawValue) {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.message !== 'string') return null;
    return {
      kind: ['success', 'error', 'warning'].includes(parsed.kind) ? parsed.kind : 'success',
      message: parsed.message.slice(0, 500),
      problems: Array.isArray(parsed.problems) ? parsed.problems.slice(0, 20).map(String) : null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- error pages */

export function renderErrorPage(ctx, { status, code, message, details = null }) {
  const problems = details && Array.isArray(details.problems) ? details.problems
    : details && typeof details === 'object'
      ? Object.values(details).filter((v) => typeof v === 'string')
      : [];
  const title = status === 404 ? 'Not found'
    : status === 403 ? 'Not permitted'
      : status === 401 ? 'Sign in required'
        : status === 409 ? 'Booking conflict'
          : status === 422 ? 'Please check the form'
            : 'Something went wrong';

  const body = html`
    <section class="container">
      <div class="card">
        <div class="card__body">
          <h1 class="page-title">${title}</h1>
          <p>${message}</p>
          ${problems.length ? html`<ul class="problem-list">${problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}
          <p class="hint">Reference: <code>${code}</code></p>
          <div class="cluster">
            <a class="button button--primary" href="/">Back to the public site</a>
            <a class="button button--ghost" href="/admin">Staff sign in</a>
          </div>
        </div>
      </div>
    </section>`;

  return publicShell({ title, body, activePath: '' });
}

/* ------------------------------------------------------------------- app */

export function createApp({ db = getDb(), config = loadConfig() } = {}) {
  const router = createRouter();

  /* 1. static assets */
  router.use(async (ctx) => {
    if (!ctx.url.pathname.startsWith(STATIC_PREFIX)) return true;
    const relative = ctx.url.pathname.slice(STATIC_PREFIX.length);
    // No traversal, no hidden files, no nested paths beyond one directory.
    if (!/^[A-Za-z0-9._-]+\.(css|js|mjs|svg|png|jpg|jpeg|webp|ico|woff2|txt)$/.test(relative)) {
      ctx.text('Not found', 404);
      return false;
    }
    const absolute = join(config.publicDir, relative);
    if (!absolute.startsWith(config.publicDir + sep)) {
      ctx.text('Not found', 404);
      return false;
    }
    const dot = relative.lastIndexOf('.');
    sendFileStream(ctx.res, 200, absolute, {
      contentType: mimeForExtension(relative.slice(dot)),
      cacheSeconds: config.isProduction ? 3600 : 0,
    });
    ctx.responded = true;
    return false;
  });

  /* 2. session resolution - roles always come from the database */
  router.use(async (ctx) => {
    ctx.secure = config.forceSecureCookies || Boolean(ctx.req.socket?.encrypted);
    const cookies = ctx.cookies = parseCookiesSafe(ctx.req);
    const resolved = resolveSession(db, cookies[SESSION_COOKIE]);
    if (resolved) {
      ctx.session = { sessionId: resolved.sessionId, csrfSecret: resolved.csrfSecret, expiresAt: resolved.expiresAt };
      ctx.actor = resolved.actor;
    }
    ctx.csrfToken = resolved ? csrfTokenFor(resolved.csrfSecret) : '';
    return true;
  });

  /* 3. flash messages + content negotiation */
  router.use(async (ctx) => {
    const cookies = ctx.cookies ?? parseCookiesSafe(ctx.req);
    ctx.flash = readFlashCookie(cookies[FLASH_COOKIE]);
    if (cookies[FLASH_COOKIE]) clearFlashCookie(ctx);
    ctx.wantsJson = isJsonRequest(ctx.req);
    return true;
  });

  /* 4. routes */
  const deps = { db, config, setFlash, readFlashCookie, renderErrorPage, html, raw, escapeHtml };
  deps.requireAuth = requireAuthFromSessions;
  deps.requireCsrf = requireCsrfFromSessions;

  registerAuthRoutes(router, deps);
  registerMediaRoutes(router, deps);
  registerPublicRoutes(router, deps);
  registerAdminSpaceRoutes(router, deps);
  registerAdminBookingRoutes(router, deps);
  registerAdminCustomerRoutes(router, deps);
  registerAdminOpsRoutes(router, deps);
  registerAdminUploadRoutes(router, deps);

  /* 5. error boundary */
  router.onError(async (ctx, error) => {
    if (ctx.res.headersSent || ctx.res.writableEnded) return;
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (status >= 500) console.error('[request-failed]', ctx.method, ctx.url?.pathname, error);

    if (ctx.wantsJson || ctx.url.pathname.startsWith('/api/')) {
      ctx.json({
        ok: false,
        error: {
          code,
          message: status >= 500
            ? 'Something went wrong on our side. The operation was not completed.'
            : error.message,
          details: error.details ?? null,
        },
      }, status);
      return;
    }
    if (status === 401) {
      redirect(ctx.res, `/admin/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
      return;
    }
    // For form submissions, bounce back with an explanatory flash.
    const referer = ctx.req.headers.referer;
    if (ctx.method === 'POST' && referer) {
      setFlash(ctx, {
        kind: 'error',
        message: error.message,
        problems: error.details?.problems ?? null,
      });
      try {
        const target = new URL(referer);
        const sameOrigin = target.host === ctx.req.headers.host;
        redirect(ctx.res, sameOrigin ? `${target.pathname}${target.search}` : '/admin');
        return;
      } catch { /* fall through to the error page */ }
    }
    const page = renderErrorPage(ctx, {
      status,
      code,
      message: status >= 500
        ? 'Something went wrong on our side. The operation was not completed.'
        : error.message,
      details: error.details ?? null,
    });
    sendHtml(ctx.res, status, page);
  });

  router.setNotFound((ctx) => {
    if (ctx.wantsJson || ctx.url.pathname.startsWith('/api/')) {
      ctx.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found', details: null } }, 404);
      return;
    }
    sendHtml(ctx.res, 404, renderErrorPage(ctx, {
      status: 404, code: 'NOT_FOUND',
      message: 'That page does not exist. It may have been moved, or the link may be out of date.',
    }));
  });

  return router;
}

function parseCookiesSafe(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { out[key] = part.slice(index + 1).trim(); }
  }
  return out;
}

// Re-exported for route modules that prefer importing from here.
export { CSRF_COOKIE, SESSION_COOKIE };
