/**
 * Gbox Platform — Storefront theme-config preloader
 *
 * Decision #1 Step 1.15f — Convenience helper that wires the
 * `theme-config/` parsers to a `TemplateLoader` and returns the
 * shape `StorefrontHandlerOptions.themeConfig` expects, so hosts
 * can build a router options bag in two lines:
 *
 *     const themeConfig = await prepareThemeConfig({
 *       loader: engine.loader,
 *       i18n,
 *       shopId: 'shop_acme',
 *     })
 *     const handler = createExpressStorefrontHandler({
 *       engine, datasource, themeConfig,
 *     })
 *
 * What this helper does:
 *
 *   1. Loads + parses `config/settings_schema.json` and
 *      `config/settings_data.json` via `loadThemeSettings`. The
 *      resolved drop becomes `themeConfig.settings`.
 *
 *   2. Walks `locales/` via `loadThemeLocales`, splitting each
 *      locale into storefront + schema flavors. The schema dicts
 *      become `themeConfig.schemaLocales`.
 *
 *   3. Pushes the storefront-flavor entries into the supplied
 *      `I18nService` via `applyThemeLocalesToI18n` (per Q3:
 *      theme i18n flows through the existing platform i18n
 *      service, NOT a parallel bundle system). The schema dicts
 *      stay OUT of the i18n service so a typo in a schema key
 *      never silently resolves against a storefront key.
 *
 *   4. Records the default locale (from `<locale>.default.json`)
 *      so the router can fall back to it when the visitor's
 *      negotiated locale isn't in the bundle.
 *
 *   5. Aggregates warnings from both loaders into a single array
 *      so the host can surface them to a startup log without
 *      digging through two result objects.
 *
 * Failures are non-fatal: a missing `settings_schema.json`,
 * missing `locales/`, or broken individual files all degrade
 * gracefully into "no theme config" rather than throwing. Only
 * a malformed schema (which is unrecoverable) re-throws — the
 * theme is fundamentally broken in that case and the host should
 * surface the deploy failure loudly.
 */

import type { I18nService } from '../../../i18n/index.js'
import type { TemplateLoader } from '../loader.js'
import {
  applyThemeLocalesToI18n,
  loadThemeLocales,
  loadThemeSettings,
  type ResolvedThemeSettings,
  type ThemeLocaleDict,
} from '../theme-config/index.js'
import type { StorefrontThemeConfig } from './types.js'

/**
 * Input bag for `prepareThemeConfig`. The `i18n` + `shopId` pair is
 * optional — when omitted, storefront strings still get parsed but
 * are NOT pushed into any i18n service (callers can do this
 * themselves later, or skip it for tests).
 */
export interface PrepareThemeConfigOptions {
  /** Template loader pointing at the theme tree on disk. */
  loader: TemplateLoader
  /**
   * I18n service to seed with storefront-flavor locale strings.
   * Optional — omit when tests/dev don't need the t filter to work.
   */
  i18n?: I18nService
  /**
   * Shop id to scope `i18n.setMany` calls. Required when `i18n` is
   * supplied; ignored otherwise.
   */
  shopId?: string
}

/**
 * Result of `prepareThemeConfig`. Contains the bag the router
 * options accept (`themeConfig`) plus the unflattened diagnostic
 * fields hosts may want to log (warnings, raw schema dicts, etc.).
 */
export interface PrepareThemeConfigResult {
  /**
   * The bag to plug into `StorefrontHandlerOptions.themeConfig`.
   * Always present, even when every loader returned empty.
   */
  themeConfig: StorefrontThemeConfig
  /**
   * Resolved theme settings drop. Same reference as
   * `themeConfig.settings`. Null when `settings_schema.json` is
   * missing.
   */
  settings: ResolvedThemeSettings | null
  /** Default locale tag detected from `<locale>.default.json`, or null. */
  defaultLocale: string | null
  /**
   * Per-locale schema dictionaries. Same reference as
   * `themeConfig.schemaLocales`. Empty when no `locales/*.schema.json`
   * files were found.
   */
  schemaLocales: Record<string, ThemeLocaleDict>
  /**
   * Aggregate of warnings from both the settings loader and the
   * locale loader. Non-fatal — surface to a startup log.
   */
  warnings: string[]
}

/**
 * Load + parse + resolve every theme-level config file from a
 * `TemplateLoader`. See file header for the full behaviour contract.
 *
 * Call this ONCE per theme deploy at handler startup. Settings rarely
 * change between deploys, so re-reading on every request would just
 * be cache thrash for no benefit.
 */
export async function prepareThemeConfig(
  opts: PrepareThemeConfigOptions,
): Promise<PrepareThemeConfigResult> {
  const warnings: string[] = []

  // ---- 1. Theme settings (settings_schema + settings_data) -------------
  const settingsResult = await loadThemeSettings(opts.loader)
  warnings.push(...settingsResult.warnings)
  const settings = settingsResult.schema === null ? null : settingsResult.settings

  // ---- 2. Theme locales -------------------------------------------------
  const localesResult = await loadThemeLocales(opts.loader)
  warnings.push(...localesResult.warnings)

  // Build the schemaLocales map by extracting the schema flavor of
  // each entry. We keep the storefront flavor for the i18n adapter
  // call below, but the router never needs it directly — once it's
  // in the i18n service, the `t` filter handles lookups.
  const schemaLocales: Record<string, ThemeLocaleDict> = {}
  for (const [locale, entry] of Object.entries(localesResult.byLocale)) {
    if (Object.keys(entry.schema).length > 0) {
      schemaLocales[locale] = entry.schema
    }
  }

  // ---- 3. Push storefront strings into the platform i18n service -------
  // Per Q3: theme locale files flow through the SAME I18nService the
  // rest of the platform uses. We never build a parallel bundle.
  if (opts.i18n && opts.shopId) {
    await applyThemeLocalesToI18n(opts.i18n, opts.shopId, localesResult)
  } else if (opts.i18n && !opts.shopId) {
    warnings.push(
      '[gbox-engine] prepareThemeConfig: i18n supplied without shopId — storefront strings NOT pushed',
    )
  }

  // ---- 4. Build the router options bag ---------------------------------
  const themeConfig: StorefrontThemeConfig = {
    settings: settings ?? undefined,
    schemaLocales: Object.keys(schemaLocales).length > 0 ? schemaLocales : undefined,
    defaultSchemaLocale: localesResult.defaultLocale,
  }

  return {
    themeConfig,
    settings,
    defaultLocale: localesResult.defaultLocale,
    schemaLocales,
    warnings,
  }
}
