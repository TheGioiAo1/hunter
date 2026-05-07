/**
 * Unit tests for the 95-template email registry (Phase 14 PR1).
 *
 * These are pure-function tests — no DB. They're about proving:
 *
 *   - Every key the admin UI / service layer will reference exists.
 *   - The category/audience/priority invariants hold for every row
 *     (CHECK-constraint parity with migration 083).
 *   - The Iron Rule 5 filter (`getMerchantVisibleTemplates()`) really
 *     strips god-admin entries, since that's what seller surfaces rely
 *     on.
 *   - The catalog count matches what the seed script will INSERT.
 */

import { describe, it, expect } from 'vitest'
import {
  EMAIL_TEMPLATE_CATALOG,
  getTemplate,
  getAllTemplates,
  getTemplatesByCategory,
  getMerchantVisibleTemplates,
  getImplementedTemplates,
  getPendingTemplates,
  getTemplateCount,
  isForcedSendCategory,
  type TemplateSpec,
} from './registry.js'

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

describe('EMAIL_TEMPLATE_CATALOG', () => {
  it('exports exactly 97 templates (95 Shopify-class catalog + 2 support notification envelopes)', () => {
    expect(getTemplateCount()).toBe(97)
    expect(Object.keys(EMAIL_TEMPLATE_CATALOG)).toHaveLength(97)
  })

  it('every template has a unique key that matches its Record index', () => {
    for (const [recordKey, spec] of Object.entries(EMAIL_TEMPLATE_CATALOG)) {
      expect(spec.key).toBe(recordKey)
    }
  })

  it('every key is snake_case (migration 083 PK convention)', () => {
    for (const key of Object.keys(EMAIL_TEMPLATE_CATALOG)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('every template has non-empty subject + body_html + body_text', () => {
    for (const t of getAllTemplates()) {
      expect(t.subject.length, `subject for ${t.key}`).toBeGreaterThan(0)
      expect(t.bodyHtml.length, `bodyHtml for ${t.key}`).toBeGreaterThan(0)
      expect(t.bodyText.length, `bodyText for ${t.key}`).toBeGreaterThan(0)
    }
  })

  it('every template has a category that matches the migration 083 CHECK', () => {
    const allowed = new Set([
      'transactional',
      'marketing',
      'lifecycle',
      'reviews',
      'ops',
      'platform',
      'legal',
    ])
    for (const t of getAllTemplates()) {
      expect(allowed.has(t.category), `category of ${t.key}`).toBe(true)
    }
  })

  it('every template has an audience that matches the migration 083 CHECK', () => {
    const allowed = new Set(['customer', 'merchant', 'god_admin'])
    for (const t of getAllTemplates()) {
      expect(allowed.has(t.audience), `audience of ${t.key}`).toBe(true)
    }
  })

  it('every template has a priority in 1..4', () => {
    for (const t of getAllTemplates()) {
      expect(t.priority).toBeGreaterThanOrEqual(1)
      expect(t.priority).toBeLessThanOrEqual(4)
      expect(Number.isInteger(t.priority)).toBe(true)
    }
  })

  it('every template has a description', () => {
    for (const t of getAllTemplates()) {
      expect(t.description.length, `description for ${t.key}`).toBeGreaterThan(0)
    }
  })

  it('every template has a variables array', () => {
    for (const t of getAllTemplates()) {
      expect(Array.isArray(t.variables), `variables for ${t.key}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

describe('getTemplate', () => {
  it('returns the spec for a known key', () => {
    const t = getTemplate('order_confirmation')
    expect(t).toBeDefined()
    expect(t?.category).toBe('transactional')
    expect(t?.audience).toBe('customer')
    expect(t?.implemented).toBe(true)
  })

  it('returns undefined for unknown keys', () => {
    expect(getTemplate('nope_nonexistent')).toBeUndefined()
    expect(getTemplate('')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('getTemplatesByCategory', () => {
  it('transactional ≥ 10 (baseline wave plus customer-receipt coverage)', () => {
    expect(getTemplatesByCategory('transactional').length).toBeGreaterThanOrEqual(10)
  })

  it('marketing ≥ 10', () => {
    expect(getTemplatesByCategory('marketing').length).toBeGreaterThanOrEqual(10)
  })

  it('lifecycle ≥ 5', () => {
    expect(getTemplatesByCategory('lifecycle').length).toBeGreaterThanOrEqual(5)
  })

  it('reviews ≥ 3', () => {
    expect(getTemplatesByCategory('reviews').length).toBeGreaterThanOrEqual(3)
  })

  it('platform ≥ 5', () => {
    expect(getTemplatesByCategory('platform').length).toBeGreaterThanOrEqual(5)
  })

  it('legal ≥ 5 (GDPR + ToS + data-breach coverage)', () => {
    expect(getTemplatesByCategory('legal').length).toBeGreaterThanOrEqual(5)
  })
})

// ---------------------------------------------------------------------------
// Iron Rule 5 — the seller surface NEVER sees god_admin templates
// ---------------------------------------------------------------------------

describe('getMerchantVisibleTemplates (Iron Rule 5)', () => {
  it('strips every god_admin template', () => {
    const visible = getMerchantVisibleTemplates()
    for (const t of visible) {
      expect(t.audience).not.toBe('god_admin')
    }
  })

  it('count matches total minus god_admin entries', () => {
    const all = getAllTemplates()
    const godAdminCount = all.filter((t) => t.audience === 'god_admin').length
    expect(getMerchantVisibleTemplates()).toHaveLength(all.length - godAdminCount)
  })

  it('platform templates are all god_admin (defense in depth — audience must match category intent)', () => {
    const platform = getTemplatesByCategory('platform')
    expect(platform.length).toBeGreaterThan(0)
    for (const t of platform) {
      expect(t.audience).toBe('god_admin')
    }
  })

  it('no non-platform template has audience god_admin (avoid accidental leaks)', () => {
    for (const t of getAllTemplates()) {
      if (t.audience === 'god_admin') {
        expect(t.category).toBe('platform')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Implemented-vs-pending split
// ---------------------------------------------------------------------------

describe('implemented / pending split', () => {
  it('36 templates are implemented (10 pre-PR1 + 5 PR2 + 5 PR5 GDPR + 14 PR6 + 2 support-notif envelopes)', () => {
    // order_confirmation, shipping_notification, password_reset, welcome,
    // refund_notification, draft_order_invoice, gift_card_delivery,
    // abandoned_cart_recovery, review_approved, review_replied +
    // PR2 fresh wires: email_verify_otp (commit 8), two_fa_code
    // (commit 9, both platform-owned), new_order_received
    // (commit 13, merchant ops), order_canceled (commit 14,
    // transactional customer), fulfillment_delivered (commit 15,
    // transactional customer; fires from Lenful tracking-sync on
    // rising-edge shipped → delivered) + PR5 GDPR: gdpr_data_export_ready,
    // gdpr_data_deletion_confirmed, privacy_policy_update,
    // cookie_consent_update (consent renewal), data_breach_notice +
    // PR6 Priority-3 ops: finance — first_time_customer_order,
    // payment_failed_merchant, refund_issued_merchant,
    // out_of_stock_alert, high_risk_order, daily_sales_digest;
    // platform god-admin — new_merchant_signup, platform_incident_alert,
    // platform_daily_digest, platform_churn_alert, platform_fraud_review,
    // platform_policy_violation, platform_integration_down,
    // platform_weekly_roundup. The 6 payout_*/chargeback_* templates
    // and platform_billing_failure stay scaffold-pending until Phase
    // 12 Stripe Connect ships.
    expect(getImplementedTemplates()).toHaveLength(36)
  })

  it('61 templates are scaffold-pending', () => {
    expect(getPendingTemplates()).toHaveLength(61)
  })

  it('implemented + pending == total', () => {
    expect(getImplementedTemplates().length + getPendingTemplates().length).toBe(
      getTemplateCount(),
    )
  })

  it('every known-implemented key is flagged', () => {
    const knownImpl = [
      'order_confirmation',
      'shipping_notification',
      'password_reset',
      'welcome',
      'refund_notification',
      'draft_order_invoice',
      'gift_card_delivery',
      'abandoned_cart_recovery',
      'review_approved',
      'review_replied',
      'email_verify_otp',
      'two_fa_code',
      'new_order_received',
      'order_canceled',
      'fulfillment_delivered',
      // PR5 — GDPR pack
      'gdpr_data_export_ready',
      'gdpr_data_deletion_confirmed',
      'privacy_policy_update',
      'cookie_consent_update',
      'data_breach_notice',
      // PR6 — Priority 3 ops (finance + platform god-admin)
      'first_time_customer_order',
      'payment_failed_merchant',
      'refund_issued_merchant',
      'out_of_stock_alert',
      'high_risk_order',
      'daily_sales_digest',
      'new_merchant_signup',
      'platform_incident_alert',
      'platform_daily_digest',
      'platform_churn_alert',
      'platform_fraud_review',
      'platform_policy_violation',
      'platform_integration_down',
      'platform_weekly_roundup',
    ]
    for (const k of knownImpl) {
      const t = getTemplate(k)
      expect(t, `${k} must exist`).toBeDefined()
      expect(t?.implemented, `${k} must have implemented=true`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Forced-send classification
// ---------------------------------------------------------------------------

describe('isForcedSendCategory', () => {
  it('forces transactional / ops / platform / legal', () => {
    expect(isForcedSendCategory('transactional')).toBe(true)
    expect(isForcedSendCategory('ops')).toBe(true)
    expect(isForcedSendCategory('platform')).toBe(true)
    expect(isForcedSendCategory('legal')).toBe(true)
  })

  it('opts-out for marketing / lifecycle / reviews', () => {
    expect(isForcedSendCategory('marketing')).toBe(false)
    expect(isForcedSendCategory('lifecycle')).toBe(false)
    expect(isForcedSendCategory('reviews')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Specific key sanity checks — picked because they're load-bearing for
// downstream PRs (service.ts senders, the admin UI labels, and the
// preference-category mapper all key on these strings).
// ---------------------------------------------------------------------------

describe('key invariants for load-bearing templates', () => {
  it('password_reset is transactional + priority 1 + no unsubscribe', () => {
    const t = getTemplate('password_reset')!
    expect(t.category).toBe('transactional')
    expect(t.audience).toBe('customer')
    expect(t.priority).toBe(1)
    expect(isForcedSendCategory(t.category)).toBe(true)
  })

  it('newsletter_broadcast is marketing + customer', () => {
    const t = getTemplate('newsletter_broadcast')!
    expect(t.category).toBe('marketing')
    expect(t.audience).toBe('customer')
  })

  it('new_merchant_signup is platform + god_admin (never seen by sellers)', () => {
    const t = getTemplate('new_merchant_signup')!
    expect(t.category).toBe('platform')
    expect(t.audience).toBe('god_admin')
  })

  it('data_breach_notice is legal + priority 1 (highest)', () => {
    const t = getTemplate('data_breach_notice')!
    expect(t.category).toBe('legal')
    expect(t.priority).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Regression: key set snapshot
// ---------------------------------------------------------------------------

describe('catalog key snapshot', () => {
  it('matches the committed template list (prevents silent removals)', () => {
    const keys = Object.keys(EMAIL_TEMPLATE_CATALOG).sort()
    // Spot-check a stable subset instead of snapshotting all 95 — new
    // templates get added over time, but these 10 are load-bearing and
    // shouldn't disappear.
    const mustHave: readonly string[] = [
      'order_confirmation',
      'shipping_notification',
      'password_reset',
      'welcome',
      'refund_notification',
      'gift_card_delivery',
      'review_approved',
      'abandoned_cart_recovery',
      'new_merchant_signup',
      'data_breach_notice',
    ]
    for (const m of mustHave) {
      expect(keys.includes(m), `${m} must be present in the catalog`).toBe(true)
    }
  })
})

// Type-level check: `TemplateSpec` is exported and structurally correct.
// This ensures downstream `import type { TemplateSpec }` won't silently
// break if the shape changes.
const _shape: TemplateSpec = {
  key: 'x',
  category: 'transactional',
  audience: 'customer',
  priority: 1,
  subject: 'x',
  bodyHtml: 'x',
  bodyText: 'x',
  variables: [],
  description: 'x',
  implemented: false,
}
void _shape
