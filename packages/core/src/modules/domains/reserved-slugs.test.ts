/**
 * Reserved shop slugs — unit tests (Phase 20 P0).
 *
 * These tests lock in the list of slugs that MUST NOT be accepted by
 * `create-store`. Regressions here are security-adjacent — a bad diff
 * that removes "admin" from the list would let a seller register a
 * shop whose default subdomain collides with admin.gbox.co.
 */

import { describe, expect, it } from 'vitest'
import {
  RESERVED_SLUGS,
  isReservedSlug,
  RESERVED_SLUG_MESSAGE,
} from './reserved-slugs.js'

describe('RESERVED_SLUGS — platform subdomains', () => {
  // Every nginx server_name on gbox.co as of 2026-04-25. Verified
  // against /etc/nginx/sites-enabled/gbox on server 1.
  const PLATFORM_SUBDOMAINS = [
    'accounts',
    'admin',
    'api',
    'cdn',
    'checkout',
    'god',
    'god-admin',
    'supporter',
    'www',
  ] as const

  for (const slug of PLATFORM_SUBDOMAINS) {
    it(`"${slug}" is reserved (would collide with ${slug}.gbox.co)`, () => {
      expect(isReservedSlug(slug)).toBe(true)
      expect(RESERVED_SLUGS.has(slug)).toBe(true)
    })
  }
})

describe('RESERVED_SLUGS — common infra + brand terms', () => {
  for (const slug of [
    'mail',
    'smtp',
    'ns',
    'ns1',
    'dns',
    'mx',
    'staging',
    'dev',
    'test',
    'preview',
    'sandbox',
    'gbox',
    'gbox-platform',
    'help',
    'support',
    'docs',
    'status',
    'login',
    'signup',
    'billing',
    'settings',
  ]) {
    it(`"${slug}" is reserved`, () => {
      expect(isReservedSlug(slug)).toBe(true)
    })
  }
})

describe('isReservedSlug — case-insensitive + defense in depth', () => {
  it('upper-case input still hits the reserved list', () => {
    expect(isReservedSlug('ADMIN')).toBe(true)
    expect(isReservedSlug('Admin')).toBe(true)
    expect(isReservedSlug('aDmIn')).toBe(true)
  })

  it('returns false for non-string input (defensive, not callable with bad types in TS)', () => {
    expect(isReservedSlug(undefined as any)).toBe(false)
    expect(isReservedSlug(null as any)).toBe(false)
    expect(isReservedSlug(123 as any)).toBe(false)
  })

  it('returns false for legitimate seller slugs that contain a reserved substring', () => {
    // "admin-co" contains "admin" but is NOT the reserved slug itself.
    expect(isReservedSlug('admin-co')).toBe(false)
    expect(isReservedSlug('my-admin')).toBe(false)
    expect(isReservedSlug('supporting-cast')).toBe(false)
    expect(isReservedSlug('api-guide')).toBe(false)
  })

  it('returns false for the empty string and whitespace', () => {
    expect(isReservedSlug('')).toBe(false)
    // Callers must trim before calling — this helper is strict.
    expect(isReservedSlug(' admin ')).toBe(false)
  })

  it('returns false for typical seller slugs', () => {
    expect(isReservedSlug('best-store')).toBe(false)
    expect(isReservedSlug('lifeasy')).toBe(false)
    expect(isReservedSlug('my-awesome-shop')).toBe(false)
    expect(isReservedSlug('a1b2c3')).toBe(false)
  })
})

describe('RESERVED_SLUG_MESSAGE — Iron Rule 5 audit', () => {
  it('never names the colliding platform slot (no /admin, /god-admin, etc. leak)', () => {
    expect(RESERVED_SLUG_MESSAGE).not.toMatch(/admin|god|checkout|accounts|api|supporter|cdn/i)
  })

  it('is a short seller-safe phrase', () => {
    // Keep UX copy short; matches the "please choose another" voice
    // used elsewhere in the signup flow.
    expect(RESERVED_SLUG_MESSAGE.length).toBeLessThan(120)
    expect(RESERVED_SLUG_MESSAGE.toLowerCase()).toContain(
      "isn't available",
    )
  })
})
