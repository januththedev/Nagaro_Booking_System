# Design Contract — Premium Hackathon Redesign (`ui/premium-hackathon-redesign`)

Lead-owned. Agents A/B build views to this contract; lead writes `styles.css` + `layout.js` to match.
Nobody changes backend files (routes, services, schema, config, api/, scripts/, tests/).

## 1. Tokens (lead implements in styles.css)

```
--paper: #faf7f1        page background (public)
--card: #fffdf8         raised surface
--sunken: #f2ede1       wells, code, table heads
--ink: #171b18          body text
--muted: #55605a        secondary text
--line: #e2dac8         hairlines
--line-strong: #8a8474  input borders
--pine: #0b3d2e         primary brand (buttons, links, headings accents)
--pine-deep: #072a21     footer, sidebar
--lime: #d9f75f         marker accent (bg only, never body text)
--lime-ink: #4d6300      small accent text on light surfaces
--gold: #9a6a1a         secondary accent (rates, eyebrows)
--danger: #9c1d28  --ok: #1c6b3c  --warn: #8a5a00  --info: #1d4d73
```

Display: `Georgia, 'Times New Roman', serif` (oversized, tight). Body: system sans.
Radius: 10px cards, 6px controls, pills for tags. Shadows: one soft layer only.

## 2. Public component classes (agents must use exactly these)

Header: `.site-header` (adds `.is-scrolled` via JS), `.brand` > `.brand__mark(svg)` + `.brand__word`.
Hero: `.hero-premium > .hero__grid > .hero__copy + .hero__media`
  copy: `.hero__eyebrow`, `.hero__title` (may contain `<em>` italic accent), `.hero__lede`,
         `.hero__search` (GET form to `/spaces`: fields `q`, `date`, `start_time`, `end_time`, submit `Search spaces`),
         `.hero__stats` (real numbers only: published count, categories, opening window)
  media: `.hero__photo--a/.hero__photo--b` (real space image URLs from data), `.hero__stamp` (rotating circular text badge, CSS only, hidden with reduced-motion), `.hero__caption`
Sections: `.section > .section__head > .section__index (e.g. "01") + .section__title + .section__lede`
Category rows: `.cat-row(.cat-row--flip) > .cat-row__media(img) + .cat-row__body > .cat-row__kicker/.cat-row__title/.cat-row__text/.cat-row__facts(li)/link`
Venue cards: `.venue-grid > .venue-card > .venue-card__media(img + .venue-card__tag + .venue-card__price) + .venue-card__body(.venue-card__name/.venue-card__meta/.venue-card__blurb/.venue-card__foot with link)`
Steps: `.steps > .step(.step__num/.step__title/.step__text)`; CTA band `.cta-band`.
Footer: `.site-footer > .footer__grid(.footer__brand/.footer__nav/.footer__ops) + .footer__base`.
Motion: add `data-reveal` to major blocks; optional `style="--reveal-delay:.1s"` steps of .05s up to .3s (no other inline styles — CSP).

## 3. Discovery / detail / booking classes

Directory: `.discover > .discover__filters (sticky aside: .filter-group, .chip-group > .chip(is-active as link), selects, reset link) + .discover__results (.result-count, .venue-grid, .empty-state, pagination keeps existing .pagination)`.
Keep ALL existing filter field names + `amenity` checkboxes + sort select.
Detail: `.venue-hero (breadcrumbs, h1, .venue-facts) + .gallery-premium (.gallery__stage img[data-gallery-main] + .gallery__thumbs button[data-gallery-thumb][data-src][data-alt]) + .spec-strip (.spec: .spec__k/.spec__v) + .detail-grid (.detail__main cards + aside .book-panel(.book-panel__price/.book-panel__note + availability form fields date/start_time/end_time/desks + [data-availability-form] + .request-cta))`.
Booking: `.booking-flow > .flow-progress (3 static items, current marked) + form keeps ALL existing input names + .form-section x3 + .booking-side (selected-space card from ?space=, what-happens list)`. Submit button disables on submit via JS (`data-submit-once`).
Received/withdraw pages: keep reference display, withdraw link, honest wording.

## 4. Admin classes

Shell (lead owns layout.js): `.app-shell > .sidebar(.brand/.nav-group/.nav-link.is-active + svg/.sidebar__user) + .maincol(.topbar(.page-crumb/.topbar__actions)/.page-head(h1 .page-sub .page-actions)/.flash-stack/.page-body)`.
Dashboard: `.kpi-grid > .kpi(.kpi__value/.kpi__label/.kpi__hint/.kpi__link)` (all values real, from existing summary data) + existing section cards.
Tables: keep `.data-table`, add `.rowlink` on title cells; status via existing `.badge`/`.tag`.
Filters: `.filters-bar` (keeps all existing field names), quick links `.quick-tabs`.
Forms: `.form-card > .form-section(.form-section__title)`, keep ALL input names/ids/errors; photo manager keeps existing hooks (`enctype`, `name="images"`, `accept`, `name="orderedIds"`, delete/cover/reorder actions, `data-confirm`).
Calendar: keep timeline markup contract (`--start/--span` minutes); style toolbar `.cal-toolbar`.
Dialogs: keep `data-confirm` mechanism (admin.js); style `.confirm-dialog`.

## 5. JS (agents A/B own their files only)

- Keep every existing `data-*` hook and id referenced by public.js/admin.js; may ADD `data-reveal` handling + `data-submit-once` + `.is-scrolled` header (extend existing files, no rewrite).
- No new dependencies, no inline `<script>`, no `style=` attributes (CSP), no external URLs.

## 6. Hard invariants (tests + backend)

- All exported view function names + parameter shapes unchanged (routes call them positionally).
- All form `action` URLs, input `name`s, filter param names unchanged.
- Test-asserted strings/attributes stay: `All figures are read live from the booking database.`, `data-dashboard`, `data-summary-url`, `data-today-confirmed/cancelled` order, `data-notification-undelivered`, `Notification email NOT delivered`, `has not reserved any inventory`, `A space cannot be published without a photograph`, `append-only`, `data-confirm`, gallery `data-*` hooks, `[role="alert"]`, `aria-describedby`/`aria-invalid` wiring, `INQ-…`/`NG-…` reference rendering, LKR/SLST formatting (views receive formatted strings — keep using them).
- Privacy: public views get only projected data (existing projection untouched).
- No lorem ipsum, no fake stats/ratings/testimonials. Images: only real space `url`s from data, `placeholder-space.svg` fallback.
