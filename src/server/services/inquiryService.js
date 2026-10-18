/**
 * Public booking inquiries (request-to-book).
 *
 * An inquiry NEVER reserves inventory. It is a durable record of what a
 * visitor asked for, plus an honest record of whether the notification email
 * was delivered. Staff convert it to a real reservation manually.
 *
 * Delivery contract (the part that matters most):
 *   1. The inquiry row is committed first, in its own write transaction.
 *   2. Only after that commit is email attempted.
 *   3. Delivery outcome is written back in a second, small transaction.
 * If the process dies between steps 1 and 3 the inquiry still exists with
 * `email_status = 'PENDING'` - never lost, never falsely reported as sent.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { withWriteTransaction } from '../db/connection.js';
import { nextReference, randomToken } from '../domain/references.js';
import {
  INQUIRY_EMAIL_STATUS, INQUIRY_STATUS, INQUIRY_STATUS_LABEL,
  SPACE_CATEGORY, SPACE_CATEGORY_LABEL, SPACE_STATUS,
} from '../domain/constants.js';
import { conflict, notFound, validationError } from '../domain/errors.js';
import {
  asInteger, asTrimmedString, LIMITS, normalizeEmail, oneOf, optionalPhone,
  parseBookingWindow, requiredEmail, requiredString,
} from '../domain/validation.js';
import { businessLocalToEpoch, coerceEpochMs, MS } from '../domain/time.js';
import { availabilityLabel, getSpaceAvailability } from './availabilityService.js';
import { recordAudit } from './auditService.js';
import { mailerConfig, safeErrorMessage, sendMail } from '../mail/mailer.js';
import { inquiryAcknowledgementEmail, inquiryNotificationEmail } from '../mail/templates.js';
import { enforcePublicInquiryLimits } from '../security/rateLimit.js';

const ONE_YEAR_MS = 365 * MS.DAY;

/** Default mailer: the real module, injectable in tests. */
const defaultMailer = { sendMail, mailerConfig };

const INQUIRY_SELECT = `
  SELECT i.*,
         s.code     AS space_code,
         s.name     AS space_name,
         s.category AS space_category,
         s.status   AS space_status,
         r.reference AS converted_reservation_reference,
         r.status    AS converted_reservation_status
    FROM inquiry i
    LEFT JOIN space s ON s.id = i.space_id
    LEFT JOIN reservation r ON r.id = i.converted_reservation_id
`;

