/**
 * windows.test.ts — deploy window math lives in two places on purpose
 * (packages/agent-guard and here). These tests pin the script-side
 * copy so the two can't silently drift.
 */

import { describe, it, expect } from 'vitest'
import { insideDailyWindow, insideSundayWindow, anyDeployWindow } from './windows.ts'

// Helper: build a UTC Date from ISO without risk of local-tz confusion.
const utc = (iso: string): Date => new Date(iso)

describe('insideDailyWindow (GMT+7 03:00..04:00)', () => {
  it('returns true at 03:00 local (20:00 UTC previous day)', () => {
    // Wed 2026-04-08 20:00:00Z === Thu 2026-04-09 03:00:00 GMT+7
    expect(insideDailyWindow(utc('2026-04-08T20:00:00Z'))).toBe(true)
  })

  it('returns true at 03:59 local', () => {
    expect(insideDailyWindow(utc('2026-04-08T20:59:00Z'))).toBe(true)
  })

  it('returns false at 04:00 local (21:00 UTC previous day)', () => {
    expect(insideDailyWindow(utc('2026-04-08T21:00:00Z'))).toBe(false)
  })

  it('returns false at 02:59 local', () => {
    expect(insideDailyWindow(utc('2026-04-08T19:59:00Z'))).toBe(false)
  })

  it('returns false mid-day UTC', () => {
    expect(insideDailyWindow(utc('2026-04-09T12:00:00Z'))).toBe(false)
  })
})

describe('insideSundayWindow (GMT+7 Sun 02:00..05:00)', () => {
  it('returns true at Sun 02:00 local', () => {
    // Sun 2026-04-12 02:00 GMT+7 === Sat 2026-04-11 19:00 UTC
    expect(insideSundayWindow(utc('2026-04-11T19:00:00Z'))).toBe(true)
  })

  it('returns true at Sun 04:59 local', () => {
    expect(insideSundayWindow(utc('2026-04-11T21:59:00Z'))).toBe(true)
  })

  it('returns false at Sun 05:00 local (outside window)', () => {
    expect(insideSundayWindow(utc('2026-04-11T22:00:00Z'))).toBe(false)
  })

  it('returns false at Sun 01:59 local', () => {
    expect(insideSundayWindow(utc('2026-04-11T18:59:00Z'))).toBe(false)
  })

  it('returns false on a Saturday at the same clock time', () => {
    // Sat 2026-04-11 03:00 GMT+7 === Fri 2026-04-10 20:00 UTC
    expect(insideSundayWindow(utc('2026-04-10T20:00:00Z'))).toBe(false)
  })
})

describe('anyDeployWindow', () => {
  it('true when inside daily window', () => {
    expect(anyDeployWindow(utc('2026-04-08T20:30:00Z'))).toBe(true)
  })

  it('true when inside sunday window', () => {
    expect(anyDeployWindow(utc('2026-04-11T20:00:00Z'))).toBe(true)
  })

  it('false outside both windows', () => {
    expect(anyDeployWindow(utc('2026-04-09T10:00:00Z'))).toBe(false)
  })
})
