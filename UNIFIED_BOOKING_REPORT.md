# Unified Booking, AI Assistant & PayHere — Delivery Report

**Repository** `januththedev/Nagaro_Booking_System` · **Branch** `main`
**Starting commit** `0abe881` ("Make the full stack Vercel deployable"; the brief's reference
`54f55c1` is its parent) · **Final commit** `43f084787e3e5bc5f024e6da5f2fe89d895f56ce`
(branch tip adds this line in a documentation-only follow-up).
**Date** 20 October 2026

---

## 1. What changed

| Area | Delivered |
|---|---|
| Public journey | One channel: landing → **Book a Space** → catalogue → venue → request form → staff approval → booking-fee payment → confirmed |
| Navigation | No public menu, no hamburger, no staff link. Header = brand mark + **Book a Space** + a discreet EN/සිං/தமிழ் switcher |
| Booking engine | New `booking_request` lifecycle with database-enforced temporary holds, immutable fee snapshots, PayHere checkout + verified callbacks, manual payment reconciliation |
| AI assistant | OpenRouter venue guide grounded in whitelisted tools; prepares editable, one-time booking drafts; can never book, charge or change state |
| Languages | Full public UI in English, සිංහල and தமிழ் (cookie-first locale, `Accept-Language` detection, BCP-47 formatting in Asia/Colombo) |
| Admin console | Approval queue with amounts/payment/hold state, fee policy configuration, rejection reasons, payment-exception reconciliation (admin console otherwise unchanged) |

## 2. Feature changes (by file group)

- `src/server/services/bookingRequestService.js` — request creation (idempotent, holds no
  inventory), approval with atomic allocation + hold claims, fee-policy snapshotting, PayHere
  checkout signing, callback verification and payment state machine, customer cancellation,
  fee-policy configuration, payment-exception resolution.
- `src/server/services/assistantService.js` — OpenRouter integration with three whitelisted
  tools, strict argument schemas, contact redaction, bounded tool budget, one bounded retry,
  and the hashed one-time booking-draft hand-off.
- `src/server/routes/bookingWorkflowRoutes.js` — public request/payment/assistant endpoints,
  PayHere notify endpoint, no-JavaScript request fallback, admin queue + fee policy + decisions.
- `src/server/routes/publicRoutes.js` — retirement of the direct-booking and concierge creation
  endpoints; legacy capability management preserved.
- `src/server/db/migrations/0005_booking_request_payments_ai.sql` (+ Postgres mirror
  `db/migrations-postgres/0002_…`) — requests, hold claims, fee policy, obligations, attempts,
  payment events, AI drafts.
- `apps/public-web/` — unified request form (`/spaces/[code]/book`) with no-JavaScript fallback,
  request/payment status page, assistant UI, language switcher, `lib/i18n.ts` dictionaries,
  and the reworded catalogue/venue/landing surfaces.

## 3. Removed / redirected public routes

| Route | Now |
|---|---|
| `GET/POST /book` | 308/303 → `/spaces` (immediate self-confirmation removed) |
| `GET/POST /booking-request` | 308/303 → `/spaces` (concierge channel removed) |
| `POST /api/public/bookings` | **410** — it bypassed approval and fees |
| `POST /api/public/inquiries` | **410** — replaced by booking requests |
| Kept for existing links | `/book/confirmed`, `/book/manage`, `/book/cancel`, `/booking-request/received`, `/booking-request/withdraw`, `GET /api/public/bookings/:ref`, `POST …/cancel` |

The orphaned `DirectBookingForm` and `ConciergeInquiryForm` components were deleted so the
retired channels cannot be resurrected.

## 4. Chatbot tools and allowed actions

| Tool | Arguments (validated) | Reads |
|---|---|---|
| `list_spaces` | `category` (enum), `min_capacity` (1–1000) | published spaces, public-safe projection |
| `get_space` | `code` | one published space |
| `check_availability` | `code`, `date`, `start_time`, `end_time`, `unit_count` | `getPublicAvailability` in Asia/Colombo |

Nothing else is callable. Unknown tools and malformed arguments are refused. Outgoing messages
are redacted of emails/phones. The assistant may **offer** a draft; it cannot create, confirm or
charge anything, cannot see admin or customer records, and cannot reach arbitrary URLs.

## 5. Booking draft and form prefill

1. The customer supplies details in conversation; the server extracts only schema-valid fields
   (ISO dates, `HH:MM` times, plausible email/phone, attendee counts).
2. The assistant offers **"Review booking details"** — never automatic.
3. On click, the client stores the draft server-side (`POST /api/public/assistant/drafts`): a
   32-byte token, SHA-256-hashed at rest, one-time read, 15-minute expiry.
