/**
 * Asset Scanner — Clone Pro Phase 1.5
 *
 * Scans all crawled pages to build a complete inventory of every external
 * asset (CSS, JS, fonts, images, SVGs, favicons, manifests, videos) that
 * needs to be downloaded for a faithful 1:1 clone.
 *
 * How it works:
 *   1. Parse every page's HTML with cheerio
 *   2. Extract asset URLs from tags, inline styles, and <style> blocks
 *   3. Resolve relative URLs to absolute
 *   4. Deduplicate by absolute URL
 *   5. Classify type + priority
 *   6. Group into download tiers (critical → high → media)
 *
 * The output `AssetInventory` drives the download stage that follows.
 */

import * as cheerio from 'cheerio'

// ---------------------------------------------------------------------------
// Re-use the page type from the deep crawler
// ---------------------------------------------------------------------------

import type { DiscoveredPage } from './deep-crawler.js'

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Classification of a discovered asset. */
export type AssetType =
  | 'css'
  | 'js'
  | 'font'
  | 'image'
  | 'svg'
  | 'favicon'
  | 'manifest'
  | 'video'
  | 'other'

/** A single asset discovered during the scan. */
export interface DiscoveredAsset {
  /** Original URL as found in the HTML (may be relative, protocol-relative, etc.) */
  url: string
  /** Fully resolved absolute URL */
  absoluteUrl: string
  /** Asset classification */
  type: AssetType
  /** Page URLs where this asset was referenced */
  foundOn: string[]
  /** True when the asset is hosted on a different origin than the source site */
  isExternal: boolean
  /** Rough size estimate in bytes (from URL heuristics — not a HEAD request) */
  estimatedSize?: number
  /**
   * Download priority:
   *  - critical: CSS + fonts (render-blocking)
   *  - high: JS (interactivity)
   *  - medium: images, favicons, SVGs
   *  - low: lazy-loaded images, videos, manifests
   */
  priority: 'critical' | 'high' | 'medium' | 'low'
}

/** Complete inventory of all assets found across crawled pages. */
export interface AssetInventory {
  /** Deduplicated list of every discovered asset */
  assets: DiscoveredAsset[]
  /** Human-readable summary counts */
  summary: {
    totalAssets: number
    byType: Record<AssetType, number>
    byPriority: Record<string, number>
    /** Every unique external hostname referenced */
    externalDomains: string[]
    /** Very rough estimate of total download size */
    estimatedTotalSizeMB: number
    cssFiles: number
    jsFiles: number
    fontFiles: number
    imageFiles: number
  }
  /** Render-blocking assets that must be fetched first (CSS + fonts) */
  criticalAssets: DiscoveredAsset[]
  /** JS files needed for interactivity */
  highPriorityAssets: DiscoveredAsset[]
  /** Images, videos, and other media */
  mediaAssets: DiscoveredAsset[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File extensions we recognise as fonts. */
const FONT_EXTENSIONS = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot'])

/** File extensions we recognise as images. */
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tiff',
])

/** File extensions we recognise as video. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.mov', '.avi'])

/** File extensions we recognise as SVG. */
const SVG_EXTENSIONS = new Set(['.svg'])

/** Regex to pull every `url(...)` from a CSS string. */
const CSS_URL_RE = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi

/** Regex to detect @font-face blocks and their src urls. */
const FONT_FACE_RE = /@font-face\s*\{[^}]*?src\s*:[^}]*?url\(\s*['"]?([^'")]+?)['"]?\s*\)[^}]*?\}/gi

