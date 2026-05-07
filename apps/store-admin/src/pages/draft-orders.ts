/**
 * Store Admin — Draft Orders
 *
 * Lists and manages draft orders (orders created by merchant on behalf of customer).
 * Uses orders table with financial_status='pending' and tag 'draft' as proxy,
 * since no dedicated draft_orders table exists yet.
 *
 * When a dedicated draft_orders migration is added, this page will be updated
 * to use the proper table.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db'
import { getSessionTokenFromCookies } from '@gbox/core/modules/auth/session.js'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'
import { createOrder } from '@gbox/core/modules/orders/service.js'
import { fireAutomationTrigger } from '@gbox/core/modules/automations/engine.js'
import { sendInvoice } from '@gbox/core/modules/email/service.js'

// ---------------------------------------------------------------------------
// Gbox Order Service — REST client (server-side fetch)
// Backend: D:\Gbox\Gbox-Order-Service · OrderController.List (POST)
// Endpoint: POST /api/{shop_id}/list?page=&limit=&fields=&sort_by=
// Body: OrderFilter JSON. Trường lọc trạng thái: `status: List<string>`.
// Auth: Bearer JWT (Policy=App, Roles="owners,read_orders").
// Response: { pagination: { page, limit, count }, data: [Order] }
// ---------------------------------------------------------------------------

const API_ORDER_BASE = (
  process.env.API_ORDER_BASE_URL || 'https://api-order.gbox.co'
).replace(/\/+$/, '')

interface ApiOrder {
  id: string
  order_number?: number | null
  email?: string | null
  customer?: { id?: string; name?: string; email?: string } | null
  tags?: string[] | null
  created_at?: string | null
  updated_at?: string | null
  total_price?: number | string | null
  currency?: string | null
  status?: string | null
  payment_status?: string | boolean | null
  financial_status?: string | null
  fulfillment_status?: string | null
  line_items?: Array<{ name?: string; quantity?: number }> | null
  shop_id?: string | null
}

interface ApiOrderListResponse {
  pagination?: { page: number; limit: number; count: number }
  data?: ApiOrder[]
}

interface FetchDraftOpts {
  page: number
  limit: number
  /** OrderFilter.status — mảng trạng thái cần lọc (mặc định ['draft']). */
  status?: string[]
  /** OrderFilter.keyword (free text). */
  keyword?: string
  /** OrderFilter.from_date / to_date — ISO 8601. */
  from_date?: string
  to_date?: string
  /** OrderFilter.customer_email. */
  customer_email?: string
  /** Query string sort_by. */
  sort_by?: string
}

async function fetchDraftOrdersFromApi(
  token: string,
  shopId: string,
  opts: FetchDraftOpts,
): Promise<{ orders: ApiOrder[]; total: number }> {
  const qs = new URLSearchParams({
    page: String(opts.page),
    limit: String(opts.limit),
    sort_by: opts.sort_by ?? 'price_desc',
  })
  const url = `${API_ORDER_BASE}/api/${encodeURIComponent(shopId)}/list?${qs}`

  // OrderFilter body — chỉ gửi field có giá trị.
  const filter: Record<string, unknown> = {
    status: opts.status && opts.status.length > 0 ? opts.status : ['draft'],
  }
  if (opts.keyword) filter.keyword = opts.keyword
  if (opts.from_date) filter.from_date = opts.from_date
  if (opts.to_date) filter.to_date = opts.to_date
  if (opts.customer_email) filter.customer_email = opts.customer_email

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(filter),
    })
  } catch (err) {
    console.error('[draft-orders] Order API network error:', err)
    return { orders: [], total: 0 }
  }
  if (!resp.ok) {
    console.error(
      `[draft-orders] Order API ${resp.status} ${resp.statusText} — empty list`,
    )
    return { orders: [], total: 0 }
  }
  const json = (await resp.json().catch(() => ({}))) as ApiOrderListResponse
  return {
    orders: Array.isArray(json.data) ? json.data : [],
    total: json.pagination?.count ?? 0,
  }
}

/** Adapt API Order → row shape that the existing render expects. */
function adaptOrderToRow(o: ApiOrder): Record<string, unknown> {
  // Backend `status` là string đơn (vd "draft" / "open" / "completed-draft").
  // Render hiện tại classify qua `tags` → tổng hợp 1 mảng tags-equivalent
  // từ `status` để render code không phải đổi cấu trúc.
  const synthTags: string[] = []
  const st = (o.status ?? '').toString().toLowerCase()
  if (st === 'draft') synthTags.push('draft')
  if (st === 'invoice_sent' || st === 'invoice-sent') synthTags.push('draft', 'invoice-sent')
  if (st === 'completed-draft' || st === 'completed_draft' || st === 'complete') {
    synthTags.push('completed-draft')
  }
  // Merge với tags backend trả (nếu có).
  if (Array.isArray(o.tags)) for (const t of o.tags) if (!synthTags.includes(t)) synthTags.push(t)

  return {
    id: o.id,
    order_number: o.order_number ?? null,
    email: o.email ?? o.customer?.email ?? null,
    name: o.customer?.name ?? null,
    status: o.status ?? null,
    tags: synthTags,
    created_at: o.created_at ?? null,
    total_price:
      typeof o.total_price === 'string' || typeof o.total_price === 'number'
        ? o.total_price
        : null,
    currency: o.currency ?? 'USD',
    financial_status: o.financial_status ?? (typeof o.payment_status === 'string' ? o.payment_status : null),
    fulfillment_status: o.fulfillment_status ?? null,
  }
}

// ---------------------------------------------------------------------------
// Shared CSS for the product-picker / line-item UI.
//
// Used by BOTH the Create Draft Order form (getDraftOrderNew) and the
// Edit Draft Order detail form (getDraftOrderDetail) so the two screens
// are visually identical. Keep this as the single source of truth —
// don't duplicate the rules inline on either page.
// ---------------------------------------------------------------------------
const LINE_ITEM_STYLES = `
  <style>
    /* ── Line Item Card ── */
    .li-row {
      background: var(--s-bg);
      border: 1px solid var(--s-border);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 14px;
      transition: border-color .2s, box-shadow .2s;
    }
    .li-row:hover {
      border-color: rgba(99,102,241,.3);
      box-shadow: 0 2px 12px rgba(99,102,241,.06);
    }

    /* Header: "Item N" + × delete */
    .li-label {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 16px; padding-bottom: 12px;
      border-bottom: 1px solid var(--s-border);
    }
    .li-label span {
      font-weight: 700; font-size: 13px; color: var(--s-text);
    }
    .li-remove {
      width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
      background: none; border: 1px solid transparent; border-radius: 6px;
      color: var(--s-text-dim); cursor: pointer; font-size: 18px; line-height: 1;
      transition: all .15s;
    }
    .li-remove:hover {
      color: var(--s-danger); border-color: var(--s-danger);
      background: rgba(239,68,68,.06);
    }

    /* 2-row layout */
    .li-grid { display: flex; flex-direction: column; gap: 16px; }
    .li-row-bottom {
      display: grid; grid-template-columns: 1fr 100px 120px; gap: 16px; align-items: end;
    }

    /* Labels */
    .li-field > label {
      display: block; font-size: 12px; font-weight: 600; margin-bottom: 8px;
      color: var(--s-text-muted); text-transform: uppercase; letter-spacing: .5px;
    }

    /* Inputs */
    .li-input {
      width: 100%; padding: 10px 14px;
      border: 1px solid var(--s-border); border-radius: 8px;
      background: var(--s-card); color: var(--s-text);
      font-size: 14px; box-sizing: border-box;
      transition: border-color .15s, box-shadow .15s;
    }
    .li-input:focus {
      border-color: var(--s-accent); outline: none;
      box-shadow: 0 0 0 3px rgba(99,102,241,.12);
    }
    .li-input::placeholder { color: var(--s-text-dim); }
    .li-input:disabled {
      background: var(--s-bg); color: var(--s-text-muted);
      cursor: not-allowed; opacity: .8;
    }

    /* Line total (read-only) */
    .li-line-total {
      padding: 10px 14px; font-size: 14px; font-weight: 700;
      color: var(--s-accent); text-align: right;
      background: rgba(99,102,241,.04); border: 1px solid var(--s-border);
      border-radius: 8px; white-space: nowrap;
    }

    /* ── Search input wrapper ──
       Only wraps <input> + icon + dropdown.
       Label and chip sit OUTSIDE this wrapper. */
    .li-search-wrap {
      position: relative;
    }
    .li-search-wrap .li-input {
      padding-right: 40px; /* room for icon */
    }
    .li-search-icon {
      position: absolute; top: 50%; right: 12px;
      transform: translateY(-50%);
      color: var(--s-text-dim); pointer-events: none;
      opacity: .45; transition: opacity .15s;
    }

    /* Dropdown — attached below the input wrapper */
    .li-dropdown {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0;
      background: var(--s-card);
      border: 1px solid var(--s-accent);
      border-radius: 10px;
      max-height: 260px; overflow-y: auto;
      z-index: 50; display: none;
      box-shadow: 0 12px 36px rgba(0,0,0,.2);
    }
    .li-dropdown.open { display: block; animation: liSlideDown .15s ease; }
    @keyframes liSlideDown {
      from { opacity:0; transform:translateY(-6px); }
      to   { opacity:1; transform:translateY(0); }
    }
    .li-dropdown::-webkit-scrollbar { width: 6px; }
    .li-dropdown::-webkit-scrollbar-thumb { background: var(--s-border); border-radius: 3px; }

    .li-opt {
      padding: 10px 16px; cursor: pointer; font-size: 14px;
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid var(--s-border); transition: background .1s;
    }
    .li-opt:last-child { border-bottom: none; }
    .li-opt:hover, .li-opt.active { background: rgba(99,102,241,.06); }
    .li-opt-title { font-weight: 500; color: var(--s-text); }
    .li-opt-price {
      font-size: 12px; color: var(--s-accent); font-weight: 700;
      background: rgba(99,102,241,.08); padding: 3px 10px; border-radius: 6px;
      white-space: nowrap;
    }
    .li-opt-empty {
      color: var(--s-text-dim); font-style: italic; font-size: 13px;
      justify-content: center; padding: 20px 16px;
    }
    .li-opt-add {
      color: var(--s-accent); font-weight: 600; font-size: 13px;
      text-decoration: none; border-top: 1px solid var(--s-border);
      background: rgba(99,102,241,.03); border-radius: 0 0 10px 10px;
      padding: 12px 16px;
    }
    .li-opt-add:hover { background: rgba(99,102,241,.08); }
    .li-opt-add svg { vertical-align: -2px; margin-right: 6px; }

    /* Selected product chip — sits below the search wrapper */
    .li-chip-area { min-height: 0; }
    .li-selected {
      display: inline-flex; align-items: center; gap: 8px;
      background: rgba(99,102,241,.08); color: var(--s-accent);
      padding: 5px 12px; border-radius: 6px; font-size: 12px;
      font-weight: 600; margin-top: 8px;
    }
    .li-selected-clear {
      background: none; border: none; color: var(--s-text-dim);
      cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1;
    }
    .li-selected-clear:hover { color: var(--s-danger); }

    /* Add button */
    #addLineItemBtn:hover, #editAddLineItemBtn:hover { background: rgba(99,102,241,.06); }
  </style>
`

// ---------------------------------------------------------------------------
// GET /orders/drafts — Draft orders list (ShopBase parity)
//
// Tab classification via tags array on orders row:
//   - Open          = tags @> ['draft']         AND NOT tags @> ['invoice-sent']
//   - Invoice sent  = tags @> ['draft']         AND     tags @> ['invoice-sent']
//   - Complete      = tags @> ['completed-draft']
//   - All           = any of the above
//
// "Complete" is tracked via a sticky 'completed-draft' tag written by
// postConvertDraft so converted drafts stay visible in the Complete tab
// even after they become normal paid orders.
// ---------------------------------------------------------------------------

