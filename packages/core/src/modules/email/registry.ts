/**
 * Gbox Platform — Email Template Registry (Phase 14 PR1)
 *
 * Single source of truth for every Shopify-class email Gbox ever sends.
 * One entry per `template_key`; `template_key` is also the PRIMARY KEY
 * on `email_template_registry` (migration 083).
 *
 * HOW THIS FITS
 * -------------
 *   - This file is the *authoritative in-code catalog*. The DB table
 *     `email_template_registry` is a *mirror* of this catalog, seeded
 *     from `scripts/seed-email-registry.ts`. Re-running the seed is
 *     safe (it UPSERTs).
 *   - The DB row is what holds seller / god-admin overrides (subject,
 *     body_html, active-toggle). When a sender wants the "current"
 *     rendered template, it should:
 *         1. SELECT from email_template_registry WHERE template_key=…
 *         2. Fall back to `CATALOG[key]` below if the row is missing
 *            (e.g. seed never ran in dev).
 *     The fallback prevents a missing seed from breaking transactional
 *     sends in dev / smoke runs.
 *   - `implemented=true` means there's a dedicated high-level sender in
 *     `service.ts` or another module that wires this template into a
 *     feature. 10 of the 97 rows are implemented at the end of PR1
 *     (the legacy BUILT_IN_TEMPLATES). The remaining 87 ship with
 *     scaffold HTML that admin preview can still render — subsequent
 *     PRs will bring them to production quality.
 *
 * ORGANIZATION
 * ------------
 *   95 entries total, grouped by the 7 Shopify-class categories and
 *   further by priority (1=MVP, 2=growth, 3=ops, 4=advanced):
 *
 *     transactional (23) — receipts the buyer expects, never unsubscribable
 *     marketing     (18) — campaigns + newsletter (opt-in only)
 *     lifecycle     (14) — welcome, win-back, post-purchase upsell
 *     reviews       ( 6) — review request + approval + reply notifications
 *     ops           (17) — merchant alerts (new order, low stock, payout, …)
 *     platform      ( 9) — god-admin internal digests (Iron Rule 5 — NEVER
 *                          seller-facing; recipient is @gbox.co mailbox)
 *     legal         ( 8) — GDPR / data export / ToS updates (forced send)
 *                   ———
 *                   95 total.
 *
 * IRON RULE 5
 * -----------
 *   Templates in the `platform` category are NEVER rendered in any
 *   seller-facing UI. The seed stores them so the god-admin dashboard
 *   at /god-admin/email can show them, but the merchant-facing email
 *   admin at /store-admin/settings/emails MUST filter them out:
 *   see the `getMerchantVisibleTemplates()` helper below.
 */

import type {
  EmailTemplateCategory,
  EmailTemplateAudience,
} from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Matches the CHECK constraint on email_template_registry.priority. */
export type TemplatePriority = 1 | 2 | 3 | 4

/**
 * Static spec for one template. Used both to seed the DB row and as the
 * in-memory fallback when the DB row is missing (pre-seed dev boxes).
 */
export interface TemplateSpec {
  key: string
  category: EmailTemplateCategory
  audience: EmailTemplateAudience
  priority: TemplatePriority
  subject: string
  bodyHtml: string
  bodyText: string
  /** Named `{{variable}}` placeholders in subject + bodyHtml + bodyText. */
  variables: string[]
  description: string
  /**
   * True if an in-code sender (e.g. `sendOrderConfirmation()`) wires
   * this template into a real feature path. False means scaffolded-only;
   * the template renders placeholder HTML until a later PR builds the
   * feature that fires it.
   */
  implemented: boolean
}

// ---------------------------------------------------------------------------
// Shared scaffold HTML
// ---------------------------------------------------------------------------
//
// Every `implemented=false` template ships with a clean, shop-brandable
// default. We render an H1 from `{{heading}}`, body text from
// `{{body_html}}`, a primary CTA from `{{cta_label}} → {{cta_url}}` (both
// optional — the call sites can leave either blank and the template
// degrades gracefully), and a footer block with shop name + unsubscribe
// link (the unsubscribe link is only rendered for marketing/lifecycle
// categories — see service-side logic).
//
// Keeping one shared scaffold means the full 95-template seed stays
// ~300 lines instead of ~5000. Per-feature HTML gets added in the PR
// that wires the feature.

