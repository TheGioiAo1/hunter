import 'dotenv/config'
import { createDb, destroyDb } from '../packages/db/src/index.ts'
import { sql } from 'kysely'

async function main() {
  const db = createDb()

  // Get shop, user, and order IDs
  const shop = await db
    .selectFrom('shops')
    .select(['id', 'slug'])
    .where('slug', '=', 'gbox-demo')
    .executeTakeFirst()

  if (!shop) {
    console.error('Shop gbox-demo not found')
    await destroyDb()
    process.exit(1)
  }

  console.log(`Shop: ${shop.slug} (${shop.id})`)

  // Get the seller user
  const seller = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', '=', 'thaibq@gbox.co')
    .executeTakeFirst()

  // Get the god admin user
  const godAdmin = await db
    .selectFrom('users')
    .select(['id', 'email'])
    .where('email', '=', 'buithai3107@gmail.com')
    .executeTakeFirst()

  if (!seller || !godAdmin) {
    console.error('Required users not found')
    await destroyDb()
    process.exit(1)
  }

  console.log(`Seller: ${seller.email} (${seller.id})`)
  console.log(`God Admin: ${godAdmin.email} (${godAdmin.id})`)

  // Get orders that are paid (suitable for refund requests)
  const orders = await db
    .selectFrom('orders')
    .select(['id', 'order_number', 'total_price', 'financial_status'])
    .where('shop_id', '=', shop.id)
    .where('financial_status', 'in', ['paid', 'partially_refunded'])
    .orderBy('order_number', 'asc')
    .limit(10)
    .execute()

  console.log(`Found ${orders.length} paid/partially_refunded orders`)

  if (orders.length < 3) {
    console.error('Need at least 3 orders to seed refund requests')
    await destroyDb()
    process.exit(1)
  }

  // Check if we already have refund requests
  const existing = await db
    .selectFrom('refund_requests' as any)
    .select(sql`count(*)`.as('c'))
    .execute()

  const count = Number((existing[0] as any)?.c ?? 0)
  if (count > 0) {
    console.log(`Already have ${count} refund requests, skipping seed`)
    await destroyDb()
    return
  }

  // Create 5 refund requests with various statuses
  const requests = [
    {
      order_id: orders[0].id,
      shop_id: shop.id,
      requested_by: seller.id,
      amount: (parseFloat(orders[0].total_price) * 0.5).toFixed(2),
      reason: 'Customer received damaged item. Requesting partial refund for the damaged product.',
      status: 'pending',
      line_items: JSON.stringify([{ description: 'Damaged item', quantity: 1 }]),
    },
    {
      order_id: orders[1].id,
      shop_id: shop.id,
      requested_by: seller.id,
      amount: orders[1].total_price,
      reason: 'Customer wants to return the entire order. Product not as described.',
      status: 'pending',
      line_items: null,
    },
    {
      order_id: orders[2].id,
      shop_id: shop.id,
      requested_by: seller.id,
      amount: (parseFloat(orders[2].total_price) * 0.3).toFixed(2),
      reason: 'Shipping delay compensation. Order arrived 2 weeks late.',
      status: 'approved',
      reviewed_by: godAdmin.id,
      reviewed_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      review_note: 'Approved. Shipping delay confirmed by carrier tracking.',
      line_items: null,
    },
    {
      order_id: orders.length > 3 ? orders[3].id : orders[0].id,
      shop_id: shop.id,
      requested_by: seller.id,
      amount: '25.00',
      reason: 'Customer complaint about product quality. Requesting goodwill refund.',
      status: 'rejected',
      reviewed_by: godAdmin.id,
      reviewed_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
      review_note: 'Rejected. Product was delivered as described. No quality issue found.',
      line_items: null,
    },
    {
      order_id: orders.length > 4 ? orders[4].id : orders[1].id,
      shop_id: shop.id,
      requested_by: seller.id,
      amount: '15.50',
      reason: 'Wrong size shipped. Customer wants exchange but we are out of stock.',
      status: 'pending',
      line_items: JSON.stringify([{ description: 'Wrong size item', quantity: 1 }]),
    },
  ]

  for (const req of requests) {
    await db
      .insertInto('refund_requests' as any)
      .values(req as any)
      .execute()
    console.log(`  Created refund request: ${req.status} — ${req.reason.substring(0, 50)}...`)
  }

  console.log(`\nSeeded ${requests.length} refund requests successfully`)
  console.log('  - 3 pending (awaiting God Admin review)')
  console.log('  - 1 approved')
  console.log('  - 1 rejected')

  await destroyDb()
}

main().catch(async (err) => {
  console.error('Seed error:', err)
  process.exit(1)
})
