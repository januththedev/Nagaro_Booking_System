/* TRACE Ops service worker: Web Push delivery and notification clicks. */
'use strict';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'TRACE Ops', body: event.data ? event.data.text() : '' };
  }
  const title = String(data.title || 'TRACE Ops');
  const options = {
    body: String(data.body || 'Open the admin console for details.'),
    icon: '/assets/placeholder-space.svg',
    badge: '/assets/placeholder-space.svg',
    tag: data.tag ? String(data.tag) : undefined,
    data: { url: String(data.url || data.actionUrl || '/admin/notifications') },
    requireInteraction: data.requireInteraction === true,
    renotify: data.priority === 'HIGH',
    silent: false,
    timestamp: Number(data.timestamp) || Date.now(),
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      client.postMessage({ type: 'TRACE_NOTIFICATION', payload: data });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    String(event.notification.data?.url || '/admin/notifications'),
    self.location.origin,
  ).href;
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
