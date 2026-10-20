import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestActor, createTestDb } from '../helpers/testDb.js';
import {
  KNOWLEDGE_LIMITS,
  createAssistantKnowledge,
  deleteAssistantKnowledge,
  getAssistantKnowledge,
  listAssistantKnowledge,
  searchAssistantKnowledge,
  slugifyKnowledge,
  updateAssistantKnowledge,
} from '../../src/server/services/assistantKnowledgeService.js';

test('Guider knowledge CRUD is administrator-only, validated and audited', (t) => {
  const db = createTestDb();
  t.after(() => db.close());
  const admin = createTestActor(db, { email: 'knowledge-admin@test.local' });
  const staff = createTestActor(db, { email: 'knowledge-staff@test.local', role: 'STAFF' });

  assert.throws(
    () => createAssistantKnowledge(db, { actor: staff, payload: { title: 'No', markdown: 'No' } }),
    (error) => error?.status === 403,
  );

  const created = createAssistantKnowledge(db, {
    actor: admin,
    now: 1000,
    payload: {
      title: 'Visitor access & parking',
      markdown: '# Arrival\nUse the east gate. Visitor parking is free.',
      is_active: '1',
    },
  });
  assert.equal(created.slug, 'visitor-access-parking');
  assert.equal(created.isActive, true);
  assert.equal(getAssistantKnowledge(db, created.id).markdown, created.markdown);

  const updated = updateAssistantKnowledge(db, {
    actor: admin,
    id: created.id,
    now: 2000,
    payload: { title: created.title, slug: created.slug, markdown: 'Parking is paid.', is_active: '' },
  });
  assert.equal(updated.isActive, false);
  assert.equal(listAssistantKnowledge(db, { includeInactive: false }).length, 0);

  const removed = deleteAssistantKnowledge(db, { actor: admin, id: created.id, now: 3000 });
  assert.equal(removed.title, created.title);
  assert.equal(getAssistantKnowledge(db, created.id), null);
  assert.deepEqual(
    db.prepare("SELECT action FROM audit_log WHERE entity_type='assistant_knowledge' ORDER BY id").all().map((row) => row.action),
    ['assistant_knowledge.created', 'assistant_knowledge.updated', 'assistant_knowledge.deleted'],
  );
});

test('slugs are stable and duplicate slugs get a friendly conflict', (t) => {
  const db = createTestDb();
  t.after(() => db.close());
  const admin = createTestActor(db);
  assert.equal(slugifyKnowledge('  Café & Visitor ACCESS  '), 'cafe-visitor-access');

  createAssistantKnowledge(db, { actor: admin, payload: { title: 'Access', slug: 'visitor', markdown: 'One' } });
  assert.throws(
    () => createAssistantKnowledge(db, { actor: admin, payload: { title: 'Other', slug: 'VISITOR', markdown: 'Two' } }),
    (error) => error?.status === 409 && /slug/i.test(error.message),
  );
  assert.throws(
    () => createAssistantKnowledge(db, { actor: admin, payload: { title: 'Too much', markdown: 'x'.repeat(KNOWLEDGE_LIMITS.markdown + 1) } }),
    (error) => error?.status === 422,
  );
});

test('search returns relevant bounded plain text from active entries only', (t) => {
  const db = createTestDb();
  t.after(() => db.close());
  const admin = createTestActor(db);
  createAssistantKnowledge(db, {
    actor: admin,
    payload: {
      title: 'Catering policy',
      markdown: '# Catering\n[Approved vendors](https://example.test) may use the loading bay. **Outside food** needs approval.',
      is_active: true,
    },
  });
  createAssistantKnowledge(db, {
    actor: admin,
    payload: { title: 'Internal Wi-Fi password', markdown: 'The password is private.', is_active: false },
  });

  const catering = searchAssistantKnowledge(db, 'Can I bring outside catering?');
  assert.equal(catering.length, 1);
  assert.equal(catering[0].title, 'Catering policy');
  assert.match(catering[0].excerpt, /Outside food/i);
  assert.ok(!catering[0].excerpt.includes('https://'));
  assert.deepEqual(searchAssistantKnowledge(db, 'Wi-Fi password'), []);
  assert.deepEqual(searchAssistantKnowledge(db, 'the and what'), []);
});
