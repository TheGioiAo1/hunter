/**
 * Etsy Order Export Parser (Sprint 6)
 *
 * Parses the "Orders.csv" download from Etsy Seller Dashboard →
 * "Settings → Options → Download Data → Orders".
 *
 * Etsy's export has ONE row per order (unlike Shopify / TikTok which
 * are one-row-per-line-item). The line item detail — item name,
 * variations, quantity, price — is crammed into a handful of columns
 * with pipe / `; ` separators. We split those out into individual
 * NormalizedLineItem entries.
 *
 * Canonical Etsy columns (v2024):
 *   Sale Date, Order ID, Buyer User ID, Full Name, First Name,
 *   Last Name, Number of Items, Payment Method, Payment Type,
 *   Item Total, Shipping, Sales Tax, Discount Amount, Order Value,
 *   Currency, Status, Card Processing Fees, Order Net, Adjusted
 *   Item Total, Adjusted Shipping, Buyer, Order Type, Payments,
 *   Ship To Name, Ship Address1, Ship Address2, Ship City, Ship State,
 *   Ship Zipcode, Ship Country, In Person Discount, In Person Location,
 *   VAT Paid by Buyer, SKU, Product Title, Variations, Quantity,
 *   Price
 *
 * Older exports merged items into single fields — we tolerate both.
 */

import type {
  ImportPlatformParser,
  NormalizedOrder,
  NormalizedLineItem,
  ParseResult,
  ParseError,
} from './types.js'

function col(headers: string[], ...names: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().trim())
  for (const name of names) {
    const n = name.toLowerCase()
    const i = lower.indexOf(n)
    if (i >= 0) return i
  }
  return -1
}

function getVal(row: string[], idx: number): string {
  if (idx < 0 || idx >= row.length) return ''
  return (row[idx] ?? '').trim()
}

