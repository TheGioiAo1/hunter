/**
 * POST /agent/approval route tests — pure handler, no server startup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApprovalRoute } from './approval.ts'
import type { ApprovalRegistry } from '../approval-registry.ts'

function makeRegistry(overrides: Partial<ApprovalRegistry> = {}): ApprovalRegistry {
  return {
    register: vi.fn(() => () => {}),
    resolve: vi.fn(() => true),
    size: vi.fn(() => 0),
    ...overrides,
  } as ApprovalRegistry
}

function makeRes() {
  const status = vi.fn()
  const json = vi.fn()
  const res: any = { status, json }
  status.mockImplementation(() => res)
  return res
}

describe('POST /agent/approval', () => {
  let registry: ApprovalRegistry
  let route: ReturnType<typeof createApprovalRoute>

  beforeEach(() => {
    registry = makeRegistry()
    route = createApprovalRoute({ approvalRegistry: registry })
  })

  it('returns 200 and resolves the registry entry', () => {
    const res = makeRes()
    route(
      { body: { aid: 'a1', toolCallId: 't1', decision: 'approved' } } as any,
      res,
    )
    expect(registry.resolve).toHaveBeenCalledWith('a1', 't1', 'approved')
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ ok: true })
  })

  it('accepts denied decisions', () => {
    const res = makeRes()
    route(
      { body: { aid: 'a1', toolCallId: 't1', decision: 'denied' } } as any,
      res,
    )
    expect(registry.resolve).toHaveBeenCalledWith('a1', 't1', 'denied')
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('returns 404 when the registry has no pending entry', () => {
    registry = makeRegistry({ resolve: vi.fn(() => false) })
    route = createApprovalRoute({ approvalRegistry: registry })
    const res = makeRes()
    route(
      { body: { aid: 'a1', toolCallId: 'stale', decision: 'approved' } } as any,
      res,
    )
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'no_pending_approval' })
  })

  it('rejects missing aid with 400', () => {
    const res = makeRes()
    route({ body: { toolCallId: 't1', decision: 'approved' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_body', reason: expect.stringMatching(/aid/) }),
    )
    expect(registry.resolve).not.toHaveBeenCalled()
  })

  it('rejects missing toolCallId with 400', () => {
    const res = makeRes()
    route({ body: { aid: 'a1', decision: 'approved' } } as any, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringMatching(/toolCallId/) }),
    )
  })

  it('rejects unknown decision values with 400', () => {
    const res = makeRes()
    route(
      { body: { aid: 'a1', toolCallId: 't1', decision: 'maybe' } } as any,
      res,
    )
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringMatching(/approved/) }),
    )
  })

  it('rejects empty body with 400', () => {
    const res = makeRes()
    route({ body: undefined } as any, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })
})
