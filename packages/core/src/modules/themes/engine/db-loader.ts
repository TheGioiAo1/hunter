/**
 * Gbox Platform — DbLoader
 *
 * Decision #1 Step 1.6 — PostgreSQL-backed `TemplateLoader`. Reads
 * theme files from the `theme_assets` table (schema from migration
 * 001). This is the PRODUCTION loader every merchant render flows
 * through.
 *
 * Row shape (from `theme_assets`):
 *   id          uuid
 *   theme_id    uuid   FK → themes.id
 *   key         varchar(500)   logical path, e.g. 'snippets/card.liquid'
 *   value       text           template source (nullable for binary
 *                              assets stored in R2 instead)
 *   content_type varchar(100)
 *   size        integer
 *   created_at  timestamptz
 *   updated_at  timestamptz
 *
 *   unique(theme_id, key) — idx_theme_assets_theme_key
 *
 * Design decisions:
 *
 *   1. SCOPED TO A THEME VERSION. Every `DbLoader` instance is bound
 *      to exactly one `theme_id`. Theme upgrade = new theme row with a
 *      new uuid = new DbLoader instance. This gives us trivial cache
 *      invalidation: drop the old instance, create a new one, the GC
 *      cleans up the old cache. No cache-coherence dance across
 *      workers, no row-level TTLs.
 *
 *   2. IN-PROCESS LRU CACHE (parse tree cache NOT this cache). The
 *      LiquidJS engine has its OWN parse-tree cache (Step 1.4 sets
 *      `cache: true`) that keys off source strings. Our cache here is
 *      one level below: it caches the raw source string from the DB so
 *      the same template fetched ten times in one request doesn't hit
 *      Postgres ten times. A typical theme has ~50 templates; caching
 *      all of them costs well under 1MB and eliminates ~50 round-trips
 *      per cold start.
 *
 *   3. IN-FLIGHT DEDUP. If two concurrent renders ask for the same
 *      template before it's cached, we share a single DB query instead
 *      of double-fetching. Mirrors the `DbI18nService` dedup pattern
 *      from Step 1.2b.
 *
 *   4. NEGATIVE CACHING. Missing templates (no row for this key) are
 *      cached as `null` using the same entry shape so repeated
 *      `{% render 'missing' %}` calls don't hammer Postgres. Because
 *      the loader is per theme version, the negative cache is safe —
 *      you can't add a new template to a published theme; you upgrade
 *      the theme and get a fresh loader.
 *
 *   5. NO TTL BY DEFAULT. Cache entries live as long as the loader
 *      instance. Dev/hot-reload servers can pass `cacheTtlMs` to force
 *      expiry; production sets it to `Infinity` implicitly.
 *
 *   6. TEMPLATE SOURCE FROM `value` COLUMN — INLINE OR R2 SENTINEL.
 *      `theme_assets.value` can hold either inline source text OR a
 *      sentinel like `r2://themes/{themeId}/{key}` pointing at a
 *      Cloudflare R2 object (Step 1.16). When the loader sees the
 *      sentinel AND has been given an `objectStore`, it fetches the
 *      blob, decodes it as UTF-8, and returns it as a normal string
 *      source. When the value is NULL or the sentinel can't be
 *      resolved (no objectStore wired, or R2 fetch fails), we
 *      negative-cache and return null so a missing template never
 *      becomes a hot-loop on the DB.
 *
 *   7. PATH TRAVERSAL DEFENSE. Every input path goes through
 *      `normalizeLogicalPath()` (rejects `..` and `.` segments) before
 *      touching the query. Same rule as StaticLoader, Iron Rule 1.
 *
 *   8. LIST() USES `LIKE` WITH ESCAPED METACHARS. We escape `%` and
 *      `_` in the prefix so a merchant naming a section
 *      `hero_banner_%.liquid` doesn't accidentally match everything.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { ObjectStore } from '../../storage/index.js'
import { isR2Reference, parseR2Reference } from '../r2-ref.js'
import {
  type LoadResult,
  type LogicalPath,
  type TemplateLoader,
  normalizeLogicalPath,
} from './loader.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DbLoaderOptions {
  /** Which theme version to read templates from. */
  themeId: string

  /**
   * Diagnostic label that shows up in error messages and the `name`
   * getter. Defaults to `'db:' + themeId.slice(0, 8)`.
   */
  label?: string

  /**
   * Cache TTL in milliseconds. Default `Infinity` — entries live until
   * the loader instance is garbage-collected. Set to a low value for
   * dev/hot-reload servers that want to pick up theme edits without
   * restarting.
   */
  cacheTtlMs?: number

  /**
   * Soft cap on cache size. When the cache holds more entries than
   * this, the oldest-inserted entry is evicted (plain FIFO — good
   * enough for theme workloads where the working set is tiny).
   * Default `Infinity`.
   */
  maxCacheSize?: number

  /**
   * Optional ObjectStore used to resolve `r2://...` sentinels stored
   * in `theme_assets.value`. If omitted, the loader treats any R2
   * sentinel as a missing template (negative cache, no error). The
   * production storefront wires this from `getObjectStore()`; tests
   * pass a `MemoryStore` instance.
   */
  objectStore?: ObjectStore
}

