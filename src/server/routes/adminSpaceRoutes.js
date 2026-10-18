/**
 * Administrative catalogue routes: list, create, edit, publish, archive and
 * the photograph management UI.
 *
 * Follows the app-wide conventions:
 *   - `requireAuth` first on every route, then `readBody()` and `requireCsrf`
 *     on state-changing routes (the CSRF token arrives as a body field, so the
 *     body must be parsed before it can be verified);
 *   - every mutation is rate limited per actor;
 *   - successes and expected failures set a one-shot flash message and answer
 *     with a 303 redirect to a `/admin/spaces...` page;
 *   - only `AppError`s with a field map (`details.name = '...'`) or a problem
 *     list (`details.problems = [...]`) are handled locally, by re-rendering
 *     the form with HTTP 422 and the submitted values preserved. Any other
 *     error (conflict, not found, ...) is rethrown so `app.js`'s error
 *     boundary flashes the message and bounces the POST back to its referer;
 *   - no business rules live here: every check is delegated to spaceService,
 *     `parseSpacePayload` and `ALLOWED_PRICING_UNITS`.
 *
 * Uploads are NOT handled here: `POST /admin/spaces/:id/images` (multipart) is
 * owned by `adminUploadRoutes.js`. This module renders the form that posts to
 * it and implements the small per-photograph actions (cover, reorder, delete).
 */
import {
  AMENITY_CATALOG, PRICING_UNIT, SPACE_CATEGORY, SPACE_STATUS,
} from '../domain/constants.js';
import { AppError, notFound } from '../domain/errors.js';
import { asMoneyCents, asPagination, LIMITS } from '../domain/validation.js';
import { isSecureRequest, q } from '../http/request.js';
import { appendCookie, redirect, serializeCookie } from '../http/response.js';
import { FLASH_COOKIE, requireAuth, requireCsrf } from '../security/sessions.js';
import { enforceAdminMutationLimit } from '../security/rateLimit.js';
import { removeStoredImage } from '../security/uploads.js';
import {
  archiveSpace, createSpace, deleteImage, getSpace, listImages, listSpaces, publishSpace,
  publishabilityIssues, reorderImages, restoreSpace, setCoverImage, unpublishSpace, updateSpace,
} from '../services/spaceService.js';
import {
  ATTRIBUTE_FIELDS, ATTRIBUTE_PANEL_FOR_CATEGORY, renderSpaceDetailPage, renderSpaceFormPage,
  renderSpaceListPage,
} from '../../web/views/admin/spaceViews.js';

const PRICING_UNITS = Object.freeze(Object.values(PRICING_UNIT));
const LIST_SORTS = Object.freeze(['name', 'newest', 'updated', 'capacity']);
const LIST_DEFAULT_STATUS = 'active';
const FLASH_MAX_AGE_SECONDS = 30;

/* ---------------------------------------------------------------- lifecycle */

