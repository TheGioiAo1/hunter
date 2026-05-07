/**
 * Tests for the Intl-backed admin formatters (Phase 2 Step 2.10).
 *
 * We deliberately avoid asserting exact output strings where the
 * Intl implementation can vary across Node versions (non-breaking
 * space characters, hair spaces around currency symbols, etc.).
 * Instead, we assert on characteristic substrings and on structural
 * differences between locales so a regression still fails loudly.
 */

import { describe, it, expect } from 'vitest'
import {
  formatNumber,
  formatCurrency,
  formatPercent,
  formatDate,
  formatDateTime,
  formatTime,
  formatRelative,
} from './format.js'

// ---------------------------------------------------------------------------
// formatNumber
// ---------------------------------------------------------------------------

describe('formatNumber', () => {
  it('returns empty for non-finite', () => {
    expect(formatNumber('en-US', NaN)).toBe('')
    expect(formatNumber('en-US', Infinity)).toBe('')
  })

  it('uses US grouping for en-US', () => {
    expect(formatNumber('en-US', 1234567)).toBe('1,234,567')
  })

  it('uses different grouping for de-DE', () => {
    // German uses dot as thousands separator.
    const s = formatNumber('de-DE', 1234567)
    expect(s).not.toBe('1,234,567')
    expect(s.replace(/[^\d]/g, '')).toBe('1234567')
  })

  it('honors maximumFractionDigits', () => {
    expect(formatNumber('en-US', 3.14159, { maximumFractionDigits: 2 })).toBe(
      '3.14',
    )
  })
})

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------

describe('formatCurrency', () => {
  it('returns empty for non-finite', () => {
    expect(formatCurrency('en-US', NaN, 'USD')).toBe('')
  })

  it('uses a dollar sign for USD in en-US', () => {
    expect(formatCurrency('en-US', 1234.5, 'USD')).toContain('$')
  })

  it('uses EUR symbol in de-DE', () => {
    expect(formatCurrency('de-DE', 1234.5, 'EUR')).toContain('€')
  })

  it('uses pound sign for GBP in en-GB', () => {
    expect(formatCurrency('en-GB', 1234.5, 'GBP')).toContain('£')
  })

  it('is case-insensitive for the currency code', () => {
    const a = formatCurrency('en-US', 100, 'usd')
    const b = formatCurrency('en-US', 100, 'USD')
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// formatPercent
// ---------------------------------------------------------------------------

describe('formatPercent', () => {
  it('renders a percent sign', () => {
    expect(formatPercent('en-US', 0.15)).toContain('%')
  })

  it('defaults to 0 fraction digits', () => {
    expect(formatPercent('en-US', 0.15)).toBe('15%')
  })

  it('honors fractionDigits', () => {
    expect(formatPercent('en-US', 0.12345, 2)).toBe('12.35%')
  })
})

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe('formatDate', () => {
  it('returns empty on unparseable input', () => {
    expect(formatDate('en-US', 'not a date')).toBe('')
  })

  it('accepts Date, string, and number inputs', () => {
    const d = new Date('2026-04-09T12:00:00Z')
    const a = formatDate('en-US', d)
    const b = formatDate('en-US', d.toISOString())
    const c = formatDate('en-US', d.getTime())
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('produces visibly different output for en-US vs de-DE', () => {
    const d = new Date('2026-04-09T12:00:00Z')
    const en = formatDate('en-US', d)
    const de = formatDate('de-DE', d)
    expect(en).not.toBe(de)
  })

  it('contains the year and the day number', () => {
    const d = new Date('2026-04-09T12:00:00Z')
    const s = formatDate('en-US', d)
    expect(s).toContain('2026')
    // Day of month may be 9 or 10 depending on timezone — accept either.
    expect(s).toMatch(/[9]|10/)
  })
})

// ---------------------------------------------------------------------------
// formatDateTime
// ---------------------------------------------------------------------------

describe('formatDateTime', () => {
  it('returns empty on unparseable input', () => {
    expect(formatDateTime('en-US', 'nope')).toBe('')
  })

  it('includes a year and a colon (time separator)', () => {
    const s = formatDateTime('en-US', new Date('2026-04-09T12:30:00Z'))
    expect(s).toContain('2026')
    expect(s).toContain(':')
  })
})

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------

describe('formatTime', () => {
  it('contains a colon between hours and minutes', () => {
    const s = formatTime('en-US', new Date('2026-04-09T12:30:00Z'))
    expect(s).toContain(':')
  })

  it('returns empty on bad input', () => {
    expect(formatTime('en-US', 'blah')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// formatRelative
// ---------------------------------------------------------------------------

describe('formatRelative', () => {
  const now = new Date('2026-04-09T12:00:00Z')

  it('returns empty on unparseable input', () => {
    expect(formatRelative('en-US', 'blah', now)).toBe('')
  })

  it('formats seconds-ago in English', () => {
    const past = new Date(now.getTime() - 30 * 1000)
    const s = formatRelative('en-US', past, now)
    // "30 seconds ago" or similar — assert on key substring.
    expect(s.toLowerCase()).toContain('second')
  })

  it('formats minutes-ago', () => {
    const past = new Date(now.getTime() - 5 * 60 * 1000)
    const s = formatRelative('en-US', past, now)
    expect(s.toLowerCase()).toContain('minute')
  })

  it('formats hours-ago', () => {
    const past = new Date(now.getTime() - 3 * 60 * 60 * 1000)
    const s = formatRelative('en-US', past, now)
    expect(s.toLowerCase()).toContain('hour')
  })

  it('formats days-ago', () => {
    const past = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
    const s = formatRelative('en-US', past, now)
    expect(s.toLowerCase()).toContain('day')
  })

  it('localizes wording to German', () => {
    const past = new Date(now.getTime() - 5 * 60 * 1000)
    const s = formatRelative('de-DE', past, now)
    // German "Minuten" or "vor" should appear.
    expect(s.toLowerCase()).toMatch(/minute|vor/)
  })
})
