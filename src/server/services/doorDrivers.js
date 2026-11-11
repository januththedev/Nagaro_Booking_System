/**
 * Door controller drivers.
 *
 * The booking system never talks to a lock directly from a browser. A driver
 * turns one authorised command into one controller call and reports exactly
 * what the controller said - nothing is assumed.
 *
 * Result shape: `{ ok, state, error, offline }`
 *   ok      the controller accepted the command
 *   state   'LOCKED' | 'UNLOCKED' when the controller CONFIRMED the physical
 *           state, otherwise null (accepted, but unconfirmed)
 *   offline the controller could not be reached at all
 *
 * HTTP driver contract (documented in docs/SMART_ACCESS.md):
 *   POST <endpoint_url>
 *   X-Nagaro-Timestamp: <epoch ms>
 *   X-Nagaro-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>
 *   {"commandId","door","action":"OPEN"|"CLOSE","autoLockAt","validUntil","issuedAt"}
 * `autoLockAt` is the mandatory deadline: a controller that can time out an
 * unlock locally MUST lock at that instant even if it loses the network.
 * `validUntil` lets it refuse a command that arrives late.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DOOR_DRIVER } from './accessPolicyService.js';

export const DOOR_HTTP_TIMEOUT_MS = 8000;
const COMMAND_VALIDITY_MS = 20_000;

let testDriver = null;

/** Replace every driver with `fn(command, config)` (tests only). Pass null to restore. */
export function setDoorDriverForTests(fn) {
  testDriver = typeof fn === 'function' ? fn : null;
}

export function controllerSecret(env = process.env) {
  const secret = String(env.DOOR_CONTROLLER_SECRET ?? '').trim();
  return secret.length >= 16 ? secret : null;
}

export function signControllerPayload(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** Constant-time check of an inbound controller signature (5-minute clock window). */
export function verifyControllerSignature({ secret, timestamp, signature, body, now = Date.now() }) {
  if (!secret) return false;
  const at = Number(timestamp);
  if (!Number.isFinite(at) || Math.abs(now - at) > 5 * 60_000) return false;
  const supplied = String(signature ?? '').replace(/^sha256=/i, '').trim().toLowerCase();
  const expected = signControllerPayload(secret, String(timestamp), body);
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function normaliseState(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (['LOCKED', 'CLOSED', 'CLOSE'].includes(text)) return 'LOCKED';
  if (['UNLOCKED', 'OPEN', 'OPENED'].includes(text)) return 'UNLOCKED';
  return null;
}

async function httpDriver(command, config, { now, env }) {
  const secret = controllerSecret(env);
  if (!secret) return { ok: false, state: null, offline: true, error: 'The door controller secret is not configured.' };
  const body = JSON.stringify({
    commandId: String(command.id),
    door: config.doorIdentifier,
    action: command.action,
    autoLockAt: command.action === 'OPEN' ? Number(command.autoLockAt) : null,
    validUntil: now + COMMAND_VALIDITY_MS,
    issuedAt: now,
  });
  const timestamp = String(now);
  let response;
  try {
    response = await fetch(config.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Nagaro-Timestamp': timestamp,
        'X-Nagaro-Signature': `sha256=${signControllerPayload(secret, timestamp, body)}`,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(DOOR_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { ok: false, state: null, offline: true, error: timedOut ? 'The door controller did not answer in time.' : 'The door controller could not be reached.' };
  }
  if (!response.ok) {
    return { ok: false, state: null, offline: response.status >= 500, error: `The door controller refused the command (HTTP ${response.status}).` };
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* an empty 2xx body is an unconfirmed acceptance */ }
  if (payload && payload.ok === false) {
    return { ok: false, state: null, offline: false, error: String(payload.error ?? 'The door controller rejected the command.').slice(0, 200) };
  }
  return { ok: true, state: config.confirmsState ? normaliseState(payload?.state) : null, offline: false, error: null };
}

/**
 * Development/demo controller. It confirms every command instantly and never
 * touches hardware; it can only be selected when NAGARO_DOOR_SIMULATOR=1.
 */
async function simulatedDriver(command, _config, { env }) {
  if (env.NAGARO_DOOR_SIMULATOR !== '1') {
    return { ok: false, state: null, offline: true, error: 'The simulated controller is disabled in this environment.' };
  }
  return { ok: true, state: command.action === 'OPEN' ? 'UNLOCKED' : 'LOCKED', offline: false, error: null };
}

export async function sendDoorCommand(command, config, { now = Date.now(), env = process.env } = {}) {
  try {
    if (testDriver) {
      const result = await testDriver(command, config);
      return { ok: Boolean(result?.ok), state: normaliseState(result?.state), offline: Boolean(result?.offline), error: result?.error ?? null };
    }
    if (config.driver === DOOR_DRIVER.HTTP) return await httpDriver(command, config, { now, env });
    if (config.driver === DOOR_DRIVER.SIMULATED) return await simulatedDriver(command, config, { env });
    return { ok: false, state: null, offline: true, error: 'No door controller is configured for this room.' };
  } catch {
    return { ok: false, state: null, offline: true, error: 'The door controller call failed unexpectedly.' };
  }
}
