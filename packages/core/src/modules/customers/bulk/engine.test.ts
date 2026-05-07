/**
 * Bulk engine unit tests — Phase 4 PR5.
 *
 * Covers the dispatcher + the column-setter path end-to-end with a
 * thin fake db. The tag path uses raw `sql` templates (unnest +
 * array_agg) which are hard to mock at the proxy level, so we assert
 * tag-path invariants at the surface (dedupe, case handling, empty
 * input → zero call) and let the live smoke on server 2 exercise the
 * real array semantics.
 */

import { describe, it, expect, vi } from 'vitest'
import { applyBulkAction, type BulkAction } from './engine.js'

const SHOP = 'shop-a'

// ---------------------------------------------------------------------------
// Fake db — records every touch + returns canned results.
// ---------------------------------------------------------------------------

interface Recorder {
  /** `{op, args}` for every terminal call (execute / executeTakeFirst). */
  updates: Array<{ op: string; set?: any; where: any[] }>
  /** Raw SQL strings we saw via `sql`...`.compile() / .execute()`. */
  sqlCalls: Array<{ sql: string; parameters: any[] }>
  /** Matched rows returned by the pre-check selectFrom('customers'). */
  matched: Array<{ id: string }>
  /** numUpdatedRows reported by the column-setter branch. */
  numUpdated: number
}

