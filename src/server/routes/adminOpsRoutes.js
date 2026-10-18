/**
 * Admin operations routes: the dashboard, the inquiry queue, the maintenance
 * list and creation form, and the activity log — plus the two admin JSON
 * endpoints that expose the same read models.
 *
 * Contract notes that shaped this file:
 *   - `dashboardService` is read, never re-implemented. Every number on the
 *     dashboard page comes from `dashboardSummary`, `todaysReservations`,
 *     `upcomingReservations`, `currentOccupancy`, `spaceUtilisation`,
 *     `listAudit` or `listInquiries`, all called in the handler below.
 *   - `inquiryService.listInquiries` has no delivery-state filter and no
 *     count-free paging, so the `emailStatus` filter of the queue is applied
 *     to the newest 200 matching rows (the service's own hard cap) and the
 *     page says so in words rather than pretending the count is global.
 *   - `updateInquiryStatus` does *not* refuse `CONVERTED` without a linked
 *     reservation, so this route refuses that transition itself and flashes
 *     the reason. See the report that accompanies this file.
 *   - Reported contract: all admin HTML mutations are POST -> 303 + flash.
 */
import { q } from '../http/request.js';
import { appendCookie, redirect, serializeCookie } from '../http/response.js';
import {
  FLASH_COOKIE, requireAuth as requireAuthFromSessions,
  requireCsrf as requireCsrfFromSessions,
} from '../security/sessions.js';
import { AppError, notFound } from '../domain/errors.js';
import {
  asDateKey, asInteger, asPagination, asTrimmedString, LIMITS, oneOf,
  parseBookingWindow, requiredString,
} from '../domain/validation.js';
import { businessDateKey, businessLocalToEpoch, MS } from '../domain/time.js';
import { INQUIRY_EMAIL_STATUS, INQUIRY_STATUS, SPACE_CATEGORY } from '../domain/constants.js';
import {
  bookingFilterOptions, currentOccupancy, dashboardSummary, recentChanges,
  spaceUtilisation, todaysReservations, upcomingReservations,
} from '../services/dashboardService.js';
import {
  getInquiry, inquiryStats, listInquiries, updateInquiryStatus,
} from '../services/inquiryService.js';
import { listAudit } from '../services/auditService.js';
import { getSpaceByCode, listSpaces } from '../services/spaceService.js';
import { listAdminUsers } from '../services/adminUserService.js';
import {
  cancelMaintenanceBlock, createMaintenanceBlock, listMaintenanceBlocks,
} from '../services/bookingService.js';
import { availabilityLabel, getSpaceAvailability } from '../services/availabilityService.js';
import {
  renderAuditPage, renderDashboardPage, renderInquiryDetailPage,
  renderInquiryListPage, renderMaintenancePage,
} from '../../web/views/admin/opsViews.js';

/** Hard cap of `auditService.listAudit` — the audit page filters inside it. */
const AUDIT_SCAN_LIMIT = 200;
/** Reservation list cap on the dashboard's "today" and "upcoming" tables. */
const DASHBOARD_RESERVATION_CAP = 50;
/** Inquiries scanned when listing the ones whose email was not delivered. */
const UNDELIVERED_SCAN_LIMIT = 50;
const UNDELIVERED_SHOWN = 10;
/** Maintenance list cap. */
const MAINTENANCE_LIST_LIMIT = 200;

