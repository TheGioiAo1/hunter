/**
 * TikTok Shop Order Export Parser
 *
 * Parses TikTok Shop's order export CSV/XLSX format.
 * TikTok exports have one row per item (similar to Shopify).
 *
 * Key TikTok Shop columns:
 *   Order ID, Order Status, SKU ID, Product Name, Variation,
 *   Quantity, SKU Unit Original Price, SKU Subtotal After Discount,
 *   Shipping Fee After Discount, Total Amount, Buyer Email,
 *   Buyer Message, Recipient, Phone #, Zipcode, State, City,
 *   Detail Address, Country/Region, Created Time, Paid Time,
 *   Tracking ID, Shipping Provider Name
 */

import type { ImportPlatformParser, NormalizedOrder, NormalizedLineItem, ParseResult, ParseError } from './types.js'

function col(headers: string[], name: string): number {
  const normalized = headers.map(h => h.toLowerCase().trim())
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === name.toLowerCase()) return i
    // Partial match for TikTok's verbose column names
    if (normalized[i].includes(name.toLowerCase())) return i
  }
  return -1
}

function getVal(row: string[], headers: string[], name: string): string {
  const idx = col(headers, name)
  return idx >= 0 && idx < row.length ? row[idx] : ''
}

export const tiktokParser: ImportPlatformParser = {
  platform: 'tiktok',
  label: 'TikTok Shop',

  detect(headers: string[]): boolean {
    const normalized = headers.map(h => h.toLowerCase().trim())
    // TikTok exports typically have "Order ID" + "SKU ID" or "Product Name"
    const hasOrderId = normalized.some(h => h === 'order id' || h.includes('order id'))
    const hasTiktokField = normalized.some(h =>
      h.includes('sku id') || h.includes('sku unit') || h.includes('buyer message') ||
      h.includes('package id') || h.includes('shipping provider')
    )
    return hasOrderId && hasTiktokField
  },

  parse(headers: string[], rows: string[][]): ParseResult {
    const errors: ParseError[] = []
    const orderMap = new Map<string, { order: NormalizedOrder; row: number }>()

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const rowNum = i + 2

      const orderId = getVal(row, headers, 'order id')
      if (!orderId) {
        errors.push({ row: rowNum, message: 'Missing Order ID' })
        continue
      }

      // Line item
      const productName = getVal(row, headers, 'product name')
      const variation = getVal(row, headers, 'variation')
      const skuId = getVal(row, headers, 'sku id') || getVal(row, headers, 'seller sku')
      const qty = parseInt(getVal(row, headers, 'quantity'), 10) || 1
      const unitPrice = parseFloat(getVal(row, headers, 'sku unit original price')) || 0
      const subtotalAfterDisc = parseFloat(getVal(row, headers, 'sku subtotal after discount')) || 0
      const discount = (unitPrice * qty) - subtotalAfterDisc

      const lineItem: NormalizedLineItem = {
        external_id: skuId || undefined,
        title: productName || 'Unknown Product',
        variant_title: variation || undefined,
        sku: skuId || undefined,
        quantity: qty,
        price: unitPrice,
        total_discount: discount > 0 ? discount : 0,
      }

      // Multi-row grouping
      const existing = orderMap.get(orderId)
      if (existing) {
        if (productName || skuId) existing.order.line_items.push(lineItem)
        continue
      }

      // Map TikTok order status
      const statusRaw = (getVal(row, headers, 'order status') || '').toLowerCase()
      let financialStatus: any = 'pending'
      let fulfillmentStatus: any = 'unfulfilled'

      if (statusRaw.includes('completed') || statusRaw.includes('delivered')) {
        financialStatus = 'paid'
        fulfillmentStatus = 'fulfilled'
      } else if (statusRaw.includes('shipped') || statusRaw.includes('in transit')) {
        financialStatus = 'paid'
        fulfillmentStatus = 'fulfilled'
      } else if (statusRaw.includes('unpaid') || statusRaw.includes('awaiting payment')) {
        financialStatus = 'pending'
      } else if (statusRaw.includes('cancelled') || statusRaw.includes('canceled')) {
        financialStatus = 'voided'
      } else if (statusRaw.includes('paid') || statusRaw.includes('awaiting shipment')) {
        financialStatus = 'paid'
      }

      // Address
      const recipientName = getVal(row, headers, 'recipient')
      const shippingAddr = {
        first_name: recipientName?.split(' ')[0] || undefined,
        last_name: recipientName?.split(' ').slice(1).join(' ') || undefined,
        address1: getVal(row, headers, 'detail address') || getVal(row, headers, 'street address') || undefined,
        city: getVal(row, headers, 'city') || undefined,
        province: getVal(row, headers, 'state') || getVal(row, headers, 'province') || undefined,
        zip: getVal(row, headers, 'zipcode') || getVal(row, headers, 'zip code') || undefined,
        country: getVal(row, headers, 'country') || getVal(row, headers, 'country/region') || undefined,
        phone: getVal(row, headers, 'phone') || getVal(row, headers, 'phone #') || undefined,
      }

      const shippingFee = parseFloat(getVal(row, headers, 'shipping fee after discount') || getVal(row, headers, 'shipping fee')) || 0
      const totalAmount = parseFloat(getVal(row, headers, 'total amount') || getVal(row, headers, 'order amount')) || 0

      const order: NormalizedOrder = {
        external_id: orderId,
        external_platform: 'tiktok',
        created_at: getVal(row, headers, 'created time') || getVal(row, headers, 'create time') || new Date().toISOString(),
        financial_status: financialStatus,
        fulfillment_status: fulfillmentStatus,
        currency: getVal(row, headers, 'currency') || 'USD',
        total_price: totalAmount || subtotalAfterDisc + shippingFee,
        total_shipping: shippingFee,
        total_discounts: discount > 0 ? discount : 0,
        email: getVal(row, headers, 'buyer email') || undefined,
        note: getVal(row, headers, 'buyer message') || undefined,
        shipping_address: shippingAddr.address1 ? shippingAddr : undefined,
        line_items: (productName || skuId) ? [lineItem] : [],
        payment_gateway: 'TikTok Shop',
        tracking_company: getVal(row, headers, 'shipping provider name') || getVal(row, headers, 'shipping provider') || undefined,
        tracking_number: getVal(row, headers, 'tracking id') || getVal(row, headers, 'tracking number') || undefined,
      }

      orderMap.set(orderId, { order, row: rowNum })
    }

    // Recalculate totals for multi-item orders
    for (const { order } of orderMap.values()) {
      if (order.line_items.length > 1) {
        const itemsTotal = order.line_items.reduce((sum, li) =>
          sum + Number(li.price) * li.quantity - Number(li.total_discount || 0), 0)
        order.subtotal_price = itemsTotal
        if (!order.total_price) {
          order.total_price = itemsTotal + Number(order.total_shipping || 0)
        }
      }
    }

    return {
      orders: Array.from(orderMap.values()).map(v => v.order),
      errors,
      totalRows: rows.length,
      platform: 'tiktok',
    }
  },
}
