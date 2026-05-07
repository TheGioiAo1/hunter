/**
 * Stage 4 v7 — Lonspy bulk crawl tests.
 *
 * Sprint 2 Task 2.4. Replaces v6 Stage 4 (AI Sonnet bucket scrapers)
 * with a Lonspy XPath bulk extractor. Three responsibilities:
 *   1. Dispatch crawler v7 (`crawlSite`) to harvest the full catalog.
 *   2. Persist a `clone_crawl_runs` audit row with platform / config /
 *      counts / quality_score / duration_ms.
 *   3. Quality gate: throw if quality_score < 0.95.
 *
 * The unit suite mocks the crawler and the DB so Stage 4 stays pure.
 */

import { describe, it, expect, vi } from 'vitest'
import { runStage4LonspyBulk, QualityBelowThresholdError } from './stage4-lonspy-bulk.js'
import type { CrawlResult, Row } from '../../v7-crawler/types.js'

function mkCompleteRow(handle: string): Row {
  return {
    Title: `Product ${handle}`,
    ImageUrls: ['https://cdn/x.jpg'],
    Description: 'A long enough description. '.padEnd(220, 'x'),
    Price: 19.99,
    Link: `https://shop.com/products/${handle}`,
  }
}
function mkIncompleteRow(handle: string): Row {
  return {
    Title: `Product ${handle}`,
    ImageUrls: [],
    Description: 'short',
    Price: 19.99,
    Link: `https://shop.com/products/${handle}`,
  }
}

function mkDb(insertSpy?: (vals: unknown) => void): any {
  return {
    insertInto: () => ({
      values: (vals: unknown) => ({
        execute: async () => {
          insertSpy?.(vals)
        },
      }),
    }),
  }
}

