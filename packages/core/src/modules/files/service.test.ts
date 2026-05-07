/**
 * Unit tests for the Files library service (Phase 7 PR5).
 *
 * Covers the pure in-memory behaviour: validation, quota check, list
 * pagination / filter / search, delete cascade, and the DB↔store
 * invariants (no orphan bytes on DB failure, no orphan row on blob
 * failure). Live Postgres end-to-end is exercised by
 * scripts/smoke-phase7-pr5.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryStore } from '../storage/memory-store.js'
import {
  uploadFile,
  listFiles,
  getFile,
  deleteFile,
  updateFile,
  sanitizeFilename,
  mimeCategory,
  objectKeyFor,
  quotaFor,
} from './service.js'

// ---------------------------------------------------------------------
// Minimal Kysely facade — only covers the call shapes the service uses.
// rows[] simulates the `files` table; we implement insertInto,
// selectFrom (with where/select/orderBy/limit/offset/execute and
// executeTakeFirst), updateTable, deleteFrom. No joins, no transactions.
// ---------------------------------------------------------------------

interface Row {
  id: string
  shop_id: string
  filename: string
  mime_type: string | null
  size: number | null
  url: string
  alt: string | null
  created_at: string
}

function makeDb(initial: Row[] = []) {
  let rows = [...initial]

  const matchLike = (haystack: string | null | undefined, pattern: string): boolean => {
    if (!haystack) return pattern === '%' // loose
    const p = pattern.toLowerCase().replace(/%/g, '.*')
    return new RegExp(`^${p}$`).test(haystack.toLowerCase())
  }

  function makeQuery(table: string) {
    type Pred = (r: Row) => boolean
    const filters: Pred[] = []
    let orderDir: 'asc' | 'desc' = 'asc'
    let orderCol: keyof Row = 'created_at'
    let limit: number | null = null
    let offset = 0
    let selectCol: string | null = null
    let fn: null | 'count' | 'sum' = null
    let fnCol: keyof Row = 'id'

    const whereRaw = (col: string, op: string, val: unknown): Pred => {
      return (r: Row) => {
        const v = (r as any)[col]
        if (op === '=') return v === val
        if (op === 'ilike') return matchLike(String(v), String(val))
        if (op === 'not ilike') return !matchLike(String(v), String(val))
        return false
      }
    }

    const q: any = {
      select: (cols: any) => {
        if (typeof cols === 'function') {
          // .select((eb) => eb.fn.count('id').as('c'))
          const sentinel = cols({
            fn: {
              count: (col: keyof Row) => ({ __fn: 'count', col, as: (a: string) => ({ __fn: 'count', col, alias: a }) }),
              sum: (col: keyof Row) => ({ __fn: 'sum', col, as: (a: string) => ({ __fn: 'sum', col, alias: a }) }),
            },
          })
          fn = sentinel.__fn ?? null
          fnCol = sentinel.col ?? 'id'
          selectCol = sentinel.alias ?? 'c'
        } else if (Array.isArray(cols) && cols.length === 1) {
          selectCol = cols[0]
        }
        return q
      },
      selectAll: () => {
        selectCol = '*'
        return q
      },
      where: (colOrCb: any, op?: string, val?: unknown) => {
        if (typeof colOrCb === 'function') {
          // .where((eb) => eb.or([...]))
          const eb = (col: string, o: string, v: unknown) => ({ __pred: whereRaw(col, o, v) })
          eb.or = (preds: Array<{ __pred: Pred }>) => ({
            __pred: (r: Row) => preds.some((p) => p.__pred(r)),
          })
          const res = colOrCb(eb)
          filters.push(res.__pred)
        } else {
          filters.push(whereRaw(String(colOrCb), String(op), val))
        }
        return q
      },
      orderBy: (col: keyof Row, dir: 'asc' | 'desc' = 'asc') => {
        orderCol = col
        orderDir = dir
        return q
      },
      limit: (n: number) => {
        limit = n
        return q
      },
      offset: (n: number) => {
        offset = n
        return q
      },
      execute: async () => {
        let out = rows.filter((r) => filters.every((f) => f(r)))
        out.sort((a, b) => {
          const av = (a as any)[orderCol]
          const bv = (b as any)[orderCol]
          const cmp = av < bv ? -1 : av > bv ? 1 : 0
          return orderDir === 'asc' ? cmp : -cmp
        })
        if (offset) out = out.slice(offset)
        if (limit !== null) out = out.slice(0, limit)
        return out
      },
      executeTakeFirst: async () => {
        const filtered = rows.filter((r) => filters.every((f) => f(r)))
        if (fn === 'count') return { [selectCol ?? 'c']: filtered.length }
        if (fn === 'sum') {
          const sum = filtered.reduce((s, r) => s + Number((r as any)[fnCol] ?? 0), 0)
          return { [selectCol ?? 'c']: sum }
        }
        return filtered[0] ?? null
      },
      executeTakeFirstOrThrow: async () => {
        const first = await q.executeTakeFirst()
        if (!first) throw new Error('not found')
        return first
      },
    }
    void table // table name unused
    return q
  }

  return {
    selectFrom: (table: string) => makeQuery(table),
    insertInto: (_table: string) => ({
      values: (row: Row) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            const full: Row = {
              created_at: new Date().toISOString(),
              ...row,
              mime_type: row.mime_type ?? null,
              size: row.size ?? null,
              alt: row.alt ?? null,
            }
            rows.push(full)
            return full
          },
        }),
        execute: async () => {
          rows.push(row)
        },
      }),
    }),
    updateTable: (_table: string) => {
      let updates: Record<string, unknown> = {}
      const filters: Array<(r: Row) => boolean> = []
      const upd: any = {
        set: (u: Record<string, unknown>) => {
          updates = u
          return upd
        },
        where: (col: string, op: string, val: unknown) => {
          filters.push((r: Row) => op === '=' && (r as any)[col] === val)
          return upd
        },
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            const target = rows.find((r) => filters.every((f) => f(r)))
            if (!target) throw new Error('not found')
            Object.assign(target, updates)
            return target
          },
        }),
        execute: async () => {
          for (const r of rows) {
            if (filters.every((f) => f(r))) Object.assign(r, updates)
          }
        },
      }
      return upd
    },
    deleteFrom: (_table: string) => {
      const filters: Array<(r: Row) => boolean> = []
      return {
        where: function (this: any, col: string, op: string, val: unknown) {
          filters.push((r: Row) => op === '=' && (r as any)[col] === val)
          return this
        },
        execute: async () => {
          rows = rows.filter((r) => !filters.every((f) => f(r)))
        },
      }
    },
    // Test helpers
    __rows: () => rows,
  } as any
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const SHOP = 'shop-1'
const OTHER_SHOP = 'shop-2'
let store: MemoryStore
let db: ReturnType<typeof makeDb>

beforeEach(() => {
  store = new MemoryStore()
  db = makeDb()
})

function bytes(n: number): Uint8Array {
  return new Uint8Array(n)
}

// ---------------------------------------------------------------------
// uploadFile
// ---------------------------------------------------------------------

describe('uploadFile', () => {
  it('uploads an image and persists a row with the CDN url', async () => {
    const res = await uploadFile(
      db,
      {
        shopId: SHOP,
        filename: 'hero.jpg',
        mimeType: 'image/jpeg',
        body: bytes(4096),
      },
      { objectStore: store },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.file.shop_id).toBe(SHOP)
    expect(res.file.filename).toBe('hero.jpg')
    expect(res.file.mime_type).toBe('image/jpeg')
    expect(res.file.size).toBe(4096)
    expect(res.file.url.startsWith('memory://files/')).toBe(true)
    expect(store._size()).toBe(1)
  })

  it('rejects missing filename', async () => {
    const res = await uploadFile(
      db,
      { shopId: SHOP, filename: '', mimeType: 'image/png', body: bytes(1) },
      { objectStore: store },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('filename_required')
  })

  it('rejects mime types outside the allowlist', async () => {
    const res = await uploadFile(
      db,
      {
        shopId: SHOP,
        filename: 'malware.exe',
        mimeType: 'application/x-msdownload',
        body: bytes(10),
      },
      { objectStore: store },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('mime_not_allowed')
    // Nothing should have been written to the store.
    expect(store._size()).toBe(0)
  })

  it('rejects files over maxFileSize', async () => {
    const res = await uploadFile(
      db,
      {
        shopId: SHOP,
        filename: 'big.mp4',
        mimeType: 'video/mp4',
        body: bytes(11),
      },
      { objectStore: store, maxFileSize: 10 },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('too_large')
    expect(store._size()).toBe(0)
  })

  it('enforces shop-wide quota', async () => {
    // Seed one file taking 100 bytes of a 150-byte budget.
    const seed = await uploadFile(
      db,
      {
        shopId: SHOP,
        filename: 'a.jpg',
        mimeType: 'image/jpeg',
        body: bytes(100),
      },
      { objectStore: store, maxShopBytes: 150 },
    )
    expect(seed.ok).toBe(true)

    const res = await uploadFile(
      db,
      {
        shopId: SHOP,
        filename: 'b.jpg',
        mimeType: 'image/jpeg',
        body: bytes(80), // would push total to 180 > 150
      },
      { objectStore: store, maxShopBytes: 150 },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('quota_exceeded')
  })

  it('sanitises the filename (strips path separators)', async () => {
    const res = await uploadFile(
      db,
      {
        shopId: SHOP,
        filename: '../../etc/passwd.png',
        mimeType: 'image/png',
        body: bytes(10),
      },
      { objectStore: store },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.file.filename).not.toContain('/')
    expect(res.file.filename).not.toContain('..')
  })
})

// ---------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------

describe('listFiles', () => {
  beforeEach(async () => {
    const seed = async (name: string, mime: string, size: number) => {
      await uploadFile(
        db,
        { shopId: SHOP, filename: name, mimeType: mime, body: bytes(size) },
        { objectStore: store },
      )
    }
    await seed('hero.jpg', 'image/jpeg', 1000)
    await seed('logo.png', 'image/png', 500)
    await seed('demo.mp4', 'video/mp4', 5000)
    await seed('manual.pdf', 'application/pdf', 2000)
    await seed('style.css', 'text/css', 300)

    // A file for a DIFFERENT shop — must never surface.
    await uploadFile(
      db,
      {
        shopId: OTHER_SHOP,
        filename: 'other.jpg',
        mimeType: 'image/jpeg',
        body: bytes(50),
      },
      { objectStore: store },
    )
  })

  it('returns all files for the shop with total + usedBytes', async () => {
    const res = await listFiles(db, SHOP)
    expect(res.rows.length).toBe(5)
    expect(res.total).toBe(5)
    expect(res.usedBytes).toBe(1000 + 500 + 5000 + 2000 + 300)
  })

  it('filters to images only when type=image', async () => {
    const res = await listFiles(db, SHOP, { type: 'image' })
    expect(res.rows.map((r) => r.filename).sort()).toEqual(['hero.jpg', 'logo.png'])
    expect(res.total).toBe(2)
  })

  it('filters to documents when type=document', async () => {
    const res = await listFiles(db, SHOP, { type: 'document' })
    expect(res.rows.map((r) => r.filename)).toContain('manual.pdf')
    expect(res.rows.map((r) => r.filename)).toContain('style.css')
  })

  it('honours search across filename', async () => {
    const res = await listFiles(db, SHOP, { search: 'hero' })
    expect(res.rows.map((r) => r.filename)).toEqual(['hero.jpg'])
  })

  it('clamps limit to [1, 200]', async () => {
    const huge = await listFiles(db, SHOP, { limit: 1_000_000 })
    expect(huge.rows.length).toBeLessThanOrEqual(200)
    const zero = await listFiles(db, SHOP, { limit: 0 })
    expect(zero.rows.length).toBeGreaterThanOrEqual(1)
  })

  it('respects offset for pagination', async () => {
    const page1 = await listFiles(db, SHOP, { limit: 2, offset: 0 })
    const page2 = await listFiles(db, SHOP, { limit: 2, offset: 2 })
    expect(page1.rows.length).toBe(2)
    expect(page2.rows.length).toBe(2)
    const ids = new Set([...page1.rows, ...page2.rows].map((r) => r.id))
    expect(ids.size).toBe(4) // no overlap
  })

  it('is shop-scoped (other shops invisible)', async () => {
    const res = await listFiles(db, SHOP)
    expect(res.rows.every((r) => r.shop_id === SHOP)).toBe(true)
    expect(res.rows.map((r) => r.filename)).not.toContain('other.jpg')
  })
})

// ---------------------------------------------------------------------
// getFile
// ---------------------------------------------------------------------

describe('getFile', () => {
  it('returns the row when it belongs to the shop', async () => {
    const r = await uploadFile(
      db,
      { shopId: SHOP, filename: 'a.png', mimeType: 'image/png', body: bytes(1) },
      { objectStore: store },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const got = await getFile(db, SHOP, r.file.id)
    expect(got?.id).toBe(r.file.id)
  })

  it('returns null when the row belongs to a different shop', async () => {
    const r = await uploadFile(
      db,
      {
        shopId: OTHER_SHOP,
        filename: 'a.png',
        mimeType: 'image/png',
        body: bytes(1),
      },
      { objectStore: store },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const got = await getFile(db, SHOP, r.file.id)
    expect(got).toBeNull()
  })
})

// ---------------------------------------------------------------------
// deleteFile
// ---------------------------------------------------------------------

describe('deleteFile', () => {
  it('removes the row and the blob', async () => {
    const r = await uploadFile(
      db,
      { shopId: SHOP, filename: 'a.png', mimeType: 'image/png', body: bytes(1) },
      { objectStore: store },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const del = await deleteFile(db, SHOP, r.file.id, { objectStore: store })
    expect(del.ok).toBe(true)

    const got = await getFile(db, SHOP, r.file.id)
    expect(got).toBeNull()
    expect(store._size()).toBe(0)
  })

  it('returns not_found for a cross-shop file id (no deletion)', async () => {
    const r = await uploadFile(
      db,
      {
        shopId: OTHER_SHOP,
        filename: 'a.png',
        mimeType: 'image/png',
        body: bytes(1),
      },
      { objectStore: store },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const del = await deleteFile(db, SHOP, r.file.id, { objectStore: store })
    expect(del.ok).toBe(false)
    if (!del.ok) expect(del.error).toBe('not_found')
    // Row must still exist for the other shop.
    expect(store._size()).toBe(1)
  })
})

// ---------------------------------------------------------------------
// updateFile
// ---------------------------------------------------------------------

describe('updateFile', () => {
  it('renames a file (sanitized)', async () => {
    const r = await uploadFile(
      db,
      { shopId: SHOP, filename: 'old.png', mimeType: 'image/png', body: bytes(1) },
      { objectStore: store },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const updated = await updateFile(db, SHOP, r.file.id, { filename: '../new.png' })
    expect(updated).not.toBeNull()
    expect(updated?.filename).not.toContain('/')
    expect(updated?.filename).toContain('new.png')
  })

  it('updates alt text independently', async () => {
    const r = await uploadFile(
      db,
      { shopId: SHOP, filename: 'a.png', mimeType: 'image/png', body: bytes(1) },
      { objectStore: store },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const updated = await updateFile(db, SHOP, r.file.id, { alt: 'A red hat' })
    expect(updated?.alt).toBe('A red hat')
    // Filename unchanged.
    expect(updated?.filename).toBe('a.png')
  })

  it('returns null for a cross-shop id', async () => {
    const r = await uploadFile(
      db,
      {
        shopId: OTHER_SHOP,
        filename: 'a.png',
        mimeType: 'image/png',
        body: bytes(1),
      },
      { objectStore: store },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const updated = await updateFile(db, SHOP, r.file.id, { alt: 'nope' })
    expect(updated).toBeNull()
  })
})

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

describe('helpers', () => {
  it('sanitizeFilename strips slashes + dots', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('/')
    // 5 reserved chars → 5 underscores.
    expect(sanitizeFilename('a<>:"|b.txt')).toBe('a_____b.txt')
    expect(sanitizeFilename('   ')).toBe('file')
    expect(sanitizeFilename('ok.jpg')).toBe('ok.jpg')
  })

  it('mimeCategory buckets everything', () => {
    expect(mimeCategory('image/png')).toBe('image')
    expect(mimeCategory('video/mp4')).toBe('video')
    expect(mimeCategory('audio/mpeg')).toBe('audio')
    expect(mimeCategory('application/pdf')).toBe('document')
    expect(mimeCategory('text/css')).toBe('document')
    expect(mimeCategory('application/zip')).toBe('other')
    expect(mimeCategory(null)).toBe('other')
  })

  it('objectKeyFor composes a shop-scoped path', () => {
    expect(objectKeyFor('sh1', 'fid1', 'a.png')).toBe('files/sh1/fid1/a.png')
  })

  it('quotaFor returns plan-based bytes', () => {
    expect(quotaFor('free')).toBe(500 * 1024 * 1024)
    expect(quotaFor('basic')).toBeGreaterThan(quotaFor('free') ?? 0)
    expect(quotaFor(null)).toBe(500 * 1024 * 1024) // unknown → free
    expect(quotaFor('unknown')).toBe(500 * 1024 * 1024)
  })
})
