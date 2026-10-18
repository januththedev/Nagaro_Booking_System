# Audit Report — Nagaro Space Booking System

**Audited commit:** `602c9a7` (branch `main`) — later than the reported baseline `a298fcb`; the repository grew between the reported baseline and this audit.
**Audit date:** 2026-10-18
**Auditor:** independent verification against the live repository, not against the supplied `IMPLEMENTATION_REPORT.md`.

## 1. Method

- Cloned locally at `D:\Nagaro_Bookinag_System`; working tree clean, `main` tracking `origin/main`.
- Ran the documented test commands with the portable Node v24.22.0 runtime.
- Inspected schema, services, routes, security modules, views, and tests.
- Booted the real production entry point (`src/server/index.js`) against a throwaway database and probed HTTP endpoints.
- Ran the end-to-end acceptance harness (`scripts/e2e-verify.js`).

## 2. Reproduced test suites

| Suite | Command | Result |
|---|---|---|
| Unit + integration | `.\tools\node.cmd --test --test-concurrency=1 "tests/unit/*.test.js" "tests/integration/*.test.js"` | **176/176 pass** |
| Concurrency (real OS processes) | `.\tools\node.cmd --test --test-concurrency=1 "tests/concurrency/*.test.js"` | **37/37 pass** |
| End-to-end acceptance | `.\tools\node.cmd scripts/e2e-verify.js` | **63/63 pass** |
| Total | | **276/276 pass** |

The reported claim of "176 unit/integration + 37 concurrency + 63 e2e" is **verified** as stated.

## 3. Verified claims

- **Double-booking prevention** — three layers present and effective: `BEGIN IMMEDIATE` write transactions, two anti-overlap triggers (`trg_occupancy_no_overlap_insert`/`_update` raising `DOUBLE_BOOKING_CONFLICT`), and idempotency + optimistic cancellation. Verified by multi-process races (`CASE 1`, `4`, `15`, `20`, `21`, `27`, `28`, `31`).
- **Half-open intervals** — `a.start < b.end AND a.end > b.start`; adjacency does not conflict (verified `CASE 5`/`6`).
- **Occupancy semantics** — CONFIRMED/COMPLETED consume; CANCELLED releases exactly once; maintenance consumes; inquiries never do (verified `CASE 10a`/`10b`/`10c`).
- **Cancellation** — non-blank reason required, actor/timestamp/reason recorded, history preserved, exactly-once release (verified `CASE 20` and e2e §12).
- **Photo upload mandatory before publish** — verified end-to-end (publish blocked without image; succeeds after upload).
- **Public PII boundary** — `getPublicAvailability()` only; `tests/unit/publicPrivacy.test.js` 40+ assertions pass.
- **Auth** — scrypt, DB-resolved roles, HttpOnly session cookie, CSRF double-submit, rate-limited login. Verified by `tests/integration/adminCustomerRoutes.test.js` (unauthenticated → 401).
- **Email honesty** — `NOT_CONFIGURED`/`FAILED`/`SENT` recorded; inquiry persisted regardless; verified by e2e §13 and `tests/unit/mailer.test.js`.
- **Time zone** — `Asia/Colombo` pinned in `src/server/domain/time.js`; `dashboardService.dashboardSummary` rejects any other zone.
- **Server boot** — `src/server/index.js` applies migrations, integrity gate, trigger gate, and starts cleanly; verified by boot check.
- **Triggers present** — 2 triggers; `PRAGMA integrity_check` / `foreign_key_check` clean.

## 4. Defects found and fixed (this audit)

| # | Defect | File | Impact | Fix |
|---|---|---|---|---|
| 1 | Static assets returned 404 (middleware ran only after route match). | `src/server/http/router.js` | Broken CSS/JS. | Run middleware chain before matching. |
| 2 | `checkBookingRules` accepted a 06:00 booking on an 08:00–18:00 space. | `src/server/services/availabilityService.js` | Invalid bookings confirmed. | Reject cursor before `dayOpen`. |
| 3 | Multi-day booking crossing midnight rejected on 24 h spaces. | same | Valid multi-day desk rentals refused. | Advance cursor to next day's open; extend `23:59` to midnight. |
| 4 | `createMaintenanceBlock` threw `column index out of range`. | `src/server/services/bookingService.js` (prior fix) | Maintenance feature broken. | Verified fixed. |
| 5 | Wrong relative import depth in `publicRoutes.js`, `authRoutes.js`. | routes | Server could not boot. | Corrected to `../../`. |
| 6 | `redirect()` did not set `ctx.responded` → `ERR_HTTP_HEADERS_SENT`. | `src/server/http/router.js` | Spurious errors after redirects. | Guard with `isHeaderSent`. |
| 7 | `adminBookingRoutes` and `adminOpsRoutes` both register `GET /admin/maintenance`. | routes | Duplicate registration (first wins). | Documented; booking module owns it. |

## 5. Partially verified / limitations

- **Pixel-level responsive rendering** was not measured with a live browser; a static CSS audit was performed instead.
- **Email SENT path** is exercised only via `NAGARO_MAIL_TRANSPORT=json|stream`; no live SMTP was available.
- **Rate-limited agents** in the previous session (docs, booking/calendar routes, public routes) hit the API limit mid-run; their files landed and the app boots cleanly, but minor finishing work may remain.
- **Nodemailer 6.x** has known advisories (CRLF injection, DoS). Upgrading to v10 is a breaking change; deferred because email is optional and the app never parses untrusted addresses. Documented in `SECURITY_REVIEW.md`.

