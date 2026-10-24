# Frontend promises versus implemented functions

24 October 2026. Review branch: `fix/comprehensive-audit`. Scope: current Next customer components, server-rendered staff views, staff browser scripts, registered routes and services. The accompanying `function-route-inventory.json` enumerates route registrations, including intentional duplicate registrations guarded by module ordering.

**Verdict: the core functions have implementations and substantial local regression coverage. A claim that every feature works in production is not supported.** Deployment/database access, live provider integrations and complete browser interaction coverage remain open. “Local” below means code tracing and relevant automated tests, not a production certification.

## Customer functions

| Frontend feature / promise | Actual implementation | Evidence / qualification |
| --- | --- | --- |
| Landing, venue categories and Book a Space | Next landing and catalogue; published catalogue API | Local HTTP cutover checks; live catalogue navigation reviewed |
| Name search, category, capacity, amenities, billing filter, sort and reset | CatalogueClient filters published data in memory | Source review; live search/category/capacity/sort/reset exercised |
| Check selected date/time across catalogue | Availability API per venue | Fixed stale results after editing the window and silent failures; production native-input check inconclusive |
| Venue photographs and thumbnail selection | VenueDetailClient gallery; media allowlist | Source traced; real PNG ingest/serve/security integration tests; live thumbnail interaction not recertified |
| Venue amenities, capacity, operating hours and rates | Space API projects stored catalogue fields | Space service/routes tests and cutover checks |
| Venue availability and pooled desk counts | Availability service checks active units, occupancy and buffers | Service/HTTP tests; availability remains provisional until checkout |
| Preserve chosen schedule when booking | Home/catalogue/detail pass date/start/end; detail passes desks | Corrected in this branch; build and source review |
| Weekly calendar, space filter, previous/next/today/date jump | PublicCalendarService + AvailabilityCalendar | API privacy/range/occupancy tests; date jump added; full UI interactions pending preview |
| Click a free slot | Link uses full minimum duration, rejects past/closing/buffer conflicts | Calendar regression tests; full-window available desk count added |
| Guest booking without creating an account | Capability-token booking flow, rate limiting and server validation | E2E creates real fixture reservation; no production customer records created |
| Date/time, desks and attendee validation | parseBookingWindow, assertBookingRules, allocateUnits | Rules, boundary and concurrency suites; browser required-fields validation also applies |
| Price, fee and remaining balance before confirmation | Authoritative quote from same pricing engine | Preview/stored tariff parity, changed-price rejection, retry regression; cents preserved |
| Submit button availability | Requires current successful availability and quote; server checks again | Versioned/aborted responses prevent stale checkout state; source/build review |
| Repeated submission protection | Form token and idempotency key | Local E2E and transaction tests; retry keeps accepted price |
| JavaScript-disabled booking fallback | Native POST /book remains wired | Existing cutover/source contract tests; JS checkout has richer preview |
| Private booking receipt / manage link | Bearer capability, no-store/private responses | Local E2E token/access checks; legacy receipt still English |
| View current booking/request state | Separate reservation and booking-request APIs; periodic refresh | HTTP state-machine tests; refresh can fail without displaying a warning (open UX limitation) |
| Cancel an eligible request or reservation | Request cancel before confirmation; reservation manage cancel for eligible confirmed booking | Local E2E/service tests; separate state-specific controls; no automated provider refund promise |
| Pay booking fee and optional advance | PayHere form, signed server callback, snapshotted obligation/attempt | Local signature, duplicate callback, amounts and invalid callback tests; real PayHere transaction NOT verified |
| Hold countdown/expiry | Expiry displayed; lazy expiry releases occupancy | Local expiry/hold tests; hold is temporary, not confirmation |
| Guider conversation | Whitelisted venue context with provider/fallback path | Assistant tests; actual provider quality/configuration still needs live verification |
| Guider editable draft | Tokenized draft creation/one-time resolution and form prefill | Fixed date-as-phone extraction, same-page loading, input preservation and error handling; browser preview pending |
| EN/Sinhala/Tamil switcher | Translation dictionaries + locale provider | Dictionary/key parity tests; full linguistic review, receipt and native validation localization incomplete |
| Mobile/keyboard/reduced-motion experience | Responsive CSS, focus helpers, reduced-motion handling | Source contracts/build only for changed screens; six-width and complete keyboard audit still pending |
| Email confirmation | Notification queue/SMTP delivery path | Requires SMTP credentials; live UI reported email delivery unconfigured. NOT currently a verified delivery capability |
| Old inquiry withdrawal links | Legacy capability withdrawal routes retained | Inquiry service and local E2E; new concierge inquiry creation is retired |

## Staff functions

