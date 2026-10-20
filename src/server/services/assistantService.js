import { createHash, randomBytes } from 'node:crypto';
import { withWriteTransaction } from '../db/connection.js';
import { getPublicAvailability } from './availabilityService.js';
import { businessLocalToEpoch } from '../domain/time.js';
import { validationError, conflict } from '../domain/errors.js';

/**
 * Venue assistant (OpenRouter).
 *
 * Contract, enforced here rather than in the prompt:
 *  - the model may only see a whitelisted set of public tools that read
 *    public-safe projections; it never receives a database handle;
 *  - tool arguments are validated against strict schemas before use;
 *  - outgoing conversation text is redacted so contact details are not sent
 *    to the provider;
 *  - nothing the model returns can create, confirm or charge a booking. The
 *    only write path is a short-lived, schema-validated booking *draft* that
 *    the customer explicitly asks for and that the form re-validates.
 */

const MAX_MESSAGES = 8;
const MAX_CHARS = 1200;
const MAX_TOOLS = 3;
const DRAFT_TTL_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
const PHONE_RE = /^\+?[\d\s().-]{7,20}$/;
const SPACE_CATEGORIES = ['MEETING_ROOM', 'TRAINING_ROOM', 'AUDITORIUM', 'COWORKING'];

export const assistantTools = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_spaces',
      description: 'List currently published TRACE spaces with factual capacity and rate summaries. Optionally filter by category or minimum capacity.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: SPACE_CATEGORIES },
          min_capacity: { type: 'integer', minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_space',
      description: 'Get factual details for one published TRACE space.',
      parameters: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Check live provisional availability for a published space. Times are Sri Lanka local times on the given date.',
      parameters: {
        type: 'object',
        required: ['code', 'date', 'start_time', 'end_time'],
        properties: {
          code: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM, 24h, Sri Lanka time' },
          end_time: { type: 'string', description: 'HH:MM, 24h, Sri Lanka time' },
          unit_count: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
    },
  },
]);

const SYSTEM_PROMPT = [
  'You are the clearly disclosed AI guide for TRACE Spaces at TRACE Expert City, Colombo.',
  'Be concise, warm and factual. Use tools for every venue fact, rate and availability claim.',
  'If a tool does not answer something, say plainly that you do not know rather than guessing.',
  'Availability is provisional until staff approval; never claim a booking is confirmed, never',
  'claim a payment succeeded, never request card details, and never expose internal or admin data.',
  'All times are Sri Lanka time (Asia/Colombo) and all prices are Sri Lankan rupees.',
  'When the visitor has given booking details (space, date, times, people, purpose, contact),',
  'summarise what they told you in one short line and tell them you can prepare an editable',
  'booking request draft for them to review — but never say anything is booked or reserved.',
].join(' ');

/** Contact details never travel to the model provider. */
function redact(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[contact redacted]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[contact redacted]');
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1) throw validationError('Send at least one message.');
  return messages.slice(-MAX_MESSAGES).map((m) => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: redact(String(m?.content ?? '').slice(0, MAX_CHARS)),
  }));
}

function safeSpace(row) {
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    category: row.category,
    capacity: Number(row.capacity),
    location: row.location,
    openTime: row.open_time,
    closeTime: row.close_time,
    minDurationMinutes: Number(row.min_duration_minutes),
    description: row.short_description,
  };
}

function asCode(value) {
  const code = String(value ?? '').trim().slice(0, 40);
  if (!code) throw validationError('A space code is required.');
  return code;
}

function asDate(value) {
  const date = String(value ?? '').trim();
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw validationError('Use a date like 2026-10-21.');
  }
  return date;
}

function asTime(value) {
  const time = String(value ?? '').trim();
  if (!TIME_RE.test(time)) throw validationError('Use a time like 14:30.');
  return time;
}

