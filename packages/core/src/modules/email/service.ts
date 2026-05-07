/**
 * Gbox Platform — Email Service
 *
 * Transactional email: order confirmations, shipping notifications,
 * password resets, and welcome emails. Uses nodemailer with SMTP
 * config from environment variables.
 */

import { createHash } from 'crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  auth: {
    user: string
    pass: string
  }
  from: string
}

export interface EmailOptions {
  to: string
  subject: string
  html: string
  from?: string
  replyTo?: string
  cc?: string
  bcc?: string
}

export interface OrderData {
  id: string
  order_number: number
  email: string
  currency: string
  subtotal_price: string
  total_shipping: string
  total_tax: string
  total_discounts: string
  total_price: string
  line_items: Array<{
    title: string
    variant_title: string | null
    quantity: number
    price: string
  }>
  shipping_address: Record<string, unknown> | null
  billing_address: Record<string, unknown> | null
  created_at: string
}

export interface FulfillmentData {
  id: string
  tracking_company: string | null
  tracking_number: string | null
  tracking_url: string | null
  shipped_at: string | null
  line_items: Array<{
    title: string
    variant_title: string | null
    quantity: number
  }>
}

export interface UserData {
  id: string
  email: string
  name: string | null
}

// ---------------------------------------------------------------------------
// Nodemailer transport (lazy init)
// ---------------------------------------------------------------------------

type Transporter = {
  sendMail(options: {
    from: string
    to: string
    subject: string
    html: string
    replyTo?: string
    cc?: string
    bcc?: string
  }): Promise<{ messageId: string }>
}

let transporter: Transporter | null = null

function getSmtpConfig(): SmtpConfig {
  const host = process.env.SMTP_HOST
  const port = parseInt(process.env.SMTP_PORT ?? '587', 10)
  const secure = process.env.SMTP_SECURE === 'true'
  const user = process.env.SMTP_USER ?? ''
  const pass = process.env.SMTP_PASS ?? ''
  const from = process.env.SMTP_FROM ?? 'noreply@gbox.io'

  if (!host) throw new Error('SMTP_HOST is not configured')

  return { host, port, secure, auth: { user, pass }, from }
}

async function getTransporter(): Promise<Transporter> {
  if (transporter) return transporter

  const config = getSmtpConfig()
  // Dynamic import so it compiles even if nodemailer isn't installed yet
  const nodemailer = await import('nodemailer')
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  }) as Transporter

  return transporter
}

// ---------------------------------------------------------------------------
// Low-level send
// ---------------------------------------------------------------------------

/**
 * Send a raw email using the configured SMTP transport.
 */
export async function sendEmail(options: EmailOptions): Promise<string> {
  const transport = await getTransporter()
  const config = getSmtpConfig()

  const result = await transport.sendMail({
    from: options.from ?? config.from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    replyTo: options.replyTo,
    cc: options.cc,
    bcc: options.bcc,
  })

  return result.messageId
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/**
 * Render an email template. First checks the database for a shop-specific
 * template override; falls back to built-in defaults.
 */
export async function renderTemplate(
  db: Kysely<Database>,
  templateName: string,
  shopId: string,
  data: Record<string, unknown>,
): Promise<{ subject: string; html: string }> {
  // Check for a shop-specific template override
  const dbTemplate = await db
    .selectFrom('email_templates')
    .select(['subject', 'body_html'])
    .where('shop_id', '=', shopId)
    .where('name', '=', templateName)
    .where('active', '=', true)
    .executeTakeFirst()

  if (dbTemplate && dbTemplate.body_html) {
    return {
      subject: interpolate(dbTemplate.subject, data),
      html: interpolate(dbTemplate.body_html, data),
    }
  }

  // Fall back to built-in templates
  const builtIn = BUILT_IN_TEMPLATES[templateName]
  if (!builtIn) {
    throw new Error(`Email template "${templateName}" not found`)
  }

  return {
    subject: interpolate(builtIn.subject, data),
    html: interpolate(builtIn.html, data),
  }
}

/**
 * Simple template interpolation: replaces {{key}} with data[key].
 * Supports dot notation for nested access: {{order.id}}.
 */
function interpolate(
  template: string,
  data: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path: string) => {
    const keys = path.split('.')
    let value: unknown = data
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return ''
      value = (value as Record<string, unknown>)[key]
    }
    return value != null ? String(value) : ''
  })
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

