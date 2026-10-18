/**
 * Tiny routing framework.
 *
 * Responsibilities kept deliberately small and explicit:
 *   - path patterns with `:param` segments
 *   - an ordered middleware chain (used for sessions, auth, CSRF, rate limits)
 *   - one error boundary that maps AppError to an HTTP status and never leaks
 *     stack traces or SQL text to the client
 */
import { parseQuery, parseRequestBody } from './request.js';
import { sendHtml, sendJson, sendText } from './response.js';
import { AppError } from '../domain/errors.js';
import { ERROR_CODE } from '../domain/constants.js';

const PARAM_PATTERN = /:([A-Za-z_][A-Za-z0-9_]*)/g;

function compilePattern(pattern) {
  const names = [];
  let regexSource = '^';
  let lastIndex = 0;
  pattern.replace(PARAM_PATTERN, (match, name, offset) => {
    regexSource += escapeRegex(pattern.slice(lastIndex, offset));
    regexSource += '([^/]+)';
    names.push(name);
    lastIndex = offset + match.length;
    return match;
  });
  regexSource += escapeRegex(pattern.slice(lastIndex));
  regexSource += '/?$';
  return { regex: new RegExp(regexSource), names };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Router {
  constructor() {
    this.routes = [];
    this.middleware = [];
    this.errorHandlers = [];
    this.notFoundHandler = null;
  }

  use(fn) {
    this.middleware.push(fn);
    return this;
  }

  onError(handler) {
    this.errorHandlers.push(handler);
    return this;
  }

  setNotFound(handler) {
    this.notFoundHandler = handler;
    return this;
  }

  add(method, pattern, handler, options = {}) {
    this.routes.push({ method, pattern, ...compilePattern(pattern), handler, options });
    return this;
  }

  get(pattern, handler, options) { return this.add('GET', pattern, handler, options); }
  post(pattern, handler, options) { return this.add('POST', pattern, handler, options); }
  put(pattern, handler, options) { return this.add('PUT', pattern, handler, options); }
  patch(pattern, handler, options) { return this.add('PATCH', pattern, handler, options); }
  delete(pattern, handler, options) { return this.add('DELETE', pattern, handler, options); }

  match(method, pathname) {
    const pathMatches = [];
    for (const route of this.routes) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      pathMatches.push({ route, match });
    }
    for (const { route, match } of pathMatches) {
      if (route.method !== method) continue;
      const params = {};
      route.names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); });
      return { route, params };
    }
    // Method mismatch on an existing path -> 405
    if (pathMatches.length > 0) {
      const allowed = [...new Set(pathMatches.map((m) => m.route.method))];
      return { methodNotAllowed: allowed };
    }
    return null;
  }

  createContext(req, res, { route, params, pathname }) {
    const url = new URL(`http://local${pathname}${rawQueryOf(req)}`);
    const ctx = {
      req,
      res,
      route,
      params,
      url,
      method: req.method,
      query: parseQuery(url),
      state: {},
      session: null,
      actor: null,
      flash: null,
      body: {},
      status: 200,
      headers: {},
      responded: false,
      wantsJson: false,
    };

    ctx.set = (key, value) => { ctx.state[key] = value; };
    ctx.setStatus = (status) => { ctx.status = status; return ctx; };
    ctx.setHeader = (name, value) => { ctx.headers[name] = value; return ctx; };

    ctx.readBody = async (options) => {
      ctx.body = await parseRequestBody(req, options);
      return ctx.body;
    };

    ctx.json = (payload, status = ctx.status) => {
      ctx.responded = true;
      sendJson(res, status, payload, ctx.headers);
    };
    ctx.html = (markup, status = ctx.status) => {
      ctx.responded = true;
      sendHtml(res, status, markup, ctx.headers);
    };
    ctx.text = (text, status = ctx.status) => {
      ctx.responded = true;
      sendText(res, status, text, ctx.headers);
    };
    return ctx;
  }

  async handle(req, res) {
    const pathname = normalisePath(req.url);
    if (pathname === null) {
      sendText(res, 400, 'Bad request');
      return;
    }

    // Run the middleware chain FIRST so request-wide handlers (static assets,
    // session resolution, flash) can short-circuit before route matching.
    const ctx = this.createContext(req, res, { route: null, params: {}, pathname });
    try {
      for (const mw of this.middleware) {
        const result = await mw(ctx);
        if (ctx.responded) return;
        if (result === false) return;
      }
    } catch (error) {
      await this.dispatchError(ctx, error);
      return;
    }
    if (ctx.responded) return;

    const matched = this.match(req.method, pathname);
    if (!matched) {
      if (this.notFoundHandler) {
        try { await this.notFoundHandler(ctx); } catch { sendText(res, 500, 'Internal error'); }
        return;
      }
      sendText(res, 404, 'Not found');
      return;
    }
    if (matched.methodNotAllowed) {
      sendText(res, 405, 'Method not allowed', { Allow: matched.methodNotAllowed.join(', ') });
      return;
    }

    ctx.route = matched.route;
    ctx.params = matched.params;
    try {
      await matched.route.handler(ctx);
    } catch (error) {
      await this.dispatchError(ctx, error);
      return;
    }
    if (!ctx.responded) {
      // A handler may have replied directly through the response helpers
      // (`redirect`, `sendFileStream`, ...) without going through ctx.
      if (isHeaderSent(res) || res.writableEnded) return;
      ctx.json({ ok: true });
    }
  }

  async dispatchError(ctx, error) {
    for (const handler of this.errorHandlers) {
      try {
        await handler(ctx, error);
        if (ctx.responded) return;
      } catch { /* fall through to the default handler */ }
    }
    if (isHeaderSent(ctx.res)) {
      try { ctx.res.destroy(); } catch { /* ignore */ }
      return;
    }
    const { status, code, message, details } = normaliseError(error);
    if (ctx.wantsJson || isApiPath(ctx.url?.pathname) || isJsonBody(ctx.req)) {
      sendJson(ctx.res, status, { ok: false, error: { code, message, details } });
    } else {
      sendText(ctx.res, status, `${status} ${message}`);
    }
  }
}

