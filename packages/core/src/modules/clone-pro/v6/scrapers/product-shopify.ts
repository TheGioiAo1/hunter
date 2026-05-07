import type { BucketScraper, ProductDTO, VariantDTO, ProductImageDTO } from './types.js'
import type { RenderedPage } from '../types.js'

export const productShopifyScraper: BucketScraper<ProductDTO> = {
  classification: 'product',
  async scrape(page: RenderedPage, ctx) {
    if (!ctx.isShopify) return null
    const ldJson = extractJsonLd(page.html)
    if (!ldJson) return null
    const handle = page.sourceUrl.match(/\/products\/([^/?#]+)/)?.[1]
    if (!handle) return null

    const images: ProductImageDTO[] = (Array.isArray(ldJson.image) ? ldJson.image : ldJson.image ? [ldJson.image] : [])
      .map((src: string, i: number) => ({ sourceUrl: src, alt: null, position: i + 1 }))

    const offers: any[] = Array.isArray(ldJson.offers) ? ldJson.offers : ldJson.offers ? [ldJson.offers] : []
    const variants: VariantDTO[] = offers.map((o, i) => ({
      sourceVariantId: o.sku ?? `${handle}-v${i}`,
      title: 'Default',
      price: String(o.price ?? '0'),
      compareAtPrice: null,
      sku: o.sku ?? null,
      optionValues: {},
      available: o.availability === 'https://schema.org/InStock' || o.availability === 'InStock',
    }))

    return {
      sourceHandle: handle,
      sourceUrl: page.sourceUrl,
      title: ldJson.name ?? handle,
      bodyHtml: ldJson.description ?? '',
      vendor: ldJson.brand?.name ?? null,
      productType: ldJson.category ?? null,
      tags: [],
      variants,
      options: [],
      images,
      seo: { title: null, description: null },
    }
  },
}

function extractJsonLd(html: string): any | null {
  const matches = Array.from(html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi))
  for (const m of matches) {
    try {
      const obj = JSON.parse(m[1].trim())
      if (obj['@type'] === 'Product') return obj
      if (Array.isArray(obj) && obj.find((x: any) => x['@type'] === 'Product')) {
        return obj.find((x: any) => x['@type'] === 'Product')
      }
    } catch { /* skip malformed */ }
  }
  return null
}
