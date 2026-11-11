/**
 * Door command service.
 *
 * Every lock/unlock is a row in `door_command`, authorised and written inside a
 * write transaction and only then sent to the room's controller. The browser
 * never decides anything: it asks, the backend checks the booking, the backend
 * talks to the controller, and the page shows what the controller confirmed.
 *
 * THE AUTOMATIC-CLOSE RULE
 *   Every OPEN stores a mandatory deadline in `door_state.auto_lock_at`:
 *       min(requested unlock deadline, authorised booking end)
 *   There is no customer path that leaves it NULL. The deadline lives in the
 *   database, not in a timer, so it survives browser closure, restarts,
 *   deployments and several application instances. `scheduleDueDoorWork()`
 *   turns a due deadline into exactly one SYSTEM CLOSE command (the
 *   idempotency key is derived from the door and the deadline), and
 *   `runDoorQueue()` sends due commands under a lease so two instances cannot
 *   send the same one twice. The deadline is cleared only by a CLOSE the
 *   controller accepted.
 */
import { withWriteTransaction } from '../db/connection.js';
import { conflict, forbidden, notFound, validationError } from '../domain/errors.js';
import { businessTimeLabel } from '../domain/time.js';
import { DOOR_DRIVER, UNLOCK_MINUTE_OPTIONS, effectiveAccessConfig, getSpaceAccessConfig } from './accessPolicyService.js';
import { sendDoorCommand } from './doorDrivers.js';
import { recordAudit } from './auditService.js';
import { NOTIFICATION_PRIORITY, NOTIFICATION_TYPE, createNotificationsForAdmins, schedulePendingDispatch } from './notificationService.js';

const MINUTE = 60_000;
const LEASE_MS = 25_000;
/** A command younger than this still blocks a second customer request. */
const BUSY_WINDOW_MS = 20_000;
const CLOSE_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const SYSTEM_CLOSE_ATTEMPTS = 6;
const CUSTOMER_CLOSE_ATTEMPTS = 3;
/** After the bounded retries fail, one fresh attempt per bucket, six buckets. */
const WATCHDOG_BUCKET_MS = 10 * MINUTE;
const WATCHDOG_BUCKETS = 6;
export const STAFF_UNLOCK_MINUTES = Object.freeze([5, 15, 30, 60]);

export const DOOR_REASON = Object.freeze({
  CUSTOMER_REQUEST: 'CUSTOMER_REQUEST',
  STAFF_OVERRIDE: 'STAFF_OVERRIDE',
  AUTO_LOCK: 'AUTO_LOCK',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  ACCESS_REVOKED: 'ACCESS_REVOKED',
  BOOKING_CHANGED: 'BOOKING_CHANGED',
  DEADLINE_EXTENDED: 'DEADLINE_EXTENDED',
});

/* ------------------------------------------------------------------ reads */

function ensureDoorState(db, spaceId, now) {
  db.prepare('INSERT INTO door_state (space_id, updated_at) VALUES (?, ?) ON CONFLICT (space_id) DO NOTHING').run(Number(spaceId), now);
  return db.prepare('SELECT * FROM door_state WHERE space_id = ?').get(Number(spaceId));
}

function hydrateCommand(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    spaceId: Number(row.space_id),
    reservationId: row.reservation_id === null || row.reservation_id === undefined ? null : Number(row.reservation_id),
    actorType: row.actor_type,
    actorName: row.actor_name ?? null,
    action: row.action,
    reason: row.reason,
    requestedMinutes: row.requested_minutes === null || row.requested_minutes === undefined ? null : Number(row.requested_minutes),
    autoLockAt: row.auto_lock_at === null || row.auto_lock_at === undefined ? null : Number(row.auto_lock_at),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
    reservationReference: row.reservation_reference ?? null,
    spaceCode: row.space_code ?? null,
    spaceName: row.space_name ?? null,
  };
}

