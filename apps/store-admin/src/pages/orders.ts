/**
 * Store Admin — Orders
 *
 * Listing: tab filters, search, table with pagination
 * Detail: line items, payment, customer, fulfillment actions
 * Fulfill: POST action to mark order fulfilled
 */

import type { Request, Response } from 'express'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc as escLayout } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { addressFormHtml, addressAutocompleteScript, parseAddressFromBody, type AddressValues } from '../components/address-autocomplete.js'
import { parseFilters, serializeFilters, activeFilterCount, applyFilters } from '../lib/order-filters.js'
import { renderFilterPanel, FILTER_PANEL_CSS, FILTER_PANEL_JS } from '../lib/order-filters-ui.js'
import { listSavedOrderFilters } from './orders-saved-filters.js'
import { listAccessibleStores } from '../lib/user-stores.js'
import {
  addOrderNote,
  bulkOrderAction,
  upsertPodFile,
  type BulkOrderAction,
} from '../../../../packages/core/src/modules/orders/operations.js'
import {
  buildConversionSummary,
  computeIndicators,
  renderConversionSummaryCard,
  renderFraudAnalysisCard,
  renderFraudAnalysisModal,
  renderSessionDetailsModal,
  modalScript,
} from '../lib/fraud-analysis.js'

/* ------------------------------------------------------------------ */
/*  GET /orders — Order listing                                       */
/* ------------------------------------------------------------------ */

