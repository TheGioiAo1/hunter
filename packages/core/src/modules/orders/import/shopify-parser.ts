/**
 * Shopify Orders CSV Parser
 *
 * Parses the Shopify admin /orders/export.csv format.
 * Shopify uses one row per line item — multiple rows share the same
 * "Name" (order number like #1001). Order-level fields are repeated
 * on each row but only the first row's values matter.
 *
 * Key Shopify CSV columns:
 *   Name, Email, Financial Status, Paid at, Fulfillment Status,
 *   Fulfilled at, Currency, Subtotal, Shipping, Taxes, Total,
 *   Lineitem quantity, Lineitem name, Lineitem price, Lineitem sku,
 *   Billing Name, Billing Street, Billing City, Billing Province,
 *   Billing Zip, Billing Country, Shipping Name, Shipping Street,
 *   Shipping City, Shipping Province, Shipping Zip, Shipping Country,
 *   Notes, Tags, etc.
 */

import type { ImportPlatformParser, NormalizedOrder, NormalizedLineItem, ParseResult, ParseError } from './types.js'

// Shopify CSV column names (exact match)
const SHOPIFY_HEADERS = [
  'name', 'email', 'financial status', 'paid at', 'fulfillment status',
  'fulfilled at', 'currency', 'subtotal', 'shipping', 'taxes', 'total',
  'lineitem quantity', 'lineitem name', 'lineitem price', 'lineitem sku',
  'lineitem variant', 'lineitem discount',
  'billing name', 'billing street', 'billing address1', 'billing address2',
  'billing city', 'billing zip', 'billing province', 'billing country',
  'billing phone',
  'shipping name', 'shipping street', 'shipping address1', 'shipping address2',
  'shipping city', 'shipping zip', 'shipping province', 'shipping country',
  'shipping phone',
  'notes', 'note', 'tags',
  'created at', 'discount code', 'discount amount',
  'payment method', 'payment reference',
]

function col(headers: string[], name: string): number {
  const normalized = headers.map(h => h.toLowerCase().trim())
  return normalized.indexOf(name.toLowerCase())
}

function getVal(row: string[], headers: string[], name: string): string {
  const idx = col(headers, name)
  return idx >= 0 && idx < row.length ? row[idx] : ''
}

