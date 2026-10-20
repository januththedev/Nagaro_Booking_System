/**
 * Static guards for the public surface.
 *
 * These are the rules that review would otherwise have to re-check by hand on
 * every change: no horizontal rails or numbered markers, a hero that paints
 * before WebGL is ready and gives up on weak devices, motion that never fights
 * the user, and copy that does not promise "a member of staff will confirm"
 * when checkout is in fact immediate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles() {
  const dirs = [join(appRoot, 'app'), join(appRoot, 'components')];
  const files = [];
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(join(entry.parentPath ?? dir, entry.name));
    }
  }
  return files.sort();
}

const readApp = (relative) => readFile(resolve(appRoot, relative), 'utf8');

test('no horizontal rails, scroll snapping or decorative numerals survive', async () => {
  const files = [resolve(appRoot, 'app/globals.css'), ...(await sourceFiles())];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const label = file.slice(appRoot.length + 1);
    assert.doesNotMatch(content, /scroll-snap/i, `${label} must not use scroll snapping`);
    assert.doesNotMatch(content, /over ?flow-x:\s*(auto|scroll)/i, `${label} must not add a horizontal rail`);
    assert.doesNotMatch(content, /\bsnap-(x|y|both|mandatory|proximity)\b/, `${label} must not use snap utility classes`);
    assert.doesNotMatch(content, /padStart\(2,\s*["']0["']\)/, `${label} must not zero-pad decorative indexes`);
    assert.doesNotMatch(content, />\s*0[1-9]\s*</, `${label} must not render bare 01/02/03 markers`);
  }
});

test('the hero paints a real photograph before WebGL exists', async () => {
  const landing = await readApp('components/LandingExperience.tsx');

  assert.match(landing, /<picture/, 'the hero must offer a non-canvas paint path');
  const picture = landing.slice(landing.indexOf('<picture'), landing.indexOf('</picture>'));
  assert.match(picture, /<img/, 'the hero picture must contain a real image element');
  assert.match(picture, /alt="[^"{]/);
  assert.match(picture, /fetchPriority="high"/);

  assert.match(landing, /dynamic\(\(\)\s*=>\s*import\("\.\/HeroWebGLCanvas"\)/);
  assert.match(landing, /ssr:\s*false/, 'the canvas must not be part of the server payload');
  assert.ok(
    landing.indexOf('</picture>') < landing.indexOf('<HeroWebGLCanvas'),
    'the photograph must be laid down before the canvas mounts on top of it',
  );
});

test('the arrival viewport carries the enquiry and booking calls to action', async () => {
  const landing = await readApp('components/LandingExperience.tsx');
  const arrival = landing.slice(
    landing.indexOf('aria-label="TRACE Spaces arrival"'),
    landing.indexOf('HERITAGE & ARCHITECTURAL CHARACTER'),
  );
  assert.ok(arrival.length > 0, 'the arrival section must exist');
  assert.match(arrival, /href="\/spaces"/);
  assert.match(arrival, /href="\/book"/);
  assert.match(
    arrival,
    /min-h-\[(?:100svh|100dvh|calc\(100dvh)/,
    'the arrival block must fill the first viewport',
  );
});

test('WebGL is a capped, lazy, recoverable enhancement', async () => {
  const hero = await readApp('components/HeroWebGLCanvas.tsx');

  assert.match(hero, /Math\.min\(window\.devicePixelRatio \|\| 1, 1\.5\)/, 'DPR must be capped at 1.5');
  assert.match(hero, /await import\("three"\)/, 'three.js must be lazy-loaded');
  assert.match(hero, /new IntersectionObserver/);
  assert.match(hero, /isVisible/, 'offscreen frames must be skipped');
  assert.match(hero, /addEventListener\("webglcontextlost"/);
  assert.match(hero, /addEventListener\("webglcontextrestored"/);
  assert.match(hero, /prefers-reduced-motion: reduce/);
  assert.match(hero, /pointer: coarse/);
  assert.match(hero, /connection\?\.saveData/);
  for (const device of [/hardwareConcurrency < 4/, /deviceMemory < 4/]) assert.match(hero, device);
  assert.match(hero, /renderer\.dispose\(\)/, 'the renderer must be torn down on unmount');
  assert.match(hero, /powerPreference: "low-power"/);
});

test('smooth scrolling is opt-in and GSAP only animates compositor properties', async () => {
  const motion = await readApp('components/MotionProvider.tsx');

  assert.match(motion, /prefers-reduced-motion: reduce/);
  assert.match(motion, /pointer: coarse/);
  assert.match(motion, /connection\?\.saveData/);
  assert.match(motion, /await Promise\.all\(\[/, 'lenis and gsap must be loaded lazily and together');
  assert.match(motion, /once: true/, 'reveals must run once, never re-trigger on scroll back');
  assert.match(motion, /lenisInstance\.destroy\(\)/);

  const tween = motion.slice(motion.indexOf('gsap.fromTo'), motion.indexOf('} catch {'));
  assert.match(tween, /autoAlpha: 0/);
  assert.match(tween, /y: 22/);
  for (const layoutProperty of ['width:', 'height:', 'top:', 'left:', 'margin']) {
    assert.doesNotMatch(tween, new RegExp(layoutProperty), `GSAP must not animate ${layoutProperty}`);
  }
  assert.doesNotMatch(motion, /scroll-behavior:\s*smooth/, 'native smooth scrolling stays with CSS, not JS');
});

test('direct checkout is a real JSON submission with a no-JavaScript fallback', async () => {
  const form = await readApp('components/DirectBookingForm.tsx');

  assert.match(form, /fetch\(clientApiPath\("\/api\/public\/bookings"\)/);
  assert.match(form, /"Content-Type": "application\/json"/);
  assert.match(form, /form_token: formToken/);
  assert.match(form, /method="post"/);
  assert.match(form, /action="\/book"/, 'without JavaScript the same form must reach the Node runtime');
  assert.match(form, /role="alert"/);
  assert.match(form, /aria-live="polite"/);
  assert.match(form, /name="email"/);
});

test('direct booking copy never defers confirmation to staff', async () => {
  const direct = [
    'components/DirectBookingForm.tsx',
    'components/VenueDetailClient.tsx',
    'components/LandingExperience.tsx',
    'app/book/page.tsx',
  ];
  const contradiction = /(staff|team|our office|front desk)[^.]{0,60}confirm|await(ing)?[^.]{0,30}confirmation|(must|will) be confirmed (by|after)/i;
  for (const file of direct) {
    const content = await readApp(file);
    assert.doesNotMatch(content, contradiction, `${file} contradicts immediate direct confirmation`);
  }
  const venue = await readApp('components/VenueDetailClient.tsx');
  assert.match(venue, /confirm(s)? your reservation immediately|confirms your reservation immediately/i);
});

test('every photograph carries alternative text', async () => {
  for (const file of await sourceFiles()) {
    const content = await readFile(file, 'utf8');
    const label = file.slice(appRoot.length + 1);
    let index = content.indexOf('<img');
    while (index !== -1) {
      const tag = content.slice(index, content.indexOf('>', index) + 1);
      assert.match(tag, /alt=/, `${label} has an <img> without alt text: ${tag.slice(0, 80)}`);
      index = content.indexOf('<img', index + 1);
    }
  }
});

test('inquiry withdrawal keeps a native fallback and a scripted path', async () => {
  const page = await readApp('app/booking-request/withdraw/page.tsx');
  const form = await readApp('components/WithdrawInquiryForm.tsx');

  assert.match(page, /<WithdrawInquiryForm/);
  assert.match(form, /method="post"/);
  assert.match(form, /action="\/booking-request\/withdraw"/);
  assert.match(form, /name="token"/, 'the capability token must travel with the withdrawal');
  assert.match(form, /fetch\("\/booking-request\/withdraw"/);
  assert.match(form, /withdrawn=1/);
  assert.match(form, /role="alert"/);
});

test('the shell exposes the primary routes and a skip link', async () => {
  const shell = await readApp('components/PublicShell.tsx');
  for (const route of ['/spaces', '/book', '/booking-request', '/admin']) {
    assert.match(shell, new RegExp(`href="${route.replace('/', '\\/')}"`), `the shell must link to ${route}`);
  }
  assert.match(shell, /Skip to main content/);
  assert.match(shell, /id="main-content"/);
  assert.match(shell, /aria-expanded=\{menuOpen\}/);
});
