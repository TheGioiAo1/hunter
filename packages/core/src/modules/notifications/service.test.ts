/**
 * Gbox Platform — Notifications Service Unit Tests
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createNotification,
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getUnreadCount,
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
    fn: {
      countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Notifications Service', () => {
  const shopId = 'shop-001'
  const userId = 'user-001'

  describe('createNotification', () => {
    it('creates a notification', async () => {
      const mockNotif = {
        id: 'notif-001',
        shop_id: shopId,
        user_id: userId,
        title: 'New order received',
        message: 'Order #1001 has been placed',
        type: 'order',
        read: false,
      }
      const db = createMockDb({ 'insert:notifications': mockNotif })

      const result = await createNotification(db, shopId, userId, {
        title: 'New order received',
        message: 'Order #1001 has been placed',
        type: 'order',
      })

      expect(result).toBeDefined()
      expect(db.insertInto).toHaveBeenCalledWith('notifications')
    })
  })

  describe('getNotifications', () => {
    it('returns notifications for a user', async () => {
      const notifs = [
        { id: 'n1', title: 'Order received', read: false },
        { id: 'n2', title: 'Payment captured', read: true },
      ]
      const db = createMockDb({
        'select:notifications': notifs,
      })

      const result = await getNotifications(db, shopId, userId)
      expect(result).toBeDefined()
    })
  })

  describe('markAsRead', () => {
    it('marks a notification as read', async () => {
      const updated = { id: 'notif-001', read: true }
      const db = createMockDb({ 'update:notifications': updated })

      await expect(markAsRead(db, 'notif-001')).resolves.not.toThrow()
      expect(db.updateTable).toHaveBeenCalledWith('notifications')
    })
  })

  describe('markAllAsRead', () => {
    it('marks all notifications as read for a user', async () => {
      const db = createMockDb()

      await expect(markAllAsRead(db, shopId, userId)).resolves.not.toThrow()
      expect(db.updateTable).toHaveBeenCalledWith('notifications')
    })
  })

  describe('deleteNotification', () => {
    it('deletes a notification', async () => {
      const db = createMockDb()

      await expect(deleteNotification(db, 'notif-001')).resolves.not.toThrow()
      expect(db.deleteFrom).toHaveBeenCalledWith('notifications')
    })
  })

  describe('getUnreadCount', () => {
    it('returns unread count', async () => {
      const db = createMockDb({
        'select:notifications': { count: 5 },
      })

      const result = await getUnreadCount(db, shopId, userId)
      expect(result).toBeDefined()
    })
  })
})