const BUILT_IN_TEMPLATES: Record<string, { subject: string; html: string }> = {
  order_confirmation: {
    subject: 'Order #{{order_number}} confirmed',
    html: `<!DOCTYPE html>
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
  },

  shipping_notification: {
    subject: 'Your order #{{order_number}} has shipped',
    html: `<!DOCTYPE html>
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
  },

  password_reset: {
    subject: 'Reset your password',
    html: `<!DOCTYPE html>
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
  },

  welcome: {
    subject: 'Welcome to {{shop_name}}!',
    html: `<!DOCTYPE html>
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
  },

  refund_notification: {
    subject: 'Refund for order #{{order_number}}',
    html: `<!DOCTYPE html>
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
  },

  draft_order_invoice: {
    subject: 'Invoice for order #{{order_number}}',
    html: `<!DOCTYPE html>
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
  },

  gift_card_delivery: {
    subject: 'You\'ve received a gift card from {{sender_name}}',
    html: `<!DOCTYPE html>
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
  },

  review_approved: {
    subject: 'Your review on {{product_title}} is live',
    html: `<!DOCTYPE html>
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
    <div class="footer"><p>Thanks for helping other shoppers &mdash; reply to this email if you have questions.</p></div>
  </div>
</body>
</html>`,
  },

  review_replied: {
    subject: '{{shop_name}} replied to your review',
    html: `<!DOCTYPE html>
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
    <div class="footer"><p>If you have more to add, reply to this email and we'll get it to the seller.</p></div>
  </div>
</body>
</html>`,
  },

  abandoned_cart_recovery: {
    subject: 'You left items in your cart!',
    html: `<!DOCTYPE html>
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
    <div class="footer"><p>If you have questions, reply to this email.</p></div>
  </div>
</body>
</html>`,
  },
}

// ---------------------------------------------------------------------------
// High-level send functions
// ---------------------------------------------------------------------------

/**
 * Send an order confirmation email.
 *
 * PR2 commit 1 — this legacy function now delegates to the PR1 pipeline
 * (`sendTemplatedEmail`) so every order-confirmation send:
 *   - respects per-shop overrides (PR1.5 `email_template_overrides`)
 *   - respects customer frequency-cap + quiet-hours (PR1.5 `canSend`)
 *   - writes a row to `email_deliveries` (full audit trail, visible in
 *     /admin/store/:slug/settings/email-templates and the god-admin
 *     delivery-log UI)
 *   - routes via the unified transport (`resolveTransport()` env picker)
 *
 * Backward compat: signature + `Promise<string>` return unchanged. The
 * string is now either the transport's messageId (if SMTP returned one)
 * or the stringified delivery-log row id on success. Callers in
 * server.ts / draft-orders.ts use `void sendOrderConfirmation(...)` so
 * the exact value is cosmetic.
 */
export async function sendOrderConfirmation(
  db: Kysely<Database>,
  shopId: string,
  order: OrderData,
): Promise<string> {
  // Build line items HTML
  const lineItemsHtml = order.line_items
    .map(
      (li) =>
        `<tr><td>${escapeHtml(li.title)}${li.variant_title ? ` - ${escapeHtml(li.variant_title)}` : ''}</td>` +
        `<td>${li.quantity}</td><td>${order.currency} ${li.price}</td></tr>`,
    )
    .join('')

  const discountRow =
    parseFloat(order.total_discounts) > 0
      ? `<tr><td>Discount</td><td>-${order.currency} ${order.total_discounts}</td></tr>`
      : ''

  const customerName = order.shipping_address
    ? `${(order.shipping_address as any).first_name ?? ''} ${(order.shipping_address as any).last_name ?? ''}`.trim()
    : order.email

  const templateData: Record<string, unknown> = {
    order_number: order.order_number,
    customer_name: customerName || order.email,
    currency: order.currency,
    subtotal_price: order.subtotal_price,
    total_shipping: order.total_shipping,
    total_tax: order.total_tax,
    total_discounts: order.total_discounts,
    total_price: order.total_price,
    line_items_html: lineItemsHtml,
    discount_row: discountRow,
  }

  // Dynamic import avoids a circular dep (service.ts ↔ send.ts via
  // shared delivery-log + preferences imports).
  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'order_confirmation',
    to: order.email,
    shopId,
    variables: templateData,
    idempotencyKey: `order_confirmation:${order.id}`,
  })

  if (result.ok) {
    return result.messageId ?? String(result.deliveryId)
  }
  // Preserve the legacy best-effort contract: don't throw on send failure.
  // Caller code already wraps this in `void sendOrderConfirmation(...)` so
  // a silent '' keeps admin request handlers clean.
  return ''
}

/**
 * Merchant-facing "new order received" operational alert.
 *
 * PR2 commit 13 — wires the previously-scaffolded `new_order_received`
 * ops template. Recipients are shop owners / staff (audience='merchant'),
 * NOT customers. Category is 'ops' → forced-send, no unsubscribe footer,
 * cannot be disabled by the seller. Fires alongside every
 * `sendOrderConfirmation` callsite in server.ts.
 *
 * Recipient address: the shop's `email` column (the address the merchant
 * signed up with). For staff fan-out (multiple recipients per shop) we'd
 * need a staff-preferences table — deferred to a later phase.
 *
 * Idempotency key: `new_order_received:<orderId>`. Multiple payment
 * webhooks (stripe + paypal retries + manual "Mark paid") on the same
 * order will NOT re-fan the merchant alert.
 *
 * Fire-and-forget contract: a silent '' return on send failure or
 * missing merchant email. Caller uses `void sendNewOrderReceived(...)`
 * so request handlers stay clean.
 */
export async function sendNewOrderReceived(
  db: Kysely<Database>,
  shopId: string,
  order: OrderData,
): Promise<string> {
  // Merchant email + shop name come from the shops table.
  const shop = await db
    .selectFrom('shops')
    .select(['email', 'name'])
    .where('id', '=', shopId)
    .executeTakeFirst()

  if (!shop || !shop.email) {
    // No merchant email on file — silently drop. Missing contact email
    // is a setup problem, not a send problem; sellers see it in the
    // shop-settings UI, not in a support ticket.
    return ''
  }

  const customerName = order.shipping_address
    ? `${(order.shipping_address as any).first_name ?? ''} ${(order.shipping_address as any).last_name ?? ''}`.trim()
    : order.email
  const orderUrl = `https://${shop.name ? shop.name.toLowerCase().replace(/\s+/g, '-') : 'store'}.gbox.co/admin/orders/${order.id}`

  const templateData: Record<string, unknown> = {
    order_number: order.order_number,
    order_total: order.total_price,
    currency: order.currency,
    customer_name: customerName || order.email,
    order_url: orderUrl,
    shop_name: shop.name,
  }

  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'new_order_received',
    to: shop.email,
    shopId,
    variables: templateData,
    idempotencyKey: `new_order_received:${order.id}`,
  })

  if (result.ok) {
    return result.messageId ?? String(result.deliveryId)
  }
  return ''
}

