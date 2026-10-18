/**
 * Admin photograph routes: upload, cover selection, removal and reordering.
 *
 * All four routes are POST-only and must run `requireAuth` + `requireCsrf` in
 * the handler body (this router has no per-route middleware). Uploads are the
 * only place a client can push binary data into the system, so the upload
 * handler funnels every file through `ingestUploadFiles`, which decides the
 * type from magic bytes and writes to a random stored name. A database insert
 * that fails removes the file it just wrote, so a rejection can never leave an
 * orphaned object behind.
 *
 * Responses follow the app-wide pattern: set a `nagaro_flash` cookie and send
 * a 303 redirect.
 */
import { AppError, notFound } from '../domain/errors.js';
import { LIMITS } from '../domain/validation.js';
import { FLASH_COOKIE, requireAuth, requireCsrf } from '../security/sessions.js';
import { ingestUploadFiles, removeStoredImage } from '../security/uploads.js';
import { appendCookie, redirect, serializeCookie } from '../http/response.js';
import { isSecureRequest } from '../http/request.js';
import {
  addImageRecord, deleteImage, getSpace, reorderImages, setCoverImage,
} from '../services/spaceService.js';

const FLASH_KINDS = new Set(['success', 'error', 'warning']);
const FLASH_MAX_AGE_SECONDS = 30;
const FLASH_MESSAGE_MAX = 600;
const FLASH_PROBLEM_MAX = 300;
const FLASH_PROBLEM_COUNT = 20;

/**
 * Write the application flash cookie and mark the request as answered.
 *
 * NOTE: `src/server/app.js` may also expose a `setFlash(ctx, flash)` helper.
 * This local implementation mirrors the app-wide cookie contract
 * (`nagaro_flash`, URL-encoded JSON `{ kind, message, problems? }`, `Path=/`,
 * `HttpOnly`, `SameSite=Lax`, `Max-Age=30`) so this module has no import cycle
 * with the application assembler. It should be unified with the app helper
 * once that module is wired.
 */
export function setFlash(ctx, flash) {
  const payload = {
    kind: FLASH_KINDS.has(flash?.kind) ? flash.kind : 'success',
    message: String(flash?.message ?? '').slice(0, FLASH_MESSAGE_MAX),
  };
  if (Array.isArray(flash?.problems)) {
    const problems = flash.problems
      .map((problem) => String(problem ?? '').trim().slice(0, FLASH_PROBLEM_MAX))
      .filter((problem) => problem !== '')
      .slice(0, FLASH_PROBLEM_COUNT);
    if (problems.length > 0) payload.problems = problems;
  }
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, JSON.stringify(payload), {
    maxAgeSeconds: FLASH_MAX_AGE_SECONDS,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(ctx.req),
  }));
}

