/**
 * supporter.gbox.co — inbox (ticket queue) page handler.
 *
 * This is the landing page after sign-in. It renders a Messenger-style
 * table of support tickets filtered by the "tab" query param:
 *
 *   ?tab=mine    — tickets assigned to the signed-in agent (default)
 *   ?tab=team    — any unassigned OR assigned-to-others active tickets
 *   ?tab=all     — everything the preset is allowed to see (requires
 *                  `support:audit:cross_shop` or the `_partial` variant)
 *   ?status=open|pending_agent|pending_seller|resolved|closed|any
 *
 * Permissions:
 *   - `support:ticket:read`      — required just to reach the page.
 *   - `support:audit:cross_shop` — unlocks the `tab=all` option. L1 never
 *                                   sees it (redirected to tab=mine).
 *
 * Iron Rule 5: filter labels + error messages go through the layout's
 * `esc()` helper, and NEVER reveal "god admin"-only tabs to a preset
 * that can't see them (the UI omits the link entirely).
 */

import type { Request, Response } from 'express'
import type { SupportStatus } from '@gbox/db/schema/tables.js'
import { listTicketsForAgent } from '@gbox/core/modules/support/index.js'
import {
  canStaff,
  logStaffAction,
} from '@gbox/core/modules/support-staff/index.js'
import { staffLayout, esc } from '../layouts/staff-layout.js'

type Tab = 'mine' | 'team' | 'all'

const VALID_STATUSES: readonly (SupportStatus | 'any')[] = [
  'any',
  'open',
  'pending_agent',
  'pending_seller',
  'resolved',
  'closed',
]

export async function getInbox(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  // Auth is already enforced by the staff-auth middleware; we get here
  // only if req.staffUser is populated. Belt-and-braces null check.
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser

  // Parse query params.
  const tabRaw = typeof req.query.tab === 'string' ? req.query.tab : 'mine'
  const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'any'
  const status = (VALID_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as SupportStatus | 'any')
    : ('any' as const)

  // Tab gating:
  // - "all" requires support:audit:cross_shop.
  // - "team" requires support:audit:cross_shop OR _partial.
  // - "mine" always allowed.
  let tab: Tab = 'mine'
  if (tabRaw === 'all' && canStaff(user, 'support:audit:cross_shop')) {
    tab = 'all'
  } else if (
    tabRaw === 'team' &&
    (canStaff(user, 'support:audit:cross_shop') ||
      canStaff(user, 'support:audit:cross_shop_partial'))
  ) {
    tab = 'team'
  }

  // Ticket query — scope by tab.
  let tickets: Awaited<ReturnType<typeof listTicketsForAgent>>
  try {
    if (tab === 'mine') {
      tickets = await listTicketsForAgent(db, {
        status,
        assignedTo: user.userId,
        limit: 100,
      })
    } else if (tab === 'team') {
      // L2-style view — all active tickets, they'll pick one to claim.
      // Queries.ts doesn't have an "assignedTo != me" filter natively, so
      // fetch the wider set and filter in memory. The cap (100) keeps it
      // cheap; if we exceed it, the user should narrow by status anyway.
      const all = await listTicketsForAgent(db, { status, limit: 200 })
      tickets = all.filter((t) => t.assignedAgentId !== user.userId).slice(0, 100)
    } else {
      tickets = await listTicketsForAgent(db, { status, limit: 100 })
    }
  } catch (err) {
    // Query failure. Log for ops; render empty list with a flash.
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.view',
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { error: (err as Error).message, tab, status },
    }).catch(() => {})
    tickets = []
    return renderError(res, user, 'Failed to load tickets. Please try again.')
  }

  const unreadTotal = tickets.reduce((a, t) => a + (t.unreadByAgentCount ?? 0), 0)

  const showAllTab = canStaff(user, 'support:audit:cross_shop')
  const showTeamTab =
    showAllTab || canStaff(user, 'support:audit:cross_shop_partial')

  // Audit: page view.
  logStaffAction(db, {
    actorUserId: user.userId,
    actorPreset: user.preset,
    action: 'ticket.view',
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] ?? null) as string | null,
    details: { tab, status, count: tickets.length },
  }).catch(() => {})

  const content = renderInbox({
    tickets,
    activeTab: tab,
    activeStatus: status,
    showAllTab,
    showTeamTab,
  })

  res
    .status(200)
    .type('html')
    .send(
      staffLayout({
        title: 'Inbox',
        user,
        activePage: 'inbox',
        content,
        inboxUnread: unreadTotal,
      }),
    )
}

