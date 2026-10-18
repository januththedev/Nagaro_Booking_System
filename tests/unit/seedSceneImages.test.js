/**
 * Demo scene renderer: determinism, validity and cost.
 *
 * The Phase 2 seed draws its demo imagery in-process with a hand-written PNG
 * encoder and a procedural architectural renderer (src/server/db/seed.js).
 * These tests keep that renderer honest: the same inputs must always produce
 * byte-identical output (so fixtures and screenshots are reproducible), the
 * bytes must be a structurally valid PNG of the expected size, the cover and
 * alternate frames must differ, and a single frame must stay cheap enough that
 * seeding a catalogue does not become a bottleneck.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderSpaceScenePng } from '../../src/server/db/seed.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngHeader(buf) {
  return {
    signatureOk: buf.subarray(0, 8).equals(PNG_SIGNATURE),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

test('the demo renderer is byte-for-byte deterministic for the same input', () => {
  const a = renderSpaceScenePng(800, 500, 'TRC-MR-01', 0);
  const b = renderSpaceScenePng(800, 500, 'TRC-MR-01', 0);
  assert.ok(a.equals(b), 'identical I/O produced different bytes');
});

test('cover and alternate frames are different images', () => {
  const cover = renderSpaceScenePng(800, 500, 'TRC-AUD-01', 0);
  const alternate = renderSpaceScenePng(800, 500, 'TRC-AUD-01', 1);
  assert.equal(cover.equals(alternate), false, 'variant 0 and 1 must not be the same frame');
});

test('rendered frames are valid PNGs at the requested dimensions', () => {
  for (const [code, variant] of [['TRC-CW-01', 0], ['TRC-MR-02', 1], ['TRC-CW-02', 0]]) {
    const buf = renderSpaceScenePng(800, 500, code, variant);
    const header = pngHeader(buf);
    assert.equal(header.signatureOk, true, `${code} v${variant} is not a PNG`);
    assert.equal(header.width, 800);
    assert.equal(header.height, 500);
    assert.ok(buf.length > 10_000, 'frame is suspiciously small');
    assert.ok(buf.length < 1_500_000, 'frame is too large for a 800x500 demo asset');
  }
});

test('rendering a single frame stays cheap', () => {
  const started = Date.now();
  renderSpaceScenePng(800, 500, 'TRC-MR-01', 0);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `a single 800x500 frame took ${elapsed}ms`);
});
