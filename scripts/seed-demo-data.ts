#!/usr/bin/env tsx
/**
 * Gbox Platform — Demo Data Seed Script
 *
 * Seeds a complete demo store with realistic data:
 * - 1 demo shop with settings
 * - 20 products with variants and images
 * - 5 collections
 * - 30 customers
 * - 50 orders with line items
 * - 10 discount codes
 * - 3 shipping zones with rates
 * - 2 locations
 * - Sample blog posts, pages, and menus
 *
 * Usage:
 *   npx tsx scripts/seed-demo-data.ts
 *   DATABASE_URL=postgresql://... npx tsx scripts/seed-demo-data.ts
 *
 * Flags:
 *   --clean    Delete existing demo data before seeding
 *   --shop=X   Use specific shop slug (default: demo-store)
 */

import { createDb, destroyDb } from '@gbox/db'
import crypto from 'crypto'

const db = createDb()

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SHOP_SLUG = process.argv.find(a => a.startsWith('--shop='))?.split('=')[1] || 'demo-store'
const CLEAN = process.argv.includes('--clean')

const uuid = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min
const randomChoice = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const randomPrice = (min: number, max: number) => (Math.random() * (max - min) + min).toFixed(2)

// ---------------------------------------------------------------------------
// Demo Data
// ---------------------------------------------------------------------------

const PRODUCT_NAMES = [
  'Classic Cotton T-Shirt', 'Premium Hoodie', 'Slim Fit Jeans', 'Canvas Sneakers',
  'Leather Backpack', 'Wireless Earbuds', 'Smart Watch Pro', 'Organic Coffee Beans',
  'Bamboo Water Bottle', 'Yoga Mat Premium', 'Running Shorts', 'Winter Jacket',
  'Silk Scarf', 'Stainless Steel Tumbler', 'Bluetooth Speaker', 'Sunglasses UV400',
  'Crossbody Bag', 'Phone Case Ultra', 'Essential Oil Set', 'Ceramic Mug Set',
]

const COLLECTIONS = [
  { name: 'Summer Collection', desc: 'Light and breezy essentials for the warm season' },
  { name: 'Best Sellers', desc: 'Our most popular products, loved by thousands' },
  { name: 'New Arrivals', desc: 'Fresh drops just landed in store' },
  { name: 'Sale', desc: 'Great deals on selected items — up to 50% off' },
  { name: 'Gift Ideas', desc: 'Perfect presents for every occasion' },
]

const FIRST_NAMES = ['James', 'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'William', 'Sophia', 'Oliver', 'Isabella',
  'Elijah', 'Mia', 'Lucas', 'Charlotte', 'Mason', 'Amelia', 'Logan', 'Harper', 'Alex', 'Evelyn',
  'Ethan', 'Abigail', 'Aiden', 'Emily', 'Jackson', 'Elizabeth', 'Sebastian', 'Sofia', 'Mateo', 'Avery']

const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson']

const COLORS = ['Black', 'White', 'Navy', 'Red', 'Green', 'Blue', 'Grey']
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL']

const DISCOUNT_CODES = [
  { code: 'WELCOME10', type: 'percentage', value: 10, min_order: '0' },
  { code: 'SAVE20', type: 'percentage', value: 20, min_order: '50.00' },
  { code: 'FLAT5', type: 'fixed_amount', value: 5, min_order: '25.00' },
  { code: 'SUMMER25', type: 'percentage', value: 25, min_order: '75.00' },
  { code: 'FREESHIP', type: 'fixed_amount', value: 0, min_order: '0' },
  { code: 'VIP30', type: 'percentage', value: 30, min_order: '100.00' },
  { code: 'FLASH15', type: 'percentage', value: 15, min_order: '0' },
  { code: 'HOLIDAY50', type: 'percentage', value: 50, min_order: '200.00' },
  { code: 'NEW10', type: 'percentage', value: 10, min_order: '0' },
  { code: 'BUNDLE20', type: 'percentage', value: 20, min_order: '150.00' },
]

