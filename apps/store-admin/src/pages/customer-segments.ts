/**
 * Store Admin — Customer Segments
 *
 * Two surfaces share this file:
 *
 *   1. Auto-segments (legacy, phase 1). Summary cards + a performance
 *      table of built-in buckets (VIPs, Repeat Buyers, At Risk, …).
 *      Query-only; no persistence.
 *
 *   2. Custom segments (phase 4 PR2). Merchant-defined rule sets
 *      stored in `customer_segments`. The editor is a plain HTML form
 *      with a "Preview count" button that re-renders with the
 *      matching-customer total, plus Save / Delete. Rule grammar is a
 *      Shopify-subset (flat AND/OR tree, safelisted fields/ops) —
 *      validation + SQL compilation live in
 *      @gbox/core/modules/customer-segments.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { sql } from 'kysely'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  createSegment,
  updateSegment,
  deleteSegment,
  listSegments,
  getSegment,
  countMatchingCustomers,
  SEGMENT_FIELD_SAFELIST,
  MAX_RULES_PER_SEGMENT,
  MAX_NAME_LENGTH,
  type SegmentRuleSet,
  type SegmentRule,
} from '@gbox/core/modules/customer-segments/index.js'
import {
  createApiContext,
  listSegments as apiListSegments,
  getSegment as apiGetSegment,
  createSegment as apiCreateSegment,
  updateSegment as apiUpdateSegment,
  bulkDeleteSegments as apiBulkDeleteSegments,
  previewSegment as apiPreviewSegment,
  applySegment as apiApplySegment,
  segmentSummary as apiSegmentSummary,
} from '../lib/customer-api-client.js'
import { formatProductApiError } from '../lib/product-api-errors.js'

export async function getCustomerSegments(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()

  let customSegments: any[] = []
  let totalCustomers = 0
  let repeatCount = 0
  let highValueCount = 0
  let newCount = 0
  let atRiskCount = 0
  let emailSubCount = 0
  let vipCount = 0
  let newThisMonth = 0

  let allCustomersPerf: any = {}
  let repeatBuyersPerf: any = {}
  let highValuePerf: any = {}
  let newCustomersPerf: any = {}
  let atRiskPerf: any = {}
  let emailSubsPerf: any = {}

  if (hasDb) {
    // Custom (merchant-defined) segments live in their own table; fetch
    // them separately so we don't bloat the auto-segments Promise.all.
    customSegments = await listSegments(db, { shop_id: store.id, limit: 250 })

    // ─── Fetch all segment data in parallel ──────────────────────
    const [
      totalCustomersResult,
      repeatCustomersResult,
      highValueResult,
      newCustomersResult,
      atRiskResult,
      emailSubscribersResult,
      vipCustomersResult,
      newThisMonthResult,
      // Segment performance data
      repeatBuyersPerfResult,
      highValuePerfResult,
      newCustomersPerfResult,
      atRiskPerfResult,
      emailSubsPerfResult,
      allCustomersPerfResult,
    ] = await Promise.all([
      // --- Summary & segment counts ---
      db.selectFrom('customers').select(db.fn.count('id').as('count')).where('shop_id', '=', store.id).executeTakeFirst(),
      db.selectFrom('orders').select(db.fn.count(sql`DISTINCT customer_id`).as('count')).where('shop_id', '=', store.id).where('customer_id', 'is not', null).groupBy('customer_id').having(db.fn.count('id'), '>', 1).execute().then(rows => ({ count: rows.length })),
      db.selectFrom('customers').select(db.fn.count('id').as('count')).where('shop_id', '=', store.id).where('total_spent', '>', 200).executeTakeFirst(),
      db.selectFrom('customers').select(db.fn.count('id').as('count')).where('shop_id', '=', store.id).where('created_at', '>=', thirtyDaysAgo).executeTakeFirst(),
      db.selectFrom('customers').innerJoin('orders', 'orders.customer_id', 'customers.id').select(db.fn.count(sql`DISTINCT customers.id`).as('count')).where('customers.shop_id', '=', store.id).where('orders.shop_id', '=', store.id).groupBy('customers.id').having(sql`MAX(orders.created_at)`, '<', ninetyDaysAgo).execute().then(rows => ({ count: rows.length })),
      db.selectFrom('customers').select(db.fn.count('id').as('count')).where('shop_id', '=', store.id).where('accepts_marketing', '=', true).executeTakeFirst(),
      db.selectFrom('customers').select(db.fn.count('id').as('count')).where('shop_id', '=', store.id).where('total_spent', '>', 500).executeTakeFirst(),
      db.selectFrom('customers').select(db.fn.count('id').as('count')).where('shop_id', '=', store.id).where('created_at', '>=', thirtyDaysAgo).executeTakeFirst(),
      
      // --- Segment performance: avg order value + total revenue ---
      db.selectFrom('orders').select([db.fn.avg('total_price').as('avg_order_value'), db.fn.sum('total_price').as('total_revenue')]).where('shop_id', '=', store.id).where('customer_id', 'in', db.selectFrom('orders').select('customer_id').where('shop_id', '=', store.id).where('customer_id', 'is not', null).groupBy('customer_id').having(db.fn.count('id'), '>', 1)).executeTakeFirst(),
      db.selectFrom('orders').select([db.fn.avg('total_price').as('avg_order_value'), db.fn.sum('total_price').as('total_revenue')]).where('shop_id', '=', store.id).where('customer_id', 'in', db.selectFrom('customers').select('id').where('shop_id', '=', store.id).where('total_spent', '>', 200)).executeTakeFirst(),
      db.selectFrom('orders').select([db.fn.avg('total_price').as('avg_order_value'), db.fn.sum('total_price').as('total_revenue')]).where('shop_id', '=', store.id).where('customer_id', 'in', db.selectFrom('customers').select('id').where('shop_id', '=', store.id).where('created_at', '>=', thirtyDaysAgo)).executeTakeFirst(),
      db.selectFrom('orders').select([db.fn.avg('total_price').as('avg_order_value'), db.fn.sum('total_price').as('total_revenue')]).where('shop_id', '=', store.id).where('customer_id', 'in', sql`(SELECT customers.id FROM customers INNER JOIN orders ON orders.customer_id = customers.id WHERE customers.shop_id = ${store.id} AND orders.shop_id = ${store.id} GROUP BY customers.id HAVING MAX(orders.created_at) < ${ninetyDaysAgo})`).executeTakeFirst(),
      db.selectFrom('orders').select([db.fn.avg('total_price').as('avg_order_value'), db.fn.sum('total_price').as('total_revenue')]).where('shop_id', '=', store.id).where('customer_id', 'in', db.selectFrom('customers').select('id').where('shop_id', '=', store.id).where('accepts_marketing', '=', true)).executeTakeFirst(),
      db.selectFrom('orders').select([db.fn.avg('total_price').as('avg_order_value'), db.fn.sum('total_price').as('total_revenue')]).where('shop_id', '=', store.id).executeTakeFirst(),
    ])

    totalCustomers = Number(totalCustomersResult?.count ?? 0)
    repeatCount = Number(repeatCustomersResult?.count ?? 0)
    highValueCount = Number(highValueResult?.count ?? 0)
    newCount = Number(newCustomersResult?.count ?? 0)
    atRiskCount = Number(atRiskResult?.count ?? 0)
    emailSubCount = Number(emailSubscribersResult?.count ?? 0)
    vipCount = Number(vipCustomersResult?.count ?? 0)
    newThisMonth = Number(newThisMonthResult?.count ?? 0)

    repeatBuyersPerf = repeatBuyersPerfResult
    highValuePerf = highValuePerfResult
    newCustomersPerf = newCustomersPerfResult
    atRiskPerf = atRiskPerfResult
    emailSubsPerf = emailSubsPerfResult
    allCustomersPerf = allCustomersPerfResult
  } else {
    // API MODE — gọi Gbox-Customer-Service. 2 calls parallel:
    //   1) listSegments → custom merchant segments
    //   2) segmentSummary → counts + perf cho 11 buckets (5 stats-derived
    //      = 0 nếu Order Service chưa push CustomerStats).
    let ctx
    try { ctx = createApiContext(req) } catch (err: any) {
      console.error('[customer-segments] auth failed:', err?.message ?? err)
    }
    if (ctx) {
      // allSettled — list / summary fail độc lập. Nếu summary BE crash thì
      // counts = 0 nhưng list segments vẫn render. Tránh 1 endpoint chết
      // kéo cả page trống.
      const [segListResult, summaryResult] = await Promise.allSettled([
        apiListSegments(ctx, { limit: 250 }),
        apiSegmentSummary(ctx),
      ])
      if (segListResult.status === 'fulfilled') {
        customSegments = segListResult.value.data ?? []
      } else {
        console.error('[customer-segments] list failed:', segListResult.reason?.message ?? segListResult.reason)
      }
      if (summaryResult.status === 'fulfilled') {
        const summary = summaryResult.value
        // BE [DataMember(EmitDefaultValue=false)] → field giá trị 0 KHÔNG được
        // serialize → JSON thiếu key → JS undefined. Defensive coalesce ?? 0.
        totalCustomers = summary.total ?? 0
        newCount = summary.new_30d ?? 0
        newThisMonth = summary.new_this_month ?? 0
        repeatCount = summary.repeat_buyers ?? 0
        highValueCount = summary.high_value ?? 0
        vipCount = summary.vip ?? 0
        atRiskCount = summary.at_risk ?? 0
        emailSubCount = summary.email_subscribers ?? 0
        const perf = summary.perf ?? {}
        allCustomersPerf = perf['all'] ?? {}
        repeatBuyersPerf = perf['repeat'] ?? {}
        highValuePerf = perf['high_value'] ?? {}
        newCustomersPerf = perf['new'] ?? {}
        atRiskPerf = perf['at_risk'] ?? {}
        emailSubsPerf = perf['email_subscribers'] ?? {}
      } else {
        console.error('[customer-segments] summary failed:', summaryResult.reason?.message ?? summaryResult.reason)
      }
    }
  }

  // ─── Segment definitions ─────────────────────────────────────

  const segments = [
    {
      key: 'all',
      name: 'All Customers',
      count: totalCustomers,
      icon: '👥',
      description: 'Every customer in your store',
      avgOrderValue: Number(allCustomersPerf?.avg_order_value ?? 0),
      totalRevenue: Number(allCustomersPerf?.total_revenue ?? 0),
    },
    {
      key: 'repeat',
      name: 'Repeat Buyers',
      count: repeatCount,
      icon: '🔄',
      description: 'Customers with more than 1 order',
      avgOrderValue: Number(repeatBuyersPerf?.avg_order_value ?? 0),
      totalRevenue: Number(repeatBuyersPerf?.total_revenue ?? 0),
    },
    {
      key: 'high-value',
      name: 'High Value',
      count: highValueCount,
      icon: '💎',
      description: 'Customers who spent over $200',
      avgOrderValue: Number(highValuePerf?.avg_order_value ?? 0),
      totalRevenue: Number(highValuePerf?.total_revenue ?? 0),
    },
    {
      key: 'new',
      name: 'New Customers',
      count: newCount,
      icon: '🆕',
      description: 'Joined in the last 30 days',
      avgOrderValue: Number(newCustomersPerf?.avg_order_value ?? 0),
      totalRevenue: Number(newCustomersPerf?.total_revenue ?? 0),
    },
    {
      key: 'at-risk',
      name: 'At Risk',
      count: atRiskCount,
      icon: '⚠️',
      description: 'No orders in the last 90 days',
      avgOrderValue: Number(atRiskPerf?.avg_order_value ?? 0),
      totalRevenue: Number(atRiskPerf?.total_revenue ?? 0),
    },
    {
      key: 'email-subscribers',
      name: 'Email Subscribers',
      count: emailSubCount,
      icon: '📧',
      description: 'Opted in to marketing emails',
      avgOrderValue: Number(emailSubsPerf?.avg_order_value ?? 0),
      totalRevenue: Number(emailSubsPerf?.total_revenue ?? 0),
    },
  ]

  // ─── Build HTML ──────────────────────────────────────────────

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/customers" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Customers
        </a>
        <h1 class="page-title">Customer Segments</h1>
        <p class="page-subtitle">Auto-generated segments plus your own rule-based lists</p>
      </div>
      <div>
        <a href="${base}/customers/segments/new" class="btn btn-primary">
          + New segment
        </a>
      </div>
    </div>

    ${renderFlashBanner(req)}

    <!-- CUSTOM SEGMENTS (merchant-defined) -->
    <div class="card" style="margin-bottom:24px">
      <div class="card-header">
        <span>Custom segments</span>
        <span style="font-size:12px;color:var(--s-text-dim)">${customSegments.length} saved</span>
      </div>
      <div class="card-body" style="padding:0">
        ${
          customSegments.length === 0
            ? `<div style="padding:24px;text-align:center;color:var(--s-text-dim);font-size:13px">
                 No custom segments yet. Build one from the rules your store cares about —
                 e.g. <em>“Accepts marketing AND spent over $200”</em>.
               </div>`
            : `<div class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Rules</th>
                      <th style="text-align:right">Updated</th>
                      <th style="text-align:right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${customSegments
                      .map((s) => {
                        const ruleset =
                          typeof s.rules_json === 'string'
                            ? (() => {
                                try {
                                  return JSON.parse(s.rules_json as unknown as string)
                                } catch {
                                  return null
                                }
                              })()
                            : (s.rules_json as unknown as SegmentRuleSet | null)
                        const summary = ruleset ? summariseRuleset(ruleset) : '—'
                        const updated = s.updated_at
                          ? new Date(s.updated_at as any).toISOString().slice(0, 10)
                          : '—'
                        const sid = String(s.id ?? '')
                        const sname = s.name ?? '(no name)'
                        return `
                          <tr>
                            <td style="font-weight:500">
                              <a href="${base}/customers/segments/${esc(sid)}" style="color:var(--s-text-primary);text-decoration:none">
                                ${esc(sname)}
                              </a>
                            </td>
                            <td style="color:var(--s-text-dim);font-size:13px">${esc(summary)}</td>
                            <td style="text-align:right;color:var(--s-text-dim);font-size:13px">${esc(updated)}</td>
                            <td style="text-align:right;white-space:nowrap">
                              <a href="${base}/customers/segments/${esc(sid)}/customers" class="btn btn-outline btn-sm" style="margin-right:6px">View customers</a>
                              <a href="${base}/customers/segments/${esc(sid)}" class="btn btn-outline btn-sm">Edit</a>
                            </td>
                          </tr>
                        `
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>`
        }
      </div>
    </div>

    <!-- SUMMARY CARDS -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${totalCustomers}</div>
        <div class="stat-label">Total Customers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${repeatCount}</div>
        <div class="stat-label">Repeat Customers</div>
        <div class="stat-change" style="color:var(--s-text-dim)">More than 1 order</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--s-accent)">${vipCount}</div>
        <div class="stat-label">VIP Customers</div>
        <div class="stat-change" style="color:var(--s-text-dim)">Over $500 spent</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--s-success)">${newThisMonth}</div>
        <div class="stat-label">New This Month</div>
        <div class="stat-change" style="color:var(--s-text-dim)">Last 30 days</div>
      </div>
    </div>

    <!-- SEGMENT CARDS -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px">
      ${segments.map(seg => `
        <div class="card">
          <div class="card-body" style="padding:20px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
              <div style="font-size:28px;line-height:1">${seg.icon}</div>
              <div>
                <div class="card-title" style="font-weight:600;font-size:15px;margin:0">${esc(seg.name)}</div>
                <div style="font-size:12px;color:var(--s-text-dim);margin-top:2px">${esc(seg.description)}</div>
              </div>
            </div>
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px">
              <div style="font-size:28px;font-weight:700">${seg.count}</div>
              <span class="badge badge-success" style="font-size:11px">customer${seg.count !== 1 ? 's' : ''}</span>
            </div>
            <a href="${base}/customers?segment=${seg.key}" class="btn btn-outline btn-sm" style="width:100%;text-align:center;display:block">View Customers</a>
          </div>
        </div>
      `).join('')}
    </div>

    <!-- SEGMENT PERFORMANCE TABLE -->
    <div class="card">
      <div class="card-header">
        <span>Segment Performance</span>
        <span style="font-size:12px;color:var(--s-text-dim)">${segments.length} segments</span>
      </div>
      <div class="card-body" style="padding:0">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Segment</th>
                <th style="text-align:right">Count</th>
                <th style="text-align:right">Avg Order Value</th>
                <th style="text-align:right">Total Revenue</th>
              </tr>
            </thead>
            <tbody>
              ${segments.map(seg => `
                <tr>
                  <td style="font-weight:500">
                    <span style="margin-right:8px">${seg.icon}</span>
                    ${esc(seg.name)}
                  </td>
                  <td style="text-align:right">
                    <span class="badge badge-success">${seg.count}</span>
                  </td>
                  <td style="text-align:right;font-weight:500">$${seg.avgOrderValue.toFixed(2)}</td>
                  <td style="text-align:right;font-weight:600">$${seg.totalRevenue.toFixed(2)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Customer Segments',
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

// ===========================================================================
// CUSTOM SEGMENTS — editor (phase 4 PR2)
// ===========================================================================

// A handful of tiny helpers that keep the handlers themselves readable.

/**
 * Render success / error query params as a top-of-page flash banner.
 * Mirrors the style used by customers.ts so the visual language stays
 * consistent across the module.
 */
