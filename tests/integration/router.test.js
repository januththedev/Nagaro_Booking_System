/**
 * HTTP kernel tests: routing, method handling, error boundary, body parsing,
 * and response security headers. These exercise the framework the whole
 * application sits on, independently of any feature route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

/** Send a request with a literal, un-normalised path and return the status. */
function rawRequestStatus(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, method: 'GET', path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}
import { createRouter, normaliseError } from '../../src/server/http/router.js';
import { sendJson, serializeCookie, applySecurityHeaders } from '../../src/server/http/response.js';
import { AppError, validationError, notFound, conflict } from '../../src/server/domain/errors.js';

async function withServer(router, fn) {
  const server = createServer((req, res) => router.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('routes match static and parameterised paths', async () => {
  const router = createRouter();
  router.get('/spaces', (ctx) => ctx.json({ ok: 'list' }));
  router.get('/spaces/:code', (ctx) => ctx.json({ code: ctx.params.code }));
  router.get('/admin/spaces/:id/images/:imageId', (ctx) => ctx.json(ctx.params));

  await withServer(router, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/spaces`)).json(), { ok: 'list' });
    assert.deepEqual(await (await fetch(`${base}/spaces/TRC-MR-01`)).json(), { code: 'TRC-MR-01' });
    assert.deepEqual(
      await (await fetch(`${base}/admin/spaces/7/images/42`)).json(),
      { id: '7', imageId: '42' },
    );
  });
});

test('trailing slashes and duplicate slashes are tolerated', async () => {
  const router = createRouter();
  router.get('/spaces', (ctx) => ctx.json({ ok: true }));
  await withServer(router, async (base) => {
    assert.equal((await fetch(`${base}/spaces/`)).status, 200);
    // Sent over a raw socket: `fetch` would resolve a leading `//` as a
    // protocol-relative authority instead of a path.
    const status = await rawRequestStatus(base, '//spaces');
    assert.equal(status, 200);
  });
});

test('a known path with the wrong method yields 405 and an Allow header', async () => {
  const router = createRouter();
  router.post('/admin/spaces', (ctx) => ctx.json({ ok: true }));
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/admin/spaces`, { method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });
});

test('unknown paths fall through to the not-found handler', async () => {
  const router = createRouter();
  router.setNotFound((ctx) => ctx.json({ ok: false }, 404));
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false });
  });
});

test('parses urlencoded and JSON bodies', async () => {
  const router = createRouter();
  router.post('/echo', async (ctx) => {
    await ctx.readBody();
    ctx.json({ body: ctx.body });
  });
  await withServer(router, async (base) => {
    const forms = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=two%20words',
    });
    assert.deepEqual(await forms.json(), { body: { a: '1', b: 'two words' } });

    const json = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1, nested: { b: [1, 2] } }),
    });
    assert.deepEqual(await json.json(), { body: { a: 1, nested: { b: [1, 2] } } });
  });
});

test('repeated form keys become arrays instead of being silently dropped', async () => {
  const router = createRouter();
  router.post('/multi', async (ctx) => {
    await ctx.readBody();
    ctx.json({ amenities: ctx.body.amenities });
  });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'amenities=Projector&amenities=Whiteboard',
    });
    assert.deepEqual(await res.json(), { amenities: ['Projector', 'Whiteboard'] });
  });
});

test('malformed JSON is rejected with 422, not a 500', async () => {
  const router = createRouter();
  router.post('/echo', async (ctx) => { await ctx.readBody(); ctx.json({}); });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 422);
    const payload = await res.json();
    assert.equal(payload.error.code, 'VALIDATION_ERROR');
  });
});

test('oversized bodies are refused', async () => {
  const router = createRouter();
  router.post('/big', async (ctx) => { await ctx.readBody({ limit: 512 }); ctx.json({ ok: true }); });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/big`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(4096) }),
    }).catch(() => null);
    // The server may destroy the socket mid-upload; either way the request
    // must not succeed.
    if (res) assert.ok(res.status >= 400, `expected a 4xx status, got ${res.status}`);
  });
});

test('error boundary maps AppError to JSON for API paths', async () => {
  const router = createRouter();
  router.get('/api/thing', () => { throw conflict('Already taken'); });
  router.onError((ctx, error) => {
    const { status, code, message } = normaliseError(error);
    sendJson(ctx.res, status, { ok: false, error: { code, message } });
  });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/api/thing`);
    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.equal(payload.error.code, 'CONFLICT');
    assert.equal(payload.error.message, 'Already taken');
  });
});

test('internal errors never leak stack traces or SQL text', async () => {
  const router = createRouter();
  router.get('/api/boom', () => { throw new Error('SQLITE_ERROR: no such table: secret_table at line 42'); });
  router.onError((ctx, error) => {
    const { status, code, message } = normaliseError(error);
    sendJson(ctx.res, status, { ok: false, error: { code, message } });
  });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/api/boom`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes('secret_table'), 'SQL text leaked to client');
    assert.ok(!text.includes('at line 42'), 'stack detail leaked to client');
    assert.ok(!text.includes('.js:'), 'file path leaked to client');
  });
});

test('thrown validation errors carry field details to the client', async () => {
  const router = createRouter();
  router.post('/api/validate', () => {
    throw validationError('Please correct the highlighted fields.', { name: 'name is required' });
  });
  router.onError((ctx, error) => {
    const { status, code, message, details } = normaliseError(error);
    sendJson(ctx.res, status, { ok: false, error: { code, message, details } });
  });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/api/validate`, { method: 'POST' });
    const payload = await res.json();
    assert.equal(res.status, 422);
    assert.deepEqual(payload.error.details, { name: 'name is required' });
  });
});

test('middleware can short-circuit a request', async () => {
  const router = createRouter();
  router.use((ctx) => {
    if (ctx.url.pathname === '/blocked') { ctx.text('No', 403); return false; }
    return true;
  });
  router.get('/blocked', (ctx) => ctx.json({ reached: true }));
  router.get('/allowed', (ctx) => ctx.json({ reached: true }));
  await withServer(router, async (base) => {
    assert.equal((await fetch(`${base}/blocked`)).status, 403);
    assert.deepEqual(await (await fetch(`${base}/allowed`)).json(), { reached: true });
  });
});

test('a handler that responds with nothing still gets a valid response', async () => {
  const router = createRouter();
  router.get('/quiet', () => { /* deliberately does not respond */ });
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/quiet`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('security headers are present and cookies are serialised correctly', async () => {
  const router = createRouter();
  router.get('/headers', (ctx) => ctx.json({ ok: true }));
  await withServer(router, async (base) => {
    const res = await fetch(`${base}/headers`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  const cookie = serializeCookie('nagaro_session', 'abc123', {
    maxAgeSeconds: 60, httpOnly: true, secure: true, sameSite: 'Lax',
  });
  assert.ok(cookie.includes('nagaro_session=abc123'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('Secure'));
  assert.ok(cookie.includes('SameSite=Lax'));
  assert.ok(cookie.includes('Max-Age=60'));
});

test('applySecurityHeaders gives uploaded media an inert policy', () => {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
  applySecurityHeaders(res, { isMedia: true });
  assert.match(headers['content-security-policy'], /default-src 'none'/);
  assert.match(headers['content-security-policy'], /sandbox/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
});

test('AppError defaults are sane', () => {
  assert.equal(new AppError('X', 'boom').status, 400);
  assert.equal(notFound().status, 404);
  assert.equal(validationError('nope').status, 422);
  assert.equal(conflict('dup').status, 409);
});
