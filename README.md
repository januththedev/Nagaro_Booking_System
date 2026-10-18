# Nagaro Space Booking System

A centralized space-booking and rental-management system for Nagaro at **Trace Expert City**, Maradana, Colombo, Sri Lanka. It replaces an Excel-based process that caused double bookings, missed inquiries and no shared view of availability.

Two experiences:

- **Public** — visitors browse published spaces, check provisional availability for a period, and submit a request-to-book inquiry. No accounts, no payments, no self-service confirmed reservations.
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
| `npm run admin:create` | Provision a staff account |
| `npm test` | Unit + integration tests |
| `npm run test:concurrency` | Multi-process booking-integrity tests (slower) |
| `npm run test:e2e` | End-to-end acceptance harness (real forms, CSRF, upload) |
| `npm run test:all` | Everything |
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
src/web/       server-rendered views, HTML primitives, static CSS/JS
tests/         unit, integration and concurrency suites
scripts/       database provisioning, inspection and the demo
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

## Configuration

Everything is environment-driven; see `.env.example` for the full annotated list.
The two that matter most operationally:

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
