import { describe, it, expect } from 'vitest'
import { persistPages } from './pages-persist.js'
import type { ScrapedPage } from '../types.js'

function makeFakeTx() {
  const writes: Array<{ table: string; values: any }> = []
  const tx: any = {
    insertInto: (table: string) => ({
      values: (v: any) => ({
        onConflict: (_c: any) => ({
          execute: async () => {
            writes.push({ table, values: v })
          },
        }),
      }),
    }),
  }
  return { tx, writes }
}

const samplePage: ScrapedPage = {
  url: 'https://x.com/pages/about',
  slug: 'about',
  title: 'About',
  body_html: '<p>hi</p>',
}

describe('persistPages', () => {
  it('upserts page by (shop_id, slug) with published=false', async () => {
    const { tx, writes } = makeFakeTx()
    const res = await persistPages(tx, 'shop-1', [samplePage])
    expect(res.inserted).toBe(1)
    expect(writes[0].table).toBe('pages')
    // Schema uses `published: boolean`, not `status`. Default false.
    expect(writes[0].values).toMatchObject({
      shop_id: 'shop-1',
      slug: 'about',
      title: 'About',
      published: false,
    })
  })

  it('strips <script> via sanitizeClonedHtml before persist', async () => {
    const withScript: ScrapedPage = {
      ...samplePage,
      body_html: '<p>hi</p><script>alert(1)</script>',
    }
    const { tx, writes } = makeFakeTx()
    await persistPages(tx, 'shop-1', [withScript])
    expect(writes[0].values.body_html).toContain('<p>hi</p>')
    expect(writes[0].values.body_html).not.toContain('<script>')
    expect(writes[0].values.body_html).not.toContain('alert')
  })

  it('propagates insert errors (does NOT swallow — pg 25P02 aborts the whole tx)', async () => {
    // See products-persist.test.ts for why swallowing inside a pg tx is
    // actively harmful: a caught error still leaves the transaction in
    // `25P02 current transaction is aborted` state, so every subsequent
    // persister (pages → menus → theme) fails opaquely downstream. Let
    // errors propagate to withSerializable instead.
    const tx: any = {
      insertInto: (_t: string) => ({
        values: (_v: any) => ({
          onConflict: (_c: any) => ({
            execute: async () => {
              throw new Error('boom')
            },
          }),
        }),
      }),
    }
    await expect(persistPages(tx, 'shop-1', [samplePage])).rejects.toThrow('boom')
  })
})
