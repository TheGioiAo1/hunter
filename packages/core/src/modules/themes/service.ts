/**
 * Gbox Platform — Theme Management Service
 *
 * Theme CRUD, asset management, active theme selection, and duplication.
 *
 * Decision #1 Step 1.16 — `updateThemeAsset` / `deleteThemeAsset` /
 * `duplicateTheme` accept an optional `deps.objectStore` so any asset
 * larger than 256 KB is automatically promoted to Cloudflare R2 instead
 * of bloating the `theme_assets.value` TEXT column. The R2 sentinel
 * format and the actual upload/cleanup helpers live in `r2-ref.ts` +
 * `asset-storage.ts` so the decision logic stays unit-testable without
 * a Postgres mock. Callers that don't pass `deps.objectStore` get the
 * legacy inline-only behavior — backwards compatible.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  deleteAssetIfR2,
  duplicateAsset,
  prepareAssetForStorage,
  reconcileAssetReplacement,
  type AssetStorageDeps,
} from './asset-storage.js'

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

type Selectable<T> = { [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any> ? S : T[K] }

export type Theme = Selectable<Database['themes']>
export type ThemeAsset = Selectable<Database['theme_assets']>

export interface CreateThemeInput {
  name: string
  role?: 'main' | 'unpublished' | 'demo'
}

export interface ThemeWithAssetCount extends Theme {
  assetCount: number
}

// ---------------------------------------------------------------------------
// Theme CRUD
// ---------------------------------------------------------------------------

/**
 * List all themes for a shop.
 */
export async function listThemes(
  db: Kysely<Database>,
  shopId: string,
): Promise<Theme[]> {
  const rows = await db
    .selectFrom('themes')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('role', 'asc')
    .orderBy('name', 'asc')
    .execute()

  return rows as Theme[]
}

/**
 * Get a theme by ID with asset count.
 */
export async function getTheme(
  db: Kysely<Database>,
  themeId: string,
): Promise<ThemeWithAssetCount | null> {
  const theme = await db
    .selectFrom('themes')
    .selectAll()
    .where('id', '=', themeId)
    .executeTakeFirst()

  if (!theme) return null

  const countRow = await db
    .selectFrom('theme_assets')
    .select(db.fn.countAll<number>().as('count'))
    .where('theme_id', '=', themeId)
    .executeTakeFirstOrThrow()

  return {
    ...(theme as Theme),
    assetCount: Number(countRow.count),
  }
}

/**
 * Create a new theme for a shop.
 */