function asCount(value, { fallback = 1, max = 200 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw validationError(`Use a whole number between 1 and ${max}.`);
  return n;
}

function loadPublishedSpace(db, code) {
  return db.prepare("SELECT * FROM space WHERE code=? COLLATE NOCASE AND status='PUBLISHED'").get(code);
}

/**
 * Strict argument validation for the whitelisted tools. Unknown tools and
 * malformed arguments are refused before any query runs.
 */
function executeTool(db, name, args = {}) {
  if (name === 'list_spaces') {
    const category = args.category ? String(args.category) : null;
    if (category && !SPACE_CATEGORIES.includes(category)) return { error: 'Unknown category.' };
    const minCapacity = asCount(args.min_capacity, { fallback: 0, max: 1000 }) || 0;
    return db
      .prepare(`SELECT code,name,category,capacity,location,open_time,close_time,min_duration_minutes,short_description
        FROM space WHERE status='PUBLISHED' ORDER BY name LIMIT 30`)
      .all()
      .filter((s) => (!category || s.category === category) && Number(s.capacity) >= minCapacity)
      .map(safeSpace);
  }
  if (name === 'get_space') {
    return safeSpace(loadPublishedSpace(db, asCode(args.code)));
  }
  if (name === 'check_availability') {
    const space = loadPublishedSpace(db, asCode(args.code));
    if (!space) return { available: false, message: 'Space not found.' };
    const date = asDate(args.date);
    const startAt = businessLocalToEpoch(date, asTime(args.start_time));
    const endAt = businessLocalToEpoch(date, asTime(args.end_time));
    if (endAt <= startAt) return { available: false, message: 'The end time must be after the start time.' };
    return getPublicAvailability(db, {
      spaceId: space.id,
      startAt,
      endAt,
      deskCount: asCount(args.unit_count),
    });
  }
  return { error: 'Tool not allowed.' };
}

function localFallback(db) {
  const spaces = db
    .prepare(`SELECT code,name,category,capacity,location,open_time,close_time,min_duration_minutes,short_description
      FROM space WHERE status='PUBLISHED' ORDER BY name LIMIT 4`)
    .all()
    .map(safeSpace);
  return {
    message: spaces.length
      ? `I’m having trouble reaching the AI guide right now. You can still explore ${spaces.map((s) => s.name).join(', ')} — every page shows live availability and a request form.`
      : 'The AI guide is temporarily unavailable. The space catalogue and request form still work.',
    providerAvailable: false,
  };
}

/** Everything the customer typed stays in this process; only a schema-valid draft is proposed. */
export function extractDraftCandidate(rawMessages) {
  const text = (Array.isArray(rawMessages) ? rawMessages : [])
    .filter((m) => m?.role === 'user')
    .map((m) => String(m?.content ?? ''))
    .join(' ');
  const email = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
  const phone = text.match(/\+?\d[\d\s().-]{7,}\d/)?.[0] ?? null;
  const date = text.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0] ?? null;
  const times = [...text.matchAll(/\b([01]?\d|2[0-3]):[0-5]\d\b/g)].map((m) => m[0]);
  const attendees = text.match(/\b(\d{1,3})\s*(?:people|persons|pax|attendees|guests)\b/i)?.[1] ?? null;
  const raw = {
    email,
    phone,
    date,
    startTime: times[0] ?? null,
    endTime: times[1] ?? null,
    attendees: attendees ? Number(attendees) : null,
  };
  try {
    return validateDraftInput(raw).partial ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Schema-validated booking draft. Only fields the customer actually supplied
 * survive; anything malformed is refused rather than guessed at.
 */
export function validateDraftInput(input = {}) {
  const out = {};
  const spaceCode = String(input.spaceCode ?? '').trim().slice(0, 40);
  if (spaceCode) out.spaceCode = spaceCode;
  if (input.date) out.date = asDate(input.date);
  if (input.startTime) out.startTime = asTime(input.startTime);
  if (input.endTime) out.endTime = asTime(input.endTime);
  if (out.startTime && out.endTime && out.endTime <= out.startTime) {
    throw validationError('The draft end time must be after its start time.');
  }
  if (input.attendees !== undefined && input.attendees !== null && input.attendees !== '') {
    out.attendees = asCount(input.attendees, { max: 1000 });
  }
  if (input.unitCount !== undefined && input.unitCount !== null && input.unitCount !== '') {
    out.unitCount = asCount(input.unitCount, { max: 200 });
  }
  for (const [key, source, max] of [
    ['purpose', input.purpose, 2000],
    ['customerName', input.customerName ?? input.fullName ?? input.name, 160],
    ['organization', input.organization, 160],
  ]) {
    const value = String(source ?? '').trim().slice(0, max);
    if (value) out[key] = value;
  }
  const email = String(input.email ?? '').trim();
  if (email) {
    if (!EMAIL_RE.test(email) || email.length > 254) throw validationError('That email address does not look right.');
    out.email = email;
  }
  const phone = String(input.phone ?? '').trim();
  if (phone) {
    if (!PHONE_RE.test(phone)) throw validationError('That phone number does not look right.');
    out.phone = phone;
  }
  if (Object.keys(out).length === 0) throw validationError('There are no usable booking details yet.');
  return { ...out, partial: !(out.spaceCode && out.date && out.startTime && out.endTime) };
}

export async function chatWithVenueAssistant(db, { messages, config, signal } = {}) {
  const safe = normalizeMessages(messages);
  const candidate = extractDraftCandidate(messages);
  if (!config?.apiKey) return { ...localFallback(db), draftCandidate: candidate };

  const conversation = [{ role: 'system', content: SYSTEM_PROMPT }, ...safe];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const callModel = async (withTools) => {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': String(config.siteUrl ?? 'https://tracesrilanka.lk'),
        'X-Title': String(config.siteTitle ?? 'TRACE Spaces guide'),
      },
      body: JSON.stringify({
        model: config.model,
        messages: conversation,
        ...(withTools ? { tools: assistantTools, tool_choice: 'auto' } : {}),
        temperature: 0.25,
        max_tokens: 450,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    return res.json();
  };

  try {
    // Bounded twice over: a round cap, and a hard cap on total tool calls.
    // The last round is called without tools so the model must answer from the
    // evidence already gathered instead of looping forever.
    let toolCallsUsed = 0;
    const MAX_ROUNDS = 4;
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const allowTools = toolCallsUsed < MAX_TOOLS && round < MAX_ROUNDS;
      let data;
      try {
        data = await callModel(allowTools);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // one bounded retry for transient provider failures
        await new Promise((resolve) => setTimeout(resolve, 250));
        data = await callModel(allowTools);
      }
      const msg = data?.choices?.[0]?.message;
      if (!msg) throw new Error('OpenRouter returned no message.');
      if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
        return {
          message: String(msg.content || 'How can I help you find a space?').slice(0, 3000),
          providerAvailable: true,
          draftCandidate: candidate,
        };
      }
      if (!allowTools) return { ...localFallback(db), draftCandidate: candidate };
      conversation.push(msg);
      for (const call of msg.tool_calls.slice(0, Math.max(0, MAX_TOOLS - toolCallsUsed))) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        let result;
        try {
          result = executeTool(db, call.function?.name, args);
        } catch {
          result = { error: 'Those tool arguments were not valid.' };
        }
        conversation.push({ role: 'tool', call_id: call.id, tool_call_id: call.id, content: JSON.stringify(result).slice(0, 8000) });
        toolCallsUsed += 1;
      }
      conversation.push({ role: 'system', content: 'Answer now from the tool results already provided. Do not call more tools.' });
    }
    return { ...localFallback(db), draftCandidate: candidate };
  } catch {
    return { ...localFallback(db), draftCandidate: candidate };
  } finally {
    clearTimeout(timer);
  }
}

