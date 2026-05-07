import { describe, it, expect } from 'vitest'
import { deploymentSafety, classifyPath } from './deployment-safety.ts'
import type { SessionContext, ToolCall } from './types.ts'

const REPO = '/tmp/gbox-repo'

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
    // Default to an in-window time: Mon 2026-04-13 03:30 GMT+7 = 20:30 UTC on Sunday
    currentTime: new Date('2026-04-12T20:30:00Z'),
    repoRoot: REPO,
    crossRepoRoots: [],
    ...overrides,
  }
}

function editCall(relPath: string): ToolCall {
  return { id: 'tc1', name: 'repo.edit', input: { path: `${REPO}/${relPath}` }, tier: 3 }
}

describe('classifyPath', () => {
  it.each([
    ['apps/storefront/src/x.ts', 'customer-facing'],
    ['apps/accounts/src/login.tsx', 'customer-facing'],
    ['packages/db/src/schema/tables.ts', 'customer-facing'],
    ['packages/core/src/modules/cart.ts', 'customer-facing'],
    ['apps/god-admin/src/x.ts', 'admin-only'],
    ['apps/store-admin/src/x.ts', 'admin-only'],
    ['docs/spec.md', 'safe'],
    ['scripts/seed.ts', 'safe'],
    ['packages/agent-guard/src/x.ts', 'safe'],
    ['tests/e2e/x.test.ts', 'safe'],
  ])('%s → %s', (path, expected) => {
    expect(classifyPath(path)).toBe(expected)
  })
})

describe('deploymentSafety — circuit breaker', () => {
  it('rejects any tier-3 call when circuit breaker is open', async () => {
    const r = await deploymentSafety.check(
      editCall('docs/safe.md'),
      ctx({ circuitBreakerOpen: true }),
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/circuit breaker/i)
  })

  it('allows tier-1 calls even when circuit breaker is open', async () => {
    const r = await deploymentSafety.check(
      { id: 'tc1', name: 'repo.read', input: { path: `${REPO}/a.ts` }, tier: 1 },
      ctx({ circuitBreakerOpen: true }),
    )
    expect(r).toEqual({ allowed: true })
  })
})

describe('deploymentSafety — traffic-level gating for customer-facing', () => {
  it('rejects customer-facing edits at peak traffic', async () => {
    const r = await deploymentSafety.check(
      editCall('apps/storefront/src/index.ts'),
      ctx({ trafficLevel: 'peak' }),
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/peak/i)
  })

  it('allows admin-only edits at peak traffic', async () => {
    const r = await deploymentSafety.check(
      editCall('apps/god-admin/src/x.ts'),
      ctx({ trafficLevel: 'peak' }),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('allows safe edits at peak traffic', async () => {
    const r = await deploymentSafety.check(
      editCall('docs/spec.md'),
      ctx({ trafficLevel: 'peak' }),
    )
    expect(r).toEqual({ allowed: true })
  })
})

describe('deploymentSafety — maintenance window for customer-facing', () => {
  // GMT+7 window: 03:00-04:00 local = 20:00-21:00 UTC previous day
  it('allows customer-facing edit inside daily window (03:30 GMT+7)', async () => {
    const r = await deploymentSafety.check(
      editCall('apps/storefront/src/index.ts'),
      ctx({
        trafficLevel: 'low',
        currentTime: new Date('2026-04-12T20:30:00Z'), // 03:30 GMT+7 Mon 2026-04-13
      }),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('rejects customer-facing edit outside window (15:00 GMT+7 Wed)', async () => {
    const r = await deploymentSafety.check(
      editCall('apps/storefront/src/index.ts'),
      ctx({
        trafficLevel: 'low',
        currentTime: new Date('2026-04-15T08:00:00Z'), // 15:00 GMT+7 Wed 2026-04-15
      }),
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/maintenance window|deploy\.schedule/i)
  })

  it('allows customer-facing edit during Sunday extended window (03:00 GMT+7 Sun)', async () => {
    const r = await deploymentSafety.check(
      editCall('packages/db/src/schema/tables.ts'),
      ctx({
        trafficLevel: 'low',
        // Sunday 03:00 GMT+7 = Saturday 20:00 UTC
        currentTime: new Date('2026-04-11T20:00:00Z'),
      }),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('rejects customer-facing edit Sunday 06:00 GMT+7 (just after window)', async () => {
    const r = await deploymentSafety.check(
      editCall('apps/storefront/src/index.ts'),
      ctx({
        trafficLevel: 'low',
        // Sunday 06:00 GMT+7 = Saturday 23:00 UTC
        currentTime: new Date('2026-04-11T23:00:00Z'),
      }),
    )
    expect(r.allowed).toBe(false)
  })
})

describe('deploymentSafety — admin-only and safe paths ignore window', () => {
  it('allows admin-only edits outside window', async () => {
    const r = await deploymentSafety.check(
      editCall('apps/god-admin/src/x.ts'),
      ctx({
        trafficLevel: 'low',
        currentTime: new Date('2026-04-15T08:00:00Z'), // daytime
      }),
    )
    expect(r).toEqual({ allowed: true })
  })

  it('allows safe edits outside window', async () => {
    const r = await deploymentSafety.check(
      editCall('docs/spec.md'),
      ctx({
        trafficLevel: 'low',
        currentTime: new Date('2026-04-15T08:00:00Z'),
      }),
    )
    expect(r).toEqual({ allowed: true })
  })
})

describe('deploymentSafety — deploy.run target=storefront', () => {
  it('rejects deploy.run storefront at peak traffic', async () => {
    const r = await deploymentSafety.check(
      { id: 'tc1', name: 'deploy.run', input: { target: 'storefront', env: 'prod' }, tier: 3 },
      ctx({ trafficLevel: 'peak' }),
    )
    expect(r.allowed).toBe(false)
  })

  it('allows deploy.run storefront during maintenance window at low traffic', async () => {
    const r = await deploymentSafety.check(
      { id: 'tc1', name: 'deploy.run', input: { target: 'storefront', env: 'prod' }, tier: 3 },
      ctx({
        trafficLevel: 'low',
        currentTime: new Date('2026-04-12T20:30:00Z'),
      }),
    )
    expect(r).toEqual({ allowed: true })
  })
})
