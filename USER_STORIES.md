# User Stories — Nagaro Space Booking System

**System:** Nagaro Space Booking and Rental Management System for **TRACE Expert City**, Maradana, Colombo, Sri Lanka.
**Repository:** `https://github.com/januththedev/Nagaro_Booking_System` (branch `main`).
**Compiled:** 18 October 2026, from the repository as it stands at commit
`a32f0f2444465efa42f2357a86077248fef8d50c`.
**Companion documents:** `ACCEPTANCE_CRITERIA.md`, `USER_STORY_TRACEABILITY.md`,
`REQUIREMENT_TEST_MATRIX.md` (the older `R-*` requirement IDs),
`docs/BOOKING_RULES.md` (business rules), `ARCHITECTURE.md`, `DATA_MODEL.md`.

---

## How to read this document

Each story carries a **stable ID** of the form `US-nn` and links to one or more
acceptance criteria of the form `AC-nn.m` (see `ACCEPTANCE_CRITERIA.md`).

### Roles

| Role | Meaning |
|---|---|
| **Customer / Public User** | An unauthenticated visitor or a client on whose behalf staff act. Has no account, submits requests only, and can never confirm a booking. |
| **Administrator** | An authenticated member of Nagaro staff. Sub-roles `ADMIN` and `STAFF` exist; only `ADMIN` may manage accounts. |
| **System** | The software acting on its own behalf (validation, the database guarantee, time zone maths, audit, email, etc.). |

### Priority

**Must** — core booking operation or data integrity. The system is not usable or
not trustworthy without it.
**Should** — important for a complete operational experience.
**Could** — useful, optional, or out of the current demo scope.

### Implementation status (applied identically in `USER_STORY_TRACEABILITY.md`)

- **Verified** — the behaviour exists in code **and** was actually exercised by
  the evidence named in the *Evidence* column.
- **Implemented, not verified** — the code exists, but no adequate verification
  evidence is available in this repository.
- **Partially implemented** — only some of the required behaviour exists.
- **Not implemented** — the capability is absent.
- **Blocked** — verification (or implementation) cannot proceed because of an
  identified external dependency.

> **Aggregation rule.** A story is assessed per acceptance criterion. The story
> status shown is the **most severe** status among its criteria, in the order
> `Not implemented` > `Blocked` > `Partially implemented` >
> `Implemented, not verified` > `Verified`. So a story is `Verified` only when
> **every** one of its criteria is verified.

### Two things this document deliberately does not do

1. It does not turn an aspiration into a completed feature. Where the code does
   not implement something, the status says so (e.g. **US-11**, **US-54**, **US-56**).
2. It does not repeat unverified claims from earlier reports. Where a behaviour
   was only ever checked by hand, the evidence column says *manual* explicitly.

### Scope note

The application is **locally demo-ready**. It has **not** been deployed to any
production host, and no live email has been sent. Stories **US-54**–**US-58**
record that boundary honestly rather than hiding it.

---

## Epic 1 — Space discovery

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-01** | **As a** customer, **I want** to browse a directory of the spaces the venue publishes, **so that** I can see what is available before contacting staff. | Must | AC-01.1, AC-01.2, AC-01.3 | **Verified** | `src/server/routes/publicRoutes.js` (`GET /spaces`, `selectPublicSpaces`); `src/web/views/publicViews.js`. `npm run test:e2e` → "GET /spaces -> 200"; `tests/unit/publicPrivacy.test.js` → "emits exactly the documented public keys". |
| **US-02** | **As a** customer, **I want** to filter and sort the directory by category, capacity, amenities, price and free text, **so that** I can narrow a long list to the spaces that fit my event. | Should | AC-02.1, AC-02.2, AC-02.3 | **Implemented, not verified** | `publicRoutes.js` `readDirectoryFilters()` / `spaceMatchesFilters()` / `sortPublicSpaces()`. No automated test exercises the filter combinations; a category filter was exercised manually in a browser during the earlier verification pass. |
| **US-03** | **As a** customer, **I want** to open a space and read its capacity, amenities, hourly/per-day rates, opening hours and photographs, **so that** I can judge whether it suits my event. | Must | AC-03.1, AC-03.2, AC-03.3 | **Verified** | `publicRoutes.js` `GET /spaces/:code`; `getSpaceByCode`. `npm run test:e2e` → "GET /spaces/:code -> 200", "detail shows no PII"; `tests/unit/publicPrivacy.test.js` → "a real published space projects cleanly, with real photographs". |
| **US-04** | **As the** venue, **I want** only published spaces to be visible and unpublished or unknown spaces to be indistinguishable from a 404, **so that** drafts and withdrawn inventory are never advertised. | Must | AC-04.1, AC-04.2 | **Implemented, not verified** | `findPublishedSpace()` returns `null` for any non-`PUBLISHED` space (`publicRoutes.js`). The published-only listing is exercised by `tests/unit/publicPrivacy.test.js` ("an unavailable space is represented, not invented") and `npm run test:e2e`. The specific "a DRAFT code returns 404" assertion is read from code, not asserted by a test. |

