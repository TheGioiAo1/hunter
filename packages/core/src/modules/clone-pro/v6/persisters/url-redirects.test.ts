import { describe, it, expect } from 'vitest'
import { urlRedirectsPersister, type UrlRedirectDTO } from './url-redirects.js'

// ---------------------------------------------------------------------------
// Minimal DTO factory
// ---------------------------------------------------------------------------
function makeUrlRedirectDto(overrides: Partial<UrlRedirectDTO> = {}): UrlRedirectDTO {
  return {
    sourcePath: '/old-page',
    targetPath: '/new-page',
    statusCode: 301,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('UrlRedirectsPersister', () => {
  it('inserts new redirect with source=clone + clone_snapshot', async () => {
    const inserts: any[] = []
    const fakeDb = makeFakeDb(inserts, {})

    const r = await urlRedirectsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeUrlRedirectDto()],
    })

    expect(r.inserted).toBe(1)
    expect(r.updated).toBe(0)
    expect(r.skippedEdited).toBe(0)
    expect(r.errors).toHaveLength(0)

    const redirectInsert = inserts.find((i) => i.table === 'url_redirects')
    expect(redirectInsert?.values).toMatchObject({
      shop_id: 'shop-1',
      source_path: '/old-page',
      target_path: '/new-page',
      status_code: 301,
      source: 'clone',
      clone_snapshot: expect.any(String),
    })

    // Snapshot should contain the original DTO fields
    const snap = JSON.parse(redirectInsert.values.clone_snapshot)
    expect(snap.sourcePath).toBe('/old-page')
    expect(snap.targetPath).toBe('/new-page')
    expect(snap.statusCode).toBe(301)
  })

  it('defaults statusCode to 301 when not provided', async () => {
    const inserts: any[] = []
    const fakeDb = makeFakeDb(inserts, {})

    await urlRedirectsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeUrlRedirectDto({ statusCode: undefined })],
    })

    const redirectInsert = inserts.find((i) => i.table === 'url_redirects')
    expect(redirectInsert?.values.status_code).toBe(301)
  })

  it('skips update when source=edited (re-clone preserves seller edit)', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const existingRedirects = [
      {
        id: 'redirect-1',
        shop_id: 'shop-1',
        source_path: '/old-page',
        source: 'edited',
      },
    ]

    const fakeDb = makeFakeDb(inserts, { url_redirects: existingRedirects }, updates)

    const r = await urlRedirectsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeUrlRedirectDto({ targetPath: '/different-target' })],
    })

    expect(r.skippedEdited).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.updated).toBe(0)
    expect(inserts.filter((i) => i.table === 'url_redirects')).toHaveLength(0)
    expect(updates.filter((u) => u.table === 'url_redirects')).toHaveLength(0)
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
