/**
 * Gbox Platform — support service unit tests.
 *
 * This file pins the **pure** surface of `service.ts` — validation +
 * state-machine edges — so we catch spec drift without needing a live
 * Postgres. End-to-end coverage of createTicket/addMessage/claim/etc
 * lives in `scripts/smoke-phase12-5-pr1.ts`.
 */
import { describe, it, expect } from 'vitest'
import { ALLOWED_TRANSITIONS, validateAddMessage, validateCreateTicket } from './service.ts'
import { SupportError } from './types.ts'

function expectSupportError(fn: () => void, code: string, pattern?: RegExp): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(SupportError)
  expect((caught as SupportError).code).toBe(code)
  if (pattern) expect((caught as SupportError).message).toMatch(pattern)
}

describe('validateCreateTicket', () => {
  const valid = {
    shopId: 'shop-1',
    openerUserId: 'user-1',
    category: 'payment' as const,
    subject: 'Refund not processed',
    body: 'Order #1234 paid via PayPal 3 days ago, refund still pending.',
  }

  it('accepts a valid payload', () => {
    expect(() => validateCreateTicket(valid)).not.toThrow()
  })

  it('rejects missing shopId', () => {
    expectSupportError(
      () => validateCreateTicket({ ...valid, shopId: '' }),
      'INVALID_INPUT',
      /shopId/,
    )
  })

  it('rejects missing openerUserId', () => {
    expectSupportError(
      () => validateCreateTicket({ ...valid, openerUserId: '' }),
      'INVALID_INPUT',
      /openerUserId/,
    )
  })

  it('rejects missing category', () => {
    expectSupportError(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => validateCreateTicket({ ...valid, category: '' as any }),
      'INVALID_INPUT',
      /category/,
    )
  })

  it('rejects empty subject', () => {
    expectSupportError(
      () => validateCreateTicket({ ...valid, subject: '   ' }),
      'INVALID_INPUT',
      /subject/,
    )
  })

  it('rejects subject > 120 chars', () => {
    expectSupportError(
      () => validateCreateTicket({ ...valid, subject: 'x'.repeat(121) }),
      'INVALID_INPUT',
      /subject too long/,
    )
  })

  it('rejects empty body', () => {
    expectSupportError(
      () => validateCreateTicket({ ...valid, body: '\n\n   \t' }),
      'INVALID_INPUT',
      /body/,
    )
  })

  it('rejects body > 8000 chars', () => {
    expectSupportError(
      () => validateCreateTicket({ ...valid, body: 'x'.repeat(8001) }),
      'INVALID_INPUT',
      /body too long/,
    )
  })

  it('collects every failure into one message', () => {
    let err: unknown
    try {
      validateCreateTicket({
        shopId: '',
        openerUserId: '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        category: '' as any,
        subject: '',
        body: '',
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SupportError)
    expect((err as SupportError).message).toContain('shopId')
    expect((err as SupportError).message).toContain('openerUserId')
    expect((err as SupportError).message).toContain('category')
    expect((err as SupportError).message).toContain('subject')
    expect((err as SupportError).message).toContain('body')
  })
})

describe('validateAddMessage', () => {
  const valid = {
    ticketId: 'ticket-1',
    senderType: 'seller' as const,
    senderUserId: 'user-1',
    body: 'Hi, any update?',
  }

  it('accepts a valid payload', () => {
    expect(() => validateAddMessage(valid)).not.toThrow()
  })

  it('rejects missing ticketId', () => {
    expectSupportError(
      () => validateAddMessage({ ...valid, ticketId: '' }),
      'INVALID_INPUT',
      /ticketId/,
    )
  })

  it('rejects missing senderType', () => {
    expectSupportError(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => validateAddMessage({ ...valid, senderType: '' as any }),
      'INVALID_INPUT',
      /senderType/,
    )
  })

  it('rejects empty body', () => {
    expectSupportError(
      () => validateAddMessage({ ...valid, body: '   ' }),
      'INVALID_INPUT',
      /body/,
    )
  })

  it('rejects body > 8000 chars', () => {
    expectSupportError(
      () => validateAddMessage({ ...valid, body: 'x'.repeat(8001) }),
      'INVALID_INPUT',
      /body too long/,
    )
  })

  it('rejects mentions on non-internal-note messages', () => {
    expectSupportError(
      () =>
        validateAddMessage({
          ...valid,
          senderType: 'agent',
          mentionedUserIds: ['u-2'],
        }),
      'INVALID_INPUT',
      /mentions only allowed on internal notes/,
    )
  })

  it('allows mentions on internal notes', () => {
    expect(() =>
      validateAddMessage({
        ...valid,
        senderType: 'agent_internal_note',
        mentionedUserIds: ['u-2', 'u-3'],
      }),
    ).not.toThrow()
  })

  it('allows system sender with no mentions', () => {
    expect(() =>
      validateAddMessage({
        ...valid,
        senderType: 'system',
        senderUserId: null,
      }),
    ).not.toThrow()
  })
})

describe('ALLOWED_TRANSITIONS (state machine)', () => {
  it('open → pending_agent/pending_seller/resolved/closed/merged', () => {
    expect(new Set(ALLOWED_TRANSITIONS.open)).toEqual(
      new Set(['pending_agent', 'pending_seller', 'resolved', 'closed', 'merged']),
    )
  })

  it('pending_agent → pending_seller/resolved/closed/merged (no back to open)', () => {
    expect(ALLOWED_TRANSITIONS.pending_agent).not.toContain('open')
    expect(ALLOWED_TRANSITIONS.pending_agent).toContain('pending_seller')
    expect(ALLOWED_TRANSITIONS.pending_agent).toContain('resolved')
    expect(ALLOWED_TRANSITIONS.pending_agent).toContain('closed')
    expect(ALLOWED_TRANSITIONS.pending_agent).toContain('merged')
  })

  it('pending_seller → pending_agent/resolved/closed/merged', () => {
    expect(ALLOWED_TRANSITIONS.pending_seller).toContain('pending_agent')
    expect(ALLOWED_TRANSITIONS.pending_seller).toContain('resolved')
  })

  it('resolved can go back to pending_agent (when seller re-opens a dispute)', () => {
    expect(ALLOWED_TRANSITIONS.resolved).toContain('pending_agent')
    expect(ALLOWED_TRANSITIONS.resolved).toContain('closed')
  })

  it('closed only edge is reopen (open)', () => {
    expect(ALLOWED_TRANSITIONS.closed).toEqual(['open'])
  })

  it('merged is terminal (no outbound edges)', () => {
    expect(ALLOWED_TRANSITIONS.merged).toEqual([])
  })

  it('every status is present as a key', () => {
    const keys = Object.keys(ALLOWED_TRANSITIONS).sort()
    expect(keys).toEqual(
      ['closed', 'merged', 'open', 'pending_agent', 'pending_seller', 'resolved'].sort(),
    )
  })

  it('no self-loops declared', () => {
    for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(tos).not.toContain(from)
    }
  })
})
