/**
 * The public frontend gateway.
 *
 * One origin serves both runtimes: Next.js owns the public pages, while the
 * Node booking runtime keeps `/api`, `/admin` and media. These tests pin the
 * boundary itself, including the no-JavaScript form posts that must stay on
 * the Node side even though their GET page is rendered by Next.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPublicFrontendIsNotListener,
  createPublicFrontendProxy,
  isBackendOwnedPath,
  loadPublicFrontendProxyConfig,
} from '../../src/server/http/publicFrontendProxy.js';

test('API, admin and media paths always belong to the booking runtime', () => {
  for (const path of [
    '/api/public/spaces',
    '/api/public/bookings/NG-2026-00001',
    '/admin',
    '/admin/reservations/12',
    '/assets/styles.css',
    '/assets/trace-media/research/trace-spaces-hero.webp',
    '/media/abc123.png',
  ]) {
    assert.equal(isBackendOwnedPath(path, 'GET'), true, `${path} must stay on Node`);
    assert.equal(isBackendOwnedPath(path, 'POST'), true, `${path} must stay on Node`);
  }
});

test('public pages belong to the Next frontend for GET requests', () => {
  for (const path of ['/', '/spaces', '/spaces/TRC-MR-01', '/book', '/book/confirmed', '/book/manage', '/booking-request', '/booking-request/received', '/booking-request/withdraw']) {
    assert.equal(isBackendOwnedPath(path, 'GET'), false, `${path} must be rendered by Next`);
  }
});

test('no-JavaScript form posts fall back to the Node runtime', () => {
  for (const path of ['/book', '/book/cancel', '/booking-request', '/booking-request/withdraw']) {
    assert.equal(isBackendOwnedPath(path, 'POST'), true, `POST ${path} must reach the Node route`);
  }
  // The GET pages of those paths stay with Next.
  assert.equal(isBackendOwnedPath('/book/cancel', 'GET'), false);
  assert.equal(isBackendOwnedPath('/booking-request/withdraw', 'GET'), false);
});

test('paths are matched on whole segments, not substrings', () => {
  assert.equal(isBackendOwnedPath('/administrator'), false);
  assert.equal(isBackendOwnedPath('/apiary'), false);
  assert.equal(isBackendOwnedPath('/assets-private'), false);
  // A POST-only fallback is exact: no child paths inherit it.
  assert.equal(isBackendOwnedPath('/book/cancel/extra', 'POST'), false);
});

test('the rollout flag defaults to the legacy renderer and rejects typos', () => {
  assert.equal(loadPublicFrontendProxyConfig({}).mode, 'legacy');
  assert.equal(loadPublicFrontendProxyConfig({ PUBLIC_FRONTEND: ' NEXT ' }).mode, 'next');
  assert.throws(
    () => loadPublicFrontendProxyConfig({ PUBLIC_FRONTEND: 'nextish' }),
    /PUBLIC_FRONTEND must be either "legacy" or "next"/,
  );
});

test('the Next origin must be a clean HTTP(S) origin', () => {
  assert.throws(
    () => loadPublicFrontendProxyConfig({ PUBLIC_FRONTEND: 'next', PUBLIC_FRONTEND_ORIGIN: 'ftp://example.test' }),
    /HTTP\(S\) origin/,
  );
  assert.throws(
    () => loadPublicFrontendProxyConfig({ PUBLIC_FRONTEND: 'next', PUBLIC_FRONTEND_ORIGIN: 'http://user:pass@example.test' }),
    /without credentials/,
  );
  assert.throws(
    () => loadPublicFrontendProxyConfig({ PUBLIC_FRONTEND: 'next', PUBLIC_FRONTEND_ORIGIN: 'http://example.test/path' }),
    /must not include a path/,
  );
  const config = loadPublicFrontendProxyConfig({ PUBLIC_FRONTEND: 'next', PUBLIC_FRONTEND_ORIGIN: 'http://127.0.0.1:4174/' });
  assert.equal(config.origin.origin, 'http://127.0.0.1:4174');
});

test('a proxy loop back to the Node listener is refused', () => {
  const config = loadPublicFrontendProxyConfig({
    PUBLIC_FRONTEND: 'next',
    PUBLIC_FRONTEND_ORIGIN: 'http://127.0.0.1:4173',
  });
  assert.throws(
    () => assertPublicFrontendIsNotListener(config, { port: 4173, host: '127.0.0.1' }),
    /proxy loop/,
  );
  // Legacy mode never proxies, so the same target is harmless there.
  assert.doesNotThrow(() => assertPublicFrontendIsNotListener(
    loadPublicFrontendProxyConfig({ PUBLIC_FRONTEND: 'legacy' }),
    { port: 4173, host: '127.0.0.1' },
  ));
});

test('shouldProxy is a pure mode + path decision', () => {
  const next = createPublicFrontendProxy({
    env: { PUBLIC_FRONTEND: 'next', PUBLIC_FRONTEND_ORIGIN: 'http://127.0.0.1:4174' },
  });
  assert.equal(next.shouldProxy({ method: 'GET', url: '/spaces' }), true);
  assert.equal(next.shouldProxy({ method: 'GET', url: '/api/public/spaces' }), false);
  assert.equal(next.shouldProxy({ method: 'POST', url: '/book' }), false);

  const legacy = createPublicFrontendProxy({ env: { PUBLIC_FRONTEND: 'legacy' } });
  assert.equal(legacy.shouldProxy({ method: 'GET', url: '/spaces' }), false);
  assert.equal(typeof legacy.handleUpgrade, 'function');
});
