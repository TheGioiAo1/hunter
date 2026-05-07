/**
 * Full Asset Downloader — Clone Pro "1:1 Clone" core
 *
 * Parses HTML to discover ALL external asset URLs (images, videos,
 * backgrounds, srcsets, lazy-load attributes) and downloads them
 * with concurrency control. Returns a rewrite map so callers can
 * replace every original URL with a local path.
 *
 * One failed download never blocks the rest — errors are collected
 * in `stats.errors` and the asset is simply skipped.
 */

import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { safeFetch } from '../../clone-shopify/safe-fetch.js'
import * as cheerio from 'cheerio'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DownloadedAsset {
  originalUrl: string
  localPath: string    // e.g., /clone-assets/{shopId}/a1b2c3d4.jpg
  buffer: Buffer
  contentType: string
  size: number
}

export interface AssetDownloadResult {
  assets: DownloadedAsset[]
  rewriteMap: Map<string, string>  // originalUrl → localPath
  stats: {
    found: number
    downloaded: number
    failed: number
    totalBytes: number
    errors: string[]
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENCY = 5
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB
const FETCH_TIMEOUT_MS = 15_000

/** URL patterns that are almost certainly tracking pixels or analytics. */
const TRACKING_PATTERNS: RegExp[] = [
  /\/pixel\b/i,
  /\/beacon\b/i,
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /facebook\.com\/tr/i,
  /facebook\.net/i,
  /doubleclick\.net/i,
  /analytics\./i,
  /hotjar\.com/i,
  /clarity\.ms/i,
  /sentry\.io/i,
  /segment\.com/i,
  /mixpanel\.com/i,
  /stat\.shopify\.com/i,
  /shopify-analytics/i,
]

/** Content-Type → file extension fallback map. */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'application/font-woff': '.woff',
  'application/font-woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/pdf': '.pdf',
}

// ---------------------------------------------------------------------------
// URL discovery helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a raw URL string to an absolute URL, handling:
 *  - already-absolute URLs (https://…)
 *  - protocol-relative (//domain.com/…)
 *  - root-relative (/path/…)
 *  - relative (path/…)
 */
function resolveUrl(raw: string, baseUrl: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Skip non-downloadable URIs
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed === '#' ||
    trimmed.startsWith('#')
  ) {
    return null
  }

  try {
    // protocol-relative → prepend https
    if (trimmed.startsWith('//')) {
      return new URL(`https:${trimmed}`).href
    }
    // absolute
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).href
    }
    // relative (root or path)
    return new URL(trimmed, baseUrl).href
  } catch {
    return null
  }
}

/**
 * Parse a `srcset` attribute value and yield each URL.
 * Format: "url1 100w, url2 200w, url3 2x"
 */
function* parseSrcset(srcset: string): Iterable<string> {
  // Split on commas, but be careful of commas inside URLs (rare but possible)
  const entries = srcset.split(',')
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    // The URL is the first token; the descriptor (100w, 2x) is the second
    const parts = trimmed.split(/\s+/)
    if (parts[0]) {
      yield parts[0]
    }
  }
}

/**
 * Extract URLs from inline CSS `background-image: url(...)` and similar.
 * Handles both `url("...")` and `url(...)` forms.
 */
