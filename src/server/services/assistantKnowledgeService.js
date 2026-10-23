/**
 * Administrator-curated, public-safe Markdown used by Guider.
 *
 * The service never renders Markdown as HTML. Active documents are searched
 * locally and only short plain-text excerpts are returned to the model. This
 * keeps the provider context bounded and prevents inactive/internal entries
 * from leaking into public answers.
 */
import { withWriteTransaction } from '../db/connection.js';
import { isAdminRole } from '../domain/constants.js';
import { conflict, forbidden, notFound, validationError } from '../domain/errors.js';
import { recordAudit } from './auditService.js';

export const KNOWLEDGE_LIMITS = Object.freeze({
  title: 160,
  slug: 120,
  markdown: 100_000,
  searchQuery: 200,
  searchResults: 5,
  excerpt: 1800,
  totalExcerpt: 6000,
});

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'of', 'on', 'or', 'our', 'the', 'to',
  'what', 'when', 'where', 'which', 'with', 'you', 'your',
]);

function requireAdminActor(actor) {
  if (!actor?.id) throw validationError('An authenticated administrator is required.');
  if (!isAdminRole(actor.role)) throw forbidden('Only administrators can manage Guider knowledge.');
}

function integerId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw validationError('A valid knowledge entry id is required.');
  return id;
}

function cleanText(value, { field, max, required = true }) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (required && !text) throw validationError(`${field} is required.`, { [field]: `${field} is required.` });
  if (text.length > max) {
    throw validationError(`${field} must be at most ${max.toLocaleString('en')} characters.`, {
      [field]: `${field} must be at most ${max.toLocaleString('en')} characters.`,
    });
  }
  return text;
}

export function slugifyKnowledge(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, KNOWLEDGE_LIMITS.slug)
    .replace(/-+$/g, '');
  return slug || 'guide-note';
}

function parsePayload(payload = {}, existing = null) {
  const title = cleanText(payload.title ?? existing?.title, {
    field: 'title', max: KNOWLEDGE_LIMITS.title,
  });
  const suppliedSlug = payload.slug === undefined ? existing?.slug : payload.slug;
  const slug = slugifyKnowledge(cleanText(suppliedSlug || title, {
    field: 'slug', max: KNOWLEDGE_LIMITS.slug, required: false,
  }) || title);
  const markdown = cleanText(payload.markdown ?? existing?.markdown, {
    field: 'markdown', max: KNOWLEDGE_LIMITS.markdown,
  });
  const activeValue = payload.isActive ?? payload.is_active;
  const isActive = activeValue === undefined
    ? (existing?.isActive ?? true)
    : ['1', 'true', 'yes', 'on'].includes(String(activeValue).trim().toLowerCase());
  return { title, slug, markdown, isActive };
}

function isUniqueSlugError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (message.includes('unique') || error?.code === '23505')
    && (message.includes('assistant_knowledge') || message.includes('slug'));
}

