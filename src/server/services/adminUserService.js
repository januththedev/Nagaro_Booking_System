/**
 * Staff / administrator account management.
 *
 * The application has exactly two roles:
 *   - SUPER_ADMIN: may add, edit, promote, reset, delete and restore accounts;
 *   - ADMIN: may use the operations console and change their own password.
 *
 * Storage keeps the historical `role = 'ADMIN'` value for every account (the
 * schema CHECK constraint is untouched) and uses `is_super_admin` to expose
 * SUPER_ADMIN vs ADMIN. At most MAX_SUPER_ADMINS active, non-deleted Super
 * Admins may exist. The cap and the last-active-Super-Admin guard both run
 * inside a write transaction; PostgreSQL takes an advisory transaction lock so
 * two concurrent promotions cannot both observe a free seat. SQLite's
 * BEGIN IMMEDIATE serialises writers in the same way.
 *
 * Deleting an account is a soft delete into a 30-day recycle bin. The email
 * stay reserved until the row is purged (the unique constraint is never
 * relaxed), and a purge reassigns ON DELETE RESTRICT authorship to the
 * inactive system principal before removing the row.
 *
 * Password hashes are never returned to callers.
 */
import { randomBytes } from 'node:crypto';
import { withWriteTransaction } from '../db/connection.js';
import {
  ADMIN_ROLE, MAX_SUPER_ADMINS, RECYCLE_BIN_RETENTION_DAYS, adminRoleLabel,
} from '../domain/constants.js';
import { conflict, forbidden, notFound, validationError } from '../domain/errors.js';
import {
  asBoolean, assertAdminRole, normalizeEmail, requiredEmail, requiredString, LIMITS,
} from '../domain/validation.js';
import { hashPassword, passwordProblems, verifyPassword } from '../security/passwords.js';
import { revokeAllSessionsForUser } from '../security/sessions.js';
import { recordAudit } from './auditService.js';

const ADMIN_USER_COLUMNS = `
  id, email, display_name, role, is_super_admin, is_active,
  deleted_at, deleted_by, purge_after, must_change_password,
  created_at, updated_at, last_login_at, failed_logins, locked_until
`;

const RECYCLE_BIN_MS = RECYCLE_BIN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SUPER_ADMIN_CAP_LOCK_KEY = 734_001;
const SYSTEM_PRINCIPAL_EMAIL = 'public-booking@system.nagaro';
const SYSTEM_PRINCIPAL_HASH = '!NO_LOGIN_SYSTEM_PRINCIPAL!';

/* ------------------------------------------------------------- hydration */

/** Map a raw row to the public staff-account shape (never the hash). */
export function hydrateAdminUser(row) {
  if (!row) return null;
  const isSuperAdmin = row.is_super_admin === 1;
  const isDeleted = row.deleted_at !== null && row.deleted_at !== undefined;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: isSuperAdmin ? ADMIN_ROLE.SUPER_ADMIN : ADMIN_ROLE.ADMIN,
    roleLabel: adminRoleLabel(isSuperAdmin ? ADMIN_ROLE.SUPER_ADMIN : ADMIN_ROLE.ADMIN),
    isSuperAdmin,
    isActive: row.is_active === 1 && !isDeleted,
    isDeleted,
    deletedAt: row.deleted_at ?? null,
    deletedBy: row.deleted_by ?? null,
    purgeAfter: row.purge_after ?? null,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    failedLogins: row.failed_logins,
    lockedUntil: row.locked_until,
  };
}

export function getAdminUser(db, id, { includeDeleted = false } = {}) {
  const row = db.prepare(`
    SELECT ${ADMIN_USER_COLUMNS}
      FROM admin_user
     WHERE id = ? AND COALESCE(is_system, 0) = 0
       ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `).get(Number(id));
  return hydrateAdminUser(row);
}

/** Active accounts by default; Super Admins first, then name. */
export function listAdminUsers(db, {
  includeInactive = false, includeDeleted = false, deletedOnly = false,
} = {}) {
  const where = ['COALESCE(is_system, 0) = 0'];
  if (deletedOnly) where.push('deleted_at IS NOT NULL');
  else if (!includeDeleted) where.push('deleted_at IS NULL');
  if (!includeInactive && !deletedOnly) where.push('is_active = 1');

  return db.prepare(`
    SELECT ${ADMIN_USER_COLUMNS}
      FROM admin_user
     WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN is_super_admin = 1 THEN 0 ELSE 1 END,
              display_name COLLATE NOCASE ASC,
              id ASC
  `).all().map(hydrateAdminUser);
}