function renderFlashBanner(req: Request): string {
  const success = (req.query.success as string) || ''
  const error = (req.query.error as string) || ''
  if (success) {
    const msg = FLASH_SUCCESS[success] ?? success
    return `<div style="background:#064e3b;border:1px solid #10b981;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#d1fae5;font-size:13px">${esc(msg)}</div>`
  }
  if (error) {
    return `<div style="background:#7f1d1d;border:1px solid #f87171;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#fee2e2;font-size:13px">${esc(decodeURIComponent(error))}</div>`
  }
  return ''
}

const FLASH_SUCCESS: Record<string, string> = {
  segment_created: 'Segment saved.',
  segment_updated: 'Segment updated.',
  segment_deleted: 'Segment deleted.',
}

/**
 * Human one-liner for a ruleset. Used on the list row so the merchant
 * can eyeball what a segment does without opening the editor.
 */
function summariseRuleset(rs: SegmentRuleSet): string {
  if (!rs || !Array.isArray(rs.rules) || rs.rules.length === 0) {
    return '(no rules)'
  }
  const joiner = rs.combinator === 'or' ? ' OR ' : ' AND '
  return rs.rules
    .map((r) => {
      const spec = SEGMENT_FIELD_SAFELIST[r.field]
      const label = spec?.label ?? r.field
      const op = r.op.replace(/_/g, ' ')
      if (r.value === null || r.value === undefined || r.value === '') {
        return `${label} ${op}`
      }
      return `${label} ${op} ${r.value}`
    })
    .join(joiner)
}

