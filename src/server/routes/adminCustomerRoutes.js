/**
 * Admin customer routes.
 *
 *   GET  /admin/customers              directory with q / sort / hasUpcoming filters
 *   GET  /admin/customers/new          creation form (query pre-fill supported)
 *   POST /admin/customers              create, with the duplicate-review gate
 *   GET  /admin/customers/:id          profile: stats, upcoming, history, frequent spaces
 *   GET  /admin/customers/:id/edit     edit form
 *   POST /admin/customers/:id          update (409 on duplicate email)
 *   GET  /api/admin/customers/search   typeahead for the booking form (staff only)
 *
 * Two rules shape every handler here:
 *
 *   1. Customer data is staff-only (ARCHITECTURE.md §8). Every route starts
 *      with `requireAuth(ctx)`, including the JSON search endpoint.
 *   2. Records are NEVER merged automatically. Before a create is committed
 *      the possible-duplicate list is shown to staff, and `createCustomer`
 *      only runs with `allowDuplicate: true` when the form explicitly
 *      confirmed the duplicate (`confirm_duplicate=1`).
 *
 * Handlers stay thin: parse the request, call a service, render or serialise.
 * All rules live in `customerService`.
 */
import { AppError, notFound } from '../domain/errors.js';
import { RESERVATION_STATUS } from '../domain/constants.js';
import { LIMITS, asPagination } from '../domain/validation.js';
import { q } from '../http/request.js';
import { appendCookie, redirect, serializeCookie } from '../http/response.js';
import { FLASH_COOKIE, requireAuth, requireCsrf } from '../security/sessions.js';
import {
  createCustomer, customerFrequentSpaces, customerUpcomingReservations,
  findPossibleDuplicates, getCustomerHistory, getCustomerOrThrow, parseCustomerPayload,
  searchCustomers, updateCustomer,
} from '../services/customerService.js';
import {
  customerDirectoryView, customerFormView, customerFormValuesFromCustomer, customerProfileView,
} from '../../web/views/admin/customerViews.js';

/** How many matching customers the `hasUpcoming` filter is willing to scan. */
const DIRECTORY_SCAN_LIMIT = 1000;
/** Typeahead page size cap (the booking form only ever needs a handful). */
const SEARCH_MAX_ITEMS = 25;
const SEARCH_MIN_QUERY = 2;
const HISTORY_LIMIT = 100;

const FLASH_MAX_AGE_SECONDS = 30;

