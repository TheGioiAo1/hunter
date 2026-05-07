import { describe, it, expect } from 'vitest'
import { blogScraper } from './blog-scraper.js'

describe('blog-scraper', () => {
  it('extracts blog post from /blogs/<blog>/<post>', async () => {
    const html = `<html><body>
      <article>
        <h1>Launch Day</h1>
        <time datetime="2026-04-26">April 26, 2026</time>
        <span class="author">Thai</span>
        <p>We launched.</p>
      </article></body></html>`
    const r = await blogScraper.scrape(
      { queueId: 'q1', sourceUrl: 'https://example.com/blogs/news/launch-day', html, screenshotSha1: null, assetUrls: [], viewportWidth: 1280, viewportHeight: 800 },
      { isShopify: true },
    )
    expect(r!.blogHandle).toBe('news')
    expect(r!.sourceHandle).toBe('launch-day')
    expect(r!.title).toBe('Launch Day')
    expect(r!.author).toBe('Thai')
    expect(r!.publishedAt).toBe('2026-04-26')
  })
})
