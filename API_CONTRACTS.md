# API and Integration Contracts

**Frozen.** These names, shapes and routes are what every module must use. Changing any of them requires updating this file, then the affected modules and their tests, in the same change.

## 1. Shared vocabulary

Import from `src/server/domain/constants.js`. Never re-declare these strings.

```
SPACE_CATEGORY      MEETING_ROOM | AUDITORIUM | COWORKING
SPACE_STATUS        DRAFT | PUBLISHED | ARCHIVED
PRICING_UNIT        HOUR | HALF_DAY | DAY | WEEK | MONTH
RESERVATION_STATUS  CONFIRMED | CANCELLED | COMPLETED
OCCUPANCY_STATUS    ACTIVE | RELEASED
OCCUPANCY_SOURCE    RESERVATION | MAINTENANCE
INQUIRY_STATUS      NEW | CONTACTED | CONVERTED | CLOSED | WITHDRAWN
INQUIRY_EMAIL_STATUS PENDING | SENT | FAILED | NOT_CONFIGURED
ADMIN_ROLE          ADMIN | STAFF
ERROR_CODE          DOUBLE_BOOKING_CONFLICT | VALIDATION_ERROR | NOT_FOUND |
                    UNAUTHORIZED | FORBIDDEN | CONFLICT | RATE_LIMITED | INTERNAL_ERROR
```

## 2. Database contract

Open with `getDb()` from `src/server/db/connection.js`. Wrap every mutation in
`withWriteTransaction(db, fn)` (a `BEGIN IMMEDIATE` transaction) — this is the
concurrency guarantee, not a stylistic choice. Reads may use plain `db.prepare(...)`
or `withReadTransaction`.

`node:sqlite` parameter rules: positional `?` placeholders only. Booleans must be
converted to `0`/`1`. `lastInsertRowid` is wrapped with `Number()`.

## 3. Domain helpers

`src/server/domain/time.js` — `BUSINESS_TZ`, `MS`, `parseClock`, `formatClock`,
`businessParts`, `businessDateKey`, `businessTimeLabel`, `businessDateTimeLabel`,
`businessLocalToEpoch(dateKey, clock)`, `startOfBusinessDay`, `businessDaySpan`,
`formatDuration`, `intervalsOverlap`, `inflate`, `coerceEpochMs`, `todayBusinessDate`.

`src/server/domain/validation.js` — `requiredString`, `asTrimmedString`, `optionalEmail`,
`requiredEmail`, `normalizeEmail`, `optionalPhone`, `asInteger`, `asMoneyCents`, `oneOf`,
`asBoolean`, `asClock`, `asDateKey`, `asEpoch`, `localDateTime`, `asStringArray`,
`asPagination`, `parseSpacePayload`, `normalizeAttributes`, `safeJson`,
`parseBookingWindow`, `sniffImageType`, `assertUploadableImage`, `LIMITS`.

`src/server/domain/errors.js` — `AppError`, `validationError`, `notFound`, `unauthorized`,
`forbidden`, `conflict`, `rateLimited`, `DoubleBookingError`.

`src/server/domain/references.js` — `nextReference(db, 'reservation'|'inquiry')` (must be
called inside a write transaction), `randomToken(bytes)`.

## 4. Service contracts

### bookingService.js

```js
createReservation(db, { actor, spaceId, customerId?, customerPayload?, startAt, endAt, unitCount,
                        attendees, purpose, internalNotes, billingUnit,
                        billingQuantity, idempotencyKey, source,
                        bookingChannel?, manageTokenHash? })
  -> { reservation, idempotent: boolean }        // throws DoubleBookingError

updateReservation(db, { actor, reservationId, patch: { spaceId?, customerId?,
                        startAt?, endAt?, unitCount?, attendees?, purpose?,
                        internalNotes?, billingUnit?, billingQuantity? } })
  -> { reservation }

cancelReservation(db, { actor, reservationId, reason })
  -> { reservation, releasedOccupancyRows }      // reason must be non-blank

reconcileCompletedReservations(db, now) -> number
createMaintenanceBlock(db, { actor, spaceId, startAt, endAt, reason, resourceUnitIds })
  -> { maintenanceBlockId, units }
cancelMaintenanceBlock(db, { actor, maintenanceBlockId, reason })
  -> { releasedOccupancyRows }
listMaintenanceBlocks(db, { spaceId, fromAt, toAt, limit })
loadReservation(db, id) | findReservationByReference(db, reference)
```

