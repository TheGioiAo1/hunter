/**
 * Gbox Platform — Storefront DbLoader tests (v1 + v2)
 *
 * Sprint 5 Task 5.1 (Clone Pro v7) extends the storefront DbLoader to
 * support TWO backing tables, switched by env flag:
 *
 *   THEME_LOADER_VERSION=v1 (default) → theme_assets (legacy v6 path)
 *   THEME_LOADER_VERSION=v2           → theme_files  (v7 generated themes)
 *
 * v2 row shape (from migration 097 + 101):
 *   shop_id     uuid     — scope
 *   path        text     — logical path (the v7 renderer writes 'templates/index.liquid')
 *   content     text     — file source
 *   theme_id    uuid     — bundle id (FK invariant: only one is_active per shop)
 *   version     int      — retry counter (Stage 16)
 *   is_active   bool     — exactly one active theme per shop
 *
 * NOTE on v2 schema: migration 097 created `theme_files (kind, source_url,
 * s3_key, cdn_url, byte_size)`; migration 101 added `theme_id, version,
 * is_active`. Sprint 4 generator writes additional columns `path` + `content`
 * which are persisted via `persistThemeFiles` callback. Tests use those
 * names (the loader queries `path` + `content`).
 *
 * Tests cover (6+ cases):
 *   1. v1 default routing — env unset → reads from theme_assets
 *   2. v2 routing — env=v2 → reads from theme_files (active theme only)
 *   3. v2 list() — returns theme_files paths (active rows only)
 *   4. v2 returns null for missing key
 *   5. Constructor allows override of version via opts
 *   6. v2 ignores inactive theme rows even if path matches
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { DbLoader } from './db-loader.js'

// ---------------------------------------------------------------------------
// Fake database with v1 (theme_assets) + v2 (theme_files) tables
// ---------------------------------------------------------------------------

interface FakeRow {
  table: 'theme_assets' | 'theme_files'
  // For v1
  theme_id?: string
  // For v2
  shop_id?: string
  is_active?: boolean
  // Common
  key?: string
  value?: string | null
  path?: string
  content?: string | null
  updated_at?: string
}

function createFakeDb(rows: FakeRow[]) {
  const fakeDb: any = {
    selectFrom: (table: string) => {
      const filtered = rows.filter((r) => r.table === table)
      const filters: Array<(r: FakeRow) => boolean> = []
      let cols: string[] = []

      const chain: any = {
        select: (...args: any[]) => {
          cols = args.flat()
          return chain
        },
        where: (col: string, op: string, val: any) => {
          if (op === '=') {
            filters.push((r) => (r as any)[col] === val)
          } else if (op === 'like') {
            const prefix = String(val).replace(/%$/, '')
            filters.push((r) => {
              const c = col === 'key' ? r.key : r.path
              return typeof c === 'string' && c.startsWith(prefix)
            })
          }
          return chain
        },
        orderBy: () => chain,
        executeTakeFirst: async () => {
          const r = filtered.find((row) => filters.every((f) => f(row)))
          if (!r) return undefined
          if (cols.length === 0) return r
          const out: any = {}
          for (const c of cols) out[c] = (r as any)[c] ?? null
          return out
        },
        execute: async () => {
          const matched = filtered.filter((row) => filters.every((f) => f(row)))
          if (cols.length === 0) return matched
          return matched.map((r) => {
            const out: any = {}
            for (const c of cols) out[c] = (r as any)[c] ?? null
            return out
          })
        },
      }
      return chain
    },
  }
  return fakeDb
}

// ---------------------------------------------------------------------------
// v1 (theme_assets) tests
// ---------------------------------------------------------------------------

describe('Storefront DbLoader — v1 (theme_assets, default)', () => {
  const v1Rows: FakeRow[] = [
    {
      table: 'theme_assets',
      theme_id: 'theme-abc',
      key: 'layout/theme.liquid',
      value: '<html>v1</html>',
      updated_at: '2026-04-01T00:00:00Z',
    },
    {
      table: 'theme_assets',
      theme_id: 'theme-abc',
      key: 'sections/header.liquid',
      value: '<header/>',
    },
  ]
  const db = createFakeDb(v1Rows)

  it('uses v1 (theme_assets) when version not specified (default)', async () => {
    const loader = new DbLoader(db, 'theme-abc')
    const src = await loader.load('layout/theme.liquid')
    expect(src).toBe('<html>v1</html>')
  })

  it('returns null for missing key in v1', async () => {
    const loader = new DbLoader(db, 'theme-abc')
    expect(await loader.load('missing.liquid')).toBeNull()
  })

  it('list() returns theme_assets keys for v1', async () => {
    const loader = new DbLoader(db, 'theme-abc')
    const keys = await loader.list()
    expect(keys).toContain('layout/theme.liquid')
    expect(keys).toContain('sections/header.liquid')
  })
})

// ---------------------------------------------------------------------------
// v2 (theme_files) tests
// ---------------------------------------------------------------------------

describe('Storefront DbLoader — v2 (theme_files)', () => {
  const v2Rows: FakeRow[] = [
    {
      table: 'theme_files',
      shop_id: 'shop-xyz',
      path: 'layout/theme.liquid',
      content: '<html>v2-active</html>',
      is_active: true,
      updated_at: '2026-05-01T00:00:00Z',
    },
    {
      table: 'theme_files',
      shop_id: 'shop-xyz',
      path: 'sections/footer.liquid',
      content: '<footer/>',
      is_active: true,
    },
    {
      // Inactive theme row — must NOT show up
      table: 'theme_files',
      shop_id: 'shop-xyz',
      path: 'layout/theme.liquid',
      content: '<html>v2-OLD</html>',
      is_active: false,
    },
  ]
  const db = createFakeDb(v2Rows)

  it('reads theme_files active row when version=v2', async () => {
    const loader = new DbLoader(db, 'shop-xyz', { version: 'v2' })
    const src = await loader.load('layout/theme.liquid')
    expect(src).toBe('<html>v2-active</html>')
  })

  it('does NOT return inactive theme rows (only is_active=true)', async () => {
    const loader = new DbLoader(db, 'shop-xyz', { version: 'v2' })
    const src = await loader.load('layout/theme.liquid')
    // Even though both rows match path, only the active one wins.
    expect(src).not.toContain('OLD')
  })

  it('returns null for missing key in v2', async () => {
    const loader = new DbLoader(db, 'shop-xyz', { version: 'v2' })
    expect(await loader.load('does/not/exist.liquid')).toBeNull()
  })

  it('list() returns theme_files paths for v2 (active only)', async () => {
    const loader = new DbLoader(db, 'shop-xyz', { version: 'v2' })
    const keys = await loader.list()
    expect(keys).toContain('layout/theme.liquid')
    expect(keys).toContain('sections/footer.liquid')
  })

  it('exists() returns true for active path in v2', async () => {
    const loader = new DbLoader(db, 'shop-xyz', { version: 'v2' })
    expect(await loader.exists('sections/footer.liquid')).toBe(true)
  })

  it('exists() returns false for missing path in v2', async () => {
    const loader = new DbLoader(db, 'shop-xyz', { version: 'v2' })
    expect(await loader.exists('not-here.liquid')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Env-flag routing
// ---------------------------------------------------------------------------

describe('Storefront DbLoader — env flag routing', () => {
  const originalEnv = process.env.THEME_LOADER_VERSION

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.THEME_LOADER_VERSION
    else process.env.THEME_LOADER_VERSION = originalEnv
  })

  it('THEME_LOADER_VERSION=v2 selects theme_files when no opts override', async () => {
    process.env.THEME_LOADER_VERSION = 'v2'
    const rows: FakeRow[] = [
      {
        table: 'theme_files',
        shop_id: 'shop-1',
        path: 'a.liquid',
        content: 'env-v2',
        is_active: true,
      },
    ]
    const db = createFakeDb(rows)
    const loader = new DbLoader(db, 'shop-1')
    expect(await loader.load('a.liquid')).toBe('env-v2')
  })

  it('THEME_LOADER_VERSION=v1 (or unset) falls back to theme_assets', async () => {
    delete process.env.THEME_LOADER_VERSION
    const rows: FakeRow[] = [
      {
        table: 'theme_assets',
        theme_id: 'theme-1',
        key: 'b.liquid',
        value: 'env-v1',
      },
    ]
    const db = createFakeDb(rows)
    const loader = new DbLoader(db, 'theme-1')
    expect(await loader.load('b.liquid')).toBe('env-v1')
  })

  it('explicit opts.version=v1 overrides env=v2', async () => {
    process.env.THEME_LOADER_VERSION = 'v2'
    const rows: FakeRow[] = [
      {
        table: 'theme_assets',
        theme_id: 'theme-1',
        key: 'c.liquid',
        value: 'opts-v1',
      },
    ]
    const db = createFakeDb(rows)
    const loader = new DbLoader(db, 'theme-1', { version: 'v1' })
    expect(await loader.load('c.liquid')).toBe('opts-v1')
  })
})
