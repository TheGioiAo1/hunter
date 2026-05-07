import { describe, it, expect, vi } from 'vitest'
import { composeGuards } from './compose.ts'
import type { GuardLayer, GuardResult, SessionContext, ToolCall } from './types.ts'

function ctx(): SessionContext {
  return {
    sessionId: 's1',
    godAdminId: 'u1',
    toolCallCount: 0,
    tier3CallsLast5Min: [],
    consecutiveEditFailures: new Map(),
    bashInFlight: false,
    circuitBreakerOpen: false,
    trafficLevel: 'low',
    currentTime: new Date(),
    repoRoot: '/tmp/repo',
    crossRepoRoots: [],
  }
}

function call(): ToolCall {
  return { id: 'tc1', name: 'repo.read', input: { path: 'a.ts' }, tier: 1 }
}

function layer(name: string, result: GuardResult): GuardLayer {
  return {
    name,
    check: vi.fn().mockResolvedValue(result),
  }
}

describe('composeGuards', () => {
  it('returns allowed:true when every layer passes', async () => {
    const a = layer('a', { allowed: true })
    const b = layer('b', { allowed: true })
    const chain = composeGuards([a, b])
    const r = await chain.check(call(), ctx())
    expect(r).toEqual({ allowed: true })
    expect(a.check).toHaveBeenCalledOnce()
    expect(b.check).toHaveBeenCalledOnce()
  })

  it('short-circuits on first rejection and carries the inner layer name', async () => {
    const a = layer('a', { allowed: true })
    const b = layer('b', { allowed: false, layer: 'b', reason: 'nope' })
    const c = layer('c', { allowed: true })
    const chain = composeGuards([a, b, c])
    const r = await chain.check(call(), ctx())
    expect(r).toEqual({ allowed: false, layer: 'b', reason: 'nope' })
    expect(a.check).toHaveBeenCalledOnce()
    expect(b.check).toHaveBeenCalledOnce()
    expect(c.check).not.toHaveBeenCalled()
  })

  it('exposes name="compose"', () => {
    const chain = composeGuards([])
    expect(chain.name).toBe('compose')
  })

  it('returns allowed:true for an empty layer list', async () => {
    const chain = composeGuards([])
    const r = await chain.check(call(), ctx())
    expect(r).toEqual({ allowed: true })
  })

  it('preserves the first rejection even if a later layer would also reject', async () => {
    const a = layer('a', { allowed: false, layer: 'a', reason: 'first' })
    const b = layer('b', { allowed: false, layer: 'b', reason: 'second' })
    const chain = composeGuards([a, b])
    const r = await chain.check(call(), ctx())
    expect(r).toEqual({ allowed: false, layer: 'a', reason: 'first' })
  })
})
