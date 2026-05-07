/**
 * Clone Pro — Homepage Section Cloner
 *
 * Extracts the actual HTML sections from a source homepage and converts
 * them into Liquid-compatible templates. This preserves the original
 * CSS class names, layout structure, and content — giving us pixel-perfect
 * fidelity when combined with the full CSS clone.
 *
 * For Shopify sites: sections are identified by shopify-section wrappers.
 * For generic sites: uses <section>, <header>, <footer> landmarks.
 */

import * as cheerio from 'cheerio'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClonedSection {
  /** Unique identifier for this section (e.g., 'header', 'hero', 'featured-collection') */
  readonly id: string
  /** The section's HTML content (may contain Liquid tags if converted) */
  readonly html: string
  /** Original Shopify section type if detected */
  readonly shopifySectionType?: string
  /** Order/position on the page (0-based) */
  readonly position: number
}

export interface HomepageCloneResult {
  /** The <head> content (meta tags, preloads, etc.) — NOT including CSS links */
  readonly headContent: string
  /** Extracted sections in order */
  readonly sections: readonly ClonedSection[]
  /** The generated index.liquid that assembles all sections */
  readonly indexTemplate: string
  /** The layout.liquid template */
  readonly layoutTemplate: string
  /** Raw header HTML (for sections/header.liquid) */
  readonly headerHtml: string
  /** Raw footer HTML (for sections/footer.liquid) */
  readonly footerHtml: string
  /** Whether source was detected as Shopify */
  readonly isShopify: boolean
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Clone the homepage structure into Liquid-compatible sections.
 *
 * @param html - Full homepage HTML
 * @param baseUrl - Source site base URL
 * @returns Sections, templates, and layout for theme generation
 */
export function cloneHomepage(html: string, baseUrl: string): HomepageCloneResult {
  const $ = cheerio.load(html)
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const isShopify = html.includes('shopify-section') || html.includes('cdn.shopify.com')

  // ── Extract <head> content ──────────────────────────────────────
  const headContent = extractHeadContent($)

  // ── Extract header ──────────────────────────────────────────────
  const headerHtml = extractHeader($, normalizedBase)

  // ── Extract footer ──────────────────────────────────────────────
  const footerHtml = extractFooter($, normalizedBase)

  // ── Extract body sections ───────────────────────────────────────
  let sections: ClonedSection[]

  if (isShopify) {
    sections = extractShopifySections($, normalizedBase)
  } else {
    sections = extractGenericSections($, normalizedBase)
  }

  // ── Generate index.liquid ───────────────────────────────────────
  const indexTemplate = generateIndexTemplate(sections)

  // ── Generate layout.liquid ──────────────────────────────────────
  const layoutTemplate = generateLayoutTemplate(headContent)

  return {
    headContent,
    sections,
    indexTemplate,
    layoutTemplate,
    headerHtml,
    footerHtml,
    isShopify,
  }
}

// ---------------------------------------------------------------------------
// Header Extraction
// ---------------------------------------------------------------------------

function extractHeader($: cheerio.CheerioAPI, baseUrl: string): string {
  // Try Shopify section header first
  let headerEl = $('[id^="shopify-section-header"]')
  if (headerEl.length === 0) headerEl = $('header').first()
  if (headerEl.length === 0) headerEl = $('[role="banner"]').first()
  if (headerEl.length === 0) return ''

  let html = headerEl.html() || ''
  html = rewriteAssetUrls(html, baseUrl)
  html = cleanupHtml(html)
  return html
}

// ---------------------------------------------------------------------------
// Footer Extraction
// ---------------------------------------------------------------------------

function extractFooter($: cheerio.CheerioAPI, baseUrl: string): string {
  let footerEl = $('[id^="shopify-section-footer"]')
  if (footerEl.length === 0) footerEl = $('footer').first()
  if (footerEl.length === 0) footerEl = $('[role="contentinfo"]').first()
  if (footerEl.length === 0) return ''

  let html = footerEl.html() || ''
  html = rewriteAssetUrls(html, baseUrl)
  html = cleanupHtml(html)
  return html
}

// ---------------------------------------------------------------------------
// Shopify Section Extraction
// ---------------------------------------------------------------------------

function extractShopifySections($: cheerio.CheerioAPI, baseUrl: string): ClonedSection[] {
  const sections: ClonedSection[] = []
  let position = 0

  // Shopify wraps each section in a div with id="shopify-section-{type}"
  $('[id^="shopify-section-"]').each((_, el) => {
    const $el = $(el)
    const fullId = $el.attr('id') || ''
    const sectionId = fullId.replace('shopify-section-', '')

    // Skip header and footer — they're handled separately
    if (sectionId.includes('header') || sectionId.includes('footer')) return
    // Skip announcement bars — they're part of header
    if (sectionId.includes('announcement')) return

    let html = $el.html() || ''
    if (html.trim().length < 50) return // Skip empty/tiny sections

    html = rewriteAssetUrls(html, baseUrl)
    html = cleanupHtml(html)

    // Determine a clean section type
    const sectionType = classifySectionType(sectionId, html)

    sections.push({
      id: sectionType + (position > 0 ? `-${position}` : ''),
      html,
      shopifySectionType: sectionId,
      position,
    })
    position++
  })

  // If no shopify-section divs found in main content, fall back to generic
  if (sections.length === 0) {
    return extractGenericSections($, baseUrl)
  }

  return sections
}

// ---------------------------------------------------------------------------
// Generic Section Extraction
// ---------------------------------------------------------------------------

function extractGenericSections($: cheerio.CheerioAPI, baseUrl: string): ClonedSection[] {
  const sections: ClonedSection[] = []
  let position = 0

  // Try <main> children first
  const main = $('main').first()
  const container = main.length > 0 ? main : $('body')

  // Look for <section> elements, or direct children of main
  const sectionEls = container.children('section, [class*="section"], [class*="hero"], [class*="banner"], [class*="featured"], [class*="collection"], [class*="slider"], [class*="carousel"]')

  if (sectionEls.length > 0) {
    sectionEls.each((_, el) => {
      const $el = $(el)
      // Skip if it's header/footer/nav
      if ($el.is('header, footer, nav') || $el.closest('header, footer').length > 0) return

      let html = $.html($el)
      if (html.trim().length < 50) return

      html = rewriteAssetUrls(html, baseUrl)
      html = cleanupHtml(html)

      const classes = $el.attr('class') || ''
      const sectionType = classifySectionFromClasses(classes, html)

      sections.push({
        id: `${sectionType}-${position}`,
        html,
        position,
      })
      position++
    })
  }

  // Fallback: just grab the entire main content as one section
  if (sections.length === 0 && main.length > 0) {
    let html = main.html() || ''
    html = rewriteAssetUrls(html, baseUrl)
    html = cleanupHtml(html)
    if (html.trim().length > 100) {
      sections.push({ id: 'main-content', html, position: 0 })
    }
  }

  return sections
}

// ---------------------------------------------------------------------------
// Template Generation
// ---------------------------------------------------------------------------

function generateIndexTemplate(sections: ClonedSection[]): string {
  const lines: string[] = [
    '{% comment %} Homepage — Cloned sections {% endcomment %}',
    '',
  ]

  for (const section of sections) {
    lines.push(`{% section '${section.id}' %}`)
  }

  // If no sections were extracted, add a fallback
  if (sections.length === 0) {
    lines.push('{% comment %} No sections extracted from source {% endcomment %}')
    lines.push('<div class="container"><p>Homepage content</p></div>')
  }

  return lines.join('\n')
}

function generateLayoutTemplate(headContent: string): string {
  return `<!DOCTYPE html>
<html lang="{{ shop.locale | default: 'en' }}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{ page_title }}{% if page_title %} — {% endif %}{{ shop.name }}</title>
  <meta name="description" content="{{ page_description }}">
  {% if page_image %}<meta property="og:image" content="{{ page_image }}">{% endif %}
  <meta property="og:site_name" content="{{ shop.name }}">
  <meta property="og:type" content="website">

${headContent}

  <link rel="stylesheet" href="{{ 'style.css' | asset_url }}">
  {{ content_for_header }}
</head>
<body>
  {% section 'header' %}

  <main id="main-content" role="main">
    {{ content_for_layout }}
  </main>

  {% section 'footer' %}

  <script src="{{ 'script.js' | asset_url }}" defer></script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Head Content Extraction
// ---------------------------------------------------------------------------

function extractHeadContent($: cheerio.CheerioAPI): string {
  const lines: string[] = []

  // Extract preconnect/dns-prefetch links
  $('head link[rel="preconnect"], head link[rel="dns-prefetch"]').each((_, el) => {
    const href = $(el).attr('href')
    const crossorigin = $(el).attr('crossorigin')
    if (href) {
      const rel = $(el).attr('rel') || 'preconnect'
      lines.push(`  <link rel="${rel}" href="${href}"${crossorigin !== undefined ? ' crossorigin' : ''}>`)
    }
  })

  // Extract favicon links
  $('head link[rel="icon"], head link[rel="shortcut icon"], head link[rel="apple-touch-icon"]').each((_, el) => {
    const href = $(el).attr('href')
    const rel = $(el).attr('rel')
    const sizes = $(el).attr('sizes')
    const type = $(el).attr('type')
    if (href) {
      let tag = `  <link rel="${rel}" href="${href}"`
      if (sizes) tag += ` sizes="${sizes}"`
      if (type) tag += ` type="${type}"`
      tag += '>'
      lines.push(tag)
    }
  })

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Section Classification
// ---------------------------------------------------------------------------

function classifySectionType(sectionId: string, html: string): string {
  const id = sectionId.toLowerCase()

  if (id.includes('hero') || id.includes('slideshow') || id.includes('banner') || id.includes('image-with-text')) return 'hero'
  if (id.includes('featured-collection') || id.includes('collection-list')) return 'featured-collection'
  if (id.includes('featured-product')) return 'featured-product'
  if (id.includes('rich-text') || id.includes('rich_text')) return 'rich-text'
  if (id.includes('newsletter') || id.includes('email') || id.includes('subscribe')) return 'newsletter'
  if (id.includes('testimonial') || id.includes('review')) return 'testimonials'
  if (id.includes('blog') || id.includes('article')) return 'blog'
  if (id.includes('video')) return 'video'
  if (id.includes('gallery') || id.includes('image-gallery')) return 'gallery'
  if (id.includes('custom') || id.includes('liquid')) return 'custom'
  if (id.includes('multicolumn') || id.includes('multi-column')) return 'multicolumn'
  if (id.includes('collage')) return 'collage'
  if (id.includes('map')) return 'map'

  // Check HTML content for patterns
  if (html.includes('swiper') || html.includes('carousel') || html.includes('slider')) return 'slideshow'
  if (/<form[^>]*newsletter|subscribe|email/i.test(html)) return 'newsletter'

  return 'section'
}

function classifySectionFromClasses(classes: string, html: string): string {
  const c = classes.toLowerCase()

  if (c.includes('hero') || c.includes('banner') || c.includes('slider')) return 'hero'
  if (c.includes('featured') || c.includes('collection')) return 'featured'
  if (c.includes('product')) return 'products'
  if (c.includes('testimonial') || c.includes('review')) return 'testimonials'
  if (c.includes('newsletter') || c.includes('subscribe')) return 'newsletter'
  if (c.includes('blog') || c.includes('article')) return 'blog'

  return 'section'
}

// ---------------------------------------------------------------------------
// HTML Cleanup and URL Rewriting
// ---------------------------------------------------------------------------

function rewriteAssetUrls(html: string, baseUrl: string): string {
  // Extract hostname to avoid double-prefixing (e.g. //bibliobloom.com/cdn/...)
  let hostname = ''
  try { hostname = new URL(baseUrl).hostname } catch { /* ignore */ }

  // Make relative URLs absolute (for images, videos, etc.)
  // src="/path" → src="https://source.com/path"
  // Skip protocol-relative URLs (//domain/...) and paths already containing the hostname
  html = html.replace(/(src|data-src|data-srcset|data-bgset|poster)="(\/[^"]*?)"/g, (_, attr, path) => {
    if (path.startsWith('//')) return `${attr}="${path}"`
    if (hostname && path.includes(hostname)) return `${attr}="${path}"`
    return `${attr}="${baseUrl}${path}"`
  })

  // srcset="/path 100w" → srcset="https://source.com/path 100w"
  html = html.replace(/srcset="([^"]*)"/g, (_, srcset) => {
    const rewritten = srcset.replace(/(^|\s)(\/\S+)/g, (_m: string, space: string, path: string) => {
      if (path.startsWith('//')) return `${space}${path}`
      if (hostname && path.includes(hostname)) return `${space}${path}`
      return `${space}${baseUrl}${path}`
    })
    return `srcset="${rewritten}"`
  })

  // href="/path" → keep relative for internal links, absolute for assets
  html = html.replace(/href="(\/[^"]*?\.(?:css|js|ico|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|otf)[^"]*)"/gi, (_, path) => {
    if (path.startsWith('//')) return `href="${path}"`
    if (hostname && path.includes(hostname)) return `href="${path}"`
    return `href="${baseUrl}${path}"`
  })

  return html
}

function cleanupHtml(html: string): string {
  // ── Selectively strip tracking/analytics scripts, KEEP theme JS ──

  // Tracking script src patterns to STRIP
  const trackingSrcPatterns = /gtm|gtag|googletagmanager|hotjar|clarity\.ms|klaviyo|facebook|fbq|monorail|analytics|pixel|bogos|sellup|hcaptcha/i

  // Theme script src patterns to KEEP
  const themeSrcPatterns = /swiper|theme|jquery|main|vendor|app/i

  // Inline script content patterns to STRIP
  const trackingInlinePatterns = /gtag|dataLayer|fbq|_hjSettings|clarity|klaviyo/i

  // Inline script content patterns to KEEP
  const themeInlinePatterns = /Swiper|slider|accordion|menu|toggle/i

  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (fullMatch, attrs: string, body: string) => {
    // KEEP JSON-LD and application/json scripts (structured data)
    if (/type\s*=\s*["']application\/(ld\+)?json["']/i.test(attrs)) {
      return fullMatch
    }

    // Check for src attribute
    const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i)

    if (srcMatch) {
      const src = srcMatch[1]
      // STRIP if src matches tracking patterns
      if (trackingSrcPatterns.test(src)) return ''
      // KEEP if src matches theme patterns
      if (themeSrcPatterns.test(src)) return fullMatch
      // Default: strip unknown external scripts
      return ''
    }

    // Inline script (no src)
    const content = body.trim()
    if (!content) return '' // empty script tags — remove

    // STRIP if content matches tracking patterns
    if (trackingInlinePatterns.test(content)) return ''
    // KEEP if content matches theme patterns
    if (themeInlinePatterns.test(content)) return fullMatch
    // Default: strip unknown inline scripts
    return ''
  })

  // Remove tracking/analytics comment blocks
  html = html.replace(/<!--\s*Google\s*Tag[\s\S]*?-->/gi, '')
  html = html.replace(/<!--\s*Facebook[\s\S]*?-->/gi, '')

  // Remove Shopify-specific data attributes that cause issues
  // But KEEP class names, ids, and aria attributes!
  html = html.replace(/\s+data-shopify-editor[^=]*="[^"]*"/g, '')

  // Clean up excessive whitespace but preserve structure
  html = html.replace(/\n{3,}/g, '\n\n')

  return html.trim()
}

// ---------------------------------------------------------------------------
// Clone Pro v3 — Full Asset Clone Utilities
// ---------------------------------------------------------------------------

/**
 * Rewrite all asset URLs in HTML from original (remote) paths to local paths.
 *
 * Handles src, data-src (+promotes to src), srcset, inline style background-image,
 * href (for asset links), poster (for videos), and protocol-relative URLs.
 */
export function rewriteUrlsToLocal(html: string, rewriteMap: Map<string, string>): string {
  if (rewriteMap.size === 0) return html

  // Build a lookup that includes both https: and protocol-relative variants
  // so "//domain.com/path" and "https://domain.com/path" both match
  const expandedMap = new Map<string, string>()
  rewriteMap.forEach((local, original) => {
    expandedMap.set(original, local)
    // If original starts with "https://", also index the "//" variant
    if (original.startsWith('https://')) {
      expandedMap.set('//' + original.slice('https://'.length), local)
    }
    // If original starts with "//", also index the "https:" variant
    if (original.startsWith('//')) {
      expandedMap.set('https:' + original, local)
    }
  })

  // Sort URLs longest-first so we don't accidentally replace a substring
  const sortedUrls = Array.from(expandedMap.keys()).sort((a, b) => b.length - a.length)

  // Escape for use in regex
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // ── 1. src="..." ──
  for (const url of sortedUrls) {
    const local = expandedMap.get(url)!
    const pattern = new RegExp(`(src=["'])${escapeRe(url)}(["'])`, 'g')
    html = html.replace(pattern, `$1${local}$2`)
  }

  // ── 2. data-src="..." → rewrite AND promote to src ──
  for (const url of sortedUrls) {
    const local = expandedMap.get(url)!
    // Rewrite data-src value
    const dsPattern = new RegExp(`(data-src=["'])${escapeRe(url)}(["'])`, 'g')
    html = html.replace(dsPattern, (_, pre, post) => {
      return `${pre}${local}${post}`
    })
  }
  // After rewriting data-src, ensure a matching src exists on the same element
  html = html.replace(/<([a-z][a-z0-9]*)\b([^>]*?)\bdata-src=(["'])([^"']*?)\3([^>]*?)>/gi, (fullMatch, tag, before, quote, dsValue, after) => {
    // If src already present in attributes, just return as-is
    if (/\bsrc\s*=/i.test(before + after)) return fullMatch
    // Add src with the same value
    return `<${tag}${before} src=${quote}${dsValue}${quote} data-src=${quote}${dsValue}${quote}${after}>`
  })

  // ── 3. srcset="url1 100w, url2 200w" ──
  html = html.replace(/srcset=(["'])([^"']*?)\1/gi, (_, quote, srcsetValue) => {
    let rewritten = srcsetValue
    for (const url of sortedUrls) {
      const local = expandedMap.get(url)!
      // Each srcset entry is "url descriptor"
      rewritten = rewritten.split(url).join(local)
    }
    return `srcset=${quote}${rewritten}${quote}`
  })

  // ── 4. Inline style background-image: url(...) ──
  html = html.replace(/style=(["'])([^"']*?)\1/gi, (fullMatch, quote, styleValue) => {
    let rewritten = styleValue
    for (const url of sortedUrls) {
      const local = expandedMap.get(url)!
      rewritten = rewritten.split(url).join(local)
    }
    if (rewritten === styleValue) return fullMatch
    return `style=${quote}${rewritten}${quote}`
  })

  // ── 5. href="..." for asset links ──
  for (const url of sortedUrls) {
    const local = expandedMap.get(url)!
    const pattern = new RegExp(`(href=["'])${escapeRe(url)}(["'])`, 'g')
    html = html.replace(pattern, `$1${local}$2`)
  }

  // ── 6. poster="..." for videos ──
  for (const url of sortedUrls) {
    const local = expandedMap.get(url)!
    const pattern = new RegExp(`(poster=["'])${escapeRe(url)}(["'])`, 'g')
    html = html.replace(pattern, `$1${local}$2`)
  }

  return html
}

/**
 * Convert lazy-loaded images/elements to eager loading so they render
 * without JavaScript. Essential for cloned static sites.
 */
export function convertLazyToEager(html: string): string {
  // ── 1. data-src → promote to src if src not already present ──
  html = html.replace(/<([a-z][a-z0-9]*)\b([^>]*?)\bdata-src=(["'])([^"']*?)\3([^>]*?)>/gi, (fullMatch, tag, before, quote, dsValue, after) => {
    if (/\bsrc\s*=/i.test(before + after)) return fullMatch
    return `<${tag}${before} src=${quote}${dsValue}${quote} data-src=${quote}${dsValue}${quote}${after}>`
  })

  // ── 2. data-srcset → promote to srcset if not already present ──
  html = html.replace(/<([a-z][a-z0-9]*)\b([^>]*?)\bdata-srcset=(["'])([^"']*?)\3([^>]*?)>/gi, (fullMatch, tag, before, quote, dssValue, after) => {
    if (/\bsrcset\s*=/i.test(before + after)) return fullMatch
    return `<${tag}${before} srcset=${quote}${dssValue}${quote} data-srcset=${quote}${dssValue}${quote}${after}>`
  })

  // ── 3. loading="lazy" → loading="eager" ──
  html = html.replace(/loading\s*=\s*(["'])lazy\1/gi, 'loading="eager"')

  // ── 4. Remove .lazyload class, add .lazyloaded class ──
  html = html.replace(/class=(["'])([^"']*?)\1/gi, (_, quote, classes) => {
    let updated = classes
    // Replace lazyload with lazyloaded (avoid replacing lazyloaded itself)
    updated = updated.replace(/\blazyload\b(?!ed)/g, 'lazyloaded')
    // If lazyloaded wasn't already there and we didn't just add it, no change needed
    return `class=${quote}${updated}${quote}`
  })

  // ── 5. data-bgset → convert to inline background-image style ──
  html = html.replace(/<([a-z][a-z0-9]*)\b([^>]*?)\bdata-bgset=(["'])([^"']*?)\3([^>]*?)>/gi, (fullMatch, tag, before, _quote, bgsetValue, after) => {
    // Take the first URL from the bgset value (format: "url descriptor, url descriptor")
    const firstUrl = bgsetValue.trim().split(/\s+/)[0]?.split(',')[0]?.trim()
    if (!firstUrl) return fullMatch

    const allAttrs = before + after
    // Check if there's already an inline style
    if (/style\s*=\s*["']/i.test(allAttrs)) {
      // Append background-image to existing style
      const result = `<${tag}${before}${after}>`.replace(
        /style=(["'])([^"']*?)\1/i,
        (_, sq, existingStyle) => {
          const cleaned = existingStyle.replace(/;\s*$/, '')
          return `style=${sq}${cleaned}; background-image: url(${firstUrl})${sq}`
        },
      )
      return result
    }

    // Add new style attribute
    return `<${tag}${before} style="background-image: url(${firstUrl})"${after}>`
  })

  return html
}