/* ------------------------------------------------------------------ helpers */

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function tokenMatches(token, storedHash) {
  try {
    const expected = Buffer.from(String(storedHash ?? ''), 'hex');
    const actual = Buffer.from(hashToken(token), 'hex');
    if (expected.length === 0 || expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function clampLimit(value, fallback = 50, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

/** Accept `YYYY-MM-DD` (business date) or an epoch/ISO instant. */
function resolveBoundary(value, { endOfDay = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    try {
      const start = businessLocalToEpoch(raw, '00:00');
      return endOfDay ? start + MS.DAY : start;
    } catch {
      return null;
    }
  }
  return coerceEpochMs(raw);
}

function likePattern(query) {
  return `%${String(query).trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/* ------------------------------------------------------------- hydration */

export function hydrateInquiry(row) {
  if (!row) return null;
  const status = row.status;
  const category = row.space_category ?? null;
  return {
    id: row.id,
    reference: row.reference,
    status,
    statusLabel: INQUIRY_STATUS_LABEL[status] ?? status,
    spaceId: row.space_id ?? null,
    spaceCode: row.space_code ?? null,
    spaceName: row.space_name ?? null,
    category,
    categoryLabel: category ? (SPACE_CATEGORY_LABEL[category] ?? category) : null,
    spaceStatus: row.space_status ?? null,
    customerName: row.customer_name,
    email: row.email,
    emailNormalized: row.email_normalized,
    phone: row.phone ?? null,
    organization: row.organization ?? null,
    startAt: row.requested_start_at,
    endAt: row.requested_end_at,
    attendees: row.attendees ?? null,
    deskQuantity: row.desk_quantity ?? null,
    message: row.message ?? null,
    emailStatus: row.email_status,
    emailError: row.email_error ?? null,
    emailAttemptedAt: row.email_attempted_at ?? null,
    emailMessageId: row.email_message_id ?? null,
    internalNotes: row.internal_notes ?? null,
    hasWithdrawToken: Boolean(row.withdraw_token_hash),
    convertedReservationId: row.converted_reservation_id ?? null,
    convertedReservationReference: row.converted_reservation_reference ?? null,
    convertedReservationStatus: row.converted_reservation_status ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    availability: null,
  };
}

/* ------------------------------------------------------------ validation */

/**
 * Validate the public request-to-book form.
 *
 * Accepts either explicit instants (`requested_start_at` / `requested_end_at`
 * as epoch ms or ISO-8601) or a date + time window (`date`, `start_time`,
 * `end_time`) which is normalised through `parseBookingWindow`.
 *
 * @returns {{customerName: string, email: string, emailNormalized: string,
 *   phone: string|null, organization: string|null,
 *   spaceId: number|null, spaceCode: string|null,
 *   startAt: number, endAt: number,
 *   attendees: number|null, deskQuantity: number|null, message: string|null}}
 */
export function parseInquiryPayload(input = {}, { now = Date.now() } = {}) {
  const source = input ?? {};
  const errors = {};
  const value = {};

  const capture = (field, fn) => {
    try {
      fn();
    } catch (error) {
      if (error && error.code === 'VALIDATION_ERROR') {
        const key = error.details?.field || field;
        errors[key] = errors[key] ?? error.message;
      } else {
        errors._ = error.message;
      }
    }
  };

  capture('customer_name', () => {
    value.customerName = requiredString(
      source.customer_name ?? source.name,
      { field: 'customer_name', max: LIMITS.maxNameLength },
    );
  });

  capture('email', () => {
    const email = requiredEmail(source.email, { field: 'email' });
    value.email = email;
    value.emailNormalized = normalizeEmail(email);
  });

  capture('phone', () => {
    value.phone = optionalPhone(source.phone, { field: 'phone' });
  });

  capture('organization', () => {
    value.organization = asTrimmedString(source.organization, {
      field: 'organization', max: LIMITS.maxNameLength,
    });
  });

  capture('space_id', () => {
    const raw = source.space_id ?? source.spaceId;
    value.spaceId = raw === null || raw === undefined || raw === ''
      ? null
      : asInteger(raw, { field: 'space_id', min: 1, required: true });
  });

  capture('space_code', () => {
    const code = asTrimmedString(source.space_code ?? source.spaceCode, {
      field: 'space_code', max: 40,
    });
    value.spaceCode = code ? code : null;
  });

  if (!value.spaceId && !value.spaceCode) {
    errors.space_id = errors.space_id ?? 'Choose a space to request.';
  }

  capture('start_at', () => {
    const window = parseBookingWindow({
      start_at: source.requested_start_at ?? source.start_at ?? source.requestedStartAt ?? source.startAt ?? null,
      end_at: source.requested_end_at ?? source.end_at ?? source.requestedEndAt ?? source.endAt ?? null,
      date: source.date ?? null,
      start_time: source.start_time ?? source.start ?? null,
      end_time: source.end_time ?? source.end ?? null,
    });
    if (window.startAt < now - ONE_YEAR_MS) {
      throw validationError('The requested date is more than one year in the past.', { field: 'start_at' });
    }
    if (window.startAt > now + ONE_YEAR_MS) {
      throw validationError('Requests can be made at most one year in advance.', { field: 'start_at' });
    }
    value.startAt = window.startAt;
    value.endAt = window.endAt;
  });

  capture('attendees', () => {
    value.attendees = asInteger(source.attendees, { field: 'attendees', min: 0, max: 100000 });
  });

  capture('desk_quantity', () => {
    value.deskQuantity = asInteger(source.desk_quantity ?? source.deskQuantity, {
      field: 'desk_quantity', min: 1, max: 5000,
    });
  });

  capture('message', () => {
    value.message = asTrimmedString(source.message, { field: 'message', max: LIMITS.maxTextLength });
  });

  if (Object.keys(errors).length > 0) {
    throw validationError('Please correct the highlighted fields.', errors);
  }

  return {
    customerName: value.customerName,
    email: value.email,
    emailNormalized: value.emailNormalized,
    phone: value.phone ?? null,
    organization: value.organization ?? null,
    spaceId: value.spaceId ?? null,
    spaceCode: value.spaceCode ?? null,
    startAt: value.startAt,
    endAt: value.endAt,
    attendees: value.attendees ?? null,
    deskQuantity: value.deskQuantity ?? null,
    message: value.message ?? null,
  };
}

/* -------------------------------------------------------------- reads */

export function getInquiry(db, id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  const row = db.prepare(`${INQUIRY_SELECT} WHERE i.id = ?`).get(numeric);
  return row ? hydrateInquiry(row) : null;
}

export function getInquiryByReference(db, reference) {
  const ref = String(reference ?? '').trim();
  if (!ref) return null;
  const row = db.prepare(`${INQUIRY_SELECT} WHERE i.reference = ? COLLATE NOCASE`).get(ref);
  return row ? hydrateInquiry(row) : null;
}

/**
 * Staff-only queue. Filters: status, space, free text, requested-start date
 * range, sort and pagination. Public routes must never call this.
 */
export function listInquiries(db, {
  status = null, spaceId = null, search = null, fromDate = null, toDate = null,
  limit = 50, offset = 0, sort = 'newest',
} = {}) {
  const where = [];
  const params = [];

  if (status && String(status).toUpperCase() !== 'ALL') {
    where.push('i.status = ?');
    params.push(oneOf(status, Object.values(INQUIRY_STATUS), { field: 'status' }));
  }
  if (spaceId) {
    where.push('i.space_id = ?');
    params.push(Number(spaceId));
  }
  const query = search ? String(search).trim() : '';
  if (query) {
    const like = likePattern(query);
    where.push(`(i.reference LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR i.customer_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR i.email LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR i.organization LIKE ? ESCAPE '\\' COLLATE NOCASE
                 OR i.phone LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like, like);
  }
  const from = resolveBoundary(fromDate);
  if (from !== null) {
    where.push('i.requested_start_at >= ?');
    params.push(from);
  }
  const to = resolveBoundary(toDate, { endOfDay: true });
  if (to !== null) {
    where.push('i.requested_start_at < ?');
    params.push(to);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy = {
    newest: 'i.created_at DESC, i.id DESC',
    oldest: 'i.created_at ASC, i.id ASC',
    start: 'i.requested_start_at ASC, i.id ASC',
    start_desc: 'i.requested_start_at DESC, i.id DESC',
    status: 'i.status ASC, i.created_at DESC, i.id DESC',
  }[sort] ?? 'i.created_at DESC, i.id DESC';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM inquiry i ${clause}`).get(...params).c;
  const rows = db.prepare(`${INQUIRY_SELECT} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, clampLimit(limit), Math.max(0, Number(offset) || 0));

  return { total, items: rows.map(hydrateInquiry) };
}

export function inquiryStats(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = '${INQUIRY_STATUS.NEW}' THEN 1 ELSE 0 END) AS new_count,
           SUM(CASE WHEN status = '${INQUIRY_STATUS.CONTACTED}' THEN 1 ELSE 0 END) AS contacted,
           SUM(CASE WHEN status = '${INQUIRY_STATUS.CONVERTED}' THEN 1 ELSE 0 END) AS converted,
           SUM(CASE WHEN status = '${INQUIRY_STATUS.CLOSED}' THEN 1 ELSE 0 END) AS closed,
           SUM(CASE WHEN status = '${INQUIRY_STATUS.WITHDRAWN}' THEN 1 ELSE 0 END) AS withdrawn,
           SUM(CASE WHEN email_status IN ('${INQUIRY_EMAIL_STATUS.FAILED}','${INQUIRY_EMAIL_STATUS.NOT_CONFIGURED}')
                    THEN 1 ELSE 0 END) AS email_not_delivered
      FROM inquiry
  `).get();

  return {
    new: row.new_count ?? 0,
    contacted: row.contacted ?? 0,
    converted: row.converted ?? 0,
    closed: row.closed ?? 0,
    withdrawn: row.withdrawn ?? 0,
    total: row.total ?? 0,
    emailNotDelivered: row.email_not_delivered ?? 0,
  };
}

/* -------------------------------------------------------- submit (public) */

/** Resolve the requested space and require it to be publicly bookable. */
function resolvePublishedSpace(db, { spaceId, spaceCode }) {
  let row = null;
  let field = 'space_id';
  if (spaceId) {
    row = db.prepare('SELECT * FROM space WHERE id = ?').get(Number(spaceId));
    field = 'space_id';
  } else if (spaceCode) {
    row = db.prepare('SELECT * FROM space WHERE code = ? COLLATE NOCASE').get(String(spaceCode).trim());
    field = 'space_code';
  }
  if (!row) {
    const message = 'Select a space from the published catalogue.';
    throw validationError(message, { [field]: message });
  }
  if (row.status !== SPACE_STATUS.PUBLISHED) {
    const message = 'This space is not currently accepting booking requests.';
    throw validationError(message, { [field]: message });
  }
  return row;
}

function availabilitySnapshot(db, inquiry) {
  if (!inquiry || !inquiry.spaceId) return null;
  const deskCount = inquiry.category === SPACE_CATEGORY.COWORKING
    ? Math.max(1, Number(inquiry.deskQuantity ?? 1) || 1)
    : 1;
  try {
    const availability = getSpaceAvailability(db, {
      spaceId: inquiry.spaceId,
      startAt: inquiry.startAt,
      endAt: inquiry.endAt,
      deskCount,
      includeConflicts: false,
    });
    return {
      isAvailable: availability.isAvailable,
      freeUnits: availability.freeUnits,
      totalUnits: availability.totalUnits,
      requestedUnits: availability.requestedUnits,
      label: availabilityLabel(availability),
    };
  } catch {
    // The inquiry is already committed; never fail the submission because a
    // read-only availability preview could not be computed.
    return null;
  }
}

async function callMailer(mailer, message) {
  try {
    const result = await mailer.sendMail(message);
    return {
      status: result?.status ?? INQUIRY_EMAIL_STATUS.FAILED,
      messageId: result?.messageId ?? null,
      error: result?.error ?? null,
    };
  } catch (error) {
    // A delivery problem must never escape: the inquiry is already committed.
    return {
      status: INQUIRY_EMAIL_STATUS.FAILED,
      messageId: null,
      error: safeErrorMessage(error),
    };
  }
}

function notificationRecipient(mailer) {
  try {
    if (mailer && typeof mailer.mailerConfig === 'function') {
      return mailer.mailerConfig()?.to ?? null;
    }
  } catch { /* fall through to the real config */ }
  try {
    return mailerConfig().to ?? null;
  } catch {
    return null;
  }
}

/**
 * Send the staff notification and the visitor acknowledgement, then collapse
 * both outcomes into the single `email_status` the schema stores.
 * SENT only when every part was actually delivered.
 */
async function deliverInquiryEmails({ mailer, inquiry, space, baseUrl }) {
  const notification = await callMailer(mailer, {
    to: notificationRecipient(mailer),
    ...inquiryNotificationEmail({ inquiry, space, baseUrl }),
  });
  const acknowledgement = await callMailer(mailer, {
    to: inquiry.email,
    ...inquiryAcknowledgementEmail({ inquiry, space, baseUrl }),
  });

  const results = [notification, acknowledgement];
  let status;
  if (results.every((r) => r.status === INQUIRY_EMAIL_STATUS.SENT)) {
    status = INQUIRY_EMAIL_STATUS.SENT;
  } else if (results.every((r) => r.status === INQUIRY_EMAIL_STATUS.NOT_CONFIGURED)) {
    status = INQUIRY_EMAIL_STATUS.NOT_CONFIGURED;
  } else if (results.some((r) => r.status === INQUIRY_EMAIL_STATUS.FAILED)) {
    status = INQUIRY_EMAIL_STATUS.FAILED;
  } else {
    // Mixed SENT / NOT_CONFIGURED: some part of delivery is unavailable.
    status = INQUIRY_EMAIL_STATUS.NOT_CONFIGURED;
  }
  const failure = results.find((r) => r.status !== INQUIRY_EMAIL_STATUS.SENT && r.error);
  const delivered = results.find((r) => r.status === INQUIRY_EMAIL_STATUS.SENT);

  return {
    status,
    messageId: delivered?.messageId ?? null,
    error: failure?.error ?? null,
  };
}

/**
 * Accept a public request-to-book.
 *
 * Order is deliberate: validate -> rate limit -> persist (transaction) ->
 * attempt email (outside the transaction) -> record delivery outcome.
 *
 * @returns {{inquiry: object, email: {status: string, error: string|null}}}
 */
export async function submitInquiry(db, {
  payload,
  ip = null,
  mailer = defaultMailer,
  now = Date.now(),
  baseUrl = null,
  enforceRateLimit = true,
} = {}) {
  const value = parseInquiryPayload(payload, { now });

  if (ip && enforceRateLimit) {
    enforcePublicInquiryLimits(db, { ip, email: value.email, now });
  }

  const withdrawToken = randomToken(24);
  const withdrawTokenHash = hashToken(withdrawToken);
  const createdAt = Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : Date.now();

  // ---- 1. Persist the inquiry. Nothing about email happens in here. ----
  const created = withWriteTransaction(db, () => {
    const space = resolvePublishedSpace(db, value);
    const reference = nextReference(db, 'inquiry', createdAt);

    const info = db.prepare(`
      INSERT INTO inquiry
        (reference, space_id, customer_name, email, email_normalized, phone, organization,
         requested_start_at, requested_end_at, attendees, desk_quantity, message,
         status, withdraw_token_hash, email_status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      reference,
      space.id,
      value.customerName,
      value.email,
      value.emailNormalized,
      value.phone,
      value.organization,
      value.startAt,
      value.endAt,
      value.attendees,
      value.deskQuantity,
      value.message,
      INQUIRY_STATUS.NEW,
      withdrawTokenHash,
      INQUIRY_EMAIL_STATUS.PENDING,
      createdAt,
      createdAt,
    );
    const id = Number(info.lastInsertRowid);

    recordAudit(db, {
      at: createdAt,
      actorLabel: `${value.customerName} <${value.email}>`,
      action: 'inquiry.received',
      entityType: 'inquiry',
      entityId: id,
      summary: `Received ${reference} for ${space.code}`,
      details: {
        reference,
        spaceId: space.id,
        spaceCode: space.code,
        startAt: value.startAt,
        endAt: value.endAt,
        attendees: value.attendees,
        deskQuantity: value.deskQuantity,
      },
    });

    return { id, reference, space };
  });

  // ---- 2. Attempt delivery only after the row is committed. ----
  const fresh = getInquiry(db, created.id);
  if (!fresh) throw notFound('Inquiry not found.');
  fresh.withdrawToken = withdrawToken;

  let delivery;
  try {
    delivery = await deliverInquiryEmails({
      mailer,
      inquiry: fresh,
      space: created.space,
      baseUrl,
    });
  } catch (error) {
    // Defensive: deliverInquiryEmails already catches transport errors.
    delivery = {
      status: INQUIRY_EMAIL_STATUS.FAILED,
      messageId: null,
      error: safeErrorMessage(error),
    };
  }

  // ---- 3. Record the honest delivery outcome. ----
  const attemptedAt = Date.now();
  withWriteTransaction(db, () => {
    db.prepare(`
      UPDATE inquiry
         SET email_status = ?, email_error = ?, email_attempted_at = ?, email_message_id = ?,
             updated_at = ?
       WHERE id = ?
    `).run(
      delivery.status,
      delivery.error,
      attemptedAt,
      delivery.messageId,
      attemptedAt,
      created.id,
    );
  });

  const inquiry = getInquiry(db, created.id);
  if (!inquiry) throw notFound('Inquiry not found.');
  inquiry.withdrawToken = withdrawToken;
  inquiry.availability = availabilitySnapshot(db, inquiry);

  return {
    inquiry,
    email: { status: delivery.status, error: delivery.error },
  };
}

