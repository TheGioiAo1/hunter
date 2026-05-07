/**
 * Clone Pro v4 — Section detector shared helpers
 *
 * Each detector is a pure function of the homepage HTML (via a cheerio
 * `$`) that either returns a `DetectedSection` or `null`. The shared
 * module holds the plumbing every detector needs:
 *
 *   - A consistent `DetectorContext` with the parsed cheerio root.
 *   - A `linearBlocks()` iterator that walks top-level page blocks and
 *     exposes them with their DOM position — so composers can preserve
 *     the source order when a site has Hero → ImageText → Products vs.
 *     Hero → Products → ImageText.
 *   - Small text/URL extractors that handle the usual garbage (br tags,
 *     non-breaking spaces, hidden utility classes, etc.).
 *
 * Principles:
 *   - Detectors NEVER mutate the cheerio tree.
 *   - Detectors return the FIRST confident match — a homepage with two
 *     heroes gets one hero section. (The composer can be extended later
 *     to return arrays, but v1 keeps the output simple.)
 *   - When unsure, return null. A missed section is fixable by editing
 *     the theme; a mis-matched section is user-confusing.
 */

import type * as cheerio from 'cheerio'
import type { DetectedSection, SectionId } from '../types.js'

// ---------------------------------------------------------------------------
// Detector context
// ---------------------------------------------------------------------------

export interface DetectorContext {
  readonly $: cheerio.CheerioAPI
  /** Source URL of the homepage — used to resolve relative URLs in settings. */
  readonly baseUrl?: string
}

export type DetectorFn = (ctx: DetectorContext) => DetectedSection | null

// ---------------------------------------------------------------------------
// Text cleaners
// ---------------------------------------------------------------------------

/** Collapse whitespace and trim — our canonical text cleanup. */
export function cleanText(input: string | null | undefined): string {
  if (!input) return ''
  return input
    .replace(/\u00a0/g, ' ') // nbsp
    .replace(/\s+/g, ' ')
    .trim()
}

/** Get the first non-empty text node inside an element. */
export function firstText(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<any>,
  selector: string,
): string {
  return cleanText(el.find(selector).first().text())
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Resolve a maybe-relative URL against the homepage's baseUrl. */
export function resolveUrl(href: string | undefined, baseUrl?: string): string {
  if (!href) return ''
  const trimmed = href.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('#') || trimmed.startsWith('javascript:')) return ''
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (!baseUrl) return trimmed
  try {
    return new URL(trimmed, baseUrl).toString()
  } catch {
    return trimmed
  }
}

/** Pick the first non-empty href from any link in the element. */
export function firstHref(
  el: cheerio.Cheerio<any>,
  baseUrl?: string,
): string {
  const link = el.find('a[href]').first()
  if (link.length === 0) return ''
  return resolveUrl(link.attr('href') || '', baseUrl)
}

/** Pick the first non-empty <img src> from the element. */
export function firstImageSrc(
  el: cheerio.Cheerio<any>,
  baseUrl?: string,
): string {
  // Try <img> first (including data-src for lazy-loaded).
  const img = el.find('img').first()
  if (img.length > 0) {
    const src =
      img.attr('src') ||
      img.attr('data-src') ||
      img.attr('data-lazy') ||
      img.attr('data-original') ||
      ''
    if (src) return resolveUrl(src, baseUrl)
  }
  // Fallback: `style="background-image: url(...)"` on the element itself…
  const selfStyle = el.attr('style') || ''
  if (/background/i.test(selfStyle)) {
    const m = selfStyle.match(/url\(['"]?([^'")]+)/)
    if (m && m[1]) return resolveUrl(m[1], baseUrl)
  }
  // …or on a descendant.
  const styled = el.find('[style*="background"]').first()
  if (styled.length > 0) {
    const style = styled.attr('style') || ''
    const m = style.match(/url\(['"]?([^'")]+)/)
    if (m && m[1]) return resolveUrl(m[1], baseUrl)
  }
  return ''
}

// ---------------------------------------------------------------------------
// Block iteration
// ---------------------------------------------------------------------------

/**
 * Yield top-level "blocks" from the homepage — the direct children of
 * `<main>` (preferred), or of `<body>` as a fallback. Each block is
 * tagged with its source position so composers can preserve ordering.
 *
 * We skip header + footer elements — those are owned by the chrome
 * bucket and detected separately (actually by homepage-cloner).
 */
export function iterateBlocks(
  $: cheerio.CheerioAPI,
): Array<{ index: number; el: cheerio.Cheerio<any> }> {
  const root = $('main').first().length > 0 ? $('main').first() : $('body').first()
  if (root.length === 0) return []

  const out: Array<{ index: number; el: cheerio.Cheerio<any> }> = []
  const children = root.children()
  children.each((i, child) => {
    const el = $(child)
    // Skip chrome landmarks.
    if (el.is('header, footer, nav[role="navigation"]')) return
    // Skip clearly non-visible elements (script, style, noscript).
    if (el.is('script, style, noscript, template')) return
    out.push({ index: i, el })
  })
  return out
}

// ---------------------------------------------------------------------------
// Finding helpers — shared between detectors
// ---------------------------------------------------------------------------

/** Count matching descendants cheaper than a full jQuery chain. */
export function countDescendants(
  el: cheerio.Cheerio<any>,
  selector: string,
): number {
  return el.find(selector).length
}

/**
 * Build a DetectedSection record. Exported for detectors to keep
 * their internal branches uniform.
 */
export function makeDetectedSection(
  id: SectionId,
  position: number,
  settings: Readonly<Record<string, string | number | boolean>>,
  sourceSnippet?: string,
): DetectedSection {
  return { id, position, settings, sourceSnippet }
}
