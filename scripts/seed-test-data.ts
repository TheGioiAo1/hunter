/**
 * Gbox Platform — Test Data Seed Script
 *
 * Populates the database with realistic test data for API testing.
 * Uses existing shops and users — does not create new ones.
 *
 * Usage:  npx tsx scripts/seed-test-data.ts
 */

import 'dotenv/config'
import { createDb, destroyDb } from '@gbox/db'
import crypto from 'crypto'

const db = createDb()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID()
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomPrice(min: number, max: number): string {
  return (Math.random() * (max - min) + min).toFixed(2)
}

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// Product definitions
// ---------------------------------------------------------------------------

const PRODUCT_DEFS = [
  {
    title: 'Classic Cotton T-Shirt',
    slug: 'classic-cotton-tshirt',
    body_html: '<p>Soft, breathable 100% cotton t-shirt in a timeless cut.</p>',
    vendor: 'Gbox Basics',
    product_type: 'T-Shirts',
    tags: ['clothing', 'basics', 'cotton'],
    variants: [
      { title: 'Small', option1: 'S', price: '24.99', sku: 'CCT-S', barcode: '8901234560011' },
      { title: 'Medium', option1: 'M', price: '24.99', sku: 'CCT-M', barcode: '8901234560012' },
      { title: 'Large', option1: 'L', price: '24.99', sku: 'CCT-L', barcode: '8901234560013' },
      { title: 'XL', option1: 'XL', price: '24.99', sku: 'CCT-XL', barcode: '8901234560014' },
    ],
  },
  {
    title: 'Premium Denim Jeans',
    slug: 'premium-denim-jeans',
    body_html: '<p>Heavyweight selvedge denim with a modern straight fit.</p>',
    vendor: 'Gbox Denim',
    product_type: 'Jeans',
    tags: ['clothing', 'denim', 'premium'],
    variants: [
      { title: 'Waist 30', option1: '30', price: '79.99', sku: 'PDJ-30', barcode: '8901234560021' },
      { title: 'Waist 32', option1: '32', price: '79.99', sku: 'PDJ-32', barcode: '8901234560022' },
      { title: 'Waist 34', option1: '34', price: '79.99', sku: 'PDJ-34', barcode: '8901234560023' },
      { title: 'Waist 36', option1: '36', price: '79.99', sku: 'PDJ-36', barcode: '8901234560024' },
    ],
  },
  {
    title: 'Wireless Bluetooth Earbuds',
    slug: 'wireless-bluetooth-earbuds',
    body_html: '<p>Active noise-cancelling earbuds with 8-hour battery life.</p>',
    vendor: 'Gbox Audio',
    product_type: 'Electronics',
    tags: ['electronics', 'audio', 'wireless'],
    variants: [
      { title: 'Black', option1: 'Black', price: '49.99', sku: 'WBE-BLK', barcode: '8901234560031' },
      { title: 'White', option1: 'White', price: '49.99', sku: 'WBE-WHT', barcode: '8901234560032' },
    ],
  },
  {
    title: 'Organic Coffee Beans 1kg',
    slug: 'organic-coffee-beans-1kg',
    body_html: '<p>Single-origin medium-roast Arabica from Colombia.</p>',
    vendor: 'Gbox Coffee',
    product_type: 'Food',
    tags: ['food', 'coffee', 'organic'],
    variants: [
      { title: 'Default', option1: null, price: '18.99', sku: 'OCB-1KG', barcode: '8901234560041' },
    ],
  },
  {
    title: 'Leather Crossbody Bag',
    slug: 'leather-crossbody-bag',
    body_html: '<p>Genuine full-grain leather crossbody with adjustable strap.</p>',
    vendor: 'Gbox Accessories',
    product_type: 'Bags',
    tags: ['bags', 'leather', 'accessories'],
    variants: [
      { title: 'Brown', option1: 'Brown', price: '89.99', sku: 'LCB-BRN', barcode: '8901234560051' },
      { title: 'Black', option1: 'Black', price: '89.99', sku: 'LCB-BLK', barcode: '8901234560052' },
    ],
  },
  {
    title: 'Smart Watch Pro',
    slug: 'smart-watch-pro',
    body_html: '<p>Health-tracking smartwatch with AMOLED display and 7-day battery.</p>',
    vendor: 'Gbox Tech',
    product_type: 'Electronics',
    tags: ['electronics', 'wearable', 'smartwatch'],
    variants: [
      { title: 'Default', option1: null, price: '199.99', sku: 'SWP-01', barcode: '8901234560061' },
    ],
  },
  {
    title: 'Bamboo Water Bottle',
    slug: 'bamboo-water-bottle',
    body_html: '<p>Eco-friendly insulated bottle with bamboo lid.</p>',
    vendor: 'Gbox Eco',
    product_type: 'Drinkware',
    tags: ['eco', 'drinkware', 'bamboo'],
    variants: [
      { title: '500ml', option1: '500ml', price: '15.99', sku: 'BWB-500', barcode: '8901234560071' },
      { title: '1L', option1: '1L', price: '19.99', sku: 'BWB-1L', barcode: '8901234560072' },
    ],
  },
  {
    title: 'Yoga Mat Premium',
    slug: 'yoga-mat-premium',
    body_html: '<p>Extra-thick 6mm non-slip yoga mat with carrying strap.</p>',
    vendor: 'Gbox Fitness',
    product_type: 'Fitness',
    tags: ['fitness', 'yoga', 'mat'],
    variants: [
      { title: 'Default', option1: null, price: '39.99', sku: 'YMP-01', barcode: '8901234560081' },
    ],
  },
  {
    title: 'Stainless Steel Tumbler',
    slug: 'stainless-steel-tumbler',
    body_html: '<p>Double-walled vacuum insulated 20oz tumbler.</p>',
    vendor: 'Gbox Eco',
    product_type: 'Drinkware',
    tags: ['eco', 'drinkware', 'steel'],
    variants: [
      { title: 'Default', option1: null, price: '22.99', sku: 'SST-01', barcode: '8901234560091' },
    ],
  },
  {
    title: 'LED Desk Lamp',
    slug: 'led-desk-lamp',
    body_html: '<p>Adjustable LED desk lamp with 5 brightness levels and USB charging port.</p>',
    vendor: 'Gbox Home',
    product_type: 'Lighting',
    tags: ['home', 'lighting', 'led'],
    variants: [
      { title: 'Default', option1: null, price: '34.99', sku: 'LDL-01', barcode: '8901234560101' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Customer definitions
// ---------------------------------------------------------------------------

const CUSTOMER_DEFS = [
  { first_name: 'Alice', last_name: 'Johnson', email: 'customer1@example.com', phone: '+1-555-2001' },
  { first_name: 'Brian', last_name: 'Lee', email: 'customer2@example.com', phone: '+1-555-2002' },
  { first_name: 'Chloe', last_name: 'Martinez', email: 'customer3@example.com', phone: '+1-555-2003' },
  { first_name: 'David', last_name: 'Nguyen', email: 'customer4@example.com', phone: '+1-555-2004' },
  { first_name: 'Emma', last_name: 'Patel', email: 'customer5@example.com', phone: '+1-555-2005' },
  { first_name: 'Frank', last_name: 'Wilson', email: 'customer6@example.com', phone: '+1-555-2006' },
  { first_name: 'Grace', last_name: 'Kim', email: 'customer7@example.com', phone: '+1-555-2007' },
  { first_name: 'Henry', last_name: 'Brown', email: 'customer8@example.com', phone: '+1-555-2008' },
  { first_name: 'Ivy', last_name: 'Taylor', email: 'customer9@example.com', phone: '+1-555-2009' },
  { first_name: 'Jack', last_name: 'Davis', email: 'customer10@example.com', phone: '+1-555-2010' },
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Gbox Platform — Test Data Seed ===\n')

  // -----------------------------------------------------------------------
  // 0. Query existing entities
  // -----------------------------------------------------------------------

  console.log('[0] Looking up existing shop & users...')

  const shop = await db
    .selectFrom('shops')
    .select(['id', 'name'])
    .where('slug', '=', 'gbox-demo')
    .executeTakeFirst()

  if (!shop) {
    console.error('ERROR: Shop "gbox-demo" not found. Run the base seed first.')
    process.exit(1)
  }
  console.log(`    Shop: ${shop.name} (${shop.id})`)

  const godAdmin = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', '=', 'buithai3107@gmail.com')
    .executeTakeFirst()

  if (!godAdmin) {
    console.error('ERROR: God Admin (buithai3107@gmail.com) not found.')
    process.exit(1)
  }
  console.log(`    God Admin: ${godAdmin.email} (${godAdmin.id})`)

  const seller = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', '=', 'thaibq@gbox.co')
    .executeTakeFirst()

  if (!seller) {
    console.error('ERROR: Seller (thaibq@gbox.co) not found.')
    process.exit(1)
  }
  console.log(`    Seller: ${seller.email} (${seller.id})`)

  const shopId = shop.id

  // -----------------------------------------------------------------------
  // 1. Products
  // -----------------------------------------------------------------------

  console.log('\n[1] Seeding products...')

  const existingProductCount = await db
    .selectFrom('products')
    .select(db.fn.count<number>('id').as('cnt'))
    .where('shop_id', '=', shopId)
    .executeTakeFirstOrThrow()

  let allVariantIds: { productTitle: string; variantId: string; price: string; sku: string; title: string }[] = []
  let allProductIds: string[] = []
  let productsCreated = 0
  let variantsCreated = 0

  if (Number(existingProductCount.cnt) >= 10) {
    console.log(`    Already ${existingProductCount.cnt} products — loading existing variants...`)
    const existingProducts = await db
      .selectFrom('products')
      .select(['id', 'title'])
      .where('shop_id', '=', shopId)
      .execute()
    allProductIds = existingProducts.map((p) => p.id)

    const existingVariants = await db
      .selectFrom('product_variants as pv')
      .innerJoin('products as p', 'p.id', 'pv.product_id')
      .select(['pv.id', 'pv.price', 'pv.sku', 'pv.title', 'p.title as productTitle'])
      .where('p.shop_id', '=', shopId)
      .execute()
    allVariantIds = existingVariants.map((v) => ({
      productTitle: v.productTitle,
      variantId: v.id,
      price: v.price as string,
      sku: v.sku ?? 'UNKNOWN',
      title: v.title,
    }))
  } else {
    const now = new Date().toISOString()

    for (const def of PRODUCT_DEFS) {
      // Check if product slug already exists for this shop
      const exists = await db
        .selectFrom('products')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('slug', '=', def.slug)
        .executeTakeFirst()

      if (exists) {
        console.log(`    Skipping "${def.title}" (slug exists)`)
        allProductIds.push(exists.id)
        // Load its variants
        const vars = await db
          .selectFrom('product_variants')
          .select(['id', 'price', 'sku', 'title'])
          .where('product_id', '=', exists.id)
          .execute()
        for (const v of vars) {
          allVariantIds.push({
            productTitle: def.title,
            variantId: v.id,
            price: v.price as string,
            sku: v.sku ?? 'UNKNOWN',
            title: v.title,
          })
        }
        continue
      }

      const productId = uuid()
      await db
        .insertInto('products')
        .values({
          id: productId,
          shop_id: shopId,
          title: def.title,
          slug: def.slug,
          body_html: def.body_html,
          vendor: def.vendor,
          product_type: def.product_type,
          status: 'active',
          tags: def.tags,
          published_at: now,
        })
        .execute()

      allProductIds.push(productId)
      productsCreated++

      for (let i = 0; i < def.variants.length; i++) {
        const vDef = def.variants[i]
        const variantId = uuid()
        await db
          .insertInto('product_variants')
          .values({
            id: variantId,
            product_id: productId,
            title: vDef.title,
            price: vDef.price,
            sku: vDef.sku,
            barcode: vDef.barcode,
            inventory_quantity: randomInt(0, 100),
            option1: vDef.option1,
            position: i + 1,
            requires_shipping: true,
            taxable: true,
          })
          .execute()

        allVariantIds.push({
          productTitle: def.title,
          variantId,
          price: vDef.price,
          sku: vDef.sku,
          title: vDef.title,
        })
        variantsCreated++
      }
    }
    console.log(`    Created ${productsCreated} products + ${variantsCreated} variants`)
  }

  // -----------------------------------------------------------------------
  // 2. Customers
  // -----------------------------------------------------------------------

  console.log('\n[2] Seeding customers...')

  const existingCustomerCount = await db
    .selectFrom('customers')
    .select(db.fn.count<number>('id').as('cnt'))
    .where('shop_id', '=', shopId)
    .executeTakeFirstOrThrow()

  let customerIds: string[] = []
  let customerEmails: string[] = []
  let customersCreated = 0

  if (Number(existingCustomerCount.cnt) >= 10) {
    console.log(`    Already ${existingCustomerCount.cnt} customers — loading existing...`)
    const existing = await db
      .selectFrom('customers')
      .select(['id', 'email'])
      .where('shop_id', '=', shopId)
      .execute()
    customerIds = existing.map((c) => c.id)
    customerEmails = existing.map((c) => c.email ?? 'unknown@example.com')
  } else {
    for (const def of CUSTOMER_DEFS) {
      // Check if email already exists for this shop
      const exists = await db
        .selectFrom('customers')
        .select('id')
        .where('shop_id', '=', shopId)
        .where('email', '=', def.email)
        .executeTakeFirst()

      if (exists) {
        customerIds.push(exists.id)
        customerEmails.push(def.email)
        continue
      }

      const customerId = uuid()
      await db
        .insertInto('customers')
        .values({
          id: customerId,
          shop_id: shopId,
          email: def.email,
          first_name: def.first_name,
          last_name: def.last_name,
          phone: def.phone,
          orders_count: 0,
          total_spent: '0',
          status: 'active',
          verified_email: true,
          accepts_marketing: Math.random() > 0.5,
        })
        .execute()

      customerIds.push(customerId)
      customerEmails.push(def.email)
      customersCreated++
    }
    console.log(`    Created ${customersCreated} customers (${customerIds.length} total)`)
  }

  // -----------------------------------------------------------------------
  // 3. Orders
  // -----------------------------------------------------------------------

  console.log('\n[3] Seeding 15 orders...')

  // Get current max order_number for this shop
  const maxOrderRow = await db
    .selectFrom('orders')
    .select(db.fn.max('order_number').as('max_num'))
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  let nextOrderNumber = Number(maxOrderRow?.max_num ?? 1000) + 1

  // Define the 15 order configurations
  const ORDER_CONFIGS: Array<{
    financial_status: string
    fulfillment_status: string
  }> = [
    // 5 paid + unfulfilled
    { financial_status: 'paid', fulfillment_status: 'unfulfilled' },
    { financial_status: 'paid', fulfillment_status: 'unfulfilled' },
    { financial_status: 'paid', fulfillment_status: 'unfulfilled' },
    { financial_status: 'paid', fulfillment_status: 'unfulfilled' },
    { financial_status: 'paid', fulfillment_status: 'unfulfilled' },
    // 3 paid + fulfilled
    { financial_status: 'paid', fulfillment_status: 'fulfilled' },
    { financial_status: 'paid', fulfillment_status: 'fulfilled' },
    { financial_status: 'paid', fulfillment_status: 'fulfilled' },
    // 2 pending + unfulfilled
    { financial_status: 'pending', fulfillment_status: 'unfulfilled' },
    { financial_status: 'pending', fulfillment_status: 'unfulfilled' },
    // 2 paid + partial
    { financial_status: 'paid', fulfillment_status: 'partial' },
    { financial_status: 'paid', fulfillment_status: 'partial' },
    // 1 refunded
    { financial_status: 'refunded', fulfillment_status: 'fulfilled' },
    // 2 partially_refunded
    { financial_status: 'partially_refunded', fulfillment_status: 'fulfilled' },
    { financial_status: 'partially_refunded', fulfillment_status: 'fulfilled' },
  ]

  interface CreatedOrder {
    id: string
    orderNumber: number
    financial_status: string
    fulfillment_status: string
    customerId: string
    customerEmail: string
    totalPrice: string
    lineItems: Array<{
      id: string
      variantId: string
      title: string
      variantTitle: string
      sku: string
      quantity: number
      price: string
    }>
  }

  const createdOrders: CreatedOrder[] = []

  for (let i = 0; i < ORDER_CONFIGS.length; i++) {
    const config = ORDER_CONFIGS[i]
    const orderId = uuid()
    const orderNumber = nextOrderNumber++
    const custIdx = randomInt(0, customerIds.length - 1)
    const customerId = customerIds[custIdx]
    const customerEmail = customerEmails[custIdx]

    // Generate 1-4 line items
    const lineItemCount = randomInt(1, 4)
    const lineItems: CreatedOrder['lineItems'] = []
    let subtotal = 0

    // Pick random variants (no duplicates per order)
    const usedVariants = new Set<number>()
    for (let li = 0; li < lineItemCount; li++) {
      let varIdx: number
      do {
        varIdx = randomInt(0, allVariantIds.length - 1)
      } while (usedVariants.has(varIdx) && usedVariants.size < allVariantIds.length)
      usedVariants.add(varIdx)

      const variant = allVariantIds[varIdx]
      const quantity = randomInt(1, 3)
      const price = variant.price
      subtotal += parseFloat(price) * quantity

      const lineItemId = uuid()
      lineItems.push({
        id: lineItemId,
        variantId: variant.variantId,
        title: variant.productTitle,
        variantTitle: variant.title,
        sku: variant.sku,
        quantity,
        price,
      })
    }

    const totalTax = parseFloat((subtotal * 0.09).toFixed(2))
    const totalShipping = subtotal >= 100 ? 0 : 5.99
    const totalPrice = parseFloat((subtotal + totalTax + totalShipping).toFixed(2))

    // Create order with a created_at in the past (spread over 30 days)
    const createdAt = daysAgo(randomInt(0, 30))

    await db
      .insertInto('orders')
      .values({
        id: orderId,
        shop_id: shopId,
        order_number: orderNumber,
        customer_id: customerId,
        email: customerEmail,
        financial_status: config.financial_status,
        fulfillment_status: config.fulfillment_status,
        currency: 'USD',
        subtotal_price: subtotal.toFixed(2),
        total_tax: totalTax.toFixed(2),
        total_shipping: totalShipping.toFixed(2),
        total_price: totalPrice.toFixed(2),
        total_discounts: '0.00',
        created_at: createdAt,
        shipping_address: JSON.stringify({
          first_name: CUSTOMER_DEFS[custIdx % CUSTOMER_DEFS.length].first_name,
          last_name: CUSTOMER_DEFS[custIdx % CUSTOMER_DEFS.length].last_name,
          address1: `${randomInt(100, 999)} Commerce St`,
          city: 'San Francisco',
          province: 'CA',
          country: 'US',
          zip: '94102',
        }),
      })
      .execute()

    // Create line items
    for (const li of lineItems) {
      const fulfillmentStatus =
        config.fulfillment_status === 'fulfilled' ? 'fulfilled' : 'unfulfilled'

      await db
        .insertInto('order_line_items')
        .values({
          id: li.id,
          order_id: orderId,
          variant_id: li.variantId,
          title: li.title,
          variant_title: li.variantTitle,
          sku: li.sku,
          quantity: li.quantity,
          price: li.price,
          fulfillment_status: fulfillmentStatus,
          requires_shipping: true,
          taxable: true,
        })
        .execute()
    }

    createdOrders.push({
      id: orderId,
      orderNumber,
      financial_status: config.financial_status,
      fulfillment_status: config.fulfillment_status,
      customerId,
      customerEmail,
      totalPrice: totalPrice.toFixed(2),
      lineItems,
    })
  }

  console.log(`    Created 15 orders (#${createdOrders[0].orderNumber} — #${createdOrders[createdOrders.length - 1].orderNumber})`)

  // -----------------------------------------------------------------------
  // 4. Transactions (1 per order)
  // -----------------------------------------------------------------------

  console.log('\n[4] Seeding transactions...')

  let txnCount = 0
  for (const order of createdOrders) {
    const isPaid = ['paid', 'refunded', 'partially_refunded'].includes(order.financial_status)
    const isPending = order.financial_status === 'pending'

    await db
      .insertInto('transactions')
      .values({
        id: uuid(),
        order_id: order.id,
        kind: 'sale',
        gateway: 'stripe',
        amount: order.totalPrice,
        currency: 'USD',
        status: isPaid ? 'success' : isPending ? 'pending' : 'success',
        gateway_transaction_id: `ch_test_${order.orderNumber}_${randomInt(1000, 9999)}`,
      })
      .execute()
    txnCount++
  }
  console.log(`    Created ${txnCount} transactions`)

  // -----------------------------------------------------------------------
  // 5. Fulfillments (for the 3 fulfilled orders, indices 5-7)
  // -----------------------------------------------------------------------

  console.log('\n[5] Seeding fulfillments...')

  const fulfilledOrders = createdOrders.filter(
    (o) => o.fulfillment_status === 'fulfilled' && o.financial_status === 'paid'
  )
  const carriers = ['USPS', 'FedEx', 'UPS']
  let fulfillmentCount = 0

  for (let i = 0; i < fulfilledOrders.length; i++) {
    const order = fulfilledOrders[i]
    const carrier = carriers[i % carriers.length]
    const trackingNumber = `TRACK-${randomInt(10000, 99999)}`
    const fulfillmentId = uuid()

    await db
      .insertInto('fulfillments')
      .values({
        id: fulfillmentId,
        order_id: order.id,
        status: 'success',
        tracking_company: carrier,
        tracking_number: trackingNumber,
        tracking_url: `https://track.example.com/${trackingNumber}`,
        shipped_at: daysAgo(randomInt(0, 5)),
      })
      .execute()

    // fulfillment_line_items
    for (const li of order.lineItems) {
      await db
        .insertInto('fulfillment_line_items')
        .values({
          fulfillment_id: fulfillmentId,
          line_item_id: li.id,
          quantity: li.quantity,
        })
        .execute()
    }
    fulfillmentCount++
  }

  // Also create partial fulfillments for "partial" orders
  const partialOrders = createdOrders.filter((o) => o.fulfillment_status === 'partial')
  for (const order of partialOrders) {
    if (order.lineItems.length < 1) continue
    const carrier = randomItem(carriers)
    const trackingNumber = `TRACK-${randomInt(10000, 99999)}`
    const fulfillmentId = uuid()

    await db
      .insertInto('fulfillments')
      .values({
        id: fulfillmentId,
        order_id: order.id,
        status: 'success',
        tracking_company: carrier,
        tracking_number: trackingNumber,
        tracking_url: `https://track.example.com/${trackingNumber}`,
        shipped_at: daysAgo(randomInt(0, 5)),
      })
      .execute()

    // Only fulfill the first line item
    const firstLi = order.lineItems[0]
    await db
      .insertInto('fulfillment_line_items')
      .values({
        fulfillment_id: fulfillmentId,
        line_item_id: firstLi.id,
        quantity: firstLi.quantity,
      })
      .execute()

    // Mark that first line item as fulfilled
    await db
      .updateTable('order_line_items')
      .set({ fulfillment_status: 'fulfilled' })
      .where('id', '=', firstLi.id)
      .execute()

    fulfillmentCount++
  }

  console.log(`    Created ${fulfillmentCount} fulfillments`)

  // -----------------------------------------------------------------------
  // 6. Refund Requests — NOTE: No refund_requests table in schema.
  //    Skipping this section. Refund requests would need a migration first.
  // -----------------------------------------------------------------------

  console.log('\n[6] Refund requests: SKIPPED (table does not exist in current schema)')

  // -----------------------------------------------------------------------
  // 7. Refunds (for the refunded + partially_refunded orders)
  // -----------------------------------------------------------------------

  console.log('\n[7] Seeding refunds...')

  const refundedOrders = createdOrders.filter(
    (o) => o.financial_status === 'refunded' || o.financial_status === 'partially_refunded'
  )

  let refundCount = 0
  for (const order of refundedOrders) {
    const refundId = uuid()
    const isFullRefund = order.financial_status === 'refunded'

    // Refund the first line item (or all for full refund)
    const itemsToRefund = isFullRefund ? order.lineItems : [order.lineItems[0]]
    let refundTotal = 0

    await db
      .insertInto('refunds')
      .values({
        id: refundId,
        order_id: order.id,
        note: isFullRefund ? 'Full refund — customer dissatisfied' : 'Partial refund — item damaged',
        restock: true,
      })
      .execute()

    for (const li of itemsToRefund) {
      const lineSubtotal = parseFloat(li.price) * li.quantity
      refundTotal += lineSubtotal

      await db
        .insertInto('refund_line_items')
        .values({
          id: uuid(),
          refund_id: refundId,
          line_item_id: li.id,
          quantity: li.quantity,
          restock_type: 'return',
          subtotal: lineSubtotal.toFixed(2),
          total_tax: (lineSubtotal * 0.09).toFixed(2),
        })
        .execute()
    }

    // Create refund transaction
    await db
      .insertInto('transactions')
      .values({
        id: uuid(),
        order_id: order.id,
        kind: 'refund',
        gateway: 'stripe',
        amount: refundTotal.toFixed(2),
        currency: 'USD',
        status: 'success',
        gateway_transaction_id: `re_test_${order.orderNumber}_${randomInt(1000, 9999)}`,
      })
      .execute()

    refundCount++
  }

  console.log(`    Created ${refundCount} refunds with line items + transactions`)

  // -----------------------------------------------------------------------
  // 8. Notifications
  // -----------------------------------------------------------------------

  console.log('\n[8] Seeding notifications...')

  const NOTIFICATION_DEFS = [
    { type: 'order_new', title: 'New order received', message: `Order #${createdOrders[0].orderNumber} from ${createdOrders[0].customerEmail} — $${createdOrders[0].totalPrice}`, read: false, resource_type: 'order', resource_id: createdOrders[0].id },
    { type: 'order_new', title: 'New order received', message: `Order #${createdOrders[1].orderNumber} from ${createdOrders[1].customerEmail} — $${createdOrders[1].totalPrice}`, read: false, resource_type: 'order', resource_id: createdOrders[1].id },
    { type: 'order_new', title: 'New order received', message: `Order #${createdOrders[2].orderNumber} from ${createdOrders[2].customerEmail} — $${createdOrders[2].totalPrice}`, read: true, resource_type: 'order', resource_id: createdOrders[2].id },
    { type: 'fulfillment_shipped', title: 'Order shipped', message: `Order #${createdOrders[5].orderNumber} has been shipped via ${carriers[0]}`, read: true, resource_type: 'order', resource_id: createdOrders[5].id },
    { type: 'fulfillment_shipped', title: 'Order shipped', message: `Order #${createdOrders[6].orderNumber} has been shipped via ${carriers[1]}`, read: true, resource_type: 'order', resource_id: createdOrders[6].id },
    { type: 'refund_approved', title: 'Refund processed', message: `Refund for order #${createdOrders[12].orderNumber} has been processed`, read: true, resource_type: 'order', resource_id: createdOrders[12].id },
    { type: 'refund_approved', title: 'Partial refund processed', message: `Partial refund for order #${createdOrders[13].orderNumber} has been processed`, read: false, resource_type: 'order', resource_id: createdOrders[13].id },
    { type: 'system_alert', title: 'Low inventory alert', message: 'Multiple products are running low on stock. Please review your inventory.', read: false, resource_type: null, resource_id: null },
    { type: 'system_alert', title: 'Weekly sales summary', message: 'You had 15 orders this week totaling $1,247.50. Great job!', read: false, resource_type: null, resource_id: null },
    { type: 'order_new', title: 'New order received', message: `Order #${createdOrders[4].orderNumber} from ${createdOrders[4].customerEmail} — $${createdOrders[4].totalPrice}`, read: false, resource_type: 'order', resource_id: createdOrders[4].id },
  ]

  for (const n of NOTIFICATION_DEFS) {
    await db
      .insertInto('notifications')
      .values({
        id: uuid(),
        shop_id: shopId,
        user_id: godAdmin.id,
        type: n.type,
        title: n.title,
        message: n.message,
        read: n.read,
        resource_type: n.resource_type,
        resource_id: n.resource_id,
        created_at: daysAgo(randomInt(0, 14)),
      })
      .execute()
  }

  console.log(`    Created ${NOTIFICATION_DEFS.length} notifications`)

  // -----------------------------------------------------------------------
  // 9. Update customer stats
  // -----------------------------------------------------------------------

  console.log('\n[9] Updating customer order stats...')

  for (const custId of customerIds) {
    const stats = await db
      .selectFrom('orders')
      .select([
        db.fn.count<number>('id').as('order_count'),
        db.fn.sum<string>('total_price').as('total_spent'),
      ])
      .where('customer_id', '=', custId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()

    if (stats) {
      await db
        .updateTable('customers')
        .set({
          orders_count: Number(stats.order_count) || 0,
          total_spent: stats.total_spent ?? '0',
        })
        .where('id', '=', custId)
        .execute()
    }
  }

  console.log(`    Updated ${customerIds.length} customers`)

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  console.log('\n=========================================')
  console.log('  SEED COMPLETE — Summary')
  console.log('=========================================')
  console.log(`  Shop:           ${shop.name} (${shopId})`)
  console.log(`  Products:       ${productsCreated} created (${allProductIds.length} total, ${allVariantIds.length} variants)`)
  console.log(`  Customers:      ${customersCreated} created (${customerIds.length} total)`)
  console.log(`  Orders:         15 created (#${createdOrders[0].orderNumber}–#${createdOrders[14].orderNumber})`)
  console.log(`    - paid/unfulfilled:          5  (ready to fulfill)`)
  console.log(`    - paid/fulfilled:            3`)
  console.log(`    - pending/unfulfilled:       2`)
  console.log(`    - paid/partial:              2`)
  console.log(`    - refunded:                  1`)
  console.log(`    - partially_refunded:        2`)
  console.log(`  Transactions:   ${txnCount} sale + ${refundCount} refund`)
  console.log(`  Fulfillments:   ${fulfillmentCount}`)
  console.log(`  Refunds:        ${refundCount}`)
  console.log(`  Notifications:  ${NOTIFICATION_DEFS.length}`)
  console.log(`  Refund Requests: SKIPPED (no table in schema)`)
  console.log('=========================================\n')

  await destroyDb(db)
  console.log('Database connection closed. Done.')
}

main().catch(async (err) => {
  console.error('SEED ERROR:', err)
  await destroyDb(db).catch(() => {})
  process.exit(1)
})
