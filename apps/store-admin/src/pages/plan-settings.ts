/**
 * Store Admin — Plan & Billing (Full Shopify Parity)
 *
 * Shows current plan, usage stats, billing history, and available plans.
 * Handles plan upgrades/downgrades, cancellation, and billing cycle display.
 *
 * Reads from:
 *   - shops table (plan column)
 *   - shop_settings (billing_history, plan_limits, etc.)
 *   - products, orders, customers (usage counts)
 *   - files (storage usage)
 *
 * POST /settings/plan           — change plan
 * POST /settings/plan/cancel    — cancel/pause plan
 * POST /settings/plan/reactivate — reactivate after cancellation
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { notify, byActor } from '../lib/notify.js'

// Plan page uses its own CSRF store to avoid conflicts with the server-level
// middleware (which is skipped for /settings/plan/* routes).
const planCsrf = createCsrfStore({ cookieName: 'gbox_csrf_plan' })

/**
 * Safely parse a shop_settings value. The `value` column is jsonb,
 * so Kysely may return an already-parsed object OR a JSON string
 * depending on the driver. This helper handles both cases.
 */
function parseSettingsValue<T = any>(val: unknown): T {
  if (val == null) return null as T
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T } catch { return val as T }
  }
  return val as T // already parsed by Kysely/pg driver
}

// ---------------------------------------------------------------------------
// Plan definitions — mirrors Shopify's tiered pricing
// ---------------------------------------------------------------------------

interface PlanDef {
  id: string
  name: string
  priceCents: number          // monthly in cents (0 = free)
  priceDisplay: string        // "$29/mo"
  annualPriceCents: number    // yearly in cents (save ~20%)
  annualDisplay: string       // "$24/mo billed annually"
  trialDays: number
  transactionFee: string      // "2%"
  staffAccounts: number       // max staff
  productLimit: number | null // null = unlimited
  storageLimitMb: number      // file storage
  shippingDiscount: string    // "up to 64%"
  features: string[]
  badge: string               // "Popular", "Best value", etc.
  highlight: boolean
}

const PLANS: PlanDef[] = [
  {
    id: 'free',
    name: 'Starter',
    priceCents: 0,
    priceDisplay: '$0',
    annualPriceCents: 0,
    annualDisplay: 'Free forever',
    trialDays: 0,
    transactionFee: '5%',
    staffAccounts: 1,
    productLimit: 10,
    storageLimitMb: 100,
    shippingDiscount: '—',
    features: [
      'Up to 10 products',
      '1 staff account',
      'Basic storefront',
      'Manual payments',
      'Community support',
    ],
    badge: '',
    highlight: false,
  },
  {
    id: 'basic',
    name: 'Basic',
    priceCents: 2900,
    priceDisplay: '$29',
    annualPriceCents: 2400,
    annualDisplay: '$24/mo billed annually',
    trialDays: 14,
    transactionFee: '2%',
    staffAccounts: 2,
    productLimit: null,
    storageLimitMb: 1024,
    shippingDiscount: 'up to 64%',
    features: [
      'Unlimited products',
      '2 staff accounts',
      'Discount codes',
      'Abandoned cart recovery',
      '64% shipping discount',
      'SSL certificate',
      '24/7 email support',
    ],
    badge: '',
    highlight: false,
  },
  {
    id: 'pro',
    name: 'Shopify / Pro',
    priceCents: 7900,
    priceDisplay: '$79',
    annualPriceCents: 6600,
    annualDisplay: '$66/mo billed annually',
    trialDays: 14,
    transactionFee: '1%',
    staffAccounts: 5,
    productLimit: null,
    storageLimitMb: 5120,
    shippingDiscount: 'up to 72%',
    features: [
      'Everything in Basic',
      '5 staff accounts',
      'Professional reports',
      'Gift cards',
      'International pricing',
      'Ecommerce automations',
      '72% shipping discount',
      'Priority support',
    ],
    badge: 'Most Popular',
    highlight: true,
  },
  {
    id: 'advanced',
    name: 'Advanced',
    priceCents: 29900,
    priceDisplay: '$299',
    annualPriceCents: 24900,
    annualDisplay: '$249/mo billed annually',
    trialDays: 14,
    transactionFee: '0.5%',
    staffAccounts: 15,
    productLimit: null,
    storageLimitMb: 25600,
    shippingDiscount: 'up to 74%',
    features: [
      'Everything in Pro',
      '15 staff accounts',
      'Advanced report builder',
      'Third-party calculated shipping',
      'Custom automations',
      '74% shipping discount',
      'Dedicated support rep',
    ],
    badge: '',
    highlight: false,
  },
  {
    id: 'enterprise',
    name: 'Plus / Enterprise',
    priceCents: 0, // custom pricing
    priceDisplay: 'Custom',
    annualPriceCents: 0,
    annualDisplay: 'Custom pricing',
    trialDays: 0,
    transactionFee: 'Negotiable',
    staffAccounts: -1, // unlimited
    productLimit: null,
    storageLimitMb: -1,
    shippingDiscount: 'up to 76%',
    features: [
      'Everything in Advanced',
      'Unlimited staff accounts',
      'Custom integrations & API',
      'SLA guarantee (99.99%)',
      'Dedicated account manager',
      'Wholesale / B2B channels',
      'Custom checkout scripts',
      'Volume pricing negotiation',
    ],
    badge: 'Enterprise',
    highlight: false,
  },
]