/**
 * Customer-facing order cancellation notice.
 *
 * PR2 commit 14 — wires `order_canceled` (transactional, priority 2).
 * Called after `cancelOrder()` in orders/service.ts commits the row
 * with cancelled_at/voided status. Transactional = forced-send, so
 * no unsubscribe footer. If the seller provided a `reason` string,
 * it's injected as a formatted notice block; otherwise the notice
 * block is empty (template renders cleanly either way).
 *
 * Idempotency: `order_canceled:<orderId>`. If the seller double-clicks
 * "Cancel order" (common on slow DB writes), the customer gets exactly
 * one email — not two. The second click hits delivery_log's UNIQUE
 * constraint on (shop_id, idempotency_key) and dedupes.
 *
 * Return contract: silent '' on any send failure — caller uses
 * `void sendOrderCanceled(...)` so request handlers stay clean.
 */
export interface CanceledOrderData {
  id: string
  order_number: number
  email: string
  currency: string
  total_price: string
  cancel_reason: string | null
  line_items: Array<{
    title: string
    variant_title: string | null
    quantity: number
  }>
  shipping_address: Record<string, unknown> | null
}

export async function sendOrderCanceled(
  db: Kysely<Database>,
  shopId: string,
  order: CanceledOrderData,
): Promise<string> {
  const shop = await db
    .selectFrom('shops')
    .select(['name'])
    .where('id', '=', shopId)
    .executeTakeFirst()

  const lineItemsHtml = order.line_items
    .map(
      (li) =>
        `<tr><td>${escapeHtml(li.title)}${li.variant_title ? ` - ${escapeHtml(li.variant_title)}` : ''}</td>` +
        `<td>${li.quantity}</td></tr>`,
    )
    .join('')

  const customerName = order.shipping_address
    ? `${(order.shipping_address as any).first_name ?? ''} ${(order.shipping_address as any).last_name ?? ''}`.trim()
    : order.email

  // Only render the "reason" block when the seller provided one.
  // Empty string → {{cancel_reason_html}} / {{cancel_reason_text}}
  // render as blank (interpolate() falls back to '' for unknown keys,
  // but we pass the key explicitly so overrides can still reference it).
  const cancelReasonHtml = order.cancel_reason
    ? `<div class="notice"><div class="reason-row"><strong>Reason:</strong> ${escapeHtml(order.cancel_reason)}</div></div>`
    : ''
  const cancelReasonText = order.cancel_reason
    ? `Reason: ${order.cancel_reason}\n`
    : ''

  const templateData: Record<string, unknown> = {
    order_number: order.order_number,
    customer_name: customerName || order.email,
    shop_name: shop?.name ?? 'our store',
    cancel_reason_html: cancelReasonHtml,
    cancel_reason_text: cancelReasonText,
    line_items_html: lineItemsHtml,
    currency: order.currency,
    total_price: order.total_price,
  }

  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'order_canceled',
    to: order.email,
    shopId,
    variables: templateData,
    idempotencyKey: `order_canceled:${order.id}`,
  })

  if (result.ok) {
    return result.messageId ?? String(result.deliveryId)
  }
  return ''
}