export function hydrateAssistantKnowledge(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    slug: row.slug,
    markdown: row.markdown,
    isActive: Number(row.is_active) === 1,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    updatedBy: row.updated_by === null ? null : Number(row.updated_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function getAssistantKnowledge(db, id) {
  return hydrateAssistantKnowledge(
    db.prepare('SELECT * FROM assistant_knowledge WHERE id=?').get(integerId(id)),
  );
}

export function listAssistantKnowledge(db, { includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE is_active=1';
  return db.prepare(`SELECT * FROM assistant_knowledge ${where} ORDER BY updated_at DESC, id DESC`)
    .all()
    .map(hydrateAssistantKnowledge);
}

export function createAssistantKnowledge(db, { actor, payload, now = Date.now() } = {}) {
  requireAdminActor(actor);
  const value = parsePayload(payload);
  try {
    return withWriteTransaction(db, () => {
      const info = db.prepare(`INSERT INTO assistant_knowledge
        (title,slug,markdown,is_active,created_by,updated_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(value.title, value.slug, value.markdown, value.isActive ? 1 : 0, actor.id, actor.id, now, now);
      const id = Number(info.lastInsertRowid);
      recordAudit(db, {
        at: now,
        actorAdminUserId: actor.id,
        actorLabel: actor.label ?? actor.displayName ?? 'administrator',
        action: 'assistant_knowledge.created',
        entityType: 'assistant_knowledge',
        entityId: id,
        summary: `Created Guider knowledge: ${value.title}`,
        details: { slug: value.slug, isActive: value.isActive },
      });
      return getAssistantKnowledge(db, id);
    });
  } catch (error) {
    if (isUniqueSlugError(error)) throw conflict('Another Guider knowledge entry already uses that slug.');
    throw error;
  }
}

export function updateAssistantKnowledge(db, { actor, id, payload, now = Date.now() } = {}) {
  requireAdminActor(actor);
  const knowledgeId = integerId(id);
  const existing = getAssistantKnowledge(db, knowledgeId);
  if (!existing) throw notFound('Guider knowledge entry not found.');
  const value = parsePayload(payload, existing);
  try {
    return withWriteTransaction(db, () => {
      db.prepare(`UPDATE assistant_knowledge
        SET title=?,slug=?,markdown=?,is_active=?,updated_by=?,updated_at=? WHERE id=?`)
        .run(value.title, value.slug, value.markdown, value.isActive ? 1 : 0, actor.id, now, knowledgeId);
      recordAudit(db, {
        at: now,
        actorAdminUserId: actor.id,
        actorLabel: actor.label ?? actor.displayName ?? 'administrator',
        action: 'assistant_knowledge.updated',
        entityType: 'assistant_knowledge',
        entityId: knowledgeId,
        summary: `Updated Guider knowledge: ${value.title}`,
        details: { slug: value.slug, isActive: value.isActive },
      });
      return getAssistantKnowledge(db, knowledgeId);
    });
  } catch (error) {
    if (isUniqueSlugError(error)) throw conflict('Another Guider knowledge entry already uses that slug.');
    throw error;
  }
}

export function deleteAssistantKnowledge(db, { actor, id, now = Date.now() } = {}) {
  requireAdminActor(actor);
  const knowledgeId = integerId(id);
  const existing = getAssistantKnowledge(db, knowledgeId);
  if (!existing) throw notFound('Guider knowledge entry not found.');
  return withWriteTransaction(db, () => {
    recordAudit(db, {
      at: now,
      actorAdminUserId: actor.id,
      actorLabel: actor.label ?? actor.displayName ?? 'administrator',
      action: 'assistant_knowledge.deleted',
      entityType: 'assistant_knowledge',
      entityId: knowledgeId,
      summary: `Deleted Guider knowledge: ${existing.title}`,
      details: { slug: existing.slug },
    });
    db.prepare('DELETE FROM assistant_knowledge WHERE id=?').run(knowledgeId);
    return existing;
  });
}

function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*>+]\s+/gm, '')
    .replace(/[|*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryTerms(query) {
  return [...new Set(
    String(query).toLocaleLowerCase('en')
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 2 && !STOP_WORDS.has(term)) ?? [],
  )].slice(0, 20);
}

function countMatches(text, term) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(term, offset)) !== -1) {
    count += 1;
    offset += term.length;
  }
  return count;
}

/** Search only active/public documents and return bounded plain-text excerpts. */
export function searchAssistantKnowledge(db, query, { limit = 3 } = {}) {
  const cleanQuery = cleanText(query, {
    field: 'query', max: KNOWLEDGE_LIMITS.searchQuery,
  });
  const terms = queryTerms(cleanQuery);
  if (terms.length === 0) return [];
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 3, KNOWLEDGE_LIMITS.searchResults));
  const scored = listAssistantKnowledge(db, { includeInactive: false }).map((entry) => {
    const title = entry.title.toLocaleLowerCase('en');
    const body = plainText(entry.markdown);
    const lowerBody = body.toLocaleLowerCase('en');
    const exact = `${title} ${lowerBody}`.includes(cleanQuery.toLocaleLowerCase('en')) ? 25 : 0;
    const score = exact + terms.reduce(
      (sum, term) => sum + (countMatches(title, term) * 8) + Math.min(countMatches(lowerBody, term), 8),
      0,
    );
    return { entry, body, score };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);

  const results = [];
  let remaining = KNOWLEDGE_LIMITS.totalExcerpt;
  for (const item of scored.slice(0, cappedLimit)) {
    if (remaining <= 0) break;
    const max = Math.min(KNOWLEDGE_LIMITS.excerpt, remaining);
    const excerpt = item.body.length > max ? `${item.body.slice(0, Math.max(0, max - 1)).trimEnd()}…` : item.body;
    results.push({ title: item.entry.title, slug: item.entry.slug, excerpt });
    remaining -= excerpt.length;
  }
  return results;
}