// ---------------------------------------------------------------------------
// Feature comparison matrix (for the comparison table)
// ---------------------------------------------------------------------------

interface FeatureRow {
  category: string
  feature: string
  values: Record<string, string | boolean>
}

const FEATURE_MATRIX: FeatureRow[] = [
  { category: 'Products', feature: 'Product listings', values: { free: '10', basic: 'Unlimited', pro: 'Unlimited', advanced: 'Unlimited', enterprise: 'Unlimited' } },
  { category: 'Products', feature: 'Product variants', values: { free: '3', basic: '100', pro: '100', advanced: '100', enterprise: 'Unlimited' } },
  { category: 'Products', feature: 'Inventory locations', values: { free: '1', basic: '4', pro: '5', advanced: '8', enterprise: 'Unlimited' } },
  { category: 'Staff', feature: 'Staff accounts', values: { free: '1', basic: '2', pro: '5', advanced: '15', enterprise: 'Unlimited' } },
  { category: 'Reports', feature: 'Analytics dashboard', values: { free: true, basic: true, pro: true, advanced: true, enterprise: true } },
  { category: 'Reports', feature: 'Professional reports', values: { free: false, basic: false, pro: true, advanced: true, enterprise: true } },
  { category: 'Reports', feature: 'Custom report builder', values: { free: false, basic: false, pro: false, advanced: true, enterprise: true } },
  { category: 'Marketing', feature: 'Discount codes', values: { free: false, basic: true, pro: true, advanced: true, enterprise: true } },
  { category: 'Marketing', feature: 'Gift cards', values: { free: false, basic: false, pro: true, advanced: true, enterprise: true } },
  { category: 'Marketing', feature: 'Abandoned cart recovery', values: { free: false, basic: true, pro: true, advanced: true, enterprise: true } },
  { category: 'Marketing', feature: 'Automations', values: { free: false, basic: false, pro: true, advanced: true, enterprise: true } },
  { category: 'Shipping', feature: 'Shipping discount', values: { free: '—', basic: '64%', pro: '72%', advanced: '74%', enterprise: '76%' } },
  { category: 'Shipping', feature: 'Calculated rates', values: { free: false, basic: false, pro: false, advanced: true, enterprise: true } },
  { category: 'International', feature: 'International pricing', values: { free: false, basic: false, pro: true, advanced: true, enterprise: true } },
  { category: 'International', feature: 'Markets', values: { free: '1', basic: '3', pro: '5', advanced: 'Unlimited', enterprise: 'Unlimited' } },
  { category: 'Support', feature: 'Email support', values: { free: false, basic: true, pro: true, advanced: true, enterprise: true } },
  { category: 'Support', feature: 'Priority support', values: { free: false, basic: false, pro: true, advanced: true, enterprise: true } },
  { category: 'Support', feature: 'Dedicated rep', values: { free: false, basic: false, pro: false, advanced: true, enterprise: true } },
  { category: 'Platform', feature: 'Transaction fee', values: { free: '5%', basic: '2%', pro: '1%', advanced: '0.5%', enterprise: 'Custom' } },
  { category: 'Platform', feature: 'Storage', values: { free: '100 MB', basic: '1 GB', pro: '5 GB', advanced: '25 GB', enterprise: 'Unlimited' } },
  { category: 'Platform', feature: 'SSL certificate', values: { free: true, basic: true, pro: true, advanced: true, enterprise: true } },
  { category: 'Platform', feature: 'Custom domain', values: { free: false, basic: true, pro: true, advanced: true, enterprise: true } },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPlanDef(planId: string): PlanDef {
  return PLANS.find(p => p.id === planId) || PLANS[0]
}

function formatCents(cents: number): string {
  if (cents === 0) return '$0'
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  const dt = typeof d === 'string' ? new Date(d) : d
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatBytes(mb: number): string {
  if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Billing history type
// ---------------------------------------------------------------------------

interface BillingEntry {
  date: string
  description: string
  amount: number // cents
  status: 'paid' | 'pending' | 'failed' | 'refunded'
}

// ---------------------------------------------------------------------------
// GET /settings/plan — Full plan management page
// ---------------------------------------------------------------------------

export async function getPlanSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  try {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const isProduction = process.env.NODE_ENV === 'production'
  const csrfToken = await planCsrf.issue(res, isProduction)
  const csrfField = csrfHiddenField(csrfToken)

  const currentPlanId = (store as any).plan || 'free'
  const currentPlan = getPlanDef(currentPlanId)

  // Success/error flash
  const flash = typeof req.query.msg === 'string' ? req.query.msg : ''
  const flashErr = typeof req.query.err === 'string' ? req.query.err : ''

  // API mode: usage stats + plan_meta + billing_history chưa có endpoint
  // riêng. Dùng default 0/empty để page render được, chờ BE expose API.
  const productCount = { c: 0 }
  const orderCount = { c: 0 }
  const customerCount = { c: 0 }
  const staffCount = { c: 0 }
  const fileStats = { totalBytes: 0, fileCount: 0 }

  const planRequests: any[] = []
  const pendingRequest: any = null
  const rejectedRequest: any = null

  const billingHistory: BillingEntry[] = []

  const planMeta: {
    billing_cycle: 'monthly' | 'annual'
    trial_ends_at: string | null
    plan_started_at: string | null
    next_billing_date: string | null
    cancelled_at: string | null
    cancel_reason: string | null
  } = {
    billing_cycle: 'monthly',
    trial_ends_at: null,
    plan_started_at: (store as any).created_at || null,
    next_billing_date: null,
    cancelled_at: null,
    cancel_reason: null,
  }

  const isOnTrial = planMeta.trial_ends_at && new Date(planMeta.trial_ends_at) > new Date()
  const trialDaysLeft = isOnTrial
    ? Math.ceil((new Date(planMeta.trial_ends_at!).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0
  const isCancelled = !!planMeta.cancelled_at
  const billingCycle = planMeta.billing_cycle || 'monthly'

  // Calculate usage percentages
  const products = Number(productCount.c)
  const productLimit = currentPlan.productLimit
  const productPct = productLimit ? Math.min(100, Math.round((products / productLimit) * 100)) : 0
  const staff = Number(staffCount.c)
  const staffLimit = currentPlan.staffAccounts
  const staffPct = staffLimit > 0 ? Math.min(100, Math.round((staff / staffLimit) * 100)) : 0
  const storageUsedMb = Number((fileStats as any)?.totalBytes || 0) / (1024 * 1024)
  const storageLimitMb = currentPlan.storageLimitMb
  const storagePct = storageLimitMb > 0 ? Math.min(100, Math.round((storageUsedMb / storageLimitMb) * 100)) : 0

  // ---------------------------------------------------------------------------
  // Build HTML
  // ---------------------------------------------------------------------------

  const content = `
    <style>
      /* Plan page redesign — Shopify-style polish, less inline noise. */
      .plan-back { color: var(--s-text-dim); text-decoration: none; font-size: 13px; display: inline-flex; align-items: center; gap: 4px; margin-bottom: 8px; }
      .plan-back:hover { color: var(--s-accent); }

      /* Current plan hero — prominent gradient card */
      .plan-hero {
        background: linear-gradient(135deg, rgba(99,102,241,.12) 0%, rgba(99,102,241,.04) 50%, transparent 100%);
        border: 1px solid var(--s-border);
        border-radius: 14px;
        padding: 28px 28px;
        margin-bottom: 24px;
        position: relative;
        overflow: hidden;
      }
      .plan-hero::before {
        content: ''; position: absolute; top: -40px; right: -40px;
        width: 180px; height: 180px; border-radius: 50%;
        background: radial-gradient(circle, rgba(99,102,241,.15), transparent 70%);
        pointer-events: none;
      }
      .plan-hero-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; flex-wrap: wrap; position: relative; }
      .plan-hero-name { font-size: 13px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--s-accent); font-weight: 600; margin-bottom: 6px; }
      .plan-hero-title { font-size: 32px; font-weight: 800; color: var(--s-text); margin: 0 0 4px; line-height: 1.1; }
      .plan-hero-price { font-size: 18px; color: var(--s-text-muted); font-weight: 500; }
      .plan-hero-meta { display: flex; gap: 28px; flex-wrap: wrap; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--s-border); }
      .plan-hero-cell { min-width: 110px; }
      .plan-hero-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: var(--s-text-dim); margin-bottom: 4px; font-weight: 600; }
      .plan-hero-value { font-size: 14px; font-weight: 600; color: var(--s-text); }
      .plan-hero-badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
      .plan-hero-badge.trial { background: rgba(245,158,11,.15); color: #f59e0b; }
      .plan-hero-badge.cancelled { background: rgba(239,68,68,.15); color: #ef4444; }
      .plan-hero-badge.active { background: rgba(34,197,94,.15); color: #22c55e; }

      /* Section header */
      .plan-section-h { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: var(--s-text-dim); margin: 24px 0 12px; display: flex; align-items: center; justify-content: space-between; }

      /* Plan tier cards */
      .plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
      .plan-tier {
        position: relative;
        background: var(--s-card);
        border: 1.5px solid var(--s-border);
        border-radius: 14px;
        padding: 22px 20px;
        display: flex;
        flex-direction: column;
        text-align: center;
        transition: border-color .15s, box-shadow .15s, transform .15s;
      }
      .plan-tier:hover:not(.current) { border-color: var(--s-accent-muted, #818cf8); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(99,102,241,.12); }
      .plan-tier.current {
        border-color: var(--s-accent);
        box-shadow: 0 0 0 1px var(--s-accent), 0 8px 24px rgba(99,102,241,.18);
        background: linear-gradient(180deg, rgba(99,102,241,.06), transparent 60%);
      }
      .plan-tier.highlight { border-color: var(--s-accent-muted, #818cf8); }
      .plan-tier-badge { position: absolute; top: -10px; right: 16px; padding: 3px 10px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
      .plan-tier-badge.popular { background: linear-gradient(180deg, #6366f1, #4f46e5); color: #fff; }
      .plan-tier-badge.current-tag { background: #22c55e; color: #fff; }
      .plan-tier-name { font-size: 18px; font-weight: 700; color: var(--s-text); margin-bottom: 6px; }
      .plan-tier-price { font-size: 30px; font-weight: 800; color: var(--s-text); line-height: 1; }
      .plan-tier-price-suffix { font-size: 13px; color: var(--s-text-dim); font-weight: 500; }
      .plan-tier-save { display: inline-block; margin-top: 4px; font-size: 11px; color: #22c55e; font-weight: 600; }
      .plan-tier-fee { font-size: 11.5px; color: var(--s-text-dim); margin: 8px 0 14px; font-weight: 500; }
      .plan-tier-features { list-style: none; padding: 0; margin: 0 0 18px; flex: 1; display: flex; flex-direction: column; gap: 6px; }
      .plan-tier-feat { font-size: 12.5px; color: var(--s-text-muted); display: flex; align-items: flex-start; justify-content: center; gap: 7px; line-height: 1.4; text-align: left; }
      .plan-tier-feat svg { flex-shrink: 0; margin-top: 2px; }
      .plan-tier-cta { width: 100%; }

      /* Usage bars */
      .plan-usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 22px; }
      .plan-usage-row { }
      .plan-usage-head { display: flex; justify-content: space-between; margin-bottom: 6px; }
      .plan-usage-label { font-size: 12px; font-weight: 600; color: var(--s-text-muted); }
      .plan-usage-val { font-size: 12px; color: var(--s-text-dim); font-variant-numeric: tabular-nums; }
      .plan-usage-bar { background: var(--s-border); border-radius: 999px; height: 6px; overflow: hidden; }
      .plan-usage-fill { height: 100%; border-radius: 999px; transition: width .3s; }

      /* Billing toggle pill */
      .plan-billing-toggle { display: inline-flex; padding: 4px; background: var(--s-card-hover, rgba(0,0,0,.04)); border-radius: 999px; gap: 2px; }
      .plan-billing-toggle label { padding: 5px 14px; border-radius: 999px; font-size: 12px; cursor: pointer; color: var(--s-text-dim); transition: .15s; display: flex; align-items: center; gap: 4px; }
      .plan-billing-toggle label:has(input:checked) { background: var(--s-card); color: var(--s-text); box-shadow: 0 1px 2px rgba(0,0,0,.06); font-weight: 600; }
      .plan-billing-toggle input { display: none; }

      @media (max-width: 720px) {
        .plan-hero { padding: 22px 18px; }
        .plan-hero-title { font-size: 26px; }
        .plan-hero-meta { gap: 18px; }
      }
    </style>

    <div class="page-header" style="margin-bottom:20px">
      <div>
        <a href="${base}/settings" class="plan-back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          Settings
        </a>
        <h1 class="page-title">Plan &amp; Billing</h1>
        <p class="page-subtitle">Quản lý gói đăng ký, mức sử dụng và lịch sử thanh toán</p>
      </div>
    </div>

    ${flash ? `<div class="alert alert-success" style="margin-bottom:16px;padding:12px 16px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:8px;color:#22c55e;font-size:13px">${esc(flash)}</div>` : ''}
    ${flashErr ? `<div class="alert alert-error" style="margin-bottom:16px;padding:12px 16px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;color:#ef4444;font-size:13px">${esc(flashErr)}</div>` : ''}

    ${pendingRequest ? `
    <!-- PENDING REQUEST BANNER -->
    <div style="margin-bottom:20px;padding:16px 20px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:10px;display:flex;align-items:center;gap:12px">
      <div style="font-size:24px">&#9203;</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:700;color:#f59e0b">Plan Change Request Pending</div>
        <div style="font-size:12px;color:var(--s-text-dim);margin-top:2px">
          ${esc(getPlanDef(pendingRequest.current_plan).name)} &#8594; <strong>${esc(getPlanDef(pendingRequest.requested_plan).name)}</strong>
          (${esc(pendingRequest.billing_cycle)}) &mdash; submitted ${formatDate(pendingRequest.requested_at)}.
          Awaiting admin approval.
        </div>
      </div>
    </div>
    ` : ''}

    ${rejectedRequest ? `
    <!-- REJECTED REQUEST BANNER -->
    <div style="margin-bottom:20px;padding:16px 20px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:10px;display:flex;align-items:center;gap:12px">
      <div style="font-size:24px">&#10060;</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:700;color:#ef4444">Previous Request Rejected</div>
        <div style="font-size:12px;color:var(--s-text-dim);margin-top:2px">
          Your request to change to <strong>${esc(getPlanDef(rejectedRequest.requested_plan).name)}</strong> was rejected
          ${rejectedRequest.rejection_reason ? `&mdash; <em>${esc(rejectedRequest.rejection_reason)}</em>` : ''}.
          You can submit a new request.
        </div>
      </div>
    </div>
    ` : ''}

    <!-- ================================================================== -->
    <!-- CURRENT PLAN HERO                                                   -->
    <!-- ================================================================== -->
    <div class="plan-hero">
      <div class="plan-hero-row">
        <div>
          <div class="plan-hero-name">Current plan</div>
          <h2 class="plan-hero-title">${esc(currentPlan.name)}</h2>
          <div class="plan-hero-price">
            ${currentPlan.priceCents === 0 ? 'Free forever' : (billingCycle === 'annual' ? esc(currentPlan.annualDisplay) : `${esc(currentPlan.priceDisplay)}/month`)}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start">
          ${isOnTrial ? `<span class="plan-hero-badge trial">⏱ Trial · ${trialDaysLeft} days left</span>` : ''}
          ${isCancelled
            ? `<span class="plan-hero-badge cancelled">● Cancelled</span>`
            : `<span class="plan-hero-badge active">● ${esc((store as any).status || 'active').toString().charAt(0).toUpperCase()}${esc((store as any).status || 'active').toString().slice(1)}</span>`}
        </div>
      </div>

      <div class="plan-hero-meta">
        <div class="plan-hero-cell">
          <div class="plan-hero-label">Billing cycle</div>
          <div class="plan-hero-value" style="text-transform:capitalize">${billingCycle}</div>
        </div>
        <div class="plan-hero-cell">
          <div class="plan-hero-label">Transaction fee</div>
          <div class="plan-hero-value">${esc(currentPlan.transactionFee)}</div>
        </div>
        <div class="plan-hero-cell">
          <div class="plan-hero-label">Next billing</div>
          <div class="plan-hero-value">${formatDate(planMeta.next_billing_date || null)}</div>
        </div>
        <div class="plan-hero-cell">
          <div class="plan-hero-label">Staff allowance</div>
          <div class="plan-hero-value">${currentPlan.staffAccounts > 0 ? `${currentPlan.staffAccounts} accounts` : 'Unlimited'}</div>
        </div>
      </div>

      ${isCancelled ? `
      <div style="margin-top:16px;padding:12px 16px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.25);border-radius:10px">
        <div style="font-size:13px;color:#ef4444;font-weight:600">Plan cancelled on ${formatDate(planMeta.cancelled_at || null)}</div>
        ${planMeta.cancel_reason ? `<div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">Reason: ${esc(planMeta.cancel_reason)}</div>` : ''}
        <form method="POST" action="${base}/settings/plan/reactivate" style="margin-top:10px">
          ${csrfField}
          <button type="submit" class="btn btn-primary btn-sm">Reactivate plan</button>
        </form>
      </div>
      ` : ''}
    </div>

    <!-- ================================================================== -->
    <!-- USAGE                                                              -->
    <!-- ================================================================== -->
    <div class="plan-section-h">
      <span>Usage <span style="color:var(--s-text-muted);font-weight:400;text-transform:none;letter-spacing:0">— this billing cycle</span></span>
    </div>
    <div class="card" style="margin-bottom:24px">
      <div class="card-body">
        <div class="plan-usage-grid">
          <!-- Products -->
          <div class="plan-usage-row">
            <div class="plan-usage-head">
              <span class="plan-usage-label">Products</span>
              <span class="plan-usage-val">${products}${productLimit ? ` / ${productLimit}` : ' (unlimited)'}</span>
            </div>
            <div class="plan-usage-bar">
              <div class="plan-usage-fill" style="background:${productPct > 80 ? '#ef4444' : productPct > 60 ? '#f59e0b' : 'var(--s-accent)'};width:${productLimit ? productPct : 5}%"></div>
            </div>
          </div>
          <!-- Staff -->
          <div class="plan-usage-row">
            <div class="plan-usage-head">
              <span class="plan-usage-label">Staff accounts</span>
              <span class="plan-usage-val">${staff}${staffLimit > 0 ? ` / ${staffLimit}` : ' (unlimited)'}</span>
            </div>
            <div class="plan-usage-bar">
              <div class="plan-usage-fill" style="background:${staffPct > 80 ? '#ef4444' : staffPct > 60 ? '#f59e0b' : 'var(--s-accent)'};width:${staffLimit > 0 ? staffPct : 5}%"></div>
            </div>
          </div>
          <!-- Storage -->
          <div class="plan-usage-row">
            <div class="plan-usage-head">
              <span class="plan-usage-label">File storage</span>
              <span class="plan-usage-val">${formatBytes(storageUsedMb)}${storageLimitMb > 0 ? ` / ${formatBytes(storageLimitMb)}` : ' (unlimited)'}</span>
            </div>
            <div class="plan-usage-bar">
              <div class="plan-usage-fill" style="background:${storagePct > 80 ? '#ef4444' : storagePct > 60 ? '#f59e0b' : 'var(--s-accent)'};width:${storageLimitMb > 0 ? storagePct : 2}%"></div>
            </div>
          </div>
        </div>

        <!-- Quick stats row -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:16px;margin-top:20px;padding-top:16px;border-top:1px solid var(--s-border)">
          <div style="text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--s-text-primary)">${Number(orderCount.c)}</div>
            <div style="font-size:11px;color:var(--s-text-dim);text-transform:uppercase;letter-spacing:.5px">Total Orders</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--s-text-primary)">${Number(customerCount.c)}</div>
            <div style="font-size:11px;color:var(--s-text-dim);text-transform:uppercase;letter-spacing:.5px">Customers</div>
          </div>
          <div style="text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--s-text-primary)">${Number((fileStats as any)?.fileCount || 0)}</div>
            <div style="font-size:11px;color:var(--s-text-dim);text-transform:uppercase;letter-spacing:.5px">Files</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================================================================== -->
    <!-- AVAILABLE PLANS                                                     -->
    <!-- ================================================================== -->
    <div class="plan-section-h">
      <span>Choose your plan</span>
      <div class="plan-billing-toggle">
        <label><input type="radio" name="billing_toggle" value="monthly" ${billingCycle === 'monthly' ? 'checked' : ''} onchange="toggleBilling('monthly')"> Monthly</label>
        <label><input type="radio" name="billing_toggle" value="annual" ${billingCycle === 'annual' ? 'checked' : ''} onchange="toggleBilling('annual')"> Annual <span style="color:#22c55e;font-weight:600;font-size:11px">−20%</span></label>
      </div>
    </div>
    <div class="plan-grid" style="margin-bottom:28px">
      ${PLANS.map(p => {
        const isCurrent = currentPlanId === p.id
        const isUpgrade = PLANS.indexOf(p) > PLANS.findIndex(x => x.id === currentPlanId)
        const isDowngrade = PLANS.indexOf(p) < PLANS.findIndex(x => x.id === currentPlanId)
        const isEnterprise = p.id === 'enterprise'
        const tierCls = ['plan-tier', isCurrent && 'current', !isCurrent && p.highlight && 'highlight'].filter(Boolean).join(' ')
        return `
        <div class="${tierCls}">
          ${isCurrent
            ? '<span class="plan-tier-badge current-tag">✓ Current</span>'
            : p.badge ? `<span class="plan-tier-badge popular">${esc(p.badge)}</span>` : ''}

          <div class="plan-tier-name">${esc(p.name)}</div>
          <div>
            <span class="plan-price-monthly plan-tier-price"${billingCycle === 'annual' ? ' style="display:none"' : ''}>${esc(p.priceDisplay)}</span>
            <span class="plan-price-annual plan-tier-price"${billingCycle === 'monthly' ? ' style="display:none"' : ''}>${p.annualPriceCents > 0 ? esc(formatCents(p.annualPriceCents)) : esc(p.priceDisplay)}</span>
            ${p.priceCents > 0 ? '<span class="plan-tier-price-suffix"> /mo</span>' : ''}
          </div>
          ${p.priceCents > 0 && p.annualPriceCents > 0 && p.annualPriceCents < p.priceCents ? `
            <span class="plan-price-annual plan-tier-save"${billingCycle === 'monthly' ? ' style="display:none"' : ''}>Save ${esc(formatCents((p.priceCents - p.annualPriceCents) * 12))}/year</span>
          ` : ''}

          <div class="plan-tier-fee">${esc(p.transactionFee)} transaction fee</div>

          <ul class="plan-tier-features">
            ${p.features.map(f => `
              <li class="plan-tier-feat">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                ${esc(f)}
              </li>
            `).join('')}
          </ul>

          ${isCurrent
            ? `<button class="btn btn-outline btn-sm plan-tier-cta" disabled>Current plan</button>`
            : isEnterprise
              ? `<a href="mailto:sales@gbox.co?subject=Enterprise Plan Inquiry - ${esc(store.name)}" class="btn btn-outline btn-sm plan-tier-cta" style="text-align:center;text-decoration:none">Contact sales</a>`
              : pendingRequest
                ? `<button class="btn btn-outline btn-sm plan-tier-cta" disabled>Request pending…</button>`
                : `<form method="POST" action="${base}/settings/plan" style="margin:0">
                    ${csrfField}
                    <input type="hidden" name="plan" value="${esc(p.id)}">
                    <input type="hidden" name="billing_cycle" value="${billingCycle}">
                    <button type="submit" class="btn ${isUpgrade ? 'btn-primary' : 'btn-outline'} btn-sm plan-tier-cta" onclick="return confirm('Request ${isDowngrade ? 'downgrade' : 'upgrade'} to ${esc(p.name)}? Sent to platform admin for approval.')">
                      ${isUpgrade ? 'Upgrade' : 'Downgrade'} to ${esc(p.name)}
                    </button>
                  </form>`
          }
        </div>`
      }).join('')}
    </div>

    <!-- ================================================================== -->
    <!-- FEATURE COMPARISON TABLE                                            -->
    <!-- ================================================================== -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header" style="cursor:pointer" onclick="document.getElementById('featureTable').style.display = document.getElementById('featureTable').style.display === 'none' ? '' : 'none'; this.querySelector('.toggle-icon').textContent = document.getElementById('featureTable').style.display === 'none' ? '+' : '-'">
        <span>Feature Comparison</span>
        <span class="toggle-icon" style="font-size:18px;font-weight:bold;color:var(--s-text-dim)">+</span>
      </div>
      <div id="featureTable" style="display:none;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:2px solid var(--s-border)">
              <th style="text-align:left;padding:10px 16px;color:var(--s-text-dim);font-weight:600">Feature</th>
              ${PLANS.filter(p => p.id !== 'enterprise').map(p => `
                <th style="text-align:center;padding:10px 12px;color:var(--s-text-dim);font-weight:600;${currentPlanId === p.id ? 'background:rgba(99,102,241,.06)' : ''}">${esc(p.name)}</th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            ${(() => {
              let lastCat = ''
              return FEATURE_MATRIX.map(row => {
                const catHeader = row.category !== lastCat
                  ? `<tr><td colspan="${PLANS.length}" style="padding:10px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--s-accent);background:var(--s-bg);border-top:1px solid var(--s-border)">${esc(row.category)}</td></tr>`
                  : ''
                lastCat = row.category
                return `${catHeader}
                  <tr style="border-bottom:1px solid var(--s-border)">
                    <td style="padding:8px 16px;color:var(--s-text-muted)">${esc(row.feature)}</td>
                    ${PLANS.filter(p => p.id !== 'enterprise').map(p => {
                      const v = row.values[p.id]
                      const cell = typeof v === 'boolean'
                        ? (v ? '<span style="color:#22c55e">&#10003;</span>' : '<span style="color:var(--s-text-dim)">&mdash;</span>')
                        : `<span style="color:var(--s-text-primary);font-weight:500">${esc(String(v))}</span>`
                      return `<td style="text-align:center;padding:8px 12px;${currentPlanId === p.id ? 'background:rgba(99,102,241,.04)' : ''}">${cell}</td>`
                    }).join('')}
                  </tr>`
              }).join('')
            })()}
          </tbody>
        </table>
      </div>
    </div>

    <!-- ================================================================== -->
    <!-- BILLING HISTORY                                                     -->
    <!-- ================================================================== -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span>Billing History</span>
      </div>
      <div class="card-body" style="padding:0">
        ${billingHistory.length > 0 ? `
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="border-bottom:1px solid var(--s-border)">
                <th style="text-align:left;padding:10px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase">Date</th>
                <th style="text-align:left;padding:10px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase">Description</th>
                <th style="text-align:right;padding:10px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase">Amount</th>
                <th style="text-align:center;padding:10px 16px;font-weight:600;color:var(--s-text-dim);font-size:11px;text-transform:uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              ${billingHistory.map(entry => `
                <tr style="border-bottom:1px solid var(--s-border)">
                  <td style="padding:10px 16px;color:var(--s-text-muted)">${formatDate(entry.date)}</td>
                  <td style="padding:10px 16px;color:var(--s-text-primary)">${esc(entry.description)}</td>
                  <td style="padding:10px 16px;text-align:right;font-weight:600;color:var(--s-text-primary)">${formatCents(entry.amount)}</td>
                  <td style="padding:10px 16px;text-align:center">
                    <span class="badge ${entry.status === 'paid' ? 'badge-success' : entry.status === 'failed' ? 'badge-error' : entry.status === 'refunded' ? 'badge-warning' : 'badge-neutral'}" style="font-size:11px">${esc(entry.status)}</span>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : `
          <div style="padding:40px;text-align:center;color:var(--s-text-dim)">
            <div style="font-size:32px;margin-bottom:8px">&#128203;</div>
            <div style="font-size:14px;font-weight:600;margin-bottom:4px">No billing history</div>
            <div style="font-size:12px">Invoices will appear here when your plan generates charges.</div>
          </div>
        `}
      </div>
    </div>

    <!-- ================================================================== -->
    <!-- PLAN MANAGEMENT ACTIONS                                             -->
    <!-- ================================================================== -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">Plan Management</div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <!-- Change billing cycle -->
          <div style="padding:16px;border:1px solid var(--s-border);border-radius:8px">
            <div style="font-size:14px;font-weight:700;margin-bottom:4px;color:var(--s-text-primary)">Billing Cycle</div>
            <div style="font-size:12px;color:var(--s-text-dim);margin-bottom:12px">
              Currently billed <strong>${billingCycle}</strong>.
              ${billingCycle === 'monthly' && currentPlan.annualPriceCents > 0 ? `Switch to annual and save ${formatCents((currentPlan.priceCents - currentPlan.annualPriceCents) * 12)}/year.` : ''}
            </div>
            <form method="POST" action="${base}/settings/plan" style="margin:0">
              ${csrfField}
              <input type="hidden" name="plan" value="${esc(currentPlanId)}">
              <input type="hidden" name="billing_cycle" value="${billingCycle === 'monthly' ? 'annual' : 'monthly'}">
              <button type="submit" class="btn btn-outline btn-sm" ${currentPlan.priceCents === 0 ? 'disabled' : ''}>
                Switch to ${billingCycle === 'monthly' ? 'Annual' : 'Monthly'}
              </button>
            </form>
          </div>

          <!-- Cancel plan -->
          <div style="padding:16px;border:1px solid ${isCancelled ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.2)'};border-radius:8px">
            <div style="font-size:14px;font-weight:700;margin-bottom:4px;color:var(--s-text-primary)">
              ${isCancelled ? 'Reactivate Plan' : 'Cancel Plan'}
            </div>
            <div style="font-size:12px;color:var(--s-text-dim);margin-bottom:12px">
              ${isCancelled
                ? 'Your plan is cancelled. Reactivate to restore all features.'
                : 'Cancel your subscription. Your store will remain active until the end of the current billing period.'
              }
            </div>
            ${isCancelled ? `
              <form method="POST" action="${base}/settings/plan/reactivate" style="margin:0">
                ${csrfField}
                <button type="submit" class="btn btn-primary btn-sm">Reactivate Plan</button>
              </form>
            ` : `
              <form method="POST" action="${base}/settings/plan/cancel" style="margin:0" onsubmit="return confirm('Are you sure you want to cancel your plan? Your store will continue working until the end of the current billing period.')">
                ${csrfField}
                <select name="reason" style="width:100%;padding:6px 10px;border:1px solid var(--s-border);border-radius:6px;font-size:12px;background:var(--s-bg);color:var(--s-text-primary);margin-bottom:8px">
                  <option value="">Select a reason (optional)</option>
                  <option value="too_expensive">Too expensive</option>
                  <option value="not_enough_features">Not enough features</option>
                  <option value="switching_platforms">Switching to another platform</option>
                  <option value="closing_business">Closing my business</option>
                  <option value="temporary_pause">Temporary pause</option>
                  <option value="other">Other</option>
                </select>
                <button type="submit" class="btn btn-sm" style="background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.3)" ${currentPlanId === 'free' ? 'disabled' : ''}>
                  Cancel Plan
                </button>
              </form>
            `}
          </div>
        </div>
      </div>
    </div>

    <!-- ================================================================== -->
    <!-- FAQ                                                                 -->
    <!-- ================================================================== -->
    <div class="card" style="margin-bottom:24px">
      <div class="card-header">Frequently Asked Questions</div>
      <div class="card-body" style="font-size:13px;color:var(--s-text-muted)">
        <details style="margin-bottom:12px;cursor:pointer">
          <summary style="font-weight:600;color:var(--s-text-primary);padding:4px 0">What happens when I upgrade?</summary>
          <p style="margin-top:8px;padding-left:16px">Your plan upgrades immediately. You'll be charged a prorated amount for the remainder of your current billing cycle, then the full amount on your next billing date.</p>
        </details>
        <details style="margin-bottom:12px;cursor:pointer">
          <summary style="font-weight:600;color:var(--s-text-primary);padding:4px 0">What happens when I downgrade?</summary>
          <p style="margin-top:8px;padding-left:16px">Your downgrade takes effect at the end of your current billing cycle. Until then, you'll keep all features of your current plan. If you exceed the new plan's limits, you may need to reduce your usage.</p>
        </details>
        <details style="margin-bottom:12px;cursor:pointer">
          <summary style="font-weight:600;color:var(--s-text-primary);padding:4px 0">Can I cancel anytime?</summary>
          <p style="margin-top:8px;padding-left:16px">Yes. You can cancel your plan at any time. Your store will remain active and fully functional until the end of your current billing period. After that, it will be downgraded to the Starter (free) plan.</p>
        </details>
        <details style="margin-bottom:12px;cursor:pointer">
          <summary style="font-weight:600;color:var(--s-text-primary);padding:4px 0">Do you offer refunds?</summary>
          <p style="margin-top:8px;padding-left:16px">We offer a 14-day free trial for all paid plans. If you're not satisfied after the trial, you can downgrade to the free plan. For annual subscriptions, prorated refunds are available within the first 30 days.</p>
        </details>
        <details style="cursor:pointer">
          <summary style="font-weight:600;color:var(--s-text-primary);padding:4px 0">What payment methods do you accept?</summary>
          <p style="margin-top:8px;padding-left:16px">We accept all major credit cards (Visa, Mastercard, American Express), PayPal, and bank transfers for Enterprise plans.</p>
        </details>
      </div>
    </div>

    <script>
    function toggleBilling(cycle) {
      document.querySelectorAll('.plan-price-monthly').forEach(el => el.style.display = cycle === 'monthly' ? '' : 'none')
      document.querySelectorAll('.plan-price-annual').forEach(el => el.style.display = cycle === 'annual' ? '' : 'none')
    }
    </script>
  `

  res.send(
    sellerLayout({
      title: 'Plan',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'settings',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
  } catch (err: any) {
    console.error('[plan-settings] getPlanSettings error:', err)
    const store = req.store!
    const base = `/admin/store/${store.slug}`
    res.status(500).send(`
      <!DOCTYPE html><html><head><title>Error</title></head>
      <body style="font-family:sans-serif;padding:40px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#ef4444;">Plan Settings Error</h1>
        <p>Something went wrong loading your plan settings.</p>
        <pre style="background:#1e293b;padding:16px;border-radius:8px;overflow-x:auto;color:#fca5a5;">${err.message || String(err)}</pre>
        <a href="${base}/settings" style="color:#3b82f6;">← Back to Settings</a>
      </body></html>
    `)
  }
}

// ---------------------------------------------------------------------------
// POST /settings/plan — Submit plan change REQUEST (for God Admin approval)
// ---------------------------------------------------------------------------
//
// Flow:
//   Merchant clicks Upgrade/Downgrade → request stored in shop_settings
//   as key "plan_change_requests" → God Admin reviews at /god-admin/plan-requests
//   → Approve updates shop.plan + billing, Reject leaves plan unchanged.
//
// Billing cycle changes (same plan) are applied immediately (no approval needed).

// ---------------------------------------------------------------------------
// API mode: plan management (change/cancel/reactivate) chưa có endpoint
// BE riêng. Tạm stub redirect với thông báo "feature unavailable".
// ---------------------------------------------------------------------------

export async function postChangePlan(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/settings/plan`
  res.redirect(`${base}?err=${encodeURIComponent('Plan change is not available in this API version. Please contact Gbox support.')}`)
}

export async function postCancelPlan(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/settings/plan`
  res.redirect(`${base}?err=${encodeURIComponent('Plan cancellation is not available in this API version. Please contact Gbox support.')}`)
}

export async function postReactivatePlan(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/settings/plan`
  res.redirect(`${base}?err=${encodeURIComponent('Plan reactivation is not available in this API version. Please contact Gbox support.')}`)
}
