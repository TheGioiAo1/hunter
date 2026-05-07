/**
 * domains.ts: sslStatusBadge unit tests.
 *
 * The badge is a thin presentational helper rendered into the
 * verified-domain status line. Cases:
 *   1. Cloudflare proxied + status='active' → "SSL · Cloudflare" green
 *   2. Origin cert + > 14 days → "SSL · 87 days" green
 *   3. Origin cert + ≤ 14 days → "SSL renews in Nd" amber
 *   4. status='pending' → "SSL issuing…" muted
 *   5. status='failed' → "SSL failed" red + tooltip from ssl_last_error
 *   6. status='expired' → "SSL expired" red
 *   7. Unknown / null status → empty string
 */

import { describe, it, expect } from 'vitest'

// Re-export the helper from the page handler for tests. The handler
// itself isn't easy to import without booting Express; we inline the
// helper here as a compile-time copy since it's tiny + pure.
//
// IMPORTANT: keep this helper in sync with the one in domains.ts. If
// you change one and not the other this test will pass while
// production renders the wrong copy. The contract above is the
// shared spec.

import { sslStatusBadge as sslStatusBadgeImpl } from './domains-ssl-badge-helper.js'

describe('sslStatusBadge', () => {
  it('Cloudflare proxied + active → green CF pill', () => {
    const out = sslStatusBadgeImpl({
      ssl_status: 'active',
      cloudflare_proxied: true,
    })
    expect(out).toContain('SSL · Cloudflare')
    expect(out).toContain('rgba(34,197,94,.15)') // green bg
  })

  it('Origin cert with > 14 days → green pill with day count', () => {
    const future = new Date(Date.now() + 87 * 24 * 60 * 60 * 1000)
    const out = sslStatusBadgeImpl({
      ssl_status: 'active',
      ssl_expires_at: future.toISOString(),
      cloudflare_proxied: false,
    })
    expect(out).toContain('SSL · 87 days')
    expect(out).toContain('rgba(34,197,94,.15)')
  })

  it('Origin cert with ≤ 14 days → amber renewal warning', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
    const out = sslStatusBadgeImpl({
      ssl_status: 'active',
      ssl_expires_at: future.toISOString(),
      cloudflare_proxied: false,
    })
    expect(out).toContain('SSL renews in 5d')
    expect(out).toContain('rgba(234,179,8,.15)') // amber bg
  })

  it('pending → muted Issuing pill', () => {
    const out = sslStatusBadgeImpl({ ssl_status: 'pending' })
    expect(out).toContain('SSL issuing')
  })

  it('failed → red pill with truncated tooltip', () => {
    const out = sslStatusBadgeImpl({
      ssl_status: 'failed',
      ssl_last_error: 'lego: order failed: rate limited by Let\'s Encrypt API',
    })
    expect(out).toContain('SSL failed')
    expect(out).toContain('rgba(239,68,68,.15)')
    expect(out).toContain('title="lego: order failed: rate limited by Let')
  })

  it('expired → red pill', () => {
    const out = sslStatusBadgeImpl({ ssl_status: 'expired' })
    expect(out).toContain('SSL expired')
  })

  it('unknown status → empty string (no confusing badge)', () => {
    expect(sslStatusBadgeImpl({})).toBe('')
    expect(sslStatusBadgeImpl({ ssl_status: null })).toBe('')
    expect(sslStatusBadgeImpl({ ssl_status: 'wat' })).toBe('')
  })

  it('active without cert info and without CF proxied → empty (defensive)', () => {
    // Edge case: row claims active=true but the cert metadata is
    // missing AND CF isn't on. The badge stays quiet rather than
    // rendering a fake "active" pill that misleads the seller.
    const out = sslStatusBadgeImpl({
      ssl_status: 'active',
      cloudflare_proxied: false,
      ssl_expires_at: null,
    })
    expect(out).toBe('')
  })
})
