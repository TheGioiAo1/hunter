/**
 * Gbox Platform — R2 Reference Helpers
 *
 * Decision #1 Step 1.16 — `theme_assets.value` can hold either inline
 * template source (text ≤256 KB) OR a sentinel pointing at a Cloudflare
 * R2 object (`r2://themes/{themeId}/{key}`). This module is the single
 * source of truth for that sentinel format.
 *
 * Why a separate file:
 *   - The format is referenced by `service.ts` (write path), `db-loader.ts`
 *     (read path), the seed installer, and any future admin UI. A typo in
 *     the prefix would silently break theme rendering, so the format lives
 *     in one constant.
 *   - Pure functions, no DB / no I/O. Trivial to unit test.
 *   - Importing this file is cheap and safe from any runtime (Node, Workers,
 *     tests).
 *
 * Format choice: `r2://themes/{themeId}/{key}` rather than a JSON blob.
 * Rationale:
 *   - Backwards-compatible read: a legacy inline asset is just `<liquid>`,
 *     never starts with `r2://`. We don't need a flag column.
 *   - Cheap parse: `startsWith('r2://')` then `slice(5)` — no JSON.parse on
 *     hot read path.
 *   - The themeId is encoded in the key so `duplicateTheme` mints a new
 *     R2 key per duplicated theme without sharing storage between themes
 *     (keeps cleanup simple — deleting a theme deletes only its own R2
 *     blobs).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The size threshold above which `updateThemeAsset` promotes an asset
 * from inline TEXT storage to an R2 object. 256 KB is the empirical
 * tipping point where inline storage starts hurting Postgres TOAST
 * page-cache hit rate (a typical PG page is 8 KB and TOAST chunks at
 * ~2 KB; an asset above ~30× the chunk size starts to dominate the
 * row's storage footprint).
 *
 * The Gbox Dawn seed theme (~1.5 MB total, ~50 files) has its largest
 * file `theme.css` at ~80 KB, so every Dawn file fits inline. Only
 * merchant-uploaded assets (hero videos, fat JS bundles) get promoted.
 */
export const R2_THRESHOLD_BYTES = 256 * 1024

/** Sentinel prefix for the value column when an asset lives in R2. */
export const R2_REF_PREFIX = 'r2://'

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical R2 object key for a theme asset. Stable across
 * the platform: every read/write/delete path agrees on this layout.
 *
 *   themes/{themeId}/{logicalPath}
 *
 * The themeId is part of the key so duplicating a theme produces a
 * disjoint set of R2 keys — see `r2-ref.test.ts` for the duplication
 * round-trip example.
 */
export function r2KeyForAsset(themeId: string, key: string): string {
  if (!themeId || typeof themeId !== 'string') {
    throw new Error('r2KeyForAsset: themeId is required')
  }
  if (!key || typeof key !== 'string') {
    throw new Error('r2KeyForAsset: key is required')
  }
  return `themes/${themeId}/${key}`
}

/**
 * Wrap an R2 object key into the sentinel that goes into the
 * `theme_assets.value` column.
 *
 *   formatR2Reference('themes/abc/foo.css') === 'r2://themes/abc/foo.css'
 */
export function formatR2Reference(r2Key: string): string {
  if (!r2Key || typeof r2Key !== 'string') {
    throw new Error('formatR2Reference: r2Key is required')
  }
  return `${R2_REF_PREFIX}${r2Key}`
}

/**
 * Convenience: build the full sentinel for a theme asset in one call.
 *
 *   formatR2ReferenceForAsset('abc', 'foo.css') === 'r2://themes/abc/foo.css'
 */
export function formatR2ReferenceForAsset(themeId: string, key: string): string {
  return formatR2Reference(r2KeyForAsset(themeId, key))
}

/**
 * True iff `value` looks like an R2 sentinel (starts with `r2://`).
 * Tolerant of `null`/`undefined`/non-string inputs so callers can pass
 * raw column values directly.
 */
export function isR2Reference(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(R2_REF_PREFIX)
}

/**
 * Strip the `r2://` prefix and return the underlying object key.
 * Returns `null` if the input is not an R2 reference (so callers can
 * branch on a single check).
 */
export function parseR2Reference(value: unknown): string | null {
  if (!isR2Reference(value)) return null
  return value.slice(R2_REF_PREFIX.length)
}

// ---------------------------------------------------------------------------
// Size helpers
// ---------------------------------------------------------------------------

/**
 * Compute the byte length of `value` as it would be stored in Postgres
 * TEXT (UTF-8). We use `Buffer.byteLength` so multibyte characters
 * (emoji in Vietnamese hero text, etc.) get counted correctly — a
 * `value.length` check would under-count those by ~3×.
 */
export function byteLengthUtf8(value: string): number {
  // Buffer is available in Node + bundled in Workers via the
  // `node:buffer` polyfill. We import lazily so the module stays
  // import-cheap on cold start.
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Decide whether `value` should be promoted to R2 based on its byte
 * size. Pure function — does not look at the runtime ObjectStore.
 *
 *   shouldPromoteToR2('small text', threshold) === false
 *   shouldPromoteToR2('a'.repeat(300_000), threshold) === true
 */
export function shouldPromoteToR2(
  value: string,
  threshold: number = R2_THRESHOLD_BYTES,
): boolean {
  return byteLengthUtf8(value) > threshold
}
