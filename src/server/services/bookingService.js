/**
 * Booking service - the atomic booking core.
 *
 * CONCURRENCY CONTRACT (the defining correctness property of this system)
 * ----------------------------------------------------------------------
 * Every operation that creates, moves, or releases inventory runs inside
 * `withWriteTransaction`, i.e. `BEGIN IMMEDIATE`:
 *
 *   1. BEGIN IMMEDIATE takes SQLite's single write lock before any read.
 *      Concurrent processes block on `busy_timeout` instead of interleaving.
 *   2. Availability is therefore re-checked *while holding that lock*, so a
 *      successful earlier availability preview gives no false comfort.
 *   3. `occupancy` BEFORE INSERT / BEFORE UPDATE triggers independently
 *      reject overlapping ACTIVE rows on the same resource unit. Even if the
 *      service-layer check were removed, the database would refuse the write.
 *   4. Any failure rolls back the whole transaction, so a rejected edit
 *      leaves the original reservation and its allocations untouched, and a
 *      rejected creation leaves nothing behind.
 *
 * Cancellation releases inventory exactly once because the status transition
 * is an optimistic `UPDATE ... WHERE status = 'CONFIRMED'`; a second attempt
 * changes zero rows and is rejected instead of releasing twice.
 */
import { withWriteTransaction } from '../db/connection.js';
import { nextReference } from '../domain/references.js';
import {
  OCCUPANCY_SOURCE, OCCUPANCY_STATUS, RESERVATION_STATUS,
  RESOURCE_KIND, SPACE_CATEGORY, SPACE_STATUS,
} from '../domain/constants.js';
import {
  AppError, DoubleBookingError, conflict, notFound, validationError,
} from '../domain/errors.js';
import { assertBookingRules, allocateUnits, findConflicts, activeUnits } from './availabilityService.js';
import { quote, loadRates } from './pricingService.js';
import { recordAudit } from './auditService.js';
import { resolveOrCreateCustomerInTransaction } from './customerService.js';

/* --------------------------------------------------------------- utilities */

export function isTriggerConflict(error) {
  return String(error?.message ?? '').includes('DOUBLE_BOOKING_CONFLICT');
}

function isUniqueViolation(error, column) {
  const message = String(error?.message ?? '');
  return message.includes('UNIQUE constraint failed') && message.includes(column);
}

function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

/* ------------------------------------------------------------- hydration */

const RESERVATION_SELECT = `
  SELECT r.*,
         s.code   AS space_code,
         s.name   AS space_name,
         s.category AS space_category,
         s.status AS space_status,
         s.buffer_minutes AS space_buffer_minutes,
         s.open_time AS space_open_time,
         s.close_time AS space_close_time,
         c.full_name AS customer_full_name,
         c.email AS customer_email,
         c.phone AS customer_phone,
         c.organization AS customer_organization,
         cu.display_name AS created_by_name,
         uu.display_name AS updated_by_name,
         xu.display_name AS cancelled_by_name
    FROM reservation r
    JOIN space s ON s.id = r.space_id
    JOIN customer c ON c.id = r.customer_id
    LEFT JOIN admin_user cu ON cu.id = r.created_by
    LEFT JOIN admin_user uu ON uu.id = r.updated_by
    LEFT JOIN admin_user xu ON xu.id = r.cancelled_by
`;

export function loadReservation(db, id) {
  const row = db.prepare(`${RESERVATION_SELECT} WHERE r.id = ?`).get(id);
  if (!row) return null;
  return hydrateReservation(db, row);
}

export function findReservationByReference(db, reference) {
  const row = db.prepare(`${RESERVATION_SELECT} WHERE r.reference = ? COLLATE NOCASE`).get(String(reference ?? '').trim());
  return row ? hydrateReservation(db, row) : null;
}

