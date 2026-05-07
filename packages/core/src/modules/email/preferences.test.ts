/**
 * Unit tests for the preferences module (Phase 14 PR1).
 *
 * Pure-function coverage:
 *   - token generation + hashing (SHA-256 + 64-hex invariants)
 *   - unsubscribe URL builder (env-driven)
 *   - mapTemplateToPrefCategory: the Shopify-class template-key →
 *     preference-category mapper
 *
 * DB-touching behaviour (canSend against real rows, upsertPreference
 * race semantics) is exercised by the smoke test against live Postgres;
 * this file only tests the parts that would be tedious to prove there.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  generateUnsubscribeToken,
  hashUnsubscribeToken,
  buildUnsubscribeUrl,
  mapTemplateToPrefCategory,
} from './preferences.js'

// ---------------------------------------------------------------------------
// Token generation + hashing
// ---------------------------------------------------------------------------

describe('generateUnsubscribeToken', () => {
  it('returns a 64-char hex string (32 bytes)', () => {
    const token = generateUnsubscribeToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a unique value on each call (cryptographic randomness)', () => {
    const set = new Set<string>()
    for (let i = 0; i < 100; i++) set.add(generateUnsubscribeToken())
    expect(set.size).toBe(100)
  })
})

describe('hashUnsubscribeToken', () => {
  it('returns a 64-char hex SHA-256', () => {
    const hash = hashUnsubscribeToken('any-raw-value')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic (same input → same output)', () => {
    const a = hashUnsubscribeToken('hello')
    const b = hashUnsubscribeToken('hello')
    expect(a).toBe(b)
  })

  it('differs for different inputs', () => {
    expect(hashUnsubscribeToken('a')).not.toBe(hashUnsubscribeToken('b'))
  })

  it('matches a known SHA-256 vector ("abc" → ba7816...)', () => {
    // NIST FIPS 180-4 test vector for SHA-256("abc").
    expect(hashUnsubscribeToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

// ---------------------------------------------------------------------------
// buildUnsubscribeUrl
// ---------------------------------------------------------------------------

describe('buildUnsubscribeUrl', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.EMAIL_UNSUBSCRIBE_BASE_URL = process.env.EMAIL_UNSUBSCRIBE_BASE_URL
    saved.ACCOUNTS_BASE_URL = process.env.ACCOUNTS_BASE_URL
    delete process.env.EMAIL_UNSUBSCRIBE_BASE_URL
    delete process.env.ACCOUNTS_BASE_URL
  })

  afterEach(() => {
    if (saved.EMAIL_UNSUBSCRIBE_BASE_URL === undefined)
      delete process.env.EMAIL_UNSUBSCRIBE_BASE_URL
    else process.env.EMAIL_UNSUBSCRIBE_BASE_URL = saved.EMAIL_UNSUBSCRIBE_BASE_URL
    if (saved.ACCOUNTS_BASE_URL === undefined) delete process.env.ACCOUNTS_BASE_URL
    else process.env.ACCOUNTS_BASE_URL = saved.ACCOUNTS_BASE_URL
  })

  it('uses the default accounts.gbox.co host when no env is set', () => {
    const url = buildUnsubscribeUrl('token123')
    expect(url).toBe('https://accounts.gbox.co/accounts/unsubscribe?token=token123')
  })

  it('prefers EMAIL_UNSUBSCRIBE_BASE_URL', () => {
    process.env.EMAIL_UNSUBSCRIBE_BASE_URL = 'https://custom.example.com'
    const url = buildUnsubscribeUrl('t')
    expect(url).toBe('https://custom.example.com/accounts/unsubscribe?token=t')
  })

  it('falls back to ACCOUNTS_BASE_URL if EMAIL_UNSUBSCRIBE_BASE_URL missing', () => {
    process.env.ACCOUNTS_BASE_URL = 'https://fallback.example.com'
    const url = buildUnsubscribeUrl('t')
    expect(url).toBe('https://fallback.example.com/accounts/unsubscribe?token=t')
  })

  it('strips trailing slash so we don\'t get //unsubscribe', () => {
    process.env.EMAIL_UNSUBSCRIBE_BASE_URL = 'https://x.com///'
    const url = buildUnsubscribeUrl('t')
    expect(url).toBe('https://x.com/accounts/unsubscribe?token=t')
  })

  it('URL-encodes the token', () => {
    const url = buildUnsubscribeUrl('token with spaces & symbols')
    // encodeURIComponent produces %20 for spaces and %26 for &.
    expect(url).toContain('token%20with%20spaces%20%26%20symbols')
  })
})

// ---------------------------------------------------------------------------
// mapTemplateToPrefCategory
// ---------------------------------------------------------------------------

describe('mapTemplateToPrefCategory', () => {
  // Forced-send categories: always null.
  it('returns null for transactional templates (forced send)', () => {
    expect(mapTemplateToPrefCategory('password_reset')).toBeNull()
    expect(mapTemplateToPrefCategory('order_confirmation')).toBeNull()
    expect(mapTemplateToPrefCategory('refund_notification')).toBeNull()
  })

  it('returns null for ops templates (forced send)', () => {
    expect(mapTemplateToPrefCategory('new_order_received')).toBeNull()
    expect(mapTemplateToPrefCategory('low_stock_alert')).toBeNull()
  })

  it('returns null for platform templates (god-admin, forced send)', () => {
    expect(mapTemplateToPrefCategory('platform_incident_alert')).toBeNull()
    expect(mapTemplateToPrefCategory('new_merchant_signup')).toBeNull()
  })

  it('returns null for legal templates (forced send)', () => {
    expect(mapTemplateToPrefCategory('gdpr_data_export_ready')).toBeNull()
    expect(mapTemplateToPrefCategory('tos_update')).toBeNull()
  })

  // Special-case overrides
  it('maps back_in_stock → back_in_stock', () => {
    expect(mapTemplateToPrefCategory('back_in_stock')).toBe('back_in_stock')
  })

  it('maps price_drop → price_drop', () => {
    expect(mapTemplateToPrefCategory('price_drop')).toBe('price_drop')
  })

  it('maps newsletter_broadcast → newsletter', () => {
    expect(mapTemplateToPrefCategory('newsletter_broadcast')).toBe('newsletter')
  })

  it('maps abandoned_cart_* and abandoned_checkout_recovery → abandoned_cart', () => {
    expect(mapTemplateToPrefCategory('abandoned_cart_recovery')).toBe('abandoned_cart')
    expect(mapTemplateToPrefCategory('abandoned_cart_reminder_2')).toBe('abandoned_cart')
    expect(mapTemplateToPrefCategory('abandoned_cart_reminder_3')).toBe('abandoned_cart')
    expect(mapTemplateToPrefCategory('abandoned_checkout_recovery')).toBe('abandoned_cart')
  })

  // Default category routing
  it('maps generic marketing templates → marketing', () => {
    expect(mapTemplateToPrefCategory('campaign_promo')).toBe('marketing')
    expect(mapTemplateToPrefCategory('flash_sale')).toBe('marketing')
    expect(mapTemplateToPrefCategory('seasonal_promo')).toBe('marketing')
  })

  it('maps lifecycle templates → lifecycle', () => {
    expect(mapTemplateToPrefCategory('customer_win_back')).toBe('lifecycle')
    expect(mapTemplateToPrefCategory('post_purchase_thank_you')).toBe('lifecycle')
  })

  it('maps reviews templates → reviews', () => {
    expect(mapTemplateToPrefCategory('review_request')).toBe('reviews')
    expect(mapTemplateToPrefCategory('review_approved')).toBe('reviews')
    expect(mapTemplateToPrefCategory('review_replied')).toBe('reviews')
  })

  it('returns null for unknown templates (fail-closed)', () => {
    expect(mapTemplateToPrefCategory('nope_not_a_template')).toBeNull()
  })
})
