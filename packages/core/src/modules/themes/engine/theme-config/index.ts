/**
 * Gbox Platform — Theme config module entry point
 *
 * Decision #1 Step 1.15 — Re-exports the parsers, loaders, and
 * resolvers for `config/settings_schema.json`,
 * `config/settings_data.json`, and the theme-level `locales/`
 * directory. The engine's top-level `index.ts` re-exports from here
 * in turn, so consumers can `import { loadThemeSettings } from
 * '@gbox/core/.../engine'` without reaching into sub-folders.
 */

export {
  parseThemeSettingsSchema,
  parseThemeSettingsData,
  resolveThemeSettings,
  ThemeSettingsParseError,
  THEME_INFO_SECTION_NAME,
  type ThemeSettingsSchema,
  type ThemeSettingsSchemaSection,
  type ThemeSettingsData,
  type ResolvedThemeSettings,
  type ThemeSettingsResolveResult,
} from './settings.js'

export {
  loadThemeSettings,
  SETTINGS_SCHEMA_PATH,
  SETTINGS_DATA_PATH,
  type LoadThemeSettingsResult,
} from './settings-loader.js'

export {
  loadThemeLocales,
  applyThemeLocalesToI18n,
  parseThemeLocaleFile,
  parseLocaleFileName,
  flattenLocaleTree,
  resolveSchemaTranslations,
  THEME_LOCALES_DIR,
  type ThemeLocaleDict,
  type ThemeLocaleEntry,
  type LoadThemeLocalesResult,
} from './theme-locale.js'
