/**
 * Gbox Platform — A-Record Detection Tests (Phase 2B Sprint 3)
 *
 * Pure-function tests for the A-record-based domain verification
 * helper. Mirrors the style of `cloudflare-detect.test.ts` — no
 * real DNS, all resolvers stubbed.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  detectARecord,
  parsePlatformIpEnv,
  type DnsAResolver,
} from './a-record-detect.js'

// ---------------------------------------------------------------------------
// parsePlatformIpEnv
// ---------------------------------------------------------------------------

describe('parsePlatformIpEnv', () => {
  it('parses a single IP', () => {
    expect(parsePlatformIpEnv('14.224.236.129')).toEqual(['14.224.236.129'])
  })

  it('splits on commas and trims whitespace', () => {
    expect(parsePlatformIpEnv('14.224.236.129, 203.0.113.5 ,  1.2.3.4')).toEqual([
      '14.224.236.129',
      '203.0.113.5',
      '1.2.3.4',
    ])
  })

  it('lowercases and deduplicates', () => {
    // IPv4 doesn't really have case, but future IPv6 support benefits
    // from lowercasing; dedup guards against operator typos.
    expect(parsePlatformIpEnv('1.2.3.4,1.2.3.4,1.2.3.4')).toEqual(['1.2.3.4'])
  })

  it('returns an empty array for undefined / null / empty strings', () => {
    expect(parsePlatformIpEnv(undefined)).toEqual([])
    expect(parsePlatformIpEnv(null)).toEqual([])
    expect(parsePlatformIpEnv('')).toEqual([])
    expect(parsePlatformIpEnv('   ')).toEqual([])
    expect(parsePlatformIpEnv(',,,')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// detectARecord — happy paths
// ---------------------------------------------------------------------------

function makeAResolver(ips: string[]): DnsAResolver {
  return vi.fn(async () => ips)
}

describe('detectARecord', () => {
  it('marks matched=true when any observed IP is in platformIps', async () => {
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: makeAResolver(['14.224.236.129']),
      platformIps: ['14.224.236.129'],
    })
    expect(result.matched).toBe(true)
    expect(result.observedIps).toEqual(['14.224.236.129'])
    expect(result.platformIps).toEqual(['14.224.236.129'])
    expect(result.lookupError).toBeUndefined()
  })

  it('marks matched=true when observedIps contains a match alongside extras', async () => {
    // HA setups can advertise multiple A records; as long as one
    // matches our origin, we consider the domain pointed at us.
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: makeAResolver(['1.1.1.1', '14.224.236.129', '8.8.8.8']),
      platformIps: ['14.224.236.129'],
    })
    expect(result.matched).toBe(true)
    expect(result.observedIps).toHaveLength(3)
  })

  it('matches when platformIps has multiple entries and observed hits one', async () => {
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: makeAResolver(['203.0.113.5']),
      platformIps: ['14.224.236.129', '203.0.113.5'],
    })
    expect(result.matched).toBe(true)
  })

  it('strips a trailing dot and lowercases the input domain before resolving', async () => {
    const resolver = vi.fn(async () => ['14.224.236.129'])
    await detectARecord({
      domain: 'Mystore.COM.',
      aResolver: resolver,
      platformIps: ['14.224.236.129'],
    })
    expect(resolver).toHaveBeenCalledWith('mystore.com')
  })

  it('trims and lowercases observedIps for display', async () => {
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: makeAResolver(['  14.224.236.129 ', '1.2.3.4']),
      platformIps: ['14.224.236.129'],
    })
    expect(result.observedIps).toEqual(['14.224.236.129', '1.2.3.4'])
    expect(result.matched).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// detectARecord — negative paths
// ---------------------------------------------------------------------------

describe('detectARecord negative paths', () => {
  it('marks matched=false when no observed IP matches', async () => {
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: makeAResolver(['1.1.1.1', '8.8.8.8']),
      platformIps: ['14.224.236.129'],
    })
    expect(result.matched).toBe(false)
    expect(result.observedIps).toEqual(['1.1.1.1', '8.8.8.8'])
  })

  it('marks matched=false when the A lookup returns an empty set', async () => {
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: makeAResolver([]),
      platformIps: ['14.224.236.129'],
    })
    expect(result.matched).toBe(false)
    expect(result.observedIps).toEqual([])
  })

  it('marks matched=false when platformIps is empty (misconfigured env)', async () => {
    // Safety net: verify must never succeed when the env var hasn't
    // been wired up — that would be "verify against nothing".
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: makeAResolver(['14.224.236.129']),
      platformIps: [],
    })
    expect(result.matched).toBe(false)
  })

  it('ignores empty/whitespace entries in platformIps', async () => {
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: makeAResolver(['14.224.236.129']),
      platformIps: ['', '   ', '14.224.236.129'],
    })
    expect(result.matched).toBe(true)
    expect(result.platformIps).toEqual(['14.224.236.129'])
  })
})

// ---------------------------------------------------------------------------
// detectARecord — failure handling
// ---------------------------------------------------------------------------

describe('detectARecord failure handling', () => {
  it('does not throw when the resolver errors — populates lookupError', async () => {
    const failing: DnsAResolver = vi.fn(async () => {
      throw new Error('SERVFAIL')
    })
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: failing,
      platformIps: ['14.224.236.129'],
    })
    expect(result.matched).toBe(false)
    expect(result.observedIps).toEqual([])
    expect(result.lookupError).toContain('SERVFAIL')
  })

  it('treats ENOTFOUND (NXDOMAIN) the same as other errors', async () => {
    const nx: DnsAResolver = vi.fn(async () => {
      const err = new Error('queryA ENOTFOUND mystore.com')
      ;(err as { code?: string }).code = 'ENOTFOUND'
      throw err
    })
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: nx,
      platformIps: ['14.224.236.129'],
    })
    expect(result.matched).toBe(false)
    expect(result.lookupError).toContain('ENOTFOUND')
  })

  it('stringifies non-Error throws so the caller always gets a message', async () => {
    // Some resolver libraries throw strings instead of Error objects.
    // We still need the lookupError field populated.
    const weird: DnsAResolver = vi.fn(async () => {
      throw 'EAI_AGAIN'
    })
    const result = await detectARecord({
      domain: 'mystore.com',
      aResolver: weird,
      platformIps: ['14.224.236.129'],
    })
    expect(result.lookupError).toBe('EAI_AGAIN')
  })
})