export function registerAdminSpaceRoutes(router, deps = {}) {
  const db = deps.db;
  const guards = {
    auth: typeof deps.requireAuth === 'function' ? deps.requireAuth : requireAuth,
    csrf: typeof deps.requireCsrf === 'function' ? deps.requireCsrf : requireCsrf,
  };

  /* --------------------------------------------------------------- list */
  router.get('/admin/spaces', async (ctx) => {
    guards.auth(ctx);
    const filters = listFilters(ctx.query);
    const { total, items } = listSpaces(db, listOptions(filters));
    ctx.html(renderSpaceListPage({
      actor: ctx.actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      spaces: items,
      total,
      filters,
      page: filters.page,
      pageSize: filters.pageSize,
    }));
  });

  /* ------------------------------------------------------------- create */
  router.get('/admin/spaces/new', async (ctx) => {
    guards.auth(ctx);
    ctx.html(renderSpaceFormPage({
      actor: ctx.actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      mode: 'create',
      values: defaultFormValues(),
    }));
  });

  router.post('/admin/spaces', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    const { rates, errors: rateErrors } = ratesFromBody(ctx.body);
    if (Object.keys(rateErrors).length > 0) {
      failForm(ctx, deps, {
        mode: 'create',
        space: null,
        body: ctx.body,
        details: rateErrors,
        message: 'Please correct the rate amounts.',
      });
      return;
    }

    try {
      const space = createSpace(db, {
        actor: ctx.actor,
        payload: { ...spacePayloadFromBody(ctx.body), rates },
      });
      flash(ctx, deps, {
        kind: 'success',
        message: `Space ${space.code} created as a draft. Add a photograph before publishing.`,
      });
      redirectTo(ctx, `/admin/spaces/${space.id}`);
    } catch (error) {
      if (!handledFormError(error)) throw error;
      failForm(ctx, deps, {
        mode: 'create',
        space: null,
        body: ctx.body,
        details: error.details,
        message: error.message,
      });
    }
  });

  /* ------------------------------------------------------------- detail */
  router.get('/admin/spaces/:id', async (ctx) => {
    guards.auth(ctx);
    const space = requireSpace(db, ctx.params.id);
    ctx.html(renderSpaceDetailPage({
      actor: ctx.actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      space,
      images: listImages(db, space.id),
      issues: publishabilityIssues(db, space.id),
    }));
  });

  /* --------------------------------------------------------------- edit */
  router.get('/admin/spaces/:id/edit', async (ctx) => {
    guards.auth(ctx);
    const space = requireSpace(db, ctx.params.id);
    ctx.html(renderSpaceFormPage({
      actor: ctx.actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      mode: 'edit',
      space,
      values: formValuesFromSpace(space),
    }));
  });

  router.post('/admin/spaces/:id', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });

    const space = requireSpace(db, ctx.params.id);
    const { rates, errors: rateErrors } = ratesFromBody(ctx.body);
    if (Object.keys(rateErrors).length > 0) {
      failForm(ctx, deps, {
        mode: 'edit',
        space,
        body: ctx.body,
        details: rateErrors,
        message: 'Please correct the rate amounts.',
      });
      return;
    }

    try {
      const updated = updateSpace(db, {
        actor: ctx.actor,
        spaceId: space.id,
        payload: { ...spacePayloadFromBody(ctx.body), rates },
      });
      flash(ctx, deps, { kind: 'success', message: `Space ${updated.code} updated.` });
      redirectTo(ctx, `/admin/spaces/${space.id}`);
    } catch (error) {
      if (!handledFormError(error)) throw error;
      failForm(ctx, deps, {
        mode: 'edit',
        space,
        body: ctx.body,
        details: error.details,
        message: error.message,
      });
    }
  });

  /* ---------------------------------------------------- publish lifecycle */
  router.post('/admin/spaces/:id/publish', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });
    const space = requireSpace(db, ctx.params.id);

    try {
      const published = publishSpace(db, { actor: ctx.actor, spaceId: space.id });
      flash(ctx, deps, {
        kind: 'success',
        message: `Space ${published.code} is now published and visible to visitors.`,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // The publication gate reports every unmet requirement as a problem list.
      flash(ctx, deps, {
        kind: 'error',
        message: error.message,
        problems: Array.isArray(error.details?.problems) ? error.details.problems : null,
      });
    }
    redirectTo(ctx, `/admin/spaces/${space.id}`);
  });

  router.post('/admin/spaces/:id/unpublish', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });
    const space = requireSpace(db, ctx.params.id);

    try {
      const updated = unpublishSpace(db, { actor: ctx.actor, spaceId: space.id });
      flash(ctx, deps, {
        kind: 'success',
        message: `Space ${updated.code} is back to draft and hidden from the public site.`,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flash(ctx, deps, { kind: 'error', message: error.message });
    }
    redirectTo(ctx, `/admin/spaces/${space.id}`);
  });

  router.post('/admin/spaces/:id/archive', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });
    const space = requireSpace(db, ctx.params.id);
    const reason = rawText(ctx.body.reason).trim();

    try {
      const result = archiveSpace(db, {
        actor: ctx.actor,
        spaceId: space.id,
        reason: reason === '' ? null : reason,
      });
      if (result.upcomingOccupancy > 0) {
        flash(ctx, deps, {
          kind: 'warning',
          message: `Space ${result.space.code} archived, but ${result.upcomingOccupancy} upcoming occupancy row${result.upcomingOccupancy === 1 ? '' : 's'} remain. Existing reservations are untouched — review the calendar and contact the customer${result.upcomingOccupancy === 1 ? '' : 's'} if the space must be freed.`,
        });
      } else {
        flash(ctx, deps, {
          kind: 'success',
          message: `Space ${result.space.code} archived. It no longer accepts new reservations.`,
        });
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flash(ctx, deps, { kind: 'error', message: error.message });
    }
    redirectTo(ctx, `/admin/spaces/${space.id}`);
  });

  router.post('/admin/spaces/:id/restore', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });
    const space = requireSpace(db, ctx.params.id);

    try {
      const restored = restoreSpace(db, { actor: ctx.actor, spaceId: space.id });
      flash(ctx, deps, {
        kind: 'success',
        message: `Space ${restored.code} restored to draft. Publish it when it is ready.`,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flash(ctx, deps, { kind: 'error', message: error.message });
    }
    redirectTo(ctx, `/admin/spaces/${space.id}`);
  });

  /* ------------------------------------------------------------- images */
  router.post('/admin/spaces/:id/images/:imageId/cover', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });
    const space = requireSpace(db, ctx.params.id);
    const imageId = parseId(ctx.params.imageId);

    try {
      if (imageId === null) throw notFound('Photograph not found.');
      setCoverImage(db, { actor: ctx.actor, spaceId: space.id, imageId });
      flash(ctx, deps, { kind: 'success', message: 'Cover photograph updated.' });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flash(ctx, deps, { kind: 'error', message: error.message });
    }
    redirectTo(ctx, `/admin/spaces/${space.id}`);
  });

  router.post('/admin/spaces/:id/images/:imageId/delete', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });
    const space = requireSpace(db, ctx.params.id);
    const imageId = parseId(ctx.params.imageId);

    try {
      if (imageId === null) throw notFound('Photograph not found.');
      const { removedStoredName } = deleteImage(db, { actor: ctx.actor, spaceId: space.id, imageId });
      // The database row is already gone; removing the file is best effort and
      // never turns a completed deletion into an error for the administrator.
      removeStoredImage(removedStoredName);
      flash(ctx, deps, { kind: 'success', message: 'Photograph deleted.' });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flash(ctx, deps, { kind: 'error', message: error.message });
    }
    redirectTo(ctx, `/admin/spaces/${space.id}`);
  });

  router.post('/admin/spaces/:id/images/reorder', async (ctx) => {
    guards.auth(ctx);
    await ctx.readBody();
    guards.csrf(ctx);
    enforceAdminMutationLimit(db, { actorId: ctx.actor.id });
    const space = requireSpace(db, ctx.params.id);
    const orderedIds = parseOrderedIds(ctx.body);

    try {
      if (orderedIds.length === 0) {
        flash(ctx, deps, {
          kind: 'error',
          message: 'No photograph order was provided, so nothing was changed.',
        });
      } else {
        reorderImages(db, { actor: ctx.actor, spaceId: space.id, orderedIds });
        flash(ctx, deps, { kind: 'success', message: 'Photograph order updated.' });
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      flash(ctx, deps, { kind: 'error', message: error.message });
    }
    redirectTo(ctx, `/admin/spaces/${space.id}`);
  });
}

