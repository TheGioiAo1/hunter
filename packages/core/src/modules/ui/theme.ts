/**
 * Gbox Platform — Shared UI Theme Helper (Phase 2 Step 2.1)
 *
 * Single source of truth for the `dark` / `light` theme toggle used by
 * god-admin, store-admin (seller-layout), accounts portal, and any
 * future admin UI.
 *
 * Why this file exists
 * --------------------
 * Before Phase 2, each layout either:
 *   - hard-coded `data-theme="dark"` (god-layout), or
 *   - took a `theme` prop that callers had to manually pass from a cookie
 *     (seller-layout).
 *
 * That meant the theme toggle button on store-admin would briefly flash
 * the wrong color on every navigation, because the HTML arrived with the
 * wrong `data-theme` attribute before JS could correct it.
 *
 * Phase 2 fixes this by:
 *   1. Reading the `gbox_theme` cookie server-side so HTML is rendered
 *      with the right `data-theme` attribute on first paint.
 *   2. Shipping a tiny `themeInitScript()` that runs BEFORE the
 *      stylesheet in `<head>`, so even if the cookie lookup fails for
 *      some reason (XHR, iframe, etc.) the client JS still sets the
 *      attribute before the first CSS rule fires.
 *   3. Providing a shared `gboxToggleTheme()` runtime function so both
 *      layouts use the same cookie name + max-age + SameSite flags.
 *
 * Triết lý: "clone giống hệt Shopify" (cookie-persisted theme, no flash)
 * + "power-ful hơn Shopify nhờ Claude" (one shared module instead of
 * three copies).
 */

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export type Theme = 'dark' | 'light'

/** Cookie name persisted on the client. Keep in sync with `themeInitScript`. */
export const THEME_COOKIE = 'gbox_theme'

/** Default theme when no cookie is present. Dark matches the current god-admin baseline. */
export const THEME_DEFAULT: Theme = 'dark'

/**
 * 1 year — theme is a UI preference, persist it long enough that the
 * user only needs to click the toggle once across all devices.
 */
export const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

// ---------------------------------------------------------------------------
// Cookie reading
// ---------------------------------------------------------------------------

/**
 * Parse a raw `Cookie:` header string and extract the `gbox_theme` value.
 *
 * Defensive against:
 *   - null/undefined header (no cookie sent)
 *   - multiple cookies in the header
 *   - unknown values (returns default instead of the malformed string)
 *   - extra whitespace around `; `
 */
export function readThemeFromCookieHeader(
  cookieHeader: string | null | undefined,
): Theme {
  if (!cookieHeader) return THEME_DEFAULT
  // Match `gbox_theme=dark` or `gbox_theme=light` at start-of-string or
  // after `; `. Using a single regex avoids splitting + trimming every
  // cookie in the header for a read that happens on every request.
  const match = cookieHeader.match(/(?:^|;\s*)gbox_theme=(dark|light)(?:;|$)/)
  if (match && (match[1] === 'dark' || match[1] === 'light')) {
    return match[1]
  }
  return THEME_DEFAULT
}

/**
 * Convenience helper for Express-style requests where `req.headers.cookie`
 * is the raw cookie string. Accepts any shape that matches the minimal
 * interface so tests and non-Express callers can use it too.
 */
export function readThemeFromRequest(
  req: { headers?: { cookie?: string | null } } | null | undefined,
): Theme {
  if (!req || !req.headers) return THEME_DEFAULT
  return readThemeFromCookieHeader(req.headers.cookie)
}

/**
 * Build a `Set-Cookie` header value for persisting a theme choice.
 * Used by tests and by any server route that wants to set the cookie
 * directly (most callers rely on the client-side toggle instead).
 */
