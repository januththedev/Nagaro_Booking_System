/**
 * Smart-access policy and per-room door configuration.
 *
 * One `access_policy` row holds the administrator-configured defaults; a
 * `space_access_config` row may override them for a single room and names the
 * door controller that room uses. `effectiveAccessConfig()` is the only place
 * the two are merged, so every caller sees the same resolved rules.
 */
import { withWriteTransaction } from '../db/connection.js';
import { isAdminRole } from '../domain/constants.js';
import { forbidden, notFound, validationError } from '../domain/errors.js';
import { recordAudit } from './auditService.js';

export const DOOR_DRIVER = Object.freeze({ NONE: 'NONE', HTTP: 'HTTP', SIMULATED: 'SIMULATED' });
export const UNLOCK_MINUTE_OPTIONS = Object.freeze([5, 15, 30]);
export const EXTENSION_MINUTES = 15;

function bool(value) { return Number(value) === 1; }
function nullableBool(value) { return value === null || value === undefined ? null : Number(value) === 1; }
function nullableInt(value) { return value === null || value === undefined ? null : Number(value); }

export function getAccessPolicy(db) {
  const row = db.prepare('SELECT * FROM access_policy WHERE id = 1').get();
  if (!row) throw new Error('The access policy row is missing. Run the database migrations.');
  return {
    linksEnabled: bool(row.links_enabled),
    earlyAccessMinutes: Number(row.early_access_minutes),
    linkRetentionMinutes: Number(row.link_retention_minutes),
    defaultUnlockMinutes: Number(row.default_unlock_minutes),
    allowUntilEnd: bool(row.allow_until_end),
    requirePhoneCheck: bool(row.require_phone_check),
    extensionsEnabled: bool(row.extensions_enabled),
    surchargeBps: Number(row.surcharge_bps),
    maxExtensions: Number(row.max_extensions),
    maxExtensionMinutes: Number(row.max_extension_minutes),
    requireApproval: bool(row.require_approval),
    payOnlineEnabled: bool(row.pay_online_enabled),
    payDeskEnabled: bool(row.pay_desk_enabled),
    minPaymentCents: Number(row.min_payment_cents),
    offerBeforeEndMinutes: Number(row.offer_before_end_minutes),
    lateGraceMinutes: Number(row.late_grace_minutes),
    lateWindowMinutes: Number(row.late_window_minutes),
    paymentHoldMinutes: Number(row.payment_hold_minutes),
    updatedAt: Number(row.updated_at),
  };
}

export function getSpaceAccessConfig(db, spaceId) {
  const row = db.prepare('SELECT * FROM space_access_config WHERE space_id = ?').get(Number(spaceId));
  return {
    spaceId: Number(spaceId),
    exists: Boolean(row),
    linksEnabled: nullableBool(row?.links_enabled),
    doorEnabled: bool(row?.door_enabled ?? 0),
    driver: row?.driver ?? DOOR_DRIVER.NONE,
    endpointUrl: row?.endpoint_url ?? null,
    doorIdentifier: row?.door_identifier ?? null,
    confirmsState: bool(row?.confirms_state ?? 1),
    allowUntilEnd: nullableBool(row?.allow_until_end),
    extensionsEnabled: nullableBool(row?.extensions_enabled),
    surchargeBps: nullableInt(row?.surcharge_bps),
    extensionBaseCents: nullableInt(row?.extension_base_cents),
  };
}

/** Policy with the room's overrides applied. */
export function effectiveAccessConfig(db, spaceId) {
  const policy = getAccessPolicy(db);
  const room = getSpaceAccessConfig(db, spaceId);
  const doorReady = room.doorEnabled && room.driver !== DOOR_DRIVER.NONE
    && (room.driver !== DOOR_DRIVER.HTTP || Boolean(room.endpointUrl && room.doorIdentifier));
  return {
    policy,
    room,
    linksEnabled: room.linksEnabled ?? policy.linksEnabled,
    doorReady,
    allowUntilEnd: room.allowUntilEnd ?? policy.allowUntilEnd,
    extensionsEnabled: room.extensionsEnabled ?? policy.extensionsEnabled,
    surchargeBps: room.surchargeBps ?? policy.surchargeBps,
  };
}

/* ------------------------------------------------------------- validation */

function first(value) { return Array.isArray(value) ? value[0] : value; }

function intField(body, name, { min, max, label }) {
  const raw = first(body[name]);
  const value = Number(raw);
  if (raw === undefined || raw === null || String(raw).trim() === '' || !Number.isInteger(value) || value < min || value > max) {
    throw validationError(`${label} must be a whole number between ${min} and ${max}.`, { [name]: `Enter a value between ${min} and ${max}.` });
  }
  return value;
}

