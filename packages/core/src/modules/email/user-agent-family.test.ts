/**
 * Unit tests for email/user-agent-family.ts — pure UA classifier.
 *
 * Covers every branch in the decision tree including the
 * order-matters cases (Edge contains "Chrome", Chrome-on-iOS contains
 * "Safari", etc.)
 */

import { describe, expect, it } from 'vitest'
import { userAgentFamily } from './user-agent-family.js'

describe('userAgentFamily — empty/null handling', () => {
  it('returns null for null', () => {
    expect(userAgentFamily(null)).toBe(null)
  })

  it('returns null for undefined', () => {
    expect(userAgentFamily(undefined)).toBe(null)
  })

  it('returns null for empty string', () => {
    expect(userAgentFamily('')).toBe(null)
  })

  it('returns null for whitespace-only string', () => {
    expect(userAgentFamily('   \t\n   ')).toBe(null)
  })
})

describe('userAgentFamily — browser classification', () => {
  it('classifies Chrome on Windows', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    expect(userAgentFamily(ua)).toBe('chrome')
  })

  it('classifies Chromium as chrome', () => {
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/118.0.5993.117 Chrome/118.0.5993.117 Safari/537.36'
    expect(userAgentFamily(ua)).toBe('chrome')
  })

  it('classifies Firefox on Linux', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0'
    expect(userAgentFamily(ua)).toBe('firefox')
  })

  it('classifies Safari on macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    expect(userAgentFamily(ua)).toBe('safari')
  })

  it('classifies Safari on iOS', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    expect(userAgentFamily(ua)).toBe('safari')
  })

  it('classifies Edge on Windows (Chromium-based)', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
    expect(userAgentFamily(ua)).toBe('edge')
  })

  it('classifies Opera', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0'
    expect(userAgentFamily(ua)).toBe('opera')
  })

  it('classifies Samsung Internet', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36'
    expect(userAgentFamily(ua)).toBe('samsung')
  })
})

describe('userAgentFamily — iOS edge cases (order-matters)', () => {
  it('classifies Chrome on iOS as chrome (CriOS token)', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.101 Mobile/15E148 Safari/604.1'
    expect(userAgentFamily(ua)).toBe('chrome')
  })

  it('classifies Firefox on iOS as firefox (FxiOS token)', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/119.1 Mobile/15E148 Safari/605.1.15'
    expect(userAgentFamily(ua)).toBe('firefox')
  })

  it('classifies Edge on iOS as edge', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/120.0.0 Mobile/15E148 Safari/604.1'
    expect(userAgentFamily(ua)).toBe('edge')
  })
})

describe('userAgentFamily — bot classification', () => {
  it('classifies Googlebot', () => {
    const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
    expect(userAgentFamily(ua)).toBe('bot')
  })

  it('classifies Bingbot', () => {
    const ua = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'
    expect(userAgentFamily(ua)).toBe('bot')
  })

  it('classifies Ahrefsbot', () => {
    expect(userAgentFamily('Mozilla/5.0 (compatible; AhrefsBot/7.0)')).toBe('bot')
  })

  it('classifies curl', () => {
    expect(userAgentFamily('curl/7.81.0')).toBe('bot')
  })

  it('classifies wget', () => {
    expect(userAgentFamily('Wget/1.21.3')).toBe('bot')
  })

  it('classifies python-requests', () => {
    expect(userAgentFamily('python-requests/2.31.0')).toBe('bot')
  })

  it('classifies node-fetch', () => {
    expect(userAgentFamily('node-fetch/1.0')).toBe('bot')
  })

  it('classifies PostmanRuntime', () => {
    expect(userAgentFamily('PostmanRuntime/7.32.3')).toBe('bot')
  })

  it('classifies HeadlessChrome', () => {
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36'
    expect(userAgentFamily(ua)).toBe('bot')
  })

  it('classifies facebookexternalhit', () => {
    expect(userAgentFamily('facebookexternalhit/1.1')).toBe('bot')
  })

  it('classifies twitterbot', () => {
    expect(userAgentFamily('Twitterbot/1.0')).toBe('bot')
  })
})

describe('userAgentFamily — fallback to other', () => {
  it('falls back to other for unknown browsers', () => {
    expect(userAgentFamily('MyCustomBrowser/1.0')).toBe('other')
  })

  it('falls back to other for random garbage', () => {
    expect(userAgentFamily('asdf1234')).toBe('other')
  })
})

describe('userAgentFamily — ReDoS resistance', () => {
  it('handles extremely long input without hanging', () => {
    const long = 'A'.repeat(100000)
    const start = Date.now()
    userAgentFamily(long)
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('handles repeated Chrome tokens', () => {
    const repeated = 'Chrome/1.0 '.repeat(10000)
    const start = Date.now()
    userAgentFamily(repeated)
    expect(Date.now() - start).toBeLessThan(100)
  })
})

describe('userAgentFamily — case insensitivity', () => {
  it('matches lowercase UA', () => {
    expect(userAgentFamily('chrome/120')).toBe('chrome')
  })

  it('matches mixed case UA', () => {
    expect(userAgentFamily('ChRoMe/120')).toBe('chrome')
  })

  it('matches uppercase UA', () => {
    expect(userAgentFamily('CHROME/120')).toBe('chrome')
  })
})
