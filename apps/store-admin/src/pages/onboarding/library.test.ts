/**
 * Store-admin — onboarding/library handler + helper tests (Phase B / Task B3).
 *
 * Two surfaces:
 *
 *   1. `getOnboardingLibraryRedirect(req, res)` — the convenience
 *      alias route `/admin/store/:slug/onboarding/library` that the
 *      accounts portal and Resume-banner will deep-link into. It just
 *      302s into `/onboarding/first-run?tab=library` so the welcome
 *      page owns all tab-rendering logic in one place.
 *
 *   2. `renderFeaturedLibraryCardsHtml(db, shopSlug)` — called by the
 *      welcome page's first-run handler to pre-render the Tab 2 grid.
 *      Thin wrapper over `listFeaturedSeeds()` + `libraryPreviewCards()`
 *      that turns DB rows into HTML. Lives here (not in the renderer)
 *      so the welcome component stays DB-free and easy to unit test.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  getOnboardingLibraryRedirect,
  renderFeaturedLibraryCardsHtml,
} from './library.js'

// ---------------------------------------------------------------------------
// 1. getOnboardingLibraryRedirect
// ---------------------------------------------------------------------------

function makeReq(slug: string) {
  return { store: { slug, id: 'shop-id-' + slug } } as any
}
function makeRes() {
  const res: any = {}
  res.redirect = vi.fn((arg1: any, arg2?: any) => {
    // Support both redirect(url) and redirect(status, url) signatures.
    res._lastStatus = typeof arg1 === 'number' ? arg1 : 302
    res._lastUrl = typeof arg1 === 'number' ? arg2 : arg1
    return res
  })
  return res
}

describe('getOnboardingLibraryRedirect', () => {
  it('redirects to /first-run?tab=library for the request store slug', () => {
    const req = makeReq('lifeasy')
    const res = makeRes()
    getOnboardingLibraryRedirect(req, res)
    expect(res.redirect).toHaveBeenCalledTimes(1)
    expect(res._lastUrl).toBe('/admin/store/lifeasy/onboarding/first-run?tab=library')
  })

  it('uses 302 so browsers do not cache the redirect', () => {
    // 301 would make the browser remember forever; the wizard is a
    // transient surface that may disappear on state change.
    const req = makeReq('acme')
    const res = makeRes()
    getOnboardingLibraryRedirect(req, res)
    expect(res._lastStatus).toBe(302)
  })
})

// ---------------------------------------------------------------------------
// 2. renderFeaturedLibraryCardsHtml
// ---------------------------------------------------------------------------

function makeFakeDbWithRows(rows: any[]) {
  const chain: any = {}
  chain.selectFrom = () => chain
  chain.select = () => chain
  chain.where = () => chain
  chain.orderBy = () => chain
  chain.limit = () => chain
  chain.execute = async () => rows
  return { selectFrom: () => chain } as any
}

describe('renderFeaturedLibraryCardsHtml', () => {
  it('returns the pre-rendered grid HTML when featured seeds exist', async () => {
    const db = makeFakeDbWithRows([
      {
        id: 'u1',
        slug: 'airbnb',
        source: 'seed',
        shopId: null,
        title: 'Airbnb',
        summary: 'Editorial travel marketplace.',
        category: 'travel',
        thumbnailUrl: 'https://cdn.example.com/airbnb.webp',
        storageTier: 'hot',
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
      },
      {
        id: 'u2',
        slug: 'stripe',
        source: 'seed',
        shopId: null,
        title: 'Stripe',
        summary: 'Developer-first payments.',
        category: 'finance',
        thumbnailUrl: null,
        storageTier: 'hot',
        createdAt: '2026-04-18T00:00:00.000Z',
        updatedAt: '2026-04-18T00:00:00.000Z',
      },
    ])
    const html = await renderFeaturedLibraryCardsHtml(db, 'lifeasy')
    expect(html).toContain('Airbnb')
    expect(html).toContain('Stripe')
    // Each card links into the existing design-library detail page so
    // sellers see the full preview experience.
    expect(html).toContain('/admin/store/lifeasy/design-library')
  })

  it('returns empty string when featured seeds are empty (so welcome fires its empty state)', async () => {
    const db = makeFakeDbWithRows([])
    const html = await renderFeaturedLibraryCardsHtml(db, 'lifeasy')
    expect(html).toBe('')
  })

  it('swallows DB errors and returns "" (graceful degradation for a non-critical panel)', async () => {
    // The welcome page MUST render even if the library query throws —
    // onboarding is the first screen of the product, a transient DB
    // blip on a secondary panel should not 500 the primary surface.
    const failingDb: any = {
      selectFrom() {
        return {
          select() { return this },
          where() { return this },
          orderBy() { return this },
          limit() { return this },
          execute: async () => {
            throw new Error('connection refused')
          },
        }
      },
    }
    const html = await renderFeaturedLibraryCardsHtml(failingDb, 'lifeasy')
    expect(html).toBe('')
  })
})
