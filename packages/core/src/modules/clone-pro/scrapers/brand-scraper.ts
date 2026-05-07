/**
 * Clone Pro — Favicon & Logo Scraper
 *
 * Extracts brand identity elements from a website:
 * - Logo image URL (from header)
 * - Favicon URL
 * - Apple touch icon
 * - Site name (from og:site_name)
 */

import * as cheerio from 'cheerio'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapedBrand {
  readonly logo_url: string | null
  readonly logo_alt: string | null
  readonly favicon_url: string | null
  readonly apple_touch_icon: string | null
  readonly site_name: string | null
}

// ---------------------------------------------------------------------------
// URL helper
// ---------------------------------------------------------------------------

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    if (!href || href.startsWith('data:')) return null
    return new URL(href, baseUrl).href
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Logo detection
// ---------------------------------------------------------------------------

const LOGO_SELECTORS = [
  // Specific logo classes
  'header .logo img',
  'header .site-logo img',
  '.header-logo img',
  '.logo img',
  '.site-logo img',
  '.brand-logo img',
  '.navbar-brand img',
  '#logo img',
  '[class*="logo"] img',
  // Shopify patterns
  '.header__logo img',
  '.site-header__logo img',
  '#SiteNavLogo img',
  // WooCommerce / WordPress
  '.custom-logo',
  '.site-branding img',
  '.wp-custom-logo img',
  // Link-based: first image inside header link to homepage
  'header a[href="/"] img',
  'header a[href="./"] img',
  '.header a[href="/"] img',
  // SVG logos
  'header .logo svg',
  'header svg.logo',
  '[class*="logo"] svg',
]

function findLogo(
  $: cheerio.CheerioAPI,
  baseUrl: string,
): { url: string | null; alt: string | null } {
  for (const selector of LOGO_SELECTORS) {
    const $el = $(selector).first()
    if ($el.length === 0) continue

    // Handle <img> tag
    if ($el.is('img')) {
      const src =
        $el.attr('src') ||
        $el.attr('data-src') ||
        $el.attr('srcset')?.split(',')[0]?.trim().split(' ')[0]
      if (src) {
        const resolved = resolveUrl(src, baseUrl)
        if (resolved) {
          return {
            url: resolved,
            alt: $el.attr('alt')?.trim() || null,
          }
        }
      }
    }

    // Handle <svg> (inline SVG logo — we can't save it as URL, skip)
    if ($el.is('svg')) {
      continue
    }
  }

  return { url: null, alt: null }
}

// ---------------------------------------------------------------------------
// Favicon detection
// ---------------------------------------------------------------------------

function findFavicon($: cheerio.CheerioAPI, baseUrl: string): string | null {
  // Order: ICO > PNG > SVG > Apple touch
  const selectors = [
    'link[rel="icon"][type="image/x-icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="icon"][type="image/png"]',
    'link[rel="icon"][type="image/svg+xml"]',
    'link[rel="icon"]',
  ]

  for (const sel of selectors) {
    const href = $(sel).first().attr('href')
    if (href) {
      const resolved = resolveUrl(href, baseUrl)
      if (resolved) return resolved
    }
  }

  // Default: /favicon.ico
  try {
    return new URL('/favicon.ico', baseUrl).href
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Apple touch icon detection
// ---------------------------------------------------------------------------

function findAppleTouchIcon($: cheerio.CheerioAPI, baseUrl: string): string | null {
  const selectors = [
    'link[rel="apple-touch-icon-precomposed"]',
    'link[rel="apple-touch-icon"]',
  ]

  for (const sel of selectors) {
    const href = $(sel).first().attr('href')
    if (href) {
      const resolved = resolveUrl(href, baseUrl)
      if (resolved) return resolved
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Site name detection
// ---------------------------------------------------------------------------

function findSiteName($: cheerio.CheerioAPI): string | null {
  // 1. og:site_name
  const ogName = $('meta[property="og:site_name"]').attr('content')?.trim()
  if (ogName) return ogName

  // 2. application-name
  const appName = $('meta[name="application-name"]').attr('content')?.trim()
  if (appName) return appName

  // 3. From <title> — take the last part after separator
  const titleText = $('title').text().trim()
  if (titleText) {
    const parts = titleText.split(/[|–—-]/)
    if (parts.length > 1) {
      const siteName = parts[parts.length - 1].trim()
      if (siteName && siteName.length < 50) return siteName
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract brand identity from page HTML.
 *
 * @param html - Full page HTML string
 * @param baseUrl - Website base URL (for resolving URLs)
 * @returns ScrapedBrand with logo, favicon, apple touch icon, and site name
 */
export function scrapeBrand(html: string, baseUrl: string): ScrapedBrand {
  const $ = cheerio.load(html)

  const logo = findLogo($, baseUrl)

  return {
    logo_url: logo.url,
    logo_alt: logo.alt,
    favicon_url: findFavicon($, baseUrl),
    apple_touch_icon: findAppleTouchIcon($, baseUrl),
    site_name: findSiteName($),
  }
}
