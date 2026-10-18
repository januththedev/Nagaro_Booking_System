/**
 * Booking-scenario building blocks and invariants shared by the concurrency
 * suite, the demo script and any later reader of this evidence.
 *
 * These helpers are deliberately READ-ONLY unless their name says otherwise:
 * a verifier must be able to inspect the database without changing it.
 *
 * FILE OWNERSHIP: this file is owned by Agent B1. Do not edit from elsewhere.
 */
import { businessDateKey, businessLocalToEpoch } from '../../src/server/domain/time.js';
import { createScenarioDb, cleanupDb, scenarioDbPath, seedScenario } from './concurrencyHelpers.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/* --------------------------------------------------------------- scenarios */

/** Fresh migrated database + seeded scenario, with a one-call teardown. */
export function openScenario(label, options = {}) {
  const dbPath = scenarioDbPath(label);
  const db = createScenarioDb(dbPath);
  const scenario = seedScenario(db, options);
  return { dbPath, db, scenario, cleanup: () => cleanupDb(dbPath) };
}

/**
 * Run a service call and describe the outcome instead of throwing.
 * Used for the sequential (non-racing) half of the suite, where the question
 * is "which error code does this path produce?".
 */
export function attempt(fn) {
  try {
    return { ok: true, result: fn() };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? error?.name ?? 'UNKNOWN_ERROR',
      message: error?.message ?? String(error),
      conflicts: error?.conflicts ?? error?.details?.conflicts ?? [],
      error,
    };
  }
}

/* ------------------------------------------------------------------ windows */

/** `YYYY-MM-DD` for "today plus N days" in the business time zone. */
export function futureDateKey(offsetDays = 30) {
  return businessDateKey(Date.now() + offsetDays * DAY_MS);
}

/** Half-open business-local window `[startClock, endClock)` on `dateKey`, as epoch ms. */
export function businessWindow(dateKey, startClock, endClock) {
  return {
    startAt: businessLocalToEpoch(dateKey, startClock),
    endAt: businessLocalToEpoch(dateKey, endClock),
  };
}

