/**
 * Gbox Platform — Metafields Service Unit Tests
 *
 * Focus areas:
 *   1. Validation rules (namespace, key, value_type enum, 5 MB value cap)
 *   2. Round-trip (setMetafield → getMetafield → deleteMetafield)
 *   3. *ById methods with cross-shop isolation
 *   4. Update-path value_type preservation (the subtle bug we fixed)
 *
 * These tests use an in-memory fake of the Kysely methods we touch.
 * They avoid a real Postgres for speed and so they run on the Windows
 * dev host (no pg reachable) — route + integration tests live in the
 * platform-api package and run against the live `gbox_platform` DB
 * from server 2.
 */

import { describe, it, expect } from 'vitest'
import {
  setMetafield,
  getMetafield,
  listMetafields,
  deleteMetafield,
  getMetafieldById,
  updateMetafieldById,
  deleteMetafieldById,
  MAX_VALUE_BYTES,
  VALUE_TYPES,
} from './service.js'

// ---------------------------------------------------------------------------
// In-memory fake database — models the rows as a plain array and re-implements
// just the Kysely chain methods we actually call. Much closer to real behavior
// than the Proxy-mock the previous test file used (which didn't match the
// actual service API at all — see git history).
// ---------------------------------------------------------------------------

interface Row {
  id: string
  shop_id: string
  owner_type: string
  owner_id: string
  namespace: string
  key: string
  value: string // serialized JSON (DB stores JSONB, but Kysely returns the parsed shape; for our test purposes a string is fine — service never re-reads it)
  value_type: string
  description: string | null
  created_at: string
  updated_at: string
}

