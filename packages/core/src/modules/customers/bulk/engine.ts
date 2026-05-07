/**
 * Gbox Platform — Customer bulk-action engine (Phase 4 / PR5).
 *
 * Applies one of a fixed set of bulk actions to a list of customer ids
 * scoped to a single shop. Returns a structured result so the caller
 * can render a toast + audit-log row without second-guessing what
 * happened.
 *
 * Why a separate module (instead of inline in customers.ts):
 *   - The list page (customers.ts) already has a bulk handler with
 *     TWO latent bugs: it treats `tags` as a CSV string (but it's a
 *     Postgres `text[]`) and it writes `status='enabled'` which
 *     violates the check constraint (`active|disabled`). Lifting to
 *     a service forces us to write the correct shape once, and makes
 *     those bugs testable.
 *   - Future surfaces (segments bulk-apply, CLI, API) will want the
 *     same engine without pulling in an Express handler.
 *
 * Every action is shop-scoped — every UPDATE includes
 * `WHERE shop_id = $1` so a malicious id array from one shop can
 * never touch another shop's rows.
 *
 * Actions:
 *   - `add_tags` / `remove_tags` — accept a `text[]` and union /
 *     difference against the stored array. Idempotent (adding an
 *     existing tag is a no-op; removing a missing one is a no-op).
 *   - `set_lifecycle` — writes one of the four lifecycle stages. Note
 *     that the daily classifier cron may reclassify the next day;
 *     we're overriding transiently for a campaign.
 *   - `subscribe_marketing` / `unsubscribe_marketing` — toggle
 *     `accepts_marketing`. Distinct verbs so the audit log reads
 *     naturally ("30 customers subscribed").
 *   - `enable` / `disable` — toggle the `status` column which
 *     (per the check constraint) must be one of `active | disabled`.
 *     Soft-delete. We deliberately do NOT offer hard-delete here —
 *     that needs a separate confirmation flow (referenced orders
 *     would break FK constraints).
 *
 * The caller is responsible for authorization (a seller on their own
 * shop) and for audit logging + bell notifications. This engine does
 * one thing.
 */

import { CustomerApi } from '@gbox/api-client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The valid lifecycle stages — mirrored from migration 056. */
export type LifecycleStage = 'new' | 'returning' | 'at_risk' | 'churned'

/**
 * Discriminated union of every supported bulk action. Using a DU
 * (instead of `(action: string, params: unknown)`) keeps the engine
 * exhaustive at the type level — add a new action and the switch
 * inside `applyBulkAction` must handle it or TS errors.
 */
export type BulkAction =
  | { type: 'add_tags'; tags: string[] }
  | { type: 'remove_tags'; tags: string[] }
  | { type: 'set_lifecycle'; stage: LifecycleStage }
  | { type: 'subscribe_marketing' }
  | { type: 'unsubscribe_marketing' }
  | { type: 'enable' }
  | { type: 'disable' }

export interface BulkResult {
  /** Number of rows actually updated (what the caller shows in the toast). */
  affected: number
  /** Number of ids that didn't match any row in this shop (cross-shop
   *  or already-deleted). Non-zero means the UI selection was stale. */
  skipped: number
  /** Post-run count of rows matching the id+shop filter. Always ≤ ids.length. */
  matched: number
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply `action` to every row in `(shop_id = shopId AND id IN ids)`.
 */
export async function applyBulkAction(
  _db: any,
  shopId: string,
  ids: string[],
  action: BulkAction,
): Promise<BulkResult> {
  const clean = Array.from(new Set(ids.filter(Boolean)))
  if (clean.length === 0) {
    return { affected: 0, skipped: 0, matched: 0 }
  }

  const response = await CustomerApi.CustomerService.getApi({
    shopId,
    ids: clean.join(','),
    limit: clean.length,
  })
  
  const customers = response.items || response.data || []
  const matched = customers.length
  const skipped = clean.length - matched
  
  if (matched === 0) {
    return { affected: 0, skipped, matched: 0 }
  }

  const affected = await runAction(shopId, customers, action)

  return { affected, skipped, matched }
}

// ---------------------------------------------------------------------------
// Per-action executors
// ---------------------------------------------------------------------------

async function runAction(
  shopId: string,
  customers: any[],
  action: BulkAction,
): Promise<number> {
  switch (action.type) {
    case 'add_tags':
      return await bulkAddTags(shopId, customers, action.tags)
    case 'remove_tags':
      return await bulkRemoveTags(shopId, customers, action.tags)
    case 'set_lifecycle':
      return await bulkUpdateColumn(shopId, customers, {
        lifecycle_stage: action.stage,
      } as any)
    case 'subscribe_marketing':
      return await bulkUpdateColumn(shopId, customers, { accepts_marketing: true } as any)
    case 'unsubscribe_marketing':
      return await bulkUpdateColumn(shopId, customers, { accepts_marketing: false } as any)
    case 'enable':
      return await bulkUpdateColumn(shopId, customers, { status: 'active' } as any)
    case 'disable':
      return await bulkUpdateColumn(shopId, customers, { status: 'disabled' } as any)
    default: {
      const _never: never = action
      throw new Error(`unknown bulk action: ${JSON.stringify(_never)}`)
    }
  }
}

async function bulkAddTags(
  shopId: string,
  customers: any[],
  tagsToAdd: string[],
): Promise<number> {
  const cleanTags = dedupeTags(tagsToAdd)
  if (cleanTags.length === 0) return 0

  const updatedCustomers = customers.map(c => {
    const existingTags = Array.isArray(c.tags) ? c.tags : []
    const newTags = dedupeTags([...existingTags, ...cleanTags])
    return { ...c, tags: newTags }
  })

  await CustomerApi.CustomerService.putApi({
    shopId,
    requestBody: updatedCustomers,
  })
  
  return updatedCustomers.length
}

async function bulkRemoveTags(
  shopId: string,
  customers: any[],
  tagsToRemove: string[],
): Promise<number> {
  const cleanTags = dedupeTags(tagsToRemove)
  if (cleanTags.length === 0) return 0

  const updatedCustomers = customers.map(c => {
    const existingTags = Array.isArray(c.tags) ? c.tags : []
    const newTags = existingTags.filter(t => !cleanTags.includes(t))
    return { ...c, tags: newTags }
  })

  await CustomerApi.CustomerService.putApi({
    shopId,
    requestBody: updatedCustomers,
  })
  
  return updatedCustomers.length
}

async function bulkUpdateColumn(
  shopId: string,
  customers: any[],
  set: Record<string, any>,
): Promise<number> {
  const updatedCustomers = customers.map(c => ({ ...c, ...set }))

  await CustomerApi.CustomerService.putApi({
    shopId,
    requestBody: updatedCustomers,
  })
  
  return updatedCustomers.length
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Trim + lowercase + dedupe. Tags are case-insensitive on the storefront
 * (matching Shopify) so we normalize at the write boundary to avoid
 * "VIP" and "vip" both ending up in the same array.
 */
function dedupeTags(input: string[]): string[] {
  const s = new Set<string>()
  for (const t of input) {
    const v = (t ?? '').trim()
    if (v) s.add(v)
  }
  return Array.from(s)
}
