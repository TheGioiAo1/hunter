/**
 * Clone Pro — Full CSS Scraper
 *
 * Downloads ALL CSS from a source website and produces a single
 * concatenated CSS string with font/image URLs rewritten to local paths.
 * This is the key to pixel-perfect cloning — we use the source's actual
 * CSS instead of regenerating from extracted tokens.
 */

import { safeFetch } from '../../clone-shopify/safe-fetch.js'
import * as cheerio from 'cheerio'
import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FullCSSResult {
  /** All CSS concatenated, with url() references rewritten to local paths */
  readonly css: string
  /** Map of local asset path → binary content (fonts, images) */
  readonly binaryAssets: Map<string, Buffer>
  /** Original Google Fonts URLs for fallback <link> tags */
  readonly googleFontsUrls: string[]
  /** Original source stylesheet URLs */
  readonly sourceStylesheetUrls: string[]
  /** Stats about what was downloaded */
  readonly stats: {
    readonly stylesheetCount: number
    readonly fontCount: number
    readonly cssImageCount: number
    readonly totalCssBytes: number
  }
}

interface CSSAssetRef {
  originalUrl: string
  localPath: string
  type: 'font' | 'image'
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Download all CSS from a website and rewrite asset URLs to local paths.
 *
 * @param html - Homepage HTML string
 * @param baseUrl - Base URL of the source site (e.g. https://bibliobloom.com)
 * @returns FullCSSResult with concatenated CSS and binary assets
 */
export async function scrapeFullCSS(
  html: string,
  baseUrl: string,
): Promise<FullCSSResult> {
  const $ = cheerio.load(html)
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const binaryAssets = new Map<string, Buffer>()
  const cssChunks: string[] = []
  const googleFontsUrls: string[] = []
  const sourceStylesheetUrls: string[] = []
  let fontCount = 0
  let cssImageCount = 0

  // ── Step 1: Collect CSS sources ─────────────────────────────────

  // External stylesheets
  const stylesheetUrls: string[] = []
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href')
    if (href) {
      const resolved = resolveUrl(href, normalizedBase)
      if (isGoogleFontsUrl(resolved)) {
        googleFontsUrls.push(resolved)
      } else {
        stylesheetUrls.push(resolved)
        sourceStylesheetUrls.push(resolved)
      }
    }
  })

