/**
 * Team & access routes.
 *
 * Only a Super Admin may open this screen or call any mutation. Every change
 * is delegated to adminUserService, which owns the three-seat cap, the
 * last-active-Super-Admin guard, the 30-day recycle bin and session
 * revocation inside a write transaction.
 *
 * Successful create/reset requests render the page directly with the
 * one-time credential panel, because the temporary password must never be
 * persisted in a cookie or written to the audit trail. Every other mutation
 * follows the app-wide POST -> 303 -> flash contract.
 */
import { ADMIN_ROLE } from '../domain/constants.js';
import { AppError } from '../domain/errors.js';
import { isSecureRequest } from '../http/request.js';
import { appendCookie, redirect, serializeCookie } from '../http/response.js';
import { FLASH_COOKIE, requireCsrf, requireSuperAdmin } from '../security/sessions.js';
import { enforceAdminMutationLimit } from '../security/rateLimit.js';
import {
  countActiveSuperAdmins,
  createAdminUser,
  generateTemporaryPassword,
  listAdminUsers,
  listDeletedAdminUsers,
  purgeDeletedAdmins,
  resetAdminPassword,
  restoreAdminUser,
  softDeleteAdminUser,
  updateAdminUser,
} from '../services/adminUserService.js';
import { renderTeamPage } from '../../web/views/admin/teamViews.js';

const FLASH_MAX_AGE_SECONDS = 30;

