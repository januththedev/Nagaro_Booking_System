/**
 * Staff account management.
 *
 * Invariants:
 *   - email is trimmed + lower-cased and unique (the schema is COLLATE NOCASE
 *     UNIQUE; the friendly conflict message is produced here);
 *   - passwords go through `passwordProblems()` before `hashPassword()`, so a
 *     weak password is reported as field problems rather than a thrown Error;
 *   - at least one active ADMIN must always remain. The check and the write
 *     run inside BEGIN IMMEDIATE so two concurrent demotions cannot both win;
 *   - deactivation and forced password resets revoke that user's sessions;
 *   - every mutation is audited in the same transaction.
 *
 * Password hashes are never returned to callers.
 */
import { withWriteTransaction } from '../db/connection.js';
import { ADMIN_ROLE } from '../domain/constants.js';
import { conflict, forbidden, notFound, validationError } from '../domain/errors.js';
import {
  asBoolean, assertAdminRole, normalizeEmail, requiredEmail, requiredString, LIMITS,
} from '../domain/validation.js';
import { hashPassword, passwordProblems, verifyPassword } from '../security/passwords.js';
import { revokeAllSessionsForUser } from '../security/sessions.js';
import { recordAudit } from './auditService.js';

const ADMIN_USER_COLUMNS = `
  id, email, display_name, role, is_active, created_at, updated_at,
  last_login_at, failed_logins, locked_until
`;

/* ------------------------------------------------------------- hydration */

/** Map a raw row to the public staff-account shape (never the hash). */
export function hydrateAdminUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    failedLogins: row.failed_logins,
    lockedUntil: row.locked_until,
  };
}

export function getAdminUser(db, id) {
  const row = db.prepare(`SELECT ${ADMIN_USER_COLUMNS} FROM admin_user WHERE id = ? AND COALESCE(is_system, 0) = 0`).get(Number(id));
  return hydrateAdminUser(row);
}

/** Active accounts by default; administrators first, then name. */
export function listAdminUsers(db, { includeInactive = false } = {}) {
  const where = includeInactive
    ? 'WHERE COALESCE(is_system, 0) = 0'
    : 'WHERE is_active = 1 AND COALESCE(is_system, 0) = 0';
  return db.prepare(`
    SELECT ${ADMIN_USER_COLUMNS}
      FROM admin_user
      ${where}
     ORDER BY CASE role WHEN '${ADMIN_ROLE.ADMIN}' THEN 0 ELSE 1 END,
              display_name COLLATE NOCASE ASC,
              id ASC
  `).all().map(hydrateAdminUser);
}

