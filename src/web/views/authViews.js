/**
 * Sign-in page. Rendered outside the admin shell by design: an unauthenticated
 * visitor must never see admin chrome.
 */
import { html } from '../lib/html.js';

export function renderLoginPage({
  csrfToken, next = '/admin', email = '', flash = null, emailConfigured = false,
}) {
  void csrfToken;
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
      <span class="brand__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 20V9M10 20V4M16 20v-7M21 20H3" />
        </svg>
      </span>
      <span class="brand__text">
        <span class="brand__name">Nagaro</span>
        <span class="brand__sub">Trace Expert City</span>
      </span>
    </a>
    <div class="site-header__actions">
      <a class="button button--ghost button--small" href="/">← Back to public site</a>
    </div>
  </div>
</header>
<main id="main" class="site-main">
  <section class="container">
    <div class="auth-layout">
      <aside class="auth-showcase">
        <div class="auth-showcase__brand">
          <span class="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 20V9M10 20V4M16 20v-7M21 20H3" />
            </svg>
          </span>
          <span class="auth-showcase__eyebrow">Nagaro Operations · Colombo</span>
        </div>
        <h1 class="auth-showcase__title">Operations &amp; Inventory Console — Trace Expert City</h1>
        <p class="auth-showcase__lead">Manage published venue schedules, convert visitor inquiries into confirmed reservations, and coordinate room turnarounds across Trace Expert City.</p>
        <dl class="auth-highlights">
          <div class="auth-highlights__item">
            <dt>Database-enforced conflict prevention</dt>
            <dd>Exclusive rooms, auditorium blocks and turnaround buffers are protected against double-booking inside SQLite transactions.</dd>
          </div>
          <div class="auth-highlights__item">
            <dt>Live unit occupancy tracking</dt>
            <dd>Real-time desk pool allocation and maintenance blocking across Sri Lanka Standard Time (UTC+5:30) operating windows.</dd>
          </div>
          <div class="auth-highlights__item">
            <dt>Manual inquiry verification</dt>
            <dd>Review visitor booking requests, verify customer records and issue confirmed reservations with full audit traceability.</dd>
          </div>
        </dl>
      </aside>

      <div class="auth-panel">
        <div class="card card--auth">
          <div class="card__head">
            <div>
              <p class="section-eyebrow">Authorized Personnel</p>
              <h2 class="card__title">Staff sign in</h2>
              <p class="card__description">Enter your Nagaro staff credentials to access the administration console.</p>
            </div>
          </div>
          <div class="card__body stack">
            ${flash && flash.message
              ? html`<div class="alert ${flash.kind === 'error' ? 'alert--error' : 'alert--success'}" role="status" data-flash>
                  <p>${flash.message}</p>
                </div>`
              : ''}
            <form method="post" action="/admin/login" class="form-grid" autocomplete="on">
              <input type="hidden" name="next" value="${next}">
              <div class="form-field form-field--full">
                <label for="email">Email address</label>
                <input id="email" name="email" type="email" required autocomplete="username"
                       value="${email}" autofocus aria-describedby="email-hint" placeholder="staff@nagaro.lk">
                <p class="hint" id="email-hint">Use the address your administrator registered.</p>
              </div>
              <div class="form-field form-field--full">
                <label for="password">Password</label>
                <input id="password" name="password" type="password" required autocomplete="current-password">
              </div>
              <div class="form-actions form-field--full">
                <button class="button button--primary button--block" type="submit">Sign in to console</button>
              </div>
            </form>
            ${emailConfigured ? '' : html`<p class="hint">Email delivery is not configured in this environment. Booking inquiries are still saved and visible to staff in the inquiry queue.</p>`}
          </div>
        </div>
        <p class="hint auth-panel__footnote">Visitors do not need an account. <a href="/spaces">Browse spaces</a> or <a href="/booking-request">request a booking</a>.</p>
      </div>
    </div>
  </section>
</main>
<footer class="site-footer">
  <div class="site-footer__inner">
    <p>Nagaro space booking · Trace Expert City, Colombo</p>
  </div>
</footer>
</body>
</html>`;
}
