# User Story → Acceptance Criteria → Implementation → Test Traceability

**System:** Nagaro Space Booking and Rental Management System for **TRACE Expert City**, Colombo, Sri Lanka.
**Repository:** `https://github.com/januththedev/Nagaro_Booking_System` (branch `main`).
**Assessed at commit:** `a32f0f2444465efa42f2357a86077248fef8d50c`.
**Companion documents:** `USER_STORIES.md`, `ACCEPTANCE_CRITERIA.md`,
`REQUIREMENT_TEST_MATRIX.md` (the older `R-*` scheme, kept as a historical
snapshot with a cross-reference added).

---

## How to read this matrix

One row per acceptance criterion. Every row names where the behaviour lives in
code, what test (if any) exercises it, and an honest status.

### Status vocabulary (exactly one per row)

| Status | Means |
|---|---|
| **Verified** | The implementation exists **and** the behaviour was actually exercised by the evidence named — either an automated test, or a manual observation that is recorded in a repository document. |
| **Implemented, not verified** | The code exists, but no adequate verification evidence is available. |
| **Partially implemented** | Only some of the required behaviour exists. |
| **Not implemented** | The capability is absent. |
| **Blocked** | Verification (or implementation) cannot proceed because of an identified external dependency. |

### Verification-method vocabulary

- **unit / integration** — `npm test` (`tests/unit/**`, `tests/integration/**`).
- **concurrency** — `npm run test:concurrency` (`tests/concurrency/**`).
- **e2e** — `npm run test:e2e` (`scripts/e2e-verify.js`, a real HTTP harness).
- **manual** — driven by hand in a browser or against the running server; the
  observation is recorded in `FINAL_READINESS_REPORT.md`, `PROGRESS.md` or
  `UI_UX_IMPLEMENTATION_REPORT.md`. Manual evidence is labelled as such and is
  never presented as an automated result.

> A passing unit test alone does not prove an entire end-to-end story is
> verified. `SELECT`-only code paths and claims that rest on a code comment are
> marked `Implemented, not verified`, not `Verified`.

### Status summary

| Status | Criteria |
|---|---|
| Verified | 133 |
| Implemented, not verified | 36 |
| Partially implemented | 1 |
| Not implemented | 4 |
| Blocked | 2 |
| **Total** | **176** |

### Story summary (aggregate; see the rule in `USER_STORIES.md`)

| Status | Stories |
|---|---|
| Verified | 32 |
| Implemented, not verified | 22 |
| Partially implemented | 1 |
| Not implemented | 2 |
| Blocked | 1 |
| **Total** | **58** |

---

## Epic 1 — Space discovery

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-01 | AC-01.1 | `src/server/routes/publicRoutes.js` (`GET /spaces`, `selectPublicSpaces`) | e2e "GET /spaces -> 200" | Verified | Directory renders every published space. |
| US-01 | AC-01.2 | `src/web/views/publicViews.js`; `spaceService.hydrateSpace` | unit publicPrivacy "a real published space projects cleanly"; manual | Verified | Name, category, capacity and LKR rate summary rendered; observed manually. |
| US-01 | AC-01.3 | `publicRoutes.js` (no auth middleware on `/spaces`) | e2e "GET /spaces -> 200" | Verified | Reached with no session cookie. |
| US-02 | AC-02.1 | `publicRoutes.js` `readDirectoryFilters` / `spaceMatchesFilters` | none | Implemented, not verified | Filter applied in code; only a manual category filter has been exercised. |
| US-02 | AC-02.2 | `spaceMatchesFilters` (min capacity, amenities, pricing unit) | none | Implemented, not verified | AND-combination logic present; untested. |
| US-02 | AC-02.3 | `sortPublicSpaces` (`name`/`capacity`/`price`) | none | Implemented, not verified | Deterministic sort present; untested. |
| US-03 | AC-03.1 | `publicRoutes.js` `GET /spaces/:code`; `findPublishedSpace` | e2e "GET /spaces/:code -> 200" | Verified | — |
| US-03 | AC-03.2 | `publicViews.js`; `spaceService.hydrateSpace` | unit publicPrivacy "photographs keep only id, url, altText and isCover"; manual | Verified | Capacity, amenities, hours and rate card rendered. |
| US-03 | AC-03.3 | `publicRoutes.js` (never imports `bookingService`/`customerService`) | e2e "detail shows no PII" | Verified | No customer name or reservation reference in the HTML. |
| US-04 | AC-04.1 | `selectPublicSpaces` fixes `status = PUBLISHED` | unit publicPrivacy "an unavailable space is represented, not invented" | Verified | DRAFT/ARCHIVED never listed. |
| US-04 | AC-04.2 | `findPublishedSpace` returns `null` for non-published | none | Implemented, not verified | The guard is visible in code; no test asserts the 404 for a DRAFT code. |

