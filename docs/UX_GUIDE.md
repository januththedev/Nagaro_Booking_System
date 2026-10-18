# UX, accessibility and front-end guide

Owner: Agent E4 (UX / accessibility / front-end). Scope: `src/web/public/styles.css`,
`src/web/public/public.js`, `src/web/public/admin.js`, the two SVG assets, and this guide.
No build step, no framework, no external requests: the CSP is
`default-src 'self'; style-src 'self'; img-src 'self' data:` and every asset is local
or inline.

---

## 1. Palette and measured contrast

Every colour is a CSS custom property declared on `:root` (light) and remapped inside
`@media (prefers-color-scheme: dark)`. Dark mode changes **token values only** — no
selector, layout or spacing difference — so both modes stay in step automatically.
The full token list is commented at the top of `styles.css`.

Ratios below were computed with WCAG 2.1 relative-luminance maths
(`(L1 + 0.05) / (L2 + 0.05)`) against the values actually in the stylesheet.

### Light mode

| Foreground | Background | Ratio | Requirement | Used by |
|---|---|---|---|---|
| `#1b2530` body text | `#ffffff` card surface | **15.51:1** | ≥ 4.5:1 | all body copy |
| `#1b2530` body text | `#f4f2ee` page background | **13.87:1** | ≥ 4.5:1 | all body copy |
| `#4e5d6b` muted text | `#ffffff` card surface | **6.77:1** | ≥ 4.5:1 | `.hint`, `.card__description`, `.page-subtitle`, `.space-card__meta` |
| `#4e5d6b` muted text | `#f4f2ee` page background | **6.05:1** | ≥ 4.5:1 | `.meta-line`, `.section-subtitle` |
| `#5f6f7d` faint text | `#ffffff` card surface | **5.18:1** | ≥ 4.5:1 (large) | `.breadcrumbs` |
| `#0e4f5f` primary | `#ffffff` card surface | **9.12:1** | ≥ 4.5:1 | links, `.section-title`, `.stat__value` |
| `#0e4f5f` primary | `#e2eef0` brand tint | **7.70:1** | ≥ 4.5:1 | selected nav item, active table row |
| `#ffffff` button label | `#0e4f5f` primary fill | **9.12:1** | ≥ 4.5:1 | `.button--primary`, `.skip-link` |
| `#7c868f` hairline | `#ffffff` card surface | **3.71:1** | ≥ 3:1 (UI edge) | card, table and panel borders |
| `#7c868f` hairline | `#f4f2ee` page background | **3.32:1** | ≥ 3:1 (UI edge) | section dividers |
| `#6f7c88` strong border | `#ffffff` card surface | **4.27:1** | ≥ 3:1 (UI edge) | inputs, selects, ghost buttons |
| `#0e4f5f` focus ring | `#ffffff` / `#f4f2ee` | **9.12:1 / 8.16:1** | ≥ 3:1 | `:focus-visible` outline |
| `#14603a` confirmed | `#e6f3ea` success tint | **6.65:1** | ≥ 4.5:1 | `.badge--confirmed`, `.pill--ok`, `.alert--success`, `.timeline__slot--free` |
| `#9f1f2b` danger | `#fbeaea` danger tint | **6.68:1** | ≥ 4.5:1 | `.badge--cancelled`, `.pill--busy`, `.field-error`, `.problem-list` |
| `#7a4a00` warning | `#fbf0dd` warning tint | **6.63:1** | ≥ 4.5:1 | `.badge--draft`, `.badge--contacted`, `.alert--warning` |
| `#1f4d75` info | `#e7eef5` info tint | **7.55:1** | ≥ 4.5:1 | `.badge--completed`, `.badge--new` |
| `#eaf3f5` rail text | `#0e2b33` sidebar rail | **13.20:1** | ≥ 4.5:1 | `.admin-sidebar`, `.site-footer` |
| `#b6cdd2` rail muted | `#0e2b33` sidebar rail | **8.96:1** | ≥ 4.5:1 | `.admin-nav__heading`, `.admin-user__role`, `.site-footer__note` |
| `#ffffff` active label | `#1f6472` active rail item | **6.72:1** | ≥ 4.5:1 | `.admin-nav__link.is-active` |
| `#a8e2ec` rail focus | `#1f6472` active rail item | **4.72:1** | ≥ 3:1 | focus ring on the sidebar rail |

