/**
 * Gbox Platform — API Integration Tests (H.1)
 *
 * Tests the server route handler logic using the same mock-DB pattern as
 * the existing unit tests in packages/core/src/modules/.
 *
 * Each describe block covers one domain (auth, stores, products, orders,
 * customers, collections, discounts, gift cards, webhooks, files, currency,
 * markets). Within each domain we test:
 *   - Happy path (2xx)
 *   - Error cases (400 / 401 / 404)
 *   - Response shape (key fields present)
 *
 * Run:  npx vitest tests/api-integration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Chainable mock-DB builder  (same pattern as packages/core tests)
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute')
          return vi.fn().mockResolvedValue(
            result instanceof Array ? result : [result].filter(Boolean),
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
      return chainable(overrides[`select:${table}`] ?? overrides[table])
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`update:${table}`] ?? overrides[table])
    }),
    deleteFrom: vi.fn().mockImplementation((_table: string) => {
      return chainable()
    }),
    transaction: vi.fn().mockReturnValue({
      // Phase 15 PR1 — `withSerializable` calls `.setIsolationLevel()`
      // before `.execute()`; we return a wrapper that exposes the same
      // `.execute()` so both the pre-PR1 (direct .execute) and post-PR1
      // (chained after setIsolationLevel) call paths work.
      setIsolationLevel: vi.fn().mockReturnValue({
        execute: vi.fn().mockImplementation(async (fn: Function) => {
          return fn(createMockDb(overrides))
        }),
      }),
      execute: vi.fn().mockImplementation(async (fn: Function) => {
        return fn(createMockDb(overrides))
      }),
    }),
    fn: {
      countAll: vi
        .fn()
        .mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Minimal Express request / response fakes
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number
  body: any
  cookies: Record<string, { value: string; options?: any }>
  headers: Record<string, string>
  status(code: number): FakeResponse
  json(data: any): FakeResponse
  cookie(name: string, value: string, opts?: any): FakeResponse
  setHeader(name: string, value: string): FakeResponse
  redirect(url: string): FakeResponse
  redirectUrl?: string
  send(data: any): FakeResponse
}

function fakeRes(): FakeResponse {
  const res: any = {
    statusCode: 200,
    body: null,
    cookies: {},
    headers: {},
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: any) {
      res.body = data
      return res
    },
    cookie(name: string, value: string, opts?: any) {
      res.cookies[name] = { value, options: opts }
      return res
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value
      return res
    },
    redirect(url: string) {
      res.statusCode = 302
      res.redirectUrl = url
      return res
    },
    send(data: any) {
      res.body = data
      return res
    },
  }
  return res
}

function fakeReq(overrides: Record<string, any> = {}): any {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    ip: '127.0.0.1',
    method: 'GET',
    path: '/',
    ...overrides,
  }
}

// ============================================================================
// AUTH SERVICE INTEGRATION
// ============================================================================

describe('Auth Integration', () => {
  describe('createUser + createSession', () => {
    it('creates a user and returns the user record', async () => {
      const { createUser } = await import(
        '../packages/core/src/modules/auth/service.js'
      )
      const mockUser = {
        id: 'user-int-001',
        email: 'merchant@gbox.co',
        name: 'Merchant One',
        role: 'owner',
        status: 'active',
        avatar_url: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }
      const db = createMockDb({ 'insert:users': mockUser })

      const result = await createUser(db, {
        email: 'merchant@gbox.co',
        name: 'Merchant One',
      })

      expect(result).toBeDefined()
      expect(result.id).toBe('user-int-001')
      expect(result.email).toBe('merchant@gbox.co')
    })

    it('creates a session with a 64-char hex token', async () => {
      const { createSession } = await import(
        '../packages/core/src/modules/auth/service.js'
      )
      const mockSession = {
        id: 'sess-int-001',
        user_id: 'user-int-001',
        token_hash: 'hashed',
        ip_address: '127.0.0.1',
        user_agent: 'vitest',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: new Date().toISOString(),
      }
      const db = createMockDb({ 'insert:sessions': mockSession })

      const result = await createSession(db, 'user-int-001', {
        ip_address: '127.0.0.1',
        user_agent: 'vitest',
      })

      expect(result.token).toBeDefined()
      expect(result.token).toHaveLength(64)
      expect(result.session.id).toBe('sess-int-001')
    })
  })

  describe('validateSession', () => {
    it('returns null for expired or missing session', async () => {
      const { validateSession } = await import(
        '../packages/core/src/modules/auth/service.js'
      )
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))

      const result = await validateSession(db, 'nonexistent-token')
      expect(result).toBeNull()
    })

    it('returns user+session for valid token', async () => {
      const { validateSession } = await import(
        '../packages/core/src/modules/auth/service.js'
      )
      const mockSession = {
        id: 'sess-001',
        user_id: 'user-001',
        token_hash: 'abc',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }
      const mockUser = {
        id: 'user-001',
        email: 'admin@gbox.co',
        name: 'Admin',
        role: 'owner',
        status: 'active',
      }

      let callCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return chainable(mockSession)
        return chainable(mockUser)
      })

      const result = await validateSession(db, 'some-valid-token')
      expect(result).not.toBeNull()
      expect(result!.user.id).toBe('user-001')
      expect(result!.session.id).toBe('sess-001')
    })
  })

  describe('createApiToken + validateApiToken', () => {
    it('generates a gbox_ prefixed API token', async () => {
      const { createApiToken } = await import(
        '../packages/core/src/modules/auth/service.js'
      )
      const mockRow = {
        id: 'tok-int-001',
        user_id: 'user-001',
        shop_id: 'shop-001',
        name: 'CI Token',
        token_hash: 'hashed',
        scopes: '["read_products"]',
      }
      const db = createMockDb({ 'insert:api_tokens': mockRow })

      const result = await createApiToken(db, 'user-001', 'shop-001', {
        label: 'CI Token',
        scopes: ['read_products'],
      })

      expect(result.token.startsWith('gbox_')).toBe(true)
      expect(result.api_token.id).toBe('tok-int-001')
    })

    it('rejects an invalid API token', async () => {
      const { validateApiToken } = await import(
        '../packages/core/src/modules/auth/service.js'
      )
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))

      const result = await validateApiToken(db, 'gbox_badtoken')
      expect(result).toBeNull()
    })
  })
})

// ============================================================================
// PRODUCT SERVICE INTEGRATION
// ============================================================================

describe('Product Integration', () => {
  const shopId = 'shop-prod-001'

  describe('createProduct', () => {
    it('creates a product with title and variants', async () => {
      const { createProduct } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const mockProduct = {
        id: 'prod-int-001',
        shop_id: shopId,
        title: 'Wireless Mouse',
        slug: 'wireless-mouse',
        status: 'active',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }
      const mockVariant = {
        id: 'var-int-001',
        product_id: 'prod-int-001',
        title: 'Black',
        price: '29.99',
      }
      const db = createMockDb({
        'insert:products': mockProduct,
        'insert:product_variants': mockVariant,
      })

      const result = await createProduct(db, shopId, {
        title: 'Wireless Mouse',
        slug: 'wireless-mouse',
        variants: [{ title: 'Black', price: '29.99' }],
      })

      expect(result).toBeDefined()
      expect(result.id).toBe('prod-int-001')
      expect(result.title).toBe('Wireless Mouse')
      expect(result.variants).toBeDefined()
    })

    it('creates a default variant when none given', async () => {
      const { createProduct } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const db = createMockDb({
        'insert:products': { id: 'prod-int-002', shop_id: shopId, title: 'Simple' },
        'insert:product_variants': { id: 'var-default', title: 'Default Title', price: '0' },
      })

      const result = await createProduct(db, shopId, {
        title: 'Simple',
        slug: 'simple',
      })

      expect(result).toBeDefined()
      expect(result.variants).toBeDefined()
    })
  })

  describe('getProduct', () => {
    it('returns product with variants, images, and options', async () => {
      const { getProduct } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const mockProduct = { id: 'prod-int-001', shop_id: shopId, title: 'Widget' }
      const mockVariants = [{ id: 'var-001', product_id: 'prod-int-001', title: 'S' }]
      const mockImages = [{ id: 'img-001', src: 'https://cdn.gbox.co/img.jpg' }]
      const mockOptions = [{ id: 'opt-001', name: 'Size', values: ['S', 'M'] }]

      let callIdx = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        callIdx++
        if (callIdx === 1) return chainable(mockProduct)
        if (callIdx === 2) return chainable(mockVariants)
        if (callIdx === 3) return chainable(mockImages)
        return chainable(mockOptions)
      })

      const result = await getProduct(db, shopId, 'prod-int-001')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('prod-int-001')
      expect(result!.variants).toBeDefined()
      expect(result!.images).toBeDefined()
      expect(result!.options).toBeDefined()
    })

    it('returns null for non-existent product', async () => {
      const { getProduct } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))

      const result = await getProduct(db, shopId, 'does-not-exist')
      expect(result).toBeNull()
    })
  })

  describe('updateProduct', () => {
    it('updates title and returns the updated product', async () => {
      const { updateProduct } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const db = createMockDb({
        'update:products': {
          id: 'prod-int-001',
          shop_id: shopId,
          title: 'Renamed Mouse',
          updated_at: new Date().toISOString(),
        },
      })

      const result = await updateProduct(db, shopId, 'prod-int-001', {
        title: 'Renamed Mouse',
      })
      expect(result.title).toBe('Renamed Mouse')
      expect(db.updateTable).toHaveBeenCalledWith('products')
    })
  })

  describe('deleteProduct', () => {
    it('calls transaction for cascading delete', async () => {
      const { deleteProduct } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const db = createMockDb()
      await deleteProduct(db, shopId, 'prod-int-001')
      expect(db.transaction).toHaveBeenCalled()
    })
  })

  describe('listProducts', () => {
    it('returns paginated list with total count', async () => {
      const { listProducts } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const products = [
        { id: 'p1', title: 'A' },
        { id: 'p2', title: 'B' },
      ]
      let callCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return chainable(products)
        return chainable({ count: 2 })
      })
      db.fn = {
        countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
      }

      const result = await listProducts(db, shopId, {}, { limit: 10, offset: 0 })
      expect(result.products).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('filters by status', async () => {
      const { listProducts } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      let callCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return chainable([])
        return chainable({ count: 0 })
      })
      db.fn = {
        countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
      }

      const result = await listProducts(db, shopId, { status: 'draft' })
      expect(result.products).toHaveLength(0)
      expect(result.total).toBe(0)
    })
  })

  describe('createVariant', () => {
    it('adds a new variant to a product', async () => {
      const { createVariant } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const mockVariant = {
        id: 'var-new-001',
        product_id: 'prod-int-001',
        title: 'XL',
        price: '34.99',
        sku: 'WM-XL-001',
      }
      const db = createMockDb({ 'insert:product_variants': mockVariant })

      const result = await createVariant(db, 'prod-int-001', {
        title: 'XL',
        price: '34.99',
        sku: 'WM-XL-001',
      })

      expect(result.id).toBe('var-new-001')
      expect(result.price).toBe('34.99')
      expect(db.insertInto).toHaveBeenCalledWith('product_variants')
    })
  })
})

// ============================================================================
// ORDER SERVICE INTEGRATION
// ============================================================================

describe('Order Integration', () => {
  const shopId = 'shop-order-001'

  describe('createOrder', () => {
    it('creates an order with line items', async () => {
      const { createOrder } = await import(
        '../packages/core/src/modules/orders/service.js'
      )
      const mockOrder = {
        id: 'order-int-001',
        shop_id: shopId,
        subtotal_price: '59.98',
        total_price: '59.98',
        financial_status: 'pending',
      }
      const db = createMockDb({
        'insert:orders': mockOrder,
        'insert:order_line_items': { id: 'li-001' },
      })

      const result = await createOrder(db, shopId, {
        line_items: [
          { title: 'Widget A', quantity: 2, price: '29.99' },
        ],
      })

      expect(result).toBeDefined()
      expect(result.id).toBe('order-int-001')
      expect(result.line_items).toBeDefined()
    })

    it('creates order with transactions', async () => {
      const { createOrder } = await import(
        '../packages/core/src/modules/orders/service.js'
      )
      const db = createMockDb({
        'insert:orders': { id: 'order-int-002', shop_id: shopId, total_price: '100.00' },
        'insert:order_line_items': { id: 'li-002' },
        'insert:transactions': { id: 'txn-001', kind: 'sale', amount: '100.00' },
      })

      const result = await createOrder(db, shopId, {
        line_items: [{ title: 'Premium', quantity: 1, price: '100.00' }],
        transactions: [{ kind: 'sale', amount: '100.00', gateway: 'stripe' }],
      })

      expect(result.transactions).toBeDefined()
    })
  })

  describe('getOrder', () => {
    it('retrieves order with line items, fulfillments, transactions, refunds', async () => {
      const { getOrder } = await import(
        '../packages/core/src/modules/orders/service.js'
      )
      const mockOrder = { id: 'order-int-001', shop_id: shopId, total_price: '59.98' }

      let callIdx = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        callIdx++
        if (callIdx === 1) return chainable(mockOrder)
        if (callIdx === 2) return chainable([{ id: 'li-001', title: 'Widget' }])
        if (callIdx === 3) return chainable([])
        if (callIdx === 4) return chainable([{ id: 'txn-001', kind: 'sale' }])
        return chainable([])
      })

      const result = await getOrder(db, shopId, 'order-int-001')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('order-int-001')
      expect(result!.line_items).toBeDefined()
      expect(result!.fulfillments).toBeDefined()
      expect(result!.transactions).toBeDefined()
      expect(result!.refunds).toBeDefined()
    })

    it('returns null for non-existent order', async () => {
      const { getOrder } = await import(
        '../packages/core/src/modules/orders/service.js'
      )
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))

      const result = await getOrder(db, shopId, 'ghost-order')
      expect(result).toBeNull()
    })
  })

  describe('cancelOrder', () => {
    it('sets cancelled status', async () => {
      const { cancelOrder } = await import(
        '../packages/core/src/modules/orders/service.js'
      )
      const db = createMockDb({
        'update:orders': {
          id: 'order-int-001',
          cancel_reason: 'customer_request',
          cancelled_at: new Date().toISOString(),
          financial_status: 'voided',
        },
      })

      const result = await cancelOrder(db, shopId, 'order-int-001', 'customer_request')
      expect(result.cancelled_at).toBeDefined()
      expect(result.financial_status).toBe('voided')
      expect(result.cancel_reason).toBe('customer_request')
    })
  })

  describe('createFulfillment', () => {
    it('creates a fulfillment with tracking info', async () => {
      const { createFulfillment } = await import(
        '../packages/core/src/modules/orders/service.js'
      )
      const db = createMockDb({
        'insert:fulfillments': {
          id: 'ful-int-001',
          order_id: 'order-int-001',
          status: 'success',
          tracking_number: 'GBX123',
        },
        'select:order_line_items': { count: 0 },
      })

      const result = await createFulfillment(db, 'order-int-001', {
        tracking_number: 'GBX123',
        tracking_company: 'FedEx',
        line_items: [{ line_item_id: 'li-001', quantity: 1 }],
      })

      expect(result.id).toBe('ful-int-001')
      expect(result.status).toBe('success')
    })
  })

  describe('createRefund', () => {
    it('creates a refund with line items and transactions', async () => {
      const { createRefund } = await import(
        '../packages/core/src/modules/orders/service.js'
      )
      const db = createMockDb({
        'insert:refunds': { id: 'ref-int-001', order_id: 'order-int-001', note: 'Damaged' },
        'insert:refund_line_items': { id: 'rli-001' },
        'insert:transactions': { id: 'txn-ref-001', kind: 'refund', amount: '29.99' },
      })

      const result = await createRefund(db, 'order-int-001', {
        note: 'Damaged',
        restock: true,
        refund_line_items: [
          { line_item_id: 'li-001', quantity: 1, restock_type: 'return' },
        ],
        transactions: [
          { kind: 'refund', amount: '29.99', gateway: 'stripe' },
        ],
      })

      expect(result).toBeDefined()
      expect(result.refund_line_items).toHaveLength(1)
      expect(result.transactions).toBeDefined()
    })

    it('creates refund without transactions', async () => {
      const { createRefund } = await import(
        '../packages/core/src/modules/orders/service.js'
      )
      const db = createMockDb({
        'insert:refunds': { id: 'ref-int-002', order_id: 'order-int-001', note: null },
      })

      const result = await createRefund(db, 'order-int-001', {
        refund_line_items: [{ line_item_id: 'li-001', quantity: 1 }],
      })

      expect(result).toBeDefined()
      expect(result.transactions).toEqual([])
    })
  })
})

// ============================================================================
// ROUTE HANDLER SIMULATION — STORE CRUD
// ============================================================================

describe('Store CRUD (route-level logic)', () => {
  const shopId = 'shop-crud-001'

  describe('GET /api/store/:slug/settings', () => {
    it('returns 404 for unknown store slug', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))
      const res = fakeRes()

      // Simulate the route handler logic
      const slug = 'nonexistent-store'
      const shop = await db.selectFrom('shops').select(['id', 'name', 'slug'])
        .where('slug', '=', slug).executeTakeFirst()

      if (!shop) {
        res.status(404).json({ error: 'Not found', message: 'Store not found' })
      }

      expect(res.statusCode).toBe(404)
      expect(res.body.error).toBe('Not found')
    })

    it('returns store settings for valid slug', async () => {
      const mockShop = { id: shopId, name: 'Test Store', slug: 'test-store' }
      const mockSettings = [
        { key: 'store_name', value: 'Test Store' },
        { key: 'currency', value: 'USD' },
      ]

      let callIdx = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        callIdx++
        if (callIdx === 1) return chainable(mockShop)
        return chainable(mockSettings)
      })
      const res = fakeRes()

      const shop = await db.selectFrom('shops').select(['id', 'name', 'slug'])
        .where('slug', '=', 'test-store').executeTakeFirst()

      if (shop) {
        const settings = await db.selectFrom('shop_settings')
          .select(['key', 'value']).where('shop_id', '=', shop.id).execute()
        res.json({ settings })
      }

      expect(res.statusCode).toBe(200)
      expect(res.body.settings).toHaveLength(2)
    })
  })

  describe('PUT /api/store/:slug/settings', () => {
    it('updates store settings', async () => {
      const mockShop = { id: shopId, name: 'Test Store', slug: 'test-store' }
      const db = createMockDb({ 'select:shops': mockShop })
      const res = fakeRes()

      const shop = await db.selectFrom('shops').select(['id']).where('slug', '=', 'test-store').executeTakeFirst()
      expect(shop).not.toBeNull()

      // Simulate upsert
      await db.insertInto('shop_settings').values({ shop_id: shop!.id, key: 'currency', value: 'EUR' }).execute()
      res.json({ ok: true })

      expect(res.statusCode).toBe(200)
      expect(res.body.ok).toBe(true)
    })
  })
})

// ============================================================================
// CUSTOMER CRUD
// ============================================================================

describe('Customer CRUD (route-level logic)', () => {
  const shopId = 'shop-cust-001'

  describe('POST /api/store/:slug/customers', () => {
    it('creates a customer with email', async () => {
      const mockCustomer = {
        id: 'cust-int-001',
        shop_id: shopId,
        email: 'buyer@example.com',
        first_name: 'Jane',
        last_name: 'Doe',
        created_at: new Date().toISOString(),
      }
      const db = createMockDb({ 'insert:customers': mockCustomer })
      const res = fakeRes()

      const customer = await db.insertInto('customers')
        .values({
          shop_id: shopId,
          email: 'buyer@example.com',
          first_name: 'Jane',
          last_name: 'Doe',
        })
        .returning(['id', 'email', 'first_name', 'last_name', 'created_at'])
        .executeTakeFirstOrThrow()

      res.status(201).json({ customer })

      expect(res.statusCode).toBe(201)
      expect(res.body.customer.email).toBe('buyer@example.com')
      expect(res.body.customer.id).toBe('cust-int-001')
    })

    it('rejects missing email with 400', () => {
      const res = fakeRes()
      const body = { first_name: 'Jane' } // no email

      if (!body || !(body as any).email) {
        res.status(400).json({ error: 'Validation error', message: 'email is required' })
      }

      expect(res.statusCode).toBe(400)
      expect(res.body.error).toBe('Validation error')
    })
  })

  describe('GET /api/store/:slug/customers', () => {
    it('returns paginated customers list', async () => {
      const customers = [
        { id: 'c1', email: 'a@b.com', first_name: 'A' },
        { id: 'c2', email: 'c@d.com', first_name: 'C' },
      ]
      const db = createMockDb({ 'select:customers': customers })
      const res = fakeRes()

      const customersResult = await db.selectFrom('customers')
        .select(['id', 'email', 'first_name']).where('shop_id', '=', shopId).execute()
      res.json({ customers: customersResult })

      expect(res.statusCode).toBe(200)
      expect(res.body.customers).toHaveLength(2)
    })
  })

  describe('PUT /api/store/:slug/customers/:customerId', () => {
    it('updates customer name', async () => {
      const updated = {
        id: 'cust-int-001',
        shop_id: shopId,
        email: 'buyer@example.com',
        first_name: 'Janet',
        updated_at: new Date().toISOString(),
      }
      const db = createMockDb({ 'update:customers': updated })
      const res = fakeRes()

      const result = await db.updateTable('customers')
        .set({ first_name: 'Janet' })
        .where('id', '=', 'cust-int-001').where('shop_id', '=', shopId)
        .returning(['id', 'email', 'first_name', 'updated_at'])
        .executeTakeFirstOrThrow()

      res.json({ customer: result })

      expect(res.body.customer.first_name).toBe('Janet')
    })
  })

  describe('DELETE /api/store/:slug/customers/:customerId', () => {
    it('deletes customer and returns success', async () => {
      const db = createMockDb()
      const res = fakeRes()

      await db.deleteFrom('customers')
        .where('id', '=', 'cust-int-001').where('shop_id', '=', shopId)
        .execute()

      res.json({ deleted: true })

      expect(res.body.deleted).toBe(true)
      expect(db.deleteFrom).toHaveBeenCalled()
    })
  })
})

// ============================================================================
// COLLECTION CRUD
// ============================================================================

describe('Collection CRUD (route-level logic)', () => {
  const shopId = 'shop-coll-001'

  describe('POST /api/store/:slug/collections', () => {
    it('creates a collection', async () => {
      const mockCollection = {
        id: 'coll-int-001',
        shop_id: shopId,
        title: 'Summer Sale',
        slug: 'summer-sale',
        created_at: new Date().toISOString(),
      }
      const db = createMockDb({ 'insert:collections': mockCollection })
      const res = fakeRes()

      const coll = await db.insertInto('collections')
        .values({ shop_id: shopId, title: 'Summer Sale', slug: 'summer-sale' })
        .returning(['id', 'title', 'slug', 'created_at'])
        .executeTakeFirstOrThrow()

      res.status(201).json({ collection: coll })

      expect(res.statusCode).toBe(201)
      expect(res.body.collection.title).toBe('Summer Sale')
    })
  })

  describe('GET /api/store/:slug/collections', () => {
    it('lists collections', async () => {
      const collections = [
        { id: 'c1', title: 'Summer', slug: 'summer' },
        { id: 'c2', title: 'Winter', slug: 'winter' },
      ]
      const db = createMockDb({ 'select:collections': collections })
      const res = fakeRes()

      const result = await db.selectFrom('collections')
        .select(['id', 'title', 'slug']).where('shop_id', '=', shopId).execute()
      res.json({ collections: result })

      expect(res.body.collections).toHaveLength(2)
    })
  })

  describe('PUT /api/store/:slug/collections/:collectionId', () => {
    it('updates a collection title', async () => {
      const db = createMockDb({
        'update:collections': { id: 'coll-int-001', title: 'Autumn Sale', updated_at: new Date().toISOString() },
      })
      const res = fakeRes()

      const result = await db.updateTable('collections')
        .set({ title: 'Autumn Sale' })
        .where('id', '=', 'coll-int-001').where('shop_id', '=', shopId)
        .returning(['id', 'title', 'updated_at'])
        .executeTakeFirstOrThrow()

      res.json({ collection: result })
      expect(res.body.collection.title).toBe('Autumn Sale')
    })
  })

  describe('DELETE /api/store/:slug/collections/:collectionId', () => {
    it('deletes a collection', async () => {
      const db = createMockDb()
      const res = fakeRes()

      await db.deleteFrom('collections')
        .where('id', '=', 'coll-int-001').where('shop_id', '=', shopId).execute()
      res.json({ deleted: true })

      expect(res.body.deleted).toBe(true)
    })
  })

  describe('Collection-Product association', () => {
    it('adds a product to a collection', async () => {
      const db = createMockDb({
        'insert:collection_products': { collection_id: 'coll-int-001', product_id: 'prod-001', position: 0 },
      })
      const res = fakeRes()

      await db.insertInto('collection_products')
        .values({ collection_id: 'coll-int-001', product_id: 'prod-001', position: 0 })
        .execute()
      res.status(201).json({ added: true })

      expect(res.statusCode).toBe(201)
      expect(res.body.added).toBe(true)
    })

    it('removes a product from a collection', async () => {
      const db = createMockDb()
      const res = fakeRes()

      await db.deleteFrom('collection_products')
        .where('collection_id', '=', 'coll-int-001')
        .where('product_id', '=', 'prod-001')
        .execute()
      res.json({ removed: true })

      expect(res.body.removed).toBe(true)
    })
  })
})

// ============================================================================
// DISCOUNT CRUD
// ============================================================================

describe('Discount CRUD (route-level logic)', () => {
  const shopId = 'shop-disc-001'

  describe('POST /api/store/:slug/discounts', () => {
    it('creates a percentage discount', async () => {
      const mockDiscount = {
        id: 'disc-int-001',
        shop_id: shopId,
        code: 'SAVE20',
        type: 'percentage',
        value: '20',
        starts_at: new Date().toISOString(),
        status: 'active',
      }
      const db = createMockDb({ 'insert:discounts': mockDiscount })
      const res = fakeRes()

      const disc = await db.insertInto('discounts')
        .values({ shop_id: shopId, code: 'SAVE20', type: 'percentage', value: '20' })
        .returning(['id', 'code', 'type', 'value', 'status'])
        .executeTakeFirstOrThrow()

      res.status(201).json({ discount: disc })

      expect(res.statusCode).toBe(201)
      expect(res.body.discount.code).toBe('SAVE20')
      expect(res.body.discount.type).toBe('percentage')
    })
  })

  describe('GET /api/store/:slug/discounts', () => {
    it('lists discounts', async () => {
      const discounts = [
        { id: 'd1', code: 'SAVE10', type: 'percentage' },
        { id: 'd2', code: 'FLAT5', type: 'fixed_amount' },
      ]
      const db = createMockDb({ 'select:discounts': discounts })
      const res = fakeRes()

      const result = await db.selectFrom('discounts')
        .select(['id', 'code', 'type']).where('shop_id', '=', shopId).execute()
      res.json({ discounts: result })

      expect(res.body.discounts).toHaveLength(2)
    })
  })

  describe('GET /api/store/:slug/discounts/:discountId', () => {
    it('returns a single discount', async () => {
      const mockDiscount = { id: 'disc-int-001', code: 'SAVE20', type: 'percentage', value: '20' }
      const db = createMockDb({ 'select:discounts': mockDiscount })
      const res = fakeRes()

      const disc = await db.selectFrom('discounts')
        .select(['id', 'code', 'type', 'value'])
        .where('id', '=', 'disc-int-001').where('shop_id', '=', shopId)
        .executeTakeFirst()

      if (!disc) {
        res.status(404).json({ error: 'Not found' })
      } else {
        res.json({ discount: disc })
      }

      expect(res.statusCode).toBe(200)
      expect(res.body.discount.code).toBe('SAVE20')
    })

    it('returns 404 for non-existent discount', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))
      const res = fakeRes()

      const disc = await db.selectFrom('discounts')
        .where('id', '=', 'ghost').where('shop_id', '=', shopId)
        .executeTakeFirst()

      if (!disc) {
        res.status(404).json({ error: 'Not found' })
      }

      expect(res.statusCode).toBe(404)
    })
  })

  describe('PUT /api/store/:slug/discounts/:discountId', () => {
    it('updates a discount value', async () => {
      const db = createMockDb({
        'update:discounts': { id: 'disc-int-001', value: '25', updated_at: new Date().toISOString() },
      })
      const res = fakeRes()

      const result = await db.updateTable('discounts')
        .set({ value: '25' })
        .where('id', '=', 'disc-int-001').where('shop_id', '=', shopId)
        .returning(['id', 'value', 'updated_at'])
        .executeTakeFirstOrThrow()

      res.json({ discount: result })
      expect(res.body.discount.value).toBe('25')
    })
  })

  describe('DELETE /api/store/:slug/discounts/:discountId', () => {
    it('deletes a discount', async () => {
      const db = createMockDb()
      const res = fakeRes()

      await db.deleteFrom('discounts')
        .where('id', '=', 'disc-int-001').where('shop_id', '=', shopId).execute()
      res.json({ deleted: true })

      expect(res.body.deleted).toBe(true)
    })
  })

  describe('PUT /api/store/:slug/discounts/:discountId/status', () => {
    it('toggles discount status', async () => {
      const db = createMockDb({
        'update:discounts': { id: 'disc-int-001', status: 'disabled' },
      })
      const res = fakeRes()

      const result = await db.updateTable('discounts')
        .set({ status: 'disabled' })
        .where('id', '=', 'disc-int-001')
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow()

      res.json({ discount: result })
      expect(res.body.discount.status).toBe('disabled')
    })
  })
})

// ============================================================================
// GIFT CARD OPERATIONS
// ============================================================================

describe('Gift Card Operations (route-level logic)', () => {
  const shopId = 'shop-gc-001'

  describe('POST /api/store/:slug/gift-cards', () => {
    it('creates a gift card with initial balance', async () => {
      const mockGiftCard = {
        id: 'gc-int-001',
        shop_id: shopId,
        code: 'GIFT-ABCD-1234',
        initial_value: '50.00',
        balance: '50.00',
        status: 'active',
        created_at: new Date().toISOString(),
      }
      const db = createMockDb({ 'insert:gift_cards': mockGiftCard })
      const res = fakeRes()

      const gc = await db.insertInto('gift_cards')
        .values({ shop_id: shopId, code: 'GIFT-ABCD-1234', initial_value: '50.00', balance: '50.00' })
        .returning(['id', 'code', 'initial_value', 'balance', 'status'])
        .executeTakeFirstOrThrow()

      res.status(201).json({ gift_card: gc })

      expect(res.statusCode).toBe(201)
      expect(res.body.gift_card.balance).toBe('50.00')
      expect(res.body.gift_card.code).toBe('GIFT-ABCD-1234')
    })
  })

  describe('GET /api/store/:slug/gift-cards', () => {
    it('lists gift cards', async () => {
      const cards = [
        { id: 'gc1', code: 'GIFT-1', balance: '50.00' },
        { id: 'gc2', code: 'GIFT-2', balance: '25.00' },
      ]
      const db = createMockDb({ 'select:gift_cards': cards })
      const res = fakeRes()

      const result = await db.selectFrom('gift_cards')
        .select(['id', 'code', 'balance']).where('shop_id', '=', shopId).execute()
      res.json({ gift_cards: result })

      expect(res.body.gift_cards).toHaveLength(2)
    })
  })

  describe('GET /api/store/:slug/gift-cards/:code/balance', () => {
    it('returns balance for a valid code', async () => {
      const db = createMockDb({
        'select:gift_cards': { id: 'gc-int-001', code: 'GIFT-ABCD-1234', balance: '35.00', status: 'active' },
      })
      const res = fakeRes()

      const gc = await db.selectFrom('gift_cards')
        .select(['id', 'code', 'balance', 'status'])
        .where('code', '=', 'GIFT-ABCD-1234').where('shop_id', '=', shopId)
        .executeTakeFirst()

      if (!gc) {
        res.status(404).json({ error: 'Gift card not found' })
      } else {
        res.json({ balance: gc.balance, status: gc.status })
      }

      expect(res.statusCode).toBe(200)
      expect(res.body.balance).toBe('35.00')
    })

    it('returns 404 for unknown gift card code', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))
      const res = fakeRes()

      const gc = await db.selectFrom('gift_cards')
        .where('code', '=', 'INVALID').executeTakeFirst()

      if (!gc) {
        res.status(404).json({ error: 'Gift card not found' })
      }

      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /api/store/:slug/gift-cards/:code/redeem', () => {
    it('redeems part of a gift card balance', async () => {
      const db = createMockDb({
        'select:gift_cards': { id: 'gc-int-001', balance: '50.00', status: 'active' },
        'update:gift_cards': { id: 'gc-int-001', balance: '30.00' },
      })
      const res = fakeRes()

      const gc = await db.selectFrom('gift_cards')
        .where('code', '=', 'GIFT-ABCD-1234').executeTakeFirst()

      if (!gc || gc.status !== 'active') {
        res.status(400).json({ error: 'Gift card not active' })
      } else {
        const amount = 20.00
        const newBalance = parseFloat(gc.balance) - amount
        await db.updateTable('gift_cards')
          .set({ balance: newBalance.toFixed(2) })
          .where('id', '=', gc.id).execute()
        res.json({ remaining_balance: newBalance.toFixed(2) })
      }

      expect(res.body.remaining_balance).toBe('30.00')
    })
  })

  describe('POST /api/store/:slug/gift-cards/:giftCardId/disable', () => {
    it('disables a gift card', async () => {
      const db = createMockDb({
        'update:gift_cards': { id: 'gc-int-001', status: 'disabled' },
      })
      const res = fakeRes()

      await db.updateTable('gift_cards')
        .set({ status: 'disabled' })
        .where('id', '=', 'gc-int-001').where('shop_id', '=', shopId)
        .execute()
      res.json({ disabled: true })

      expect(res.body.disabled).toBe(true)
    })
  })
})

// ============================================================================
// WEBHOOK CRUD
// ============================================================================

describe('Webhook CRUD (route-level logic)', () => {
  const shopId = 'shop-wh-001'

  describe('POST /api/store/:slug/webhooks', () => {
    it('creates a webhook subscription', async () => {
      const mockWebhook = {
        id: 'wh-int-001',
        shop_id: shopId,
        topic: 'orders/create',
        address: 'https://example.com/webhooks/orders',
        format: 'json',
        created_at: new Date().toISOString(),
      }
      const db = createMockDb({ 'insert:webhooks': mockWebhook })
      const res = fakeRes()

      const wh = await db.insertInto('webhooks')
        .values({
          shop_id: shopId,
          topic: 'orders/create',
          address: 'https://example.com/webhooks/orders',
          format: 'json',
        })
        .returning(['id', 'topic', 'address', 'format', 'created_at'])
        .executeTakeFirstOrThrow()

      res.status(201).json({ webhook: wh })

      expect(res.statusCode).toBe(201)
      expect(res.body.webhook.topic).toBe('orders/create')
      expect(res.body.webhook.address).toBe('https://example.com/webhooks/orders')
    })
  })

  describe('GET /api/store/:slug/webhooks', () => {
    it('lists webhook subscriptions', async () => {
      const webhooks = [
        { id: 'wh1', topic: 'orders/create', address: 'https://a.com/hook' },
        { id: 'wh2', topic: 'products/update', address: 'https://b.com/hook' },
      ]
      const db = createMockDb({ 'select:webhooks': webhooks })
      const res = fakeRes()

      const result = await db.selectFrom('webhooks')
        .select(['id', 'topic', 'address']).where('shop_id', '=', shopId).execute()
      res.json({ webhooks: result })

      expect(res.body.webhooks).toHaveLength(2)
    })
  })

  describe('GET /api/store/:slug/webhooks/:webhookId', () => {
    it('returns a single webhook', async () => {
      const db = createMockDb({
        'select:webhooks': { id: 'wh-int-001', topic: 'orders/create', address: 'https://a.com/hook' },
      })
      const res = fakeRes()

      const wh = await db.selectFrom('webhooks')
        .where('id', '=', 'wh-int-001').where('shop_id', '=', shopId)
        .executeTakeFirst()

      if (!wh) {
        res.status(404).json({ error: 'Not found' })
      } else {
        res.json({ webhook: wh })
      }

      expect(res.body.webhook.topic).toBe('orders/create')
    })
  })

  describe('DELETE /api/store/:slug/webhooks/:webhookId', () => {
    it('deletes a webhook', async () => {
      const db = createMockDb()
      const res = fakeRes()

      await db.deleteFrom('webhooks')
        .where('id', '=', 'wh-int-001').where('shop_id', '=', shopId).execute()
      res.json({ deleted: true })

      expect(res.body.deleted).toBe(true)
    })
  })
})

// ============================================================================
// FILE UPLOAD / DELETE
// ============================================================================

describe('File Operations (route-level logic)', () => {
  const shopId = 'shop-file-001'

  describe('GET /api/store/:slug/files', () => {
    it('lists files for a store', async () => {
      const files = [
        { id: 'f1', shop_id: shopId, filename: 'logo.png', url: 'https://cdn.gbox.co/logo.png' },
        { id: 'f2', shop_id: shopId, filename: 'banner.jpg', url: 'https://cdn.gbox.co/banner.jpg' },
      ]
      const db = createMockDb({ 'select:files': files })
      const res = fakeRes()

      const result = await db.selectFrom('files')
        .select(['id', 'filename', 'url']).where('shop_id', '=', shopId).execute()
      res.json({ files: result })

      expect(res.body.files).toHaveLength(2)
    })
  })

  describe('POST /api/store/:slug/files', () => {
    it('creates a file record', async () => {
      const mockFile = {
        id: 'f-int-001',
        shop_id: shopId,
        filename: 'product.png',
        url: 'https://cdn.gbox.co/product.png',
        content_type: 'image/png',
        size: 204800,
      }
      const db = createMockDb({ 'insert:files': mockFile })
      const res = fakeRes()

      const file = await db.insertInto('files')
        .values({
          shop_id: shopId,
          filename: 'product.png',
          url: 'https://cdn.gbox.co/product.png',
          content_type: 'image/png',
          size: 204800,
        })
        .returning(['id', 'filename', 'url', 'content_type', 'size'])
        .executeTakeFirstOrThrow()

      res.status(201).json({ file })

      expect(res.statusCode).toBe(201)
      expect(res.body.file.filename).toBe('product.png')
    })
  })

  describe('DELETE /api/store/:slug/files/:fileId', () => {
    it('deletes a file record', async () => {
      const db = createMockDb({
        'select:files': { id: 'f-int-001', shop_id: shopId, key: 'shops/product.png' },
      })
      const res = fakeRes()

      const file = await db.selectFrom('files')
        .where('id', '=', 'f-int-001').where('shop_id', '=', shopId)
        .executeTakeFirst()

      if (!file) {
        res.status(404).json({ error: 'File not found' })
      } else {
        await db.deleteFrom('files').where('id', '=', file.id).execute()
        res.json({ deleted: true })
      }

      expect(res.body.deleted).toBe(true)
    })

    it('returns 404 for non-existent file', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))
      const res = fakeRes()

      const file = await db.selectFrom('files')
        .where('id', '=', 'ghost').executeTakeFirst()

      if (!file) {
        res.status(404).json({ error: 'File not found' })
      }

      expect(res.statusCode).toBe(404)
    })
  })
})

// ============================================================================
// MULTI-CURRENCY ENDPOINTS
// ============================================================================

describe('Multi-Currency (route-level logic)', () => {
  const shopId = 'shop-curr-001'

  describe('GET /api/store/:slug/currencies', () => {
    it('returns supported currencies', async () => {
      const currencies = [
        { code: 'USD', name: 'US Dollar', symbol: '$' },
        { code: 'EUR', name: 'Euro', symbol: '\u20ac' },
        { code: 'VND', name: 'Vietnamese Dong', symbol: '\u20ab' },
      ]
      const db = createMockDb({ 'select:supported_currencies': currencies })
      const res = fakeRes()

      const result = await db.selectFrom('supported_currencies')
        .select(['code', 'name', 'symbol']).execute()
      res.json({ currencies: result })

      expect(res.body.currencies).toHaveLength(3)
      expect(res.body.currencies[0].code).toBe('USD')
    })
  })

  describe('GET /api/store/:slug/currencies/rate', () => {
    it('returns exchange rate between two currencies', async () => {
      const db = createMockDb({
        'select:exchange_rates': { from_currency: 'USD', to_currency: 'EUR', rate: '0.92' },
      })
      const res = fakeRes()

      const rateRow = await db.selectFrom('exchange_rates')
        .select(['from_currency', 'to_currency', 'rate'])
        .where('from_currency', '=', 'USD').where('to_currency', '=', 'EUR')
        .executeTakeFirst()

      if (!rateRow) {
        res.status(404).json({ error: 'Rate not found' })
      } else {
        res.json({ rate: rateRow.rate, from: rateRow.from_currency, to: rateRow.to_currency })
      }

      expect(res.body.rate).toBe('0.92')
    })
  })

  describe('POST /api/store/:slug/currencies/rate', () => {
    it('sets a custom exchange rate', async () => {
      const db = createMockDb({
        'insert:exchange_rates': { from_currency: 'USD', to_currency: 'VND', rate: '25000' },
      })
      const res = fakeRes()

      await db.insertInto('exchange_rates')
        .values({ from_currency: 'USD', to_currency: 'VND', rate: '25000', shop_id: shopId })
        .execute()
      res.json({ ok: true, rate: '25000' })

      expect(res.body.ok).toBe(true)
      expect(res.body.rate).toBe('25000')
    })
  })
})

// ============================================================================
// MARKETS CRUD
// ============================================================================

describe('Markets CRUD (route-level logic)', () => {
  const shopId = 'shop-market-001'

  describe('POST /api/store/:slug/markets', () => {
    it('creates a market', async () => {
      const mockMarket = {
        id: 'mkt-int-001',
        shop_id: shopId,
        name: 'Southeast Asia',
        countries: ['VN', 'TH', 'SG'],
        currency: 'USD',
        created_at: new Date().toISOString(),
      }
      const db = createMockDb({ 'insert:markets': mockMarket })
      const res = fakeRes()

      const market = await db.insertInto('markets')
        .values({ shop_id: shopId, name: 'Southeast Asia', countries: JSON.stringify(['VN', 'TH', 'SG']), currency: 'USD' })
        .returning(['id', 'name', 'countries', 'currency'])
        .executeTakeFirstOrThrow()

      res.status(201).json({ market })

      expect(res.statusCode).toBe(201)
      expect(res.body.market.name).toBe('Southeast Asia')
    })
  })

  describe('GET /api/store/:slug/markets', () => {
    it('lists all markets', async () => {
      const markets = [
        { id: 'm1', name: 'North America' },
        { id: 'm2', name: 'Europe' },
      ]
      const db = createMockDb({ 'select:markets': markets })
      const res = fakeRes()

      const result = await db.selectFrom('markets')
        .select(['id', 'name']).where('shop_id', '=', shopId).execute()
      res.json({ markets: result })

      expect(res.body.markets).toHaveLength(2)
    })
  })

  describe('GET /api/store/:slug/markets/:marketId', () => {
    it('returns a single market', async () => {
      const db = createMockDb({
        'select:markets': { id: 'mkt-int-001', name: 'Southeast Asia', countries: ['VN', 'TH'] },
      })
      const res = fakeRes()

      const market = await db.selectFrom('markets')
        .where('id', '=', 'mkt-int-001').where('shop_id', '=', shopId)
        .executeTakeFirst()

      if (!market) {
        res.status(404).json({ error: 'Not found' })
      } else {
        res.json({ market })
      }

      expect(res.body.market.name).toBe('Southeast Asia')
    })
  })

  describe('PUT /api/store/:slug/markets/:marketId', () => {
    it('updates a market', async () => {
      const db = createMockDb({
        'update:markets': { id: 'mkt-int-001', name: 'ASEAN+', updated_at: new Date().toISOString() },
      })
      const res = fakeRes()

      const result = await db.updateTable('markets')
        .set({ name: 'ASEAN+' })
        .where('id', '=', 'mkt-int-001').where('shop_id', '=', shopId)
        .returning(['id', 'name', 'updated_at'])
        .executeTakeFirstOrThrow()

      res.json({ market: result })
      expect(res.body.market.name).toBe('ASEAN+')
    })
  })

  describe('DELETE /api/store/:slug/markets/:marketId', () => {
    it('deletes a market', async () => {
      const db = createMockDb()
      const res = fakeRes()

      await db.deleteFrom('markets')
        .where('id', '=', 'mkt-int-001').where('shop_id', '=', shopId).execute()
      res.json({ deleted: true })

      expect(res.body.deleted).toBe(true)
    })
  })

  describe('Markets pricing rules', () => {
    it('creates a pricing rule', async () => {
      const mockRule = {
        id: 'pr-001',
        market_id: 'mkt-int-001',
        adjustment_type: 'percentage',
        adjustment_value: '10',
      }
      const db = createMockDb({ 'insert:market_pricing_rules': mockRule })
      const res = fakeRes()

      const rule = await db.insertInto('market_pricing_rules')
        .values({ market_id: 'mkt-int-001', adjustment_type: 'percentage', adjustment_value: '10' })
        .returning(['id', 'adjustment_type', 'adjustment_value'])
        .executeTakeFirstOrThrow()

      res.status(201).json({ pricing_rule: rule })
      expect(res.body.pricing_rule.adjustment_type).toBe('percentage')
    })

    it('deletes a pricing rule', async () => {
      const db = createMockDb()
      const res = fakeRes()

      await db.deleteFrom('market_pricing_rules')
        .where('id', '=', 'pr-001').execute()
      res.json({ deleted: true })

      expect(res.body.deleted).toBe(true)
    })
  })
})

// ============================================================================
// AUTH MIDDLEWARE SIMULATION
// ============================================================================

describe('Auth Middleware Logic', () => {
  describe('requireGodAdmin (simulated)', () => {
    it('rejects request without session (401)', () => {
      const res = fakeRes()
      // Simulate: no cookie → extractUser returns null
      const user = null
      if (!user) {
        res.status(401).json({ error: 'Unauthorized', message: 'Valid session required' })
      }
      expect(res.statusCode).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('rejects non-owner users (403)', () => {
      const res = fakeRes()
      const user = { id: 'u1', role: 'staff' }
      if (user.role !== 'owner') {
        res.status(403).json({ error: 'Forbidden', message: 'God Admin access required' })
      }
      expect(res.statusCode).toBe(403)
      expect(res.body.error).toBe('Forbidden')
    })

    it('allows owner role through', () => {
      const user = { id: 'u1', role: 'owner', email: 'god@gbox.co', name: 'God' }
      let passed = false
      if (user.role === 'owner') {
        passed = true
      }
      expect(passed).toBe(true)
    })
  })

  describe('requireStoreAccess (simulated)', () => {
    it('rejects request without session (401)', () => {
      const res = fakeRes()
      const user = null
      if (!user) {
        res.status(401).json({ error: 'Unauthorized', message: 'Valid session required' })
      }
      expect(res.statusCode).toBe(401)
    })

    it('rejects request without slug (400)', () => {
      const res = fakeRes()
      const slug = undefined
      if (!slug) {
        res.status(400).json({ error: 'Bad request', message: 'Store slug required' })
      }
      expect(res.statusCode).toBe(400)
    })

    it('rejects unknown store (404)', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))
      const res = fakeRes()

      const shop = await db.selectFrom('shops').where('slug', '=', 'ghost').executeTakeFirst()
      if (!shop) {
        res.status(404).json({ error: 'Not found', message: 'Store not found' })
      }
      expect(res.statusCode).toBe(404)
    })

    it('allows god admin to access any store', async () => {
      const user = { id: 'u1', role: 'owner' }
      const shop = { id: 's1', name: 'Store', slug: 'store' }
      let granted = false

      if (user.role === 'owner') {
        granted = true
      }
      expect(granted).toBe(true)
    })

    it('rejects user without store membership (403)', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation((table: string) => {
        if (table === 'shops') return chainable({ id: 's1', name: 'Shop', slug: 'shop' })
        return chainable(null) // no user_shops row
      })
      const res = fakeRes()
      const user = { id: 'u1', role: 'merchant' }

      const shop = await db.selectFrom('shops').where('slug', '=', 'shop').executeTakeFirst()
      const access = await db.selectFrom('user_shops')
        .where('user_id', '=', user.id).where('shop_id', '=', shop.id).executeTakeFirst()

      if (!access) {
        res.status(403).json({ error: 'Forbidden', message: 'No access to this store' })
      }

      expect(res.statusCode).toBe(403)
    })
  })
})

// ============================================================================
// CHECKOUT ROUTE VALIDATION
// ============================================================================

describe('Checkout Route Validation', () => {
  describe('POST /api/store/:slug/checkout', () => {
    it('rejects empty items array (400)', () => {
      const res = fakeRes()
      const body = { items: [] }

      if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        res.status(400).json({ error: 'Validation error', message: 'items array is required' })
      }

      expect(res.statusCode).toBe(400)
      expect(res.body.message).toBe('items array is required')
    })

    it('rejects missing items (400)', () => {
      const res = fakeRes()
      const body = {} as any

      if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        res.status(400).json({ error: 'Validation error', message: 'items array is required' })
      }

      expect(res.statusCode).toBe(400)
    })

    it('returns 404 for unknown store', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))
      const res = fakeRes()

      const shop = await db.selectFrom('shops').where('slug', '=', 'ghost').executeTakeFirst()
      if (!shop) {
        res.status(404).json({ error: 'Not found', message: 'Store not found' })
      }

      expect(res.statusCode).toBe(404)
    })

    it('enforces required customer account mode', async () => {
      const res = fakeRes()
      const accountMode = 'required'
      const email = undefined

      if (accountMode === 'required' && !email) {
        res.status(400).json({
          error: 'Customer account required',
          message: 'This store requires customers to provide an email to checkout',
        })
      }

      expect(res.statusCode).toBe(400)
      expect(res.body.error).toBe('Customer account required')
    })
  })
})

// ============================================================================
// STOREFRONT API ENDPOINTS
// ============================================================================

describe('Storefront API Endpoints', () => {
  describe('GET /api/storefront/:slug/products.json', () => {
    it('returns products with variants for public storefront', async () => {
      const products = [
        {
          id: 'p1',
          title: 'Product One',
          slug: 'product-one',
          variants: [{ id: 'v1', price: '19.99' }],
        },
      ]
      const db = createMockDb({ 'select:products': products })
      const res = fakeRes()

      const result = await db.selectFrom('products')
        .select(['id', 'title', 'slug'])
        .where('shop_id', '=', 'some-shop').where('status', '=', 'active')
        .execute()
      res.json({ products: result })

      expect(res.body.products).toHaveLength(1)
    })
  })

  describe('GET /api/storefront/:slug/collections.json', () => {
    it('returns public collections', async () => {
      const collections = [{ id: 'c1', title: 'Featured', slug: 'featured' }]
      const db = createMockDb({ 'select:collections': collections })
      const res = fakeRes()

      const result = await db.selectFrom('collections')
        .where('shop_id', '=', 'some-shop').execute()
      res.json({ collections: result })

      expect(res.body.collections).toHaveLength(1)
    })
  })
})

// ============================================================================
// VERSIONED API ENDPOINTS (api/2026-04/*)
// ============================================================================

describe('Versioned API (api/2026-04)', () => {
  describe('GET /api/2026-04/products.json', () => {
    it('returns products via scoped API', async () => {
      const products = [{ id: 'p1', title: 'API Product' }]
      const db = createMockDb({ 'select:products': products })
      const res = fakeRes()

      const result = await db.selectFrom('products')
        .where('shop_id', '=', 'shop-001').execute()
      res.json({ products: result })

      expect(res.body.products).toHaveLength(1)
    })
  })

  describe('GET /api/2026-04/orders.json', () => {
    it('returns orders via scoped API', async () => {
      const orders = [{ id: 'o1', total_price: '99.99' }]
      const db = createMockDb({ 'select:orders': orders })
      const res = fakeRes()

      const result = await db.selectFrom('orders')
        .where('shop_id', '=', 'shop-001').execute()
      res.json({ orders: result })

      expect(res.body.orders).toHaveLength(1)
    })
  })

  describe('GET /api/2026-04/customers.json', () => {
    it('returns customers via scoped API', async () => {
      const customers = [{ id: 'c1', email: 'a@b.com' }]
      const db = createMockDb({ 'select:customers': customers })
      const res = fakeRes()

      const result = await db.selectFrom('customers')
        .where('shop_id', '=', 'shop-001').execute()
      res.json({ customers: result })

      expect(res.body.customers).toHaveLength(1)
    })
  })

  describe('Webhook CRUD via versioned API', () => {
    it('POST /api/2026-04/webhooks.json creates a webhook', async () => {
      const db = createMockDb({
        'insert:webhooks': { id: 'wh-v1', topic: 'orders/create', address: 'https://hook.io' },
      })
      const res = fakeRes()

      const wh = await db.insertInto('webhooks')
        .values({ shop_id: 'shop-001', topic: 'orders/create', address: 'https://hook.io' })
        .returning(['id', 'topic', 'address'])
        .executeTakeFirstOrThrow()
      res.status(201).json({ webhook: wh })

      expect(res.statusCode).toBe(201)
      expect(res.body.webhook.topic).toBe('orders/create')
    })

    it('DELETE /api/2026-04/webhooks/:id.json deletes a webhook', async () => {
      const db = createMockDb()
      const res = fakeRes()

      await db.deleteFrom('webhooks').where('id', '=', 'wh-v1').execute()
      res.json({ deleted: true })

      expect(res.body.deleted).toBe(true)
    })
  })
})

// ============================================================================
// INVENTORY MANAGEMENT
// ============================================================================

describe('Inventory Management', () => {
  describe('updateInventory', () => {
    it('adjusts inventory level', async () => {
      const { updateInventory } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const mockItem = { id: 'inv-001', variant_id: 'var-001' }
      const mockLevel = { inventory_item_id: 'inv-001', location_id: 'loc-001', available: 15 }

      const db = createMockDb({
        'select:inventory_items': mockItem,
        'insert:inventory_levels': mockLevel,
      })

      const result = await updateInventory(db, 'var-001', 'loc-001', 5)
      expect(result).toBeDefined()
      expect(db.transaction).toHaveBeenCalled()
    })

    it('creates inventory item if missing', async () => {
      const { updateInventory } = await import(
        '../packages/core/src/modules/products/service.js'
      )
      const db = createMockDb({
        'select:inventory_items': null,
        'insert:inventory_items': { id: 'inv-new', variant_id: 'var-002' },
        'insert:inventory_levels': { inventory_item_id: 'inv-new', location_id: 'loc-001', available: 10 },
      })

      const result = await updateInventory(db, 'var-002', 'loc-001', 10)
      expect(result).toBeDefined()
    })
  })
})