## Epic 2 — Booking requests and inquiries

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-05 | AC-05.1 | `src/server/services/inquiryService.js` `createInquiry`; `POST /booking-request` | integration inquiryService "a valid submission persists a row with a unique INQ reference"; e2e "POST inquiry -> 303" | Verified | — |
| US-05 | AC-05.2 | `inquiryService` (never writes `occupancy`) | concurrency transactionIntegrity (no occupancy on non-reservation writes) | Verified | A request creates no occupancy row. |
| US-05 | AC-05.3 | `src/server/domain/validation.js` `parseInquiryPayload` | integration inquiryService "validation failures are reported per field and nothing is persisted" | Verified | — |
| US-05 | AC-05.4 | `inquiryService.createInquiry` (throws before reporting success) | concurrency transactionIntegrity CASE 25a/25b | Verified | A failed write leaves no row and the caller sees an error, not success. |
| US-06 | AC-06.1 | `src/server/domain/references.js` `nextReference('INQ')` | integration inquiryService "a valid submission persists a row with a unique INQ reference" | Verified | `INQ-YYYY-NNNNN`. |
| US-06 | AC-06.2 | `publicRoutes.js` `GET /booking-request/received`; `EMAIL_STATUS_NOTICE` in `publicViews.js` | e2e "received page states NOT delivered (honest)" | Verified | Wording: this is a request, not a confirmed booking; "this check does not hold the space". |
| US-06 | AC-06.3 | `publicRoutes.js` (no path creates a reservation) | e2e (no correlation between inquiry and reservations) | Verified | Nothing converts an inquiry into a confirmed reservation automatically. |
| US-07 | AC-07.1 | `validation.js`; `src/server/domain/errors.js` | integration inquiryService "validation failures are reported per field" | Verified | — |
| US-07 | AC-07.2 | `inquiryService` | integration inquiryService "validation failures ... nothing is persisted" | Verified | — |
| US-08 | AC-08.1 | `inquiryService.createInquiry` (commit → send → write-back) | integration inquiryService "the email is attempted only after the row has been committed" | Verified | — |
| US-08 | AC-08.2 | `inquiryService`; `src/server/mail/mailer.js` | integration inquiryService "a throwing mailer is recorded as FAILED and the committed row survives" | Verified | — |
| US-08 | AC-08.3 | `inquiryService` (PENDING default) | integration inquiryService (email status written back in a second transaction) | Verified | Crash window leaves `PENDING`. |
| US-09 | AC-09.1 | `publicRoutes.js` `POST /booking-request/withdraw`; `inquiryService.withdrawInquiry` | integration inquiryService "withdrawal requires the matching token, is idempotent"; e2e "POST withdraw -> 200 (confirmed)" | Verified | — |
| US-09 | AC-09.2 | `inquiryService.withdrawInquiry` (`timingSafeEqual`) | integration inquiryService same test | Verified | — |
| US-09 | AC-09.3 | `inquiryService.withdrawInquiry` | integration inquiryService "cannot be reopened" | Verified | — |
| US-10 | AC-10.1 | `src/server/routes/adminOpsRoutes.js` `GET /admin/inquiries`; `inquiryService.listInquiries` | e2e "inquiry queue lists the reference"; integration adminOpsRoutes | Verified | — |
| US-10 | AC-10.2 | `inquiryService.inquiryStats`; `opsViews.js` | integration inquiryService "inquiryStats ... undelivered email honestly" | Verified | Delivery state displayed (`SENT`/`FAILED`/`NOT_CONFIGURED`/`PENDING`). |
| US-10 | AC-10.3 | `adminOpsRoutes.js` `emailStatus` filter over the newest 200 rows | none | Implemented, not verified | No test exercises the queue filters. |
| US-10 | AC-10.4 | `adminOpsRoutes.js` (states the 200-row scan bound) | integration inquiryService "inquiryStats counts ... honestly" | Verified | Counts derive from scanned rows; the page states the cap. |
| US-11 | AC-11.1 | `adminBookingRoutes.js` `GET /admin/reservations/new?inquiry=` | integration adminCustomerRoutes "GET /admin/customers/new pre-fills from an inquiry" | Verified | Space, window, desk count, customer details pre-filled. |
| US-11 | AC-11.2 | `inquiryService.convertInquiryToReservation` — **no route calls it** | integration inquiryService "convertInquiryToReservation links an existing reservation and flips the status" | Partially implemented | The service works and is tested, but nothing invokes it, so `converted_reservation_id` is never set in the running app. |
| US-11 | AC-11.3 | `adminOpsRoutes.js` L241 (refuses `CONVERTED` without a link) | none | Implemented, not verified | The guard exists; untested. |