/** Current door picture for one room. Reads only. */
export function getDoorSnapshot(db, spaceId, { now = Date.now() } = {}) {
  const state = db.prepare('SELECT * FROM door_state WHERE space_id = ?').get(Number(spaceId));
  const latest = hydrateCommand(db.prepare('SELECT * FROM door_command WHERE space_id = ? ORDER BY id DESC LIMIT 1').get(Number(spaceId)));
  const inFlight = latest && ['PENDING', 'SENDING'].includes(latest.status) ? latest : null;
  return {
    spaceId: Number(spaceId),
    reportedState: state?.reported_state ?? 'UNKNOWN',
    reportedAt: state?.reported_at === null || state?.reported_at === undefined ? null : Number(state.reported_at),
    desiredState: state?.desired_state ?? 'LOCKED',
    autoLockAt: state?.auto_lock_at === null || state?.auto_lock_at === undefined ? null : Number(state.auto_lock_at),
    autoLockMode: state?.auto_lock_mode ?? null,
    unlockedReservationId: state?.unlocked_reservation_id === null || state?.unlocked_reservation_id === undefined ? null : Number(state.unlocked_reservation_id),
    controllerOnline: Number(state?.controller_online ?? 1) === 1,
    lastContactAt: state?.last_contact_at === null || state?.last_contact_at === undefined ? null : Number(state.last_contact_at),
    lastError: state?.last_error ?? null,
    pending: inFlight,
    latest,
    overdue: Boolean(state?.auto_lock_at !== null && state?.auto_lock_at !== undefined && Number(state.auto_lock_at) <= now),
  };
}

