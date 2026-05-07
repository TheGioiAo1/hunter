/**
 * Featured-collection detector.
 *
 * Recognises a homepage "featured products" block by its grid of product
 * cards. Detection rules:
 *
 *   1. Element with class matching `product-grid`, `products-grid`,
 *      `featured-collection`, `product-list`, or `products-list`.
 *
 *   2. OR a list/grid element with ≥ 2 descendants that look like
 *      product cards — `.product-card`, `.product-item`,
 *      `.grid-product`, or `[data-product-id]`.
 *
 * Extracted settings (keyed to Gbox Dawn's `featured-collection` schema):
 *   - heading            → nearest preceding h2/h3, else default
 *   - subheading         → first paragraph inside the section-header
 *   - collection_handle  → guessed from the first product link's
 *                          collection URL, or left empty (editor fills it)
 *   - products_to_show   → number of product cards counted, clamped to 2..24
 */

import type { DetectedSection } from '../types.js'
import {
  cleanText,
  countDescendants,
  iterateBlocks,
  makeDetectedSection,
  type DetectorContext,
} from './shared.js'

const GRID_CLASS_RE = /\b(product-grid|products-grid|featured-collection|product-list|products-list|featured-products)\b/i
const PRODUCT_CARD_SELECTOR =
  '.product-card, .product-item, .grid-product, [data-product-id], article.product, li.product'

// Match "/collections/<handle>" and capture the handle.
const COLLECTION_URL_RE = /\/collections\/([a-z0-9][a-z0-9-]*)/i

export function detectFeaturedCollection(ctx: DetectorContext): DetectedSection | null {
  const { $ } = ctx
  const blocks = iterateBlocks($)

  for (const { index, el } of blocks) {
    // Direct match on the block's own class…
    const ownClass = el.attr('class') || ''
    if (GRID_CLASS_RE.test(ownClass)) {
      return extractFromGrid(el, index)
    }
    // …or a wrapper around a grid.
    const grid = el.find('[class]').filter((_, node) => {
      const cls = $(node).attr('class') || ''
      return GRID_CLASS_RE.test(cls)
    }).first()
    if (grid.length > 0) {
      return extractFromGrid(grid, index, el)
    }

    // Fallback: block contains ≥ 2 product-card-shaped descendants.
    if (countDescendants(el, PRODUCT_CARD_SELECTOR) >= 2) {
      return extractFromGrid(el, index)
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extractFromGrid(
  gridEl: ReturnType<DetectorContext['$']>,
  position: number,
  wrapper?: ReturnType<DetectorContext['$']>,
): DetectedSection {
  const searchRoot = wrapper ?? gridEl
  // Heading: first h2/h3 in the wrapper, or preceding sibling of the grid.
  let heading = cleanText(searchRoot.find('h2, h3').first().text())
  if (!heading) {
    const prev = gridEl.prev()
    if (prev && (prev as any).is && (prev as any).is('h2, h3')) {
      heading = cleanText((prev as any).text())
    }
  }

  // Subheading: a paragraph near the heading, e.g. `.section-header p`.
  let subheading = cleanText(searchRoot.find('.section-header p, header p').first().text())
  if (!subheading) {
    subheading = cleanText(searchRoot.find('p').first().text())
  }

  // Count product cards → products_to_show (2..24).
  let products = countDescendants(gridEl, PRODUCT_CARD_SELECTOR)
  if (products === 0) {
    // Children of the grid often ARE the cards (<li>).
    products = gridEl.children().length
  }
  const products_to_show = Math.max(2, Math.min(24, products || 8))

  // Guess the collection handle from the first inner "/collections/<handle>" link.
  let collection_handle = ''
  gridEl.find('a[href]').each((_i, node) => {
    if (collection_handle) return
    const href = (node.attribs?.href as string) || ''
    const m = href.match(COLLECTION_URL_RE)
    if (m && m[1]) collection_handle = m[1]
  })

  const settings: Record<string, string | number | boolean> = {
    heading: heading || 'Featured collection',
    products_to_show,
  }
  if (subheading) settings.subheading = subheading
  if (collection_handle) settings.collection_handle = collection_handle

  return makeDetectedSection('featured-collection', position, settings)
}