`actor` is always `{ id, label, role }`. `label` is used verbatim in the audit log.

### publicBookingService.js

```js
createPublicBooking(db, { spaceId, startAt, endAt, unitCount, attendees,
                          purpose, idempotencyKey, customer, now? })
  -> { reservation: publicSafeShape, idempotent, manageToken }
getPublicBooking(db, { reference, token }) -> publicSafeShape
cancelPublicBooking(db, { reference, token, now? }) -> publicSafeShape
```

Only the one-time raw management token can authorize guest reads/cancellation; the database stores its
SHA-256 hash. The public-safe shape contains booking reference, space, schedule, quantity, price and status,
never customer data, audit actors, internal notes, other reservation references or unit identities.

**Reservation object shape** (what views and API responses consume):

```js
{ id, reference, status, spaceId, spaceCode, spaceName, category, spaceStatus,
  bufferMinutes, customerId,
  customer: { id, fullName, email, phone, organization },
  startAt, endAt, unitCount, attendees, purpose, internalNotes,
  billingUnit, billingQuantity, rateCents, totalCents, currency,
  units: [{ id, code, label, kind }], unitCodes: [String],
  createdBy, createdByName, createdAt, updatedBy, updatedByName, updatedAt,
  cancelledBy, cancelledByName, cancelledAt, cancellationReason, idempotencyKey }
```

### availabilityService.js

```js
findConflicts(db, { spaceId, resourceUnitId?, startAt, endAt, bufferMinutes?,
                    excludeReservationId?, includeReleased? }) -> Conflict[]
inspectUnits(db, { spaceId, unitIds, startAt, endAt, bufferMinutes?,
                   excludeReservationId? }) -> { freeUnitIds, conflicts }
allocateUnits(db, { spaceId, startAt, endAt, requiredCount, bufferMinutes?,
                    excludeReservationId?, preferredUnitIds? })
  -> { units, conflicts, totalUnits, freeCount }   // throws DoubleBookingError
activeUnits(db, spaceId) -> ResourceUnit[]
getSpaceAvailability(db, { spaceId, startAt, endAt, deskCount?, includeConflicts? })
getPublicAvailability(db, { spaceId, startAt, endAt, deskCount? })   // no PII, PUBLISHED only
getSpaceDayGrid(db, { spaceId, dateKey, includeDetails? })
checkBookingRules(space, { startAt, endAt, attendees }) -> String[]
assertBookingRules(space, window, attendees)         // throws validationError
availabilityLabel(availability) -> String
```

`Conflict` = `{ occupancyId, resourceUnitId, unitCode, unitLabel, spaceId, startAt, endAt,
source, status, reservationId, reservationReference, reservationStatus, customerName,
maintenanceBlockId, maintenanceReason, label }`.

**Do not extend the public availability response with customer data.** Only
`getPublicAvailability()` may be called from visitor-facing routes.

### spaceService.js

```js
createSpace(db, { actor, payload }) -> Space
updateSpace(db, { actor, spaceId, payload }) -> Space
publishSpace(db, { actor, spaceId }) -> Space        // throws when not publishable
unpublishSpace(db, { actor, spaceId }) | restoreSpace(db, { actor, spaceId }) -> Space
archiveSpace(db, { actor, spaceId, reason }) -> { space, upcomingOccupancy }
setDeskCount(db, { actor, spaceId, deskCount }) -> Space
publishabilityIssues(db, spaceId) -> String[]
listSpaces(db, { status, category, search, includeArchived, limit, offset, sort })
  -> { total, items: Space[] }
getSpace(db, id) | getSpaceByCode(db, code) | getSpaceOrThrow(db, id) -> Space | null
listImages(db, spaceId) -> SpaceImage[]
addImageRecord(db, { actor, spaceId, storedName, originalName, mimeType, byteSize, altText })
deleteImage(db, { actor, spaceId, imageId }) -> { removedStoredName }
setCoverImage(db, { actor, spaceId, imageId }) -> SpaceImage[]
reorderImages(db, { actor, spaceId, orderedIds }) -> SpaceImage[]
rateSummary(space) -> String
```