export function countActiveAdmins(db) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS c FROM admin_user WHERE role = '${ADMIN_ROLE.ADMIN}' AND is_active = 1`,
  ).get().c);
}

/* ------------------------------------------------------------ validation */

function requireActor(actor) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
}

function normaliseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw validationError('A valid staff account id is required.');
  return id;
}

function passwordProblemsOrThrow(password, field = 'password') {
  const problems = passwordProblems(password);
  if (problems.length > 0) {
    throw validationError('The password does not meet the requirements.', { field, problems });
  }
}

function isUniqueEmailError(error) {
  const message = String(error?.message ?? '');
  return message.includes('UNIQUE constraint failed') && message.includes('admin_user.email');
}

function parseCreatePayload(payload = {}) {
  const email = normalizeEmail(requiredEmail(payload.email, { field: 'email' }));
  const displayName = requiredString(
    payload.display_name ?? payload.displayName,
    { field: 'display_name', max: LIMITS.maxNameLength },
  );
  const role = payload.role === undefined || payload.role === null || payload.role === ''
    ? ADMIN_ROLE.STAFF
    : assertAdminRole(payload.role);
  passwordProblemsOrThrow(payload.password);
  return { email, displayName, role, passwordHash: hashPassword(payload.password) };
}

function parseUpdatePayload(payload = {}) {
  const value = {};
  if (payload.display_name !== undefined || payload.displayName !== undefined) {
    value.displayName = requiredString(
      payload.display_name ?? payload.displayName,
      { field: 'display_name', max: LIMITS.maxNameLength },
    );
  }
  if (payload.email !== undefined) {
    value.email = normalizeEmail(requiredEmail(payload.email, { field: 'email' }));
  }
  if (payload.role !== undefined && payload.role !== null && payload.role !== '') {
    value.role = assertAdminRole(payload.role);
  }
  if (payload.is_active !== undefined && payload.is_active !== null && payload.is_active !== '') {
    value.isActive = asBoolean(payload.is_active, { fallback: false });
  }
  return value;
}

/* ---------------------------------------------------------------- writes */

export function createAdminUser(db, { actor, payload } = {}) {
  requireActor(actor);
  const value = parseCreatePayload(payload);

  return withWriteTransaction(db, () => {
    const existing = db.prepare('SELECT id FROM admin_user WHERE email = ? COLLATE NOCASE').get(value.email);
    if (existing) throw conflict('A staff account with this email already exists.');

    const now = Date.now();
    let info;
    try {
      info = db.prepare(`
        INSERT INTO admin_user
          (email, password_hash, display_name, role, is_active, created_at, updated_at)
        VALUES (?,?,?,?,1,?,?)
      `).run(value.email, value.passwordHash, value.displayName, value.role, now, now);
    } catch (error) {
      if (isUniqueEmailError(error)) throw conflict('A staff account with this email already exists.');
      throw error;
    }

    const id = Number(info.lastInsertRowid);
    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'admin_user.created',
      entityType: 'admin_user',
      entityId: id,
      summary: `Created ${value.role === ADMIN_ROLE.ADMIN ? 'administrator' : 'staff'} account ${value.email}`,
      details: { email: value.email, displayName: value.displayName, role: value.role },
    });
    return getAdminUser(db, id);
  });
}

export function updateAdminUser(db, { actor, adminUserId, payload } = {}) {
  requireActor(actor);
  const id = normaliseId(adminUserId);
  const patch = parseUpdatePayload(payload);

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
    if (!current) throw notFound('Staff account not found.');

    const nextRole = patch.role ?? current.role;
    const nextIsActive = patch.isActive ?? (current.is_active === 1);

    // Last-active-administrator guard. Counting inside BEGIN IMMEDIATE means
    // two concurrent demotions cannot both observe "one other admin".
    if (current.role === ADMIN_ROLE.ADMIN && current.is_active === 1
      && (nextRole !== ADMIN_ROLE.ADMIN || nextIsActive === false)) {
      const otherAdmins = Number(db.prepare(
        `SELECT COUNT(*) AS c FROM admin_user
          WHERE role = '${ADMIN_ROLE.ADMIN}' AND is_active = 1 AND id <> ?`,
      ).get(id).c);
      if (otherAdmins === 0) {
        throw conflict(
          'At least one active administrator must remain. Promote another account to administrator before deactivating or demoting this one.',
        );
      }
    }

    const nextEmail = patch.email ?? current.email;
    if (patch.email && patch.email !== current.email) {
      const dupe = db.prepare('SELECT id FROM admin_user WHERE email = ? COLLATE NOCASE AND id <> ?')
        .get(nextEmail, id);
      if (dupe) throw conflict('Another staff account already uses this email.');
    }

    const nextDisplayName = patch.displayName ?? current.display_name;
    const now = Date.now();
    try {
      db.prepare(`
        UPDATE admin_user
           SET email = ?, display_name = ?, role = ?, is_active = ?, updated_at = ?
         WHERE id = ?
      `).run(nextEmail, nextDisplayName, nextRole, nextIsActive ? 1 : 0, now, id);
    } catch (error) {
      if (isUniqueEmailError(error)) throw conflict('Another staff account already uses this email.');
      throw error;
    }

    if (nextIsActive === false && current.is_active === 1) {
      revokeAllSessionsForUser(db, id, now);
    }

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'admin_user.updated',
      entityType: 'admin_user',
      entityId: id,
      summary: nextIsActive === false && current.is_active === 1
        ? `Deactivated staff account ${current.email}`
        : `Updated staff account ${nextEmail}`,
      details: {
        before: {
          email: current.email,
          displayName: current.display_name,
          role: current.role,
          isActive: current.is_active === 1,
        },
        after: {
          email: nextEmail,
          displayName: nextDisplayName,
          role: nextRole,
          isActive: nextIsActive,
        },
      },
    });
    return getAdminUser(db, id);
  });
}

/** Deactivation is an update with the last-admin guard and session revocation. */
export function deactivateAdminUser(db, { actor, adminUserId } = {}) {
  return updateAdminUser(db, { actor, adminUserId, payload: { is_active: false } });
}

/**
 * Self-service password change. The caller's current password is required.
 * Every *other* live session for the account is revoked; pass `keepSessionId`
 * so the session performing the change survives.
 */
export function changeOwnPassword(db, {
  actor, adminUserId, currentPassword, newPassword, keepSessionId = null,
} = {}) {
  requireActor(actor);
  const id = normaliseId(adminUserId);
  if (Number(actor.id) !== id) throw forbidden('You can only change your own password.');
  passwordProblemsOrThrow(newPassword, 'new_password');

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
    if (!current) throw notFound('Staff account not found.');
    if (!verifyPassword(currentPassword, current.password_hash)) {
      throw validationError('The current password is incorrect.', { field: 'current_password' });
    }

    const now = Date.now();
    db.prepare(`
      UPDATE admin_user
         SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?
    `).run(hashPassword(newPassword), now, id);

    const keep = keepSessionId === null || keepSessionId === undefined ? null : Number(keepSessionId);
    db.prepare(`
      UPDATE admin_session SET revoked_at = ?
       WHERE admin_user_id = ? AND revoked_at IS NULL
         AND (? IS NULL OR id <> ?)
    `).run(now, id, keep, keep);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'admin_user.password_changed',
      entityType: 'admin_user',
      entityId: id,
      summary: `Changed own password for ${current.email}`,
      details: { self: true, keptSessionId: keep },
    });
    return getAdminUser(db, id);
  });
}

/**
 * Administrative password reset: ADMIN only, no current-password challenge.
 * All of the target account's sessions are revoked.
 */
export function setPassword(db, { actor, adminUserId, newPassword } = {}) {
  requireActor(actor);
  if (actor.role !== ADMIN_ROLE.ADMIN) {
    throw forbidden('Only an administrator can reset another account password.');
  }
  const id = normaliseId(adminUserId);
  passwordProblemsOrThrow(newPassword, 'new_password');

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
    if (!current) throw notFound('Staff account not found.');

    const now = Date.now();
    db.prepare(`
      UPDATE admin_user
         SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?
    `).run(hashPassword(newPassword), now, id);
    revokeAllSessionsForUser(db, id, now);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'admin_user.password_changed',
      entityType: 'admin_user',
      entityId: id,
      summary: `Reset password for ${current.email}`,
      details: { forced: true },
    });
    return getAdminUser(db, id);
  });
}

/**
 * Bootstrap hook, safe on every boot: creates the first administrator only
 * when the table is completely empty; never touches existing rows.
 *
 * @returns {{created: boolean, reason: string|null, user?: object}}
 */
export function ensureFirstAdmin(db, { email, password, displayName = null } = {}) {
  return withWriteTransaction(db, () => {
    const existing = Number(db.prepare('SELECT COUNT(*) AS c FROM admin_user WHERE COALESCE(is_system, 0) = 0').get().c);
    if (existing > 0) return { created: false, reason: 'administrators already exist' };

    const normalisedEmail = normalizeEmail(requiredEmail(email, { field: 'email' }));
    const name = String(displayName ?? '').trim() || normalisedEmail;
    passwordProblemsOrThrow(password);

    const now = Date.now();
    let info;
    try {
      info = db.prepare(`
        INSERT INTO admin_user
          (email, password_hash, display_name, role, is_active, created_at, updated_at)
        VALUES (?,?,?,?,1,?,?)
      `).run(
        normalisedEmail,
        hashPassword(password),
        name.slice(0, LIMITS.maxNameLength),
        ADMIN_ROLE.ADMIN,
        now,
        now,
      );
    } catch (error) {
      // Another process won the race between the count and the insert.
      if (isUniqueEmailError(error)) return { created: false, reason: 'administrators already exist' };
      throw error;
    }

    const id = Number(info.lastInsertRowid);
    recordAudit(db, {
      actorLabel: 'system',
      action: 'admin_user.created',
      entityType: 'admin_user',
      entityId: id,
      summary: `Created initial administrator ${normalisedEmail}`,
      details: { email: normalisedEmail, role: ADMIN_ROLE.ADMIN, bootstrap: true },
    });
    return { created: true, reason: null, user: getAdminUser(db, id) };
  });
}
