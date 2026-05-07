/**
 * Clone Library — Theme clone service (Phase 4.2)
 *
 * When a seller pays to clone a site, the produced theme becomes a
 * reusable asset in their Clone Library. From the Library they can:
 *
 *   - Apply the theme to the current store they're logged into
 *   - Apply the theme to any OTHER store the same seller owns
 *   - Pick the theme at "create 2nd store" time
 *
 * This module is the data layer behind those actions. It copies a
 * source theme row + all its `theme_assets` into the target shop and
 * stamps `cloned_from_theme_id` so the Library can render the
 * ancestry chain.
 *
 * Access control is NOT done here — this service trusts its caller
 * (the HTTP route at Phase 4.6 checks that the logged-in user owns
 * both shops). This split keeps the service unit-testable with a
 * plain Kysely instance.
 *
 * Why we don't extend `themes/service.ts#duplicateTheme`:
 *
 *   `duplicateTheme` copies within the same shop (carries `shop_id`
 *   over, leaves `cloned_from_theme_id` NULL). Both of those behaviors
 *   are correct for the "duplicate" action in the theme editor — we
 *   don't want Library side-effects leaking into every duplicate. So
 *   we have a separate service here that does the Library-specific
 *   shop-switch + ancestry stamp.
 *
 * Contract:
 *
 *   - Source theme must exist. If not, throws `THEME_NOT_FOUND`.
 *   - Target shop must exist. If not, the `shop_id` FK will trip at
 *     insert time. We don't pre-check — the route layer already
 *     validated the shop before calling us.
 *   - `activate: true` promotes the new theme to 'main' and demotes
 *     any existing main in the target shop (atomic via
 *     `setActiveTheme`). `activate: false` leaves it 'unpublished'.
 *   - If copying assets fails partway, the theme row still exists
 *     (no transaction wrap, matching `duplicateTheme`'s behavior).
 *     Callers can delete via `deleteTheme` to reclaim.
 *
 * Ancestry semantics:
 *
 *   - `cloned_from_theme_id` is stamped with the SOURCE theme's id.
 *     If the source is itself a copy, we still point to it — not to
 *     the original root. The Library can walk the chain if needed.
 *   - `source_clone_job_id` is NOT inherited. Only the ORIGINAL theme
 *     (the one produced by the clone pipeline) carries that link.
 *     Library copies intentionally drop it so the Library shows one
 *     card per job, not one per copy of that job's output.
 */

import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { duplicateAsset, type AssetStorageDeps } from '../../themes/asset-storage.js'
import { setActiveTheme } from '../../themes/service.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CloneThemeToShopInput {
  /** The theme row in the Clone Library we're copying FROM. */
  readonly sourceThemeId: string
  /** The shop receiving the new theme copy. */
  readonly targetShopId: string
  /**
   * Optional override for the new theme's display name. If absent we
   * reuse the source theme's `name`. The Library's UI will typically
   * leave this empty so the ancestry chain stays readable.
   */
  readonly newName?: string
  /**
   * When true, demote any existing 'main' theme in `targetShopId` and
   * promote the new copy to 'main'. Matches the "Apply to this store"
   * Library action. When false, the copy lands as 'unpublished' and
   * the merchant can activate later via the theme editor — matches
   * the "Keep as inactive copy" option from Thai's Q2.
   */
  readonly activate?: boolean
  /**
   * Injected R2 object store. Only needed if the source theme has
   * any assets stored in R2 (value begins with `r2://`). Inline
   * assets work without this. Passed through to `duplicateAsset`.
   */
  readonly deps?: AssetStorageDeps
}