export async function getDraftOrders(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // API mode fallback when no local DB — list via BE Order-Service.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    const { renderDraftsListApi } = await import('./drafts-list-api.js')
    return renderDraftsListApi(req, res)
  }

  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`

  // Small helper: Express can give us a string OR an array (when the same
  // input name appears twice in a form). Always collapse to first string.
  const firstStr = (v: unknown): string =>
    Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : '') : (typeof v === 'string' ? v : '')

  const tab = firstStr(req.query.tab) || 'all'
  const search = firstStr(req.query.q).trim()
  const searchFieldRaw = firstStr(req.query.field) || 'order_name'
  const searchField = (searchFieldRaw === 'customer_email' ? 'customer_email' : 'order_name') as
    | 'order_name'
    | 'customer_email'
  const dateFrom = firstStr(req.query.date_from)
  const dateTo = firstStr(req.query.date_to)

  // Status is MULTI-SELECT (checkboxes). Parse into a validated string[].
  const rawStatus = req.query.status
  const statusList: string[] = (
    Array.isArray(rawStatus)
      ? rawStatus.map((v) => (typeof v === 'string' ? v : ''))
      : typeof rawStatus === 'string' && rawStatus
        ? [rawStatus]
        : []
  ).filter((s): s is 'open' | 'invoice_sent' | 'complete' =>
    s === 'open' || s === 'invoice_sent' || s === 'complete',
  )

  const perPage = Math.max(10, Math.min(200, parseInt(firstStr(req.query.per) || '50', 10)))
  const page = Math.max(1, parseInt(firstStr(req.query.page) || '1', 10))
  const offset = (page - 1) * perPage

  // Base scope — orders that are or were drafts.
  // Typed as SqlBool<boolean> so Kysely accepts it in `.where(...)`.
  const draftScope = sql<boolean>`(
    COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[]
    OR COALESCE(tags, ARRAY[]::text[]) @> ARRAY['completed-draft']::text[]
  )`

  const applyTabFilter = (q: any): any => {
    if (tab === 'open') {
      return q
        .where(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[]`)
        .where(sql`NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['invoice-sent']::text[])`)
    }
    if (tab === 'invoice_sent') {
      return q
        .where(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[]`)
        .where(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['invoice-sent']::text[]`)
    }
    if (tab === 'complete') {
      return q.where(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['completed-draft']::text[]`)
    }
    return q // 'all'
  }

  const applySearch = (q: any): any => {
    if (!search) return q
    if (searchField === 'customer_email') {
      return q.where('email', 'ilike', `%${search}%`)
    }
    // order_name: strip '#' / non-digit chars and match order_number.
    const n = parseInt(search.replace(/[^0-9]/g, ''), 10)
    if (!isNaN(n)) return q.where('order_number', '=', n)
    // Free-form text with no digits: fall back to no results (returns same q
    // but with an always-false predicate so search feels honest).
    return q.where(sql<boolean>`FALSE`)
  }

  const applyDateFilter = (q: any): any => {
    if (dateFrom) q = q.where('created_at', '>=', dateFrom)
    if (dateTo) {
      // inclusive end-of-day
      const endDate = new Date(dateTo + 'T23:59:59.999Z').toISOString()
      q = q.where('created_at', '<=', endDate)
    }
    return q
  }

  // Multi-status: OR together each checked status.
  const applyStatusFilter = (q: any): any => {
    if (statusList.length === 0) return q
    const preds: any[] = []
    if (statusList.includes('open')) {
      preds.push(sql`(
        COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[]
        AND NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['invoice-sent']::text[])
      )`)
    }
    if (statusList.includes('invoice_sent')) {
      preds.push(sql`(
        COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[]
        AND COALESCE(tags, ARRAY[]::text[]) @> ARRAY['invoice-sent']::text[]
      )`)
    }
    if (statusList.includes('complete')) {
      preds.push(sql`COALESCE(tags, ARRAY[]::text[]) @> ARRAY['completed-draft']::text[]`)
    }
    if (preds.length === 0) return q
    return q.where(sql<boolean>`(${sql.join(preds, sql` OR `)})`)
  }

  // ─── Fetch draft orders qua Gbox Order Service ────────────────────
  // Replace local Kysely query bằng call REST API. Backend filter theo
  // shop_id + tags=draft,completed-draft. Tab filter (open/invoice_sent/
  // complete) áp client-side trên data đã fetch để vẫn giữ UX cũ.
  // Search / date filter chưa wire vào API call — sẽ áp client-side
  // (acceptable vì draft volume thấp, limit 200).

  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')

  let drafts: any[] = []
  let totalFiltered = 0
  let allCount = 0
  let openCount = 0
  let invoiceSentCount = 0
  let completeCount = 0

  if (token && store.id) {
    // Map UI tab → backend `status` list. UI có 4 tab; backend dùng status
    // string đơn nên ta map sang giá trị tương ứng.
    let statusForApi: string[]
    if (tab === 'open') statusForApi = ['draft']
    else if (tab === 'invoice_sent') statusForApi = ['invoice-sent']
    else if (tab === 'complete') statusForApi = ['completed-draft']
    else if (statusList.length > 0) {
      // Checkbox multi-status. Map sang backend equivalents.
      statusForApi = []
      if (statusList.includes('open')) statusForApi.push('draft')
      if (statusList.includes('invoice_sent')) statusForApi.push('invoice-sent')
      if (statusList.includes('complete')) statusForApi.push('completed-draft')
    } else {
      // 'all' tab — gồm tất cả 3 trạng thái draft variants.
      statusForApi = ['draft', 'invoice-sent', 'completed-draft']
    }

    const { orders, total } = await fetchDraftOrdersFromApi(token, store.id, {
      page,
      limit: perPage,
      status: statusForApi,
      keyword: search && searchField === 'order_name' ? search : undefined,
      customer_email: search && searchField === 'customer_email' ? search : undefined,
      from_date: dateFrom || undefined,
      to_date: dateTo ? `${dateTo}T23:59:59.999Z` : undefined,
      sort_by: 'price_desc',
    })

    drafts = orders.map(adaptOrderToRow) as any[]
    totalFiltered = total

    // Tab counts: backend chỉ trả count cho query hiện tại. Để có 4
    // counter (all/open/invoice_sent/complete) chính xác cần 4 request
    // song song. Tránh waterfall — fire concurrent với HEAD-style (limit=1).
    const countOnly = async (statuses: string[]): Promise<number> => {
      const r = await fetchDraftOrdersFromApi(token, store.id, {
        page: 1,
        limit: 1,
        status: statuses,
        sort_by: 'price_desc',
      })
      return r.total
    }
    const [cAll, cOpen, cInv, cComp] = await Promise.all([
      countOnly(['draft', 'invoice-sent', 'completed-draft']),
      countOnly(['draft']),
      countOnly(['invoice-sent']),
      countOnly(['completed-draft']),
    ]).catch(() => [totalFiltered, 0, 0, 0])
    allCount = cAll
    openCount = cOpen
    invoiceSentCount = cInv
    completeCount = cComp
  }

  const totalPages = Math.ceil(totalFiltered / perPage) || 1
  const fromIdx = totalFiltered === 0 ? 0 : offset + 1
  const toIdx = Math.min(offset + perPage, totalFiltered)

  // URL builder — preserves current filters. `status` is an array (multi-
  // select); pass `status: null` to clear, `status: ['open','complete']` to set.
  type UrlVal = string | number | string[] | undefined | null
  const buildUrl = (overrides: Record<string, UrlVal>) => {
    const params = new URLSearchParams()
    const merged: Record<string, UrlVal> = {
      tab: tab !== 'all' ? tab : undefined,
      q: search || undefined,
      field: searchField !== 'order_name' ? searchField : undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      status: statusList.length > 0 ? statusList : undefined,
      per: perPage !== 50 ? perPage : undefined,
      page: page !== 1 ? page : undefined,
      ...overrides,
    }
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined || v === null || v === '') continue
      if (Array.isArray(v)) {
        for (const vv of v) if (vv) params.append(k, String(vv))
      } else {
        params.set(k, String(v))
      }
    }
    const qs = params.toString()
    return `${base}/orders/drafts${qs ? '?' + qs : ''}`
  }

  const tabLink = (id: string, label: string, count: number) => {
    const isActive = tab === id
    const href = buildUrl({ tab: id === 'all' ? undefined : id, page: undefined })
    return `<a href="${esc(href)}" class="tab${isActive ? ' active' : ''}">${esc(label)} <span class="tab-count">(${count})</span></a>`
  }

  const pageLink = (p: number, label: string, disabled: boolean) => {
    if (disabled) return `<span class="dr-pg-btn" style="opacity:0.35;pointer-events:none">${label}</span>`
    return `<a href="${esc(buildUrl({ page: p }))}" class="dr-pg-btn">${label}</a>`
  }

  // Exactly TWO search-field options (ShopBase parity).
  const searchFieldLabels: Record<'order_name' | 'customer_email', string> = {
    order_name: 'Order name',
    customer_email: 'Customer email',
  }

  // Status label + badge color for each draft row
  const rowStatus = (d: any): { label: string; cls: string } => {
    const tags: string[] = Array.isArray(d.tags) ? d.tags : []
    if (tags.includes('completed-draft')) return { label: 'Complete', cls: 'badge-success' }
    if (tags.includes('invoice-sent')) return { label: 'Invoice sent', cls: 'badge-info' }
    return { label: 'Open', cls: 'badge-warning' }
  }

  const content = `
    <style>
      /* Draft-orders filter widgets — self-contained so they work without
         relying on CSS inlined by other pages (orders.ts). */

      /* Normalize every control in the filter row to the SAME height / font
         so borders and baselines line up. There is no global .input class
         rule in the layout, so button vs input inherit different browser
         default padding and drift apart visually. */
      #draftFilterForm .input,
      #draftFilterForm .dr-menu-btn,
      #draftFilterForm .btn {
        height: 36px;
        box-sizing: border-box;
        font-size: 13px;
        line-height: 20px;
        border-radius: 6px;
        border: 1px solid var(--s-border);
        background: var(--s-surface);
        color: var(--s-text);
      }
      #draftFilterForm .input { padding: 0 12px; }
      #draftFilterForm input[type="text"].input { padding: 0 12px 0 32px; }
      #draftFilterForm .dr-menu-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 0 12px; cursor: pointer;
      }
      #draftFilterForm .dr-field-btn {
        min-width: 170px; justify-content: space-between;
      }
      #draftFilterForm .dr-menu-btn:hover,
      #draftFilterForm .input:hover { border-color: var(--s-accent, #6366f1); }
      #draftFilterForm .input:focus,
      #draftFilterForm .dr-menu-btn:focus {
        outline: none; border-color: var(--s-accent, #6366f1);
        box-shadow: 0 0 0 3px rgba(99,102,241,.15);
      }

      .dr-menu-wrap { position:relative; display:inline-flex; align-items:center; }
      .dr-menu {
        display:none; position:absolute; top:calc(100% + 4px); right:0; z-index:200;
        min-width:200px; background:var(--s-card, var(--s-surface, #fff));
        border:1px solid var(--s-border); border-radius:8px; padding:6px;
        box-shadow:0 12px 28px rgba(0,0,0,.22);
      }
      .dr-menu.open { display:block; }
      .dr-item {
        display:block; padding:8px 12px; font-size:13px; color:var(--s-text);
        text-decoration:none; border-radius:6px; cursor:pointer;
      }
      .dr-item:hover { background:var(--s-hover, rgba(99,102,241,.08)); }
      .dr-item.active { background:var(--s-accent, #6366f1); color:#fff; }
      .dr-check {
        display:flex; align-items:center; gap:10px; padding:8px 10px;
        font-size:13px; color:var(--s-text); cursor:pointer; border-radius:6px;
        user-select:none;
      }
      .dr-check:hover { background:var(--s-hover, rgba(99,102,241,.08)); }
      .dr-check input[type=checkbox] { width:15px; height:15px; cursor:pointer; margin:0; }

      /* Pagination bar — Row per page LEFT, counter + arrows RIGHT */
      .dr-pg-bar {
        display:flex; align-items:center; justify-content:space-between;
        padding:14px 16px; border-top:1px solid var(--s-border); gap:12px;
      }
      .dr-pg-left, .dr-pg-right { display:flex; align-items:center; gap:8px; }
      .dr-pg-btn {
        display:inline-flex; align-items:center; justify-content:center;
        min-width:28px; height:28px; padding:0 8px; font-size:13px;
        border:1px solid var(--s-border); border-radius:6px;
        background:var(--s-surface); color:var(--s-text);
        text-decoration:none; cursor:pointer;
      }
      .dr-pg-btn:hover { background:var(--s-hover, rgba(99,102,241,.08)); border-color:var(--s-accent, #6366f1); }

      /* Bulk actions bar — visible when at least one row is checked */
      .dr-bulk-bar {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 16px; margin-top: 8px;
        background: var(--s-hover, rgba(99,102,241,.06));
        border: 1px solid var(--s-border); border-radius: 8px;
      }
      .dr-bulk-clear {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0;
        border: 1px solid var(--s-accent, #6366f1); border-radius: 6px;
        background: var(--s-card); color: var(--s-accent, #6366f1);
        cursor: pointer;
      }
      .dr-bulk-clear:hover { background: var(--s-accent, #6366f1); color: #fff; }
      .dr-bulk-count { font-size: 13px; color: var(--s-text); }
      .dr-bulk-count strong { color: var(--s-accent, #6366f1); }
    </style>

    <div class="page-header">
      <div>
        <h1 class="page-title">Draft orders ${allCount > 0 ? `<span style="color:var(--s-text-muted);font-weight:500;font-size:18px">(${allCount})</span>` : ''}</h1>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a href="${base}/orders/drafts/export" class="btn btn-outline" style="font-size:13px">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:4px"><path d="M10 3v10M6 9l4 4 4-4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
          Export order
        </a>
        <a href="${base}/orders/drafts/new" class="btn btn-primary" style="font-size:13px">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
          Create order
        </a>
      </div>
    </div>

    <!-- TABS + SEARCH -->
    <div class="card">
      <div class="card-header" style="flex-direction:column;gap:12px;align-items:stretch">
        <div class="tabs" style="border-bottom:1px solid var(--s-border);padding-bottom:0">
          ${tabLink('all', 'All', allCount)}
          ${tabLink('open', 'Open', openCount)}
          ${tabLink('invoice_sent', 'Invoice sent', invoiceSentCount)}
          ${tabLink('complete', 'Complete', completeCount)}
        </div>

        <form method="get" action="${base}/orders/drafts" id="draftFilterForm" style="display:flex;gap:8px;width:100%;flex-wrap:wrap;align-items:center">
          ${tab !== 'all' ? `<input type="hidden" name="tab" value="${esc(tab)}">` : ''}
          ${perPage !== 50 ? `<input type="hidden" name="per" value="${perPage}">` : ''}
          <input type="hidden" name="field" id="draftSearchField" value="${esc(searchField)}">

          <!-- FIELD SELECTOR: 2 options (Order name | Customer email) -->
          <div class="dr-menu-wrap">
            <button type="button" class="dr-menu-btn dr-field-btn" data-menu="draftFieldMenu">
              <span id="draftFieldLabel">${esc(searchFieldLabels[searchField])}</span>
              <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
            </button>
            <div class="dr-menu" id="draftFieldMenu" style="left:0;right:auto;min-width:180px">
              ${(['order_name', 'customer_email'] as const).map(k =>
                `<a class="dr-item${searchField === k ? ' active' : ''}" href="#" data-draft-field="${k}" data-label="${esc(searchFieldLabels[k])}">${esc(searchFieldLabels[k])}</a>`,
              ).join('')}
            </div>
          </div>

          <div style="position:relative;flex:1;min-width:240px">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--s-text-muted);pointer-events:none"><circle cx="9" cy="9" r="6"/><path d="m17 17-3.5-3.5"/></svg>
            <input type="text" name="q" value="${esc(search)}" placeholder="Search draft orders..." class="input" style="width:100%">
          </div>
          <button type="submit" class="dr-menu-btn">Search</button>
          ${search ? `<a href="${esc(buildUrl({ q: undefined, page: undefined }))}" class="dr-menu-btn" style="text-decoration:none">Clear</a>` : ''}

          <!-- ORDER DATE: From / To range picker -->
          <div class="dr-menu-wrap">
            <button type="button" class="dr-menu-btn" data-menu="draftDateMenu">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="13" rx="1"/><path d="M3 8h14M7 2v4M13 2v4"/></svg>
              <span>Order date${(dateFrom || dateTo) ? ' •' : ''}</span>
              <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
            </button>
            <div class="dr-menu" id="draftDateMenu" style="min-width:280px;padding:12px" onclick="event.stopPropagation()">
              <div style="display:flex;flex-direction:column;gap:10px">
                <label style="font-size:11px;color:var(--s-text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">From
                  <input type="date" name="date_from" value="${esc(dateFrom)}" class="input" style="display:block;width:100%;margin-top:6px;font-size:13px">
                </label>
                <label style="font-size:11px;color:var(--s-text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">To
                  <input type="date" name="date_to" value="${esc(dateTo)}" class="input" style="display:block;width:100%;margin-top:6px;font-size:13px">
                </label>
                <div style="display:flex;gap:6px;margin-top:4px">
                  <button type="submit" class="btn btn-primary btn-sm" style="flex:1">Apply</button>
                  ${(dateFrom || dateTo)
                    ? `<a href="${esc(buildUrl({ date_from: undefined, date_to: undefined, page: undefined }))}" class="btn btn-outline btn-sm" style="flex:1;text-align:center">Clear</a>`
                    : `<button type="button" class="btn btn-outline btn-sm" style="flex:1" onclick="document.querySelector('input[name=date_from]').value='';document.querySelector('input[name=date_to]').value=''">Clear</button>`
                  }
                </div>
              </div>
            </div>
          </div>

          <!-- STATUS: Multi-select checkboxes + Clear -->
          <div class="dr-menu-wrap">
            <button type="button" class="dr-menu-btn" data-menu="draftStatusMenu">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>
              <span>Status${statusList.length > 0 ? ` (${statusList.length})` : ''}</span>
              <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
            </button>
            <div class="dr-menu" id="draftStatusMenu" style="min-width:220px;padding:10px" onclick="event.stopPropagation()">
              <label class="dr-check"><input type="checkbox" name="status" value="open" ${statusList.includes('open') ? 'checked' : ''}> <span>Open</span></label>
              <label class="dr-check"><input type="checkbox" name="status" value="invoice_sent" ${statusList.includes('invoice_sent') ? 'checked' : ''}> <span>Invoice sent</span></label>
              <label class="dr-check"><input type="checkbox" name="status" value="complete" ${statusList.includes('complete') ? 'checked' : ''}> <span>Complete</span></label>
              <div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--s-border)">
                <button type="submit" class="btn btn-primary btn-sm" style="flex:1">Apply</button>
                ${statusList.length > 0
                  ? `<a href="${esc(buildUrl({ status: null, page: undefined }))}" class="btn btn-outline btn-sm" style="flex:1;text-align:center">Clear</a>`
                  : `<button type="button" class="btn btn-outline btn-sm" style="flex:1" onclick="document.querySelectorAll('#draftStatusMenu input[name=status]').forEach(function(c){c.checked=false})">Clear</button>`
                }
              </div>
            </div>
          </div>
        </form>

        <!-- BULK ACTIONS BAR — appears when any row is checked -->
        <div id="draftBulkBar" class="dr-bulk-bar" style="display:none">
          <button type="button" class="dr-bulk-clear" onclick="draftClearSelection()" title="Clear selection" aria-label="Clear selection">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 10h10"/></svg>
          </button>
          <span class="dr-bulk-count"><strong id="draftBulkCount">0</strong> item<span id="draftBulkPlural">s</span> selected</span>
          <div class="dr-menu-wrap">
            <button type="button" class="dr-menu-btn" data-menu="draftBulkMenu">
              <span>Actions</span>
              <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
            </button>
            <div class="dr-menu" id="draftBulkMenu" style="left:0;right:auto;min-width:200px">
              <a href="#" class="dr-item" data-bulk-action="convert">Convert to order</a>
              <a href="#" class="dr-item" data-bulk-action="send_invoice">Send invoice</a>
              <a href="#" class="dr-item" data-bulk-action="delete" style="color:var(--s-danger, #ef4444)">Delete</a>
            </div>
          </div>
        </div>

        <!-- Bulk POST endpoint + CSRF token exposed for the fetch() dispatcher -->
        <meta id="draftBulkMeta"
              data-endpoint="${base}/orders/drafts/bulk"
              data-csrf="${esc((req as any).csrfToken || '')}" />
      </div>

      <div class="card-body" style="padding:0">
        ${drafts.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:32px;padding-left:16px"><input type="checkbox" id="draftSelectAll" onchange="draftToggleAll(this.checked)" class="bulk-check"></th>
                  <th>Order</th>
                  <th>Date</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th style="text-align:right">Total</th>
                </tr>
              </thead>
              <tbody>
                ${drafts.map(d => {
                  const date = new Date(d.created_at as string)
                  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  const status = rowStatus(d)
                  // ShopBase-parity: every draft order is displayed with the
                  // sticky "#D<number>" prefix (e.g. #D15) so merchants can
                  // tell a draft apart from a normal paid order at a glance.
                  const orderLabel = d.order_number
                    ? `#D${d.order_number}`
                    : `#D${(d.id as string).slice(0, 8)}`
                  return `
                    <tr class="order-row" data-id="${esc(d.id)}">
                      <td style="padding-left:16px"><input type="checkbox" class="bulk-check draft-row-check" value="${esc(d.id)}"></td>
                      <td>
                        <a href="${base}/orders/drafts/${esc(d.id)}" style="color:var(--s-accent);text-decoration:none;font-weight:600">${esc(orderLabel)}</a>
                      </td>
                      <td style="color:var(--s-text-muted);font-size:13px">${dateStr}</td>
                      <td>${d.email ? esc(d.email) : '<span style="color:var(--s-text-muted)">No email</span>'}</td>
                      <td><span class="badge ${status.cls}">${esc(status.label)}</span></td>
                      <td style="text-align:right;font-weight:600">$${Number(d.total_price || 0).toFixed(2)}</td>
                    </tr>
                  `
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div style="padding:64px 24px;text-align:center">
            <div style="width:64px;height:64px;margin:0 auto 16px;border-radius:50%;background:var(--s-bg);display:flex;align-items:center;justify-content:center;color:var(--s-text-muted)">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>
            </div>
            <div style="font-weight:600;font-size:15px;color:var(--s-text);margin-bottom:6px">You have no ${tab === 'all' ? 'draft' : esc(tab.replace('_', ' '))} orders yet</div>
            <div style="font-size:13px;color:var(--s-text-muted);max-width:420px;margin:0 auto 20px">Your draft orders will be listed here. Create an order on behalf of a customer to get started.</div>
            <a href="${base}/orders/drafts/new" class="btn btn-primary btn-sm">Create order</a>
          </div>
        `}
      </div>

      <!-- PAGINATION: Row per page LEFT-BOTTOM, "N-M of total < >" RIGHT-BOTTOM -->
      <div class="dr-pg-bar">
        <div class="dr-pg-left">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--s-text-muted)">
            Row per page
            <select class="input" style="padding:4px 8px;font-size:12px;width:auto" onchange="const u=new URL(location.href);u.searchParams.set('per',this.value);u.searchParams.delete('page');location.href=u.toString()">
              <option value="25"${perPage === 25 ? ' selected' : ''}>25</option>
              <option value="50"${perPage === 50 ? ' selected' : ''}>50</option>
              <option value="100"${perPage === 100 ? ' selected' : ''}>100</option>
              <option value="150"${perPage === 150 ? ' selected' : ''}>150</option>
            </select>
          </label>
        </div>
        <div class="dr-pg-right">
          <span style="font-size:12px;color:var(--s-text-muted);margin-right:8px">
            ${fromIdx}-${toIdx} of ${totalFiltered}
          </span>
          ${pageLink(page - 1, '&lt;', page === 1)}
          ${pageLink(page + 1, '&gt;', page >= totalPages)}
        </div>
      </div>
    </div>

    <script>
      (function(){
        // ── Bulk selection state ──
        var bulkBar = document.getElementById('draftBulkBar')
        var bulkCount = document.getElementById('draftBulkCount')
        var bulkPlural = document.getElementById('draftBulkPlural')
        var selectAllBox = document.getElementById('draftSelectAll')

        function getCheckedIds() {
          var checks = document.querySelectorAll('.draft-row-check:checked')
          var ids = []
          for (var i = 0; i < checks.length; i++) ids.push(checks[i].value)
          return ids
        }
        function refreshBulkBar() {
          var ids = getCheckedIds()
          if (ids.length > 0) {
            bulkBar.style.display = 'flex'
            bulkCount.textContent = String(ids.length)
            bulkPlural.style.display = ids.length === 1 ? 'none' : 'inline'
          } else {
            bulkBar.style.display = 'none'
          }
          // Sync header checkbox indeterminate/checked state
          var all = document.querySelectorAll('.draft-row-check')
          if (selectAllBox) {
            if (ids.length === 0) {
              selectAllBox.checked = false
              selectAllBox.indeterminate = false
            } else if (ids.length === all.length) {
              selectAllBox.checked = true
              selectAllBox.indeterminate = false
            } else {
              selectAllBox.checked = false
              selectAllBox.indeterminate = true
            }
          }
        }

        window.draftToggleAll = function(checked) {
          document.querySelectorAll('.draft-row-check').forEach(function(cb){ cb.checked = checked })
          refreshBulkBar()
        }
        window.draftClearSelection = function() {
          document.querySelectorAll('.draft-row-check').forEach(function(cb){ cb.checked = false })
          refreshBulkBar()
        }
        document.querySelectorAll('.draft-row-check').forEach(function(cb){
          cb.addEventListener('change', refreshBulkBar)
        })
        refreshBulkBar()

        // ── Bulk action dispatch (fetch-based, no hidden form) ──
        // IMPORTANT: we serialise the body as application/x-www-form-urlencoded
        // (URLSearchParams), NOT multipart/form-data (FormData). The global
        // CSRF middleware in server.ts reads req.body._csrf, which Express's
        // urlencoded parser populates — the multipart parser only runs on
        // explicit upload routes (see server.ts ~308-316). If we sent
        // multipart here, req.body would be {} and every bulk action would
        // return 403 "Invalid or expired form submission".
        var bulkMeta = document.getElementById('draftBulkMeta')
        var bulkEndpoint = bulkMeta && bulkMeta.getAttribute('data-endpoint') || ''
        var bulkCsrf = bulkMeta && bulkMeta.getAttribute('data-csrf') || ''

        document.querySelectorAll('[data-bulk-action]').forEach(function(a){
          a.addEventListener('click', function(e){
            e.preventDefault()
            var action = a.getAttribute('data-bulk-action')
            var ids = getCheckedIds()
            if (!ids.length) return
            var label = action === 'convert' ? 'convert' : action === 'send_invoice' ? 'send invoices for' : 'permanently delete'
            var noun = ids.length === 1 ? 'draft order' : ids.length + ' draft orders'
            if (!confirm('Are you sure you want to ' + label + ' ' + noun + '?')) return

            var body = new URLSearchParams()
            body.append('_csrf', bulkCsrf)
            body.append('action', action)
            for (var i = 0; i < ids.length; i++) body.append('ids', ids[i])

            // Disable the clicked item so double-clicks don't fire twice.
            a.style.pointerEvents = 'none'
            a.style.opacity = '0.6'
            closeAllMenus()

            fetch(bulkEndpoint, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
              redirect: 'follow',
            })
              .then(function(res){
                // Server redirects to /orders/drafts?success=... on success.
                // fetch() with redirect:'follow' gives us the FINAL URL in res.url.
                if (res.redirected || res.ok) {
                  window.location.href = res.url
                  return
                }
                return res.text().then(function(txt){
                  alert('Bulk action failed (HTTP ' + res.status + '). Please reload the page and try again.')
                  console.error('[bulk] failed:', res.status, txt.slice(0, 300))
                  a.style.pointerEvents = ''
                  a.style.opacity = ''
                })
              })
              .catch(function(err){
                alert('Network error: ' + (err && err.message || err))
                console.error('[bulk] network error:', err)
                a.style.pointerEvents = ''
                a.style.opacity = ''
              })
          })
        })

        // Local dropdown toggler — does not rely on a global defined elsewhere.
        function closeAllMenus() {
          document.querySelectorAll('.dr-menu').forEach(function(m){ m.classList.remove('open') })
        }
        function openMenu(id) {
          var menu = document.getElementById(id)
          if (!menu) return
          var wasOpen = menu.classList.contains('open')
          closeAllMenus()
          if (!wasOpen) menu.classList.add('open')
        }

        // Wire all [data-menu="..."] buttons → open the matching panel
        document.querySelectorAll('.dr-menu-btn').forEach(function(btn){
          btn.addEventListener('click', function(e){
            e.preventDefault()
            e.stopPropagation()
            openMenu(btn.getAttribute('data-menu'))
          })
        })

        // Click outside any .dr-menu-wrap → close
        document.addEventListener('click', function(e){
          if (!e.target.closest('.dr-menu-wrap')) closeAllMenus()
        })
        // ESC → close
        document.addEventListener('keydown', function(e){
          if (e.key === 'Escape') closeAllMenus()
        })

        // Field selector: set hidden field + update label + submit.
        document.querySelectorAll('[data-draft-field]').forEach(function(a){
          a.addEventListener('click', function(e){
            e.preventDefault()
            var f = a.getAttribute('data-draft-field')
            var hidden = document.getElementById('draftSearchField')
            if (hidden) hidden.value = f
            var lbl = document.getElementById('draftFieldLabel')
            if (lbl) lbl.textContent = a.getAttribute('data-label') || a.textContent
            closeAllMenus()
            var form = document.getElementById('draftFilterForm')
            if (form) form.submit()
          })
        })
      })()
    </script>
  `

  res.send(
    sellerLayout({
      title: 'Draft orders',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'orders',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// GET /orders/drafts/new — Create draft order form
// ---------------------------------------------------------------------------

export async function getDraftOrderNew(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  // API mode fallback for local dev / no DB. Renders Shopify-style draft form.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    const { renderDraftOrderNewApi } = await import('./draft-order-new-api.js')
    return renderDraftOrderNewApi(req, res)
  }

  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const error = req.query.error as string || ''

  // Load products WITH default variant price for the product picker
  let products: Array<{ id: string; title: string; price: string }> = []
  try {
    products = await db
      .selectFrom('products')
      .innerJoin('product_variants', 'product_variants.product_id', 'products.id')
      .select(['products.id', 'products.title', 'product_variants.price'])
      .where('products.shop_id', '=', store.id)
      .where('products.status', '=', 'active')
      .orderBy('products.title', 'asc')
      .limit(200)
      .execute()
    // Deduplicate — keep first variant (lowest position) per product
    const seen = new Set<string>()
    products = products.filter(p => {
      if (seen.has(p.id)) return false
      seen.add(p.id)
      return true
    })
  } catch { /* graceful */ }

  // Load customers for the customer picker
  let customers: any[] = []
  try {
    customers = await db
      .selectFrom('customers')
      .select(['id', 'first_name', 'last_name', 'email'])
      .where('shop_id', '=', store.id)
      .orderBy('first_name', 'asc')
      .limit(100)
      .execute()
  } catch { /* graceful */ }

  // Load default/latest address for each of those customers so we can
  // auto-fill the Shipping Address card when the merchant picks an
  // existing customer from the dropdown. Merchants can still edit the
  // fields afterwards — this is just a smart default (ShopBase parity).
  let customerAddressRows: any[] = []
  try {
    if (customers.length > 0) {
      customerAddressRows = await db
        .selectFrom('customer_addresses')
        .innerJoin('customers', 'customers.id', 'customer_addresses.customer_id')
        .select([
          'customer_addresses.customer_id',
          'customer_addresses.address1',
          'customer_addresses.address2',
          'customer_addresses.city',
          'customer_addresses.province',
          'customer_addresses.country',
          'customer_addresses.zip',
          'customer_addresses.phone',
          'customer_addresses.is_default',
          'customer_addresses.created_at',
        ])
        .where('customers.shop_id', '=', store.id)
        .orderBy('customer_addresses.is_default', 'desc')
        .orderBy('customer_addresses.created_at', 'desc')
        .execute()
    }
  } catch { /* graceful */ }

  // Build customer email + address maps for JS auto-fill.
  // For the address map we keep only the FIRST row per customer_id
  // (the query orders default first, then newest), so the merchant
  // sees the best-guess shipping address.
  const customerEmailMap: Record<string, string> = {}
  const customerAddressMap: Record<string, {
    address1: string
    city: string
    province: string
    zip: string
    country: string
    phone: string
  }> = {}
  for (const row of customerAddressRows) {
    const cid = row.customer_id as string
    if (customerAddressMap[cid]) continue
    customerAddressMap[cid] = {
      address1: (row.address1 as string) || '',
      city: (row.city as string) || '',
      province: (row.province as string) || '',
      zip: (row.zip as string) || '',
      country: (row.country as string) || '',
      phone: (row.phone as string) || '',
    }
  }

  const customerOptions = customers.map(c => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown'
    if (c.email) customerEmailMap[c.id] = c.email
    return `<option value="${esc(c.id)}">${esc(name)} (${esc(c.email || 'no email')})</option>`
  }).join('')

  const content = `
    <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
      <a href="/admin/store/${esc(store.slug)}/orders/drafts" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px">&larr; Draft Orders</a>
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Create Draft Order</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Create an order on behalf of a customer</p>
      </div>
    </div>

    ${error ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#b91c1c;font-size:13px">${esc(decodeURIComponent(error))}</div>` : ''}

    <form method="POST" action="/admin/store/${esc(store.slug)}/orders/drafts" style="max-width:800px">
      <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />

      <!-- Customer -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px">
          <h2 style="margin:0;font-size:17px;font-weight:700">Customer</h2>
          <button type="button" id="qcOpenBtn" style="padding:6px 12px;font-size:12.5px;font-weight:500;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-accent);cursor:pointer;display:inline-flex;align-items:center;gap:4px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Create customer
          </button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Select existing customer</label>
            <select name="customer_id" id="draftCustomerSelect" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px">
              <option value="">-- No customer (guest order) --</option>
              ${customerOptions}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Or enter email</label>
            <input type="email" name="email" id="draftEmailInput" placeholder="customer@example.com" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
        </div>
      </div>

      <!-- Quick-create customer modal -->
      <dialog id="qcModal" style="border:1px solid var(--s-border);border-radius:12px;padding:0;background:var(--s-card,#fff);color:var(--s-text);max-width:480px;width:92vw">
        <form method="dialog" id="qcForm" style="padding:22px 24px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <h3 style="margin:0;font-size:17px;font-weight:700">Create customer</h3>
            <button type="button" id="qcCloseBtn" aria-label="Close" style="border:0;background:transparent;color:var(--s-text-muted);font-size:22px;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px">×</button>
          </div>
          <div id="qcError" style="display:none;padding:8px 12px;background:rgba(239,68,68,.12);color:#dc2626;border-radius:6px;font-size:12.5px;margin-bottom:12px"></div>
          <label style="display:block;margin-bottom:12px">
            <span style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:var(--s-text-muted)">Email *</span>
            <input id="qcEmail" type="email" required maxlength="120" placeholder="customer@example.com"
              style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:7px;background:var(--s-bg);color:var(--s-text);font-size:14px;box-sizing:border-box" />
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
            <label>
              <span style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:var(--s-text-muted)">First name</span>
              <input id="qcFirstName" type="text" maxlength="80" placeholder="John"
                style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:7px;background:var(--s-bg);color:var(--s-text);font-size:14px;box-sizing:border-box" />
            </label>
            <label>
              <span style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:var(--s-text-muted)">Last name</span>
              <input id="qcLastName" type="text" maxlength="80" placeholder="Doe"
                style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:7px;background:var(--s-bg);color:var(--s-text);font-size:14px;box-sizing:border-box" />
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 100px;gap:10px;margin-bottom:18px">
            <label>
              <span style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:var(--s-text-muted)">Phone</span>
              <input id="qcPhone" type="text" maxlength="32" placeholder="+1 555-1234"
                style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:7px;background:var(--s-bg);color:var(--s-text);font-size:14px;box-sizing:border-box" />
            </label>
            <label>
              <span style="display:block;font-size:12px;font-weight:600;margin-bottom:5px;color:var(--s-text-muted)">Country</span>
              <input id="qcCountry" type="text" maxlength="2" placeholder="US"
                style="width:100%;padding:8px 10px;border:1px solid var(--s-border);border-radius:7px;background:var(--s-bg);color:var(--s-text);font-size:14px;box-sizing:border-box;text-transform:uppercase" />
            </label>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button type="button" id="qcCancelBtn" style="padding:8px 14px;border:1px solid var(--s-border);border-radius:7px;background:transparent;color:var(--s-text-muted);cursor:pointer;font-size:13px">Cancel</button>
            <button type="button" id="qcSubmitBtn" style="padding:8px 16px;border:0;border-radius:7px;background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff;cursor:pointer;font-size:13px;font-weight:500">Create</button>
          </div>
        </form>
      </dialog>
      <script>(function(){
        var modal = document.getElementById('qcModal');
        var openBtn = document.getElementById('qcOpenBtn');
        var closeBtn = document.getElementById('qcCloseBtn');
        var cancelBtn = document.getElementById('qcCancelBtn');
        var submitBtn = document.getElementById('qcSubmitBtn');
        var emailEl = document.getElementById('qcEmail');
        var firstEl = document.getElementById('qcFirstName');
        var lastEl = document.getElementById('qcLastName');
        var phoneEl = document.getElementById('qcPhone');
        var countryEl = document.getElementById('qcCountry');
        var errEl = document.getElementById('qcError');
        var sel = document.getElementById('draftCustomerSelect');
        var emailInput = document.getElementById('draftEmailInput');
        if (!modal || !openBtn) return;
        function showErr(msg){ errEl.style.display = 'block'; errEl.textContent = msg; }
        function clearErr(){ errEl.style.display = 'none'; errEl.textContent = ''; }
        function open(){ clearErr(); modal.showModal(); setTimeout(function(){ if(emailEl) emailEl.focus(); }, 30); }
        function close(){ modal.close(); }
        openBtn.addEventListener('click', open);
        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        submitBtn.addEventListener('click', async function(){
          clearErr();
          var payload = {
            email: (emailEl && emailEl.value || '').trim(),
            first_name: (firstEl && firstEl.value || '').trim(),
            last_name: (lastEl && lastEl.value || '').trim(),
            phone: (phoneEl && phoneEl.value || '').trim(),
            country_code: (countryEl && countryEl.value || '').trim().toUpperCase()
          };
          if (!payload.email) { showErr('Email là bắt buộc'); return; }
          if (!payload.first_name && !payload.last_name) { showErr('Cần ít nhất first hoặc last name'); return; }
          submitBtn.disabled = true; submitBtn.textContent = 'Saving…';
          try {
            var r = await fetch('${esc(`/admin/store/${store.slug}/api/customers/quick-create`)}', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify(payload)
            });
            var data = await r.json().catch(function(){ return {}; });
            if (!r.ok) { showErr(data.error || ('HTTP ' + r.status)); return; }
            // Prepend new option + select it
            if (sel && data.id) {
              var fullName = data.full_name || ((data.first_name || '') + ' ' + (data.last_name || '')).trim() || data.email;
              var opt = document.createElement('option');
              opt.value = data.id;
              opt.textContent = fullName + ' (' + data.email + ')';
              opt.selected = true;
              sel.insertBefore(opt, sel.children[1] || null);
              sel.value = data.id;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (emailInput && data.email) emailInput.value = data.email;
            close();
          } catch (err) {
            showErr((err && err.message) || 'Network error');
          } finally {
            submitBtn.disabled = false; submitBtn.textContent = 'Create';
          }
        });
        // ESC inside dialog đã được handled bởi <dialog>
      })();</script>

      <!-- Customer email map for auto-fill -->
      <script id="customerEmailMap" type="application/json">${JSON.stringify(customerEmailMap)}</script>
      <!-- Customer default/latest address map for auto-fill (ShopBase parity) -->
      <script id="customerAddressMap" type="application/json">${JSON.stringify(customerAddressMap)}</script>

      <!-- Line Items -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 16px;font-size:17px;font-weight:700">Line Items</h2>
        <p style="margin:0 0 12px;color:var(--s-text-secondary);font-size:13px">Search products or type a custom item name. Price auto-fills when selecting a product.</p>

        <div id="draftLineItems">
          <!-- Item rows will be rendered by JS -->
        </div>

        <button type="button" id="addLineItemBtn" style="margin-top:12px;padding:8px 16px;border:1px dashed var(--s-border);border-radius:8px;background:none;color:var(--s-accent);cursor:pointer;font-size:13px;font-weight:600;width:100%;transition:background .15s">
          + Add another item
        </button>
      </div>

      <!-- Product catalog (hidden JSON for JS picker) -->
      <script id="productCatalog" type="application/json">${JSON.stringify(products.map(p => ({ id: p.id, title: p.title, price: p.price })))}</script>

      <!-- Shipping Address -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px">
          <h2 style="margin:0;font-size:17px;font-weight:700">Shipping Address</h2>
          <span id="shipAutoFilledBadge" style="display:none;font-size:12px;color:var(--s-accent, #6366f1);background:rgba(99,102,241,.08);padding:4px 10px;border-radius:6px;font-weight:600">
            Auto-filled from customer — edit if needed
          </span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div style="grid-column:span 2">
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Address</label>
            <input type="text" id="shipAddress1" name="shipping_address1" placeholder="123 Main St" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">City</label>
            <input type="text" id="shipCity" name="shipping_city" placeholder="New York" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">State</label>
            <input type="text" id="shipProvince" name="shipping_province" placeholder="NY" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">ZIP</label>
            <input type="text" id="shipZip" name="shipping_zip" placeholder="10001" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Country</label>
            <input type="text" id="shipCountry" name="shipping_country" value="US" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          </div>
        </div>
      </div>

      <!-- Order Note -->
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
        <h2 style="margin:0 0 16px;font-size:17px;font-weight:700">Notes & Tags</h2>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Note</label>
          <textarea name="note" rows="3" placeholder="Internal note about this draft order" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px;resize:vertical"></textarea>
        </div>
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Tags</label>
          <input type="text" name="tags" value="draft" placeholder="draft, wholesale" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-bg);color:var(--s-text-primary);font-size:14px" />
          <div style="font-size:12px;color:var(--s-text-secondary);margin-top:4px">Comma-separated. "draft" tag is added automatically.</div>
        </div>
      </div>

      <div style="display:flex;gap:12px">
        <button type="submit" class="btn btn-primary" style="padding:10px 24px;font-size:14px;font-weight:600;border-radius:8px">Create Draft Order</button>
        <a href="/admin/store/${esc(store.slug)}/orders/drafts" class="btn" style="padding:10px 24px;font-size:14px;border-radius:8px;background:var(--s-bg);border:1px solid var(--s-border);color:var(--s-text-primary);text-decoration:none">Cancel</a>
      </div>
    </form>

    ${LINE_ITEM_STYLES}

    <script>
    // Auto-fill email + shipping address when selecting an existing customer.
    // Fields remain fully editable so the merchant can override before saving.
    (function() {
      var emailMap = {};
      var addrMap = {};
      try { emailMap = JSON.parse(document.getElementById('customerEmailMap').textContent || '{}'); } catch(e) {}
      try { addrMap  = JSON.parse(document.getElementById('customerAddressMap').textContent || '{}'); } catch(e) {}

      var custSelect = document.querySelector('select[name="customer_id"]');
      var emailInput = document.getElementById('draftEmailInput');
      var ship = {
        address1: document.getElementById('shipAddress1'),
        city:     document.getElementById('shipCity'),
        province: document.getElementById('shipProvince'),
        zip:      document.getElementById('shipZip'),
        country:  document.getElementById('shipCountry'),
      };
      var badge = document.getElementById('shipAutoFilledBadge');

      // Remember the user-entered country so we can restore it on clear
      var defaultCountry = ship.country ? ship.country.value : '';

      function clearShipping() {
        if (ship.address1) ship.address1.value = '';
        if (ship.city)     ship.city.value = '';
        if (ship.province) ship.province.value = '';
        if (ship.zip)      ship.zip.value = '';
        if (ship.country)  ship.country.value = defaultCountry;
        if (badge) badge.style.display = 'none';
      }

      function fillShipping(a) {
        if (!a) return;
        if (ship.address1) ship.address1.value = a.address1 || '';
        if (ship.city)     ship.city.value     = a.city || '';
        if (ship.province) ship.province.value = a.province || '';
        if (ship.zip)      ship.zip.value      = a.zip || '';
        if (ship.country && a.country) ship.country.value = a.country;
        if (badge) badge.style.display = 'inline-block';
      }

      if (custSelect) {
        custSelect.addEventListener('change', function() {
          var cid = custSelect.value;
          // Email
          if (emailInput) {
            if (cid && emailMap[cid]) emailInput.value = emailMap[cid];
            else if (!cid) emailInput.value = '';
          }
          // Shipping address — only auto-fill when we actually have one on file
          if (!cid) {
            clearShipping();
          } else if (addrMap[cid]) {
            fillShipping(addrMap[cid]);
          } else {
            // Customer has no saved address — leave blanks, hide badge
            clearShipping();
          }
        });
      }

      // If the merchant edits any shipping field after auto-fill, hide the badge
      // so the UI doesn't falsely claim the values came from the customer record.
      ['address1','city','province','zip','country'].forEach(function(k) {
        var el = ship[k];
        if (el) el.addEventListener('input', function() {
          if (badge) badge.style.display = 'none';
        });
      });
    })();

    (function() {
      var catalog = [];
      try { catalog = JSON.parse(document.getElementById('productCatalog').textContent || '[]'); } catch(e) {}
      var container = document.getElementById('draftLineItems');
      var addBtn = document.getElementById('addLineItemBtn');
      var itemCount = 0;
      var productsUrl = '/admin/store/${esc(store.slug)}/products/new';
      var svgSearch = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="9" r="5"/><path d="M13 13l4 4"/></svg>';
      var svgPlus = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>';

      function escH(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

      function createItemRow() {
        itemCount++;
        var i = itemCount;
        var row = document.createElement('div');
        row.className = 'li-row';
        row.setAttribute('data-item-row', i);
        row.innerHTML =
          '<div class="li-label">' +
            '<span>Item ' + i + '</span>' +
            '<button type="button" class="li-remove" data-remove-row="' + i + '" title="Remove item">&times;</button>' +
          '</div>' +
          '<div class="li-grid">' +
            '<div class="li-field">' +
              '<label>Product / Title</label>' +
              '<div class="li-search-wrap">' +
                '<input type="text" name="item' + i + '_title" class="li-input li-title-input" ' +
                  'placeholder="Search products or type custom name..." autocomplete="off" />' +
                '<span class="li-search-icon">' + svgSearch + '</span>' +
                '<div class="li-dropdown" id="liDrop' + i + '"></div>' +
              '</div>' +
              '<div class="li-chip-area"></div>' +
            '</div>' +
            '<div class="li-row-bottom">' +
              '<div class="li-field">' +
                '<label>Unit Price</label>' +
                '<input type="text" name="item' + i + '_price" class="li-input li-price-input" placeholder="0.00" />' +
              '</div>' +
              '<div class="li-field">' +
                '<label>Quantity</label>' +
                '<input type="number" name="item' + i + '_qty" class="li-input li-qty-input" value="1" min="1" />' +
              '</div>' +
              '<div class="li-field">' +
                '<label>Line Total</label>' +
                '<div class="li-line-total">$0.00</div>' +
              '</div>' +
            '</div>' +
          '</div>';
        container.appendChild(row);
        wireSearch(row, i);
        wireRemove(row);
        wireLineTotal(row);
        return row;
      }

      function wireRemove(row) {
        var btn = row.querySelector('[data-remove-row]');
        if (btn) btn.addEventListener('click', function() { row.remove(); renumberRows(); });
      }

      function wireLineTotal(row) {
        var priceInput = row.querySelector('.li-price-input');
        var qtyInput = row.querySelector('.li-qty-input');
        var totalEl = row.querySelector('.li-line-total');
        function update() {
          var p = parseFloat(priceInput.value) || 0;
          var q = parseInt(qtyInput.value) || 1;
          totalEl.textContent = '$' + (p * q).toFixed(2);
        }
        priceInput.addEventListener('input', update);
        qtyInput.addEventListener('input', update);
        // Run once so a row seeded with qty=1 shows "$0.00" immediately
        // and, more importantly, so any row where the price gets filled
        // in programmatically (product-picker selection) can trigger
        // this same update() via a synthetic input event without needing
        // a reference to the closure.
        update();
      }

      function renumberRows() {
        var rows = container.querySelectorAll('.li-row');
        for (var r = 0; r < rows.length; r++) {
          var label = rows[r].querySelector('.li-label span');
          if (label) label.textContent = 'Item ' + (r + 1);
        }
      }

      function wireSearch(row, i) {
        var input = row.querySelector('.li-title-input');
        var priceInput = row.querySelector('.li-price-input');
        var dropdown = row.querySelector('.li-dropdown');
        var chipArea = row.querySelector('.li-chip-area');
        var searchIcon = row.querySelector('.li-search-icon');
        var activeIdx = -1;

        function showChip(title, price) {
          chipArea.innerHTML =
            '<div class="li-selected">' +
              '<span>✓ ' + escH(title) + ' — $' + parseFloat(price).toFixed(2) + '</span>' +
              '<button type="button" class="li-selected-clear" title="Clear selection">&times;</button>' +
            '</div>';
          var clearBtn = chipArea.querySelector('.li-selected-clear');
          if (clearBtn) clearBtn.addEventListener('click', function() {
            chipArea.innerHTML = '';
            input.value = '';
            priceInput.value = '';
            // Programmatic .value changes don't fire an input event, so
            // the line-total listener won't see the reset unless we
            // dispatch a synthetic one.
            priceInput.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
          });
        }

        function selectProduct(title, price) {
          input.value = title;
          priceInput.value = parseFloat(price).toFixed(2);
          // Programmatic assignment to .value does NOT fire an input
          // event, so the wireLineTotal listener never recalculates —
          // the user would see "$0.00" until they manually touched
          // quantity. Fire a synthetic event so the line total updates
          // immediately.
          priceInput.dispatchEvent(new Event('input', { bubbles: true }));
          dropdown.classList.remove('open');
          dropdown.innerHTML = '';
          input.blur();
          showChip(title, price);
        }

        function renderDropdown(query) {
          var q = (query || '').toLowerCase().trim();
          var matches = catalog.filter(function(p) {
            return p.title.toLowerCase().indexOf(q) !== -1;
          }).slice(0, 20);

          var html = '';
          if (matches.length > 0) {
            html = matches.map(function(p, idx) {
              return '<div class="li-opt" data-idx="' + idx + '" data-title="' + escH(p.title) + '" data-price="' + escH(p.price) + '">' +
                '<span class="li-opt-title">' + escH(p.title) + '</span>' +
                '<span class="li-opt-price">$' + parseFloat(p.price).toFixed(2) + '</span>' +
              '</div>';
            }).join('');
          } else if (q) {
            html += '<div class="li-opt li-opt-empty">No products match "' + escH(q) + '"</div>';
          } else {
            html += '<div class="li-opt li-opt-empty">Type to search your products...</div>';
          }
          html += '<a href="' + productsUrl + '" class="li-opt li-opt-add">' +
            svgPlus + ' Add new product' +
          '</a>';

          dropdown.innerHTML = html;
          dropdown.classList.add('open');
          activeIdx = -1;

          var opts = dropdown.querySelectorAll('.li-opt[data-title]');
          for (var o = 0; o < opts.length; o++) {
            (function(opt) {
              opt.addEventListener('mousedown', function(e) {
                e.preventDefault();
                selectProduct(opt.getAttribute('data-title'), opt.getAttribute('data-price'));
              });
            })(opts[o]);
          }
        }

        input.addEventListener('focus', function() {
          if (searchIcon) searchIcon.style.opacity = '1';
          chipArea.innerHTML = '';
          renderDropdown(input.value);
        });
        input.addEventListener('input', function() {
          chipArea.innerHTML = '';
          renderDropdown(input.value);
        });
        input.addEventListener('blur', function() {
          if (searchIcon) searchIcon.style.opacity = '.5';
          setTimeout(function() { dropdown.classList.remove('open'); }, 200);
        });

        input.addEventListener('keydown', function(e) {
          var opts = dropdown.querySelectorAll('.li-opt[data-title]');
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, opts.length - 1);
            for (var k = 0; k < opts.length; k++) opts[k].classList.toggle('active', k === activeIdx);
            if (opts[activeIdx]) opts[activeIdx].scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, 0);
            for (var k = 0; k < opts.length; k++) opts[k].classList.toggle('active', k === activeIdx);
            if (opts[activeIdx]) opts[activeIdx].scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'Enter' && activeIdx >= 0 && opts[activeIdx]) {
            e.preventDefault();
            selectProduct(opts[activeIdx].getAttribute('data-title'), opts[activeIdx].getAttribute('data-price'));
          } else if (e.key === 'Escape') {
            dropdown.classList.remove('open');
          }
        });
      }

      // First row
      createItemRow();

      // Add item button
      addBtn.addEventListener('click', function() {
        if (itemCount >= 20) return;
        var row = createItemRow();
        row.querySelector('.li-title-input').focus();
      });
    })();
    </script>
  `

  res.send(
    sellerLayout({
      title: 'Create Draft Order',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'orders',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /orders/drafts — Create draft order
// ---------------------------------------------------------------------------

export async function postDraftOrderCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const body = req.body

  // API mode: post to BE Order-Service insert-temp.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    try {
      const { createApiContext, insertTempOrder, createOrder, getCustomerByIdOrEmail } = await import('../lib/customer-api-client.js')
      const ctx = createApiContext(req)

      const lineItems: Array<{ title: string; price: number; quantity: number }> = []
      for (let i = 1; i <= 20; i++) {
        const title = body[`item${i}_title`]
        const price = body[`item${i}_price`]
        const qty = parseInt(body[`item${i}_qty`] || '1', 10)
        if (title && price) {
          lineItems.push({ title, price: parseFloat(price) || 0, quantity: Math.max(1, qty) })
        }
      }
      if (lineItems.length === 0) {
        return res.redirect(`/admin/store/${store.slug}/orders/drafts/new?error=${encodeURIComponent('At least one line item is required')}`)
      }

      const subtotal = lineItems.reduce((s, it) => s + it.price * it.quantity, 0)
      // Tax compute is deferred until after customer fetch — needs country_code
      // from customerData (form only sends country_name string, not ISO code).
      let tax = 0
      const tags = (body.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean)
      // action=create → real order (no draft tag → shown on /orders).
      // Default (Send invoice / save) → keep draft tag → shown on /orders/drafts.
      const isFinalize = body.action === 'create'
      if (!isFinalize && !tags.includes('draft')) tags.unshift('draft')
      if (isFinalize) {
        const idx = tags.indexOf('draft')
        if (idx >= 0) tags.splice(idx, 1)
      }

      // BE Order model has NO top-level email/customer_id — those fields
      // live inside billing_address / shipping_address (nested Customer object).
      // Fetch full customer to populate the nested addresses so the order has
      // proper data when listed (otherwise BE saves an empty stub).
      let customerData: any = null
      const idOrEmail = body.customer_id || body.email
      if (idOrEmail) {
        try {
          customerData = await getCustomerByIdOrEmail(ctx, idOrEmail)
        } catch (err: any) {
          console.warn('[draft-create-api] customer prefetch failed:', err?.message)
        }
      }

      const addressFromCustomer = customerData ? {
        id: customerData.id || null,
        first_name: customerData.first_name || null,
        last_name: customerData.last_name || null,
        full_name: customerData.full_name || [customerData.first_name, customerData.last_name].filter(Boolean).join(' '),
        email: customerData.email || body.email || null,
        phone: customerData.phone || null,
        address_1: customerData.address_1 || body.shipping_address1 || null,
        address_2: customerData.address_2 || null,
        city: customerData.city || body.shipping_city || null,
        province: customerData.province || body.shipping_province || null,
        zip: customerData.zip || body.shipping_zip || null,
        country_name: customerData.country_name || body.shipping_country || null,
        country_code: customerData.country_code || null,
      } : (body.email ? {
        email: body.email,
        address_1: body.shipping_address1 || null,
        city: body.shipping_city || null,
        province: body.shipping_province || null,
        zip: body.shipping_zip || null,
        country_name: body.shipping_country || null,
      } : null)

      // Now compute tax. Resolve country code from multiple sources, in order:
      //   1. customerData.country_code (BE Customer record — authoritative)
      //   2. body.shipping_country (form input — may be 2-letter code OR name)
      // If form value is a name like "Vietnam", look up ISO via small map.
      const NAME_TO_CC: Record<string, string> = {
        vietnam: 'vn', 'viet nam': 'vn', 'việt nam': 'vn',
        'united states': 'us', usa: 'us', america: 'us',
        'united kingdom': 'gb', uk: 'gb', britain: 'gb',
        canada: 'ca', australia: 'au', germany: 'de', france: 'fr',
        japan: 'jp', singapore: 'sg', thailand: 'th', malaysia: 'my',
        indonesia: 'id', philippines: 'ph', china: 'cn',
        'south korea': 'kr', korea: 'kr', india: 'in', brazil: 'br',
        mexico: 'mx', italy: 'it', spain: 'es', netherlands: 'nl',
      }
      let ccCreate = String((addressFromCustomer as any)?.country_code || customerData?.country_code || body.shipping_country || body.country_code || '').trim().toLowerCase()
      if (ccCreate.length > 2 && NAME_TO_CC[ccCreate]) {
        ccCreate = NAME_TO_CC[ccCreate]
      } else if (ccCreate.length !== 2) {
        // Unknown long form → try first 2 chars as last resort
        ccCreate = ccCreate.slice(0, 2)
      }
      if (ccCreate && subtotal > 0) {
        try {
          const { computeOrderTax } = await import('../lib/subfee-api-client.js')
          const r = await computeOrderTax(ctx, ccCreate, subtotal)
          tax = r.amount
          console.log('[draft-create-api] tax', ccCreate, '→', r.rate + '%', '→ $' + tax.toFixed(2))
        } catch (e: any) {
          console.warn('[draft-create-api] tax compute failed', e?.message)
        }
      } else {
        console.warn('[draft-create-api] no country_code → tax=0 (subtotal=' + subtotal + ')')
      }

      // BE CartItem shape (Order-Service Lencam_Order_Service_Models_LencamOrder_CartItem):
      // - product_name: display label (NOT `title` or `name`)
      // - variant: nested object — price lives inside variant.price
      // - quantity, total: top-level
      // Sending flat {title, price} caused BE to persist only `quantity` and
      // total_price=0 because BE didn't recognise the price location.
      const orderPayload: Record<string, any> = {
        shop_id: store.id,
        currency: body.currency || 'USD',
        tags,
        note: body.note || null,
        line_items: lineItems.map(it => ({
          product_name: it.title,
          quantity: it.quantity,
          fulfillment_quantity: 0,
          total: it.price * it.quantity,
          variant: {
            name: it.title,
            price: it.price,
          },
          custom_fields: [],
        })),
        total_items: lineItems.reduce((s, it) => s + it.quantity, 0),
        subtotal_price: subtotal,
        tax,
        total_price: Math.round((subtotal + tax) * 100) / 100,
        total_transaction: Math.round((subtotal + tax) * 100) / 100,
        payment_status: false,
        // BE Order.status enum: Pending|Updating|Processing|Picked|Fulfillment|
        // Cancel|Refund|Hold|Resend. Drafts use 'Pending' + tag 'draft' to
        // separate from real orders in list filtering.
        status: 'Pending',
        create_date: new Date().toISOString(),
        update_date: new Date().toISOString(),
      }
      if (addressFromCustomer) {
        orderPayload.billing_address = addressFromCustomer
        orderPayload.shipping_address = addressFromCustomer
      }
      // BE has 2 distinct endpoints:
      // - POST /api/{shop_id}/insert-temp → InsertOnetempAsync: raw insert,
      //   no order_number / short_id / counter. Use only for true drafts.
      // - POST /api/{shop_id} → InsertOneAsync: assigns order_number, short_id,
      //   resets payment_status etc. Required for orders to appear in /orders list.
      if (isFinalize) {
        await createOrder(ctx, orderPayload)
      } else {
        await insertTempOrder(ctx, orderPayload)
      }
      const dest = isFinalize ? '/orders' : '/orders/drafts'
      const msg = isFinalize ? 'Order created' : 'Draft created'
      return res.redirect(`/admin/store/${store.slug}${dest}?success=${encodeURIComponent(msg)}`)
    } catch (err: any) {
      console.error('[draft-create-api] failed:', err?.message || err)
      return res.redirect(`/admin/store/${store.slug}/orders/drafts/new?error=${encodeURIComponent(err?.message || 'Save failed')}`)
    }
  }

  try {
    // Build line items from form fields
    const lineItems: Array<{ title: string; price: string; quantity: number }> = []

    // Support dynamic number of line items (up to 20)
    for (let i = 1; i <= 20; i++) {
      const title = body[`item${i}_title`]
      const price = body[`item${i}_price`]
      const qty = parseInt(body[`item${i}_qty`] || '1', 10)
      if (title && price) {
        lineItems.push({ title, price: String(parseFloat(price).toFixed(2)), quantity: Math.max(1, qty) })
      }
    }

    if (lineItems.length === 0) {
      return res.redirect(`/admin/store/${store.slug}/orders/drafts/new?error=${encodeURIComponent('At least one line item is required')}`)
    }

    // Build tags — always include 'draft'
    const tags = (body.tags || 'draft')
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean)
    if (!tags.includes('draft')) tags.unshift('draft')

    // Build shipping address if provided
    const shippingAddress = body.shipping_address1 ? {
      address1: body.shipping_address1,
      city: body.shipping_city || null,
      province: body.shipping_province || null,
      zip: body.shipping_zip || null,
      country: body.shipping_country || 'US',
    } : null

    // If customer selected but email not typed, look up the customer's email
    let email = body.email || null
    if (!email && body.customer_id) {
      try {
        const cust = await db
          .selectFrom('customers')
          .select(['email'])
          .where('id', '=', body.customer_id)
          .where('shop_id', '=', store.id)
          .executeTakeFirst()
        if (cust?.email) email = cust.email
      } catch { /* graceful */ }
    }

    const newOrder = await createOrder(db, store.id, {
      customer_id: body.customer_id || null,
      email,
      note: body.note || null,
      tags,
      financial_status: 'pending',
      shipping_address: shippingAddress,
      line_items: lineItems,
    })

    // Fire automation trigger (fire-and-forget)
    void fireAutomationTrigger(db, store.id, 'order_created', { order: newOrder }).catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'draft_order_created',
      title: `Draft order created: ${lineItems.length} item${lineItems.length === 1 ? '' : 's'}`,
      message: [email || null, byActor(user)].filter(Boolean).join(' • '),
      resourceType: 'order',
      resourceId: (newOrder as any)?.id,
    })

    res.redirect(`/admin/store/${store.slug}/orders/drafts?success=created`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/orders/drafts/new?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /orders/drafts/:id/send-invoice — Send invoice email
// ---------------------------------------------------------------------------

export async function postSendInvoice(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const orderId = req.params.id

  try {
    // Load the draft order
    const order = await db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .executeTakeFirst()

    if (!order || !order.email) {
      res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Order not found or has no email')}`)
      return
    }

    // Load line items
    const lineItems = await db
      .selectFrom('order_line_items')
      .selectAll()
      .where('order_id', '=', orderId)
      .execute()

    const subtotal = lineItems.reduce((sum, li: any) => sum + parseFloat(li.price || '0') * (li.quantity || 1), 0)
    const total = parseFloat(String(order.total_price || subtotal))

    // Build payment URL — checkout page for this order
    const paymentUrl = `${req.protocol}://${req.get('host')}/checkout/${orderId}`

    await sendInvoice(db, store.id, {
      order_id: order.id,
      order_number: order.order_number as number,
      email: order.email,
      currency: order.currency || 'USD',
      line_items: lineItems.map((li: any) => ({
        title: li.title || 'Item',
        variant_title: li.variant_title || null,
        quantity: li.quantity || 1,
        price: String(parseFloat(li.price || '0').toFixed(2)),
      })),
      subtotal: subtotal.toFixed(2),
      total: total.toFixed(2),
      note: order.note || null,
      payment_url: paymentUrl,
      due_date: null,
    })

    // Stamp 'invoice-sent' tag so the Invoice sent tab picks it up.
    const currentTags = Array.isArray(order.tags) ? (order.tags as string[]) : []
    if (!currentTags.includes('invoice-sent')) {
      const newTags = [...currentTags, 'invoice-sent']
      await db
        .updateTable('orders')
        .set({ tags: newTags as any, updated_at: new Date().toISOString() })
        .where('id', '=', orderId)
        .execute()
    }

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'draft_invoice_sent',
      title: `Invoice sent: order #D${order.order_number}`,
      message: [order.email, byActor(user)].filter(Boolean).join(' • '),
      resourceType: 'order',
      resourceId: order.id,
    })

    res.redirect(`/admin/store/${store.slug}/orders/drafts?success=invoice_sent`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Failed to send invoice: ' + err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /orders/drafts/:id/convert — Convert draft to real order
// ---------------------------------------------------------------------------

export async function postConvertDraft(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const orderId = req.params.id

  try {
    const order = await db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .where('financial_status', '=', 'pending')
      .executeTakeFirst()

    if (!order) {
      res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Draft order not found')}`)
      return
    }

    // Convert: change financial_status to 'paid', swap 'draft' → 'completed-draft'.
    // The sticky 'completed-draft' tag keeps the converted order visible in
    // the Draft Orders "Complete" tab even though it is now a normal paid order.
    const currentTags = Array.isArray(order.tags) ? order.tags : []
    const newTags = currentTags.filter((t: string) => t !== 'draft')
    if (!newTags.includes('completed-draft')) newTags.push('completed-draft')

    await db
      .updateTable('orders')
      .set({
        financial_status: 'paid',
        tags: newTags as any,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', orderId)
      .execute()

    // Send order confirmation email if customer has email
    if (order.email) {
      try {
        const { sendOrderConfirmation } = await import('@gbox/core/modules/email/service.js')
        const lineItems = await db.selectFrom('order_line_items').selectAll().where('order_id', '=', orderId).execute()
        void sendOrderConfirmation(db, store.id, {
          id: order.id,
          order_number: order.order_number as number,
          email: order.email,
          currency: order.currency || 'USD',
          subtotal_price: String(order.subtotal_price || '0'),
          total_shipping: String(order.total_shipping || '0'),
          total_tax: String(order.total_tax || '0'),
          total_discounts: String(order.total_discounts || '0'),
          total_price: String(order.total_price || '0'),
          line_items: lineItems.map((li: any) => ({
            title: li.title || '', variant_title: li.variant_title, quantity: li.quantity, price: String(li.price),
          })),
          shipping_address: order.shipping_address as any,
          billing_address: order.billing_address as any,
          created_at: String(order.created_at),
        }).catch(() => {})
      } catch { /* email optional */ }
    }

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'draft_order_converted',
      title: `Draft converted: #D${order.order_number}`,
      message: byActor(user),
      resourceType: 'order',
      resourceId: orderId,
    })

    res.redirect(`/admin/store/${store.slug}/orders/${orderId}?success=converted`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Failed to convert: ' + err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /orders/drafts/:id/delete — Delete draft order
// ---------------------------------------------------------------------------

export async function postDeleteDraft(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const orderId = req.params.id

  try {
    // Only delete orders that are still pending (drafts)
    const order = await db
      .selectFrom('orders')
      .select(['id', 'financial_status'])
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .where('financial_status', '=', 'pending')
      .executeTakeFirst()

    if (!order) {
      res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Draft not found or already converted')}`)
      return
    }

    // Delete line items first, then order
    await db.deleteFrom('order_line_items').where('order_id', '=', orderId).execute()
    await db.deleteFrom('orders').where('id', '=', orderId).where('shop_id', '=', store.id).execute()

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'draft_order_deleted',
      title: `Draft order deleted`,
      message: byActor(user),
      resourceType: 'order',
      resourceId: orderId,
    })

    res.redirect(`/admin/store/${store.slug}/orders/drafts?success=deleted`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Failed to delete: ' + err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /orders/drafts/bulk — Bulk actions on selected draft orders
//
// Body: action=convert|send_invoice|delete, ids=<uuid>[&ids=<uuid>...]
// Uses the SAME core logic as the single-id handlers — we just loop.
// ---------------------------------------------------------------------------

export async function postBulkDraftAction(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const body = req.body as { action?: string; ids?: string | string[] }

  const action = String(body.action || '')
  if (action !== 'convert' && action !== 'send_invoice' && action !== 'delete') {
    res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Unknown bulk action')}`)
    return
  }

  const ids: string[] = Array.isArray(body.ids)
    ? body.ids.map(String).filter(Boolean)
    : typeof body.ids === 'string' && body.ids
      ? [body.ids]
      : []
  if (ids.length === 0) {
    res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('No drafts selected')}`)
    return
  }

  let success = 0
  let failed = 0

  for (const orderId of ids) {
    try {
      // All three actions load the order first + verify shop ownership.
      const order = await db
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', orderId)
        .where('shop_id', '=', store.id)
        .executeTakeFirst()
      if (!order) { failed++; continue }

      if (action === 'delete') {
        if (order.financial_status !== 'pending') { failed++; continue }
        await db.deleteFrom('order_line_items').where('order_id', '=', orderId).execute()
        await db.deleteFrom('orders').where('id', '=', orderId).where('shop_id', '=', store.id).execute()
        success++
        continue
      }

      if (action === 'send_invoice') {
        if (!order.email) { failed++; continue }
        const lineItems = await db
          .selectFrom('order_line_items')
          .selectAll()
          .where('order_id', '=', orderId)
          .execute()
        const subtotal = lineItems.reduce(
          (sum, li: any) => sum + parseFloat(li.price || '0') * (li.quantity || 1),
          0,
        )
        const total = parseFloat(String(order.total_price || subtotal))
        const paymentUrl = `${req.protocol}://${req.get('host')}/checkout/${orderId}`
        await sendInvoice(db, store.id, {
          order_id: order.id,
          order_number: order.order_number as number,
          email: order.email,
          currency: order.currency || 'USD',
          line_items: lineItems.map((li: any) => ({
            title: li.title || 'Item',
            variant_title: li.variant_title || null,
            quantity: li.quantity || 1,
            price: String(parseFloat(li.price || '0').toFixed(2)),
          })),
          subtotal: subtotal.toFixed(2),
          total: total.toFixed(2),
          note: order.note || null,
          payment_url: paymentUrl,
          due_date: null,
        })
        const currentTags = Array.isArray(order.tags) ? (order.tags as string[]) : []
        if (!currentTags.includes('invoice-sent')) {
          const newTags = [...currentTags, 'invoice-sent']
          await db
            .updateTable('orders')
            .set({ tags: newTags as any, updated_at: new Date().toISOString() })
            .where('id', '=', orderId)
            .execute()
        }
        success++
        continue
      }

      if (action === 'convert') {
        if (order.financial_status !== 'pending') { failed++; continue }
        const currentTags = Array.isArray(order.tags) ? (order.tags as string[]) : []
        const newTags = currentTags.filter((t) => t !== 'draft')
        if (!newTags.includes('completed-draft')) newTags.push('completed-draft')
        await db
          .updateTable('orders')
          .set({
            financial_status: 'paid',
            tags: newTags as any,
            updated_at: new Date().toISOString(),
          })
          .where('id', '=', orderId)
          .execute()
        success++
        continue
      }
    } catch {
      failed++
    }
  }

  // Single rollup notification for the bulk op
  const actionNoun =
    action === 'convert' ? 'converted' : action === 'send_invoice' ? 'invoiced' : 'deleted'
  notify(db, {
    shopId: store.id,
    userId: user?.id,
    type: `draft_order_bulk_${action}`,
    title: `${success} draft order${success === 1 ? '' : 's'} ${actionNoun}${failed > 0 ? ` (${failed} failed)` : ''}`,
    message: byActor(user),
    resourceType: 'order',
    resourceId: null,
  })

  const successParam = action === 'convert'
    ? 'bulk_converted'
    : action === 'send_invoice'
      ? 'bulk_invoice_sent'
      : 'bulk_deleted'
  // For send_invoice, land the user on the Invoice sent tab so they can
  // immediately see the orders that just got invoiced. For convert, land on
  // the Complete tab for the same reason. Delete just drops back to All.
  const landingTab = action === 'send_invoice'
    ? '&tab=invoice_sent'
    : action === 'convert'
      ? '&tab=complete'
      : ''
  res.redirect(
    `/admin/store/${store.slug}/orders/drafts?success=${successParam}&count=${success}${
      failed > 0 ? `&failed=${failed}` : ''
    }${landingTab}`,
  )
}

// ---------------------------------------------------------------------------
// GET /orders/drafts/:id — Draft order detail / edit
// ---------------------------------------------------------------------------

export async function getDraftOrderDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const orderId = req.params.id
  const success = req.query.success as string || ''
  const error = req.query.error as string || ''

  try {
    const order: any = await db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .executeTakeFirst()

    if (!order) {
      res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Draft order not found')}`)
      return
    }

    const lineItems: any[] = await db
      .selectFrom('order_line_items')
      .selectAll()
      .where('order_id', '=', orderId)
      .execute()

    // Get customer info if linked
    let customer: any = null
    if (order.customer_id) {
      try {
        customer = await db
          .selectFrom('customers')
          .select(['id', 'first_name', 'last_name', 'email', 'phone'])
          .where('id', '=', order.customer_id)
          .executeTakeFirst()
      } catch { /* ok */ }
    }

    // Load customer list for edit dropdown
    let customers: any[] = []
    try {
      customers = await db
        .selectFrom('customers')
        .select(['id', 'first_name', 'last_name', 'email'])
        .where('shop_id', '=', store.id)
        .orderBy('first_name', 'asc')
        .limit(100)
        .execute()
    } catch { /* ok */ }

    // Load products for edit line items picker
    let products: Array<{ id: string; title: string; price: string }> = []
    try {
      products = await db
        .selectFrom('products')
        .innerJoin('product_variants', 'product_variants.product_id', 'products.id')
        .select(['products.id', 'products.title', 'product_variants.price'])
        .where('products.shop_id', '=', store.id)
        .where('products.status', '=', 'active')
        .orderBy('products.title', 'asc')
        .limit(200)
        .execute()
      const seen = new Set<string>()
      products = products.filter(p => {
        if (seen.has(p.id)) return false
        seen.add(p.id)
        return true
      })
    } catch { /* ok */ }

    const orderNumRaw = order.order_number || order.id.slice(0, 8)
    const orderNum = `D${orderNumRaw}`
    const isDraft = order.financial_status === 'pending'
    const createdAt = new Date(order.created_at).toLocaleString()
    const updatedAt = order.updated_at ? new Date(order.updated_at).toLocaleString() : createdAt
    const shipping = (order.shipping_address && typeof order.shipping_address === 'object') ? order.shipping_address : {} as any
    const subtotal = lineItems.reduce((sum, li) => sum + parseFloat(li.price || '0') * (li.quantity || 1), 0)
    const total = parseFloat(String(order.total_price || subtotal))
    const customerName = customer ? [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.email : null

    const customerOptionsEdit = customers.map(c => {
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown'
      const selected = c.id === order.customer_id ? ' selected' : ''
      return `<option value="${esc(c.id)}"${selected}>${esc(name)} (${esc(c.email || 'no email')})</option>`
    }).join('')

    const customerEmailMapEdit: Record<string, string> = {}
    customers.forEach(c => { if (c.email) customerEmailMapEdit[c.id] = c.email })

    const content = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <div style="display:flex;align-items:center;gap:12px">
        <a href="/admin/store/${esc(store.slug)}/orders/drafts" style="color:var(--s-text-muted);text-decoration:none;font-size:13px">&larr; Draft Orders</a>
        <div>
          <h1 style="margin:0;font-size:22px;font-weight:700">Draft #${esc(String(orderNum))}</h1>
          <p style="margin:4px 0 0;color:var(--s-text-muted);font-size:13px">Created ${createdAt} &middot; Updated ${updatedAt}</p>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${isDraft ? 'badge-warning' : 'badge-success'}" style="font-size:12px;padding:4px 10px">${isDraft ? 'Draft' : esc(order.financial_status)}</span>
        ${isDraft ? `
          <form method="POST" action="/admin/store/${esc(store.slug)}/orders/drafts/${esc(orderId)}/convert" style="margin:0">
            <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
            <button type="submit" class="btn btn-sm" style="background:#16a34a;color:#fff;border:none;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Convert to Order</button>
          </form>
          ${order.email ? `
          <form method="POST" action="/admin/store/${esc(store.slug)}/orders/drafts/${esc(orderId)}/send-invoice" style="margin:0">
            <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
            <button type="submit" class="btn btn-sm" style="background:#2563eb;color:#fff;border:none;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Send Invoice</button>
          </form>` : ''}
          <form method="POST" action="/admin/store/${esc(store.slug)}/orders/drafts/${esc(orderId)}/delete" style="margin:0">
            <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
            <button type="submit" class="btn btn-sm" style="background:var(--s-bg);border:1px solid var(--s-danger);color:var(--s-danger);font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Delete</button>
          </form>
        ` : ''}
      </div>
    </div>

    ${success ? `<div style="background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#22c55e;font-size:13px">${success === 'updated' ? 'Draft order updated successfully!' : esc(success)}</div>` : ''}
    ${error ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#b91c1c;font-size:13px">${esc(decodeURIComponent(error))}</div>` : ''}

    <div style="display:grid;grid-template-columns:2fr 1fr;gap:24px;max-width:1000px">
      <!-- Left column: editable form -->
      <div>
        <form method="POST" action="/admin/store/${esc(store.slug)}/orders/drafts/${esc(orderId)}/update">
          <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />

          <!-- Line Items — styled to match Create Draft Order form -->
          <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
            <h2 style="margin:0 0 16px;font-size:17px;font-weight:700">Line Items</h2>
            ${isDraft ? `
              <p style="margin:0 0 12px;color:var(--s-text-muted);font-size:13px">Search products or type a custom item name. Price auto-fills when selecting a product.</p>
              <div id="editLineItems">
                ${lineItems.map((li, idx) => {
                  const liTotal = (parseFloat(li.price || '0') * (li.quantity || 1)).toFixed(2)
                  return `
                  <div class="li-row" data-item-row="${idx + 1}">
                    <div class="li-label">
                      <span>Item ${idx + 1}</span>
                      <button type="button" class="li-remove" data-remove-row="${idx + 1}" title="Remove item">&times;</button>
                    </div>
                    <div class="li-grid">
                      <!-- Row 1: Product search -->
                      <div class="li-field">
                        <label>Product / Title</label>
                        <div class="li-search-wrap">
                          <input type="text" name="item${idx + 1}_title" value="${esc(li.title || '')}" class="li-input li-title-input" required autocomplete="off" placeholder="Search products or type custom name..." />
                          <span class="li-search-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="9" r="5"/><path d="M13 13l4 4"/></svg></span>
                          <div class="li-dropdown"></div>
                        </div>
                        <div class="li-chip-area"></div>
                      </div>
                      <!-- Row 2: Price + Qty + Line total -->
                      <div class="li-row-bottom">
                        <div class="li-field">
                          <label>Unit Price</label>
                          <input type="text" name="item${idx + 1}_price" value="${esc(parseFloat(li.price || '0').toFixed(2))}" class="li-input li-price-input" required placeholder="0.00" />
                        </div>
                        <div class="li-field">
                          <label>Quantity</label>
                          <input type="number" name="item${idx + 1}_qty" value="${li.quantity || 1}" min="1" class="li-input li-qty-input" required />
                        </div>
                        <div class="li-field">
                          <label>Line Total</label>
                          <div class="li-line-total">$${liTotal}</div>
                        </div>
                      </div>
                    </div>
                  </div>`
                }).join('')}
              </div>
              <button type="button" id="editAddLineItemBtn" style="margin-top:12px;padding:8px 16px;border:1px dashed var(--s-border);border-radius:8px;background:none;color:var(--s-accent);cursor:pointer;font-size:13px;font-weight:600;width:100%;transition:background .15s">+ Add another item</button>
            ` : `
              <!-- Read-only view for converted drafts, styled to echo the .li-row look -->
              <div>
                ${lineItems.map((li, idx) => {
                  const liTotal = (parseFloat(li.price || '0') * (li.quantity || 1)).toFixed(2)
                  return `
                  <div class="li-row" style="cursor:default">
                    <div class="li-label">
                      <span>Item ${idx + 1}</span>
                    </div>
                    <div class="li-grid">
                      <div class="li-field">
                        <label>Product / Title</label>
                        <div class="li-search-wrap">
                          <input type="text" class="li-input" value="${esc(li.title || '')}" disabled />
                        </div>
                      </div>
                      <div class="li-row-bottom">
                        <div class="li-field">
                          <label>Unit Price</label>
                          <input type="text" class="li-input" value="$${esc(parseFloat(li.price || '0').toFixed(2))}" disabled />
                        </div>
                        <div class="li-field">
                          <label>Quantity</label>
                          <input type="text" class="li-input" value="${li.quantity || 1}" disabled />
                        </div>
                        <div class="li-field">
                          <label>Line Total</label>
                          <div class="li-line-total">$${esc(liTotal)}</div>
                        </div>
                      </div>
                    </div>
                  </div>`
                }).join('')}
              </div>
            `}

            <!-- Totals -->
            <div style="border-top:2px solid var(--s-border);padding-top:14px;margin-top:18px;display:flex;flex-direction:column;gap:6px;align-items:flex-end">
              <div style="display:flex;gap:40px;font-size:13px;color:var(--s-text-muted)">
                <span>Subtotal</span>
                <span id="editSubtotal" style="font-weight:600;color:var(--s-text)">$${subtotal.toFixed(2)}</span>
              </div>
              <div style="display:flex;gap:40px;font-size:15px;font-weight:700;border-top:1px solid var(--s-border);padding-top:8px;margin-top:4px">
                <span>Total</span>
                <span id="editTotal" style="color:var(--s-accent)">$${total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <!-- Product catalog for picker -->
          <script id="editProductCatalog" type="application/json">${JSON.stringify(products.map(p => ({ id: p.id, title: p.title, price: p.price })))}</script>

          <!-- Customer -->
          <div class="card" style="margin-bottom:20px">
            <div class="card-header">Customer</div>
            <div class="card-body">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                <div>
                  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Customer</label>
                  <select name="customer_id" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px" ${isDraft ? '' : 'disabled'} id="editCustSelect">
                    <option value="">-- Guest order --</option>
                    ${customerOptionsEdit}
                  </select>
                </div>
                <div>
                  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Email</label>
                  <input type="email" name="email" value="${esc(order.email || '')}" placeholder="customer@example.com" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px" ${isDraft ? '' : 'disabled'} id="editEmailInput" />
                </div>
              </div>
            </div>
          </div>

          <!-- Shipping -->
          <div class="card" style="margin-bottom:20px">
            <div class="card-header">Shipping Address</div>
            <div class="card-body">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
                <div style="grid-column:span 2">
                  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Address</label>
                  <input type="text" name="shipping_address1" value="${esc(shipping.address1 || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px" ${isDraft ? '' : 'disabled'} />
                </div>
                <div>
                  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">City</label>
                  <input type="text" name="shipping_city" value="${esc(shipping.city || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px" ${isDraft ? '' : 'disabled'} />
                </div>
                <div>
                  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">State</label>
                  <input type="text" name="shipping_province" value="${esc(shipping.province || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px" ${isDraft ? '' : 'disabled'} />
                </div>
                <div>
                  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">ZIP</label>
                  <input type="text" name="shipping_zip" value="${esc(shipping.zip || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px" ${isDraft ? '' : 'disabled'} />
                </div>
                <div>
                  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Country</label>
                  <input type="text" name="shipping_country" value="${esc(shipping.country || 'US')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px" ${isDraft ? '' : 'disabled'} />
                </div>
              </div>
            </div>
          </div>

          <!-- Note & Tags -->
          <div class="card" style="margin-bottom:20px">
            <div class="card-header">Notes & Tags</div>
            <div class="card-body">
              <div style="margin-bottom:16px">
                <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Note</label>
                <textarea name="note" rows="3" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px;resize:vertical" ${isDraft ? '' : 'disabled'}>${esc(order.note || '')}</textarea>
              </div>
              <div>
                <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Tags</label>
                <input type="text" name="tags" value="${esc(Array.isArray(order.tags) ? order.tags.join(', ') : (order.tags || 'draft'))}" style="width:100%;padding:8px 12px;border:1px solid var(--s-border);border-radius:6px;background:var(--s-card);color:var(--s-text);font-size:14px" ${isDraft ? '' : 'disabled'} />
              </div>
            </div>
          </div>

          ${isDraft ? `<button type="submit" class="btn btn-primary" style="padding:10px 24px;font-size:14px;font-weight:600;border-radius:8px">Save Changes</button>` : ''}
        </form>
      </div>

      <!-- Right column: summary sidebar -->
      <div>
        <div class="card" style="margin-bottom:20px">
          <div class="card-header">Summary</div>
          <div class="card-body" style="font-size:13px">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px">
              <span style="color:var(--s-text-muted)">Subtotal</span>
              <span id="sidebarSubtotal" style="font-weight:600">$${subtotal.toFixed(2)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px">
              <span style="color:var(--s-text-muted)">Shipping</span>
              <span style="font-weight:600">$${parseFloat(String(order.total_shipping || '0')).toFixed(2)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:8px">
              <span style="color:var(--s-text-muted)">Tax</span>
              <span style="font-weight:600">$${parseFloat(String(order.total_tax || '0')).toFixed(2)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;padding-top:8px;border-top:2px solid var(--s-border)">
              <span style="font-weight:700;font-size:14px">Total</span>
              <span id="sidebarTotal" style="font-weight:700;font-size:16px;color:var(--s-accent)">$${total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:20px">
          <div class="card-header">Customer Info</div>
          <div class="card-body" style="font-size:13px">
            ${customerName ? `
              <div style="font-weight:600;margin-bottom:4px">${esc(customerName)}</div>
              <div style="color:var(--s-text-muted);margin-bottom:4px">${esc(customer?.email || order.email || '')}</div>
              ${customer?.phone ? `<div style="color:var(--s-text-muted)">${esc(customer.phone)}</div>` : ''}
            ` : order.email ? `
              <div style="color:var(--s-text-muted)">${esc(order.email)}</div>
              <div style="margin-top:4px;font-size:12px;color:var(--s-text-dim)">Guest order</div>
            ` : `
              <div style="color:var(--s-text-dim);font-style:italic">No customer linked</div>
            `}
          </div>
        </div>

        <div class="card">
          <div class="card-header">Timeline</div>
          <div class="card-body" style="font-size:12px;color:var(--s-text-muted)">
            <div style="margin-bottom:6px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--s-warning);margin-right:6px;vertical-align:middle"></span>
              Created &middot; ${createdAt}
            </div>
            ${order.updated_at && order.updated_at !== order.created_at ? `
            <div style="margin-bottom:6px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--s-info);margin-right:6px;vertical-align:middle"></span>
              Updated &middot; ${updatedAt}
            </div>` : ''}
            ${!isDraft ? `
            <div>
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--s-success);margin-right:6px;vertical-align:middle"></span>
              Converted to order
            </div>` : ''}
          </div>
        </div>
      </div>
    </div>

    ${LINE_ITEM_STYLES}

    <!-- Customer email map for auto-fill on edit -->
    <script id="editCustomerEmailMap" type="application/json">${JSON.stringify(customerEmailMapEdit)}</script>
    <script>
    (function() {
      // Customer email auto-fill
      var emailMap = {};
      try { emailMap = JSON.parse(document.getElementById('editCustomerEmailMap').textContent || '{}'); } catch(e) {}
      var sel = document.getElementById('editCustSelect');
      var inp = document.getElementById('editEmailInput');
      if (sel && inp) {
        sel.addEventListener('change', function() {
          var cid = sel.value;
          if (cid && emailMap[cid]) inp.value = emailMap[cid];
        });
      }

      // --- Product picker + auto-recalculate for draft edit ---
      var container = document.getElementById('editLineItems');
      var addBtn = document.getElementById('editAddLineItemBtn');
      if (!container) return; // not in edit mode

      var catalog = [];
      try { catalog = JSON.parse(document.getElementById('editProductCatalog').textContent || '[]'); } catch(e) {}
      var productsUrl = '/admin/store/${esc(store.slug)}/products/new';
      var svgSearch = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="9" r="5"/><path d="M13 13l4 4"/></svg>';
      var svgPlus = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>';

      function escH(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

      function recalcTotals() {
        var rows = container.querySelectorAll('.li-row');
        var sub = 0;
        for (var r = 0; r < rows.length; r++) {
          var p = parseFloat(rows[r].querySelector('.li-price-input').value) || 0;
          var q = parseInt(rows[r].querySelector('.li-qty-input').value) || 1;
          var lineT = rows[r].querySelector('.li-line-total');
          if (lineT) lineT.textContent = '$' + (p * q).toFixed(2);
          sub += p * q;
        }
        var subEl = document.getElementById('editSubtotal');
        var totEl = document.getElementById('editTotal');
        var sumEl = document.getElementById('sidebarSubtotal');
        var sumTotEl = document.getElementById('sidebarTotal');
        if (subEl) subEl.textContent = '$' + sub.toFixed(2);
        if (totEl) totEl.textContent = '$' + sub.toFixed(2);
        if (sumEl) sumEl.textContent = '$' + sub.toFixed(2);
        if (sumTotEl) sumTotEl.textContent = '$' + sub.toFixed(2);
      }

      function wireSearch(row) {
        var input = row.querySelector('.li-title-input');
        var priceInput = row.querySelector('.li-price-input');
        var dropdown = row.querySelector('.li-dropdown');
        var chipArea = row.querySelector('.li-chip-area');
        var searchIcon = row.querySelector('.li-search-icon');
        var activeIdx = -1;

        function showChip(title, price) {
          chipArea.innerHTML =
            '<div class="li-selected">' +
              '<span>&#10003; ' + escH(title) + ' — $' + parseFloat(price).toFixed(2) + '</span>' +
              '<button type="button" class="li-selected-clear" title="Clear selection">&times;</button>' +
            '</div>';
          var clearBtn = chipArea.querySelector('.li-selected-clear');
          if (clearBtn) clearBtn.addEventListener('click', function() {
            chipArea.innerHTML = '';
            input.value = '';
            priceInput.value = '';
            input.focus();
            recalcTotals();
          });
        }

        function selectProduct(title, price) {
          input.value = title;
          priceInput.value = parseFloat(price).toFixed(2);
          dropdown.classList.remove('open');
          dropdown.innerHTML = '';
          input.blur();
          showChip(title, price);
          recalcTotals();
        }

        function renderDropdown(query) {
          var q = (query || '').toLowerCase().trim();
          var matches = catalog.filter(function(p) {
            return p.title.toLowerCase().indexOf(q) !== -1;
          }).slice(0, 20);

          var html = '';
          if (matches.length > 0) {
            html = matches.map(function(p, idx) {
              return '<div class="li-opt" data-idx="' + idx + '" data-title="' + escH(p.title) + '" data-price="' + escH(p.price) + '">' +
                '<span class="li-opt-title">' + escH(p.title) + '</span>' +
                '<span class="li-opt-price">$' + parseFloat(p.price).toFixed(2) + '</span>' +
              '</div>';
            }).join('');
          } else if (q) {
            html += '<div class="li-opt li-opt-empty">No products match "' + escH(q) + '"</div>';
          } else {
            html += '<div class="li-opt li-opt-empty">Type to search your products...</div>';
          }
          html += '<a href="' + productsUrl + '" class="li-opt li-opt-add">' + svgPlus + ' Add new product</a>';
          dropdown.innerHTML = html;
          dropdown.classList.add('open');
          activeIdx = -1;

          var opts = dropdown.querySelectorAll('.li-opt[data-title]');
          for (var o = 0; o < opts.length; o++) {
            (function(opt) {
              opt.addEventListener('mousedown', function(e) {
                e.preventDefault();
                selectProduct(opt.getAttribute('data-title'), opt.getAttribute('data-price'));
              });
            })(opts[o]);
          }
        }

        input.addEventListener('focus', function() {
          if (searchIcon) searchIcon.style.opacity = '1';
          chipArea.innerHTML = '';
          renderDropdown(input.value);
        });
        input.addEventListener('input', function() {
          chipArea.innerHTML = '';
          renderDropdown(input.value);
        });
        input.addEventListener('blur', function() {
          if (searchIcon) searchIcon.style.opacity = '.5';
          setTimeout(function() { dropdown.classList.remove('open'); }, 200);
        });
        input.addEventListener('keydown', function(e) {
          var opts = dropdown.querySelectorAll('.li-opt[data-title]');
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIdx = Math.min(activeIdx + 1, opts.length - 1);
            for (var k = 0; k < opts.length; k++) opts[k].classList.toggle('active', k === activeIdx);
            if (opts[activeIdx]) opts[activeIdx].scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIdx = Math.max(activeIdx - 1, 0);
            for (var k = 0; k < opts.length; k++) opts[k].classList.toggle('active', k === activeIdx);
            if (opts[activeIdx]) opts[activeIdx].scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'Enter' && activeIdx >= 0 && opts[activeIdx]) {
            e.preventDefault();
            selectProduct(opts[activeIdx].getAttribute('data-title'), opts[activeIdx].getAttribute('data-price'));
          } else if (e.key === 'Escape') {
            dropdown.classList.remove('open');
          }
        });

        // Auto-recalc on price/qty change
        priceInput.addEventListener('input', recalcTotals);
        row.querySelector('.li-qty-input').addEventListener('input', recalcTotals);
      }

      // Wire existing rows
      var existingRows = container.querySelectorAll('.li-row');
      for (var i = 0; i < existingRows.length; i++) {
        wireSearch(existingRows[i]);
        var removeBtn = existingRows[i].querySelector('.li-remove');
        if (removeBtn) {
          (function(row) {
            removeBtn.addEventListener('click', function() { row.remove(); renumberRows(); recalcTotals(); });
          })(existingRows[i]);
        }
      }

      var itemCount = existingRows.length;

      function renumberRows() {
        var rows = container.querySelectorAll('.li-row');
        for (var r = 0; r < rows.length; r++) {
          var label = rows[r].querySelector('.li-label span');
          if (label) label.innerHTML = 'Item ' + (r + 1);
        }
        itemCount = rows.length;
      }

      if (addBtn) {
        addBtn.addEventListener('click', function() {
          if (itemCount >= 20) return;
          itemCount++;
          var i = itemCount;
          var row = document.createElement('div');
          row.className = 'li-row';
          row.setAttribute('data-item-row', i);
          row.innerHTML =
            '<div class="li-label">' +
              '<span>Item ' + i + '</span>' +
              '<button type="button" class="li-remove" title="Remove item">&times;</button>' +
            '</div>' +
            '<div class="li-grid">' +
              '<div class="li-field">' +
                '<label>Product / Title</label>' +
                '<div class="li-search-wrap">' +
                  '<input type="text" name="item' + i + '_title" class="li-input li-title-input" required autocomplete="off" placeholder="Search products or type custom name..." />' +
                  '<span class="li-search-icon">' + svgSearch + '</span>' +
                  '<div class="li-dropdown"></div>' +
                '</div>' +
                '<div class="li-chip-area"></div>' +
              '</div>' +
              '<div class="li-row-bottom">' +
                '<div class="li-field">' +
                  '<label>Unit Price</label>' +
                  '<input type="text" name="item' + i + '_price" class="li-input li-price-input" required placeholder="0.00" />' +
                '</div>' +
                '<div class="li-field">' +
                  '<label>Quantity</label>' +
                  '<input type="number" name="item' + i + '_qty" class="li-input li-qty-input" value="1" min="1" required />' +
                '</div>' +
                '<div class="li-field">' +
                  '<label>Line Total</label>' +
                  '<div class="li-line-total">$0.00</div>' +
                '</div>' +
              '</div>' +
            '</div>';
          container.appendChild(row);
          wireSearch(row);
          var rmBtn = row.querySelector('.li-remove');
          if (rmBtn) rmBtn.addEventListener('click', function() { row.remove(); renumberRows(); recalcTotals(); });
          row.querySelector('.li-title-input').focus();
        });
      }
    })();
    </script>
    `

    res.send(
      sellerLayout({
        title: `Draft #${orderNum}`,
        storeName: store.name,
        storeSlug: store.slug,
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
        storeRole: user.storeRole,
        activePage: 'orders',
        content,
        theme: theme as 'dark' | 'light',
      }),
    )
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /orders/drafts/:id/update — Update draft order
// ---------------------------------------------------------------------------

export async function postDraftOrderUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const orderId = req.params.id
  const body = req.body

  try {
    // Verify the order exists and is still a draft
    const order = await db
      .selectFrom('orders')
      .select(['id', 'financial_status', 'shop_id'])
      .where('id', '=', orderId)
      .where('shop_id', '=', store.id)
      .where('financial_status', '=', 'pending')
      .executeTakeFirst()

    if (!order) {
      res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Draft order not found')}`)
      return
    }

    // Resolve email from customer_id if needed
    let email = body.email || null
    if (!email && body.customer_id) {
      try {
        const cust = await db
          .selectFrom('customers')
          .select(['email'])
          .where('id', '=', body.customer_id)
          .where('shop_id', '=', store.id)
          .executeTakeFirst()
        if (cust?.email) email = cust.email
      } catch { /* ok */ }
    }

    // Build line items
    const lineItems: Array<{ title: string; price: string; quantity: number }> = []
    for (let i = 1; i <= 20; i++) {
      const title = body[`item${i}_title`]
      const price = body[`item${i}_price`]
      const qty = parseInt(body[`item${i}_qty`] || '1', 10)
      if (title && price) {
        lineItems.push({ title, price: String(parseFloat(price).toFixed(2)), quantity: Math.max(1, qty) })
      }
    }

    // Build tags
    const tags = (body.tags || 'draft')
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean)
    if (!tags.includes('draft')) tags.unshift('draft')

    // Build shipping
    const shippingAddress = body.shipping_address1 ? {
      address1: body.shipping_address1,
      city: body.shipping_city || null,
      province: body.shipping_province || null,
      zip: body.shipping_zip || null,
      country: body.shipping_country || 'US',
    } : null

    // Calculate totals
    const subtotal = lineItems.reduce((sum, li) => sum + parseFloat(li.price) * li.quantity, 0)

    // Update order
    await db
      .updateTable('orders')
      .set({
        customer_id: body.customer_id || null,
        email,
        note: body.note || null,
        tags: tags as any,
        shipping_address: shippingAddress ? JSON.stringify(shippingAddress) as any : null,
        subtotal_price: subtotal.toFixed(2),
        total_price: subtotal.toFixed(2),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', orderId)
      .execute()

    // Replace line items — delete old, insert new
    await db.deleteFrom('order_line_items').where('order_id', '=', orderId).execute()
    if (lineItems.length > 0) {
      await db
        .insertInto('order_line_items')
        .values(lineItems.map((li) => ({
          order_id: orderId,
          title: li.title,
          price: li.price,
          quantity: li.quantity,
        })))
        .execute()
    }

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'draft_order_updated',
      title: `Draft order updated`,
      message: byActor(user),
      resourceType: 'order',
      resourceId: orderId,
    })

    res.redirect(`/admin/store/${store.slug}/orders/drafts/${orderId}?success=updated`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/orders/drafts/${orderId}?error=${encodeURIComponent(err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// GET /orders/drafts/export — Stream a CSV of draft orders
//
// Dedicated endpoint because the shared orders exporter in core excludes
// any row tagged 'draft' (merchants rarely want drafts in a generic "all
// orders" export). This endpoint does the opposite: it only returns draft
// and completed-draft rows, matching the Draft Orders list page.
// ---------------------------------------------------------------------------

export async function getDraftOrdersExport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser

  try {
    const rows = await (db.selectFrom('orders') as any)
      .select([
        'id',
        'order_number',
        'email',
        'created_at',
        'financial_status',
        'total_price',
        'subtotal_price',
        'currency',
        'note',
        'tags',
      ])
      .where('shop_id', '=', store.id)
      .where(sql<boolean>`(
        COALESCE(tags, ARRAY[]::text[]) @> ARRAY['draft']::text[]
        OR COALESCE(tags, ARRAY[]::text[]) @> ARRAY['completed-draft']::text[]
      )`)
      .orderBy('created_at', 'desc')
      .execute()

    // Build CSV
    const escCsv = (v: any): string => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }

    const header = [
      'Order',
      'Date',
      'Email',
      'Status',
      'Financial status',
      'Subtotal',
      'Total',
      'Currency',
      'Note',
      'Tags',
    ].join(',')

    const lines = rows.map((r: any) => {
      const tags: string[] = Array.isArray(r.tags) ? r.tags : []
      const status = tags.includes('completed-draft')
        ? 'Complete'
        : tags.includes('invoice-sent')
          ? 'Invoice sent'
          : 'Open'
      const orderNum = r.order_number ? `#D${r.order_number}` : `#D${String(r.id).slice(0, 8)}`
      const date = new Date(r.created_at as string).toISOString()
      return [
        orderNum,
        date,
        r.email || '',
        status,
        r.financial_status || '',
        r.subtotal_price || '0.00',
        r.total_price || '0.00',
        r.currency || 'USD',
        r.note || '',
        tags.join('|'),
      ].map(escCsv).join(',')
    })

    const csv = [header, ...lines].join('\n') + '\n'
    const filename = `${store.slug}-draft-orders-${new Date().toISOString().slice(0, 10)}.csv`

    notify(db, {
      shopId: store.id,
      userId: user?.id ?? null,
      type: 'draft_orders_exported',
      title: `Exported ${rows.length} draft order${rows.length === 1 ? '' : 's'} (CSV)`,
      message: byActor(user),
      resourceType: 'order_export',
      resourceId: null,
    })

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csv)
  } catch (err: any) {
    console.error('[draft-orders] export failed:', err?.message)
    res.redirect(`/admin/store/${store.slug}/orders/drafts?error=${encodeURIComponent('Export failed: ' + err.message)}`)
  }
}
