# Progress / Resumption Log — Nagaro Space Booking

Last updated: 2026-10-18

## Completed milestones

1. **Audit** — `AUDIT_REPORT.md` written. All reported test counts reproduced (176 unit/integration,
   37 concurrency, 63 e2e = 276, 0 failures).
2. **Defects fixed** — router static-asset ordering, `checkBookingRules` (before-opening +
   cross-midnight), import depths, redirect `ctx.responded`, maintenance block column mismatch,
   Blob schema columns.
3. **PostgreSQL migration SQL** — `db/migrations-postgres/0001_init.sql` (full schema, FKs, check
   constraints, GiST exclusion constraint for non-overlap, desk-pool via resource_unit rows).
4. **Vercel Blob integration** — `src/server/security/blobStorage.js` (conditional on
   `BLOB_READ_WRITE_TOKEN`), `uploads.js` branches to Blob, `spaceService` persists
   `blob_url`/`blob_pathname`, `listImages` uses Blob URL when present, `adminUploadRoutes` deletes
   Blob on removal.
5. **SQLite migration** — `src/server/db/migrations/0002_blob_columns.sql` adds `blob_url`,
   `blob_pathname` to `space_image`.
6. **Docs** — `ARCHITECTURE.md` §13 (target production architecture), `.env.example` updated with
   `DATABASE_URL`/`DIRECT_URL`/`BLOB_READ_WRITE_TOKEN`, `AUDIT_REPORT.md`, `SECURITY_REVIEW.md`,
   `IMPLEMENTATION_REPORT.md`.
7. **Phase 2 visual redesign** — editorial public site and operations console; demo imagery replaced
   with a deterministic in-process renderer; temporary preview artifacts removed (`8c95e97`).
8. **Independent verification/repair pass (this pass)** — location/time-zone/currency corrected to
   Colombo, Sri Lanka; CSP tightened back to `style-src 'self'`; mobile overflow, footer contrast,
   heading-order and gallery-label defects fixed; `npm test` fixed for Node ≥ 22; docs reconciled.
   See `UI_UX_IMPLEMENTATION_REPORT.md` for the full record.

## Test evidence (final)

- `npm test` → **190/190 pass** (unit + integration)
- `npm run test:concurrency` → **37/37 pass**
- `npm run test:e2e` → **63/63 pass**
- **Total: 290/290 pass**

New coverage added this pass: `tests/unit/businessTimeZone.test.js`,
`tests/integration/businessTimeZone.test.js`, `tests/unit/seedSceneImages.test.js`.

## Verification performed this pass

- Real Chromium browser against the production entry point on an **isolated** throwaway database and
  upload directory (`%TEMP%\opencode\nagaro-qa\`), seeded with `--demo`. Production data untouched.
- Responsive layout measured natively at 390 / 768 / 1440 CSS px for every public and admin route —
  **54 route × width combinations, 0 page-level overflow, 0 console errors/warnings**.
- Lighthouse accessibility **1.00 on every audited route**; no remaining accessibility failures.
- Location/time-zone/currency root-cause correction verified end-to-end (public request stored as the
  correct SLST→UTC instant; no confirmed reservation created).
- Imagery verified: valid 800×500 PNGs, correct MIME, category mapping, cover/alternate swap,
  empty-state fallback, deterministic rendering, seeding-only generation.

## Git

- Remote: https://github.com/januththedev/Nagaro_Booking_System
- Branch: main
- Latest commit: see `git log --oneline -1`

## Remaining external blockers (cannot be completed without credentials)

1. **Supabase PostgreSQL** — no `DATABASE_URL`/`DIRECT_URL`/`SUPABASE_*` and no `psql`/`supabase` CLI.
   The application still runs on SQLite. To complete: provision a Supabase project, run
   `db/migrations-postgres/0001_init.sql`, set `DATABASE_URL`/`DIRECT_URL`, and implement the async
   `pg`-based adapter (the codebase is currently synchronous on `node:sqlite`; converting every service
   to async is the remaining engineering work). SQLite remains the dev/test default.
2. **Vercel Blob** — no `BLOB_READ_WRITE_TOKEN` and no Vercel CLI. Blob code is implemented but
   untested against a live store.
3. **Vercel deployment** — no CLI/credentials. App is deployable via `vercel deploy` once env vars are
   set; `vercel.json` not yet added.
4. **Live SMTP** — no `SMTP_HOST`; email status reports `NOT_CONFIGURED` honestly.
5. **PostgreSQL concurrency tests** — require a live PG instance; the SQLite concurrency suite
   (37 tests) remains the regression reference.

## Environment note

- **Screenshots are not capturable in this environment** (the browser tooling needs a visible desktop
  window). Browser verification was therefore done through navigation, accessibility snapshots, DOM
  and computed-style inspection, console/network capture, Lighthouse, and native iframe-pinned
  viewport measurement. No before/after screenshots are fabricated.

## Next actions (when credentials are available)

1. Provision Supabase project + Blob store.
2. Run the PG migration; verify with `psql`.
3. Implement the async DB adapter behind `DATABASE_URL` (convert services from sync `db.prepare` to
   async `pg` queries); keep SQLite path for tests.
4. Port the concurrency suite to PG and run it.
5. Add `vercel.json`; deploy and verify health endpoint.
6. Run the e2e harness against the deployed URL.
