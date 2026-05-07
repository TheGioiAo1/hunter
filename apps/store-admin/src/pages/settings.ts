/**
 * Store Admin — Settings Page
 *
 * Sub-pages: General, Payments, Shipping, Taxes, Staff, Domains
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc as escLayout } from '../layouts/seller-layout.js'
// CSRF: centralized in server.ts; pages use req.csrfToken + csrfHiddenField.
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'
import { createApiContext, getShopDetail, updateShopDetail } from '../lib/shop-detail-api-client.js'
import { formatProductApiError } from '../lib/product-api-errors.js'

// ─── SETTINGS HOME ──────────────────────────────────────────────

export async function getSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!

  // Mirrors the full Shopify Settings hub. Every card here must resolve
  // to a registered route — regression-guarded by
  // apps/store-admin/scripts/smoke-settings-audit.ts. The "Domains" card
  // deliberately points at /online-store/domains (not /settings/domains
  // which doesn't exist) to match the sidebar nav and the actual handler
  // location in online-store.ts.
  const base = `/admin/store/${store.slug}`
  const settingSections = [
    { icon: '🏪', title: 'General',           desc: 'Store name, address, contact info, currency',         href: `${base}/settings/general` },
    { icon: '📋', title: 'Plan',              desc: 'Plan, billing cycle, usage, upgrades',                 href: `${base}/settings/plan` },
    { icon: '💳', title: 'Payments',          desc: 'Payment providers, Stripe, PayPal configuration',     href: `${base}/settings/payments` },
    { icon: '🛒', title: 'Checkout',          desc: 'Checkout behavior, cart rules, abandoned recovery',   href: `${base}/settings/checkout` },
    { icon: '🚚', title: 'Shipping and delivery', desc: 'Shipping zones, rates, carriers',                 href: `${base}/settings/shipping` },
    { icon: '🧾', title: 'Surcharges',         desc: 'Flat fees per item by country, applied at checkout',  href: `${base}/settings/taxes` },
    { icon: '🌍', title: 'Markets',           desc: 'Countries, shipping zones, tax registrations per region', href: `${base}/settings/markets` },
    { icon: '💱', title: 'Currencies',        desc: 'Primary currency and storefront display currencies',   href: `${base}/settings/currencies` },
    { icon: '🌐', title: 'Domains',           desc: 'Custom domain, SSL, DNS settings',                    href: `${base}/online-store/domains` },
    { icon: '📍', title: 'Locations',         desc: 'Fulfillment locations and warehouses',                href: `${base}/settings/locations` },
    { icon: '👤', title: 'Customer accounts', desc: 'Account registration, login, self-service',           href: `${base}/settings/customer-accounts` },
    { icon: '🔔', title: 'Notifications',     desc: 'Email templates, notification preferences',           href: `${base}/settings/notifications` },
    { icon: '🧩', title: 'Custom data',       desc: 'Metafield definitions for products, orders, customers', href: `${base}/settings/custom-data` },
    { icon: '🗣️', title: 'Languages',         desc: 'Store language and translations',                     href: `${base}/settings/languages` },
    { icon: '📜', title: 'Policies',          desc: 'Privacy, terms, refund, shipping policies',           href: `${base}/settings/legal` },
    { icon: '👥', title: 'Users and staff',   desc: 'Team members, roles, permissions',                    href: `${base}/settings/staff` },
    { icon: '🔒', title: 'Security',          desc: 'Sign-in history, active sessions, 2FA',               href: `${base}/settings/security` },
    { icon: '🔔', title: 'Alerts',            desc: 'Choose which events email you and appear in-app',     href: `${base}/settings/alerts` },
    { icon: '📊', title: 'Store activity log', desc: 'Audit log of staff actions',                         href: `${base}/settings/activity` },
    { icon: '🤖', title: 'AI',                desc: 'AI provider, API keys, model selection',              href: `${base}/settings/ai` },
    { icon: '📱', title: 'Marketing pixels',  desc: 'Meta, GA4, TikTok, Pinterest, Google Ads, custom tags', href: `${base}/settings/pixels` },
    // Phase 10 PR4 — surface review moderation preferences here so the
    // Phase 10 PR3 profanity + notification settings are discoverable
    // from the Settings hub (previously only reachable from the reviews
    // queue header). The target page lives under /products/reviews/settings
    // so the breadcrumb stays logical, but this card is the primary
    // entry point for sellers arriving via the Settings grid.
    { icon: '⭐', title: 'Reviews',           desc: 'Profanity filter, moderation defaults, reviewer emails', href: `${base}/products/reviews/settings` },
    // Phase 14 PR3 — Shopify Flow lite automations hub. Absorbs the
    // old /marketing/automations + /marketing/abandoned/settings pages
    // under one roof so merchants have a single place to toggle every
    // automatic email in their store.
    { icon: '🤖', title: 'Automations',       desc: 'Automatic emails for orders, reviews, restocks, abandoned carts, and more', href: `${base}/settings/automations` },
    // Phase 14 PR6 commit 8 — narrow finance-alerts view. Same
    // automation_flows rows as the Automations page, filtered to the
    // 10 finance/fraud keys so merchants can find "turn off the fraud
    // email" without scrolling past 18 marketing toggles.
    { icon: '💰', title: 'Finance alerts',    desc: 'Refunds, failed payments, fraud flags, out-of-stock, and payouts', href: `${base}/settings/finance-alerts` },
    // Phase 14 PR4 — email open/click analytics. Lives under /reports
    // (it's a report, not a setting) but surfaced here so sellers can
    // reach it from the same hub as the templates / automations it
    // reports on. Tracking only applies to marketing, lifecycle, and
    // reviews emails — transactional emails are never tracked.
    { icon: '📊', title: 'Email analytics',   desc: 'Open rates, click rates, bounce rates, and per-template breakdown', href: `${base}/reports/email-analytics` },
    // Gbox Email Service automation templates — abandoned cart, order
    // confirmation, shipping notification, etc. Connects to the
    // Lencam microservice (api-email.gbox.co) separately from the
    // Shopify-class registry at /settings/email-templates.
    { icon: '✉️', title: 'Email Templates',    desc: 'Abandoned cart, order confirmation, shipping notification và các email tự động khác', href: `${base}/settings/email-templates` },
    // Phase 14 PR4.B — blocked-address list, manually clearable. Grouped
    // alongside analytics/templates/automations because it's the last
    // piece of the "outbound email" story — what happened to addresses
    // that bounced or complained.
    { icon: '🚫', title: 'Email suppressions', desc: 'Addresses blocked from future sends after a bounce or spam complaint', href: `${base}/settings/email-suppressions` },
    // Phase 14 PR5 — GDPR/Privacy queue. Customers file requests on
    // /accounts/privacy (token-auth'd from their email footer); staff
    // triage the queue here.
    { icon: '🛡️', title: 'Privacy requests', desc: 'Customer data exports, deletion requests, and rectification queue', href: `${base}/settings/privacy-requests` },
  ]

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Settings</h1>
        <p class="page-subtitle">Manage your store configuration</p>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
      ${settingSections.map(s => `
        <a href="${esc(s.href)}" class="card" style="text-decoration:none;color:inherit;transition:transform .15s;cursor:pointer">
          <div class="card-body" style="display:flex;align-items:flex-start;gap:16px">
            <div style="font-size:28px;flex-shrink:0">${s.icon}</div>
            <div>
              <div style="font-weight:600;font-size:15px;margin-bottom:4px">${esc(s.title)}</div>
              <div style="font-size:13px;color:var(--text-secondary)">${esc(s.desc)}</div>
            </div>
          </div>
        </a>
      `).join('')}
    </div>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Settings',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'settings',
    content,
  }))
}

// ─── GENERAL SETTINGS ────────────────────────────────────────────

export async function getGeneralSettings(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  let shop: any = null
  let errMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    shop = await getShopDetail(ctx)
  } catch (err) {
    errMsg = formatProductApiError(err)
  }

  if (!shop && !errMsg) {
    res.redirect(`/admin/store/${store.slug}/settings`)
    return
  }

  const saved = req.query.saved === '1'
  const flashError = String(req.query.error ?? '').slice(0, 200)

  // Fallback toàn bộ field về store/JWT context khi API fail.
  shop = shop ?? {}
  const name = shop.name ?? store.name ?? ''
  const email = shop.email ?? ''
  const phone = shop.phone ?? ''
  const address = shop.address ?? ''
  const apartment = shop.apartment ?? ''
  const city = shop.city ?? ''
  const province = shop.province ?? ''
  const countryCode = shop.country_code ?? ''
  const zipCode = shop.zip_code ?? ''
  const currency = shop.currency ?? 'USD'
  const effectiveTz = shop.timezone ?? 'UTC'
  const title = shop.title ?? ''
  const description = shop.description ?? ''
  const legalName = shop.legal_name_of_business ?? ''
  const publicDomain = shop.public_domain ?? `${store.slug}.gbox.co`
  const active = shop.active !== false

  const TZ_CHOICES = [
    'UTC',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
    'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore',
    'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Manila', 'Asia/Kolkata',
    'Australia/Sydney', 'Pacific/Auckland',
  ]
  if (effectiveTz && !TZ_CHOICES.includes(effectiveTz)) TZ_CHOICES.unshift(effectiveTz)
  const tzOptions = TZ_CHOICES.map((t) => `<option value="${esc(t)}" ${t === effectiveTz ? 'selected' : ''}>${esc(t)}</option>`).join('')

  const csrfField = csrfHiddenField(req.csrfToken!)

  const content = `
    <style>
      .gbx-flash{display:flex;align-items:center;gap:8px;padding:10px 14px;margin:0 0 16px;border-radius:8px;font-size:13px;font-weight:500}
      .gbx-flash-success{color:#065f46;background:#d1fae5;border:1px solid #a7f3d0}
      .gbx-flash-error{color:#991b1b;background:#fee2e2;border:1px solid #fecaca}
      [data-theme="dark"] .gbx-flash-success{color:#a7f3d0;background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3)}
      [data-theme="dark"] .gbx-flash-error{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3)}
    </style>

    <div class="page-header">
      <div>
        <h1 class="page-title">General Settings</h1>
        <p class="page-subtitle"><a href="/admin/store/${store.slug}/settings" style="color:var(--accent);text-decoration:none">Settings</a> / General</p>
      </div>
      <button form="generalForm" type="submit" class="btn btn-primary">Save changes</button>
    </div>

    ${saved ? `<div class="gbx-flash gbx-flash-success">General settings saved.</div>` : ''}
    ${flashError ? `<div class="gbx-flash gbx-flash-error">${esc(flashError)}</div>` : ''}
    ${errMsg ? `<div class="gbx-flash gbx-flash-error">${esc(errMsg)}</div>` : ''}

    <form id="generalForm" method="POST" action="/admin/store/${store.slug}/settings/general">
      ${csrfField}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <!-- Store Details -->
        <div class="card">
          <div class="card-header">Store details</div>
          <div class="card-body">
            <div style="margin-bottom:16px">
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Store name</label>
              <input type="text" name="name" value="${esc(name)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px" required>
            </div>
            <div style="margin-bottom:16px">
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Legal business name</label>
              <input type="text" name="legal_name_of_business" value="${esc(legalName)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
            </div>
            <div style="margin-bottom:16px">
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Email</label>
              <input type="email" name="email" value="${esc(email)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Phone</label>
              <input type="text" name="phone" value="${esc(phone)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
            </div>
          </div>
        </div>

        <!-- Address -->
        <div class="card">
          <div class="card-header">Store address</div>
          <div class="card-body">
            <div style="margin-bottom:16px">
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Address</label>
              <input type="text" name="address" value="${esc(address)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
            </div>
            <div style="margin-bottom:16px">
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Apartment / Suite</label>
              <input type="text" name="apartment" value="${esc(apartment)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">City</label>
                <input type="text" name="city" value="${esc(city)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Province/State</label>
                <input type="text" name="province" value="${esc(province)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Country code</label>
                <input type="text" name="country_code" value="${esc(countryCode)}" placeholder="VN, US, JP..." maxlength="2" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;text-transform:uppercase">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">ZIP/Postal</label>
                <input type="text" name="zip_code" value="${esc(zipCode)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Currency</label>
                <input type="text" name="currency" value="${esc(currency)}" maxlength="3" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;text-transform:uppercase">
                <p style="font-size:11px;color:var(--text-secondary);margin-top:4px">ISO-4217 code (USD, VND, EUR...).</p>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Timezone</label>
                <select name="timezone" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
                  ${tzOptions}
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- SEO -->
      <div class="card" style="margin-top:20px">
        <div class="card-header">Storefront SEO</div>
        <div class="card-body">
          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Title (browser tab + search)</label>
            <input type="text" name="title" value="${esc(title)}" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px">
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary)">Description</label>
            <textarea name="description" rows="3" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;resize:vertical">${esc(description)}</textarea>
            <p style="font-size:11px;color:var(--text-secondary);margin-top:4px">Shown in search engine results and social previews.</p>
          </div>
        </div>
      </div>

      <!-- Status -->
      <div class="card" style="margin-top:20px">
        <div class="card-header">Status</div>
        <div class="card-body" style="display:flex;gap:24px;align-items:center;flex-wrap:wrap">
          <div>
            <span style="font-size:12px;color:var(--text-secondary)">Status:</span>
            <span class="badge ${active ? 'badge-success' : 'badge-warning'}" style="margin-left:8px">${active ? 'active' : 'inactive'}</span>
          </div>
          <div>
            <span style="font-size:12px;color:var(--text-secondary)">Domain:</span>
            <span style="font-size:13px;margin-left:8px">${esc(publicDomain)}</span>
          </div>
        </div>
      </div>
    </form>
  `

  res.send(sellerLayout({
    title: 'General Settings',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'settings',
    content,
  }))
}

// ─── SAVE GENERAL SETTINGS ───────────────────────────────────────

export async function postGeneralSettings(
  req: Request,
  res: Response,
  _db: any,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  const b = req.body as Record<string, string>
  const tz = (b.timezone || '').trim() || 'UTC'

  try {
    const ctx = createApiContext(req)
    // PUT trả về Shop đầy đủ — BE merge fields đã gửi với data hiện tại.
    // Truyền id để BE filter đúng record (cùng shop_id trong URL).
    await updateShopDetail(ctx, {
      id: store.id,
      name: (b.name || store.name || '').trim(),
      legal_name_of_business: (b.legal_name_of_business || '').trim() || undefined,
      email: (b.email || '').trim() || undefined,
      phone: (b.phone || '').trim() || undefined,
      address: (b.address || '').trim() || undefined,
      apartment: (b.apartment || '').trim() || undefined,
      city: (b.city || '').trim() || undefined,
      province: (b.province || '').trim() || undefined,
      country_code: (b.country_code || '').trim().toUpperCase() || undefined,
      zip_code: (b.zip_code || '').trim() || undefined,
      currency: (b.currency || '').trim().toUpperCase() || undefined,
      timezone: tz,
      title: (b.title || '').trim() || undefined,
      description: (b.description || '').trim() || undefined,
    })
    res.redirect(`${base}/settings/general?saved=1`)
  } catch (err) {
    const msg = formatProductApiError(err)
    res.redirect(`${base}/settings/general?error=${encodeURIComponent(msg)}`)
  }
}

// ─── STAFF SETTINGS ──────────────────────────────────────────────

export async function getStaffSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!

  const staff = await db
    .selectFrom('user_shops as us')
    .innerJoin('users as u', 'u.id', 'us.user_id')
    .select(['u.id', 'u.name', 'u.email', 'u.role as userRole', 'us.role as storeRole'])
    .where('us.shop_id', '=', store.id)
    .execute()

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Staff & Permissions</h1>
        <p class="page-subtitle"><a href="/admin/store/${store.slug}/settings" style="color:var(--accent);text-decoration:none">Settings</a> / Staff</p>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span>Team members (${staff.length})</span>
      </div>
      <div class="card-body">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Platform Role</th><th>Store Role</th></tr></thead>
            <tbody>
              ${staff.map(s => `
                <tr>
                  <td style="font-weight:500">${esc(s.name || s.email.split('@')[0])}</td>
                  <td>${esc(s.email)}</td>
                  <td><span class="badge badge-info">${esc(s.userRole)}</span></td>
                  <td><span class="badge ${s.storeRole === 'owner' ? 'badge-success' : 'badge-warning'}">${esc(s.storeRole)}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Staff',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'settings',
    content,
  }))
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
