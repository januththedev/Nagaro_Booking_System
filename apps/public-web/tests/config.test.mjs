/**
 * Configuration boundary of the public frontend.
 *
 * The Next app is never the public listener: the Node runtime owns the public
 * port and streams page requests to Next while keeping /api, /admin, /assets
 * and /media for itself. These checks lock the rewrites, the build flags and
 * the capability-page headers that make that split work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readApp = (relative) => readFile(resolve(appRoot, relative), 'utf8');

/**
 * next.config.mjs resolves its proxy target when the module is evaluated, so
 * each environment case needs a fresh module instance (the query string gives
 * the ESM loader a distinct specifier).
 */
let loadCount = 0;
async function loadNextConfig(env = {}) {
  const previous = { API_ORIGIN: process.env.API_ORIGIN, API_PROXY_TARGET: process.env.API_PROXY_TARGET };
  delete process.env.API_ORIGIN;
  delete process.env.API_PROXY_TARGET;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    loadCount += 1;
    const specifier = new URL(`../next.config.mjs?case=${loadCount}`, import.meta.url).href;
    const module = await import(specifier);
    return module.default;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the Next app never advertises the framework and keeps strict mode', async () => {
  const config = await loadNextConfig();
  assert.equal(config.poweredByHeader, false);
  assert.equal(config.reactStrictMode, true);
});

test('rewrites hand API, admin, asset and media traffic to the Node runtime', async () => {
  const config = await loadNextConfig();
  const rewrites = await config.rewrites();

  const bySource = new Map(rewrites.map((rule) => [rule.source, rule.destination]));
  assert.deepEqual(
    [...bySource.keys()].sort(),
    ['/admin/:path*', '/api/:path*', '/assets/:path*', '/media/:path*'],
  );

  for (const prefix of ['/api', '/admin', '/assets', '/media']) {
    assert.equal(bySource.get(`${prefix}/:path*`), `http://127.0.0.1:4173${prefix}/:path*`);
  }
});

test('the proxy target follows API_PROXY_TARGET, then API_ORIGIN, and drops trailing slashes', async () => {
  const fromProxyTarget = await loadNextConfig({ API_PROXY_TARGET: 'http://127.0.0.1:4321/' });
  const [first] = await fromProxyTarget.rewrites();
  assert.equal(first.destination, 'http://127.0.0.1:4321/api/:path*');

  const fromOrigin = await loadNextConfig({ API_ORIGIN: 'http://10.0.0.7:8080' });
  const [second] = await fromOrigin.rewrites();
  assert.equal(second.destination, 'http://10.0.0.7:8080/api/:path*');

  const both = await loadNextConfig({ API_ORIGIN: 'http://10.0.0.7:8080', API_PROXY_TARGET: 'https://api.example.test' });
  const [third] = await both.rewrites();
  assert.equal(third.destination, 'https://api.example.test/api/:path*');
});

test('capability pages are unshareable: no-store, no-referrer, noindex', async () => {
  const source = await readApp('middleware.ts');
  assert.match(source, /matcher:\s*\[[^\]]*"\/book\/confirmed"[^\]]*"\/book\/manage"[^\]]*\]/);
  for (const header of [
    /"Cache-Control",\s*"no-store, private"/,
    /"Referrer-Policy",\s*"no-referrer"/,
    /"X-Robots-Tag",\s*"noindex, nofollow, noarchive"/,
  ]) {
    assert.match(source, header);
  }
});

test('the app ships its own fonts instead of calling a font CDN', async () => {
  const css = await readApp('app/globals.css');
  assert.match(css, /@import "@fontsource\/libre-caslon-display\//);
  assert.match(css, /@import "@fontsource\/ibm-plex-mono\//);
  for (const file of ['app/globals.css', 'app/layout.tsx', 'components/PublicShell.tsx']) {
    const content = await readApp(file);
    assert.doesNotMatch(content, /fonts\.(googleapis|gstatic)\.com/, `${file} must not load remote fonts`);
  }
});

test('Vercel Analytics is mounted once at the public app root', async () => {
  const layout = await readApp('app/layout.tsx');
  const manifest = JSON.parse(await readApp('package.json'));

  assert.match(layout, /import\s+\{\s*Analytics\s*\}\s+from\s+["']@vercel\/analytics\/next["']/);
  assert.equal((layout.match(/<Analytics\s*\/>/g) ?? []).length, 1);
  assert.match(manifest.dependencies['@vercel/analytics'], /^\^2\./);
});
