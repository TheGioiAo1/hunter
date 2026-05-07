/**
 * Orders CSV Exporter
 *
 * Generates Shopify-compatible CSV export of orders with line items,
 * customer info, addresses, and payment details. Each line item becomes
 * its own row (Shopify format) — one order with 3 items = 3 CSV rows.
 *
 * Columns follow Shopify's Orders export format so merchants migrating
 * FROM Gbox TO Shopify (or comparing data) get a familiar layout.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportOrder {
  id: string
  order_number: number | string
  created_at: string
  updated_at?: string | null
  financial_status: string
  fulfillment_status: string | null
  currency: string
  subtotal_price: string | number
  total_discounts: string | number
  total_shipping: string | number
  total_tax: string | number
  total_price: string | number
  note?: string | null
  tags?: string[] | null
  email?: string | null
  phone?: string | null
  customer_id?: string | null
  billing_address?: any
  shipping_address?: any
  cancel_reason?: string | null
  cancelled_at?: string | null
  closed_at?: string | null
  source_channel?: string | null
  line_items: ExportLineItem[]
  transactions?: ExportTransaction[]
  fulfillments?: ExportFulfillment[]
}

export interface ExportLineItem {
  id: string
  title: string
  variant_title?: string | null
  sku?: string | null
  quantity: number
  price: string | number
  total_discount?: string | number
  fulfillment_status?: string | null
  requires_shipping?: boolean
  taxable?: boolean
  gift_card?: boolean
  product_id?: string | null
  variant_id?: string | null
}

export interface ExportTransaction {
  gateway?: string | null
  kind?: string | null
  amount?: string | number
  authorization?: string | null
  status?: string | null
}

export interface ExportFulfillment {
  tracking_company?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
  status?: string | null
  shipped_at?: string | null
}

export interface ExportOptions {
  /** Include line item details (default: true) */
  includeLineItems?: boolean
  /** Include customer info (default: true) */
  includeCustomer?: boolean
  /** Include addresses (default: true) */
  includeAddresses?: boolean
  /** Include transaction history (default: false) */
  includeTransactions?: boolean
  /** Include fulfillment details (default: false) */
  includeFulfillments?: boolean
}

// ---------------------------------------------------------------------------
// CSV Helpers
// ---------------------------------------------------------------------------

