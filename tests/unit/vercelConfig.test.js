import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

test('vercel.json uses supported project keys and keeps Next tracing in next.config', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
  const allowed = new Set([
    '$schema', 'framework', 'installCommand', 'buildCommand', 'outputDirectory',
    'functions', 'rewrites',
  ]);

  for (const key of Object.keys(config)) {
    assert.ok(allowed.has(key), `unexpected Vercel project key: ${key}`);
  }
  assert.equal(Object.hasOwn(config, 'outputFileTracingIncludes'), false);
  assert.equal(config.framework, 'nextjs');
  assert.equal(config.outputDirectory, 'apps/public-web/.next');
  assert.equal(config.functions?.['api/index.js']?.includeFiles, 'src/**');

  const nextConfig = readFileSync(resolve(root, 'apps/public-web/next.config.mjs'), 'utf8');
  assert.match(nextConfig, /outputFileTracingRoot/);
});

test('Vercel routes backend-owned paths to the Node function without swallowing public pages', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
  const rewrites = new Map(config.rewrites.map((entry) => [entry.source, entry.destination]));
  for (const source of ['/api/:path*', '/admin/:path*', '/assets/:path*', '/media/:path*']) {
    assert.equal(rewrites.get(source), '/api/index');
  }
  assert.equal(rewrites.has('/(.*)'), false, 'public Next routes must not be swallowed by the API function');
});
