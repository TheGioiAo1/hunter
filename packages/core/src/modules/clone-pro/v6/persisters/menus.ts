/**
 * Clone Pro v6 — menus persister (L17 provenance-aware)
 *
 * Persists MenuDTO[] into the `menus` table and their items into
 * `menu_items` with recursive parent_id linking.
 * Respects L17: menus with source='edited' or source='manual' are NEVER
 * overwritten by a re-clone.
 *
 * Schema deviations from the task plan (schema wins):
 *   - menus.slug  (NOT `handle`) — sourceHandle maps to slug, confirmed
 *     from MenuTable in tables.ts.
 *   - menu_items HAS a `source` column (migration 097) — but since a full
 *     re-clone wipes and rebuilds items anyway (the item tree structure can
 *     change entirely), we use delete-all + reinsert for clone-sourced menus.
 *     The deleted menu_items were originally clone-written so no seller edits
 *     are lost; if the parent menu is source='edited' the whole menu is
 *     skipped before we reach the item delete step.
 *   - menu_items has `depth` (Generated<number>, default 0) — we populate
 *     it explicitly from the recursion depth so the admin UI tree renders
 *     without a separate denormalisation pass.
 *   - menu_items has `broken` (Generated<boolean>, default false) — omitted
 *     on insert (DB default covers it).
 *   - menu_items has no `clone_job_id` column — not stored at item level.
 */

import type { BucketPersister, PersistInput, PersistResult } from './types.js'
import type { MenuDTO, MenuItemDTO } from '../scrapers/types.js'
import { withSerializable } from '../../../db/transaction.js'
import { shouldOverwriteOnReclone } from './snapshot.js'

export const menusPersister: BucketPersister<MenuDTO> = {
  bucketName: 'menus',

  async persist(input: PersistInput<MenuDTO>): Promise<PersistResult> {
    const out: PersistResult = { inserted: 0, updated: 0, skippedEdited: 0, errors: [] }

    await withSerializable(input.db, async (trx) => {
      for (const dto of input.dtos) {
        try {
          const existing = await (trx as any)
            .selectFrom('menus')
            .where('shop_id', '=', input.shopId)
            .where('slug', '=', dto.sourceHandle)
            .select(['id', 'source'])
            .executeTakeFirst() as { id: string; source: string } | undefined

          let menuId: string

          if (existing) {
            if (!shouldOverwriteOnReclone(existing)) {
              out.skippedEdited++
              continue
            }
            await (trx as any).updateTable('menus')
              .set({
                title: dto.title,
                source: 'clone',
              })
              .where('id', '=', existing.id)
              .execute()
            menuId = existing.id
            out.updated++
          } else {
            const snapshotJson = JSON.stringify({
              title: dto.title,
              items: dto.items,
            })
            const inserted = await (trx as any).insertInto('menus')
              .values({
                shop_id: input.shopId,
                slug: dto.sourceHandle,
                title: dto.title,
                source: 'clone',
                clone_snapshot: snapshotJson,
                clone_job_id: input.jobId,
              })
              .returningAll()
              .execute() as Array<{ id: string }>
            menuId = inserted[0].id
            out.inserted++
          }

          // Replace all existing menu_items (both insert and update paths).
          // The item tree structure may change completely on re-clone, so
          // delete-all + reinsert is safe — the parent menu's source guard
          // above ensures we only reach here for clone-sourced (or new) menus.
          await (trx as any)
            .deleteFrom('menu_items')
            .where('menu_id', '=', menuId)
            .execute()

          await insertMenuItemsRecursive(trx, menuId, null, dto.items, 0)
        } catch (err) {
          out.errors.push({ sourceHandle: dto.sourceHandle, reason: (err as Error).message })
        }
      }
    })

    return out
  },
}

async function insertMenuItemsRecursive(
  trx: any,
  menuId: string,
  parentId: string | null,
  items: MenuItemDTO[],
  depth: number,
): Promise<void> {
  for (const item of items) {
    const snapshotJson = JSON.stringify({
      title: item.title,
      url: item.url,
      position: item.position,
    })
    const inserted = await trx.insertInto('menu_items')
      .values({
        menu_id: menuId,
        parent_id: parentId,
        title: item.title,
        url: item.url,
        position: item.position,
        depth,
        source: 'clone',
        clone_snapshot: snapshotJson,
      })
      .returningAll()
      .execute() as Array<{ id: string }>
    const childId = inserted[0].id
    if (item.children.length > 0) {
      await insertMenuItemsRecursive(trx, menuId, childId, item.children, depth + 1)
    }
  }
}