4. The hand-off navigates to `/spaces/<code>/book#draft=<token>` (or the catalogue when the
   space is still undecided); the form resolves the token, fills the fields, clears the hash and
   shows *"AI draft loaded. Review every field — nothing has been submitted."*
5. Every value stays editable and the form validates independently. Nothing is auto-submitted,
   and no personal contact details travel in URLs or analytics.

## 6. Booking / payment state model

Reservation: `REQUESTED → APPROVED_AWAITING_PAYMENT → CONFIRMED`, with `REJECTED`, `CANCELLED`,
`EXPIRED`, `PAYMENT_REVIEW_REQUIRED` as terminal/exception states.
Payment (separate column): `NOT_REQUIRED, UNPAID, PENDING, PAID, FAILED, REVIEW_REQUIRED, REFUNDED`.
Holds live in `booking_hold_claim` + `occupancy` rows with explicit `expires_at`; the existing
anti-overlap triggers arbitrate holds vs. reservations vs. maintenance.

## 7. PayHere integration design and verification

- Checkout parameters are generated server-side over the **immutable** `payment_obligation`
  snapshot (integer cents, `amount` formatted to two decimals), hashed with the documented
  `md5(merchant_id + order_id + amount + currency + md5(secret))` algorithm.
- The notify endpoint accepts form-encoded callbacks, verifies `md5sig` (timing-safe), merchant
  id, currency and amount, records **every** notification in `payment_event`, and is idempotent
  on a payload fingerprint. Duplicate callbacks confirm nothing twice.
- A successful charge that cannot be applied (expired hold, cancelled request, mismatched
  amount) becomes `PAYMENT_REVIEW_REQUIRED` with the provider evidence retained — never a silent
  drop, never an automatic confirm, never inventory seized after the fact.
- The browser return URL is never treated as proof; the status page reads server-recorded state.

## 8. Database migrations

`0005_booking_request_payments_ai.sql` (SQLite) / `0002_booking_request_payments_ai.sql`
(Postgres): `booking_request`, `booking_hold_claim`, `booking_fee_policy` (seeded `DISABLED`),
`payment_obligation`, `payment_attempt`, `payment_event`, `ai_booking_draft`, plus indexes and
the `booking_request` reference sequence. Existing reservations and inquiries are untouched.

## 9. Required environment variables (names only)

`PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET`, `PAYHERE_MODE` (or `PAYHERE_SANDBOX`),
`NAGARO_BASE_URL`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `PUBLIC_FRONTEND`,
`PUBLIC_FRONTEND_ORIGIN`, plus the existing database/mail/security variables.
`.env.example` lists them with placeholder names only; no secret is committed.

## 10. Automated test results

| Suite | Command | Result |
|---|---|---|
| Unit + integration | `npm test` | **246 passed, 0 failed** |
| Concurrency / booking integrity | `npm run test:concurrency` | **37 passed, 0 failed** |
| HTTP acceptance (17 sections) | `npm run test:e2e` | **99 passed, 0 failed** |
| Public app (config, quote parity, i18n parity, surface guards) | `npm run test:public` | **38 passed, 0 failed** |
| Frontend cut-over + rollback | `npm run test:cutover` | **56 passed, 0 failed** |

New coverage this phase includes: PayHere signature/amount/idempotency edge cases, fee-policy
arithmetic and snapshot immutability, hold expiry and late-callback escalation, assistant tool
whitelisting/argument validation/redaction/tool-budget bounds, draft hashing and one-time use,
retired-route behaviour, and full dictionary parity across EN/සිං/தமிழ்.

## 11. Browser test results

The full journey was driven over real HTTP (sections 1–17 above cover request → approve → fee →
verified callback → confirmed → competing approval refused → cancellation), and the public
surface was exercised in a real browser: catalogue filtering, venue availability console,
the request form, the request status page with its PayHere action, the language switcher, and
the assistant panel (which shows the honest fallback when no provider key is configured).

