/**
 * Gbox Platform — Edge Cache Headers Tests (Phase 3D)
 *
 * Pure string-building + a fake header bag for the apply helper.
 * No network, no Express.
 */

import { describe, it, expect } from 'vitest'
import {
  buildCacheControl,
  buildEdgeCacheControl,
  applyCachePolicy,
  cacheHeaders,
  CACHE_PRESETS,
  type CachePolicy,
  type HeaderBag,
} from './edge-headers.js'

function makeRecorder(): HeaderBag & { headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  return {
    headers,
    set(name, value) {
      headers[name] = value
    },
  }
}

describe('buildCacheControl', () => {
  it('emits no-store for the no-store scope', () => {
    expect(buildCacheControl({ scope: 'no-store', maxAge: 0 })).toBe('no-store')
  })

  it('emits public + max-age + s-maxage for a public policy', () => {
    expect(
      buildCacheControl({ scope: 'public', maxAge: 60, sMaxAge: 300 }),
    ).toBe('public, max-age=60, s-maxage=300')
  })

  it('defaults s-maxage to max-age when omitted', () => {
    expect(buildCacheControl({ scope: 'public', maxAge: 60 })).toBe(
      'public, max-age=60, s-maxage=60',
    )
  })

  it('includes stale-while-revalidate and stale-if-error when set', () => {
    const value = buildCacheControl({
      scope: 'public',
      maxAge: 0,
      sMaxAge: 60,
      staleWhileRevalidate: 600,
      staleIfError: 86_400,
    })
    expect(value).toContain('stale-while-revalidate=600')
    expect(value).toContain('stale-if-error=86400')
  })

  it('includes must-revalidate and immutable only when set', () => {
    expect(
      buildCacheControl({ scope: 'public', maxAge: 0, mustRevalidate: true }),
    ).toContain('must-revalidate')
    expect(
      buildCacheControl({ scope: 'public', maxAge: 1, immutable: true }),
    ).toContain('immutable')
    expect(buildCacheControl({ scope: 'public', maxAge: 1 })).not.toContain(
      'immutable',
    )
  })

  it('emits private + max-age for private scope (no s-maxage)', () => {
    expect(buildCacheControl({ scope: 'private', maxAge: 0 })).toBe(
      'private, max-age=0',
    )
  })

  it('clamps negative max-age to zero', () => {
    expect(buildCacheControl({ scope: 'public', maxAge: -5, sMaxAge: -10 })).toBe(
      'public, max-age=0, s-maxage=0',
    )
  })
})

describe('buildEdgeCacheControl', () => {
  it('returns no-store for private scope (CDN must not cache)', () => {
    expect(buildEdgeCacheControl({ scope: 'private', maxAge: 60 })).toBe(
      'no-store',
    )
  })

  it('returns no-store for no-store scope', () => {
    expect(buildEdgeCacheControl({ scope: 'no-store', maxAge: 0 })).toBe(
      'no-store',
    )
  })

  it('uses s-maxage as the edge max-age, dropping browser max-age', () => {
    const edge = buildEdgeCacheControl({
      scope: 'public',
      maxAge: 0,
      sMaxAge: 60,
    })
    expect(edge).toBe('public, max-age=60')
  })

  it('drops must-revalidate (browser-only directive)', () => {
    const edge = buildEdgeCacheControl({
      scope: 'public',
      maxAge: 0,
      sMaxAge: 60,
      mustRevalidate: true,
    })
    expect(edge).not.toContain('must-revalidate')
  })

  it('keeps stale-while-revalidate and stale-if-error', () => {
    const edge = buildEdgeCacheControl({
      scope: 'public',
      maxAge: 0,
      sMaxAge: 60,
      staleWhileRevalidate: 300,
      staleIfError: 900,
    })
    expect(edge).toContain('stale-while-revalidate=300')
    expect(edge).toContain('stale-if-error=900')
  })
})

describe('applyCachePolicy', () => {
  it('stamps Cache-Control, CDN-Cache-Control, Surrogate-Control, Vary', () => {
    const rec = makeRecorder()
    applyCachePolicy(rec, 'storefront_html_swr')
    expect(rec.headers['Cache-Control']).toContain('must-revalidate')
    expect(rec.headers['CDN-Cache-Control']).toContain('max-age=60')
    expect(rec.headers['Surrogate-Control']).toBe(rec.headers['CDN-Cache-Control'])
    expect(rec.headers['Vary']).toBe('Accept-Language, Cookie')
  })

  it('does not set CDN headers when scope is no-store… wait, it SHOULD set them to no-store', () => {
    const rec = makeRecorder()
    applyCachePolicy(rec, 'no_store')
    expect(rec.headers['Cache-Control']).toBe('no-store')
    expect(rec.headers['CDN-Cache-Control']).toBe('no-store')
    expect(rec.headers['Surrogate-Control']).toBe('no-store')
  })

  it('private scope CDN header becomes no-store but browser header stays private', () => {
    const rec = makeRecorder()
    applyCachePolicy(rec, 'personalised_private')
    expect(rec.headers['Cache-Control']).toContain('private')
    expect(rec.headers['CDN-Cache-Control']).toBe('no-store')
    expect(rec.headers['Vary']).toBe('Cookie')
  })

  it('theme_asset_immutable emits the 1-year immutable policy', () => {
    const rec = makeRecorder()
    applyCachePolicy(rec, 'theme_asset_immutable')
    expect(rec.headers['Cache-Control']).toBe(
      'public, max-age=31536000, s-maxage=31536000, immutable',
    )
    expect(rec.headers['CDN-Cache-Control']).toContain('immutable')
  })

  it('api_short and api_long carry Vary: Accept-Language', () => {
    for (const name of ['api_short', 'api_long'] as const) {
      const rec = makeRecorder()
      applyCachePolicy(rec, name)
      expect(rec.headers['Vary']).toBe('Accept-Language')
    }
  })

  it('accepts a custom CachePolicy object directly', () => {
    const rec = makeRecorder()
    applyCachePolicy(rec, {
      scope: 'public',
      maxAge: 10,
      sMaxAge: 20,
      vary: ['Accept-Encoding'],
    })
    expect(rec.headers['Cache-Control']).toBe(
      'public, max-age=10, s-maxage=20',
    )
    expect(rec.headers['Vary']).toBe('Accept-Encoding')
  })

  it('omits Vary when the policy does not declare one', () => {
    const rec = makeRecorder()
    applyCachePolicy(rec, { scope: 'public', maxAge: 5 })
    expect(rec.headers['Vary']).toBeUndefined()
  })
})

describe('cacheHeaders middleware factory', () => {
  it('returns an Express-shaped middleware that applies the policy and calls next', () => {
    const rec = makeRecorder()
    let nextCalled = 0
    const mw = cacheHeaders('api_short')
    mw({}, rec, () => {
      nextCalled += 1
    })
    expect(nextCalled).toBe(1)
    expect(rec.headers['Cache-Control']).toContain('max-age=30')
  })
})

describe('preset sanity', () => {
  it('every preset round-trips through buildCacheControl without throwing', () => {
    for (const name of Object.keys(CACHE_PRESETS) as Array<
      keyof typeof CACHE_PRESETS
    >) {
      expect(() => buildCacheControl(CACHE_PRESETS[name])).not.toThrow()
    }
  })

  it('no preset accidentally uses a negative TTL', () => {
    for (const policy of Object.values(CACHE_PRESETS) as CachePolicy[]) {
      expect(policy.maxAge).toBeGreaterThanOrEqual(0)
      if (policy.sMaxAge !== undefined) {
        expect(policy.sMaxAge).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