export function listDoorActivity(db, { spaceId = null, reservationId = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (spaceId !== null) { where.push('c.space_id = ?'); params.push(Number(spaceId)); }
  if (reservationId !== null) { where.push('c.reservation_id = ?'); params.push(Number(reservationId)); }
  const rows = db.prepare(`
    SELECT c.*, r.reference AS reservation_reference, s.code AS space_code, s.name AS space_name,
           u.display_name AS actor_name
      FROM door_command c
      JOIN space s ON s.id = c.space_id
      LEFT JOIN reservation r ON r.id = c.reservation_id
      LEFT JOIN admin_user u ON u.id = c.actor_admin_user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.id DESC LIMIT ?`).all(...params, Math.min(Math.max(Number(limit) || 50, 1), 500));
  return rows.map(hydrateCommand);
}

/* ---------------------------------------------------------------- writes */

/** Insert a command; an existing idempotency key returns that command. Call inside a write transaction. */
function insertCommand(db, {
  spaceId, reservationId = null, accessLinkId = null, actorType, actorAdminUserId = null, action, reason,
  requestedMinutes = null, autoLockAt = null, idempotencyKey, maxAttempts = 1, now,
}) {
  const key = String(idempotencyKey ?? '').trim().slice(0, 200);
  if (!key) throw validationError('A door command needs an idempotency key.');
  const existing = db.prepare('SELECT * FROM door_command WHERE idempotency_key = ?').get(key);
  if (existing) return { command: hydrateCommand(existing), idempotent: true };
  const info = db.prepare(`INSERT INTO door_command
      (space_id, reservation_id, access_link_id, actor_type, actor_admin_user_id, action, reason,
       requested_minutes, auto_lock_at, idempotency_key, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING',0,?,?,?,?)`)
    .run(Number(spaceId), reservationId, accessLinkId, actorType, actorAdminUserId, action, reason,
      requestedMinutes, autoLockAt, key, maxAttempts, now, now, now);
  const row = db.prepare('SELECT * FROM door_command WHERE id = ?').get(Number(info.lastInsertRowid));
  return { command: hydrateCommand(row), idempotent: false };
}

function assertNotBusy(db, spaceId, now) {
  const busy = db.prepare(`SELECT id FROM door_command
     WHERE space_id = ? AND status IN ('PENDING','SENDING') AND created_at > ? ORDER BY id DESC LIMIT 1`)
    .get(Number(spaceId), now - BUSY_WINDOW_MS);
  if (busy) {
    const error = conflict('The door is still responding to the previous request. Please wait a moment.');
    error.code = 'DOOR_BUSY';
    throw error;
  }
}

/**
 * Customer OPEN / CLOSE. `access` is the already-authenticated link context
 * (see accessLinkService.resolveAccess); the booking is re-read under the
 * write lock so an expired, cancelled or revoked booking cannot slip through.
 *
 * @param {'OPEN'|'CLOSE'} action
 * @param {number|'END'|null} minutes  5, 15, 30 or 'END' (until the booking ends)
 */
export function requestCustomerDoorCommand(db, { access, action, minutes = null, idempotencyKey, now = Date.now() } = {}) {
  const verb = String(action ?? '').toUpperCase();
  if (!['OPEN', 'CLOSE'].includes(verb)) throw validationError('Choose to lock or unlock the door.');
  const key = String(idempotencyKey ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw validationError('The request could not be verified. Reload the page and try again.');

  return withWriteTransaction(db, () => {
    const link = db.prepare('SELECT * FROM booking_access_link WHERE id = ?').get(Number(access.linkId));
    if (!link || link.status !== 'ACTIVE') throw notFound('This access link is no longer available.');
    const reservation = db.prepare('SELECT * FROM reservation WHERE id = ?').get(Number(link.reservation_id));
    if (!reservation) throw notFound('Booking not found.');
    const config = effectiveAccessConfig(db, reservation.space_id);
    const startsAt = Number(reservation.start_at) - config.policy.earlyAccessMinutes * MINUTE;
    const endsAt = Number(reservation.end_at);

    const denied = (message, code) => { const e = forbidden(message); e.code = code; return e; };
    if (reservation.status === 'CANCELLED') throw denied('This booking was cancelled. Door controls are unavailable.', 'ACCESS_CANCELLED');
    if (link.door_access_revoked_at !== null && link.door_access_revoked_at !== undefined) throw denied('Door access for this booking has been turned off. Please contact staff.', 'ACCESS_REVOKED');
    if (now >= endsAt || reservation.status !== 'CONFIRMED') throw denied('Your booking has ended. Door controls are no longer available.', 'ACCESS_ENDED');
    if (now < startsAt) throw denied('Door controls become available when your booking starts.', 'ACCESS_NOT_STARTED');
    if (!config.doorReady) throw denied('Door control is not available for this room. Please ask staff for help.', 'DOOR_UNAVAILABLE');

    const scopedKey = `cust:${link.id}:${key}`;
    const repeat = db.prepare('SELECT * FROM door_command WHERE idempotency_key = ?').get(scopedKey);
    if (repeat) return { command: hydrateCommand(repeat), idempotent: true };
    assertNotBusy(db, reservation.space_id, now);
    ensureDoorState(db, reservation.space_id, now);

    if (verb === 'CLOSE') {
      const result = insertCommand(db, {
        spaceId: reservation.space_id, reservationId: reservation.id, accessLinkId: link.id,
        actorType: 'CUSTOMER', action: 'CLOSE', reason: DOOR_REASON.CUSTOMER_REQUEST,
        idempotencyKey: scopedKey, maxAttempts: CUSTOMER_CLOSE_ATTEMPTS, now,
      });
      db.prepare("UPDATE door_state SET desired_state = 'LOCKED', updated_at = ? WHERE space_id = ?").run(now, reservation.space_id);
      return result;
    }

    const untilEnd = String(minutes ?? '').toUpperCase() === 'END';
    const requested = untilEnd ? null : Number(minutes ?? config.policy.defaultUnlockMinutes);
    if (untilEnd && !config.allowUntilEnd) throw validationError('Keeping the door unlocked until the booking ends is not allowed for this room.', { minutes: 'Choose 5, 15 or 30 minutes.' });
    if (!untilEnd && !UNLOCK_MINUTE_OPTIONS.includes(requested)) throw validationError('Choose 5, 15 or 30 minutes.', { minutes: 'Choose 5, 15 or 30 minutes.' });

    // The mandatory deadline: never later than the authorised booking end.
    const autoLockAt = untilEnd ? endsAt : Math.min(now + requested * MINUTE, endsAt);
    const result = insertCommand(db, {
      spaceId: reservation.space_id, reservationId: reservation.id, accessLinkId: link.id,
      actorType: 'CUSTOMER', action: 'OPEN', reason: DOOR_REASON.CUSTOMER_REQUEST,
      requestedMinutes: requested, autoLockAt, idempotencyKey: scopedKey, maxAttempts: 1, now,
    });
    db.prepare(`UPDATE door_state SET desired_state = 'UNLOCKED', auto_lock_at = ?, auto_lock_mode = ?,
        unlocked_reservation_id = ?, updated_at = ? WHERE space_id = ?`)
      .run(autoLockAt, untilEnd ? 'UNTIL_END' : 'TIMED', reservation.id, now, reservation.space_id);
    return result;
  });
}

/** Staff override from the operations console. An unlock always carries a deadline. */
export function requestStaffDoorCommand(db, { actor, spaceId, action, minutes = 5, now = Date.now() } = {}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  const verb = String(action ?? '').toUpperCase();
  if (!['OPEN', 'CLOSE'].includes(verb)) throw validationError('Choose to lock or unlock the door.');
  const id = Number(spaceId);
  return withWriteTransaction(db, () => {
    const space = db.prepare('SELECT id, code, name FROM space WHERE id = ?').get(id);
    if (!space) throw notFound('Space not found.');
    const config = effectiveAccessConfig(db, id);
    if (!config.doorReady) throw conflict('No door controller is enabled for this room.');
    assertNotBusy(db, id, now);
    ensureDoorState(db, id, now);
    const key = `staff:${actor.id}:${id}:${verb}:${now}`;
    let result;
    if (verb === 'OPEN') {
      const requested = Number(minutes);
      if (!STAFF_UNLOCK_MINUTES.includes(requested)) throw validationError('Choose how long the door should stay unlocked.', { minutes: 'Choose 5, 15, 30 or 60 minutes.' });
      const autoLockAt = now + requested * MINUTE;
      result = insertCommand(db, {
        spaceId: id, actorType: 'STAFF', actorAdminUserId: actor.id, action: 'OPEN', reason: DOOR_REASON.STAFF_OVERRIDE,
        requestedMinutes: requested, autoLockAt, idempotencyKey: key, maxAttempts: 1, now,
      });
      db.prepare(`UPDATE door_state SET desired_state = 'UNLOCKED', auto_lock_at = ?, auto_lock_mode = 'STAFF',
          unlocked_reservation_id = NULL, updated_at = ? WHERE space_id = ?`).run(autoLockAt, now, id);
    } else {
      result = insertCommand(db, {
        spaceId: id, actorType: 'STAFF', actorAdminUserId: actor.id, action: 'CLOSE', reason: DOOR_REASON.STAFF_OVERRIDE,
        idempotencyKey: key, maxAttempts: CUSTOMER_CLOSE_ATTEMPTS, now,
      });
      db.prepare("UPDATE door_state SET desired_state = 'LOCKED', updated_at = ? WHERE space_id = ?").run(now, id);
    }
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: verb === 'OPEN' ? 'door.staff_unlock' : 'door.staff_lock',
      entityType: 'space', entityId: id,
      summary: `${verb === 'OPEN' ? `Unlocked ${space.code} for ${minutes} minutes` : `Locked ${space.code}`} from the console`,
    });
    return result;
  });
}