## Epic 3 — Administrator authentication and dashboard

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-12 | AC-12.1 | `src/server/security/sessions.js` `authenticate`; `authRoutes.js` `POST /admin/login` | e2e "POST login -> 303", "session cookie set" | Verified | — |
| US-12 | AC-12.2 | `sessions.js` `authenticate` `genericFailure()` | none | Implemented, not verified | Generic "email or password is incorrect" is in code; no test drives a wrong password. |
| US-12 | AC-12.3 | `sessions.js` (`is_active !== 1` → forbidden) | integration adminUserService "deactivating a user ... blocks sign-in" | Verified | — |
| US-13 | AC-13.1 | `sessions.js` `requireAuth`; admin route middleware | integration adminSpaceRoutes "an anonymous request is rejected"; e2e "GET /admin without session -> 303" | Verified | — |
| US-13 | AC-13.2 | `requireAuth` for API paths | integration adminCustomerRoutes "GET /api/admin/customers/search without an actor returns 401"; e2e "GET /api/admin/dashboard/summary without session -> 401" | Verified | — |
| US-14 | AC-14.1 | `sessions.js` (`failed_logins` counter) | none | Implemented, not verified | — |
| US-14 | AC-14.2 | `sessions.js` (`MAX_FAILED_LOGINS = 8`, `LOCKOUT_MS = 15 min`) | none | Implemented, not verified | — |
| US-14 | AC-14.3 | `src/server/security/rateLimit.js` `enforceLoginLimits` | none | Implemented, not verified | Limits exist (30/IP, 12/email per 15 min); untested. |
| US-15 | AC-15.1 | `authRoutes.js` `POST /admin/logout`; `sessions.js` `revokeSession` | none | Implemented, not verified | Sign-out has no dedicated automated assertion. |
| US-15 | AC-15.2 | `authRoutes.js` `POST /admin/account/password` | integration adminUserService "changeOwnPassword: checks the current password" | Verified | — |
| US-15 | AC-15.3 | `sessions.js` `revokeAllSessionsForUser` | integration adminUserService "changeOwnPassword ... revokes the rest" | Verified | The caller's session survives; the others are revoked. |
| US-16 | AC-16.1 | `sessions.js` `requireAdmin` | integration adminUserService "setPassword: ADMIN only" | Verified | — |
| US-16 | AC-16.2 | `adminUserService` last-admin protection | integration adminUserService "last-admin protection" | Verified | — |
| US-16 | AC-16.3 | `sessions.js`; `adminUserService` guards | integration adminUserService "guests cannot create or modify accounts" | Verified | — |
| US-17 | AC-17.1 | `src/server/services/dashboardService.js` | integration dashboardService "dashboard summary, lists and utilisation all match independent SQL counts" | Verified | — |
| US-17 | AC-17.2 | `dashboardService` | integration dashboardService "an empty database reports real zeroes" | Verified | — |
| US-17 | AC-17.3 | `adminOpsRoutes.js` `GET /api/admin/dashboard/summary` | e2e "summary has activeSpaces" | Verified | — |

