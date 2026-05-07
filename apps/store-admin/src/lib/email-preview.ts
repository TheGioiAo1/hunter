/**
 * Gbox Platform — Email Templates preview helpers (Phase 14 PR2).
 *
 * Pure-function module so the PR2 smoke test can import it without
 * dragging in the admin server graph. Same dep-free pattern as
 * `email-templates-flash.ts` / `review-settings-flash.ts`.
 *
 * Responsibilities
 * ----------------
 *   1. `buildSamplePreviewVariables(spec)` — returns a plausible
 *      Record<string, unknown> filling every `spec.variables[]` entry so
 *      `{{customer_name}}` renders as "Pat Tester", `{{order_number}}`
 *      as "1001", etc. Falls back to `[sample: foo]` for unknown keys so
 *      the template still renders something human.
 *
 *   2. `interpolate(template, data)` — same `{{name}}` + `{{a.b.c}}`
 *      substitution semantics as `send.ts::interpolate` (re-implemented
 *      here to keep preview dep-free). Unknown keys render as empty
 *      string (Shopify convention).
 *
 *   3. `renderPreviewDocument({ resolved, variables })` — takes a
 *      resolved template + variables and returns a full HTML document
 *      safe to embed in an iframe: the `bodyHtml` is wrapped with a
 *      `<meta charset>` + minimal reset + a small "PREVIEW" ribbon so
 *      sellers never confuse the iframe with a real email. The subject
 *      is placed in the `<title>` so screen-readers announce context.
 *
 * Iron Rule 5: the admin page layer already filters out god_admin
 * templates before it ever hits this helper. If a hostile request
 * somehow reaches here with a god_admin spec we still render, because
 * preview is READ-ONLY — but the wrapping handler is the gate.
 */

import type { ResolvedTemplate, TemplateSpec } from '@gbox/core/modules/email/registry.js'

// ---------------------------------------------------------------------------
// Sample variables
// ---------------------------------------------------------------------------

/**
 * Named sample values for the most common template placeholders. Keys
 * are the raw `{{var}}` name. When a template declares a variable we
 * don't have a named sample for, we synthesise `[sample: <key>]` so the
 * placeholder is still visible (rather than rendering empty-string
 * which is what send.ts::interpolate does at real send time).
 *
 * Values are INTENTIONALLY obviously-fake ("Pat Tester" / "1001" /
 * "demo.gbox.co") so a seller previewing can't confuse the preview
 * with a real customer email they forgot to purge.
 */
const NAMED_SAMPLES: Readonly<Record<string, unknown>> = {
  // Customer identity
  customer_name: 'Pat Tester',
  customer_first_name: 'Pat',
  customer_last_name: 'Tester',
  customer_email: 'pat@example.test',

  // Shop identity
  shop_name: 'Demo Shop',
  shop_url: 'https://demo.gbox.co',
  shop_email: 'hello@demo.gbox.co',
  shop_phone: '+1 555 0100',
  shop_address: '123 Demo Street, Testville',

  // Orders
  order_number: '1001',
  order_id: '1001',
  order_url: 'https://demo.gbox.co/orders/1001',
  order_total: '$49.95',
  total_price: '$49.95',
  subtotal: '$45.00',
  shipping_cost: '$4.95',
  tax_total: '$0.00',
  currency: 'USD',

  // Line items (pre-rendered blocks since templates use {{line_items_html}})
  line_items_html:
    '<div style="padding:8px 0;border-bottom:1px solid #eee">' +
    '<strong>Sample product</strong> × 1 — $45.00</div>',
  line_items_text: '• Sample product × 1 — $45.00',

  // Shipping
  tracking_number: '1Z999AA10123456784',
  tracking_url: 'https://tracking.example.test/1Z999AA10123456784',
  tracking_carrier: 'UPS',
  carrier: 'UPS',
  estimated_delivery: 'Apr 28, 2026',

  // Refunds / cancels
  refund_amount: '$25.00',
  cancel_reason_html:
    '<div style="padding:10px 14px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px">' +
    '<strong>Reason:</strong> Sample reason for preview.</div>',
  cancel_reason_text: 'Reason: Sample reason for preview.',

  // Auth / OTP
  otp_code: '123456',
  two_fa_code: '123456',
  reset_url: 'https://demo.gbox.co/account/reset?token=sample',
  verify_url: 'https://demo.gbox.co/account/verify?token=sample',
  expires_in: '15 minutes',

  // Gift cards
  gift_card_code: 'GIFT-SAMPLE-1234',
  gift_card_balance: '$50.00',
  gift_card_expiry: 'Apr 28, 2027',
  sender_name: 'Alex Sender',
  personal_message: 'Happy birthday! Enjoy something on me.',

  // Drafts / invoices
  invoice_url: 'https://demo.gbox.co/invoices/sample',
  due_date: 'Apr 30, 2026',

  // Reviews
  review_body: 'Really happy with the product — would buy again!',
  review_rating: '5',
  review_product_name: 'Sample product',
  reply_body: 'Thanks so much for the kind words — it means a lot!',

  // Abandoned cart
  cart_url: 'https://demo.gbox.co/cart/sample',
  recovery_url: 'https://demo.gbox.co/cart/recover/sample',

  // Scaffold defaults — these are also filled by send.ts at send time.
  heading: 'Sample heading',
  body_html: '<p>This is sample body HTML for the preview.</p>',
  body_text: 'This is sample body text for the preview.',
  cta_label: 'View details',
  cta_url: 'https://demo.gbox.co',
  cta_html:
    '<a href="https://demo.gbox.co" style="display:inline-block;padding:12px 24px;background:#111827;color:#fff;text-decoration:none;border-radius:6px">View details</a>',
  cta_text: 'View details: https://demo.gbox.co',

  // Footer (preview mode — no real unsubscribe so we point to the landing
  // page but make it clear this is sample copy).
  unsubscribe_html:
    '<a href="https://demo.gbox.co/accounts/unsubscribe?token=sample">Unsubscribe</a>',
  unsubscribe_text: 'Unsubscribe: https://demo.gbox.co/accounts/unsubscribe?token=sample',
  unsubscribe_url: 'https://demo.gbox.co/accounts/unsubscribe?token=sample',
  preferences_url: 'https://demo.gbox.co/accounts/preferences?token=sample',
}