/* ---------------------------------------------------------------- guards */

/**
 * 303 redirect that marks the request answered.
 *
 * `Router.handle` sends a JSON `{ok:true}` fallback for handlers that left
 * `ctx.responded` false; writing the redirect directly without this flag makes
 * that fallback attempt a second response on an already-flushed socket.
 */
function redirectTo(ctx, location) {
  redirect(ctx.res, location, 303);
  ctx.responded = true;
}

function requireSpace(db, rawId) {
  const id = parseId(rawId);
  if (id === null) throw notFound('Space not found.');
  const space = getSpace(db, id);
  if (!space) throw notFound('Space not found.');
  return space;
}

function parseId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Only a validation failure that can be shown on the form is handled locally.
 * `details` is a field map (`{ name: 'Name is required.' }`) and may carry a
 * `problems` array instead.
 */
function handledFormError(error) {
  if (!(error instanceof AppError) || error.status !== 422) return false;
  const details = error.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  return Object.keys(details).length > 0;
}

function failForm(ctx, deps, { mode, space, body, details, message }) {
  ctx.html(renderSpaceFormPage({
    actor: ctx.actor,
    csrfToken: ctx.csrfToken,
    flash: null,
    mode,
    space,
    values: formValuesFromBody(body),
    details,
    errorMessage: message,
  }), 422);
}

