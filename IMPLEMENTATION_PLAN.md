# Implementation Plan — Nagaro Space Booking System

**Rewritten 18 October 2026 to describe the repository as it actually is.** Every "produced" line below
corresponds to a file that exists on disk and was opened while writing `DATA_MODEL.md`,
`REQUIREMENT_TEST_MATRIX.md` and `docs/BOOKING_RULES.md`. Every "outstanding" line corresponds to a file
that is referenced by `ARCHITECTURE.md`, `API_CONTRACTS.md` or `package.json` and does **not** exist.

Workstream identifiers follow the orchestrator's naming (`A1`–`E6`). Ownership is shown per file so the
map can be checked against the repository rather than against a plan document.

---

## 1. Workstreams

| WS | Role | Owns | Status |
|---|---|---|---|
| **A1** | Architecture & contracts | `ARCHITECTURE.md`, `API_CONTRACTS.md` | **Produced.** Both frozen. Both over-describe the system — see §6. |
| **A2** | Domain requirements analyst | `REQUIREMENT_TEST_MATRIX.md`, `docs/BOOKING_RULES.md` | **Produced** (this delivery). |
| **A3** | Data model specialist | `DATA_MODEL.md`, `tests/unit/bookingRulesTraceability.test.js` | **Produced** (this delivery). |
| **B1** | Persistence & domain layer | `src/server/db/connection.js`, `db/migrate.js`, `db/migrations/0001_init.sql`, `domain/*.js` | **Produced and complete.** Schema, pragmas, migration runner, and all five pure domain modules. |
| **B2** | Booking & availability engine | `services/bookingService.js`, `services/availabilityService.js`, `services/pricingService.js` | **Produced.** Contains defects **D-1** (maintenance insert) and **D-2** (multi-day windows); see `REQUIREMENT_TEST_MATRIX.md` §13.4. |
| **B3** | Catalogue, customers, audit | `services/spaceService.js`, `services/customerService.js`, `services/auditService.js` | **Produced.** Contains wart **D-4** (`syncUnits` does not reactivate). |
| **B4** | Inquiry, dashboard, admin users, mail | `services/inquiryService.js`, `services/dashboardService.js`, `services/adminUserService.js`, `mail/mailer.js` | **Outstanding.** None of these files exist. The `inquiry` table and vocabulary exist with no service. |
| **C1** | HTTP core | `http/router.js`, `http/request.js`, `http/response.js`, `app.js`, `config.js` | **Produced.** Middleware chain, error boundary, security headers, body limits. |
| **C2** | Process bootstrap & storage | `index.js`, `db/seed.js`, `security/uploads.js`, `scripts/create-admin.js` | **Outstanding.** `npm start` cannot run; there is no way to create a first administrator. |
| **C3** | Public routes | `routes/publicRoutes.js`, `routes/mediaRoutes.js` | **Outstanding.** |
| **C4** | Admin routes | `routes/authRoutes.js`, `routes/adminSpaceRoutes.js`, `routes/adminBookingRoutes.js`, `routes/adminCustomerRoutes.js`, `routes/adminOpsRoutes.js`, `routes/adminUploadRoutes.js` | **Outstanding.** `app.js` imports all eight modules; importing `app.js` fails today. |
| **D1** | View primitives | `web/lib/html.js`, `web/views/layout.js` | **Produced.** Escaping, formatting, badges, pagination, both page shells. |
| **D2** | Public pages | `web/views/public/*` (landing, directory, space detail, booking request, acknowledgement, withdraw) | **Outstanding.** |
| **D3** | Admin pages | `web/views/admin/*` (dashboard, spaces, reservations, calendar, customers, inquiries, maintenance, audit, login) | **Outstanding.** |
| **D4** | Static assets | `web/public/styles.css`, `public.js`, `admin.js`, `favicon.svg` | **Outstanding.** Both shells reference these URLs; all three currently 404. |
| **E1** | Concurrency suite | `tests/concurrency/*` (30 cases, `R-CONC-001`…`R-CONC-030`) | **Outstanding.** The mechanism is implemented; the multi-process behaviour has never been observed. |
| **E2** | Unit suite | `tests/unit/*` | **Partial.** `bookingRulesTraceability.test.js` exists. `mailer*`, `uploads*`, `dashboard*` do not. |
| **E3** | Integration suite | `tests/integration/*` (`inquiry*`, `dashboard*`, `adminUser*`, plus public and booking flows) | **Outstanding.** |
| **E4** | Test helpers | `tests/helpers/*` | **Outstanding.** |
| **E5** | Demo scripts | `scripts/demo-double-booking.js` | **Outstanding.** `scripts/smoke-core.js` exists and **passes** (run for this plan). |
| **E6** | Reports & hand-off | `IMPLEMENTATION_REPORT.md` | **Outstanding.** `ARCHITECTURE.md` §2 cites it for raw evidence. |

