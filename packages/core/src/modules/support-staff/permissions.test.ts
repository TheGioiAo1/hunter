/**
 * Permission checks + `requireSupportPermission` middleware — tests.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  canStaff,
  hasAnyPermission,
  hasPermission,
  requireSupportPermission,
  type DenyLogger,
  type MinimalExpressReq,
  type MinimalExpressRes,
} from './permissions.ts'

describe('hasPermission', () => {
  it('returns true on matrix hit', () => {
    expect(hasPermission('l1_support', 'support:ticket:read')).toBe(true)
    expect(hasPermission('lead_support', 'support:ticket:delete_message')).toBe(true)
    expect(hasPermission('god_admin', 'support:shop:orders_read')).toBe(true)
  })

  it('returns false on matrix miss', () => {
    expect(hasPermission('l1_support', 'support:ticket:delete_message')).toBe(false)
    expect(hasPermission('l2_support_senior', 'support:shop:orders_read')).toBe(false)
    expect(hasPermission('lead_support', 'support:staff:invite')).toBe(false)
  })

  it('returns false for unknown preset (fail-closed)', () => {
    // @ts-expect-error — intentionally testing unknown preset
    expect(hasPermission('random_role', 'support:ticket:read')).toBe(false)
    expect(hasPermission(null, 'support:ticket:read')).toBe(false)
    expect(hasPermission(undefined, 'support:ticket:read')).toBe(false)
  })
})

describe('hasAnyPermission', () => {
  it('returns true if any scope passes', () => {
    expect(
      hasAnyPermission('l1_support', [
        'support:ticket:delete_message', // denied
        'support:ticket:read', // allowed
      ]),
    ).toBe(true)
  })

  it('returns false if none pass', () => {
    expect(
      hasAnyPermission('l1_support', [
        'support:ticket:delete_message',
        'support:staff:invite',
      ]),
    ).toBe(false)
  })

  it('returns false on empty list', () => {
    expect(hasAnyPermission('god_admin', [])).toBe(false)
  })
})

describe('canStaff', () => {
  it('returns false when user is null/undefined', () => {
    expect(canStaff(null, 'support:ticket:read')).toBe(false)
    expect(canStaff(undefined, 'support:ticket:read')).toBe(false)
  })

  it('returns true when user has the scope', () => {
    expect(
      canStaff(
        { userId: 'u1', preset: 'l1_support', displayName: 'Thai' },
        'support:ticket:read',
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// requireSupportPermission middleware
// ---------------------------------------------------------------------------

function mockRes(): MinimalExpressRes & { _status: number; _body: string } {
  const res: any = {
    _status: 200,
    _body: '',
  }
  res.status = (code: number) => {
    res._status = code
    return res
  }
  res.type = () => res
  res.send = (body: string) => {
    res._body = body
  }
  return res
}

function mockReq(opts: Partial<MinimalExpressReq> = {}): MinimalExpressReq {
  return {
    path: opts.path ?? '/inbox',
    method: opts.method ?? 'GET',
    ip: opts.ip ?? '127.0.0.1',
    headers: opts.headers ?? { 'user-agent': 'vitest' },
    staffUser: opts.staffUser,
  }
}

describe('requireSupportPermission — middleware', () => {
  it('401s when no staff user on the request', async () => {
    const logDeny = vi.fn() as unknown as DenyLogger
    const mw = requireSupportPermission('support:ticket:read', logDeny)
    const req = mockReq({ staffUser: null })
    const res = mockRes()
    const next = vi.fn()
    await mw(req, res, next)
    expect(res._status).toBe(401)
    expect(next).not.toHaveBeenCalled()
    expect(logDeny).not.toHaveBeenCalled()
  })

  it('403s + logs when preset fails the scope', async () => {
    const logDeny = vi.fn(async () => {})
    const mw = requireSupportPermission('support:shop:orders_read', logDeny)
    const req = mockReq({
      path: '/shop/x/orders',
      method: 'GET',
      staffUser: { userId: 'u1', preset: 'l1_support', displayName: 'Thai' },
    })
    const res = mockRes()
    const next = vi.fn()
    await mw(req, res, next)
    expect(res._status).toBe(403)
    expect(next).not.toHaveBeenCalled()
    expect(logDeny).toHaveBeenCalledTimes(1)
    expect(logDeny).toHaveBeenCalledWith({
      actorUserId: 'u1',
      actorPreset: 'l1_support',
      scope: 'support:shop:orders_read',
      path: '/shop/x/orders',
      method: 'GET',
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
  })

  it('calls next() when the preset passes', async () => {
    const logDeny = vi.fn() as unknown as DenyLogger
    const mw = requireSupportPermission('support:ticket:read', logDeny)
    const req = mockReq({
      staffUser: { userId: 'u1', preset: 'l1_support', displayName: 'Thai' },
    })
    const res = mockRes()
    const next = vi.fn()
    await mw(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res._status).toBe(200) // unchanged
    expect(logDeny).not.toHaveBeenCalled()
  })

  it('DOES NOT leak scope name in the 403 body (Iron Rule 5)', async () => {
    const logDeny = vi.fn(async () => {})
    const mw = requireSupportPermission('support:shop:orders_read', logDeny)
    const req = mockReq({
      staffUser: { userId: 'u1', preset: 'l1_support', displayName: 'Thai' },
    })
    const res = mockRes()
    await mw(req, res, vi.fn())
    expect(res._body).not.toContain('support:shop:orders_read')
    expect(res._body).not.toContain('orders_read')
    expect(res._body).not.toContain('l1_support')
  })

  it('survives a logDeny that throws', async () => {
    const logDeny = vi.fn().mockRejectedValue(new Error('DB down'))
    const mw = requireSupportPermission('support:shop:orders_read', logDeny)
    const req = mockReq({
      staffUser: { userId: 'u1', preset: 'l1_support', displayName: 'Thai' },
    })
    const res = mockRes()
    await mw(req, res, vi.fn())
    // Still responds with 403 even though the audit write crashed.
    expect(res._status).toBe(403)
  })

  it('extracts user-agent from array headers (supertest quirk)', async () => {
    const logDeny = vi.fn(async () => {})
    const mw = requireSupportPermission('support:shop:orders_read', logDeny)
    const req = mockReq({
      headers: { 'user-agent': ['vitest', 'ignored'] },
      staffUser: { userId: 'u1', preset: 'l1_support', displayName: 'Thai' },
    })
    const res = mockRes()
    await mw(req, res, vi.fn())
    expect(logDeny).toHaveBeenCalledWith(
      expect.objectContaining({ userAgent: 'vitest' }),
    )
  })
})
