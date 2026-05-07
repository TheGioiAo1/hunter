/**
 * Theme Versions — unit tests
 *
 * Cases:
 *   1. createSnapshot writes a row with version=1 on first call
 *   2. createSnapshot increments version monotonically
 *   3. createSnapshot embeds files+sections+globalSettings into snapshot_json
 *   4. createSnapshot stamps published_at when status=published
 *   5. listVersions newest first
 *   6. listVersions caps limit
 *   7. restoreVersion throws when version not found
 *   8. restoreVersion throws on cross-theme restore attempt
 *   9. restoreVersion throws on corrupt snapshot
 *  10. restoreVersion replays files+sections+global into the target theme
 */

import { describe, it, expect } from 'vitest'
import { createSnapshot, listVersions, restoreVersion } from './versions.js'

interface DbFx {
  themes: Map<string, any>
  files: any[]
  sections: any[]
  globals: Map<string, any>
  versions: any[]
  /** Captured INSERT/DELETE shape for assertions. */
  ops: Array<{ op: string; table: string; values?: any; where?: any }>
}

function makeFx(): DbFx {
  return {
    themes: new Map(),
    files: [],
    sections: [],
    globals: new Map(),
    versions: [],
    ops: [],
  }
}

function mockDb(fx: DbFx) {
  const builder: any = {
    selectFrom(table: string) {
      const q: any = { kind: 'select', table, where: [], orderBy: [], limit: null, isAggregate: false }
      const leaf: any = {
        select(cols: any) {
          if (typeof cols === 'function') q.isAggregate = true
          return leaf
        },
        where(col: string, _op: string, val: any) {
          q.where.push({ col: col.includes('.') ? col.split('.').pop() : col, val })
          return leaf
        },
        orderBy() { return leaf },
        limit(n: number) { q.limit = n; return leaf },
        async executeTakeFirst() {
          if (table === 'themes') {
            for (const t of fx.themes.values()) {
              if (q.where.every((w: any) => (t as any)[w.col] === w.val)) return t
            }
            return undefined
          }
          if (table === 'theme_versions' && q.isAggregate) {
            const filtered = fx.versions.filter((v) =>
              q.where.every((w: any) => v[w.col] === w.val),
            )
            const max = filtered.length ? Math.max(...filtered.map((v) => v.version)) : null
            return { max_version: max }
          }
          if (table === 'theme_versions') {
            return fx.versions.find((v) => q.where.every((w: any) => v[w.col] === w.val))
          }
          if (table === 'theme_global_settings') {
            for (const g of fx.globals.values()) {
              if (q.where.every((w: any) => (g as any)[w.col] === w.val)) return g
            }
            return undefined
          }
        },
        async execute() {
          if (table === 'theme_files') {
            return fx.files.filter((f) => q.where.every((w: any) => f[w.col] === w.val))
          }
          if (table === 'theme_page_sections') {
            return fx.sections.filter((s) => q.where.every((w: any) => s[w.col] === w.val))
          }
          if (table === 'theme_versions') {
            const arr = fx.versions
              .filter((v) => q.where.every((w: any) => v[w.col] === w.val))
              .slice()
              .sort((a, b) => b.version - a.version)
            return q.limit ? arr.slice(0, q.limit) : arr
          }
          return []
        },
      }
      return leaf
    },
    insertInto(table: string) {
      const q: any = { kind: 'insert', table, values: undefined, returning: undefined }
      const leaf: any = {
        values(v: any) { q.values = v; return leaf },
        returning() { return leaf },
        async executeTakeFirstOrThrow() {
          fx.ops.push({ op: 'insert', table, values: q.values })
          if (table === 'theme_versions') {
            const id = 'v-' + Math.random().toString(36).slice(2, 7)
            const row = { id, ...q.values, created_at: new Date().toISOString() }
            fx.versions.push(row)
            return { id }
          }
          return { id: 'auto' }
        },
        async execute() {
          fx.ops.push({ op: 'insert', table, values: q.values })
          if (table === 'theme_files') fx.files.push(q.values)
          if (table === 'theme_page_sections') fx.sections.push(q.values)
          if (table === 'theme_global_settings') fx.globals.set(q.values.theme_id, q.values)
        },
      }
      return leaf
    },
    deleteFrom(table: string) {
      const q: any = { kind: 'delete', table, where: [] }
      const leaf: any = {
        where(col: string, _op: string, val: any) {
          q.where.push({ col: col.includes('.') ? col.split('.').pop() : col, val })
          return leaf
        },
        async execute() {
          fx.ops.push({ op: 'delete', table, where: q.where })
          if (table === 'theme_files') {
            fx.files = fx.files.filter((f) => !q.where.every((w: any) => f[w.col] === w.val))
          }
          if (table === 'theme_page_sections') {
            fx.sections = fx.sections.filter((s) => !q.where.every((w: any) => s[w.col] === w.val))
          }
          if (table === 'theme_global_settings') {
            for (const k of Array.from(fx.globals.keys())) {
              const g = fx.globals.get(k)
              if (q.where.every((w: any) => g[w.col] === w.val)) fx.globals.delete(k)
            }
          }
        },
      }
      return leaf
    },
    transaction() {
      return { async execute(fn: any) { return await fn(builder) } }
    },
  }
  return builder
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('createSnapshot', () => {
  it('writes a row with version=1 on first call', async () => {
    const fx = makeFx()
    fx.themes.set('t1', { id: 't1', shop_id: 'shop-A' })
    fx.files.push({ theme_id: 't1', path: 'layout/theme.liquid', kind: 'liquid', content: '<html></html>', custom_css: null })

    const out = await createSnapshot(mockDb(fx), 't1')
    expect(out.version).toBe(1)
    expect(typeof out.id).toBe('string')
    expect(fx.versions[0].theme_id).toBe('t1')
    expect(fx.versions[0].snapshot_json.files).toHaveLength(1)
  })

  it('increments version monotonically', async () => {
    const fx = makeFx()
    fx.themes.set('t1', { id: 't1', shop_id: 'shop-A' })
    fx.versions.push({ id: 'v0', theme_id: 't1', version: 7, status: 'draft', snapshot_json: {} })

    const out = await createSnapshot(mockDb(fx), 't1')
    expect(out.version).toBe(8)
  })

  it('embeds files+sections+globalSettings in snapshot_json', async () => {
    const fx = makeFx()
    fx.themes.set('t1', { id: 't1', shop_id: 'shop-A' })
    fx.files.push({ theme_id: 't1', path: 'layout/theme.liquid', kind: 'liquid', content: 'x', custom_css: null })
    fx.sections.push({ theme_id: 't1', page_type: 'index', section_key: 'hero', section_type: 'hero', position: 0, settings_json: { h: 'Hi' }, blocks_json: [], custom_css: null, enabled: true })
    fx.globals.set('t1', { theme_id: 't1', settings_json: { color: '#000' }, schema_json: {} })

    const out = await createSnapshot(mockDb(fx), 't1', { label: 'Pre-publish', createdBy: 'user-1' })
    const snap = fx.versions[0].snapshot_json
    expect(snap.files).toHaveLength(1)
    expect(snap.pageSections).toHaveLength(1)
    expect(snap.pageSections[0].settings_json).toEqual({ h: 'Hi' })
    expect(snap.globalSettings.settings_json).toEqual({ color: '#000' })
    expect(fx.versions[0].label).toBe('Pre-publish')
    expect(fx.versions[0].created_by).toBe('user-1')
    expect(fx.versions[0].published_at).toBeNull()
  })

  it('stamps published_at when status=published', async () => {
    const fx = makeFx()
    fx.themes.set('t1', { id: 't1', shop_id: 'shop-A' })
    await createSnapshot(mockDb(fx), 't1', { status: 'published' })
    expect(typeof fx.versions[0].published_at).toBe('string')
  })
})

describe('listVersions', () => {
  it('returns rows newest first', async () => {
    const fx = makeFx()
    fx.versions.push({ id: 'a', theme_id: 't1', version: 1, status: 'draft', label: null, created_by: null, published_at: null, created_at: 'x' })
    fx.versions.push({ id: 'b', theme_id: 't1', version: 3, status: 'published', label: 'p', created_by: null, published_at: 'x', created_at: 'x' })
    fx.versions.push({ id: 'c', theme_id: 't1', version: 2, status: 'draft', label: null, created_by: null, published_at: null, created_at: 'x' })

    const rows = await listVersions(mockDb(fx), 't1')
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1])
  })

  it('caps limit', async () => {
    const fx = makeFx()
    for (let i = 1; i <= 5; i++) {
      fx.versions.push({ id: 'v' + i, theme_id: 't1', version: i, status: 'draft', label: null, created_by: null, published_at: null, created_at: 'x' })
    }
    const rows = await listVersions(mockDb(fx), 't1', 3)
    expect(rows).toHaveLength(3)
    expect(rows[0].version).toBe(5)
  })
})

