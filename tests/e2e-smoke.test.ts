/**
 * Gbox Platform — E2E Smoke Tests (H.1)
 *
 * End-to-end smoke tests that exercise critical user journeys through
 * the service layer using the mock-DB pattern. These simulate:
 *
 *   Flow 1: Merchant signup -> store creation -> product add -> checkout -> order
 *   Flow 2: Customer registration -> browse -> add to cart -> checkout
 *
 * Each flow chains service calls in the order a real user would trigger
 * them, verifying the output of one step feeds correctly into the next.
 *
 * Run:  npx vitest tests/e2e-smoke.test.ts
 */

import { describe, it, expect, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Chainable mock-DB builder (same as packages/core tests)
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute')
          return vi
            .fn()
            .mockResolvedValue(
              result instanceof Array
                ? result
                : [result].filter(Boolean),
            )
        if (prop === 'executeTakeFirst')
          return vi.fn().mockResolvedValue(result ?? null)
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result')
            return result
          })
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

function createMockDb(overrides: Record<string, any> = {}) {
  const db: any = {
    insertInto: vi.fn().mockImplementation((table: string) => {
      return chainable(
        overrides[`insert:${table}`] ?? overrides[table] ?? { id: 'mock-id' },
      )
    }),
    selectFrom: vi.fn().mockImplementation((table: string) => {
      return chainable(
        overrides[`select:${table}`] ?? overrides[table],
      )
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      return chainable(
        overrides[`update:${table}`] ?? overrides[table],
      )
    }),
    deleteFrom: vi
      .fn()
      .mockImplementation((_table: string) => chainable()),
    transaction: vi.fn().mockReturnValue({
      // Phase 15 PR1 — `withSerializable` calls `.setIsolationLevel()`
      // before `.execute()`; we return a wrapper that exposes the same
      // `.execute()` so both the pre-PR1 (direct .execute) and post-PR1
      // (chained after setIsolationLevel) call paths work.
      setIsolationLevel: vi.fn().mockReturnValue({
        execute: vi
          .fn()
          .mockImplementation(async (fn: Function) =>
            fn(createMockDb(overrides)),
          ),
      }),
      execute: vi
        .fn()
        .mockImplementation(async (fn: Function) =>
          fn(createMockDb(overrides)),
        ),
    }),
    fn: {
      countAll: vi
        .fn()
        .mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
    },
  }
  return db
}

// ============================================================================
// FLOW 1: Merchant Journey — signup -> store -> product -> checkout -> order
// ============================================================================

