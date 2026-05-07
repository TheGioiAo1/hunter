/**
 * Gbox Platform — Platform Config Definitions (Phase 2 Step 2.5)
 *
 * The 11 god-admin-only platform settings. Every one of these rows
 * answers a question that's *platform-wide* and cannot be answered
 * per-store:
 *
 *   1. "What is the platform called in emails and the sidebar?"
 *   2. "What's the canonical URL visitors should see?"
 *   3. "Where do users email for help?"
 *   4. "What's the default locale for brand-new stores?"
 *   5. "What's the default currency for brand-new stores?"
 *   6. "What's the default timezone for brand-new stores?"
 *   7. "Is the platform in maintenance mode right now?"
 *   8. "Is merchant signup currently open?"
 *   9. "How many stores can a single user own?"
 *  10. "What's the minimum password length for new accounts?"
 *  11. "How long before a session expires (in hours)?"
 *
 * The design follows the same philosophy as the rest of Phase 2:
 *   - Pure, tree-shakable module. No DB import here — the service
 *     layer (platform-config/service.ts) is where persistence lives.
 *   - Typed keys + typed values so the admin UI can render the right
 *     widget (text, number, select, toggle) without switch statements
 *     peppered across three files.
 *   - Each setting has `category`, `label`, `help`, `default`,
 *     `validate()`. The admin page groups by category, shows help as
 *     description text, falls back to default if the DB row is
 *     missing, and runs the validator before writing.
 *
 * Triết lý: "clone giống hệt Shopify" (settings page grouped by
 * section with help copy) + "power-ful hơn Shopify nhờ Claude"
 * (one typed registry → the admin form, the seed migration, the
 * REST endpoint shape, and the runtime cache all share one source).
 */

export type PlatformSettingKind =
  | 'text'
  | 'email'
  | 'url'
  | 'number'
  | 'boolean'
  | 'select'
  | 'secret'   // masked API key input — shows ****... with reveal toggle

export interface PlatformSettingOption {
  value: string
  label: string
}

export interface PlatformSettingDef<T = unknown> {
  /** Stable key used as the DB row primary key. */
  key: string
  /** Grouping for the admin UI (renders as a section header). */
  category: 'Branding' | 'Regional' | 'Security' | 'Operations' | 'Integrations'
  /** Widget kind — drives which input is rendered on the edit form. */
  kind: PlatformSettingKind
  /** Short human label. */
  label: string
  /** Help copy shown under the input. */
  help: string
  /** Default value used when the DB row is missing. */
  default: T
  /**
   * Options for `kind: 'select'`. Ignored otherwise.
   * First option is considered the default if `default` is not set.
   */
  options?: PlatformSettingOption[]
  /**
   * Optional validator. Returns an error string when invalid,
   * or null/undefined when valid. Runs server-side before persist.
   */
  validate?: (value: T) => string | null | undefined
  /**
   * If true, exposing the value to non-god-admin users is forbidden.
   * (All settings on this page are god-admin-only in the UI, but the
   * flag lets service-layer consumers gate reads explicitly.)
   */
  sensitive?: boolean
}

/**
 * The 11 settings. Adding a 12th is a one-line append here — the
 * admin UI, the service layer, and the tests all pick it up
 * automatically.
 */
