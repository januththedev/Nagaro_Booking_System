# Architecture — Nagaro Space Booking System

## 1. What this is

A centralized space-booking and rental-management system for Nagaro at Trace Expert City. It replaces an Excel process that caused double bookings, missed inquiries and no shared availability view.

Two experiences:

| Experience | Entry point | Purpose |
|---|---|---|
| Public | `/`, `/spaces`, `/booking-request` | Browse published spaces, check provisional availability, submit a request-to-book inquiry. No accounts, no payments, **no self-service confirmed reservations**. |
| Administrative | `/admin/*` | Manage spaces, photographs, customers, reservations, cancellations, maintenance and inquiries. Authenticated staff only. |

**The defining correctness property:** two overlapping confirmed reservations for the same single-capacity resource can never both commit. Enforced in the database, not in the UI. See §5.

## 2. Verified runtime environment

Inspected before choosing anything (see `IMPLEMENTATION_REPORT.md` for raw evidence):

| Capability | Finding | Consequence |
|---|---|---|
| Node.js | v24.22.0 (portable install) | Modern JS, ESM, `node:test`, built-in `fetch`/`FormData`/`Request` |
| `node:sqlite` | Available, SQLite **3.53.4** | Real ACID database with **zero native build step** |
| PostgreSQL / Docker | **Not installed, not reachable** | PostgreSQL exclusion constraints are NOT available; design must be correct on SQLite |
| npm registry | Reachable | Exactly one runtime dependency (`nodemailer`) |
| Build toolchain | None | No transpiling, bundling or native compilation anywhere |
| `Intl` time zones | Working | `Asia/Colombo` resolved through `Intl`, not the server clock |

**Decision:** Node 24 + built-in SQLite + a hand-written HTTP layer + server-rendered HTML. Rationale: the environment has no build toolchain and no PostgreSQL, so a stack with a native module dependency or a bundler is a delivery risk with no compensating benefit. The result runs from `node src/server/index.js` with one `npm install`.

## 3. Layering

```
src/server/
  index.js              process bootstrap: migrate, seed, listen, graceful shutdown
  app.js                assembles router + middleware + route modules
  db/
    connection.js       single handle, pragmas, withWriteTransaction/withReadTransaction
    migrate.js          forward-only migration runner (schema_migrations)
    migrations/*.sql    versioned DDL, incl. the anti-overlap triggers
    seed.js             idempotent demo/initial data
  http/                 request parsing, response helpers, router + error boundary
  domain/               time, constants (shared vocabulary), validation, errors, references
  security/             passwords (scrypt), sessions + CSRF, rate limiting, uploads
  services/             business logic: booking, availability, pricing, space, customer,
                        inquiry, dashboard, admin users, audit
  routes/               HTTP endpoints (thin: validate -> service -> respond)
  ai/                   (unused; reserved)
src/web/
  lib/html.js           escaped templating primitives
  views/                server-rendered pages
  public/               static CSS + progressive-enhancement JS
apps/public-web/        Next.js public frontend (App Router, React 19, Tailwind 4)
  app/                  routes: /, /spaces, /book, /book/confirmed, /book/manage,
                        /booking-request, /booking-request/received, /booking-request/withdraw
  components/           hero (WebGL + GSAP), catalogue, checkout, management, shell
  lib/                  server API client, formatting, media, engine-accurate quote mirror
  tests/                Node test-runner suite for the app (config, quote parity, guards)
tests/{unit,integration,concurrency}
scripts/                admin creation, demo, smoke checks, e2e harnesses, stack runner
storage/uploads/        uploaded space photographs (outside the web root)
data/nagaro.db          SQLite database file
```

Boundaries:

- **routes** never contain business rules; they parse input, call a service, and render or serialise.
- **services** own transactions and invariants; they never touch `req`/`res`.
- **domain** is dependency-free (pure functions + constants).
- **views** receive plain objects and never query the database.
- **web/public** is inert: no secrets, no customer data.
- **apps/public-web** is a presentation layer only: it reads the public JSON API and posts guest
  forms back to the Node runtime. It owns no database handle, no capability token and no booking
  rule; the availability, pricing and overlap logic it mirrors for display is asserted against the
  real server modules by `apps/public-web/tests/quote.test.mjs`.

## 4. Data model summary

Full detail in `DATA_MODEL.md`. Key tables:

- `admin_user`, `admin_session`, `audit_log` — identity, sessions, immutable activity history.
- `space`, `space_rate`, `space_image`, `resource_unit` — catalogue and bookable inventory.
- `customer` — one authoritative profile per customer.
- `reservation` — the booking record, including cancellation actor/time/reason.
- `occupancy` — **concrete inventory claims**, one row per (resource unit, interval). This is the table that makes double booking impossible.
- `maintenance_block` — planned unavailability, materialised as `occupancy` rows with `source = 'MAINTENANCE'`.
- `inquiry` — public request-to-book submissions with delivery status.
- `rate_limit_counter`, `app_sequence` — abuse control and document numbering.

