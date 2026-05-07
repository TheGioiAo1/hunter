/**
 * Gbox Platform — Gift Card Email Module Unit Tests (Phase 10 PR2)
 *
 * Covers the glue between `listPendingEmailDeliveries` and
 * `sendGiftCardDelivery` — particularly:
 *
 *   - cron batch runs through every row
 *   - per-row failures don't flip the sent marker
 *   - shop-name resolution is cached
 *   - `deliverGiftCardNow` throws on the right pre-conditions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the email service module at import time so send never hits SMTP.
vi.mock('../email/service.js', () => ({
  sendGiftCardDelivery: vi.fn(),
}))

// Mock the gift-cards service module so we can inject pending rows
// without building a full Kysely mock.
vi.mock('./service.js', () => ({
  listPendingEmailDeliveries: vi.fn(),
  markGiftCardEmailSent: vi.fn(),
}))

import { deliverGiftCardNow, processPendingGiftCardEmails } from './email.js'
import * as emailService from '../email/service.js'
import * as giftCardService from './service.js'

const mockedSend = emailService.sendGiftCardDelivery as unknown as ReturnType<typeof vi.fn>
const mockedList = giftCardService.listPendingEmailDeliveries as unknown as ReturnType<typeof vi.fn>
const mockedMark = giftCardService.markGiftCardEmailSent as unknown as ReturnType<typeof vi.fn>

function makeShopMockDb(name: string) {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue({ name }),
    // deliverGiftCardNow also calls selectFrom('gift_cards') with .select(...)
    // — we return a configurable object from selectFrom below.
  }
  return chain
}

beforeEach(() => {
  mockedSend.mockReset()
  mockedList.mockReset()
  mockedMark.mockReset()
  mockedSend.mockResolvedValue('message-id-1')
  mockedMark.mockResolvedValue(undefined)
})

describe('gift-cards/email.ts', () => {
  describe('processPendingGiftCardEmails', () => {
    it('dispatches every pending row and marks them sent', async () => {
      mockedList.mockResolvedValueOnce([
        {
          id: 'gc-1',
          shop_id: 'shop-A',
          code: 'AAAA',
          recipient_email: 'a@example.com',
          recipient_name: 'Ann',
          sender_name: 'Bob',
          personal_message: 'hi',
          initial_value: '10.00',
          balance: '10.00',
          currency: 'USD',
          send_at: '2026-04-01T00:00:00Z',
          expires_at: null,
        },
        {
          id: 'gc-2',
          shop_id: 'shop-A',
          code: 'BBBB',
          recipient_email: 'b@example.com',
          recipient_name: null,
          sender_name: null,
          personal_message: null,
          initial_value: '25.00',
          balance: '25.00',
          currency: 'USD',
          send_at: '2026-04-01T00:00:00Z',
          expires_at: null,
        },
      ])

      // Mock shop name lookup for shop-A.
      const db: any = {
        selectFrom: vi.fn().mockImplementation(() => ({
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve({ name: 'Acme' }),
            }),
          }),
        })),
      }

      const result = await processPendingGiftCardEmails(db)
      expect(result.processed).toBe(2)
      expect(result.sent).toBe(2)
      expect(result.failed).toBe(0)
      expect(mockedSend).toHaveBeenCalledTimes(2)
      expect(mockedMark).toHaveBeenCalledTimes(2)
      // Shop-name lookup should be cached — 1 DB call for both rows.
      expect(db.selectFrom).toHaveBeenCalledTimes(1)
    })

    it('captures failures without marking sent', async () => {
      mockedList.mockResolvedValueOnce([
        {
          id: 'gc-3',
          shop_id: 'shop-B',
          code: 'CCCC',
          recipient_email: 'c@example.com',
          recipient_name: null,
          sender_name: null,
          personal_message: null,
          initial_value: '10.00',
          balance: '10.00',
          currency: 'USD',
          send_at: '2026-04-01T00:00:00Z',
          expires_at: null,
        },
      ])
      mockedSend.mockRejectedValueOnce(new Error('SMTP down'))

      const db: any = {
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve({ name: 'Beta' }),
            }),
          }),
        }),
      }

      const result = await processPendingGiftCardEmails(db)
      expect(result.processed).toBe(1)
      expect(result.sent).toBe(0)
      expect(result.failed).toBe(1)
      expect(result.outcomes[0]!.ok).toBe(false)
      expect(result.outcomes[0]!.error).toContain('SMTP down')
      expect(mockedMark).not.toHaveBeenCalled()
    })

    it('no-ops gracefully when the queue is empty', async () => {
      mockedList.mockResolvedValueOnce([])
      const db: any = { selectFrom: vi.fn() }
      const result = await processPendingGiftCardEmails(db)
      expect(result).toEqual({ processed: 0, sent: 0, failed: 0, outcomes: [] })
      expect(mockedSend).not.toHaveBeenCalled()
    })

    it('caches shop name across rows', async () => {
      mockedList.mockResolvedValueOnce([
        {
          id: 'gc-4',
          shop_id: 'shop-X',
          code: 'DDDD',
          recipient_email: 'd@example.com',
          recipient_name: null,
          sender_name: null,
          personal_message: null,
          initial_value: '5.00',
          balance: '5.00',
          currency: 'USD',
          send_at: '2026-04-01T00:00:00Z',
          expires_at: null,
        },
        {
          id: 'gc-5',
          shop_id: 'shop-X', // same shop
          code: 'EEEE',
          recipient_email: 'e@example.com',
          recipient_name: null,
          sender_name: null,
          personal_message: null,
          initial_value: '5.00',
          balance: '5.00',
          currency: 'USD',
          send_at: '2026-04-01T00:00:00Z',
          expires_at: null,
        },
        {
          id: 'gc-6',
          shop_id: 'shop-Y', // different shop
          code: 'FFFF',
          recipient_email: 'f@example.com',
          recipient_name: null,
          sender_name: null,
          personal_message: null,
          initial_value: '5.00',
          balance: '5.00',
          currency: 'USD',
          send_at: '2026-04-01T00:00:00Z',
          expires_at: null,
        },
      ])
      const db: any = {
        selectFrom: vi.fn().mockImplementation(() => ({
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve({ name: 'Shop Name' }),
            }),
          }),
        })),
      }
      await processPendingGiftCardEmails(db)
      // 2 lookups (shop-X once, shop-Y once), not 3
      expect(db.selectFrom).toHaveBeenCalledTimes(2)
    })
  })

  describe('deliverGiftCardNow', () => {
    function makeDbForCard(card: any, shopName = 'Acme') {
      const giftCardChain = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(card),
      }
      const shopChain = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue({ name: shopName }),
      }
      return {
        selectFrom: vi.fn().mockImplementation((table: string) => {
          if (table === 'gift_cards') return giftCardChain
          if (table === 'shops') return shopChain
          throw new Error('Unexpected table ' + table)
        }),
      } as any
    }

    it('sends + marks when the card is deliverable', async () => {
      const card = {
        id: 'gc-send',
        shop_id: 'shop-A',
        code: 'XYZ',
        recipient_email: 'r@example.com',
        recipient_name: 'R',
        sender_name: 'S',
        personal_message: null,
        initial_value: '20.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
        email_sent_at: null,
      }
      const db = makeDbForCard(card)
      const outcome = await deliverGiftCardNow(db, 'gc-send')
      expect(outcome.ok).toBe(true)
      expect(mockedSend).toHaveBeenCalledTimes(1)
      expect(mockedMark).toHaveBeenCalledWith(db, 'gc-send')
    })

    it('throws when card is missing', async () => {
      const db = makeDbForCard(null)
      await expect(deliverGiftCardNow(db, 'missing')).rejects.toThrow(/not found/i)
    })

    it('throws when disabled', async () => {
      const db = makeDbForCard({
        id: 'gc',
        shop_id: 'shop',
        code: 'X',
        recipient_email: 'x@x.com',
        recipient_name: null,
        sender_name: null,
        personal_message: null,
        initial_value: '5.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: '2025-01-01',
        email_sent_at: null,
      })
      await expect(deliverGiftCardNow(db, 'gc')).rejects.toThrow(/disabled/i)
    })

    it('throws when recipient_email is null', async () => {
      const db = makeDbForCard({
        id: 'gc',
        shop_id: 'shop',
        code: 'X',
        recipient_email: null,
        recipient_name: null,
        sender_name: null,
        personal_message: null,
        initial_value: '5.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
        email_sent_at: null,
      })
      await expect(deliverGiftCardNow(db, 'gc')).rejects.toThrow(/no recipient/i)
    })

    it('returns ok=false when send fails (no throw)', async () => {
      mockedSend.mockRejectedValueOnce(new Error('connect timeout'))
      const db = makeDbForCard({
        id: 'gc-fail',
        shop_id: 'shop',
        code: 'X',
        recipient_email: 'r@x.com',
        recipient_name: null,
        sender_name: null,
        personal_message: null,
        initial_value: '5.00',
        currency: 'USD',
        expires_at: null,
        disabled_at: null,
        email_sent_at: null,
      })
      const outcome = await deliverGiftCardNow(db, 'gc-fail')
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.error).toContain('connect timeout')
      }
      expect(mockedMark).not.toHaveBeenCalled()
    })
  })
})