function makeDb(rec: Recorder) {
  const whereChain = {
    _where: [] as any[],
  }

  function makeUpdateChain(setVal: any) {
    const chain: any = {
      set(x: any) {
        setVal = x
        return chain
      },
      where(...args: any[]) {
        whereChain._where.push(args)
        return chain
      },
      async executeTakeFirst() {
        rec.updates.push({ op: 'update', set: setVal, where: [...whereChain._where] })
        whereChain._where = []
        return { numUpdatedRows: BigInt(rec.numUpdated) }
      },
    }
    return chain
  }

  function makeSelectChain() {
    const chain: any = {
      select: () => chain,
      where: () => chain,
      async execute() {
        return rec.matched
      },
    }
    return chain
  }

  const fakeTx = {
    updateTable(table: string) {
      expect(table).toBe('customers')
      return makeUpdateChain(undefined)
    },
    // Raw-SQL path: `sql`...`.execute(tx)` ultimately calls
    // `tx.executeQuery(compiled)`. We stub it to produce N returning rows
    // so the engine's `result.rows.length` reflects N updates.
    async executeQuery(compiled: any) {
      rec.sqlCalls.push({ sql: compiled.sql, parameters: compiled.parameters })
      return { rows: rec.matched.map((m) => ({ id: m.id })) }
    },
  }

  return {
    selectFrom(table: string) {
      expect(table).toBe('customers')
      return makeSelectChain()
    },
    transaction: () => ({
      execute: async (cb: (tx: any) => Promise<any>) => cb(fakeTx),
    }),
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyBulkAction', () => {
  it('returns zeros on empty ids without hitting the db', async () => {
    const selectSpy = vi.fn()
    const db: any = { selectFrom: selectSpy, transaction: vi.fn() }
    const res = await applyBulkAction(db, SHOP, [], { type: 'disable' })
    expect(res).toEqual({ affected: 0, skipped: 0, matched: 0 })
    expect(selectSpy).not.toHaveBeenCalled()
  })

  it('dedupes + filters falsy ids before the matched pre-check', async () => {
    const rec: Recorder = { updates: [], sqlCalls: [], matched: [], numUpdated: 0 }
    const db = makeDb(rec)
    // `skipped` should reflect "clean count - matched count", not
    // the raw input length including duplicates.
    const res = await applyBulkAction(db, SHOP, ['a', 'a', '', 'b'], {
      type: 'disable',
    })
    // 2 unique ids, 0 matched → 2 skipped, 0 affected.
    expect(res).toEqual({ affected: 0, skipped: 2, matched: 0 })
  })

  it('disable writes status=disabled inside a transaction', async () => {
    const rec: Recorder = {
      updates: [],
      sqlCalls: [],
      matched: [{ id: 'c1' }, { id: 'c2' }],
      numUpdated: 2,
    }
    const db = makeDb(rec)
    const res = await applyBulkAction(db, SHOP, ['c1', 'c2', 'foreign-shop-id'], {
      type: 'disable',
    })
    // Only 2 matched our shop; 1 was cross-shop → skipped.
    expect(res).toEqual({ affected: 2, skipped: 1, matched: 2 })
    expect(rec.updates).toHaveLength(1)
    expect(rec.updates[0]!.set).toEqual({ status: 'disabled' })
    // shop_id predicate MUST be present — cross-shop defense.
    const shopWhere = rec.updates[0]!.where.find((w) => w[0] === 'shop_id')
    expect(shopWhere).toEqual(['shop_id', '=', SHOP])
  })

  it('enable writes status=active (not "enabled" — violates check constraint)', async () => {
    const rec: Recorder = { updates: [], sqlCalls: [], matched: [{ id: 'c1' }], numUpdated: 1 }
    const db = makeDb(rec)
    await applyBulkAction(db, SHOP, ['c1'], { type: 'enable' })
    expect(rec.updates[0]!.set).toEqual({ status: 'active' })
  })

  it('set_lifecycle writes the stage string', async () => {
    const rec: Recorder = { updates: [], sqlCalls: [], matched: [{ id: 'c1' }], numUpdated: 1 }
    const db = makeDb(rec)
    await applyBulkAction(db, SHOP, ['c1'], { type: 'set_lifecycle', stage: 'churned' })
    expect(rec.updates[0]!.set).toEqual({ lifecycle_stage: 'churned' })
  })

  it('subscribe_marketing / unsubscribe_marketing toggle accepts_marketing', async () => {
    // Subscribe.
    {
      const rec: Recorder = {
        updates: [],
        sqlCalls: [],
        matched: [{ id: 'c1' }],
        numUpdated: 1,
      }
      const db = makeDb(rec)
      await applyBulkAction(db, SHOP, ['c1'], { type: 'subscribe_marketing' })
      expect(rec.updates[0]!.set).toEqual({ accepts_marketing: true })
    }
    // Unsubscribe.
    {
      const rec: Recorder = {
        updates: [],
        sqlCalls: [],
        matched: [{ id: 'c1' }],
        numUpdated: 1,
      }
      const db = makeDb(rec)
      await applyBulkAction(db, SHOP, ['c1'], { type: 'unsubscribe_marketing' })
      expect(rec.updates[0]!.set).toEqual({ accepts_marketing: false })
    }
  })

  it('add_tags with only whitespace tags is a no-op (no SQL issued)', async () => {
    const rec: Recorder = {
      updates: [],
      sqlCalls: [],
      matched: [{ id: 'c1' }],
      numUpdated: 0,
    }
    const db = makeDb(rec)
    const res = await applyBulkAction(db, SHOP, ['c1'], { type: 'add_tags', tags: ['', '   '] })
    // matched was 1, but affected stays 0 because we short-circuited
    // before issuing the UPDATE.
    expect(res.matched).toBe(1)
    expect(res.affected).toBe(0)
    expect(rec.sqlCalls).toHaveLength(0)
  })

  it('remove_tags with only whitespace tags is a no-op', async () => {
    const rec: Recorder = {
      updates: [],
      sqlCalls: [],
      matched: [{ id: 'c1' }],
      numUpdated: 0,
    }
    const db = makeDb(rec)
    const res = await applyBulkAction(db, SHOP, ['c1'], {
      type: 'remove_tags',
      tags: [''],
    })
    expect(res.affected).toBe(0)
    expect(rec.sqlCalls).toHaveLength(0)
  })

  // Raw-SQL array semantics are hard to fake via proxies because
  // Kysely's RawBuilder needs a full QueryExecutor. We pin the SQL
  // shape via source-level assertions here; the actual array_agg /
  // array-diff runtime is exercised on server 2 in the live smoke.
  describe('tag SQL shape (source-level)', () => {
    // Lazily require at test-time so we read the latest on-disk src.
    const src = async () => {
      const fs = await import('node:fs/promises')
      return fs.readFile(
        new URL('./engine.ts', import.meta.url),
        'utf8',
      )
    }

    it('add_tags uses array_agg DISTINCT over unnest of existing || new', async () => {
      const s = await src()
      expect(s).toMatch(/UPDATE customers/)
      expect(s).toMatch(/array_agg\(DISTINCT\s+tag\s+ORDER\s+BY\s+tag\)/i)
      expect(s).toMatch(/unnest\(COALESCE\(tags,\s*ARRAY\[\]::text\[\]\)\s*\|\|/i)
    })

    it('remove_tags uses array(SELECT ... WHERE tag <> ALL) difference', async () => {
      const s = await src()
      expect(s).toMatch(/SET\s+tags\s*=\s*ARRAY\(/i)
      expect(s).toMatch(/WHERE\s+tag\s*<>\s*ALL\(/i)
    })

    it('both tag paths scope on shop_id AND use ANY(uuid[]) for ids', async () => {
      const s = await src()
      const anyUuidMatches = s.match(/id\s*=\s*ANY\(\$\{ids\}::uuid\[\]\)/g) ?? []
      expect(anyUuidMatches.length).toBeGreaterThanOrEqual(2)
      const shopMatches = s.match(/shop_id\s*=\s*\$\{shopId\}/g) ?? []
      expect(shopMatches.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('throws on an unknown action type (exhaustiveness check)', async () => {
    const rec: Recorder = { updates: [], sqlCalls: [], matched: [{ id: 'c1' }], numUpdated: 0 }
    const db = makeDb(rec)
    await expect(
      applyBulkAction(db, SHOP, ['c1'], { type: 'BAD' as any } as BulkAction),
    ).rejects.toThrow(/unknown bulk action/)
  })
})
