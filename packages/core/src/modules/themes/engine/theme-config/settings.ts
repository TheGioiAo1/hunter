/**
 * Gbox Platform — Theme Settings parser + resolver
 *
 * Decision #1 Step 1.15 — Shopify themes ship two config files in
 * `config/`:
 *
 *   - `settings_schema.json` — declarative schema for the theme
 *     customizer. Array of "section" objects, each with `name` and
 *     `settings[]`. The first entry is `theme_info` and contains
 *     metadata about the theme version (skipped at resolve time).
 *
 *   - `settings_data.json` — current values, either as a named
 *     preset reference or an inline object. Two formats are accepted:
 *
 *     Format A (preset reference):
 *       { "current": "Default", "presets": { "Default": {...} } }
 *
 *     Format B (inline object):
 *       { "current": { "color_primary": "#000" }, "presets": {...} }
 *
 *     Format C (no current at all — just presets):
 *       { "presets": { "Default": {...} } }
 *
 * Resolution chain (highest → lowest):
 *
 *   1. `current` object values        (Format B)
 *   2. preset values when `current`   (Format A)
 *      is a preset name string
 *   3. `default` from schema entry
 *   4. `typeFallbackDefault(type)`    — built-in
 *
 * Failure modes (silent fallback per Shopify behavior):
 *
 *   - `current` is a preset name that doesn't exist in `presets`
 *     → falls back to schema defaults; logged as a warning.
 *   - `settings_data.json` is malformed JSON → caller's parse step
 *     handles it (we throw a clear error), but the loader catches
 *     it and falls back to defaults.
 *   - A setting key in `current` references an id that's no longer
 *     in the schema → silently ignored. Same as Shopify when a
 *     theme version drops a setting.
 *
 * Why share `SchemaSetting` / `typeFallbackDefault` from schema/types?
 *
 *   The setting shape is identical to section settings — same `type`,
 *   `default`, `id`, etc. Re-using the same types means the same
 *   `t:foo.bar` schema-translation pass works for both theme settings
 *   and section settings (Step 1.15d).
 */

import {
  NON_VALUE_SETTING_TYPES,
  typeFallbackDefault,
  type SchemaSetting,
} from '../schema/types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One section in `settings_schema.json`. Top-level array entry.
 * `theme_info` is a special name reserved for the theme metadata
 * entry that we filter out at resolve time.
 */
export interface ThemeSettingsSchemaSection {
  /** Section heading shown in the customizer sidebar. */
  name: string
  /** Settings inside this section. */
  settings: SchemaSetting[]
  /** Pass-through for any other fields (icons, theme_info metadata). */
  [extra: string]: unknown
}

/**
 * The full parsed `settings_schema.json` content. Always an array;
 * `theme_info` (if present) lives at index 0 and is filtered out at
 * resolve time.
 */
export type ThemeSettingsSchema = ThemeSettingsSchemaSection[]

/**
 * The parsed `settings_data.json` content. All fields are optional
 * because Shopify accepts any of the three valid shapes (see file
 * header).
 */
export interface ThemeSettingsData {
  /**
   * Either a preset name (string lookup into `presets`) or an inline
   * object of values (preset-less form). Missing means "use the
   * first preset, or schema defaults if no presets".
   */
  current?: string | Record<string, unknown>
  /**
   * Named presets the customizer can switch between. Each preset is
   * a flat key→value object, NOT nested by section.
   */
  presets?: Record<string, Record<string, unknown>>
  /** Pass-through for editor metadata (`platform_customizations`, etc.). */
  [extra: string]: unknown
}

/**
 * The fully-resolved theme settings drop. Flat object the engine
 * exposes as `{{ settings.foo }}` in Liquid templates.
 *
 * Keys come from `schema.settings[].id` for every value-bearing
 * setting type (filters out `header` / `paragraph` separators).
 */
export type ResolvedThemeSettings = Record<string, unknown>

/**
 * Diagnostic returned alongside the resolved drop. Lets the loader
 * surface warnings about malformed settings_data so ops can fix
 * them, without ever 500'ing the request.
 */
export interface ThemeSettingsResolveResult {
  /** The flat drop ready for `{{ settings.* }}`. */
  settings: ResolvedThemeSettings
  /** Non-fatal issues encountered during resolution. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Thrown by the parsers below for unrecoverable JSON errors. */
export class ThemeSettingsParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ThemeSettingsParseError'
  }
}

/**
 * Parse the JSON source of `settings_schema.json` into a typed
 * array. Throws on malformed JSON or wrong top-level shape (must be
 * an array).
 *
 * Forwards-compat: unknown setting types are accepted as-is — the
 * resolver uses `typeFallbackDefault()` which handles unknown types.
 */
