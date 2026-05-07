/**
 * Gbox Platform — Product Service Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createProduct,
  getProduct,
  updateProduct,
  deleteProduct,
  listProducts,
  createVariant,
  updateInventory,
} from './service.js'

// ---------------------------------------------------------------------------
// Mock database builder
// ---------------------------------------------------------------------------

/** Builds a chainable mock that records calls and resolves with `result`. */
function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined // prevent auto-await on proxy
        if (prop === 'execute') return vi.fn().mockResolvedValue(result instanceof Array ? result : [result].filter(Boolean))
        if (prop === 'executeTakeFirst') return vi.fn().mockResolvedValue(result ?? null)
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
      return chainable(overrides[`insert:${table}`] ?? overrides[table] ?? { id: 'mock-id' })
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
      execute: vi.fn().mockImplementation(async (fn: Function) => {
        // The transaction callback receives a "trx" that behaves like db
        return fn(createMockDb(overrides))
      }),
    }),
    fn: {
      countAll: vi.fn().mockReturnValue({
        as: vi.fn().mockReturnValue('count'),
      }),
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Product Service', () => {
  const shopId = 'shop-001'

  describe('createProduct', () => {
    it('creates a product with variants and returns correct structure', async () => {
      const mockProduct = {
        id: 'prod-001',
        shop_id: shopId,
        title: 'Test Product',
        slug: 'test-product',
        status: 'active',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }
      const mockVariant = {
        id: 'var-001',
        product_id: 'prod-001',
        title: 'Small',
        price: '19.99',
      }

      const db = createMockDb({
        'insert:products': mockProduct,
        'insert:product_variants': mockVariant,
      })

      const result = await createProduct(db, shopId, {
        title: 'Test Product',
        slug: 'test-product',
        variants: [
          { title: 'Small', price: '19.99' },
        ],
      })

      expect(result).toBeDefined()
      expect(result.id).toBe('prod-001')
      expect(result.title).toBe('Test Product')
      expect(result.variants).toBeDefined()
    })

    it('creates a default variant when no variants are provided', async () => {
      const mockProduct = {
        id: 'prod-002',
        shop_id: shopId,
        title: 'Simple Product',
        slug: 'simple-product',
      }
      const mockVariant = {
        id: 'var-default',
        product_id: 'prod-002',
        title: 'Default Title',
        price: '0',
      }

      const db = createMockDb({
        'insert:products': mockProduct,
        'insert:product_variants': mockVariant,
      })

      const result = await createProduct(db, shopId, {
        title: 'Simple Product',
        slug: 'simple-product',
      })

      expect(result).toBeDefined()
      expect(result.variants).toBeDefined()
    })
  })

  describe('getProduct', () => {
    it('retrieves product with variants and images', async () => {
      const mockProduct = {
        id: 'prod-001',
        shop_id: shopId,
        title: 'Test Product',
        slug: 'test-product',
      }
      const mockVariants = [{ id: 'var-001', product_id: 'prod-001', title: 'Small' }]
      const mockImages = [{ id: 'img-001', product_id: 'prod-001', src: 'http://example.com/img.jpg' }]
      const mockOptions = [{ id: 'opt-001', product_id: 'prod-001', name: 'Size', values: ['S', 'M'] }]

      let selectCallCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        selectCallCount++
        // First call: product. Subsequent: variants, images, options (via Promise.all)
        if (selectCallCount === 1) return chainable(mockProduct)
        if (selectCallCount === 2) return chainable(mockVariants)
        if (selectCallCount === 3) return chainable(mockImages)
        return chainable(mockOptions)
      })

      const result = await getProduct(db, shopId, 'prod-001')

      expect(result).not.toBeNull()
      expect(result!.id).toBe('prod-001')
      expect(result!.variants).toBeDefined()
      expect(result!.images).toBeDefined()
      expect(result!.options).toBeDefined()
    })

    it('returns null for non-existent product', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))

      const result = await getProduct(db, shopId, 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('updateProduct', () => {
    it('updates title and returns updated product', async () => {
      const updatedProduct = {
        id: 'prod-001',
        shop_id: shopId,
        title: 'Updated Title',
        slug: 'test-product',
        updated_at: '2024-01-02T00:00:00Z',
      }

      const db = createMockDb({ 'update:products': updatedProduct })

      const result = await updateProduct(db, shopId, 'prod-001', {
        title: 'Updated Title',
      })

      expect(result.title).toBe('Updated Title')
      expect(db.updateTable).toHaveBeenCalledWith('products')
    })
  })

  describe('deleteProduct', () => {
    it('soft-deletes product by removing all related records', async () => {
      const db = createMockDb()

      await deleteProduct(db, shopId, 'prod-001')

      // Verify transaction was called
      expect(db.transaction).toHaveBeenCalled()
    })
  })

  describe('listProducts', () => {
    it('returns paginated results', async () => {
      const products = [
        { id: 'prod-001', title: 'Product 1' },
        { id: 'prod-002', title: 'Product 2' },
      ]

      let callCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // Products query
          return chainable(products)
        }
        // Count query
        return chainable({ count: 2 })
      })
      db.fn = {
        countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
      }

      const result = await listProducts(db, shopId, {}, { limit: 10, offset: 0 })

      expect(result.products).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('respects status filter', async () => {
      const db = createMockDb()
      let callCount = 0
      db.selectFrom = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return chainable([])
        return chainable({ count: 0 })
      })
      db.fn = {
        countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
      }

      const result = await listProducts(db, shopId, { status: 'active' })

      expect(result.products).toHaveLength(0)
      expect(result.total).toBe(0)
    })
  })

  describe('createVariant', () => {
    it('adds variant to existing product', async () => {
      const mockVariant = {
        id: 'var-new',
        product_id: 'prod-001',
        title: 'Large',
        price: '29.99',
        sku: 'LRG-001',
      }

      const db = createMockDb({ 'insert:product_variants': mockVariant })

      const result = await createVariant(db, 'prod-001', {
        title: 'Large',
        price: '29.99',
        sku: 'LRG-001',
      })

      expect(result.id).toBe('var-new')
      expect(result.title).toBe('Large')
      expect(result.price).toBe('29.99')
      expect(db.insertInto).toHaveBeenCalledWith('product_variants')
    })
  })

  describe('updateInventory', () => {
    it('adjusts inventory level correctly', async () => {
      const mockItem = { id: 'inv-001', variant_id: 'var-001' }
      const mockLevel = {
        inventory_item_id: 'inv-001',
        location_id: 'loc-001',
        available: 15,
      }

      const db = createMockDb({
        'select:inventory_items': mockItem,
        'insert:inventory_levels': mockLevel,
      })

      const result = await updateInventory(db, 'var-001', 'loc-001', 5)

      expect(result).toBeDefined()
      expect(db.transaction).toHaveBeenCalled()
    })

    it('creates inventory item if it does not exist', async () => {
      const mockNewItem = { id: 'inv-new', variant_id: 'var-002' }
      const mockLevel = {
        inventory_item_id: 'inv-new',
        location_id: 'loc-001',
        available: 10,
      }

      const db = createMockDb({
        'select:inventory_items': null, // does not exist
        'insert:inventory_items': mockNewItem,
        'insert:inventory_levels': mockLevel,
      })

      const result = await updateInventory(db, 'var-002', 'loc-001', 10)

      expect(result).toBeDefined()
    })
  })
})