export const PLATFORM_SETTING_DEFS = [
  // --------------------------------------------------------------------------
  // Branding
  // --------------------------------------------------------------------------
  {
    key: 'platform_name',
    category: 'Branding',
    kind: 'text',
    label: 'Platform name',
    help: 'Shown in the top bar, the login page, and outgoing emails.',
    default: 'Gbox Platform',
    validate: (v: string) => {
      if (!v || v.trim().length === 0) return 'Platform name is required.'
      if (v.length > 64) return 'Platform name must be 64 characters or fewer.'
      return null
    },
  } satisfies PlatformSettingDef<string>,

  {
    key: 'platform_url',
    category: 'Branding',
    kind: 'url',
    label: 'Platform URL',
    help: 'The canonical HTTPS URL of this platform, used in emails and OAuth callbacks.',
    default: 'https://gbox.co',
    validate: (v: string) => {
      if (!v) return 'Platform URL is required.'
      try {
        const u = new URL(v)
        if (u.protocol !== 'https:' && u.protocol !== 'http:') {
          return 'Platform URL must be http or https.'
        }
      } catch {
        return 'Platform URL is not a valid URL.'
      }
      return null
    },
  } satisfies PlatformSettingDef<string>,

  {
    key: 'support_email',
    category: 'Branding',
    kind: 'email',
    label: 'Support email',
    help: 'Where merchants should email for help. Shown on the login page and in error screens.',
    default: 'support@gbox.co',
    validate: (v: string) => {
      if (!v) return 'Support email is required.'
      // RFC-lite email check — we don't need perfection, just sanity.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        return 'Support email must be a valid email address.'
      }
      return null
    },
  } satisfies PlatformSettingDef<string>,

  // --------------------------------------------------------------------------
  // Regional
  // --------------------------------------------------------------------------
  {
    key: 'default_locale',
    category: 'Regional',
    kind: 'select',
    label: 'Default locale for new stores',
    help: 'New stores inherit this locale until the merchant overrides it in their store settings. Market = US/EU, no Vietnamese.',
    default: 'en-US',
    options: [
      { value: 'en-US', label: 'English (United States)' },
      { value: 'en-GB', label: 'English (United Kingdom)' },
      { value: 'de-DE', label: 'Deutsch (Deutschland)' },
      { value: 'fr-FR', label: 'Français (France)' },
      { value: 'es-ES', label: 'Español (España)' },
    ],
  } satisfies PlatformSettingDef<string>,

  {
    key: 'default_currency',
    category: 'Regional',
    kind: 'select',
    label: 'Default currency for new stores',
    help: 'ISO-4217 currency code. Merchants can add more currencies inside their store.',
    default: 'USD',
    options: [
      { value: 'USD', label: 'US Dollar (USD)' },
      { value: 'EUR', label: 'Euro (EUR)' },
      { value: 'GBP', label: 'British Pound (GBP)' },
      { value: 'CAD', label: 'Canadian Dollar (CAD)' },
      { value: 'AUD', label: 'Australian Dollar (AUD)' },
    ],
  } satisfies PlatformSettingDef<string>,

  {
    key: 'default_timezone',
    category: 'Regional',
    kind: 'select',
    label: 'Default timezone for new stores',
    help: 'IANA timezone name. Used for scheduled jobs, cron reports, and order cutoffs.',
    default: 'America/New_York',
    options: [
      { value: 'America/New_York', label: 'New York (Eastern)' },
      { value: 'America/Los_Angeles', label: 'Los Angeles (Pacific)' },
      { value: 'Europe/London', label: 'London' },
      { value: 'Europe/Berlin', label: 'Berlin' },
      { value: 'Europe/Paris', label: 'Paris' },
      { value: 'Europe/Madrid', label: 'Madrid' },
    ],
  } satisfies PlatformSettingDef<string>,

  // --------------------------------------------------------------------------
  // Operations
  // --------------------------------------------------------------------------
  {
    key: 'maintenance_mode',
    category: 'Operations',
    kind: 'boolean',
    label: 'Maintenance mode',
    help: 'When ON, all admin pages (except god-admin) show a maintenance screen. Toggle for deploys and migrations.', // iron-rule-5-ok: help text rendered only on god-admin /platform-config page; never shown to sellers
    default: false,
  } satisfies PlatformSettingDef<boolean>,

  {
    key: 'signup_enabled',
    category: 'Operations',
    kind: 'boolean',
    label: 'Merchant signup enabled',
    help: 'When OFF, accounts.gbox.co stops accepting new merchant registrations (existing merchants still log in).',
    default: true,
  } satisfies PlatformSettingDef<boolean>,

  {
    key: 'max_stores_per_user',
    category: 'Operations',
    kind: 'number',
    label: 'Max stores per user',
    help: 'The hard cap on how many stores a single user can own. Used as a sanity check — the Billing plan limits take precedence when set.',
    default: 10,
    validate: (v: number) => {
      if (!Number.isInteger(v)) return 'Max stores must be an integer.'
      if (v < 1) return 'Max stores must be at least 1.'
      if (v > 1000) return 'Max stores must be 1000 or fewer.'
      return null
    },
  } satisfies PlatformSettingDef<number>,

  // --------------------------------------------------------------------------
  // Security
  // --------------------------------------------------------------------------
  {
    key: 'password_min_length',
    category: 'Security',
    kind: 'number',
    label: 'Minimum password length',
    help: 'New accounts must pick a password at least this many characters long. Applies to merchants; customer accounts follow the per-store policy.',
    default: 12,
    validate: (v: number) => {
      if (!Number.isInteger(v)) return 'Password length must be an integer.'
      if (v < 8) return 'Password length must be at least 8 (OWASP minimum).'
      if (v > 128) return 'Password length must be 128 or fewer.'
      return null
    },
  } satisfies PlatformSettingDef<number>,

  {
    key: 'session_timeout_hours',
    category: 'Security',
    kind: 'number',
    label: 'Session timeout (hours)',
    help: 'Merchant sessions expire after this many hours of inactivity. Lower is more secure; higher is more convenient.',
    default: 24,
    validate: (v: number) => {
      if (!Number.isInteger(v)) return 'Session timeout must be an integer number of hours.'
      if (v < 1) return 'Session timeout must be at least 1 hour.'
      if (v > 720) return 'Session timeout must be 720 hours (30 days) or fewer.'
      return null
    },
  } satisfies PlatformSettingDef<number>,

  // --------------------------------------------------------------------------
  // Integrations — Third-party API keys
  // --------------------------------------------------------------------------
  {
    key: 'google_maps_api_key',
    category: 'Integrations',
    kind: 'secret',
    label: 'Google Maps API Key',
    help: 'Address correction by Google — enables address autocomplete + interactive map picker on order/customer address fields. Get your key at console.cloud.google.com. Enable: Maps JavaScript API, Places API, Geocoding API.',
    default: '',
    sensitive: true,
    validate: (v: string) => {
      if (v && v.length < 20) return 'Google API key seems too short. Check your key at console.cloud.google.com.'
      if (v && !v.startsWith('AIza')) return 'Google API key should start with "AIza". Check your key.'
      return null
    },
  } satisfies PlatformSettingDef<string>,
] as const

