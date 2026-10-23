/**
 * Session management.
 *
 * The browser holds a random opaque token in an HttpOnly cookie; only the
 * SHA-256 hash of that token is stored, so a database read cannot be replayed
 * as a live session. Every session carries its own CSRF secret.
 *
 * Roles are resolved on every request from `admin_user`, never from the client.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { randomToken } from '../domain/references.js';
import { forbidden, unauthorized, validationError } from '../domain/errors.js';
import { ADMIN_ROLE, adminRoleLabel } from '../domain/constants.js';
import { recordAudit } from '../services/auditService.js';
import { verifyPassword } from './passwords.js';

export const SESSION_COOKIE = 'nagaro_session';
export const CSRF_COOKIE = 'nagaro_csrf';
export const FLASH_COOKIE = 'nagaro_flash';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const IDLE_TIMEOUT_MS = 1000 * 60 * 120; // 2 hours of inactivity
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 1000 * 60 * 15;

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function hashIp(ip) {
  const salt = process.env.NAGARO_IP_SALT ?? 'nagaro-ip-salt';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

/** Authenticate an email/password pair. Throws on failure with a generic message. */
export function authenticate(db, { email, password, ip = null, now = Date.now() }) {
  const account = db.prepare('SELECT * FROM admin_user WHERE email = ? COLLATE NOCASE').get(String(email ?? '').trim());

  const genericFailure = () => {
    recordAudit(db, {
      at: now,
      actorLabel: String(email ?? '').slice(0, 120) || 'unknown',
      action: 'auth.login_failed',
      entityType: 'admin_user',
      entityId: account?.id ?? null,
      summary: `Failed sign-in attempt for ${String(email ?? '').slice(0, 120)}`,
      details: { ipHash: ip ? hashIp(ip) : null },
    });
    throw unauthorized('Email or password is incorrect.');
  };

  if (!account) genericFailure();
  if (account.deleted_at !== null && account.deleted_at !== undefined) {
    throw forbidden('This account is no longer available.');
  }
  if (account.is_active !== 1) throw forbidden('This account has been disabled.');
  if (account.locked_until && account.locked_until > now) {
    throw forbidden('Too many failed attempts. Try again in a few minutes.');
  }

  if (!verifyPassword(password, account.password_hash)) {
    const failed = account.failed_logins + 1;
    const locked = failed >= MAX_FAILED_LOGINS ? now + LOCKOUT_MS : null;
    db.prepare('UPDATE admin_user SET failed_logins = ?, locked_until = ? WHERE id = ?')
      .run(failed, locked, account.id);
    genericFailure();
  }

  db.prepare('UPDATE admin_user SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
    .run(now, account.id);
  return account;
}

export function createSession(db, { adminUserId, userAgent = null, ip = null, now = Date.now() }) {
  const token = randomToken(32);
  const csrfSecret = randomToken(24);
  db.prepare(`INSERT INTO admin_session
      (token_hash, admin_user_id, csrf_secret, created_at, expires_at, last_seen_at, user_agent, ip_hash)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(
      hashToken(token), Number(adminUserId), csrfSecret, now, now + SESSION_TTL_MS, now,
      userAgent ? String(userAgent).slice(0, 300) : null,
      ip ? hashIp(ip) : null,
    );
  return { token, csrfSecret, expiresAt: now + SESSION_TTL_MS };
}

/**
 * Resolve a session token to an actor. Returns null when the token is
 * missing, unknown, expired, idle-timed-out, revoked, or the account is
 * disabled - the caller then treats the request as anonymous.
 */
export function resolveSession(db, token, { now = Date.now() } = {}) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.*, u.email, u.display_name, u.role, u.is_active,
           u.is_super_admin, u.deleted_at, u.must_change_password
      FROM admin_session s
      JOIN admin_user u ON u.id = s.admin_user_id
     WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at <= now) return null;
  if (now - row.last_seen_at > IDLE_TIMEOUT_MS) {
    db.prepare('UPDATE admin_session SET revoked_at = ? WHERE id = ?').run(now, row.id);
    return null;
  }
  if (row.is_active !== 1) return null;
  if (row.deleted_at !== null && row.deleted_at !== undefined) return null;

  db.prepare('UPDATE admin_session SET last_seen_at = ? WHERE id = ?').run(now, row.id);

  const role = row.is_super_admin === 1 ? ADMIN_ROLE.SUPER_ADMIN : ADMIN_ROLE.ADMIN;
  return {
    sessionId: row.id,
    csrfSecret: row.csrf_secret,
    expiresAt: row.expires_at,
    actor: {
      id: row.admin_user_id,
      email: row.email,
      displayName: row.display_name,
      role,
      mustChangePassword: row.must_change_password === 1,
      label: `${row.display_name} (${adminRoleLabel(role)})`,
    },
  };
}

export function revokeSession(db, sessionId, now = Date.now()) {
  db.prepare('UPDATE admin_session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, sessionId);
}

export function revokeAllSessionsForUser(db, adminUserId, now = Date.now()) {
  db.prepare('UPDATE admin_session SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL')
    .run(now, Number(adminUserId));
}

export function purgeExpiredSessions(db, now = Date.now()) {
  return db.prepare('DELETE FROM admin_session WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
    .run(now, now - 7 * 24 * 3600 * 1000).changes;
}

/* --------------------------------------------------------------- CSRF */

/** Double-submit token bound to the session secret. */
export function csrfTokenFor(csrfSecret) {
  return createHash('sha256').update(`csrf:${csrfSecret}`).digest('base64url');
}

export function verifyCsrf(csrfSecret, provided) {
  if (!csrfSecret || !provided) return false;
  const expected = Buffer.from(csrfTokenFor(csrfSecret));
  const actual = Buffer.from(String(provided));
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/* -------------------------------------------------------------- guards */

export function requireAuth(ctx) {
  if (!ctx.actor) throw unauthorized();
  return ctx.actor;
}

export function requireAdmin(ctx) {
  const actor = requireAuth(ctx);
  if (actor.role !== ADMIN_ROLE.ADMIN && actor.role !== ADMIN_ROLE.SUPER_ADMIN) {
    throw forbidden('This action requires an administrator role.');
  }
  return actor;
}

export function requireSuperAdmin(ctx) {
  const actor = requireAuth(ctx);
  if (actor.role !== ADMIN_ROLE.SUPER_ADMIN) {
    throw forbidden('This action requires a Super Admin role.');
  }
  return actor;
}

/**
 * CSRF protection for state-changing requests.
 * Accepts the token from `_csrf` form field, `x-csrf-token` header, or the
 * `csrf` query parameter (used by the delete-style forms).
 */
export function requireCsrf(ctx) {
  if (!ctx.session) throw unauthorized('Your session has expired. Sign in again.');
  const provided = ctx.body?._csrf
    ?? ctx.headers?.['x-csrf-token']
    ?? ctx.req.headers['x-csrf-token']
    ?? ctx.query?.csrf;
  if (!verifyCsrf(ctx.session.csrfSecret, Array.isArray(provided) ? provided[0] : provided)) {
    const error = forbidden('The security token for this form has expired. Reload the page and try again.');
    error.code = 'CSRF_INVALID';
    throw error;
  }
  return true;
}

export function assertOwnAccountOrAdmin(actor, adminUserId) {
  if (actor.role === ADMIN_ROLE.SUPER_ADMIN) return true;
  if (Number(adminUserId) !== actor.id) throw forbidden('You can only manage your own account.');
  return true;
}

export { validationError, SESSION_TTL_MS, IDLE_TIMEOUT_MS, MAX_FAILED_LOGINS };
