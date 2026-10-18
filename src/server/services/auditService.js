/**
 * Audit trail. Records are written inside the same transaction as the
 * mutation they describe, so an audit entry can never survive a rolled-back
 * change and a committed change always has its history.
 */

export function recordAudit(db, {
  at = Date.now(),
  actorAdminUserId = null,
  actorLabel = 'system',
  action,
  entityType,
  entityId = null,
  summary,
  details = null,
}) {
  if (!action) throw new Error('audit action is required');
  if (!entityType) throw new Error('audit entityType is required');
  if (!summary) throw new Error('audit summary is required');
  db.prepare(`INSERT INTO audit_log
      (at, actor_admin_user_id, actor_label, action, entity_type, entity_id, summary, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      at,
      actorAdminUserId,
      actorLabel,
      action,
      entityType,
      entityId === null ? null : String(entityId),
      summary,
      details === null ? null : JSON.stringify(details),
    );
}

/** Read recent audit entries, optionally filtered to one entity. */
export function listAudit(db, { entityType = null, entityId = null, actorAdminUserId = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (entityId !== null && entityId !== undefined) { where.push('entity_id = ?'); params.push(String(entityId)); }
  if (actorAdminUserId) { where.push('actor_admin_user_id = ?'); params.push(actorAdminUserId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(Number(limit) || 50, 200), Number(offset) || 0);
  return rows.map(hydrateAudit);
}

export function hydrateAudit(row) {
  if (!row) return null;
  let details = null;
  if (row.details) {
    try { details = JSON.parse(row.details); } catch { details = null; }
  }
  return {
    id: row.id,
    at: row.at,
    actorAdminUserId: row.actor_admin_user_id,
    actorLabel: row.actor_label,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    details,
  };
}