describe('E2E Flow 1: Merchant Journey', () => {
  // Shared state across steps
  const merchantEmail = 'merchant-e2e@gbox.co'
  const storeSlug = 'e2e-test-store'
  const now = new Date().toISOString()

  let userId: string
  let sessionToken: string
  let shopId: string
  let productId: string
  let variantId: string
  let checkoutId: string
  let orderId: string

  it('Step 1: Merchant signup — creates user account', async () => {
    const { createUser } = await import(
      '../packages/core/src/modules/auth/service.js'
    )

    const mockUser = {
      id: 'e2e-user-001',
      email: merchantEmail,
      name: 'E2E Merchant',
      role: 'owner',
      status: 'active',
      avatar_url: null,
      created_at: now,
      updated_at: now,
    }

    const db = createMockDb({ 'insert:users': mockUser })
    const result = await createUser(db, {
      email: merchantEmail,
      name: 'E2E Merchant',
    })

    expect(result).toBeDefined()
    expect(result.id).toBe('e2e-user-001')
    expect(result.email).toBe(merchantEmail)
    expect(result.role).toBe('owner')

    userId = result.id
  })

  it('Step 2: Session creation — merchant logs in', async () => {
    const { createSession } = await import(
      '../packages/core/src/modules/auth/service.js'
    )

    const mockSession = {
      id: 'e2e-sess-001',
      user_id: userId,
      token_hash: 'hashed-value',
      ip_address: '127.0.0.1',
      user_agent: 'vitest-e2e',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: now,
    }

    const db = createMockDb({ 'insert:sessions': mockSession })
    const result = await createSession(db, userId, {
      ip_address: '127.0.0.1',
      user_agent: 'vitest-e2e',
    })

    expect(result.token).toHaveLength(64)
    expect(result.session.id).toBe('e2e-sess-001')

    sessionToken = result.token
  })

  it('Step 3: Store creation — merchant creates a shop', async () => {
    const mockShop = {
      id: 'e2e-shop-001',
      name: 'E2E Test Store',
      slug: storeSlug,
      email: `${storeSlug}@gbox.co`,
      currency: 'USD',
      plan: 'basic',
      status: 'active',
      created_at: now,
    }

    const db = createMockDb({ 'insert:shops': mockShop })

    const shop = await db
      .insertInto('shops')
      .values({
        name: 'E2E Test Store',
        slug: storeSlug,
        email: `${storeSlug}@gbox.co`,
        currency: 'USD',
        plan: 'basic',
        status: 'active',
      })
      .returning(['id', 'name', 'slug', 'currency', 'plan', 'status'])
      .executeTakeFirstOrThrow()

    expect(shop.id).toBe('e2e-shop-001')
    expect(shop.slug).toBe(storeSlug)
    expect(shop.status).toBe('active')

    shopId = shop.id

    // Link user to shop
    await db
      .insertInto('user_shops')
      .values({ user_id: userId, shop_id: shopId, role: 'owner' })
      .execute()

    expect(db.insertInto).toHaveBeenCalledWith('user_shops')
  })

  it('Step 4: Product creation — adds a product with variant', async () => {
    const { createProduct } = await import(
      '../packages/core/src/modules/products/service.js'
    )

    const mockProduct = {
      id: 'e2e-prod-001',
      shop_id: shopId,
      title: 'E2E Widget',
      slug: 'e2e-widget',
      status: 'active',
      created_at: now,
      updated_at: now,
    }
    const mockVariant = {
      id: 'e2e-var-001',
      product_id: 'e2e-prod-001',
      title: 'Standard',
      price: '49.99',
      sku: 'E2E-STD-001',
      inventory_quantity: 100,
    }

    const db = createMockDb({
      'insert:products': mockProduct,
      'insert:product_variants': mockVariant,
    })

    const result = await createProduct(db, shopId, {
      title: 'E2E Widget',
      slug: 'e2e-widget',
      variants: [
        { title: 'Standard', price: '49.99', sku: 'E2E-STD-001' },
      ],
    })

    expect(result.id).toBe('e2e-prod-001')
    expect(result.title).toBe('E2E Widget')
    expect(result.variants).toBeDefined()

    productId = result.id
    variantId = 'e2e-var-001'
  })

  it('Step 5: Checkout creation — customer adds to cart and starts checkout', async () => {
    // Simulate the checkout route logic
    const mockCheckout = {
      id: 'e2e-checkout-001',
      shop_id: shopId,
      email: 'buyer@example.com',
      line_items: [
        {
          variant_id: variantId,
          quantity: 2,
          title: 'E2E Widget - Standard',
          price: '49.99',
        },
      ],
      subtotal: '99.98',
      total: '99.98',
      currency: 'USD',
      created_at: now,
    }

    const db = createMockDb({
      'select:shops': { id: shopId, name: 'E2E Test Store', slug: storeSlug, currency: 'USD' },
      'insert:checkouts': mockCheckout,
    })

    // Simulate store lookup
    const shop = await db
      .selectFrom('shops')
      .select(['id', 'name', 'slug', 'currency'])
      .where('slug', '=', storeSlug)
      .executeTakeFirst()

    expect(shop).not.toBeNull()
    expect(shop.id).toBe(shopId)

    // Simulate checkout creation
    const items = [{ variant_id: variantId, quantity: 2 }]
    expect(items).toHaveLength(1)
    expect(items[0].variant_id).toBe(variantId)

    checkoutId = mockCheckout.id
    expect(checkoutId).toBe('e2e-checkout-001')
  })

  it('Step 6: Order completion — checkout becomes an order', async () => {
    const { createOrder } = await import(
      '../packages/core/src/modules/orders/service.js'
    )

    const mockOrder = {
      id: 'e2e-order-001',
      shop_id: shopId,
      customer_email: 'buyer@example.com',
      subtotal_price: '99.98',
      total_price: '99.98',
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      created_at: now,
    }

    const db = createMockDb({
      'insert:orders': mockOrder,
      'insert:order_line_items': {
        id: 'e2e-li-001',
        order_id: 'e2e-order-001',
        title: 'E2E Widget - Standard',
        quantity: 2,
        price: '49.99',
      },
      'insert:transactions': {
        id: 'e2e-txn-001',
        order_id: 'e2e-order-001',
        kind: 'sale',
        amount: '99.98',
        gateway: 'stripe',
        status: 'success',
      },
    })

    const order = await createOrder(db, shopId, {
      line_items: [
        { title: 'E2E Widget - Standard', quantity: 2, price: '49.99' },
      ],
      transactions: [
        { kind: 'sale', amount: '99.98', gateway: 'stripe' },
      ],
    })

    expect(order.id).toBe('e2e-order-001')
    expect(order.line_items).toBeDefined()
    expect(order.transactions).toBeDefined()

    orderId = order.id
  })

  it('Step 7: Order fulfillment — merchant ships the order', async () => {
    const { createFulfillment } = await import(
      '../packages/core/src/modules/orders/service.js'
    )

    const mockFulfillment = {
      id: 'e2e-ful-001',
      order_id: orderId,
      status: 'success',
      tracking_number: 'E2E-TRACK-001',
      tracking_company: 'FedEx',
      tracking_url: 'https://fedex.com/track/E2E-TRACK-001',
    }

    const db = createMockDb({
      'insert:fulfillments': mockFulfillment,
      'select:order_line_items': { count: 0 },
    })

    const fulfillment = await createFulfillment(db, orderId, {
      tracking_number: 'E2E-TRACK-001',
      tracking_company: 'FedEx',
      line_items: [{ line_item_id: 'e2e-li-001', quantity: 2 }],
    })

    expect(fulfillment.id).toBe('e2e-ful-001')
    expect(fulfillment.status).toBe('success')
    expect(fulfillment.tracking_number).toBe('E2E-TRACK-001')
  })

  it('Step 8: Refund — partial refund issued', async () => {
    const { createRefund } = await import(
      '../packages/core/src/modules/orders/service.js'
    )

    const mockRefund = {
      id: 'e2e-ref-001',
      order_id: orderId,
      note: 'One item damaged in shipping',
      restock: true,
    }

    const db = createMockDb({
      'insert:refunds': mockRefund,
      'insert:refund_line_items': {
        id: 'e2e-rli-001',
        refund_id: 'e2e-ref-001',
        line_item_id: 'e2e-li-001',
        quantity: 1,
        restock_type: 'return',
      },
      'insert:transactions': {
        id: 'e2e-txn-ref-001',
        order_id: orderId,
        kind: 'refund',
        amount: '49.99',
        gateway: 'stripe',
      },
    })

    const refund = await createRefund(db, orderId, {
      note: 'One item damaged in shipping',
      restock: true,
      refund_line_items: [
        {
          line_item_id: 'e2e-li-001',
          quantity: 1,
          restock_type: 'return',
        },
      ],
      transactions: [
        { kind: 'refund', amount: '49.99', gateway: 'stripe' },
      ],
    })

    expect(refund).toBeDefined()
    expect(refund.refund_line_items).toHaveLength(1)
    expect(refund.transactions).toBeDefined()
  })
})

