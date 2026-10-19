/**
 * Static guards for the public experience.
 *
 * The public rebuild removes four patterns that made the old frontend feel
 * generic, and this file stops them from creeping back:
 *
 *   1. horizontal rails / `overflow-x` scroll boxes on public surfaces,
 *   2. CSS scroll snapping,
 *   3. decorative `01 / 02 / 03` section markers and numbered step pills,
 *   4. the "Space modes"-style floating statistic block.
 *
 * The guard reads the two renderers that ship to visitors — the legacy
 * server-rendered views (`src/web/views/publicViews.js` + `styles.css`) and the
 * Next.js public app (`apps/public-web`) — and asserts the patterns are absent.
 * Admin-only tables keep their `.table-wrap` scroll container: dense staff
 * tables are a different problem from a public showcase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const legacyViews = readFileSync(join(root, 'src/web/views/publicViews.js'), 'utf8');
const publicCss = readFileSync(join(root, 'src/web/public/styles.css'), 'utf8');

const NEXT_EXTENSIONS = new Set(['.tsx', '.ts', '.css', '.mjs']);
const nextSources = [
  ...walk(join(root, 'apps/public-web/app')),
  ...walk(join(root, 'apps/public-web/components')),
]
  .filter((file) => NEXT_EXTENSIONS.has(extname(file)))
  .map((file) => ({ file, source: readFileSync(file, 'utf8') }));

/** A bare two-digit decorative marker used as its own text node. */
const NUMBERED_MARKER = />\s*0[1-9]\s*</;
/** `01 · Space & Preferred Schedule`, `02 / Self-service` and friends. */
const NUMBERED_PREFIX = /['"`>\s]0[1-9]\s*[·/]/;

test('public surfaces never ship a horizontal rail or a snapped scroll box', () => {
  assert.doesNotMatch(
    legacyViews,
    /data-horizontal-rail|trace-space-rail|trace-reel/,
    'legacy public views must not render rails, marquees or floating spotlight cards'
  );

  // Only `<pre>` (code) and the admin `.table-wrap` may scroll sideways.
  const sidewaysRules = [...publicCss.matchAll(/(^|\n)([^{}\n]+)\{([^}]*)\}/g)]
    .filter((match) => /(^|[;\s])overflow-x\s*:/.test(match[3]))
    .map((match) => match[2].trim());
  const allowed = new Set(['pre', '.table-wrap']);
  const offending = sidewaysRules.filter((selector) => !allowed.has(selector));
  assert.deepEqual(
    offending,
    [],
    `unexpected overflow-x rules in the public stylesheet: ${offending.join(', ')}`
  );

  for (const { file, source } of nextSources) {
    assert.doesNotMatch(
      source,
      /overflow-x/,
      `${file} must not introduce horizontal scrolling on a public page`
    );
    assert.doesNotMatch(
      source,
      /\bsnap-(?:x|y|both|mandatory|proximity|start|end|center|align|normal|none)\b/,
      `${file} must not introduce scroll snapping`
    );
  }
});

test('the public stylesheet contains no scroll-snap and no numbered marker rules', () => {
  assert.doesNotMatch(publicCss, /scroll-snap/, 'scroll snapping is banned on public pages');
  assert.doesNotMatch(
    publicCss,
    /\.(?:section__index|step__num|process-step__num|flow-progress__num)\b/,
    'decorative numbered-marker classes must not exist in the public stylesheet'
  );
  assert.doesNotMatch(
    publicCss,
    /\.(?:trace-space-rail|trace-space-card|trace-stage__word|trace-stage__stats)\b/,
    'legacy rail, watermark and floating statistic styles must stay deleted'
  );
});

test('no public renderer emits decorative 01/02/03 markers or a stat block', () => {
  assert.ok(legacyViews.length > 1000, 'sanity check: the legacy views file was read');

  assert.doesNotMatch(
    legacyViews,
    NUMBERED_MARKER,
    'a decorative two-digit marker is rendered as its own text node'
  );
  assert.doesNotMatch(
    legacyViews,
    NUMBERED_PREFIX,
    'a decorative "01 ·" style prefix is rendered in the public views'
  );
  assert.doesNotMatch(
    legacyViews,
    /class="[^"]*\b(?:section__index|step__num|flow-progress__num)\b/,
    'numbered-marker classes must not be rendered by the public views'
  );
  assert.doesNotMatch(
    legacyViews,
    /Space modes/,
    'the floating "Space modes" statistic block must not return'
  );

  for (const { file, source } of nextSources) {
    assert.doesNotMatch(
      source,
      NUMBERED_MARKER,
      `${file} renders a decorative two-digit marker`
    );
    assert.doesNotMatch(
      source,
      NUMBERED_PREFIX,
      `${file} renders a decorative "01 ·" style prefix`
    );
  }
});

test('the booking stages are named, never numbered', () => {
  const stageBlock = legacyViews.slice(legacyViews.indexOf('flow-progress'));
  assert.ok(stageBlock.length > 0, 'expected a flow-progress stage list in the legacy checkout');

  const stages = legacyViews.match(/<ol class="flow-progress"[\s\S]*?<\/ol>/);
  assert.ok(stages, 'expected the legacy checkout to render its stage list');
  assert.doesNotMatch(stages[0], /flow-progress__num|>\s*\d\s*</, 'stages must be named, not numbered');
  for (const label of ['Space &amp; schedule', 'Contact details', 'Review &amp; send']) {
    assert.ok(stages[0].includes(label), `stage list is missing "${label}"`);
  }
});

test('direct checkout copy never contradicts itself about who confirms a booking', () => {
  // The stale sentence claimed every booking waits for staff. Direct checkout
  // confirms inside the booking transaction; only inquiries are provisional.
  assert.doesNotMatch(
    legacyViews,
    /Nagaro staff confirm every booking by hand|A booking is confirmed only once Nagaro staff confirm it|staff confirm all bookings/,
    'stale "staff must confirm every booking" copy must not return'
  );

  for (const { file, source } of nextSources) {
    assert.doesNotMatch(
      source,
      /provisional[\s\S]{0,80}direct checkout|direct checkout[\s\S]{0,80}provisional until staff/i,
      `${file} must not describe direct checkout as provisional`
    );
  }
});
