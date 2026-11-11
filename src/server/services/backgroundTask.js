/**
 * Run work after the response without losing it on serverless hosting.
 *
 * On Vercel a function can be frozen as soon as the response is sent, so a
 * bare setTimeout may never fire. Vercel exposes `waitUntil` through its
 * request context; when present, the promise is registered there and the
 * function stays alive until it settles. Elsewhere the work simply runs.
 */
const VERCEL_CONTEXT = Symbol.for('@vercel/request-context');

export function runInBackground(label, fn) {
  const promise = Promise.resolve()
    .then(fn)
    .catch((error) => console.warn(`[${label}] background task failed:`, error?.code ?? error?.message ?? 'unknown'));
  try {
    const ctx = globalThis[VERCEL_CONTEXT]?.get?.();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise);
  } catch { /* not on Vercel */ }
  return promise;
}