export async function getOrders(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // API mode fallback when no local DB — list via BE Order-Service.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    const { renderOrdersListApi } = await import('./orders-list-api.js')
    return renderOrdersListApi(req, res)
  }

  const store = req.store!
  const user = req.storeUser!

  const tab = (req.query.tab as string) || 'all'
  const search = (req.query.q as string) || ''
  const searchField = (req.query.field as string) || 'order_name'
  const perPage = [50, 100, 150].includes(parseInt(req.query.per as string, 10))
    ? parseInt(req.query.per as string, 10)
    : 50
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
  const offset = (page - 1) * perPage
  const base = `/admin/store/${store.slug}`

  // Parse filters from query (Sprint 2)
  const filters = parseFilters(req.query as Record<string, any>)
  const filterCount = activeFilterCount(filters)

  // Build base query — exclude draft orders (they live under /orders/drafts)
  let listQuery = db.selectFrom('orders')
    .select([
      'id', 'order_number', 'email', 'total_price',
      'financial_status', 'fulfillment_status', 'closed_at', 'cancelled_at',
      'tags', 'created_at',
    ])
    .where('shop_id', '=', store.id)
    .where(sql`NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[])`)

  let countQuery = db.selectFrom('orders')
    .select(db.fn.count('id').as('count'))
    .where('shop_id', '=', store.id)
    .where(sql`NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[])`)

  // Tab filter — ShopBase parity: All / Open / On hold / Closed / Chargebacks & inquiries
  const applyTabFilter = (q: any): any => {
    if (tab === 'open') {
      return q
        .where('closed_at', 'is', null)
        .where('cancelled_at', 'is', null)
        .where(sql`NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['on_hold']::text[])`)
        .where(sql`NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['archived']::text[])`)
    }
    if (tab === 'on_hold') {
      return q.where(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['on_hold']::text[]`)
    }
    if (tab === 'closed') {
      return q.where('closed_at', 'is not', null)
    }
    if (tab === 'chargebacks') {
      // v1: Chargebacks & inquiries empty — payments gateway integration will populate
      return q.where(sql`false`)
    }
    return q // 'all'
  }

  listQuery = applyTabFilter(listQuery)
  countQuery = applyTabFilter(countQuery)

  // Apply advanced filters (Sprint 2) — panel filters affect list + count, not tab stats
  if (filterCount > 0) {
    try {
      listQuery = applyFilters(listQuery, filters)
      countQuery = applyFilters(countQuery, filters)
    } catch (err: any) {
      console.error('[orders] applyFilters failed:', err.message)
    }
  }

  // Search filter — field selector (order_name, order_price, transaction_id, line_item,
  // customer_name, customer_email, variant_sku, customer_address)
  if (search) {
    const like = `%${search}%`
    const applySearch = (q: any): any => {
      switch (searchField) {
        case 'order_price': {
          const n = parseFloat(search)
          return isNaN(n) ? q.where(sql`false`) : q.where('total_price', '=', String(n))
        }
        case 'transaction_id':
          return q.where(eb => eb.exists(
            eb.selectFrom('transactions' as any)
              .select('id')
              .whereRef('transactions.order_id' as any, '=', 'orders.id')
              .where(sql`transactions.gateway_transaction_id ILIKE ${like} OR transactions.id::text ILIKE ${like}`),
          ))
        case 'line_item':
          return q.where(eb => eb.exists(
            eb.selectFrom('order_line_items' as any)
              .select('id')
              .whereRef('order_line_items.order_id' as any, '=', 'orders.id')
              .where('order_line_items.title' as any, 'ilike', like),
          ))
        case 'variant_sku':
          return q.where(eb => eb.exists(
            eb.selectFrom('order_line_items' as any)
              .select('id')
              .whereRef('order_line_items.order_id' as any, '=', 'orders.id')
              .where('order_line_items.sku' as any, 'ilike', like),
          ))
        case 'customer_name':
          return q.where(sql`
            (orders.shipping_address->>'name') ILIKE ${like}
            OR (orders.shipping_address->>'first_name') ILIKE ${like}
            OR (orders.shipping_address->>'last_name') ILIKE ${like}
            OR (orders.billing_address->>'name') ILIKE ${like}
          `)
        case 'customer_email':
          return q.where('email', 'ilike', like)
        case 'customer_address':
          return q.where(sql`
            (orders.shipping_address->>'address1') ILIKE ${like}
            OR (orders.shipping_address->>'address2') ILIKE ${like}
            OR (orders.shipping_address->>'city') ILIKE ${like}
            OR (orders.shipping_address->>'country') ILIKE ${like}
          `)
        case 'order_name':
        default: {
          const n = parseInt(search.replace(/[^0-9]/g, ''), 10)
          if (!isNaN(n)) {
            return q.where(eb => eb.or([
              eb('order_number', '=', n),
              eb('email', 'ilike', like),
            ]))
          }
          return q.where('email', 'ilike', like)
        }
      }
    }
    listQuery = applySearch(listQuery)
    countQuery = applySearch(countQuery)
  }

  // Execute queries in parallel — single aggregated stats query for all tab counts
  const tabStatsQuery = sql<{
    all_count: string
    open_count: string
    on_hold_count: string
    closed_count: string
    total_revenue: string
  }>`
    SELECT
      COUNT(*)::text AS all_count,
      COUNT(*) FILTER (
        WHERE closed_at IS NULL
          AND cancelled_at IS NULL
          AND NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['on_hold']::text[])
          AND NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['archived']::text[])
      )::text AS open_count,
      COUNT(*) FILTER (
        WHERE COALESCE(tags, ARRAY[]::text[]) @> ARRAY['on_hold']::text[]
      )::text AS on_hold_count,
      COUNT(*) FILTER (
        WHERE closed_at IS NOT NULL
      )::text AS closed_count,
      COALESCE(SUM(total_price), 0)::text AS total_revenue
    FROM orders
    WHERE shop_id = ${store.id}
      AND NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[])
  `

  const [orders, totalResult, tabStats, savedFilters, accessibleStores] = await Promise.all([
    listQuery
      .orderBy('created_at', 'desc')
      .limit(perPage)
      .offset(offset)
      .execute(),

    countQuery.executeTakeFirst(),

    tabStatsQuery.execute(db).then(r => r.rows[0]),

    listSavedOrderFilters(db, store.id, user.id),

    listAccessibleStores(db, user.id, user.role),
  ])

  const totalFiltered = Number(totalResult?.count ?? 0)
  const allCount = Number(tabStats?.all_count ?? 0)
  const openCount = Number(tabStats?.open_count ?? 0)
  const onHoldCount = Number(tabStats?.on_hold_count ?? 0)
  const closedCount = Number(tabStats?.closed_count ?? 0)
  const chargebackCount = 0 // v1: tied to payment gateway work
  const totalRevenue = Number(tabStats?.total_revenue ?? 0)
  const totalPages = Math.ceil(totalFiltered / perPage) || 1
  const fromIdx = totalFiltered === 0 ? 0 : offset + 1
  const toIdx = Math.min(offset + perPage, totalFiltered)

  // Helper to build URL with current filters preserved
  const serializedFilters = serializeFilters(filters)

  // Stable signature for comparing the current filter set against saved views.
  // Keys sorted so {a=1,b=2} and {b=2,a=1} produce the same string.
  const filterSignature = (obj: Record<string, string>): string =>
    Object.keys(obj).sort().map(k => `${k}=${obj[k]}`).join('&')
  const currentFilterSig = filterSignature(serializedFilters)
  const buildUrl = (overrides: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams()
    const merged: Record<string, string | number | undefined> = {
      tab: tab !== 'all' ? tab : undefined,
      q: search || undefined,
      field: searchField !== 'order_name' ? searchField : undefined,
      per: perPage !== 50 ? perPage : undefined,
      page: page !== 1 ? page : undefined,
      ...serializedFilters,
      ...overrides,
    }
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== '' && v !== null) params.set(k, String(v))
    }
    const qs = params.toString()
    return `${base}/orders${qs ? '?' + qs : ''}`
  }

  // Tab helper
  const tabLink = (id: string, label: string, count: number) => {
    const isActive = tab === id
    const href = buildUrl({ tab: id === 'all' ? undefined : id, page: undefined })
    return `<a href="${esc(href)}" class="tab${isActive ? ' active' : ''}">${esc(label)} <span class="tab-count">(${count})</span></a>`
  }

  // Pagination helper
  const pageLink = (p: number, label: string, disabled: boolean) => {
    if (disabled) return `<span class="pg-btn" style="opacity:0.35;pointer-events:none">${label}</span>`
    return `<a href="${esc(buildUrl({ page: p }))}" class="pg-btn">${label}</a>`
  }

  const searchFieldLabels: Record<string, string> = {
    order_name: 'Order name',
    order_price: 'Order price',
    transaction_id: 'Transaction ID',
    line_item: 'Line item name',
    customer_name: 'Customer name',
    customer_email: 'Customer Email',
    variant_sku: 'Variant SKU',
    customer_address: 'Customer address',
  }

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Orders <span style="color:var(--s-text-muted);font-weight:500;font-size:18px">(${allCount})</span></h1>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <!-- Fulfillment centralized by Gbox (Phase F0). Sellers no longer push manual fulfillments or tracking. -->
        <a href="${base}/orders/export" class="btn btn-outline" style="font-size:13px">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:4px"><path d="M10 3v10M6 9l4 4 4-4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
          Export order
        </a>
        <div class="menu-wrap">
          <button type="button" class="btn btn-outline" style="font-size:13px" onclick="toggleMenu('importMenu')">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:4px"><path d="M10 13V3M6 7l4-4 4 4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
            Import order
            <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:4px"><path d="M5 8l5 5 5-5"/></svg>
          </button>
          <div class="menu-dropdown" id="importMenu">
            <a class="menu-item" href="${base}/orders/import">From CSV</a>
            <a class="menu-item" href="${base}/orders/import?platform=shopify">From Shopify</a>
            <a class="menu-item" href="${base}/orders/import?platform=amazon">From Amazon</a>
            <a class="menu-item" href="${base}/orders/import?platform=tiktok">From TikTok</a>
            <a class="menu-item" href="${base}/orders/import?platform=etsy">From Etsy</a>
            <a class="menu-item" href="${base}/orders/import?platform=ebay">From eBay</a>
          </div>
        </div>
        <a href="${base}/orders/import-tracking" class="btn btn-outline" style="font-size:13px">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:4px"><path d="M3 10h14M10 3v14"/></svg>
          Import tracking number
        </a>
      </div>
    </div>

    <!-- STATS -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${allCount}</div>
        <div class="stat-label">Total Orders</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:${openCount > 0 ? '#0284c7' : '#059669'}">${openCount}</div>
        <div class="stat-label">Open</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">$${totalRevenue.toFixed(2)}</div>
        <div class="stat-label">Total Revenue</div>
      </div>
    </div>

    <!-- TABS + SEARCH -->
    <div class="card">
      <div class="card-header" style="flex-direction:column;gap:12px;align-items:stretch">
        <div class="tabs" style="border-bottom:1px solid var(--s-border);padding-bottom:0">
          ${tabLink('all', 'All', allCount)}
          ${tabLink('open', 'Open', openCount)}
          ${tabLink('on_hold', 'On hold', onHoldCount)}
          ${tabLink('closed', 'Closed', closedCount)}
          ${tabLink('chargebacks', 'Chargebacks & inquiries', chargebackCount)}
        </div>
        ${savedFilters.length > 0 ? `
          <div class="saved-filter-row">
            <span class="saved-filter-label">Saved views:</span>
            ${savedFilters.map(sf => {
              const sig = filterSignature(sf.filter_json)
              const isActive = sig === currentFilterSig && sig.length > 0
              const params = new URLSearchParams()
              if (tab !== 'all') params.set('tab', tab)
              for (const [k, v] of Object.entries(sf.filter_json)) params.set(k, v)
              const href = `${base}/orders${params.toString() ? '?' + params.toString() : ''}`
              return `
                <span class="saved-filter-chip${isActive ? ' active' : ''}">
                  <a href="${esc(href)}" class="saved-filter-chip-link">${esc(sf.name)}</a>
                  <form method="POST" action="${base}/orders/saved-filters/${esc(sf.id)}/delete" style="display:inline" onsubmit="return confirm('Delete saved view &quot;${esc(sf.name)}&quot;?')">
                    ${csrfHiddenField(req.csrfToken!)}
                    <button type="submit" class="saved-filter-chip-close" title="Delete saved view">&times;</button>
                  </form>
                </span>
              `
            }).join('')}
          </div>
        ` : ''}
        <form method="get" action="${base}/orders" style="display:flex;gap:8px;width:100%;flex-wrap:wrap;align-items:center">
          ${tab !== 'all' ? `<input type="hidden" name="tab" value="${esc(tab)}">` : ''}
          ${perPage !== 50 ? `<input type="hidden" name="per" value="${perPage}">` : ''}
          <div class="menu-wrap">
            <button type="button" class="input" style="display:inline-flex;align-items:center;gap:6px;min-width:150px;justify-content:space-between;cursor:pointer;background:var(--s-surface)" onclick="toggleMenu('fieldMenu')">
              <span>${esc(searchFieldLabels[searchField] || 'Order name')}</span>
              <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
            </button>
            <div class="menu-dropdown" id="fieldMenu">
              ${Object.entries(searchFieldLabels).map(([k, v]) =>
                `<a class="menu-item${searchField === k ? ' active' : ''}" href="#" data-field="${k}">${esc(v)}</a>`,
              ).join('')}
            </div>
          </div>
          <input type="hidden" name="field" id="searchField" value="${esc(searchField)}">
          <div style="position:relative;flex:1;min-width:240px">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--s-text-muted)"><circle cx="9" cy="9" r="6"/><path d="m17 17-3.5-3.5"/></svg>
            <input type="text" name="q" value="${esc(search)}" placeholder="Search by order name, transaction id, line item name.." class="input" style="padding-left:30px;width:100%">
          </div>
          <button type="submit" class="btn btn-outline btn-sm">Search</button>
          ${search ? `<a href="${esc(buildUrl({ q: undefined, page: undefined }))}" class="btn btn-outline btn-sm">Clear</a>` : ''}
          <div class="menu-wrap">
            <button type="button" class="btn btn-outline btn-sm" onclick="toggleMenu('currentStoreMenu')">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:4px"><path d="M3 8l2-4h10l2 4M3 8v9h14V8M3 8h14M8 13h4"/></svg>
              ${esc(store.name)}
              <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:4px"><path d="M5 8l5 5 5-5"/></svg>
            </button>
            <div class="menu-dropdown" id="currentStoreMenu" style="min-width:240px;max-height:320px;overflow-y:auto">
              <div style="padding:8px 12px 4px;font-size:11px;color:var(--s-text-muted);text-transform:uppercase;letter-spacing:.04em">Switch store</div>
              ${accessibleStores.length === 0 ? `
                <div class="menu-item" style="opacity:0.6;cursor:default;pointer-events:none;font-size:11px">No other stores</div>
              ` : accessibleStores.map(s => `
                <a class="menu-item${s.slug === store.slug ? ' active' : ''}" href="/admin/store/${esc(s.slug)}/orders" title="${esc(s.name)}">
                  ${s.slug === store.slug ? '✓ ' : ''}${esc(s.name)}
                </a>
              `).join('')}
            </div>
          </div>
          <button type="button" class="btn btn-outline btn-sm" onclick="openFilterPanel()">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:4px"><path d="M3 5h14M6 10h8M9 15h2"/></svg>
            Filters${filterCount > 0 ? ` <span class="badge" style="background:var(--s-accent,#6366f1);color:#fff;padding:1px 6px;border-radius:10px;font-size:11px;margin-left:4px">${filterCount}</span>` : ''}
          </button>
          ${filterCount > 0 ? `
            <button type="button" class="btn btn-outline btn-sm" onclick="openSaveViewModal()" title="Save current filter set as a named view">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:4px"><path d="M4 4h9l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z"/><path d="M7 4v4h6V4M7 13h6"/></svg>
              Save view
            </button>
          ` : ''}
        </form>
      </div>

      <!-- BULK ACTION BAR (hidden until selection) -->
      <div class="bulk-bar" id="bulkBar" style="display:none">
        <div class="bulk-bar-inner">
          <span class="bulk-count"><span id="bulkCount">0</span> selected</span>
          <form method="POST" action="${base}/orders/bulk" id="bulkForm" style="display:flex;gap:8px;align-items:center">
            ${csrfHiddenField(req.csrfToken!)}
            <input type="hidden" name="ids" id="bulkIds">
            <select name="action" id="bulkAction" class="bulk-select" onchange="toggleTagInput()">
              <option value="">Actions</option>
              <option value="archive">Archive</option>
              <option value="cancel">Cancel</option>
              <option value="mark_paid">Mark as paid</option>
              <option value="add_tag">Add tag</option>
            </select>
            <input type="text" name="tag" id="bulkTagInput" class="input" placeholder="Tag name..." style="display:none;width:140px;padding:4px 8px;font-size:12px">
            <button type="submit" class="btn btn-primary btn-sm" onclick="return confirm('Apply bulk action to selected orders?')">Apply</button>
          </form>
          <button class="btn btn-outline btn-sm" onclick="clearSelection()">Deselect all</button>
        </div>
      </div>

      <div class="card-body" style="padding:0">
        ${orders.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:32px;padding-left:16px"><input type="checkbox" id="selectAll" onchange="toggleAll(this.checked)" class="bulk-check"></th>
                  <th>Order</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Fulfillment Status</th>
                  <th>Payment status</th>
                  <th style="text-align:right">Total</th>
                </tr>
              </thead>
              <tbody>
                ${orders.map(o => {
                  const date = new Date(o.created_at as string)
                  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  const payment = o.financial_status || 'pending'
                  const fulfillment = o.fulfillment_status || 'unfulfilled'
                  const payBadge = payment === 'paid' ? 'badge-success' : payment === 'refunded' ? 'badge-danger' : 'badge-warning'
                  const fulBadge = fulfillment === 'fulfilled' ? 'badge-success' : fulfillment === 'closed' ? 'badge-muted' : 'badge-warning'

                  return `
                    <tr class="order-row" data-id="${esc(o.id)}">
                      <td style="padding-left:16px"><input type="checkbox" class="bulk-check row-check" value="${esc(o.id)}" onchange="updateBulk()"></td>
                      <td>
                        <a href="${base}/orders/${o.id}" style="color:var(--s-accent);text-decoration:none;font-weight:600">#${esc(String(o.order_number))}</a>
                      </td>
                      <td style="color:var(--s-text-muted);font-size:13px">${dateStr}</td>
                      <td>${esc(o.email || 'N/A')}</td>
                      <td><span class="badge ${fulBadge}">${esc(fulfillment)}</span></td>
                      <td><span class="badge ${payBadge}">${esc(payment)}</span></td>
                      <td style="text-align:right;font-weight:600">$${Number(o.total_price).toFixed(2)}</td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <p style="color:var(--s-text-muted);font-size:13px;text-align:center;padding:40px">
            ${search ? 'No orders match your search.' : 'No orders yet.'}
          </p>
        `}
      </div>

      <!-- PAGINATION -->
      <div class="pg-bar">
        <div class="pg-left">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--s-text-muted)">
            Row per page
            <select class="input" style="padding:4px 8px;font-size:12px;width:auto" onchange="const u=new URL(location.href);u.searchParams.set('per',this.value);u.searchParams.delete('page');location.href=u.toString()">
              <option value="50"${perPage === 50 ? ' selected' : ''}>50</option>
              <option value="100"${perPage === 100 ? ' selected' : ''}>100</option>
              <option value="150"${perPage === 150 ? ' selected' : ''}>150</option>
            </select>
          </label>
        </div>
        <div class="pg-right">
          <span style="font-size:12px;color:var(--s-text-muted);margin-right:12px">
            ${fromIdx}-${toIdx} of ${totalFiltered}
          </span>
          ${pageLink(page - 1, '&lt;', page === 1)}
          ${pageLink(page + 1, '&gt;', page >= totalPages)}
        </div>
      </div>
    </div>

    <!-- FILTERS PANEL (Sprint 2) -->
    ${renderFilterPanel({
      f: filters,
      formAction: `${base}/orders`,
      preservedParams: {
        ...(tab !== 'all' ? { tab } : {}),
        ...(search ? { q: search } : {}),
        ...(searchField !== 'order_name' ? { field: searchField } : {}),
        ...(perPage !== 50 ? { per: String(perPage) } : {}),
      },
    })}

    <!-- SAVE VIEW MODAL (Sprint 3) -->
    <div class="save-view-backdrop" id="saveViewBackdrop" onclick="closeSaveViewModal()"></div>
    <div class="save-view-modal" id="saveViewModal" role="dialog" aria-labelledby="saveViewTitle">
      <div class="save-view-header">
        <h3 id="saveViewTitle">Save filter view</h3>
        <button type="button" class="save-view-close" onclick="closeSaveViewModal()" aria-label="Close">&times;</button>
      </div>
      <form method="POST" action="${base}/orders/saved-filters">
        ${csrfHiddenField(req.csrfToken!)}
        ${tab !== 'all' ? `<input type="hidden" name="tab" value="${esc(tab)}">` : ''}
        ${Object.entries(serializedFilters).map(([k, v]) =>
          `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
        ).join('')}
        <div class="save-view-body">
          <label class="save-view-label" for="saveViewName">View name</label>
          <input type="text" id="saveViewName" name="name" maxlength="80" required
                 placeholder="e.g. High risk unfulfilled"
                 class="input" style="width:100%">
          <p class="save-view-hint">
            Saves the current ${filterCount} filter${filterCount === 1 ? '' : 's'} as a named view you can re-apply later.
            Only visible to you.
          </p>
        </div>
        <div class="save-view-footer">
          <button type="button" class="btn btn-outline btn-sm" onclick="closeSaveViewModal()">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Save view</button>
        </div>
      </form>
    </div>

    <style>
      .bulk-bar {
        position:sticky; top:0; z-index:50; margin-bottom:12px;
        background:var(--s-accent, #6366f1); border-radius:10px; padding:8px 16px;
        animation:slideDown .2s ease;
      }
      @keyframes slideDown { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
      .bulk-bar-inner { display:flex; align-items:center; gap:12px; }
      .bulk-count { color:#fff; font-size:13px; font-weight:600; }
      .bulk-select {
        padding:6px 10px; border-radius:6px; font-size:12px;
        border:1px solid rgba(255,255,255,.3); background:rgba(255,255,255,.15);
        color:#fff; cursor:pointer;
      }
      .bulk-bar .btn-primary { background:rgba(255,255,255,.2); border-color:rgba(255,255,255,.3); color:#fff; }
      .bulk-bar .btn-outline { color:#fff; border-color:rgba(255,255,255,.3); }
      .bulk-check { width:16px; height:16px; cursor:pointer; accent-color:var(--s-accent, #6366f1); }
      .order-row.selected { background:rgba(99,102,241,.06); }

      /* Tab counts (ShopBase-style) */
      .tabs { display:flex; gap:2px; }
      .tab { padding:10px 16px; font-size:13px; color:var(--s-text-muted); text-decoration:none; border-bottom:2px solid transparent; margin-bottom:-1px; transition:color .15s,border-color .15s; }
      .tab:hover { color:var(--s-text); }
      .tab.active { color:var(--s-accent, #6366f1); border-bottom-color:var(--s-accent, #6366f1); font-weight:600; }
      .tab-count { color:var(--s-text-muted); font-size:12px; font-weight:400; }
      .tab.active .tab-count { color:var(--s-accent, #6366f1); }

      /* Dropdown menus — use --s-card (themed) not --s-surface with a
         hard-coded dark fallback, which silently produced a black dropdown
         on the light theme. --s-surface is aliased to --s-card in
         seller-layout, but referencing --s-card directly here makes the
         dependency obvious. */
      .menu-wrap { position:relative; display:inline-block; }
      .menu-dropdown {
        display:none; position:absolute; top:calc(100% + 4px); right:0; z-index:100;
        min-width:180px; background:var(--s-card); border:1px solid var(--s-border);
        border-radius:8px; padding:4px; box-shadow:var(--s-shadow, 0 8px 24px rgba(0,0,0,.24));
      }
      .menu-dropdown.open { display:block; }
      .menu-item {
        display:block; padding:8px 12px; font-size:13px; color:var(--s-text);
        text-decoration:none; border-radius:6px; cursor:pointer; transition:background .15s;
      }
      .menu-item:hover { background:var(--s-hover, rgba(99,102,241,.08)); }
      .menu-item.active { background:var(--s-accent, #6366f1); color:#fff; }

      /* Pagination bar */
      .pg-bar {
        display:flex; align-items:center; justify-content:space-between;
        padding:12px 16px; border-top:1px solid var(--s-border);
      }
      .pg-left, .pg-right { display:flex; align-items:center; gap:4px; }
      .pg-btn {
        display:inline-flex; align-items:center; justify-content:center;
        min-width:28px; height:28px; padding:0 8px; font-size:13px;
        border:1px solid var(--s-border); border-radius:6px;
        background:var(--s-surface); color:var(--s-text);
        text-decoration:none; cursor:pointer; transition:background .15s,border-color .15s;
      }
      .pg-btn:hover { background:var(--s-hover, rgba(99,102,241,.08)); border-color:var(--s-accent, #6366f1); }

      /* Saved filter chips (Sprint 3) */
      .saved-filter-row {
        display:flex; align-items:center; gap:6px; flex-wrap:wrap;
        padding:8px 0 2px 0;
      }
      .saved-filter-label {
        font-size:11px; color:var(--s-text-muted); text-transform:uppercase;
        letter-spacing:.04em; margin-right:4px;
      }
      .saved-filter-chip {
        display:inline-flex; align-items:center; gap:4px;
        padding:3px 4px 3px 10px; font-size:12px;
        background:var(--s-surface); border:1px solid var(--s-border);
        border-radius:12px; color:var(--s-text);
        transition:background .15s, border-color .15s;
      }
      .saved-filter-chip:hover { border-color:var(--s-accent, #6366f1); }
      .saved-filter-chip.active {
        background:rgba(99,102,241,.12);
        border-color:var(--s-accent, #6366f1);
        color:var(--s-accent, #6366f1);
        font-weight:600;
      }
      .saved-filter-chip-link { color:inherit; text-decoration:none; }
      .saved-filter-chip-close {
        display:inline-flex; align-items:center; justify-content:center;
        width:16px; height:16px; padding:0; margin:0;
        font-size:14px; line-height:1;
        background:transparent; border:none; color:var(--s-text-muted);
        cursor:pointer; border-radius:50%;
      }
      .saved-filter-chip-close:hover { background:var(--s-hover, rgba(99,102,241,.16)); color:var(--s-text); }

      /* Save view modal (Sprint 3) */
      .save-view-backdrop {
        display:none; position:fixed; inset:0; z-index:200;
        background:rgba(0,0,0,.4);
      }
      .save-view-backdrop.open { display:block; }
      .save-view-modal {
        display:none; position:fixed; z-index:201;
        top:50%; left:50%; transform:translate(-50%, -50%);
        width:420px; max-width:calc(100vw - 32px);
        background:var(--s-surface, #1a1b23); border:1px solid var(--s-border);
        border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,.4);
      }
      .save-view-modal.open { display:block; }
      .save-view-header {
        display:flex; align-items:center; justify-content:space-between;
        padding:14px 16px; border-bottom:1px solid var(--s-border);
      }
      .save-view-header h3 { margin:0; font-size:15px; font-weight:600; }
      .save-view-close {
        background:transparent; border:none; color:var(--s-text-muted);
        font-size:22px; line-height:1; cursor:pointer; padding:0 4px;
      }
      .save-view-close:hover { color:var(--s-text); }
      .save-view-body { padding:16px; }
      .save-view-label { display:block; font-size:12px; font-weight:600; margin-bottom:6px; }
      .save-view-hint { font-size:11px; color:var(--s-text-muted); margin:8px 0 0 0; }
      .save-view-footer {
        display:flex; justify-content:flex-end; gap:8px;
        padding:12px 16px; border-top:1px solid var(--s-border);
      }

      ${FILTER_PANEL_CSS}
    </style>

    <script>
    function toggleAll(checked) {
      document.querySelectorAll('.row-check').forEach(cb => { cb.checked = checked; cb.closest('tr').classList.toggle('selected', checked); });
      updateBulk();
    }
    function updateBulk() {
      const checks = [...document.querySelectorAll('.row-check:checked')];
      const bar = document.getElementById('bulkBar');
      const count = document.getElementById('bulkCount');
      const ids = document.getElementById('bulkIds');
      if (checks.length > 0) {
        bar.style.display = 'block';
        count.textContent = checks.length;
        ids.value = checks.map(c => c.value).join(',');
      } else {
        bar.style.display = 'none';
      }
      document.querySelectorAll('.row-check').forEach(cb => {
        cb.closest('tr').classList.toggle('selected', cb.checked);
      });
      document.getElementById('selectAll').checked = checks.length === document.querySelectorAll('.row-check').length && checks.length > 0;
    }
    function clearSelection() {
      document.querySelectorAll('.row-check').forEach(cb => { cb.checked = false; cb.closest('tr').classList.remove('selected'); });
      document.getElementById('selectAll').checked = false;
      document.getElementById('bulkBar').style.display = 'none';
    }
    function toggleTagInput() {
      const sel = document.getElementById('bulkAction');
      const tagInput = document.getElementById('bulkTagInput');
      tagInput.style.display = sel.value === 'add_tag' ? 'inline-block' : 'none';
    }

    /* ShopBase-style dropdown menus */
    function toggleMenu(id) {
      const menu = document.getElementById(id);
      const isOpen = menu.classList.contains('open');
      document.querySelectorAll('.menu-dropdown').forEach(m => m.classList.remove('open'));
      if (!isOpen) menu.classList.add('open');
    }
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) {
        document.querySelectorAll('.menu-dropdown').forEach(m => m.classList.remove('open'));
      }
    });

    /* Field selector click → set hidden input + submit */
    document.querySelectorAll('#fieldMenu .menu-item[data-field]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('searchField').value = el.dataset.field;
        el.closest('form').submit();
      });
    });

    /* Save view modal (Sprint 3) */
    function openSaveViewModal() {
      document.getElementById('saveViewBackdrop').classList.add('open');
      document.getElementById('saveViewModal').classList.add('open');
      const input = document.getElementById('saveViewName');
      if (input) setTimeout(() => input.focus(), 30);
    }
    function closeSaveViewModal() {
      document.getElementById('saveViewBackdrop').classList.remove('open');
      document.getElementById('saveViewModal').classList.remove('open');
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSaveViewModal();
    });

    ${FILTER_PANEL_JS}
    </script>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Orders',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'orders',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

/* ------------------------------------------------------------------ */
/*  GET /orders/:id — Order detail (FULL)                             */
/* ------------------------------------------------------------------ */

export async function getOrderDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // API mode fallback when no local DB — fetch single order via BE Order-Service.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    const { renderOrderDetailApi } = await import('./orders-list-api.js')
    return renderOrderDetailApi(req, res)
  }

  const store = req.store!
  const user = req.storeUser!
  const orderId = req.params.id || req.params.orderId
  const base = `/admin/store/${store.slug}`
  const successMsg = req.query.success as string | undefined
  const errorMsg = req.query.error as string | undefined
  const editMode = req.query.edit === '1'
  // Read Google Maps API key from platform_settings (set via God Admin > Config > Integrations)
  const placesRow = await db.selectFrom('platform_settings' as any)
    .select(['value'])
    .where('key', '=', 'google_maps_api_key')
    .executeTakeFirst()
    .catch(() => null)
  const PLACES_KEY = placesRow ? String((placesRow as any).value ?? '').replace(/^"|"$/g, '') : (process.env.GOOGLE_PLACES_API_KEY || '')

  // 6-way parallel fetch: order, line items, fulfillments, refund requests, transactions, timeline
  const [order, lineItems, fulfillments, refundRequests, transactions, orderEvents, podFiles] = await Promise.all([
    db.selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .executeTakeFirst(),

    db.selectFrom('order_line_items as oli')
      .leftJoin('products as p', 'p.id', 'oli.product_id')
      .leftJoin('product_variants as pv', 'pv.id', 'oli.variant_id')
      .select([
        'oli.id', 'oli.title', 'oli.variant_title', 'oli.sku',
        'oli.quantity', 'oli.price', 'oli.total_discount', 'oli.fulfillment_status',
        'oli.properties',
        'p.title as product_title', 'pv.title as pv_title',
      ])
      .innerJoin('orders as o', 'o.id', 'oli.order_id')
      .where('o.id', '=', orderId)
      .where('o.shop_id', '=', store.id)
      .execute(),

    db.selectFrom('fulfillments')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .execute(),

    db.selectFrom('refund_requests')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .execute(),

    // Transactions (payment gateway records)
    db.selectFrom('transactions')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .execute()
      .catch(() => [] as any[]),

    // Order timeline events
    db.selectFrom('order_events')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'desc')
      .execute()
      .catch(() => [] as any[]),

    // POD files for line items
    db.selectFrom('pod_files')
      .selectAll()
      .where('order_id', '=', orderId)
      .where('shop_id', '=', store.id)
      .execute()
      .catch(() => [] as any[]),
  ])

  if (!order) {
    const theme = (req as any).theme || 'dark'
    res.status(404).send(sellerLayout({
      title: 'Order not found',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'orders', theme: theme as 'dark' | 'light',
      content: `
        <div class="page-header"><div>
          <h1 class="page-title">Order not found</h1>
          <p class="page-subtitle">This order does not exist or belongs to another store.</p>
        </div></div>
        <a href="${base}/orders" class="btn btn-outline">Back to orders</a>
      `,
    }))
    return
  }

  // --- Data prep ---
  const orderDate = new Date(order.created_at as string)
  const dateStr = orderDate.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const payment = order.financial_status || 'pending'
  const fulfillment = order.fulfillment_status || 'unfulfilled'
  const payBadge = payment === 'paid' ? 'badge-success' : payment === 'refunded' ? 'badge-danger' : 'badge-warning'
  const fulBadge = fulfillment === 'fulfilled' ? 'badge-success' : fulfillment === 'closed' ? 'badge-muted' : 'badge-warning'
  const currency = String(order.currency || 'USD').toUpperCase()
  const currSym = currency === 'VND' ? '' : '$'
  const currSuffix = currency === 'VND' ? ' VND' : ''
  const fmt = (n: number | string) => `${currSym}${Number(n).toFixed(2)}${currSuffix}`

  const subtotal = lineItems.reduce((sum, li) => sum + Number(li.price) * Number(li.quantity), 0)
  const shippingAddr: AddressValues = (order.shipping_address || {}) as AddressValues
  const billingAddr: AddressValues = (order.billing_address || {}) as AddressValues
  const tags: string[] = Array.isArray(order.tags) ? order.tags : []

  // Fraud Analysis + Conversion Summary — parallel queries for the
  // ShopBase-parity sidebar cards.
  //
  //   - isFirstOrder: true if this is the customer's only paid order. We
  //     count all orders by customer_id including this one; `=== 1`
  //     means it's their first.
  //   - helpPages: CMS pages seeded at store creation (migration 027 +
  //     default-help-pages.ts). The "Learn more" links inside the Fraud
  //     Analysis modal point to these, so guidance lives inside the
  //     merchant's own admin rather than an external help center.
  const [customerOrderCountRow, helpPages] = await Promise.all([
    order.customer_id
      ? db.selectFrom('orders')
          .select(db.fn.count<number>('id').as('n'))
          .where('shop_id', '=', store.id)
          .where('customer_id', '=', order.customer_id)
          .executeTakeFirst()
          .catch(() => null)
      : Promise.resolve(null),
    db.selectFrom('pages')
      .select(['id', 'slug'])
      .where('shop_id', '=', store.id)
      .where('slug', 'in', ['fraud-analysis', 'prevent-fraud'])
      .execute()
      .catch(() => [] as Array<{ id: string; slug: string }>),
  ])

  const isFirstOrder = customerOrderCountRow ? Number((customerOrderCountRow as any).n) === 1 : false
  const fraudPage = helpPages.find(p => p.slug === 'fraud-analysis')
  const preventPage = helpPages.find(p => p.slug === 'prevent-fraud')
  const fraudLinks = {
    fraudAnalysisPageUrl: fraudPage ? `${base}/online-store/pages/${fraudPage.id}` : null,
    preventFraudPageUrl: preventPage ? `${base}/online-store/pages/${preventPage.id}` : null,
  }

  const conversionSummary = buildConversionSummary(order as any, isFirstOrder)
  const fraudIndicators = computeIndicators(order as any, transactions as any[])

  const SESSION_MODAL_ID = 'gbox-session-modal'
  const FRAUD_MODAL_ID = 'gbox-fraud-modal'

  // Build POD file lookup map: line_item_id -> pod file
  const podMap = new Map<string, any>()
  for (const pf of podFiles) podMap.set(pf.line_item_id, pf)

  const csrfToken = (req as any).csrfToken || ''

  // Helper: render address block
  const renderAddr = (addr: AddressValues, label: string) => {
    const name = [addr.first_name, addr.last_name].filter(Boolean).join(' ')
    const lines = [name, addr.company, addr.address1, addr.address2,
      [addr.city, addr.province, addr.zip].filter(Boolean).join(', '),
      addr.country,
    ].filter(Boolean)
    if (lines.length === 0) return `<p style="color:var(--s-text-dim);font-size:12px;font-style:italic">No ${label.toLowerCase()} provided</p>`
    return lines.map(l => `<div style="font-size:13px;color:var(--s-text)">${esc(String(l))}</div>`).join('')
      + (addr.phone ? `<div style="font-size:12px;color:var(--s-text-muted);margin-top:4px">Tel: ${esc(addr.phone)}</div>` : '')
  }

  // ====================== BUILD HTML ======================
  // Wrap everything in a ShopBase-style centered container (max-width
  // 1100px) so the order detail feels focused instead of sprawling
  // edge-to-edge on wide monitors. The main-area flex child already
  // handles horizontal padding, so margin:0 auto is enough.
  const content = `
    <div style="max-width:1100px;margin:0 auto">
    ${successMsg ? `<div style="background:var(--s-success-bg,#065f46);color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(successMsg === 'converted' ? 'Draft order successfully converted to a paid order.' : successMsg === 'updated' ? 'Order updated successfully.' : successMsg)}</div>` : ''}
    ${errorMsg ? `<div style="background:#7f1d1d;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(decodeURIComponent(errorMsg))}</div>` : ''}

    <!-- PAGE HEADER -->
    <div class="page-header">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="${base}/orders" style="color:var(--s-text-muted);text-decoration:none;font-size:20px" title="Back to orders">&larr;</a>
        <div>
          <h1 class="page-title" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            Order #${esc(String(order.order_number))}
            <span class="badge ${payBadge}" style="font-size:12px">${esc(payment)}</span>
            <span class="badge ${fulBadge}" style="font-size:12px">${esc(fulfillment)}</span>
          </h1>
          <p class="page-subtitle">${dateStr}</p>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${!editMode ? `<a href="${base}/orders/${orderId}?edit=1" class="btn btn-outline" style="font-size:13px">Edit Order</a>` : ''}
        <!-- Fulfillment handled by Gbox (Phase F0) — button removed from seller UI -->
        <a href="${base}/orders/${orderId}/return" class="btn btn-outline" style="font-size:13px">Create Return</a>
        <a href="${base}/refund-requests/new?orderId=${order.id}" class="btn btn-outline" style="font-size:13px">Request Refund</a>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 380px;gap:20px">
      <!-- ==================== LEFT COLUMN ==================== -->
      <div>
        <!-- LINE ITEMS + POD -->
        <div class="card">
          <div class="card-header">
            <span>Items</span>
            <span class="badge badge-muted">${lineItems.length} item${lineItems.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="card-body" style="padding:0">
            ${lineItems.length > 0 ? `
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style="min-width:180px">Product</th>
                      <th>SKU</th>
                      <th style="text-align:center">Qty</th>
                      <th style="text-align:right">Unit Price</th>
                      <th style="text-align:right">Discount</th>
                      <th style="text-align:right">Total</th>
                      <th style="text-align:center">POD</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${lineItems.map((li: any) => {
                      const title = li.title || li.product_title || 'Unknown product'
                      const variant = li.variant_title || li.pv_title || ''
                      const sku = li.sku || '-'
                      const price = Number(li.price)
                      const qty = Number(li.quantity)
                      const disc = Number(li.total_discount || 0)
                      const lineTotal = price * qty - disc
                      const pod = podMap.get(li.id)
                      return `
                        <tr>
                          <td>
                            <div style="font-weight:500;font-size:13px">${esc(title)}</div>
                            ${variant ? `<div style="color:var(--s-text-muted);font-size:12px">${esc(variant)}</div>` : ''}
                          </td>
                          <td style="font-family:monospace;font-size:12px;color:var(--s-text-muted)">${esc(sku)}</td>
                          <td style="text-align:center">${qty}</td>
                          <td style="text-align:right">${fmt(price)}</td>
                          <td style="text-align:right;color:${disc > 0 ? 'var(--s-success)' : 'var(--s-text-dim)'}">${disc > 0 ? '-' + fmt(disc) : '-'}</td>
                          <td style="text-align:right;font-weight:600">${fmt(lineTotal)}</td>
                          <td style="text-align:center">
                            ${pod ? `
                              <a href="${esc(pod.file_url)}" target="_blank" rel="noopener" style="color:var(--s-accent);text-decoration:none;font-size:12px;display:inline-flex;align-items:center;gap:4px" title="${esc(pod.filename)}">
                                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="8" cy="8" r="2"/><path d="M3 14l4-4 3 3 2-2 5 5"/></svg>
                                View
                              </a>
                            ` : `
                              <span style="color:var(--s-text-dim);font-size:11px">—</span>
                            `}
                          </td>
                        </tr>
                      `
                    }).join('')}
                  </tbody>
                </table>
              </div>

              <!-- TOTALS BREAKDOWN -->
              <div style="border-top:1px solid var(--s-border);padding:16px 20px;display:flex;flex-direction:column;gap:6px;align-items:flex-end">
                <div style="display:grid;grid-template-columns:140px 100px;gap:4px;font-size:13px">
                  <span style="color:var(--s-text-muted)">Subtotal</span>
                  <span style="text-align:right;font-weight:500">${fmt(subtotal)}</span>

                  <span style="color:var(--s-text-muted)">Discount</span>
                  <span style="text-align:right;color:var(--s-success)">${Number(order.total_discounts) > 0 ? '-' + fmt(order.total_discounts) : fmt(0)}</span>

                  <span style="color:var(--s-text-muted)">Shipping</span>
                  <span style="text-align:right">${fmt(order.total_shipping)}</span>

                  <span style="color:var(--s-text-muted)">Tax / VAT</span>
                  <span style="text-align:right">${fmt(order.total_tax)}</span>
                </div>

                <div style="display:grid;grid-template-columns:140px 100px;gap:4px;border-top:2px solid var(--s-border);padding-top:8px;margin-top:4px">
                  <span style="font-size:15px;font-weight:700">Total</span>
                  <span style="text-align:right;font-size:15px;font-weight:700">${fmt(order.total_price)}</span>
                </div>
              </div>
            ` : '<p style="color:var(--s-text-muted);font-size:13px;text-align:center;padding:20px">No line items</p>'}
          </div>
        </div>

        <!-- FULFILLMENT STATUS -->
        <div class="card" style="margin-top:20px">
          <div class="card-header">
            <span>Fulfillment</span>
            <span class="badge ${fulBadge}">${esc(fulfillment)}</span>
          </div>
          <div class="card-body">
            ${fulfillment === 'fulfilled' || fulfillments.length > 0 ? `
              ${fulfillments.map((f: any, idx: number) => {
                const shippedDate = f.shipped_at ? new Date(f.shipped_at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
                const fStatus = f.status || 'success'
                const fBadge = fStatus === 'success' ? 'badge-success' : fStatus === 'cancelled' || fStatus === 'failure' ? 'badge-danger' : 'badge-warning'
                return `
                  <div style="border:1px solid var(--s-border);border-radius:8px;padding:12px 16px;${idx > 0 ? 'margin-top:12px;' : ''}font-size:13px">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                      <span style="font-weight:600">Fulfillment ${fulfillments.length > 1 ? '#' + (idx + 1) : ''}</span>
                      <span class="badge ${fBadge}">${esc(fStatus)}</span>
                    </div>
                    <div style="display:grid;grid-template-columns:100px 1fr;gap:6px 12px">
                      ${f.tracking_company ? `<span style="color:var(--s-text-muted)">Carrier</span><span style="font-weight:500">${esc(String(f.tracking_company))}</span>` : ''}
                      ${f.tracking_number ? `
                        <span style="color:var(--s-text-muted)">Tracking</span>
                        <span>
                          <code style="font-size:12px;background:var(--s-bg);padding:2px 6px;border-radius:4px">${esc(String(f.tracking_number))}</code>
                          ${f.tracking_url ? ` <a href="${esc(String(f.tracking_url))}" target="_blank" rel="noopener" style="color:var(--s-accent);text-decoration:none;font-size:12px">Track &rarr;</a>` : ''}
                        </span>
                      ` : ''}
                      ${shippedDate ? `<span style="color:var(--s-text-muted)">Shipped</span><span>${shippedDate}</span>` : ''}
                    </div>
                  </div>
                `
              }).join('')}
            ` : fulfillment === 'closed' ? `
              <p style="color:var(--s-text-muted);font-size:13px">This order is closed.</p>
            ` : `
              <div style="display:flex;align-items:center;gap:8px;color:var(--s-warning);font-size:13px">
                <span style="font-size:16px">&#9203;</span>
                <span>Awaiting fulfillment</span>
              </div>
              <p style="color:var(--s-text-muted);font-size:12px;margin-top:8px">This order is pending fulfillment.</p>
            `}
          </div>
        </div>

        <!-- TRANSACTIONS / PAYMENT GATEWAY -->
        ${transactions.length > 0 ? `
          <div class="card" style="margin-top:20px">
            <div class="card-header">
              <span>Transactions</span>
              <span class="badge badge-muted">${transactions.length}</span>
            </div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Gateway</th>
                      <th style="text-align:right">Amount</th>
                      <th>Status</th>
                      <th>Transaction ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${transactions.map((t: any) => {
                      const tDate = new Date(t.created_at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                      const kindLabel: Record<string, string> = { sale: 'Sale', capture: 'Capture', refund: 'Refund', void: 'Void', authorization: 'Auth' }
                      const kindColor: Record<string, string> = { sale: 'var(--s-success)', capture: 'var(--s-success)', refund: 'var(--s-warning)', void: 'var(--s-text-dim)', authorization: 'var(--s-accent)' }
                      const statusBadge = t.status === 'success' ? 'badge-success' : t.status === 'failure' || t.status === 'error' ? 'badge-danger' : 'badge-warning'
                      const gwId = t.gateway_transaction_id || t.authorization || '-'
                      return `
                        <tr>
                          <td style="font-size:12px;white-space:nowrap">${tDate}</td>
                          <td><span style="color:${kindColor[t.kind] || 'var(--s-text)'};font-weight:500;font-size:12px">${kindLabel[t.kind] || t.kind}</span></td>
                          <td style="text-transform:capitalize;font-size:13px">${esc(String(t.gateway || '-'))}</td>
                          <td style="text-align:right;font-weight:600;font-size:13px">${fmt(t.amount)}</td>
                          <td><span class="badge ${statusBadge}" style="font-size:11px">${esc(String(t.status))}</span></td>
                          <td style="font-family:monospace;font-size:11px;color:var(--s-text-muted);max-width:160px;overflow:hidden;text-overflow:ellipsis" title="${esc(String(gwId))}">${esc(String(gwId).substring(0, 24))}${String(gwId).length > 24 ? '...' : ''}</td>
                        </tr>
                      `
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- REFUND REQUESTS -->
        <div class="card" style="margin-top:20px">
          <div class="card-header">
            <span>Refund Requests</span>
            <span class="badge badge-muted">${refundRequests.length}</span>
          </div>
          <div class="card-body">
            ${refundRequests.length > 0 ? `
              <div style="display:flex;flex-direction:column;gap:12px">
                ${refundRequests.map((rr: any) => {
                  const rrDate = new Date(rr.created_at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  const rrStatus = rr.status || 'pending'
                  const rrBadge = rrStatus === 'approved' ? 'badge-success' : rrStatus === 'rejected' ? 'badge-danger' : 'badge-warning'
                  const reason = String(rr.reason || '')
                  const truncReason = reason.length > 80 ? reason.substring(0, 80) + '...' : reason
                  return `
                    <div style="border:1px solid var(--s-border);border-radius:8px;padding:12px 16px;font-size:13px">
                      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                        <span style="font-weight:600">${fmt(rr.amount)}</span>
                        <span class="badge ${rrBadge}">${esc(rrStatus)}</span>
                      </div>
                      <p style="color:var(--s-text-muted);margin:0 0 4px 0" title="${esc(reason)}">${esc(truncReason)}</p>
                      <span style="color:var(--s-text-dim);font-size:12px">${rrDate}</span>
                      ${rr.review_note ? `<p style="color:var(--s-text);font-size:12px;margin:6px 0 0 0;padding-top:6px;border-top:1px solid var(--s-border)"><strong>Review:</strong> ${esc(String(rr.review_note))}</p>` : ''}
                    </div>
                  `
                }).join('')}
              </div>
            ` : '<p style="color:var(--s-text-muted);font-size:13px;margin:0">No refund requests.</p>'}
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--s-border);display:flex;gap:8px">
              <a href="${base}/refund-requests/new?orderId=${order.id}" class="btn btn-outline btn-sm">Request Refund</a>
            </div>
          </div>
        </div>

        <!-- ORDER TIMELINE -->
        <div class="card" style="margin-top:20px">
          <div class="card-header"><span>Timeline</span></div>
          <div class="card-body">
            <!-- Add internal note form -->
            <form method="POST" action="${base}/orders/${orderId}/add-note" style="display:flex;gap:8px;margin-bottom:16px">
              ${csrfHiddenField(csrfToken)}
              <input type="text" name="note_message" placeholder="Add an internal note..." style="flex:1;padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:13px" />
              <button type="submit" class="btn btn-outline btn-sm">Post</button>
            </form>

            <div style="display:flex;flex-direction:column;gap:0;position:relative;padding-left:24px">
              <div style="position:absolute;left:8px;top:0;bottom:0;width:2px;background:var(--s-border)"></div>

              ${orderEvents.length > 0 ? orderEvents.map((ev: any) => {
                const evDate = new Date(ev.created_at as string)
                const evDateStr = evDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                const iconMap: Record<string, string> = {
                  order_placed: '&#128722;', payment_captured: '&#128179;', payment_authorized: '&#128179;',
                  fulfilled: '&#128230;', partially_fulfilled: '&#128230;', shipped: '&#128666;',
                  refunded: '&#128176;', cancelled: '&#10060;', edited: '&#9998;',
                  note_added: '&#128172;', email_sent: '&#128231;', return_requested: '&#128257;',
                }
                const icon = iconMap[ev.event_type] || '&#128196;'
                return `
                  <div style="position:relative;padding-bottom:16px">
                    <div style="position:absolute;left:-20px;top:2px;width:14px;height:14px;background:var(--s-card);border:2px solid var(--s-border);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px">${icon}</div>
                    <div style="font-size:13px;color:var(--s-text)">${esc(ev.message || ev.event_type)}</div>
                    <div style="font-size:11px;color:var(--s-text-dim);margin-top:2px">${evDateStr} &middot; ${esc(ev.actor_type || 'system')}</div>
                  </div>
                `
              }).join('') : `
                <div style="position:relative;padding-bottom:16px">
                  <div style="position:absolute;left:-20px;top:2px;width:14px;height:14px;background:var(--s-card);border:2px solid var(--s-border);border-radius:50%;font-size:8px;display:flex;align-items:center;justify-content:center">&#128722;</div>
                  <div style="font-size:13px;color:var(--s-text)">Order #${esc(String(order.order_number))} created</div>
                  <div style="font-size:11px;color:var(--s-text-dim);margin-top:2px">${dateStr} &middot; system</div>
                </div>
              `}
            </div>
          </div>
        </div>
      </div>

      <!-- ==================== RIGHT COLUMN (SIDEBAR) ==================== -->
      <div>

        ${editMode ? `
        <!-- ============ EDIT MODE ============ -->
        <form method="POST" action="${base}/orders/${orderId}/edit">
          ${csrfHiddenField(csrfToken)}

          <!-- Customer -->
          <div class="card">
            <div class="card-header"><span>Customer</span></div>
            <div class="card-body">
              <div style="margin-bottom:10px">
                <label style="display:block;font-size:12px;font-weight:500;color:var(--s-text-muted);margin-bottom:4px">Email</label>
                <input type="email" name="email" value="${esc(order.email || '')}" style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:13px" />
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:500;color:var(--s-text-muted);margin-bottom:4px">Phone</label>
                <input type="text" name="phone" value="${esc(order.phone || '')}" style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:13px" placeholder="+84..." />
              </div>
            </div>
          </div>

          <!-- Shipping Address -->
          <div class="card" style="margin-top:16px">
            <div class="card-body">
              ${addressFormHtml({ prefix: 'shipping', label: 'Shipping Address', values: shippingAddr, compact: true })}
            </div>
          </div>

          <!-- Billing Address -->
          <div class="card" style="margin-top:16px">
            <div class="card-body">
              ${addressFormHtml({ prefix: 'billing', label: 'Billing Address', values: billingAddr, compact: true })}
            </div>
          </div>

          <!-- Notes -->
          <div class="card" style="margin-top:16px">
            <div class="card-header"><span>Notes</span></div>
            <div class="card-body">
              <textarea name="note" rows="4" style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:13px;resize:vertical">${esc(order.note || '')}</textarea>
            </div>
          </div>

          <!-- Tags -->
          <div class="card" style="margin-top:16px">
            <div class="card-header"><span>Tags</span></div>
            <div class="card-body">
              <input type="text" name="tags" value="${esc(tags.join(', '))}" placeholder="tag1, tag2, tag3" style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:13px" />
              <p style="font-size:11px;color:var(--s-text-dim);margin-top:4px">Comma-separated</p>
            </div>
          </div>

          <!-- Save / Cancel -->
          <div style="display:flex;gap:8px;margin-top:16px">
            <button type="submit" class="btn" style="flex:1;background:var(--s-accent);color:#fff;border:none;padding:10px;border-radius:8px;font-weight:600;cursor:pointer">Save Changes</button>
            <a href="${base}/orders/${orderId}" class="btn btn-outline" style="padding:10px 16px">Cancel</a>
          </div>
        </form>

        ` : `
        <!-- ============ VIEW MODE ============ -->

        <!-- Customer -->
        <div class="card">
          <div class="card-header"><span>Customer</span></div>
          <div class="card-body">
            <div style="display:flex;flex-direction:column;gap:6px;font-size:13px">
              ${order.customer_id ? `
                <a href="${base}/customers/${order.customer_id}" style="color:var(--s-accent);text-decoration:none;font-weight:600">${esc(order.email || 'Unknown')}</a>
              ` : `
                <span style="font-weight:600">${esc(order.email || 'Guest checkout')}</span>
              `}
              ${order.email ? `<div style="color:var(--s-text-muted);display:flex;align-items:center;gap:6px">
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="16" height="12" rx="2"/><path d="M2 4l8 6 8-6"/></svg>
                ${esc(order.email)}
              </div>` : ''}
              ${order.phone ? `<div style="color:var(--s-text-muted);display:flex;align-items:center;gap:6px">
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5a2 2 0 012-2h2.28a1 1 0 01.95.68l.96 2.87a1 1 0 01-.24 1.02L7.1 9.42a12 12 0 005.48 5.48l1.85-1.85a1 1 0 011.02-.24l2.87.96a1 1 0 01.68.95V17a2 2 0 01-2 2A15 15 0 013 5z"/></svg>
                ${esc(order.phone)}
              </div>` : ''}
            </div>
          </div>
        </div>

        <!-- Shipping Address -->
        <div class="card" style="margin-top:16px">
          <div class="card-header"><span>Shipping Address</span></div>
          <div class="card-body">${renderAddr(shippingAddr, 'Shipping address')}</div>
        </div>

        <!-- Billing Address -->
        <div class="card" style="margin-top:16px">
          <div class="card-header"><span>Billing Address</span></div>
          <div class="card-body">${renderAddr(billingAddr, 'Billing address')}</div>
        </div>

        <!-- Conversion Summary (ShopBase-parity) -->
        ${renderConversionSummaryCard(conversionSummary, SESSION_MODAL_ID)}

        <!-- Fraud Analysis (ShopBase-parity) -->
        ${renderFraudAnalysisCard(fraudIndicators, FRAUD_MODAL_ID)}

        <!-- Payment Info -->
        <div class="card" style="margin-top:16px">
          <div class="card-header">
            <span>Payment</span>
            <span class="badge ${payBadge}" style="font-size:11px">${esc(payment)}</span>
          </div>
          <div class="card-body">
            <div style="display:grid;grid-template-columns:110px 1fr;gap:6px 12px;font-size:13px">
              <span style="color:var(--s-text-muted)">Amount</span>
              <span style="font-weight:700">${fmt(order.total_price)}</span>
              <span style="color:var(--s-text-muted)">Currency</span>
              <span style="font-weight:500">${esc(currency)}</span>
              ${transactions.length > 0 ? (() => {
                const primary = transactions.find((t: any) => t.kind === 'sale' || t.kind === 'capture') || transactions[0]
                return `
                  <span style="color:var(--s-text-muted)">Gateway</span>
                  <span style="font-weight:500;text-transform:capitalize">${esc(String(primary.gateway || '-'))}</span>
                  ${primary.gateway_transaction_id ? `
                    <span style="color:var(--s-text-muted)">Transaction ID</span>
                    <span style="font-family:monospace;font-size:11px;word-break:break-all" title="${esc(String(primary.gateway_transaction_id))}">${esc(String(primary.gateway_transaction_id))}</span>
                  ` : ''}
                  ${primary.authorization ? `
                    <span style="color:var(--s-text-muted)">Auth Code</span>
                    <span style="font-family:monospace;font-size:11px">${esc(String(primary.authorization))}</span>
                  ` : ''}
                  ${primary.message ? `
                    <span style="color:var(--s-text-muted)">Message</span>
                    <span style="font-size:12px">${esc(String(primary.message))}</span>
                  ` : ''}
                `
              })() : ''}
            </div>
          </div>
        </div>

        <!-- Notes -->
        <div class="card" style="margin-top:16px">
          <div class="card-header"><span>Notes</span></div>
          <div class="card-body">
            ${order.note
              ? `<p style="font-size:13px;color:var(--s-text);white-space:pre-wrap;margin:0">${esc(order.note)}</p>`
              : '<p style="font-size:12px;color:var(--s-text-dim);font-style:italic;margin:0">No notes</p>'
            }
          </div>
        </div>

        <!-- Tags -->
        <div class="card" style="margin-top:16px">
          <div class="card-header"><span>Tags</span></div>
          <div class="card-body">
            ${tags.length > 0
              ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${tags.map(t => `<span class="badge badge-muted" style="font-size:11px;padding:3px 8px">${esc(t)}</span>`).join('')}</div>`
              : '<p style="font-size:12px;color:var(--s-text-dim);font-style:italic;margin:0">No tags</p>'
            }
          </div>
        </div>

        <!-- Order Details / Meta -->
        <div class="card" style="margin-top:16px">
          <div class="card-header"><span>Details</span></div>
          <div class="card-body">
            <div style="display:grid;grid-template-columns:100px 1fr;gap:6px 12px;font-size:13px">
              <span style="color:var(--s-text-muted)">Order ID</span>
              <span style="font-family:monospace;font-size:11px;color:var(--s-text-muted);word-break:break-all">${esc(String(order.id))}</span>
              <span style="color:var(--s-text-muted)">Created</span>
              <span>${dateStr}</span>
              ${order.updated_at ? `
                <span style="color:var(--s-text-muted)">Updated</span>
                <span>${new Date(order.updated_at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              ` : ''}
              ${order.cancelled_at ? `
                <span style="color:var(--s-text-muted)">Cancelled</span>
                <span style="color:var(--s-danger)">${new Date(order.cancelled_at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              ` : ''}
              ${order.cancel_reason ? `
                <span style="color:var(--s-text-muted)">Cancel Reason</span>
                <span style="color:var(--s-danger)">${esc(order.cancel_reason)}</span>
              ` : ''}
            </div>
          </div>
        </div>
        `}
      </div>
    </div>

    <!-- POD Upload link — upload moved to Fulfillments page -->
    ${podFiles.length < lineItems.length ? `
      <div style="margin-top:16px;padding:12px 16px;background:var(--s-bg);border:1px dashed var(--s-border);border-radius:8px;display:flex;align-items:center;gap:10px">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="var(--s-accent)" stroke-width="1.5"><rect x="3" y="3" width="14" height="14" rx="2"/><circle cx="8" cy="8" r="2"/><path d="M3 14l4-4 3 3 2-2 5 5"/></svg>
        <span style="font-size:13px;color:var(--s-text-muted)">
          POD designs: ${podFiles.length}/${lineItems.length} uploaded.
          <a href="${base}/fulfillments/${orderId}" style="color:var(--s-accent);text-decoration:none;font-weight:600">
            Upload POD files &rarr;
          </a>
        </span>
      </div>
    ` : ''}
    </div><!-- /max-width wrapper -->

    <!-- ShopBase-parity modals (rendered outside the centered wrapper so
         their fixed-position overlays cover the whole viewport) -->
    ${renderSessionDetailsModal(SESSION_MODAL_ID, order as any, conversionSummary)}
    ${renderFraudAnalysisModal(FRAUD_MODAL_ID, order as any, fraudIndicators, fraudLinks)}
    ${modalScript()}

    ${editMode ? addressAutocompleteScript(PLACES_KEY) : ''}
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: `Order #${order.order_number}`,
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
    activePage: 'orders', content, theme: theme as 'dark' | 'light',
  }))
}

/* ------------------------------------------------------------------ */
/*  POST /orders/:orderId/edit — Update order                         */
/* ------------------------------------------------------------------ */

export async function postOrderEdit(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const orderId = req.params.id || req.params.orderId
  const base = `/admin/store/${store.slug}`

  try {
    const order = await db.selectFrom('orders')
      .select(['id', 'shop_id'])
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .executeTakeFirst()

    if (!order) {
      res.redirect(`${base}/orders?error=${encodeURIComponent('Order not found')}`)
      return
    }

    const { email, phone, note, tags: tagsRaw } = req.body
    const tags = tagsRaw ? String(tagsRaw).split(',').map((t: string) => t.trim()).filter(Boolean) : []
    const shippingAddress = parseAddressFromBody(req.body, 'shipping')
    const billingAddress = parseAddressFromBody(req.body, 'billing')

    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    }
    if (email !== undefined) updateData.email = email.trim() || null
    if (phone !== undefined) updateData.phone = phone.trim() || null
    if (note !== undefined) updateData.note = note.trim() || null
    updateData.tags = tags.length > 0 ? tags as any : null
    if (shippingAddress) updateData.shipping_address = JSON.stringify(shippingAddress)
    if (billingAddress) updateData.billing_address = JSON.stringify(billingAddress)

    await db.updateTable('orders')
      .set(updateData)
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .execute()

    // Log timeline event
    await db.insertInto('order_events')
      .values({
        shop_id: store.id,
        order_id: orderId,
        event_type: 'edited',
        actor_type: 'user',
        actor_id: user.id,
        message: `Order edited by ${user.name || user.email}`,
      })
      .execute()
      .catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'order_edited',
      title: `Order edited`,
      message: byActor(user),
      resourceType: 'order',
      resourceId: orderId,
    })

    res.redirect(`${base}/orders/${orderId}?success=updated`)
  } catch (err: any) {
    res.redirect(`${base}/orders/${orderId}?error=${encodeURIComponent('Failed to update: ' + err.message)}`)
  }
}

/* ------------------------------------------------------------------ */
/*  POST /orders/:orderId/add-note — Add timeline note                */
/* ------------------------------------------------------------------ */

export async function postOrderAddNote(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const orderId = req.params.id || req.params.orderId
  const base = `/admin/store/${store.slug}`
  const message = String(req.body.note_message || '').trim()

  try {
    // Delegate to shared core service — the REST API calls the same
    // function so note-semantics stay consistent across UI and API.
    await addOrderNote(db, {
      shopId: store.id,
      orderId,
      message,
      actorId: user.id,
      actorType: 'user',
    })
    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'order_note_added',
      title: `Order note added`,
      message: message.length > 80 ? message.slice(0, 77) + '...' : message,
      resourceType: 'order',
      resourceId: orderId,
    })
  } catch (err: any) {
    console.error('[Orders] addOrderNote error:', err?.message)
  }

  res.redirect(`${base}/orders/${orderId}`)
}

/* ------------------------------------------------------------------ */
/*  POST /orders/:orderId/pod-upload — POD file upload (multipart)    */
/* ------------------------------------------------------------------ */

export async function postPodUpload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const orderId = req.params.id || req.params.orderId

  try {
    const file = (req as any).file
    if (!file) {
      res.json({ ok: false, error: 'No file uploaded' })
      return
    }

    const lineItemId = req.body.line_item_id
    if (!lineItemId) {
      res.json({ ok: false, error: 'Missing line_item_id' })
      return
    }

    // Verify order + line item belong to this store
    const order = await db.selectFrom('orders').select(['id']).where('id', '=', orderId).where('shop_id', '=', store.id).executeTakeFirst()
    if (!order) {
      res.json({ ok: false, error: 'Order not found' })
      return
    }
    const lineItem = await db.selectFrom('order_line_items').select(['id']).where('id', '=', lineItemId).where('order_id', '=', orderId).executeTakeFirst()
    if (!lineItem) {
      res.json({ ok: false, error: 'Line item not found' })
      return
    }

    // Store file to R2 (side-effect — stays in the web handler because
    // it needs multipart access; the core service only owns DB state).
    const { getObjectStore } = await import('@gbox/core/modules/storage/index.js')
    const objectStore = getObjectStore()
    const fileKey = `shops/${store.id}/pod/${orderId}/${lineItemId}.png`
    const fileUrl = await objectStore.put(fileKey, file.buffer, {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    })

    // Delegate DB upsert + timeline event to shared core service
    await upsertPodFile(db, {
      shopId: store.id,
      orderId,
      lineItemId,
      fileKey,
      fileUrl,
      filename: file.originalname || 'design.png',
      mimeType: 'image/png',
      size: file.size,
      uploadedBy: user.id,
    })

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'order_pod_uploaded',
      title: `Proof of delivery uploaded`,
      message: [file.originalname || 'design.png', byActor(user)].filter(Boolean).join(' • '),
      resourceType: 'order',
      resourceId: orderId,
    })

    res.json({ ok: true, file_url: fileUrl })
  } catch (err: any) {
    console.error('[POD Upload Error]', err.message)
    res.json({ ok: false, error: 'Upload failed: ' + err.message })
  }
}

/* ------------------------------------------------------------------ */
/*  POST /orders/:id/fulfill — Disabled for sellers                   */
/*  Fulfillment is handled by God Admin only.                         */
/* ------------------------------------------------------------------ */

export async function postFulfillOrder(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const orderId = req.params.id || req.params.orderId
  const base = `/admin/store/${store.slug}`

  // Sellers cannot fulfill orders — only God Admin can
  res.redirect(`${base}/orders/${orderId}`)
}

/* ------------------------------------------------------------------ */
/*  POST /orders/bulk — Bulk actions                                  */
/* ------------------------------------------------------------------ */

export async function postOrderBulk(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const { ids, action, tag } = req.body as { ids: string; action: string; tag?: string }
  if (!ids || !action) {
    res.redirect(`${base}/orders`)
    return
  }

  const orderIds = ids.split(',').filter(Boolean)
  if (orderIds.length === 0) {
    res.redirect(`${base}/orders`)
    return
  }

  try {
    // Delegate to shared core service — it scopes all writes by
    // shop_id (cross-tenant safety), emits the audit_logs row, and
    // supports add_tag / remove_tag / archive / cancel / mark_paid /
    // mark_fulfilled in one call.
    const result = await bulkOrderAction(db, {
      shopId: store.id,
      orderIds,
      action: action as BulkOrderAction,
      tag,
      actorId: user.id,
    })

    // UI-level notification (the core service doesn't own the notification
    // feed — that's still a store-admin concern)
    if (result.affected > 0) {
      const notifAction = action === 'cancel' ? 'cancelled' : action
      notify(db, {
        shopId: store.id,
        userId: user.id,
        type: action === 'mark_fulfilled' ? 'orders_bulk_fulfilled' : 'orders_bulk_updated',
        title: `${result.affected} order(s) ${notifAction}`,
        message: byActor(user),
        resourceType: 'order',
        resourceId: null,
      })
    }
  } catch (err: any) {
    console.error('[Order bulk action error]', err.message)
  }

  res.redirect(`${base}/orders`)
}

/* ------------------------------------------------------------------ */
/*  Utility                                                           */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