---

## Epic 2 — Booking requests and inquiries

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-05** | **As a** customer, **I want** to submit a booking request for a space, date and time window, **so that** the venue can consider my requirement. | Must | AC-05.1, AC-05.2, AC-05.3, AC-05.4 | **Verified** | `src/server/services/inquiryService.js` `createInquiry`; `src/server/routes/publicRoutes.js` `POST /booking-request`. `tests/integration/inquiryService.test.js` → "a valid submission persists a row with a unique INQ reference and honest email status"; `npm run test:e2e` → "POST inquiry -> 303". |
| **US-06** | **As a** customer, **I want** to be told that a request is **not** a confirmed booking and to receive a reference, **so that** I know what to expect and can follow up. | Must | AC-06.1, AC-06.2, AC-06.3 | **Verified** | `publicRoutes.js` `GET /booking-request/received`; `EMAIL_STATUS_NOTICE` in `publicViews.js`; `nextReference('INQ')` in `src/server/domain/references.js`. `npm run test:e2e` → "received page shows reference", "received page states NOT delivered (honest)". |
| **US-07** | **As a** customer, **I want** the form to tell me exactly which fields are wrong if my submission is invalid, **so that** I can correct it without guessing. | Must | AC-07.1, AC-07.2 | **Verified** | `src/server/domain/validation.js` `parseInquiryPayload`; `src/server/domain/errors.js`. `tests/integration/inquiryService.test.js` → "validation failures are reported per field and nothing is persisted". |
| **US-08** | **As the** venue, **I want** a submitted request to be stored durably even if the notification email fails, **so that** a request is never lost because of email trouble. | Must | AC-08.1, AC-08.2, AC-08.3 | **Verified** | `inquiryService.createInquiry` (commit → send → write-back); `src/server/mail/mailer.js`. `tests/integration/inquiryService.test.js` → "the email is attempted only after the row has been committed", "a throwing mailer is recorded as FAILED and the committed row survives". |
| **US-09** | **As a** customer, **I want** to withdraw my own request using the token issued to me, **so that** I can cancel a request I no longer need. | Should | AC-09.1, AC-09.2, AC-09.3 | **Verified** | `publicRoutes.js` `GET/POST /booking-request/withdraw`; `inquiryService.withdrawInquiry` (SHA-256 token compare). `tests/integration/inquiryService.test.js` → "withdrawal requires the matching token, is idempotent, and cannot be reopened"; `npm run test:e2e` → "POST withdraw -> 200 (confirmed)". |
| **US-10** | **As an** administrator, **I want** to review incoming requests in a queue that also shows whether the notification email was delivered, **so that** I can tell a genuine enquiry from one that was never notified. | Must | AC-10.1, AC-10.2, AC-10.3, AC-10.4 | **Implemented, not verified** | `src/server/routes/adminOpsRoutes.js` `GET /admin/inquiries`; `inquiryService.listInquiries`, `inquiryStats`. `npm run test:e2e` → "inquiry queue lists the reference"; `tests/integration/adminOpsRoutes.test.js`. **Limitation:** the `emailStatus` filter is applied to the newest 200 scanned rows (no delivery-state filter in the service); the page states this. |
| **US-11** | **As an** administrator, **I want** to turn an inquiry into a confirmed reservation, **so that** a request becomes a booking without re-typing the client's details. | Should | AC-11.1, AC-11.2, AC-11.3 | **Partially implemented** | **Works:** `GET /admin/reservations/new?inquiry=<id>` pre-fills space, date, times, desk count and customer details from the inquiry (`src/server/routes/adminBookingRoutes.js`), and `inquiryService.convertInquiryToReservation` exists and is unit-tested. **Gap:** no route ever calls `convertInquiryToReservation`, so `inquiry.converted_reservation_id` is never set and `POST /admin/inquiries/:id/status` refuses the `CONVERTED` transition (`adminOpsRoutes.js` L241). The inquiry therefore cannot reach `CONVERTED` through the user interface. Documented as a known gap; not fixed in this pass. |

---

