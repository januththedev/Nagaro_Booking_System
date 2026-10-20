# Nagaro Space Booking System

A centralized space-booking and rental-management system for Nagaro at **Trace Expert City**, Maradana, Colombo, Sri Lanka. It replaces an Excel-based process that caused double bookings, missed inquiries and no shared view of availability.

Two experiences:

- **Public** — visitors browse published spaces, check live availability, and either confirm a guest reservation immediately or send a concierge inquiry for a complex event. No account or online payment is required; confirmed checkouts receive a private management link.
- **Administrative** — staff manage spaces, photographs, customers, reservations, cancellations, maintenance and inquiries from one place.

Three space categories are supported: **meeting/training rooms**, the **auditorium**, and **co-working desks** (individually bookable).

## The defining property

Two overlapping confirmed reservations for the same single-capacity resource can never both commit. This is enforced by the database itself, not by the user interface:

1. every booking mutation runs inside `BEGIN IMMEDIATE`, so availability is re-checked while holding SQLite's write lock;
2. `occupancy` table triggers raise `DOUBLE_BOOKING_CONFLICT` on any overlapping `ACTIVE` row, for every code path including future ones;
3. unique constraints plus an optimistic `UPDATE ... WHERE status = 'CONFIRMED'` make retries and cancellations exactly-once.

See `ARCHITECTURE.md` §5 and `DATA_MODEL.md` for the full mechanism, and `tests/concurrency/` for the multi-process proof.

## Requirements

- **Node.js 22.5 or newer** (uses the built-in `node:sqlite` module — Node 24 recommended and tested)
- npm
- No PostgreSQL, no Docker, no build step, no native compilation

## Getting started

```bash
npm install                 # one dependency: nodemailer
cp .env.example .env        # optional; sensible defaults work without it
npm run migrate             # create/upgrade the database schema
npm run seed -- --demo      # optional: demonstration catalogue, customers and bookings
npm start                   # http://127.0.0.1:4173
```

### Running the Next.js public frontend

The public pages can be rendered by the Next.js app in `apps/public-web` while the Node runtime
keeps the public port. One origin, two owners — see `ARCHITECTURE.md` §12.

```bash
npm install                            # installs backend + the public-web workspace
npm run build:public                   # production build of the public app
npm run dev:full                       # Node on :4173 + `next dev` on :4174, one public origin
# or, against the production build:
npm run start:full                     # Node on :4173 + `next start` on :4174
```

Open `http://127.0.0.1:4173`. Pages come from Next; `/api/*`, `/admin/*`, `/assets/*`, `/media/*`
and the no-JavaScript form posts stay in the booking runtime. Rolling back is configuration only:

```bash
# legacy renderer, no Next process needed
PUBLIC_FRONTEND=legacy npm start
```

`npm run test:cutover` verifies the split end to end (which process answered, form fallbacks,
capability headers, legacy rollback).

### Creating the first administrator

Either set both `NAGARO_BOOTSTRAP_ADMIN_EMAIL` and `NAGARO_BOOTSTRAP_ADMIN_PASSWORD`
before the first boot (ignored once any administrator exists), or run:

```bash
npm run admin:create -- --email ops@nagaro.example --name "Ops Lead" --role ADMIN
```

The password is read from the prompt, `--password`, or `NAGARO_NEW_ADMIN_PASSWORD`.
`--demo` seeding creates `admin@nagaro.local` / `NagaroDemo2026` — **development only**.

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with `--watch` |
| `npm run migrate` | Apply pending migrations |
| `npm run seed` | Seed the catalogue (`-- --demo` adds demo bookings and inquiries) |
| `npm run provision:postgres` | Migrate Supabase, create the first admin if needed, and seed the production catalogue |
| `npm run verify:vercel` | Validate the checked-in Vercel layout (`-- --require-env` also checks connected environment names) |
| `npm run admin:create` | Provision a staff account |
| `npm test` | Unit + integration tests |
| `npm run test:concurrency` | Multi-process booking-integrity tests (slower) |
| `npm run test:e2e` | End-to-end acceptance harness (real forms, CSRF, upload) |
| `npm run test:public` | Next.js public app suite (config, quote parity with the engine, surface guards) |
| `npm run test:cutover` | Boots Node + `next start` and verifies the same-origin split and the legacy rollback |
| `npm run test:all` | Everything |
| `npm run test:full` | Every suite incl. the frontend and the cut-over harness |
| `npm run dev:full` / `npm run start:full` | Run the whole stack (Node + Next) on one public origin |
| `npm run demo:double-booking` | Live demonstration that conflicting bookings are refused |

