/*
 * Keeps the door console current without a manual reload. Every ten seconds
 * the page is fetched again and each [data-live-region] is replaced - unless
 * someone is typing or choosing inside that region, in which case it waits.
 */
const INTERVAL_MS = 10000;

function busy(region) {
  const active = document.activeElement;
  return Boolean(active && region.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
}

async function refresh() {
  if (document.hidden) return;
  let response;
  try {
    response = await fetch(location.pathname, { headers: { Accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store' });
  } catch { return; }
  if (!response.ok || response.redirected) return;
  const next = new DOMParser().parseFromString(await response.text(), 'text/html');
  for (const region of document.querySelectorAll('[data-live-region]')) {
    const fresh = next.querySelector(`[data-live-region="${region.dataset.liveRegion}"]`);
    if (!fresh || busy(region) || fresh.innerHTML === region.innerHTML) continue;
    region.innerHTML = fresh.innerHTML;
  }
}

if (document.querySelector('[data-access-live]')) {
  setInterval(refresh, INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