  // @import in inline styles
  $('style').each((_, el) => {
    const styleContent = $(el).html() || ''
    const importMatches = styleContent.matchAll(/@import\s+url\(\s*['"]?(.*?)['"]?\s*\)/g)
    for (const m of importMatches) {
      const url = resolveUrl(m[1], normalizedBase)
      if (isGoogleFontsUrl(url)) {
        googleFontsUrls.push(url)
      } else {
        stylesheetUrls.push(url)
        sourceStylesheetUrls.push(url)
      }
    }
  })

  // ── Step 2: Fetch all external CSS files ────────────────────────

  const cssResults = await fetchAllCSS(stylesheetUrls)
  for (const result of cssResults) {
    if (result.css) cssChunks.push(result.css)
  }

  // ── Step 3: Collect inline <style> blocks ───────────────────────

  $('style').each((_, el) => {
    const content = $(el).html() || ''
    // Skip empty or very small style blocks (tracking pixels etc)
    if (content.trim().length > 20) {
      // Remove @import lines (we already fetched those)
      const cleaned = content.replace(/@import\s+url\([^)]*\)\s*;?/g, '')
      if (cleaned.trim()) cssChunks.push(cleaned)
    }
  })

  // ── Step 4: Fetch Google Fonts CSS + font files ─────────────────

  for (const gfUrl of googleFontsUrls) {
    try {
      // Use modern user-agent to get woff2 format
      const resp = await safeFetch(gfUrl, { maxBytes: 1024 * 1024, timeoutMs: 10000 })
      if (resp.statusCode === 200) {
        let gfCss = resp.body.toString('utf-8')

        // Find and download all font files in Google Fonts CSS
        const fontUrlMatches = gfCss.matchAll(/url\(\s*['"]?(https?:\/\/fonts\.gstatic\.com\/[^'"\s)]+)['"]?\s*\)/g)
        for (const m of fontUrlMatches) {
          const fontUrl = m[1]
          const ext = getExtension(fontUrl) || 'woff2'
          const hash = shortHash(fontUrl)
          const localPath = `assets/fonts/gf-${hash}.${ext}`

          try {
            const fontResp = await safeFetch(fontUrl, { maxBytes: 5 * 1024 * 1024, timeoutMs: 15000 })
            if (fontResp.statusCode === 200) {
              binaryAssets.set(localPath, fontResp.body)
              gfCss = gfCss.split(fontUrl).join(`/${localPath}`)
              fontCount++
            }
          } catch { /* skip individual font failures */ }
        }

        cssChunks.unshift(gfCss) // Google Fonts at the top
      }
    } catch { /* skip Google Fonts failures */ }
  }

  // ── Step 5: Find and download all url() assets in CSS ───────────

  let combinedCss = cssChunks.join('\n\n/* --- next stylesheet --- */\n\n')

  // Find all url() references
  const urlRefs = extractCssUrls(combinedCss, normalizedBase)

  // Download fonts and images
  for (const ref of urlRefs) {
    try {
      const resp = await safeFetch(ref.originalUrl, { maxBytes: 10 * 1024 * 1024, timeoutMs: 15000 })
      if (resp.statusCode === 200) {
        binaryAssets.set(ref.localPath, resp.body)
        // Replace all occurrences of this URL in the CSS
        combinedCss = replaceUrlInCss(combinedCss, ref.originalUrl, `/${ref.localPath}`)
        if (ref.type === 'font') fontCount++
        else cssImageCount++
      }
    } catch { /* skip failed downloads */ }
  }

  // ── Step 6: Clean up CSS ────────────────────────────────────────

  // Remove any remaining @import rules that reference external URLs
  combinedCss = combinedCss.replace(/@import\s+url\([^)]*\)\s*;?/g, '')

  // Add a header comment
  combinedCss = `/* Cloned from ${normalizedBase} — ${new Date().toISOString()} */\n\n${combinedCss}`

  return {
    css: combinedCss,
    binaryAssets,
    googleFontsUrls,
    sourceStylesheetUrls,
    stats: {
      stylesheetCount: cssResults.filter(r => r.css).length,
      fontCount,
      cssImageCount,
      totalCssBytes: Buffer.byteLength(combinedCss, 'utf-8'),
    },
  }
}

// ---------------------------------------------------------------------------
// CSS Fetcher
// ---------------------------------------------------------------------------

interface CSSFetchResult {
  url: string
  css: string | null
  error?: string
}

async function fetchAllCSS(urls: string[]): Promise<CSSFetchResult[]> {
  const results: CSSFetchResult[] = []

  // Fetch up to 5 concurrently
  const CONCURRENCY = 5
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.allSettled(
      batch.map(async (url) => {
        const resp = await safeFetch(url, { maxBytes: 5 * 1024 * 1024, timeoutMs: 15000 })
        if (resp.statusCode === 200) {
          return { url, css: resp.body.toString('utf-8') }
        }
        return { url, css: null, error: `HTTP ${resp.statusCode}` }
      }),
    )
    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value)
      } else {
        results.push({ url: batch[results.length] || 'unknown', css: null, error: r.reason?.message })
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// URL extraction and rewriting
// ---------------------------------------------------------------------------

function extractCssUrls(css: string, baseUrl: string): CSSAssetRef[] {
  const refs: CSSAssetRef[] = []
  const seen = new Set<string>()

  // Match url() in CSS, excluding data: URIs and already-local paths
  const urlRegex = /url\(\s*['"]?((?:https?:\/\/)[^'"\s)]+|(?:\/\/)[^'"\s)]+|(?:\.\.?\/)[^'"\s)]+)['"]?\s*\)/g
  let match

  while ((match = urlRegex.exec(css)) !== null) {
    let url = match[1]

    // Skip data URIs, already local paths, and Google Fonts (handled separately)
    if (url.startsWith('data:') || url.startsWith('/assets/') || isGoogleFontsUrl(url)) continue

    // Resolve relative URLs
    url = resolveUrl(url, baseUrl)

    if (seen.has(url)) continue
    seen.add(url)

    const ext = getExtension(url) || 'bin'
    const hash = shortHash(url)
    const isFont = /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(url)
    const type: 'font' | 'image' = isFont ? 'font' : 'image'
    const folder = isFont ? 'fonts' : 'images'
    const localPath = `assets/${folder}/${hash}.${ext}`

    refs.push({ originalUrl: url, localPath, type })
  }

  return refs
}

function replaceUrlInCss(css: string, originalUrl: string, newUrl: string): string {
  // Escape special regex characters in the URL
  const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match url() with optional quotes around this specific URL
  const regex = new RegExp(`url\\(\\s*['"]?${escaped}['"]?\\s*\\)`, 'g')
  return css.replace(regex, `url('${newUrl}')`)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUrl(url: string, baseUrl: string): string {
  try {
    if (url.startsWith('//')) return 'https:' + url
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    if (url.startsWith('/')) return baseUrl + url
    return new URL(url, baseUrl + '/').toString()
  } catch {
    return baseUrl + '/' + url
  }
}

function isGoogleFontsUrl(url: string): boolean {
  return /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(url)
}

function getExtension(url: string): string | null {
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/)
    return match ? match[1].toLowerCase() : null
  } catch {
    const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
    return match ? match[1].toLowerCase() : null
  }
}

function shortHash(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex').substring(0, 12)
}
