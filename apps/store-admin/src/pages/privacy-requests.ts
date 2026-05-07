/**
 * Store Admin — Privacy Requests (Phase 14 PR5)
 *
 * One page + two POST actions:
 *
 *   GET  /admin/store/:slug/settings/privacy-requests
 *        Paginated list of every customer_privacy_requests row for
 *        this shop. Filter by `type` (export / deletion / rectification)
 *        and `status` (pending / processing / ready / completed /
 *        consumed / cancelled / failed). Default sort: newest first.
 *
 *   POST /admin/store/:slug/settings/privacy-requests/:id/cancel
 *        Staff cancels a pending DELETION on behalf of the customer
 *        (e.g. customer called support in a panic). Wraps
 *        `adminCancelDeletion()`, which checks cross-shop ownership
 *        + current status before flipping. Always records
 *        `processor_user_id` + `notes` on the row for the audit trail.
 *
 *   POST /admin/store/:slug/settings/privacy-requests/:id/mark-ready
 *        Staff manually marks a RECTIFICATION as completed — the
 *        deeper "apply the correction to the customer record" flow
 *        is out of scope for PR5 since rectification payloads are
 *        free-form. The UI lets staff acknowledge the request so it
 *        stops showing up in the queue; the actual data edits happen
 *        via the customer-detail page.
 *
 * IRON RULE 5
 * -----------
 *  Every query filters by `shop_id = store.id`. Every error path routes
 *  through `safePrivacyMessage` → 'Please contact Gbox support.' — no
 *  leak of DB text or platform-internal paths. The page never mentions
 *  god admin or `/god-admin/*` routes; if a rectification requires
 *  platform-level action (which should not happen in PR5) the fallback
 *  is "contact Gbox support".
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  listPrivacyRequests,
  adminCancelDeletion,
  getPrivacyRequestById,
  type PrivacyRequestType,
  type PrivacyRequestStatus,
  type PrivacyRequestRow,
} from '@gbox/core/modules/email/privacy-requests.js'

// Kept dep-free so smokes can import it without dragging the whole
// admin server graph (AI SDKs etc.) — same pattern as
// `review-settings-flash.ts`.
export function safePrivacyMessage(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message.toLowerCase()
    if (m.includes('not found')) return 'Privacy request not found.'
    if (m.includes('bad_status') || m.includes('cannot cancel')) {
      return 'This request can no longer be updated from this surface.'
    }
  }
  return 'Please contact Gbox support.'
}

// ---------------------------------------------------------------------------
// Filters + pagination helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50

function normaliseType(raw: unknown): PrivacyRequestType | 'all' {
  if (raw === 'export' || raw === 'deletion' || raw === 'rectification') return raw
  return 'all'
}

function normaliseStatus(raw: unknown): PrivacyRequestStatus | 'all' {
  if (
    raw === 'pending' ||
    raw === 'processing' ||
    raw === 'ready' ||
    raw === 'completed' ||
    raw === 'consumed' ||
    raw === 'cancelled' ||
    raw === 'failed'
  ) {
    return raw
  }
  return 'all'
}

function normalisePage(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(n, 10_000)
}

function typeLabel(t: PrivacyRequestType): string {
  switch (t) {
    case 'export': return 'Data export'
    case 'deletion': return 'Account deletion'
    case 'rectification': return 'Rectification'
  }
}

function statusLabel(s: PrivacyRequestStatus): string {
  switch (s) {
    case 'pending': return 'Pending'
    case 'processing': return 'Processing'
    case 'ready': return 'Ready'
    case 'completed': return 'Completed'
    case 'consumed': return 'Downloaded'
    case 'cancelled': return 'Cancelled'
    case 'failed': return 'Failed'
  }
}

function statusTone(s: PrivacyRequestStatus): string {
  switch (s) {
    case 'pending': return '#f59e0b'     // amber
    case 'processing': return '#3b82f6'  // blue
    case 'ready': return '#10b981'       // teal
    case 'completed':
    case 'consumed': return '#16a34a'    // green
    case 'cancelled': return '#6b7280'   // grey
    case 'failed': return '#dc2626'      // red
  }
}

function formatDate(v: Date | string | null): string {
  if (v == null) return '—'
  try {
    const d = v instanceof Date ? v : new Date(String(v))
    if (Number.isNaN(d.getTime())) return '—'
    return d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
  } catch {
    return '—'
  }
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

function banner(kind: 'ok' | 'error', text: string): string {
  const bg = kind === 'ok' ? 'var(--success-bg,#0f5132)' : 'var(--danger-bg,#842029)'
  const color = kind === 'ok' ? 'var(--success-text,#d1e7dd)' : 'var(--danger-text,#f8d7da)'
  return `<div style="padding:10px 14px;border-radius:6px;background:${bg};color:${color};margin-bottom:16px">${esc(text)}</div>`
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/settings/privacy-requests
// ---------------------------------------------------------------------------

export async function getPrivacyRequestsPage(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const saved = typeof req.query.saved === 'string' ? req.query.saved : null
  const errFlash = typeof req.query.err === 'string' ? req.query.err : null

  const type = normaliseType(req.query.type)
  const status = normaliseStatus(req.query.status)
  const page = normalisePage(req.query.page)

  let rows: PrivacyRequestRow[]
  try {
    rows = await listPrivacyRequests(db as any, {
      shopId: store.id,
      requestType: type === 'all' ? undefined : type,
      status: status === 'all' ? undefined : status,
      limit: PAGE_SIZE + 1, // +1 so we know whether there's a next page
      offset: (page - 1) * PAGE_SIZE,
    })
  } catch (err) {
    res.status(500).send(
      sellerLayout({
        title: 'Privacy requests',
        storeName: store.name,
        storeSlug: store.slug,
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
        storeRole: (user as any).storeRole,
        theme: theme as 'dark' | 'light',
        activePage: 'settings',
        content: banner('error', safePrivacyMessage(err)),
      }),
    )
    return
  }

  const hasNext = rows.length > PAGE_SIZE
  const pageRows = hasNext ? rows.slice(0, PAGE_SIZE) : rows

  const flash = saved
    ? banner(
        'ok',
        saved === 'cancelled'
          ? 'Deletion cancelled.'
          : saved === 'marked-ready'
            ? 'Request marked as completed.'
            : 'Saved.',
      )
    : errFlash
      ? banner('error', decodeURIComponent(errFlash))
      : ''

  const tableRows = pageRows
    .map((r) => {
      const statusColor = statusTone(r.status)
      const canCancel = r.requestType === 'deletion' && r.status === 'pending'
      const canMarkReady =
        r.requestType === 'rectification' &&
        (r.status === 'pending' || r.status === 'processing')
      const cancelForm = canCancel
        ? `
          <form method="POST" action="${base}/settings/privacy-requests/${r.id}/cancel"
                style="display:inline-block;margin:0"
                onsubmit="return confirm('Cancel this deletion on behalf of the customer?')">
            ${csrfHiddenField((req as any).csrfToken || '')}
            <button type="submit" class="btn btn-danger btn-sm">Cancel</button>
          </form>
        `
        : ''
      const markReadyForm = canMarkReady
        ? `
          <form method="POST" action="${base}/settings/privacy-requests/${r.id}/mark-ready"
                style="display:inline-block;margin:0 0 0 6px">
            ${csrfHiddenField((req as any).csrfToken || '')}
            <button type="submit" class="btn btn-primary btn-sm">Mark as done</button>
          </form>
        `
        : ''

      const scheduled =
        r.requestType === 'deletion' && r.scheduledDeletionAt
          ? `<br/><span style="font-size:11px;color:var(--text-muted)">Scheduled: ${esc(formatDate(r.scheduledDeletionAt))}</span>`
          : ''

      return `
        <tr>
          <td style="font-family:monospace;font-size:12px">#${r.id}</td>
          <td>${esc(typeLabel(r.requestType))}</td>
          <td>
            <span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${statusColor}20;color:${statusColor};font-size:11px;font-weight:600">
              ${esc(statusLabel(r.status))}
            </span>
            ${scheduled}
          </td>
          <td style="font-size:12px">${esc(r.customerEmailLower)}</td>
          <td style="font-size:12px">${esc(formatDate(r.requestedAt))}</td>
          <td style="text-align:right">${cancelForm}${markReadyForm}</td>
        </tr>
      `
    })
    .join('')

  const typeFilterOpts = ['all', 'export', 'deletion', 'rectification']
    .map(
      (v) =>
        `<option value="${v}"${type === v ? ' selected' : ''}>${esc(
          v === 'all' ? 'All types' : typeLabel(v as PrivacyRequestType),
        )}</option>`,
    )
    .join('')

  const statusFilterOpts = [
    'all',
    'pending',
    'processing',
    'ready',
    'completed',
    'consumed',
    'cancelled',
    'failed',
  ]
    .map(
      (v) =>
        `<option value="${v}"${status === v ? ' selected' : ''}>${esc(
          v === 'all' ? 'All statuses' : statusLabel(v as PrivacyRequestStatus),
        )}</option>`,
    )
    .join('')

  const qsKeep = new URLSearchParams()
  if (type !== 'all') qsKeep.set('type', type)
  if (status !== 'all') qsKeep.set('status', status)
  const prevHref =
    page > 1
      ? `${base}/settings/privacy-requests?${new URLSearchParams({
          ...Object.fromEntries(qsKeep),
          page: String(page - 1),
        }).toString()}`
      : null
  const nextHref = hasNext
    ? `${base}/settings/privacy-requests?${new URLSearchParams({
        ...Object.fromEntries(qsKeep),
        page: String(page + 1),
      }).toString()}`
    : null

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Privacy requests</h1>
        <p class="page-subtitle">
          <a href="${base}/settings" style="color:var(--accent);text-decoration:none">Settings</a>
          / Privacy requests
        </p>
      </div>
    </div>

    ${flash}

    <div class="card" style="margin-bottom:16px">
      <div class="card-body">
        <form method="GET" action="${base}/settings/privacy-requests"
              style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
            Type
            <select name="type" class="form-select" style="min-width:160px">${typeFilterOpts}</select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
            Status
            <select name="status" class="form-select" style="min-width:160px">${statusFilterOpts}</select>
          </label>
          <button type="submit" class="btn btn-primary btn-sm" style="margin-top:18px">Apply</button>
          ${
            type !== 'all' || status !== 'all'
              ? `<a href="${base}/settings/privacy-requests" class="btn btn-ghost btn-sm" style="margin-top:18px">Clear</a>`
              : ''
          }
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-body" style="padding:0;overflow-x:auto">
        <table class="table" style="margin:0;width:100%">
          <thead>
            <tr>
              <th style="width:80px">ID</th>
              <th style="width:140px">Type</th>
              <th style="width:180px">Status</th>
              <th>Customer email</th>
              <th style="width:200px">Requested</th>
              <th style="width:220px;text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              tableRows
                ? tableRows
                : `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px">No privacy requests ${
                    type !== 'all' || status !== 'all' ? 'match these filters.' : 'yet.'
                  }</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>

    <div style="display:flex;justify-content:space-between;margin-top:16px">
      <div>
        ${
          prevHref
            ? `<a href="${prevHref}" class="btn btn-ghost btn-sm">&larr; Previous</a>`
            : '<span></span>'
        }
      </div>
      <div style="color:var(--text-muted);font-size:12px;align-self:center">
        Page ${page}
      </div>
      <div>
        ${nextHref ? `<a href="${nextHref}" class="btn btn-ghost btn-sm">Next &rarr;</a>` : ''}
      </div>
    </div>
  `

  res.send(
    sellerLayout({
      title: 'Privacy requests',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: (user as any).storeRole,
      theme: theme as 'dark' | 'light',
      activePage: 'settings',
      content,
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/settings/privacy-requests/:id/cancel
// ---------------------------------------------------------------------------

export async function postCancelDeletionAction(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}/settings/privacy-requests`

  const rawId = typeof req.params?.id === 'string' ? parseInt(req.params.id, 10) : NaN
  if (!Number.isFinite(rawId) || rawId <= 0) {
    res.redirect(303, `${base}?err=${encodeURIComponent('Invalid request.')}`)
    return
  }

  const notes =
    typeof req.body?.notes === 'string' && req.body.notes.trim().length > 0
      ? req.body.notes.trim()
      : `Cancelled by staff ${user.email}`

  try {
    // Cross-shop guard — adminCancelDeletion checks shop_id internally
    // but we double-up with getPrivacyRequestById to render consistent
    // "not found" messaging on POST as well as GET.
    const existing = await getPrivacyRequestById(db as any, {
      requestId: rawId,
      shopId: store.id,
    })
    if (!existing) {
      res.redirect(303, `${base}?err=${encodeURIComponent('Privacy request not found.')}`)
      return
    }

    const result = await adminCancelDeletion(db as any, {
      requestId: rawId,
      shopId: store.id,
      processorUserId: user.id,
      notes,
    })
    if (!result.ok) {
      res.redirect(303, `${base}?err=${encodeURIComponent(safePrivacyMessage(new Error(result.error)))}`)
      return
    }
    res.redirect(303, `${base}?saved=cancelled`)
  } catch (err) {
    res.redirect(303, `${base}?err=${encodeURIComponent(safePrivacyMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/settings/privacy-requests/:id/mark-ready
// ---------------------------------------------------------------------------
//
// Used for rectification requests only. Exports + deletions follow the
// worker + finalizer flow — staff shouldn't short-circuit those here.

export async function postMarkReadyAction(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}/settings/privacy-requests`

  const rawId = typeof req.params?.id === 'string' ? parseInt(req.params.id, 10) : NaN
  if (!Number.isFinite(rawId) || rawId <= 0) {
    res.redirect(303, `${base}?err=${encodeURIComponent('Invalid request.')}`)
    return
  }

  try {
    const existing = await getPrivacyRequestById(db as any, {
      requestId: rawId,
      shopId: store.id,
    })
    if (!existing) {
      res.redirect(303, `${base}?err=${encodeURIComponent('Privacy request not found.')}`)
      return
    }
    if (existing.requestType !== 'rectification') {
      res.redirect(
        303,
        `${base}?err=${encodeURIComponent(
          'Only rectification requests can be marked done from this surface.',
        )}`,
      )
      return
    }
    if (existing.status !== 'pending' && existing.status !== 'processing') {
      res.redirect(
        303,
        `${base}?err=${encodeURIComponent('This request is already resolved.')}`,
      )
      return
    }

    await db
      .updateTable('customer_privacy_requests')
      .set({
        status: 'completed',
        processor_user_id: user.id,
        completed_at: new Date(),
      } as any)
      .where('id', '=', rawId)
      .where('shop_id', '=', store.id)
      .execute()

    res.redirect(303, `${base}?saved=marked-ready`)
  } catch (err) {
    res.redirect(303, `${base}?err=${encodeURIComponent(safePrivacyMessage(err))}`)
  }
}
