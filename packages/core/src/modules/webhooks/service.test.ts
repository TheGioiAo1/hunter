/**
 * Gbox Platform — Webhooks Service Unit Tests
 */

import { describe, it, expect, vi } from 'vitest'
import {
  registerWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
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
  return {
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
    fn: {
      countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
    },
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Webhooks Service', () => {
  const shopId = 'shop-001'

  describe('registerWebhook', () => {
    it('creates a webhook subscription', async () => {
      const mockWH = {
        id: 'wh-001',
        shop_id: shopId,
        topic: 'orders/create',
        address: 'https://example.com/webhook',
        format: 'json',
      }
      const db = createMockDb({ 'insert:webhooks': mockWH })

      const result = await registerWebhook(db, shopId, 'orders/create', 'https://example.com/webhook', 'json')

      expect(result).toBeDefined()
      expect(db.insertInto).toHaveBeenCalledWith('webhooks')
    })
  })

  describe('listWebhooks', () => {
    it('returns webhooks for a shop', async () => {
      const webhooks = [
        { id: 'wh-001', topic: 'orders/create' },
        { id: 'wh-002', topic: 'products/update' },
      ]
      const db = createMockDb({ 'select:webhooks': webhooks })

      const result = await listWebhooks(db, shopId)
      expect(result).toBeDefined()
    })
  })

  describe('getWebhook', () => {
    it('returns a single webhook', async () => {
      const mockWH = { id: 'wh-001', topic: 'orders/create' }
      const db = createMockDb({ 'select:webhooks': mockWH })

      const result = await getWebhook(db, 'wh-001')
      expect(result).toBeDefined()
    })

    it('returns null when not found', async () => {
      const db = createMockDb({ 'select:webhooks': null })
      const result = await getWebhook(db, 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('deleteWebhook', () => {
    it('deletes a webhook', async () => {
      const db = createMockDb()
      await expect(deleteWebhook(db, 'wh-001')).resolves.not.toThrow()
      expect(db.deleteFrom).toHaveBeenCalledWith('webhooks')
    })
  })
})
