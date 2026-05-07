/**
 * God Admin — Customers (Level 5 shoppers)
 *
 * GET /god-admin/customers        — list across every shop
 * GET /god-admin/customers/:id    — single-customer detail + AI panel
 *
 * Customers are storefront shoppers, completely separate from the
 * merchant `users` table (CLAUDE.md Rule 2). This surface lets the
 * God Admin audit spend, identify VIPs, spot abuse, and drill down
 * into order history. Read-only by design — write actions happen
 * either via the merchant's own store admin or directly on the
 * storefront.
 *
 * List page shows aggregated spend / order count / last activity
 * computed from the `orders` table at query time rather than trusting
 * the denormalized `customers.orders_count` / `customers.total_spent`
 * columns, because the seed scripts do not keep those in sync. This
 * also means the numbers always match what revenue.ts shows.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import {
  analyzeContext,
  isAiConfigured,
  type AdvisorContext,
} from '@gbox/core/modules/ai/index.js'
import { renderAiPanel, renderAiPanelUnconfigured } from '../lib/ai-panel.js'
import { aiPanelCsrf } from './ai-chat.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function shortDate(iso: string | Date | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fullDate(iso: string | Date | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function fmtMoney(amount: number | string | null, currency: string): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : (amount ?? 0)
  if (!Number.isFinite(n)) return '-'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${n.toFixed(2)} ${currency}`
  }
}

function statusBadge(status: string | null | undefined): string {
  const s = (status ?? 'unknown').toLowerCase()
  const map: Record<string, string> = {
    active: 'badge-green',
    disabled: 'badge-red',
    paid: 'badge-green',
    pending: 'badge-yellow',
    refunded: 'badge-red',
    partially_refunded: 'badge-yellow',
    voided: 'badge-gray',
    fulfilled: 'badge-green',
    unfulfilled: 'badge-gray',
    partial: 'badge-yellow',
  }
  return `<span class="badge ${map[s] || 'badge-gray'}">${esc(s)}</span>`
}

/**
 * Compute lifetime days since the first order, used to express
 * "customer tenure" in the detail page without dragging in a full
 * duration-formatting library.
 */
function daysBetween(from: string | Date, to: string | Date): number {
  const a = new Date(from).getTime()
  const b = new Date(to).getTime()
  return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)))
}

// ---------------------------------------------------------------------------
// GET /god-admin/customers — list
// ---------------------------------------------------------------------------

