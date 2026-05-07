/**
 * Gbox Platform — Theme Settings loader
 *
 * Decision #1 Step 1.15 — Convenience function that wires the
 * `TemplateLoader` to the settings parser + resolver. Single call,
 * one result, never throws on missing files (a brand-new theme
 * without `settings_data.json` is a normal state).
 *
 * Why a separate file from `settings.ts`? The parser is pure +
 * sync; the loader is async + I/O bound. Keeping them apart means
 * unit tests for the parser don't have to set up a fake loader.
 */

import type { TemplateLoader } from '../loader.js'
import {
  parseThemeSettingsData,
  parseThemeSettingsSchema,
  resolveThemeSettings,
  ThemeSettingsParseError,
  type ResolvedThemeSettings,
  type ThemeSettingsSchema,
  type ThemeSettingsData,
} from './settings.js'

/**
 * Result of `loadThemeSettings`. Always returns a value — fields
 * are explicitly nullable for the missing-file cases so callers can
 * decide whether to surface a warning.
 */
export interface LoadThemeSettingsResult {
  /** Resolved drop ready for `{{ settings.* }}`. Empty when no schema. */
  settings: ResolvedThemeSettings
  /** Parsed schema, or null when `settings_schema.json` is missing. */
  schema: ThemeSettingsSchema | null
  /** Parsed data, or null when `settings_data.json` is missing/broken. */
  data: ThemeSettingsData | null
  /** Non-fatal issues (missing data file, malformed JSON, …). */
  warnings: string[]
}

/** Default location for the schema file. */
export const SETTINGS_SCHEMA_PATH = 'config/settings_schema.json'

/** Default location for the values file. */
export const SETTINGS_DATA_PATH = 'config/settings_data.json'

/**
 * Load + parse + resolve theme settings from a `TemplateLoader`.
 *
 * Behaviour matrix:
 *
 *   schema | data    | result
 *   -------|---------|------------------------------
 *   missing| any     | empty drop, warning
 *   present| missing | schema defaults, no warning
 *   present| broken  | schema defaults, warning
 *   present| present | resolved drop, possibly warnings
 *
 * The router (Step 1.14) calls this once at handler init and caches
 * the result for the life of the handler — settings rarely change
 * between deploys, so we don't re-read on every request.
 */
export async function loadThemeSettings(
  loader: TemplateLoader,
): Promise<LoadThemeSettingsResult> {
  const warnings: string[] = []

  // 1. Load + parse the schema.
  const schemaSrc = await loader.load(SETTINGS_SCHEMA_PATH)
  if (schemaSrc === null) {
    warnings.push(
      `[gbox-engine] ${SETTINGS_SCHEMA_PATH} not found — settings drop will be empty`,
    )
    return { settings: {}, schema: null, data: null, warnings }
  }
  let schema: ThemeSettingsSchema
  try {
    schema = parseThemeSettingsSchema(schemaSrc, SETTINGS_SCHEMA_PATH)
  } catch (err) {
    // A broken schema is a hard error — without a schema we can't
    // even build defaults, and the theme is fundamentally broken.
    // Re-throw so the deploy step can fail loudly.
    throw err instanceof ThemeSettingsParseError
      ? err
      : new ThemeSettingsParseError(
          `[gbox-engine] ${SETTINGS_SCHEMA_PATH}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
  }

  // 2. Load + parse the data file. Both missing and broken paths
  //    fall back to schema defaults — we never throw here.
  const dataSrc = await loader.load(SETTINGS_DATA_PATH)
  let data: ThemeSettingsData | null = null
  if (dataSrc !== null) {
    try {
      data = parseThemeSettingsData(dataSrc, SETTINGS_DATA_PATH)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(
        `[gbox-engine] ${SETTINGS_DATA_PATH} could not be parsed (${msg}) — falling back to schema defaults`,
      )
      data = null
    }
  }

  // 3. Resolve.
  const result = resolveThemeSettings(schema, data ?? undefined)
  warnings.push(...result.warnings)
  return {
    settings: result.settings,
    schema,
    data,
    warnings,
  }
}
