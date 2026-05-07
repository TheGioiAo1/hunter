/**
 * Gbox Platform — requirePermission Middleware Tests (Phase 7.2)
 */

import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { requirePermission } from './require-permission.js'
import { AdminLevel } from './admin-levels.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRes() {
  const json = vi.fn()
  const status = vi.fn(() => ({ json } as unknown as Response))
  const res = { status, json } as unknown as Response
  return { res, status, json }
}

function makeReqWithAuth(authOverride: Record<string, unknown> | null) {
  return {
    auth: authOverride
      ? {
          user: { id: 'u1', email: 'a@b.co', role: 'staff', ...authOverride.user as object },
          session: { id: 's1' } as any,
          isDefaultAdmin: false,
          shopRole: null,
          shop: null,
          level: AdminLevel.STORE_STAFF,
          levelLabel: 'Store Staff',
          ...authOverride,
        }
      : undefined,
  } as unknown as Request
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('requirePermission', () => {
  it('calls next() when the user has the permission', async () => {
    const mw = requirePermission('shop.view_orders')
    const req = makeReqWithAuth({
      user: { id: 'u1', email: 'a@b.co', role: 'staff' },
      shopRole: 'staff',
    })
    const { res } = makeRes()
    const next = vi.fn() as NextFunction
    await mw(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('returns 403 when the user lacks the permission', async () => {
    const mw = requirePermission('shop.delete')
    const req = makeReqWithAuth({
      user: { id: 'u1', email: 'a@b.co', role: 'staff' },
      shopRole: 'staff',
    })
    const { res, status, json } = makeRes()
    const next = vi.fn() as NextFunction
    await mw(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(403)
    const body = json.mock.calls[0]?.[0] as any
    expect(body.error).toBe('forbidden')
    expect(body.permission).toBe('shop.delete')
  })

  it('returns 401 when req.auth is missing entirely', async () => {
    const mw = requirePermission('shop.view_orders')
    const req = makeReqWithAuth(null)
    const { res, status, json } = makeRes()
    const next = vi.fn() as NextFunction
    await mw(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(401)
    expect(json).toHaveBeenCalledWith({ error: 'unauthenticated' })
  })

  it('lets a god admin do anything', async () => {
    const mw = requirePermission('platform.delete_shop')
    const req = makeReqWithAuth({
      user: { id: 'u1', email: 'thai@gbox.co', role: 'owner' },
      isDefaultAdmin: true,
    })
    const { res } = makeRes()
    const next = vi.fn() as NextFunction
    await mw(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('honours a custom onForbidden handler', async () => {
    const onForbidden = vi.fn()
    const mw = requirePermission('shop.delete', { onForbidden })
    const req = makeReqWithAuth({
      user: { id: 'u1', email: 'a@b.co', role: 'staff' },
      shopRole: 'staff',
    })
    const { res } = makeRes()
    await mw(req, res, vi.fn() as NextFunction)
    expect(onForbidden).toHaveBeenCalledTimes(1)
    const callArgs = onForbidden.mock.calls[0]
    expect(callArgs?.[2]).toMatchObject({
      permission: 'shop.delete',
      actualLabel: 'Store Staff',
    })
  })
})
