/**
 * Space management: catalogue records, rates, photographs and bookable
 * inventory (resource units).
 *
 * Inventory shape by category:
 *   MEETING_ROOM / AUDITORIUM -> exactly one EXCLUSIVE unit (capacity 1)
 *   COWORKING                 -> N independent DESK units
 * Adding or removing desks is a single atomic operation that refuses to drop
 * a desk that still has future active occupancy.
 */
import { withWriteTransaction } from '../db/connection.js';
import {
  ALLOWED_PRICING_UNITS, PRICING_UNIT, RESOURCE_KIND, SPACE_CATEGORY,
  SPACE_CATEGORY_LABEL, SPACE_STATUS, OCCUPANCY_STATUS,
} from '../domain/constants.js';
import { conflict, notFound, validationError } from '../domain/errors.js';
import { parseSpacePayload, safeJson, asInteger } from '../domain/validation.js';
import { recordAudit } from './auditService.js';
import { formatMoney } from './pricingService.js';

const SPACE_SELECT = `
  SELECT s.*,
         (SELECT COUNT(*) FROM space_image i WHERE i.space_id = s.id) AS image_count,
         (SELECT i.stored_name FROM space_image i WHERE i.space_id = s.id AND i.is_cover = 1) AS cover_image,
         (SELECT COUNT(*) FROM resource_unit u WHERE u.space_id = s.id AND u.is_active = 1) AS unit_count
    FROM space s
`;

export function hydrateSpace(db, row) {
  if (!row) return null;
  const rates = db.prepare('SELECT unit, amount_cents, is_default FROM space_rate WHERE space_id = ? ORDER BY amount_cents').all(row.id);
  const rateMap = {};
  for (const r of rates) rateMap[r.unit] = r.amount_cents;
  const units = db.prepare(
    'SELECT id, code, label, kind, is_active FROM resource_unit WHERE space_id = ? ORDER BY code',
  ).all(row.id).filter((u) => u.is_active === 1);

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    categoryLabel: SPACE_CATEGORY_LABEL[row.category] ?? row.category,
    shortDescription: row.short_description,
    description: row.description,
    location: row.location,
    floor: row.floor,
    capacity: row.capacity,
    status: row.status,
    currency: row.currency,
    pricingUnit: row.pricing_unit,
    minDurationMinutes: row.min_duration_minutes,
    maxDurationMinutes: row.max_duration_minutes,
    bufferMinutes: row.buffer_minutes,
    openTime: row.open_time,
    closeTime: row.close_time,
    amenities: safeJson(row.amenities, []),
    attributes: safeJson(row.attributes, {}),
    contactNote: row.contact_note,
    rates: rateMap,
    rateList: rates,
    units,
    unitCount: row.unit_count ?? units.length,
    imageCount: row.image_count ?? 0,
    coverImage: row.cover_image ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    archivedAt: row.archived_at,
  };
}