/** `HH:MM` labels for an epoch-ms instant pair in business-local time. */
export function clockLabel(epochMs, dateKey) {
  const dayStart = businessLocalToEpoch(dateKey, '00:00');
  const minutes = Math.round((epochMs - dayStart) / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* -------------------------------------------------------------- inspection */

/** The raw `reservation` row, every column, exactly as stored. */
export function reservationRow(db, id) {
  return db.prepare('SELECT * FROM reservation WHERE id = ?').get(Number(id)) ?? null;
}

/** Every `occupancy` row owned by a reservation, including RELEASED history. */
export function occupancyRows(db, reservationId) {
  return db.prepare('SELECT * FROM occupancy WHERE reservation_id = ? ORDER BY id').all(Number(reservationId));
}

export function activeOccupancyRows(db, reservationId) {
  return db
    .prepare("SELECT * FROM occupancy WHERE reservation_id = ? AND status = 'ACTIVE' ORDER BY id")
    .all(Number(reservationId));
}

export function occupancyRowsForSpace(db, spaceId) {
  return db.prepare('SELECT * FROM occupancy WHERE space_id = ? ORDER BY id').all(Number(spaceId));
}

/** Byte-for-byte state of a reservation: its row plus all of its occupancy rows. */
export function reservationSnapshot(db, id) {
  return {
    reservation: reservationRow(db, id),
    occupancy: occupancyRows(db, id),
  };
}

/** CONFIRMED reservations on `spaceId` overlapping `[startAt, endAt)`. */
export function confirmedReservationsInWindow(db, { spaceId, startAt, endAt }) {
  return db.prepare(`
    SELECT * FROM reservation
     WHERE space_id = ? AND status = 'CONFIRMED'
       AND start_at < ? AND end_at > ?
     ORDER BY id
  `).all(Number(spaceId), Number(endAt), Number(startAt));
}

export function countRows(db, sql, ...params) {
  return db.prepare(sql).get(...params).c;
}

export function sequenceValue(db, name) {
  const row = db.prepare('SELECT value FROM app_sequence WHERE name = ?').get(String(name));
  return row ? row.value : null;
}

/**
 * Distinct ACTIVE resource units in use at every `stepMs` instant of a window.
 * The recursive CTE generates the instants inside SQLite, so the whole proof
 * is one statement against committed state.
 */
export function perInstantUnitCounts(db, { spaceId, startAt, endAt, stepMs = 60000 }) {
  const rows = db.prepare(`
    WITH RECURSIVE instants(i) AS (
      SELECT ?
      UNION ALL
      SELECT i + ? FROM instants WHERE i + ? < ?
    )
    SELECT i AS instant,
           (SELECT COUNT(DISTINCT o.resource_unit_id)
              FROM occupancy o
             WHERE o.space_id = ?
               AND o.status = 'ACTIVE'
               AND o.start_at <= i AND o.end_at > i) AS used
      FROM instants
     ORDER BY i
  `).all(Number(startAt), Number(stepMs), Number(stepMs), Number(endAt), Number(spaceId));
  return rows.map((row) => ({ instant: row.instant, used: row.used }));
}

/** Peak concurrent ACTIVE units over a window, with the instant where it occurs. */
export function peakConcurrentUnits(db, { spaceId, startAt, endAt, stepMs = 60000 }) {
  const samples = perInstantUnitCounts(db, { spaceId, startAt, endAt, stepMs });
  let peak = 0;
  let peakAt = null;
  for (const sample of samples) {
    if (sample.used > peak) { peak = sample.used; peakAt = sample.instant; }
  }
  return { peak, peakAt, samples };
}

/* --------------------------------------------------------- state invariants
 * The properties that must hold after ANY interleaving of edit / cancel /
 * create. A failure here is a torn transaction, not a lost race.            */

export function consistencyProblems(db, reservationId) {
  const id = Number(reservationId);
  const row = reservationRow(db, id);
  if (!row) return [`reservation ${id} does not exist`];
  const active = activeOccupancyRows(db, id);
  const problems = [];

  if (row.status === 'CANCELLED') {
    if (active.length > 0) {
      problems.push(`status=CANCELLED but ${active.length} ACTIVE occupancy row(s) remain (ids ${active.map((o) => o.id).join(', ')})`);
    }
    if (!row.cancelled_at) problems.push('status=CANCELLED with cancelled_at NULL');
    if (!row.cancellation_reason || row.cancellation_reason.trim() === '') {
      problems.push('status=CANCELLED with a blank cancellation_reason');
    }
  } else {
    if (active.length === 0) problems.push(`status=${row.status} but the reservation holds no ACTIVE occupancy row`);
    if (active.length !== row.unit_count) {
      problems.push(`unit_count=${row.unit_count} but ${active.length} ACTIVE occupancy row(s)`);
    }
    for (const occupancy of active) {
      if (occupancy.start_at !== row.start_at || occupancy.end_at !== row.end_at) {
        problems.push(`ACTIVE occupancy ${occupancy.id} covers [${occupancy.start_at}, ${occupancy.end_at}) but the reservation window is [${row.start_at}, ${row.end_at})`);
      }
    }
  }
  return problems;
}

export function activeUnitIds(db, reservationId) {
  return activeOccupancyRows(db, reservationId).map((row) => row.resource_unit_id);
}

/* ------------------------------------------------------------ diagnostics */

/** Human-readable worker outcome table for assertion messages and logs. */
export function describeResults(results) {
  const lines = ['worker outcomes:'];
  for (const result of results) {
    const job = result.job ?? {};
    const payload = job.payload ?? {};
    const windowLabel = payload.startAt !== undefined
      ? `[${payload.startAt}, ${payload.endAt})`
      : '';
    lines.push([
      `  #${String(result.index).padStart(2, '0')}`,
      `ok=${result.ok}`,
      `code=${result.code ?? '-'}`,
      windowLabel,
      result.error ? `error=${result.error}` : `reference=${result.result?.reservation?.reference ?? result.result?.reference ?? '-'}`,
    ].join(' '));
  }
  return lines.join('\n');
}

/** Assertion-friendly summary of the successes in a race. */
export function successIndices(results) {
  return results.filter((result) => result.ok).map((result) => result.index);
}