export async function getCustomers(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const search = ((req.query.search as string) || '').trim()
  const shopFilterRaw = ((req.query.shop_id as string) || '').trim()
  const statusFilter = ((req.query.status as string) || '').trim()
  const sortKey = ((req.query.sort as string) || 'total_spent').trim()

  // Whitelist sort keys to keep the ORDER BY clause injection-safe.
  const SORT_MAP: Record<string, { col: 'spent' | 'orders' | 'last_order' | 'created_at'; label: string }> = {
    total_spent: { col: 'spent', label: 'Total spent' },
    orders: { col: 'orders', label: 'Orders' },
    last_order: { col: 'last_order', label: 'Last order' },
    created: { col: 'created_at', label: 'Joined' },
  }
  const sort = SORT_MAP[sortKey] ?? SORT_MAP.total_spent

  try {
    // All shops for the filter dropdown
    const allShops = await db
      .selectFrom('shops')
      .select(['id', 'name', 'slug', 'currency'])
      .orderBy('name', 'asc')
      .execute()
    const shopById: Record<string, (typeof allShops)[number]> = {}
    for (const s of allShops) shopById[s.id] = s

    // Per-shop aggregates joined into a single row per customer.
    // NOTE: we intentionally group by (customer_id, shop_id, currency)
    // rather than collapsing across shops, because a single email can
    // shop in multiple Gbox stores with different presentment
    // currencies. For the list view we surface the *primary* shop
    // (the one with the highest spend) and the list-level KPIs are
    // computed off that. This is simpler than rendering one row per
    // customer-shop pair and matches how the user scrolled the board
    // on Shopify.
    let customerQuery = db
      .selectFrom('customers as c')
      .leftJoin(
        db
          .selectFrom('orders as o')
          .select([
            'o.customer_id',
            'o.shop_id',
            'o.currency',
            sql<string>`sum(o.total_price::numeric) filter (where o.financial_status in ('paid','partially_refunded'))`.as('spent'),
            sql<string>`count(*) filter (where o.financial_status in ('paid','partially_refunded','refunded'))`.as('orders'),
            sql<string>`max(o.created_at)`.as('last_order'),
          ])
          .groupBy(['o.customer_id', 'o.shop_id', 'o.currency'])
          .as('agg'),
        (join) => join.onRef('agg.customer_id', '=', 'c.id').onRef('agg.shop_id', '=', 'c.shop_id'),
      )
      .innerJoin('shops as s', 's.id', 'c.shop_id')
      .select([
        'c.id',
        'c.shop_id',
        'c.email',
        'c.first_name',
        'c.last_name',
        'c.status',
        'c.created_at',
        's.name as shop_name',
        's.slug as shop_slug',
        's.currency as shop_currency',
        sql<string>`coalesce(agg.spent, '0')`.as('spent'),
        sql<string>`coalesce(agg.orders, '0')`.as('orders'),
        sql<string | null>`agg.last_order`.as('last_order'),
      ])

    if (search) {
      const like = `%${search}%`
      customerQuery = customerQuery.where((eb) =>
        eb.or([
          eb('c.email', 'ilike', like),
          eb('c.first_name', 'ilike', like),
          eb('c.last_name', 'ilike', like),
        ]),
      )
    }
    if (shopFilterRaw) {
      customerQuery = customerQuery.where('c.shop_id', '=', shopFilterRaw)
    }
    if (statusFilter) {
      customerQuery = customerQuery.where('c.status', '=', statusFilter)
    }

    // ORDER BY uses a whitelisted column, cast numeric where appropriate.
    const sortCol = sort.col
    if (sortCol === 'spent') {
      customerQuery = customerQuery.orderBy(sql`coalesce(agg.spent, '0')::numeric`, 'desc')
    } else if (sortCol === 'orders') {
      customerQuery = customerQuery.orderBy(sql`coalesce(agg.orders, '0')::numeric`, 'desc')
    } else if (sortCol === 'last_order') {
      customerQuery = customerQuery.orderBy(sql`agg.last_order`, 'desc')
    } else {
      customerQuery = customerQuery.orderBy('c.created_at', 'desc')
    }

    const customers = await customerQuery.limit(200).execute()

    // Platform-wide KPIs (independent of the filter, so the header
    // always shows the total universe — the filter only narrows the
    // table below).
    const [totalRow, activeRow, grossRow, newMonthRow] = await Promise.all([
      db.selectFrom('customers').select(db.fn.count<number>('id').as('n')).executeTakeFirstOrThrow(),
      db.selectFrom('customers').where('status', '=', 'active').select(db.fn.count<number>('id').as('n')).executeTakeFirstOrThrow(),
      db
        .selectFrom('orders')
        .where('financial_status', 'in', ['paid', 'partially_refunded'])
        .select(sql<string>`coalesce(sum(total_price::numeric), 0)::text`.as('gross'))
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('customers')
        .where('created_at', '>', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .select(db.fn.count<number>('id').as('n'))
        .executeTakeFirstOrThrow(),
    ])

    const totalCustomers = Number(totalRow.n) || 0
    const activeCustomers = Number(activeRow.n) || 0
    const grossLifetime = Number(grossRow.gross) || 0
    const newLast30 = Number(newMonthRow.n) || 0

    // Render shop filter options
    const shopOptions = ['<option value="">All stores</option>']
      .concat(
        allShops.map(
          (s) => `<option value="${esc(s.id)}"${shopFilterRaw === s.id ? ' selected' : ''}>${esc(s.name)} (${esc(s.currency)})</option>`,
        ),
      )
      .join('')

    const rows = customers.length
      ? customers
          .map((c) => {
            const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)'
            const spent = Number(c.spent) || 0
            const orderCount = Number(c.orders) || 0
            return `
              <tr>
                <td>
                  <a href="/god-admin/customers/${esc(c.id)}" class="customer-row-link">
                    <div class="customer-row-name">${esc(name)}</div>
                    <div class="customer-row-email">${esc(c.email)}</div>
                  </a>
                </td>
                <td>${esc(c.shop_name)}</td>
                <td>${statusBadge(c.status)}</td>
                <td class="num">${orderCount}</td>
                <td class="num">${fmtMoney(spent, c.shop_currency)}</td>
                <td>${shortDate(c.last_order)}</td>
                <td>${shortDate(c.created_at)}</td>
              </tr>
            `
          })
          .join('')
      : `<tr><td colspan="7" style="text-align:center;color:var(--god-text-secondary);padding:28px">
            No customers match the current filters.
          </td></tr>`

    const content = `
      <div class="page-header">
        <h1>Customers</h1>
        <div class="page-header-sub">Storefront shoppers across every store on the platform.</div>
      </div>

      <div class="kpi-row">
        <div class="kpi-card">
          <div class="kpi-label">Total customers</div>
          <div class="kpi-value">${totalCustomers.toLocaleString()}</div>
          <div class="kpi-sub">${activeCustomers.toLocaleString()} active</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">New (30d)</div>
          <div class="kpi-value">${newLast30.toLocaleString()}</div>
          <div class="kpi-sub">Joined in the last 30 days</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Lifetime GMV</div>
          <div class="kpi-value">${fmtMoney(grossLifetime, 'USD')}</div>
          <div class="kpi-sub">Sum of paid orders (USD-equivalent ignoring FX)</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Average LTV</div>
          <div class="kpi-value">${totalCustomers > 0 ? fmtMoney(grossLifetime / totalCustomers, 'USD') : '-'}</div>
          <div class="kpi-sub">Gross GMV / customers</div>
        </div>
      </div>

      <div class="card">
        <form method="get" action="/god-admin/customers" class="toolbar">
          <input type="text" name="search" placeholder="Search by name or email..."
                 value="${esc(search)}" class="search-input" />
          <select name="shop_id" class="filter-select" onchange="this.form.submit()">
            ${shopOptions}
          </select>
          <select name="status" class="filter-select" onchange="this.form.submit()">
            <option value="">All statuses</option>
            <option value="active"${statusFilter === 'active' ? ' selected' : ''}>Active</option>
            <option value="disabled"${statusFilter === 'disabled' ? ' selected' : ''}>Disabled</option>
          </select>
          <select name="sort" class="filter-select" onchange="this.form.submit()">
            <option value="total_spent"${sortKey === 'total_spent' ? ' selected' : ''}>Sort: top spenders</option>
            <option value="orders"${sortKey === 'orders' ? ' selected' : ''}>Sort: most orders</option>
            <option value="last_order"${sortKey === 'last_order' ? ' selected' : ''}>Sort: recently active</option>
            <option value="created"${sortKey === 'created' ? ' selected' : ''}>Sort: newest</option>
          </select>
          <button type="submit" class="btn btn-primary btn-sm">Apply</button>
        </form>

        <table class="data-table customers-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Store</th>
              <th>Status</th>
              <th class="num">Orders</th>
              <th class="num">Spent</th>
              <th>Last order</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="table-footer">
          Showing ${customers.length} of ${totalCustomers.toLocaleString()} customers.
          ${customers.length >= 200 ? ' Refine the filters to narrow the view.' : ''}
        </div>
      </div>

      ${CUSTOMERS_LIST_CSS}
    `

    res.send(
      godLayout({
        title: 'Customers',
        userEmail: user.email,
        activePath: '/god-admin/customers',
        content,
      }),
    )
  } catch (err) {
    console.error('[God Admin] Customers list error:', err)
    res.status(500).send(
      godLayout({
        title: 'Customers',
        userEmail: user.email,
        activePath: '/god-admin/customers',
        content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/customers/:id — detail
// ---------------------------------------------------------------------------

export async function getCustomerDetail(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user
  const customerId = req.params.id

  try {
    const customer = await db
      .selectFrom('customers as c')
      .innerJoin('shops as s', 's.id', 'c.shop_id')
      .where('c.id', '=', customerId)
      .select([
        'c.id',
        'c.shop_id',
        'c.email',
        'c.first_name',
        'c.last_name',
        'c.phone',
        'c.status',
        'c.accepts_marketing',
        'c.tags',
        'c.note',
        'c.created_at',
        'c.updated_at',
        'c.last_login_at',
        's.name as shop_name',
        's.slug as shop_slug',
        's.currency as shop_currency',
      ])
      .executeTakeFirst()

    if (!customer) {
      res.status(404).send(
        godLayout({
          title: 'Customer not found',
          userEmail: user.email,
          activePath: '/god-admin/customers',
          content: `
            <div class="card">
              <p style="color:var(--red)">Customer not found.</p>
              <a href="/god-admin/customers" class="btn btn-secondary btn-sm" style="margin-top:12px">Back to customers</a>
            </div>`,
        }),
      )
      return
    }

    const [orders, addresses, sessionStats] = await Promise.all([
      db
        .selectFrom('orders')
        .where('customer_id', '=', customerId)
        .select([
          'id',
          'order_number',
          'financial_status',
          'fulfillment_status',
          'currency',
          'total_price',
          'subtotal_price',
          'total_tax',
          'total_shipping',
          'created_at',
        ])
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute(),
      db
        .selectFrom('customer_addresses')
        .where('customer_id', '=', customerId)
        .select([
          'id',
          'first_name',
          'last_name',
          'address1',
          'address2',
          'city',
          'province',
          'country',
          'country_code',
          'zip',
          'phone',
          'is_default',
        ])
        .orderBy('is_default', 'desc')
        .limit(10)
        .execute(),
      db
        .selectFrom('customer_sessions')
        .where('customer_id', '=', customerId)
        .where('expires_at', '>', new Date().toISOString())
        .select(db.fn.count<number>('id').as('n'))
        .executeTakeFirstOrThrow(),
    ])

    // Derived lifetime stats computed from the real orders so we
    // don't trust the potentially-stale denormalized columns.
    const paidOrders = orders.filter((o) =>
      ['paid', 'partially_refunded'].includes(o.financial_status),
    )
    const refundedOrders = orders.filter((o) =>
      ['refunded', 'partially_refunded'].includes(o.financial_status),
    )
    const lifetimeSpent = paidOrders.reduce((s, o) => s + (Number(o.total_price) || 0), 0)
    const lifetimeOrders = orders.length
    const avgOrderValue = paidOrders.length > 0 ? lifetimeSpent / paidOrders.length : 0
    const firstOrderAt = orders.length > 0 ? orders[orders.length - 1].created_at : null
    const lastOrderAt = orders.length > 0 ? orders[0].created_at : null
    const customerAgeDays = daysBetween(customer.created_at, new Date())
    const tenureDays = firstOrderAt ? daysBetween(firstOrderAt, lastOrderAt ?? new Date()) : 0
    const currency = customer.shop_currency

    const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || '(no name)'

    // Build AI advisor snapshot — the shape mirrors what the HTML
    // shows so the model's answers line up with what the operator
    // sees on screen.
    const snapshot: Record<string, unknown> = {
      customer: {
        id: customer.id,
        email: customer.email,
        name: fullName,
        phone: customer.phone,
        status: customer.status,
        shop: { name: customer.shop_name, slug: customer.shop_slug, currency },
        joined_at: customer.created_at,
        last_login_at: customer.last_login_at,
        accepts_marketing: customer.accepts_marketing,
        tags: customer.tags,
        note: customer.note,
      },
      lifetime: {
        orders: lifetimeOrders,
        paid_orders: paidOrders.length,
        refunded_orders: refundedOrders.length,
        spent: Number(lifetimeSpent.toFixed(2)),
        average_order_value: Number(avgOrderValue.toFixed(2)),
        first_order_at: firstOrderAt,
        last_order_at: lastOrderAt,
        customer_age_days: customerAgeDays,
        tenure_days: tenureDays,
      },
      recent_orders: orders.slice(0, 10).map((o) => ({
        id: o.id,
        order_number: o.order_number,
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status,
        total: Number(o.total_price),
        currency: o.currency,
        created_at: o.created_at,
      })),
      addresses: addresses.map((a) => ({
        city: a.city,
        province: a.province,
        country: a.country ?? a.country_code,
        is_default: a.is_default,
      })),
      active_sessions: Number(sessionStats.n) || 0,
    }
    const context: AdvisorContext = {
      type: 'customer',
      title: `${fullName} · ${customer.email}`,
      snapshot,
    }

    const briefPromise = isAiConfigured()
      ? analyzeContext(context).catch((err) => {
          console.error('[God Admin] Customer detail AI brief error:', err)
          return { text: `Advisor error: ${err instanceof Error ? err.message : String(err)}`, usage: null }
        })
      : Promise.resolve(null)

    // Orders table
    const ordersRows = orders.length
      ? orders
          .map(
            (o) => `
            <tr>
              <td><a href="/god-admin/orders/${esc(o.id)}" class="mono">#${o.order_number}</a></td>
              <td>${statusBadge(o.financial_status)}</td>
              <td>${statusBadge(o.fulfillment_status)}</td>
              <td class="num">${fmtMoney(o.total_price, o.currency)}</td>
              <td>${fullDate(o.created_at)}</td>
            </tr>`,
          )
          .join('')
      : `<tr><td colspan="5" style="text-align:center;color:var(--god-text-secondary);padding:24px">No orders yet.</td></tr>`

    // Addresses
    const addrBlocks = addresses.length
      ? addresses
          .map(
            (a) => `
            <div class="addr-block${a.is_default ? ' addr-default' : ''}">
              <div class="addr-name">${esc([a.first_name, a.last_name].filter(Boolean).join(' ') || '(no name)')}${a.is_default ? ' <span class="badge badge-blue">Default</span>' : ''}</div>
              <div class="addr-line">${esc(a.address1)}${a.address2 ? ', ' + esc(a.address2) : ''}</div>
              <div class="addr-line">${esc([a.city, a.province, a.zip].filter(Boolean).join(', '))}</div>
              <div class="addr-line">${esc(a.country ?? a.country_code ?? '')}</div>
              ${a.phone ? `<div class="addr-line" style="color:var(--god-text-secondary)">${esc(a.phone)}</div>` : ''}
            </div>`,
          )
          .join('')
      : `<p style="color:var(--god-text-secondary);padding:12px 0">No saved addresses.</p>`

    // Wait for AI brief (it ran in parallel with DB queries above)
    const brief = await briefPromise
    let aiPanelHtml: string
    if (!isAiConfigured()) {
      aiPanelHtml = renderAiPanelUnconfigured()
    } else {
      const csrfToken = await aiPanelCsrf.issue(res, process.env.NODE_ENV === 'production')
      aiPanelHtml = renderAiPanel({
        context,
        initialInsight: brief?.text ?? 'No advisor output available.',
        csrfToken,
        endpoint: '/god-admin/ai/chat',
        id: 'customer-ai',
      })
    }

    const content = `
      <div class="page-header">
        <div>
          <div class="page-crumb"><a href="/god-admin/customers">Customers</a> / ${esc(customer.email)}</div>
          <h1>${esc(fullName)}</h1>
          <div class="page-header-sub">
            ${esc(customer.email)} · Shop:
            <a href="/god-admin/stores/${esc(customer.shop_id)}">${esc(customer.shop_name)}</a>
          </div>
        </div>
        <div class="page-header-actions">
          ${statusBadge(customer.status)}
          <a href="/god-admin/customers" class="btn btn-secondary btn-sm">Back to customers</a>
        </div>
      </div>

      <div class="customer-grid">
        <div class="customer-main">
          <div class="kpi-row">
            <div class="kpi-card">
              <div class="kpi-label">Lifetime spent</div>
              <div class="kpi-value">${fmtMoney(lifetimeSpent, currency)}</div>
              <div class="kpi-sub">${paidOrders.length} paid order${paidOrders.length === 1 ? '' : 's'}</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Orders</div>
              <div class="kpi-value">${lifetimeOrders}</div>
              <div class="kpi-sub">${refundedOrders.length} refunded</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Avg order value</div>
              <div class="kpi-value">${fmtMoney(avgOrderValue, currency)}</div>
              <div class="kpi-sub">Across paid orders</div>
            </div>
            <div class="kpi-card">
              <div class="kpi-label">Customer age</div>
              <div class="kpi-value">${customerAgeDays}d</div>
              <div class="kpi-sub">${tenureDays}d buying tenure</div>
            </div>
          </div>

          <div class="card">
            <div class="card-title">Order history</div>
            <table class="data-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Financial</th>
                  <th>Fulfillment</th>
                  <th class="num">Total</th>
                  <th>Placed</th>
                </tr>
              </thead>
              <tbody>${ordersRows}</tbody>
            </table>
          </div>

          <div class="card">
            <div class="card-title">Addresses</div>
            <div class="addresses">${addrBlocks}</div>
          </div>
        </div>

        <aside class="customer-sidebar">
          <div class="card">
            <div class="card-title">Profile</div>
            <div class="info-row"><span class="info-label">Email</span><span class="info-value">${esc(customer.email)}</span></div>
            <div class="info-row"><span class="info-label">Phone</span><span class="info-value">${esc(customer.phone) || '-'}</span></div>
            <div class="info-row"><span class="info-label">Marketing</span><span class="info-value">${customer.accepts_marketing ? 'Yes' : 'No'}</span></div>
            <div class="info-row"><span class="info-label">Tags</span><span class="info-value">${esc((customer.tags ?? []).join(', ')) || '-'}</span></div>
            <div class="info-row"><span class="info-label">Joined</span><span class="info-value">${fullDate(customer.created_at)}</span></div>
            <div class="info-row"><span class="info-label">Last login</span><span class="info-value">${fullDate(customer.last_login_at)}</span></div>
            <div class="info-row"><span class="info-label">Active sessions</span><span class="info-value">${Number(sessionStats.n) || 0}</span></div>
            ${customer.note ? `<div class="info-row" style="display:block"><span class="info-label" style="display:block;margin-bottom:4px">Note</span><div class="info-value" style="white-space:pre-wrap">${esc(customer.note)}</div></div>` : ''}
          </div>

          ${aiPanelHtml}
        </aside>
      </div>

      ${CUSTOMER_DETAIL_CSS}
    `

    res.send(
      godLayout({
        title: `Customer · ${fullName}`,
        userEmail: user.email,
        activePath: '/god-admin/customers',
        content,
      }),
    )
  } catch (err) {
    console.error('[God Admin] Customer detail error:', err)
    res.status(500).send(
      godLayout({
        title: 'Customer',
        userEmail: user.email,
        activePath: '/god-admin/customers',
        content: `<div class="card"><p style="color:var(--red)">Error: ${esc(String(err))}</p></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// Styles — scoped to the customers pages
// ---------------------------------------------------------------------------

const CUSTOMERS_LIST_CSS = `
<style>
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
    margin-bottom: 20px;
  }
  @media (max-width: 900px) { .kpi-row { grid-template-columns: repeat(2, 1fr); } }
  .kpi-card {
    background: var(--god-card);
    border: 1px solid var(--god-border);
    border-radius: 12px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kpi-label { font-size: 12px; color: var(--god-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .kpi-value { font-size: 28px; font-weight: 700; color: var(--god-text); }
  .kpi-sub { font-size: 12px; color: var(--god-text-secondary); }

  .toolbar {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .toolbar .search-input {
    flex: 1 1 260px;
    min-width: 220px;
    padding: 9px 12px;
    border-radius: 8px;
    border: 1px solid var(--god-border);
    background: var(--god-bg);
    color: var(--god-text);
  }
  .toolbar .filter-select {
    padding: 9px 12px;
    border-radius: 8px;
    border: 1px solid var(--god-border);
    background: var(--god-bg);
    color: var(--god-text);
  }

  .customers-table td, .customers-table th { vertical-align: middle; }
  .customers-table td.num, .customers-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .customer-row-link { display: block; color: inherit; text-decoration: none; }
  .customer-row-link:hover .customer-row-name { color: var(--primary); }
  .customer-row-name { font-weight: 600; color: var(--god-text); }
  .customer-row-email { font-size: 12px; color: var(--god-text-secondary); }
  .table-footer {
    padding: 10px 4px;
    font-size: 12px;
    color: var(--god-text-secondary);
  }

  .page-header-sub { color: var(--god-text-secondary); font-size: 13px; margin-top: 4px; }
</style>
`

const CUSTOMER_DETAIL_CSS = `
<style>
  .page-crumb { font-size: 12px; color: var(--god-text-secondary); margin-bottom: 4px; }
  .page-crumb a { color: var(--god-text-secondary); text-decoration: none; }
  .page-crumb a:hover { color: var(--primary); }
  .page-header-actions { display: flex; gap: 10px; align-items: center; }
  .page-header-sub { color: var(--god-text-secondary); font-size: 13px; margin-top: 4px; }

  .customer-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    gap: 24px;
    align-items: start;
  }
  @media (max-width: 1100px) { .customer-grid { grid-template-columns: 1fr; } }
  .customer-sidebar { position: sticky; top: 24px; display: flex; flex-direction: column; gap: 16px; }

  .kpi-row {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
    margin-bottom: 20px;
  }
  @media (max-width: 900px) { .kpi-row { grid-template-columns: repeat(2, 1fr); } }
  .kpi-card {
    background: var(--god-card);
    border: 1px solid var(--god-border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kpi-label { font-size: 11px; color: var(--god-text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
  .kpi-value { font-size: 24px; font-weight: 700; color: var(--god-text); }
  .kpi-sub { font-size: 12px; color: var(--god-text-secondary); }

  .addresses {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
  }
  .addr-block {
    border: 1px solid var(--god-border);
    border-radius: 10px;
    padding: 12px 14px;
    background: var(--god-bg);
    font-size: 13px;
    line-height: 1.45;
  }
  .addr-block.addr-default { border-color: var(--primary); }
  .addr-name { font-weight: 600; margin-bottom: 4px; color: var(--god-text); }
  .addr-line { color: var(--god-text-secondary); }

  .info-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px dashed var(--god-border); }
  .info-row:last-child { border-bottom: 0; }
  .info-label { color: var(--god-text-secondary); }
  .info-value { color: var(--god-text); text-align: right; max-width: 60%; word-break: break-word; }
  .info-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

  .data-table td.num, .data-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
`