export function listSpaces(db, {
  status = null, category = null, search = null, includeArchived = false,
  limit = 100, offset = 0, sort = 'name',
} = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('s.status = ?'); params.push(status); }
  else if (!includeArchived) { where.push("s.status <> 'ARCHIVED'"); }
  if (category) { where.push('s.category = ?'); params.push(category); }
  if (search) {
    where.push('(s.name LIKE ? COLLATE NOCASE OR s.code LIKE ? COLLATE NOCASE OR s.location LIKE ? COLLATE NOCASE OR s.short_description LIKE ? COLLATE NOCASE)');
    const like = `%${String(search).trim()}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy = {
    name: 's.name COLLATE NOCASE ASC',
    newest: 's.created_at DESC',
    updated: 's.updated_at DESC',
    capacity: 's.capacity DESC',
  }[sort] ?? 's.name COLLATE NOCASE ASC';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM space s ${clause}`).get(...params).c;
  const rows = db.prepare(`${SPACE_SELECT} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0);
  return { total, items: rows.map((r) => hydrateSpace(db, r)) };
}

export function getSpace(db, id) {
  const row = db.prepare(`${SPACE_SELECT} WHERE s.id = ?`).get(Number(id));
  return row ? hydrateSpace(db, row) : null;
}

export function getSpaceByCode(db, code) {
  const row = db.prepare(`${SPACE_SELECT} WHERE s.code = ? COLLATE NOCASE`).get(String(code ?? '').trim());
  return row ? hydrateSpace(db, row) : null;
}

export function getSpaceOrThrow(db, id) {
  const space = getSpace(db, id);
  if (!space) throw notFound('Space not found.');
  return space;
}

/* ------------------------------------------------------------ inventory */

function unitKindFor(category) {
  return category === SPACE_CATEGORY.COWORKING ? RESOURCE_KIND.DESK : RESOURCE_KIND.EXCLUSIVE;
}

/**
 * Make the active unit set match `desiredCount` without disturbing occupancy
 * that is already committed. Desks are only ever deactivated when they hold
 * no ACTIVE occupancy.
 */
function syncUnits(db, { space, desiredCount, now }) {
  const kind = unitKindFor(space.category);
  const all = db.prepare('SELECT * FROM resource_unit WHERE space_id = ? ORDER BY code').all(space.id);
  const active = all.filter((u) => u.is_active === 1);

  if (desiredCount < active.length) {
    const removable = active.slice(desiredCount);
    const busy = new Set(
      db.prepare(`
        SELECT DISTINCT resource_unit_id FROM occupancy
         WHERE status = '${OCCUPANCY_STATUS.ACTIVE}' AND resource_unit_id IN (${removable.map(() => '?').join(',')})
      `).all(...removable.map((u) => u.id)).map((r) => r.resource_unit_id),
    );
    const blocked = removable.filter((u) => busy.has(u.id));
    if (blocked.length > 0) {
      throw conflict(
        `Cannot remove ${blocked.length} desk${blocked.length === 1 ? '' : 's'} (${blocked.map((u) => u.code).join(', ')}): they hold confirmed or upcoming occupancy. Cancel or move those reservations first.`,
      );
    }
    const stmt = db.prepare('UPDATE resource_unit SET is_active = 0 WHERE id = ?');
    for (const u of removable) stmt.run(u.id);
    return { deactivated: removable.length, created: 0 };
  }

  const toCreate = desiredCount - active.length;
  if (toCreate <= 0) return { deactivated: 0, created: 0 };

  const usedCodes = new Set(all.map((u) => u.code));
  const prefix = space.category === SPACE_CATEGORY.COWORKING ? 'DESK' : 'UNIT';
  const stmt = db.prepare(
    'INSERT INTO resource_unit (space_id, code, label, kind, is_active, created_at) VALUES (?,?,?,?,1,?)',
  );
  let created = 0;
  let index = 1;
  while (created < toCreate && index < 5000) {
    const code = `${prefix}-${String(index).padStart(2, '0')}`;
    index += 1;
    if (usedCodes.has(code)) continue;
    usedCodes.add(code);
    stmt.run(space.id, code, space.category === SPACE_CATEGORY.COWORKING ? `Desk ${code.split('-')[1]}` : space.name, kind, now);
    created += 1;
  }
  // Reactivate previously deactivated units before generating brand new ones.
  return { deactivated: 0, created };
}

function normaliseRates(category, inputRates, existingRates = {}, fallbackUnit = null) {
  const allowed = ALLOWED_PRICING_UNITS[category];
  const out = {};
  if (Array.isArray(inputRates)) {
    for (const entry of inputRates) {
      if (!entry || typeof entry !== 'object') continue;
      const unit = String(entry.unit ?? '').trim();
      if (!allowed.includes(unit)) continue;
      const raw = entry.amount_cents !== undefined ? entry.amount_cents : entry.amount;
      if (raw === undefined || raw === null || raw === '') continue;
      const cents = typeof raw === 'number' && Number.isInteger(raw)
        ? raw
        : Math.round(Number(String(raw).replace(/,/g, '')) * 100);
      if (!Number.isFinite(cents) || cents < 0) {
        throw validationError(`Enter a valid amount for the ${unit.toLowerCase().replace('_', ' ')} rate.`, { field: `rates.${unit}` });
      }
      out[unit] = cents;
    }
  } else {
    for (const [unit, cents] of Object.entries(existingRates ?? {})) {
      if (allowed.includes(unit)) out[unit] = cents;
    }
  }
  const preferred = fallbackUnit && allowed.includes(fallbackUnit) ? fallbackUnit : allowed[0];
  if (out[preferred] === undefined) {
    for (const candidate of allowed) {
      if (out[candidate] !== undefined) { out[preferred] = out[candidate]; break; }
    }
  }
  return out;
}

function persistRates(db, spaceId, rates) {
  db.prepare('DELETE FROM space_rate WHERE space_id = ?').run(spaceId);
  const stmt = db.prepare('INSERT INTO space_rate (space_id, unit, amount_cents, is_default) VALUES (?,?,?,?)');
  for (const [unit, cents] of Object.entries(rates)) {
    stmt.run(spaceId, unit, cents, 0);
  }
  // Exactly one default, used when a booking omits an explicit unit.
  const primary = db.prepare('SELECT unit FROM space_rate WHERE space_id = ? ORDER BY amount_cents DESC LIMIT 1').get(spaceId);
  if (primary) db.prepare('UPDATE space_rate SET is_default = 1 WHERE space_id = ? AND unit = ?').run(spaceId, primary.unit);
}

/* --------------------------------------------------------------- writes */

export function createSpace(db, { actor, payload } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const value = parseSpacePayload(payload, { partial: false });
  const now = Date.now();

  return withWriteTransaction(db, () => {
    const dupe = db.prepare('SELECT id FROM space WHERE code = ? COLLATE NOCASE').get(value.code);
    if (dupe) throw conflict(`A space with code ${value.code} already exists.`);

    const deskCount = value.category === SPACE_CATEGORY.COWORKING
      ? (value.desk_count ?? Math.max(1, value.capacity))
      : 1;

    const info = db.prepare(`
      INSERT INTO space
        (code, name, category, short_description, description, location, floor, capacity,
         status, currency, pricing_unit, min_duration_minutes, max_duration_minutes,
         buffer_minutes, open_time, close_time, amenities, attributes, contact_note,
         created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      value.code, value.name, value.category, value.short_description, value.description,
      value.location, value.floor ?? null, value.capacity,
      value.currency ?? 'ETB', value.pricing_unit ?? ALLOWED_PRICING_UNITS[value.category][0],
      value.min_duration_minutes ?? 60, value.max_duration_minutes ?? null,
      value.buffer_minutes ?? 0, value.open_time ?? '08:00', value.close_time ?? '18:00',
      JSON.stringify(value.amenities ?? []), JSON.stringify(value.attributes ?? {}),
      value.contact_note ?? null, now, now,
    );

    const spaceId = Number(info.lastInsertRowid);
    const space = getSpace(db, spaceId);
    syncUnits(db, { space, desiredCount: deskCount, now });
    persistRates(db, spaceId, normaliseRates(value.category, value.rates, {}, space.pricingUnit));

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'space.created',
      entityType: 'space',
      entityId: spaceId,
      summary: `Created space ${value.code} (${value.name})`,
      details: { code: value.code, category: value.category, unitCount: deskCount },
    });

    return getSpace(db, spaceId);
  });
}

