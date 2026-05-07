import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createApprovalGate, type ApprovalEvent } from './approval-gate.ts'
import type { SessionContext, ToolCall } from './types.ts'

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
    currentTime: new Date('2026-04-10T10:00:00Z'),
    repoRoot: '/tmp/repo',
    crossRepoRoots: [],
  }
}

function tool(name: string, tier: 1 | 2 | 3 | 4, input: unknown = {}): ToolCall {
  return { id: 'tc1', name, input, tier }
}

describe('approvalGate', () => {
  it('passes through tier-1 calls without emitting', async () => {
    const em = new EventEmitter()
    const spy = vi.fn()
    em.on('approval_required', spy)
    const gate = createApprovalGate(em)

    const r = await gate.check(tool('repo.read', 1), ctx())
    expect(r).toEqual({ allowed: true })
    expect(spy).not.toHaveBeenCalled()
  })

  it('passes through tier-2 calls without emitting', async () => {
    const em = new EventEmitter()
    const spy = vi.fn()
    em.on('approval_required', spy)
    const gate = createApprovalGate(em)

    const r = await gate.check(tool('repo.grep', 2), ctx())
    expect(r).toEqual({ allowed: true })
    expect(spy).not.toHaveBeenCalled()
  })

  it('emits approval_required on tier-3 and resolves to approved', async () => {
    const em = new EventEmitter()
    const gate = createApprovalGate(em)

    em.once('approval_required', (evt: ApprovalEvent) => {
      expect(evt.toolCallId).toBe('tc1')
      expect(evt.name).toBe('repo.edit')
      expect(evt.doubleConfirm).toBe(false)
      queueMicrotask(() => gate.resolveApproval('tc1', 'approved'))
    })

    const r = await gate.check(tool('repo.edit', 3, { path: 'a.ts' }), ctx())
    expect(r).toEqual({ allowed: true })
  })

  it('resolveApproval("denied") rejects the pending call', async () => {
    const em = new EventEmitter()
    const gate = createApprovalGate(em)

    em.once('approval_required', () => {
      queueMicrotask(() => gate.resolveApproval('tc1', 'denied'))
    })

    const r = await gate.check(tool('repo.edit', 3, { path: 'a.ts' }), ctx())
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.layer).toBe('approval-gate')
      expect(r.reason).toMatch(/denied/i)
    }
  })

  it('times out after the configured window if no decision arrives', async () => {
    vi.useFakeTimers()
    const em = new EventEmitter()
    const gate = createApprovalGate(em, { timeoutMs: 120_000 })

    const pending = gate.check(tool('repo.edit', 3, { path: 'a.ts' }), ctx())
    // Advance past the timeout before resolving.
    await vi.advanceTimersByTimeAsync(120_001)
    const r = await pending
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/timeout/i)
    vi.useRealTimers()
  })

  it('sets doubleConfirm=true for git.push to main branch', async () => {
    const em = new EventEmitter()
    const gate = createApprovalGate(em)
    let captured: ApprovalEvent | null = null
    em.once('approval_required', (evt: ApprovalEvent) => {
      captured = evt
      queueMicrotask(() => gate.resolveApproval('tc1', 'approved'))
    })

    await gate.check(tool('git.push', 3, { branch: 'main', remote: 'origin' }), ctx())
    expect(captured).not.toBeNull()
    expect(captured!.doubleConfirm).toBe(true)
  })

  it('does NOT set doubleConfirm for git.push to a feature branch', async () => {
    const em = new EventEmitter()
    const gate = createApprovalGate(em)
    let captured: ApprovalEvent | null = null
    em.once('approval_required', (evt: ApprovalEvent) => {
      captured = evt
      queueMicrotask(() => gate.resolveApproval('tc1', 'approved'))
    })

    await gate.check(tool('git.push', 3, { branch: 'feat/x', remote: 'origin' }), ctx())
    expect(captured!.doubleConfirm).toBe(false)
  })

  it('rejects tier-4 calls outright (disabled in 9.2)', async () => {
    const em = new EventEmitter()
    const gate = createApprovalGate(em)
    const r = await gate.check(tool('shell.root', 4), ctx())
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/tier.?4|disabled/i)
  })

  it('emits payload with normalized input (not raw), not the ToolCall object', async () => {
    const em = new EventEmitter()
    const gate = createApprovalGate(em)
    let captured: ApprovalEvent | null = null
    em.once('approval_required', (evt: ApprovalEvent) => {
      captured = evt
      queueMicrotask(() => gate.resolveApproval('tc1', 'approved'))
    })
    await gate.check(tool('repo.edit', 3, { path: 'a.ts', content: 'new' }), ctx())
    expect(captured!.normalizedInput).toEqual({ path: 'a.ts', content: 'new' })
  })
})
