/**
 * Security Headers — Storefront helper tests (Phase 3A Step 3A.3)
 *
 * Until Phase 3A, `headers.ts` only exposed two helmet() instances
 * (`securityHeaders` for the API and `adminSecurityHeaders` for the
 * admin panels). The storefront needs a third variant with different
 * rules — it serves public HTML that has to render merchant-supplied
 * Liquid templates, external product images, analytics pixels, chat
 * widgets and embedded fonts, none of which the admin or the API
 * ever deal with.
 *
 * These tests lock in the contract of the new helper without
 * depending on helmet's internal behaviour:
 *
 *   1. The exported `storefrontCspDirectives` const is the source
 *      of truth. Test directly against it so any regression in the
 *      directive list is caught in review.
 *   2. `storefrontSecurityHeaders` is the helmet middleware built
 *      from those directives. A smoke test pipes a fake req/res
 *      through it and asserts that the critical response headers
 *      (CSP, HSTS, X-Content-Type-Options, Referrer-Policy) are
 *      set, so helmet-version bumps don't silently drop protection.
 */

import { describe, it, expect } from 'vitest'

// These tests lock in the *production* contract for storefront security
// headers (HSTS set, upgrade-insecure-requests emitted). Since
// `headers.ts` reads NODE_ENV at module load to decide whether to emit
// HSTS + upgrade-insecure-requests (we deliberately turn both off in
// development so dev boxes served over http:// don't lock browsers out —
// see the comment at the top of headers.ts), we pin NODE_ENV to
// 'production' BEFORE importing the module, then use a dynamic import so
// the env var is set before the top-level const runs.
process.env.NODE_ENV = 'production'
const {
  storefrontCspDirectives,
  storefrontSecurityHeaders,
  adminSecurityHeaders,
} = await import('./headers.js')

// ---------------------------------------------------------------------------
// storefrontCspDirectives — directive dict shape
// ---------------------------------------------------------------------------

