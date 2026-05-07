/**
 * Tests for preferences.ts — pure logic (no DB), plus `pickChannels`
 * + `isInQuietHours`.
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PREFERENCES,
  channelsForType,
  isInQuietHours,
  pickChannels,
  type ResolvedPreferences,
} from './preferences.ts'

function prefs(overrides: Partial<ResolvedPreferences> = {}): ResolvedPreferences {
  return { ...DEFAULT_PREFERENCES, userId: 'u1', ...overrides }
}

describe('channelsForType', () => {
  it('maps SLA breach to sla_breach column', () => {
    const p = prefs({ slaBreachChannels: ['email'] })
    expect(channelsForType(p, 'sla_first_response_breach')).toEqual(['email'])
    expect(channelsForType(p, 'sla_resolution_breach')).toEqual(['email'])
  })
  it('maps mention to mention column', () => {
    const p = prefs({ mentionChannels: ['in_app'] })
    expect(channelsForType(p, 'mention')).toEqual(['in_app'])
  })
  it('maps csat_prompt to csat_prompt column', () => {
    const p = prefs({ csatPromptChannels: ['email', 'in_app'] })
    expect(channelsForType(p, 'csat_prompt')).toEqual(['email', 'in_app'])
  })
  it('maps new_message and ticket_assigned to new_message column', () => {
    const p = prefs({ newMessageChannels: ['browser_push'] })
    expect(channelsForType(p, 'new_message_to_agent')).toEqual(['browser_push'])
    expect(channelsForType(p, 'ticket_assigned')).toEqual(['browser_push'])
  })
  it('auto_close types map to sla_breach column', () => {
    const p = prefs({ slaBreachChannels: ['in_app'] })
    expect(channelsForType(p, 'auto_close')).toEqual(['in_app'])
    expect(channelsForType(p, 'auto_close_warning')).toEqual(['in_app'])
  })
})

describe('isInQuietHours', () => {
  it('returns false when no quiet hours configured', () => {
    const p = prefs({ quietHoursStart: null, quietHoursEnd: null })
    expect(isInQuietHours(p, new Date('2026-04-22T15:00:00Z'))).toBe(false)
  })

  it('returns true inside a same-day window', () => {
    const p = prefs({
      quietHoursStart: '09:00',
      quietHoursEnd: '17:00',
      quietHoursTz: 'UTC',
    })
    expect(isInQuietHours(p, new Date('2026-04-22T10:00:00Z'))).toBe(true)
  })

  it('returns false outside a same-day window', () => {
    const p = prefs({
      quietHoursStart: '09:00',
      quietHoursEnd: '17:00',
      quietHoursTz: 'UTC',
    })
    expect(isInQuietHours(p, new Date('2026-04-22T18:00:00Z'))).toBe(false)
  })

  it('handles window crossing midnight (22:00 → 07:00)', () => {
    const p = prefs({
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      quietHoursTz: 'UTC',
    })
    expect(isInQuietHours(p, new Date('2026-04-22T23:00:00Z'))).toBe(true)
    expect(isInQuietHours(p, new Date('2026-04-22T03:00:00Z'))).toBe(true)
    expect(isInQuietHours(p, new Date('2026-04-22T12:00:00Z'))).toBe(false)
  })

  it('end is exclusive (17:00 sharp is OUTSIDE quiet)', () => {
    const p = prefs({
      quietHoursStart: '09:00',
      quietHoursEnd: '17:00',
      quietHoursTz: 'UTC',
    })
    expect(isInQuietHours(p, new Date('2026-04-22T17:00:00Z'))).toBe(false)
  })
})

describe('pickChannels', () => {
  it('returns empty when emailEnabled=false AND no other channels requested', () => {
    const p = prefs({
      emailEnabled: false,
      inAppEnabled: false,
      slaBreachChannels: ['email'],
    })
    expect(pickChannels(p, 'sla_first_response_breach')).toEqual([])
  })

  it('SLA breach bypasses quiet hours for email', () => {
    const p = prefs({
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
      quietHoursTz: 'UTC',
      slaBreachChannels: ['email', 'in_app'],
    })
    const picked = pickChannels(
      p,
      'sla_first_response_breach',
      new Date('2026-04-22T10:00:00Z'),
    )
    expect(picked).toContain('email')
    expect(picked).toContain('in_app')
  })

  it('regular notification suppresses email during quiet hours', () => {
    const p = prefs({
      quietHoursStart: '09:00',
      quietHoursEnd: '17:00',
      quietHoursTz: 'UTC',
      mentionChannels: ['email', 'in_app'],
    })
    const picked = pickChannels(
      p,
      'mention',
      new Date('2026-04-22T10:00:00Z'),
    )
    expect(picked).not.toContain('email')
    expect(picked).toContain('in_app')
  })

  it('skips browser_push when no subscription present', () => {
    const p = prefs({
      browserPushEnabled: true,
      browserPushSubscription: null,
      mentionChannels: ['browser_push', 'in_app'],
    })
    const picked = pickChannels(p, 'mention')
    expect(picked).not.toContain('browser_push')
  })

  it('honours in-app toggle off', () => {
    const p = prefs({
      inAppEnabled: false,
      mentionChannels: ['in_app', 'email'],
    })
    const picked = pickChannels(
      p,
      'mention',
      new Date('2026-04-22T10:00:00Z'),
    )
    expect(picked).not.toContain('in_app')
    expect(picked).toContain('email')
  })
})