export function listDeletedAdminUsers(db) {
  return listAdminUsers(db, { deletedOnly: true, includeInactive: true });
}

/** Every active, non-deleted administrator (both roles). */
export function countActiveAdmins(db) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS c
      FROM admin_user
     WHERE is_active = 1 AND deleted_at IS NULL AND COALESCE(is_system, 0) = 0
  `).get().c);
}

export function countActiveSuperAdmins(db, { excludeId = null } = {}) {
  const exclusion = excludeId === null || excludeId === undefined ? '' : 'AND id <> ?';
  const params = exclusion ? [Number(excludeId)] : [];
  return Number(db.prepare(`
    SELECT COUNT(*) AS c
      FROM admin_user
     WHERE is_super_admin = 1 AND is_active = 1 AND deleted_at IS NULL
       AND COALESCE(is_system, 0) = 0 ${exclusion}
  `).get(...params).c);
}

/* ------------------------------------------------------------ validation */

function requireActor(actor) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
}

function requireSuperAdminActor(actor) {
  requireActor(actor);
  if (actor.role !== ADMIN_ROLE.SUPER_ADMIN) {
    throw forbidden('Only a Super Admin can manage team accounts.');
  }
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
  return (message.includes('UNIQUE constraint failed') && message.includes('admin_user.email'))
    || (/duplicate key value/i.test(message) && /admin_user/i.test(message));
}

/** A password that satisfies passwordProblems(): letters, digits, 17 chars. */
export function generateTemporaryPassword() {
  const body = randomBytes(10).toString('base64url').replace(/[-_]/g, 'x');
  return `T9-${body}`;
}

/** Serialise the cap decision across processes on PostgreSQL. */
function lockSuperAdminCap(db) {
  if (db.dialect === 'postgres') {
    db.prepare('SELECT pg_advisory_xact_lock(?)').get(SUPER_ADMIN_CAP_LOCK_KEY);
  }
}

function assertSuperAdminCapacity(db, { excludeId = null } = {}) {
  const active = countActiveSuperAdmins(db, { excludeId });
  if (active >= MAX_SUPER_ADMINS) {
    throw conflict(
      `There can be at most ${MAX_SUPER_ADMINS} active Super Admins. `
        + 'Demote or delete a Super Admin before adding another.',
    );
  }
}

function assertLastSuperAdminRemains(db, current) {
  if (current.is_super_admin !== 1 || current.is_active !== 1 || current.deleted_at !== null) return;
  if (countActiveSuperAdmins(db, { excludeId: current.id }) === 0) {
    throw conflict(
      'At least one active Super Admin must remain. Promote another account before demoting, '
        + 'deactivating or deleting this one.',
    );
  }
}

function parseCreatePayload(payload = {}) {
  const email = normalizeEmail(requiredEmail(payload.email, { field: 'email' }));
  const displayName = requiredString(
    payload.display_name ?? payload.displayName,
    { field: 'display_name', max: LIMITS.maxNameLength },
  );
  const role = payload.role === undefined || payload.role === null || payload.role === ''
    ? ADMIN_ROLE.ADMIN
    : assertAdminRole(payload.role);
  passwordProblemsOrThrow(payload.password);
  return {
    email,
    displayName,
    role,
    isSuperAdmin: role === ADMIN_ROLE.SUPER_ADMIN,
    mustChangePassword: asBoolean(
      payload.must_change_password ?? payload.mustChangePassword,
      { fallback: false },
    ),
    passwordHash: hashPassword(payload.password),
  };
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
  requireSuperAdminActor(actor);
  const value = parseCreatePayload(payload);

  return withWriteTransaction(db, () => {
    if (value.isSuperAdmin) {
      lockSuperAdminCap(db);
      assertSuperAdminCapacity(db);
    }

    const existing = db.prepare('SELECT id FROM admin_user WHERE email = ? COLLATE NOCASE').get(value.email);
    if (existing) throw conflict('A staff account with this email already exists.');

    const now = Date.now();
    let info;
    try {
      info = db.prepare(`
        INSERT INTO admin_user
          (email, password_hash, display_name, role, is_super_admin, is_active,
           must_change_password, created_at, updated_at)
        VALUES (?,?,?,'ADMIN',?,1,?,?,?)
      `).run(
        value.email,
        value.passwordHash,
        value.displayName,
        value.isSuperAdmin ? 1 : 0,
        value.mustChangePassword ? 1 : 0,
        now,
        now,
      );
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
      summary: `Created ${adminRoleLabel(value.role)} account ${value.email}`,
      details: {
        email: value.email,
        displayName: value.displayName,
        role: value.role,
        mustChangePassword: value.mustChangePassword,
      },
    });
    return getAdminUser(db, id);
  });
}

export function updateAdminUser(db, { actor, adminUserId, payload } = {}) {
  requireSuperAdminActor(actor);
  const id = normaliseId(adminUserId);
  const patch = parseUpdatePayload(payload);

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
    if (!current || current.is_system === 1) throw notFound('Staff account not found.');
    if (current.deleted_at !== null) {
      throw conflict('This account is in the recycle bin. Restore it before editing it.');
    }

    lockSuperAdminCap(db);

    const nextRole = patch.role ?? (current.is_super_admin === 1 ? ADMIN_ROLE.SUPER_ADMIN : ADMIN_ROLE.ADMIN);
    const nextIsSuper = nextRole === ADMIN_ROLE.SUPER_ADMIN;
    const currentIsSuper = current.is_super_admin === 1;
    const nextIsActive = patch.isActive ?? (current.is_active === 1);

    if (nextIsSuper && nextIsActive && (!currentIsSuper || current.is_active !== 1)) {
      assertSuperAdminCapacity(db, { excludeId: id });
    }
    if (currentIsSuper && (!nextIsSuper || nextIsActive === false)) {
      assertLastSuperAdminRemains(db, current);
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
           SET email = ?, display_name = ?, role = 'ADMIN', is_super_admin = ?,
               is_active = ?, updated_at = ?
         WHERE id = ?
      `).run(nextEmail, nextDisplayName, nextIsSuper ? 1 : 0, nextIsActive ? 1 : 0, now, id);
    } catch (error) {
      if (isUniqueEmailError(error)) throw conflict('Another staff account already uses this email.');
      throw error;
    }

    if (nextIsActive === false && current.is_active === 1) {
      revokeAllSessionsForUser(db, id, now);
    }

    const roleChanged = currentIsSuper !== nextIsSuper;
    const action = roleChanged ? 'admin_user.role_changed' : 'admin_user.updated';
    const summary = roleChanged
      ? `Changed ${current.email} to ${adminRoleLabel(nextRole)}`
      : nextIsActive === false && current.is_active === 1
        ? `Deactivated staff account ${current.email}`
        : `Updated staff account ${nextEmail}`;

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action,
      entityType: 'admin_user',
      entityId: id,
      summary,
      details: {
        before: {
          email: current.email,
          displayName: current.display_name,
          role: currentIsSuper ? ADMIN_ROLE.SUPER_ADMIN : ADMIN_ROLE.ADMIN,
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

/** Deactivation is an update with the last-Super-Admin guard and session revocation. */
export function deactivateAdminUser(db, { actor, adminUserId } = {}) {
  return updateAdminUser(db, { actor, adminUserId, payload: { is_active: false } });
}

/** Move an account into the 30-day recycle bin. Self-deletion is forbidden. */
export function softDeleteAdminUser(db, { actor, adminUserId, now = Date.now() } = {}) {
  requireSuperAdminActor(actor);
  const id = normaliseId(adminUserId);
  if (Number(actor.id) === id) {
    throw forbidden('You cannot delete your own account.');
  }

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
    if (!current || current.is_system === 1) throw notFound('Staff account not found.');
    if (current.deleted_at !== null) throw conflict('This account is already in the recycle bin.');

    lockSuperAdminCap(db);
    assertLastSuperAdminRemains(db, current);

    const purgeAfter = now + RECYCLE_BIN_MS;
    db.prepare(`
      UPDATE admin_user
         SET is_active = 0, deleted_at = ?, deleted_by = ?, purge_after = ?, updated_at = ?
       WHERE id = ?
    `).run(now, actor.id, purgeAfter, now, id);
    revokeAllSessionsForUser(db, id, now);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'admin_user.deleted',
      entityType: 'admin_user',
      entityId: id,
      summary: `Moved ${current.email} to the recycle bin`,
      details: {
        email: current.email,
        role: current.is_super_admin === 1 ? ADMIN_ROLE.SUPER_ADMIN : ADMIN_ROLE.ADMIN,
        purgeAfter,
        retentionDays: RECYCLE_BIN_RETENTION_DAYS,
      },
    });
    return getAdminUser(db, id, { includeDeleted: true });
  });
}