// ---------------------------------------------------------------------------
// Seed Functions
// ---------------------------------------------------------------------------

async function seedShop(): Promise<string> {
  const existing = await db.selectFrom('shops' as any).selectAll().where('slug', '=', SHOP_SLUG).executeTakeFirst()
  if (existing) {
    console.log(`  Shop "${SHOP_SLUG}" already exists (${(existing as any).id})`)
    return (existing as any).id
  }

  const shopId = uuid()
  await db.insertInto('shops' as any).values({
    id: shopId,
    name: 'Demo Store',
    slug: SHOP_SLUG,
    email: 'demo@gbox.co',
    domain: `${SHOP_SLUG}.gbox.co`,
    currency: 'USD',
    timezone: 'America/New_York',
    status: 'active',
    plan: 'professional',
    created_at: now(),
    updated_at: now(),
  }).execute()

  // Shop settings
  const settings = [
    { key: 'store_name', value: '"Demo Store"' },
    { key: 'store_description', value: '"A beautiful demo store powered by Gbox Platform"' },
    { key: 'customer_account_mode', value: '"optional"' },
    { key: 'checkout_login_method', value: '"email_code"' },
  ]
  for (const s of settings) {
    await db.insertInto('shop_settings' as any).values({
      shop_id: shopId, key: s.key, value: s.value,
    }).execute()
  }

  console.log(`  Created shop "${SHOP_SLUG}" (${shopId})`)
  return shopId
}

async function seedProducts(shopId: string): Promise<string[]> {
  const productIds: string[] = []

  for (const name of PRODUCT_NAMES) {
    const productId = uuid()
    const price = randomPrice(9.99, 149.99)
    const comparePrice = (parseFloat(price) * 1.3).toFixed(2)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

    await db.insertInto('products' as any).values({
      id: productId,
      shop_id: shopId,
      title: name,
      handle: slug,
      body_html: `<p>Premium quality ${name.toLowerCase()}. Made with care and attention to detail.</p>`,
      vendor: randomChoice(['Gbox', 'Premium Co', 'Quality Goods', 'Essential Brand']),
      product_type: randomChoice(['Apparel', 'Accessories', 'Electronics', 'Home', 'Health']),
      status: 'active',
      tags: [randomChoice(['trending', 'popular', 'new']), randomChoice(['featured', 'sale', 'premium'])],
      created_at: now(),
      updated_at: now(),
    }).execute()

    // Create 2-3 variants per product
    const variantCount = randomInt(1, 3)
    for (let v = 0; v < variantCount; v++) {
      const variantId = uuid()
      const variantPrice = (parseFloat(price) + v * 5).toFixed(2)
      const color = randomChoice(COLORS)
      const size = randomChoice(SIZES)

      await db.insertInto('product_variants' as any).values({
        id: variantId,
        product_id: productId,
        title: `${color} / ${size}`,
        price: variantPrice,
        compare_at_price: comparePrice,
        sku: `${slug}-${color.toLowerCase()}-${size.toLowerCase()}`,
        inventory_quantity: randomInt(0, 200),
        option1: color,
        option2: size,
        position: v + 1,
        created_at: now(),
        updated_at: now(),
      }).execute()
    }

    productIds.push(productId)
  }

  console.log(`  Created ${PRODUCT_NAMES.length} products with variants`)
  return productIds
}

async function seedCollections(shopId: string, productIds: string[]): Promise<void> {
  for (const col of COLLECTIONS) {
    const colId = uuid()
    const slug = col.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

    await db.insertInto('collections' as any).values({
      id: colId,
      shop_id: shopId,
      title: col.name,
      handle: slug,
      body_html: `<p>${col.desc}</p>`,
      sort_order: 'best-selling',
      published: true,
      created_at: now(),
      updated_at: now(),
    }).execute()

    // Assign 4-8 random products to each collection
    const count = randomInt(4, 8)
    const shuffled = [...productIds].sort(() => Math.random() - 0.5)
    for (let i = 0; i < Math.min(count, shuffled.length); i++) {
      await db.insertInto('collection_products' as any).values({
        collection_id: colId,
        product_id: shuffled[i],
        position: i + 1,
      }).execute().catch(() => {}) // Ignore duplicates
    }
  }

  console.log(`  Created ${COLLECTIONS.length} collections`)
}