function flagField(body, name) {
  const raw = first(body[name]);
  return ['1', 'true', 'on', 'yes'].includes(String(raw ?? '').trim().toLowerCase()) ? 1 : 0;
}

/**
 * Parse a percentage typed by a person ("20", "12.5") into basis points
 * without floating-point arithmetic. At most two decimal places are accepted.
 */
export function percentToBps(input, { field = 'surcharge_percent', max = 500 } = {}) {
  const text = String(first(input) ?? '').trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw validationError('Enter the surcharge as a percentage with at most two decimal places.', { [field]: 'Enter a percentage such as 20 or 12.5.' });
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0);
  if (bps > max * 100) throw validationError(`The surcharge cannot exceed ${max}%.`, { [field]: `Enter ${max} or less.` });
  return bps;
}

/** Parse "1,250.50" style LKR input into integer cents. */
export function moneyToCents(input, { field = 'amount', maxCents = 100_000_000 } = {}) {
  const text = String(first(input) ?? '').trim().replace(/,/g, '');
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw validationError('Enter an amount in rupees with at most two decimal places.', { [field]: 'Enter an amount such as 250 or 250.50.' });
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0);
  if (cents > maxCents) throw validationError('That amount is too large.', { [field]: 'Enter a smaller amount.' });
  return cents;
}

export function bpsToPercentText(bps) {
  const value = Number(bps) || 0;
  const whole = Math.trunc(value / 100);
  const fraction = value % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}

/* ---------------------------------------------------------------- updates */

export function updateAccessPolicy(db, { actor, body = {}, now = Date.now() } = {}) {
  if (!actor?.id || !isAdminRole(actor.role)) throw forbidden('Changing the access policy requires an administrator role.');
  const next = {
    links_enabled: flagField(body, 'links_enabled'),
    early_access_minutes: intField(body, 'early_access_minutes', { min: 0, max: 120, label: 'Early access' }),
    link_retention_minutes: intField(body, 'link_retention_hours', { min: 1, max: 720, label: 'Link retention' }) * 60,
    default_unlock_minutes: intField(body, 'default_unlock_minutes', { min: 5, max: 30, label: 'Default unlock duration' }),
    allow_until_end: flagField(body, 'allow_until_end'),
    require_phone_check: flagField(body, 'require_phone_check'),
    extensions_enabled: flagField(body, 'extensions_enabled'),
    surcharge_bps: percentToBps(body.surcharge_percent),
    max_extensions: intField(body, 'max_extensions', { min: 0, max: 48, label: 'Maximum extensions' }),
    max_extension_minutes: intField(body, 'max_extension_minutes', { min: 0, max: 720, label: 'Maximum added time' }),
    require_approval: flagField(body, 'require_approval'),
    pay_online_enabled: flagField(body, 'pay_online_enabled'),
    pay_desk_enabled: flagField(body, 'pay_desk_enabled'),
    min_payment_cents: moneyToCents(body.min_payment_lkr ?? '0', { field: 'min_payment_lkr' }),
    offer_before_end_minutes: intField(body, 'offer_before_end_minutes', { min: 0, max: 120, label: 'Offer window before the end' }),
    late_grace_minutes: intField(body, 'late_grace_minutes', { min: 0, max: 14, label: 'Late-payment tolerance' }),
    late_window_minutes: intField(body, 'late_window_minutes', { min: 0, max: 720, label: 'Late extension window' }),
    payment_hold_minutes: intField(body, 'payment_hold_minutes', { min: 3, max: 60, label: 'Payment hold' }),
  };
  if (!UNLOCK_MINUTE_OPTIONS.includes(next.default_unlock_minutes)) {
    throw validationError('Choose 5, 15 or 30 minutes as the default unlock duration.', { default_unlock_minutes: 'Choose 5, 15 or 30.' });
  }
  if (next.extensions_enabled && !next.pay_online_enabled && !next.pay_desk_enabled) {
    throw validationError('Enable at least one payment method for extensions.', { pay_online_enabled: 'Choose online payment, front-desk payment, or both.' });
  }
  return withWriteTransaction(db, () => {
    const columns = Object.keys(next);
    db.prepare(`UPDATE access_policy SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = ? WHERE id = 1`)
      .run(...columns.map((c) => next[c]), actor.id, now);
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label ?? actor.displayName ?? 'administrator',
      action: 'access_policy.updated', entityType: 'access_policy', entityId: 1,
      summary: 'Updated the room access and extension policy', details: next,
    });
    return getAccessPolicy(db);
  });
}

function overrideFlag(body, name) {
  const raw = String(first(body[name]) ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'inherit') return null;
  return ['1', 'true', 'on', 'yes'].includes(raw) ? 1 : 0;
}