## 6. Not verified / blocked (external)

- **Supabase PostgreSQL**: no `DATABASE_URL`, `SUPABASE_*`, or `psql` available. SQLite remains the runtime database. Migration artifacts are provided (§7) but a live migration could not be executed.
- **Vercel Blob**: no `BLOB_READ_WRITE_TOKEN` or Vercel CLI. Local filesystem storage remains the runtime path; Blob integration code is provided (§8) but not live-tested.
- **Vercel deployment**: no Vercel CLI or project credentials. Not deployed.
- **Live SMTP**: no `SMTP_HOST`. Email status correctly reports `NOT_CONFIGURED`.

## 7. PostgreSQL migration artifacts

Created `db/migrations-postgres/0001_init.sql` (see repository) containing:
- All 16 tables with PostgreSQL types (`timestamptz`, `jsonb`, `text`, `integer`).
- Primary keys, foreign keys, unique constraints, check constraints.
- Indexes on `reservation(space_id, start_at)`, `occupancy(resource_unit_id, start_at, end_at)`, `inquiry(status, created_at)`, etc.
- A GiST exclusion constraint on `occupancy` using `tstzrange(start_at, end_at, '[)')` with `WITH =` on `resource_unit_id`, restricted to `status = 'ACTIVE'` (via a partial index/exclusion), providing database-enforced non-overlap for single resources.
- Desk-pool capacity enforced via explicit `resource_unit` rows + per-unit exclusion (same mechanism, N units).
- `app_sequence` and `rate_limit_counter` tables.
- Triggers for `updated_at` maintenance.

The migration runner (`src/server/db/migrate.js`) is SQLite-specific; a PostgreSQL runner is documented as a follow-up (use `node-pg-migrate` or a simple `schema_migrations` table with `pg`).

## 8. Vercel Blob integration

`src/server/security/uploads.js` now conditionally uses `@vercel/blob` when `BLOB_READ_WRITE_TOKEN` is present:
- `put()` with a generated pathname, `access: 'public'`, content-type from sniffed bytes.
- Returns the Blob URL; metadata stored in `space_image` (column `blob_url`, `blob_pathname`).
- On DB failure, the uploaded blob is deleted (best-effort) to avoid orphans.
- Falls back to the local filesystem when the token is absent (development).

`@vercel/blob` and `pg` are added to `package.json` dependencies.

## 9. Architecture update

`ARCHITECTURE.md` §2 updated to reflect the target (Supabase PostgreSQL + Vercel Blob) while noting SQLite remains the local/dev default until a live database is provisioned.

## 10. Remaining required configuration (external)

1. Provision a Supabase project; set `DATABASE_URL` (pooled connection) and `DIRECT_URL` (for migrations).
2. Run `db/migrations-postgres/*.sql` against the Supabase database.
3. Create a Vercel Blob store; set `BLOB_READ_WRITE_TOKEN`.
4. Set `NAGARO_IP_SALT`, `NAGARO_BOOTSTRAP_ADMIN_EMAIL`/`_PASSWORD`, `NAGARO_ADMIN_NOTIFICATION_EMAIL`, and SMTP variables in Vercel.
5. Deploy via Vercel (`vercel deploy`).
6. Run the PostgreSQL concurrency test suite against the Supabase test database.
7. Execute the data migration script if any real SQLite data exists (none found in this repository's `data/` directory at audit time).

## 11. Agents deployed

This session used the orchestrator directly (no subagents) due to the prior rate-limit incident; all work was verified by reproducible commands listed above. Subagent deployment is recommended for the remaining PostgreSQL concurrency and browser UX verification once credentials are available.

## 12. Addendum — Phase 2 verification pass (2026-10-18, later than §1–§11)

This section records what changed after the audit above. The audit in §1–§11 stands as the
state of commit `602c9a7`; the figures below supersede §2 and §5 for the current tree.

- **Location corrected.** TRACE Expert City is in Colombo, Sri Lanka, not Addis Ababa. The business
  zone is `Asia/Colombo` (UTC+05:30) and the currency is `LKR`. This corrected a real defect: the
  audit's §3 "Time zone" line was only true *after* the locale was fixed. See
  `UI_UX_IMPLEMENTATION_REPORT.md` §3.
- **Reproduced test suites (current).** Unit + integration **190/190**, concurrency **37/37**,
  end-to-end **63/63** — **290/290 pass**. (`npm test`, `npm run test:concurrency`, `npm run test:e2e`.)
- **Browser verification now performed.** Every public and admin route was driven in a real Chromium
  browser: navigation, form submission, accessibility-tree snapshots, console/network capture and
  Lighthouse. Responsive layout was measured natively at 390/768/1440 CSS px — **54 route × width
  combinations, 0 page-level overflow, 0 console errors/warnings** — addressing the §5 limitation.
  Lighthouse accessibility is **1.00 on every audited route**. Screenshots could not be rasterised
  in this environment (no visible desktop window); no screenshots are fabricated.
- **Defects found and fixed this pass:** mobile overflow on `/admin/maintenance`; footer brand text at
  1.05:1 contrast; admin heading-order skips; non-focusable scrollable tables; gallery
  accessible-name mismatch; the CSP `style-src 'unsafe-inline'` relaxation; `npm test` not running on
  Node ≥ 22; and a stale `nagaro.et` placeholder.
- **CSP tightened, not relaxed.** `src/server/http/response.js` now sends `style-src 'self'`; the one
  inline style that required `unsafe-inline` was removed at the root.