/** Rough average sizes (bytes) used when we cannot determine actual size. */
const SIZE_ESTIMATES: Record<AssetType, number> = {
  css: 30_000,
  js: 80_000,
  font: 50_000,
  image: 150_000,
  svg: 8_000,
  favicon: 5_000,
  manifest: 1_000,
  video: 5_000_000,
  other: 20_000,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a potentially relative URL against a base URL.
 * Returns `null` when the input is not a usable URL (data:, javascript:, #, etc.).
 */
function resolveUrl(raw: string, base: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('data:')) return null
  if (trimmed.startsWith('javascript:')) return null
  if (trimmed.startsWith('#')) return null
  if (trimmed.startsWith('mailto:')) return null
  if (trimmed.startsWith('tel:')) return null

  try {
    // Handle protocol-relative URLs
    const toResolve = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
    const resolved = new URL(toResolve, base)
    // Strip fragment
    resolved.hash = ''
    return resolved.href
  } catch {
    return null
  }
}

/**
 * Extract the hostname from an absolute URL, or `null` on failure.
 */
function getHostname(absoluteUrl: string): string | null {
  try {
    return new URL(absoluteUrl).hostname
  } catch {
    return null
  }
}

/**
 * Get the file extension (lowercased, including the dot) from a URL path.
 */
function getExtension(absoluteUrl: string): string {
  try {
    const pathname = new URL(absoluteUrl).pathname
    const dot = pathname.lastIndexOf('.')
    if (dot === -1) return ''
    // Ignore extensions after query params encoded in the path
    const ext = pathname.slice(dot).toLowerCase()
    // Trim anything after a second dot (e.g. ".min.js" → take ".js" portion)
    return ext.split(/[?#]/)[0]
  } catch {
    return ''
  }
}

/**
 * Classify an asset URL into an `AssetType`.
 *
 * @param absoluteUrl - The resolved absolute URL
 * @param hint        - Optional hint from the HTML context (e.g. 'font', 'stylesheet')
 */
function classifyAsset(absoluteUrl: string, hint?: string): AssetType {
  // Explicit hints from context always win
  if (hint === 'stylesheet' || hint === 'css') return 'css'
  if (hint === 'font') return 'font'
  if (hint === 'favicon') return 'favicon'
  if (hint === 'manifest') return 'manifest'
  if (hint === 'video') return 'video'
  if (hint === 'script') return 'js'

  const ext = getExtension(absoluteUrl)

  if (ext === '.css') return 'css'
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js'
  if (FONT_EXTENSIONS.has(ext)) return 'font'
  if (SVG_EXTENSIONS.has(ext)) return 'svg'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (ext === '.json' && absoluteUrl.includes('manifest')) return 'manifest'
  if (ext === '.webmanifest') return 'manifest'
  if (ext === '.ico') return 'favicon'

  // URL path heuristics
  const lower = absoluteUrl.toLowerCase()
  if (lower.includes('fonts.googleapis.com') || lower.includes('fonts.gstatic.com')) return 'font'
  if (lower.includes('/font') && !lower.includes('/fontawesome')) return 'font'

  return hint === 'image' ? 'image' : 'other'
}

/**
 * Assign download priority based on asset type and context.
 */
function assignPriority(
  type: AssetType,
  isLazy: boolean,
): 'critical' | 'high' | 'medium' | 'low' {
  if (type === 'css' || type === 'font') return 'critical'
  if (type === 'js') return 'high'
  if (type === 'video' || type === 'manifest') return 'low'
  if (isLazy) return 'low'
  // images, svgs, favicons
  if (type === 'favicon') return 'medium'
  return 'medium'
}

// ---------------------------------------------------------------------------
// Core Scanner
// ---------------------------------------------------------------------------

/**
 * Internal mutable map used during scanning. Keyed by absolute URL.
 */
interface AssetEntry {
  url: string
  absoluteUrl: string
  type: AssetType
  foundOn: Set<string>
  isExternal: boolean
  isLazy: boolean
  estimatedSize?: number
}

/**
 * Scan a single page's HTML and collect asset references into `assetMap`.
 *
 * @param page      - The crawled page to scan
 * @param sourceHost - Hostname of the source website (for external detection)
 * @param assetMap  - Shared mutable map accumulating results across pages
 */
function scanPage(
  page: DiscoveredPage,
  sourceHost: string,
  assetMap: Map<string, AssetEntry>,
): void {
  const $ = cheerio.load(page.html)
  const pageUrl = page.url

  /**
   * Register a discovered asset URL. Deduplicates by absolute URL and merges
   * `foundOn` sets when the same asset appears on multiple pages.
   */
  const register = (
    rawUrl: string,
    hint?: string,
    lazy = false,
  ): void => {
    const abs = resolveUrl(rawUrl, pageUrl)
    if (!abs) return

    const existing = assetMap.get(abs)
    if (existing) {
      existing.foundOn.add(pageUrl)
      return
    }

    const type = classifyAsset(abs, hint)
    const host = getHostname(abs)
    const isExternal = host !== null && host !== sourceHost

    assetMap.set(abs, {
      url: rawUrl,
      absoluteUrl: abs,
      type,
      foundOn: new Set([pageUrl]),
      isExternal,
      isLazy: lazy,
      estimatedSize: SIZE_ESTIMATES[type],
    })
  }

  // ----- <link> tags -----
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href')
    if (href) register(href, 'stylesheet')
  })

  $('link[rel="preload"]').each((_, el) => {
    const href = $(el).attr('href')
    const asAttr = $(el).attr('as')
    if (href && asAttr === 'font') register(href, 'font')
    else if (href && asAttr === 'style') register(href, 'stylesheet')
    else if (href && asAttr === 'script') register(href, 'script')
    else if (href && asAttr === 'image') register(href, 'image')
    else if (href) register(href)
  })

  $('link[rel="prefetch"], link[rel="preconnect"], link[rel="dns-prefetch"]').each((_, el) => {
    // We only care about prefetched assets with an href that looks like a file
    const href = $(el).attr('href')
    if (href && getExtension(href)) register(href)
  })

  $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, el) => {
    const href = $(el).attr('href')
    if (href) register(href, 'favicon')
  })

  $('link[rel="manifest"]').each((_, el) => {
    const href = $(el).attr('href')
    if (href) register(href, 'manifest')
  })

  // ----- <script> tags -----
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src')
    if (src) register(src, 'script')
  })

  // ----- <img> tags -----
  $('img').each((_, el) => {
    const src = $(el).attr('src')
    const srcset = $(el).attr('srcset')
    const dataSrc = $(el).attr('data-src')
    const dataLazy = $(el).attr('loading') === 'lazy'

    if (src) register(src, 'image', dataLazy)
    if (dataSrc) register(dataSrc, 'image', true)

    // Parse srcset: "url1 1x, url2 2x" or "url1 300w, url2 600w"
    if (srcset) {
      parseSrcset(srcset).forEach((u) => register(u, 'image', dataLazy))
    }
  })

  // ----- <picture> / <source> tags -----
  $('picture source').each((_, el) => {
    const srcset = $(el).attr('srcset')
    const src = $(el).attr('src')
    if (srcset) parseSrcset(srcset).forEach((u) => register(u, 'image'))
    if (src) register(src, 'image')
  })

  // ----- <video> / <source> tags -----
  $('video').each((_, el) => {
    const src = $(el).attr('src')
    const poster = $(el).attr('poster')
    if (src) register(src, 'video')
    if (poster) register(poster, 'image')
  })

  $('video source').each((_, el) => {
    const src = $(el).attr('src')
    if (src) register(src, 'video')
  })

  // ----- <svg> with external references -----
  $('svg use[href], svg use[xlink\\:href]').each((_, el) => {
    const href = $(el).attr('href') || $(el).attr('xlink:href')
    if (href && !href.startsWith('#')) register(href, 'image')
  })

  $('svg image[href], svg image[xlink\\:href]').each((_, el) => {
    const href = $(el).attr('href') || $(el).attr('xlink:href')
    if (href) register(href, 'image')
  })

  // ----- Inline style attributes: background-image, etc. -----
  $('[style]').each((_, el) => {
    const style = $(el).attr('style')
    if (style) {
      extractCssUrls(style).forEach((u) => register(u, 'image'))
    }
  })

  // ----- <style> blocks -----
  $('style').each((_, el) => {
    const cssText = $(el).text()
    if (!cssText) return

    // Extract @font-face src urls specifically as fonts
    let fontMatch: RegExpExecArray | null
    const fontFaceRe = new RegExp(FONT_FACE_RE.source, FONT_FACE_RE.flags)
    while ((fontMatch = fontFaceRe.exec(cssText)) !== null) {
      if (fontMatch[1]) register(fontMatch[1], 'font')
    }

    // Extract all other url() references
    extractCssUrls(cssText).forEach((u) => {
      // If it looks like a font, classify as font; otherwise image
      const ext = getExtension(resolveUrl(u, pageUrl) || '')
      const hint = FONT_EXTENSIONS.has(ext) ? 'font' : 'image'
      register(u, hint)
    })
  })
}