**Space object shape:**

```js
{ id, code, name, category, categoryLabel, shortDescription, description, location,
  floor, capacity, status, currency, pricingUnit, minDurationMinutes, maxDurationMinutes,
  bufferMinutes, openTime, closeTime, amenities: String[], attributes: Object,
  contactNote, rates: { [PRICING_UNIT]: cents }, rateList, units: ResourceUnit[],
  unitCount, imageCount, coverImage, createdAt, updatedAt, publishedAt, archivedAt }
```

**SpaceImage** = `{ id, spaceId, storedName, originalName, mimeType, byteSize, altText,
sortOrder, isCover, createdAt, url /* "/media/<storedName>" */ }`.

### customerService.js

```js
searchCustomers(db, { query, limit, offset, sort }) -> { total, items: Customer[] }
getCustomer(db, id) | getCustomerOrThrow(db, id) -> Customer | null
createCustomer(db, { actor, payload, allowDuplicate }) -> Customer
updateCustomer(db, { actor, customerId, payload }) -> Customer
findPossibleDuplicates(db, { email, fullName, excludeId }) -> [{ customer, match, confidence }]
getCustomerHistory(db, customerId, { limit }) -> HistoryEntry[]
customerFrequentSpaces(db, customerId, { limit })
customerUpcomingReservations(db, customerId, now)
```

`payload` uses snake_case field names: `full_name`, `email`, `phone`, `organization`, `notes`.

**Customer** = `{ id, fullName, email, emailNormalized, phone, organization, notes, createdAt,
updatedAt, stats: { totalReservations, confirmedReservations, cancelledReservations,
lastBookingAt, bookedValueCents }, history? }`.

### auditService.js

```js
recordAudit(db, { at?, actorAdminUserId?, actorLabel, action, entityType,
                  entityId?, summary, details? })
listAudit(db, { entityType?, entityId?, actorAdminUserId?, limit, offset }) -> AuditEntry[]
hydrateAudit(row) -> AuditEntry
```

Action names use `entity.verb`: `reservation.created`, `reservation.updated`,
`reservation.cancelled`, `space.created`, `space.updated`, `space.published`,
`space.unpublished`, `space.archived`, `space.restored`, `space.inventory_changed`,
`space.image_added`, `space.image_removed`, `space.cover_set`, `space.images_reordered`,
`customer.created`, `customer.updated`, `maintenance.created`, `maintenance.cancelled`,
`inquiry.received`, `inquiry.status_changed`, `inquiry.withdrawn`, `auth.login`,
`auth.login_failed`, `auth.logout`, `admin_user.created`, `admin_user.updated`.

### pricingService.js

```js
quote({ space, rates, startAt, endAt, unitCount, billingUnit?, billingQuantityOverride? })
  -> { billingUnit, billingQuantity, rateCents, totalCents, currency }
loadRates(db, spaceId) -> Map<unit, cents>
billingQuantityFor({ unit, startAt, endAt, billingQuantityOverride })
formatMoney(cents, currency) | formatMoneyCompact(cents, currency)
```

### security

```js
passwords.js   hashPassword(plain) -> String; verifyPassword(plain, stored) -> boolean;
               passwordProblems(password) -> String[]
sessions.js    SESSION_COOKIE, CSRF_COOKIE, FLASH_COOKIE,
               authenticate(db, { email, password, ip, now }) -> admin_user row,
               createSession(db, { adminUserId, userAgent, ip }) -> { token, csrfSecret, expiresAt },
               resolveSession(db, token) -> { sessionId, csrfSecret, expiresAt, actor } | null,
               revokeSession(db, sessionId), revokeAllSessionsForUser(db, id),
               purgeExpiredSessions(db), csrfTokenFor(secret), verifyCsrf(secret, provided),
               requireAuth(ctx), requireAdmin(ctx), requireCsrf(ctx)
rateLimit.js   enforce(db, key, { limit, windowMs, message }), hit(db, key, { windowMs }),
               ipBucket(scope, ip), emailBucket(scope, email),
               enforcePublicInquiryLimits(db, { ip, email }),
               enforceLoginLimits(db, { ip, email }), enforceAdminMutationLimit(db, { actorId })
```

