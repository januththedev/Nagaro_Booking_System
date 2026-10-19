/**
 * Cut-over acceptance harness for the Next.js public frontend.
 *
 * Boots the real production entry point (src/server/index.js) with
 * PUBLIC_FRONTEND=next plus `next start`, then drives every routing decision
 * through the *public* origin so the same-origin gateway is what is being
 * tested: pages come from Next, while /api, /admin, /assets, /media and the
 * no-JavaScript form posts stay in the Node booking runtime. The final phase
 * restarts the Node runtime with PUBLIC_FRONTEND=legacy to prove the rollback
 * is configuration only.
 *
 * Requires a production build:  npm run build:public
 * Run:  tools\node.cmd scripts/e2e-public-frontend.js
 * Exit: 0 on full pass, 1 on any failure.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BACKEND_PORT = 4218;
const FRONTEND_PORT = 4219;
const root = resolve(import.meta.dirname, '..');
const publicApp = resolve(root, 'apps', 'public-web');
const base = `http://127.0.0.1:${BACKEND_PORT}`;

if (!existsSync(join(publicApp, '.next', 'BUILD_ID'))) {
  console.error('[public-e2e] No production build found. Run: npm run build:public');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'nagaro-public-e2e-'));
const dbPath = join(dir, 'public.db');
const uploadDir = join(dir, 'uploads');
const backendEnv = {
  ...process.env,
  PORT: String(BACKEND_PORT),
  HOST: '127.0.0.1',
  NODE_ENV: 'development',
  NAGARO_DB_PATH: dbPath,
  NAGARO_UPLOAD_DIR: uploadDir,
  NAGARO_DEMO_SEED: '1',
  NAGARO_IP_SALT: 'public-e2e-salt',
  PUBLIC_FRONTEND: 'next',
  PUBLIC_FRONTEND_ORIGIN: `http://127.0.0.1:${FRONTEND_PORT}`,
};

let backend = null;
let backendLog = '';
let frontend = null;
let frontendLog = '';

function spawnBackend(extraEnv = {}) {
  backendLog = '';
  const child = spawn(process.execPath, [join(root, 'src', 'server', 'index.js')], {
    env: { ...backendEnv, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: root,
  });
  child.stdout.on('data', (d) => { backendLog += d; });
  child.stderr.on('data', (d) => { backendLog += d; });
  return child;
}

function spawnFrontend() {
  frontendLog = '';
  const requireFromApp = createRequire(join(publicApp, 'package.json'));
  const nextCli = requireFromApp.resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [nextCli, 'start', '-H', '127.0.0.1', '-p', String(FRONTEND_PORT)], {
    env: {
      ...process.env,
      API_ORIGIN: base,
      API_PROXY_TARGET: base,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: publicApp,
  });
  child.stdout.on('data', (d) => { frontendLog += d; });
  child.stderr.on('data', (d) => { frontendLog += d; });
  return child;
}

async function waitFor(label, request, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await request();
      if (response && response.status < 500) return response;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`[public-e2e] ${label} never became ready.`);
  console.error(`--- node log ---\n${backendLog}\n--- next log ---\n${frontendLog}`);
  shutdown(1);
  return null;
}

function shutdown(code) {
  for (const child of [backend, frontend]) {
    if (child && child.exitCode === null && !child.killed) child.kill();
  }
  setTimeout(() => {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
    process.exit(code);
  }, 600).unref();
}

let passed = 0;
let failed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? '  -- ' + detail : ''}`); }
}

const text = (response) => response.text();
const isNextPage = (html) => html.includes('/_next/static/') && !html.includes('/assets/styles.css');
const isLegacyPage = (html) => html.includes('/assets/styles.css') && !html.includes('/_next/static/');
function locationOf(response) {
  const value = response.headers.get('location') || '';
  try { const url = new URL(value, base); return url.pathname + url.search; } catch { return value; }
}
function formTokenOf(html) {
  const match = html.match(/name="form_token"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ boot */

backend = spawnBackend();
frontend = spawnFrontend();

if (!await waitFor('node runtime', () => fetch(`${base}/api/public/spaces?page=1&pageSize=1`))) process.exit(1);
if (!await waitFor('gateway -> next', () => fetch(base))) process.exit(1);

console.log('\n=== PUBLIC FRONTEND CUT-OVER ACCEPTANCE ===');

