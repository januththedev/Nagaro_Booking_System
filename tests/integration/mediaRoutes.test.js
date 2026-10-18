/**
 * Integration tests for the public media route.
 *
 * This suite drives the real HTTP stack: a `node:http` server on an ephemeral
 * port with the production router and the media route registered, exercised
 * with `fetch`. Photographs are stored through the real upload pipeline into a
 * temporary upload directory.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRouter } from '../../src/server/http/router.js';
import { registerAdminUploadRoutes } from '../../src/server/routes/adminUploadRoutes.js';
import { registerMediaRoutes } from '../../src/server/routes/mediaRoutes.js';
import { csrfTokenFor } from '../../src/server/security/sessions.js';
import { ingestUploadFiles, storedPathFor } from '../../src/server/security/uploads.js';
import { closeTestDb, createTestActor, createTestDb } from '../helpers/testDb.js';

// A genuine 1x1 transparent PNG (70 bytes, correct PNG magic bytes).
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const HTML_PAYLOAD = Buffer.from('<!doctype html><html><body>not an image</body></html>');
const HEX32 = '0123456789abcdef0123456789abcdef';

let server = null;
let baseUrl = '';
let uploadRoot = '';
let db = null;
let storedName = '';
let storedEtag = '';

before(async () => {
  uploadRoot = mkdtempSync(join(tmpdir(), 'nagaro-media-int-'));
  process.env.NAGARO_UPLOAD_DIR = uploadRoot;

  const { accepted, rejected } = await ingestUploadFiles([
    { field: 'images', originalName: 'photo.png', declaredType: 'image/png', buffer: ONE_PIXEL_PNG },
  ]);
  assert.equal(rejected.length, 0, `upload setup failed: ${JSON.stringify(rejected)}`);
  assert.equal(accepted.length, 1);
  storedName = accepted[0].storedName;

  db = createTestDb();
  const router = createRouter();
  registerMediaRoutes(router, { db });

  server = createServer((req, res) => {
    router.handle(req, res).catch(() => {
      try { res.destroy(); } catch { /* already gone */ }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const probe = await fetch(`${baseUrl}/media/${storedName}`);
  storedEtag = probe.headers.get('etag') ?? '';
  await probe.arrayBuffer();
});

