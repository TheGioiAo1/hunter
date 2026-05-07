/**
 * install-default.ts — covers the idempotency contract + the two
 * write paths (themes, theme_files, theme_global_settings).
 *
 * No DB required — uses an in-memory fake that records every kysely
 * call so we can assert on them.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { installDefaultTheme } from './install-default.js'

interface Op {
  kind: 'select' | 'update' | 'insert'
  table: string
  values?: unknown
  whereClauses?: Array<[string, string, unknown]>
  conflictColumns?: string[]
}

interface FakeDb {
  ops: Op[]
  /** Pre-seeded selectFrom(themes) responses keyed by query signature. */
  existingThemes: Array<{ id: string; name: string; role: string }>
  insertedThemeId: string
}

function makeFakeDb(initialThemes: FakeDb['existingThemes'] = []): FakeDb & { db: any } {
  const fake: FakeDb = {
    ops: [],
    existingThemes: initialThemes,
    insertedThemeId: 'theme-installed',
  }
  const db: any = {
    selectFrom(table: string) {
      const op: Op = { kind: 'select', table, whereClauses: [] }
      fake.ops.push(op)
      const chain: any = {
        select: () => chain,
        where: (col: string, ineq: string, val: unknown) => {
          op.whereClauses!.push([col, ineq, val])
          return chain
        },
        executeTakeFirst: async () => {
          if (table !== 'themes') return undefined
          // Filter by name first (idempotency check).
          const nameClause = op.whereClauses!.find((c) => c[0] === 'name' && c[1] === '=')
          if (nameClause) {
            const found = fake.existingThemes.find((t) => t.name === nameClause[2])
            return found ? { id: found.id, role: found.role } : undefined
          }
          // Filter by role (auto-role pre-check looks for an existing main).
          const roleClause = op.whereClauses!.find((c) => c[0] === 'role' && c[1] === '=')
          if (roleClause) {
            const found = fake.existingThemes.find((t) => t.role === roleClause[2])
            return found ? { id: found.id } : undefined
          }
          return undefined
        },
        execute: async () => {
          if (table !== 'themes') return []
          // 'name like X%' — return all themes for the shop.
          return fake.existingThemes.map((t) => ({ name: t.name }))
        },
      }
      return chain
    },
    updateTable(table: string) {
      const op: Op = { kind: 'update', table, whereClauses: [] }
      fake.ops.push(op)
      return {
        set: (vals: any) => {
          op.values = vals
          return {
            where: (col: string, ineq: string, val: unknown) => {
              op.whereClauses!.push([col, ineq, val])
              return {
                where: (col2: string, ineq2: string, val2: unknown) => {
                  op.whereClauses!.push([col2, ineq2, val2])
                  return { execute: async () => undefined }
                },
                execute: async () => undefined,
              }
            },
          }
        },
      }
    },
    insertInto(table: string) {
      const op: Op = { kind: 'insert', table }
      fake.ops.push(op)
      return {
        values: (vals: any) => {
          op.values = vals
          return {
            returning: () => ({
              executeTakeFirstOrThrow: async () => ({ id: fake.insertedThemeId }),
            }),
            onConflict: (cb: any) => {
              const oc: any = {
                columns: (cols: string[]) => {
                  op.conflictColumns = cols
                  return { doUpdateSet: () => ({ execute: async () => undefined }) }
                },
              }
              cb(oc)
              return { execute: async () => undefined }
            },
            execute: async () => undefined,
          }
        },
      }
    },
    // The fake transaction() runs the callback with the SAME fake db so
    // ops are still recorded for assertions. Real Kysely would scope to
    // a connection — but that's not what we're testing here.
    transaction() {
      return {
        execute: async (fn: (trx: any) => Promise<unknown>) => {
          return await fn(db)
        },
      }
    },
  }
  return { ...fake, db }
}