### Inventory model

| Category | Resource units | Booking granularity |
|---|---|---|
| Meeting/training room | exactly 1 `EXCLUSIVE` unit | one reservation at a time |
| Auditorium | exactly 1 `EXCLUSIVE` unit | one reservation at a time |
| Co-working | N `DESK` units (N = desk inventory) | 1..N desks per reservation |

Capacity is therefore not a counter that can drift. A pooled desk booking allocates **specific** desk rows; the per-unit non-overlap rule makes "never more than 20 desks at once" a consequence of the same constraint that prevents room double booking.

## 5. How double booking is prevented

Three independent layers, in order of authority:

1. **`BEGIN IMMEDIATE` write transactions.** Every creating/moving/releasing operation opens with `BEGIN IMMEDIATE`, taking SQLite's single write lock *before* reading. Concurrent processes block on `busy_timeout=10000` rather than interleaving, so the availability re-check inside the transaction observes every previously committed booking. A successful earlier availability *preview* therefore guarantees nothing — the check that matters happens under the lock.
2. **Database triggers.** `trg_occupancy_no_overlap_insert` and `trg_occupancy_no_overlap_update` run `RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')` whenever an ACTIVE occupancy row would overlap another ACTIVE row on the same resource unit. This holds for *any* code path, including future ones, and independently of layer 1.
3. **Unique constraints and optimistic guards.** `reservation.idempotency_key` is UNIQUE (retry safety). Cancellation is `UPDATE ... WHERE status = 'CONFIRMED'`, so a repeated cancel changes zero rows and cannot release inventory twice.

Interval semantics are half-open throughout: `[start, end)`, conflicting exactly when `a.start < b.end AND a.end > b.start`. An 11:00 end never collides with an 11:00 start. `space.buffer_minutes` widens the *requested* interval symmetrically and applies only against reservation occupancy, so maintenance is compared exactly.

Rollback is the failure story: a rejected edit re-runs the whole transaction, leaving the original reservation and its allocations byte-for-byte unchanged. A rejected creation leaves nothing behind — no orphaned occupancy rows, no consumed reference.

Evidence: `tests/concurrency/*` spawn real OS processes against the real database file. `scripts/demo-double-booking.js` reproduces the rejection for a live demo.

## 6. Booking status semantics

| Status | Consumes inventory | Notes |
|---|---|---|
| `CONFIRMED` | Yes | The only status an administrator creates |
| `COMPLETED` | Yes (for its past interval) | Set by reconciliation once `end_at` has passed; history preserved |
| `CANCELLED` | No | Releases its occupancy rows atomically, exactly once |
| Public inquiry | **No** | Never reserves inventory; administrator converts manually |

## 7. Authentication and authorization

- Passwords: `scrypt` (N=16384, r=8, p=1) with a per-user random salt, stored as `scrypt$N$r$p$salt$hash`. Verified in constant time.
- Sessions: a 32-byte random token in an `HttpOnly`, `SameSite=Lax` cookie. Only the SHA-256 hash is stored, so database contents cannot be replayed as a live session. 12-hour absolute expiry plus a 2-hour idle timeout.
- **Roles are resolved from the database on every request**, never from the browser.
- CSRF: double-submit token derived from a per-session secret, required on every state-changing admin request (`_csrf` field or `x-csrf-token` header).
- Sign-in throttling: per-IP and per-account counters, plus account lockout after repeated failures.
- First administrator: `npm run admin:create` or `NAGARO_BOOTSTRAP_ADMIN_EMAIL` / `NAGARO_BOOTSTRAP_ADMIN_PASSWORD` applied on first boot; the bootstrap values are ignored once any administrator exists.

## 8. Public/private data boundary

| Data | Public | Admin |
|---|---|---|
| Space name, description, amenities, rates, capacity | Yes (PUBLISHED only) | Yes |
| Availability for a period | Yes — counts and blocked intervals only | Yes, with details |
| Customer name, email, phone, organisation, notes | **Never** | Yes |
| Reservation references, purposes, internal notes | **Never** | Yes |
| Inquiries | Only via the visitor's own withdraw link | Yes |

`getPublicAvailability()` is the single public availability entry point and returns counts and anonymous blocked periods. It never joins `customer`. `DRAFT` and `ARCHIVED` spaces return 404 on public routes.

## 9. Time zone

All timestamps are stored as epoch milliseconds in UTC. Every local calculation goes through `src/server/domain/time.js`, which pins the business zone to `Asia/Colombo` (fixed UTC+05:30, no DST) via `Intl`. The server's own time zone is never consulted.

## 10. Email

