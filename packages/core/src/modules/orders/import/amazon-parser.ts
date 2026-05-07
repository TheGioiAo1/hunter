/**
 * Amazon Order Report Parser
 *
 * Parses Amazon Seller Central's order report CSV/TSV.
 * Amazon exports orders and items separately, but most sellers
 * download a combined "All Orders" report with one row per item.
 *
 * Key Amazon columns:
 *   amazon-order-id, purchase-date, order-status, product-name,
 *   sku, quantity, item-price, item-tax, shipping-price,
 *   ship-address-1, ship-address-2, ship-city, ship-state,
 *   ship-postal-code, ship-country, buyer-email, currency
 */

import type { ImportPlatformParser, NormalizedOrder, NormalizedLineItem, ParseResult, ParseError } from './types.js'

function col(headers: string[], name: string): number {
  const normalized = headers.map(h => h.toLowerCase().trim().replace(/-/g, ' '))
  return normalized.indexOf(name.toLowerCase().replace(/-/g, ' '))
}

function getVal(row: string[], headers: string[], name: string): string {
  const idx = col(headers, name)
  return idx >= 0 && idx < row.length ? row[idx] : ''
}

export const amazonParser: ImportPlatformParser = {
  platform: 'amazon',
  label: 'Amazon',

  detect(headers: string[]): boolean {
    const normalized = headers.map(h => h.toLowerCase().trim().replace(/-/g, ' '))
    return (
      (normalized.includes('amazon order id') || normalized.includes('order id')) &&
      (normalized.includes('product name') || normalized.includes('sku') || normalized.includes('asin'))
    )
  },

  parse(headers: string[], rows: string[][]): ParseResult {
    const errors: ParseError[] = []
    const orderMap = new Map<string, { order: NormalizedOrder; row: number }>()

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowNum = i + 2

      const orderId = getVal(row, headers, 'amazon-order-id') || getVal(row, headers, 'order-id')
      if (!orderId) {
        errors.push({ row: rowNum, message: 'Missing amazon-order-id' })
        continue
      }

      // Line item
      const productName = getVal(row, headers, 'product-name') || getVal(row, headers, 'title')
      const sku = getVal(row, headers, 'sku') || getVal(row, headers, 'seller-sku')
      const asin = getVal(row, headers, 'asin')
      const qty = parseInt(getVal(row, headers, 'quantity') || getVal(row, headers, 'quantity-purchased'), 10) || 1
      const price = parseFloat(getVal(row, headers, 'item-price') || getVal(row, headers, 'item-total')) || 0
      const itemTax = parseFloat(getVal(row, headers, 'item-tax')) || 0

      const lineItem: NormalizedLineItem = {
        external_id: asin || sku || undefined,
        title: productName || sku || asin || 'Unknown Product',
        sku: sku || asin || undefined,
        quantity: qty,
        price: qty > 0 ? (price / qty) : price,
      }

      // Multi-row grouping
      const existing = orderMap.get(orderId)
      if (existing) {
        if (productName || sku) existing.order.line_items.push(lineItem)
        // Accumulate tax
        const prevTax = parseFloat(String(existing.order.total_tax || 0))
        existing.order.total_tax = prevTax + itemTax
        continue
      }

      // Map Amazon order status
      const statusRaw = (getVal(row, headers, 'order-status') || '').toLowerCase()
      const financialStatus = statusRaw === 'shipped' || statusRaw === 'unshipped' ? 'paid'
        : statusRaw === 'cancelled' ? 'voided'
        : statusRaw === 'pending' ? 'pending'
        : 'paid'

      const fulfillmentStatus = statusRaw === 'shipped' ? 'fulfilled'
        : statusRaw === 'cancelled' ? 'unfulfilled'
        : 'unfulfilled'

      // Shipping address
      const shippingAddr = {
        first_name: (getVal(row, headers, 'recipient-name') || getVal(row, headers, 'ship-address-name') || '').split(' ')[0] || undefined,
        last_name: (getVal(row, headers, 'recipient-name') || getVal(row, headers, 'ship-address-name') || '').split(' ').slice(1).join(' ') || undefined,
        address1: getVal(row, headers, 'ship-address-1') || undefined,
        address2: getVal(row, headers, 'ship-address-2') || undefined,
        city: getVal(row, headers, 'ship-city') || undefined,
        province: getVal(row, headers, 'ship-state') || undefined,
        zip: getVal(row, headers, 'ship-postal-code') || undefined,
        country: getVal(row, headers, 'ship-country') || undefined,
        phone: getVal(row, headers, 'ship-phone-number') || undefined,
      }

      const shippingPrice = parseFloat(getVal(row, headers, 'shipping-price')) || 0

      const order: NormalizedOrder = {
        external_id: orderId,
        external_platform: 'amazon',
        created_at: getVal(row, headers, 'purchase-date') || getVal(row, headers, 'order-date') || new Date().toISOString(),
        financial_status: financialStatus as any,
        fulfillment_status: fulfillmentStatus as any,
        currency: getVal(row, headers, 'currency') || 'USD',
        total_price: price,
        total_shipping: shippingPrice,
        total_tax: itemTax,
        email: getVal(row, headers, 'buyer-email') || undefined,
        phone: getVal(row, headers, 'buyer-phone-number') || undefined,
        shipping_address: shippingAddr.address1 ? shippingAddr : undefined,
        line_items: (productName || sku) ? [lineItem] : [],
        payment_gateway: 'Amazon',
      }

      orderMap.set(orderId, { order, row: rowNum })
    }

    // Post-process: recalculate total_price for multi-item orders
    for (const { order } of orderMap.values()) {
      if (order.line_items.length > 1) {
        const itemsTotal = order.line_items.reduce((sum, li) =>
          sum + Number(li.price) * li.quantity, 0)
        order.total_price = itemsTotal + Number(order.total_shipping || 0) + Number(order.total_tax || 0)
        order.subtotal_price = itemsTotal
      }
    }

    return {
      orders: Array.from(orderMap.values()).map(v => v.order),
      errors,
      totalRows: rows.length,
      platform: 'amazon',
    }
  },
}
