/**
 * Page shells. Both shells render complete documents; no client-side
 * framework is required for any core workflow.
 */
import { html, raw, join } from '../lib/html.js';
import { ADMIN_ROLE, ADMIN_ROLE_LABEL, isAdminRole } from '../../server/domain/constants.js';

/** Geometric "workspace skyline" brand mark. */
function brandMark() {
  return html`<span class="brand__mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 20V9M10 20V4M16 20v-7M21 20H3" />
    </svg>
  </span>`;
}

/** Crisp 18x18 inline SVG line icon for admin navigation and chrome controls. */
function navIcon(paths) {
  return raw(`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`);
}

const PUBLIC_NAV = [
  { href: '/', label: 'Discover' },
  { href: '/spaces', label: 'Spaces' },
  { href: '/book', label: 'Book' },
];

const ADMIN_NAV = [
  { group: 'Operations', items: [
    {
      href: '/admin',
      label: 'Dashboard',
      icon: navIcon('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
    },
    {
      href: '/admin/calendar',
      label: 'Calendar',
      icon: navIcon('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>'),
    },
    {
      href: '/admin/reservations',
      label: 'Reservations',
      icon: navIcon('<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 14 2 2 4-4"/>'),
    },
    {
      href: '/admin/inquiries',
      label: 'Inquiries',
      icon: navIcon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
    },
    {
      href: '/admin/booking-requests',
      label: 'Booking requests',
      icon: navIcon('<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/>'),
    },
  ] },
  { group: 'Catalogue', items: [
    {
      href: '/admin/spaces',
      label: 'Spaces',
      icon: navIcon('<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M10 21v-4h4v4"/>'),
    },
    {
      href: '/admin/maintenance',
      label: 'Maintenance',
      icon: navIcon('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    },
    {
      href: '/admin/guider-knowledge',
      label: 'Guider knowledge',
      adminOnly: true,
      icon: navIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h7"/>'),
    },
  ] },
  { group: 'Records', items: [
    {
      href: '/admin/customers',
      label: 'Customers',
      icon: navIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
    },
    {
      href: '/admin/team',
      label: 'Team & access',
      superAdminOnly: true,
      icon: navIcon('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
    },
    {
      href: '/admin/audit',
      label: 'Activity log',
      icon: navIcon('<path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/>'),
    },
  ] },
];

function flashRegion(flash) {
  if (!flash || !flash.message) return '';
  const kind = flash.kind === 'error' ? 'alert--error'
    : flash.kind === 'warning' ? 'alert--warning'
      : 'alert--success';
  return html`<div class="alert ${kind}" role="status" data-flash>
    <p>${flash.message}</p>
    ${flash.problems && flash.problems.length
    ? html`<ul>${flash.problems.map((p) => html`<li>${p}</li>`)}</ul>`
    : ''}
    <button type="button" class="alert__close" data-dismiss aria-label="Dismiss">×</button>
  </div>`;
}

function documentHead({ title, description }) {
  return html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${description ? html`<meta name="description" content="${description}">` : ''}
<link rel="stylesheet" href="/assets/styles.css">
<link rel="icon" href="/assets/trace-media/brand/trace-logo-original.jpg" type="image/jpeg">`;
}

export function publicShell({
  title, description = null, body, activePath = '/', pageClass = '', version = null,
}) {
  return html`<!doctype html>
<html lang="en">
<head>
${documentHead({ title: `${title} · TRACE Spaces`, description })}
</head>
<body class="page page--public ${pageClass}">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header trace-header">
  <div class="site-header__inner">
    <a class="brand trace-brand" href="/" aria-label="TRACE Spaces home">
      <span class="trace-brand__mark" aria-hidden="true">T</span>
      <span class="brand__word"><span class="brand__name">TRACE</span>
        <span class="brand__sub">Spaces / Colombo</span></span>
    </a>
    <nav class="site-nav" id="public-nav" aria-label="Main">
      ${PUBLIC_NAV.map((item) => html`<a href="${item.href}"
        class="site-nav__link ${activePath === item.href ? 'is-active' : ''}"
        ${activePath === item.href ? raw('aria-current="page"') : ''}>${item.label}</a>`)}
    </nav>
    <div class="site-header__actions">
      <a class="trace-header__staff" href="/admin">Staff</a>
      <a class="trace-header__book" href="/book">Book a space <span aria-hidden="true">↗</span></a>
    </div>
  </div>
  <button class="site-nav__toggle" type="button" data-nav-toggle aria-expanded="false" aria-controls="public-nav">Menu</button>
</header>
<main id="main" class="site-main">
${body}
</main>
<footer class="site-footer">
  <div class="site-footer__inner footer__grid">
    <div class="site-footer__brand footer__brand">
      <div class="brand">
        ${brandMark()}
        <span class="brand__word"><span class="brand__name">TRACE Spaces</span>
          <span class="brand__sub">Colombo</span></span>
      </div>
      <p>Spaces with history, built for what comes next.</p>
      <p class="site-footer__note">Choose your time and review the total before booking. Availability is checked again at checkout.</p>
    </div>
    <nav class="footer__nav" aria-label="Spaces and booking">
      <h2 class="site-footer__heading">Spaces &amp; Booking</h2>
      <ul class="site-footer__links">
        <li><a href="/">Home</a></li>
        <li><a href="/spaces">All spaces</a></li>
        <li><a href="/book">Book a space</a></li>
        <li><a href="/spaces?category=MEETING_ROOM">Meeting rooms</a></li>
        <li><a href="/spaces?category=AUDITORIUM">Auditoriums &amp; event halls</a></li>
        <li><a href="/spaces?category=COWORKING">Co-working desks</a></li>
      </ul>
    </nav>
    <div class="footer__ops">
      <h2 class="site-footer__heading">Operations Desk</h2>
      <p class="site-footer__note">All booking times are shown in Sri Lanka Standard Time (UTC+05:30).</p>
      <p><a href="/admin">Staff operations portal →</a></p>
      ${version ? html`<p class="site-footer__version">Build ${version}</p>` : ''}
    </div>
  </div>
  <div class="site-footer__inner footer__base">
    <span>TRACE Spaces — Trace Expert City, Colombo</span>
    <span>Live schedules · protected checkout · SLST</span>
  </div>
</footer>
<script type="module" src="/assets/public.js"></script>
<script type="module" src="/assets/public-experience.js"></script>
</body>
</html>`;
}

function notificationBell(csrfToken) {
  return html`<div class="admin-bell" data-notification-bell data-csrf="${csrfToken}">
    <button class="admin-bell__button" type="button" data-notification-toggle
            aria-expanded="false" aria-controls="admin-notification-panel" aria-label="Notifications">
      ${navIcon('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>')}
      <span class="admin-bell__badge" data-notification-badge hidden>0</span>
    </button>
    <section class="admin-bell__panel" id="admin-notification-panel" data-notification-panel hidden aria-label="Notifications">
      <header class="admin-bell__head">
        <div>
          <p class="section-eyebrow">Operations</p>
          <h2 class="admin-bell__title">Notifications</h2>
        </div>
        <button class="button button--ghost button--small" type="button" data-notification-enable hidden>Enable desktop alerts</button>
      </header>
      <p class="hint admin-bell__status" data-notification-bell-status role="status" aria-live="polite"></p>
      <div class="admin-bell__list" data-notification-list>
        <p class="hint">Loading notifications…</p>
      </div>
      <footer class="admin-bell__foot">
        <a href="/admin/notifications">View all notifications</a>
        <button class="button button--ghost button--small" type="button" data-notification-read-all>Mark all read</button>
      </footer>
    </section>
  </div>`;
}

export function adminShell({
  title, actor, csrfToken, flash = null, activePath = '/admin', body, breadcrumbs = [],
  pageActions = null, subtitle = null, extraStyles = [], extraScripts = [],
}) {
  const roleLabel = ADMIN_ROLE_LABEL[actor?.role] ?? adminRoleFallback(actor?.role);
  return html`<!doctype html>
<html lang="en">
<head>
${documentHead({ title: `${title} · TRACE Ops` })}
<meta name="csrf-token" content="${csrfToken}">
${extraStyles.map((href) => html`<link rel="stylesheet" href="${href}">`)}
<link rel="stylesheet" href="/assets/admin-shell.css">
<link rel="stylesheet" href="/assets/admin-notifications.css">
</head>
<body class="page page--admin">
<a class="skip-link" href="#main">Skip to main content</a>
<div class="app-shell admin-shell">
  <aside class="sidebar admin-sidebar" id="admin-sidebar">
    <div class="sidebar__brand admin-sidebar__brand">
      <a class="brand" href="/admin" aria-label="TRACE operations home">
        ${brandMark()}
        <span class="brand__word"><span class="brand__name">TRACE</span>
          <span class="brand__sub">Operations</span></span>
      </a>
    </div>
    <nav class="sidebar__nav admin-nav" aria-label="TRACE operations administration">
      ${ADMIN_NAV.map((section) => html`<div class="nav-group admin-nav__section">
        <h2 class="admin-nav__heading">${section.group}</h2>
        <ul class="admin-nav__list">
          ${section.items
    .filter((item) => !item.adminOnly || isAdminRole(actor?.role))
    .filter((item) => !item.superAdminOnly || actor?.role === ADMIN_ROLE.SUPER_ADMIN)
    .map((item) => html`<li>
            <a href="${item.href}"
               class="nav-link admin-nav__link ${isActiveNav(activePath, item.href) ? 'is-active' : ''}"
               ${isActiveNav(activePath, item.href) ? raw('aria-current="page"') : ''}>
              <span class="admin-nav__icon" aria-hidden="true">${item.icon}</span>
              <span>${item.label}</span>
            </a>
          </li>`)}
        </ul>
      </div>`)}
    </nav>
    <div class="sidebar__user admin-sidebar__footer">
      <p class="admin-user">
        <span class="admin-user__name">${actor?.displayName ?? 'Staff'}</span>
        <span class="admin-user__role">${roleLabel}</span>
      </p>
      <div class="admin-user__actions">
        <a class="button button--ghost button--small" href="/admin/account">My account</a>
        <form method="post" action="/admin/logout" class="inline-form">
          <input type="hidden" name="_csrf" value="${csrfToken}">
          <button class="button button--ghost button--small" type="submit">Sign out</button>
        </form>
      </div>
    </div>
  </aside>
  <div class="maincol admin-main">
    <header class="topbar admin-topbar">
      <button class="admin-topbar__menu" type="button" data-sidebar-toggle aria-expanded="false" aria-controls="admin-sidebar" aria-label="Toggle navigation">
        ${navIcon('<path d="M4 6h16M4 12h16M4 18h16"/>')}
      </button>
      ${breadcrumbs.length
    ? html`<nav class="page-crumb breadcrumbs" aria-label="Breadcrumb"><ol>
          ${breadcrumbs.map((crumb, index) => html`<li>
            ${crumb.href && index < breadcrumbs.length - 1
    ? html`<a href="${crumb.href}">${crumb.label}</a>`
    : html`<span ${index === breadcrumbs.length - 1 ? raw('aria-current="page"') : ''}>${crumb.label}</span>`}
          </li>`)}
        </ol></nav>`
    : html`<span class="breadcrumbs breadcrumbs--empty"></span>`}
      <div class="topbar__actions admin-topbar__actions">
        <form class="admin-search-form" method="get" action="/admin/search" role="search">
          <label class="visually-hidden" for="admin-global-search">Search the admin console</label>
          <input id="admin-global-search" name="q" type="search" maxlength="120"
                 placeholder="Search records…" autocomplete="off" data-admin-search>
          <button class="admin-search-form__button" type="submit" aria-label="Search">
            ${navIcon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}
          </button>
        </form>
        ${notificationBell(csrfToken)}
        <span class="tag" title="Business timezone: Asia/Colombo">SLST · UTC+05:30</span>
        <a class="button button--ghost button--small" href="/" target="_blank" rel="noopener">View public site</a>
        ${pageActions ?? ''}
      </div>
    </header>
    <div class="admin-prep-strip" data-notification-prep hidden role="status" aria-live="polite">
      <span class="admin-prep-strip__mark" aria-hidden="true">!</span>
      <span class="admin-prep-strip__copy">
        <strong data-notification-prep-title>Room preparation reminder</strong>
        <span data-notification-prep-body></span>
      </span>
      <a class="admin-prep-strip__open" href="/admin/notifications" data-notification-prep-open>Open</a>
      <button class="admin-prep-strip__dismiss" type="button" data-notification-prep-dismiss aria-label="Dismiss this room preparation reminder">×</button>
    </div>
    <main id="main" class="admin-content">
      <div class="page-head admin-page-head">
        <div>
          <h1 class="page-title">${title}</h1>
          ${subtitle ? html`<p class="page-sub page-subtitle">${subtitle}</p>` : ''}
        </div>
      </div>
      <div class="flash-stack" aria-live="polite">${flashRegion(flash)}</div>
      <div class="page-body" data-page-body>${body}</div>
    </main>
  </div>
</div>
<script type="module" src="/assets/admin.js"></script>
<script type="module" src="/assets/admin-search.js"></script>
<script type="module" src="/assets/admin-notifications.js"></script>
${extraScripts.map((src) => html`<script type="module" src="${src}"></script>`)}
</body>
</html>`;
}

function adminRoleFallback(role) {
  if (!role) return '';
  return String(role).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function isActiveNav(activePath, href) {
  if (href === '/admin') return activePath === '/admin';
  return activePath === href || activePath.startsWith(`${href}/`);
}

export function pageContainer({ title = null, description = null, actions = null, body, modifiers = '' }) {
  return html`<section class="container ${modifiers}">
    ${(title || actions)
    ? html`<div class="section-head">
        <div>
          ${title ? html`<h2 class="section-title">${title}</h2>` : ''}
          ${description ? html`<p class="section-subtitle">${description}</p>` : ''}
        </div>
        ${actions ? html`<div class="section-actions">${actions}</div>` : ''}
      </div>`
    : ''}
    ${body}
  </section>`;
}

export function card({ title = null, description = null, actions = null, body, modifiers = '' }) {
  return html`<article class="card ${modifiers}">
    ${(title || actions)
    ? html`<header class="card__head">
        <div>
          ${title ? html`<h2 class="card__title">${title}</h2>` : ''}
          ${description ? html`<p class="card__description">${description}</p>` : ''}
        </div>
        ${actions ? html`<div class="card__actions">${actions}</div>` : ''}
      </header>`
    : ''}
    <div class="card__body">${body}</div>
  </article>`;
}

export function table({ columns, rows, emptyMessage = 'Nothing to show.', modifiers = '', label = 'Data table' }) {
  if (!rows || rows.length === 0) {
    return html`<div class="table-wrap ${modifiers}" tabindex="0" role="region" aria-label="${label}">
      <table class="data-table">
        <thead><tr>${columns.map((c) => html`<th scope="col" class="${c.align === 'right' ? 'is-right' : ''}">${c.label}</th>`)}</tr></thead>
      </table>
      <p class="table-empty">${emptyMessage}</p>
    </div>`;
  }
  return html`<div class="table-wrap ${modifiers}" tabindex="0" role="region" aria-label="${label}">
    <table class="data-table">
      <thead>
        <tr>${columns.map((c) => html`<th scope="col" class="${c.align === 'right' ? 'is-right' : ''} ${c.className ?? ''}">${c.label}</th>`)}</tr>
      </thead>
      <tbody>
        ${rows.map((row) => html`<tr>${row.cells.map((cell, index) => html`<td class="${columns[index]?.align === 'right' ? 'is-right' : ''} ${columns[index]?.className ?? ''}">${cell}</td>`)}</tr>`)}
      </tbody>
    </table>
  </div>`;
}

export { join };