## Demonstrating the double-booking rejection

```bash
npm run demo:double-booking
```

The script creates a temporary database, books a room, shows a single-process overlap
being refused, then races **six real operating-system processes** for the identical
window and prints each process's outcome. It asserts that exactly one confirmed
reservation exists for that period and exits non-zero if the guarantee is violated.

## Layout

```
src/server/    HTTP layer, domain rules, business services, security, routes, migrations
src/web/       server-rendered views (legacy renderer and admin console), static CSS/JS
apps/public-web/ Next.js public frontend (landing, catalogue, checkout, management, concierge)
tests/         unit, integration and concurrency suites
scripts/       database provisioning, inspection, the demo and the acceptance harnesses
storage/       uploaded space photographs (created at runtime, not committed)
data/          the SQLite database (created at runtime, not committed)
```

## Documentation

| File | Contents |
|---|---|
| `ARCHITECTURE.md` | Stack decisions, layering, the concurrency mechanism, security model, environment variables |
| `DATA_MODEL.md` | Tables, relationships, constraints, indexes, retention and the concurrency proof |
| `API_CONTRACTS.md` | Frozen shared vocabulary, service signatures, object shapes, route inventory, error codes |
| `docs/BOOKING_RULES.md` | Business rules in plain language, plus every documented assumption |
| `docs/IMAGE_PROVENANCE.md` | Where demo imagery comes from and why it is not a photograph of the venue |
| `REQUIREMENT_TEST_MATRIX.md` | Requirement → implementation → test traceability |
| `SECURITY_REVIEW.md` | Security findings and their resolution |
| `docs/UX_GUIDE.md` | Palette, contrast ratios, breakpoints, client-side feature contracts |
| `IMPLEMENTATION_REPORT.md` | What was delivered, how it was verified, what remains |
| `USER_STORIES.md` | User stories by epic and role, with priority and implementation status |
| `ACCEPTANCE_CRITERIA.md` | Measurable, independently testable acceptance criteria (`AC-*`) for every story |
| `USER_STORY_TRACEABILITY.md` | Per-criterion story → implementation → test matrix, evidence-graded |
| `REQUIREMENTS_IMPLEMENTATION_REPORT.md` | Summary of completed, partial, unverified and unimplemented requirements |
| `FINAL_READINESS_REPORT.md` | Release-readiness verdict and the local demo boundary |
| `PRESENTATION.md` | 10-slide presentation outline, speaker script and demo run-sheet |
| `presentation/slides.html` | Self-contained 10-slide deck (screenshots in `presentation/assets/`) |
| `PUBLIC_FRONTEND_REPORT.md` | The Next.js public frontend: what changed, how it was verified, rollback, limitations |
| `VERCEL_DEPLOYMENT.md` | Supabase, Vercel Blob, environment variables and deployment smoke-test checklist |

## Project status

**Deployment-ready, but not yet connected to live infrastructure.** Local
development continues to use SQLite and local uploads. Vercel production uses
the checked-in serverless entry point with Supabase PostgreSQL and Vercel Blob
when `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are configured. No live project
credentials are committed, so the final hosted smoke test must be run after the
Vercel integrations are connected. See `VERCEL_DEPLOYMENT.md` for the exact
environment and migration checklist.

## Configuration

Everything is environment-driven; see `.env.example` for the full annotated list.
Production deployment values are listed in `VERCEL_DEPLOYMENT.md`. The two that
matter most in every environment:

- **Email.** Set `SMTP_HOST` (and friends) to deliver booking inquiries by email.
  Without it the system still saves every inquiry and records `email_status` as
  `NOT_CONFIGURED`. It never reports an undelivered email as sent.
- **`NAGARO_IP_SALT`.** Set a long random value in production; it salts the hashed
  IP addresses kept in the audit log and the rate limiter.

## Time zone

Timestamps are stored in UTC and every local calculation pins the business zone to
`Asia/Colombo` — Sri Lanka Standard Time (UTC+05:30, no daylight saving). The
server's own time zone is never used, so the application behaves identically
wherever it runs.