### Dark mode

| Foreground | Background | Ratio | Requirement | Used by |
|---|---|---|---|---|
| `#e8eef2` body text | `#16212a` card surface | **13.96:1** | ≥ 4.5:1 | all body copy |
| `#e8eef2` body text | `#0e1519` page background | **15.74:1** | ≥ 4.5:1 | all body copy |
| `#b0bfc9` muted text | `#16212a` card surface | **8.67:1** | ≥ 4.5:1 | hints, metadata |
| `#b0bfc9` muted text | `#0e1519` page background | **9.77:1** | ≥ 4.5:1 | secondary copy |
| `#93a3ae` faint text | `#16212a` card surface | **6.30:1** | ≥ 4.5:1 (large) | `.breadcrumbs` |
| `#7ccfdf` primary | `#16212a` card surface | **9.22:1** | ≥ 4.5:1 | links, `.stat__value` |
| `#7ccfdf` primary | `#143039` brand tint | **7.84:1** | ≥ 4.5:1 | selected nav item, row hover |
| `#06222a` button label | `#7ccfdf` primary fill | **9.33:1** | ≥ 4.5:1 | `.button--primary`, `.skip-link` |
| `#5f7280` hairline | `#16212a` card surface | **3.27:1** | ≥ 3:1 (UI edge) | card, table and panel borders |
| `#5f7280` hairline | `#0e1519` page background | **3.69:1** | ≥ 3:1 (UI edge) | section dividers |
| `#6b7d8d` strong border | `#16212a` card surface | **3.85:1** | ≥ 3:1 (UI edge) | inputs, selects, ghost buttons |
| `#8fddea` focus ring | `#16212a` / `#0e1519` | **10.66:1 / 12.02:1** | ≥ 3:1 | `:focus-visible` outline |
| `#82d9a3` confirmed | `#10281c` success tint | **9.24:1** | ≥ 4.5:1 | confirmed / available states |
| `#f4a7ac` danger | `#33161a` danger tint | **8.63:1** | ≥ 4.5:1 | cancelled / busy states |
| `#eec684` warning | `#2c2413` warning tint | **9.53:1** | ≥ 4.5:1 | draft / contacted states |
| `#a3cef0` info | `#132434` info tint | **9.51:1** | ≥ 4.5:1 | completed / new states |
| `#eaf3f5` rail text | `#0a1d23` sidebar rail | **15.37:1** | ≥ 4.5:1 | `.admin-sidebar`, `.site-footer` |
| `#b3cbd1` rail muted | `#0a1d23` sidebar rail | **10.21:1** | ≥ 4.5:1 | sidebar headings, footer note |
| `#ffffff` active label | `#20697a` active rail item | **6.24:1** | ≥ 4.5:1 | `.admin-nav__link.is-active` |
| `#a8e2ec` rail focus | `#20697a` active rail item | **4.39:1** | ≥ 3:1 | focus ring on the sidebar rail |

Status colour is never the **only** signal: every badge, pill and alert carries its
label as text, every busy timeline row is striped as well as tinted, and the live
availability result is announced in words, not colour.

---

## 2. Responsive breakpoints

Mobile-first; the base stylesheet is the 360 px layout.

| Breakpoint | What changes |
|---|---|
| base (360 px+) | single column; public nav collapsed behind `[data-nav-toggle]`; admin sidebar off-canvas; tables scroll inside `.table-wrap`; `.stat-grid` is `auto-fit, minmax(180px, 1fr)` |
| `min-width: 640px` | `.form-grid` and `.filter-bar` go multi-column; `.split-layout` becomes 2:1; `.detail-list` becomes a label/value table; wider gutters |
| `min-width: 768px` | public nav expands horizontally and `[data-nav-toggle]` is hidden; `.space-grid` becomes 2–3 up; tables drop their forced minimum width |
| `min-width: 900px` | admin sidebar becomes a sticky `264px` rail in the shell grid; `[data-sidebar-toggle]` is hidden; the off-canvas scrim is disabled |
| `min-width: 1280px` | wider content cap and gutters |

