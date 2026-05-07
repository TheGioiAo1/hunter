/**
 * acme-challenge middleware — unit tests.
 *
 * Cases:
 *   1. Non-challenge paths fall through to next()
 *   2. Valid token + file exists → 200 + body trimmed
 *   3. Valid token + file missing → 404
 *   4. Path traversal token → 400 + never reads disk
 *   5. Malformed token → 400
 *   6. Read error other than ENOENT → 500
 */

import { describe, it, expect, vi } from 'vitest'
import { buildAcmeChallengeMiddleware, __test } from './acme-challenge.js'

const { isSafeToken } = __test

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '' as string,
    contentType: '' as string,
    status(code: number) {
      this.statusCode = code
      return this
    },
    type(t: string) {
      this.contentType = t
      return this
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v
      return this
    },
    send(payload: string) {
      this.body = payload
      return this
    },
  }
  return res
}

function makeReq(path: string) {
  return { path } as any
}

describe('isSafeToken', () => {
  it('accepts base64url + dot', () => {
    expect(isSafeToken('abc-123_XYZ.def')).toBe(true)
  })
  it('rejects empty / too long / forbidden chars / null byte / dotdot', () => {
    expect(isSafeToken('')).toBe(false)
    expect(isSafeToken('a'.repeat(201))).toBe(false)
    expect(isSafeToken('a/b')).toBe(false)
    expect(isSafeToken('a\\b')).toBe(false)
    expect(isSafeToken('..')).toBe(false)
    expect(isSafeToken('a..b')).toBe(false)
    expect(isSafeToken('a\0b')).toBe(false)
    expect(isSafeToken('a b')).toBe(false)
    expect(isSafeToken('a/../etc/passwd')).toBe(false)
  })
})

describe('acmeChallengeMiddleware', () => {
  it('falls through to next() for non-challenge paths', () => {
    const mw = buildAcmeChallengeMiddleware()
    const next = vi.fn()
    const res = makeRes()
    mw(makeReq('/products/foo'), res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.body).toBe('')
  })

  it('serves the trimmed file body when the token exists', async () => {
    const readFileImpl = vi.fn(async (p: string) => {
      expect(p.endsWith('/var/www/acme-webroot/.well-known/acme-challenge/abc123') ||
             p.endsWith('\\var\\www\\acme-webroot\\.well-known\\acme-challenge\\abc123')).toBe(true)
      return Buffer.from('challenge-key-authorisation\n', 'utf8')
    })
    const mw = buildAcmeChallengeMiddleware({ readFileImpl })
    const next = vi.fn()
    const res = makeRes()
    await new Promise<void>((resolve) => {
      mw(makeReq('/.well-known/acme-challenge/abc123'), res, () => resolve())
      // Settle on next tick.
      setImmediate(() => resolve())
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('challenge-key-authorisation')
    expect(res.headers['Content-Type']).toContain('text/plain')
    expect(readFileImpl).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 404 when the token file is missing (ENOENT)', async () => {
    const readFileImpl = vi.fn(async () => {
      const err = new Error('not found') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })
    const mw = buildAcmeChallengeMiddleware({ readFileImpl })
    const res = makeRes()
    await new Promise<void>((resolve) => {
      mw(makeReq('/.well-known/acme-challenge/abc123'), res, () => resolve())
      setImmediate(() => resolve())
    })
    expect(res.statusCode).toBe(404)
    expect(res.body).toBe('not found')
  })

  it('returns 400 for path-traversal tokens without reading disk', async () => {
    const readFileImpl = vi.fn()
    const mw = buildAcmeChallengeMiddleware({ readFileImpl })
    const res = makeRes()
    mw(makeReq('/.well-known/acme-challenge/../../etc/passwd'), res, vi.fn())
    expect(res.statusCode).toBe(400)
    expect(readFileImpl).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed tokens (whitespace, null byte)', async () => {
    const readFileImpl = vi.fn()
    const mw = buildAcmeChallengeMiddleware({ readFileImpl })
    const res = makeRes()
    mw(makeReq('/.well-known/acme-challenge/bad%20token'), res, vi.fn())
    expect(res.statusCode).toBe(400)
    expect(readFileImpl).not.toHaveBeenCalled()
  })

  it('returns 500 on non-ENOENT read errors', async () => {
    const readFileImpl = vi.fn(async () => {
      const err = new Error('eperm') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    })
    const mw = buildAcmeChallengeMiddleware({ readFileImpl })
    const res = makeRes()
    await new Promise<void>((resolve) => {
      mw(makeReq('/.well-known/acme-challenge/validtoken'), res, () => resolve())
      setImmediate(() => resolve())
    })
    expect(res.statusCode).toBe(500)
  })
})