/** Escape a CSV field — wrap in quotes if it contains comma, newline, or quote */
function csvField(val: unknown): string {
  if (val === null || val === undefined) return ''
  const s = String(val)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function formatAddr(addr: any, field: string): string {
  if (!addr) return ''
  return String(addr[field] || '')
}

function addrName(addr: any): string {
  if (!addr) return ''
  return [addr.first_name, addr.last_name].filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Column Definitions
// ---------------------------------------------------------------------------

const BASE_COLUMNS = [
  'Order Number',
  'Order ID',
  'Created At',
  'Updated At',
  'Financial Status',
  'Fulfillment Status',
  'Currency',
  'Subtotal',
  'Total Discounts',
  'Total Shipping',
  'Total Tax',
  'Total Price',
  'Note',
  'Tags',
  'Cancel Reason',
  'Cancelled At',
  'Source Channel',
]

const CUSTOMER_COLUMNS = [
  'Customer ID',
  'Customer Email',
  'Customer Phone',
]

const BILLING_COLUMNS = [
  'Billing Name',
  'Billing Company',
  'Billing Address1',
  'Billing Address2',
  'Billing City',
  'Billing Province',
  'Billing Zip',
  'Billing Country',
  'Billing Phone',
]

const SHIPPING_COLUMNS = [
  'Shipping Name',
  'Shipping Company',
  'Shipping Address1',
  'Shipping Address2',
  'Shipping City',
  'Shipping Province',
  'Shipping Zip',
  'Shipping Country',
  'Shipping Phone',
]

const LINE_ITEM_COLUMNS = [
  'Line Item ID',
  'Line Item Product ID',
  'Line Item SKU',
  'Line Item Title',
  'Line Item Variant',
  'Line Item Quantity',
  'Line Item Price',
  'Line Item Discount',
  'Line Item Total',
  'Line Item Fulfillment Status',
  'Line Item Requires Shipping',
  'Line Item Taxable',
  'Line Item Gift Card',
]

const TRANSACTION_COLUMNS = [
  'Payment Gateway',
  'Payment Kind',
  'Payment Amount',
  'Payment Authorization',
  'Payment Status',
]

const FULFILLMENT_COLUMNS = [
  'Fulfillment Carrier',
  'Fulfillment Tracking Number',
  'Fulfillment Tracking URL',
  'Fulfillment Status',
  'Fulfillment Shipped At',
]

// ---------------------------------------------------------------------------
// Export Functions
// ---------------------------------------------------------------------------

/**
 * Build CSV header row based on export options.
 */
export function buildHeaders(options: ExportOptions = {}): string[] {
  const cols = [...BASE_COLUMNS]
  if (options.includeCustomer !== false) cols.push(...CUSTOMER_COLUMNS)
  if (options.includeAddresses !== false) {
    cols.push(...BILLING_COLUMNS)
    cols.push(...SHIPPING_COLUMNS)
  }
  if (options.includeLineItems !== false) cols.push(...LINE_ITEM_COLUMNS)
  if (options.includeTransactions) cols.push(...TRANSACTION_COLUMNS)
  if (options.includeFulfillments) cols.push(...FULFILLMENT_COLUMNS)
  return cols
}

/**
 * Convert a single order to CSV rows. One row per line item (Shopify format).
 * If no line items, produces one row with empty line item columns.
 */
export function orderToRows(order: ExportOrder, options: ExportOptions = {}): string[][] {
  const ba = order.billing_address || {}
  const sa = order.shipping_address || {}
  const tags = Array.isArray(order.tags) ? order.tags.join(', ') : (order.tags || '')

  // Base order fields
  const baseFields = [
    order.order_number,
    order.id,
    order.created_at,
    order.updated_at || '',
    order.financial_status,
    order.fulfillment_status || 'unfulfilled',
    order.currency,
    order.subtotal_price,
    order.total_discounts,
    order.total_shipping,
    order.total_tax,
    order.total_price,
    order.note || '',
    tags,
    order.cancel_reason || '',
    order.cancelled_at || '',
    order.source_channel || 'online_store',
  ]

  // Customer fields
  const customerFields = options.includeCustomer !== false ? [
    order.customer_id || '',
    order.email || '',
    order.phone || '',
  ] : []

  // Address fields
  const addressFields = options.includeAddresses !== false ? [
    addrName(ba),
    formatAddr(ba, 'company'),
    formatAddr(ba, 'address1'),
    formatAddr(ba, 'address2'),
    formatAddr(ba, 'city'),
    formatAddr(ba, 'province'),
    formatAddr(ba, 'zip'),
    formatAddr(ba, 'country'),
    formatAddr(ba, 'phone'),
    addrName(sa),
    formatAddr(sa, 'company'),
    formatAddr(sa, 'address1'),
    formatAddr(sa, 'address2'),
    formatAddr(sa, 'city'),
    formatAddr(sa, 'province'),
    formatAddr(sa, 'zip'),
    formatAddr(sa, 'country'),
    formatAddr(sa, 'phone'),
  ] : []

  // Line items — one row per item
  const lineItems = (options.includeLineItems !== false && order.line_items.length > 0)
    ? order.line_items
    : [null] // One row even if no items

  const rows: string[][] = []

  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i]
    const row: any[] = [...baseFields, ...customerFields, ...addressFields]

    if (options.includeLineItems !== false) {
      if (li) {
        const price = Number(li.price)
        const qty = Number(li.quantity)
        const disc = Number(li.total_discount || 0)
        row.push(
          li.id,
          li.product_id || '',
          li.sku || '',
          li.title,
          li.variant_title || '',
          qty,
          price,
          disc,
          (price * qty - disc).toFixed(2),
          li.fulfillment_status || 'unfulfilled',
          li.requires_shipping !== false ? 'true' : 'false',
          li.taxable !== false ? 'true' : 'false',
          li.gift_card ? 'true' : 'false',
        )
      } else {
        row.push(...LINE_ITEM_COLUMNS.map(() => ''))
      }
    }

    // Transaction (first one only for CSV — or one per row if multiple)
    if (options.includeTransactions) {
      const txn = order.transactions?.[i] || order.transactions?.[0]
      if (txn) {
        row.push(
          txn.gateway || '',
          txn.kind || '',
          txn.amount || '',
          txn.authorization || '',
          txn.status || '',
        )
      } else {
        row.push(...TRANSACTION_COLUMNS.map(() => ''))
      }
    }

    // Fulfillment
    if (options.includeFulfillments) {
      const ful = order.fulfillments?.[i] || order.fulfillments?.[0]
      if (ful) {
        row.push(
          ful.tracking_company || '',
          ful.tracking_number || '',
          ful.tracking_url || '',
          ful.status || '',
          ful.shipped_at || '',
        )
      } else {
        row.push(...FULFILLMENT_COLUMNS.map(() => ''))
      }
    }

    rows.push(row.map(v => String(v)))
  }

  return rows
}

/**
 * Generate full CSV string from an array of orders.
 */
export function exportOrdersCsv(
  orders: ExportOrder[],
  options: ExportOptions = {},
): string {
  const headers = buildHeaders(options)
  const lines: string[] = [headers.map(csvField).join(',')]

  for (const order of orders) {
    const rows = orderToRows(order, options)
    for (const row of rows) {
      lines.push(row.map(csvField).join(','))
    }
  }

  return lines.join('\n')
}

/**
 * Generate JSON export — simpler, just returns the orders array.
 */
export function exportOrdersJson(orders: ExportOrder[]): string {
  return JSON.stringify(orders, null, 2)
}
