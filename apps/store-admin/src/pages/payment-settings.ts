/**
 * Store Admin — Settings > Payments
 *
 * Payment providers: PayPal (default, primary), Stripe (fallback), Manual/COD
 * PayPal flow: Create new PayPal account (chính chủ) → OR connect existing account
 * Persisted in shop_settings table (key-value per shop)
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
// (paymentCsrf riêng đã loại bỏ — dùng csrfStore chính qua middleware)
import { notify, byActor } from '../lib/notify.js'
import {
  createPartnerReferralLink,
  getMerchantIntegrationInfo,
} from '../lib/paypal-partner-api.js'
import {
  createApiContext as createPaymentApiCtx,
  listPayments as listBePayments,
  upsertPaymentByGateway,
  createPayment,
  deletePayment,
  setActivePayment,
  listPaymentsByGateway,
  type BePayment,
} from '../lib/payment-api-client.js'
import { renderPaypalAccountsList, renderPaypalToggleButton } from './payment-paypal-accounts-render.js'

// Multi-account constraint: tối đa 5 PayPal record/shop, single-active.
const MAX_PAYPAL_ACCOUNTS = 5

// const paymentCsrf — loại bỏ; dùng csrfStore chính từ middleware.

// ─── Helpers ────────────────────────────────────────────────────

function mask(val: string): string {
  if (!val || val.length <= 4) return val ? '****' : ''
  return '*'.repeat(val.length - 4) + val.slice(-4)
}

function parseSettingsValue<T = any>(val: unknown): T {
  if (val == null) return null as T
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T } catch { return val as T }
  }
  return val as T
}

async function loadSettings(
  db: Kysely<Database>,
  shopId: string,
): Promise<Map<string, any>> {
  const rows = await db
    .selectFrom('shop_settings')
    .select(['key', 'value'])
    .where('shop_id', '=', shopId)
    .execute()

  const map = new Map<string, any>()
  for (const r of rows) {
    map.set(r.key, parseSettingsValue(r.value))
  }
  return map
}

async function upsertSetting(
  db: Kysely<Database>,
  shopId: string,
  key: string,
  value: any,
): Promise<void> {
  const existing = await db
    .selectFrom('shop_settings')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()

  const jsonVal = JSON.stringify(value)
  if (existing) {
    await db
      .updateTable('shop_settings')
      .set({ value: jsonVal, updated_at: new Date() })
      .where('id', '=', existing.id)
      .execute()
  } else {
    await db
      .insertInto('shop_settings')
      .values({
        shop_id: shopId,
        key,
        value: jsonVal,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute()
  }
}

// Setting keys
const KEYS = {
  // PayPal (primary — default enabled)
  paypalEnabled: 'payment_paypal_enabled',
  paypalClientId: 'payment_paypal_client_id',
  paypalClientSecret: 'payment_paypal_client_secret',
  paypalSandbox: 'payment_paypal_sandbox',
  paypalMerchantId: 'paypal_partner.paypal_merchant_id',
  paypalConnected: 'paypal_partner.paypal_connected',
  paypalConnectedAt: 'paypal_partner.paypal_connected_at',
  paypalAccountEmail: 'paypal_partner.paypal_account_email',
  // Stripe (fallback)
  stripeEnabled: 'payment_stripe_enabled',
  stripeApiKey: 'payment_stripe_api_key',
  stripeWebhookSecret: 'payment_stripe_webhook_secret',
  stripeTestMode: 'payment_stripe_test_mode',
  // Manual / COD
  manualEnabled: 'payment_manual_enabled',
  manualInstructions: 'payment_manual_instructions',
  // General settings
  autoCapture: 'payment_auto_capture',
  refundPolicy: 'payment_refund_policy',
  // Payment capture method — 3-enum (Shopify-style):
  // 'automatic_checkout' | 'automatic_fulfilled' | 'manual'
  captureMethod: 'payment_capture_method',
  // Gift cards: never expire | expire after N days (BE policy stub)
  giftCardExpiration: 'payment_gift_card_expiration',
} as const

// ─── Shared styles ──────────────────────────────────────────────

const INPUT_STYLE = 'width:100%;padding:10px 14px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)'
const LABEL_STYLE = 'display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-dim)'

const PAGE_CSS = `
<style>
  /* Constrain the payment-settings column so it doesn't stretch across a
     wide monitor. Thai flagged the page felt way too long horizontally —
     Shopify's own payments settings sit around ~740-800px wide, which
     keeps the 2-column Client ID / Client Secret grid readable without
     making the page feel like an empty racetrack. 820 is wide enough to
     still fit the 2-col inputs comfortably (≈378px each after gutters).
     The cards below already use 100% width, so constraining the wrapper
     is enough — no per-card tweaks needed. */
  .pay-settings-wrap { max-width:820px; margin:0 auto; }

  .toggle-switch { position:relative; display:inline-block; width:44px; height:24px; }
  .toggle-switch input { opacity:0; width:0; height:0; }
  .toggle-slider {
    position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0;
    background:var(--s-border); border-radius:24px; transition:.25s;
  }
  .toggle-slider::before {
    content:""; position:absolute; height:18px; width:18px; left:3px; bottom:3px;
    background:#fff; border-radius:50%; transition:.25s;
  }
  .toggle-switch input:checked + .toggle-slider { background:var(--s-accent, #6366f1); }
  .toggle-switch input:checked + .toggle-slider::before { transform:translateX(20px); }
  .radio-group { display:flex; gap:16px; flex-wrap:wrap; }
  .radio-group label { display:flex; align-items:center; gap:6px; font-size:13px; cursor:pointer; }

  .provider-card { background:var(--s-surface); border:1px solid var(--s-border); border-radius:12px; margin-bottom:20px; overflow:hidden; }
  .provider-card.primary { border-color:var(--s-accent, #6366f1); border-width:2px; }
  .provider-header { display:flex; align-items:center; justify-content:space-between; padding:20px 24px; }
  .provider-body { padding:0 24px 24px; }
  .provider-icon { width:44px; height:44px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:22px; flex-shrink:0; }
  .provider-info { margin-left:12px; flex:1; }
  .provider-name { font-weight:700; font-size:15px; }
  .provider-desc { font-size:12px; color:var(--s-text-dim); margin-top:2px; }
  .provider-badge { font-size:10px; font-weight:700; padding:3px 8px; border-radius:4px; text-transform:uppercase; letter-spacing:.5px; }
  .badge-default { background:var(--s-accent, #6366f1); color:#fff; }
  .badge-fallback { background:var(--s-border); color:var(--s-text-dim); }
  .badge-connected { background:rgba(16,185,129,.15); color:#10b981; }

  .paypal-flow-tabs { display:flex; gap:0; margin-bottom:20px; border:1px solid var(--s-border); border-radius:8px; overflow:hidden; }
  .paypal-flow-tab { flex:1; padding:12px 16px; text-align:center; cursor:pointer; font-size:13px; font-weight:600; transition:all .2s; border:none; background:transparent; color:var(--s-text-dim); }
  .paypal-flow-tab.active { background:var(--s-accent, #6366f1); color:#fff; }
  .paypal-flow-tab:hover:not(.active) { background:rgba(99,102,241,.08); }
  .paypal-flow-panel { display:none; }
  .paypal-flow-panel.active { display:block; }

  .step-list { list-style:none; padding:0; margin:0; }
  .step-item { display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--s-border); }
  .step-item:last-child { border-bottom:none; }
  .step-num { width:28px; height:28px; border-radius:50%; background:var(--s-accent, #6366f1); color:#fff; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; flex-shrink:0; }
  .step-content { flex:1; }
  .step-title { font-weight:600; font-size:13px; margin-bottom:2px; }
  .step-desc { font-size:12px; color:var(--s-text-dim); line-height:1.5; }

  .info-box { background:rgba(99,102,241,.06); border:1px solid rgba(99,102,241,.15); border-radius:8px; padding:14px 16px; margin-bottom:16px; }
  .info-box p { margin:0; font-size:12px; line-height:1.6; color:var(--s-text-dim); }
  .info-box strong { color:var(--s-text); }
  .warning-box { background:rgba(234,179,8,.08); border:1px solid rgba(234,179,8,.2); border-radius:8px; padding:14px 16px; margin-bottom:16px; }

  .connect-btn { display:inline-flex; align-items:center; gap:8px; padding:12px 24px; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; border:none; transition:all .2s; text-decoration:none; }
  .connect-btn-paypal { background:#0070ba; color:#fff; }
  .connect-btn-paypal:hover { background:#005ea6; }
  .connect-btn-create { background:#ffc439; color:#003087; }
  .connect-btn-create:hover { background:#f0b72f; }

  .connected-status { display:flex; align-items:center; gap:12px; padding:16px; background:rgba(16,185,129,.06); border:1px solid rgba(16,185,129,.2); border-radius:8px; }
  .connected-dot { width:10px; height:10px; border-radius:50%; background:#10b981; flex-shrink:0; }
</style>
`

// ─── GET: Display payment settings ──────────────────────────────

export async function getPaymentSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const success = req.query.success as string | undefined
  const error = req.query.error as string | undefined

  // Removed local DB (shop_settings) per "bám sát BE" rule (2026-05-02).
  // All payment config now sourced from BE Payment Service. Shop-level policies
  // (capture method, refund, gift card expiration, ...) — pending BE endpoint
  // GET/PUT /api/{shop_id}/payment-policy. See:
  //   plans/reports/be-gaps-260502-1003-payment-settings.md
  // While waiting, those fields render as visual-only with warning banner.
  const dbAvailable = false  // legacy flag kept for downstream compatibility

  // Helper that derives gateway state from BE Payment list. Looks up by paygate.
  const findGw = (paygate: string) => bePayments.find(p => p.paygate === paygate)

  const get = (_key: string, fallback = ''): string => {
    // TODO: wire to BE payment-policy endpoint when available
    return fallback
  }
  const isOn = (_key: string, defaultOn = false): boolean => {
    // TODO: wire to BE payment-policy endpoint when available
    return defaultOn
  }

  const currency = store.currency || 'VND'
  // Dùng csrfToken từ admin middleware (req.csrfToken) — cùng cookie với mọi
  // page khác trong store-admin. Trước đây dùng paymentCsrf riêng gây split-brain
  // và conflict với global auto-refresh JS (cookie name khác).
  const csrfField = csrfHiddenField(req.csrfToken!)

  // Fetch payment gateways registered in BE Payment Service (centralized list).
  // Used to show "Active gateways" banner so seller knows which gateways
  // storefront /payments/public will return for checkout.
  let bePayments: BePayment[] = []
  try {
    const payCtx = createPaymentApiCtx(req)
    const r = await listBePayments(payCtx, { limit: 50 })
    bePayments = r.data ?? []
  } catch (err: any) {
    console.warn('[payment-settings] BE Payment-Service list failed:', err?.message)
  }

  // PayPal accounts (multi-record): all PayPal payment records for this shop.
  // Single-active rule enforced ở activate handler. Connected = có ít nhất 1 active.
  const paypalAccounts = bePayments.filter(p => p.paygate === 'Paypal')
  const paypalActive = paypalAccounts.find(p => p.active)
  const paypalConnected = !!paypalActive
  const showAddPaypalForm = req.query.add_paypal === '1'

  // Onboarding return URL
  const returnUrl = `${req.protocol}://${req.get('host')}${base}/settings/payments?paypal_onboarded=1`

  const content = `
    ${PAGE_CSS}

    <div class="pay-settings-wrap">
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Payments</h1>
        <p class="page-subtitle">Configure payment providers for your store. PayPal is the default payment gateway.</p>
      </div>
      <button form="paymentForm" type="submit" class="btn btn-primary">Save settings</button>
    </div>

    ${success ? `
      <div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">
        ${esc(success)}
      </div>
    ` : ''}

    ${error ? `
      <div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-error, #ef4444);font-size:13px">
        ${esc(error)}
      </div>
    ` : ''}

    <!-- BE-pending banner: shop-level policy fields (capture method, refund,
         gift card expiration, Apple Wallet) are visual-only until BE adds
         GET/PUT /api/{shop_id}/payment-policy.
         See plans/reports/be-gaps-260502-1003-payment-settings.md -->
    <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.4);border-radius:8px;padding:10px 14px;margin-bottom:18px;color:var(--s-text);font-size:12px;line-height:1.5">
      <strong style="color:#f59e0b">⚠ Heads up</strong> — Shop-level policies (Payment capture / Manual methods / Customizations / Gift card expiration / Apple Wallet) are <em>visual-only</em>. Pending BE endpoint <code>/api/{shop_id}/payment-policy</code>. Gateway credentials (PayPal, Stripe) save to BE Payment Service normally.
    </div>

    <form id="paymentForm" method="POST" action="${base}/settings/payments">
      ${csrfField}

      <!-- ═══════════════════════════════════════════════════════════
           PAYPAL — PRIMARY PAYMENT GATEWAY (DEFAULT)
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card primary">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-icon" style="background:rgba(0,112,186,.1)">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106z" fill="#003087"/><path d="M18.171 7.394c-.985 5.05-4.35 6.797-8.647 6.797H7.334c-.524 0-.968.382-1.05.9L5.07 22.255a.534.534 0 0 0 .527.617h3.705c.46 0 .85-.334.921-.788l.038-.196.728-4.617.047-.255c.071-.454.46-.788.921-.788h.58c3.76 0 6.703-1.528 7.562-5.95.36-1.847.174-3.388-.778-4.473a3.715 3.715 0 0 0-1.154-.911z" fill="#0070ba"/></svg>
            </div>
            <div class="provider-info">
              <div class="provider-name">PayPal</div>
              <div class="provider-desc">Accept PayPal, Venmo, Debit/Credit Cards, Pay Later</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            ${paypalConnected
              ? '<span class="provider-badge badge-connected">Connected</span>'
              : '<span class="provider-badge badge-fallback">Inactive</span>'}
            ${renderPaypalToggleButton({
              base,
              enabled: paypalConnected,
              accountsCount: paypalAccounts.length,
            })}
          </div>
        </div>

        <div class="provider-body">
          ${renderPaypalAccountsList({
            base,
            accounts: paypalAccounts,
            maxAccounts: MAX_PAYPAL_ACCOUNTS,
            showAddForm: showAddPaypalForm,
            csrfField,
          })}
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           STRIPE — FALLBACK GATEWAY
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-icon" style="background:rgba(99,91,255,.1)">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M2 10h20M2 14h20M4 6h16a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z" stroke="#635bff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div class="provider-info">
              <div class="provider-name">Stripe</div>
              <div class="provider-desc">Credit cards, Apple Pay, Google Pay (fallback gateway)</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="provider-badge badge-fallback">Fallback</span>
            <label class="toggle-switch">
              <input type="checkbox" name="stripe_enabled" value="1" ${isOn(KEYS.stripeEnabled) ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="provider-body">
          <div class="info-box" style="margin-bottom:16px">
            <p>Stripe is used as a fallback when PayPal is not available. Enable it as a secondary payment option for customers who prefer credit cards directly.</p>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
            <div>
              <label style="${LABEL_STYLE}">API Key</label>
              <input type="password" name="stripe_api_key" placeholder="${get(KEYS.stripeApiKey) ? mask(get(KEYS.stripeApiKey)) : 'sk_live_...'}" autocomplete="off" style="${INPUT_STYLE}">
              ${get(KEYS.stripeApiKey) ? `<div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">Current: ${esc(mask(get(KEYS.stripeApiKey)))}</div>` : ''}
            </div>
            <div>
              <label style="${LABEL_STYLE}">Webhook Secret</label>
              <input type="password" name="stripe_webhook_secret" placeholder="${get(KEYS.stripeWebhookSecret) ? mask(get(KEYS.stripeWebhookSecret)) : 'whsec_...'}" autocomplete="off" style="${INPUT_STYLE}">
              ${get(KEYS.stripeWebhookSecret) ? `<div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">Current: ${esc(mask(get(KEYS.stripeWebhookSecret)))}</div>` : ''}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <label class="toggle-switch">
              <input type="checkbox" name="stripe_test_mode" value="1" ${isOn(KEYS.stripeTestMode) ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <span style="font-size:13px">Test mode</span>
            <span style="font-size:11px;color:var(--s-text-dim)">(use Stripe test keys, no real charges)</span>
          </div>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           MANUAL / COD
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-icon" style="background:rgba(16,185,129,.1)">
              <span style="font-size:22px">&#128181;</span>
            </div>
            <div class="provider-info">
              <div class="provider-name">Manual / Cash on Delivery</div>
              <div class="provider-desc">Bank transfer, COD, or custom payment instructions</div>
            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" name="manual_enabled" value="1" ${isOn(KEYS.manualEnabled) ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="provider-body">
          <label style="${LABEL_STYLE}">Payment Instructions</label>
          <textarea name="manual_instructions" rows="4" placeholder="e.g., Please transfer to Account #12345 at ABC Bank. Include your order number as the reference."
            style="${INPUT_STYLE};resize:vertical;font-family:inherit">${esc(get(KEYS.manualInstructions))}</textarea>
          <div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">Shown to customers who choose this payment method at checkout.</div>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           PAYMENT SETTINGS
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-icon" style="background:rgba(99,102,241,.1)">
              <span style="font-size:22px">&#9881;</span>
            </div>
            <div class="provider-info">
              <div class="provider-name">Payment Settings</div>
              <div class="provider-desc">Auto-capture, refund policy, and general configuration</div>
            </div>
          </div>
        </div>
        <div class="provider-body">
          <!-- Currency -->
          <div style="margin-bottom:20px">
            <label style="${LABEL_STYLE}">Store Currency</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="text" value="${esc(currency)}" disabled
                style="${INPUT_STYLE};background:var(--s-bg-dim, rgba(0,0,0,.05));opacity:.7;max-width:120px">
              <span style="font-size:12px;color:var(--s-text-dim)">Change in <a href="${base}/settings/general" style="color:var(--s-accent, #6366f1);text-decoration:none">General Settings</a></span>
            </div>
          </div>

          <!-- Auto-capture -->
          <div style="margin-bottom:20px">
            <label style="${LABEL_STYLE}">Auto-capture payments</label>
            <div class="radio-group">
              <label>
                <input type="radio" name="auto_capture" value="yes" ${get(KEYS.autoCapture, 'yes') === 'yes' ? 'checked' : ''}>
                <span>Yes</span>
                <span style="font-size:11px;color:var(--s-text-dim)">&mdash; capture immediately on order</span>
              </label>
              <label>
                <input type="radio" name="auto_capture" value="no" ${get(KEYS.autoCapture, 'yes') === 'no' ? 'checked' : ''}>
                <span>No</span>
                <span style="font-size:11px;color:var(--s-text-dim)">&mdash; authorize only, capture manually</span>
              </label>
            </div>
          </div>

          <!-- Refund policy -->
          <div>
            <label style="${LABEL_STYLE}">Refund Policy</label>
            <select name="refund_policy" style="${INPUT_STYLE};max-width:280px">
              <option value="full" ${get(KEYS.refundPolicy, 'full') === 'full' ? 'selected' : ''}>Full refund allowed</option>
              <option value="partial" ${get(KEYS.refundPolicy, 'full') === 'partial' ? 'selected' : ''}>Partial refund allowed</option>
              <option value="none" ${get(KEYS.refundPolicy, 'full') === 'none' ? 'selected' : ''}>No refunds</option>
            </select>
            <div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">Controls the refund options available when processing returns.</div>
          </div>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           ACTIVE GATEWAYS (registered in BE Payment Service)
           Read-only: shows what storefront /payments/public returns.
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-info">
              <div class="provider-name">Active payment gateways</div>
              <div class="provider-desc">Live registry from Gbox Payment Service. Storefront checkout uses this list.</div>
            </div>
          </div>
        </div>
        <div class="provider-body">
          ${bePayments.length === 0 ? `
            <div style="padding:14px;border:1px dashed var(--s-border);border-radius:8px;color:var(--s-text-dim);font-size:13px;text-align:center">
              No gateways registered yet. Connect PayPal above or activate Stripe to populate.
            </div>
          ` : `
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="border-bottom:1px solid var(--s-border)">
                  <th style="text-align:left;padding:8px 10px;font-weight:500;font-size:11px;color:var(--s-text-dim)">Gateway</th>
                  <th style="text-align:left;padding:8px 10px;font-weight:500;font-size:11px;color:var(--s-text-dim)">Name</th>
                  <th style="text-align:left;padding:8px 10px;font-weight:500;font-size:11px;color:var(--s-text-dim)">Mode</th>
                  <th style="text-align:left;padding:8px 10px;font-weight:500;font-size:11px;color:var(--s-text-dim)">Active</th>
                  <th style="text-align:left;padding:8px 10px;font-weight:500;font-size:11px;color:var(--s-text-dim)">Public key</th>
                </tr>
              </thead>
              <tbody>
                ${bePayments.map(p => `<tr style="border-bottom:1px solid var(--s-border)">
                  <td style="padding:10px;font-weight:600">${esc(String(p.paygate || '—'))}</td>
                  <td style="padding:10px">${esc(String(p.name || '—'))}</td>
                  <td style="padding:10px">${p.live ? '<span style="color:#10b981">Live</span>' : '<span style="color:#f59e0b">Sandbox</span>'}</td>
                  <td style="padding:10px">${p.active ? '<span style="color:#10b981">●</span> Yes' : '<span style="color:var(--s-text-dim)">○</span> No'}</td>
                  <td style="padding:10px;font-family:monospace;font-size:11px;color:var(--s-text-dim)">${esc(mask(String(p.public_key || '')))}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          `}
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           PAYMENT CAPTURE METHOD — 3 radios (Shopify-style)
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-info">
              <div class="provider-name">Payment capture method</div>
              <div class="provider-desc">Payments are authorized when an order is placed. Select how to capture payments:</div>
            </div>
          </div>
        </div>
        <div class="provider-body">
          <div class="radio-group" style="display:flex;flex-direction:column;gap:14px">
            <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
              <input type="radio" name="capture_method" value="automatic_checkout" ${get(KEYS.captureMethod, 'automatic_checkout') === 'automatic_checkout' ? 'checked' : ''} style="margin-top:3px">
              <div>
                <div style="font-weight:600;font-size:13px;color:var(--s-text)">Automatically at checkout</div>
                <div style="font-size:12px;color:var(--s-text-dim);margin-top:2px">Capture payment when an order is placed</div>
              </div>
            </label>
            <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
              <input type="radio" name="capture_method" value="automatic_fulfilled" ${get(KEYS.captureMethod, 'automatic_checkout') === 'automatic_fulfilled' ? 'checked' : ''} style="margin-top:3px">
              <div>
                <div style="font-weight:600;font-size:13px;color:var(--s-text)">Automatically when the entire order is fulfilled</div>
                <div style="font-size:12px;color:var(--s-text-dim);margin-top:2px">Authorize payment at checkout and capture once the entire order is fulfilled</div>
              </div>
            </label>
            <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
              <input type="radio" name="capture_method" value="manual" ${get(KEYS.captureMethod, 'automatic_checkout') === 'manual' ? 'checked' : ''} style="margin-top:3px">
              <div>
                <div style="font-weight:600;font-size:13px;color:var(--s-text)">Manually</div>
                <div style="font-size:12px;color:var(--s-text-dim);margin-top:2px">Authorize payment at checkout and capture manually</div>
              </div>
            </label>
          </div>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           MANUAL PAYMENT METHODS
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-info">
              <div class="provider-name">Manual payment methods</div>
              <div class="provider-desc">Payments made outside your online store. Orders paid manually must be approved before being fulfilled.</div>
            </div>
          </div>
        </div>
        <div class="provider-body">
          <button type="button" class="btn btn-outline" style="display:inline-flex;align-items:center;gap:6px;padding:10px 16px;font-size:13px;border-radius:8px" onclick="alert('Add a manual payment method (TODO BE wiring).')">
            <span style="font-size:16px;line-height:1">⊕</span> Manual payment method
          </button>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           PAYMENT METHOD CUSTOMIZATIONS
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-info">
              <div class="provider-name">Payment method customizations</div>
              <div class="provider-desc">Control how payment methods appear to your customers at checkout.</div>
            </div>
          </div>
        </div>
        <div class="provider-body">
          <a href="${base}/apps?category=payment-customizations" class="btn btn-outline" style="display:inline-block;padding:10px 16px;font-size:13px;border-radius:8px;text-decoration:none;color:var(--s-text)">View payment method customization apps</a>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           GIFT CARD EXPIRATION
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center">
            <div class="provider-info">
              <div class="provider-name">Gift card expiration</div>
            </div>
          </div>
        </div>
        <div class="provider-body">
          <div class="radio-group" style="display:flex;flex-direction:column;gap:10px">
            <label style="display:flex;gap:10px;align-items:center;cursor:pointer">
              <input type="radio" name="gift_card_expiration" value="never" ${get(KEYS.giftCardExpiration, 'never') === 'never' ? 'checked' : ''}>
              <span style="font-size:13px;color:var(--s-text)">Gift cards never expire</span>
            </label>
            <label style="display:flex;gap:10px;align-items:center;cursor:pointer">
              <input type="radio" name="gift_card_expiration" value="expire" ${get(KEYS.giftCardExpiration, 'never') === 'expire' ? 'checked' : ''}>
              <span style="font-size:13px;color:var(--s-text)">Gift cards expire</span>
            </label>
          </div>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════════════════
           APPLE WALLET PASSES
           ═══════════════════════════════════════════════════════════ -->
      <div class="provider-card">
        <div class="provider-header">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <div style="display:flex;align-items:center">
              <div class="provider-info">
                <div class="provider-name">Apple Wallet passes</div>
                <div class="provider-desc">Give customers a digital Apple Wallet pass to use online or in your retail stores</div>
              </div>
            </div>
            <button type="button" class="btn btn-outline" style="padding:8px 14px;font-size:13px;border-radius:8px" onclick="alert('Apple Wallet customization (TODO BE wiring).')">Customize</button>
          </div>
        </div>
      </div>

      <!-- Bottom save button -->
      <div style="display:flex;justify-content:flex-end;padding-bottom:20px">
        <button type="submit" class="btn btn-primary" style="padding:12px 32px;font-size:14px">Save settings</button>
      </div>

      <p style="text-align:center;margin:0 0 40px;font-size:12px;color:var(--s-text-dim)">
        <a href="https://help.gbox.co/payments" target="_blank" rel="noopener" style="color:var(--s-text-dim);text-decoration:underline">Learn more about payments</a>
      </p>
    </form>

    <!-- Companion form: render OUTSIDE main paymentForm để tránh nested forms.
         Toggle button trong PayPal header dùng form="ps-paypal-toggle" để submit. -->
    <form id="ps-paypal-toggle" method="POST" action="${base}/settings/payments/paypal-accounts/toggle" style="display:none">
      ${csrfField}
    </form>
    </div><!-- /.pay-settings-wrap -->
  `

  res.send(sellerLayout({
    title: 'Payment Settings',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'settings',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─── POST: Save payment settings ────────────────────────────────

export async function postPaymentSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  // CSRF đã verify ở centralized middleware (server.ts) — không cần check riêng.

  try {
    const body = req.body || {}
    const payCtx = createPaymentApiCtx(req)

    // ───────────────────────────────────────────────────────────────
    // BÁM SÁT BE — chỉ ghi vào BE Payment Service.
    // shop_settings (local DB) đã bỏ hoàn toàn (2026-05-02). Field nào
    // BE chưa support → KHÔNG ghi (log warn). Xem report:
    //   plans/reports/be-gaps-260502-1003-payment-settings.md
    // ───────────────────────────────────────────────────────────────

    // PayPal — managed bởi handlers riêng (postPaypalAccountAdd / Activate / Delete).
    // Bỏ wiring ở main settings save form vì giờ multi-account list view ở UI riêng.

    // Stripe — wire BE Payment record (paygate=stripe)
    if (body.stripe_enabled !== undefined || body.stripe_api_key || body.stripe_test_mode !== undefined) {
      await upsertPaymentByGateway(payCtx, 'stripe', {
        name: 'Stripe',
        description: 'Stripe — credit cards, Apple Pay, Google Pay',
        paygate: 'stripe',
        public_key: body.stripe_api_key || undefined,
        private_key: body.stripe_webhook_secret || undefined,
        active: body.stripe_enabled === '1',
        live: body.stripe_test_mode !== '1',
      })
    }

    // Manual / COD — wire BE Payment (paygate=manual). Note: instructions
    // field not yet in BE Payment model — TODO request BE add `instructions`.
    if (body.manual_enabled !== undefined) {
      await upsertPaymentByGateway(payCtx, 'manual', {
        name: 'Manual / COD',
        description: body.manual_instructions || 'Cash on delivery or bank transfer',
        paygate: 'manual',
        active: body.manual_enabled === '1',
        live: true,
      })
    }

    // Shop-level policies — DROPPED. BE chưa có /api/{shop_id}/payment-policy.
    // Log warn so BE team knows what FE is trying to send.
    const droppedFields = [
      'auto_capture', 'refund_policy', 'capture_method', 'gift_card_expiration',
    ].filter(k => body[k] !== undefined && body[k] !== '')
    if (droppedFields.length) {
      console.warn(
        '[payment-settings] BE GAP — fields dropped (no payment-policy endpoint):',
        Object.fromEntries(droppedFields.map(k => [k, body[k]])),
      )
    }

    // Notify (best-effort — uses local DB if available; OK to fail)
    try {
      notify(db, {
        shopId: store.id,
        userId: (req as any).storeUser?.id,
        type: 'payment_settings_updated',
        title: 'Payment settings updated',
        message: byActor((req as any).storeUser),
        resourceType: null,
        resourceId: null,
      })
    } catch { /* ignore — notification is non-critical */ }

    res.redirect(`${base}/settings/payments?success=Payment+settings+saved`)
  } catch (err: any) {
    console.error('[payment-settings] Save error:', err?.message || err)
    res.redirect(`${base}/settings/payments?error=${encodeURIComponent(err?.message || 'Failed to save settings. Please try again.')}`)
  }
}

// ─── POST: Disconnect PayPal (clears partner + credential keys) ───

export async function postDisconnectPaypal(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  // CSRF đã verify ở centralized middleware. Legacy handler — UI không còn
  // disconnect button (đã thay bằng per-account Delete trong list view).
  // Giữ route để backward-compat nếu user còn bookmark cũ.

  try {
    // Disconnect = delete BE Payment record where paygate=paypal.
    // shop_settings dropped per "bám sát BE" rule (2026-05-02).
    const payCtx = createPaymentApiCtx(req)
    const list = await listBePayments(payCtx, { limit: 50 }).catch(() => ({ data: [] as BePayment[] }))
    const paypalRow = (list.data || []).find(p => p.paygate === 'paypal')
    if (paypalRow?.id) {
      const { deletePayment } = await import('../lib/payment-api-client.js')
      await deletePayment(payCtx, paypalRow.id)
    }

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'paypal_disconnected',
      title: 'PayPal disconnected',
      message: byActor((req as any).storeUser),
      resourceType: null,
      resourceId: null,
    })

    res.redirect(`${base}/settings/payments?success=${encodeURIComponent('PayPal disconnected')}`)
  } catch (err) {
    console.error('[payment-settings] PayPal disconnect error:', err)
    res.redirect(`${base}/settings/payments?error=${encodeURIComponent('Failed to disconnect PayPal. Please try again.')}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PayPal multi-account handlers
//   POST /settings/payments/paypal-accounts/add        → create new record
//   POST /settings/payments/paypal-accounts/:id/activate
//   POST /settings/payments/paypal-accounts/:id/delete
// Single-active enforcement ở setActivePayment (sequential PUT).
// Max 5 accounts/shop guard ở Add handler.
// ─────────────────────────────────────────────────────────────────────────

export async function postPaypalAccountAdd(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const back = `${base}/settings/payments`

  try {
    const body = req.body || {}
    const name = String(body.name || '').trim().slice(0, 80)
    const mode = String(body.mode || 'live').toLowerCase()
    const clientId = String(body.client_id || '').trim()
    const clientSecret = String(body.client_secret || '').trim()

    if (!clientId || !clientSecret) {
      res.redirect(`${back}?error=${encodeURIComponent('Client ID and Client Secret are required.')}`)
      return
    }
    if (mode !== 'live' && mode !== 'sandbox') {
      res.redirect(`${back}?error=${encodeURIComponent('Mode must be live or sandbox.')}`)
      return
    }

    const payCtx = createPaymentApiCtx(req)
    const existing = await listPaymentsByGateway(payCtx, 'Paypal')

    if (existing.length >= MAX_PAYPAL_ACCOUNTS) {
      res.redirect(`${back}?error=${encodeURIComponent(`Maximum ${MAX_PAYPAL_ACCOUNTS} PayPal accounts reached. Delete one before adding another.`)}`)
      return
    }

    // Dup-detect: cùng client_id (public_key) đã tồn tại → reject
    if (existing.some(p => p.public_key === clientId)) {
      res.redirect(`${back}?error=${encodeURIComponent('A PayPal account with this Client ID already exists.')}`)
      return
    }

    const isFirst = existing.length === 0
    const live = mode === 'live'

    const created = await createPayment(payCtx, {
      paygate: 'Paypal',
      name: name || (live ? 'PayPal Live' : 'PayPal Sandbox'),
      description: live
        ? 'PayPal — production credentials'
        : 'PayPal — sandbox (test only)',
      public_key: clientId,
      private_key: clientSecret,
      active: isFirst,  // first account auto-activated
      live,
    })

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'paypal_account_added',
      title: `PayPal account added (${live ? 'Live' : 'Sandbox'})`,
      message: byActor((req as any).storeUser),
      resourceType: 'payment',
      resourceId: created.id ?? null,
    })

    res.redirect(`${back}?success=${encodeURIComponent(isFirst ? 'PayPal account added and activated.' : 'PayPal account added (inactive). Click "Set Active" to enable.')}`)
  } catch (err: any) {
    console.error('[paypal-account-add] failed:', err?.message || err)
    res.redirect(`${back}?error=${encodeURIComponent(err?.message || 'Failed to add PayPal account.')}`)
  }
}

export async function postPaypalAccountActivate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const back = `${base}/settings/payments`
  const paymentId = String(req.params.id || '').trim()

  if (!paymentId) {
    res.redirect(`${back}?error=${encodeURIComponent('Missing payment id.')}`)
    return
  }

  try {
    const payCtx = createPaymentApiCtx(req)
    await setActivePayment(payCtx, paymentId, 'Paypal')

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'paypal_account_activated',
      title: 'PayPal active account changed',
      message: byActor((req as any).storeUser),
      resourceType: 'payment',
      resourceId: paymentId,
    })

    res.redirect(`${back}?success=${encodeURIComponent('Active PayPal account updated.')}`)
  } catch (err: any) {
    console.error('[paypal-account-activate] failed:', err?.message || err)
    res.redirect(`${back}?error=${encodeURIComponent(err?.message || 'Failed to set active PayPal account.')}`)
  }
}

/**
 * Toggle bật/tắt PayPal khỏi storefront (master switch).
 *  - enabled='0': set active=false cho TẤT CẢ PayPal records → storefront không thấy PayPal
 *  - enabled='1': nếu chưa có active nào → activate first record (theo position/order)
 *
 * Note: khi toggle off rồi on lại, BE không "nhớ" record nào active trước đó,
 * nên tự pick first. Seller có thể click Set Active để chọn record khác.
 */
export async function postPaypalToggle(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const back = `${base}/settings/payments`

  const enabled = String((req.body || {}).enabled || '').trim() === '1'

  try {
    const payCtx = createPaymentApiCtx(req)
    const accounts = await listPaymentsByGateway(payCtx, 'Paypal')

    if (accounts.length === 0) {
      res.redirect(`${back}?error=${encodeURIComponent('No PayPal accounts to toggle. Add an account first.')}`)
      return
    }

    if (!enabled) {
      // Disable all
      for (const acc of accounts) {
        if (acc.id && acc.active) {
          const { updatePayment } = await import('../lib/payment-api-client.js')
          await updatePayment(payCtx, acc.id, { ...acc, active: false })
        }
      }
    } else {
      // Enable: nếu chưa có active, activate first record
      const hasActive = accounts.some(a => a.active)
      if (!hasActive) {
        const target = accounts[0]
        if (target?.id) {
          await setActivePayment(payCtx, target.id, 'Paypal')
        }
      }
    }

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'paypal_toggle',
      title: `PayPal ${enabled ? 'enabled' : 'disabled'} at storefront`,
      message: byActor((req as any).storeUser),
      resourceType: null,
      resourceId: null,
    })

    res.redirect(`${back}?success=${encodeURIComponent(enabled ? 'PayPal enabled at storefront.' : 'PayPal disabled at storefront.')}`)
  } catch (err: any) {
    console.error('[paypal-toggle] failed:', err?.message || err)
    res.redirect(`${back}?error=${encodeURIComponent(err?.message || 'Failed to toggle PayPal.')}`)
  }
}

export async function postPaypalAccountDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const back = `${base}/settings/payments`
  const paymentId = String(req.params.id || '').trim()

  if (!paymentId) {
    res.redirect(`${back}?error=${encodeURIComponent('Missing payment id.')}`)
    return
  }

  try {
    const payCtx = createPaymentApiCtx(req)
    await deletePayment(payCtx, paymentId)

    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'paypal_account_deleted',
      title: 'PayPal account deleted',
      message: byActor((req as any).storeUser),
      resourceType: 'payment',
      resourceId: paymentId,
    })

    res.redirect(`${back}?success=${encodeURIComponent('PayPal account deleted.')}`)
  } catch (err: any) {
    console.error('[paypal-account-delete] failed:', err?.message || err)
    res.redirect(`${back}?error=${encodeURIComponent(err?.message || 'Failed to delete PayPal account.')}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PayPal Partner Onboarding (port of D:\gbox\gbox-paypal-partner-master)
// ─────────────────────────────────────────────────────────────────────────

/**
 * GET /settings/payments/paypal/onboard-start
 * Generates a Partner Referral link from PayPal then 302-redirects the seller
 * to PayPal's onboarding flow. After completion PayPal redirects to
 * onboard-callback with merchantIdInPayPal etc.
 */
export async function getPaypalOnboardStart(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  try {
    const callbackUrl = `${req.protocol}://${req.get('host')}${base}/settings/payments/paypal/onboard-callback`
    const link = await createPartnerReferralLink({
      trackingId: store.id,
      returnUrl: callbackUrl,
    }, req)
    res.redirect(link)
  } catch (err: any) {
    console.error('[paypal-onboard-start] failed:', err?.message || err)
    res.redirect(`${base}/settings/payments?error=${encodeURIComponent(`PayPal onboarding init failed: ${err?.message || 'unknown'}`)}`)
  }
}

/**
 * GET /settings/payments/paypal/onboard-callback
 * PayPal redirects here after merchant grants permissions. We persist the
 * received merchantIdInPayPal + status fields to shop_settings so that
 * subsequent payment captures can use the merchant context.
 *
 * Query params from PayPal:
 *  - merchantIdInPayPal     → we save as paypal_merchant_id
 *  - merchantId             → internal tracking_id we sent
 *  - permissionsGranted     → "true"/"false"
 *  - accountStatus          → "BUSINESS_ACCOUNT"/etc
 *  - consentStatus          → "true"/"false"
 *  - productIntentId        → product code
 *  - isEmailConfirmed       → "true"/"false"
 */
export async function getPaypalOnboardCallback(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const merchantId = String(req.query.merchantIdInPayPal || '')
  if (!merchantId) {
    return res.redirect(`${base}/settings/payments?error=${encodeURIComponent('Missing merchant ID from PayPal')}`)
  }

  // Best-effort: fetch live integration info to confirm payments_receivable
  // and capture seller's primary email for description display.
  let primaryEmail: string | null = null
  let paymentsReceivable: boolean | null = null
  try {
    const info = await getMerchantIntegrationInfo(merchantId, req)
    primaryEmail = info?.primary_email || null
    paymentsReceivable = info?.payments_receivable ?? null
  } catch (err: any) {
    console.warn('[paypal-onboard-callback] merchant info fetch failed:', err?.message)
  }

  // Onboarding metadata BE chưa support (account_status, permissions_granted,
  // consent_status, is_email_confirmed, payments_receivable, connected_at).
  // Log warn để BE team biết — xem report be-gaps-260502-1003-payment-settings.md
  console.warn('[paypal-onboard-callback] BE GAP — onboarding metadata not persisted (no Payment.metadata field):', {
    merchant_id: merchantId,
    account_status: req.query.accountStatus,
    permissions_granted: req.query.permissionsGranted,
    consent_status: req.query.consentStatus,
    is_email_confirmed: req.query.isEmailConfirmed,
    payments_receivable: paymentsReceivable,
    primary_email: primaryEmail,
  })

  // Single source of truth: BE Payment Service. Upsert paypal record.
  try {
    const payCtx = createPaymentApiCtx(req)
    const consentGranted = req.query.permissionsGranted === 'true'
    const accountStatus = String(req.query.accountStatus || '')
    await upsertPaymentByGateway(payCtx, 'paypal', {
      name: 'PayPal',
      description: primaryEmail
        ? `PayPal Partner — ${primaryEmail}${paymentsReceivable === false ? ' (payments NOT receivable yet)' : ''}`
        : 'PayPal Partner — accepts PayPal, Venmo, credit/debit cards, Pay Later',
      paygate: 'paypal',
      public_key: merchantId,
      private_key: null,
      active: consentGranted && accountStatus !== 'BUSINESS_ACCOUNT_LOCKED' && paymentsReceivable !== false,
      live: !((process.env.PAYPAL_API_BASE || '').includes('sandbox')),
    })
  } catch (err: any) {
    console.error('[paypal-onboard-callback] BE Payment-Service upsert failed:', err?.message)
    return res.redirect(`${base}/settings/payments?error=${encodeURIComponent('Failed to register PayPal in Payment Service: ' + (err?.message || 'unknown'))}`)
  }

  res.redirect(`${base}/settings/payments?success=${encodeURIComponent('PayPal account connected')}`)
}
