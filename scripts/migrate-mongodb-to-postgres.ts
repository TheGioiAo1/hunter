/**
 * Gbox Platform — MongoDB to PostgreSQL Migration Script
 *
 * Migrates all data from the legacy MongoDB-based Gbox microservices
 * (Gbox-Users, Gbox-Shops, Gbox-Products, etc.) into the new
 * PostgreSQL schema managed by Kysely.
 *
 * Usage:
 *   npx tsx scripts/migrate-mongodb-to-postgres.ts
 *
 * Required environment variables:
 *   MONGODB_URI    — MongoDB connection string
 *   DATABASE_URL   — PostgreSQL connection string
 */

import 'dotenv/config'
import { MongoClient, type Db, type Collection, type Document } from 'mongodb'
import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from '../packages/db/src/schema/tables.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MONGODB_URI = process.env.MONGODB_URI
const DATABASE_URL = process.env.DATABASE_URL
const BATCH_SIZE = 1000

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI environment variable is not set')
  process.exit(1)
}
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Database connections
// ---------------------------------------------------------------------------

function createPostgres(): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 10,
  })
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  })
}

// ---------------------------------------------------------------------------
// Progress logging
// ---------------------------------------------------------------------------

function logProgress(step: string, current: number, total: number): void {
  const pct = total > 0 ? ((current / total) * 100).toFixed(1) : '100.0'
  process.stdout.write(`\r  [${step}] ${current}/${total} (${pct}%)`)
  if (current === total) {
    process.stdout.write('\n')
  }
}

function logStep(name: string): void {
  console.log(`\n--- ${name} ---`)
}

// ---------------------------------------------------------------------------
// Batch insert helper
// ---------------------------------------------------------------------------

async function batchInsert<T extends Record<string, unknown>>(
  db: Kysely<Database>,
  table: keyof Database & string,
  records: T[],
  step: string,
): Promise<number> {
  let inserted = 0
  const total = records.length

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)

    await db.transaction().execute(async (trx) => {
      await (trx.insertInto(table as any) as any)
        .values(batch)
        .onConflict((oc: any) => oc.doNothing())
        .execute()
    })

    inserted += batch.length
    logProgress(step, Math.min(inserted, total), total)
  }

  return inserted
}

// ---------------------------------------------------------------------------
// Migration steps
// ---------------------------------------------------------------------------

/**
 * Step 1: Migrate users from Gbox-Users
 */