Rules are written so nothing can force the viewport wider than the device:

- the only fixed minimum width (`--ng-timeline`/`.data-table { min-width: 34rem }`) sits
  inside `.table-wrap { overflow-x: auto }`, so wide tables scroll **inside** the wrapper;
- the off-canvas sidebar translates to a negative X (negative overflow never produces a
  scrollbar);
- every multi-column track is `minmax(…, 1fr)` / `auto-fit`, and the grid and flex
  children that can hold long unbroken text (`.form-field`, `.filter-bar__field`,
  `.card__body`, `.admin-main`, `.space-card__title a`) carry `min-width: 0`;
- `.stat-grid` is `repeat(auto-fit, minmax(180px, 1fr))`, so it is one column at 360 px
  and four at 1280 px without any additional media query;
- `.confirm-dialog` is `min(34rem, calc(100vw - 2rem))`.

This was checked by static analysis of every rule that sets a width, minimum width or
`nowrap`. A pixel-level confirmation in a real browser at the three widths has **not**
been run: no desktop browser was reachable from the agent session that wrote this code,
and the server was still being built. Re-run it against the running app
(`npm start`, then 360 / 768 / 1280 px on `/`, `/spaces/:code`, `/admin` and
`/admin/reservations/new`) as part of integration testing.

---

## 3. Client-side feature inventory and data-attribute contracts

Each feature is initialised independently and returns immediately when its markup is
absent, so a page can carry any subset. `public.js` runs on public pages, `admin.js` on
the admin shell.

### `public.js`

| Feature | Contract it depends on | Behaviour |
|---|---|---|
| Mobile nav toggle | `[data-nav-toggle]` + `.site-nav` | toggles `aria-expanded`, adds `body.nav-open`; Escape closes and restores focus. Also assigns `id="public-nav"` to the `<nav>` so the `aria-controls` already in `layout.js` resolves to a real element |
| Availability checker | `[data-availability-form]` with `[name=date]`, `[name=start_time]`, `[name=end_time]`, `[name=desks]`; output `[data-availability-result]` | on submit, `fetch()` GET `/api/public/availability?space=&start=&end=&desks=`, renders a sentence plus the provisional caveat, class `availability-result--ok` or `availability-result--busy`. Space code comes from `form[data-space]`, else `[name=space]`, else the `/spaces/:code` path |
| Availability prefill | `?date=&start=&end=&desks=` in the URL | fills empty fields only (each value validated against a strict pattern) and, when the full window arrived, runs the check immediately |
| Gallery | `[data-gallery-main]` (an `<img>`) and one `[data-gallery-thumb]` per photograph | thumbnails are `<button>`s; click/Enter/Space copies `data-src`/`data-alt` (or the inner `<img>`) into the main image and sets `aria-current="true"` on the active thumb |
| Dismissible flashes | `[data-flash]` containing `[data-dismiss]` | removes the alert from the DOM |
| Confirmation | `<form data-confirm="…">` | `confirm()` before submitting; refusal cancels the submission |

`public.js` **never** disables the form without JS, and always leaves the form a working
`action`/`method` so the no-JS path still reaches the server.

### `admin.js`

