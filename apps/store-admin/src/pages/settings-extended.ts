/**
 * Store Admin — Settings Extended (Phase 9)
 *
 * I1-I2: Shipping Zones & Rates
 * J1:    Tax Settings
 * K3:    Notification Settings
 * K5:    Billing & Plan
 * K6:    Legal Page Generator
 * K7:    Activity Log
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { logSellerAction } from '../middleware/store-auth.js'
// CSRF: centralized in server.ts; pages use req.csrfToken + csrfHiddenField.
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'

// ─── I1-I2: SHIPPING SETTINGS ───────────────────────────────────

export async function getShippingSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const saved = req.query.saved === '1'

  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  // Fetch shipping zones with their rates
  const zones = await db.selectFrom('shipping_zones')
    .select(['id', 'name', 'countries'])
    .where('shop_id', '=', store.id)
    .orderBy('name', 'asc')
    .execute()

  // Fetch rates for all zones
  const zoneIds = zones.map(z => z.id)
  const rates = zoneIds.length > 0
    ? await db.selectFrom('shipping_rates')
        .select(['id', 'zone_id', 'name', 'price', 'type', 'min_value', 'max_value'])
        .where('zone_id', 'in', zoneIds)
        .orderBy('name', 'asc')
        .execute()
    : []

  // Group rates by zone
  const ratesByZone = new Map<string, typeof rates>()
  for (const r of rates) {
    const list = ratesByZone.get(r.zone_id) || []
    list.push(r)
    ratesByZone.set(r.zone_id, list)
  }

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Shipping</h1>
        <p class="page-subtitle">Manage shipping zones and rates</p>
      </div>
    </div>

    ${saved ? `
      <div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">
        Shipping zone saved successfully.
      </div>
    ` : ''}

    <!-- EXISTING ZONES -->
    ${zones.length > 0 ? zones.map(z => {
      const zoneRates = ratesByZone.get(z.id) || []
      const countries = Array.isArray(z.countries) ? z.countries.join(', ') : String(z.countries || 'All')
      return `
        <div class="card" style="margin-bottom:16px">
          <div class="card-header">
            <div>
              <span style="font-weight:600">${esc(z.name)}</span>
              <span style="font-size:12px;color:var(--s-text-dim);margin-left:8px">${esc(countries)}</span>
            </div>
            <span class="badge badge-neutral">${zoneRates.length} rate${zoneRates.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="card-body" style="padding:0">
            ${zoneRates.length > 0 ? `
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Rate Name</th>
                      <th>Type</th>
                      <th style="text-align:right">Price</th>
                      <th>Range</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${zoneRates.map(r => `
                      <tr>
                        <td style="font-weight:500">${esc(r.name)}</td>
                        <td><span class="badge badge-neutral">${esc(r.type || 'flat')}</span></td>
                        <td style="text-align:right;font-weight:600">$${Number(r.price).toFixed(2)}</td>
                        <td style="color:var(--s-text-dim);font-size:12px">
                          ${r.min_value != null || r.max_value != null
                            ? `${r.min_value != null ? '$' + Number(r.min_value).toFixed(2) : '0'} — ${r.max_value != null ? '$' + Number(r.max_value).toFixed(2) : 'unlimited'}`
                            : 'All orders'}
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : `
              <div style="padding:16px;text-align:center;color:var(--s-text-dim);font-size:13px">No rates configured for this zone.</div>
            `}
          </div>
        </div>
      `
    }).join('') : `
      <div class="card" style="margin-bottom:20px">
        <div class="card-body" style="text-align:center;padding:40px;color:var(--s-text-dim)">
          <div style="font-size:32px;margin-bottom:12px">&#128666;</div>
          <div style="font-weight:600;margin-bottom:4px">No shipping zones</div>
          <div style="font-size:13px">Create your first shipping zone below.</div>
        </div>
      </div>
    `}

    <!-- CREATE ZONE FORM -->
    <div class="card">
      <div class="card-header">
        <span>Create Shipping Zone</span>
      </div>
      <div class="card-body">
        <form method="POST" action="${base}/settings/shipping" id="shippingForm">
          ${csrfField}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Zone Name</label>
              <input type="text" name="zone_name" placeholder="e.g., Domestic, International" required
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Countries (comma-separated)</label>
              <textarea name="countries" rows="1" placeholder="e.g., US, CA, MX"
                style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text);resize:vertical"></textarea>
            </div>
          </div>

          <div style="border:1px solid var(--s-border);border-radius:8px;padding:16px;margin-bottom:16px">
            <div style="font-weight:600;font-size:13px;margin-bottom:12px">Shipping Rate</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Rate Name</label>
                <input type="text" name="rate_name" placeholder="e.g., Standard Shipping" required
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Price ($)</label>
                <input type="number" name="rate_price" step="0.01" min="0" placeholder="0.00" required
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Type</label>
                <select name="rate_type"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
                  <option value="flat">Flat rate</option>
                  <option value="weight_based">Weight-based</option>
                  <option value="price_based">Price-based</option>
                </select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Min Value (optional)</label>
                <input type="number" name="min_value" step="0.01" min="0" placeholder="e.g., 0.00"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--s-text-dim)">Max Value (optional)</label>
                <input type="number" name="max_value" step="0.01" min="0" placeholder="e.g., 100.00"
                  style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)">
              </div>
            </div>
          </div>

          <button type="submit" class="btn btn-primary">Create Zone</button>
        </form>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Shipping Settings',
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

// ─── POST: CREATE SHIPPING ZONE ─────────────────────────────────

export async function postCreateShippingZone(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`

  // CSRF validated by centralized middleware in server.ts.

  const {
    zone_name,
    countries,
    rate_name,
    rate_price,
    rate_type,
    min_value,
    max_value,
  } = req.body

  if (!zone_name || !rate_name || rate_price == null) {
    res.redirect(`${base}/settings/shipping`)
    return
  }

  // Parse countries into array
  const countryList = (countries || '')
    .split(',')
    .map((c: string) => c.trim())
    .filter(Boolean)

  // Create zone
  const zone = await db.insertInto('shipping_zones')
    .values({
      shop_id: store.id,
      name: zone_name.trim(),
      countries: JSON.stringify(countryList),
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Create rate
  await db.insertInto('shipping_rates')
    .values({
      zone_id: zone.id,
      name: rate_name.trim(),
      price: parseFloat(rate_price) || 0,
      type: rate_type || 'flat',
      min_value: min_value ? parseFloat(min_value) : null,
      max_value: max_value ? parseFloat(max_value) : null,
    })
    .execute()

  await logSellerAction(db, req, 'create', 'shipping_zone', zone.id, {
    zone_name: zone_name.trim(),
    countries: countryList,
  })

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'shipping_zone_created',
    title: `Shipping zone created: ${zone_name.trim()}`,
    message: byActor((req as any).storeUser),
    resourceType: 'shipping_zone',
    resourceId: zone.id,
  })

  res.redirect(`${base}/settings/shipping?saved=1`)
}

// ─── J1: TAX SETTINGS (removed Phase 9 PR3) ─────────────────────
//
// The legacy `getTaxSettings` + `postTaxSettings` placeholders (backed by
// `shop_settings.tax_inclusive` JSONB) were replaced in Phase 9 PR2 by
// pages/tax-settings.ts (`getTaxSettingsPage` + `postTaxSettingsForm`)
// which reads/writes the richer `shops.tax_inclusive_pricing` column from
// migration 067 along with registrations + rates. PR3 drops the orphans
// to keep the settings-extended surface tight. If any caller still
// imports the old names, use the new handlers directly.

// ─── K3: NOTIFICATION SETTINGS ──────────────────────────────────

/**
 * Starter content for each default transactional email. Merchants can
 * customise any of these; on first save the row is inserted into
 * `email_templates`. Until they customise, the page just shows the
 * defaults and the preview uses this content.
 */
