/**
 * Security Module — HTTP Security Headers
 *
 * Uses helmet.js to set comprehensive security headers.
 * Configuration tuned for server-rendered HTML + API hybrid servers.
 */

import helmet from 'helmet'

// ---------------------------------------------------------------------------
// Environment gate
//
// HSTS and CSP's `upgrade-insecure-requests` directive MUST NOT be sent in
// development. Two reasons:
//
//   1. Dev servers are typically reached over plain http:// (e.g. the office
//      LAN box at http://192.168.1.13). Sending HSTS teaches the browser
//      "this host is HTTPS-only for 1 year", and because HSTS is sticky the
//      user is then locked out even after the header is removed — Chrome
//      will refuse to connect until they manually clear the HSTS cache via
//      chrome://net-internals/#hsts.
//
//   2. HSTS is also spec-invalid for IP-address hosts (RFC 6797 §2.3).
//      Browsers that strictly conform will silently drop it, but Chrome
//      currently honors it for IPs — hence the lockout above.
//
// So: in non-production we disable HSTS entirely AND strip
// `upgrade-insecure-requests` from the CSP directives. In production the
// apps sit behind HTTPS (TLS-terminating nginx or Cloudflare), so both are
// safe and desirable.
// ---------------------------------------------------------------------------
const isProduction = process.env.NODE_ENV === 'production'

/** HSTS config — disabled in dev to prevent the HTTPS-lockout described above. */
const hstsConfig = isProduction
  ? { maxAge: 31536000, includeSubDomains: true, preload: true }
  : (false as const)

/**
 * Security headers middleware for API servers (Platform API).
 * More restrictive — no inline scripts needed.
 */
export const securityHeaders = helmet({
  // Content Security Policy
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],  // inline styles for server-rendered HTML
      imgSrc: ["'self'", 'data:', 'https:'],     // allow external images (product images, CDN)
      fontSrc: ["'self'", 'https:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  // Prevent clickjacking
  frameguard: { action: 'deny' },
  // Prevent MIME-type sniffing
  noSniff: undefined,  // X-Content-Type-Options: nosniff (default)
  // HSTS — enforce HTTPS (1 year). Disabled in dev (see hstsConfig above).
  hsts: hstsConfig,
  // Hide X-Powered-By
  hidePoweredBy: undefined,
  // Referrer policy
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // XSS filter (legacy header, but doesn't hurt)
  xssFilter: undefined,
  // DNS prefetch control
  dnsPrefetchControl: { allow: false },
  // Don't cache sensitive responses
  // (individual routes can override with Cache-Control)
})

/**
 * Content-Security-Policy directives for the public storefront
 * (apps/storefront). Split out from the middleware so tests can
 * assert on the directive list directly, and so other modules
 * (e.g. the future theme-scoped CSP generator) can extend it.
 *
 * Key differences vs `adminSecurityHeaders`:
 *
 *   - `script-src` allows `https:` because merchants embed third-
 *     party analytics / chat widgets / marketing pixels that live
 *     on unknown CDN hosts. Locking this down requires per-shop
 *     configuration which ships in Phase 3E; in 3A we allow any
 *     https origin but still block plain `http:`.
 *   - `img-src` / `font-src` allow `https:` and `data:` (and `blob:`
 *     for img) because product CDNs, Google Fonts, and inline SVG
 *     placeholders are all first-class citizens on a storefront.
 *   - `frame-ancestors` is `'self'` (not `'none'`) so the merchant
 *     can embed their own live storefront inside the admin preview
 *     iframe. Third-party embedding is still forbidden.
 *   - `form-action` permits `https:` so the checkout handoff can
 *     POST to the checkout subdomain.
 *   - `upgrade-insecure-requests` forces http → https for any
 *     embedded asset a merchant pasted in by mistake.
 *
 * Phase 3A ships this as a single permissive baseline. Later phases
 * layer a per-shop CSP generator on top that narrows `script-src`
 * and `connect-src` to the allow-listed analytics/chat domains that
 * the merchant actually enabled.
 */
export const storefrontCspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'unsafe-inline'", 'https:'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  fontSrc: ["'self'", 'data:', 'https:'],
  connectSrc: ["'self'", 'https:'],
  mediaSrc: ["'self'", 'https:'],
  frameSrc: ["'self'", 'https:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'", 'https:'],
  frameAncestors: ["'self'"],
  // Only emit `upgrade-insecure-requests` in production — see comment at top
  // of this file. In dev this directive combined with HSTS would force the
  // browser to upgrade http://192.168.1.13 to https:// and hang.
  ...(isProduction ? { upgradeInsecureRequests: [] as string[] } : {}),
} as const

/**
 * Public storefront security headers. Applied to every request
 * that flows through `apps/storefront`.
 */
export const storefrontSecurityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: storefrontCspDirectives as unknown as Record<string, string[]>,
  },
  // frameguard handled via CSP frame-ancestors; leave helmet's
  // default X-Frame-Options header in place as a SAMEORIGIN fallback
  // for older browsers.
  frameguard: { action: 'sameorigin' },
  // HSTS disabled in dev — see comment at top of file.
  hsts: hstsConfig,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // X-Content-Type-Options: nosniff is helmet's default; be explicit
  // here so a future helmet refactor can't silently drop it.
  noSniff: undefined,
})

