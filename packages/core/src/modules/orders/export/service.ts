/**
 * Orders Export Service
 *
 * One-call entry point that fetches orders from the DB, joins their
 * line-items / transactions / fulfillments, and hands off to the pure
 * `exportOrdersCsv` / `exportOrdersJson` formatters.
 *
 * Split out of `apps/store-admin/pages/orders-export.ts` during the
 * Phase 9 schema-consistency audit so the REST API (gbox-api) and the
 * server-rendered dashboard (store-admin) share one source of truth.
 * That way a feature like "include tax details" only has to change in
 * one place.
 */

import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  exportOrdersCsv,
  exportOrdersJson,
  type ExportOrder,
  type ExportOptions,
} from './csv-exporter.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportScope =
  | 'all'
  | 'unfulfilled'
  | 'paid'
  | 'date_range'
  | 'selected'

export interface FetchExportOrdersParams {
  scope?: ExportScope
  /** ISO date-only string (YYYY-MM-DD). Used when scope='date_range'. */
  date_from?: string | null
  date_to?: string | null
  /** Explicit id list. Used when scope='selected'. */
  ids?: string[]
  /** Safety cap — anything above this is silently truncated. */
  limit?: number
  /** Column groups to hydrate — skip expensive joins when false. */
  includeLineItems?: boolean
  includeTransactions?: boolean
  includeFulfillments?: boolean
}

export interface ExportResult {
  data: string           // csv / json string (already BOM-prefixed for csv)
  contentType: string
  filename: string
  rowCount: number
}

// ---------------------------------------------------------------------------
// Core: fetch orders shaped for the CSV/JSON exporter
// ---------------------------------------------------------------------------

/**
 * Load orders (plus requested related rows) into the `ExportOrder[]` shape
 * the formatter expects. Excludes draft orders (tag='draft') since they
 * have separate export flows via the Drafts page.
 */
