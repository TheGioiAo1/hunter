/**
 * Design Library — clone slug derivation tests (Phase D2).
 *
 * Locks the shape and determinism of `deriveCloneSlug`:
 *
 *   - `<hostname>-<8-hex>` shape, no upper-case, no unicode.
 *   - Deterministic on `(url, jobId)` — retry of the emit hook with the
 *     same jobId produces the same slug (important for idempotent
 *     recovery from a transient DB error that aborted the first insert).
 *   - Unique-enough without jobId — two back-to-back calls with no
 *     jobId produce different slugs (crypto randomness).
 */

import { describe, expect, it } from 'vitest'
import { deriveCloneSlug, sanitizeHostname } from './clone-slug.js'

describe('deriveCloneSlug', () => {
  it('shape: lowercase hostname + 8-hex suffix joined by "-"', () => {
    const slug = deriveCloneSlug(
      'https://www.airbnb.com/',
      '6df3a4b1-c290-4f22-a0ce-deadbeef1234',
    )
    expect(slug).toBe('airbnb-com-6df3a4b1')
  })

  it('deterministic on (url, jobId) — two calls yield the same slug', () => {
    const a = deriveCloneSlug(
      'https://stripe.com',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    )
    const b = deriveCloneSlug(
      'https://stripe.com',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    )
    expect(a).toBe(b)
    expect(a).toBe('stripe-com-aaaaaaaa')
  })

  it('different jobIds on the same URL produce different slugs', () => {
    const a = deriveCloneSlug('https://clay.com', '11111111-2222-3333-4444-555555555555')
    const b = deriveCloneSlug('https://clay.com', '66666666-7777-8888-9999-000000000000')
    expect(a).not.toBe(b)
    expect(a).toBe('clay-com-11111111')
    expect(b).toBe('clay-com-66666666')
  })

  it('strips the "www." prefix before sanitizing', () => {
    // Matches `/^www\./` so `airbnb` and `www.airbnb` produce the same
    // hostname base — avoids two flavours of the same clone diverging.
    const slug = deriveCloneSlug('https://www.airbnb.com', 'abcdef0123456789abcdef0123456789')
    expect(slug).toBe('airbnb-com-abcdef01')
  })

  it('collapses non-alphanumeric hostname bytes into single hyphens', () => {
    // Subdomains + dots + hyphens all become one hyphen, no doubles.
    const slug = deriveCloneSlug('https://shop--v2.example.co.uk/', '1234567890abcdef')
    expect(slug).toBe('shop-v2-example-co-uk-12345678')
  })

  it('falls back to the manual hostname parse when URL() rejects', () => {
    // Missing protocol — `new URL()` throws and the catch path strips
    // the path/query manually. Result stays a valid slug.
    const slug = deriveCloneSlug('www.clay.com/pricing?ref=hn', 'abcd1234efab5678')
    expect(slug).toBe('clay-com-abcd1234')
  })

  it('lowercases host bytes that came from a mixed-case URL', () => {
    const slug = deriveCloneSlug('https://WWW.Airbnb.COM/', 'deadbeef12345678')
    expect(slug).toBe('airbnb-com-deadbeef')
  })

  it('lowercases hex bytes that came from a mixed-case jobId', () => {
    const slug = deriveCloneSlug('https://clay.com', 'ABCDEF01-2345-6789-abcd-ef0123456789')
    expect(slug).toBe('clay-com-abcdef01')
  })

  it('caps the hostname portion at 64 chars so URLs stay readable', () => {
    // 100-char subdomain — the cap kicks in at 64 so the slug total is
    // 64 + 1 + 8 = 73 chars.
    const longHost = 'a'.repeat(100) + '.example.com'
    const slug = deriveCloneSlug(`https://${longHost}`, 'abcd1234abcd1234')
    const hostPart = slug.slice(0, slug.length - 9) // strip "-" + 8 hex
    expect(hostPart.length).toBeLessThanOrEqual(64)
    expect(slug.endsWith('-abcd1234')).toBe(true)
  })

  it('falls back to "clone" when sourceUrl is empty', () => {
    // Empty URL is a belt-and-braces case — caller's validator should
    // reject it before we're called. Produce a usable slug regardless.
    const slug = deriveCloneSlug('', '1234567890abcdef')
    expect(slug).toBe('clone-12345678')
  })

  it('generates a random suffix when jobId is omitted', () => {
    // Dev/test harness path. Two calls yield different suffixes so the
    // partial unique index on (shop_id, slug) won't collide.
    const a = deriveCloneSlug('https://example.com')
    const b = deriveCloneSlug('https://example.com')
    expect(a).not.toBe(b)
    expect(a.startsWith('example-com-')).toBe(true)
    // 8 lowercase hex chars after the last "-".
    expect(a).toMatch(/^example-com-[0-9a-f]{8}$/)
  })

  it('generates a random suffix when jobId sanitizes to empty', () => {
    // A caller passing e.g. "???" would have nothing URL-safe left.
    // We fall through to the random branch rather than emitting a
    // slug with a trailing "-" and nothing after it.
    const slug = deriveCloneSlug('https://example.com', '???')
    expect(slug).toMatch(/^example-com-[0-9a-f]{8}$/)
  })

  it('pads a short-but-valid jobId with random hex to reach 8 chars', () => {
    // A caller passing a 3-char jobId shouldn't produce a short suffix —
    // the partial unique index would collide on retry. We keep the
    // first chars stable (deterministic prefix) and pad the rest.
    const slug = deriveCloneSlug('https://example.com', 'abc')
    expect(slug.startsWith('example-com-abc')).toBe(true)
    expect(slug).toMatch(/^example-com-abc[0-9a-f]{5}$/)
  })

  it('output is URL-safe — only [a-z0-9-] characters', () => {
    const slug = deriveCloneSlug(
      'https://Weird.Site-Name_2.example.co.uk/some-path',
      '00-11-22-33-44-55',
    )
    expect(slug).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('sanitizeHostname (internal helper)', () => {
  it('strips "www.", lowercases, and hyphenates non-alnum', () => {
    expect(sanitizeHostname('https://www.Example.Co.UK/')).toBe('example-co-uk')
  })

  it('returns an empty string for an empty URL', () => {
    expect(sanitizeHostname('')).toBe('')
  })

  it('handles malformed URLs without throwing', () => {
    expect(sanitizeHostname('not a url')).toBe('not-a-url')
  })

  it('strips path + query from manual-parse fallback', () => {
    // `foo.bar/baz?x=1` has no protocol so URL() rejects — fallback
    // strips path + query before sanitizing.
    expect(sanitizeHostname('foo.bar/baz?x=1')).toBe('foo-bar')
  })
})
