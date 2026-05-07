/**
 * Gbox Platform — Revenue Board Demo Seed
 *
 * Populates the database with a rich 90-day revenue dataset so the
 * God Admin `/god-admin/finance/revenue` board has meaningful charts,
 * by-store breakdowns, multi-country / multi-currency / multi-gateway
 * rows to explore.
 *
 * What it creates (idempotent — safe to re-run):
 *   - Up to 4 demo shops (gbox-demo is reused if present, the rest are
 *     created with slugs `gbox-eu`, `gbox-asia`, `gbox-latam`)
 *   - Per-shop: ~10 customers with varied names/countries
 *   - ~180 orders spread over 90 days (weighted toward recent weeks)
 *     across all 4 shops with mixed currencies, countries, and order
 *     sizes. ~10% are refunded/partially_refunded to exercise the
 *     refund-rate KPI.
 *   - 1 transaction per order, gateway drawn from {stripe, paypal,
 *     manual} weighted by shop region.
 *
 * Usage:
 *   From server 2 (the one that can reach Postgres):
 *     cd /opt/gbox-platform && npx tsx scripts/seed-revenue-demo.ts
 *
 * Requires gbox-demo shop + god admin user to already exist (same
 * prerequisite as scripts/seed-test-data.ts).
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

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Weighted random pick — items closer to the start of the array are
 * more likely. Used for gateway selection per shop so the breakdown
 * doesn't look uniform.
 */
function weighted<T>(pairs: readonly [T, number][]): T {
  const total = pairs.reduce((s, p) => s + p[1], 0)
  let r = Math.random() * total
  for (const [v, w] of pairs) {
    r -= w
    if (r <= 0) return v
  }
  return pairs[pairs.length - 1][0]
}

/** Days-ago timestamp with sub-day jitter so charts aren't stepped. */
function daysAgoIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(randomInt(0, 23), randomInt(0, 59), randomInt(0, 59), 0)
  return d.toISOString()
}

/**
 * Pick a random day within the last `maxDays`, biased toward the
 * recent end so the time series looks like an organically growing
 * business rather than flat noise.
 */
function biasedRecentDay(maxDays: number): number {
  // `Math.random() ** 1.6` → density near 0 (i.e. today) is higher.
  return Math.floor(Math.pow(Math.random(), 1.6) * maxDays)
}

// ---------------------------------------------------------------------------
// Demo shop definitions
// ---------------------------------------------------------------------------

interface DemoShopDef {
  slug: string
  name: string
  email: string
  currency: string
  country: string
  /** Gateway weights: higher = more common for this region. */
  gatewayWeights: readonly [string, number][]
  /** Country mix for customer shipping addresses. */
  countries: readonly { code: string; name: string; city: string; zip: string }[]
}

const SHOP_DEFS: DemoShopDef[] = [
  {
    slug: 'gbox-demo',
    name: 'Gbox Demo Store',
    email: 'demo@gbox.co',
    currency: 'USD',
    country: 'US',
    gatewayWeights: [['stripe', 7], ['paypal', 2], ['manual', 1]],
    countries: [
      { code: 'US', name: 'United States', city: 'San Francisco', zip: '94102' },
      { code: 'US', name: 'United States', city: 'New York', zip: '10001' },
      { code: 'CA', name: 'Canada', city: 'Toronto', zip: 'M5V2T6' },
    ],
  },
  {
    slug: 'gbox-eu',
    name: 'Gbox Europe',
    email: 'eu@gbox.co',
    currency: 'EUR',
    country: 'DE',
    gatewayWeights: [['stripe', 6], ['paypal', 4]],
    countries: [
      { code: 'DE', name: 'Germany', city: 'Berlin', zip: '10115' },
      { code: 'FR', name: 'France', city: 'Paris', zip: '75001' },
      { code: 'NL', name: 'Netherlands', city: 'Amsterdam', zip: '1011' },
      { code: 'ES', name: 'Spain', city: 'Madrid', zip: '28001' },
    ],
  },
  {
    slug: 'gbox-asia',
    name: 'Gbox Asia',
    email: 'asia@gbox.co',
    currency: 'SGD',
    country: 'SG',
    gatewayWeights: [['stripe', 5], ['paypal', 2], ['manual', 3]],
    countries: [
      { code: 'SG', name: 'Singapore', city: 'Singapore', zip: '018956' },
      { code: 'VN', name: 'Vietnam', city: 'Ho Chi Minh City', zip: '700000' },
      { code: 'JP', name: 'Japan', city: 'Tokyo', zip: '100-0001' },
      { code: 'AU', name: 'Australia', city: 'Sydney', zip: '2000' },
    ],
  },
  {
    slug: 'gbox-latam',
    name: 'Gbox LATAM',
    email: 'latam@gbox.co',
    currency: 'BRL',
    country: 'BR',
    gatewayWeights: [['stripe', 4], ['manual', 5], ['paypal', 1]],
    countries: [
      { code: 'BR', name: 'Brazil', city: 'Sao Paulo', zip: '01000-000' },
      { code: 'MX', name: 'Mexico', city: 'Mexico City', zip: '01000' },
      { code: 'AR', name: 'Argentina', city: 'Buenos Aires', zip: 'C1001' },
    ],
  },
]

