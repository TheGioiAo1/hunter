import type { BucketScraper, CollectionDTO } from './types.js'

export const collectionShopifyScraper: BucketScraper<CollectionDTO> = {
  classification: 'collection',
  async scrape(page, ctx) {
    if (!ctx.isShopify) return null
    const handle = page.sourceUrl.match(/\/collections\/([^/?#]+)/)?.[1]
    if (!handle) return null

    const titleM = page.html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      ?? page.html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    const title = titleM ? decodeHtmlEntities(titleM[1].trim()) : handle

    const descM = page.html.match(/<div[^>]*class=["'][^"']*collection-description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
    const bodyHtml = descM ? descM[1].trim() : ''

    const productHandles = Array.from(page.html.matchAll(/href=["']\/products\/([^"'?#]+)["']/g))
      .map((m) => m[1])
      .filter((h, i, arr) => arr.indexOf(h) === i)

    return {
      sourceHandle: handle,
      sourceUrl: page.sourceUrl,
      title,
      bodyHtml,
      productHandles,
      seo: { title: null, description: null },
    }
  },
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}