export function hydrateReservation(db, row) {
  const units = db.prepare(`
    SELECT u.id, u.code, u.label, u.kind
      FROM occupancy o
      JOIN resource_unit u ON u.id = o.resource_unit_id
     WHERE o.reservation_id = ? AND o.status = '${OCCUPANCY_STATUS.ACTIVE}'
     ORDER BY u.code
  `).all(row.id);

  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    spaceId: row.space_id,
    spaceCode: row.space_code,
    spaceName: row.space_name,
    category: row.space_category,
    spaceStatus: row.space_status,
    bufferMinutes: row.space_buffer_minutes,
    customerId: row.customer_id,
    customer: {
      id: row.customer_id,
      fullName: row.customer_full_name,
      email: row.customer_email,
      phone: row.customer_phone,
      organization: row.customer_organization,
    },
    startAt: row.start_at,
    endAt: row.end_at,
    unitCount: row.unit_count,
    attendees: row.attendees,
    purpose: row.purpose,
    internalNotes: row.internal_notes,
    billingUnit: row.billing_unit,
    billingQuantity: row.billing_quantity,
    rateCents: row.rate_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    units,
    unitCodes: units.map((u) => u.code),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedByName: row.updated_by_name,
    updatedAt: row.updated_at,
    cancelledBy: row.cancelled_by,
    cancelledByName: row.cancelled_by_name,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    idempotencyKey: row.idempotency_key,
    bookingChannel: row.booking_channel ?? 'STAFF',
  };
}

/* ------------------------------------------------------------- validation */

function loadSpaceOrThrow(db, spaceId) {
  const space = db.prepare('SELECT * FROM space WHERE id = ?').get(spaceId);
  if (!space) throw notFound('Space not found.');
  if (space.status === SPACE_STATUS.ARCHIVED) {
    throw conflict('Archived spaces cannot receive new or changed reservations.');
  }
  return space;
}

function normaliseWindow({ startAt, endAt }) {
  const start = Number(startAt);
  const end = Number(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw validationError('A valid start and end time are required.', { field: 'start_at' });
  }
  if (end <= start) {
    throw validationError('The end time must be after the start time.', { field: 'end_at' });
  }
  if (end - start > 400 * 24 * 60 * 60 * 1000) {
    throw validationError('Booking periods longer than 400 days are not supported.', { field: 'end_at' });
  }
  return { startAt: Math.trunc(start), endAt: Math.trunc(end) };
}

function requiredUnitsFor(space, requested) {
  if (space.category === SPACE_CATEGORY.COWORKING) {
    const count = Number(requested ?? 1);
    if (!Number.isInteger(count) || count < 1) {
      throw validationError('Number of desks must be a whole number of at least 1.', { field: 'unit_count' });
    }
    return count;
  }
  return 1;
}

/* --------------------------------------------------------------- creation */

/**
 * Create a CONFIRMED reservation. Atomic: either the reservation, its
 * allocations and its audit entry all commit, or nothing does.
 *
 * @returns {{reservation: object, idempotent: boolean}}
 */