export function registerAdminOpsRoutes(router, deps = {}) {
  const db = deps.db;

  /* ------------------------------------------------ maintenance ownership */
  // `src/server/routes/adminBookingRoutes.js` is owned by another agent and may
  // also register the maintenance mutations. Register ours only when that file
  // did not, so a duplicate can never silently shadow either handler.
  const maintenanceCreateOwned = routeExists(router, 'POST', '/admin/maintenance');
  const maintenanceCancelOwned = routeExists(router, 'POST', '/admin/maintenance/:id/cancel');
  if (maintenanceCreateOwned || maintenanceCancelOwned) {
    console.warn(
      '[admin-ops] another route module already registers '
        + `${maintenanceCreateOwned ? 'POST /admin/maintenance' : ''}`
        + `${maintenanceCreateOwned && maintenanceCancelOwned ? ' and ' : ''}`
        + `${maintenanceCancelOwned ? 'POST /admin/maintenance/:id/cancel' : ''}`
        + ' — adminOpsRoutes will not duplicate them.',
    );
  }

  /* ------------------------------------------------------------ dashboard */

  router.get('/admin', async (ctx) => {
    const actor = checkAuth(ctx, deps);
    const now = Date.now();

    // Every figure on the page below comes from one of these calls.
    const summary = dashboardSummary(db, { now });
    const todays = todaysReservations(db, { now });
    const upcoming = upcomingReservations(db, { now, days: 30, limit: DASHBOARD_RESERVATION_CAP });
    const availability = currentOccupancy(db, { now });
    const utilisation = spaceUtilisation(db, {
      fromAt: businessLocalToEpoch(summary.businessDate, '00:00'),
      toAt: businessLocalToEpoch(summary.businessDate, '00:00') + 30 * MS.DAY,
      limit: 12,
    });

    // Inquiries needing attention: NEW and CONTACTED, newest first.
    const attention = [
      ...listInquiries(db, { status: INQUIRY_STATUS.NEW, limit: 25 }).items,
      ...listInquiries(db, { status: INQUIRY_STATUS.CONTACTED, limit: 25 }).items,
    ]
      .sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id))
      .slice(0, 25);

    // Requests whose notification email was not delivered. The count is the
    // service's own all-time count; the listed references are the newest
    // matches inside the scan window.
    const undeliveredScan = listInquiries(db, { limit: UNDELIVERED_SCAN_LIMIT, sort: 'newest' }).items;
    const undelivered = {
      count: summary.inquiries.awaitingEmailDelivery,
      items: undeliveredScan
        .filter((inquiry) => isUndelivered(inquiry)
          && inquiry.status !== INQUIRY_STATUS.CLOSED
          && inquiry.status !== INQUIRY_STATUS.WITHDRAWN)
        .slice(0, UNDELIVERED_SHOWN),
    };

    const reservationChanges = listAudit(db, { entityType: 'reservation', limit: 8 });
    const otherChanges = recentChanges(db, { limit: 12 })
      .filter((entry) => entry.entityType !== 'reservation');

    ctx.html(renderDashboardPage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      summary,
      today: todays.filter((reservation) => reservation.status !== 'CANCELLED'),
      cancelledToday: todays.filter((reservation) => reservation.status === 'CANCELLED'),
      upcoming: {
        groups: groupByBusinessDay(upcoming),
        shown: upcoming.length,
        total: summary.upcoming.next30Days,
      },
      availability,
      utilisation,
      attention,
      undelivered,
      reservationChanges,
      recentChanges: otherChanges,
    }));
  });

  /* -------------------------------------------------------- inquiry queue */

  router.get('/admin/inquiries', async (ctx) => {
    const actor = checkAuth(ctx, deps);

    const status = optionalOneOf(q(ctx.query, 'status'), Object.values(INQUIRY_STATUS), 'status');
    const emailStatus = optionalOneOf(q(ctx.query, 'emailStatus'), Object.values(INQUIRY_EMAIL_STATUS), 'emailStatus');
    const search = textOrNull(q(ctx.query, 'q'));
    const from = optionalDate(q(ctx.query, 'from'), 'from');
    const to = optionalDate(q(ctx.query, 'to'), 'to');
    const { page, pageSize, offset } = asPagination({
      page: q(ctx.query, 'page'),
      pageSize: q(ctx.query, 'pageSize') ?? LIMITS.defaultPageSize,
    });

    const spaceResult = resolveSpaceFilter(db, q(ctx.query, 'space'));
    const spaceId = spaceResult.spaceId;

    let items = [];
    let total = 0;
    let filteredWithinWindow = false;

    if (!spaceResult.unresolved) {
      if (emailStatus) {
        // The service has no delivery-state filter; filter the newest window.
        const scan = listInquiries(db, {
          status, spaceId, search, fromDate: from, toDate: to,
          limit: AUDIT_SCAN_LIMIT, offset: 0, sort: 'newest',
        });
        const filtered = scan.items.filter((inquiry) => inquiry.emailStatus === emailStatus);
        total = filtered.length;
        items = filtered.slice(offset, offset + pageSize);
        filteredWithinWindow = true;
      } else {
        const result = listInquiries(db, {
          status, spaceId, search, fromDate: from, toDate: to,
          limit: pageSize, offset, sort: 'newest',
        });
        total = result.total;
        items = result.items;
      }
    }

    const rawFilters = {
      q: search ?? '', status: status ?? '', space: q(ctx.query, 'space') ?? '',
      emailStatus: emailStatus ?? '', from: from ?? '', to: to ?? '',
    };

    ctx.html(renderInquiryListPage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      inquiries: items,
      stats: inquiryStats(db),
      spaces: bookingFilterOptions(db).spaces,
      filters: {
        q: search, status, space: q(ctx.query, 'space') ?? '', emailStatus, from, to,
        query: compactQuery(rawFilters, ['page']),
      },
      page,
      pageSize,
      total,
      filteredWithinWindow,
    }));
  });

  router.get('/admin/inquiries/:id', async (ctx) => {
    const actor = checkAuth(ctx, deps);
    const id = parseId(ctx.params.id);
    const inquiry = id === null ? null : getInquiry(db, id);
    if (!inquiry) throw notFound('Inquiry not found.');

    ctx.html(renderInquiryDetailPage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      inquiry,
      availability: availabilitySnapshot(db, inquiry),
      timeline: listAudit(db, { entityType: 'inquiry', entityId: id, limit: 50 }),
      statuses: Object.values(INQUIRY_STATUS),
    }));
  });

  router.post('/admin/inquiries/:id/status', async (ctx) => {
    const actor = checkAuth(ctx, deps);
    await ctx.readBody();
    checkCsrf(ctx, deps);

    const id = parseId(ctx.params.id);
    const inquiry = id === null ? null : getInquiry(db, id);
    if (!inquiry) throw notFound('Inquiry not found.');

    const status = oneOf(ctx.body.status, Object.values(INQUIRY_STATUS), { field: 'status' });
    const target = `/admin/inquiries/${id}`;

    // The service does not guard this transition, so the route refuses it
    // rather than letting an inquiry claim a conversion that never happened.
    if (status === INQUIRY_STATUS.CONVERTED && !inquiry.convertedReservationId) {
      flashThenRedirect(ctx, deps, target, {
        kind: 'error',
        message: `Inquiry ${inquiry.reference} cannot be marked “${INQUIRY_STATUS.CONVERTED}” yet: `
          + 'no reservation is linked to it. Create the reservation from this inquiry first, then link it.',
      });
      return;
    }

    const internalNotes = typeof ctx.body.internal_notes === 'string'
      ? ctx.body.internal_notes
      : undefined;

    try {
      const updated = updateInquiryStatus(db, { actor, inquiryId: id, status, internalNotes });
      const changed = updated.status !== inquiry.status;
      flashThenRedirect(ctx, deps, target, {
        kind: 'success',
        message: changed
          ? `${updated.reference} moved from ${inquiry.status} to ${updated.status}.`
          : `Notes on ${updated.reference} saved. The status is unchanged (${updated.status}).`,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flashThenRedirect(ctx, deps, target, {
        kind: 'error',
        message: error.message,
        problems: problemsFrom(error),
      });
    }
  });

  /* ---------------------------------------------------------- maintenance */

  router.get('/admin/maintenance', async (ctx) => {
    const actor = checkAuth(ctx, deps);

    const spaceResult = resolveSpaceFilter(db, q(ctx.query, 'space'));
    const from = optionalDate(q(ctx.query, 'from'), 'from');
    const to = optionalDate(q(ctx.query, 'to'), 'to');
    const fromAt = from ? businessLocalToEpoch(from, '00:00') : null;
    const toAt = to ? businessLocalToEpoch(to, '00:00') + MS.DAY : null;

    const blocks = spaceResult.unresolved
      ? []
      : listMaintenanceBlocks(db, {
        spaceId: spaceResult.spaceId, fromAt, toAt, limit: MAINTENANCE_LIST_LIMIT,
      });
    const spaces = listSpaces(db, { limit: 200 }).items;

    ctx.html(renderMaintenancePage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      blocks,
      spaces,
      filters: {
        spaceId: spaceResult.spaceId,
        from: from ?? '',
        to: to ?? '',
      },
      canCreate: !maintenanceCreateOwned && !spaceResult.unresolved,
      canCancel: !maintenanceCancelOwned,
    }));
  });

  if (!maintenanceCreateOwned) {
    router.post('/admin/maintenance', async (ctx) => {
      const actor = checkAuth(ctx, deps);
      await ctx.readBody();
      checkCsrf(ctx, deps);

      const spaceId = asInteger(ctx.body.space_id, { field: 'space_id', min: 1, required: true });
      const window = parseBookingWindow({
        date: ctx.body.date,
        start_time: ctx.body.start_time,
        end_time: ctx.body.end_time,
      });
      const reason = requiredString(ctx.body.reason, { field: 'reason', max: 500 });

      try {
        const created = createMaintenanceBlock(db, {
          actor,
          spaceId,
          startAt: window.startAt,
          endAt: window.endAt,
          reason,
        });
        flashThenRedirect(ctx, deps, '/admin/maintenance', {
          kind: 'success',
          message: `Blocked ${created.units.length} unit${created.units.length === 1 ? '' : 's'} `
            + `(${created.units.join(', ')}) for maintenance.`,
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        flashThenRedirect(ctx, deps, '/admin/maintenance', {
          kind: 'error',
          message: error.message,
          problems: problemsFrom(error),
        });
      }
    });
  }

  if (!maintenanceCancelOwned) {
    router.post('/admin/maintenance/:id/cancel', async (ctx) => {
      const actor = checkAuth(ctx, deps);
      await ctx.readBody();
      checkCsrf(ctx, deps);

      const id = parseId(ctx.params.id);
      if (id === null) throw notFound('Maintenance block not found.');
      const reason = asTrimmedString(ctx.body.reason, { field: 'reason', max: 500 });

      try {
        const { releasedOccupancyRows } = cancelMaintenanceBlock(db, {
          actor, maintenanceBlockId: id, reason: reason ?? null,
        });
        flashThenRedirect(ctx, deps, '/admin/maintenance', {
          kind: 'success',
          message: 'Maintenance block cancelled: '
            + `${releasedOccupancyRows} occupancy row${releasedOccupancyRows === 1 ? '' : 's'} released.`,
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        flashThenRedirect(ctx, deps, '/admin/maintenance', {
          kind: 'error',
          message: error.message,
          problems: problemsFrom(error),
        });
      }
    });
  }

  /* --------------------------------------------------------- activity log */

  router.get('/admin/audit', async (ctx) => {
    const actor = checkAuth(ctx, deps);

    const entityType = textOrNull(q(ctx.query, 'entityType'));
    const actionFilter = textOrNull(q(ctx.query, 'action'));
    const actorFilter = textOrNull(q(ctx.query, 'actor'));
    const { page, pageSize, offset } = asPagination({
      page: q(ctx.query, 'page'),
      pageSize: q(ctx.query, 'pageSize') ?? LIMITS.defaultPageSize,
    });

    // `listAudit` can filter on entity/actor and page, but exposes no total and
    // no action filter, so the newest window is read once and both the action
    // filter and the paging are applied to that window. `windowLimited` tells
    // the page when the window was full, so it never implies completeness.
    const windowEntries = listAudit(db, {
      entityType,
      actorAdminUserId: actorFilter && /^\d+$/.test(actorFilter) ? Number(actorFilter) : null,
      limit: AUDIT_SCAN_LIMIT,
      offset: 0,
    });

    const needle = actionFilter ? actionFilter.toLowerCase() : null;
    const actorNeedle = actorFilter && !/^\d+$/.test(actorFilter) ? actorFilter.toLowerCase() : null;
    const filtered = windowEntries.filter((entry) => {
      if (needle && !entry.action.toLowerCase().includes(needle)) return false;
      if (actorNeedle && !String(entry.actorLabel ?? '').toLowerCase().includes(actorNeedle)) return false;
      return true;
    });
    const total = filtered.length;

    ctx.html(renderAuditPage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      entries: filtered.slice(offset, offset + pageSize),
      actors: listAdminUsers(db, { includeInactive: true }),
      filters: {
        entityType, action: actionFilter, actor: actorFilter,
        query: compactQuery({
          entityType: entityType ?? '', action: actionFilter ?? '', actor: actorFilter ?? '',
        }, ['page']),
      },
      page,
      pageSize,
      total,
      windowLimited: windowEntries.length >= AUDIT_SCAN_LIMIT,
    }));
  });

  /* ------------------------------------------------------------ admin JSON */

  router.get('/api/admin/dashboard/summary', async (ctx) => {
    checkAuth(ctx, deps);
    ctx.json(dashboardSummary(db, { now: Date.now() }));
  });

  router.get('/api/admin/inquiries/:id', async (ctx) => {
    checkAuth(ctx, deps);
    const id = parseId(ctx.params.id);
    const inquiry = id === null ? null : getInquiry(db, id);
    if (!inquiry) throw notFound('Inquiry not found.');
    ctx.json({
      inquiry: { ...inquiry, availability: availabilitySnapshot(db, inquiry) },
    });
  });
}

/* ------------------------------------------------------------------ helpers */

function checkAuth(ctx, deps) {
  const guard = typeof deps.requireAuth === 'function' ? deps.requireAuth : requireAuthFromSessions;
  return guard(ctx);
}

function checkCsrf(ctx, deps) {
  const guard = typeof deps.requireCsrf === 'function' ? deps.requireCsrf : requireCsrfFromSessions;
  return guard(ctx);
}

export function setFlashCookie(ctx, flash) {
  const payload = JSON.stringify({
    kind: ['success', 'error', 'warning'].includes(flash?.kind) ? flash.kind : 'success',
    message: String(flash?.message ?? '').slice(0, 500),
    problems: Array.isArray(flash?.problems) ? flash.problems.slice(0, 20).map(String) : undefined,
  });
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, payload, {
    maxAgeSeconds: 30,
    httpOnly: true,
    secure: ctx.secure ?? false,
    sameSite: 'Lax',
  }));
}