describe('runStage4LonspyBulk', () => {
  it('returns DTOs + persists audit row on full-quality crawl', async () => {
    const insertCalls: unknown[] = []
    const crawl = vi.fn(
      async (): Promise<CrawlResult> => ({
        source_url: 'https://shop.com/collections/all',
        platform: 'shopify-classic',
        config_used: 'shopify-products-json',
        products: [mkCompleteRow('a'), mkCompleteRow('b')],
        collections: [],
        pages: [],
        warnings: [],
      }),
    )
    const result = await runStage4LonspyBulk({
      jobId: 'job-1',
      sourceUrl: 'https://shop.com',
      productsLimit: 10,
      db: mkDb((v) => insertCalls.push(v)),
      crawl,
    })
    expect(result.products).toHaveLength(2)
    expect(result.collections).toEqual([])
    expect(result.pages).toEqual([])
    expect(insertCalls).toHaveLength(1)
    const inserted = insertCalls[0] as Record<string, unknown>
    expect(inserted.job_id).toBe('job-1')
    expect(inserted.platform).toBe('shopify-classic')
    expect(inserted.config_used).toBe('shopify-products-json')
    expect(inserted.rows_harvested).toBe(2)
    expect(inserted.rows_failed).toBe(0)
    expect(Number(inserted.quality_score)).toBe(1)
  })

  it('passes products_limit through to the crawler', async () => {
    const crawl = vi.fn(
      async (): Promise<CrawlResult> => ({
        source_url: 'https://shop.com',
        platform: 'shopify-classic',
        config_used: 'shopify-products-json',
        products: [mkCompleteRow('x')],
        collections: [],
        pages: [],
        warnings: [],
      }),
    )
    await runStage4LonspyBulk({
      jobId: 'job-2',
      sourceUrl: 'https://shop.com',
      productsLimit: 200,
      db: mkDb(),
      crawl,
    })
    expect(crawl).toHaveBeenCalledWith(
      'https://shop.com',
      expect.objectContaining({ products_limit: 200 }),
    )
  })

  it('passes null products_limit through (full crawl)', async () => {
    const crawl = vi.fn(
      async (): Promise<CrawlResult> => ({
        source_url: 'https://shop.com',
        platform: 'shopify-classic',
        config_used: 'x',
        products: [mkCompleteRow('y')],
        collections: [],
        pages: [],
        warnings: [],
      }),
    )
    await runStage4LonspyBulk({
      jobId: 'job-3',
      sourceUrl: 'https://shop.com',
      productsLimit: null,
      db: mkDb(),
      crawl,
    })
    expect(crawl).toHaveBeenCalledWith(
      'https://shop.com',
      expect.objectContaining({ products_limit: null }),
    )
  })

  it('throws QualityBelowThresholdError when score < 0.95', async () => {
    // 1 complete + 9 incomplete → score 0.10
    const products: Row[] = [
      mkCompleteRow('a'),
      ...Array.from({ length: 9 }, (_, i) => mkIncompleteRow(`bad-${i}`)),
    ]
    const crawl = async (): Promise<CrawlResult> => ({
      source_url: 'https://shop.com',
      platform: 'shopify-classic',
      config_used: 'x',
      products,
      collections: [],
      pages: [],
      warnings: [],
    })
    await expect(
      runStage4LonspyBulk({
        jobId: 'job-4',
        sourceUrl: 'https://shop.com',
        productsLimit: null,
        db: mkDb(),
        crawl,
      }),
    ).rejects.toBeInstanceOf(QualityBelowThresholdError)
  })

  it('still persists the crawl_runs row even when quality fails', async () => {
    // Quality gate should throw AFTER persisting the audit row so god-admin
    // can still see what happened.
    const inserted: unknown[] = []
    const products: Row[] = [
      ...Array.from({ length: 3 }, (_, i) => mkIncompleteRow(`bad-${i}`)),
    ]
    const crawl = async (): Promise<CrawlResult> => ({
      source_url: 'https://shop.com',
      platform: 'shopify-classic',
      config_used: 'x',
      products,
      collections: [],
      pages: [],
      warnings: [],
    })
    await expect(
      runStage4LonspyBulk({
        jobId: 'job-5',
        sourceUrl: 'https://shop.com',
        productsLimit: null,
        db: mkDb((v) => inserted.push(v)),
        crawl,
      }),
    ).rejects.toBeInstanceOf(QualityBelowThresholdError)
    expect(inserted).toHaveLength(1)
  })

  it('passes quality gate at exactly 0.95 threshold', async () => {
    // 19 complete + 1 incomplete = 0.95 → MUST pass.
    const products: Row[] = [
      ...Array.from({ length: 19 }, (_, i) => mkCompleteRow(`good-${i}`)),
      mkIncompleteRow('one-bad'),
    ]
    const crawl = async (): Promise<CrawlResult> => ({
      source_url: 'https://shop.com',
      platform: 'shopify-classic',
      config_used: 'x',
      products,
      collections: [],
      pages: [],
      warnings: [],
    })
    const result = await runStage4LonspyBulk({
      jobId: 'job-6',
      sourceUrl: 'https://shop.com',
      productsLimit: null,
      db: mkDb(),
      crawl,
    })
    expect(result.products.length).toBe(20)
  })

  it('produces empty DTO arrays when crawler returns 0 products + warning', async () => {
    // 0 products = 0/0 quality, special-cased to "empty crawl" — Stage
    // 4 must still throw QualityBelowThreshold so the pipeline doesn't
    // proceed to publish an empty store.
    const crawl = async (): Promise<CrawlResult> => ({
      source_url: 'https://shop.com',
      platform: 'unknown',
      config_used: 'unknown',
      products: [],
      collections: [],
      pages: [],
      warnings: ['no products found'],
    })
    await expect(
      runStage4LonspyBulk({
        jobId: 'job-7',
        sourceUrl: 'https://shop.com',
        productsLimit: null,
        db: mkDb(),
        crawl,
      }),
    ).rejects.toBeInstanceOf(QualityBelowThresholdError)
  })

  it('maps crawler collection summary into CollectionDTO output', async () => {
    const crawl = async (): Promise<CrawlResult> => ({
      source_url: 'https://shop.com/collections/all',
      platform: 'shopify-classic',
      config_used: 'shopify-products-json',
      products: [mkCompleteRow('a'), mkCompleteRow('b')],
      collections: [
        {
          handle: 'all',
          title: 'All Products',
          product_handles: ['a', 'b'],
        },
      ],
      pages: [],
      warnings: [],
    })
    const result = await runStage4LonspyBulk({
      jobId: 'job-8',
      sourceUrl: 'https://shop.com/collections/all',
      productsLimit: null,
      db: mkDb(),
      crawl,
    })
    expect(result.collections).toHaveLength(1)
    expect(result.collections[0].sourceHandle).toBe('all')
    expect(result.collections[0].productHandles).toEqual(['a', 'b'])
  })

  it('stores duration_ms in audit row', async () => {
    const inserted: unknown[] = []
    const crawl = async (): Promise<CrawlResult> => {
      // Simulate 50ms crawler work.
      await new Promise((resolve) => setTimeout(resolve, 50))
      return {
        source_url: 'https://shop.com',
        platform: 'shopify-classic',
        config_used: 'x',
        products: [mkCompleteRow('a')],
        collections: [],
        pages: [],
        warnings: [],
      }
    }
    await runStage4LonspyBulk({
      jobId: 'job-9',
      sourceUrl: 'https://shop.com',
      productsLimit: null,
      db: mkDb((v) => inserted.push(v)),
      crawl,
    })
    const row = inserted[0] as Record<string, unknown>
    expect(typeof row.duration_ms).toBe('number')
    expect(row.duration_ms as number).toBeGreaterThanOrEqual(40)
  })
})
