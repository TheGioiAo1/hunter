/**
 * Clone Pro v4 — Phase 1.4: Template Detector
 *
 * Analyzes crawled pages to detect which template types are present
 * in the source site and selects the best sample page for each template.
 *
 * Given an array of DiscoveredPage objects from the deep crawler, this module:
 *   1. Groups pages by their pageType
 *   2. Scores each page as a template candidate using cheerio-based
 *      structural analysis (content richness, depth, semantic elements)
 *   3. Detects structural variants within the same page type
 *   4. Returns a TemplateDetectionResult with the best sample for each type
 *
 * Usage:
 *   import { detectTemplates } from './template-detector.js'
 *   const result = detectTemplates(crawledPages)
 *   // result.templates[0].samplePage  ← best page for templatization
 */

import * as cheerio from 'cheerio'
import type { DiscoveredPage, PageType } from './deep-crawler.js'

// Re-export for convenience
export type { DiscoveredPage, PageType }

// Page types: 'home' | 'product' | 'collection' | 'list-collections' | 'page'
// | 'blog' | 'blog-post' | 'cart' | 'search' | 'account' | 'login'
// | 'register' | 'policy' | 'password' | '404' | 'other'

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

/** Overall result of template detection across all crawled pages. */
export interface TemplateDetectionResult {
  /** One entry per detected page type (sorted by count descending). */
  templates: DetectedTemplate[]
  /** How many distinct template types were found. */
  totalTemplateTypes: number
  /** Warnings about missing or problematic templates. */
  warnings: string[]
}

/** A single detected template type and its best sample page. */
export interface DetectedTemplate {
  /** The page type identifier (e.g. 'product', 'collection'). */
  pageType: string
  /** Mapped Liquid template path (e.g. 'templates/product.liquid'). */
  templateName: string
  /** The highest-scoring candidate — use this for templatization. */
  samplePage: TemplateCandidate
  /** Every page of this type, scored and sorted descending. */
  allCandidates: TemplateCandidate[]
  /** How many pages use this template. */
  count: number
  /** True if pages of this type have significantly different structures. */
  hasVariants: boolean
}

/** A single page evaluated as a potential template sample. */
export interface TemplateCandidate {
  /** Full URL of the page. */
  url: string
  /** Page title (from <title> or meta). */
  title: string
  /** Raw HTML of the page. */
  html: string
  /** Candidate quality score (higher = better). */
  score: number
  /** Human-readable explanation of the score. */
  reason: string
}

// ---------------------------------------------------------------------------
// pageType → Liquid template name mapping
// ---------------------------------------------------------------------------

const PAGE_TYPE_TO_TEMPLATE: Record<PageType, string> = {
  'home': 'templates/index.liquid',
  'product': 'templates/product.liquid',
  'collection': 'templates/collection.liquid',
  'list-collections': 'templates/list-collections.liquid',
  'page': 'templates/page.liquid',
  'blog': 'templates/blog.liquid',
  'blog-post': 'templates/article.liquid',
  'cart': 'templates/cart.liquid',
  'search': 'templates/search.liquid',
  'account': 'templates/customers/account.liquid',
  'login': 'templates/customers/login.liquid',
  'register': 'templates/customers/register.liquid',
  'policy': 'templates/page.policy.liquid',
  'password': 'templates/password.liquid',
  '404': 'templates/404.liquid',
  'other': 'templates/page.liquid',
}

/**
 * Page types that are commonly expected in a well-structured store.
 * Missing any of these generates a warning.
 */
const EXPECTED_PAGE_TYPES: readonly PageType[] = [
  'home',
  'product',
  'collection',
  'page',
  'cart',
]

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Analyze crawled pages and detect which template types are present.
 *
 * Groups all pages by type, scores each one as a template candidate,
 * picks the best sample for each type, and detects structural variants.
 *
 * @param pages - Array of pages from the deep crawler
 * @returns Detection result with templates, counts, and warnings
 */