/**
 * Customer-facing "your order has been delivered" confirmation.
 *
 * PR2 commit 15 — wires `fulfillment_delivered` (transactional,
 * priority 2). Fires from the Lenful tracking-sync worker on the
 * rising-edge transition shipped → delivered (mapStatus picks the
 * state up from carrier webhook text). The caller only has the
 * gbox order_id handy at that point, so this shim does the full
 * order+shop+line_items fetch inside.
 *
 * Idempotency: `fulfillment_delivered:<orderId>`. Carriers sometimes
 * re-fire the "delivered" webhook (USPS does this a lot after
 * business-hours rescans). The delivery_log UNIQUE constraint on
 * (shop_id, idempotency_key) ensures the customer gets exactly one
 * "it arrived" email.
 *
 * Silent '' on missing order / missing email / SMTP down. Caller
 * uses `void sendFulfillmentDelivered(...)` — this runs in the cron
 * worker context and we MUST NOT let a mail failure abort the
 * fulfillment_status mirror write.
 */
export async function sendFulfillmentDelivered(
  db: Kysely<Database>,
  orderId: string,
): Promise<string> {
  const order = await db
    .selectFrom('orders')
    .select([
      'id',
      'shop_id',
      'order_number',
      'email',
      'shipping_address',
    ])
    .where('id', '=', orderId)
    .executeTakeFirst()

  if (!order || !order.email) return ''

  const shop = await db
    .selectFrom('shops')
    .select(['name', 'slug', 'custom_domain'])
    .where('id', '=', order.shop_id)
    .executeTakeFirst()

  const shopName = shop?.name ?? 'our store'
  const shopUrl = shop?.custom_domain
    ? `https://${shop.custom_domain}`
    : `https://${shop?.slug ?? 'store'}.gbox.co`

  const lineItems = await db
    .selectFrom('order_line_items')
    .select(['title', 'variant_title', 'quantity'])
    .where('order_id', '=', orderId)
    .execute()

  const lineItemsHtml = lineItems
    .map(
      (li) =>
        `<tr><td>${escapeHtml(li.title ?? '')}${li.variant_title ? ` - ${escapeHtml(li.variant_title)}` : ''}</td>` +
        `<td>${li.quantity}</td></tr>`,
    )
    .join('')

  const lineItemsText = lineItems
    .map(
      (li) =>
        `- ${li.title ?? ''}${li.variant_title ? ` (${li.variant_title})` : ''} × ${li.quantity}`,
    )
    .join('\n')

  const customerName = order.shipping_address
    ? `${(order.shipping_address as any).first_name ?? ''} ${(order.shipping_address as any).last_name ?? ''}`.trim()
    : order.email

  const templateData: Record<string, unknown> = {
    order_number: order.order_number,
    customer_name: customerName || order.email,
    shop_name: shopName,
    shop_url: shopUrl,
    line_items_html: lineItemsHtml,
    line_items_text: lineItemsText,
  }

  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'fulfillment_delivered',
    to: order.email,
    shopId: order.shop_id,
    variables: templateData,
    idempotencyKey: `fulfillment_delivered:${order.id}`,
  })

  if (result.ok) {
    return result.messageId ?? String(result.deliveryId)
  }
  return ''
}

/**
 * Send a shipping notification email.
 *
 * PR2 commit 2 — same migration shape as sendOrderConfirmation: delegates
 * to the PR1 pipeline. Idempotency key keys on fulfillment.id so a carrier
 * webhook that re-fires the "shipped" state doesn't double-send.
 */
export async function sendShippingNotification(
  db: Kysely<Database>,
  shopId: string,
  order: OrderData,
  fulfillment: FulfillmentData,
): Promise<string> {
  const lineItemsHtml = fulfillment.line_items
    .map(
      (li) =>
        `<tr><td>${escapeHtml(li.title)}${li.variant_title ? ` - ${escapeHtml(li.variant_title)}` : ''}</td>` +
        `<td>${li.quantity}</td></tr>`,
    )
    .join('')

  let trackingHtml = ''
  if (fulfillment.tracking_number) {
    trackingHtml = `<div class="tracking">`
    trackingHtml += `<p><strong>Carrier:</strong> ${escapeHtml(fulfillment.tracking_company ?? 'Standard')}</p>`
    trackingHtml += `<p><strong>Tracking:</strong> `
    if (fulfillment.tracking_url) {
      trackingHtml += `<a href="${escapeHtml(fulfillment.tracking_url)}">${escapeHtml(fulfillment.tracking_number)}</a>`
    } else {
      trackingHtml += escapeHtml(fulfillment.tracking_number)
    }
    trackingHtml += `</p></div>`
  }

  const customerName = order.shipping_address
    ? `${(order.shipping_address as any).first_name ?? ''} ${(order.shipping_address as any).last_name ?? ''}`.trim()
    : order.email

  const templateData: Record<string, unknown> = {
    order_number: order.order_number,
    customer_name: customerName || order.email,
    tracking_html: trackingHtml,
    line_items_html: lineItemsHtml,
  }

  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'shipping_notification',
    to: order.email,
    shopId,
    variables: templateData,
    idempotencyKey: `shipping_notification:${fulfillment.id}`,
  })

  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

