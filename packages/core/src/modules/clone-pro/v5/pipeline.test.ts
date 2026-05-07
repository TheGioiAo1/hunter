import { describe, it, expect } from 'vitest'
import { runCloneProV5 } from './pipeline.js'
import type { PipelineContext } from './types.js'

describe('runCloneProV5', () => {
  it('runs phases ①→⑨ in order on the happy path', async () => {
    const order: string[] = []
    const scrapers = {
      detectPlatform: async () => {
        order.push('detect')
        return 'shopify' as const
      },
      scrapeProducts: async () => {
        order.push('scrape-products')
        return []
      },
      scrapeCollections: async () => {
        order.push('scrape-collections')
        return []
      },
      scrapePages: async () => {
        order.push('scrape-pages')
        return []
      },
      parseMenu: () => {
        order.push('parse-menu')
        return { handle: 'main', nodes: [] }
      },
      extractTokens: () => {
        order.push('extract-tokens')
        return {
          colors: { primary: null, secondary: null, background: null, text: null },
          typography: { heading_family: null, body_family: null, base_size_px: null },
          spacing: { base_px: null },
          radius_px: null,
          raw_css_vars: {},
        }
      },
      fetchHomepage: async () => {
        order.push('fetch-homepage')
        return '<html></html>'
      },
    }
    const persisters = {
      persistAll: async () => {
        order.push('persist')
        return {
          productsInserted: 0,
          collectionsInserted: 0,
          pagesInserted: 0,
          menuItems: 0,
        }
      },
      mountPreview: async () => {
        order.push('mount-preview')
        return 'https://abc.clone-preview.gbox.local'
      },
    }
    const verify = {
      routeCheck: async () => {
        order.push('route-check')
        return { total: 0, passCount: 0, passRate: 1, failures: [] }
      },
    }
    const ctx: PipelineContext = {
      jobId: 'job-1',
      shopId: 'shop-1',
      sourceUrl: 'https://x.com',
      sourceHost: 'x.com',
      scope: { products: true, collections: true, pages: true, menu: true, theme: true },
    }

    const result = await runCloneProV5(ctx, { scrapers, persisters, verify } as any)

    // Detect + fetch-homepage run before the scrape batch; the three
    // scrapeX calls inside Promise.all are order-indeterminate in principle
    // but ours complete synchronously in their declared order so we can
    // still assert the exact sequence. Tweak if the impl swaps them.
    expect(order).toEqual([
      'detect',
      'fetch-homepage',
      'scrape-products',
      'scrape-collections',
      'scrape-pages',
      'parse-menu',
      'extract-tokens',
      'persist',
      'mount-preview',
      'route-check',
    ])
    expect(result.grade.letter).toMatch(/[A-F]/)
    expect(result.previewUrl).toMatch(/clone-preview/)
    expect(result.platform).toBe('shopify')
    expect(result.designMd).toContain('# x.com')
  })

  it('fails job + surfaces error when platform detect returns unknown', async () => {
    const scrapers = { detectPlatform: async () => 'unknown' as const }
    const ctx: PipelineContext = {
      jobId: 'j',
      shopId: 's',
      sourceUrl: 'https://x.com',
      sourceHost: 'x.com',
      scope: { products: true, collections: true, pages: true, menu: true, theme: true },
    }
    await expect(runCloneProV5(ctx, { scrapers } as any)).rejects.toThrow(/platform/i)
  })

  it('rejects non-Shopify platforms in PR1 scope', async () => {
    const scrapers = { detectPlatform: async () => 'woocommerce' as const }
    const ctx: PipelineContext = {
      jobId: 'j',
      shopId: 's',
      sourceUrl: 'https://x.com',
      sourceHost: 'x.com',
      scope: { products: true, collections: true, pages: true, menu: true, theme: true },
    }
    await expect(runCloneProV5(ctx, { scrapers } as any)).rejects.toThrow(/woocommerce/)
  })

  it('counts nested menu nodes correctly when computing menu_resolution_pct', async () => {
    // Menu has 3 nodes total (root Shop + nested Men + root Gone).
    // We'll mark Shop's URL as imported (via products scraping), leaving
    // Men + Gone broken — menuResolutionPct = 1 - 2/3 ≈ 0.333.
    const scrapers = {
      detectPlatform: async () => 'shopify' as const,
      fetchHomepage: async () => '<html></html>',
      scrapeProducts: async () => [
        {
          source_id: '1',
          handle: 'shop',
          title: 'Shop',
          body_html: '',
          vendor: null,
          product_type: null,
          tags: [],
          images: [{ src: 'x', alt: null, position: 0 }],
          variants: [],
          options: [],
        },
      ],
      scrapeCollections: async () => [],
      scrapePages: async () => [],
      parseMenu: () => ({
        handle: 'main',
        nodes: [
          {
            label: 'Shop',
            url: 'https://x.com/products/shop',
            children: [
              { label: 'Men', url: 'https://x.com/broken-men', children: [] },
            ],
          },
          { label: 'Gone', url: 'https://x.com/broken-gone', children: [] },
        ],
      }),
      extractTokens: () => ({
        colors: { primary: null, secondary: null, background: null, text: null },
        typography: { heading_family: null, body_family: null, base_size_px: null },
        spacing: { base_px: null },
        radius_px: null,
        raw_css_vars: {},
      }),
    }
    const persisters = {
      persistAll: async () => ({
        productsInserted: 1,
        collectionsInserted: 0,
        pagesInserted: 0,
        menuItems: 3,
      }),
      mountPreview: async () => 'https://abc.clone-preview.gbox.local',
    }
    const verify = {
      routeCheck: async () => ({
        total: 1,
        passCount: 1,
        passRate: 1,
        failures: [],
      }),
    }
    const ctx: PipelineContext = {
      jobId: 'j',
      shopId: 's',
      sourceUrl: 'https://x.com',
      sourceHost: 'x.com',
      scope: { products: true, collections: true, pages: true, menu: true, theme: true },
    }
    const result = await runCloneProV5(ctx, { scrapers, persisters, verify } as any)
    // stats.menuBroken should count Men + Gone (2 broken out of 3 total).
    expect(result.stats.menuBroken).toBe(2)
    // menu_resolution_pct ≈ 1/3 ≈ 0.333; grade breakdown reflects that.
    expect(result.grade.breakdown.menu_resolution_pct).toBeCloseTo(1 / 3, 2)
  })
})