/**
 * On a failed POST (validation, bad JSON, preview error) we re-render
 * the editor with the merchant's submitted values intact. Express
 * gives us everything as strings or arrays-of-strings, so normalise.
 */
function normaliseForRerender(body: any): {
  name: string
  combinator: 'and' | 'or'
  rules: Array<{ field: string; op: string; value: string }>
} {
  const name = typeof body?.name === 'string' ? body.name : ''
  const combinator: 'and' | 'or' = body?.combinator === 'or' ? 'or' : 'and'
  const fields = toArray(body?.['rule_field[]'])
  const ops = toArray(body?.['rule_op[]'])
  const values = toArray(body?.['rule_value[]'])
  const rows: Array<{ field: string; op: string; value: string }> = []
  const len = Math.max(fields.length, ops.length, values.length)
  for (let i = 0; i < len; i++) {
    const field = fields[i] ?? ''
    const op = ops[i] ?? ''
    const value = values[i] ?? ''
    if (!field && !op && !value) continue
    rows.push({ field, op, value })
  }
  return { name, combinator, rules: rows }
}

function toArray(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.map((x) => String(x))
  return [String(v)]
}

/**
 * Gather merchant-submitted rules into the shape our validator expects.
 * Blank rows drop out silently; that's what lets the editor always
 * render N+1 blank rows without the merchant having to delete them.
 */