export function registerAdminCustomerRoutes(router, deps = {}) {
  const { db } = deps;
  const requireStaff = typeof deps.requireAuth === 'function' ? deps.requireAuth : requireAuth;
  const guardCsrf = typeof deps.requireCsrf === 'function' ? deps.requireCsrf : requireCsrf;
  const setFlash = typeof deps.setFlash === 'function' ? deps.setFlash : fallbackSetFlash;

  /* ------------------------------------------------------------ directory */

  router.get('/admin/customers', async (ctx) => {
    const actor = requireStaff(ctx);
    const filters = readDirectoryFilters(ctx.query);
    const { page, pageSize } = asPagination(ctx.query);
    const result = listDirectoryCustomers(db, { filters, page, pageSize });

    ctx.html(customerDirectoryView({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      items: result.items,
      total: result.total,
      filters,
      page,
      pageSize,
      truncated: result.truncated,
      scanLimit: DIRECTORY_SCAN_LIMIT,
    }));
  });

  /* --------------------------------------------------------- create page */

  router.get('/admin/customers/new', async (ctx) => {
    const actor = requireStaff(ctx);
    // Pre-fill from an inquiry: ?name=&email=&phone=&organization=
    ctx.html(customerFormView({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      mode: 'create',
      values: {
        full_name: readQueryText(ctx.query, 'name', LIMITS.maxNameLength),
        email: readQueryText(ctx.query, 'email', LIMITS.maxEmailLength),
        phone: readQueryText(ctx.query, 'phone', LIMITS.maxPhoneLength),
        organization: readQueryText(ctx.query, 'organization', LIMITS.maxNameLength),
        notes: '',
      },
    }));
  });

  router.post('/admin/customers', async (ctx) => {
    const actor = requireStaff(ctx);
    const body = await ctx.readBody();
    guardCsrf(ctx);

    const values = readFormValues(body);
    const confirmDuplicate = isChecked(body.confirm_duplicate);

    // 1. Validate before anything else so a broken form is rejected cheaply and
    //    the duplicate check runs on a real email address.
    let payload;
    try {
      payload = parseCustomerPayload(body);
    } catch (error) {
      if (!isValidationError(error)) throw error;
      ctx.html(customerFormView({
        actor,
        csrfToken: ctx.csrfToken,
        flash: ctx.flash,
        mode: 'create',
        values,
        errors: fieldErrorsFrom(error),
        problems: generalProblemsFrom(error),
      }), 422);
      return;
    }

    // 2. Show possible duplicates. Nothing is merged and nothing is saved yet.
    const duplicates = findPossibleDuplicates(db, {
      email: payload.email,
      fullName: payload.fullName,
    });
    if (duplicates.length > 0 && !confirmDuplicate) {
      ctx.html(customerFormView({
        actor,
        csrfToken: ctx.csrfToken,
        flash: ctx.flash,
        mode: 'create',
        values,
        duplicates,
      }), 422);
      return;
    }

    // 3. Only an explicit confirmation lets a duplicate email be stored.
    let customer;
    try {
      customer = createCustomer(db, {
        actor,
        payload: body,
        allowDuplicate: confirmDuplicate,
      });
    } catch (error) {
      if (!isAppError(error)) throw error;
      if (error.code === 'CONFLICT') {
        // The service refused (e.g. the same email was created concurrently).
        const matches = findPossibleDuplicates(db, { email: payload.email, fullName: payload.fullName });
        ctx.html(customerFormView({
          actor,
          csrfToken: ctx.csrfToken,
          flash: ctx.flash,
          mode: 'create',
          values,
          duplicates: matches,
          problems: [error.message],
        }), 422);
        return;
      }
      ctx.html(customerFormView({
        actor,
        csrfToken: ctx.csrfToken,
        flash: ctx.flash,
        mode: 'create',
        values,
        errors: fieldErrorsFrom(error),
        problems: generalProblemsFrom(error),
      }), 422);
      return;
    }

    setFlash(ctx, { kind: 'success', message: `Created customer ${customer.fullName}.` });
    redirect(ctx.res, `/admin/customers/${customer.id}`);
    ctx.responded = true;
  });

  /* -------------------------------------------------------------- profile */

  router.get('/admin/customers/:id', async (ctx) => {
    const actor = requireStaff(ctx);
    const customerId = parseId(ctx.params.id);
    const customer = customerId === null ? null : getCustomerOrThrow(db, customerId);
    if (!customer) throw notFound('Customer not found.');

    ctx.html(customerProfileView({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      customer,
      history: getCustomerHistory(db, customer.id, { limit: HISTORY_LIMIT }),
      upcoming: customerUpcomingReservations(db, customer.id, Date.now()),
      frequentSpaces: customerFrequentSpaces(db, customer.id, { limit: 5 }),
    }));
  });

  /* ----------------------------------------------------------- edit page */

  router.get('/admin/customers/:id/edit', async (ctx) => {
    const actor = requireStaff(ctx);
    const customerId = parseId(ctx.params.id);
    const customer = customerId === null ? null : getCustomerOrThrow(db, customerId);
    if (!customer) throw notFound('Customer not found.');

    ctx.html(customerFormView({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      mode: 'edit',
      customerId: customer.id,
      values: customerFormValuesFromCustomer(customer),
    }));
  });

  router.post('/admin/customers/:id', async (ctx) => {
    const actor = requireStaff(ctx);
    const body = await ctx.readBody();
    guardCsrf(ctx);

    const customerId = parseId(ctx.params.id);
    const existing = customerId === null ? null : getCustomerOrThrow(db, customerId);
    if (!existing) throw notFound('Customer not found.');

    let updated;
    try {
      updated = updateCustomer(db, { actor, customerId: existing.id, payload: body });
    } catch (error) {
      if (!isAppError(error)) throw error;

      if (error.code === 'CONFLICT') {
        // Duplicate email: name the clashing profile instead of a bare message.
        const attempted = typeof body.email === 'string' ? body.email : '';
        const clash = findPossibleDuplicates(db, { email: attempted })
          .find((entry) => entry.match === 'email' && entry.customer.id !== existing.id);
        ctx.html(customerFormView({
          actor,
          csrfToken: ctx.csrfToken,
          flash: ctx.flash,
          mode: 'edit',
          customerId: existing.id,
          values: readFormValues(body),
          conflictMessage: error.message,
          conflictCustomer: clash ? clash.customer : null,
        }), 409);
        return;
      }

      ctx.html(customerFormView({
        actor,
        csrfToken: ctx.csrfToken,
        flash: ctx.flash,
        mode: 'edit',
        customerId: existing.id,
        values: readFormValues(body),
        errors: fieldErrorsFrom(error),
        problems: generalProblemsFrom(error),
      }), 422);
      return;
    }

    setFlash(ctx, { kind: 'success', message: `Updated customer ${updated.fullName}.` });
    redirect(ctx.res, `/admin/customers/${updated.id}`);
    ctx.responded = true;
  });

  /* -------------------------------------------------------- search (JSON) */

  router.get('/api/admin/customers/search', async (ctx) => {
    // Staff only: this endpoint exposes names, emails and phone numbers.
    requireStaff(ctx);

    const query = readQueryText(ctx.query, 'q', LIMITS.maxQueryLength).trim();
    if (query.length < SEARCH_MIN_QUERY) {
      // Never dump the whole directory for a one-character (or empty) query.
      ctx.json({ items: [] });
      return;
    }

    const requested = Number(q(ctx.query, 'limit', 10));
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), SEARCH_MAX_ITEMS)
      : 10;

    const result = searchCustomers(db, { query, limit });
    ctx.json({
      items: result.items.map((customer) => ({
        id: customer.id,
        fullName: customer.fullName,
        email: customer.email,
        phone: customer.phone,
        organization: customer.organization,
        confirmedReservations: customer.stats.confirmedReservations,
      })),
    });
  });
}

