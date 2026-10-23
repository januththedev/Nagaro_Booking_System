/* Focus the global admin search from anywhere with `/` or Ctrl/Cmd+K. */
'use strict';

(function () {
  var input = document.querySelector('[data-admin-search]');
  if (!input) return;

  function isTyping(target) {
    if (!target) return false;
    var tag = String(target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }

  document.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.altKey) return;
    var shortcut = (event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k';
    var slash = event.key === '/' && !event.ctrlKey && !event.metaKey;
    if (!shortcut && !slash) return;
    if (isTyping(event.target) && !shortcut) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
})();