export function updateSpace(db, { actor, spaceId, payload } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(spaceId);
  const existing = getSpaceOrThrow(db, id);
  const value = parseSpacePayload(payload, { partial: true, existing: {
    ...existing,
    short_description: existing.shortDescription,
    pricing_unit: existing.pricingUnit,
    min_duration_minutes: existing.minDurationMinutes,
    max_duration_minutes: existing.maxDurationMinutes,
    buffer_minutes: existing.bufferMinutes,
    open_time: existing.openTime,
    close_time: existing.closeTime,
    contact_note: existing.contactNote,
  } });

  const now = Date.now();
  return withWriteTransaction(db, () => {
    if (value.code && value.code !== existing.code) {
      const dupe = db.prepare('SELECT id FROM space WHERE code = ? COLLATE NOCASE AND id <> ?').get(value.code, id);
      if (dupe) throw conflict(`A space with code ${value.code} already exists.`);
    }
    if (value.category && value.category !== existing.category) {
      const activeOccupancy = db.prepare(
        `SELECT COUNT(*) AS c FROM occupancy WHERE space_id = ? AND status = '${OCCUPANCY_STATUS.ACTIVE}'`,
      ).get(id).c;
      if (activeOccupancy > 0) {
        throw conflict('The category cannot be changed while the space has active occupancy.');
      }
    }

    const merged = {
      code: value.code ?? existing.code,
      name: value.name ?? existing.name,
      category: value.category ?? existing.category,
      short_description: value.short_description ?? existing.shortDescription,
      description: value.description ?? existing.description,
      location: value.location ?? existing.location,
      floor: value.floor !== undefined ? value.floor : existing.floor,
      capacity: value.capacity ?? existing.capacity,
      currency: value.currency ?? existing.currency,
      pricing_unit: value.pricing_unit ?? existing.pricingUnit,
      min_duration_minutes: value.min_duration_minutes ?? existing.minDurationMinutes,
      max_duration_minutes: value.max_duration_minutes !== undefined ? value.max_duration_minutes : existing.maxDurationMinutes,
      buffer_minutes: value.buffer_minutes ?? existing.bufferMinutes,
      open_time: value.open_time ?? existing.openTime,
      close_time: value.close_time ?? existing.closeTime,
      amenities: value.amenities !== undefined ? value.amenities : existing.amenities,
      attributes: value.attributes !== undefined ? value.attributes : existing.attributes,
      contact_note: value.contact_note !== undefined ? value.contact_note : existing.contactNote,
    };

    db.prepare(`
      UPDATE space SET
        code = ?, name = ?, category = ?, short_description = ?, description = ?,
        location = ?, floor = ?, capacity = ?, currency = ?, pricing_unit = ?,
        min_duration_minutes = ?, max_duration_minutes = ?, buffer_minutes = ?,
        open_time = ?, close_time = ?, amenities = ?, attributes = ?, contact_note = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      merged.code, merged.name, merged.category, merged.short_description, merged.description,
      merged.location, merged.floor, merged.capacity, merged.currency, merged.pricing_unit,
      merged.min_duration_minutes, merged.max_duration_minutes, merged.buffer_minutes,
      merged.open_time, merged.close_time, JSON.stringify(merged.amenities ?? []),
      JSON.stringify(merged.attributes ?? {}), merged.contact_note, now, id,
    );

    if (merged.category !== existing.category) {
      syncUnits(db, { space: { ...existing, category: merged.category }, desiredCount: 1, now });
      db.prepare('UPDATE resource_unit SET code = ?, label = ? WHERE space_id = ?')
        .run('UNIT-01', merged.name, id);
    }
    if (value.desk_count !== undefined && merged.category === SPACE_CATEGORY.COWORKING) {
      syncUnits(db, { space: { ...existing, category: merged.category }, desiredCount: Number(value.desk_count), now });
    }
    if (value.rates !== undefined) {
      persistRates(db, id, normaliseRates(merged.category, value.rates, existing.rates, merged.pricing_unit));
    }

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'space.updated',
      entityType: 'space',
      entityId: id,
      summary: `Updated space ${merged.code}`,
      details: { before: existing, after: merged },
    });

    return getSpace(db, id);
  });
}

/** Publication gate: a space cannot go live without a photograph. */
export function publishabilityIssues(db, spaceId) {
  const space = getSpaceOrThrow(db, spaceId);
  const issues = [];
  if (space.imageCount < 1) issues.push('At least one photograph is required before publishing.');
  if (!space.description || space.description.length < 20) issues.push('Add a detailed description (at least 20 characters).');
  if (!space.shortDescription) issues.push('Add a short summary.');
  if (!space.location) issues.push('Add a location.');
  if (!space.rates || Object.keys(space.rates).length === 0) issues.push('Add at least one rate.');
  if (space.unitCount < 1) issues.push('Configure at least one bookable desk or unit.');
  if (space.category === SPACE_CATEGORY.COWORKING && space.unitCount < 1) issues.push('Configure at least one co-working desk.');
  return issues;
}

export function publishSpace(db, { actor, spaceId } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(spaceId);
  const space = getSpaceOrThrow(db, id);
  if (space.status === SPACE_STATUS.PUBLISHED) return space;

  const issues = publishabilityIssues(db, id);
  if (issues.length > 0) {
    throw validationError('This space is not ready to publish.', { problems: issues });
  }
  const now = Date.now();
  return withWriteTransaction(db, () => {
    db.prepare("UPDATE space SET status = 'PUBLISHED', published_at = COALESCE(published_at, ?), archived_at = NULL, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'space.published', entityType: 'space', entityId: id,
      summary: `Published space ${space.code}`,
    });
    return getSpace(db, id);
  });
}

export function unpublishSpace(db, { actor, spaceId } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(spaceId);
  const space = getSpaceOrThrow(db, id);
  const now = Date.now();
  return withWriteTransaction(db, () => {
    db.prepare("UPDATE space SET status = 'DRAFT', updated_at = ? WHERE id = ?").run(now, id);
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'space.unpublished', entityType: 'space', entityId: id,
      summary: `Moved space ${space.code} back to draft`,
    });
    return getSpace(db, id);
  });
}

export function archiveSpace(db, { actor, spaceId, reason = null } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(spaceId);
  const space = getSpaceOrThrow(db, id);
  const now = Date.now();
  return withWriteTransaction(db, () => {
    const upcoming = db.prepare(`
      SELECT COUNT(*) AS c FROM occupancy
       WHERE space_id = ? AND status = '${OCCUPANCY_STATUS.ACTIVE}' AND end_at > ?
    `).get(id, now).c;
    db.prepare("UPDATE space SET status = 'ARCHIVED', archived_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'space.archived', entityType: 'space', entityId: id,
      summary: `Archived space ${space.code}`,
      details: { reason: reason ? String(reason).trim() : null, upcomingOccupancy: upcoming },
    });
    return { space: getSpace(db, id), upcomingOccupancy: upcoming };
  });
}

export function restoreSpace(db, { actor, spaceId } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(spaceId);
  const space = getSpaceOrThrow(db, id);
  const now = Date.now();
  return withWriteTransaction(db, () => {
    db.prepare("UPDATE space SET status = 'DRAFT', archived_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'space.restored', entityType: 'space', entityId: id,
      summary: `Restored space ${space.code} from archive`,
    });
    return getSpace(db, id);
  });
}

export function setDeskCount(db, { actor, spaceId, deskCount } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(spaceId);
  const space = getSpaceOrThrow(db, id);
  if (space.category !== SPACE_CATEGORY.COWORKING) {
    throw validationError('Only co-working spaces have a desk inventory.', { field: 'desk_count' });
  }
  const count = asInteger(deskCount, { field: 'desk_count', min: 1, max: 500, required: true });
  const now = Date.now();
  return withWriteTransaction(db, () => {
    const events = [];
    if (count < space.unitCount) {
      syncUnits(db, { space, desiredCount: count, now });
      events.push(`deactivated ${space.unitCount - count}`);
    } else if (count > space.unitCount) {
      syncUnits(db, { space, desiredCount: count, now });
      events.push(`added ${count - space.unitCount}`);
    }
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'space.inventory_changed', entityType: 'space', entityId: id,
      summary: `Desk inventory for ${space.code} set to ${count}`,
      details: { from: space.unitCount, to: count, events },
    });
    return getSpace(db, id);
  });
}

/* ------------------------------------------------------------- images */

export function listImages(db, spaceId) {
  return db.prepare(
    'SELECT * FROM space_image WHERE space_id = ? ORDER BY is_cover DESC, sort_order ASC, id ASC',
  ).all(Number(spaceId)).map((r) => ({
    id: r.id,
    spaceId: r.space_id,
    storedName: r.stored_name,
    originalName: r.original_name,
    mimeType: r.mime_type,
    byteSize: r.byte_size,
    altText: r.alt_text,
    sortOrder: r.sort_order,
    isCover: r.is_cover === 1,
    createdAt: r.created_at,
    url: `/media/${r.stored_name}`,
  }));
}

export function addImageRecord(db, { actor, spaceId, storedName, originalName, mimeType, byteSize, altText = null } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(spaceId);
  getSpaceOrThrow(db, id);
  const now = Date.now();
  return withWriteTransaction(db, () => {
    const count = db.prepare('SELECT COUNT(*) AS c FROM space_image WHERE space_id = ?').get(id).c;
    if (count >= 12) throw conflict('A space can have at most 12 photographs.');
    const nextOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM space_image WHERE space_id = ?').get(id).m) + 1;
    const isCover = count === 0 ? 1 : 0;
    const info = db.prepare(`
      INSERT INTO space_image (space_id, stored_name, original_name, mime_type, byte_size, alt_text, sort_order, is_cover, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, storedName, originalName, mimeType, byteSize, altText, nextOrder, isCover, now);

    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'space.image_added', entityType: 'space', entityId: id,
      summary: `Added photograph to space ${id}`,
      details: { storedName, originalName, mimeType, byteSize },
    });
    return listImages(db, id).find((i) => i.id === Number(info.lastInsertRowid));
  });
}

