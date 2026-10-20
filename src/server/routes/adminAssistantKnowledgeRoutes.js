import { AppError, notFound, validationError } from '../domain/errors.js';
import { redirect } from '../http/response.js';
import { requireAdmin, requireCsrf } from '../security/sessions.js';
import { enforceAdminMutationLimit } from '../security/rateLimit.js';
import {
  KNOWLEDGE_LIMITS,
  createAssistantKnowledge,
  deleteAssistantKnowledge,
  getAssistantKnowledge,
  listAssistantKnowledge,
  updateAssistantKnowledge,
} from '../services/assistantKnowledgeService.js';
import {
  renderAssistantKnowledgeFormPage,
  renderAssistantKnowledgeListPage,
} from '../../web/views/admin/assistantKnowledgeViews.js';

const ALLOWED_FILE_TYPES = new Set(['', 'text/plain', 'text/markdown', 'application/octet-stream']);

export function registerAdminAssistantKnowledgeRoutes(router, deps = {}) {
  const { db } = deps;
  const setFlash = deps.setFlash;

  router.get('/admin/guider-knowledge', async (ctx) => {
    const actor = requireAdmin(ctx);
    ctx.html(renderAssistantKnowledgeListPage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      entries: listAssistantKnowledge(db),
    }));
  });

  router.get('/admin/guider-knowledge/new', async (ctx) => {
    const actor = requireAdmin(ctx);
    ctx.html(renderAssistantKnowledgeFormPage({
      actor, csrfToken: ctx.csrfToken, flash: ctx.flash, mode: 'create', values: {},
    }));
  });

  router.post('/admin/guider-knowledge', async (ctx) => {
    const actor = requireAdmin(ctx);
    const body = await ctx.readBody();
    requireCsrf(ctx);
    enforceAdminMutationLimit(db, { actorId: actor.id });
    let payload;
    try {
      payload = payloadFromBody(body);
      const created = createAssistantKnowledge(db, { actor, payload });
      setFlash?.(ctx, { kind: 'success', message: `Added “${created.title}” to Guider knowledge.` });
      return redirectTo(ctx, '/admin/guider-knowledge');
    } catch (error) {
      if (!(error instanceof AppError) || ![409, 422].includes(error.status)) throw error;
      ctx.html(renderAssistantKnowledgeFormPage({
        actor,
        csrfToken: ctx.csrfToken,
        flash: ctx.flash,
        mode: 'create',
        values: valuesForRerender(body, payload),
        error: error.message,
      }), error.status);
    }
  });

  router.get('/admin/guider-knowledge/:id/edit', async (ctx) => {
    const actor = requireAdmin(ctx);
    const entry = getAssistantKnowledge(db, ctx.params.id);
    if (!entry) throw notFound('Guider knowledge entry not found.');
    ctx.html(renderAssistantKnowledgeFormPage({
      actor, csrfToken: ctx.csrfToken, flash: ctx.flash, mode: 'edit', entry,
    }));
  });

  router.post('/admin/guider-knowledge/:id', async (ctx) => {
    const actor = requireAdmin(ctx);
    const body = await ctx.readBody();
    requireCsrf(ctx);
    enforceAdminMutationLimit(db, { actorId: actor.id });
    const entry = getAssistantKnowledge(db, ctx.params.id);
    if (!entry) throw notFound('Guider knowledge entry not found.');
    let payload;
    try {
      payload = payloadFromBody(body);
      const updated = updateAssistantKnowledge(db, { actor, id: entry.id, payload });
      setFlash?.(ctx, { kind: 'success', message: `Updated “${updated.title}”.` });
      return redirectTo(ctx, '/admin/guider-knowledge');
    } catch (error) {
      if (!(error instanceof AppError) || ![409, 422].includes(error.status)) throw error;
      ctx.html(renderAssistantKnowledgeFormPage({
        actor,
        csrfToken: ctx.csrfToken,
        flash: ctx.flash,
        mode: 'edit',
        entry,
        values: valuesForRerender(body, payload),
        error: error.message,
      }), error.status);
    }
  });

  router.post('/admin/guider-knowledge/:id/delete', async (ctx) => {
    const actor = requireAdmin(ctx);
    await ctx.readBody();
    requireCsrf(ctx);
    enforceAdminMutationLimit(db, { actorId: actor.id });
    const deleted = deleteAssistantKnowledge(db, { actor, id: ctx.params.id });
    setFlash?.(ctx, { kind: 'success', message: `Deleted “${deleted.title}” from Guider knowledge.` });
    return redirectTo(ctx, '/admin/guider-knowledge');
  });
}

function payloadFromBody(body = {}) {
  const upload = readMarkdownUpload(body.__files);
  return {
    title: first(body.title),
    slug: first(body.slug),
    markdown: upload ?? first(body.markdown),
    is_active: first(body.is_active),
  };
}

function readMarkdownUpload(files) {
  const selected = (Array.isArray(files) ? files : [])
    .filter((file) => file?.field === 'knowledge_file' && file.buffer?.length > 0);
  if (selected.length === 0) return null;
  if (selected.length > 1) throw validationError('Upload one Markdown file at a time.');
  const file = selected[0];
  const name = String(file.originalName ?? '');
  const type = String(file.declaredType ?? '').toLowerCase();
  if (!/\.(md|markdown)$/i.test(name) || !ALLOWED_FILE_TYPES.has(type)) {
    throw validationError('Upload a .md or .markdown text file.');
  }
  if (file.buffer.length > KNOWLEDGE_LIMITS.markdown * 4) {
    throw validationError('The Markdown upload is too large. Keep it below 400 KB.');
  }
  const markdown = file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (markdown.includes('\uFFFD')) throw validationError('The Markdown file must use UTF-8 text encoding.');
  if (markdown.length > KNOWLEDGE_LIMITS.markdown) {
    throw validationError(`Markdown must be at most ${KNOWLEDGE_LIMITS.markdown.toLocaleString('en')} characters.`);
  }
  return markdown;
}

function valuesForRerender(body, payload) {
  return {
    title: first(body?.title),
    slug: first(body?.slug),
    markdown: payload?.markdown ?? first(body?.markdown),
    is_active: first(body?.is_active),
  };
}

function first(value) {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function redirectTo(ctx, location) {
  redirect(ctx.res, location);
  ctx.responded = true;
}
