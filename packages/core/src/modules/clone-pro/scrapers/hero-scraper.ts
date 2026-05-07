/**
 * Clone Pro — Hero/Banner Image Scraper
 *
 * Detects and extracts hero sections, banners, sliders, and carousels
 * from a website's homepage (or any page).
 *
 * Extracts:
 * - Hero image URL
 * - Heading and subheading text
 * - CTA button text and link
 * - Position order on page
 */

import * as cheerio from 'cheerio'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapedHero {
  readonly image_url: string
  readonly alt: string
  readonly heading: string | null
  readonly subheading: string | null
  readonly cta_text: string | null
  readonly cta_url: string | null
  readonly position: number
}

// ---------------------------------------------------------------------------
// URL helper
// ---------------------------------------------------------------------------

function resolveUrl(href: string, baseUrl: string): string {
  try {
    if (!href || href === '#' || href.startsWith('data:') || href.startsWith('javascript:')) {
      return ''
    }
    return new URL(href, baseUrl).href
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Hero section detection
// ---------------------------------------------------------------------------

// Selectors for hero/banner/slider sections (ordered by specificity)
const HERO_SECTION_SELECTORS = [
  // Common class patterns
  '.hero',
  '.hero-section',
  '.hero-banner',
  '.banner',
  '.banner-section',
  '.slider',
  '.slideshow',
  '.carousel',
  '.swiper',
  '.slick-slider',
  '.home-hero',
  '.homepage-hero',
  '.main-banner',
  '.full-width-banner',
  // Shopify-specific
  '#shopify-section-slideshow',
  '#shopify-section-image-with-text',
  '[data-section-type="slideshow"]',
  '[data-section-type="hero"]',
  '.shopify-section--slideshow',
  '.shopify-section--hero',
  // WooCommerce / WordPress
  '.wp-block-cover',
  '.elementor-section-full_width',
  // Semantic detection
  'section:first-of-type',
]

// Selectors for finding images within a hero section
const HERO_IMAGE_SELECTORS = [
  'img',
  'picture img',
  'picture source',
  '[style*="background-image"]',
]

// ---------------------------------------------------------------------------
// Extract image from various sources
// ---------------------------------------------------------------------------

function extractImageUrl(
  $: cheerio.CheerioAPI,
  $section: cheerio.Cheerio<any>,
  baseUrl: string,
): string {
  // 1. Try <img> tag
  const $img = $section.find('img').first()
  if ($img.length > 0) {
    const src =
      $img.attr('src') ||
      $img.attr('data-src') ||
      $img.attr('data-lazy-src') ||
      $img.attr('data-srcset')?.split(',')[0]?.trim().split(' ')[0]
    if (src) {
      const resolved = resolveUrl(src, baseUrl)
      if (resolved) return resolved
    }
  }

  // 2. Try <picture> <source> tag
  const $source = $section.find('picture source').first()
  if ($source.length > 0) {
    const srcset = $source.attr('srcset')
    if (srcset) {
      const firstSrc = srcset.split(',')[0]?.trim().split(' ')[0]
      if (firstSrc) {
        const resolved = resolveUrl(firstSrc, baseUrl)
        if (resolved) return resolved
      }
    }
  }

  // 3. Try background-image in inline style
  const style = $section.attr('style') || ''
  const bgMatch = style.match(/background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/i)
  if (bgMatch) {
    const resolved = resolveUrl(bgMatch[1], baseUrl)
    if (resolved) return resolved
  }

  // 4. Try children with background-image
  $section.find('[style*="background-image"]').each((_, el) => {
    if ($img.length > 0) return // already found
    const elStyle = $(el).attr('style') || ''
    const match = elStyle.match(/background-image:\s*url\(['"]?([^'")\s]+)['"]?\)/i)
    if (match) {
      const resolved = resolveUrl(match[1], baseUrl)
      if (resolved) {
        // Can't return from .each, but we set via side-effect below
      }
    }
  })

  // 5. Try data-background attribute
  const dataBg =
    $section.attr('data-background') ||
    $section.attr('data-bg') ||
    $section.find('[data-background], [data-bg]').first().attr('data-background') ||
    $section.find('[data-background], [data-bg]').first().attr('data-bg')
  if (dataBg) {
    const resolved = resolveUrl(dataBg, baseUrl)
    if (resolved) return resolved
  }

  return ''
}

// ---------------------------------------------------------------------------
// Extract text content from hero
// ---------------------------------------------------------------------------

function extractHeading(
  $: cheerio.CheerioAPI,
  $section: cheerio.Cheerio<any>,
): string | null {
  // Try h1 first, then h2
  for (const tag of ['h1', 'h2', '.hero-title', '.banner-title', '.heading']) {
    const $el = $section.find(tag).first()
    if ($el.length > 0) {
      const text = $el.text().trim()
      if (text && text.length > 0 && text.length < 200) {
        return text
      }
    }
  }
  return null
}

function extractSubheading(
  $: cheerio.CheerioAPI,
  $section: cheerio.Cheerio<any>,
): string | null {
  for (const tag of ['h2', 'h3', 'p', '.hero-subtitle', '.banner-subtitle', '.subheading', '.hero-text']) {
    const $el = $section.find(tag).first()
    if ($el.length > 0) {
      const text = $el.text().trim()
      // Must be different from heading and reasonable length
      if (text && text.length > 10 && text.length < 300) {
        return text
      }
    }
  }
  return null
}

function extractCTA(
  $: cheerio.CheerioAPI,
  $section: cheerio.Cheerio<any>,
  baseUrl: string,
): { text: string | null; url: string | null } {
  // Look for CTA buttons/links
  const ctaSelectors = [
    '.btn',
    '.button',
    'a.cta',
    '.hero-cta',
    '.banner-cta',
    '.btn-primary',
    '[class*="button"]',
    'a[class*="btn"]',
  ]

  for (const sel of ctaSelectors) {
    const $btn = $section.find(sel).first()
    if ($btn.length > 0) {
      const text = $btn.text().trim()
      const href = resolveUrl($btn.attr('href') || '', baseUrl)
      if (text && text.length < 50) {
        return { text, url: href || null }
      }
    }
  }

  return { text: null, url: null }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape hero sections, banners, and sliders from page HTML.
 *
 * @param html - Full page HTML string
 * @param baseUrl - Website base URL (for resolving image URLs)
 * @returns Array of ScrapedHero objects, ordered by position on page
 */
export function scrapeHeroes(html: string, baseUrl: string): ScrapedHero[] {
  const $ = cheerio.load(html)
  const heroes: ScrapedHero[] = []
  const seenImages = new Set<string>()
  let position = 0

  for (const selector of HERO_SECTION_SELECTORS) {
    const $sections = $(selector)

    $sections.each((_, el) => {
      const $section = $(el)

      // Must be a substantial element (not a tiny div)
      if ($section.text().trim().length < 5 && $section.find('img').length === 0) {
        return
      }

      const imageUrl = extractImageUrl($, $section, baseUrl)
      if (!imageUrl || seenImages.has(imageUrl)) return

      // Skip small utility images (icons, logos)
      // We check the image element dimensions if available
      const $img = $section.find('img').first()
      const width = parseInt($img.attr('width') || '0', 10)
      if (width > 0 && width < 200) return

      seenImages.add(imageUrl)

      const heading = extractHeading($, $section)
      const subheading = extractSubheading($, $section)
      const cta = extractCTA($, $section, baseUrl)

      // Make sure subheading is different from heading
      const finalSubheading = subheading === heading ? null : subheading

      heroes.push({
        image_url: imageUrl,
        alt: $img.attr('alt')?.trim() || heading || '',
        heading,
        subheading: finalSubheading,
        cta_text: cta.text,
        cta_url: cta.url,
        position: position++,
      })
    })
  }

  // Also check for large standalone images in the first section
  if (heroes.length === 0) {
    $('img').each((_, el) => {
      if (heroes.length >= 3) return // Cap at 3 heroes
      const $img = $(el)
      const width = parseInt($img.attr('width') || '0', 10)
      const height = parseInt($img.attr('height') || '0', 10)

      // Only consider large images
      if (width > 0 && width < 600 && height > 0 && height < 300) return

      const src = $img.attr('src') || $img.attr('data-src')
      if (!src) return
      const resolved = resolveUrl(src, baseUrl)
      if (!resolved || seenImages.has(resolved)) return

      // Must be in the first half of the page (hero position)
      const $parent = $img.parent()
      if ($parent.closest('footer, .footer, nav, .nav, header .logo').length > 0) return

      seenImages.add(resolved)
      heroes.push({
        image_url: resolved,
        alt: $img.attr('alt')?.trim() || '',
        heading: null,
        subheading: null,
        cta_text: null,
        cta_url: null,
        position: position++,
      })
    })
  }

  return heroes
}