`ctx` is the router context (§5). `ctx.actor` is `{ id, email, displayName, role, label }`.

## 5. HTTP layer contract

**Router** (`src/server/http/router.js`): `router.get|post|put|patch|delete(pattern, handler)`.
Patterns use `:param` segments. Method mismatch yields 405; unmatched paths fall to the
404 handler.

**Context object** handed to every handler:

```js
{ req, res, params, query, url, method, body, state, session, actor, flash,
  wantsJson,
  set(key, value), setStatus(status), setHeader(name, value),
  readBody({ limit? }) -> Object,     // parses json / urlencoded / multipart
  json(payload, status?), html(markup, status?), text(text, status?) }
```

Middleware registered with `router.use(fn)` runs in order. Returning `false` or having
already responded stops the chain. Errors thrown anywhere are routed to `router.onError`.

**Route ownership rule:** visitor-facing routes live under `/`, `/spaces`, `/book`, `/booking-request`,
`/media`, `/assets`; JSON APIs under `/api/public/*`; staff routes under `/admin/*` and
`/api/admin/*`. Public routes must never import `customerService`.

## 6. HTML/view contract

`src/web/lib/html.js`:

```js
html`<p>${value}</p>`   // escapes every interpolation, returns RawHtml
raw(x)                  // explicit unescaped output — grep-auditable
join(list, sep)
escapeHtml(value)
money(cents, currency) | moneyCompact() | dateLabel | timeLabel | dateTimeLabel
friendlyDate | periodLabel(startAt, endAt) | relativeDayLabel | durationLabel
statusBadge(status) | categoryLabel(category) | pricingUnitLabel(unit) | tag(text, variant)
availabilityPill(isAvailable, label) | fieldError(details, field) | problemList(list)
emptyState(message, hint) | pagination({ page, pageSize, total, basePath, extraQuery })
csrfField(token) | attr(name, value)
```

`src/web/views/layout.js`: `publicShell({ title, description, body, activePath, pageClass })`,
`adminShell({ title, actor, csrfToken, flash, activePath, body, breadcrumbs, pageActions,
subtitle })`, `pageContainer`, `card`, `table({ columns, rows, emptyMessage })`.

Views return `RawHtml` from `html\`...\`` and are rendered with `ctx.html(page)`.
Whenever a view is composed with `html`, nested `RawHtml` is not double-escaped.

## 7. Route inventory

Every route below must exist. Handlers are thin; all rules live in services.

### Public pages (HTML)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Landing page: photographic hero, "Book a Space" entry point, venue programme, footer |
| GET | `/spaces` | Published space directory with category, capacity, billing-unit, amenity, text and availability filters |
| GET | `/spaces/:code` | Space detail: gallery, amenities, category attributes, rates, availability console, request CTA |
| GET | `/spaces/:code/book` | Unified booking request form for one published space |
| POST | `/spaces/:code/book` | No-JavaScript fallback for the request form; creates the request and redirects to the private status page |
| GET | `/book` | **Retired** — 308 redirect to `/spaces` |
| POST | `/book` | **Retired** — 303 redirect to `/spaces` (immediate self-confirmation removed) |
| GET | `/book/confirmed` | Legacy capability receipt for pre-request reservations (`?ref=&token=`); kept for existing links |
| GET | `/book/manage` | Capability-protected status page: request state, hold deadline, PayHere action, cancellation; legacy reservations still manage here |
| POST | `/book/cancel` | Cancel a not-yet-started legacy reservation and release inventory once |
| GET | `/booking-request` | **Retired** — 308 redirect to `/spaces` |
| POST | `/booking-request` | **Retired** — 303 redirect to `/spaces` (concierge channel removed) |
| GET | `/booking-request/received` | Legacy inquiry acknowledgement, kept for existing links |
| GET | `/booking-request/withdraw` | Legacy inquiry withdraw form (`?ref=&token=`); incomplete links read 400 |
| POST | `/booking-request/withdraw` | Mark a legacy inquiry WITHDRAWN |
| GET | `/media/:storedName` | Serve an uploaded photograph (validated name, inert headers) |