`src/server/mail/mailer.js` uses `nodemailer` when `SMTP_*` environment variables are present. When they are absent the inquiry is still persisted, `email_status` is recorded honestly as `NOT_CONFIGURED`, and the visitor is told the request was received but that notification is pending configuration. A successful database write is never reported to the visitor or to staff as a delivered email.

## 11. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (default 4173) | HTTP port |
| `NAGARO_DB_PATH` | No (`data/nagaro.db`) | SQLite file |
| `NAGARO_BASE_URL` | No | Absolute links in notification emails |
| `NAGARO_IP_SALT` | Recommended in production | Salts hashed IPs |
| `NAGARO_TRUST_PROXY` | No | Set to `1` behind a reverse proxy |
| `NAGARO_FORCE_SECURE_COOKIES` | No | Set to `1` to force the `Secure` cookie flag |
| `NAGARO_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` / `_NAME` | No | First administrator on an empty database |
| `NAGARO_ADMIN_NOTIFICATION_EMAIL` | No | Where inquiry notifications are sent |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM` | No | Email delivery |
| `NAGARO_UPLOAD_DIR` | No (`storage/uploads`) | Photograph storage |
| `PUBLIC_FRONTEND` | No (`legacy`) | `next` streams public pages to the Next.js process; `legacy` renders them in this process |
| `PUBLIC_FRONTEND_ORIGIN` | Only when `PUBLIC_FRONTEND=next` | Internal origin of the Next.js process (must not be the public port) |
| `PUBLIC_FRONTEND_HOST` / `PUBLIC_FRONTEND_PORT` | No (`127.0.0.1:4174`) | Convenience inputs used by `scripts/run-public-stack.js` to build the origin |
| `API_ORIGIN` (or `API_PROXY_TARGET`) | Only for the Next.js process | Node origin the Next app calls for `/api`, `/assets` and `/media` |

## 12. Public frontend (Next.js) and the same-origin gateway

The public experience can be rendered by a Next.js app in `apps/public-web` while the Node runtime
stays the only public listener. The split is deliberately in the HTTP layer, not in page code:

```
browser ──► Node (public port)
              ├─ /api/*, /admin/*, /assets/*, /media/*      → handled here (booking engine, console, files)
              ├─ POST /book, /book/cancel, /booking-request,
              │  /booking-request/withdraw                    → handled here (no-JavaScript form fallback)
              └─ every other GET                              → streamed to the Next.js process
```

- `src/server/http/publicFrontendProxy.js` owns the decision. `isBackendOwnedPath(pathname, method)`
  answers "does the booking runtime own this request", and `BACKEND_FORM_POSTS` lists the page paths
  whose POSTs must stay local even though their GET is rendered by Next — the same origin is what
  makes the session cookie, CSRF secret, capability token, rate limiter and audit log work for both
  stacks at once.
- The Next app never becomes a second origin: `apps/public-web/next.config.mjs` rewrites
  `/api`, `/admin`, `/assets` and `/media` straight back to the Node runtime, so a direct visit to
  the Next port still talks to the same engine (used only for local development).
- Capability pages (`/book/confirmed`, `/book/manage`) carry `Cache-Control: no-store, private`,
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` from `apps/public-web/middleware.ts`;
  the booking JSON endpoints set the same headers server-side.
- Rolling back is configuration only: unset `PUBLIC_FRONTEND` (or set `legacy`) and the Node
  renderer serves every page again, with the Next process stopped. Both renderers read the same
  services and the same database, so a rollback never strands data.
- Evidence: `npm run test:cutover` boots Node + `next start` and drives the public origin, asserting
  which process answered, that the no-JavaScript form posts reach the booking engine, that the
  capability pages stay unshareable, and that the legacy flag still works.

## 13. Target production architecture (Supabase + Vercel)

The shipped code runs on SQLite + local filesystem by default (development).
For production, the following environment variables switch the runtime:

- `DATABASE_URL` (and `DIRECT_URL` for migrations): when set, the application
  uses PostgreSQL (Supabase) instead of SQLite. The `pg` driver is used.
- `BLOB_READ_WRITE_TOKEN`: when set, uploaded photographs are stored in Vercel
  Blob; otherwise the local filesystem is used.

Schema for PostgreSQL is in `db/migrations-postgres/0001_init.sql`. It preserves
the epoch-millisecond service contract and adds a GiST exclusion constraint on
`occupancy` (`int8range(start_at, end_at, '[)')`) that enforces non-overlap at
the database level for every resource unit, including individual desk units.

See `AUDIT_REPORT.md` §7-§10 for the migration plan and remaining
configuration steps.

**Status:** the runtime adapter, migration runner, Blob integration and Vercel
routing are implemented. A live Supabase project and Vercel Blob store are still
required for the hosted cutover because no production credentials are committed.
See `VERCEL_DEPLOYMENT.md` for the operator checklist.
