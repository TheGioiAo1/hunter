/**
 * Phase 14 PR2 — per-template migration unit tests.
 *
 * As each commit in PR2 migrates a legacy `sendXxx()` function to route
 * through the PR1 pipeline (`sendTemplatedEmail` → `resolveTemplate`
 * → `email_deliveries`), this file gains a test block asserting:
 *
 *   1. The registry spec for that template holds real production HTML
 *      (not the shared SCAFFOLD_HTML placeholder).
 *   2. The spec's `subject` + `bodyHtml` + `bodyText` reference the
 *      variables the feature passes (guards against silent-drop when
 *      vars rename).
 *   3. `getTemplate(key)` returns an `implemented: true` spec — the
 *      admin UI filters on this to hide unwired scaffolds.
 *
 * The tests are pure — no DB, no transport. Live-DB assertions land
 * in `scripts/smoke-phase14-pr2.ts` at the end of PR2.
 */

import { describe, it, expect } from 'vitest'
import { EMAIL_TEMPLATE_CATALOG, getTemplate } from './registry.js'

// ---------------------------------------------------------------------------
// Shared scaffold detection
// ---------------------------------------------------------------------------

/**
 * The shared scaffold HTML — any template spec that still reference this
 * hasn't been production-HTML'd yet. Matching on the unique `{{heading}}`
 * + `.btn-wrap` combo is robust against CSS tweaks.
 */
function looksLikeScaffold(bodyHtml: string): boolean {
  return (
    bodyHtml.includes('{{heading}}') &&
    bodyHtml.includes('{{body_html}}') &&
    bodyHtml.includes('{{shop_name}}')
  )
}

// ---------------------------------------------------------------------------
// PR2 commit 1 — order_confirmation
// ---------------------------------------------------------------------------

describe('PR2 commit 1: order_confirmation', () => {
  const spec = getTemplate('order_confirmation')

  it('is present in the catalog and implemented', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    // Positive: the legacy BUILT_IN_TEMPLATES had this opening line.
    expect(spec!.bodyHtml).toMatch(/Thank you for your order/i)
  })

  it('has a plain-text body (not the scaffold text)', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toMatch(/Thank you for your order/i)
    expect(spec!.bodyText).toMatch(/Order #/)
  })

  it('references every variable the feature passes', () => {
    expect(spec).toBeTruthy()
    // These are the keys built by sendOrderConfirmation() in service.ts.
    const requiredVars = [
      'order_number',
      'customer_name',
      'currency',
      'subtotal_price',
      'total_shipping',
      'total_tax',
      'total_price',
      'line_items_html',
      'discount_row',
    ]
    for (const v of requiredVars) {
      expect(
        spec!.variables.includes(v),
        `variables missing ${v}`,
      ).toBe(true)
    }
  })

  it('subject interpolates {{order_number}}', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject).toContain('{{order_number}}')
  })

  it('bodyHtml contains the key placeholders the feature fills', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyHtml).toContain('{{order_number}}')
    expect(spec!.bodyHtml).toContain('{{customer_name}}')
    expect(spec!.bodyHtml).toContain('{{line_items_html}}')
    expect(spec!.bodyHtml).toContain('{{total_price}}')
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 2 — shipping_notification
// ---------------------------------------------------------------------------

