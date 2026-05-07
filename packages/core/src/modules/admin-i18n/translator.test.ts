/**
 * Tests for the admin translator + interpolation (Phase 2 Step 2.10).
 */

import { describe, it, expect } from 'vitest'
import {
  createTranslator,
  interpolateAdmin,
  isAdminLocale,
  coerceAdminLocale,
} from './translator.js'
import { ADMIN_LOCALES, ADMIN_LOCALE_DICTS } from './index.js'
import type { AdminMessageKey } from './types.js'

// ---------------------------------------------------------------------------
// interpolateAdmin
// ---------------------------------------------------------------------------

describe('interpolateAdmin', () => {
  it('returns the template unchanged when no vars', () => {
    expect(interpolateAdmin('Hello', undefined)).toBe('Hello')
    expect(interpolateAdmin('No braces here', {})).toBe('No braces here')
  })

  it('replaces {name} tokens', () => {
    expect(interpolateAdmin('Hello {name}', { name: 'Alice' })).toBe(
      'Hello Alice',
    )
  })

  it('replaces multiple tokens', () => {
    expect(
      interpolateAdmin('{greeting}, {name}!', {
        greeting: 'Hi',
        name: 'Bob',
      }),
    ).toBe('Hi, Bob!')
  })

  it('coerces numbers to strings', () => {
    expect(interpolateAdmin('Count: {n}', { n: 42 })).toBe('Count: 42')
  })

  it('leaves unknown tokens as literals (Shopify behavior)', () => {
    expect(interpolateAdmin('Hi {name}', { other: 'x' })).toBe('Hi {name}')
  })

  it('short-circuits when there are no braces at all', () => {
    expect(interpolateAdmin('flat text', { a: '1' })).toBe('flat text')
  })

  it('does not match double-brace Liquid syntax', () => {
    // {{ name }} has an outer brace matched as `{{` which doesn't
    // fit /\{(\w+)\}/ — so it's left alone.
    expect(interpolateAdmin('Hi {{ name }}', { name: 'x' })).toBe(
      'Hi {{ name }}',
    )
  })
})

// ---------------------------------------------------------------------------
// isAdminLocale / coerceAdminLocale
// ---------------------------------------------------------------------------

describe('isAdminLocale', () => {
  it('accepts supported locales', () => {
    expect(isAdminLocale('en-US')).toBe(true)
    expect(isAdminLocale('de-DE')).toBe(true)
    expect(isAdminLocale('fr-FR')).toBe(true)
    expect(isAdminLocale('es-ES')).toBe(true)
    expect(isAdminLocale('en-GB')).toBe(true)
  })

  it('rejects unsupported locales', () => {
    expect(isAdminLocale('vi-VN')).toBe(false) // Iron Rule — NO Vietnamese
    expect(isAdminLocale('ja-JP')).toBe(false)
    expect(isAdminLocale('en')).toBe(false) // bare tag not acceptable
    expect(isAdminLocale('EN-US')).toBe(false) // case-sensitive
  })

  it('rejects non-strings', () => {
    expect(isAdminLocale(null)).toBe(false)
    expect(isAdminLocale(undefined)).toBe(false)
    expect(isAdminLocale(42)).toBe(false)
    expect(isAdminLocale({})).toBe(false)
  })
})

describe('coerceAdminLocale', () => {
  it('passes through supported values', () => {
    expect(coerceAdminLocale('de-DE')).toBe('de-DE')
  })

  it('returns the default for unsupported values', () => {
    expect(coerceAdminLocale('vi-VN')).toBe('en-US')
    expect(coerceAdminLocale(null)).toBe('en-US')
    expect(coerceAdminLocale(undefined)).toBe('en-US')
  })
})

// ---------------------------------------------------------------------------
// createTranslator
// ---------------------------------------------------------------------------

describe('createTranslator', () => {
  it('returns en-US strings when locale is en-US', () => {
    const t = createTranslator('en-US')
    expect(t('nav.dashboard')).toBe('Dashboard')
    expect(t('button.save')).toBe('Save')
  })

  it('returns German strings for de-DE', () => {
    const t = createTranslator('de-DE')
    expect(t('nav.dashboard')).toBe('Übersicht')
    expect(t('button.save')).toBe('Speichern')
    expect(t('button.sign_out')).toBe('Abmelden')
  })

  it('returns French strings for fr-FR', () => {
    const t = createTranslator('fr-FR')
    expect(t('nav.dashboard')).toBe('Tableau de bord')
    expect(t('button.cancel')).toBe('Annuler')
  })

  it('returns Spanish strings for es-ES', () => {
    const t = createTranslator('es-ES')
    expect(t('nav.dashboard')).toBe('Panel')
    expect(t('button.delete')).toBe('Eliminar')
  })

  it('interpolates vars using {name} syntax', () => {
    const t = createTranslator('en-US')
    expect(t('form.required', { field: 'Email' })).toBe('Email is required')
    expect(t('form.too_short', { field: 'Password', min: 8 })).toBe(
      'Password must be at least 8 characters',
    )
  })

  it('interpolates into a German template', () => {
    const t = createTranslator('de-DE')
    expect(t('form.required', { field: 'E-Mail' })).toBe(
      'E-Mail ist erforderlich',
    )
  })
})

// ---------------------------------------------------------------------------
// Dictionary integrity (every locale ships every key)
// ---------------------------------------------------------------------------

describe('locale dictionaries', () => {
  const baseline = ADMIN_LOCALE_DICTS['en-US']
  const baselineKeys = Object.keys(baseline) as AdminMessageKey[]

  for (const locale of ADMIN_LOCALES) {
    it(`[${locale}] defines every key in the baseline`, () => {
      const dict = ADMIN_LOCALE_DICTS[locale]
      for (const key of baselineKeys) {
        expect(dict[key], `missing key ${key}`).toBeDefined()
        expect(typeof dict[key]).toBe('string')
        expect(dict[key].length).toBeGreaterThan(0)
      }
    })
  }

  it('does not ship any Vietnamese locale', () => {
    expect(ADMIN_LOCALES).not.toContain('vi-VN')
    expect(ADMIN_LOCALES).not.toContain('vi')
  })

  it('includes exactly 5 locales (en-US, en-GB, de-DE, fr-FR, es-ES)', () => {
    expect(ADMIN_LOCALES).toHaveLength(5)
    expect(new Set(ADMIN_LOCALES)).toEqual(
      new Set(['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES']),
    )
  })
})
