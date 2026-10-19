# Progress / Resumption Log — Nagaro Space Booking

Last updated: 2026-10-19

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
9. **Readiness pass (this pass; see `FINAL_READINESS_REPORT.md`)** — independently re-verified
   the state above, then fixed four release-affecting defects and produced the presentation pack:
   - `.detail-list` collapsed to one character per line inside narrow cards (public sidebar,
     inquiry preview, admin detail panels) — root-caused to a fixed `minmax(10rem, 14rem)` label
     track and made container-relative; regression test added
     (`tests/unit/detailListLayout.test.js`).
   - `.data-table` cells used `overflow-wrap: anywhere`, shredding names mid-word
     (`Acaci / a Train / ing Roo / m`); switched to `break-word` so tables scroll in the
     already-focusable `.table-wrap` instead of squeezing columns below legibility.
   - `scripts/e2e-verify.js` probed availability at `now + 30 days`, which preserved the current
     time of day and therefore failed outside 08:00–18:00 SLST — a genuine reproducibility bug.
     Replaced with a deterministic 10:00–12:00 SLST probe.
   - `tools/node.cmd`, `tools/npm.cmd`, `tools/git.cmd` hardcoded another machine's paths; they now
     resolve `%NAGARO_NODE%`/`%NAGARO_GIT%` or `PATH` and report an actionable error.
   - Presentation pack added: `PRESENTATION.md` and `presentation/slides.html`.
   - Local demo database reseeded so demo data is Colombo-localised (Sri Lankan names, `+94`
     numbers, `LKR`); previous file backed up inside the gitignored `data/`.
10. **TRACE Spaces experience + public checkout** — rebuilt the public journey around official
    TRACE imagery with a responsive editorial landing page, progressive native WebGL ambience,
    catalogue/detail/checkout/confirmation/management surfaces and a coordinated admin/auth visual
    system. Public checkout now creates confirmed reservations through the canonical transactional
    booking engine, hashes private management capabilities, supports safe cancellation, records an
    auditable `PUBLIC` channel and keeps customer/internal data out of public projections. Official
    media sources and usage notes are recorded in `src/web/public/trace-media/research/PROVENANCE.md`.

## Test evidence (final)

- 2026-10-19 full suite (`unit + integration + concurrency`) → **244/244 pass**. This includes
  real multi-process races, public-checkout capability/privacy tests and transaction rollback tests.
- Browser verification at 390, 768 and 1280 CSS px → no horizontal overflow or console errors on
  landing, catalogue, checkout or authentication; WebGL initialized; labels, alt text, language and
  single-H1 structure verified.

- `npm test` → **192/192 pass** (unit + integration; 190 pre-existing + 2 new regression tests)
- `npm run test:concurrency` → **37/37 pass**
- `npm run test:e2e` → **63/63 pass**
- **Total: 292/292 pass**

New coverage added in the first verification pass: `tests/unit/businessTimeZone.test.js`,
`tests/integration/businessTimeZone.test.js`, `tests/unit/seedSceneImages.test.js`.
New coverage added in the readiness pass: `tests/unit/detailListLayout.test.js` (2 tests).

## Verification performed in the first verification pass

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
3. **Production deployment** — the current synchronous Node/SQLite runtime is not compatible with
   Sites' Worker/D1 target or durable serverless hosting. No `.openai/hosting.json` is present. A
   PostgreSQL/D1 adapter, production secrets and provider credentials are required before deployment;
   `vercel.json` is not yet added.
4. **Live SMTP** — no `SMTP_HOST`; email status reports `NOT_CONFIGURED` honestly.
5. **PostgreSQL concurrency tests** — require a live PG instance; the SQLite concurrency suite
   (37 tests) remains the regression reference.

## Environment note

- **Screenshots are capturable in this environment as of the readiness pass.** Real captures of the
  running application were taken and stored in `artifacts/presentation/` (15 native-viewport
  screenshots plus 8 width-pinned responsive renders; deliberately gitignored because they are large
  binaries). No screenshot is fabricated or retouched.
- **The tab viewport is fixed at 912×670** and the browser tooling exposes no device emulation, so
  exact-width 1440/768/390 *native* screenshots are impossible. Responsive verification is done by
  rendering each route inside a width-pinned document at the true target width — real CSS layout and
  real measurements — which is also how the `responsive/` images are produced.
- Earlier passes did browser verification through navigation, accessibility snapshots, DOM and
  computed-style inspection, console/network capture, and iframe-pinned viewport measurement.

## Next actions (when credentials are available)

1. Provision Supabase project + Blob store.
2. Run the PG migration; verify with `psql`.
3. Implement the async DB adapter behind `DATABASE_URL` (convert services from sync `db.prepare` to
   async `pg` queries); keep SQLite path for tests.
4. Port the concurrency suite to PG and run it.
5. Add `vercel.json`; deploy and verify health endpoint.
6. Run the e2e harness against the deployed URL.
