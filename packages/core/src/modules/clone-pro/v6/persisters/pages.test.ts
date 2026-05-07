import { describe, it, expect } from 'vitest'
import { pagesPersister } from './pages.js'

// ---------------------------------------------------------------------------
// Minimal DTO factory
// ---------------------------------------------------------------------------
function makePageDto(
  overrides: Partial<{
    sourceHandle: string
    sourceUrl: string
    title: string
    bodyHtml: string
    isPolicy: boolean
    seo: { title: string | null; description: string | null }
  }> = {},
) {
  return {
    sourceHandle: 'about-us',
    sourceUrl: 'https://x.com/pages/about-us',
    title: 'About Us',
    bodyHtml: '<p>We are Acme.</p>',
    isPolicy: false,
    seo: { title: null, description: null },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PagesPersister', () => {
  it('inserts new page with clone_snapshot + source=clone', async () => {
    const inserts: any[] = []

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) => fn(makeTrx(inserts, {})),
        }),
      }),
    }

    const r = await pagesPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makePageDto()],
    })

    expect(r.inserted).toBe(1)
    expect(r.skippedEdited).toBe(0)
    expect(r.updated).toBe(0)
    expect(r.errors).toHaveLength(0)

    const pageInsert = inserts.find((i) => i.table === 'pages')
    expect(pageInsert?.values).toMatchObject({
      slug: 'about-us',
      source: 'clone',
      clone_snapshot: expect.any(String),
      published: false,
    })

    // Snapshot should contain title + body_html + is_policy
    const snap = JSON.parse(pageInsert.values.clone_snapshot)
    expect(snap.title).toBe('About Us')
    expect(snap.body_html).toBe('<p>We are Acme.</p>')
    expect(snap.is_policy).toBe(false)
  })

  it('skips update when source=edited (re-clone preserves seller edit)', async () => {
    const inserts: any[] = []
    const existingPages = [
      {
        id: 'page-1',
        shop_id: 'shop-1',
        slug: 'about-us',
        source: 'edited',
        title: 'Seller Edited Page',
      },
    ]

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) =>
            fn(makeTrx(inserts, { pages: existingPages })),
        }),
      }),
    }

    const r = await pagesPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makePageDto({ title: 'Source Title', bodyHtml: '' })],
    })

    expect(r.skippedEdited).toBe(1)
    expect(r.updated).toBe(0)
    expect(r.inserted).toBe(0)
    // No page insert should have happened
    expect(inserts.filter((i) => i.table === 'pages')).toHaveLength(0)
  })

  it('updates existing clone-source page', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const existingPages = [
      { id: 'page-1', shop_id: 'shop-1', slug: 'about-us', source: 'clone', title: 'Old Title' },
    ]

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) =>
            fn(makeTrx(inserts, { pages: existingPages }, updates)),
        }),
      }),
    }

    const r = await pagesPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makePageDto({ title: 'New Title' })],
    })

    expect(r.updated).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.skippedEdited).toBe(0)
    const pageUpdate = updates.find((u) => u.table === 'pages')
    expect(pageUpdate?.values.title).toBe('New Title')
    expect(pageUpdate?.values.source).toBe('clone')
  })

  it('inserts policy page and stores is_policy=true in clone_snapshot', async () => {
    const inserts: any[] = []

    const fakeDb = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (fn: any) => fn(makeTrx(inserts, {})),
        }),
      }),
    }

    await pagesPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makePageDto({ sourceHandle: 'privacy-policy', title: 'Privacy Policy', isPolicy: true })],
    })

    const pageInsert = inserts.find((i) => i.table === 'pages')
    const snap = JSON.parse(pageInsert.values.clone_snapshot)
    expect(snap.is_policy).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fake transaction builder
// ---------------------------------------------------------------------------
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