/** Restore a recycled account. A Super Admin needs a free active seat. */
export function restoreAdminUser(db, { actor, adminUserId, now = Date.now() } = {}) {
  requireSuperAdminActor(actor);
  const id = normaliseId(adminUserId);

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
    if (!current || current.is_system === 1) throw notFound('Staff account not found.');
    if (current.deleted_at === null) throw conflict('This account is not in the recycle bin.');

    lockSuperAdminCap(db);
    if (current.is_super_admin === 1) assertSuperAdminCapacity(db, { excludeId: id });

    db.prepare(`
      UPDATE admin_user
         SET deleted_at = NULL, deleted_by = NULL, purge_after = NULL,
             is_active = 1, updated_at = ?
       WHERE id = ?
    `).run(now, id);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'admin_user.restored',
      entityType: 'admin_user',
      entityId: id,
      summary: `Restored ${current.email} from the recycle bin`,
      details: {
        email: current.email,
        role: current.is_super_admin === 1 ? ADMIN_ROLE.SUPER_ADMIN : ADMIN_ROLE.ADMIN,
      },
    });
    return getAdminUser(db, id);
  });
}

/** Find or create the inactive system principal used for purged authorship. */
function ensureSystemPrincipal(db, now = Date.now()) {
  let row = db.prepare(`
    SELECT id FROM admin_user
     WHERE COALESCE(is_system, 0) = 1
     ORDER BY id ASC LIMIT 1
  `).get();
  if (row) return Number(row.id);

  db.prepare(`
    INSERT OR IGNORE INTO admin_user
      (email, password_hash, display_name, role, is_active, created_at, updated_at, is_system)
    VALUES (?,?,?,'ADMIN',0,?,?,1)
  `).run(SYSTEM_PRINCIPAL_EMAIL, SYSTEM_PRINCIPAL_HASH, 'TRACE system principal', now, now);

  row = db.prepare(`
    SELECT id FROM admin_user
     WHERE COALESCE(is_system, 0) = 1
     ORDER BY id ASC LIMIT 1
  `).get();
  if (!row) throw new Error('The system principal could not be created for account purge.');
  return Number(row.id);
}

