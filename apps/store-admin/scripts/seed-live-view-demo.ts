/**
 * Seed demo data for the Live View page so KPI cards, world map, and
 * the customer-behavior bars all light up.
 *
 * What it seeds (idempotent — re-runnable any time):
 *   - ~60 checkout_sessions spread across the last 10 minutes
 *       · 22 "open" sessions with updated_at >= NOW() - 2m  → "Checking out"
 *       · 18 "open" sessions with updated_at <  NOW() - 2m  → "Active carts"
 *       · 20 "completed" sessions                           → "Purchased"
 *     (the "Checking out" subset also counts as "Visitors right now")
 *
 *   - 20 orders from 20 different countries so the world map shows
 *     dots on all 5 continents. Each order is marked with tag
 *     "gbox-demo-live-view" so a future rerun / cleanup finds them.
 *
 * Self-clean: every run deletes rows from prior seeds (matching the
 * "gbox-demo-live-view" tag on orders and a deterministic email pattern
 * on the orders + the sentinel `note = '[gbox-demo]'` on checkout_sessions
 * — we can't tag checkout_sessions directly so we leak a sentinel via
 * cart_json metadata).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/seed-live-view-demo.ts [storeSlug]
 *   DATABASE_URL=... npx tsx scripts/seed-live-view-demo.ts [storeSlug] --clean
 *
 * Default storeSlug: gbox-test
 *
 * Safety: --clean just wipes demo rows and exits without inserting new
 * ones. Normal run wipes + inserts fresh rows so the Live View window
 * always reflects the current "last 10 minutes".
 */

import { createDb, destroyDb } from '@gbox/db'
import { randomUUID } from 'node:crypto'

// Stable marker so cleanup is deterministic. Do NOT change mid-project
// without a migration script — old rows will leak.
const DEMO_TAG = 'gbox-demo-live-view'
const DEMO_NOTE = '[gbox-demo]'
const DEMO_EMAIL_SUFFIX = '@gbox-demo.local'

