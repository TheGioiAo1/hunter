/**
 * Store-admin — dismiss-banner handler tests (Phase C / Task C4).
 *
 * POST /admin/store/:slug/onboarding/dismiss-banner
 *
 * The ✕ on the Resume-setup banner. Permanent dismiss — moves the shop
 * from `skipped` → `completed` with `choice='dismissed'` and
 * `completed_at=now()`. After this, no more banner, no more wizard
 * auto-redirect. The seller has opted out of the wizard lifecycle.
 *
 * Redirect strategy: go back to the page the banner lived on (via
 * Referer), NOT the dashboard. Sellers dismiss the banner from
 * wherever they happen to be (products list, settings page, …) and
 * expect to stay there, not get yanked home. Dashboard is the
 * fallback when the Referer is missing or points off-origin.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { postDismissOnboardingBanner } from './dismiss-banner.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeReq(opts: {
  slug?: string
  shopId?: string
  referer?: string | null
} = {}) {
  return {
    store: {
      id: opts.shopId ?? 'shop-abc',
      slug: opts.slug ?? 'lifeasy',
      name: 'Lifeasy',
    },
    storeUser: { id: 'user-1', name: 'Thai' },
    headers: opts.referer === null
      ? {}
      : { referer: opts.referer ?? '/admin/store/lifeasy/products' },
  } as any
}

function makeRes() {
  const res: any = { _redirectUrl: null, _redirectStatus: 0 }
  res.redirect = vi.fn((arg1: any, arg2?: any) => {
    res._redirectStatus = typeof arg1 === 'number' ? arg1 : 302
    res._redirectUrl = typeof arg1 === 'number' ? arg2 : arg1
    return res
  })
  return res
}

function makeFakeDb() {
  const captured: any[] = []
  const chain: any = {}
  chain.set = (patch: any) => {
    captured.push({ op: 'set', patch })
    return chain
  }
  chain.where = (col: any, op: any, val: any) => {
    captured.push({ op: 'where', col, opArg: op, val })
    return chain
  }
  chain.execute = async () => []
  return {
    _captured: captured,
    updateTable: (_name: string) => chain,
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('postDismissOnboardingBanner', () => {
  it("transitions skipped → completed with choice='dismissed'", async () => {
    const req = makeReq({ shopId: 'shop-zz' })
    const res = makeRes()
    const db = makeFakeDb()
    await postDismissOnboardingBanner(req, res, db)
    // The helper gates the UPDATE on state ∈ (cloning, skipped) and sets
    // onboarding_state='completed' + onboarding_choice='dismissed'.
    const setCall = db._captured.find((c: any) => c.op === 'set')
    expect(setCall).toBeDefined()
    expect(setCall.patch.onboarding_state).toBe('completed')
    expect(setCall.patch.onboarding_choice).toBe('dismissed')
  })

  it('redirects to the Referer when present and same-origin-ish', async () => {
    const req = makeReq({
      slug: 'lifeasy',
      referer: '/admin/store/lifeasy/products',
    })
    const res = makeRes()
    const db = makeFakeDb()
    await postDismissOnboardingBanner(req, res, db)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy/products')
  })

  it('falls back to the dashboard when Referer is missing', async () => {
    const req = makeReq({ slug: 'acme', referer: null })
    const res = makeRes()
    const db = makeFakeDb()
    await postDismissOnboardingBanner(req, res, db)
    expect(res._redirectUrl).toBe('/admin/store/acme')
  })

  it('falls back to the dashboard when Referer is an off-origin URL', async () => {
    // Never trust a bare referer — an attacker who got a seller to
    // click a dismiss button on their site could pivot back to an
    // attacker-controlled URL. Require path-starts-with-/admin.
    const req = makeReq({
      slug: 'acme',
      referer: 'https://evil.example.com/steal-me',
    })
    const res = makeRes()
    const db = makeFakeDb()
    await postDismissOnboardingBanner(req, res, db)
    expect(res._redirectUrl).toBe('/admin/store/acme')
  })

  it('302 status (not 301) so the browser does not cache the redirect', async () => {
    const req = makeReq()
    const res = makeRes()
    const db = makeFakeDb()
    await postDismissOnboardingBanner(req, res, db)
    expect(res._redirectStatus).toBe(302)
  })
})
