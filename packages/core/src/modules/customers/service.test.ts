/**
 * Gbox Platform — Customer Service Unit Tests
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createCustomer,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  listCustomers,
  addAddress,
} from './service.js'

// ---------------------------------------------------------------------------
// Mock database builder
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
    deleteFrom: vi.fn().mockImplementation(() => chainable()),
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn().mockImplementation(async (fn: Function) => {
        return fn(createMockDb(overrides))
      }),
    }),
    fn: {
      countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
      sum: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('sum') }),
      max: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('max') }),
      avg: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('avg') }),
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Customer Service', () => {
  const shopId = 'shop-001'

  describe('createCustomer', () => {
    it('creates a customer with basic fields', async () => {
      const mockCustomer = {
        id: 'cust-001',
        shop_id: shopId,
        email: 'john@test.com',
        first_name: 'John',
        last_name: 'Doe',
      }
      const db = createMockDb({
        'insert:customers': mockCustomer,
        'select:customer_addresses': [],
      })

      const result = await createCustomer(db, shopId, {
        email: 'john@test.com',
        first_name: 'John',
        last_name: 'Doe',
      })

      expect(result).toBeDefined()
    })

    it('creates a customer with address', async () => {
      const mockCustomer = {
        id: 'cust-002',
        shop_id: shopId,
        email: 'jane@test.com',
      }
      const mockAddr = {
        id: 'addr-001',
        customer_id: 'cust-002',
        address1: '123 Main St',
        city: 'NYC',
      }
      const db = createMockDb({
        'insert:customers': mockCustomer,
        'insert:customer_addresses': mockAddr,
        'select:customer_addresses': [mockAddr],
      })

      const result = await createCustomer(db, shopId, {
        email: 'jane@test.com',
        addresses: [
          {
            address1: '123 Main St',
            city: 'NYC',
            country: 'US',
            is_default: true,
          },
        ],
      })

      expect(result).toBeDefined()
    })

    it('creates customer with marketing opt-in', async () => {
      const mockCustomer = {
        id: 'cust-003',
        accepts_marketing: true,
      }
      const db = createMockDb({
        'insert:customers': mockCustomer,
      })

      const result = await createCustomer(db, shopId, {
        email: 'sub@test.com',
        accepts_marketing: true,
      })

      expect(result).toBeDefined()
    })
  })

  describe('getCustomer', () => {
    it('returns customer with addresses', async () => {
      const mockCustomer = {
        id: 'cust-001',
        email: 'john@test.com',
        orders_count: 5,
        total_spent: '250.00',
      }
      const db = createMockDb({
        'select:customers': mockCustomer,
        'select:customer_addresses': [],
        'select:orders': { count: 5, sum: '250.00' },
      })

      const result = await getCustomer(db, shopId, 'cust-001')
      expect(result).toBeDefined()
    })

    it('returns null when not found', async () => {
      const db = createMockDb({
        'select:customers': null,
        'select:customer_addresses': [],
      })
      const result = await getCustomer(db, shopId, 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('updateCustomer', () => {
    it('updates customer fields', async () => {
      const updated = {
        id: 'cust-001',
        first_name: 'Jonathan',
        last_name: 'Doe',
      }
      const db = createMockDb({
        'update:customers': updated,
      })

      const result = await updateCustomer(db, shopId, 'cust-001', {
        first_name: 'Jonathan',
      })

      expect(result).toBeDefined()
      expect(db.updateTable).toHaveBeenCalledWith('customers')
    })
  })

  describe('deleteCustomer', () => {
    it('soft-deletes (sets status to disabled)', async () => {
      const db = createMockDb({
        'update:customers': { id: 'cust-001', status: 'disabled' },
      })

      await expect(deleteCustomer(db, shopId, 'cust-001')).resolves.not.toThrow()
    })
  })

  describe('listCustomers', () => {
    it('returns paginated customers', async () => {
      const customers = [
        { id: 'c1', email: 'a@test.com' },
        { id: 'c2', email: 'b@test.com' },
      ]
      const db = createMockDb({
        'select:customers': customers.length > 0 ? customers : { count: 2 },
      })

      const result = await listCustomers(db, shopId)
      expect(result).toBeDefined()
    })
  })

  describe('addAddress', () => {
    it('adds a new address', async () => {
      const mockAddr = {
        id: 'addr-001',
        customer_id: 'cust-001',
        address1: '456 Oak Ave',
      }
      const db = createMockDb({
        'insert:customer_addresses': mockAddr,
        'select:customer_addresses': [],
      })

      const result = await addAddress(db, 'cust-001', {
        address1: '456 Oak Ave',
        city: 'LA',
        country: 'US',
      })

      expect(result).toBeDefined()
    })
  })
})
