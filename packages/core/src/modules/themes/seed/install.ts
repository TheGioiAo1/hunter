/**
 * Gbox Platform — Gbox Dawn install helper
 *
 * Decision #1 Step 1.17c. Drops the entire `GBOX_DAWN_BUNDLE` into a
 * theme via `updateThemeAsset`, so a freshly created shop has a
 * working storefront before the merchant ever opens the editor.
 *
 * Wired into:
 *
 *   - `createShop()` — every new shop gets a default theme + this
 *     install pass (Step 1.18).
 *   - admin "Reset to Gbox Dawn" button — drops every theme asset
 *     and re-installs from the bundle (future step).
 *   - migration 009 — back-fills existing shops that don't yet have
 *     a theme (Step 1.18).
 *
 * Design notes:
 *
 *   1. SEQUENTIAL writes. The bundle has ~60 small files; doing them
 *      sequentially keeps connection-pool pressure low and gives
 *      deterministic ordering for tests. Parallel `Promise.all` would
 *      shave milliseconds and risk transient deadlocks under load.
 *
 *   2. UPSERT semantics. We delegate to `updateThemeAsset`, which
 *      already handles the insert-or-update branch and (as of Step
 *      1.16) routes large bodies to R2 when an `objectStore` is
 *      wired. So this helper is implicitly R2-aware too.
 *
 *   3. SAFE TO RE-RUN. Calling `installGboxDawnTheme` twice is a
 *      no-op (every row is overwritten with identical content). The
 *      "Reset to Gbox Dawn" button uses this property: it just
 *      calls `installGboxDawnTheme` again.
 *
 *   4. NO DESTROY. We DO NOT delete pre-existing assets that aren't
 *      in the bundle. Merchants who customize the seed shouldn't
 *      lose their work on a re-install. The "reset" path will be a
 *      separate helper (`resetThemeToGboxDawn`) that explicitly
 *      truncates first.
 *
 *   5. LIVE COUNTERS. Returns a small report so callers can log
 *      install progress and tests can assert exact write counts.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { AssetStorageDeps } from '../asset-storage.js'
import { updateThemeAsset } from '../service.js'
import {
  GBOX_DAWN_BUNDLE_VERSION,
  listGboxDawnAssets,
  type GboxDawnAsset,
} from './gbox-dawn-bundle.js'

export interface InstallGboxDawnReport {
  /** Number of asset rows written. */
  installed: number
  /** The bundle version that was installed (recorded for migrations). */
  bundleVersion: string
  /** Names of every key written, in install order. */
  keys: readonly string[]
}

export interface InstallGboxDawnOptions extends AssetStorageDeps {
  /**
   * If supplied, called once per asset just BEFORE the write. Useful
   * for progress logging in CLIs / migrations.
   */
  onAsset?: (asset: GboxDawnAsset, index: number, total: number) => void
}

/**
 * Install (or re-install) every Gbox Dawn asset into a theme. The
 * theme row must already exist — this helper writes assets only.
 *
 * Throws if any single `updateThemeAsset` call throws — the install
 * is best treated as a transaction by the caller (wrap in
 * `db.transaction()` if atomicity matters).
 */
export async function installGboxDawnTheme(
  db: Kysely<Database>,
  themeId: string,
  opts: InstallGboxDawnOptions = {},
): Promise<InstallGboxDawnReport> {
  if (!themeId || typeof themeId !== 'string') {
    throw new Error('installGboxDawnTheme: themeId is required')
  }

  const assets = listGboxDawnAssets()
  const total = assets.length
  const writtenKeys: string[] = []

  for (let i = 0; i < total; i++) {
    const asset = assets[i]!
    if (opts.onAsset) {
      try {
        opts.onAsset(asset, i, total)
      } catch {
        // Logging callback errors are non-fatal — keep installing.
      }
    }
    await updateThemeAsset(
      db,
      themeId,
      asset.key,
      asset.source,
      asset.contentType,
      { objectStore: opts.objectStore, threshold: opts.threshold },
    )
    writtenKeys.push(asset.key)
  }

  return {
    installed: total,
    bundleVersion: GBOX_DAWN_BUNDLE_VERSION,
    keys: writtenKeys,
  }
}
