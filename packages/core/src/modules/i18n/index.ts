/**
 * Gbox Platform — i18n Module Entry Point
 *
 * Decision #1 Step 1.2b — Public surface for the theme i18n system.
 *
 * Two implementations ship:
 *   - DbI18nService     → reads from the `translations` table (migration 008)
 *   - MemoryI18nService → in-memory, for tests + early engine bring-up
 *
 * The LiquidJS engine (Step 1.4) will accept any `I18nService` instance
 * via dependency injection so no module here cares which one is in use.
 */

export type {
  I18nService,
  TranslateOptions,
  TranslationDict,
  InterpolationVars,
  CacheKey,
} from './types.js'
export { interpolate } from './interpolate.js'
export { DbI18nService } from './service.js'
export { MemoryI18nService } from './memory-service.js'
export {
  translateKey,
  buildLocaleFallbackChain,
  type TranslationBundles,
  type TranslateKeyOptions,
} from './translate.js'
