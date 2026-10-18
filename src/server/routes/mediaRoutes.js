/**
 * Public media route.
 *
 * `GET|HEAD /media/:storedName` serves a photograph. It is deliberately
 * unauthenticated - published space photographs are public - and is built to
 * reveal nothing except the bytes of a valid stored image:
 *
 *   - the name must match `^[a-f0-9]{32}\.(jpg|png|webp)$` before any
 *     filesystem call happens; anything else gets a plain 404;
 *   - the resolved path is re-proved to be inside the upload directory;
 *   - the Content-Type comes from the stored extension, never from the
 *     request or the original filename;
 *   - responses are inert: `nosniff`, sandboxing CSP and CORP are applied by
 *     `sendFileStream(..., { isMedia: true })`;
 *   - nothing about the storage directory, the original filename or a stack
 *     trace is ever written to the response.
 */
import { lstatSync } from 'node:fs';
import { applySecurityHeaders, sendFileStream, sendText } from '../http/response.js';
import { isSafeStoredName, mimeForStoredName, storedPathFor } from '../security/uploads.js';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export function registerMediaRoutes(router, { db } = {}) {
  // Space photographs are public and read straight from disk; the database is
  // intentionally not consulted here (and the parameter is kept for a uniform
  // `register*Routes(router, deps)` signature).
  void db;

  const handler = (ctx) => serveStoredImage(ctx);
  router.get('/media/:storedName', handler);
  // HEAD must behave identically but send no body. Node also suppresses the
  // body for HEAD, but the explicit branch below avoids opening the file.
  router.add('HEAD', '/media/:storedName', handler);
}

function serveStoredImage(ctx) {
  const storedName = ctx.params?.storedName;
  if (!isSafeStoredName(storedName)) {
    respondNotFound(ctx);
    return;
  }

  let absolutePath;
  try {
    absolutePath = storedPathFor(storedName);
  } catch {
    // Any containment failure is indistinguishable from "no such file".
    respondNotFound(ctx);
    return;
  }

  let stat;
  try {
    // lstat, not stat: a symlink is not a stored photograph and must not be
    // followed out of the upload directory.
    stat = lstatSync(absolutePath);
  } catch {
    respondNotFound(ctx);
    return;
  }
  if (!stat.isFile()) {
    respondNotFound(ctx);
    return;
  }

  const contentType = mimeForStoredName(storedName);
  const etag = `"${storedName}"`;
  const cacheHeaders = { 'Cache-Control': IMMUTABLE_CACHE };

  if (ifNoneMatchHits(ctx.req.headers['if-none-match'], etag)) {
    applySecurityHeaders(ctx.res, { isMedia: true });
    ctx.res.writeHead(304, { ETag: etag, ...cacheHeaders });
    ctx.res.end();
    ctx.responded = true;
    return;
  }

  if (ctx.method === 'HEAD') {
    applySecurityHeaders(ctx.res, { isMedia: true });
    ctx.res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      ETag: etag,
      ...cacheHeaders,
    });
    ctx.res.end();
    ctx.responded = true;
    return;
  }

  sendFileStream(ctx.res, 200, absolutePath, {
    contentType,
    cacheSeconds: 31536000,
    isMedia: true,
    headers: { ETag: etag },
  });
  // `sendFileStream` writes headers synchronously (or a plain 404 when the
  // file vanished); mark the context so the router does not append a JSON body.
  ctx.responded = true;
}

function respondNotFound(ctx) {
  // Constant, path-free body. Static photographs have no directory listing and
  // a missing/invalid name is indistinguishable from any other invalid name.
  try {
    sendText(ctx.res, 404, 'Not found', { 'Cache-Control': 'no-store' });
  } catch {
    try { ctx.res.destroy(); } catch { /* already gone */ }
  }
  ctx.responded = true;
}

/** Weak comparison as required by RFC 9110 for If-None-Match. */
function ifNoneMatchHits(headerValue, etag) {
  if (!headerValue) return false;
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : String(headerValue);
  return raw.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value === etag || value === `W/${etag}`;
  });
}
