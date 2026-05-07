/**
 * Image-with-text detector.
 *
 * The classic "media-and-copy" split section — image on one side, text
 * on the other. Recognised by:
 *
 *   1. Explicit class signals: `image-with-text`, `media-with-text`,
 *      `feature-row`, `rich-text-with-image`, `brand-story`.
 *
 *   2. Structural signal: a block containing exactly one <img> or
 *      background-image element AND a <h2>/<h3> + paragraph + link,
 *      arranged side-by-side (has `display: grid/flex` heuristic).
 *
 * We skip anything that looks like the hero (already consumed) or a
 * product card (which the featured-collection detector handles).
 *
 * Extracted settings (Gbox Dawn's `image-with-text` schema):
 *   - heading    → first h2/h3
 *   - text       → first paragraph
 *   - image      → first <img src> (or background-image URL)
 *   - link_label → first link text
 *   - link_url   → first link href
 */

import type { DetectedSection } from '../types.js'
import {
  cleanText,
  firstImageSrc,
  iterateBlocks,
  makeDetectedSection,
  type DetectorContext,
} from './shared.js'

const IMAGE_TEXT_CLASS_RE =
  /\b(image-with-text|media-with-text|feature-row|rich-text-with-image|brand-story|text-with-image|media-text|split-panel)\b/i

export function detectImageWithText(ctx: DetectorContext): DetectedSection | null {
  const { $, baseUrl } = ctx
  const blocks = iterateBlocks($)

  for (const { index, el } of blocks) {
    const ownClass = el.attr('class') || ''
    if (IMAGE_TEXT_CLASS_RE.test(ownClass)) {
      return extract(el, index, baseUrl)
    }

    // Descendant match — a wrapper around an explicit image-with-text block.
    const inner = el
      .find('[class]')
      .filter((_, node) => {
        const cls = $(node).attr('class') || ''
        return IMAGE_TEXT_CLASS_RE.test(cls)
      })
      .first()
    if (inner.length > 0) {
      return extract(inner, index, baseUrl)
    }

    // Structural fallback: one image + one heading + one paragraph inside a
    // flex/grid block. Very loose — any homepage with this shape gets one.
    const hasImg = el.find('img').length >= 1
    const hasHeading = el.find('h2, h3').length >= 1
    const hasPara = el.find('p').length >= 1
    if (hasImg && hasHeading && hasPara && el.find('form').length === 0) {
      // Skip blocks that look like product grids (≥ 2 product cards).
      if (el.find('.product-card, .product-item, [data-product-id]').length >= 2) continue
      return extract(el, index, baseUrl)
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extract(
  el: ReturnType<DetectorContext['$']>,
  position: number,
  baseUrl?: string,
): DetectedSection {
  const heading = cleanText(el.find('h2, h3').first().text())
  const text = cleanText(el.find('p').first().text())
  const image = firstImageSrc(el, baseUrl)

  // Pick the first link that is NOT an image wrapper (we want the CTA).
  let linkEl = el
    .find('a[href]')
    .filter((_, node) => {
      const a = el.find(node)
      // Skip links whose only content is an image.
      const kidText = cleanText(a.text())
      return kidText.length > 0
    })
    .first()
  if (!linkEl || linkEl.length === 0) linkEl = el.find('a[href]').first()

  const link_label = cleanText(linkEl.text())
  const link_url = linkEl.length > 0 ? resolveHref(linkEl.attr('href'), baseUrl) : ''

  const settings: Record<string, string | number | boolean> = {
    heading: heading || 'Image with text',
  }
  if (text) settings.text = text
  if (image) settings.image = image
  if (link_label) settings.link_label = link_label
  if (link_url) settings.link_url = link_url

  return makeDetectedSection('image-with-text', position, settings)
}

function resolveHref(href: string | undefined, baseUrl?: string): string {
  if (!href) return ''
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:')) return ''
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (trimmed.startsWith('http')) return trimmed
  if (!baseUrl) return trimmed
  try {
    return new URL(trimmed, baseUrl).toString()
  } catch {
    return trimmed
  }
}