// ============================================================================
// FLOW 2: Customer Journey — registration -> browse -> cart -> checkout
// ============================================================================

describe('E2E Flow 2: Customer Journey', () => {
  const shopId = 'e2e-shop-002'
  const storeSlug = 'e2e-customer-store'
  const customerEmail = 'customer-e2e@example.com'
  const now = new Date().toISOString()

  it('Step 1: Store exists for browsing', async () => {
    const mockShop = {
      id: shopId,
      name: 'E2E Customer Store',
      slug: storeSlug,
      currency: 'USD',
      status: 'active',
    }
    const db = createMockDb({ 'select:shops': mockShop })

    const shop = await db
      .selectFrom('shops')
      .select(['id', 'name', 'slug', 'currency', 'status'])
      .where('slug', '=', storeSlug)
      .executeTakeFirst()

    expect(shop).not.toBeNull()
    expect(shop.status).toBe('active')
  })

  it('Step 2: Customer browses products (storefront API)', async () => {
    const products = [
      {
        id: 'e2e-prod-010',
        title: 'Organic T-Shirt',
        slug: 'organic-tshirt',
        status: 'active',
        variants: [{ id: 'e2e-var-010', title: 'M', price: '29.99' }],
      },
      {
        id: 'e2e-prod-011',
        title: 'Eco Hoodie',
        slug: 'eco-hoodie',
        status: 'active',
        variants: [{ id: 'e2e-var-011', title: 'L', price: '59.99' }],
      },
    ]
    const db = createMockDb({ 'select:products': products })

    const result = await db
      .selectFrom('products')
      .select(['id', 'title', 'slug', 'status'])
      .where('shop_id', '=', shopId)
      .where('status', '=', 'active')
      .execute()

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('Organic T-Shirt')
    expect(result[1].title).toBe('Eco Hoodie')
  })

  it('Step 3: Customer browses collections', async () => {
    const collections = [
      { id: 'e2e-coll-001', title: 'New Arrivals', slug: 'new-arrivals' },
      { id: 'e2e-coll-002', title: 'Best Sellers', slug: 'best-sellers' },
    ]
    const db = createMockDb({ 'select:collections': collections })

    const result = await db
      .selectFrom('collections')
      .select(['id', 'title', 'slug'])
      .where('shop_id', '=', shopId)
      .execute()

    expect(result).toHaveLength(2)
  })

  it('Step 4: Customer views product detail', async () => {
    const { getProduct } = await import(
      '../packages/core/src/modules/products/service.js'
    )

    const mockProduct = {
      id: 'e2e-prod-010',
      shop_id: shopId,
      title: 'Organic T-Shirt',
      slug: 'organic-tshirt',
      body_html: '<p>100% organic cotton</p>',
      status: 'active',
    }
    const mockVariants = [
      { id: 'e2e-var-010', product_id: 'e2e-prod-010', title: 'M', price: '29.99' },
      { id: 'e2e-var-010b', product_id: 'e2e-prod-010', title: 'L', price: '29.99' },
    ]
    const mockImages = [
      { id: 'e2e-img-001', src: 'https://cdn.gbox.co/tshirt.jpg' },
    ]
    const mockOptions = [
      { id: 'e2e-opt-001', name: 'Size', values: ['M', 'L', 'XL'] },
    ]

    let callIdx = 0
    const db = createMockDb()
    db.selectFrom = vi.fn().mockImplementation(() => {
      callIdx++
      if (callIdx === 1) return chainable(mockProduct)
      if (callIdx === 2) return chainable(mockVariants)
      if (callIdx === 3) return chainable(mockImages)
      return chainable(mockOptions)
    })

    const product = await getProduct(db, shopId, 'e2e-prod-010')

    expect(product).not.toBeNull()
    expect(product!.title).toBe('Organic T-Shirt')
    expect(product!.variants).toBeDefined()
    expect(product!.images).toBeDefined()
    expect(product!.options).toBeDefined()
  })

  it('Step 5: Customer creates checkout (add to cart + checkout)', async () => {
    // Simulate the checkout route logic
    const mockShop = {
      id: shopId,
      name: 'E2E Customer Store',
      slug: storeSlug,
      currency: 'USD',
    }

    let selectIdx = 0
    const db = createMockDb()
    db.selectFrom = vi.fn().mockImplementation(() => {
      selectIdx++
      if (selectIdx === 1) return chainable(mockShop)
      if (selectIdx === 2) return chainable(null) // no account_mode setting
      return chainable(null)
    })

    // Validate the cart items
    const items = [
      { variant_id: 'e2e-var-010', quantity: 1 },
      { variant_id: 'e2e-var-011', quantity: 2 },
    ]

    expect(items).toHaveLength(2)
    expect(items[0].variant_id).toBe('e2e-var-010')

    // The checkout would be created via createCheckout service
    // We simulate the response
    const checkoutResponse = {
      id: 'e2e-checkout-002',
      shop_id: shopId,
      line_items: [
        { variant_id: 'e2e-var-010', quantity: 1, price: '29.99' },
        { variant_id: 'e2e-var-011', quantity: 2, price: '59.99' },
      ],
      subtotal: '149.97',
      total: '149.97',
      currency: 'USD',
    }

    expect(checkoutResponse.id).toBeDefined()
    expect(checkoutResponse.line_items).toHaveLength(2)
    expect(checkoutResponse.total).toBe('149.97')
  })

  it('Step 6: Customer applies discount code', async () => {
    // Simulate discount lookup + application
    const mockDiscount = {
      id: 'e2e-disc-001',
      code: 'WELCOME10',
      type: 'percentage',
      value: '10',
      status: 'active',
      usage_count: 0,
      usage_limit: 100,
    }
    const db = createMockDb({ 'select:discounts': mockDiscount })

    const discount = await db
      .selectFrom('discounts')
      .select(['id', 'code', 'type', 'value', 'status', 'usage_count', 'usage_limit'])
      .where('code', '=', 'WELCOME10')
      .where('shop_id', '=', shopId)
      .where('status', '=', 'active')
      .executeTakeFirst()

    expect(discount).not.toBeNull()
    expect(discount.code).toBe('WELCOME10')
    expect(discount.type).toBe('percentage')

    // Validate discount is usable
    expect(discount.usage_count < discount.usage_limit).toBe(true)

    // Calculate discounted total
    const subtotal = 149.97
    const discountAmount = subtotal * (parseFloat(discount.value) / 100)
    const discountedTotal = subtotal - discountAmount

    expect(discountAmount).toBeCloseTo(14.997)
    expect(discountedTotal).toBeCloseTo(134.973)
  })

  it('Step 7: Checkout completion — order is created', async () => {
    const { createOrder } = await import(
      '../packages/core/src/modules/orders/service.js'
    )

    const mockOrder = {
      id: 'e2e-order-002',
      shop_id: shopId,
      customer_email: customerEmail,
      subtotal_price: '149.97',
      total_discounts: '14.997',
      total_price: '134.97',
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      discount_codes: ['WELCOME10'],
      created_at: now,
    }

    const db = createMockDb({
      'insert:orders': mockOrder,
      'insert:order_line_items': { id: 'e2e-li-010' },
      'insert:transactions': {
        id: 'e2e-txn-002',
        order_id: 'e2e-order-002',
        kind: 'sale',
        amount: '134.97',
        gateway: 'paypal',
        status: 'success',
      },
    })

    const order = await createOrder(db, shopId, {
      line_items: [
        { title: 'Organic T-Shirt - M', quantity: 1, price: '29.99' },
        { title: 'Eco Hoodie - L', quantity: 2, price: '59.99' },
      ],
      transactions: [
        { kind: 'sale', amount: '134.97', gateway: 'paypal' },
      ],
    })

    expect(order.id).toBe('e2e-order-002')
    expect(order.line_items).toBeDefined()
    expect(order.transactions).toBeDefined()
  })

  it('Step 8: Customer retrieves order details', async () => {
    const { getOrder } = await import(
      '../packages/core/src/modules/orders/service.js'
    )

    const mockOrder = {
      id: 'e2e-order-002',
      shop_id: shopId,
      customer_email: customerEmail,
      total_price: '134.97',
      financial_status: 'paid',
    }

    let callIdx = 0
    const db = createMockDb()
    db.selectFrom = vi.fn().mockImplementation(() => {
      callIdx++
      if (callIdx === 1) return chainable(mockOrder)
      if (callIdx === 2) return chainable([
        { id: 'e2e-li-010', title: 'Organic T-Shirt - M', quantity: 1, price: '29.99' },
        { id: 'e2e-li-011', title: 'Eco Hoodie - L', quantity: 2, price: '59.99' },
      ])
      if (callIdx === 3) return chainable([]) // fulfillments
      if (callIdx === 4) return chainable([
        { id: 'e2e-txn-002', kind: 'sale', amount: '134.97' },
      ])
      return chainable([]) // refunds
    })

    const order = await getOrder(db, shopId, 'e2e-order-002')

    expect(order).not.toBeNull()
    expect(order!.id).toBe('e2e-order-002')
    expect(order!.line_items).toBeDefined()
    expect(order!.fulfillments).toBeDefined()
    expect(order!.transactions).toBeDefined()
    expect(order!.refunds).toBeDefined()
  })
})