/**
 * Send a password reset email.
 *
 * PR2 commit 3 — this function is now a thin wrapper around the unified
 * `sendTemplatedEmail` pipeline. The real forgot-password flow (in
 * `apps/accounts/src/pages/forgot-password.ts`) calls `sendTemplatedEmail`
 * directly; this legacy shim is kept so any pre-PR2 importer still goes
 * through the same pipeline (audit row in `email_deliveries`, respects
 * per-shop overrides, honours customer preferences).
 */
export async function sendPasswordReset(
  db: Kysely<Database>,
  shopId: string,
  user: UserData,
  token: string,
  baseUrl?: string,
): Promise<string> {
  const resetBaseUrl = baseUrl ?? process.env.APP_URL ?? 'https://app.gbox.io'
  const resetUrl = `${resetBaseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`

  const templateData: Record<string, unknown> = {
    user_name: user.name ?? user.email,
    reset_url: resetUrl,
  }

  // Dynamic import keeps this module free of a circular dep (send.ts also
  // imports from delivery-log + preferences which transitively touch service).
  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'password_reset',
    to: user.email,
    shopId,
    variables: templateData,
    // Use the hex token as the idempotency discriminator — two concurrent
    // reset requests for the same user use distinct tokens, so each mints a
    // distinct delivery row, matching the forgot-password.ts caller.
    idempotencyKey: `password_reset:token:${token.slice(0, 16)}`,
  })
  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

/**
 * Send a welcome email to a new user.
 *
 * PR2 commit 4 — now delegates to the unified `sendTemplatedEmail`
 * pipeline. The real first-touch trigger lives in
 * `apps/accounts/src/pages/create-store.ts` (right after the seller
 * creates their first shop); this shim is kept so any pre-PR2
 * importer still flows through the same pipeline.
 */
export async function sendWelcome(
  db: Kysely<Database>,
  shopId: string,
  user: UserData,
  shopName?: string,
): Promise<string> {
  const loginUrl = process.env.APP_URL ?? 'https://app.gbox.io'

  // Resolve shop name if not provided
  let resolvedShopName = shopName
  if (!resolvedShopName) {
    const shop = await db
      .selectFrom('shops')
      .select('name')
      .where('id', '=', shopId)
      .executeTakeFirst()
    resolvedShopName = shop?.name ?? 'Gbox Platform'
  }

  const templateData: Record<string, unknown> = {
    user_name: user.name ?? user.email,
    shop_name: resolvedShopName,
    login_url: loginUrl,
  }

  // Dynamic import avoids a circular dep (send.ts shares delivery-log
  // + preferences with this module).
  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'welcome',
    to: user.email,
    shopId,
    variables: templateData,
    // Idempotency keyed by (user, shop) — same choice as the real
    // trigger in create-store.ts so both paths are guaranteed to
    // collapse if the caller accidentally invokes both.
    idempotencyKey: `welcome:${user.id ?? user.email}:${shopId}`,
  })
  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

// ---------------------------------------------------------------------------
// Draft order invoice
// ---------------------------------------------------------------------------

export interface InvoiceData {
  order_id: string
  order_number: number
  email: string
  currency: string
  line_items: Array<{
    title: string
    variant_title: string | null
    quantity: number
    price: string
  }>
  subtotal: string
  total: string
  note: string | null
  payment_url: string
  due_date: string | null
}

/**
 * Send an invoice email for a draft order.
 *
 * PR2 commit 6 — now delegates to the unified `sendTemplatedEmail`
 * pipeline. Two active callsites in `apps/store-admin/src/pages/
 * draft-orders.ts` (manual "Send invoice" action + bulk resend)
 * stay source-compatible.
 *
 * While we were in here, fixed a latent template-variable mismatch:
 * the legacy template used `{{note_html}}` / `{{due_date_html}}` but
 * the old templateData only passed plain `note` / `due_date`, so the
 * literal placeholders leaked into the rendered email. Now the shim
 * pre-wraps both fields in display markup (or substitutes empty
 * strings when missing, collapsing the section entirely).
 */