/** HTTPS is required for a controller endpoint outside local development. */
export function validateControllerUrl(value, env = process.env) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { throw validationError('Enter a valid controller URL.', { endpoint_url: 'Enter an absolute https:// address.' }); }
  if (url.username || url.password) throw validationError('The controller URL must not contain credentials.', { endpoint_url: 'Remove the user name and password.' });
  const insecureAllowed = env.NAGARO_DOOR_ALLOW_HTTP === '1' || (env.NODE_ENV ?? 'development') !== 'production';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecureAllowed)) {
    throw validationError('The controller URL must use HTTPS.', { endpoint_url: 'Use an https:// address.' });
  }
  if (text.length > 500) throw validationError('The controller URL is too long.', { endpoint_url: 'Use 500 characters or fewer.' });
  return url.toString();
}

export function updateSpaceAccessConfig(db, { actor, spaceId, body = {}, now = Date.now(), env = process.env } = {}) {
  if (!actor?.id || !isAdminRole(actor.role)) throw forbidden('Configuring a door controller requires an administrator role.');
  const id = Number(spaceId);
  const space = db.prepare('SELECT id, code, name FROM space WHERE id = ?').get(id);
  if (!space) throw notFound('Space not found.');

  const driver = String(first(body.driver) ?? DOOR_DRIVER.NONE).trim().toUpperCase();
  if (!Object.values(DOOR_DRIVER).includes(driver)) throw validationError('Choose a valid door controller type.', { driver: 'Choose a controller type.' });
  if (driver === DOOR_DRIVER.SIMULATED && env.NAGARO_DOOR_SIMULATOR !== '1') {
    throw validationError('The simulated controller is only available when NAGARO_DOOR_SIMULATOR=1 is set. It never operates a real door.', { driver: 'Not available in this environment.' });
  }
  const endpointUrl = driver === DOOR_DRIVER.HTTP ? validateControllerUrl(first(body.endpoint_url), env) : null;
  const identifierRaw = String(first(body.door_identifier) ?? '').trim();
  if (identifierRaw && !/^[A-Za-z0-9._:-]{1,80}$/.test(identifierRaw)) {
    throw validationError('The door identifier may contain letters, digits, dots, dashes, colons and underscores only.', { door_identifier: 'Use up to 80 simple characters.' });
  }
  const doorIdentifier = identifierRaw || (driver === DOOR_DRIVER.NONE ? null : space.code);
  const doorEnabled = flagField(body, 'door_enabled');
  if (doorEnabled && driver === DOOR_DRIVER.NONE) throw validationError('Choose a controller type before enabling door control.', { driver: 'Choose a controller type.' });
  if (doorEnabled && driver === DOOR_DRIVER.HTTP && !endpointUrl) throw validationError('Enter the controller URL before enabling door control.', { endpoint_url: 'Enter the controller address.' });

  const surchargeText = String(first(body.surcharge_percent) ?? '').trim();
  const baseText = String(first(body.extension_base_lkr) ?? '').trim();
  const values = {
    links_enabled: overrideFlag(body, 'links_enabled'),
    door_enabled: doorEnabled,
    driver,
    endpoint_url: endpointUrl,
    door_identifier: doorIdentifier,
    confirms_state: flagField(body, 'confirms_state'),
    allow_until_end: overrideFlag(body, 'allow_until_end'),
    extensions_enabled: overrideFlag(body, 'extensions_enabled'),
    surcharge_bps: surchargeText === '' ? null : percentToBps(surchargeText),
    extension_base_cents: baseText === '' ? null : moneyToCents(baseText, { field: 'extension_base_lkr' }),
  };

  return withWriteTransaction(db, () => {
    if (doorIdentifier) {
      const clash = db.prepare('SELECT space_id FROM space_access_config WHERE door_identifier = ? AND space_id <> ?').get(doorIdentifier, id);
      if (clash) throw validationError('Another room already uses that door identifier.', { door_identifier: 'Choose an identifier unique to this door.' });
    }
    const columns = Object.keys(values);
    db.prepare(`INSERT INTO space_access_config (space_id, ${columns.join(', ')}, updated_by, updated_at)
      VALUES (?, ${columns.map(() => '?').join(', ')}, ?, ?)
      ON CONFLICT (space_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')},
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(id, ...columns.map((c) => values[c]), actor.id, now);
    db.prepare(`INSERT INTO door_state (space_id, updated_at) VALUES (?, ?) ON CONFLICT (space_id) DO NOTHING`).run(id, now);
    recordAudit(db, {
      actorAdminUserId: actor.id, actorLabel: actor.label ?? actor.displayName ?? 'administrator',
      action: 'space_access_config.updated', entityType: 'space', entityId: id,
      summary: `Updated door access settings for ${space.code}`,
      details: { ...values, endpoint_url: endpointUrl ? new URL(endpointUrl).origin : null },
    });
    return getSpaceAccessConfig(db, id);
  });
}
