/**
 * PostgreSQL migration runner: mechanics plus migration-file contract.
 *
 * Mechanics run against pg-mem (a real PostgreSQL wire-protocol
 * implementation): ordering, ledger, idempotent reruns, rollback on failure.
 * pg-mem cannot load extensions (btree_gist) or enforce GiST exclusion
 * constraints, so the shipped db/migrations-postgres/0001_init.sql itself is
 * covered by a static contract test instead — honestly labelled as such.
 * The full migration must still be applied once against real Supabase
 * PostgreSQL (scripts/migrate-postgres.js) before the cutover.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import {
  applyPgMigrations, listPgMigrationFiles, pgConnectionString, pgMigrationsDir,
} from '../../scripts/migrate-postgres.js';
import { applyMigrations } from '../../src/server/db/migrate.js';

function memClient() {
  const db = newDb();
  const { Client } = db.adapters.createPg();
  return new Client();
}

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nagaro-pg-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

test('SQLite migration runner refuses a PostgreSQL handle', () => {
  assert.throws(
    () => applyMigrations({ dialect: 'postgres' }),
    (error) => /migrate:postgres/.test(error.message),
  );
});

test('pgConnectionString prefers DIRECT_URL, falls back to DATABASE_URL, else null', () => {
  assert.equal(pgConnectionString({ DIRECT_URL: 'direct', DATABASE_URL: 'pooled' }), 'direct');
  assert.equal(pgConnectionString({ DATABASE_URL: 'pooled' }), 'pooled');
  assert.equal(pgConnectionString({}), null);
  assert.equal(pgConnectionString({ DIRECT_URL: '  ', DATABASE_URL: '' }), null);
});

test('listPgMigrationFiles only takes .sql in sorted order', () => {
  const dir = fixtureDir({ 'b.sql': 'SELECT 1', 'a.sql': 'SELECT 1', 'note.txt': 'x' });
  try {
    assert.deepEqual(listPgMigrationFiles(dir), ['a.sql', 'b.sql']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPgMigrations applies in order, records the ledger, and is idempotent', async () => {
  const dir = fixtureDir({
    // NOTE: single statements without trailing semicolons — pg-mem rejects
    // trailing semicolons, while real node-postgres accepts multi-statement
    // files (the runner intentionally sends each file whole, since naive
    // splitting would break DO $$ blocks).
    '0001_a.sql': 'CREATE TABLE widget_a (id SERIAL PRIMARY KEY, name TEXT)',
    '0002_b.sql': 'CREATE TABLE widget_b (id SERIAL PRIMARY KEY, a_id INTEGER REFERENCES widget_a(id))',
  });
  const client = memClient();
  try {
    const first = await applyPgMigrations(client, { dir });
    assert.deepEqual(first, ['0001_a.sql', '0002_b.sql']);
    const ledger = (await client.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    assert.deepEqual(ledger, ['0001_a.sql', '0002_b.sql']);
    const second = await applyPgMigrations(client, { dir });
    assert.deepEqual(second, [], 'reruns apply nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPgMigrations rolls back a failing file and names it', async () => {
  const dir = fixtureDir({
    '0001_good.sql': 'CREATE TABLE thing (id SERIAL PRIMARY KEY)',
    '0002_bad.sql': 'CREATE TABLE broken (id THIS_IS_NOT_A_TYPE)',
  });
  const client = memClient();
  try {
    await assert.rejects(() => applyPgMigrations(client, { dir }), /0002_bad\.sql/);
    const tables = (await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )).rows.map((r) => r.table_name);
    assert.ok(tables.includes('thing'), 'the good file stays applied');
    assert.ok(!tables.includes('broken'), 'the failed file leaves no partial table');
    const ledger = (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name);
    assert.deepEqual(ledger, ['0001_good.sql'], 'the failed file is not recorded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pgMigrationsDir defaults to the shipped directory and honours the override', async () => {
  const { readFileSync } = await import('node:fs');
  const def = pgMigrationsDir();
  assert.ok(def.endsWith('migrations-postgres'));
  assert.ok(listPgMigrationFiles(def).includes('0001_init.sql'));
  void readFileSync;
});

test('CONTRACT (static): optional advances are stored as immutable attempt snapshots and obligation credits', async () => {
  const { readFileSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const sql = readFileSync(joinPath(pgMigrationsDir(), '0004_optional_advances.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE payment_obligation[\s\S]+advance_paid_cents BIGINT NOT NULL DEFAULT 0/i);
  assert.match(sql, /ALTER TABLE payment_attempt[\s\S]+advance_cents BIGINT NOT NULL DEFAULT 0/i);
});

test('CONTRACT (static): 0005 adds the two-role model, recycle bin and cap indexes', async () => {
  const { readFileSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const sql = readFileSync(joinPath(pgMigrationsDir(), '0005_admin_roles_recycle_bin.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /ADD COLUMN deleted_at BIGINT/i);
  assert.match(sql, /ADD COLUMN deleted_by BIGINT REFERENCES admin_user\(id\) ON DELETE SET NULL/i);
  assert.match(sql, /ADD COLUMN purge_after BIGINT/i);
  assert.match(sql, /ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql, /UPDATE admin_user SET role = 'ADMIN' WHERE role = 'STAFF'/i);
  assert.match(sql, /SET is_super_admin = 1/i);
  assert.match(sql, /COALESCE\(is_system, 0\) = 0/i);
  assert.match(sql, /ORDER BY is_active DESC, created_at ASC, id ASC/i);
  assert.match(sql, /LIMIT 3/i);
  assert.match(sql, /CREATE INDEX ix_admin_user_active_super/i);
  assert.match(sql, /CREATE INDEX ix_admin_user_deleted/i);
});

test('CONTRACT (static): 0006 adds notifications, push subscriptions and dispatch indexes', async () => {
  const { readFileSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const sql = readFileSync(joinPath(pgMigrationsDir(), '0006_notifications.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE notification/i);
  assert.match(sql, /type\s+TEXT NOT NULL CHECK \(type IN \('NEW_BOOKING','BOOKING_CANCELLED','REMINDER'\)\)/i);
  assert.match(sql, /priority\s+TEXT NOT NULL DEFAULT 'NORMAL' CHECK \(priority IN \('NORMAL','HIGH'\)\)/i);
  assert.match(sql, /UNIQUE \(admin_user_id, dedupe_key\)/i);
  assert.match(sql, /CREATE INDEX ix_notification_unread/i);
  assert.match(sql, /CREATE INDEX ix_notification_priority/i);
  assert.match(sql, /CREATE INDEX ix_notification_due/i);
  assert.match(sql, /CREATE TABLE push_subscription/i);
  assert.match(sql, /endpoint\s+TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /failure_count\s+INTEGER NOT NULL DEFAULT 0 CHECK \(failure_count >= 0\)/i);
  assert.match(sql, /CREATE INDEX ix_push_subscription_user/i);
  assert.match(sql, /CREATE INDEX ix_push_subscription_prune/i);
});

test('CONTRACT (static): 0001_init.sql carries the full schema and the overlap guard', async () => {
  const { readFileSync } = await import('node:fs');
  const { join: joinPath, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const sql = readFileSync(
    joinPath(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations-postgres', '0001_init.sql'),
    'utf8',
  );
  for (const table of [
    'app_sequence', 'admin_user', 'admin_session', 'space', 'space_rate', 'resource_unit',
    'space_image', 'customer', 'reservation', 'occupancy', 'maintenance_block', 'inquiry',
    'audit_log', 'rate_limit_counter',
  ]) {
    assert.ok(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}\\b`).test(sql), `table ${table} present`);
  }
  assert.ok(/EXCLUDE USING gist/.test(sql), 'GiST exclusion constraint present');
  assert.ok(/int8range\(start_at, end_at/.test(sql), 'half-open range on the occupancy interval');
  assert.ok(/WHERE \(status = 'ACTIVE'\)/.test(sql), 'overlap guard scoped to ACTIVE rows');
  assert.ok(/REFERENCES reservation/.test(sql), 'occupancy references reservations');
  assert.ok(/idempotency_key/.test(sql), 'idempotency key column present');
  assert.ok(/cancellation_reason/.test(sql), 'cancellation reason column present');
});