export function buildThemeCookie(
  theme: Theme,
  options: { secure?: boolean } = {},
): string {
  const parts = [
    `${THEME_COOKIE}=${theme}`,
    'Path=/',
    `Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

// ---------------------------------------------------------------------------
// Client-side script snippets
// ---------------------------------------------------------------------------

/**
 * Tiny IIFE that sets `<html data-theme="…">` from the cookie BEFORE the
 * stylesheet is parsed. Must be placed in `<head>` BEFORE the `<style>`
 * block. This prevents a flash of the wrong theme on first paint.
 *
 * The snippet is ~220 bytes gzipped and has no dependencies. Inlined on
 * every page — worth the bytes to avoid FOUC.
 */
export function themeInitScript(): string {
  // NOTE: This runs on the client in the shadow of `<script>`, so we
  // can't use template literals — escape `\s` as `\\s` inside the JS
  // string so the regex compiles correctly.
  return (
    '<script>(function(){try{' +
    "var m=document.cookie.match(/(?:^|;\\s*)gbox_theme=(dark|light)/);" +
    "var t=m?m[1]:'dark';" +
    "document.documentElement.setAttribute('data-theme',t);" +
    '}catch(e){}})();</script>'
  )
}

/**
 * Runtime JS that defines `window.gboxToggleTheme()`. Wire a button
 * `onclick="gboxToggleTheme()"` and the layout will cycle dark ↔ light,
 * persist the choice in a 1-year cookie, and update `data-theme` live
 * so all CSS variables re-cascade without a page reload.
 *
 * Returns the JS body only (no `<script>` tags) so callers can inject
 * it into an existing `<script>` block alongside other page JS.
 */
export function themeToggleScriptBody(): string {
  return (
    'window.gboxToggleTheme=function(){' +
    "var h=document.documentElement;" +
    "var c=h.getAttribute('data-theme')||'dark';" +
    "var n=c==='dark'?'light':'dark';" +
    "h.setAttribute('data-theme',n);" +
    "document.cookie='" +
    THEME_COOKIE +
    "='+n+';path=/;max-age=" +
    String(THEME_COOKIE_MAX_AGE_SECONDS) +
    ";SameSite=Lax';" +
    "var btn=document.getElementById('themeToggleBtn');" +
    "if(btn)btn.setAttribute('data-current',n);" +
    '};'
  )
}

// ---------------------------------------------------------------------------
// Toggle button HTML
// ---------------------------------------------------------------------------

export interface ThemeToggleButtonOptions {
  /** CSS class to apply to the button. Default: `theme-toggle`. */
  className?: string
  /** Current theme, used for the `data-current` attribute. */
  theme?: Theme
  /** Override the aria-label (default: "Toggle dark/light theme"). */
  ariaLabel?: string
}

/**
 * Render the theme toggle button. The same button works in both themes —
 * CSS toggles which icon (sun/moon) is visible based on `data-theme` on
 * the `<html>` element. Principle: show the icon for the destination
 * state (dark mode shows sun because clicking goes to light, and vice
 * versa) — this matches the Shopify admin behavior.
 */
export function themeToggleButton(
  options: ThemeToggleButtonOptions = {},
): string {
  const className = options.className ?? 'theme-toggle'
  const theme = options.theme ?? THEME_DEFAULT
  const ariaLabel = options.ariaLabel ?? 'Toggle dark/light theme'

  // Two icons, one visible per theme (controlled by CSS — see
  // `themeToggleButtonCss()` for the CSS rules).
  const sunIcon =
    '<svg class="theme-toggle-icon theme-toggle-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>' +
    '</svg>'

  const moonIcon =
    '<svg class="theme-toggle-icon theme-toggle-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' +
    '</svg>'

  return (
    `<button id="themeToggleBtn" type="button" class="${className}" ` +
    `onclick="gboxToggleTheme()" ` +
    `aria-label="${ariaLabel}" ` +
    `title="${ariaLabel}" ` +
    `data-current="${theme}">` +
    sunIcon +
    moonIcon +
    '</button>'
  )
}

/**
 * CSS rules that the toggle button needs to switch between sun/moon
 * icons based on the current theme. Inline into the layout stylesheet.
 */
export function themeToggleButtonCss(): string {
  return `
/* Theme toggle button (shared across all admin layouts) */
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: currentColor;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.theme-toggle:hover { background: rgba(148, 163, 184, 0.12); }
.theme-toggle:focus-visible {
  outline: 2px solid var(--gbox-accent, #6366f1);
  outline-offset: 2px;
}
.theme-toggle-icon { display: none; }
/* Show sun when in dark mode (click to go light) */
[data-theme="dark"] .theme-toggle .theme-toggle-sun { display: block; }
/* Show moon when in light mode (click to go dark) */
[data-theme="light"] .theme-toggle .theme-toggle-moon { display: block; }
/* Fallback: if data-theme isn't set yet, show sun (default dark) */
html:not([data-theme]) .theme-toggle .theme-toggle-sun { display: block; }
`
}