export function createAssistantDraft(db, input = {}, now = Date.now()) {
  const draft = validateDraftInput(input);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + DRAFT_TTL_MS;
  db.prepare(`INSERT INTO ai_booking_draft
    (token_hash,space_code,date_key,start_time,end_time,attendees,unit_count,purpose,customer_name,email,phone,organization,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    createHash('sha256').update(token).digest('hex'),
    draft.spaceCode ?? null,
    draft.date ?? null,
    draft.startTime ?? null,
    draft.endTime ?? null,
    draft.attendees ?? null,
    draft.unitCount ?? null,
    draft.purpose ?? null,
    draft.customerName ?? null,
    draft.email ?? null,
    draft.phone ?? null,
    draft.organization ?? null,
    expiresAt,
    now,
  );
  return { token, expiresAt };
}

/** One-time, short-lived hand-off. The token is hashed at rest and burns on read. */
export function consumeAssistantDraft(db, token, now = Date.now()) {
  const hash = createHash('sha256').update(String(token ?? '')).digest('hex');
  return withWriteTransaction(db, () => {
    const row = db
      .prepare('SELECT * FROM ai_booking_draft WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?')
      .get(hash, now);
    if (!row) throw conflict('This booking draft has expired or was already used.');
    db.prepare('UPDATE ai_booking_draft SET consumed_at=? WHERE id=?').run(now, row.id);
    return {
      spaceCode: row.space_code,
      date: row.date_key,
      startTime: row.start_time,
      endTime: row.end_time,
      attendees: row.attendees,
      unitCount: row.unit_count,
      purpose: row.purpose,
      customerName: row.customer_name,
      email: row.email,
      phone: row.phone,
      organization: row.organization,
    };
  });
}