/* ---------------------------------------------------------- staff actions */

export function updateInquiryStatus(db, {
  actor, inquiryId, status = null, internalNotes,
} = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(inquiryId);
  if (!Number.isInteger(id) || id < 1) {
    throw validationError('A valid inquiry id is required.', { field: 'inquiry_id' });
  }

  const hasStatus = status !== null && status !== undefined && String(status).trim() !== '';
  const hasNotes = internalNotes !== undefined && internalNotes !== null;
  if (!hasStatus && !hasNotes) {
    throw validationError('Provide a status or internal notes to update.', { field: 'status' });
  }
  const nextStatus = hasStatus
    ? oneOf(status, Object.values(INQUIRY_STATUS), { field: 'status' })
    : null;
  const notes = hasNotes
    ? asTrimmedString(internalNotes, { field: 'internal_notes', max: LIMITS.maxLongTextLength })
    : null;

  return withWriteTransaction(db, () => {
    const current = db.prepare('SELECT * FROM inquiry WHERE id = ?').get(id);
    if (!current) throw notFound('Inquiry not found.');

    if (
      current.status === INQUIRY_STATUS.WITHDRAWN
      && nextStatus
      && nextStatus !== INQUIRY_STATUS.WITHDRAWN
    ) {
      throw conflict(
        'This inquiry was withdrawn by the visitor and cannot be reopened. Ask the visitor to submit a new request.',
      );
    }

    const effectiveStatus = nextStatus ?? current.status;
    const effectiveNotes = hasNotes ? (notes ?? null) : (current.internal_notes ?? null);
    const statusChanged = effectiveStatus !== current.status;
    const notesChanged = (effectiveNotes ?? null) !== (current.internal_notes ?? null);

    if (!statusChanged && !notesChanged) {
      return getInquiry(db, id);
    }

    const now = Date.now();
    db.prepare('UPDATE inquiry SET status = ?, internal_notes = ?, updated_at = ? WHERE id = ?')
      .run(effectiveStatus, effectiveNotes, now, id);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'inquiry.status_changed',
      entityType: 'inquiry',
      entityId: id,
      summary: statusChanged
        ? `Changed ${current.reference} from ${current.status} to ${effectiveStatus}`
        : `Updated internal notes on ${current.reference}`,
      details: {
        reference: current.reference,
        from: current.status,
        to: effectiveStatus,
        internalNotesChanged: notesChanged,
      },
    });

    return getInquiry(db, id);
  });
}

