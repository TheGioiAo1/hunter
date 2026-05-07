/**
 * Gbox Platform — Cluster D bug 9 unit tests (pure helper).
 *
 * The DB-touching sweepZombieDeliveries() is exercised by the phase-14
 * pr2 smoke script. Here we only lock down the cutoff arithmetic — the
 * one piece that a typo ("0 minutes") could catastrophically break.
 */
import { describe, it, expect } from 'vitest'
import {
  computeZombieCutoffIso,
  DEFAULT_ZOMBIE_GRACE_MINUTES,
  ZOMBIE_FAILED_REASON,
} from './zombie-janitor.js'

describe('computeZombieCutoffIso (bug 9)', () => {
  it('subtracts the grace period from now', () => {
    const now = '2026-04-24T10:00:00.000Z'
    const cutoff = computeZombieCutoffIso(now, 10)
    expect(cutoff).toBe('2026-04-24T09:50:00.000Z')
  })

  it('handles the default grace period (10 minutes)', () => {
    const now = '2026-04-24T10:00:00.000Z'
    const cutoff = computeZombieCutoffIso(now, DEFAULT_ZOMBIE_GRACE_MINUTES)
    expect(cutoff).toBe('2026-04-24T09:50:00.000Z')
  })

  it('handles a 1-minute grace (test-timing)', () => {
    const now = '2026-04-24T10:00:00.000Z'
    const cutoff = computeZombieCutoffIso(now, 1)
    expect(cutoff).toBe('2026-04-24T09:59:00.000Z')
  })

  it('rejects zero grace period (foot-gun guard)', () => {
    // A 0-minute grace would sweep every single queued row instantly —
    // catastrophic if an ops typo lands in a config file.
    expect(() => computeZombieCutoffIso('2026-04-24T10:00:00Z', 0)).toThrow(
      /must be > 0/,
    )
  })

  it('rejects negative grace period', () => {
    expect(() => computeZombieCutoffIso('2026-04-24T10:00:00Z', -5)).toThrow(
      /must be > 0/,
    )
  })

  it('rejects NaN / Infinity grace periods', () => {
    expect(() => computeZombieCutoffIso('2026-04-24T10:00:00Z', NaN)).toThrow(
      /must be > 0/,
    )
    expect(() =>
      computeZombieCutoffIso('2026-04-24T10:00:00Z', Infinity),
    ).toThrow(/must be > 0/)
  })

  it('rejects invalid ISO date strings', () => {
    expect(() => computeZombieCutoffIso('not-a-date', 10)).toThrow(
      /invalid nowIso/,
    )
  })

  it('rolls over day / month boundaries correctly', () => {
    // 1 minute after midnight → cutoff should cross into prior month.
    const now = '2026-05-01T00:00:30.000Z'
    const cutoff = computeZombieCutoffIso(now, 10)
    expect(cutoff).toBe('2026-04-30T23:50:30.000Z')
  })
})

describe('ZOMBIE_FAILED_REASON', () => {
  it('contains the word "zombie" so admin UI can substring-match', () => {
    // The admin UI has a special icon + tooltip for zombies; it checks
    // via substring match on failed_reason. If we rename this constant
    // carelessly the admin UI silently stops rendering the zombie icon.
    expect(ZOMBIE_FAILED_REASON).toMatch(/zombie/)
  })
})
