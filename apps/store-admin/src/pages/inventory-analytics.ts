/**
 * Store Admin — Inventory Analytics (Phase 6 PR2)
 *
 * Dedicated inventory analytics page scoped to the current store.
 * Period selector (7d / 30d / 90d), 4 cards:
 *
 *   1. Top sellers (units)           — what's moving
 *   2. Sell-through leaders (%)      — how fast it's moving
 *   3. Low stock (≤ threshold)       — what's about to run out
 *   4. Dead stock (>90d no sales)    — what's tying up capital
 *
 * Every card links back to the variant's product page, matching
 * the existing inventory.ts page UX.
 *
 * All queries live in packages/core/src/modules/analytics/
 * inventory-analytics.ts. This page is a thin HTML renderer.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import {
  getTopSellers,
  getDeadStock,
  getLowStock,
  getSellThroughLeaders,
  periodToRange,
} from '@gbox/core/modules/analytics/inventory-analytics.js'
import { sellerLayout, esc } from '../layouts/seller-layout.js'

// ─── Formatters ────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

function variantLabel(
  productTitle: string,
  variantTitle: string | null,
  sku: string | null,
): string {
  const base = variantTitle && variantTitle !== 'Default Title'
    ? `${productTitle} — ${variantTitle}`
    : productTitle
  return sku ? `${base} · SKU ${sku}` : base
}

// ─── Main handler ─────────────────────────────────────────────────

export async function getInventoryAnalytics(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const periodParam = String(req.query.period ?? '30d')
  const range = periodToRange(periodParam)
  const periodLabel = range.label

  try {
    // `db as any` sidesteps the duplicate-Kysely-types hazard documented in
    // CLAUDE.md (workspace root vs packages/db/node_modules) — same pattern
    // used 400+ times across the codebase.
    const [topSellers, sellThrough, lowStock, deadStock] = await Promise.all([
      getTopSellers(db as any, store.id, range, 10),
      getSellThroughLeaders(db as any, store.id, range, { limit: 10, minSold: 5 }),
      getLowStock(db as any, store.id, { threshold: 5, limit: 20 }),
      getDeadStock(db as any, store.id, { daysCutoff: 90, limit: 20 }),
    ])

    // Summary stat cards
    const totalUnitsSold = topSellers.reduce((acc, r) => acc + r.units_sold, 0)
    const totalRevenue = topSellers.reduce(
      (acc, r) => acc + Number(r.revenue ?? 0),
      0,
    )
    const deadUnits = deadStock.reduce((acc, r) => acc + r.inventory_quantity, 0)
    const lowStockCount = lowStock.length

    const content = `
      <style>
        .period-tabs { display:flex; gap:2px; background:var(--s-card); border-radius:8px; border:1px solid var(--s-border); padding:2px; }
        .period-tab { padding:6px 14px; font-size:12px; border-radius:6px; text-decoration:none; color:var(--s-text-muted); transition:all .15s; cursor:pointer; }
        .period-tab:hover { color:var(--s-text); }
        .period-tab.active { background:var(--s-accent); color:#fff; }
        .two-col { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:20px; }
        .st-row { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--s-border); }
        .st-row:last-child { border-bottom:none; }
        .st-title { font-size:13px; color:var(--s-text); }
        .st-sub { font-size:11px; color:var(--s-text-muted); margin-top:2px; }
        .st-bar { width:100%; height:6px; border-radius:3px; background:var(--s-border); overflow:hidden; margin-top:6px; }
        .st-bar-fill { height:100%; background:var(--s-accent); border-radius:3px; transition:width .3s; }
        @media (max-width:768px) {
          .two-col { grid-template-columns:1fr; }
        }
      </style>

      <div class="page-header">
        <div>
          <h1 class="page-title">Inventory Analytics</h1>
          <p style="color:var(--s-text-muted);margin:0;font-size:13px">${esc(periodLabel)} &mdash; ${esc(store.name)}</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <a href="${base}/products/inventory" class="btn btn-secondary" style="font-size:12px">View Stock</a>
          <div class="period-tabs">
            ${['7d', '30d', '90d'].map(p => `
              <a href="${base}/reports/inventory?period=${p}" class="period-tab${periodParam === p ? ' active' : ''}">${
                p === '7d' ? '7 days' : p === '30d' ? '30 days' : '90 days'
              }</a>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Summary Cards -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${fmtNum(totalUnitsSold)}</div>
          <div class="stat-label">Units Sold (top 10)</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${fmtMoney(totalRevenue)}</div>
          <div class="stat-label">Revenue (top 10)</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:${lowStockCount > 0 ? 'var(--s-warning, #f59e0b)' : 'var(--s-text)'}">${fmtNum(lowStockCount)}</div>
          <div class="stat-label">Low Stock Variants</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:${deadUnits > 0 ? 'var(--s-danger, #ef4444)' : 'var(--s-text)'}">${fmtNum(deadUnits)}</div>
          <div class="stat-label">Dead Stock Units (90d+)</div>
        </div>
      </div>

      <div class="two-col">
        <!-- Top Sellers -->
        <div class="card">
          <div class="card-header">
            <span>Top Sellers (units)</span>
            <span style="font-size:11px;color:var(--s-text-muted)">${esc(periodLabel)}</span>
          </div>
          <div class="card-body" style="padding:0">
            ${topSellers.length > 0 ? `
              <div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr><th>#</th><th>Variant</th><th>Units</th><th>Orders</th><th>Revenue</th></tr>
                  </thead>
                  <tbody>
                    ${topSellers.map((r, i) => `
                      <tr>
                        <td style="color:var(--s-text-muted)">${i + 1}</td>
                        <td>
                          <a href="${base}/products/${r.product_id}" style="color:var(--s-accent);text-decoration:none">${esc(variantLabel(r.product_title, r.variant_title, r.sku))}</a>
                        </td>
                        <td>${fmtNum(r.units_sold)}</td>
                        <td>${fmtNum(r.orders_count)}</td>
                        <td style="font-weight:600;color:var(--s-success)">${fmtMoney(Number(r.revenue ?? 0))}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : '<div class="empty-state" style="padding:40px 20px"><div class="empty-state-text">No sales in this period.</div></div>'}
          </div>
        </div>

        <!-- Sell-through Leaders -->
        <div class="card">
          <div class="card-header">
            <span>Sell-Through Leaders</span>
            <span style="font-size:11px;color:var(--s-text-muted)">sold / (sold + on hand)</span>
          </div>
          <div class="card-body" style="padding:0 16px">
            ${sellThrough.length > 0 ? sellThrough.map((r) => `
              <div class="st-row">
                <div style="flex:1;min-width:0">
                  <div class="st-title">
                    <a href="${base}/products/${r.product_id}" style="color:var(--s-text);text-decoration:none">${esc(variantLabel(r.product_title, r.variant_title, r.sku))}</a>
                  </div>
                  <div class="st-sub">${fmtNum(r.units_sold)} sold · ${fmtNum(r.inventory_quantity)} on hand</div>
                  <div class="st-bar"><div class="st-bar-fill" style="width:${(r.sell_through * 100).toFixed(1)}%"></div></div>
                </div>
                <div style="margin-left:16px;font-weight:600;font-size:14px;color:var(--s-accent)">
                  ${fmtPct(r.sell_through)}
                </div>
              </div>
            `).join('') : '<div class="empty-state" style="padding:40px 20px"><div class="empty-state-text">No variants with ≥5 units sold in this period.</div></div>'}
          </div>
        </div>
      </div>

      <div class="two-col">
        <!-- Low Stock -->
        <div class="card">
          <div class="card-header">
            <span>Low Stock (≤ 5 units)</span>
            <span style="font-size:11px;color:var(--s-text-muted)">${fmtNum(lowStockCount)} variants</span>
          </div>
          <div class="card-body" style="padding:0">
            ${lowStock.length > 0 ? `
              <div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr><th>Variant</th><th>SKU</th><th>On Hand</th></tr>
                  </thead>
                  <tbody>
                    ${lowStock.map((r) => `
                      <tr>
                        <td>
                          <a href="${base}/products/${r.product_id}" style="color:var(--s-accent);text-decoration:none">${esc(variantLabel(r.product_title, r.variant_title, null))}</a>
                        </td>
                        <td style="color:var(--s-text-muted);font-size:12px">${esc(r.sku ?? '—')}</td>
                        <td style="font-weight:600;color:${r.inventory_quantity === 0 ? 'var(--s-danger, #ef4444)' : 'var(--s-warning, #f59e0b)'}">${fmtNum(r.inventory_quantity)}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : '<div class="empty-state" style="padding:40px 20px"><div class="empty-state-text">No low-stock variants.</div></div>'}
          </div>
        </div>

        <!-- Dead Stock -->
        <div class="card">
          <div class="card-header">
            <span>Dead Stock (&gt; 90 days no sales)</span>
            <span style="font-size:11px;color:var(--s-text-muted)">${fmtNum(deadUnits)} units tied up</span>
          </div>
          <div class="card-body" style="padding:0">
            ${deadStock.length > 0 ? `
              <div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr><th>Variant</th><th>On Hand</th><th>Last Sold</th></tr>
                  </thead>
                  <tbody>
                    ${deadStock.map((r) => `
                      <tr>
                        <td>
                          <a href="${base}/products/${r.product_id}" style="color:var(--s-accent);text-decoration:none">${esc(variantLabel(r.product_title, r.variant_title, r.sku))}</a>
                        </td>
                        <td>${fmtNum(r.inventory_quantity)}</td>
                        <td style="color:var(--s-text-muted);font-size:12px">${
                          r.days_since_last_sale === null
                            ? 'Never'
                            : `${fmtNum(r.days_since_last_sale)} days ago`
                        }</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : '<div class="empty-state" style="padding:40px 20px"><div class="empty-state-text">No dead stock. Keep it up!</div></div>'}
          </div>
        </div>
      </div>
    `

    res.send(sellerLayout({
      title: 'Inventory Analytics',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }))
  } catch (err) {
    console.error('[inventory-analytics] Error:', err)
    const content = `
      <div class="page-header">
        <h1 class="page-title">Inventory Analytics</h1>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="empty-state">
            <div class="empty-state-title">Error loading analytics</div>
            <div class="empty-state-text">Something went wrong. Please try again later.</div>
          </div>
        </div>
      </div>
    `
    res.status(500).send(sellerLayout({
      title: 'Inventory Analytics',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }))
  }
}
