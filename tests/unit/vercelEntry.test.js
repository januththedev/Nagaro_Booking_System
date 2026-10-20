/**
 * Vercel serverless entry (api/index.js): configuration guards and request
 * handling, exercised over real HTTP against throwaway state.
 *
 * Proves:
 *   - on Vercel with no persistent database and no explicit opt-in, the
 *     function refuses with a configuration error (never a silent local
 *     SQLite fallback and never a stack trace or secret);
 *   - with an unreachable DATABASE_URL, it fails safely and creates no
 *     fallback SQLite file;
 *   - with the explicit ephemeral opt-in, it boots and serves the real app
 *     (public page 200, unknown route 404, security headers present).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAVED_ENV = { ...process.env };

function setEnv(overrides) {
  for (const key of ['VERCEL', 'DATABASE_URL', 'DIRECT_URL', 'NAGARO_ALLOW_EPHEMERAL_SQLITE', 'NAGARO_DB_PATH', 'NAGARO_UPLOAD_DIR']) {
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
}

async function freshHandler() {
  const mod = await import(`../../api/index.js?case=${Math.random().toString(36).slice(2)}`);
  mod.resetServerlessAppForTests();
  return mod.default;
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('vercel entry refuses without a persistent database and without opt-in', async (t) => {
  t.after(() => { process.env = { ...SAVED_ENV }; });
  const dir = mkdtempSync(join(tmpdir(), 'nagaro-vercel-guard-'));
  try {
    setEnv({ VERCEL: '1', NAGARO_DB_PATH: join(dir, 'should-never-exist.db') });
    const handler = await freshHandler();
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 500);
      const payload = await res.json();
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, 'CONFIGURATION_ERROR');
      assert.match(payload.error.message, /database/i);
      assert.ok(!JSON.stringify(payload).includes('should-never-exist'), 'no paths leak');
    });
    assert.equal(existsSync(join(dir, 'should-never-exist.db')), false, 'no database file created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vercel entry fails safely when configured PostgreSQL is unreachable', async (t) => {
  t.after(() => { process.env = { ...SAVED_ENV }; });
  const dir = mkdtempSync(join(tmpdir(), 'nagaro-vercel-pg-'));
  try {
    setEnv({
      VERCEL: '1',
      DATABASE_URL: 'postgres://user:s3cret-pw@127.0.0.1:1/postgres',
      NAGARO_DB_PATH: join(dir, 'must-not-exist.db'),
    });
    const handler = await freshHandler();
    await withServer(handler, async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 500);
      const payload = await res.json();
      assert.equal(payload.error.code, 'CONFIGURATION_ERROR');
      const text = JSON.stringify(payload);
      assert.ok(!text.includes('s3cret-pw'), 'connection secret never leaks');
      assert.ok(!text.includes('127.0.0.1'), 'connection host never leaks');
      assert.match(payload.error.message, /PostgreSQL database/i);
    });
    assert.equal(existsSync(join(dir, 'must-not-exist.db')), false, 'no SQLite fallback file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vercel entry serves the real app with the explicit ephemeral opt-in', async (t) => {
  t.after(() => { process.env = { ...SAVED_ENV }; });
  const dir = mkdtempSync(join(tmpdir(), 'nagaro-vercel-ephem-'));
  try {
    setEnv({
      VERCEL: '1',
      NAGARO_ALLOW_EPHEMERAL_SQLITE: '1',
      NAGARO_DB_PATH: join(dir, 'preview.db'),
      NAGARO_UPLOAD_DIR: join(dir, 'uploads'),
    });
    const handler = await freshHandler();
    await withServer(handler, async (base) => {
      const home = await fetch(`${base}/`);
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-type') ?? '', /text\/html/);
      assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
      const missing = await fetch(`${base}/no-such-page`);
      assert.equal(missing.status, 404);
      const api = await fetch(`${base}/api/public/spaces`, { headers: { accept: 'application/json' } });
      assert.equal(api.status, 200);
    });
  } finally {
    const { closeDb } = await import('../../src/server/db/connection.js');
    closeDb();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