/* ------------------------------------------------------------------ flash */

/**
 * Write the one-shot flash cookie. `deps.setFlash` is provided by `app.js`;
 * the local fallback mirrors the same cookie contract so this module can be
 * registered on a bare router (as the integration tests do).
 */
function flash(ctx, deps, { kind = 'success', message, problems = null }) {
  const payload = { kind, message };
  if (Array.isArray(problems) && problems.length > 0) payload.problems = problems.map(String);
  if (typeof deps.setFlash === 'function') {
    deps.setFlash(ctx, payload);
    return;
  }
  appendCookie(ctx.res, serializeCookie(FLASH_COOKIE, JSON.stringify(payload), {
    maxAgeSeconds: FLASH_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(ctx.req),
  }));
}

/* ------------------------------------------------------------------ input */

function rawText(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === null || first === undefined) return '';
  return String(first);
}

/** Blank optional text becomes `null` so clearing a field clears the column. */
function nullableText(value) {
  const text = rawText(value).trim();
  return text === '' ? null : text;
}

/** First value of a possibly repeated query parameter, or `''`. */
function queryText(query, key) {
  return rawText(q(query, key) ?? '');
}

function listFilters(query) {
  const statusRaw = queryText(query, 'status').trim() || LIST_DEFAULT_STATUS;
  const status = statusRaw === 'all'
    || statusRaw === LIST_DEFAULT_STATUS
    || Object.values(SPACE_STATUS).includes(statusRaw)
    ? statusRaw
    : LIST_DEFAULT_STATUS;

  const categoryRaw = queryText(query, 'category').trim();
  const category = Object.values(SPACE_CATEGORY).includes(categoryRaw) ? categoryRaw : '';

  const sortRaw = queryText(query, 'sort').trim();
  const sort = LIST_SORTS.includes(sortRaw) ? sortRaw : 'name';

  const search = queryText(query, 'q').trim().slice(0, LIMITS.maxQueryLength);
  const { page, pageSize, offset } = asPagination({
    page: digitsOnly(q(query, 'page')),
    pageSize: digitsOnly(q(query, 'pageSize')),
  });

  return { status, category, search, sort, page, pageSize, offset };
}

function listOptions(filters) {
  const options = {
    status: null,
    category: filters.category || null,
    search: filters.search || null,
    includeArchived: false,
    limit: filters.pageSize,
    offset: filters.offset,
    sort: filters.sort,
  };
  if (filters.status === 'all') options.includeArchived = true;
  else if (filters.status !== LIST_DEFAULT_STATUS) options.status = filters.status;
  return options;
}

function digitsOnly(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : undefined;
}

/**
 * Assemble the service payload from the form body.
 *
 * `parseSpacePayload` treats every present key as provided, so each field the
 * form renders is sent explicitly; the form is authoritative for the whole
 * record. Keys whose category does not apply are omitted rather than cleared:
 * `desk_count` is only sent for COWORKING, and attributes are read only from
 * the panel matching the submitted category.
 */
