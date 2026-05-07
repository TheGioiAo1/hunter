import { describe, it, expect, vi } from 'vitest'
import { classifyUrls, classifyUrlsByPattern } from './stage2-classify-urls.js'

describe('Stage 2 — URL classification', () => {
  describe('classifyUrlsByPattern (Shopify-pattern shortcut)', () => {
    it('classifies /products/handle as product', () => {
      expect(
        classifyUrlsByPattern(['https://example.com/products/widget-x'])[
          'https://example.com/products/widget-x'
        ],
      ).toBe('product')
    })
    it('classifies /collections/handle as collection', () => {
      expect(
        classifyUrlsByPattern(['https://example.com/collections/sale'])[
          'https://example.com/collections/sale'
        ],
      ).toBe('collection')
    })
    it('classifies /pages/handle as page', () => {
      expect(
        classifyUrlsByPattern(['https://example.com/pages/about'])[
          'https://example.com/pages/about'
        ],
      ).toBe('page')
    })
    it('classifies /blogs/x/y as blog_post', () => {
      expect(
        classifyUrlsByPattern(['https://example.com/blogs/news/2024-launch'])[
          'https://example.com/blogs/news/2024-launch'
        ],
      ).toBe('blog_post')
    })
    it('classifies /policies/x as policy', () => {
      expect(
        classifyUrlsByPattern(['https://example.com/policies/privacy-policy'])[
          'https://example.com/policies/privacy-policy'
        ],
      ).toBe('policy')
    })
    it('returns null for unmatched URLs', () => {
      expect(
        classifyUrlsByPattern(['https://example.com/random'])[
          'https://example.com/random'
        ],
      ).toBeNull()
    })
  })

  describe('classifyUrls (full pipeline with AI fallback)', () => {
    it('uses pattern shortcut for Shopify URLs (no AI call)', async () => {
      const aiCall = vi.fn()
      const r = await classifyUrls({
        urls: [
          'https://example.com/products/x',
          'https://example.com/collections/y',
        ],
        callAI: aiCall as any,
      })
      expect(aiCall).not.toHaveBeenCalled()
      expect(r['https://example.com/products/x']).toBe('product')
      expect(r['https://example.com/collections/y']).toBe('collection')
    })

    it('falls back to AI for unmatched URLs in batches of 50', async () => {
      const aiCall = vi.fn().mockImplementation(async (urls: string[]) => {
        const out: Record<string, any> = {}
        for (const u of urls) out[u] = 'page'
        return out
      })
      const urls = Array.from(
        { length: 75 },
        (_, i) => `https://example.com/random-${i}`,
      )
      const r = await classifyUrls({ urls, callAI: aiCall as any })
      expect(aiCall).toHaveBeenCalledTimes(2)
      expect(Object.values(r).every((v) => v === 'page')).toBe(true)
    })
  })
})
