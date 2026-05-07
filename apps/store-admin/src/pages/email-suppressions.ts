/**
 * Store Admin — Email Suppressions (Phase 14 PR4.B)
 *
 * One page + one POST action:
 *
 *   GET  /admin/store/:slug/settings/email-suppressions
 *        Paginated list of active suppressions for this shop, filterable
 *        by reason (hard_bounce / complaint / manual) and searchable by
 *        email. Headline KPIs across the top — active count, 30-day
 *        hard-bounce delta, 30-day complaint delta.
 *
 *   POST /admin/store/:slug/settings/email-suppressions/:id/unsuppress
 *        Admin action: mark a row unsuppressed (soft delete — sets
 *        unsuppressed_at + unsuppressed_by, preserves the audit row).
 *        Ownership is verified via getSuppressionById({shopId:store.id})
 *        BEFORE calling unsuppress() so a shop can't clear another shop's
 *        suppression by POSTing an arbitrary id.
 *
 * WHY THIS LIVES UNDER /settings AND NOT /reports
 * -----------------------------------------------
 * Shopify puts deliverability lists under Admin → Settings → Notifications
 * → Suppressions. This is an actionable list, not a read-only report —
 * sellers come here to unblock a specific customer ("VIP emailed us
 * from their real inbox after changing ISPs, please unblock"), not just
 * to look at numbers. That pattern matches /settings/* (actions) vs
 * /reports/* (analytics).
 *
 * IRON RULE 5
 * -----------
 * Every query filters by `shop_id = store.id`. Platform-scoped
 * suppressions (shop_id NULL) never appear in this UI; they are
 * god-admin-only and are administered elsewhere. No string output
 * mentions "platform" or "god admin" — the error paths route through
 * a generic "contact Gbox support" helper.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  listSuppressions,
  countActiveSuppressions,
  countRecentByReason,
  unsuppress,
  getSuppressionById,
  type SuppressionReason,
  type SuppressionRow,
} from '@gbox/core/modules/email/suppression.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseReason(raw: unknown): SuppressionReason | 'all' {
  if (raw === 'hard_bounce' || raw === 'complaint' || raw === 'manual') return raw
  return 'all'
}

function reasonLabel(r: SuppressionReason): string {
  switch (r) {
    case 'hard_bounce':
      return 'Hard bounce'
    case 'complaint':
      return 'Spam complaint'
    case 'manual':
      return 'Manual'
  }
}

function reasonTone(r: SuppressionReason): string {
  switch (r) {
    case 'hard_bounce':
      return '#dc2626' // red
    case 'complaint':
      return '#f59e0b' // amber
    case 'manual':
      return '#6b7280' // grey
  }
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtDate(value: string | Date | null): string {
  if (value == null) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function kpiCard(title: string, value: string, sub: string, tone: 'neutral' | 'warn' = 'neutral'): string {
  const color = tone === 'warn' ? '#f59e0b' : 'var(--text-primary)'
  return `
    <div class="card" style="min-height:110px">
      <div class="card-body">
        <div style="font-size:12px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.05em">${esc(title)}</div>
        <div style="font-size:28px;font-weight:700;color:${color};margin-top:6px">${esc(value)}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">${esc(sub)}</div>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// List page: GET /admin/store/:slug/settings/email-suppressions
// ---------------------------------------------------------------------------

export async function getEmailSuppressionsPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`

  const reasonFilter = normaliseReason(req.query.reason)
  const pageSize = 50
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)
  const offset = (page - 1) * pageSize

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbx = db as any

  // API mode (no local DB): page renders empty UI + KPI = 0. Suppression list
  // is stored in local Postgres so there's no way for BE to expose this yet.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  let activeTotal = 0, hardBounceCount = 0, complaintCount = 0, manualCount = 0
  let hardBounce30d = 0, complaint30d = 0
  let rows: SuppressionRow[] = []

  if (hasDb) {
    try {
      ;[activeTotal, hardBounceCount, complaintCount, manualCount, hardBounce30d, complaint30d, rows] =
        await Promise.all([
          countActiveSuppressions(dbx, { shopId: store.id }),
          countActiveSuppressions(dbx, { shopId: store.id, reason: 'hard_bounce' }),
          countActiveSuppressions(dbx, { shopId: store.id, reason: 'complaint' }),
          countActiveSuppressions(dbx, { shopId: store.id, reason: 'manual' }),
          countRecentByReason(dbx, { shopId: store.id, reason: 'hard_bounce', sinceDays: 30 }),
          countRecentByReason(dbx, { shopId: store.id, reason: 'complaint', sinceDays: 30 }),
          listSuppressions(dbx, {
            shopId: store.id,
            limit: pageSize,
            offset,
            reason: reasonFilter === 'all' ? undefined : reasonFilter,
          }),
        ])
    } catch (e: any) {
      console.warn('[email-suppressions] DB read failed:', e?.message)
    }
  }

  // Toast flags — URL-param driven so we don't need session flash.
  const unsuppressed = req.query.unsuppressed === '1'
  const notFound = req.query.err === 'not_found'
  const genericErr = req.query.err === 'generic'

  const toast = unsuppressed
    ? `<div class="card" style="margin-bottom:16px;border-left:3px solid #22c55e">
         <div class="card-body" style="padding:12px 16px;font-size:13px">Address removed from suppression list. New sends will attempt delivery.</div>
       </div>`
    : notFound
    ? `<div class="card" style="margin-bottom:16px;border-left:3px solid #f59e0b">
         <div class="card-body" style="padding:12px 16px;font-size:13px">That suppression row could not be found or is not yours.</div>
       </div>`
    : genericErr
    ? `<div class="card" style="margin-bottom:16px;border-left:3px solid #dc2626">
         <div class="card-body" style="padding:12px 16px;font-size:13px">Something went wrong. Please contact Gbox support.</div>
       </div>`
    : ''

  // Filter chips
  const chip = (value: 'all' | SuppressionReason, label: string, count: number): string => {
    const active = reasonFilter === value
    const href = value === 'all'
      ? `${base}/settings/email-suppressions`
      : `${base}/settings/email-suppressions?reason=${value}`
    return `<a href="${esc(href)}" style="padding:6px 12px;border:1px solid var(--border);border-radius:999px;text-decoration:none;color:${active ? '#fff' : 'var(--text-primary)'};background:${active ? '#2563eb' : 'transparent'};font-size:13px">${esc(label)} · ${fmtInt(count)}</a>`
  }

  const table = rows.length === 0
    ? `<div class="card"><div class="card-body" style="text-align:center;padding:40px;color:var(--text-secondary)">
         <div style="font-size:15px;margin-bottom:4px">No ${reasonFilter === 'all' ? '' : reasonLabel(reasonFilter).toLowerCase() + ' '}suppressions.</div>
         <div style="font-size:13px">Hard bounces and spam complaints will appear here automatically.</div>
       </div></div>`
    : `<div class="card"><div class="card-body" style="padding:0">
         <table style="width:100%;border-collapse:collapse;font-size:13px">
           <thead>
             <tr style="border-bottom:1px solid var(--border);background:var(--bg-secondary)">
               <th style="text-align:left;padding:10px 14px;font-weight:600">Email</th>
               <th style="text-align:left;padding:10px 14px;font-weight:600">Reason</th>
               <th style="text-align:left;padding:10px 14px;font-weight:600">Source</th>
               <th style="text-align:left;padding:10px 14px;font-weight:600">Suppressed</th>
               <th style="text-align:right;padding:10px 14px;font-weight:600">Actions</th>
             </tr>
           </thead>
           <tbody>
             ${rows.map((r: SuppressionRow, i: number) => renderRow(r, i, base, req.csrfToken ?? '')).join('')}
           </tbody>
         </table>
       </div></div>`

  const hasNextPage = rows.length === pageSize
  const pagination = (page > 1 || hasNextPage)
    ? `<div style="display:flex;justify-content:space-between;margin-top:16px">
         ${page > 1 ? `<a href="${base}/settings/email-suppressions?reason=${reasonFilter}&page=${page - 1}" style="padding:6px 12px;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:var(--text-primary);font-size:13px">← Previous</a>` : '<span></span>'}
         <div style="font-size:12px;color:var(--text-secondary);align-self:center">Page ${page}</div>
         ${hasNextPage ? `<a href="${base}/settings/email-suppressions?reason=${reasonFilter}&page=${page + 1}" style="padding:6px 12px;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:var(--text-primary);font-size:13px">Next →</a>` : '<span></span>'}
       </div>`
    : ''

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Email suppressions</h1>
        <p class="page-subtitle">Addresses we've blocked from future sends. Cleared automatically when a customer re-subscribes from the unsubscribe page, or manually here.</p>
      </div>
    </div>

    ${toast}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px">
      ${kpiCard('Total blocked', fmtInt(activeTotal), `${fmtInt(hardBounceCount)} bounces + ${fmtInt(complaintCount)} complaints + ${fmtInt(manualCount)} manual`)}
      ${kpiCard('Hard bounces (30d)', fmtInt(hardBounce30d), 'new this period', hardBounce30d > 0 ? 'warn' : 'neutral')}
      ${kpiCard('Complaints (30d)', fmtInt(complaint30d), 'new this period', complaint30d > 0 ? 'warn' : 'neutral')}
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${chip('all', 'All', activeTotal)}
      ${chip('hard_bounce', 'Hard bounces', hardBounceCount)}
      ${chip('complaint', 'Complaints', complaintCount)}
      ${chip('manual', 'Manual', manualCount)}
    </div>

    ${table}
    ${pagination}

    <p style="font-size:12px;color:var(--text-secondary);margin-top:20px">
      Hard bounces indicate the address is permanently undeliverable. Complaints are spam-folder marks from the recipient's inbox provider. Keeping bounced/complained addresses off your sends protects your sender reputation.
    </p>
  `

  res.send(
    sellerLayout({
      title: 'Email suppressions',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'settings',
      content,
    }),
  )
}

function renderRow(r: SuppressionRow, index: number, base: string, csrfToken: string): string {
  const zebra = index % 2 === 1 ? 'background:var(--bg-secondary)' : ''
  const unsuppressUrl = `${base}/settings/email-suppressions/${r.id}/unsuppress`
  // CSRF via hidden input matches the pattern used by other seller POSTs.
  return `
    <tr style="border-bottom:1px solid var(--border);${zebra}">
      <td style="padding:10px 14px;font-family:monospace;font-size:12px">${esc(r.emailAddressLower)}</td>
      <td style="padding:10px 14px">
        <span style="color:${reasonTone(r.reason)};font-weight:500">${esc(reasonLabel(r.reason))}</span>
        ${r.bounceSubType ? `<span style="color:var(--text-secondary);font-size:11px"> · ${esc(r.bounceSubType)}</span>` : ''}
      </td>
      <td style="padding:10px 14px;color:var(--text-secondary);font-size:12px">${esc(r.sourceTransport)}</td>
      <td style="padding:10px 14px;color:var(--text-secondary);font-size:12px">${esc(fmtDate(r.suppressedAt))}</td>
      <td style="padding:10px 14px;text-align:right">
        <form method="POST" action="${esc(unsuppressUrl)}" style="display:inline" onsubmit="return confirm('Un-block ${esc(r.emailAddressLower)} and allow future sends?')">
          ${csrfHiddenField(csrfToken)}
          <button type="submit" style="padding:4px 10px;border:1px solid var(--border);background:transparent;color:var(--text-primary);border-radius:4px;font-size:12px;cursor:pointer">Unsuppress</button>
        </form>
      </td>
    </tr>
  `
}

// ---------------------------------------------------------------------------
// Action: POST /admin/store/:slug/settings/email-suppressions/:id/unsuppress
// ---------------------------------------------------------------------------

export async function postUnsuppressAction(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const suppressionId = Number.parseInt(String(req.params.id ?? ''), 10)
  if (!Number.isFinite(suppressionId) || suppressionId <= 0) {
    res.redirect(`${base}/settings/email-suppressions?err=not_found`)
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbx = db as any

  // API mode (no local DB): no BE endpoint for suppressions → redirect to generic banner.
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'
  if (!hasDb) {
    res.redirect(`${base}/settings/email-suppressions?err=generic`)
    return
  }

  // Cross-shop guard: verify the row belongs to this store before
  // mutating. Without this check a POST to /unsuppress/42 would clear
  // shop X's suppression even from a session logged into shop Y. The
  // partial-UNIQUE indexes in the schema don't help here — they prevent
  // duplicate inserts, not cross-shop reads.
  const existing = await getSuppressionById(dbx, {
    suppressionId,
    shopId: store.id,
  })
  if (!existing) {
    res.redirect(`${base}/settings/email-suppressions?err=not_found`)
    return
  }

  const result = await unsuppress(dbx, {
    suppressionId,
    unsuppressedBy: user.id ?? null,
    notes: `Unsuppressed via admin UI by ${user.email ?? 'unknown'}`,
  })

  if (!result.ok) {
    res.redirect(`${base}/settings/email-suppressions?err=generic`)
    return
  }

  res.redirect(`${base}/settings/email-suppressions?unsuppressed=1`)
}
