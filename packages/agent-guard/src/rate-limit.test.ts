import { describe, it, expect } from 'vitest'
import { rateLimit } from './rate-limit.ts'
import type { SessionContext, ToolCall } from './types.ts'

const NOW = new Date('2026-04-10T10:00:00.000Z')
const NOW_MS = NOW.getTime()

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 's1',
    godAdminId: 'u1',
    toolCallCount: 0,
    tier3CallsLast5Min: [],
    consecutiveEditFailures: new Map(),
    bashInFlight: false,
    circuitBreakerOpen: false,
    trafficLevel: 'low',
    currentTime: NOW,
    repoRoot: '/tmp/repo',
    crossRepoRoots: [],
    ...overrides,
  }
}

function call(name: string, tier: 1 | 2 | 3 | 4, input: unknown = {}): ToolCall {
  return { id: 'tc1', name, input, tier }
}

describe('rateLimit — rule 1: session cap (100 tool calls)', () => {
  it('allows the 99th tool call', async () => {
    const r = await rateLimit.check(call('repo.read', 1), ctx({ toolCallCount: 99 }))
    expect(r).toEqual({ allowed: true })
  })

  it('rejects the 100th tool call', async () => {
    const r = await rateLimit.check(call('repo.read', 1), ctx({ toolCallCount: 100 }))
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.layer).toBe('rate-limit')
      expect(r.reason).toMatch(/session cap/i)
    }
  })

  it('rejects the 150th tool call', async () => {
    const r = await rateLimit.check(call('repo.read', 1), ctx({ toolCallCount: 150 }))
    expect(r.allowed).toBe(false)
  })
})

describe('rateLimit — rule 2: 20 tier-3 calls per 5-minute window', () => {
  const recent = (n: number): number[] =>
    Array.from({ length: n }, (_, i) => NOW_MS - i * 1000) // all within the last minute

  it('allows a tier-3 call when history has 19 entries in window', async () => {
    const r = await rateLimit.check(call('repo.edit', 3), ctx({ tier3CallsLast5Min: recent(19) }))
    expect(r).toEqual({ allowed: true })
  })

  it('rejects a tier-3 call when history has 20 entries in window', async () => {
    const r = await rateLimit.check(call('repo.edit', 3), ctx({ tier3CallsLast5Min: recent(20) }))
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/tier.?3/i)
  })

  it('excludes entries older than 5 minutes from the count', async () => {
    // 19 stale (older than 5 min) + 5 fresh = 5 in window → allow
    const stale = Array.from({ length: 19 }, () => NOW_MS - 10 * 60_000)
    const fresh = Array.from({ length: 5 }, (_, i) => NOW_MS - i * 1000)
    const r = await rateLimit.check(
      call('repo.edit', 3),
      ctx({ tier3CallsLast5Min: [...stale, ...fresh] }),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('does NOT apply the tier-3 rule to tier-1 calls', async () => {
    const full = Array.from({ length: 50 }, (_, i) => NOW_MS - i * 1000)
    const r = await rateLimit.check(call('repo.read', 1), ctx({ tier3CallsLast5Min: full }))
    expect(r).toEqual({ allowed: true })
  })
})

describe('rateLimit — rule 3: 3 consecutive repo.edit failures on same file', () => {
  it('allows repo.edit when failure count for the path is 2', async () => {
    const ctxWith = ctx({
      consecutiveEditFailures: new Map([['/tmp/repo/a.ts', 2]]),
    })
    const r = await rateLimit.check(call('repo.edit', 3, { path: '/tmp/repo/a.ts' }), ctxWith)
    expect(r).toEqual({ allowed: true })
  })

  it('rejects repo.edit when failure count for the path is 3', async () => {
    const ctxWith = ctx({
      consecutiveEditFailures: new Map([['/tmp/repo/a.ts', 3]]),
    })
    const r = await rateLimit.check(call('repo.edit', 3, { path: '/tmp/repo/a.ts' }), ctxWith)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/consecutive/i)
  })

  it('does NOT reject repo.edit on a different path even if another path is at 3', async () => {
    const ctxWith = ctx({
      consecutiveEditFailures: new Map([['/tmp/repo/other.ts', 3]]),
    })
    const r = await rateLimit.check(call('repo.edit', 3, { path: '/tmp/repo/a.ts' }), ctxWith)
    expect(r).toEqual({ allowed: true })
  })
})

describe('rateLimit — precedence', () => {
  it('rejects at session cap even if other rules would allow', async () => {
    const r = await rateLimit.check(call('repo.read', 1), ctx({ toolCallCount: 999 }))
    expect(r.allowed).toBe(false)
  })
})
