/**
 * Store Admin — Security page (Phase 9 PR4).
 *
 * Displays the staff member's recent sign-in history (last 50) and
 * active sessions. Does NOT gate on 2FA state — that's in the
 * existing 2FA enrollment flow owned by Phase 0.
 *
 * Iron rule 5: every error path surfaces "Please contact Gbox support"
 * with zero god-admin mentions.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { listLoginEvents } from '@gbox/core/modules/staff/login-events.js'

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toISOString().replace('T', ' ').slice(0, 16)
  } catch {
    return '—'
  }
}

function outcomeBadge(o: string): string {
  const cls =
    o === 'success' ? 'badge-success'
      : o === '2fa_required' ? 'badge-info'
      : 'badge-danger'
  return `<span class="badge ${cls}">${esc(o.replace(/_/g, ' '))}</span>`
}

export async function getSecuritySettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const events = await listLoginEvents(db as any, {
    user_id: user.id,
    limit: 50,
  })

  const activeSessions: Array<{
    id: string
    ip: string | null
    ua: string | null
    created: string
    expires: string
    two_fa_verified: boolean
  }> = await (db as any)
    .selectFrom('sessions')
    .select([
      'id',
      'ip_address as ip',
      'user_agent as ua',
      'created_at as created',
      'expires_at as expires',
      'two_fa_verified',
    ])
    .where('user_id', '=', user.id)
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'desc')
    .limit(20)
    .execute()
    .then((rs: any[]) => rs.map((r: any) => ({
      id: String(r.id),
      ip: r.ip ?? null,
      ua: r.ua ?? null,
      created: String(r.created),
      expires: String(r.expires),
      two_fa_verified: Boolean(r.two_fa_verified),
    })))

  const newDeviceCount = events.filter((e) => e.is_new_device && e.outcome === 'success').length
  const failedCount = events.filter((e) => e.outcome !== 'success').length

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Security</h1>
        <p class="page-subtitle"><a href="${base}/settings" style="color:var(--accent);text-decoration:none">Settings</a> / Security</p>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px">
      <div class="card"><div class="card-body">
        <div style="font-size:12px;color:var(--text-secondary)">New-device sign-ins (last 50)</div>
        <div style="font-size:28px;font-weight:600;margin-top:4px">${newDeviceCount}</div>
      </div></div>
      <div class="card"><div class="card-body">
        <div style="font-size:12px;color:var(--text-secondary)">Failed attempts (last 50)</div>
        <div style="font-size:28px;font-weight:600;margin-top:4px">${failedCount}</div>
      </div></div>
      <div class="card"><div class="card-body">
        <div style="font-size:12px;color:var(--text-secondary)">Active sessions</div>
        <div style="font-size:28px;font-weight:600;margin-top:4px">${activeSessions.length}</div>
      </div></div>
    </div>

    <div class="card">
      <div class="card-header"><span>Recent sign-ins</span></div>
      <div class="card-body" style="padding:0">
        ${events.length === 0
          ? '<div style="padding:16px;color:var(--text-secondary)">No sign-in history yet.</div>'
          : `<table style="width:100%;border-collapse:collapse">
               <thead>
                 <tr style="background:var(--bg-secondary);text-align:left">
                   <th style="padding:10px 14px">When</th>
                   <th style="padding:10px 14px">Outcome</th>
                   <th style="padding:10px 14px">IP</th>
                   <th style="padding:10px 14px">Device</th>
                   <th style="padding:10px 14px">Flags</th>
                 </tr>
               </thead>
               <tbody>
                 ${events.map((e) => `
                   <tr style="border-top:1px solid var(--border)">
                     <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px">${fmtDateTime(e.created_at)}</td>
                     <td style="padding:10px 14px">${outcomeBadge(e.outcome)}</td>
                     <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px">${esc(e.ip_address || '—')}</td>
                     <td style="padding:10px 14px;font-size:12px">${esc((e.user_agent || '—').slice(0, 80))}</td>
                     <td style="padding:10px 14px">
                       ${e.is_new_device ? '<span class="badge badge-warning">new device</span>' : ''}
                     </td>
                   </tr>
                 `).join('')}
               </tbody>
             </table>`}
      </div>
    </div>

    <div class="card" style="margin-top:24px">
      <div class="card-header"><span>Active sessions</span></div>
      <div class="card-body" style="padding:0">
        ${activeSessions.length === 0
          ? '<div style="padding:16px;color:var(--text-secondary)">No active sessions.</div>'
          : `<table style="width:100%;border-collapse:collapse">
               <thead>
                 <tr style="background:var(--bg-secondary);text-align:left">
                   <th style="padding:10px 14px">Started</th>
                   <th style="padding:10px 14px">Expires</th>
                   <th style="padding:10px 14px">IP</th>
                   <th style="padding:10px 14px">Device</th>
                   <th style="padding:10px 14px">2FA</th>
                 </tr>
               </thead>
               <tbody>
                 ${activeSessions.map((s) => `
                   <tr style="border-top:1px solid var(--border)">
                     <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px">${fmtDateTime(s.created)}</td>
                     <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px">${fmtDateTime(s.expires)}</td>
                     <td style="padding:10px 14px;font-family:var(--font-mono);font-size:12px">${esc(s.ip || '—')}</td>
                     <td style="padding:10px 14px;font-size:12px">${esc((s.ua || '—').slice(0, 80))}</td>
                     <td style="padding:10px 14px">
                       ${s.two_fa_verified
                         ? '<span class="badge badge-success">verified</span>'
                         : '<span class="badge badge-warning">unverified</span>'}
                     </td>
                   </tr>
                 `).join('')}
               </tbody>
             </table>`}
        <div style="padding:12px 16px;font-size:12px;color:var(--text-secondary);border-top:1px solid var(--border)">
          If you see activity you don't recognise, change your password and <strong>contact Gbox support</strong>.
        </div>
      </div>
    </div>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Security',
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