/**
 * Visitor withdrawal. Requires the matching reference AND withdraw token;
 * a wrong token is indistinguishable from an unknown reference on purpose.
 */
export function withdrawInquiry(db, { reference, token } = {}) {
  const ref = String(reference ?? '').trim();
  const rawToken = String(token ?? '').trim();
  if (!ref) throw validationError('A request reference is required.', { field: 'reference' });
  if (!rawToken) throw validationError('A withdrawal token is required.', { field: 'token' });

  return withWriteTransaction(db, () => {
    const row = db.prepare(`${INQUIRY_SELECT} WHERE i.reference = ? COLLATE NOCASE`).get(ref);
    if (!row || !row.withdraw_token_hash || !tokenMatches(rawToken, row.withdraw_token_hash)) {
      throw notFound('No request matches that reference and withdrawal link.');
    }

    if (row.status === INQUIRY_STATUS.WITHDRAWN) {
      return hydrateInquiry(row);
    }
    if (row.status === INQUIRY_STATUS.CONVERTED) {
      throw conflict('This request has already been converted to a reservation. Please contact us instead.');
    }
    if (row.status === INQUIRY_STATUS.CLOSED) {
      throw conflict('This request has already been closed.');
    }

    const now = Date.now();
    db.prepare('UPDATE inquiry SET status = ?, updated_at = ? WHERE id = ?')
      .run(INQUIRY_STATUS.WITHDRAWN, now, row.id);

    recordAudit(db, {
      actorLabel: `visitor <${row.email}>`,
      action: 'inquiry.withdrawn',
      entityType: 'inquiry',
      entityId: row.id,
      summary: `Withdrawn by visitor: ${row.reference}`,
      details: { reference: row.reference, previousStatus: row.status },
    });

    return getInquiry(db, row.id);
  });
}

