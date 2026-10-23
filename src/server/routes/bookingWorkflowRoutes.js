import { clientIp, q } from '../http/request.js';
import { redirect } from '../http/response.js';
import { parseBookingWindow } from '../domain/validation.js';
import { enforce, ipBucket } from '../security/rateLimit.js';
import { requireAuth, requireCsrf } from '../security/sessions.js';
import {
  approveBookingRequest, cancelBookingRequest, createBookingRequest, createPayHereCheckout,
  getBookingFeePolicy, getBookingRequest, listBookingRequests, processPayHereNotification,
  rejectBookingRequest, resolvePaymentException, updateBookingFeePolicy,
} from '../services/bookingRequestService.js';
import { adminShell } from '../../web/views/layout.js';
import { renderBookingRequestsPage } from '../../web/views/admin/bookingRequestViews.js';
import { html } from '../../web/lib/html.js';
import { chatWithVenueAssistant, consumeAssistantDraft, createAssistantDraft } from '../services/assistantService.js';

function first(value) { return Array.isArray(value) ? value[0] : value; }
function token(ctx, body = null) {
  const auth = String(ctx.req.headers.authorization ?? '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(first(body?.token ?? ctx.query.token) ?? '');
}
function mapInput(db, body) {
  const code = String(first(body.spaceCode ?? body.space_code ?? body.space) ?? '').trim();
  const space = db.prepare("SELECT * FROM space WHERE code=? COLLATE NOCASE AND status='PUBLISHED'").get(code);
  const window = parseBookingWindow({ start_at: first(body.startAt ?? body.start_at), end_at: first(body.endAt ?? body.end_at), date: first(body.date), start_time: first(body.startTime ?? body.start_time), end_time: first(body.endTime ?? body.end_time) });
  return { spaceId: space?.id, startAt: window.startAt, endAt: window.endAt, unitCount: first(body.unitCount ?? body.unit_count ?? body.desks), attendees: first(body.attendees), billingUnit: first(body.billingUnit ?? body.billing_unit), purpose: first(body.purpose), idempotencyKey: first(body.formToken ?? body.form_token ?? body.idempotencyKey), customer: { fullName: first(body.fullName ?? body.full_name ?? body.name), email: first(body.email), phone: first(body.phone), organization: first(body.organization) } };
}
function protect(ctx) { ctx.setHeader('Cache-Control', 'no-store, private'); ctx.setHeader('Referrer-Policy', 'no-referrer'); }
function lkr(cents) { return `LKR ${(Number(cents ?? 0) / 100).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

export function registerBookingWorkflowRoutes(router, deps = {}) {
  const { db, config } = deps;

  /* ------------------------------------------------- public request flow */

  router.post('/api/public/booking-requests', async ctx => {
    const body = await ctx.readBody();
    enforce(db, ipBucket('booking-request', clientIp(ctx.req)), { limit: 8, windowMs: 15 * 60_000 });
    const result = createBookingRequest(db, mapInput(db, body));
    protect(ctx); ctx.json({ ok: true, ...result }, result.idempotent ? 200 : 201);
  });

  // No-JavaScript fallback for the unified request form: same service, same
  // rules, then the visitor lands on their private status page.
  router.post('/spaces/:code/book', async ctx => {
    const body = await ctx.readBody();
    const code = String(ctx.params.code ?? '').trim();
    try {
      enforce(db, ipBucket('booking-request', clientIp(ctx.req)), { limit: 8, windowMs: 15 * 60_000 });
      const result = createBookingRequest(db, mapInput(db, { ...body, spaceCode: code }));
      redirect(ctx.res, `/book/manage?ref=${encodeURIComponent(result.request.reference)}&token=${encodeURIComponent(result.manageToken)}`, 303);
    } catch (error) {
      redirect(ctx.res, `/spaces/${encodeURIComponent(code.toUpperCase())}/book?failed=${encodeURIComponent(String(error?.message ?? 'Please check the details and try again.').slice(0, 300))}`, 303);
    }
    ctx.responded = true;
  });

  router.get('/api/public/booking-requests/:reference', async ctx => { protect(ctx); ctx.json({ ok: true, request: getBookingRequest(db, { reference: ctx.params.reference, token: token(ctx) }) }); });

  router.post('/api/public/booking-requests/:reference/cancel', async ctx => {
    const body = await ctx.readBody();
    protect(ctx);
    ctx.json({ ok: true, request: cancelBookingRequest(db, { reference: ctx.params.reference, token: token(ctx, body), reason: body.reason ?? null }) });
  });

  router.post('/api/public/booking-requests/:reference/payment', async ctx => {
    const body = await ctx.readBody();
    protect(ctx);
    ctx.json({ ok: true, checkout: createPayHereCheckout(db, {
      reference: ctx.params.reference,
      token: token(ctx, body),
      config: config.payHere,
      advanceCents: first(body.advanceCents ?? body.advance_cents) ?? 0,
    }) });
  });

  // PayHere server-to-server notification: form-encoded, signature verified
  // inside the service. The browser return URL is never treated as proof.
  router.post('/api/public/payments/payhere/notify', async ctx => {
    const body = await ctx.readBody();
    const result = processPayHereNotification(db, body, config.payHere);
    ctx.text(result.accepted ? 'OK' : 'INVALID', result.accepted ? 200 : 400);
  });

  /* --------------------------------------------------------- AI assistant */

  router.post('/api/public/assistant/chat', async ctx => {
    const body = await ctx.readBody();
    enforce(db, ipBucket('ai-chat', clientIp(ctx.req)), { limit: 20, windowMs: 15 * 60_000 });
    ctx.json({ ok: true, ...await chatWithVenueAssistant(db, { messages: body.messages, config: config.openRouter }) });
  });
  router.post('/api/public/assistant/drafts', async ctx => {
    const body = await ctx.readBody();
    enforce(db, ipBucket('ai-draft', clientIp(ctx.req)), { limit: 8, windowMs: 15 * 60_000 });
    protect(ctx); ctx.json({ ok: true, draft: createAssistantDraft(db, body) }, 201);
  });
  router.post('/api/public/assistant/drafts/resolve', async ctx => {
    const body = await ctx.readBody();
    protect(ctx); ctx.json({ ok: true, draft: consumeAssistantDraft(db, body.token) });
  });

  /* ------------------------------------------------------- staff console */

  router.post('/admin/booking-requests/fee-policy', async ctx => {
    const actor = requireAuth(ctx);
    await ctx.readBody();
    requireCsrf(ctx);
    const body = ctx.body ?? {};
    updateBookingFeePolicy(db, {
      actor,
      mode: first(body.mode),
      fixedCents: body.fixed_lkr !== undefined ? Math.round(Number(first(body.fixed_lkr)) * 100) : first(body.fixed_cents),
      percentageBps: body.percentage !== undefined ? Math.round(Number(first(body.percentage)) * 100) : first(body.percentage_bps),
      paymentWindowMinutes: first(body.payment_window_minutes),
    });
    redirect(ctx.res, '/admin/booking-requests');
    ctx.responded = true;
  });

  router.get('/admin/booking-requests', async ctx => {
    const actor = requireAuth(ctx);
    const items = listBookingRequests(db, { limit: 200 });
    const policy = getBookingFeePolicy(db);
    ctx.html(renderBookingRequestsPage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      items,
      policy,
      filters: { status: q(ctx.query, 'status') || 'open', q: q(ctx.query, 'q') || '' },
    }));
  });

  router.post('/admin/booking-requests/:reference/approve', async ctx => { const actor = requireAuth(ctx); await ctx.readBody(); requireCsrf(ctx); const row = db.prepare('SELECT id FROM booking_request WHERE reference=?').get(ctx.params.reference); approveBookingRequest(db, { actor, requestId: row?.id }); redirect(ctx.res, '/admin/booking-requests'); ctx.responded = true; });

  router.post('/admin/booking-requests/:reference/reject', async ctx => { const actor = requireAuth(ctx); await ctx.readBody(); requireCsrf(ctx); const row = db.prepare('SELECT id FROM booking_request WHERE reference=?').get(ctx.params.reference); rejectBookingRequest(db, { actor, requestId: row?.id, reason: first(ctx.body.reason) }); redirect(ctx.res, '/admin/booking-requests'); ctx.responded = true; });

  router.post('/admin/booking-requests/:reference/resolve-payment', async ctx => {
    const actor = requireAuth(ctx);
    await ctx.readBody();
    requireCsrf(ctx);
    const row = db.prepare('SELECT id FROM booking_request WHERE reference=?').get(ctx.params.reference);
    resolvePaymentException(db, { actor, requestId: row?.id, outcome: first(ctx.body.outcome), note: first(ctx.body.note) });
    redirect(ctx.res, '/admin/booking-requests');
    ctx.responded = true;
  });
}
