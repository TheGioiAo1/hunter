/**
 * Orders Filter Engine
 *
 * Parses filter query params (f_*) into typed OrderFilters object,
 * applies WHERE clauses to Kysely query, serializes back to URL params.
 *
 * Sprint 2: 17 core filter sections (ShopBase parity).
 * Sprint 2b: +UTM + Print file status + Order risk.
 */

import { sql } from 'kysely'

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface OrderFilters {
  // Status / payment / fulfillment
  status: string[]              // ['open','archived','cancelled','on_hold']
  payment: string[]             // ['pending','authorized','paid','refunded',...]
  fulfillment: string[]         // ['unfulfilled','partial','fulfilled','processing',...]
  channel: string[]             // ['shopify','etsy','imported','tiktok','amazon','ebay']

  // Tracking
  tracking: string              // text search tracking number
  hasTracking: '' | 'yes' | 'no'

  // Product / line item
  productTypeHas: string
  productTypeNot: string
  vendorHas: string
  vendorNot: string
  lineNameHas: string
  lineNameNot: string
  lineSkuHas: string
  lineSkuNot: string

  // Dates
  orderDateFrom: string
  orderDateTo: string
  refundDateFrom: string
  refundDateTo: string
  fulfillDateFrom: string
  fulfillDateTo: string

  // Misc
  custom: '' | 'yes' | 'no'    // custom options Yes/No
  country: string               // ISO country code
  tag: string                   // tag name
  customer: string              // customer name or email

  // Sprint 2b (empty until 2b)
  utmSource: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
  utmTerm: string
  printFileStatus: '' | 'any_generating' | 'all_generated'
  riskHigh: '' | 'yes'
}

export const EMPTY_FILTERS: OrderFilters = {
  status: [],
  payment: [],
  fulfillment: [],
  channel: [],
  tracking: '',
  hasTracking: '',
  productTypeHas: '',
  productTypeNot: '',
  vendorHas: '',
  vendorNot: '',
  lineNameHas: '',
  lineNameNot: '',
  lineSkuHas: '',
  lineSkuNot: '',
  orderDateFrom: '',
  orderDateTo: '',
  refundDateFrom: '',
  refundDateTo: '',
  fulfillDateFrom: '',
  fulfillDateTo: '',
  custom: '',
  country: '',
  tag: '',
  customer: '',
  utmSource: '',
  utmMedium: '',
  utmCampaign: '',
  utmContent: '',
  utmTerm: '',
  printFileStatus: '',
  riskHigh: '',
}

/* ------------------------------------------------------------------ */
/*  Parse — query object → OrderFilters                               */
/* ------------------------------------------------------------------ */

const csv = (v: any): string[] => {
  if (!v) return []
  const s = String(v).trim()
  if (!s) return []
  return s.split(',').map(x => x.trim()).filter(Boolean)
}

const str = (v: any): string => (v == null ? '' : String(v).trim())

const enumVal = <T extends string>(v: any, allowed: readonly T[]): '' | T => {
  const s = str(v)
  return (allowed as readonly string[]).includes(s) ? (s as T) : ''
}

export function parseFilters(query: Record<string, any>): OrderFilters {
  return {
    status: csv(query.f_status),
    payment: csv(query.f_payment),
    fulfillment: csv(query.f_fulfillment),
    channel: csv(query.f_channel),
    tracking: str(query.f_tracking),
    hasTracking: enumVal(query.f_has_tracking, ['yes', 'no'] as const),
    productTypeHas: str(query.f_ptype_has),
    productTypeNot: str(query.f_ptype_not),
    vendorHas: str(query.f_vendor_has),
    vendorNot: str(query.f_vendor_not),
    lineNameHas: str(query.f_line_name_has),
    lineNameNot: str(query.f_line_name_not),
    lineSkuHas: str(query.f_line_sku_has),
    lineSkuNot: str(query.f_line_sku_not),
    orderDateFrom: str(query.f_order_date_from),
    orderDateTo: str(query.f_order_date_to),
    refundDateFrom: str(query.f_refund_date_from),
    refundDateTo: str(query.f_refund_date_to),
    fulfillDateFrom: str(query.f_fulfill_date_from),
    fulfillDateTo: str(query.f_fulfill_date_to),
    custom: enumVal(query.f_custom, ['yes', 'no'] as const),
    country: str(query.f_country),
    tag: str(query.f_tag),
    customer: str(query.f_customer),
    utmSource: str(query.f_utm_source),
    utmMedium: str(query.f_utm_medium),
    utmCampaign: str(query.f_utm_campaign),
    utmContent: str(query.f_utm_content),
    utmTerm: str(query.f_utm_term),
    printFileStatus: enumVal(query.f_print_status, ['any_generating', 'all_generated'] as const),
    riskHigh: enumVal(query.f_risk, ['yes'] as const),
  }
}