| Frontend feature / promise | Actual implementation | Evidence / qualification |
| --- | --- | --- |
| Staff sign-in, logout, secure sessions and own password change | Auth routes, password hashing, session expiry/revocation, CSRF | Session tests and actual PostgreSQL HTTP login; live authenticated console previously failed |
| Database readiness | Checks required staff schema before session resolution | Missing-column reproduction, explicit 503, guest API isolation and recovery after schema restoration |
| Dashboard counters and recent activity | Dashboard service aggregates persisted records | Independent SQL count tests and PostgreSQL rendering |
| Reservation search/filter/pagination/detail | Booking routes/services and SSR views | Route/service tests; PostgreSQL list/detail/form navigation |
| Create/edit reservation, customer selection and live conflict check | Booking services, customer autocomplete, availability API | E2E writes fixtures; overlap/concurrency tests; no frontend-only success |
| Cancel reservation with reason | Cancellation route/service releases occupancy and records audit | Local E2E and service tests; permanent financial/provider effects are separate |
| Calendar day/week/space/date navigation and events | Calendar routes, event feed and admin-calendar.js | HTTP feed/render tests; pointer/focus interaction still needs browser preview |
| Calendar create drawer | JSON reservation endpoint with same canonical booking service | Source payload/handler tracing and E2E API checks; drawer interaction not browser-certified |
| Calendar move/resize | Reschedule endpoint updates reservation and blocking inventory | Added PostgreSQL HTTP data assertions; reverse-time move rejected without changing saved time |
| Approve/reject pending request from queue/calendar | Booking request service with hold/payment rules | Local E2E/service state tests; production action not exercised |
| Configure fee and payment window | Fee-policy route/service with role guards | Workflow tests and rendered form route/CSRF checks |
| Resolve payment exception | Explicit outcome/note route; audit record | Workflow tests; recording a refund does NOT execute a provider refund |
| Space create/edit, rates, attributes and operating rules | Space routes/services | Local route tests and E2E; all five production-like spaces render on PostgreSQL |
| Publish/unpublish/archive/restore space | Guarded lifecycle service with publication requirements | Lifecycle tests; visibility tied to stored status |
| Upload/reorder/cover/delete venue image | Upload pipeline + image routes and media service | Real PNG and hostile-content tests; actual Vercel Blob write/configuration not verified |
| Customer create/edit/search/history and duplicate handling | Customer routes/services | HTTP mutation and duplicate regressions; PostgreSQL detail/edit rendering |
| Legacy inquiry status and convert to reservation | Inquiry service and conversion-prefilled booking forms | Local inquiry/E2E tests; no public new-inquiry promise |
| Maintenance create/cancel | Blocking occupancy transactions and lifecycle | Local E2E and concurrency tests |
| Global search and keyboard shortcut | Server search across spaces/customers/reservations/requests/inquiries; focus script | Source traced and PostgreSQL search route rendering; shortcut browser test pending |
| In-app notifications, unread counts, mark read/all read | Per-admin API with ownership and CSRF guards | Notification HTTP tests; browser polling script wired |
| Push enable/test/unsubscribe | Service worker, subscription routes, VAPID delivery | Local ownership/validation tests; requires VAPID, browser permission and delivery verification |
| Team create/edit/deactivate | Super Admin guarded account service; session revocation | Account/team tests; access control now exposed in form |
| Super Admin role and three-seat cap | Service checks including reactivation | Regression for disabled Super Admin reactivation; last-active protections |
| Reset password, recycle/restore/purge account | Guarded account lifecycle, audit/reassignment | Account service tests; production destructive actions not used for testing |
| Guider knowledge create/edit/upload/delete | Markdown/text ingestion and knowledge service | HTTP role/upload tests; PostgreSQL list/new rendering |
| Audit log filters and entity links | Audit service + views | SQL/render tests and PostgreSQL navigation |
| All rendered staff form destinations | Runtime router lookup across crawled pages | 60 concrete POST targets registered and reject missing-CSRF requests. This proves wiring/protection, not successful execution of all 60 mutations |

## Open gaps and release boundary

- Live authenticated admin must be retested after obtaining production logs/database migration status. Missing migrations are reproduced locally but remain an unconfirmed production cause.
- SMTP, VAPID, PayHere and model-provider configuration cannot be inferred from source existence. Actual delivery/payment/provider checks remain required.
- Six responsive widths, pointer dragging, drawers, keyboard focus and all localized copy still need browser acceptance on the changed deployment.
- Request/manage screens label live updates but silently retain last data on polling errors. This is an open UX limitation, not proof of continuously fresh state.
- The changed catalogue now clears previous-window badges, ignores obsolete requests and shows failed-check errors. Failed checks must not imply availability.
- This review is an implementation/contract audit, plus the stated local tests. It is not an exhaustive proof over every possible input, dependency failure or browser.
