/**
 * canonical-host-redirect tests.
 *
 * Cases:
 *   1. POST/PUT/DELETE pass through (don't break form submits)
 *   2. Skip /.well-known/* (ACME challenges work on every host)
 *   3. Skip /_health (monitors hit platform subdomain)
 *   4. Skip /assets/* (asset cache stays on same origin)
 *   5. Skip when ?preview_theme_id is present (admin preview deep links)
 *   6. Resolver returns null → pass through
 *   7. Already on canonical host → pass through
 *   8. On platform subdomain + canonical = custom → 301 with full URL
 *   9. Resolver throws → pass through (never break storefront)
 *  10. enabled=false kill switch
 */

import { describe, it, expect, vi } from 'vitest'
import { buildCanonicalHostRedirect } from './canonical-host-redirect.js'

function makeReq(opts: {
  method?: string
  hostname?: string
  path?: string
  query?: Record<string, unknown>
  originalUrl?: string
} = {}) {
  return {
    method: opts.method ?? 'GET',
    hostname: opts.hostname ?? 'best-store.gbox.co',
    path: opts.path ?? '/',
    query: opts.query ?? {},
    originalUrl: opts.originalUrl ?? opts.path ?? '/',
    headers: { host: opts.hostname ?? 'best-store.gbox.co' },
  } as any
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    type(_t: string) { return this },
    status(c: number) { this.statusCode = c; return this },
    setHeader(k: string, v: string) { this.headers[k] = v; return this },
    send(s: string) { this.body = s; return this },
  }
  return res
}

describe('canonical-host-redirect', () => {
  it('POST falls through (would lose body)', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => ({ hostname: 'tw3.store' }),
    })
    const next = vi.fn()
    mw(makeReq({ method: 'POST' }), makeRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('skips /.well-known/* (ACME)', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => ({ hostname: 'tw3.store' }),
    })
    const next = vi.fn()
    mw(makeReq({ path: '/.well-known/acme-challenge/abc' }), makeRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('skips /_health (monitors)', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => ({ hostname: 'tw3.store' }),
    })
    const next = vi.fn()
    mw(makeReq({ path: '/_health' }), makeRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('skips /assets/* (same-origin)', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => ({ hostname: 'tw3.store' }),
    })
    const next = vi.fn()
    mw(makeReq({ path: '/assets/main.css' }), makeRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('skips when ?preview_theme_id is present', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => ({ hostname: 'tw3.store' }),
    })
    const next = vi.fn()
    mw(makeReq({ query: { preview_theme_id: 'abc' } }), makeRes(), next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('resolver returns null → pass through', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => null,
    })
    const next = vi.fn()
    const res = makeRes()
    await new Promise<void>((resolve) => {
      mw(makeReq(), res, () => {
        next()
        resolve()
      })
    })
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200) // never set
  })

  it('already on canonical host → pass through', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => ({ hostname: 'tw3.store' }),
    })
    const next = vi.fn()
    const res = makeRes()
    await new Promise<void>((resolve) => {
      mw(makeReq({ hostname: 'tw3.store' }), res, () => {
        next()
        resolve()
      })
    })
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.headers['Location']).toBeUndefined()
  })

  it('platform subdomain + custom canonical → 301 to full URL preserving path + query', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => ({ hostname: 'tw3.store' }),
    })
    const next = vi.fn()
    const res = makeRes()
    await new Promise<void>((resolve) => {
      mw(
        makeReq({
          hostname: 'best-store.gbox.co',
          path: '/products/foo',
          originalUrl: '/products/foo?utm=email',
        }),
        res,
        () => {
          next()
          resolve()
        },
      )
      // Settle on next tick if redirect was synchronous-via-promise.
      setImmediate(() => resolve())
    })
    expect(res.statusCode).toBe(301)
    expect(res.headers['Location']).toBe('https://tw3.store/products/foo?utm=email')
    expect(res.headers['Link']).toContain('rel="canonical"')
    expect(next).not.toHaveBeenCalled()
  })

  it('resolver throws → pass through (never break storefront)', async () => {
    const mw = buildCanonicalHostRedirect({
      getCanonicalHost: async () => {
        throw new Error('db down')
      },
    })
    const next = vi.fn()
    const res = makeRes()
    await new Promise<void>((resolve) => {
      mw(makeReq(), res, () => {
        next()
        resolve()
      })
    })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('enabled=false → no-op', () => {
    const mw = buildCanonicalHostRedirect({
      enabled: false,
      getCanonicalHost: async () => ({ hostname: 'tw3.store' }),
    })
    const next = vi.fn()
    const res = makeRes()
    mw(makeReq({ hostname: 'best-store.gbox.co' }), res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.headers['Location']).toBeUndefined()
  })
})
