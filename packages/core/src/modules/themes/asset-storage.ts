/**
 * Gbox Platform — Theme Asset Storage Helpers
 *
 * Decision #1 Step 1.16 — pure functions that move asset bodies in
 * and out of an `ObjectStore`. Designed so `service.ts` can stay a
 * thin layer over Postgres + delegation to these helpers, and so the
 * R2 promotion / cleanup logic can be tested with a `MemoryStore`
 * without spinning up Postgres.
 *
 * The split is:
 *   - `r2-ref.ts`        → format / parse / size pure functions (no I/O)
 *   - `asset-storage.ts` → upload / download / delete / duplicate helpers
 *                          that take an injected ObjectStore
 *   - `service.ts`       → DB writes + decides when to call the helpers
 *
 * None of these helpers touch Postgres. They only return the
 * `theme_assets.value` string the caller should write to the DB
 * (either inline source or an `r2://...` sentinel).
 */

import type { ObjectStore } from '../storage/index.js'
import {
  formatR2ReferenceForAsset,
  isR2Reference,
  parseR2Reference,
  R2_THRESHOLD_BYTES,
  r2KeyForAsset,
  shouldPromoteToR2,
} from './r2-ref.js'

// ---------------------------------------------------------------------------
// Storage decision result
// ---------------------------------------------------------------------------

/**
 * The outcome of `prepareAssetForStorage`. The caller writes
 * `valueToStore` into `theme_assets.value` and uses `kind` for logging
 * / metrics. `kind === 'r2'` means an R2 upload already happened.
 */
export interface PreparedAsset {
  kind: 'inline' | 'r2'
  /** What to store in the `theme_assets.value` column. */
  valueToStore: string
  /** Bytes the body occupies in storage (inline TEXT or R2 object). */
  byteSize: number
}

// ---------------------------------------------------------------------------
// Options for the helper functions
// ---------------------------------------------------------------------------

export interface AssetStorageDeps {
  /**
   * If supplied, large assets (> threshold) get promoted to R2 via
   * this store. If omitted, every asset stays inline regardless of
   * size — used by tests + by callers that don't want to depend on
   * the storage module.
   */
  objectStore?: ObjectStore | undefined

