/**
 * Gbox Platform — TemplateLoader Interface
 *
 * Decision #1 Step 1.3 — The abstract layer the LiquidJS engine uses
 * to fetch template source by logical path. This is where the engine's
 * "where do templates live?" decision becomes pluggable: every loader
 * speaks the same async interface, so the engine code never branches
 * on storage type.
 *
 * Two implementations ship in Decision #1:
 *   - StaticLoader (Step 1.3, this folder)   → reads from a directory
 *                                                on disk. Used for
 *                                                seeding gbox-dawn and
 *                                                for local theme dev.
 *   - DbLoader     (Step 1.6, future)         → reads from the
 *                                                `theme_assets` table
 *                                                (with R2 spillover for
 *                                                blobs >256KB). Used in
 *                                                production for every
 *                                                merchant render.
 *
 * Logical path layout
 * -------------------
 * Loaders speak in Shopify-style logical paths, NOT filesystem paths.
 * Every theme has the same canonical directory tree:
 *
 *     layout/<name>.liquid          ← theme.liquid is the default
 *     templates/<name>.liquid       ← page entry points
 *     templates/<name>.json         ← section group templates
 *     templates/customers/<name>.liquid
 *     sections/<name>.liquid        ← reusable sections
 *     snippets/<name>.liquid        ← partials, included via {% render %}
 *     locales/<locale>.json         ← consumed by the i18n loader, not
 *                                     this loader, but the path lives
 *                                     in the same tree
 *     config/settings_data.json
 *     config/settings_schema.json
 *     assets/*                      ← CSS/JS/images, served by ObjectStore
 *
 * Loader callers always pass paths with forward slashes and the
 * extension included (e.g. `'sections/header.liquid'`). The engine's
 * tag handlers translate Shopify shorthand:
 *
 *     {% render 'product-card' %}        →  load('snippets/product-card.liquid')
 *     {% section 'header' %}             →  load('sections/header.liquid')
 *     {% include 'breadcrumbs' %}        →  load('snippets/breadcrumbs.liquid')
 *
 * Why a custom interface instead of LiquidJS's built-in `FS` shape?
 *   1. LiquidJS `FS` requires both sync and async methods. Our
 *      production loaders (DB, R2) are inherently async and would
 *      have to throw on the sync calls. A wrapper adapter (built in
 *      Step 1.4) bridges TemplateLoader → LiquidJS FS by stubbing the
 *      sync methods to throw, since we run the engine in async-only
 *      mode anyway.
 *   2. Our interface returns `null` on missing instead of throwing,
 *      which lets the engine layer in fallback behavior (e.g. fall
 *      back to the section-group JSON when a `.liquid` is missing,
 *      or render the missing-template sentinel page).
 *   3. We need `list()` for theme install, theme upgrade diffing, and
 *      asset inventory — LiquidJS has no equivalent.
 */

/**
 * Logical path is the canonical Shopify-style path with forward
 * slashes and the file extension. Defined as a branded alias so the
 * compiler nudges callers to use a helper rather than passing arbitrary
 * strings, but it remains assignable from string for ergonomic call
 * sites.
 */
export type LogicalPath = string

/**
 * Recognised top-level directories in a Shopify-compatible theme.
 * Used by `list()` callers and by helper builders below.
 */
export type ThemeDir =
  | 'layout'
  | 'templates'
  | 'sections'
  | 'snippets'
  | 'locales'
  | 'config'
  | 'assets'

/**
 * Path-builder helpers — keep callers from hand-concatenating strings
 * (and forgetting the `.liquid` extension or the leading slash).
 */
export const path = {
  layout: (name: string): LogicalPath => `layout/${name}.liquid`,
  template: (name: string): LogicalPath => `templates/${name}.liquid`,
  templateJson: (name: string): LogicalPath => `templates/${name}.json`,
  customerTemplate: (name: string): LogicalPath => `templates/customers/${name}.liquid`,
  section: (name: string): LogicalPath => `sections/${name}.liquid`,
  snippet: (name: string): LogicalPath => `snippets/${name}.liquid`,
  locale: (locale: string): LogicalPath => `locales/${locale}.json`,
  configData: (): LogicalPath => 'config/settings_data.json',
  configSchema: (): LogicalPath => 'config/settings_schema.json',
}