export function createReservation(db, input) {
  const {
    actor, spaceId, customerId, customerPayload = null, startAt, endAt, unitCount = 1, attendees = null,
    purpose = null, internalNotes = null, billingUnit = null,
    billingQuantity = null, idempotencyKey = null, source = 'admin',
    bookingChannel = 'STAFF', manageTokenHash = null,
  } = input ?? {};

  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  if (!spaceId) throw validationError('A space must be selected.', { field: 'space_id' });
  if (!customerId && !customerPayload) throw validationError('A customer must be selected.', { field: 'customer_id' });

  const window = normaliseWindow({ startAt, endAt });

  try {
    return withWriteTransaction(db, () => {
      if (idempotencyKey) {
        const existing = db.prepare('SELECT id FROM reservation WHERE idempotency_key = ?').get(String(idempotencyKey));
        if (existing) {
          return { reservation: loadReservation(db, existing.id), idempotent: true };
        }
      }

      const space = loadSpaceOrThrow(db, Number(spaceId));
      const resolvedCustomer = customerId
        ? db.prepare('SELECT id FROM customer WHERE id = ?').get(Number(customerId))
        : resolveOrCreateCustomerInTransaction(db, { actor, payload: customerPayload });
      const customer = resolvedCustomer ? { id: Number(resolvedCustomer.id) } : null;
      if (!customer) throw notFound('Customer not found.');

      assertBookingRules(space, window, attendees);
      const required = requiredUnitsFor(space, unitCount);

      // Availability is re-checked here, inside the write lock.
      const allocation = allocateUnits(db, {
        spaceId: space.id,
        startAt: window.startAt,
        endAt: window.endAt,
        requiredCount: required,
        bufferMinutes: space.buffer_minutes ?? 0,
      });

      const rates = loadRates(db, space.id);
      const priced = quote({
        space, rates, startAt: window.startAt, endAt: window.endAt,
        unitCount: required, billingUnit, billingQuantityOverride: billingQuantity,
      });

      const reference = nextReference(db, 'reservation');
      const now = Date.now();

      const channel = bookingChannel === 'PUBLIC' ? 'PUBLIC' : 'STAFF';
      const info = db.prepare(`
        INSERT INTO reservation
          (reference, space_id, customer_id, status, start_at, end_at, unit_count,
           attendees, purpose, internal_notes, billing_unit, billing_quantity,
           rate_cents, total_cents, currency, idempotency_key, created_by, created_at,
           updated_by, updated_at, booking_channel, manage_token_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        reference, space.id, customer.id, RESERVATION_STATUS.CONFIRMED,
        window.startAt, window.endAt, required,
        attendees === null || attendees === '' ? null : Number(attendees),
        purpose || null, internalNotes || null,
        priced.billingUnit, priced.billingQuantity, priced.rateCents, priced.totalCents,
        priced.currency, idempotencyKey ? String(idempotencyKey) : null,
        actor.id, now, actor.id, now, channel, manageTokenHash || null,
      );

      const reservationId = Number(info.lastInsertRowid);
      insertOccupancy(db, {
        reservationId,
        spaceId: space.id,
        unitIds: allocation.units.map((u) => u.id),
        startAt: window.startAt,
        endAt: window.endAt,
        now,
      });

      recordAudit(db, {
        actorAdminUserId: actor.id,
        actorLabel: actor.label,
        action: 'reservation.created',
        entityType: 'reservation',
        entityId: reservationId,
        summary: `Created ${reference} for ${allocation.units.map((u) => u.code).join(', ')}`,
        details: {
          reference,
          spaceId: space.id,
          spaceCode: space.code,
          customerId: customer.id,
          startAt: window.startAt,
          endAt: window.endAt,
          unitCount: required,
          units: allocation.units.map((u) => u.code),
          totalCents: priced.totalCents,
          source,
        },
      });

      return { reservation: loadReservation(db, reservationId), idempotent: false };
    });
  } catch (error) {
    return handleBookingFailure(db, error, { idempotencyKey, spaceId, window, required: unitCount });
  }
}

function insertOccupancy(db, { reservationId, spaceId, unitIds, startAt, endAt, now }) {
  const stmt = db.prepare(`
    INSERT INTO occupancy
      (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const unitId of unitIds) {
    stmt.run(
      unitId, spaceId, startAt, endAt,
      OCCUPANCY_STATUS.ACTIVE, OCCUPANCY_SOURCE.RESERVATION, reservationId, now,
    );
  }
}

/**
 * Translate post-rollback failures into domain errors with useful detail.
 * Runs *after* the transaction has been rolled back, so reads here reflect
 * committed state only.
 */
function handleBookingFailure(db, error, { idempotencyKey, spaceId, window, required }) {
  if (error instanceof AppError) throw error;

  if (idempotencyKey && isUniqueViolation(error, 'reservation.idempotency_key')) {
    const row = db.prepare('SELECT id FROM reservation WHERE idempotency_key = ?').get(String(idempotencyKey));
    if (row) return { reservation: loadReservation(db, row.id), idempotent: true };
  }

  if (isTriggerConflict(error) || isUniqueViolation(error, 'reservation.reference')) {
    const conflicts = window
      ? findConflicts(db, { spaceId: Number(spaceId), startAt: window.startAt, endAt: window.endAt })
      : [];
    throw new DoubleBookingError(
      'Another booking for this space was committed first. The requested period is no longer available.',
      conflicts,
    );
  }

  throw error;
}

/* ------------------------------------------------------------------ update */

/**
 * Edit a CONFIRMED reservation. The previous allocations are released and new
 * ones taken inside the same transaction: if any part fails, the rollback
 * restores the original reservation exactly as it was.
 */
export function updateReservation(db, {
  actor, reservationId, patch = {}, idempotencyKey = null,
} = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(reservationId);
  if (!Number.isInteger(id) || id < 1) throw validationError('A valid reservation id is required.');

  // Recorded outside the transaction so the post-rollback error path can
  // report which committed bookings actually blocked the change.
  const failureContext = { spaceId: null, startAt: null, endAt: null };

  try {
    return withWriteTransaction(db, () => {
      const current = db.prepare(`${RESERVATION_SELECT} WHERE r.id = ?`).get(id);
      if (!current) throw notFound('Reservation not found.');
      if (current.status === RESERVATION_STATUS.CANCELLED) {
        throw conflict('Cancelled reservations cannot be edited. Create a new reservation instead.');
      }

      const durationMs = current.end_at - current.start_at;
      const targetSpaceId = patch.spaceId !== undefined && patch.spaceId !== null
        ? Number(patch.spaceId) : current.space_id;
      const window = normaliseWindow({
        startAt: patch.startAt !== undefined && patch.startAt !== null ? patch.startAt : current.start_at,
        endAt: patch.endAt !== undefined && patch.endAt !== null
          ? patch.endAt
          : (patch.startAt !== undefined && patch.startAt !== null
            ? Number(patch.startAt) + durationMs
            : current.end_at),
      });

      const space = loadSpaceOrThrow(db, targetSpaceId);
      failureContext.spaceId = space.id;
      failureContext.startAt = window.startAt;
      failureContext.endAt = window.endAt;
      const customerId = patch.customerId !== undefined && patch.customerId !== null
        ? Number(patch.customerId) : current.customer_id;
      const customer = db.prepare('SELECT id FROM customer WHERE id = ?').get(customerId);
      if (!customer) throw notFound('Customer not found.');

      const attendees = patch.attendees !== undefined ? patch.attendees : current.attendees;
      const unitCount = patch.unitCount !== undefined && patch.unitCount !== null
        ? patch.unitCount : current.unit_count;

      assertBookingRules(space, window, attendees);
      const required = requiredUnitsFor(space, unitCount);

      // Remember which units this reservation held so a pure time edit keeps
      // the same desks/room whenever they are still free.
      const previousUnitIds = db.prepare(
        `SELECT resource_unit_id FROM occupancy WHERE reservation_id = ? AND status = '${OCCUPANCY_STATUS.ACTIVE}'`,
      ).all(id).map((r) => r.resource_unit_id);

      const now = Date.now();

      // Release inside the transaction; rolled back automatically on failure.
      db.prepare(
        `UPDATE occupancy SET status = '${OCCUPANCY_STATUS.RELEASED}', released_at = ?
          WHERE reservation_id = ? AND status = '${OCCUPANCY_STATUS.ACTIVE}'`,
      ).run(now, id);

      const allocation = allocateUnits(db, {
        spaceId: space.id,
        startAt: window.startAt,
        endAt: window.endAt,
        requiredCount: required,
        bufferMinutes: space.buffer_minutes ?? 0,
        excludeReservationId: id,
        preferredUnitIds: previousUnitIds,
      });

      const rates = loadRates(db, space.id);
      const rateChanged =
        (patch.billingUnit !== undefined && patch.billingUnit !== current.billing_unit)
        || (patch.billingQuantity !== undefined)
        || space.id !== current.space_id
        || window.startAt !== current.start_at
        || window.endAt !== current.end_at
        || required !== current.unit_count;

      const priced = rateChanged || patch.billingUnit !== undefined
        ? quote({
          space, rates, startAt: window.startAt, endAt: window.endAt,
          unitCount: required,
          billingUnit: patch.billingUnit !== undefined ? patch.billingUnit : current.billing_unit,
          billingQuantityOverride: patch.billingQuantity !== undefined ? patch.billingQuantity : null,
        })
        : {
          billingUnit: current.billing_unit,
          billingQuantity: current.billing_quantity,
          rateCents: current.rate_cents,
          totalCents: current.total_cents,
          currency: current.currency,
        };

      db.prepare(`
        UPDATE reservation
           SET space_id = ?, customer_id = ?, start_at = ?, end_at = ?, unit_count = ?,
               attendees = ?, purpose = ?, internal_notes = ?,
               billing_unit = ?, billing_quantity = ?, rate_cents = ?, total_cents = ?,
               updated_by = ?, updated_at = ?
         WHERE id = ?
      `).run(
        space.id, customerId, window.startAt, window.endAt, required,
        attendees === null || attendees === '' ? null : Number(attendees),
        patch.purpose !== undefined ? (patch.purpose || null) : current.purpose,
        patch.internalNotes !== undefined ? (patch.internalNotes || null) : current.internal_notes,
        priced.billingUnit, priced.billingQuantity, priced.rateCents, priced.totalCents,
        actor.id, now, id,
      );

      insertOccupancy(db, {
        reservationId: id,
        spaceId: space.id,
        unitIds: allocation.units.map((u) => u.id),
        startAt: window.startAt,
        endAt: window.endAt,
        now,
      });

      recordAudit(db, {
        actorAdminUserId: actor.id,
        actorLabel: actor.label,
        action: 'reservation.updated',
        entityType: 'reservation',
        entityId: id,
        summary: `Updated ${current.reference}`,
        details: {
          reference: current.reference,
          before: {
            spaceId: current.space_id,
            customerId: current.customer_id,
            startAt: current.start_at,
            endAt: current.end_at,
            unitCount: current.unit_count,
            attendees: current.attendees,
            totalCents: current.total_cents,
          },
          after: {
            spaceId: space.id,
            customerId,
            startAt: window.startAt,
            endAt: window.endAt,
            unitCount: required,
            attendees: attendees === null || attendees === '' ? null : Number(attendees),
            totalCents: priced.totalCents,
            units: allocation.units.map((u) => u.code),
          },
        },
      });

      return { reservation: loadReservation(db, id), idempotent: false };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isTriggerConflict(error)) {
      const conflicts = failureContext.spaceId && failureContext.startAt !== null
        ? findConflicts(db, {
          spaceId: failureContext.spaceId,
          startAt: failureContext.startAt,
          endAt: failureContext.endAt,
        }).filter((c) => c.reservationId !== id)
        : [];
      throw new DoubleBookingError(
        'The requested change collides with another confirmed booking. The original reservation was left unchanged.',
        conflicts,
      );
    }
    throw error;
  }
}

/* -------------------------------------------------------------- cancel */

/**
 * Cancel a reservation. Requires a non-blank reason, records actor/time/reason,
 * preserves the historical row, and releases inventory exactly once.
 */
export function cancelReservation(db, { actor, reservationId, reason } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(reservationId);
  if (!Number.isInteger(id) || id < 1) throw validationError('A valid reservation id is required.');

  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length === 0) {
    throw validationError('A cancellation reason is required.', { field: 'cancellation_reason' });
  }
  if (text.length > 1000) {
    throw validationError('The cancellation reason must be 1000 characters or fewer.', { field: 'cancellation_reason' });
  }

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM reservation WHERE id = ?').get(id);
    if (!current) throw notFound('Reservation not found.');

    const now = Date.now();
    // Optimistic guard: only a CONFIRMED reservation can be cancelled, so a
    // repeated request changes zero rows and cannot release inventory twice.
    const result = db.prepare(`
      UPDATE reservation
         SET status = '${RESERVATION_STATUS.CANCELLED}',
             cancelled_by = ?, cancelled_at = ?, cancellation_reason = ?,
             updated_by = ?, updated_at = ?
       WHERE id = ? AND status = '${RESERVATION_STATUS.CONFIRMED}'
    `).run(actor.id, now, text, actor.id, now, id);

    if (Number(result.changes) !== 1) {
      throw conflict(
        current.status === RESERVATION_STATUS.CANCELLED
          ? 'This reservation is already cancelled.'
          : 'Only confirmed reservations can be cancelled.',
      );
    }

    const released = db.prepare(`
      UPDATE occupancy SET status = '${OCCUPANCY_STATUS.RELEASED}', released_at = ?
       WHERE reservation_id = ? AND status = '${OCCUPANCY_STATUS.ACTIVE}'
    `).run(now, id);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'reservation.cancelled',
      entityType: 'reservation',
      entityId: id,
      summary: `Cancelled ${current.reference}: ${text}`,
      details: {
        reference: current.reference,
        reason: text,
        releasedOccupancyRows: Number(released.changes),
        spaceId: current.space_id,
        startAt: current.start_at,
        endAt: current.end_at,
        totalCents: current.total_cents,
      },
    });

    return { reservation: loadReservation(db, id), releasedOccupancyRows: Number(released.changes) };
  });
}

