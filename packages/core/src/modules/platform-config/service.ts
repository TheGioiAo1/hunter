/**
 * Gbox Platform — Platform Config Service (Phase 2 Step 2.5)
 *
 * Thin persistence layer on top of the typed definitions registry.
 * The service is storage-agnostic: callers inject a `PlatformSettingsStore`
 * (backed by Kysely in the real app, backed by an in-memory map in
 * tests / Cloudflare Workers previews).
 *
 *   ┌────────────────────────┐     ┌─────────────────────────┐
 *   │ god-admin route        │     │ definitions.ts          │
 *   │ POST /god-admin/config │     │ (11 typed settings)     │
 *   └──────────┬─────────────┘     └────────────┬────────────┘
 *              │                                │
 *              ▼                                ▼
 *   ┌────────────────────────────────────────────────────┐
 *   │          PlatformConfigService                     │
 *   │                                                    │
 *   │   getAll() → fills missing rows with defaults      │
 *   │   get(key) → coerces raw JSON back to typed value  │
 *   │   applyChange(key, raw) → coerce + validate + save │
 *   └───────────────────┬────────────────────────────────┘
 *                       │
 *                       ▼
 *            ┌──────────────────────┐
 *            │ PlatformSettingsStore │
 *            │  (Kysely | in-mem)   │
 *            └──────────────────────┘
 *
 * Why not just query `platform_settings` directly from the route?
 * Because every read would have to re-coerce JSONB values, fill in
 * defaults for missing keys, and reject unknown keys. Centralizing
 * that here means the Platform Config admin page, the sign-up page
 * (which reads `signup_enabled`), and the health check endpoint
 * (which reads `maintenance_mode`) all go through one code path —
 * and one cache.
 */

import {
  PLATFORM_SETTING_DEFS,
  PLATFORM_SETTING_MAP,
  coerceValue,
  validateValue,
  type PlatformSettingDef,
  type PlatformSettingKey,
} from './definitions.js'

/**
 * Storage abstraction. Implementations MUST treat the value as
 * JSON-serializable — strings, numbers, booleans. The service layer
 * handles type coercion via the registry.
 */
export interface PlatformSettingsStore {
  /** Return all rows as a `{key: value}` map. Missing rows are omitted. */
  readAll(): Promise<Record<string, unknown>>
  /** Upsert a single row. */
  write(key: string, value: unknown): Promise<void>
}

/**
 * In-memory implementation — zero deps, used by tests and preview
 * environments. Thread-safe only under Node's single event loop.
 */
export class InMemoryPlatformSettingsStore implements PlatformSettingsStore {
  private readonly data: Map<string, unknown>

  constructor(initial: Record<string, unknown> = {}) {
    this.data = new Map(Object.entries(initial))
  }

  async readAll(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.data)
  }

  async write(key: string, value: unknown): Promise<void> {
    this.data.set(key, value)
  }
}

/** A single resolved setting — value is either stored or default. */
export interface ResolvedPlatformSetting {
  def: PlatformSettingDef
  value: unknown
  /** True when the value came from the default (no DB row yet). */
  isDefault: boolean
}

export interface ApplyChangeResult {
  ok: boolean
  /** Error message when ok=false. */
  error?: string
  /** Resolved value after coercion (only when ok=true). */
  value?: unknown
}

export class PlatformConfigService {
  constructor(private readonly store: PlatformSettingsStore) {}

  /**
   * Return all 11 settings resolved — stored value when present,
   * default value otherwise. Stable order (matches
   * PLATFORM_SETTING_DEFS declaration order).
   */
  async getAll(): Promise<ResolvedPlatformSetting[]> {
    const stored = await this.store.readAll()
    return PLATFORM_SETTING_DEFS.map((def) => {
      const hasStored = Object.prototype.hasOwnProperty.call(stored, def.key)
      if (hasStored) {
        return { def: def as PlatformSettingDef, value: stored[def.key], isDefault: false }
      }
      return { def: def as PlatformSettingDef, value: def.default, isDefault: true }
    })
  }

  /**
   * Return a single setting's effective value. Falls back to the
   * default if no row is stored. Unknown keys return `undefined`.
   */
  async get<T = unknown>(key: PlatformSettingKey): Promise<T | undefined> {
    const def = PLATFORM_SETTING_MAP[key]
    if (!def) return undefined
    const stored = await this.store.readAll()
    if (Object.prototype.hasOwnProperty.call(stored, key)) {
      return stored[key] as T
    }
    return def.default as T
  }

  /**
   * Coerce + validate + persist a single setting from a raw form
   * string. Returns an ApplyChangeResult so the route handler can
   * render either a success toast or a field-level error.
   *
   * Unknown keys are rejected (can't write arbitrary rows).
   */
  async applyChange(key: string, raw: string): Promise<ApplyChangeResult> {
    const def = PLATFORM_SETTING_MAP[key]
    if (!def) return { ok: false, error: `Unknown setting: ${key}` }

    let coerced: unknown
    try {
      coerced = coerceValue(def, raw)
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    const err = validateValue(def, coerced)
    if (err) return { ok: false, error: err }

    await this.store.write(key, coerced)
    return { ok: true, value: coerced }
  }

  /**
   * Apply many changes in one shot. Returns a map keyed by setting
   * key of either null (success) or an error string. Does NOT abort
   * on the first error — we want to surface all field errors at once
   * so the merchant sees every problem in one pass (Shopify UX).
   */
  async applyMany(
    changes: Record<string, string>,
  ): Promise<Record<string, string | null>> {
    const errors: Record<string, string | null> = {}
    for (const [key, raw] of Object.entries(changes)) {
      const result = await this.applyChange(key, raw)
      errors[key] = result.ok ? null : result.error ?? 'Unknown error'
    }
    return errors
  }
}