export function detectTemplates(pages: DiscoveredPage[]): TemplateDetectionResult {
  const warnings: string[] = []

  // Filter to only successful pages (2xx status codes)
  const validPages = pages.filter((p) => p.statusCode >= 200 && p.statusCode < 300)

  if (validPages.length === 0) {
    return { templates: [], totalTemplateTypes: 0, warnings: ['No valid pages (2xx) found in crawl results'] }
  }

  // Group pages by pageType
  const grouped = groupByPageType(validPages)

  // Build DetectedTemplate for each group
  const templates: DetectedTemplate[] = []

  for (const [pageType, groupPages] of grouped.entries()) {
    const candidates = groupPages
      .map((page) => scoreCandidate(page, pageType))
      .sort((a, b) => b.score - a.score)

    const hasVariants = detectVariants(groupPages)

    templates.push({
      pageType,
      templateName: PAGE_TYPE_TO_TEMPLATE[pageType as PageType] ?? 'templates/page.liquid',
      samplePage: candidates[0],
      allCandidates: candidates,
      count: candidates.length,
      hasVariants,
    })
  }

  // Sort by count descending so the most common template types come first
  templates.sort((a, b) => b.count - a.count)

  // Generate warnings for missing expected types
  for (const expected of EXPECTED_PAGE_TYPES) {
    if (!grouped.has(expected)) {
      warnings.push(`No ${expected} pages found`)
    }
  }

  // Warn on variant detection
  for (const tpl of templates) {
    if (tpl.hasVariants) {
      warnings.push(
        `"${tpl.pageType}" pages have structural variants — the generated template may not fit all pages`,
      )
    }
  }

  return {
    templates,
    totalTemplateTypes: templates.length,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group pages into a Map keyed by pageType.
 *
 * @param pages - Valid (2xx) discovered pages
 * @returns Map of pageType to pages
 */
function groupByPageType(pages: DiscoveredPage[]): Map<string, DiscoveredPage[]> {
  const map = new Map<string, DiscoveredPage[]>()
  for (const page of pages) {
    const existing = map.get(page.pageType)
    if (existing) {
      existing.push(page)
    } else {
      map.set(page.pageType, [page])
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Candidate Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single page as a template candidate.
 *
 * Scoring factors:
 *   - Content length (longer body = richer template to extract)
 *   - Crawl depth (1-2 preferred over deep pages)
 *   - Structural richness (semantic elements matching the page type)
 *   - Penalty for edge-case signals (sold-out, empty, error markers)
 *
 * @param page - The discovered page to score
 * @param pageType - The type of page (used to pick structural checks)
 * @returns A TemplateCandidate with score and explanation
 */
function scoreCandidate(page: DiscoveredPage, pageType: string): TemplateCandidate {
  const reasons: string[] = []
  let score = 0

  const $ = cheerio.load(page.html)

  // --- Content length score (0–25 pts) ---
  const bodyHtml = $('body').html() ?? ''
  const bodyLength = bodyHtml.length
  if (bodyLength > 20_000) {
    score += 25
    reasons.push('rich content (>20k chars)')
  } else if (bodyLength > 10_000) {
    score += 20
    reasons.push('good content (>10k chars)')
  } else if (bodyLength > 5_000) {
    score += 15
    reasons.push('moderate content (>5k chars)')
  } else if (bodyLength > 1_000) {
    score += 8
    reasons.push('light content (>1k chars)')
  } else {
    score += 2
    reasons.push('very little content (<1k chars)')
  }

  // --- Depth score (0–15 pts) ---
  if (page.depth === 1) {
    score += 15
    reasons.push('depth 1 (top-level page)')
  } else if (page.depth === 2) {
    score += 12
    reasons.push('depth 2')
  } else if (page.depth === 0) {
    score += 10
    reasons.push('depth 0 (homepage-level)')
  } else if (page.depth === 3) {
    score += 7
    reasons.push('depth 3')
  } else {
    score += 3
    reasons.push(`deep page (depth ${page.depth})`)
  }

  // --- Structural richness score (0–40 pts, type-specific) ---
  const structScore = scoreStructure($, pageType as PageType)
  score += structScore.points
  reasons.push(...structScore.reasons)

  // --- Edge-case penalties (negative points) ---
  const penalties = detectEdgeCasePenalties($, pageType as PageType)
  score += penalties.points // negative
  if (penalties.reasons.length > 0) {
    reasons.push(...penalties.reasons)
  }

  // --- Title presence bonus (0–5 pts) ---
  if (page.title && page.title.trim().length > 0) {
    score += 5
    reasons.push('has title')
  }

  // --- Outlinks bonus (0–5 pts) — pages with outlinks are more "connected" ---
  if (page.outLinks.length > 5) {
    score += 5
    reasons.push('well-connected (>5 outlinks)')
  } else if (page.outLinks.length > 0) {
    score += 3
    reasons.push('has outlinks')
  }

  // --- Images bonus (0–5 pts) ---
  const imgCount = $('img').length
  if (imgCount >= 3) {
    score += 5
    reasons.push(`has ${imgCount} images`)
  } else if (imgCount > 0) {
    score += 2
    reasons.push(`has ${imgCount} image(s)`)
  }

  return {
    url: page.url,
    title: page.title,
    html: page.html,
    score: Math.max(0, score),
    reason: reasons.join('; '),
  }
}

// ---------------------------------------------------------------------------
// Type-Specific Structural Scoring
// ---------------------------------------------------------------------------

interface StructScoreResult {
  points: number
  reasons: string[]
}

/**
 * Score structural richness based on page type.
 *
 * Uses cheerio to look for semantic elements that are typical for each
 * page type (e.g. price elements on product pages, grids on collections).
 *
 * @param $ - Cheerio instance loaded with the page HTML
 * @param pageType - The page type to score for
 * @returns Points (0–40) and reasons
 */
function scoreStructure($: cheerio.CheerioAPI, pageType: PageType): StructScoreResult {
  switch (pageType) {
    case 'product':
      return scoreProductStructure($)
    case 'collection':
      return scoreCollectionStructure($)
    case 'blog':
      return scoreBlogStructure($)
    case 'blog-post':
      return scoreBlogPostStructure($)
    case 'home':
      return scoreHomeStructure($)
    case 'page':
      return scoreGenericPageStructure($)
    case 'cart':
      return scoreCartStructure($)
    case 'search':
      return scoreSearchStructure($)
    default:
      return scoreDefaultStructure($)
  }
}

/**
 * Product page: look for price, images, add-to-cart, description.
 */
function scoreProductStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Price elements
  const priceSelectors = [
    '[class*="price"]', '[data-price]', '[id*="price"]',
    '.product-price', '.price', '.money',
    '[class*="Price"]', '[data-product-price]',
  ]
  if (matchesAny($, priceSelectors)) {
    points += 10
    reasons.push('has price element')
  }

  // Product images / gallery
  const imageSelectors = [
    '[class*="product-image"]', '[class*="product-gallery"]',
    '[class*="ProductImage"]', '[data-product-media]',
    '.product__media', '[class*="gallery"]',
    '[class*="product-photo"]', '[class*="product-img"]',
  ]
  if (matchesAny($, imageSelectors)) {
    points += 10
    reasons.push('has product image/gallery')
  }

  // Add-to-cart button
  const cartSelectors = [
    '[class*="add-to-cart"]', '[data-add-to-cart]',
    'button[name="add"]', '[id*="add-to-cart"]',
    '[class*="AddToCart"]', 'form[action*="/cart/add"]',
    '[class*="add_to_cart"]', 'button[type="submit"][class*="cart"]',
  ]
  if (matchesAny($, cartSelectors)) {
    points += 10
    reasons.push('has add-to-cart button')
  }

  // Product description
  const descSelectors = [
    '[class*="product-description"]', '[class*="product__description"]',
    '[class*="ProductDescription"]', '[data-product-description]',
    '.product-description', '[id*="product-description"]',
  ]
  if (matchesAny($, descSelectors)) {
    points += 5
    reasons.push('has product description')
  }

  // Variant selector (size, color, etc.)
  const variantSelectors = [
    '[class*="variant"]', 'select[name*="option"]',
    '[data-option-index]', '[class*="swatch"]',
    '[class*="option-selector"]',
  ]
  if (matchesAny($, variantSelectors)) {
    points += 5
    reasons.push('has variant selector')
  }

  return { points: Math.min(40, points), reasons }
}

/**
 * Collection page: look for product grids, filters, pagination.
 */
function scoreCollectionStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Product grid / list
  const gridSelectors = [
    '[class*="product-grid"]', '[class*="product-list"]',
    '[class*="collection-products"]', '[class*="ProductGrid"]',
    '[class*="products-grid"]', '[data-collection-products]',
    '.grid--products', '[class*="product-card"]',
  ]
  if (matchesAny($, gridSelectors)) {
    points += 12
    reasons.push('has product grid/list')
  }

  // Filter sidebar
  const filterSelectors = [
    '[class*="filter"]', '[class*="facet"]',
    '[data-filter]', '[class*="sidebar"]',
    '[class*="refinement"]', '[class*="Filter"]',
  ]
  if (matchesAny($, filterSelectors)) {
    points += 10
    reasons.push('has filter/facet sidebar')
  }

  // Pagination
  const paginationSelectors = [
    '[class*="pagination"]', '.pagination',
    'nav[aria-label*="pagination"]', '[class*="Pagination"]',
    '[class*="page-numbers"]', '.paginate',
  ]
  if (matchesAny($, paginationSelectors)) {
    points += 8
    reasons.push('has pagination')
  }

  // Sort dropdown
  const sortSelectors = [
    '[class*="sort"]', 'select[name*="sort"]',
    '[data-sort-by]', '[class*="Sort"]',
  ]
  if (matchesAny($, sortSelectors)) {
    points += 5
    reasons.push('has sort control')
  }

  // Multiple product links (indicates a real collection, not an empty one)
  const productLinks = $('a[href*="/products/"]').length + $('a[href*="/product/"]').length
  if (productLinks >= 4) {
    points += 5
    reasons.push(`links to ${productLinks} products`)
  }

  return { points: Math.min(40, points), reasons }
}

/**
 * Blog index: look for article lists, post dates, author info.
 */
function scoreBlogStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Article list / cards
  const articleSelectors = [
    'article', '[class*="article"]', '[class*="blog-post"]',
    '[class*="post-card"]', '[class*="blog-item"]',
    '[class*="ArticleCard"]', '[class*="blog-listing"]',
  ]
  const articleCount = countMatches($, articleSelectors)
  if (articleCount >= 3) {
    points += 15
    reasons.push(`has ${articleCount} article elements`)
  } else if (articleCount > 0) {
    points += 8
    reasons.push(`has ${articleCount} article element(s)`)
  }

  // Date elements
  const dateSelectors = [
    'time', '[class*="date"]', '[class*="Date"]',
    '[datetime]', '[class*="published"]',
  ]
  if (matchesAny($, dateSelectors)) {
    points += 8
    reasons.push('has date elements')
  }

  // Pagination
  if (matchesAny($, ['[class*="pagination"]', '.pagination', '.paginate'])) {
    points += 7
    reasons.push('has pagination')
  }

  // Tags / categories
  const tagSelectors = [
    '[class*="tag"]', '[class*="category"]',
    '[class*="Tag"]', '[class*="Category"]',
  ]
  if (matchesAny($, tagSelectors)) {
    points += 5
    reasons.push('has tags/categories')
  }

  return { points: Math.min(40, points), reasons }
}

/**
 * Blog post / article: look for article body, author, date, comments.
 */
function scoreBlogPostStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Article body
  const bodySelectors = [
    'article', '[class*="article-content"]', '[class*="post-content"]',
    '[class*="entry-content"]', '[class*="blog-post__content"]',
    '[class*="rte"]', '[class*="ArticleContent"]',
  ]
  if (matchesAny($, bodySelectors)) {
    points += 12
    reasons.push('has article body')
  }

  // Author info
  const authorSelectors = [
    '[class*="author"]', '[rel="author"]',
    '[class*="Author"]', '[class*="byline"]',
  ]
  if (matchesAny($, authorSelectors)) {
    points += 8
    reasons.push('has author info')
  }

  // Date
  if (matchesAny($, ['time', '[datetime]', '[class*="date"]', '[class*="published"]'])) {
    points += 7
    reasons.push('has publish date')
  }

  // Comments section
  const commentSelectors = [
    '[class*="comment"]', '[id*="comment"]',
    '[class*="Comment"]', '#disqus_thread',
  ]
  if (matchesAny($, commentSelectors)) {
    points += 5
    reasons.push('has comments section')
  }

  // Share buttons
  const shareSelectors = [
    '[class*="share"]', '[class*="social"]',
    '[class*="Share"]', '[class*="Social"]',
  ]
  if (matchesAny($, shareSelectors)) {
    points += 3
    reasons.push('has share buttons')
  }

  return { points: Math.min(40, points), reasons }
}

/**
 * Homepage: look for hero, featured products, sections, slider.
 */
function scoreHomeStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Hero / banner
  const heroSelectors = [
    '[class*="hero"]', '[class*="banner"]', '[class*="slideshow"]',
    '[class*="Hero"]', '[class*="Banner"]', '[class*="carousel"]',
    '[class*="slider"]', '[class*="Slider"]',
  ]
  if (matchesAny($, heroSelectors)) {
    points += 10
    reasons.push('has hero/banner section')
  }

  // Featured products / collections
  const featuredSelectors = [
    '[class*="featured"]', '[class*="Featured"]',
    '[class*="best-seller"]', '[class*="new-arrival"]',
    '[class*="product-card"]', '[class*="collection-card"]',
  ]
  if (matchesAny($, featuredSelectors)) {
    points += 10
    reasons.push('has featured content')
  }

  // Multiple distinct sections
  const sections = $('section').length + $('[class*="section"]').length
  if (sections >= 4) {
    points += 10
    reasons.push(`has ${sections} sections`)
  } else if (sections >= 2) {
    points += 5
    reasons.push(`has ${sections} section(s)`)
  }

  // Newsletter / signup
  const newsletterSelectors = [
    '[class*="newsletter"]', '[class*="subscribe"]',
    '[class*="Newsletter"]', '[class*="signup"]',
  ]
  if (matchesAny($, newsletterSelectors)) {
    points += 5
    reasons.push('has newsletter section')
  }

  // Testimonials / reviews
  const testimonialSelectors = [
    '[class*="testimonial"]', '[class*="review"]',
    '[class*="Testimonial"]', '[class*="Review"]',
  ]
  if (matchesAny($, testimonialSelectors)) {
    points += 5
    reasons.push('has testimonials/reviews')
  }

  return { points: Math.min(40, points), reasons }
}