**Score: 12 workstreams produced, 13 outstanding, 1 partial.**

---

## 2. File-ownership map

Rules already in force, restated so nobody edits across a boundary:

- `src/server/db/migrations/**` — one owner (B1). A change to `0001_init.sql` invalidates
  `DATA_MODEL.md` §5 and `tests/unit/bookingRulesTraceability.test.js`.
- `src/server/domain/**` — one owner (B1). These modules are dependency-free pure functions; a service
  importing a domain module is fine, the reverse is a defect.
- `src/server/services/**` — B2 (booking, availability, pricing) and B3 (space, customer, audit),
  with B4 outstanding for the rest. Services own transactions; they never touch `req`/`res`.
- `src/server/routes/**` — C3/C4. Routes never contain business rules.
- `src/server/http/**`, `app.js`, `config.js` — C1.
- `src/web/lib/**`, `src/web/views/**` — D1 produced the primitives; D2/D3 own the pages and must not edit
  `html.js` or `layout.js` contracts (`API_CONTRACTS.md` §6).
- `src/web/public/**` — D4.
- `tests/**` — E1–E4, one owner per directory. `tests/helpers/**` is shared infrastructure and must be
  stable before the suites that depend on it.
- `scripts/**` — E5.
- `*.md` at the repository root — A1 (frozen contracts), A2/A3 (analysis artefacts).
  **No analysis document may be edited to make an implementation look complete.**

---

## 3. Dependency graph

```
                    ┌─────────────────────────────┐
                    │ A1  ARCHITECTURE / CONTRACTS │  (frozen)
                    └──────────────┬──────────────┘
                                   │
             ┌─────────────────────┴─────────────────────┐
             ▼                                           ▼
  ┌───────────────────────┐                  ┌────────────────────────┐
  │ B1  schema + domain    │                  │ A2/A3  analysis +       │
  │ 0001_init.sql, pragmas │                  │ traceability + tests    │
  └───────────┬───────────┘                  └───────────┬────────────┘
              │                                          │
              ▼                                          │
  ┌───────────────────────┐    ┌──────────────────────┐  │
  │ B2  booking/avail/pricing│  │ B3  space/customer/audit│ │
  └───────────┬───────────┘    └──────────┬───────────┘  │
              └────────────┬──────────────┘              │
                           ▼                             │
                  ┌──────────────────┐                   │
                  │ B4  inquiry /    │                   │
                  │ dashboard / mail │                   │
                  └────────┬─────────┘                   │
                           ▼                             │
                  ┌──────────────────┐                   │
                  │ C1  http + app    │                   │
                  └────────┬─────────┘                   │
                           ▼                             │
                  ┌──────────────────┐                   │
                  │ C2  bootstrap +   │                   │
                  │ uploads + seed    │                   │
                  └────────┬─────────┘                   │
                           ▼                             │
                  ┌──────────────────┐                   │
                  │ C3/C4  routes     │                   │
                  └────────┬─────────┘                   │
                           ▼                             │
                  ┌──────────────────┐                   │
                  │ D1 primitives ─────► D2/D3 pages ───► D4 assets
                  └──────────────────┘                   │
                           ▼                             ▼
                  ┌──────────────────────────────────────────┐
                  │ E1–E6  suites, helpers, demo, report      │
                  └──────────────────────────────────────────┘
```

Two hard dependency edges that have already bitten:

1. **`app.js` imports eight route modules that do not exist.** Until C3/C4 land, nothing that imports
   `app.js` can be loaded — including any integration test that wants to drive the real HTTP surface.
   The whole E3 suite is blocked behind this.
2. **`tests/helpers/*` is a shared dependency of E1, E2 and E3.** It is owned by another workstream and
   must be frozen before the suites are written against it; the unit test delivered with this plan
   deliberately uses its own in-memory `DatabaseSync` handle to avoid depending on it.

---

## 4. Delivery stages

