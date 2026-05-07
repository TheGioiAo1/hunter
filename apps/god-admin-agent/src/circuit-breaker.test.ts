import { describe, it, expect } from 'vitest'
import { createCircuitBreaker } from './circuit-breaker.ts'

describe('circuit breaker', () => {
  it('starts closed', () => {
    const cb = createCircuitBreaker({ windowMs: 60_000, errorThreshold: 3 })
    expect(cb.isOpen()).toBe(false)
    expect(cb.snapshot().errorsInWindow).toBe(0)
  })

  it('opens after N errors inside the window', () => {
    let t = 1_000
    const cb = createCircuitBreaker({
      windowMs: 60_000,
      errorThreshold: 3,
      now: () => t,
    })
    cb.recordError()
    cb.recordError()
    expect(cb.isOpen()).toBe(false)
    cb.recordError()
    expect(cb.isOpen()).toBe(true)
  })

  it('drops errors older than the window from the count', () => {
    let t = 1_000
    const cb = createCircuitBreaker({
      windowMs: 10_000,
      errorThreshold: 3,
      now: () => t,
    })
    cb.recordError() // t=1000
    cb.recordError() // t=1000 — 2 errors at t=1000
    t = 20_000 // both t=1000 errors are now outside the 10s window
    cb.recordError() // t=20000 — only 1 in window
    cb.recordError() // t=20000 — 2 in window
    expect(cb.isOpen()).toBe(false)
    cb.recordError() // t=20000 — 3 in window → trip
    expect(cb.isOpen()).toBe(true)
  })

  it('close() resets the breaker manually', () => {
    const cb = createCircuitBreaker({ windowMs: 60_000, errorThreshold: 2 })
    cb.recordError()
    cb.recordError()
    expect(cb.isOpen()).toBe(true)
    cb.close()
    expect(cb.isOpen()).toBe(false)
    expect(cb.snapshot().errorsInWindow).toBe(0)
  })

  it('recordSuccess does NOT auto-close a tripped breaker', () => {
    const cb = createCircuitBreaker({ windowMs: 60_000, errorThreshold: 2 })
    cb.recordError()
    cb.recordError()
    expect(cb.isOpen()).toBe(true)
    cb.recordSuccess()
    expect(cb.isOpen()).toBe(true) // still open — operator must close
  })
})