/* ------------------------------------------------------------------ helpers */

/** `?name=&email=&phone=&organization=` pre-fill for the creation form. */
function readQueryText(query, key, max) {
  const value = q(query, key, '');
  const text = Array.isArray(value) ? value[0] : value;
  return String(text ?? '').replace(/\u0000/g, '').slice(0, max);
}

function parseId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readDirectoryFilters(query) {
  const rawSort = String(q(query, 'sort', 'name') ?? '').trim();
  const sort = ['name', 'recent', 'bookings'].includes(rawSort) ? rawSort : 'name';

  const rawUpcoming = String(q(query, 'hasUpcoming', '') ?? '').trim().toLowerCase();
  const hasUpcoming = ['true', '1', 'yes', 'on'].includes(rawUpcoming) ? true
    : ['false', '0', 'no', 'off'].includes(rawUpcoming) ? false
      : null;

  return { q: readQueryText(query, 'q', LIMITS.maxQueryLength).trim(), sort, hasUpcoming };
}

/**
 * Directory listing. `hasUpcoming` is not a column, so the filter walks the
 * service in page-sized chunks: `searchCustomers` stays the single source of
 * truth for matching and ordering, and the walk is bounded so one broad filter
 * can never scan an unbounded table.
 */
function listDirectoryCustomers(db, { filters, page, pageSize }) {
  const base = { query: filters.q || null, sort: filters.sort };
  const offset = (page - 1) * pageSize;

  if (filters.hasUpcoming === null) {
    const result = searchCustomers(db, { ...base, limit: pageSize, offset });
    return { total: result.total, items: result.items, truncated: false };
  }

  const withUpcoming = customersWithUpcomingReservations(db);
  const matched = [];
  let scanned = 0;
  let truncated = false;

  for (;;) {
    const chunk = searchCustomers(db, { ...base, limit: LIMITS.maxPageSize, offset: scanned });
    for (const item of chunk.items) {
      if (withUpcoming.has(item.id) === filters.hasUpcoming) matched.push(item);
    }
    scanned += chunk.items.length;
    if (chunk.items.length < LIMITS.maxPageSize) break; // end of the result set
    if (scanned >= DIRECTORY_SCAN_LIMIT) {
      truncated = chunk.total > scanned;
      break;
    }
  }

  return { total: matched.length, items: matched.slice(offset, offset + pageSize), truncated };
}