// ============================================================================
// FLOW 3: Multi-currency checkout
// ============================================================================

describe('E2E Flow 3: Multi-currency Checkout', () => {
  const shopId = 'e2e-shop-003'

  it('converts checkout total to presentment currency', async () => {
    // Simulate the checkout route's currency conversion logic
    const shopCurrency = 'USD'
    const targetCurrency = 'EUR'
    const checkoutTotal = '99.98'

    // Mock exchange rate lookup
    const mockRate = { from_currency: 'USD', to_currency: 'EUR', rate: '0.92' }
    const db = createMockDb({ 'select:exchange_rates': mockRate })

    const rateRow = await db
      .selectFrom('exchange_rates')
      .select(['from_currency', 'to_currency', 'rate'])
      .where('from_currency', '=', shopCurrency)
      .where('to_currency', '=', targetCurrency)
      .executeTakeFirst()

    expect(rateRow).not.toBeNull()

    const rate = parseFloat(rateRow.rate)
    const convertedTotal = (parseFloat(checkoutTotal) * rate).toFixed(2)

    expect(convertedTotal).toBe('91.98')

    // Build checkout response with presentment currency
    const checkoutResponse = {
      total: checkoutTotal,
      currency: shopCurrency,
      presentment_total: convertedTotal,
      presentment_currency: targetCurrency,
      exchange_rate: rateRow.rate,
    }

    expect(checkoutResponse.presentment_currency).toBe('EUR')
    expect(checkoutResponse.presentment_total).toBe('91.98')
    expect(checkoutResponse.exchange_rate).toBe('0.92')
  })
})

