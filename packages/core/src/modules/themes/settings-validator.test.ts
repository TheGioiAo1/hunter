/**
 * Gbox Platform — Theme settings validator tests (Stage 5.1)
 *
 * The validator is the gate the admin UI uses before saving a
 * merchant's theme settings. It takes a `ThemeSettingsSchema` (the
 * theme's own declaration from `settings_schema.json`) and a
 * candidate `overrides` map (flat id → value), and returns either
 *
 *   { ok: true, cleaned }   — safe to persist (with coerced values)
 *
 * or
 *
 *   { ok: false, errors }   — with machine-readable reasons the
 *                             admin UI can map back to fields.
 *
 * Shape of an error:
 *
 *   { path: "color_primary",
 *     code: "invalid_color",
 *     message: "expected #rrggbb, got 'blue'" }
 *
 * Tests pin every rejection code + every coercion branch so a
 * silent regression turns red at review time.
 */

import { describe, it, expect } from 'vitest'
import {
  validateThemeSettings,
  type ThemeSettingsValidationError,
} from './settings-validator.js'
import type { ThemeSettingsSchema } from './engine/theme-config/settings.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const schema = (...overrides: unknown[]): ThemeSettingsSchema => [
  {
    name: 'General',
    settings: overrides as any,
  },
]

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('validateThemeSettings — happy paths', () => {
  it('accepts a valid color and normalises to lowercase #rrggbb', () => {
    const out = validateThemeSettings(
      schema({ id: 'c', type: 'color', default: '#000000' }),
      { c: '#FF8800' },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.cleaned.c).toBe('#ff8800')
  })

  it('normalises #abc shorthand to #aabbcc', () => {
    const out = validateThemeSettings(
      schema({ id: 'c', type: 'color' }),
      { c: '#F60' },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.cleaned.c).toBe('#ff6600')
  })

  it('accepts a number within range', () => {
    const out = validateThemeSettings(
      schema({ id: 'n', type: 'range', min: 0, max: 100, step: 1 }),
      { n: 42 },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.cleaned.n).toBe(42)
  })

  it('coerces a stringified number', () => {
    const out = validateThemeSettings(
      schema({ id: 'n', type: 'number' }),
      { n: '7' },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.cleaned.n).toBe(7)
  })

  it('accepts a valid select option', () => {
    const out = validateThemeSettings(
      schema({
        id: 's',
        type: 'select',
        options: [{ value: 'left' }, { value: 'right' }],
      }),
      { s: 'left' },
    )
    expect(out.ok).toBe(true)
  })

  it('accepts a checkbox boolean + coerces "true" / "false"', () => {
    const schemaIn = schema({ id: 'b', type: 'checkbox' })
    const a = validateThemeSettings(schemaIn, { b: true })
    const b = validateThemeSettings(schemaIn, { b: 'false' })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok) expect(a.cleaned.b).toBe(true)
    if (b.ok) expect(b.cleaned.b).toBe(false)
  })

  it('accepts a valid URL', () => {
    const out = validateThemeSettings(
      schema({ id: 'u', type: 'url' }),
      { u: 'https://gbox.co/about' },
    )
    expect(out.ok).toBe(true)
  })

  it('strips setting keys that are not in the schema', () => {
    const out = validateThemeSettings(
      schema({ id: 'known', type: 'text' }),
      { known: 'ok', unknown: 'junk' },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(Object.prototype.hasOwnProperty.call(out.cleaned, 'unknown')).toBe(false)
    expect(out.cleaned.known).toBe('ok')
  })

  it('falls back to schema defaults for missing keys', () => {
    const out = validateThemeSettings(
      schema(
        { id: 'a', type: 'text', default: 'hello' },
        { id: 'b', type: 'number', default: 5 },
      ),
      {},
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.cleaned.a).toBe('hello')
    expect(out.cleaned.b).toBe(5)
  })

  it('skips header + paragraph separators', () => {
    const out = validateThemeSettings(
      schema(
        { type: 'header', content: 'General' },
        { type: 'paragraph', content: 'info' },
        { id: 'c', type: 'color', default: '#000000' },
      ),
      { c: '#fff' },
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(Object.keys(out.cleaned)).toEqual(['c'])
  })
})

// ---------------------------------------------------------------------------
// Rejection paths
// ---------------------------------------------------------------------------

function codes(errors: ThemeSettingsValidationError[]): string[] {
  return errors.map((e) => `${e.path}:${e.code}`)
}

describe('validateThemeSettings — rejection paths', () => {
  it('rejects a non-color string with invalid_color', () => {
    const out = validateThemeSettings(
      schema({ id: 'c', type: 'color' }),
      { c: 'blue' },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('c:invalid_color')
  })

  it('rejects a number below min with out_of_range', () => {
    const out = validateThemeSettings(
      schema({ id: 'n', type: 'range', min: 10, max: 20 }),
      { n: 5 },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('n:out_of_range')
  })

  it('rejects a number above max with out_of_range', () => {
    const out = validateThemeSettings(
      schema({ id: 'n', type: 'range', min: 10, max: 20 }),
      { n: 99 },
    )
    expect(out.ok).toBe(false)
  })

  it('rejects a non-numeric number field with invalid_number', () => {
    const out = validateThemeSettings(
      schema({ id: 'n', type: 'number' }),
      { n: 'abc' },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('n:invalid_number')
  })

  it('rejects a select value that is not in the options with invalid_option', () => {
    const out = validateThemeSettings(
      schema({
        id: 's',
        type: 'select',
        options: [{ value: 'left' }, { value: 'right' }],
      }),
      { s: 'up' },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('s:invalid_option')
  })

  it('rejects a URL with an unsupported protocol with invalid_url', () => {
    const out = validateThemeSettings(
      schema({ id: 'u', type: 'url' }),
      { u: 'javascript:alert(1)' },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('u:invalid_url')
  })

  it('rejects oversized text (> 10 KiB) with too_long', () => {
    const big = 'x'.repeat(11 * 1024)
    const out = validateThemeSettings(
      schema({ id: 't', type: 'text' }),
      { t: big },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors)).toContain('t:too_long')
  })

  it('aggregates multiple errors in a single pass', () => {
    const out = validateThemeSettings(
      schema(
        { id: 'c', type: 'color' },
        { id: 'n', type: 'range', min: 0, max: 10 },
      ),
      { c: 'blue', n: 99 },
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(codes(out.errors).sort()).toEqual(['c:invalid_color', 'n:out_of_range'])
  })

  it('rejects when overrides is not an object', () => {
    const out = validateThemeSettings(
      schema({ id: 't', type: 'text' }),
      null as any,
    )
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.errors[0]!.code).toBe('invalid_payload')
  })
})
