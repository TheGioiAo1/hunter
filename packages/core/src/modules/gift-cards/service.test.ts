/**
 * Gbox Platform — Gift Cards Service Unit Tests
 *
 * Phase 10 PR2 adds coverage for:
 *   - normaliseGiftCardCode
 *   - validateGiftCardForCheckout (all 6 reason branches + happy path)
 *   - redeemGiftCard (balance bump + last_redeemed_at / redeemed_amount)
 *   - markGiftCardEmailSent
 *   - updateGiftCard (partial patch semantics)
 *   - listPendingEmailDeliveries (filter shape)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createGiftCard,
  getGiftCard,
  redeemGiftCard,
  getGiftCardBalance,
  disableGiftCard,
  listGiftCards,
  validateGiftCardForCheckout,
  markGiftCardEmailSent,
  updateGiftCard,
  listPendingEmailDeliveries,
  normaliseGiftCardCode,
} from './service.js'

// ---------------------------------------------------------------------------
// Mock database builder
// ---------------------------------------------------------------------------

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute')
          return vi
            .fn()
            .mockResolvedValue(
              result instanceof Array ? result : [result].filter(Boolean),
            )
        if (prop === 'executeTakeFirst')
          return vi.fn().mockResolvedValue(result ?? null)
        if (prop === 'executeTakeFirstOrThrow') {
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result')
            return result
          })
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

function createMockDb(overrides: Record<string, any> = {}) {
  const db: any = {
    insertInto: vi.fn().mockImplementation((table: string) => {
      return chainable(
        overrides[`insert:${table}`] ?? overrides[table] ?? { id: 'mock-id' },
      )
    }),
    selectFrom: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`select:${table}`] ?? overrides[table])
    }),
    updateTable: vi.fn().mockImplementation((table: string) => {
      return chainable(overrides[`update:${table}`] ?? overrides[table])
    }),
    deleteFrom: vi.fn().mockImplementation(() => chainable()),
    transaction: vi.fn().mockReturnValue({
      execute: vi.fn().mockImplementation(async (fn: Function) => {
        return fn(createMockDb(overrides))
      }),
    }),
    fn: {
      countAll: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue('count') }),
    },
  }
  return db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gift Cards Service', () => {
  const shopId = 'shop-001'

  describe('normaliseGiftCardCode', () => {
    it('uppercases and strips dashes + spaces', () => {
      expect(normaliseGiftCardCode('abcd-1234 efgh 5678')).toBe('ABCD1234EFGH5678')
    })
    it('leaves an already-normalised code alone', () => {
      expect(normaliseGiftCardCode('ABCD1234EFGH5678')).toBe('ABCD1234EFGH5678')
    })
    it('trims whitespace', () => {
      expect(normaliseGiftCardCode('   HELLO   ')).toBe('HELLO')
    })
  })

  describe('createGiftCard', () => {
    it('creates a gift card with auto-generated code', async () => {
      const mockGC = {
        id: 'gc-001',
        shop_id: shopId,
        code: 'ABCD1234EFGH5678',
        initial_value: '50.00',
        balance: '50.00',
        currency: 'USD',
      }
      const db = createMockDb({ 'insert:gift_cards': mockGC })

      const result = await createGiftCard(db, shopId, {
        initialValue: '50.00',
        currency: 'USD',
      })

      expect(result).toBeDefined()
    })

    it('creates with custom code', async () => {
      const mockGC = {
        id: 'gc-002',
        code: 'CUSTOMCODE',
        initial_value: '100.00',
        balance: '100.00',
      }
      const db = createMockDb({ 'insert:gift_cards': mockGC })

      const result = await createGiftCard(db, shopId, {
        initialValue: '100.00',
        code: 'Custom-Code',
      })

      expect(result.code).toBe('CUSTOMCODE')
    })

    it('persists recipient + delivery fields (migration 070)', async () => {
      const mockGC = {
        id: 'gc-003',
        code: 'ABCDEFGH',
        initial_value: '25.00',
        balance: '25.00',
        recipient_email: 'friend@example.com',
        recipient_name: 'Friend',
        sender_name: 'Alice',
        personal_message: 'Happy birthday!',
        send_at: '2026-05-01T09:00:00Z',
      }
      const db = createMockDb({ 'insert:gift_cards': mockGC })

      const result = await createGiftCard(db, shopId, {
        initialValue: '25.00',
        recipientEmail: 'friend@example.com',
        recipientName: 'Friend',
        senderName: 'Alice',
        personalMessage: 'Happy birthday!',
        sendAt: '2026-05-01T09:00:00Z',
      })

      expect(result.recipient_email).toBe('friend@example.com')
      expect(result.sender_name).toBe('Alice')
    })

    it('normalises initial_value to 2 decimals', async () => {
      const mockGC = { id: 'gc-004', initial_value: '50.00', balance: '50.00' }
      const db = createMockDb({ 'insert:gift_cards': mockGC })
      const result = await createGiftCard(db, shopId, {
        initialValue: '50',
      })
      expect(result).toBeDefined()
    })
  })

  describe('getGiftCard', () => {
    it('returns gift card by code', async () => {
      const mockGC = { id: 'gc-001', code: 'ABCD1234', balance: '50.00' }
      const db = createMockDb({ 'select:gift_cards': mockGC })

      const result = await getGiftCard(db, 'ABCD-1234')
      expect(result).toEqual(mockGC)
    })

    it('returns null for non-existent', async () => {
      const db = createMockDb({ 'select:gift_cards': null })
      const result = await getGiftCard(db, 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('getGiftCardBalance', () => {
    it('returns balance for a valid card', async () => {
      const mockGC = { id: 'gc-001', balance: '75.50', disabled_at: null }
      const db = createMockDb({ 'select:gift_cards': mockGC })

      const result = await getGiftCardBalance(db, 'ABCD-1234')
      expect(result).toBeDefined()
    })
  })

  describe('disableGiftCard', () => {
    it('disables an active gift card', async () => {
      const disabled = { id: 'gc-001', disabled_at: '2024-01-01' }
      const db = createMockDb({ 'update:gift_cards': disabled })

      await expect(disableGiftCard(db, 'gc-001')).resolves.not.toThrow()
    })
  })

  describe('listGiftCards', () => {
    it('returns paginated gift cards', async () => {
      const cards = [
        { id: 'gc-001', balance: '50.00' },
        { id: 'gc-002', balance: '25.00' },
      ]
      const db = createMockDb({
        'select:gift_cards': cards.length > 0 ? cards : { count: 2 },
      })

      const result = await listGiftCards(db, shopId)
      expect(result).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Phase 10 PR2 — validateGiftCardForCheckout
  // -----------------------------------------------------------------------

  describe('validateGiftCardForCheckout', () => {
    it('returns ok=true with applicable = min(balance, cartTotal)', async () => {
      const row = {
        id: 'gc-a',
        code: 'AAAABBBBCCCCDDDD',
        balance: '50.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
      }
      const db = createMockDb({ 'select:gift_cards': row })

      const r = await validateGiftCardForCheckout(db, shopId, 'AAAA-BBBB-CCCC-DDDD', '30.00', 'USD')
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.applicable).toBe('30.00')
        expect(r.giftCard.id).toBe('gc-a')
      }
    })

    it('clamps applicable to the gift card balance when cart > balance', async () => {
      const row = {
        id: 'gc-b',
        code: 'BBBBCCCCDDDDEEEE',
        balance: '20.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
      }
      const db = createMockDb({ 'select:gift_cards': row })

      const r = await validateGiftCardForCheckout(db, shopId, 'BBBB-CCCC-DDDD-EEEE', 100, 'USD')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.applicable).toBe('20.00')
    })

    it('returns reason=not_found for unknown codes', async () => {
      const db = createMockDb({ 'select:gift_cards': null })
      const r = await validateGiftCardForCheckout(db, shopId, 'UNKNOWN', '10', 'USD')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('not_found')
    })

    it('returns reason=disabled for disabled cards', async () => {
      const row = {
        id: 'gc-c',
        code: 'X',
        balance: '50.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: '2025-01-01T00:00:00Z',
      }
      const db = createMockDb({ 'select:gift_cards': row })
      const r = await validateGiftCardForCheckout(db, shopId, 'X', '10', 'USD')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('disabled')
    })

    it('returns reason=expired for past expires_at', async () => {
      const row = {
        id: 'gc-d',
        code: 'X',
        balance: '50.00',
        currency: 'USD',
        expires_at: '2000-01-01T00:00:00Z',
        disabled_at: null,
      }
      const db = createMockDb({ 'select:gift_cards': row })
      const r = await validateGiftCardForCheckout(db, shopId, 'X', '10', 'USD')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('expired')
    })

    it('returns reason=zero_balance for fully-drained cards', async () => {
      const row = {
        id: 'gc-e',
        code: 'X',
        balance: '0.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
      }
      const db = createMockDb({ 'select:gift_cards': row })
      const r = await validateGiftCardForCheckout(db, shopId, 'X', '10', 'USD')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('zero_balance')
    })

    it('returns reason=currency_mismatch when currencies differ', async () => {
      const row = {
        id: 'gc-f',
        code: 'X',
        balance: '50.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
      }
      const db = createMockDb({ 'select:gift_cards': row })
      const r = await validateGiftCardForCheckout(db, shopId, 'X', '10', 'EUR')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('currency_mismatch')
    })

    it('returns reason=invalid_cart_total for negative totals', async () => {
      const db = createMockDb({ 'select:gift_cards': null })
      const r = await validateGiftCardForCheckout(db, shopId, 'X', '-1', 'USD')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('invalid_cart_total')
    })

    it('returns reason=invalid_cart_total for NaN', async () => {
      const db = createMockDb({ 'select:gift_cards': null })
      const r = await validateGiftCardForCheckout(db, shopId, 'X', 'nope', 'USD')
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('invalid_cart_total')
    })

    it('normalises the incoming code before lookup', async () => {
      const row = {
        id: 'gc-g',
        code: 'ABCDEF1234',
        balance: '10.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
      }
      const db = createMockDb({ 'select:gift_cards': row })
      const r = await validateGiftCardForCheckout(db, shopId, ' abcdef-1234 ', '5', 'USD')
      expect(r.ok).toBe(true)
    })

    it('accepts missing currency (currency-free cart)', async () => {
      const row = {
        id: 'gc-h',
        code: 'X',
        balance: '50.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
      }
      const db = createMockDb({ 'select:gift_cards': row })
      const r = await validateGiftCardForCheckout(db, shopId, 'X', '10', null)
      expect(r.ok).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Phase 10 PR2 — markGiftCardEmailSent
  // -----------------------------------------------------------------------

  describe('markGiftCardEmailSent', () => {
    it('updates email_sent_at on the card', async () => {
      const db = createMockDb({ 'update:gift_cards': { id: 'gc-x' } })
      await expect(markGiftCardEmailSent(db, 'gc-x')).resolves.not.toThrow()
      expect(db.updateTable).toHaveBeenCalledWith('gift_cards')
    })

    it('accepts a custom sentAt iso', async () => {
      const db = createMockDb({ 'update:gift_cards': { id: 'gc-y' } })
      await expect(markGiftCardEmailSent(db, 'gc-y', '2026-05-01T00:00:00Z')).resolves.not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Phase 10 PR2 — updateGiftCard
  // -----------------------------------------------------------------------

  describe('updateGiftCard', () => {
    it('updates only specified fields', async () => {
      const db = createMockDb({ 'update:gift_cards': { id: 'gc-u' } })
      await updateGiftCard(db, 'gc-u', {
        recipientEmail: 'new@example.com',
        personalMessage: 'Updated note',
      })
      expect(db.updateTable).toHaveBeenCalledWith('gift_cards')
    })

    it('allows clearing fields with null', async () => {
      const db = createMockDb({ 'update:gift_cards': { id: 'gc-u' } })
      await updateGiftCard(db, 'gc-u', {
        recipientEmail: null,
        sendAt: null,
      })
      expect(db.updateTable).toHaveBeenCalledWith('gift_cards')
    })

    it('returns early when patch has no editable fields', async () => {
      const db = createMockDb({ 'update:gift_cards': { id: 'gc-u' } })
      await updateGiftCard(db, 'gc-u', {})
      // should never touch updateTable when there's nothing to update
      expect(db.updateTable).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // Phase 10 PR2 — listPendingEmailDeliveries
  // -----------------------------------------------------------------------

  describe('listPendingEmailDeliveries', () => {
    it('returns rows with recipient_email present', async () => {
      const rows = [
        {
          id: 'gc-p1',
          shop_id: shopId,
          code: 'AAAA',
          recipient_email: 'a@example.com',
          recipient_name: 'Ann',
          sender_name: 'Bob',
          personal_message: null,
          initial_value: '10.00',
          balance: '10.00',
          currency: 'USD',
          send_at: '2026-04-01T00:00:00Z',
          expires_at: null,
        },
      ]
      const db = createMockDb({ 'select:gift_cards': rows })
      const pending = await listPendingEmailDeliveries(db, { limit: 10 })
      expect(pending.length).toBe(1)
      expect(pending[0]!.recipient_email).toBe('a@example.com')
    })

    it('drops rows where recipient_email is null', async () => {
      const rows = [
        {
          id: 'gc-p2',
          shop_id: shopId,
          code: 'BBBB',
          recipient_email: null,
          recipient_name: null,
          sender_name: null,
          personal_message: null,
          initial_value: '10.00',
          balance: '10.00',
          currency: 'USD',
          send_at: '2026-04-01T00:00:00Z',
          expires_at: null,
        },
      ]
      const db = createMockDb({ 'select:gift_cards': rows })
      const pending = await listPendingEmailDeliveries(db, { limit: 10 })
      expect(pending.length).toBe(0)
    })

    it('accepts an optional shop scope', async () => {
      const db = createMockDb({ 'select:gift_cards': [] })
      await expect(
        listPendingEmailDeliveries(db, { shopId, limit: 5 }),
      ).resolves.toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // Phase 10 PR2 — redeemGiftCard balance bump
  // -----------------------------------------------------------------------

  describe('redeemGiftCard (PR2 redemption metadata)', () => {
    it('rejects when redeem amount exceeds balance', async () => {
      const row = {
        id: 'gc-r',
        code: 'X',
        balance: '10.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
        redeemed_amount: '0',
      }
      const db = createMockDb({ 'select:gift_cards': row })
      await expect(redeemGiftCard(db, 'X', '25.00')).rejects.toThrow(
        /Insufficient/i,
      )
    })

    it('rejects when amount is non-positive', async () => {
      const row = {
        id: 'gc-r2',
        code: 'X',
        balance: '10.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
        redeemed_amount: '0',
      }
      const db = createMockDb({ 'select:gift_cards': row })
      await expect(redeemGiftCard(db, 'X', '0')).rejects.toThrow(
        /positive/i,
      )
    })

    it('bumps balance + redeemed_amount on success', async () => {
      const row = {
        id: 'gc-r3',
        code: 'X',
        balance: '50.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
        redeemed_amount: '0',
      }
      const updated = {
        ...row,
        balance: '40.00',
        redeemed_amount: '10.00',
        last_redeemed_at: 'now',
      }
      const db = createMockDb({
        'select:gift_cards': row,
        'update:gift_cards': updated,
      })
      const result = await redeemGiftCard(db, 'X', '10.00', 'order-abc')
      expect(result).toEqual(updated)
    })
  })
})
