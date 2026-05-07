import type { BucketScraper, CollectionDTO } from './types.js'
import type { RenderedPage } from '../types.js'

const SYSTEM_PROMPT = `You extract a collection (category/department) page's metadata. Return JSON:
{ "title": string, "bodyHtml": string, "productLinks": string[] }
Only JSON. If page is NOT a collection/category, return {}.`

export const collectionGenericScraper: BucketScraper<CollectionDTO> = {
  classification: 'collection',
  async scrape(page: RenderedPage, ctx) {
    if (!ctx.callAI) return null
    const handle = new URL(page.sourceUrl).pathname.split('/').filter(Boolean).pop() ?? 'collection'
    const text = await ctx.callAI(SYSTEM_PROMPT, `URL: ${page.sourceUrl}\nHTML:\n${page.html.slice(0, 32_000)}`)
    let parsed: any
    // Claude often wraps JSON in markdown fences; strip them.
    const stripped = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
    try { parsed = JSON.parse(stripped) } catch { return null }
    if (!parsed.title) return null
    return {
      sourceHandle: handle,
      sourceUrl: page.sourceUrl,
      title: parsed.title,
      bodyHtml: parsed.bodyHtml ?? '',
      productHandles: (parsed.productLinks ?? []).map((u: string) => {
        try { return new URL(u, page.sourceUrl).pathname.split('/').pop() } catch { return null }
      }).filter(Boolean),
      seo: { title: null, description: null },
    }
  },
}