export async function sendInvoice(
  db: Kysely<Database>,
  shopId: string,
  invoice: InvoiceData,
): Promise<string> {
  const lineItemsHtml = invoice.line_items
    .map(
      (li) =>
        `<tr><td>${escapeHtml(li.title)}${li.variant_title ? ` - ${escapeHtml(li.variant_title)}` : ''}</td>` +
        `<td style="text-align:center">${li.quantity}</td><td style="text-align:right">${invoice.currency} ${li.price}</td></tr>`,
    )
    .join('')

  // Pre-wrap note + due_date in their display markup so an empty
  // value collapses the whole section (matches legacy HTML's
  // `{{note_html}}` / `{{due_date_html}}` expectations).
  const noteHtml = invoice.note
    ? `<div class="note"><strong>Note:</strong> ${escapeHtml(invoice.note)}</div>`
    : ''
  const dueDateHtml = invoice.due_date
    ? `<p class="due-date">Due by ${escapeHtml(invoice.due_date)}</p>`
    : ''

  const templateData: Record<string, unknown> = {
    order_number: invoice.order_number,
    line_items_html: lineItemsHtml,
    subtotal: invoice.subtotal,
    total: invoice.total,
    currency: invoice.currency,
    note_html: noteHtml,
    payment_url: invoice.payment_url,
    due_date_html: dueDateHtml,
  }

  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'draft_order_invoice',
    to: invoice.email,
    shopId,
    variables: templateData,
    // Draft-invoice idempotency is tricky: sellers legitimately resend
    // the same invoice when the customer loses it. We scope by
    // `order_id + total` so a resend of the SAME invoice collapses,
    // but an edit (different total) is allowed through.
    idempotencyKey: `draft_invoice:${invoice.order_id}:${invoice.total}`,
  })
  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

// ---------------------------------------------------------------------------
// Refund notification
// ---------------------------------------------------------------------------

export interface RefundData {
  id: string
  amount: string
  currency: string
  reason: string | null
  refund_line_items: Array<{
    title: string
    variant_title: string | null
    quantity: number
    price: string
  }>
}

/**
 * Send a refund notification email.
 *
 * PR2 commit 5 — now delegates to the unified `sendTemplatedEmail`
 * pipeline. Two active callsites in server.ts (`refund_request`
 * approval path + direct refund endpoint) keep their existing
 * `sendRefundNotification(db, shopId, order, refund)` shape — no
 * caller-side changes needed.
 *
 * Idempotency key `refund_notification:{refundId}` collapses any
 * double-fire from webhook retries on the refund processor; a
 * partial refund followed later by another partial refund gets
 * distinct refund rows (distinct ids), so they each mail.
 */
export async function sendRefundNotification(
  db: Kysely<Database>,
  shopId: string,
  order: OrderData,
  refund: RefundData,
): Promise<string> {
  const lineItemsHtml = refund.refund_line_items
    .map(
      (li) =>
        `<tr><td>${escapeHtml(li.title)}${li.variant_title ? ` - ${escapeHtml(li.variant_title)}` : ''}</td>` +
        `<td>${li.quantity}</td><td>${refund.currency} ${li.price}</td></tr>`,
    )
    .join('')

  const customerName = order.shipping_address
    ? `${(order.shipping_address as any).first_name ?? ''} ${(order.shipping_address as any).last_name ?? ''}`.trim()
    : order.email

  const templateData: Record<string, unknown> = {
    order_number: order.order_number,
    customer_name: customerName || order.email,
    refund_amount: refund.amount,
    currency: refund.currency,
    reason: refund.reason ?? 'No reason provided',
    line_items_html: lineItemsHtml,
  }

  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'refund_notification',
    to: order.email,
    shopId,
    variables: templateData,
    idempotencyKey: `refund_notification:${refund.id}`,
  })
  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

// ---------------------------------------------------------------------------
// Abandoned cart recovery
// ---------------------------------------------------------------------------

export interface AbandonedCartData {
  checkout_id: string
  email: string
  customer_name: string | null
  items: Array<{
    title: string
    variant_title: string | null
    quantity: number
    price: string
  }>
  total: string
  currency: string
  recovery_url: string
}