async function migrateUsers(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<Map<string, string>> {
  logStep('1. Migrating users')
  const collection = mongoDB.collection('users')
  const docs = await collection.find({}).toArray()
  const idMap = new Map<string, string>()

  const records = docs.map((doc) => {
    const id = doc._id.toString()
    idMap.set(id, id)
    return {
      id,
      email: doc.email ?? `unknown_${id}@migration.local`,
      name: doc.name ?? doc.username ?? null,
      avatar_url: doc.avatar ?? doc.avatarUrl ?? null,
      role: doc.role ?? 'owner',
      status: doc.status ?? 'active',
      created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
      updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
    }
  })

  await batchInsert(pgDb, 'users', records, 'users')
  console.log(`  Processed ${records.length} users`)
  return idMap
}

/**
 * Step 2: Migrate shops from Gbox-Shops
 */
async function migrateShops(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<Map<string, string>> {
  logStep('2. Migrating shops')
  const collection = mongoDB.collection('shops')
  const docs = await collection.find({}).toArray()
  const idMap = new Map<string, string>()

  const records = docs.map((doc) => {
    const id = doc._id.toString()
    idMap.set(id, id)
    return {
      id,
      name: doc.name ?? 'Unnamed Shop',
      slug: doc.slug ?? doc.name?.toLowerCase().replace(/\s+/g, '-') ?? `shop-${id.slice(-8)}`,
      domain: doc.domain ?? null,
      custom_domain: doc.customDomain ?? null,
      email: doc.email ?? 'unknown@migration.local',
      phone: doc.phone ?? null,
      address: doc.address?.street ?? doc.address?.address1 ?? null,
      city: doc.address?.city ?? null,
      province: doc.address?.province ?? doc.address?.state ?? null,
      country: doc.address?.country ?? null,
      zip: doc.address?.zip ?? doc.address?.postalCode ?? null,
      currency: doc.currency ?? 'USD',
      timezone: doc.timezone ?? 'UTC',
      plan: doc.plan ?? null,
      status: doc.status ?? 'active',
      logo_url: doc.logo ?? doc.logoUrl ?? null,
      created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
      updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
    }
  })

  await batchInsert(pgDb, 'shops', records, 'shops')
  console.log(`  Processed ${records.length} shops`)
  return idMap
}

/**
 * Step 3: Migrate user-shop relationships from JWT claims / user docs
 */
async function migrateUserShops(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('3. Migrating user_shops')
  const collection = mongoDB.collection('users')
  const docs = await collection.find({}).toArray()

  const records: Array<Record<string, unknown>> = []
  for (const doc of docs) {
    const userId = doc._id.toString()
    const shops = doc.shops ?? doc.shopIds ?? []
    for (const shopRef of shops) {
      const shopId = typeof shopRef === 'object' ? shopRef._id?.toString() ?? shopRef.shopId?.toString() : shopRef.toString()
      records.push({
        user_id: userId,
        shop_id: shopId,
        role: doc.role ?? 'owner',
        permissions: null,
        created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
      })
    }
  }

  if (records.length > 0) {
    await batchInsert(pgDb, 'user_shops', records, 'user_shops')
  }
  console.log(`  Processed ${records.length} user_shop relations`)
}

/**
 * Step 4: Migrate products, variants, and images from Gbox-Products
 */
async function migrateProducts(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('4. Migrating products + variants + images')
  const collection = mongoDB.collection('products')
  const docs = await collection.find({}).toArray()
  const total = docs.length
  let processed = 0

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE)

    await pgDb.transaction().execute(async (trx) => {
      for (const doc of batch) {
        const productId = doc._id.toString()
        const shopId = doc.shopId?.toString() ?? doc.shop_id?.toString() ?? ''

        // Insert product
        await (trx.insertInto('products') as any)
          .values({
            id: productId,
            shop_id: shopId,
            title: doc.title ?? 'Untitled',
            slug: doc.slug ?? doc.handle ?? `product-${productId.slice(-8)}`,
            body_html: doc.bodyHtml ?? doc.body_html ?? doc.description ?? null,
            vendor: doc.vendor ?? null,
            product_type: doc.productType ?? doc.product_type ?? null,
            status: doc.status ?? 'active',
            tags: doc.tags ?? null,
            template_suffix: doc.templateSuffix ?? null,
            published_at: doc.publishedAt ? new Date(doc.publishedAt).toISOString() : null,
            created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
            updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
          })
          .onConflict((oc: any) => oc.doNothing())
          .execute()

        // Insert variants
        const variants = doc.variants ?? []
        for (let vi = 0; vi < variants.length; vi++) {
          const v = variants[vi]
          await (trx.insertInto('product_variants') as any)
            .values({
              id: v._id?.toString() ?? `${productId}_v${vi}`,
              product_id: productId,
              title: v.title ?? 'Default Title',
              price: String(v.price ?? '0'),
              compare_at_price: v.compareAtPrice != null ? String(v.compareAtPrice) : null,
              cost: v.cost != null ? String(v.cost) : null,
              sku: v.sku ?? null,
              barcode: v.barcode ?? null,
              inventory_quantity: v.inventoryQuantity ?? v.inventory_quantity ?? 0,
              weight: v.weight != null ? String(v.weight) : null,
              weight_unit: v.weightUnit ?? v.weight_unit ?? 'kg',
              option1: v.option1 ?? null,
              option2: v.option2 ?? null,
              option3: v.option3 ?? null,
              position: v.position ?? vi,
              image_url: v.imageUrl ?? v.image_url ?? null,
              requires_shipping: v.requiresShipping ?? true,
              taxable: v.taxable ?? true,
              created_at: v.createdAt ? new Date(v.createdAt).toISOString() : new Date().toISOString(),
              updated_at: v.updatedAt ? new Date(v.updatedAt).toISOString() : new Date().toISOString(),
            })
            .onConflict((oc: any) => oc.doNothing())
            .execute()
        }

        // Insert images
        const images = doc.images ?? []
        for (let ii = 0; ii < images.length; ii++) {
          const img = images[ii]
          await (trx.insertInto('product_images') as any)
            .values({
              id: img._id?.toString() ?? `${productId}_img${ii}`,
              product_id: productId,
              src: img.src ?? img.url ?? '',
              alt: img.alt ?? null,
              width: img.width ?? null,
              height: img.height ?? null,
              position: img.position ?? ii,
              created_at: img.createdAt ? new Date(img.createdAt).toISOString() : new Date().toISOString(),
            })
            .onConflict((oc: any) => oc.doNothing())
            .execute()
        }

        processed++
      }
    })

    logProgress('products', Math.min(processed, total), total)
  }

  console.log(`  Processed ${processed} products`)
}