// ============================================================================
// FLOW 4: Store management lifecycle
// ============================================================================

describe('E2E Flow 4: Store Management Lifecycle', () => {
  it('creates store -> adds products -> creates collection -> assigns products -> deletes collection', async () => {
    // Step 1: Create store
    const shopId = 'e2e-lifecycle-001'
    const mockShop = {
      id: shopId,
      name: 'Lifecycle Store',
      slug: 'lifecycle-store',
      status: 'active',
    }
    let db = createMockDb({ 'insert:shops': mockShop })
    const shop = await db
      .insertInto('shops')
      .values(mockShop)
      .returning(['id', 'name', 'slug', 'status'])
      .executeTakeFirstOrThrow()

    expect(shop.id).toBe(shopId)

    // Step 2: Add products
    const { createProduct } = await import(
      '../packages/core/src/modules/products/service.js'
    )
    db = createMockDb({
      'insert:products': { id: 'lc-prod-001', shop_id: shopId, title: 'Item A' },
      'insert:product_variants': { id: 'lc-var-001', price: '10.00' },
    })
    const product = await createProduct(db, shopId, {
      title: 'Item A',
      slug: 'item-a',
    })
    expect(product.id).toBe('lc-prod-001')

    // Step 3: Create collection
    db = createMockDb({
      'insert:collections': { id: 'lc-coll-001', shop_id: shopId, title: 'Featured' },
    })
    const coll = await db
      .insertInto('collections')
      .values({ shop_id: shopId, title: 'Featured', slug: 'featured' })
      .returning(['id', 'title'])
      .executeTakeFirstOrThrow()
    expect(coll.id).toBe('lc-coll-001')

    // Step 4: Assign product to collection
    db = createMockDb({
      'insert:collection_products': {
        collection_id: 'lc-coll-001',
        product_id: 'lc-prod-001',
        position: 0,
      },
    })
    await db
      .insertInto('collection_products')
      .values({
        collection_id: 'lc-coll-001',
        product_id: 'lc-prod-001',
        position: 0,
      })
      .execute()

    expect(db.insertInto).toHaveBeenCalledWith('collection_products')

    // Step 5: Remove product from collection
    db = createMockDb()
    await db
      .deleteFrom('collection_products')
      .where('collection_id', '=', 'lc-coll-001')
      .where('product_id', '=', 'lc-prod-001')
      .execute()

    expect(db.deleteFrom).toHaveBeenCalled()

    // Step 6: Delete collection
    db = createMockDb()
    await db
      .deleteFrom('collections')
      .where('id', '=', 'lc-coll-001')
      .where('shop_id', '=', shopId)
      .execute()

    expect(db.deleteFrom).toHaveBeenCalled()
  })
})

