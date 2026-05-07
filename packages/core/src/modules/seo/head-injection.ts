/**
 * Gbox Platform — Head Injection (Phase 8 PR3)
 *
 * Turns a shop's SEO settings into the HTML fragments the storefront
 * layout needs to inject:
 *
 *   • `buildHeadTags(settings)`    — `<meta>` + `<script>` tags for the
 *                                     document head (GA4, GTM head, site
 *                                     verification, robots noindex).
 *   • `buildBodyOpenTags(settings)`— `<noscript>` GTM iframe that must
 *                                     sit immediately after `<body>`.
 *
 * All output is HTML-safe: merchant-supplied values are passed through
 * `escapeHtml()` before being interpolated, and the GA/GTM IDs are
 * restricted to a strict regex so an attacker who somehow writes into
 * seo_settings can't inject JavaScript via the "ID" field.
 *
 * Iron rule 5: no Gbox-admin paths, feature names, or internal strings
 * appear in the output. The only identifiers rendered are the merchant's
 * own Google IDs + verification string.
 */

import type { SeoSettings } from './seo-settings.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Validate a GA4 measurement ID. Google's format is
 * `G-` followed by 10 alphanumeric characters. Stripping everything
 * else means a pasted URL or a stray `<script>` tag never makes it
 * into the injected snippet.
 */
function isValidGaId(id: string): boolean {
  return /^G-[A-Z0-9]{10}$/.test(id)
}

/**
 * Validate a GTM container ID. Google's format is
 * `GTM-` followed by 6–10 alphanumeric characters.
 */
function isValidGtmId(id: string): boolean {
  return /^GTM-[A-Z0-9]{6,10}$/.test(id)
}

/**
 * Google site-verification values are opaque tokens from Search
 * Console. We don't know the exact character set, so we take a
 * conservative alphanumeric + `-_` filter and cap the length at 200.
 * A value that fails this filter is dropped rather than escaped —
 * Google would reject a meta tag with HTML entities anyway.
 */
function isValidVerification(token: string): boolean {
  return /^[A-Za-z0-9_-]{10,200}$/.test(token)
}

// ---------------------------------------------------------------------------
// buildHeadTags
// ---------------------------------------------------------------------------

/**
 * Returns the HTML to splice into the `<head>`. Output is a single
 * newline-separated string; callers can append it verbatim before
 * `</head>`. Each tag is on its own line for readability in the
 * served HTML.
 */
export function buildHeadTags(settings: SeoSettings): string {
  const lines: string[] = []

  // Robots noindex — must be first so crawlers that stop parsing
  // the head early still see it.
  if (settings.robots_noindex) {
    lines.push('<meta name="robots" content="noindex, nofollow">')
  }

  // Google Site Verification.
  if (settings.google_site_verification && isValidVerification(settings.google_site_verification)) {
    lines.push(
      `<meta name="google-site-verification" content="${escapeHtml(
        settings.google_site_verification,
      )}">`,
    )
  }

  // Google Analytics 4.
  if (settings.google_analytics_id && isValidGaId(settings.google_analytics_id)) {
    const id = settings.google_analytics_id // validated, safe for template literal
    lines.push(
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>`,
    )
    lines.push(
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');</script>`,
    )
  }

  // Google Tag Manager (head snippet).
  if (settings.google_tag_manager_id && isValidGtmId(settings.google_tag_manager_id)) {
    const id = settings.google_tag_manager_id
    lines.push(
      `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');</script>`,
    )
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// buildBodyOpenTags
// ---------------------------------------------------------------------------

/**
 * Returns the HTML to splice immediately after `<body>`. This is
 * exclusively the GTM noscript fallback iframe; merchants without
 * GTM get an empty string.
 */
export function buildBodyOpenTags(settings: SeoSettings): string {
  if (!settings.google_tag_manager_id) return ''
  if (!isValidGtmId(settings.google_tag_manager_id)) return ''
  const id = settings.google_tag_manager_id
  return `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${id}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`
}

/**
 * Small convenience bundler for themes that want to pull both fragments
 * through a single function.
 */
export function buildSeoHeadInjection(settings: SeoSettings): {
  head: string
  bodyOpen: string
} {
  return {
    head: buildHeadTags(settings),
    bodyOpen: buildBodyOpenTags(settings),
  }
}