function collectRulesFromBody(body: any): SegmentRuleSet {
  const combinator = body?.combinator === 'or' ? 'or' : 'and'
  const fields = toArray(body?.['rule_field[]'])
  const ops = toArray(body?.['rule_op[]'])
  const values = toArray(body?.['rule_value[]'])
  const rules: SegmentRule[] = []
  const len = Math.max(fields.length, ops.length, values.length)
  for (let i = 0; i < len; i++) {
    const field = (fields[i] ?? '').trim()
    const op = (ops[i] ?? '').trim()
    const value = (values[i] ?? '').trim()
    // Skip rows the merchant left blank (they click "Add rule" liberally).
    if (!field && !op && !value) continue
    rules.push({ field, op, value: value === '' ? null : value })
  }
  return { combinator, rules }
}

/**
 * Render a single rule row in the editor. Index is used to keep the
 * three parallel form fields in sync when the browser posts them back.
 */
function renderRuleRow(
  i: number,
  row: { field: string; op: string; value: string },
): string {
  const fieldOptions = Object.entries(SEGMENT_FIELD_SAFELIST)
    .map(
      ([name, spec]) =>
        `<option value="${esc(name)}"${row.field === name ? ' selected' : ''}>${esc(spec.label)}</option>`,
    )
    .join('')

  // The op <select> is populated against the field in `row` so
  // server-rendered markup stays valid even without client JS.
  const activeSpec = SEGMENT_FIELD_SAFELIST[row.field]
  const opOptions = activeSpec
    ? activeSpec.ops
        .map(
          (op) =>
            `<option value="${esc(op)}"${row.op === op ? ' selected' : ''}>${esc(op.replace(/_/g, ' '))}</option>`,
        )
        .join('')
    : `<option value="">—</option>`

  return `
    <div class="rule-row" style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;margin-bottom:8px">
      <select name="rule_field[]" style="padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:13px">
        <option value="">— field —</option>
        ${fieldOptions}
      </select>
      <select name="rule_op[]" style="padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:13px">
        <option value="">— op —</option>
        ${opOptions}
      </select>
      <input type="text" name="rule_value[]" value="${esc(row.value)}" placeholder="value (leave blank for is_set / is_not_set)" style="padding:8px 10px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:13px" />
      <button type="submit" name="action" value="remove_rule:${i}" class="btn btn-outline btn-sm" title="Remove this rule" style="padding:4px 10px">×</button>
    </div>
  `
}

