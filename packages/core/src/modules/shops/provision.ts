/**
 * Gbox Platform — Shop Provisioning
 *
 * Decision #1 Step 1.18. High-level orchestrator that creates a shop
 * AND installs the default Gbox Dawn theme in a single call. This is
 * the function every caller should use instead of bare `createShop`,
 * because a shop without a theme is useless on the storefront.
 *
 * Separation of concerns: `createShop` (shop service) stays pure —
 * it only writes the `shops` row. This module wires the cross-module
 * sequence: shop → theme → seed install.
 *
 * Both the API route handler and migration 009 (back-fill) call
 * through here so the install path is tested exactly once.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { AssetStorageDeps } from '../themes/asset-storage.js'
import { createShop, type CreateShopInput, type Shop } from './service.js'
import { createTheme, type Theme } from '../themes/service.js'
import {
  installGboxDawnTheme,
  type InstallGboxDawnReport,
} from '../themes/seed/install.js'
import { seedDefaultHelpPages } from '../content/default-help-pages.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisionShopResult {
  shop: Shop
  theme: Theme
  install: InstallGboxDawnReport
}

export interface ProvisionShopOptions extends AssetStorageDeps {
  /**
   * Name for the default theme. Defaults to 'Gbox Dawn'.
   */
  themeName?: string
  /**
   * Progress callback forwarded to `installGboxDawnTheme`.
   */
  onAsset?: InstallGboxDawnReport extends never
    ? never
    : Parameters<typeof installGboxDawnTheme>[2] extends { onAsset?: infer F }
      ? F
      : never
}

/**
 * Create a shop, create a default "Gbox Dawn" theme (role = main),
 * and install every seed asset. Returns the shop, the theme row,
 * and the install report.
 *
 * This is **not** wrapped in a transaction — callers who need
 * atomicity should wrap `provisionShop` in `db.transaction()`.
 */
export async function provisionShop(
  db: Kysely<Database>,
  data: CreateShopInput,
  opts: ProvisionShopOptions = {},
): Promise<ProvisionShopResult> {
  // 1. Create the shop row.
  const shop = await createShop(db, data)

  // 2. Create the main theme.
  const theme = await createTheme(db, shop.id, {
    name: opts.themeName ?? 'Gbox Dawn',
    role: 'main',
  })

  // 3. Install seed assets.
  const install = await installGboxDawnTheme(db, theme.id, {
    objectStore: opts.objectStore,
    threshold: opts.threshold,
    onAsset: opts.onAsset as any,
  })

  // 4. Seed default help pages (Fraud analysis, Prevent fraud). Non-fatal
  //    — if the insert fails we still return a provisioned shop rather
  //    than rolling the theme install back. The OrderDetail Fraud modal
  //    degrades gracefully when the pages are absent.
  try {
    await seedDefaultHelpPages(db, shop.id)
  } catch (err) {
    console.error('[provisionShop] seedDefaultHelpPages failed:', err)
  }

  return { shop, theme, install }
}

/**
 * Ensure a shop has at least one theme. If the shop already has any
 * theme row, this is a no-op. Otherwise it creates a "Gbox Dawn"
 * main theme and installs the seed.
 *
 * Used by migration 009 to back-fill existing shops.
 */
export async function ensureShopHasTheme(
  db: Kysely<Database>,
  shopId: string,
  opts: ProvisionShopOptions = {},
): Promise<{ created: boolean; theme?: Theme; install?: InstallGboxDawnReport }> {
  const existing = await db
    .selectFrom('themes')
    .select('id')
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (existing) {
    return { created: false }
  }

  const theme = await createTheme(db, shopId, {
    name: opts.themeName ?? 'Gbox Dawn',
    role: 'main',
  })

  const install = await installGboxDawnTheme(db, theme.id, {
    objectStore: opts.objectStore,
    threshold: opts.threshold,
    onAsset: opts.onAsset as any,
  })

  return { created: true, theme, install }
}