/**
 * Queue a SYSTEM CLOSE for a room when this booking may have left it unlocked
 * (cancellation, revocation, a move to another room). Call inside a write
 * transaction. Returns the command or null when nothing needs locking.
 */
export function queueSystemLock(db, { spaceId, reservationId = null, reason, now = Date.now(), force = false }) {
  const state = db.prepare('SELECT * FROM door_state WHERE space_id = ?').get(Number(spaceId));
  if (!state) return null;
  const ownedByBooking = reservationId !== null && Number(state.unlocked_reservation_id) === Number(reservationId);
  const maybeOpen = state.auto_lock_at !== null && state.auto_lock_at !== undefined;
  if (!force && !(ownedByBooking && maybeOpen)) return null;
  const config = getSpaceAccessConfig(db, spaceId);
  if (!config.doorEnabled || config.driver === DOOR_DRIVER.NONE) return null;
  const result = insertCommand(db, {
    spaceId, reservationId, actorType: 'SYSTEM', action: 'CLOSE', reason,
    idempotencyKey: `sys:${reason}:${spaceId}:${reservationId ?? 0}:${now}`, maxAttempts: SYSTEM_CLOSE_ATTEMPTS, now,
  });
  db.prepare("UPDATE door_state SET desired_state = 'LOCKED', auto_lock_at = ?, updated_at = ? WHERE space_id = ?")
    .run(Math.min(Number(state.auto_lock_at ?? now), now), now, Number(spaceId));
  return result.command;
}

