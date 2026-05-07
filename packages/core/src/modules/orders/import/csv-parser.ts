/**
 * Generic CSV Parser
 *
 * Parses raw CSV text into headers + rows, handling:
 * - Quoted fields with commas, newlines, escaped quotes
 * - UTF-8 BOM stripping
 * - TSV (tab-delimited) auto-detection
 */

// ---------------------------------------------------------------------------
// CSV Text → Rows
// ---------------------------------------------------------------------------

export function parseCsvText(text: string): { headers: string[]; rows: string[][] } {
  // Strip BOM
  let clean = text.replace(/^\ufeff/, '')

  // Auto-detect delimiter (tab vs comma)
  const firstLine = clean.split('\n')[0] || ''
  const delimiter = firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ','

  const rows: string[][] = []
  let currentRow: string[] = []
  let currentField = ''
  let inQuotes = false
  let i = 0

  while (i < clean.length) {
    const ch = clean[i]

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ""
        if (i + 1 < clean.length && clean[i + 1] === '"') {
          currentField += '"'
          i += 2
          continue
        }
        // End of quoted field
        inQuotes = false
        i++
        continue
      }
      currentField += ch
      i++
    } else {
      if (ch === '"') {
        inQuotes = true
        i++
        continue
      }
      if (ch === delimiter) {
        currentRow.push(currentField.trim())
        currentField = ''
        i++
        continue
      }
      if (ch === '\n' || ch === '\r') {
        currentRow.push(currentField.trim())
        currentField = ''
        if (currentRow.some(f => f !== '')) {
          rows.push(currentRow)
        }
        currentRow = []
        // Handle \r\n
        if (ch === '\r' && i + 1 < clean.length && clean[i + 1] === '\n') i++
        i++
        continue
      }
      currentField += ch
      i++
    }
  }

  // Last field/row
  currentRow.push(currentField.trim())
  if (currentRow.some(f => f !== '')) {
    rows.push(currentRow)
  }

  if (rows.length === 0) return { headers: [], rows: [] }

  const headers = rows[0]
  return { headers, rows: rows.slice(1) }
}

// ---------------------------------------------------------------------------
// Auto-detect Column Mapping
// ---------------------------------------------------------------------------

/**
 * Known header synonyms → Gbox field key.
 *
 * Synonyms must be lowercase and trimmed — the matcher normalizes
 * incoming headers the same way before comparison.
 *
 * Header variants covered:
 *   - Shopify style: `lineitem name` / `lineitem sku` (no space between
 *     "line" and "item")
 *   - Gbox exporter style: `line item title` / `line item sku` (with
 *     space) — Gbox's own CSV export uses this form, so importing a
 *     Gbox-exported CSV back into Gbox must round-trip.
 *   - Snake_case: `line_item_price` etc.
 *   - Generic: `title`, `sku`, `price` as last-resort fallbacks.
 */
