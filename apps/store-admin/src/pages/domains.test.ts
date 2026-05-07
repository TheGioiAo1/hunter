/**
 * Store-admin — postVerifyDomain onboarding nudge (Phase E Task E2).
 *
 * When a seller verifies their first custom domain AND their shop is
 * still in `onboarding_state='pending'`, route them back into the
 * onboarding wizard with `?from=domain-verified` so the welcome-page
 * experience picks up from a real achievement (verified domain) rather
 * than dumping them on the bare Domains page with a green pill.
 *
 * The hook is a narrow branch INSIDE the `result.ok` success path of
 * `postVerifyDomain` — it fires BEFORE the existing `?success=...`
 * redirect. All other states (`completed`, `skipped`, `cloning`, plus
 * any legacy null) fall through to the pre-existing redirect chain so
 * veteran sellers still see the usual success banner.
 *
 * We deliberately keep these tests isolated to the nudge branch — the
 * rest of the verify handler (NS lookup, A-record detect, notifications,
 * audit log) is tested against the real DNS resolver integration in
 * `packages/core/src/modules/domains/cloudflare-service.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --------------------------------------------------------------------
// Module mocks — must come BEFORE the import of domains.ts
// --------------------------------------------------------------------

vi.mock('@gbox/core/modules/domains/cloudflare-service.js', () => ({
  addDomain: vi.fn(),
  verifyDomain: vi.fn(),
  setPrimary: vi.fn(),
  setRedirect: vi.fn(),
  removeDomain: vi.fn(),
}))
vi.mock('@gbox/core/modules/ops/a-record-detect.js', () => ({
  parsePlatformIpEnv: vi.fn(() => ['192.168.1.13']),
}))
vi.mock('../lib/notify.js', () => ({
  notify: vi.fn(),
  byActor: vi.fn((u: any) => `By ${u?.name ?? u?.email ?? 'unknown'}`),
}))
vi.mock('../middleware/store-auth.js', () => ({
  logSellerAction: vi.fn().mockResolvedValue(undefined),
}))
// Bypass node:dns import at the top of makeDnsResolvers — we don't
// actually hit DNS because verifyDomain itself is mocked, but the
// dynamic import inside `makeDnsResolvers` still runs before the mock
// takes over. Make it a harmless no-op.
vi.mock('node:dns/promises', () => ({
  resolveNs: vi.fn(),
  resolveCname: vi.fn(),
  resolve4: vi.fn(),
}))

import { verifyDomain } from '@gbox/core/modules/domains/cloudflare-service.js'
import { postVerifyDomain } from './domains.js'

// --------------------------------------------------------------------
// Request / Response test doubles
// --------------------------------------------------------------------

function makeReq(opts: {
  slug?: string
  shopId?: string
  domainId?: string
  onboardingState?: string | null
} = {}) {
  return {
    store: {
      id: opts.shopId ?? 'shop-1',
      slug: opts.slug ?? 'my-store',
      name: 'My Store',
      domain: null,
      plan: 'free',
      status: 'active',
      currency: 'USD',
      onboarding_state: opts.onboardingState ?? 'completed',
    },
    storeUser: {
      id: 'user-1',
      name: 'Thai',
      email: 'thai@example.com',
      role: 'owner',
      storeRole: 'owner',
    },
    body: { domain_id: opts.domainId ?? 'dom-1' },
    query: {},
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as any
}

function makeRes() {
  const res: any = { _redirectUrl: null, _statusCode: 200 }
  res.status = vi.fn().mockImplementation((n: number) => {
    res._statusCode = n
    return res
  })
  res.redirect = vi.fn().mockImplementation((arg1: any, arg2?: any) => {
    if (typeof arg1 === 'number') {
      res._statusCode = arg1
      res._redirectUrl = arg2
    } else {
      res._statusCode = 302
      res._redirectUrl = arg1
    }
    return res
  })
  res.send = vi.fn().mockImplementation((b: any) => {
    res._body = b
    return res
  })
  return res
}

function makeDb(): any {
  // The nudge branch fires BEFORE any DB follow-ups inside the handler,
  // but verifyDomain itself is mocked so the handler never actually
  // reaches Kysely. Return a loose any-shaped stub so imports don't
  // fail if a future chain landed.
  return {} as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

// --------------------------------------------------------------------
// Nudge branch: pending → onboarding wizard
// --------------------------------------------------------------------

describe('postVerifyDomain onboarding nudge (Phase E Task E2)', () => {
  it('redirects to the wizard when onboarding_state=pending and verify succeeds', async () => {
    ;(verifyDomain as any).mockResolvedValue({
      ok: true,
      domain: 'www.mystore.com',
      method: 'cloudflare',
    })
    const req = makeReq({
      slug: 'my-store',
      onboardingState: 'pending',
    })
    const res = makeRes()
    const db = makeDb()

    await postVerifyDomain(req, res, db)

    expect(res.redirect).toHaveBeenCalled()
    // The nudge must land on the first-run wizard with a
    // `from=domain-verified` breadcrumb so the welcome page can
    // acknowledge the verification.
    expect(res._redirectUrl).toContain('/admin/store/my-store/onboarding/first-run')
    expect(res._redirectUrl).toContain('from=domain-verified')
    // The old success banner URL must NOT fire when we've nudged the
    // seller into the wizard — otherwise they'd land on /onboarding/
    // first-run after the wizard dismissed.
    expect(res._redirectUrl).not.toContain('tab=custom')
    expect(res._redirectUrl).not.toContain('success=')
  })

  it('falls through to the success redirect when onboarding_state=completed', async () => {
    ;(verifyDomain as any).mockResolvedValue({
      ok: true,
      domain: 'www.mystore.com',
      method: 'cloudflare',
    })
    const req = makeReq({
      slug: 'my-store',
      onboardingState: 'completed',
    })
    const res = makeRes()
    const db = makeDb()

    await postVerifyDomain(req, res, db)

    expect(res.redirect).toHaveBeenCalled()
    // Veteran seller who already finished onboarding — usual success
    // banner redirect with `?tab=custom&success=...` should fire.
    expect(res._redirectUrl).toContain('tab=custom')
    expect(res._redirectUrl).toContain('success=')
    expect(res._redirectUrl).not.toContain('/onboarding/first-run')
  })

  it('falls through to the success redirect when onboarding_state=skipped', async () => {
    // Skipped sellers already dismissed the wizard; they should NOT be
    // re-captured into it just because they later added a domain.
    ;(verifyDomain as any).mockResolvedValue({
      ok: true,
      domain: 'www.mystore.com',
      method: 'cloudflare',
    })
    const req = makeReq({
      slug: 'my-store',
      onboardingState: 'skipped',
    })
    const res = makeRes()
    const db = makeDb()

    await postVerifyDomain(req, res, db)

    expect(res._redirectUrl).toContain('tab=custom')
    expect(res._redirectUrl).not.toContain('/onboarding/first-run')
  })

  it('falls through when onboarding_state is null (legacy pre-050 row)', async () => {
    // Legacy rows pre-migration-050 read back NULL. The gate middleware
    // defaults those to 'pending', but for the nudge we want to be
    // strict: only nudge rows that explicitly carry 'pending'. That
    // way the hook has no effect on backfilled-but-veteran stores.
    ;(verifyDomain as any).mockResolvedValue({
      ok: true,
      domain: 'www.mystore.com',
      method: 'cloudflare',
    })
    const req = makeReq({
      slug: 'my-store',
      onboardingState: null,
    })
    const res = makeRes()
    const db = makeDb()

    await postVerifyDomain(req, res, db)

    expect(res._redirectUrl).toContain('tab=custom')
    expect(res._redirectUrl).not.toContain('/onboarding/first-run')
  })

  it('does not nudge on verification failure even if state=pending', async () => {
    // The whole point of the nudge is "first verified domain" — if
    // verify failed, we still want the seller on the Domains page
    // with the error banner so they can retry, not bounced into the
    // wizard.
    ;(verifyDomain as any).mockResolvedValue({
      ok: false,
      error: 'not_verified',
      aRecord: { matched: false, observedIps: [], platformIps: [] },
      cloudflare: { cloudflareProxied: false, nameservers: [], dnsTarget: null },
    })
    const req = makeReq({
      slug: 'my-store',
      onboardingState: 'pending',
    })
    const res = makeRes()
    const db = makeDb()

    await postVerifyDomain(req, res, db)

    expect(res._redirectUrl).toContain('tab=custom')
    expect(res._redirectUrl).toContain('error=')
    expect(res._redirectUrl).not.toContain('/onboarding/first-run')
  })
})
