/**
 * Gbox Platform — Shared Toast Notifications (Phase 2 Step 2.3)
 *
 * A single source of truth for "flash message" UX across every admin
 * surface. Before Stage 2.3 each page implemented its own pattern:
 *   - god-admin used ?error=... / ?success=... query strings read by
 *     handlers and rendered into a bespoke banner div
 *   - store-admin used session.flash via express-session middleware
 *   - checkout silently redirected on errors
 *
 * That's three inconsistent patterns, none of which auto-dismiss, none
 * of which stack, all of which flash at the top of the page.
 *
 * Stage 2.3 unifies everything into two layers:
 *
 *   1. SERVER side: `buildFlashCookie()` sets a short-lived cookie with
 *      a URL-safe payload. Layouts render `flashContainerHtml()` in the
 *      body which both:
 *        a. Emits any pending flash from the cookie (then clears it via
 *           a tiny script), and
 *        b. Provides an empty container that the runtime can append
 *           dynamic toasts to.
 *
 *   2. CLIENT side: `toastRuntimeScriptBody()` defines a global
 *      `window.gboxToast(kind, message, opts)` function that any page
 *      script, htmx response, or inline handler can call. Auto-dismisses
 *      after `duration` ms (default 4000), supports close button,
 *      stacks vertically, and pauses the dismiss timer on hover.
 *
 * Design decisions
 * ----------------
 * - Position: top-right (matches Shopify admin, leaves room for the
 *   topbar search and the sidebar).
 * - Stacking: newest on top, older toasts shift down.
 * - Max 5 visible at once — older toasts are culled to prevent runaway.
 * - No dependencies — everything ships as a ~1.5KB inline script.
 *
 * Triết lý: "clone giống hệt Shopify" (same position, same auto-dismiss
 * UX) + "power-ful hơn Shopify nhờ Claude" (works identically for SSR
 * flash messages AND client-side AJAX, a single function call either
 * way).
 */

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface ToastOptions {
  /** Visual tone. Default: 'info'. */
  kind?: ToastKind
  /** Visible text. */
  message: string
  /** Optional smaller title above the message. */
  title?: string
  /** Auto-dismiss after N ms. Default: 4000. Pass 0 to disable. */
  duration?: number
}

export interface FlashCookieOptions {
  /** Secure flag — set true in production. Default: false. */
  secure?: boolean
}

/** Name of the flash cookie read by the layout. */
export const FLASH_COOKIE = 'gbox_flash'

/**
 * Serialize a toast into a cookie payload. We URL-encode the JSON so
 * it survives the cookie transport intact. The client script decodes
 * it and calls `gboxToast(...)` with the same arguments.
 *
 * The cookie is set with `Max-Age=10` so if the user bounces without
 * reading it, it expires fast and doesn't accumulate. Path=/ so it's
 * readable on every route, SameSite=Lax to match the auth/theme
 * cookies.
 */