const FIRST_NAMES = [
  'Alice', 'Bob', 'Charlie', 'Diana', 'Ethan', 'Fiona', 'George', 'Henry',
  'Ivy', 'Jack', 'Kira', 'Liam', 'Maya', 'Noah', 'Olivia', 'Pedro',
  'Quinn', 'Ravi', 'Sofia', 'Tomas',
]
const LAST_NAMES = [
  'Andersson', 'Brown', 'Chen', 'Dubois', 'Evans', 'Fernandez', 'Gupta',
  'Hansen', 'Ito', 'Johnson', 'Khan', 'Lopez', 'Mueller', 'Nakamura',
  'Oliveira', 'Park', 'Quispe', 'Rossi', 'Silva', 'Tanaka',
]

/** Canonical basket sizes (in the shop's own currency). */
const BASKET_PROFILES = [
  { weight: 4, min: 20, max: 60 },   // cheap impulse buys
  { weight: 6, min: 60, max: 180 },  // average basket
  { weight: 3, min: 180, max: 400 }, // larger orders
  { weight: 1, min: 400, max: 900 }, // rare whale orders
]

function pickBasketTotal(): number {
  const profile = weighted<typeof BASKET_PROFILES[number]>(
    BASKET_PROFILES.map((p) => [p, p.weight] as const),
  )
  return randomInt(profile.min, profile.max)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Gbox Platform — Revenue Board Demo Seed ===\n')

  // 0. Resolve or create shops
  console.log('[0] Resolving demo shops...')
  interface ResolvedShop {
    def: DemoShopDef
    id: string
  }
  const shops: ResolvedShop[] = []

  for (const def of SHOP_DEFS) {
    const existing = await db
      .selectFrom('shops')
      .select(['id', 'name'])
      .where('slug', '=', def.slug)
      .executeTakeFirst()

    if (existing) {
      console.log(`    [=] ${def.slug} → ${existing.id}`)
      shops.push({ def, id: existing.id })
      continue
    }

    // Create a new shop. Only the primary demo (gbox-demo) is
    // expected to already exist; the rest are opt-in for this seed.
    const id = uuid()
    await db
      .insertInto('shops')
      .values({
        id,
        name: def.name,
        slug: def.slug,
        domain: `${def.slug}.gbox.co`,
        email: def.email,
        country: def.country,
        currency: def.currency,
        status: 'active',
      })
      .execute()
    console.log(`    [+] created ${def.slug} → ${id}`)
    shops.push({ def, id })
  }

  // 1. Customers per shop (10 each, idempotent by email)
  console.log('\n[1] Seeding customers per shop...')
  interface ShopCustomer {
    id: string
    email: string
    firstName: string
    lastName: string
    country: { code: string; name: string; city: string; zip: string }
  }
  const customersByShop: Record<string, ShopCustomer[]> = {}

  for (const shop of shops) {
    const list: ShopCustomer[] = []
    for (let i = 0; i < 10; i++) {
      const firstName = pick(FIRST_NAMES)
      const lastName = pick(LAST_NAMES)
      const email = `demo+${shop.def.slug}-${i + 1}@gbox.dev`
      const country = shop.def.countries[i % shop.def.countries.length]

      const existing = await db
        .selectFrom('customers')
        .select('id')
        .where('shop_id', '=', shop.id)
        .where('email', '=', email)
        .executeTakeFirst()

      let id: string
      if (existing) {
        id = existing.id
      } else {
        id = uuid()
        await db
          .insertInto('customers')
          .values({
            id,
            shop_id: shop.id,
            email,
            first_name: firstName,
            last_name: lastName,
            status: 'active',
          })
          .execute()
      }
      list.push({ id, email, firstName, lastName, country })
    }
    customersByShop[shop.id] = list
    console.log(`    ${shop.def.slug}: ${list.length} customers ready`)
  }

  // 2. Orders — spread over 90 days, weighted toward recent
  console.log('\n[2] Seeding orders (90 days, multi-shop)...')
  const ORDERS_PER_SHOP = 45
  const WINDOW_DAYS = 90

  // Per-shop order number counter so we don't collide with any
  // existing orders. Start from max+1.
  const nextOrderNumberByShop: Record<string, number> = {}
  for (const shop of shops) {
    const row = await db
      .selectFrom('orders')
      .select(db.fn.max<number>('order_number').as('max'))
      .where('shop_id', '=', shop.id)
      .executeTakeFirst()
    nextOrderNumberByShop[shop.id] = (row?.max ?? 1000) + 1
  }

  let totalOrders = 0
  let totalTxns = 0

  for (const shop of shops) {
    const custList = customersByShop[shop.id]
    let shopOrders = 0

    for (let i = 0; i < ORDERS_PER_SHOP; i++) {
      const cust = pick(custList)
      const orderId = uuid()
      const orderNumber = nextOrderNumberByShop[shop.id]++

      const dayOffset = biasedRecentDay(WINDOW_DAYS)
      const createdAt = daysAgoIso(dayOffset)

      const basket = pickBasketTotal()
      const subtotal = basket
      const totalTax = +(subtotal * 0.09).toFixed(2)
      const totalShipping = subtotal >= 150 ? 0 : +(Math.random() * 12 + 4).toFixed(2)
      const totalPrice = +(subtotal + totalTax + totalShipping).toFixed(2)

      // Financial status distribution:
      //   ~80% paid, ~6% refunded, ~6% partially_refunded,
      //   ~5% pending, ~3% voided. Refund rate lands near 12% which
      //   gives the KPI something real to show.
      const r = Math.random()
      let financialStatus: string
      if (r < 0.80) financialStatus = 'paid'
      else if (r < 0.86) financialStatus = 'refunded'
      else if (r < 0.92) financialStatus = 'partially_refunded'
      else if (r < 0.97) financialStatus = 'pending'
      else financialStatus = 'voided'

      const fulfillmentStatus =
        financialStatus === 'paid' && Math.random() < 0.7
          ? 'fulfilled'
          : financialStatus === 'partially_refunded'
            ? 'fulfilled'
            : 'unfulfilled'

      await db
        .insertInto('orders')
        .values({
          id: orderId,
          shop_id: shop.id,
          order_number: orderNumber,
          customer_id: cust.id,
          email: cust.email,
          financial_status: financialStatus,
          fulfillment_status: fulfillmentStatus,
          currency: shop.def.currency,
          subtotal_price: subtotal.toFixed(2),
          total_tax: totalTax.toFixed(2),
          total_shipping: totalShipping.toFixed(2),
          total_price: totalPrice.toFixed(2),
          total_discounts: '0.00',
          created_at: createdAt,
          shipping_address: JSON.stringify({
            first_name: cust.firstName,
            last_name: cust.lastName,
            address1: `${randomInt(100, 999)} Market Street`,
            city: cust.country.city,
            country: cust.country.code,
            country_code: cust.country.code,
            zip: cust.country.zip,
          }),
          billing_address: JSON.stringify({
            first_name: cust.firstName,
            last_name: cust.lastName,
            address1: `${randomInt(100, 999)} Market Street`,
            city: cust.country.city,
            country: cust.country.code,
            country_code: cust.country.code,
            zip: cust.country.zip,
          }),
        })
        .execute()

      // Transaction — gateway depends on shop region. For pending/
      // voided orders we still insert a row so the transactions table
      // reflects the full funnel, but mark the status accordingly.
      const gateway = weighted(shop.def.gatewayWeights)
      let txnStatus: string
      let txnKind: string
      if (financialStatus === 'paid' || financialStatus === 'refunded' || financialStatus === 'partially_refunded') {
        txnStatus = 'success'
        txnKind = 'sale'
      } else if (financialStatus === 'pending') {
        txnStatus = 'pending'
        txnKind = 'authorization'
      } else {
        txnStatus = 'failure'
        txnKind = 'void'
      }

      await db
        .insertInto('transactions')
        .values({
          id: uuid(),
          order_id: orderId,
          kind: txnKind,
          gateway,
          amount: totalPrice.toFixed(2),
          currency: shop.def.currency,
          status: txnStatus,
          gateway_transaction_id: `ch_demo_${shop.def.slug}_${orderNumber}_${randomInt(1000, 9999)}`,
          created_at: createdAt,
        })
        .execute()

      // For refunded / partially_refunded orders, add a refund txn too
      // so the transactions log drill-downs tell the story.
      if (financialStatus === 'refunded' || financialStatus === 'partially_refunded') {
        const refundAmount = financialStatus === 'refunded'
          ? totalPrice
          : +(totalPrice * (randomInt(20, 60) / 100)).toFixed(2)
        await db
          .insertInto('transactions')
          .values({
            id: uuid(),
            order_id: orderId,
            kind: 'refund',
            gateway,
            amount: refundAmount.toFixed(2),
            currency: shop.def.currency,
            status: 'success',
            gateway_transaction_id: `re_demo_${shop.def.slug}_${orderNumber}_${randomInt(1000, 9999)}`,
            // Refund happens 1-5 days after the order
            created_at: daysAgoIso(Math.max(0, dayOffset - randomInt(1, 5))),
          })
          .execute()
        totalTxns++
      }
      totalTxns++
      totalOrders++
      shopOrders++
    }
    console.log(`    ${shop.def.slug}: +${shopOrders} orders`)
  }

  // 3. Summary
  console.log('\n=== Seed Complete ===')
  console.log(`Shops:        ${shops.length}`)
  console.log(`Orders:       ${totalOrders} (window: ${WINDOW_DAYS} days)`)
  console.log(`Transactions: ${totalTxns}`)
  console.log('\nNext step: visit https://god-dev.gbox.co/god-admin/finance/revenue')
}

main()
  .catch((err) => {
    console.error('[Revenue Seed] FATAL:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await destroyDb(db)
  })