function flashThenRedirect(ctx, deps, location, flash) {
  if (typeof deps.setFlash === 'function') deps.setFlash(ctx, flash);
  else setFlashCookie(ctx, flash);
  redirect(ctx.res, location, 303);
  ctx.responded = true;
}

/** True when the router already has a handler for this method + pattern. */
function routeExists(router, method, pattern) {
  if (!router || !Array.isArray(router.routes)) return false;
  return router.routes.some((route) => route.method === method && route.pattern === pattern);
}

function parseId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function optionalOneOf(value, allowed, field) {
  const text = textOrNull(value);
  return text === null ? null : oneOf(text, allowed, { field });
}

function optionalDate(value, field) {
  const text = textOrNull(value);
  return text === null ? null : asDateKey(text, { field });
}

/** Resolve a `?space=` filter that may be an id or a space code. */
function resolveSpaceFilter(db, value) {
  const text = textOrNull(value);
  if (text === null) return { spaceId: null, unresolved: false };
  if (/^\d+$/.test(text)) return { spaceId: Number(text), unresolved: false };
  const space = getSpaceByCode(db, text);
  if (!space) return { spaceId: null, unresolved: true };
  return { spaceId: space.id, unresolved: false };
}

function groupByBusinessDay(reservations) {
  const groups = [];
  let current = null;
  for (const reservation of reservations) {
    const key = businessDateKey(reservation.startAt);
    if (!current || current.key !== key) {
      current = { key, startAt: reservation.startAt, items: [] };
      groups.push(current);
    }
    current.items.push(reservation);
  }
  return groups;
}

