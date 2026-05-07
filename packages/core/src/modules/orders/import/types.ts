/**
 * Orders Import — Shared Types
 *
 * The normalized order format that ALL platform parsers convert to.
 * The importer validates this shape, then inserts into the database.
 */

// ---------------------------------------------------------------------------
// Normalized Order (all parsers output this)
// ---------------------------------------------------------------------------

export interface NormalizedOrder {
  /** External order ID/number from the source platform */
  external_id: string
  /** Source platform (csv, shopify, amazon, tiktok, woocommerce, etc.) */
  external_platform: string
  /** Order number (human-readable) */
  order_number?: number | string
  /** ISO timestamp when the order was created */
  created_at?: string
  /** Financial status */
  financial_status?: 'pending' | 'paid' | 'partially_paid' | 'refunded' | 'voided'
  /** Fulfillment status */
  fulfillment_status?: 'unfulfilled' | 'partial' | 'fulfilled'
  /** Currency code (ISO 4217) */
  currency?: string
  /** Price totals */
  subtotal_price?: number | string
  total_discounts?: number | string
  total_shipping?: number | string
  total_tax?: number | string
  total_price?: number | string
  /** Customer info */
  email?: string
  phone?: string
  /** Order note */
  note?: string
  /** Tags */
  tags?: string[]
  /** Shipping address */
  shipping_address?: NormalizedAddress
  /** Billing address */
  billing_address?: NormalizedAddress
  /** Line items */
  line_items: NormalizedLineItem[]
  /** Cancel info */
  cancel_reason?: string
  cancelled_at?: string
  /** Payment info */
  payment_gateway?: string
  payment_method?: string
  transaction_id?: string
  /** Fulfillment tracking */
  tracking_company?: string
  tracking_number?: string
  tracking_url?: string
}

export interface NormalizedAddress {
  first_name?: string
  last_name?: string
  company?: string
  address1?: string
  address2?: string
  city?: string
  province?: string
  zip?: string
  country?: string
  country_code?: string
  phone?: string
}

export interface NormalizedLineItem {
  /** External line item ID or SKU */
  external_id?: string
  title: string
  variant_title?: string
  sku?: string
  quantity: number
  price: number | string
  total_discount?: number | string
  requires_shipping?: boolean
  taxable?: boolean
  gift_card?: boolean
}

// ---------------------------------------------------------------------------
// Column Mapping (for CSV import wizard)
// ---------------------------------------------------------------------------

export interface ColumnMapping {
  /** Source column header name → target Gbox field */
  [sourceColumn: string]: string | null
}

/** All possible target fields for column mapping */
export const MAPPABLE_FIELDS = [
  // Order
  { key: 'external_id', label: 'Order ID / External ID', required: true },
  { key: 'order_number', label: 'Order Number' },
  { key: 'created_at', label: 'Created At / Date' },
  { key: 'financial_status', label: 'Payment Status' },
  { key: 'fulfillment_status', label: 'Fulfillment Status' },
  { key: 'currency', label: 'Currency' },
  { key: 'subtotal_price', label: 'Subtotal' },
  { key: 'total_discounts', label: 'Total Discounts' },
  { key: 'total_shipping', label: 'Total Shipping' },
  { key: 'total_tax', label: 'Total Tax' },
  { key: 'total_price', label: 'Total Price', required: true },
  { key: 'email', label: 'Customer Email' },
  { key: 'phone', label: 'Customer Phone' },
  { key: 'note', label: 'Note' },
  { key: 'tags', label: 'Tags' },
  // Address
  { key: 'shipping_name', label: 'Shipping Name' },
  { key: 'shipping_address1', label: 'Shipping Address 1' },
  { key: 'shipping_address2', label: 'Shipping Address 2' },
  { key: 'shipping_city', label: 'Shipping City' },
  { key: 'shipping_province', label: 'Shipping Province/State' },
  { key: 'shipping_zip', label: 'Shipping ZIP/Postal' },
  { key: 'shipping_country', label: 'Shipping Country' },
  { key: 'shipping_phone', label: 'Shipping Phone' },
  { key: 'billing_name', label: 'Billing Name' },
  { key: 'billing_address1', label: 'Billing Address 1' },
  { key: 'billing_city', label: 'Billing City' },
  { key: 'billing_province', label: 'Billing Province/State' },
  { key: 'billing_zip', label: 'Billing ZIP/Postal' },
  { key: 'billing_country', label: 'Billing Country' },
  // Line items
  { key: 'line_item_title', label: 'Product Title', required: true },
  { key: 'line_item_sku', label: 'Product SKU' },
  { key: 'line_item_variant', label: 'Variant' },
  { key: 'line_item_quantity', label: 'Quantity', required: true },
  { key: 'line_item_price', label: 'Item Price', required: true },
  { key: 'line_item_discount', label: 'Item Discount' },
  // Payment
  { key: 'payment_gateway', label: 'Payment Gateway' },
  { key: 'transaction_id', label: 'Transaction ID' },
  // Fulfillment
  { key: 'tracking_company', label: 'Shipping Carrier' },
  { key: 'tracking_number', label: 'Tracking Number' },
] as const

// ---------------------------------------------------------------------------
// Parser Interface
// ---------------------------------------------------------------------------

export interface ParseResult {
  orders: NormalizedOrder[]
  errors: ParseError[]
  /** Number of rows processed */
  totalRows: number
  /** Detected platform name */
  platform: string
}

export interface ParseError {
  row: number
  field?: string
  message: string
}

export interface ImportPlatformParser {
  /** Platform name identifier */
  platform: string
  /** Human label */
  label: string
  /** Detect whether a file matches this parser (by headers or structure) */
  detect(headers: string[], sampleRows?: string[][]): boolean
  /** Parse the file into normalized orders */
  parse(headers: string[], rows: string[][]): ParseResult
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: NormalizedOrder[]
  errors: ParseError[]
}

export function validateOrders(orders: NormalizedOrder[]): ValidationResult {
  const valid: NormalizedOrder[] = []
  const errors: ParseError[] = []

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]
    const rowNum = i + 1

    if (!o.external_id) {
      errors.push({ row: rowNum, field: 'external_id', message: 'Missing order ID' })
      continue
    }

    if (!o.line_items || o.line_items.length === 0) {
      errors.push({ row: rowNum, field: 'line_items', message: 'Order has no line items' })
      continue
    }

    // Validate line items
    let lineItemsValid = true
    for (const li of o.line_items) {
      if (!li.title) {
        errors.push({ row: rowNum, field: 'line_item_title', message: `Missing product title` })
        lineItemsValid = false
      }
      if (!li.quantity || li.quantity <= 0) {
        errors.push({ row: rowNum, field: 'line_item_quantity', message: `Invalid quantity: ${li.quantity}` })
        lineItemsValid = false
      }
    }

    if (!lineItemsValid) continue

    // Normalize financial_status
    if (o.financial_status) {
      const fs = o.financial_status.toLowerCase()
      if (['paid', 'pending', 'partially_paid', 'refunded', 'voided'].includes(fs)) {
        o.financial_status = fs as any
      } else {
        o.financial_status = 'pending'
      }
    } else {
      o.financial_status = 'pending'
    }

    // Normalize fulfillment_status
    if (o.fulfillment_status) {
      const ffs = o.fulfillment_status.toLowerCase()
      if (['unfulfilled', 'partial', 'fulfilled'].includes(ffs)) {
        o.fulfillment_status = ffs as any
      } else {
        o.fulfillment_status = 'unfulfilled'
      }
    } else {
      o.fulfillment_status = 'unfulfilled'
    }

    valid.push(o)
  }

  return { valid, errors }
}
