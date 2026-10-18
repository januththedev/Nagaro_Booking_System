/**
 * Child-process entry point for the concurrency suite.
 *
 * One process = one action, fired at a shared wall-clock instant so that all
 * workers collide on SQLite's single write lock as hard as possible.
 *
 * Invocation:
 *   node bookingWorker.js '{"dbPath":"...","action":"createReservation","payload":{...}}'
 *
 * Lifecycle:
 *   1. open the shared database file with the application's pragmas
 *      (busy_timeout = 10000 included, so a blocked writer waits instead of
 *      failing with SQLITE_BUSY);
 *   2. signal `{ ready: true }` to the parent;
 *   3. wait for the parent's `START <epochMs>` broadcast;
 *   4. busy-wait until that instant, then perform EXACTLY ONE action;
 *   5. report `{ ok, result }` or `{ ok: false, code, message, conflicts }`
 *      over IPC (and as a stdout fallback) and exit.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import { openDb, barrierIpc, waitUntil, RESULT_MARKER } from '../../helpers/concurrencyHelpers.js';
import { nextReference } from '../../../src/server/domain/references.js';
import {
  createReservation,
  updateReservation,
  cancelReservation,
  createMaintenanceBlock,
} from '../../../src/server/services/bookingService.js';

const DEFAULT_ACTOR = { id: 1, label: 'Concurrency Worker', role: 'ADMIN' };

/* ------------------------------------------------------------- report path */

function report(payload) {
  const line = `${RESULT_MARKER}${JSON.stringify(payload)}`;
  try { process.stdout.write(`${line}\n`); } catch { /* stdout gone */ }

  const exitCode = payload.ok ? 0 : (payload.code ? 2 : 1);
  if (typeof process.send === 'function') {
    const fallback = setTimeout(() => process.exit(exitCode), 750);
    try {
      process.send({ report: payload }, () => {
        clearTimeout(fallback);
        process.exit(exitCode);
      });
      return;
    } catch {
      clearTimeout(fallback);
    }
  }
  process.exit(exitCode);
}

function describeError(error) {
  return {
    code: error?.code ?? error?.errcode ?? error?.name ?? 'UNKNOWN_ERROR',
    message: error?.message ?? String(error),
    conflicts: error?.conflicts
      ?? (Array.isArray(error?.details?.conflicts) ? error.details.conflicts : []),
    stack: error?.stack ?? null,
  };
}

/* ------------------------------------------------------------------ actions */