/**
 * Permanently remove recycled accounts.
 *
 * Called by the notification/maintenance cron as
 * `purgeDeletedAdmins(db, { now })` to auto-purge after 30 days, and by the
 * team screen with `adminUserId` for an immediate manual purge. Before each
 * row is deleted, ON DELETE RESTRICT authorship (reservations, maintenance
 * blocks) is reassigned to the inactive system principal.
 *
 * @returns {{count: number, purged: Array<{id:number,email:string,role:string,displayName:string}>}}
 */
export function purgeDeletedAdmins(db, {
  now = Date.now(), adminUserId = null, actor = null,
} = {}) {
  if (actor) requireSuperAdminActor(actor);

  return withWriteTransaction(db, () => {
    let rows;
    if (adminUserId !== null && adminUserId !== undefined) {
      const id = normaliseId(adminUserId);
      const row = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
      if (!row || row.is_system === 1) throw notFound('Staff account not found.');
      if (row.deleted_at === null) {
        throw conflict('Only accounts in the recycle bin can be permanently deleted.');
      }
      rows = [row];
    } else {
      rows = db.prepare(`
        SELECT * FROM admin_user
         WHERE deleted_at IS NOT NULL
           AND COALESCE(is_system, 0) = 0
           AND purge_after IS NOT NULL
           AND purge_after <= ?
         ORDER BY purge_after ASC, id ASC
      `).all(Number(now));
    }

    if (rows.length === 0) return { count: 0, purged: [] };

    const systemPrincipalId = ensureSystemPrincipal(db, Number(now));
    const purged = [];

    for (const row of rows) {
      // Reassign every ON DELETE RESTRICT reference before deleting the row.
      db.prepare('UPDATE reservation SET created_by = ? WHERE created_by = ?')
        .run(systemPrincipalId, row.id);
      db.prepare('UPDATE maintenance_block SET created_by = ? WHERE created_by = ?')
        .run(systemPrincipalId, row.id);

      db.prepare('DELETE FROM admin_user WHERE id = ?').run(row.id);

      const role = row.is_super_admin === 1 ? ADMIN_ROLE.SUPER_ADMIN : ADMIN_ROLE.ADMIN;
      recordAudit(db, {
        at: Number(now),
        actorAdminUserId: actor?.id ?? null,
        actorLabel: actor?.label ?? 'system',
        action: 'admin_user.purged',
        entityType: 'admin_user',
        entityId: row.id,
        summary: `Permanently deleted ${row.email} from the recycle bin`,
        details: {
          email: row.email,
          displayName: row.display_name,
          role,
          reassignedToSystemPrincipalId: systemPrincipalId,
        },
      });
      purged.push({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role,
      });
    }

    return { count: purged.length, purged };
  });
}