/**
 * Send an abandoned cart recovery email.
 *
 * PR2 commit 10 — delegates to the unified `sendTemplatedEmail`
 * pipeline so every recovery send:
 *   - respects per-shop overrides (PR1.5 `email_template_overrides`)
 *   - respects customer opt-out (lifecycle category — separate toggle
 *     from marketing, so a customer can mute promos but still get
 *     "you left items in your cart")
 *   - writes a row to `email_deliveries` (audit + admin UI)
 *   - routes via the unified transport (`resolveTransport()` env picker)
 *   - gets an unsubscribe footer auto-injected by send.ts (the scaffold
 *     `unsubscribe_html` / `unsubscribe_text` vars render into the
 *     footer markers the registry spec now carries).
 *
 * Scope note: this shim is the SIMPLE-path sender (one-shot API). The
 * full abandoned-cart flow (multi-step enrolment + cron + per-step
 * scheduling) lives in `packages/core/src/modules/marketing/
 * abandoned-cart-cron.ts` which has its own step-template engine and
 * hasn't been migrated to sendTemplatedEmail yet — that's tracked
 * in phase-14-deferred.md (step-template migration is a PR of its
 * own because the cron engine's template shape differs from the
 * registry shape).
 *
 * Idempotency: keyed on `checkout_id` so the same cart can't get
 * spammed. If the cron driver later tries to re-dispatch step 1 for
 * a cart that already shipped, the delivery-log returns the prior
 * row and no duplicate email fires.
 */
export async function sendAbandonedCartRecovery(
  db: Kysely<Database>,
  shopId: string,
  cart: AbandonedCartData,
): Promise<string> {
  const lineItemsHtml = cart.items
    .map(
      (li) =>
        `<tr><td>${escapeHtml(li.title)}${li.variant_title ? ` - ${escapeHtml(li.variant_title)}` : ''}</td>` +
        `<td>${li.quantity}</td><td>${cart.currency} ${li.price}</td></tr>`,
    )
    .join('')

  const templateData: Record<string, unknown> = {
    customer_name: cart.customer_name ?? 'there',
    line_items_html: lineItemsHtml,
    total: cart.total,
    currency: cart.currency,
    recovery_url: cart.recovery_url,
  }

  // Dynamic import avoids the circular dep (service.ts ↔ send.ts via
  // shared delivery-log + preferences imports).
  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'abandoned_cart_recovery',
    to: cart.email,
    shopId,
    variables: templateData,
    idempotencyKey: `abandoned_cart_recovery:${cart.checkout_id}`,
  })

  // Backward-compat: existing callers expect a string (messageId or
  // delivery-log id). Recovery emails are fire-and-forget — on
  // skipped/blocked/failed we return '' rather than throwing, so the
  // cron driver can proceed.
  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

// ---------------------------------------------------------------------------
// Gift card delivery
// ---------------------------------------------------------------------------

export interface GiftCardDeliveryData {
  code: string
  currency: string
  initial_value: string
  recipient_email: string
  recipient_name: string | null
  sender_name: string | null
  personal_message: string | null
  shop_name: string
  expires_at: string | null
}

/**
 * Deliver a gift card to its recipient. Uses the `gift_card_delivery`
 * template — sellers can override this via `email_template_overrides`
 * like any other transactional email.
 *
 * PR2 commit 7 — now delegates to the unified `sendTemplatedEmail`
 * pipeline. Called from `packages/core/src/modules/gift-cards/email.ts`
 * (immediate delivery + scheduled cron fan-out). The cron has its own
 * `markGiftCardEmailSent` marker against double-delivery; the idempotency
 * key below is belt-and-braces for concurrent tick races.
 */
export async function sendGiftCardDelivery(
  db: Kysely<Database>,
  shopId: string,
  card: GiftCardDeliveryData,
): Promise<string> {
  const messageHtml = card.personal_message
    ? `<div class="message">${escapeHtml(card.personal_message)}</div>`
    : ''
  const expiresHtml = card.expires_at
    ? `<div class="expires">This gift card expires on ${escapeHtml(
        new Date(card.expires_at).toLocaleDateString(),
      )}.</div>`
    : ''

  const templateData: Record<string, unknown> = {
    code: card.code,
    currency: card.currency,
    initial_value: card.initial_value,
    recipient_name: card.recipient_name ?? 'there',
    sender_name: card.sender_name ?? card.shop_name,
    shop_name: card.shop_name,
    message_html: messageHtml,
    expires_html: expiresHtml,
  }

  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'gift_card_delivery',
    to: card.recipient_email,
    shopId,
    variables: templateData,
    // Gift-card codes are globally unique (generated via crypto) so
    // `code` alone is a stable dedupe key for the lifetime of the card.
    idempotencyKey: `gift_card:${card.code}`,
  })
  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

// ---------------------------------------------------------------------------
// Review notifications (Phase 10 PR3)
// ---------------------------------------------------------------------------

export interface ReviewNotificationData {
  /**
   * The product_reviews.id the notification is about. Added in PR2
   * commit 11 — powers idempotency keys so re-approval / re-approve-
   * after-unapprove cycles don't spam the reviewer. Required: both
   * upstream callsites (approveReview, replyToReview in reviews/
   * service.ts) already have the reviewId parameter in scope.
   */
  reviewId: string
  /** 1..5 */
  rating: number
  title: string | null
  body: string
  authorName: string
  authorEmail: string
  productTitle: string
  productUrl: string
  shopName: string
}