/** A JSON request expects a JSON error even on a non-/api path. */
function isJsonBody(req) {
  const type = String(req?.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') return true;
  const accept = String(req?.headers?.accept ?? '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

function isHeaderSent(res) {
  return res.headersSent || res.writableEnded;
}

function isApiPath(pathname) {
  return typeof pathname === 'string' && pathname.startsWith('/api/');
}

/**
 * Extract a normalised pathname from the raw request target.
 *
 * `new URL('//spaces', base)` would be read as a protocol-relative URL whose
 * *authority* is `spaces`, silently turning the path into `/`. Splitting the
 * target by hand avoids that whole class of confusion.
 * Returns null when the target cannot be interpreted.
 */
export function normalisePath(rawTarget) {
  const raw = typeof rawTarget === 'string' && rawTarget.length > 0 ? rawTarget : '/';
  const hashIndex = raw.indexOf('#');
  const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  const rawPath = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  if (rawPath.includes('\0')) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null; // malformed percent-encoding
  }

  let pathname = decoded.replace(/\/{2,}/g, '/');
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  return pathname;
}

/** The raw `?query` portion of the request target, including the leading `?`. */
export function rawQueryOf(req) {
  const raw = typeof req?.url === 'string' ? req.url : '/';
  const hashIndex = raw.indexOf('#');
  const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  return queryIndex === -1 ? '' : withoutHash.slice(queryIndex);
}

/**
 * Map any thrown value to a safe client-facing shape.
 * Internal errors are logged server-side in full and reported generically.
 */
export function normaliseError(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    };
  }
  if (error && error.code === 'VALIDATION_ERROR') {
    return { status: 422, code: ERROR_CODE.VALIDATION, message: error.message, details: error.details ?? null };
  }
  const isRequestError = error instanceof SyntaxError || error?.type === 'request.aborted';
  if (isRequestError) {
    return { status: 400, code: ERROR_CODE.VALIDATION, message: 'The request could not be processed.', details: null };
  }
  console.error('[unhandled]', error);
  return {
    status: 500,
    code: ERROR_CODE.INTERNAL,
    message: 'Something went wrong on our side. The operation was not completed.',
    details: null,
  };
}

export function createRouter() {
  return new Router();
}

export { compilePattern };
