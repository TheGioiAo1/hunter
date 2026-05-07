/**
 * PayPal multi-account UI renderers.
 *
 * Tách khỏi payment-settings.ts (đã 1050 LOC) — chỉ chứa render functions
 * cho list of saved PayPal accounts + add form. Logic single-active enforcement
 * sống ở payment-api-client.setActivePayment.
 *
 * Constraint: tối đa 5 PayPal records/shop, single-active (FE-enforced).
 */

import { esc } from '../layouts/seller-layout.js'
import type { BePayment } from '../lib/payment-api-client.js'

const INPUT_STYLE =
  'width:100%;padding:10px 14px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)'
const LABEL_STYLE =
  'display:block;font-size:12px;font-weight:600;margin-bottom:6px;color:var(--s-text-dim)'

function mask(val: string): string {
  if (!val || val.length <= 4) return val ? '****' : ''
  return val.slice(0, 4) + '*'.repeat(Math.max(4, val.length - 8)) + val.slice(-4)
}

/**
 * Render 1 account card với badges (Live/Sandbox + Active) + actions
 * (Set Active / Delete). Active card có border xanh + bg highlight.
 */
function renderAccountCard(base: string, acc: BePayment, csrfField: string): string {
  const id = String(acc.id ?? '')
  const isLive = acc.live === true
  const isActive = acc.active === true
  const label = (acc.name && acc.name.trim()) || (isLive ? 'PayPal Live' : 'PayPal Sandbox')
  const description = acc.description || ''
  const clientIdMasked = mask(String(acc.public_key || ''))

  const liveBadgeStyle = isLive
    ? 'background:rgba(16,185,129,.15);color:#10b981'
    : 'background:rgba(245,158,11,.15);color:#f59e0b'

  return `
    <div style="border:1px solid ${isActive ? '#10b981' : 'var(--s-border)'};border-radius:8px;padding:14px;background:${isActive ? 'rgba(16,185,129,.04)' : 'transparent'}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span style="font-weight:600;font-size:13px;color:var(--s-text)">${esc(label)}</span>
        <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.4px;${liveBadgeStyle}">${isLive ? 'Live' : 'Sandbox'}</span>
        ${isActive ? '<span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.4px;background:rgba(99,102,241,.15);color:#6366f1">● Active</span>' : ''}
      </div>
      <div style="font-size:11px;color:var(--s-text-dim);margin-bottom:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all">
        Client ID: ${esc(clientIdMasked)}${description ? ` &middot; <span style="font-family:inherit">${esc(description)}</span>` : ''}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${!isActive ? `
          <form method="POST" action="${base}/settings/payments/paypal-accounts/${esc(id)}/activate" style="display:inline">
            ${csrfField}
            <button type="submit" style="background:var(--s-accent, #6366f1);color:#fff;border:none;padding:6px 14px;font-size:12px;border-radius:6px;cursor:pointer;font-weight:600">Set Active</button>
          </form>
        ` : ''}
        <form method="POST" action="${base}/settings/payments/paypal-accounts/${esc(id)}/delete" style="display:inline" onsubmit="return confirm('${isActive ? 'This is the ACTIVE account. PayPal checkout will stop working until you activate another account. Continue?' : 'Delete this PayPal account?'}')">
          ${csrfField}
          <button type="submit" style="background:transparent;color:#ef4444;border:1px solid #ef4444;padding:6px 14px;font-size:12px;border-radius:6px;cursor:pointer;font-weight:600">Delete</button>
        </form>
      </div>
    </div>
  `
}

// PayPal Developer Dashboard — nơi seller tạo/lấy REST API credentials.
const PAYPAL_DEV_DASHBOARD_LIVE = 'https://developer.paypal.com/dashboard/applications/live'
const PAYPAL_DEV_DASHBOARD_SANDBOX = 'https://developer.paypal.com/dashboard/applications/sandbox'

/**
 * Render Add form — single form, no tabs. Lý do bỏ Connect tab: end-state
 * giống Manual (phải paste credentials), Connect chỉ verify ownership →
 * không đáng UI space. Partner link giữ 1 chỗ duy nhất ở footer của list.
 */
