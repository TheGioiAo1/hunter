/**
 * Shop crawl policy — unit coverage (Phase 8 PR3b).
 *
 * Covers:
 *   • Active + no noindex → crawlable
 *   • Suspended shop → not crawlable (merchant kill switch irrelevant)
 *   • Closed shop → not crawlable
 *   • Active + merchant noindex → not crawlable (merchantNoindex flag set)
 *   • DB resolver returns closed variant for unknown shop id
 *   • DB resolver merges raw seo_settings blob
 */

import { describe, it, expect } from 'vitest'
import {
  computeCrawlPolicy,
  getShopCrawlPolicy,
  type ShopCrawlPolicy,
} from './crawl-policy.js'
import { DEFAULT_SEO_SETTINGS, type SeoSettings } from './seo-settings.js'

describe('computeCrawlPolicy', () => {
  it('active shop + no noindex → crawlable', () => {
    const p = computeCrawlPolicy({ status: 'active' }, DEFAULT_SEO_SETTINGS)
    expect(p.crawlable).toBe(true)
    expect(p.passwordProtected).toBe(false)
    expect(p.merchantNoindex).toBe(false)
  })

  it('suspended shop → not crawlable', () => {
    const p = computeCrawlPolicy({ status: 'suspended' }, DEFAULT_SEO_SETTINGS)
    expect(p.crawlable).toBe(false)
  })

  it('closed shop → not crawlable even when noindex explicitly off', () => {
    const p = computeCrawlPolicy({ status: 'closed' }, DEFAULT_SEO_SETTINGS)
    expect(p.crawlable).toBe(false)
  })

  it('active shop + merchant noindex → not crawlable, flag set', () => {
    const noindexSettings: SeoSettings = {
      ...DEFAULT_SEO_SETTINGS,
      robots_noindex: true,
    }
    const p = computeCrawlPolicy({ status: 'active' }, noindexSettings)
    expect(p.crawlable).toBe(false)
    expect(p.merchantNoindex).toBe(true)
    expect(p.passwordProtected).toBe(false)
  })

  it('null status → not crawlable', () => {
    const p = computeCrawlPolicy({ status: null }, DEFAULT_SEO_SETTINGS)
    expect(p.crawlable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DB-bound resolver
// ---------------------------------------------------------------------------

type Row = { id: string; status: string | null; seo_settings: unknown }

function makeDb(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return {
    selectFrom(_t: string) {
      return {
        _id: null as null | string,
        where(col: string, _op: string, val: string) {
          if (col !== 'id') throw new Error(`unexpected col ${col}`)
          this._id = val
          return this
        },
        select(cols: string[]) {
          this._cols = cols
          return this
        },
        _cols: [] as string[],
        async executeTakeFirst() {
          const r = this._id ? byId.get(this._id) : undefined
          if (!r) return undefined
          const out: Record<string, unknown> = {}
          for (const c of this._cols) {
            out[c] = (r as unknown as Record<string, unknown>)[c]
          }
          return out
        },
      }
    },
  } as any
}

describe('getShopCrawlPolicy', () => {
  it('returns closed variant for unknown shop id', async () => {
    const db = makeDb([])
    const p = await getShopCrawlPolicy(db, 'nope')
    expect(p).toEqual<ShopCrawlPolicy>({
      crawlable: false,
      passwordProtected: false,
      merchantNoindex: false,
    })
  })

  it('active shop + empty seo_settings → crawlable', async () => {
    const db = makeDb([{ id: 'shop_1', status: 'active', seo_settings: {} }])
    const p = await getShopCrawlPolicy(db, 'shop_1')
    expect(p.crawlable).toBe(true)
  })

  it('respects persisted robots_noindex=true', async () => {
    const db = makeDb([
      {
        id: 'shop_1',
        status: 'active',
        seo_settings: { robots_noindex: true },
      },
    ])
    const p = await getShopCrawlPolicy(db, 'shop_1')
    expect(p.crawlable).toBe(false)
    expect(p.merchantNoindex).toBe(true)
  })

  it('suspended shop overrides any seo_settings', async () => {
    const db = makeDb([
      {
        id: 'shop_1',
        status: 'suspended',
        seo_settings: { robots_noindex: false },
      },
    ])
    const p = await getShopCrawlPolicy(db, 'shop_1')
    expect(p.crawlable).toBe(false)
  })
})