## Epic 4 — Space and pricing management

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-18 | AC-18.1 | `src/server/services/spaceService.js` `createSpace`; `POST /admin/spaces` | integration adminSpaceRoutes "POST /admin/spaces creates exactly one row"; e2e "POST create space -> 303" | Verified | — |
| US-18 | AC-18.2 | `validation.js` `parseSpacePayload`; `POST /admin/spaces` | integration adminSpaceRoutes "... invalid payload re-renders the form with 422" | Verified | — |
| US-18 | AC-18.3 | `spaceService.createSpace` (duplicate code check) | none | Implemented, not verified | Conflict thrown in code; no test covers a duplicate space code. |
| US-19 | AC-19.1 | `spaceService.updateSpace`; `POST /admin/spaces/:id` | integration adminSpaceRoutes "editing a space ... updates it on success" | Verified | — |
| US-19 | AC-19.2 | `updateSpace`; `POST /admin/spaces/:id` | integration adminSpaceRoutes "editing a space re-renders with 422 on bad input" | Verified | — |
| US-19 | AC-19.3 | `updateSpace` (refuses category change under active occupancy) | none | Implemented, not verified | Guard in code; untested. |
| US-20 | AC-20.1 | `spaceService.publishabilityIssues` / `publishSpace` | unit spacePublishGate "refuses a space without a photograph"; integration adminSpaceRoutes "publishing without a photograph fails"; e2e "publish without photo -> 303 (blocked)" | Verified | — |
| US-20 | AC-20.2 | `publishabilityIssues` | unit spacePublishGate; integration adminSpaceRoutes | Verified | Every unmet requirement is listed. |
| US-20 | AC-20.3 | `publishSpace` | unit spacePublishGate "publishing flips the status and stamps published_at"; e2e "space now PUBLISHED" | Verified | — |
| US-20 | AC-20.4 | `publishSpace` (early return when already published) | unit spacePublishGate "publishing ... is idempotent" | Verified | — |
| US-21 | AC-21.1 | `src/server/security/uploads.js` `storeImage`; `POST /admin/spaces/:id/images` | unit uploads "storeImage writes the bytes under a random 32-hex stored name"; integration mediaRoutes "admin image routes" | Verified | — |
| US-21 | AC-21.2 | `uploads.js` `sniffImageType` / `assertUploadableImage` | unit uploads "rejects a fake .png containing a PHP payload" | Verified | Magic-byte check, not the declared type. |
| US-21 | AC-21.3 | `spaceService.setCoverImage` / `reorderImages` / `deleteImage` | integration mediaRoutes "cover, reorder, delete"; integration adminSpaceRoutes "cover, reorder and delete" | Verified | — |
| US-21 | AC-21.4 | `spaceService.addImageRecord` (12-photo cap); `uploads.js` batch cap | unit uploads "caps the batch: the 13th file is rejected as overflow" | Verified | — |
| US-22 | AC-22.1 | `constants.js` `ALLOWED_PRICING_UNITS`; `spaceService.normaliseRates` | unit spacePublishGate "rejects a co-working space priced per hour and accepts per day" | Verified | — |
| US-22 | AC-22.2 | `normaliseRates` (`Math.round(... * 100)`) | unit bookingRulesTraceability R-BOOK-012/013 (cents arithmetic) | Verified | — |
| US-22 | AC-22.3 | `src/server/services/pricingService.js` `formatMoney`; `src/web/lib/html.js` `money` | manual | Verified | LKR rate cards observed in the running demo; `formatMoney` defaults to LKR. |
| US-23 | AC-23.1 | `spaceService.setDeskCount` / `syncUnits` | concurrency deskCapacity CASE 12 "20 processes ... 20 distinct desks" | Verified | — |
| US-23 | AC-23.2 | `syncUnits` (refuses to drop an occupied desk) | unit spacePublishGate "is refused while a desk holds active occupancy" | Verified | — |
| US-23 | AC-23.3 | `setDeskCount` (rejects non-co-working spaces) | none | Implemented, not verified | Field error in code; untested. |
| US-24 | AC-24.1 | `spaceService.archiveSpace`; `POST /admin/spaces/:id/archive` | unit spacePublishGate; integration adminSpaceRoutes "archive and restore round-trip over HTTP" | Verified | — |
| US-24 | AC-24.2 | `archiveSpace` (returns `upcomingOccupancy`) | integration adminSpaceRoutes "archiving warns when the space still carries upcoming occupancy" | Verified | — |
| US-24 | AC-24.3 | `spaceService.restoreSpace` | unit spacePublishGate "archive then restore round-trips to draft" | Verified | — |