/**
 * One read of "which customers still have a confirmed booking in the future".
 * Mirrors `customerUpcomingReservations` (CONFIRMED and `end_at >= now`) for
 * every customer at once, so the directory filter does not run N queries.
 */
function customersWithUpcomingReservations(db, now = Date.now()) {
  const rows = db.prepare(`
    SELECT DISTINCT customer_id FROM reservation
     WHERE status = ? AND end_at >= ?
  `).all(RESERVATION_STATUS.CONFIRMED, now);
  return new Set(rows.map((row) => row.customer_id));
}

/** Values kept for redisplay after a rejected submission (never trusted as input). */
function readFormValues(body = {}) {
  const read = (key, max) => {
    const value = body?.[key];
    const text = Array.isArray(value) ? value[0] : value;
    return String(text ?? '').replace(/\u0000/g, '').slice(0, max);
  };
  return {
    full_name: read('full_name', LIMITS.maxNameLength),
    email: read('email', LIMITS.maxEmailLength),
    phone: read('phone', LIMITS.maxPhoneLength),
    organization: read('organization', LIMITS.maxNameLength),
    notes: read('notes', LIMITS.maxLongTextLength),
  };
}

function isChecked(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());
}

function isAppError(error) {
  return error instanceof AppError || (error && typeof error.code === 'string' && typeof error.status === 'number');
}

function isValidationError(error) {
  return isAppError(error) && error.code === 'VALIDATION_ERROR';
}

/**
 * Service validation errors carry either `{ field }` (single field, message in
 * `error.message`) or a `{ field: message }` map. Normalise both to the map
 * shape the views expect.
 */
function fieldErrorsFrom(error) {
  const details = error?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  if (typeof details.field === 'string' && details.field) {
    return { [details.field]: error.message };
  }
  const entries = Object.entries(details).filter(([, value]) => typeof value === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** Messages that belong to the form as a whole (`details.problems`). */
function generalProblemsFrom(error) {
  const problems = error?.details?.problems;
  if (Array.isArray(problems) && problems.length > 0) return problems.map(String);
  if (!fieldErrorsFrom(error)) return [String(error?.message ?? 'The record could not be saved.')];
  return [];
}

/**
 * Fallback flash writer, used only when the route module is registered without
 * the application's `setFlash` dependency. Mirrors the app-wide cookie contract
 * (`nagaro_flash`, URL-encoded JSON `{ kind, message }`, HttpOnly, SameSite=Lax).
 */
function fallbackSetFlash(ctx, { kind = 'success', message, problems = null }) {
  if (!ctx || !ctx.res) return;
  const payload = JSON.stringify({ kind, message, problems: problems ?? undefined });
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, payload, {
    maxAgeSeconds: FLASH_MAX_AGE_SECONDS,
    httpOnly: true,
    secure: Boolean(ctx.secure),
  }));
}