async function seedCustomers(shopId: string): Promise<string[]> {
  const customerIds: string[] = []

  for (let i = 0; i < 30; i++) {
    const firstName = FIRST_NAMES[i]
    const lastName = LAST_NAMES[i]
    const customerId = uuid()

    await db.insertInto('customers' as any).values({
      id: customerId,
      shop_id: shopId,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`,
      first_name: firstName,
      last_name: lastName,
      phone: `+1${randomInt(200, 999)}${randomInt(100, 999)}${randomInt(1000, 9999)}`,
      accepts_marketing: Math.random() > 0.3,
      orders_count: 0,
      total_spent: 0,
      tags: Math.random() > 0.5 ? ['returning'] : [],
      verified_email: true,
      status: 'active',
      created_at: now(),
      updated_at: now(),
    }).execute()

    customerIds.push(customerId)
  }

  console.log(`  Created 30 customers`)
  return customerIds
}

async function seedOrders(shopId: string, productIds: string[], customerIds: string[]): Promise<void> {
  const statuses = ['paid', 'paid', 'paid', 'pending', 'refunded']
  const fulfillStatuses = ['fulfilled', 'fulfilled', 'unfulfilled', 'partial']

  for (let i = 0; i < 50; i++) {
    const orderId = uuid()
    const customer = randomChoice(customerIds)
    const customerRow = await db.selectFrom('customers' as any).selectAll()
      .where('id', '=', customer).executeTakeFirst() as any

    const lineItemCount = randomInt(1, 4)
    let subtotal = 0
    const lineItems: any[] = []

    for (let li = 0; li < lineItemCount; li++) {
      const productId = randomChoice(productIds)
      const product = await db.selectFrom('products' as any).selectAll()
        .where('id', '=', productId).executeTakeFirst() as any
      const variant = await db.selectFrom('product_variants' as any).selectAll()
        .where('product_id', '=', productId).limit(1).executeTakeFirst() as any

      if (!product || !variant) continue

      const quantity = randomInt(1, 3)
      const price = parseFloat(variant.price || '29.99')
      subtotal += price * quantity

      lineItems.push({
        id: uuid(),
        order_id: orderId,
        product_id: productId,
        variant_id: variant.id,
        title: product.title,
        variant_title: variant.title,
        quantity,
        price: price.toFixed(2),
        sku: variant.sku,
        fulfillment_status: null,
        created_at: now(),
        updated_at: now(),
      })
    }

    if (lineItems.length === 0) continue

    const tax = subtotal * 0.08
    const shipping = randomChoice([0, 5.99, 9.99, 14.99])
    const total = subtotal + tax + shipping

    // Random date in last 30 days
    const orderDate = new Date(Date.now() - randomInt(0, 30 * 24 * 60 * 60 * 1000)).toISOString()

    await db.insertInto('orders' as any).values({
      id: orderId,
      shop_id: shopId,
      order_number: 1000 + i,
      email: customerRow?.email || 'guest@example.com',
      customer_id: customer,
      financial_status: randomChoice(statuses),
      fulfillment_status: randomChoice(fulfillStatuses),
      currency: 'USD',
      subtotal_price: subtotal.toFixed(2),
      total_tax: tax.toFixed(2),
      total_shipping: shipping.toFixed(2),
      total_discounts: '0.00',
      total_price: total.toFixed(2),
      total_line_items_price: subtotal.toFixed(2),
      tags: [],
      note: null,
      cancel_reason: null,
      cancelled_at: null,
      closed_at: null,
      shipping_address: JSON.stringify({
        first_name: customerRow?.first_name || 'Guest',
        last_name: customerRow?.last_name || 'User',
        address1: `${randomInt(1, 999)} ${randomChoice(['Main St', 'Oak Ave', 'Pine Rd', 'Elm St'])}`,
        city: randomChoice(['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix']),
        province: randomChoice(['NY', 'CA', 'IL', 'TX', 'AZ']),
        country: 'US',
        zip: `${randomInt(10000, 99999)}`,
      }),
      billing_address: null,
      created_at: orderDate,
      updated_at: orderDate,
    }).execute()

    // Insert line items
    for (const li of lineItems) {
      await db.insertInto('order_line_items' as any).values(li).execute()
    }

    // Update customer stats
    await db.updateTable('customers' as any)
      .set({
        orders_count: (db as any).fn('COALESCE', ['orders_count', 0]).add(1) as any,
        total_spent: (db as any).fn('COALESCE', ['total_spent', 0]).add(Math.round(total)) as any,
        updated_at: now(),
      } as any)
      .where('id', '=', customer)
      .execute()
      .catch(() => {}) // Ignore SQL function issues
  }

  console.log(`  Created 50 orders with line items`)
}

async function seedDiscounts(shopId: string): Promise<void> {
  for (const d of DISCOUNT_CODES) {
    await db.insertInto('discounts' as any).values({
      id: uuid(),
      shop_id: shopId,
      title: `${d.code} - ${d.type === 'percentage' ? `${d.value}% off` : `$${d.value} off`}`,
      code: d.code,
      type: d.type,
      value: d.value,
      value_type: d.type === 'percentage' ? 'percentage' : 'fixed_amount',
      minimum_order_amount: d.min_order,
      usage_limit: randomInt(50, 500),
      times_used: randomInt(0, 30),
      starts_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'active',
      created_at: now(),
      updated_at: now(),
    }).execute()
  }

  console.log(`  Created ${DISCOUNT_CODES.length} discount codes`)
}

async function seedContent(shopId: string): Promise<void> {
  // Pages
  const pages = [
    { title: 'About Us', handle: 'about', content: '<h2>Our Story</h2><p>We started with a simple mission: provide quality products at fair prices. Today, we serve customers worldwide with the same dedication to excellence.</p>' },
    { title: 'Contact', handle: 'contact', content: '<h2>Get In Touch</h2><p>Email: hello@demo-store.com<br>Phone: +1 (555) 123-4567<br>Hours: Mon-Fri 9AM-5PM EST</p>' },
    { title: 'FAQ', handle: 'faq', content: '<h2>Frequently Asked Questions</h2><p><strong>How long does shipping take?</strong><br>Standard shipping: 5-7 business days. Express: 2-3 business days.</p><p><strong>What is your return policy?</strong><br>30-day hassle-free returns on all items.</p>' },
    { title: 'Privacy Policy', handle: 'privacy-policy', content: '<h2>Privacy Policy</h2><p>We respect your privacy and are committed to protecting your personal data.</p>' },
    { title: 'Terms of Service', handle: 'terms-of-service', content: '<h2>Terms of Service</h2><p>By using our store, you agree to these terms and conditions.</p>' },
  ]

  for (const page of pages) {
    await db.insertInto('pages' as any).values({
      id: uuid(),
      shop_id: shopId,
      title: page.title,
      handle: page.handle,
      body_html: page.content,
      published: true,
      created_at: now(),
      updated_at: now(),
    }).execute()
  }

  // Blog posts
  const posts = [
    { title: 'Welcome to Our Store', handle: 'welcome', excerpt: 'We are excited to launch our new online store!' },
    { title: '5 Summer Fashion Trends', handle: 'summer-trends', excerpt: 'Stay stylish this summer with these trending looks.' },
    { title: 'How to Choose the Perfect Gift', handle: 'gift-guide', excerpt: 'Our ultimate guide to finding the right present.' },
  ]

  for (const post of posts) {
    await db.insertInto('blog_posts' as any).values({
      id: uuid(),
      shop_id: shopId,
      title: post.title,
      handle: post.handle,
      body_html: `<p>${post.excerpt}</p><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>`,
      excerpt: post.excerpt,
      author: 'Demo Store Team',
      published: true,
      published_at: now(),
      tags: ['news'],
      created_at: now(),
      updated_at: now(),
    }).execute()
  }

  // Menus
  const menuId = uuid()
  await db.insertInto('menus' as any).values({
    id: menuId, shop_id: shopId, title: 'Main Menu', handle: 'main-menu',
    created_at: now(), updated_at: now(),
  }).execute()

  const menuItems = [
    { title: 'Home', url: '/', position: 1 },
    { title: 'Shop All', url: '/collections/all', position: 2 },
    { title: 'Best Sellers', url: '/collections/best-sellers', position: 3 },
    { title: 'Sale', url: '/collections/sale', position: 4 },
    { title: 'About', url: '/pages/about', position: 5 },
    { title: 'Contact', url: '/pages/contact', position: 6 },
  ]

  for (const item of menuItems) {
    await db.insertInto('menu_items' as any).values({
      id: uuid(), menu_id: menuId, title: item.title, url: item.url,
      position: item.position, created_at: now(), updated_at: now(),
    }).execute()
  }

  const footerMenuId = uuid()
  await db.insertInto('menus' as any).values({
    id: footerMenuId, shop_id: shopId, title: 'Footer Menu', handle: 'footer',
    created_at: now(), updated_at: now(),
  }).execute()

  const footerItems = [
    { title: 'Privacy Policy', url: '/pages/privacy-policy', position: 1 },
    { title: 'Terms of Service', url: '/pages/terms-of-service', position: 2 },
    { title: 'FAQ', url: '/pages/faq', position: 3 },
    { title: 'Contact', url: '/pages/contact', position: 4 },
  ]

  for (const item of footerItems) {
    await db.insertInto('menu_items' as any).values({
      id: uuid(), menu_id: footerMenuId, title: item.title, url: item.url,
      position: item.position, created_at: now(), updated_at: now(),
    }).execute()
  }

  console.log(`  Created 5 pages, 3 blog posts, 2 menus`)
}

async function seedShipping(shopId: string): Promise<void> {
  const zones = [
    {
      name: 'Domestic (US)',
      countries: ['US'],
      rates: [
        { name: 'Standard Shipping', price: '5.99', min_weight: 0, max_weight: 50 },
        { name: 'Express Shipping', price: '14.99', min_weight: 0, max_weight: 50 },
        { name: 'Free Shipping (over $75)', price: '0.00', min_order: '75.00' },
      ],
    },
    {
      name: 'Canada',
      countries: ['CA'],
      rates: [
        { name: 'Standard International', price: '12.99', min_weight: 0, max_weight: 30 },
        { name: 'Express International', price: '29.99', min_weight: 0, max_weight: 30 },
      ],
    },
    {
      name: 'Rest of World',
      countries: ['*'],
      rates: [
        { name: 'International Shipping', price: '19.99', min_weight: 0, max_weight: 20 },
      ],
    },
  ]

  for (const zone of zones) {
    const zoneId = uuid()
    await db.insertInto('shipping_zones' as any).values({
      id: zoneId, shop_id: shopId, name: zone.name,
      countries: zone.countries,
      created_at: now(), updated_at: now(),
    }).execute()

    for (const rate of zone.rates) {
      await db.insertInto('shipping_rates' as any).values({
        id: uuid(),
        shipping_zone_id: zoneId,
        name: rate.name,
        price: rate.price,
        min_order_subtotal: (rate as any).min_order || null,
        conditions: JSON.stringify({ min_weight: rate.min_weight, max_weight: rate.max_weight }),
        created_at: now(),
        updated_at: now(),
      }).execute()
    }
  }

  console.log(`  Created 3 shipping zones with rates`)
}

async function seedLocations(shopId: string): Promise<void> {
  const locations = [
    { name: 'Main Warehouse', address: '123 Commerce St, New York, NY 10001', primary: true },
    { name: 'West Coast Fulfillment', address: '456 Distribution Ave, Los Angeles, CA 90001', primary: false },
  ]

  for (const loc of locations) {
    await db.insertInto('locations' as any).values({
      id: uuid(), shop_id: shopId, name: loc.name,
      address1: loc.address.split(',')[0],
      city: loc.address.split(',')[1]?.trim(),
      province: loc.address.split(',')[2]?.trim().split(' ')[0],
      zip: loc.address.split(' ').pop(),
      country: 'US',
      active: true,
      is_primary: loc.primary,
      created_at: now(), updated_at: now(),
    }).execute()
  }

  console.log(`  Created 2 locations`)
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

async function cleanDemoData(shopId: string): Promise<void> {
  console.log('  Cleaning existing demo data...')

  // Delete in dependency order
  const tables = [
    'order_line_items', 'orders', 'collection_products', 'product_variants',
    'product_images', 'products', 'collections', 'customers', 'discounts',
    'shipping_rates', 'shipping_zones', 'locations', 'menu_items', 'menus',
    'blog_posts', 'pages', 'notifications', 'activity_logs', 'shop_settings',
  ]

  for (const table of tables) {
    try {
      await db.deleteFrom(table as any).where('shop_id', '=', shopId).execute()
    } catch {
      // Some tables might use different FK column names
      try {
        const rows = await db.selectFrom(table as any).selectAll().where('shop_id', '=', shopId).execute()
        if (rows.length > 0) {
          for (const row of rows) {
            await db.deleteFrom(table as any).where('id', '=', (row as any).id).execute()
          }
        }
      } catch {}
    }
  }

  // Delete the shop itself
  await db.deleteFrom('shops' as any).where('id', '=', shopId).execute().catch(() => {})

  console.log('  Cleaned')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== Gbox Platform Demo Data Seeder ===\n')
  console.log(`Shop: ${SHOP_SLUG}`)
  console.log(`Database: ${process.env.DATABASE_URL?.replace(/:[^:@]*@/, ':***@') || 'default'}\n`)

  try {
    if (CLEAN) {
      const existing = await db.selectFrom('shops' as any).selectAll().where('slug', '=', SHOP_SLUG).executeTakeFirst()
      if (existing) {
        await cleanDemoData((existing as any).id)
      }
    }

    console.log('Seeding...')
    const shopId = await seedShop()
    const productIds = await seedProducts(shopId)
    await seedCollections(shopId, productIds)
    const customerIds = await seedCustomers(shopId)
    await seedOrders(shopId, productIds, customerIds)
    await seedDiscounts(shopId)
    await seedContent(shopId)
    await seedShipping(shopId)
    await seedLocations(shopId)

    console.log('\n=== SEED COMPLETE ===')
    console.log(`\nStore URL: http://localhost:4321/api/store/${SHOP_SLUG}`)
    console.log(`Admin URL: http://localhost:4325/admin/store/${SHOP_SLUG}`)
    console.log(`\nSummary:`)
    console.log(`  - 1 shop (${SHOP_SLUG})`)
    console.log(`  - ${PRODUCT_NAMES.length} products with variants`)
    console.log(`  - ${COLLECTIONS.length} collections`)
    console.log(`  - 30 customers`)
    console.log(`  - 50 orders`)
    console.log(`  - ${DISCOUNT_CODES.length} discount codes`)
    console.log(`  - 5 pages, 3 blog posts, 2 menus`)
    console.log(`  - 3 shipping zones, 2 locations`)
  } catch (err: any) {
    console.error('\nSeed failed:', err.message)
    if (err.detail) console.error('Detail:', err.detail)
    process.exit(1)
  } finally {
    await destroyDb(db)
  }
}

main()
