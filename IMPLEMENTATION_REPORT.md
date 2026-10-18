# Implementation Report — Nagaro Space Booking & Rental Management

**Project:** Nagaro Space Booking and Rental Management System for Trace Expert City
**Status:** Phase 1 complete and verified
**Date:** 2026-10-18
**Repository:** https://github.com/januththedev/Nagaro_Booking_System (branch `main`, commit `a298fcb`)

## 1. Stack and runtime

- Node.js v24.22.0 (portable install) + built-in `node:sqlite` (SQLite 3.53.4).
- Zero native build toolchain, no Docker, no PostgreSQL. One runtime dependency: `nodemailer@6.9.16`.
- Hand-written HTTP layer, server-rendered HTML, no client framework.
- Time zone: all timestamps stored as epoch ms (UTC); displayed in `Asia/Colombo` (fixed UTC+05:30) via `src/server/domain/time.js`.

## 2. Architecture

Layered, contract-first:

```
HTTP (router) -> middleware (static, session, flash) -> routes -> services -> db (SQLite)
                                                          -> views (server-rendered HTML)
```

- `src/server/app.js` assembles the middleware chain and registers all route modules.
- `src/server/db/migrations/0001_init.sql` owns the schema, including the two anti-overlap triggers.
- `src/server/services/*` holds all business rules; routes are thin.
- `src/web/views/*` server-rendered HTML using `src/web/lib/html.js` (escaped interpolation).

## 3. Double-booking prevention (the core requirement)

Three independent layers, all verified:

1. **`BEGIN IMMEDIATE` write transactions** (`withWriteTransaction`): every mutation takes the write lock; availability is re-checked inside the lock.
2. **SQLite triggers** `trg_occupancy_no_overlap_insert` / `trg_occupancy_no_overlap_update` raise `RAISE(ABORT,'DOUBLE_BOOKING_CONFLICT')` on any overlapping ACTIVE occupancy row. They fire even on direct SQL writes.
3. **Idempotency + optimistic cancellation**: `reservation.idempotency_key` is UNIQUE; cancellation uses `UPDATE ... WHERE status='CONFIRMED'` so it can succeed exactly once.

Half-open intervals: conflict iff `existing.start < requested.end AND existing.end > requested.start`; adjacent times do not conflict. Verified by `CASE 5` (09:00–11:00 then 11:00–13:00 both succeed) and `CASE 6` (one-minute overlap rejected).

Occupancy semantics: CONFIRMED + COMPLETED consume inventory; CANCELLED releases it (occupancy row set to `RELEASED`); public inquiries never create occupancy rows; maintenance blocks consume inventory over their exact interval. Buffer minutes inflate the *requested* interval only against reservation-sourced occupancy, never maintenance (verified by `CASE 10a`/`10b`).

## 4. Concurrency evidence (real multi-process)

The suite in `tests/concurrency/` spawns real OS child processes against the same on-disk SQLite file (WAL, `busy_timeout=10000`), releases them with a shared wall-clock `START` broadcast (observed skew 1–4 ms).

Command: `.\tools\node.cmd --test --test-concurrency=1 "tests/concurrency/*.test.js"`
Result: **37 tests, 37 pass, 0 fail, 26 030 ms**.

Key evidence:
- `CASE 1`: 8 processes, identical room and window → exactly 1 confirmed.
- `CASE 4`: 10 rounds × 8 processes on 10 fresh databases → exactly 1 winner every round.
- `CASE 15`: 30 processes on a 20-desk pool → exactly 20 succeed; per-instant SQL check peak = 20 desks, never 21.
- `CASE 20`: 6 processes cancel the same reservation → exactly 1 succeeds, inventory released once.
- `CASE 21`: 8 processes with the same idempotency key → one reservation, one reference.
- `CASE 27`/`28`: direct `INSERT`/`UPDATE` into `occupancy` that overlaps an ACTIVE row is refused by the trigger.
- `CASE 31`: an unclean shutdown mid-transaction leaves nothing behind.

Demo: `.\tools\node.cmd scripts/demo-double-booking.js` → 6 processes race, exactly 1 confirms, 5 refused with `DOUBLE_BOOKING_CONFLICT` naming the winner's reference. Exit 0.

## 5. End-to-end acceptance evidence

Command: `.\tools\node.cmd scripts/e2e-verify.js`
Result: **63 checks, 63 pass, 0 fail**.

