import { describe, it, expect } from 'vitest'
import { deviceFingerprint } from './login-events.js'

describe('deviceFingerprint', () => {
  it('returns null when both ip and ua are missing', () => {
    expect(deviceFingerprint(null, null)).toBeNull()
    expect(deviceFingerprint(undefined, undefined)).toBeNull()
    expect(deviceFingerprint('', '')).toBeNull()
  })
  it('is a 64-char hex string', () => {
    const fp = deviceFingerprint('192.168.1.13', 'Mozilla/5.0')
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
  it('is stable for the same inputs', () => {
    const a = deviceFingerprint('192.168.1.13', 'Mozilla/5.0 Chrome/120')
    const b = deviceFingerprint('192.168.1.13', 'Mozilla/5.0 Chrome/120')
    expect(a).toBe(b)
  })
  it('ignores IPv4 last octet (same subnet)', () => {
    const a = deviceFingerprint('192.168.1.13', 'Mozilla/5.0')
    const b = deviceFingerprint('192.168.1.200', 'Mozilla/5.0')
    expect(a).toBe(b)
  })
  it('differs across different IPv4 subnets', () => {
    const a = deviceFingerprint('192.168.1.13', 'Mozilla/5.0')
    const b = deviceFingerprint('10.0.0.5', 'Mozilla/5.0')
    expect(a).not.toBe(b)
  })
  it('strips version numbers from UA', () => {
    // Chrome/120 vs Chrome/121 should collapse to the same fingerprint
    const a = deviceFingerprint('192.168.1.13', 'Chrome/120 Windows')
    const b = deviceFingerprint('192.168.1.13', 'Chrome/121 Windows')
    expect(a).toBe(b)
  })
  it('differs across fundamentally different browsers', () => {
    const a = deviceFingerprint('192.168.1.13', 'Chrome/120 Windows')
    const b = deviceFingerprint('192.168.1.13', 'Safari/17 Mac OS')
    expect(a).not.toBe(b)
  })
  it('handles IPv6 (first 4 groups)', () => {
    const a = deviceFingerprint('2001:db8:85a3:1234:abcd:ef01:2345:6789', 'ua')
    const b = deviceFingerprint('2001:db8:85a3:1234:ffff:ffff:ffff:ffff', 'ua')
    expect(a).toBe(b)
  })
  it('handles ip only (no ua)', () => {
    const fp = deviceFingerprint('192.168.1.13', null)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
  it('handles ua only (no ip)', () => {
    const fp = deviceFingerprint(null, 'Mozilla/5.0')
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })
})
