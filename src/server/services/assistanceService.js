/**
 * Staff assistance requests raised from the customer access page.
 *
 * One open request per booking (a partial unique index enforces it), so a
 * customer tapping the button repeatedly produces one notification, not ten.
 * Every signed-in member of staff is notified in-app and by Web Push.
 */
import { withWriteTransaction } from '../db/connection.js';
import { conflict, notFound, validationError } from '../domain/errors.js';
import { accessTimeLabel } from '../mail/accessTemplates.js';
import { recordAudit } from './auditService.js';
import { NOTIFICATION_PRIORITY, NOTIFICATION_TYPE, createNotificationsForAdmins, schedulePendingDispatch } from './notificationService.js';

const HOUR = 60 * 60_000;

function num(value) { return value === null || value === undefined ? null : Number(value); }

function hydrate(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reservationId: Number(row.reservation_id),
    spaceId: Number(row.space_id),
    status: row.status,
    contextState: row.context_state ?? null,
    createdAt: Number(row.created_at),
    acknowledgedAt: num(row.acknowledged_at),
    acknowledgedByName: row.acknowledged_by_name ?? null,
    resolvedAt: num(row.resolved_at),
    resolvedByName: row.resolved_by_name ?? null,
    resolutionNote: row.resolution_note ?? null,
    reservationReference: row.reservation_reference ?? null,
    spaceCode: row.space_code ?? null,
    spaceName: row.space_name ?? null,
    customerName: row.customer_name ?? null,
    customerPhone: row.customer_phone ?? null,
    endAt: num(row.end_at),
  };
}

const SELECT = `SELECT a.*, r.reference AS reservation_reference, r.end_at, s.code AS space_code, s.name AS space_name,
    c.full_name AS customer_name, c.phone AS customer_phone, ack.display_name AS acknowledged_by_name, res.display_name AS resolved_by_name
  FROM staff_assistance_request a
  JOIN reservation r ON r.id = a.reservation_id
  JOIN space s ON s.id = a.space_id
  JOIN customer c ON c.id = r.customer_id
  LEFT JOIN admin_user ack ON ack.id = a.acknowledged_by
  LEFT JOIN admin_user res ON res.id = a.resolved_by`;

export function latestAssistance(db, reservationId) {
  return hydrate(db.prepare('SELECT * FROM staff_assistance_request WHERE reservation_id = ? ORDER BY id DESC LIMIT 1').get(Number(reservationId)));
}

export function listAssistanceRequests(db, { open = true, limit = 50 } = {}) {
  const where = open ? "WHERE a.status IN ('OPEN','ACKNOWLEDGED')" : "WHERE a.status = 'RESOLVED'";
  return db.prepare(`${SELECT} ${where} ORDER BY a.id DESC LIMIT ?`).all(limit).map(hydrate);
}

export function countOpenAssistance(db) {
  return Number(db.prepare("SELECT COUNT(*) AS c FROM staff_assistance_request WHERE status = 'OPEN'").get()?.c ?? 0);
}

/** Raise (or return the already-open) assistance request for the booking behind an access link. */
export function requestAssistance(db, { access, contextState = null, now = Date.now() } = {}) {
  let created = false;
  const request = withWriteTransaction(db, () => {
    const open = db.prepare("SELECT * FROM staff_assistance_request WHERE reservation_id = ? AND status IN ('OPEN','ACKNOWLEDGED')").get(Number(access.reservation.id));
    if (open) return hydrate(open);
    const info = db.prepare(`INSERT INTO staff_assistance_request (reservation_id, access_link_id, space_id, status, context_state, created_at)
        VALUES (?,?,?,'OPEN',?,?)`).run(access.reservation.id, access.linkId, access.reservation.space_id, contextState ? String(contextState).slice(0, 40) : null, now);
    // Keep the page reachable while staff are on their way, even past retention.
    db.prepare('UPDATE booking_access_link SET retain_until = CASE WHEN retain_until IS NULL OR retain_until < ? THEN ? ELSE retain_until END, updated_at = ? WHERE id = ?')
      .run(now + 12 * HOUR, now + 12 * HOUR, now, access.linkId);
    recordAudit(db, {
      actorLabel: 'customer access link', action: 'staff_assistance.requested', entityType: 'reservation', entityId: access.reservation.id,
      summary: `Customer asked for staff assistance (${access.reservation.reference})`,
    });
    created = true;
    return hydrate(db.prepare('SELECT * FROM staff_assistance_request WHERE id = ?').get(Number(info.lastInsertRowid)));
  });
  if (created) {
    try {
      const result = createNotificationsForAdmins(db, {
        type: NOTIFICATION_TYPE.STAFF_ASSISTANCE,
        title: 'Customer needs assistance',
        body: `${access.reservation.customer_name} in ${access.reservation.space_name} (${access.reservation.space_code}) asked for staff assistance at `
          + `${accessTimeLabel(now)}. Booking ${access.reservation.reference}.`,
        entityType: 'reservation', entityId: String(access.reservation.id), actionUrl: '/admin/access',
        priority: NOTIFICATION_PRIORITY.HIGH, dedupeKey: `assistance:${request.id}`, now,
      });
      if (result.created > 0) schedulePendingDispatch(db);
    } catch (error) {
      console.warn('[assistance] could not notify staff:', error?.code ?? error?.message ?? 'unknown');
    }
  }
  return request;
}

export function acknowledgeAssistance(db, { actor, requestId, now = Date.now() } = {}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  return withWriteTransaction(db, () => {
    const row = db.prepare('SELECT * FROM staff_assistance_request WHERE id = ?').get(Number(requestId));
    if (!row) throw notFound('Assistance request not found.');
    if (row.status !== 'OPEN') throw conflict('This request was already picked up.');
    db.prepare("UPDATE staff_assistance_request SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ? WHERE id = ? AND status = 'OPEN'").run(actor.id, now, row.id);
    recordAudit(db, { actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'staff_assistance.acknowledged', entityType: 'reservation', entityId: row.reservation_id, summary: 'Acknowledged a staff assistance request' });
    return hydrate(db.prepare(`${SELECT} WHERE a.id = ?`).get(row.id));
  });
}

export function resolveAssistance(db, { actor, requestId, note = null, now = Date.now() } = {}) {
  if (!actor?.id) throw validationError('An authenticated staff actor is required.');
  return withWriteTransaction(db, () => {
    const row = db.prepare('SELECT * FROM staff_assistance_request WHERE id = ?').get(Number(requestId));
    if (!row) throw notFound('Assistance request not found.');
    if (row.status === 'RESOLVED') throw conflict('This request is already resolved.');
    const text = String(note ?? '').trim().slice(0, 500) || null;
    db.prepare(`UPDATE staff_assistance_request SET status = 'RESOLVED', resolved_by = ?, resolved_at = ?, resolution_note = ?,
        acknowledged_by = COALESCE(acknowledged_by, ?), acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?`).run(actor.id, now, text, actor.id, now, row.id);
    recordAudit(db, { actorAdminUserId: actor.id, actorLabel: actor.label ?? 'staff', action: 'staff_assistance.resolved', entityType: 'reservation', entityId: row.reservation_id, summary: 'Resolved a staff assistance request', details: { note: text } });
    return hydrate(db.prepare(`${SELECT} WHERE a.id = ?`).get(row.id));
  });
}
