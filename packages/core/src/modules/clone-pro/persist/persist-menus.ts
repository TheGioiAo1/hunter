/**
 * Clone Pro — Menu Persistence
 *
 * Persists scraped navigation menus into the Gbox database.
 * Creates menus and menu items with correct parent-child hierarchy.
 * Uses the existing content/service.ts createMenu() and addMenuItem().
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { createMenu, addMenuItem } from '../../content/service.js'
import type { ScrapedMenuItem, ScrapedMenus } from '../scrapers/menu-scraper.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistMenusResult {
  readonly menusCreated: number
  readonly itemsCreated: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist scraped menus (main + footer) into the database.
 * Creates menu records and inserts menu items with hierarchy.
 *
 * @param db - Kysely database instance
 * @param shopId - Target shop UUID
 * @param menus - ScrapedMenus from the menu scraper
 * @returns Count of menus and items created
 */
export async function persistCloneMenus(
  db: Kysely<Database>,
  shopId: string,
  menus: ScrapedMenus,
  jobId: string | null = null,
): Promise<PersistMenusResult> {
  let menusCreated = 0
  let itemsCreated = 0

  // Helper: stamp clone_job_id on the freshly-created menu row.
  const stamp = async (menuId: string) => {
    if (!jobId) return
    await db
      .updateTable('menus')
      .set({ clone_job_id: jobId } as any)
      .where('id', '=', menuId)
      .execute()
  }

  // --- Main Menu ---
  if (menus.main_menu.length > 0) {
    try {
      // Delete existing main-menu if present (re-clone scenario)
      const existingMain = await db
        .selectFrom('menus')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('slug', '=', 'main-menu')
        .executeTakeFirst()

      if (existingMain) {
        await db.deleteFrom('menu_items').where('menu_id', '=', existingMain.id).execute()
        await db.deleteFrom('menus').where('id', '=', existingMain.id).execute()
      }

      const menu = await createMenu(db, shopId, {
        title: 'Main Menu',
        slug: 'main-menu',
      })
      await stamp(menu.id)
      menusCreated++

      const count = await insertMenuItems(db, menu.id, menus.main_menu)
      itemsCreated += count
    } catch (err) {
      console.warn('[persist-menus] Failed to create main menu:', (err as Error).message)
    }
  }

  // --- Footer Menu ---
  if (menus.footer_menu.length > 0) {
    try {
      // Delete existing footer-menu if present
      const existingFooter = await db
        .selectFrom('menus')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('slug', '=', 'footer-menu')
        .executeTakeFirst()

      if (existingFooter) {
        await db.deleteFrom('menu_items').where('menu_id', '=', existingFooter.id).execute()
        await db.deleteFrom('menus').where('id', '=', existingFooter.id).execute()
      }

      const menu = await createMenu(db, shopId, {
        title: 'Footer Menu',
        slug: 'footer-menu',
      })
      await stamp(menu.id)
      menusCreated++

      const count = await insertMenuItems(db, menu.id, menus.footer_menu)
      itemsCreated += count
    } catch (err) {
      console.warn('[persist-menus] Failed to create footer menu:', (err as Error).message)
    }
  }

  return { menusCreated, itemsCreated }
}

// ---------------------------------------------------------------------------
// Recursive menu item insertion
// ---------------------------------------------------------------------------

async function insertMenuItems(
  db: Kysely<Database>,
  menuId: string,
  items: ScrapedMenuItem[],
  parentId: string | null = null,
  startPosition = 0,
): Promise<number> {
  let count = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    try {
      const menuItem = await addMenuItem(db, menuId, {
        parent_id: parentId || undefined,
        title: item.title,
        url: item.url || null,
        position: startPosition + i,
      })
      count++

      // Insert children recursively
      if (item.children.length > 0) {
        const childCount = await insertMenuItems(
          db, menuId, item.children, menuItem.id, 0,
        )
        count += childCount
      }
    } catch (err) {
      console.warn(`[persist-menus] Failed to insert item "${item.title}":`, (err as Error).message)
    }
  }

  return count
}