/**
 * Generic static page: look for rich text content, headings, images.
 */
function scoreGenericPageStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Rich text area
  const rteSelectors = [
    '[class*="rte"]', '[class*="page-content"]',
    '[class*="entry-content"]', '[class*="content"]',
    'article', 'main',
  ]
  if (matchesAny($, rteSelectors)) {
    points += 12
    reasons.push('has content area')
  }

  // Headings (h1–h3)
  const headingCount = $('h1, h2, h3').length
  if (headingCount >= 3) {
    points += 10
    reasons.push(`has ${headingCount} headings`)
  } else if (headingCount > 0) {
    points += 5
    reasons.push(`has ${headingCount} heading(s)`)
  }

  // Paragraphs
  const pCount = $('p').length
  if (pCount >= 5) {
    points += 10
    reasons.push(`has ${pCount} paragraphs`)
  } else if (pCount > 0) {
    points += 5
    reasons.push(`has ${pCount} paragraph(s)`)
  }

  // Images within content
  const contentImages = $('main img, article img, [class*="content"] img').length
  if (contentImages >= 2) {
    points += 8
    reasons.push(`has ${contentImages} content images`)
  }

  return { points: Math.min(40, points), reasons }
}

/**
 * Cart page: look for line items, totals, checkout button.
 */
function scoreCartStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Cart table / items
  const cartItemSelectors = [
    '[class*="cart-item"]', '[class*="cart__item"]',
    '[class*="line-item"]', '[data-cart-item]',
    '[class*="CartItem"]', 'table[class*="cart"]',
  ]
  if (matchesAny($, cartItemSelectors)) {
    points += 12
    reasons.push('has cart items')
  }

  // Cart totals
  const totalSelectors = [
    '[class*="cart-total"]', '[class*="cart__total"]',
    '[class*="subtotal"]', '[data-cart-subtotal]',
    '[class*="CartTotal"]',
  ]
  if (matchesAny($, totalSelectors)) {
    points += 10
    reasons.push('has cart totals')
  }

  // Checkout button
  const checkoutSelectors = [
    '[class*="checkout"]', '[name="checkout"]',
    'a[href*="checkout"]', 'button[class*="checkout"]',
    '[class*="Checkout"]',
  ]
  if (matchesAny($, checkoutSelectors)) {
    points += 10
    reasons.push('has checkout button')
  }

  // Quantity controls
  const qtySelectors = [
    '[class*="quantity"]', 'input[name*="quantity"]',
    '[data-quantity]', '[class*="qty"]',
  ]
  if (matchesAny($, qtySelectors)) {
    points += 8
    reasons.push('has quantity controls')
  }

  return { points: Math.min(40, points), reasons }
}

