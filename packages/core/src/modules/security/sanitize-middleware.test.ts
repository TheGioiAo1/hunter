/**
 * Gbox Platform — Sanitize Middleware Tests (Phase 7.1)
 *
 * Tests the Express wrapper without spinning up an actual HTTP
 * server: we feed it stub `req` / `res` / `next` objects, let the
 * middleware monkey-patch `res.json`, and then assert on what gets
 * passed to the (captured) original `json` implementation.
 *
 * This keeps the test dependency-light (no supertest) and runs in
 * the same single-millisecond budget as the rest of the security
 * suite.
 */

import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'
import { sanitizeResponseMiddleware } from './sanitize-middleware.js'

// Build a fake `res` whose `.json` records the body it received.
// The middleware patches this method, so the captured calls live on
// the spy AFTER the patch — exactly what production hits.
function makeRes() {
  const captured: unknown[] = []
  const res = {
    json(body: unknown) {
      captured.push(body)
      return this
    },
  } as unknown as Response
  return { res, captured }
}

function makeReq(path = '/'): Request {
  return { path } as Request
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sanitizeResponseMiddleware', () => {
  it('strips sensitive fields before they reach the original res.json', () => {
    const mw = sanitizeResponseMiddleware()
    const { res, captured } = makeRes()
    const next = vi.fn()
    mw(makeReq('/user'), res, next)

    expect(next).toHaveBeenCalled()
    res.json({
      id: 'usr_1',
      email: 'a@b.co',
      password_hash: '$2a$12$leaked',
      session_token: 'leaked',
    })

    expect(captured).toHaveLength(1)
    const body = captured[0] as Record<string, unknown>
    expect(body.id).toBe('usr_1')
    expect(body.email).toBe('a@b.co')
    expect(body).not.toHaveProperty('password_hash')
    expect(body).not.toHaveProperty('session_token')
  })

  it('strips sensitive fields from an array body', () => {
    const mw = sanitizeResponseMiddleware()
    const { res, captured } = makeRes()
    mw(makeReq('/list'), res, vi.fn())

    res.json([
      { id: '1', email: 'a@b.co', password: 'leaked' },
      { id: '2', email: 'c@d.co', password: 'also-leaked' },
    ])

    const body = captured[0] as Array<Record<string, unknown>>
    expect(body).toHaveLength(2)
    for (const row of body) {
      expect(row).not.toHaveProperty('password')
    }
  })

  it('honours a skip predicate', () => {
    const skip = vi.fn((req: Request) => req.path === '/admin/raw')
    const mw = sanitizeResponseMiddleware({ skip })
    const { res, captured } = makeRes()
    mw(makeReq('/admin/raw'), res, vi.fn())

    res.json({ id: '1', password_hash: 'still-here' })

    expect(skip).toHaveBeenCalled()
    const body = captured[0] as Record<string, unknown>
    // skipped → password_hash should still be present
    expect(body).toHaveProperty('password_hash', 'still-here')
  })

  it('still sanitizes other paths when a skip predicate is set', () => {
    const mw = sanitizeResponseMiddleware({
      skip: (req) => req.path === '/admin/raw',
    })
    const { res, captured } = makeRes()
    mw(makeReq('/user'), res, vi.fn())

    res.json({ id: '1', password_hash: 'leaked' })

    expect(captured[0]).not.toHaveProperty('password_hash')
  })

  it('forwards extraKeys to the underlying sanitizer', () => {
    const mw = sanitizeResponseMiddleware({ extraKeys: ['internal_note'] })
    const { res, captured } = makeRes()
    mw(makeReq('/note'), res, vi.fn())

    res.json({ id: '1', internal_note: 'hush', email: 'a@b.co' })

    const body = captured[0] as Record<string, unknown>
    expect(body).not.toHaveProperty('internal_note')
    expect(body.email).toBe('a@b.co')
  })

  it('always calls next() so the request chain continues', () => {
    const mw = sanitizeResponseMiddleware()
    const next = vi.fn()
    mw(makeReq('/anything'), makeRes().res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('still calls next() when the skip predicate fires', () => {
    const mw = sanitizeResponseMiddleware({ skip: () => true })
    const next = vi.fn()
    mw(makeReq('/skipped'), makeRes().res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })
})
