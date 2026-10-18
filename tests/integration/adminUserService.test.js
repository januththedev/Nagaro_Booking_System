/**
 * Admin-user service integration tests.
 *
 * Exercises the real scrypt hashing, the email uniqueness rule, the
 * last-active-administrator guard and session revocation against a real
 * SQLite database built by tests/helpers/testDb.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTestDb, closeTestDb, createTestActor, withTempFileDb, TEST_PASSWORD,
} from '../helpers/testDb.js';
import {
  listAdminUsers, getAdminUser, createAdminUser, updateAdminUser, changeOwnPassword,
  setPassword, countActiveAdmins, ensureFirstAdmin, deactivateAdminUser,
} from '../../src/server/services/adminUserService.js';
import { authenticate, createSession, resolveSession } from '../../src/server/security/sessions.js';
import { verifyPassword } from '../../src/server/security/passwords.js';

const scalar = (db, sql, ...params) => Number(Object.values(db.prepare(sql).get(...params))[0] ?? 0);

test('createAdminUser: hashes the password, normalises the email and never returns the hash', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const actor = createTestActor(db);

  const password = 'SuperSecret123';
  const user = createAdminUser(db, {
    actor,
    payload: {
      email: '  OWNER@Example.COM ',
      display_name: 'Owner',
      role: 'ADMIN',
      password,
    },
  });

  assert.equal(user.email, 'owner@example.com', 'email is trimmed and lower-cased');
  assert.equal(user.displayName, 'Owner');
  assert.equal(user.role, 'ADMIN');
  assert.equal(user.isActive, true);
  assert.equal('password_hash' in user, false);
  assert.equal('passwordHash' in user, false);

  const row = db.prepare('SELECT password_hash FROM admin_user WHERE id = ?').get(user.id);
  assert.ok(row.password_hash.startsWith('scrypt$'), 'stored in the scrypt$N$r$p$salt$hash format');
  assert.equal(verifyPassword(password, row.password_hash), true);
  assert.equal(verifyPassword('SuperSecret124', row.password_hash), false);

  // The hash round-trips through the real sign-in path.
  const account = authenticate(db, { email: 'OWNER@EXAMPLE.COM', password });
  assert.equal(account.id, user.id);

  assert.equal(getAdminUser(db, user.id).email, 'owner@example.com');
  const listed = listAdminUsers(db).map((u) => u.email);
  assert.ok(listed.includes('owner@example.com'));
  assert.ok(listed.includes('admin@test.local'));
});

test('createAdminUser: weak passwords are rejected with field problems and no row is written', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const actor = createTestActor(db);

  const before = scalar(db, 'SELECT COUNT(*) FROM admin_user');

  const expectProblem = (password, fragment) => {
    assert.throws(
      () => createAdminUser(db, {
        actor,
        payload: { email: `weak-${Math.random().toString(36).slice(2)}@example.com`, display_name: 'Weak', password },
      }),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.details.field, 'password');
        assert.ok(Array.isArray(error.details.problems));
        assert.ok(
          error.details.problems.some((p) => p.toLowerCase().includes(fragment)),
          `expected a problem mentioning "${fragment}", got: ${error.details.problems.join(' | ')}`,
        );
        return true;
      },
    );
  };

  expectProblem('short', 'at least 10 characters');
  expectProblem('abcdefghijklmnop', 'at least one number');
  expectProblem('1234567890123', 'at least one letter');
  expectProblem('password123456', 'avoid common passwords');

  assert.equal(scalar(db, 'SELECT COUNT(*) FROM admin_user'), before, 'no account was created');
});

test('createAdminUser / updateAdminUser: duplicate emails are a friendly conflict, case-insensitively', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const actor = createTestActor(db);

  createAdminUser(db, {
    actor,
    payload: { email: 'dup@example.com', display_name: 'First', role: 'STAFF', password: 'DuplicatePass1' },
  });
  const before = scalar(db, 'SELECT COUNT(*) FROM admin_user');

  assert.throws(
    () => createAdminUser(db, {
      actor,
      payload: { email: 'DUP@EXAMPLE.COM', display_name: 'Copy', role: 'STAFF', password: 'DuplicatePass1' },
    }),
    (error) => error.code === 'CONFLICT' && /already exists/i.test(error.message),
  );
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM admin_user'), before);

  const other = createAdminUser(db, {
    actor,
    payload: { email: 'other@example.com', display_name: 'Other', role: 'STAFF', password: 'OtherPerson123' },
  });
  assert.throws(
    () => updateAdminUser(db, { actor, adminUserId: other.id, payload: { email: 'dup@example.com' } }),
    (error) => error.code === 'CONFLICT' && /already uses this email/i.test(error.message),
  );
  assert.equal(getAdminUser(db, other.id).email, 'other@example.com', 'the failed update rolled back');
});

test('last-admin protection: the only active administrator cannot be demoted or deactivated', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const actor = createTestActor(db, { email: 'only-admin@test.local', name: 'Only Admin' });
  assert.equal(countActiveAdmins(db), 1);

  assert.throws(
    () => updateAdminUser(db, { actor, adminUserId: actor.id, payload: { role: 'STAFF' } }),
    (error) => error.code === 'CONFLICT' && /at least one active administrator/i.test(error.message),
  );
  assert.throws(
    () => deactivateAdminUser(db, { actor, adminUserId: actor.id }),
    (error) => error.code === 'CONFLICT' && /at least one active administrator/i.test(error.message),
  );

  assert.equal(getAdminUser(db, actor.id).role, 'ADMIN');
  assert.equal(getAdminUser(db, actor.id).isActive, true);
  assert.equal(countActiveAdmins(db), 1);

  // With a second active administrator, demoting one works ...
  const second = createAdminUser(db, {
    actor,
    payload: { email: 'second@test.local', display_name: 'Second', role: 'ADMIN', password: 'SecondAdmin123' },
  });
  const demoted = updateAdminUser(db, { actor, adminUserId: second.id, payload: { role: 'STAFF' } });
  assert.equal(demoted.role, 'STAFF');
  assert.equal(countActiveAdmins(db), 1);

  // ... and the first administrator cannot be demoted now either.
  assert.throws(
    () => updateAdminUser(db, { actor, adminUserId: actor.id, payload: { role: 'STAFF' } }),
    (error) => error.code === 'CONFLICT',
  );
  assert.equal(getAdminUser(db, actor.id).role, 'ADMIN');

  // Deactivating a STAFF account is fine.
  const off = deactivateAdminUser(db, { actor, adminUserId: second.id });
  assert.equal(off.isActive, false);
  assert.equal(countActiveAdmins(db), 1);
  assert.deepEqual(listAdminUsers(db).map((u) => u.id), [actor.id]);
  assert.equal(listAdminUsers(db, { includeInactive: true }).length, 2);
});

test('ensureFirstAdmin: creates one administrator, then refuses to touch anything', async () => {
  await withTempFileDb(async (db) => {
    const first = ensureFirstAdmin(db, {
      email: 'First@Example.com', password: 'FirstAdmin123', displayName: 'First Admin',
    });
    assert.equal(first.created, true);
    assert.equal(first.reason, null);
    assert.equal(first.user.role, 'ADMIN');
    assert.equal(first.user.email, 'first@example.com');
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM admin_user'), 1);

    const storedHash = db.prepare('SELECT password_hash FROM admin_user WHERE id = ?').get(first.user.id).password_hash;
    assert.equal(verifyPassword('FirstAdmin123', storedHash), true);

    const again = ensureFirstAdmin(db, {
      email: 'other@example.com', password: 'OtherAdmin123', displayName: 'Other Admin',
    });
    assert.deepEqual(again, { created: false, reason: 'administrators already exist' });
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM admin_user'), 1);
    assert.equal(getAdminUser(db, first.user.id).email, 'first@example.com', 'nothing was overwritten');
    assert.equal(
      db.prepare('SELECT password_hash FROM admin_user WHERE id = ?').get(first.user.id).password_hash,
      storedHash,
      'the existing password hash is untouched',
    );
  });
});

test('ensureFirstAdmin: any existing row (even inactive or staff) blocks creation', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  createTestActor(db, { email: 'existing@test.local', role: 'STAFF' });

  const result = ensureFirstAdmin(db, { email: 'new@example.com', password: 'NewAdmin12345', displayName: 'New' });
  assert.deepEqual(result, { created: false, reason: 'administrators already exist' });
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM admin_user'), 1);
});

test('ensureFirstAdmin: rejects a weak bootstrap password and defaults the name to the email', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));

  assert.throws(
    () => ensureFirstAdmin(db, { email: 'boot@example.com', password: 'weak', displayName: 'Boot' }),
    (error) => error.code === 'VALIDATION_ERROR' && Array.isArray(error.details.problems),
  );
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM admin_user'), 0);

  const created = ensureFirstAdmin(db, { email: 'boot@example.com', password: 'BootstrapPass1' });
  assert.equal(created.created, true);
  assert.equal(created.user.displayName, 'boot@example.com');
  assert.equal(authenticate(db, { email: 'boot@example.com', password: 'BootstrapPass1' }).id, created.user.id);
});

test('deactivating a user revokes every session and blocks sign-in', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const actor = createTestActor(db, { email: 'session-admin@test.local' });
  const user = createAdminUser(db, {
    actor,
    payload: { email: 'staffer@test.local', display_name: 'Staffer', role: 'STAFF', password: 'StafferPass123' },
  });

  const session = createSession(db, { adminUserId: user.id, userAgent: 'test-agent' });
  assert.ok(resolveSession(db, session.token), 'the session works before deactivation');
  assert.equal(authenticate(db, { email: 'staffer@test.local', password: 'StafferPass123' }).id, user.id);

  const deactivated = deactivateAdminUser(db, { actor, adminUserId: user.id });
  assert.equal(deactivated.isActive, false);

  assert.equal(resolveSession(db, session.token), null, 'the revoked token no longer resolves');
  const sessions = db.prepare('SELECT revoked_at FROM admin_session WHERE admin_user_id = ?').all(user.id);
  assert.ok(sessions.length >= 1);
  assert.ok(sessions.every((row) => row.revoked_at !== null), 'every stored session row is revoked');

  assert.throws(
    () => authenticate(db, { email: 'staffer@test.local', password: 'StafferPass123' }),
    (error) => error.code === 'FORBIDDEN' && /disabled/i.test(error.message),
  );

  // A deactivated account can be brought back through updateAdminUser.
  const revived = updateAdminUser(db, { actor, adminUserId: user.id, payload: { is_active: true } });
  assert.equal(revived.isActive, true);
  assert.equal(authenticate(db, { email: 'staffer@test.local', password: 'StafferPass123' }).id, user.id);
});

test('changeOwnPassword: checks the current password, keeps the caller session, revokes the rest', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const admin = createTestActor(db, { email: 'pw-admin@test.local' });
  const user = createAdminUser(db, {
    actor: admin,
    payload: { email: 'pw-user@test.local', display_name: 'PW User', role: 'STAFF', password: 'OriginalPass123' },
  });
  const ownActor = { id: user.id, label: user.displayName, role: user.role };

  const callerSession = createSession(db, { adminUserId: user.id, userAgent: 'browser-a' });
  const otherSession = createSession(db, { adminUserId: user.id, userAgent: 'browser-b' });
  const callerSessionId = resolveSession(db, callerSession.token).sessionId;

  assert.throws(
    () => changeOwnPassword(db, {
      actor: ownActor, adminUserId: user.id, currentPassword: 'NotThePassword1', newPassword: 'NewPassword456',
    }),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'current_password',
  );

  assert.throws(
    () => changeOwnPassword(db, {
      actor: ownActor, adminUserId: user.id, currentPassword: 'OriginalPass123', newPassword: 'weak',
    }),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'new_password',
  );

  assert.throws(
    () => changeOwnPassword(db, {
      actor: { id: 9999, label: 'Someone else', role: 'STAFF' },
      adminUserId: user.id, currentPassword: 'OriginalPass123', newPassword: 'NewPassword456',
    }),
    (error) => error.code === 'FORBIDDEN',
  );

  const changed = changeOwnPassword(db, {
    actor: ownActor,
    adminUserId: user.id,
    currentPassword: 'OriginalPass123',
    newPassword: 'NewPassword456',
    keepSessionId: callerSessionId,
  });
  assert.equal(changed.id, user.id);

  assert.ok(resolveSession(db, callerSession.token), 'the calling session survives');
  assert.equal(resolveSession(db, otherSession.token), null, 'the other session is revoked');

  assert.equal(authenticate(db, { email: 'pw-user@test.local', password: 'NewPassword456' }).id, user.id);
  assert.throws(
    () => authenticate(db, { email: 'pw-user@test.local', password: 'OriginalPass123' }),
    (error) => error.code === 'UNAUTHORIZED',
  );
});

test('setPassword: ADMIN only, no current password needed, revokes all target sessions', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const admin = createTestActor(db, { email: 'reset-admin@test.local' });
  const user = createAdminUser(db, {
    actor: admin,
    payload: { email: 'reset-user@test.local', display_name: 'Reset User', role: 'STAFF', password: 'BeforeReset123' },
  });

  assert.throws(
    () => setPassword(db, {
      actor: { id: user.id, label: user.displayName, role: 'STAFF' },
      adminUserId: user.id,
      newPassword: 'AfterReset1234',
    }),
    (error) => error.code === 'FORBIDDEN',
  );

  const session = createSession(db, { adminUserId: user.id });
  const updated = setPassword(db, { actor: admin, adminUserId: user.id, newPassword: 'AfterReset1234' });
  assert.equal(updated.id, user.id);
  assert.equal(resolveSession(db, session.token), null, 'every target session is revoked');
  assert.equal(authenticate(db, { email: 'reset-user@test.local', password: 'AfterReset1234' }).id, user.id);

  assert.throws(
    () => setPassword(db, { actor: admin, adminUserId: user.id, newPassword: 'short' }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

test('every mutation writes its audit entry', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const actor = createTestActor(db, { email: 'audit-admin@test.local' });

  const created = createAdminUser(db, {
    actor,
    payload: { email: 'audit-user@test.local', display_name: 'Audit User', role: 'STAFF', password: 'AuditPass1234' },
  });
  updateAdminUser(db, { actor, adminUserId: created.id, payload: { display_name: 'Audit User Renamed' } });
  changeOwnPassword(db, {
    actor: { id: created.id, label: created.displayName, role: created.role },
    adminUserId: created.id,
    currentPassword: 'AuditPass1234',
    newPassword: 'AuditPass5678',
  });
  setPassword(db, { actor, adminUserId: created.id, newPassword: 'AuditPass9012' });
  deactivateAdminUser(db, { actor, adminUserId: created.id });

  const actions = db.prepare(
    "SELECT DISTINCT action FROM audit_log WHERE entity_type = 'admin_user'",
  ).all().map((row) => row.action).sort();
  assert.deepEqual(actions, ['admin_user.created', 'admin_user.password_changed', 'admin_user.updated']);

  const auditEntries = db.prepare(
    'SELECT actor_label, summary FROM audit_log WHERE entity_type = ? ORDER BY id',
  ).all('admin_user');
  assert.ok(auditEntries.length >= 5);
  assert.ok(auditEntries.some((entry) => /Deactivated/i.test(entry.summary)));
  assert.ok(auditEntries.every((entry) => entry.actor_label === 'system' || entry.actor_label.length > 0));
});

test('createAdminUser: role defaults to STAFF and unknown roles are rejected', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const actor = createTestActor(db);

  const staff = createAdminUser(db, {
    actor,
    payload: { email: 'default-role@test.local', display_name: 'Default Role', password: 'DefaultRole123' },
  });
  assert.equal(staff.role, 'STAFF');

  assert.throws(
    () => createAdminUser(db, {
      actor,
      payload: { email: 'bad-role@test.local', display_name: 'Bad Role', role: 'SUPERUSER', password: 'BadRolePass12' },
    }),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'role',
  );

  assert.throws(
    () => updateAdminUser(db, { actor, adminUserId: staff.id, payload: { role: 'OWNER' } }),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'role',
  );
});

test('guests cannot create or modify accounts, and unknown ids are not found', (t) => {
  const db = createTestDb();
  t.after(() => closeTestDb(db));
  const actor = createTestActor(db);

  assert.throws(
    () => createAdminUser(db, { payload: { email: 'x@example.com', display_name: 'X', password: 'NopeNope123' } }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => updateAdminUser(db, { actor, adminUserId: 424242, payload: { display_name: 'Ghost' } }),
    (error) => error.code === 'NOT_FOUND',
  );
  assert.throws(
    () => setPassword(db, { actor, adminUserId: 424242, newPassword: 'NoAccount123' }),
    (error) => error.code === 'NOT_FOUND',
  );
  assert.equal(getAdminUser(db, 424242), null);

  // Smoke: the helper's default password still signs in.
  const found = authenticate(db, { email: 'admin@test.local', password: TEST_PASSWORD });
  assert.equal(found.id, actor.id);
});
