/**
 * Outbound SMS.
 *
 * The same honest delivery contract as the mailer: an unconfigured provider is
 * a normal state reported as NOT_CONFIGURED, a delivery problem is FAILED with
 * a short secret-free message, and nothing here ever throws into a booking
 * transaction.
 *
 * Providers (SMS_PROVIDER = textlk | notifylk | twilio). When SMS_PROVIDER is
 * unset, the first provider whose credentials are present is used.
 *
 * Text.lk (Sri Lanka)          TEXTLK_API_TOKEN, TEXTLK_SENDER_ID (demo: TextLKDemo)
 * Notify.lk (Sri Lanka)        NOTIFYLK_USER_ID, NOTIFYLK_API_KEY, NOTIFYLK_SENDER_ID (demo: NotifyDEMO)
 * Twilio Programmable Messaging:
 *   TWILIO_ACCOUNT_SID           AC...
 *   TWILIO_AUTH_TOKEN            or TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET
 *   TWILIO_MESSAGING_SERVICE_SID MG... (preferred), or
 *   TWILIO_FROM_NUMBER           an E.164 number / alphanumeric sender ID
 *   SMS_DEFAULT_COUNTRY_CODE     defaults to 94 (Sri Lanka) for local numbers
 *
 * Tests inject a sender with setSmsSenderForTests().
 */
const TIMEOUT_MS = 10000;
let testSender = null;

function env(name) {
  const raw = process.env[name];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

export function setSmsSenderForTests(fn) {
  testSender = typeof fn === 'function' ? fn : null;
}

function twilioCredentials() {
  const accountSid = env('TWILIO_ACCOUNT_SID');
  if (env('TWILIO_API_KEY_SID') && env('TWILIO_API_KEY_SECRET')) {
    return { accountSid, user: env('TWILIO_API_KEY_SID'), pass: env('TWILIO_API_KEY_SECRET') };
  }
  return { accountSid, user: accountSid, pass: env('TWILIO_AUTH_TOKEN') };
}

function chosenProvider() {
  const explicit = env('SMS_PROVIDER').toLowerCase();
  if (['textlk', 'notifylk', 'twilio'].includes(explicit)) return explicit;
  if (env('TEXTLK_API_TOKEN')) return 'textlk';
  if (env('NOTIFYLK_API_KEY')) return 'notifylk';
  return 'twilio';
}

export function smsConfig() {
  if (testSender) return { configured: true, provider: 'test', reason: null };
  const provider = chosenProvider();
  if (provider === 'textlk') {
    if (!env('TEXTLK_API_TOKEN')) return { configured: false, provider, reason: 'Set TEXTLK_API_TOKEN.' };
    if (!env('TEXTLK_SENDER_ID')) return { configured: false, provider, reason: 'Set TEXTLK_SENDER_ID (TextLKDemo for testing).' };
    return { configured: true, provider, reason: null };
  }
  if (provider === 'notifylk') {
    const ok = env('NOTIFYLK_USER_ID') && env('NOTIFYLK_API_KEY') && env('NOTIFYLK_SENDER_ID');
    return { configured: Boolean(ok), provider, reason: ok ? null : 'Set NOTIFYLK_USER_ID, NOTIFYLK_API_KEY and NOTIFYLK_SENDER_ID.' };
  }
  const { accountSid, user, pass } = twilioCredentials();
  const sender = env('TWILIO_MESSAGING_SERVICE_SID') || env('TWILIO_FROM_NUMBER');
  if (!accountSid && !pass) return { configured: false, provider: null, reason: 'SMS is not configured (TWILIO_ACCOUNT_SID is unset).' };
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) return { configured: false, provider: 'twilio', reason: 'TWILIO_ACCOUNT_SID must look like AC followed by 32 hex characters.' };
  if (!user || !pass) return { configured: false, provider: 'twilio', reason: 'Set TWILIO_AUTH_TOKEN (or TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET).' };
  if (!sender) return { configured: false, provider: 'twilio', reason: 'Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.' };
  return { configured: true, provider: 'twilio', reason: null };
}

/**
 * Normalise a Sri Lankan or international number to E.164:
 * "077 123 4567" -> "+94771234567". Returns null when it cannot be a mobile number.
 */
