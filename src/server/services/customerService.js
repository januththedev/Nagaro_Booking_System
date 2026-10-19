/**
 * Customer records.
 *
 * One authoritative profile per customer; reservations link to it by id.
 * Emails are normalised for duplicate detection, but the system NEVER merges
 * records automatically - staff decide.
 */
import { withWriteTransaction } from '../db/connection.js';
import { RESERVATION_STATUS, OCCUPANCY_STATUS } from '../domain/constants.js';
import { conflict, notFound, validationError } from '../domain/errors.js';
import { normalizeEmail, optionalEmail, optionalPhone, requiredString, asTrimmedString, LIMITS } from '../domain/validation.js';
import { recordAudit } from './auditService.js';

export function hydrateCustomer(db, row, { includeHistory = false } = {}) {
  if (!row) return null;
  const stats = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = '${RESERVATION_STATUS.CONFIRMED}' THEN 1 ELSE 0 END) AS confirmed,
           SUM(CASE WHEN status = '${RESERVATION_STATUS.CANCELLED}' THEN 1 ELSE 0 END) AS cancelled,
           MAX(start_at) AS last_start,
           SUM(CASE WHEN status <> '${RESERVATION_STATUS.CANCELLED}' THEN total_cents ELSE 0 END) AS booked_value
      FROM reservation WHERE customer_id = ?
  `).get(row.id);

  const customer = {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    emailNormalized: row.email_normalized,
    phone: row.phone,
    organization: row.organization,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: {
      totalReservations: stats.total ?? 0,
      confirmedReservations: stats.confirmed ?? 0,
      cancelledReservations: stats.cancelled ?? 0,
      lastBookingAt: stats.last_start ?? null,
      bookedValueCents: stats.booked_value ?? 0,
    },
  };
  if (includeHistory) customer.history = getCustomerHistory(db, row.id);
  return customer;
}

export function getCustomer(db, id) {
  const row = db.prepare('SELECT * FROM customer WHERE id = ?').get(Number(id));
  return hydrateCustomer(db, row);
}

export function getCustomerOrThrow(db, id) {
  const customer = getCustomer(db, id);
  if (!customer) throw notFound('Customer not found.');
  return customer;
}

export function getCustomerHistory(db, customerId, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT r.id, r.reference, r.status, r.start_at, r.end_at, r.unit_count, r.attendees,
           r.total_cents, r.currency, r.billing_unit, r.billing_quantity, r.cancellation_reason,
           r.cancelled_at, r.created_at,
           s.code AS space_code, s.name AS space_name, s.category AS space_category
      FROM reservation r
      JOIN space s ON s.id = r.space_id
     WHERE r.customer_id = ?
     ORDER BY r.start_at DESC
     LIMIT ?
  `).all(Number(customerId), Math.min(Number(limit) || 100, 500)).map((r) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    startAt: r.start_at,
    endAt: r.end_at,
    unitCount: r.unit_count,
    attendees: r.attendees,
    totalCents: r.total_cents,
    currency: r.currency,
    billingUnit: r.billing_unit,
    billingQuantity: r.billing_quantity,
    cancellationReason: r.cancellation_reason,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at,
    spaceId: null,
    spaceCode: r.space_code,
    spaceName: r.space_name,
    category: r.space_category,
  }));
}

/**
 * Search by name, organisation, email or phone.
 * `query` is matched with LIKE wildcards escaped by the caller.
 */