## Epic 5 — Reservation management

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-25 | AC-25.1 | `src/server/services/bookingService.js` `createReservation`; `POST /admin/reservations` | e2e "POST create reservation -> 303"; concurrency roomDoubleBooking CASE 3 | Verified | — |
| US-25 | AC-25.2 | `availabilityService.allocateUnits` | concurrency roomDoubleBooking CASE 1–4; deskCapacity CASE 12 | Verified | — |
| US-25 | AC-25.3 | `createReservation` (missing space/customer → validation error) | none | Implemented, not verified | No integration test exists for the reservation routes' negative paths. |
| US-25 | AC-25.4 | `createReservation` → `DoubleBookingError` | concurrency roomDoubleBooking CASE 1–4; e2e "conflicting POST -> rejected" | Verified | — |
| US-26 | AC-26.1 | `bookingService.updateReservation`; `POST /admin/reservations/:id` | concurrency concurrentEdit CASE 17 | Verified | — |
| US-26 | AC-26.2 | `updateReservation` (rolls back on conflict) | concurrency concurrentEdit CASE 17; e2e "conflicting edit -> rejected", "original window preserved" | Verified | — |
| US-26 | AC-26.3 | `updateReservation` (refuses edits to CANCELLED) | none | Implemented, not verified | Guard in code; untested. |
| US-27 | AC-27.1 | `bookingService.cancelReservation` (reason required) | concurrency cancellationAndRetry CASE 23; e2e "blank reason -> 422 (rejected)" | Verified | — |
| US-27 | AC-27.2 | `cancelReservation` (releases occupancy in the same transaction) | concurrency cancellationAndRetry CASE 20, CASE 22; e2e "cancel with reason -> 303" | Verified | — |
| US-27 | AC-27.3 | `cancelReservation` (stores `cancellation_reason`) | e2e "reason recorded" | Verified | — |
| US-27 | AC-27.4 | `cancelReservation` (refuses double cancellation) | e2e "second cancel -> rejected (409)"; concurrency cancellationAndRetry CASE 20 | Verified | — |
| US-28 | AC-28.1 | `adminBookingRoutes.js` `GET /admin/reservations` | none | Implemented, not verified | No test asserts the reservation list. |
| US-28 | AC-28.2 | `GET /admin/reservations` status/space filters | none | Implemented, not verified | Untested. |
| US-29 | AC-29.1 | `customerService.createCustomer`; `POST /admin/customers` | integration adminCustomerRoutes "with a fresh email creates the customer" | Verified | — |
| US-29 | AC-29.2 | `customerService.findPossibleDuplicates` / `createCustomer` | integration adminCustomerRoutes "existing email returns 422 and creates no second row"; unit customerDuplicateDetection | Verified | Never merges silently. |
| US-29 | AC-29.3 | `createCustomer` `allowDuplicate`; `confirm_duplicate` | integration adminCustomerRoutes "the same POST with confirm_duplicate=1 creates the second row" | Verified | — |
| US-29 | AC-29.4 | `customerDuplicateDetection` reads only | unit customerDuplicateDetection "duplicate detection reports and never writes" | Verified | — |
| US-30 | AC-30.1 | `bookingService.reconcileCompletedReservations`; called in `src/server/index.js` | none | Implemented, not verified | Transition observed in the boot log manually; no automated assertion. |
| US-30 | AC-30.2 | `reconcileCompletedReservations` (only past end times) | none | Implemented, not verified | — |
| US-31 | AC-31.1 | `adminBookingRoutes.js` `GET /admin/calendar` | e2e "GET /admin/calendar -> 200" | Verified | Smoke only. |
| US-31 | AC-31.2 | `GET /api/admin/calendar/events` | e2e "GET /api/admin/calendar/events -> 200" (smoke) | Implemented, not verified | Only the status code is asserted, not the event contents. |
| US-31 | AC-31.3 | `availabilityService.getSpaceDayGrid` | unit publicPrivacy "the day projection is the exact documented shape, with no occupancy" | Verified | — |

## Epic 6 — Availability, maintenance and double-booking prevention

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-32 | AC-32.1 | `bookingService.createReservation` inside `withWriteTransaction` | concurrency roomDoubleBooking CASE 1–4 | Verified | 10 rounds × 8 processes → exactly 1 winner. |
| US-32 | AC-32.2 | `occupancy` triggers in `db/migrations/0001_init.sql` | concurrency triggerDirectWrite CASE 27–28; unit bookingRulesTraceability R-SEC-012 | Verified | Direct INSERT/UPDATE rejected. |
| US-32 | AC-32.3 | `src/server/db/connection.js` `BEGIN IMMEDIATE` + `busy_timeout` | concurrency roomDoubleBooking, concurrentEdit, transactionIntegrity | Verified | — |
| US-32 | AC-32.4 | `withWriteTransaction` rollback | concurrency transactionIntegrity CASE 24–26, CASE 31 | Verified | — |
| US-33 | AC-33.1 | `availabilityService.findConflicts`; `time.js` `intervalsOverlap` | concurrency intervalBoundaries CASE 5, CASE 8; unit bookingRulesTraceability R-AVAIL-003 | Verified | — |
| US-33 | AC-33.2 | `findConflicts` | concurrency intervalBoundaries CASE 6, CASE 7 | Verified | — |
| US-33 | AC-33.3 | `findConflicts` (`inflate` by `buffer_minutes`) | concurrency intervalBoundaries CASE 10a | Verified | — |
| US-33 | AC-33.4 | `findConflicts` (maintenance compared exactly) | concurrency intervalBoundaries CASE 10b | Verified | — |
| US-34 | AC-34.1 | `availabilityService.checkBookingRules` | unit bookingRulesTraceability R-AVAIL-004 | Verified | Message names SLST and the date. |
| US-34 | AC-34.2 | `checkBookingRules` | unit bookingRulesTraceability R-AVAIL-005 | Verified | — |
| US-34 | AC-34.3 | `checkBookingRules` | unit bookingRulesTraceability R-AVAIL-006 | Verified | — |
| US-34 | AC-34.4 | `checkBookingRules` (capacity) | unit bookingRulesTraceability R-BOOK-018 | Verified | — |
| US-35 | AC-35.1 | `bookingService.createMaintenanceBlock` (reason required) | none | Implemented, not verified | Field error in code; no test drives a blank reason. |
| US-35 | AC-35.2 | `createMaintenanceBlock` (writes occupancy, source MAINTENANCE) | concurrency intervalBoundaries CASE 10c, CASE 11b | Verified | — |
| US-35 | AC-35.3 | `findConflicts` (booking over maintenance refused) | concurrency intervalBoundaries CASE 10c, CASE 11b | Verified | — |
| US-36 | AC-36.1 | `bookingService.cancelMaintenanceBlock` | none | Implemented, not verified | — |
| US-36 | AC-36.2 | `cancelMaintenanceBlock` (refuses double cancellation) | none | Implemented, not verified | — |
| US-36 | AC-36.3 | `cancelMaintenanceBlock` (not found) | none | Implemented, not verified | — |
| US-37 | AC-37.1 | `findConflicts` (occupancy is occupancy) | concurrency intervalBoundaries CASE 10c | Verified | — |
| US-37 | AC-37.2 | `withWriteTransaction` + triggers | concurrency intervalBoundaries CASE 11b | Verified | 1 booking + 3 maintenance blocks race → exactly 1 wins. |
| US-37 | AC-37.3 | `cancelMaintenanceBlock` releases occupancy | concurrency intervalBoundaries CASE 10c | Verified | — |
| US-38 | AC-38.1 | `availabilityService.getPublicAvailability` | unit publicPrivacy "counts the booked interval without naming anyone" | Verified | — |
| US-38 | AC-38.2 | `availabilityService.availabilityLabel` | unit bookingRulesTraceability R-AVAIL-016 | Verified | — |
| US-38 | AC-38.3 | `getPublicAvailability` (read-only) | unit publicPrivacy "a free interval reports counts and no blocked periods" | Verified | — |

