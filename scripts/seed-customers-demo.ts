/**
 * Gbox Platform — Customers Board Demo Seed
 *
 * Enriches the customer dataset so the `/god-admin/customers` board
 * has something interesting to show:
 *
 *   1. Ensures every demo shop has at least ~15 customers (adds more
 *      shoppers on top of whatever the revenue seed already created)
 *   2. Backfills phone number, accepts_marketing, tags, last_login_at
 *      and a `note` column on a subset so the detail page has content
 *   3. Ensures each customer has at least one saved address in
 *      `customer_addresses` so the detail-page Addresses card
 *      renders more than "no saved addresses"
 *   4. Recomputes `orders_count` and `total_spent` denormalized
 *      columns from the real `orders` table so the list-page KPIs
 *      match the actual data on both this page and revenue.ts
 *
 * Idempotent — safe to re-run. Every mutation is either an UPDATE
 * against an existing row or a guarded INSERT that checks for a
 * duplicate first.
 *
 * Usage:
 *   cd ~/gbox-platform && npx tsx scripts/seed-customers-demo.ts
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

function daysAgoIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(randomInt(0, 23), randomInt(0, 59), randomInt(0, 59), 0)
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// Sample data pools
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Alice', 'Bob', 'Charlie', 'Diana', 'Ethan', 'Fiona', 'George', 'Henry',
  'Ivy', 'Jack', 'Kira', 'Liam', 'Maya', 'Noah', 'Olivia', 'Pedro',
  'Quinn', 'Ravi', 'Sofia', 'Tomas', 'Uma', 'Victor', 'Wendy', 'Xena',
  'Yara', 'Zane',
]
const LAST_NAMES = [
  'Andersson', 'Brown', 'Chen', 'Dubois', 'Evans', 'Fernandez', 'Gupta',
  'Hansen', 'Ito', 'Johnson', 'Khan', 'Lopez', 'Mueller', 'Nakamura',
  'Oliveira', 'Park', 'Quispe', 'Rossi', 'Silva', 'Tanaka', 'Ueda',
  'Vasquez', 'Wong', 'Xu', 'Yilmaz', 'Zhou',
]

const TAG_POOL = ['vip', 'wholesale', 'newsletter', 'repeat', 'high-value', 'recent', 'cold', 'refunded-once']
const NOTE_POOL = [
  'Asked for gift-wrap on their last order.',
  'Flagged as wholesale buyer — may qualify for B2B tier.',
  'Has repeatedly requested EU invoice formatting.',
  'Returned once due to sizing; offered exchange.',
  'Prefers contact via SMS over email.',
  null, null, null, // most customers shouldn't have a note
]

// Countries a customer could live in, keyed by shop region so we
// don't end up with a US customer in the LATAM store.
const COUNTRIES_BY_SHOP: Record<string, { code: string; name: string; city: string; province: string; zip: string }[]> = {
  'gbox-demo': [
    { code: 'US', name: 'United States', city: 'San Francisco', province: 'CA', zip: '94102' },
    { code: 'US', name: 'United States', city: 'New York', province: 'NY', zip: '10001' },
    { code: 'US', name: 'United States', city: 'Austin', province: 'TX', zip: '78701' },
    { code: 'CA', name: 'Canada', city: 'Toronto', province: 'ON', zip: 'M5V2T6' },
  ],
  'gbox-eu': [
    { code: 'DE', name: 'Germany', city: 'Berlin', province: 'BE', zip: '10115' },
    { code: 'FR', name: 'France', city: 'Paris', province: 'IDF', zip: '75001' },
    { code: 'NL', name: 'Netherlands', city: 'Amsterdam', province: 'NH', zip: '1011' },
    { code: 'ES', name: 'Spain', city: 'Madrid', province: 'MD', zip: '28001' },
    { code: 'IT', name: 'Italy', city: 'Milan', province: 'MI', zip: '20121' },
  ],
  'gbox-asia': [
    { code: 'SG', name: 'Singapore', city: 'Singapore', province: 'SG', zip: '018956' },
    { code: 'VN', name: 'Vietnam', city: 'Ho Chi Minh City', province: 'HCM', zip: '700000' },
    { code: 'JP', name: 'Japan', city: 'Tokyo', province: 'TK', zip: '100-0001' },
    { code: 'AU', name: 'Australia', city: 'Sydney', province: 'NSW', zip: '2000' },
  ],
  'gbox-latam': [
    { code: 'BR', name: 'Brazil', city: 'Sao Paulo', province: 'SP', zip: '01000-000' },
    { code: 'MX', name: 'Mexico', city: 'Mexico City', province: 'CMX', zip: '01000' },
    { code: 'AR', name: 'Argentina', city: 'Buenos Aires', province: 'BA', zip: 'C1001' },
  ],
}

function phoneForCountry(cc: string): string {
  const dial: Record<string, string> = {
    US: '+1', CA: '+1', DE: '+49', FR: '+33', NL: '+31', ES: '+34', IT: '+39',
    SG: '+65', VN: '+84', JP: '+81', AU: '+61', BR: '+55', MX: '+52', AR: '+54',
  }
  const prefix = dial[cc] ?? '+1'
  return `${prefix}${randomInt(100, 999)}${randomInt(1000, 9999)}`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Gbox Platform — Customers Board Demo Seed ===\n')

  // 0. Resolve the 4 demo shops — revenue seed created them
  console.log('[0] Resolving demo shops...')
  const shops = await db
    .selectFrom('shops')
    .select(['id', 'slug', 'name', 'currency'])
    .where('slug', 'in', ['gbox-demo', 'gbox-eu', 'gbox-asia', 'gbox-latam'])
    .execute()

  if (shops.length === 0) {
    console.error('ERROR: No demo shops found. Run `npx tsx scripts/seed-revenue-demo.ts` first.')
    process.exit(1)
  }
  for (const s of shops) {
    console.log(`    [=] ${s.slug} → ${s.id}`)
  }

  // 1. Make sure each shop has at least 15 customers — top up if needed
  console.log('\n[1] Topping up customers per shop (target ≥ 15)...')
  let created = 0
  for (const shop of shops) {
    const cntRow = await db
      .selectFrom('customers')
      .where('shop_id', '=', shop.id)
      .select(db.fn.count<number>('id').as('n'))
      .executeTakeFirstOrThrow()
    const current = Number(cntRow.n) || 0
    const need = Math.max(0, 15 - current)

    for (let i = 0; i < need; i++) {
      // Unique email per run — timestamped to dodge collisions with
      // any previous seed without having to query first.
      const email = `demo+${shop.slug}-extra-${Date.now()}-${i}@gbox.dev`
      await db
        .insertInto('customers')
        .values({
          id: uuid(),
          shop_id: shop.id,
          email,
          first_name: pick(FIRST_NAMES),
          last_name: pick(LAST_NAMES),
          status: 'active',
        })
        .execute()
      created++
    }
    console.log(`    ${shop.slug}: had ${current}, added ${need}`)
  }
  console.log(`    total new customers: ${created}`)

  // 2. Enrich every demo customer with profile fields + addresses
  console.log('\n[2] Enriching customer profiles + addresses...')
  let enriched = 0
  let addrsAdded = 0

  for (const shop of shops) {
    const countries = COUNTRIES_BY_SHOP[shop.slug] ?? COUNTRIES_BY_SHOP['gbox-demo']
    const customers = await db
      .selectFrom('customers')
      .where('shop_id', '=', shop.id)
      .select(['id', 'first_name', 'last_name', 'email'])
      .execute()

    for (const c of customers) {
      const country = pick(countries)
      const marketing = Math.random() < 0.6
      const tagCount = randomInt(0, 3)
      const tags: string[] = []
      for (let i = 0; i < tagCount; i++) {
        const t = pick(TAG_POOL)
        if (!tags.includes(t)) tags.push(t)
      }
      const note = pick(NOTE_POOL)
      // Last login is sometime in the last 30 days for ~70% of
      // customers (the rest have never logged in after signup).
      const lastLoginAt = Math.random() < 0.7 ? daysAgoIso(randomInt(0, 30)) : null

      await db
        .updateTable('customers')
        .where('id', '=', c.id)
        .set({
          phone: phoneForCountry(country.code),
          accepts_marketing: marketing,
          tags,
          note,
          last_login_at: lastLoginAt,
        })
        .execute()
      enriched++

      // Address — skip if customer already has one
      const addrRow = await db
        .selectFrom('customer_addresses')
        .where('customer_id', '=', c.id)
        .select('id')
        .limit(1)
        .executeTakeFirst()

      if (!addrRow) {
        await db
          .insertInto('customer_addresses')
          .values({
            id: uuid(),
            customer_id: c.id,
            first_name: c.first_name,
            last_name: c.last_name,
            address1: `${randomInt(100, 9999)} Market Street`,
            address2: randomInt(1, 4) === 1 ? `Suite ${randomInt(100, 999)}` : null,
            city: country.city,
            province: country.province,
            province_code: country.province,
            country: country.name,
            country_code: country.code,
            zip: country.zip,
            phone: phoneForCountry(country.code),
            is_default: true,
          })
          .execute()
        addrsAdded++

        // ~30% of customers get a secondary shipping address
        if (Math.random() < 0.3) {
          const alt = pick(countries)
          await db
            .insertInto('customer_addresses')
            .values({
              id: uuid(),
              customer_id: c.id,
              first_name: c.first_name,
              last_name: c.last_name,
              address1: `${randomInt(100, 9999)} Pine Avenue`,
              city: alt.city,
              province: alt.province,
              province_code: alt.province,
              country: alt.name,
              country_code: alt.code,
              zip: alt.zip,
              phone: phoneForCountry(alt.code),
              is_default: false,
            })
            .execute()
          addrsAdded++
        }
      }
    }
    console.log(`    ${shop.slug}: ${customers.length} profiles enriched`)
  }
  console.log(`    total enriched: ${enriched}`)
  console.log(`    total addresses inserted: ${addrsAdded}`)

  // 3. Recompute denormalized orders_count / total_spent
  // Looping per customer avoids raw SQL (and the kysely
  // version-mismatch pain of `sql.execute(db)` when the root and
  // packages/db kysely copies diverge). It's ~60 customers, so the
  // per-row cost is irrelevant.
  console.log('\n[3] Recomputing customers.orders_count + customers.total_spent...')
  let denormUpdated = 0
  for (const shop of shops) {
    // Pull raw rows and aggregate in JS — simpler than wrestling
    // with the kysely version mismatch between root and packages/db.
    const rawOrders = await db
      .selectFrom('orders')
      .where('shop_id', '=', shop.id)
      .where('customer_id', 'is not', null)
      .select(['customer_id', 'financial_status', 'total_price'])
      .execute()

    const agg = new Map<string, { cnt: number; spent: number }>()
    for (const o of rawOrders) {
      if (!o.customer_id) continue
      const e = agg.get(o.customer_id) ?? { cnt: 0, spent: 0 }
      if (['paid', 'partially_refunded', 'refunded'].includes(o.financial_status)) {
        e.cnt++
      }
      if (['paid', 'partially_refunded'].includes(o.financial_status)) {
        e.spent += Number(o.total_price) || 0
      }
      agg.set(o.customer_id, e)
    }

    for (const [customerId, stats] of agg) {
      await db
        .updateTable('customers')
        .where('id', '=', customerId)
        .set({
          orders_count: stats.cnt,
          total_spent: stats.spent.toFixed(2),
          updated_at: new Date().toISOString(),
        })
        .execute()
      denormUpdated++
    }
    console.log(`    ${shop.slug}: recomputed ${agg.size} customers`)
  }
  console.log(`    total denormalized updates: ${denormUpdated}`)

  // 4. Summary
  console.log('\n=== Seed Complete ===')
  const cntRow = await db
    .selectFrom('customers')
    .where('shop_id', 'in', shops.map((s) => s.id))
    .select(db.fn.count<number>('id').as('n'))
    .executeTakeFirstOrThrow()
  console.log(`Customers (demo shops): ${Number(cntRow.n) || 0}`)
  console.log('\nNext step: visit https://god-dev.gbox.co/god-admin/customers')
}

main()
  .catch((err) => {
    console.error('[Customers Seed] FATAL:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await destroyDb(db)
  })