/**
 * Returns a copy of `NAMED_SAMPLES` with `[sample: <key>]` added for
 * every `spec.variables[]` entry we don't have a named value for.
 * Keeps previews pixel-stable across templates that share common
 * placeholders while still covering one-off variables.
 */
export function buildSamplePreviewVariables(
  spec: Pick<TemplateSpec, 'variables'> | { variables: readonly string[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...NAMED_SAMPLES }
  for (const name of spec.variables ?? []) {
    if (!(name in out)) {
      out[name] = `[sample: ${name}]`
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Interpolation (same shape as send.ts::interpolate, kept here dep-free)
// ---------------------------------------------------------------------------

/**
 * `{{name}}` substitution with dot-path support. Unknown keys render as
 * empty string — matches both Shopify's and `send.ts::interpolate`.
 */
export function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_m, path: string) => {
    const keys = path.split('.')
    let value: unknown = data
    for (const k of keys) {
      if (value == null || typeof value !== 'object') return ''
      value = (value as Record<string, unknown>)[k]
    }
    return value == null ? '' : String(value)
  })
}

// ---------------------------------------------------------------------------
// Full-document rendering for iframe embed
// ---------------------------------------------------------------------------

export interface RenderPreviewInput {
  readonly resolved: Pick<ResolvedTemplate, 'subject' | 'bodyHtml' | 'key'>
  readonly variables: Record<string, unknown>
}

/**
 * Wrap the resolved template's interpolated `bodyHtml` in a minimal
 * HTML document suitable for iframe embed. We DO NOT re-style the body
 * — the template itself owns its CSS, same as a real email client. We
 * only inject:
 *
 *   - `<meta charset>` so interpolated variables render correctly
 *   - `<title>` = rendered subject (screen-reader context)
 *   - a small "PREVIEW" ribbon pinned to top-right so sellers visually
 *     distinguish the iframe from a real email
 *
 * The output is a complete `<!DOCTYPE html>` document ready to pipe
 * straight into `res.send()` with `Content-Type: text/html`.
 */
export function renderPreviewDocument(input: RenderPreviewInput): string {
  const { resolved, variables } = input
  const subject = interpolate(resolved.subject, variables)
  const body = interpolate(resolved.bodyHtml, variables)

  // Template body may already be a full document (many scaffolded
  // templates are) — wrap defensively. We don't reparse; we just prepend
  // the ribbon + meta so both cases work.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  .gbox-preview-ribbon {
    position: fixed;
    top: 8px;
    right: 8px;
    z-index: 9999;
    padding: 4px 10px;
    background: rgba(99,102,241,.92);
    color: #fff;
    font: 600 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    border-radius: 999px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    pointer-events: none;
  }
</style>
</head>
<body>
<div class="gbox-preview-ribbon" aria-hidden="true">Preview · ${escapeHtml(resolved.key)}</div>
${body}
</body>
</html>`
}

// Local escape (not worth pulling esc from seller-layout — dep-free).
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
