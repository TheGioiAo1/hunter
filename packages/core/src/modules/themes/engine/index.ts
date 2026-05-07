/**
 * Gbox Platform — Theme Engine Module Entry Point
 *
 * Decision #1 — Public surface for the LiquidJS-based theme engine.
 *
 * Currently exports the loader layer (Step 1.3). The Liquid instance,
 * filter set, tag handlers, render context builder, etc. land in
 * subsequent steps and will be re-exported from here.
 *
 * Why a per-feature folder under `themes/` instead of replacing
 * `themes/engine.ts` directly?
 *   - Step 1.17 deletes the old Nunjucks engine. Until then, the new
 *     code lives next to the old one without import conflicts.
 *   - The new engine is split into many small files; one flat file
 *     would balloon past the 200-line CLAUDE.md guideline.
 */

export {
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
  type ThemeDir,
  normalizeLogicalPath,
  path as themePath,
} from './loader.js'
export { StaticLoader, type StaticLoaderOptions } from './static-loader.js'
export { DbLoader, type DbLoaderOptions } from './db-loader.js'
export {
  createLiquidEngine,
  loaderToLiquidFS,
  type CreateLiquidEngineOptions,
  type LiquidEngine,
} from './liquid.js'
export { registerStringFilters } from './filters/string.js'
export { registerUrlFilters } from './filters/url.js'
export { registerMoneyFilters } from './filters/money.js'
export { registerNumericFilters } from './filters/numeric.js'
export { registerI18nFilters } from './filters/i18n.js'
export { registerImageFilters } from './filters/image.js'
export {
  DefaultAssetUrlBuilder,
  type AssetUrlBuilder,
  type DefaultAssetUrlBuilderOptions,
  type ImageInput,
  type ImageSize,
  parseSizeToken,
  applySizeSuffix,
  resolveImageUrl,
  joinUrl,
} from './assets/asset-url-builder.js'
export {
  registerSectionTag,
  renderSectionInstance,
  GBOX_SECTION_INSTANCES_ENV_KEY,
  GBOX_SCHEMA_LOCALE_DICT_ENV_KEY,
  type GboxSectionInstancesEnv,
  type GboxSchemaLocaleDictEnv,
} from './tags/section.js'
export {
  registerPaginateTag,
  buildPaginateParts,
  buildPageUrl,
  buildRebindFrame,
  GBOX_PAGINATION_ENV_KEY,
  type PaginationInput,
  type GboxPaginationEnv,
  type PaginateDrop,
  type PaginatePart,
} from './tags/paginate.js'
export {
  parseJsonTemplate,
  JsonTemplateParseError,
} from './json-template/parser.js'
export { renderJsonTemplate } from './json-template/renderer.js'
export type {
  JsonTemplate,
  JsonSectionInstance,
  JsonBlockInstance,
} from './json-template/types.js'
export {
  registerMetaBlockTags,
  findParsedSchema,
  GBOX_META_REGISTER_KEY,
  type GboxMetaRegister,
} from './tags/meta-blocks.js'
export {
  parseSchemaBody,
  emptySchema,
  SchemaParseError,
} from './schema/parser.js'
export {
  resolveSectionDrop,
  resolveSectionSettings,
  resolveSectionBlocks,
  resolveSettingsFromList,
} from './schema/resolver.js'
export {
  NON_VALUE_SETTING_TYPES,
  typeFallbackDefault,
  type ParsedSchema,
  type ResolvedBlock,
  type SchemaBlock,
  type SchemaSetting,
  type SchemaSettingType,
  type SectionBlockInstance,
  type SectionDrop,
  type SectionInstance,
} from './schema/types.js'
export {
  registerLayoutTag,
  GBOX_LAYOUT_REGISTER_KEY,
  GBOX_LAYOUT_NONE,
  type GboxLayoutRegister,
} from './tags/layout.js'
export { registerFormTag, FORM_HANDLERS } from './tags/form.js'
export { registerFormFilters } from './filters/form.js'
export {
  renderPage,
  normalizeTemplatePath,
  normalizeTemplateBase,
  resolvePageTemplate,
  buildContentForHeader,
  resolveLayoutName,
  type RenderPageOptions,
  type RenderPageResult,
  type ResolvedTemplate,
} from './pipeline.js'
export {
  renderSections,
  resolveForSectionApi,
  SectionRenderingError,
  DEFAULT_MAX_SECTIONS,
  type RenderSectionsOptions,
  type RenderSectionsResult,
  type ResolvedForSectionApi,
  type SectionRenderingErrorCode,
} from './section-api.js'
export {
  // Types
  type StorefrontRequestContext,
  type StorefrontResponse,
  type StorefrontRoute,
  type RouteLoaderResult,
  type StorefrontHandlerOptions,
  type StorefrontThemeConfig,
  // Datasource
  MemoryDataSource,
  type StorefrontDataSource,
  type DataSourceContext,
  type PageArgs,
  type MemoryDataSourceSeed,
  type ShopDrop,
  type ProductDrop,
  type CollectionDrop,
  type PageDrop,
  type PolicyDrop,
  type BlogDrop,
  type ArticleDrop,
  type CustomerDrop,
  type CartDrop,
  type GiftCardDrop,
  type SearchDrop,
  // Locale
  DEFAULT_LOCALE_CONFIG,
  negotiateLocale,
  parseAcceptLanguage,
  pickFromAcceptLanguage,
  stripLocalePrefix,
  type LocaleConfig,
  type LocaleNegotiation,
  // Error logger
  RateLimitedErrorLogger,
  createDefaultErrorLogger,
  fingerprintError,
  CONSOLE_SINK,
  NOOP_SINK,
  DEFAULT_ERROR_MAX_PER_WINDOW,
  DEFAULT_ERROR_WINDOW_MS,
  type ErrorLogger,
  type ErrorLoggerSink,
  type ErrorLoggerOptions,
  type LoggedEvent,
  type ReportInput,
  // Router
  STOREFRONT_ROUTES,
  COMPILED_ROUTES,
  compileRoute,
  matchRoute,
  parseSectionsParam,
  pickSchemaLocaleDict,
  handleStorefrontRequest,
  type CompiledRoute,
  // Express adapter
  createExpressStorefrontHandler,
  expressToStorefrontContext,
  type ExpressLikeRequest,
  type ExpressLikeResponse,
  type ExpressLikeNext,
  type ExpressStorefrontHandler,
  // Theme config preloader
  prepareThemeConfig,
  type PrepareThemeConfigOptions,
  type PrepareThemeConfigResult,
} from './storefront/index.js'

// ---- Theme config (settings + locales) ----------------------------------
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
  loadThemeSettings,
  SETTINGS_SCHEMA_PATH,
  SETTINGS_DATA_PATH,
  type LoadThemeSettingsResult,
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
} from './theme-config/index.js'
