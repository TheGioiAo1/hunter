/**
 * Page Builder — Auto-Sectionize Module
 *
 * Takes raw HTML (from Clone Pro output) and automatically detects sections,
 * extracts their content, and generates section instances with settings.
 *
 * Each section instance has a `sectionType` (maps to a SectionSchema) and
 * `settings` (extracted values from the HTML).
 */

import * as cheerio from 'cheerio'
import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SectionizeResult {
  /** Detected sections in document order */
  sections: ExtractedSection[]
  /** Header HTML if detected */
  headerHtml: string | null
  /** Footer HTML if detected */
  footerHtml: string | null
  /** Any HTML not captured by a section */
  remainingHtml: string
  /** Warnings emitted during detection */
  warnings: string[]
}

export interface ExtractedSection {
  /** Maps to SectionSchema.type */
  sectionType: string
  /** Unique key, e.g. "hero_a1b2c3" */
  sectionKey: string
  /** Position in the page (0-based) */
  position: number
  /** Extracted values from the HTML */
  settings: Record<string, any>
  /** Block-level children (slides, testimonials, FAQ items, etc.) */
  blocks?: Array<{
    type: string
    settings: Record<string, any>
  }>
  /** The raw HTML of this section */
  originalHtml: string
  /** 0-100, how confident we are in the detection */
  confidence: number
}

