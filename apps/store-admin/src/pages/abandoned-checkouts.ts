/**
 * Store Admin — Abandoned Checkouts (ShopBase parity)
 *
 * This page is ONLY a statistics view. Recovery is driven by two separate
 * tools in Marketing & Sales:
 *   • Email Marketing  → sends abandoned-cart recovery emails
 *   • SMS Marketing    → sends abandoned-cart recovery SMS
 *
 * Each row shows the status of those deliveries (Email status, SMS status)
 * and the outcome (Recovery status: Lost / In progress / Recovered).
 *
 * Filters: Search, Date range, Email status, SMS status, Recovery status.
 *
 * Until the marketing tools are live, email/sms status columns default to
 * "Not sent" and recovery status is derived purely from checkout state.
 */

import type { Request, Response } from 'express'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstStr(v: any): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

function computeCartTotal(cart: any): number {
  if (!Array.isArray(cart)) return 0
  return cart.reduce((sum: number, it: any) => {
    const price = parseFloat(String(it?.price ?? it?.unit_price ?? 0)) || 0
    const qty = parseInt(String(it?.quantity ?? it?.qty ?? 1), 10) || 1
    return sum + price * qty
  }, 0)
}

/** Recovery status derived from checkout state.
 *  Once the marketing tools are wired up, 'in_progress' will include
 *  checkouts where we sent a recovery email/SMS but haven't seen a
 *  completed order yet. */
function deriveRecoveryStatus(state: string): 'lost' | 'recovered' | 'in_progress' {
  if (state === 'completed') return 'recovered'
  if (state === 'abandoned' || state === 'expired') return 'lost'
  return 'in_progress' // 'open'
}

function recoveryBadge(s: 'lost' | 'recovered' | 'in_progress'): { label: string; cls: string } {
  if (s === 'recovered') return { label: 'Recovered', cls: 'badge-success' }
  if (s === 'in_progress') return { label: 'In progress', cls: 'badge-info' }
  return { label: 'Lost', cls: 'badge-danger' }
}

function statusBadge(s: string): string {
  // Email/SMS columns — until marketing tools exist, always "Not sent"
  const label = s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
  const cls =
    s === 'sent' || s === 'delivered' || s === 'opened' || s === 'clicked'
      ? 'badge-success'
      : s === 'bounced' || s === 'failed'
        ? 'badge-danger'
        : 'badge-muted'
  return `<span class="badge ${cls}" style="font-size:11px">${esc(label)}</span>`
}

// ---------------------------------------------------------------------------
// GET /orders/abandoned — Abandoned checkouts list (ShopBase layout)
// ---------------------------------------------------------------------------

