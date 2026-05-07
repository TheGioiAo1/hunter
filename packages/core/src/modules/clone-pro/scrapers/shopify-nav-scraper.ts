/**
 * Clone Pro — Shopify Navigation Scraper
 *
 * Extracts navigation structure from Shopify sites.
 * Shopify renders nav server-side in the header HTML,
 * so we can parse it with cheerio (no headless browser needed).
 *
 * Returns both structured data (for DB) and raw HTML (for templates).
 */

import * as cheerio from 'cheerio'
import type { ScrapedMenuItem, ScrapedMenus } from './menu-scraper.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShopifyNavResult {
  /** Structured menu items for DB persistence */
  readonly menus: ScrapedMenus
  /** Raw announcement bar HTML (if present) */
  readonly announcementBarHtml: string | null
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Extract navigation from a Shopify site's homepage HTML.
 */
export function scrapeShopifyNav(html: string, baseUrl: string): ShopifyNavResult {
  const $ = cheerio.load(html)
  const normalizedBase = baseUrl.replace(/\/$/, '')

  // ── Extract announcement bar ──────────────────────────────────
  let announcementBarHtml: string | null = null
  const announcementEl = $('[id*="announcement"], [class*="announcement-bar"], .announcement, .promo-bar')
  if (announcementEl.length > 0) {
    announcementBarHtml = announcementEl.first().html()?.trim() || null
  }

  // ── Extract main menu ─────────────────────────────────────────
  const mainMenu = extractMainMenu($, normalizedBase)

  // ── Extract footer menu ───────────────────────────────────────
  const footerMenu = extractFooterMenu($, normalizedBase)

  return {
    menus: {
      main_menu: mainMenu,
      footer_menu: footerMenu,
    },
    announcementBarHtml,
  }
}

// ---------------------------------------------------------------------------
// Main Menu Extraction
// ---------------------------------------------------------------------------

function extractMainMenu($: cheerio.CheerioAPI, baseUrl: string): ScrapedMenuItem[] {
  const items: ScrapedMenuItem[] = []

  // Strategy 1: Look for Shopify header nav
  let navContainer = $('header nav, [id^="shopify-section-header"] nav').first()

  // Strategy 2: Look for main-nav or primary-nav
  if (navContainer.length === 0) {
    navContainer = $('.main-nav, .primary-nav, .site-nav, [class*="header-nav"], [class*="main-menu"]').first()
  }

  // Strategy 3: Any nav in header
  if (navContainer.length === 0) {
    navContainer = $('header').find('nav, ul').first()
  }

  if (navContainer.length === 0) return items

  // Find top-level menu items (direct <li> children of the nav's <ul>)
  const topLevelUl = navContainer.find('> ul, > div > ul, > div > div > ul').first()
  const listToProcess = topLevelUl.length > 0 ? topLevelUl : navContainer

  listToProcess.children('li, [class*="menu-item"], [class*="nav-item"]').each((_, el) => {
    const $li = $(el)
    const $link = $li.children('a, button, [class*="link"]').first()

    const title = cleanText($link.text())
    const url = resolveNavUrl($link.attr('href') || '', baseUrl)

    if (!title || title.length > 100) return

    // Check for dropdown/submenu
    const children: ScrapedMenuItem[] = []
    const submenu = $li.find('ul, [class*="submenu"], [class*="dropdown"], [class*="mega-menu"]').first()

    if (submenu.length > 0) {
      submenu.find('> li > a, > div a, > ul > li > a').each((_, childEl) => {
        const childTitle = cleanText($(childEl).text())
        const childUrl = resolveNavUrl($(childEl).attr('href') || '', baseUrl)
        if (childTitle && childTitle.length < 100) {
          children.push({ title: childTitle, url: childUrl, children: [] })
        }
      })
    }

    items.push({ title, url, children })
  })

  return items
}

// ---------------------------------------------------------------------------
// Footer Menu Extraction
// ---------------------------------------------------------------------------

function extractFooterMenu($: cheerio.CheerioAPI, baseUrl: string): ScrapedMenuItem[] {
  const items: ScrapedMenuItem[] = []

  const footer = $('footer, [id^="shopify-section-footer"], [class*="site-footer"]').first()
  if (footer.length === 0) return items

  // Footer typically has multiple columns with headings + links
  footer.find('ul').each((_, ul) => {
    $(ul).children('li').each((_, li) => {
      const $link = $(li).find('a').first()
      const title = cleanText($link.text())
      const url = resolveNavUrl($link.attr('href') || '', baseUrl)

      if (title && title.length < 100 && url) {
        // Avoid duplicates
        if (!items.some(i => i.url === url)) {
          items.push({ title, url, children: [] })
        }
      }
    })
  })

  return items
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function resolveNavUrl(url: string, baseUrl: string): string {
  if (!url || url === '#' || url.startsWith('javascript:')) return '#'
  if (url.startsWith('http://') || url.startsWith('https://')) {
    // Convert absolute URLs to relative if they're on the same domain
    try {
      const parsed = new URL(url)
      const baseParsed = new URL(baseUrl)
      if (parsed.hostname === baseParsed.hostname) {
        return parsed.pathname + parsed.search + parsed.hash
      }
    } catch { /* return as-is */ }
    return url
  }
  if (url.startsWith('/')) return url
  return '/' + url
}