/**
 * Step 5: Migrate categories to collections
 */
async function migrateCollections(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('5. Migrating categories -> collections')
  const collection = mongoDB.collection('categories')
  const docs = await collection.find({}).toArray()

  const records = docs.map((doc) => ({
    id: doc._id.toString(),
    shop_id: doc.shopId?.toString() ?? doc.shop_id?.toString() ?? '',
    title: doc.name ?? doc.title ?? 'Untitled',
    slug: doc.slug ?? doc.handle ?? `collection-${doc._id.toString().slice(-8)}`,
    body_html: doc.description ?? doc.bodyHtml ?? null,
    image_url: doc.image ?? doc.imageUrl ?? null,
    sort_order: doc.sortOrder ?? null,
    published: doc.published ?? doc.status === 'active' ?? false,
    rules: doc.rules ? JSON.stringify(doc.rules) : null,
    template_suffix: null,
    created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
  }))

  if (records.length > 0) {
    await batchInsert(pgDb, 'collections', records, 'collections')
  }
  console.log(`  Processed ${records.length} collections`)
}

/**
 * Step 6: Migrate customers and addresses from Gbox-Customers
 */
async function migrateCustomers(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('6. Migrating customers + addresses')
  const collection = mongoDB.collection('customers')
  const docs = await collection.find({}).toArray()
  const total = docs.length
  let processed = 0

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE)

    await pgDb.transaction().execute(async (trx) => {
      for (const doc of batch) {
        const customerId = doc._id.toString()
        const shopId = doc.shopId?.toString() ?? doc.shop_id?.toString() ?? ''

        await (trx.insertInto('customers') as any)
          .values({
            id: customerId,
            shop_id: shopId,
            email: doc.email ?? null,
            first_name: doc.firstName ?? doc.first_name ?? null,
            last_name: doc.lastName ?? doc.last_name ?? null,
            phone: doc.phone ?? null,
            accepts_marketing: doc.acceptsMarketing ?? doc.accepts_marketing ?? false,
            orders_count: doc.ordersCount ?? doc.orders_count ?? 0,
            total_spent: String(doc.totalSpent ?? doc.total_spent ?? '0'),
            tags: doc.tags ?? null,
            note: doc.note ?? null,
            tax_exempt: doc.taxExempt ?? doc.tax_exempt ?? false,
            verified_email: doc.verifiedEmail ?? doc.verified_email ?? false,
            status: doc.status ?? 'active',
            created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
            updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
          })
          .onConflict((oc: any) => oc.doNothing())
          .execute()

        // Addresses
        const addresses = doc.addresses ?? []
        for (let ai = 0; ai < addresses.length; ai++) {
          const addr = addresses[ai]
          await (trx.insertInto('customer_addresses') as any)
            .values({
              id: addr._id?.toString() ?? `${customerId}_addr${ai}`,
              customer_id: customerId,
              first_name: addr.firstName ?? addr.first_name ?? null,
              last_name: addr.lastName ?? addr.last_name ?? null,
              company: addr.company ?? null,
              address1: addr.address1 ?? addr.street ?? null,
              address2: addr.address2 ?? null,
              city: addr.city ?? null,
              province: addr.province ?? addr.state ?? null,
              province_code: addr.provinceCode ?? addr.province_code ?? null,
              country: addr.country ?? null,
              country_code: addr.countryCode ?? addr.country_code ?? null,
              zip: addr.zip ?? addr.postalCode ?? null,
              phone: addr.phone ?? null,
              is_default: addr.isDefault ?? addr.is_default ?? (ai === 0),
              created_at: addr.createdAt ? new Date(addr.createdAt).toISOString() : new Date().toISOString(),
            })
            .onConflict((oc: any) => oc.doNothing())
            .execute()
        }

        processed++
      }
    })

    logProgress('customers', Math.min(processed, total), total)
  }

  console.log(`  Processed ${processed} customers`)
}