## Epic 3 — Administrator authentication and dashboard

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-12** | **As an** administrator, **I want** to sign in with my email and password, **so that** I can reach the staff console. | Must | AC-12.1, AC-12.2, AC-12.3 | **Implemented, not verified** | `src/server/security/sessions.js` `authenticate`; `src/server/security/passwords.js`; `src/server/routes/authRoutes.js`. `npm run test:e2e` → "POST login -> 303", "session cookie set"; `tests/integration/adminUserService.test.js` → "deactivating a user revokes every session and blocks sign-in". |
| **US-13** | **As the** venue, **I want** every administrative page and API endpoint to require an authenticated session, **so that** client data is never exposed to an anonymous visitor. | Must | AC-13.1, AC-13.2 | **Verified** | `requireAuth` guard in `src/server/security/sessions.js`. `tests/integration/adminSpaceRoutes.test.js` → "an anonymous request is rejected and never reaches the catalogue"; `tests/integration/adminCustomerRoutes.test.js` → "GET ... without an actor returns 401", "redirected to the staff sign-in page"; `npm run test:e2e` → "GET /admin without session -> 303". |
| **US-14** | **As the** venue, **I want** repeated failed sign-ins to be throttled and the account temporarily locked, **so that** password guessing is impractical. | Must | AC-14.1, AC-14.2, AC-14.3 | **Implemented, not verified** | `sessions.js` `authenticate` (`MAX_FAILED_LOGINS = 8`, 15-minute lockout); `src/server/security/rateLimit.js` `enforceLoginLimits` (30/IP, 12/email per 15 min) with a `rate_limit_counter` table. No automated test drives the lockout or the login rate limit. |
| **US-15** | **As an** administrator, **I want** to sign out and change my own password, **so that** I control my access to the console. | Should | AC-15.1, AC-15.2, AC-15.3 | **Implemented, not verified** | `authRoutes.js` `GET/POST /admin/logout`, `POST /admin/account/password`; `sessions.js` `revokeSession`. `tests/integration/adminUserService.test.js` → "changeOwnPassword: checks the current password, keeps the caller session, revokes the rest". Sign-out itself has no dedicated automated assertion. |
| **US-16** | **As the** venue, **I want** role-based authorization that distinguishes administrators from ordinary staff, **so that** sensitive account actions are limited to administrators. | Must | AC-16.1, AC-16.2, AC-16.3 | **Verified** | `src/server/security/sessions.js` `requireAdmin`, `assertOwnAccountOrAdmin`; `src/server/services/adminUserService.js`. `tests/integration/adminUserService.test.js` → "setPassword: ADMIN only, no current password needed, revokes all target sessions", "last-admin protection: the only active administrator cannot be demoted or deactivated", "guests cannot create or modify accounts". |
| **US-17** | **As an** administrator, **I want** a dashboard that shows today's bookings, current occupancy, pending inquiries and utilisation, **so that** I get an operational picture in one glance. | Must | AC-17.1, AC-17.2, AC-17.3 | **Verified** | `src/server/services/dashboardService.js`; `src/server/routes/adminOpsRoutes.js` `GET /admin`, `GET /api/admin/dashboard/summary`. `tests/integration/dashboardService.test.js` → "dashboard summary, lists and utilisation all match independent SQL counts", "an empty database reports real zeroes, never invented numbers"; `npm run test:e2e` → "summary has activeSpaces". |

---

## Epic 4 — Space and pricing management

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-18** | **As an** administrator, **I want** to create a space with its category, capacity, location and hours, **so that** it can be configured and later published. | Must | AC-18.1, AC-18.2, AC-18.3 | **Implemented, not verified** | `src/server/services/spaceService.js` `createSpace`; `src/server/routes/adminSpaceRoutes.js` `POST /admin/spaces`; `src/server/domain/validation.js` `parseSpacePayload`. `tests/integration/adminSpaceRoutes.test.js` → "POST /admin/spaces creates exactly one row, stores the rates and redirects", "... with an invalid payload re-renders the form with 422 and creates nothing"; `npm run test:e2e` → "POST create space -> 303". |
| **US-19** | **As an** administrator, **I want** to edit an existing space, **so that** details, hours and rates stay accurate. | Must | AC-19.1, AC-19.2, AC-19.3 | **Implemented, not verified** | `spaceService.updateSpace`; `POST /admin/spaces/:id`. `tests/integration/adminSpaceRoutes.test.js` → "editing a space re-renders with 422 on bad input and updates it on success". |
| **US-20** | **As the** venue, **I want** a space to be impossible to publish until it is complete, **so that** the public directory never shows an empty or unpriced space. | Must | AC-20.1, AC-20.2, AC-20.3, AC-20.4 | **Verified** | `spaceService.publishabilityIssues` / `publishSpace` (requires ≥1 photograph, description ≥20 chars, short summary, location, ≥1 rate, ≥1 unit). `tests/unit/spacePublishGate.test.js` → "publishSpace refuses a space without a photograph and names the requirement", "publishing flips the status and stamps published_at, and is idempotent"; `tests/integration/adminSpaceRoutes.test.js` → "publishing without a photograph fails ... leaves the space in draft", "publishing succeeds once a photograph exists"; `npm run test:e2e` → "publish without photo -> 303 (blocked)", "space now PUBLISHED". |
| **US-21** | **As an** administrator, **I want** to upload, cover, reorder and delete a space's photographs, **so that** the public page shows accurate imagery. | Should | AC-21.1, AC-21.2, AC-21.3, AC-21.4 | **Verified** | `src/server/security/uploads.js`; `src/server/routes/adminUploadRoutes.js`; `spaceService.addImageRecord/deleteImage/setCoverImage/reorderImages`. `tests/unit/uploads.test.js` (24 tests); `tests/integration/mediaRoutes.test.js` → "admin image routes: guards, upload, cap, orphan cleanup, cover, reorder, delete and flash contract", "GET /media/<storedName> streams the exact bytes with inert, cacheable headers"; `tests/integration/adminSpaceRoutes.test.js` → "cover, reorder and delete act on the photograph records". |
| **US-22** | **As an** administrator, **I want** each space to be priced in the units its category allows, in Sri Lankan Rupees, **so that** quoted rates are correct and consistent. | Must | AC-22.1, AC-22.2, AC-22.3 | **Verified** | `src/server/domain/constants.js` `ALLOWED_PRICING_UNITS`; `spaceService.normaliseRates`; `src/server/services/pricingService.js` `formatMoney`. `tests/unit/spacePublishGate.test.js` → "rejects a co-working space priced per hour and accepts per day"; `tests/unit/bookingRulesTraceability.test.js` → R-BOOK-012/013/014/015/016 (billing quantities). |
| **US-23** | **As an** administrator, **I want** to set how many individually-bookable desks a co-working space has, **so that** concurrent desk rentals are counted correctly. | Should | AC-23.1, AC-23.2, AC-23.3 | **Implemented, not verified** | `spaceService.setDeskCount`, `syncUnits` (refuses to drop a desk holding active occupancy). `tests/concurrency/deskCapacity.test.js` (CASE 12–16); `tests/unit/spacePublishGate.test.js` → "is refused while a desk holds active occupancy and succeeds once it is free". |
| **US-24** | **As an** administrator, **I want** to archive a space and later restore it, **so that** inventory that is no longer offered leaves the live catalogue without being destroyed. | Should | AC-24.1, AC-24.2, AC-24.3 | **Verified** | `spaceService.archiveSpace` / `restoreSpace` (warns on upcoming occupancy). `tests/unit/spacePublishGate.test.js` → "archive then restore round-trips to draft and clears archived_at"; `tests/integration/adminSpaceRoutes.test.js` → "archive and restore round-trip over HTTP", "archiving warns when the space still carries upcoming occupancy". |

