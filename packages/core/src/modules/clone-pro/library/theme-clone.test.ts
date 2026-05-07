/**
 * Tests for the Clone Library theme clone service (Phase 4.2).
 *
 * Focus on behaviour that the Phase 4 design depends on:
 *
 *   - source theme lookup + THEME_NOT_FOUND error code
 *   - target row gets `cloned_from_theme_id` stamped at insert time
 *   - `source_clone_job_id` is NEVER copied to the new row (ancestry
 *     rule from module docstring — only the ORIGINAL theme carries it)
 *   - asset copy loop invokes `duplicateAsset` once per source row
 *   - `activate: true` calls setActiveTheme; `activate: false` doesn't
 *   - `findExistingClone` returns null when no copy exists, or the id
 *     of the existing main copy when one exists
 *
 * Assets storage is stubbed so the test doesn't touch R2.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cloneThemeToShop, findExistingClone, CloneLibraryError } from './theme-clone.js'

// ---------------------------------------------------------------------------
// Mocks for external deps — setActiveTheme + duplicateAsset
// ---------------------------------------------------------------------------

vi.mock('../../themes/service.js', () => ({
  setActiveTheme: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../themes/asset-storage.js', () => ({
  duplicateAsset: vi.fn(async (value: string | null) => value),
}))

import { setActiveTheme } from '../../themes/service.js'
import { duplicateAsset } from '../../themes/asset-storage.js'

// ---------------------------------------------------------------------------
// Chainable mock — needs to track inserts + route tables
// ---------------------------------------------------------------------------

type TableRows = Record<string, unknown[]>

interface MockDbState {
  readonly inserts: { table: string; values: unknown }[]
  rowsByTable: TableRows
}

function makeChainable(state: MockDbState, table: string): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(state.rowsByTable[table] ?? [])
        }
        if (prop === 'executeTakeFirst') {
          return vi.fn().mockResolvedValue(
            (state.rowsByTable[table] ?? [])[0] ?? null,
          )
        }
        if (prop === 'executeTakeFirstOrThrow') {
          const row = (state.rowsByTable[table] ?? [])[0]
          if (!row) {
            return vi.fn().mockRejectedValue(new Error('no row'))
          }
          return vi.fn().mockResolvedValue(row)
        }
        return (..._args: unknown[]) => makeChainable(state, table)
      },
    },
  )
}

function makeDb(rowsByTable: TableRows = {}) {
  const state: MockDbState = { inserts: [], rowsByTable }
  const db: any = {
    selectFrom: (table: string) => makeChainable(state, table),
    insertInto: (table: string) => {
      let captured: unknown = null
      const chain = {
        values(v: unknown) {
          captured = v
          return this
        },
        returning() {
          return this
        },
        returningAll() {
          return this
        },
        execute: vi.fn().mockImplementation(async () => {
          state.inserts.push({ table, values: captured })
          return []
        }),
        executeTakeFirstOrThrow: vi.fn().mockImplementation(async () => {
          state.inserts.push({ table, values: captured })
          // Return a synthetic theme row for themes; the insert on
          // theme_assets calls execute(), not executeTakeFirstOrThrow.
          const row = state.rowsByTable.__insertedTheme?.[0] ?? {
            id: 'new-theme-id',
            shop_id: (captured as any)?.shop_id,
            name: (captured as any)?.name,
            role: 'unpublished',
          }
          return row
        }),
      }
      return chain
    },
  }
  return { db, state }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(setActiveTheme).mockClear()
  vi.mocked(duplicateAsset).mockClear()
})

describe('cloneThemeToShop', () => {
  it('throws THEME_NOT_FOUND when the source theme does not exist', async () => {
    const { db } = makeDb({ themes: [] })
    await expect(
      cloneThemeToShop(db, {
        sourceThemeId: 'missing',
        targetShopId: 'shop-target',
      }),
    ).rejects.toBeInstanceOf(CloneLibraryError)

    const { db: db2 } = makeDb({ themes: [] })
    try {
      await cloneThemeToShop(db2, {
        sourceThemeId: 'missing',
        targetShopId: 'shop-target',
      })
    } catch (err) {
      expect((err as CloneLibraryError).code).toBe('THEME_NOT_FOUND')
    }
  })

  it('inserts a new theme row with cloned_from_theme_id stamped, role=unpublished', async () => {
    const { db, state } = makeDb({
      themes: [{ id: 'src', shop_id: 'shop-src', name: 'Source Theme' }],
      theme_assets: [],
      __insertedTheme: [{ id: 'new-1', shop_id: 'shop-target', name: 'Source Theme', role: 'unpublished' }],
    })

    const result = await cloneThemeToShop(db, {
      sourceThemeId: 'src',
      targetShopId: 'shop-target',
    })

    const themeInsert = state.inserts.find((i) => i.table === 'themes')
    expect(themeInsert).toBeDefined()
    const values = themeInsert!.values as Record<string, unknown>
    expect(values.shop_id).toBe('shop-target')
    expect(values.name).toBe('Source Theme')
    expect(values.role).toBe('unpublished')
    expect(values.cloned_from_theme_id).toBe('src')
    // Ancestry rule: source_clone_job_id must NEVER be copied into
    // a Library re-clone. Only the original carries that link.
    expect(values.source_clone_job_id).toBeUndefined()

    expect(result.themeId).toBe('new-1')
    expect(result.role).toBe('unpublished')
  })

  it('applies newName override when provided', async () => {
    const { db, state } = makeDb({
      themes: [{ id: 'src', shop_id: 'shop-src', name: 'Source Theme' }],
      theme_assets: [],
    })

    await cloneThemeToShop(db, {
      sourceThemeId: 'src',
      targetShopId: 'shop-target',
      newName: 'Custom Name',
    })

    const themeInsert = state.inserts.find((i) => i.table === 'themes')
    expect((themeInsert!.values as any).name).toBe('Custom Name')
  })

  it('copies each source asset via duplicateAsset', async () => {
    const { db, state } = makeDb({
      themes: [{ id: 'src', shop_id: 'shop-src', name: 'Source Theme' }],
      theme_assets: [
        { theme_id: 'src', key: 'layout/theme.liquid', value: 'a', content_type: 'text/liquid', size: 1 },
        { theme_id: 'src', key: 'config/settings_data.json', value: 'b', content_type: 'application/json', size: 1 },
      ],
    })

    const result = await cloneThemeToShop(db, {
      sourceThemeId: 'src',
      targetShopId: 'shop-target',
    })

    expect(duplicateAsset).toHaveBeenCalledTimes(2)
    expect(result.assetsCopied).toBe(2)
    // theme_assets insert batch goes to the insertInto('theme_assets') path.
    const assetInsert = state.inserts.find((i) => i.table === 'theme_assets')
    expect(assetInsert).toBeDefined()
    expect(Array.isArray(assetInsert!.values)).toBe(true)
    expect((assetInsert!.values as unknown[]).length).toBe(2)
  })

  it('activate=true calls setActiveTheme and sets role=main in result', async () => {
    const { db } = makeDb({
      themes: [{ id: 'src', shop_id: 'shop-src', name: 'T' }],
      theme_assets: [],
    })
    const result = await cloneThemeToShop(db, {
      sourceThemeId: 'src',
      targetShopId: 'shop-target',
      activate: true,
    })
    expect(setActiveTheme).toHaveBeenCalledTimes(1)
    expect(result.role).toBe('main')
  })

  it('activate=false (default) does NOT call setActiveTheme', async () => {
    const { db } = makeDb({
      themes: [{ id: 'src', shop_id: 'shop-src', name: 'T' }],
      theme_assets: [],
    })
    const result = await cloneThemeToShop(db, {
      sourceThemeId: 'src',
      targetShopId: 'shop-target',
    })
    expect(setActiveTheme).not.toHaveBeenCalled()
    expect(result.role).toBe('unpublished')
  })
})

// ---------------------------------------------------------------------------
// findExistingClone
// ---------------------------------------------------------------------------

describe('findExistingClone', () => {
  it('returns null when no copy exists', async () => {
    const { db } = makeDb({ themes: [] })
    const row = await findExistingClone(db as any, {
      sourceThemeId: 'src',
      targetShopId: 'shop-target',
    })
    expect(row).toBeNull()
  })

  it('returns existing id + role when a copy exists', async () => {
    const { db } = makeDb({
      themes: [{ id: 'existing-main', role: 'main' }],
    })
    const row = await findExistingClone(db as any, {
      sourceThemeId: 'src',
      targetShopId: 'shop-target',
    })
    expect(row).toEqual({ themeId: 'existing-main', role: 'main' })
  })
})
