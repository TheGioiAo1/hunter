/**
 * Store-admin — `resolvePublishedAt` helper (Phase C3c).
 *
 * The helper decides the `published_at` column value for a save based
 * on the "Publish" checkbox and the optional "Schedule publish"
 * datetime-local input. Keeping it pure makes the scheduling matrix
 * trivial to verify — the create/edit handlers then call it.
 */

import { describe, it, expect, vi } from 'vitest'
import { resolvePublishedAt } from './collections.js'

describe('resolvePublishedAt', () => {
  it('returns null when the publish box is unchecked', () => {
    expect(resolvePublishedAt(false, '')).toBeNull()
    expect(resolvePublishedAt(false, '2030-01-01T00:00')).toBeNull()
  })

  it('returns NOW() when published + no schedule given', () => {
    const before = Date.now()
    const out = resolvePublishedAt(true, '')
    const after = Date.now()
    expect(out).toBeInstanceOf(Date)
    const t = (out as Date).getTime()
    expect(t).toBeGreaterThanOrEqual(before - 5)
    expect(t).toBeLessThanOrEqual(after + 5)
  })

  it('returns NOW() for a malformed schedule string', () => {
    const out = resolvePublishedAt(true, 'not-a-date')
    expect(out).toBeInstanceOf(Date)
    // Roughly now.
    expect(Math.abs((out as Date).getTime() - Date.now())).toBeLessThan(1000)
  })

  it('returns the future schedule when it is >2s ahead', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000) // +1h
    // Use ISO string — browsers POST datetime-local as "YYYY-MM-DDTHH:mm"
    // but `new Date(isoString)` handles both shapes.
    const out = resolvePublishedAt(true, future.toISOString())
    expect(out).toBeInstanceOf(Date)
    expect(Math.abs((out as Date).getTime() - future.getTime())).toBeLessThan(1000)
  })

  it('falls back to NOW() when schedule is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const out = resolvePublishedAt(true, past)
    expect(out).toBeInstanceOf(Date)
    // "Publish now" semantics — should be close to now, not the past value.
    expect((out as Date).getTime()).toBeGreaterThan(Date.now() - 5_000)
  })

  it('falls back to NOW() when schedule is "right now" (within 2s)', () => {
    const nowIso = new Date(Date.now() + 500).toISOString()
    const out = resolvePublishedAt(true, nowIso)
    expect(out).toBeInstanceOf(Date)
    expect(Math.abs((out as Date).getTime() - Date.now())).toBeLessThan(2000)
  })

  it('ignores non-string inputs gracefully', () => {
    // Merchants shouldn't ever send these, but bots / CSV imports might.
    const out1 = resolvePublishedAt(true, null)
    const out2 = resolvePublishedAt(true, undefined)
    const out3 = resolvePublishedAt(true, 12345)
    const out4 = resolvePublishedAt(true, { what: 'is this' })
    for (const out of [out1, out2, out3, out4]) {
      expect(out).toBeInstanceOf(Date)
      expect(Math.abs((out as Date).getTime() - Date.now())).toBeLessThan(1000)
    }
  })
})