describe('restoreVersion', () => {
  it('throws when version not found', async () => {
    const fx = makeFx()
    await expect(restoreVersion(mockDb(fx), 't1', 'missing')).rejects.toThrow(/not found/i)
  })

  it('throws on cross-theme restore attempt', async () => {
    const fx = makeFx()
    fx.versions.push({ id: 'v1', theme_id: 'OTHER', version: 1, snapshot_json: { capturedAt: 'x', schemaVersion: 1, files: [], pageSections: [], globalSettings: null } })
    await expect(restoreVersion(mockDb(fx), 't1', 'v1')).rejects.toThrow(/does not belong/i)
  })

  it('throws on corrupt snapshot', async () => {
    const fx = makeFx()
    fx.versions.push({ id: 'v1', theme_id: 't1', version: 1, snapshot_json: 'not-an-object' })
    fx.themes.set('t1', { id: 't1', shop_id: 'shop-A' })
    await expect(restoreVersion(mockDb(fx), 't1', 'v1')).rejects.toThrow(/corrupt/i)
  })

  it('replays files+sections+global into the target theme', async () => {
    const fx = makeFx()
    fx.themes.set('t1', { id: 't1', shop_id: 'shop-A' })
    fx.files.push({ theme_id: 't1', path: 'layout/old.liquid', kind: 'liquid', content: 'OLD', custom_css: null })
    fx.sections.push({ theme_id: 't1', page_type: 'index', section_key: 'old', section_type: 'old', position: 0, settings_json: {}, blocks_json: [], custom_css: null, enabled: true })

    fx.versions.push({
      id: 'v1',
      theme_id: 't1',
      version: 5,
      snapshot_json: {
        capturedAt: '2026-04-01T00:00:00Z',
        schemaVersion: 1,
        files: [
          { path: 'layout/theme.liquid', kind: 'liquid', content: 'RESTORED', custom_css: null },
        ],
        pageSections: [
          { page_type: 'index', section_key: 'hero', section_type: 'hero', position: 0, settings_json: { h: 'Hi' }, blocks_json: [], custom_css: null, enabled: true },
        ],
        globalSettings: { settings_json: { color: '#fff' }, schema_json: {} },
      },
    })

    const out = await restoreVersion(mockDb(fx), 't1', 'v1')
    expect(out.restored).toBe(2) // 1 file + 1 section
    expect(fx.files).toHaveLength(1)
    expect(fx.files[0].path).toBe('layout/theme.liquid')
    expect(fx.files[0].content).toBe('RESTORED')
    expect(fx.sections).toHaveLength(1)
    expect(fx.sections[0].section_key).toBe('hero')
    expect(fx.globals.get('t1').settings_json).toEqual({ color: '#fff' })
  })
})
