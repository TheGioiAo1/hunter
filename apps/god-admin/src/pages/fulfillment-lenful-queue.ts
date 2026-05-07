/**
 * God Admin — Lenful Fulfillment Queue (Phase F2)
 *
 *   GET  /god-admin/fulfillments/lenful-queue                   — list
 *   POST /god-admin/fulfillments/lenful-queue/:orderId/push     — manual push
 *   POST /god-admin/fulfillments/lenful-queue/bulk-push         — push many
 *
 * What F2 adds on top of F0/F1
 * ----------------------------
 * • Shop filter dropdown (derived from live lenful_orders rows)
 * • Date range (created_at / last_push_at) — uses `from` + `to` YYYY-MM-DD
 * • Free-text search (order_number or lenful_order_id)
 * • Checkbox multi-select + "Push selected" bulk action
 * • Exponential backoff — retry button disabled until
 *     `next_retry_at = last_push_at + min(2^push_attempts * 10s, 1h)`
 * • Tracks attempt count in the existing `lenful_orders.push_attempts`
 *
 * Every bulk push still runs serially (to respect the 2 req/s rate
 * limiter in LenfulClient) and logs a per-order outcome banner.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
import {
  pushOrderToLenful,
  getActiveCredential,
  syncTrackingGlobal,
  syncTrackingForRow,
} from '../../../../packages/core/src/modules/fulfillment/lenful/index.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_lenful_queue' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function esc(s: unknown): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(iso)
  }
}

function statusBadge(status: string | null | undefined): string {
  const s = String(status || 'none').toLowerCase()
  const colors: Record<string, string> = {
    queued: '#64748b',
    pushed: '#3b82f6',
    paid: '#8b5cf6',
    in_production: '#f59e0b',
    shipped: '#10b981',
    delivered: '#22c55e',
    cancelled: '#ef4444',
    failed: '#ef4444',
    none: '#64748b',
  }
  const color = colors[s] ?? '#64748b'
  return `<span style="display:inline-block;padding:2px 10px;background:${color}22;color:${color};border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase">${esc(s)}</span>`
}

/**
 * Exponential backoff helper — returns the next eligible retry instant
 * for a row that is currently in `failed` status.
 *
 *   delay = min(2^attempts * 10s, 1h)
 *
 * Returns `null` if the row has no previous push (so it can be pushed
 * immediately), or if attempts is 0.
 */
function computeNextRetryAt(lastPushAt: Date | string | null, attempts: number): Date | null {
  if (!lastPushAt || attempts <= 0) return null
  const base = typeof lastPushAt === 'string' ? new Date(lastPushAt) : lastPushAt
  if (Number.isNaN(base.getTime())) return null
  const delayMs = Math.min(Math.pow(2, attempts) * 10_000, 60 * 60 * 1000)
  return new Date(base.getTime() + delayMs)
}

function retryReady(lastPushAt: Date | string | null, attempts: number): boolean {
  const next = computeNextRetryAt(lastPushAt, attempts)
  if (!next) return true
  return Date.now() >= next.getTime()
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/lenful-queue
// ---------------------------------------------------------------------------

interface QueueFilters {
  status: string
  shopId: string
  fromDate: string
  toDate: string
  search: string
  page: number
}

function readFilters(req: Request): QueueFilters {
  return {
    status: typeof req.query.status === 'string' ? req.query.status : 'all',
    shopId: typeof req.query.shop === 'string' ? req.query.shop : '',
    fromDate: typeof req.query.from === 'string' ? req.query.from : '',
    toDate: typeof req.query.to === 'string' ? req.query.to : '',
    search: typeof req.query.q === 'string' ? req.query.q.trim() : '',
    page: Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1),
  }
}

