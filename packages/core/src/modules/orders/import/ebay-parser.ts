/**
 * eBay Order Export Parser (Sprint 6)
 *
 * Parses the "Orders" CSV download from eBay Seller Hub → Orders →
 * Download Report. eBay's export has one row per order, with
 * multi-line-item orders flattening all items into one cell separated
 * by `;`. The column names are inconsistent across marketplaces
 * (ebay.com, ebay.co.uk, ebay.de) so we accept a handful of
 * synonyms for each field.
 *
 * Canonical eBay columns (ebay.com 2024):
 *   Order Number, Sales Record Number, Order Creation Date,
 *   Order Paid On, Buyer Username, Buyer Name, Buyer Email,
 *   Buyer Address 1, Buyer Address 2, Buyer City, Buyer State,
 *   Buyer Zip, Buyer Country, Item Number, Item Title, Custom Label
 *   (SKU), Quantity, Item Subtotal, Sold For, Shipping And Handling,
 *   Sales Tax, Total Price, Currency, Payment Method, Sale Status,
 *   Tracking Number, Shipping Service
 *
 * Design:
 *   1. **One row = one order** — items concatenated by `;` in the
 *      Item Title / Custom Label / Quantity / Sold For columns are
 *      re-split into individual line items with aligned indices.
 *   2. **Tolerant header matching** — we accept both "Custom Label"
 *      and "SKU", both "Sold For" and "Item Subtotal", etc.
 *   3. **Status normalisation** — eBay's "Payment Received",
 *      "Shipped", "Completed" map to our financial/fulfillment enums.
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
    const i = lower.indexOf(name.toLowerCase())
    if (i >= 0) return i
  }
  // Fall back to substring match (eBay occasionally wraps header
  // names with notes like "(USD)").
  for (const name of names) {
    const n = name.toLowerCase()
    for (let i = 0; i < lower.length; i++) {
      if (lower[i].includes(n)) return i
    }
  }
  return -1
}

function getVal(row: string[], idx: number): string {
  if (idx < 0 || idx >= row.length) return ''
  return (row[idx] ?? '').trim()
}

function parseMoney(raw: string): number {
  if (!raw) return 0
  const cleaned = raw
    .replace(/[^\d.,\-]/g, '')
    .replace(/(\d),(\d{2})$/, '$1.$2')
    .replace(/,(?=\d{3})/g, '')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

function parseIntSafe(raw: string, fallback = 1): number {
  const n = parseInt((raw || '').replace(/[^\d\-]/g, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function splitMulti(raw: string): string[] {
  if (!raw) return []
  const parts = raw.includes(';') ? raw.split(';') : raw.split('|')
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

export const ebayParser: ImportPlatformParser = {
  platform: 'ebay',
  label: 'eBay',

  detect(headers: string[]): boolean {
    const lower = headers.map((h) => h.toLowerCase().trim())
    // eBay's export signature: "Order Number" (or "Sales Record Number")
    // plus at least one eBay-unique column.
    const hasOrderCol = lower.some(
      (h) =>
        h === 'order number' ||
        h === 'sales record number' ||
        h.includes('order number'),
    )
    const ebaySignals = [
      'buyer username',
      'custom label',
      'item number',
      'sold for',
      'shipping and handling',
      'sale status',
    ]
    const hits = ebaySignals.filter((s) =>
      lower.some((h) => h === s || h.includes(s)),
    ).length
    return hasOrderCol && hits >= 2
  },

  parse(headers: string[], rows: string[][]): ParseResult {
    const errors: ParseError[] = []
    const orders: NormalizedOrder[] = []

    const idx = {
      orderNum: col(headers, 'order number', 'sales record number'),
      createdAt: col(headers, 'order creation date', 'order paid on', 'sale date'),
      status: col(headers, 'sale status', 'order status', 'status'),
      buyerUser: col(headers, 'buyer username', 'buyer id'),
      buyerName: col(headers, 'buyer name', 'ship to name'),
      email: col(headers, 'buyer email', 'email'),
      phone: col(headers, 'buyer phone', 'phone'),
      address1: col(headers, 'buyer address 1', 'ship to address 1', 'address line 1'),
      address2: col(headers, 'buyer address 2', 'ship to address 2', 'address line 2'),
      city: col(headers, 'buyer city', 'ship to city', 'city'),
      province: col(headers, 'buyer state', 'ship to state', 'state'),
      zip: col(headers, 'buyer zip', 'ship to zip', 'post code', 'zip code'),
      country: col(headers, 'buyer country', 'ship to country', 'country'),
      itemNumber: col(headers, 'item number'),
      title: col(headers, 'item title', 'title'),
      sku: col(headers, 'custom label', 'sku', 'seller sku'),
      quantity: col(headers, 'quantity'),
      unitPrice: col(headers, 'sold for', 'item subtotal', 'unit price'),
      shipping: col(headers, 'shipping and handling', 'shipping cost'),
      tax: col(headers, 'sales tax', 'tax'),
      total: col(headers, 'total price', 'order total'),
      currency: col(headers, 'currency'),
      payment: col(headers, 'payment method'),
      tracking: col(headers, 'tracking number'),
      carrier: col(headers, 'shipping service', 'carrier'),
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowNum = i + 2

      const orderNum = getVal(row, idx.orderNum)
      if (!orderNum) {
        errors.push({ row: rowNum, message: 'Missing Order Number' })
        continue
      }

      // Status mapping
      const statusRaw = getVal(row, idx.status).toLowerCase()
      let financialStatus: NormalizedOrder['financial_status'] = 'paid'
      let fulfillmentStatus: NormalizedOrder['fulfillment_status'] = 'unfulfilled'
      if (statusRaw.includes('awaiting payment') || statusRaw.includes('unpaid')) {
        financialStatus = 'pending'
      } else if (statusRaw.includes('refunded')) {
        financialStatus = 'refunded'
      } else if (statusRaw.includes('cancel')) {
        financialStatus = 'voided'
      }
      if (
        statusRaw.includes('shipped') ||
        statusRaw.includes('delivered') ||
        statusRaw.includes('completed')
      ) {
        fulfillmentStatus = 'fulfilled'
      }

      // Multi-line items (eBay concatenates with `;`)
      const titles = splitMulti(getVal(row, idx.title))
      const skus = splitMulti(getVal(row, idx.sku))
      const itemNums = splitMulti(getVal(row, idx.itemNumber))
      const qtys = splitMulti(getVal(row, idx.quantity))
      const prices = splitMulti(getVal(row, idx.unitPrice))

      const lineCount = Math.max(
        titles.length,
        skus.length,
        itemNums.length,
        1,
      )
      const lineItems: NormalizedLineItem[] = []
      for (let k = 0; k < lineCount; k++) {
        lineItems.push({
          external_id: itemNums[k] || itemNums[0] || skus[k] || undefined,
          title: titles[k] || titles[0] || 'Unknown Item',
          sku: skus[k] || skus[0] || undefined,
          quantity: parseIntSafe(qtys[k] ?? qtys[0] ?? '1', 1),
          price: parseMoney(prices[k] ?? prices[0] ?? '0'),
        })
      }

      // Address
      const buyerName = getVal(row, idx.buyerName)
      const firstName = buyerName.split(' ')[0] || undefined
      const lastName = buyerName.split(' ').slice(1).join(' ') || undefined

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

      const subtotal = lineItems.reduce(
        (sum, li) => sum + Number(li.price) * li.quantity,
        0,
      )

      const order: NormalizedOrder = {
        external_id: orderNum,
        external_platform: 'ebay',
        order_number: orderNum,
        created_at: getVal(row, idx.createdAt) || new Date().toISOString(),
        financial_status: financialStatus,
        fulfillment_status: fulfillmentStatus,
        currency: getVal(row, idx.currency) || 'USD',
        subtotal_price: subtotal,
        total_shipping: parseMoney(getVal(row, idx.shipping)),
        total_tax: parseMoney(getVal(row, idx.tax)),
        total_price:
          parseMoney(getVal(row, idx.total)) ||
          subtotal +
            parseMoney(getVal(row, idx.shipping)) +
            parseMoney(getVal(row, idx.tax)),
        email: getVal(row, idx.email) || undefined,
        phone: getVal(row, idx.phone) || undefined,
        shipping_address: shippingAddress,
        line_items: lineItems,
        payment_gateway: getVal(row, idx.payment) || 'eBay Managed Payments',
        tracking_number: getVal(row, idx.tracking) || undefined,
        tracking_company: getVal(row, idx.carrier) || undefined,
      }

      orders.push(order)
    }

    return {
      orders,
      errors,
      totalRows: rows.length,
      platform: 'ebay',
    }
  },
}