## Epic 7 — Timezone and currency handling

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-39 | AC-39.1 | `src/server/domain/time.js`; schema (`INTEGER` epoch-ms columns) | unit businessTimeZone; unit bookingRulesTraceability R-AVAIL-001 | Verified | No wall-clock strings stored. |
| US-39 | AC-39.2 | `time.js` `BUSINESS_TZ`, `BUSINESS_TZ_OFFSET_MINUTES = 330` | unit businessTimeZone "business time zone is Asia/Colombo at a fixed UTC+05:30" | Verified | — |
| US-39 | AC-39.3 | `time.js` `businessLocalToEpoch` / `businessDateTimeLabel` | unit businessTimeZone "a Colombo-local date/time maps to the correct UTC instant"; "midnight and the half-hour offset are handled exactly" | Verified | — |
| US-40 | AC-40.1 | `time.js` (fixed offset; no host-zone arithmetic) | unit businessTimeZone "calendar-day maths is independent of the server machine time zone"; manual (4 host zones) | Verified | Manual check recorded in `FINAL_READINESS_REPORT.md`. |
| US-40 | AC-40.2 | `dashboardService.hourlyBuckets` | unit dashboardTimeBuckets "a 23:00 SLST booking lands on day N, not day N+1" | Verified | — |
| US-40 | AC-40.3 | `dashboardService` (asserts the business zone) | unit businessTimeZone "dashboard calculations refuse any zone other than Asia/Colombo" | Verified | — |
| US-41 | AC-41.1 | `db/migrations/0001_init.sql` (`DEFAULT 'LKR'`); `spaceService.createSpace` | migrations executed by every test that calls `openScenario`/`applyMigrations` | Verified | All demo rows are LKR. |
| US-41 | AC-41.2 | `db/migrations/0003_currency_sri_lanka.sql` | migrations executed in tests (applied by `applyMigrations`) | Verified | `ETB` → `LKR` correction runs on migrate. |
| US-41 | AC-41.3 | `spaceService.normaliseRates`; `space_rate.amount_cents` | unit bookingRulesTraceability R-BOOK-012/013 | Verified | Integer cents only. |