---

## Epic 5 — Reservation management

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-25** | **As an** administrator, **I want** to create a confirmed reservation for a customer, **so that** a vetted request becomes a real booking. | Must | AC-25.1, AC-25.2, AC-25.3, AC-25.4 | **Implemented, not verified** | `src/server/services/bookingService.js` `createReservation`; `POST /admin/reservations`. `npm run test:e2e` → "POST create reservation -> 303", "detail shows reference", "detail shows status"; `tests/concurrency/roomDoubleBooking.test.js`. |
| **US-26** | **As an** administrator, **I want** to move a reservation to a different time, space or desk count, **so that** a change of plan can be accommodated. | Must | AC-26.1, AC-26.2, AC-26.3 | **Implemented, not verified** | `bookingService.updateReservation`; `POST /admin/reservations/:id`. `tests/concurrency/concurrentEdit.test.js` (CASE 17–19); `npm run test:e2e` → "conflicting edit -> rejected", "original window preserved". |
| **US-27** | **As an** administrator, **I want** to cancel a reservation only with a written reason, releasing its inventory atomically, **so that** cancellations are accountable and the slot becomes bookable at once. | Must | AC-27.1, AC-27.2, AC-27.3, AC-27.4 | **Verified** | `bookingService.cancelReservation` (reason required, ≤1000 chars; occupancy released in the same transaction). `tests/concurrency/cancellationAndRetry.test.js` (CASE 20–23); `npm run test:e2e` → "blank reason -> 422 (rejected)", "cancel with reason -> 303", "status CANCELLED", "reason recorded", "second cancel -> rejected". |
| **US-28** | **As an** administrator, **I want** to browse and filter reservations by status and space, **so that** I can locate a booking quickly. | Must | AC-28.1, AC-28.2 | **Implemented, not verified** | `GET /admin/reservations` (`adminBookingRoutes.js`) with status/space filters. No automated test asserts the list contents or the filters. |
| **US-29** | **As an** administrator, **I want** to record customers and be warned when a similar one already exists, **so that** client records stay clean without silently merging people. | Should | AC-29.1, AC-29.2, AC-29.3, AC-29.4 | **Verified** | `src/server/services/customerService.js` `createCustomer`, `findPossibleDuplicates`; `adminCustomerRoutes.js`. `tests/unit/customerDuplicateDetection.test.js` (11 tests) → "duplicate detection reports and never writes"; `tests/integration/adminCustomerRoutes.test.js` → "POST /admin/customers with an existing email returns 422 and creates no second row", "the same POST with confirm_duplicate=1 creates the second row". |
| **US-30** | **As the** venue, **I want** past confirmed reservations to be marked completed automatically, **so that** the historical record stays accurate as time passes. | Should | AC-30.1, AC-30.2 | **Implemented, not verified** | `bookingService.reconcileCompletedReservations`, called at boot from `src/server/index.js` (`[db] marked N past reservation(s) as completed`). No automated test asserts the transition; the effect was observed in the boot log during manual runs. |
| **US-31** | **As an** administrator, **I want** a calendar view of occupancy per space, **so that** I can see the day at a glance. | Should | AC-31.1, AC-31.2, AC-31.3 | **Implemented, not verified** | `GET /admin/calendar`, `GET /api/admin/calendar/events`; `availabilityService.getSpaceDayGrid`. `npm run test:e2e` → "GET /admin/calendar -> 200", "GET /api/admin/calendar/events -> 200" (smoke only). The grid projection is partly covered by `tests/unit/publicPrivacy.test.js` → "the day projection is the exact documented shape, with no occupancy". |

