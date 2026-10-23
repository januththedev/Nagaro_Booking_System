/**
 * Minimal forward-only migration runner.
 * Applied migrations are recorded in `schema_migrations`; each file runs
 * inside its own transaction and is rolled back entirely on failure.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb, databasePath } from './connection.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function applyMigrations(db = getDb()) {
  if (db.dialect === 'postgres') {
    throw new Error(
      'SQLite migrations cannot be applied to a PostgreSQL connection. Use `npm run migrate:postgres` instead.',
    );
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name),
  );

  const performed = [];
  for (const file of migrationFiles()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)')
        .run(file, Date.now());
      db.exec('COMMIT');
      performed.push(file);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
    }
  }
  return performed;
}

/** Check that the PostgreSQL application schema has been migrated. */
export function postgresSchemaReady(db) {
  const row = db.prepare(`
    SELECT 1 AS ready
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'admin_user'
       AND column_name = 'is_super_admin'
  `).get();
  return Boolean(row);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const db = getDb();
  if (db.dialect === 'postgres') {
    console.error('This command only applies SQLite migrations. Use `npm run migrate:postgres` for PostgreSQL.');
    process.exitCode = 2;
  } else {
    const performed = applyMigrations(db);
    if (performed.length === 0) {
      console.log(`No pending migrations. Database: ${databasePath()}`);
    } else {
      for (const name of performed) console.log(`applied ${name}`);
      console.log(`Migrations applied. Database: ${databasePath()}`);
    }
  }
}
