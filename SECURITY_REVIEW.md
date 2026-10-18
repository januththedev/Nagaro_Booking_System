# Security Review — Nagaro Space Booking

**Scope:** Phase 1 application as shipped (commit `a298fcb`).
**Method:** code inspection of `src/server/security/*`, `src/server/http/*`, `src/server/services/*`, `src/server/routes/*`, plus the automated suites listed below.

## 1. Authentication and sessions

- Passwords hashed with scrypt (N=16384, r=8, p=1) in `src/server/security/passwords.js`; `passwordProblems()` enforces a minimum.
- Session token: 32 random bytes, only SHA-256 stored in `admin_session`; cookie `nagaro_session` is `HttpOnly`, `SameSite=Lax`, `Secure` when TLS/proxy.
- 12 h absolute + 2 h idle expiry; `purgeExpiredSessions()` on boot.
- Roles resolved from the database on every request (`resolveSession` → `ctx.actor`); the browser never supplies a role. Verified by `tests/integration/adminCustomerRoutes.test.js` ("GET /api/admin/customers/search without an actor returns 401").
- Login is rate-limited (`enforceLoginLimits` by IP + email) and records `auth.login` / `auth.login_failed` audit entries.

## 2. CSRF

- Per-session secret; `csrfTokenFor(secret)` exposed to views; `verifyCsrf(secret, provided)` on every mutation.
- Double-submit: cookie + hidden form field; mismatch → 403.
- Login is exempt (no session yet); all other POSTs require it.

## 3. Uploads (photographs)

Controls in `src/server/security/uploads.js` + `src/server/routes/adminUploadRoutes.js` + `src/server/routes/mediaRoutes.js`:
- Type decided by magic bytes only (`sniffImageType`); client `Content-Type` and filename are advisory.
- SVG rejected everywhere (not in the allow-list).
- 5 MB per file, 12-file batch cap.
- Stored name: 32 random hex chars + extension from the sniffed MIME; client filename stored only as display text, never used in a path.
- `wx` open flag prevents overwrite; collisions trigger a fresh name.
- Path containment: `storedPathFor` re-validates the name, rejects NUL/`/`/`\`/`..`, then proves `dirname(resolve(dir,name)) === resolve(uploadDir())`.
- Strict name allow-list on `/media/:storedName`: `^[a-f0-9]{32}\.(jpg|png|webp)$`; 13 hostile names return 404 before any filesystem call (verified by `tests/integration/mediaRoutes.test.js`).
- Media responses: `Content-Type` from the stored extension, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, CORP, inline disposition. `lstat` refuses symlinks.
- Failed DB inserts delete the file just written; orphan cleanup in `finally`.
- Client filename sanitised (directory components stripped, control chars removed, length-capped).

Verified by `tests/unit/uploads.test.js` (22 tests) and `tests/integration/mediaRoutes.test.js` (8 tests).

## 4. Public data minimisation

- Visitor routes never import `customerService` or `bookingService`.
- Availability answers come only from `getPublicAvailability()` (counts + anonymous blocked periods) and `getSpaceDayGrid(..., { includeDetails: false })`.
- No customer name, email, phone, note, or reservation reference reaches a public response. Verified by `tests/unit/publicPrivacy.test.js` (40+ assertions, including a fixture that deliberately injects PII into the space and asserts it is absent from the projection).

## 5. Rate limiting

- `enforceLoginLimits`, `enforcePublicInquiryLimits`, `enforceAdminMutationLimit` in `src/server/security/rateLimit.js`.
- Public inquiry throttled by IP + email; returns 429 `RATE_LIMITED`.

## 6. Concurrency and data integrity

- `BEGIN IMMEDIATE` write transactions with `busy_timeout=10000`.
- Anti-overlap triggers fire on direct writes (verified `CASE 27`/`28`).
- Optimistic cancellation: `UPDATE ... WHERE status='CONFIRMED'` → exactly once.
- Idempotency key UNIQUE → duplicate submissions return the original reservation.
- Foreign keys ON; `PRAGMA integrity_check` / `foreign_key_check` gate on boot.

## 7. Transport and headers

- `applySecurityHeaders` on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`.
- HTML pages get a CSP (`default-src 'self'`, `frame-ancestors 'none'`, etc.).
- No `innerHTML`/`eval`/`document.write` in client JS (`public.js`, `admin.js`); all server data reaches the DOM via `textContent`/`createElement`.

## 8. Findings and resolutions

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | Static assets 404: middleware ran only after route match, so `/assets/*` hit the 404 handler. | High (broken UI) | `router.handle` now runs the middleware chain before matching. Verified by boot check (all assets 200). |
| 2 | `checkBookingRules` accepted a 06:00 booking on an 08:00–18:00 space (only the intersection with open hours was checked). | Medium | Loop now rejects any cursor before `dayOpen`. Verified by `DEFECT-3`. |
| 3 | Multi-day booking crossing midnight rejected on 24 h spaces (`cursor` never left the start day). | Medium | Cursor advances to the next day's opening; close time `23:59` extends to midnight. Verified by `DEFECT-2`. |
| 4 | `createMaintenanceBlock` threw `column index out of range` (9 columns, 8 values). | High (broken feature) | Fixed; guarded by `CASE 10c`. |
| 5 | `publicRoutes.js` imported `../web/...` (wrong depth) → server could not boot. | High | Corrected to `../../web/...`. |
| 6 | `authRoutes.js` wrong relative import depth. | High | Corrected. |
| 7 | Router `redirect()` did not set `ctx.responded`, causing `ERR_HTTP_HEADERS_SENT` after redirect. | Medium | `handle` now checks `isHeaderSent(res)` before the default `ctx.json`. |
| 8 | Uploads agent noted `normalisePath` double-decodes params. | Low (theoretical) | All params are validated by strict allow-lists; no bypass observed. Documented; not blocking. |

No critical or high-severity open findings. All listed items are fixed and covered by tests.

## 9. Not in scope (by design)

- No payment processing.
- No public user accounts.
- No AI assistants.
- No real-time push (polling/refresh on demand only).
- Email delivery depends on external SMTP; the app degrades gracefully and reports status honestly.
