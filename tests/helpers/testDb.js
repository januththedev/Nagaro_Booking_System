/**
 * Shared test database helper.
 *
 * Builds throwaway SQLite handles with the real migrations applied and the
 * same PRAGMAs used by `src/server/db/connection.js`. The module-level
 * singleton in connection.js is deliberately NOT touched: tests get their own
 * explicit-path handles so they never clobber the application database.
 *
 * Usage:
 *   const db = createTestDb();                 // in-memory
 *   const db = createTestDb({ path });         // file-backed
 *   await withTempFileDb(async (db, path) => { ... });  // auto cleanup
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { hashPassword } from '../../src/server/security/passwords.js';

/** Password every createTestActor() account can sign in with. */
export const TEST_PASSWORD = 'TestPassword123';

/** Open a migrated database with the production PRAGMAs. */
export function createTestDb({ path = ':memory:' } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Same pragma set as getDb() in src/server/db/connection.js.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA trusted_schema = OFF');
  applyMigrations(db);
  return db;
}

/** Close a handle created by createTestDb(). Safe to call twice. */
export function closeTestDb(db) {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
}

/**
 * Insert an administrator with a real scrypt hash for `TEST_PASSWORD`.
 * Returns the `{ id, label, role }` actor shape services expect.
 */
export function createTestActor(db, {
  email = 'admin@test.local',
  role = 'ADMIN',
  name = 'Test Admin',
} = {}) {
  const now = Date.now();
  const storageRole = role === 'STAFF' ? 'STAFF' : 'ADMIN';
  const isSuperAdmin = role === 'SUPER_ADMIN' ? 1 : 0;
  const info = db.prepare(`
    INSERT INTO admin_user
      (email, password_hash, display_name, role, is_super_admin, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,1,?,?)
  `).run(email, hashPassword(TEST_PASSWORD), name, storageRole, isSuperAdmin, now, now);
  const id = Number(info.lastInsertRowid);
  return { id, label: name, role };
}

/**
 * Create a temporary file-backed database, hand it to `fn`, and always remove
 * the file and its WAL companions afterwards.
 */
export async function withTempFileDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nagaro-test-'));
  const path = join(dir, 'test.db');
  const db = createTestDb({ path });
  try {
    return await fn(db, path);
  } finally {
    closeTestDb(db);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
        break;
      } catch {
        // Windows may briefly hold the -wal/-shm files; retry shortly.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}