describe('storefrontCspDirectives', () => {
  it('is a plain object (helmet accepts this shape directly)', () => {
    expect(typeof storefrontCspDirectives).toBe('object')
    expect(storefrontCspDirectives).not.toBeNull()
  })

  it('keeps objectSrc locked to none (Flash/Silverlight kill-switch)', () => {
    expect(storefrontCspDirectives.objectSrc).toEqual(["'none'"])
  })

  it('keeps baseUri locked to self (prevents <base> href injection)', () => {
    expect(storefrontCspDirectives.baseUri).toEqual(["'self'"])
  })

  it('allows inline styles because Liquid themes emit inline style blocks', () => {
    expect(storefrontCspDirectives.styleSrc).toContain("'unsafe-inline'")
    expect(storefrontCspDirectives.styleSrc).toContain("'self'")
  })

  it('allows inline scripts because theme.js often lives in layout', () => {
    expect(storefrontCspDirectives.scriptSrc).toContain("'unsafe-inline'")
    expect(storefrontCspDirectives.scriptSrc).toContain("'self'")
  })

  it('allows https scripts so merchants can embed analytics + chat widgets', () => {
    expect(storefrontCspDirectives.scriptSrc).toContain('https:')
  })

  it('allows external images from https and data URIs (product CDNs + inline SVG placeholders)', () => {
    expect(storefrontCspDirectives.imgSrc).toContain("'self'")
    expect(storefrontCspDirectives.imgSrc).toContain('https:')
    expect(storefrontCspDirectives.imgSrc).toContain('data:')
    expect(storefrontCspDirectives.imgSrc).toContain('blob:')
  })

  it('allows external https fonts (Google Fonts / Adobe Fonts)', () => {
    expect(storefrontCspDirectives.fontSrc).toContain("'self'")
    expect(storefrontCspDirectives.fontSrc).toContain('https:')
    expect(storefrontCspDirectives.fontSrc).toContain('data:')
  })

  it('allows connect-src to https for analytics beacons', () => {
    expect(storefrontCspDirectives.connectSrc).toContain("'self'")
    expect(storefrontCspDirectives.connectSrc).toContain('https:')
  })

  it('keeps frameAncestors at self so merchants can embed their own storefront in preview iframes', () => {
    // Unlike adminSecurityHeaders (which is 'none'), the storefront
    // has to be embeddable from the merchant's own admin preview.
    expect(storefrontCspDirectives.frameAncestors).toEqual(["'self'"])
  })

  it('restricts form-action to self + https (checkout handoff)', () => {
    expect(storefrontCspDirectives.formAction).toContain("'self'")
    expect(storefrontCspDirectives.formAction).toContain('https:')
  })

  it('upgrades insecure requests (forces http → https for embedded assets)', () => {
    // upgrade-insecure-requests is represented as an empty array in
    // helmet's directive shape.
    expect(storefrontCspDirectives.upgradeInsecureRequests).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// storefrontSecurityHeaders — smoke test through fake req/res
// ---------------------------------------------------------------------------

describe('storefrontSecurityHeaders middleware', () => {
  interface FakeRes {
    headers: Record<string, string>
    setHeader(name: string, value: string): void
    getHeader(name: string): string | undefined
    removeHeader(name: string): void
  }

  function mkRes(): FakeRes {
    return {
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value
      },
      getHeader(name) {
        return this.headers[name.toLowerCase()]
      },
      removeHeader(name) {
        delete this.headers[name.toLowerCase()]
      },
    }
  }

  function runMiddleware(): Promise<FakeRes> {
    return new Promise((resolve, reject) => {
      const res = mkRes()
      const req = { headers: {}, secure: true } as never
      storefrontSecurityHeaders(req, res as never, (err?: unknown) => {
        if (err) reject(err)
        else resolve(res)
      })
    })
  }

  it('sets Content-Security-Policy with the storefront directives', async () => {
    const res = await runMiddleware()
    const csp = res.getHeader('content-security-policy')
    expect(csp).toBeTruthy()
    expect(csp!).toContain("default-src")
    expect(csp!).toContain("object-src 'none'")
    expect(csp!).toContain('frame-ancestors')
  })

  it('sets Strict-Transport-Security with a long max-age', async () => {
    const res = await runMiddleware()
    const hsts = res.getHeader('strict-transport-security')
    expect(hsts).toBeTruthy()
    expect(hsts!).toMatch(/max-age=\d+/)
  })

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await runMiddleware()
    expect(res.getHeader('x-content-type-options')).toBe('nosniff')
  })

  it('sets Referrer-Policy', async () => {
    const res = await runMiddleware()
    expect(res.getHeader('referrer-policy')).toBeTruthy()
  })

  it('does NOT set X-Frame-Options DENY (frameAncestors replaces it and we want self-embedding)', async () => {
    const res = await runMiddleware()
    const xfo = res.getHeader('x-frame-options')
    // If set at all, must not be DENY (which would break merchant
    // preview iframes). SAMEORIGIN is acceptable as a fallback.
    if (xfo) {
      expect(xfo.toLowerCase()).not.toBe('deny')
    }
  })
})

// ---------------------------------------------------------------------------
// adminSecurityHeaders — regression guard for April 2026 "Import order
// button does nothing" bug. helmet defaults `script-src-attr` to `'none'`
// which silently blocks every `onclick=""` handler in server-rendered HTML.
// We rely on inline onclick in store-admin + god-admin, so the directive
// MUST include `'unsafe-inline'`. If a future helmet upgrade or refactor
// drops this, dropdowns and modals across both admin apps will mysteriously
// stop working and the only symptom is "the button is broken".
// Ported from master during PR #10 merge (commit 4a2ed50).
// ---------------------------------------------------------------------------

describe('adminSecurityHeaders middleware', () => {
  interface FakeRes {
    headers: Record<string, string>
    setHeader(name: string, value: string): void
    getHeader(name: string): string | undefined
    removeHeader(name: string): void
  }

  function mkRes(): FakeRes {
    return {
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value
      },
      getHeader(name) {
        return this.headers[name.toLowerCase()]
      },
      removeHeader(name) {
        delete this.headers[name.toLowerCase()]
      },
    }
  }

  function runAdminMiddleware(): Promise<FakeRes> {
    return new Promise((resolve, reject) => {
      const res = mkRes()
      const req = { headers: {}, secure: true } as never
      adminSecurityHeaders(req, res as never, (err?: unknown) => {
        if (err) reject(err)
        else resolve(res)
      })
    })
  }

  it("allows inline onclick handlers via script-src-attr 'unsafe-inline'", async () => {
    const res = await runAdminMiddleware()
    const csp = res.getHeader('content-security-policy')
    expect(csp).toBeTruthy()
    // This is the critical assertion — if this fails, every dropdown
    // menu and modal trigger in store-admin and god-admin breaks.
    expect(csp!).toContain("script-src-attr 'unsafe-inline'")
  })

  it("allows inline <script> blocks via script-src 'unsafe-inline'", async () => {
    const res = await runAdminMiddleware()
    const csp = res.getHeader('content-security-policy')
    expect(csp!).toMatch(/script-src [^;]*'unsafe-inline'/)
  })

  it('still locks object-src to none (admin never needs Flash/Silverlight)', async () => {
    const res = await runAdminMiddleware()
    const csp = res.getHeader('content-security-policy')
    expect(csp!).toContain("object-src 'none'")
  })

  it('still locks frame-ancestors to none (admin must never be embedded)', async () => {
    const res = await runAdminMiddleware()
    const csp = res.getHeader('content-security-policy')
    expect(csp!).toContain("frame-ancestors 'none'")
  })
})