/**
 * Search page: look for search input, results container.
 */
function scoreSearchStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Search input
  const inputSelectors = [
    'input[type="search"]', 'input[name*="q"]',
    '[class*="search-input"]', '[class*="search__input"]',
  ]
  if (matchesAny($, inputSelectors)) {
    points += 15
    reasons.push('has search input')
  }

  // Results container
  const resultSelectors = [
    '[class*="search-result"]', '[class*="search__result"]',
    '[class*="SearchResult"]', '[data-search-results]',
  ]
  if (matchesAny($, resultSelectors)) {
    points += 15
    reasons.push('has search results container')
  }

  // Result count / status
  const countSelectors = [
    '[class*="result-count"]', '[class*="results-count"]',
    '[class*="search-count"]',
  ]
  if (matchesAny($, countSelectors)) {
    points += 5
    reasons.push('has result count')
  }

  // Pagination
  if (matchesAny($, ['[class*="pagination"]', '.pagination'])) {
    points += 5
    reasons.push('has pagination')
  }

  return { points: Math.min(40, points), reasons }
}

/**
 * Fallback scoring for page types without specific structural checks
 * (account, login, register, policy, password, 404, list-collections, other).
 */
function scoreDefaultStructure($: cheerio.CheerioAPI): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Forms (common in account/login/register)
  const formCount = $('form').length
  if (formCount > 0) {
    points += 10
    reasons.push(`has ${formCount} form(s)`)
  }

  // Main content area
  if (matchesAny($, ['main', '[role="main"]', '[class*="content"]'])) {
    points += 10
    reasons.push('has main content area')
  }

  // Headings
  const headings = $('h1, h2').length
  if (headings > 0) {
    points += 5
    reasons.push(`has ${headings} heading(s)`)
  }

  // Meaningful text content
  const textLength = $('body').text().trim().length
  if (textLength > 500) {
    points += 10
    reasons.push('has substantial text content')
  } else if (textLength > 100) {
    points += 5
    reasons.push('has some text content')
  }

  return { points: Math.min(40, points), reasons }
}

