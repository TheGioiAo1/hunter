/**
 * Store-admin — Onboarding banner injection middleware tests
 * (Phase D / Task D2).
 *
 * The Resume-setup banner appears above the page content on every
 * `/admin/store/:slug/*` view when `res.locals.showOnboardingBanner` is
 * truthy (set by the gate middleware for shops in state='skipped').
 *
 * Integration approach: the seller-layout template embeds a well-known
 * placeholder comment (`<!--GBOX_ONBOARDING_BANNER_SLOT-->`) just above
 * `${content}`. This middleware wraps `res.send` and, before flushing,
 * replaces the placeholder with either:
 *
 *   - the banner HTML (when `res.locals.showOnboardingBanner === true`)
 *   - an empty string  (otherwise — keeps the HTML clean)
 *
 * Why this approach: there are 200+ `sellerLayout(...)` call sites in
 * the store-admin tree. Adding a prop to every one of them would be
 * a mechanical but huge diff; the placeholder-replace keeps the change
 * to two files (seller-layout template + this middleware) plus the
 * banner-renderer tests below.
 *
 * The banner-render helper is tested alongside because the middleware
 * is the only caller. Separate file would fragment the coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  onboardingBannerInjector,
  renderOnboardingResumeBanner,
} from './onboarding-banner.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeReq(opts: {
  slug?: string
  csrfToken?: string
} = {}) {
  return {
    params: { slug: opts.slug ?? 'lifeasy' },
    // 2026-04-25 — real middleware sets `req.csrfToken` to a STRING,
    // not a function. Test mock pre-fix used a function shape that
    // matched onboarding-banner.ts's broken `typeof === 'function'`
    // read but masked the production-empty-token bug. Tests now
    // match the real shape; banner middleware reads either form for
    // back-compat.
    csrfToken: opts.csrfToken ?? 'csrf-TEST',
  } as any
}

function makeRes(opts: { showBanner?: boolean } = {}) {
  const res: any = {
    locals: {} as Record<string, unknown>,
    _sent: undefined as unknown,
    _sentCount: 0,
  }
  if (opts.showBanner) res.locals.showOnboardingBanner = true
  // Real Express `send` returns the response object. Our stub captures
  // the flushed body so the assertions can inspect it.
  res.send = vi.fn(function send(body: unknown) {
    res._sent = body
    res._sentCount += 1
    return res
  })
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Middleware — placeholder substitution
// ---------------------------------------------------------------------------

describe('onboardingBannerInjector — placeholder replacement', () => {
  const SLOT = '<!--GBOX_ONBOARDING_BANNER_SLOT-->'

  it('showOnboardingBanner=true → slot is replaced with banner HTML', () => {
    const req = makeReq({ slug: 'acme' })
    const res = makeRes({ showBanner: true })
    const next = vi.fn()
    onboardingBannerInjector(req, res, next)
    expect(next).toHaveBeenCalled()

    res.send(`<html><body>${SLOT}<h1>Products</h1></body></html>`)
    const body = String(res._sent)
    expect(body).not.toContain(SLOT)
    expect(body).toMatch(/finish setting up your store/i)
    expect(body).toContain('/admin/store/acme/onboarding/first-run')
  })

  it('showOnboardingBanner=false → slot is replaced with empty string', () => {
    const req = makeReq()
    const res = makeRes({ showBanner: false })
    const next = vi.fn()
    onboardingBannerInjector(req, res, next)
    res.send(`<html><body>${SLOT}<h1>Products</h1></body></html>`)
    const body = String(res._sent)
    expect(body).not.toContain(SLOT)
    expect(body).not.toMatch(/finish setting up your store/i)
  })

  it('missing showOnboardingBanner → slot is replaced with empty string', () => {
    const req = makeReq()
    const res = makeRes() // no flag set
    const next = vi.fn()
    onboardingBannerInjector(req, res, next)
    res.send(`<p>${SLOT}body content</p>`)
    const body = String(res._sent)
    expect(body).not.toContain(SLOT)
    expect(body).toContain('body content')
  })

  it('response body with no slot → passes through untouched', () => {
    const req = makeReq()
    const res = makeRes({ showBanner: true })
    const next = vi.fn()
    onboardingBannerInjector(req, res, next)
    const input = '<html><body><h1>No slot here</h1></body></html>'
    res.send(input)
    expect(res._sent).toBe(input)
  })

  it('non-string body (Buffer, JSON) → passes through untouched', () => {
    const req = makeReq()
    const res = makeRes({ showBanner: true })
    const next = vi.fn()
    onboardingBannerInjector(req, res, next)
    const buf = Buffer.from('binary-response')
    res.send(buf)
    expect(res._sent).toBe(buf)
  })

  it('send is called exactly once after injection (no double-flush)', () => {
    // Wrapping res.send is a subtle place to regress — if the wrapper
    // forwards back into itself instead of the inner captured ref, we
    // get an infinite loop. Guard: the flushed body lands in our stub
    // exactly once, and the send spy is only called once too.
    const req = makeReq()
    const res = makeRes({ showBanner: true })
    const next = vi.fn()
    onboardingBannerInjector(req, res, next)
    res.send(`<div>${SLOT}</div>`)
    expect(res._sentCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Banner renderer — pure function
// ---------------------------------------------------------------------------

describe('renderOnboardingResumeBanner', () => {
  it('renders the primary Finish-setup copy', () => {
    const html = renderOnboardingResumeBanner({ slug: 'lifeasy', csrfToken: 'x' })
    expect(html).toMatch(/finish setting up your store/i)
  })

  it('Resume CTA points at /onboarding/first-run for the current slug', () => {
    const html = renderOnboardingResumeBanner({ slug: 'acme', csrfToken: 'x' })
    expect(html).toContain('href="/admin/store/acme/onboarding/first-run"')
  })

  it('Dismiss form POSTs to /onboarding/dismiss-banner with _csrf hidden input', () => {
    const html = renderOnboardingResumeBanner({
      slug: 'acme',
      csrfToken: 'csrf-XYZ',
    })
    expect(html).toContain('action="/admin/store/acme/onboarding/dismiss-banner"')
    expect(html).toMatch(/method="post"/i)
    expect(html).toMatch(/name="_csrf"\s+value="csrf-XYZ"/)
  })

  it('NEVER leaks "design library" or "god admin" seller-facing copy', () => {
    // Rule 5 (seller UI): the banner is the most prominent seller
    // surface and must not expose internal wording. Regression guard.
    const html = renderOnboardingResumeBanner({ slug: 'acme', csrfToken: 'x' })
    expect(html.toLowerCase()).not.toContain('design library')
    expect(html.toLowerCase()).not.toContain('god admin')
    expect(html.toLowerCase()).not.toContain('/god-admin')
  })

  it('has an a11y landmark role for the banner', () => {
    const html = renderOnboardingResumeBanner({ slug: 'acme', csrfToken: 'x' })
    expect(html).toMatch(/role="complementary"|role="region"/)
  })

  it('HTML-escapes the slug so a hostile slug cannot break out', () => {
    // Defense-in-depth: slugs are validated at creation, but a seller
    // who somehow landed "a</span><script>" should NOT see a parsed
    // script tag in their banner. The &lt; appears in the attribute
    // value but not as a live <.
    const html = renderOnboardingResumeBanner({
      slug: 'a"><script>',
      csrfToken: 'x',
    })
    expect(html).not.toContain('<script>')
  })
})