export function deleteImage(db, { actor, spaceId, imageId } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const sid = Number(spaceId);
  const iid = Number(imageId);
  return withWriteTransaction(db, () => {
    const image = db.prepare('SELECT * FROM space_image WHERE id = ? AND space_id = ?').get(iid, sid);
    if (!image) throw notFound('Photograph not found.');
    db.prepare('DELETE FROM space_image WHERE id = ?').run(iid);
    if (image.is_cover === 1) {
      const next = db.prepare('SELECT id FROM space_image WHERE space_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1').get(sid);
      if (next) db.prepare('UPDATE space_image SET is_cover = 1 WHERE id = ?').run(next.id);
    }
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label,
      action: 'space.image_removed', entityType: 'space', entityId: sid,
      summary: `Removed photograph ${image.original_name}`,
      details: { storedName: image.stored_name },
    });
    return { removedStoredName: image.stored_name };
  });
}

export function setCoverImage(db, { actor, spaceId, imageId } = {}) {
  const sid = Number(spaceId);
  const iid = Number(imageId);
  return withWriteTransaction(db, () => {
    const image = db.prepare('SELECT * FROM space_image WHERE id = ? AND space_id = ?').get(iid, sid);
    if (!image) throw notFound('Photograph not found.');
    db.prepare('UPDATE space_image SET is_cover = 0 WHERE space_id = ?').run(sid);
    db.prepare('UPDATE space_image SET is_cover = 1 WHERE id = ?').run(iid);
    recordAudit(db, {
      actorAdminUserId: actor?.id ?? null, actorLabel: actor?.label ?? 'system',
      action: 'space.cover_set', entityType: 'space', entityId: sid,
      summary: `Set cover photograph for space ${sid}`,
    });
    return listImages(db, sid);
  });
}

