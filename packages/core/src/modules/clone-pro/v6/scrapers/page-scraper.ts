import type { BucketScraper, PageDTO } from './types.js'

export const pageScraper: BucketScraper<PageDTO> = {
  classification: 'page',
  async scrape(page, ctx) {
    const handleMatch = page.sourceUrl.match(/\/(pages|policies)\/([^/?#]+)/)
    if (!handleMatch && !ctx.callAI) return null
    const isPolicy = handleMatch?.[1] === 'policies'
    const handle = handleMatch?.[2] ?? deriveHandle(page.sourceUrl)

    const mainMatch = page.html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
      ?? page.html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    const inner = mainMatch ? mainMatch[1] : page.html
    const titleMatch = inner.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    const title = titleMatch ? stripTags(titleMatch[1]).trim() : handle

    return {
      sourceHandle: handle,
      sourceUrl: page.sourceUrl,
      title,
      bodyHtml: stripBoilerplate(inner),
      isPolicy,
      seo: { title: null, description: null },
    }
  },
}

function deriveHandle(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'page'
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function stripBoilerplate(html: string): string {
  return html
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .trim()
}
