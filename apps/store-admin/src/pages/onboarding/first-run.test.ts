/**
 * Store-admin — first-run wizard handler tests (Phase B / Task B1).
 *
 * The handler is the entry point at GET /admin/store/:slug/onboarding/first-run.
 * It makes three state-based decisions before rendering anything:
 *
 *   completed  → 302 to the dashboard (wizard done — don't re-show)
 *   cloning    → 302 to /clone-pro/:jobId (seller mid-clone — resume progress)
 *   pending    → render the two-tab welcome page
 *   skipped    → also render the welcome page (seller clicked "later",
 *                coming back via the Resume banner)
 *
 * Query-string knobs:
 *
 *   ?welcome=1   → stamp the hero H1 "Welcome to Gbox!" on first arrival.
 *   ?tab=library → deep-link to the Theme Library tab (aria-selected=true).
 *   ?from=domain-verified → celebratory "Your domain is live!" banner
 *                 when the seller just wired a custom domain mid-setup.
 *
 * These tests exercise the routing decisions and the composition of the
 * rendered welcome HTML (via stubbed `renderWelcome` + fake DB). We do
 * NOT re-assert the full welcome-component HTML here — that's covered
 * by `welcome.test.ts`.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

// We need to intercept `listFeaturedSeeds` (invoked deep inside the
// library helper) AND the sellerLayout wrap. Use vi.mock so the
// first-run handler picks up controllable stand-ins.

vi.mock('@gbox/core/modules/design-library/index.js', async (orig) => {
  const actual = (await orig()) as object
  return {
    ...actual,
    listFeaturedSeeds: vi.fn(async () => []),
  }
})

vi.mock('../../layouts/seller-layout.js', () => ({
  sellerLayout: (opts: { title: string; content: string; activePage: string }) =>
    `<layout title="${opts.title}" page="${opts.activePage}">${opts.content}</layout>`,
  esc: (s: string) => s,
}))

import { getOnboardingFirstRun } from './first-run.js'

// ---------------------------------------------------------------------------
// Test-double builders
// ---------------------------------------------------------------------------

function makeReq(opts: {
  slug?: string
  onboardingState?: 'pending' | 'cloning' | 'completed' | 'skipped'
  cloneJobId?: string | null
  query?: Record<string, string>
} = {}) {
  return {
    store: {
      id: 'shop-1',
      slug: opts.slug ?? 'lifeasy',
      name: 'Lifeasy Store',
      onboarding_state: opts.onboardingState ?? 'pending',
      onboarding_clone_job_id: opts.cloneJobId ?? null,
    },
    storeUser: {
      name: 'Thai Bui',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    query: opts.query ?? {},
    headers: {},
    // Production middleware sets `req.csrfToken` to a STRING. Pre-2026-04-25
    // tests used a function shape that masked the production-empty-token bug.
    csrfToken: 'csrf-TEST',
  } as any
}

function makeRes() {
  const res: any = {
    _sentBody: '',
    _redirectUrl: null as string | null,
    _redirectStatus: 0,
  }
  res.redirect = vi.fn((arg1: any, arg2?: any) => {
    res._redirectStatus = typeof arg1 === 'number' ? arg1 : 302
    res._redirectUrl = typeof arg1 === 'number' ? arg2 : arg1
    return res
  })
  res.send = vi.fn((body: string) => { res._sentBody = body; return res })
  res.setHeader = vi.fn()
  return res
}

// Minimal DB stub — first-run queries run through the library helper
// which is mocked at the listFeaturedSeeds boundary above.
const fakeDb = {} as any

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// State-based routing
// ---------------------------------------------------------------------------

describe('getOnboardingFirstRun — state routing', () => {
  it('redirects to the dashboard when onboarding_state=completed', async () => {
    const req = makeReq({ slug: 'lifeasy', onboardingState: 'completed' })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res.redirect).toHaveBeenCalledTimes(1)
    expect(res._redirectUrl).toBe('/admin/store/lifeasy')
    expect(res.send).not.toHaveBeenCalled()
  })

  it('falls through to welcome page when state=cloning (clone-pro retired 2026-04-26)', async () => {
    // Legacy `cloning` state from the retired clone-pro surface no
    // longer redirects anywhere — the seller sees the Theme Library
    // welcome page on next visit. God admin can resume their pre-cutover
    // job via internal tooling.
    const req = makeReq({
      slug: 'lifeasy',
      onboardingState: 'cloning',
      cloneJobId: 'job-abc-123',
    })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.send).toHaveBeenCalledTimes(1)
  })

  it('renders the wizard when state=pending (default path)', async () => {
    const req = makeReq({ onboardingState: 'pending' })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res.send).toHaveBeenCalledTimes(1)
    expect(res.redirect).not.toHaveBeenCalled()
    // 2026-04-26: tablist removed (clone tab dropped); Theme Library
    // panel renders solo. Assert the panel is present instead.
    expect(res._sentBody).toMatch(/id="panel-library"/)
  })

  it('renders the wizard when state=skipped (seller came back via Resume banner)', async () => {
    const req = makeReq({ onboardingState: 'skipped' })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res.send).toHaveBeenCalledTimes(1)
    expect(res._sentBody).toMatch(/id="panel-library"/)
  })
})

// ---------------------------------------------------------------------------
// Query-string knobs
// ---------------------------------------------------------------------------

describe('getOnboardingFirstRun — query flags', () => {
  it('renders the "Welcome to Gbox!" hero when ?welcome=1', async () => {
    const req = makeReq({ query: { welcome: '1' } })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res._sentBody).toMatch(/Welcome to Gbox/)
  })

  it('renders the library panel regardless of ?tab value (clone tab dropped)', async () => {
    // 2026-04-26: Clone Pro re-scoped to god-admin-only. The wizard now
    // ships a single Theme Library panel — no tablist, no aria-selected.
    const reqWithLibrary = makeReq({ query: { tab: 'library' } })
    const resWithLibrary = makeRes()
    await getOnboardingFirstRun(reqWithLibrary, resWithLibrary, fakeDb)
    expect(resWithLibrary._sentBody).toMatch(/id="panel-library"/)
    expect(resWithLibrary._sentBody).not.toMatch(/role="tablist"/)
    expect(resWithLibrary._sentBody).not.toMatch(/id="panel-clone"/)
  })

  it('renders the library panel when no ?tab is passed', async () => {
    const req = makeReq({})
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res._sentBody).toMatch(/id="panel-library"/)
    expect(res._sentBody).not.toMatch(/id="panel-clone"/)
  })

  it('renders the domain-verified banner when ?from=domain-verified', async () => {
    const req = makeReq({ query: { from: 'domain-verified' } })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res._sentBody).toMatch(/domain is live|domain verified/i)
  })

  it('does NOT render the domain-verified banner for other ?from values', async () => {
    const req = makeReq({ query: { from: 'something-else' } })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res._sentBody).not.toMatch(/domain is live/i)
  })
})

// ---------------------------------------------------------------------------
// Composed URL correctness — making sure the action URLs line up with
// Phase C/D handler routes. Getting these wrong silently 404s the seller
// and kills the wizard.
// ---------------------------------------------------------------------------

describe('getOnboardingFirstRun — URL composition', () => {
  it('does NOT render a Clone-from-URL CTA (clone-pro retired 2026-04-26)', async () => {
    const req = makeReq({ slug: 'acme-store' })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res._sentBody).not.toMatch(/href="\/admin\/store\/acme-store\/onboarding\/clone"/)
    expect(res._sentBody).not.toMatch(/Start cloning/)
  })

  it('points the skip form at /onboarding/skip for the request slug', async () => {
    const req = makeReq({ slug: 'acme-store' })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res._sentBody).toMatch(
      /<form[^>]*action="\/admin\/store\/acme-store\/onboarding\/skip"/,
    )
  })

  it('points "Browse full library" at design-library with from=onboarding', async () => {
    const req = makeReq({ slug: 'acme-store' })
    const res = makeRes()
    await getOnboardingFirstRun(req, res, fakeDb)
    expect(res._sentBody).toMatch(
      /href="\/admin\/store\/acme-store\/online-store\/library\?from=onboarding"/,
    )
  })
})
