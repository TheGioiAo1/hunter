import { describe, it, expect, vi } from 'vitest'
import { createRegistry } from './registry.ts'
import type { ToolDef } from './types.ts'
import type {
  GuardLayer,
  GuardResult,
  SessionContext,
  ToolCall,
} from '@gbox/agent-guard'

function makeCtx(): SessionContext {
  return {
    sessionId: 's-1',
    godAdminId: 'god-1',
    toolCallCount: 0,
    tier3CallsLast5Min: [],
    consecutiveEditFailures: new Map(),
    bashInFlight: false,
    circuitBreakerOpen: false,
    trafficLevel: 'normal',
    currentTime: new Date('2026-04-10T00:00:00Z'),
    repoRoot: '/tmp/repo',
    crossRepoRoots: [],
  }
}

function allowAllGuard(): GuardLayer {
  return {
    name: 'test-allow-all',
    async check(): Promise<GuardResult> {
      return { allowed: true }
    },
  }
}

function denyGuard(reason = 'test-deny'): GuardLayer {
  return {
    name: 'test-deny',
    async check(): Promise<GuardResult> {
      return { allowed: false, layer: 'test-deny', reason }
    },
  }
}

const okTool: ToolDef<{ x: number }, Record<string, never>> = {
  name: 'test.ok',
  tier: 1,
  description: 'returns ok with x doubled',
  parseInput(raw) {
    if (!raw || typeof raw !== 'object' || typeof (raw as any).x !== 'number') {
      throw new Error('test.ok: x required')
    }
    return { x: (raw as any).x }
  },
  async run(input) {
    return { kind: 'ok', data: { doubled: input.x * 2 } }
  },
}

const errorTool: ToolDef<void, Record<string, never>> = {
  name: 'test.error',
  tier: 1,
  description: 'always errors',
  parseInput() {
    return
  },
  async run() {
    return { kind: 'error', message: 'boom', code: 'test_error' }
  },
}

describe('createRegistry — construction', () => {
  it('rejects duplicate tool names', () => {
    expect(() => createRegistry([okTool, okTool])).toThrow(/duplicate tool name/)
  })

  it('list() returns every registered tool', () => {
    const reg = createRegistry([okTool, errorTool])
    expect(reg.list().map((t) => t.name).sort()).toEqual(['test.error', 'test.ok'])
  })

  it('get() returns the matching def or undefined', () => {
    const reg = createRegistry([okTool])
    expect(reg.get('test.ok')).toBe(okTool)
    expect(reg.get('nope')).toBeUndefined()
  })
})

describe('createRegistry.dispatch', () => {
  const call: ToolCall = { id: 'tc-1', name: 'test.ok', input: { x: 5 }, tier: 1 }

  it('returns unknown_tool when the name is not registered', async () => {
    const reg = createRegistry([okTool])
    const result = await reg.dispatch({
      call: { ...call, name: 'nope' },
      sessionContext: makeCtx(),
      deps: {},
      guard: allowAllGuard(),
    })
    expect(result).toEqual({ kind: 'unknown_tool', name: 'nope' })
  })

  it('returns error when parseInput throws', async () => {
    const reg = createRegistry([okTool])
    const result = await reg.dispatch({
      call: { ...call, input: { wrong: 'shape' } },
      sessionContext: makeCtx(),
      deps: {},
      guard: allowAllGuard(),
    })
    expect(result).toMatchObject({
      kind: 'error',
      code: 'invalid_input',
    })
  })

  it('returns blocked when the guard chain denies', async () => {
    const reg = createRegistry([okTool])
    const result = await reg.dispatch({
      call,
      sessionContext: makeCtx(),
      deps: {},
      guard: denyGuard('blocked for testing'),
    })
    expect(result).toEqual({
      kind: 'blocked',
      layer: 'test-deny',
      reason: 'blocked for testing',
    })
  })

  it('invokes the tool handler when the guard allows', async () => {
    const reg = createRegistry([okTool])
    const result = await reg.dispatch({
      call,
      sessionContext: makeCtx(),
      deps: {},
      guard: allowAllGuard(),
    })
    expect(result).toEqual({ kind: 'ok', data: { doubled: 10 } })
  })

  it('propagates tool-level errors as kind=error', async () => {
    const reg = createRegistry([errorTool])
    const result = await reg.dispatch({
      call: { ...call, name: 'test.error' },
      sessionContext: makeCtx(),
      deps: {},
      guard: allowAllGuard(),
    })
    expect(result).toEqual({ kind: 'error', message: 'boom', code: 'test_error' })
  })

  it('enforces the tool tier (model cannot spoof a lower tier)', async () => {
    const guard: GuardLayer = {
      name: 'tier-spy',
      check: vi.fn<(call: ToolCall, ctx: SessionContext) => Promise<GuardResult>>(
        async () => ({ allowed: true }),
      ),
    }
    const reg = createRegistry([okTool])
    await reg.dispatch({
      call: { ...call, tier: 3 as any }, // model lies
      sessionContext: makeCtx(),
      deps: {},
      guard,
    })
    // Registry should have overridden the tier back to the tool's declared 1.
    expect((guard.check as any).mock.calls[0][0].tier).toBe(1)
  })
})