export interface SectionizeOptions {
  /** Minimum confidence score to auto-detect (0-100). Default: 30 */
  minConfidence?: number
  /** If true, wraps unmatched sections as custom-html. Default: true */
  wrapUnmatched?: boolean
  /** Source URL for resolving relative image paths */
  sourceUrl?: string
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DetectionResult {
  sectionType: string
  confidence: number
  settings: Record<string, any>
  blocks?: ExtractedSection['blocks']
}

type Detector = (
  $: cheerio.CheerioAPI,
  $el: cheerio.Cheerio<any>,
  opts: Required<SectionizeOptions>,
) => DetectionResult | null

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function resolveUrl(href: string, baseUrl: string | undefined): string {
  if (!href || !href.trim()) return ''
  if (href.startsWith('data:') || href.startsWith('javascript:') || href === '#') return ''
  if (!baseUrl) return href
  try {
    return new URL(href, baseUrl).href
  } catch {
    return href
  }
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

/** Extract text from element, trimming whitespace */
function extractText($el: cheerio.Cheerio<any>): string {
  return $el.text().replace(/\s+/g, ' ').trim()
}

/** Extract first heading (h1-h6) text from element */
function extractHeading($el: cheerio.Cheerio<any>): string | null {
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const $h = $el.find(tag).first()
    if ($h.length > 0) {
      const text = extractText($h)
      if (text) return text
    }
  }
  return null
}

/** Extract background image from element's style attribute or first child img */
function extractBackgroundImage(
  $el: cheerio.Cheerio<any>,
  baseUrl: string | undefined,
): string | null {
  // Inline style background-image
  const style = $el.attr('style') || ''
  const bgMatch = style.match(/background-image:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i)
  if (bgMatch?.[1]) {
    return resolveUrl(bgMatch[1], baseUrl) || null
  }

  // data-background / data-bg attributes
  const dataBg = $el.attr('data-background') || $el.attr('data-bg')
  if (dataBg) {
    return resolveUrl(dataBg, baseUrl) || null
  }

  // Check children for background-image
  let found: string | null = null
  $el.find('[style*="background-image"]').each((_, child) => {
    if (found) return
    const childStyle = (child as any).attribs?.style ?? ''
    if (!childStyle) return
    const m = (childStyle as string).match(
      /background-image:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i,
    )
    if (m?.[1]) {
      found = resolveUrl(m[1], baseUrl) || null
    }
  })

  return found
}

/** Extract the first large image src from an element */
function extractImage(
  $el: cheerio.Cheerio<any>,
  baseUrl: string | undefined,
): string | null {
  const $img = $el.find('img').first()
  if ($img.length > 0) {
    const src =
      $img.attr('src') ||
      $img.attr('data-src') ||
      $img.attr('data-lazy-src') ||
      $img.attr('data-srcset')?.split(',')[0]?.trim().split(' ')[0]
    if (src) return resolveUrl(src, baseUrl) || null
  }

  // Fallback to background image
  return extractBackgroundImage($el, baseUrl)
}

/** Extract button {text, url} from element */
function extractButton(
  $el: cheerio.Cheerio<any>,
  baseUrl: string | undefined,
): { text: string; url: string } | null {
  const btnSelectors = [
    'a.btn', 'a.button', 'a[class*="btn"]', 'a[class*="button"]',
    'a[class*="cta"]', 'button', '.btn', '.button',
  ]
  for (const sel of btnSelectors) {
    const $btn = $el.find(sel).first()
    if ($btn.length > 0) {
      const text = extractText($btn)
      if (text && text.length < 80) {
        const href = $btn.attr('href') || ''
        return { text, url: resolveUrl(href, baseUrl) || href }
      }
    }
  }
  // Last resort: any <a> with short text
  const $a = $el.find('a').filter((_, a) => {
    const t = extractText(cheerio.load('')(a))
    return t.length > 0 && t.length < 50
  }).first()
  if ($a.length > 0) {
    const text = extractText($a)
    const href = $a.attr('href') || ''
    return { text, url: resolveUrl(href, baseUrl) || href }
  }
  return null
}

/** Count product-card-like children */
function countProductCards($el: cheerio.Cheerio<any>): number {
  let count = 0
  const cardSelectors = [
    '[class*="product-card"]', '[class*="product_card"]',
    '[class*="product-item"]', '[class*="product_item"]',
    '[class*="card"]',
  ]
  for (const sel of cardSelectors) {
    const n = $el.find(sel).length
    if (n > 0) { count = Math.max(count, n); break }
  }
  return count
}

/** Detect column count from grid/flex CSS or child count */
function detectColumns($el: cheerio.Cheerio<any>): number {
  const style = $el.attr('style') || ''

  // Check grid-template-columns
  const gridMatch = style.match(/grid-template-columns:\s*(.+?)(;|$)/i)
  if (gridMatch) {
    const cols = gridMatch[1].trim().split(/\s+/).length
    if (cols >= 2 && cols <= 6) return cols
  }

  // Check class-based column hints
  const cls = $el.attr('class') || ''
  const colMatch = cls.match(/(?:col|columns?)-(\d)/i)
  if (colMatch) {
    const n = parseInt(colMatch[1], 10)
    if (n >= 2 && n <= 6) return n
  }

  // Count direct children that look like columns
  const children = $el.children()
  if (children.length >= 2 && children.length <= 6) {
    return children.length
  }

  return 0
}

/** Generate unique section key */
function generateSectionKey(type: string): string {
  const suffix = crypto.randomBytes(4).toString('hex')
  return `${type}_${suffix}`
}

/** Check if a class attribute matches any of the given patterns */
function classMatches(cls: string, patterns: string[]): boolean {
  const lower = cls.toLowerCase()
  return patterns.some((p) => lower.includes(p))
}

/** Get outer HTML of a cheerio element */
function outerHtml($: cheerio.CheerioAPI, $el: cheerio.Cheerio<any>): string {
  return $.html($el) || ''
}

/** Extract all links from a navigation-like element */
function extractMenuLinks(
  $el: cheerio.Cheerio<any>,
  baseUrl: string | undefined,
): Array<{ text: string; url: string }> {
  const links: Array<{ text: string; url: string }> = []
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _$root = ($el as any).root ? $el : cheerio.load($el.html() ?? '')
  $el.find('a').each((_, a) => {
    const text = (a as any).children
      ?.map((c: any) => (c.type === 'text' ? c.data : ''))
      .join('')
      .trim()
    const href = (a as any).attribs?.href || ''
    if (text && text.length < 80) {
      links.push({ text, url: resolveUrl(href, baseUrl) || href })
    }
  })
  return links
}

// ---------------------------------------------------------------------------
// Section detectors
// ---------------------------------------------------------------------------

const detectHeader: Detector = ($, $el, opts) => {
  const tag = ($el.prop('tagName') || '').toLowerCase()
  const cls = $el.attr('class') || ''
  const role = $el.attr('role') || ''

  const isHeader =
    tag === 'header' ||
    role === 'banner' ||
    classMatches(cls, ['header', 'site-header', 'page-header', 'masthead'])

  if (!isHeader) return null

  // Check it contains nav-like content
  const hasNav = $el.find('nav, [class*="nav"], [class*="menu"]').length > 0
  const hasLogo = $el.find('img, [class*="logo"], svg').length > 0

  let confidence = 40
  if (tag === 'header') confidence += 25
  if (role === 'banner') confidence += 15
  if (hasNav) confidence += 10
  if (hasLogo) confidence += 10

  const logoImg = $el.find('[class*="logo"] img, .logo img, a:first-child img').first()
  const logoSrc = logoImg.length > 0
    ? resolveUrl(logoImg.attr('src') || logoImg.attr('data-src') || '', opts.sourceUrl)
    : null

  const menuLinks: Array<{ text: string; url: string }> = []
  $el.find('nav a, [class*="nav"] a, [class*="menu"] a').each((_, a) => {
    const $a = $(a)
    const text = extractText($a)
    const href = $a.attr('href') || ''
    if (text && text.length < 80 && !text.toLowerCase().includes('cart')) {
      menuLinks.push({ text, url: resolveUrl(href, opts.sourceUrl) || href })
    }
  })

  const hasSearch = $el.find('input[type="search"], [class*="search"], [aria-label*="search"]').length > 0
  const hasCart = $el.find('[class*="cart"], [aria-label*="cart"]').length > 0

  return {
    sectionType: 'header',
    confidence: Math.min(confidence, 100),
    settings: {
      logo_image: logoSrc,
      menu_links: menuLinks,
      has_search: hasSearch,
      has_cart: hasCart,
    },
  }
}

const detectFooter: Detector = ($, $el, opts) => {
  const tag = ($el.prop('tagName') || '').toLowerCase()
  const cls = $el.attr('class') || ''
  const role = $el.attr('role') || ''

  const isFooter =
    tag === 'footer' ||
    role === 'contentinfo' ||
    classMatches(cls, ['footer', 'site-footer', 'page-footer'])

  if (!isFooter) return null

  let confidence = 50
  if (tag === 'footer') confidence += 25
  if (role === 'contentinfo') confidence += 15

  // Extract copyright
  const fullText = extractText($el)
  const copyMatch = fullText.match(/(?:copyright|©|\(c\))\s*.{0,100}/i)
  const copyright = copyMatch ? copyMatch[0].trim() : null

  // Extract social links
  const socialLinks: Array<{ platform: string; url: string }> = []
  const socialPatterns = [
    'facebook', 'twitter', 'instagram', 'youtube', 'linkedin',
    'pinterest', 'tiktok', 'snapchat', 'x.com',
  ]
  $el.find('a').each((_, a) => {
    const href = ($(a).attr('href') || '').toLowerCase()
    for (const platform of socialPatterns) {
      if (href.includes(platform)) {
        socialLinks.push({
          platform: platform === 'x.com' ? 'twitter' : platform,
          url: resolveUrl($(a).attr('href') || '', opts.sourceUrl),
        })
        break
      }
    }
  })

  // Check for newsletter form
  const hasNewsletter = $el.find('input[type="email"], [class*="newsletter"]').length > 0

  // Extract column menus
  const columnMenus: Array<{ title: string | null; links: Array<{ text: string; url: string }> }> = []
  $el.find('[class*="footer-col"], [class*="footer_col"], [class*="footer-menu"], [class*="widget"]').each((_, col) => {
    const $col = $(col)
    const title = extractHeading($col)
    const links: Array<{ text: string; url: string }> = []
    $col.find('a').each((_, a) => {
      const $a = $(a)
      const text = extractText($a)
      const href = $a.attr('href') || ''
      if (text && text.length < 80) {
        links.push({ text, url: resolveUrl(href, opts.sourceUrl) || href })
      }
    })
    if (links.length > 0) {
      columnMenus.push({ title, links })
    }
  })

  return {
    sectionType: 'footer',
    confidence: Math.min(confidence, 100),
    settings: {
      copyright,
      social_links: socialLinks,
      has_newsletter: hasNewsletter,
      column_menus: columnMenus,
    },
  }
}

const detectHero: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''
  const tag = ($el.prop('tagName') || '').toLowerCase()