Covered flows:
- Unauthenticated `GET /admin` → 303 to login; `GET /api/admin/dashboard/summary` → 401 `UNAUTHORIZED`.
- Admin sign-in with a real scrypt hash, session cookie.
- Space creation → publish blocked without a photo → real PNG upload (magic-byte validated, 32-hex stored name) → publish succeeds → PUBLISHED.
- Public browse (`/`, `/spaces`, `/spaces/:code`), `GET /api/public/spaces`, `GET /api/public/availability`.
- Customer creation + search.
- Reservation creation → conflicting reservation rejected (no second row) → conflicting edit rejected (original window unchanged) → cancellation reason required (blank → 422) → cancel with reason succeeds and records it → second cancel rejected (409).
- Public inquiry → received page with reference and honest `NOT_CONFIGURED` delivery status → withdraw with token → WITHDRAWN; admin queue lists it.
- Maintenance block creation.
- Calendar, audit, dashboard summary, media serving with `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`.

## 6. Test inventory

| Suite | Files | Tests | Pass | Fail |
|---|---|---|---|---|
| Unit + integration | `tests/unit`, `tests/integration` | 190 | 190 | 0 |
| Concurrency (multi-process) | `tests/concurrency` | 37 | 37 | 0 |
| End-to-end acceptance | `scripts/e2e-verify.js` | 63 checks | 63 | 0 |
| **Total** | | **290** | **290** | **0** |

Unit/integration command: `npm test` (globs `tests/unit/**/*.test.js` and
`tests/integration/**/*.test.js`). Concurrency: `npm run test:concurrency`. End-to-end:
`npm run test:e2e`.

## 7. Requirement coverage (P0 / P1 / P2)

**P0 — all done:**
- Persistence: SQLite with migrations, FKs, integrity gate on boot.
- Auth: server-side, scrypt hashes, DB-resolved roles, HttpOnly session cookie, CSRF double-submit, rate-limited login.
- Spaces: CRUD, categories (meeting/training, auditorium, co-working), desk inventory, rates.
- Availability: overlap engine, half-open, buffer, maintenance.
- Admin reservations: create/edit/cancel, conflict detection.
- Double-booking prevention: verified (§3, §4).
- Central booking overview: dashboard with live figures.

**P1 — all done:**
- Customers: directory, search, duplicates, history.
- Photos: mandatory before publish, magic-byte sniffing, 5 MB cap, SVG rejected.
- Edit/cancel with reason + audit trail.
- Inquiry form + email: persisted even when email unconfigured; delivery status reported honestly (`NOT_CONFIGURED`/`FAILED`/`SENT`); `NAGARO_MAIL_TRANSPORT=json|stream` enables a real SENT path for tests.
- Calendar with filters; availability day grid.

**P2 — done:** CSS design system, responsive layout, empty states, flash messages, audit log UI, dashboard.

## 8. Security controls (see also SECURITY_REVIEW.md)

- Auth: scrypt (N=16384, r=8, p=1); 32-byte session token, only SHA-256 stored; 12 h absolute + 2 h idle expiry.
- CSRF: per-session secret, double-submit.
- Uploads: magic bytes only, SVG rejected, 5 MB cap, 32-hex random stored names, `wx` open flag, path containment in `storedPathFor`, media served with `CSP: default-src 'none'; sandbox` and `nosniff`.
- Public responses: `getPublicAvailability()` only — no customer names, emails, phones, notes, or reservation references. Verified by `tests/unit/publicPrivacy.test.js` (40+ assertions).
- Rate limiting: login, public inquiry, admin mutation scopes.
- No payment processing, no public accounts, no AI assistants.

## 9. Known limitations

- Email is `NOT_CONFIGURED` unless `SMTP_HOST` is set; inquiries are still persisted and the UI states honestly that no email was delivered.
- Queue delivery filter and audit filters operate inside the newest-200-row window (service hard cap); the UI states this.
- `GET /admin/maintenance` is registered by both `adminBookingRoutes` (mounted first) and `adminOpsRoutes`; the booking module's page wins. Maintenance POSTs are owned by the booking module.
- `node --test tests/concurrency` (bare directory form) fails on Node 24; the `package.json` scripts now use the glob form (`tests/concurrency/**/*.test.js`) so `npm test` / `npm run test:concurrency` work on the required Node version.
- Pixel-level rendering was measured natively in a real browser at 390/768/1440 CSS px during the Phase 2 pass (54 route × width combinations, 0 overflow); screenshots could not be rasterised in that environment (no visible desktop window). Lighthouse accessibility is 1.00 on every audited route. See `UI_UX_IMPLEMENTATION_REPORT.md`.

## 10. Key files

- Spine: `src/server/app.js`, `src/server/index.js`, `src/server/db/migrations/0001_init.sql`
- Concurrency core: `src/server/services/bookingService.js`, `src/server/services/availabilityService.js`
- Auth/security: `src/server/security/sessions.js`, `src/server/security/uploads.js`, `src/server/security/rateLimit.js`
- Contracts: `ARCHITECTURE.md`, `API_CONTRACTS.md`, `DATA_MODEL.md`, `docs/BOOKING_RULES.md`, `docs/UX_GUIDE.md`, `REQUIREMENT_TEST_MATRIX.md`, `IMPLEMENTATION_PLAN.md`
