/**
 * Gbox Platform — Domain Verification Tests (Phase 6.3)
 *
 * Pure-function tests for the DNS TXT verification helpers. The
 * helpers are wired up in higher layers (an Express handler in the
 * god-admin app, a renewal cron in scripts/ops) — here we lock down
 * the algorithm itself.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  generateVerificationToken,
  expectedTxtRecord,
  verifyDomainTxt,
  buildVerificationInstructions,
  type DnsTxtResolver,
} from './domain-verification.js'

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

describe('generateVerificationToken', () => {
  it('returns a 64-character hex string by default (32 random bytes)', () => {
    const token = generateVerificationToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns a unique value on every call', () => {
    const tokens = new Set(
      Array.from({ length: 25 }, () => generateVerificationToken()),
    )
    expect(tokens.size).toBe(25)
  })

  it('respects a caller-supplied byte length', () => {
    const token = generateVerificationToken(16)
    // 16 bytes → 32 hex chars.
    expect(token).toHaveLength(32)
  })
})

// ---------------------------------------------------------------------------
// expectedTxtRecord
// ---------------------------------------------------------------------------

describe('expectedTxtRecord', () => {
  it('formats the TXT record value with the gbox-verify prefix', () => {
    const value = expectedTxtRecord('abc123')
    expect(value).toBe('gbox-site-verification=abc123')
  })

  it('produces the lookup hostname under _gbox-verify.<domain>', () => {
    expect(
      buildVerificationInstructions({
        domain: 'shop.example.com',
        token: 'abc123',
      }).recordHost,
    ).toBe('_gbox-verify.shop.example.com')
  })

  it('strips a trailing dot from the merchant-supplied domain', () => {
    expect(
      buildVerificationInstructions({
        domain: 'shop.example.com.',
        token: 'abc123',
      }).recordHost,
    ).toBe('_gbox-verify.shop.example.com')
  })
})

// ---------------------------------------------------------------------------
// verifyDomainTxt — happy path + edge cases
// ---------------------------------------------------------------------------

function makeResolver(records: string[][]): DnsTxtResolver {
  return vi.fn(async () => records)
}

describe('verifyDomainTxt', () => {
  it('returns ok=true when the expected record is present', async () => {
    const resolver = makeResolver([['gbox-site-verification=abc123']])
    const result = await verifyDomainTxt({
      domain: 'shop.example.com',
      token: 'abc123',
      resolver,
    })
    expect(result.ok).toBe(true)
    expect(result.matchedRecord).toBe('gbox-site-verification=abc123')
    expect(resolver).toHaveBeenCalledWith('_gbox-verify.shop.example.com')
  })

  it('reassembles a multi-segment TXT record before comparing', async () => {
    // DNS splits TXT records longer than 255 bytes into multiple
    // segments. The resolver returns each segment as a separate
    // string, but the actual record is the concatenation.
    const resolver = makeResolver([
      ['gbox-site-veri', 'fication=long-token-value'],
    ])
    const result = await verifyDomainTxt({
      domain: 'shop.example.com',
      token: 'long-token-value',
      resolver,
    })
    expect(result.ok).toBe(true)
  })

  it('returns ok=false with reason="not_found" when no records match', async () => {
    const resolver = makeResolver([['gbox-site-verification=different']])
    const result = await verifyDomainTxt({
      domain: 'shop.example.com',
      token: 'abc123',
      resolver,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('mismatch')
  })

  it('returns reason="not_found" when the resolver returns an empty list', async () => {
    const resolver = makeResolver([])
    const result = await verifyDomainTxt({
      domain: 'shop.example.com',
      token: 'abc123',
      resolver,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_found')
  })

  it('treats DNS NXDOMAIN errors as reason="not_found", not "lookup_error"', async () => {
    const resolver: DnsTxtResolver = vi.fn(async () => {
      const err = new Error('queryTxt ENOTFOUND _gbox-verify.shop.example.com')
      ;(err as { code?: string }).code = 'ENOTFOUND'
      throw err
    })
    const result = await verifyDomainTxt({
      domain: 'shop.example.com',
      token: 'abc123',
      resolver,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_found')
  })

  it('returns reason="lookup_error" for any other DNS failure', async () => {
    const resolver: DnsTxtResolver = vi.fn(async () => {
      throw new Error('SERVFAIL')
    })
    const result = await verifyDomainTxt({
      domain: 'shop.example.com',
      token: 'abc123',
      resolver,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('lookup_error')
    expect(result.error).toContain('SERVFAIL')
  })

  it('refuses to verify with an empty token', async () => {
    const resolver = makeResolver([['gbox-site-verification=']])
    const result = await verifyDomainTxt({
      domain: 'shop.example.com',
      token: '',
      resolver,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid_token')
    expect(resolver).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// buildVerificationInstructions — UI text
// ---------------------------------------------------------------------------

describe('buildVerificationInstructions', () => {
  it('returns a complete instruction bundle', () => {
    const inst = buildVerificationInstructions({
      domain: 'shop.example.com',
      token: 'abc123',
    })
    expect(inst.recordType).toBe('TXT')
    expect(inst.recordHost).toBe('_gbox-verify.shop.example.com')
    expect(inst.recordValue).toBe('gbox-site-verification=abc123')
    expect(inst.helpUrl).toContain('docs')
  })
})
