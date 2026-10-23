/**
 * Serve the Web Push service worker from the site root.
 *
 * A service worker's script URL determines its maximum scope. The admin
 * notification code registers `/sw.js` with scope `/admin/`, so the response
 * must opt into that scope with `Service-Worker-Allowed`.
 */
import { readFileSync } from 'node:fs';

const SERVICE_WORKER_PATH = new URL('../../web/public/sw.js', import.meta.url);
const SERVICE_WORKER_BODY = readFileSync(SERVICE_WORKER_PATH);

export function registerServiceWorkerRoute(router) {
  const serve = (ctx) => {
    ctx.res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/admin/',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': SERVICE_WORKER_BODY.length,
    });
    ctx.res.end(SERVICE_WORKER_BODY);
    ctx.responded = true;
  };
  router.get('/sw.js', serve);
}
