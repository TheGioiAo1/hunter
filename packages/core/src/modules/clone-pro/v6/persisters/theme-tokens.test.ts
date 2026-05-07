import { describe, it, expect } from 'vitest'
import { themeTokensPersister } from './theme-tokens.js'
import type { ThemeTokensDTO } from '../scrapers/types.js'

// ---------------------------------------------------------------------------
// Minimal DTO factory
// ---------------------------------------------------------------------------
function makeThemeTokensDto(
  overrides: Partial<ThemeTokensDTO> = {},
): ThemeTokensDTO {
  return {
    colors: { primary: '#000000', background: '#ffffff' },
    fonts: { heading: 'Inter', body: 'Inter', alt: null },
    spacing: { base: '16px' },
    radii: { sm: '4px', md: '8px' },
    shadows: { card: '0 1px 3px rgba(0,0,0,0.1)' },
    raw: { computedStyles: { '--color-primary': '#000000' } },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ThemeTokensPersister', () => {
  it('returns early with no-op when dtos is empty', async () => {
    const inserts: any[] = []
    const fakeDb = makeFakeDb(inserts, {})

    const r = await themeTokensPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [],
    })

    expect(r.inserted).toBe(0)
    expect(r.updated).toBe(0)
    expect(r.skippedEdited).toBe(0)
    expect(r.errors).toHaveLength(0)
    expect(inserts).toHaveLength(0)
  })

  it('inserts new shop_theme_tokens row with tokens_json + clone_snapshot', async () => {
    const inserts: any[] = []
    const fakeDb = makeFakeDb(inserts, {})

    const r = await themeTokensPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeThemeTokensDto()],
    })

    expect(r.inserted).toBe(1)
    expect(r.updated).toBe(0)
    expect(r.skippedEdited).toBe(0)
    expect(r.errors).toHaveLength(0)

    const tokenInsert = inserts.find((i) => i.table === 'shop_theme_tokens')
    expect(tokenInsert?.values).toMatchObject({
      shop_id: 'shop-1',
      source: 'clone',
      tokens_json: expect.any(String),
      clone_snapshot: expect.any(String),
    })

    // Both tokens_json and clone_snapshot should be the same serialised DTO
    const parsed = JSON.parse(tokenInsert.values.tokens_json)
    expect(parsed.colors.primary).toBe('#000000')
    expect(parsed.fonts.heading).toBe('Inter')

    const snap = JSON.parse(tokenInsert.values.clone_snapshot)
    expect(snap).toEqual(parsed)
  })

  it('skips update when source=edited (re-clone preserves seller theme customisation)', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const existingTokens = [{ shop_id: 'shop-1', source: 'edited' }]

    const fakeDb = makeFakeDb(inserts, { shop_theme_tokens: existingTokens }, updates)

    const r = await themeTokensPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeThemeTokensDto({ colors: { primary: '#ff0000' } })],
    })

    expect(r.skippedEdited).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.updated).toBe(0)
    expect(inserts.filter((i) => i.table === 'shop_theme_tokens')).toHaveLength(0)
    expect(updates.filter((u) => u.table === 'shop_theme_tokens')).toHaveLength(0)
  })

  it('updates existing clone-source row with new tokens_json', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const existingTokens = [{ shop_id: 'shop-1', source: 'clone' }]

    const fakeDb = makeFakeDb(inserts, { shop_theme_tokens: existingTokens }, updates)

    const r = await themeTokensPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeThemeTokensDto({ colors: { primary: '#ff0000', background: '#eeeeee' } })],
    })

    expect(r.updated).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.skippedEdited).toBe(0)

    const tokenUpdate = updates.find((u) => u.table === 'shop_theme_tokens')
    expect(tokenUpdate?.values.source).toBe('clone')
    expect(tokenUpdate?.values.tokens_json).toBeDefined()

    const parsed = JSON.parse(tokenUpdate.values.tokens_json)
    expect(parsed.colors.primary).toBe('#ff0000')
  })
})

// ---------------------------------------------------------------------------
// Fake transaction / DB builder
// ---------------------------------------------------------------------------
function makeFakeDb(
  inserts: any[],
  existing: Record<string, any[]> = {},
  updates: any[] = [],
) {
  return {
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: async (fn: any) => fn(makeTrx(inserts, existing, updates)),
      }),
    }),
  }
}

function makeTrx(
  inserts: any[],
  existing: Record<string, any[]> = {},
  updates: any[] = [],
): any {
  return {
    selectFrom: (table: string) => ({
      where: () => ({
        select: () => ({
          executeTakeFirst: async () => existing[table]?.[0] ?? undefined,
          execute: async () => existing[table] ?? [],
        }),
        executeTakeFirst: async () => existing[table]?.[0] ?? undefined,
        where: () => ({
          select: () => ({
            executeTakeFirst: async () => existing[table]?.[0] ?? undefined,
          }),
          executeTakeFirst: async () => existing[table]?.[0] ?? undefined,
        }),
      }),
    }),
    insertInto: (table: string) => ({
      values: (values: any) => ({
        returningAll: () => ({
          execute: async () => {
            inserts.push({ table, values })
            return [{ ...values }]
          },
        }),
        execute: async () => {
          inserts.push({ table, values })
        },
      }),
    }),
    updateTable: (table: string) => ({
      set: (values: any) => ({
        where: () => ({
          execute: async () => {
            updates.push({ table, values })
          },
          where: () => ({
            execute: async () => {
              updates.push({ table, values })
            },
          }),
        }),
      }),
    }),
  }
}