export function searchCustomers(db, { query = null, limit = 25, offset = 0, sort = 'name' } = {}) {
  const where = [];
  const params = [];
  const q = query ? String(query).trim() : '';
  if (q) {
    where.push(`(c.full_name LIKE ? COLLATE NOCASE OR c.email LIKE ? COLLATE NOCASE
                 OR c.organization LIKE ? COLLATE NOCASE OR c.phone LIKE ?)`);
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy = {
    name: 'c.full_name COLLATE NOCASE ASC',
    recent: 'c.created_at DESC',
    bookings: 'confirmed DESC, c.full_name COLLATE NOCASE ASC',
  }[sort] ?? 'c.full_name COLLATE NOCASE ASC';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM customer c ${clause}`).get(...params).c;
  const rows = db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM reservation r WHERE r.customer_id = c.id) AS total,
           (SELECT COUNT(*) FROM reservation r WHERE r.customer_id = c.id AND r.status = '${RESERVATION_STATUS.CONFIRMED}') AS confirmed,
           (SELECT COUNT(*) FROM reservation r WHERE r.customer_id = c.id AND r.status = '${RESERVATION_STATUS.CANCELLED}') AS cancelled,
           (SELECT MAX(r.start_at) FROM reservation r WHERE r.customer_id = c.id) AS last_start,
           (SELECT SUM(r.total_cents) FROM reservation r WHERE r.customer_id = c.id AND r.status <> '${RESERVATION_STATUS.CANCELLED}') AS booked_value
      FROM customer c
      ${clause}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?
  `).all(...params, Math.min(Number(limit) || 25, 200), Number(offset) || 0);

  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      email: r.email,
      phone: r.phone,
      organization: r.organization,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      stats: {
        totalReservations: r.total ?? 0,
        confirmedReservations: r.confirmed ?? 0,
        cancelledReservations: r.cancelled ?? 0,
        lastBookingAt: r.last_start ?? null,
        bookedValueCents: r.booked_value ?? 0,
      },
    })),
  };
}

/**
 * Likely duplicates for a (name, email) pair. Never merges - only reports so
 * staff can pick the right existing profile.
 */
export function findPossibleDuplicates(db, { email, fullName = null, excludeId = null } = {}) {
  const normalized = email ? normalizeEmail(email) : null;
  const results = [];

  if (normalized) {
    const byEmail = db.prepare('SELECT * FROM customer WHERE email_normalized = ?').all(normalized);
    for (const row of byEmail) {
      if (excludeId && row.id === Number(excludeId)) continue;
      results.push({ customer: hydrateCustomer(db, row), match: 'email', confidence: 'high' });
    }
  }
  const name = fullName ? String(fullName).trim() : '';
  if (name.length >= 3) {
    const byName = db.prepare('SELECT * FROM customer WHERE full_name LIKE ? COLLATE NOCASE LIMIT 10')
      .all(`%${name.replace(/[%_]/g, (m) => `\\${m}`)}%`);
    for (const row of byName) {
      if (excludeId && row.id === Number(excludeId)) continue;
      if (results.some((r) => r.customer.id === row.id)) continue;
      results.push({ customer: hydrateCustomer(db, row), match: 'name', confidence: 'medium' });
    }
  }
  return results;
}

export function parseCustomerPayload(input, { partial = false } = {}) {
  const provided = (key) => input[key] !== undefined;
  const value = {};
  if (provided('full_name') || provided('fullName') || !partial) {
    value.fullName = requiredString(input.full_name ?? input.fullName, { field: 'full_name', max: LIMITS.maxNameLength });
  }
  if (provided('email') || !partial) {
    value.email = requiredEmailField(input.email);
  }
  if (provided('phone')) value.phone = optionalPhone(input.phone);
  if (provided('organization')) value.organization = asTrimmedString(input.organization, { max: LIMITS.maxNameLength, field: 'organization' });
  if (provided('notes')) value.notes = asTrimmedString(input.notes, { max: LIMITS.maxLongTextLength, field: 'notes' });
  return value;
}

/**
 * Resolve the canonical customer for a public checkout while the caller owns
 * the write transaction. Existing profiles are never mutated; the oldest
 * matching email is reused. This keeps customer creation and inventory
 * allocation in one rollback boundary.
 */
export function resolveOrCreateCustomerInTransaction(db, { actor, payload } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated actor is required.');
  const value = parseCustomerPayload(payload);
  const normalized = normalizeEmail(value.email);
  const existing = db.prepare(`
    SELECT id FROM customer
     WHERE email_normalized = ?
     ORDER BY created_at ASC, id ASC
     LIMIT 1
  `).get(normalized);
  if (existing) return getCustomer(db, Number(existing.id));

  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO customer (full_name, email, email_normalized, phone, organization, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    value.fullName, value.email, normalized, value.phone ?? null,
    value.organization ?? null, null, now, now,
  );
  const id = Number(info.lastInsertRowid);
  recordAudit(db, {
    actorAdminUserId: actor.id,
    actorLabel: actor.label,
    action: 'customer.created',
    entityType: 'customer',
    entityId: id,
    summary: `Created customer ${value.fullName} through public checkout`,
    details: { email: normalized, organization: value.organization ?? null, source: 'public_checkout' },
  });
  return getCustomer(db, id);
}

