/**
 * Unit tests for ApprovalRegistry. Pure in-memory — no HTTP, no Redis.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createApprovalRegistry,
  type ApprovalRegistry,
} from './approval-registry.ts'

describe('ApprovalRegistry', () => {
  let reg: ApprovalRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    reg = createApprovalRegistry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('register + resolve routes the decision to the callback', () => {
    const onResolve = vi.fn()
    reg.register('aid-1', 'tool-a', onResolve)
    expect(reg.size()).toBe(1)

    const didResolve = reg.resolve('aid-1', 'tool-a', 'approved')
    expect(didResolve).toBe(true)
    expect(onResolve).toHaveBeenCalledWith('approved')
    expect(reg.size()).toBe(0)
  })

  it('resolve returns false for unknown (aid, toolCallId)', () => {
    const ok = reg.resolve('aid-1', 'nonexistent', 'approved')
    expect(ok).toBe(false)
  })

  it('resolve returns false after the entry was already resolved', () => {
    const onResolve = vi.fn()
    reg.register('aid-1', 'tool-a', onResolve)
    reg.resolve('aid-1', 'tool-a', 'approved')
    const second = reg.resolve('aid-1', 'tool-a', 'denied')
    expect(second).toBe(false)
    expect(onResolve).toHaveBeenCalledTimes(1)
  })

  it('fires timeout callback if no decision arrives within timeoutMs', () => {
    const onResolve = vi.fn()
    reg.register('aid-1', 'tool-a', onResolve, 5000)
    expect(reg.size()).toBe(1)

    vi.advanceTimersByTime(5000)
    expect(onResolve).toHaveBeenCalledWith('timeout')
    expect(reg.size()).toBe(0)
  })

  it('disposer cancels the timer without invoking onResolve', () => {
    const onResolve = vi.fn()
    const dispose = reg.register('aid-1', 'tool-a', onResolve, 5000)
    dispose()
    vi.advanceTimersByTime(10_000)
    expect(onResolve).not.toHaveBeenCalled()
    expect(reg.size()).toBe(0)
  })

  it('scopes keys by (aid, toolCallId) — same toolCallId on different aids is distinct', () => {
    const a = vi.fn()
    const b = vi.fn()
    reg.register('aid-1', 'tool-a', a)
    reg.register('aid-2', 'tool-a', b)
    expect(reg.size()).toBe(2)

    reg.resolve('aid-1', 'tool-a', 'approved')
    expect(a).toHaveBeenCalledWith('approved')
    expect(b).not.toHaveBeenCalled()
    expect(reg.size()).toBe(1)
  })

  it('register on an existing key cancels the old entry before overwriting', () => {
    const first = vi.fn()
    const second = vi.fn()
    reg.register('aid-1', 'tool-a', first, 5000)
    reg.register('aid-1', 'tool-a', second, 5000)

    // First entry's timer should have been cancelled. Advance past both
    // timeouts — only `second` gets the timeout.
    vi.advanceTimersByTime(5000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('timeout')
  })

  it('uses the default 120s timeout when no explicit value passed', () => {
    const onResolve = vi.fn()
    reg.register('aid-1', 'tool-a', onResolve)

    // At 119s, still pending.
    vi.advanceTimersByTime(119_000)
    expect(onResolve).not.toHaveBeenCalled()

    // At 120s, fires.
    vi.advanceTimersByTime(1000)
    expect(onResolve).toHaveBeenCalledWith('timeout')
  })
})