### Public JSON

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/spaces` | Published spaces, filterable; no PII |
| GET | `/api/public/spaces/:code` | One published space |
| GET | `/api/public/availability` | `?space=<code>&start=&end=&desks=` → provisional availability, counts only |
| GET | `/api/public/availability/day` | `?space=<code>&date=` → hourly slots for one day |
| POST | `/api/public/booking-requests` | Create a booking request (status `REQUESTED`, no inventory held): `{ ok, request, manageToken, idempotent }` (`no-store, private`, `no-referrer`); idempotent on `formToken` |
| GET | `/api/public/booking-requests/:reference` | Capability-protected request state, fee snapshot and hold deadline |
| POST | `/api/public/booking-requests/:reference/cancel` | Customer cancellation through the capability link; releases any active hold |
| POST | `/api/public/booking-requests/:reference/payment` | Produce signed PayHere checkout parameters for the snapshotted fee (409 when not payable) |
| POST | `/api/public/payments/payhere/notify` | PayHere server-to-server callback (form-encoded): `md5sig` verified, amount checked against the immutable snapshot, idempotent, never trusts the browser return |
| POST | `/api/public/assistant/chat` | Venue assistant turn (OpenRouter through whitelisted tools; contact details redacted; bounded tool budget) |
| POST | `/api/public/assistant/drafts` | Create a short-lived, schema-validated booking draft (token hashed at rest) |
| POST | `/api/public/assistant/drafts/resolve` | Burn a draft token and return the prepared fields |
| GET | `/api/public/bookings/:reference` | Load a legacy public reservation with capability token (`Authorization: Bearer <token>`, `x-booking-capability`, or `?token=`) |
| POST | `/api/public/bookings/:reference/cancel` | Cancel a future legacy reservation with capability token and release inventory once |
| POST | `/api/public/bookings` | **Retired** — 410; immediate confirmation bypassed approval and fees |
| POST | `/api/public/inquiries` | **Retired** — 410; the concierge channel is replaced by booking requests |

### Admin pages (HTML)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin` | Dashboard: spaces, today/upcoming bookings, occupancy, new inquiries, recent activity |
| GET | `/admin/login`, POST `/admin/login` | Sign in |
| POST | `/admin/logout` | Sign out |
| GET | `/admin/spaces` | Space list with status/category filters and search |
| GET | `/admin/spaces/new`, POST `/admin/spaces` | Create space |
| GET | `/admin/spaces/:id` | Space detail with publish checklist |
| GET | `/admin/spaces/:id/edit`, POST `/admin/spaces/:id` | Edit space (incl. rates, desk inventory) |
| POST | `/admin/spaces/:id/publish` | Publish (blocked without a photograph) |
| POST | `/admin/spaces/:id/unpublish` | Back to draft |
| POST | `/admin/spaces/:id/archive` | Archive |
| POST | `/admin/spaces/:id/restore` | Restore from archive |
| POST | `/admin/spaces/:id/images` | Upload photographs |
| POST | `/admin/spaces/:id/images/:imageId/cover` | Set cover |
| POST | `/admin/spaces/:id/images/:imageId/delete` | Remove |
| POST | `/admin/spaces/:id/images/reorder` | Reorder |
| GET | `/admin/reservations` | Consolidated booking list with filters, sorting, pagination |
| GET | `/admin/reservations/new`, POST `/admin/reservations` | Create reservation |
| GET | `/admin/reservations/:id` | Booking detail with permitted actions |
| GET | `/admin/reservations/:id/edit`, POST `/admin/reservations/:id` | Edit reservation |
| POST | `/admin/reservations/:id/cancel` | Reason-required cancellation |
| GET | `/admin/calendar` | Day/week timeline with space, category and status filters |
| GET | `/admin/customers` | Customer directory with search |
| GET | `/admin/customers/new`, POST `/admin/customers` | Create customer |
| GET | `/admin/customers/:id` | Customer profile with booking history |
| GET | `/admin/customers/:id/edit`, POST `/admin/customers/:id` | Edit customer |
| GET | `/admin/inquiries` | Inquiry queue with status filters |
| GET | `/admin/inquiries/:id` | Inquiry detail incl. delivery status and convert action |
| POST | `/admin/inquiries/:id/status` | Change status |
| GET | `/admin/maintenance`, POST `/admin/maintenance` | List / create maintenance blocks |
| POST | `/admin/maintenance/:id/cancel` | Cancel maintenance block |
| GET | `/admin/audit` | Activity log with filters |

