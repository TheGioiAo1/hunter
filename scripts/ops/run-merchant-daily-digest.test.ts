/**
 * Unit tests for run-merchant-daily-digest.ts kill-switch helper.
 */

import { describe, it, expect } from 'vitest'
import { isMerchantDigestEnabled } from './run-merchant-daily-digest.js'

describe('isMerchantDigestEnabled', () => {
  it('defaults to true when env is absent', () => {
    expect(isMerchantDigestEnabled({})).toBe(true)
  })

  it('false when explicitly 0', () => {
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: '0' })).toBe(false)
  })

  it('false when explicitly "false"', () => {
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: 'false' })).toBe(false)
  })

  it('false when explicitly "FALSE" (case-insensitive)', () => {
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: 'FALSE' })).toBe(false)
  })

  it('false when explicitly "no"', () => {
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: 'no' })).toBe(false)
  })

  it('false when empty string', () => {
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: '' })).toBe(false)
  })

  it('true when "1"', () => {
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: '1' })).toBe(true)
  })

  it('true when "true"', () => {
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: 'true' })).toBe(true)
  })

  it('true when any other value (safe default)', () => {
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: 'yes' })).toBe(true)
    expect(isMerchantDigestEnabled({ MERCHANT_DIGEST_ENABLED: 'on' })).toBe(true)
  })
})