  const hasHeroClass = classMatches(cls, ['hero', 'banner', 'jumbotron'])
  const hasSlideshowClass = classMatches(cls, ['slideshow', 'slider', 'carousel', 'swiper', 'slick'])

  // If it looks more like a slideshow, let the slideshow detector handle it
  if (hasSlideshowClass && !hasHeroClass) return null

  let confidence = 0
  if (hasHeroClass) confidence += 50

  // Large background image?
  const bgImage = extractBackgroundImage($el, opts.sourceUrl)
  if (bgImage) confidence += 15

  // Has a prominent heading?
  const heading = extractHeading($el)
  if (heading) confidence += 10

  // Has a CTA button?
  const button = extractButton($el, opts.sourceUrl)
  if (button) confidence += 10

  // Is it a large section? (more than trivial content)
  const text = extractText($el)
  if (text.length > 20 && text.length < 500) confidence += 5

  // First section with large image is likely a hero
  const mainImage = extractImage($el, opts.sourceUrl)
  if (mainImage) confidence += 10

  if (confidence < 30) return null

  // Extract subheading: first <p> or second heading
  let subheading: string | null = null
  const $p = $el.find('p').first()
  if ($p.length > 0) {
    const pText = extractText($p)
    if (pText && pText !== heading && pText.length > 5 && pText.length < 300) {
      subheading = pText
    }
  }