---

## Epic 6 — Availability, maintenance and double-booking prevention

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-32** | **As the** venue, **I want** two overlapping confirmed reservations on the same single-capacity resource to be impossible, **so that** a room is never promised twice — even if the application check is bypassed. | Must | AC-32.1, AC-32.2, AC-32.3, AC-32.4 | **Verified** | `BEGIN IMMEDIATE` + `withWriteTransaction` (`src/server/db/connection.js`), `occupancy` BEFORE INSERT/UPDATE triggers (`db/migrations/0001_init.sql`). `tests/concurrency/roomDoubleBooking.test.js` (CASE 1–4: 8 processes × 10 rounds → exactly 1 winner); `tests/concurrency/triggerDirectWrite.test.js` (CASE 27–30); `tests/unit/bookingRulesTraceability.test.js` → R-SEC-012; `npm run demo:double-booking`. |
| **US-33** | **As the** venue, **I want** interval boundaries to be half-open and a configurable turnaround buffer honoured, **so that** back-to-back bookings behave predictably and rooms have time to turn over. | Must | AC-33.1, AC-33.2, AC-33.3, AC-33.4 | **Verified** | `src/server/domain/time.js` `intervalsOverlap`; `availabilityService.findConflicts` (`inflate` by `buffer_minutes`). `tests/concurrency/intervalBoundaries.test.js` (CASE 5–11); `tests/unit/bookingRulesTraceability.test.js` → R-AVAIL-001/002/003/012. |
| **US-34** | **As the** venue, **I want** opening hours, minimum/maximum duration and capacity to be enforced server-side, **so that** invalid bookings are refused before anything is written. | Must | AC-34.1, AC-34.2, AC-34.3, AC-34.4 | **Verified** | `availabilityService.checkBookingRules` / `assertBookingRules`. `tests/unit/bookingRulesTraceability.test.js` → R-AVAIL-004/005/006/017, R-BOOK-018; `tests/concurrency/intervalBoundaries.test.js` → CASE 11c (multi-day accepted), CASE 11d (before opening refused). |
| **US-35** | **As an** administrator, **I want** to block a space or individual desks for maintenance over a period, **so that** unavailable inventory cannot be booked. | Must | AC-35.1, AC-35.2, AC-35.3 | **Implemented, not verified** | `bookingService.createMaintenanceBlock`; `POST /admin/maintenance`. `tests/concurrency/intervalBoundaries.test.js` → CASE 10c, CASE 11b; `npm run test:e2e` → "POST maintenance -> 303". |
| **US-36** | **As an** administrator, **I want** to cancel a maintenance block, **so that** a space can return to service early. | Should | AC-36.1, AC-36.2, AC-36.3 | **Implemented, not verified** | `bookingService.cancelMaintenanceBlock`; `POST /admin/maintenance/:id/cancel`. No dedicated automated test. |
| **US-37** | **As the** venue, **I want** maintenance to occupy inventory exactly like a booking, **so that** it can never collide with a reservation. | Must | AC-37.1, AC-37.2, AC-37.3 | **Verified** | Maintenance writes `occupancy` rows with `source = 'MAINTENANCE'`; `findConflicts` compares them exactly (buffer not applied). `tests/concurrency/intervalBoundaries.test.js` → CASE 10b, CASE 10c, CASE 11b. |
| **US-38** | **As a** customer or administrator, **I want** an availability preview for a proposed period, **so that** I can choose a workable slot before committing. | Must | AC-38.1, AC-38.2, AC-38.3 | **Verified** | `availabilityService.getSpaceAvailability` / `getPublicAvailability` / `availabilityLabel`; public `GET /api/public/availability`, admin `GET /api/admin/availability`. `tests/unit/bookingRulesTraceability.test.js` → R-AVAIL-016 ("availability labels report counts, not optimism"); `tests/unit/publicPrivacy.test.js` → "counts the booked interval without naming anyone"; `npm run test:e2e` → "GET /api/public/availability -> 2xx". |

---

