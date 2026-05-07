import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { signInternalJwt } from '@gbox/agent-core'
import { createJwtAuth } from './jwt-auth.ts'

const SECRET = 'a'.repeat(64) // 64 chars, well above 32-char min

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as unknown as Response & { statusCode: number; body: unknown }
}

function fakeReq(header: string | undefined): Request {
  return {
    header(name: string): string | undefined {
      if (name.toLowerCase() === 'authorization') return header
      return undefined
    },
  } as unknown as Request
}

describe('jwt-auth middleware', () => {
  it('rejects requests without a bearer header', async () => {
    const mw = createJwtAuth({ secret: SECRET })
    const res = fakeRes()
    const next = vi.fn() as NextFunction
    await mw(fakeReq(undefined), res, next)
    expect(res.statusCode).toBe(401)
    expect((res as any).body).toEqual({ error: 'missing_bearer_token' })
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects malformed bearer tokens', async () => {
    const mw = createJwtAuth({ secret: SECRET })
    const res = fakeRes()
    const next = vi.fn() as NextFunction
    await mw(fakeReq('Bearer not-a-real-jwt'), res, next)
    expect(res.statusCode).toBe(401)
    expect((res as any).body).toMatchObject({ error: 'invalid_jwt' })
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects tokens signed with the wrong secret', async () => {
    const token = await signInternalJwt({ sid: 's1', aid: 'a1', secret: SECRET })
    const mw = createJwtAuth({ secret: 'b'.repeat(64) })
    const res = fakeRes()
    const next = vi.fn() as NextFunction
    await mw(fakeReq(`Bearer ${token}`), res, next)
    expect(res.statusCode).toBe(401)
    expect((res as any).body).toMatchObject({ reason: 'bad_signature' })
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts a valid token and attaches claims to req.jwt', async () => {
    const token = await signInternalJwt({ sid: 'sid-1', aid: 'aid-1', secret: SECRET })
    const mw = createJwtAuth({ secret: SECRET })
    const req = fakeReq(`Bearer ${token}`)
    const res = fakeRes()
    const next = vi.fn() as NextFunction
    await mw(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect((req as any).jwt).toMatchObject({ sid: 'sid-1', aid: 'aid-1' })
  })
})