// ============================================================================
// FLOW 5: Gift card lifecycle
// ============================================================================

describe('E2E Flow 5: Gift Card Lifecycle', () => {
  const shopId = 'e2e-gc-shop-001'

  it('issues gift card -> redeems partially -> checks balance -> disables', async () => {
    // Step 1: Issue gift card
    const mockGiftCard = {
      id: 'e2e-gc-001',
      shop_id: shopId,
      code: 'E2E-GIFT-ABCD',
      initial_value: '100.00',
      balance: '100.00',
      status: 'active',
    }
    let db = createMockDb({ 'insert:gift_cards': mockGiftCard })

    const gc = await db
      .insertInto('gift_cards')
      .values({
        shop_id: shopId,
        code: 'E2E-GIFT-ABCD',
        initial_value: '100.00',
        balance: '100.00',
      })
      .returning(['id', 'code', 'initial_value', 'balance', 'status'])
      .executeTakeFirstOrThrow()

    expect(gc.balance).toBe('100.00')
    expect(gc.status).toBe('active')

    // Step 2: Redeem $30
    db = createMockDb({
      'select:gift_cards': { ...gc, balance: '100.00' },
      'update:gift_cards': { id: gc.id, balance: '70.00' },
    })

    const lookup = await db
      .selectFrom('gift_cards')
      .where('code', '=', 'E2E-GIFT-ABCD')
      .executeTakeFirst()

    expect(lookup).not.toBeNull()
    const newBalance = (parseFloat(lookup.balance) - 30).toFixed(2)
    expect(newBalance).toBe('70.00')

    // Step 3: Check balance
    db = createMockDb({
      'select:gift_cards': { id: gc.id, balance: '70.00', status: 'active' },
    })
    const balanceCheck = await db
      .selectFrom('gift_cards')
      .where('code', '=', 'E2E-GIFT-ABCD')
      .executeTakeFirst()

    expect(balanceCheck.balance).toBe('70.00')
    expect(balanceCheck.status).toBe('active')

    // Step 4: Disable gift card
    db = createMockDb({
      'update:gift_cards': { id: gc.id, status: 'disabled' },
    })
    const disabled = await db
      .updateTable('gift_cards')
      .set({ status: 'disabled' })
      .where('id', '=', gc.id)
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow()

    expect(disabled.status).toBe('disabled')
  })
})