## Epic 7 — Timezone and currency handling

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-39** | **As the** venue, **I want** every instant stored as a UTC epoch-millisecond and displayed in Sri Lanka Standard Time, **so that** the database is unambiguous and staff see local times. | Must | AC-39.1, AC-39.2, AC-39.3 | **Verified** | `src/server/domain/time.js` (`BUSINESS_TZ = 'Asia/Colombo'`, `BUSINESS_TZ_OFFSET_MINUTES = 330`, `businessLocalToEpoch`, `businessDateKey`). `tests/unit/businessTimeZone.test.js`; `tests/integration/businessTimeZone.test.js` → "reservations, maintenance and availability share Asia/Colombo"; `tests/unit/bookingRulesTraceability.test.js` → R-AVAIL-001. |
| **US-40** | **As the** venue, **I want** Colombo-local date and time maths to be independent of the host machine's time zone, **so that** the same booking means the same instant on any server. | Must | AC-40.1, AC-40.2, AC-40.3 | **Verified** | `time.js` uses the fixed offset (no `Date`-local arithmetic). `tests/unit/businessTimeZone.test.js` → "calendar-day maths is independent of the server machine time zone", "dashboard calculations refuse any zone other than Asia/Colombo"; `tests/unit/dashboardTimeBuckets.test.js` → "business day: the naive UTC-midnight window is not the business day". A four-host-zone manual check (UTC, America/New_York, Pacific/Kiritimati, Asia/Colombo) was also recorded in `FINAL_READINESS_REPORT.md`. |
| **US-41** | **As the** venue, **I want** prices in Sri Lankan Rupees stored as integer minor units, **so that** rates are never corrupted by floating-point rounding or a stale currency code. | Must | AC-41.1, AC-41.2, AC-41.3 | **Verified** | `space.currency`/`reservation.currency` default `'LKR'` (`0001_init.sql`); `db/migrations/0003_currency_sri_lanka.sql` upgrades `ETB` → `LKR`; `pricingService.formatMoney` / `src/web/lib/html.js` `money`. No unit test asserts the formatted output; the LKR rate cards were observed manually in the demo. |

---

## Epic 8 — Notifications, auditing and security

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-42** | **As the** venue, **I want** the true email delivery state (`SENT`, `FAILED`, `NOT_CONFIGURED`, `PENDING`) recorded and shown, **so that** nobody is told an email was sent when it was not. | Must | AC-42.1, AC-42.2, AC-42.3, AC-42.4 | **Verified** | `src/server/mail/mailer.js` (no socket when `SMTP_HOST` unset); `inquiryService` writes the outcome back; `INQUIRY_EMAIL_STATUS`. `tests/unit/mailer.test.js` → "NOT_CONFIGURED: no SMTP_HOST means no connection attempt and an honest status", "FAILED: a throwing transport is reported, never thrown", "secrets: SMTP_PASS never appears in a reported delivery error"; `npm run test:e2e` → "received page states NOT delivered (honest)". |
| **US-43** | **As the** venue, **I want** every mutating operation to leave an audit entry written in the same transaction, **so that** the history cannot disagree with the data. | Must | AC-43.1, AC-43.2, AC-43.3 | **Implemented, not verified** | `src/server/services/auditService.js` `recordAudit`; called inside every write service; `GET /admin/audit`. `tests/integration/adminUserService.test.js` → "every mutation writes its audit entry"; `tests/integration/adminOpsRoutes.test.js`; `npm run test:e2e` → "GET /admin/audit -> 200". |
| **US-44** | **As a** customer, **I want** the public site to never reveal customer names, references or internal notes, **so that** client privacy is preserved. | Must | AC-44.1, AC-44.2, AC-44.3 | **Verified** | `availabilityService.getPublicAvailability`, `getSpaceDayGrid(..., { includeDetails: false })`; `publicRoutes.js` never imports `customerService`/`bookingService`. `tests/unit/publicPrivacy.test.js` → "catches reservation references but not inquiry references", "carries no staff-only fields and scrubs forbidden attribute keys"; `npm run test:e2e` → "detail shows no PII". |
| **US-45** | **As the** venue, **I want** every state-changing administrative request to carry a valid CSRF token, **so that** a third-party page cannot drive the console through a signed-in browser. | Must | AC-45.1, AC-45.2 | **Verified** | `sessions.js` `csrfTokenFor` / `verifyCsrf` / `requireCsrf`. `tests/integration/adminSpaceRoutes.test.js` → "a mutation without a valid CSRF token is rejected and writes nothing"; `tests/integration/router.test.js` → "security headers are present and cookies are serialised correctly". |
| **US-46** | **As the** venue, **I want** sessions to be stored as hashes, expire, idle-time out and be revocable, **so that** a database leak cannot be replayed as a live login. | Must | AC-46.1, AC-46.2, AC-46.3, AC-46.4 | **Implemented, not verified** | `sessions.js` (`hashToken`, 12 h TTL, 2 h idle timeout, `revokeSession`, `revokeAllSessionsForUser`). `tests/integration/adminUserService.test.js` → "deactivating a user revokes every session and blocks sign-in", "changeOwnPassword ... revokes the rest". |
| **US-47** | **As the** venue, **I want** security headers, a strict content-security policy, inert media responses and error pages free of stack traces, **so that** the console resists injection and leaks nothing internal. | Should | AC-47.1, AC-47.2, AC-47.3, AC-47.4 | **Verified** | `src/server/http/response.js` `applySecurityHeaders`; `src/server/http/router.js` error boundary. `tests/integration/router.test.js` → "internal errors never leak stack traces or SQL text", "applySecurityHeaders gives uploaded media an inert policy"; `npm run test:e2e` → "media has CSP sandbox", "media has nosniff". Verified manually in the earlier pass: `default-src 'self'` CSP, `X-Frame-Options: DENY`, 404 without a stack trace. |
| **US-48** | **As the** venue, **I want** all input validated and normalised server-side and uploads type-checked, **so that** malformed or hostile data never reaches the database or disk. | Must | AC-48.1, AC-48.2, AC-48.3, AC-48.4 | **Verified** | `src/server/domain/validation.js`; `src/server/security/uploads.js` (`sniffImageType`, magic-byte checks, 5 MB cap, 12-file cap). `tests/unit/uploads.test.js` (24 tests incl. "rejects a fake .png containing a PHP payload"); `tests/integration/router.test.js` → "oversized bodies are refused", "malformed JSON is rejected with 422, not a 500". |

