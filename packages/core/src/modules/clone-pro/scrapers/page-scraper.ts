/**
 * Clone Pro — Universal Page Scraper
 *
 * Scrapes any web page and extracts structured content:
 * title, body HTML, meta tags, OG data, and page type detection.
 *
 * Uses cheerio for DOM parsing + safeFetch for SSRF-safe HTTP.
 */

import * as cheerio from 'cheerio'
import { safeFetch } from '../../clone-shopify/safe-fetch.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PageType =
  | 'about'
  | 'contact'
  | 'policy'
  | 'faq'
  | 'terms'
  | 'shipping'
  | 'refund'
  | 'custom'

export interface ScrapedPage {
  readonly url: string
  readonly title: string
  readonly slug: string
  readonly body_html: string
  readonly meta_title: string | null
  readonly meta_description: string | null
  readonly og_image: string | null
  readonly author: string | null
  readonly published_at: string | null
  readonly page_type: PageType
}

// ---------------------------------------------------------------------------
// Page-type detection from URL path
// ---------------------------------------------------------------------------

const PAGE_TYPE_PATTERNS: Array<[RegExp, PageType]> = [
  [/\/(about|about-us|who-we-are|our-story|notre-histoire)\b/i, 'about'],
  [/\/(contact|contact-us|get-in-touch|kontakt)\b/i, 'contact'],
  [/\/(faq|faqs|frequently-asked|help-center|questions)\b/i, 'faq'],
  [/\/(terms|terms-of-service|terms-and-conditions|tos|agb)\b/i, 'terms'],
  [/\/(privacy|privacy-policy|data-protection|datenschutz)\b/i, 'policy'],
  [/\/(shipping|delivery|shipping-policy|shipping-info)\b/i, 'shipping'],
  [/\/(refund|return|refund-policy|returns-policy|exchange)\b/i, 'refund'],
  [/\/(policy|policies|legal)\b/i, 'policy'],
]

function detectPageType(url: string): PageType {
  const path = new URL(url).pathname.toLowerCase()
  for (const [pattern, type] of PAGE_TYPE_PATTERNS) {
    if (pattern.test(path)) return type
  }
  return 'custom'
}

// ---------------------------------------------------------------------------
// Slug extraction from URL
// ---------------------------------------------------------------------------

function extractSlug(url: string): string {
  const path = new URL(url).pathname
  // Remove trailing slash and leading slash
  const cleaned = path.replace(/^\/+|\/+$/g, '')
  // Take the last segment as slug, or use full path joined by dashes
  const segments = cleaned.split('/').filter(Boolean)
  if (segments.length === 0) return 'home'
  // If it's a deeply nested path like /pages/about-us, take last segment
  const last = segments[segments.length - 1]
  // Remove file extension if present
  return last.replace(/\.[^.]+$/, '') || 'page'
}

// ---------------------------------------------------------------------------
// HTML cleaning — remove scripts, tracking, non-content elements
// ---------------------------------------------------------------------------

const REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'nav',
  'header',
  'footer',
  '.header',
  '.footer',
  '.nav',
  '.navbar',
  '.navigation',
  '.sidebar',
  '.breadcrumb',
  '.breadcrumbs',
  '.cookie-banner',
  '.cookie-consent',
  '.popup',
  '.modal',
  '.newsletter-popup',
  '.announcement-bar',
  '.top-bar',
  '[data-tracking]',
  '[data-analytics]',
  '.social-share',
  '.share-buttons',
  '.related-products',
  '.recently-viewed',
  '#shopify-section-header',
  '#shopify-section-footer',
  '#shopify-section-announcement-bar',
]

