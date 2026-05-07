/**
 * Unit tests for run-platform-weekly-roundup.ts helpers.
 *
 * We don't test `main()` — that hits the live DB + emitter. Instead
 * we cover the pure date + formatting helpers that decide what the
 * cron sends.
 */

import { describe, it, expect } from 'vitest'
import {
  previousMondayUtc,
  formatWeekStart,
  escapeHtml,
} from './run-platform-weekly-roundup.js'

describe('previousMondayUtc', () => {
  it('Mon 2026-04-20 returns prior Monday 2026-04-13', () => {
    // "This Monday" is still running — we only send roundups for
    // weeks that are complete.
    const now = new Date('2026-04-20T06:00:00Z') // Monday
    expect(previousMondayUtc(now)).toBe('2026-04-13')
  })

  it('Tue 2026-04-21 returns 2026-04-20', () => {
    const now = new Date('2026-04-21T10:00:00Z') // Tuesday
    expect(previousMondayUtc(now)).toBe('2026-04-20')
  })

  it('Sun 2026-04-19 returns 2026-04-13', () => {
    const now = new Date('2026-04-19T23:59:59Z') // Sunday night
    expect(previousMondayUtc(now)).toBe('2026-04-13')
  })

  it('Wed 2026-04-22 returns 2026-04-20', () => {
    const now = new Date('2026-04-22T00:00:00Z') // Wednesday
    expect(previousMondayUtc(now)).toBe('2026-04-20')
  })

  it('year boundary: Fri 2026-01-02 returns 2025-12-29', () => {
    const now = new Date('2026-01-02T12:00:00Z')
    expect(previousMondayUtc(now)).toBe('2025-12-29')
  })
})

describe('formatWeekStart', () => {
  it('formats April 20, 2026', () => {
    expect(formatWeekStart('2026-04-20')).toBe('Apr 20, 2026')
  })

  it('formats January 1, 2025', () => {
    expect(formatWeekStart('2025-01-01')).toBe('Jan 1, 2025')
  })

  it('formats December 31, 2026', () => {
    expect(formatWeekStart('2026-12-31')).toBe('Dec 31, 2026')
  })
})

describe('escapeHtml', () => {
  it('escapes <script>', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
  })

  it('escapes quotes + apostrophes', () => {
    expect(escapeHtml(`Joe's "Shop"`)).toBe('Joe&#39;s &quot;Shop&quot;')
  })

  it('escapes ampersand first so other escapes don\'t double-escape', () => {
    expect(escapeHtml('AT&T')).toBe('AT&amp;T')
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;')
  })

  it('no-op on plain text', () => {
    expect(escapeHtml('Tom Tailor')).toBe('Tom Tailor')
  })
})
