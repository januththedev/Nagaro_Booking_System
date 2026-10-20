import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestActor, createTestDb, closeTestDb } from '../helpers/testDb.js';
import {
  editorialCovers,
  provisionProductionCatalogue,
} from '../../src/server/db/provisionCatalogue.js';

test('production provisioning publishes the catalogue with verified editorial covers and no demo activity', () => {
  const db = createTestDb();
  try {
    const actor = createTestActor(db);
    const result = provisionProductionCatalogue(db, { actor });

    assert.equal(result.before, 0);
    assert.equal(result.after, Object.keys(editorialCovers).length);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM space WHERE status = 'PUBLISHED'").get().c), 5);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM reservation').get().c), 0);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM inquiry').get().c), 0);

    const images = db.prepare(`
      SELECT s.code, i.stored_name, i.mime_type, i.byte_size, i.alt_text,
             i.is_cover, i.blob_url, i.blob_pathname
        FROM space s
        JOIN space_image i ON i.space_id = s.id
       ORDER BY s.code
    `).all();
    assert.equal(images.length, 5);
    for (const image of images) {
      assert.match(image.stored_name, /^[a-f0-9]{32}\.(?:jpg|webp)$/);
      assert.match(image.mime_type, /^image\/(?:jpeg|webp)$/);
      assert.ok(image.byte_size > 0);
      assert.ok(image.alt_text.length > 10);
      assert.equal(image.is_cover, 1);
      assert.match(image.blob_url, /^\/assets\/trace-media\/research\//);
      assert.equal(image.blob_pathname, null);
    }

    const rerun = provisionProductionCatalogue(db, { actor });
    assert.equal(rerun.before, 5);
    assert.equal(rerun.after, 5);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM space_image').get().c), 5);
  } finally {
    closeTestDb(db);
  }
});