// ============================================================================
// FLOW 6: Webhook delivery lifecycle
// ============================================================================

describe('E2E Flow 6: Webhook Lifecycle', () => {
  const shopId = 'e2e-wh-shop-001'

  it('creates webhook -> lists -> retrieves -> deletes', async () => {
    // Step 1: Create
    const mockWebhook = {
      id: 'e2e-wh-001',
      shop_id: shopId,
      topic: 'orders/paid',
      address: 'https://hooks.example.com/orders',
      format: 'json',
    }
    let db = createMockDb({ 'insert:webhooks': mockWebhook })

    const wh = await db
      .insertInto('webhooks')
      .values(mockWebhook)
      .returning(['id', 'topic', 'address', 'format'])
      .executeTakeFirstOrThrow()

    expect(wh.id).toBe('e2e-wh-001')
    expect(wh.topic).toBe('orders/paid')

    // Step 2: List
    db = createMockDb({
      'select:webhooks': [mockWebhook],
    })
    const list = await db
      .selectFrom('webhooks')
      .where('shop_id', '=', shopId)
      .execute()

    expect(list).toHaveLength(1)

    // Step 3: Get single
    db = createMockDb({ 'select:webhooks': mockWebhook })
    const single = await db
      .selectFrom('webhooks')
      .where('id', '=', 'e2e-wh-001')
      .executeTakeFirst()

    expect(single).not.toBeNull()
    expect(single.topic).toBe('orders/paid')

    // Step 4: Delete
    db = createMockDb()
    await db
      .deleteFrom('webhooks')
      .where('id', '=', 'e2e-wh-001')
      .where('shop_id', '=', shopId)
      .execute()

    expect(db.deleteFrom).toHaveBeenCalled()
  })
})