const DEFAULT_EMAIL_TEMPLATES: Array<{ name: string; subject: string; body_html: string }> = [
  {
    name: 'Order Confirmation',
    subject: 'Order #{{order_number}} confirmed',
    body_html: '<p>Hi {{customer_first_name}},</p>\n<p>Thanks for your order <strong>#{{order_number}}</strong> — we\'ve got it!</p>\n<p>Order total: <strong>{{order_total}}</strong></p>\n<p>We\'ll email you again when your order ships.</p>\n<p>— {{store_name}}</p>',
  },
  {
    name: 'Shipping Confirmation',
    subject: 'Your order has shipped',
    body_html: '<p>Hi {{customer_first_name}},</p>\n<p>Good news! Order <strong>#{{order_number}}</strong> is on its way.</p>\n<p>Tracking: <a href="{{tracking_url}}">{{tracking_number}}</a></p>\n<p>— {{store_name}}</p>',
  },
  {
    name: 'Order Refund',
    subject: 'Your order has been refunded',
    body_html: '<p>Hi {{customer_first_name}},</p>\n<p>We\'ve refunded <strong>{{refund_amount}}</strong> for order <strong>#{{order_number}}</strong>.</p>\n<p>It can take 5-10 business days for the refund to appear on your statement.</p>\n<p>— {{store_name}}</p>',
  },
  {
    name: 'Customer Welcome',
    subject: 'Welcome to {{store_name}}',
    body_html: '<p>Hi {{customer_first_name}},</p>\n<p>Welcome to <strong>{{store_name}}</strong>! Thanks for creating an account.</p>\n<p><a href="{{store_url}}">Start shopping</a></p>',
  },
  {
    name: 'Password Reset',
    subject: 'Reset your password',
    body_html: '<p>Hi {{customer_first_name}},</p>\n<p>Tap the link below to reset your password. This link expires in 30 minutes.</p>\n<p><a href="{{reset_url}}">Reset password</a></p>\n<p>If you didn\'t request this, you can ignore this email.</p>',
  },
  {
    name: 'Abandoned Cart Reminder',
    subject: 'You left something behind',
    body_html: '<p>Hi {{customer_first_name}},</p>\n<p>You still have items in your cart at {{store_name}}.</p>\n<p><a href="{{checkout_url}}">Complete your order</a></p>',
  },
]