/**
 * Mark past CONFIRMED reservations as COMPLETED. History is preserved and the
 * occupancy rows stay ACTIVE because they describe a real past interval.
 */
export function reconcileCompletedReservations(db, now = Date.now()) {
  return withWriteTransaction(db, () => {
    const rows = db.prepare(
      `SELECT id FROM reservation WHERE status = '${RESERVATION_STATUS.CONFIRMED}' AND end_at < ?`,
    ).all(now);
    if (rows.length === 0) return 0;
    const stmt = db.prepare(
      `UPDATE reservation SET status = '${RESERVATION_STATUS.COMPLETED}', updated_at = ? WHERE id = ?`,
    );
    for (const row of rows) stmt.run(now, row.id);
    return rows.length;
  });
}

/* ----------------------------------------------------------- maintenance */

/**
 * Block inventory for maintenance. Occupancy rows are created for every
 * affected unit, so the same database trigger that prevents double bookings
 * also prevents a maintenance block from clobbering a confirmed reservation.
 */
export function createMaintenanceBlock(db, {
  actor, spaceId, startAt, endAt, reason, resourceUnitIds = null, idempotencyKey = null,
} = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const window = normaliseWindow({ startAt, endAt });
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length === 0) throw validationError('A reason is required for a maintenance block.', { field: 'reason' });

  try {
    void idempotencyKey;
    return withWriteTransaction(db, () => {
      const space = db.prepare('SELECT * FROM space WHERE id = ?').get(Number(spaceId));
      if (!space) throw notFound('Space not found.');

      const units = activeUnits(db, space.id);
      const targets = resourceUnitIds && resourceUnitIds.length
        ? units.filter((u) => resourceUnitIds.map(Number).includes(u.id))
        : units;
      if (targets.length === 0) throw conflict('This space has no active bookable inventory to block.');

      const now = Date.now();
      const info = db.prepare(`
        INSERT INTO maintenance_block (space_id, start_at, end_at, reason, status, created_by, created_at)
        VALUES (?,?,?,?,'ACTIVE',?,?)
      `).run(space.id, window.startAt, window.endAt, text, actor.id, now);

      const blockId = Number(info.lastInsertRowid);
      const stmt = db.prepare(`
        INSERT INTO occupancy
          (resource_unit_id, space_id, start_at, end_at, status, source, reservation_id,
           maintenance_block_id, created_at)
        VALUES (?,?,?,?,?,?,NULL,?,?)
      `);
      for (const unit of targets) {
        stmt.run(
          unit.id, space.id, window.startAt, window.endAt,
          OCCUPANCY_STATUS.ACTIVE, OCCUPANCY_SOURCE.MAINTENANCE, blockId, now,
        );
      }

      recordAudit(db, {
        actorAdminUserId: actor.id,
        actorLabel: actor.label,
        action: 'maintenance.created',
        entityType: 'maintenance_block',
        entityId: blockId,
        summary: `Blocked ${space.code} (${targets.length} unit${targets.length === 1 ? '' : 's'}): ${text}`,
        details: { spaceId: space.id, startAt: window.startAt, endAt: window.endAt, reason: text },
      });

      return { maintenanceBlockId: blockId, units: targets.map((u) => u.code) };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isTriggerConflict(error)) {
      const conflicts = findConflicts(db, {
        spaceId: Number(spaceId), startAt: window.startAt, endAt: window.endAt,
      });
      throw new DoubleBookingError(
        'Maintenance cannot be scheduled over an existing confirmed reservation.',
        conflicts,
      );
    }
    throw error;
  }
}

