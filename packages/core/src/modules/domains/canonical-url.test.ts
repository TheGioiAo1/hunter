/**
 * canonical-url unit tests.
 *
 * Cases for resolveCanonicalUrlSync (pure):
 *   1. No primary_domain_id → platform subdomain
 *   2. primary_domain_id set + row verified → primary domain
 *   3. primary_domain_id set + row NOT verified → platform fallback
 *   4. primary_domain_id set + row missing → platform fallback
 *   5. Custom platform suffix override
 *
 * Cases for resolveCanonicalUrl (DB):
 *   6. Happy path — shop + verified primary
 *   7. Shop has no primary → only one query, platform fallback
 *   8. Shop missing → empty result
 *   9. DB throws on shop read → fallback path attempts slug-only read
 */

import { describe, it, expect } from 'vitest'
import { resolveCanonicalUrlSync, resolveCanonicalUrl } from './canonical-url.js'

describe('resolveCanonicalUrlSync', () => {
  it('no primary_domain_id → platform subdomain', () => {
    const r = resolveCanonicalUrlSync(
      { slug: 'best-store', primary_domain_id: null },
      null,
    )
    expect(r.hostname).toBe('best-store.gbox.co')
    expect(r.origin).toBe('https://best-store.gbox.co')
    expect(r.source).toBe('platform_subdomain')
  })

  it('verified primary domain → primary domain', () => {
    const r = resolveCanonicalUrlSync(
      { slug: 'best-store', primary_domain_id: 'd1' },
      { domain: 'tw3.store', verified: true },
    )
    expect(r.hostname).toBe('tw3.store')
    expect(r.origin).toBe('https://tw3.store')
    expect(r.source).toBe('primary_domain')
  })

  it('unverified primary domain → falls back to platform subdomain', () => {
    const r = resolveCanonicalUrlSync(
      { slug: 'best-store', primary_domain_id: 'd1' },
      { domain: 'tw3.store', verified: false },
    )
    expect(r.hostname).toBe('best-store.gbox.co')
    expect(r.source).toBe('platform_subdomain')
  })

  it('missing primary domain row → falls back', () => {
    const r = resolveCanonicalUrlSync(
      { slug: 'best-store', primary_domain_id: 'd1' },
      null,
    )
    expect(r.hostname).toBe('best-store.gbox.co')
    expect(r.source).toBe('platform_subdomain')
  })

  it('respects platformDomainSuffix override', () => {
    const r = resolveCanonicalUrlSync(
      { slug: 'best-store', primary_domain_id: null },
      null,
      { platformDomainSuffix: '.staging.example' },
    )
    expect(r.hostname).toBe('best-store.staging.example')
  })
})

describe('resolveCanonicalUrl (DB)', () => {
  function mockDb(opts: {
    shop?: { slug: string; primary_domain_id: string | null } | undefined
    domain?: { domain: string; verified: boolean } | undefined
    failOn?: 'shops' | 'shop_domains' | null
  }) {
    return {
      selectFrom(table: string) {
        if (opts.failOn === table) {
          throw new Error(`db error reading ${table}`)
        }
        return {
          select() {
            return this
          },
          where() {
            return this
          },
          async executeTakeFirst() {
            if (table === 'shops') return opts.shop
            if (table === 'shop_domains') return opts.domain
            return undefined
          },
        }
      },
    } as any
  }

  it('happy path with verified primary', async () => {
    const db = mockDb({
      shop: { slug: 'best-store', primary_domain_id: 'd1' },
      domain: { domain: 'tw3.store', verified: true },
    })
    const r = await resolveCanonicalUrl(db, 'shop-1')
    expect(r.hostname).toBe('tw3.store')
    expect(r.source).toBe('primary_domain')
  })

  it('shop with no primary → platform fallback (no shop_domains read)', async () => {
    const db = mockDb({
      shop: { slug: 'best-store', primary_domain_id: null },
    })
    const r = await resolveCanonicalUrl(db, 'shop-1')
    expect(r.hostname).toBe('best-store.gbox.co')
  })

  it('missing shop → empty result, never throws', async () => {
    const db = mockDb({ shop: undefined })
    const r = await resolveCanonicalUrl(db, 'shop-missing')
    expect(r.hostname).toBe('')
    expect(r.source).toBe('platform_subdomain')
  })

  it('DB throws on initial read → caller still gets a value', async () => {
    let calls = 0
    const db = {
      selectFrom() {
        calls += 1
        if (calls === 1) {
          throw new Error('first read failed')
        }
        // Recovery read returns the slug.
        return {
          select() {
            return this
          },
          where() {
            return this
          },
          async executeTakeFirst() {
            return { slug: 'best-store' }
          },
        }
      },
    } as any
    const r = await resolveCanonicalUrl(db, 'shop-1')
    expect(r.hostname).toBe('best-store.gbox.co')
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