  return {
    sectionType: 'hero-banner',
    confidence: Math.min(confidence, 100),
    settings: {
      heading,
      subheading,
      button_text: button?.text || null,
      button_url: button?.url || null,
      background_image: bgImage || mainImage || null,
      image: mainImage || null,
    },
  }
}

const detectFeaturedCollection: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasCollectionClass = classMatches(cls, [
    'collection', 'product-grid', 'product-list', 'featured-product',
    'featured-collection', 'products-section',
  ])

  const productCount = countProductCards($el)
  const hasPrices = $el.find('[class*="price"]').length > 0

  let confidence = 0
  if (hasCollectionClass) confidence += 40
  if (productCount >= 2) confidence += 30
  if (hasPrices) confidence += 15
  if (productCount >= 4) confidence += 10

  if (confidence < 30) return null

  const heading = extractHeading($el)
  const columns = detectColumns($el) || Math.min(productCount, 4)

  return {
    sectionType: 'featured-collection',
    confidence: Math.min(confidence, 100),
    settings: {
      heading,
      product_count: productCount,
      columns,
    },
  }
}

const detectImageWithText: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasExplicitClass = classMatches(cls, [
    'image-with-text', 'image_with_text', 'media-with-text',
    'text-with-image', 'split-section',
  ])

  // Must contain both a substantial image and a text block
  const image = extractImage($el, opts.sourceUrl)
  const heading = extractHeading($el)
  const $p = $el.find('p').first()
  const bodyText = $p.length > 0 ? extractText($p) : null

  const hasImage = !!image
  const hasText = !!(heading || (bodyText && bodyText.length > 20))

  let confidence = 0
  if (hasExplicitClass) confidence += 50
  if (hasImage && hasText) confidence += 30
  if (heading) confidence += 5
  if (bodyText && bodyText.length > 30) confidence += 5

  if (confidence < 30 || !hasImage || !hasText) return null

  // Detect layout direction
  const children = $el.children()
  let imagePosition: 'left' | 'right' = 'left'
  if (children.length >= 2) {
    const firstChild = children.first()
    const hasImgInFirst = firstChild.find('img').length > 0 || !!extractBackgroundImage(firstChild, opts.sourceUrl)
    imagePosition = hasImgInFirst ? 'left' : 'right'
  }

  const button = extractButton($el, opts.sourceUrl)

  return {
    sectionType: 'image-with-text',
    confidence: Math.min(confidence, 100),
    settings: {
      heading,
      body_text: bodyText,
      image,
      image_position: imagePosition,
      button_text: button?.text || null,
      button_url: button?.url || null,
    },
  }
}

const detectRichText: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasExplicitClass = classMatches(cls, [
    'rich-text', 'rich_text', 'text-block', 'text-section',
    'content-block', 'page-content', 'wysiwyg',
  ])

  // Primarily text content: headings, paragraphs, lists — no product cards, no large images
  const heading = extractHeading($el)
  const paragraphs = $el.find('p')
  const lists = $el.find('ul, ol')
  const images = $el.find('img')
  const productCards = countProductCards($el)

  const textContent = extractText($el)
  const hasSubstantialText = textContent.length > 50
  const isTextDominated = paragraphs.length > 0 || lists.length > 0
  const hasNoProducts = productCards === 0
  const fewImages = images.length <= 1

  let confidence = 0
  if (hasExplicitClass) confidence += 50
  if (hasSubstantialText && isTextDominated && hasNoProducts && fewImages) confidence += 35
  if (heading) confidence += 5
  if (paragraphs.length >= 2) confidence += 5

  if (confidence < 30) return null

  // Extract alignment from style or class
  let textAlign: 'left' | 'center' | 'right' = 'left'
  const style = $el.attr('style') || ''
  if (style.includes('text-align: center') || style.includes('text-align:center')) textAlign = 'center'
  else if (style.includes('text-align: right') || style.includes('text-align:right')) textAlign = 'right'
  else if (classMatches(cls, ['text-center', 'center'])) textAlign = 'center'

  // Get body HTML (inner content minus heading)
  const $clone = $el.clone()
  $clone.find('h1, h2, h3, h4, h5, h6').first().remove()
  const bodyHtml = $clone.html()?.trim() || ''

  return {
    sectionType: 'rich-text',
    confidence: Math.min(confidence, 100),
    settings: {
      heading,
      body_html: bodyHtml,
      text_align: textAlign,
    },
  }
}