/**
 * Step 7: Migrate orders, line items, and transactions from Gbox-Orders
 */
async function migrateOrders(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('7. Migrating orders + line_items + transactions')
  const collection = mongoDB.collection('orders')
  const docs = await collection.find({}).toArray()
  const total = docs.length
  let processed = 0

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE)

    await pgDb.transaction().execute(async (trx) => {
      for (const doc of batch) {
        const orderId = doc._id.toString()
        const shopId = doc.shopId?.toString() ?? doc.shop_id?.toString() ?? ''

        await (trx.insertInto('orders') as any)
          .values({
            id: orderId,
            shop_id: shopId,
            customer_id: doc.customerId?.toString() ?? doc.customer_id?.toString() ?? null,
            email: doc.email ?? null,
            phone: doc.phone ?? null,
            financial_status: doc.financialStatus ?? doc.financial_status ?? 'pending',
            fulfillment_status: doc.fulfillmentStatus ?? doc.fulfillment_status ?? 'unfulfilled',
            currency: doc.currency ?? 'USD',
            subtotal_price: String(doc.subtotalPrice ?? doc.subtotal_price ?? '0'),
            total_discounts: String(doc.totalDiscounts ?? doc.total_discounts ?? '0'),
            total_shipping: String(doc.totalShipping ?? doc.total_shipping ?? '0'),
            total_tax: String(doc.totalTax ?? doc.total_tax ?? '0'),
            total_price: String(doc.totalPrice ?? doc.total_price ?? '0'),
            total_weight: doc.totalWeight ?? doc.total_weight ?? null,
            note: doc.note ?? null,
            tags: doc.tags ?? null,
            cancel_reason: doc.cancelReason ?? doc.cancel_reason ?? null,
            cancelled_at: doc.cancelledAt ? new Date(doc.cancelledAt).toISOString() : null,
            closed_at: doc.closedAt ? new Date(doc.closedAt).toISOString() : null,
            billing_address: doc.billingAddress ?? doc.billing_address
              ? JSON.stringify(doc.billingAddress ?? doc.billing_address) : null,
            shipping_address: doc.shippingAddress ?? doc.shipping_address
              ? JSON.stringify(doc.shippingAddress ?? doc.shipping_address) : null,
            created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
            updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
          })
          .onConflict((oc: any) => oc.doNothing())
          .execute()

        // Line items
        const lineItems = doc.lineItems ?? doc.line_items ?? []
        for (let li = 0; li < lineItems.length; li++) {
          const item = lineItems[li]
          await (trx.insertInto('order_line_items') as any)
            .values({
              id: item._id?.toString() ?? `${orderId}_li${li}`,
              order_id: orderId,
              product_id: item.productId?.toString() ?? item.product_id?.toString() ?? null,
              variant_id: item.variantId?.toString() ?? item.variant_id?.toString() ?? null,
              title: item.title ?? item.name ?? 'Unknown',
              variant_title: item.variantTitle ?? item.variant_title ?? null,
              sku: item.sku ?? null,
              quantity: item.quantity ?? 1,
              price: String(item.price ?? '0'),
              total_discount: String(item.totalDiscount ?? item.total_discount ?? '0'),
              fulfillment_status: item.fulfillmentStatus ?? item.fulfillment_status ?? 'unfulfilled',
              requires_shipping: item.requiresShipping ?? item.requires_shipping ?? true,
              taxable: item.taxable ?? true,
              gift_card: item.giftCard ?? item.gift_card ?? false,
              properties: item.properties ? JSON.stringify(item.properties) : null,
              created_at: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
            })
            .onConflict((oc: any) => oc.doNothing())
            .execute()
        }

        // Transactions
        const transactions = doc.transactions ?? []
        for (let ti = 0; ti < transactions.length; ti++) {
          const t = transactions[ti]
          await (trx.insertInto('transactions') as any)
            .values({
              id: t._id?.toString() ?? `${orderId}_tx${ti}`,
              order_id: orderId,
              kind: t.kind ?? 'sale',
              gateway: t.gateway ?? 'manual',
              amount: String(t.amount ?? '0'),
              currency: t.currency ?? doc.currency ?? 'USD',
              status: t.status ?? 'success',
              authorization: t.authorization ?? null,
              gateway_transaction_id: t.gatewayTransactionId ?? t.gateway_transaction_id ?? null,
              error_code: t.errorCode ?? t.error_code ?? null,
              message: t.message ?? null,
              created_at: t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString(),
            })
            .onConflict((oc: any) => oc.doNothing())
            .execute()
        }

        processed++
      }
    })

    logProgress('orders', Math.min(processed, total), total)
  }

  console.log(`  Processed ${processed} orders`)
}

