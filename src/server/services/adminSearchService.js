/**
 * Admin global search. Read-only and staff-only.
 *
 * The query is deliberately small and bounded: four/five result groups, each
 * capped, and every group uses the same explicit allowlist of columns. No
 * password hashes, capability tokens, payment secrets or internal notes are
 * returned.
 */
import { isAdminRole } from '../domain/constants.js';
import { forbidden, validationError } from '../domain/errors.js';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;
const MIN_QUERY = 2;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function likePattern(query) {
  const escaped = String(query).replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

function group(kind, label, items) {
  return { kind, label, items };
}

export function searchAdmin(db, { query, limit = DEFAULT_LIMIT } = {}) {
  const term = text(query, 120);
  const capped = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  if (term.length < MIN_QUERY) return { query: term, groups: [], total: 0 };
  const pattern = likePattern(term);
  const groups = [];

  const spaces = db.prepare(`
    SELECT id, code, name, category, status, location
      FROM space
     WHERE LOWER(name) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(code) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(COALESCE(location, '')) LIKE LOWER(?) ESCAPE '\\'
     ORDER BY CASE WHEN status = 'PUBLISHED' THEN 0 ELSE 1 END, LOWER(name)
     LIMIT ?
  `).all(pattern, pattern, pattern, capped);
  if (spaces.length) {
    groups.push(group('spaces', 'Spaces', spaces.map((space) => ({
      id: space.id,
      title: space.name,
      subtitle: [space.code, space.location].filter(Boolean).join(' \u00b7 '),
      meta: `${space.status} \u00b7 ${space.category.replaceAll('_', ' ').toLowerCase()}`,
      href: `/admin/spaces/${space.id}`,
    }))));
  }

  const customers = db.prepare(`
    SELECT id, full_name, email, organization
      FROM customer
     WHERE LOWER(full_name) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(email) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(COALESCE(organization, '')) LIKE LOWER(?) ESCAPE '\\'
     ORDER BY LOWER(full_name)
     LIMIT ?
  `).all(pattern, pattern, pattern, capped);
  if (customers.length) {
    groups.push(group('customers', 'Customers', customers.map((customer) => ({
      id: customer.id,
      title: customer.full_name,
      subtitle: [customer.email, customer.organization].filter(Boolean).join(' \u00b7 '),
      meta: 'Customer profile',
      href: `/admin/customers/${customer.id}`,
    }))));
  }

  const reservations = db.prepare(`
    SELECT r.id, r.reference, r.status, r.start_at, r.end_at,
           c.full_name AS customer_name, s.code AS space_code, s.name AS space_name
      FROM reservation r
      JOIN customer c ON c.id = r.customer_id
      JOIN space s ON s.id = r.space_id
     WHERE LOWER(r.reference) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(c.full_name) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(c.email) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(s.code) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(s.name) LIKE LOWER(?) ESCAPE '\\'
     ORDER BY r.start_at DESC
     LIMIT ?
  `).all(pattern, pattern, pattern, pattern, pattern, capped);
  if (reservations.length) {
    groups.push(group('reservations', 'Reservations', reservations.map((reservation) => ({
      id: reservation.id,
      title: reservation.reference,
      subtitle: [reservation.customer_name, reservation.space_code, reservation.space_name].filter(Boolean).join(' \u00b7 '),
      meta: `${reservation.status} \u00b7 ${new Date(Number(reservation.start_at) + 5.5 * 3600000).toISOString().slice(0, 16).replace('T', ' ')} SLST`,
      href: `/admin/reservations/${reservation.id}`,
    }))));
  }

  const requests = db.prepare(`
    SELECT br.id, br.reference, br.status, br.customer_name, br.email,
           s.code AS space_code, s.name AS space_name
      FROM booking_request br
      JOIN space s ON s.id = br.space_id
     WHERE LOWER(br.reference) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(br.customer_name) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(br.email) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(s.code) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(s.name) LIKE LOWER(?) ESCAPE '\\'
     ORDER BY br.created_at DESC
     LIMIT ?
  `).all(pattern, pattern, pattern, pattern, pattern, capped);
  if (requests.length) {
    groups.push(group('requests', 'Booking requests', requests.map((request) => ({
      id: request.id,
      title: request.reference,
      subtitle: [request.customer_name, request.email, request.space_code].filter(Boolean).join(' \u00b7 '),
      meta: request.status.replaceAll('_', ' ').toLowerCase(),
      href: `/admin/booking-requests?status=all&q=${encodeURIComponent(request.reference)}`,
    }))));
  }

  const inquiries = db.prepare(`
    SELECT id, reference, status, customer_name, email, organization
      FROM inquiry
     WHERE LOWER(reference) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(customer_name) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(email) LIKE LOWER(?) ESCAPE '\\'
        OR LOWER(COALESCE(organization, '')) LIKE LOWER(?) ESCAPE '\\'
     ORDER BY created_at DESC
     LIMIT ?
  `).all(pattern, pattern, pattern, pattern, capped);
  if (inquiries.length) {
    groups.push(group('inquiries', 'Inquiries', inquiries.map((inquiry) => ({
      id: inquiry.id,
      title: inquiry.reference,
      subtitle: [inquiry.customer_name, inquiry.email, inquiry.organization].filter(Boolean).join(' \u00b7 '),
      meta: inquiry.status.toLowerCase(),
      href: `/admin/inquiries/${inquiry.id}`,
    }))));
  }

  return { query: term, groups, total: groups.reduce((sum, entry) => sum + entry.items.length, 0) };
}

export function assertSearchActor(actor) {
  if (!actor?.id || !isAdminRole(actor.role)) throw forbidden('This search is available to administrators only.');
  if (!actor.id) throw validationError('An authenticated staff actor is required.');
}
