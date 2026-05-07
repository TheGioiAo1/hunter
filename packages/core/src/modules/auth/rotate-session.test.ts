/**
 * Gbox Platform — Session Rotation Tests (Phase 7.3)
 *
 * Iron Rule #1: "Session tokens: 64-char hex, rotated on privilege
 * change". This module locks down the rotation contract:
 *
 *   1. New session is created BEFORE the old one is deleted
 *      (no "logged out for free" window).
 *   2. If create fails, the old session is left intact and the
 *      caller sees the error.
 *   3. If create succeeds but delete fails, we still return the
 *      new token — the old one is dead-but-uncollected and will be
 *      reaped by `cleanExpiredSessions` next cycle.
 */

import { describe, it, expect, vi } from 'vitest'
import { rotateSession, type RotateSessionDeps } from './rotate-session.js'

function makeDeps(
  overrides: Partial<RotateSessionDeps> = {},
): RotateSessionDeps {
  return {
    createSession: vi.fn(async () => ({
      token: 'new-token-' + Math.random().toString(36).slice(2),
      expiresAt: new Date('2026-05-09T00:00:00Z'),
    })),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('rotateSession', () => {
  it('creates the new session before deleting the old one', async () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      createSession: vi.fn(async () => {
        callOrder.push('create')
        return { token: 'new-tok', expiresAt: new Date() }
      }),
      deleteSession: vi.fn(async () => {
        callOrder.push('delete')
      }),
    })

    await rotateSession(
      { oldToken: 'old-tok', userId: 'usr_1', meta: {} },
      deps,
    )

    expect(callOrder).toEqual(['create', 'delete'])
  })

  it('returns the new token + expiresAt', async () => {
    const expiresAt = new Date('2026-05-09T00:00:00Z')
    const deps = makeDeps({
      createSession: vi.fn(async () => ({ token: 'new-tok', expiresAt })),
    })

    const result = await rotateSession(
      { oldToken: 'old-tok', userId: 'usr_1', meta: {} },
      deps,
    )

    expect(result.token).toBe('new-tok')
    expect(result.expiresAt).toEqual(expiresAt)
  })

  it('forwards meta (ip + user agent) to createSession', async () => {
    const create = vi.fn(async () => ({
      token: 'new-tok',
      expiresAt: new Date(),
    }))
    const deps = makeDeps({ createSession: create })

    await rotateSession(
      {
        oldToken: 'old',
        userId: 'usr_1',
        meta: { ipAddress: '203.0.113.5', userAgent: 'Mozilla/5.0' },
      },
      deps,
    )

    expect(create).toHaveBeenCalledWith('usr_1', {
      ipAddress: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
    })
  })

  it('does NOT delete the old session when create fails', async () => {
    const deleteFn = vi.fn(async () => {})
    const deps = makeDeps({
      createSession: vi.fn(async () => {
        throw new Error('DB unreachable')
      }),
      deleteSession: deleteFn,
    })

    await expect(
      rotateSession(
        { oldToken: 'old-tok', userId: 'usr_1', meta: {} },
        deps,
      ),
    ).rejects.toThrow('DB unreachable')

    expect(deleteFn).not.toHaveBeenCalled()
  })

  it('still returns the new token when delete fails (best-effort cleanup)', async () => {
    const deps = makeDeps({
      deleteSession: vi.fn(async () => {
        throw new Error('delete blew up')
      }),
    })

    // Should NOT throw — new token works, old token will get
    // garbage-collected by the cleanup cron.
    const result = await rotateSession(
      { oldToken: 'old-tok', userId: 'usr_1', meta: {} },
      deps,
    )

    expect(result.token).toMatch(/^new-token-/)
  })

  it('reports the partial-success state via the result.partialFailure flag', async () => {
    const deps = makeDeps({
      deleteSession: vi.fn(async () => {
        throw new Error('redis flaky')
      }),
    })

    const result = await rotateSession(
      { oldToken: 'old-tok', userId: 'usr_1', meta: {} },
      deps,
    )

    expect(result.partialFailure).toBeDefined()
    expect(result.partialFailure?.stage).toBe('delete_old')
    expect(result.partialFailure?.message).toContain('redis flaky')
  })

  it('skips deletion entirely when oldToken is empty string', async () => {
    // Use case: a brand-new login that has no prior session.
    // Skipping the no-op delete avoids spurious "delete failed"
    // alerts in audit logs.
    const deleteFn = vi.fn(async () => {})
    const deps = makeDeps({ deleteSession: deleteFn })

    const result = await rotateSession(
      { oldToken: '', userId: 'usr_1', meta: {} },
      deps,
    )

    expect(result.token).toMatch(/^new-token-/)
    expect(deleteFn).not.toHaveBeenCalled()
  })
})