function filtersToQuery(f: QueueFilters, override: Partial<QueueFilters> = {}): string {
  const merged = { ...f, ...override }
  const q = new URLSearchParams()
  if (merged.status && merged.status !== 'all') q.set('status', merged.status)
  if (merged.shopId) q.set('shop', merged.shopId)
  if (merged.fromDate) q.set('from', merged.fromDate)
  if (merged.toDate) q.set('to', merged.toDate)
  if (merged.search) q.set('q', merged.search)
  if (merged.page > 1) q.set('page', String(merged.page))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export async function getLenfulQueue(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)
  const flash = typeof req.query.msg === 'string' ? req.query.msg : ''
  const err = typeof req.query.err === 'string' ? req.query.err : ''
  const filters = readFilters(req)
  const PAGE_SIZE = 50

  try {
    const cred = await getActiveCredential(db)

    // Distinct shops appearing in lenful_orders (for the dropdown).
    const shopOptionsRaw = await db
      .selectFrom('lenful_orders')
      .select((eb) => [
        'gbox_shop_id',
        'gbox_shop_name',
        'gbox_shop_slug',
        eb.fn.countAll<number>().as('n'),
      ])
      .groupBy(['gbox_shop_id', 'gbox_shop_name', 'gbox_shop_slug'])
      .orderBy('gbox_shop_name', 'asc')
      .execute()

    // Main query with all filters applied.
    let q = db
      .selectFrom('lenful_orders as lo')
      .innerJoin('orders as o', 'o.id', 'lo.gbox_order_id')
      .select([
        'lo.id as lo_id',
        'lo.status as status',
        'lo.lenful_order_id as lenful_order_id',
        'lo.lenful_order_number as lenful_order_number',
        'lo.last_error_code as last_error_code',
        'lo.last_error_msg as last_error_msg',
        'lo.last_push_at as last_push_at',
        'lo.push_attempts as push_attempts',
        'lo.gbox_order_id as gbox_order_id',
        'lo.gbox_shop_id as gbox_shop_id',
        'lo.gbox_shop_name as shop_name',
        'lo.gbox_shop_slug as shop_slug',
        'lo.gbox_seller_email as seller_email',
        'lo.order_number_sent as order_number_sent',
        'lo.created_at as queue_created_at',
        'lo.updated_at as queue_updated_at',
        'o.order_number as order_number',
        'o.total_price as total_price',
        'o.email as customer_email',
        'o.created_at as order_created_at',
      ])

    if (filters.status !== 'all') q = q.where('lo.status', '=', filters.status as any)
    if (filters.shopId) q = q.where('lo.gbox_shop_id', '=', filters.shopId)
    if (filters.fromDate) {
      q = q.where('lo.created_at', '>=', new Date(filters.fromDate + 'T00:00:00Z') as any)
    }
    if (filters.toDate) {
      q = q.where('lo.created_at', '<=', new Date(filters.toDate + 'T23:59:59Z') as any)
    }
    if (filters.search) {
      const s = `%${filters.search}%`
      q = q.where((eb) =>
        eb.or([
          eb(sql`${eb.ref('o.order_number')}::text`, 'ilike', s),
          eb('lo.lenful_order_id', 'ilike', s),
          eb('lo.lenful_order_number', 'ilike', s),
          eb('lo.order_number_sent', 'ilike', s),
        ]),
      )
    }

    // Total count for pagination
    let countQ = db.selectFrom('lenful_orders as lo')
      .innerJoin('orders as o', 'o.id', 'lo.gbox_order_id')
      .select((eb) => eb.fn.countAll<number>().as('n'))
    if (filters.status !== 'all') countQ = countQ.where('lo.status', '=', filters.status as any)
    if (filters.shopId) countQ = countQ.where('lo.gbox_shop_id', '=', filters.shopId)
    if (filters.fromDate) {
      countQ = countQ.where('lo.created_at', '>=', new Date(filters.fromDate + 'T00:00:00Z') as any)
    }
    if (filters.toDate) {
      countQ = countQ.where('lo.created_at', '<=', new Date(filters.toDate + 'T23:59:59Z') as any)
    }
    if (filters.search) {
      const s = `%${filters.search}%`
      countQ = countQ.where((eb) =>
        eb.or([
          eb(sql`${eb.ref('o.order_number')}::text`, 'ilike', s),
          eb('lo.lenful_order_id', 'ilike', s),
          eb('lo.lenful_order_number', 'ilike', s),
          eb('lo.order_number_sent', 'ilike', s),
        ]),
      )
    }
    const countRow = await countQ.executeTakeFirst()
    const total = Number(countRow?.n ?? 0)
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

    const rowsExisting = await q
      .orderBy('lo.updated_at', 'desc')
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE)
      .execute()

    // Unpushed orders — only shown on first page, when status=all and no search.
    const showUnpushed =
      filters.status === 'all' && !filters.search && filters.page === 1

    const unpushed = showUnpushed
      ? await db
          .selectFrom('orders as o')
          .leftJoin('lenful_orders as lo', 'lo.gbox_order_id', 'o.id')
          .leftJoin('shops as s', 's.id', 'o.shop_id')
          .select([
            'o.id as gbox_order_id',
            'o.order_number as order_number',
            'o.total_price as total_price',
            'o.email as customer_email',
            'o.created_at as order_created_at',
            's.id as shop_id',
            's.name as shop_name',
            's.slug as shop_slug',
          ])
          .where('lo.id', 'is', null)
          .where((eb) =>
            eb.or([
              eb('o.financial_status' as any, '=', 'paid'),
              eb('o.financial_status' as any, '=', 'authorized'),
            ]),
          )
          .where((eb) =>
            eb.or([
              eb('o.fulfillment_status' as any, 'is', null),
              eb('o.fulfillment_status' as any, '=', 'unfulfilled'),
            ]),
          )
          .$if(Boolean(filters.shopId), (qb) => qb.where('s.id', '=', filters.shopId))
          .$if(Boolean(filters.fromDate), (qb) =>
            qb.where('o.created_at', '>=', new Date(filters.fromDate + 'T00:00:00Z') as any),
          )
          .$if(Boolean(filters.toDate), (qb) =>
            qb.where('o.created_at', '<=', new Date(filters.toDate + 'T23:59:59Z') as any),
          )
          .orderBy('o.created_at', 'desc')
          .limit(50)
          .execute()
      : []

    // ─── Render rows ──────────────────────────────────────────
    const existingRows = rowsExisting.length
      ? rowsExisting
          .map((r) => {
            const ready = retryReady(r.last_push_at as any, Number(r.push_attempts ?? 0))
            const nextAt = computeNextRetryAt(r.last_push_at as any, Number(r.push_attempts ?? 0))
            const canPush = r.status === 'queued' || r.status === 'failed'
            const errCol = r.last_error_msg
              ? `<div style="color:#ef4444;font-size:11px;font-family:monospace;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.last_error_msg)}">${esc(r.last_error_code || 'ERR')}: ${esc(r.last_error_msg.slice(0, 100))}</div>`
              : '—'
            const checkbox = canPush
              ? `<input type="checkbox" name="ids" value="${esc(r.gbox_order_id)}" class="queue-check" style="cursor:pointer" ${ready ? '' : 'disabled'}>`
              : ''
            const pushBtn = canPush
              ? ready
                ? `<form method="post" action="/god-admin/fulfillments/lenful-queue/${esc(r.gbox_order_id)}/push" style="display:inline">${csrfField}<button type="submit" style="padding:5px 12px;background:#3b82f6;color:#fff;border:none;border-radius:5px;font-size:11px;cursor:pointer">Push now</button></form>`
                : `<span title="Next retry at ${esc(fmtDate(nextAt))}" style="padding:5px 12px;background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:5px;font-size:11px;cursor:not-allowed">wait ${esc(fmtDate(nextAt))}</span>`
              : `<span style="color:#64748b;font-size:11px">—</span>`
            return `
              <tr style="border-bottom:1px solid #1e293b">
                <td style="padding:10px 12px;text-align:center">${checkbox}</td>
                <td style="padding:10px 12px">${statusBadge(r.status)}</td>
                <td style="padding:10px 12px;font-size:12px">
                  <div style="font-weight:600">#${esc(r.order_number)}</div>
                  <div style="color:#64748b;font-family:monospace;font-size:10px">${esc(r.order_number_sent || '')}</div>
                </td>
                <td style="padding:10px 12px;font-size:12px">
                  <div>${esc(r.shop_name || '-')}</div>
                  <div style="color:#64748b;font-size:10px">${esc(r.seller_email || '-')}</div>
                </td>
                <td style="padding:10px 12px;font-size:12px">${esc(r.customer_email || '-')}</td>
                <td style="padding:10px 12px;font-size:12px;font-family:monospace">${esc(r.lenful_order_id || '—')}</td>
                <td style="padding:10px 12px">${errCol}</td>
                <td style="padding:10px 12px;font-size:11px;color:#94a3b8">${fmtDate(r.last_push_at as any)} (${r.push_attempts ?? 0}×)</td>
                <td style="padding:10px 12px">${pushBtn}</td>
              </tr>`
          })
          .join('')
      : ''

    const unpushedRows = unpushed.length
      ? unpushed
          .map(
            (r) => `
        <tr style="border-bottom:1px solid #1e293b;background:#0b1220">
          <td style="padding:10px 12px;text-align:center">
            <input type="checkbox" name="ids" value="${esc(r.gbox_order_id)}" class="queue-check" style="cursor:pointer">
          </td>
          <td style="padding:10px 12px">${statusBadge('none')}</td>
          <td style="padding:10px 12px;font-size:12px;font-weight:600">#${esc(r.order_number)}</td>
          <td style="padding:10px 12px;font-size:12px">${esc(r.shop_name || '-')}</td>
          <td style="padding:10px 12px;font-size:12px">${esc(r.customer_email || '-')}</td>
          <td style="padding:10px 12px;font-size:11px;color:#64748b">—</td>
          <td style="padding:10px 12px;font-size:11px;color:#64748b">Not pushed yet</td>
          <td style="padding:10px 12px;font-size:11px;color:#94a3b8">${fmtDate(r.order_created_at as any)}</td>
          <td style="padding:10px 12px">
            <form method="post" action="/god-admin/fulfillments/lenful-queue/${esc(r.gbox_order_id)}/push" style="display:inline">
              ${csrfField}
              <button type="submit" style="padding:5px 12px;background:#10b981;color:#fff;border:none;border-radius:5px;font-size:11px;cursor:pointer">Push to Lenful</button>
            </form>
          </td>
        </tr>`,
          )
          .join('')
      : ''

    const allRows =
      (existingRows + unpushedRows) ||
      '<tr><td colspan="9" style="padding:32px;text-align:center;color:#64748b">No orders match this filter.</td></tr>'

    const credBanner = cred
      ? `<div style="padding:10px 14px;background:#10b98122;color:#10b981;border-radius:8px;margin-bottom:16px;font-size:12px">
          Using credential <strong>${esc(cred.label)}</strong> (${esc(cred.user_name)}) → store <code>${esc(cred.lenful_store_id || 'NOT-SET')}</code>.
          ${cred.lenful_store_id ? '' : ' ⚠ Store ID missing — run Test on the credential first.'}
        </div>`
      : `<div style="padding:10px 14px;background:#ef444422;color:#ef4444;border-radius:8px;margin-bottom:16px;font-size:12px">
          No active Lenful credential. <a href="/god-admin/fulfillments/credentials" style="color:#fff;text-decoration:underline">Add one first</a>.
        </div>`

    const flashBanner = flash
      ? `<div style="padding:10px 14px;background:#10b98122;color:#10b981;border-radius:8px;margin-bottom:16px;font-size:12px;white-space:pre-wrap">${esc(flash)}</div>`
      : ''
    const errBanner = err
      ? `<div style="padding:10px 14px;background:#ef444422;color:#ef4444;border-radius:8px;margin-bottom:16px;font-size:12px;white-space:pre-wrap">${esc(err)}</div>`
      : ''

    const statusChips = ['all', 'queued', 'pushed', 'failed', 'paid', 'in_production', 'shipped']
      .map(
        (f) =>
          `<a href="${filtersToQuery(filters, { status: f, page: 1 }) || '?'}" style="padding:6px 14px;background:${
            filters.status === f ? '#3b82f6' : 'transparent'
          };color:${filters.status === f ? '#fff' : '#94a3b8'};border:1px solid #334155;border-radius:6px;font-size:12px;text-decoration:none;margin-right:6px">${f}</a>`,
      )
      .join('')

    const shopOptionsHtml = shopOptionsRaw
      .map(
        (s) =>
          `<option value="${esc(s.gbox_shop_id)}" ${s.gbox_shop_id === filters.shopId ? 'selected' : ''}>${esc(s.gbox_shop_name)} (${Number(s.n)})</option>`,
      )
      .join('')

    const prevPage = Math.max(1, filters.page - 1)
    const nextPage = Math.min(pageCount, filters.page + 1)
    const pager = `
      <div style="display:flex;gap:8px;align-items:center;padding:14px 16px;border-top:1px solid #1e293b;font-size:12px">
        <span style="color:#94a3b8">Page ${filters.page} / ${pageCount} • ${total} matching rows</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          ${filters.page > 1 ? `<a href="${filtersToQuery(filters, { page: prevPage })}" style="padding:6px 12px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none">← Prev</a>` : ''}
          ${filters.page < pageCount ? `<a href="${filtersToQuery(filters, { page: nextPage })}" style="padding:6px 12px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none">Next →</a>` : ''}
        </div>
      </div>`

    const content = `
      <div class="page-header">
        <h1>Lenful Fulfillment Queue</h1>
        <p style="color:#94a3b8;font-size:13px;margin:4px 0 0">
          Manually push Gbox orders to Lenful. Rule 4: every pushed order carries a <code>GBOX-&lt;shopSlug&gt;-&lt;orderNumber&gt;</code> tag + a <code>[GBOX]</code> note so we can trace it back.
        </p>
      </div>

      ${credBanner}
      ${flashBanner}
      ${errBanner}

      <!-- F3: Sync tracking button -->
      <form method="POST" action="/god-admin/fulfillments/lenful-queue/sync-tracking" style="display:inline-block;margin-bottom:12px">
        ${csrfField}
        <button type="submit" style="padding:9px 18px;background:#8b5cf6;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">
          Sync tracking from Lenful
        </button>
      </form>

      <!-- FILTERS -->
      <form method="GET" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px;padding:14px;background:#0f172a;border:1px solid #1e293b;border-radius:10px">
        <input type="hidden" name="status" value="${esc(filters.status)}">
        <label style="display:block;font-size:11px;color:#94a3b8">Shop
          <select name="shop" style="display:block;margin-top:4px;padding:8px 12px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0;min-width:200px">
            <option value="">All shops</option>
            ${shopOptionsHtml}
          </select>
        </label>
        <label style="display:block;font-size:11px;color:#94a3b8">From
          <input type="date" name="from" value="${esc(filters.fromDate)}" style="display:block;margin-top:4px;padding:8px 12px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0">
        </label>
        <label style="display:block;font-size:11px;color:#94a3b8">To
          <input type="date" name="to" value="${esc(filters.toDate)}" style="display:block;margin-top:4px;padding:8px 12px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0">
        </label>
        <label style="display:block;font-size:11px;color:#94a3b8;flex:1;min-width:220px">Search
          <input type="text" name="q" value="${esc(filters.search)}" placeholder="order number or lenful id"
                 style="display:block;margin-top:4px;padding:8px 12px;background:#020617;border:1px solid #334155;border-radius:6px;color:#e2e8f0;width:100%">
        </label>
        <button type="submit" style="padding:9px 18px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Apply</button>
        <a href="/god-admin/fulfillments/lenful-queue" style="padding:9px 14px;background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:6px;font-size:13px;text-decoration:none">Reset</a>
      </form>

      <div style="margin-bottom:16px">${statusChips}</div>

      <!-- BULK FORM wraps the table so checked boxes submit to bulk-push -->
      <form method="POST" action="/god-admin/fulfillments/lenful-queue/bulk-push" id="bulkForm">
        ${csrfField}
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
          <label style="font-size:12px;color:#94a3b8;display:flex;gap:6px;align-items:center">
            <input type="checkbox" id="selectAll"> Select all on this page
          </label>
          <span id="selectCount" style="font-size:11px;color:#64748b">0 selected</span>
          <button type="submit" id="bulkPushBtn" disabled
                  style="margin-left:auto;padding:8px 18px;background:#6366f1;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;opacity:0.5">
            Push selected
          </button>
        </div>

        <div class="card" style="padding:0;overflow:hidden">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:#0f172a;border-bottom:1px solid #1e293b">
                <th style="padding:10px 12px;width:30px;text-align:center;font-size:11px;color:#94a3b8"></th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Status</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Gbox order</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Shop / Seller</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Customer</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Lenful ID</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Last error</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Last push</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Action</th>
              </tr>
            </thead>
            <tbody>${allRows}</tbody>
          </table>
          ${pager}
        </div>
      </form>

      <div style="margin-top:24px;padding:16px;background:#0f172a;border-radius:8px;border:1px solid #1e293b;font-size:12px;color:#94a3b8;line-height:1.7">
        <strong style="color:#e2e8f0">📋 F2 retry policy</strong><br>
        • Each failed row is retry-locked for <code>min(2^attempts × 10s, 1h)</code> after <code>last_push_at</code>.<br>
        • "Push selected" runs serially at 2 req/s to respect Lenful's rate limit.<br>
        • Rows blocked by backoff are shown with <em>"wait …"</em> and cannot be selected.<br>
        • Tracking sync (Lenful → Gbox) lands in F3, wallet alerts in F5, API log viewer in F6.
      </div>

      <script>
        (function() {
          var form = document.getElementById('bulkForm')
          if (!form) return
          var selectAll = document.getElementById('selectAll')
          var pushBtn = document.getElementById('bulkPushBtn')
          var count = document.getElementById('selectCount')
          function update() {
            var checks = form.querySelectorAll('input.queue-check:not(:disabled)')
            var sel = 0
            checks.forEach(function (c) { if (c.checked) sel++ })
            count.textContent = sel + ' selected'
            pushBtn.disabled = sel === 0
            pushBtn.style.opacity = sel === 0 ? '0.5' : '1'
          }
          selectAll.addEventListener('change', function () {
            var checks = form.querySelectorAll('input.queue-check:not(:disabled)')
            checks.forEach(function (c) { c.checked = selectAll.checked })
            update()
          })
          form.addEventListener('change', function (e) {
            if (e.target && e.target.classList && e.target.classList.contains('queue-check')) update()
          })
          form.addEventListener('submit', function (e) {
            var checks = form.querySelectorAll('input.queue-check:checked')
            if (checks.length === 0) {
              e.preventDefault()
              alert('Select at least one order to push.')
              return
            }
            if (!confirm('Push ' + checks.length + ' order(s) to Lenful?')) e.preventDefault()
          })
          update()
        })()
      </script>
    `

    res.send(
      godLayout({
        title: 'Lenful Queue',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/lenful-queue',
        content,
      }),
    )
  } catch (e) {
    console.error('[God Admin] Lenful queue error:', e)
    res.status(500).send(
      godLayout({
        title: 'Lenful Queue',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/lenful-queue',
        content: `<div class="card" style="padding:20px"><p style="color:#ef4444">Error: ${esc(
          String(e),
        )}</p></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/lenful-queue/:orderId/push
// ---------------------------------------------------------------------------

export async function postLenfulQueuePush(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/lenful-queue?err=' + encodeURIComponent('CSRF token expired. Try again.'))
    return
  }
  const user = req.godAdmin!.user
  const gboxOrderId = String(req.params.orderId ?? '')

  // Respect exponential backoff for failed rows
  const existing = await db
    .selectFrom('lenful_orders')
    .select(['status', 'push_attempts', 'last_push_at'])
    .where('gbox_order_id', '=', gboxOrderId)
    .executeTakeFirst()
  if (existing && existing.status === 'failed') {
    const next = computeNextRetryAt(existing.last_push_at as any, Number(existing.push_attempts ?? 0))
    if (next && Date.now() < next.getTime()) {
      res.redirect(
        '/god-admin/fulfillments/lenful-queue?err=' +
          encodeURIComponent(`Retry locked until ${next.toISOString()}. Wait for the backoff window.`),
      )
      return
    }
  }

  try {
    const result = await pushOrderToLenful(db, {
      gboxOrderId,
      triggeredBy: 'god-admin-manual',
      userId: user.id,
    })
    if (result.ok) {
      res.redirect(
        '/god-admin/fulfillments/lenful-queue?msg=' +
          encodeURIComponent(
            `Order pushed to Lenful (id ${result.lenfulOrderId || result.lenfulOrderRowId.slice(0, 8)}).`,
          ),
      )
      return
    }
    res.redirect(
      '/god-admin/fulfillments/lenful-queue?err=' +
        encodeURIComponent(
          `Push failed: ${result.errorCode || '?'} — ${result.errorMsg || 'unknown'}`,
        ),
    )
  } catch (e: any) {
    console.error('[God Admin] Lenful queue push error:', e)
    res.redirect(
      '/god-admin/fulfillments/lenful-queue?err=' +
        encodeURIComponent('Push failed: ' + (e?.message || String(e))),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/lenful-queue/bulk-push  (Phase F2)
// body: ids[] — list of gbox_order_id values to push. Serial, 2 req/s.
// ---------------------------------------------------------------------------

export async function postLenfulQueueBulkPush(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/lenful-queue?err=' + encodeURIComponent('CSRF token expired. Try again.'))
    return
  }
  const user = req.godAdmin!.user
  const raw = (req.body as any)?.ids
  const ids: string[] = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string' && raw
    ? [raw]
    : []
  if (ids.length === 0) {
    res.redirect(
      '/god-admin/fulfillments/lenful-queue?err=' + encodeURIComponent('No orders selected.'),
    )
    return
  }

  let okCount = 0
  let failCount = 0
  let skipCount = 0
  const errors: string[] = []

  for (const gboxOrderId of ids) {
    // Respect exponential backoff — skip locked rows so one blocked entry
    // doesn't stall the bulk run.
    const existing = await db
      .selectFrom('lenful_orders')
      .select(['status', 'push_attempts', 'last_push_at'])
      .where('gbox_order_id', '=', gboxOrderId)
      .executeTakeFirst()
    if (existing && existing.status === 'failed') {
      const next = computeNextRetryAt(existing.last_push_at as any, Number(existing.push_attempts ?? 0))
      if (next && Date.now() < next.getTime()) {
        skipCount++
        errors.push(`${gboxOrderId.slice(0, 8)}: backoff until ${next.toISOString()}`)
        continue
      }
    }
    try {
      const result = await pushOrderToLenful(db, {
        gboxOrderId,
        triggeredBy: 'god-admin-bulk',
        userId: user.id,
      })
      if (result.ok) {
        okCount++
      } else {
        failCount++
        errors.push(`${gboxOrderId.slice(0, 8)}: ${result.errorCode || '?'} ${result.errorMsg || ''}`)
      }
    } catch (e: any) {
      failCount++
      errors.push(`${gboxOrderId.slice(0, 8)}: ${e?.message ?? String(e)}`)
    }
  }

  const summary = `Bulk push finished — ${okCount} ok, ${failCount} failed, ${skipCount} skipped (backoff).`
  const detail = errors.length > 0 ? '\n' + errors.slice(0, 10).join('\n') : ''
  if (failCount > 0 || skipCount > 0) {
    res.redirect(
      '/god-admin/fulfillments/lenful-queue?err=' + encodeURIComponent(summary + detail),
    )
  } else {
    res.redirect('/god-admin/fulfillments/lenful-queue?msg=' + encodeURIComponent(summary))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/lenful-queue/sync-tracking  (Phase F3)
// Global poll of Lenful /api/order/tracking_item → mirror into our DB.
// ---------------------------------------------------------------------------

export async function postLenfulQueueSyncTracking(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/lenful-queue?err=' + encodeURIComponent('CSRF token expired. Try again.'))
    return
  }
  const user = req.godAdmin!.user
  try {
    const result = await syncTrackingGlobal(db, {
      triggeredBy: 'god-admin-sync-tracking',
      userId: user.id,
      maxPages: 5,
    })
    const summary = `Tracking sync ${result.ok ? 'done' : 'finished with errors'} — fetched ${result.fetched}, updated ${result.updated}, matched-no-change ${result.matched}, skipped ${result.skipped}.`
    const detail = result.errors.length > 0 ? '\n' + result.errors.slice(0, 10).join('\n') : ''
    if (!result.ok || result.errors.length > 0) {
      res.redirect(
        '/god-admin/fulfillments/lenful-queue?err=' + encodeURIComponent(summary + detail),
      )
    } else {
      res.redirect('/god-admin/fulfillments/lenful-queue?msg=' + encodeURIComponent(summary))
    }
  } catch (e: any) {
    console.error('[god-admin] tracking sync error:', e)
    res.redirect(
      '/god-admin/fulfillments/lenful-queue?err=' +
        encodeURIComponent('Tracking sync failed: ' + (e?.message || String(e))),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/lenful-queue/:orderId/sync  (Phase F3)
// Targeted single-row tracking sync (triggered from the row action column).
// ---------------------------------------------------------------------------

export async function postLenfulQueueSyncRow(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/lenful-queue?err=' + encodeURIComponent('CSRF token expired. Try again.'))
    return
  }
  const user = req.godAdmin!.user
  const gboxOrderId = String(req.params.orderId ?? '')
  try {
    const row = await db
      .selectFrom('lenful_orders')
      .select(['id'])
      .where('gbox_order_id', '=', gboxOrderId)
      .executeTakeFirst()
    if (!row) {
      res.redirect(
        '/god-admin/fulfillments/lenful-queue?err=' + encodeURIComponent('Row not found.'),
      )
      return
    }
    const result = await syncTrackingForRow(db, row.id, {
      triggeredBy: 'god-admin-sync-row',
      userId: user.id,
      maxPages: 2,
    })
    const summary = `Sync row: fetched ${result.fetched}, updated ${result.updated}.`
    if (!result.ok) {
      res.redirect(
        '/god-admin/fulfillments/lenful-queue?err=' +
          encodeURIComponent(summary + '\n' + result.errors.join('\n')),
      )
    } else {
      res.redirect('/god-admin/fulfillments/lenful-queue?msg=' + encodeURIComponent(summary))
    }
  } catch (e: any) {
    console.error('[god-admin] sync row error:', e)
    res.redirect(
      '/god-admin/fulfillments/lenful-queue?err=' +
        encodeURIComponent('Sync row failed: ' + (e?.message || String(e))),
    )
  }
}
