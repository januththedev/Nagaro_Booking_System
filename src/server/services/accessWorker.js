/**
 * Everything in the smart-access feature that has to happen "when the time
 * comes" rather than when someone clicks: mandatory door locking, command
 * retries, releasing unpaid extension holds and retrying link delivery.
 *
 * All of it is driven by rows with due timestamps, so this function is safe
 * to call from anywhere, any number of times, on any number of instances:
 *   - a long-running Node process calls it on an interval (startAccessWorker);
 *   - a serverless deployment calls it from the secured scheduler endpoint;
 *   - customer and staff page loads call it lazily so a due lock is never
 *     waiting on the next scheduler tick while someone is looking at it.
 */
import { loadConfig } from '../config.js';
import { deliverPendingAccessLinks } from './accessLinkService.js';
import { hasDueDoorWork, runDoorQueue } from './doorService.js';
import { expireExtensionHolds } from './extensionService.js';

let running = null;

export async function runAccessMaintenance(db, { now = Date.now(), deliver = true } = {}) {
  // One run at a time per process; a second caller simply awaits the first.
  if (running) return running;
  running = (async () => {
    const summary = { door: null, expiredExtensionHolds: 0, deliveries: 0 };
    try { summary.door = await runDoorQueue(db, { now }); } catch (error) { console.warn('[access-worker] door queue failed:', error?.code ?? error?.message ?? 'unknown'); }
    try { summary.expiredExtensionHolds = expireExtensionHolds(db, now); } catch (error) { console.warn('[access-worker] hold expiry failed:', error?.code ?? error?.message ?? 'unknown'); }
    if (deliver) {
      try { summary.deliveries = (await deliverPendingAccessLinks(db, { baseUrl: loadConfig().baseUrl, now })).processed; } catch (error) { console.warn('[access-worker] link delivery failed:', error?.code ?? error?.message ?? 'unknown'); }
    }
    return summary;
  })();
  try { return await running; } finally { running = null; }
}

/** Lazy variant for request handlers: only does work when something is due. */
export async function runDueDoorWork(db, { now = Date.now() } = {}) {
  let due = false;
  try { due = hasDueDoorWork(db, { now }); } catch { return null; }
  if (!due) return null;
  return runAccessMaintenance(db, { now, deliver: false });
}

/** Interval driver for the long-running server. The timer only polls; the schedule itself lives in the database. */
export function startAccessWorker(db, { intervalMs = 10_000 } = {}) {
  const timer = setInterval(() => {
    runAccessMaintenance(db).catch((error) => console.warn('[access-worker] run failed:', error?.code ?? error?.message ?? 'unknown'));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