## Epic 8 — Notifications, auditing and security

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-42 | AC-42.1 | `src/server/mail/mailer.js` | unit mailer "NOT_CONFIGURED: no SMTP_HOST means no connection attempt" | Verified | — |
| US-42 | AC-42.2 | `mailer.js` | unit mailer "SENT: the json transport seam delivers"; "the stream transport seam" | Verified | Delivery result recorded. |
| US-42 | AC-42.3 | `mailer.js`; `inquiryService` | unit mailer "FAILED: a throwing transport is reported, never thrown"; integration inquiryService "a throwing mailer is recorded as FAILED" | Verified | — |
| US-42 | AC-42.4 | `mailer.js` `safeErrorMessage` | unit mailer "secrets: SMTP_PASS never appears in a reported delivery error"; "safeErrorMessage redacts URL credentials" | Verified | — |
| US-43 | AC-43.1 | `src/server/services/auditService.js` `recordAudit`; called by every write service | integration adminUserService "every mutation writes its audit entry" | Verified | — |
| US-43 | AC-43.2 | `recordAudit` called inside `withWriteTransaction` | none | Implemented, not verified | Same-transaction atomicity is by construction; no rollback test asserts the audit row disappears. |
| US-43 | AC-43.3 | `adminOpsRoutes.js` `GET /admin/audit`; `auditService.listAudit` | e2e "GET /admin/audit -> 200"; integration adminOpsRoutes | Verified | — |
| US-44 | AC-44.1 | `publicRoutes.js` (no customer/booking imports) | unit publicPrivacy "carries no staff-only fields"; e2e "detail shows no PII" | Verified | — |
| US-44 | AC-44.2 | `availabilityService.getPublicAvailability`; `publicRoutes.js` projection | unit publicPrivacy "emits exactly the documented public keys, in order"; "scrubs forbidden attribute keys" | Verified | — |
| US-44 | AC-44.3 | public projection | unit publicPrivacy "catches reservation references but not inquiry references" | Verified | — |
| US-45 | AC-45.1 | `sessions.js` `requireCsrf` / `verifyCsrf` | integration adminSpaceRoutes "a mutation without a valid CSRF token is rejected and writes nothing" | Verified | — |
| US-45 | AC-45.2 | `sessions.js` `csrfTokenFor` | integration adminSpaceRoutes (happy-path mutations carry `_csrf`) | Verified | — |
| US-46 | AC-46.1 | `sessions.js` `hashToken`; `admin_session.token_hash` | none | Implemented, not verified | Only the hash is stored, but no test asserts the raw token is absent/unusable. |
| US-46 | AC-46.2 | `sessions.js` `SESSION_TTL_MS`; `resolveSession` | none | Implemented, not verified | Expiry logic present; untested. |
| US-46 | AC-46.3 | `sessions.js` `IDLE_TIMEOUT_MS`; `resolveSession` | none | Implemented, not verified | Idle revocation present; untested. |
| US-46 | AC-46.4 | `sessions.js` `revokeAllSessionsForUser` | integration adminUserService "deactivating a user revokes every session" | Verified | — |
| US-47 | AC-47.1 | `src/server/http/response.js` `applySecurityHeaders` | integration router "security headers are present"; manual (CSP `default-src 'self'`, `X-Frame-Options: DENY`) | Verified | — |
| US-47 | AC-47.2 | `response.js`; `mediaRoutes.js` | integration router "applySecurityHeaders gives uploaded media an inert policy"; integration mediaRoutes "streams the exact bytes with inert, cacheable headers"; e2e "media has CSP sandbox", "media has nosniff" | Verified | — |
| US-47 | AC-47.3 | `src/server/http/router.js` error boundary | integration router "internal errors never leak stack traces or SQL text" | Verified | — |
| US-47 | AC-47.4 | `router.js` not-found handler | integration router "unknown paths fall through to the not-found handler"; manual | Verified | Friendly 404, no stack trace. |
| US-48 | AC-48.1 | `src/server/domain/validation.js` (every mutating route funnels through it) | integration adminSpaceRoutes (422 on invalid payload); integration inquiryService | Verified | — |
| US-48 | AC-48.2 | `uploads.js` `sniffImageType` / `assertUploadableImage` | unit uploads "rejects SVG, PHP, HTML, empty and truncated buffers" | Verified | — |
| US-48 | AC-48.3 | `uploads.js` (`MAX_IMAGE_BYTES = 5 MB`) | unit uploads "rejects oversized files" | Verified | — |
| US-48 | AC-48.4 | `router.js` body handling | integration router "oversized bodies are refused", "malformed JSON is rejected with 422, not a 500" | Verified | — |

## Epic 9 — Responsive usability and reliability

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-49 | AC-49.1 | `src/web/public/styles.css` | manual | Implemented, not verified | Manual responsive sweep (15 routes × 1440/768/390) recorded in `FINAL_READINESS_REPORT.md`; no automated viewport test exists. |
| US-49 | AC-49.2 | `styles.css` | manual | Implemented, not verified | As above. |
| US-49 | AC-49.3 | `styles.css` (`.table-wrap` scroll container; `.detail-list`) | manual | Implemented, not verified | As above. |
| US-50 | AC-50.1 | `styles.css` `.detail-list` media rule (`minmax(0, min(10rem, 40%))`) | unit detailListLayout "two-column detail-list never lets the label track over-consume the container" | Verified | — |
| US-50 | AC-50.2 | `styles.css` `.data-table` (`overflow-wrap: break-word`) | unit detailListLayout "detail-list values can break long tokens" | Verified | — |
| US-51 | AC-51.1 | `router.js` error boundary | integration router "error boundary maps AppError to JSON for API paths" | Verified | — |
| US-51 | AC-51.2 | `router.js`; `errors.js` | integration router "thrown validation errors carry field details to the client" | Verified | — |
| US-51 | AC-51.3 | `dashboardService` | integration dashboardService "an empty database reports real zeroes" | Verified | — |
| US-52 | AC-52.1 | `src/server/db/migrate.js` `applyMigrations` | none | Implemented, not verified | Migrations run in tests, but re-running them against an already-migrated DB is not asserted. |
| US-52 | AC-52.2 | `src/server/db/seed.js` (idempotent) | manual (seed reports `skipped: reservations already exist`) | Verified | Observed during reseeding. |
| US-52 | AC-52.3 | `src/server/index.js`; `tools/node.cmd`, `tools/npm.cmd` | manual (production-mode boot smoke test) | Verified | Recorded in `FINAL_READINESS_REPORT.md`; `/`, `/spaces`, `/booking-request` → 200, `/admin` → 303. |
| US-53 | AC-53.1 | `package.json` scripts | e2e / integration / concurrency suites executed | Verified | Results in `REQUIREMENTS_IMPLEMENTATION_REPORT.md`. |
| US-53 | AC-53.2 | `scripts/e2e-verify.js` `SLST_OFFSET_MS` / `slstWindow()` | e2e section [7] | Verified | Deterministic 10:00–12:00 SLST probe; fixed a 16:00-afternoon flake. |
| US-53 | AC-53.3 | `tests/unit/detailListLayout.test.js` | unit detailListLayout | Verified | Written to fail against the pre-fix CSS and pass after. |

