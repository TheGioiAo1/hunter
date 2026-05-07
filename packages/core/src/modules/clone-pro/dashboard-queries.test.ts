/**
 * Unit tests for dashboard-queries.ts — the merchant dashboard read
 * helpers that feed the clone-pro index page, detail page, and stats
 * strip.
 *
 * These are shape / filter-contract tests: we assert that each helper
 * targets the `storefront_clone_jobs` table (per 2026-04-17 pivot),
 * filters by the right `status` bucket, and applies `shop_id`
 * correctly. A chainable Proxy mocks the Kysely query builder so we
 * can capture calls without a real Postgres connection — the same
 * approach the existing `run.test.ts` uses.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  listActiveJobs,
  listJobHistory,
  getDashboardStats,
  getReadyToPublishJobs,
  averageGradeLabel,
} from './dashboard-queries.js'

interface QueryCallLog {
  table: string | null
  whereCalls: Array<[string, string, unknown]>
  whereInCalls: Array<[string, string, unknown]>
  orderByCalls: Array<[string, string]>
  limitCalls: number[]
  offsetCalls: number[]
  executeResults: unknown[]
}

function createMockDb(rows: unknown[]): { db: any; log: QueryCallLog } {
  const log: QueryCallLog = {
    table: null,
    whereCalls: [],
    whereInCalls: [],
    orderByCalls: [],
    limitCalls: [],
    offsetCalls: [],
    executeResults: rows,
  }

  const qb: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(log.executeResults)
        }
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockResolvedValue({ n: log.executeResults.length })
        }
        if (prop === 'where') {
          return vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
            if (op === 'in') log.whereInCalls.push([col, op, val])
            else log.whereCalls.push([col, op, val])
            return qb
          })
        }
        if (prop === 'orderBy') {
          return vi.fn().mockImplementation((col: string, dir: string) => {
            log.orderByCalls.push([col, dir])
            return qb
          })
        }
        if (prop === 'limit') {
          return vi.fn().mockImplementation((n: number) => {
            log.limitCalls.push(n)
            return qb
          })
        }
        if (prop === 'offset') {
          return vi.fn().mockImplementation((n: number) => {
            log.offsetCalls.push(n)
            return qb
          })
        }
        return vi.fn().mockReturnValue(qb)
      },
    },
  )

  const db = {
    selectFrom: vi.fn().mockImplementation((t: string) => {
      log.table = t
      return qb
    }),
  }

  return { db, log }
}

describe('dashboard-queries — public API', () => {
  it('exports the four helpers as functions', () => {
    expect(typeof listActiveJobs).toBe('function')
    expect(typeof listJobHistory).toBe('function')
    expect(typeof getDashboardStats).toBe('function')
    expect(typeof getReadyToPublishJobs).toBe('function')
  })
})

describe('listActiveJobs', () => {
  it('targets storefront_clone_jobs (pivot target)', async () => {
    const { db, log } = createMockDb([])
    await listActiveJobs(db as any, 'shop-1')
    expect(log.table).toBe('storefront_clone_jobs')
  })

  it('filters by shop_id and the active-status bucket', async () => {
    const { db, log } = createMockDb([])
    await listActiveJobs(db as any, 'shop-42')
    const shopClause = log.whereCalls.find(([c]) => c === 'shop_id')
    expect(shopClause).toBeDefined()
    expect(shopClause![2]).toBe('shop-42')

    const statusClause = log.whereInCalls.find(([c]) => c === 'status')
    expect(statusClause).toBeDefined()
    expect(statusClause![2]).toEqual(['running', 'paused', 'failed'])
  })

  it('orders by created_at desc', async () => {
    const { db, log } = createMockDb([])
    await listActiveJobs(db as any, 'shop-1')
    expect(log.orderByCalls).toContainEqual(['created_at', 'desc'])
  })
})

describe('getReadyToPublishJobs', () => {
  it('filters succeeded + unpublished + not discarded', async () => {
    const { db, log } = createMockDb([])
    await getReadyToPublishJobs(db as any, 'shop-1')
    expect(log.table).toBe('storefront_clone_jobs')

    const status = log.whereCalls.find(([c]) => c === 'status')
    expect(status?.[1]).toBe('=')
    expect(status?.[2]).toBe('succeeded')

    const pub = log.whereCalls.find(([c]) => c === 'published_at')
    expect(pub?.[1]).toBe('is')
    expect(pub?.[2]).toBeNull()

    const disc = log.whereCalls.find(([c]) => c === 'discarded_at')
    expect(disc?.[1]).toBe('is')
    expect(disc?.[2]).toBeNull()
  })

  it('orders by finished_at desc', async () => {
    const { db, log } = createMockDb([])
    await getReadyToPublishJobs(db as any, 'shop-1')
    expect(log.orderByCalls).toContainEqual(['finished_at', 'desc'])
  })
})

describe('listJobHistory', () => {
  it('applies shop filter, limit, and offset', async () => {
    const { db, log } = createMockDb([])
    await listJobHistory(db as any, { shopId: 'shop-1', limit: 25, offset: 50 })
    expect(log.table).toBe('storefront_clone_jobs')
    expect(log.limitCalls).toContain(25)
    expect(log.offsetCalls).toContain(50)
    expect(log.whereCalls.find(([c]) => c === 'shop_id')?.[2]).toBe('shop-1')
  })

  it('applies status filter when supplied', async () => {
    const { db, log } = createMockDb([])
    await listJobHistory(db as any, {
      shopId: 'shop-1',
      statusFilter: 'succeeded',
      limit: 10,
      offset: 0,
    })
    const s = log.whereCalls.find(([c]) => c === 'status')
    expect(s?.[2]).toBe('succeeded')
  })

  it('applies search filter as ILIKE on source_url when supplied', async () => {
    const { db, log } = createMockDb([])
    await listJobHistory(db as any, {
      shopId: 'shop-1',
      search: 'shop2',
      limit: 10,
      offset: 0,
    })
    const s = log.whereCalls.find(([c]) => c === 'source_url')
    expect(s).toBeDefined()
    expect(s?.[2]).toMatch(/shop2/)
  })

  it('returns { rows, total } shape', async () => {
    const { db } = createMockDb([{ id: 'a' }, { id: 'b' }])
    const out = await listJobHistory(db as any, { shopId: 'shop-1', limit: 10, offset: 0 })
    expect(out).toHaveProperty('rows')
    expect(out).toHaveProperty('total')
    expect(Array.isArray(out.rows)).toBe(true)
    expect(typeof out.total).toBe('number')
  })
})

describe('getDashboardStats', () => {
  it('returns total + published + avgGrade + costCents30d', async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 45 * 24 * 3600_000).toISOString()
    const recent = new Date(now.getTime() - 5 * 24 * 3600_000).toISOString()
    const rows = [
      { status: 'succeeded', grade: 'A', cost_cents: 50, published_at: recent, created_at: recent },
      { status: 'succeeded', grade: 'B', cost_cents: 30, published_at: null, created_at: recent },
      { status: 'failed', grade: null, cost_cents: 0, published_at: null, created_at: old },
    ]
    const { db } = createMockDb(rows)
    const stats = await getDashboardStats(db as any, 'shop-1')
    expect(stats.total).toBe(3)
    expect(stats.published).toBe(1)
    expect(stats.avgGrade).toBe('A') // (4+3)/2 = 3.5 → A
    // Only recent rows contribute (50 + 30); the old row is outside 30d.
    expect(stats.costCents30d).toBe(80)
  })

  it('returns em-dash placeholder when no grades are set', async () => {
    const { db } = createMockDb([])
    const stats = await getDashboardStats(db as any, 'shop-1')
    expect(stats.total).toBe(0)
    expect(stats.avgGrade).toBe('—')
    expect(stats.costCents30d).toBe(0)
  })
})

describe('averageGradeLabel (helper)', () => {
  it('maps grade averages to letters', () => {
    expect(averageGradeLabel([])).toBe('—')
    expect(averageGradeLabel(['A', 'A', 'A'])).toBe('A')
    expect(averageGradeLabel(['A', 'B'])).toBe('A')   // 3.5 avg → A
    expect(averageGradeLabel(['B', 'B'])).toBe('B')   // 3.0 avg → B
    expect(averageGradeLabel(['B', 'C'])).toBe('B')   // 2.5 avg → B
    expect(averageGradeLabel(['C', 'C'])).toBe('C')   // 2.0 avg → C
    expect(averageGradeLabel(['F', 'F'])).toBe('F')   // 0.0 → F
  })
})
