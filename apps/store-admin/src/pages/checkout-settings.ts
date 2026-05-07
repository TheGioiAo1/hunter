/**
 * Store Admin — Checkout Settings (API mode stub)
 *
 * Toggle settings cũ lưu vào `shop_settings` (DB-only). BE chưa expose
 * API riêng → page render form với default values, save báo "not available".
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'

function toggleField(name: string, label: string, description: string, checked: boolean): string {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--s-border)">
      <div>
        <div style="font-weight:600;font-size:14px;color:var(--s-text-primary)">${label}</div>
        <div style="font-size:12px;color:var(--s-text-secondary);margin-top:2px">${description}</div>
      </div>
      <label style="position:relative;width:44px;height:24px;cursor:pointer">
        <input type="checkbox" name="${name}" value="true" ${checked ? 'checked' : ''} style="opacity:0;width:0;height:0;position:absolute" />
        <div style="position:absolute;inset:0;border-radius:12px;background:${checked ? 'rgba(34,197,94,.8)' : 'var(--s-border)'};transition:background .2s">
          <div style="position:absolute;top:2px;${checked ? 'right:2px' : 'left:2px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:all .2s"></div>
        </div>
      </label>
    </div>
  `
}

export async function getCheckoutSettings(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  // Default values — chờ BE expose endpoint shop_settings/checkout_*.
  const requireAccount: string = 'optional'
  const requirePhone = false
  const enableTipping = false
  const autoFulfillDigital = false
  const orderNotes = true
  const termsRequired = false

  const flashSuccess = String(req.query.success ?? '').slice(0, 200)
  const flashError = String(req.query.error ?? '').slice(0, 200)
  const csrfField = csrfHiddenField(req.csrfToken!)

  const content = `
    <style>
      .gbx-flash{display:flex;align-items:center;gap:8px;padding:10px 14px;margin:0 0 16px;border-radius:8px;font-size:13px;font-weight:500}
      .gbx-flash-success{color:#065f46;background:#d1fae5;border:1px solid #a7f3d0}
      .gbx-flash-error{color:#991b1b;background:#fee2e2;border:1px solid #fecaca}
      .gbx-flash-info{color:#1e40af;background:#dbeafe;border:1px solid #bfdbfe}
      [data-theme="dark"] .gbx-flash-success{color:#a7f3d0;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3)}
      [data-theme="dark"] .gbx-flash-error{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)}
      [data-theme="dark"] .gbx-flash-info{color:#bfdbfe;background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.3)}
    </style>

    <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
      <a href="/admin/store/${esc(store.slug)}/settings" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px">&larr; Settings</a>
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Checkout</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Configure checkout experience for ${esc(store.name)}</p>
      </div>
    </div>

    ${flashSuccess ? `<div class="gbx-flash gbx-flash-success">${esc(flashSuccess)}</div>` : ''}
    ${flashError ? `<div class="gbx-flash gbx-flash-error">${esc(flashError)}</div>` : ''}

    <div class="gbx-flash gbx-flash-info" style="max-width:700px">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="7"/><path d="M8 5v3M8 11h.01"/></svg>
      Checkout settings persistence is being migrated to the new API. Form below shows defaults; saving is temporarily disabled.
    </div>

    <form method="POST" action="/admin/store/${esc(store.slug)}/settings/checkout">
      ${csrfField}

      <!-- Customer Information -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px;max-width:700px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Customer Information</h2>
        <p style="margin:0 0 12px;color:var(--s-text-secondary);font-size:13px">Control what information customers provide at checkout</p>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Customer accounts</label>
          <select name="require_account" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px">
            <option value="disabled" ${requireAccount === 'disabled' ? 'selected' : ''}>Accounts are disabled</option>
            <option value="optional" ${requireAccount === 'optional' ? 'selected' : ''}>Accounts are optional</option>
            <option value="required" ${requireAccount === 'required' ? 'selected' : ''}>Accounts are required</option>
          </select>
          <div style="font-size:12px;color:var(--s-text-secondary);margin-top:4px">Choose if customers need an account to check out</div>
        </div>

        ${toggleField('require_phone', 'Require phone number', 'Customers must provide a phone number at checkout', requirePhone)}
        ${toggleField('order_notes', 'Allow order notes', 'Let customers add special instructions to their order', orderNotes)}
      </div>

      <!-- Order Processing -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px;max-width:700px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Order Processing</h2>
        <p style="margin:0 0 12px;color:var(--s-text-secondary);font-size:13px">Automatic fulfillment and processing options</p>

        ${toggleField('auto_fulfill_digital', 'Auto-fulfill digital products', 'Automatically mark digital products as fulfilled after payment', autoFulfillDigital)}
        ${toggleField('tipping', 'Enable tipping', 'Allow customers to add a tip during checkout', enableTipping)}
      </div>

      <!-- Policies -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px;max-width:700px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Policies</h2>
        <p style="margin:0 0 12px;color:var(--s-text-secondary);font-size:13px">Terms and legal requirements</p>

        ${toggleField('terms_required', 'Require agreement to terms', 'Customers must agree to your terms of service before checkout', termsRequired)}
      </div>

      <button type="submit" class="btn btn-primary" style="padding:10px 24px;font-size:14px;font-weight:600;border-radius:8px">Save Settings</button>
    </form>
  `

  res.send(
    sellerLayout({
      title: 'Checkout Settings',
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
}

export async function postCheckoutSettings(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  res.redirect(
    `/admin/store/${store.slug}/settings/checkout?error=${encodeURIComponent(
      'Checkout settings save is not available in this API version. Please contact Gbox support.',
    )}`,
  )
}
