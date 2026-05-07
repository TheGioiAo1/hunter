/**
 * Gbox Platform — Order Service Unit Tests
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createOrder,
  getOrder,
  cancelOrder,
  createFulfillment,
  createRefund,
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
    deleteFrom: vi.fn().mockImplementation(() => chainable()),
    transaction: vi.fn().mockReturnValue({
      // Phase 15 PR1 — match Kysely's chainable setIsolationLevel() API so
      // createOrder's withSerializable() wrapper can set SERIALIZABLE and
      // then call execute() exactly as it does in production.
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
      countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Order Service', () => {
  const shopId = 'shop-001'

  describe('createOrder', () => {
    it('creates order with line items and calculates totals', async () => {
      const mockOrder = {
        id: 'order-001',
        shop_id: shopId,
        subtotal_price: '39.98',
        total_discounts: '0.00',
        total_price: '39.98',
        financial_status: 'pending',
        created_at: '2024-01-01T00:00:00Z',
      }
      const mockLineItems = [
        { id: 'li-001', order_id: 'order-001', title: 'Widget', quantity: 2, price: '19.99' },
      ]

      const db = createMockDb({
        'insert:orders': mockOrder,
        'insert:order_line_items': mockLineItems[0],
      })

      const result = await createOrder(db, shopId, {
        line_items: [
          { title: 'Widget', quantity: 2, price: '19.99' },
        ],
      })

      expect(result).toBeDefined()
      expect(result.id).toBe('order-001')
      expect(result.line_items).toBeDefined()
    })

    it('creates order with transactions when provided', async () => {
      const mockOrder = {
        id: 'order-002',
        shop_id: shopId,
        total_price: '50.00',
      }
      const mockTransaction = {
        id: 'txn-001',
        order_id: 'order-002',
        kind: 'sale',
        amount: '50.00',
        gateway: 'stripe',
      }

      const db = createMockDb({
        'insert:orders': mockOrder,
        'insert:order_line_items': { id: 'li-001' },
        'insert:transactions': mockTransaction,
      })

      const result = await createOrder(db, shopId, {
        line_items: [{ title: 'Premium Widget', quantity: 1, price: '50.00' }],
        transactions: [{ kind: 'sale', amount: '50.00', gateway: 'stripe' }],
      })

      expect(result.transactions).toBeDefined()
    })

    it('updates customer order count when customer_id provided', async () => {
      const mockOrder = {
        id: 'order-003',
        shop_id: shopId,
        customer_id: 'cust-001',
        total_price: '25.00',
      }

      const db = createMockDb({
        'insert:orders': mockOrder,
        'insert:order_line_items': { id: 'li-001' },
      })

      await createOrder(db, shopId, {
        customer_id: 'cust-001',
        line_items: [{ title: 'Item', quantity: 1, price: '25.00' }],
      })

      expect(db.transaction).toHaveBeenCalled()
    })
  })

  describe('getOrder', () => {
    it('retrieves order with line items and transactions', async () => {
      const mockOrder = {
        id: 'order-001',
        shop_id: shopId,
        total_price: '39.98',
      }

      let selectCallCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return chainable(mockOrder)
        if (selectCallCount === 2) return chainable([{ id: 'li-001', title: 'Widget' }])
        if (selectCallCount === 3) return chainable([])
        if (selectCallCount === 4) return chainable([{ id: 'txn-001', kind: 'sale' }])
        return chainable([])
      })

      const result = await getOrder(db, shopId, 'order-001')

      expect(result).not.toBeNull()
      expect(result!.id).toBe('order-001')
      expect(result!.line_items).toBeDefined()
      expect(result!.fulfillments).toBeDefined()
      expect(result!.transactions).toBeDefined()
      expect(result!.refunds).toBeDefined()
    })

    it('returns null for non-existent order', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))

      const result = await getOrder(db, shopId, 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('cancelOrder', () => {
    it('sets cancelled status and timestamp', async () => {
      const cancelledOrder = {
        id: 'order-001',
        shop_id: shopId,
        cancel_reason: 'customer_request',
        cancelled_at: '2024-01-02T00:00:00Z',
        closed_at: '2024-01-02T00:00:00Z',
        financial_status: 'voided',
      }

      const db = createMockDb({ 'update:orders': cancelledOrder })

      const result = await cancelOrder(db, shopId, 'order-001', 'customer_request')

      expect(result.cancelled_at).toBeDefined()
      expect(result.financial_status).toBe('voided')
      expect(result.cancel_reason).toBe('customer_request')
      expect(db.updateTable).toHaveBeenCalledWith('orders')
    })
  })

  describe('createFulfillment', () => {
    it('creates fulfillment and updates order status', async () => {
      const mockFulfillment = {
        id: 'ful-001',
        order_id: 'order-001',
        status: 'success',
        tracking_number: 'TRACK123',
      }

      const db = createMockDb({
        'insert:fulfillments': mockFulfillment,
        'select:order_line_items': { count: 0 },
      })

      const result = await createFulfillment(db, 'order-001', {
        tracking_number: 'TRACK123',
        tracking_company: 'FedEx',
        line_items: [{ line_item_id: 'li-001', quantity: 1 }],
      })

      expect(result).toBeDefined()
      expect(result.id).toBe('ful-001')
      expect(result.status).toBe('success')
    })
  })

  describe('createRefund', () => {
    it('creates refund with line items', async () => {
      const mockRefund = {
        id: 'ref-001',
        order_id: 'order-001',
        note: 'Damaged item',
        restock: true,
      }
      const mockTransaction = {
        id: 'txn-ref-001',
        order_id: 'order-001',
        kind: 'refund',
        amount: '19.99',
      }

      const db = createMockDb({
        'insert:refunds': mockRefund,
        'insert:refund_line_items': { id: 'rli-001' },
        'insert:transactions': mockTransaction,
      })

      const result = await createRefund(db, 'order-001', {
        note: 'Damaged item',
        restock: true,
        refund_line_items: [
          { line_item_id: 'li-001', quantity: 1, restock_type: 'return' },
        ],
        transactions: [
          { kind: 'refund', amount: '19.99', gateway: 'stripe' },
        ],
      })

      expect(result).toBeDefined()
      expect(result.refund_line_items).toHaveLength(1)
      expect(result.transactions).toBeDefined()
    })

    it('creates refund without transactions', async () => {
      const mockRefund = {
        id: 'ref-002',
        order_id: 'order-001',
        note: null,
        restock: false,
      }

      const db = createMockDb({
        'insert:refunds': mockRefund,
      })

      const result = await createRefund(db, 'order-001', {
        refund_line_items: [
          { line_item_id: 'li-001', quantity: 1 },
        ],
      })

      expect(result).toBeDefined()
      expect(result.transactions).toEqual([])
    })
  })
})