const detectTestimonials: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasClass = classMatches(cls, ['testimonial', 'review', 'quote', 'customer-feedback'])

  let confidence = 0
  if (hasClass) confidence += 50

  // Look for quote-like structures
  const blockquotes = $el.find('blockquote, [class*="quote"], [class*="testimonial-item"], [class*="review-item"]')
  if (blockquotes.length > 0) confidence += 25
  if (blockquotes.length >= 2) confidence += 10

  if (confidence < 30) return null

  const heading = extractHeading($el)
  const blocks: ExtractedSection['blocks'] = []

  const itemSel = blockquotes.length > 0
    ? blockquotes
    : $el.children()

  itemSel.each((_, item) => {
    const $item = $(item)
    const quoteText = extractText($item.find('p, [class*="text"], [class*="content"], blockquote').first()) ||
      extractText($item)
    const authorName = extractText(
      $item.find('[class*="author"], [class*="name"], cite, .cite').first(),
    )
    const authorImage = extractImage($item.find('[class*="author"], [class*="avatar"]').first(), opts.sourceUrl)

    if (quoteText && quoteText.length > 10) {
      blocks.push({
        type: 'testimonial',
        settings: {
          quote: quoteText,
          author: authorName || null,
          author_image: authorImage || null,
        },
      })
    }
  })

  if (blocks.length === 0) return null

  return {
    sectionType: 'testimonials',
    confidence: Math.min(confidence, 100),
    settings: { heading },
    blocks,
  }
}

const detectNewsletter: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasClass = classMatches(cls, ['newsletter', 'subscribe', 'signup', 'mailing-list', 'email-signup'])
  const hasEmailInput = $el.find('input[type="email"]').length > 0
  const hasForm = $el.find('form').length > 0

  let confidence = 0
  if (hasClass) confidence += 40
  if (hasEmailInput) confidence += 35
  if (hasForm && hasEmailInput) confidence += 10

  if (confidence < 30) return null

  const heading = extractHeading($el)
  const $p = $el.find('p').first()
  const subheading = $p.length > 0 ? extractText($p) : null
  const button = extractButton($el, opts.sourceUrl)

  return {
    sectionType: 'newsletter',
    confidence: Math.min(confidence, 100),
    settings: {
      heading,
      subheading: subheading !== heading ? subheading : null,
      button_text: button?.text || 'Subscribe',
    },
  }
}

const detectSlideshow: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasClass = classMatches(cls, ['slideshow', 'carousel', 'swiper', 'slick', 'owl-carousel', 'glide'])

  let confidence = 0
  if (hasClass) confidence += 50

  // Look for multiple slide children
  const slideSelectors = [
    '[class*="slide"]', '[class*="swiper-slide"]', '[class*="slick-slide"]',
    '[class*="carousel-item"]', '[class*="glide__slide"]',
  ]

  let $slides = cheerio.load('')('')  // empty
  for (const sel of slideSelectors) {
    const found = $el.find(sel)
    if (found.length >= 2) {
      $slides = found
      confidence += 25
      break
    }
  }

  // If no explicit slide children, check for multiple large images
  if ($slides.length < 2) {
    const images = $el.find('img')
    if (images.length >= 2) {
      $slides = images
      confidence += 15
    }
  }

  if (confidence < 30 || $slides.length < 2) return null

  const heading = extractHeading($el)
  const blocks: ExtractedSection['blocks'] = []

  $slides.each((_, slide) => {
    const $slide = $(slide)
    const image = extractImage($slide, opts.sourceUrl)
    const slideHeading = extractHeading($slide)
    const button = extractButton($slide, opts.sourceUrl)

    blocks.push({
      type: 'slide',
      settings: {
        image: image || null,
        heading: slideHeading || null,
        button_text: button?.text || null,
        button_url: button?.url || null,
      },
    })
  })

  return {
    sectionType: 'slideshow',
    confidence: Math.min(confidence, 100),
    settings: { heading },
    blocks,
  }
}

