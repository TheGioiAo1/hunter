/**
 * Store Admin — Customer Accounts Settings
 *
 * Configures customer account behavior: registration, login methods,
 * self-service returns, order history access, etc.
 * Mirrors Shopify's Settings > Customer accounts page.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getShopSetting(db: Kysely<Database>, shopId: string, key: string): Promise<any> {
  const row = await db
    .selectFrom('shop_settings')
    .select('value')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()
  return row ? (row as any).value : null
}

async function setShopSetting(db: Kysely<Database>, shopId: string, key: string, value: any): Promise<void> {
  const existing = await db
    .selectFrom('shop_settings')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('shop_settings')
      .set({ value: JSON.stringify(value), updated_at: new Date().toISOString() } as any)
      .where('shop_id', '=', shopId)
      .where('key', '=', key)
      .execute()
  } else {
    await db
      .insertInto('shop_settings')
      .values({
        shop_id: shopId,
        key,
        value: JSON.stringify(value),
      } as any)
      .execute()
  }
}

// ---------------------------------------------------------------------------
// GET /settings/customer-accounts
// ---------------------------------------------------------------------------

export async function getCustomerAccountsSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const successMsg = req.query.success === 'saved' ? 'Customer account settings saved.' : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''

  // API mode (no local DB): render with defaults instead of throwing.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let accountMode: any = null
  let loginMethod: any = null
  let selfServeReturns: any = null
  let orderHistory: any = null
  let savedAddresses: any = null
  let wishlistEnabled: any = null

  if (hasDb) {
    try {
      ;[accountMode, loginMethod, selfServeReturns, orderHistory, savedAddresses, wishlistEnabled] = await Promise.all([
        getShopSetting(db, store.id, 'customer_account_mode'),
        getShopSetting(db, store.id, 'customer_login_method'),
        getShopSetting(db, store.id, 'customer_self_serve_returns'),
        getShopSetting(db, store.id, 'customer_order_history'),
        getShopSetting(db, store.id, 'customer_saved_addresses'),
        getShopSetting(db, store.id, 'customer_wishlist'),
      ])
    } catch (e: any) {
      console.warn('[customer-accounts-settings] DB read failed, using defaults:', e?.message)
    }
  }

  const content = `
    <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
      <a href="/admin/store/${esc(store.slug)}/settings" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px">&larr; Settings</a>
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Customer Accounts</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Configure how customers interact with their accounts</p>
      </div>
    </div>

    ${successMsg ? `<div style="background:color-mix(in srgb, var(--s-success,#22c55e) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-success,#22c55e) 40%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:16px;color:var(--s-text);font-size:13px">${esc(successMsg)}</div>` : ''}
    ${errorMsg ? `<div style="background:color-mix(in srgb, var(--s-danger,#ef4444) 14%, transparent);border:1px solid color-mix(in srgb, var(--s-danger,#ef4444) 40%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:16px;color:var(--s-text);font-size:13px">${esc(errorMsg)}</div>` : ''}

    <form method="POST" action="/admin/store/${esc(store.slug)}/settings/customer-accounts" style="max-width:700px">
      <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />

      <!-- Account Registration -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Account Registration</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Choose how customer accounts work on your store</p>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:8px">Customer accounts</label>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${['disabled', 'optional', 'required'].map(v => `
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:12px;border:1px solid var(--s-border);border-radius:8px;background:${(accountMode || 'optional') === v ? 'var(--s-surface)' : 'var(--s-bg)'}">
                <input type="radio" name="account_mode" value="${v}" ${(accountMode || 'optional') === v ? 'checked' : ''} style="margin-top:2px" />
                <div>
                  <div style="font-weight:600;font-size:14px;color:var(--s-text-primary)">${v.charAt(0).toUpperCase() + v.slice(1)}</div>
                  <div style="font-size:12px;color:var(--s-text-secondary);margin-top:2px">${v === 'disabled' ? 'Customers checkout as guests only' : v === 'optional' ? 'Customers can create accounts at checkout or on the account page' : 'Customers must create an account to checkout'}</div>
                </div>
              </label>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Login Method -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Login Method</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">How customers sign in to their accounts</p>

        <div style="margin-bottom:8px">
          <select name="login_method" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px">
            <option value="email_password" ${(loginMethod || 'email_password') === 'email_password' ? 'selected' : ''}>Email and password</option>
            <option value="magic_link" ${loginMethod === 'magic_link' ? 'selected' : ''}>Magic link (passwordless)</option>
            <option value="both" ${loginMethod === 'both' ? 'selected' : ''}>Both email/password and magic link</option>
          </select>
        </div>
      </div>

      <!-- Account Features -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 4px;font-size:17px;font-weight:700">Account Features</h2>
        <p style="margin:0 0 16px;color:var(--s-text-secondary);font-size:13px">Enable or disable customer account features</p>

        ${[
          { name: 'order_history', label: 'Order history', desc: 'Customers can view their past orders', checked: orderHistory !== false },
          { name: 'saved_addresses', label: 'Saved addresses', desc: 'Customers can save multiple shipping addresses', checked: savedAddresses !== false },
          { name: 'wishlist', label: 'Wishlist', desc: 'Customers can save products to a wishlist', checked: wishlistEnabled === true },
          { name: 'self_serve_returns', label: 'Self-serve returns', desc: 'Customers can request returns from their account', checked: selfServeReturns === true },
        ].map(f => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--s-border)">
            <div>
              <div style="font-weight:600;font-size:14px;color:var(--s-text-primary)">${f.label}</div>
              <div style="font-size:12px;color:var(--s-text-secondary);margin-top:2px">${f.desc}</div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" name="${f.name}" value="true" ${f.checked ? 'checked' : ''} style="width:16px;height:16px" />
            </label>
          </div>
        `).join('')}
      </div>

      <button type="submit" class="btn btn-primary" style="padding:10px 24px;font-size:14px;font-weight:600;border-radius:8px">Save Settings</button>
    </form>
  `

  res.send(
    sellerLayout({
      title: 'Customer Accounts',
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

// ---------------------------------------------------------------------------
// POST /settings/customer-accounts — Save settings
// ---------------------------------------------------------------------------

export async function postCustomerAccountsSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const body = req.body

  // API mode (no local DB): no BE endpoint for shop_settings → show banner.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.redirect(`/admin/store/${store.slug}/settings/customer-accounts?error=${encodeURIComponent('Saving settings requires local DB or a BE endpoint - not supported in API mode.')}`)
    return
  }

  try {
    await Promise.all([
      setShopSetting(db, store.id, 'customer_account_mode', body.account_mode || 'optional'),
      setShopSetting(db, store.id, 'customer_login_method', body.login_method || 'email_password'),
      setShopSetting(db, store.id, 'customer_order_history', body.order_history === 'true'),
      setShopSetting(db, store.id, 'customer_saved_addresses', body.saved_addresses === 'true'),
      setShopSetting(db, store.id, 'customer_wishlist', body.wishlist === 'true'),
      setShopSetting(db, store.id, 'customer_self_serve_returns', body.self_serve_returns === 'true'),
    ])
    notify(db, {
      shopId: store.id,
      userId: (req as any).storeUser?.id,
      type: 'customer_accounts_settings_updated',
      title: 'Customer account settings updated',
      message: byActor((req as any).storeUser),
      resourceType: null,
      resourceId: null,
    })
    res.redirect(`/admin/store/${store.slug}/settings/customer-accounts?success=saved`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/settings/customer-accounts?error=${encodeURIComponent(err.message)}`)
  }
}
