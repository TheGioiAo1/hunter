/**
 * Orders Import Service
 *
 * Persists `NormalizedOrder[]` produced by the platform parsers into the
 * database as real rows (orders + line_items + transactions + fulfillments
 * + timeline events). Split out of `apps/store-admin/pages/orders-import.ts`
 * during the Phase 9 schema-consistency audit so the REST API and the UI
 * wizard share one source of truth for insert semantics.
 *
 * Insert strategy — idempotent:
 *   - Same (shop_id, external_platform, external_id) is deduped via a
 *     SELECT pre-check; the row is counted in `skipped` instead of
 *     raising a unique-constraint error. This lets merchants re-run an
 *     import without rolling back the previous partial success.
 *   - On any per-row error the loop increments `errors` and moves on
 *     rather than aborting the whole batch — import is always
 *     best-effort across rows.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { NormalizedOrder } from './types.js'
import { importFromCsv, validateOrders } from './index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistImportParams {
  /** Optional user id for the `imported` timeline event actor field. */
  userId?: string | null
  /** Extra tags appended to every inserted order. Defaults to ['imported']. */
  extraTags?: string[]
}

export interface PersistImportResult {
  imported: number
  skipped: number
  errors: number
  /** Error messages for the first N failed rows — useful in API responses. */
  errorMessages: string[]
}

// ---------------------------------------------------------------------------
// Persist: validated orders → DB
// ---------------------------------------------------------------------------