// ---------------------------------------------------------------------------
// Edge-Case Penalties
// ---------------------------------------------------------------------------

/**
 * Detect signals that a page is an edge case or low-quality template sample.
 *
 * @param $ - Cheerio instance
 * @param pageType - Current page type
 * @returns Negative points and reasons
 */
function detectEdgeCasePenalties($: cheerio.CheerioAPI, pageType: PageType): StructScoreResult {
  let points = 0
  const reasons: string[] = []

  // Sold-out / unavailable products
  if (pageType === 'product') {
    const soldOutSelectors = [
      '[class*="sold-out"]', '[class*="soldout"]',
      '[class*="out-of-stock"]', '[class*="unavailable"]',
      '[class*="SoldOut"]', '[data-unavailable]',
    ]
    if (matchesAny($, soldOutSelectors)) {
      points -= 15
      reasons.push('PENALTY: sold-out/unavailable product')
    }
  }

  // Empty collection
  if (pageType === 'collection') {
    const emptySelectors = [
      '[class*="empty"]', '[class*="no-products"]',
      '[class*="collection-empty"]',
    ]
    if (matchesAny($, emptySelectors)) {
      points -= 15
      reasons.push('PENALTY: empty collection')
    }
  }

  // Password-protected page
  if (matchesAny($, ['[class*="password"]', 'form[action*="password"]']) && pageType !== 'password') {
    points -= 10
    reasons.push('PENALTY: password-protected page')
  }

  // Very short body (likely error or redirect stub)
  const bodyText = $('body').text().trim()
  if (bodyText.length < 50) {
    points -= 10
    reasons.push('PENALTY: very little text content (<50 chars)')
  }

  // Redirect / meta refresh
  if ($('meta[http-equiv="refresh"]').length > 0) {
    points -= 10
    reasons.push('PENALTY: meta redirect page')
  }

  // "Coming soon" markers
  const bodyLower = bodyText.toLowerCase()
  if (bodyLower.includes('coming soon') || bodyLower.includes('under construction')) {
    points -= 10
    reasons.push('PENALTY: coming-soon / under-construction page')
  }

  return { points, reasons }
}

// ---------------------------------------------------------------------------
// Variant Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether pages of the same type have significantly different structures.
 *
 * Compares the "structural fingerprint" of each page (set of major tag counts
 * and class-name patterns) and flags variants when the difference exceeds
 * a threshold.
 *
 * @param pages - All pages of a single type
 * @returns True if structural variants are detected
 */