| Feature | Contract it depends on | Behaviour |
|---|---|---|
| Sidebar toggle | `[data-sidebar-toggle]` (with `aria-controls="admin-sidebar"`) | toggles `aria-expanded` + `body.sidebar-open`; Escape, outside-click and resize ≥ 900 px close it |
| Dismissible flashes | `[data-flash]` + `[data-dismiss]` | same as public |
| Confirmation | `<form data-confirm="…">` | destructive actions (cancel, archive, delete image) confirm first; registered before the submit guard so a refused confirmation never disables a button |
| Customer picker | `[data-customer-search]` (or any `input[role="combobox"][aria-controls]`), `[name=customer_id]`, `[data-customer-display]`, `[data-customer-clear]`, `[data-new-customer-fields]`, optional `[data-new-customer-toggle]` | `role="combobox"` + `aria-expanded` + `aria-controls` + `aria-activedescendant` over a `role="listbox"`; Arrow keys, Home/End, Enter to select, Escape to close, Tab closes. Debounced 200 ms query to `/api/admin/customers/search?q=`. Selecting an item fills the hidden `customer_id` and writes the name/e-mail/organisation into `[data-customer-display]`. The always-present “New customer” option clears the id, reveals `[data-new-customer-fields]` and focuses its first field. The popup is anchored directly under the input with an inline `top`, because the view's wrapper also holds the hint and the action buttons |
| Live availability | booking form marked `[data-reservation-form]` — or, failing that, the first form containing `[name=space_id]` — with `[name=space_id]`, a date (`[name=start_date]`/`[name=date]`), times (`[name=start_time]`+`[name=end_time]`, or `[name=start_at]`+`[name=end_at]`), desks (`[name=unit_count]`/`[name=desks]`) and output `[data-availability-result]` | debounced 400 ms `fetch()` of `/api/admin/availability?space=&start=&end=&desks=`. Free → success panel, submits stay enabled. Conflict → `availability-result--busy`, each blocking entry from `conflicts[]` listed as `label (start → end) · unit` (reading `details.conflicts` from an error envelope too), submit buttons disabled with a `data-blocked-reason`, and a polite `aria-live` announcement |
| Double-submit guard | same form | on submit (and only if no earlier listener cancelled it) the buttons are disabled, `aria-busy="true"` is set and the submitter's `name`/`value` is preserved in a hidden field. If the live check already knows the slot is busy, submission is blocked entirely with an explanation and focus moves to the result |
| Desk quantity helper | `[name=unit_count]`/`[name=desks]`, plus `[data-desk-hint]` | writes “N of M desks free for this period.” from the availability payload; turns red at zero. The views do **not** render `[data-desk-hint]`, so the script creates the line next to the desk field rather than letting the feature silently disappear |
| Filter auto-submit | `.filter-bar__field select` (and any `select` inside `[data-auto-submit]`) | submits the enclosing form on change. Free-text inputs are never auto-submitted |
| Scrollable tables | `.table-wrap` | adds `tabindex="0"`/`role="region"` while the wrapper actually overflows |
| Announcements | created on demand as `[data-announcer]` | one polite live region for every asynchronous message |

Both scripts follow two hard rules: **no `innerHTML` with server data** (every value from
a JSON response reaches the DOM through `textContent` or `document.createElement`), and
no global error swallowing — a feature that cannot find its markup returns quietly, and
only that feature is affected.

---

## 4. Keyboard and screen-reader notes

- **Focus is never removed.** `:focus-visible` gets a 3 px `--ng-focus-ring` outline with
  a 2 px offset on every interactive element; form controls additionally change border
  colour on plain `:focus` so the affordance survives browsers without `:focus-visible`.
- **Skip link** is visible only when focused and jumps to `#main` on both shells.
- **Navigation** uses real links with `aria-current="page"` for the active entry.
- **Combobox semantics** follow the ARIA 1.2 pattern: the input owns `aria-expanded`,
  `aria-controls`, `aria-activedescendant`; options are `role="option"` with
  `aria-selected` tracked on the active one; the list opens on typing or ArrowDown and
  closes on Escape, Tab or outside click. Options are committed on `mousedown` so the
  selection beats the input's blur.
- **Asynchronous results** are announced through a polite live region: availability
  answers, blocked submissions, customer selections and the “Submitting…” state.
- **Timelines** are read as hour rows; the positioned block is additive, and each block
  carries its own accessible text (the view supplies `label`/`reference`).
- **Dialogs** use the native `<dialog>` element, so focus trapping and Escape handling
  come from the platform.
- `prefers-reduced-motion: reduce` removes transitions, the hover lift on cards, and
  smooth scrolling.