/* ------------------------------------------------------------------ */
/*  Serialize — OrderFilters → URLSearchParams                        */
/* ------------------------------------------------------------------ */

export function serializeFilters(f: OrderFilters): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.status.length) out.f_status = f.status.join(',')
  if (f.payment.length) out.f_payment = f.payment.join(',')
  if (f.fulfillment.length) out.f_fulfillment = f.fulfillment.join(',')
  if (f.channel.length) out.f_channel = f.channel.join(',')
  if (f.tracking) out.f_tracking = f.tracking
  if (f.hasTracking) out.f_has_tracking = f.hasTracking
  if (f.productTypeHas) out.f_ptype_has = f.productTypeHas
  if (f.productTypeNot) out.f_ptype_not = f.productTypeNot
  if (f.vendorHas) out.f_vendor_has = f.vendorHas
  if (f.vendorNot) out.f_vendor_not = f.vendorNot
  if (f.lineNameHas) out.f_line_name_has = f.lineNameHas
  if (f.lineNameNot) out.f_line_name_not = f.lineNameNot
  if (f.lineSkuHas) out.f_line_sku_has = f.lineSkuHas
  if (f.lineSkuNot) out.f_line_sku_not = f.lineSkuNot
  if (f.orderDateFrom) out.f_order_date_from = f.orderDateFrom
  if (f.orderDateTo) out.f_order_date_to = f.orderDateTo
  if (f.refundDateFrom) out.f_refund_date_from = f.refundDateFrom
  if (f.refundDateTo) out.f_refund_date_to = f.refundDateTo
  if (f.fulfillDateFrom) out.f_fulfill_date_from = f.fulfillDateFrom
  if (f.fulfillDateTo) out.f_fulfill_date_to = f.fulfillDateTo
  if (f.custom) out.f_custom = f.custom
  if (f.country) out.f_country = f.country
  if (f.tag) out.f_tag = f.tag
  if (f.customer) out.f_customer = f.customer
  if (f.utmSource) out.f_utm_source = f.utmSource
  if (f.utmMedium) out.f_utm_medium = f.utmMedium
  if (f.utmCampaign) out.f_utm_campaign = f.utmCampaign
  if (f.utmContent) out.f_utm_content = f.utmContent
  if (f.utmTerm) out.f_utm_term = f.utmTerm
  if (f.printFileStatus) out.f_print_status = f.printFileStatus
  if (f.riskHigh) out.f_risk = f.riskHigh
  return out
}

/**
 * Count how many filter groups are active (for UI badge "Filters (3)")
 */
export function activeFilterCount(f: OrderFilters): number {
  let n = 0
  if (f.status.length) n++
  if (f.payment.length) n++
  if (f.fulfillment.length) n++
  if (f.channel.length) n++
  if (f.tracking || f.hasTracking) n++
  if (f.productTypeHas || f.productTypeNot) n++
  if (f.vendorHas || f.vendorNot) n++
  if (f.lineNameHas || f.lineNameNot) n++
  if (f.lineSkuHas || f.lineSkuNot) n++
  if (f.orderDateFrom || f.orderDateTo) n++
  if (f.refundDateFrom || f.refundDateTo) n++
  if (f.fulfillDateFrom || f.fulfillDateTo) n++
  if (f.custom) n++
  if (f.country) n++
  if (f.tag) n++
  if (f.customer) n++
  if (f.utmSource) n++
  if (f.utmMedium) n++
  if (f.utmCampaign) n++
  if (f.utmContent) n++
  if (f.utmTerm) n++
  if (f.printFileStatus) n++
  if (f.riskHigh) n++
  return n
}