function detectVariants(pages: DiscoveredPage[]): boolean {
  if (pages.length < 2) return false

  const fingerprints = pages.map((p) => computeStructuralFingerprint(p.html))

  // Compare each fingerprint against the first one
  const baseline = fingerprints[0]
  const SIMILARITY_THRESHOLD = 0.6 // Below this = variant

  for (let i = 1; i < fingerprints.length; i++) {
    const similarity = computeSimilarity(baseline, fingerprints[i])
    if (similarity < SIMILARITY_THRESHOLD) {
      return true
    }
  }

  return false
}

/** A lightweight structural fingerprint for comparison. */
interface StructuralFingerprint {
  /** Counts of major HTML tags. */
  tagCounts: Record<string, number>
  /** Top class-name prefixes (first 2 segments of hyphenated classes). */
  classPatterns: Set<string>
  /** Number of major sections (section, article, div with semantic classes). */
  sectionCount: number
}

/**
 * Compute a structural fingerprint from raw HTML.
 *
 * @param html - Raw HTML string
 * @returns Fingerprint object
 */
function computeStructuralFingerprint(html: string): StructuralFingerprint {
  const $ = cheerio.load(html)

  // Count major tags
  const majorTags = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'form', 'table']
  const tagCounts: Record<string, number> = {}
  for (const tag of majorTags) {
    const count = $(tag).length
    if (count > 0) {
      tagCounts[tag] = count
    }
  }

  // Collect class-name patterns (first 2 segments of hyphenated class names)
  const classPatterns = new Set<string>()
  $('[class]').each((_, el) => {
    const cls = $(el).attr('class') ?? ''
    for (const name of cls.split(/\s+/)) {
      const parts = name.split(/[-_]/)
      if (parts.length >= 2) {
        classPatterns.add(parts.slice(0, 2).join('-').toLowerCase())
      }
    }
  })

  const sectionCount = $('section').length + $('article').length + $('[class*="section"]').length

  return { tagCounts, classPatterns, sectionCount }
}

/**
 * Compute Jaccard-like similarity between two structural fingerprints.
 *
 * Combines tag-count similarity and class-pattern overlap into a single
 * score between 0 (completely different) and 1 (identical).
 *
 * @param a - First fingerprint
 * @param b - Second fingerprint
 * @returns Similarity score (0–1)
 */
function computeSimilarity(a: StructuralFingerprint, b: StructuralFingerprint): number {
  // Tag count similarity (cosine-ish)
  const allTags = new Set([...Object.keys(a.tagCounts), ...Object.keys(b.tagCounts)])
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (const tag of allTags) {
    const va = a.tagCounts[tag] ?? 0
    const vb = b.tagCounts[tag] ?? 0
    dotProduct += va * vb
    normA += va * va
    normB += vb * vb
  }
  const tagSimilarity = normA === 0 && normB === 0 ? 1 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1)

  // Class pattern Jaccard similarity
  const unionSize = new Set([...a.classPatterns, ...b.classPatterns]).size
  let intersectionSize = 0
  for (const pattern of a.classPatterns) {
    if (b.classPatterns.has(pattern)) intersectionSize++
  }
  const classSimilarity = unionSize === 0 ? 1 : intersectionSize / unionSize

  // Section count similarity
  const maxSections = Math.max(a.sectionCount, b.sectionCount, 1)
  const sectionSimilarity = 1 - Math.abs(a.sectionCount - b.sectionCount) / maxSections

  // Weighted average
  return tagSimilarity * 0.3 + classSimilarity * 0.5 + sectionSimilarity * 0.2
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if any of the given CSS selectors match at least one element.
 *
 * @param $ - Cheerio instance
 * @param selectors - Array of CSS selectors to try
 * @returns True if any selector matches
 */
function matchesAny($: cheerio.CheerioAPI, selectors: string[]): boolean {
  for (const sel of selectors) {
    try {
      if ($(sel).length > 0) return true
    } catch {
      // Invalid selector — skip silently
    }
  }
  return false
}

/**
 * Count total elements matching any of the given selectors (deduplicated).
 *
 * @param $ - Cheerio instance
 * @param selectors - Array of CSS selectors
 * @returns Total unique matching elements
 */
function countMatches($: cheerio.CheerioAPI, selectors: string[]): number {
  const joined = selectors.join(', ')
  try {
    return $(joined).length
  } catch {
    // Fallback: try individually
    let total = 0
    for (const sel of selectors) {
      try {
        total += $(sel).length
      } catch {
        // skip
      }
    }
    return total
  }
}
