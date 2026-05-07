import { describe, it, expect } from 'vitest'
import { blogPostsPersister } from './blog-posts.js'

// ---------------------------------------------------------------------------
// Minimal DTO factory
// ---------------------------------------------------------------------------
function makeBlogPostDto(
  overrides: Partial<{
    blogHandle: string
    sourceHandle: string
    sourceUrl: string
    title: string
    author: string | null
    bodyHtml: string
    publishedAt: string | null
    tags: string[]
    seo: { title: string | null; description: string | null }
  }> = {},
) {
  return {
    blogHandle: 'news',
    sourceHandle: 'my-first-post',
    sourceUrl: 'https://x.com/blogs/news/my-first-post',
    title: 'My First Post',
    author: 'Jane Doe',
    bodyHtml: '<p>Hello world.</p>',
    publishedAt: '2025-01-15T00:00:00Z',
    tags: ['welcome', 'intro'],
    seo: { title: null, description: null },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BlogPostsPersister', () => {
  it('inserts new blog post with clone_snapshot + source=clone', async () => {
    const inserts: any[] = []

    const fakeDb = makeFakeDb(inserts, {})

    const r = await blogPostsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeBlogPostDto()],
    })

    expect(r.inserted).toBe(1)
    expect(r.updated).toBe(0)
    expect(r.skippedEdited).toBe(0)
    expect(r.errors).toHaveLength(0)

    const postInsert = inserts.find((i) => i.table === 'blog_posts')
    expect(postInsert?.values).toMatchObject({
      shop_id: 'shop-1',
      slug: 'my-first-post',
      title: 'My First Post',
      body_html: '<p>Hello world.</p>',
      author: 'Jane Doe',
      published: false,
      source: 'clone',
      clone_snapshot: expect.any(String),
    })

    // Snapshot should contain blog_handle, title, body_html, tags
    const snap = JSON.parse(postInsert.values.clone_snapshot)
    expect(snap.blog_handle).toBe('news')
    expect(snap.title).toBe('My First Post')
    expect(snap.body_html).toBe('<p>Hello world.</p>')
    expect(snap.tags).toEqual(['welcome', 'intro'])
  })

  it('skips update when source=edited (re-clone preserves seller edit)', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const existingPosts = [
      {
        id: 'post-1',
        shop_id: 'shop-1',
        slug: 'my-first-post',
        source: 'edited',
        title: 'Seller Edited Title',
      },
    ]

    const fakeDb = makeFakeDb(inserts, { blog_posts: existingPosts }, updates)

    const r = await blogPostsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeBlogPostDto({ title: 'Source Title From Clone' })],
    })

    expect(r.skippedEdited).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.updated).toBe(0)
    expect(inserts.filter((i) => i.table === 'blog_posts')).toHaveLength(0)
    expect(updates.filter((u) => u.table === 'blog_posts')).toHaveLength(0)
  })

  it('updates existing clone-source post with new fields', async () => {
    const inserts: any[] = []
    const updates: any[] = []
    const existingPosts = [
      {
        id: 'post-1',
        shop_id: 'shop-1',
        slug: 'my-first-post',
        source: 'clone',
        title: 'Old Title',
      },
    ]

    const fakeDb = makeFakeDb(inserts, { blog_posts: existingPosts }, updates)

    const r = await blogPostsPersister.persist({
      db: fakeDb as any,
      shopId: 'shop-1',
      jobId: 'job-1',
      dtos: [makeBlogPostDto({ title: 'Updated Title', tags: ['updated'] })],
    })

    expect(r.updated).toBe(1)
    expect(r.inserted).toBe(0)
    expect(r.skippedEdited).toBe(0)

    const postUpdate = updates.find((u) => u.table === 'blog_posts')
    expect(postUpdate?.values.title).toBe('Updated Title')
    expect(postUpdate?.values.body_html).toBe('<p>Hello world.</p>')
    expect(postUpdate?.values.source).toBe('clone')
    expect(postUpdate?.values.tags).toEqual(['updated'])
  })
})

// ---------------------------------------------------------------------------
// Fake transaction / DB builder (mirrors pages.test.ts pattern)
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
    deleteFrom: (table: string) => ({
      where: () => ({
        execute: async () => {
          inserts.push({ table, _op: 'delete' })
        },
        where: () => ({
          execute: async () => {
            inserts.push({ table, _op: 'delete' })
          },
        }),
      }),
    }),
  }
}