// 20 countries scattered around the globe for a populated map. All
// codes match the COUNTRY_CENTROIDS table in live-view.ts.
const DEMO_COUNTRIES: Array<{ code: string; name: string; currency: string; sampleCity: string }> = [
  { code: 'VN', name: 'Vietnam', currency: 'VND', sampleCity: 'Ho Chi Minh City' },
  { code: 'US', name: 'United States', currency: 'USD', sampleCity: 'New York' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', sampleCity: 'London' },
  { code: 'DE', name: 'Germany', currency: 'EUR', sampleCity: 'Berlin' },
  { code: 'FR', name: 'France', currency: 'EUR', sampleCity: 'Paris' },
  { code: 'JP', name: 'Japan', currency: 'JPY', sampleCity: 'Tokyo' },
  { code: 'AU', name: 'Australia', currency: 'AUD', sampleCity: 'Sydney' },
  { code: 'CA', name: 'Canada', currency: 'CAD', sampleCity: 'Toronto' },
  { code: 'BR', name: 'Brazil', currency: 'BRL', sampleCity: 'São Paulo' },
  { code: 'IN', name: 'India', currency: 'INR', sampleCity: 'Mumbai' },
  { code: 'TH', name: 'Thailand', currency: 'THB', sampleCity: 'Bangkok' },
  { code: 'SG', name: 'Singapore', currency: 'SGD', sampleCity: 'Singapore' },
  { code: 'MY', name: 'Malaysia', currency: 'MYR', sampleCity: 'Kuala Lumpur' },
  { code: 'ID', name: 'Indonesia', currency: 'IDR', sampleCity: 'Jakarta' },
  { code: 'PH', name: 'Philippines', currency: 'PHP', sampleCity: 'Manila' },
  { code: 'KR', name: 'South Korea', currency: 'KRW', sampleCity: 'Seoul' },
  { code: 'MX', name: 'Mexico', currency: 'MXN', sampleCity: 'Mexico City' },
  { code: 'IT', name: 'Italy', currency: 'EUR', sampleCity: 'Rome' },
  { code: 'ES', name: 'Spain', currency: 'EUR', sampleCity: 'Madrid' },
  { code: 'NL', name: 'Netherlands', currency: 'EUR', sampleCity: 'Amsterdam' },
]

function minsAgo(mins: number): Date {
  return new Date(Date.now() - mins * 60 * 1000)
}

/** Random int in [min, max] inclusive */
function rint(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** Deterministic-ish random float in [min, max] */
function rflt(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

async function clean(db: any, shopId: string): Promise<{ orders: number; sessions: number }> {
  // Wipe orders previously seeded by this script. Every demo order has
  // an @gbox-demo.local email suffix, which is unique enough to identify
  // them cleanly without dealing with Kysely's array-contains quirks.
  const ordRes = await db
    .deleteFrom('orders')
    .where('shop_id', '=', shopId)
    .where('email', 'like', `%${DEMO_EMAIL_SUFFIX}`)
    .executeTakeFirst()
  const ordersDeleted = Number(ordRes?.numDeletedRows || 0)

  // Wipe checkout_sessions that carry the sentinel note inside cart_json
  const sessRows = await db
    .selectFrom('checkout_sessions')
    .select(['id', 'cart_json'])
    .where('shop_id', '=', shopId)
    .execute()

  const victims: string[] = []
  for (const row of sessRows as any[]) {
    try {
      const c = typeof row.cart_json === 'string' ? JSON.parse(row.cart_json) : row.cart_json
      if (c && typeof c === 'object' && c._gbox_demo === DEMO_NOTE) {
        victims.push(row.id)
      }
    } catch {
      /* skip malformed */
    }
  }

  let sessionsDeleted = 0
  if (victims.length > 0) {
    const r = await db
      .deleteFrom('checkout_sessions')
      .where('shop_id', '=', shopId)
      .where('id', 'in', victims)
      .executeTakeFirst()
    sessionsDeleted = Number(r?.numDeletedRows || 0)
  }

  return { orders: ordersDeleted, sessions: sessionsDeleted }
}

async function seedCheckoutSessions(db: any, shopId: string): Promise<number> {
  const rows: any[] = []
  const now = Date.now()

  // 22 "Checking out" — open + updated_at within last 2 mins.
  for (let i = 0; i < 22; i++) {
    const createdSecondsAgo = rint(30, 540) // 30s … 9 mins ago
    const updatedSecondsAgo = rint(1, 110) // within last 2 mins
    rows.push({
      id: randomUUID(),
      shop_id: shopId,
      customer_id: null,
      cart_json: JSON.stringify({
        _gbox_demo: DEMO_NOTE,
        items: [
          {
            variant_id: null,
            title: 'Demo item',
            quantity: rint(1, 3),
            price: String(rint(19, 199) + 0.99),
          },
        ],
      }),
      state: 'open',
      created_at: new Date(now - createdSecondsAgo * 1000),
      updated_at: new Date(now - updatedSecondsAgo * 1000),
    })
  }

  // 18 "Active carts" — open + updated_at between 2m and 10m.
  for (let i = 0; i < 18; i++) {
    const createdSecondsAgo = rint(180, 590)
    const updatedSecondsAgo = rint(125, 590) // older than 2 mins
    rows.push({
      id: randomUUID(),
      shop_id: shopId,
      customer_id: null,
      cart_json: JSON.stringify({
        _gbox_demo: DEMO_NOTE,
        items: [
          {
            variant_id: null,
            title: 'Demo item',
            quantity: rint(1, 2),
            price: String(rint(9, 149) + 0.99),
          },
        ],
      }),
      state: 'open',
      created_at: new Date(now - createdSecondsAgo * 1000),
      updated_at: new Date(now - updatedSecondsAgo * 1000),
    })
  }

  // 20 "Purchased" — completed.
  for (let i = 0; i < 20; i++) {
    const createdSecondsAgo = rint(60, 590)
    const updatedSecondsAgo = rint(10, createdSecondsAgo)
    rows.push({
      id: randomUUID(),
      shop_id: shopId,
      customer_id: null,
      cart_json: JSON.stringify({
        _gbox_demo: DEMO_NOTE,
        items: [
          {
            variant_id: null,
            title: 'Demo item',
            quantity: rint(1, 4),
            price: String(rint(19, 299) + 0.99),
          },
        ],
      }),
      state: 'completed',
      created_at: new Date(now - createdSecondsAgo * 1000),
      updated_at: new Date(now - updatedSecondsAgo * 1000),
    })
  }

  if (rows.length === 0) return 0
  await db.insertInto('checkout_sessions').values(rows).execute()
  return rows.length
}

async function seedOrders(db: any, shopId: string): Promise<number> {
  const rows: any[] = []
  const now = Date.now()

  // One order per demo country (20 total), scattered across the last
  // 10 minutes. Prices randomized so "Total sales" sums to a realistic
  // value (~$2k–$10k depending on the roll).
  for (const country of DEMO_COUNTRIES) {
    const createdSecondsAgo = rint(30, 590)
    const price = rflt(19.99, 499.99)
    const firstName = 'Demo'
    const lastName = `From${country.code}`

    rows.push({
      id: randomUUID(),
      shop_id: shopId,
      customer_id: null,
      email: `demo-${country.code.toLowerCase()}-${rint(1000, 9999)}${DEMO_EMAIL_SUFFIX}`,
      phone: null,
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      currency: 'USD',
      total_price: price.toFixed(2),
      subtotal_price: price.toFixed(2),
      shipping_address: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        address1: '123 Demo Street',
        city: country.sampleCity,
        country: country.name,
        country_code: country.code,
        zip: '00000',
      }),
      billing_address: JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        address1: '123 Demo Street',
        city: country.sampleCity,
        country: country.name,
        country_code: country.code,
        zip: '00000',
      }),
      note: DEMO_NOTE,
      tags: [DEMO_TAG],
      source_channel: 'online_store',
      created_at: new Date(now - createdSecondsAgo * 1000),
      updated_at: new Date(now - createdSecondsAgo * 1000),
    })
  }

  if (rows.length === 0) return 0
  await db.insertInto('orders').values(rows).execute()
  return rows.length
}

