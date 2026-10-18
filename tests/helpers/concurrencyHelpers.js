/**
 * Concurrency test infrastructure: real OS processes against one real database file.
 *
 * WHY THIS EXISTS
 * ---------------
 * `node:sqlite` is synchronous, so two calls inside one process can never
 * interleave. An in-process "race" therefore proves nothing about the
 * double-booking guarantee. Every concurrency test in this suite instead:
 *
 *   1. builds a real on-disk SQLite database with the SAME pragmas the
 *      application uses (`src/server/db/connection.js`): WAL,
 *      busy_timeout = 10000, foreign_keys = ON, synchronous = NORMAL,
 *      trusted_schema = OFF;
 *   2. forks N real child processes, each of which opens that same file;
 *   3. waits until every child reports `{ ready: true }` (database open,
 *      START listener registered) - so all workers exist before any starts;
 *   4. broadcasts ONE shared wall-clock start instant over IPC
 *      (`START <epochMs>`, biased ~250 ms into the future);
 *   5. lets the children fire their booking call at that instant.
 *
 * Nothing in the parent mutates the database while a race is running.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import { fork } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createSpace } from '../../src/server/services/spaceService.js';
import { createCustomer } from '../../src/server/services/customerService.js';

/** Absolute path of the child-process entry point used by every race. */
export const BOOKING_WORKER = fileURLToPath(new URL('../concurrency/worker/bookingWorker.js', import.meta.url));

/** Marker prefix a worker writes to stdout as an IPC-independent result fallback. */
export const RESULT_MARKER = '__NAGARO_WORKER_RESULT__ ';

const HANDLES = new Map();
let pathCounter = 0;

/* ------------------------------------------------------------------ timing */

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

/** Block the current thread for `ms` without burning CPU (Node allows this on the main thread). */
export function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(SLEEPER, 0, 0, ms);
}

/**
 * Busy-wait until the wall clock reaches `epochMs`.
 * The last millisecond is a tight spin so all workers fire within ~1 ms of
 * each other rather than on a timer tick.
 */
export function waitUntil(epochMs) {
  for (;;) {
    const remaining = epochMs - Date.now();
    if (remaining <= 0) return Date.now();
    if (remaining > 2) sleepSync(remaining - 1);
  }
}

/* --------------------------------------------------------------- locations */

/** Directory holding throwaway scenario databases. */
export function scenarioRoot() {
  const root = process.env.NAGARO_CONCURRENCY_TMP || join(tmpdir(), 'nagaro-concurrency');
  mkdirSync(root, { recursive: true });
  return root;
}

/** A unique on-disk database path for one scenario. */
export function scenarioDbPath(label = 'scenario') {
  pathCounter += 1;
  const name = [
    String(label).replace(/[^a-zA-Z0-9_-]/g, '_'),
    process.pid,
    Date.now().toString(36),
    pathCounter,
    Math.random().toString(36).slice(2, 8),
  ].join('-');
  return join(scenarioRoot(), `${name}.db`);
}

/* ------------------------------------------------------------------- pragmas */

/**
 * The exact pragma set from `src/server/db/connection.js`.
 * busy_timeout is set FIRST so every later pragma waits on a lock instead of
 * failing with SQLITE_BUSY while a sibling process is opening the file.
 */
export function applyPragmas(db) {
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA trusted_schema = OFF');
  return db;
}

/** Fresh database file: pragmas + all migrations applied. */
export function createScenarioDb(filePath) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(filePath + suffix, { force: true });
  const db = new DatabaseSync(filePath);
  applyPragmas(db);
  applyMigrations(db);
  HANDLES.set(filePath, db);
  return db;
}

/** Open an already-migrated file with the correct pragmas (used by workers). */
export function openDb(filePath) {
  const db = new DatabaseSync(filePath);
  applyPragmas(db);
  HANDLES.set(filePath, db);
  return db;
}

export function closeScenarioDb(db) {
  for (const [path, handle] of HANDLES) {
    if (handle === db) HANDLES.delete(path);
  }
  try { db.close(); } catch { /* already closed */ }
}

/** Close any handle this module opened for `filePath`, then delete .db/-wal/-shm. */
export function cleanupDb(filePath) {
  const handle = HANDLES.get(filePath);
  if (handle) {
    try { handle.close(); } catch { /* already closed */ }
    HANDLES.delete(filePath);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rmSync(filePath + suffix, { force: true });
        break;
      } catch (error) {
        if (error.code !== 'EBUSY' && error.code !== 'EPERM') break;
        sleepSync(25); // Windows can hold the file briefly after close
      }
    }
  }
}