---

## Epic 9 — Responsive usability and reliability

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-49** | **As a** customer or administrator, **I want** to use the system on desktop, tablet and mobile without horizontal scrolling or lost controls, **so that** I can book or manage from any device. | Must | AC-49.1, AC-49.2, AC-49.3 | **Implemented, not verified** | `src/web/public/styles.css` responsive rules. **Manual evidence only:** a responsive sweep in the earlier verification pass covered 15 routes × 1440/768/390 px with no horizontal overflow and no clipped detail lists; width-pinned renders were captured. No automated viewport test exists, so this is not marked Verified. |
| **US-50** | **As a** user, **I want** tables and detail lists to remain readable without clipping values or shredding words, **so that** I can read data on a narrow screen. | Should | AC-50.1, AC-50.2 | **Verified** | `styles.css`: `.data-table` cells use `overflow-wrap: break-word`; `.detail-list` label track is `minmax(0, min(10rem, 40%))`. `tests/unit/detailListLayout.test.js` → "two-column detail-list never lets the label track over-consume the container", "detail-list values can break long tokens instead of overflowing their track". |
| **US-51** | **As a** user, **I want** clear error messages and honest empty states, **so that** a failure is understandable and an empty database never shows invented numbers. | Should | AC-51.1, AC-51.2, AC-51.3 | **Verified** | `src/server/http/router.js` (`AppError` mapping, 404 handler); `dashboardService`. `tests/integration/router.test.js` → "error boundary maps AppError to JSON for API paths", "unknown paths fall through to the not-found handler", "thrown validation errors carry field details to the client"; `tests/integration/dashboardService.test.js` → "an empty database reports real zeroes, never invented numbers". |
| **US-52** | **As a** developer, **I want** the application to migrate, seed and start reproducibly with a documented command, **so that** a fresh clone runs the demo. | Must | AC-52.1, AC-52.2, AC-52.3 | **Implemented, not verified** | `src/server/index.js` (boot: migrate → reconcile → listen); `src/server/db/migrate.js`, `seed.js`; `tools/node.cmd`, `tools/npm.cmd`, `tools/git.cmd` resolve `NAGARO_NODE`/`NAGARO_GIT`/PATH. A production-mode smoke boot was executed manually and recorded in `FINAL_READINESS_REPORT.md` (`/`, `/spaces`, `/booking-request` → 200; `/admin` → 303). |
| **US-53** | **As a** developer, **I want** a reproducible automated test suite whose time-dependent probes do not fail by clock, **so that** results are trustworthy at any hour. | Must | AC-53.1, AC-53.2, AC-53.3 | **Verified** | `package.json` (`test`, `test:concurrency`, `test:e2e`); `scripts/e2e-verify.js` now uses `SLST_OFFSET_MS`/`slstWindow()` for a deterministic 10:00–12:00 SLST availability probe. Suites run green (see `USER_STORY_TRACEABILITY.md`). |

---

## Epic 10 — Production readiness and accessibility (outside the demo scope)

These stories exist so that the boundary between *locally demo-ready* and
*production* is explicit and auditable. None of them is satisfied by the demo
deployment.

