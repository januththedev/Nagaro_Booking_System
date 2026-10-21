/**
 * Static guards for the public surface.
 *
 * These are the rules review would otherwise re-check by hand on every change:
 * no horizontal rails or numbered markers, a hero that paints before WebGL is
 * ready and gives up on weak devices, motion that never fights the user, one
 * unified direct-booking flow (no retired dual channel), a navigation-free header
 * whose single call to action is labelled exactly "Book a Space", and copy
 * that explains checkout's final atomic inventory check and any configured
 * registration fee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dictionaries } from '../lib/i18n.ts';

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
  assert.match(picture, /alt=(\{[^}]+\}|"[^"{][^"]*")/, 'the hero image needs alternative text');
  assert.match(picture, /fetchPriority="high"/);

  assert.match(landing, /dynamic\(\(\)\s*=>\s*import\("\.\/HeroWebGLCanvas"\)/);
  assert.match(landing, /ssr:\s*false/, 'the canvas must not be part of the server payload');
  assert.ok(
    landing.indexOf('</picture>') < landing.indexOf('<HeroWebGLCanvas'),
    'the photograph must be laid down before the canvas mounts on top of it',
  );
});

test('the arrival viewport carries the Book a Space call to action', async () => {
  const landing = await readApp('components/LandingExperience.tsx');
  const arrival = landing.slice(
    landing.indexOf('aria-label="TRACE Spaces arrival"'),
    landing.indexOf('HERITAGE & ARCHITECTURAL CHARACTER'),
  );
  assert.ok(arrival.length > 0, 'the arrival section must exist');
  assert.match(arrival, /href="\/spaces"/, 'the primary action leads to the catalogue');
  assert.doesNotMatch(arrival, /href="\/book(\/|")/, 'the retired direct-booking route must not be offered');
  assert.doesNotMatch(arrival, /href="\/booking-request(\/|")/, 'the retired inquiry route must not be offered');
  assert.match(
    arrival,
    /min-h-\[(?:100svh|100dvh|calc\(100dvh)/,
    'the arrival block must fill the first viewport',
  );
});

test('the header is a brand mark with one action — no navigation menu', async () => {
  const shell = await readApp('components/PublicShell.tsx');
  const brand = await readApp('components/TraceSpacesBrand.tsx');
  const styles = await readApp('app/globals.css');
  assert.doesNotMatch(shell, /<nav/, 'the public header must not carry a navigation menu');
  assert.doesNotMatch(shell, /menuOpen|hamburger|nav-toggle/i, 'no mobile hamburger menu');
  for (const retired of ['/book', '/booking-request', '/admin']) {
    assert.doesNotMatch(shell, new RegExp(`href="${retired.replace('/', '\\/')}"`), `the shell must not link to ${retired}`);
  }
  assert.match(shell, /href="\/spaces"/, 'the single call to action leads to the catalogue');
  assert.match(shell, /LanguageSwitcher/, 'the language control is part of the minimal header');
  assert.match(shell, /<TraceSpacesBrand\s*\/>/, 'the supplied TRACE identity is used in the header');
  assert.match(brand, /trace-media\/brand\/trace-logo-transparent\.png/, 'the transparent cutout of the user-supplied artwork is used');
  assert.match(brand, />SPACES</);
  assert.doesNotMatch(brand, /<svg|<path/, 'the supplied TRACE mark must not be reconstructed');
  assert.doesNotMatch(styles, /\.trace-spaces-brand\s*\{[^}]*background:\s*#fff/s, 'the logo must not be pasted into a white rectangle');
  assert.match(shell, /id="main-content"/);
  assert.match(shell, /useT\(\)/, 'shell copy comes from the dictionary');
});

test('the English call to action is labelled exactly "Book a Space" in every language', () => {
  for (const locale of ['en', 'si', 'ta']) {
    assert.equal(typeof dictionaries[locale].chrome.bookCta, 'string');
    assert.ok(dictionaries[locale].chrome.bookCta.trim().length > 0);
  }
  assert.equal(dictionaries.en.chrome.bookCta, 'Book a Space');
  assert.equal(dictionaries.en.hero.bookCta, 'Book a Space');
  assert.equal(dictionaries.en.closing.bookCta, 'Book a Space');
  assert.equal(dictionaries.en.hero.headline, 'Colombo Spaces.');
});

test('the assistant is consistently branded Guider and the header uses the polished floating chrome', async () => {
  const shell = await readApp('components/PublicShell.tsx');
  const assistant = await readApp('components/VenueAssistant.tsx');
  const styles = await readApp('app/globals.css');

  assert.match(shell, /premium-nav/);
  assert.match(styles, /\.premium-nav\s*\{/);
  assert.match(styles, /\.guider-panel\s*\{/);
  assert.match(assistant, /guider-panel/);
  assert.match(assistant, /guider-launcher__icon/);
  assert.match(assistant, /aria-label=\{open \? t\.assistant\.launcherClose : t\.assistant\.launcherOpen\}/);
  assert.doesNotMatch(assistant, />\s*\{open \? t\.assistant\.launcherClose : t\.assistant\.launcherOpen\}\s*</, 'the launcher label must not be visibly rendered');
  for (const locale of ['en', 'si', 'ta']) {
    assert.equal(dictionaries[locale].assistant.title, 'Guider');
    assert.match(dictionaries[locale].assistant.launcherOpen, /Guider/);
    assert.match(dictionaries[locale].assistant.ariaLabel, /Guider/);
  }
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

test('the unified form reaches direct booking with and without JavaScript', async () => {
  const form = await readApp('components/UnifiedRequestForm.tsx');

  assert.match(form, /fetch\(clientApiPath\(['"]\/api\/public\/bookings['"]\)/);
  assert.match(form, /["']Content-Type["']:\s*["']application\/json["']/);
  assert.match(form, /formToken/, 'submissions are idempotent');
  assert.match(form, /method="post"/);
  assert.match(form, /action="\/book"/, 'without JavaScript the form posts to the direct booking route');
  assert.match(form, /name="form_token"/);
  assert.match(form, /name="space_code"/);
  assert.match(form, /role="alert"/);
  assert.match(form, /name="email"/);
  assert.match(form, /name="date"/);
});

test('public checkout copy promises booking, not staff approval', async () => {
  const form = await readApp('components/UnifiedRequestForm.tsx');
  assert.equal(dictionaries.en.request.submit, 'Confirm booking');
  assert.equal(dictionaries.en.venue.requestCta, 'Book this space');
  assert.match(dictionaries.en.request.noticeBody, /locks the selected inventory atomically/i);
  assert.doesNotMatch(JSON.stringify(dictionaries.en.request), /request only|staff approval|send request/i);
  assert.doesNotMatch(form, /api\/public\/booking-requests/);
});

test('no surface promises confirmation before checkout verifies inventory and any required payment', async () => {
  const promise = /(confirm(s|ed)? (your )?reservation immediately|immediate(ly)? confirm|book(ed)? instantly|confirmed instantly|pay later,? confirm now)/i;
  const contradiction = /(staff|team|our office|front desk)[^.]{0,40}(will|must) (now )?confirm( your)? reservation immediately/i;
  for (const file of await sourceFiles()) {
    const content = await readFile(file, 'utf8');
    const label = file.slice(appRoot.length + 1);
    assert.doesNotMatch(content, promise, `${label} over-promises confirmation`);
    assert.doesNotMatch(content, contradiction, `${label} invents a staff confirmation step`);
    assert.doesNotMatch(content, /concierge/i, `${label} must not resurrect the retired concierge channel`);
    assert.doesNotMatch(content, /Direct booking console/i, `${label} uses retired implementation language`);
  }
});

test('the booking form explains the atomic checkout boundary', async () => {
  const en = dictionaries.en;
  assert.match(en.request.noticeBody, /rechecks availability|atomically/i);
  assert.match(en.request.formEyebrow, /Direct booking/i);
  assert.match(en.venue.consoleNote, /confirms immediately|held securely/i);
  assert.match(en.assistant.intro, /prepare your booking details/i);
  assert.doesNotMatch(en.assistant.intro, /confirmed|reserved/i, 'the assistant intro must not claim a booking');
});

test('Guider keeps each new turn visible and restores keyboard focus', async () => {
  const assistant = await readApp('components/VenueAssistant.tsx');
  const styles = await readApp('app/globals.css');

  assert.match(assistant, /messageListRef/);
  assert.match(assistant, /list\.scrollTo\(\{ top: list\.scrollHeight/);
  assert.match(assistant, /prefers-reduced-motion: reduce/);
  assert.match(assistant, /role="log"/);
  assert.match(assistant, /aria-busy=\{busy\}/);
  assert.match(assistant, /launcherRef\.current\?\.focus\(\)/);
  assert.match(assistant, /sendMessage\(starter\)/, 'starter prompts should send instead of only filling the composer');
  assert.match(styles, /\.guider-typing/);
  assert.match(styles, /overscroll-behavior:\s*contain/);
});

test('booking and availability state revalidate live without weakening checkout', async () => {
  const hook = await readApp('lib/useLiveRefresh.ts');
  const manage = await readApp('components/ManageBookingClient.tsx');
  const requestStatus = await readApp('components/RequestStatusClient.tsx');
  const bookingForm = await readApp('components/UnifiedRequestForm.tsx');

  assert.match(hook, /visibilitychange/);
  assert.match(hook, /addEventListener\("focus"/);
  assert.match(hook, /addEventListener\("online"/);
  assert.match(hook, /AbortController/);
  assert.match(hook, /if \(disposed \|\| running\) return/, 'polls must never overlap');

  assert.match(manage, /useLiveRefresh/);
  assert.match(manage, /api\/public\/bookings\/\$\{encodeURIComponent\(reference\)\}/);
  assert.match(requestStatus, /useLiveRefresh/);
  assert.match(requestStatus, /api\/public\/booking-requests\/\$\{encodeURIComponent\(reference\)\}/);
  assert.match(bookingForm, /api\/public\/availability/);
  assert.match(bookingForm, /liveAvailability\.state==="busy"/);
  assert.match(bookingForm, /api\/public\/bookings/, 'the atomic booking endpoint remains the final write');
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

test('legacy capability links keep their native fallback and scripted path', async () => {
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
