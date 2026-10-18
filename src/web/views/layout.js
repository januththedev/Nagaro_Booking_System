/**
 * Page shells. Both shells render complete documents; no client-side
 * framework is required for any core workflow.
 */
import { html, raw, join } from '../lib/html.js';

const PUBLIC_NAV = [
  { href: '/', label: 'Home' },
  { href: '/spaces', label: 'Spaces' },
  { href: '/booking-request', label: 'Request a booking' },
];

const ADMIN_NAV = [
  { group: 'Operations', items: [
    { href: '/admin', label: 'Dashboard', icon: '▤' },
    { href: '/admin/calendar', label: 'Calendar', icon: '▦' },
    { href: '/admin/reservations', label: 'Reservations', icon: '▣' },
    { href: '/admin/inquiries', label: 'Inquiries', icon: '✉' },
  ] },
  { group: 'Catalogue', items: [
    { href: '/admin/spaces', label: 'Spaces', icon: '▢' },
    { href: '/admin/maintenance', label: 'Maintenance', icon: '⚙' },
  ] },
  { group: 'Records', items: [
    { href: '/admin/customers', label: 'Customers', icon: '◍' },
    { href: '/admin/audit', label: 'Activity log', icon: '⎙' },
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
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">`;
}

export function publicShell({
  title, description = null, body, activePath = '/', pageClass = '', version = null,
}) {
  return html`<!doctype html>
<html lang="en">
<head>
${documentHead({ title: `${title} · Nagaro Space Booking`, description })}
</head>
<body class="page page--public ${pageClass}">
<a class="skip-link" href="#main">Skip to main content</a>
<header class="site-header">
  <div class="site-header__inner">
    <a class="brand" href="/">
      <span class="brand__mark" aria-hidden="true">N</span>
      <span class="brand__text">
        <span class="brand__name">Nagaro</span>
        <span class="brand__sub">Trace Expert City</span>
      </span>
    </a>
    <nav class="site-nav" aria-label="Main">
      ${PUBLIC_NAV.map((item) => html`<a href="${item.href}"
        class="site-nav__link ${activePath === item.href ? 'is-active' : ''}"
        ${activePath === item.href ? raw('aria-current="page"') : ''}>${item.label}</a>`)}
    </nav>
    <div class="site-header__actions">
      <a class="button button--ghost button--small" href="/admin">Staff sign in</a>
    </div>
  </div>
  <button class="site-nav__toggle" type="button" data-nav-toggle aria-expanded="false" aria-controls="public-nav">Menu</button>
</header>
<main id="main" class="site-main">
${body}
</main>
<footer class="site-footer">
  <div class="site-footer__inner">
    <p>Nagaro space booking · Trace Expert City, Addis Ababa</p>
    <p class="site-footer__note">Availability shown on this site is provisional. A booking is only confirmed once Nagaro staff confirm it.</p>
    ${version ? html`<p class="site-footer__version">Build ${version}</p>` : ''}
  </div>
</footer>
<script type="module" src="/assets/public.js"></script>
</body>
</html>`;
}

export function adminShell({
  title, actor, csrfToken, flash = null, activePath = '/admin', body, breadcrumbs = [],
  pageActions = null, subtitle = null,
}) {
  return html`<!doctype html>
<html lang="en">
<head>
${documentHead({ title: `${title} · Nagaro Admin` })}
</head>
<body class="page page--admin">
<a class="skip-link" href="#main">Skip to main content</a>
<div class="admin-shell">
  <aside class="admin-sidebar" id="admin-sidebar">
    <div class="admin-sidebar__brand">
      <span class="brand__mark" aria-hidden="true">N</span>
      <span class="brand__text">
        <span class="brand__name">Nagaro</span>
        <span class="brand__sub">Admin</span>
      </span>
    </div>
    <nav class="admin-nav" aria-label="Administration">
      ${ADMIN_NAV.map((section) => html`<div class="admin-nav__section">
        <h2 class="admin-nav__heading">${section.group}</h2>
        <ul class="admin-nav__list">
          ${section.items.map((item) => html`<li>
            <a href="${item.href}"
               class="admin-nav__link ${isActiveNav(activePath, item.href) ? 'is-active' : ''}"
               ${isActiveNav(activePath, item.href) ? raw('aria-current="page"') : ''}>
              <span class="admin-nav__icon" aria-hidden="true">${item.icon}</span>
              <span>${item.label}</span>
            </a>
          </li>`)}
        </ul>
      </div>`)}
    </nav>
    <div class="admin-sidebar__footer">
      <p class="admin-user">
        <span class="admin-user__name">${actor?.displayName ?? 'Staff'}</span>
        <span class="admin-user__role">${actor?.role ?? ''}</span>
      </p>
      <form method="post" action="/admin/logout" class="inline-form">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <button class="button button--ghost button--small" type="submit">Sign out</button>
      </form>
    </div>
  </aside>
  <div class="admin-main">
    <header class="admin-topbar">
      <button class="admin-topbar__menu" type="button" data-sidebar-toggle aria-expanded="false" aria-controls="admin-sidebar">☰</button>
      ${breadcrumbs.length
    ? html`<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>
          ${breadcrumbs.map((crumb, index) => html`<li>
            ${crumb.href && index < breadcrumbs.length - 1
    ? html`<a href="${crumb.href}">${crumb.label}</a>`
    : html`<span ${index === breadcrumbs.length - 1 ? raw('aria-current="page"') : ''}>${crumb.label}</span>`}
          </li>`)}
        </ol></nav>`
    : html`<span class="breadcrumbs breadcrumbs--empty"></span>`}
      <div class="admin-topbar__actions">
        <a class="button button--ghost button--small" href="/" target="_blank" rel="noopener">View public site</a>
        ${pageActions ?? ''}
      </div>
    </header>
    <main id="main" class="admin-content">
      <div class="admin-page-head">
        <div>
          <h1 class="page-title">${title}</h1>
          ${subtitle ? html`<p class="page-subtitle">${subtitle}</p>` : ''}
        </div>
      </div>
      ${flashRegion(flash)}
      <div data-page-body>${body}</div>
    </main>
  </div>
</div>
<script type="module" src="/assets/admin.js"></script>
</body>
</html>`;
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
          ${title ? html`<h3 class="card__title">${title}</h3>` : ''}
          ${description ? html`<p class="card__description">${description}</p>` : ''}
        </div>
        ${actions ? html`<div class="card__actions">${actions}</div>` : ''}
      </header>`
    : ''}
    <div class="card__body">${body}</div>
  </article>`;
}

export function table({ columns, rows, emptyMessage = 'Nothing to show.', modifiers = '' }) {
  if (!rows || rows.length === 0) {
    return html`<div class="table-wrap ${modifiers}">
      <table class="data-table">
        <thead><tr>${columns.map((c) => html`<th scope="col" class="${c.align === 'right' ? 'is-right' : ''}">${c.label}</th>`)}</tr></thead>
      </table>
      <p class="table-empty">${emptyMessage}</p>
    </div>`;
  }
  return html`<div class="table-wrap ${modifiers}">
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
