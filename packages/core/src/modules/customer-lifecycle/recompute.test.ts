/**
 * Recompute service unit tests — Phase 4 PR3.
 *
 * Mocks the Kysely db via the same chainable-proxy pattern as the
 * customer-notes tests so we don't have to enumerate every .select /
 * .where / .limit / .execute call. Only the terminal methods
 * (execute / executeTakeFirst) return real fixture data.
 *
 * We skip the raw-SQL backfill step (passing `skipBackfill: true`)
 * because sql`...`.execute(db) is hard to mock cleanly — the server-2
 * smoke test exercises it for real.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  recomputeOneCustomerLifecycle,
  recomputeAllLifecycleStages,
} from './recompute.js'

const NOW = new Date('2026-04-20T12:00:00.000Z')

function daysAgo(days: number): Date {
  const d = new Date(NOW)
  d.setUTCDate(d.getUTCDate() - days)
  return d
}

// ---------------------------------------------------------------------------
// Chainable proxy — borrowed from customer-notes/service.test.ts.
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(
            Array.isArray(result) ? result : result == null ? [] : [result],
          )
        }
        if (prop === 'executeTakeFirst') {
          return vi.fn().mockResolvedValue(result ?? null)
        }
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result')
            return result
          })
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

// ---------------------------------------------------------------------------
// recomputeOneCustomerLifecycle
// ---------------------------------------------------------------------------

describe('recomputeOneCustomerLifecycle', () => {
  it('returns null when the customer does not exist', async () => {
    const db: any = {
      selectFrom: vi.fn().mockReturnValue(chainable(null)),
      updateTable: vi.fn(),
    }
    const result = await recomputeOneCustomerLifecycle(db, 'missing-id', { now: NOW })
    expect(result).toBeNull()
    expect(db.updateTable).not.toHaveBeenCalled()
  })

  it('is a no-op when the stage is already correct', async () => {
    const db: any = {
      selectFrom: vi.fn().mockReturnValue(
        chainable({
          orders_count: 1,
          last_order_at: daysAgo(3).toISOString(),
          lifecycle_stage: 'new',
        }),
      ),
      updateTable: vi.fn(),
    }
    const result = await recomputeOneCustomerLifecycle(db, 'cust-1', { now: NOW })
    expect(result).toBe('new')
    // No update when stage didn't change.
    expect(db.updateTable).not.toHaveBeenCalled()
  })

  it('writes the new stage when it changed (at_risk → churned)', async () => {
    const updateChain = chainable()
    const db: any = {
      selectFrom: vi.fn().mockReturnValue(
        chainable({
          orders_count: 5,
          last_order_at: daysAgo(200).toISOString(), // > 180 → churned
          lifecycle_stage: 'at_risk',
        }),
      ),
      updateTable: vi.fn().mockReturnValue(updateChain),
    }
    const result = await recomputeOneCustomerLifecycle(db, 'cust-2', { now: NOW })
    expect(result).toBe('churned')
    expect(db.updateTable).toHaveBeenCalledWith('customers')
  })

  it('flips new → returning when a 2nd recent order is counted', async () => {
    const db: any = {
      selectFrom: vi.fn().mockReturnValue(
        chainable({
          orders_count: 2,
          last_order_at: daysAgo(1).toISOString(),
          lifecycle_stage: 'new',
        }),
      ),
      updateTable: vi.fn().mockReturnValue(chainable()),
    }
    const result = await recomputeOneCustomerLifecycle(db, 'cust-3', { now: NOW })
    expect(result).toBe('returning')
    expect(db.updateTable).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// recomputeAllLifecycleStages
// ---------------------------------------------------------------------------

describe('recomputeAllLifecycleStages', () => {
  it('returns zeroes for an empty tenant', async () => {
    const db: any = {
      selectFrom: vi.fn().mockReturnValue(chainable([])),
      updateTable: vi.fn(),
    }
    const result = await recomputeAllLifecycleStages(db, {
      now: NOW,
      skipBackfill: true,
    })
    expect(result).toEqual({
      scanned: 0,
      updated: 0,
      backfilledLastOrderAt: 0,
    })
    expect(db.updateTable).not.toHaveBeenCalled()
  })

  it('reclassifies only rows whose stage drifted', async () => {
    // Three customers: one correctly tagged `new`, one stale at_risk →
    // churned, one stale new → returning. Only the latter two trigger
    // UPDATE calls.
    const customers = [
      {
        id: 'a',
        orders_count: 0,
        last_order_at: null,
        lifecycle_stage: 'new', // correct
      },
      {
        id: 'b',
        orders_count: 5,
        last_order_at: daysAgo(200).toISOString(),
        lifecycle_stage: 'at_risk', // drifted — should be churned
      },
      {
        id: 'c',
        orders_count: 3,
        last_order_at: daysAgo(2).toISOString(),
        lifecycle_stage: 'new', // drifted — should be returning
      },
    ]

    let selectCalls = 0
    const db: any = {
      selectFrom: vi.fn().mockImplementation(() => {
        selectCalls++
        // First call: return the 3 rows. Second keyset call: empty
        // (we pass batchSize >= 3 so the loop exits after page 1).
        return chainable(selectCalls === 1 ? customers : [])
      }),
      updateTable: vi.fn().mockReturnValue(chainable()),
    }

    const result = await recomputeAllLifecycleStages(db, {
      now: NOW,
      skipBackfill: true,
      batchSize: 500,
    })

    expect(result.scanned).toBe(3)
    expect(result.updated).toBe(2)
    expect(result.backfilledLastOrderAt).toBe(0)
    expect(db.updateTable).toHaveBeenCalledTimes(2)
  })

  it('paginates via keyset when a full batch comes back', async () => {
    // batchSize=1 forces two pages: first returns 1 row, we then keyset
    // past it and the second page returns empty → loop exits.
    let selectCalls = 0
    const db: any = {
      selectFrom: vi.fn().mockImplementation(() => {
        selectCalls++
        if (selectCalls === 1) {
          return chainable([
            {
              id: 'only',
              orders_count: 0,
              last_order_at: null,
              lifecycle_stage: 'new',
            },
          ])
        }
        return chainable([])
      }),
      updateTable: vi.fn(),
    }

    const result = await recomputeAllLifecycleStages(db, {
      now: NOW,
      skipBackfill: true,
      batchSize: 1,
    })

    expect(result.scanned).toBe(1)
    expect(result.updated).toBe(0)
    expect(selectCalls).toBeGreaterThanOrEqual(2)
  })
})
