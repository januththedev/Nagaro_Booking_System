/**
 * Server-rendered notification centre. The bell exists on every admin page;
 * this page is the full, accessible list with the reminder group pinned first.
 */
import { dateTimeLabel, html, tag } from '../../lib/html.js';
import { adminShell } from '../layout.js';

function notificationCard(item) {
  const reminder = item.priority === 'HIGH';
  return html`<a class="notification-item ${reminder ? 'notification-item--reminder' : ''}"
                href="${item.actionUrl}"
                data-notification-id="${item.id}"
                data-notification-read="${item.isRead ? '1' : '0'}">
    <span class="notification-item__mark" aria-hidden="true">${reminder ? '!' : '•'}</span>
    <span class="notification-item__copy">
      <span class="notification-item__top">
        <strong class="notification-item__title">${item.title}</strong>
        ${reminder ? tag('Prep reminder', 'warn') : ''}
        ${item.isRead ? '' : tag('Unread', 'info')}
      </span>
      <span class="notification-item__body">${item.body}</span>
      <span class="notification-item__meta">${dateTimeLabel(item.createdAt)}</span>
    </span>
  </a>`;
}

export function renderNotificationsPage({
  actor, csrfToken, flash = null, items = [], unreadCount = 0,
  pushConfigured = false, subscriptions = 0,
}) {
  const reminders = items.filter((item) => item.priority === 'HIGH' && !item.isRead);
  const rest = items.filter((item) => !(item.priority === 'HIGH' && !item.isRead));

  return adminShell({
    title: 'Notifications',
    subtitle: 'Live booking activity, cancellations and room-preparation reminders. Reminders stay at the top until you read them.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/notifications',
    extraStyles: ['/assets/admin-notifications.css'],
    extraScripts: ['/assets/admin-notifications.js'],
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Notifications' }],
    body: html`<div class="stack notification-page" data-notification-page data-csrf="${csrfToken}">
      <section class="card notification-page__lead">
        <div class="card__body notification-page__lead-body">
          <div>
            <p class="section-eyebrow">Alert centre</p>
            <h2 class="card__title">${unreadCount > 0 ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}` : 'You are all caught up'}</h2>
            <p class="card__description">
              ${pushConfigured
    ? `${subscriptions} desktop-alert subscription${subscriptions === 1 ? '' : 's'} active on this account. Reminders are delivered even when the admin tab is closed, subject to the browser and operating system.`
    : 'Desktop alerts are not configured on this server yet. In-app notifications still work; ask a Super Admin to add the VAPID keys to enable push.'}
            </p>
          </div>
          <div class="notification-page__actions">
            <button class="button button--ghost button--small" type="button" data-notification-enable>
              ${subscriptions > 0 ? 'Refresh desktop alerts' : 'Enable desktop alerts'}
            </button>
            <button class="button button--ghost button--small" type="button" data-notification-test ${pushConfigured ? '' : 'disabled'}>
              Send test alert
            </button>
            <button class="button button--ghost button--small" type="button" data-notification-read-all>
              Mark all read
            </button>
          </div>
        </div>
      </section>

      <p class="hint notification-page__status" data-notification-status role="status" aria-live="polite"></p>

      ${reminders.length > 0 ? html`<section class="notification-group" aria-labelledby="notification-reminders-title">
        <header class="notification-group__head">
          <div>
            <p class="section-eyebrow">Do this next</p>
            <h2 class="card__title" id="notification-reminders-title">Room preparation</h2>
          </div>
          <span class="tag tag--warn">${reminders.length} due</span>
        </header>
        <div class="notification-list" data-notification-reminders-list>
          ${reminders.map(notificationCard)}
        </div>
      </section>` : ''}

      <section class="notification-group" aria-labelledby="notification-all-title">
        <header class="notification-group__head">
          <div>
            <p class="section-eyebrow">Activity</p>
            <h2 class="card__title" id="notification-all-title">All notifications</h2>
          </div>
        </header>
        <div class="notification-list" data-notification-page-list>
          ${items.length === 0
    ? html`<div class="empty-state"><p class="empty-state__message">No notifications yet.</p><p class="empty-state__hint">New bookings, cancellations and reminders will appear here.</p></div>`
    : (reminders.length > 0 ? rest : items).length === 0
      ? html`<p class="hint">Everything above is a reminder. New activity will appear here.</p>`
      : (reminders.length > 0 ? rest : items).map(notificationCard)}
        </div>
      </section>

      <p class="hint">
        Reminder emails are sent when SMTP is configured. Web Push works best with the admin site installed as a PWA;
        iPhone and iPad require adding TRACE Ops to the Home Screen before alerts can be enabled.
      </p>
    </div>`,
  });
}
