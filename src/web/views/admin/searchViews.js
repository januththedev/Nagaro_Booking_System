/**
 * Global search results, grouped by record type. The results are links into
 * the existing record pages; search never mutates data.
 */
import { html } from '../../lib/html.js';
import { adminShell } from '../layout.js';

function resultCard(item, kind) {
  return html`<a class="search-result" href="${item.href}">
    <span class="search-result__copy">
      <strong class="search-result__title">${item.title}</strong>
      ${item.subtitle ? html`<span class="search-result__subtitle">${item.subtitle}</span>` : ''}
      ${item.meta ? html`<span class="search-result__meta">${kind} \u00b7 ${item.meta}</span>` : ''}
    </span>
    <span class="search-result__arrow" aria-hidden="true">\u2192</span>
  </a>`;
}

export function renderSearchPage({
  actor, csrfToken, flash = null, query = '', groups = [], total = 0,
}) {
  const heading = query.length >= 2
    ? `${total} result${total === 1 ? '' : 's'} for \u201c${query}\u201d`
    : 'Search the operations console';

  return adminShell({
    title: 'Search',
    subtitle: 'Find a space, customer, reservation, booking request or historical inquiry without hunting through menus.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/search',
    extraStyles: ['/assets/admin-ux.css'],
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Search' }],
    body: html`<div class="stack">
      <form class="card admin-search-page" method="get" action="/admin/search" role="search">
        <div class="card__body stack">
          <label for="admin-search-page-input" class="section-eyebrow">Search all records</label>
          <div class="admin-search-page__row">
            <input id="admin-search-page-input" name="q" type="search" value="${query}"
                   placeholder="Reference, customer, email, space code or venue name"
                   autofocus autocomplete="off" maxlength="120">
            <button class="button button--primary" type="submit">Search</button>
          </div>
          <p class="hint">Searches spaces, customers, reservations, booking requests and historical inquiries. Use <kbd>/</kbd> from any admin page to jump here.</p>
        </div>
      </form>

      ${query.length < 2
    ? html`<div class="empty-state">
        <p class="empty-state__message">Type at least two characters to search.</p>
        <p class="empty-state__hint">For example: a customer surname, a reservation reference, an email address, or a space code.</p>
      </div>`
    : groups.length === 0
      ? html`<div class="empty-state">
          <p class="empty-state__message">No matches for \u201c${query}\u201d.</p>
          <p class="empty-state__hint">Try a shorter surname, an email fragment, or a reference without punctuation.</p>
        </div>`
      : html`<div class="stack">
          <p class="hint">${heading}</p>
          ${groups.map((group) => html`<section class="card search-group" aria-labelledby="search-${group.kind}">
            <header class="card__head">
              <div>
                <p class="section-eyebrow">${group.items.length} match${group.items.length === 1 ? '' : 'es'}</p>
                <h2 class="card__title" id="search-${group.kind}">${group.label}</h2>
              </div>
            </header>
            <div class="card__body search-group__list">
              ${group.items.map((item) => resultCard(item, group.label.replace(/s$/, '')))}
            </div>
          </section>`)}
        </div>`}
    </div>`,
  });
}