function createFakeDb(seed: Row[] = []) {
  const rows: Row[] = [...seed]
  let idSeq = rows.length + 1

  type Where = { field: keyof Row; value: unknown }

  function matches(r: Row, wheres: Where[]): boolean {
    return wheres.every((w) => (r as any)[w.field] === w.value)
  }

  function selectFrom(_table: 'metafields') {
    const wheres: Where[] = []
    const orders: Array<keyof Row> = []
    const chain: any = {
      selectAll: () => chain,
      where: (field: keyof Row, _op: string, value: unknown) => {
        wheres.push({ field, value })
        return chain
      },
      orderBy: (field: keyof Row) => {
        orders.push(field)
        return chain
      },
      executeTakeFirst: async () => rows.find((r) => matches(r, wheres)),
      execute: async () => {
        let out = rows.filter((r) => matches(r, wheres))
        if (orders.length) {
          out = [...out].sort((a, b) => {
            for (const f of orders) {
              const av = String((a as any)[f])
              const bv = String((b as any)[f])
              if (av < bv) return -1
              if (av > bv) return 1
            }
            return 0
          })
        }
        return out
      },
    }
    return chain
  }

  function updateTable(_table: 'metafields') {
    const wheres: Where[] = []
    let patch: Partial<Row> = {}
    const chain: any = {
      set: (p: Partial<Row>) => {
        patch = { ...patch, ...p }
        return chain
      },
      where: (field: keyof Row, _op: string, value: unknown) => {
        wheres.push({ field, value })
        return chain
      },
      returningAll: () => chain,
      executeTakeFirst: async () => {
        const target = rows.find((r) => matches(r, wheres))
        if (!target) return undefined
        Object.assign(target, patch)
        return { ...target }
      },
    }
    return chain
  }

  function insertInto(_table: 'metafields') {
    let v: Partial<Row> = {}
    const chain: any = {
      values: (x: Partial<Row>) => {
        v = x
        return chain
      },
      returningAll: () => chain,
      executeTakeFirstOrThrow: async () => {
        const now = new Date().toISOString()
        // Build row from caller values, then overwrite system fields. Using a
        // plain object and reassignment dodges TS2783 (spread + literal key
        // collision) while keeping the semantics we want.
        const row = { ...(v as Row) } as Row
        row.id = `mf-${idSeq++}`
        row.created_at = now
        row.updated_at = now
        if (row.description === undefined) row.description = null
        rows.push(row)
        return { ...row }
      },
    }
    return chain
  }

  function deleteFrom(_table: 'metafields') {
    const wheres: Where[] = []
    const chain: any = {
      where: (field: keyof Row, _op: string, value: unknown) => {
        wheres.push({ field, value })
        return chain
      },
      executeTakeFirst: async () => {
        const before = rows.length
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matches(rows[i]!, wheres)) rows.splice(i, 1)
        }
        return { numDeletedRows: BigInt(before - rows.length) }
      },
    }
    return chain
  }

  return {
    rows,
    selectFrom,
    updateTable,
    insertInto,
    deleteFrom,
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Metafields Service — validation', () => {
  it('rejects a namespace shorter than 3 chars', async () => {
    const db = createFakeDb()
    await expect(
      setMetafield(db, {
        shop_id: 'shop-1',
        owner_type: 'product',
        owner_id: 'prod-1',
        namespace: 'ab',
        key: 'color',
        value: 'red',
      }),
    ).rejects.toThrow(/namespace/i)
  })

  it('rejects a key with invalid characters', async () => {
    const db = createFakeDb()
    await expect(
      setMetafield(db, {
        shop_id: 'shop-1',
        owner_type: 'product',
        owner_id: 'prod-1',
        namespace: 'custom',
        key: 'has space',
        value: 'red',
      }),
    ).rejects.toThrow(/key/i)
  })

  it('rejects an unknown value_type enum', async () => {
    const db = createFakeDb()
    await expect(
      setMetafield(db, {
        shop_id: 'shop-1',
        owner_type: 'product',
        owner_id: 'prod-1',
        namespace: 'custom',
        key: 'color',
        value: 'red',
        value_type: 'mystery' as any,
      }),
    ).rejects.toThrow(/value_type/i)
  })

  it('rejects a value bigger than 5 MB', async () => {
    const db = createFakeDb()
    const huge = 'x'.repeat(MAX_VALUE_BYTES + 1)
    await expect(
      setMetafield(db, {
        shop_id: 'shop-1',
        owner_type: 'product',
        owner_id: 'prod-1',
        namespace: 'custom',
        key: 'big',
        value: huge,
      }),
    ).rejects.toThrow(/too large/i)
  })

  it('rejects a non-serializable value (function)', async () => {
    const db = createFakeDb()
    await expect(
      setMetafield(db, {
        shop_id: 'shop-1',
        owner_type: 'product',
        owner_id: 'prod-1',
        namespace: 'custom',
        key: 'bad',
        value: () => 'nope',
      }),
    ).rejects.toThrow(/JSON-serializable/i)
  })

  it('exports the canonical VALUE_TYPES enum', () => {
    expect(VALUE_TYPES).toContain('single_line_text_field')
    expect(VALUE_TYPES).toContain('json')
    expect(VALUE_TYPES).toContain('reference')
    expect(VALUE_TYPES.length).toBeGreaterThanOrEqual(11)
  })
})

