/**
 * HTTP response helpers plus the application's default security headers.
 */
import { createReadStream, statSync } from 'node:fs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeForExtension(ext) {
  return MIME_TYPES[String(ext).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Security headers applied to every response.
 * `media` is only used for user-uploaded photographs, which get a stricter
 * policy than HTML pages.
 */
export function applySecurityHeaders(res, { isHtml = false, isMedia = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isMedia) {
    // Uploaded files are inert: never treat them as a document.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  } else if (isHtml) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
  }
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8');
  applySecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendHtml(res, status, html, headers = {}) {
  const body = Buffer.from(String(html), 'utf8');
  applySecurityHeaders(res, { isHtml: true });
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(String(text), 'utf8');
  applySecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  res.end(body);
}

export function sendBuffer(res, status, buffer, { contentType = 'application/octet-stream', headers = {}, isMedia = false, cacheSeconds = 0 } = {}) {
  applySecurityHeaders(res, { isMedia });
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}, immutable` : 'no-store',
    ...headers,
  });
  res.end(buffer);
}

export function sendFileStream(res, status, absolutePath, { contentType, cacheSeconds = 0, isMedia = false, headers = {} } = {}) {
  let stat;
  try {
    stat = statSync(absolutePath);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'Not found');
  applySecurityHeaders(res, { isMedia });
  res.writeHead(status, {
    'Content-Type': contentType ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}, immutable` : 'no-store',
    ...headers,
  });
  const stream = createReadStream(absolutePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return undefined;
}

export function redirect(res, location, status = 303, headers = {}) {
  applySecurityHeaders(res);
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

export function sendNoContent(res, headers = {}) {
  applySecurityHeaders(res);
  res.writeHead(204, { 'Cache-Control': 'no-store', ...headers });
  res.end();
}

/** Append a Set-Cookie header without clobbering previously set cookies. */
export function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', [cookie]);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie]);
  else res.setHeader('Set-Cookie', [existing, cookie]);
}

export function serializeCookie(name, value, {
  maxAgeSeconds = null, path = '/', httpOnly = true, secure = false, sameSite = 'Lax',
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (maxAgeSeconds !== null) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

export { MIME_TYPES };