/**
 * Keep the mandatory deadline consistent when a booking's end time changes.
 * A shortened booking pulls the deadline in; an extended booking moves the
 * deadline out only for an unlock the customer asked to keep "until the
 * booking ends" and only while that unlock is still in force. An unlock that
 * already expired is never brought back. Call inside a write transaction.
 */
export function syncDoorDeadline(db, { reservationId, spaceId, newEndAt, now = Date.now() }) {
  const state = db.prepare('SELECT * FROM door_state WHERE space_id = ?').get(Number(spaceId));
  if (!state || Number(state.unlocked_reservation_id) !== Number(reservationId)) return null;
  if (state.auto_lock_at === null || state.auto_lock_at === undefined) return null;
  const current = Number(state.auto_lock_at);
  const end = Number(newEndAt);
  if (current > end) {
    db.prepare('UPDATE door_state SET auto_lock_at = ?, updated_at = ? WHERE space_id = ?').run(end, now, Number(spaceId));
    return { autoLockAt: end, refresh: false };
  }
  const stillInForce = current > now && state.reported_state === 'UNLOCKED' && state.desired_state === 'UNLOCKED';
  if (state.auto_lock_mode === 'UNTIL_END' && end > current && stillInForce) {
    db.prepare('UPDATE door_state SET auto_lock_at = ?, updated_at = ? WHERE space_id = ?').run(end, now, Number(spaceId));
    // Tell a self-timing controller about the later deadline.
    insertCommand(db, {
      spaceId, reservationId, actorType: 'SYSTEM', action: 'OPEN', reason: DOOR_REASON.DEADLINE_EXTENDED,
      autoLockAt: end, idempotencyKey: `sys:deadline:${spaceId}:${reservationId}:${end}`, maxAttempts: 1, now,
    });
    return { autoLockAt: end, refresh: true };
  }
  return null;
}

/* ------------------------------------------------------------- execution */

function alertAdmins(db, { spaceId, title, body, dedupeKey, now }) {
  try {
    const result = createNotificationsForAdmins(db, {
      type: NOTIFICATION_TYPE.DOOR_ALERT, title, body, entityType: 'space', entityId: String(spaceId),
      actionUrl: '/admin/access', priority: NOTIFICATION_PRIORITY.HIGH, dedupeKey, now,
    });
    if (result.created > 0) schedulePendingDispatch(db);
  } catch (error) {
    console.warn('[door] could not raise a staff alert:', error?.code ?? error?.message ?? 'unknown');
  }
}

/**
 * Take the lease on one command. Authorisation is checked again here, at send
 * time, so an OPEN that waited in the queue past the end of the booking is
 * dropped instead of being sent.
 */
function claimCommand(db, commandId, now) {
  return withWriteTransaction(db, () => {
    const row = db.prepare('SELECT * FROM door_command WHERE id = ?').get(Number(commandId));
    if (!row || row.status !== 'PENDING' || Number(row.next_attempt_at) > now) return null;
    const fail = (message) => {
      db.prepare("UPDATE door_command SET status = 'FAILED', last_error = ?, updated_at = ?, completed_at = ? WHERE id = ?").run(message, now, now, row.id);
      return null;
    };
    if (row.action === 'OPEN') {
      if (row.auto_lock_at === null || row.auto_lock_at === undefined || Number(row.auto_lock_at) <= now) return fail('The unlock window had already ended.');
      if (now - Number(row.created_at) > BUSY_WINDOW_MS) return fail('The unlock request expired before it could be sent.');
      if (row.reservation_id !== null && row.reservation_id !== undefined) {
        const reservation = db.prepare('SELECT status, end_at, space_id FROM reservation WHERE id = ?').get(Number(row.reservation_id));
        if (!reservation || reservation.status !== 'CONFIRMED' || Number(reservation.end_at) <= now || Number(reservation.space_id) !== Number(row.space_id)) {
          return fail('The booking no longer authorises this door.');
        }
        if (row.access_link_id !== null && row.access_link_id !== undefined) {
          const link = db.prepare('SELECT status, door_access_revoked_at FROM booking_access_link WHERE id = ?').get(Number(row.access_link_id));
          if (!link || link.status !== 'ACTIVE' || (link.door_access_revoked_at !== null && link.door_access_revoked_at !== undefined)) {
            return fail('Door access for this booking was revoked.');
          }
        }
      }
    }
    const config = getSpaceAccessConfig(db, row.space_id);
    if (!config.doorEnabled || config.driver === DOOR_DRIVER.NONE) return fail('No door controller is enabled for this room.');
    const claimed = db.prepare(`UPDATE door_command SET status = 'SENDING', attempts = attempts + 1, lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'PENDING'`).run(now + LEASE_MS, now, row.id);
    if (Number(claimed.changes) !== 1) return null;
    return { command: hydrateCommand({ ...row, attempts: Number(row.attempts) + 1, status: 'SENDING' }), config };
  });
}