/**
 * Optional metadata about a stored template entry. Loaders that can
 * cheaply produce this (filesystem stat, db updated_at) should fill
 * it in; loaders that can't may return `undefined`.
 */
export interface LoadResult {
  /** The template source. */
  source: string
  /** ISO-8601 last-modified, if known. Used for ETag generation. */
  updatedAt?: string
  /** SHA-256 of source if pre-computed by the storage layer. */
  sha256?: string
}

/**
 * Public surface of every template loader.
 *
 * All methods are async because the production DB loader needs it,
 * and async-everywhere is simpler than maintaining two code paths.
 * Filesystem callers in dev pay a microtask hop per template, which
 * is irrelevant relative to render time.
 */
export interface TemplateLoader {
  /**
   * Read the source for a logical path. Returns `null` if the path
   * does not exist (NEVER throws on missing — that lets the engine
   * decide whether missing is fatal or has a fallback).
   *
   * Throws only on storage errors that are not "missing": permission
   * denied, network timeout, db connection lost, etc.
   */
  load(path: LogicalPath): Promise<string | null>

  /**
   * Same as `load()` but returns the source plus available metadata
   * (timestamps, hashes). Used by the section/template cache layer
   * to compute ETags and decide whether to serve a 304.
   */
  loadWithMeta(path: LogicalPath): Promise<LoadResult | null>

  /**
   * True if the path exists, without reading the body. Cheap O(1)
   * operation on every backend (filesystem stat, db EXISTS, R2 HEAD).
   */
  exists(path: LogicalPath): Promise<boolean>

  /**
   * List every logical path that starts with `prefix`. Returns paths
   * in lexicographic order. Used by:
   *   - Theme install: list every file the seed wants to copy.
   *   - Theme upgrade: diff the new version against the existing one.
   *   - Admin UI inventory: show the merchant every file in their theme.
   *
   * Example:
   *   await loader.list('snippets/')  → ['snippets/header.liquid', ...]
   *   await loader.list('')            → every path the loader knows
   */
  list(prefix?: string): Promise<LogicalPath[]>

  /**
   * Diagnostic name for logs and the engine error context.
   * Examples: 'static:gbox-dawn', 'db:shop_<uuid>:theme_<uuid>'.
   */
  readonly name: string
}

// ---------------------------------------------------------------------------
// Path normalization helpers — used by every loader implementation.
// ---------------------------------------------------------------------------

/**
 * Normalize a user-supplied logical path:
 *   - Replace backslashes with forward slashes (Windows safety).
 *   - Strip leading slashes.
 *   - Collapse repeated slashes.
 *   - Reject `..` segments (path traversal defense — see below).
 *
 * Throws on traversal attempts. This MUST be called by every loader's
 * `load`/`exists` implementation BEFORE touching storage so an attacker
 * can never construct a path like `../../etc/passwd`.
 *
 * Defense rationale (Iron Rule 1 — security first):
 *   The loader sees logical paths from inside template renders. Most
 *   come from trusted theme code, but `{% render foo %}` accepts a
 *   variable for `foo`, and that variable can in theory be set from
 *   `request.params` if a buggy theme passes user input through. The
 *   normalize step is the choke point that catches that.
 */
export function normalizeLogicalPath(input: string): LogicalPath {
  if (typeof input !== 'string') {
    throw new TypeError(`TemplateLoader: path must be a string, got ${typeof input}`)
  }
  if (input.length === 0) {
    throw new Error('TemplateLoader: path must not be empty')
  }

  // Windows → POSIX
  let p = input.replace(/\\/g, '/')

  // Strip leading slashes
  p = p.replace(/^\/+/, '')

  // Collapse repeated slashes
  p = p.replace(/\/{2,}/g, '/')

  // Reject path traversal — both `..` segments and `.` (current dir)
  // segments. The check is on segment equality so a filename like
  // `..foo.liquid` (legitimate) is allowed.
  const segments = p.split('/')
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(
        `TemplateLoader: path traversal segment "${seg}" rejected in "${input}"`,
      )
    }
    if (seg.length === 0) {
      // Should be unreachable after the slash collapse but defend in depth.
      throw new Error(`TemplateLoader: empty segment in "${input}"`)
    }
  }

  return p
}