| Stage | Content | Entry condition | State |
|---|---|---|---|
| **S0 — Contracts** | A1 documents, schema, pragmas, migration runner | — | **Done** |
| **S1 — Domain core** | B1 domain modules; B2/B3 services | S0 | **Done** (with defects D-1, D-2, D-4 recorded) |
| **S2 — Analysis** | A2 matrix, A3 data model, booking rules, traceability test | S1 | **Done** (this delivery) |
| **S3 — Remaining services** | B4: inquiry, dashboard, admin users, mailer | S1 | **Not started** |
| **S4 — HTTP surface** | C2 bootstrap/uploads/seed, C3 public routes, C4 admin routes | S3 | **Not started** |
| **S5 — Experience** | D2/D3 pages, D4 assets | S4 | **Not started** |
| **S6 — Verification** | E1 concurrency suite, E2/E3 suites, E4 helpers, E5 demo script, E6 report | S4 (E1 needs only S1) | **Not started** |

Only stage S6's concurrency suite (`E1`) is independent of S3–S5: it needs the schema and the services
that already exist, and it is the highest-value outstanding work because it is the only thing that would
demonstrate the defining correctness property of the system end-to-end.

---

## 5. Integration order

1. **Freeze `tests/helpers/*`** (E4). Every other suite depends on it.
2. **Fix D-1 and D-2** (B2) before anything builds on maintenance or multi-day windows. D-1 makes
   `createMaintenanceBlock` throw on every call; D-2 makes `WEEK`/`MONTH` rentals unreachable.
3. **Land E1, the concurrency suite**, against the current schema. It needs no routes and no views, and it
   converts the system's central claim from an argument into evidence.
4. **Land B4** (inquiry, dashboard, mailer) and wire `rateLimit.enforcePublicInquiryLimits`,
   `enforceLoginLimits` and `requireCsrf`, all of which exist and are unused.
5. **Land C2**, which unblocks `npm start`, seeding and the first administrator.
6. **Land C3/C4 routes**, then D2/D3 pages, then D4 assets. Routes are thin: validate → service → respond,
   with the CSRF guard on every mutation.
7. **Land E3 integration tests** against the real HTTP surface; update `REQUIREMENT_TEST_MATRIX.md` statuses
   as each named test appears. `tests/unit/bookingRulesTraceability.test.js` must be re-run after any
   change to migrations, `time.js`, `pricingService.js` or `availabilityService.js`.
8. **Land E5/E6** — the double-booking demo script and `IMPLEMENTATION_REPORT.md`.

---

## 6. Known drift between the plan's documents and the repository

Documents that describe a system more complete than the one on disk, listed so the orchestrator is not
misled:

| Document | Claim | Reality |
|---|---|---|
| `ARCHITECTURE.md` §3 | `src/server/index.js`, `routes/`, `services/inquiry|dashboard|adminUsers`, `mail/`, `security/uploads`, `web/views/`, `web/public/`, `seed.js` all exist | None exist. |
| `ARCHITECTURE.md` §5 | "Evidence: `tests/concurrency/*` spawn real OS processes" | `tests/concurrency/` does not exist. |
| `ARCHITECTURE.md` §5 | "`scripts/demo-double-booking.js` reproduces the rejection for a live demo" | The file does not exist. `scripts/smoke-core.js` does, and passes. |
| `ARCHITECTURE.md` §2 | "see `IMPLEMENTATION_REPORT.md` for raw evidence" | The file does not exist. |
| `ARCHITECTURE.md` §7 | "`npm run admin:create` or `NAGARO_BOOTSTRAP_ADMIN_*`" | Neither path is implemented; `config.js` only reads the variables. |
| `API_CONTRACTS.md` §7 | "Every route below must exist" | Zero of ~45 routes exist. |
| `package.json` | `test`, `test:concurrency`, `test:all`, `seed`, `admin:create`, `demo:double-booking` | `npm test` fails (`tests/integration` missing); `seed`, `admin:create` and `demo:double-booking` point at absent files. |

**Recommendation to the orchestrator:** treat §13.2 of `REQUIREMENT_TEST_MATRIX.md` as the authoritative
list of claims that must not be repeated in a status report until the named files exist.

---

## 7. Definition of done for this system

1. `npm test` and `npm run test:concurrency` both pass on a clean checkout.
2. `tests/concurrency/` contains the 30 cases enumerated as `R-CONC-001`…`R-CONC-030`, and
   `REQUIREMENT_TEST_MATRIX.md` §5 rows move from `pending` to `implemented+tested`.
3. `tests/unit/bookingRulesTraceability.test.js` is green, and stays green after every migration —
   it is the tripwire on the triggers and on the documented pricing arithmetic.
4. `npm start` boots, `/` renders published spaces, `/admin` requires a session, and the first
   administrator can be created on an empty database.
5. Every row in `REQUIREMENT_TEST_MATRIX.md` is `implemented+tested` or explicitly justified as
   `manual` by design.
6. D-1, D-2, D-3, D-4 and D-5 are fixed or formally accepted, and the corresponding documents are
   updated in the same change.
