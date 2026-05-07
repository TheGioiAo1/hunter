/**
 * Unit tests for `canonicalDomainFromUrl` — the pure helper that
 * derives the canonical_domain column from a source URL.
 *
 * This helper is on the hot path for every Clone Pro start and
 * backstops the Phase 6 UNIQUE index from migration 045. Anything
 * that slips through here either blocks a legitimate second run or
 * lets a dupe land, so the rules locked in the 2026-04-17 spec are
 * exercised exhaustively:
 *
 *   1. Protocol gate — http/https only, everything else null.
 *   2. Hostname casing normalised to lowercase.
 *   3. Leading "www." stripped so www.X and X collide.
 *   4. Port, path, query, fragment ignored.
 *   5. Unparseable / empty / nullish inputs → null.
 *
 * These tests are pure Vitest — no DB, no network. Runs in the
 * shared unit suite.
 */

import { describe, it, expect } from 'vitest'
import { canonicalDomainFromUrl } from './canonical-domain.js'

describe('canonicalDomainFromUrl', () => {
  // --- Happy path --------------------------------------------------

  it('returns bare hostname for a plain https URL', () => {
    expect(canonicalDomainFromUrl('https://bibliobloom.com')).toBe(
      'bibliobloom.com',
    )
  })

  it('returns bare hostname for a plain http URL', () => {
    expect(canonicalDomainFromUrl('http://example.com')).toBe('example.com')
  })

  // --- Rule 3: www stripping --------------------------------------

  it('strips a single leading "www." prefix', () => {
    expect(canonicalDomainFromUrl('https://www.bibliobloom.com')).toBe(
      'bibliobloom.com',
    )
  })

  it('only strips the FIRST www. — deeper www. subdomains stay', () => {
    // A store that genuinely lives at `www.store.example.com` should
    // dedupe as `store.example.com`, but `www.www.example.com` is a
    // deliberate multi-www setup and we only peel one layer.
    expect(canonicalDomainFromUrl('https://www.www.example.com')).toBe(
      'www.example.com',
    )
  })

  it('leaves non-www subdomains alone', () => {
    expect(canonicalDomainFromUrl('https://shop.example.com')).toBe(
      'shop.example.com',
    )
  })

  // --- Rule 2: casing ---------------------------------------------

  it('lowercases the hostname', () => {
    expect(canonicalDomainFromUrl('https://BIBLIOBLOOM.COM')).toBe(
      'bibliobloom.com',
    )
  })

  it('lowercases mixed-case hostnames with www', () => {
    expect(canonicalDomainFromUrl('https://WWW.BiblioBloom.Com')).toBe(
      'bibliobloom.com',
    )
  })

  // --- Rule 4: port / path / query / fragment are noise ------------

  it('drops an explicit port', () => {
    expect(canonicalDomainFromUrl('https://bibliobloom.com:443')).toBe(
      'bibliobloom.com',
    )
  })

  it('drops a non-default port', () => {
    expect(canonicalDomainFromUrl('http://bibliobloom.com:8080')).toBe(
      'bibliobloom.com',
    )
  })

  it('drops the path', () => {
    expect(
      canonicalDomainFromUrl('https://bibliobloom.com/shop/products/tea'),
    ).toBe('bibliobloom.com')
  })

  it('drops query string', () => {
    expect(
      canonicalDomainFromUrl('https://bibliobloom.com/?utm_source=claude'),
    ).toBe('bibliobloom.com')
  })

  it('drops fragment', () => {
    expect(canonicalDomainFromUrl('https://bibliobloom.com/#/section')).toBe(
      'bibliobloom.com',
    )
  })

  it('drops userinfo', () => {
    expect(
      canonicalDomainFromUrl('https://user:pass@bibliobloom.com/admin'),
    ).toBe('bibliobloom.com')
  })

  // --- Rule 1: protocol gate --------------------------------------

  it('rejects javascript: URLs', () => {
    expect(canonicalDomainFromUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects ftp: URLs', () => {
    expect(canonicalDomainFromUrl('ftp://example.com')).toBeNull()
  })

  it('rejects data: URLs', () => {
    expect(canonicalDomainFromUrl('data:text/html,<h1>x</h1>')).toBeNull()
  })

  it('rejects file: URLs', () => {
    expect(canonicalDomainFromUrl('file:///etc/hosts')).toBeNull()
  })

  // --- Rule 5: empty / null / unparseable --------------------------

  it('returns null for null input', () => {
    expect(canonicalDomainFromUrl(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(canonicalDomainFromUrl(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(canonicalDomainFromUrl('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(canonicalDomainFromUrl('   ')).toBeNull()
  })

  it('returns null for unparseable garbage', () => {
    expect(canonicalDomainFromUrl('not a url')).toBeNull()
  })

  it('returns null for bare hostname without protocol', () => {
    // We intentionally require a scheme so operators don't accidentally
    // feed us HTML-escaped junk. The SQL regex in migration 041 is the
    // fallback backfill path; the hot path demands a parseable URL.
    expect(canonicalDomainFromUrl('bibliobloom.com')).toBeNull()
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(
      canonicalDomainFromUrl('   https://bibliobloom.com/   '),
    ).toBe('bibliobloom.com')
  })

  // --- Equivalence — the whole point of the helper -----------------

  it('normalises all Phase 6 spec examples to the same domain', () => {
    const canonical = 'bibliobloom.com'
    expect(canonicalDomainFromUrl('https://www.bibliobloom.com/shop')).toBe(
      canonical,
    )
    expect(canonicalDomainFromUrl('https://bibliobloom.com/')).toBe(canonical)
    expect(
      canonicalDomainFromUrl('https://BIBLIOBLOOM.com/products/tea'),
    ).toBe(canonical)
    expect(canonicalDomainFromUrl('https://bibliobloom.com:443')).toBe(
      canonical,
    )
  })

  // --- IPv6 / IPv4 literals ---------------------------------------

  it('preserves IPv4 literals as-is', () => {
    expect(canonicalDomainFromUrl('http://127.0.0.1:8080/admin')).toBe(
      '127.0.0.1',
    )
  })

  it('preserves IPv6 literals (brackets stripped by URL parser)', () => {
    // WHATWG URL strips the brackets around the hostname — that's
    // fine for our purposes; two different source URLs with the same
    // literal IP still collide on the same canonical key.
    const canonical = canonicalDomainFromUrl('http://[::1]:8080/admin')
    expect(canonical).toBe('[::1]')
  })
})
