import type { BucketScraper, BlogPostDTO } from './types.js'

export const blogScraper: BucketScraper<BlogPostDTO> = {
  classification: 'blog_post',
  async scrape(page, _ctx) {
    const m = page.sourceUrl.match(/\/blogs\/([^/]+)\/([^/?#]+)/)
    if (!m) return null
    const [, blogHandle, postHandle] = m

    const articleM = page.html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    const inner = articleM ? articleM[1] : page.html

    const titleM = inner.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : postHandle

    const timeM = inner.match(/<time[^>]*datetime=["']([^"']+)["']/i)
    const publishedAt = timeM ? timeM[1] : null

    const authorM = inner.match(/<[^>]*class=["'][^"']*author[^"']*["'][^>]*>([^<]+)</i)
    const author = authorM ? authorM[1].trim() : null

    const bodyHtml = inner
      .replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '')
      .replace(/<time[\s\S]*?<\/time>/gi, '')
      .replace(/<[^>]*class=["'][^"']*author[^"']*["'][\s\S]*?<\/[^>]+>/gi, '')
      .trim()

    return {
      blogHandle,
      sourceHandle: postHandle,
      sourceUrl: page.sourceUrl,
      title,
      author,
      bodyHtml,
      publishedAt,
      tags: [],
      seo: { title: null, description: null },
    }
  },
}