export async function createTheme(
  db: Kysely<Database>,
  shopId: string,
  data: CreateThemeInput,
): Promise<Theme> {
  const row = await db
    .insertInto('themes')
    .values({
      shop_id: shopId,
      name: data.name,
      role: data.role ?? 'unpublished',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as Theme
}

/**
 * Delete a theme and all its assets.
 */
export async function deleteTheme(
  db: Kysely<Database>,
  themeId: string,
): Promise<void> {
  // Check that it is not the active theme
  const theme = await db
    .selectFrom('themes')
    .select(['id', 'role'])
    .where('id', '=', themeId)
    .executeTakeFirst()

  if (!theme) {
    throw new Error(`Theme ${themeId} not found`)
  }

  if (theme.role === 'main') {
    throw new Error('Cannot delete the active (main) theme. Set another theme as active first.')
  }

  // Delete assets first, then the theme
  await db.deleteFrom('theme_assets').where('theme_id', '=', themeId).execute()
  await db.deleteFrom('themes').where('id', '=', themeId).execute()
}

/**
 * Set a theme as the active (main) theme for its shop.
 * All other themes in the shop are set to 'unpublished'.
 */
export async function setActiveTheme(
  db: Kysely<Database>,
  shopId: string,
  themeId: string,
): Promise<void> {
  // Verify theme exists and belongs to this shop
  const theme = await db
    .selectFrom('themes')
    .select(['id', 'shop_id'])
    .where('id', '=', themeId)
    .executeTakeFirst()

  if (!theme) {
    throw new Error(`Theme ${themeId} not found`)
  }
  if (theme.shop_id !== shopId) {
    throw new Error(`Theme ${themeId} does not belong to shop ${shopId}`)
  }

  // Wrap both updates in a transaction to avoid inconsistent state
  await db.transaction().execute(async (trx) => {
    // Set all themes for this shop to 'unpublished'
    await trx
      .updateTable('themes')
      .set({ role: 'unpublished', updated_at: new Date().toISOString() } as any)
      .where('shop_id', '=', shopId)
      .where('role', '=', 'main')
      .execute()

    // Set the target theme to 'main'
    await trx
      .updateTable('themes')
      .set({ role: 'main', updated_at: new Date().toISOString() } as any)
      .where('id', '=', themeId)
      .execute()
  })
}

// ---------------------------------------------------------------------------
// Theme Assets
// ---------------------------------------------------------------------------

/**
 * Get a single theme asset by key.
 */
export async function getThemeAsset(
  db: Kysely<Database>,
  themeId: string,
  key: string,
): Promise<ThemeAsset | null> {
  const row = await db
    .selectFrom('theme_assets')
    .selectAll()
    .where('theme_id', '=', themeId)
    .where('key', '=', key)
    .executeTakeFirst()

  return (row as ThemeAsset) ?? null
}

/**
 * Create or update a theme asset.
 *
 * Decision #1 Step 1.16 — if `deps.objectStore` is supplied and the
 * value exceeds 256 KB, the body is uploaded to R2 and the column
 * stores an `r2://themes/{themeId}/{key}` sentinel instead of inline
 * source. When the previous row was in R2 and the new value lives
 * elsewhere, the old R2 blob is cleaned up via
 * `reconcileAssetReplacement`.
 */
export async function updateThemeAsset(
  db: Kysely<Database>,
  themeId: string,
  key: string,
  value: string,
  contentType?: string,
  deps: AssetStorageDeps = {},
): Promise<ThemeAsset> {
  const existing = await db
    .selectFrom('theme_assets')
    .select(['id', 'value'])
    .where('theme_id', '=', themeId)
    .where('key', '=', key)
    .executeTakeFirst()

  // Decide where the new body should live (inline or R2). This call
  // is side-effecting only when the R2 path runs (it issues the put).
  const prepared = await prepareAssetForStorage(
    themeId,
    key,
    value,
    contentType ?? null,
    deps,
  )

  if (existing) {
    // Clean up the previous R2 blob if we're moving away from it.
    await reconcileAssetReplacement(
      existing.value ?? null,
      prepared.valueToStore,
      deps,
    )

    const row = await db
      .updateTable('theme_assets')
      .set({
        value: prepared.valueToStore,
        content_type: contentType ?? null,
        size: prepared.byteSize,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow()

    return row as ThemeAsset
  }

  const row = await db
    .insertInto('theme_assets')
    .values({
      theme_id: themeId,
      key,
      value: prepared.valueToStore,
      content_type: contentType ?? null,
      size: prepared.byteSize,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as ThemeAsset
}

/**
 * Delete a theme asset by key.
 *
 * Decision #1 Step 1.16 — if the row's value is an R2 sentinel and
 * `deps.objectStore` is supplied, the underlying R2 blob is deleted
 * before the row. Errors from the R2 delete are swallowed (logged
 * via `console.warn`) so a stale R2 blob never blocks a DB delete.
 */
export async function deleteThemeAsset(
  db: Kysely<Database>,
  themeId: string,
  key: string,
  deps: AssetStorageDeps = {},
): Promise<void> {
  // Read the previous value first so we can clean up the R2 blob
  // (if any) before nuking the row.
  const existing = await db
    .selectFrom('theme_assets')
    .select('value')
    .where('theme_id', '=', themeId)
    .where('key', '=', key)
    .executeTakeFirst()

  if (existing) {
    await deleteAssetIfR2(existing.value ?? null, deps, (err) => {
      console.warn(
        `[themes/service] R2 delete failed for ${themeId}/${key}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }

  await db
    .deleteFrom('theme_assets')
    .where('theme_id', '=', themeId)
    .where('key', '=', key)
    .execute()
}

/**
 * List all assets for a theme.
 */
export async function listThemeAssets(
  db: Kysely<Database>,
  themeId: string,
): Promise<ThemeAsset[]> {
  const rows = await db
    .selectFrom('theme_assets')
    .selectAll()
    .where('theme_id', '=', themeId)
    .orderBy('key', 'asc')
    .execute()

  return rows as ThemeAsset[]
}

// ---------------------------------------------------------------------------
// Theme asset search (Phase 7 PR4 — Shopify-style file finder)
// ---------------------------------------------------------------------------

export interface ThemeAssetSearchHit {
  /** The asset key (e.g. `templates/product.liquid`). */
  readonly key: string
  /**
   * First matching line in the file body when `mode` includes `content`,
   * clipped to 200 chars so payloads stay small. Null when the match
   * was filename-only (key contains `q` but body didn't scan), when
   * the row lives in R2 (value is a sentinel, not the source), or
   * when no line matched.
   */
  readonly snippet: string | null
  /** 1-based line number of the snippet; null under the same conditions. */
  readonly lineNumber: number | null
  /**
   * 'filename' when only the key matched, 'content' when only the body
   * matched, 'both' when both matched. Lets the UI render a small
   * "in filename" / "in content" badge next to each hit.
   */
  readonly matchType: 'filename' | 'content' | 'both'
}

export interface SearchThemeAssetsOpts {
  /** Max hits returned. Default 50 — the UI is a modal, not an infinite list. */
  readonly limit?: number
  /**
   * Which surfaces to scan:
   *   - 'filename' — just asset keys (cheap, always runs).
   *   - 'content'  — just asset body (ILIKE on `value`).
   *   - 'both'     — union (keys OR bodies); default.
   * When the seller passes `mode=filename` we skip the ILIKE-on-`value`
   * scan entirely — cheaper on themes with ~500 assets.
   */
  readonly mode?: 'filename' | 'content' | 'both'
  /**
   * Optional extension filter (e.g. `.liquid`, `.css`). Only hits
   * whose `key` ends with this suffix are returned. Case-insensitive;
   * no leading dot is also accepted.
   */
  readonly ext?: string | null
}

/**
 * Search theme assets by filename and/or body content. Used by the
 * editor's Ctrl+Shift+F panel.
 *
 * Semantics:
 *   - `q` is trimmed + lowercased before use. Empty/whitespace-only
 *     input returns `[]` — we never list every asset from search.
 *   - Matches are sorted: exact key match > key prefix > key contains
 *     > content match, then by key ascending.
 *   - Rows whose `value` is an R2 sentinel (`r2://…`) are included in
 *     filename results but skipped by content scan — grepping R2 blobs
 *     on every keystroke would blow up the editor's response time.
 *     The returned hit's `snippet` is null for those rows.
 *   - Never scans across themes. Callers that need shop-wide file
 *     search must fan out themselves.
 */
export async function searchThemeAssets(
  db: Kysely<Database>,
  themeId: string,
  q: string,
  opts: SearchThemeAssetsOpts = {},
): Promise<ThemeAssetSearchHit[]> {
  const needle = q.trim().toLowerCase()
  if (!needle) return []

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
  const mode = opts.mode ?? 'both'

  // Normalise the optional extension filter — tolerate `.liquid`, `liquid`.
  const extRaw = (opts.ext ?? '').trim().toLowerCase()
  const ext = extRaw ? (extRaw.startsWith('.') ? extRaw : `.${extRaw}`) : null

  // Load the full asset set for this theme — the `theme_assets.value`
  // column is TEXT and the editor targets themes with a few hundred
  // assets at most; paging on the Kysely side isn't worth the extra
  // round trips. If theme sizes grow significantly, revisit.
  const rows = await db
    .selectFrom('theme_assets')
    .select(['key', 'value'])
    .where('theme_id', '=', themeId)
    .orderBy('key', 'asc')
    .execute()

  const hits: ThemeAssetSearchHit[] = []

  for (const row of rows as Array<{ key: string; value: string | null }>) {
    const key = row.key
    if (ext && !key.toLowerCase().endsWith(ext)) continue

    const keyLower = key.toLowerCase()
    const keyMatches = mode !== 'content' && keyLower.includes(needle)

    let snippet: string | null = null
    let lineNumber: number | null = null
    let bodyMatches = false

    if (mode !== 'filename' && row.value && !isR2Sentinel(row.value)) {
      const found = findFirstMatch(row.value, needle)
      if (found) {
        bodyMatches = true
        snippet = found.snippet
        lineNumber = found.lineNumber
      }
    }

    if (!keyMatches && !bodyMatches) continue

    hits.push({
      key,
      snippet,
      lineNumber,
      matchType:
        keyMatches && bodyMatches
          ? 'both'
          : keyMatches
            ? 'filename'
            : 'content',
    })
  }

  // Prioritise: exact key → prefix → contains → content-only, then by key.
  hits.sort((a, b) => {
    const aRank = matchRank(a, needle)
    const bRank = matchRank(b, needle)
    if (aRank !== bRank) return aRank - bRank
    return a.key.localeCompare(b.key)
  })

  return hits.slice(0, limit)
}

/** Returns true when `value` is the `r2://…` indirection sentinel. */
function isR2Sentinel(value: string): boolean {
  return value.startsWith('r2://')
}

/**
 * Linear scan for the first line containing `needle`. Returns the
 * trimmed line (up to 200 chars) and its 1-based line number, or null
 * when nothing matches. We intentionally don't use regex so odd chars
 * in `needle` (`.`, `*`, brackets…) behave literally.
 */
function findFirstMatch(
  body: string,
  needle: string,
): { snippet: string; lineNumber: number } | null {
  const lower = body.toLowerCase()
  const idx = lower.indexOf(needle)
  if (idx === -1) return null

  // Map char offset back to line number: count newlines before the hit.
  let lineNumber = 1
  for (let i = 0; i < idx; i++) {
    if (body[i] === '\n') lineNumber++
  }

  // Extract the matching line (from nearest \n before idx to nearest \n after).
  const start = body.lastIndexOf('\n', idx - 1) + 1
  const endRaw = body.indexOf('\n', idx)
  const end = endRaw === -1 ? body.length : endRaw
  const line = body.slice(start, end).trim().slice(0, 200)

  return { snippet: line, lineNumber }
}

function matchRank(hit: ThemeAssetSearchHit, needle: string): number {
  const k = hit.key.toLowerCase()
  if (k === needle) return 0 // exact
  if (k.startsWith(needle)) return 1 // prefix
  if (k.includes(needle)) return 2 // contains
  return 3 // content-only (matchType === 'content')
}

/**
 * Duplicate a theme (including all its assets) with a new name.
 *
 * Decision #1 Step 1.16 — for any source asset whose value is an R2
 * sentinel, the body is fetched from R2 and re-uploaded under the
 * new theme's R2 key (`themes/{newThemeId}/{key}`). Inline assets
 * are copied verbatim. If `deps.objectStore` is missing and the
 * source has any R2 assets, `duplicateAsset` throws — we refuse to
 * silently drop content during a duplication.
 */
export async function duplicateTheme(
  db: Kysely<Database>,
  themeId: string,
  newName: string,
  deps: AssetStorageDeps = {},
): Promise<Theme> {
  // Get original theme
  const original = await db
    .selectFrom('themes')
    .selectAll()
    .where('id', '=', themeId)
    .executeTakeFirst()

  if (!original) {
    throw new Error(`Theme ${themeId} not found`)
  }

  // Create the new theme
  const newTheme = await db
    .insertInto('themes')
    .values({
      shop_id: original.shop_id,
      name: newName,
      role: 'unpublished',
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  // Copy all assets — sequentially so an R2 fetch failure stops the
  // copy loop with a meaningful error rather than half-populating
  // the new theme. Theme asset counts are small (~50), serial copy
  // is fine.
  const assets = await db
    .selectFrom('theme_assets')
    .selectAll()
    .where('theme_id', '=', themeId)
    .execute()

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
  }

  return newTheme as Theme
}