function renderInbox(args: {
  tickets: Awaited<ReturnType<typeof listTicketsForAgent>>
  activeTab: Tab
  activeStatus: SupportStatus | 'any'
  showAllTab: boolean
  showTeamTab: boolean
}): string {
  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'mine', label: 'Assigned to me', show: true },
    { id: 'team', label: 'Team queue', show: args.showTeamTab },
    { id: 'all', label: 'All tickets', show: args.showAllTab },
  ]
  const tabBar = tabs
    .filter((t) => t.show)
    .map((t) => {
      const active = t.id === args.activeTab
      const style = active
        ? 'color:var(--accent);border-bottom:2px solid var(--accent);font-weight:600;'
        : 'color:var(--text-muted);'
      return `<a href="/inbox?tab=${esc(t.id)}" style="${style};padding:10px 14px;display:inline-block;text-decoration:none">${esc(t.label)}</a>`
    })
    .join('')

  const statusFilters = VALID_STATUSES.map((s) => {
    const label =
      s === 'any' ? 'All statuses' : s === 'pending_agent' ? 'Waiting on us' : s === 'pending_seller' ? 'Waiting on seller' : s.charAt(0).toUpperCase() + s.slice(1)
    const sel = s === args.activeStatus ? 'selected' : ''
    return `<option value="${esc(s)}" ${sel}>${esc(label)}</option>`
  }).join('')

  const rows =
    args.tickets.length === 0
      ? `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:40px">No tickets in this view.</td></tr>`
      : args.tickets.map(renderTicketRow).join('')

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
      <div style="border-bottom:1px solid var(--border);flex:1 1 auto">${tabBar}</div>
      <form method="get" action="/inbox" style="display:flex;align-items:center;gap:8px;margin-left:16px">
        <input type="hidden" name="tab" value="${esc(args.activeTab)}">
        <label style="margin:0;color:var(--text-muted);font-size:12px">Status</label>
        <select name="status" onchange="this.form.submit()" style="width:auto;min-width:150px">${statusFilters}</select>
      </form>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th style="width:45%">Subject</th>
          <th>Shop</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Assigned to</th>
          <th>Last activity</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `
}

function renderTicketRow(t: Awaited<ReturnType<typeof listTicketsForAgent>>[number]): string {
  const statusPill = statusToPill(t.status)
  const priorityPill = priorityToPill(t.priority)
  const assigned = t.assignedAgentDisplayName
    ? esc(t.assignedAgentDisplayName)
    : `<span style="color:var(--text-muted)">Unassigned</span>`
  const unreadDot = t.unreadByAgentCount > 0
    ? `<span style="background:var(--accent);color:#fff;border-radius:999px;padding:1px 7px;font-size:10px;margin-left:6px;font-weight:600">${t.unreadByAgentCount}</span>`
    : ''
  const subjectCell = `<a href="/tickets/${esc(t.id)}" style="display:block">
    <div style="font-weight:${t.unreadByAgentCount > 0 ? '600' : '500'};color:var(--text)">${esc(t.subject)}${unreadDot}</div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:2px">Opened by ${esc(t.openerDisplayName)} • ${esc(t.category)}</div>
  </a>`
  return `<tr>
    <td>${subjectCell}</td>
    <td><span style="font-size:12px">${esc(t.shopName)}</span></td>
    <td>${statusPill}</td>
    <td>${priorityPill}</td>
    <td style="font-size:12px">${assigned}</td>
    <td style="font-size:11px;color:var(--text-muted)" title="${esc(t.lastMessageAt)}">${formatRelative(t.lastMessageAt)}</td>
  </tr>`
}

function statusToPill(s: string): string {
  const cls =
    s === 'open' ? 'pill-open'
    : s === 'pending_seller' ? 'pill-pending-s'
    : s === 'pending_agent' ? 'pill-pending-a'
    : s === 'resolved' ? 'pill-resolved'
    : s === 'closed' ? 'pill-closed'
    : 'pill-open'
  const label =
    s === 'pending_agent' ? 'Waiting on us'
    : s === 'pending_seller' ? 'Waiting on seller'
    : s.charAt(0).toUpperCase() + s.slice(1)
  return `<span class="pill ${cls}">${esc(label)}</span>`
}

function priorityToPill(p: string): string {
  const cls =
    p === 'urgent' ? 'pill-urgent'
    : p === 'high' ? 'pill-high'
    : p === 'low' ? 'pill-low'
    : 'pill-normal'
  return `<span class="pill ${cls}">${esc(p)}</span>`
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return esc(iso)
  const deltaS = Math.round((Date.now() - then) / 1000)
  if (deltaS < 60) return 'just now'
  if (deltaS < 3600) return `${Math.round(deltaS / 60)}m ago`
  if (deltaS < 86400) return `${Math.round(deltaS / 3600)}h ago`
  return `${Math.round(deltaS / 86400)}d ago`
}

function renderError(
  res: Response,
  user: NonNullable<Request['staffUser']>,
  message: string,
): void {
  res
    .status(500)
    .type('html')
    .send(
      staffLayout({
        title: 'Inbox',
        user,
        activePage: 'inbox',
        content: '<div></div>',
        flash: { kind: 'err', text: message },
      }),
    )
}
