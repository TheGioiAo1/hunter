import type { BucketScraper, ProductDTO } from './types.js'
import type { RenderedPage } from '../types.js'

const SYSTEM_PROMPT = `You extract product data from rendered HTML. Return JSON with shape:
{ "title": string, "bodyHtml": string, "price": string, "images": string[], "variants": [{ "sku": string, "price": string, "optionValues": object }] }
Only return JSON, no commentary. If page is NOT a product page, return {}.`

export const productGenericScraper: BucketScraper<ProductDTO> = {
  classification: 'product',
  async scrape(page: RenderedPage, ctx) {
    if (!ctx.callAI) return null
    const handle = derivHandleFromUrl(page.sourceUrl)
    const userPrompt = `URL: ${page.sourceUrl}\nHTML (truncated to first 32KB):\n${page.html.slice(0, 32_000)}`
    const text = await ctx.callAI(SYSTEM_PROMPT, userPrompt)
    let parsed: any
    try { parsed = JSON.parse(stripJsonFences(text)) } catch { return null }
    if (!parsed.title) return null

    return {
      sourceHandle: handle,
      sourceUrl: page.sourceUrl,
      title: parsed.title,
      bodyHtml: parsed.bodyHtml ?? '',
      vendor: null,
      productType: null,
      tags: [],
      variants: (parsed.variants ?? []).map((v: any, i: number) => ({
        sourceVariantId: v.sku ?? `${handle}-v${i}`,
        title: v.title ?? 'Default',
        price: String(v.price ?? parsed.price ?? '0'),
        compareAtPrice: null,
        sku: v.sku ?? null,
        optionValues: v.optionValues ?? {},
        available: true,
      })),
      options: [],
      images: (parsed.images ?? []).map((src: string, i: number) => ({ sourceUrl: src, alt: null, position: i + 1 })),
      seo: { title: null, description: null },
    }
  },
}

function derivHandleFromUrl(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'product'
}

/**
 * Strip markdown code fences from AI output. Claude/Haiku frequently wraps
 * JSON responses in ` ```json ... ``` ` despite the "no commentary" instruction;
 * this normalizes the response so JSON.parse can consume it.
 */
function stripJsonFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}