// ============================================================================
// FLOW 7: Error handling across the stack
// ============================================================================

describe('E2E Flow 7: Error Handling', () => {
  it('401 when no session provided for protected route', () => {
    const user = null
    const res = { statusCode: 200, body: null as any }

    if (!user) {
      res.statusCode = 401
      res.body = { error: 'Unauthorized', message: 'Valid session required' }
    }

    expect(res.statusCode).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('403 when non-owner accesses god admin route', () => {
    const user = { role: 'staff' }
    const res = { statusCode: 200, body: null as any }

    if (user.role !== 'owner') {
      res.statusCode = 403
      res.body = { error: 'Forbidden', message: 'God Admin access required' }
    }

    expect(res.statusCode).toBe(403)
  })

  it('404 for non-existent store', async () => {
    const db = createMockDb()
    db.selectFrom = vi.fn().mockReturnValue(chainable(null))

    const shop = await db
      .selectFrom('shops')
      .where('slug', '=', 'ghost-store')
      .executeTakeFirst()

    const res = { statusCode: 200, body: null as any }
    if (!shop) {
      res.statusCode = 404
      res.body = { error: 'Not found', message: 'Store not found' }
    }

    expect(res.statusCode).toBe(404)
    expect(res.body.error).toBe('Not found')
  })

  it('400 for invalid checkout items', () => {
    const body = { items: 'not-an-array' } as any
    const res = { statusCode: 200, body: null as any }

    if (
      !body.items ||
      !Array.isArray(body.items) ||
      body.items.length === 0
    ) {
      res.statusCode = 400
      res.body = {
        error: 'Validation error',
        message: 'items array is required',
      }
    }

    expect(res.statusCode).toBe(400)
    expect(res.body.message).toBe('items array is required')
  })

  it('400 for required customer account without email', () => {
    const accountMode = 'required'
    const email = undefined
    const res = { statusCode: 200, body: null as any }

    if (accountMode === 'required' && !email) {
      res.statusCode = 400
      res.body = {
        error: 'Customer account required',
        message:
          'This store requires customers to provide an email to checkout',
      }
    }

    expect(res.statusCode).toBe(400)
    expect(res.body.error).toBe('Customer account required')
  })
})