const catalogue = await (await fetch(`${base}/api/public/spaces?page=1&pageSize=50`)).json();
const spaces = Array.isArray(catalogue?.items) ? catalogue.items : [];
const venue = spaces[0] ?? null;
if (!venue) {
  console.error('[public-e2e] The demo seed published no venues, so nothing can be verified.');
  shutdown(1);
}

/* ------------------------------------------------- 1. ownership split */

console.log('\n[1] one origin, two owners');
{
  const home = await fetch(base);
  const homeHtml = await text(home);
  check('GET / -> 200', home.ok, `got ${home.status}`);
  check('GET / is rendered by Next.js', isNextPage(homeHtml));
  check('GET / ships the design system from Next', /\/_next\/static\/css\//.test(homeHtml));

  const directory = await fetch(`${base}/spaces`);
  const directoryHtml = await text(directory);
  check('GET /spaces -> 200 from Next.js', directory.ok && isNextPage(directoryHtml));
  check('the directory lists a seeded venue', directoryHtml.includes(venue.name), venue.name);

  const detail = await fetch(`${base}/spaces/${encodeURIComponent(venue.code)}`);
  const detailHtml = await text(detail);
  check(`GET /spaces/${venue.code} -> 200 from Next.js`, detail.ok && isNextPage(detailHtml));
  check('the venue page carries live ledger data', detailHtml.includes(venue.name));

  const booking = await fetch(`${base}/book`);
  const bookingHtml = await text(booking);
  check('GET /book -> 200 from Next.js', booking.ok && isNextPage(bookingHtml));
  check('the direct checkout form is server-rendered', bookingHtml.includes('name="form_token"'));
  check('the direct checkout form keeps a no-JavaScript fallback', bookingHtml.includes('action="/book"'));

  const concierge = await fetch(`${base}/booking-request`);
  const conciergeHtml = await text(concierge);
  check('GET /booking-request -> 200 from Next.js', concierge.ok && isNextPage(conciergeHtml));
  check('the concierge form is readable without JavaScript', conciergeHtml.includes('name="email"'));

  const missing = await fetch(`${base}/a-page-that-does-not-exist`);
  const missingHtml = await text(missing);
  check('unknown public path -> 404 from Next.js', missing.status === 404 && isNextPage(missingHtml), `got ${missing.status}`);
}

/* ------------------------------------- 1b. server payload is complete */

console.log('\n[1b] every page is complete before any JavaScript runs');
{
  const homeHtml = await text(await fetch(base));
  check('the arrival photograph is in the server payload', /<picture[\s\S]{0,400}?loading=|fetchpriority="high"/i.test(homeHtml));
  check('both arrival actions are in the server payload', homeHtml.includes('href="/spaces"') && homeHtml.includes('href="/book"'));
  check('no server-rendered block is hidden pending motion', !/style="[^"]*(opacity:\s*0|visibility:\s*hidden)/i.test(homeHtml));
  check('the hero canvas is absent from the server payload', !homeHtml.includes('<canvas'));
  check('the reveal hooks ship without inline hiding', homeHtml.includes('data-editorial-reveal') && !/data-editorial-reveal[^>]*style="/i.test(homeHtml));

  const bookHtml = await text(await fetch(`${base}/book`));
  check('checkout fields are server-rendered', ['name="space_code"', 'name="date"', 'name="start_time"', 'name="end_time"', 'name="customer_name"', 'name="email"'].every((field) => bookHtml.includes(field)));
  check('the checkout names its stages in words, not numerals', bookHtml.includes('Space &amp; time') && bookHtml.includes('Review &amp; confirm') && !/>\s*0[1-3]\s*</.test(bookHtml));

  const conciergeHtml = await text(await fetch(`${base}/booking-request`));
  check('the inquiry form is complete without JavaScript', ['name="space_code"', 'name="date"', 'name="start_time"', 'name="customer_name"', 'name="email"', 'name="message"'].every((field) => conciergeHtml.includes(field)));
  check('direct checkout is described as immediate in the catalogue', !/staff (will|must) confirm/i.test(conciergeHtml));
}

/* ------------------------------------- 2. node-owned surfaces survive */

console.log('\n[2] the booking runtime keeps everything it owns');
{
  const api = await fetch(`${base}/api/public/spaces?page=1&pageSize=5`);
  const apiBody = await api.json().catch(() => null);
  check('GET /api/public/spaces stays with node -> 200', api.ok, `got ${api.status}`);
  check('api answers as JSON', (api.headers.get('content-type') || '').includes('application/json'));
  check('api returns the paginated envelope', Array.isArray(apiBody?.items) && apiBody.items.length > 0);

  const adminGuard = await fetch(`${base}/api/admin/dashboard/summary`);
  check('GET /api/admin/* stays with node -> 401', adminGuard.status === 401, `got ${adminGuard.status}`);

  const login = await fetch(`${base}/admin/login`);
  const loginHtml = await text(login);
  check('GET /admin/login stays with node -> 200', login.ok && isLegacyPage(loginHtml));
  check('the operator login is the real one, not a Next page', loginHtml.includes('action="/admin/login"') && loginHtml.includes('type="password"'));

  const css = await fetch(`${base}/assets/styles.css`);
  check('GET /assets/styles.css stays with node -> 200', css.ok, `got ${css.status}`);

  const hero = await fetch(`${base}/assets/trace-media/research/trace-spaces-hero.webp`);
  check('the hero photograph is served by node', hero.ok, `got ${hero.status}`);
  check('the hero photograph keeps its content type', (hero.headers.get('content-type') || '').includes('image/'));

  const admin = await fetch(`${base}/admin`, { redirect: 'manual' });
  check('GET /admin stays with node -> redirect to login', admin.status === 303 || admin.status === 302, `got ${admin.status}`);
}

/* ------------------------------------- 3. capability pages stay private */

console.log('\n[3] capability links are unshareable through the gateway');
{
  const manage = await fetch(`${base}/book/manage?ref=NG-2026-00000&token=not-a-real-token`);
  const manageHtml = await text(manage);
  check('GET /book/manage -> 200 from Next.js', manage.ok && isNextPage(manageHtml));
  check('a rejected capability reads as a friendly page', /not recognised/i.test(manageHtml));
  check('manage is no-store', (manage.headers.get('cache-control') || '').includes('no-store'), manage.headers.get('cache-control') || '');
  check('manage is no-referrer', manage.headers.get('referrer-policy') === 'no-referrer');
  check('manage is noindex', (manage.headers.get('x-robots-tag') || '').includes('noindex'));
}

/* --------------------------------- 4. no-JavaScript form fallbacks */

console.log('\n[4] form fallbacks reach the booking runtime, not Next.js');
let confirmedPath = null;
{
  const bookingHtml = await text(await fetch(`${base}/book`));
  const formToken = formTokenOf(bookingHtml);
  check('the direct checkout exposes a live form token', typeof formToken === 'string' && formToken.length >= 20);

  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + 21 * 86_400_000));

  const form = new URLSearchParams({
    form_token: formToken,
    space_code: venue.code,
    date: day,
    start_time: '10:00',
    end_time: '12:00',
    desks: '1',
    attendees: '4',
    customer_name: 'Cutover Guest',
    email: `cutover-${Date.now()}@public.test`,
    phone: '+94 77 111 2222',
    organization: 'Cutover Labs',
    message: 'no-JavaScript fallback',
  });

  const posted = await fetch(`${base}/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  confirmedPath = locationOf(posted);
  check('POST /book -> 303 handled by node', posted.status === 303, `got ${posted.status} ${confirmedPath}`);
  check('POST /book redirects to the private confirmation link', /^\/book\/confirmed\?ref=NG-\d{4}-\d{5}&token=/.test(confirmedPath), confirmedPath);

  const confirmed = await fetch(base + confirmedPath);
  const confirmedHtml = await text(confirmed);
  const reference = (confirmedPath.match(/ref=(NG-\d{4}-\d{5})/) || [])[1];
  check('the private confirmation renders in Next.js', confirmed.ok && isNextPage(confirmedHtml), `got ${confirmed.status}`);
  check('the confirmation shows the booking reference', confirmedHtml.includes(reference), reference);
  check('the confirmation names the reserved venue', confirmedHtml.includes(venue.name));
  check('direct checkout is stated as confirmed, not pending', /confirm/i.test(confirmedHtml) && !/awaiting confirmation|staff will confirm|pending approval/i.test(confirmedHtml));

  const inquiryHtml = await text(await fetch(`${base}/booking-request`));
  check('the concierge form exposes its fields without JavaScript', inquiryHtml.includes('name="message"'));

  const inquiry = new URLSearchParams({
    space_code: venue.code,
    date: day,
    start_time: '14:00',
    end_time: '16:00',
    desks: '1',
    customer_name: 'Cutover Concierge',
    email: `concierge-${Date.now()}@public.test`,
    phone: '+94 77 333 4444',
    organization: 'Cutover Labs',
    attendees: '8',
    message: 'no-JavaScript concierge inquiry',
  });
  const inquiryPosted = await fetch(`${base}/booking-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: inquiry,
    redirect: 'manual',
  });
  const receivedPath = locationOf(inquiryPosted);
  check('POST /booking-request -> 303 handled by node', inquiryPosted.status === 303, `got ${inquiryPosted.status}`);
  check('the inquiry redirects to its receipt', /^\/booking-request\/received\?ref=INQ-\d{4}-\d+/.test(receivedPath), receivedPath);

  const received = await fetch(base + receivedPath);
  const receivedHtml = await text(received);
  check('the inquiry receipt renders in Next.js', received.ok && isNextPage(receivedHtml));
  check('the receipt states the inquiry is provisional', /provisional/i.test(receivedHtml));
  check('the receipt offers a withdrawal path', /withdraw/i.test(receivedHtml));
}