describe('installDefaultTheme — fresh shop', () => {
  it('creates 1 themes row + N theme_files + 1 theme_global_settings (N from vendored bundle)', async () => {
    // 2026-04-27 — bumped from a hardcoded 11 to whatever the bundled
    // theme ships with. Sprint 8 PR-A vendored an 11-file minimal subset;
    // the bundle script later vendored the full 32-file Gbox Default
    // theme from the gbox-theme-editor repo. Pinning a literal count
    // here would force a test-edit on every theme update — instead we
    // assert "the test wrote at least one of every important kind" and
    // pin the SHAPE.
    const f = makeFakeDb([])
    const r = await installDefaultTheme(f.db, { shopId: 'shop-1', role: 'unpublished' })
    expect(r.created).toBe(true)
    expect(r.themeId).toBe('theme-installed')
    expect(r.filesWritten).toBeGreaterThanOrEqual(11)
    const inserts = f.ops.filter((o) => o.kind === 'insert')
    expect(inserts.find((o) => o.table === 'themes')).toBeTruthy()
    expect(inserts.filter((o) => o.table === 'theme_files').length).toBe(r.filesWritten)
    expect(inserts.find((o) => o.table === 'theme_global_settings')).toBeTruthy()
  })

  it('every theme_files insert carries a unique synthesized source_url', async () => {
    // Regression guard: idx_theme_files_shop_source_url UNIQUE(shop_id,
    // source_url) used to be tripped on the second file because the
    // installer set source_url='' for every row. The fix synthesizes
    // a gbox://theme/<themeId>/<path> URL so each row's tuple is
    // distinct. This test pins the shape so we don't regress.
    const f = makeFakeDb([])
    const r = await installDefaultTheme(f.db, { shopId: 'shop-1', role: 'unpublished' })
    const fileInserts = f.ops.filter((o) => o.kind === 'insert' && o.table === 'theme_files')
    const sourceUrls = fileInserts.map((o) => (o.values as any).source_url)
    expect(sourceUrls.length).toBe(r.filesWritten)
    expect(new Set(sourceUrls).size).toBe(sourceUrls.length) // every URL distinct
    for (const u of sourceUrls) {
      expect(typeof u).toBe('string')
      expect((u as string).startsWith('gbox://theme/')).toBe(true)
    }
  })

  it('materializes theme_page_sections rows from every templates/*.json', async () => {
    const f = makeFakeDb([])
    const r = await installDefaultTheme(f.db, { shopId: 'shop-1', role: 'unpublished' })
    // The bundled default theme ships with at least one template — the
    // important contract is that EVERY section listed in `order[]`
    // produces a theme_page_sections insert. We don't pin the exact
    // count to keep the test resilient to default-theme edits, just
    // assert the count > 0 and matches r.sectionsCreated.
    const sectionInserts = f.ops.filter(
      (o) => o.kind === 'insert' && o.table === 'theme_page_sections',
    )
    expect(sectionInserts.length).toBeGreaterThan(0)
    expect(r.sectionsCreated).toBe(sectionInserts.length)
    // Each insert carries a section_type string + page_type string.
    for (const op of sectionInserts) {
      expect(typeof (op.values as any).section_type).toBe('string')
      expect(typeof (op.values as any).page_type).toBe('string')
      expect(typeof (op.values as any).section_key).toBe('string')
    }
  })

  it('skips the demote-old-main step when installing as unpublished', async () => {
    const f = makeFakeDb([])
    await installDefaultTheme(f.db, { shopId: 'shop-1', role: 'unpublished' })
    const updates = f.ops.filter((o) => o.kind === 'update' && o.table === 'themes')
    expect(updates.length).toBe(0)
  })

  it('demotes the existing main when installing as main', async () => {
    const f = makeFakeDb([])
    await installDefaultTheme(f.db, { shopId: 'shop-1', role: 'main' })
    const updates = f.ops.filter((o) => o.kind === 'update' && o.table === 'themes')
    expect(updates.length).toBe(1)
    expect((updates[0]!.values as any).role).toBe('unpublished')
  })
})

describe('installDefaultTheme — auto role (Shopify-style first-theme-publishes)', () => {
  it("auto: empty shop → installs as 'main' (first theme on empty shop goes live)", async () => {
    const f = makeFakeDb([])
    const r = await installDefaultTheme(f.db, { shopId: 'shop-1' /* role omitted → auto */ })
    expect(r.role).toBe('main')
    // The themes-row INSERT must carry role: 'main'.
    const themeInsert = f.ops.find((o) => o.kind === 'insert' && o.table === 'themes')
    expect(themeInsert).toBeTruthy()
    expect((themeInsert!.values as any).role).toBe('main')
  })

  it("auto: shop with existing main → installs as 'unpublished' (preserves the seller's live theme)", async () => {
    const f = makeFakeDb([
      { id: 'live-theme', name: 'Custom Theme', role: 'main' },
    ])
    const r = await installDefaultTheme(f.db, { shopId: 'shop-1' /* role omitted → auto */ })
    expect(r.role).toBe('unpublished')
    const themeInsert = f.ops.find((o) => o.kind === 'insert' && o.table === 'themes')
    expect((themeInsert!.values as any).role).toBe('unpublished')
    // The existing main must NOT be demoted.
    const updates = f.ops.filter((o) => o.kind === 'update' && o.table === 'themes')
    expect(updates.length).toBe(0)
  })

  it("auto: explicit 'main' still demotes existing main", async () => {
    const f = makeFakeDb([
      { id: 'live-theme', name: 'Custom Theme', role: 'main' },
    ])
    const r = await installDefaultTheme(f.db, { shopId: 'shop-1', role: 'main' })
    expect(r.role).toBe('main')
    const updates = f.ops.filter((o) => o.kind === 'update' && o.table === 'themes')
    expect(updates.length).toBe(1)
  })
})

describe('installDefaultTheme — idempotency', () => {
  beforeEach(() => {
    // Each fake is a new instance; nothing shared.
  })

  it('returns the existing theme id without re-creating when one exists with the same name', async () => {
    const f = makeFakeDb([
      { id: 'old-theme-123', name: 'Gbox Default', role: 'unpublished' },
    ])
    const r = await installDefaultTheme(f.db, { shopId: 'shop-1', role: 'unpublished' })
    expect(r.created).toBe(false)
    expect(r.themeId).toBe('old-theme-123')
    expect(r.filesWritten).toBe(0)
    expect(r.sectionsCreated).toBe(0)
    expect(r.role).toBe('unpublished')
    // Should NOT insert a new themes row when it returns existing.
    const inserts = f.ops.filter((o) => o.kind === 'insert' && o.table === 'themes')
    expect(inserts.length).toBe(0)
  })

  it('with force=true creates a new theme even if one exists', async () => {
    const f = makeFakeDb([
      { id: 'old-theme-123', name: 'Gbox Default', role: 'unpublished' },
    ])
    const r = await installDefaultTheme(f.db, { shopId: 'shop-1', force: true })
    expect(r.created).toBe(true)
    expect(r.themeId).toBe('theme-installed')
    // 2026-04-27 — count comes from the bundled DEFAULT_THEME_FILES (was
    // a hardcoded 11 in Sprint 8 PR-A's minimal subset; now 32 after the
    // full Gbox Default theme was vendored from gbox-theme-editor).
    // Asserting "at least 11" keeps the contract (we ship a real theme)
    // without re-pinning every bundle update.
    expect(r.filesWritten).toBeGreaterThanOrEqual(11)
  })
})
