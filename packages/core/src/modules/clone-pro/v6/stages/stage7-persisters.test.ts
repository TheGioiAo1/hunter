import { describe, it, expect, vi } from 'vitest'
import { runPersisters } from './stage7-persisters.js'

// ---------------------------------------------------------------------------
// Helper — build minimal empty DTOs bag
// ---------------------------------------------------------------------------
function makeEmptyDtos() {
  return {
    products: [],
    collections: [],
    pages: [],
    blogPosts: [],
    menus: [],
    themeTokens: null as any,
    themeFiles: [],
    urlRedirects: [],
    genericMedia: [],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Stage 7 — persister dispatch', () => {
  it('runs all configured persisters and aggregates results', async () => {
    const fakeProducts = {
      bucketName: 'products',
      persist: vi.fn().mockResolvedValue({ inserted: 5, updated: 0, skippedEdited: 0, errors: [] }),
    }
    const fakeCollections = {
      bucketName: 'collections',
      persist: vi.fn().mockResolvedValue({ inserted: 3, updated: 0, skippedEdited: 0, errors: [] }),
    }

    const r = await runPersisters({
      db: {} as any,
      shopId: 's',
      jobId: 'j',
      dtos: {
        ...makeEmptyDtos(),
        products: [{}],
        collections: [{}],
      },
      registry: {
        products: fakeProducts as any,
        collections: fakeCollections as any,
      },
    })

    expect(r.products.inserted).toBe(5)
    expect(r.collections.inserted).toBe(3)
    expect(r.pages).toEqual({ inserted: 0, updated: 0, skippedEdited: 0, errors: [] })
    expect(r.bucketFailures).toHaveLength(0)

    expect(fakeProducts.persist).toHaveBeenCalledOnce()
    expect(fakeCollections.persist).toHaveBeenCalledOnce()
  })

  it('5% per-bucket failure threshold marks bucket failed', async () => {
    // 56 DTOs — 6 errors = ~10.7% > 5% threshold → bucketFailures includes 'products'
    const errors = Array.from({ length: 6 }, (_, i) => ({ sourceHandle: `h${i}`, reason: 'fk' }))
    const fakeProducts = {
      bucketName: 'products',
      persist: vi.fn().mockResolvedValue({ inserted: 50, updated: 0, skippedEdited: 0, errors }),
    }

    const r = await runPersisters({
      db: {} as any,
      shopId: 's',
      jobId: 'j',
      dtos: {
        ...makeEmptyDtos(),
        products: Array.from({ length: 56 }, () => ({})),
      },
      registry: {
        products: fakeProducts as any,
      },
    })

    expect(r.bucketFailures).toContain('products')
  })

  it('does not flag bucket under threshold (5% boundary)', async () => {
    // 100 DTOs — 5 errors = exactly 5% which is NOT > 5% → no failure
    const errors = Array.from({ length: 5 }, (_, i) => ({ sourceHandle: `h${i}`, reason: 'fk' }))
    const fakeProducts = {
      bucketName: 'products',
      persist: vi.fn().mockResolvedValue({ inserted: 95, updated: 0, skippedEdited: 0, errors }),
    }

    const r = await runPersisters({
      db: {} as any,
      shopId: 's',
      jobId: 'j',
      dtos: {
        ...makeEmptyDtos(),
        products: Array.from({ length: 100 }, () => ({})),
      },
      registry: {
        products: fakeProducts as any,
      },
    })

    expect(r.bucketFailures).not.toContain('products')
  })

  it('skips unregistered buckets and empty dto arrays', async () => {
    const fakePages = {
      bucketName: 'pages',
      persist: vi.fn().mockResolvedValue({ inserted: 2, updated: 0, skippedEdited: 0, errors: [] }),
    }

    const r = await runPersisters({
      db: {} as any,
      shopId: 's',
      jobId: 'j',
      dtos: {
        ...makeEmptyDtos(),
        pages: [{}, {}],
        // products dtos provided but no persister registered
        products: [{}, {}],
      },
      registry: {
        pages: fakePages as any,
        // products intentionally absent
      },
    })

    expect(r.pages.inserted).toBe(2)
    expect(r.products).toEqual({ inserted: 0, updated: 0, skippedEdited: 0, errors: [] })
    expect(fakePages.persist).toHaveBeenCalledOnce()
  })

  it('wraps themeTokens single object into dtos array', async () => {
    const fakeThemeTokens = {
      bucketName: 'shop_theme_tokens',
      persist: vi.fn().mockResolvedValue({ inserted: 1, updated: 0, skippedEdited: 0, errors: [] }),
    }

    await runPersisters({
      db: {} as any,
      shopId: 's',
      jobId: 'j',
      dtos: {
        ...makeEmptyDtos(),
        themeTokens: { colors: {}, fonts: {}, spacing: {}, radii: {}, shadows: {}, raw: {} },
      },
      registry: {
        themeTokens: fakeThemeTokens as any,
      },
    })

    // Should be called with dtos array of length 1
    const callArg = fakeThemeTokens.persist.mock.calls[0][0]
    expect(callArg.dtos).toHaveLength(1)
  })
})