const detectLogoList: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasClass = classMatches(cls, [
    'logo-list', 'brand-list', 'partner', 'client', 'sponsor',
    'logo-bar', 'brands', 'trusted-by',
  ])

  // Must have multiple small images
  const images = $el.find('img')
  const smallImages = images.filter((_, img) => {
    const width = parseInt($(img).attr('width') || '0', 10)
    // Small logos are typically under 200px, or width is unknown
    return width === 0 || width <= 200
  })

  let confidence = 0
  if (hasClass) confidence += 45
  if (smallImages.length >= 3) confidence += 30
  if (smallImages.length >= 5) confidence += 10

  // Negative signal: if images are large or contain prices, not a logo list
  const hasPrices = $el.find('[class*="price"]').length > 0
  if (hasPrices) return null

  if (confidence < 30) return null

  const heading = extractHeading($el)
  const blocks: ExtractedSection['blocks'] = []

  smallImages.each((_, img) => {
    const $img = $(img)
    const src = $img.attr('src') || $img.attr('data-src') || ''
    const resolvedSrc = resolveUrl(src, opts.sourceUrl)
    const $parent = $img.closest('a')
    const link = $parent.length > 0 ? resolveUrl($parent.attr('href') || '', opts.sourceUrl) : ''

    if (resolvedSrc) {
      blocks.push({
        type: 'logo',
        settings: {
          image: resolvedSrc,
          alt: $img.attr('alt') || '',
          link: link || null,
        },
      })
    }
  })

  if (blocks.length < 2) return null

  return {
    sectionType: 'logo-list',
    confidence: Math.min(confidence, 100),
    settings: { heading },
    blocks,
  }
}

const detectMultiColumn: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasClass = classMatches(cls, [
    'multi-column', 'multi_column', 'columns-section', 'features',
    'services', 'benefits', 'icon-boxes', 'info-boxes',
  ])

  const children = $el.children()
  const childCount = children.length

  // Look for a wrapper with 2-6 children of similar structure
  let $columns = children
  if (childCount === 1) {
    // Maybe there's a wrapper div
    const innerChildren = children.first().children()
    if (innerChildren.length >= 2 && innerChildren.length <= 6) {
      $columns = innerChildren
    }
  }

  const colCount = $columns.length
  if (colCount < 2 || colCount > 6) {
    if (!hasClass) return null
  }

  // Each column should have heading + text content
  let columnsWithHeading = 0
  let columnsWithText = 0
  $columns.each((_, col) => {
    const $col = $(col)
    if (extractHeading($col)) columnsWithHeading++
    const p = $col.find('p')
    if (p.length > 0 && extractText(p.first()).length > 10) columnsWithText++
  })

  let confidence = 0
  if (hasClass) confidence += 40
  if (colCount >= 2 && colCount <= 4 && columnsWithHeading >= 2) confidence += 30
  if (columnsWithText >= 2) confidence += 10
  if (columnsWithHeading === colCount) confidence += 10

  if (confidence < 30) return null

  const heading = extractHeading($el)
  const blocks: ExtractedSection['blocks'] = []

  $columns.each((_, col) => {
    const $col = $(col)
    const colHeading = extractHeading($col)
    const $p = $col.find('p').first()
    const colText = $p.length > 0 ? extractText($p) : null
    const colImage = extractImage($col, opts.sourceUrl)

    blocks.push({
      type: 'column',
      settings: {
        heading: colHeading || null,
        text: colText || null,
        image: colImage || null,
      },
    })
  })

  return {
    sectionType: 'multi-column',
    confidence: Math.min(confidence, 100),
    settings: {
      heading,
      columns: colCount,
    },
    blocks,
  }
}

const detectFaq: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''
  const tag = ($el.prop('tagName') || '').toLowerCase()

  const hasClass = classMatches(cls, ['faq', 'accordion', 'collapse', 'expandable'])
  const hasDetails = $el.find('details').length > 0

  let confidence = 0
  if (hasClass) confidence += 50
  if (hasDetails) confidence += 35

  // Look for question/answer pairs
  const faqItemSelectors = [
    'details', '[class*="faq-item"]', '[class*="accordion-item"]',
    '[class*="collapse-item"]', '[class*="question"]',
  ]

  let $items = cheerio.load('')('')
  for (const sel of faqItemSelectors) {
    const found = $el.find(sel)
    if (found.length >= 2) {
      $items = found
      confidence += 15
      break
    }
  }

  if (confidence < 30) return null

  const heading = extractHeading($el)
  const blocks: ExtractedSection['blocks'] = []

  if ($items.length > 0) {
    $items.each((_, item) => {
      const $item = $(item)
      const question = extractText(
        $item.find('summary, [class*="question"], [class*="title"], [class*="header"], h3, h4').first(),
      )
      const answer = extractText(
        $item.find('[class*="answer"], [class*="content"], [class*="body"], p').first(),
      )
      if (question) {
        blocks.push({
          type: 'faq-item',
          settings: {
            question,
            answer: answer || '',
          },
        })
      }
    })
  }

  if (blocks.length === 0 && !hasClass) return null

  return {
    sectionType: 'faq',
    confidence: Math.min(confidence, 100),
    settings: { heading },
    blocks,
  }
}

