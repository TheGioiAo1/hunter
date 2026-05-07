/**
 * push-order — single entry point for "send this Gbox order to Lenful".
 *
 * Used by:
 *   - God admin "Push" button (manual, v1)
 *   - Cron auto-push worker (v1.1, per routing rule)
 *
 * Flow
 * ----
 * 1. Load Gbox order + line items + shop + seller + shipping address
 * 2. Load Lenful mappings for every variant
 * 3. Load POD artwork from `pod_files` (legacy) — while migration is
 *    still in-flight artwork can live in either pod_files or, once
 *    Phase F1 lands, lenful_design_library
 * 4. buildCreateOrderPayload(...)
 * 5. LenfulClient.createOrder(storeId, payload)
 * 6. Upsert lenful_orders + lenful_order_items
 * 7. Update orders.fulfillment_status → 'in_progress'
 * 8. Emit order event + audit_log
 *
 * Errors
 * ------
 * Any BuildError / LenfulApiError → lenful_orders row is created/updated
 * with status='queued' or 'failed' + last_error_msg so the queue page
 * can show it.
 */

import type { Kysely } from 'kysely'
import type { Database, LenfulOrderStatus } from '../../../../../db/src/schema/tables.js'
import { LenfulClient, LenfulApiError } from './client.ts'
import { getActiveCredential, recordCredentialError } from './credentials.ts'
import {
  BuildError,
  buildCreateOrderPayload,
  type GboxLineItemForBuilder,
  type GboxOrderForBuilder,
  type LenfulMappingForBuilder,
  type PodArtworkForBuilder,
  type SellerForBuilder,
  type ShopForBuilder,
} from './builder.ts'
import type { PrintPosition } from './types.ts'

export interface PushOrderInput {
  readonly gboxOrderId: string
  /** User id of the god admin that clicked Push (or 'cron' for auto). */
  readonly triggeredBy: string
  readonly userId?: string | null
}

export interface PushOrderResult {
  readonly ok: boolean
  readonly lenfulOrderId?: string
  readonly lenfulOrderRowId: string
  readonly status: LenfulOrderStatus
  readonly errorCode?: string
  readonly errorMsg?: string
}