/**
 * Link an existing reservation to an inquiry and mark it CONVERTED.
 * Reservations are never created here; the staff member creates the booking
 * first, then links it. The reservation must belong to the same customer
 * email as the inquiry.
 */
export function convertInquiryToReservation(db, { actor, inquiryId, reservationId } = {}) {
  if (!actor || !actor.id) throw validationError('An authenticated staff actor is required.');
  const id = Number(inquiryId);
  if (!Number.isInteger(id) || id < 1) {
    throw validationError('A valid inquiry id is required.', { field: 'inquiry_id' });
  }
  const resId = Number(reservationId);
  if (!Number.isInteger(resId) || resId < 1) {
    throw validationError('Select a reservation to link.', { field: 'reservation_id' });
  }

  return withWriteTransaction(db, () => {
    const inquiry = db.prepare('SELECT * FROM inquiry WHERE id = ?').get(id);
    if (!inquiry) throw notFound('Inquiry not found.');

    const reservation = db.prepare(`
      SELECT r.id, r.reference, r.status, r.customer_id,
             c.full_name AS customer_name, c.email_normalized AS customer_email_normalized
        FROM reservation r
        JOIN customer c ON c.id = r.customer_id
       WHERE r.id = ?
    `).get(resId);
    if (!reservation) throw notFound('Reservation not found.');

    if (inquiry.status === INQUIRY_STATUS.WITHDRAWN) {
      throw conflict('This inquiry was withdrawn by the visitor and cannot be converted.');
    }
    if (inquiry.status === INQUIRY_STATUS.CONVERTED) {
      if (Number(inquiry.converted_reservation_id) === resId) return getInquiry(db, id);
      throw conflict('This inquiry is already linked to another reservation.');
    }
    if (reservation.status === 'CANCELLED') {
      throw conflict('Cancelled reservations cannot be linked as a conversion.');
    }
    if (reservation.customer_email_normalized !== inquiry.email_normalized) {
      throw conflict(
        `Reservation ${reservation.reference} belongs to a different customer (${reservation.customer_name}). `
        + `Link a reservation for ${inquiry.email} instead.`,
      );
    }

    const now = Date.now();
    db.prepare(`
      UPDATE inquiry
         SET status = ?, converted_reservation_id = ?, updated_at = ?
       WHERE id = ?
    `).run(INQUIRY_STATUS.CONVERTED, resId, now, id);

    recordAudit(db, {
      actorAdminUserId: actor.id,
      actorLabel: actor.label,
      action: 'inquiry.status_changed',
      entityType: 'inquiry',
      entityId: id,
      summary: `Converted ${inquiry.reference} to reservation ${reservation.reference}`,
      details: {
        reference: inquiry.reference,
        from: inquiry.status,
        to: INQUIRY_STATUS.CONVERTED,
        reservationId: resId,
        reservationReference: reservation.reference,
      },
    });

    return getInquiry(db, id);
  });
}

export const _internals = {
  resolvePublishedSpace,
  tokenMatches,
  deliverInquiryEmails,
  availabilitySnapshot,
  resolveBoundary,
  likePattern,
  ONE_YEAR_MS,
};
