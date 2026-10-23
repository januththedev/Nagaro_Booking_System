import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBookingRequestsPage } from '../../src/web/views/admin/bookingRequestViews.js';

const baseItem = {
  reference: 'REQ-2026-00001',
  status: 'REQUESTED',
  paymentStatus: 'UNPAID',
  spaceCode: 'TRC-MR-01',
  spaceName: 'Meeting Room 1',
  startAt: Date.UTC(2026, 9, 22, 4, 30),
  endAt: Date.UTC(2026, 9, 22, 5, 30),
  unitCount: 1,
  attendees: 6,
  purpose: 'Board meeting',
  venueTotalCents: 125000,
  currency: 'LKR',
  holdExpiresAt: null,
  rejectionReason: null,
  reservationReference: null,
  customer: { fullName: 'Test Customer', email: 'test@example.com', organization: 'Acme' },
  payment: {
    bookingFeeCents: 50000,
    advancePaidCents: 0,
    remainingBalanceCents: 75000,
    currency: 'LKR',
    latestAttempt: null,
  },
};

function render(items, overrides = {}) {
  return String(renderBookingRequestsPage({
    actor: { role: 'SUPER_ADMIN', displayName: 'Owner' },
    csrfToken: 'test-csrf',
    items,
    policy: { mode: 'DISABLED', fixedCents: 0, percentageBps: 0, paymentWindowMinutes: 120 },
    filters: { status: 'open', q: '' },
    ...overrides,
  }));
}

test('request inbox shows a scannable card with one-click approval and a reasoned rejection', () => {
  const html = render([baseItem]);
  assert.match(html, /REQ-2026-00001/);
  assert.match(html, /Test Customer/);
  assert.match(html, /Meeting Room 1/);
  assert.match(html, /Approve request/);
  assert.match(html, /Reject request/);
  assert.match(html, /Reason for rejection/);
  assert.match(html, /Open 1|New request/);
});

test('request inbox filters by status tab and search term', () => {
  const confirmed = {
    ...baseItem,
    reference: 'REQ-2026-00002',
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
    customer: { fullName: 'Another Customer', email: 'other@example.com' },
  };
  assert.match(render([baseItem, confirmed]), /REQ-2026-00001/);
  assert.doesNotMatch(render([baseItem, confirmed]), /REQ-2026-00002/);

  const searched = render([baseItem, confirmed], { filters: { status: 'all', q: 'another' } });
  assert.match(searched, /REQ-2026-00002/);
  assert.doesNotMatch(searched, /REQ-2026-00001/);
});

test('request inbox escapes customer-supplied strings', () => {
  const html = render([{
    ...baseItem,
    customer: { fullName: '<script>alert(1)</script>', email: 'evil@example.com' },
  }]);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('registration fee settings are hidden from accounts without an admin role', () => {
  const html = render([baseItem], { actor: { role: 'STAFF', displayName: 'Staff' } });
  assert.doesNotMatch(html, /Registration fee policy/);
});
