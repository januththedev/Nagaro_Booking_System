/**
 * Minimal HTTP request helpers. No third-party dependencies.
 */
import { validationError } from '../domain/errors.js';

export const DEFAULT_BODY_LIMIT = 1024 * 1024; // 1 MB for JSON/form bodies
export const UPLOAD_BODY_LIMIT = 12 * 1024 * 1024; // multipart with images

/** Read the raw request body with a hard size cap. */
export function readRawBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(validationError(`Request body exceeds the ${Math.round(limit / 1024)} KB limit.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(validationError('Request aborted.')));
  });
}

export function contentType(req) {
  return String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

export function isMultipart(req) {
  return contentType(req).startsWith('multipart/form-data');
}

/** Parse an application/x-www-form-urlencoded or application/json body. */
export async function parseRequestBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const type = contentType(req);
  if (type === 'application/json') {
    const raw = await readRawBody(req, { limit });
    if (raw.length === 0) return {};
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw validationError('The JSON body must be an object.');
      }
      return parsed;
    } catch (error) {
      if (error.code === 'VALIDATION_ERROR') throw error;
      throw validationError('The request body is not valid JSON.');
    }
  }
  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const raw = await readRawBody(req, { limit });
    const params = new URLSearchParams(raw.toString('utf8'));
    const out = {};
    for (const [key, value] of params) {
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
      } else {
        out[key] = value;
      }
    }
    return out;
  }
  if (isMultipart(req)) {
    return parseMultipartBody(req, { limit: UPLOAD_BODY_LIMIT });
  }
  throw validationError(`Unsupported content type: ${type || '(none)'}`);
}

/**
 * Multipart parsing uses the platform's own FormData implementation, so no
 * third-party parser is required and no unbounded memory growth is possible
 * (the body is size-capped by readRawBody).
 */
export async function parseMultipartBody(req, { limit = UPLOAD_BODY_LIMIT } = {}) {
  const raw = await readRawBody(req, { limit });
  const request = new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] ?? '' },
    body: raw,
  });
  let form;
  try {
    form = await request.formData();
  } catch {
    throw validationError('The form submission could not be read.');
  }
  const fields = {};
  const files = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        fields[key] = Array.isArray(fields[key]) ? [...fields[key], value] : [fields[key], value];
      } else {
        fields[key] = value;
      }
    } else {
      files.push({
        field: key,
        originalName: String(value.name ?? 'upload'),
        declaredType: String(value.type ?? ''),
        buffer: Buffer.from(await value.arrayBuffer()),
      });
    }
  }
  return { ...fields, __files: files };
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

export function parseQuery(url) {
  const out = {};
  for (const [key, value] of url.searchParams) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** First value of a possibly repeated query parameter. */
export function q(params, key, fallback = null) {
  const value = params[key];
  if (value === undefined || value === null) return fallback;
  return Array.isArray(value) ? (value[0] ?? fallback) : value;
}

export function clientIp(req) {
  // The app runs behind no trusted proxy by default, so the socket address is
  // authoritative. If a reverse proxy is added, configure TRUST_PROXY=1.
  if (process.env.NAGARO_TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function isSecureRequest(req) {
  if (process.env.NAGARO_FORCE_SECURE_COOKIES === '1') return true;
  return Boolean(req.socket?.encrypted);
}

export function isJsonRequest(req) {
  const accept = String(req.headers.accept ?? '');
  const type = contentType(req);
  if (type === 'application/json') return true;
  if (accept.includes('application/json') && !accept.includes('text/html')) return true;
  return false;
}
