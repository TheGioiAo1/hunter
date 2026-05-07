/**
 * Gbox Platform — Storefront module entry point
 *
 * Decision #1 Step 1.14 — Re-export every public type and function
 * the storefront router exposes so consumers can do
 *
 *   import { handleStorefrontRequest, MemoryDataSource } from
 *     '@gbox/core/.../engine/storefront'
 *
 * without reaching into individual sub-files. The Theme engine's
 * top-level `engine/index.ts` re-exports from here in turn.
 */

// ---- Types --------------------------------------------------------------
export type {
  StorefrontRequestContext,
  StorefrontResponse,
  StorefrontRoute,
  RouteLoaderResult,
  StorefrontHandlerOptions,
  StorefrontThemeConfig,
} from './types.js'

// ---- Datasource ---------------------------------------------------------
export {
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
} from './datasource.js'

// ---- Locale negotiation -------------------------------------------------
export {
  DEFAULT_LOCALE_CONFIG,
  negotiateLocale,
  parseAcceptLanguage,
  pickFromAcceptLanguage,
  stripLocalePrefix,
  type LocaleConfig,
  type LocaleNegotiation,
} from './locale.js'

// ---- Error logger -------------------------------------------------------
export {
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
} from './error-logger.js'

// ---- Router -------------------------------------------------------------
export {
  STOREFRONT_ROUTES,
  COMPILED_ROUTES,
  compileRoute,
  matchRoute,
  parseSectionsParam,
  pickSchemaLocaleDict,
  handleStorefrontRequest,
  type CompiledRoute,
} from './router.js'

// ---- Theme config preloader ---------------------------------------------
export {
  prepareThemeConfig,
  type PrepareThemeConfigOptions,
  type PrepareThemeConfigResult,
} from './theme-config-loader.js'

// ---- Express adapter ----------------------------------------------------
export {
  createExpressStorefrontHandler,
  expressToStorefrontContext,
  type ExpressLikeRequest,
  type ExpressLikeResponse,
  type ExpressLikeNext,
  type ExpressStorefrontHandler,
} from './express-adapter.js'
