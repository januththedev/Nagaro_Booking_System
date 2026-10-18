/**
 * Sign-in page. Rendered outside the admin shell by design: an unauthenticated
 * visitor must never see admin chrome.
 */
import { html } from '../lib/html.js';

export function renderLoginPage({
  csrfToken, next = '/admin', email = '', flash = null, emailConfigured = false,
}) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Staff sign in · Nagaro Space Booking</title>
  <link rel="stylesheet" href="/assets/styles.css">
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
</head>
<body class="page page--public page--auth">
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
    <div class="site-header__actions">
      <a class="button button--ghost button--small" href="/">Back to public site</a>
    </div>
  </div>
</header>
<main id="main" class="site-main">
  <section class="container container--narrow">
    <div class="card card--auth">
      <div class="card__head">
        <h1 class="card__title">Staff sign in</h1>
        <p class="card__description">Nagaro space booking administration.</p>
      </div>
      <div class="card__body">
        ${flash && flash.message
          ? html`<div class="alert ${flash.kind === 'error' ? 'alert--error' : 'alert--success'}" role="status">
              <p>${flash.message}</p>
            </div>`
          : ''}
        <form method="post" action="/admin/login" class="form-grid" autocomplete="on">
          <input type="hidden" name="next" value="${next}">
          <div class="form-field">
            <label for="email">Email address</label>
            <input id="email" name="email" type="email" required autocomplete="username"
                   value="${email}" autofocus aria-describedby="email-hint">
            <p class="hint" id="email-hint">Use the address your administrator registered.</p>
          </div>
          <div class="form-field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" required autocomplete="current-password">
          </div>
          <div class="form-actions">
            <button class="button button--primary" type="submit">Sign in</button>
          </div>
        </form>
        ${emailConfigured ? '' : html`<p class="hint">Email delivery is not configured in this environment. Booking inquiries are still saved and visible to staff.</p>`}
      </div>
    </div>
    <p class="hint">Visitors do not need an account. <a href="/spaces">Browse spaces</a> or <a href="/booking-request">request a booking</a>.</p>
  </section>
</main>
<footer class="site-footer">
  <div class="site-footer__inner">
    <p>Nagaro space booking · Trace Expert City, Addis Ababa</p>
  </div>
</footer>
</body>
</html>`;
}
