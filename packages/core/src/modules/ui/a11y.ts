/**
 * Gbox Platform — Accessibility Helpers (Phase 2 Step 2.8)
 *
 * Ships the shared a11y primitives every admin page needs:
 *
 *   - `skipToMainLink(targetId)` — WCAG 2.4.1 "Bypass Blocks" skip
 *     link. Hidden until focused; jumps over the sidebar/topbar
 *     straight to the main content.
 *   - `visuallyHidden(text)` — wraps text so screen readers can read
 *     it but sighted users can't see it (the canonical `.sr-only`
 *     pattern with clip-path, not `display:none`).
 *   - `srOnlyCss()` — stylesheet for the two above.
 *   - `focusRingCss()` — consistent `:focus-visible` outline across
 *     EVERY interactive element: buttons, links, inputs, [tabindex].
 *   - `liveRegionHtml(id, level?)` — an empty `aria-live` container
 *     that arbitrary JS can update with `.textContent = msg` to
 *     announce toast/error messages to assistive tech.
 *   - `reducedMotionCss()` — respects `prefers-reduced-motion` by
 *     disabling non-essential animations and transitions.
 *   - `ariaCurrent(isActive)` — returns `' aria-current="page"'` or
 *     empty string, for use on active nav links.
 *
 * These are pure functions returning HTML or CSS strings; no runtime
 * JS, no framework dependency. Drop them into any SSR layout.
 *
 * Triết lý: "clone giống hệt Shopify" (Shopify admin passes WCAG 2.1
 * AA, so do we) + "power-ful hơn Shopify nhờ Claude" (one shared
 * module drives both god-admin and seller-admin, so an a11y bug fix
 * ships to both surfaces at once).
 *
 * References
 * ----------
 * - WCAG 2.1 SC 2.4.1 Bypass Blocks (Level A)
 * - WCAG 2.1 SC 2.4.7 Focus Visible (Level AA)
 * - WCAG 2.1 SC 1.4.13 Content on Hover or Focus (Level AA)
 * - WCAG 2.1 SC 2.3.3 Animation from Interactions (Level AAA)
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Skip-to-main link (WCAG 2.4.1)
// ---------------------------------------------------------------------------

/**
 * Render the canonical "Skip to main content" link. Place this as
 * the very FIRST focusable element inside `<body>`. When a keyboard
 * user presses Tab once after page load, this link appears; pressing
 * Enter jumps focus to the element whose id matches `targetId`.
 *
 * The matching target element MUST have:
 *   - `id="{targetId}"`
 *   - `tabindex="-1"` so it can receive programmatic focus
 *   - `role="main"` or be a <main> element
 */
export function skipToMainLink(
  targetId = 'main-content',
  label = 'Skip to main content',
): string {
  return `<a href="#${esc(targetId)}" class="gbox-skip-link">${esc(label)}</a>`
}

// ---------------------------------------------------------------------------
// Visually hidden
// ---------------------------------------------------------------------------

/**
 * Wrap text so it's announced by screen readers but invisible on
 * screen. Use this for icon-only buttons that need an accessible
 * name, or for extra context like "(opens in new tab)".
 */
export function visuallyHidden(text: string): string {
  return `<span class="gbox-sr-only">${esc(text)}</span>`
}

// ---------------------------------------------------------------------------
// aria-live region
// ---------------------------------------------------------------------------

/**
 * Render an empty aria-live region. Assistive tech will announce any
 * text content that appears in this container. Typical use: toast
 * notifications and form error summaries.
 *
 * `polite` waits until the user finishes what they're doing.
 * `assertive` interrupts — reserve for urgent errors.
 */
export function liveRegionHtml(
  id: string,
  level: 'polite' | 'assertive' = 'polite',
): string {
  return `<div id="${esc(id)}" class="gbox-sr-only" aria-live="${level}" aria-atomic="true"></div>`
}

// ---------------------------------------------------------------------------
// aria-current helper
// ---------------------------------------------------------------------------

/**
 * Returns ` aria-current="page"` when the link points at the current
 * page, or an empty string otherwise. Use by concatenating directly
 * into nav anchor tags so the assistive-tech announcement is
 * "dashboard, current page".
 */
export function ariaCurrent(isActive: boolean): string {
  return isActive ? ' aria-current="page"' : ''
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * Canonical sr-only helper (WebAIM / Tailwind pattern). `display:
 * none` would HIDE from screen readers too — we need the element in
 * the accessibility tree but not on the visual viewport.
 */
export function srOnlyCss(): string {
  return `
    .gbox-sr-only {
      position: absolute !important;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  `
}

/** Skip-link shows only on keyboard focus. */
export function skipLinkCss(): string {
  return `
    .gbox-skip-link {
      position: absolute;
      top: -40px;
      left: 12px;
      z-index: 1000;
      padding: 10px 16px;
      background: var(--god-accent, #3b82f6);
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      border-radius: 0 0 6px 6px;
      text-decoration: none;
      transition: top 0.15s;
    }
    .gbox-skip-link:focus,
    .gbox-skip-link:focus-visible {
      top: 0;
      outline: 2px solid #fff;
      outline-offset: 2px;
    }
  `
}

/**
 * Consistent focus ring across every interactive element. Note we
 * use `:focus-visible` — that means mouse clicks on a button DON'T
 * show the ring (which frustrates designers), only keyboard Tab
 * focus does. This is the modern accessible default.
 */
export function focusRingCss(): string {
  return `
    a:focus-visible,
    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible,
    [tabindex]:focus-visible,
    summary:focus-visible {
      outline: 2px solid var(--god-accent, #3b82f6);
      outline-offset: 2px;
      border-radius: 3px;
    }
    /* Remove the default Firefox dotted outline so it doesn't
       double up with our ring. */
    a::-moz-focus-inner,
    button::-moz-focus-inner {
      border: 0;
    }
    /* Main content container gets focus on skip-link click but we
       don't want a visible ring — the scroll position shift itself
       signals the jump. */
    [role="main"]:focus,
    main:focus {
      outline: none;
    }
  `
}

/**
 * Honor `prefers-reduced-motion: reduce` — disables all transitions,
 * animations, and scroll-behavior:smooth. Users who set this OS
 * preference get a calmer interface. WCAG SC 2.3.3.
 */
export function reducedMotionCss(): string {
  return `
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  `
}

/**
 * Bundle all a11y CSS into one call so layouts only add one line.
 */
export function a11yCss(): string {
  return srOnlyCss() + skipLinkCss() + focusRingCss() + reducedMotionCss()
}
