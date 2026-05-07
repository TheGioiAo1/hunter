/**
 * Gbox Platform — Rate-limited error logger tests
 *
 * Decision #1 Step 1.14. Cover fingerprinting stability, token bucket
 * enforcement (5/min default), suppressed-counter rollover, fake clock
 * window expiry, and the disable knob (`maxPerWindow=0`).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  fingerprintError,
  RateLimitedErrorLogger,
  type ErrorLoggerSink,
  type LoggedEvent,
} from './error-logger.js'

function makeRecorder(): {
  sink: ErrorLoggerSink
  events: LoggedEvent[]
} {
  const events: LoggedEvent[] = []
  return {
    events,
    sink: {
      log(e) {
        events.push(e)
      },
    },
  }
}

function err(name: string, frame: string): Error {
  const e = new Error('boom')
  e.name = name
  e.stack = `${name}: boom\n    at ${frame}`
  return e
}

// ---------------------------------------------------------------------------
// fingerprintError
// ---------------------------------------------------------------------------

describe('fingerprintError', () => {
  it('returns the same hash for the same name + frame + status', () => {
    const a = fingerprintError(err('TypeError', 'foo.js:10:1'), 500)
    const b = fingerprintError(err('TypeError', 'foo.js:10:1'), 500)
    expect(a).toBe(b)
  })

  it('changes when error name changes', () => {
    const a = fingerprintError(err('TypeError', 'foo.js:10:1'), 500)
    const b = fingerprintError(err('RangeError', 'foo.js:10:1'), 500)
    expect(a).not.toBe(b)
  })

  it('changes when first stack frame changes', () => {
    const a = fingerprintError(err('TypeError', 'foo.js:10:1'), 500)
    const b = fingerprintError(err('TypeError', 'bar.js:20:1'), 500)
    expect(a).not.toBe(b)
  })

  it('changes when status changes', () => {
    const a = fingerprintError(err('TypeError', 'foo.js:10:1'), 500)
    const b = fingerprintError(err('TypeError', 'foo.js:10:1'), 502)
    expect(a).not.toBe(b)
  })

  it('handles errors with no stack', () => {
    const noStack = new Error('boom')
    noStack.stack = undefined
    expect(fingerprintError(noStack, 500)).toMatch(/^[a-f0-9]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// RateLimitedErrorLogger
// ---------------------------------------------------------------------------

describe('RateLimitedErrorLogger', () => {
  it('forwards the first N events through the sink', () => {
    const { sink, events } = makeRecorder()
    const logger = new RateLimitedErrorLogger({
      sink,
      maxPerWindow: 3,
      now: () => 1_000,
    })
    for (let i = 0; i < 5; i++) {
      logger.report({
        error: err('Boom', 'a.js:1:1'),
        status: 500,
        path: '/foo',
        method: 'GET',
      })
    }
    expect(events).toHaveLength(3)
  })

  it('returns true for accepted events and false for dropped', () => {
    const { sink } = makeRecorder()
    const logger = new RateLimitedErrorLogger({
      sink,
      maxPerWindow: 2,
      now: () => 1_000,
    })
    const args = {
      error: err('Boom', 'a.js:1:1'),
      status: 500,
      path: '/x',
      method: 'GET',
    }
    expect(logger.report(args)).toBe(true)
    expect(logger.report(args)).toBe(true)
    expect(logger.report(args)).toBe(false)
  })

  it('reports the suppressed count on the next accepted event', () => {
    const { sink, events } = makeRecorder()
    let now = 1_000
    const logger = new RateLimitedErrorLogger({
      sink,
      maxPerWindow: 1,
      windowMs: 100,
      now: () => now,
    })
    const args = {
      error: err('Boom', 'a.js:1:1'),
      status: 500,
      path: '/x',
      method: 'GET',
    }
    logger.report(args) // accepted, suppressed=0
    logger.report(args) // dropped
    logger.report(args) // dropped
    // Advance past the window so the next event opens a fresh bucket
    // and reports the carried-over suppressed count.
    now = 2_000
    logger.report(args)
    expect(events).toHaveLength(2)
    expect(events[0].suppressed).toBe(0)
    expect(events[1].suppressed).toBe(2)
  })

  it('treats different fingerprints as independent buckets', () => {
    const { sink, events } = makeRecorder()
    const logger = new RateLimitedErrorLogger({
      sink,
      maxPerWindow: 1,
      now: () => 1_000,
    })
    logger.report({
      error: err('TypeError', 'a.js:1:1'),
      status: 500,
      path: '/x',
      method: 'GET',
    })
    logger.report({
      error: err('RangeError', 'a.js:1:1'),
      status: 500,
      path: '/x',
      method: 'GET',
    })
    expect(events).toHaveLength(2)
  })

  it('disables logging entirely when maxPerWindow <= 0', () => {
    const { sink, events } = makeRecorder()
    const logger = new RateLimitedErrorLogger({ sink, maxPerWindow: 0 })
    expect(
      logger.report({
        error: new Error('boom'),
        status: 500,
        path: '/',
        method: 'GET',
      }),
    ).toBe(false)
    expect(events).toHaveLength(0)
  })

  it('reset() clears all bucket state', () => {
    const { sink, events } = makeRecorder()
    const logger = new RateLimitedErrorLogger({
      sink,
      maxPerWindow: 1,
      now: () => 1_000,
    })
    const args = {
      error: err('Boom', 'a.js:1:1'),
      status: 500,
      path: '/x',
      method: 'GET',
    }
    logger.report(args)
    logger.report(args) // dropped
    logger.reset()
    logger.report(args) // accepted again, fresh bucket
    expect(events).toHaveLength(2)
  })

  it('LoggedEvent carries the request fields verbatim', () => {
    const { sink, events } = makeRecorder()
    const logger = new RateLimitedErrorLogger({ sink, now: () => 42 })
    logger.report({
      error: err('Boom', 'a.js:1:1'),
      status: 500,
      path: '/cart',
      method: 'POST',
      shopId: 'shop_x',
    })
    expect(events[0]).toMatchObject({
      status: 500,
      path: '/cart',
      method: 'POST',
      shopId: 'shop_x',
      timestamp: 42,
    })
    expect(events[0].fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// Smoke: console.error stub doesn't blow up
// ---------------------------------------------------------------------------

describe('CONSOLE_SINK', () => {
  it('writes to console.error without throwing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { CONSOLE_SINK } = await import('./error-logger.js')
      CONSOLE_SINK.log({
        fingerprint: 'abc',
        status: 500,
        error: err('Boom', 'a.js:1:1'),
        path: '/',
        method: 'GET',
        suppressed: 3,
        timestamp: Date.now(),
      })
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})