Deployment verification (https://nagarobookingsystem.vercel.app) additionally exercised the
journey against the live Supabase backend and surfaced three deployment-only defects, each
fixed and covered:

1. Every request to `/assets`, `/media`, `/api` and `/admin` returned `CONFIGURATION_ERROR`
   because the function refuses to boot without `DATABASE_URL` — the Supabase panel provides
   `POSTGRES_PRISMA_URL` and friends, so the mapping is now documented in
   `VERCEL_DEPLOYMENT.md`.
2. The pages rendered their empty states although the API served the catalogue: the server-side
   self-fetch used `VERCEL_URL`, which sits behind Vercel's Deployment Protection. Covered by a
   regression test (`api-client.test.mjs`).
3. Every rate-limited endpoint failed on PostgreSQL with SQLSTATE 42702 — SQLite accepts
   `ON CONFLICT DO UPDATE SET count = count + 1`, PostgreSQL calls the name ambiguous. Fixed by
   qualifying the column and verified by reproducing against the live database.
4. The admin dashboard died with `RangeError: Invalid time value` while formatting the activity
   list: node-postgres returns `int8` timestamps as strings. int8 is now parsed to Number at the
   driver boundary and `timeTag` coerces defensively. All nine admin pages were then exercised
   against the live database.

## 12. Sandbox payment results

**No PayHere sandbox transaction was performed** — no merchant credentials were available to
this run. Everything payment-related is verified against a fake gateway using the *real*
signature rules (unit + HTTP suites). Treat payment as **LOCALLY VERIFIED only**.

## 13. Deployed Preview URL

**https://nagarobookingsystem.vercel.app** — the Vercel production deployment, wired to the
Supabase PostgreSQL project and the Vercel Blob store described below.

## 14. Missing credentials / merchant approvals

- `OPENROUTER_API_KEY` — the assistant answers from its factual fallback in this environment.
- `PAYHERE_MERCHANT_ID` / `PAYHERE_MERCHANT_SECRET` — sandbox checkout and callbacks untested
  against the real gateway.
- PayHere **domain approval** for the canonical application URL (sandbox and live) is an
  owner-side step; the merchant secret may be domain-specific.
- Supabase and Vercel Blob credentials **were provided and are wired**: the database is
  provisioned (migrations, exclusion constraint, catalogue, first administrator) and the Blob
  token is set on the Vercel project. The corresponding secrets were shared in a chat channel
  and should be rotated after the demonstration.

## 15. Known limitations

1. **Refunds are manual.** PayHere refund capability is merchant-specific; the console records
   `REFUND_RECORDED` / `PAYMENT_KEPT` reconciliation with audit and claims no provider refund.
2. **Live email is unconfigured** in this environment; requests and inquiries are persisted and
   the UI says so honestly (`NOT_CONFIGURED`).
3. **Legacy pages keep English-only fragments**: the legacy receipt/withdraw pages carry the new
   dictionary where keys exist, but a handful of legacy-only strings (e.g. the pre-request
   `/book/confirmed` receipt labels) remain English.
4. **Reduced-motion** is covered by source guards and CSS rather than runtime emulation.
5. The AI assistant's draft extraction recognises ISO dates and 24-hour times; natural-language
   dates ("next Tuesday") are answered by the model but only explicit values reach the draft.

## 16. Verdict

| Requirement | Level of evidence |
|---|---|
| Unified request flow replaces direct booking + concierge | **IMPLEMENTED + LOCALLY VERIFIED** (routes retired 410/308/303; harness sections 13, 17) |
| Minimal public header, "Book a Space" entry point | **IMPLEMENTED + LOCALLY VERIFIED** (surface guards + cut-over harness) |
| Request → admin approval → fee → confirmed lifecycle | **IMPLEMENTED + LOCALLY VERIFIED** (246 unit/integration + 99 HTTP checks) |
| Database-enforced temporary holds with expiry | **IMPLEMENTED + LOCALLY VERIFIED** (incl. 37 concurrency checks) |
| PayHere checkout + signed, idempotent callbacks | **IMPLEMENTED + LOCALLY VERIFIED** — **SANDBOX VERIFIED: BLOCKED** (no merchant credentials) |
| Booking-fee policy (fixed / percentage / disabled) | **IMPLEMENTED + LOCALLY VERIFIED** |
| Payment exceptions escalated, evidence retained | **IMPLEMENTED + LOCALLY VERIFIED** |
| Admin payment view and reconciliation | **IMPLEMENTED + LOCALLY VERIFIED** |
| OpenRouter assistant grounded in real venue data | **IMPLEMENTED + LOCALLY VERIFIED** (fake provider) — **LIVE MODEL: BLOCKED** (no API key) |
| Assistant prefill with explicit consent, editable, never auto-submitting | **IMPLEMENTED + LOCALLY VERIFIED** |
| Assistant cannot book/charge/administer | **IMPLEMENTED + LOCALLY VERIFIED** (tool whitelist + tests) |
| English / සිංහල / தமிழ் support | **IMPLEMENTED + LOCALLY VERIFIED** (dictionary parity + rendered pages) |
| Booking integrity in the database | **IMPLEMENTED + LOCALLY VERIFIED** (trigger + concurrency suites) |
| Supabase PostgreSQL deployment | **DEPLOYED + VERIFIED** (migrations, exclusion constraint, catalogue, administrator) |
| Vercel production deployment | **PREVIEW VERIFIED** at https://nagarobookingsystem.vercel.app |
| PayHere sandbox transaction end-to-end | **BLOCKED** (no merchant credentials) |
| Production hardening sign-off | **BLOCKED** (rotate the shared secrets; complete PayHere domain approval) |

Nothing in this report is claimed as production-verified.