export function buildFlashCookie(
  toast: ToastOptions,
  opts: FlashCookieOptions = {},
): string {
  const payload = JSON.stringify({
    k: toast.kind ?? 'info',
    m: toast.message,
    t: toast.title ?? '',
    d: toast.duration ?? 4000,
  })
  const encoded = encodeURIComponent(payload)
  const parts = [
    `${FLASH_COOKIE}=${encoded}`,
    'Path=/',
    'Max-Age=10',
    'SameSite=Lax',
    'HttpOnly=false', // must be readable by the runtime script
  ]
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Clear the flash cookie by setting it with Max-Age=0. Called after the
 * client script reads it so a refresh doesn't re-show the same toast.
 * We don't use this server-side — the client does it via `document.cookie
 * = '...=; Max-Age=0'` in the runtime script. Exposed for callers that
 * want to clear explicitly.
 */
export function clearFlashCookie(): string {
  return `${FLASH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

/**
 * Empty container the runtime script appends toasts into. Layouts
 * should place this right before `</body>` so toasts overlay all
 * content.
 */
export function flashContainerHtml(): string {
  return `<div id="gboxToastContainer" class="gbox-toast-container" aria-live="polite" aria-atomic="false"></div>`
}

/**
 * Runtime script body (no surrounding `<script>` tag). Defines:
 *   - window.gboxToast(kind, message, opts?)
 *   - auto-consumes any `gbox_flash` cookie on DOMContentLoaded
 *
 * Designed to be inlined inside an existing `<script>` block in the
 * layout so we don't pay for an extra round-trip.
 *
 * The generated JS is intentionally ES5-ish (no arrow shorthands that
 * break on old browsers, no template literals for DOM construction —
 * we use createElement so user-supplied strings are safely escaped
 * by the DOM API rather than manual string interpolation).
 */
export function toastRuntimeScriptBody(): string {
  return `
    (function(){
      var MAX_VISIBLE = 5;
      var DEFAULT_DURATION = 4000;

      function getContainer() {
        return document.getElementById('gboxToastContainer');
      }

      function iconFor(kind) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 20 20');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        var d = '';
        if (kind === 'success') d = 'M4 10l4 4 8-8';
        else if (kind === 'error') d = 'M6 6l8 8M14 6l-8 8';
        else if (kind === 'warning') d = 'M10 3l8 14H2zM10 8v4M10 15h0';
        else d = 'M10 7v4M10 14h0M10 2a8 8 0 100 16 8 8 0 000-16z';
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', d);
        svg.appendChild(p);
        return svg;
      }

      function showToast(kind, message, opts) {
        opts = opts || {};
        var container = getContainer();
        if (!container) return;

        // Enforce MAX_VISIBLE — cull oldest if we're at the cap.
        while (container.children.length >= MAX_VISIBLE) {
          container.removeChild(container.firstChild);
        }

        var toast = document.createElement('div');
        toast.className = 'gbox-toast gbox-toast-' + (kind || 'info');
        toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

        var iconWrap = document.createElement('div');
        iconWrap.className = 'gbox-toast-icon';
        iconWrap.appendChild(iconFor(kind));
        toast.appendChild(iconWrap);

        var body = document.createElement('div');
        body.className = 'gbox-toast-body';
        if (opts.title) {
          var t = document.createElement('div');
          t.className = 'gbox-toast-title';
          t.textContent = opts.title;
          body.appendChild(t);
        }
        var m = document.createElement('div');
        m.className = 'gbox-toast-message';
        m.textContent = message;
        body.appendChild(m);
        toast.appendChild(body);

        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'gbox-toast-close';
        closeBtn.setAttribute('aria-label', 'Dismiss');
        closeBtn.innerHTML = '&times;';
        toast.appendChild(closeBtn);

        container.appendChild(toast);

        // Trigger enter animation on next frame so CSS transition fires.
        requestAnimationFrame(function(){
          toast.classList.add('gbox-toast-in');
        });

        var duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION;
        var timer = null;

        function dismiss() {
          if (!toast.parentNode) return;
          toast.classList.remove('gbox-toast-in');
          toast.classList.add('gbox-toast-out');
          setTimeout(function(){
            if (toast.parentNode) toast.parentNode.removeChild(toast);
          }, 250);
        }

        function startTimer() {
          if (duration > 0) {
            timer = setTimeout(dismiss, duration);
          }
        }
        function stopTimer() {
          if (timer) { clearTimeout(timer); timer = null; }
        }

        closeBtn.addEventListener('click', function(e){
          e.preventDefault();
          stopTimer();
          dismiss();
        });

        // Pause auto-dismiss on hover / focus-within so users have time
        // to read long messages.
        toast.addEventListener('mouseenter', stopTimer);
        toast.addEventListener('mouseleave', startTimer);
        toast.addEventListener('focusin', stopTimer);
        toast.addEventListener('focusout', startTimer);

        startTimer();
      }

      window.gboxToast = showToast;

      // On load, consume any pending flash cookie and show it.
      function consumeFlash() {
        var match = document.cookie.match(/(?:^|;\\s*)gbox_flash=([^;]+)/);
        if (!match) return;
        try {
          var payload = JSON.parse(decodeURIComponent(match[1]));
          showToast(payload.k, payload.m, { title: payload.t, duration: payload.d });
        } catch (e) { /* ignore malformed */ }
        // Clear the cookie so a refresh doesn't replay it.
        document.cookie = 'gbox_flash=; Path=/; Max-Age=0; SameSite=Lax';
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', consumeFlash);
      } else {
        consumeFlash();
      }
    })();
  `
}

/**
 * CSS for the toast container + toast card. Uses shared --god-* CSS
 * variables so it tints correctly in both dark and light mode.
 */
export function toastCss(): string {
  return `
    .gbox-toast-container {
      position: fixed;
      top: 72px;
      right: 20px;
      z-index: 9000;
      display: flex;
      flex-direction: column-reverse;
      gap: 10px;
      pointer-events: none;
      max-width: calc(100vw - 40px);
    }
    .gbox-toast {
      pointer-events: auto;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      min-width: 280px;
      max-width: 400px;
      padding: 12px 14px;
      border-radius: 8px;
      background: var(--god-surface, #1f2937);
      border: 1px solid var(--god-border, rgba(255,255,255,0.08));
      box-shadow: 0 10px 25px rgba(0,0,0,0.25);
      color: var(--god-text, #f3f4f6);
      font-size: 13px;
      line-height: 1.45;
      transform: translateX(120%);
      opacity: 0;
      transition: transform 0.25s ease, opacity 0.25s ease;
    }
    .gbox-toast-in {
      transform: translateX(0);
      opacity: 1;
    }
    .gbox-toast-out {
      transform: translateX(20%);
      opacity: 0;
    }
    .gbox-toast-icon {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      margin-top: 1px;
    }
    .gbox-toast-icon svg {
      width: 100%;
      height: 100%;
    }
    .gbox-toast-body {
      flex: 1;
      min-width: 0;
    }
    .gbox-toast-title {
      font-weight: 600;
      color: var(--god-text, #f3f4f6);
      margin-bottom: 2px;
    }
    .gbox-toast-message {
      color: var(--god-text-secondary, #cbd5e1);
      word-wrap: break-word;
    }
    .gbox-toast-close {
      flex-shrink: 0;
      background: transparent;
      border: none;
      color: var(--god-text-secondary, #9ca3af);
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      padding: 0 4px;
      font-family: inherit;
    }
    .gbox-toast-close:hover {
      color: var(--god-text, #f3f4f6);
    }
    .gbox-toast-close:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
      border-radius: 2px;
    }

    /* Kind-specific accent borders + icon colors */
    .gbox-toast-success {
      border-left: 3px solid var(--god-success, #22c55e);
    }
    .gbox-toast-success .gbox-toast-icon { color: var(--god-success, #22c55e); }
    .gbox-toast-error {
      border-left: 3px solid var(--god-danger, #ef4444);
    }
    .gbox-toast-error .gbox-toast-icon { color: var(--god-danger, #ef4444); }
    .gbox-toast-warning {
      border-left: 3px solid var(--god-warning, #f59e0b);
    }
    .gbox-toast-warning .gbox-toast-icon { color: var(--god-warning, #f59e0b); }
    .gbox-toast-info {
      border-left: 3px solid var(--god-accent, #3b82f6);
    }
    .gbox-toast-info .gbox-toast-icon { color: var(--god-accent, #3b82f6); }

    @media (prefers-reduced-motion: reduce) {
      .gbox-toast {
        transition: none;
        transform: none;
      }
    }
  `
}