export const shopifyParser: ImportPlatformParser = {
  platform: 'shopify',
  label: 'Shopify',

  detect(headers: string[]): boolean {
    const normalized = headers.map(h => h.toLowerCase().trim())
    // Shopify exports always have "Name" and "Lineitem name"
    return (
      (normalized.includes('name') || normalized.includes('order name')) &&
      (normalized.includes('lineitem name') || normalized.includes('lineitem quantity'))
    )
  },

  parse(headers: string[], rows: string[][]): ParseResult {
    const errors: ParseError[] = []
    const orderMap = new Map<string, { order: NormalizedOrder; row: number }>()

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowNum = i + 2

      const orderName = getVal(row, headers, 'name') || getVal(row, headers, 'order name')
      if (!orderName) {
        errors.push({ row: rowNum, message: 'Missing order Name column' })
        continue
      }

      // Line item
      const liTitle = getVal(row, headers, 'lineitem name')
      const liQty = parseInt(getVal(row, headers, 'lineitem quantity'), 10) || 1
      const liPrice = parseFloat(getVal(row, headers, 'lineitem price')) || 0
      const liSku = getVal(row, headers, 'lineitem sku')
      const liVariant = getVal(row, headers, 'lineitem variant')
      const liDiscount = parseFloat(getVal(row, headers, 'lineitem discount')) || 0

      const lineItem: NormalizedLineItem = {
        title: liTitle || 'Unknown Product',
        variant_title: liVariant || undefined,
        sku: liSku || undefined,
        quantity: liQty,
        price: liPrice,
        total_discount: liDiscount,
      }

      // Group rows by order name
      const existing = orderMap.get(orderName)
      if (existing) {
        if (liTitle) existing.order.line_items.push(lineItem)
        continue
      }

      // Parse addresses
      const shippingAddr = {
        first_name: (getVal(row, headers, 'shipping name') || '').split(' ')[0] || undefined,
        last_name: (getVal(row, headers, 'shipping name') || '').split(' ').slice(1).join(' ') || undefined,
        address1: getVal(row, headers, 'shipping street') || getVal(row, headers, 'shipping address1') || undefined,
        address2: getVal(row, headers, 'shipping address2') || undefined,
        city: getVal(row, headers, 'shipping city') || undefined,
        province: getVal(row, headers, 'shipping province') || undefined,
        zip: getVal(row, headers, 'shipping zip') || undefined,
        country: getVal(row, headers, 'shipping country') || undefined,
        phone: getVal(row, headers, 'shipping phone') || undefined,
      }

      const billingAddr = {
        first_name: (getVal(row, headers, 'billing name') || '').split(' ')[0] || undefined,
        last_name: (getVal(row, headers, 'billing name') || '').split(' ').slice(1).join(' ') || undefined,
        address1: getVal(row, headers, 'billing street') || getVal(row, headers, 'billing address1') || undefined,
        address2: getVal(row, headers, 'billing address2') || undefined,
        city: getVal(row, headers, 'billing city') || undefined,
        province: getVal(row, headers, 'billing province') || undefined,
        zip: getVal(row, headers, 'billing zip') || undefined,
        country: getVal(row, headers, 'billing country') || undefined,
        phone: getVal(row, headers, 'billing phone') || undefined,
      }

      // Tags
      const tagsRaw = getVal(row, headers, 'tags')
      const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : undefined

      // Map Shopify financial status
      const financialRaw = getVal(row, headers, 'financial status').toLowerCase()
      const financialMap: Record<string, any> = {
        paid: 'paid', pending: 'pending', refunded: 'refunded',
        partially_refunded: 'partially_paid', voided: 'voided',
        authorized: 'pending',
      }

      // Map Shopify fulfillment status
      const fulfillRaw = getVal(row, headers, 'fulfillment status').toLowerCase()
      const fulfillMap: Record<string, any> = {
        fulfilled: 'fulfilled', unfulfilled: 'unfulfilled', partial: 'partial',
      }

      const order: NormalizedOrder = {
        external_id: orderName,
        external_platform: 'shopify',
        order_number: parseInt(orderName.replace(/[^0-9]/g, ''), 10) || undefined,
        created_at: getVal(row, headers, 'created at') || new Date().toISOString(),
        financial_status: financialMap[financialRaw] || 'pending',
        fulfillment_status: fulfillMap[fulfillRaw] || 'unfulfilled',
        currency: getVal(row, headers, 'currency') || 'USD',
        subtotal_price: parseFloat(getVal(row, headers, 'subtotal')) || 0,
        total_discounts: parseFloat(getVal(row, headers, 'discount amount')) || 0,
        total_shipping: parseFloat(getVal(row, headers, 'shipping')) || 0,
        total_tax: parseFloat(getVal(row, headers, 'taxes')) || 0,
        total_price: parseFloat(getVal(row, headers, 'total')) || 0,
        email: getVal(row, headers, 'email') || undefined,
        note: getVal(row, headers, 'notes') || getVal(row, headers, 'note') || undefined,
        tags,
        shipping_address: shippingAddr.address1 ? shippingAddr : undefined,
        billing_address: billingAddr.address1 ? billingAddr : undefined,
        line_items: liTitle ? [lineItem] : [],
        payment_gateway: getVal(row, headers, 'payment method') || undefined,
        transaction_id: getVal(row, headers, 'payment reference') || undefined,
      }

      orderMap.set(orderName, { order, row: rowNum })
    }

    return {
      orders: Array.from(orderMap.values()).map(v => v.order),
      errors,
      totalRows: rows.length,
      platform: 'shopify',
    }
  },
}
