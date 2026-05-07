/**
 * Gbox Platform — Admin i18n Module (Phase 2 Step 2.10)
 *
 * Barrel re-export for the admin UI internationalization stack.
 * Everything here is ADMIN-only — the storefront theme engine has
 * its own separate `@gbox/core/modules/i18n` module that is backed
 * by the `translations` database table per shop.
 *
 * Market: US + EU only. Locales shipped: en-US, en-GB, de-DE, fr-FR,
 * es-ES. NO Vietnamese (per CLAUDE.md Iron Rule).
 */

export type {
  AdminLocale,
  AdminLocaleDict,
  AdminMessageKey,
  AdminMessages,
  AdminTranslator,
} from './types.js'

export {
  ADMIN_LOCALES,
  ADMIN_LOCALE_LABELS,
  ADMIN_LOCALE_FLAGS,
  DEFAULT_ADMIN_LOCALE,
} from './types.js'

export { ADMIN_LOCALE_DICTS } from './locales.js'

export {
  interpolateAdmin,
  isAdminLocale,
  coerceAdminLocale,
  createTranslator,
} from './translator.js'

export {
  type NegotiateInput,
  ADMIN_LOCALE_COOKIE,
  ADMIN_LOCALE_COOKIE_MAX_AGE_SECONDS,
  readLocaleFromCookieHeader,
  buildLocaleCookie,
  parseAcceptLanguage,
  resolveLanguageTag,
  pickLocaleFromAcceptLanguage,
  negotiateAdminLocale,
  readLocaleFromRequest,
} from './negotiate.js'

export {
  formatNumber,
  formatCurrency,
  formatPercent,
  formatDate,
  formatDateTime,
  formatTime,
  formatRelative,
} from './format.js'
