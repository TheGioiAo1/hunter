/**
 * Seller Support Widget — the floating "G" button.
 *
 * Drops a Messenger-style chat launcher at bottom-right on every
 * store-admin page. Spec pins the palette:
 *
 *   - Button: 56px circle, Messenger-blue #0084FF, white "G"
 *   - Badge:  red pill with unread count (hidden when 0)
 *   - Polling interval: 3000ms while the widget is visible; paused
 *     when the browser tab is hidden to save battery on laptops.
 *
 * Behaviour:
 *
 *   - Click → deep-link to /admin/store/:slug/support (inbox page).
 *   - While on an inbox/detail page, badge still drives the red dot
 *     so agents replying in another ticket trigger a nudge.
 *
 * Iron Rule 5:
 *
 *   - The button text is literally "G". No mention of "support",
 *     "god-admin", "feature flag", or any internal path.
 *   - The fetch URL (`/admin/store/{slug}/support/api/unread`) is a
 *     normal seller-scoped route. It returns `{ ok, total, perTicket }`
 *     and nothing else.
 *
 * Usage (in seller-layout.ts):
 *
 *   import { supportWidgetHtml } from '../components/support-widget.js'
 *   ...
 *   ${supportWidgetHtml({ base })}
 *
 * The function takes only `base` (the /admin/store/:slug prefix). We
 * intentionally don't pre-render an unreadCount here — the widget
 * fetches it immediately on mount so server-side timing doesn't
 * affect the first tick.
 */

export interface SupportWidgetOptions {
  /** `/admin/store/:slug` */
  base: string
  /**
   * Override polling interval in ms. Default 3000ms. Tests pass a
   * shorter interval; production never overrides.
   */
  pollIntervalMs?: number
}

export function supportWidgetHtml(opts: SupportWidgetOptions): string {
  const base = opts.base
  const pollMs = opts.pollIntervalMs ?? 3000
  return `
<!-- Seller Support Widget ("G" launcher) -->
<style>
  .gbox-support-launcher {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 9500;
  }
  .gbox-support-launcher a.gbox-support-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: #0084FF;
    color: #ffffff;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 24px;
    font-weight: 700;
    text-decoration: none;
    box-shadow: 0 8px 20px rgba(0, 132, 255, 0.35);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    position: relative;
  }
  .gbox-support-launcher a.gbox-support-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 12px 24px rgba(0, 132, 255, 0.45);
  }
  .gbox-support-launcher a.gbox-support-btn:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
  }
  .gbox-support-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 10px;
    background: #ef4444;
    color: #ffffff;
    font-size: 11px;
    font-weight: 700;
    font-family: inherit;
    display: none;
    align-items: center;
    justify-content: center;
    line-height: 1;
    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
  }
  .gbox-support-badge[data-visible="1"] {
    display: inline-flex;
  }
  @media (max-width: 640px) {
    .gbox-support-launcher { right: 16px; bottom: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .gbox-support-launcher a.gbox-support-btn { transition: none; }
  }
</style>
<div class="gbox-support-launcher" id="gboxSupportLauncher">
  <a class="gbox-support-btn"
     href="${escAttr(base)}/support"
     id="gboxSupportBtn"
     aria-label="Support — Gbox"
     title="Support">
    G
    <span class="gbox-support-badge" id="gboxSupportBadge" aria-live="polite" aria-label="Unread messages"></span>
  </a>
</div>
<script>
(function () {
  var badge = document.getElementById('gboxSupportBadge');
  if (!badge) return;
  var base = ${JSON.stringify(base)};
  var pollMs = ${Number(pollMs)};
  var timer = null;
  var inFlight = false;

  function render(count) {
    if (!count || count <= 0) {
      badge.removeAttribute('data-visible');
      badge.textContent = '';
    } else {
      badge.setAttribute('data-visible', '1');
      badge.textContent = count >= 100 ? '99+' : String(count);
    }
  }

  function tick() {
    if (inFlight) return;
    if (document.hidden) return;
    inFlight = true;
    fetch(base + '/support/api/unread', {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
    })
      .then(function (r) { return r.ok ? r.json() : { ok: false }; })
      .then(function (data) {
        if (data && data.ok) render(Number(data.total || 0));
      })
      .catch(function () { /* ignore transient errors */ })
      .then(function () { inFlight = false; });
  }

  function start() {
    if (timer !== null) return;
    tick();
    timer = window.setInterval(tick, pollMs);
  }
  function stop() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  // Fire once immediately on load so the badge is correct before the
  // first 3s tick. After that the interval takes over.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
</script>
`
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Exposed for unit tests.
export const __testables = { escAttr }
