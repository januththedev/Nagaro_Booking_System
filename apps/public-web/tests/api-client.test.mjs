/**
 * The server-side API client talks to the Node booking runtime across the
 * gateway. These tests pin the envelope the client expects and, just as
 * importantly, the graceful degradation: a public page must still render when
 * the booking runtime is unreachable instead of throwing a 500.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { clientApiPath, getBooking, getSpace, getSpaces } from '../lib/api.ts';

const SPACE = {
  code: 'bay-07',
  name: 'Bay 07',
  category: 'EVENT_SPACE',
  capacity: 120,
  pricePerHourCents: 1_500_000,
  pricePerHour: '15000.00',
  currency: 'LKR',
  location: 'TRACE Expert City, Colombo',
  openTime: '08:00',
  closeTime: '18:00',
  images: [],
};

async function withStubApi(handler, fn) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const previousOrigin = process.env.API_ORIGIN;
  process.env.API_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(requests);
  } finally {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
    server.close();
    await once(server, 'close');
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(payload);
}

test('the catalogue is read from the paginated public spaces envelope', async () => {
  await withStubApi((req, res) => {
    if (req.url.startsWith('/api/public/spaces?')) {
      return json(res, 200, { items: [SPACE], page: 1, pageSize: 100, total: 1 });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND', message: 'no route' } });
  }, async (requests) => {
    const result = await getSpaces();
    assert.equal(result.available, true);
    assert.equal(result.spaces.length, 1);
    assert.equal(result.spaces[0].code, 'bay-07');

    const query = new URL(requests[0].url, 'http://stub.invalid').searchParams;
    assert.equal(query.get('page'), '1');
    assert.equal(query.get('sort'), 'name');
    assert.equal(requests[0].method, 'GET');
    assert.match(requests[0].headers.accept, /application\/json/);
  });
});

test('a booking runtime that is down degrades to an empty, flagged catalogue', async () => {
  const previousOrigin = process.env.API_ORIGIN;
  // Port 1 is reserved and never listening, so the request fails at connect time.
  process.env.API_ORIGIN = 'http://127.0.0.1:1';
  try {
    const result = await getSpaces();
    assert.deepEqual(result, { spaces: [], available: false });
  } finally {
    if (previousOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = previousOrigin;
  }
});

test('a single venue resolves, and an unknown venue resolves to null instead of throwing', async () => {
  await withStubApi((req, res) => {
    if (req.url === '/api/public/spaces/bay-07') return json(res, 200, SPACE);
    return json(res, 404, { error: { code: 'SPACE_NOT_FOUND', message: 'Unknown space.' } });
  }, async (requests) => {
    const space = await getSpace('bay-07');
    assert.equal(space?.name, 'Bay 07');

    const missing = await getSpace('does-not-exist');
    assert.equal(missing, null);
    assert.equal(requests.length, 2);
  });
});

test('capability lookups require both parts, send the bearer token, and unwrap the envelope', async () => {
  const reservation = { reference: 'NG-2026-00001', status: 'CONFIRMED', currency: 'LKR' };

  await withStubApi((req, res) => {
    if (req.headers.authorization !== 'Bearer secret-capability-token') {
      return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    }
    return json(res, 200, { ok: true, data: { reservation } });
  }, async (requests) => {
    assert.equal(await getBooking('', ''), null);
    assert.equal(await getBooking('NG-2026-00001', ''), null);
    assert.equal(await getBooking('', 'secret-capability-token'), null);
    assert.equal(requests.length, 0, 'an incomplete reference must never reach the network');

    const booking = await getBooking('NG-2026-00001', 'secret-capability-token');
    assert.equal(booking?.reference, 'NG-2026-00001');
    assert.equal(requests[0].headers.authorization, 'Bearer secret-capability-token');
    assert.equal(requests[0].url, '/api/public/bookings/NG-2026-00001');

    const denied = await getBooking('NG-2026-00001', 'wrong-token');
    assert.equal(denied, null, 'a rejected capability must read as "not found", never as an error page');
  });
});

test('the browser-side path builder honours an explicit API base and stays relative by default', () => {
  const previous = process.env.NEXT_PUBLIC_API_BASE;

  delete process.env.NEXT_PUBLIC_API_BASE;
  assert.equal(clientApiPath('/api/public/bookings'), '/api/public/bookings');

  process.env.NEXT_PUBLIC_API_BASE = 'https://api.example.test/';
  assert.equal(clientApiPath('/api/public/bookings'), 'https://api.example.test/api/public/bookings');

  if (previous === undefined) delete process.env.NEXT_PUBLIC_API_BASE;
  else process.env.NEXT_PUBLIC_API_BASE = previous;
});