/**
 * Step 8: Migrate fulfillments from Gbox-Orders
 */
async function migrateFulfillments(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('8. Migrating fulfillments')
  const collection = mongoDB.collection('fulfillments')
  let docs: Document[] = []

  try {
    docs = await collection.find({}).toArray()
  } catch {
    // Fulfillments may be embedded in orders — try extracting from orders
    const ordersCollection = mongoDB.collection('orders')
    const orders = await ordersCollection.find({ fulfillments: { $exists: true, $ne: [] } }).toArray()
    for (const order of orders) {
      for (const f of (order.fulfillments ?? [])) {
        docs.push({ ...f, orderId: order._id.toString(), shopId: order.shopId ?? order.shop_id })
      }
    }
  }

  const records = docs.map((doc, i) => ({
    id: doc._id?.toString() ?? `ful_${i}_${Date.now()}`,
    order_id: doc.orderId?.toString() ?? doc.order_id?.toString() ?? '',
    location_id: doc.locationId?.toString() ?? doc.location_id?.toString() ?? null,
    status: doc.status ?? 'success',
    tracking_company: doc.trackingCompany ?? doc.tracking_company ?? null,
    tracking_number: doc.trackingNumber ?? doc.tracking_number ?? null,
    tracking_url: doc.trackingUrl ?? doc.tracking_url ?? null,
    shipped_at: doc.shippedAt ? new Date(doc.shippedAt).toISOString() : null,
    created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
  }))

  if (records.length > 0) {
    await batchInsert(pgDb, 'fulfillments', records, 'fulfillments')
  }
  console.log(`  Processed ${records.length} fulfillments`)
}

/**
 * Step 9: Migrate shipping zones and rates from Gbox-Shippings
 */
