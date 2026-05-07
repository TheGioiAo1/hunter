import { describe, it, expect, vi } from 'vitest'
import { discoverUrls } from './stage1-sitemap.js'

describe('Stage 1 — sitemap discovery', () => {
  it('walks /sitemap.xml when present', async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) {
        return { status: 200, ok: true, text: async () => `<?xml version="1.0"?><urlset><url><loc>https://example.com/products/a</loc></url><url><loc>https://example.com/pages/about</loc></url></urlset>` }
      }
      return { status: 404, ok: false, text: async () => '' }
    })
    const r = await discoverUrls({
      sourceUrl: 'https://example.com',
      maxBfsPages: 1000,
      maxBfsDepth: 5,
      fetch: fakeFetch as any,
    })
    expect(r.urls).toHaveLength(2)
    expect(r.urls[0].discoveredVia).toBe('sitemap')
  })

  it('expands sitemap-index recursively', async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) {
        return { status: 200, ok: true, text: async () => `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/sitemap_products.xml</loc></sitemap></sitemapindex>` }
      }
      if (url.endsWith('/sitemap_products.xml')) {
        return { status: 200, ok: true, text: async () => `<?xml version="1.0"?><urlset><url><loc>https://example.com/products/x</loc></url></urlset>` }
      }
      return { status: 404, ok: false, text: async () => '' }
    })
    const r = await discoverUrls({ sourceUrl: 'https://example.com', maxBfsPages: 1000, maxBfsDepth: 5, fetch: fakeFetch as any })
    expect(r.urls.find((u) => u.sourceUrl.endsWith('/products/x'))).toBeDefined()
    expect(r.urls[0].discoveredVia).toBe('sitemap_index')
  })

  it('falls back to BFS when no sitemap', async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/sitemap.xml') || url.endsWith('/sitemap_index.xml')) {
        return { status: 404, ok: false, text: async () => '' }
      }
      if (url === 'https://example.com/' || url === 'https://example.com') {
        return { status: 200, ok: true, text: async () => `<html><body><a href="/products/a">A</a><a href="/pages/about">About</a></body></html>` }
      }
      if (url.endsWith('/robots.txt')) return { status: 404, ok: false, text: async () => '' }
      return { status: 200, ok: true, text: async () => '<html></html>' }
    })
    const r = await discoverUrls({ sourceUrl: 'https://example.com', maxBfsPages: 5, maxBfsDepth: 1, fetch: fakeFetch as any })
    expect(r.urls.length).toBeGreaterThan(0)
    expect(r.urls.some((u) => u.discoveredVia === 'bfs')).toBe(true)
  })

  it('respects maxBfsPages cap', async () => {
    let counter = 0
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/sitemap.xml') || url.endsWith('/robots.txt')) return { status: 404, ok: false, text: async () => '' }
      counter++
      const html = counter < 100
        ? `<html><body><a href="/p${counter}">L</a></body></html>`
        : '<html></html>'
      return { status: 200, ok: true, text: async () => html }
    })
    const r = await discoverUrls({ sourceUrl: 'https://example.com', maxBfsPages: 10, maxBfsDepth: 5, fetch: fakeFetch as any })
    expect(r.urls.length).toBeLessThanOrEqual(10)
  })
})