function renderAddForm(base: string, expanded: boolean, csrfField: string, isFirst: boolean): string {
  return `
    <details id="paypal-add-form" ${expanded ? 'open' : ''} style="border:1px solid var(--s-border);border-radius:8px;overflow:hidden;margin-top:14px">
      <summary style="cursor:pointer;padding:12px 16px;font-size:13px;font-weight:600;background:rgba(99,102,241,.04);list-style:none;display:flex;align-items:center;gap:8px">
        <span style="font-size:18px;line-height:1;color:var(--s-accent, #6366f1)">+</span>
        Add new PayPal account
      </summary>

      <form method="POST" action="${base}/settings/payments/paypal-accounts/add" style="padding:16px;border-top:1px solid var(--s-border)">
        ${csrfField}

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div>
            <label style="${LABEL_STYLE}">Label (optional)</label>
            <input type="text" name="name" placeholder="e.g. Main store" maxlength="80" style="${INPUT_STYLE}">
          </div>
          <div>
            <label style="${LABEL_STYLE}">Mode</label>
            <div style="display:flex;gap:14px;align-items:center;height:38px">
              <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer">
                <input type="radio" name="mode" value="live" checked>
                <span>Live</span>
              </label>
              <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer">
                <input type="radio" name="mode" value="sandbox">
                <span>Sandbox</span>
              </label>
            </div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:8px">
          <div>
            <label style="${LABEL_STYLE}">Client ID <span style="color:#ef4444">*</span></label>
            <input type="text" name="client_id" required autocomplete="off" placeholder="Paste PayPal Client ID" style="${INPUT_STYLE}">
          </div>
          <div>
            <label style="${LABEL_STYLE}">Client Secret <span style="color:#ef4444">*</span></label>
            <input type="password" name="client_secret" required autocomplete="off" style="${INPUT_STYLE}">
          </div>
        </div>

        <p style="font-size:11px;color:var(--s-text-dim);margin:0 0 14px">
          Need credentials?
          <a href="${PAYPAL_DEV_DASHBOARD_LIVE}" target="_blank" rel="noopener noreferrer" style="color:var(--s-accent, #6366f1);text-decoration:none;font-weight:600">Live Dashboard ↗</a>
          &middot;
          <a href="${PAYPAL_DEV_DASHBOARD_SANDBOX}" target="_blank" rel="noopener noreferrer" style="color:var(--s-accent, #6366f1);text-decoration:none;font-weight:600">Sandbox Dashboard ↗</a>
        </p>

        <div style="display:flex;gap:10px;align-items:center">
          <button type="submit" class="btn btn-primary" style="padding:9px 18px;font-size:13px;border-radius:6px;font-weight:600">${isFirst ? 'Add &amp; Activate' : 'Add account'}</button>
          <a href="${base}/settings/payments" style="padding:9px 12px;font-size:12px;color:var(--s-text-dim);text-decoration:none">Cancel</a>
          ${isFirst
            ? '<span style="font-size:11px;color:var(--s-text-dim);margin-left:auto">First account auto-activates</span>'
            : '<span style="font-size:11px;color:var(--s-text-dim);margin-left:auto">Added inactive — Set Active manually</span>'}
        </div>
      </form>
    </details>
  `
}

/**
 * Render switch toggle ở header của PayPal card.
 *
 * Hiển thị toggle ON/OFF — submit POST tới /paypal-accounts/toggle để
 * deactivate-all (OFF) hoặc activate-first (ON). Hoạt động với form OUTSIDE
 * main paymentForm (button form="..." attribute) để tránh nested forms.
 *
 * Nếu accountsCount=0: render disabled visual (không có account nào để bật).
 */
export function renderPaypalToggleButton(opts: {
  base: string
  enabled: boolean
  accountsCount: number
}): string {
  const { enabled, accountsCount } = opts
  const disabled = accountsCount === 0
  const nextValue = enabled ? '0' : '1'
  const title = disabled
    ? 'Add a PayPal account first'
    : enabled
      ? 'Click to disable PayPal at storefront'
      : 'Click to enable PayPal at storefront'

  if (disabled) {
    return `
      <span class="toggle-switch" style="opacity:.4;cursor:not-allowed" title="${title}">
        <input type="checkbox" disabled>
        <span class="toggle-slider"></span>
      </span>
    `
  }
  return `
    <button type="submit" form="ps-paypal-toggle" name="enabled" value="${nextValue}"
      title="${title}"
      style="background:none;border:none;padding:0;cursor:pointer;display:inline-flex;align-items:center">
      <span class="toggle-switch" style="pointer-events:none">
        <input type="checkbox" ${enabled ? 'checked' : ''} disabled>
        <span class="toggle-slider"></span>
      </span>
    </button>
  `
}

export interface RenderAccountsListOpts {
  base: string
  accounts: BePayment[]
  maxAccounts: number
  showAddForm: boolean
  csrfField: string
}

/**
 * Top-level render: list cards + add form + Partner registration link.
 */
export function renderPaypalAccountsList(opts: RenderAccountsListOpts): string {
  const { base, accounts, maxAccounts, showAddForm, csrfField } = opts
  const atMax = accounts.length >= maxAccounts
  const isEmpty = accounts.length === 0

  return `
    <!-- List header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:13px;font-weight:600;color:var(--s-text)">
        Saved accounts <span style="color:var(--s-text-dim);font-weight:400">(${accounts.length}/${maxAccounts})</span>
      </div>
      ${atMax
        ? '<span style="font-size:11px;color:#f59e0b;font-weight:600">Maximum reached</span>'
        : `<a href="${base}/settings/payments?add_paypal=1#paypal-add-form" style="display:inline-flex;align-items:center;gap:5px;padding:6px 12px;font-size:12px;font-weight:600;border:1px solid var(--s-border);border-radius:6px;text-decoration:none;color:var(--s-text);background:var(--s-surface)">
            <span style="font-size:14px;line-height:1">+</span> Add account
          </a>`}
    </div>

    ${isEmpty
      ? `<p style="font-size:12px;color:var(--s-text-dim);margin:0 0 6px">No accounts yet — add your first below.</p>`
      : `<div style="display:flex;flex-direction:column;gap:10px">
          ${accounts.map(acc => renderAccountCard(base, acc, csrfField)).join('')}
        </div>`}

    ${atMax ? '' : renderAddForm(base, showAddForm || isEmpty, csrfField, isEmpty)}

    <div style="margin-top:16px;padding-top:12px;border-top:1px dashed var(--s-border);font-size:12px;color:var(--s-text-dim)">
      Don't have a PayPal Business account?
      <a href="${base}/settings/payments/paypal/onboard-start" style="color:var(--s-accent, #6366f1);text-decoration:none;font-weight:600">Register via PayPal Partner ↗</a>
    </div>
  `
}
