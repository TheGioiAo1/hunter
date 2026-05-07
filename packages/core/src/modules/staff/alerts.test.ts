import { describe, it, expect } from 'vitest'
import {
  ALERT_EVENT_CATALOG,
  ALERT_EVENT_KEYS,
  isValidAlertEventKey,
  getAlertEventDef,
  resolvePreference,
} from './alerts.js'

describe('ALERT_EVENT_CATALOG', () => {
  it('has at least 10 events', () => {
    expect(ALERT_EVENT_CATALOG.length).toBeGreaterThanOrEqual(10)
  })
  it('every entry has the required fields', () => {
    for (const e of ALERT_EVENT_CATALOG) {
      expect(e.key).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+$/)
      expect(e.label.length).toBeGreaterThan(0)
      expect(e.description.length).toBeGreaterThan(0)
      expect(['info', 'warning', 'critical']).toContain(e.defaultSeverity)
      expect(typeof e.defaultVia.email).toBe('boolean')
      expect(typeof e.defaultVia.inapp).toBe('boolean')
    }
  })
  it('ALERT_EVENT_KEYS is derived from catalog', () => {
    expect(ALERT_EVENT_KEYS).toEqual(ALERT_EVENT_CATALOG.map((e) => e.key))
  })
  it('keys are unique', () => {
    expect(new Set(ALERT_EVENT_KEYS).size).toBe(ALERT_EVENT_KEYS.length)
  })
  it('includes launch-critical events', () => {
    const keys = new Set(ALERT_EVENT_KEYS)
    expect(keys.has('order.placed')).toBe(true)
    expect(keys.has('order.payment_failed')).toBe(true)
    expect(keys.has('inventory.low_stock')).toBe(true)
    expect(keys.has('staff.new_device_login')).toBe(true)
    expect(keys.has('staff.2fa_disabled')).toBe(true)
  })
  it('critical events default to email+inapp', () => {
    for (const e of ALERT_EVENT_CATALOG) {
      if (e.defaultSeverity === 'critical') {
        expect(e.defaultVia.email).toBe(true)
        expect(e.defaultVia.inapp).toBe(true)
      }
    }
  })
})

describe('isValidAlertEventKey', () => {
  it('accepts catalog keys', () => {
    expect(isValidAlertEventKey('order.placed')).toBe(true)
    expect(isValidAlertEventKey('staff.new_device_login')).toBe(true)
  })
  it('rejects unknown keys', () => {
    expect(isValidAlertEventKey('order.deleted')).toBe(false)
    expect(isValidAlertEventKey('')).toBe(false)
    expect(isValidAlertEventKey(42 as any)).toBe(false)
    expect(isValidAlertEventKey(null as any)).toBe(false)
  })
})

describe('getAlertEventDef', () => {
  it('returns the def for a valid key', () => {
    const def = getAlertEventDef('order.placed')
    expect(def?.label).toBe('New order placed')
  })
  it('returns null for an unknown key', () => {
    expect(getAlertEventDef('orders.nope')).toBeNull()
  })
})

describe('resolvePreference', () => {
  it('returns the stored preference when present', () => {
    const p = resolvePreference({ via_email: false, via_inapp: true }, 'order.placed')
    expect(p).toEqual({ via_email: false, via_inapp: true })
  })
  it('falls back to catalog default when no row', () => {
    const p = resolvePreference(null, 'order.payment_failed')
    // payment_failed defaults: email true, inapp true
    expect(p).toEqual({ via_email: true, via_inapp: true })
  })
  it('safe fallback for unknown event (via_inapp only)', () => {
    const p = resolvePreference(null, 'nothing.here')
    expect(p).toEqual({ via_email: false, via_inapp: true })
  })
  it('catalog default for low_stock: inapp only', () => {
    const p = resolvePreference(null, 'inventory.low_stock')
    expect(p).toEqual({ via_email: false, via_inapp: true })
  })
  it('2fa_disabled: both channels (critical)', () => {
    const p = resolvePreference(null, 'staff.2fa_disabled')
    expect(p).toEqual({ via_email: true, via_inapp: true })
  })
})