function parseMoney(raw: string): number {
  if (!raw) return 0
  // Etsy formats as `$12.34` or `12,34` (EU) — strip symbols + use .
  const cleaned = raw
    .replace(/[^\d.,\-]/g, '')
    .replace(/(\d),(\d{2})$/, '$1.$2') // EU decimal comma → dot
    .replace(/,(?=\d{3})/g, '') // US thousand separator
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

function parseIntSafe(raw: string, fallback = 1): number {
  const n = parseInt((raw || '').replace(/[^\d\-]/g, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Split a "Product Title" column that may contain multiple items
 * joined by `;` or `|`. Quantity / price columns use the same
 * separator so we keep the indices aligned.
 */
function splitMulti(raw: string): string[] {
  if (!raw) return []
  const parts = raw.includes('|') ? raw.split('|') : raw.split(';')
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

export const etsyParser: ImportPlatformParser = {
  platform: 'etsy',
  label: 'Etsy',

  detect(headers: string[]): boolean {
    const lower = headers.map((h) => h.toLowerCase().trim())
    // Etsy's export signature: has "Order ID" + at least one Etsy-unique
    // column like "Sale Date", "Ship To Name", or "Buyer User ID".
    const hasOrderId = lower.some((h) => h === 'order id')
    const etsySignals = [
      'sale date',
      'buyer user id',
      'ship to name',
      'item total',
      'order value',
    ]
    const hits = etsySignals.filter((s) => lower.includes(s)).length
    return hasOrderId && hits >= 2
  },

  parse(headers: string[], rows: string[][]): ParseResult {
    const errors: ParseError[] = []
    const orders: NormalizedOrder[] = []

    // Cache header indices up front
    const idx = {
      orderId: col(headers, 'order id'),
      saleDate: col(headers, 'sale date', 'date paid'),
      status: col(headers, 'status'),
      currency: col(headers, 'currency'),
      itemTotal: col(headers, 'item total', 'adjusted item total'),
      shipping: col(headers, 'shipping', 'adjusted shipping'),
      tax: col(headers, 'sales tax', 'vat paid by buyer'),
      discount: col(headers, 'discount amount', 'in person discount'),
      orderValue: col(headers, 'order value', 'order net'),
      payment: col(headers, 'payment method', 'payment type'),
      email: col(headers, 'email', 'buyer email'),
      buyerFull: col(headers, 'full name', 'ship to name', 'buyer'),
      firstName: col(headers, 'first name'),
      lastName: col(headers, 'last name'),
      phone: col(headers, 'phone', 'buyer phone'),
      address1: col(headers, 'ship address1', 'ship address 1'),
      address2: col(headers, 'ship address2', 'ship address 2'),
      city: col(headers, 'ship city'),
      province: col(headers, 'ship state'),
      zip: col(headers, 'ship zipcode', 'ship zip'),
      country: col(headers, 'ship country'),
      sku: col(headers, 'sku', 'seller sku'),
      title: col(headers, 'product title', 'item name', 'title'),
      variations: col(headers, 'variations', 'variation'),
      quantity: col(headers, 'quantity', 'number of items'),
      price: col(headers, 'price', 'unit price'),
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowNum = i + 2

      const orderId = getVal(row, idx.orderId)
      if (!orderId) {
        errors.push({ row: rowNum, message: 'Missing Order ID' })
        continue
      }

      // Etsy status → normalised status
      const statusRaw = getVal(row, idx.status).toLowerCase()
      let financialStatus: NormalizedOrder['financial_status'] = 'paid'
      let fulfillmentStatus: NormalizedOrder['fulfillment_status'] = 'unfulfilled'
      if (statusRaw.includes('paid') && !statusRaw.includes('unpaid')) {
        financialStatus = 'paid'
      }
      if (
        statusRaw.includes('shipped') ||
        statusRaw.includes('completed') ||
        statusRaw.includes('delivered')
      ) {
        fulfillmentStatus = 'fulfilled'
      }
      if (statusRaw.includes('cancel') || statusRaw.includes('refund')) {
        financialStatus = statusRaw.includes('refund') ? 'refunded' : 'voided'
      }

      // Split line items — Etsy sometimes concatenates multiple items
      // into the Product Title / SKU / Quantity / Price columns.
      const titles = splitMulti(getVal(row, idx.title))
      const skus = splitMulti(getVal(row, idx.sku))
      const variations = splitMulti(getVal(row, idx.variations))
      const quantities = splitMulti(getVal(row, idx.quantity))
      const prices = splitMulti(getVal(row, idx.price))

      const lineCount = Math.max(
        titles.length,
        skus.length,
        quantities.length,
        1,
      )

      const lineItems: NormalizedLineItem[] = []
      for (let k = 0; k < lineCount; k++) {
        const title = titles[k] || titles[0] || 'Unknown Item'
        const sku = skus[k] || skus[0] || undefined
        const variation = variations[k] || variations[0] || undefined
        const qty = parseIntSafe(quantities[k] ?? quantities[0] ?? '1', 1)
        const price = parseMoney(prices[k] ?? prices[0] ?? '0')
        lineItems.push({
          external_id: sku,
          title,
          variant_title: variation,
          sku,
          quantity: qty,
          price,
        })
      }

      // Shipping / billing — Etsy only ships to one address
      const firstName =
        getVal(row, idx.firstName) ||
        getVal(row, idx.buyerFull).split(' ')[0] ||
        undefined
      const lastName =
        getVal(row, idx.lastName) ||
        getVal(row, idx.buyerFull).split(' ').slice(1).join(' ') ||
        undefined

      const address1 = getVal(row, idx.address1)
      const shippingAddress = address1
        ? {
            first_name: firstName,
            last_name: lastName,
            address1,
            address2: getVal(row, idx.address2) || undefined,
            city: getVal(row, idx.city) || undefined,
            province: getVal(row, idx.province) || undefined,
            zip: getVal(row, idx.zip) || undefined,
            country: getVal(row, idx.country) || undefined,
            phone: getVal(row, idx.phone) || undefined,
          }
        : undefined

      const order: NormalizedOrder = {
        external_id: orderId,
        external_platform: 'etsy',
        created_at: getVal(row, idx.saleDate) || new Date().toISOString(),
        financial_status: financialStatus,
        fulfillment_status: fulfillmentStatus,
        currency: getVal(row, idx.currency) || 'USD',
        subtotal_price: parseMoney(getVal(row, idx.itemTotal)),
        total_shipping: parseMoney(getVal(row, idx.shipping)),
        total_tax: parseMoney(getVal(row, idx.tax)),
        total_discounts: parseMoney(getVal(row, idx.discount)),
        total_price:
          parseMoney(getVal(row, idx.orderValue)) ||
          parseMoney(getVal(row, idx.itemTotal)) +
            parseMoney(getVal(row, idx.shipping)) +
            parseMoney(getVal(row, idx.tax)),
        email: getVal(row, idx.email) || undefined,
        phone: getVal(row, idx.phone) || undefined,
        shipping_address: shippingAddress,
        line_items: lineItems,
        payment_gateway: getVal(row, idx.payment) || 'Etsy Payments',
      }

      orders.push(order)
    }

    return {
      orders,
      errors,
      totalRows: rows.length,
      platform: 'etsy',
    }
  },
}
