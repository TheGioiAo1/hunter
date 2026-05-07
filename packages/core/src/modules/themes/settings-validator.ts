/**
 * Gbox Platform — Theme settings validator (Stage 5.1)
 *
 * The gate the admin UI calls before persisting a merchant's
 * theme-customizer values. Given:
 *
 *   • the theme's `settings_schema.json` (already parsed into a
 *     `ThemeSettingsSchema` by `@gbox/core/modules/themes/engine/
 *     theme-config/settings.js`), and
 *   • a flat `overrides` map (`{ color_primary: '#ff8800', ... }`)
 *     the merchant just typed into the form,
 *
 * it walks every value-bearing entry in the schema and produces
 * either:
 *
 *   { ok: true,  cleaned: ResolvedThemeSettings }
 *   { ok: false, errors: ThemeSettingsValidationError[] }
 *
 * The validator DOES coerce values (string `"7"` → number `7`,
 * `"#F60"` → `"#ff6600"`), because that's how the admin form looks
 * — HTML form inputs always ship strings. Callers get the canonical
 * values back in `cleaned`, not the raw submission.
 *
 * Why not collapse this into `resolveThemeSettings`? Because the
 * resolver is meant to be FORGIVING — it's used at render time and
 * must never 500 a storefront over a minor typo. This validator is
 * STRICT — it's used at WRITE time and must refuse to persist
 * garbage. Same data, different gates.
 */

import {
  NON_VALUE_SETTING_TYPES,
  type SchemaSetting,
} from './engine/schema/types.js'
import type {
  ThemeSettingsSchema,
  ResolvedThemeSettings,
} from './engine/theme-config/settings.js'
import { THEME_INFO_SECTION_NAME } from './engine/theme-config/settings.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ThemeSettingsErrorCode =
  | 'invalid_payload'
  | 'invalid_color'
  | 'invalid_number'
  | 'out_of_range'
  | 'invalid_option'
  | 'invalid_url'
  | 'too_long'
  | 'invalid_boolean'

export interface ThemeSettingsValidationError {
  /** Setting id, or `""` for top-level errors. */
  path: string
  code: ThemeSettingsErrorCode
  message: string
}

export type ThemeSettingsValidationResult =
  | { ok: true; cleaned: ResolvedThemeSettings }
  | { ok: false; errors: ThemeSettingsValidationError[] }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 10 KiB cap on any text-ish field. Merchants complaining means
 * someone is pasting a novel into an alt-text box. */
const MAX_TEXT_LEN = 10 * 1024

/** URL protocols the validator will allow. `javascript:` is the
 * reason this list exists. */
const ALLOWED_URL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
  // Relative URLs are handled separately.
])

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validateThemeSettings(
  schema: ThemeSettingsSchema,
  overrides: unknown,
): ThemeSettingsValidationResult {
  if (
    !overrides ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides)
  ) {
    return {
      ok: false,
      errors: [
        {
          path: '',
          code: 'invalid_payload',
          message: 'overrides must be a flat object',
        },
      ],
    }
  }

  const src = overrides as Record<string, unknown>
  const cleaned: ResolvedThemeSettings = {}
  const errors: ThemeSettingsValidationError[] = []

  for (const section of schema) {
    if (section.name === THEME_INFO_SECTION_NAME) continue
    for (const item of section.settings) {
      const type = typeof item.type === 'string' ? item.type : ''
      if (
        NON_VALUE_SETTING_TYPES.has(type as 'header' | 'paragraph')
      ) {
        continue
      }
      const id = typeof item.id === 'string' ? item.id : ''
      if (!id) continue

      const hasOverride = Object.prototype.hasOwnProperty.call(src, id)
      if (!hasOverride) {
        // Fall back to the schema default or the type fallback.
        if (Object.prototype.hasOwnProperty.call(item, 'default')) {
          cleaned[id] = item.default
        }
        continue
      }

      const raw = src[id]
      const res = validateOne(type, item, id, raw)
      if (res.ok) {
        cleaned[id] = res.value
      } else {
        errors.push(...res.errors)
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, cleaned }
}

// ---------------------------------------------------------------------------
// Per-setting validation
// ---------------------------------------------------------------------------

type OneResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: ThemeSettingsValidationError[] }

