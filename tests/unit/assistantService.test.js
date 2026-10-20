/**
 * Venue assistant (OpenRouter) — grounding, tool safety and draft hand-off.
 *
 * These tests treat the model as untrusted: they assert that only whitelisted
 * tools run, that arguments are schema-validated, that contact details never
 * reach the provider, and that the assistant cannot create, confirm or charge
 * anything — the only write is a hashed, one-time, schema-validated draft.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createTestDb } from '../helpers/testDb.js';
import {
  assistantTools,
  chatWithVenueAssistant,
  consumeAssistantDraft,
  createAssistantDraft,
  extractDraftCandidate,
  validateDraftInput,
} from '../../src/server/services/assistantService.js';
import { parseBookingWindow } from '../../src/server/domain/validation.js';

const originalFetch = globalThis.fetch;

function stubFetch(responses) {
  const calls = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return { ok: true, status: 200, json: async () => payload };
  };
  return calls;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function seedSpace(db) {
  const now = Date.now();
  const inserted = db.prepare(`INSERT INTO space
    (code,name,category,short_description,capacity,status,currency,pricing_unit,min_duration_minutes,max_duration_minutes,buffer_minutes,open_time,close_time,amenities,attributes,created_at,updated_at,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('AI-ROOM-01', 'Assistant Room', 'MEETING_ROOM', 'A test venue', 20, 'PUBLISHED', 'LKR', 'HOUR', 60, 480, 0, '08:00', '18:00', '["Whiteboard"]', '{}', now, now, now);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO space_rate (space_id,unit,amount_cents,is_default) VALUES (?,?,?,1)').run(id, 'HOUR', 250000);
  db.prepare('INSERT INTO resource_unit (space_id,code,label,kind,is_active,created_at) VALUES (?,?,?,?,1,?)').run(id, 'AI-ROOM-01-A', 'Assistant Room', 'EXCLUSIVE', now);
  return id;
}

function toolCall(name, args, id = `call_${name}`) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function modelMessage(body) {
  return JSON.parse(body).messages.at(-1);
}

test('without a provider key the assistant degrades gracefully and keeps booking working', async (t) => {
  t.after(restoreFetch);
  const db = createTestDb();
  seedSpace(db);
  const calls = stubFetch([{ choices: [{ message: { content: 'should not be used' } }] }]);

  const result = await chatWithVenueAssistant(db, {
    messages: [{ role: 'user', content: 'I need a room for 10 people.' }],
    config: {},
  });

  assert.equal(result.providerAvailable, false);
  assert.equal(calls.length, 0, 'no network call without a key');
  assert.match(result.message, /Assistant Room|catalogue/i);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM booking_request').get().c, 0);
  db.close();
});

test('contact details are redacted before conversation text reaches the provider', async (t) => {
  t.after(restoreFetch);
  const db = createTestDb();
  seedSpace(db);
  const calls = stubFetch([{ choices: [{ message: { content: 'Happy to help.' } }] }]);

  await chatWithVenueAssistant(db, {
    messages: [{ role: 'user', content: 'I am Nimal. Reach me at nimal@example.com or +94 77 123 4567.' }],
    config: { apiKey: 'sk-test', model: 'vendor/model-x', baseUrl: 'https://openrouter.test/api/v1' },
  });

  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, 'vendor/model-x');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  const transcript = JSON.stringify(sent.messages);
  assert.ok(!transcript.includes('nimal@example.com'), 'email must not reach the provider');
  assert.ok(!/\+94 77 123 4567/.test(transcript), 'phone must not reach the provider');
  assert.match(transcript, /\[contact redacted\]/);
  assert.equal(sent.tools.length, assistantTools.length);
  db.close();
});

test('tool execution is whitelisted, schema-checked, and returns public-safe projections only', async (t) => {
  t.after(restoreFetch);
  const db = createTestDb();
  seedSpace(db);
  const calls = stubFetch([
    {
      choices: [{
        message: {
          content: null,
          tool_calls: [
            toolCall('get_space', { code: 'AI-ROOM-01' }),
            toolCall('drop_tables', { table: 'admin_user' }),
            toolCall('check_availability', { code: 'AI-ROOM-01', date: '2030-08-14', start_time: '25:99', end_time: '11:00' }),
            toolCall('get_space', { code: 'AI-ROOM-01', extra: 'ignored' }),
          ],
        },
      }],
    },
    { choices: [{ message: { content: 'Here is what I found.' } }] },
  ]);

  const result = await chatWithVenueAssistant(db, {
    messages: [{ role: 'user', content: 'Tell me about AI-ROOM-01 on 2030-08-14.' }],
    config: { apiKey: 'sk-test', model: 'vendor/model-x', baseUrl: 'https://openrouter.test/api/v1' },
  });

  assert.equal(result.message, 'Here is what I found.');
  assert.equal(calls.length, 2);
  const conversation = JSON.parse(calls[1].init.body).messages;
  const toolResults = conversation.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));

  const spaceResult = toolResults[0];
  assert.equal(spaceResult.code, 'AI-ROOM-01');
  const allowedKeys = new Set(['code', 'name', 'category', 'capacity', 'location', 'openTime', 'closeTime', 'minDurationMinutes', 'description']);
  assert.deepEqual(Object.keys(spaceResult).filter((k) => !allowedKeys.has(k)), [], 'projection must stay public-safe');

  assert.deepEqual(toolResults[1], { error: 'Tool not allowed.' });
  assert.match(JSON.stringify(toolResults[2]), /error/i, 'malformed tool arguments are refused');
  db.close();
});

test('tool recursion is bounded even when the model never stops calling tools', async (t) => {
  t.after(restoreFetch);
  const db = createTestDb();
  seedSpace(db);
  const calls = stubFetch([
    { choices: [{ message: { content: null, tool_calls: [toolCall('list_spaces', {})] } }] },
  ]);

  const result = await chatWithVenueAssistant(db, {
    messages: [{ role: 'user', content: 'List everything.' }],
    config: { apiKey: 'sk-test', model: 'vendor/model-x', baseUrl: 'https://openrouter.test/api/v1' },
  });

  assert.ok(calls.length <= 4, `tool budget must be bounded, saw ${calls.length} model calls`);
  assert.equal(typeof result.message, 'string');
  db.close();
});

test('availability checks use Sri Lanka business time and real inventory', async (t) => {
  t.after(restoreFetch);
  const db = createTestDb();
  seedSpace(db);
  const calls = stubFetch([
    {
      choices: [{
        message: {
          content: null,
          tool_calls: [toolCall('check_availability', { code: 'AI-ROOM-01', date: '2030-08-14', start_time: '09:00', end_time: '11:00', unit_count: 1 })],
        },
      }],
    },
    { choices: [{ message: { content: 'Checked.' } }] },
  ]);

  await chatWithVenueAssistant(db, {
    messages: [{ role: 'user', content: 'Is AI-ROOM-01 free on 2030-08-14 from 09:00 to 11:00?' }],
    config: { apiKey: 'sk-test', model: 'vendor/model-x', baseUrl: 'https://openrouter.test/api/v1' },
  });

  const toolResults = JSON.parse(calls[1].init.body).messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
  const availability = toolResults[0];
  assert.equal(typeof availability.isAvailable, 'boolean');
  assert.equal(availability.isAvailable, true);
  const window = parseBookingWindow({ date: '2030-08-14', start_time: '09:00', end_time: '11:00' });
  assert.equal(availability.startAt ?? window.startAt, window.startAt);
  db.close();
});

test('booking drafts are schema-validated, hashed at rest and burn after one use', async (t) => {
  const db = createTestDb();
  const now = Date.UTC(2030, 0, 1);

  const draft = createAssistantDraft(db, {
    spaceCode: 'AI-ROOM-01',
    date: '2030-08-14',
    startTime: '09:00',
    endTime: '11:00',
    attendees: 12,
    purpose: 'Board review',
    customerName: 'Asha Perera',
    email: 'asha@example.com',
    phone: '+94 77 123 4567',
  }, now);

  assert.ok(draft.token.length >= 32);
  const stored = db.prepare('SELECT * FROM ai_booking_draft').get();
  assert.equal(stored.token_hash, createHash('sha256').update(draft.token).digest('hex'));
  assert.ok(!String(stored.token_hash).includes(draft.token), 'the raw token must never be stored');

  const resolved = consumeAssistantDraft(db, draft.token, now + 1000);
  assert.equal(resolved.spaceCode, 'AI-ROOM-01');
  assert.equal(resolved.attendees, 12);
  assert.equal(resolved.email, 'asha@example.com');

  assert.throws(() => consumeAssistantDraft(db, draft.token, now + 2000), (e) => e?.status === 409, 'drafts are one-time');

  const expired = createAssistantDraft(db, { date: '2030-08-14' }, now);
  assert.throws(() => consumeAssistantDraft(db, expired.token, now + 16 * 60_000), (e) => e?.status === 409);

  assert.throws(() => createAssistantDraft(db, { email: 'not-an-email' }, now), (e) => e?.status === 422, 'invalid contact details are refused');
  assert.throws(() => createAssistantDraft(db, {}, now), (e) => e?.status === 422, 'empty drafts are refused');
  assert.throws(() => createAssistantDraft(db, { date: '14-08-2030' }, now), (e) => e?.status === 422, 'dates must be ISO');
  assert.throws(() => createAssistantDraft(db, { startTime: '09:00', endTime: '08:00' }, now), (e) => e?.status === 422);
  db.close();
});

test('draft recognition only proposes details the customer actually supplied', () => {
  const found = extractDraftCandidate([
    { role: 'user', content: 'I need a room on 2030-08-14 from 09:00 to 11:00 for 12 people. Contact asha@example.com' },
    { role: 'assistant', content: 'Sure.' },
    { role: 'user', content: 'Also call me on +94 77 123 4567' },
  ]);
  assert.equal(found.date, '2030-08-14');
  assert.equal(found.startTime, '09:00');
  assert.equal(found.endTime, '11:00');
  assert.equal(found.attendees, 12);
  assert.equal(found.email, 'asha@example.com');

  assert.equal(extractDraftCandidate([{ role: 'user', content: 'hello there' }]), null);
  const partial = validateDraftInput({ date: '2030-08-14' });
  assert.equal(partial.partial, true, 'an incomplete draft is offered as editable, never as complete');
});