/**
 * Self-service password change. The caller's current password is required.
 * Every *other* live session for the account is revoked; pass `keepSessionId`
 * so the session performing the change survives. A successful change clears
 * the forced-password-change flag set by an administrative reset.
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
    if (!current || current.deleted_at !== null) throw notFound('Staff account not found.');
    if (!verifyPassword(currentPassword, current.password_hash)) {
      throw validationError('The current password is incorrect.', { field: 'current_password' });
    }

    const now = Date.now();
    db.prepare(`
      UPDATE admin_user
         SET password_hash = ?, failed_logins = 0, locked_until = NULL,
             must_change_password = 0, updated_at = ?
       WHERE id = ?
    `).run(hashPassword(newPassword), now, id);

    const keep = keepSessionId === null || keepSessionId === undefined ? null : Number(keepSessionId);
    if (keep === null) {
      db.prepare(`
        UPDATE admin_session SET revoked_at = ?
         WHERE admin_user_id = ? AND revoked_at IS NULL
      `).run(now, id);
    } else {
      db.prepare(`
        UPDATE admin_session SET revoked_at = ?
         WHERE admin_user_id = ? AND revoked_at IS NULL AND id <> ?
      `).run(now, id, keep);
    }

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
 * Administrative password reset: Super Admin only, no current-password
 * challenge. Sets the forced-change flag and revokes every target session.
 */
export function setPassword(db, { actor, adminUserId, newPassword } = {}) {
  requireSuperAdminActor(actor);
  const id = normaliseId(adminUserId);
  passwordProblemsOrThrow(newPassword, 'new_password');

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(id);
    if (!current || current.is_system === 1) throw notFound('Staff account not found.');
    if (current.deleted_at !== null) {
      throw conflict('This account is in the recycle bin. Restore it before resetting its password.');
    }

    const now = Date.now();
    db.prepare(`
      UPDATE admin_user
         SET password_hash = ?, failed_logins = 0, locked_until = NULL,
             must_change_password = 1, updated_at = ?
       WHERE id = ?
    `).run(hashPassword(newPassword), now, id);
    revokeAllSessionsForUser(db, id, now);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'admin_user.password_reset',
      entityType: 'admin_user',
      entityId: id,
      summary: `Reset password for ${current.email}`,
      details: { forced: true, mustChangePassword: true },
    });
    return getAdminUser(db, id);
  });
}

/** Generate (or accept) a temporary password, reset it and return it once. */
export function resetAdminPassword(db, {
  actor, adminUserId, newPassword = null,
} = {}) {
  const temporaryPassword = newPassword || generateTemporaryPassword();
  const user = setPassword(db, { actor, adminUserId, newPassword: temporaryPassword });
  return { user, temporaryPassword, generated: !newPassword };
}

/**
 * Bootstrap hook, safe on every boot: creates the first Super Admin only
 * when the table has no non-system rows; never touches existing rows.
 *
 * @returns {{created: boolean, reason: string|null, user?: object}}
 */
export function ensureFirstAdmin(db, { email, password, displayName = null } = {}) {
  return withWriteTransaction(db, () => {
    const existing = Number(db.prepare(
      'SELECT COUNT(*) AS c FROM admin_user WHERE COALESCE(is_system, 0) = 0',
    ).get().c);
    if (existing > 0) return { created: false, reason: 'administrators already exist' };

    const normalisedEmail = normalizeEmail(requiredEmail(email, { field: 'email' }));
    const name = String(displayName ?? '').trim() || normalisedEmail;
    passwordProblemsOrThrow(password);

    const now = Date.now();
    let info;
    try {
      info = db.prepare(`
        INSERT INTO admin_user
          (email, password_hash, display_name, role, is_super_admin, is_active,
           created_at, updated_at)
        VALUES (?,?,?,'ADMIN',1,1,?,?)
      `).run(
        normalisedEmail,
        hashPassword(password),
        name.slice(0, LIMITS.maxNameLength),
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
      summary: `Created initial Super Admin ${normalisedEmail}`,
      details: { email: normalisedEmail, role: ADMIN_ROLE.SUPER_ADMIN, bootstrap: true },
    });
    return { created: true, reason: null, user: getAdminUser(db, id) };
  });
}