describe('PR2 commit 2: shipping_notification', () => {
  const spec = getTemplate('shipping_notification')

  it('is present, implemented, transactional, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Your order is on its way/i)
    expect(spec!.bodyHtml).toContain('{{tracking_html}}')
    expect(spec!.bodyHtml).toContain('{{line_items_html}}')
  })

  it('bodyText is plain and contains the shipped headline', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toMatch(/on its way/i)
  })

  it('declares required variables', () => {
    expect(spec).toBeTruthy()
    for (const v of ['order_number', 'customer_name', 'tracking_html', 'line_items_html']) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 3 — password_reset
// ---------------------------------------------------------------------------

describe('PR2 commit 3: password_reset', () => {
  const spec = getTemplate('password_reset')

  it('is present, implemented, transactional, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    // Positive checks: the legacy BUILT_IN_TEMPLATES had these.
    expect(spec!.bodyHtml).toMatch(/Reset your password/i)
    expect(spec!.bodyHtml).toContain('{{reset_url}}')
    // Defence-in-depth: the reset email should say "expires in 1 hour"
    // since the TTL in forgot-password.ts is hard-coded to RESET_TOKEN_TTL_MS
    // = 60 * 60 * 1000 — if either moves we want the test to scream.
    expect(spec!.bodyHtml).toMatch(/1 hour/i)
  })

  it('bodyText is plain and contains the reset url placeholder', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{reset_url}}')
    expect(spec!.bodyText).toMatch(/reset your password/i)
  })

  it('declares variables matching the trigger callsite', () => {
    expect(spec).toBeTruthy()
    // These match the keys passed by apps/accounts/src/pages/forgot-password.ts
    // and the legacy `sendPasswordReset()` shim in service.ts.
    for (const v of ['user_name', 'reset_url']) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 4 — welcome
// ---------------------------------------------------------------------------

describe('PR2 commit 4: welcome', () => {
  const spec = getTemplate('welcome')

  it('is present, implemented, transactional, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Welcome, \{\{user_name\}\}!/)
    expect(spec!.bodyHtml).toContain('{{shop_name}}')
    expect(spec!.bodyHtml).toContain('{{login_url}}')
  })

  it('bodyText is plain and contains the welcome + login_url', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toMatch(/Welcome/i)
    expect(spec!.bodyText).toContain('{{login_url}}')
  })

  it('subject advertises the shop_name', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject).toContain('{{shop_name}}')
  })

  it('declares variables matching the create-store trigger', () => {
    expect(spec).toBeTruthy()
    // The trigger in create-store.ts passes exactly these three keys.
    for (const v of ['user_name', 'shop_name', 'login_url']) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 5 — refund_notification
// ---------------------------------------------------------------------------

describe('PR2 commit 5: refund_notification', () => {
  const spec = getTemplate('refund_notification')

  it('is present, implemented, transactional, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/You've been refunded/)
    expect(spec!.bodyHtml).toContain('{{refund_amount}}')
    expect(spec!.bodyHtml).toContain('{{line_items_html}}')
    // The legacy copy carries the "5-10 business days" hint — worth
    // asserting because sellers sometimes try to trim it and that
    // triggers support tickets when customers expect an instant refund.
    expect(spec!.bodyHtml).toMatch(/5-10 business days/i)
  })

  it('bodyText is plain and contains the refund figure', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{refund_amount}}')
    expect(spec!.bodyText).toMatch(/refunded/i)
  })

  it('subject interpolates {{order_number}}', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject).toContain('{{order_number}}')
  })

  it('declares variables matching the sendRefundNotification callsite', () => {
    expect(spec).toBeTruthy()
    for (const v of [
      'order_number',
      'customer_name',
      'refund_amount',
      'currency',
      'reason',
      'line_items_html',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 6 — draft_order_invoice
// ---------------------------------------------------------------------------

describe('PR2 commit 6: draft_order_invoice', () => {
  const spec = getTemplate('draft_order_invoice')

  it('is present, implemented, transactional, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Invoice #/)
    expect(spec!.bodyHtml).toContain('{{payment_url}}')
    // Pay Now button is the key CTA — this email has no other action.
    expect(spec!.bodyHtml).toMatch(/Pay Now/)
  })

  it('uses {{note_html}} and {{due_date_html}} wrappers, not raw fields', () => {
    expect(spec).toBeTruthy()
    // This is the regression fix — the legacy template referenced
    // `{{note_html}}` but the templateData only passed `note`, which
    // meant the literal placeholder leaked into the email body.
    expect(spec!.bodyHtml).toContain('{{note_html}}')
    expect(spec!.bodyHtml).toContain('{{due_date_html}}')
    expect(spec!.bodyHtml).not.toContain('{{note}}')
    expect(spec!.bodyHtml).not.toContain('{{due_date}}')
  })

  it('bodyText is plain and contains payment_url + totals', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{payment_url}}')
    expect(spec!.bodyText).toContain('{{total}}')
  })

  it('declares variables matching the sendInvoice callsite post-fix', () => {
    expect(spec).toBeTruthy()
    // After the PR2 commit 6 fix, the shim passes note_html + due_date_html
    // (not raw note / due_date) to match the HTML expectations.
    for (const v of [
      'order_number',
      'line_items_html',
      'subtotal',
      'total',
      'currency',
      'note_html',
      'due_date_html',
      'payment_url',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
    // And the raw `note` / `due_date` names must NOT be declared —
    // they were the legacy bug.
    expect(spec!.variables.includes('note')).toBe(false)
    expect(spec!.variables.includes('due_date')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 7 — gift_card_delivery
// ---------------------------------------------------------------------------

describe('PR2 commit 7: gift_card_delivery', () => {
  const spec = getTemplate('gift_card_delivery')

  it('is present, implemented, transactional, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/You've received a gift card/i)
    expect(spec!.bodyHtml).toContain('{{code}}')
    expect(spec!.bodyHtml).toContain('{{initial_value}}')
    // How-to-redeem block is core UX — don't let it be stripped out.
    expect(spec!.bodyHtml).toMatch(/How to redeem/i)
  })

  it('bodyText is plain and contains the code + redeem steps', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{code}}')
    expect(spec!.bodyText).toMatch(/How to redeem/i)
  })

  it('subject advertises the sender', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject).toContain('{{sender_name}}')
  })

  it('declares all 8 variables the sendGiftCardDelivery shim passes', () => {
    expect(spec).toBeTruthy()
    for (const v of [
      'code',
      'currency',
      'initial_value',
      'recipient_name',
      'sender_name',
      'shop_name',
      'message_html',
      'expires_html',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 8 — email_verify_otp (platform-owned)
// ---------------------------------------------------------------------------
//
// This one is structurally different: the template is PLATFORM-owned
// (audience='god_admin'), so Iron rule 5 means it must NEVER surface
// in the seller override UI. Pre-PR8 the real transport was the
// external `smtp-gbox` HTTP relay; PR8 cluster-A moved it into the
// in-process @gbox/core/modules/email pipeline. This spec still powers
// god-admin preview + seed-script accounting; send-signup-otp.ts is
// the runtime consumer.

describe('PR2 commit 8: email_verify_otp', () => {
  const spec = getTemplate('email_verify_otp')

  it('is present, implemented, and platform-categorised', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('platform')
    expect(spec!.priority).toBe(1)
  })

  it('is flagged audience=god_admin (Iron rule 5)', () => {
    // This guarantees getMerchantVisibleTemplates() filters it out of
    // the seller-facing override UI. If a refactor accidentally flips
    // audience back to 'customer', sellers would see the platform
    // signup OTP as customizable — a real leak.
    expect(spec).toBeTruthy()
    expect(spec!.audience).toBe('god_admin')
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Verify your email/i)
    expect(spec!.bodyHtml).toContain('{{otp_code}}')
    expect(spec!.bodyHtml).toContain('{{expires_minutes}}')
  })

  it('bodyText is plain and contains the OTP placeholder', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{otp_code}}')
    expect(spec!.bodyText).toContain('{{expires_minutes}}')
  })

  it('declares exactly the 2 variables the signup OTP flow uses', () => {
    expect(spec).toBeTruthy()
    expect(spec!.variables).toEqual(['otp_code', 'expires_minutes'])
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 9 — two_fa_code (shared seller + god-admin 2FA template)
// ---------------------------------------------------------------------------
//
// One template serves BOTH login surfaces:
//
//   1. apps/accounts/src/pages/login-2fa.ts  — seller 2FA OTP
//   2. apps/god-admin/src/pages/login-2fa.ts — god-admin 2FA OTP
//
// Both pass shopId=null (platform send). Copy is intentionally neutral
// ("Your Gbox sign-in code") so the template body reads identically
// for seller + god-admin, avoiding any Iron-rule-5 leak if a seller
// somehow previewed the template HTML.

describe('PR2 commit 9: two_fa_code', () => {
  const spec = getTemplate('two_fa_code')

  it('is present, implemented, platform-categorised, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('platform')
    expect(spec!.priority).toBe(1)
  })

  it('is flagged audience=god_admin (Iron rule 5 — not editable by sellers)', () => {
    // Security emails are platform-owned, same as Shopify's locked
    // password-reset. If a refactor flips this back to 'customer' or
    // 'merchant', sellers would see a 2FA override slot in the admin
    // UI — that's a seat at the table for a phish-friendly attacker.
    expect(spec).toBeTruthy()
    expect(spec!.audience).toBe('god_admin')
  })

  it('copy is seller-safe — no "God Admin" branding (Iron rule 5)', () => {
    // Deliberately-neutral subject/body so the same template row serves
    // both flows. If someone edits the registry to re-add "God Admin",
    // the seller preview UI could accidentally show it.
    expect(spec).toBeTruthy()
    expect(spec!.subject.toLowerCase()).not.toContain('god admin')
    expect(spec!.bodyHtml.toLowerCase()).not.toContain('god admin')
    expect(spec!.bodyText.toLowerCase()).not.toContain('god admin')
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Gbox sign-in code/i)
    expect(spec!.bodyHtml).toContain('{{code}}')
    expect(spec!.bodyHtml).toContain('{{expires_minutes}}')
    // Security-minded footer — should tell the recipient what to do
    // if they didn't trigger the login. Dropping this removes the
    // primary phish-safety signal, so guard it.
    expect(spec!.bodyHtml).toMatch(/didn't try to sign in/i)
  })

  it('bodyText is plain and contains the code placeholder + expiry hint', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{code}}')
    expect(spec!.bodyText).toContain('{{expires_minutes}}')
  })

  it('declares exactly the 2 variables the auth flow passes', () => {
    expect(spec).toBeTruthy()
    expect(spec!.variables).toEqual(['code', 'expires_minutes'])
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 10 — abandoned_cart_recovery
// ---------------------------------------------------------------------------
//
// Lifecycle category (NOT transactional) — subject to opt-out, and the
// send.ts pipeline auto-injects an unsubscribe footer. The legacy
// BUILT_IN_TEMPLATES HTML now lives in the registry spec, so the
// admin UI preview reflects what customers actually receive.

describe('PR2 commit 10: abandoned_cart_recovery', () => {
  const spec = getTemplate('abandoned_cart_recovery')

  it('is present, implemented, lifecycle, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('lifecycle')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Don't forget your items/i)
    // Legacy CTA is "Complete Your Order" — guard against rename that
    // would break copy-tested conversion rates.
    expect(spec!.bodyHtml).toMatch(/Complete Your Order/i)
    expect(spec!.bodyHtml).toContain('{{customer_name}}')
    expect(spec!.bodyHtml).toContain('{{line_items_html}}')
    expect(spec!.bodyHtml).toContain('{{recovery_url}}')
  })

  it('embeds the unsubscribe marker (lifecycle footer requirement)', () => {
    // Lifecycle / marketing / reviews categories MUST render the
    // unsubscribe footer — send.ts injects `unsubscribe_html` /
    // `unsubscribe_text` variables, and the template has to consume
    // them or the CAN-SPAM-safe footer drops silently.
    expect(spec).toBeTruthy()
    expect(spec!.bodyHtml).toContain('{{unsubscribe_html}}')
    expect(spec!.bodyText).toContain('{{unsubscribe_text}}')
  })

  it('bodyText is plain and contains the recovery URL + total', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{recovery_url}}')
    expect(spec!.bodyText).toContain('{{total}}')
    expect(spec!.bodyText).toContain('{{currency}}')
  })

  it('declares variables matching the sendAbandonedCartRecovery shim', () => {
    expect(spec).toBeTruthy()
    for (const v of [
      'customer_name',
      'line_items_html',
      'total',
      'currency',
      'recovery_url',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 11 — review_approved
// ---------------------------------------------------------------------------
//
// Reviews category (opt-out separate from marketing). Upstream caller
// (approveReview in reviews/service.ts) now threads reviewId through
// the payload for idempotency — a re-approve cycle can't spam.

describe('PR2 commit 11: review_approved', () => {
  const spec = getTemplate('review_approved')

  it('is present, implemented, reviews, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('reviews')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Thanks for sharing your thoughts/i)
    expect(spec!.bodyHtml).toContain('{{customer_name}}')
    expect(spec!.bodyHtml).toContain('{{product_title}}')
    expect(spec!.bodyHtml).toContain('{{stars}}')
    expect(spec!.bodyHtml).toContain('{{title_html}}')
    expect(spec!.bodyHtml).toContain('{{body_html}}')
    expect(spec!.bodyHtml).toContain('{{product_url}}')
  })

  it('embeds the unsubscribe marker (reviews-category footer requirement)', () => {
    // Reviews is an opt-out category — send.ts injects the unsubscribe
    // vars, the template has to CONSUME them or the CAN-SPAM-safe
    // footer silently drops.
    expect(spec).toBeTruthy()
    expect(spec!.bodyHtml).toContain('{{unsubscribe_html}}')
    expect(spec!.bodyText).toContain('{{unsubscribe_text}}')
  })

  it('subject interpolates {{product_title}}', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject).toContain('{{product_title}}')
  })

  it('bodyText is plain and contains the product URL + shop_name', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{product_url}}')
    expect(spec!.bodyText).toContain('{{shop_name}}')
  })

  it('declares variables matching the sendReviewApproved shim', () => {
    expect(spec).toBeTruthy()
    for (const v of [
      'customer_name',
      'product_title',
      'product_url',
      'shop_name',
      'stars',
      'title_html',
      'body_html',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 12 — review_replied
// ---------------------------------------------------------------------------
//
// Reviews category, companion to review_approved. Idempotency is
// review-id + SHA-256-prefix of the reply body — merchant typo-fix +
// re-notify fires a new email (new hash), but exact-replay dedupes.

describe('PR2 commit 12: review_replied', () => {
  const spec = getTemplate('review_replied')

  it('is present, implemented, reviews, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('reviews')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/sent you a reply/i)
    expect(spec!.bodyHtml).toContain('{{customer_name}}')
    expect(spec!.bodyHtml).toContain('{{product_title}}')
    expect(spec!.bodyHtml).toContain('{{shop_name}}')
    expect(spec!.bodyHtml).toContain('{{body_html}}')
    expect(spec!.bodyHtml).toContain('{{reply_author}}')
    expect(spec!.bodyHtml).toContain('{{reply_body_html}}')
    expect(spec!.bodyHtml).toContain('{{product_url}}')
  })

  it('embeds the unsubscribe marker (reviews-category footer requirement)', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyHtml).toContain('{{unsubscribe_html}}')
    expect(spec!.bodyText).toContain('{{unsubscribe_text}}')
  })

  it('subject interpolates {{shop_name}}', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject).toContain('{{shop_name}}')
  })

  it('bodyText is plain and contains reply + customer review bodies', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{reply_body_html}}')
    expect(spec!.bodyText).toContain('{{body_html}}')
    expect(spec!.bodyText).toContain('{{product_url}}')
  })

  it('declares variables matching the sendReviewReplied shim', () => {
    expect(spec).toBeTruthy()
    for (const v of [
      'customer_name',
      'product_title',
      'product_url',
      'shop_name',
      'stars',
      'body_html',
      'reply_author',
      'reply_body_html',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 13 — new_order_received (merchant ops alert)
// ---------------------------------------------------------------------------
//
// Ops category, audience='merchant'. Fires alongside every
// `sendOrderConfirmation` callsite in server.ts (6 places: 1 generic
// checkout + 2 paypal-partner captures + 1 paypal direct capture +
// 1 stripe webhook + 1 paypal webhook). Recipient resolves from
// shops.email (no staff fan-out in this phase). ops = forced-send, so
// NO unsubscribe footer — sellers cannot opt-out of the "new order"
// alert.

describe('PR2 commit 13: new_order_received', () => {
  const spec = getTemplate('new_order_received')

  it('is present, implemented, ops, merchant-audience, priority 1', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('ops')
    expect(spec!.audience).toBe('merchant')
    expect(spec!.priority).toBe(1)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/New order received/i)
    expect(spec!.bodyHtml).toContain('{{order_number}}')
    expect(spec!.bodyHtml).toContain('{{customer_name}}')
    expect(spec!.bodyHtml).toContain('{{order_total}}')
    expect(spec!.bodyHtml).toContain('{{order_url}}')
    expect(spec!.bodyHtml).toContain('{{shop_name}}')
    expect(spec!.bodyHtml).toContain('{{currency}}')
    // CTA button — merchants click through to the order.
    expect(spec!.bodyHtml).toMatch(/View order/i)
  })

  it('does NOT reference unsubscribe markers (ops is forced-send)', () => {
    // Ops-category emails cannot be opted-out. If someone refactors
    // this template to opt-out style, the send.ts unsubscribe-footer
    // auto-injection still wouldn't fire (isForcedSendCategory covers
    // ops), but keeping the template MARKER-free is defence in depth.
    expect(spec).toBeTruthy()
    expect(spec!.bodyHtml).not.toContain('{{unsubscribe_html}}')
    expect(spec!.bodyText).not.toContain('{{unsubscribe_text}}')
  })

  it('subject interpolates {{order_number}}', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject).toContain('{{order_number}}')
  })

  it('bodyText is plain and contains order_url + customer_name', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{order_url}}')
    expect(spec!.bodyText).toContain('{{customer_name}}')
    expect(spec!.bodyText).toContain('{{order_total}}')
  })

  it('declares variables matching the sendNewOrderReceived shim', () => {
    expect(spec).toBeTruthy()
    for (const v of [
      'order_number',
      'order_total',
      'currency',
      'customer_name',
      'order_url',
      'shop_name',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 14 — order_canceled (customer-facing cancellation)
// ---------------------------------------------------------------------------
//
// Transactional category = forced-send, no unsubscribe footer. Fires
// from the admin cancel endpoint (`POST /api/store/:slug/orders/:id/
// cancel`) right after `cancelOrder()` commits. Idempotency is
// `order_canceled:<orderId>` so a seller double-click doesn't double-
// notify the customer. When the seller provides a reason, the shim
// renders a notice block; absent-reason renders cleanly empty.

describe('PR2 commit 14: order_canceled', () => {
  const spec = getTemplate('order_canceled')

  it('is present, implemented, transactional, customer-audience, priority 2', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(2)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Your order has been canceled/i)
    expect(spec!.bodyHtml).toContain('{{order_number}}')
    expect(spec!.bodyHtml).toContain('{{customer_name}}')
    expect(spec!.bodyHtml).toContain('{{shop_name}}')
    expect(spec!.bodyHtml).toContain('{{cancel_reason_html}}')
    expect(spec!.bodyHtml).toContain('{{line_items_html}}')
    expect(spec!.bodyHtml).toContain('{{total_price}}')
    // Refund ETA copy is contract — customers expect this exact phrasing
    // (matches the refund_notification template), so guard it.
    expect(spec!.bodyHtml).toMatch(/5-10 business days/i)
  })

  it('does NOT reference unsubscribe markers (transactional = forced-send)', () => {
    // Transactional category is non-opt-outable per
    // isForcedSendCategory. Guards against a refactor that adds
    // unsubscribe vars — those would be no-ops here and confusing.
    expect(spec).toBeTruthy()
    expect(spec!.bodyHtml).not.toContain('{{unsubscribe_html}}')
    expect(spec!.bodyText).not.toContain('{{unsubscribe_text}}')
  })

  it('subject interpolates {{order_number}}', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject).toContain('{{order_number}}')
  })

  it('bodyText is plain and contains shop_name + refund ETA', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{shop_name}}')
    expect(spec!.bodyText).toContain('{{total_price}}')
    expect(spec!.bodyText).toContain('{{cancel_reason_text}}')
    expect(spec!.bodyText).toMatch(/5-10 business days/i)
  })

  it('declares variables matching the sendOrderCanceled shim', () => {
    expect(spec).toBeTruthy()
    for (const v of [
      'order_number',
      'customer_name',
      'shop_name',
      'cancel_reason_html',
      'cancel_reason_text',
      'line_items_html',
      'currency',
      'total_price',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PR2 commit 15 — fulfillment_delivered (delivery confirmation)
// ---------------------------------------------------------------------------
//
// Customer-facing "your order has arrived" notice. Fires from the
// Lenful tracking-sync worker on the rising-edge shipped → delivered
// transition (carrier webhook text maps via mapStatus in
// tracking-sync.ts). Transactional category = forced-send, no
// unsubscribe footer. Idempotency is orderId-keyed so repeat "still
// delivered" carrier pings don't spam.

describe('PR2 commit 15: fulfillment_delivered', () => {
  const spec = getTemplate('fulfillment_delivered')

  it('is present, implemented, transactional, customer-audience, priority 2', () => {
    expect(spec).toBeTruthy()
    expect(spec!.implemented).toBe(true)
    expect(spec!.category).toBe('transactional')
    expect(spec!.audience).toBe('customer')
    expect(spec!.priority).toBe(2)
  })

  it('has real production HTML (no longer the shared scaffold)', () => {
    expect(spec).toBeTruthy()
    expect(looksLikeScaffold(spec!.bodyHtml)).toBe(false)
    expect(spec!.bodyHtml).toMatch(/Your order has arrived/i)
    expect(spec!.bodyHtml).toContain('{{order_number}}')
    expect(spec!.bodyHtml).toContain('{{customer_name}}')
    expect(spec!.bodyHtml).toContain('{{shop_name}}')
    expect(spec!.bodyHtml).toContain('{{line_items_html}}')
    expect(spec!.bodyHtml).toContain('{{shop_url}}')
    // Delivered badge UX — guard against copy change that weakens the
    // visual confirmation signal. Shopify's equivalent email has the
    // same pill.
    expect(spec!.bodyHtml).toMatch(/Delivered/)
  })

  it('does NOT reference unsubscribe markers (transactional = forced-send)', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyHtml).not.toContain('{{unsubscribe_html}}')
    expect(spec!.bodyText).not.toContain('{{unsubscribe_text}}')
  })

  it('subject is delivery-focused (not invoice or marketing)', () => {
    expect(spec).toBeTruthy()
    expect(spec!.subject.toLowerCase()).toMatch(/delivered/)
    // Guard against a template rename that accidentally folds in
    // review_request copy — that's a separate template.
    expect(spec!.subject.toLowerCase()).not.toContain('review')
  })

  it('bodyText is plain and contains line_items_text + shop_url', () => {
    expect(spec).toBeTruthy()
    expect(spec!.bodyText.includes('{{heading}}')).toBe(false)
    expect(spec!.bodyText).toContain('{{line_items_text}}')
    expect(spec!.bodyText).toContain('{{shop_url}}')
    expect(spec!.bodyText).toContain('{{shop_name}}')
  })

  it('declares variables matching the sendFulfillmentDelivered shim', () => {
    expect(spec).toBeTruthy()
    for (const v of [
      'order_number',
      'customer_name',
      'shop_name',
      'shop_url',
      'line_items_html',
      'line_items_text',
    ]) {
      expect(spec!.variables.includes(v), `variables missing ${v}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Regression guard — catalog size + count invariants still hold
// ---------------------------------------------------------------------------

describe('PR2 migrations — catalog invariants', () => {
  it('catalog size is 97 (95 original + 2 support notification envelopes from P0 fix)', () => {
    expect(Object.keys(EMAIL_TEMPLATE_CATALOG)).toHaveLength(97)
  })

  it('every migrated-so-far template still has audience/category/priority', () => {
    const migratedKeys: Array<keyof typeof EMAIL_TEMPLATE_CATALOG> = [
      'order_confirmation',
      'shipping_notification',
      'password_reset',
      'welcome',
      'refund_notification',
      'draft_order_invoice',
      'gift_card_delivery',
      'email_verify_otp',
      'two_fa_code',
      'abandoned_cart_recovery',
      'review_approved',
      'review_replied',
      'new_order_received',
      'order_canceled',
      'fulfillment_delivered',
    ]
    for (const key of migratedKeys) {
      const spec = EMAIL_TEMPLATE_CATALOG[key]
      expect(spec, `missing spec for ${String(key)}`).toBeTruthy()
      expect(spec.audience).toBeTruthy()
      expect(spec.category).toBeTruthy()
      expect([1, 2, 3, 4]).toContain(spec.priority)
    }
  })
})
