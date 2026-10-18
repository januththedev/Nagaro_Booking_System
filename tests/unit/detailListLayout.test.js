/**
 * Regression guard for the two-column `.detail-list` layout.
 *
 * Bug (fixed in this commit): the responsive rule used
 *
 *     grid-template-columns: minmax(10rem, 14rem) 1fr;
 *
 * inside `@media (min-width: 640px)`. A non-`fr` track grows to its max
 * *before* the `1fr` track is resolved, so inside any card narrower than
 * ~14rem + the value's minimum content the value column collapsed to roughly
 * one character and was clipped by `.detail-list { overflow: hidden }`. The
 * public venue sidebar, the inquiry preview cards and the admin detail panels
 * (244px/195px/147px wide) all rendered one-letter-per-line values.
 *
 * The rule must therefore keep a zero minimum on both tracks and cap the
 * label column relative to the container so it can never over-consume it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  fileURLToPath(new URL('../../src/web/public/styles.css', import.meta.url)),
  'utf8'
);

function rulesContaining(selector, property) {
  const blocks = css.matchAll(new RegExp(`${selector.replace(/[.\\-]/g, '\\$&')}\\s*\\{[^}]*\\}`, 'g'));
  return [...blocks]
    .map((m) => m[0])
    .filter((block) => block.includes(property));
}

test('two-column detail-list never lets the label track over-consume the container', () => {
  const candidates = rulesContaining('.detail-list', 'grid-template-columns');
  const twoColumn = candidates.filter((block) => /minmax\(0,\s*1fr\)/.test(block));
  assert.ok(twoColumn.length >= 1, 'expected a two-column .detail-list rule in styles.css');

  for (const block of twoColumn) {
    const value = block.match(/grid-template-columns:\s*([^;}]+)/)[1].trim();

    // No absolute minimum on any track (e.g. `minmax(10rem, 14rem)`); such a
    // track greedy-grows to its max and starves the value column.
    assert.doesNotMatch(
      value,
      /minmax\(\s*[1-9]/,
      `label track must not have a non-zero absolute minimum: ${value}`
    );

    // The label column must be capped relative to its container.
    assert.match(value, /%/, `label track must be container-relative: ${value}`);

    // The value column must be allowed to shrink to zero so the grid can
    // never overflow its own (overflow:hidden) box.
    assert.match(value, /minmax\(0,\s*1fr\)/, `value track must be minmax(0, 1fr): ${value}`);
  }
});

test('detail-list values can break long tokens instead of overflowing their track', () => {
  const ddRules = rulesContaining('.detail-list dd', 'overflow-wrap');
  assert.ok(ddRules.length >= 1, 'expected an overflow-wrap rule for .detail-list dd');
  assert.ok(
    ddRules.some((block) => /overflow-wrap:\s*anywhere/.test(block)),
    'detail-list dd must use overflow-wrap: anywhere so long tokens wrap inside the value track'
  );
});