export interface ReviewReplyNotificationData extends ReviewNotificationData {
  replyBody: string
  replyAuthor: string | null
}

function renderStars(rating: number): string {
  const safe = Math.max(0, Math.min(5, Math.round(rating)))
  return '★★★★★☆☆☆☆☆'.slice(5 - safe, 10 - safe)
}

/**
 * Notify the reviewer that their review was approved and is now public.
 * Merchants can disable this in `shop_review_settings` —
 * `service.ts::updateReviewStatus` only calls this when the flag is on.
 *
 * PR2 commit 11 — delegates to the unified `sendTemplatedEmail` pipeline
 * so every approval notification:
 *   - respects per-shop overrides (PR1.5 `email_template_overrides`)
 *   - honours the reviewer's preferences (reviews-category opt-out is
 *     separate from marketing — a customer who muted promos still gets
 *     approval notifications unless they explicitly muted reviews)
 *   - writes a row to `email_deliveries` (audit + admin UI)
 *   - gets a full unsubscribe footer auto-injected (reviews is an opt-
 *     out category so send.ts stamps the `{{unsubscribe_html}}` /
 *     `{{unsubscribe_text}}` variables — the registry spec consumes
 *     them in the footer).
 *
 * Idempotency: keyed on the review id so a re-approve (or approve→
 * un-approve→re-approve cycle) doesn't spam the reviewer.
 */
export async function sendReviewApproved(
  db: Kysely<Database>,
  shopId: string,
  data: ReviewNotificationData,
): Promise<string> {
  const titleHtml = data.title
    ? `<div class="review-title">${escapeHtml(data.title)}</div>`
    : ''
  const templateData: Record<string, unknown> = {
    customer_name: data.authorName || 'there',
    product_title: data.productTitle,
    product_url: data.productUrl,
    shop_name: data.shopName,
    stars: renderStars(data.rating),
    title_html: titleHtml,
    body_html: escapeHtml(data.body).replace(/\n/g, '<br>'),
  }

  // Dynamic import — avoids the circular dep between service.ts ↔ send.ts
  // via shared delivery-log + preferences imports.
  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'review_approved',
    to: data.authorEmail,
    shopId,
    variables: templateData,
    idempotencyKey: `review_approved:${data.reviewId}`,
  })

  // Backward-compat: Promise<string>. On ok, return messageId (or the
  // delivery row id if the transport didn't emit one). On skipped/
  // blocked/failed return '' — this helper is wrapped in try/catch by
  // `approveReview()` which already swallows failures per Iron rule 5.
  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

/**
 * Notify the reviewer that the merchant has replied to their review.
 *
 * PR2 commit 12 — delegates to `sendTemplatedEmail`. Same reasoning as
 * review_approved (commit 11): per-shop overrides, preference gate,
 * delivery-log audit, unsubscribe footer auto-injection.
 *
 * Idempotency: review id + SHA-256-prefix of the reply body. The hash
 * prefix is important — a merchant may edit their reply (e.g. typo fix,
 * expanded answer) and re-notify; each distinct reply body should land
 * in the customer's inbox. Re-sending the EXACT same reply dedupes.
 */
export async function sendReviewReplied(
  db: Kysely<Database>,
  shopId: string,
  data: ReviewReplyNotificationData,
): Promise<string> {
  const templateData: Record<string, unknown> = {
    customer_name: data.authorName || 'there',
    product_title: data.productTitle,
    product_url: data.productUrl,
    shop_name: data.shopName,
    stars: renderStars(data.rating),
    body_html: escapeHtml(data.body).replace(/\n/g, '<br>'),
    reply_author: data.replyAuthor ?? data.shopName,
    reply_body_html: escapeHtml(data.replyBody).replace(/\n/g, '<br>'),
  }

  // Hash-prefix the reply body so edits to the reply fire a new email
  // (merchant fixes a typo + re-notify → customer sees the updated
  // reply), while exact-replay attempts dedupe via the idempotent
  // insert path.
  const replyHash = createHash('sha256')
    .update(data.replyBody)
    .digest('hex')
    .slice(0, 16)

  const { sendTemplatedEmail } = await import('./send.js')
  const result = await sendTemplatedEmail(db, {
    templateKey: 'review_replied',
    to: data.authorEmail,
    shopId,
    variables: templateData,
    idempotencyKey: `review_replied:${data.reviewId}:${replyHash}`,
  })

  if (result.ok) return result.messageId ?? String(result.deliveryId)
  return ''
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
