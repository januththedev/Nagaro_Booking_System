/**
 * Initial-administrator bootstrap: idempotency and safety.
 *
 * ensureFirstAdmin() is the single bootstrap path used by both the boot-time
 * environment bootstrap (NAGARO_BOOTSTRAP_ADMIN_*) and the documented manual
 * procedure. These tests prove, against the real SQLite schema:
 *   - the first call creates the account and returns created=true;
 *   - reruns never create duplicates and never touch the existing row
 *     (password hash and display name are unchanged);
 *   - weak passwords are rejected and create nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, closeTestDb } from '../helpers/testDb.js';
import { ensureFirstAdmin } from '../../src/server/services/adminUserService.js';
import { verifyPassword } from '../../src/server/security/passwords.js';

function freshDb() {
  return createTestDb({ path: ':memory:' });
}

test('first bootstrap creates the administrator account', () => {
  const db = freshDb();
  try {
    const result = ensureFirstAdmin(db, {
      email: 'nimnaljanuth@gmail.com',
      password: 'Str0ng-Preview-Pass!',
      displayName: 'Nagaro Owner',
    });
    assert.equal(result.created, true);
    assert.equal(result.user.email, 'nimnaljanuth@gmail.com');
    assert.equal(result.user.role, 'ADMIN');
    const row = db.prepare('SELECT * FROM admin_user WHERE email = ?').get('nimnaljanuth@gmail.com');
    assert.ok(row, 'row exists');
    assert.ok(verifyPassword('Str0ng-Preview-Pass!', row.password_hash), 'hash verifies');
    assert.ok(!String(row.password_hash).includes('Str0ng-Preview-Pass!'), 'no plaintext stored');
  } finally {
    closeTestDb(db);
  }
});

test('rerunning bootstrap never duplicates or resets the account', () => {
  const db = freshDb();
  try {
    const first = ensureFirstAdmin(db, {
      email: 'nimnaljanuth@gmail.com',
      password: 'Str0ng-Preview-Pass!',
    });
    assert.equal(first.created, true);
    const before = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(first.user.id);

    const second = ensureFirstAdmin(db, {
      email: 'someone-else@example.com',
      password: 'An0ther-Strong-Pass!',
    });
    assert.equal(second.created, false);
    assert.equal(second.reason, 'administrators already exist');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM admin_user').get().c,
      1,
      'no second account created',
    );
    const after = db.prepare('SELECT * FROM admin_user WHERE id = ?').get(first.user.id);
    assert.equal(after.password_hash, before.password_hash, 'existing password hash untouched');
    assert.equal(after.display_name, before.display_name, 'existing display name untouched');
    assert.ok(verifyPassword('Str0ng-Preview-Pass!', after.password_hash), 'original password still works');
  } finally {
    closeTestDb(db);
  }
});

test('a weak bootstrap password is rejected and creates nothing', () => {
  const db = freshDb();
  try {
    assert.throws(
      () => ensureFirstAdmin(db, { email: 'nimnaljanuth@gmail.com', password: 'weak' }),
      (error) => error?.code === 'VALIDATION_ERROR',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM admin_user').get().c, 0);
  } finally {
    closeTestDb(db);
  }
});
