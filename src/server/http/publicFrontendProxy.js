/**
 * Same-origin public frontend gateway.
 *
 * The Node booking application remains the only public listener. When the
 * rollout flag is enabled, public page requests are streamed to the internal
 * Next.js process while API, admin and media requests stay in this process.
 * Keeping this boundary here (rather than in page code) makes the legacy
 * renderer an instant, configuration-only rollback.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const DEFAULT_ORIGIN = 'http://127.0.0.1:4174';
const BACKEND_PREFIXES = Object.freeze(['/api', '/admin', '/assets', '/media']);
/**
 * Form posts the Node runtime owns even though the matching GET page is
 * rendered by the Next frontend. They are the no-JavaScript fallback for the
 * capability-token and booking forms, so they must never be proxied away from
 * the process that owns the session cookie, CSRF secret and booking service.
 */
const BACKEND_FORM_POSTS = Object.freeze([
  '/book',
  '/book/cancel',
  '/booking-request',
  '/booking-request/withdraw',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function pathMatchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isBackendOwnedPath(pathname, method = 'GET') {
  if (BACKEND_PREFIXES.some((prefix) => pathMatchesPrefix(pathname, prefix))) return true;
  return String(method ?? 'GET').toUpperCase() === 'POST'
    && (BACKEND_FORM_POSTS.some((path) => pathname === path)
      || /^\/spaces\/[^/]+\/book$/.test(pathname));
}

export function loadPublicFrontendProxyConfig(env = process.env) {
  const mode = String(env.PUBLIC_FRONTEND ?? 'legacy').trim().toLowerCase();
  if (!['legacy', 'next'].includes(mode)) {
    throw new Error('PUBLIC_FRONTEND must be either "legacy" or "next".');
  }

  let origin;
  try {
    origin = new URL(env.PUBLIC_FRONTEND_ORIGIN ?? DEFAULT_ORIGIN);
  } catch {
    throw new Error('PUBLIC_FRONTEND_ORIGIN must be a valid absolute HTTP URL.');
  }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error('PUBLIC_FRONTEND_ORIGIN must be an HTTP(S) origin without credentials.');
  }
  if (origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_FRONTEND_ORIGIN must not include a path, query string or fragment.');
  }

  return Object.freeze({ mode, origin });
}

export function assertPublicFrontendIsNotListener(proxyConfig, listener) {
  if (proxyConfig.mode !== 'next') return;
  const targetPort = Number(proxyConfig.origin.port || (proxyConfig.origin.protocol === 'https:' ? 443 : 80));
  const listenerPort = Number(listener?.port);
  if (!Number.isFinite(listenerPort) || targetPort !== listenerPort) return;

  const host = String(listener?.host ?? '').toLowerCase();
  const targetHost = proxyConfig.origin.hostname.toLowerCase();
  const localNames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '::']);
  if (targetHost === host || (localNames.has(targetHost) && localNames.has(host))) {
    throw new Error('PUBLIC_FRONTEND_ORIGIN points at the Node listener and would create a proxy loop.');
  }
}

function requestPath(req) {
  try {
    return new URL(req.url ?? '/', 'http://gateway.invalid').pathname;
  } catch {
    return '/';
  }
}

function forwardedProtocol(req) {
  const supplied = req.headers['x-forwarded-proto'];
  if (typeof supplied === 'string' && supplied) return supplied.split(',')[0].trim();
  return req.socket?.encrypted ? 'https' : 'http';
}

function forwardedPort(req, protocol) {
  const supplied = req.headers['x-forwarded-port'];
  if (typeof supplied === 'string' && supplied) return supplied.split(',')[0].trim();
  const host = String(req.headers.host ?? '');
  const match = host.match(/:(\d+)$/);
  return match?.[1] ?? (protocol === 'https' ? '443' : '80');
}

function upstreamHeaders(req, { preserveUpgrade = false } = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!preserveUpgrade && HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (value !== undefined) headers[name] = value;
  }

  const protocol = forwardedProtocol(req);
  const remoteAddress = req.socket?.remoteAddress;
  const previousFor = req.headers['x-forwarded-for'];
  headers['x-forwarded-proto'] = protocol;
  headers['x-forwarded-port'] = forwardedPort(req, protocol);
  headers['x-forwarded-host'] = req.headers.host ?? '';
  if (remoteAddress) {
    headers['x-forwarded-for'] = previousFor ? `${previousFor}, ${remoteAddress}` : remoteAddress;
  }
  return headers;
}

function downstreamHeaders(headers, targetOrigin, req) {
  const filtered = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) filtered[name] = value;
  }

  const location = filtered.location;
  if (typeof location === 'string' && location.startsWith(targetOrigin.origin)) {
    const protocol = forwardedProtocol(req);
    const host = req.headers.host;
    if (host) filtered.location = `${protocol}://${host}${location.slice(targetOrigin.origin.length)}`;
  }
  return filtered;
}

function sendUnavailable(res) {
  if (res.headersSent || res.writableEnded) {
    try { res.destroy(); } catch { /* connection already closed */ }
    return;
  }
  res.writeHead(502, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Retry-After': '1',
  });
  res.end('The public experience is temporarily unavailable. Please retry in a moment.');
}

function streamHttpRequest(req, res, origin) {
  return new Promise((resolve) => {
    const transport = origin.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = transport({
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port || undefined,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req),
    }, (upstreamResponse) => {
      if (res.writableEnded) {
        upstreamResponse.destroy();
        resolve();
        return;
      }
      res.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        downstreamHeaders(upstreamResponse.headers, origin, req),
      );
      upstreamResponse.pipe(res);
      upstreamResponse.once('end', resolve);
      upstreamResponse.once('error', () => {
        sendUnavailable(res);
        resolve();
      });
    });

    upstream.once('error', () => {
      sendUnavailable(res);
      resolve();
    });
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  });
}

function writeUpgradeRequest(upstream, req, head) {
  const headers = upstreamHeaders(req, { preserveUpgrade: true });
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else if (value !== undefined) {
      lines.push(`${name}: ${value}`);
    }
  }
  upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (head?.length) upstream.write(head);
}

function proxyUpgrade(req, socket, head, origin) {
  const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
  const onConnect = function onConnect() {
    writeUpgradeRequest(this, req, head);
    socket.pipe(this).pipe(socket);
  };
  const upstream = origin.protocol === 'https:'
    ? tlsConnect({ host: origin.hostname, port, servername: origin.hostname }, onConnect)
    : netConnect({ host: origin.hostname, port }, onConnect);

  const closeBoth = () => {
    try { upstream.destroy(); } catch { /* already closed */ }
    try { socket.destroy(); } catch { /* already closed */ }
  };
  upstream.once('error', closeBoth);
  socket.once('error', closeBoth);
}

export function createPublicFrontendProxy({ env = process.env, listener = null } = {}) {
  const config = loadPublicFrontendProxyConfig(env);
  if (listener) assertPublicFrontendIsNotListener(config, listener);

  function shouldProxy(req) {
    return config.mode === 'next' && !isBackendOwnedPath(requestPath(req), req.method);
  }

  return Object.freeze({
    config,
    shouldProxy,
    handle(req, res) {
      return streamHttpRequest(req, res, config.origin);
    },
    handleUpgrade(req, socket, head) {
      if (!shouldProxy(req)) {
        socket.destroy();
        return;
      }
      proxyUpgrade(req, socket, head, config.origin);
    },
  });
}

export const publicFrontendBackendPrefixes = BACKEND_PREFIXES;
export const publicFrontendBackendFormPosts = BACKEND_FORM_POSTS;