function recordOutcome(db, command, config, result, now) {
  return withWriteTransaction(db, () => {
    const row = db.prepare('SELECT * FROM door_command WHERE id = ?').get(command.id);
    if (!row || row.status !== 'SENDING') return hydrateCommand(row);
    const state = ensureDoorState(db, command.spaceId, now);
    const confirmed = result.ok && result.state !== null && result.state === (command.action === 'OPEN' ? 'UNLOCKED' : 'LOCKED');
    // A controller that never reports state can only acknowledge. One that
    // normally confirms but did not is treated as "not locked yet" for CLOSE.
    const acknowledged = result.ok && !confirmed && (command.action === 'OPEN' || !config.confirmsState);
    const contradicts = result.ok && result.state !== null && !confirmed;

    if (confirmed || acknowledged) {
      db.prepare('UPDATE door_command SET status = ?, last_error = NULL, lease_until = NULL, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(confirmed ? 'CONFIRMED' : 'ACKNOWLEDGED', now, now, command.id);
      if (command.action === 'CLOSE') {
        db.prepare(`UPDATE door_state SET reported_state = ?, reported_at = ?, desired_state = 'LOCKED', auto_lock_at = NULL,
            auto_lock_mode = NULL, unlocked_reservation_id = NULL, controller_online = 1, last_contact_at = ?, last_error = NULL, updated_at = ?
            WHERE space_id = ?`).run(confirmed ? 'LOCKED' : 'UNKNOWN', now, now, now, command.spaceId);
      } else {
        db.prepare(`UPDATE door_state SET reported_state = ?, reported_at = ?, controller_online = 1, last_contact_at = ?, last_error = NULL, updated_at = ?
            WHERE space_id = ?`).run(confirmed ? 'UNLOCKED' : 'UNKNOWN', now, now, now, command.spaceId);
      }
      return hydrateCommand(db.prepare('SELECT * FROM door_command WHERE id = ?').get(command.id));
    }

    const message = String(result.error ?? (contradicts ? 'The controller reported a different door state.' : 'The door did not confirm the command.')).slice(0, 300);
    const retry = command.action === 'CLOSE' && command.attempts < command.maxAttempts;
    if (retry) {
      const delay = CLOSE_BACKOFF_MS[Math.min(command.attempts - 1, CLOSE_BACKOFF_MS.length - 1)];
      db.prepare("UPDATE door_command SET status = 'PENDING', last_error = ?, lease_until = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?")
        .run(message, now + delay, now, command.id);
    } else {
      db.prepare("UPDATE door_command SET status = 'FAILED', last_error = ?, lease_until = NULL, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(message, now, now, command.id);
    }
    db.prepare('UPDATE door_state SET controller_online = ?, last_error = ?, updated_at = ? WHERE space_id = ?')
      .run(result.offline ? 0 : 1, message, now, command.spaceId);
    if (!result.offline) db.prepare('UPDATE door_state SET last_contact_at = ? WHERE space_id = ?').run(now, command.spaceId);
    if (contradicts) {
      db.prepare('UPDATE door_state SET reported_state = ?, reported_at = ? WHERE space_id = ?').run(result.state, now, command.spaceId);
    }
    // An OPEN the controller definitely refused never unlocked the door, so
    // its deadline is withdrawn. An unknown outcome keeps the deadline.
    if (command.action === 'OPEN' && !result.offline && !result.ok && state.reported_state === 'LOCKED'
      && Number(state.auto_lock_at) === Number(command.autoLockAt)) {
      db.prepare("UPDATE door_state SET desired_state = 'LOCKED', auto_lock_at = NULL, auto_lock_mode = NULL, unlocked_reservation_id = NULL WHERE space_id = ?")
        .run(command.spaceId);
    }
    const final = hydrateCommand(db.prepare('SELECT * FROM door_command WHERE id = ?').get(command.id));
    final.needsAlert = !retry && command.action === 'CLOSE' && command.actorType === 'SYSTEM';
    return final;
  });
}

/** Send one queued command to its controller and record what happened. */
export async function executeDoorCommand(db, commandId, { now = Date.now() } = {}) {
  const claimed = claimCommand(db, commandId, now);
  if (!claimed) {
    return hydrateCommand(db.prepare('SELECT * FROM door_command WHERE id = ?').get(Number(commandId)));
  }
  const result = await sendDoorCommand(claimed.command, claimed.config, { now });
  const outcome = recordOutcome(db, claimed.command, claimed.config, result, now);
  if (outcome?.needsAlert) {
    const space = db.prepare('SELECT code, name FROM space WHERE id = ?').get(claimed.command.spaceId);
    alertAdmins(db, {
      spaceId: claimed.command.spaceId,
      title: 'Door did not confirm locking',
      body: `${space?.name ?? 'A room'} (${space?.code ?? '?'}) did not confirm that it locked at ${businessTimeLabel(now)}. `
        + 'Please check the door in person.',
      dedupeKey: `door-alert:${claimed.command.id}`,
      now,
    });
  }
  return outcome;
}

/**
 * Turn due deadlines into SYSTEM CLOSE commands and recover commands whose
 * sender died mid-flight. Synchronous, idempotent and safe on every instance.
 */
export function scheduleDueDoorWork(db, { now = Date.now() } = {}) {
  return withWriteTransaction(db, () => {
    let queued = 0;
    const due = db.prepare('SELECT * FROM door_state WHERE auto_lock_at IS NOT NULL AND auto_lock_at <= ?').all(now);
    for (const state of due) {
      const bucket = Math.floor((now - Number(state.auto_lock_at)) / WATCHDOG_BUCKET_MS);
      if (bucket > WATCHDOG_BUCKETS) continue;
      const key = bucket === 0 ? `auto-lock:${state.space_id}:${state.auto_lock_at}` : `auto-lock:${state.space_id}:${state.auto_lock_at}:w${bucket}`;
      const result = insertCommand(db, {
        spaceId: state.space_id,
        reservationId: state.unlocked_reservation_id ?? null,
        actorType: 'SYSTEM', action: 'CLOSE', reason: DOOR_REASON.AUTO_LOCK,
        idempotencyKey: key, maxAttempts: bucket === 0 ? SYSTEM_CLOSE_ATTEMPTS : 2, now,
      });
      if (!result.idempotent) {
        queued += 1;
        db.prepare("UPDATE door_state SET desired_state = 'LOCKED', updated_at = ? WHERE space_id = ?").run(now, state.space_id);
      }
    }
    // A sender that crashed leaves SENDING behind. A CLOSE is retried; the
    // outcome of an OPEN is unknown, so it is closed out and never re-sent.
    const stale = db.prepare("SELECT * FROM door_command WHERE status = 'SENDING' AND lease_until IS NOT NULL AND lease_until <= ?").all(now);
    for (const row of stale) {
      if (row.action === 'CLOSE' && Number(row.attempts) < Number(row.max_attempts)) {
        db.prepare("UPDATE door_command SET status = 'PENDING', lease_until = NULL, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
          .run(now, 'The previous attempt did not finish.', now, row.id);
      } else {
        db.prepare("UPDATE door_command SET status = 'FAILED', lease_until = NULL, last_error = ?, updated_at = ?, completed_at = ? WHERE id = ?")
          .run('The command outcome is unknown.', now, now, row.id);
      }
    }
    return { queued, recovered: stale.length };
  });
}

/** Run everything that is due. Used by the worker loop, the cron tick and page loads. */
export async function runDoorQueue(db, { now = Date.now(), limit = 25 } = {}) {
  const scheduled = scheduleDueDoorWork(db, { now });
  const due = db.prepare("SELECT id FROM door_command WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?")
    .all(now, limit);
  let sent = 0;
  for (const row of due) {
    await executeDoorCommand(db, Number(row.id), { now });
    sent += 1;
  }
  return { ...scheduled, sent };
}

/** Cheap check used before doing any work on a customer page load. */
export function hasDueDoorWork(db, { now = Date.now() } = {}) {
  const deadline = db.prepare('SELECT 1 AS due FROM door_state WHERE auto_lock_at IS NOT NULL AND auto_lock_at <= ? LIMIT 1').get(now);
  if (deadline) return true;
  const command = db.prepare("SELECT 1 AS due FROM door_command WHERE (status = 'PENDING' AND next_attempt_at <= ?) OR (status = 'SENDING' AND lease_until <= ?) LIMIT 1").get(now, now);
  return Boolean(command);
}

/* --------------------------------------------------- controller callbacks */

/**
 * A controller reporting its own state (after a command, on a heartbeat, or
 * when someone used a physical key). The caller has verified the signature.
 */
export function recordControllerStatus(db, { doorIdentifier, state, commandId = null, now = Date.now() } = {}) {
  const reported = ['LOCKED', 'UNLOCKED'].includes(String(state ?? '').toUpperCase()) ? String(state).toUpperCase() : null;
  if (!reported) throw validationError('The door state must be LOCKED or UNLOCKED.');
  const outcome = withWriteTransaction(db, () => {
    const config = db.prepare('SELECT space_id FROM space_access_config WHERE door_identifier = ?').get(String(doorIdentifier ?? '').trim());
    if (!config) throw notFound('Unknown door.');
    const spaceId = Number(config.space_id);
    const before = ensureDoorState(db, spaceId, now);
    if (reported === 'LOCKED') {
      db.prepare(`UPDATE door_state SET reported_state = 'LOCKED', reported_at = ?, controller_online = 1, last_contact_at = ?, last_error = NULL,
          auto_lock_at = CASE WHEN desired_state = 'LOCKED' OR auto_lock_at <= ? THEN NULL ELSE auto_lock_at END,
          updated_at = ? WHERE space_id = ?`).run(now, now, now, now, spaceId);
      db.prepare("UPDATE door_state SET auto_lock_mode = NULL, unlocked_reservation_id = NULL WHERE space_id = ? AND auto_lock_at IS NULL").run(spaceId);
    } else {
      db.prepare("UPDATE door_state SET reported_state = 'UNLOCKED', reported_at = ?, controller_online = 1, last_contact_at = ?, last_error = NULL, updated_at = ? WHERE space_id = ?")
        .run(now, now, now, spaceId);
    }
    if (commandId !== null && /^\d+$/.test(String(commandId))) {
      const expected = reported === 'UNLOCKED' ? 'OPEN' : 'CLOSE';
      db.prepare("UPDATE door_command SET status = 'CONFIRMED', updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ? AND space_id = ? AND action = ? AND status IN ('ACKNOWLEDGED','SENDING')")
        .run(now, now, Number(commandId), spaceId, expected);
    }
    const unexpected = reported === 'UNLOCKED' && (before.auto_lock_at === null || before.auto_lock_at === undefined);
    return { spaceId, unexpected };
  });
  if (outcome.unexpected) {
    const space = db.prepare('SELECT code, name FROM space WHERE id = ?').get(outcome.spaceId);
    alertAdmins(db, {
      spaceId: outcome.spaceId,
      title: 'Door unlocked outside a booking',
      body: `${space?.name ?? 'A room'} (${space?.code ?? '?'}) reported that it is unlocked, but no booking or staff unlock is in force.`,
      dedupeKey: `door-unexpected:${outcome.spaceId}:${Math.floor(now / (30 * MINUTE))}`,
      now,
    });
  }
  return outcome;
}

/** Best-effort immediate run after a write queued door work; the worker and cron tick are the guarantee. */
export function kickDoorQueue(db) {
  const timer = setTimeout(() => {
    runDoorQueue(db).catch((error) => console.warn('[door] immediate queue run failed:', error?.code ?? error?.message ?? 'unknown'));
  }, 0);
  if (typeof timer.unref === 'function') timer.unref();
}