interface EditorState {
  mode: 'new' | 'edit'
  name: string
  combinator: 'and' | 'or'
  rules: Array<{ field: string; op: string; value: string }>
  previewCount: number | null
  error: string | null
  segmentId: string | null
}

/**
 * Render the full segment editor form. Shared between the "new" and
 * "edit" surfaces; all that varies is `mode` + the form action.
 */
function renderEditor(
  req: Request,
  base: string,
  state: EditorState,
): string {
  const action =
    state.mode === 'edit' && state.segmentId
      ? `${base}/customers/segments/${esc(state.segmentId)}`
      : `${base}/customers/segments`

  // Always render at least one rule row so the form looks like a form.
  const rows = state.rules.length > 0 ? state.rules : [{ field: '', op: '', value: '' }]

  const ruleRows = rows
    .slice(0, MAX_RULES_PER_SEGMENT)
    .map((r, i) => renderRuleRow(i, r))
    .join('')

  const previewLine =
    state.previewCount !== null
      ? `<div style="margin-top:8px;padding:10px 14px;background:var(--s-surface-alt,#0f172a);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);font-size:13px">
           <strong>${state.previewCount}</strong> customer${state.previewCount === 1 ? '' : 's'} match this segment right now.
         </div>`
      : ''

  const errorLine = state.error
    ? `<div style="margin-bottom:12px;padding:10px 14px;background:#7f1d1d;border:1px solid #f87171;border-radius:6px;color:#fee2e2;font-size:13px">${esc(state.error)}</div>`
    : ''

  return `
    <div class="page-header">
      <div>
        <a href="${base}/customers/segments" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Segments
        </a>
        <h1 class="page-title">${state.mode === 'edit' ? 'Edit segment' : 'New segment'}</h1>
      </div>
    </div>

    ${errorLine}

    <form method="POST" action="${action}" style="max-width:820px">
      ${csrfHiddenField(String((req as any).csrfToken || ''))}

      <div class="card" style="padding:20px;margin-bottom:16px">
        <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Segment name</label>
        <input
          type="text"
          name="name"
          required
          maxlength="${MAX_NAME_LENGTH}"
          value="${esc(state.name)}"
          placeholder="e.g. Marketing-opted high-spenders"
          style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px"
        />
      </div>

      <div class="card" style="padding:20px;margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <label style="font-size:13px;font-weight:600">Rules</label>
          <label style="font-size:13px;color:var(--s-text-dim)">
            Match
            <select name="combinator" style="margin:0 6px;padding:4px 8px;border:1px solid var(--s-border);border-radius:4px;background:var(--s-bg);color:var(--s-text-primary);font-size:13px">
              <option value="and"${state.combinator === 'and' ? ' selected' : ''}>ALL</option>
              <option value="or"${state.combinator === 'or' ? ' selected' : ''}>ANY</option>
            </select>
            of the following
          </label>
        </div>

        ${ruleRows}

        <div style="margin-top:12px;display:flex;gap:8px">
          <button type="submit" name="action" value="add_rule" class="btn btn-outline btn-sm">+ Add rule</button>
          <button type="submit" name="action" value="preview" class="btn btn-outline btn-sm">Preview count</button>
        </div>

        ${previewLine}
      </div>

      <div style="display:flex;gap:8px;align-items:center">
        <button type="submit" name="action" value="save" class="btn btn-primary">
          ${state.mode === 'edit' ? 'Save changes' : 'Create segment'}
        </button>
        <a href="${base}/customers/segments" class="btn btn-outline">Cancel</a>
        ${
          state.mode === 'edit' && state.segmentId
            ? `<form method="POST" action="${base}/customers/segments/${esc(state.segmentId)}/delete" style="display:inline;margin-left:auto">
                 ${csrfHiddenField(String((req as any).csrfToken || ''))}
                 <button type="submit" class="btn btn-outline btn-sm" style="color:#f87171;border-color:#f87171"
                   onclick="return confirm('Delete this segment? This cannot be undone.')">
                   Delete segment
                 </button>
               </form>`
            : ''
        }
      </div>
    </form>
  `
}