export async function pushOrderToLenful(
  db: Kysely<Database>,
  input: PushOrderInput,
): Promise<PushOrderResult> {
  // 1. Active credential
  const cred = await getActiveCredential(db)
  if (!cred) {
    return {
      ok: false,
      lenfulOrderRowId: '',
      status: 'failed',
      errorCode: 'NO_CREDENTIAL',
      errorMsg: 'No active Lenful credential',
    }
  }
  if (!cred.lenful_store_id) {
    return {
      ok: false,
      lenfulOrderRowId: '',
      status: 'failed',
      errorCode: 'NO_STORE',
      errorMsg: 'Lenful credential has no store_id configured',
    }
  }

  // 2. Load Gbox order + shop + seller
  const order = await db
    .selectFrom('orders')
    .selectAll()
    .where('id', '=', input.gboxOrderId)
    .executeTakeFirst()
  if (!order) {
    return {
      ok: false,
      lenfulOrderRowId: '',
      status: 'failed',
      errorCode: 'NOT_FOUND',
      errorMsg: 'Order not found',
    }
  }

  const shop = await db
    .selectFrom('shops')
    .select(['id', 'slug', 'name'])
    .where('id', '=', (order as any).shop_id)
    .executeTakeFirst()
  if (!shop) {
    return {
      ok: false,
      lenfulOrderRowId: '',
      status: 'failed',
      errorCode: 'SHOP_NOT_FOUND',
      errorMsg: 'Shop not found',
    }
  }

  // Owning seller — first user_shops.owner row, fallback to any user
  const sellerRow = await db
    .selectFrom('user_shops')
    .innerJoin('users', 'users.id', 'user_shops.user_id')
    .select(['users.id as id', 'users.email as email'])
    .where('user_shops.shop_id', '=', shop.id)
    .orderBy('user_shops.role', 'desc')
    .limit(1)
    .executeTakeFirst()
  const seller: SellerForBuilder = sellerRow ?? {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'unknown@gbox',
  }

  // 3. Line items
  const lineItems = await db
    .selectFrom('order_line_items')
    .select(['id', 'quantity', 'title', 'sku', 'variant_id', 'product_id'])
    .where('order_id', '=', input.gboxOrderId)
    .execute()

  // 4. Lenful mappings for every variant/product
  const variantIds = lineItems.map((li) => li.variant_id).filter((x): x is string => !!x)
  const productIds = lineItems.map((li) => li.product_id).filter((x): x is string => !!x)

  const mappingRowsVariant = variantIds.length
    ? await db
        .selectFrom('lenful_product_map')
        .select([
          'gbox_variant_id',
          'gbox_product_id',
          'lenful_product_sku',
          'default_shipping_priority',
          'default_print_position',
        ])
        .where('gbox_variant_id', 'in', variantIds)
        .execute()
    : []
  const mappingRowsProduct = productIds.length
    ? await db
        .selectFrom('lenful_product_map')
        .select([
          'gbox_variant_id',
          'gbox_product_id',
          'lenful_product_sku',
          'default_shipping_priority',
          'default_print_position',
        ])
        .where('gbox_product_id', 'in', productIds)
        .where('gbox_variant_id', 'is', null)
        .execute()
    : []

  const mapByLineItem = new Map<string, LenfulMappingForBuilder>()
  for (const li of lineItems) {
    const hit =
      (li.variant_id &&
        mappingRowsVariant.find((m) => m.gbox_variant_id === li.variant_id)) ||
      mappingRowsProduct.find((m) => m.gbox_product_id === li.product_id)
    if (hit) {
      mapByLineItem.set(li.id, {
        gbox_variant_id: hit.gbox_variant_id ?? null,
        gbox_product_id: hit.gbox_product_id,
        lenful_product_sku: hit.lenful_product_sku,
        default_shipping_priority: (hit.default_shipping_priority as unknown as number[]) ?? [0, 1, 2],
        default_print_position: (hit.default_print_position as unknown as number) ?? 1,
      })
    }
  }

  // 5. POD artwork (from legacy pod_files)
  const podRows = await db
    .selectFrom('pod_files')
    .select(['line_item_id', 'file_url', 'filename'])
    .where('order_id', '=', input.gboxOrderId)
    .execute()
  const artworkByLineItem = new Map<string, PodArtworkForBuilder>()
  for (const pod of podRows) {
    artworkByLineItem.set(pod.line_item_id, {
      line_item_id: pod.line_item_id,
      position: 1 as PrintPosition, // default Front — override via mapping
      link: pod.file_url,
    })
  }

  const shopForBuilder: ShopForBuilder = {
    id: shop.id,
    slug: shop.slug,
    name: shop.name,
  }
  const orderForBuilder: GboxOrderForBuilder = {
    id: order.id,
    order_number: (order as any).order_number,
    email: (order as any).email ?? null,
    phone: (order as any).phone ?? null,
    shipping_address:
      typeof (order as any).shipping_address === 'string'
        ? safeParse((order as any).shipping_address)
        : (order as any).shipping_address,
  }
  const liForBuilder: GboxLineItemForBuilder[] = lineItems.map((li) => ({
    id: li.id,
    quantity: li.quantity,
    title: li.title,
    sku: li.sku,
    variant_id: li.variant_id,
    product_id: li.product_id,
  }))

  // 6. Upsert lenful_orders row as 'queued' FIRST so failures are visible
  const existing = await db
    .selectFrom('lenful_orders')
    .select(['id'])
    .where('gbox_order_id', '=', input.gboxOrderId)
    .executeTakeFirst()

  let lenfulOrderRowId = existing?.id
  if (!lenfulOrderRowId) {
    const inserted = await db
      .insertInto('lenful_orders')
      .values({
        gbox_order_id: input.gboxOrderId,
        gbox_shop_id: shop.id,
        gbox_shop_slug: shop.slug,
        gbox_shop_name: shop.name,
        gbox_seller_user_id: seller.id,
        gbox_seller_email: seller.email,
        credential_id: cred.id,
        status: 'queued',
        push_attempts: 0,
        pushed_by: input.userId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    lenfulOrderRowId = inserted.id
  }

  // 7. Build payload — surface builder errors back to caller
  let built: ReturnType<typeof buildCreateOrderPayload>
  try {
    built = buildCreateOrderPayload({
      shop: shopForBuilder,
      seller,
      order: orderForBuilder,
      lineItems: liForBuilder,
      mappings: mapByLineItem,
      artworks: artworkByLineItem,
    })
  } catch (err) {
    const code = err instanceof BuildError ? err.code : 'BUILD_ERROR'
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .updateTable('lenful_orders')
      .set({
        status: 'queued',
        last_error_code: code,
        last_error_msg: msg.slice(0, 1000),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', lenfulOrderRowId)
      .execute()
    return {
      ok: false,
      lenfulOrderRowId,
      status: 'queued',
      errorCode: code,
      errorMsg: msg,
    }
  }

  // 8. Fire the Lenful API call
  const client = new LenfulClient({
    db,
    credentialId: cred.id,
    triggeredBy: input.triggeredBy,
    userId: input.userId ?? null,
  })

  try {
    const response = await client.createOrder(cred.lenful_store_id, built.payload)
    const lenfulOrderId =
      response.id || response.order_id || String(response.order_number || '')

    // Update main row
    await db
      .updateTable('lenful_orders')
      .set({
        status: 'pushed',
        lenful_order_id: lenfulOrderId || null,
        lenful_order_number: response.order_number
          ? String(response.order_number)
          : null,
        push_attempts: (((existing as any)?.push_attempts ?? 0) + 1) as any,
        last_push_at: new Date().toISOString(),
        last_error_code: null,
        last_error_msg: null,
        request_payload: JSON.stringify(built.payload) as any,
        response_payload: JSON.stringify(response) as any,
        shipping_method_used: built.shippingMethodUsed,
        note_sent: built.noteSent,
        order_number_sent: built.orderNumberSent,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', lenfulOrderRowId)
      .execute()

    // Mirror into order_items
    await db
      .deleteFrom('lenful_order_items')
      .where('lenful_order_id_fk', '=', lenfulOrderRowId)
      .execute()
    const respItems = Array.isArray(response.items) ? response.items : []
    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i]
      const respItem = respItems[i] ?? {}
      const map = mapByLineItem.get(li.id)
      if (!map) continue
      await db
        .insertInto('lenful_order_items')
        .values({
          lenful_order_id_fk: lenfulOrderRowId,
          gbox_line_item_id: li.id,
          lenful_item_id: (respItem as any).id ?? null,
          lenful_product_sku: map.lenful_product_sku,
          lenful_design_sku: (respItem as any).design_sku ?? null,
          quantity: li.quantity,
          raw_payload: JSON.stringify(respItem) as any,
        })
        .execute()
    }

    // Mark Gbox order in-progress
    await db
      .updateTable('orders')
      .set({ fulfillment_status: 'in_progress', updated_at: new Date().toISOString() } as any)
      .where('id', '=', input.gboxOrderId)
      .execute()

    return {
      ok: true,
      lenfulOrderId: lenfulOrderId || undefined,
      lenfulOrderRowId,
      status: 'pushed',
    }
  } catch (err) {
    const code = err instanceof LenfulApiError ? `HTTP_${err.statusCode}` : 'API_ERROR'
    const msg = err instanceof Error ? err.message : String(err)
    await recordCredentialError(db, cred.id, msg)
    await db
      .updateTable('lenful_orders')
      .set({
        status: 'failed',
        last_error_code: code,
        last_error_msg: msg.slice(0, 1000),
        request_payload: JSON.stringify(built.payload) as any,
        push_attempts: (((existing as any)?.push_attempts ?? 0) + 1) as any,
        last_push_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', lenfulOrderRowId)
      .execute()
    return {
      ok: false,
      lenfulOrderRowId,
      status: 'failed',
      errorCode: code,
      errorMsg: msg,
    }
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
