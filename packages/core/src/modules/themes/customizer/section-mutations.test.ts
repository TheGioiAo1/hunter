/**
 * Theme Customizer — section-mutations unit tests
 *
 * These cases exercise the JS-level merge / order / preset logic on a
 * stub Kysely. The live-DB smoke test (live-customizer-mutations.ts) on
 * server 2 covers the actual SQL.
 *
 * Cases covered:
 *   1. updateSectionSettings merges patch on top of existing
 *   2. updateSectionSettings drops keys whose patch value is null
 *   3. updateSectionSettings throws on missing section
 *   4. updateSectionSettings throws on non-object patch
 *   5. updateSectionBlocks rejects non-array blocks
 *   6. addSection generates unique key by suffixing -2/-3
 *   7. addSection seeds settings from preset when presetIndex provided
 *   8. addSection appends position = max+1 when no insertAfter
 *   9. reorderSections appends ids missing from incoming list
 *  10. reorderSections short-circuits on empty list
 */

import { describe, it, expect } from 'vitest'
import {
  updateSectionSettings,
  updateSectionBlocks,
  toggleSectionVisibility,
  addSection,
  removeSection,
  reorderSections,
} from './section-mutations.js'

// ─── DB fixture helpers ──────────────────────────────────────────────────

interface DbFixture {
  sections: Map<string, any>
  schemas: Map<string, { schema_json: any }>
  /** Captured update payloads for assertions. */
  updates: Array<{ table: string; set: any; where: any }>
  inserted: any | null
  deleted: string | null
}

function makeFixture(): DbFixture {
  return { sections: new Map(), schemas: new Map(), updates: [], inserted: null, deleted: null }
}