/* ------------------------------------------------------------------ */
/*  Apply — OrderFilters → Kysely WHERE clauses                       */
/* ------------------------------------------------------------------ */

/**
 * Apply filters to a Kysely query on `orders` table.
 * Returns a new query with WHERE clauses added.
 *
 * Tolerates missing columns (UTM, risk_level, etc.) by try/catch at query time.
 */
export function applyFilters(q: any, f: OrderFilters): any {
  // --- Status ---
  if (f.status.length) {
    q = q.where((eb: any) => {
      const conds: any[] = []
      if (f.status.includes('open')) {
        conds.push(eb.and([
          eb('closed_at', 'is', null),
          eb('cancelled_at', 'is', null),
          sql`NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['on_hold']::text[])`,
          sql`NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['archived']::text[])`,
        ]))
      }
      if (f.status.includes('archived')) {
        conds.push(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['archived']::text[]`)
      }
      if (f.status.includes('cancelled')) {
        conds.push(eb('cancelled_at', 'is not', null))
      }
      if (f.status.includes('on_hold')) {
        conds.push(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['on_hold']::text[]`)
      }
      return conds.length ? eb.or(conds) : sql`true`
    })
  }

  // --- Payment status ---
  if (f.payment.length) {
    // Map ShopBase payment values to our financial_status values
    const mapped = f.payment.map(p => {
      switch (p) {
        case 'pending': return 'pending'
        case 'authorized': return 'authorized'
        case 'paid': return 'paid'
        case 'partially_paid': return 'partially_paid'
        case 'refunded': return 'refunded'
        case 'partially_refunded': return 'partially_refunded'
        case 'voided': return 'voided'
        case 'payment_in_process': return 'processing'
        default: return p
      }
    })
    q = q.where('financial_status', 'in', mapped)
  }

  // --- Fulfillment status ---
  if (f.fulfillment.length) {
    const mapped = f.fulfillment.map(s => {
      switch (s) {
        case 'unfulfilled': return 'unfulfilled'
        case 'partial': return 'partial'
        case 'fulfilled': return 'fulfilled'
        case 'processing': return 'processing'
        case 'partial_processing': return 'partial_processing'
        case 'awaiting_stock': return 'awaiting_stock'
        default: return s
      }
    })
    q = q.where((eb: any) => {
      const conds = mapped.map(m => eb('fulfillment_status', '=', m))
      if (mapped.includes('unfulfilled')) conds.push(eb('fulfillment_status', 'is', null))
      return eb.or(conds)
    })
  }

  // --- Sales channel (source_channel column — added in migration 022) ---
  // Migration 022 sets DEFAULT 'online_store' on insert, but the column is
  // nullable so pre-migration rows may still be NULL. Fall back to the same
  // default value that migration 022 uses so the filter is self-consistent
  // with the schema (fixes the earlier 'web' mismatch).
  if (f.channel.length) {
    q = q.where(sql`COALESCE(source_channel, 'online_store') = ANY(${f.channel})`)
  }

  // --- Tracking number (search in fulfillments.tracking_number) ---
  if (f.tracking) {
    const like = `%${f.tracking}%`
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('fulfillments')
        .select('id')
        .whereRef('fulfillments.order_id', '=', 'orders.id')
        .where('fulfillments.tracking_number' as any, 'ilike', like),
    ))
  }

  // --- Have tracking number ---
  if (f.hasTracking === 'yes') {
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('fulfillments')
        .select('id')
        .whereRef('fulfillments.order_id', '=', 'orders.id')
        .where('fulfillments.tracking_number' as any, 'is not', null),
    ))
  } else if (f.hasTracking === 'no') {
    q = q.where((eb: any) => eb.not(eb.exists(
      eb.selectFrom('fulfillments')
        .select('id')
        .whereRef('fulfillments.order_id', '=', 'orders.id')
        .where('fulfillments.tracking_number' as any, 'is not', null),
    )))
  }

  // --- Product type contains / not contains ---
  if (f.productTypeHas) {
    const like = `%${f.productTypeHas}%`
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('order_line_items as oli')
        .innerJoin('products as p', 'p.id', 'oli.product_id')
        .select('oli.id')
        .whereRef('oli.order_id', '=', 'orders.id')
        .where('p.product_type' as any, 'ilike', like),
    ))
  }
  if (f.productTypeNot) {
    const like = `%${f.productTypeNot}%`
    q = q.where((eb: any) => eb.not(eb.exists(
      eb.selectFrom('order_line_items as oli')
        .innerJoin('products as p', 'p.id', 'oli.product_id')
        .select('oli.id')
        .whereRef('oli.order_id', '=', 'orders.id')
        .where('p.product_type' as any, 'ilike', like),
    )))
  }

  // --- Vendor contains / not contains ---
  if (f.vendorHas) {
    const like = `%${f.vendorHas}%`
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('order_line_items as oli')
        .innerJoin('products as p', 'p.id', 'oli.product_id')
        .select('oli.id')
        .whereRef('oli.order_id', '=', 'orders.id')
        .where('p.vendor' as any, 'ilike', like),
    ))
  }
  if (f.vendorNot) {
    const like = `%${f.vendorNot}%`
    q = q.where((eb: any) => eb.not(eb.exists(
      eb.selectFrom('order_line_items as oli')
        .innerJoin('products as p', 'p.id', 'oli.product_id')
        .select('oli.id')
        .whereRef('oli.order_id', '=', 'orders.id')
        .where('p.vendor' as any, 'ilike', like),
    )))
  }

  // --- Line item name contains / not contains ---
  if (f.lineNameHas) {
    const like = `%${f.lineNameHas}%`
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('order_line_items')
        .select('id')
        .whereRef('order_line_items.order_id', '=', 'orders.id')
        .where('order_line_items.title', 'ilike', like),
    ))
  }
  if (f.lineNameNot) {
    const like = `%${f.lineNameNot}%`
    q = q.where((eb: any) => eb.not(eb.exists(
      eb.selectFrom('order_line_items')
        .select('id')
        .whereRef('order_line_items.order_id', '=', 'orders.id')
        .where('order_line_items.title', 'ilike', like),
    )))
  }

  // --- Line item SKU contains / not contains ---
  if (f.lineSkuHas) {
    const like = `%${f.lineSkuHas}%`
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('order_line_items')
        .select('id')
        .whereRef('order_line_items.order_id', '=', 'orders.id')
        .where('order_line_items.sku' as any, 'ilike', like),
    ))
  }
  if (f.lineSkuNot) {
    const like = `%${f.lineSkuNot}%`
    q = q.where((eb: any) => eb.not(eb.exists(
      eb.selectFrom('order_line_items')
        .select('id')
        .whereRef('order_line_items.order_id', '=', 'orders.id')
        .where('order_line_items.sku' as any, 'ilike', like),
    )))
  }

  // --- Date ranges ---
  if (f.orderDateFrom) q = q.where('created_at', '>=', f.orderDateFrom)
  if (f.orderDateTo) q = q.where('created_at', '<=', f.orderDateTo + ' 23:59:59')

  if (f.refundDateFrom || f.refundDateTo) {
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('refunds' as any)
        .select('id')
        .whereRef('refunds.order_id', '=', 'orders.id')
        .where(eb2 => {
          const conds: any[] = []
          if (f.refundDateFrom) conds.push(eb2('refunds.created_at' as any, '>=', f.refundDateFrom))
          if (f.refundDateTo) conds.push(eb2('refunds.created_at' as any, '<=', f.refundDateTo + ' 23:59:59'))
          return eb2.and(conds)
        }),
    ))
  }

  if (f.fulfillDateFrom || f.fulfillDateTo) {
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('fulfillments')
        .select('id')
        .whereRef('fulfillments.order_id', '=', 'orders.id')
        .where(eb2 => {
          const conds: any[] = []
          if (f.fulfillDateFrom) conds.push(eb2('fulfillments.created_at' as any, '>=', f.fulfillDateFrom))
          if (f.fulfillDateTo) conds.push(eb2('fulfillments.created_at' as any, '<=', f.fulfillDateTo + ' 23:59:59'))
          return eb2.and(conds)
        }),
    ))
  }

  // --- Custom options Yes/No (line items with properties JSONB non-empty) ---
  if (f.custom === 'yes') {
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('order_line_items')
        .select('id')
        .whereRef('order_line_items.order_id', '=', 'orders.id')
        .where(sql`jsonb_array_length(COALESCE(order_line_items.properties, '[]'::jsonb)) > 0`),
    ))
  } else if (f.custom === 'no') {
    q = q.where((eb: any) => eb.not(eb.exists(
      eb.selectFrom('order_line_items')
        .select('id')
        .whereRef('order_line_items.order_id', '=', 'orders.id')
        .where(sql`jsonb_array_length(COALESCE(order_line_items.properties, '[]'::jsonb)) > 0`),
    )))
  }

  // --- Country (shipping address ISO) ---
  if (f.country) {
    q = q.where(sql`
      (orders.shipping_address->>'country_code') = ${f.country.toUpperCase()}
      OR (orders.shipping_address->>'country') = ${f.country}
    `)
  }

  // --- Tag ---
  if (f.tag) {
    q = q.where(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY[${f.tag}]::text[]`)
  }

  // --- Customer (name or email) ---
  if (f.customer) {
    const like = `%${f.customer}%`
    q = q.where(sql`
      orders.email ILIKE ${like}
      OR (orders.shipping_address->>'name') ILIKE ${like}
      OR (orders.shipping_address->>'first_name') ILIKE ${like}
      OR (orders.shipping_address->>'last_name') ILIKE ${like}
    `)
  }

  // --- UTM (Sprint 2b columns — null-safe; now fully typed via tables.ts) ---
  if (f.utmSource) q = q.where('orders.utm_source', 'ilike', `%${f.utmSource}%`)
  if (f.utmMedium) q = q.where('orders.utm_medium', 'ilike', `%${f.utmMedium}%`)
  if (f.utmCampaign) q = q.where('orders.utm_campaign', 'ilike', `%${f.utmCampaign}%`)
  if (f.utmContent) q = q.where('orders.utm_content', 'ilike', `%${f.utmContent}%`)
  if (f.utmTerm) q = q.where('orders.utm_term', 'ilike', `%${f.utmTerm}%`)

  // --- Print file status (Sprint 2b pod_files.status column — now typed) ---
  if (f.printFileStatus === 'any_generating') {
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('pod_files')
        .select('id')
        .whereRef('pod_files.order_id', '=', 'orders.id')
        .where('pod_files.status', 'in', ['pending', 'generating']),
    ))
  } else if (f.printFileStatus === 'all_generated') {
    q = q.where((eb: any) => eb.exists(
      eb.selectFrom('pod_files')
        .select('id')
        .whereRef('pod_files.order_id', '=', 'orders.id'),
    )).where((eb: any) => eb.not(eb.exists(
      eb.selectFrom('pod_files')
        .select('id')
        .whereRef('pod_files.order_id', '=', 'orders.id')
        .where('pod_files.status', '<>', 'generated'),
    )))
  }

  // --- Risk (Sprint 2b risk_level column — now typed) ---
  if (f.riskHigh === 'yes') {
    q = q.where('orders.risk_level', '=', 'high')
  }

  return q
}