async function main() {
  const args = process.argv.slice(2)
  const storeSlug = args.find((a) => !a.startsWith('--')) || 'gbox-test'
  const cleanOnly = args.includes('--clean')

  console.log(`[seed-live-view] store=${storeSlug} mode=${cleanOnly ? 'clean' : 'seed'}`)

  const db = createDb() as any

  try {
    const shopRow = await db
      .selectFrom('shops')
      .select(['id', 'name', 'slug'])
      .where('slug', '=', storeSlug)
      .executeTakeFirst()

    if (!shopRow) {
      console.error(`[FAIL] Store not found: ${storeSlug}`)
      process.exit(1)
    }
    console.log(`[ok]   Store: ${shopRow.name} (${shopRow.id})`)

    const wiped = await clean(db, shopRow.id)
    console.log(
      `[ok]   Cleaned prior demo: orders=${wiped.orders} sessions=${wiped.sessions}`,
    )

    if (cleanOnly) {
      console.log('[done] --clean requested — exiting without seeding')
      return
    }

    const sessionsInserted = await seedCheckoutSessions(db, shopRow.id)
    console.log(`[ok]   Inserted ${sessionsInserted} checkout_sessions`)

    const ordersInserted = await seedOrders(db, shopRow.id)
    console.log(`[ok]   Inserted ${ordersInserted} orders from ${DEMO_COUNTRIES.length} countries`)

    console.log('\n[done] Live View should now show:')
    console.log('       - Visitors right now: ~22 (the "Checking out" subset)')
    console.log('       - Total sessions (10m): ~60')
    console.log(`       - Total orders (10m): ${ordersInserted}`)
    console.log('       - Total sales (10m): sum of 20 random paid orders')
    console.log('       - World map: dots on all 5 continents')
    console.log('       - Customer behavior: Active=~18, Checking out=~22, Purchased=~20')
    console.log('\n       Refresh the Live View page to see it light up.')
    console.log('       Rerun this script any time to re-anchor the 10-minute window.')
  } finally {
    await destroyDb(db)
  }
}

main().catch((err) => {
  console.error('[FAIL] Seed crashed:', err)
  process.exit(1)
})