/**
 * Parse an `srcset` attribute value into an array of URLs.
 *
 * Format: "url1 1x, url2 2x" or "url1 300w, url2 600w"
 */
function parseSrcset(srcset: string): string[] {
  return srcset
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean)
}

/**
 * Extract all `url(...)` references from a CSS string.
 */
function extractCssUrls(css: string): string[] {
  const urls: string[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(CSS_URL_RE.source, CSS_URL_RE.flags)
  while ((match = re.exec(css)) !== null) {
    const url = match[1]
    if (url && !url.startsWith('data:')) {
      urls.push(url)
    }
  }
  return urls
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan all crawled pages and build a complete asset inventory.
 *
 * This is the main entry point for Phase 1.5. It takes the pages produced
 * by the deep crawler and returns a structured inventory of every asset
 * that needs to be downloaded.
 *
 * @param pages     - Array of pages from the deep crawler
 * @param sourceUrl - The root URL of the website being cloned (used for
 *                    resolving relative paths and detecting external domains)
 * @returns A complete `AssetInventory` ready for the download stage
 *
 * @example
 * ```ts
 * import { scanAssets, printAssetInventory } from './asset-scanner.js'
 *
 * const inventory = scanAssets(crawledPages, 'https://example-store.com')
 * console.log(printAssetInventory(inventory))
 * // Download critical assets first, then high, then media
 * await downloadBatch(inventory.criticalAssets)
 * await downloadBatch(inventory.highPriorityAssets)
 * await downloadBatch(inventory.mediaAssets)
 * ```
 */
export function scanAssets(
  pages: DiscoveredPage[],
  sourceUrl: string,
): AssetInventory {
  const sourceHost = getHostname(sourceUrl) || ''
  const assetMap = new Map<string, AssetEntry>()

  // Scan every page
  for (const page of pages) {
    if (!page.html || page.statusCode >= 400) continue
    scanPage(page, sourceHost, assetMap)
  }

  // Convert internal entries to public DiscoveredAsset[]
  const assets: DiscoveredAsset[] = Array.from(assetMap.values()).map((entry) => ({
    url: entry.url,
    absoluteUrl: entry.absoluteUrl,
    type: entry.type,
    foundOn: Array.from(entry.foundOn),
    isExternal: entry.isExternal,
    estimatedSize: entry.estimatedSize,
    priority: assignPriority(entry.type, entry.isLazy),
  }))

  // Sort: critical first, then high, medium, low
  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  }
  assets.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])

  // Build summary counts
  const byType = initByType()
  const byPriority: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  const externalHostSet = new Set<string>()
  let totalEstimatedBytes = 0

  for (const asset of assets) {
    byType[asset.type]++
    byPriority[asset.priority] = (byPriority[asset.priority] || 0) + 1

    if (asset.isExternal) {
      const host = getHostname(asset.absoluteUrl)
      if (host) externalHostSet.add(host)
    }

    totalEstimatedBytes += asset.estimatedSize ?? 0
  }

  // Group by priority tier
  const criticalAssets = assets.filter((a) => a.priority === 'critical')
  const highPriorityAssets = assets.filter((a) => a.priority === 'high')
  const mediaAssets = assets.filter(
    (a) => a.priority === 'medium' || a.priority === 'low',
  )

  return {
    assets,
    summary: {
      totalAssets: assets.length,
      byType,
      byPriority,
      externalDomains: Array.from(externalHostSet).sort(),
      estimatedTotalSizeMB: Math.round((totalEstimatedBytes / (1024 * 1024)) * 100) / 100,
      cssFiles: byType.css,
      jsFiles: byType.js,
      fontFiles: byType.font,
      imageFiles: byType.image + byType.svg,
    },
    criticalAssets,
    highPriorityAssets,
    mediaAssets,
  }
}

