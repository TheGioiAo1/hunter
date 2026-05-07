/**
 * Gbox Platform — Shop Review Settings Unit Tests (Phase 10 PR3)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  getShopReviewSettings,
  upsertShopReviewSettings,
  resolveVoteSalt,
  _SHOP_REVIEW_SETTINGS_DEFAULTS,
} from './settings.js'

function chainable(result: any = undefined) {
  const obj: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute')
          return vi
            .fn()
            .mockResolvedValue(Array.isArray(result) ? result : [result].filter(Boolean))
        if (prop === 'executeTakeFirst')
          return vi.fn().mockResolvedValue(result ?? null)
        if (prop === 'executeTakeFirstOrThrow')
          return vi.fn().mockImplementation(async () => {
            if (result == null) throw new Error('no result')
            return result
          })
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

function createMockDb(overrides: Record<string, any> = {}) {
  const db: any = {
    insertInto: vi.fn((t: string) =>
      chainable(overrides[`insert:${t}`] ?? overrides[t] ?? { ok: true }),
    ),
    selectFrom: vi.fn((t: string) =>
      chainable(overrides[`select:${t}`] ?? overrides[t]),
    ),
    updateTable: vi.fn((t: string) =>
      chainable(overrides[`update:${t}`] ?? overrides[t] ?? { ok: true }),
    ),
  }
  return db
}

describe('Reviews / Settings', () => {
  describe('getShopReviewSettings', () => {
    it('returns defaults when no row exists', async () => {
      const db = createMockDb({ 'select:shop_review_settings': null })
      const s = await getShopReviewSettings(db, 'shop-a')
      expect(s.profanityFilterEnabled).toBe(
        _SHOP_REVIEW_SETTINGS_DEFAULTS.profanityFilterEnabled,
      )
      expect(s.profanityExtraTerms).toEqual([])
      expect(s.notifyCustomerOnApprove).toBe(true)
      expect(s.notifyCustomerOnReply).toBe(true)
      expect(s.shopId).toBe('shop-a')
    })

    it('hydrates a stored row', async () => {
      const row = {
        shop_id: 'shop-b',
        profanity_filter_enabled: false,
        profanity_extra_terms: ['asdf'],
        notify_customer_on_approve: false,
        notify_customer_on_reply: true,
        created_at: 'x',
        updated_at: 'y',
      }
      const db = createMockDb({ 'select:shop_review_settings': row })
      const s = await getShopReviewSettings(db, 'shop-b')
      expect(s.profanityFilterEnabled).toBe(false)
      expect(s.profanityExtraTerms).toEqual(['asdf'])
      expect(s.notifyCustomerOnApprove).toBe(false)
      expect(s.notifyCustomerOnReply).toBe(true)
    })

    it('handles jsonb string stored in profanity_extra_terms', async () => {
      const row = {
        shop_id: 'shop-c',
        profanity_filter_enabled: true,
        profanity_extra_terms: '["foo","BAR"]',
        notify_customer_on_approve: true,
        notify_customer_on_reply: true,
        created_at: 'x',
        updated_at: 'y',
      }
      const db = createMockDb({ 'select:shop_review_settings': row })
      const s = await getShopReviewSettings(db, 'shop-c')
      expect(s.profanityExtraTerms).toEqual(['foo', 'bar'])
    })
  })

  describe('upsertShopReviewSettings', () => {
    it('inserts when no prior row', async () => {
      const db = createMockDb({ 'select:shop_review_settings': null })
      const result = await upsertShopReviewSettings(db, 'shop-x', {
        profanityFilterEnabled: false,
      })
      expect(result.profanityFilterEnabled).toBe(false)
      expect(db.insertInto).toHaveBeenCalledWith('shop_review_settings')
    })

    it('updates when row exists', async () => {
      const row = {
        shop_id: 'shop-y',
        profanity_filter_enabled: true,
        profanity_extra_terms: [],
        notify_customer_on_approve: true,
        notify_customer_on_reply: true,
        created_at: 'x',
        updated_at: 'y',
      }
      const db = createMockDb({ 'select:shop_review_settings': row })
      await upsertShopReviewSettings(db, 'shop-y', {
        profanityExtraTerms: ['junk'],
      })
      expect(db.updateTable).toHaveBeenCalledWith('shop_review_settings')
    })

    it('preserves fields not in the patch', async () => {
      const row = {
        shop_id: 'shop-z',
        profanity_filter_enabled: false,
        profanity_extra_terms: ['kept'],
        notify_customer_on_approve: false,
        notify_customer_on_reply: true,
        created_at: 'x',
        updated_at: 'y',
      }
      const db = createMockDb({ 'select:shop_review_settings': row })
      const out = await upsertShopReviewSettings(db, 'shop-z', {
        notifyCustomerOnReply: false,
      })
      expect(out.profanityFilterEnabled).toBe(false)
      expect(out.profanityExtraTerms).toEqual(['kept'])
      expect(out.notifyCustomerOnApprove).toBe(false)
      expect(out.notifyCustomerOnReply).toBe(false)
    })
  })

  describe('resolveVoteSalt', () => {
    it('produces a 64-char hex string', () => {
      const salt = resolveVoteSalt('shop-a')
      expect(salt).toMatch(/^[a-f0-9]{64}$/)
    })

    it('is deterministic per shop', () => {
      expect(resolveVoteSalt('shop-a')).toBe(resolveVoteSalt('shop-a'))
    })

    it('differs between shops', () => {
      expect(resolveVoteSalt('shop-a')).not.toBe(resolveVoteSalt('shop-b'))
    })
  })
})