export function normalizeSmsNumber(value, { defaultCountryCode = env('SMS_DEFAULT_COUNTRY_CODE') || '94' } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const international = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (!international) {
    if (digits.startsWith('0')) digits = `${defaultCountryCode}${digits.slice(1)}`;
    else if (digits.length <= 9) digits = `${defaultCountryCode}${digits}`;
  }
  return /^\d{9,15}$/.test(digits) ? `+${digits}` : null;
}

function safeError(error) {
  let message = String(error?.message ?? error ?? 'SMS delivery failed.');
  for (const name of ['TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SECRET', 'TEXTLK_API_TOKEN', 'NOTIFYLK_API_KEY']) {
    const secret = env(name);
    if (secret.length >= 8) message = message.split(secret).join('[redacted]');
  }
  message = message.replace(/[\r\n\t]+/g, ' ').trim();
  return message.length > 200 ? `${message.slice(0, 197)}...` : message || 'SMS delivery failed.';
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

/** Text.lk OAuth API. Numbers are sent without the plus sign: 94771234567. */
async function sendViaTextLk({ to, message }) {
  const response = await fetch('https://app.text.lk/api/v3/sms/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('TEXTLK_API_TOKEN')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ recipient: to.replace(/^\+/, ''), sender_id: env('TEXTLK_SENDER_ID'), type: 'plain', message }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (!response.ok || payload?.status === false || payload?.status === 'error') {
    throw new Error(`Text.lk did not send the message (HTTP ${response.status})${payload?.message ? `: ${payload.message}` : ''}`);
  }
  return payload?.data?.sms_id ? String(payload.data.sms_id) : (payload?.data?.uid ? String(payload.data.uid) : null);
}

/** Notify.lk API. Numbers are sent as 9471XXXXXXX. */
async function sendViaNotifyLk({ to, message }) {
  const params = new URLSearchParams({
    user_id: env('NOTIFYLK_USER_ID'), api_key: env('NOTIFYLK_API_KEY'), sender_id: env('NOTIFYLK_SENDER_ID'),
    to: to.replace(/^\+/, ''), message,
  });
  const response = await fetch('https://app.notify.lk/api/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await readJson(response);
  if (!response.ok || String(payload?.status ?? '').toLowerCase() !== 'success') {
    throw new Error(`Notify.lk did not send the message (HTTP ${response.status})${payload?.message ? `: ${payload.message}` : ''}`);
  }
  return null;
}

async function sendViaTwilio({ to, message }) {
  const { accountSid, user, pass } = twilioCredentials();
  const params = new URLSearchParams({ To: to, Body: message });
  if (env('TWILIO_MESSAGING_SERVICE_SID')) params.set('MessagingServiceSid', env('TWILIO_MESSAGING_SERVICE_SID'));
  else params.set('From', env('TWILIO_FROM_NUMBER'));
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }
  if (!response.ok) {
    const code = payload?.code ? ` (Twilio error ${payload.code})` : '';
    throw new Error(`Twilio answered HTTP ${response.status}${code}${payload?.message ? `: ${payload.message}` : ''}`);
  }
  if (['failed', 'undelivered', 'canceled'].includes(String(payload?.status ?? ''))) {
    throw new Error(`Twilio did not accept the message (status ${payload.status}).`);
  }
  return payload?.sid ? String(payload.sid) : null;
}

/**
 * Send one text message. Never rejects.
 * @returns {Promise<{status:'SENT'|'FAILED'|'NOT_CONFIGURED'|'NO_ADDRESS', error:string|null, messageId?:string|null}>}
 */
export async function sendSms({ to, message } = {}) {
  const config = smsConfig();
  if (!config.configured) return { status: 'NOT_CONFIGURED', error: config.reason };
  const number = normalizeSmsNumber(to);
  if (!number) return { status: 'NO_ADDRESS', error: 'No valid mobile number is on file for this booking.' };
  const text = String(message ?? '').trim().slice(0, 600);
  if (!text) return { status: 'FAILED', error: 'The message was empty.' };
  try {
    if (testSender) {
      await testSender({ to: number, message: text });
      return { status: 'SENT', error: null, messageId: null };
    }
    const provider = config.provider;
    const messageId = provider === 'textlk' ? await sendViaTextLk({ to: number, message: text })
      : provider === 'notifylk' ? await sendViaNotifyLk({ to: number, message: text })
        : await sendViaTwilio({ to: number, message: text });
    return { status: 'SENT', error: null, messageId };
  } catch (error) {
    return { status: 'FAILED', error: safeError(error) };
  }
}
