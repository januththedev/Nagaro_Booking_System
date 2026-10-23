/**
 * The demo administrator must never be created by accident.
 *
 * `npm run seed` (without `--demo`) is the catalogue-only path used by people
 * who already provisioned their own Super Admin. On an empty database it must
 * fail with an actionable message instead of inserting the documented
 * `admin@trace.local` / `TraceDemo2026` credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('plain seed refuses to create the demo administrator on an empty database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nagaro-seed-gate-'));
  const env = {
    ...process.env,
    DATABASE_URL: '',
    NAGARO_DB_PATH: join(dir, 'empty.db'),
    NAGARO_UPLOAD_DIR: join(dir, 'uploads'),
  };
  delete env.NAGARO_DEMO_ADMIN_PASSWORD;

  try {
    const result = spawnSync(process.execPath, ['src/server/db/seed.js'], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No administrator exists/);
    assert.match(result.stderr, /npm run seed -- --demo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