| GET | `/admin/booking-requests` | Approval queue: request, space, customer, amounts, payment and hold state |
| POST | `/admin/booking-requests/fee-policy` | Administrator-configured booking fee (DISABLED/FIXED/PERCENTAGE + payment window); snapshotted at approval |
| POST | `/admin/booking-requests/:reference/approve` | Approve a request: recheck availability atomically, create a database-enforced hold and the fee obligation |
| POST | `/admin/booking-requests/:reference/reject` | Reject a request with a recorded reason |
| POST | `/admin/booking-requests/:reference/resolve-payment` | Reconcile a payment exception (`REFUND_RECORDED` / `PAYMENT_KEPT`) with an audited note |

### Admin JSON

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/availability` | `?space=&start=&end=&desks=` with full conflict detail |
| GET | `/api/admin/customers/search` | `?q=` typeahead for the booking form |
| GET | `/api/admin/spaces/search` | `?q=` typeahead |
| GET | `/api/admin/calendar/events` | Calendar feed for a date range |
| GET | `/api/admin/dashboard/summary` | Dashboard counters |
| GET | `/api/admin/inquiries/:id` | Inquiry detail |

### Response envelope

JSON success: the payload itself, e.g. `{ items: [...], total: 12 }`.
JSON failure: `{ ok: false, error: { code, message, details } }`.
Admin HTML mutations use POST → 303 redirect with a flash cookie (`kind` in
`success` | `error` | `warning`, optional `problems: string[]`).

### Errors

| Condition | Status | Code |
|---|---|---|
| Overlapping booking | 409 | `DOUBLE_BOOKING_CONFLICT` |
| Field validation | 422 | `VALIDATION_ERROR` |
| Missing/expired session | 401 | `UNAUTHORIZED` |
| Non-admin attempting an admin action | 403 | `FORBIDDEN` |
| State conflict (already cancelled, duplicate email space code) | 409 | `CONFLICT` |
| Rate limit exceeded | 429 | `RATE_LIMITED` |
| Unknown id | 404 | `NOT_FOUND` |

## 8. Media and uploads

- Storage root: `NAGARO_UPLOAD_DIR` or `storage/uploads` (never inside the web root).
- Stored name: 32 random hex characters + extension derived from **sniffed bytes**, never from the client-supplied filename.
- Accepted: JPEG, PNG, WebP up to 5 MB. **SVG is rejected** (script execution risk).
- `Content-Type` on read comes from the stored extension; responses carry
  `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`.
- `/media/:storedName` rejects anything that is not `^[a-f0-9]{32}\.(jpg|png|webp)$`.

## 9. Requirement identifiers

Requirements use `R-<area>-<n>` and are traceable in `REQUIREMENT_TEST_MATRIX.md`:

`R-SPACE-*` catalogue · `R-AVAIL-*` availability · `R-BOOK-*` reservations ·
`R-CONC-*` concurrency · `R-CUST-*` customers · `R-INQ-*` inquiries ·
`R-AUTH-*` auth · `R-DASH-*` dashboard · `R-PUB-*` public · `R-SEC-*` security · `R-UX-*` experience.