export async function getAbandonedCheckouts(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`

  // No local DB → BE chưa có endpoint abandoned-checkouts (chỉ có insert-temp
  // cho draft orders, KHÔNG track checkout_sessions). Render empty state với
  // banner pending BE. TODO: BE team cần thêm:
  //   GET /api/{shop_id}/abandoned-checkouts (Authorize)
  //     query: page, limit, date_from, date_to, recovery_status
  //     response: { data: CheckoutSession[], pagination }
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    const content = `
      <div style="max-width:1100px;margin:0 auto;padding-bottom:80px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <h1 style="margin:0;font-size:20px;font-weight:600;color:var(--s-text)">🛒 Abandoned checkouts</h1>
        </div>
        <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.4);border-radius:8px;padding:10px 14px;margin-bottom:18px;color:var(--s-text);font-size:12px;line-height:1.5">
          <strong style="color:#f59e0b">⚠ Pending BE</strong> — Cần endpoint <code>/api/{shop_id}/abandoned-checkouts</code> trong BE Order Service. Hiện tại đang phụ thuộc local DB <code>checkout_sessions</code>.
        </div>
        <div style="background:var(--s-card);border:1px solid var(--s-border);border-radius:12px;padding:48px 24px;text-align:center;box-shadow:var(--s-shadow)">
          <div style="font-size:48px;margin-bottom:14px;opacity:.5">🛒</div>
          <h2 style="margin:0 0 8px;font-size:16px;font-weight:600;color:var(--s-text)">No abandoned checkouts</h2>
          <p style="margin:0 auto;max-width:480px;font-size:13px;color:var(--s-text-muted);line-height:1.5">When customers add items to cart but don't complete checkout, they appear here so you can recover the sale via email/SMS.</p>
        </div>
      </div>
    `
    res.send(sellerLayout({
      title: 'Abandoned checkouts',
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
    return
  }

  // ── Query params (filter + pagination) ────────────────────────────
  const search = (firstStr(req.query.q) || '').trim()
  const dateFrom = firstStr(req.query.date_from) || ''
  const dateTo = firstStr(req.query.date_to) || ''
  const emailStatus = firstStr(req.query.email_status) || '' // '', not_sent, sent, opened, clicked, bounced
  const smsStatus = firstStr(req.query.sms_status) || ''     // '', not_sent, sent, delivered, failed
  const recoveryStatus = firstStr(req.query.recovery) || ''  // '', lost, in_progress, recovered

  const page = Math.max(1, parseInt(firstStr(req.query.page) || '1', 10) || 1)
  const perPage = Math.max(10, Math.min(200, parseInt(firstStr(req.query.per) || '25', 10) || 25))
  const offset = (page - 1) * perPage

  // Build URL helper — preserves current filters
  const buildUrl = (overrides: Record<string, string | number | undefined | null>): string => {
    const params = new URLSearchParams()
    const current: Record<string, string> = {
      q: search,
      date_from: dateFrom,
      date_to: dateTo,
      email_status: emailStatus,
      sms_status: smsStatus,
      recovery: recoveryStatus,
      per: String(perPage),
      page: String(page),
    }
    const merged: Record<string, string | number | undefined | null> = { ...current, ...overrides }
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined || v === null || v === '') continue
      params.set(k, String(v))
    }
    const qs = params.toString()
    return `${base}/orders/abandoned${qs ? '?' + qs : ''}`
  }

  // ── Base query: all checkout_sessions for this shop ───────────────
  // We pull everything except 'completed' as "abandoned candidates".
  // 'completed' rows stay visible only if the Recovery filter explicitly
  // asks for "Recovered" (those are the wins we want to celebrate).
  //
  // States map from Recovery filter:
  //   recovered  → ['completed']
  //   lost       → ['abandoned','expired']
  //   in_progress→ ['open']
  //   (default)  → ['abandoned','expired','completed']
  const statesForFilter: readonly ('open' | 'abandoned' | 'expired' | 'completed')[] =
    recoveryStatus === 'recovered'
      ? ['completed']
      : recoveryStatus === 'lost'
        ? ['abandoned', 'expired']
        : recoveryStatus === 'in_progress'
          ? ['open']
          : ['abandoned', 'expired', 'completed']

  // Search: when the user typed something, we resolve the matching
  // customer IDs first (by email / first_name / last_name / phone) and
  // then use that set in the main query. Fewer round-trips than a JOIN
  // on every page render, and supports the short-id fall-through too.
  let searchCustomerIds: string[] = []
  const searchLike = search ? `%${search.toLowerCase()}%` : ''
  if (search) {
    const custHits = await db
      .selectFrom('customers')
      .select('id')
      .where('shop_id', '=', store.id)
      .where((eb) =>
        eb.or([
          eb(sql`lower(email)` as any, 'like', searchLike as any),
          eb(sql`lower(first_name)` as any, 'like', searchLike as any),
          eb(sql`lower(last_name)` as any, 'like', searchLike as any),
          eb(sql`lower(phone)` as any, 'like', searchLike as any),
        ]),
      )
      .limit(500)
      .execute()
    searchCustomerIds = custHits.map((c: any) => c.id)
  }

  // A single helper so list + count queries stay in perfect sync.
  // Any WHERE added here applies to BOTH queries.
  const applyFilters = <T>(qb: any): any => {
    let q = qb.where('shop_id', '=', store.id).where('state', 'in', statesForFilter)
    if (dateFrom) q = q.where('updated_at', '>=', dateFrom + 'T00:00:00')
    if (dateTo) q = q.where('updated_at', '<=', dateTo + 'T23:59:59')
    if (search) {
      // Match checkout id (prefix) OR customer_id ∈ searchCustomerIds.
      // If there are zero customer hits AND the search doesn't look like
      // a checkout id, we still return nothing via the id condition — the
      // IN (empty) case is handled by passing a sentinel that can't match.
      q = q.where((eb: any) =>
        eb.or([
          eb(sql`lower(id::text)` as any, 'like', searchLike as any),
          eb(
            'customer_id',
            'in',
            searchCustomerIds.length > 0
              ? searchCustomerIds
              : ['00000000-0000-0000-0000-000000000000'],
          ),
        ]),
      )
    }
    return q
  }

  const [rows, countRow] = await Promise.all([
    applyFilters(db.selectFrom('checkout_sessions').selectAll())
      .orderBy('updated_at', 'desc')
      .limit(perPage)
      .offset(offset)
      .execute(),
    applyFilters(
      db.selectFrom('checkout_sessions').select(db.fn.countAll<number>().as('count')),
    ).executeTakeFirstOrThrow(),
  ])

  const total = Number(countRow.count)
  const checkouts = rows as any[]

  // Resolve customer emails in one batch for the PLACED BY column.
  const customerIds = Array.from(
    new Set(checkouts.map((c) => c.customer_id).filter(Boolean)),
  ) as string[]
  let customerMap: Record<string, string> = {}
  if (customerIds.length > 0) {
    const custRows = await db
      .selectFrom('customers')
      .select(['id', 'email', 'first_name', 'last_name'])
      .where('id', 'in', customerIds)
      .execute()
    customerMap = Object.fromEntries(
      custRows.map((c: any) => {
        const label = c.email || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer'
        return [c.id, label]
      }),
    )
  }

  // `filteredCheckouts` is just an alias now — all filtering happens in SQL.
  const filteredCheckouts = checkouts

  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const fromIdx = total === 0 ? 0 : offset + 1
  const toIdx = Math.min(offset + perPage, total)

  // ── Table rows ───────────────────────────────────────────────────
  const tableRows =
    filteredCheckouts.length === 0
      ? '' // empty state rendered separately
      : filteredCheckouts
          .map((c: any) => {
            const shortId = String(c.id).slice(0, 8).toUpperCase()
            const checkoutLabel = `#C${shortId}`
            const date = new Date(c.updated_at || c.created_at)
            const dateStr = date.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
            const placedBy = c.customer_id
              ? customerMap[c.customer_id] || 'Customer'
              : 'Guest'
            const cartTotal = computeCartTotal(c.cart_json)
            const recovery = recoveryBadge(deriveRecoveryStatus(c.state))

            // NOTE: No /orders/abandoned/:id detail route exists yet — the row
            // label is displayed as plain text. When a detail page is added,
            // wrap this in an <a href="${base}/orders/abandoned/${esc(c.id)}"> again.
            return `
              <tr class="ac-row" data-id="${esc(c.id)}">
                <td style="padding:12px 16px">
                  <span
                     style="color:var(--s-text-primary);font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
                    ${esc(checkoutLabel)}
                  </span>
                </td>
                <td style="padding:12px 16px;color:var(--s-text-muted);font-size:13px">${dateStr}</td>
                <td style="padding:12px 16px">
                  ${
                    placedBy === 'Guest'
                      ? '<span style="color:var(--s-text-muted)">Guest</span>'
                      : esc(placedBy)
                  }
                </td>
                <td style="padding:12px 16px">${statusBadge('not_sent')}</td>
                <td style="padding:12px 16px">${statusBadge('not_sent')}</td>
                <td style="padding:12px 16px">
                  <span class="badge ${recovery.cls}">${esc(recovery.label)}</span>
                </td>
                <td style="padding:12px 16px;text-align:right;font-weight:600">
                  $${cartTotal.toFixed(2)}
                </td>
              </tr>
            `
          })
          .join('')

  // ── Dropdown options for filters ─────────────────────────────────
  const emailOptions = [
    { v: '', l: 'All' },
    { v: 'not_sent', l: 'Not sent' },
    { v: 'sent', l: 'Sent' },
    { v: 'opened', l: 'Opened' },
    { v: 'clicked', l: 'Clicked' },
    { v: 'bounced', l: 'Bounced' },
  ]
  const smsOptions = [
    { v: '', l: 'All' },
    { v: 'not_sent', l: 'Not sent' },
    { v: 'sent', l: 'Sent' },
    { v: 'delivered', l: 'Delivered' },
    { v: 'failed', l: 'Failed' },
  ]
  const recoveryOptions = [
    { v: '', l: 'All' },
    { v: 'lost', l: 'Lost' },
    { v: 'in_progress', l: 'In progress' },
    { v: 'recovered', l: 'Recovered' },
  ]
  const labelFor = (opts: typeof emailOptions, v: string): string =>
    opts.find((o) => o.v === v)?.l || opts[0].l

  // ── Page content ─────────────────────────────────────────────────
  const content = `
    <style>
      /* ShopBase-parity filter bar */
      .ac-filter-bar {
        display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
        padding: 16px; border-bottom: 1px solid var(--s-border);
      }
      .ac-search {
        flex: 1; min-width: 220px; position: relative;
      }
      .ac-search input {
        width: 100%; padding: 8px 12px 8px 34px;
        font-size: 13px; background: var(--s-bg); color: var(--s-text);
        border: 1px solid var(--s-border); border-radius: 8px;
      }
      .ac-search .ac-search-icon {
        position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
        color: var(--s-text-muted); pointer-events: none;
      }
      .ac-menu-wrap { position: relative; }
      .ac-menu-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 8px 12px; font-size: 13px;
        background: var(--s-bg); color: var(--s-text);
        border: 1px solid var(--s-border); border-radius: 8px;
        cursor: pointer; white-space: nowrap;
      }
      .ac-menu-btn:hover { border-color: var(--s-accent); }
      .ac-menu {
        position: absolute; top: calc(100% + 4px); left: 0;
        min-width: 180px; padding: 6px;
        background: var(--s-surface);
        border: 1px solid var(--s-border); border-radius: 8px;
        box-shadow: 0 6px 18px rgba(0,0,0,.25);
        display: none; z-index: 20;
      }
      .ac-menu.open { display: block; }
      .ac-item {
        display: block; padding: 8px 10px; font-size: 13px;
        color: var(--s-text); text-decoration: none; border-radius: 6px;
      }
      .ac-item:hover { background: var(--s-bg); }
      .ac-item.active { background: rgba(99,102,241,.12); color: var(--s-accent); font-weight: 600; }

      /* Empty state — generous vertical breathing room to match ShopBase */
      .ac-empty {
        padding: 96px 24px 120px; text-align: center;
        min-height: 320px;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
      }
      .ac-empty-icon {
        width: 120px; height: 96px; margin: 0 auto 20px;
        display: flex; align-items: center; justify-content: center;
        color: var(--s-text-muted); opacity: .45;
      }
      .ac-empty-title {
        font-size: 14px; font-weight: 500; color: var(--s-text-muted); margin-bottom: 4px;
      }
      .ac-empty-sub {
        font-size: 12px; color: var(--s-text-muted); opacity: .75;
      }

      /* Table */
      .ac-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .ac-table thead tr {
        background: var(--s-bg);
        border-bottom: 1px solid var(--s-border);
      }
      .ac-table th {
        text-align: left; padding: 14px 16px;
        font-size: 11px; font-weight: 600; letter-spacing: .08em;
        text-transform: uppercase; color: var(--s-text-muted);
      }
      .ac-table th.ac-right { text-align: right; }
      .ac-table tbody tr {
        border-bottom: 1px solid var(--s-border);
      }
      .ac-table tbody tr:hover { background: var(--s-bg); }

      /* Empty-state table: headers stay visible but faded (ShopBase parity) */
      .ac-table-empty thead tr {
        background: transparent;
      }
      .ac-table-empty th {
        color: var(--s-text-muted);
        opacity: .55;
        font-weight: 500;
      }
      .ac-table-empty tbody tr {
        border-bottom: none;
      }
      .ac-table-empty tbody tr:hover {
        background: transparent;
      }

      /* Pagination bar */
      .ac-pg-bar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; border-top: 1px solid var(--s-border);
        font-size: 12px; color: var(--s-text-muted);
      }
      .ac-pg-bar a, .ac-pg-bar span.disabled {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border-radius: 6px;
        border: 1px solid var(--s-border); color: var(--s-text);
        text-decoration: none; font-size: 14px; background: var(--s-surface);
      }
      .ac-pg-bar span.disabled { opacity: .4; cursor: not-allowed; }
      .ac-pg-bar a:hover { border-color: var(--s-accent); color: var(--s-accent); }

      .badge-muted {
        background: rgba(148,163,184,.12);
        color: var(--s-text-muted);
        border: 1px solid rgba(148,163,184,.3);
      }
      .badge-info {
        background: rgba(99,102,241,.12);
        color: var(--s-accent);
        border: 1px solid rgba(99,102,241,.3);
      }
    </style>

    <div class="page-header">
      <div>
        <a href="${base}/orders" style="color:var(--s-text-muted);text-decoration:none;font-size:12px;display:inline-flex;align-items:center;gap:4px;margin-bottom:6px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 15l-5-5 5-5"/></svg>
          Orders
        </a>
        <h1 class="page-title" style="margin:0;font-size:22px;font-weight:700">Abandoned Checkouts</h1>
      </div>
      <div>
        <!-- SMS fee history button removed — /marketing/sms/fee-history route
             doesn't exist. Restore when the SMS billing feature ships. -->
      </div>
    </div>

    <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;overflow:hidden">

      <!-- FILTER BAR (matches ShopBase layout) -->
      <div class="ac-filter-bar">
        <div class="ac-search">
          <svg class="ac-search-icon" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="9" r="6"/><path d="m17 17-3.5-3.5"/></svg>
          <form method="get" action="${base}/orders/abandoned" id="acFilterForm" style="display:contents">
            ${dateFrom ? `<input type="hidden" name="date_from" value="${esc(dateFrom)}">` : ''}
            ${dateTo ? `<input type="hidden" name="date_to" value="${esc(dateTo)}">` : ''}
            ${emailStatus ? `<input type="hidden" name="email_status" value="${esc(emailStatus)}">` : ''}
            ${smsStatus ? `<input type="hidden" name="sms_status" value="${esc(smsStatus)}">` : ''}
            ${recoveryStatus ? `<input type="hidden" name="recovery" value="${esc(recoveryStatus)}">` : ''}
            <input type="text" name="q" value="${esc(search)}" placeholder="Search checkouts">
          </form>
        </div>

        <!-- Date range -->
        <div class="ac-menu-wrap">
          <button type="button" class="ac-menu-btn" data-menu="acDateMenu">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="13" rx="1"/><path d="M3 8h14M7 2v4M13 2v4"/></svg>
            <span>${dateFrom || dateTo ? `${esc(dateFrom || '…')} — ${esc(dateTo || '…')}` : 'Date range'}</span>
            <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
          </button>
          <div class="ac-menu" id="acDateMenu" style="min-width:280px;padding:12px" onclick="event.stopPropagation()">
            <form method="get" action="${base}/orders/abandoned" style="display:flex;flex-direction:column;gap:10px">
              ${search ? `<input type="hidden" name="q" value="${esc(search)}">` : ''}
              ${emailStatus ? `<input type="hidden" name="email_status" value="${esc(emailStatus)}">` : ''}
              ${smsStatus ? `<input type="hidden" name="sms_status" value="${esc(smsStatus)}">` : ''}
              ${recoveryStatus ? `<input type="hidden" name="recovery" value="${esc(recoveryStatus)}">` : ''}
              <label style="font-size:11px;color:var(--s-text-muted);font-weight:600;text-transform:uppercase">From
                <input type="date" name="date_from" value="${esc(dateFrom)}" class="input" style="display:block;width:100%;margin-top:6px;padding:6px 8px;font-size:12px;background:var(--s-bg);border:1px solid var(--s-border);color:var(--s-text);border-radius:6px">
              </label>
              <label style="font-size:11px;color:var(--s-text-muted);font-weight:600;text-transform:uppercase">To
                <input type="date" name="date_to" value="${esc(dateTo)}" class="input" style="display:block;width:100%;margin-top:6px;padding:6px 8px;font-size:12px;background:var(--s-bg);border:1px solid var(--s-border);color:var(--s-text);border-radius:6px">
              </label>
              <div style="display:flex;gap:6px;margin-top:4px">
                <button type="submit" class="btn btn-primary btn-sm" style="flex:1">Apply</button>
                ${
                  dateFrom || dateTo
                    ? `<a href="${esc(buildUrl({ date_from: undefined, date_to: undefined, page: undefined }))}" class="btn btn-outline btn-sm" style="flex:1;text-align:center">Clear</a>`
                    : ''
                }
              </div>
            </form>
          </div>
        </div>

        <!-- Email status -->
        <div class="ac-menu-wrap">
          <button type="button" class="ac-menu-btn" data-menu="acEmailMenu">
            <span>Email status${emailStatus ? ': ' + esc(labelFor(emailOptions, emailStatus)) : ''}</span>
            <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
          </button>
          <div class="ac-menu" id="acEmailMenu">
            ${emailOptions
              .map(
                (o) => `
              <a class="ac-item${emailStatus === o.v ? ' active' : ''}" href="${esc(buildUrl({ email_status: o.v || undefined, page: undefined }))}">${esc(o.l)}</a>
            `,
              )
              .join('')}
          </div>
        </div>

        <!-- SMS status -->
        <div class="ac-menu-wrap">
          <button type="button" class="ac-menu-btn" data-menu="acSmsMenu">
            <span>SMS status${smsStatus ? ': ' + esc(labelFor(smsOptions, smsStatus)) : ''}</span>
            <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
          </button>
          <div class="ac-menu" id="acSmsMenu">
            ${smsOptions
              .map(
                (o) => `
              <a class="ac-item${smsStatus === o.v ? ' active' : ''}" href="${esc(buildUrl({ sms_status: o.v || undefined, page: undefined }))}">${esc(o.l)}</a>
            `,
              )
              .join('')}
          </div>
        </div>

        <!-- Recovery status -->
        <div class="ac-menu-wrap">
          <button type="button" class="ac-menu-btn" data-menu="acRecoveryMenu">
            <span>Recovery status${recoveryStatus ? ': ' + esc(labelFor(recoveryOptions, recoveryStatus)) : ''}</span>
            <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8l5 5 5-5"/></svg>
          </button>
          <div class="ac-menu" id="acRecoveryMenu">
            ${recoveryOptions
              .map(
                (o) => `
              <a class="ac-item${recoveryStatus === o.v ? ' active' : ''}" href="${esc(buildUrl({ recovery: o.v || undefined, page: undefined }))}">${esc(o.l)}</a>
            `,
              )
              .join('')}
          </div>
        </div>
      </div>

      <!-- TABLE — headers always visible, empty state overlays the body -->
      <div style="overflow-x:auto">
        <table class="ac-table ${filteredCheckouts.length === 0 ? 'ac-table-empty' : ''}">
          <thead>
            <tr>
              <th>Checkout</th>
              <th>Date</th>
              <th>Placed by</th>
              <th>Email status</th>
              <th>SMS status</th>
              <th>Recovery status</th>
              <th class="ac-right">Total</th>
            </tr>
          </thead>
          ${
            filteredCheckouts.length > 0
              ? `<tbody>${tableRows}</tbody>`
              : (() => {
                  const hasAnyFilter =
                    Boolean(search) ||
                    Boolean(dateFrom) ||
                    Boolean(dateTo) ||
                    Boolean(emailStatus) ||
                    Boolean(smsStatus) ||
                    Boolean(recoveryStatus)
                  const emptyTitle = hasAnyFilter
                    ? 'No abandoned checkouts match your filters'
                    : 'No abandoned checkouts yet'
                  const emptySub = hasAnyFilter
                    ? 'Try clearing filters or widening the date range.'
                    : 'When a customer starts a checkout but doesn\u2019t pay, it\u2019ll show up here.'
                  return `
            <tbody>
              <tr>
                <td colspan="7" style="padding:0;border:0">
                  <div class="ac-empty">
                    <div class="ac-empty-icon">
                      <svg width="120" height="96" viewBox="0 0 120 96" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
                        <path d="M30 40 L60 22 L90 40 L90 78 L30 78 Z" style="fill:var(--s-bg)"/>
                        <path d="M30 40 L60 58 L90 40"/>
                        <path d="M60 58 L60 78"/>
                        <path d="M18 34 L30 40 M102 34 L90 40" stroke-dasharray="3 3"/>
                      </svg>
                    </div>
                    <div class="ac-empty-title">${emptyTitle}</div>
                    <div class="ac-empty-sub">${emptySub}</div>
                  </div>
                </td>
              </tr>
            </tbody>
          `
                })()
          }
        </table>
      </div>

      ${
        filteredCheckouts.length > 0
          ? `
        <div class="ac-pg-bar">
          <span>${fromIdx}–${toIdx} of ${total}</span>
          <div style="display:flex;gap:6px">
            ${
              page > 1
                ? `<a href="${esc(buildUrl({ page: page - 1 }))}">&lsaquo;</a>`
                : '<span class="disabled">&lsaquo;</span>'
            }
            ${
              page < totalPages
                ? `<a href="${esc(buildUrl({ page: page + 1 }))}">&rsaquo;</a>`
                : '<span class="disabled">&rsaquo;</span>'
            }
          </div>
        </div>
      `
          : ''
      }
    </div>

    <script>
      (function(){
        function closeAll() {
          document.querySelectorAll('.ac-menu').forEach(function(m){ m.classList.remove('open') })
        }
        document.querySelectorAll('.ac-menu-btn').forEach(function(btn){
          btn.addEventListener('click', function(e){
            e.preventDefault(); e.stopPropagation();
            var id = btn.getAttribute('data-menu')
            var menu = document.getElementById(id)
            if (!menu) return
            var wasOpen = menu.classList.contains('open')
            closeAll()
            if (!wasOpen) menu.classList.add('open')
          })
        })
        document.addEventListener('click', function(e){
          if (!e.target.closest('.ac-menu-wrap')) closeAll()
        })
        document.addEventListener('keydown', function(e){
          if (e.key === 'Escape') closeAll()
        })

        // Submit search on Enter
        var searchInput = document.querySelector('.ac-search input[name="q"]')
        if (searchInput) {
          searchInput.addEventListener('keydown', function(e){
            if (e.key === 'Enter') {
              e.preventDefault()
              var form = document.getElementById('acFilterForm')
              if (form) form.submit()
            }
          })
        }
      })()
    </script>
  `

  res.send(
    sellerLayout({
      title: 'Abandoned Checkouts',
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
