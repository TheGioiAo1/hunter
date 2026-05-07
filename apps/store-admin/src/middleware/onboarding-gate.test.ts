/**
 * Store-admin — Onboarding gate middleware tests (Phase D / Task D1).
 *
 * Mounted after `storeAuth` so `req.store` is populated. Responsibilities:
 *
 *   1. When `shop.onboarding_state === 'pending'`, redirect to
 *      `/admin/store/:slug/onboarding/first-run` UNLESS the request
 *      path is an allow-listed bypass (onboarding flow itself, API
 *      surface, assets, logout, clone-pro progress).
 *
 *   2. When `shop.onboarding_state === 'skipped'`, set
 *      `res.locals.showOnboardingBanner = true` and call next().
 *      The banner-injection middleware (Task D2) reads that flag and
 *      splices the Resume-setup card into the layout.
 *
 *   3. When `shop.onboarding_state ∈ {'cloning', 'completed'}`, plain
 *      pass-through — no redirect, no banner. Cloning is an in-flight
 *      state with its own surface; completed is terminal.
 *
 *   4. When `req.store` is missing (shouldn't happen after storeAuth,
 *      but defense in depth), pass-through silently. The downstream
 *      handler will 404 or 500 on its own.
 *
 * Bypass list (never redirected, even when pending):
 *
 *   /admin/store/:slug/onboarding/*   ← the wizard itself
 *   /admin/store/:slug/api/*          ← JSON surface, don't HTML-redirect
 *   /admin/store/:slug/assets/*       ← static files
 *   /admin/store/:slug/logout         ← seller must always be able to leave
 *   /admin/store/:slug/clone-pro/*    ← progress page for in-flight clones
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { onboardingGate } from './onboarding-gate.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type OnboardingState = 'pending' | 'cloning' | 'skipped' | 'completed'

function makeReq(opts: {
  path: string
  slug?: string
  onboardingState?: OnboardingState
  missingStore?: boolean
}) {
  const slug = opts.slug ?? 'lifeasy'
  const req: any = {
    path: opts.path,
    originalUrl: opts.path,
    params: { slug },
  }
  if (!opts.missingStore) {
    req.store = {
      id: 'shop-1',
      slug,
      name: 'Lifeasy',
      onboarding_state: opts.onboardingState ?? 'pending',
    }
  }
  return req
}

function makeRes() {
  const res: any = {
    _redirectUrl: null,
    _redirectStatus: 0,
    locals: {},
  }
  res.redirect = vi.fn((arg1: any, arg2?: any) => {
    res._redirectStatus = typeof arg1 === 'number' ? arg1 : 302
    res._redirectUrl = typeof arg1 === 'number' ? arg2 : arg1
    return res
  })
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Pending-state redirect
// ---------------------------------------------------------------------------

describe('onboardingGate — pending redirects', () => {
  it('pending + dashboard root → redirect to /onboarding/first-run', () => {
    const req = makeReq({ path: '/admin/store/lifeasy', onboardingState: 'pending' })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy/onboarding/first-run')
    expect(next).not.toHaveBeenCalled()
  })

  it('pending + trailing-slash dashboard → redirect to /onboarding/first-run', () => {
    const req = makeReq({ path: '/admin/store/lifeasy/', onboardingState: 'pending' })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy/onboarding/first-run')
    expect(next).not.toHaveBeenCalled()
  })

  it('pending + deep admin page → redirect to /onboarding/first-run', () => {
    const req = makeReq({
      path: '/admin/store/lifeasy/products',
      onboardingState: 'pending',
    })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy/onboarding/first-run')
    expect(next).not.toHaveBeenCalled()
  })

  it('pending + nested admin page → redirect to /onboarding/first-run', () => {
    const req = makeReq({
      path: '/admin/store/lifeasy/settings/general',
      onboardingState: 'pending',
    })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy/onboarding/first-run')
    expect(next).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Bypass list — pending but allowed through
// ---------------------------------------------------------------------------

describe('onboardingGate — bypass list', () => {
  const bypass: Array<[string, string]> = [
    ['wizard welcome', '/admin/store/lifeasy/onboarding/first-run'],
    ['wizard clone', '/admin/store/lifeasy/onboarding/clone'],
    ['wizard library alias', '/admin/store/lifeasy/onboarding/library'],
    ['wizard skip POST', '/admin/store/lifeasy/onboarding/skip'],
    ['api surface', '/admin/store/lifeasy/api/v1/products'],
    ['assets', '/admin/store/lifeasy/assets/app.css'],
    ['logout', '/admin/store/lifeasy/logout'],
    // 2026-04-26: clone-pro bypass removed (god-admin-only concierge tooling).
  ]

  for (const [label, path] of bypass) {
    it(`pending + ${label} (${path}) → pass-through, no redirect`, () => {
      const req = makeReq({ path, onboardingState: 'pending' })
      const res = makeRes()
      const next = vi.fn()
      onboardingGate(req, res, next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(res.redirect).not.toHaveBeenCalled()
    })
  }

  it('bypass regex does not match sibling slug as a prefix', () => {
    // Regression guard: a path like .../onboardings (extra 's') must
    // NOT match the onboarding bypass — a seller might have a
    // "/onboardings-legacy" route one day and we shouldn't accidentally
    // unblock it.
    const req = makeReq({
      path: '/admin/store/lifeasy/onboardings/first-run',
      onboardingState: 'pending',
    })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy/onboarding/first-run')
    expect(next).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Skipped-state banner flag
// ---------------------------------------------------------------------------

describe('onboardingGate — skipped banner', () => {
  it('skipped + dashboard → pass-through with showOnboardingBanner=true', () => {
    const req = makeReq({
      path: '/admin/store/lifeasy/products',
      onboardingState: 'skipped',
    })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.locals.showOnboardingBanner).toBe(true)
  })

  it('skipped + wizard page → pass-through, banner flag NOT set', () => {
    // Once the seller is back inside the wizard from the banner, the
    // banner itself would be redundant. Don't flag it for those paths.
    const req = makeReq({
      path: '/admin/store/lifeasy/onboarding/first-run',
      onboardingState: 'skipped',
    })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.locals.showOnboardingBanner).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// Terminal / in-flight states — plain pass-through
// ---------------------------------------------------------------------------

describe('onboardingGate — cloning / completed pass-through', () => {
  it('cloning + any path → pass-through, no redirect, no banner', () => {
    const req = makeReq({
      path: '/admin/store/lifeasy/products',
      onboardingState: 'cloning',
    })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.locals.showOnboardingBanner).toBeFalsy()
  })

  it('completed + any path → pass-through, no redirect, no banner', () => {
    const req = makeReq({
      path: '/admin/store/lifeasy/settings',
      onboardingState: 'completed',
    })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.locals.showOnboardingBanner).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// Defensive rails
// ---------------------------------------------------------------------------

describe('onboardingGate — defensive rails', () => {
  it('missing req.store → pass-through silently (storeAuth will handle it)', () => {
    const req = makeReq({
      path: '/admin/store/lifeasy/products',
      missingStore: true,
    })
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.redirect).not.toHaveBeenCalled()
  })

  it('onboarding_state undefined on the store row → treat as pending', () => {
    // Legacy rows pre-migration-050 or a row that hasn't been backfilled
    // yet. Default behaviour should be "wizard", not "skip the gate".
    const req: any = {
      path: '/admin/store/lifeasy/products',
      originalUrl: '/admin/store/lifeasy/products',
      params: { slug: 'lifeasy' },
      store: { id: 'shop-1', slug: 'lifeasy', name: 'Lifeasy' },
    }
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy/onboarding/first-run')
    expect(next).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Regression: production middleware-mount-strip
  //
  // `app.use('/admin/store/:slug', onboardingGate)` chops the mount prefix
  // off `req.url`/`req.path` before the gate runs. Pre-2026-04-25 the gate
  // matched the BYPASS regexes against `req.path` directly, which DOES
  // include the prefix in these unit tests (because `makeReq` sets it
  // verbatim) but DOES NOT in production — so the production bypass
  // never matched and a freshly-signed-up seller landing on
  // `/admin/store/SLUG/onboarding/first-run` got a redirect to
  // `/admin/store/SLUG/onboarding/first-run` (the same URL) → infinite
  // loop, "ERR_TOO_MANY_REDIRECTS" in the browser.
  //
  // The fix reconstructs `baseUrl + path` so the regexes see the same
  // URL shape they were authored against. These tests simulate the
  // post-mount-strip state by passing only the suffix in `path` and
  // putting the prefix in `baseUrl`.
  // -------------------------------------------------------------------------
  it('post-mount-strip wizard URL → bypassed (no redirect-loop)', () => {
    const req: any = {
      baseUrl: '/admin/store/lifeasy',
      path: '/onboarding/first-run',
      originalUrl: '/admin/store/lifeasy/onboarding/first-run',
      params: { slug: 'lifeasy' },
      store: {
        id: 'shop-1',
        slug: 'lifeasy',
        name: 'Lifeasy',
        onboarding_state: 'pending',
      },
    }
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res.redirect).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('post-mount-strip non-wizard URL → still redirects to first-run', () => {
    const req: any = {
      baseUrl: '/admin/store/lifeasy',
      path: '/products',
      originalUrl: '/admin/store/lifeasy/products',
      params: { slug: 'lifeasy' },
      store: {
        id: 'shop-1',
        slug: 'lifeasy',
        name: 'Lifeasy',
        onboarding_state: 'pending',
      },
    }
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy/onboarding/first-run')
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    '/onboarding/first-run',
    '/onboarding/library',
    '/onboarding/skip',
    '/api/v1/products',
    '/assets/app.css',
    '/logout',
    // 2026-04-26: /clone-pro bypass removed (god-admin-only concierge tooling).
    // '/onboarding/clone' also dropped — that route now 410s like the rest of clone-pro.
  ])('post-mount-strip bypass: %s', (suffix) => {
    const req: any = {
      baseUrl: '/admin/store/lifeasy',
      path: suffix,
      originalUrl: '/admin/store/lifeasy' + suffix,
      params: { slug: 'lifeasy' },
      store: {
        id: 'shop-1',
        slug: 'lifeasy',
        name: 'Lifeasy',
        onboarding_state: 'pending',
      },
    }
    const res = makeRes()
    const next = vi.fn()
    onboardingGate(req, res, next)
    expect(res.redirect).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('kill-switch flag OFF → gate becomes a no-op even for pending', () => {
    // Phase F feature flag: `GBOX_ONBOARDING_WIZARD_ENABLED !== 'true'`
    // must short-circuit the gate entirely (no redirect, no banner)
    // so we can kill-switch on server 1 without redeploying.
    const original = process.env.GBOX_ONBOARDING_WIZARD_ENABLED
    process.env.GBOX_ONBOARDING_WIZARD_ENABLED = 'false'
    try {
      const req = makeReq({
        path: '/admin/store/lifeasy/products',
        onboardingState: 'pending',
      })
      const res = makeRes()
      const next = vi.fn()
      onboardingGate(req, res, next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(res.redirect).not.toHaveBeenCalled()
      expect(res.locals.showOnboardingBanner).toBeFalsy()
    } finally {
      if (original === undefined) {
        delete process.env.GBOX_ONBOARDING_WIZARD_ENABLED
      } else {
        process.env.GBOX_ONBOARDING_WIZARD_ENABLED = original
      }
    }
  })
})
