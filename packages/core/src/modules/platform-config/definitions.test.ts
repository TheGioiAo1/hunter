/**
 * Tests for the platform config definitions (Phase 2 Step 2.5).
 */

import { describe, it, expect } from 'vitest'
import {
  PLATFORM_SETTING_DEFS,
  PLATFORM_SETTING_MAP,
  groupByCategory,
  coerceValue,
  validateValue,
  type PlatformSettingDef,
} from './definitions.js'

describe('PLATFORM_SETTING_DEFS', () => {
  it('ships exactly 12 settings (owner requirement)', () => {
    expect(PLATFORM_SETTING_DEFS.length).toBe(12)
  })

  it('every setting has a unique key', () => {
    const keys = PLATFORM_SETTING_DEFS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every setting has a category, label, help, default, kind', () => {
    for (const d of PLATFORM_SETTING_DEFS) {
      expect(d.category).toBeTruthy()
      expect(d.label).toBeTruthy()
      expect(d.help).toBeTruthy()
      expect(d.default).toBeDefined()
      expect(d.kind).toBeTruthy()
    }
  })

  it('every select setting has options', () => {
    for (const d of PLATFORM_SETTING_DEFS) {
      if (d.kind === 'select') {
        expect(d.options).toBeTruthy()
        expect(d.options!.length).toBeGreaterThan(0)
      }
    }
  })

  it('default value is one of the options for select kinds', () => {
    for (const d of PLATFORM_SETTING_DEFS) {
      if (d.kind === 'select' && d.options) {
        const values = d.options.map((o) => o.value)
        expect(values).toContain(d.default)
      }
    }
  })

  it('no Vietnamese locale is offered (market = US/EU)', () => {
    const localeDef = PLATFORM_SETTING_MAP['default_locale']
    const localeValues = localeDef.options!.map((o) => o.value)
    expect(localeValues).not.toContain('vi-VN')
    expect(localeValues).not.toContain('vi')
  })

  it('default_locale defaults to en-US and includes EU locales', () => {
    const def = PLATFORM_SETTING_MAP['default_locale']
    expect(def.default).toBe('en-US')
    const values = def.options!.map((o) => o.value)
    expect(values).toContain('en-US')
    expect(values).toContain('en-GB')
    expect(values).toContain('de-DE')
    expect(values).toContain('fr-FR')
    expect(values).toContain('es-ES')
  })

  it('default_currency defaults to USD', () => {
    expect(PLATFORM_SETTING_MAP['default_currency'].default).toBe('USD')
  })

  it('password_min_length defaults to 12 (stronger than OWASP min of 8)', () => {
    expect(PLATFORM_SETTING_MAP['password_min_length'].default).toBe(12)
  })

  it('maintenance_mode defaults to false', () => {
    expect(PLATFORM_SETTING_MAP['maintenance_mode'].default).toBe(false)
  })

  it('signup_enabled defaults to true', () => {
    expect(PLATFORM_SETTING_MAP['signup_enabled'].default).toBe(true)
  })
})

describe('PLATFORM_SETTING_MAP', () => {
  it('resolves every setting in the array to the same def', () => {
    for (const d of PLATFORM_SETTING_DEFS) {
      expect(PLATFORM_SETTING_MAP[d.key]).toBe(d)
    }
  })

  it('returns undefined for unknown keys', () => {
    expect(PLATFORM_SETTING_MAP['never_seen_before']).toBeUndefined()
  })
})

describe('groupByCategory', () => {
  it('returns a record keyed by category', () => {
    const grouped = groupByCategory()
    expect(grouped.Branding).toBeTruthy()
    expect(grouped.Regional).toBeTruthy()
    expect(grouped.Security).toBeTruthy()
    expect(grouped.Operations).toBeTruthy()
  })

  it('the union of all groups equals the full list', () => {
    const grouped = groupByCategory()
    const total = Object.values(grouped).reduce((a, b) => a + b.length, 0)
    expect(total).toBe(PLATFORM_SETTING_DEFS.length)
  })

  it('preserves declaration order inside each group', () => {
    const grouped = groupByCategory()
    // Branding: platform_name, platform_url, support_email
    expect(grouped.Branding.map((d) => d.key)).toEqual([
      'platform_name',
      'platform_url',
      'support_email',
    ])
  })
})

