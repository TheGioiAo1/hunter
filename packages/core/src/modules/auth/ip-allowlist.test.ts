/**
 * Tests for the CIDR matcher used by the admin IP allowlist
 * (Phase 0 §8 Item #4). Pure functions, no DB.
 */

import { describe, it, expect } from 'vitest'
import {
  parseCidr,
  parseCidrList,
  ipInCidr,
  ipInAllowlist,
  normaliseRequestIp,
  InvalidCidrError,
} from './ip-allowlist.js'

describe('parseCidr', () => {
  it('parses IPv4 CIDR', () => {
    const p = parseCidr('10.0.0.0/8')
    expect(p.family).toBe('v4')
    expect(p.prefix).toBe(8)
    expect(p.width).toBe(32)
  })

  it('parses bare IPv4 as /32', () => {
    const p = parseCidr('1.2.3.4')
    expect(p.prefix).toBe(32)
  })

  it('parses IPv6 CIDR', () => {
    const p = parseCidr('2001:db8::/32')
    expect(p.family).toBe('v6')
    expect(p.prefix).toBe(32)
    expect(p.width).toBe(128)
  })

  it('parses bare IPv6 as /128', () => {
    const p = parseCidr('::1')
    expect(p.prefix).toBe(128)
  })

  it('rejects garbage', () => {
    expect(() => parseCidr('not-an-ip')).toThrow(InvalidCidrError)
  })

  it('rejects out-of-range prefix', () => {
    expect(() => parseCidr('1.2.3.4/33')).toThrow(InvalidCidrError)
    expect(() => parseCidr('::1/129')).toThrow(InvalidCidrError)
  })

  it('rejects empty string', () => {
    expect(() => parseCidr('')).toThrow(InvalidCidrError)
  })
})

describe('parseCidrList', () => {
  it('collects valid and invalid separately', () => {
    const out = parseCidrList(['10.0.0.0/8', 'garbage', '192.168.1.1', ''])
    expect(out.valid).toHaveLength(2)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].raw).toBe('garbage')
  })
})

describe('ipInCidr — IPv4', () => {
  const c = parseCidr('10.0.0.0/8')

  it('matches first address in range', () => {
    expect(ipInCidr('10.0.0.0', c)).toBe(true)
  })

  it('matches middle address', () => {
    expect(ipInCidr('10.12.34.56', c)).toBe(true)
  })

  it('matches last address in range', () => {
    expect(ipInCidr('10.255.255.255', c)).toBe(true)
  })

  it('rejects address outside range', () => {
    expect(ipInCidr('11.0.0.0', c)).toBe(false)
    expect(ipInCidr('9.255.255.255', c)).toBe(false)
  })

  it('rejects IPv6 against IPv4 CIDR', () => {
    expect(ipInCidr('::1', c)).toBe(false)
  })

  it('matches /32 single host', () => {
    const host = parseCidr('1.2.3.4')
    expect(ipInCidr('1.2.3.4', host)).toBe(true)
    expect(ipInCidr('1.2.3.5', host)).toBe(false)
  })

  it('matches /0 everything', () => {
    const any = parseCidr('0.0.0.0/0')
    expect(ipInCidr('1.2.3.4', any)).toBe(true)
    expect(ipInCidr('255.255.255.255', any)).toBe(true)
  })
})

describe('ipInCidr — IPv6', () => {
  const c = parseCidr('2001:db8::/32')

  it('matches inside range', () => {
    expect(ipInCidr('2001:db8::1', c)).toBe(true)
    expect(ipInCidr('2001:db8:ffff::1', c)).toBe(true)
  })

  it('rejects outside range', () => {
    expect(ipInCidr('2001:db9::1', c)).toBe(false)
    expect(ipInCidr('::1', c)).toBe(false)
  })

  it('matches /128 single host', () => {
    const host = parseCidr('::1')
    expect(ipInCidr('::1', host)).toBe(true)
    expect(ipInCidr('::2', host)).toBe(false)
  })
})

describe('ipInAllowlist', () => {
  it('returns true when list is empty', () => {
    expect(ipInAllowlist('1.2.3.4', [])).toBe(true)
    expect(ipInAllowlist('1.2.3.4', null)).toBe(true)
    expect(ipInAllowlist('1.2.3.4', undefined)).toBe(true)
  })

  it('matches if any entry matches', () => {
    const list = [parseCidr('10.0.0.0/8'), parseCidr('192.168.1.0/24')]
    expect(ipInAllowlist('192.168.1.50', list)).toBe(true)
    expect(ipInAllowlist('10.1.2.3', list)).toBe(true)
  })

  it('rejects when no entry matches', () => {
    const list = [parseCidr('10.0.0.0/8')]
    expect(ipInAllowlist('8.8.8.8', list)).toBe(false)
  })
})

describe('normaliseRequestIp', () => {
  it('unwraps IPv4-mapped IPv6', () => {
    expect(normaliseRequestIp('::ffff:1.2.3.4')).toBe('1.2.3.4')
  })

  it('preserves bare IPv4', () => {
    expect(normaliseRequestIp('1.2.3.4')).toBe('1.2.3.4')
  })

  it('preserves IPv6', () => {
    expect(normaliseRequestIp('::1')).toBe('::1')
  })

  it('returns null for garbage', () => {
    expect(normaliseRequestIp('not-an-ip')).toBe(null)
    expect(normaliseRequestIp('')).toBe(null)
    expect(normaliseRequestIp(null)).toBe(null)
    expect(normaliseRequestIp(undefined)).toBe(null)
  })
})