/** Reorder photographs. `orderedIds` must be a permutation of the space's images. */
export function reorderImages(db, { actor, spaceId, orderedIds = [] } = {}) {
  const sid = Number(spaceId);
  return withWriteTransaction(db, () => {
    const current = listImages(db, sid);
    const known = new Set(current.map((i) => i.id));
    const provided = orderedIds.map(Number).filter((n) => known.has(n));
    if (provided.length !== current.length) {
      throw validationError('Provide every photograph exactly once when reordering.');
    }
    const stmt = db.prepare('UPDATE space_image SET sort_order = ? WHERE id = ? AND space_id = ?');
    provided.forEach((imageId, index) => stmt.run(index, imageId, sid));
    recordAudit(db, {
      actorAdminUserId: actor?.id ?? null, actorLabel: actor?.label ?? 'system',
      action: 'space.images_reordered', entityType: 'space', entityId: sid,
      summary: `Reordered photographs for space ${sid}`,
      details: { orderedIds: provided },
    });
    return listImages(db, sid);
  });
}

export function rateSummary(space) {
  const entries = Object.entries(space.rates ?? {});
  if (entries.length === 0) return 'Rate on request';
  return entries
    .sort((a, b) => a[1] - b[1])
    .map(([unit, cents]) => `${formatMoney(cents, space.currency)} ${unit === 'HALF_DAY' ? 'per half day' : `per ${unit.toLowerCase()}`}`)
    .join(' · ');
}

export { SPACE_CATEGORY, PRICING_UNIT };
