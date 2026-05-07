/**
 * Clone Pro — Blog Post Scraper
 *
 * Scrapes blog posts from e-commerce websites.
 * Extracts title, body HTML, excerpt, author, tags, image, and published date.
 *
 * Works with any platform:
 * - Shopify blogs
 * - WordPress/WooCommerce posts
 * - Generic blog layouts
 */

import * as cheerio from 'cheerio'
import { safeFetch } from '../../clone-shopify/safe-fetch.js'
import type { CloneSitemapNode } from '../../clone-shopify/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapedBlogPost {
  readonly url: string
  readonly title: string
  readonly slug: string
  readonly body_html: string
  readonly excerpt: string | null
  readonly author: string | null
  readonly image_url: string | null
  readonly tags: string[]
  readonly published_at: string | null
}

// ---------------------------------------------------------------------------
// Slug extraction
// ---------------------------------------------------------------------------

function extractSlug(url: string): string {
  const path = new URL(url).pathname
  const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  // Last segment: /blog/my-post-title → my-post-title
  return segments[segments.length - 1]?.replace(/\.[^.]+$/, '') || 'post'
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function resolveUrl(href: string, baseUrl: string): string {
  try {
    if (!href) return ''
    return new URL(href, baseUrl).href
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// HTML cleaning for blog content
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
  '.sidebar',
  '.comments',
  '.comment-section',
  '#comments',
  '.related-posts',
  '.share-buttons',
  '.social-share',
  '.author-bio',
  '.post-navigation',
  '.pagination',
  '.breadcrumb',
  '.breadcrumbs',
  '.newsletter',
  '.newsletter-signup',
  '.cookie-banner',
  '.cookie-consent',
  '.popup',
  '.modal',
  '.advertisement',
  '.ad',
  '.ads',
  '[data-tracking]',
  '[data-analytics]',
]

function cleanHtml($: cheerio.CheerioAPI, $content: cheerio.Cheerio<any>): string {
  const $clone = $content.clone()

  for (const sel of REMOVE_SELECTORS) {
    $clone.find(sel).remove()
  }

  // Remove event handler attributes
  $clone.find('*').each((_, el) => {
    const attribs = (el as any).attribs || {}
    for (const attr of Object.keys(attribs)) {
      if (attr.startsWith('on') || attr.startsWith('data-track')) {
        $(el).removeAttr(attr)
      }
    }
  })

  return ($clone.html() || '').trim()
}

// ---------------------------------------------------------------------------
// Content area detection for blog posts
// ---------------------------------------------------------------------------

const BLOG_CONTENT_SELECTORS = [
  'article .entry-content',   // WordPress
  'article .post-content',
  'article .article-content',
  '.blog-post__content',      // Generic
  '.post-body',
  '.article-body',
  '.entry-content',
  '.post-content',
  '.article-content',
  '.blog-content',
  'article .rte',             // Shopify
  '.shopify-section article',
  'article',
  'main',
  '[role="main"]',
  '.page-content',
  '#content',
]

function findBlogContent($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  for (const selector of BLOG_CONTENT_SELECTORS) {
    const $el = $(selector).first()
    if ($el.length > 0 && $el.text().trim().length > 100) {
      return $el
    }
  }
  return $('body')
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

const TAG_SELECTORS = [
  '.tags a',
  '.post-tags a',
  '.article-tags a',
  '.tag-list a',
  '.entry-tags a',
  '[rel="tag"]',
  '.blog-tags a',
  'a[href*="/tagged/"]',     // Shopify
  'a[href*="/tag/"]',        // WordPress
]

function extractTags($: cheerio.CheerioAPI): string[] {
  const tags: string[] = []
  const seen = new Set<string>()

  for (const selector of TAG_SELECTORS) {
    $(selector).each((_, el) => {
      const tag = $(el).text().trim().toLowerCase()
      if (tag && tag.length < 60 && !seen.has(tag)) {
        seen.add(tag)
        tags.push(tag)
      }
    })
    if (tags.length > 0) break
  }

  return tags
}

// ---------------------------------------------------------------------------
// Featured image detection
// ---------------------------------------------------------------------------

const FEATURED_IMAGE_SELECTORS = [
  'meta[property="og:image"]',
  '.post-image img',
  '.article-image img',
  '.featured-image img',
  '.blog-post__image img',
  'article img',
  '.entry-content img',
]

function findFeaturedImage($: cheerio.CheerioAPI, baseUrl: string): string | null {
  // Try OG image first
  const ogImage = $('meta[property="og:image"]').attr('content')?.trim()
  if (ogImage) return resolveUrl(ogImage, baseUrl)

  // Try specific featured image selectors
  for (const selector of FEATURED_IMAGE_SELECTORS) {
    if (selector.includes('meta[')) continue // already handled
    const $img = $(selector).first()
    if ($img.length > 0) {
      const src = $img.attr('src') || $img.attr('data-src')
      if (src) return resolveUrl(src, baseUrl)
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Scrape a single blog post
// ---------------------------------------------------------------------------

async function scrapeSinglePost(url: string, baseUrl: string): Promise<ScrapedBlogPost | null> {
  try {
    const resp = await safeFetch(url, {
      timeoutMs: 15_000,
      maxBytes: 5 * 1024 * 1024,
    })

    const html = resp.body.toString('utf-8')
    const $ = cheerio.load(html)

    // --- Title ---
    const title =
      $('h1').first().text().trim() ||
      $('title').text().trim().split(/[|–—-]/).shift()?.trim() ||
      'Untitled Post'

    // --- Author ---
    const author =
      $('meta[name="author"]').attr('content')?.trim() ||
      $('[rel="author"]').first().text().trim() ||
      $('[class*="author-name"]').first().text().trim() ||
      $('[class*="author"] a').first().text().trim() ||
      $('.byline a').first().text().trim() ||
      null

    // --- Published date ---
    const published_at =
      $('meta[property="article:published_time"]').attr('content')?.trim() ||
      $('time[datetime]').first().attr('datetime')?.trim() ||
      $('meta[name="date"]').attr('content')?.trim() ||
      $('[class*="date"]').first().text().trim() ||
      null

    // --- Content ---
    const $content = findBlogContent($)
    const body_html = cleanHtml($, $content)

    // --- Excerpt ---
    const excerpt =
      $('meta[property="og:description"]').attr('content')?.trim() ||
      $('meta[name="description"]').attr('content')?.trim() ||
      // Take first 200 chars of content text
      $content.text().trim().slice(0, 200).replace(/\s+/g, ' ').trim() ||
      null

    // --- Tags ---
    const tags = extractTags($)

    // --- Featured image ---
    const image_url = findFeaturedImage($, baseUrl)

    return {
      url,
      title,
      slug: extractSlug(url),
      body_html,
      excerpt: excerpt && excerpt.length > 0 ? excerpt : null,
      author: author && author.length > 0 ? author : null,
      image_url,
      tags,
      published_at: published_at && published_at.length > 0 ? published_at : null,
    }
  } catch (err) {
    console.warn(`[blog-scraper] Failed to scrape ${url}:`, (err as Error).message)
    return null
  }
}

// ---------------------------------------------------------------------------
// Blog listing page — detect individual post URLs
// ---------------------------------------------------------------------------

const BLOG_POST_LINK_SELECTORS = [
  // Shopify
  'a[href*="/blogs/"]',
  '.article-card a',
  // WordPress
  '.post a[href*="/20"]',  // WordPress date-based permalinks
  'article a',
  'h2 a',
  'h3 a',
  // Generic
  '.blog-post a',
  '.blog-card a',
  '.post-item a',
  '.blog-listing a',
]

/**
 * Discover blog post URLs from a blog listing/index page.
 */
export async function discoverBlogPostUrls(
  blogIndexUrl: string,
  baseUrl: string,
): Promise<string[]> {
  try {
    const resp = await safeFetch(blogIndexUrl, {
      timeoutMs: 15_000,
      maxBytes: 5 * 1024 * 1024,
    })

    const html = resp.body.toString('utf-8')
    const $ = cheerio.load(html)
    const urls: string[] = []
    const seen = new Set<string>()

    for (const selector of BLOG_POST_LINK_SELECTORS) {
      $(selector).each((_, el) => {
        const href = $(el).attr('href')
        if (!href) return
        const resolved = resolveUrl(href, baseUrl)
        if (!resolved || seen.has(resolved)) return

        // Must be same domain
        try {
          if (new URL(resolved).hostname !== new URL(baseUrl).hostname) return
        } catch {
          return
        }

        // Skip obvious non-post URLs
        const path = new URL(resolved).pathname.toLowerCase()
        if (
          path === '/' ||
          path === '/blog' ||
          path === '/blog/' ||
          path.includes('/cart') ||
          path.includes('/account') ||
          path.includes('/collection') ||
          path.includes('/product')
        ) return

        seen.add(resolved)
        urls.push(resolved)
      })

      if (urls.length > 0) break
    }

    return urls
  } catch (err) {
    console.warn(`[blog-scraper] Failed to discover posts from ${blogIndexUrl}:`, (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape blog posts from sitemap nodes.
 * Filters to 'blog' kind nodes, discovers post URLs from listing pages,
 * then scrapes each individual post.
 *
 * @param sitemapNodes - All sitemap nodes from walkSitemap()
 * @param baseUrl - The website's base URL
 * @param options.concurrency - Max concurrent requests (default: 3)
 * @param options.maxPosts - Max posts to scrape (default: 50)
 * @returns Array of scraped blog posts
 */
export async function scrapeBlogPosts(
  sitemapNodes: readonly CloneSitemapNode[],
  baseUrl: string,
  options?: { concurrency?: number; maxPosts?: number },
): Promise<ScrapedBlogPost[]> {
  const maxPosts = options?.maxPosts ?? 50
  const concurrency = options?.concurrency ?? 3

  // Collect all blog URLs from sitemap
  const blogNodes = sitemapNodes.filter((n) => n.kind === 'blog')

  // Separate listing pages (shorter paths) from individual posts (longer paths)
  const postUrls: string[] = []
  const listingUrls: string[] = []

  for (const node of blogNodes) {
    const path = new URL(node.url).pathname
    const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    // Short paths like /blog or /blogs/news are listing pages
    // Longer paths like /blogs/news/my-post are individual posts
    if (segments.length <= 2) {
      listingUrls.push(node.url)
    } else {
      postUrls.push(node.url)
    }
  }

  // If we have listing URLs but no post URLs, discover posts from listings
  if (postUrls.length === 0 && listingUrls.length > 0) {
    for (const listingUrl of listingUrls.slice(0, 5)) {
      const discovered = await discoverBlogPostUrls(listingUrl, baseUrl)
      postUrls.push(...discovered)
      if (postUrls.length >= maxPosts) break
    }
  }

  // Cap at maxPosts
  const urlsToScrape = postUrls.slice(0, maxPosts)
  if (urlsToScrape.length === 0) return []

  // Scrape each post
  const results: ScrapedBlogPost[] = []
  const queue = [...urlsToScrape]

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift()
      if (!url) break
      const post = await scrapeSinglePost(url, baseUrl)
      if (post) {
        results.push(post)
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
  await Promise.all(workers)

  return results
}

/**
 * Scrape blog posts from a list of URLs directly.
 */
export async function scrapeBlogPostUrls(
  urls: string[],
  baseUrl: string,
  options?: { concurrency?: number },
): Promise<ScrapedBlogPost[]> {
  const concurrency = options?.concurrency ?? 3
  const results: ScrapedBlogPost[] = []
  const queue = [...urls]

  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift()
      if (!url) break
      const post = await scrapeSinglePost(url, baseUrl)
      if (post) {
        results.push(post)
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
  await Promise.all(workers)

  return results
}