/**
 * Look up a default template by name. Used when a merchant clicks
 * "Customize" on a template that doesn't have a DB row yet.
 */
function findDefaultTemplate(name: string): { name: string; subject: string; body_html: string } | null {
  return DEFAULT_EMAIL_TEMPLATES.find(t => t.name === name) || null
}

export async function getNotificationSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const saved = req.query.saved === '1'

  // Fetch email templates — API mode (no local DB): return [] so the render
  // path falls back to defaultTemplates (UI logic already handles it).
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let templates: Array<{ id: any; name: string; subject: string | null; active: boolean | null }> = []
  if (hasDb) {
    try {
      templates = await db.selectFrom('email_templates')
        .select(['id', 'name', 'subject', 'active'])
        .where('shop_id', '=', store.id)
        .orderBy('name', 'asc')
        .execute() as any
    } catch (e: any) {
      console.warn('[notification-settings] DB read failed:', e?.message)
    }
  }

  // Default template list if none exist
  const defaultTemplates = DEFAULT_EMAIL_TEMPLATES.map(t => ({ name: t.name, subject: t.subject }))

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Notifications</h1>
        <p class="page-subtitle">Manage email templates and notification preferences</p>
      </div>
    </div>

    ${saved ? '<div style="margin-bottom:16px;padding:10px 14px;border-radius:8px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#22c55e;font-size:13px">Template saved.</div>' : ''}

    <!-- EMAIL TEMPLATES -->
    <div class="card">
      <div class="card-header">
        <span>Email Templates</span>
        <span style="font-size:12px;color:var(--s-text-dim)">${templates.length > 0 ? templates.length + ' templates' : 'Using defaults'}</span>
      </div>
      <div class="card-body" style="padding:0">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${templates.length > 0 ? templates.map(t => `
                <tr>
                  <td style="font-weight:500">${esc(t.name)}</td>
                  <td style="color:var(--s-text-muted);font-size:13px">${esc(t.subject || '')}</td>
                  <td>
                    <span class="badge ${t.active ? 'badge-success' : 'badge-warning'}">${t.active ? 'Active' : 'Disabled'}</span>
                  </td>
                  <td>
                    <a href="${base}/settings/notifications/templates/${encodeURIComponent(t.name)}/edit" class="btn btn-outline btn-sm" style="text-decoration:none">Edit</a>
                  </td>
                </tr>
              `).join('') : defaultTemplates.map(t => `
                <tr>
                  <td style="font-weight:500">${esc(t.name)}</td>
                  <td style="color:var(--s-text-muted);font-size:13px">${esc(t.subject)}</td>
                  <td>
                    <span class="badge badge-success">Active</span>
                  </td>
                  <td>
                    <a href="${base}/settings/notifications/templates/${encodeURIComponent(t.name)}/edit" class="btn btn-outline btn-sm" style="text-decoration:none">Customize</a>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- NOTIFICATION PREFERENCES (PLACEHOLDER) -->
    <div class="card" style="margin-top:20px">
      <div class="card-header">
        <span>Notification Preferences</span>
        <span class="badge badge-neutral">Coming soon</span>
      </div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:12px">
          ${[
            { label: 'New order notifications', desc: 'Receive email when a new order is placed', checked: true },
            { label: 'Low stock alerts', desc: 'Get notified when product stock drops below threshold', checked: true },
            { label: 'Customer signup notifications', desc: 'Receive email when a new customer registers', checked: false },
            { label: 'Review notifications', desc: 'Get notified when a product review is submitted', checked: false },
          ].map(n => `
            <label style="display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid var(--s-border);border-radius:8px;cursor:pointer">
              <input type="checkbox" ${n.checked ? 'checked' : ''} disabled
                style="width:18px;height:18px;accent-color:var(--s-accent)">
              <div style="flex:1">
                <div style="font-weight:500;font-size:13px">${esc(n.label)}</div>
                <div style="font-size:12px;color:var(--s-text-dim);margin-top:1px">${esc(n.desc)}</div>
              </div>
            </label>
          `).join('')}
        </div>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Notifications',
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

// ─── K3b: EMAIL TEMPLATE EDITOR ─────────────────────────────────

/**
 * GET /settings/notifications/templates/:name/edit
 *
 * Render the edit form for a single transactional email template.
 * If the merchant already customised this template we pre-fill from
 * the `email_templates` row; otherwise we fall back to the starter
 * copy in `DEFAULT_EMAIL_TEMPLATES` so merchants always see the
 * canonical baseline before making changes.
 */
export async function getEmailTemplateEdit(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const name = String(req.params.name || '')

  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  const fallback = findDefaultTemplate(name)
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let existing: { id?: any; name?: string; subject?: string | null; body_html?: string | null; active?: boolean | null } | undefined
  if (hasDb) {
    try {
      existing = await db.selectFrom('email_templates')
        .select(['id', 'name', 'subject', 'body_html', 'active'])
        .where('shop_id', '=', store.id)
        .where('name', '=', name)
        .executeTakeFirst() as any
    } catch (e: any) {
      console.warn('[email-template-edit] DB read failed:', e?.message)
    }
  }

  if (!existing && !fallback) {
    res.status(404).send('Template not found')
    return
  }

  const subject = existing?.subject ?? fallback?.subject ?? ''
  const bodyHtml = existing?.body_html ?? fallback?.body_html ?? ''
  const active = existing ? !!existing.active : true
  const isCustomised = !!existing

  const saved = req.query.saved === '1'

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings/notifications" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Notifications
        </a>
        <h1 class="page-title">${esc(name)}</h1>
        <p class="page-subtitle">${isCustomised ? 'Customised template' : 'Using default template — save to customise'}</p>
      </div>
    </div>

    ${saved ? '<div style="margin-bottom:16px;padding:10px 14px;border-radius:8px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#22c55e;font-size:13px">Template saved.</div>' : ''}

    <form method="POST" action="${base}/settings/notifications/templates/${encodeURIComponent(name)}">
      ${csrfField}

      <div class="card">
        <div class="card-header">
          <span>Template content</span>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
          <div>
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px">Subject line</label>
            <input type="text" name="subject" value="${esc(subject)}" required maxlength="255"
              style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg-elevated);color:var(--s-text);font-size:14px">
            <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">Placeholders like <code>{{order_number}}</code> are replaced at send time.</div>
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px">Body (HTML)</label>
            <textarea name="body_html" rows="14" required
              style="width:100%;padding:10px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg-elevated);color:var(--s-text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5">${esc(bodyHtml)}</textarea>
            <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">Supports the same <code>{{placeholder}}</code> tokens as the subject line.</div>
          </div>

          <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer">
            <input type="checkbox" name="active" value="1" ${active ? 'checked' : ''}
              style="width:16px;height:16px;accent-color:var(--s-accent)">
            <span>Send this email to customers</span>
          </label>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <a href="${base}/settings/notifications" class="btn btn-outline" style="text-decoration:none">Cancel</a>
        <button type="submit" class="btn btn-primary">Save template</button>
      </div>
    </form>
  `

  res.send(sellerLayout({
    title: `Edit: ${name}`,
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

/**
 * POST /settings/notifications/templates/:name
 *
 * Upsert a customised email template. The `(shop_id, name)` pair has
 * a unique index (see migration 001) so we can use `onConflict` +
 * `doUpdateSet` for a single-round-trip insert-or-update.
 *
 * `name` is the canonical template key (e.g. "Order Confirmation") and
 * comes from the URL, never the form body — merchants can't rename
 * or re-target a template by tampering with a hidden field.
 */
export async function postEmailTemplateUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const name = String(req.params.name || '')

  // CSRF validated by centralized middleware in server.ts.

  const { subject, body_html, active } = req.body as {
    subject?: string
    body_html?: string
    active?: string
  }

  const trimmedSubject = typeof subject === 'string' ? subject.trim() : ''
  const trimmedBody = typeof body_html === 'string' ? body_html.trim() : ''

  if (!trimmedSubject) {
    res.status(400).send('Subject is required')
    return
  }
  if (trimmedSubject.length > 255) {
    res.status(400).send('Subject must be 255 characters or fewer')
    return
  }
  if (!trimmedBody) {
    res.status(400).send('Body is required')
    return
  }

  // Reject unknown template names so merchants can't create arbitrary
  // rows by hitting the URL directly. We only allow the canonical set
  // defined in DEFAULT_EMAIL_TEMPLATES.
  if (!findDefaultTemplate(name)) {
    res.status(404).send('Template not found')
    return
  }

  const nowIso = new Date().toISOString()
  const isActive = active === '1' || active === 'true' || active === 'on'

  // API mode (no local DB): no BE endpoint for email_templates → show banner.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.redirect(`${base}/settings/notifications/templates/${encodeURIComponent(name)}/edit?error=${encodeURIComponent('Saving template requires local DB or a BE endpoint - not supported in API mode.')}`)
    return
  }

  await db.insertInto('email_templates')
    .values({
      shop_id: store.id,
      name,
      subject: trimmedSubject,
      body_html: trimmedBody,
      active: isActive,
    } as any)
    .onConflict((oc) =>
      oc.columns(['shop_id', 'name']).doUpdateSet({
        subject: trimmedSubject,
        body_html: trimmedBody,
        active: isActive,
        updated_at: nowIso,
      } as any),
    )
    .execute()

  await logSellerAction(db, req, 'update', 'email_template', name, {
    active: isActive,
  })

  notify(db, {
    shopId: store.id,
    userId: (req as any).storeUser?.id,
    type: 'email_template_updated',
    title: `Email template updated: ${name}`,
    message: byActor((req as any).storeUser),
    resourceType: 'email_template',
    resourceId: null,
  })

  res.redirect(`${base}/settings/notifications/templates/${encodeURIComponent(name)}/edit?saved=1`)
}

// ─── K7: ACTIVITY LOG ───────────────────────────────────────────

export async function getActivityLog(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
  const perPage = 50
  const offset = (page - 1) * perPage
  const search = (req.query.q as string || '').trim()

  // API mode (no local DB): audit_logs is Postgres-only. Render empty state.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let logs: Array<{ id: any; user_email: string | null; action: string; resource_type: string | null; resource_id: string | null; details: any; ip_address: string | null; created_at: any }> = []
  let totalCount = 0

  if (hasDb) {
    try {
      // Build query — join with users to get email
      let baseQuery = db.selectFrom('audit_logs')
        .leftJoin('users', 'users.id', 'audit_logs.user_id')
        .where('audit_logs.shop_id', '=', store.id)

      if (search) {
        baseQuery = baseQuery.where((eb) =>
          eb.or([
            eb('audit_logs.action', 'ilike', `%${search}%`),
            eb('users.email', 'ilike', `%${search}%`),
          ])
        )
      }

      const [rows, totalResult] = await Promise.all([
        baseQuery
          .select([
            'audit_logs.id',
            'users.email as user_email',
            'audit_logs.action',
            'audit_logs.resource_type',
            'audit_logs.resource_id',
            'audit_logs.details',
            'audit_logs.ip_address',
            'audit_logs.created_at',
          ])
          .orderBy('audit_logs.created_at', 'desc')
          .limit(perPage)
          .offset(offset)
          .execute(),

        baseQuery
          .select(db.fn.count('audit_logs.id').as('count'))
          .executeTakeFirst(),
      ])
      logs = rows as any
      totalCount = Number(totalResult?.count ?? 0)
    } catch (e: any) {
      console.warn('[activity-log] DB read failed:', e?.message)
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage))

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Activity Log</h1>
        <p class="page-subtitle">${totalCount} action${totalCount !== 1 ? 's' : ''} recorded</p>
      </div>
    </div>

    <!-- SEARCH -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-body" style="padding:12px 16px">
        <form method="GET" action="${base}/settings/activity" style="display:flex;gap:10px;align-items:center">
          <input
            type="text"
            name="q"
            value="${esc(search)}"
            placeholder="Search by action or user email..."
            style="flex:1;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg, transparent);color:var(--s-text)"
          >
          <button type="submit" class="btn btn-outline btn-sm">Search</button>
          ${search ? `<a href="${base}/settings/activity" class="btn btn-outline btn-sm">Clear</a>` : ''}
        </form>
      </div>
    </div>

    <!-- LOGS TABLE -->
    <div class="card">
      <div class="card-header">
        <span>Activity${search ? ` matching "${esc(search)}"` : ''}</span>
        <span style="font-size:12px;color:var(--s-text-dim)">${totalCount} entries</span>
      </div>
      <div class="card-body" style="padding:0">
        ${logs.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                ${logs.map(l => {
                  const ts = new Date(l.created_at as string)
                  const dateStr = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                  const details = l.details ? (typeof l.details === 'string' ? l.details : JSON.stringify(l.details)).slice(0, 80) : ''
                  return `
                    <tr>
                      <td style="font-size:12px;color:var(--s-text-dim);white-space:nowrap">${dateStr}</td>
                      <td style="font-size:13px">${esc(l.user_email || 'System')}</td>
                      <td>
                        <span class="badge badge-neutral">${esc(l.action || '')}</span>
                      </td>
                      <td style="font-size:13px;color:var(--s-text-muted)">
                        ${esc(l.resource_type || '')}${l.resource_id ? ` <span style="font-family:monospace;font-size:11px">${esc(String(l.resource_id).slice(0, 8))}...</span>` : ''}
                      </td>
                      <td style="font-size:12px;color:var(--s-text-dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(details)}">${esc(details)}</td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>

          ${totalPages > 1 ? `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--s-border);font-size:13px;color:var(--s-text-dim)">
              <span>Page ${page} of ${totalPages}</span>
              <div style="display:flex;gap:4px">
                ${page > 1
                  ? `<a href="${base}/settings/activity?page=${page - 1}${search ? '&q=' + encodeURIComponent(search) : ''}" class="btn btn-outline btn-sm">&laquo; Previous</a>`
                  : `<span class="btn btn-outline btn-sm" style="opacity:0.4;pointer-events:none">&laquo; Previous</span>`}
                ${page < totalPages
                  ? `<a href="${base}/settings/activity?page=${page + 1}${search ? '&q=' + encodeURIComponent(search) : ''}" class="btn btn-outline btn-sm">Next &raquo;</a>`
                  : `<span class="btn btn-outline btn-sm" style="opacity:0.4;pointer-events:none">Next &raquo;</span>`}
              </div>
            </div>
          ` : ''}
        ` : `
          <div style="text-align:center;padding:40px;color:var(--s-text-dim)">
            <div style="font-weight:600;margin-bottom:4px">${search ? 'No matching activity' : 'No activity logged yet'}</div>
            <div style="font-size:13px">${search ? 'Try a different search term.' : 'Actions will appear here as your team uses the store admin.'}</div>
          </div>
        `}
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Activity Log',
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

// ─── K6: LEGAL PAGES ────────────────────────────────────────────

export async function getLegalPages(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const legalSlugs = ['privacy-policy', 'terms-of-service', 'refund-policy']

  // Check which legal pages already exist. API mode (no local DB): return [] →
  // all 3 cards show "Not created" + Generate-with-AI button. BE Page Service
  // exposes GET /api/{shop_id} but the schema differs (nested slug) — wire later
  // when persistence is needed.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let existingPages: Array<{ id: any; slug: string; title: string | null }> = []
  if (hasDb) {
    try {
      existingPages = await db.selectFrom('pages')
        .select(['id', 'slug', 'title'])
        .where('shop_id', '=', store.id)
        .where('slug', 'in', legalSlugs)
        .execute() as any
    } catch (e: any) {
      console.warn('[legal-pages] DB read failed:', e?.message)
    }
  }

  const existingMap = new Map(existingPages.map(p => [p.slug, p]))

  const legalCards = [
    {
      slug: 'privacy-policy',
      title: 'Privacy Policy',
      desc: 'Explains how you collect, use, and protect customer data. Required by GDPR, CCPA, and most jurisdictions.',
      icon: '&#128274;',
    },
    {
      slug: 'terms-of-service',
      title: 'Terms of Service',
      desc: 'Defines the rules and guidelines for using your store. Protects your business legally.',
      icon: '&#128220;',
    },
    {
      slug: 'refund-policy',
      title: 'Refund Policy',
      desc: 'Outlines your return and refund conditions. Builds customer trust and reduces disputes.',
      icon: '&#128176;',
    },
  ]

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/settings" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Settings
        </a>
        <h1 class="page-title">Legal Pages</h1>
        <p class="page-subtitle">Generate and manage your store's legal documents</p>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
      ${legalCards.map(card => {
        const existing = existingMap.get(card.slug)
        return `
          <div class="card">
            <div class="card-body" style="padding:24px">
              <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:16px">
                <div style="font-size:32px;flex-shrink:0">${card.icon}</div>
                <div>
                  <div style="font-weight:600;font-size:15px;margin-bottom:4px">${esc(card.title)}</div>
                  <div style="font-size:12px;color:var(--s-text-dim);line-height:1.5">${esc(card.desc)}</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                ${existing
                  ? `
                    <span class="badge badge-success">Created</span>
                    <a href="${base}/online-store/pages/${existing.id}" class="btn btn-outline btn-sm">Edit</a>
                  `
                  : `
                    <span class="badge badge-warning">Not created</span>
                    <button class="btn btn-primary btn-sm" data-ai-sug="Generate a ${card.title.toLowerCase()} for my store named ${esc(store.name)}">Generate with AI</button>
                  `}
              </div>
            </div>
          </div>
        `
      }).join('')}
    </div>

    <!-- AI LEGAL ASSISTANT -->
    <div class="card" style="margin-top:20px;border-color:var(--s-accent)">
      <div class="card-header" style="color:var(--s-accent)">
        <span style="display:flex;align-items:center;gap:8px">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7.5" cy="8.5" r="1"/><circle cx="12.5" cy="8.5" r="1"/><path d="M7 13c1.5 1 4.5 1 6 0"/></svg>
          AI Legal Assistant
        </span>
      </div>
      <div class="card-body" style="display:flex;flex-wrap:wrap;gap:8px">
        <button class="btn btn-outline btn-sm" data-ai-sug="Generate all legal pages for my store">Generate all pages</button>
        <button class="btn btn-outline btn-sm" data-ai-sug="Review my privacy policy for GDPR compliance">GDPR compliance check</button>
        <button class="btn btn-outline btn-sm" data-ai-sug="What legal pages does my e-commerce store need?">Legal requirements</button>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Legal Pages',
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

// ─── K5: BILLING & PLAN (removed Phase 9 PR3) ──────────────────
//
// The legacy `getBillingPage` duplicated the plan picker + usage card that
// now live in pages/plan-settings.ts (`getPlanSettings`). The old
// `/settings/billing` route now redirects to /settings/plan — see the
// router note in server.ts. Dropping the orphan here trims ~180 lines
// from this module without any behavioural change.
