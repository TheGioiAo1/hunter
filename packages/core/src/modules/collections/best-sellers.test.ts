/**
 * Gbox Platform — best-sellers ranker tests (Phase C3a)
 *
 * Verifies the ranker issues the right Kysely calls:
 *   - selectFrom('collection_products as cp')
 *   - innerJoin('products as p', ...)
 *   - orderBy('sold', 'desc')
 *   - orderBy('cp.position', 'asc')
 *   - where('cp.collection_id', '=', collectionId)
 *   - where('p.status', '=', 'active')
 *   - limit + offset applied
 *
 * The correlated subquery itself isn't evaluated against the fake DB —
 * the `sql` tagged template is passed through `select()` and the fake
 * just returns the pre-configured rows. This is sufficient for a unit
 * test; the actual SQL execution is validated against the live Postgres
 * test server (server 1) during smoke.
 */

import { describe, expect, it } from 'vitest'
import { rankCollectionBestSellers } from './best-sellers.js'

interface Call {
  method: string
  args: unknown[]
}

function createRankerFakeDb(rows: any[]) {
  const calls: Call[] = []
  const chain: any = {
    selectFrom: (table: string) => {
      calls.push({ method: 'selectFrom', args: [table] })
      return chain
    },
    innerJoin: (table: string, left: string, right: string) => {
      calls.push({ method: 'innerJoin', args: [table, left, right] })
      return chain
    },
    select: (arg: unknown) => {
      calls.push({ method: 'select', args: [arg] })
      return chain
    },
    where: (col: unknown, op?: unknown, val?: unknown) => {
      calls.push({ method: 'where', args: [col, op, val] })
      return chain
    },
    orderBy: (col: string, direction: string) => {
      calls.push({ method: 'orderBy', args: [col, direction] })
      return chain
    },
    limit: (n: number) => {
      calls.push({ method: 'limit', args: [n] })
      return chain
    },
    offset: (n: number) => {
      calls.push({ method: 'offset', args: [n] })
      return chain
    },
    execute: async () => rows,
  }
  // Top-level selectFrom proxy (first call on `db`)
  const db = {
    selectFrom: (table: string) => chain.selectFrom(table),
  }
  return { db, calls }
}

describe('rankCollectionBestSellers', () => {
  it('returns productIds in the order the query produced them', async () => {
    const { db } = createRankerFakeDb([
      { id: 'p-top', sold: 50 },
      { id: 'p-mid', sold: 10 },
      { id: 'p-tail', sold: 0 },
    ])
    const result = await rankCollectionBestSellers(db as any, {
      shopId: 'shop-1',
      collectionId: 'c-1',
      limit: 10,
      offset: 0,
    })
    // The ranker trusts the DB's ORDER BY; it just maps `id` out.
    expect(result.productIds).toEqual(['p-top', 'p-mid', 'p-tail'])
  })

  it('queries collection_products joined to products', async () => {
    const { db, calls } = createRankerFakeDb([])
    await rankCollectionBestSellers(db as any, {
      shopId: 'shop-1',
      collectionId: 'c-1',
      limit: 10,
      offset: 0,
    })
    expect(
      calls.some(
        (c) => c.method === 'selectFrom' && c.args[0] === 'collection_products as cp',
      ),
    ).toBe(true)
    expect(
      calls.some(
        (c) =>
          c.method === 'innerJoin' &&
          c.args[0] === 'products as p' &&
          c.args[1] === 'p.id' &&
          c.args[2] === 'cp.product_id',
      ),
    ).toBe(true)
  })

  it('orders by sold DESC (primary) and cp.position ASC (tiebreak)', async () => {
    const { db, calls } = createRankerFakeDb([])
    await rankCollectionBestSellers(db as any, {
      shopId: 'shop-1',
      collectionId: 'c-1',
      limit: 10,
      offset: 0,
    })
    const orderBys = calls.filter((c) => c.method === 'orderBy')
    // Primary sort must come FIRST — otherwise cp.position wins and
    // best-selling collapses into manual ordering again.
    expect(orderBys[0]?.args).toEqual(['sold', 'desc'])
    expect(orderBys[1]?.args).toEqual(['cp.position', 'asc'])
  })

  it('scopes by collection id and filters to active products', async () => {
    const { db, calls } = createRankerFakeDb([])
    await rankCollectionBestSellers(db as any, {
      shopId: 'shop-1',
      collectionId: 'c-abc',
      limit: 10,
      offset: 0,
    })
    expect(
      calls.some(
        (c) =>
          c.method === 'where' &&
          c.args[0] === 'cp.collection_id' &&
          c.args[1] === '=' &&
          c.args[2] === 'c-abc',
      ),
    ).toBe(true)
    expect(
      calls.some(
        (c) =>
          c.method === 'where' &&
          c.args[0] === 'p.status' &&
          c.args[1] === '=' &&
          c.args[2] === 'active',
      ),
    ).toBe(true)
  })

  it('honours limit + offset for pagination', async () => {
    const { db, calls } = createRankerFakeDb([])
    await rankCollectionBestSellers(db as any, {
      shopId: 'shop-1',
      collectionId: 'c-1',
      limit: 25,
      offset: 50,
    })
    expect(calls.some((c) => c.method === 'limit' && c.args[0] === 25)).toBe(true)
    expect(calls.some((c) => c.method === 'offset' && c.args[0] === 50)).toBe(true)
  })

  it('propagates query errors so the caller can fall back to manual', async () => {
    const db: any = {
      selectFrom: () => {
        throw new Error('pg_connection_refused')
      },
    }
    await expect(
      rankCollectionBestSellers(db, {
        shopId: 'shop-1',
        collectionId: 'c-1',
        limit: 10,
        offset: 0,
      }),
    ).rejects.toThrow('pg_connection_refused')
  })
})