// ---------------------------------------------------------------------------
// GET /customers/segments/new — blank editor
// ---------------------------------------------------------------------------

export async function getCustomerSegmentNew(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const content = renderEditor(req, base, {
    mode: 'new',
    name: '',
    combinator: 'and',
    rules: [],
    previewCount: null,
    error: null,
    segmentId: null,
  })

  res.send(
    sellerLayout({
      title: 'New segment',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'customers',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// GET /customers/segments/:id — edit an existing segment
// ---------------------------------------------------------------------------

export async function getCustomerSegmentDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const segmentId = String(req.params.segmentId ?? req.params.id ?? '')
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  let segment: any = null
  if (!hasDb) {
    try {
      const ctx = createApiContext(req)
      segment = await apiGetSegment(ctx, segmentId)
    } catch (err: any) {
      const msg = formatProductApiError(err)
      res.redirect(`${base}/customers/segments?error=${encodeURIComponent(msg)}`)
      return
    }
  } else {
    segment = await getSegment(db, { shop_id: store.id, id: segmentId })
  }
  if (!segment) {
    res.redirect(
      `${base}/customers/segments?error=${encodeURIComponent('Segment not found')}`,
    )
    return
  }

  const ruleset =
    typeof segment.rules_json === 'string'
      ? (() => {
          try {
            return JSON.parse(segment.rules_json as unknown as string) as SegmentRuleSet
          } catch {
            return { combinator: 'and', rules: [] } as SegmentRuleSet
          }
        })()
      : ((segment.rules_json as unknown as SegmentRuleSet) ?? {
          combinator: 'and',
          rules: [],
        })

  const content = renderEditor(req, base, {
    mode: 'edit',
    name: segment.name ?? '',
    combinator: ruleset.combinator ?? 'and',
    rules: (ruleset.rules ?? []).map((r) => ({
      field: r.field,
      op: r.op,
      value: r.value == null ? '' : String(r.value),
    })),
    previewCount: null,
    error: null,
    segmentId,
  })

  res.send(
    sellerLayout({
      title: `Edit segment · ${segment.name ?? ''}`,
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'customers',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// Shared POST handler — create + update both route through here.
//
// Actions (submit-button values, no JS bundle required):
//   - save          persist + redirect
//   - preview       validate + count + re-render editor with number
//   - add_rule      re-render editor with one extra blank row
//   - remove_rule:N re-render editor with row N dropped
// ---------------------------------------------------------------------------

async function handleEditorSubmit(
  req: Request,
  res: Response,
  db: Kysely<Database>,
  mode: 'new' | 'edit',
  segmentId: string | null,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const rawAction = String(req.body?.action ?? 'save')
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  const form = normaliseForRerender(req.body)

  // Row mutators — these never touch the DB, just re-render the editor
  // with the merchant's rows shuffled.
  if (rawAction === 'add_rule') {
    form.rules.push({ field: '', op: '', value: '' })
    return renderWithState(req, res, mode, segmentId, form, null, null, theme, base, store, user)
  }
  if (rawAction.startsWith('remove_rule:')) {
    const n = Number(rawAction.split(':', 2)[1])
    if (Number.isFinite(n)) form.rules.splice(n, 1)
    return renderWithState(req, res, mode, segmentId, form, null, null, theme, base, store, user)
  }

  // Preview and save both need the rules to validate.
  const ruleset = collectRulesFromBody(req.body)

  if (rawAction === 'preview') {
    if (!hasDb) {
      try {
        const ctx = createApiContext(req)
        const r = await apiPreviewSegment(ctx, ruleset as any)
        return renderWithState(req, res, mode, segmentId, form, r.count, null, theme, base, store, user)
      } catch (err: any) {
        const msg = formatProductApiError(err)
        return renderWithState(req, res, mode, segmentId, form, null, msg, theme, base, store, user)
      }
    }
    try {
      const count = await countMatchingCustomers(db, store.id, ruleset)
      return renderWithState(
        req,
        res,
        mode,
        segmentId,
        form,
        count,
        null,
        theme,
        base,
        store,
        user,
      )
    } catch (err: any) {
      return renderWithState(
        req,
        res,
        mode,
        segmentId,
        form,
        null,
        err?.message || 'Rules failed to validate',
        theme,
        base,
        store,
        user,
      )
    }
  }

  if (!hasDb) {
    try {
      const ctx = createApiContext(req)
      if (mode === 'new') {
        const created = await apiCreateSegment(ctx, { name: form.name, rules: ruleset as any })
        res.redirect(`${base}/customers/segments/${esc(String(created.id))}?success=segment_created`)
      } else {
        const updated = await apiUpdateSegment(ctx, segmentId!, { name: form.name, rules: ruleset as any })
        if (!updated) {
          res.redirect(`${base}/customers/segments?error=${encodeURIComponent('Segment not found')}`)
          return
        }
        res.redirect(`${base}/customers/segments/${esc(String(updated.id))}?success=segment_updated`)
      }
    } catch (err: any) {
      const msg = formatProductApiError(err)
      return renderWithState(req, res, mode, segmentId, form, null, msg, theme, base, store, user)
    }
    return
  }

  // Save path — validate name + rules, write, redirect.
  try {
    if (mode === 'new') {
      const created = await createSegment(db, {
        shop_id: store.id,
        name: form.name,
        rules: ruleset,
      })
      res.redirect(
        `${base}/customers/segments/${esc(String(created.id))}?success=segment_created`,
      )
    } else {
      const updated = await updateSegment(db, {
        shop_id: store.id,
        id: segmentId!,
        name: form.name,
        rules: ruleset,
      })
      if (!updated) {
        res.redirect(
          `${base}/customers/segments?error=${encodeURIComponent('Segment not found')}`,
        )
        return
      }
      res.redirect(
        `${base}/customers/segments/${esc(String(updated.id))}?success=segment_updated`,
      )
    }
  } catch (err: any) {
    return renderWithState(
      req,
      res,
      mode,
      segmentId,
      form,
      null,
      err?.message || 'Failed to save segment',
      theme,
      base,
      store,
      user,
    )
  }

}

function renderWithState(
  req: Request,
  res: Response,
  mode: 'new' | 'edit',
  segmentId: string | null,
  form: ReturnType<typeof normaliseForRerender>,
  previewCount: number | null,
  error: string | null,
  theme: string,
  base: string,
  store: any,
  user: any,
): void {
  const content = renderEditor(req, base, {
    mode,
    name: form.name,
    combinator: form.combinator,
    rules: form.rules,
    previewCount,
    error,
    segmentId,
  })
  res.send(
    sellerLayout({
      title: mode === 'new' ? 'New segment' : 'Edit segment',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'customers',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /customers/segments — create (or preview / add / remove row)
// ---------------------------------------------------------------------------

export async function postCustomerSegmentCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  return handleEditorSubmit(req, res, db, 'new', null)
}

// ---------------------------------------------------------------------------
// POST /customers/segments/:id — update (or preview / add / remove row)
// ---------------------------------------------------------------------------

export async function postCustomerSegmentUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const segmentId = String(req.params.segmentId ?? req.params.id ?? '')
  return handleEditorSubmit(req, res, db, 'edit', segmentId)
}

// ---------------------------------------------------------------------------
// POST /customers/segments/:id/delete — hard delete
// ---------------------------------------------------------------------------

export async function postCustomerSegmentDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${esc(store.slug)}`
  const segmentId = String(req.params.segmentId ?? req.params.id ?? '')
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  if (!hasDb) {
    try {
      const ctx = createApiContext(req)
      await apiBulkDeleteSegments(ctx, [segmentId])
      res.redirect(`${base}/customers/segments?success=segment_deleted`)
    } catch (err: any) {
      const msg = formatProductApiError(err)
      res.redirect(`${base}/customers/segments?error=${encodeURIComponent(msg)}`)
    }
    return
  }

  try {
    const ok = await deleteSegment(db, { shop_id: store.id, id: segmentId })
    if (!ok) {
      res.redirect(
        `${base}/customers/segments?error=${encodeURIComponent('Segment not found')}`,
      )
      return
    }
    res.redirect(`${base}/customers/segments?success=segment_deleted`)
  } catch (err: any) {
    res.redirect(
      `${base}/customers/segments?error=${encodeURIComponent(err?.message || 'Failed to delete segment')}`,
    )
  }
}
