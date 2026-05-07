/**
 * Support staff presets — tests.
 *
 * Pins the permission matrix from spec §10.7 + 2FA mode resolver.
 * Every preset/scope cell is asserted so a typo in `PERMISSION_MATRIX`
 * fails CI loudly. If the spec changes, update both this file and
 * `presets.ts` together.
 */
import { describe, it, expect } from 'vitest'
import { ALL_SCOPES, PERMISSION_MATRIX, PRESET_LABEL, twoFaMode } from './presets.ts'

describe('PERMISSION_MATRIX — coverage', () => {
  it('covers all 4 presets (3 support tiers + god_admin)', () => {
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual(
      ['god_admin', 'l1_support', 'l2_support_senior', 'lead_support'].sort(),
    )
  })

  it('every preset row has exactly the scopes in ALL_SCOPES (no typos)', () => {
    const want = [...ALL_SCOPES].sort()
    for (const [preset, row] of Object.entries(PERMISSION_MATRIX)) {
      const keys = Object.keys(row).sort()
      expect(keys, `preset ${preset}`).toEqual(want)
    }
  })
})

describe('L1 preset — front-line triage', () => {
  const l1 = PERMISSION_MATRIX.l1_support
  it('can read + reply + claim + internal note on tickets', () => {
    expect(l1['support:ticket:read']).toBe(true)
    expect(l1['support:ticket:reply']).toBe(true)
    expect(l1['support:ticket:claim']).toBe(true)
    expect(l1['support:ticket:internal_note']).toBe(true)
  })

  it('can do partial status change (open/pending) but NOT full status change', () => {
    expect(l1['support:ticket:status_change']).toBe(false)
    expect(l1['support:ticket:status_change_partial']).toBe(true)
  })

  it('CANNOT assign others / change priority / merge / delete messages', () => {
    expect(l1['support:ticket:assign_others']).toBe(false)
    expect(l1['support:ticket:priority_change']).toBe(false)
    expect(l1['support:ticket:merge']).toBe(false)
    expect(l1['support:ticket:delete_message']).toBe(false)
  })

  it('CANNOT manage canned replies / read cross-shop audit / see team analytics', () => {
    expect(l1['support:canned_replies:manage']).toBe(false)
    expect(l1['support:audit:cross_shop']).toBe(false)
    expect(l1['support:audit:cross_shop_partial']).toBe(false)
    expect(l1['support:analytics:team']).toBe(false)
  })

  it('has its own self analytics + AI usage', () => {
    expect(l1['support:analytics:self']).toBe(true)
    expect(l1['support:ai:use']).toBe(true)
  })

  it('DENY-LIST: orders / customers / revenue / billing all false', () => {
    expect(l1['support:shop:orders_read']).toBe(false)
    expect(l1['support:shop:customers_read']).toBe(false)
    expect(l1['support:shop:revenue_read']).toBe(false)
    expect(l1['support:shop:billing_read']).toBe(false)
  })

  it('DENY-LIST: no staff mgmt / AI config', () => {
    expect(l1['support:staff:invite']).toBe(false)
    expect(l1['support:staff:manage']).toBe(false)
    expect(l1['support:ai:configure']).toBe(false)
  })
})

describe('L2 preset — senior agent', () => {
  const l2 = PERMISSION_MATRIX.l2_support_senior
  it('can assign others + priority change + full status + merge + manage canned replies', () => {
    expect(l2['support:ticket:assign_others']).toBe(true)
    expect(l2['support:ticket:priority_change']).toBe(true)
    expect(l2['support:ticket:status_change']).toBe(true)
    expect(l2['support:ticket:merge']).toBe(true)
    expect(l2['support:canned_replies:manage']).toBe(true)
  })

  it('has partial cross-shop audit (assigned only) but NOT full cross-shop', () => {
    expect(l2['support:audit:cross_shop_partial']).toBe(true)
    expect(l2['support:audit:cross_shop']).toBe(false)
  })

  it('CANNOT delete messages / see team analytics', () => {
    expect(l2['support:ticket:delete_message']).toBe(false)
    expect(l2['support:analytics:team']).toBe(false)
  })

  it('DENY-LIST: orders / customers / revenue / billing all false', () => {
    expect(l2['support:shop:orders_read']).toBe(false)
    expect(l2['support:shop:customers_read']).toBe(false)
    expect(l2['support:shop:revenue_read']).toBe(false)
    expect(l2['support:shop:billing_read']).toBe(false)
  })

  it('DENY-LIST: no staff mgmt / AI config', () => {
    expect(l2['support:staff:invite']).toBe(false)
    expect(l2['support:staff:manage']).toBe(false)
    expect(l2['support:ai:configure']).toBe(false)
  })
})

describe('Lead preset — team manager', () => {
  const lead = PERMISSION_MATRIX.lead_support
  it('inherits everything L2 has PLUS delete messages / full cross-shop / team analytics', () => {
    expect(lead['support:ticket:delete_message']).toBe(true)
    expect(lead['support:audit:cross_shop']).toBe(true)
    expect(lead['support:analytics:team']).toBe(true)
  })

  it('DENY-LIST: orders / customers / revenue / billing all false (god-admin-only)', () => {
    expect(lead['support:shop:orders_read']).toBe(false)
    expect(lead['support:shop:customers_read']).toBe(false)
    expect(lead['support:shop:revenue_read']).toBe(false)
    expect(lead['support:shop:billing_read']).toBe(false)
  })

  it('DENY-LIST: still no staff invite / manage / AI config', () => {
    expect(lead['support:staff:invite']).toBe(false)
    expect(lead['support:staff:manage']).toBe(false)
    expect(lead['support:ai:configure']).toBe(false)
  })
})

describe('god_admin preset — platform owner', () => {
  const god = PERMISSION_MATRIX.god_admin
  it('has every scope set to true', () => {
    for (const scope of ALL_SCOPES) {
      expect(god[scope], `god admin should have ${scope}`).toBe(true)
    }
  })
})

describe('PRESET_LABEL', () => {
  it('exposes a user-friendly label for every preset', () => {
    expect(PRESET_LABEL.l1_support).toBe('L1 Support')
    expect(PRESET_LABEL.l2_support_senior).toBe('L2 Support (Senior)')
    expect(PRESET_LABEL.lead_support).toBe('Lead Support')
    expect(PRESET_LABEL.god_admin).toBe('God Admin')
  })
})

describe('twoFaMode', () => {
  it('L1 = optional', () => {
    expect(twoFaMode('l1_support')).toBe('optional')
  })
  it('L2 = recommended', () => {
    expect(twoFaMode('l2_support_senior')).toBe('recommended')
  })
  it('Lead = mandatory', () => {
    expect(twoFaMode('lead_support')).toBe('mandatory')
  })
  it('god_admin = mandatory', () => {
    expect(twoFaMode('god_admin')).toBe('mandatory')
  })
})