**Timeline convention** (also commented at the top of `styles.css`): hour rows are
`.timeline__slot` inside `.timeline`, each one `--ng-timeline-hour` tall, coloured with
`.timeline__slot--free` / `.timeline__slot--busy`. A booking block is positioned with two
unitless **minute** values — `style="--start: 570; --span: 90"` — and the stylesheet turns
them into `top`/`height` through `--ng-timeline-minute`. Inline `top`/`height` still wins,
so a view that positions blocks itself is not fought by the stylesheet; without either, a
block defaults to one hour at the top of the window rather than disappearing.

`calendarViews.js` (as shipped) lists each hour's occupants *inside* the hour row, so no
absolute positioning is needed for it to be readable — the positioning rules exist for a
future day/week view that spans blocks across hours, and the ownership of `position:
absolute` sits here because a view cannot add it without touching this stylesheet. Its
maintenance occupants use a bare `<span class="timeline__block--muted">`, which is why
that modifier carries its own padding, border and background instead of assuming it is
combined with `.timeline__block`. `.timeline-legend` is the matching key.

## 3b. What the view layer actually provides (verified against the source)

Every hook below was confirmed present in `src/web/views/**` and is what the two scripts
bind to: `[data-nav-toggle]`, `[data-sidebar-toggle]`, `[data-flash]`, `[data-dismiss]`,
`[data-confirm]`, `[data-availability-form]` (+ `data-space`), `[data-availability-result]`,
`[data-gallery-main]`, `[data-gallery-thumb]` (+ `data-src`/`data-alt`),
`[data-customer-search]` (`role="combobox"`, `aria-controls="customer-search-listbox"`),
`[name=customer_id]`, `[data-customer-display]`, `[data-customer-clear]`,
`[data-new-customer-toggle]`, `[data-new-customer-fields]` (`<details open>`),
`[data-reservation-form]` (+ `data-tz-offset="+03:00"`), `[data-space-code]`.

Field names in the admin booking form are `space_id`, `date`, `start_time`, `end_time`,
`unit_count` — so the live check reads `date` (not `start_date`) and `unit_count`, and the
public checker uses `date`, `start_time`, `end_time`, `desks`.

---

## 5. What degrades without JavaScript

Everything that matters. No core flow depends on script:

| Without JS | Result |
|---|---|
| Mobile public nav | **shown, not hidden**: `@media (scripting: none)` undoes the collapsed state and removes the toggle button, so the links stay reachable on a phone. On ≥ 768 px the nav is always horizontal anyway |
| Admin sidebar | **shown, not hidden**: `@media (scripting: none)` turns the rail back into a static full-width block above the content and hides the inert toggle |
| Availability checker | submits as an ordinary form to its `action`; the server answers normally. No instant answer, no caveat swap |
| Availability prefill | still works — the query string reaches the server and the server can prefill the fields |
| Gallery | every photograph is present as a static image/thumbnail; the main image stays on the cover |
| Flash alerts | stay visible; `[data-dismiss]` is a no-op button that does nothing harmful |
| Confirmations | the server enforces every rule anyway (cancel requires a reason, publish requires a photograph, overlaps are rejected in the transaction). The dialog is a courtesy |
| Customer picker | `[name=customer_id]` stays empty and the ordinary customer fields are all real form fields, so a new customer can always be entered by hand — this is exactly why `admin.js` never hides `[data-new-customer-fields]` when the view renders it as `<details open>` (the no-JS path) and why it reveals it by setting `open`, not by removing `hidden` |
| Live availability re-check | gone; the server revalidates inside the booking transaction on POST and returns `409 DOUBLE_BOOKING_CONFLICT` with details |
| Desk hint, filter auto-submit | gone; the filter form has a visible submit button |
| Double-submit guard | gone; the server's idempotency key and transaction revalidation remain the real protection |

The client-side availability checks are explicitly **provisional previews**. They never
replace the server's revalidation, and the wording in the UI says so in every state.

The `scripting` media feature is supported by current Chrome, Edge, Firefox and Safari;
in a browser old enough to lack it, the mobile nav and the admin rail fall back to the
collapsed layout above. That is the single known residual no-JS gap, and it only affects
browsers that are already outside the project's support envelope (ES modules, `fetch`,
`color-mix()` and `:has()` are used elsewhere).
