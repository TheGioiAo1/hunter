/**
 * Gbox Platform — Admin i18n Types (Phase 2 Step 2.10)
 *
 * The ADMIN i18n system is separate from the storefront (theme) i18n
 * system in `packages/core/src/modules/i18n`:
 *
 *   - Storefront i18n: per-shop, DB-backed (translations table),
 *     loaded by the LiquidJS engine, bulk-upserted by theme install.
 *   - Admin i18n (THIS MODULE): per-user preference, static JSON
 *     bundled with the app, used by god-admin + store-admin layouts
 *     and shared UI helpers. Five locales ship in-repo and never
 *     touch the database.
 *
 * Scope (from CLAUDE.md Iron Rule / Stage 2.10):
 *   - Markets: US + EU only → NO Vietnamese
 *   - Locales: en-US, en-GB, de-DE, fr-FR, es-ES
 *   - en-US is the baseline + ultimate fallback
 *
 * Philosophy: "clone giống hệt Shopify" — Shopify admin ships the
 * same set of English/German/French/Spanish locales, and fall-through
 * handling matches theirs (key → shop default → en-US → key literal).
 * "power-ful hơn Shopify nhờ Claude" — the entire dictionary is a
 * typed union so missing keys are a TypeScript error at compile time,
 * not a runtime surprise.
 */

/**
 * Supported admin locale codes. Keep this list in lock-step with the
 * `ADMIN_LOCALES` array in `locales.ts`. Any new locale MUST ship a
 * complete dictionary on day one — we never allow partial coverage
 * that would silently fall back to English at runtime.
 */
export type AdminLocale = 'en-US' | 'en-GB' | 'de-DE' | 'fr-FR' | 'es-ES'

/**
 * The canonical baseline locale. Used as the last step of the
 * fallback chain before returning the raw key.
 */
export const DEFAULT_ADMIN_LOCALE: AdminLocale = 'en-US'

/**
 * Runtime-checkable list of all supported locales. Useful for
 * validating request headers, cookies, and admin preference forms.
 */
export const ADMIN_LOCALES: readonly AdminLocale[] = [
  'en-US',
  'en-GB',
  'de-DE',
  'fr-FR',
  'es-ES',
] as const

/**
 * Human-readable labels for the locale switcher dropdown. Each label
 * is written IN ITS OWN LANGUAGE so a user who accidentally lands on
 * the wrong locale can still recognize their own.
 */
export const ADMIN_LOCALE_LABELS: Record<AdminLocale, string> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'de-DE': 'Deutsch',
  'fr-FR': 'Français',
  'es-ES': 'Español',
}

/**
 * Flag emojis paired with each locale for the switcher. Emojis are
 * decoration only — never the sole indicator, because flag-as-language
 * is an a11y anti-pattern for some users.
 */
export const ADMIN_LOCALE_FLAGS: Record<AdminLocale, string> = {
  'en-US': '🇺🇸',
  'en-GB': '🇬🇧',
  'de-DE': '🇩🇪',
  'fr-FR': '🇫🇷',
  'es-ES': '🇪🇸',
}

/**
 * One locale's dictionary — flat key→value map. Keys are dot-separated
 * namespaces (e.g., `nav.dashboard`, `button.save`) so consumers can
 * spot ownership at a glance.
 */
export type AdminMessages = {
  // Common buttons & actions
  'button.save': string
  'button.cancel': string
  'button.delete': string
  'button.edit': string
  'button.create': string
  'button.back': string
  'button.close': string
  'button.confirm': string
  'button.apply': string
  'button.reset': string
  'button.search': string
  'button.filter': string
  'button.export': string
  'button.import': string
  'button.continue': string
  'button.sign_in': string
  'button.sign_out': string

  // Navigation — god-admin sidebar
  'nav.dashboard': string
  'nav.stores': string
  'nav.users': string
  'nav.orders': string
  'nav.products': string
  'nav.customers': string
  'nav.finance': string
  'nav.marketing': string
  'nav.analytics': string
  'nav.settings': string
  'nav.platform_config': string
  'nav.admins': string
  'nav.activity': string
  'nav.discounts': string
  'nav.billing': string

  // Common table / list columns
  'label.name': string
  'label.email': string
  'label.status': string
  'label.created_at': string
  'label.updated_at': string
  'label.actions': string
  'label.id': string
  'label.description': string
  'label.price': string
  'label.quantity': string
  'label.total': string
  'label.role': string
  'label.locale': string
  'label.theme': string

  // Common statuses
  'status.active': string
  'status.inactive': string
  'status.pending': string
  'status.suspended': string
  'status.archived': string
  'status.draft': string
  'status.published': string

  // Form messages (echo of validator defaults for consistency)
  'form.required': string
  'form.invalid_email': string
  'form.invalid_url': string
  'form.too_short': string
  'form.too_long': string
  'form.must_match': string

  // Empty states
  'empty.no_results': string
  'empty.no_items_yet': string
  'empty.no_access': string
  'empty.error_generic': string

  // Confirmation modals
  'confirm.are_you_sure': string
  'confirm.cannot_be_undone': string
  'confirm.type_to_confirm': string

  // Toasts / flash messages
  'toast.saved': string
  'toast.deleted': string
  'toast.created': string
  'toast.updated': string
  'toast.error_generic': string

  // Accessibility strings
  'a11y.skip_to_main': string
  'a11y.close_menu': string
  'a11y.open_menu': string
  'a11y.loading': string

  // Theme / locale / chrome
  'chrome.theme_toggle': string
  'chrome.language': string
  'chrome.current_page': string
}

/**
 * Literal union of every key name. Lets callers type-check at the
 * call site: `t('nav.dashboard')` compiles, `t('nav.dashboord')` does
 * not.
 */
export type AdminMessageKey = keyof AdminMessages

/**
 * Shape of every shipped locale. Using a mapped `Record<key,string>`
 * enforces that a new locale file MUST define every key, catching
 * omissions at build time.
 */
export type AdminLocaleDict = AdminMessages

/**
 * Function signature consumers rely on. Returns the resolved string
 * after interpolation. Interpolation tokens use `{name}` (single
 * braces, NOT Liquid `{{ }}` — that namespace belongs to the theme
 * engine).
 */
export type AdminTranslator = (
  key: AdminMessageKey,
  vars?: Record<string, string | number>,
) => string