// ---------------------------------------------------------------------------
// Cache entry shape
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** `null` = negative cache (row missing or value NULL). */
  result: LoadResult | null
  /** When this entry expires. `Infinity` means never. */
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DbLoader implements TemplateLoader {
  readonly name: string

  private readonly db: Kysely<Database>
  private readonly themeId: string
  private readonly cacheTtlMs: number
  private readonly maxCacheSize: number
  private readonly objectStore: ObjectStore | undefined

  /** Positive + negative cache, keyed by normalized logical path. */
  private readonly cache: Map<string, CacheEntry> = new Map()

  /** In-flight request dedup — prevents N concurrent fetches for one key. */
  private readonly inflight: Map<string, Promise<LoadResult | null>> = new Map()

  constructor(db: Kysely<Database>, opts: DbLoaderOptions) {
    if (!db) throw new Error('DbLoader: db is required')
    if (!opts || typeof opts.themeId !== 'string' || opts.themeId.length === 0) {
      throw new Error('DbLoader: opts.themeId is required')
    }

    this.db = db
    this.themeId = opts.themeId
    this.cacheTtlMs = opts.cacheTtlMs ?? Infinity
    this.maxCacheSize = opts.maxCacheSize ?? Infinity
    this.objectStore = opts.objectStore
    this.name = opts.label ?? `db:${opts.themeId.slice(0, 8)}`
  }

  // ---------------------------------------------------------------------
  // TemplateLoader interface
  // ---------------------------------------------------------------------

  async load(logicalPath: LogicalPath): Promise<string | null> {
    const r = await this.loadWithMeta(logicalPath)
    return r ? r.source : null
  }

  async loadWithMeta(logicalPath: LogicalPath): Promise<LoadResult | null> {
    const norm = normalizeLogicalPath(logicalPath)

    // 1. Cache hit (positive or negative) — fast path.
    const cached = this.cache.get(norm)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result
    }

    // 2. In-flight dedup — second caller shares the first's promise.
    const pending = this.inflight.get(norm)
    if (pending) return pending

    // 3. Cold fetch.
    const promise = this.fetchFromDb(norm).finally(() => {
      this.inflight.delete(norm)
    })
    this.inflight.set(norm, promise)
    return promise
  }

  async exists(logicalPath: LogicalPath): Promise<boolean> {
    // Reuses loadWithMeta so we only issue one query + cache fills for
    // the common "exists? then load" sequence. Trades a slightly larger
    // read per exists() call for a trip to Postgres on the follow-up
    // load(). Theme files are small (<50KB), the tradeoff is cheap.
    const r = await this.loadWithMeta(logicalPath)
    return r !== null
  }

  async list(prefix: string = ''): Promise<LogicalPath[]> {
    let query = this.db
      .selectFrom('theme_assets')
      .select('key')
      .where('theme_id', '=', this.themeId)

    if (prefix.length > 0) {
      // Normalize the prefix through the same rules as path inputs,
      // minus the non-empty guard (an empty prefix means "all").
      const normPrefix = prefix.replace(/\\/g, '/').replace(/^\/+/, '')
      // Escape LIKE metacharacters so `foo_bar` doesn't match `foo1bar`.
      const escaped = escapeLike(normPrefix)
      query = query.where('key', 'like', `${escaped}%`)
    }

    // `list()` is infrequent (theme install, admin inventory) so we
    // order in SQL rather than in JS to keep the callsite simple.
    const rows = await query.orderBy('key', 'asc').execute()

    // Paths in the DB are already logical (the seeder normalized on
    // insert), but run them through normalizeLogicalPath anyway so a
    // bad row can't leak out of the loader as a traversal string.
    return rows.map((r) => normalizeLogicalPath(r.key))
  }

  // ---------------------------------------------------------------------
  // Cache management
  // ---------------------------------------------------------------------

  /**
   * Drop a specific path from the cache, or the whole cache if no
   * argument is passed. Called by the admin theme editor after a
   * merchant saves a template, and by the theme upgrade pipeline.
   */
  invalidate(logicalPath?: LogicalPath): void {
    if (logicalPath === undefined) {
      this.cache.clear()
      return
    }
    this.cache.delete(normalizeLogicalPath(logicalPath))
  }

  /** Test helper — number of cached entries (positive + negative). */
  _cacheSize(): number {
    return this.cache.size
  }

  /** Test helper — peek at a cached entry without touching expiry. */
  _peekCache(logicalPath: LogicalPath): CacheEntry | undefined {
    return this.cache.get(normalizeLogicalPath(logicalPath))
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async fetchFromDb(norm: string): Promise<LoadResult | null> {
    const row = await this.db
      .selectFrom('theme_assets')
      .select(['value', 'updated_at'])
      .where('theme_id', '=', this.themeId)
      .where('key', '=', norm)
      .executeTakeFirst()

    let result: LoadResult | null
    if (!row || row.value === null) {
      // Negative cache: row missing or value IS NULL.
      result = null
    } else if (isR2Reference(row.value)) {
      // R2 sentinel — try to fetch the body from the object store.
      // We only attempt the fetch when an objectStore is wired into
      // this loader instance. Without one we negative-cache so the
      // template behaves as missing rather than throwing inside the
      // render pipeline.
      const body = await this.fetchR2Body(row.value)
      if (body === null) {
        result = null
      } else {
        result = {
          source: body,
          updatedAt: toIsoString(row.updated_at),
        }
      }
    } else {
      result = {
        source: row.value,
        updatedAt: toIsoString(row.updated_at),
      }
    }

    this.storeInCache(norm, result)
    return result
  }

  /**
   * Resolve an `r2://...` sentinel to its UTF-8 source string.
   * Returns null on any failure (no objectStore wired, malformed
   * sentinel, blob missing, fetch error). Failures are logged via
   * `console.warn` so missing R2 templates show up in ops without
   * crashing the render path.
   */
  private async fetchR2Body(sentinel: string): Promise<string | null> {
    if (!this.objectStore) {
      console.warn(
        `[db-loader ${this.name}] R2 sentinel ${sentinel} but no objectStore wired; treating as missing`,
      )
      return null
    }
    const r2Key = parseR2Reference(sentinel)
    if (r2Key === null) return null
    try {
      const bytes = await this.objectStore.get(r2Key)
      if (bytes === null) {
        console.warn(
          `[db-loader ${this.name}] R2 blob ${r2Key} missing for sentinel ${sentinel}`,
        )
        return null
      }
      return new TextDecoder('utf-8').decode(bytes)
    } catch (err) {
      console.warn(
        `[db-loader ${this.name}] R2 fetch failed for ${r2Key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return null
    }
  }

  private storeInCache(norm: string, result: LoadResult | null): void {
    // Simple FIFO eviction: if we're at the cap, drop the oldest entry
    // (Map preserves insertion order). For theme workloads the working
    // set is small (~50 templates) so LRU vs FIFO doesn't matter.
    if (this.cache.size >= this.maxCacheSize) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(norm, {
      result,
      expiresAt:
        this.cacheTtlMs === Infinity ? Infinity : Date.now() + this.cacheTtlMs,
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape SQL LIKE metacharacters (`%`, `_`, `\\`) so a user-supplied
 * prefix is treated literally. We use the default PostgreSQL escape
 * character (backslash); no `ESCAPE` clause needed.
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => '\\' + c)
}

/**
 * Coerce a Kysely `updated_at` column (which may come back as a `Date`
 * object from node-postgres, or as a string from some drivers) into
 * an ISO-8601 string. Returns `undefined` for falsy inputs so callers
 * can leave `updatedAt` absent from the LoadResult.
 */
function toIsoString(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  // Fallback: try to coerce anything else Date-like.
  try {
    const d = new Date(value as any)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  } catch {
    return undefined
  }
}