/* --------------------------------- 5. JSON contract through the gateway */

console.log('\n[5] the client-side checkout contract crosses the gateway');
let jsonReference = null;
let jsonToken = null;
{
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + 42 * 86_400_000));

  const create = await fetch(`${base}/api/public/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      form_token: `cutover-e2e-${Date.now()}`,
      space_code: venue.code,
      date: day,
      start_time: '10:00',
      end_time: '12:00',
      desks: '1',
      attendees: '3',
      customer_name: 'Gateway Guest',
      email: `gateway-${Date.now()}@public.test`,
      phone: '+94 77 555 6666',
      organization: 'Gateway Labs',
      message: 'JSON checkout through the gateway',
    }),
  });
  const created = await create.json().catch(() => null);
  jsonReference = created?.data?.reservation?.reference ?? null;
  jsonToken = created?.data?.manageToken ?? null;

  check('POST /api/public/bookings -> 201', create.status === 201, `got ${create.status} ${JSON.stringify(created)?.slice(0, 200)}`);
  check('the JSON checkout returns a reference and capability', Boolean(jsonReference && jsonToken), JSON.stringify(created)?.slice(0, 200));
  check('the JSON checkout is no-store', (create.headers.get('cache-control') || '').includes('no-store'));
  check('the JSON checkout never leaks customer PII', !Object.hasOwn(created?.data?.reservation ?? {}, 'customer'));

  const manage = await fetch(`${base}/api/public/bookings/${encodeURIComponent(jsonReference)}`, {
    headers: { Authorization: `Bearer ${jsonToken}`, Accept: 'application/json' },
  });
  check('the capability lookup crosses the gateway -> 200', manage.status === 200, `got ${manage.status}`);

  const cancel = await fetch(`${base}/api/public/bookings/${encodeURIComponent(jsonReference)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${jsonToken}` },
    body: JSON.stringify({ reference: jsonReference, token: jsonToken }),
  });
  const cancelled = await cancel.json().catch(() => null);
  check('cancelling through the gateway -> 200', cancel.status === 200, `got ${cancel.status}`);
  check('the cancelled reservation is marked CANCELLED', cancelled?.data?.reservation?.status === 'CANCELLED');
}

/* ------------------------------------------------- 6. instant rollback */

console.log('\n[6] the legacy renderer is still one environment variable away');
{
  backend.kill();
  await new Promise((r) => setTimeout(r, 700));
  backend = spawnBackend({ PUBLIC_FRONTEND: 'legacy' });
  await waitFor('node runtime (legacy mode)', () => fetch(`${base}/api/public/spaces?page=1&pageSize=1`));

  const home = await fetch(base);
  const homeHtml = await text(home);
  check('legacy GET / -> 200', home.ok, `got ${home.status}`);
  check('legacy GET / is rendered by node', isLegacyPage(homeHtml));
  check('legacy home still lists published venues', homeHtml.includes(venue.name));

  const detail = await fetch(`${base}/spaces/${encodeURIComponent(venue.code)}`);
  const detailHtml = await text(detail);
  check('legacy venue page -> 200 from node', detail.ok && isLegacyPage(detailHtml));

  const booking = await fetch(`${base}/book`);
  const bookingHtml = await text(booking);
  check('legacy checkout still renders', booking.ok && isLegacyPage(bookingHtml));
  check('legacy checkout keeps its own form token', formTokenOf(bookingHtml) !== null);
}

backend.kill();
frontend.kill();
await new Promise((r) => setTimeout(r, 500));
try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('Failures:');
  for (const failure of failures) console.log('  - ' + failure);
  process.exit(1);
}
process.exit(0);
