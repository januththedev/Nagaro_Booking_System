import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AppError } from '../../src/server/domain/errors.js';
import { createRouter } from '../../src/server/http/router.js';
import { registerAdminAssistantKnowledgeRoutes } from '../../src/server/routes/adminAssistantKnowledgeRoutes.js';
import { csrfTokenFor } from '../../src/server/security/sessions.js';
import { createTestActor, createTestDb } from '../helpers/testDb.js';

const CSRF_SECRET = 'guider-route-test-secret';
const CSRF_TOKEN = csrfTokenFor(CSRF_SECRET);

test('admin can paste or upload Markdown while non-admin staff are refused', async (t) => {
  const db = createTestDb();
  const admin = createTestActor(db, { email: 'guider-admin@test.local' });
  const staff = createTestActor(db, { email: 'guider-staff@test.local', role: 'STAFF' });
  const router = createRouter();
  router.use(async (ctx) => {
    const selected = ctx.req.headers['x-test-role'] === 'staff' ? staff : admin;
    ctx.actor = selected;
    ctx.session = { sessionId: 1, csrfSecret: CSRF_SECRET, expiresAt: Date.now() + 60_000 };
    ctx.csrfToken = CSRF_TOKEN;
    ctx.flash = null;
    return true;
  });
  router.onError(async (ctx, error) => {
    const status = error instanceof AppError ? error.status : 500;
    ctx.json({ error: { message: error.message } }, status);
  });
  registerAdminAssistantKnowledgeRoutes(router, { db, setFlash: () => {} });
  const server = createServer((req, res) => void router.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const refused = await fetch(`${base}/admin/guider-knowledge`, {
    headers: { 'x-test-role': 'staff', accept: 'application/json' },
  });
  assert.equal(refused.status, 403);

  const upload = new FormData();
  upload.set('_csrf', CSRF_TOKEN);
  upload.set('title', 'Arrival guide');
  upload.set('slug', 'arrival-guide');
  upload.set('markdown', 'This pasted value is replaced by the file.');
  upload.set('is_active', '1');
  upload.set('knowledge_file', new Blob(['# Arrival\nUse the east gate.'], { type: 'text/markdown' }), 'arrival.md');
  const created = await fetch(`${base}/admin/guider-knowledge`, {
    method: 'POST', body: upload, redirect: 'manual',
  });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/admin/guider-knowledge');
  const row = db.prepare("SELECT * FROM assistant_knowledge WHERE slug='arrival-guide'").get();
  assert.equal(row.markdown, '# Arrival\nUse the east gate.');
  assert.equal(row.is_active, 1);

  const pasted = new URLSearchParams({
    _csrf: CSRF_TOKEN,
    title: 'Arrival & access',
    slug: 'arrival-guide',
    markdown: '# Access\n<script>alert(1)</script> Visitors use the west gate.',
  });
  const updated = await fetch(`${base}/admin/guider-knowledge/${row.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: pasted,
    redirect: 'manual',
  });
  assert.equal(updated.status, 303);
  assert.equal(db.prepare('SELECT is_active FROM assistant_knowledge WHERE id=?').get(row.id).is_active, 0);

  const edit = await fetch(`${base}/admin/guider-knowledge/${row.id}/edit`);
  const markup = await edit.text();
  assert.equal(edit.status, 200);
  assert.ok(!markup.includes('<script>alert(1)</script>'), 'pasted Markdown is escaped, never rendered as HTML');
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const removed = await fetch(`${base}/admin/guider-knowledge/${row.id}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: CSRF_TOKEN }),
    redirect: 'manual',
  });
  assert.equal(removed.status, 303);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assistant_knowledge').get().c, 0);
});
