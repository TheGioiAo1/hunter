/**
 * Tests for the Clone Library read helpers (Phase 4.4).
 *
 * These are pure query-shape tests — they mock Kysely with a chainable
 * Proxy and assert that:
 *
 *   - `listLibraryCards` short-circuits to [] when no shops are passed
 *   - each status filter ('completed' | 'failed' | 'running' | 'all')
 *     applies the right IN list (or none)
 *   - limit is clamped to [1, 500]
 *   - `getLibraryJob` returns null when the user has no shops and
 *     also when the row lookup comes back empty
 *
 * No Postgres contact. The `.execute()` return value is whatever the
 * mock hands back, so the tests don't pin actual DB semantics.
 */

import { describe, it, expect, vi } from 'vitest'
import { listLibraryCards, getLibraryJob } from './queries.js'

// ---------------------------------------------------------------------------
// Chainable mock
// ---------------------------------------------------------------------------

interface Call {
  method: string
  args: unknown[]
}

function chainable(finalRows: unknown[] = [], log: Call[] = []): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(finalRows)
        }
        if (prop === 'executeTakeFirst') {
          return vi.fn().mockResolvedValue(finalRows[0] ?? null)
        }
        return (...args: unknown[]) => {
          log.push({ method: String(prop), args })
          return chainable(finalRows, log)
        }
      },
    },
  )
}

function mockDb(rows: unknown[] = []) {
  const log: Call[] = []
  const db: any = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      log.push({ method: 'selectFrom', args: [table] })
      return chainable(rows, log)
    }),
  }
  return { db, log }
}

// Find the args of the N-th `where` call (1-indexed).
function nthWhere(log: Call[], n: number): unknown[] {
  const wheres = log.filter((c) => c.method === 'where')
  return wheres[n - 1]?.args ?? []
}

// ---------------------------------------------------------------------------
// listLibraryCards
// ---------------------------------------------------------------------------

describe('listLibraryCards', () => {
  it('returns [] immediately when userShopIds is empty — no query issued', async () => {
    const { db, log } = mockDb([])
    const rows = await listLibraryCards(db, { userShopIds: [] })
    expect(rows).toEqual([])
    // Short-circuit means the query builder is never touched.
    expect(log.filter((c) => c.method === 'selectFrom')).toHaveLength(0)
  })

  it('scopes to the given shop ids and filters out discarded jobs', async () => {
    const { db, log } = mockDb([])
    await listLibraryCards(db, { userShopIds: ['shop-1', 'shop-2'] })

    // First where: shop_id IN (…)
    const shopWhere = nthWhere(log, 1)
    expect(shopWhere[0]).toBe('j.shop_id')
    expect(shopWhere[1]).toBe('in')
    expect(shopWhere[2]).toEqual(['shop-1', 'shop-2'])

    // Second where: discarded_at IS NULL
    const discardedWhere = nthWhere(log, 2)
    expect(discardedWhere[0]).toBe('j.discarded_at')
    expect(discardedWhere[1]).toBe('is')
    expect(discardedWhere[2]).toBeNull()
  })

  it("applies statusFilter='completed' as status IN (succeeded, published)", async () => {
    const { db, log } = mockDb([])
    await listLibraryCards(db, {
      userShopIds: ['shop-1'],
      statusFilter: 'completed',
    })
    const statusWhere = nthWhere(log, 3)
    expect(statusWhere[0]).toBe('j.status')
    expect(statusWhere[1]).toBe('in')
    expect(statusWhere[2]).toEqual(['succeeded', 'published'])
  })

  it("applies statusFilter='failed' as status IN (failed, cancelled)", async () => {
    const { db, log } = mockDb([])
    await listLibraryCards(db, {
      userShopIds: ['shop-1'],
      statusFilter: 'failed',
    })
    const statusWhere = nthWhere(log, 3)
    expect(statusWhere[2]).toEqual(['failed', 'cancelled'])
  })

  it("applies statusFilter='running' as status IN (queued, running)", async () => {
    const { db, log } = mockDb([])
    await listLibraryCards(db, {
      userShopIds: ['shop-1'],
      statusFilter: 'running',
    })
    const statusWhere = nthWhere(log, 3)
    expect(statusWhere[2]).toEqual(['queued', 'running'])
  })

  it("statusFilter='all' adds no third where", async () => {
    const { db, log } = mockDb([])
    await listLibraryCards(db, { userShopIds: ['shop-1'], statusFilter: 'all' })
    const wheres = log.filter((c) => c.method === 'where')
    expect(wheres).toHaveLength(2)
  })

  it('clamps limit to at most 500 and at least 1', async () => {
    const { db, log: log1 } = mockDb([])
    await listLibraryCards(db, { userShopIds: ['shop-1'], limit: 5000 })
    const hiLimit = log1.find((c) => c.method === 'limit')
    expect(hiLimit?.args[0]).toBe(500)

    const m2 = mockDb([])
    await listLibraryCards(m2.db, { userShopIds: ['shop-1'], limit: 0 })
    const loLimit = m2.log.find((c) => c.method === 'limit')
    expect(loLimit?.args[0]).toBe(1)
  })

  it('defaults limit to 100 when omitted', async () => {
    const { db, log } = mockDb([])
    await listLibraryCards(db, { userShopIds: ['shop-1'] })
    const limit = log.find((c) => c.method === 'limit')
    expect(limit?.args[0]).toBe(100)
  })

  it('orders by created_at desc (newest first)', async () => {
    const { db, log } = mockDb([])
    await listLibraryCards(db, { userShopIds: ['shop-1'] })
    const orderBy = log.find((c) => c.method === 'orderBy')
    expect(orderBy?.args).toEqual(['j.created_at', 'desc'])
  })
})

// ---------------------------------------------------------------------------
// getLibraryJob
// ---------------------------------------------------------------------------

describe('getLibraryJob', () => {
  it('returns null immediately when userShopIds is empty', async () => {
    const { db } = mockDb([])
    const row = await getLibraryJob(db, { jobId: 'j1', userShopIds: [] })
    expect(row).toBeNull()
  })

  it('returns null when the job row is not found', async () => {
    const { db } = mockDb([]) // executeTakeFirst → null
    const row = await getLibraryJob(db, { jobId: 'j1', userShopIds: ['s1'] })
    expect(row).toBeNull()
  })

  it('enriches the row with a sampleProductIds array on success', async () => {
    // Two selectFrom calls happen: one on storefront_clone_jobs, one
    // on products. We can't easily route rows-by-table with our
    // simple mock, so we use a router-style mock:
    const jobRow = {
      jobId: 'j1',
      shopId: 's1',
      shopName: 'Shop One',
      shopSlug: 'shop-one',
      sourceUrl: 'https://example.com',
      status: 'succeeded',
      createdAt: new Date('2026-04-01'),
      finishedAt: new Date('2026-04-01'),
      label: null,
      themeId: 't1',
      themeName: 'Theme One',
      productCount: 3,
      pageCount: 1,
      blogCount: 0,
      collectionCount: 2,
    }

    const db: any = {
      selectFrom: vi.fn().mockImplementation((table: string) => {
        if (table === 'storefront_clone_jobs as j') {
          return chainable([jobRow], [])
        }
        if (table === 'products') {
          return chainable(
            [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
            [],
          )
        }
        return chainable([], [])
      }),
    }

    const row = await getLibraryJob(db, { jobId: 'j1', userShopIds: ['s1'] })
    expect(row).not.toBeNull()
    expect(row?.jobId).toBe('j1')
    expect(row?.sampleProductIds).toEqual(['p1', 'p2', 'p3'])
  })
})
