/**
 * Apply the versioned PostgreSQL migrations in db/migrations-postgres/.
 *
 *   node scripts/migrate-postgres.js            (uses DIRECT_URL, else DATABASE_URL)
 *   NAGARO_PG_MIGRATIONS_DIR=path node scripts/migrate-postgres.js   (override, used by tests)
 *
 * Each *.sql file runs inside its own transaction and is recorded in the
 * `schema_migrations` ledger, so reruns only apply pending files. A failed
 * file rolls back and aborts with a non-zero exit code; the error message
 * never includes the connection string.
 *
 * Requires a live PostgreSQL database (Supabase). There is no local fallback:
 * without DIRECT_URL/DATABASE_URL the script exits 2 with usage text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = resolve(here, '..', 'db', 'migrations-postgres');

export function pgMigrationsDir() {
  return process.env.NAGARO_PG_MIGRATIONS_DIR
    ? resolve(process.env.NAGARO_PG_MIGRATIONS_DIR)
    : DEFAULT_MIGRATIONS_DIR;
}

export function pgConnectionString(env = process.env) {
  const direct = String(env.DIRECT_URL ?? '').trim();
  if (direct) return direct;
  const pooled = String(env.DATABASE_URL ?? '').trim();
  return pooled || null;
}

export function listPgMigrationFiles(dir = pgMigrationsDir()) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

function ledgerSql() {
  return `CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
}

/**
 * Create the ledger unless it demonstrably exists. The re-check keeps a
 * concurrent creator (or an engine that reports IF NOT EXISTS oddly) from
 * failing a run whose ledger is already in place.
 */
async function ensureLedger(client) {
  try {
    await client.query(ledgerSql());
    return;
  } catch (error) {
    const existing = await client.query(
      "SELECT table_name FROM information_schema.tables"
      + " WHERE table_schema = 'public' AND table_name = 'schema_migrations'",
    );
    if (existing.rows.length > 0) return;
    throw error;
  }
}

/** Apply pending migrations with `client` ({ query }). Returns the applied names. */
export async function applyPgMigrations(client, { dir = pgMigrationsDir() } = {}) {
  await ensureLedger(client);
  const applied = new Set(
    (await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const performed = [];
  for (const file of listPgMigrationFiles(dir)) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      performed.push(file);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw new Error(`PostgreSQL migration ${file} failed: ${error.message}`);
    }
  }
  return performed;
}

async function main() {
  const connectionString = pgConnectionString();
  if (!connectionString) {
    console.error('Set DIRECT_URL (preferred, bypasses the pooler) or DATABASE_URL to a Supabase PostgreSQL connection string.');
    console.error('Refusing to run against any other database. Nothing was applied.');
    process.exitCode = 2;
    return;
  }
  const { Client } = await import('pg');
  const { pgConnectionConfig } = await import('../src/server/db/pgSsl.js');
  const client = new Client(pgConnectionConfig(connectionString));
  try {
    await client.connect();
  } catch (error) {
    console.error(`Could not connect to PostgreSQL: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    const performed = await applyPgMigrations(client);
    if (performed.length === 0) console.log('No pending PostgreSQL migrations.');
    else for (const name of performed) console.log(`applied ${name}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
