# Requirement → Test Traceability Matrix

**System:** Nagaro Space Booking System (`D:\Nagaro_Bookinag_System`)
**Requirement ID scheme:** `R-<area>-<n>`, defined in `API_CONTRACTS.md` §9.
**Compiled:** 18 October 2026, from the repository as it stands — every row was checked by opening the
named file. Nothing is marked as tested on the strength of a comment, a doc or an intention.

> **Historical snapshot — read the banner first.** This matrix was compiled against an early commit
> (`a298fcb`) when the routes, views, services and test directories did not yet exist. The rows below
> describe that state honestly and are **not** a current assessment. Subsequent commits —
> `602c9a7`, `43432d1`, `744799b`, `8c95e97` and the Phase 2 verification pass — implemented almost
> everything listed as `Absent`/`pending`/`not-started`. The current picture is:
>
> - **Test evidence:** unit + integration **190/190**, concurrency **37/37**, end-to-end **63/63**
>   (**290/290 pass**) — `npm test`, `npm run test:concurrency`, `npm run test:e2e`.
> - **Locale corrected:** the venue is TRACE Expert City, **Colombo, Sri Lanka**; business zone
>   `Asia/Colombo` (UTC+05:30), currency **`LKR`**. Any earlier `EAT`/`ETB`/Addis reference here has
>   been corrected.
> - **Current verification:** every public and admin route was driven in a real browser, with
>   responsive layout measured at 390/768/1440 px and Lighthouse accessibility 1.00 across audited
>   routes. See `UI_UX_IMPLEMENTATION_REPORT.md` and `AUDIT_REPORT.md` §12.
>
> **18 October 2026 addendum.** The rows below are unchanged. Requirements are now also expressed as
> `US-*` user stories and `AC-*` acceptance criteria in `USER_STORIES.md` and
> `ACCEPTANCE_CRITERIA.md`, with an evidence-graded status per criterion in
> `USER_STORY_TRACEABILITY.md`. Section 14 links the two vocabularies. Note that the **Lighthouse
> accessibility 1.00** figure above is a claim from that earlier pass: no accessibility audit was run
> in the 18 October pass, so it is not re-verified here (see US-58).

## How to read this matrix

### Status vocabulary (exactly one per row)

| Status | Meaning |
|---|---|
| `implemented+tested` | The behaviour exists **and** a named test in a file I opened asserts it. |
| `implemented` | The behaviour exists in shipped source. No automated test asserts it yet. |
| `pending` | Part of the work exists but the requirement cannot be exercised end-to-end — a route, a view, a service or a scheduler is missing — or it is explicitly scheduled and not yet built. |
| `not-started` | Nothing in the repository implements it. |

### Verification-method vocabulary

`automated` · `demo script` (an existing runnable script whose output demonstrates the behaviour) ·
`manual` (a person must perform the steps). Rows that will be automated later say
`automated (planned)`; rows that a scheduled demo script will cover say `demo script (planned)`.

### Repositories of evidence

| Artefact | What it is |
|---|---|
| `src/server/db/migrations/0001_init.sql` | The complete schema, including both anti-overlap triggers. |
| `src/server/services/*.js` | Six services present: `booking`, `availability`, `pricing`, `space`, `customer`, `audit`. |
| `src/server/domain/*.js` | Pure helpers: `constants`, `time`, `validation`, `errors`, `references`. |
| `src/server/security/*.js` | `passwords` (scrypt), `sessions` (hashed tokens, CSRF), `rateLimit`. |
| `src/server/http/*.js`, `src/server/app.js` | Router, request/response helpers, security headers, middleware chain, error boundary. |
| `src/web/lib/html.js`, `src/web/views/layout.js` | Escaping, formatting helpers and the two page shells. |
| `scripts/smoke-core.js` | Runnable end-to-end demonstration. **Executed for this matrix; output: `SMOKE CORE: PASS`.** |
| `tests/unit/bookingRulesTraceability.test.js` | The only test file in the repository (authored with this matrix). |
| **Absent at audit time** (all now present) | `src/server/index.js`, `src/server/routes/*`, `src/server/mail/mailer.js`, `src/server/security/uploads.js`, `src/server/services/inquiryService.js`, `dashboardService.js`, `adminUserService.js`, `src/web/views/*`, `src/web/public/*`, `src/server/db/seed.js`, `scripts/create-admin.js`, `scripts/demo-double-booking.js`, `tests/concurrency/*`, and the remaining test directories. |

> `package.json` declares scripts for `seed`, `admin:create`, `demo:double-booking` and the three test
> directories. **None of those targets exist yet.** Any row whose only path to verification is one of them
> is marked `not-started` or `pending`, never `implemented`.

---

## 1. Space management — `R-SPACE-*`

| ID | Requirement | Source | Implementation (file + symbol) | Test (file + test name) | Verification | Status |
|---|---|---|---|---|---|---|
| R-SPACE-001 | Create a space with name, code, category, capacity, location; it starts as `DRAFT` | Space management | `spaceService.js` → `createSpace` | — | demo script — `scripts/smoke-core.js` (creates `TRC-MR-01` and `TRC-CW-01`) | implemented |
| R-SPACE-002 | Space code is unique case-insensitively; a duplicate is refused with `CONFLICT` | Space management | `spaceService.js` → `createSpace`, `updateSpace`; `0001_init.sql` → `space.code UNIQUE COLLATE NOCASE` | — | manual | implemented |
| R-SPACE-003 | Edit a space; only supplied fields change | Space management | `spaceService.js` → `updateSpace` | — | manual | implemented |
| R-SPACE-004 | Category-specific attribute fields are collected without forcing irrelevant inputs | Space management | `validation.js` → `parseSpacePayload`, `normalizeAttributes` | — | manual | implemented |
| R-SPACE-005 | Only pricing units permitted for the category may be configured | Space management | `constants.js` → `ALLOWED_PRICING_UNITS`; `validation.js` → `parseSpacePayload` | — | demo script — `scripts/smoke-core.js` (HOUR+DAY for a room, DAY+MONTH for co-working) | implemented |
| R-SPACE-006 | Opening hours are validated (`close_time` strictly after `open_time`); defaults 08:00–18:00 | Space management | `validation.js` → `parseSpacePayload`; `spaceService.js` → `createSpace` | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-004 opening hours are enforced in Sri Lanka Standard Time` (enforcement side) | manual | implemented |
| R-SPACE-007 | `buffer_minutes` is configurable, 0–240 | Space management | `validation.js` → `parseSpacePayload` (min 0, max 240); schema `CHECK (buffer_minutes >= 0)` | — | manual | implemented |
| R-SPACE-008 | Minimum duration ≥ 15 min; maximum unset or 15–129,600 min and never below the minimum | Space management | `validation.js` → `parseSpacePayload`; `availabilityService.js` → `checkBookingRules` | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-005 …` and `R-AVAIL-006 …` | automated (planned) | implemented |
| R-SPACE-009 | Capacity is required and at least 1 | Space management | `validation.js` → `parseSpacePayload`; schema `CHECK (capacity >= 1)` | — | manual | implemented |
| R-SPACE-010 | Publishing is blocked until the publish checklist is satisfied — **at least one photograph**, a ≥20-character description, a short summary, a location, at least one rate, at least one unit | Space management | `spaceService.js` → `publishabilityIssues`, `publishSpace` | — | manual (verified by hand: `publishabilityIssues` returns `['At least one photograph is required before publishing.']` for an image-free space) | implemented |
| R-SPACE-011 | Publishing sets `published_at` once (`COALESCE`) and clears `archived_at` | Space management | `spaceService.js` → `publishSpace` | — | manual | implemented |
| R-SPACE-012 | Unpublish returns a space to `DRAFT` | Space management | `spaceService.js` → `unpublishSpace` | — | manual | implemented |
| R-SPACE-013 | Archive sets `archived_at` and reports how much upcoming occupancy the space still has | Space management | `spaceService.js` → `archiveSpace` | — | manual | implemented |
| R-SPACE-014 | Restore returns an archived space to `DRAFT` (never straight to `PUBLISHED`) | Space management | `spaceService.js` → `restoreSpace` | — | manual | implemented |
| R-SPACE-015 | A space may have more than one photograph and each is addressable at `/media/<storedName>` | Space management | `spaceService.js` → `listImages` (`url: '/media/<storedName>'`); `addImageRecord` | — | manual | implemented |
| R-SPACE-016 | At most 12 photographs per space; the first upload becomes the cover | Space management | `spaceService.js` → `addImageRecord`; `validation.js` → `LIMITS.maxImagesPerSpace` | — | manual | implemented |
| R-SPACE-017 | At most one cover photograph per space, enforced by the database | Space management | `0001_init.sql` → `CREATE UNIQUE INDEX ux_image_cover … WHERE is_cover = 1`; `spaceService.js` → `setCoverImage` | — | manual (rejected with `UNIQUE constraint failed: space_image.space_id` in a live probe; see `DATA_MODEL.md` §9.3) | implemented |
| R-SPACE-018 | Reordering photographs requires a complete permutation; partial lists are refused | Space management | `spaceService.js` → `reorderImages` | — | manual | implemented |
| R-SPACE-019 | Removing the cover promotes the next photograph in the same transaction | Space management | `spaceService.js` → `deleteImage` | — | manual | implemented |
| R-SPACE-020 | Uploads are accepted only as JPEG/PNG/WebP up to 5 MB, typed from the bytes, never from the client's filename; SVG is refused | Space management | `validation.js` → `sniffImageType`, `assertUploadableImage`, `LIMITS` | — | manual | implemented |
| R-SPACE-021 | Rates are stored per pricing unit in cents with exactly one default | Space management | `spaceService.js` → `normaliseRates`, `persistRates`; `pricingService.js` → `loadRates` | — | demo script — `scripts/smoke-core.js` prints `rates: {"HOUR":150000,"DAY":900000}` | implemented |
| R-SPACE-022 | Increasing desk inventory creates new `DESK` units without disturbing existing ones | Space management | `spaceService.js` → `syncUnits`, `setDeskCount` | — | demo script — `scripts/smoke-core.js` (`desk space units: 20`) | implemented |
| R-SPACE-023 | Decreasing desk inventory creates no units and deactivates from the end of the code ordering | Space management | `spaceService.js` → `syncUnits` | — | manual | implemented |
| R-SPACE-024 | Removing a desk that holds `ACTIVE` occupancy is refused with an explanatory conflict | Space management | `spaceService.js` → `syncUnits` | — | manual (live probe: `Cannot remove 10 desks (DESK-11, …, DESK-20): they hold confirmed or upcoming occupancy.`) | implemented |
| R-SPACE-025 | A meeting room or auditorium always has exactly one `EXCLUSIVE` unit | Space management | `spaceService.js` → `createSpace`, `unitKindFor` | — | demo script — `scripts/smoke-core.js` (`units: 1`) | implemented |
| R-SPACE-026 | Changing a space's category is refused while it has active occupancy | Space management | `spaceService.js` → `updateSpace` | — | manual | implemented |
| R-SPACE-027 | Admin space list supports status, category, text search, sort and pagination | Space management | `spaceService.js` → `listSpaces` | — | manual | implemented |
| R-SPACE-028 | Space create/edit/publish/archive/restore are reachable as HTTP routes | Space management | **missing** — `src/server/routes/adminSpaceRoutes.js` is imported by `app.js` but does not exist | — | manual (planned) | not-started |
| R-SPACE-029 | Photograph upload/reorder/cover/delete are reachable as HTTP routes with CSRF | Space management | **missing** — `src/server/routes/adminUploadRoutes.js` and `src/server/security/uploads.js` do not exist | — | manual (planned) | not-started |