/**
 * Build the `form-action` directive for the admin CSP.
 *
 * Why this exists:
 *   Phase 0.4 locked `form-action` to `'self'`, which worked when every
 *   merchant form posted back to the same host it was rendered on. But
 *   the accounts portal submits `/accounts/create-store` to
 *   `accounts.<platform>` and then the server 302s the browser off to
 *   `admin.<platform>/admin/store/<slug>`. Chrome (CSP Level 3) checks
 *   `form-action` against **every redirect hop**, not just the initial
 *   POST target — so a 'self'-only allowlist silently kills that
 *   cross-subdomain handoff. The POST fires, the server replies 302,
 *   and then Chrome aborts the navigation. The user sees the form
 *   "freeze" with no error anywhere in the UI. Observed live on
 *   accounts.thaibeotit.com → admin.thaibeotit.com on 2026-04-11.
 *
 * Strategy:
 *   1. Always include `'self'` so same-host form posts keep working
 *      (login, reset password, account settings).
 *   2. Always include the scheme+host of `STORE_ADMIN_BASE_URL` when
 *      it's set, because every accounts→store-admin handoff needs it.
 *      We only allow the scheme://host (not the path) because CSP
 *      source expressions are origin-scoped.
 *   3. Allow ops to append extra origins via `CSP_FORM_ACTION_ALLOWLIST`
 *      (comma-separated) for future subdomains (checkout, god-admin,
 *      api, etc.) without another code change + redeploy.
 *
 * Any entry that fails to parse is dropped silently — we'd rather ship
 * a partial allowlist than crash boot on a typo in .env.
 */
export function buildAdminFormActionAllowlist(): string[] {
  const allowlist = new Set<string>(["'self'"])

  const storeAdminBase = (process.env.STORE_ADMIN_BASE_URL ?? '').trim()
  if (storeAdminBase) {
    try {
      const parsed = new URL(storeAdminBase)
      allowlist.add(`${parsed.protocol}//${parsed.host}`)
    } catch {
      // Ignore malformed URL — falls back to 'self' only.
    }
  }

  const extra = (process.env.CSP_FORM_ACTION_ALLOWLIST ?? '').trim()
  if (extra) {
    for (const raw of extra.split(',')) {
      const origin = raw.trim()
      if (!origin) continue
      try {
        const parsed = new URL(origin)
        allowlist.add(`${parsed.protocol}//${parsed.host}`)
      } catch {
        // Ignore malformed entry.
      }
    }
  }

  return Array.from(allowlist)
}

/**
 * Security headers for admin panel servers (God Admin, Store Admin).
 * Slightly relaxed — allows inline scripts for server-rendered onclick handlers.
 *
 * GOTCHA (fixed April 2026, ported from master): helmet's default CSP sets
 * `script-src-attr 'none'` which blocks `onclick=""`, `onsubmit=""` and every
 * other inline event attribute, EVEN IF `script-src` allows 'unsafe-inline'.
 * `script-src` only covers `<script>` blocks + `src=` URLs; `script-src-attr`
 * is a separate directive that specifically covers inline event handler
 * attributes.
 *
 * Both admin apps (store-admin, god-admin) emit server-rendered HTML with
 * dozens of `onclick="toggleMenu(...)"` / `onclick="openModal(...)"` handlers
 * — dropdowns, bulk-action bars, modals. Without `scriptSrcAttr` explicitly
 * allow-listed, every one of those buttons silently does nothing when
 * clicked (Chrome blocks the handler, no network request is sent, no console
 * error if the user isn't looking at DevTools — to the user it looks like
 * "the button is broken"). Migrating all handlers to addEventListener is
 * the long-term fix, but for now we match `scriptSrcAttr` to `scriptSrc`.
 */
// Allowlist các CDN dùng bởi admin editors. Mỗi entry tương ứng 1 feature
// concrete — không thêm bừa để CSP còn ý nghĩa.
//   - cdn.ckeditor.com         → CKEditor 5 super-build (page editor, blog editor)
//   - cdn.cloudflare.com / cdnjs → CodeMirror (theme editor /online-store/themes/.../editor)
//   - cdn.jsdelivr.net         → Quill / Tippy / fallback CDN cho lib khác
const ADMIN_CDN_ALLOW = [
  'https://cdn.ckeditor.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
]

export const adminSecurityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", ...ADMIN_CDN_ALLOW],   // <script> blocks in server-rendered HTML + admin editor CDNs
      scriptSrcAttr: ["'unsafe-inline'"],         // onclick="..." etc — MUST be set or helmet defaults to 'none' (master fix ported from 4a2ed50)
      styleSrc: ["'self'", "'unsafe-inline'", ...ADMIN_CDN_ALLOW],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'", 'http://localhost:*', 'http://192.168.1.13:*', ...ADMIN_CDN_ALLOW],  // allow API calls + CDN sourcemap fetch
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      // form-action must allow the store-admin host so the accounts
      // portal can POST /accounts/create-store and let the server 302
      // the browser to admin.<platform>/admin/store/<slug>. Chrome
      // (CSP Level 3) checks every redirect hop against this list,
      // so a 'self'-only allowlist silently kills the handoff.
      formAction: buildAdminFormActionAllowlist(),
      frameAncestors: ["'none'"],
      // Only emit `upgrade-insecure-requests` in production. On a dev box
      // reached via plain http://192.168.1.13 this directive combined with
      // HSTS would lock the browser out (see comment at top of file).
      ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  frameguard: { action: 'deny' },
  // HSTS disabled in dev — see comment at top of file.
  hsts: hstsConfig,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
})