function validateOne(
  type: string,
  item: SchemaSetting,
  id: string,
  raw: unknown,
): OneResult {
  switch (type) {
    case 'color':
    case 'color_background': {
      const hex = normaliseHexColor(raw)
      if (hex === null) {
        return err(
          id,
          'invalid_color',
          `expected #rrggbb, got ${describe(raw)}`,
        )
      }
      return ok(hex)
    }

    case 'number':
    case 'range': {
      const n = coerceNumber(raw)
      if (n === null) {
        return err(
          id,
          'invalid_number',
          `expected a number, got ${describe(raw)}`,
        )
      }
      const min = typeof item.min === 'number' ? item.min : null
      const max = typeof item.max === 'number' ? item.max : null
      if ((min !== null && n < min) || (max !== null && n > max)) {
        return err(
          id,
          'out_of_range',
          `expected ${min ?? '-∞'}..${max ?? '+∞'}, got ${n}`,
        )
      }
      return ok(n)
    }

    case 'checkbox': {
      const b = coerceBoolean(raw)
      if (b === null) {
        return err(
          id,
          'invalid_boolean',
          `expected true/false, got ${describe(raw)}`,
        )
      }
      return ok(b)
    }

    case 'select':
    case 'radio': {
      const options = Array.isArray(item.options) ? item.options : []
      const values = options
        .map((o) => (typeof o?.value === 'string' ? o.value : null))
        .filter((v): v is string => v !== null)
      const value = typeof raw === 'string' ? raw : String(raw ?? '')
      if (!values.includes(value)) {
        return err(
          id,
          'invalid_option',
          `${describe(raw)} is not one of [${values.join(', ')}]`,
        )
      }
      return ok(value)
    }

    case 'url': {
      if (raw === '' || raw === null || raw === undefined) return ok('')
      if (typeof raw !== 'string') {
        return err(id, 'invalid_url', `expected a URL string, got ${describe(raw)}`)
      }
      if (raw.startsWith('/')) return ok(raw) // site-relative
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        return err(id, 'invalid_url', `not a valid URL: ${describe(raw)}`)
      }
      if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
        return err(
          id,
          'invalid_url',
          `protocol ${parsed.protocol} is not allowed`,
        )
      }
      return ok(parsed.toString())
    }

    case 'text':
    case 'textarea':
    case 'richtext':
    case 'html':
    case 'inline_richtext':
    case 'liquid': {
      const s = typeof raw === 'string' ? raw : String(raw ?? '')
      if (s.length > MAX_TEXT_LEN) {
        return err(
          id,
          'too_long',
          `expected ≤ ${MAX_TEXT_LEN} chars, got ${s.length}`,
        )
      }
      return ok(s)
    }

    // Picker + list types — we don't own the source of truth (the
    // admin UI hands us ids it already resolved). Pass them through
    // unchanged; downstream code will reject stale ids at render
    // time.
    default:
      return ok(raw)
  }
}

// ---------------------------------------------------------------------------
// Primitive coercers
// ---------------------------------------------------------------------------

/**
 * Normalise any accepted color spelling to a canonical lowercase
 * `#rrggbb`. Returns `null` when the input isn't a color.
 *
 * Accepted inputs:
 *   - `#rgb`   / `#RGB`
 *   - `#rrggbb` / `#RRGGBB`
 *   - leading `#` is required — bare `ff8800` is rejected so we
 *     never mistake arbitrary hex-like strings for colors.
 */
export function normaliseHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed.startsWith('#')) return null
  const hex = trimmed.slice(1)
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return '#' + hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return '#' + hex
  }
  return null
}

function coerceNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return null
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  return null
}

function coerceBoolean(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  if (raw === 'true' || raw === '1' || raw === 1) return true
  if (raw === 'false' || raw === '0' || raw === 0) return false
  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(value: unknown): OneResult {
  return { ok: true, value }
}

function err(
  path: string,
  code: ThemeSettingsErrorCode,
  message: string,
): OneResult {
  return { ok: false, errors: [{ path, code, message }] }
}

function describe(raw: unknown): string {
  if (raw === null) return 'null'
  if (raw === undefined) return 'undefined'
  if (typeof raw === 'string') return `'${raw.slice(0, 40)}'`
  return String(raw)
}
