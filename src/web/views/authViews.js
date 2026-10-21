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
  <title>Operations sign in · TRACE Spaces</title>
  <link rel="stylesheet" href="/assets/styles.css">
  <link rel="icon" href="/assets/trace-media/brand/trace-logo-original.jpg" type="image/jpeg">
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
      <span class="brand__word"><span class="brand__name">TRACE Spaces</span>
        <span class="brand__sub">Colombo</span></span>
    </a>
    <div class="site-header__actions">
      <a class="button button--ghost button--small" href="/">← Back to public site</a>
    </div>
  </div>
</header>
<main id="main" class="site-main">
  <section class="container" data-reveal>
    <div class="auth-layout">
      <aside class="auth-showcase">
        <div class="auth-showcase__brand">
          <span class="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 20V9M10 20V4M16 20v-7M21 20H3" />
            </svg>
          </span>
          <span class="auth-showcase__eyebrow">TRACE Operations · Colombo</span>
        </div>
        <h1 class="auth-showcase__title">One calm view of every space, guest and booking.</h1>
        <p class="auth-showcase__lead">Run the TRACE Spaces catalogue, supervise direct guest checkouts and coordinate room turnarounds from one operational cockpit.</p>
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
            <dt>Public requests, visible instantly</dt>
            <dd>Online booking requests arrive with their source clearly marked; approval, holds and payments remain visible to the operations team.</dd>
          </div>
        </dl>
      </aside>

      <div class="auth-panel">
        <div class="card card--auth">
          <div class="card__head">
            <div>
              <p class="section-eyebrow">Authorized Personnel</p>
              <h2 class="card__title">Staff sign in</h2>
              <p class="card__description">Enter your staff credentials to open the TRACE operations console.</p>
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
                       value="${email}" autofocus aria-describedby="email-hint" placeholder="operations@trace.lk">
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
            ${emailConfigured ? '' : html`<p class="hint">Email delivery is not configured in this environment. Direct bookings still confirm on screen, and concierge inquiries remain visible in the operations queue.</p>`}
          </div>
        </div>
        <p class="hint auth-panel__footnote">Visitors do not need an account. <a href="/spaces">Browse spaces</a>, <a href="/book">send a booking request</a> or <a href="/booking-request">ask the concierge</a>.</p>
      </div>
    </div>
  </section>
</main>
<footer class="site-footer">
  <div class="site-footer__inner footer__grid">
    <div class="footer__brand">
      <p><strong>TRACE Spaces</strong> · Trace Expert City, Colombo</p>
      <p class="site-footer__note">Online requests are reviewed by the operations team; approved times are held while any configured registration fee is completed.</p>
    </div>
    <nav class="footer__nav" aria-label="Public site">
      <h2 class="site-footer__heading">Public site</h2>
      <ul class="site-footer__links">
        <li><a href="/">Home</a></li>
        <li><a href="/spaces">All spaces</a></li>
        <li><a href="/book">Book a space</a></li>
        <li><a href="/booking-request">Ask the concierge</a></li>
      </ul>
    </nav>
    <div class="footer__ops">
      <h2 class="site-footer__heading">Operations</h2>
      <p class="site-footer__note">Sri Lanka Standard Time (UTC+05:30).</p>
    </div>
  </div>
  <div class="site-footer__inner footer__base">
    <span>TRACE Spaces — Colombo</span>
  </div>
</footer>
</body>
</html>`;
}