/** Strongly-typed union of all setting keys. */
export type PlatformSettingKey = (typeof PLATFORM_SETTING_DEFS)[number]['key']

/** Lookup map for O(1) key→def resolution. */
export const PLATFORM_SETTING_MAP: Record<string, PlatformSettingDef> =
  Object.fromEntries(PLATFORM_SETTING_DEFS.map((d) => [d.key, d as PlatformSettingDef]))

/**
 * Return all settings grouped by category, preserving the declaration
 * order inside each group. Used by the admin form to render sections.
 */
export function groupByCategory(): Record<string, PlatformSettingDef[]> {
  const out: Record<string, PlatformSettingDef[]> = {}
  for (const def of PLATFORM_SETTING_DEFS) {
    const list = out[def.category] ?? []
    list.push(def as PlatformSettingDef)
    out[def.category] = list
  }
  return out
}

/**
 * Coerce a raw form-post string into the def's declared type. Throws
 * a typed error if the input can't be coerced. The service layer
 * wraps this + `validate()` in a single `applyChange()` call.
 */
export function coerceValue(
  def: PlatformSettingDef,
  raw: string,
): string | number | boolean {
  switch (def.kind) {
    case 'boolean':
      // HTML form checkboxes post 'on' when checked, absent when not.
      // We normalize both that and explicit 'true'/'false'.
      return raw === 'on' || raw === 'true' || raw === '1'
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        throw new Error(`Value for "${def.key}" is not a number.`)
      }
      return n
    }
    case 'text':
    case 'email':
    case 'url':
    case 'select':
    case 'secret':
    default:
      return String(raw)
  }
}

/**
 * Validate a value against its def. Returns null when valid, or an
 * error string describing what's wrong. Unknown-kind settings pass
 * through (the def.validate is the only enforcement then).
 */
export function validateValue(
  def: PlatformSettingDef,
  value: unknown,
): string | null {
  // Type shape check
  if (def.kind === 'boolean' && typeof value !== 'boolean') {
    return `Value for "${def.key}" must be a boolean.`
  }
  if (def.kind === 'number' && typeof value !== 'number') {
    return `Value for "${def.key}" must be a number.`
  }
  if (
    (def.kind === 'text' ||
      def.kind === 'email' ||
      def.kind === 'url' ||
      def.kind === 'select' ||
      def.kind === 'secret') &&
    typeof value !== 'string'
  ) {
    return `Value for "${def.key}" must be a string.`
  }

  // Select must be one of the allowed options.
  if (def.kind === 'select' && def.options) {
    const allowed = def.options.map((o) => o.value)
    if (!allowed.includes(value as string)) {
      return `Value for "${def.key}" must be one of: ${allowed.join(', ')}.`
    }
  }

  // Per-def validator
  if (def.validate) {
    const err = def.validate(value as never)
    if (err) return err
  }

  return null
}
