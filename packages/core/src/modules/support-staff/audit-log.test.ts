/**
 * Audit log writer — tests.
 *
 * DB round-trips aren't exercised here — those ride on the PR3 smoke.
 * We pin the write-failure contract (never throws) and the
 * specialized `logPermissionDenied` mapper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logPermissionDenied, logStaffAction } from './audit-log.ts'

describe('logStaffAction — fails gracefully', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when the DB insert throws', async () => {
    const db = {
      insertInto: () => {
        throw new Error('DB down')
      },
    } as any
    const id = await logStaffAction(db, {
      actorUserId: 'u1',
      actorPreset: 'l1_support',
      action: 'ticket.reply',
      targetTicketId: 't1',
    })
    expect(id).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })

  it('returns the inserted id on success', async () => {
    const db = {
      insertInto: () => ({
        values: () => ({
          returning: () => ({
            executeTakeFirst: async () => ({ id: 42n }),
          }),
        }),
      }),
    } as any
    const id = await logStaffAction(db, {
      actorUserId: 'u1',
      actorPreset: 'l1_support',
      action: 'ticket.reply',
      targetTicketId: 't1',
    })
    expect(id).toBe('42')
  })

  it('truncates over-long request_path and user_agent', async () => {
    let capturedValues: any = null
    const db = {
      insertInto: () => ({
        values: (v: any) => {
          capturedValues = v
          return {
            returning: () => ({ executeTakeFirst: async () => ({ id: 1n }) }),
          }
        },
      }),
    } as any
    await logStaffAction(db, {
      actorUserId: null,
      actorPreset: null,
      action: 'perm.deny',
      requestPath: '/' + 'a'.repeat(600),
      userAgent: 'z'.repeat(600),
    })
    expect(capturedValues.request_path.length).toBe(500)
    expect(capturedValues.user_agent.length).toBe(500)
  })
})

describe('logPermissionDenied', () => {
  it('maps to action=perm.deny with scope as deny_reason', async () => {
    let captured: any = null
    const db = {
      insertInto: () => ({
        values: (v: any) => {
          captured = v
          return {
            returning: () => ({ executeTakeFirst: async () => ({ id: 7n }) }),
          }
        },
      }),
    } as any
    await logPermissionDenied(db, {
      actorUserId: 'u1',
      actorPreset: 'l1_support',
      scope: 'support:shop:orders_read',
      requestPath: '/shop/x/orders',
      requestMethod: 'GET',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    })
    expect(captured.action).toBe('perm.deny')
    expect(captured.deny_reason).toBe('support:shop:orders_read')
    expect(captured.actor_user_id).toBe('u1')
    expect(captured.actor_preset).toBe('l1_support')
    expect(captured.request_path).toBe('/shop/x/orders')
    expect(captured.request_method).toBe('GET')
    expect(captured.ip_address).toBe('127.0.0.1')
    expect(captured.user_agent).toBe('vitest')
    expect(captured.details).toEqual({ scope: 'support:shop:orders_read' })
  })
})