export function registerAdminUploadRoutes(router, deps = {}) {
  const db = deps.db;

  const uploadImages = async (ctx) => {
    checkAuth(ctx, deps);
    const body = await ctx.readBody(); // multipart; needed before CSRF reads `_csrf`
    checkCsrf(ctx, deps);

    const spaceId = parseId(ctx.params.id);
    const space = spaceId === null ? null : getSpace(db, spaceId);
    if (!space) throw notFound('Space not found.');
    const target = `/admin/spaces/${space.id}`;

    const files = Array.isArray(body?.__files) ? body.__files : [];
    if (files.length === 0) {
      flashRedirect(ctx, deps, target, {
        kind: 'error',
        message: 'Choose at least one photograph to upload.',
      });
      return;
    }

    const { accepted, rejected } = await ingestUploadFiles(files, {
      maxFiles: LIMITS.maxImagesPerSpace,
    });
    const problems = rejected.map((entry) => problem(entry.originalName, entry.reason));
    const altText = readAltText(body);

    // Insert records only for files that were actually written, and delete any
    // file whose record did not make it into the database.
    const insertedNames = new Set();
    try {
      for (const file of accepted) {
        try {
          addImageRecord(db, {
            actor: ctx.actor,
            spaceId: space.id,
            storedName: file.storedName,
            originalName: file.originalName,
            mimeType: file.mimeType,
            byteSize: file.byteSize,
            altText,
          });
          insertedNames.add(file.storedName);
        } catch (error) {
          if (error instanceof AppError) {
            problems.push(problem(file.originalName, error.message));
          } else {
            throw error;
          }
        }
      }
    } finally {
      for (const file of accepted) {
        if (!insertedNames.has(file.storedName)) removeStoredImage(file.storedName);
      }
    }

    const added = insertedNames.size;
    if (added === 0) {
      flashRedirect(ctx, deps, target, {
        kind: 'error',
        message: 'No photographs were added.',
        problems,
      });
      return;
    }
    if (problems.length > 0) {
      flashRedirect(ctx, deps, target, {
        kind: 'warning',
        message: `Added ${added} of ${accepted.length} photographs to ${space.name}.`,
        problems,
      });
      return;
    }
    flashRedirect(ctx, deps, target, {
      kind: 'success',
      message: `Added ${added} photograph${added === 1 ? '' : 's'} to ${space.name}.`,
    });
  };

  const makeCover = async (ctx) => {
    checkAuth(ctx, deps);
    await ctx.readBody();
    checkCsrf(ctx, deps);

    const spaceId = parseId(ctx.params.id);
    const imageId = parseId(ctx.params.imageId);
    if (spaceId === null) throw notFound('Space not found.');
    if (imageId === null) throw notFound('Photograph not found.');
    const target = `/admin/spaces/${spaceId}`;

    try {
      setCoverImage(db, { actor: ctx.actor, spaceId, imageId });
      flashRedirect(ctx, deps, target, { kind: 'success', message: 'Cover photograph updated.' });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flashRedirect(ctx, deps, target, { kind: 'error', message: error.message });
    }
  };

  const deleteImageHandler = async (ctx) => {
    checkAuth(ctx, deps);
    await ctx.readBody();
    checkCsrf(ctx, deps);

    const spaceId = parseId(ctx.params.id);
    const imageId = parseId(ctx.params.imageId);
    if (spaceId === null) throw notFound('Space not found.');
    if (imageId === null) throw notFound('Photograph not found.');
    const target = `/admin/spaces/${spaceId}`;

    try {
      const { removedStoredName } = deleteImage(db, { actor: ctx.actor, spaceId, imageId });
      removeStoredImage(removedStoredName); // best effort: the row is already gone
      flashRedirect(ctx, deps, target, { kind: 'success', message: 'Photograph removed.' });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flashRedirect(ctx, deps, target, { kind: 'error', message: error.message });
    }
  };

  const reorderImagesHandler = async (ctx) => {
    checkAuth(ctx, deps);
    const body = await ctx.readBody();
    checkCsrf(ctx, deps);

    const spaceId = parseId(ctx.params.id);
    if (spaceId === null) throw notFound('Space not found.');
    const target = `/admin/spaces/${spaceId}`;

    const orderedIds = parseOrderedIds(body);
    if (orderedIds.length === 0) {
      flashRedirect(ctx, deps, target, {
        kind: 'error',
        message: 'No photograph order was provided.',
      });
      return;
    }

    try {
      reorderImages(db, { actor: ctx.actor, spaceId, orderedIds });
      flashRedirect(ctx, deps, target, { kind: 'success', message: 'Photograph order updated.' });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flashRedirect(ctx, deps, target, { kind: 'error', message: error.message });
    }
  };

  router.post('/admin/spaces/:id/images', uploadImages);
  router.post('/admin/spaces/:id/images/reorder', reorderImagesHandler);
  router.post('/admin/spaces/:id/images/:imageId/cover', makeCover);
  router.post('/admin/spaces/:id/images/:imageId/delete', deleteImageHandler);
}

/* ------------------------------------------------------------------ helpers */

function checkAuth(ctx, deps) {
  const guard = typeof deps.requireAuth === 'function' ? deps.requireAuth : requireAuth;
  return guard(ctx);
}

function checkCsrf(ctx, deps) {
  const guard = typeof deps.requireCsrf === 'function' ? deps.requireCsrf : requireCsrf;
  return guard(ctx);
}

function flashRedirect(ctx, deps, location, flash) {
  const appSetFlash = ctx?.app?.setFlash;
  if (typeof appSetFlash === 'function' && appSetFlash !== setFlash) {
    appSetFlash(ctx, flash);
  } else if (typeof deps.setFlash === 'function' && deps.setFlash !== setFlash) {
    deps.setFlash(ctx, flash);
  } else {
    setFlash(ctx, flash);
  }
  redirect(ctx.res, location, 303);
  ctx.responded = true;
}

function parseId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseOrderedIds(body) {
  const raw = body?.orderedIds ?? body?.ordered_ids ?? body?.ids;
  const values = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const value of values) {
    for (const part of String(value ?? '').split(',')) {
      const text = part.trim();
      if (!/^\d+$/.test(text)) continue;
      const parsed = Number(text);
      if (Number.isSafeInteger(parsed) && parsed > 0 && !out.includes(parsed)) out.push(parsed);
    }
  }
  return out;
}

function readAltText(body) {
  const raw = body?.alt_text ?? body?.altText ?? body?.alt;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text === '' ? null : text.slice(0, 300);
}

function problem(originalName, reason) {
  const name = String(originalName ?? 'upload');
  const text = String(reason ?? 'The file could not be stored.');
  return `${name}: ${text}`;
}