## Epic 10 — Production readiness and accessibility

| Story ID | Acceptance criteria | Implementation location | Test reference | Status | Evidence / limitation |
|---|---|---|---|---|---|
| US-54 | AC-54.1 | none wired — `src/server/db/connection.js` opens SQLite | none | Not implemented | No runtime PostgreSQL code path exists. |
| US-54 | AC-54.2 | `db/migrations-postgres/0001_init.sql` | none | Not implemented | DDL exists but is not part of any tested path. |
| US-55 | AC-55.1 | `src/server/security/blobStorage.js`; `uploads.js`; `adminUploadRoutes.js` | none | Implemented, not verified | Wired and gated on `BLOB_READ_WRITE_TOKEN`; the remote path is never exercised in tests. |
| US-55 | AC-55.2 | `uploads.js` local fallback | unit uploads (filesystem store) | Verified | Local filesystem store is the tested default. |
| US-56 | AC-56.1 | none | none | Not implemented | No `vercel.json`, no serverless handler; no deployment performed. |
| US-56 | AC-56.2 | none | none | Not implemented | No post-deployment smoke test exists because there is no deployment. |
| US-57 | AC-57.1 | `mailer.js` (real SMTP path) | unit mailer (seams only) | Blocked | No SMTP credentials/server configured; real delivery cannot be verified. Boot reports `email status: NOT configured`. |
| US-57 | AC-57.2 | `mailer.js`; `inquiryService` | unit mailer "FAILED: a throwing transport is reported" | Blocked | The failure path is unit-tested, but "real SMTP failure" needs a real server. |
| US-58 | AC-58.1 | `src/web/views/**`, `styles.css` | none | Implemented, not verified | No axe/Lighthouse/WCAG run; no accessibility score is claimed. |
| US-58 | AC-58.2 | `styles.css`; semantic markup | none | Implemented, not verified | Untested with assistive technology. |

---

## Cross-check: legacy `R-*` requirements

`REQUIREMENT_TEST_MATRIX.md` predates this document and uses an `R-<area>-<n>`
scheme. It is preserved as a **historical snapshot** with its original banner.
A cross-reference mapping `R-*` ↔ `US-*` / `AC-*` has been appended to it
(section 14) so the two vocabularies can be reconciled without rewriting the
older record.

## Known gaps in one place

| Gap | Affects | Status | Note |
|---|---|---|---|
| Inquiry → reservation linkage is not wired to any route | US-11 / AC-11.2 | Partially implemented | Pre-fill works; `CONVERTED` is unreachable from the UI. Recommended follow-up. |
| Reservation and calendar routes have no integration tests | US-25.3, US-26.3, US-28, US-31.2 | Implemented, not verified | Only e2e happy paths and service-level concurrency tests exist. |
| Session internals (hash-only storage, TTL, idle timeout, sign-out) untested | US-15.1, US-46.1–46.3 | Implemented, not verified | Guards exist and are readable. |
| Login lockout and rate limiting untested | US-14 | Implemented, not verified | Code present in `sessions.js` / `rateLimit.js`. |
| Audit-log same-transaction atomicity not asserted | US-43.2 | Implemented, not verified | By construction (call inside `withWriteTransaction`). |
| Migration idempotency not asserted | US-52.1 | Implemented, not verified | Migrations run once per fresh test DB. |
| No production deployment, no PostgreSQL runtime, no live email | US-54, US-56, US-57 | Not implemented / Blocked | Boundary stated in `FINAL_READINESS_REPORT.md`. |
| No accessibility audit | US-58 | Implemented, not verified | No WCAG score claimed. |
