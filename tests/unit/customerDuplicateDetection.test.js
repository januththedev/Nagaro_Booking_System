/**
 * Unit tests for customer duplicate detection.
 *
 * These run against a real in-memory SQLite database with the production
 * migrations applied (`new DatabaseSync(':memory:')` + `applyMigrations`), so
 * the `email_normalized` index and the actual normalisation path are exercised
 * rather than a mock. Records are created through the real `createCustomer`
 * service, so the stored `email_normalized` value is exactly what production
 * stores.
 *
 * This file intentionally does not import `tests/helpers/testDb.js` (owned by
 * another workstream); it builds its own handle.
 *
 * The rule under test: detection only ever *reports*. Nothing is merged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { applyMigrations } from '../../src/server/db/migrate.js';
import { findPossibleDuplicates, createCustomer } from '../../src/server/services/customerService.js';
import { normalizeEmail } from '../../src/server/domain/validation.js';

const ACTOR = { id: 1, label: 'Unit Admin (ADMIN)', role: 'ADMIN' };

/** A migrated in-memory database plus the administrator the FK on audit needs. */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db);
  const now = Date.now();
  db.prepare(`
    INSERT INTO admin_user (email, password_hash, display_name, role, is_active, created_at, updated_at)
    VALUES (?,?,?,?,1,?,?)
  `).run('unit-admin@nagaro.test', 'scrypt$16384$8$1$unit$hash', 'Unit Admin', 'ADMIN', now, now);
  return db;
}

/** Create a customer through the real service. */
function seedCustomer(db, { fullName, email, organization = '', phone = '' }) {
  return createCustomer(db, {
    actor: ACTOR,
    payload: {
      full_name: fullName,
      email,
      organization,
      phone,
    },
  });
}

/* ------------------------------------------------------------- email matching */

test('findPossibleDuplicates finds a customer by email regardless of case and surrounding whitespace', (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const hanna = seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });

  const matches = findPossibleDuplicates(db, { email: ' Hanna@Example.COM ' });

  assert.equal(matches.length, 1, 'one duplicate expected for hanna@example.com');
  assert.equal(matches[0].customer.id, hanna.id);
  assert.equal(matches[0].customer.fullName, 'Hanna Tesfaye');
  // The original spelling is preserved; only the comparison form is normalised.
  assert.equal(matches[0].customer.email, 'hanna@example.com');
});

test("an email hit reports match: 'email' with confidence: 'high'", (t) => {
  const db = freshDb();
  t.after(() => db.close());
  seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });

  const matches = findPossibleDuplicates(db, { email: 'HANNA@EXAMPLE.COM' });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].match, 'email');
  assert.equal(matches[0].confidence, 'high');
  assert.ok(matches[0].customer.stats, 'the hydrated customer carries lifetime stats for the review panel');
});

/* -------------------------------------------------------------- name matching */

test("a partial name match reports match: 'name' with confidence: 'medium'", (t) => {
  const db = freshDb();
  t.after(() => db.close());
  seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });
  seedCustomer(db, { fullName: 'Yonas Bekele', email: 'yonas@example.com' });

  // No email given, so the only possible match source is the loose LIKE on name.
  const matches = findPossibleDuplicates(db, { email: null, fullName: 'Tesfaye' });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].customer.fullName, 'Hanna Tesfaye');
  assert.equal(matches[0].match, 'name');
  assert.equal(matches[0].confidence, 'medium', 'a name hit is explicitly "possible", never certain');
});

test('a name hit never masquerades as an email hit', (t) => {
  const db = freshDb();
  t.after(() => db.close());
  seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });

  const matches = findPossibleDuplicates(db, { email: 'someone-else@example.com', fullName: 'Tesfaye' });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].match, 'name');
  assert.equal(matches[0].confidence, 'medium');
});

