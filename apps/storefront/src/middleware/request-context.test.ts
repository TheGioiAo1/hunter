/**
 * Gbox Storefront — Request Context Middleware Tests (Stage 3A.2)
 *
 * These tests exercise the request-context middleware as a pure
 * function — no Express server, no sockets — by calling it with a
 * hand-rolled `req` / `res` / `next` trio and asserting on the
 * side-effects. That keeps them fast (<5ms each) and isolates them
 * from everything the real Express app drags in.
 *
 * The middleware owns three orthogonal concerns that this file
 * covers independently:
 *
 *   1. Request ID: generate one if the upstream proxy didn't, reuse
 *      the upstream ID when it looks safe.
 *   2. Response header: X-Request-ID must always be set on the way
 *      out — even for thrown responses — so operators can correlate
 *      logs with user reports.
 *   3. Context object: req.gboxCtx carries id + startedAt + a pino
 *      child logger bound to { req_id }, so every downstream
 *      middleware can log with the ID "for free".
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildRequestContextMiddleware,
  newRequestId,
  isValidUpstreamRequestId,
} from './request-context.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeReq {
  headers: Record<string, string | string[] | undefined>
  gboxCtx?: {
    id: string
    startedAt: number
    logger: { info: (...args: unknown[]) => void }
  }
}

interface FakeRes {
  headers: Record<string, string>
  statusCode: number
  _finishListeners: Array<() => void>
  setHeader(name: string, value: string): void
  getHeader(name: string): string | undefined
  on(event: string, fn: () => void): void
  _emitFinish(): void
}

function mkReq(headers: Record<string, string | string[] | undefined> = {}): FakeReq {
  return { headers }
}

function mkRes(): FakeRes {
  const res: FakeRes = {
    headers: {},
    statusCode: 200,
    _finishListeners: [],
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()]
    },
    on(event, fn) {
      if (event === 'finish') this._finishListeners.push(fn)
    },
    _emitFinish() {
      for (const fn of this._finishListeners) fn()
    },
  }
  return res
}

// ---------------------------------------------------------------------------
// newRequestId()
// ---------------------------------------------------------------------------

describe('newRequestId', () => {
  it('returns a non-empty string', () => {
    const id = newRequestId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('returns a different id on each call', () => {
    const a = newRequestId()
    const b = newRequestId()
    expect(a).not.toBe(b)
  })

  it('contains only url-safe characters', () => {
    const id = newRequestId()
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})

// ---------------------------------------------------------------------------
// isValidUpstreamRequestId()
// ---------------------------------------------------------------------------

describe('isValidUpstreamRequestId', () => {
  it('accepts a simple alnum id', () => {
    expect(isValidUpstreamRequestId('abc123')).toBe(true)
  })

  it('accepts uuid-style ids (with hyphens)', () => {
    expect(
      isValidUpstreamRequestId('8ddd3f6c-9b68-4944-918d-b05492111119'),
    ).toBe(true)
  })

  it('rejects empty strings', () => {
    expect(isValidUpstreamRequestId('')).toBe(false)
  })

  it('rejects strings longer than 128 chars (defence against header abuse)', () => {
    expect(isValidUpstreamRequestId('a'.repeat(129))).toBe(false)
  })

  it('rejects strings with CRLF (header injection)', () => {
    expect(isValidUpstreamRequestId('abc\r\nX-Bad: yes')).toBe(false)
  })

  it('rejects strings with control chars', () => {
    expect(isValidUpstreamRequestId('abc\x00def')).toBe(false)
  })

  it('rejects strings with spaces (not header-safe)', () => {
    expect(isValidUpstreamRequestId('abc def')).toBe(false)
  })

  it('accepts underscores and dots (common in upstream generators)', () => {
    expect(isValidUpstreamRequestId('req_12.34')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildRequestContextMiddleware — ID generation + header propagation
// ---------------------------------------------------------------------------

describe('buildRequestContextMiddleware → id generation', () => {
  it('generates a new id when no upstream X-Request-ID is present', () => {
    const mw = buildRequestContextMiddleware()
    const req = mkReq()
    const res = mkRes()
    const next = vi.fn()

    mw(req as never, res as never, next)

    expect(req.gboxCtx?.id).toBeDefined()
    expect(typeof req.gboxCtx?.id).toBe('string')
    expect(req.gboxCtx!.id.length).toBeGreaterThan(0)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
  })

  it('reuses a valid upstream X-Request-ID (operators can trace across hops)', () => {
    const mw = buildRequestContextMiddleware()
    const req = mkReq({ 'x-request-id': 'upstream-abc-123' })
    const res = mkRes()

    mw(req as never, res as never, vi.fn())

    expect(req.gboxCtx?.id).toBe('upstream-abc-123')
  })

  it('ignores an invalid upstream X-Request-ID and generates its own', () => {
    const mw = buildRequestContextMiddleware()
    const req = mkReq({ 'x-request-id': 'bad\r\nheader' })
    const res = mkRes()

    mw(req as never, res as never, vi.fn())

    expect(req.gboxCtx?.id).toBeDefined()
    expect(req.gboxCtx?.id).not.toBe('bad\r\nheader')
  })

  it('handles array-valued header (Node allows this for duplicate headers)', () => {
    const mw = buildRequestContextMiddleware()
    const req = mkReq({ 'x-request-id': ['first', 'second'] })
    const res = mkRes()

    mw(req as never, res as never, vi.fn())

    // Uses the first value
    expect(req.gboxCtx?.id).toBe('first')
  })

  it('sets X-Request-ID on the response with the chosen id', () => {
    const mw = buildRequestContextMiddleware()
    const req = mkReq()
    const res = mkRes()

    mw(req as never, res as never, vi.fn())

    expect(res.getHeader('X-Request-ID')).toBe(req.gboxCtx?.id)
  })
})

// ---------------------------------------------------------------------------
// buildRequestContextMiddleware — context shape
// ---------------------------------------------------------------------------

describe('buildRequestContextMiddleware → context shape', () => {
  it('stamps startedAt as a recent epoch ms', () => {
    const mw = buildRequestContextMiddleware()
    const req = mkReq()
    const before = Date.now()
    mw(req as never, mkRes() as never, vi.fn())
    const after = Date.now()

    expect(req.gboxCtx?.startedAt).toBeGreaterThanOrEqual(before)
    expect(req.gboxCtx?.startedAt).toBeLessThanOrEqual(after)
  })

  it('attaches a logger object with at least info/warn/error methods', () => {
    const mw = buildRequestContextMiddleware()
    const req = mkReq()
    mw(req as never, mkRes() as never, vi.fn())

    expect(typeof req.gboxCtx?.logger).toBe('object')
    expect(typeof (req.gboxCtx?.logger as { info?: unknown }).info).toBe(
      'function',
    )
    expect(typeof (req.gboxCtx?.logger as { warn?: unknown }).warn).toBe(
      'function',
    )
    expect(typeof (req.gboxCtx?.logger as { error?: unknown }).error).toBe(
      'function',
    )
  })
})

// ---------------------------------------------------------------------------
// buildRequestContextMiddleware — finish listener
// ---------------------------------------------------------------------------

describe('buildRequestContextMiddleware → finish hook', () => {
  it('registers a finish listener so downstream shutdown logs duration', () => {
    const mw = buildRequestContextMiddleware()
    const req = mkReq()
    const res = mkRes()

    mw(req as never, res as never, vi.fn())
    expect(res._finishListeners.length).toBeGreaterThanOrEqual(1)
  })

  it('invokes the injected onFinish hook with the request id + duration', () => {
    const onFinish = vi.fn()
    const mw = buildRequestContextMiddleware({ onFinish })

    const req = mkReq()
    const res = mkRes()
    mw(req as never, res as never, vi.fn())

    res._emitFinish()

    expect(onFinish).toHaveBeenCalledTimes(1)
    const arg = onFinish.mock.calls[0][0] as {
      id: string
      durationMs: number
      statusCode: number
    }
    expect(arg.id).toBe(req.gboxCtx?.id)
    expect(typeof arg.durationMs).toBe('number')
    expect(arg.durationMs).toBeGreaterThanOrEqual(0)
    expect(arg.statusCode).toBe(200)
  })

  it('never throws even if the onFinish hook throws (logging must not crash the response)', () => {
    const onFinish = vi.fn(() => {
      throw new Error('boom')
    })
    const mw = buildRequestContextMiddleware({ onFinish })

    const req = mkReq()
    const res = mkRes()
    mw(req as never, res as never, vi.fn())

    expect(() => res._emitFinish()).not.toThrow()
  })
})
