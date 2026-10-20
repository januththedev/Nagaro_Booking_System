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

  router.post('/api/public/booking-requests/:reference/payment', async ctx => { protect(ctx); ctx.json({ ok: true, checkout: createPayHereCheckout(db, { reference: ctx.params.reference, token: token(ctx), config: config.payHere }) }); });

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
      fixedCents: first(body.fixed_cents),
      percentageBps: first(body.percentage_bps),
      paymentWindowMinutes: first(body.payment_window_minutes),
    });
    redirect(ctx.res, '/admin/booking-requests');
    ctx.responded = true;
  });

  router.get('/admin/booking-requests', async ctx => {
    const actor = requireAuth(ctx);
    const items = listBookingRequests(db, { status: q(ctx.query, 'status'), limit: 200 });
    const policy = getBookingFeePolicy(db);
    const feeRows = items.map(item => {
      const payment = item.payment;
      return html`<tr>
        <td><strong>${item.reference}</strong><br><small>${new Date(item.startAt).toLocaleString('en-LK', { timeZone: 'Asia/Colombo' })} – ${new Date(item.endAt).toLocaleTimeString('en-LK', { timeZone: 'Asia/Colombo' })}</small></td>
        <td>${item.spaceName}<br><small>${item.unitCount} unit(s) · ${item.attendees ?? '—'} attending</small></td>
        <td>${item.customer.fullName}<br><small>${item.customer.email}</small></td>
        <td><small>Total ${lkr(item.venueTotalCents)}</small><br><small>Fee ${payment ? lkr(payment.bookingFeeCents) : '—'}</small><br><small>Balance ${payment ? lkr(payment.remainingBalanceCents) : '—'}</small></td>
        <td><span class="status-badge">${item.paymentStatus}</span>${payment?.latestAttempt ? html`<br><small>${payment.latestAttempt.orderId} · ${payment.latestAttempt.status}</small>${payment.latestAttempt.paymentId ? html`<br><small>PayHere ${payment.latestAttempt.paymentId}</small>` : ''}` : ''}</td>
        <td><span class="status-badge">${item.status}</span>${item.holdExpiresAt ? html`<br><small>Hold until ${new Date(item.holdExpiresAt).toLocaleTimeString('en-LK', { timeZone: 'Asia/Colombo' })}</small>` : ''}${item.rejectionReason ? html`<br><small>${item.rejectionReason}</small>` : ''}</td>
        <td>${item.status === 'REQUESTED' ? html`
          <form method="post" action="/admin/booking-requests/${item.reference}/approve" class="cluster"><input type="hidden" name="_csrf" value="${ctx.csrfToken}"><button class="button button--primary">Approve</button></form>
          <form method="post" action="/admin/booking-requests/${item.reference}/reject" class="stack"><input type="hidden" name="_csrf" value="${ctx.csrfToken}"><label>Reason <input name="reason" required maxlength="1000"></label><button class="button button--danger">Reject</button></form>`
        : item.paymentStatus === 'REVIEW_REQUIRED' ? html`
          <form method="post" action="/admin/booking-requests/${item.reference}/resolve-payment" class="stack"><input type="hidden" name="_csrf" value="${ctx.csrfToken}">
            <label>Outcome <select name="outcome"><option value="REFUND_RECORDED">Refund recorded</option><option value="PAYMENT_KEPT">Payment kept</option></select></label>
            <label>Note <input name="note" required maxlength="1000"></label>
            <button class="button button--primary">Resolve</button></form>`
        : '—'}</td>
      </tr>`;
    });
    const body = html`<section class="container">
      <div class="page-header"><div>
        <p class="eyebrow">Approval queue</p>
        <h1 class="page-title">Booking requests</h1>
        <p class="hint">Approve only after reviewing the schedule. Approval creates a database-enforced temporary hold and a payment obligation. Nothing is confirmed until the booking fee, when configured, has been verified by PayHere.</p>
      </div></div>

      ${actor.role === 'ADMIN' ? html`<form method="post" action="/admin/booking-requests/fee-policy" class="stack" style="border:1px solid var(--rule);padding:1rem;margin-bottom:1.5rem">
        <input type="hidden" name="_csrf" value="${ctx.csrfToken}">
        <h2 class="page-title" style="font-size:1.1rem;margin:0">Booking fee policy</h2>
        <p class="hint">Disabled by default. Set a fee only when the business has decided one. The amount is snapshotted on every approval.</p>
        <div class="cluster">
          <label>Mode <select name="mode">
            <option value="DISABLED" ${policy?.mode === 'DISABLED' ? 'selected' : ''}>Disabled (no fee)</option>
            <option value="FIXED" ${policy?.mode === 'FIXED' ? 'selected' : ''}>Fixed amount (LKR)</option>
            <option value="PERCENTAGE" ${policy?.mode === 'PERCENTAGE' ? 'selected' : ''}>Percentage of venue total</option>
          </select></label>
          <label>Fixed fee (LKR cents) <input name="fixed_cents" type="number" min="0" value="${policy?.fixedCents ?? 0}"></label>
          <label>Percentage (basis points) <input name="percentage_bps" type="number" min="0" max="10000" value="${policy?.percentageBps ?? 0}"></label>
          <label>Payment window (minutes) <input name="payment_window_minutes" type="number" min="5" max="10080" value="${policy?.paymentWindowMinutes ?? 120}"></label>
          <button class="button button--primary">Save fee policy</button>
        </div>
      </form>` : ''}

      <div class="table-wrap"><table>
        <thead><tr><th>Request</th><th>Space</th><th>Customer</th><th>Amounts</th><th>Payment</th><th>State</th><th>Decision</th></tr></thead>
        <tbody>${feeRows.length ? feeRows : html`<tr><td colspan="7">No booking requests yet.</td></tr>`}</tbody>
      </table></div>
    </section>`;
    ctx.html(adminShell({ title: 'Booking requests', actor, csrfToken: ctx.csrfToken, flash: ctx.flash, activePath: '/admin/booking-requests', body }));
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
