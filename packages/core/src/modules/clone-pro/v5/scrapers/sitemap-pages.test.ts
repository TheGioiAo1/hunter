import { describe, it, expect, vi } from 'vitest'
import { scrapeSitemapPages } from './sitemap-pages.js'

const sitemapXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.example.com/pages/about</loc></url>
  <url><loc>https://shop.example.com/pages/contact</loc></url>
  <url><loc>https://shop.example.com/products/tee-a</loc></url>
  <url><loc>https://shop.example.com/collections/sale</loc></url>
  <url><loc>https://shop.example.com/blogs/news/hello</loc></url>
  <url><loc>https://shop.example.com/cart</loc></url>
  <url><loc>https://shop.example.com/account/login</loc></url>
</urlset>`

const aboutHtml = `<html><head><title>About Us | Shop</title></head><body><main><h1>About</h1><p>Founded 2024.</p></main></body></html>`

describe('scrapeSitemapPages', () => {
  it('filters sitemap to only /pages/* URLs — rejects products/collections/blogs/cart/account', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => sitemapXml })
      .mockResolvedValueOnce({ ok: true, text: async () => aboutHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => aboutHtml })  // contact

    const out = await scrapeSitemapPages('https://shop.example.com', { fetch: fetchMock as any })

    expect(out).toHaveLength(2)
    expect(out.map((p) => p.slug).sort()).toEqual(['about', 'contact'])
  })

  it('derives slug from URL pathname — /pages/about → about', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => sitemapXml })
      .mockResolvedValueOnce({ ok: true, text: async () => aboutHtml })
      .mockResolvedValueOnce({ ok: true, text: async () => aboutHtml })
    const out = await scrapeSitemapPages('https://shop.example.com', { fetch: fetchMock as any })
    const about = out.find((p) => p.slug === 'about')!
    expect(about.title).toBe('About Us | Shop')
    expect(about.body_html).toContain('<h1>About</h1>')
  })

  it('returns empty when sitemap 404s (no throw — clone continues without pages)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' })
    const out = await scrapeSitemapPages('https://shop.example.com', { fetch: fetchMock as any })
    expect(out).toEqual([])
  })
})
