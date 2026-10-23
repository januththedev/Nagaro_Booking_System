/**
 * Identity routes: sign in, sign out, own password change.
 *
 * The sign-in page is deliberately outside the admin shell so an
 * unauthenticated visitor never receives admin chrome.
 */
import { html } from '../../web/lib/html.js';
import { adminShell } from '../../web/views/layout.js';
import { renderLoginPage } from '../../web/views/authViews.js';
import {
  CSRF_COOKIE, SESSION_COOKIE, authenticate, createSession, csrfTokenFor,
  requireAuth, requireCsrf, revokeSession,
} from '../security/sessions.js';
import { appendCookie, redirect, serializeCookie } from '../http/response.js';
import { enforceLoginLimits } from '../security/rateLimit.js';
import { clientIp } from '../http/request.js';
import { changeOwnPassword, getAdminUser } from '../services/adminUserService.js';
import { recordAudit } from '../services/auditService.js';
import { requiredString, asTrimmedString } from '../domain/validation.js';
import { validationError } from '../domain/errors.js';
import { businessDateTimeLabel } from '../domain/time.js';
import { adminRoleLabel } from '../domain/constants.js';

const SAFE_NEXT = /^\/admin(\/[A-Za-z0-9\-_./?=&%#]*)?$/;

/** Only same-site admin paths may be used as a post-login destination. */
function safeNext(value) {
  const next = typeof value === 'string' ? value.trim() : '';
  if (!next || !SAFE_NEXT.test(next)) return '/admin';
  if (next.startsWith('/admin/login')) return '/admin';
  return next;
}

function setSessionCookies(ctx, session) {
  const maxAge = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
  appendCookie(ctx.res, serializeCookie(SESSION_COOKIE, session.token, {
    maxAgeSeconds: maxAge, httpOnly: true, secure: ctx.secure, sameSite: 'Lax',
  }));
  // Readable by scripts so the client can echo it back in x-csrf-token headers.
  // It is not a credential on its own: the server re-derives it from the
  // session secret, which stays in the HttpOnly session row.
  appendCookie(ctx.res, serializeCookie(CSRF_COOKIE, csrfTokenFor(session.csrfSecret), {
    maxAgeSeconds: maxAge, httpOnly: false, secure: ctx.secure, sameSite: 'Lax',
  }));
}

export function registerAuthRoutes(router, deps) {
  const { db, config, setFlash } = deps;

  router.get('/admin/login', async (ctx) => {
    if (ctx.actor) {
      redirect(ctx.res, safeNext(ctx.query.next));
      return;
    }
    ctx.html(renderLoginPage({
      csrfToken: ctx.csrfToken,
      next: safeNext(ctx.query.next),
      email: typeof ctx.query.email === 'string' ? ctx.query.email : '',
      flash: ctx.flash,
      emailConfigured: Boolean(config.smtp.host),
    }));
  });

  router.post('/admin/login', async (ctx) => {
    await ctx.readBody();
    const ip = clientIp(ctx.req);
    const next = safeNext(ctx.body.next);
    const submittedEmail = asTrimmedString(ctx.body.email, { max: 254, field: 'email' }) ?? '';

    // Throttle before touching credentials so brute force is cheap to reject.
    enforceLoginLimits(db, { ip, email: submittedEmail });

    let account;
    try {
      account = authenticate(db, { email: submittedEmail, password: ctx.body.password, ip });
    } catch (error) {
      if (ctx.wantsJson) throw error;
      setFlash(ctx, { kind: 'error', message: error.message });
      redirect(ctx.res, `/admin/login?next=${encodeURIComponent(next)}&email=${encodeURIComponent(submittedEmail.slice(0, 120))}`);
      return;
    }

    const session = createSession(db, {
      adminUserId: account.id,
      userAgent: ctx.req.headers['user-agent'] ?? null,
      ip,
    });
    setSessionCookies(ctx, session);

    const accountRole = account.is_super_admin === 1 ? 'SUPER_ADMIN' : 'ADMIN';
    recordAudit(db, {
      actorAdminUserId: account.id,
      actorLabel: `${account.display_name} (${adminRoleLabel(accountRole)})`,
      action: 'auth.login',
      entityType: 'admin_user',
      entityId: account.id,
      summary: `Signed in as ${account.email}`,
    });

    // A reset password must be replaced before the console can be used.
    redirect(ctx.res, account.must_change_password === 1 ? '/admin/account' : next);
  });

  router.post('/admin/logout', async (ctx) => {
    await ctx.readBody();
    if (ctx.session) {
      requireCsrf(ctx);
      revokeSession(db, ctx.session.sessionId);
      if (ctx.actor) {
        recordAudit(db, {
          actorAdminUserId: ctx.actor.id,
          actorLabel: ctx.actor.label,
          action: 'auth.logout',
          entityType: 'admin_user',
          entityId: ctx.actor.id,
          summary: `Signed out ${ctx.actor.email}`,
        });
      }
    }
    appendCookie(ctx.res, serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, httpOnly: true }));
    appendCookie(ctx.res, serializeCookie(CSRF_COOKIE, '', { maxAgeSeconds: 0, httpOnly: false }));
    redirect(ctx.res, '/admin/login');
  });

  router.get('/admin/account', async (ctx) => {
    const actor = requireAuth(ctx);
    const account = getAdminUser(db, actor.id);
    ctx.html(adminShell({
      title: 'My account',
      subtitle: 'Change your password. All your other sessions will be signed out.',
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      activePath: '/admin/account',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'My account' }],
      body: html`<div class="card"><div class="card__body">
        ${actor.mustChangePassword
          ? html`<div class="alert alert--warning" role="alert">
              <p><strong>Choose a new password to continue.</strong> Your password was reset by a Super Admin. The temporary password only opens this account page.</p>
            </div>`
          : ''}
        <dl class="detail-list">
          <dt>Name</dt><dd>${account?.displayName ?? actor.displayName}</dd>
          <dt>Email</dt><dd>${account?.email ?? actor.email}</dd>
          <dt>Role</dt><dd>${account?.roleLabel ?? adminRoleLabel(account?.role ?? actor.role)}</dd>
          <dt>Last sign-in</dt><dd>${account?.lastLoginAt ? businessDateTimeLabel(account.lastLoginAt) : '—'}</dd>
        </dl>
        <form method="post" action="/admin/account/password" class="form-grid">
          <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
          <div class="form-field">
            <label for="current_password">Current password</label>
            <input id="current_password" name="current_password" type="password" required autocomplete="current-password">
          </div>
          <div class="form-field">
            <label for="new_password">New password</label>
            <input id="new_password" name="new_password" type="password" required minlength="10" autocomplete="new-password">
            <p class="hint">At least 10 characters, including a letter and a number.</p>
          </div>
          <div class="form-field">
            <label for="new_password_confirm">Confirm new password</label>
            <input id="new_password_confirm" name="new_password_confirm" type="password" required minlength="10" autocomplete="new-password">
          </div>
          <div class="form-actions">
            <button class="button button--primary" type="submit">Change password</button>
          </div>
        </form>
      </div></div>`,
    }));
  });

  router.post('/admin/account/password', async (ctx) => {
    const actor = requireAuth(ctx);
    await ctx.readBody();
    requireCsrf(ctx);
    const current = requiredString(ctx.body.current_password, { field: 'current_password', max: 200 });
    const nextPassword = requiredString(ctx.body.new_password, { field: 'new_password', max: 200 });
    const confirm = requiredString(ctx.body.new_password_confirm, { field: 'new_password_confirm', max: 200 });
    if (nextPassword !== confirm) {
      throw validationError('The new passwords do not match.', {
        new_password_confirm: 'The new passwords do not match.',
      });
    }
    changeOwnPassword(db, {
      actor,
      adminUserId: actor.id,
      currentPassword: current,
      newPassword: nextPassword,
      keepSessionId: ctx.session?.sessionId ?? null,
    });
    setFlash(ctx, { kind: 'success', message: 'Your password has been changed. Other sessions were signed out.' });
    redirect(ctx.res, '/admin/account');
  });

  router.get('/admin/logout', async (ctx) => redirect(ctx.res, '/admin/login'));
}
