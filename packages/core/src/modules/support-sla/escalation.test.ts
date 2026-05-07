/**
 * Tests for `escalation.ts` — pure decision logic, no DB.
 */

import { describe, it, expect } from 'vitest'
import {
  bumpPriority,
  decideEscalation,
  PRIORITY_ORDER,
  type BreachRecord,
} from './escalation.ts'

describe('bumpPriority', () => {
  it('bumps low → normal', () => {
    expect(bumpPriority('low')).toBe('normal')
  })
  it('bumps normal → high', () => {
    expect(bumpPriority('normal')).toBe('high')
  })
  it('bumps high → urgent', () => {
    expect(bumpPriority('high')).toBe('urgent')
  })
  it('caps at urgent (no further bump)', () => {
    expect(bumpPriority('urgent')).toBe('urgent')
  })
  it('priority ordering is stable', () => {
    expect(PRIORITY_ORDER).toEqual(['low', 'normal', 'high', 'urgent'])
  })
})

function makeBreach(overrides: Partial<BreachRecord> = {}): BreachRecord {
  return {
    ticketId: 't1',
    shopId: 's1',
    breachType: 'first_response',
    overdueMs: 30 * 60_000, // 30 min over
    slaWindowMs: 4 * 3600 * 1000, // 4h window
    priority: 'normal',
    assignedAgentId: 'agent-1',
    category: 'technical',
    ...overrides,
  }
}

describe('decideEscalation: first-response breach', () => {
  it('assigned + mildly late → notify agent only, no bump, no lead', () => {
    const dec = decideEscalation(makeBreach(), { leadUserId: 'lead-1' })
    expect(dec.notifyUserIds).toEqual(['agent-1'])
    expect(dec.newPriority).toBeNull()
    expect(dec.pageLead).toBe(false)
    expect(dec.reason).toContain('first-response')
  })

  it('assigned + >2x overdue → bump priority + page lead', () => {
    const dec = decideEscalation(
      makeBreach({
        overdueMs: 9 * 3600 * 1000, // 9h over on a 4h window → 2.25x
        priority: 'normal',
      }),
      { leadUserId: 'lead-1' },
    )
    expect(dec.notifyUserIds).toContain('agent-1')
    expect(dec.notifyUserIds).toContain('lead-1')
    expect(dec.newPriority).toBe('high')
    expect(dec.pageLead).toBe(true)
    expect(dec.reason).toContain('priority bumped')
  })

  it('unassigned → page lead + bump + no double-noting', () => {
    const dec = decideEscalation(
      makeBreach({ assignedAgentId: null, priority: 'low' }),
      { leadUserId: 'lead-1' },
    )
    expect(dec.notifyUserIds).toEqual(['lead-1'])
    expect(dec.newPriority).toBe('normal')
    expect(dec.pageLead).toBe(true)
  })

  it('unassigned with no lead configured → empty recipient list (caller must fallback)', () => {
    const dec = decideEscalation(
      makeBreach({ assignedAgentId: null }),
      { leadUserId: null },
    )
    expect(dec.notifyUserIds).toEqual([])
    expect(dec.pageLead).toBe(true)
  })

  it('priority already urgent → newPriority=null (no no-op change)', () => {
    const dec = decideEscalation(
      makeBreach({
        overdueMs: 20 * 3600 * 1000,
        priority: 'urgent',
      }),
      { leadUserId: 'lead-1' },
    )
    expect(dec.newPriority).toBeNull()
    expect(dec.pageLead).toBe(true)
  })
})

describe('decideEscalation: resolution breach', () => {
  it('assigned + under 100% over → notify agent only', () => {
    const dec = decideEscalation(
      makeBreach({
        breachType: 'resolution',
        overdueMs: 30 * 60_000,
        slaWindowMs: 24 * 3600 * 1000,
      }),
      { leadUserId: 'lead-1' },
    )
    expect(dec.notifyUserIds).toEqual(['agent-1'])
    expect(dec.newPriority).toBeNull()
    expect(dec.pageLead).toBe(false)
  })

  it('assigned + >100% over → bump + lead', () => {
    const dec = decideEscalation(
      makeBreach({
        breachType: 'resolution',
        overdueMs: 30 * 3600 * 1000, // 30h on a 24h window
        slaWindowMs: 24 * 3600 * 1000,
        priority: 'normal',
      }),
      { leadUserId: 'lead-1' },
    )
    expect(dec.notifyUserIds).toContain('agent-1')
    expect(dec.notifyUserIds).toContain('lead-1')
    expect(dec.newPriority).toBe('high')
    expect(dec.pageLead).toBe(true)
  })

  it('unassigned resolution breach → always page lead + bump', () => {
    const dec = decideEscalation(
      makeBreach({
        breachType: 'resolution',
        assignedAgentId: null,
        priority: 'high',
      }),
      { leadUserId: 'lead-1' },
    )
    expect(dec.notifyUserIds).toEqual(['lead-1'])
    expect(dec.newPriority).toBe('urgent')
    expect(dec.pageLead).toBe(true)
  })
})

describe('decideEscalation: zero-window edge case', () => {
  it('slaWindowMs=0 → ratio=0, no bump (no divide-by-zero crash)', () => {
    const dec = decideEscalation(
      makeBreach({ slaWindowMs: 0, overdueMs: 1000 }),
      { leadUserId: 'lead-1' },
    )
    // With ratio=0 and assigned, behaves like "mild breach".
    expect(dec.pageLead).toBe(false)
    expect(dec.newPriority).toBeNull()
  })
})
