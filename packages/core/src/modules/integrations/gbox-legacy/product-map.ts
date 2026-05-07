/**
 * Lenful `NormalizedCatalogEntry` → legacy Gbox `LegacyProductPayload` mapper.
 *
 * Design notes
 * ------------
 * - SKUs must be globally unique per legacy shop. Lenful provides a
 *   `lenful_product_sku` + per-variant sku. We prefix both with `LNF-`
 *   and append a short random suffix so re-imports don't collide.
 * - Prices: we pass through Lenful's `base_price` / variant price as
 *   the retail price. Sellers can re-price in the legacy admin after.
 *   No margin is auto-applied here — keep the intent obvious.
 * - Images: thumbnail first (position=1), then each gallery URL in
 *   order. Duplicates (same URL in both) are deduped preserving the
 *   first occurrence.
 * - Options: we copy Lenful's derived options list as-is; the legacy
 *   service accepts `{name, values: [{name, display_value}]}` per
 *   swagger. `option_values` on each variant lets the .NET side
 *   reconstruct the matrix.
 * - Body HTML: wrap Lenful's description (or a templated fallback) in
 *   the same "Gbox-theme"-style block the local importer uses, so the
 *   storefront gets identically-styled product bodies whichever path
 *   created the product.
 */

import type { NormalizedCatalogEntry } from '../../fulfillment/lenful/catalog-sync.ts'
import type {
  LegacyProductImage,
  LegacyProductOption,
  LegacyProductPayload,
  LegacyProductVariant,
} from './types.ts'

const SKU_PREFIX = 'LNF'

function shortRand(): string {
  // 6 base-36 chars — ~2B space, collision-resistant per re-import window
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildBodyHtml(entry: NormalizedCatalogEntry, fallbackTitle: string): string {
  const hero = entry.description
    ? entry.description.trim()
    : `Premium ${entry.category_name || 'print-on-demand'} product, crafted on demand and shipped through the Gbox fulfillment partner network. Add your own design, your own price, and start selling today.`
  const optionRows = entry.options
    .map(
      (o) =>
        `<li><strong>${escHtml(o.name)}:</strong> ${o.values
          .map(escHtml)
          .join(' \u2022 ')}</li>`,
    )
    .join('')
  return [
    '<div class="gbox-product-description">',
    `  <p>${escHtml(hero)}</p>`,
    entry.options.length > 0
      ? `  <h3>Available options</h3>\n  <ul>\n    ${optionRows}\n  </ul>`
      : '',
    '  <h3>Why you\'ll love it</h3>',
    '  <ul>',
    '    <li><strong>Print-on-demand</strong> &mdash; no inventory risk, no upfront cost</li>',
    '    <li><strong>Ships worldwide</strong> &mdash; fulfilled through Gbox\'s global partner network</li>',
    '    <li><strong>Quality guaranteed</strong> &mdash; every order is inspected before it leaves the warehouse</li>',
    '    <li><strong>Custom designs welcome</strong> &mdash; upload your artwork and we\'ll handle the rest</li>',
    '  </ul>',
    '</div>',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildImages(entry: NormalizedCatalogEntry): LegacyProductImage[] {
  const seen = new Set<string>()
  const out: LegacyProductImage[] = []
  const push = (url: string | null | undefined) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    out.push({ position: out.length + 1, url })
  }
  push(entry.thumbnail_url)
  for (const g of entry.gallery_urls) push(g)
  return out
}

function buildOptions(entry: NormalizedCatalogEntry): LegacyProductOption[] {
  return entry.options.map((o) => ({
    name: o.name,
    values: o.values.map((v) => ({ name: v, display_value: v })),
  }))
}

function buildVariants(
  entry: NormalizedCatalogEntry,
  productSkuPrefix: string,
): LegacyProductVariant[] {
  if (entry.variants.length === 0) {
    return [
      {
        name: 'Default',
        sku: `${productSkuPrefix}-DEFAULT`,
        price: entry.base_price ?? 0,
      },
    ]
  }
  const used = new Set<string>()
  return entry.variants.map((v, idx) => {
    const rawSku = (v.sku || `${productSkuPrefix}-V${idx + 1}`).toUpperCase()
    // Prefix + dedupe (Lenful sometimes repeats the same SKU across colours)
    let sku = `${productSkuPrefix}-${rawSku}`
    let attempt = 1
    while (used.has(sku)) sku = `${productSkuPrefix}-${rawSku}-${attempt++}`
    used.add(sku)
    return {
      name: v.title || v.sku,
      sku,
      price: v.price ?? entry.base_price ?? 0,
      option_values: v.options.map((o) => o.value),
    }
  })
}

/**
 * Produce a fresh legacy Product payload from a Lenful catalog entry.
 * Every call generates new random SKU suffixes — re-importing the same
 * Lenful product yields distinct legacy products (by design: sellers
 * use re-import for "same base, different design" listings).
 */
export function mapLenfulEntryToLegacyProduct(
  entry: NormalizedCatalogEntry,
): LegacyProductPayload {
  const title = entry.title || entry.lenful_product_sku
  const skuSuffix = shortRand()
  const productSkuBase = (entry.lenful_product_sku || 'LENFUL')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .slice(0, 24)
  const productSkuPrefix = `${SKU_PREFIX}-${productSkuBase}-${skuSuffix}`

  const slugBase = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  const slug = slugBase
    ? `${slugBase}-${skuSuffix.toLowerCase()}`
    : `lenful-${skuSuffix.toLowerCase()}`

  return {
    name: title,
    sku: productSkuPrefix,
    slug,
    vendor: 'Lenful POD',
    tags: ['lenful', 'pod', entry.category_slug ?? '']
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i) as string[],
    body_html: buildBodyHtml(entry, title),
    images: buildImages(entry),
    options: buildOptions(entry),
    variants: buildVariants(entry, productSkuPrefix),
    seo_title: `${title} | Gbox`,
    seo_description:
      (entry.description ?? '').slice(0, 160) ||
      `Order ${title} on Gbox. Print-on-demand, ships worldwide.`,
    published: true,
  }
}
