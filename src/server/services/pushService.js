/**
 * Web Push transport.
 *
 * VAPID configuration is read directly from the environment (the application
 * config module is intentionally not extended for this feature):
 *
 *   VAPID_PUBLIC_KEY   browser applicationServerKey
 *   VAPID_PRIVATE_KEY  server-only signing key
 *   VAPID_SUBJECT      mailto: or https: identity
 *
 * `web-push` is loaded lazily so a deployment that has not installed the
 * optional transport can still serve the in-app notification centre. Delivery
 * failures never escape as process errors from here: callers receive a stable
 * result / error object and decide whether to retry.
 */
import webpush from 'web-push';

const DEFAULT_SUBJECT = 'mailto:no-reply@trace.local';
const CONFIGURED_DETAILS = new Map();

function envValue(env, name) {
  const raw = env?.[name] ?? process.env?.[name];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

function validSubject(value) {
  return /^mailto:[^\s]+$/i.test(value) || /^https?:\/\/[^\s]+$/i.test(value);
}

/** Resolve VAPID details without throwing for an unconfigured deployment. */
export function vapidConfig(env = process.env) {
  const publicKey = envValue(env, 'VAPID_PUBLIC_KEY');
  const privateKey = envValue(env, 'VAPID_PRIVATE_KEY');
  const subjectRaw = envValue(env, 'VAPID_SUBJECT');
  const subject = validSubject(subjectRaw) ? subjectRaw : DEFAULT_SUBJECT;
  return {
    // A real contact identity is part of a valid VAPID configuration. Do not
    // silently sign production push requests with the local-development
    // placeholder when the subject was omitted or malformed.
    configured: Boolean(publicKey && privateKey && validSubject(subjectRaw)),
    publicKey: publicKey || null,
    privateKey: privateKey || null,
    subject,
  };
}

/** Public half of the VAPID pair, or null when push is not configured. */
export function vapidPublicKey(env = process.env) {
  const config = vapidConfig(env);
  return config.configured ? config.publicKey : null;
}

function configureVapid(details) {
  const key = `${details.subject}|${details.publicKey}|${details.privateKey}`;
  if (CONFIGURED_DETAILS.get('key') === key) return;
  webpush.setVapidDetails(details.subject, details.publicKey, details.privateKey);
  CONFIGURED_DETAILS.set('key', key);
}

function subscriptionShape(subscription) {
  const endpoint = String(subscription?.endpoint ?? '').trim();
  const p256dh = String(subscription?.keys?.p256dh ?? subscription?.p256dh ?? '').trim();
  const auth = String(subscription?.keys?.auth ?? subscription?.auth ?? '').trim();
  if (!endpoint || !p256dh || !auth) {
    const error = new Error('The push subscription is incomplete.');
    error.code = 'PUSH_SUBSCRIPTION_INVALID';
    throw error;
  }
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Send one push message.
 *
 * The payload is the JSON object the service worker receives. `urgency` is a
 * transport-level hint (`very-low|low|normal|high`); the reminder payload also
 * carries `requireInteraction: true` for the notification itself.
 *
 * Resolves with `{ statusCode, body }` on success and throws the provider error
 * on failure (404/410 mean the subscription is gone).
 */
export async function sendWebPush({
  subscription,
  payload,
  urgency = 'normal',
  ttl = 3600,
  vapid = vapidConfig(),
} = {}) {
  if (!vapid?.configured) {
    const error = new Error('Web Push is not configured on this server.');
    error.code = 'VAPID_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  configureVapid(vapid);
  const body = JSON.stringify(payload ?? {});
  const options = {
    TTL: Math.max(0, Number(ttl) || 0),
    urgency: ['very-low', 'low', 'normal', 'high'].includes(urgency) ? urgency : 'normal',
    contentEncoding: 'aes128gcm',
    timeout: 10000,
  };
  const response = await webpush.sendNotification(subscriptionShape(subscription), body, options);
  return { statusCode: Number(response?.statusCode ?? 201), body: response?.body ?? null };
}

/** Test-only: forget the cached VAPID details. */
export function resetPushTransportForTests() {
  CONFIGURED_DETAILS.clear();
}

export { DEFAULT_SUBJECT };