export function registerAdminTeamRoutes(router, deps = {}) {
  const { db } = deps;
  const guards = {
    auth: typeof deps.requireAuth === 'function' ? deps.requireAuth : requireSuperAdmin,
    csrf: typeof deps.requireCsrf === 'function' ? deps.requireCsrf : requireCsrf,
  };

  router.get('/admin/team', async (ctx) => {
    const actor = guards.auth(ctx);
    if (actor?.role !== ADMIN_ROLE.SUPER_ADMIN) throw forbiddenRole();

    const now = Date.now();
    // Expired recycle-bin rows are removed on the first team visit after the
    // deadline; the boot-time scheduler in index.js also runs this sweep.
    purgeDeletedAdmins(db, { now });

    ctx.html(renderTeamPage(teamState(db, ctx, {
      tab: ctx.query.tab === 'recycle' ? 'recycle' : 'active',
      now,
    })));
  });

  router.post('/admin/team', async (ctx) => {
    requireTeamActor(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    const providedPassword = firstValue(ctx.body.password).trim();
    const generate = truthy(ctx.body.generate) || providedPassword === '';
    const password = generate ? generateTemporaryPassword() : providedPassword;

    try {
      const user = createAdminUser(db, {
        actor: ctx.actor,
        payload: {
          email: firstValue(ctx.body.email),
          display_name: firstValue(ctx.body.display_name),
          role: firstValue(ctx.body.role) || undefined,
          password,
          must_change_password: generate,
        },
      });

      ctx.html(renderTeamPage(teamState(db, ctx, {
        tab: 'active',
        revealed: {
          title: generate ? 'Account created with a temporary password' : 'Account created',
          note: generate
            ? `Share this temporary password with ${user.email}. They will be asked to choose a new password at first sign-in.`
            : `Share this password with ${user.email}. They can change it from My account after signing in.`,
          email: user.email,
          password,
        },
      })));
    } catch (error) {
      if (!isExpectedTeamError(error)) throw error;
      ctx.html(renderTeamPage(teamState(db, ctx, {
        tab: 'active',
        flash: errorFlash(error),
      })), error.status);
    }
  });

  router.post('/admin/team/:id', async (ctx) => {
    requireTeamActor(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    try {
      const user = updateAdminUser(db, {
        actor: ctx.actor,
        adminUserId: ctx.params.id,
        payload: {
          display_name: firstValue(ctx.body.display_name),
          email: firstValue(ctx.body.email),
          role: firstValue(ctx.body.role) || undefined,
          is_active: ctx.body.is_active,
        },
      });
      flash(ctx, deps, {
        kind: 'success',
        message: `Saved ${user.displayName}'s account details.`,
      });
      redirectTo(ctx, '/admin/team');
    } catch (error) {
      expectedMutationFailure(ctx, deps, error);
    }
  });

  router.post('/admin/team/:id/reset', async (ctx) => {
    requireTeamActor(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    try {
      const { user, temporaryPassword } = resetAdminPassword(db, {
        actor: ctx.actor,
        adminUserId: ctx.params.id,
      });
      ctx.html(renderTeamPage(teamState(db, ctx, {
        tab: 'active',
        revealed: {
          title: 'Password reset',
          note: `${user.email} has been signed out everywhere and must choose a new password after signing in with this temporary password.`,
          email: user.email,
          password: temporaryPassword,
        },
      })));
    } catch (error) {
      if (!isExpectedTeamError(error)) throw error;
      ctx.html(renderTeamPage(teamState(db, ctx, {
        tab: 'active',
        flash: errorFlash(error),
      })), error.status);
    }
  });

  router.post('/admin/team/:id/role', async (ctx) => {
    requireTeamActor(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    try {
      const user = updateAdminUser(db, {
        actor: ctx.actor,
        adminUserId: ctx.params.id,
        payload: { role: firstValue(ctx.body.role) },
      });
      flash(ctx, deps, {
        kind: 'success',
        message: `${user.displayName} is now ${user.roleLabel}.`,
      });
      redirectTo(ctx, '/admin/team');
    } catch (error) {
      expectedMutationFailure(ctx, deps, error);
    }
  });

  router.post('/admin/team/:id/delete', async (ctx) => {
    requireTeamActor(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    try {
      const user = softDeleteAdminUser(db, {
        actor: ctx.actor,
        adminUserId: ctx.params.id,
      });
      flash(ctx, deps, {
        kind: 'success',
        message: `${user.email} was moved to the recycle bin and signed out. The account is purged after 30 days unless restored.`,
      });
      redirectTo(ctx, '/admin/team?tab=recycle');
    } catch (error) {
      expectedMutationFailure(ctx, deps, error);
    }
  });

  router.post('/admin/team/:id/restore', async (ctx) => {
    requireTeamActor(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    try {
      const user = restoreAdminUser(db, {
        actor: ctx.actor,
        adminUserId: ctx.params.id,
      });
      flash(ctx, deps, {
        kind: 'success',
        message: `${user.email} was restored as ${user.roleLabel}.`,
      });
      redirectTo(ctx, '/admin/team');
    } catch (error) {
      expectedMutationFailure(ctx, deps, error);
    }
  });

  router.post('/admin/team/:id/purge', async (ctx) => {
    requireTeamActor(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    try {
      const result = purgeDeletedAdmins(db, {
        actor: ctx.actor,
        adminUserId: ctx.params.id,
      });
      const purged = result.purged[0];
      flash(ctx, deps, {
        kind: 'success',
        message: `${purged?.email ?? 'The account'} was permanently deleted. The email address is available again.`,
      });
      redirectTo(ctx, '/admin/team?tab=recycle');
    } catch (error) {
      expectedMutationFailure(ctx, deps, error);
    }
  });
}

/* ------------------------------------------------------------------ state */

function teamState(db, ctx, overrides = {}) {
  return {
    actor: ctx.actor,
    csrfToken: ctx.csrfToken,
    flash: ctx.flash,
    members: listAdminUsers(db, { includeInactive: true }),
    deletedMembers: listDeletedAdminUsers(db),
    superCount: countActiveSuperAdmins(db),
    tab: 'active',
    revealed: null,
    now: Date.now(),
    ...overrides,
  };
}

/* ----------------------------------------------------------------- guards */

function requireTeamActor(ctx) {
  const actor = requireSuperAdmin(ctx);
  return actor;
}

function forbiddenRole() {
  const error = new AppError('FORBIDDEN', 'This action requires a Super Admin role.', { status: 403 });
  return error;
}

/* ---------------------------------------------------------------- errors */

function isExpectedTeamError(error) {
  return error instanceof AppError && error.status >= 400 && error.status < 500;
}

function errorFlash(error) {
  return {
    kind: 'error',
    message: error.message,
    problems: Array.isArray(error.details?.problems) ? error.details.problems : null,
  };
}

function expectedMutationFailure(ctx, deps, error) {
  if (!isExpectedTeamError(error)) throw error;
  flash(ctx, deps, errorFlash(error));
  redirectTo(ctx, '/admin/team');
}

/* ----------------------------------------------------------------- flash */

function flash(ctx, deps, { kind = 'success', message, problems = null }) {
  const payload = { kind, message };
  if (Array.isArray(problems) && problems.length > 0) payload.problems = problems.map(String);
  if (typeof deps.setFlash === 'function') {
    deps.setFlash(ctx, payload);
    return;
  }
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, JSON.stringify(payload), {
    maxAgeSeconds: FLASH_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(ctx.req),
  }));
}

function redirectTo(ctx, location) {
  redirect(ctx.res, location, 303);
  ctx.responded = true;
}

/* ------------------------------------------------------------------ input */

function firstValue(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === null || first === undefined) return '';
  return String(first);
}

function truthy(value) {
  const text = firstValue(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'on' || text === 'yes';
}