| ID | User story | Priority | Acceptance criteria | Status | Evidence / notes |
|---|---|---|---|---|---|
| **US-54** | **As the** venue, **I want** to persist to PostgreSQL in production, **so that** data survives an ephemeral host. | Could | AC-54.1, AC-54.2 | **Not implemented** | `db/migrations-postgres/0001_init.sql` provides equivalent DDL and `pg` is a declared dependency, but **no runtime code path loads it**: `src/server/db/connection.js` opens a local `node:sqlite` file only. Documented in `ARCHITECTURE.md` and `FINAL_READINESS_REPORT.md`. |
| **US-55** | **As the** venue, **I want** uploaded photographs stored in durable object storage in production, **so that** images survive across deployments. | Could | AC-55.1, AC-55.2 | **Implemented, not verified** | The adapter **is** wired: `src/server/security/uploads.js` imports `blobEnabled`/`storeBlob`, and `adminUploadRoutes.js` imports `deleteBlob`; it activates only when `BLOB_READ_WRITE_TOKEN` is set (`src/server/security/blobStorage.js`). No test exercises the remote Vercel Blob path, and the local demo uses the filesystem. |
| **US-56** | **As the** venue, **I want** the application deployed to a production host, **so that** the public can actually book. | Could | AC-56.1, AC-56.2 | **Not implemented** | There is no `vercel.json`, no `api/` entry point and no serverless handler; `src/server/index.js` is a long-running `node:http` server writing a local SQLite file and a local uploads folder. No deployment has been performed. |
| **US-57** | **As the** venue, **I want** notification email delivered over a real SMTP server, **so that** staff are actually alerted to new requests. | Should | AC-57.1, AC-57.2 | **Blocked** | The delivery machinery is implemented and tested through transport seams (`tests/unit/mailer.test.js`), but no SMTP credentials/server are configured, so real delivery cannot be verified. Boot reports `email status: NOT configured`; inquiries are still stored and flagged undelivered. |
| **US-58** | **As a** user with a disability, **I want** the interface to meet WCAG 2.1 AA, **so that** I can use the system with assistive technology. | Should | AC-58.1, AC-58.2 | **Implemented, not verified** | Forms use labelled controls, tables live in focusable scroll containers, and document structure is semantic, but **no accessibility audit was run** in this pass (no axe/Lighthouse/WCAG tool output is available). No accessibility score is claimed. |

---

## Story inventory

| Epic | Stories | IDs |
|---|---|---|
| 1 Space discovery | 4 | US-01 – US-04 |
| 2 Booking requests and inquiries | 7 | US-05 – US-11 |
| 3 Administrator authentication and dashboard | 6 | US-12 – US-17 |
| 4 Space and pricing management | 7 | US-18 – US-24 |
| 5 Reservation management | 7 | US-25 – US-31 |
| 6 Availability, maintenance and double-booking prevention | 7 | US-32 – US-38 |
| 7 Timezone and currency handling | 3 | US-39 – US-41 |
| 8 Notifications, auditing and security | 7 | US-42 – US-48 |
| 9 Responsive usability and reliability | 5 | US-49 – US-53 |
| 10 Production readiness and accessibility | 5 | US-54 – US-58 |
| **Total** | **58** | |

## Status summary

| Status | Stories |
|---|---|
| Verified | 32 |
| Implemented, not verified | 22 |
| Partially implemented | 1 (US-11) |
| Not implemented | 2 (US-54, US-56) |
| Blocked | 1 (US-57) |
| **Total** | **58** |

### Notes on the downgraded stories

These stories have working, readable implementations, but at least one of their
criteria lacks adequate evidence, so they are **not** marked Verified. Fixing
them is a *testing* task, not a feature task.

| Story | Why it is not Verified |
|---|---|
| US-02 | Directory filter/sort combinations have no automated test; only a manual category filter was exercised. |
| US-04 | The "a DRAFT/ARCHIVED code returns 404" assertion is read from code, not asserted. |
| US-10 | The `emailStatus` queue filter is untested (and capped at 200 scanned rows, which the page states). |
| US-12 | No test drives a wrong password or the generic refusal (disabled accounts *are* tested). |
| US-14 | Lockout and login rate limiting are implemented but untested. |
| US-15 | Sign-out has no dedicated automated assertion (password management is tested). |
| US-18 | Duplicate space code is refused in code but untested. |
| US-19 | The "category cannot change under active occupancy" guard is untested. |
| US-23 | "Only co-working spaces have a desk inventory" is untested (desk capacity and occupancy guards *are* tested). |
| US-25 | Missing space/customer validation on the reservation route is untested. |
| US-26 | "Cancelled reservations cannot be edited" is untested (concurrent edit *is* tested). |
| US-35 | A blank maintenance reason is refused in code but untested. |
| US-36 | Maintenance-block cancellation has no automated test. |
| US-43 | Same-transaction atomicity of the audit row is by construction, not asserted. |
| US-46 | Hash-only token storage, session TTL and idle timeout are untested (revocation *is* tested). |
| US-49 | The responsive sweep was manual; there is no automated viewport test. |
| US-52 | Migration idempotency (re-running against a migrated database) is not asserted. |
| US-55 | The durable-storage adapter is wired but never exercised (no object-store token). |
| US-58 | No accessibility audit was run. |

