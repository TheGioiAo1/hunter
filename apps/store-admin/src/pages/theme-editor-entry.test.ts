/**
 * Theme Editor entry-point handler — unit tests.
 *
 * Covers:
 *   1. Redirects to /themes/:id/customize when a main theme exists
 *   2. Falls back to the newest theme when no main theme exists
 *   3. Bounces to the Library when the shop has zero themes
 *   4. Wraps DB errors via safeMessage (no internal leak)
 */

import { describe, it, expect, vi } from 'vitest'
import { getThemeEditorEntry } from './theme-editor-entry.js'

vi.mock('@gbox/core/modules/support/safe-message.js', () => ({
  safeMessage: (_e: Error) => ({ safe: 'Please contact Gbox support.' }),
}))

interface DbFx {
  themes: any[]
  /** Forced rejection for the next selectFrom call (error-path test). */
  fail?: Error
}

function mockDb(fx: DbFx) {
  return {
    selectFrom(_table: string) {
      if (fx.fail) throw fx.fail
      const q: any = { where: [], limit: null, orderBy: null }
      const leaf: any = {
        select() { return leaf },
        where(col: string, _op: string, val: any) {
          q.where.push({ col: col.includes('.') ? col.split('.').pop() : col, val })
          return leaf
        },
        orderBy(col: string) { q.orderBy = col; return leaf },
        limit(n: number) { q.limit = n; return leaf },
        async executeTakeFirst() {
          let rows = fx.themes.filter((t) =>
            q.where.every((w: any) => t[w.col] === w.val),
          )
          if (q.orderBy === 'created_at') {
            rows = rows.slice().sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
          }
          return rows[0]
        },
      }
      return leaf
    },
  } as any
}

function makeReq(slug: string = 'best-store', shopId: string = 'shop-A') {
  return {
    store: { id: shopId, slug, name: 'Best Store' },
    storeUser: { id: 'user-1', name: 'Lam', email: 'lam@example.com', role: 'staff', storeRole: 'owner' },
    params: { slug },
  } as any
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    redirected: undefined as string | undefined,
    redirectStatus: undefined as number | undefined,
    body: undefined as any,
    redirect(status: number, url?: string) {
      if (typeof status === 'string') {
        this.redirected = status
        this.redirectStatus = 302
      } else {
        this.redirectStatus = status
        this.redirected = url
      }
      return this
    },
    status(code: number) { this.statusCode = code; return this },
    send(payload: any) { this.body = payload; return this },
  }
  return res
}

describe('getThemeEditorEntry', () => {
  it('redirects to /themes/:id/customize when a main theme exists', async () => {
    const fx: DbFx = {
      themes: [{ id: 'theme-main', shop_id: 'shop-A', role: 'main', created_at: 100 }],
    }
    const req = makeReq()
    const res = makeRes()
    await getThemeEditorEntry(req, res, mockDb(fx))
    expect(res.redirectStatus).toBe(302)
    expect(res.redirected).toBe('/admin/store/best-store/themes/theme-main/customize')
  })

  it('falls back to the newest theme when no main theme exists', async () => {
    const fx: DbFx = {
      themes: [
        { id: 'theme-old', shop_id: 'shop-A', role: 'unpublished', created_at: 100 },
        { id: 'theme-new', shop_id: 'shop-A', role: 'unpublished', created_at: 500 },
      ],
    }
    const req = makeReq()
    const res = makeRes()
    await getThemeEditorEntry(req, res, mockDb(fx))
    expect(res.redirectStatus).toBe(302)
    expect(res.redirected).toBe('/admin/store/best-store/themes/theme-new/customize')
  })

  it('bounces to the Themes list when the shop has zero themes', async () => {
    // 2026-04-26 fix: previously bounced to /online-store/library
    // directly which made Theme editor and Library feel like the same
    // sidebar entry. Now bounces to the Themes list page; its empty
    // state offers an "Open Theme Library" CTA.
    const fx: DbFx = { themes: [] }
    const req = makeReq()
    const res = makeRes()
    await getThemeEditorEntry(req, res, mockDb(fx))
    expect(res.redirectStatus).toBe(302)
    expect(res.redirected).toBe('/admin/store/best-store/online-store/themes')
  })

  it('does not leak themes from another shop', async () => {
    const fx: DbFx = {
      themes: [
        { id: 'leaked-main', shop_id: 'shop-OTHER', role: 'main', created_at: 100 },
      ],
    }
    const req = makeReq('best-store', 'shop-A')
    const res = makeRes()
    await getThemeEditorEntry(req, res, mockDb(fx))
    // No themes for shop-A → bounce to Themes list, not the cross-shop main theme.
    expect(res.redirected).toBe('/admin/store/best-store/online-store/themes')
  })

  it('returns safeMessage on DB error (no internal leak)', async () => {
    const fx: DbFx = { themes: [], fail: new Error('postgres exploded — secret leaked: foo') }
    const req = makeReq()
    const res = makeRes()
    await getThemeEditorEntry(req, res, mockDb(fx))
    expect(res.statusCode).toBe(500)
    expect(res.body).toBe('Please contact Gbox support.')
    expect(res.body).not.toContain('postgres')
  })
})