/**
 * Initialise a zeroed-out `Record<AssetType, number>`.
 */
function initByType(): Record<AssetType, number> {
  return {
    css: 0,
    js: 0,
    font: 0,
    image: 0,
    svg: 0,
    favicon: 0,
    manifest: 0,
    video: 0,
    other: 0,
  }
}

// ---------------------------------------------------------------------------
// Pretty-printer
// ---------------------------------------------------------------------------

/**
 * Format an `AssetInventory` as a human-readable text summary.
 *
 * The output is designed for CLI / log consumption and looks like:
 *
 * ```
 * Asset Inventory
 * ===============
 * CSS:       12 files (critical)
 * JS:         8 files
 * Fonts:      6 files (critical)
 * ...
 * ```
 *
 * @param inventory - The inventory to format
 * @returns Multi-line formatted string
 */
export function printAssetInventory(inventory: AssetInventory): string {
  const { summary, assets } = inventory
  const { byType, externalDomains, estimatedTotalSizeMB } = summary

  const lines: string[] = []

  lines.push('Asset Inventory')
  lines.push('\u2550'.repeat(40))

  // Type breakdown with padding for alignment
  const typeRows: [string, number, string][] = [
    ['CSS', byType.css, '(critical)'],
    ['JS', byType.js, ''],
    ['Fonts', byType.font, '(critical)'],
    ['Images', byType.image, ''],
    ['SVG', byType.svg, ''],
    ['Favicons', byType.favicon, ''],
    ['Manifest', byType.manifest, ''],
    ['Video', byType.video, ''],
    ['Other', byType.other, ''],
  ]

  // Only print rows that have > 0 assets
  const activeRows = typeRows.filter(([, count]) => count > 0)

  for (const [label, count, note] of activeRows) {
    const countStr = String(count).padStart(6)
    const suffix = count === 1 ? 'file' : 'files'
    const noteStr = note ? ` ${note}` : ''
    lines.push(`${label.padEnd(12)}${countStr} ${suffix}${noteStr}`)
  }

  lines.push('\u2500'.repeat(40))
  lines.push(`${'Total'.padEnd(12)}${String(summary.totalAssets).padStart(6)} assets`)

  // External domains with reference counts
  if (externalDomains.length > 0) {
    lines.push('')
    lines.push('External Domains:')

    // Count how many asset references each domain has
    const domainRefCounts = new Map<string, number>()
    for (const asset of assets) {
      if (asset.isExternal) {
        const host = getHostname(asset.absoluteUrl)
        if (host) {
          const total = asset.foundOn.length
          domainRefCounts.set(host, (domainRefCounts.get(host) || 0) + total)
        }
      }
    }

    // Sort by ref count descending
    const sortedDomains = Array.from(domainRefCounts.entries()).sort(
      (a, b) => b[1] - a[1],
    )

    for (const [domain, refs] of sortedDomains) {
      const refLabel = refs === 1 ? 'ref' : 'refs'
      lines.push(`  - ${domain} (${refs} ${refLabel})`)
    }
  }

  // Size estimate
  lines.push('')
  const sizeStr =
    estimatedTotalSizeMB >= 1
      ? `~${Math.round(estimatedTotalSizeMB)} MB`
      : `~${Math.round(estimatedTotalSizeMB * 1024)} KB`
  lines.push(`Est. Download Size: ${sizeStr}`)

  return lines.join('\n')
}
