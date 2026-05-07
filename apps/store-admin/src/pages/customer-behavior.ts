/**
 * Store Admin — Customer Behavior (Phase 6 PR3)
 *
 * Dedicated customer analytics page scoped to the current store.
 * Period selector (7d / 30d / 90d) + optional segment filter.
 *
 * Cards:
 *   1. New vs Returning             — orders in range partitioned
 *   2. Lifecycle breakdown          — new/returning/at_risk/churned counts
 *   3. Top spenders                 — total_spent desc (segment-scoped)
 *   4. At-risk customers            — >60d since last order (segment-scoped)
 *
 * All queries live in packages/core/src/modules/analytics/
 * customer-behavior.ts. This page is a thin HTML renderer.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import {
  getTopSpenders,
  getAtRiskCustomers,
  getNewVsReturning,
  getLifecycleBreakdown,
  periodToRange,
} from '@gbox/core/modules/analytics/customer-behavior.js'
import { listSegments } from '@gbox/core/modules/customer-segments/service.js'
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

function displayName(
  first: string | null,
  last: string | null,
  email: string | null,
): string {
  const parts = [first, last].filter(Boolean).join(' ').trim()
  return parts || email || '(no name)'
}

const STAGE_LABELS: Record<string, string> = {
  new: 'New',
  returning: 'Returning',
  at_risk: 'At Risk',
  churned: 'Churned',
}

const STAGE_COLORS: Record<string, string> = {
  new: 'var(--s-accent)',
  returning: 'var(--s-success, #10b981)',
  at_risk: 'var(--s-warning, #f59e0b)',
  churned: 'var(--s-danger, #ef4444)',
}

// ─── Main handler ─────────────────────────────────────────────────

export async function getCustomerBehavior(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const periodParam = String(req.query.period ?? '30d')
  const segmentId = req.query.segment ? String(req.query.segment) : null
  const range = periodToRange(periodParam)
  const periodLabel = range.label

  try {
    // `db as any` sidesteps the duplicate-Kysely-types hazard documented in
    // CLAUDE.md (workspace root vs packages/db/node_modules) — same pattern
    // used 400+ times across the codebase.
    const [topSpenders, atRisk, newVsReturning, lifecycle, segments] =
      await Promise.all([
        getTopSpenders(db as any, store.id, {
          limit: 10,
          minOrders: 1,
          segmentId,
        }),
        getAtRiskCustomers(db as any, store.id, {
          daysCutoff: 60,
          limit: 20,
          segmentId,
        }),
        getNewVsReturning(db as any, store.id, range, { segmentId }),
        getLifecycleBreakdown(db as any, store.id, { segmentId }),
        listSegments(db as any, { shop_id: store.id, limit: 100, offset: 0 }),
      ])

    const activeSegment = segments.find((s) => s.id === segmentId)

    // Top summary stat cards
    const totalCustomers = lifecycle.total
    const atRiskCount = (lifecycle.counts.at_risk ?? 0) + (lifecycle.counts.churned ?? 0)
    const returningRatePct = fmtPct(newVsReturning.returning_rate)
    const totalSpentTop10 = topSpenders.reduce(
      (acc, r) => acc + Number(r.total_spent ?? 0),
      0,
    )

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
        .st-bar-fill { height:100%; border-radius:3px; transition:width .3s; }
        .seg-filter { display:flex; gap:8px; align-items:center; }
        .seg-filter select { background:var(--s-card); border:1px solid var(--s-border); color:var(--s-text); border-radius:6px; padding:4px 8px; font-size:12px; }
        .stage-pill { display:inline-block; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; color:#fff; }
        @media (max-width:768px) {
          .two-col { grid-template-columns:1fr; }
        }
      </style>

      <div class="page-header">
        <div>
          <h1 class="page-title">Customer Behavior</h1>
          <p style="color:var(--s-text-muted);margin:0;font-size:13px">
            ${esc(periodLabel)}
            ${activeSegment ? ` &mdash; segment: <strong>${esc(activeSegment.name)}</strong>` : ''}
            &mdash; ${esc(store.name)}
          </p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <a href="${base}/customers" class="btn btn-secondary" style="font-size:12px">All customers</a>
          <form method="get" action="${base}/reports/customers" class="seg-filter">
            <input type="hidden" name="period" value="${esc(periodParam)}" />
            <select name="segment" onchange="this.form.submit()">
              <option value="">All customers</option>
              ${segments.map((s) => `
                <option value="${esc(s.id)}"${segmentId === s.id ? ' selected' : ''}>
                  ${esc(s.name)}
                </option>
              `).join('')}
            </select>
          </form>
          <div class="period-tabs">
            ${['7d', '30d', '90d'].map(p => `
              <a href="${base}/reports/customers?period=${p}${segmentId ? `&segment=${esc(segmentId)}` : ''}" class="period-tab${periodParam === p ? ' active' : ''}">${
                p === '7d' ? '7 days' : p === '30d' ? '30 days' : '90 days'
              }</a>
            `).join('')}
          </div>
        </div>
      </div>

      <!-- Summary Cards -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${fmtNum(totalCustomers)}</div>
          <div class="stat-label">Customers${activeSegment ? ' (in segment)' : ''}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${returningRatePct}</div>
          <div class="stat-label">Returning Rate (${esc(periodLabel)})</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:${atRiskCount > 0 ? 'var(--s-warning, #f59e0b)' : 'var(--s-text)'}">${fmtNum(atRiskCount)}</div>
          <div class="stat-label">At-risk + churned</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${fmtMoney(totalSpentTop10)}</div>
          <div class="stat-label">Top-10 lifetime spend</div>
        </div>
      </div>

      <div class="two-col">
        <!-- New vs Returning -->
        <div class="card">
          <div class="card-header">
            <span>New vs Returning</span>
            <span style="font-size:11px;color:var(--s-text-muted)">${esc(periodLabel)}</span>
          </div>
          <div class="card-body">
            ${newVsReturning.total_orders > 0 ? `
              <div style="display:flex;gap:16px;margin-bottom:16px">
                <div style="flex:1">
                  <div style="font-size:24px;font-weight:700">${fmtNum(newVsReturning.new_customer_orders)}</div>
                  <div style="color:var(--s-text-muted);font-size:12px">New customer orders</div>
                </div>
                <div style="flex:1">
                  <div style="font-size:24px;font-weight:700;color:var(--s-success, #10b981)">${fmtNum(newVsReturning.returning_customer_orders)}</div>
                  <div style="color:var(--s-text-muted);font-size:12px">Returning customer orders</div>
                </div>
              </div>
              <div style="display:flex;height:20px;border-radius:4px;overflow:hidden">
                <div style="flex:${newVsReturning.new_customer_orders};background:var(--s-accent);min-width:${newVsReturning.new_customer_orders === 0 ? '0' : '2%'}"></div>
                <div style="flex:${newVsReturning.returning_customer_orders};background:var(--s-success, #10b981);min-width:${newVsReturning.returning_customer_orders === 0 ? '0' : '2%'}"></div>
              </div>
              <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--s-text-muted)">
                <span>${fmtPct(1 - newVsReturning.returning_rate)} new</span>
                <span>${fmtPct(newVsReturning.returning_rate)} returning</span>
              </div>
            ` : '<div class="empty-state" style="padding:20px 0"><div class="empty-state-text">No orders in this period.</div></div>'}
          </div>
        </div>

        <!-- Lifecycle Breakdown -->
        <div class="card">
          <div class="card-header">
            <span>Lifecycle Breakdown</span>
            <span style="font-size:11px;color:var(--s-text-muted)">${fmtNum(totalCustomers)} total</span>
          </div>
          <div class="card-body">
            ${totalCustomers > 0 ? ['new', 'returning', 'at_risk', 'churned'].map((stage) => {
              const n = lifecycle.counts[stage] ?? 0
              const pct = totalCustomers > 0 ? n / totalCustomers : 0
              return `
                <div class="st-row">
                  <div style="flex:1;min-width:0">
                    <div class="st-title">
                      <span class="stage-pill" style="background:${STAGE_COLORS[stage]}">${STAGE_LABELS[stage]}</span>
                    </div>
                    <div class="st-bar"><div class="st-bar-fill" style="width:${(pct * 100).toFixed(1)}%;background:${STAGE_COLORS[stage]}"></div></div>
                  </div>
                  <div style="margin-left:16px;text-align:right">
                    <div style="font-weight:600">${fmtNum(n)}</div>
                    <div style="font-size:11px;color:var(--s-text-muted)">${fmtPct(pct)}</div>
                  </div>
                </div>
              `
            }).join('') : '<div class="empty-state" style="padding:20px 0"><div class="empty-state-text">No customers yet.</div></div>'}
          </div>
        </div>
      </div>

      <div class="two-col">
        <!-- Top Spenders -->
        <div class="card">
          <div class="card-header">
            <span>Top Spenders (lifetime)</span>
            <span style="font-size:11px;color:var(--s-text-muted)">${activeSegment ? `in "${esc(activeSegment.name)}"` : 'all customers'}</span>
          </div>
          <div class="card-body" style="padding:0">
            ${topSpenders.length > 0 ? `
              <div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr><th>#</th><th>Customer</th><th>Orders</th><th>Total Spent</th></tr>
                  </thead>
                  <tbody>
                    ${topSpenders.map((r, i) => `
                      <tr>
                        <td style="color:var(--s-text-muted)">${i + 1}</td>
                        <td>
                          <a href="${base}/customers/${r.customer_id}" style="color:var(--s-accent);text-decoration:none">${esc(displayName(r.first_name, r.last_name, r.email))}</a>
                          <div style="font-size:11px;color:var(--s-text-muted)">${esc(r.email ?? '—')}</div>
                        </td>
                        <td>${fmtNum(r.orders_count)}</td>
                        <td style="font-weight:600;color:var(--s-success, #10b981)">${fmtMoney(Number(r.total_spent ?? 0))}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : '<div class="empty-state" style="padding:40px 20px"><div class="empty-state-text">No customers with orders yet.</div></div>'}
          </div>
        </div>

        <!-- At-Risk Customers -->
        <div class="card">
          <div class="card-header">
            <span>At-Risk Customers</span>
            <span style="font-size:11px;color:var(--s-text-muted)">&gt; 60 days since last order</span>
          </div>
          <div class="card-body" style="padding:0">
            ${atRisk.length > 0 ? `
              <div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr><th>Customer</th><th>Orders</th><th>Spent</th><th>Last Order</th></tr>
                  </thead>
                  <tbody>
                    ${atRisk.map((r) => `
                      <tr>
                        <td>
                          <a href="${base}/customers/${r.customer_id}" style="color:var(--s-accent);text-decoration:none">${esc(displayName(r.first_name, r.last_name, r.email))}</a>
                          <div style="font-size:11px;color:var(--s-text-muted)">${esc(r.email ?? '—')}</div>
                        </td>
                        <td>${fmtNum(r.orders_count)}</td>
                        <td>${fmtMoney(Number(r.total_spent ?? 0))}</td>
                        <td style="color:var(--s-warning, #f59e0b);font-size:12px">${
                          r.days_since_last_order === null
                            ? 'Unknown'
                            : `${fmtNum(r.days_since_last_order)} days ago`
                        }</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            ` : '<div class="empty-state" style="padding:40px 20px"><div class="empty-state-text">No at-risk customers. All your buyers are active!</div></div>'}
          </div>
        </div>
      </div>
    `

    res.send(sellerLayout({
      title: 'Customer Behavior',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'customers',
      content,
      theme: theme as 'dark' | 'light',
    }))
  } catch (err) {
    console.error('[customer-behavior] Error:', err)
    const content = `
      <div class="page-header">
        <h1 class="page-title">Customer Behavior</h1>
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
      title: 'Customer Behavior',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'customers',
      content,
      theme: theme as 'dark' | 'light',
    }))
  }
}
