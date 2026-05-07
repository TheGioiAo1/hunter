/**
 * Clone Pro — Navigation Menu Scraper
 *
 * Extracts main and footer navigation menus from a page's HTML.
 * Handles nested submenus (dropdown/mega menu) via <ul>/<li> hierarchy.
 *
 * Works with any website — uses common nav patterns:
 * - <nav> elements in header/footer
 * - <header> / <footer> link lists
 * - Shopify, WooCommerce, Squarespace nav structures
 */

import * as cheerio from 'cheerio'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapedMenuItem {
  readonly title: string
  readonly url: string
  readonly children: ScrapedMenuItem[]
}

export interface ScrapedMenus {
  readonly main_menu: ScrapedMenuItem[]
  readonly footer_menu: ScrapedMenuItem[]
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function resolveUrl(href: string, baseUrl: string): string {
  try {
    // Skip anchors, javascript:, mailto:, tel: links
    if (
      !href ||
      href === '#' ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    ) {
      return ''
    }
    return new URL(href, baseUrl).href
  } catch {
    return ''
  }
}

function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const a = new URL(url)
    const b = new URL(baseUrl)
    return a.hostname === b.hostname
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Menu item extraction from <li>/<a> structure
// ---------------------------------------------------------------------------

function extractMenuItems(
  $: cheerio.CheerioAPI,
  $container: cheerio.Cheerio<any>,
  baseUrl: string,
  depth = 0,
): ScrapedMenuItem[] {
  if (depth > 3) return [] // Guard against infinite nesting

  const items: ScrapedMenuItem[] = []
  const seen = new Set<string>()

  // Try to find direct <li> children first (standard nav pattern)
  let $listItems = $container.children('li')

  // If no <li> found, look for <ul> > <li> inside
  if ($listItems.length === 0) {
    $listItems = $container.find('> ul > li, > ol > li')
  }

  // If still nothing, try finding <a> tags directly
  if ($listItems.length === 0) {
    $container.find('> a').each((_, el) => {
      const $a = $(el)
      const title = $a.text().trim()
      const href = resolveUrl($a.attr('href') || '', baseUrl)
      if (title && href && !seen.has(href)) {
        seen.add(href)
        items.push({ title, url: href, children: [] })
      }
    })
    return items
  }

  $listItems.each((_, li) => {
    const $li = $(li)
    // Get the direct <a> child (not nested submenu links)
    const $link = $li.find('> a').first()
    if ($link.length === 0) {
      // Sometimes the <li> has a <span> or <button> for dropdown toggles
      const $toggle = $li.find('> span, > button').first()
      if ($toggle.length === 0) return
    }

    const title = (
      $link.length > 0
        ? $link.clone().children('span.sr-only, .visually-hidden').remove().end().text()
        : $li.find('> span, > button').first().text()
    ).trim()

    const href = $link.length > 0
      ? resolveUrl($link.attr('href') || '', baseUrl)
      : ''

    if (!title) return

    // Deduplicate
    const key = href || title
    if (seen.has(key)) return
    seen.add(key)

    // Look for submenu
    const children: ScrapedMenuItem[] = []
    const $submenu = $li.find('> ul, > ol, > .submenu, > .dropdown-menu, > .mega-menu')
    if ($submenu.length > 0) {
      children.push(...extractMenuItems($, $submenu.first(), baseUrl, depth + 1))
    }

    items.push({
      title,
      url: href,
      children,
    })
  })

  return items
}

// ---------------------------------------------------------------------------
// Header nav detection
// ---------------------------------------------------------------------------

const HEADER_NAV_SELECTORS = [
  'header nav',
  'header .nav',
  'header .navigation',
  '#header nav',
  '.header nav',
  '.site-header nav',
  '.main-nav',
  '.primary-nav',
  '.navbar',
  '#site-navigation',
  '[data-section-type="header"] nav',  // Shopify
  '#SiteNav',                          // Shopify
  '.site-nav',                         // Shopify
  '#AccessibleNav',
  'nav[role="navigation"]',
  'nav.menu',
]

function findMainMenu($: cheerio.CheerioAPI, baseUrl: string): ScrapedMenuItem[] {
  for (const selector of HEADER_NAV_SELECTORS) {
    const $nav = $(selector).first()
    if ($nav.length === 0) continue

    // Find the first <ul> inside nav
    const $ul = $nav.find('ul').first()
    const $target = $ul.length > 0 ? $ul : $nav

    const items = extractMenuItems($, $target, baseUrl)
    if (items.length >= 2) {
      return items
    }
  }

  // Fallback: find any <nav> with multiple links
  const $allNavs = $('nav')
  for (let i = 0; i < $allNavs.length; i++) {
    const $nav = $allNavs.eq(i)
    // Skip footer navs
    if ($nav.closest('footer').length > 0) continue

    const $ul = $nav.find('ul').first()
    const $target = $ul.length > 0 ? $ul : $nav
    const items = extractMenuItems($, $target, baseUrl)
    if (items.length >= 2) {
      return items
    }
  }

  return []
}

// ---------------------------------------------------------------------------
// Footer nav detection
// ---------------------------------------------------------------------------

const FOOTER_NAV_SELECTORS = [
  'footer nav',
  'footer .nav',
  '#footer nav',
  '.footer nav',
  '.site-footer nav',
  'footer ul',
  '.footer-links',
  '.footer-menu',
  '[data-section-type="footer"] nav',  // Shopify
  '#footer-links',
]

function findFooterMenu($: cheerio.CheerioAPI, baseUrl: string): ScrapedMenuItem[] {
  // Collect all footer links as a flat list
  const allItems: ScrapedMenuItem[] = []
  const seen = new Set<string>()

  for (const selector of FOOTER_NAV_SELECTORS) {
    const $nav = $(selector)
    if ($nav.length === 0) continue

    $nav.find('a').each((_, el) => {
      const $a = $(el)
      const title = $a.text().trim()
      const href = resolveUrl($a.attr('href') || '', baseUrl)

      if (!title || !href || seen.has(href)) return
      if (!isSameDomain(href, baseUrl)) return

      seen.add(href)
      allItems.push({ title, url: href, children: [] })
    })

    if (allItems.length >= 2) return allItems
  }

  // Fallback: get all links from <footer>
  const $footer = $('footer').first()
  if ($footer.length > 0) {
    $footer.find('a').each((_, el) => {
      const $a = $(el)
      const title = $a.text().trim()
      const href = resolveUrl($a.attr('href') || '', baseUrl)

      if (!title || title.length > 80 || !href || seen.has(href)) return
      if (!isSameDomain(href, baseUrl)) return

      seen.add(href)
      allItems.push({ title, url: href, children: [] })
    })
  }

  return allItems
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract main and footer navigation menus from page HTML.
 *
 * @param html - Full page HTML string
 * @param baseUrl - Base URL of the website (for resolving relative links)
 * @returns ScrapedMenus with main_menu and footer_menu arrays
 */
export function scrapeMenus(html: string, baseUrl: string): ScrapedMenus {
  const $ = cheerio.load(html)

  return {
    main_menu: findMainMenu($, baseUrl),
    footer_menu: findFooterMenu($, baseUrl),
  }
}