function isUndelivered(inquiry) {
  return inquiry.emailStatus === INQUIRY_EMAIL_STATUS.FAILED
    || inquiry.emailStatus === INQUIRY_EMAIL_STATUS.NOT_CONFIGURED;
}

/**
 * Read-only availability preview for an inquiry window. `hydrateInquiry` always
 * reports `availability: null`, so staff reads compute the snapshot here with
 * the same service `submitInquiry` uses.
 */
function availabilitySnapshot(db, inquiry) {
  if (!inquiry || !inquiry.spaceId) return null;
  const deskCount = inquiry.category === SPACE_CATEGORY.COWORKING
    ? Math.max(1, Number(inquiry.deskQuantity ?? 1) || 1)
    : 1;
  try {
    const availability = getSpaceAvailability(db, {
      spaceId: inquiry.spaceId,
      startAt: inquiry.startAt,
      endAt: inquiry.endAt,
      deskCount,
      includeConflicts: false,
    });
    return {
      isAvailable: availability.isAvailable,
      freeUnits: availability.freeUnits,
      totalUnits: availability.totalUnits,
      requestedUnits: availability.requestedUnits,
      label: availabilityLabel(availability),
      checkedAt: availability.checkedAt,
      provisional: true,
    };
  } catch {
    return null;
  }
}

/** Turn conflict detail into flash bullet points. */
function problemsFrom(error) {
  const details = error?.details;
  if (!details) return null;
  if (Array.isArray(details.problems) && details.problems.length) return details.problems;
  if (Array.isArray(details.conflicts) && details.conflicts.length) {
    return details.conflicts.slice(0, 10).map((conflict) => {
      const label = conflict.label
        ?? `${conflict.source ?? 'occupancy'} on ${conflict.unitCode ?? `unit ${conflict.resourceUnitId}`}`;
      const who = conflict.customerName ?? conflict.maintenanceReason ?? null;
      return who ? `${label} — ${who}` : label;
    });
  }
  return null;
}

/** Query string carried through pagination links (blank values dropped). */
function compactQuery(values, drop = []) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (drop.includes(key)) continue;
    const text = textOrNull(value);
    if (text !== null) out[key] = text;
  }
  return out;
}
