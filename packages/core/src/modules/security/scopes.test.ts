/**
 * Gbox Platform — API Token Scopes Unit Tests
 *
 * Tests the scope resolution logic: exact match, write→read implicit grant.
 */

import { describe, it, expect, vi } from 'vitest'

// We can't import requireScope directly (it returns middleware), but we can
// test the internal hasScope logic by testing the middleware behavior.
// Instead, we'll test the hasScope logic by extracting it.

// Since hasScope is not exported, we test via requireScope middleware behavior.
import { requireScope } from './scopes.js'
import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Mock database builder
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') return vi.fn().mockResolvedValue([result].filter(Boolean))
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

function createMockDb(tokenRow: any = null) {
  return {
    selectFrom: vi.fn().mockImplementation(() => chainable(tokenRow)),
    updateTable: vi.fn().mockImplementation(() => chainable()),
  } as any
}

function createMockReq(token?: string): Request {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as any
}

function createMockRes(): Response & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 0,
    body: null,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: any) {
      res.body = data
      return res
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('requireScope middleware', () => {
  it('returns 401 when no token is provided', async () => {
    const db = createMockDb()
    const middleware = requireScope('read_products', { db })
    const req = createMockReq()
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(res.body.error).toBe('unauthorized')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when token is not recognized', async () => {
    const db = createMockDb(null) // no token found
    const middleware = requireScope('read_products', { db })
    const req = createMockReq('invalid-token')
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(res.statusCode).toBe(401)
    expect(res.body.error).toBe('invalid_token')
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 403 when token lacks the required scope', async () => {
    const tokenRow = {
      id: 'tok-001',
      token_hash: 'hash',
      scopes: ['read_orders'],
      last_used_at: null,
    }
    const db = createMockDb(tokenRow)
    const middleware = requireScope('read_products', { db })
    const req = createMockReq('some-token')
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(res.statusCode).toBe(403)
    expect(res.body.error).toBe('insufficient_scope')
    expect(res.body.required_scope).toBe('read_products')
    expect(next).not.toHaveBeenCalled()
  })

  it('passes when token has exact scope', async () => {
    const tokenRow = {
      id: 'tok-001',
      token_hash: 'hash',
      scopes: ['read_products'],
      last_used_at: null,
    }
    const db = createMockDb(tokenRow)
    const middleware = requireScope('read_products', { db })
    const req = createMockReq('some-token')
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect((req as any).apiToken).toEqual(tokenRow)
  })

  it('write_X implicitly grants read_X', async () => {
    const tokenRow = {
      id: 'tok-002',
      token_hash: 'hash',
      scopes: ['write_products'],
      last_used_at: null,
    }
    const db = createMockDb(tokenRow)
    const middleware = requireScope('read_products', { db })
    const req = createMockReq('some-token')
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.statusCode).toBe(0) // not set to error
  })

  it('read_X does NOT grant write_X', async () => {
    const tokenRow = {
      id: 'tok-003',
      token_hash: 'hash',
      scopes: ['read_products'],
      last_used_at: null,
    }
    const db = createMockDb(tokenRow)
    const middleware = requireScope('write_products', { db })
    const req = createMockReq('some-token')
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('allows missing token when required=false', async () => {
    const db = createMockDb()
    const middleware = requireScope('read_products', { db, required: false })
    const req = createMockReq() // no token
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('handles gift_cards scope', async () => {
    const tokenRow = {
      id: 'tok-004',
      token_hash: 'hash',
      scopes: ['write_gift_cards'],
      last_used_at: null,
    }
    const db = createMockDb(tokenRow)
    const middleware = requireScope('read_gift_cards', { db })
    const req = createMockReq('gc-token')
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
  })
})