const detectVideo: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasClass = classMatches(cls, ['video', 'media-player'])

  // Check for iframe with video source
  const $iframe = $el.find('iframe').first()
  const iframeSrc = $iframe.attr('src') || $iframe.attr('data-src') || ''
  const isVideoIframe = /youtube|vimeo|dailymotion|wistia/.test(iframeSrc)

  // Check for <video> element
  const $video = $el.find('video').first()
  const hasVideo = $video.length > 0
  const videoSrc = $video.attr('src') || $video.find('source').first().attr('src') || ''

  let confidence = 0
  if (hasClass) confidence += 30
  if (isVideoIframe) confidence += 50
  if (hasVideo) confidence += 40

  if (confidence < 30) return null

  const heading = extractHeading($el)
  const coverImage = extractImage($el, opts.sourceUrl)

  let videoUrl = ''
  if (isVideoIframe) {
    videoUrl = resolveUrl(iframeSrc, opts.sourceUrl)
  } else if (hasVideo) {
    videoUrl = resolveUrl(videoSrc, opts.sourceUrl)
  }

  return {
    sectionType: 'video',
    confidence: Math.min(confidence, 100),
    settings: {
      heading,
      video_url: videoUrl,
      cover_image: coverImage || null,
    },
  }
}

const detectContactForm: Detector = ($, $el, opts) => {
  const cls = $el.attr('class') || ''

  const hasClass = classMatches(cls, ['contact', 'form-section', 'get-in-touch', 'reach-us'])
  const $form = $el.find('form').first()
  const hasForm = $form.length > 0

  if (!hasForm) return null

  // Must have typical contact form fields
  const hasName = $form.find('input[name*="name"], input[placeholder*="name" i]').length > 0
  const hasEmail = $form.find('input[type="email"], input[name*="email"], input[placeholder*="email" i]').length > 0
  const hasMessage = $form.find('textarea, [name*="message"], [name*="comment"]').length > 0

  let confidence = 0
  if (hasClass) confidence += 35
  if (hasEmail && hasMessage) confidence += 30
  if (hasName) confidence += 10
  if (hasForm) confidence += 10

  // Distinguish from newsletter: contact forms usually have a message/textarea field
  if (!hasMessage && !hasName && hasEmail) return null // likely newsletter

  if (confidence < 30) return null

  const heading = extractHeading($el)
  const hasPhone = $form.find('input[type="tel"], input[name*="phone"]').length > 0
  const hasSubject = $form.find('input[name*="subject"], select[name*="subject"]').length > 0

  return {
    sectionType: 'contact-form',
    confidence: Math.min(confidence, 100),
    settings: {
      heading,
      has_name_field: hasName,
      has_email_field: hasEmail,
      has_phone_field: hasPhone,
      has_subject_field: hasSubject,
      has_message_field: hasMessage,
    },
  }
}

// ---------------------------------------------------------------------------
// Detector pipeline (ordered by specificity — most specific first)
// ---------------------------------------------------------------------------

/** Detectors for header and footer (extracted separately) */
const structuralDetectors: Detector[] = [detectHeader, detectFooter]

/** Content section detectors, ordered from most specific to least */
const contentDetectors: Detector[] = [
  detectSlideshow,
  detectFeaturedCollection,
  detectVideo,
  detectContactForm,
  detectTestimonials,
  detectFaq,
  detectNewsletter,
  detectLogoList,
  detectHero,
  detectImageWithText,
  detectMultiColumn,
  detectRichText,
]

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Auto-sectionize raw HTML into detected sections.
 *
 * Parses the HTML with cheerio, detects header/footer, then splits the
 * remaining body into sections by running each top-level element through
 * the detection pipeline.
 */