function cleanBodyHtml($: cheerio.CheerioAPI, $content: cheerio.Cheerio<any>): string {
  // Clone to avoid mutating original
  const $clone = $content.clone()

  // Remove non-content elements
  for (const sel of REMOVE_SELECTORS) {
    $clone.find(sel).remove()
  }

  // Remove empty elements (empty divs, spans, etc.)
  $clone.find('div, span, p').each((_, el) => {
    const $el = $(el)
    if ($el.text().trim() === '' && $el.find('img, video, picture, svg').length === 0) {
      $el.remove()
    }
  })

  // Remove event handler attributes
  $clone.find('*').each((_, el) => {
    const $el = $(el)
    const attribs = (el as any).attribs || {}
    for (const attr of Object.keys(attribs)) {
      if (attr.startsWith('on') || attr.startsWith('data-track') || attr === 'data-analytics') {
        $el.removeAttr(attr)
      }
    }
  })

  const html = $clone.html()
  return html ? html.trim() : ''
}

// ---------------------------------------------------------------------------
// Main content area detection
// ---------------------------------------------------------------------------

const CONTENT_SELECTORS = [
  'main article',
  'article',
  'main',
  '[role="main"]',
  '.page-content',
  '.main-content',
  '#main-content',
  '#content',
  '.content',
  '.entry-content',       // WordPress
  '.post-content',
  '.article-content',
  '.page-body',
  '.rte',                 // Shopify rich-text
  '.shopify-section',
  '#MainContent',         // Shopify
  '#shopify-section-main',
  '.woocommerce',         // WooCommerce
  '.type-page',           // WordPress
]

function findMainContent($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  for (const selector of CONTENT_SELECTORS) {
    const $el = $(selector)
    if ($el.length > 0 && $el.text().trim().length > 50) {
      return $el.first()
    }
  }
  // Fallback: use body
  return $('body')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape a single page by URL and extract structured content.
 *
 * @param url - Absolute URL of the page to scrape
 * @returns ScrapedPage with cleaned HTML content and metadata
 */
export async function scrapePage(url: string): Promise<ScrapedPage> {
  const resp = await safeFetch(url, {
    timeoutMs: 15_000,
    maxBytes: 5 * 1024 * 1024, // 5 MB
  })

  const html = resp.body.toString('utf-8')
  const $ = cheerio.load(html)

  // --- Title ---
  const title =
    $('h1').first().text().trim() ||
    $('title').text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    'Untitled Page'

  // --- Meta tags ---
  const meta_title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').text().trim() ||
    null

  const meta_description =
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() ||
    null

  const og_image =
    $('meta[property="og:image"]').attr('content')?.trim() || null

  // --- Author ---
  const author =
    $('meta[name="author"]').attr('content')?.trim() ||
    $('[rel="author"]').text().trim() ||
    $('[class*="author"]').first().text().trim() ||
    null

  // --- Published date ---
  const published_at =
    $('meta[property="article:published_time"]').attr('content')?.trim() ||
    $('time[datetime]').first().attr('datetime')?.trim() ||
    $('meta[name="date"]').attr('content')?.trim() ||
    null

  // --- Main content ---
  const $mainContent = findMainContent($)
  const body_html = cleanBodyHtml($, $mainContent)

  return {
    url,
    title,
    slug: extractSlug(url),
    body_html,
    meta_title,
    meta_description,
    og_image,
    author,
    published_at,
    page_type: detectPageType(url),
  }
}

/**
 * Scrape multiple pages from sitemap nodes.
 * Filters to only 'page' kind nodes, fetches each, returns results.
 * Skips pages that fail to fetch (logs warning, does not throw).
 */
export async function scrapePages(
  pageUrls: string[],
  options?: { concurrency?: number },
): Promise<ScrapedPage[]> {
  const concurrency = options?.concurrency ?? 3
  const results: ScrapedPage[] = []
  const queue = [...pageUrls]

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift()
      if (!url) break
      try {
        const page = await scrapePage(url)
        results.push(page)
      } catch (err) {
        // Log but don't crash — partial results are better than none
        console.warn(`[page-scraper] Failed to scrape ${url}:`, (err as Error).message)
      }
    }
  }

  // Run workers concurrently
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
  await Promise.all(workers)

  return results
}