function mockDb(fx: DbFixture) {
  // We model just enough of Kysely's chain to pass the modules' calls.
  // For complex chains (executeTakeFirst, transaction) we branch by table.
  const exec = (q: any) => {
    if (q.kind === 'select' && q.table === 'theme_page_sections' && q.where?.id) {
      return fx.sections.get(q.where.id)
    }
    if (q.kind === 'select' && q.table === 'theme_section_schemas' && q.where?.type) {
      return fx.schemas.get(q.where.type)
    }
    if (q.kind === 'selectAll' && q.table === 'theme_page_sections') {
      const arr: any[] = []
      for (const s of fx.sections.values()) {
        if (s.theme_id === q.where.theme_id && s.page_type === q.where.page_type) {
          arr.push(s)
        }
      }
      return arr
    }
    return undefined
  }

  const builder = {
    selectFrom(table: string) {
      const q: any = { kind: 'select', table, where: {}, selects: [] }
      const leaf: any = {
        leftJoin() {
          return leaf
        },
        select(cols: any) {
          // detect aggregate fn().max
          if (typeof cols === 'function') {
            q.kind = 'aggregate'
          } else {
            q.selects = cols
          }
          return leaf
        },
        where(col: string, _op: string, val: any) {
          // strip table prefix
          const k = col.includes('.') ? col.split('.').pop()! : col
          q.where[k] = val
          return leaf
        },
        orderBy() {
          return leaf
        },
        async executeTakeFirst() {
          if (q.kind === 'aggregate') {
            // max(position)
            let max: number | null = null
            for (const s of fx.sections.values()) {
              if (s.theme_id === q.where.theme_id && s.page_type === q.where.page_type) {
                if (max == null || s.position > max) max = s.position
              }
            }
            return { max_pos: max }
          }
          return exec(q)
        },
        async executeTakeFirstOrThrow() {
          const r = await leaf.executeTakeFirst()
          if (!r) throw new Error('not found')
          return r
        },
        async execute() {
          if (q.kind === 'select' && q.table === 'theme_page_sections') {
            q.kind = 'selectAll'
            return exec(q)
          }
          return []
        },
      }
      return leaf
    },

    updateTable(table: string) {
      const q: any = { kind: 'update', table, set: undefined, where: {} }
      const leaf: any = {
        set(payload: any) {
          q.set = typeof payload === 'function' ? { __fn: true } : payload
          return leaf
        },
        where(col: string, _op: string, val: any) {
          const k = col.includes('.') ? col.split('.').pop()! : col
          q.where[k] = val
          return leaf
        },
        async execute() {
          fx.updates.push({ table, set: q.set, where: q.where })
          if (q.where.id && fx.sections.has(q.where.id) && q.set && !q.set.__fn) {
            const cur = fx.sections.get(q.where.id)
            fx.sections.set(q.where.id, { ...cur, ...q.set })
          }
        },
      }
      return leaf
    },

    insertInto(_table: string) {
      const q: any = { kind: 'insert', values: undefined, returning: undefined }
      const leaf: any = {
        values(v: any) {
          q.values = v
          return leaf
        },
        returning(_cols: any) {
          return leaf
        },
        async executeTakeFirstOrThrow() {
          const id = `auto-${Math.random().toString(36).slice(2, 7)}`
          const row = { id, ...q.values }
          fx.sections.set(id, row)
          fx.inserted = row
          return { id }
        },
      }
      return leaf
    },

    deleteFrom(_table: string) {
      const q: any = { kind: 'delete', where: {} }
      const leaf: any = {
        where(col: string, _op: string, val: any) {
          const k = col.includes('.') ? col.split('.').pop()! : col
          q.where[k] = val
          return leaf
        },
        async execute() {
          if (q.where.id) {
            fx.deleted = q.where.id
            fx.sections.delete(q.where.id)
          }
        },
      }
      return leaf
    },

    transaction() {
      return {
        async execute(fn: any) {
          return await fn(builder)
        },
      }
    },
  }
  return builder as any
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('updateSectionSettings', () => {
  it('merges patch on top of existing', async () => {
    const fx = makeFixture()
    fx.sections.set('s1', { id: 's1', settings_json: { a: 1, b: 2 } })
    const merged = await updateSectionSettings(mockDb(fx), 's1', { b: 22, c: 3 })
    expect(merged).toEqual({ a: 1, b: 22, c: 3 })
  })

  it('drops keys whose patch value is null', async () => {
    const fx = makeFixture()
    fx.sections.set('s1', { id: 's1', settings_json: { a: 1, b: 2 } })
    const merged = await updateSectionSettings(mockDb(fx), 's1', { a: null })
    expect(merged).toEqual({ b: 2 })
  })

  it('throws on missing section', async () => {
    const fx = makeFixture()
    await expect(updateSectionSettings(mockDb(fx), 'missing', { a: 1 })).rejects.toThrow(/not found/i)
  })

  it('throws on non-object patch', async () => {
    const fx = makeFixture()
    fx.sections.set('s1', { id: 's1', settings_json: {} })
    await expect(
      updateSectionSettings(mockDb(fx), 's1', null as any),
    ).rejects.toThrow(/object/i)
  })
})

describe('updateSectionBlocks', () => {
  it('rejects non-array blocks', async () => {
    const fx = makeFixture()
    await expect(updateSectionBlocks(mockDb(fx), 's1', 'oops' as any)).rejects.toThrow(/array/i)
  })

  it('writes blocks array through', async () => {
    const fx = makeFixture()
    await updateSectionBlocks(mockDb(fx), 's1', [{ type: 'cta' }])
    expect(fx.updates[0].set.blocks_json).toEqual([{ type: 'cta' }])
  })
})

describe('toggleSectionVisibility', () => {
  it('writes enabled bool', async () => {
    const fx = makeFixture()
    await toggleSectionVisibility(mockDb(fx), 's1', false)
    expect(fx.updates[0].set.enabled).toBe(false)
  })
})

describe('addSection', () => {
  it('generates unique key by suffixing when collisions exist', async () => {
    const fx = makeFixture()
    fx.sections.set('a1', { id: 'a1', theme_id: 't1', page_type: 'index', section_key: 'hero', position: 0 })
    fx.sections.set('a2', { id: 'a2', theme_id: 't1', page_type: 'index', section_key: 'hero-2', position: 1 })

    const out = await addSection(mockDb(fx), {
      themeId: 't1',
      pageType: 'index',
      type: 'hero',
    })
    expect(out.sectionKey).toBe('hero-3')
    expect(out.position).toBe(2)
  })

  it('seeds settings + blocks from preset when presetIndex provided', async () => {
    const fx = makeFixture()
    fx.schemas.set('hero', {
      schema_json: {
        presets: [
          { name: 'Welcome', settings: { heading: 'Hi' }, blocks: [{ type: 'cta' }] },
        ],
      },
    })

    await addSection(mockDb(fx), {
      themeId: 't1',
      pageType: 'index',
      type: 'hero',
      presetIndex: 0,
    })
    expect(fx.inserted.settings_json).toEqual({ heading: 'Hi' })
    expect(fx.inserted.blocks_json).toEqual([{ type: 'cta' }])
  })

  it('client-supplied settings override preset settings', async () => {
    const fx = makeFixture()
    fx.schemas.set('hero', {
      schema_json: { presets: [{ name: 'p', settings: { heading: 'preset' } }] },
    })

    await addSection(mockDb(fx), {
      themeId: 't1',
      pageType: 'index',
      type: 'hero',
      presetIndex: 0,
      settings: { heading: 'override' },
    })
    expect(fx.inserted.settings_json.heading).toBe('override')
  })

  it('appends to position max+1 when no insertAfter and no rows', async () => {
    const fx = makeFixture()
    const out = await addSection(mockDb(fx), { themeId: 't1', pageType: 'index', type: 'hero' })
    // Empty -> max=null -> nextPosition returns -1 -> position = 0
    expect(out.position).toBe(0)
  })
})

describe('removeSection', () => {
  it('issues a DELETE for the id', async () => {
    const fx = makeFixture()
    fx.sections.set('s1', { id: 's1' })
    await removeSection(mockDb(fx), 's1')
    expect(fx.deleted).toBe('s1')
    expect(fx.sections.has('s1')).toBe(false)
  })
})

describe('reorderSections', () => {
  it('short-circuits on empty list', async () => {
    const fx = makeFixture()
    await reorderSections(mockDb(fx), 't1', 'index', [])
    expect(fx.updates).toHaveLength(0)
  })

  it('rejects non-array payload', async () => {
    const fx = makeFixture()
    await expect(
      reorderSections(mockDb(fx), 't1', 'index', 'bad' as any),
    ).rejects.toThrow(/array/i)
  })

  it('rewrites positions to array index, appending leftovers', async () => {
    const fx = makeFixture()
    fx.sections.set('a', { id: 'a', theme_id: 't1', page_type: 'index', position: 0 })
    fx.sections.set('b', { id: 'b', theme_id: 't1', page_type: 'index', position: 1 })
    fx.sections.set('c', { id: 'c', theme_id: 't1', page_type: 'index', position: 2 })

    await reorderSections(mockDb(fx), 't1', 'index', ['c', 'a'])
    // Expected: c -> 0, a -> 1, b -> 2 (leftover appended)
    const positions = fx.updates
      .filter((u) => u.set?.position !== undefined)
      .map((u) => ({ id: u.where.id, position: u.set.position }))
    expect(positions).toEqual([
      { id: 'c', position: 0 },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ])
  })
})