function requiredEmailField(value) {
  const email = optionalEmail(value);
  if (!email) throw validationError('Email address is required.', { field: 'email' });
  return email;
}

export function createCustomer(db, { actor, payload, allowDuplicate = false } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const value = parseCustomerPayload(payload);
  const normalized = normalizeEmail(value.email);
  const now = Date.now();

  return withWriteTransaction(db, () => {
    const existing = db.prepare('SELECT * FROM customer WHERE email_normalized = ?').get(normalized);
    if (existing && !allowDuplicate) {
      throw conflict(
        `A customer with this email already exists: ${existing.full_name}. Select the existing profile instead.`,
      );
    }
    const info = db.prepare(`
      INSERT INTO customer (full_name, email, email_normalized, phone, organization, notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      value.fullName, value.email, normalized, value.phone ?? null,
      value.organization ?? null, value.notes ?? null, now, now,
    );
    const id = Number(info.lastInsertRowid);
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'customer.created', entityType: 'customer', entityId: id,
      summary: `Created customer ${value.fullName}`,
      details: { email: normalized, organization: value.organization ?? null },
    });
    return getCustomer(db, id);
  });
}

export function updateCustomer(db, { actor, customerId, payload } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(customerId);
  const existing = getCustomerOrThrow(db, id);
  const value = parseCustomerPayload(payload, { partial: true });
  const now = Date.now();

  return withWriteTransaction(db, () => {
    const merged = {
      fullName: value.fullName ?? existing.fullName,
      email: value.email ?? existing.email,
      phone: value.phone !== undefined ? value.phone : existing.phone,
      organization: value.organization !== undefined ? value.organization : existing.organization,
      notes: value.notes !== undefined ? value.notes : existing.notes,
    };
    const normalized = normalizeEmail(merged.email);
    const dupe = db.prepare('SELECT id, full_name FROM customer WHERE email_normalized = ? AND id <> ?').get(normalized, id);
    if (dupe) throw conflict(`Another customer already uses this email: ${dupe.full_name}.`);

    db.prepare(`
      UPDATE customer SET full_name = ?, email = ?, email_normalized = ?, phone = ?,
                          organization = ?, notes = ?, updated_at = ?
       WHERE id = ?
    `).run(merged.fullName, merged.email, normalized, merged.phone, merged.organization, merged.notes, now, id);

    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'customer.updated', entityType: 'customer', entityId: id,
      summary: `Updated customer ${merged.fullName}`,
      details: {
        before: { fullName: existing.fullName, email: existing.email, phone: existing.phone, organization: existing.organization },
        after: { fullName: merged.fullName, email: merged.email, phone: merged.phone, organization: merged.organization },
      },
    });
    return getCustomer(db, id);
  });
}

/** The spaces a customer has booked most, for quick re-booking. */
export function customerFrequentSpaces(db, customerId, { limit = 5 } = {}) {
  return db.prepare(`
    SELECT s.id, s.code, s.name, s.category, COUNT(*) AS bookings
      FROM reservation r JOIN space s ON s.id = r.space_id
     WHERE r.customer_id = ?
     GROUP BY s.id
     ORDER BY bookings DESC, s.name COLLATE NOCASE
     LIMIT ?
  `).all(Number(customerId), limit).map((r) => ({
    id: r.id, code: r.code, name: r.name, category: r.category, bookings: r.bookings,
  }));
}

export function customerUpcomingReservations(db, customerId, now = Date.now()) {
  return db.prepare(`
    SELECT r.id, r.reference, r.start_at, r.end_at, r.status,
           s.code AS space_code, s.name AS space_name
      FROM reservation r JOIN space s ON s.id = r.space_id
     WHERE r.customer_id = ? AND r.status = '${RESERVATION_STATUS.CONFIRMED}' AND r.end_at >= ?
     ORDER BY r.start_at ASC
  `).all(Number(customerId), now).map((r) => ({
    id: r.id, reference: r.reference, startAt: r.start_at, endAt: r.end_at,
    status: r.status, spaceCode: r.space_code, spaceName: r.space_name,
  }));
}

export { OCCUPANCY_STATUS };
