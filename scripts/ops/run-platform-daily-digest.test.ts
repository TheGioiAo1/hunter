/**
 * Unit tests for run-platform-daily-digest.ts helpers.
 */

import { describe, it, expect } from 'vitest'
import { formatUsd } from './run-platform-daily-digest.js'

describe('formatUsd', () => {
  it('formats a plain integer', () => {
    expect(formatUsd(100)).toBe('$100.00')
  })

  it('formats a numeric string from pg', () => {
    expect(formatUsd('12345.67')).toBe('$12,345.67')
  })

  it('uses thousands separators', () => {
    expect(formatUsd(1234567.89)).toBe('$1,234,567.89')
  })

  it('handles null / undefined as $0.00', () => {
    expect(formatUsd(null)).toBe('$0.00')
    expect(formatUsd(undefined)).toBe('$0.00')
  })

  it('guards against NaN', () => {
    expect(formatUsd('not-a-number')).toBe('$0.00')
  })

  it('rounds to 2 decimal places', () => {
    expect(formatUsd(1.005)).toBe('$1.01') // banker's rounding via toLocaleString — 1.005 → 1.01
  })

  it('handles negative values', () => {
    // Refunds can go negative. We don't special-case; let the formatter
    // emit '-'. The cron should never actually pass a negative, but
    // we don't want the helper to hide errors upstream.
    expect(formatUsd(-50)).toBe('$-50.00')
  })
})
