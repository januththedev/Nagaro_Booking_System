/**
 * End-to-end acceptance harness for the Nagaro booking system.
 *
 * Boots the REAL production entry point (src/server/index.js) against a
 * throwaway database and drives every P0/P1 flow over HTTP with real form
 * submissions, CSRF tokens, cookies and a real PNG upload.
 *
 * Run:  tools\node.cmd scripts/e2e-verify.js
 * Exit: 0 on full pass, 1 on any failure.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const md5Upper = (value) => createHash('md5').update(String(value)).digest('hex').toUpperCase();

const PORT = 4217;
const dir = mkdtempSync(join(tmpdir(), 'nagaro-e2e-'));
const dbPath = join(dir, 'e2e.db');
const uploadDir = join(dir, 'uploads');
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  NODE_ENV: 'development',
  NAGARO_DB_PATH: dbPath,
  NAGARO_UPLOAD_DIR: uploadDir,
  NAGARO_BOOTSTRAP_ADMIN_EMAIL: 'admin@e2e.test',
  NAGARO_BOOTSTRAP_ADMIN_PASSWORD: 'E2eAdminPass123',
  NAGARO_BOOTSTRAP_ADMIN_NAME: 'E2E Admin',
  NAGARO_ADMIN_NOTIFICATION_EMAIL: 'office@e2e.test',
  NAGARO_IP_SALT: 'e2e-salt',
  // Sandbox-shaped credentials so the harness can exercise the real PayHere
  // signature rules locally. They are test values only and grant nothing.
  PAYHERE_MERCHANT_ID: '1210000',
  PAYHERE_MERCHANT_SECRET: 'e2e-payhere-secret',
  PAYHERE_SANDBOX: '1',
};

// Spaces are bookable 08:00-18:00 Sri Lanka Standard Time (UTC+05:30, no DST).
// A probe derived from the current wall clock falls outside those hours
// whenever the suite happens to run late in the Colombo afternoon/evening, which
// made this check fail purely as a function of what time it was run. Pin the
// probe to a deterministic 10:00-12:00 SLST window on a future date instead:
// the intent (a valid future window returns 2xx) is unchanged, and the result no
// longer depends on the host clock.
const SLST_OFFSET_MS = 330 * 60000;
function slstWindow(daysAhead, startHour, durationHours) {
  const slst = new Date(Date.now() + daysAhead * 86400000 + SLST_OFFSET_MS);
  slst.setUTCHours(startHour, 0, 0, 0);
  const start = slst.getTime() - SLST_OFFSET_MS;
  return { start, end: start + durationHours * 3600000 };
}

const child = spawn(process.execPath, ['src/server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() });
let bootLog = '';
child.stdout.on('data', (d) => { bootLog += d; });
child.stderr.on('data', (d) => { bootLog += d; });

const base = `http://127.0.0.1:${PORT}`;

const cookies = new Map();
function cookieHeader() { return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
function storeCookies(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const m = c.match(/^([^=]+)=([^;]*)/);
    if (m) cookies.set(m[1].trim(), m[2].trim());
  }
}
async function req(method, path, { form, multipart, headers = {}, redirect = 'manual' } = {}) {
  const h = { ...headers };
  if (cookies.size) h.Cookie = cookieHeader();
  let payload;
  if (form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) params.append(k, v);
    payload = params;
    h['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (multipart) {
    payload = multipart;
  }
  const res = await fetch(base + path, { method, headers: h, body: payload, redirect });
  storeCookies(res);
  return res;
}

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  FAIL  ${label}${detail ? '  -- ' + detail : ''}`); }
}
function csrfOf(html) { const m = html.match(/name="_csrf"\s+value="([^"]+)"/); return m ? m[1] : null; }
function locPath(res) {
  const l = res.headers.get('location') || '';
  try { const u = new URL(l, base); return u.pathname + u.search; } catch { return l; }
}

let ready = false;
for (let i = 0; i < 80; i += 1) {
  try { const r = await fetch(base + '/'); if (r.status < 500) { ready = true; break; } } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) { console.error('Server never became ready. Boot log:\n' + bootLog); child.kill(); process.exit(1); }

console.log('\n=== E2E ACCEPTANCE ===');

// 1. unauthenticated
console.log('\n[1] unauthenticated admin access');
{
  const r = await req('GET', '/admin');
  check('GET /admin without session -> 303', r.status === 303, `got ${r.status}`);
  check('redirects to login', (r.headers.get('location') || '').includes('/admin/login'));
  const r2 = await req('GET', '/api/admin/dashboard/summary');
  check('GET /api/admin/dashboard/summary without session -> 401', r2.status === 401);
  const j = await r2.json();
  check('error code UNAUTHORIZED', j?.error?.code === 'UNAUTHORIZED');
}

// 2. sign in
console.log('\n[2] admin sign in');
let csrf;
{
  const r = await req('GET', '/admin/login');
  check('GET /admin/login -> 200', r.status === 200);
  const r2 = await req('POST', '/admin/login', { form: { email: 'admin@e2e.test', password: 'E2eAdminPass123', next: '/admin' } });
  check('POST login -> 303', r2.status === 303, `got ${r2.status}`);
  check('session cookie set', cookies.has('nagaro_session'));
  const r3 = await req('GET', '/admin');
  const dashHtml = await r3.text();
  check('GET /admin after login -> 200', r3.status === 200);
  check('dashboard shows live figures', dashHtml.includes('All figures are read live'));
}

// 3. create space
console.log('\n[3] create a meeting room (no photo yet)');
let spaceId, spaceCode = 'E2E-MEET';
{
  const r = await req('GET', '/admin/spaces/new');
  const html = await r.text();
  const c = csrfOf(html); if (c) csrf = c;
  const form = {
    _csrf: csrf,
    code: spaceCode,
    name: 'E2E Meeting Room',
    category: 'MEETING_ROOM',
    capacity: '12',
    short_description: 'A meeting room created by the e2e harness.',
    description: 'An exclusive meeting room used for end-to-end verification of the booking system.',
    location: 'Floor 2, Trace Expert City',
    floor: '2',
    currency: 'LKR',
    pricing_unit: 'HOUR',
    min_duration_minutes: '30',
    max_duration_minutes: '480',
    buffer_minutes: '0',
    open_time: '08:00',
    close_time: '18:00',
    amenities: 'wifi',
    contact_note: '',
    rates_HOUR: '1500.00',
    rates_HALF_DAY: '4500.00',
  };
  const r2 = await req('POST', '/admin/spaces', { form });
  check('POST create space -> 303', r2.status === 303, `got ${r2.status}`);
  const lp = locPath(r2);
  const m = lp.match(/\/admin\/spaces\/(\d+)/);
  spaceId = m ? m[1] : null;
  check('redirected to space detail with id', !!spaceId, lp);
}

// 4. publish gate (no photo)
console.log('\n[4] publish blocked without a photograph');
{
  const r = await req('GET', `/admin/spaces/${spaceId}`);
  const c = csrfOf(await r.text()); if (c) csrf = c;
  const r2 = await req('POST', `/admin/spaces/${spaceId}/publish`, { form: { _csrf: csrf } });
  check('publish without photo -> 303 (blocked)', r2.status === 303, `got ${r2.status}`);
  const r3 = await req('GET', `/admin/spaces/${spaceId}`);
  const html = await r3.text();
  check('space still DRAFT', html.toLowerCase().includes('draft'));
}

// 5. upload a real PNG
console.log('\n[5] upload a photograph (magic-byte validated)');
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
{
  const r = await req('GET', `/admin/spaces/${spaceId}`);
  const c = csrfOf(await r.text()); if (c) csrf = c;
  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('alt_text', 'E2E test photo');
  fd.append('images', new Blob([pngBytes], { type: 'image/png' }), 'photo.png');
  const r2 = await req('POST', `/admin/spaces/${spaceId}/images`, { multipart: fd });
  check('image upload -> 303', r2.status === 303, `got ${r2.status}`);
  const r3 = await req('GET', `/admin/spaces/${spaceId}`);
  const html3 = await r3.text();
  check('space now has a photo', html3.includes('/media/') || html3.toLowerCase().includes('cover'));
}

// 6. publish
console.log('\n[6] publish after photo upload');
{
  const r = await req('GET', `/admin/spaces/${spaceId}`);
  const c = csrfOf(await r.text()); if (c) csrf = c;
  const r2 = await req('POST', `/admin/spaces/${spaceId}/publish`, { form: { _csrf: csrf } });
  check('publish with photo -> 303', r2.status === 303, `got ${r2.status}`);
  const r3 = await req('GET', `/admin/spaces/${spaceId}`);
  const html = await r3.text();
  check('space now PUBLISHED', html.toUpperCase().includes('PUBLISHED'));
}

// 7. public browse + availability
console.log('\n[7] public browse and availability');
{
  const r = await req('GET', '/');
  check('GET / -> 200', r.status === 200);
  const home = await r.text();
  check('home mentions the space', home.includes('E2E Meeting Room'));
  const r2 = await req('GET', '/spaces');
  check('GET /spaces -> 200', r2.status === 200);
  const r3 = await req('GET', `/spaces/${spaceCode}`);
  check('GET /spaces/:code -> 200', r3.status === 200);
  const detail = await r3.text();
  check('detail shows no PII', !detail.includes('admin@e2e.test'));
  const r4 = await req('GET', '/api/public/spaces');
  check('GET /api/public/spaces -> 200', r4.status === 200);
  const j = await r4.json();
  check('public spaces include our space', Array.isArray(j.items) && j.items.some((s) => s.code === spaceCode));
  const probe = slstWindow(30, 10, 2);
  const r5 = await req('GET', `/api/public/availability?space=${spaceCode}&start=${probe.start}&end=${probe.end}`);
  check('GET /api/public/availability -> 2xx', r5.status >= 200 && r5.status < 300, `got ${r5.status}`);
}

// 8. create customer
console.log('\n[8] create a customer');
let customerId;
{
  const r = await req('GET', '/admin/customers/new');
  const c = csrfOf(await r.text()); if (c) csrf = c;
  const r2 = await req('POST', '/admin/customers', { form: {
    _csrf: csrf, full_name: 'E2E Customer', email: 'cust@e2e.test', phone: '+94900000000', organization: 'Trace Labs', notes: 'e2e',
  } });
  check('POST create customer -> 303', r2.status === 303, `got ${r2.status}`);
  const r4 = await req('GET', '/api/admin/customers/search?q=E2E+Customer');
  const j = await r4.json();
  const arr = Array.isArray(j) ? j : (j.items ?? []);
  customerId = arr[0]?.id;
  check('customer search returns id', !!customerId, JSON.stringify(j).slice(0, 200));
}

// 9. create reservation
console.log('\n[9] create a reservation');
let reservationId, reservationRef;
{
  const r = await req('GET', '/admin/reservations/new');
  const html = await r.text();
  const c = csrfOf(html); if (c) csrf = c;
  const futureDate = '2026-11-15';
  const form = {
    _csrf: csrf,
    space_id: spaceId,
    customer_id: customerId,
    customer_search: 'E2E Customer',
    date: futureDate,
    start_time: '09:00',
    end_time: '11:00',
    unit_count: '1',
    attendees: '5',
    purpose: 'e2e booking',
    internal_notes: 'internal only',
    billing_unit: 'HOUR',
  };
  const r2 = await req('POST', '/admin/reservations', { form });
  check('POST create reservation -> 303', r2.status === 303, `got ${r2.status} ${locPath(r2)}`);
  const lp = locPath(r2);
  const m = lp.match(/\/admin\/reservations\/(\d+)/);
  reservationId = m ? m[1] : null;
  check('redirected to reservation detail', !!reservationId, lp);
  if (reservationId) {
    const r3 = await req('GET', `/admin/reservations/${reservationId}`);
    const html3 = await r3.text();
    const rm = html3.match(/NG-\d{4}-\d+/);
    reservationRef = rm ? rm[0] : null;
    check('detail shows reference', !!reservationRef);
    check('detail shows status', html3.toLowerCase().includes('confirmed'));
  }
}

// 10. conflicting reservation rejected
console.log('\n[10] conflicting booking is rejected (no second reservation)');
{
  const before = await req('GET', '/admin/reservations');
  const beforeHtml = await before.text();
  const beforeCount = (beforeHtml.match(/NG-\d{4}-\d+/g) || []).length;
  const r = await req('GET', '/admin/reservations/new');
  const c = csrfOf(await r.text()); if (c) csrf = c;
  const r2 = await req('POST', '/admin/reservations', { form: {
    _csrf: csrf, space_id: spaceId, customer_id: customerId, customer_search: 'E2E Customer',
    date: '2026-11-15', start_time: '09:30', end_time: '10:30', unit_count: '1',
    purpose: 'conflict attempt', billing_unit: 'HOUR',
  } });
  check('conflicting POST -> rejected (303 or 409)', r2.status === 303 || r2.status === 409, `got ${r2.status}`);
  const r3 = await req('GET', '/admin/reservations');
  const afterHtml = await r3.text();
  const afterCount = (afterHtml.match(/NG-\d{4}-\d+/g) || []).length;
  check('no new reservation created', afterCount === beforeCount, `${beforeCount} -> ${afterCount}`);
}

// 11. conflicting edit rejected, original unchanged
console.log('\n[11] conflicting edit rejected, original unchanged');
{
  const r = await req('GET', '/admin/reservations/new');
  const c = csrfOf(await r.text()); if (c) csrf = c;
  const r2 = await req('POST', '/admin/reservations', { form: {
    _csrf: csrf, space_id: spaceId, customer_id: customerId, customer_search: 'E2E Customer',
    date: '2026-11-15', start_time: '13:00', end_time: '15:00', unit_count: '1',
    purpose: 'second booking', billing_unit: 'HOUR',
  } });
  check('second reservation created', r2.status === 303, `got ${r2.status}`);
  const r3 = await req('GET', `/admin/reservations/${reservationId}/edit`);
  const c2 = csrfOf(await r3.text()); if (c2) csrf = c2;
  const r4 = await req('POST', `/admin/reservations/${reservationId}`, { form: {
    _csrf: csrf, space_id: spaceId, customer_id: customerId, customer_search: 'E2E Customer',
    date: '2026-11-15', start_time: '12:30', end_time: '14:30', unit_count: '1',
    purpose: 'edited to conflict', billing_unit: 'HOUR',
    form_token: 'edit-token-1',
  } });
  check('conflicting edit -> rejected (303 or 409)', r4.status === 303 || r4.status === 409, `got ${r4.status}`);
  const r5 = await req('GET', `/admin/reservations/${reservationId}`);
  const html = await r5.text();
  check('original window preserved (09:00)', html.includes('09:00'));
  check('original window preserved (11:00)', html.includes('11:00'));
}

// 12. cancellation
console.log('\n[12] cancellation requires a reason; releases inventory');
{
  const r = await req('GET', `/admin/reservations/${reservationId}`);
  const c = csrfOf(await r.text()); if (c) csrf = c;
  const r2 = await req('POST', `/admin/reservations/${reservationId}/cancel`, { form: { _csrf: csrf, cancellation_reason: '   ' } });
  check('blank reason -> 422 (rejected)', r2.status === 422, `got ${r2.status}`);
  const r3 = await req('GET', `/admin/reservations/${reservationId}`);
  const html = await r3.text();
  check('still CONFIRMED after blank reason', html.toLowerCase().includes('confirmed'));

  const r4 = await req('GET', `/admin/reservations/${reservationId}`);
  const c2 = csrfOf(await r4.text()); if (c2) csrf = c2;
  const r5 = await req('POST', `/admin/reservations/${reservationId}/cancel`, { form: { _csrf: c2, cancellation_reason: 'E2E test cancellation' } });
  check('cancel with reason -> 303', r5.status === 303, `got ${r5.status}`);
  const r6 = await req('GET', `/admin/reservations/${reservationId}`);
  const html6 = await r6.text();
  check('status CANCELLED', html6.toLowerCase().includes('cancelled') || html6.toLowerCase().includes('canceled'));
  check('reason recorded', html6.includes('E2E test cancellation'));

  const r7 = await req('GET', `/admin/reservations/${reservationId}`);
  const c3 = csrfOf(await r7.text()); if (c3) csrf = c3;
  const r8 = await req('POST', `/admin/reservations/${reservationId}/cancel`, { form: { _csrf: c3, cancellation_reason: 'again' } });
  check('second cancel -> rejected (409)', r8.status === 409 || r8.status === 422, `got ${r8.status}`);
}

// 13. retired inquiry channel + preserved legacy capability endpoints
console.log('\n[13] retired inquiry channel + legacy capability endpoints');
{
  const r = await req('GET', '/booking-request');
  check('GET /booking-request -> catalogue redirect (channel retired)', r.status === 308 && locPath(r) === '/spaces', `${r.status} ${locPath(r)}`);

  const posted = await req('POST', '/booking-request', { form: {
    _csrf: csrf,
    space_code: spaceCode,
    date: '2026-11-20',
    start_time: '10:00',
    end_time: '12:00',
    desks: '1',
    customer_name: 'Inquiry Person',
    email: 'inq@e2e.test',
    message: 'please confirm',
  } });
  check('POST inquiry -> catalogue redirect (channel retired)', posted.status === 303 && locPath(posted) === '/spaces', `${posted.status} ${locPath(posted)}`);

  // Historical inquiry links keep working: the withdrawal endpoints stay alive
  // and unknown tokens are refused without leaking anything.
  const withdrawForm = await req('GET', '/booking-request/withdraw');
  check('legacy withdraw page rejects incomplete links -> 400', withdrawForm.status === 400, `got ${withdrawForm.status}`);
  const withdrawHtml = await withdrawForm.text();
  check('unknown inquiry reads as unrecognised', /not recognised|withdraw/i.test(withdrawHtml));

  const withdrawToken = 'legacy-token-that-is-long-enough-0123456789';
  const c = csrfOf(withdrawHtml) || csrf;
  const postedWithdraw = await req('POST', '/booking-request/withdraw', { form: { _csrf: c, reference: 'INQ-2020-00001', token: withdrawToken } });
  check('legacy withdraw endpoint stays alive', postedWithdraw.status < 500, `got ${postedWithdraw.status}`);

  const r4 = await req('GET', '/admin/inquiries');
  check('admin inquiry queue still serves historical inquiries', r4.status === 200, `got ${r4.status}`);
}

// 14. maintenance block
console.log('\n[14] maintenance block');
{
  const r = await req('GET', '/admin/maintenance');
  check('GET /admin/maintenance -> 200', r.status === 200);
  const c = csrfOf(await r.text()); if (c) csrf = c;
  const r2 = await req('POST', '/admin/maintenance', { form: {
    _csrf: csrf, space_id: spaceId, date: '2026-11-25', start_time: '13:00', end_time: '14:00', reason: 'E2E maintenance',
  } });
  check('POST maintenance -> 303', r2.status === 303, `got ${r2.status}`);
}

// 15. calendar, audit, dashboard API
console.log('\n[15] calendar, audit, dashboard API');
{
  check('GET /admin/calendar -> 200', (await req('GET', '/admin/calendar')).status === 200);
  check('GET /admin/audit -> 200', (await req('GET', '/admin/audit')).status === 200);
  const r = await req('GET', '/api/admin/calendar/events');
  check('GET /api/admin/calendar/events -> 200', r.status === 200);
  const r2 = await req('GET', '/api/admin/dashboard/summary');
  check('GET /api/admin/dashboard/summary -> 200', r2.status === 200);
  const j = await r2.json();
  check('summary has activeSpaces', !!j.activeSpaces);
}

// 16. media is inert
console.log('\n[16] media serving is inert');
{
  const r = await req('GET', `/admin/spaces/${spaceId}`);
  const html = await r.text();
  const m = html.match(/\/media\/([a-f0-9]{32}\.(?:jpg|png|webp))/);
  if (m) {
    const r2 = await fetch(base + '/media/' + m[1]);
    check('media -> 200', r2.status === 200);
    check('media has CSP sandbox', (r2.headers.get('content-security-policy') || '').includes('sandbox'));
    check('media has nosniff', r2.headers.get('x-content-type-options') === 'nosniff');
  } else {
    console.log('  SKIP  no media URL found in space page');
  }
}

// 17. unified request -> approval -> booking-fee payment contract
console.log('\n[17] unified request -> approval -> payment contract');
{
  const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

  // 17a. the retired dual channel is closed: only the unified request remains.
  const retiredDirect = await fetch(base + '/api/public/bookings', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ form_token: 'retired', space_code: spaceCode, date: '2030-01-01', start_time: '10:00', end_time: '11:00', customer_name: 'Retired Guest', email: 'retired@e2e.test' }),
  });
  check('POST /api/public/bookings -> 410 (direct confirmation retired)', retiredDirect.status === 410, `got ${retiredDirect.status}`);
  const retiredConcierge = await fetch(base + '/api/public/inquiries', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ space_code: spaceCode, date: '2030-01-01', start_time: '10:00', end_time: '11:00', customer_name: 'Retired Guest', email: 'retired@e2e.test' }),
  });
  check('POST /api/public/inquiries -> 410 (concierge channel retired)', retiredConcierge.status === 410, `got ${retiredConcierge.status}`);
  const retiredForm = await req('POST', '/book', { form: { form_token: 'retired', space_code: spaceCode, date: '2030-01-01', start_time: '10:00', end_time: '11:00', customer_name: 'Retired Guest', email: 'retired@e2e.test' } });
  check('POST /book form -> catalogue redirect', retiredForm.status === 303 && locPath(retiredForm) === '/spaces', `${retiredForm.status} ${locPath(retiredForm)}`);
  const retiredInquiryForm = await req('POST', '/booking-request', { form: { space_code: spaceCode, date: '2030-01-01', start_time: '10:00', end_time: '11:00', customer_name: 'Retired Guest', email: 'retired@e2e.test' } });
  check('POST /booking-request form -> catalogue redirect', retiredInquiryForm.status === 303 && locPath(retiredInquiryForm) === '/spaces', `${retiredInquiryForm.status} ${locPath(retiredInquiryForm)}`);

  // 17b. a request records intent; it holds no inventory and confirms nothing.
  const window = slstWindow(32, 10, 2);
  const dateKey = new Date(window.start + SLST_OFFSET_MS).toISOString().slice(0, 10);
  const request = {
    spaceCode, date: dateKey, startTime: '10:00', endTime: '12:00',
    unitCount: '1', attendees: '6', purpose: 'Unified request E2E',
    formToken: `e2e-req-${Date.now()}`,
    fullName: 'Request Guest', email: `request-guest-${Date.now()}@e2e.test`,
    phone: '+94 77 000 0001', organization: 'Request Labs',
  };
  const createRequest = () => fetch(base + '/api/public/booking-requests', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(request) });
  const created = await createRequest();
  const createdBody = await created.json().catch(() => null);
  check('POST /api/public/booking-requests -> 201', created.status === 201, `got ${created.status}`);
  check('request response is no-store', (created.headers.get('cache-control') || '').includes('no-store'));
  check('request response is no-referrer', created.headers.get('referrer-policy') === 'no-referrer');
  const reqRef = createdBody?.request?.reference;
  const reqToken = createdBody?.manageToken;
  check('request returns a REQ reference', /^REQ-\d{4}-\d{5}$/.test(reqRef || ''), JSON.stringify(createdBody).slice(0, 200));
  check('request returns a capability token', typeof reqToken === 'string' && reqToken.length >= 40);
  check('a new request is honestly unconfirmed', createdBody?.request?.status === 'REQUESTED');
  check('a new request is honestly unpaid', createdBody?.request?.paymentStatus === 'UNPAID');

  const availabilityUrl = `${base}/api/public/availability?space=${encodeURIComponent(spaceCode)}&start=${encodeURIComponent(new Date(window.start).toISOString())}&end=${encodeURIComponent(new Date(window.end).toISOString())}&desks=1`;
  const freeBefore = await fetch(availabilityUrl, { headers: { Accept: 'application/json' } });
  const freeBeforeBody = await freeBefore.json().catch(() => null);
  check('a pending request holds no inventory', freeBeforeBody?.isAvailable === true, JSON.stringify(freeBeforeBody).slice(0, 160));

  const retried = await createRequest();
  const retriedBody = await retried.json().catch(() => null);
  check('idempotent request retry -> 200', retried.status === 200, `got ${retried.status}`);
  check('idempotent retry keeps one request', retriedBody?.request?.reference === reqRef && retriedBody?.idempotent === true);

  if (reqRef && reqToken) {
    const capability = () => fetch(`${base}/api/public/booking-requests/${encodeURIComponent(reqRef)}`, { headers: { Authorization: `Bearer ${reqToken}`, Accept: 'application/json' } });

    const read = await capability();
    const readBody = await read.json().catch(() => null);
    check('capability lookup -> 200', read.status === 200, `got ${read.status}`);
    check('capability lookup is no-store', (read.headers.get('cache-control') || '').includes('no-store'));
    check('capability lookup projects no customer PII', !Object.hasOwn(readBody?.request ?? {}, 'customer'));

    const wrongToken = await fetch(`${base}/api/public/booking-requests/${encodeURIComponent(reqRef)}`, { headers: { Authorization: 'Bearer wrong-token-value-that-is-long-enough', Accept: 'application/json' } });
    check('wrong request capability -> 404', wrongToken.status === 404, `got ${wrongToken.status}`);

    // 17c. the administrator sets the booking fee and approves the request.
    const queue = await req('GET', '/admin/booking-requests');
    const queueHtml = await queue.text();
    check('admin approval queue renders the request', queue.status === 200 && queueHtml.includes(reqRef), `got ${queue.status}`);
    const queueToken = csrfOf(queueHtml);

    const policy = await req('POST', '/admin/booking-requests/fee-policy', { form: { _csrf: queueToken, mode: 'FIXED', fixed_cents: '50000', percentage_bps: '0', payment_window_minutes: '30' } });
    check('booking fee policy is administrator-configurable', [302, 303].includes(policy.status), `got ${policy.status}`);

    const approve = await req('POST', `/admin/booking-requests/${encodeURIComponent(reqRef)}/approve`, { form: { _csrf: queueToken } });
    check('approval redirects back to the queue', [302, 303].includes(approve.status), `got ${approve.status}`);

    const held = await capability();
    const heldBody = await held.json().catch(() => null);
    check('approval moves the request to awaiting payment', heldBody?.request?.status === 'APPROVED_AWAITING_PAYMENT', String(heldBody?.request?.status));
    check('the fee snapshot is immutable and visible', heldBody?.request?.payment?.bookingFeeCents === 50000);
    check('approval states the hold deadline', Number(heldBody?.request?.holdExpiresAt) > Date.now());

    const heldNow = await fetch(availabilityUrl, { headers: { Accept: 'application/json' } });
    const heldNowBody = await heldNow.json().catch(() => null);
    check('an approved hold reserves inventory', heldNowBody?.isAvailable === false, JSON.stringify(heldNowBody).slice(0, 160));

    // 17d. PayHere checkout parameters, then a correctly signed sandbox callback.
    const checkoutRes = await fetch(`${base}/api/public/booking-requests/${encodeURIComponent(reqRef)}/payment`, { method: 'POST', headers: { Authorization: `Bearer ${reqToken}`, Accept: 'application/json' } });
    const checkoutBody = await checkoutRes.json().catch(() => null);
    const checkout = checkoutBody?.checkout;
    check('payment endpoint returns PayHere checkout parameters', checkoutRes.status === 200 && String(checkout?.action || '').includes('payhere.lk'), JSON.stringify(checkoutBody).slice(0, 160));
    const fields = checkout?.fields ?? {};
    check('checkout amounts use PayHere money format', /^\d+\.\d{2}$/.test(fields.amount || ''), String(fields.amount));
    check('checkout names the notification endpoint', String(fields.notify_url || '').includes('/api/public/payments/payhere/notify'));
    check('checkout hash matches the documented algorithm', fields.hash === md5Upper(`${fields.merchant_id}${fields.order_id}${fields.amount}${fields.currency}${md5Upper('e2e-payhere-secret')}`));

    const sig = md5Upper(`${fields.merchant_id}${fields.order_id}${fields.amount}${fields.currency}2${md5Upper('e2e-payhere-secret')}`);
    const notifyBody = new URLSearchParams({
      merchant_id: fields.merchant_id, order_id: fields.order_id, payment_id: 'E2E-PAY-1',
      payhere_amount: fields.amount, payhere_currency: fields.currency, status_code: '2',
      method: 'VISA', status_message: 'Success', md5sig: sig,
    }).toString();
    const notify = await fetch(base + '/api/public/payments/payhere/notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: notifyBody });
    check('signed PayHere callback -> 200 OK', notify.status === 200 && (await notify.text()) === 'OK', `got ${notify.status}`);

    const confirmed = await capability();
    const confirmedBody = await confirmed.json().catch(() => null);
    check('verified payment confirms the request', confirmedBody?.request?.status === 'CONFIRMED', String(confirmedBody?.request?.status));
    check('payment state is recorded as paid', confirmedBody?.request?.paymentStatus === 'PAID');
    check('confirmation creates a real reservation', /^NG-\d{4}-\d{5}$/.test(confirmedBody?.request?.reservationReference || ''), String(confirmedBody?.request?.reservationReference));

    const duplicate = await fetch(base + '/api/public/payments/payhere/notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: notifyBody });
    check('duplicate callback stays idempotent -> 200', duplicate.status === 200, `got ${duplicate.status}`);
    const afterDuplicate = await capability();
    const afterDuplicateBody = await afterDuplicate.json().catch(() => null);
    check('duplicate callback confirms nothing twice', afterDuplicateBody?.request?.reservationReference === confirmedBody?.request?.reservationReference);

    const forged = await fetch(base + '/api/public/payments/payhere/notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ merchant_id: fields.merchant_id, order_id: fields.order_id, payment_id: 'E2E-FORGED', payhere_amount: '999999.00', payhere_currency: 'LKR', status_code: '2', md5sig: 'FORGED' }).toString() });
    check('forged callback -> 400 INVALID', forged.status === 400, `got ${forged.status}`);

    // 17e. a competing request is recorded but can never take the same window.
    const competitor = await fetch(base + '/api/public/booking-requests', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...request, formToken: `e2e-req-competitor-${Date.now()}`, email: `competitor-${Date.now()}@e2e.test`, fullName: 'Competing Guest' }) });
    const competitorBody = await competitor.json().catch(() => null);
    check('competing request is recorded (requests hold nothing)', competitor.status === 201, `got ${competitor.status}`);
    const competitorRef = competitorBody?.request?.reference;
    if (competitorRef) {
      const competitorApprove = await req('POST', `/admin/booking-requests/${encodeURIComponent(competitorRef)}/approve`, { form: { _csrf: queueToken } });
      check('approving a conflicting request is refused', competitorApprove.status === 409, `got ${competitorApprove.status}`);
    }

    // 17f. the customer can withdraw a request before any decision.
    const cancelRequest = await fetch(base + '/api/public/booking-requests', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...request, formToken: `e2e-req-cancel-${Date.now()}`, email: `cancel-me-${Date.now()}@e2e.test`, fullName: 'Cancel Guest' }) });
    const cancelRequestBody = await cancelRequest.json().catch(() => null);
    const cancelRef = cancelRequestBody?.request?.reference;
    const cancelToken = cancelRequestBody?.manageToken;
    if (cancelRef && cancelToken) {
      const cancel = await fetch(`${base}/api/public/booking-requests/${encodeURIComponent(cancelRef)}/cancel`, {
        method: 'POST',
        headers: { ...jsonHeaders, Authorization: `Bearer ${cancelToken}` },
        body: JSON.stringify({ reason: 'Plans changed' }),
      });
      const cancelBody = await cancel.json().catch(() => null);
      check('customer can cancel a request -> 200', cancel.status === 200, `got ${cancel.status}`);
      check('cancelled request is honestly terminal', cancelBody?.request?.status === 'CANCELLED');
    }
  }
}

child.kill();
await new Promise((r) => setTimeout(r, 500));
try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) { console.log('Failures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
process.exit(0);
