/**
 * God Admin — Stores Management (Category B)
 *
 * GET  /god-admin/stores              — List all stores
 * GET  /god-admin/stores/create       — Create store form
 * POST /god-admin/stores              — Create store
 * GET  /god-admin/stores/:id          — Store detail
 * GET  /god-admin/stores/:id/health   — Store health score
 * POST /god-admin/stores/:id/suspend  — Suspend store
 * POST /god-admin/stores/:id/reactivate — Reactivate store
 * POST /god-admin/stores/:id/delete   — Soft delete store
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
// Phase 0 Step 0.4b: CSRF on every store-mutation form. The detail
// page has three destructive row actions (suspend / reactivate /
// delete) plus a create form on a separate page — one module-level
// store feeds tokens to all of them.
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'

// ---------------------------------------------------------------------------
// Module-level CSRF store
// ---------------------------------------------------------------------------

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_god_stores' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtMoney(val: string | number | null): string {
  const n = Number(val) || 0
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusBadge(status: string | null): string {
  const s = status || 'unknown'
  const map: Record<string, string> = {
    active: 'badge-green', suspended: 'badge-red', closed: 'badge-red',
    deleted: 'badge-red',
    paid: 'badge-green', pending: 'badge-yellow', unfulfilled: 'badge-yellow',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

function healthScoreColor(score: number): string {
  if (score > 70) return '#22c55e'  // green
  if (score >= 40) return '#eab308' // yellow
  return '#ef4444'                   // red
}

function healthScoreBadge(score: number): string {
  const color = healthScoreColor(score)
  return `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;background:${color}22;color:${color};font-weight:600;font-size:13px">${score}/100</span>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/stores — List all stores
// ---------------------------------------------------------------------------

export async function getStores(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const search = (req.query.search as string || '').trim()
  const statusFilter = (req.query.status as string || '').trim()

  try {
    let query = db.selectFrom('shops as s')
      .leftJoin(
        db.selectFrom('products').groupBy('shop_id').select(['shop_id', sql<string>`count(*)`.as('cnt')]).as('pc'),
        'pc.shop_id', 's.id',
      )
      .leftJoin(
        db.selectFrom('orders').groupBy('shop_id').select([
          'shop_id',
          sql<string>`count(*)`.as('order_cnt'),
          sql<string>`coalesce(sum(total_price::numeric), 0)`.as('revenue'),
        ]).as('oc'),
        'oc.shop_id', 's.id',
      )
      .select([
        's.id', 's.name', 's.slug', 's.domain', 's.plan', 's.status',
        's.created_at',
        sql<string>`coalesce(pc.cnt, 0)`.as('products_count'),
        sql<string>`coalesce(oc.order_cnt, 0)`.as('orders_count'),
        sql<string>`coalesce(oc.revenue, 0)`.as('revenue'),
      ])

    if (search) {
      query = query.where((eb) =>
        eb.or([
          eb('s.name', 'ilike', `%${search}%`),
          eb('s.slug', 'ilike', `%${search}%`),
          eb('s.domain', 'ilike', `%${search}%`),
        ])
      )
    }

    if (statusFilter) {
      query = query.where('s.status', '=', statusFilter)
    }

    const stores = await query.orderBy('s.created_at', 'desc').limit(100).execute()

    const tableRows = stores.length > 0
      ? stores.map(s => `
        <tr>
          <td><a href="/god-admin/stores/${s.id}">${esc(s.name)}</a></td>
          <td class="mono">${esc(s.slug)}</td>
          <td>${esc(s.domain) || '-'}</td>
          <td>${esc(s.plan) || '-'}</td>
          <td>${statusBadge(s.status)}</td>
          <td>${fmtNum(s.products_count)}</td>
          <td>${fmtNum(s.orders_count)}</td>
          <td>${fmtMoney(s.revenue)}</td>
          <td>${shortDate(s.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:24px">No stores found</td></tr>'

    const content = `
      <div class="page-header">
        <h1>All Stores</h1>
        <div class="action-group">
          <a href="/god-admin/stores/create" class="btn btn-primary btn-sm">+ Create Store</a>
        </div>
      </div>

      <div class="card">
        <form method="get" action="/god-admin/stores" class="toolbar">
          <input type="text" name="search" class="search-input" placeholder="Search stores..." value="${esc(search)}">
          <select name="status" class="filter-select">
            <option value="">All Statuses</option>
            <option value="active"${statusFilter === 'active' ? ' selected' : ''}>Active</option>
            <option value="suspended"${statusFilter === 'suspended' ? ' selected' : ''}>Suspended</option>
            <option value="closed"${statusFilter === 'closed' ? ' selected' : ''}>Closed</option>
            <option value="deleted"${statusFilter === 'deleted' ? ' selected' : ''}>Deleted</option>
          </select>
          <button type="submit" class="btn btn-primary btn-sm">Filter</button>
        </form>

        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Domain</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Products</th>
              <th>Orders</th>
              <th>Revenue</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`

    res.send(godLayout({
      title: 'Stores',
      userEmail: user.email,
      activePath: '/god-admin/stores',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Stores list error:', err)
    res.status(500).send(godLayout({
      title: 'Stores',
      userEmail: user.email,
      activePath: '/god-admin/stores',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/stores/create — Create store form
// ---------------------------------------------------------------------------

export async function getCreateStore(req: Request, res: Response, _db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  const timezones = [
    'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
    'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Shanghai',
    'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Australia/Sydney', 'Pacific/Auckland',
  ]

  const timezoneOptions = timezones.map(tz =>
    `<option value="${esc(tz)}"${tz === 'UTC' ? ' selected' : ''}>${esc(tz)}</option>`
  ).join('')

  const content = `
    <div class="page-header">
      <h1>Create Store</h1>
      <div class="action-group">
        <a href="/god-admin/stores" class="btn btn-secondary btn-sm">Back to Stores</a>
      </div>
    </div>

    <div class="card" style="max-width:640px">
      <form method="post" action="/god-admin/stores" style="display:flex;flex-direction:column;gap:16px">
        ${csrfField}

        <div class="form-group">
          <label class="form-label" for="store-name">Store Name *</label>
          <input type="text" id="store-name" name="name" class="form-input" required
                 placeholder="My Awesome Store"
                 oninput="document.getElementById('store-slug').value = this.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')">
        </div>

        <div class="form-group">
          <label class="form-label" for="store-slug">Slug *</label>
          <input type="text" id="store-slug" name="slug" class="form-input mono" required
                 placeholder="my-awesome-store" pattern="[a-z0-9\\-]+">
          <span style="font-size:12px;color:var(--gray-400)">URL-friendly identifier (auto-generated from name)</span>
        </div>

        <div class="form-group">
          <label class="form-label" for="store-email">Contact Email *</label>
          <input type="email" id="store-email" name="email" class="form-input" required
                 placeholder="store@example.com">
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div class="form-group">
            <label class="form-label" for="store-currency">Currency</label>
            <select id="store-currency" name="currency" class="form-input">
              <option value="USD" selected>USD - US Dollar</option>
              <option value="EUR">EUR - Euro</option>
              <option value="GBP">GBP - British Pound</option>
              <option value="VND">VND - Vietnamese Dong</option>
              <option value="JPY">JPY - Japanese Yen</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="store-timezone">Timezone</label>
            <select id="store-timezone" name="timezone" class="form-input">
              ${timezoneOptions}
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="store-plan">Plan</label>
          <select id="store-plan" name="plan" class="form-input">
            <option value="free" selected>Free</option>
            <option value="basic">Basic</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>

        <div style="display:flex;gap:12px;margin-top:8px">
          <button type="submit" class="btn btn-primary">Create Store</button>
          <a href="/god-admin/stores" class="btn btn-secondary">Cancel</a>
        </div>
      </form>
    </div>`

  res.send(godLayout({
    title: 'Create Store',
    userEmail: user.email,
    activePath: '/god-admin/stores',
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /god-admin/stores — Create store
// ---------------------------------------------------------------------------

export async function postCreateStore(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  // CSRF first — this form creates a brand-new shop record, so we
  // refuse without a valid one-time token.
  if (!(await csrfStore.verify(req))) {
    res.status(403).send(godLayout({
      title: 'Create Store',
      userEmail: user.email,
      activePath: '/god-admin/stores',
      content: `<div class="card"><p style="color:var(--red)">Invalid form submission. Please reload and try again.</p><a href="/god-admin/stores/create" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Form</a></div>`,
    }))
    return
  }

  try {
    const { name, slug, email, currency, timezone, plan } = req.body

    if (!name || !slug || !email) {
      res.status(400).send(godLayout({
        title: 'Create Store',
        userEmail: user.email,
        activePath: '/god-admin/stores',
        content: `<div class="card"><p style="color:var(--red)">Name, slug, and email are required.</p><a href="/god-admin/stores/create" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Form</a></div>`,
      }))
      return
    }

    // Check slug uniqueness
    const existing = await db.selectFrom('shops')
      .where('slug', '=', slug)
      .select('id')
      .executeTakeFirst()

    if (existing) {
      res.status(409).send(godLayout({
        title: 'Create Store',
        userEmail: user.email,
        activePath: '/god-admin/stores',
        content: `<div class="card"><p style="color:var(--red)">A store with slug "${esc(slug)}" already exists.</p><a href="/god-admin/stores/create" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Form</a></div>`,
      }))
      return
    }

    const result = await db.insertInto('shops')
      .values({
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
        email: email.trim(),
        currency: currency || 'USD',
        timezone: timezone || 'UTC',
        plan: plan || 'free',
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    // Audit log
    await db.insertInto('audit_logs').values({
      shop_id: result.id,
      user_id: user.id,
      action: 'store.created',
      resource_type: 'shop',
      resource_id: result.id,
      details: JSON.stringify({ name, slug, email, currency, timezone, plan }),
      ip_address: req.ip || null,
    }).execute()

    res.redirect(`/god-admin/stores/${result.id}`)
  } catch (err) {
    console.error('[God Admin] Create store error:', err)
    res.status(500).send(godLayout({
      title: 'Create Store',
      userEmail: user.email,
      activePath: '/god-admin/stores',
      content: `<div class="card"><p style="color:var(--red)">Error creating store: ${esc(String(err))}</p><a href="/god-admin/stores/create" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Form</a></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/stores/:id — Store detail
// ---------------------------------------------------------------------------

export async function getStoreDetail(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const storeId = req.params.id

  // One token shared by suspend/reactivate/delete forms on this page.
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  try {
    const shop = await db.selectFrom('shops')
      .where('id', '=', storeId)
      .selectAll()
      .executeTakeFirst()

    if (!shop) {
      res.status(404).send(godLayout({
        title: 'Store Not Found',
        userEmail: user.email,
        activePath: '/god-admin/stores',
        content: '<div class="card"><p style="color:var(--red)">Store not found.</p><a href="/god-admin/stores" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Stores</a></div>',
      }))
      return
    }

    // Parallel sub-queries
    const [productsCount, ordersCount, customersCount, staff, recentOrders, topProducts, healthScore] = await Promise.all([
      db.selectFrom('products').where('shop_id', '=', storeId).select(sql<string>`count(*)`.as('cnt')).executeTakeFirst(),
      db.selectFrom('orders').where('shop_id', '=', storeId).select([sql<string>`count(*)`.as('cnt'), sql<string>`coalesce(sum(total_price::numeric), 0)`.as('revenue')]).executeTakeFirst(),
      db.selectFrom('customers').where('shop_id', '=', storeId).select(sql<string>`count(*)`.as('cnt')).executeTakeFirst(),
      db.selectFrom('user_shops as us')
        .innerJoin('users as u', 'u.id', 'us.user_id')
        .where('us.shop_id', '=', storeId)
        .select(['u.email', 'u.name', 'us.role'])
        .execute(),
      db.selectFrom('orders')
        .where('shop_id', '=', storeId)
        .select(['id', 'order_number', 'email', 'total_price', 'financial_status', 'fulfillment_status', 'created_at'])
        .orderBy('created_at', 'desc')
        .limit(10)
        .execute(),
      // Top 5 products by order line items count
      db.selectFrom('products as p')
        .leftJoin('order_line_items as oli', 'oli.product_id', 'p.id')
        .where('p.shop_id', '=', storeId)
        .groupBy(['p.id', 'p.title', 'p.status'])
        .select([
          'p.id', 'p.title', 'p.status',
          sql<string>`count(oli.id)`.as('line_items_count'),
          sql<string>`coalesce(sum(oli.quantity), 0)`.as('total_qty'),
          sql<string>`coalesce(sum(oli.price::numeric * oli.quantity), 0)`.as('total_revenue'),
        ])
        .orderBy(sql`count(oli.id)`, 'desc')
        .limit(5)
        .execute(),
      // Quick health score calculation
      calculateHealthScore(db, storeId),
    ])

    const staffRows = staff.length > 0
      ? staff.map(s => `<tr><td>${esc(s.email)}</td><td>${esc(s.name) || '-'}</td><td>${statusBadge(s.role)}</td></tr>`).join('')
      : '<tr><td colspan="3" style="text-align:center;color:var(--gray-400);padding:16px">No staff</td></tr>'

    const ordersRows = recentOrders.length > 0
      ? recentOrders.map(o => `
        <tr>
          <td><a href="/god-admin/orders/${esc(o.id)}">#${o.order_number}</a></td>
          <td>${esc(o.email)}</td>
          <td>${fmtMoney(o.total_price)}</td>
          <td>${statusBadge(o.financial_status)}</td>
          <td>${statusBadge(o.fulfillment_status)}</td>
          <td>${shortDate(o.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:16px">No orders</td></tr>'

    const topProductsRows = topProducts.length > 0 && Number(topProducts[0].line_items_count) > 0
      ? topProducts.map(p => `
        <tr>
          <td>${esc(p.title)}</td>
          <td>${statusBadge(p.status)}</td>
          <td>${fmtNum(p.line_items_count)}</td>
          <td>${fmtNum(p.total_qty)}</td>
          <td>${fmtMoney(p.total_revenue)}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:16px">No product sales data</td></tr>'

    const isDeleted = shop.status === 'deleted'

    const content = `
      <div class="page-header">
        <h1>
          ${esc(shop.name)}
          <a href="/god-admin/stores/${shop.id}/health" style="margin-left:12px;text-decoration:none" title="Health Score">
            ${healthScoreBadge(healthScore.total)}
          </a>
        </h1>
        <div class="action-group">
          ${!isDeleted && shop.status === 'active'
            ? `<form method="post" action="/god-admin/stores/${shop.id}/suspend" style="display:inline">${csrfField}<button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Suspend this store?')">Suspend</button></form>`
            : ''
          }
          ${!isDeleted && shop.status === 'suspended'
            ? `<form method="post" action="/god-admin/stores/${shop.id}/reactivate" style="display:inline">${csrfField}<button type="submit" class="btn btn-primary btn-sm">Reactivate</button></form>`
            : ''
          }
          ${!isDeleted
            ? `<form method="post" action="/god-admin/stores/${shop.id}/delete" style="display:inline">${csrfField}<button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Are you sure you want to DELETE this store? This action marks the store as deleted.')">Delete Store</button></form>`
            : `<span class="badge badge-red" style="padding:6px 12px;font-size:13px">This store has been deleted</span>`
          }
          <a href="/god-admin/stores" class="btn btn-secondary btn-sm">Back</a>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Products</div>
          <div class="stat-value">${fmtNum(productsCount?.cnt ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Orders</div>
          <div class="stat-value">${fmtNum(ordersCount?.cnt ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Revenue</div>
          <div class="stat-value">${fmtMoney(ordersCount?.revenue ?? 0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Customers</div>
          <div class="stat-value">${fmtNum(customersCount?.cnt ?? 0)}</div>
        </div>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-title" style="margin-bottom:12px">Store Info</div>
          <div class="info-row"><span class="info-label">ID</span><span class="info-value mono">${esc(shop.id)}</span></div>
          <div class="info-row"><span class="info-label">Slug</span><span class="info-value mono">${esc(shop.slug)}</span></div>
          <div class="info-row"><span class="info-label">Domain</span><span class="info-value">${esc(shop.domain) || '-'}</span></div>
          <div class="info-row"><span class="info-label">Custom Domain</span><span class="info-value">${esc(shop.custom_domain) || '-'}</span></div>
          <div class="info-row"><span class="info-label">Email</span><span class="info-value">${esc(shop.email)}</span></div>
          <div class="info-row"><span class="info-label">Plan</span><span class="info-value">${esc(shop.plan) || '-'}</span></div>
          <div class="info-row"><span class="info-label">Status</span><span class="info-value">${statusBadge(shop.status)}</span></div>
          <div class="info-row"><span class="info-label">Currency</span><span class="info-value">${esc(shop.currency)}</span></div>
          <div class="info-row"><span class="info-label">Timezone</span><span class="info-value">${esc(shop.timezone)}</span></div>
          <div class="info-row"><span class="info-label">Created</span><span class="info-value">${shortDate(shop.created_at)}</span></div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:12px">Staff Members</div>
          <table class="data-table">
            <thead><tr><th>Email</th><th>Name</th><th>Role</th></tr></thead>
            <tbody>${staffRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Top Products</div>
        </div>
        <table class="data-table">
          <thead>
            <tr><th>Product</th><th>Status</th><th>Line Items</th><th>Qty Sold</th><th>Revenue</th></tr>
          </thead>
          <tbody>${topProductsRows}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Recent Orders</div>
        </div>
        <table class="data-table">
          <thead>
            <tr><th>Order</th><th>Customer</th><th>Amount</th><th>Payment</th><th>Fulfillment</th><th>Date</th></tr>
          </thead>
          <tbody>${ordersRows}</tbody>
        </table>
      </div>`

    res.send(godLayout({
      title: shop.name,
      userEmail: user.email,
      activePath: '/god-admin/stores',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Store detail error:', err)
    res.status(500).send(godLayout({
      title: 'Store Detail',
      userEmail: user.email,
      activePath: '/god-admin/stores',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/stores/:id/suspend
// ---------------------------------------------------------------------------

export async function postSuspendStore(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const storeId = req.params.id

  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/stores/${storeId}`)
    return
  }

  try {
    // Capture name + prior status BEFORE we flip — we need the name for
    // the platform_churn_alert and the status diff tells us whether
    // this is actually a real lifecycle transition (re-suspending an
    // already-suspended shop shouldn't re-alert; the dedup-per-month
    // guards that anyway, but checking up-front is cleaner).
    const before = await db
      .selectFrom('shops')
      .select(['name', 'status'])
      .where('id', '=', storeId)
      .executeTakeFirst()

    await db.updateTable('shops')
      .set({ status: 'suspended', updated_at: new Date().toISOString() })
      .where('id', '=', storeId)
      .execute()

    // Audit log
    await db.insertInto('audit_logs').values({
      shop_id: storeId,
      user_id: req.godAdmin!.user.id,
      action: 'store.suspended',
      resource_type: 'shop',
      resource_id: storeId,
      ip_address: req.ip || null,
    }).execute()

    // Phase 14 PR6 — platform_churn_alert. Fire-and-forget so a dead
    // alerts pipeline can't block the suspend action itself (god-admin
    // must ALWAYS be able to suspend a bad shop, even if emails break).
    if (before && before.status !== 'suspended') {
      void (async () => {
        try {
          const { emitPlatformChurnAlert } = await import(
            '@gbox/core/modules/platform-alerts/emitters.js'
          )
          await emitPlatformChurnAlert(db, {
            shopId: storeId,
            shopName: before.name ?? 'Unknown shop',
            closureReason: 'suspended',
          })
        } catch (alertErr) {
          console.error('[God Admin] platform_churn_alert emit failed:', alertErr)
        }
      })()
    }

    res.redirect(`/god-admin/stores/${storeId}`)
  } catch (err) {
    console.error('[God Admin] Suspend store error:', err)
    res.redirect(`/god-admin/stores/${storeId}`)
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/stores/:id/reactivate
// ---------------------------------------------------------------------------

export async function postReactivateStore(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const storeId = req.params.id

  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/stores/${storeId}`)
    return
  }

  try {
    await db.updateTable('shops')
      .set({ status: 'active', updated_at: new Date().toISOString() })
      .where('id', '=', storeId)
      .execute()

    // Audit log
    await db.insertInto('audit_logs').values({
      shop_id: storeId,
      user_id: req.godAdmin!.user.id,
      action: 'store.reactivated',
      resource_type: 'shop',
      resource_id: storeId,
      ip_address: req.ip || null,
    }).execute()

    res.redirect(`/god-admin/stores/${storeId}`)
  } catch (err) {
    console.error('[God Admin] Reactivate store error:', err)
    res.redirect(`/god-admin/stores/${storeId}`)
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/stores/:id/delete — Soft delete
// ---------------------------------------------------------------------------

export async function postDeleteStore(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const storeId = req.params.id

  if (!(await csrfStore.verify(req))) {
    res.redirect(`/god-admin/stores/${storeId}`)
    return
  }

  try {
    const before = await db
      .selectFrom('shops')
      .select(['name', 'status'])
      .where('id', '=', storeId)
      .executeTakeFirst()

    await db.updateTable('shops')
      .set({ status: 'deleted', updated_at: new Date().toISOString() })
      .where('id', '=', storeId)
      .execute()

    // Audit log
    await db.insertInto('audit_logs').values({
      shop_id: storeId,
      user_id: req.godAdmin!.user.id,
      action: 'store.deleted',
      resource_type: 'shop',
      resource_id: storeId,
      ip_address: req.ip || null,
    }).execute()

    // Phase 14 PR6 — platform_churn_alert. Soft-delete = churn.
    if (before && before.status !== 'deleted') {
      void (async () => {
        try {
          const { emitPlatformChurnAlert } = await import(
            '@gbox/core/modules/platform-alerts/emitters.js'
          )
          await emitPlatformChurnAlert(db, {
            shopId: storeId,
            shopName: before.name ?? 'Unknown shop',
            closureReason: 'deleted',
          })
        } catch (alertErr) {
          console.error('[God Admin] platform_churn_alert emit failed:', alertErr)
        }
      })()
    }

    res.redirect('/god-admin/stores')
  } catch (err) {
    console.error('[God Admin] Delete store error:', err)
    res.redirect(`/god-admin/stores/${storeId}`)
  }
}

// ---------------------------------------------------------------------------
// Health Score — internal calculation
// ---------------------------------------------------------------------------

interface HealthBreakdown {
  total: number
  products: { score: number; max: 20; detail: string }
  recentOrders: { score: number; max: 20; detail: string }
  productQuality: { score: number; max: 20; detail: string }
  customerBase: { score: number; max: 20; detail: string }
  completeness: { score: number; max: 20; detail: string }
  recommendations: string[]
}

async function calculateHealthScore(db: Kysely<Database>, storeId: string): Promise<HealthBreakdown> {
  const recommendations: string[] = []

  // 1. Products count
  const prodResult = await db.selectFrom('products')
    .where('shop_id', '=', storeId)
    .select(sql<string>`count(*)`.as('cnt'))
    .executeTakeFirst()
  const prodCount = Number(prodResult?.cnt ?? 0)

  let productsScore: number
  let productsDetail: string
  if (prodCount > 10) { productsScore = 20; productsDetail = `${prodCount} products` }
  else if (prodCount > 5) { productsScore = 10; productsDetail = `${prodCount} products (add more for full score)` }
  else if (prodCount > 0) { productsScore = 5; productsDetail = `Only ${prodCount} products` }
  else { productsScore = 0; productsDetail = 'No products'; recommendations.push('Add products to your store') }

  // 2. Recent orders (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const recentOrdersResult = await db.selectFrom('orders')
    .where('shop_id', '=', storeId)
    .where('created_at', '>=', sevenDaysAgo)
    .select(sql<string>`count(*)`.as('cnt'))
    .executeTakeFirst()
  const recentCount = Number(recentOrdersResult?.cnt ?? 0)

  let recentOrdersScore: number
  let recentOrdersDetail: string
  if (recentCount > 10) { recentOrdersScore = 20; recentOrdersDetail = `${recentCount} orders in last 7 days` }
  else if (recentCount > 5) { recentOrdersScore = 15; recentOrdersDetail = `${recentCount} orders in last 7 days` }
  else if (recentCount > 0) { recentOrdersScore = 10; recentOrdersDetail = `${recentCount} orders in last 7 days` }
  else { recentOrdersScore = 0; recentOrdersDetail = 'No orders in last 7 days'; recommendations.push('Drive traffic to generate recent orders') }

  // 3. Product quality — % of products with images
  let productQualityScore = 0
  let productQualityDetail = 'No products to evaluate'
  if (prodCount > 0) {
    const withImagesResult = await db.selectFrom('products as p')
      .where('p.shop_id', '=', storeId)
      .leftJoin('product_images as pi', 'pi.product_id', 'p.id')
      .select(sql<string>`count(distinct case when pi.id is not null then p.id end)`.as('with_images'))
      .executeTakeFirst()
    const withImages = Number(withImagesResult?.with_images ?? 0)
    const pct = Math.round((withImages / prodCount) * 100)
    productQualityScore = Math.round((pct / 100) * 20)
    productQualityDetail = `${pct}% of products have images (${withImages}/${prodCount})`
    if (pct < 80) recommendations.push('Add images to more products for better conversion')
  }

  // 4. Customer base
  const custResult = await db.selectFrom('customers')
    .where('shop_id', '=', storeId)
    .select(sql<string>`count(*)`.as('cnt'))
    .executeTakeFirst()
  const custCount = Number(custResult?.cnt ?? 0)

  let customerScore: number
  let customerDetail: string
  if (custCount > 100) { customerScore = 20; customerDetail = `${custCount} customers` }
  else if (custCount > 50) { customerScore = 15; customerDetail = `${custCount} customers` }
  else if (custCount > 10) { customerScore = 10; customerDetail = `${custCount} customers` }
  else if (custCount > 0) { customerScore = 5; customerDetail = `Only ${custCount} customers` }
  else { customerScore = 0; customerDetail = 'No customers'; recommendations.push('Focus on customer acquisition') }

  // 5. Store completeness
  const shop = await db.selectFrom('shops')
    .where('id', '=', storeId)
    .selectAll()
    .executeTakeFirst()

  let completenessScore = 0
  const completenessChecks: string[] = []
  if (shop) {
    if (shop.domain) { completenessScore += 5; completenessChecks.push('domain') }
    else { recommendations.push('Set up a domain for your store') }
    if (shop.email) { completenessScore += 5; completenessChecks.push('email') }
    else { recommendations.push('Add a contact email') }
    if (shop.logo_url) { completenessScore += 5; completenessChecks.push('logo') }
    else { recommendations.push('Upload a store logo') }
    if (shop.phone || shop.address) { completenessScore += 5; completenessChecks.push('contact info') }
    else { recommendations.push('Add phone number or address') }
  }
  const completenessDetail = completenessChecks.length > 0
    ? `Has: ${completenessChecks.join(', ')} (${completenessScore}/20)`
    : 'Missing domain, email, logo, contact info'

  const total = productsScore + recentOrdersScore + productQualityScore + customerScore + completenessScore

  return {
    total,
    products: { score: productsScore, max: 20, detail: productsDetail },
    recentOrders: { score: recentOrdersScore, max: 20, detail: recentOrdersDetail },
    productQuality: { score: productQualityScore, max: 20, detail: productQualityDetail },
    customerBase: { score: customerScore, max: 20, detail: customerDetail },
    completeness: { score: completenessScore, max: 20, detail: completenessDetail },
    recommendations,
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/stores/:id/health — Store health score page
// ---------------------------------------------------------------------------

export async function getStoreHealth(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const storeId = req.params.id

  try {
    const shop = await db.selectFrom('shops')
      .where('id', '=', storeId)
      .select(['id', 'name', 'slug'])
      .executeTakeFirst()

    if (!shop) {
      res.status(404).send(godLayout({
        title: 'Store Not Found',
        userEmail: user.email,
        activePath: '/god-admin/stores',
        content: '<div class="card"><p style="color:var(--red)">Store not found.</p><a href="/god-admin/stores" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to Stores</a></div>',
      }))
      return
    }

    const health = await calculateHealthScore(db, storeId)
    const color = healthScoreColor(health.total)
    const label = health.total > 70 ? 'Healthy' : health.total >= 40 ? 'Needs Attention' : 'Critical'

    const categories = [
      { name: 'Products', icon: '&#128230;', ...health.products },
      { name: 'Recent Orders (7d)', icon: '&#128179;', ...health.recentOrders },
      { name: 'Product Quality', icon: '&#127912;', ...health.productQuality },
      { name: 'Customer Base', icon: '&#128101;', ...health.customerBase },
      { name: 'Store Completeness', icon: '&#9989;', ...health.completeness },
    ]

    const breakdownRows = categories.map(cat => {
      const pct = Math.round((cat.score / cat.max) * 100)
      const barColor = pct > 70 ? '#22c55e' : pct >= 40 ? '#eab308' : '#ef4444'
      return `
        <tr>
          <td style="white-space:nowrap">${cat.icon} ${esc(cat.name)}</td>
          <td style="font-weight:600;text-align:center">${cat.score}/${cat.max}</td>
          <td style="width:40%">
            <div style="background:var(--gray-700);border-radius:4px;height:8px;overflow:hidden">
              <div style="background:${barColor};height:100%;width:${pct}%;border-radius:4px;transition:width 0.3s"></div>
            </div>
          </td>
          <td style="color:var(--gray-400);font-size:13px">${esc(cat.detail)}</td>
        </tr>`
    }).join('')

    const recommendationsList = health.recommendations.length > 0
      ? `<ul style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px">${health.recommendations.map(r => `<li style="color:var(--gray-300)">${esc(r)}</li>`).join('')}</ul>`
      : '<p style="color:var(--gray-400)">No recommendations - this store is performing well!</p>'

    const content = `
      <div class="page-header">
        <h1>${esc(shop.name)} - Health Score</h1>
        <div class="action-group">
          <a href="/god-admin/stores/${shop.id}" class="btn btn-secondary btn-sm">Back to Store</a>
        </div>
      </div>

      <div class="card" style="text-align:center;padding:32px">
        <div style="font-size:64px;font-weight:700;color:${color};line-height:1">${health.total}</div>
        <div style="font-size:14px;color:${color};margin-top:4px;font-weight:600">${label}</div>
        <div style="margin-top:12px;font-size:13px;color:var(--gray-400)">out of 100 points</div>
        <div style="margin:16px auto 0;max-width:300px;background:var(--gray-700);border-radius:6px;height:10px;overflow:hidden">
          <div style="background:${color};height:100%;width:${health.total}%;border-radius:6px;transition:width 0.3s"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:16px">Score Breakdown</div>
        <table class="data-table">
          <thead>
            <tr><th>Category</th><th style="text-align:center">Score</th><th>Progress</th><th>Details</th></tr>
          </thead>
          <tbody>${breakdownRows}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:16px">Recommendations</div>
        ${recommendationsList}
      </div>`

    res.send(godLayout({
      title: `${shop.name} - Health`,
      userEmail: user.email,
      activePath: '/god-admin/stores',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Store health error:', err)
    res.status(500).send(godLayout({
      title: 'Store Health',
      userEmail: user.email,
      activePath: '/god-admin/stores',
      content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
    }))
  }
}
