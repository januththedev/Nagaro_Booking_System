/**
 * Outbound email.
 *
 * Honest delivery semantics:
 *   - SMTP_HOST absent  -> NOT_CONFIGURED. No socket is opened, no exception
 *     is thrown. This is a normal configuration state, not an error.
 *   - delivery failure  -> FAILED with a short, secret-free message. Delivery
 *     problems never propagate as exceptions, because a persisted inquiry must
 *     not be rolled back (or reported as lost) just because email is down.
 *   - success           -> SENT with the provider message id.
 *
 * Timeouts keep a dead SMTP server from holding an HTTP request open:
 * 8s to connect, 8s for the greeting, 12s of socket inactivity.
 *
 * Tests can bypass SMTP entirely with NAGARO_MAIL_TRANSPORT=json|stream, or
 * inject a transport factory via setTransportFactoryForTests().
 */
import nodemailer from 'nodemailer';
import { INQUIRY_EMAIL_STATUS } from '../domain/constants.js';

const DEFAULT_FROM = 'no-reply@trace.local';
const TIMEOUTS = Object.freeze({
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 12000,
});

let transportFactory = null;
let factoryTransport = null;
let defaultTransport = null;
let defaultTransportKey = null;

function envValue(name) {
  const raw = process.env[name];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

function smtpSecure() {
  const raw = envValue('SMTP_SECURE').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Local test transports are an explicit, deliberate configuration. */
function transportMode() {
  const mode = envValue('NAGARO_MAIL_TRANSPORT').toLowerCase();
  return mode === 'json' || mode === 'stream' ? mode : 'smtp';
}

/**
 * Resolve the current email configuration from the environment.
 * Returns `{ configured, from, to, mode, reason }`.
 */
export function mailerConfig() {
  const adminAddress = envValue('NAGARO_ADMIN_NOTIFICATION_EMAIL');
  const from = envValue('SMTP_FROM') || adminAddress || DEFAULT_FROM;
  const to = adminAddress || null;
  const host = envValue('SMTP_HOST');
  const mode = transportMode();

  if (host) return { configured: true, from, to, mode, reason: null };
  if (mode !== 'smtp') return { configured: true, from, to, mode, reason: null };

  return {
    configured: false,
    from,
    to,
    mode: null,
    reason: 'SMTP is not configured (SMTP_HOST is unset).',
  };
}

function transportKey() {
  const config = mailerConfig();
  if (!config.configured) return null;
  return [
    config.mode,
    envValue('SMTP_HOST'),
    envValue('SMTP_PORT'),
    envValue('SMTP_USER'),
    smtpSecure() ? 'secure' : 'plain',
  ].join('|');
}

function buildTransport() {
  const config = mailerConfig();
  if (config.mode === 'json') {
    // nodemailer's JSON transport: renders the message, delivers nowhere.
    return nodemailer.createTransport({ jsonTransport: true });
  }
  if (config.mode === 'stream') {
    return nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  }
  const port = Number(envValue('SMTP_PORT') || '587');
  const user = envValue('SMTP_USER');
  const pass = process.env.SMTP_PASS ?? '';
  return nodemailer.createTransport({
    host: envValue('SMTP_HOST'),
    port: Number.isInteger(port) && port > 0 ? port : 587,
    secure: smtpSecure(),
    auth: user ? { user, pass: String(pass) } : undefined,
    pool: true,
    ...TIMEOUTS,
  });
}

function getTransport() {
  if (transportFactory) {
    if (!factoryTransport) factoryTransport = transportFactory();
    return factoryTransport;
  }
  const key = transportKey();
  if (!key) return null;
  if (!defaultTransport || defaultTransportKey !== key) {
    if (defaultTransport && typeof defaultTransport.close === 'function') {
      try { defaultTransport.close(); } catch { /* best effort */ }
    }
    defaultTransport = buildTransport();
    defaultTransportKey = key;
  }
  return defaultTransport;
}

/** Replace the transport construction (tests only). Pass null to restore. */
export function setTransportFactoryForTests(fn) {
  transportFactory = typeof fn === 'function' ? fn : null;
  factoryTransport = null;
}

/** Drop cached transports and the test factory. Tests only. */
export function resetTransportForTests() {
  transportFactory = null;
  factoryTransport = null;
  if (defaultTransport && typeof defaultTransport.close === 'function') {
    try { defaultTransport.close(); } catch { /* best effort */ }
  }
  defaultTransport = null;
  defaultTransportKey = null;
}

/**
 * Strip anything secret or unhelpfully long out of a delivery error.
 * SMTP_PASS (raw and URL-encoded) and `user:pass@host` URL credentials are
 * redacted before the message is stored or logged.
 */
export function safeErrorMessage(error) {
  let message;
  if (error && typeof error === 'object') {
    message = String(error.message ?? error.code ?? '');
  } else {
    message = String(error ?? '');
  }

  const secret = process.env.SMTP_PASS ? String(process.env.SMTP_PASS) : '';
  if (secret.length > 0) {
    message = message.split(secret).join('[redacted]');
    try {
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) message = message.split(encoded).join('[redacted]');
    } catch { /* encoding is best effort */ }
  }

  message = message
    .replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, '://$1:[redacted]@')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (message.length > 300) message = `${message.slice(0, 297)}...`;
  return message || 'Email delivery failed.';
}

function failure(error) {
  return { status: INQUIRY_EMAIL_STATUS.FAILED, messageId: null, error: safeErrorMessage(error) };
}

/**
 * Send one message. Never rejects; the caller gets a delivery result instead.
 * @returns {Promise<{status: 'SENT'|'FAILED'|'NOT_CONFIGURED', messageId: string|null, error: string|null}>}
 */
export async function sendMail({
  to = null, subject = '', text = '', html = null, replyTo = null,
} = {}) {
  let config;
  try {
    config = mailerConfig();
  } catch (error) {
    return failure(error);
  }

  if (!config.configured) {
    return {
      status: INQUIRY_EMAIL_STATUS.NOT_CONFIGURED,
      messageId: null,
      error: config.reason,
    };
  }

  const recipient = to ? String(to).trim() : config.to;
  if (!recipient) {
    return {
      status: INQUIRY_EMAIL_STATUS.FAILED,
      messageId: null,
      error: 'No recipient email address is available for this message.',
    };
  }

  try {
    const transport = getTransport();
    if (!transport) {
      return {
        status: INQUIRY_EMAIL_STATUS.NOT_CONFIGURED,
        messageId: null,
        error: 'SMTP is not configured (SMTP_HOST is unset).',
      };
    }
    const info = await transport.sendMail({
      from: config.from,
      to: recipient,
      subject: String(subject ?? '').slice(0, 300) || '(no subject)',
      text: String(text ?? ''),
      html: html === null || html === undefined ? undefined : String(html),
      replyTo: replyTo === null || replyTo === undefined ? undefined : String(replyTo),
    });
    return {
      status: INQUIRY_EMAIL_STATUS.SENT,
      messageId: info && info.messageId ? String(info.messageId) : null,
      error: null,
    };
  } catch (error) {
    return failure(error);
  }
}