const ACTIONS = {
  /** Identical to the production admin "create reservation" path. */
  createReservation(db, payload) {
    const result = createReservation(db, { ...payload, actor: payload.actor ?? DEFAULT_ACTOR });
    return {
      idempotent: result.idempotent,
      reservation: serialiseReservation(result.reservation),
    };
  },

  /** Retry-safety path: same function, an explicit idempotency key in the payload. */
  createReservationWithIdempotencyKey(db, payload) {
    const result = createReservation(db, { ...payload, actor: payload.actor ?? DEFAULT_ACTOR });
    return {
      idempotent: result.idempotent,
      reservation: serialiseReservation(result.reservation),
    };
  },

  updateReservation(db, payload) {
    const result = updateReservation(db, {
      actor: payload.actor ?? DEFAULT_ACTOR,
      reservationId: payload.reservationId,
      patch: payload.patch ?? {},
    });
    return { reservation: serialiseReservation(result.reservation) };
  },

  cancelReservation(db, payload) {
    const result = cancelReservation(db, {
      actor: payload.actor ?? DEFAULT_ACTOR,
      reservationId: payload.reservationId,
      reason: payload.reason,
    });
    return {
      releasedOccupancyRows: result.releasedOccupancyRows,
      reservation: serialiseReservation(result.reservation),
    };
  },

  createMaintenanceBlock(db, payload) {
    const result = createMaintenanceBlock(db, {
      actor: payload.actor ?? DEFAULT_ACTOR,
      spaceId: payload.spaceId,
      startAt: payload.startAt,
      endAt: payload.endAt,
      reason: payload.reason,
      resourceUnitIds: payload.resourceUnitIds ?? null,
    });
    return { maintenanceBlockId: result.maintenanceBlockId, units: result.units };
  },

  /** Barrier sanity check: proves the workers really do fire together. */
  echo(_db, payload) {
    return { echo: payload.echo ?? null };
  },

  /**
   * Adversarial crash path: open a write transaction, insert a reservation AND
   * its occupancy row, then die without COMMIT. Used to prove that an unclean
   * shutdown cannot leave a partial booking behind (WAL recovery discards the
   * uncommitted frames) and cannot poison the next booking either.
   */
  crashMidTransaction(db, payload) {
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    const reference = nextReference(db, 'reservation');
    db.prepare(`
      INSERT INTO reservation
        (reference, space_id, customer_id, status, start_at, end_at, unit_count,
         billing_unit, billing_quantity, rate_cents, total_cents, currency,
         created_by, created_at, updated_by, updated_at)
      VALUES (?,?,?, 'CONFIRMED', ?,?,1, 'HOUR',1,0,0, 'LKR', ?,?,?,?)
    `).run(reference, payload.spaceId, payload.customerId, payload.startAt, payload.endAt,
      payload.actorId ?? 1, now, payload.actorId ?? 1, now);
    const reservationId = Number(db.prepare('SELECT id FROM reservation WHERE reference = ?').get(reference).id);
    db.prepare(`
      INSERT INTO occupancy
        (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, maintenance_block_id, created_at)
      VALUES (?,?,?,?, 'ACTIVE', 'RESERVATION', ?, NULL, ?)
    `).run(payload.unitId, payload.spaceId, payload.startAt, payload.endAt, reservationId, now);
    process.exit(7); // no COMMIT, no ROLLBACK: an unclean shutdown mid-transaction
  },
};

/** Keep worker results small and JSON-safe. */
function serialiseReservation(reservation) {
  if (!reservation) return null;
  return {
    id: reservation.id,
    reference: reservation.reference,
    status: reservation.status,
    spaceId: reservation.spaceId,
    startAt: reservation.startAt,
    endAt: reservation.endAt,
    unitCount: reservation.unitCount,
    unitCodes: reservation.unitCodes,
    idempotencyKey: reservation.idempotencyKey,
    totalCents: reservation.totalCents,
    updatedAt: reservation.updatedAt,
    cancelledAt: reservation.cancelledAt,
  };
}

/* -------------------------------------------------------------------- main */

const rawJob = process.argv[2];
let job = null;
try {
  job = JSON.parse(rawJob ?? '');
} catch (error) {
  report({ ok: false, code: 'WORKER_BAD_ARGS', message: `Could not parse job: ${error.message}` });
}

let db = null;
let openError = null;
try {
  db = openDb(job.dbPath);
} catch (error) {
  openError = error;
}

if (typeof process.send === 'function') process.send({ ready: true });

if (openError) {
  report({ ok: false, code: openError.code ?? 'DB_OPEN_FAILED', message: openError.message });
} else {
  const handler = ACTIONS[job.action];
  if (!handler) {
    report({ ok: false, code: 'WORKER_UNKNOWN_ACTION', message: `Unknown action: ${job.action}` });
  } else {
    const startInstant = await barrierIpc();
    const startedAt = waitUntil(startInstant);
    try {
      const result = handler(db, job.payload ?? {});
      report({
        ok: true,
        pid: process.pid,
        startedAt,
        finishedAt: Date.now(),
        result,
      });
    } catch (error) {
      const described = describeError(error);
      report({
        ok: false,
        pid: process.pid,
        startedAt,
        finishedAt: Date.now(),
        code: described.code,
        message: described.message,
        conflicts: described.conflicts,
        stack: described.stack,
      });
    }
  }
}