  /**
   * Override the default 256 KB promotion threshold. Mostly used by
   * tests so they can drive the R2 path with small payloads.
   */
  threshold?: number
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Decide where a brand-new (or updated) asset body should live and,
 * if it's going to R2, actually upload it. Returns the value the
 * caller should persist in `theme_assets.value`.
 *
 * Behavior matrix:
 *
 *   value size | objectStore | result
 *   -----------|-------------|-------------------------------
 *   ≤ threshold|   any       | inline (raw value)
 *   > threshold|   present   | R2 upload + sentinel string
 *   > threshold|   absent    | inline (with no R2 fallback)
 *
 * Why we still allow inline for big values when no objectStore is
 * passed: backwards-compat. Existing callers (admin import flow,
 * tests) didn't have an objectStore parameter; we don't want to
 * break them or force them to wire one up before the integration
 * step. The threshold guard is a soft promotion, not a hard limit.
 */
export async function prepareAssetForStorage(
  themeId: string,
  key: string,
  value: string,
  contentType: string | null | undefined,
  deps: AssetStorageDeps = {},
): Promise<PreparedAsset> {
  const threshold = deps.threshold ?? R2_THRESHOLD_BYTES
  const byteSize = Buffer.byteLength(value, 'utf8')

  if (!shouldPromoteToR2(value, threshold) || !deps.objectStore) {
    return { kind: 'inline', valueToStore: value, byteSize }
  }

  const r2Key = r2KeyForAsset(themeId, key)
  await deps.objectStore.put(r2Key, value, {
    contentType: contentType ?? undefined,
  })

  return {
    kind: 'r2',
    valueToStore: formatR2ReferenceForAsset(themeId, key),
    byteSize,
  }
}

// ---------------------------------------------------------------------------
// Cleanup path
// ---------------------------------------------------------------------------

/**
 * Best-effort delete of an R2 blob given the previous value of the
 * `theme_assets.value` column. No-op if `previousValue` is null,
 * empty, or not an R2 reference, or if no objectStore is supplied.
 *
 * Idempotent: if the key has already been deleted, the underlying
 * `objectStore.delete` is a no-op. We swallow errors and log them via
 * the optional `onError` hook so a stale R2 blob never blocks a DB
 * write.
 */
export async function deleteAssetIfR2(
  previousValue: string | null | undefined,
  deps: AssetStorageDeps = {},
  onError?: (err: unknown) => void,
): Promise<void> {
  if (!deps.objectStore) return
  const r2Key = parseR2Reference(previousValue)
  if (r2Key === null) return
  try {
    await deps.objectStore.delete(r2Key)
  } catch (err) {
    if (onError) onError(err)
  }
}

/**
 * When updating an existing asset, we may be replacing an R2 blob
 * with a new R2 blob (same key — handled by overwrite), or with an
 * inline value (need to delete the old R2 blob), or replacing an
 * inline value with an R2 blob (no cleanup needed). This helper
 * resolves all three cases for the caller.
 *
 *   prev  | next  | action
 *   ------|-------|----------------------------------------------
 *   inline| inline| nothing
 *   inline| r2    | nothing (no orphan; the new put already ran)
 *   r2 (k)| r2 (k)| nothing (the put overwrote in place)
 *   r2 (k)| inline| delete prev R2 blob
 *   r2 (a)| r2 (b)| delete prev R2 blob (different key — should not
 *                   happen with our keying scheme but defended)
 */
export async function reconcileAssetReplacement(
  previousValue: string | null | undefined,
  nextValueToStore: string,
  deps: AssetStorageDeps = {},
  onError?: (err: unknown) => void,
): Promise<void> {
  const prevKey = parseR2Reference(previousValue)
  const nextKey = parseR2Reference(nextValueToStore)
  if (prevKey === null) return // prev was inline → nothing to clean
  if (nextKey !== null && nextKey === prevKey) return // overwrite in place
  await deleteAssetIfR2(previousValue, deps, onError)
}

// ---------------------------------------------------------------------------
// Duplication path
// ---------------------------------------------------------------------------

/**
 * For `duplicateTheme`: given an asset row from the source theme,
 * compute the value the new theme should store. If the source value
 * is inline, we copy it verbatim. If it's an R2 reference, we
 * download the body and re-upload it under the destination theme's
 * R2 key.
 *
 * Returns the value to insert into the new `theme_assets` row.
 *
 * If the source is r2:// but no objectStore is supplied OR the source
 * blob can't be fetched (deleted out from under us), we throw — the
 * alternative is silently dropping content during a duplication,
 * which is worse than failing loudly. The caller catches and surfaces
 * the error.
 */
export async function duplicateAsset(
  sourceValue: string | null,
  sourceContentType: string | null,
  destThemeId: string,
  destKey: string,
  deps: AssetStorageDeps = {},
): Promise<string | null> {
  if (sourceValue === null) return null
  if (!isR2Reference(sourceValue)) {
    return sourceValue // inline copy
  }

  if (!deps.objectStore) {
    throw new Error(
      `duplicateAsset: source asset ${destKey} is in R2 but no objectStore was provided`,
    )
  }

  const sourceR2Key = parseR2Reference(sourceValue)
  if (sourceR2Key === null) {
    // Defensive — isR2Reference returned true but parse failed.
    throw new Error(`duplicateAsset: malformed R2 reference: ${sourceValue}`)
  }

  const body = await deps.objectStore.get(sourceR2Key)
  if (body === null) {
    throw new Error(
      `duplicateAsset: source R2 blob ${sourceR2Key} not found (orphaned reference?)`,
    )
  }

  const destR2Key = r2KeyForAsset(destThemeId, destKey)
  await deps.objectStore.put(destR2Key, body, {
    contentType: sourceContentType ?? undefined,
  })

  return formatR2ReferenceForAsset(destThemeId, destKey)
}
