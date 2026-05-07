/**
 * Gbox Platform — Smart collection sync (Phase C2)
 *
 * One entry point: `syncSmartCollection(db, {collectionId, shopId})`.
 *
 * Called from the BullMQ worker (and directly from tests). Does:
 *
 *   1. Load the collection, verify it belongs to shopId, pull `rules`.
 *   2. If rules are absent / empty / legacy-shape → this is a MANUAL
 *      collection; do nothing. Manual collections' memberships are
 *      owned by the product editor + Phase C1 handlers.
 *   3. Evaluate rules → get desired product id set.
 *   4. Load current `collection_products` for this collection → get
 *      current product id set.
 *   5. Diff:
 *        to_add    = desired \ current   → INSERT with position = max+i
 *        to_remove = current \ desired   → DELETE
 *        shared rows are left alone so manual drag positions stick.
 *
 * Returns a summary `{added, removed, kept}` for the audit log.
 *
 * Rationale for diff-then-apply (vs. "DELETE all then INSERT"): rapid
 * re-evaluations triggered by product edits would otherwise thrash
 * the table and kill positional ordering if a merchant later adds a
 * "Featured" manual pin (Phase C3).
 */

import type { Kysely } from 'kysely'
import { evaluateSmartRules, isSmartRules, type SmartRules } from './smart-rules.js'

export interface SyncResult {
  collectionId: string
  mode: 'smart' | 'manual' | 'not-found'
  added: number
  removed: number
  kept: number
}

export interface SyncInput {
  collectionId: string
  shopId: string
}

/**
 * Re-evaluate a smart collection's rules and sync `collection_products`
 * to match. Safe to call on a manual collection — returns `mode: 'manual'`
 * and a no-op summary.
 */
export async function syncSmartCollection(
  db: Kysely<any>,
  input: SyncInput,
): Promise<SyncResult> {
  const { collectionId, shopId } = input

  // ---- 1. Load collection, enforce shop scope. ---------------------------
  const coll = await db
    .selectFrom('collections')
    .select(['id', 'rules'])
    .where('id', '=', collectionId)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!coll) {
    return { collectionId, mode: 'not-found', added: 0, removed: 0, kept: 0 }
  }

  // ---- 2. Manual guard. --------------------------------------------------
  if (!isSmartRules(coll.rules)) {
    return { collectionId, mode: 'manual', added: 0, removed: 0, kept: 0 }
  }
  const rules = coll.rules as SmartRules

  // ---- 3. Evaluate rules. ------------------------------------------------
  const desiredIds = await evaluateSmartRules(db, shopId, rules)
  const desired = new Set<string>(desiredIds)

  // ---- 4. Load current memberships. --------------------------------------
  const currentRows = await db
    .selectFrom('collection_products')
    .select(['product_id', 'position'])
    .where('collection_id', '=', collectionId)
    .execute()
  const current = new Set<string>(currentRows.map((r: any) => r.product_id as string))

  // ---- 5. Diff. ----------------------------------------------------------
  const toAdd: string[] = []
  const toRemove: string[] = []
  for (const id of desired) if (!current.has(id)) toAdd.push(id)
  for (const id of current) if (!desired.has(id)) toRemove.push(id)

  // ---- 6. Apply. ---------------------------------------------------------
  if (toRemove.length > 0) {
    await db
      .deleteFrom('collection_products')
      .where('collection_id', '=', collectionId)
      .where('product_id', 'in', toRemove)
      .execute()
  }

  if (toAdd.length > 0) {
    // Append after the current max position so existing rows keep
    // their manual order (if any).
    const currentMax = currentRows.reduce(
      (m: number, r: any) => Math.max(m, Number(r.position ?? 0)),
      -1,
    )
    const rows = toAdd.map((productId, i) => ({
      collection_id: collectionId,
      product_id: productId,
      position: currentMax + 1 + i,
    }))
    await db.insertInto('collection_products').values(rows as any).execute()
  }

  return {
    collectionId,
    mode: 'smart',
    added: toAdd.length,
    removed: toRemove.length,
    kept: desired.size - toAdd.length,
  }
}