async function migrateShipping(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('9. Migrating shipping_zones + rates')
  const collection = mongoDB.collection('shippings')
  let docs: Document[] = []

  try {
    docs = await collection.find({}).toArray()
  } catch {
    // Try alternative collection name
    try {
      docs = await mongoDB.collection('shipping_zones').find({}).toArray()
    } catch {
      console.log('  No shipping collection found, skipping')
      return
    }
  }

  let zonesCount = 0
  let ratesCount = 0

  for (const doc of docs) {
    const zoneId = doc._id.toString()
    const shopId = doc.shopId?.toString() ?? doc.shop_id?.toString() ?? ''

    const countries = doc.countries ?? doc.zones ?? []

    await pgDb
      .insertInto('shipping_zones')
      .values({
        id: zoneId,
        shop_id: shopId,
        name: doc.name ?? 'Default Zone',
        countries: JSON.stringify(countries),
        created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
        updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
      } as any)
      .onConflict((oc) => oc.doNothing())
      .execute()
    zonesCount++

    // Rates within the zone
    const rates = doc.rates ?? doc.shippingRates ?? []
    for (let ri = 0; ri < rates.length; ri++) {
      const rate = rates[ri]
      await pgDb
        .insertInto('shipping_rates')
        .values({
          id: rate._id?.toString() ?? `${zoneId}_rate${ri}`,
          zone_id: zoneId,
          name: rate.name ?? 'Standard',
          price: String(rate.price ?? '0'),
          type: rate.type ?? 'flat',
          min_value: rate.minValue != null ? String(rate.minValue) : null,
          max_value: rate.maxValue != null ? String(rate.maxValue) : null,
          created_at: rate.createdAt ? new Date(rate.createdAt).toISOString() : new Date().toISOString(),
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
      ratesCount++
    }
  }

  console.log(`  Processed ${zonesCount} zones, ${ratesCount} rates`)
}

/**
 * Step 10: Migrate pages from Gbox-Pages
 */
async function migratePages(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('10. Migrating pages')
  const collection = mongoDB.collection('pages')
  let docs: Document[] = []

  try {
    docs = await collection.find({}).toArray()
  } catch {
    console.log('  No pages collection found, skipping')
    return
  }

  const records = docs.map((doc) => ({
    id: doc._id.toString(),
    shop_id: doc.shopId?.toString() ?? doc.shop_id?.toString() ?? '',
    title: doc.title ?? 'Untitled',
    slug: doc.slug ?? doc.handle ?? `page-${doc._id.toString().slice(-8)}`,
    body_html: doc.bodyHtml ?? doc.body_html ?? doc.content ?? null,
    author: doc.author ?? null,
    template_suffix: doc.templateSuffix ?? null,
    published: doc.published ?? doc.status === 'published' ?? false,
    created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
  }))

  if (records.length > 0) {
    await batchInsert(pgDb, 'pages', records, 'pages')
  }
  console.log(`  Processed ${records.length} pages`)
}

/**
 * Step 11: Migrate email templates from Gbox-Emails
 */
async function migrateEmailTemplates(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('11. Migrating email_templates')
  const collection = mongoDB.collection('emails')
  let docs: Document[] = []

  try {
    docs = await collection.find({}).toArray()
  } catch {
    try {
      docs = await mongoDB.collection('email_templates').find({}).toArray()
    } catch {
      console.log('  No email templates collection found, skipping')
      return
    }
  }

  const records = docs.map((doc) => ({
    id: doc._id.toString(),
    shop_id: doc.shopId?.toString() ?? doc.shop_id?.toString() ?? '',
    name: doc.name ?? doc.type ?? 'unknown',
    subject: doc.subject ?? '',
    body_html: doc.bodyHtml ?? doc.body_html ?? doc.body ?? doc.content ?? null,
    active: doc.active ?? true,
    created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
    updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
  }))

  if (records.length > 0) {
    await batchInsert(pgDb, 'email_templates', records, 'email_templates')
  }
  console.log(`  Processed ${records.length} email templates`)
}

/**
 * Step 12: Migrate menus from Gbox-Shop/menus
 */
async function migrateMenus(
  mongoDB: Db,
  pgDb: Kysely<Database>,
): Promise<void> {
  logStep('12. Migrating menus')
  const collection = mongoDB.collection('menus')
  let docs: Document[] = []

  try {
    docs = await collection.find({}).toArray()
  } catch {
    console.log('  No menus collection found, skipping')
    return
  }

  let menusCount = 0
  let itemsCount = 0

  for (const doc of docs) {
    const menuId = doc._id.toString()
    const shopId = doc.shopId?.toString() ?? doc.shop_id?.toString() ?? ''

    await pgDb
      .insertInto('menus')
      .values({
        id: menuId,
        shop_id: shopId,
        title: doc.title ?? doc.name ?? 'Main Menu',
        slug: doc.slug ?? doc.handle ?? `menu-${menuId.slice(-8)}`,
        created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
        updated_at: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : new Date().toISOString(),
      } as any)
      .onConflict((oc) => oc.doNothing())
      .execute()
    menusCount++

    // Menu items
    const items = doc.items ?? doc.links ?? []
    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii]
      await pgDb
        .insertInto('menu_items')
        .values({
          id: item._id?.toString() ?? `${menuId}_item${ii}`,
          menu_id: menuId,
          parent_id: item.parentId?.toString() ?? item.parent_id?.toString() ?? null,
          title: item.title ?? item.name ?? item.label ?? 'Untitled',
          url: item.url ?? item.href ?? null,
          resource_type: item.resourceType ?? item.resource_type ?? null,
          resource_id: item.resourceId?.toString() ?? item.resource_id?.toString() ?? null,
          position: item.position ?? ii,
          created_at: item.createdAt ? new Date(item.createdAt).toISOString() : new Date().toISOString(),
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
      itemsCount++
    }
  }

  console.log(`  Processed ${menusCount} menus, ${itemsCount} menu items`)
}

// ---------------------------------------------------------------------------
// Main migration runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Gbox Platform: MongoDB -> PostgreSQL Migration ===')
  console.log(`MongoDB: ${MONGODB_URI!.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')}`)
  console.log(`PostgreSQL: ${DATABASE_URL!.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')}`)
  console.log('')

  const mongoClient = new MongoClient(MONGODB_URI!)
  const pgDb = createPostgres()

  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...')
    await mongoClient.connect()
    const mongoDB = mongoClient.db()
    console.log('Connected to MongoDB')

    // Verify PostgreSQL connection
    console.log('Verifying PostgreSQL connection...')
    await sql`SELECT 1`.execute(pgDb)
    console.log('Connected to PostgreSQL')

    const startTime = Date.now()

    // Run migration steps in order (respecting FK dependencies)
    const userIdMap = await migrateUsers(mongoDB, pgDb)
    const shopIdMap = await migrateShops(mongoDB, pgDb)
    await migrateUserShops(mongoDB, pgDb)
    await migrateProducts(mongoDB, pgDb)
    await migrateCollections(mongoDB, pgDb)
    await migrateCustomers(mongoDB, pgDb)
    await migrateOrders(mongoDB, pgDb)
    await migrateFulfillments(mongoDB, pgDb)
    await migrateShipping(mongoDB, pgDb)
    await migratePages(mongoDB, pgDb)
    await migrateEmailTemplates(mongoDB, pgDb)
    await migrateMenus(mongoDB, pgDb)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`\n=== Migration complete in ${elapsed}s ===`)
  } catch (err) {
    console.error('\nMigration failed:', err)
    process.exit(1)
  } finally {
    await mongoClient.close()
    await pgDb.destroy()
  }
}

main()