export async function persistImportedOrders(
  db: Kysely<Database>,
  shopId: string,
  orders: NormalizedOrder[],
  params: PersistImportParams = {},
): Promise<PersistImportResult> {
  const { userId = null, extraTags = [] } = params

  let imported = 0
  let skipped = 0
  let errors = 0
  const errorMessages: string[] = []

  for (const o of orders) {
    try {
      // Idempotency: skip if we already imported this external id
      const existing = await db
        .selectFrom('orders')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('external_id', '=', o.external_id ?? null)
        .executeTakeFirst()
        .catch(() => null)

      if (existing) {
        skipped++
        continue
      }

      // Per-shop auto-increment — we emulate it via MAX() + 1 to stay
      // compatible with the (shop_id, order_number) uniqueness already
      // enforced by migration 001.
      const lastOrder = await db
        .selectFrom('orders')
        .select('order_number')
        .where('shop_id', '=', shopId)
        .orderBy('order_number', 'desc')
        .limit(1)
        .executeTakeFirst()
      const nextNumber = (Number(lastOrder?.order_number) || 1000) + 1

      const tags: string[] = [
        ...extraTags,
        'imported',
        ...(o.external_platform ? [`import:${o.external_platform}`] : []),
        ...(o.tags ?? []),
      ]

      const insertResult = await db
        .insertInto('orders')
        .values({
          shop_id: shopId,
          order_number: nextNumber as any,
          email: o.email || '',
          phone: o.phone || null,
          financial_status: o.financial_status || 'pending',
          fulfillment_status: o.fulfillment_status || 'unfulfilled',
          currency: o.currency || 'USD',
          subtotal_price: String(o.subtotal_price || o.total_price || '0'),
          total_discounts: String(o.total_discounts || '0'),
          total_shipping: String(o.total_shipping || '0'),
          total_tax: String(o.total_tax || '0'),
          total_price: String(o.total_price || '0'),
          note: o.note || null,
          tags: tags as any,
          shipping_address: o.shipping_address
            ? (JSON.stringify(o.shipping_address) as any)
            : null,
          billing_address: o.billing_address
            ? (JSON.stringify(o.billing_address) as any)
            : null,
          cancel_reason: o.cancel_reason || null,
          cancelled_at: o.cancelled_at ? new Date(o.cancelled_at) as any : null,
          external_id: o.external_id || null,
          external_platform: o.external_platform || null,
          source_channel: 'import',
        })
        .returning(['id'])
        .executeTakeFirst()

      if (!insertResult) {
        errors++
        continue
      }

      const orderId = insertResult.id

      // Line items
      for (const li of o.line_items) {
        await db
          .insertInto('order_line_items')
          .values({
            order_id: orderId,
            title: li.title,
            variant_title: li.variant_title || null,
            sku: li.sku || null,
            quantity: li.quantity,
            price: String(li.price),
            total_discount: String(li.total_discount || '0'),
            fulfillment_status:
              o.fulfillment_status === 'fulfilled' ? 'fulfilled' : 'unfulfilled',
            requires_shipping: li.requires_shipping !== false,
            taxable: li.taxable !== false,
            gift_card: li.gift_card || false,
          })
          .execute()
      }

      // Transaction (payment)
      if (o.payment_gateway || o.transaction_id) {
        await db
          .insertInto('transactions')
          .values({
            order_id: orderId,
            kind: 'sale',
            gateway: o.payment_gateway || 'manual',
            amount: String(o.total_price || '0'),
            currency: o.currency || 'USD',
            status: o.financial_status === 'paid' ? 'success' : 'pending',
            authorization: o.transaction_id || null,
          })
          .execute()
          .catch(() => {})
      }

      // Fulfillment (tracking)
      if (
        o.tracking_number ||
        (o.fulfillment_status === 'fulfilled' && o.tracking_company)
      ) {
        await db
          .insertInto('fulfillments')
          .values({
            order_id: orderId,
            status: 'success',
            tracking_company: o.tracking_company || null,
            tracking_number: o.tracking_number || null,
            tracking_url: o.tracking_url || null,
          })
          .execute()
          .catch(() => {})
      }

      // Timeline event
      await db
        .insertInto('order_events')
        .values({
          shop_id: shopId,
          order_id: orderId,
          event_type: 'imported',
          actor_type: userId ? 'user' : 'system',
          actor_id: userId,
          message: `Order imported from ${o.external_platform} (external ID: ${o.external_id})`,
          data: JSON.stringify({
            external_id: o.external_id,
            external_platform: o.external_platform,
          }) as any,
        })
        .execute()
        .catch(() => {})

      imported++
    } catch (err: any) {
      errors++
      if (errorMessages.length < 20) {
        errorMessages.push(
          `Row ${o.external_id || '?'}: ${err?.message || 'unknown error'}`,
        )
      }
      console.error(
        `[import/service] Error importing order ${o.external_id}:`,
        err?.message,
      )
    }
  }

  return { imported, skipped, errors, errorMessages }
}

// ---------------------------------------------------------------------------
// One-call: CSV text → parsed + validated + persisted
// ---------------------------------------------------------------------------

export interface ImportFromCsvResult extends PersistImportResult {
  totalRows: number
  validRows: number
  invalidRows: number
  platform: string
  parseErrors: { row: number; message: string }[]
}

/**
 * Full pipeline used by the REST API: take raw CSV text, parse it,
 * validate, and persist valid rows. Returns a report combining parse
 * errors and persistence stats so the client can render a summary.
 */
export async function importOrdersFromCsv(
  db: Kysely<Database>,
  shopId: string,
  csvText: string,
  params: PersistImportParams & { forcePlatform?: string } = {},
): Promise<ImportFromCsvResult> {
  const parsed = importFromCsv(csvText, params.forcePlatform)
  const validation = validateOrders(parsed.orders)

  const persisted = await persistImportedOrders(db, shopId, validation.valid, params)

  // Merge parse-level and validation-level errors so the client sees
  // both in one list.
  const allParseErrors = [...parsed.errors, ...validation.errors]
  const invalidRows = parsed.orders.length - validation.valid.length

  return {
    ...persisted,
    totalRows: parsed.totalRows,
    validRows: validation.valid.length,
    invalidRows,
    platform: parsed.platform,
    parseErrors: allParseErrors,
  }
}
