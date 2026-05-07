/**
 * Gbox Platform — Cloudflare Detection Tests (Phase 2B Sprint 2)
 *
 * Pure-function tests for the NS-based Cloudflare detection helper.
 * The helper is wired into the domain service in the store-admin app
 * (routes in server.ts, UI in pages/domains.ts) — these tests lock
 * down the detection rules + failure modes without needing real DNS.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  detectCloudflare,
  isCloudflareNameserver,
  resolveNsWithApexWalk,
  type DnsNsResolver,
  type DnsCnameResolver,
  type DnsAResolver,
} from './cloudflare-detect.js'

// ---------------------------------------------------------------------------
// isCloudflareNameserver
// ---------------------------------------------------------------------------

describe('isCloudflareNameserver', () => {
  it('returns true for the standard Cloudflare pattern', () => {
    expect(isCloudflareNameserver('dara.ns.cloudflare.com')).toBe(true)
    expect(isCloudflareNameserver('igor.ns.cloudflare.com')).toBe(true)
  })

  it('strips a trailing dot before matching', () => {
    // Some resolvers return FQDNs with a trailing dot — we shouldn't
    // treat `foo.ns.cloudflare.com.` as a mismatch.
    expect(isCloudflareNameserver('dara.ns.cloudflare.com.')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isCloudflareNameserver('DARA.NS.CLOUDFLARE.COM')).toBe(true)
  })

  it('returns false for non-Cloudflare nameservers', () => {
    expect(isCloudflareNameserver('ns1.google.com')).toBe(false)
    expect(isCloudflareNameserver('ns-1234.awsdns-56.org')).toBe(false)
  })

  it('does not match lookalike domains', () => {
    // Belt-and-suspenders: a suffix match on `.ns.cloudflare.com`
    // must not be fooled by something like
    // `evil.ns.cloudflare.com.attacker.tld`.
    expect(isCloudflareNameserver('evil.ns.cloudflare.com.attacker.tld')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// detectCloudflare — happy paths
// ---------------------------------------------------------------------------

function makeNsResolver(result: string[]): DnsNsResolver {
  return vi.fn(async () => result)
}

function makeCnameResolver(result: string[]): DnsCnameResolver {
  return vi.fn(async () => result)
}

function makeAResolver(result: string[]): DnsAResolver {
  return vi.fn(async () => result)
}

describe('detectCloudflare', () => {
  it('marks cloudflareProxied=true when every NS matches the pattern', async () => {
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver([
        'dara.ns.cloudflare.com',
        'igor.ns.cloudflare.com',
      ]),
    })
    expect(result.cloudflareProxied).toBe(true)
    expect(result.nameservers).toEqual([
      'dara.ns.cloudflare.com',
      'igor.ns.cloudflare.com',
    ])
    expect(result.lookupError).toBeUndefined()
  })

  it('normalizes nameservers to lowercase + no trailing dot + sorted', async () => {
    // Resolvers sometimes return FQDNs with trailing dots and
    // inconsistent casing. The UI pill renders the list directly, so
    // consistency matters.
    const result = await detectCloudflare({
      domain: 'Shop.Example.com',
      nsResolver: makeNsResolver([
        'IGOR.ns.cloudflare.com.',
        'dara.NS.CLOUDFLARE.com',
      ]),
    })
    expect(result.nameservers).toEqual([
      'dara.ns.cloudflare.com',
      'igor.ns.cloudflare.com',
    ])
  })

  it('deduplicates nameservers returned as duplicates by the resolver', async () => {
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver([
        'dara.ns.cloudflare.com',
        'dara.ns.cloudflare.com.',
        'igor.ns.cloudflare.com',
      ]),
    })
    expect(result.nameservers).toHaveLength(2)
  })

  it('returns cloudflareProxied=false when NS list is a mix of Cloudflare + other', async () => {
    // Partial migration — seller changed one NS but not the other.
    // Not good enough: Cloudflare only terminates SSL when all NS
    // are theirs.
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver([
        'dara.ns.cloudflare.com',
        'ns1.registrar.com',
      ]),
    })
    expect(result.cloudflareProxied).toBe(false)
    expect(result.nameservers).toHaveLength(2)
  })

  it('returns cloudflareProxied=false when NS is empty', async () => {
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver([]),
    })
    expect(result.cloudflareProxied).toBe(false)
    expect(result.nameservers).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// detectCloudflare — failure handling
// ---------------------------------------------------------------------------

describe('detectCloudflare failure modes', () => {
  it('does not throw when the NS resolver errors — populates lookupError', async () => {
    const failingResolver: DnsNsResolver = vi.fn(async () => {
      throw new Error('SERVFAIL')
    })
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: failingResolver,
    })
    expect(result.cloudflareProxied).toBe(false)
    expect(result.nameservers).toEqual([])
    expect(result.lookupError).toContain('SERVFAIL')
  })

  it('treats NXDOMAIN identically to other errors (caller branches on lookupError)', async () => {
    const nxResolver: DnsNsResolver = vi.fn(async () => {
      const err = new Error('queryNs ENOTFOUND shop.example.com')
      ;(err as { code?: string }).code = 'ENOTFOUND'
      throw err
    })
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: nxResolver,
    })
    expect(result.cloudflareProxied).toBe(false)
    expect(result.lookupError).toContain('ENOTFOUND')
  })
})

// ---------------------------------------------------------------------------
// detectCloudflare — DNS target probe
// ---------------------------------------------------------------------------

describe('detectCloudflare DNS target probe', () => {
  it('returns the CNAME target when cnameResolver yields one', async () => {
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver([
        'dara.ns.cloudflare.com',
        'igor.ns.cloudflare.com',
      ]),
      cnameResolver: makeCnameResolver(['shops.gbox.co.']),
    })
    expect(result.dnsTarget).toBe('shops.gbox.co')
  })

  it('falls back to A records when CNAME is empty', async () => {
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver(['dara.ns.cloudflare.com']),
      cnameResolver: makeCnameResolver([]),
      aResolver: makeAResolver(['104.21.10.20', '172.67.99.8']),
    })
    // A records get joined so the UI can show a single line.
    expect(result.dnsTarget).toBe('104.21.10.20,172.67.99.8')
  })

  it('falls back to A records when CNAME resolver throws', async () => {
    const throwingCname: DnsCnameResolver = vi.fn(async () => {
      throw new Error('ENODATA')
    })
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver(['dara.ns.cloudflare.com']),
      cnameResolver: throwingCname,
      aResolver: makeAResolver(['1.2.3.4']),
    })
    expect(result.dnsTarget).toBe('1.2.3.4')
  })

  it('returns dnsTarget=null when neither resolver is provided', async () => {
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver(['dara.ns.cloudflare.com']),
    })
    expect(result.dnsTarget).toBeNull()
  })

  it('returns dnsTarget=null when both resolvers throw', async () => {
    const throwing = async () => {
      throw new Error('ENODATA')
    }
    const result = await detectCloudflare({
      domain: 'shop.example.com',
      nsResolver: makeNsResolver(['dara.ns.cloudflare.com']),
      cnameResolver: throwing,
      aResolver: throwing,
    })
    expect(result.dnsTarget).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveNsWithApexWalk — zone-apex discovery
// ---------------------------------------------------------------------------

describe('resolveNsWithApexWalk', () => {
  it('returns NS directly when the input host is the apex', async () => {
    const resolver = vi.fn(async (host: string) => {
      if (host === 'mystore.com') {
        return ['dara.ns.cloudflare.com', 'igor.ns.cloudflare.com']
      }
      return []
    })
    const result = await resolveNsWithApexWalk('mystore.com', resolver)
    expect(result.apex).toBe('mystore.com')
    expect(result.nameservers).toEqual([
      'dara.ns.cloudflare.com',
      'igor.ns.cloudflare.com',
    ])
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('walks up one label when the subdomain has no NS', async () => {
    // Most real-world setups: seller enters `www.mystore.com` but
    // only the apex has NS records. The walker must climb one
    // level and retry to get the Cloudflare pair.
    const resolver = vi.fn(async (host: string) => {
      if (host === 'www.mystore.com') return []
      if (host === 'mystore.com') {
        return ['dara.ns.cloudflare.com', 'igor.ns.cloudflare.com']
      }
      return []
    })
    const result = await resolveNsWithApexWalk('www.mystore.com', resolver)
    expect(result.apex).toBe('mystore.com')
    expect(result.nameservers).toEqual([
      'dara.ns.cloudflare.com',
      'igor.ns.cloudflare.com',
    ])
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('walks up multiple labels when the domain is deeply nested', async () => {
    const resolver = vi.fn(async (host: string) => {
      if (host === 'mystore.com') return ['dara.ns.cloudflare.com']
      return []
    })
    const result = await resolveNsWithApexWalk(
      'deeply.nested.shop.mystore.com',
      resolver,
    )
    expect(result.apex).toBe('mystore.com')
    expect(result.nameservers).toEqual(['dara.ns.cloudflare.com'])
    expect(resolver).toHaveBeenCalledTimes(4)
  })

  it('keeps climbing past resolver errors until an ancestor answers', async () => {
    // Some resolvers throw NXDOMAIN for subdomains that don't exist
    // but return successfully for the parent zone. The walker must
    // catch the throw and continue up instead of giving up.
    const resolver = vi.fn(async (host: string) => {
      if (host === 'www.mystore.com') {
        throw new Error('queryNs ENOTFOUND www.mystore.com')
      }
      if (host === 'mystore.com') return ['dara.ns.cloudflare.com']
      return []
    })
    const result = await resolveNsWithApexWalk('www.mystore.com', resolver)
    expect(result.apex).toBe('mystore.com')
    expect(result.nameservers).toEqual(['dara.ns.cloudflare.com'])
  })

  it('stops before the TLD — never queries a single-label host', async () => {
    // If every ancestor returned empty/error, we must not query
    // `com` (would hit the root servers). The walker stops once
    // the candidate shrinks to < 2 labels.
    const resolver = vi.fn(async () => [])
    const result = await resolveNsWithApexWalk(
      'foo.bar.baz.com',
      resolver,
    )
    expect(result.apex).toBeNull()
    expect(result.nameservers).toEqual([])
    // Four attempts: foo.bar.baz.com, bar.baz.com, baz.com — then
    // the walker refuses to query just `com`.
    expect(resolver).toHaveBeenCalledTimes(3)
    for (const call of resolver.mock.calls) {
      expect(call[0]).not.toBe('com')
    }
  })

  it('returns the last error when every candidate throws', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('SERVFAIL')
    })
    const result = await resolveNsWithApexWalk('www.mystore.com', resolver)
    expect(result.apex).toBeNull()
    expect(result.nameservers).toEqual([])
    expect(result.lookupError).toContain('SERVFAIL')
  })

  it('refuses to walk when the input has fewer than 2 labels', async () => {
    const resolver = vi.fn(async () => ['ignored.ns.cloudflare.com'])
    const result = await resolveNsWithApexWalk('localhost', resolver)
    expect(result.apex).toBeNull()
    expect(result.nameservers).toEqual([])
    expect(resolver).not.toHaveBeenCalled()
  })

  it('normalizes + dedupes + sorts nameservers at the found apex', async () => {
    // Matches the invariants the UI depends on — same as the
    // original detectCloudflare test for consistency.
    const resolver = vi.fn(async (host: string) => {
      if (host === 'mystore.com') {
        return [
          'IGOR.ns.cloudflare.com.',
          'dara.NS.CLOUDFLARE.com',
          'igor.ns.cloudflare.com',
        ]
      }
      return []
    })
    const result = await resolveNsWithApexWalk('www.mystore.com', resolver)
    expect(result.nameservers).toEqual([
      'dara.ns.cloudflare.com',
      'igor.ns.cloudflare.com',
    ])
  })
})

// ---------------------------------------------------------------------------
// detectCloudflare — zone-apex walk integration
// ---------------------------------------------------------------------------

describe('detectCloudflare zone-apex walk integration', () => {
  it('treats a subdomain as cloudflareProxied when the apex is on Cloudflare', async () => {
    // Fix for the "seller enters www.mystore.com but NS live at
    // mystore.com" bug the pre-walk code shipped with.
    const result = await detectCloudflare({
      domain: 'www.mystore.com',
      nsResolver: async (host: string) => {
        if (host === 'mystore.com') {
          return ['dara.ns.cloudflare.com', 'igor.ns.cloudflare.com']
        }
        return []
      },
    })
    expect(result.cloudflareProxied).toBe(true)
    expect(result.nameservers).toEqual([
      'dara.ns.cloudflare.com',
      'igor.ns.cloudflare.com',
    ])
  })

  it('populates lookupError when every ancestor lookup fails', async () => {
    const result = await detectCloudflare({
      domain: 'www.mystore.com',
      nsResolver: async () => {
        throw new Error('SERVFAIL')
      },
    })
    expect(result.cloudflareProxied).toBe(false)
    expect(result.nameservers).toEqual([])
    expect(result.lookupError).toContain('SERVFAIL')
  })
})