describe('Metafields Service — CRUD by tuple', () => {
  it('inserts on first setMetafield call', async () => {
    const db = createFakeDb()
    const mf = await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'color',
      value: 'red',
      value_type: 'single_line_text_field',
    })
    expect(mf.id).toMatch(/^mf-/)
    expect(mf.namespace).toBe('custom')
    expect(mf.key).toBe('color')
    expect(db.rows.length).toBe(1)
  })

  it('updates on second setMetafield call (same tuple)', async () => {
    const db = createFakeDb()
    await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'color',
      value: 'red',
      value_type: 'single_line_text_field',
    })
    const updated = await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'color',
      value: 'blue',
    })
    expect(db.rows.length).toBe(1)
    expect(JSON.parse(updated.value as unknown as string)).toBe('blue')
  })

  it('preserves existing value_type on update when caller omits it (bug fix)', async () => {
    const db = createFakeDb()
    await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'weight',
      value: 12,
      value_type: 'number_integer',
    })
    const updated = await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'weight',
      value: 15,
      // no value_type → must NOT revert to 'single_line_text_field'
    })
    expect(updated.value_type).toBe('number_integer')
  })

  it('returns null from getMetafield when tuple not found', async () => {
    const db = createFakeDb()
    const mf = await getMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-X',
      namespace: 'custom',
      key: 'gone',
    })
    expect(mf).toBeNull()
  })

  it('lists metafields for an owner, filtered by namespace', async () => {
    const db = createFakeDb()
    await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'color',
      value: 'red',
    })
    await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'size',
      value: 'large',
    })
    await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'seo',
      key: 'title',
      value: 'SEO Title',
    })

    const all = await listMetafields(db, 'shop-1', 'product', 'prod-1')
    expect(all.length).toBe(3)

    const custom = await listMetafields(db, 'shop-1', 'product', 'prod-1', 'custom')
    expect(custom.length).toBe(2)
    expect(custom.map((m) => m.key).sort()).toEqual(['color', 'size'])
  })

  it('deleteMetafield returns true only when a row was deleted', async () => {
    const db = createFakeDb()
    await setMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'toss',
      value: 'x',
    })
    const del1 = await deleteMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'toss',
    })
    expect(del1).toBe(true)

    const del2 = await deleteMetafield(db, {
      shop_id: 'shop-1',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'toss',
    })
    expect(del2).toBe(false)
  })
})

describe('Metafields Service — CRUD by ID (cross-shop isolation)', () => {
  it('getMetafieldById scopes by shop_id (prevents foreign-shop reads)', async () => {
    const db = createFakeDb()
    const mfA = await setMetafield(db, {
      shop_id: 'shop-A',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'color',
      value: 'red',
    })

    // Right shop → found
    expect(await getMetafieldById(db, 'shop-A', mfA.id)).not.toBeNull()
    // Wrong shop → null (never returns foreign shop's data)
    expect(await getMetafieldById(db, 'shop-B', mfA.id)).toBeNull()
  })

  it('updateMetafieldById returns null for foreign shop', async () => {
    const db = createFakeDb()
    const mf = await setMetafield(db, {
      shop_id: 'shop-A',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'color',
      value: 'red',
    })
    const fromForeign = await updateMetafieldById(db, mf.id, {
      shop_id: 'shop-B',
      value: 'hacked',
    })
    expect(fromForeign).toBeNull()

    // Row is untouched
    const untouched = await getMetafieldById(db, 'shop-A', mf.id)
    expect(JSON.parse(untouched!.value as unknown as string)).toBe('red')
  })

  it('updateMetafieldById only updates fields the caller passed', async () => {
    const db = createFakeDb()
    const mf = await setMetafield(db, {
      shop_id: 'shop-A',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'weight',
      value: 10,
      value_type: 'number_integer',
      description: 'Original desc',
    })

    // Only change the value. description + value_type must be preserved.
    const updated = await updateMetafieldById(db, mf.id, {
      shop_id: 'shop-A',
      value: 20,
    })
    expect(updated).not.toBeNull()
    expect(updated!.value_type).toBe('number_integer')
    expect(updated!.description).toBe('Original desc')
    expect(JSON.parse(updated!.value as unknown as string)).toBe(20)
  })

  it('deleteMetafieldById refuses cross-shop deletes', async () => {
    const db = createFakeDb()
    const mf = await setMetafield(db, {
      shop_id: 'shop-A',
      owner_type: 'product',
      owner_id: 'prod-1',
      namespace: 'custom',
      key: 'color',
      value: 'red',
    })
    const foreignDel = await deleteMetafieldById(db, 'shop-B', mf.id)
    expect(foreignDel).toBe(false)
    expect(db.rows.length).toBe(1) // still there

    const ownDel = await deleteMetafieldById(db, 'shop-A', mf.id)
    expect(ownDel).toBe(true)
    expect(db.rows.length).toBe(0)
  })
})
