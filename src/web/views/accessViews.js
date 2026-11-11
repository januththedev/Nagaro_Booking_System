/**
 * Customer room-access page shell.
 *
 * The server renders the frame, the loading skeleton and the no-JavaScript
 * notice; `/assets/access.js` then renders every state from the
 * server-authoritative `/api/access/state` response. The access token is never
 * written into the markup, the title or any attribute.
 */
import { html } from '../lib/html.js';

const LOCALES = ['en', 'si', 'ta'];

/** Same rule as the public site: explicit `trace_locale` cookie first, then Accept-Language. */
export function resolveAccessLocale(ctx) {
  const cookie = String(ctx.cookies?.trace_locale ?? '').toLowerCase();
  if (LOCALES.includes(cookie)) return cookie;
  const header = String(ctx.req?.headers?.['accept-language'] ?? '').toLowerCase();
  for (const part of header.split(',')) {
    const tag = part.split(';')[0].trim().slice(0, 2);
    if (LOCALES.includes(tag)) return tag;
  }
  return 'en';
}

function head(title) {
  return html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#080808">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<meta name="format-detection" content="telephone=no">
<title>${title}</title>
<link rel="stylesheet" href="/assets/access.css">
<link rel="icon" href="/assets/trace-media/brand/trace-logo-original.jpg" type="image/jpeg">`;
}

/** BookingAccessSkeleton: shown until the first state arrives. */
function skeleton() {
  return html`<div class="ax-skeleton" aria-hidden="true">
    <div class="ax-skeleton__row"><span class="ax-bone ax-bone--title"></span><span class="ax-bone ax-bone--badge"></span></div>
    <span class="ax-bone ax-bone--line"></span>
    <span class="ax-bone ax-bone--panel"></span>
    <span class="ax-bone ax-bone--button"></span>
    <span class="ax-bone ax-bone--button"></span>
  </div>`;
}

export function renderAccessPage({ locale = 'en', spaceName = '', reference = '' } = {}) {
  return html`<!doctype html>
<html lang="${locale}">
<head>
${head('Room Access')}
</head>
<body class="ax-body">
<main class="ax-shell">
  <section class="ax-card" id="access-root" data-space="${spaceName}" data-reference="${reference}" aria-live="polite" aria-busy="true">
    <header class="ax-header">
      <div class="ax-header__text">
        <h1 class="ax-title">Room Access</h1>
        <p class="ax-subtitle">${spaceName}${reference ? html` · <span class="ax-nowrap">${reference}</span>` : ''}</p>
      </div>
    </header>
    ${skeleton()}
    <noscript>
      <div class="ax-panel ax-panel--center">
        <h2 class="ax-panel__title">JavaScript is needed</h2>
        <p class="ax-panel__text">Door controls need JavaScript. Please enable it in your browser, or ask our staff for help.</p>
      </div>
    </noscript>
  </section>
</main>
<script type="module" src="/assets/access.js"></script>
</body>
</html>`;
}

/** AccessErrorView for an unknown, revoked or retired link. Says nothing about which. */
export function renderAccessUnavailablePage({
  locale = 'en',
  heading = 'This access link is not available',
  message = 'The link may have been replaced or is no longer in use. Check your latest SMS or email, or ask our staff for help.',
} = {}) {
  return html`<!doctype html>
<html lang="${locale}">
<head>
${head('Room Access')}
</head>
<body class="ax-body">
<main class="ax-shell">
  <section class="ax-card">
    <header class="ax-header">
      <div class="ax-header__text">
        <h1 class="ax-title">Room Access</h1>
      </div>
    </header>
    <div class="ax-panel ax-panel--center">
      <svg class="ax-panel__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1"/><path d="M4 4l16 16"/></svg>
      <h2 class="ax-panel__title">${heading}</h2>
      <p class="ax-panel__text">${message}</p>
    </div>
  </section>
</main>
</body>
</html>`;
}