/* -------------------------------------------------------------------- seeds */

/**
 * A complete scenario: one administrator, one customer, one exclusive room,
 * one buffered room, one auditorium and a pooled co-working space.
 *
 * All inventory is created through the real `spaceService` so the resource
 * units and rates are exactly what production code would produce.
 */
export function seedScenario(db, {
  deskCount = 20,
  bufferMinutes = 30,
  deskOpenTime = '08:00',
  deskCloseTime = '18:00',
} = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO admin_user (email, password_hash, display_name, role, is_active, created_at, updated_at)
    VALUES (?,?,?,?,1,?,?)
  `).run('concurrency@nagaro.test', 'scrypt$0$0$0$0$0', 'Concurrency Test Admin', 'ADMIN', now, now);
  const actor = { id: 1, label: 'Concurrency Test Admin', role: 'ADMIN' };

  const customer = createCustomer(db, {
    actor,
    payload: { full_name: 'Marta Kebede', email: 'marta.kebede@example.test', organization: 'Trace Labs' },
  });

  const roomSpace = createSpace(db, {
    actor,
    payload: {
      code: 'RACE-ROOM',
      name: 'Race Room',
      category: 'MEETING_ROOM',
      capacity: 12,
      min_duration_minutes: 30,
      short_description: 'Exclusive meeting room used by the concurrency suite.',
      description: 'An exclusive meeting room with a single bookable resource unit.',
      location: 'Floor 2, Trace Expert City',
      rates: [{ unit: 'HOUR', amount: '500' }],
    },
  });

  const bufferedRoom = createSpace(db, {
    actor,
    payload: {
      code: 'RACE-BUFFER',
      name: 'Buffered Room',
      category: 'MEETING_ROOM',
      capacity: 8,
      min_duration_minutes: 30,
      buffer_minutes: bufferMinutes,
      short_description: 'Meeting room with a turnover buffer between reservations.',
      description: 'A meeting room whose bookings keep a symmetric turnover buffer.',
      location: 'Floor 2, Trace Expert City',
      rates: [{ unit: 'HOUR', amount: '400' }],
    },
  });

  const auditorium = createSpace(db, {
    actor,
    payload: {
      code: 'RACE-AUD',
      name: 'Race Auditorium',
      category: 'AUDITORIUM',
      capacity: 200,
      min_duration_minutes: 30,
      short_description: 'Auditorium used by the concurrency suite.',
      description: 'A single-unit auditorium used for exclusive-inventory tests.',
      location: 'Ground floor, Trace Expert City',
      rates: [{ unit: 'HALF_DAY', amount: '9000' }],
    },
  });

  const deskSpace = createSpace(db, {
    actor,
    payload: {
      code: 'RACE-DESKS',
      name: 'Race Co-working Floor',
      category: 'COWORKING',
      capacity: deskCount,
      desk_count: deskCount,
      min_duration_minutes: 30,
      open_time: deskOpenTime,
      close_time: deskCloseTime,
      short_description: 'Pooled co-working desks used by the concurrency suite.',
      description: 'A co-working floor whose desks are individually allocated inventory.',
      location: 'Floor 1, Trace Expert City',
      rates: [{ unit: 'DAY', amount: '500' }],
    },
  });

  return { actor, customer, roomSpace, bufferedRoom, auditorium, deskSpace };
}

/* ------------------------------------------------------------------- workers */

/**
 * Fork `count` real child processes against ONE database file and release them
 * at the same wall-clock instant.
 *
 * @param {object} options
 * @param {string}   options.workerScript  child entry point (default: bookingWorker.js)
 * @param {string}   options.dbPath        the shared on-disk database
 * @param {number}   options.count         number of workers
 * @param {string|Function} options.action worker action, or (index) => action
 * @param {object|Function} options.payload action payload, or (index) => payload
 * @param {number}   options.timeoutMs     hard budget for the whole race
 * @param {number}   options.startDelayMs  how far in the future the shared start instant is biased
 * @returns {Promise<Array<{index:number, ok:boolean, code:string|null, result:object|null,
 *   error:string|null, conflicts:Array|null, stdout:string, stderr:string,
 *   exitCode:number|null, signal:string|null, ready:boolean, timedOut:boolean,
 *   startedAt:number|null, finishedAt:number|null, job:object}>>}
 */
export async function runWorkers({
  workerScript = BOOKING_WORKER,
  dbPath,
  count,
  action,
  payload = {},
  timeoutMs = 30000,
  startDelayMs = 250,
} = {}) {
  if (!dbPath) throw new Error('runWorkers requires dbPath (the shared database file)');
  if (!Number.isInteger(count) || count < 1) throw new Error('runWorkers requires count >= 1');

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    entries.push({
      index,
      job: {
        dbPath,
        action: typeof action === 'function' ? action(index) : action,
        payload: typeof payload === 'function' ? payload(index) : payload,
      },
      ok: false,
      code: null,
      result: null,
      error: null,
      conflicts: null,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      ready: false,
      timedOut: false,
      startedAt: null,
      finishedAt: null,
      report: null,
    });
  }

  for (const entry of entries) {
    const child = fork(workerScript, [JSON.stringify(entry.job)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    entry.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { entry.stdout += chunk; });
    child.stderr.on('data', (chunk) => { entry.stderr += chunk; });

    entry.readyPromise = new Promise((resolve) => { entry.resolveReady = resolve; });
    entry.donePromise = new Promise((resolve) => { entry.resolveDone = resolve; });

    child.on('message', (message) => {
      if (message && message.ready === true) {
        entry.ready = true;
        entry.resolveReady(entry);
        return;
      }
      if (message && message.report) entry.report = message.report;
    });
    child.on('error', (error) => {
      entry.error = `spawn error: ${error.message}`;
      entry.ready = true;
      entry.resolveReady(entry);
      entry.resolveDone(entry);
    });
    child.on('exit', (code, signal) => {
      entry.exitCode = code;
      entry.signal = signal;
      entry.resolveReady(entry);
      entry.resolveDone(entry);
    });
  }

  // All children must exist (and have opened the database) before anyone fires.
  const readyBudget = Math.min(timeoutMs, 20000);
  await Promise.race([
    Promise.all(entries.map((entry) => entry.readyPromise)),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, readyBudget);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);

  const startEpochMs = Date.now() + Math.max(0, startDelayMs);
  for (const entry of entries) {
    if (entry.ready && entry.child.connected) {
      try { entry.child.send(`START ${startEpochMs}`); } catch { /* child already gone */ }
    }
  }

  const killTimer = setTimeout(() => {
    for (const entry of entries) {
      if (entry.exitCode === null && entry.signal === null) {
        entry.timedOut = true;
        try { entry.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
  }, timeoutMs);

  await Promise.all(entries.map((entry) => entry.donePromise));
  clearTimeout(killTimer);

  return entries.map((entry) => finaliseEntry(entry, startEpochMs));
}

function finaliseEntry(entry, startEpochMs) {
  let report = entry.report;
  if (!report) report = parseStdoutReport(entry.stdout);

  if (report) {
    entry.ok = report.ok === true;
    entry.code = report.code ?? null;
    entry.result = report.result ?? null;
    entry.conflicts = report.conflicts ?? null;
    entry.error = report.ok ? null : (report.message ?? 'worker reported failure');
    entry.startedAt = report.startedAt ?? null;
    entry.finishedAt = report.finishedAt ?? null;
    entry.pid = report.pid ?? null;
  } else {
    entry.error = entry.error
      ?? `worker produced no result (exit ${entry.exitCode ?? 'null'}${entry.signal ? `, signal ${entry.signal}` : ''})${entry.stderr ? `: ${entry.stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`;
    entry.ok = false;
  }
  entry.startEpochMs = startEpochMs;
  entry.stdout = entry.stdout.split(RESULT_MARKER)[0].trim();
  entry.stderr = entry.stderr.trim();
  delete entry.child;
  delete entry.report;
  delete entry.readyPromise;
  delete entry.donePromise;
  delete entry.resolveReady;
  delete entry.resolveDone;
  return entry;
}

/** Parse the stdout fallback line a worker writes before it exits. */
export function parseStdoutReport(stdout) {
  const index = String(stdout ?? '').lastIndexOf(RESULT_MARKER);
  if (index < 0) return null;
  const line = stdout.slice(index + RESULT_MARKER.length).split('\n')[0];
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Worker-side barrier: resolves with the shared start instant once the parent
 * broadcasts `START <epochMs>`. Call `waitUntil(instant)` immediately after.
 */
export function barrierIpc(_workerScript) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (typeof message !== 'string') return;
      const match = /^START (\d+)$/.exec(message.trim());
      if (!match) return;
      process.off('message', onMessage);
      resolve(Number(match[1]));
    };
    process.on('message', onMessage);
  });
}