const HEADER_SYNONYMS: Record<string, string[]> = {
  external_id: ['order id', 'order_id', 'orderid', 'id', 'name', 'order name', 'order no'],
  order_number: ['order number', 'order_number', 'ordernumber', 'order #', 'order no', '#'],
  created_at: ['created at', 'created_at', 'date', 'order date', 'created', 'placed on', 'purchase date'],
  financial_status: ['financial status', 'financial_status', 'payment status', 'payment_status', 'status'],
  fulfillment_status: ['fulfillment status', 'fulfillment_status', 'shipping status'],
  currency: ['currency', 'currency code'],
  subtotal_price: ['subtotal', 'subtotal_price', 'subtotal price', 'items total'],
  total_discounts: ['total discounts', 'total_discounts', 'discount', 'discount amount'],
  total_shipping: ['total shipping', 'total_shipping', 'shipping', 'shipping cost', 'shipping price'],
  total_tax: ['total tax', 'total_tax', 'tax', 'tax amount'],
  total_price: ['total', 'total price', 'total_price', 'grand total', 'order total', 'amount'],
  email: ['email', 'customer email', 'customer_email', 'buyer email', 'e-mail'],
  phone: ['phone', 'customer phone', 'telephone', 'tel'],
  note: ['note', 'notes', 'order note', 'customer note', 'comments'],
  tags: ['tags', 'order tags'],
  // Address
  shipping_name: ['shipping name', 'ship to', 'recipient name', 'shipping first name'],
  shipping_address1: ['shipping address1', 'shipping address 1', 'shipping street', 'ship address'],
  shipping_address2: ['shipping address2', 'shipping address 2', 'ship address 2'],
  shipping_city: ['shipping city', 'ship city'],
  shipping_province: ['shipping province', 'shipping state', 'ship state', 'shipping province name'],
  shipping_zip: ['shipping zip', 'shipping postal', 'ship zip', 'shipping zip code'],
  shipping_country: ['shipping country', 'ship country', 'shipping country/region'],
  shipping_phone: ['shipping phone', 'ship phone'],
  billing_name: ['billing name', 'bill to', 'billing first name'],
  billing_address1: ['billing address1', 'billing address 1', 'billing street'],
  billing_city: ['billing city', 'bill city'],
  billing_province: ['billing province', 'billing state', 'bill state'],
  billing_zip: ['billing zip', 'billing postal', 'bill zip'],
  billing_country: ['billing country', 'bill country'],
  // Line items — ORDER MATTERS: put the most-specific ("line item X")
  // synonyms first so they claim their columns before the generic
  // single-word fallbacks (`title`, `sku`, `price`) can grab the wrong
  // column in files that also have unrelated "Title" / "Price" headers.
  line_item_title: [
    'line item title',      // Gbox exporter
    'lineitem name',        // Shopify
    'lineitem_name',
    'line item name',
    'product title',
    'product name',
    'item title',
    'item name',
    'product',
    'title',                // last-resort fallback
  ],
  line_item_sku: [
    'line item sku',        // Gbox exporter
    'lineitem sku',         // Shopify
    'lineitem_sku',
    'item sku',
    'product sku',
    'sku',
  ],
  line_item_variant: [
    'line item variant',    // Gbox exporter
    'lineitem variant',     // Shopify
    'variant title',
    'variant',
    'option',
  ],
  line_item_quantity: [
    'line item quantity',   // Gbox exporter
    'lineitem quantity',    // Shopify
    'lineitem_quantity',
    'item qty',
    'quantity',
    'qty',
  ],
  line_item_price: [
    'line item price',      // Gbox exporter
    'lineitem price',       // Shopify
    'lineitem_price',
    'item price',
    'unit price',
    'price',
  ],
  line_item_discount: [
    'line item discount',   // Gbox exporter
    'lineitem discount',    // Shopify
    'item discount',
    'line discount',
  ],
  // Payment
  payment_gateway: ['payment method', 'payment gateway', 'gateway', 'payment type'],
  transaction_id: ['transaction id', 'transaction_id', 'payment reference', 'txn id'],
  // Fulfillment
  tracking_company: ['carrier', 'shipping carrier', 'tracking company', 'courier', 'fulfillment carrier'],
  tracking_number: ['tracking number', 'tracking_number', 'tracking #', 'track number', 'fulfillment tracking number'],
}

/**
 * Auto-detect column mapping from CSV headers.
 * Returns a mapping of { csvHeaderIndex: gboxFieldKey }.
 */
export function autoDetectMapping(headers: string[]): Record<number, string> {
  const mapping: Record<number, string> = {}
  const normalizedHeaders = headers.map(h => h.toLowerCase().trim())

  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (let i = 0; i < normalizedHeaders.length; i++) {
      if (mapping[i]) continue // Already mapped
      const h = normalizedHeaders[i]
      if (synonyms.includes(h)) {
        mapping[i] = field
        break
      }
    }
  }

  return mapping
}

// ---------------------------------------------------------------------------
// Apply Mapping → Normalized Orders
// ---------------------------------------------------------------------------

import type { NormalizedOrder, NormalizedLineItem, ParseResult, ParseError } from './types.js'

/**
 * Convert CSV rows into NormalizedOrders using a column mapping.
 *
 * CSV rows where multiple rows share the same order_id are grouped
 * (Shopify format: one row per line item, order fields repeated).
 */
