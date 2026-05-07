/**
 * Clone Pro v5 — menus persister (phase ⑤, runs inside `withSerializable`)
 *
 * Takes a `FlaggedMenuTree` (the output of the R3 menu guardrail), upserts
 * the menu row, wipes existing items, and re-inserts the full tree with
 * correct `parent_id`, `depth`, `position`, and `broken` flag.
 *
 * Schema deviations from the plan:
 *   - `menus` table uses `slug` + `title` — the DTO's `handle` is stored
 *     verbatim in both columns (`title = handle` is acceptable for PR1;
 *     sellers can rename in the admin UI post-clone).
 *   - `menu_items.title` (NOT `label`). `broken` + `depth` columns come
 *     from migration 091b.
 *
 * Rebuild strategy: DELETE all items for the menu, then recursively
 * re-insert. Cheaper than diffing for PR1; menus are tiny (<100 items
 * even on large stores). Re-clone always produces a clean tree.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { FlaggedMenuTree, FlaggedMenuNode } from '../validate/guardrails.js'

export interface PersistMenusResult {
  readonly menuInserted: number
  readonly itemsInserted: number
}

export async function persistMenus(
  tx: Kysely<Database>,
  shopId: string,
  tree: FlaggedMenuTree,
): Promise<PersistMenusResult> {
  // Upsert menu — title defaults to the handle; sellers can edit later.
  const menu = await tx
    .insertInto('menus')
    .values({
      shop_id: shopId,
      slug: tree.handle,
      title: tree.handle,
    })
    .onConflict((oc) =>
      oc.columns(['shop_id', 'slug']).doUpdateSet({ title: tree.handle }),
    )
    .returning('id')
    .executeTakeFirst()

  if (!menu) return { menuInserted: 0, itemsInserted: 0 }
  const menuId = menu.id as string

  // Wipe existing items — the full tree gets re-inserted below.
  await tx.deleteFrom('menu_items').where('menu_id', '=', menuId).execute()

  let itemsInserted = 0
  async function insertRec(
    nodes: readonly FlaggedMenuNode[],
    parentId: string | null,
    depth: number,
  ): Promise<void> {
    let position = 0
    for (const n of nodes) {
      // Plain INSERT — no ON CONFLICT. We DELETE'd every existing menu_item
      // for this menu on line 52 before entering insertRec, so nothing can
      // conflict. The earlier ON CONFLICT targeted
      // `idx_menu_items_menu_parent_position`, but that index is an
      // EXPRESSION index (`coalesce(parent_id::text, '')`) which Postgres
      // cannot infer as an arbiter unless the client restates the
      // expression verbatim — and the DELETE makes the whole clause
      // redundant anyway. The unique index is still valuable as a
      // defensive constraint against future bugs, but the persister
      // doesn't need it for upsert semantics.
      const row = await tx
        .insertInto('menu_items')
        .values({
          menu_id: menuId,
          parent_id: parentId,
          title: n.label,
          url: n.url,
          depth,
          position: position++,
          broken: n.broken === true,
        })
        .returning('id')
        .executeTakeFirst()

      itemsInserted++
      if (row && n.children.length > 0) {
        await insertRec(n.children, row.id as string, depth + 1)
      }
    }
  }
  await insertRec(tree.nodes, null, 0)

  return { menuInserted: 1, itemsInserted }
}