export function cancelMaintenanceBlock(db, { actor, maintenanceBlockId, reason = null } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(maintenanceBlockId);
  if (!Number.isInteger(id) || id < 1) throw validationError('A valid maintenance block id is required.');

  return withWriteTransaction(db, () => {
    const block = db.prepare('SELECT * FROM maintenance_block WHERE id = ?').get(id);
    if (!block) throw notFound('Maintenance block not found.');
    if (block.status === 'CANCELLED') throw conflict('This maintenance block is already cancelled.');

    const now = Date.now();
    db.prepare('UPDATE maintenance_block SET status = ?, cancelled_by = ?, cancelled_at = ? WHERE id = ?')
      .run('CANCELLED', actor.id, now, id);

    const released = db.prepare(`
      UPDATE occupancy SET status = '${OCCUPANCY_STATUS.RELEASED}', released_at = ?
       WHERE maintenance_block_id = ? AND status = '${OCCUPANCY_STATUS.ACTIVE}'
    `).run(now, id);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'maintenance.cancelled',
      entityType: 'maintenance_block',
      entityId: id,
      summary: `Cancelled maintenance block on space ${block.space_id}`,
      details: { reason: reason ? String(reason).trim() : null },
    });

    return { releasedOccupancyRows: Number(released.changes) };
  });
}

export function listMaintenanceBlocks(db, { spaceId = null, fromAt = null, toAt = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (spaceId) { where.push('m.space_id = ?'); params.push(Number(spaceId)); }
  if (fromAt) { where.push('m.end_at > ?'); params.push(Number(fromAt)); }
  if (toAt) { where.push('m.start_at < ?'); params.push(Number(toAt)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT m.*, s.code AS space_code, s.name AS space_name, a.display_name AS created_by_name
      FROM maintenance_block m
      JOIN space s ON s.id = m.space_id
      LEFT JOIN admin_user a ON a.id = m.created_by
      ${clause}
     ORDER BY m.start_at DESC
     LIMIT ?
  `).all(...params, Math.min(Number(limit) || 100, 500)).map((row) => ({
    id: row.id,
    spaceId: row.space_id,
    spaceCode: row.space_code,
    spaceName: row.space_name,
    startAt: row.start_at,
    endAt: row.end_at,
    reason: row.reason,
    status: row.status,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
  }));
}

export const _internals = { isUniqueViolation, requiredUnitsFor, normaliseWindow, placeholders, RESERVATION_SELECT };
