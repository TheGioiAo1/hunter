/**
 * God Admin — Dashboard Page (Category A: System Overview)
 *
 * GET /god-admin
 *
 * Displays:
 * - Total revenue, orders, stores, users, customers
 * - Orders today vs yesterday (% change)
 * - Revenue today vs yesterday
 * - Top 5 stores by revenue
 * - Recent 10 orders
 * - Recent signups (last 5 users)
 * - System info
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMoney(val: string | number | null): string {
  const n = Number(val) || 0
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtNum(val: number | string | null): string {
  return Number(val || 0).toLocaleString('en-US')
}

function pctChange(today: number, yesterday: number): string {
  if (yesterday === 0) return today > 0 ? '+100%' : '0%'
  const pct = ((today - yesterday) / yesterday) * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

function pctClass(today: number, yesterday: number): string {
  if (today >= yesterday) return 'up'
  return 'down'
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    active: 'badge-green',
    paid: 'badge-green',
    fulfilled: 'badge-green',
    pending: 'badge-yellow',
    unfulfilled: 'badge-yellow',
    partial: 'badge-yellow',
    suspended: 'badge-red',
    closed: 'badge-red',
    refunded: 'badge-red',
    disabled: 'badge-red',
    draft: 'badge-gray',
  }
  const cls = map[status] || 'badge-gray'
  return `<span class="badge ${cls}">${status}</span>`
}

function escHtml(s: string | null): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function shortDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

export async function getDashboard(req: Request, res: Response, db: Kysely<Database>): Promise<void> {
  const user = req.godAdmin!.user

  // Date boundaries
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString()

  try {
    // Parallel queries
    const [
      totalRevenueRow,
      totalOrdersRow,
      totalStoresRow,
      totalUsersRow,
      totalCustomersRow,
      ordersToday,
      ordersYesterday,
      revenueToday,
      revenueYesterday,
      topStores,
      recentOrders,
      recentUsers,
      activeSessionsRow,
    ] = await Promise.all([
      // Total revenue (paid orders)
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .select(sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // Total orders
      db.selectFrom('orders')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Total active stores
      db.selectFrom('shops')
        .where('status', '=', 'active')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Total users
      db.selectFrom('users')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Total customers
      db.selectFrom('customers')
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Orders today
      db.selectFrom('orders')
        .where('created_at', '>=', todayStart)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Orders yesterday
      db.selectFrom('orders')
        .where('created_at', '>=', yesterdayStart)
        .where('created_at', '<', todayStart)
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),

      // Revenue today
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .where('created_at', '>=', todayStart)
        .select(sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // Revenue yesterday
      db.selectFrom('orders')
        .where('financial_status', '=', 'paid')
        .where('created_at', '>=', yesterdayStart)
        .where('created_at', '<', todayStart)
        .select(sql<string>`coalesce(sum(total_price::numeric), 0)`.as('total'))
        .executeTakeFirst(),

      // Top 5 stores by revenue
      // Phase 1: include s.id so the table rows can deep-link into
      // /god-admin/stores/:id and /god-admin/orders?shop_id=:id
      db.selectFrom('orders as o')
        .innerJoin('shops as s', 's.id', 'o.shop_id')
        .where('o.financial_status', '=', 'paid')
        .groupBy(['s.id', 's.name', 's.slug'])
        .select([
          's.id as shop_id',
          's.name',
          's.slug',
          sql<string>`coalesce(sum(o.total_price::numeric), 0)`.as('revenue'),
          sql<string>`count(o.id)`.as('order_count'),
        ])
        .orderBy(sql`sum(o.total_price::numeric)`, 'desc')
        .limit(5)
        .execute(),

      // Recent 10 orders
      // Phase 1: include o.shop_id so every row can deep-link into the
      // forthcoming /god-admin/orders/:id detail page, the store
      // detail, and the customer-email filtered orders list.
      // o.shop_id is a NOT NULL FK in the schema, so the link target
      // is always valid even on a LEFT JOIN miss (orphaned shop row).
      db.selectFrom('orders as o')
        .leftJoin('shops as s', 's.id', 'o.shop_id')
        .select([
          'o.id',
          'o.shop_id',
          'o.order_number',
          's.name as shop_name',
          'o.email as customer_email',
          'o.total_price',
          'o.financial_status',
          'o.fulfillment_status',
          'o.created_at',
        ])
        .orderBy('o.created_at', 'desc')
        .limit(10)
        .execute(),

      // Recent 5 users
      db.selectFrom('users')
        .select(['id', 'email', 'name', 'role', 'status', 'created_at'])
        .orderBy('created_at', 'desc')
        .limit(5)
        .execute(),

      // Active sessions
      db.selectFrom('sessions')
        .where('expires_at', '>', new Date().toISOString())
        .select(sql<string>`count(*)`.as('count'))
        .executeTakeFirst(),
    ])

    const totalRevenue = Number(totalRevenueRow?.total ?? 0)
    const totalOrders = Number(totalOrdersRow?.count ?? 0)
    const totalStores = Number(totalStoresRow?.count ?? 0)
    const totalUsers = Number(totalUsersRow?.count ?? 0)
    const totalCustomers = Number(totalCustomersRow?.count ?? 0)
    const ordersTodayN = Number(ordersToday?.count ?? 0)
    const ordersYesterdayN = Number(ordersYesterday?.count ?? 0)
    const revTodayN = Number(revenueToday?.total ?? 0)
    const revYesterdayN = Number(revenueYesterday?.total ?? 0)
    const activeSessions = Number(activeSessionsRow?.count ?? 0)

    // --------------------------------------------------------------
    // Drill-down links (Phase 1 of System Overview → Detail network)
    //
    // Every stat card is wrapped in an <a> that points at the most
    // relevant drill-down destination. The hrefs below are the single
    // source of truth — if you rename a target page, update it here.
    //
    //   Total Revenue   → Revenue Breakdown (Phase 6 Option B target)
    //                     Falls back to /finance until the dedicated
    //                     /finance/revenue page ships.
    //   Total Orders    → Orders list (all)
    //   Active Stores   → Stores list filtered by status=active
    //   Total Users     → Users list (all)
    //   Total Customers → Customers list (Phase 5 target)
    //   Orders Today    → Orders list filtered by today's date range
    //   Revenue Today   → Finance dashboard scoped to today
    //   Active Sessions → Security → Active tokens
    // --------------------------------------------------------------
    const today = new Date().toISOString().slice(0, 10)
    const statsHtml = `
      <div class="stats-grid">
        <a class="stat-card stat-card-link" href="/god-admin/finance/revenue">
          <div class="stat-label">Total Revenue</div>
          <div class="stat-value">${fmtMoney(totalRevenue)}</div>
          <div class="stat-hint">Click to break down by store, period, currency</div>
        </a>
        <a class="stat-card stat-card-link" href="/god-admin/orders">
          <div class="stat-label">Total Orders</div>
          <div class="stat-value">${fmtNum(totalOrders)}</div>
          <div class="stat-hint">Browse & filter all orders</div>
        </a>
        <a class="stat-card stat-card-link" href="/god-admin/stores?status=active">
          <div class="stat-label">Active Stores</div>
          <div class="stat-value">${fmtNum(totalStores)}</div>
          <div class="stat-hint">View merchants</div>
        </a>
        <a class="stat-card stat-card-link" href="/god-admin/users">
          <div class="stat-label">Total Users</div>
          <div class="stat-value">${fmtNum(totalUsers)}</div>
          <div class="stat-hint">Platform + store owners + staff</div>
        </a>
        <a class="stat-card stat-card-link" href="/god-admin/customers">
          <div class="stat-label">Total Customers</div>
          <div class="stat-value">${fmtNum(totalCustomers)}</div>
          <div class="stat-hint">Shoppers across all stores</div>
        </a>
        <a class="stat-card stat-card-link" href="/god-admin/orders?date_from=${today}&amp;date_to=${today}">
          <div class="stat-label">Orders Today</div>
          <div class="stat-value">${fmtNum(ordersTodayN)}</div>
          <div class="stat-change ${pctClass(ordersTodayN, ordersYesterdayN)}">${pctChange(ordersTodayN, ordersYesterdayN)} vs yesterday</div>
        </a>
        <a class="stat-card stat-card-link" href="/god-admin/finance/revenue?period=today">
          <div class="stat-label">Revenue Today</div>
          <div class="stat-value">${fmtMoney(revTodayN)}</div>
          <div class="stat-change ${pctClass(revTodayN, revYesterdayN)}">${pctChange(revTodayN, revYesterdayN)} vs yesterday</div>
        </a>
        <a class="stat-card stat-card-link" href="/god-admin/security/tokens">
          <div class="stat-label">Active Sessions</div>
          <div class="stat-value">${fmtNum(activeSessions)}</div>
          <div class="stat-hint">Currently logged-in users</div>
        </a>
      </div>
      <style>
        .stat-card-link {
          display: block;
          text-decoration: none;
          color: inherit;
          cursor: pointer;
          transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
          position: relative;
        }
        .stat-card-link:hover {
          transform: translateY(-2px);
          border-color: var(--brand, #3b82f6);
          box-shadow: 0 8px 24px -8px rgba(59, 130, 246, 0.35);
        }
        .stat-card-link::after {
          content: '\u2192';
          position: absolute;
          top: 16px;
          right: 16px;
          font-size: 14px;
          color: var(--gray-400, #94a3b8);
          opacity: 0;
          transition: opacity 0.15s ease, transform 0.15s ease;
        }
        .stat-card-link:hover::after {
          opacity: 1;
          transform: translateX(2px);
        }
        .stat-hint {
          font-size: 11px;
          color: var(--gray-400, #94a3b8);
          margin-top: 6px;
          font-weight: 500;
        }
      </style>`

    // Top 5 stores table
    // Phase 1: every cell that represents a related entity is a deep
    // link. Store name → store detail. Orders column → orders list
    // pre-filtered by shop_id. Revenue column → revenue breakdown
    // scoped to this shop.
    const topStoresRows = topStores.length > 0
      ? topStores.map((s, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><a href="/god-admin/stores/${escHtml(s.shop_id)}">${escHtml(s.name)}</a></td>
          <td class="mono">${escHtml(s.slug)}</td>
          <td><a href="/god-admin/orders?shop_id=${escHtml(s.shop_id)}">${fmtNum(s.order_count)}</a></td>
          <td><a href="/god-admin/finance/revenue?shop_id=${escHtml(s.shop_id)}"><strong>${fmtMoney(s.revenue)}</strong></a></td>
        </tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:24px">No store revenue data yet</td></tr>'

    const topStoresHtml = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Top 5 Stores by Revenue</div>
          <a href="/god-admin/stores" class="btn btn-secondary btn-sm">View All</a>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Store</th>
              <th>Slug</th>
              <th>Orders</th>
              <th>Revenue</th>
            </tr>
          </thead>
          <tbody>${topStoresRows}</tbody>
        </table>
      </div>`

    // Recent orders table
    // Phase 1 + 2: every meaningful cell links to the related entity.
    //   - Order number → order detail (Phase 2 target)
    //   - Store name   → store detail
    //   - Customer     → orders list filtered by that email
    //   - Amount       → transactions scoped to this order
    //   - Fulfillment  → fulfillment detail for this order
    const recentOrdersRows = recentOrders.length > 0
      ? recentOrders.map(o => `
        <tr>
          <td><a href="/god-admin/orders/${escHtml(o.id)}"><strong>#${o.order_number}</strong></a></td>
          <td><a href="/god-admin/stores/${escHtml(o.shop_id)}">${escHtml(o.shop_name)}</a></td>
          <td>${o.customer_email
            ? `<a href="/god-admin/orders?customer_email=${encodeURIComponent(o.customer_email)}">${escHtml(o.customer_email)}</a>`
            : '-'}</td>
          <td><a href="/god-admin/finance/transactions?order_id=${escHtml(o.id)}">${fmtMoney(o.total_price)}</a></td>
          <td>${statusBadge(o.financial_status)}</td>
          <td><a href="/god-admin/fulfillments/${escHtml(o.id)}">${statusBadge(o.fulfillment_status)}</a></td>
          <td>${shortDate(o.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:24px">No orders yet</td></tr>'

    const recentOrdersHtml = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Recent Orders</div>
          <a href="/god-admin/orders" class="btn btn-secondary btn-sm">View All</a>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Store</th>
              <th>Customer</th>
              <th>Amount</th>
              <th>Payment</th>
              <th>Fulfillment</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${recentOrdersRows}</tbody>
        </table>
      </div>`

    // Recent signups
    const recentUsersRows = recentUsers.length > 0
      ? recentUsers.map(u => `
        <tr>
          <td><a href="/god-admin/users/${u.id}">${escHtml(u.email)}</a></td>
          <td>${escHtml(u.name) || '-'}</td>
          <td>${statusBadge(u.role)}</td>
          <td>${statusBadge(u.status)}</td>
          <td>${shortDate(u.created_at)}</td>
        </tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:24px">No users yet</td></tr>'

    const recentUsersHtml = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Recent Signups</div>
          <a href="/god-admin/users" class="btn btn-secondary btn-sm">View All</a>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>${recentUsersRows}</tbody>
        </table>
      </div>`

    // System info
    const systemHtml = `
      <div class="card">
        <div class="card-title" style="margin-bottom:12px">System Info</div>
        <div class="info-row">
          <span class="info-label">Node.js Version</span>
          <span class="info-value mono">${process.version}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Platform</span>
          <span class="info-value mono">${process.platform} ${process.arch}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Active Sessions</span>
          <span class="info-value">${fmtNum(activeSessions)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Memory Usage</span>
          <span class="info-value mono">${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB</span>
        </div>
        <div class="info-row">
          <span class="info-label">Uptime</span>
          <span class="info-value mono">${Math.round(process.uptime() / 60)} min</span>
        </div>
      </div>`

    const content = `
      <div class="page-header">
        <h1>System Overview</h1>
        <div class="welcome-chip">Signed in as <strong>${escHtml(user.email)}</strong></div>
      </div>
      <style>
        .page-header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
        .welcome-chip {
          padding: 6px 12px; border-radius: 999px;
          background: rgba(59,130,246,0.12);
          border: 1px solid rgba(59,130,246,0.3);
          color: #93c5fd; font-size: 12px; font-weight: 600;
        }
      </style>
      ${statsHtml}
      <div class="two-col">
        <div>${topStoresHtml}</div>
        <div>${recentUsersHtml}</div>
      </div>
      ${recentOrdersHtml}
      ${systemHtml}
    `

    res.send(godLayout({
      title: 'Dashboard',
      userEmail: user.email,
      activePath: '/god-admin',
      content,
    }))
  } catch (err) {
    console.error('[God Admin] Dashboard error:', err)
    res.status(500).send(godLayout({
      title: 'Dashboard',
      userEmail: user.email,
      activePath: '/god-admin',
      content: `<div class="card"><p style="color:var(--red)">Error loading dashboard: ${escHtml(String(err))}</p></div>`,
    }))
  }
}