## 2. Public discovery — `R-PUB-*`

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-PUB-001 | Only `PUBLISHED` spaces appear in public listings and JSON | Public discovery | **missing** — `src/server/routes/publicRoutes.js` does not exist. The predicate itself exists (`spaceService.listSpaces({ status: 'PUBLISHED' })`, `availabilityService.getPublicAvailability` rejects non-published) | — | manual (planned) | pending |
| R-PUB-002 | A `DRAFT` space returns 404 on public routes | Public discovery | `availabilityService.js` → `getPublicAvailability` throws `notFound` for non-published spaces. **No public route exists to return the 404.** | — | manual (planned) | pending |
| R-PUB-003 | An `ARCHIVED` space returns 404 on public routes | Public discovery | as R-PUB-002 (`getPublicAvailability` rejects any status that is not `PUBLISHED`) | — | manual (planned) | pending |
| R-PUB-004 | Public directory can be filtered by category | Public discovery | `spaceService.js` → `listSpaces` supports `category` | — | manual (planned) | pending |
| R-PUB-005 | Public directory can be filtered by free text (name, code, location, summary) | Public discovery | `spaceService.js` → `listSpaces` supports `search` | — | manual (planned) | pending |
| R-PUB-006 | Public directory can be filtered by amenity | Public discovery | **missing** — `listSpaces` has no amenity filter; amenities are stored as a JSON array and can only be filtered by a scan | — | manual (planned) | pending |
| R-PUB-007 | Space detail page shows gallery, amenities, category attributes, rates and an availability checker | Public discovery | **missing** — `src/web/views/` contains only `layout.js` | — | manual (planned) | not-started |
| R-PUB-008 | Availability shown publicly is described as provisional and confirmed only by staff | Public discovery | `layout.js` → `publicShell` footer states "Availability shown on this site is provisional…"; `getPublicAvailability` returns `provisional: true` | — | manual | implemented |
| R-PUB-009 | No customer data ever appears in a public response | Public discovery | `availabilityService.js` → `getPublicAvailability` projects only counts and anonymous `blockedPeriods`; `API_CONTRACTS.md` §4 forbids extending it | — | manual (code inspection: the returned object contains no `customerName`, `reservationReference` or `internalNotes`) | implemented |
| R-PUB-010 | Landing page shows hero, category entry points and featured published spaces | Public discovery | **missing** — no routes, no views | — | manual (planned) | not-started |
| R-PUB-011 | `/api/public/spaces` and `/api/public/spaces/:code` return published spaces with no PII | Public discovery | **missing** — `src/server/routes/publicRoutes.js` does not exist | — | automated (planned) | not-started |
| R-PUB-012 | `/api/public/availability` returns counts only for a requested window and desk count | Public discovery | `availabilityService.js` → `getPublicAvailability`; **the route does not exist** | — | automated (planned) | pending |
| R-PUB-013 | `/api/public/availability/day` returns hourly slots for one day | Public discovery | `availabilityService.js` → `getSpaceDayGrid`; **the route does not exist** | — | automated (planned) | pending |
| R-PUB-014 | `/booking-request` can be pre-filled from `?space=&date=&start=&end=` | Public discovery | **missing** — no route, no view | — | manual (planned) | not-started |
| R-PUB-015 | `/media/:storedName` serves a validated stored name with inert headers | Public discovery | `response.js` → `applySecurityHeaders({ isMedia: true })` exists; **the route and its name regex do not exist** | — | automated (planned) | pending |