function* extractUrlsFromCssValue(cssValue: string): Iterable<string> {
  const regex = /url\(\s*['"]?(.*?)['"]?\s*\)/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(cssValue)) !== null) {
    const url = match[1]
    if (url) yield url
  }
}

/**
 * Scan the entire HTML document and collect all unique asset URLs.
 */
function discoverAssetUrls(html: string, baseUrl: string): Set<string> {
  const urls = new Set<string>()
  const $ = cheerio.load(html)

  const addUrl = (raw: string | undefined) => {
    if (!raw) return
    const resolved = resolveUrl(raw, baseUrl)
    if (resolved) urls.add(resolved)
  }

  const addSrcset = (raw: string | undefined) => {
    if (!raw) return
    for (const u of parseSrcset(raw)) {
      addUrl(u)
    }
  }

  // 1. <img src="..."> and <img data-src="...">
  $('img').each((_, el) => {
    const $el = $(el)
    addUrl($el.attr('src'))
    addUrl($el.attr('data-src'))
    addUrl($el.attr('data-original'))
    addUrl($el.attr('data-lazy-src'))
    addSrcset($el.attr('srcset'))
    addSrcset($el.attr('data-srcset'))
  })

  // 2. <source srcset="..."> (inside <picture> or <video>)
  $('source').each((_, el) => {
    const $el = $(el)
    addUrl($el.attr('src'))
    addSrcset($el.attr('srcset'))
    addSrcset($el.attr('data-srcset'))
  })

  // 3. <video poster="..."> and <video src="...">
  $('video').each((_, el) => {
    const $el = $(el)
    addUrl($el.attr('poster'))
    addUrl($el.attr('src'))
    addUrl($el.attr('data-src'))
  })

  // 4. <link rel="icon/apple-touch-icon/shortcut icon" href="...">
  $('link[rel*="icon"]').each((_, el) => {
    addUrl($(el).attr('href'))
  })

  // 5. <link rel="preload" as="image" href="...">
  $('link[rel="preload"][as="image"]').each((_, el) => {
    addUrl($(el).attr('href'))
  })

  // 6. Inline style attributes — background-image: url(...)
  $('[style]').each((_, el) => {
    const style = $(el).attr('style')
    if (style) {
      for (const u of extractUrlsFromCssValue(style)) {
        addUrl(u)
      }
    }
  })

  // 7. data-bg, data-bgset, data-background (lazy-load background plugins)
  $('[data-bg]').each((_, el) => addUrl($(el).attr('data-bg')))
  $('[data-bgset]').each((_, el) => addSrcset($(el).attr('data-bgset')))
  $('[data-background]').each((_, el) => addUrl($(el).attr('data-background')))
  $('[data-background-image]').each((_, el) => addUrl($(el).attr('data-background-image')))

  // 8. Open Graph / Twitter meta images
  $('meta[property="og:image"]').each((_, el) => addUrl($(el).attr('content')))
  $('meta[name="twitter:image"]').each((_, el) => addUrl($(el).attr('content')))

  // 9. <input type="image" src="...">
  $('input[type="image"]').each((_, el) => addUrl($(el).attr('src')))

  // 10. <object data="..."> and <embed src="...">
  $('object[data]').each((_, el) => addUrl($(el).attr('data')))
  $('embed[src]').each((_, el) => addUrl($(el).attr('src')))

  return urls
}

// ---------------------------------------------------------------------------
// File naming helpers
// ---------------------------------------------------------------------------

/** Derive a content-based hash from the buffer (full SHA-256, truncated to 16 hex chars). */
function contentHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

/**
 * Determine the file extension from the URL path or Content-Type header.
 * Falls back to `.bin` if nothing better is available.
 */
function detectExtension(url: string, contentType: string | undefined): string {
  // Try URL path first
  try {
    const pathname = new URL(url).pathname
    const ext = extname(pathname).toLowerCase()
    // Only accept known image/media extensions
    if (ext && /^\.\w{2,5}$/.test(ext) && !ext.includes('php') && !ext.includes('asp')) {
      return ext
    }
  } catch { /* ignore */ }

  // Fall back to Content-Type
  if (contentType) {
    const mime = contentType.split(';')[0]?.trim().toLowerCase()
    if (mime && MIME_TO_EXT[mime]) {
      return MIME_TO_EXT[mime]
    }
  }

  return '.bin'
}

// ---------------------------------------------------------------------------
// Semaphore for concurrency control
// ---------------------------------------------------------------------------

class Semaphore {
  private current = 0
  private queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++
        resolve()
      })
    })
  }

  release(): void {
    this.current--
    const next = this.queue.shift()
    if (next) next()
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Returns true if the URL should be skipped (tracking, analytics, etc.). */
function shouldSkipUrl(url: string, extraPatterns: RegExp[]): boolean {
  const allPatterns = [...TRACKING_PATTERNS, ...extraPatterns]
  for (const pattern of allPatterns) {
    if (pattern.test(url)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Download ALL external assets referenced in the HTML document.
 *
 * @param html       - The full HTML of the page to scan.
 * @param baseUrl    - The page's URL (used to resolve relative paths).
 * @param shopId     - Store identifier for the local path prefix.
 * @param options    - Concurrency, size limits, skip patterns.
 * @returns          - Downloaded assets, rewrite map, and stats.
 */
export async function downloadAllAssets(
  html: string,
  baseUrl: string,
  shopId: string,
  options?: {
    maxConcurrency?: number
    maxFileSize?: number
    skipPatterns?: RegExp[]
  },
): Promise<AssetDownloadResult> {
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
  const maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  const skipPatterns = options?.skipPatterns ?? []

  // 1. Discover all unique asset URLs in the HTML
  const discovered = discoverAssetUrls(html, baseUrl)

  // 2. Filter out tracking / skip patterns
  const urlsToFetch: string[] = []
  for (const url of discovered) {
    if (!shouldSkipUrl(url, skipPatterns)) {
      urlsToFetch.push(url)
    }
  }

  const stats = {
    found: urlsToFetch.length,
    downloaded: 0,
    failed: 0,
    totalBytes: 0,
    errors: [] as string[],
  }

  const assets: DownloadedAsset[] = []
  const rewriteMap = new Map<string, string>()
  const semaphore = new Semaphore(maxConcurrency)

  // 3. Download all assets with concurrency control
  const tasks = urlsToFetch.map(async (url) => {
    await semaphore.acquire()
    try {
      await downloadSingleAsset(url, shopId, maxFileSize, assets, rewriteMap, stats)
    } finally {
      semaphore.release()
    }
  })

  await Promise.allSettled(tasks)

  return { assets, rewriteMap, stats }
}

/**
 * Download a single asset. Errors are caught and recorded in stats —
 * they never propagate to the caller.
 */
async function downloadSingleAsset(
  url: string,
  shopId: string,
  maxFileSize: number,
  assets: DownloadedAsset[],
  rewriteMap: Map<string, string>,
  stats: AssetDownloadResult['stats'],
): Promise<void> {
  try {
    const response = await safeFetch(url, {
      maxBytes: maxFileSize,
      timeoutMs: FETCH_TIMEOUT_MS,
    })

    // Non-2xx → treat as failure
    if (response.statusCode < 200 || response.statusCode >= 300) {
      stats.failed++
      stats.errors.push(`HTTP ${response.statusCode} for ${url}`)
      return
    }

    const { body, headers } = response
    const rawContentType = headers['content-type']
    const contentType = typeof rawContentType === 'string'
      ? rawContentType.split(';')[0]?.trim() ?? 'application/octet-stream'
      : 'application/octet-stream'

    // Skip 1x1 tracking pixel images (body < 200 bytes AND image type)
    if (body.length < 200 && contentType.startsWith('image/')) {
      // Very small images are almost always tracking pixels.
      // However, SVGs can be tiny and legitimate, so allow those.
      if (contentType !== 'image/svg+xml') {
        stats.failed++
        stats.errors.push(`Skipped probable tracking pixel (${body.length} bytes): ${url}`)
        return
      }
    }

    // Skip empty bodies
    if (body.length === 0) {
      stats.failed++
      stats.errors.push(`Empty response body: ${url}`)
      return
    }

    const hash = contentHash(body)
    const ext = detectExtension(url, contentType)
    const localPath = `/clone-assets/${shopId}/${hash}${ext}`

    const asset: DownloadedAsset = {
      originalUrl: url,
      localPath,
      buffer: body,
      contentType,
      size: body.length,
    }

    assets.push(asset)
    rewriteMap.set(url, localPath)

    stats.downloaded++
    stats.totalBytes += body.length
  } catch (err) {
    stats.failed++
    const msg = err instanceof Error ? err.message : String(err)
    stats.errors.push(`Failed to download ${url}: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// HTML rewriting helper
// ---------------------------------------------------------------------------

/**
 * Convenience: apply the rewrite map to the HTML, replacing all
 * original asset URLs with their local paths.
 *
 * This handles:
 *  - Simple attribute values (src, href, poster, data-src, etc.)
 *  - srcset entries
 *  - Inline style url(...) values
 *
 * Returns the rewritten HTML string.
 */
export function rewriteHtmlAssets(
  html: string,
  rewriteMap: Map<string, string>,
): string {
  if (rewriteMap.size === 0) return html

  let result = html

  // Sort by longest URL first to avoid partial replacements
  const entries = [...rewriteMap.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  )

  for (const [originalUrl, localPath] of entries) {
    // Escape special regex characters in the URL
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Replace all occurrences (in attributes, srcsets, inline styles)
    result = result.replace(new RegExp(escaped, 'g'), localPath)
  }

  return result
}