export async function fetchOrdersForExport(
  db: Kysely<Database>,
  shopId: string,
  params: FetchExportOrdersParams = {},
): Promise<ExportOrder[]> {
  const {
    scope = 'all',
    date_from,
    date_to,
    ids,
    limit = 10_000,
    includeLineItems = true,
    includeTransactions = false,
    includeFulfillments = false,
  } = params

  // Base query — shop scope + skip drafts. The `tags @>` operator is
  // Postgres-specific and Kysely's typed API doesn't ship an alias for
  // it, so we use a raw-SQL fragment for the NOT-contains check.
  let q = db
    .selectFrom('orders')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where(sql<boolean>`NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[])`)

  if (scope === 'date_range') {
    if (date_from) q = q.where('created_at', '>=', new Date(date_from) as any)
    if (date_to) {
      const toDate = new Date(date_to)
      toDate.setHours(23, 59, 59, 999)
      q = q.where('created_at', '<=', toDate as any)
    }
  } else if (scope === 'unfulfilled') {
    q = q.where((eb) =>
      eb.or([
        eb('fulfillment_status', 'is', null),
        eb('fulfillment_status', '=', 'unfulfilled'),
        eb('fulfillment_status', '=', 'partial'),
      ]),
    )
  } else if (scope === 'paid') {
    q = q.where('financial_status', '=', 'paid')
  } else if (scope === 'selected' && ids && ids.length > 0) {
    q = q.where('id', 'in', ids)
  }

  const orders = await q.orderBy('created_at', 'desc').limit(limit).execute()
  if (orders.length === 0) return []

  const orderIds = orders.map((o) => o.id)

  // Parallel joins — only fetch what the caller asked for
  const [lineItems, transactions, fulfillments] = await Promise.all([
    includeLineItems
      ? db
          .selectFrom('order_line_items')
          .selectAll()
          .where('order_id', 'in', orderIds)
          .execute()
      : Promise.resolve([] as any[]),
    includeTransactions
      ? db
          .selectFrom('transactions')
          .selectAll()
          .where('order_id', 'in', orderIds)
          .execute()
          .catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    includeFulfillments
      ? db
          .selectFrom('fulfillments')
          .selectAll()
          .where('order_id', 'in', orderIds)
          .execute()
          .catch(() => [] as any[])
      : Promise.resolve([] as any[]),
  ])

  // Group relations by order_id
  const liByOrder = groupBy(lineItems, 'order_id')
  const txByOrder = groupBy(transactions, 'order_id')
  const fulByOrder = groupBy(fulfillments, 'order_id')

  return orders.map<ExportOrder>((o) => {
    const billing =
      typeof o.billing_address === 'string'
        ? safeParse(o.billing_address)
        : o.billing_address
    const shipping =
      typeof o.shipping_address === 'string'
        ? safeParse(o.shipping_address)
        : o.shipping_address

    return {
      id: o.id,
      order_number: o.order_number as number,
      created_at: String(o.created_at),
      updated_at: o.updated_at ? String(o.updated_at) : null,
      financial_status: o.financial_status || 'pending',
      fulfillment_status: o.fulfillment_status || 'unfulfilled',
      currency: o.currency || 'USD',
      subtotal_price: o.subtotal_price || '0',
      total_discounts: o.total_discounts || '0',
      total_shipping: o.total_shipping || '0',
      total_tax: o.total_tax || '0',
      total_price: o.total_price || '0',
      note: o.note,
      tags: o.tags as string[] | null,
      email: o.email,
      phone: o.phone,
      customer_id: o.customer_id || null,
      billing_address: billing,
      shipping_address: shipping,
      cancel_reason: o.cancel_reason,
      cancelled_at: o.cancelled_at ? String(o.cancelled_at) : null,
      closed_at: o.closed_at ? String(o.closed_at) : null,
      source_channel: o.source_channel || null,
      line_items: (liByOrder.get(o.id) || []).map((li: any) => ({
        id: li.id,
        title: li.title,
        variant_title: li.variant_title,
        sku: li.sku,
        quantity: Number(li.quantity),
        price: li.price,
        total_discount: li.total_discount || '0',
        fulfillment_status: li.fulfillment_status,
        requires_shipping: li.requires_shipping !== false,
        taxable: li.taxable !== false,
        gift_card: li.gift_card === true,
        product_id: li.product_id,
        variant_id: li.variant_id,
      })),
      transactions: (txByOrder.get(o.id) || []).map((tx: any) => ({
        gateway: tx.gateway,
        kind: tx.kind,
        amount: tx.amount,
        authorization: tx.authorization,
        status: tx.status,
      })),
      fulfillments: (fulByOrder.get(o.id) || []).map((f: any) => ({
        tracking_company: f.tracking_company,
        tracking_number: f.tracking_number,
        tracking_url: f.tracking_url,
        status: f.status,
        shipped_at: f.shipped_at ? String(f.shipped_at) : null,
      })),
    }
  })
}

// ---------------------------------------------------------------------------
// Core: fetch + format in one call
// ---------------------------------------------------------------------------

/**
 * One-call wrapper. Used by the REST API to stream an export directly;
 * store-admin uses the two-step path (`fetchOrdersForExport` then render
 * into an HTTP response) so it can set its own Content-Disposition.
 */
export async function generateOrdersExport(
  db: Kysely<Database>,
  shopId: string,
  params: FetchExportOrdersParams & {
    format: 'csv' | 'json'
    storeSlug?: string
    options?: ExportOptions
  },
): Promise<ExportResult> {
  const orders = await fetchOrdersForExport(db, shopId, params)
  const timestamp = new Date().toISOString().slice(0, 10)
  const storeName = params.storeSlug || 'store'

  if (params.format === 'json') {
    return {
      data: exportOrdersJson(orders),
      contentType: 'application/json',
      filename: `orders-${storeName}-${timestamp}.json`,
      rowCount: orders.length,
    }
  }

  // CSV — BOM prefixed for Excel UTF-8
  const csv = exportOrdersCsv(orders, params.options ?? {})
  return {
    data: '\ufeff' + csv,
    contentType: 'text/csv; charset=utf-8',
    filename: `orders-${storeName}-${timestamp}.csv`,
    rowCount: orders.length,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupBy<T extends Record<string, any>>(
  rows: T[],
  key: keyof T,
): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const k = String(row[key])
    const list = map.get(k) || []
    list.push(row)
    map.set(k, list)
  }
  return map
}

function safeParse(text: string | null | undefined): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
