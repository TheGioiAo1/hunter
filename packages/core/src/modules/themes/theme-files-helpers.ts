/**
 * theme-files helpers — shared utilities for inserting `theme_files` rows.
 *
 * Why this file exists:
 *   The `theme_files` table has a UNIQUE INDEX on `(shop_id, source_url)`
 *   (idx_theme_files_shop_source_url) that the original schema authors
 *   added for clone-pro: each cloned file came from a unique URL on the
 *   source site, so the index doubled as a "have we already imported
 *   this asset?" guard. That assumption breaks for any code path that
 *   inserts theme_files WITHOUT a real source URL — bundled default
 *   theme files, zip imports, version restores, all of them have NO
 *   external URL. The historical workaround was to set source_url=''
 *   for every row. With the UNIQUE index, the first row inserts fine
 *   and every subsequent row throws "duplicate key value violates
 *   unique constraint idx_theme_files_shop_source_url".
 *
 *   Three production-blocking bugs Thai surfaced today (install Gbox
 *   Default, import zip theme, restore version) all hit this exact
 *   code smell. The fix here is to synthesize a deterministically
 *   unique `gbox://theme/<themeId>/<path>` URL so every row's
 *   (shop_id, source_url) tuple is genuinely unique.
 *
 *   Why not strip the index? Because clone-pro DEPENDS on the index
 *   for de-duping repeat clones of the same source asset. Touching
 *   migrations to drop it would break clone-pro's idempotency guard.
 *
 *   Why a helper instead of inlining at every call site? Three
 *   call sites today (install-default, theme-zip-importer, versions
 *   restore) and the count grows over time. Centralising the URL
 *   shape means a future schema change only edits one file. The
 *   tests assert the shape so a regression there fails CI loudly.
 */

const PREFIX = 'gbox://theme/'

/**
 * Build a synthetic, deterministic, per-row source_url for a theme
 * file that has no real external origin. The output is guaranteed
 * unique within a (themeId, path) pair, which means callers writing
 * 11 files for the same theme produce 11 distinct source_url values
 * — satisfying the (shop_id, source_url) UNIQUE constraint without
 * any extra coordination.
 *
 *   synthesizeThemeFileSourceUrl('a9eeb3f6...', 'layout/theme.liquid')
 *   → 'gbox://theme/a9eeb3f6.../layout/theme.liquid'
 *
 * The `gbox://` scheme is intentionally chosen to be NOT a valid HTTP
 * URL — anything that tries to fetch this address will fail loudly
 * rather than silently 200ing on a real site.
 */
export function synthesizeThemeFileSourceUrl(
  themeId: string,
  filePath: string,
): string {
  // Sanity: the inputs are already validated by the time they reach
  // this function (themeId from DB, path from DEFAULT_THEME_FILES /
  // unzipped archive / snapshot). We don't strip or normalize — the
  // exact same input must produce the exact same output every time
  // so re-runs (e.g. version restore) deterministically generate the
  // same URL and idempotent queries can match it.
  return `${PREFIX}${themeId}/${filePath}`
}

/**
 * True when the URL was synthesized by this module — used by
 * downstream code (audit log, exports) to decide whether to surface
 * the URL to the seller. We don't show `gbox://` URLs in the UI
 * because they're internal placeholders.
 */
export function isSynthesizedThemeFileSourceUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.startsWith(PREFIX)
}
