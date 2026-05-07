import { describe, it, expect } from 'vitest'
import { themeFilesPersister, type ThemeFileDTO } from './theme-files.js'

// ---------------------------------------------------------------------------
// Minimal DTO factory
// ---------------------------------------------------------------------------
function makeThemeFileDto(overrides: Partial<ThemeFileDTO> = {}): ThemeFileDTO {
  return {
    kind: 'css',
    sourceUrl: 'https://x.com/assets/styles.css',
    s3Key: 'seller-uuid/shop-1/abc123.css',
    cdnUrl: 'https://cdn.gbox.co/seller-uuid/shop-1/abc123.css',
    byteSize: 4096,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ThemeFilesPersister', () => {
  it('inserts new theme file with source=clone + clone_snapshot', async () => {
    const inserts: any[] = []
    const fakeDb = makeFakeDb(inserts, {})

    const r = await themeFilesPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeThemeFileDto()],
    })

    expect(r.inserted).toBe(1)
    expect(r.updated).toBe(0)
    expect(r.skippedEdited).toBe(0)
    expect(r.errors).toHaveLength(0)

    const fileInsert = inserts.find((i) => i.table === 'theme_files')
    expect(fileInsert?.values).toMatchObject({
      shop_id: 'shop-1',
      kind: 'css',
      source_url: 'https://x.com/assets/styles.css',
      s3_key: 'seller-uuid/shop-1/abc123.css',
      cdn_url: 'https://cdn.gbox.co/seller-uuid/shop-1/abc123.css',
      byte_size: 4096,
      source: 'clone',
      clone_snapshot: expect.any(String),
    })

    // Snapshot should be the serialised DTO
    const snap = JSON.parse(fileInsert.values.clone_snapshot)
    expect(snap.kind).toBe('css')
    expect(snap.sourceUrl).toBe('https://x.com/assets/styles.css')
    expect(snap.byteSize).toBe(4096)
  })

  it('skips update when source=edited (re-clone preserves seller edit)', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const existingFiles = [
      {
        id: 'file-1',
        shop_id: 'shop-1',
        source_url: 'https://x.com/assets/styles.css',
        source: 'edited',
      },
    ]

    const fakeDb = makeFakeDb(inserts, { theme_files: existingFiles }, updates)

    const r = await themeFilesPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeThemeFileDto({ s3Key: 'seller-uuid/shop-1/newsha.css', cdnUrl: 'https://cdn.gbox.co/new.css' })],
    })

    expect(r.skippedEdited).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.updated).toBe(0)
    expect(inserts.filter((i) => i.table === 'theme_files')).toHaveLength(0)
    expect(updates.filter((u) => u.table === 'theme_files')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fake transaction / DB builder (mirrors blog-posts.test.ts pattern)
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
        where: () => ({
          select: () => ({
            executeTakeFirst: async () => existing[table]?.[0] ?? undefined,
            execute: async () => existing[table] ?? [],
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
            return [{ ...values, id: `${table}-0` }]
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