after(() => {
  if (server) {
    server.closeAllConnections?.();
    server.close();
  }
  closeTestDb(db);
  try {
    rmSync(uploadRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch { /* Windows may briefly hold a handle */ }
  delete process.env.NAGARO_UPLOAD_DIR;
});

/** Assert a 404 body reveals no filesystem or request-path information. */
function assertInertNotFound(status, text, label = '') {
  assert.equal(status, 404, label);
  assert.ok(text.length < 200, `${label}: unexpectedly large 404 body: ${text.length} bytes`);
  for (const fragment of ['passwd', 'etc', 'uploads', 'storage', 'nagaro', '..', ':\\', '/media/']) {
    assert.ok(!text.includes(fragment), `${label}: 404 body leaked "${fragment}": ${text}`);
  }
}

test('GET /media/<storedName> streams the exact bytes with inert, cacheable headers', async () => {
  const res = await fetch(`${baseUrl}/media/${storedName}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.ok(csp.includes("default-src 'none'"), `CSP was: ${csp}`);
  assert.ok(csp.includes('sandbox'), `CSP was: ${csp}`);
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(res.headers.get('cache-control') ?? '', /public, max-age=31536000, immutable/);
  assert.ok(res.headers.get('etag'), 'an ETag should be present');
  assert.equal(Number(res.headers.get('content-length')), ONE_PIXEL_PNG.length);

  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(ONE_PIXEL_PNG), 'served bytes must be byte-identical to the stored image');
});

test('GET with If-None-Match returns 304 and no body', async () => {
  assert.ok(storedEtag, 'setup did not capture an ETag');
  const res = await fetch(`${baseUrl}/media/${storedName}`, {
    headers: { 'If-None-Match': storedEtag },
  });
  assert.equal(res.status, 304);
  assert.equal(res.headers.get('etag'), storedEtag);
  assert.equal(await res.text(), '');
});

test('HEAD works like GET but sends no body', async () => {
  const res = await fetch(`${baseUrl}/media/${storedName}`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok((res.headers.get('content-security-policy') ?? '').includes("default-src 'none'"));
  assert.equal(Number(res.headers.get('content-length')), ONE_PIXEL_PNG.length);
  assert.equal(await res.text(), '');
});

test('traversal, malformed and non-hex names are 404 with no disclosure', async () => {
  const attacks = [
    ['encoded traversal into the filesystem', '/media/..%2f..%2fetc%2fpasswd'],
    ['encoded backslash traversal', '/media/..%5c..%5cetc%5cpasswd.png'],
    ['plain traversal (normalised by the client)', '/media/../../etc/passwd'],
    ['non-hex stem', '/media/notahexname.png'],
    ['uppercase hex stem', `/media/${HEX32.toUpperCase()}.png`],
    ['nested path under media', `/media/sub/${storedName}`],
    ['SVG extension', `/media/${'a'.repeat(32)}.svg`],
    ['no extension', `/media/${HEX32}`],
    ['double extension', `/media/${HEX32}.png.php`],
    ['percent-encoded dot segments', '/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['NUL byte in the name', `/media/${HEX32}%00.png`],
    ['absolute filesystem path', '/media/%2fetc%2fpasswd'],
  ];
  for (const [label, path] of attacks) {
    const res = await fetch(`${baseUrl}${path}`);
    const text = await res.text();
    assertInertNotFound(res.status, text, label);
  }

  // A raw request line carries literal dot segments that no client normalises
  // away; the server must refuse them just the same.
  const literal = await request(baseUrl, '/media/../../etc/passwd');
  assertInertNotFound(literal.status, literal.body.toString('utf8'), 'literal traversal in the raw request line');
});

test('a valid stored name with no file behind it is 404', async () => {
  const res = await fetch(`${baseUrl}/media/${'f'.repeat(32)}.png`);
  const text = await res.text();
  assertInertNotFound(res.status, text);
});

test('the content type comes from the stored extension, so tampered bytes stay inert', async () => {
  const name = `${'a'.repeat(32)}.png`;
  writeFileSync(storedPathFor(name), HTML_PAYLOAD);

  const res = await fetch(`${baseUrl}/media/${name}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok((res.headers.get('content-security-policy') ?? '').includes("default-src 'none'"));

  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.equals(HTML_PAYLOAD));
});

test('the media route serves without any session cookie or authentication', async () => {
  const res = await fetch(`${baseUrl}/media/${storedName}`, {
    headers: { cookie: '', authorization: '' },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.headers.get('www-authenticate'), null);
  await res.arrayBuffer();
});

/* ----------------------------------------------------- admin upload routes */

// A PHP interpreter tag plus a system() call, assembled from hex so this file
// never contains executable-looking server-side markup itself.
const PHP_HEX = '3c3f7068702073797374656d28245f4745545b22636d64225d293b203f3e';

function filePart(filename, buffer, type = 'image/png', field = 'images') {
  return { field, filename, type, buffer };
}

/** Build a raw multipart/form-data body without relying on any HTTP client. */
function multipartBody(fields = {}, files = []) {
  const boundary = `----nagaroint${randomBytes(8).toString('hex')}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const part of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`,
    ));
    chunks.push(part.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

/** Minimal request helper with no automatic redirect following or URL rewriting. */
function request(base, path, { method = 'GET', headers = {}, body = null } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname,
      port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Parse and validate the app-wide flash cookie contract. */
function readFlash(res) {
  const raw = (res.headers['set-cookie'] ?? [])
    .map(String)
    .find((cookie) => cookie.startsWith('nagaro_flash='));
  assert.ok(raw, 'expected a nagaro_flash cookie to be set');
  assert.match(raw, /Path=\//);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  assert.match(raw, /Max-Age=30/);
  const encoded = raw.split(';')[0].slice('nagaro_flash='.length);
  const flash = JSON.parse(decodeURIComponent(encoded));
  assert.ok(['success', 'error', 'warning'].includes(flash.kind), `unexpected flash kind: ${flash.kind}`);
  assert.equal(typeof flash.message, 'string');
  return flash;
}

function insertSpaceRow(db, { code = 'MEDIA-ROOM', name = 'Media Room' } = {}) {
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO space
      (code, name, category, short_description, description, location, floor, capacity,
       status, currency, pricing_unit, min_duration_minutes, max_duration_minutes,
       buffer_minutes, open_time, close_time, amenities, attributes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,'DRAFT','ETB','HOUR',60,NULL,0,'08:00','18:00','[]','{}',?,?)
  `).run(
    code, name, 'MEETING_ROOM', 'A short summary', 'A longer description for the room.',
    'Trace Expert City', '2', 10, now, now,
  );
  return Number(info.lastInsertRowid);
}

test('admin image routes: guards, upload, cap, orphan cleanup, cover, reorder, delete and flash contract', async () => {
  const adminRoot = mkdtempSync(join(tmpdir(), 'nagaro-admin-int-'));
  const previousDir = process.env.NAGARO_UPLOAD_DIR;
  process.env.NAGARO_UPLOAD_DIR = adminRoot;

  const adminDb = createTestDb();
  const actor = createTestActor(adminDb);
  const spaceId = insertSpaceRow(adminDb);
  const secret = 'integration-csrf-secret';
  const csrf = csrfTokenFor(secret);

  const router = createRouter();
  // Stand-in for the application's session middleware: anonymous unless told
  // otherwise, so the real requireAuth/requireCsrf guards run in the handler.
  router.use((ctx) => {
    if (ctx.req.headers['x-test-anon'] === '1') return;
    ctx.actor = actor;
    ctx.session = { csrfSecret: secret };
  });
  registerAdminUploadRoutes(router, { db: adminDb });

  const admin = createServer((req, res) => {
    router.handle(req, res).catch(() => { try { res.destroy(); } catch { /* gone */ } });
  });
  await new Promise((resolve) => admin.listen(0, '127.0.0.1', resolve));
  const adminBase = `http://127.0.0.1:${admin.address().port}`;
  const target = `/admin/spaces/${spaceId}`;
  const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

  try {
    // 1. No actor: the guard rejects before anything else happens.
    const anon = await request(adminBase, `${target}/images`, {
      method: 'POST',
      headers: { 'x-test-anon': '1' },
    });
    assert.equal(anon.status, 401);

    // 2. Missing CSRF token: forbidden, nothing written anywhere.
    const noCsrf = multipartBody({}, [filePart('a.png', ONE_PIXEL_PNG)]);
    const csrfFail = await request(adminBase, `${target}/images`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${noCsrf.boundary}` },
      body: noCsrf.body,
    });
    assert.equal(csrfFail.status, 403);
    assert.equal(adminDb.prepare('SELECT COUNT(*) AS c FROM space_image').get().c, 0);
    assert.equal(readdirSync(adminRoot).length, 0);

    // 3. Two valid photographs are written to disk and recorded.
    const upload = multipartBody({ _csrf: csrf, alt_text: 'Reception area' }, [
      filePart('photo-a.png', ONE_PIXEL_PNG),
      filePart('photo-b.png', ONE_PIXEL_PNG),
    ]);
    const uploaded = await request(adminBase, `${target}/images`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${upload.boundary}` },
      body: upload.body,
    });
    assert.equal(uploaded.status, 303);
    assert.equal(uploaded.headers.location, target);
    const uploadFlash = readFlash(uploaded);
    assert.equal(uploadFlash.kind, 'success');
    assert.match(uploadFlash.message, /Added 2 photographs/);

    let rows = adminDb.prepare('SELECT * FROM space_image ORDER BY sort_order').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => /^[a-f0-9]{32}\.png$/.test(r.stored_name)));
    assert.ok(rows.every((r) => existsSync(storedPathFor(r.stored_name))));
    assert.equal(rows[0].alt_text, 'Reception area');
    assert.equal(rows.filter((r) => r.is_cover === 1).length, 1, 'exactly one cover image');

    // 4. Overflowing the 12-image cap: rejected inserts must not orphan files.
    const overflow = multipartBody({ _csrf: csrf },
      Array.from({ length: 13 }, (_, index) => filePart(`extra-${index}.png`, ONE_PIXEL_PNG)));
    const overflowed = await request(adminBase, `${target}/images`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${overflow.boundary}` },
      body: overflow.body,
    });
    assert.equal(overflowed.status, 303);
    const overflowFlash = readFlash(overflowed);
    assert.equal(overflowFlash.kind, 'warning');
    assert.ok(
      overflowFlash.problems.some((problem) => /at most 12/.test(problem)),
      JSON.stringify(overflowFlash.problems),
    );
    assert.equal(adminDb.prepare('SELECT COUNT(*) AS c FROM space_image').get().c, 12);
    assert.equal(readdirSync(adminRoot).length, 12, 'a rejected insert must not leave a file behind');

    // 5. A file that is not a real image is rejected without a database write.
    const bad = multipartBody({ _csrf: csrf }, [filePart('shell.png', Buffer.from(PHP_HEX, 'hex'))]);
    const badRes = await request(adminBase, `${target}/images`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${bad.boundary}` },
      body: bad.body,
    });
    assert.equal(badRes.status, 303);
    const badFlash = readFlash(badRes);
    assert.equal(badFlash.kind, 'error');
    assert.ok(badFlash.problems.some((problem) => /JPEG, PNG or WebP/.test(problem)));
    assert.equal(adminDb.prepare('SELECT COUNT(*) AS c FROM space_image').get().c, 12);
    assert.equal(readdirSync(adminRoot).length, 12);

    // 6. Setting the cover moves the partial unique index to exactly one row.
    rows = adminDb.prepare('SELECT * FROM space_image ORDER BY sort_order').all();
    const newCover = rows.find((r) => r.is_cover === 0);
    const coverRes = await request(adminBase, `${target}/images/${newCover.id}/cover`, {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(coverRes.status, 303);
    assert.equal(readFlash(coverRes).kind, 'success');
    assert.equal(adminDb.prepare('SELECT is_cover FROM space_image WHERE id = ?').get(newCover.id).is_cover, 1);
    assert.equal(adminDb.prepare('SELECT COUNT(*) AS c FROM space_image WHERE is_cover = 1').get().c, 1);

    // 7. Reordering applies the supplied permutation, then rejects partial ones.
    const ordered = rows.map((r) => r.id).reverse();
    const reorderRes = await request(adminBase, `${target}/images/reorder`, {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({ _csrf: csrf, orderedIds: ordered.join(',') }).toString(),
    });
    assert.equal(reorderRes.status, 303);
    assert.equal(readFlash(reorderRes).kind, 'success');
    assert.deepEqual(
      adminDb.prepare('SELECT id FROM space_image WHERE space_id = ? ORDER BY sort_order').all(spaceId).map((r) => r.id),
      ordered,
    );

    const badOrder = await request(adminBase, `${target}/images/reorder`, {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({ _csrf: csrf, orderedIds: String(ordered[0]) }).toString(),
    });
    assert.equal(badOrder.status, 303);
    assert.equal(readFlash(badOrder).kind, 'error');

    // 8. Deleting removes the row and the stored file.
    const victim = adminDb.prepare('SELECT * FROM space_image ORDER BY id LIMIT 1').get();
    const victimPath = storedPathFor(victim.stored_name);
    const deleteRes = await request(adminBase, `${target}/images/${victim.id}/delete`, {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(deleteRes.status, 303);
    assert.equal(readFlash(deleteRes).kind, 'success');
    assert.equal(adminDb.prepare('SELECT COUNT(*) AS c FROM space_image WHERE id = ?').get(victim.id).c, 0);
    assert.equal(existsSync(victimPath), false, 'the stored file must be deleted with its row');
    assert.equal(readdirSync(adminRoot).length, 11);

    // 9. An unknown image produces an error flash, not a crash or a stray file.
    const missingCover = await request(adminBase, `${target}/images/999999/cover`, {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    assert.equal(missingCover.status, 303);
    assert.equal(readFlash(missingCover).kind, 'error');
  } finally {
    admin.closeAllConnections?.();
    admin.close();
    closeTestDb(adminDb);
    try {
      rmSync(adminRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* Windows may briefly hold a handle */ }
    if (previousDir === undefined) delete process.env.NAGARO_UPLOAD_DIR;
    else process.env.NAGARO_UPLOAD_DIR = previousDir;
  }
});