export function autoSectionize(html: string, options?: SectionizeOptions): SectionizeResult {
  const opts: Required<SectionizeOptions> = {
    minConfidence: options?.minConfidence ?? 30,
    wrapUnmatched: options?.wrapUnmatched ?? true,
    sourceUrl: options?.sourceUrl ?? '',
  }

  const $ = cheerio.load(html)
  const warnings: string[] = []

  // ------------------------------------------------------------------
  // Step 1: Extract header
  // ------------------------------------------------------------------
  let headerHtml: string | null = null
  const headerSelectors = ['header', '[role="banner"]', '[class*="header"]:not([class*="sub-header"])']

  for (const sel of headerSelectors) {
    const $header = $(sel).first()
    if ($header.length > 0) {
      const result = detectHeader($, $header, opts)
      if (result && result.confidence >= opts.minConfidence) {
        headerHtml = outerHtml($, $header)
        $header.remove()
        break
      }
    }
  }

  // ------------------------------------------------------------------
  // Step 2: Extract footer
  // ------------------------------------------------------------------
  let footerHtml: string | null = null
  const footerSelectors = ['footer', '[role="contentinfo"]', '[class*="footer"]:not([class*="sub-footer"])']

  for (const sel of footerSelectors) {
    const $footer = $(sel).first()
    if ($footer.length > 0) {
      const result = detectFooter($, $footer, opts)
      if (result && result.confidence >= opts.minConfidence) {
        footerHtml = outerHtml($, $footer)
        $footer.remove()
        break
      }
    }
  }

  // ------------------------------------------------------------------
  // Step 3: Identify the main content container
  // ------------------------------------------------------------------
  let $container: cheerio.Cheerio<any> = $('body').length > 0 ? $('body') : $.root()

  const $main = $('main').first()
  if ($main.length > 0) {
    $container = $main
  } else {
    // Try common wrapper selectors
    const wrapperSelectors = [
      '#content', '#main', '#main-content', '.main-content',
      '.content', '.page-content', '.site-content', '[role="main"]',
    ]
    for (const sel of wrapperSelectors) {
      const $w = $(sel).first()
      if ($w.length > 0) {
        $container = $w
        break
      }
    }
  }

  // ------------------------------------------------------------------
  // Step 4: Iterate top-level children and detect sections
  // ------------------------------------------------------------------
  const sections: ExtractedSection[] = []
  const processedElements = new Set<any>()
  let position = 0
  const remainingParts: string[] = []

  $container.children().each((_, el) => {
    const $el = $(el)
    const tag = ($el.prop('tagName') || '').toLowerCase()

    // Skip script, style, link, meta, noscript
    if (['script', 'style', 'link', 'meta', 'noscript', 'svg'].includes(tag)) return

    // Skip empty or whitespace-only elements
    const rawHtml = outerHtml($, $el)
    if (!rawHtml.trim() || extractText($el).length === 0 && $el.find('img, video, iframe').length === 0) {
      return
    }

    // Skip elements already extracted as header/footer
    if (processedElements.has(el)) return

    // Run detection pipeline
    let bestResult: DetectionResult | null = null

    for (const detector of contentDetectors) {
      const result = detector($, $el, opts)
      if (result && result.confidence >= opts.minConfidence) {
        if (!bestResult || result.confidence > bestResult.confidence) {
          bestResult = result
        }
      }
    }

    if (bestResult) {
      const section: ExtractedSection = {
        sectionType: bestResult.sectionType,
        sectionKey: generateSectionKey(bestResult.sectionType),
        position: position++,
        settings: bestResult.settings,
        originalHtml: rawHtml,
        confidence: bestResult.confidence,
      }
      if (bestResult.blocks && bestResult.blocks.length > 0) {
        section.blocks = bestResult.blocks
      }
      sections.push(section)
    } else if (opts.wrapUnmatched) {
      // Wrap as custom-html
      sections.push({
        sectionType: 'custom-html',
        sectionKey: generateSectionKey('custom-html'),
        position: position++,
        settings: {
          html: rawHtml,
        },
        originalHtml: rawHtml,
        confidence: 0,
      })
    } else {
      remainingParts.push(rawHtml)
    }
  })

  // ------------------------------------------------------------------
  // Step 5: Handle case where container has no useful children
  //         (e.g. flat HTML without wrapper divs)
  // ------------------------------------------------------------------
  if (sections.length === 0 && !headerHtml && !footerHtml) {
    const bodyHtml = $container.html()?.trim() || ''
    if (bodyHtml && opts.wrapUnmatched) {
      sections.push({
        sectionType: 'custom-html',
        sectionKey: generateSectionKey('custom-html'),
        position: 0,
        settings: { html: bodyHtml },
        originalHtml: bodyHtml,
        confidence: 0,
      })
      warnings.push('No structured sections detected. Entire content wrapped as custom-html.')
    }
  }

  // Add warnings for low-confidence detections
  for (const section of sections) {
    if (section.confidence > 0 && section.confidence < 50) {
      warnings.push(
        `Section "${section.sectionKey}" (${section.sectionType}) detected with low confidence (${section.confidence}%). Review recommended.`,
      )
    }
  }

  return {
    sections,
    headerHtml,
    footerHtml,
    remainingHtml: remainingParts.join('\n'),
    warnings,
  }
}