export function parseThemeSettingsSchema(
  source: string,
  fileName = 'config/settings_schema.json',
): ThemeSettingsSchema {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ThemeSettingsParseError(
      `[gbox-engine] ${fileName}: invalid JSON — ${msg}`,
    )
  }
  if (!Array.isArray(raw)) {
    throw new ThemeSettingsParseError(
      `[gbox-engine] ${fileName}: top level must be an array (got ${typeof raw})`,
    )
  }
  // Coerce each entry into a `ThemeSettingsSchemaSection`. We're
  // permissive — anything missing `settings` becomes an empty list,
  // anything missing `name` keeps an empty string, so a slightly
  // broken file still resolves to schema defaults instead of 500ing.
  const out: ThemeSettingsSchema = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : ''
    const settings = Array.isArray(obj.settings)
      ? (obj.settings as SchemaSetting[])
      : []
    out.push({ ...obj, name, settings })
  }
  return out
}

/**
 * Parse the JSON source of `settings_data.json` into a typed object.
 * Throws on malformed JSON; loaders can catch + fall back to schema
 * defaults.
 */
export function parseThemeSettingsData(
  source: string,
  fileName = 'config/settings_data.json',
): ThemeSettingsData {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ThemeSettingsParseError(
      `[gbox-engine] ${fileName}: invalid JSON — ${msg}`,
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ThemeSettingsParseError(
      `[gbox-engine] ${fileName}: top level must be an object`,
    )
  }
  // The shape is duck-typed — we accept any object that vaguely
  // looks like settings_data. Field validation happens in resolve.
  return raw as ThemeSettingsData
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Theme metadata section name. Shopify uses this exact string in
 * `settings_schema.json`'s first entry. We filter it out so its
 * fields don't pollute the resolved drop.
 */
export const THEME_INFO_SECTION_NAME = 'theme_info'

/**
 * Build the resolved `settings` drop by walking every section in
 * the schema, picking the value from the data layer (or falling
 * back to defaults).
 *
 * `data` may be `undefined` (no settings_data.json on disk) — in
 * which case the result is just the schema defaults. This is the
 * happy path for tests + brand-new themes.
 */
export function resolveThemeSettings(
  schema: ThemeSettingsSchema,
  data?: ThemeSettingsData,
): ThemeSettingsResolveResult {
  const warnings: string[] = []

  // 1. Pick the override map from the data layer.
  const overrides = pickOverrides(data, warnings)

  // 2. Walk every section in the schema (skip theme_info), then
  //    every value-bearing setting inside.
  const out: ResolvedThemeSettings = {}
  for (const section of schema) {
    if (section.name === THEME_INFO_SECTION_NAME) continue
    for (const item of section.settings) {
      const type = typeof item.type === 'string' ? item.type : ''
      // Layout-only entries never produce a value.
      if (NON_VALUE_SETTING_TYPES.has(type as 'header' | 'paragraph')) continue
      const id = item.id
      if (typeof id !== 'string' || !id) continue
      out[id] = pickSettingValue(type, item, overrides, id)
    }
  }
  return { settings: out, warnings }
}

/**
 * Pick the appropriate override map from `settings_data.json`.
 * Three forms:
 *
 *   1. data.current is an object → use it directly (Format B).
 *   2. data.current is a string → look up data.presets[current]
 *      (Format A). Missing preset → empty + warning.
 *   3. data.current is missing  → use empty (Format C / no data).
 *
 * Returns an empty object on every fallback path, so resolution
 * cleanly drops back to schema defaults.
 */
function pickOverrides(
  data: ThemeSettingsData | undefined,
  warnings: string[],
): Record<string, unknown> {
  if (!data) return {}
  const current = data.current
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>
  }
  if (typeof current === 'string') {
    const preset = data.presets?.[current]
    if (preset && typeof preset === 'object' && !Array.isArray(preset)) {
      return preset as Record<string, unknown>
    }
    warnings.push(
      `[gbox-engine] settings_data.json: current preset "${current}" not found in presets — falling back to schema defaults`,
    )
    return {}
  }
  return {}
}

/**
 * Pick the final value for one setting entry.
 *
 * Precedence: override → schema default → type fallback. Same logic
 * as the section schema resolver, but kept separate so the two can
 * evolve independently (theme settings could grow types section
 * settings don't, and vice versa).
 *
 * Note: an explicit `null` in the override IS honored (Shopify
 * treats null as "cleared"). The `hasOwn` check is intentional.
 */
function pickSettingValue(
  type: string,
  item: SchemaSetting,
  overrides: Record<string, unknown>,
  id: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id]
  }
  if (Object.prototype.hasOwnProperty.call(item, 'default')) {
    return item.default
  }
  return typeFallbackDefault(type)
}
