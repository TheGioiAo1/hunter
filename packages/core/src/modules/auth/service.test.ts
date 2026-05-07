/**
 * Gbox Platform — Auth Service Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createUser,
  createSession,
  validateSession,
  createApiToken,
  validateApiToken,
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
      execute: vi.fn().mockImplementation(async (fn: Function) => {
        return fn(createMockDb(overrides))
      }),
    }),
  }
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth Service', () => {
  describe('createUser', () => {
    it('creates user and returns the user record', async () => {
      const mockUser = {
        id: 'user-001',
        email: 'alice@example.com',
        name: 'Alice',
        avatar_url: null,
        role: 'owner',
        status: 'active',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      }

      const db = createMockDb({ 'insert:users': mockUser })

      const result = await createUser(db, {
        email: 'alice@example.com',
        name: 'Alice',
      })

      expect(result).toBeDefined()
      expect(result.id).toBe('user-001')
      expect(result.email).toBe('alice@example.com')
      expect(result.name).toBe('Alice')
      expect(db.insertInto).toHaveBeenCalledWith('users')
    })

    it('creates user without optional fields', async () => {
      const mockUser = {
        id: 'user-002',
        email: 'bob@example.com',
        name: null,
        avatar_url: null,
      }

      const db = createMockDb({ 'insert:users': mockUser })

      const result = await createUser(db, { email: 'bob@example.com' })

      expect(result.name).toBeNull()
      expect(result.avatar_url).toBeNull()
    })
  })

  describe('createSession', () => {
    it('generates token and stores hashed version', async () => {
      const mockSession = {
        id: 'sess-001',
        user_id: 'user-001',
        token_hash: 'hashed-value',
        ip_address: '127.0.0.1',
        user_agent: 'TestAgent/1.0',
        expires_at: '2024-02-01T00:00:00Z',
        created_at: '2024-01-01T00:00:00Z',
      }

      const db = createMockDb({ 'insert:sessions': mockSession })

      const result = await createSession(db, 'user-001', {
        ip_address: '127.0.0.1',
        user_agent: 'TestAgent/1.0',
      })

      expect(result.token).toBeDefined()
      expect(typeof result.token).toBe('string')
      expect(result.token.length).toBe(64) // 32 bytes hex
      expect(result.session).toBeDefined()
      expect(result.session.id).toBe('sess-001')
      expect(db.insertInto).toHaveBeenCalledWith('sessions')
    })

    it('uses custom expiry when provided', async () => {
      const mockSession = {
        id: 'sess-002',
        user_id: 'user-001',
        expires_at: '2024-01-02T00:00:00Z',
      }

      const db = createMockDb({ 'insert:sessions': mockSession })

      const result = await createSession(db, 'user-001', {
        expires_in_ms: 24 * 60 * 60 * 1000, // 1 day
      })

      expect(result.token).toBeDefined()
      expect(result.session).toBeDefined()
    })
  })

  describe('validateSession', () => {
    it('valid token returns user and session', async () => {
      const mockSession = {
        id: 'sess-001',
        user_id: 'user-001',
        token_hash: 'abc',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }
      const mockUser = {
        id: 'user-001',
        email: 'alice@example.com',
        status: 'active',
      }

      let selectCallCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return chainable(mockSession)
        return chainable(mockUser)
      })

      const result = await validateSession(db, 'some-valid-token')

      expect(result).not.toBeNull()
      expect(result!.user.id).toBe('user-001')
      expect(result!.session.id).toBe('sess-001')
    })

    it('expired session returns null', async () => {
      // When session lookup returns null (expired), validateSession returns null
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))

      const result = await validateSession(db, 'expired-token')
      expect(result).toBeNull()
    })

    it('inactive user returns null', async () => {
      const mockSession = {
        id: 'sess-001',
        user_id: 'user-disabled',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      }

      let selectCallCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return chainable(mockSession)
        return chainable(null) // user not found / not active
      })

      const result = await validateSession(db, 'token-for-disabled-user')
      expect(result).toBeNull()
    })
  })

  describe('createApiToken', () => {
    it('generates prefixed token with gbox_ prefix', async () => {
      const mockRow = {
        id: 'tok-001',
        user_id: 'user-001',
        shop_id: 'shop-001',
        name: 'My API Key',
        token_hash: 'hashed',
        scopes: '["read_products","write_products"]',
      }

      const db = createMockDb({ 'insert:api_tokens': mockRow })

      const result = await createApiToken(db, 'user-001', 'shop-001', {
        label: 'My API Key',
        scopes: ['read_products', 'write_products'],
      })

      expect(result.token).toBeDefined()
      expect(result.token.startsWith('gbox_')).toBe(true)
      expect(result.api_token).toBeDefined()
      expect(result.api_token.id).toBe('tok-001')
      expect(db.insertInto).toHaveBeenCalledWith('api_tokens')
    })
  })

  describe('validateApiToken', () => {
    it('valid token returns user, shop, and scopes', async () => {
      const mockApiToken = {
        id: 'tok-001',
        user_id: 'user-001',
        shop_id: 'shop-001',
        token_hash: 'hashed',
        scopes: ['read_products', 'write_products'],
      }
      const mockUser = {
        id: 'user-001',
        email: 'alice@example.com',
        status: 'active',
      }
      const mockShop = {
        id: 'shop-001',
        name: 'Test Shop',
      }

      let selectCallCount = 0
      const db = createMockDb()
      db.selectFrom = vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) return chainable(mockApiToken)
        if (selectCallCount === 2) return chainable(mockUser)
        return chainable(mockShop)
      })
      db.updateTable = vi.fn().mockReturnValue(chainable())

      const result = await validateApiToken(db, 'gbox_somevalidtoken')

      expect(result).not.toBeNull()
      expect(result!.user.id).toBe('user-001')
      expect(result!.shop.id).toBe('shop-001')
      expect(result!.scopes).toEqual(['read_products', 'write_products'])
    })

    it('invalid token returns null', async () => {
      const db = createMockDb()
      db.selectFrom = vi.fn().mockReturnValue(chainable(null))

      const result = await validateApiToken(db, 'gbox_invalidtoken')
      expect(result).toBeNull()
    })
  })
})