test('an email hit is not repeated as a name hit for the same customer', (t) => {
  const db = freshDb();
  t.after(() => db.close());
  seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });

  const matches = findPossibleDuplicates(db, { email: 'hanna@example.com', fullName: 'Hanna Tesfaye' });

  assert.equal(matches.length, 1, 'one customer must appear once, with the stronger match');
  assert.equal(matches[0].match, 'email');
  assert.equal(matches[0].confidence, 'high');
});

/* ------------------------------------------------------------------ excludeId */

test('excludeId removes the customer being edited from its own duplicate list', (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const hanna = seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });

  const withSelf = findPossibleDuplicates(db, { email: 'hanna@example.com', fullName: 'Hanna Tesfaye' });
  assert.equal(withSelf.length, 1);

  const withoutSelf = findPossibleDuplicates(db, {
    email: 'hanna@example.com', fullName: 'Hanna Tesfaye', excludeId: hanna.id,
  });
  assert.deepEqual(withoutSelf, [], 'editing a customer must never flag that customer as its own duplicate');
});

test('excludeId only excludes the given customer, not everyone', (t) => {
  const db = freshDb();
  t.after(() => db.close());
  const hanna = seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });
  const hannaTwo = seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna2@example.com' });

  const matches = findPossibleDuplicates(db, {
    email: 'hanna@example.com', fullName: 'Hanna Tesfaye', excludeId: hannaTwo.id,
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].customer.id, hanna.id);
});

/* ------------------------------------------------------------ normalizeEmail */

test('normalizeEmail trims, lower-cases and survives unicode input', () => {
  assert.equal(normalizeEmail('  Hanna@Example.COM '), 'hanna@example.com');
  assert.equal(normalizeEmail('Hanna@Example.COM'), 'hanna@example.com');
  assert.equal(normalizeEmail('ÜNÏCODE@EXÄMPLE.COM '), 'ünïcode@exämple.com');
  assert.equal(normalizeEmail('  Selam   @  Example.com'), 'selam   @  example.com');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('duplicate detection uses normalizeEmail, not SQLite lower()', (t) => {
  const db = freshDb();
  t.after(() => db.close());
  // SQLite's built-in lower() is ASCII-only, so 'Ü' would not fold if the
  // comparison happened in SQL. Storing through the service and reading back
  // with mixed case + whitespace must still match.
  const unicode = seedCustomer(db, { fullName: 'Ünïcode Öztürk', email: 'Ünïcode@Exämple.COM' });

  const matches = findPossibleDuplicates(db, { email: ' ünïcode@exämple.com  ' });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].customer.id, unicode.id);
  assert.equal(matches[0].match, 'email');
  assert.equal(matches[0].confidence, 'high');
});

/* --------------------------------------------------------------- empty queries */

test('an empty query returns no matches rather than throwing', (t) => {
  const db = freshDb();
  t.after(() => db.close());
  seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });

  assert.deepEqual(findPossibleDuplicates(db, {}), []);
  assert.deepEqual(findPossibleDuplicates(db, { email: null, fullName: null }), []);
  assert.deepEqual(findPossibleDuplicates(db, { email: '', fullName: '' }), []);
  assert.deepEqual(findPossibleDuplicates(db, { email: undefined, fullName: undefined }), []);
  // A name shorter than the 3-character minimum is not searched at all.
  assert.deepEqual(findPossibleDuplicates(db, { email: '   ', fullName: ' ab ' }), []);
  // No argument at all must also be safe.
  assert.deepEqual(findPossibleDuplicates(db), []);
});

test('duplicate detection reports and never writes', (t) => {
  const db = freshDb();
  t.after(() => db.close());
  seedCustomer(db, { fullName: 'Hanna Tesfaye', email: 'hanna@example.com' });
  const before = db.prepare('SELECT COUNT(*) AS c FROM customer').get().c;

  findPossibleDuplicates(db, { email: 'hanna@example.com', fullName: 'Hanna Tesfaye' });

  const after = db.prepare('SELECT COUNT(*) AS c FROM customer').get().c;
  assert.equal(after, before, 'detection is read-only: no record is created, merged or altered');
});