export interface CloneThemeToShopResult {
  /** The new theme's id in the target shop. */
  readonly themeId: string
  /** Final role after the operation — 'main' if `activate`, else 'unpublished'. */
  readonly role: 'main' | 'unpublished'
  /** How many asset rows were copied over. */
  readonly assetsCopied: number
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export class CloneLibraryError extends Error {
  public readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CloneLibraryError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Copy a theme from the Clone Library into a target shop.
 *
 * This is a cross-shop operation — the source theme's `shop_id` can
 * differ from `targetShopId`. Ownership of both shops MUST be
 * enforced at the route layer (Phase 4.6) before this runs.
 *
 * Returns the new theme's id and asset-copy stats so the UI can
 * show a confirmation toast.
 */
export async function cloneThemeToShop(
  db: Kysely<Database>,
  input: CloneThemeToShopInput,
): Promise<CloneThemeToShopResult> {
  const { sourceThemeId, targetShopId, newName, activate = false, deps = {} } = input

  // 1. Load source theme (must exist).
  const source = await db
    .selectFrom('themes')
    .selectAll()
    .where('id', '=', sourceThemeId)
    .executeTakeFirst()

  if (!source) {
    throw new CloneLibraryError('THEME_NOT_FOUND', `Theme ${sourceThemeId} not found`)
  }

  // 2. Insert new theme in target shop, role='unpublished' (promote
  //    later if activate=true). We go through raw Kysely to stamp
  //    `cloned_from_theme_id` at insert time rather than as a
  //    follow-up UPDATE — one fewer round-trip and avoids a transient
  //    window where the row exists without ancestry.
  const newTheme = await (db as any)
    .insertInto('themes')
    .values({
      shop_id: targetShopId,
      name: newName ?? source.name,
      role: 'unpublished',
      cloned_from_theme_id: sourceThemeId,
      // NOTE: source_clone_job_id deliberately NOT copied. See module
      // docstring — only the original theme carries that link.
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  // 3. Copy all assets. Reuse the same R2-aware `duplicateAsset`
  //    helper that `duplicateTheme` uses so inline vs R2 bodies are
  //    handled identically. Sequential loop (asset counts are ~50).
  const assets = await db
    .selectFrom('theme_assets')
    .selectAll()
    .where('theme_id', '=', sourceThemeId)
    .execute()

  let assetsCopied = 0
  if (assets.length > 0) {
    const copiedRows: Array<{
      theme_id: string
      key: string
      value: string | null
      content_type: string | null
      size: number | null
    }> = []

    for (const a of assets) {
      const newValue = await duplicateAsset(
        a.value ?? null,
        a.content_type ?? null,
        newTheme.id,
        a.key,
        deps,
      )
      copiedRows.push({
        theme_id: newTheme.id,
        key: a.key,
        value: newValue,
        content_type: a.content_type,
        size: a.size,
      })
    }

    await db.insertInto('theme_assets').values(copiedRows as any).execute()
    assetsCopied = copiedRows.length
  }

  // 4. Optionally promote to 'main'. `setActiveTheme` wraps the
  //    demote+promote in a transaction so we never end up with two
  //    'main' rows or zero 'main' rows.
  let finalRole: 'main' | 'unpublished' = 'unpublished'
  if (activate) {
    await setActiveTheme(db, targetShopId, newTheme.id)
    finalRole = 'main'
  }

  return {
    themeId: newTheme.id,
    role: finalRole,
    assetsCopied,
  }
}

/**
 * Convenience wrapper: clone + activate in one call. Used by the
 * "Apply to this store" Library action where the merchant always
 * wants the theme live immediately.
 */
export async function applyClonedTheme(
  db: Kysely<Database>,
  input: Omit<CloneThemeToShopInput, 'activate'>,
): Promise<CloneThemeToShopResult> {
  return cloneThemeToShop(db, { ...input, activate: true })
}

// ---------------------------------------------------------------------------
// Pre-flight: does this shop already have a copy of the source theme?
// ---------------------------------------------------------------------------

/**
 * Lookup: has `targetShopId` already cloned `sourceThemeId` before?
 *
 * Returns the existing copy's id (preferring an active 'main' copy
 * over any 'unpublished' copies) so the UI can say "already applied"
 * instead of silently duplicating.
 *
 * This is a soft check — the UI can decide whether to block the
 * re-clone or allow a fresh copy. The clone service itself does not
 * enforce uniqueness (sellers might legitimately want two copies
 * for A/B testing).
 */
export async function findExistingClone(
  db: Kysely<Database> | Transaction<Database>,
  params: { readonly sourceThemeId: string; readonly targetShopId: string },
): Promise<{ readonly themeId: string; readonly role: string } | null> {
  // 'main' (active) sorts after 'demo' / 'unpublished' alphabetically,
  // but we want the active one on top if present. Explicit CASE via
  // sql`` gives us that ordering without reaching into Kysely's
  // dynamic-ref escape hatch (which TS can't always type-check).
  const row = await (db as any)
    .selectFrom('themes')
    .select(['id', 'role'])
    .where('shop_id', '=', params.targetShopId)
    .where('cloned_from_theme_id', '=', params.sourceThemeId)
    .orderBy(sql`CASE WHEN role='main' THEN 0 ELSE 1 END`, 'asc')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()

  if (!row) return null
  return { themeId: row.id, role: row.role }
}
