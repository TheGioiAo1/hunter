/**
 * Store Admin — Alerts page (Phase 9 PR4).
 *
 * Two panels on the same route:
 *   1. Alert feed — unread/all/dismissed tabs, mark read, dismiss, mark-all-read.
 *   2. Alert preferences — per-event (via_email / via_inapp) toggles.
 *
 * Iron rule 5 compliance: dispatch errors surface as "Please contact
 * Gbox support" copy. No god-admin mentions anywhere on this page.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { logSellerAction } from '../middleware/store-auth.js'
import {
  ALERT_EVENT_CATALOG,
  listAlerts,
  listPreferences,
  markAlertRead,
  markAllAlertsRead,
  dismissAlert,
  upsertPreference,
  resolvePreference,
  type AlertSeverity,
} from '@gbox/core/modules/staff/alerts.js'

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 16)
  } catch {
    return '—'
  }
}

function severityBadge(s: AlertSeverity | string): string {
  const cls = s === 'critical' ? 'badge-danger' : s === 'warning' ? 'badge-warning' : 'badge-info'
  return `<span class="badge ${cls}">${esc(s)}</span>`
}

function banner(kind: 'ok' | 'error', msg: string): string {
  const bg = kind === 'ok' ? 'var(--success-bg,#0f5132)' : 'var(--danger-bg,#842029)'
  const color = kind === 'ok' ? 'var(--success-text,#d1e7dd)' : 'var(--danger-text,#f8d7da)'
  return `<div style="padding:10px 14px;border-radius:6px;background:${bg};color:${color};margin-bottom:16px">${esc(msg)}</div>`
}

// ---------------------------------------------------------------------------
// GET /settings/alerts
// ---------------------------------------------------------------------------

export async function getAlertsSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const tab = typeof req.query.tab === 'string' && ['unread', 'all', 'dismissed'].includes(req.query.tab)
    ? (req.query.tab as 'unread' | 'all' | 'dismissed')
    : 'unread'
  const saved = typeof req.query.saved === 'string' ? req.query.saved : null
  const errMsg = typeof req.query.err === 'string' ? req.query.err : null

  const [alerts, preferences] = await Promise.all([
    listAlerts(db as any, { shop_id: store.id, user_id: user.id, status: tab, limit: 100 }),
    listPreferences(db as any, user.id, store.id),
  ])
  const prefsByEvent = new Map(preferences.map((p) => [p.event_type, p]))

  const flashBanner = saved
    ? banner('ok', saved === 'prefs' ? 'Preferences saved.' : saved === 'read' ? 'Marked read.' : 'Saved.')
    : errMsg
      ? banner('error', decodeURIComponent(errMsg))
      : ''

  const tabLink = (name: string, label: string) => {
    const active = tab === name
    return `<a href="${base}/settings/alerts?tab=${name}" style="padding:8px 14px;text-decoration:none;border-bottom:2px solid ${active ? 'var(--accent)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--text-secondary)'};font-weight:${active ? '600' : '400'}">${esc(label)}</a>`
  }

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Alerts</h1>
        <p class="page-subtitle"><a href="${base}/settings" style="color:var(--accent);text-decoration:none">Settings</a> / Alerts</p>
      </div>
    </div>

    ${flashBanner}

    <div class="card">
      <div class="card-header" style="padding:0;background:var(--bg-secondary)">
        <div style="display:flex;gap:0;padding:0 8px">
          ${tabLink('unread', `Unread (${tab === 'unread' ? alerts.length : ''}${tab === 'unread' ? '' : ''})`)}
          ${tabLink('all', 'All')}
          ${tabLink('dismissed', 'Dismissed')}
        </div>
      </div>
      <div class="card-body" style="padding:0">
        ${alerts.length === 0
          ? `<div style="padding:24px;text-align:center;color:var(--text-secondary)">No alerts here.</div>`
          : `<table style="width:100%;border-collapse:collapse">
               <thead>
                 <tr style="background:var(--bg-secondary);text-align:left">
                   <th style="padding:10px 14px">When</th>
                   <th style="padding:10px 14px">Severity</th>
                   <th style="padding:10px 14px">Event</th>
                   <th style="padding:10px 14px">Message</th>
                   <th style="padding:10px 14px">Actions</th>
                 </tr>
               </thead>
               <tbody>
                 ${alerts.map((a) => {
                   const unread = !a.read_at
                   return `
                     <tr style="border-top:1px solid var(--border);${unread ? 'background:rgba(13,110,253,0.04)' : ''}">
                       <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px">${fmtDateTime(a.created_at)}</td>
                       <td style="padding:10px 14px">${severityBadge(a.severity)}</td>
                       <td style="padding:10px 14px;font-size:12px;color:var(--text-secondary)">${esc(a.event_type)}</td>
                       <td style="padding:10px 14px">
                         <strong style="font-size:13px">${esc(a.title)}</strong>
                         <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${esc(a.message)}</div>
                         ${a.link ? `<a href="${esc(a.link)}" style="font-size:12px;color:var(--accent);text-decoration:none">Open →</a>` : ''}
                       </td>
                       <td style="padding:10px 14px;white-space:nowrap">
                         ${unread ? `
                           <form method="POST" action="${base}/settings/alerts/${esc(a.id)}/read" style="display:inline">
                             ${csrfHiddenField((req as any).csrfToken || '')}
                             <button type="submit" class="btn btn-sm btn-secondary">Mark read</button>
                           </form>
                         ` : ''}
                         ${a.dismissed_at ? '' : `
                           <form method="POST" action="${base}/settings/alerts/${esc(a.id)}/dismiss" style="display:inline">
                             ${csrfHiddenField((req as any).csrfToken || '')}
                             <button type="submit" class="btn btn-sm btn-secondary">Dismiss</button>
                           </form>
                         `}
                       </td>
                     </tr>
                   `
                 }).join('')}
               </tbody>
             </table>
             ${tab === 'unread' && alerts.length > 0 ? `
               <div style="padding:12px 16px;border-top:1px solid var(--border);text-align:right">
                 <form method="POST" action="${base}/settings/alerts/read-all" style="display:inline">
                   ${csrfHiddenField((req as any).csrfToken || '')}
                   <button type="submit" class="btn btn-sm btn-secondary">Mark all read</button>
                 </form>
               </div>
             ` : ''}`}
      </div>
    </div>

    <form method="POST" action="${base}/settings/alerts/preferences" class="card" style="margin-top:24px">
      ${csrfHiddenField((req as any).csrfToken || '')}
      <div class="card-header"><span>Alert preferences</span></div>
      <div class="card-body" style="padding:0">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--bg-secondary);text-align:left">
              <th style="padding:10px 14px">Event</th>
              <th style="padding:10px 14px;text-align:center">Email</th>
              <th style="padding:10px 14px;text-align:center">In-app</th>
            </tr>
          </thead>
          <tbody>
            ${ALERT_EVENT_CATALOG.map((evt) => {
              const pref = prefsByEvent.get(evt.key)
              const eff = resolvePreference(pref ? { via_email: pref.via_email, via_inapp: pref.via_inapp } : null, evt.key)
              return `
                <tr style="border-top:1px solid var(--border)">
                  <td style="padding:10px 14px">
                    <strong style="font-size:13px">${esc(evt.label)}</strong>
                    <div style="font-size:11px;color:var(--text-secondary)">${esc(evt.description)}</div>
                  </td>
                  <td style="padding:10px 14px;text-align:center">
                    <input type="hidden" name="event_keys[]" value="${esc(evt.key)}">
                    <input type="checkbox" name="email__${esc(evt.key)}" ${eff.via_email ? 'checked' : ''}>
                  </td>
                  <td style="padding:10px 14px;text-align:center">
                    <input type="checkbox" name="inapp__${esc(evt.key)}" ${eff.via_inapp ? 'checked' : ''}>
                  </td>
                </tr>
              `
            }).join('')}
          </tbody>
        </table>
        <div style="padding:12px 16px;border-top:1px solid var(--border);text-align:right">
          <button type="submit" class="btn btn-primary">Save preferences</button>
        </div>
      </div>
    </form>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Alerts',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    theme: theme as 'dark' | 'light',
    activePage: 'settings',
    content,
  }))
}

// ---------------------------------------------------------------------------
// POST /settings/alerts/:id/read
// ---------------------------------------------------------------------------

export async function postAlertRead(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  try {
    await markAlertRead(db as any, String(req.params.id), store.id, user.id)
  } catch {
    // silently swallow — the alert will just stay unread, no user-facing action blocked
  }
  res.redirect(`${base}/settings/alerts?saved=read`)
}

// ---------------------------------------------------------------------------
// POST /settings/alerts/:id/dismiss
// ---------------------------------------------------------------------------

export async function postAlertDismiss(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  try {
    await dismissAlert(db as any, String(req.params.id), store.id, user.id)
  } catch {
    // swallow
  }
  res.redirect(`${base}/settings/alerts?saved=read`)
}

// ---------------------------------------------------------------------------
// POST /settings/alerts/read-all
// ---------------------------------------------------------------------------

export async function postAlertsReadAll(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  await markAllAlertsRead(db as any, store.id, user.id)
  res.redirect(`${base}/settings/alerts?saved=read`)
}

// ---------------------------------------------------------------------------
// POST /settings/alerts/preferences
// ---------------------------------------------------------------------------

export async function postAlertPreferences(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  try {
    const bodyKeys: string[] = Array.isArray(req.body?.['event_keys[]'])
      ? (req.body['event_keys[]'] as string[])
      : Array.isArray(req.body?.event_keys)
        ? (req.body.event_keys as string[])
        : typeof req.body?.event_keys === 'string'
          ? [req.body.event_keys as string]
          : []

    for (const evt of ALERT_EVENT_CATALOG) {
      if (!bodyKeys.includes(evt.key)) continue
      const via_email = Boolean(req.body?.[`email__${evt.key}`])
      const via_inapp = Boolean(req.body?.[`inapp__${evt.key}`])
      await upsertPreference(db as any, {
        user_id: user.id,
        shop_id: store.id,
        event_type: evt.key,
        via_email,
        via_inapp,
      })
    }

    logSellerAction(db as any, req, 'update', 'staff_alert_preferences', user.id, {
      event_count: bodyKeys.length,
    })

    res.redirect(`${base}/settings/alerts?saved=prefs`)
  } catch {
    res.redirect(`${base}/settings/alerts?err=${encodeURIComponent('Please contact Gbox support.')}`)
  }
}
