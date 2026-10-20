import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

test('vercel.json uses supported project keys and keeps Next tracing in next.config', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
  const allowed = new Set([
    '$schema', 'framework', 'buildCommand', 'outputDirectory',
    'functions', 'rewrites',
  ]);

  for (const key of Object.keys(config)) {
    assert.ok(allowed.has(key), `unexpected Vercel project key: ${key}`);
  }
  assert.equal(Object.hasOwn(config, 'outputFileTracingIncludes'), false);
  assert.equal(Object.hasOwn(config, 'installCommand'), false, 'Vercel must use the root npm workspace install');
  assert.equal(config.framework, 'nextjs');
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.outputDirectory, 'apps/public-web/.next');
  assert.equal(config.functions?.['api/index.js']?.includeFiles, 'src/**');
  assert.equal(
    Object.hasOwn(config.functions?.['api/index.js'] ?? {}, 'runtime'),
    false,
    'official Node.js functions must use the project Node engine, not a community-runtime identifier',
  );

  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines?.node, '24.x');
  assert.deepEqual(packageJson.workspaces, ['apps/public-web']);
  assert.equal(packageJson.scripts?.build, 'npm run build --workspace=trace-spaces-public-web');
  assert.equal(
    existsSync(resolve(root, 'apps/public-web/package-lock.json')),
    false,
    'the workspace must use the single root lockfile',
  );

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