describe('coerceValue', () => {
  const numDef: PlatformSettingDef = {
    key: 'x',
    category: 'Operations',
    kind: 'number',
    label: 'X',
    help: 'x',
    default: 0,
  }
  const boolDef: PlatformSettingDef = {
    key: 'y',
    category: 'Operations',
    kind: 'boolean',
    label: 'Y',
    help: 'y',
    default: false,
  }
  const textDef: PlatformSettingDef = {
    key: 'z',
    category: 'Branding',
    kind: 'text',
    label: 'Z',
    help: 'z',
    default: '',
  }

  it('parses numeric strings', () => {
    expect(coerceValue(numDef, '42')).toBe(42)
    expect(coerceValue(numDef, '-7')).toBe(-7)
  })

  it('throws on non-numeric input for number kinds', () => {
    expect(() => coerceValue(numDef, 'hello')).toThrow(/not a number/)
  })

  it("treats 'on' as true (HTML checkbox convention)", () => {
    expect(coerceValue(boolDef, 'on')).toBe(true)
  })

  it("treats 'true' and '1' as true", () => {
    expect(coerceValue(boolDef, 'true')).toBe(true)
    expect(coerceValue(boolDef, '1')).toBe(true)
  })

  it("treats everything else as false", () => {
    expect(coerceValue(boolDef, 'off')).toBe(false)
    expect(coerceValue(boolDef, 'false')).toBe(false)
    expect(coerceValue(boolDef, '')).toBe(false)
    expect(coerceValue(boolDef, '0')).toBe(false)
  })

  it('passes strings through for text/email/url/select', () => {
    expect(coerceValue(textDef, 'Hello world')).toBe('Hello world')
  })
})

describe('validateValue', () => {
  it('passes when the value is valid', () => {
    const def = PLATFORM_SETTING_MAP['platform_name']
    expect(validateValue(def, 'Gbox Platform')).toBeNull()
  })

  it('rejects wrong type for number kinds', () => {
    const def = PLATFORM_SETTING_MAP['max_stores_per_user']
    expect(validateValue(def, 'not a number')).toMatch(/must be a number/)
  })

  it('rejects wrong type for boolean kinds', () => {
    const def = PLATFORM_SETTING_MAP['maintenance_mode']
    expect(validateValue(def, 'yes')).toMatch(/must be a boolean/)
  })

  it('rejects wrong type for text kinds', () => {
    const def = PLATFORM_SETTING_MAP['platform_name']
    expect(validateValue(def, 123)).toMatch(/must be a string/)
  })

  it('rejects empty platform name', () => {
    const def = PLATFORM_SETTING_MAP['platform_name']
    expect(validateValue(def, '')).toMatch(/required/)
    expect(validateValue(def, '   ')).toMatch(/required/)
  })

  it('rejects platform name over 64 chars', () => {
    const def = PLATFORM_SETTING_MAP['platform_name']
    expect(validateValue(def, 'a'.repeat(65))).toMatch(/64 characters/)
  })

  it('rejects invalid URLs', () => {
    const def = PLATFORM_SETTING_MAP['platform_url']
    expect(validateValue(def, 'not a url')).toMatch(/not a valid URL/)
  })

  it('rejects non-http/https URLs', () => {
    const def = PLATFORM_SETTING_MAP['platform_url']
    expect(validateValue(def, 'ftp://gbox.co')).toMatch(/http or https/)
  })

  it('accepts a valid https URL', () => {
    const def = PLATFORM_SETTING_MAP['platform_url']
    expect(validateValue(def, 'https://gbox.co')).toBeNull()
  })

  it('rejects invalid email addresses', () => {
    const def = PLATFORM_SETTING_MAP['support_email']
    expect(validateValue(def, 'not an email')).toMatch(/valid email/)
    expect(validateValue(def, 'no-at-sign.com')).toMatch(/valid email/)
  })

  it('accepts a valid email address', () => {
    const def = PLATFORM_SETTING_MAP['support_email']
    expect(validateValue(def, 'support@gbox.co')).toBeNull()
  })

  it('rejects password length below OWASP minimum of 8', () => {
    const def = PLATFORM_SETTING_MAP['password_min_length']
    expect(validateValue(def, 7)).toMatch(/at least 8/)
  })

  it('rejects password length above 128', () => {
    const def = PLATFORM_SETTING_MAP['password_min_length']
    expect(validateValue(def, 129)).toMatch(/128 or fewer/)
  })

  it('rejects non-integer password length', () => {
    const def = PLATFORM_SETTING_MAP['password_min_length']
    expect(validateValue(def, 12.5)).toMatch(/integer/)
  })

  it('rejects session timeout outside [1, 720]', () => {
    const def = PLATFORM_SETTING_MAP['session_timeout_hours']
    expect(validateValue(def, 0)).toMatch(/at least 1/)
    expect(validateValue(def, 721)).toMatch(/720 hours/)
  })

  it('rejects max_stores_per_user outside [1, 1000]', () => {
    const def = PLATFORM_SETTING_MAP['max_stores_per_user']
    expect(validateValue(def, 0)).toMatch(/at least 1/)
    expect(validateValue(def, 1001)).toMatch(/1000 or fewer/)
  })

  it('rejects select values that are not in the allowed list', () => {
    const def = PLATFORM_SETTING_MAP['default_locale']
    expect(validateValue(def, 'zh-CN')).toMatch(/must be one of/)
  })

  it('accepts select values that are in the allowed list', () => {
    const def = PLATFORM_SETTING_MAP['default_locale']
    expect(validateValue(def, 'en-US')).toBeNull()
    expect(validateValue(def, 'de-DE')).toBeNull()
  })

  it('accepts boolean values for maintenance_mode', () => {
    const def = PLATFORM_SETTING_MAP['maintenance_mode']
    expect(validateValue(def, true)).toBeNull()
    expect(validateValue(def, false)).toBeNull()
  })
})