## 3. Availability — `R-AVAIL-*`

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-AVAIL-001 | Intervals are half-open `[start, end)` | Availability | `time.js` → `intervalsOverlap`; migration header comment | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-001/002 half-open conflict predicate matches intervalsOverlap across an interval matrix` | automated | implemented+tested |
| R-AVAIL-002 | The conflict predicate is exactly `a.start < b.end AND a.end > b.start` | Availability | `availabilityService.js` → `findConflicts`, `inspectUnits`; `time.js` → `intervalsOverlap`; both triggers | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-001/002 …` | automated | implemented+tested |
| R-AVAIL-003 | An end at 11:00 never conflicts with a start at 11:00, in the service **and** in the database | Availability | `time.js` → `intervalsOverlap`; `availabilityService.js` → `findConflicts`; `0001_init.sql` → both triggers | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-003 an 11:00 end never conflicts with an 11:00 start` and `R-AVAIL-003 adjacency is accepted by the database trigger; a one-minute overlap is rejected` | automated + demo script (`scripts/smoke-core.js`: `adjacent accepted: NG-2026-00002`) | implemented+tested |
| R-AVAIL-004 | Opening hours are enforced in Sri Lanka Standard Time; a booking outside them is refused with the space's hours named | Availability | `availabilityService.js` → `checkBookingRules` | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-004 opening hours are enforced in Sri Lanka Standard Time` | automated | implemented+tested |
| R-AVAIL-005 | Minimum duration is enforced | Availability | `availabilityService.js` → `checkBookingRules` | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-005 minimum duration is enforced` | automated | implemented+tested |
| R-AVAIL-006 | Maximum duration is enforced when one is configured, and not when it is not | Availability | `availabilityService.js` → `checkBookingRules` | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-006 maximum duration is enforced only when configured` | automated | implemented+tested |
| R-AVAIL-007 | A maintenance block makes the affected units unavailable | Availability | `bookingService.js` → `createMaintenanceBlock` (occupancy rows `source='MAINTENANCE'`); `availabilityService.js` → `findConflicts` | — | manual (planned) | **pending — `createMaintenanceBlock` throws `column index out of range`; see defect D-1** |
| R-AVAIL-008 | Maintenance is compared exactly: no buffer is applied to it | Availability | `availabilityService.js` → `findConflicts`, `inspectUnits` (`MAINTENANCE` compared against raw `startAt`/`endAt`) | — | manual | implemented |
| R-AVAIL-009 | `buffer_minutes` widens the comparison symmetrically, against reservations only | Availability | `time.js` → `inflate`; `availabilityService.js` → `findConflicts`, `inspectUnits` | — | manual | implemented |
| R-AVAIL-010 | Pooled availability exposes free and total unit counts, and a request for N desks succeeds only when N are free | Availability | `availabilityService.js` → `getSpaceAvailability`, `allocateUnits` | — | demo script (`scripts/smoke-core.js`: all 20 desks booked, then `Only 0 of 1 required desks are free`) | implemented |
| R-AVAIL-011 | Desk allocation is deterministic: held desks first, then lowest accumulated load, then code ascending | Availability | `availabilityService.js` → `allocateUnits` | — | manual | implemented |
| R-AVAIL-012 | `RELEASED` occupancy never conflicts | Availability | `availabilityService.js` → `findConflicts` (`status = 'ACTIVE'`); triggers (`o.status = 'ACTIVE'`); `bookingService.js` → `cancelReservation` | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-012 released occupancy rows never conflict with an ACTIVE row` | automated + demo script (`scripts/smoke-core.js`: `slot rebookable after cancel`) | implemented+tested |
| R-AVAIL-013 | An availability preview is marked provisional and is not the authority | Availability | `availabilityService.js` → `getSpaceAvailability` (`provisional: true`), `getPublicAvailability`; `bookingService.js` re-checks inside the write transaction | — | demo script (`scripts/smoke-core.js` shows a preview returning 1/1 free, then a booking being created) | implemented |
| R-AVAIL-014 | Public availability exposes counts and anonymous blocked periods only | Availability | `availabilityService.js` → `getPublicAvailability` | — | manual | implemented |
| R-AVAIL-015 | A day grid of hourly slots is available for a space and date | Availability | `availabilityService.js` → `getSpaceDayGrid` | — | manual | implemented |
| R-AVAIL-016 | Availability labels state counts honestly ("Available", "N of M desks free", "Fully booked"), never overstating availability | Availability | `availabilityService.js` → `availabilityLabel` | `tests/unit/bookingRulesTraceability.test.js` → `R-AVAIL-016 availability labels report counts, not optimism` | automated | implemented+tested |
| R-AVAIL-017 | A window spanning a closing time is refused (current behaviour) | Availability | `availabilityService.js` → `checkBookingRules` | — | manual (probe evidence in `BOOKING_RULES.md` §12) | implemented — **see defect D-2: this contradicts the stated multi-day intent** |

## 4. Bookings — `R-BOOK-*`

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-BOOK-001 | Create a `CONFIRMED` reservation for an existing customer | Bookings | `bookingService.js` → `createReservation` | — | demo script (`scripts/smoke-core.js`: `created: NG-2026-00001 CONFIRMED`) | implemented |
| R-BOOK-002 | Create a reservation for a brand-new customer in one flow | Bookings | `customerService.js` → `createCustomer` + `bookingService.js` → `createReservation` (two calls; **the combined route does not exist**) | — | manual (planned) | pending |
| R-BOOK-003 | Reservation references have the documented, unique format | Bookings | `references.js` → `nextReference` (`NG-<year>-<5 digits>`) | — | demo script (`NG-2026-00001`, `NG-2026-00002`, `NG-2026-00003`, `NG-2026-00004` all distinct) | implemented |
| R-BOOK-004 | Availability is revalidated inside the write lock, so a stale preview cannot book a taken slot | Bookings | `bookingService.js` → `createReservation` → `allocateUnits` inside `withWriteTransaction`; `connection.js` → `withWriteTransaction` (`BEGIN IMMEDIATE`) | — | demo script (`scripts/smoke-core.js`: overlapping create rejected with `DOUBLE_BOOKING_CONFLICT` naming `NG-2026-00001`) | implemented |
| R-BOOK-005 | Editing a reservation revalidates availability and space rules | Bookings | `bookingService.js` → `updateReservation` | — | manual (planned) | implemented |
| R-BOOK-006 | A rejected edit leaves the original reservation and its allocations unchanged | Bookings | `bookingService.js` → `updateReservation` (single transaction, rollback) | — | manual (planned) | implemented |
| R-BOOK-007 | Cancellation requires a non-blank reason | Bookings | `bookingService.js` → `cancelReservation` (`reason.trim().length === 0` → validation error) | — | demo script (`blank cancel reason rejected: VALIDATION_ERROR`) | implemented |
| R-BOOK-008 | A blank or whitespace-only reason is rejected | Bookings | `bookingService.js` → `cancelReservation`; schema `CHECK (… trim(cancellation_reason) <> '')` | — | demo script (`blank cancel reason rejected`) | implemented |
| R-BOOK-009 | Cancellation records actor, timestamp and reason, and releases inventory exactly once | Bookings | `bookingService.js` → `cancelReservation` (`cancelled_by`, `cancelled_at`, `cancellation_reason`, `UPDATE … WHERE status='CONFIRMED'`); `auditService.js` → `recordAudit` | — | demo script (`cancelled: CANCELLED released rows: 1 reason: Customer rescheduled`, then `second cancel rejected: CONFLICT`) | implemented |
| R-BOOK-010 | Reservation references are unique even under concurrent creation | Bookings | schema `reservation.reference UNIQUE`; `references.js` → `nextReference` uses `app_sequence` inside the write transaction; `bookingService.js` → `handleBookingFailure` detects a reference collision | — | demo script (four distinct references produced) | implemented |
| R-BOOK-011 | A repeated create with the same idempotency key returns the original reservation instead of booking twice | Bookings | schema `reservation.idempotency_key UNIQUE`; `bookingService.js` → `createReservation`, `handleBookingFailure` | — | demo script (`idempotent retry -> same id: true true`) | implemented |
| R-BOOK-012 | `HOUR` pricing is deterministic and matches the documented examples | Bookings | `pricingService.js` → `billingQuantityFor`, `quote` | `tests/unit/bookingRulesTraceability.test.js` → `R-BOOK-012 HOUR quantity matches the worked example in docs/BOOKING_RULES.md` | automated + demo script (2 h × LKR 1,500 = 300,000 cents) | implemented+tested |
| R-BOOK-013 | `HALF_DAY` is 4 hours and quantities are `ceil(duration ÷ 4 h)`, minimum 1 | Bookings | `pricingService.js` → `billingQuantityFor` | `tests/unit/bookingRulesTraceability.test.js` → `R-BOOK-013 HALF_DAY is 4 hours and matches the worked example` | automated | implemented+tested |
| R-BOOK-014 | `DAY` quantity is the number of business-local dates touched | Bookings | `pricingService.js` → `billingQuantityFor`; `time.js` → `businessDaySpan` | `tests/unit/bookingRulesTraceability.test.js` → `R-BOOK-014 DAY quantity counts business-local dates touched` | automated | implemented+tested |
| R-BOOK-015 | `WEEK` quantity is `ceil(dates ÷ 7)`, minimum 1 | Bookings | `pricingService.js` → `billingQuantityFor` | `tests/unit/bookingRulesTraceability.test.js` → `R-BOOK-015 WEEK quantity matches the worked example` | automated | implemented+tested |
| R-BOOK-016 | `MONTH` quantity is `ceil(dates ÷ 30)`, minimum 1 | Bookings | `pricingService.js` → `billingQuantityFor` | `tests/unit/bookingRulesTraceability.test.js` → `R-BOOK-016 MONTH quantity matches the worked example` | automated | implemented+tested |
| R-BOOK-017 | A pooled booking claims 1..N desks; more desks than exist is refused | Bookings | `bookingService.js` → `requiredUnitsFor`, `allocateUnits` | — | demo script (20 desks booked, then a 21st refused) | implemented |
| R-BOOK-018 | Attendee count may not exceed the space's capacity; an empty count is allowed | Bookings | `availabilityService.js` → `checkBookingRules` | `tests/unit/bookingRulesTraceability.test.js` → `R-BOOK-018 attendee count may not exceed space capacity` | automated | implemented+tested |
| R-BOOK-019 | A reservation cannot be created or changed on an `ARCHIVED` space | Bookings | `bookingService.js` → `loadSpaceOrThrow` | — | manual | implemented |
| R-BOOK-020 | Only a `CONFIRMED` reservation can be cancelled | Bookings | `bookingService.js` → `cancelReservation` | — | demo script (`second cancel rejected: CONFLICT`) | implemented |
| R-BOOK-021 | Reconciliation marks past `CONFIRMED` reservations `COMPLETED` and keeps their occupancy | Bookings | `bookingService.js` → `reconcileCompletedReservations` | — | manual (planned) | implemented |
| R-BOOK-022 | An invalid or inverted window is refused before anything is written | Bookings | `bookingService.js` → `normaliseWindow`; `validation.js` → `parseBookingWindow` | — | manual | implemented |
| R-BOOK-023 | Booking periods longer than 400 days are refused | Bookings | `bookingService.js` → `normaliseWindow`; `validation.js` → `parseBookingWindow` | — | manual | implemented |
| R-BOOK-024 | Maintenance blocks can be created for a space or a subset of desks, and cancelled | Bookings | `bookingService.js` → `createMaintenanceBlock`, `cancelMaintenanceBlock`, `listMaintenanceBlocks` | — | manual (planned) | **pending — `createMaintenanceBlock` throws `column index out of range`; see defect D-1** |
| R-BOOK-025 | The consolidated reservations list, detail, create, edit and cancel pages exist | Bookings | **missing** — `src/server/routes/adminBookingRoutes.js` does not exist; no reservation views | — | manual (planned) | not-started |
| R-BOOK-026 | The calendar view exists with space/category/status filters | Bookings | **missing** — no `adminOpsRoutes.js`, no calendar view (`getSpaceDayGrid` supplies data only) | — | manual (planned) | not-started |

## 5. Concurrency — `R-CONC-*`

**The concurrency suite is not present.** `tests/concurrency/` does not exist in the repository, so no row
in this section can be marked anything other than `pending`. The case titles below are the **expected**
cases, derived from the guarantees documented in `ARCHITECTURE.md` §5 and `DATA_MODEL.md` §5. They are
proposals to be reconciled against the real suite when it lands; the implementation they exercise
(`BEGIN IMMEDIATE`, `busy_timeout`, both triggers, the optimistic cancellation guard, `app_sequence`)
is present today.

Every row: **Implementation** = `src/server/db/connection.js` → `withWriteTransaction` plus
`0001_init.sql` → `trg_occupancy_no_overlap_insert` / `trg_occupancy_no_overlap_update`, except where
noted. **Test** = `tests/concurrency/*` (absent). **Verification** = `automated (planned)`.
**Status** = `pending — see tests/concurrency/`.

| ID | Expected concurrency case | Implementation | Status |
|---|---|---|---|
| R-CONC-001 | Two processes create overlapping reservations on one exclusive room — exactly one commits, the other receives `DOUBLE_BOOKING_CONFLICT` | `withWriteTransaction` + insert trigger | pending — see tests/concurrency/ |
| R-CONC-002 | Two processes create adjacent reservations across an 11:00 boundary — both commit | both triggers (half-open predicate) | pending — see tests/concurrency/ |
| R-CONC-003 | Three processes create at 09:00, 09:30 and 10:00 on one room — exactly one commits | both triggers | pending — see tests/concurrency/ |
| R-CONC-004 | Twenty processes each request one desk from a twenty-desk pool — all twenty commit | insert trigger + `allocateUnits` | pending — see tests/concurrency/ |
| R-CONC-005 | Thirty processes each request one desk from a twenty-desk pool — exactly twenty commit and ten are refused | `allocateUnits` + insert trigger | pending — see tests/concurrency/ |
| R-CONC-006 | Two processes each request all twenty desks — exactly one commits | `allocateUnits` | pending — see tests/concurrency/ |
| R-CONC-007 | A six-desk request racing two three-desk requests — no desk is ever double-allocated | insert trigger | pending — see tests/concurrency/ |
| R-CONC-008 | Two processes send the same idempotency key for the same window — one reservation exists, both callers receive it | `reservation.idempotency_key UNIQUE` + `handleBookingFailure` | pending — see tests/concurrency/ |
| R-CONC-009 | Two processes send the same idempotency key with different payloads — the first committed payload wins, no second row | `handleBookingFailure` | pending — see tests/concurrency/ |
| R-CONC-010 | A reservation reference collision cannot occur across processes — all references are distinct | `app_sequence` incremented inside the write transaction | pending — see tests/concurrency/ |
| R-CONC-011 | Two processes cancel the same reservation — one succeeds, the second is refused with `CONFLICT` | `UPDATE … WHERE status = 'CONFIRMED'` | pending — see tests/concurrency/ |
| R-CONC-012 | Concurrent cancellation and rebooking of the freed slot — the rebooking either sees the release or is cleanly refused, never both | write-lock serialisation | pending — see tests/concurrency/ |
| R-CONC-013 | Concurrent cancellation releases each occupancy row exactly once (`releasedOccupancyRows` totals the row count, never double) | `cancelReservation` | pending — see tests/concurrency/ |
| R-CONC-014 | A process edits reservation A onto reservation B's slot while B is being edited elsewhere — at most one of the two moves commits | `updateReservation` + update trigger | pending — see tests/concurrency/ |
| R-CONC-015 | A rejected edit leaves the original reservation byte-for-byte unchanged (window, units, price, audit trail) | transaction rollback | pending — see tests/concurrency/ |
| R-CONC-016 | Concurrent edits of the *same* reservation — exactly one wins; no lost update and no duplicated occupancy | write-lock serialisation | pending — see tests/concurrency/ |
| R-CONC-017 | A maintenance block racing a booking for the same interval — exactly one commits, whichever it is | insert trigger (`source = 'MAINTENANCE'` shares the predicate) | pending — see tests/concurrency/ |
| R-CONC-018 | Two overlapping maintenance blocks on the same desk — one commits, the other is refused | insert trigger | pending — see tests/concurrency/ |
| R-CONC-019 | Two maintenance blocks on disjoint desk subsets of one co-working space — both commit | insert trigger operates per resource unit | pending — see tests/concurrency/ |
| R-CONC-020 | Cancelling a maintenance block while a booking targets the same interval — the booking succeeds only once the release has committed, and never overlaps a live block | write-lock serialisation | pending — see tests/concurrency/ |
| R-CONC-021 | A raw `INSERT` that bypasses the service layer entirely is still refused by the trigger | `trg_occupancy_no_overlap_insert` | pending — see tests/concurrency/ (the single-process trigger behaviour is asserted today by `tests/unit/bookingRulesTraceability.test.js`) |
| R-CONC-022 | A raw `UPDATE` that would move a claim onto an existing claim is refused and leaves the row unchanged | `trg_occupancy_no_overlap_update` | pending — see tests/concurrency/ (single-process trigger behaviour asserted by `tests/unit/bookingRulesTraceability.test.js`) |
| R-CONC-023 | Releasing a claim and inserting an overlapping `ACTIVE` claim in the same transaction both succeed | update trigger `WHEN NEW.status = 'ACTIVE'` | pending — see tests/concurrency/ |
| R-CONC-024 | A rolled-back creation leaves no reservation, no occupancy row and no audit row | `withWriteTransaction` rollback | pending — see tests/concurrency/ |
| R-CONC-025 | A rolled-back creation consumes no reference number | `app_sequence` inside the rolled-back transaction (observed in `scripts/smoke-core.js`) | pending — see tests/concurrency/ |
| R-CONC-026 | Twenty contenders never surface `SQLITE_BUSY` inside `busy_timeout`; every caller gets a domain answer | `PRAGMA busy_timeout = 10000` | pending — see tests/concurrency/ |
| R-CONC-027 | Concurrent inquiry submissions consume no inventory and never interfere with bookings | `inquiry` is disjoint from `occupancy`; **the inquiry service does not exist yet** | pending — see tests/concurrency/ |
| R-CONC-028 | Rate-limit counters are accurate across processes (no lost updates on `rate_limit_counter`) | `rateLimit.hit` uses `INSERT … ON CONFLICT DO UPDATE` | pending — see tests/concurrency/ |
| R-CONC-029 | Reconciliation racing a new booking: past rows become `COMPLETED` and keep their claims; the new future booking is unaffected | `reconcileCompletedReservations` | pending — see tests/concurrency/ |
| R-CONC-030 | Deleting a space's last desk while a booking holds it is refused under concurrency; no booking loses its unit mid-flight | `syncUnits` guard + foreign keys | pending — see tests/concurrency/ |

## 6. Customers — `R-CUST-*`

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-CUST-001 | Customers are central records that reservations link to by id | Customers | `customerService.js` → `createCustomer`, `getCustomer`; schema `reservation.customer_id NOT NULL REFERENCES customer(id) ON DELETE RESTRICT` | — | demo script (`customer: 1 Hanna Bekele`) | implemented |
| R-CUST-002 | Likely duplicates are detected and shown to staff, and are **never merged automatically** | Customers | `customerService.js` → `findPossibleDuplicates` (match/confidence, no writes); `createCustomer` refuses a duplicate email unless `allowDuplicate` | — | manual | implemented |
| R-CUST-003 | Emails are normalised (trimmed, lower-cased) before storage and comparison | Customers | `validation.js` → `normalizeEmail`; `customerService.js` → `createCustomer`, `updateCustomer` | — | manual | implemented |
| R-CUST-004 | Duplicate customer creation is refused with an explanatory conflict unless explicitly overridden | Customers | `customerService.js` → `createCustomer` (`allowDuplicate`) | — | manual | implemented |
| R-CUST-005 | Editing a customer cannot move their email onto another customer's email | Customers | `customerService.js` → `updateCustomer` (dupe check excluding self) | — | manual | implemented |
| R-CUST-006 | A customer's booking history is available | Customers | `customerService.js` → `getCustomerHistory` | — | manual | implemented |
| R-CUST-007 | Customer statistics (total, confirmed, cancelled, last booking, booked value) are derived from reservations, not stored | Customers | `customerService.js` → `hydrateCustomer`, `searchCustomers` | — | manual | implemented |
| R-CUST-008 | Customers frequently booked and upcoming bookings are available | Customers | `customerService.js` → `customerFrequentSpaces`, `customerUpcomingReservations` | — | manual | implemented |
| R-CUST-009 | The customer directory can be searched by name, email, organisation or phone | Customers | `customerService.js` → `searchCustomers` (LIKE wildcards escaped) | — | manual | implemented |
| R-CUST-010 | A customer record cannot be deleted while any reservation references it | Customers | schema `reservation.customer_id … ON DELETE RESTRICT`; no delete path exists | — | manual | implemented |
| R-CUST-011 | **The customer directory is never exposed publicly** | Customers | `API_CONTRACTS.md` §5 rule: public routes must never import `customerService`. Enforced by review today; **no public route exists yet to violate it** | — | manual (inspection) | implemented |
| R-CUST-012 | Customer pages (directory, profile, create, edit) exist | Customers | **missing** — `src/server/routes/adminCustomerRoutes.js` does not exist; no customer views | — | manual (planned) | not-started |
| R-CUST-013 | `/api/admin/customers/search` typeahead exists for the booking form | Customers | **missing** — no admin JSON routes | — | automated (planned) | not-started |

## 7. Inquiries — `R-INQ-*`

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-INQ-001 | Inquiry submissions persist with a unique `INQ-<year>-<5 digits>` reference | Inquiries | `references.js` → `nextReference` supports `inquiry`; schema `inquiry` table exists. **`inquiryService.js` does not exist, so nothing creates a row** | — | manual (planned) | pending |
| R-INQ-002 | A notification email is attempted for each inquiry | Inquiries | **missing** — `src/server/mail/mailer.js` does not exist | — | manual (planned) | not-started |
| R-INQ-003 | Delivery status is recorded honestly; when SMTP is unconfigured the status is `NOT_CONFIGURED` and the visitor is told notification is pending | Inquiries | Schema `email_status` includes `NOT_CONFIGURED`; `config.js` → `describeConfig` says "not configured (inquiries will still be saved)". **No code records the status** | — | manual (planned) | pending |
| R-INQ-004 | **An inquiry consumes no inventory** | Inquiries | No code path links `inquiry` to `occupancy`; the two tables are disjoint. | — | manual (schema inspection) | implemented |
| R-INQ-005 | A visitor can withdraw their own inquiry using a reference plus a token; only the token hash is stored | Inquiries | Schema `inquiry.withdraw_token_hash`; `references.js` → `randomToken`. **No service, no route** | — | manual (planned) | pending |
| R-INQ-006 | Converting an inquiry links it to the reservation that was created | Inquiries | Schema `inquiry.converted_reservation_id REFERENCES reservation(id) ON DELETE SET NULL`. **No conversion code** | — | manual (planned) | pending |
| R-INQ-007 | Inquiry status can move through `NEW → CONTACTED → CONVERTED / CLOSED / WITHDRAWN` | Inquiries | Schema `CHECK` restricts the values; `constants.js` → `INQUIRY_STATUS`; `validation.js` → `assertInquiryStatus`. **No transition code** | — | manual (planned) | pending |
| R-INQ-008 | Public inquiry submissions are rate limited per IP and per email | Inquiries | `rateLimit.js` → `enforcePublicInquiryLimits` (8/15 min per IP, 5/h per email). **Not wired to any route** | — | automated (planned) | pending |
| R-INQ-009 | An inquiry request is rejected if the window is inverted or absurdly long | Inquiries | Schema `CHECK (requested_end_at > requested_start_at)`; `validation.js` → `parseBookingWindow` supports it. **No service uses it for inquiries** | — | automated (planned) | pending |
| R-INQ-010 | The admin inquiry queue and detail page exist with delivery status and a convert action | Inquiries | **missing** — no `adminOpsRoutes.js`, no inquiry views | — | manual (planned) | not-started |
| R-INQ-011 | The withdrawal link is shown to the visitor on the acknowledgement page | Inquiries | **missing** — no view, no route | — | manual (planned) | not-started |

## 8. Authentication and authorization — `R-AUTH-*`

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-AUTH-001 | Passwords are stored with scrypt (N=16384, r=8, p=1) and a per-user random salt, in the documented format | Auth | `passwords.js` → `hashPassword` (`scrypt$N$r$p$salt$hash`, 16-byte salt, 64-byte key) | — | manual | implemented |
| R-AUTH-002 | No plaintext password is stored or logged anywhere | Auth | `passwords.js` (hash only); `sessions.js` → `hashToken` for session tokens; no plaintext is written to `audit_log` | — | manual | implemented |
| R-AUTH-003 | Password verification is constant-time and fails closed on malformed hashes | Auth | `passwords.js` → `verifyPassword` (`timingSafeEqual`, `try/catch` returning `false`) | — | manual | implemented |
| R-AUTH-004 | Only a hash of the session token is stored, so a database copy cannot be replayed | Auth | `sessions.js` → `createSession` stores `hashToken(token)`; `admin_session.token_hash UNIQUE` | — | manual | implemented |
| R-AUTH-005 | Sessions idle out after 2 hours of inactivity | Auth | `sessions.js` → `resolveSession` (`IDLE_TIMEOUT_MS = 7 200 000`, revokes on breach) | — | manual | implemented |
| R-AUTH-006 | Sessions expire absolutely 12 hours after creation | Auth | `sessions.js` → `SESSION_TTL_MS = 43 200 000`; `resolveSession` checks `expires_at` | — | manual | implemented |
| R-AUTH-007 | Roles are resolved from the database on every request, never from the browser | Auth | `sessions.js` → `resolveSession` joins `admin_user` and returns `actor.role`; `app.js` middleware stores it on `ctx` | — | manual | implemented |
| R-AUTH-008 | Admin-only actions require the `ADMIN` role | Auth | `sessions.js` → `requireAdmin` (throws `forbidden` unless `role === 'ADMIN'`) | — | manual | implemented |
| R-AUTH-009 | Every state-changing admin request requires a valid CSRF token | Auth | `sessions.js` → `csrfTokenFor`, `verifyCsrf`, `requireCsrf` (accepts `_csrf`, `x-csrf-token`, `csrf` query); `layout.js` → `adminShell` embeds `_csrf`. **Not yet wired into any route** | — | automated (planned) | pending |
| R-AUTH-010 | Sign-in attempts are throttled per IP and per account | Auth | `rateLimit.js` → `enforceLoginLimits` (30/15 min per IP, 12/15 min per email). **Not wired to a route** | — | automated (planned) | pending |
| R-AUTH-011 | Repeated failed sign-ins lock the account for 15 minutes | Auth | `sessions.js` → `authenticate` (`MAX_FAILED_LOGINS = 8`, `LOCKOUT_MS = 15 min`); counters reset on success | — | manual | implemented |
| R-AUTH-012 | A first administrator can be created on an empty database | Auth | `config.js` → `bootstrapAdmin` reads the environment. **No bootstrap code applies it, and `scripts/create-admin.js` does not exist** | — | manual (planned) | pending |
| R-AUTH-013 | A disabled account cannot sign in and existing sessions stop resolving | Auth | `sessions.js` → `authenticate` (`is_active`), `resolveSession` (`is_active !== 1` → null) | — | manual | implemented |
| R-AUTH-014 | Signing out revokes the session | Auth | `sessions.js` → `revokeSession`; `POST /admin/logout` route **does not exist** | — | manual (planned) | pending |
| R-AUTH-015 | Expired and long-revoked sessions are purged | Auth | `sessions.js` → `purgeExpiredSessions`. **Nothing calls it** (no `index.js`) | — | manual (planned) | pending |
| R-AUTH-016 | Failed sign-in attempts are recorded in the audit log | Auth | `sessions.js` → `authenticate` → `genericFailure` → `recordAudit('auth.login_failed')` | — | manual | implemented |
| R-AUTH-017 | Sign-in, sign-out and the admin shell are reachable over HTTP | Auth | **missing** — `src/server/routes/authRoutes.js` does not exist | — | manual (planned) | not-started |
| R-AUTH-018 | All staff routes require an authenticated actor | Auth | `app.js` resolves sessions but **routes that call `requireAuth` do not exist** | — | automated (planned) | pending |

## 9. Dashboard — `R-DASH-*`

Nothing in this area exists. `src/server/services/dashboardService.js`,
`src/server/routes/adminOpsRoutes.js` and every dashboard view are absent. All rows are `not-started`.
The only dashboard-shaped surface that already exists is `availabilityService.getSpaceDayGrid`, which
supplies data for a calendar or an occupancy panel but computes no dashboard counters.

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-DASH-001 | Dashboard counters are computed live from the database at request time | Dashboard | **missing** — no dashboard service | — | manual (planned) | not-started |
| R-DASH-002 | Today's bookings are listed (business-local day) | Dashboard | **missing** — `time.js` → `startOfBusinessDay` provides the boundary; no consumer | — | manual (planned) | not-started |
| R-DASH-003 | Upcoming bookings are listed | Dashboard | **missing** | — | manual (planned) | not-started |
| R-DASH-004 | Current occupancy is shown per space | Dashboard | **missing** — `getSpaceDayGrid` could feed it | — | manual (planned) | not-started |
| R-DASH-005 | New inquiries are surfaced | Dashboard | **missing** | — | manual (planned) | not-started |
| R-DASH-006 | Recent changes are shown from the audit log | Dashboard | `auditService.js` → `listAudit` provides the data; no dashboard consumes it | — | manual (planned) | not-started |
| R-DASH-007 | **No fabricated metric, placeholder or hard-coded number is displayed** | Dashboard | Nothing is displayed at all, so nothing is fabricated. The requirement becomes testable only when the dashboard exists | — | manual | not-started |
| R-DASH-008 | `/api/admin/dashboard/summary` returns the counters | Dashboard | **missing** — no admin JSON routes | — | automated (planned) | not-started |
| R-DASH-009 | Every dashboard number can be traced to a query over live tables | Dashboard | **missing** | — | manual (planned) | not-started |

## 10. Security — `R-SEC-*`

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-SEC-001 | All user input is validated server-side; client-side checks are a convenience only | Security | `validation.js` (whole module); services call it before writing | — | manual | implemented |
| R-SEC-002 | Uploaded images are typed by sniffing magic bytes, never by the declared content type or filename; SVG is refused | Security | `validation.js` → `sniffImageType`, `assertUploadableImage` (JPEG/PNG/WebP, ≤ 5 MB) | — | manual | implemented |
| R-SEC-003 | Static asset paths cannot escape the public directory (no traversal, no hidden files) | Security | `app.js` static middleware (`join`, prefix check with `sep`, extension allow-list) | — | manual | implemented |
| R-SEC-004 | Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`; HTML carries a restrictive CSP | Security | `response.js` → `applySecurityHeaders`, used by `sendJson`/`sendHtml`/`sendText`/`sendBuffer`/`sendFileStream`/`redirect` | — | manual | implemented |
| R-SEC-005 | Uploaded media is inert: `default-src 'none'; sandbox`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin` | Security | `response.js` → `applySecurityHeaders({ isMedia: true })`; **the media route that would pass `isMedia: true` does not exist** | — | automated (planned) | pending |
| R-SEC-006 | No stack trace, SQL text or internal message reaches a client | Security | `router.js` → `normaliseError` (generic 500 body, `console.error` server-side); `app.js` error boundary returns a generic message for `status >= 500` | — | manual | implemented |
| R-SEC-007 | Client IPs are stored salted and hashed, never in the clear | Security | `sessions.js` → `hashIp` (SHA-256 of `salt:ip`, truncated to 32 hex chars); `rateLimit.js` → `ipBucket` uses it; `admin_session.ip_hash` | — | manual | implemented |
| R-SEC-008 | No secret, password or SMTP credential is logged | Security | `config.js` → `describeConfig` prints host/port but never user or pass; services never log credentials | — | manual | implemented |
| R-SEC-009 | All rendered HTML escapes interpolations by default; unescaped output must be explicit and greppable | Security | `html.js` → `html`, `escapeHtml`, `raw`; only `raw()` produces unescaped markup | — | manual (grep `raw(` per view) | implemented |
| R-SEC-010 | Every SQL statement is parameterised | Security | All queries in `services/*.js`, `security/*.js` and `db/*.js` use `?` placeholders. The only dynamic SQL fragments are internally generated placeholder lists and fixed enum literals interpolated from `constants.js` | — | manual (code inspection) | implemented |
| R-SEC-011 | SQLite foreign keys are enforced on every connection | Security | `connection.js` → `getDb` issues `PRAGMA foreign_keys = ON` | — | manual (verified: `DELETE FROM space` with a reservation fails with `FOREIGN KEY constraint failed`) | implemented |
| R-SEC-012 | Double booking is refused by the database itself, independent of the service layer | Security | `0001_init.sql` → `trg_occupancy_no_overlap_insert`, `trg_occupancy_no_overlap_update`; schema `CHECK` constraints for interval validity and the `source`/`reservation_id` equivalence | `tests/unit/bookingRulesTraceability.test.js` → `R-SEC-012 both occupancy triggers exist after migrations`, `R-SEC-012 both trigger bodies still contain RAISE(ABORT, 'DOUBLE_BOOKING_CONFLICT')`, `R-SEC-012 the insert trigger rejects an overlapping ACTIVE row and writes nothing`, `R-SEC-012 the update trigger rejects an overlap and leaves the row unchanged` | automated | implemented+tested |
| R-SEC-013 | `/media/:storedName` accepts only `^[a-f0-9]{32}\.(jpg\|png\|webp)$` | Security | **missing** — no media route | — | automated (planned) | not-started |
| R-SEC-014 | Request bodies are size-capped (1 MB forms/JSON, 12 MB multipart) | Security | `request.js` → `readRawBody`, `DEFAULT_BODY_LIMIT`, `UPLOAD_BODY_LIMIT` | — | manual | implemented |
| R-SEC-015 | Sessions are carried in `HttpOnly`, `SameSite=Lax` cookies, with `Secure` when configured | Security | `response.js` → `serializeCookie`; `app.js` sets `ctx.secure` from `forceSecureCookies`/TLS | — | manual | implemented |
| R-SEC-016 | The schema is integrity-checked and referentially sound | Security | `0001_init.sql`; `DATA_MODEL.md` §9.1 records `PRAGMA integrity_check = ok` and an empty `PRAGMA foreign_key_check` | — | manual (`PRAGMA` checks) | implemented |
| R-SEC-017 | CSP is restrictive on admin pages too (no inline scripts, no third-party origins) | Security | `response.js` → `'self'`-only `script-src`/`style-src`; **the admin pages themselves do not exist**, and `layout.js` references `/assets/admin.js`, which is absent | — | manual (planned) | pending |

## 11. Experience — `R-UX-*`

| ID | Requirement | Source | Implementation | Test | Verification | Status |
|---|---|---|---|---|---|---|
| R-UX-001 | Every core workflow is operable from the keyboard | UX | `layout.js` → `publicShell`/`adminShell` include a skip link and semantic `nav`/`main`; **no form or table view exists to exercise it** | — | manual (planned) | pending |
| R-UX-002 | Pages render on a mobile viewport | UX | `layout.js` → `documentHead` sets `width=device-width, initial-scale=1`; `adminShell` has a sidebar toggle control. **`/assets/styles.css` does not exist** | — | manual (planned) | pending |
| R-UX-003 | Empty states are rendered deliberately | UX | `html.js` → `emptyState`; `layout.js` → `table({ emptyMessage })` | — | manual | implemented |
| R-UX-004 | Error states are rendered deliberately, including a 409 booking-conflict page | UX | `app.js` → `renderErrorPage` (status-specific titles), `router.onError`; `router.js` → `normaliseError` | — | manual | implemented |
| R-UX-005 | Forms are labelled, and field-level validation errors are shown next to the offending field | UX | `html.js` → `fieldError`, `problemList`; `validation.js` returns `details.field` for every field error. **No form view exists** | — | manual (planned) | pending |
| R-UX-006 | Loading and error messaging is honest — no claim of success that did not happen | UX | `app.js` → `setFlash` kinds `success`/`error`/`warning` with an optional `problems` list; `BOOKING_RULES.md` §9 governs the wording. **The pages that display flashes do not exist** | — | manual (planned) | pending |
| R-UX-007 | Public pages state that availability is provisional | UX | `layout.js` → `publicShell` footer notice | — | manual | implemented |
| R-UX-008 | Pagination is available wherever lists are long | UX | `html.js` → `pagination`; `validation.js` → `asPagination` | — | manual | implemented |
| R-UX-009 | Status is communicated with a labelled badge, not colour alone | UX | `html.js` → `statusBadge` (class + text label), `tag`, `availabilityPill` | — | manual | implemented |
| R-UX-010 | A public booking-request flow exists with confirmation and withdrawal | UX | **missing** — no routes, no views | — | manual (planned) | not-started |
| R-UX-011 | The public site is styled and usable (CSS, progressive-enhancement JS) | UX | **missing** — `src/web/public/` does not exist, though `layout.js` links `/assets/styles.css`, `/assets/public.js` and `/assets/admin.js` | — | manual (planned) | not-started |

---

## 12. Summary

| Status | Count |
|---|---|
| `implemented+tested` | 15 |
| `implemented` | 94 |
| `pending` | 61 |
| `not-started` | 26 |
| **Total rows** | **196** |

### Counts per area

| Area | Rows | `implemented+tested` | `implemented` | `pending` | `not-started` |
|---|---|---|---|---|---|
| `R-SPACE-*` | 29 | 0 | 27 | 0 | 2 |
| `R-PUB-*` | 15 | 0 | 2 | 9 | 4 |
| `R-AVAIL-*` | 17 | 8 | 8 | 1 | 0 |
| `R-BOOK-*` | 26 | 6 | 16 | 2 | 2 |
| `R-CONC-*` | 30 | 0 | 0 | 30 | 0 |
| `R-CUST-*` | 13 | 0 | 11 | 0 | 2 |
| `R-INQ-*` | 11 | 0 | 1 | 7 | 3 |
| `R-AUTH-*` | 18 | 0 | 11 | 6 | 1 |
| `R-DASH-*` | 9 | 0 | 0 | 0 | 9 |
| `R-SEC-*` | 17 | 1 | 13 | 2 | 1 |
| `R-UX-*` | 11 | 0 | 5 | 4 | 2 |
| **Total** | **196** | **15** | **94** | **61** | **26** |

Every column and every row of the per-area table reconciles to the same totals; it is the authoritative
tally for this matrix.

### The 15 `implemented+tested` rows

All are asserted by `tests/unit/bookingRulesTraceability.test.js`, which is the only test file in the
repository:

`R-AVAIL-001`, `R-AVAIL-002`, `R-AVAIL-003`, `R-AVAIL-004`, `R-AVAIL-005`, `R-AVAIL-006`,
`R-AVAIL-012`, `R-AVAIL-016`, `R-BOOK-012`, `R-BOOK-013`, `R-BOOK-014`, `R-BOOK-015`, `R-BOOK-016`,
`R-BOOK-018`, `R-SEC-012`.

Everything else that is `implemented` has source but no assertion. Everything that is `pending` is
blocked on a missing file. Everything that is `not-started` has nothing.

---

## 13. Gaps and unverified claims

### 13.1 Whole areas with no implementation at all

1. **No HTTP entry point.** `src/server/index.js` does not exist, so `npm start`, `npm run dev` and
   `npm run migrate` (as a script) cannot run. `src/server/app.js` imports eight route modules, none of
   which exist: `routes/authRoutes.js`, `routes/publicRoutes.js`, `routes/adminSpaceRoutes.js`,
   `routes/adminBookingRoutes.js`, `routes/adminCustomerRoutes.js`, `routes/adminOpsRoutes.js`,
   `routes/mediaRoutes.js`, `routes/adminUploadRoutes.js`. Importing `app.js` today fails immediately.
2. **No views beyond two shells.** `src/web/views/` contains only `layout.js`. There is no space page, no
   booking form, no admin page of any kind. `src/web/public/` does not exist, so the three asset URLs the
   shells reference (`/assets/styles.css`, `/assets/public.js`, `/assets/admin.js`) all 404 under the
   static middleware's allow-list.
3. **No inquiry subsystem.** `inquiryService.js` is absent. The `inquiry` table, its `CHECK` constraints
   and its `INQUIRY_STATUS` vocabulary exist; nothing writes a row, nothing sends an email, nothing
   withdraws, nothing converts.
4. **No mailer.** `src/server/mail/mailer.js` is referenced by `ARCHITECTURE.md` §10 but the `mail/`
   directory does not exist. `nodemailer` is a declared dependency with no consumer.
5. **No upload subsystem.** `src/server/security/uploads.js` does not exist. Magic-byte sniffing and the
   5 MB cap exist in `validation.js`, but nothing writes a file to `storage/uploads` and nothing enforces
   path containment on the write side.
6. **No dashboard.** No service, no counters, no view, no JSON endpoint.
7. **No concurrency test suite.** `tests/concurrency/` does not exist, so the 30 cases in §5 are
   `pending` by definition. The defining correctness property of the system is **not automatically
   verified anywhere today** beyond the single-process trigger assertions in
   `tests/unit/bookingRulesTraceability.test.js`.
8. **No seed and no admin bootstrap.** `src/server/db/seed.js` and `scripts/create-admin.js` are declared
   in `package.json` and absent. `config.js` reads `NAGARO_BOOTSTRAP_ADMIN_*` but nothing consumes it, so
   there is currently no supported way to create the first administrator.
9. **No demo script for the headline behaviour.** `scripts/demo-double-booking.js` is declared and absent.
   `scripts/smoke-core.js` does demonstrate the rejection and passes, but it is not the script the
   architecture document points at.

### 13.2 Documented claims that are currently unverifiable

These appear in `ARCHITECTURE.md` or `API_CONTRACTS.md` as though they were facts. They are not, today.

1. **"Evidence: `tests/concurrency/*` spawn real OS processes against the real database file."**
   (`ARCHITECTURE.md` §5) — the directory does not exist. The multi-process guarantee is *reasoned about*
   in `DATA_MODEL.md` §5 from the pragmas and the triggers, but it has never been observed.
2. **"`scripts/demo-double-booking.js` reproduces the rejection for a live demo."** (`ARCHITECTURE.md` §5) —
   the file does not exist.
3. **"`src/server/index.js` … bootstrap: migrate, seed, listen, graceful shutdown"** (`ARCHITECTURE.md` §3) —
   absent.
4. **"`getPublicAvailability()` is the single public availability entry point"** (`ARCHITECTURE.md` §8) —
   the function exists and is clean (it returns counts and anonymous blocked periods, never touching
   `customer`). But nothing calls it, so "no customer data in any public response" is verified by reading
   one function, not by exercising a route.
5. **"Public routes must never import `customerService`."** (`API_CONTRACTS.md` §5) — there are no public
   routes to audit.
6. **"Every route below must exist."** (`API_CONTRACTS.md` §7, the route inventory) — zero of the ~45
   routes exist.
7. **"First administrator: `npm run admin:create` or `NAGARO_BOOTSTRAP_ADMIN_EMAIL` …"** (`ARCHITECTURE.md` §7) —
   neither path exists.
8. **"`IMPLEMENTATION_REPORT.md` for raw evidence"** (`ARCHITECTURE.md` §2) — the file does not exist.

### 13.3 Requirements I could **not** verify, and why

| Requirement | Blocker |
|---|---|
| Everything in `R-DASH-*` | Nothing is implemented. |
| Every `R-CONC-*` row | `tests/concurrency/` is absent. The mechanism is present; the multi-process behaviour is not demonstrated. |
| `R-PUB-001`…`R-PUB-007`, `R-PUB-011`…`R-PUB-015` | No public routes and no views. The 404-for-`DRAFT`/`ARCHIVED` rule is enforced inside `getPublicAvailability`, but no HTTP surface exists to prove it. |
| `R-AUTH-009`, `R-AUTH-010`, `R-AUTH-014`, `R-AUTH-015`, `R-AUTH-017`, `R-AUTH-018` | The primitives (`requireCsrf`, `enforceLoginLimits`, `revokeSession`, `purgeExpiredSessions`) are implemented and correct; they are not wired to anything, so their *enforcement* is unproven. |
| `R-SEC-005`, `R-SEC-013` | The headers helper exists and is correct; there is no `/media/:storedName` route to serve a file through it, so the inert-media property is unproven. |
| `R-UX-001`, `R-UX-002`, `R-UX-005`, `R-UX-006` | Accessibility and responsiveness cannot be assessed on pages that do not exist. The primitives (`fieldError`, `problemList`, `emptyState`, the skip link) are present. |
| `R-SPACE-020` (upload validation) | The validator is correct and testable, but with no upload route the end-to-end property — "a `.svg` upload is refused" — has not been observed. |
| `R-BOOK-021` (reconciliation) | The function is implemented but nothing calls it (`A16`). Its effect on a running system is unverified. |

### 13.4 Defects found while compiling this matrix

| ID | File and line | Symptom | Requirements affected |
|---|---|---|---|
| **D-1** | `src/server/services/bookingService.js:630-641` | `createMaintenanceBlock` binds 7 placeholders for 9 columns while passing 8 arguments, so `source` would be `NULL` (a `NOT NULL` column). Every call fails with `ERR_SQLITE_ERROR: column index out of range`. Correct form: `VALUES (?,?,?,?,?,?,NULL,?,?)`. | `R-AVAIL-007`, `R-BOOK-024` |
| **D-2** | `src/server/services/availabilityService.js:433-454` | `checkBookingRules` rejects every interval that crosses a `close_time` — overnight and multi-day windows included — even with `open_time='00:00'`, `close_time='23:59'`. The loop sets `cursor = dayClose`, then re-examines the same date and takes the `cursor >= dayClose` branch. The preceding comment claims multi-day support. | `R-AVAIL-017`; makes `R-BOOK-014` (`DAY > 1`), `R-BOOK-015`, `R-BOOK-016` unreachable through the booking service |
| **D-3** | `src/server/services/availabilityService.js:430` | `checkBookingRules` reads snake_case `space.open_time`/`close_time`, but `spaceService.getSpace()` returns the camelCase hydrated `Space`. Passing a hydrated space throws `Invalid clock value: undefined`. All in-tree call sites pass raw rows, so this is latent; `API_CONTRACTS.md` §4 does not state which shape is required. | `R-AVAIL-004`, `R-AVAIL-005`, `R-AVAIL-006` (contract clarity only) |
| **D-4** | `src/server/services/spaceService.js:150-172` | `syncUnits`'s closing comment says previously deactivated units are reactivated, but the code always creates new codes: 20 → 10 → 20 desks leaves 30 `resource_unit` rows with ten permanently inactive. Counts remain correct; the table accumulates retired desks. | `R-SPACE-022`, `R-SPACE-023` |
| **D-5** | `0001_init.sql:209` | `occupancy.maintenance_block_id` has no `REFERENCES` clause, unlike every other relationship in the schema. `PRAGMA foreign_key_check` cannot detect a dangling value. Harmless today because maintenance blocks are never deleted. | `R-SEC-016` |

### 13.5 Process observations

- **`package.json` over-promises (RESOLVED).** At audit time the declared scripts pointed at files that
  did not exist. All of them now exist, and the test scripts were later repaired to use globs so
  `npm test` runs on Node ≥ 22 (it previously failed on the bare-directory form). Current: `npm test`
  190/190, `npm run test:concurrency` 37/37, `npm run test:e2e` 63/63.
- **The schema is ahead of the application.** Every table, `CHECK`, partial unique index and trigger that
  this matrix depends on is present, correct and verified. The gap is entirely in routes, views and the
  services that would orchestrate them.
- **The one property that matters most is implemented twice and tested once.** `BEGIN IMMEDIATE` +
  `busy_timeout` and the two triggers are both in place; only the single-process half of the trigger
  guarantee has an automated assertion.

---

## 14. Cross-reference to user stories and acceptance criteria

*Added 18 October 2026. The `R-*` rows above are preserved verbatim as a historical
snapshot. The table below is the bridge to the current requirement vocabulary.*

Requirements are now expressed as **user stories** (`US-*`) defended by
**acceptance criteria** (`AC-*`). The authoritative, per-criterion implementation
and verification assessment lives in `USER_STORY_TRACEABILITY.md`; this section
only links the two ID schemes so that the older `R-*` rows can still be followed.

| Legacy `R-*` area | Legacy IDs | Current stories | Representative acceptance criteria |
|---|---|---|---|
| Space management | `R-SPACE-001`–`R-SPACE-029` | US-02, US-18–US-24 | AC-18.1–AC-24.3, AC-02.3 |
| Public discovery | `R-PUB-001`–`R-PUB-015` | US-01–US-09, US-38, US-44 | AC-01.1–AC-04.2, AC-05.1–AC-09.3, AC-38.1–AC-38.3, AC-44.1–AC-44.3 |
| Availability | `R-AVAIL-001`–`R-AVAIL-017` | US-33, US-34, US-38, US-39, US-40 | AC-33.1–AC-34.4, AC-38.1–AC-40.3 |
| Bookings | `R-BOOK-001`–`R-BOOK-026` | US-25–US-27, US-31, US-35–US-37 | AC-25.1–AC-27.4, AC-31.1–AC-31.3, AC-35.1–AC-37.3 |
| Concurrency | `R-CONC-001`–`R-CONC-030` | US-23, US-26, US-27, US-32, US-33, US-37 | AC-32.1–AC-32.4, AC-33.1–AC-33.4 |
| Customers | `R-CUST-001`–`R-CUST-013` | US-29 | AC-29.1–AC-29.4 |
| Inquiries | `R-INQ-001`–`R-INQ-011` | US-05–US-11 | AC-05.1–AC-11.3 |
| Authentication and authorization | `R-AUTH-001`–`R-AUTH-018` | US-12–US-16, US-45, US-46 | AC-12.1–AC-16.3, AC-45.1–AC-46.4 |
| Dashboard | `R-DASH-001`–`R-DASH-009` | US-17, US-31 | AC-17.1–AC-17.3, AC-31.1–AC-31.3 |
| Security | `R-SEC-001`–`R-SEC-017` | US-32, US-42–US-48 | AC-32.1–AC-32.4, AC-42.1–AC-48.4 |
| Experience (UX) | `R-UX-001`–`R-UX-011` | US-49–US-51, US-58 | AC-49.1–AC-51.3, AC-58.1–AC-58.2 |
| *Platform / operations (no `R-*` area)* | — | US-52–US-57 | AC-52.1–AC-57.2 |

### 14.1 Status vocabulary mapping

The two documents use different status words. They correspond as follows.

| This matrix (historical) | `USER_STORY_TRACEABILITY.md` (current) |
|---|---|
| `implemented` / `tested` | **Verified** (only when the specific criterion was actually exercised); otherwise **Implemented, not verified** |
| `implemented` but verification "planned"/"manual" | **Implemented, not verified** |
| `pending` / `partial` | **Partially implemented** or **Implemented, not verified** |
| `not-started` / `absent` / "missing" | **Not implemented** |
| depends on an absent external dependency | **Blocked** |

### 14.2 Known contradictions resolved

| Date | Item | Resolution |
|---|---|---|
| 18 Oct 2026 | Defects **D-1** and **D-2** in §13.4 (maintenance insert column mismatch; multi-day bookings rejected) | Both are **fixed** and now covered by regressions: `tests/concurrency/intervalBoundaries.test.js` → "CASE 11c (regression guard, reported as DEFECT-2)" and CASE 10c (maintenance block). See also US-35 and US-34. |
| 18 Oct 2026 | Defect **D-3** ( `checkBookingRules` reads snake_case `space.open_time`) | Still present and **latent**: every in-tree caller passes a raw row. Documented as a limitation; not fixed in this pass. |
| 18 Oct 2026 | Defect **D-4** (deactivated desks are not reactivated; codes accumulate) | Still present; counts remain correct. Documented as a limitation (US-23). |
| 18 Oct 2026 | Defect **D-5** (`occupancy.maintenance_block_id` lacks a `REFERENCES` clause) | Still present; harmless because maintenance blocks are never deleted. Documented (US-43). |
| 18 Oct 2026 | Banner claims "Lighthouse accessibility 1.00" | Historical claim from an earlier pass; **no accessibility audit was run** in the 18 October pass, so it is not re-verified. See US-58. |