function spacePayloadFromBody(body) {
  const category = rawText(body.category).trim();
  const payload = {
    code: rawText(body.code),
    name: rawText(body.name),
    category,
    short_description: rawText(body.short_description),
    description: rawText(body.description),
    location: rawText(body.location),
    floor: nullableText(body.floor),
    capacity: rawText(body.capacity),
    currency: rawText(body.currency),
    pricing_unit: rawText(body.pricing_unit),
    min_duration_minutes: rawText(body.min_duration_minutes),
    max_duration_minutes: rawText(body.max_duration_minutes),
    buffer_minutes: rawText(body.buffer_minutes),
    open_time: rawText(body.open_time),
    close_time: rawText(body.close_time),
    contact_note: nullableText(body.contact_note),
    amenities: amenitiesFromBody(body),
    attributes: attributesFromBody(body, category),
  };
  if (category === SPACE_CATEGORY.COWORKING) payload.desk_count = rawText(body.desk_count);
  return payload;
}

/**
 * `rates_HOUR`, `rates_HALF_DAY`, ... -> `[{ unit, amount_cents }]`, the shape
 * `normaliseRates` reads (it also accepts the object form, but a list keeps
 * the "leave blank to remove" semantics exact). Amounts are validated per
 * field so an invalid figure is reported next to its own input.
 */
function ratesFromBody(body) {
  const rates = [];
  const errors = {};
  for (const unit of PRICING_UNITS) {
    const raw = rawText(body[`rates_${unit}`]).trim();
    if (raw === '') continue;
    try {
      const amountCents = asMoneyCents(raw, { field: `rates.${unit}` });
      if (amountCents !== null) rates.push({ unit, amount_cents: amountCents });
    } catch (error) {
      if (error instanceof AppError && typeof error.details?.field === 'string') {
        errors[error.details.field] = error.message;
      } else {
        throw error;
      }
    }
  }
  return { rates, errors };
}

function amenitiesFromBody(body) {
  const selected = body.amenities;
  const list = Array.isArray(selected) ? selected : (selected === undefined || selected === null || selected === '' ? [] : [selected]);
  const values = [
    ...list.map((value) => String(value).trim()),
    ...rawText(body.amenities_other).split(','),
  ].map((value) => value.trim()).filter((value) => value !== '');
  return [...new Set(values)];
}

/** Reads only the attribute panel of the submitted category. */
function attributesFromBody(body, category) {
  const panel = ATTRIBUTE_PANEL_FOR_CATEGORY[category];
  if (!panel) return {};
  const attributes = {};
  for (const field of ATTRIBUTE_FIELDS[panel] ?? []) {
    const submitted = body[`attributes_${panel}[${field.key}]`];
    if (field.type === 'checkbox') {
      if (submitted !== undefined) attributes[field.key] = true;
      continue;
    }
    const value = rawText(submitted).trim();
    if (value !== '') attributes[field.key] = value;
  }
  return attributes;
}

/* ------------------------------------------------------- form value shaping */

function emptyRates() {
  const rates = {};
  for (const unit of PRICING_UNITS) rates[unit] = '';
  return rates;
}

function emptyAttributes() {
  const attributes = {};
  for (const panel of Object.keys(ATTRIBUTE_FIELDS)) attributes[panel] = {};
  return attributes;
}

function defaultFormValues() {
  return {
    code: '',
    name: '',
    category: SPACE_CATEGORY.MEETING_ROOM,
    short_description: '',
    description: '',
    location: '',
    floor: '',
    capacity: '',
    currency: 'LKR',
    // DAY is allowed by every category, so a fresh form cannot be rejected for
    // a category/unit mismatch before the administrator has chosen.
    pricing_unit: PRICING_UNIT.DAY,
    min_duration_minutes: '60',
    max_duration_minutes: '',
    buffer_minutes: '0',
    open_time: '08:00',
    close_time: '18:00',
    contact_note: '',
    desk_count: '1',
    amenities: [],
    amenities_other: '',
    rates: emptyRates(),
    attributes: emptyAttributes(),
  };
}

