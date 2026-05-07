/**
 * Store Admin — Saved Order Filters (Sprint 3)
 *
 * Persists named filter views for the Orders dashboard, scoped to
 * (shop_id, user_id). Storing `filter_json` as JSON (not a raw query
 * string) means we can rename/restructure f_* params later without
 * invalidating saved views — on load we feed the JSON back through
 * `parseFilters` + `serializeFilters` and drop any fields that no
 * longer exist in the current filter schema.
 *
 * Routes:
 *   POST /orders/saved-filters             → save/upsert the current f_* set
 *   POST /orders/saved-filters/:id/delete  → tenancy-guarded delete
 *
 * Load is implicit: chip links on the Orders page are pre-rendered
 * with the saved filter's f_* params in the URL, so clicking a chip
 * is just a normal navigation.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { parseFilters, serializeFilters } from '../lib/order-filters.js'
import { notify, byActor } from '../lib/notify.js'

/* ------------------------------------------------------------------ */
/*  POST /orders/saved-filters — upsert current filter set            */
/* ------------------------------------------------------------------ */

export async function postSaveOrderFilter(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const body = req.body as Record<string, any>
  const rawName = String(body.name ?? '').trim()
  if (!rawName) {
    res.redirect(`${base}/orders`)
    return
  }
  // Clip to column width (varchar(80)) so upsert never fails on length
  const name = rawName.slice(0, 80)

  // The form posts current f_* params in hidden inputs — parse them
  // into the canonical OrderFilters shape then serialize for storage.
  // This drops any hand-crafted junk values the user might try.
  const filters = parseFilters(body)
  const serialized = serializeFilters(filters)

  // Refuse to save an empty filter (no point pinning "no filter" view)
  if (Object.keys(serialized).length === 0) {
    // Build redirect preserving the current tab so the user isn't bounced
    const tab = String(body.tab ?? '').trim()
    const qs = tab && tab !== 'all' ? `?tab=${encodeURIComponent(tab)}` : ''
    res.redirect(`${base}/orders${qs}`)
    return
  }

  // Kysely's insert builder expects string for JsonB ColumnType — we
  // pass the serialized JSON through a cast helper to satisfy the wrapped
  // `Generated<JsonB<...>>` type without losing type-safety on other columns.
  const jsonbValue = JSON.stringify(serialized) as any

  try {
    await db
      .insertInto('order_saved_filters')
      .values({
        shop_id: store.id,
        user_id: user.id,
        name,
        filter_json: jsonbValue,
      })
      .onConflict((oc) =>
        oc.columns(['shop_id', 'user_id', 'name']).doUpdateSet({
          filter_json: jsonbValue,
          updated_at: new Date().toISOString(),
        }),
      )
      .execute()

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'order_filter_saved',
      title: `Order filter saved: ${name}`,
      message: byActor((req as any).storeUser),
      resourceType: 'order_saved_filter',
      resourceId: null,
    })
  } catch (err: any) {
    console.error('[orders-saved-filters] save failed:', err.message)
  }

  // Redirect back to the Orders page with the just-saved filter applied,
  // so the user visually confirms the chip and still sees filtered data.
  const params = new URLSearchParams()
  const tab = String(body.tab ?? '').trim()
  if (tab && tab !== 'all') params.set('tab', tab)
  for (const [k, v] of Object.entries(serialized)) params.set(k, v)
  const qs = params.toString()
  res.redirect(`${base}/orders${qs ? '?' + qs : ''}`)
}

/* ------------------------------------------------------------------ */
/*  POST /orders/saved-filters/:id/delete — tenancy-guarded delete    */
/* ------------------------------------------------------------------ */

export async function postDeleteOrderFilter(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const id = String(req.params.id ?? '').trim()

  if (!id) {
    res.redirect(`${base}/orders`)
    return
  }

  try {
    await db
      .deleteFrom('order_saved_filters')
      .where('id', '=', id)
      .where('shop_id', '=', store.id)
      .where('user_id', '=', user.id)
      .execute()

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'order_filter_deleted',
      title: 'Order filter deleted',
      message: byActor((req as any).storeUser),
      resourceType: 'order_saved_filter',
      resourceId: id,
    })
  } catch (err: any) {
    console.error('[orders-saved-filters] delete failed:', err.message)
  }

  res.redirect(`${base}/orders`)
}

/* ------------------------------------------------------------------ */
/*  Query helper — used by getOrders to render the chip row           */
/* ------------------------------------------------------------------ */

export interface SavedOrderFilter {
  id: string
  name: string
  filter_json: Record<string, string>
}

/**
 * Fetch saved filters for the current (shop, user). Returns at most 50
 * entries — if a staffer has more than that, the older ones are simply
 * not shown in the chip row; they still exist in the DB and a future
 * "Manage saved views" modal can list them.
 */
export async function listSavedOrderFilters(
  db: Kysely<Database>,
  shopId: string,
  userId: string,
): Promise<SavedOrderFilter[]> {
  try {
    const rows = await db
      .selectFrom('order_saved_filters')
      .select(['id', 'name', 'filter_json'])
      .where('shop_id', '=', shopId)
      .where('user_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .limit(50)
      .execute()

    return rows.map((r) => {
      // filter_json arrives as an object from pg's jsonb parser
      const raw =
        r.filter_json && typeof r.filter_json === 'object'
          ? (r.filter_json as Record<string, unknown>)
          : {}
      // Re-normalize through parseFilters/serializeFilters so a stale
      // saved view (with dropped params from a schema change) gets
      // cleaned up on read rather than clobbering the URL.
      const cleaned = serializeFilters(parseFilters(raw as Record<string, any>))
      return { id: String(r.id), name: String(r.name), filter_json: cleaned }
    })
  } catch (err: any) {
    console.error('[orders-saved-filters] list failed:', err.message)
    return []
  }
}