export function applyMapping(
  headers: string[],
  rows: string[][],
  mapping: Record<number, string>,
  platform: string = 'csv',
): ParseResult {
  const errors: ParseError[] = []
  const orderMap = new Map<string, { order: NormalizedOrder; row: number }>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 2 // +2 because row 1 is headers, data starts at row 2

    // Extract values by mapping
    const vals: Record<string, string> = {}
    for (const [colIdx, field] of Object.entries(mapping)) {
      const idx = parseInt(colIdx, 10)
      if (idx < row.length) {
        vals[field] = row[idx]
      }
    }

    // Order ID
    const orderId = vals.external_id || vals.order_number || `row-${rowNum}`
    if (!orderId || orderId === '') {
      errors.push({ row: rowNum, field: 'external_id', message: 'Missing order ID' })
      continue
    }

    // Line item for this row
    const lineItem: NormalizedLineItem = {
      external_id: vals.line_item_sku || undefined,
      title: vals.line_item_title || 'Unknown Product',
      variant_title: vals.line_item_variant || undefined,
      sku: vals.line_item_sku || undefined,
      quantity: parseInt(vals.line_item_quantity, 10) || 1,
      price: parseFloat(vals.line_item_price) || 0,
      total_discount: parseFloat(vals.line_item_discount) || 0,
    }

    // Check if order already exists (multi-row per order)
    const existing = orderMap.get(orderId)
    if (existing) {
      // Just add line item
      if (lineItem.title && lineItem.title !== 'Unknown Product') {
        existing.order.line_items.push(lineItem)
      }
      continue
    }

    // Parse address from flat fields
    const shippingAddr = (vals.shipping_address1 || vals.shipping_city || vals.shipping_name) ? {
      first_name: vals.shipping_name?.split(' ')[0] || undefined,
      last_name: vals.shipping_name?.split(' ').slice(1).join(' ') || undefined,
      address1: vals.shipping_address1 || undefined,
      address2: vals.shipping_address2 || undefined,
      city: vals.shipping_city || undefined,
      province: vals.shipping_province || undefined,
      zip: vals.shipping_zip || undefined,
      country: vals.shipping_country || undefined,
      phone: vals.shipping_phone || undefined,
    } : undefined

    const billingAddr = (vals.billing_address1 || vals.billing_city || vals.billing_name) ? {
      first_name: vals.billing_name?.split(' ')[0] || undefined,
      last_name: vals.billing_name?.split(' ').slice(1).join(' ') || undefined,
      address1: vals.billing_address1 || undefined,
      city: vals.billing_city || undefined,
      province: vals.billing_province || undefined,
      zip: vals.billing_zip || undefined,
      country: vals.billing_country || undefined,
    } : undefined

    // Parse tags
    const tags = vals.tags ? vals.tags.split(',').map(t => t.trim()).filter(Boolean) : undefined

    const order: NormalizedOrder = {
      external_id: orderId,
      external_platform: platform,
      order_number: vals.order_number ? parseInt(vals.order_number, 10) || undefined : undefined,
      created_at: vals.created_at || new Date().toISOString(),
      financial_status: (vals.financial_status?.toLowerCase() as any) || 'pending',
      fulfillment_status: (vals.fulfillment_status?.toLowerCase() as any) || 'unfulfilled',
      currency: vals.currency || 'USD',
      subtotal_price: parseFloat(vals.subtotal_price) || undefined,
      total_discounts: parseFloat(vals.total_discounts) || 0,
      total_shipping: parseFloat(vals.total_shipping) || 0,
      total_tax: parseFloat(vals.total_tax) || 0,
      total_price: parseFloat(vals.total_price) || 0,
      email: vals.email || undefined,
      phone: vals.phone || undefined,
      note: vals.note || undefined,
      tags,
      shipping_address: shippingAddr,
      billing_address: billingAddr,
      line_items: lineItem.title !== 'Unknown Product' ? [lineItem] : [],
      payment_gateway: vals.payment_gateway || undefined,
      transaction_id: vals.transaction_id || undefined,
      tracking_company: vals.tracking_company || undefined,
      tracking_number: vals.tracking_number || undefined,
    }

    orderMap.set(orderId, { order, row: rowNum })
  }

  return {
    orders: Array.from(orderMap.values()).map(v => v.order),
    errors,
    totalRows: rows.length,
    platform,
  }
}
