/**
 * SQLite connection management.
 *
 * One process owns one long-lived DatabaseSync handle. node:sqlite is
 * synchronous, so a single handle serialises statements inside the process;
 * across processes SQLite's own file locks plus `busy_timeout` provide the
 * serialisation that makes check-then-write booking logic atomic.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data', 'nagaro.db');

let handle = null;
let handlePath = null;

export function databasePath() {
  return process.env.NAGARO_DB_PATH
    ? resolve(process.env.NAGARO_DB_PATH)
    : DEFAULT_DB_PATH;
}

/**
 * Open (or reuse) the process-wide database handle with the pragmas this
 * application depends on for correctness.
 */
export function getDb() {
  const path = databasePath();
  if (handle && handlePath === path) return handle;

  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // WAL keeps readers from blocking the single writer.
  db.exec('PRAGMA journal_mode = WAL');
  // Wait up to 10s for a competing writer instead of failing with SQLITE_BUSY.
  // This is what lets concurrent processes queue on the write lock.
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA trusted_schema = OFF');

  handle = db;
  handlePath = path;
  return db;
}

export function closeDb() {
  if (handle) {
    try { handle.close(); } catch { /* already closed */ }
  }
  handle = null;
  handlePath = null;
}

/**
 * Run `fn` inside a write transaction that takes the RESERVED lock up front.
 *
 * BEGIN IMMEDIATE is the crux of double-booking prevention:
 *   - it acquires SQLite's single write lock immediately, so only one
 *     process can be inside this block at a time;
 *   - competing processes block on busy_timeout and, once admitted, observe
 *     the previously committed rows, so their availability re-check sees them;
 *   - the BEFORE INSERT/UPDATE triggers on `occupancy` independently reject
 *     overlaps, so even a logic bug in the service layer cannot commit one.
 *
 * Any thrown error rolls the whole transaction back, guaranteeing that a
 * failed booking/edit leaves no partial reservation or allocation behind.
 */
export function withWriteTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already aborted */ }
    throw error;
  }
}

/** Read-only helper. Uses a deferred transaction so it never takes the write lock. */
export function withReadTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
}
