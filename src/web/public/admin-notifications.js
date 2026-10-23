/* TRACE Ops notification bell, full notification page and Web Push opt-in.
   Progressive enhancement only: the server-rendered list remains usable with
   JavaScript disabled. */
'use strict';

(function () {
  var root = document.querySelector('[data-notification-bell]');
  var page = document.querySelector('[data-notification-page]');
  if (!root && !page) return;

  var csrf = (root && root.getAttribute('data-csrf'))
    || (page && page.getAttribute('data-csrf'))
    || (document.querySelector('meta[name="csrf-token"]') || {}).content
    || '';
  var state = {
    items: [],
    unreadCount: 0,
    push: { configured: false, publicKey: null, subscriptions: 0 },
    loading: false,
    pollTimer: null
  };

  function api(path, options) {
    var init = options || {};
    var headers = Object.assign({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-csrf-token': csrf
    }, init.headers || {});
    return fetch(path, Object.assign({}, init, { headers: headers, credentials: 'same-origin' }))
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok) {
            var message = body && body.error && body.error.message
              ? body.error.message
              : 'The request could not be completed.';
            var error = new Error(message);
            error.status = response.status;
            throw error;
          }
          return body;
        });
      });
  }

  function setStatus(message, tone) {
    var pageNode = document.querySelector('[data-notification-status]');
    var bellNode = document.querySelector('[data-notification-bell-status]');
    var node = pageNode || bellNode;
    if (!node) return;
    node.textContent = message || '';
    node.className = pageNode
      ? 'hint notification-page__status' + (tone ? ' notification-page__status--' + tone : '')
      : 'hint admin-bell__status' + (tone ? ' admin-bell__status--' + tone : '');
  }

  function relativeTime(epochMs) {
    var diff = Math.max(0, Date.now() - Number(epochMs || 0));
    var minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
    var days = Math.floor(hours / 24);
    if (days < 7) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Colombo',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(Number(epochMs)));
  }

  function notificationNode(item) {
    var reminder = item.priority === 'HIGH';
    var link = document.createElement('a');
    link.className = 'notification-item'
      + (reminder ? ' notification-item--reminder' : '')
      + (item.isRead ? ' is-read' : ' is-unread');
    link.href = item.actionUrl || '/admin/notifications';
    link.setAttribute('data-notification-id', String(item.id));
    link.setAttribute('data-notification-read', item.isRead ? '1' : '0');

    var mark = document.createElement('span');
    mark.className = 'notification-item__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = reminder ? '!' : '\u2022';

    var copy = document.createElement('span');
    copy.className = 'notification-item__copy';

    var top = document.createElement('span');
    top.className = 'notification-item__top';
    var title = document.createElement('strong');
    title.className = 'notification-item__title';
    title.textContent = item.title || 'Notification';
    top.appendChild(title);
    if (reminder) {
      var reminderTag = document.createElement('span');
      reminderTag.className = 'tag tag--warn';
      reminderTag.textContent = 'Prep reminder';
      top.appendChild(reminderTag);
    }
    if (!item.isRead) {
      var unreadTag = document.createElement('span');
      unreadTag.className = 'tag tag--info';
      unreadTag.textContent = 'Unread';
      top.appendChild(unreadTag);
    }

    var body = document.createElement('span');
    body.className = 'notification-item__body';
    body.textContent = item.body || '';

    var meta = document.createElement('span');
    meta.className = 'notification-item__meta';
    meta.textContent = relativeTime(item.createdAt);

    copy.appendChild(top);
    copy.appendChild(body);
    copy.appendChild(meta);
    link.appendChild(mark);
    link.appendChild(copy);

    link.addEventListener('click', function (event) {
      if (item.isRead) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      api('/api/admin/notifications/' + encodeURIComponent(item.id) + '/read', { method: 'POST' })
        .then(function () { window.location.href = link.href; })
        .catch(function () { window.location.href = link.href; });
    });
    return link;
  }

  function renderList(target, items) {
    if (!target) return;
    target.textContent = '';
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No notifications here yet.';
      target.appendChild(empty);
      return;
    }
    items.forEach(function (item) { target.appendChild(notificationNode(item)); });
  }

  function prepDismissed(item) {
    try { return window.sessionStorage.getItem('trace-prep-dismissed:' + item.id) === '1'; }
    catch { return false; }
  }

  function renderPrepStrip() {
    var strip = document.querySelector('[data-notification-prep]');
    if (!strip) return;
    var now = Date.now();
    var reminder = state.items.find(function (item) {
      return item.priority === 'HIGH'
        && !item.isRead
        && (!item.startsAt || Number(item.startsAt) > now)
        && !prepDismissed(item);
    });
    if (!reminder) {
      strip.hidden = true;
      return;
    }
    var title = strip.querySelector('[data-notification-prep-title]');
    var body = strip.querySelector('[data-notification-prep-body]');
    var open = strip.querySelector('[data-notification-prep-open]');
    var dismiss = strip.querySelector('[data-notification-prep-dismiss]');
    if (title) {
      var minutes = reminder.startsAt
        ? Math.max(0, Math.ceil((Number(reminder.startsAt) - Date.now()) / 60000))
        : null;
      title.textContent = minutes === null
        ? (reminder.title || 'Room preparation reminder')
        : 'Room prep: starts in ' + minutes + ' min';
    }
    if (body) body.textContent = reminder.body || '';
    if (open) open.href = reminder.actionUrl || '/admin/notifications';
    if (dismiss) dismiss.onclick = function () {
      try { window.sessionStorage.setItem('trace-prep-dismissed:' + reminder.id, '1'); } catch {}
      strip.hidden = true;
    };
    strip.hidden = false;
  }

  function render() {
    var badge = document.querySelector('[data-notification-badge]');
    if (badge) {
      var count = Number(state.unreadCount || 0);
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = count === 0;
    }
    if (root) {
      var bellList = root.querySelector('[data-notification-list]');
      renderList(bellList, state.items);
      var panel = root.querySelector('[data-notification-panel]');
      var enable = root.querySelector('[data-notification-enable]');
      if (enable) {
        enable.hidden = !pushSupported();
        enable.textContent = state.push.subscriptions > 0 ? 'Desktop alerts on' : 'Enable desktop alerts';
        enable.disabled = !pushSupported();
      }
      if (panel && !panel.hidden && state.loading === false) panel.setAttribute('aria-busy', 'false');
    }
    if (page) {
      var pageList = page.querySelector('[data-notification-page-list]');
      var reminderList = page.querySelector('[data-notification-reminders-list]');
      var unreadReminders = state.items.filter(function (item) {
        return item.priority === 'HIGH' && !item.isRead;
      });
      if (reminderList) {
        renderList(reminderList, unreadReminders);
        var reminderGroup = reminderList.closest('.notification-group');
        if (reminderGroup) reminderGroup.hidden = unreadReminders.length === 0;
        renderList(pageList, state.items.filter(function (item) {
          return !(item.priority === 'HIGH' && !item.isRead);
        }));
      } else {
        renderList(pageList, state.items);
      }
      var pageEnable = page.querySelector('[data-notification-enable]');
      if (pageEnable) {
        pageEnable.disabled = !pushSupported();
        pageEnable.textContent = state.push.subscriptions > 0 ? 'Refresh desktop alerts' : 'Enable desktop alerts';
      }
      var test = page.querySelector('[data-notification-test]');
      if (test) test.disabled = !state.push.configured;
    }
    renderPrepStrip();
  }

  function load() {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    var limit = page ? 50 : 20;
    return api('/api/admin/notifications?limit=' + limit)
      .then(function (body) {
        state.items = Array.isArray(body.items) ? body.items : [];
        state.unreadCount = Number(body.unreadCount || 0);
        state.push = Object.assign({ configured: false, publicKey: null, subscriptions: 0 }, body.push || {});
        render();
      })
      .catch(function (error) {
        if (error && error.status === 401) return;
        if (!page && root) {
          var list = root.querySelector('[data-notification-list]');
          if (list) {
            list.textContent = '';
            var message = document.createElement('p');
            message.className = 'hint';
            message.textContent = 'Notifications are temporarily unavailable.';
            list.appendChild(message);
          }
        }
        if (page) setStatus('Could not load notifications. Try again in a moment.', 'error');
      })
      .finally(function () { state.loading = false; });
  }

  function markAllRead() {
    if (!state.unreadCount) return;
    api('/api/admin/notifications/read-all', { method: 'POST' })
      .then(function () { return load(); })
      .then(function () { if (page) setStatus('All notifications marked read.', 'ok'); })
      .catch(function (error) { setStatus(error.message || 'Could not mark notifications read.', 'error'); });
  }

  function pushSupported() {
    return Boolean(window.isSecureContext
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window);
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = window.atob(base64);
    var output = new Uint8Array(raw.length);
    for (var index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
    return output;
  }

  function registerPush() {
    if (!pushSupported()) {
      setStatus('This browser cannot use desktop alerts. Use a current Chrome, Edge, Firefox or Safari (installed PWA on iPhone/iPad).', 'error');
      return;
    }
    setStatus('Requesting notification permission…', '');
    Notification.requestPermission()
      .then(function (permission) {
        if (permission !== 'granted') {
          throw new Error('Notification permission was not granted. You can enable it in the browser site settings.');
        }
        return navigator.serviceWorker.register('/sw.js', { scope: '/admin/' });
      })
      .then(function (registration) {
        return (state.push.publicKey
          ? Promise.resolve(state.push.publicKey)
          : api('/api/admin/notifications/vapid-public-key').then(function (body) {
            if (!body.configured || !body.publicKey) throw new Error('Desktop alerts are not configured on this server.');
            state.push.publicKey = body.publicKey;
            return body.publicKey;
          }))
          .then(function (publicKey) {
            return registration.pushManager.getSubscription().then(function (existing) {
              if (existing) return existing;
              return registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
              });
            });
          });
      })
      .then(function (subscription) {
        return api('/api/admin/notifications/subscribe', {
          method: 'POST',
          body: JSON.stringify({
            subscription: subscription.toJSON(),
            userAgent: navigator.userAgent
          })
        });
      })
      .then(function (body) {
        state.push.subscriptions = Number(body.subscriptions || 0);
        render();
        setStatus('Desktop alerts are enabled for this browser. Reminders will arrive even when the tab is closed, subject to the operating system.', 'ok');
      })
      .catch(function (error) {
        setStatus(error.message || 'Desktop alerts could not be enabled.', 'error');
      });
  }

  function sendTest() {
    setStatus('Sending a test alert…', '');
    api('/api/admin/notifications/test', { method: 'POST' })
      .then(function (body) {
        setStatus(body.sent > 0
          ? 'Test alert sent. Check your notification tray.'
          : 'The test could not reach a device. Re-enable desktop alerts first.', body.sent > 0 ? 'ok' : 'error');
      })
      .catch(function (error) { setStatus(error.message || 'The test alert failed.', 'error'); });
  }

  function togglePanel(open) {
    if (!root) return;
    var button = root.querySelector('[data-notification-toggle]');
    var panel = root.querySelector('[data-notification-panel]');
    if (!button || !panel) return;
    var next = typeof open === 'boolean' ? open : panel.hidden;
    panel.hidden = !next;
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      panel.setAttribute('aria-busy', 'true');
      load();
    }
  }

  if (root) {
    var toggle = root.querySelector('[data-notification-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function (event) {
        event.stopPropagation();
        togglePanel();
      });
    }
    var readAll = root.querySelector('[data-notification-read-all]');
    if (readAll) readAll.addEventListener('click', markAllRead);
    var enable = root.querySelector('[data-notification-enable]');
    if (enable) enable.addEventListener('click', registerPush);
    document.addEventListener('click', function (event) {
      if (!root.contains(event.target)) togglePanel(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') togglePanel(false);
    });
  }

  if (page) {
    var pageReadAll = page.querySelector('[data-notification-read-all]');
    if (pageReadAll) pageReadAll.addEventListener('click', markAllRead);
    var pageEnable = page.querySelector('[data-notification-enable]');
    if (pageEnable) pageEnable.addEventListener('click', registerPush);
    var test = page.querySelector('[data-notification-test]');
    if (test) test.addEventListener('click', sendTest);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'TRACE_NOTIFICATION') load();
    });
  }

  load();
  state.pollTimer = window.setInterval(function () {
    if (document.visibilityState === 'visible' && !document.hidden) load();
  }, 60000);
  // Refresh as soon as an administrator returns to the console rather than
  // waiting for the next polling boundary.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !document.hidden) load();
  });
  window.addEventListener('focus', load);
  window.addEventListener('trace:notifications:refresh', load);
})();