const SCAFFOLD_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111827; font-size: 24px; margin: 0 0 16px; }
  .body { color: #374151; line-height: 1.6; margin: 0 0 24px; }
  .btn { display: inline-block; padding: 12px 32px; background: #111827; color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 8px 0; }
  .btn-wrap { text-align: center; margin: 24px 0; }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; color: #9ca3af; font-size: 12px; text-align: center; }
  .footer a { color: #6b7280; text-decoration: underline; }
</style></head>
<body>
  <div class="container">
    <h1>{{heading}}</h1>
    <div class="body">{{body_html}}</div>
    {{cta_html}}
    <div class="footer">
      <p>{{shop_name}}</p>
      {{unsubscribe_html}}
    </div>
  </div>
</body>
</html>`

const SCAFFOLD_TEXT = `{{heading}}

{{body_text}}

{{cta_text}}

---
{{shop_name}}
{{unsubscribe_text}}`

/** Shared variables every scaffold template understands. */
const SCAFFOLD_VARS = [
  'heading',
  'body_html',
  'body_text',
  'cta_html',
  'cta_text',
  'shop_name',
  'unsubscribe_html',
  'unsubscribe_text',
]

/**
 * Small helper: build a scaffold-backed template spec. The subject line
 * is the only category-specific bit that has to be filled in at
 * catalog-definition time.
 */
function scaffold(
  key: string,
  category: EmailTemplateCategory,
  audience: EmailTemplateAudience,
  priority: TemplatePriority,
  subject: string,
  description: string,
  extraVars: string[] = [],
  // Phase 14 PR6 — optional 8th arg to flip implemented on
  // scaffold-backed templates that now have a live trigger wire but
  // still re-use the generic scaffold HTML body. Defaults to false so
  // existing call sites are unchanged; PR6 passes `true` on the 14
  // keys whose emit path was landed in commit 5.
  implemented = false,
): TemplateSpec {
  return {
    key,
    category,
    audience,
    priority,
    subject,
    bodyHtml: SCAFFOLD_HTML,
    bodyText: SCAFFOLD_TEXT,
    variables: [...SCAFFOLD_VARS, ...extraVars],
    description,
    implemented,
  }
}

// ---------------------------------------------------------------------------
// The 95-template catalog
// ---------------------------------------------------------------------------
//
// Template keys follow the convention:
//   <subject>_<verb>_<target>
// e.g. `order_confirmation`, `password_reset`, `new_order_received`.
// Keys are snake_case and stable — they appear in DB rows, log lines,
// and the admin URL `/god-admin/email/templates/:key` so renaming is
// migrations-territory.

export const EMAIL_TEMPLATE_CATALOG: Record<string, TemplateSpec> = {
  // ─── TRANSACTIONAL (22) ─────────────────────────────────────────────
  // Receipts / confirmations the buyer expects. Never unsubscribable.
  // Priority 1 = already wired in PR1; priority 2 = PR2+.

  order_confirmation: {
    key: 'order_confirmation',
    category: 'transactional',
    audience: 'customer',
    priority: 1,
    subject: 'Order #{{order_number}} confirmed',
    // PR2 commit 1 — real HTML ported from legacy service.ts::BUILT_IN_TEMPLATES
    // into the registry so `sendTemplatedEmail` can serve it without falling
    // back to scaffold. Seller overrides take precedence via PR1.5's
    // `email_template_overrides` table.
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #333; font-size: 24px; }
  .order-number { color: #666; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { font-weight: 600; color: #333; }
  .totals td { border-bottom: none; }
  .total-row td { font-weight: 700; font-size: 16px; border-top: 2px solid #333; }
  .footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Thank you for your order!</h1>
    <p class="order-number">Order #{{order_number}}</p>
    <p>Hi {{customer_name}}, we've received your order and it's being processed.</p>
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>{{line_items_html}}</tbody>
    </table>
    <table class="totals">
      <tr><td>Subtotal</td><td>{{currency}} {{subtotal_price}}</td></tr>
      <tr><td>Shipping</td><td>{{currency}} {{total_shipping}}</td></tr>
      <tr><td>Tax</td><td>{{currency}} {{total_tax}}</td></tr>
      {{discount_row}}
      <tr class="total-row"><td>Total</td><td>{{currency}} {{total_price}}</td></tr>
    </table>
    <div class="footer"><p>If you have questions, reply to this email.</p></div>
  </div>
</body>
</html>`,
    bodyText: `Thank you for your order!

Order #{{order_number}}

Hi {{customer_name}}, we've received your order and it's being processed.

Subtotal: {{currency}} {{subtotal_price}}
Shipping: {{currency}} {{total_shipping}}
Tax:      {{currency}} {{total_tax}}
Total:    {{currency}} {{total_price}}

If you have questions, reply to this email.`,
    variables: ['order_number', 'customer_name', 'currency', 'subtotal_price', 'total_shipping', 'total_tax', 'total_discounts', 'total_price', 'line_items_html', 'discount_row'],
    description: 'Order placed successfully. Sent immediately after checkout completes.',
    implemented: true,
  },
  shipping_notification: {
    key: 'shipping_notification',
    category: 'transactional',
    audience: 'customer',
    priority: 1,
    subject: 'Your order #{{order_number}} has shipped',
    // PR2 commit 2 — real HTML ported from legacy BUILT_IN_TEMPLATES.
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #333; font-size: 24px; }
  .tracking { background: #f0f7ff; border-radius: 6px; padding: 16px; margin: 20px 0; }
  .tracking a { color: #0066cc; text-decoration: none; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  .footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Your order is on its way!</h1>
    <p>Hi {{customer_name}}, your order #{{order_number}} has shipped.</p>
    {{tracking_html}}
    <table>
      <thead><tr><th>Item</th><th>Qty</th></tr></thead>
      <tbody>{{line_items_html}}</tbody>
    </table>
    <div class="footer"><p>If you have questions, reply to this email.</p></div>
  </div>
</body>
</html>`,
    bodyText: `Your order is on its way!

Hi {{customer_name}}, your order #{{order_number}} has shipped.

{{tracking_html}}

If you have questions, reply to this email.`,
    variables: ['order_number', 'customer_name', 'tracking_html', 'line_items_html'],
    description: 'Fulfillment marked shipped. Contains tracking number + carrier.',
    implemented: true,
  },
  // WIRED_PR2 — triggered from apps/accounts/src/pages/forgot-password.ts
  //             via sendTemplatedEmail (idempotency key: password_reset:{userId}:{tokenHash}).
  password_reset: {
    key: 'password_reset',
    category: 'transactional',
    audience: 'customer',
    priority: 1,
    subject: 'Reset your password',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #333; font-size: 24px; }
  .btn { display: inline-block; padding: 12px 32px; background: #333; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
  .footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Reset your password</h1>
    <p>Hi {{user_name}}, we received a request to reset your password.</p>
    <p>Click the button below to set a new password. This link expires in 1 hour.</p>
    <a href="{{reset_url}}" class="btn">Reset Password</a>
    <p style="color:#999;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    <div class="footer"><p>This is an automated message.</p></div>
  </div>
</body>
</html>`,
    bodyText: `Reset your password

Hi {{user_name}}, we received a request to reset your password.

Click the link below to set a new password. This link expires in 1 hour:

{{reset_url}}

If you didn't request this, you can safely ignore this email.`,
    variables: ['user_name', 'reset_url'],
    description: 'Password reset link, 1-hour TTL.',
    implemented: true,
  },
  // WIRED_PR2 — triggered from apps/accounts/src/pages/create-store.ts
  //             right after the seller finishes signup + creates their
  //             first shop (idempotency key: welcome:{userId}:{shopId}).
  welcome: {
    key: 'welcome',
    category: 'transactional',
    audience: 'customer',
    priority: 1,
    subject: 'Welcome to {{shop_name}}!',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #333; font-size: 24px; }
  .btn { display: inline-block; padding: 12px 32px; background: #333; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
  .footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Welcome, {{user_name}}!</h1>
    <p>Your account has been created. You're all set to start using {{shop_name}}.</p>
    <a href="{{login_url}}" class="btn">Get Started</a>
    <div class="footer"><p>If you have questions, reply to this email.</p></div>
  </div>
</body>
</html>`,
    bodyText: `Welcome, {{user_name}}!

Your account has been created. You're all set to start using {{shop_name}}.

Get started: {{login_url}}

If you have questions, reply to this email.`,
    variables: ['user_name', 'shop_name', 'login_url'],
    description: 'First-touch account created. Sent once on signup confirmation.',
    implemented: true,
  },
  // WIRED_PR2 — triggered from server.ts refund endpoints
  //             (sendRefundNotification shim delegates to sendTemplatedEmail).
  refund_notification: {
    key: 'refund_notification',
    category: 'transactional',
    audience: 'customer',
    priority: 1,
    subject: 'Refund for order #{{order_number}}',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #333; font-size: 24px; }
  .refund-amount { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 16px; margin: 20px 0; text-align: center; }
  .refund-amount .amount { font-size: 28px; font-weight: 700; color: #16a34a; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { font-weight: 600; color: #333; }
  .reason { background: #f9fafb; border-radius: 6px; padding: 12px; margin: 16px 0; color: #666; }
  .footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>You've been refunded</h1>
    <p>Hi {{customer_name}}, a refund has been issued for order #{{order_number}}.</p>
    <div class="refund-amount">
      <div class="amount">{{currency}} {{refund_amount}}</div>
      <div style="color:#666;font-size:13px;margin-top:4px;">Refund amount</div>
    </div>
    <div class="reason"><strong>Reason:</strong> {{reason}}</div>
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>{{line_items_html}}</tbody>
    </table>
    <p style="color:#666;font-size:13px;">The refund may take 5-10 business days to appear on your statement.</p>
    <div class="footer"><p>If you have questions, reply to this email.</p></div>
  </div>
</body>
</html>`,
    bodyText: `You've been refunded

Hi {{customer_name}}, a refund has been issued for order #{{order_number}}.

Refund amount: {{currency}} {{refund_amount}}
Reason: {{reason}}

The refund may take 5-10 business days to appear on your statement.

If you have questions, reply to this email.`,
    variables: ['order_number', 'customer_name', 'refund_amount', 'currency', 'reason', 'line_items_html'],
    description: 'Refund issued. Breakdown by line item + reason.',
    implemented: true,
  },
  // WIRED_PR2 — triggered from apps/store-admin/src/pages/draft-orders.ts
  //             via `sendInvoice()` shim (idempotency key: draft_invoice:{orderId}).
  //
  // Note: the HTML uses `{{note_html}}` + `{{due_date_html}}` (pre-wrapped
  // in markup at the callsite) rather than raw `{{note}}` + `{{due_date}}`
  // so an empty value collapses the section entirely instead of leaving a
  // dangling "Due: " / "Note: " label — matches Shopify's behaviour.
  draft_order_invoice: {
    key: 'draft_order_invoice',
    category: 'transactional',
    audience: 'customer',
    priority: 1,
    subject: 'Invoice for order #{{order_number}}',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #333; font-size: 24px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { font-weight: 600; color: #333; }
  .total-row td { font-weight: 700; font-size: 16px; border-top: 2px solid #333; }
  .btn { display: inline-block; padding: 14px 36px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; font-size: 16px; }
  .btn-wrap { text-align: center; }
  .note { background: #f9fafb; border-radius: 6px; padding: 12px; margin: 16px 0; color: #666; font-size: 13px; }
  .due-date { color: #dc2626; font-weight: 600; }
  .footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Invoice #{{order_number}}</h1>
    <p>You have a pending order. Please review the details below and complete your payment.</p>
    {{due_date_html}}
    <table>
      <thead><tr><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Price</th></tr></thead>
      <tbody>{{line_items_html}}</tbody>
      <tfoot>
        <tr><td>Subtotal</td><td></td><td style="text-align:right">{{currency}} {{subtotal}}</td></tr>
        <tr class="total-row"><td>Total Due</td><td></td><td style="text-align:right">{{currency}} {{total}}</td></tr>
      </tfoot>
    </table>
    {{note_html}}
    <div class="btn-wrap">
      <a href="{{payment_url}}" class="btn">Pay Now</a>
    </div>
    <div class="footer"><p>If you have questions about this invoice, reply to this email.</p></div>
  </div>
</body>
</html>`,
    bodyText: `Invoice #{{order_number}}

You have a pending order. Please review the details below and complete your payment.

Subtotal: {{currency}} {{subtotal}}
Total Due: {{currency}} {{total}}

Pay now: {{payment_url}}

If you have questions about this invoice, reply to this email.`,
    variables: [
      'order_number',
      'line_items_html',
      'subtotal',
      'total',
      'currency',
      'note_html',
      'due_date_html',
      'payment_url',
    ],
    description: 'Pay-now link for draft order (Shopify: "send invoice").',
    implemented: true,
  },
  // WIRED_PR2 — triggered from packages/core/src/modules/gift-cards/email.ts
  //             via `sendGiftCardDelivery()` shim. Idempotency: gift_card:{code}.
  //             Scheduled delivery via the cron hook in the same module.
  gift_card_delivery: {
    key: 'gift_card_delivery',
    category: 'transactional',
    audience: 'customer',
    priority: 1,
    subject: 'You\'ve received a gift card from {{sender_name}}',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #333; font-size: 26px; margin-bottom: 8px; }
  .sub { color: #666; font-size: 14px; margin-top: 0; }
  .card-box { margin: 28px 0; padding: 28px; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); border-radius: 12px; text-align: center; color: #fff; }
  .card-box .amount { font-size: 44px; font-weight: 800; letter-spacing: -1px; }
  .card-box .currency { font-size: 20px; opacity: .85; margin-right: 6px; }
  .card-box .label { text-transform: uppercase; letter-spacing: 1.5px; font-size: 11px; opacity: .85; margin-top: 6px; }
  .code { display: inline-block; background: #fff; color: #1f2937; font-family: 'SF Mono', Menlo, monospace; font-size: 20px; letter-spacing: 2px; padding: 14px 24px; border-radius: 8px; margin-top: 18px; font-weight: 600; }
  .message { background: #f9fafb; border-left: 4px solid #6366f1; border-radius: 4px; padding: 16px 18px; margin: 24px 0; color: #374151; font-style: italic; }
  .how { margin-top: 32px; padding-top: 24px; border-top: 1px solid #eee; color: #4b5563; font-size: 13px; line-height: 1.6; }
  .how ol { padding-left: 18px; margin: 8px 0 0; }
  .expires { margin-top: 16px; color: #6b7280; font-size: 12px; }
  .footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>You've received a gift card!</h1>
    <p class="sub">Hi {{recipient_name}}, {{sender_name}} has sent you a gift card from {{shop_name}}.</p>
    <div class="card-box">
      <div><span class="currency">{{currency}}</span><span class="amount">{{initial_value}}</span></div>
      <div class="label">Gift Card Value</div>
      <div class="code">{{code}}</div>
    </div>
    {{message_html}}
    <div class="how">
      <strong>How to redeem</strong>
      <ol>
        <li>Add items to your cart at {{shop_name}}.</li>
        <li>Paste the code above at checkout.</li>
        <li>The balance is applied automatically.</li>
      </ol>
      {{expires_html}}
    </div>
    <div class="footer"><p>If you have questions, reply to this email.</p></div>
  </div>
</body>
</html>`,
    bodyText: `You've received a gift card!

Hi {{recipient_name}}, {{sender_name}} has sent you a gift card from {{shop_name}}.

Gift Card Value: {{currency}} {{initial_value}}
Code: {{code}}

How to redeem:
1. Add items to your cart at {{shop_name}}.
2. Paste the code above at checkout.
3. The balance is applied automatically.

If you have questions, reply to this email.`,
    variables: ['code', 'currency', 'initial_value', 'recipient_name', 'sender_name', 'shop_name', 'message_html', 'expires_html'],
    description: 'Gift card code delivered to recipient.',
    implemented: true,
  },

  // The "pending" transactional wave — scaffold-backed until per-feature PRs
  // wire them up. Each one pairs with a feature in the Shopify flow.
  //
  // DEFERRED from PR2 — tracked in docs/email-system/phase-14-deferred.md
  // When you build the related feature, WIRE the email as part of
  // acceptance. Do NOT ship the feature with the scaffold still
  // scaffold-only; flip `implemented: true` and remove the
  // `DEFERRED_PR2` comment on that spec.
  //
  // WIRED in PR2 (marked below with WIRED_PR2): order_canceled,
  // fulfillment_delivered. Plus email_verify_otp, two_fa_code (both
  // priority 1) are WIRED_PR2 as well.

  // PR2 commit 14 — WIRED_PR2. Customer-facing cancellation notice.
  // Fires from `POST /api/store/:slug/orders/:orderId/cancel` after
  // cancelOrder() in orders/service.ts commits. Transactional category
  // = no unsubscribe footer, cannot be opted-out (you need the "we
  // cancelled your order" notice even if you hate our marketing).
  // Idempotency is orderId-keyed: a double-click of the seller's
  // "Cancel order" button doesn't re-fan.
  order_canceled: {
    key: 'order_canceled',
    category: 'transactional',
    audience: 'customer',
    priority: 2,
    subject: 'Order #{{order_number}} canceled',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111; font-size: 22px; margin: 0 0 8px 0; }
  .order-number { color: #6b7280; font-size: 14px; margin: 0 0 20px 0; }
  .notice { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 16px 0; border-radius: 4px; color: #78350f; font-size: 14px; }
  .reason-row { margin: 12px 0; font-size: 14px; color: #374151; }
  .reason-row strong { color: #111; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  th { font-weight: 600; color: #4b5563; background: #f9fafb; }
  .refund-note { background: #ecfdf5; border-left: 4px solid #10b981; padding: 12px 16px; margin: 20px 0; border-radius: 4px; color: #065f46; font-size: 14px; }
  .footer { margin-top: 32px; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Your order has been canceled</h1>
    <p class="order-number">Order #{{order_number}}</p>
    <p>Hi {{customer_name}}, we're writing to confirm that your order with {{shop_name}} has been canceled.</p>
    {{cancel_reason_html}}
    <table>
      <thead><tr><th>Item</th><th>Qty</th></tr></thead>
      <tbody>{{line_items_html}}</tbody>
    </table>
    <div class="refund-note">
      <strong>Refund:</strong> If you were charged for this order, you'll receive a refund of {{currency}} {{total_price}} to your original payment method within 5-10 business days.
    </div>
    <p>If you have any questions about this cancellation, reply to this email and we'll help you out.</p>
    <p class="footer">Sent by {{shop_name}} — this is a transactional notice you cannot unsubscribe from.</p>
  </div>
</body>
</html>`,
    bodyText: `Your order has been canceled

Order #{{order_number}}

Hi {{customer_name}}, your order with {{shop_name}} has been canceled.

{{cancel_reason_text}}

Refund: If you were charged for this order, you'll receive a refund of
{{currency}} {{total_price}} to your original payment method within
5-10 business days.

If you have any questions, reply to this email.

— {{shop_name}}`,
    variables: [
      'order_number',
      'customer_name',
      'shop_name',
      'cancel_reason_html',
      'cancel_reason_text',
      'line_items_html',
      'currency',
      'total_price',
    ],
    description: 'Customer-facing cancellation notice with refund ETA. WIRED_PR2.',
    implemented: true,
  },
  // DEFERRED_PR2 — Edit Order feature (low-volume Shopify parity); see phase-14-deferred.md §10
  order_edited: scaffold(
    'order_edited', 'transactional', 'customer', 2,
    'Your order #{{order_number}} was updated',
    'Merchant edited a line item / address after payment.',
  ),
  // DEFERRED_PR2 — Phase 12 PayPal / deferred-capture flows; see phase-14-deferred.md §1
  order_paid: scaffold(
    'order_paid', 'transactional', 'customer', 2,
    'Payment received for order #{{order_number}}',
    'Separate payment-captured receipt (for deferred-capture flows).',
  ),
  // DEFERRED_PR2 — invoice reminder cron; see phase-14-deferred.md §11
  order_invoice_sent: scaffold(
    'order_invoice_sent', 'transactional', 'customer', 2,
    'Invoice sent for order #{{order_number}}',
    'Reminder that an invoice has been issued (follow-up on draft_order_invoice).',
  ),
  // DEFERRED_PR2 — BOPIS / local-pickup feature; see phase-14-deferred.md §3
  fulfillment_ready_for_pickup: scaffold(
    'fulfillment_ready_for_pickup', 'transactional', 'customer', 2,
    'Your order is ready for pickup',
    'Local / BOPIS pickup ready notification.',
  ),
  // DEFERRED_PR2 — carrier webhook granularity; see phase-14-deferred.md §4
  fulfillment_out_for_delivery: scaffold(
    'fulfillment_out_for_delivery', 'transactional', 'customer', 2,
    'Your order is out for delivery',
    'Carrier picked up, same-day or last-mile delivery signal.',
  ),
  // PR2 commit 15 — WIRED_PR2. Customer-facing delivery confirmation.
  // Fires from the Lenful tracking-sync worker on the rising-edge
  // transition `shipped → delivered` (mapStatus in tracking-sync.ts
  // picks this up from carrier webhook text). Idempotency is
  // orderId-keyed so repeated carrier pings of "still delivered" don't
  // re-send. Transactional = forced-send (no unsubscribe footer) —
  // Shopify parity; customers always get the "it arrived" email even
  // if they opt out of marketing. This is the template that unblocks
  // the downstream `review_request` nudge (scheduled via the existing
  // reviews module; lives in a later PR since review_request is
  // priority 2 lifecycle).
  fulfillment_delivered: {
    key: 'fulfillment_delivered',
    category: 'transactional',
    audience: 'customer',
    priority: 2,
    subject: 'Your order has been delivered',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111; font-size: 22px; margin: 0 0 8px 0; }
  .order-number { color: #6b7280; font-size: 14px; margin: 0 0 20px 0; }
  .delivered-badge { display: inline-block; background: #ecfdf5; color: #065f46; border: 1px solid #10b981; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  th { font-weight: 600; color: #4b5563; background: #f9fafb; }
  .btn-wrap { margin: 28px 0 16px 0; text-align: center; }
  .btn { display: inline-block; background: #111; color: #fff !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; }
  .footer { margin-top: 32px; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <span class="delivered-badge">Delivered</span>
    <h1>Your order has arrived</h1>
    <p class="order-number">Order #{{order_number}}</p>
    <p>Hi {{customer_name}}, great news — your order from {{shop_name}} has been delivered. We hope you love it.</p>
    <table>
      <thead><tr><th>Item</th><th>Qty</th></tr></thead>
      <tbody>{{line_items_html}}</tbody>
    </table>
    <p>If anything's not right, reply to this email and we'll help you out.</p>
    <div class="btn-wrap"><a href="{{shop_url}}" class="btn">Shop again</a></div>
    <p class="footer">Sent by {{shop_name}} — this is a transactional delivery confirmation.</p>
  </div>
</body>
</html>`,
    bodyText: `Your order has arrived

Order #{{order_number}}

Hi {{customer_name}}, great news — your order from {{shop_name}} has
been delivered. We hope you love it.

{{line_items_text}}

If anything's not right, reply to this email and we'll help.

Shop again: {{shop_url}}

— {{shop_name}}`,
    variables: [
      'order_number',
      'customer_name',
      'shop_name',
      'shop_url',
      'line_items_html',
      'line_items_text',
    ],
    description: 'Delivery confirmation; triggers review-request flow. WIRED_PR2.',
    implemented: true,
  },
  // DEFERRED_PR2 — carrier webhook granularity; see phase-14-deferred.md §5
  fulfillment_failed: scaffold(
    'fulfillment_failed', 'transactional', 'customer', 2,
    'Issue delivering your order #{{order_number}}',
    'Carrier returned non-deliverable. Merchant needs to action.',
  ),
  // DEFERRED_PR2 — RMA/returns system; see phase-14-deferred.md §6
  return_requested: scaffold(
    'return_requested', 'transactional', 'customer', 2,
    'We received your return request',
    'Confirmation that return request is under review.',
  ),
  // DEFERRED_PR2 — RMA/returns system; see phase-14-deferred.md §7
  return_approved: scaffold(
    'return_approved', 'transactional', 'customer', 2,
    'Your return for order #{{order_number}} was approved',
    'Return label + instructions.',
  ),
  // DEFERRED_PR2 — RMA/returns system; see phase-14-deferred.md §8
  return_declined: scaffold(
    'return_declined', 'transactional', 'customer', 2,
    'About your return request',
    'Return not eligible — reason + contact info.',
  ),
  // DEFERRED_PR2 — RMA/returns system; see phase-14-deferred.md §9
  return_received: scaffold(
    'return_received', 'transactional', 'customer', 2,
    'We received your return',
    'Warehouse scanned the return; refund processing next.',
  ),
  // WIRED_PR2 (+ rewired in PR8 bug-11 rescan) — signup email verification OTP.
  //
  // This is a PLATFORM-OWNED template, not a per-shop customizable one —
  // it's the signup OTP users receive when registering for the Gbox
  // Platform itself (before they have a shop).
  //
  // Transport history:
  //   - Pre-PR8 (Phase 14 PR1 era): delivered through the external
  //     `smtp-gbox` HTTP relay shim at apps/accounts/src/lib/smtp-gbox.ts.
  //   - PR8 cluster-A (commit b925dae) killed the shim and moved this
  //     template into the in-process @gbox/core/modules/email pipeline —
  //     same `sendTemplatedEmail({ key: 'email_verify_otp' })` path as
  //     every other transactional email. Transport selection now goes
  //     through `resolveTransport()` (Gmail SMTP in prod, Console in dev).
  //
  // This registry row exists so:
  //   (a) god-admin preview can inspect the production copy Thai signed off,
  //   (b) the catalog + `scripts/seed-email-registry.ts` stay
  //       exhaustively-accounting (no orphans),
  //   (c) the signup helper `apps/accounts/src/lib/send-signup-otp.ts`
  //       looks up the spec by key so variables + subject come from a
  //       single source of truth.
  //
  // Iron rule 5 — `audience='god_admin'` means `getMerchantVisibleTemplates()`
  // filters it out of the seller-facing override UI. Sellers can't
  // (and shouldn't) edit platform signup copy. Critically, audience here
  // is an ADMIN-UI permission marker, NOT a recipient filter — the
  // `shopId=null` call from send-signup-otp.ts lets the send proceed
  // normally (see `signup-otp-audience.test.ts` for the full story).
  email_verify_otp: {
    key: 'email_verify_otp',
    category: 'platform',
    audience: 'god_admin',
    priority: 1,
    subject: 'Your Gbox verification code',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111827; font-size: 24px; margin-bottom: 8px; }
  .code-box { margin: 28px 0; padding: 28px 20px; background: #f0f4ff; border: 1px solid #dbe4ff; border-radius: 10px; text-align: center; }
  .code { font-family: 'SF Mono', Menlo, monospace; font-size: 32px; letter-spacing: 8px; font-weight: 700; color: #1e3a8a; }
  .expire { color: #6b7280; font-size: 13px; margin-top: 12px; }
  .footer { margin-top: 32px; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Verify your email</h1>
    <p>Welcome to Gbox! Enter the 6-digit code below to finish creating your account.</p>
    <div class="code-box">
      <div class="code">{{otp_code}}</div>
      <div class="expire">This code expires in {{expires_minutes}} minutes.</div>
    </div>
    <p style="color:#6b7280;font-size:13px;">If you didn't sign up for Gbox, you can safely ignore this email.</p>
    <div class="footer"><p>This is an automated message from Gbox.</p></div>
  </div>
</body>
</html>`,
    bodyText: `Verify your email

Welcome to Gbox! Enter the 6-digit code below to finish creating your account:

{{otp_code}}

This code expires in {{expires_minutes}} minutes.

If you didn't sign up for Gbox, you can safely ignore this email.`,
    variables: ['otp_code', 'expires_minutes'],
    description: 'Signup email-verification OTP (platform-owned; delivered in-process via @gbox/core/modules/email, post PR8 cluster-A).',
    implemented: true,
  },
  // DEFERRED_PR2 — passwordless auth UX; see phase-14-deferred.md §2
  magic_link_login: scaffold(
    'magic_link_login', 'transactional', 'customer', 2,
    'Sign in to {{shop_name}}',
    'Passwordless magic-link login.',
    ['login_url', 'expires_minutes'],
  ),
  // WIRED_PR2 — 2FA sign-in code
  //
  // Serves BOTH surfaces off one template (generic copy, no "God Admin"
  // mention anywhere so it works identically for the two callsites):
  //
  //   1. Seller 2FA email OTP — apps/accounts/src/pages/login-2fa.ts
  //   2. God-admin 2FA email OTP — apps/god-admin/src/pages/login-2fa.ts
  //
  // Both pass `shopId: null` (platform-scoped send — this email is not
  // tied to any single shop; it's authentication infrastructure).
  //
  // Iron rule 5 — `audience='god_admin'` means the seller override UI
  // (`getMerchantVisibleTemplates()`) filters this out, so sellers
  // CANNOT customize their 2FA copy. Security-critical auth emails
  // are platform-owned, same as Shopify's locked password-reset.
  // Pairing with `category='platform'` is a structural invariant
  // enforced by registry.test.ts.
  two_fa_code: {
    key: 'two_fa_code',
    category: 'platform',
    audience: 'god_admin',
    priority: 1,
    subject: 'Your Gbox sign-in code',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #0f172a; font-size: 20px; margin: 0 0 12px; }
  p { color: #475569; font-size: 14px; line-height: 1.6; }
  .code-box { margin: 24px 0; padding: 20px; background: #f1f5f9; border-radius: 10px; text-align: center; }
  .code { font-family: 'SF Mono', Monaco, monospace; font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #0f172a; }
  .warn { color: #64748b; font-size: 12px; }
  .footer { margin-top: 32px; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Gbox sign-in code</h1>
    <p>Someone is signing in to your Gbox account. If that's you, use the code below within {{expires_minutes}} minutes:</p>
    <div class="code-box"><div class="code">{{code}}</div></div>
    <p class="warn">If you didn't try to sign in, ignore this email and change your password immediately.</p>
    <div class="footer"><p>This is an automated message from Gbox.</p></div>
  </div>
</body>
</html>`,
    bodyText: `Gbox sign-in code

Someone is signing in to your Gbox account. If that's you, use the code below within {{expires_minutes}} minutes:

{{code}}

If you didn't try to sign in, ignore this email and change your password immediately.`,
    variables: ['code', 'expires_minutes'],
    description: '2FA email sign-in code (platform-owned; used by seller + platform-admin login flows).',
    implemented: true,
  },

  // ─── MARKETING (18) ─────────────────────────────────────────────────
  // Merchant → customer promotions. Requires explicit opt-in (category
  // "marketing" in email_preferences).

  newsletter_broadcast: scaffold(
    'newsletter_broadcast', 'marketing', 'customer', 2,
    '{{subject}}',
    'Newsletter / broadcast blast sent from the Campaigns admin.',
    ['subject', 'preheader', 'sections_html'],
  ),
  campaign_promo: scaffold(
    'campaign_promo', 'marketing', 'customer', 2,
    '{{subject}}',
    'One-off marketing campaign (sale, collection launch, bundle).',
  ),
  flash_sale: scaffold(
    'flash_sale', 'marketing', 'customer', 2,
    'Flash sale: {{offer_headline}}',
    'Time-boxed flash-sale promo with countdown.',
    ['offer_headline', 'ends_at', 'discount_code'],
  ),
  seasonal_promo: scaffold(
    'seasonal_promo', 'marketing', 'customer', 3,
    '{{season_name}} savings inside',
    'Seasonal (Black Friday, Tet, Christmas) campaign.',
    ['season_name'],
  ),
  discount_code: scaffold(
    'discount_code', 'marketing', 'customer', 2,
    'Here\'s {{amount}} off your next order',
    'Manual discount-code send (loyalty, apology, partner co-op).',
    ['amount', 'code', 'expires_at'],
  ),
  product_launch: scaffold(
    'product_launch', 'marketing', 'customer', 2,
    'New: {{product_title}} is here',
    'Single-product launch / drop email.',
    ['product_title', 'product_url', 'hero_image_url'],
  ),
  collection_launch: scaffold(
    'collection_launch', 'marketing', 'customer', 3,
    'New collection: {{collection_title}}',
    'Merchandised collection launch.',
    ['collection_title', 'collection_url', 'hero_image_url'],
  ),
  back_in_stock: scaffold(
    'back_in_stock', 'marketing', 'customer', 2,
    '{{product_title}} is back in stock',
    'Stock-alert for subscribers of a specific variant.',
    ['product_title', 'product_url', 'variant_title'],
  ),
  price_drop: scaffold(
    'price_drop', 'marketing', 'customer', 3,
    'Price drop on {{product_title}}',
    'Price-alert for wishlist watchers.',
    ['product_title', 'product_url', 'old_price', 'new_price', 'currency'],
  ),
  free_shipping_offer: scaffold(
    'free_shipping_offer', 'marketing', 'customer', 3,
    'Free shipping on your next order',
    'Free-shipping promo (threshold or everyone).',
    ['threshold', 'expires_at'],
  ),
  bundle_offer: scaffold(
    'bundle_offer', 'marketing', 'customer', 3,
    'Save with this bundle',
    'Curated bundle promo.',
    ['bundle_title', 'bundle_url', 'bundle_price', 'savings'],
  ),
  loyalty_points_earned: scaffold(
    'loyalty_points_earned', 'marketing', 'customer', 3,
    'You earned {{points}} points',
    'Loyalty points accrual notification.',
    ['points', 'total_balance', 'redeem_url'],
  ),
  loyalty_tier_upgrade: scaffold(
    'loyalty_tier_upgrade', 'marketing', 'customer', 3,
    'You\'re now a {{tier_name}} member',
    'Tier-up congratulations.',
    ['tier_name', 'perks_html'],
  ),
  vip_exclusive: scaffold(
    'vip_exclusive', 'marketing', 'customer', 4,
    'VIP exclusive: {{offer_title}}',
    'VIP-segment-only promotional send.',
    ['offer_title', 'offer_url'],
  ),
  birthday_discount: scaffold(
    'birthday_discount', 'marketing', 'customer', 4,
    'Happy birthday from {{shop_name}}!',
    'Birthday gift / discount.',
    ['code', 'amount', 'expires_at'],
  ),
  anniversary: scaffold(
    'anniversary', 'marketing', 'customer', 4,
    'It\'s been {{years}} year(s)!',
    'Customer anniversary email.',
    ['years'],
  ),
  referral_invite: scaffold(
    'referral_invite', 'marketing', 'customer', 4,
    '{{referrer_name}} thinks you\'ll love {{shop_name}}',
    'Friend-referred-you invite (customer sent).',
    ['referrer_name', 'referrer_code', 'signup_url'],
  ),
  referral_reward: scaffold(
    'referral_reward', 'marketing', 'customer', 4,
    'Your friend signed up — here\'s your reward',
    'Reward confirmation when referred friend checks out.',
    ['reward_amount', 'code'],
  ),

  // ─── LIFECYCLE (14) ─────────────────────────────────────────────────
  // Automated customer-journey emails. Separate opt-out toggle from
  // marketing (so a customer can mute promos but still get
  // "you haven't shopped in a while").

  // WIRED_PR2 — abandoned cart recovery step 1 (1h after abandon).
  // Migrated from the legacy BUILT_IN_TEMPLATES HTML in service.ts.
  // Lifecycle category means: opt-out toggle is separate from marketing
  // (a customer can mute promos but still get "you left items in your
  // cart"), and the send.ts pipeline auto-injects an unsubscribe footer.
  abandoned_cart_recovery: {
    key: 'abandoned_cart_recovery',
    category: 'lifecycle',
    audience: 'customer',
    priority: 1,
    subject: 'You left items in your cart!',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #333; font-size: 24px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
  th { font-weight: 600; color: #333; }
  .total-row td { font-weight: 700; font-size: 16px; border-top: 2px solid #333; }
  .btn { display: inline-block; padding: 14px 36px; background: #333; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; font-size: 16px; }
  .btn-wrap { text-align: center; }
  .footer { margin-top: 32px; color: #999; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Don't forget your items!</h1>
    <p>Hi {{customer_name}}, you left some great items in your cart. Complete your purchase before they sell out!</p>
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>{{line_items_html}}</tbody>
      <tfoot><tr class="total-row"><td>Total</td><td></td><td>{{currency}} {{total}}</td></tr></tfoot>
    </table>
    <div class="btn-wrap">
      <a href="{{recovery_url}}" class="btn">Complete Your Order</a>
    </div>
    <div class="footer">
      <p>If you have questions, reply to this email.</p>
      <p>{{unsubscribe_html}}</p>
    </div>
  </div>
</body>
</html>`,
    bodyText: `Don't forget your items!

Hi {{customer_name}}, you left some great items in your cart. Complete your purchase before they sell out!

Total: {{currency}} {{total}}

Complete your order: {{recovery_url}}

If you have questions, reply to this email.

{{unsubscribe_text}}`,
    variables: ['customer_name', 'line_items_html', 'total', 'currency', 'recovery_url'],
    description: 'Abandoned-cart email 1 (Phase 8 PR2). Runs 1h after abandon. WIRED_PR2.',
    implemented: true,
  },
  abandoned_cart_reminder_2: scaffold(
    'abandoned_cart_reminder_2', 'lifecycle', 'customer', 2,
    'Still thinking it over?',
    'Abandoned-cart email 2. Runs 24h after abandon.',
  ),
  abandoned_cart_reminder_3: scaffold(
    'abandoned_cart_reminder_3', 'lifecycle', 'customer', 2,
    'Last chance: your cart expires soon',
    'Abandoned-cart email 3. Runs 72h after abandon.',
  ),
  abandoned_checkout_recovery: scaffold(
    'abandoned_checkout_recovery', 'lifecycle', 'customer', 2,
    'Complete your purchase',
    'Abandoned-checkout (reached checkout but didn\'t pay) recovery.',
  ),
  browse_abandonment: scaffold(
    'browse_abandonment', 'lifecycle', 'customer', 3,
    'Take another look at {{product_title}}',
    'Customer browsed but didn\'t add to cart.',
    ['product_title', 'product_url'],
  ),
  post_purchase_upsell: scaffold(
    'post_purchase_upsell', 'lifecycle', 'customer', 3,
    'Pairs well with your recent purchase',
    'Cross-sell based on last order.',
    ['recommended_items_html'],
  ),
  post_purchase_thank_you: scaffold(
    'post_purchase_thank_you', 'lifecycle', 'customer', 2,
    'Thank you for your order 💙',
    'Thank-you touch 3-7 days after delivery.',
  ),
  customer_win_back: scaffold(
    'customer_win_back', 'lifecycle', 'customer', 3,
    'We miss you!',
    'Dormant customer re-engagement (60+ days inactive).',
  ),
  customer_reactivation_offer: scaffold(
    'customer_reactivation_offer', 'lifecycle', 'customer', 3,
    'Come back for {{discount_amount}} off',
    'Dormant customer with incentive.',
    ['discount_amount', 'code'],
  ),
  first_order_milestone: scaffold(
    'first_order_milestone', 'lifecycle', 'customer', 4,
    'Welcome to the {{shop_name}} family',
    'Touch after first order confirmed.',
  ),
  repeat_customer_milestone: scaffold(
    'repeat_customer_milestone', 'lifecycle', 'customer', 4,
    'Milestone: your {{order_count}}th order!',
    'Customer-milestone celebration (5th, 10th, 25th order).',
    ['order_count'],
  ),
  replenishment_reminder: scaffold(
    'replenishment_reminder', 'lifecycle', 'customer', 3,
    'Time to reorder {{product_title}}?',
    'Consumable-product replenishment reminder.',
    ['product_title', 'product_url', 'days_since_order'],
  ),
  onboarding_day_1: scaffold(
    'onboarding_day_1', 'lifecycle', 'customer', 3,
    'Getting started with {{shop_name}}',
    'Day-1 of new-customer onboarding sequence.',
  ),
  onboarding_day_3: scaffold(
    'onboarding_day_3', 'lifecycle', 'customer', 3,
    'Here\'s what we recommend',
    'Day-3 of new-customer onboarding sequence.',
  ),

  // ─── REVIEWS (6) ────────────────────────────────────────────────────
  // Review request + moderation + notifications. Phase 10 PR3 already
  // wired `review_approved` and `review_replied`.

  review_request: scaffold(
    'review_request', 'reviews', 'customer', 2,
    'How was your {{product_title}}?',
    'Post-delivery review request. Fires 5-14d after fulfillment.',
    ['product_title', 'review_url'],
  ),
  // WIRED_PR2 — reviewer notified that their review was approved.
  // Reviews category → send.ts auto-injects unsubscribe footer (the
  // reviewer can mute this channel separately from marketing + promos).
  review_approved: {
    key: 'review_approved',
    category: 'reviews',
    audience: 'customer',
    priority: 1,
    subject: 'Your review on {{product_title}} is live',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111827; font-size: 24px; margin-bottom: 8px; }
  .sub { color: #6b7280; font-size: 14px; margin-top: 0; }
  .stars { font-size: 22px; letter-spacing: 2px; color: #f59e0b; margin: 16px 0 4px; }
  .review { background: #f9fafb; border-radius: 8px; padding: 18px 20px; margin: 20px 0; color: #374151; line-height: 1.6; }
  .review-title { font-weight: 600; color: #111827; margin-bottom: 6px; }
  .btn { display: inline-block; padding: 12px 28px; background: #111827; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 8px 0 0; }
  .footer { margin-top: 32px; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Thanks for sharing your thoughts!</h1>
    <p class="sub">Hi {{customer_name}}, your review of {{product_title}} at {{shop_name}} has been published.</p>
    <div class="stars">{{stars}}</div>
    <div class="review">
      {{title_html}}
      <div>{{body_html}}</div>
    </div>
    <a href="{{product_url}}" class="btn">View your review</a>
    <div class="footer">
      <p>Thanks for helping other shoppers &mdash; reply to this email if you have questions.</p>
      <p>{{unsubscribe_html}}</p>
    </div>
  </div>
</body>
</html>`,
    bodyText: `Thanks for sharing your thoughts!

Hi {{customer_name}}, your review of {{product_title}} at {{shop_name}} has been published.

Rating: {{stars}}

View your review: {{product_url}}

Thanks for helping other shoppers — reply to this email if you have questions.

{{unsubscribe_text}}`,
    variables: ['customer_name', 'product_title', 'product_url', 'shop_name', 'stars', 'title_html', 'body_html'],
    description: 'Reviewer notified their review was approved. WIRED_PR2.',
    implemented: true,
  },
  // WIRED_PR2 — reviewer notified the merchant replied to their review.
  // Reviews category → unsubscribe footer auto-injected by send.ts.
  review_replied: {
    key: 'review_replied',
    category: 'reviews',
    audience: 'customer',
    priority: 1,
    subject: '{{shop_name}} replied to your review',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111827; font-size: 24px; margin-bottom: 8px; }
  .sub { color: #6b7280; font-size: 14px; margin-top: 0; }
  .stars { font-size: 20px; letter-spacing: 2px; color: #f59e0b; margin: 14px 0 4px; }
  .review { background: #f9fafb; border-radius: 8px; padding: 16px 18px; margin: 16px 0; color: #374151; line-height: 1.6; }
  .reply { background: #eef2ff; border-left: 4px solid #6366f1; border-radius: 4px; padding: 16px 18px; margin: 20px 0; color: #1f2937; line-height: 1.6; }
  .reply-author { font-weight: 600; color: #4338ca; margin-bottom: 6px; font-size: 13px; letter-spacing: .3px; text-transform: uppercase; }
  .btn { display: inline-block; padding: 12px 28px; background: #4f46e5; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 8px 0 0; }
  .footer { margin-top: 32px; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>{{shop_name}} sent you a reply</h1>
    <p class="sub">Hi {{customer_name}}, the team responded to your review of {{product_title}}.</p>
    <div class="stars">{{stars}}</div>
    <div class="review">{{body_html}}</div>
    <div class="reply">
      <div class="reply-author">{{reply_author}}</div>
      <div>{{reply_body_html}}</div>
    </div>
    <a href="{{product_url}}" class="btn">View the conversation</a>
    <div class="footer">
      <p>If you have more to add, reply to this email and we'll get it to the seller.</p>
      <p>{{unsubscribe_html}}</p>
    </div>
  </div>
</body>
</html>`,
    bodyText: `{{shop_name}} sent you a reply

Hi {{customer_name}}, the team responded to your review of {{product_title}}.

Your review ({{stars}}):
{{body_html}}

Their reply ({{reply_author}}):
{{reply_body_html}}

View the conversation: {{product_url}}

If you have more to add, reply to this email and we'll get it to the seller.

{{unsubscribe_text}}`,
    variables: ['customer_name', 'product_title', 'product_url', 'shop_name', 'stars', 'body_html', 'reply_author', 'reply_body_html'],
    description: 'Reviewer notified the merchant replied. WIRED_PR2.',
    implemented: true,
  },
  review_rejected: scaffold(
    'review_rejected', 'reviews', 'customer', 3,
    'About your review',
    'Reviewer notified their review was rejected (moderation).',
  ),
  review_helpful_milestone: scaffold(
    'review_helpful_milestone', 'reviews', 'customer', 4,
    'Your review helped {{helpful_count}} shoppers',
    'Your review hit a helpful-vote milestone.',
    ['helpful_count'],
  ),
  review_reminder: scaffold(
    'review_reminder', 'reviews', 'customer', 3,
    'A reminder to review your purchase',
    'Second nudge if review_request got no click.',
    ['product_title', 'review_url'],
  ),

  // ─── OPS (18) ───────────────────────────────────────────────────────
  // Merchant-facing operational alerts. Recipients are shop owners /
  // staff — NOT customers.

  // PR2 commit 13 — WIRED_PR2. Merchant ops alert fired alongside
  // every `sendOrderConfirmation` (6 callsites in server.ts — stripe
  // webhook, paypal webhook, paypal partner capture ×2, checkout
  // complete, paypal direct capture). Ops category = forced-send, so
  // no unsubscribe footer. Audience='merchant' means send.ts pipes the
  // email to `shops.email` (the shop owner address). Template is
  // Shopify-parity compact: headline + 4-field summary + "View order"
  // CTA. No line-item table — this is a notification, not a receipt.
  new_order_received: {
    key: 'new_order_received',
    category: 'ops',
    audience: 'merchant',
    priority: 1,
    subject: 'New order: #{{order_number}}',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111; font-size: 22px; margin: 0 0 8px 0; }
  .lead { color: #4b5563; margin: 0 0 24px 0; font-size: 14px; }
  table.summary { width: 100%; border-collapse: collapse; margin: 16px 0 24px 0; }
  table.summary th { text-align: left; color: #6b7280; font-weight: 500; font-size: 13px; padding: 8px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; width: 140px; }
  table.summary td { text-align: left; color: #111; font-weight: 600; padding: 8px 12px; border-bottom: 1px solid #e5e7eb; }
  .btn-wrap { margin: 24px 0; text-align: center; }
  .btn { display: inline-block; background: #111; color: #fff !important; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; }
  .footer { margin-top: 32px; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>New order received</h1>
    <p class="lead">Order #{{order_number}} just came in for {{shop_name}}.</p>
    <table class="summary">
      <tr><th>Order</th><td>#{{order_number}}</td></tr>
      <tr><th>Customer</th><td>{{customer_name}}</td></tr>
      <tr><th>Total</th><td>{{currency}} {{order_total}}</td></tr>
    </table>
    <div class="btn-wrap"><a href="{{order_url}}" class="btn">View order</a></div>
    <p class="footer">This is an operational alert from your Gbox store — it is sent on every new order and cannot be unsubscribed.</p>
  </div>
</body>
</html>`,
    bodyText: `New order received

Order #{{order_number}} just came in for {{shop_name}}.

Customer: {{customer_name}}
Total:    {{currency}} {{order_total}}

View order: {{order_url}}

— Gbox operational alert (ops category, cannot be unsubscribed).`,
    variables: ['order_number', 'order_total', 'currency', 'customer_name', 'order_url', 'shop_name'],
    description: 'Merchant gets a heads-up on every new order. WIRED_PR2.',
    implemented: true,
  },
  high_value_order: scaffold(
    'high_value_order', 'ops', 'merchant', 2,
    'High-value order #{{order_number}} — {{order_total}}',
    'Order over the high-value threshold (default: $500).',
    ['order_number', 'order_total', 'order_url'],
  ),
  // WIRED_PR6 — flow-catalog condition on `order.paid` with
  // `totalOrdersForCustomer === 1 AND customerId != null`.
  first_time_customer_order: scaffold(
    'first_time_customer_order', 'ops', 'merchant', 3,
    'First order from {{customer_name}}',
    'Merchant touch-point for first-time-customer VIP.',
    ['customer_name', 'order_number', 'order_url'],
    true,
  ),
  payment_failed_customer: scaffold(
    'payment_failed_customer', 'transactional', 'customer', 2,
    'Payment issue on order #{{order_number}}',
    'Customer-facing payment-failed notice with retry link.',
    ['order_number', 'retry_url'],
  ),
  // WIRED_PR6 — fan-out from existing `payment.failed` event emitted in
  // createTransaction when transaction.status='failed'.
  payment_failed_merchant: scaffold(
    'payment_failed_merchant', 'ops', 'merchant', 2,
    'Payment failed on order #{{order_number}}',
    'Merchant-facing payment-failed alert.',
    ['order_number', 'order_url'],
    true,
  ),
  // WIRED_PR6 — fan-out from `refund.issued` event emitted in
  // createRefund post-commit (dollars → cents conversion).
  refund_issued_merchant: scaffold(
    'refund_issued_merchant', 'ops', 'merchant', 2,
    'Refund issued for order #{{order_number}}',
    'Merchant log of refund issued.',
    ['order_number', 'refund_amount', 'order_url'],
    true,
  ),
  low_stock_alert: scaffold(
    'low_stock_alert', 'ops', 'merchant', 2,
    'Low stock: {{product_title}}',
    'Inventory dropped below seller-configured threshold.',
    ['product_title', 'variant_title', 'available', 'product_url'],
  ),
  // WIRED_PR6 — fan-out from `inventory.out_of_stock` event emitted
  // in products/service.ts::updateInventory on the `previousAvailable
  // > 0 && newAvailable <= 0` transition.
  out_of_stock_alert: scaffold(
    'out_of_stock_alert', 'ops', 'merchant', 2,
    'Out of stock: {{product_title}}',
    'Inventory hit zero on a tracked item.',
    ['product_title', 'variant_title', 'product_url'],
    true,
  ),
  // WIRED_PR6_DEFERRED — all 6 payout/chargeback templates stay
  // scaffold-only until Phase 12 ships the Stripe Connect payout
  // pipeline + chargeback webhook. No cron, no service emit, no
  // event-bus wiring today: the substrate simply doesn't exist yet.
  // When Phase 12 lands, flip `implemented: true` and wire emits
  // from the payout scheduler / Stripe dispute webhook handler.
  // Tracked in docs/email-system/phase-14-deferred.md.
  payout_scheduled: scaffold(
    'payout_scheduled', 'ops', 'merchant', 3,
    'Payout of {{amount}} scheduled',
    'Upcoming payout notification.',
    ['amount', 'currency', 'expected_date'],
  ),
  payout_completed: scaffold(
    'payout_completed', 'ops', 'merchant', 3,
    'Payout of {{amount}} sent',
    'Payout successfully transferred.',
    ['amount', 'currency', 'bank_last4'],
  ),
  payout_failed: scaffold(
    'payout_failed', 'ops', 'merchant', 2,
    'Payout of {{amount}} failed',
    'Payout retry needed (bank rejected / hold).',
    ['amount', 'failure_reason'],
  ),
  chargeback_opened: scaffold(
    'chargeback_opened', 'ops', 'merchant', 2,
    'Chargeback on order #{{order_number}}',
    'Buyer disputed a charge; merchant action required.',
    ['order_number', 'amount', 'reason'],
  ),
  chargeback_won: scaffold(
    'chargeback_won', 'ops', 'merchant', 3,
    'Chargeback won on order #{{order_number}}',
    'Dispute resolved in merchant\'s favour.',
    ['order_number'],
  ),
  chargeback_lost: scaffold(
    'chargeback_lost', 'ops', 'merchant', 2,
    'Chargeback lost on order #{{order_number}}',
    'Dispute resolved against merchant; funds already reclaimed.',
    ['order_number', 'amount'],
  ),
  // WIRED_PR6 — fan-out from `order.high_risk` event emitted in
  // createTransaction after `order.paid` when `fraud_score >= 75` (or
  // risk_level='high' fallback when engine hasn't scored).
  high_risk_order: scaffold(
    'high_risk_order', 'ops', 'merchant', 2,
    'High-risk order #{{order_number}} — review before fulfilling',
    'Fraud-signal triggered; review + release decision.',
    ['order_number', 'risk_score', 'order_url'],
    true,
  ),
  staff_invited: scaffold(
    'staff_invited', 'ops', 'merchant', 2,
    'You\'ve been invited to {{shop_name}}',
    'Staff-member invitation email (accept-link included).',
    ['inviter_name', 'shop_name', 'accept_url'],
  ),
  staff_new_device_login: scaffold(
    'staff_new_device_login', 'ops', 'merchant', 2,
    'New device signed in to your Gbox account',
    'Security alert: new device or IP detected for a staff login.',
    ['device_info', 'location', 'timestamp', 'revoke_url'],
  ),
  // WIRED_PR6 — direct sendTemplatedEmail from the merchant-daily
  // cron (scripts/ops/run-merchant-daily-digest.ts). Skips zero-order
  // shops; idempotency key is daily_sales_digest:<shopId>:<date>.
  daily_sales_digest: scaffold(
    'daily_sales_digest', 'ops', 'merchant', 3,
    'Your daily {{shop_name}} recap',
    'Yesterday\'s sales + top items + top regions.',
    ['total_sales', 'order_count', 'top_products_html'],
    true,
  ),

  // ─── PLATFORM (9) ───────────────────────────────────────────────────
  // IRON RULE 5 — audience=god_admin. These are NEVER surfaced in any
  // seller-facing admin UI. Recipients are internal @gbox.co mailboxes.

  // WIRED_PR6 — direct emitter in apps/accounts/src/pages/create-store.ts
  // after the welcome email emit.
  new_merchant_signup: scaffold(
    'new_merchant_signup', 'platform', 'god_admin', 2,
    '[Platform] New merchant: {{shop_name}}',
    'New shop created on accounts.gbox.co. Lead into sales / success handoff.',
    ['shop_name', 'owner_email', 'country', 'shop_url'],
    true,
  ),
  // WIRED_PR6 — fired from logging/logger.ts::installProcessErrorHandlers
  // on uncaughtException (severity=critical) + unhandledRejection
  // (severity=high). Dedup key = hash(err.message + env) + 60s cooldown.
  platform_incident_alert: scaffold(
    'platform_incident_alert', 'platform', 'god_admin', 1,
    '[Platform] Incident: {{severity}} — {{title}}',
    'Internal incident alert (5xx spike, queue backup, payment gateway down).',
    ['severity', 'title', 'runbook_url'],
    true,
  ),
  // WIRED_PR6 — cron scripts/ops/run-platform-daily-digest.ts at
  // 06:00 UTC. Dedup date:YYYY-MM-DD → hard 1/day.
  platform_daily_digest: scaffold(
    'platform_daily_digest', 'platform', 'god_admin', 3,
    '[Platform] Daily KPIs — {{date}}',
    'Daily GMV / signup / churn digest for internal team.',
    ['date', 'gmv_total', 'new_shops', 'churned_shops'],
    true,
  ),
  // WIRED_PR6 — god-admin/src/pages/stores.ts::{postSuspendStore,
  // postDeleteStore} fire on status transition. Dedup shop:<uuid>:<yyyymm>
  // → 1/shop/month.
  platform_churn_alert: scaffold(
    'platform_churn_alert', 'platform', 'god_admin', 3,
    '[Platform] Shop closed: {{shop_name}}',
    'A merchant closed / suspended / churned. Trigger winback ticket.',
    ['shop_name', 'closure_reason'],
    true,
  ),
  // WIRED_PR6 — cron scripts/ops/run-platform-fraud-review.ts at
  // 03:00 UTC. 3 heuristics merged per-shop into 1 email.
  platform_fraud_review: scaffold(
    'platform_fraud_review', 'platform', 'god_admin', 2,
    '[Platform] Fraud review required — {{shop_name}}',
    'Internal alert when a shop trips platform-level fraud heuristics.',
    ['shop_name', 'heuristic', 'evidence_url'],
    true,
  ),
  // WIRED_PR6 — emitter live; direct helper called from god-admin
  // action handler (Commit 7 adds the UI button on the platform-alerts
  // page for ad-hoc test-send).
  platform_policy_violation: scaffold(
    'platform_policy_violation', 'platform', 'god_admin', 2,
    '[Platform] Policy review — {{shop_name}}',
    'Shop reported / flagged for T&C violation.',
    ['shop_name', 'reason'],
    true,
  ),
  // WIRED_PR6_DEFERRED — scaffold only. Phase 12 ships Gbox-owned
  // subscription billing; when that lands, wire this via the charge-
  // failed webhook handler using emitPlatformBillingFailure().
  platform_billing_failure: scaffold(
    'platform_billing_failure', 'platform', 'god_admin', 2,
    '[Platform] Billing failure — {{shop_name}}',
    'Gbox-owned subscription renewal charge failed.',
    ['shop_name', 'amount', 'failure_reason'],
  ),
  // WIRED_PR6 — integration wrappers call health.ts::onIntegrationCallError
  // on failure; only emits when errorRate > 10% over >= 10 calls in
  // the last 5m. Dedup key = <integration>:YYYYMMDDHHMM (5m slot).
  platform_integration_down: scaffold(
    'platform_integration_down', 'platform', 'god_admin', 1,
    '[Platform] Integration down: {{integration_name}}',
    'A third-party integration (carrier, payment) reported unhealthy for >5m.',
    ['integration_name', 'error_rate', 'status_page'],
    true,
  ),
  // WIRED_PR6 — cron scripts/ops/run-platform-weekly-roundup.ts
  // Monday 07:00 UTC. Dedup week:YYYY-WW (ISO Thursday rule).
  platform_weekly_roundup: scaffold(
    'platform_weekly_roundup', 'platform', 'god_admin', 4,
    '[Platform] Weekly roundup — week of {{week_start}}',
    'Weekly internal digest across the platform.',
    ['week_start', 'gmv_total', 'top_shops_html'],
    true,
  ),

  // ─── LEGAL (8) ──────────────────────────────────────────────────────
  // Forced-send: user preference cannot unsubscribe from these.

  // WIRED_PR5 — triggered from `markExportReady()` in privacy-requests.ts
  //             after the data-export packager uploads the ZIP to S3
  //             (idempotency key: gdpr_data_export_ready:{request_id}).
  gdpr_data_export_ready: {
    key: 'gdpr_data_export_ready',
    category: 'legal',
    audience: 'customer',
    priority: 2,
    subject: 'Your data export is ready',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111827; font-size: 24px; margin: 0 0 16px; }
  .body { color: #374151; line-height: 1.6; margin: 0 0 24px; }
  .btn { display: inline-block; padding: 12px 32px; background: #111827; color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 8px 0; }
  .btn-wrap { text-align: center; margin: 24px 0; }
  .notice { background: #fef3c7; border-left: 3px solid #f59e0b; padding: 12px 16px; border-radius: 4px; margin: 20px 0; color: #78350f; font-size: 14px; }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Your data export is ready</h1>
    <div class="body">
      <p>Hi {{customer_name}},</p>
      <p>Your personal data export from {{shop_name}} is ready to download. The archive includes your account details, order history, email preferences, consent events and any other personal data we hold about you.</p>
    </div>
    <div class="btn-wrap"><a href="{{download_url}}" class="btn">Download your data</a></div>
    <div class="notice">
      This link is single-use and expires on <strong>{{expires_at}}</strong>. After that you will need to request a new export.
    </div>
    <p style="color:#6b7280;font-size:13px;">If you did not request this export, please contact us immediately.</p>
    <div class="footer"><p>{{shop_name}}</p></div>
  </div>
</body>
</html>`,
    bodyText: `Your data export is ready

Hi {{customer_name}},

Your personal data export from {{shop_name}} is ready to download.
The archive includes your account details, order history, email
preferences, consent events and any other personal data we hold
about you.

Download: {{download_url}}

This link is single-use and expires on {{expires_at}}.
After that you will need to request a new export.

If you did not request this export, please contact us immediately.

---
{{shop_name}}`,
    variables: ['customer_name', 'shop_name', 'download_url', 'expires_at'],
    description: 'GDPR Art. 15 / 20 data portability export ready for download. Contains one-time signed S3 URL.',
    implemented: true,
  },
  // WIRED_PR5 — triggered by `run-privacy-deletions` cron after the 30-day
  //             grace window elapses and PII is nulled across customer tables
  //             (idempotency key: gdpr_data_deletion_confirmed:{request_id}).
  gdpr_data_deletion_confirmed: {
    key: 'gdpr_data_deletion_confirmed',
    category: 'legal',
    audience: 'customer',
    priority: 2,
    subject: 'Your data deletion request has been completed',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111827; font-size: 24px; margin: 0 0 16px; }
  .body { color: #374151; line-height: 1.6; margin: 0 0 24px; }
  .retained { background: #f3f4f6; border-radius: 6px; padding: 16px; margin: 20px 0; color: #374151; font-size: 14px; }
  .retained strong { color: #111827; }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Your data deletion has been completed</h1>
    <div class="body">
      <p>Hi {{customer_name}},</p>
      <p>As requested, we have erased your personal data from {{shop_name}} on <strong>{{deletion_date}}</strong>. This fulfils your right to erasure under GDPR Art. 17.</p>
    </div>
    <div class="retained">
      <p><strong>What we had to keep:</strong> for legal and tax reasons, we are required to retain anonymised records of past orders (order numbers, amounts, dates) without your identity attached. These rows can no longer be linked back to you.</p>
    </div>
    <p style="color:#6b7280;font-size:13px;">You can create a new account at any time. That account will not be connected to the data we just erased.</p>
    <div class="footer"><p>{{shop_name}}</p></div>
  </div>
</body>
</html>`,
    bodyText: `Your data deletion has been completed

Hi {{customer_name}},

As requested, we have erased your personal data from {{shop_name}}
on {{deletion_date}}. This fulfils your right to erasure under
GDPR Art. 17.

What we had to keep: for legal and tax reasons, we are required
to retain anonymised records of past orders (order numbers,
amounts, dates) without your identity attached. These rows can
no longer be linked back to you.

You can create a new account at any time. That account will not
be connected to the data we just erased.

---
{{shop_name}}`,
    variables: ['customer_name', 'shop_name', 'deletion_date'],
    description: 'GDPR Art. 17 right-to-erasure fulfillment confirmation. Sent after cron finalizes deletion.',
    implemented: true,
  },
  tos_update: scaffold(
    'tos_update', 'legal', 'customer', 3,
    'Updates to our Terms of Service',
    'ToS amendment notice (30-day pre-effective).',
    ['effective_date', 'summary_html', 'full_tos_url'],
  ),
  // WIRED_PR5 — admin-triggered from /settings/privacy-policy-update (Phase 15)
  //             or ops CLI. PR5 registers the template; the sender bulk job
  //             is not wired automatically — legal teams trigger manually.
  privacy_policy_update: {
    key: 'privacy_policy_update',
    category: 'legal',
    audience: 'customer',
    priority: 3,
    subject: 'Updates to our Privacy Policy',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111827; font-size: 24px; margin: 0 0 16px; }
  .body { color: #374151; line-height: 1.6; margin: 0 0 24px; }
  .effective { background: #eef2ff; border-radius: 6px; padding: 12px 16px; margin: 20px 0; color: #3730a3; font-size: 14px; }
  .summary { background: #fafafa; border-radius: 6px; padding: 16px; margin: 20px 0; color: #374151; font-size: 14px; line-height: 1.6; }
  .btn { display: inline-block; padding: 12px 32px; background: #111827; color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 8px 0; }
  .btn-wrap { text-align: center; margin: 24px 0; }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>We've updated our Privacy Policy</h1>
    <div class="body">
      <p>Hi {{customer_name}},</p>
      <p>We have made changes to the Privacy Policy that governs how {{shop_name}} handles your personal data.</p>
    </div>
    <div class="effective">Effective date: <strong>{{effective_date}}</strong></div>
    <div class="summary">{{summary_html}}</div>
    <div class="btn-wrap"><a href="{{full_policy_url}}" class="btn">Read the full policy</a></div>
    <p style="color:#6b7280;font-size:13px;">If you do not agree with the changes, you can close your account at any time from your account settings.</p>
    <div class="footer"><p>{{shop_name}}</p></div>
  </div>
</body>
</html>`,
    bodyText: `We've updated our Privacy Policy

Hi {{customer_name}},

We have made changes to the Privacy Policy that governs how
{{shop_name}} handles your personal data.

Effective date: {{effective_date}}

{{summary_html}}

Read the full policy: {{full_policy_url}}

If you do not agree with the changes, you can close your account
at any time from your account settings.

---
{{shop_name}}`,
    variables: ['customer_name', 'shop_name', 'effective_date', 'summary_html', 'full_policy_url'],
    description: 'Privacy policy amendment notice. Triggered by admin bulk-send from /settings/privacy-requests.',
    implemented: true,
  },
  account_closed_confirmation: scaffold(
    'account_closed_confirmation', 'legal', 'customer', 2,
    'Your account has been closed',
    'Customer-initiated account closure confirmation.',
  ),
  // WIRED_PR5 — consent renewal requests. Scope doc calls this
  //             `consent_renewal_request`; registry key kept as
  //             `cookie_consent_update` for back-compat with the 95-template
  //             PR1 seed. The Phase 15 consent-expiry cron will trigger this.
  cookie_consent_update: {
    key: 'cookie_consent_update',
    category: 'legal',
    audience: 'customer',
    priority: 4,
    subject: 'Please update your privacy preferences',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #111827; font-size: 24px; margin: 0 0 16px; }
  .body { color: #374151; line-height: 1.6; margin: 0 0 24px; }
  .btn { display: inline-block; padding: 12px 32px; background: #111827; color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 8px 0; }
  .btn-wrap { text-align: center; margin: 24px 0; }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Please update your privacy preferences</h1>
    <div class="body">
      <p>Hi {{customer_name}},</p>
      <p>Your privacy preferences at {{shop_name}} are due for renewal. Confirming your choices keeps us aligned with GDPR consent-refresh requirements and makes sure we only contact you in the ways you want.</p>
      <p>This will take about a minute.</p>
    </div>
    <div class="btn-wrap"><a href="{{preferences_url}}" class="btn">Update preferences</a></div>
    <p style="color:#6b7280;font-size:13px;">No action needed if you want to keep your current preferences — they remain in effect until you change them.</p>
    <div class="footer"><p>{{shop_name}}</p></div>
  </div>
</body>
</html>`,
    bodyText: `Please update your privacy preferences

Hi {{customer_name}},

Your privacy preferences at {{shop_name}} are due for renewal.
Confirming your choices keeps us aligned with GDPR consent-refresh
requirements and makes sure we only contact you in the ways you
want. This will take about a minute.

Update preferences: {{preferences_url}}

No action needed if you want to keep your current preferences —
they remain in effect until you change them.

---
{{shop_name}}`,
    variables: ['customer_name', 'shop_name', 'preferences_url'],
    description: 'GDPR consent-renewal request. Registered in PR5; Phase 15 cron will trigger it on expiry.',
    implemented: true,
  },
  // WIRED_PR5 — triggered manually by ops / legal team from the incident
  //             response runbook. Never automated. Priority 1 (always send).
  data_breach_notice: {
    key: 'data_breach_notice',
    category: 'legal',
    audience: 'customer',
    priority: 1,
    subject: 'Important: security notice about your account',
    bodyHtml: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
  .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; }
  h1 { color: #991b1b; font-size: 24px; margin: 0 0 16px; }
  .body { color: #374151; line-height: 1.6; margin: 0 0 24px; }
  .section { background: #fafafa; border-radius: 6px; padding: 16px; margin: 16px 0; color: #374151; font-size: 14px; line-height: 1.6; }
  .section strong { color: #111827; display: block; margin-bottom: 8px; }
  .banner { background: #fef2f2; border-left: 3px solid #dc2626; padding: 12px 16px; border-radius: 4px; margin: 20px 0; color: #7f1d1d; font-size: 14px; }
  .footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; color: #9ca3af; font-size: 12px; text-align: center; }
</style></head>
<body>
  <div class="container">
    <h1>Important: security notice about your account</h1>
    <div class="banner">This is a security notification. Please read it in full.</div>
    <div class="body">
      <p>Hi {{customer_name}},</p>
      <p>We are writing to let you know about a security incident that may have affected your personal data held by {{shop_name}}.</p>
    </div>
    <div class="section">
      <strong>Incident date</strong>
      {{incident_date}}
    </div>
    <div class="section">
      <strong>What happened</strong>
      {{what_happened}}
    </div>
    <div class="section">
      <strong>What we have done</strong>
      {{what_we_did}}
    </div>
    <div class="section">
      <strong>What you should do</strong>
      {{what_you_should_do}}
    </div>
    <p style="color:#6b7280;font-size:13px;">This notification is sent in accordance with GDPR Art. 34. If you have any questions, please reply to this email.</p>
    <div class="footer"><p>{{shop_name}}</p></div>
  </div>
</body>
</html>`,
    bodyText: `IMPORTANT: SECURITY NOTICE ABOUT YOUR ACCOUNT

Hi {{customer_name}},

We are writing to let you know about a security incident that may
have affected your personal data held by {{shop_name}}.

INCIDENT DATE
{{incident_date}}

WHAT HAPPENED
{{what_happened}}

WHAT WE HAVE DONE
{{what_we_did}}

WHAT YOU SHOULD DO
{{what_you_should_do}}

This notification is sent in accordance with GDPR Art. 34.
If you have any questions, please reply to this email.

---
{{shop_name}}`,
    variables: ['customer_name', 'shop_name', 'incident_date', 'what_happened', 'what_we_did', 'what_you_should_do'],
    description: 'GDPR Art. 34 data-breach notification to affected data subjects. Operationally triggered.',
    implemented: true,
  },
  regulatory_disclosure: scaffold(
    'regulatory_disclosure', 'legal', 'customer', 3,
    'Required disclosure about your order',
    'Jurisdiction-specific mandatory disclosure (e.g. CA Prop 65).',
    ['disclosure_text'],
  ),

  // ─── SUPPORT NOTIFICATIONS (2) ──────────────────────────────────────
  //
  // Two envelope templates used by the support notification sender
  // (`packages/core/src/modules/support-notifications/sender.ts`).
  // They replace the legacy `sendEmail` call so every support notification
  // lands an audit row in `email_deliveries` — giving ops visibility into
  // support emails alongside all other platform email.
  //
  // WHY two templates?
  //   - `support_notification_seller` — goes to merchant email addresses;
  //     audience='merchant' so getMerchantVisibleTemplates() can surface
  //     them in the seller admin under a "Support" category (if wanted).
  //     shopId = the ticket's shop_id.
  //   - `support_notification_agent` — goes to Gbox support staff
  //     (L1/L2/Lead); audience='god_admin' so Iron Rule 5's
  //     getMerchantVisibleTemplates() filter removes them from any seller
  //     surface. shopId = null (platform-scoped).
  //
  // BOTH use category='ops' → `isForcedSendCategory()` returns true →
  // `sendTemplatedEmail` bypasses email_preferences opt-out. Support
  // staff cannot unsubscribe from SLA breach alerts; sellers cannot
  // unsubscribe from auto-close notices.
  //
  // The body is composed by the sender using SCAFFOLD_VARS so the admin
  // preview still renders something meaningful. Real body content is
  // injected as `{{body_html}}` / `{{body_text}}` / `{{heading}}` /
  // `{{cta_html}}` — built by the sender, not stored in the template.
  //
  // WIRED — sendSupportNotification() in sender.ts uses these.
  support_notification_seller: scaffold(
    'support_notification_seller', 'ops', 'merchant', 2,
    '{{heading}}',
    'Envelope template for seller-facing support notifications (new message, SLA breach, CSAT prompt, auto-close). Body assembled by the support notification sender.',
    [],
    true,
  ),
  support_notification_agent: scaffold(
    'support_notification_agent', 'platform', 'god_admin', 2,
    '{{heading}}',
    'Envelope template for internal Gbox support agent notifications (new seller message, @-mention, ticket assigned). audience=god_admin so sellers never see it. shopId=null (platform-scoped).',
    [],
    true,
  ),
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Fast lookup. Returns undefined for unknown keys. */
export function getTemplate(key: string): TemplateSpec | undefined {
  return EMAIL_TEMPLATE_CATALOG[key]
}

/** All 95 specs as an array (for seeding + admin UI listings). */
export function getAllTemplates(): TemplateSpec[] {
  return Object.values(EMAIL_TEMPLATE_CATALOG)
}

/** Filter to one category (for the admin UI tabs). */
export function getTemplatesByCategory(
  category: EmailTemplateCategory,
): TemplateSpec[] {
  return getAllTemplates().filter((t) => t.category === category)
}

/**
 * Templates the seller admin UI is allowed to show.
 *
 * IRON RULE 5 — platform templates (audience='god_admin') are filtered
 * out here, not in the UI. This is the one chokepoint; the UI should
 * call THIS, not `getAllTemplates()`, so a future refactor can't leak
 * god-admin templates into a seller surface.
 */
export function getMerchantVisibleTemplates(): TemplateSpec[] {
  return getAllTemplates().filter((t) => t.audience !== 'god_admin')
}

/** For the god-admin coverage dashboard. */
export function getImplementedTemplates(): TemplateSpec[] {
  return getAllTemplates().filter((t) => t.implemented)
}

/** For the god-admin coverage dashboard. */
export function getPendingTemplates(): TemplateSpec[] {
  return getAllTemplates().filter((t) => !t.implemented)
}

/** Total count — cheap invariant for tests. */
export function getTemplateCount(): number {
  return Object.keys(EMAIL_TEMPLATE_CATALOG).length
}

/**
 * Whether a category is "receipt-class" — can NEVER be unsubscribed.
 * Called by `preferences.ts::canSend()`.
 */
export function isForcedSendCategory(category: EmailTemplateCategory): boolean {
  return (
    category === 'transactional' ||
    category === 'ops' ||
    category === 'platform' ||
    category === 'legal'
  )
}

// ---------------------------------------------------------------------------
// Resolved template (PR1.5 — shop overrides)
// ---------------------------------------------------------------------------

/**
 * The rendered shape `sendTemplatedEmail()` actually uses: default row
 * merged with any per-shop override. Callers outside the send pipeline
 * (admin preview, campaign drafts) can use this too.
 *
 * Fields track the three override points + the resolved `active` flag.
 * `active=false` on a seller-visible, non-transactional template means
 * the send is blocked at the shop level — `transactional` / `ops` /
 * `legal` / `platform` categories ignore `active=false` (we never
 * stop a password-reset because the seller accidentally clicked a
 * toggle).
 */
export interface ResolvedTemplate {
  key: string
  category: EmailTemplateCategory
  audience: EmailTemplateAudience
  priority: TemplatePriority
  subject: string
  bodyHtml: string
  bodyText: string
  variables: string[]
  description: string
  /**
   * True if this shop (or the catalog default, if shopId is null) has
   * the template enabled. For forced-send categories we ALWAYS return
   * true — the resolver ignores override.active in those cases to
   * guard against seller footgun.
   */
  active: boolean
  /** True if any per-shop override contributed to this result. */
  overridden: boolean
}

/**
 * Narrow Kysely-shaped dependency so this module doesn't import the
 * heavy `@gbox/db` type bundle. The admin UI + send pipeline hand in
 * the real Kysely instance; tests can hand in a stub.
 */
interface TemplateOverrideDb {
  selectFrom: (table: 'email_template_registry' | 'email_template_overrides') => {
    select: (cols: readonly string[]) => {
      where: (
        col: string,
        op: string,
        val: string | boolean | null,
      ) => {
        where: (
          col: string,
          op: string,
          val: string | boolean | null,
        ) => { executeTakeFirst: () => Promise<Record<string, unknown> | undefined> }
        executeTakeFirst: () => Promise<Record<string, unknown> | undefined>
      }
    }
  }
}

/**
 * Resolve a template for a given (shopId, key) pair, merging defaults
 * + per-shop override. Falls back to the in-code catalog when the DB
 * row is missing (pre-seed dev boxes).
 *
 *   shopId=null    → platform-scope send, overrides NOT consulted
 *   shopId='…'     → load override row; NULL fields fall through
 *   unknown key    → return null (caller fails closed)
 *   override.active=false + non-forced → return `active=false`, caller blocks
 *
 * Keeps the database import surface narrow so tests can stub the db
 * parameter. Code path is O(1 query) when shopId is set, O(0 queries)
 * when it's null.
 */
export async function resolveTemplate(
  db: TemplateOverrideDb | null,
  shopId: string | null,
  key: string,
): Promise<ResolvedTemplate | null> {
  const spec = getTemplate(key)
  if (!spec) return null

  // Platform-scope emails never look at shop overrides.
  // A null `db` arg is valid for pure-catalog resolution (tests + preview).
  if (shopId === null || db === null) {
    return {
      key: spec.key,
      category: spec.category,
      audience: spec.audience,
      priority: spec.priority,
      subject: spec.subject,
      bodyHtml: spec.bodyHtml,
      bodyText: spec.bodyText,
      variables: spec.variables,
      description: spec.description,
      active: true,
      overridden: false,
    }
  }

  // Load the DB default row (to honour god-admin subject/body overrides
  // written via the platform admin tools) AND the per-shop override
  // row. Both may be missing.
  const dbDefault = (await db
    .selectFrom('email_template_registry')
    .select([
      'subject_default',
      'body_html_default',
      'body_text_default',
      'active',
    ] as const)
    .where('template_key', '=', key)
    .executeTakeFirst()) as
    | {
        subject_default?: string
        body_html_default?: string
        body_text_default?: string
        active?: boolean
      }
    | undefined

  const override = (await db
    .selectFrom('email_template_overrides')
    .select([
      'subject_custom',
      'body_html_custom',
      'body_text_custom',
      'active',
    ] as const)
    .where('shop_id', '=', shopId)
    .where('template_key', '=', key)
    .executeTakeFirst()) as
    | {
        subject_custom?: string | null
        body_html_custom?: string | null
        body_text_custom?: string | null
        active?: boolean
      }
    | undefined

  // Active resolution:
  //   forced-send category → always active (ignore both rows' active=false)
  //   else → override.active wins if present; fallback to dbDefault.active;
  //          final fallback is true.
  let active: boolean
  if (isForcedSendCategory(spec.category)) {
    active = true
  } else if (override && override.active === false) {
    active = false
  } else if (dbDefault && dbDefault.active === false) {
    active = false
  } else {
    active = true
  }

  // Three-layer merge for content: override > db default > in-code catalog.
  const subject =
    override?.subject_custom ??
    dbDefault?.subject_default ??
    spec.subject
  const bodyHtml =
    override?.body_html_custom ??
    dbDefault?.body_html_default ??
    spec.bodyHtml
  const bodyText =
    override?.body_text_custom ??
    dbDefault?.body_text_default ??
    spec.bodyText

  const overridden =
    !!override &&
    (override.subject_custom != null ||
      override.body_html_custom != null ||
      override.body_text_custom != null ||
      override.active === false)

  return {
    key: spec.key,
    category: spec.category,
    audience: spec.audience,
    priority: spec.priority,
    subject,
    bodyHtml,
    bodyText,
    variables: spec.variables,
    description: spec.description,
    active,
    overridden,
  }
}

// ---------------------------------------------------------------------------
// Override CRUD
// ---------------------------------------------------------------------------
//
// Thin wrappers around the `email_template_overrides` table used by
// store-admin + god-admin UI. We intentionally don't expose a "bulk"
// update; each template is its own decision and the UI is row-level.

/** Narrow Kysely type for override CRUD (separate from resolver's). */
interface OverrideCrudDb {
  insertInto: (table: 'email_template_overrides') => {
    values: (v: Record<string, unknown>) => {
      onConflict: (cb: (oc: {
        columns: (cols: readonly string[]) => {
          doUpdateSet: (v: Record<string, unknown>) => unknown
        }
      }) => unknown) => { execute: () => Promise<unknown> }
    }
  }
  deleteFrom: (table: 'email_template_overrides') => {
    where: (col: string, op: string, val: string) => {
      where: (col: string, op: string, val: string) => { execute: () => Promise<unknown> }
    }
  }
  selectFrom: (table: 'email_template_overrides') => {
    select: (cols: readonly string[]) => {
      where: (
        col: string,
        op: string,
        val: string | boolean,
      ) => { execute: () => Promise<Record<string, unknown>[]> }
    }
  }
}

export interface UpsertOverrideInput {
  shopId: string
  templateKey: string
  subjectCustom?: string | null
  bodyHtmlCustom?: string | null
  bodyTextCustom?: string | null
  active?: boolean
}

/**
 * INSERT-or-UPDATE a shop's override for one template. Called by the
 * store-admin editor on save. All override fields are nullable; passing
 * `subjectCustom=null` explicitly clears the field (fall-through to
 * default). Passing `undefined` leaves it unchanged.
 *
 * Iron Rule 5: this function does NOT check whether the template's
 * audience is seller-visible. The calling route MUST have already
 * filtered through `getMerchantVisibleTemplates()` — this avoids an
 * import cycle and keeps the CRUD dumb.
 */
export async function upsertTemplateOverride(
  db: OverrideCrudDb,
  input: UpsertOverrideInput,
): Promise<void> {
  const values: Record<string, unknown> = {
    shop_id: input.shopId,
    template_key: input.templateKey,
  }
  // Only include keys the caller explicitly set, so `undefined` leaves
  // fields unchanged on UPDATE path.
  if (input.subjectCustom !== undefined) values.subject_custom = input.subjectCustom
  if (input.bodyHtmlCustom !== undefined) values.body_html_custom = input.bodyHtmlCustom
  if (input.bodyTextCustom !== undefined) values.body_text_custom = input.bodyTextCustom
  if (input.active !== undefined) values.active = input.active

  // The UPDATE set mirrors the INSERT values (minus the PK columns).
  const updateSet: Record<string, unknown> = {}
  if (input.subjectCustom !== undefined) updateSet.subject_custom = input.subjectCustom
  if (input.bodyHtmlCustom !== undefined) updateSet.body_html_custom = input.bodyHtmlCustom
  if (input.bodyTextCustom !== undefined) updateSet.body_text_custom = input.bodyTextCustom
  if (input.active !== undefined) updateSet.active = input.active

  await db
    .insertInto('email_template_overrides')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['shop_id', 'template_key']).doUpdateSet(updateSet),
    )
    .execute()
}

/**
 * Delete a shop's override for one template. Equivalent to "reset to
 * default" in the UI — the template falls back to the
 * `email_template_registry.*_default` values on next resolve.
 */
export async function clearTemplateOverride(
  db: OverrideCrudDb,
  shopId: string,
  templateKey: string,
): Promise<void> {
  await db
    .deleteFrom('email_template_overrides')
    .where('shop_id', '=', shopId)
    .where('template_key', '=', templateKey)
    .execute()
}

export interface ShopOverrideRow {
  template_key: string
  subject_custom: string | null
  body_html_custom: string | null
  body_text_custom: string | null
  active: boolean
}

/**
 * List every override for a shop. Used by the store-admin template list
 * to show a "Customized" badge on templates the seller has touched.
 */
export async function listShopOverrides(
  db: OverrideCrudDb,
  shopId: string,
): Promise<ShopOverrideRow[]> {
  const rows = await db
    .selectFrom('email_template_overrides')
    .select([
      'template_key',
      'subject_custom',
      'body_html_custom',
      'body_text_custom',
      'active',
    ] as const)
    .where('shop_id', '=', shopId)
    .execute()
  return rows as unknown as ShopOverrideRow[]
}