function formValuesFromSpace(space) {
  const rates = emptyRates();
  for (const unit of PRICING_UNITS) {
    const cents = space.rates?.[unit];
    rates[unit] = cents === undefined || cents === null ? '' : (cents / 100).toFixed(2);
  }

  const attributes = emptyAttributes();
  const panel = ATTRIBUTE_PANEL_FOR_CATEGORY[space.category];
  if (panel) {
    for (const field of ATTRIBUTE_FIELDS[panel]) {
      const value = space.attributes?.[field.key];
      if (field.type === 'checkbox') {
        attributes[panel][field.key] = value === true || value === 1 || value === 'true';
      } else {
        attributes[panel][field.key] = value === undefined || value === null ? '' : String(value);
      }
    }
  }

  const amenities = Array.isArray(space.amenities) ? space.amenities : [];
  const otherAmenities = amenities.filter((amenity) => !AMENITY_CATALOG.includes(amenity));

  return {
    code: space.code,
    name: space.name,
    category: space.category,
    short_description: space.shortDescription ?? '',
    description: space.description ?? '',
    location: space.location ?? '',
    floor: space.floor ?? '',
    capacity: String(space.capacity),
    currency: space.currency ?? 'LKR',
    pricing_unit: space.pricingUnit,
    min_duration_minutes: String(space.minDurationMinutes),
    max_duration_minutes: space.maxDurationMinutes === null || space.maxDurationMinutes === undefined
      ? '' : String(space.maxDurationMinutes),
    buffer_minutes: String(space.bufferMinutes),
    open_time: space.openTime,
    close_time: space.closeTime,
    contact_note: space.contactNote ?? '',
    desk_count: space.category === SPACE_CATEGORY.COWORKING ? String(space.unitCount) : '1',
    amenities,
    amenities_other: otherAmenities.join(', '),
    rates,
    attributes,
  };
}

function formValuesFromBody(body) {
  const category = rawText(body.category).trim();
  const rates = emptyRates();
  for (const unit of PRICING_UNITS) rates[unit] = rawText(body[`rates_${unit}`]);

  const attributes = emptyAttributes();
  for (const [panel, fields] of Object.entries(ATTRIBUTE_FIELDS)) {
    for (const field of fields) {
      const submitted = body[`attributes_${panel}[${field.key}]`];
      attributes[panel][field.key] = field.type === 'checkbox'
        ? submitted !== undefined
        : rawText(submitted);
    }
  }

  return {
    code: rawText(body.code),
    name: rawText(body.name),
    category: category || SPACE_CATEGORY.MEETING_ROOM,
    short_description: rawText(body.short_description),
    description: rawText(body.description),
    location: rawText(body.location),
    floor: rawText(body.floor),
    capacity: rawText(body.capacity),
    currency: rawText(body.currency) || 'LKR',
    pricing_unit: rawText(body.pricing_unit),
    min_duration_minutes: rawText(body.min_duration_minutes),
    max_duration_minutes: rawText(body.max_duration_minutes),
    buffer_minutes: rawText(body.buffer_minutes),
    open_time: rawText(body.open_time),
    close_time: rawText(body.close_time),
    contact_note: rawText(body.contact_note),
    desk_count: rawText(body.desk_count),
    amenities: amenitiesFromBody(body),
    amenities_other: rawText(body.amenities_other),
    rates,
    attributes,
  };
}

/** Accepts repeated fields (`orderedIds=1&orderedIds=2`) or `1,2,3`. */
function parseOrderedIds(body) {
  const raw = body.orderedIds ?? body['orderedIds[]'] ?? body.ordered_ids ?? body.ids;
  const values = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === '' ? [] : [raw]);
  const ordered = [];
  for (const value of values) {
    for (const part of String(value).split(',')) {
      const id = parseId(part.trim());
      if (id !== null && !ordered.includes(id)) ordered.push(id);
    }
  }
  return ordered;
}
