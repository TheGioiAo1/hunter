/**
 * supporter.gbox.co — single ticket thread (Messenger-style).
 *
 * Routes:
 *   GET  /tickets/:id                 → render thread + composer
 *   POST /tickets/:id/reply           → agent reply (public, visible to seller)
 *   POST /tickets/:id/internal-note   → agent-internal note (invisible to seller, supports @mentions later)
 *   POST /tickets/:id/status          → status change (open/pending/resolved/closed)
 *   POST /tickets/:id/priority        → priority change
 *   POST /tickets/:id/claim           → assign-to-self
 *
 * Permission gates (checked INSIDE the handler, not just via middleware,
 * so a forged POST body still fails):
 *
 *   reply              support:ticket:reply
 *   internal-note      support:ticket:internal_note
 *   status (any)       support:ticket:status_change
 *   status partial     support:ticket:status_change_partial   (L1 — open/pending_* only)
 *   priority           support:ticket:priority_change
 *   claim              support:ticket:claim
 *
 * Iron Rule 5: errors go through `safeMessage()`; HTTP bodies never
 * leak scope names, DB internals, or "god admin" strings. Diagnostic
 * reasons go to `support_audit_log`.
 */

import type { Request, Response } from 'express'
import type { SupportStatus, SupportPriority } from '@gbox/db/schema/tables.js'
import {
  addMessage,
  claimTicket,
  listMessagesForAgent,
  listTicketsForAgent,
  markReadByAgent,
  setPriority,
  setStatus,
  safeMessage,
  SupportError,
} from '@gbox/core/modules/support/index.js'
import {
  canStaff,
  hasPermission,
  logStaffAction,
} from '@gbox/core/modules/support-staff/index.js'
import { staffLayout, esc } from '../layouts/staff-layout.js'

const ALLOWED_STATUSES: readonly SupportStatus[] = [
  'open',
  'pending_agent',
  'pending_seller',
  'resolved',
  'closed',
]

const PARTIAL_STATUSES: readonly SupportStatus[] = [
  'open',
  'pending_agent',
  'pending_seller',
]

const ALLOWED_PRIORITIES: readonly SupportPriority[] = ['low', 'normal', 'high', 'urgent']

// ── GET /tickets/:id ──────────────────────────────────────────────────

export async function getTicket(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  const ticketId = String(req.params.id ?? '')
  if (!ticketId) {
    res.status(404).type('html').send('<p>Not found.</p>')
    return
  }

  // Load ticket metadata via the agent-scoped list query filtered to this id.
  // (listTicketsForAgent returns joins we want; a single ticketId filter works.)
  const ticketRows = await listTicketsForAgent(db, { limit: 1 })
    .then((rs) => rs.filter((r) => r.id === ticketId))
    .catch(() => [])
  // Fallback: if not in the first page, fetch directly.
  let ticket =
    ticketRows[0] ?? (await loadTicketById(db, ticketId).catch(() => null))
  if (!ticket) {
    res.status(404).type('html').send(
      staffLayout({
        title: 'Not found',
        user,
        activePage: 'inbox',
        content: '<p>That ticket could not be found.</p>',
      }),
    )
    return
  }

  // Mark as read for the agent.
  markReadByAgent(db, ticketId).catch(() => {})

  // Load messages.
  const messages = await listMessagesForAgent(db, ticketId).catch(() => [])

  // Permission-based UI state:
  const canReply = canStaff(user, 'support:ticket:reply')
  const canInternal = canStaff(user, 'support:ticket:internal_note')
  const canStatusAny = canStaff(user, 'support:ticket:status_change')
  const canStatusPartial = canStaff(user, 'support:ticket:status_change_partial')
  const canPriority = canStaff(user, 'support:ticket:priority_change')
  const canClaim = canStaff(user, 'support:ticket:claim')

  // Pick which statuses the user is allowed to switch to.
  let allowedNextStatuses: readonly SupportStatus[] = []
  if (canStatusAny) {
    allowedNextStatuses = ALLOWED_STATUSES
  } else if (canStatusPartial) {
    allowedNextStatuses = PARTIAL_STATUSES
  }

  logStaffAction(db, {
    actorUserId: user.userId,
    actorPreset: user.preset,
    action: 'ticket.view',
    targetTicketId: ticketId,
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] ?? null) as string | null,
  }).catch(() => {})

  const flashMsg = typeof req.query.msg === 'string' ? req.query.msg : ''
  const flash =
    flashMsg === 'replied'
      ? { kind: 'ok' as const, text: 'Reply sent.' }
      : flashMsg === 'note'
        ? { kind: 'ok' as const, text: 'Internal note saved.' }
        : flashMsg === 'status'
          ? { kind: 'ok' as const, text: 'Status updated.' }
          : flashMsg === 'claimed'
            ? { kind: 'ok' as const, text: 'Ticket claimed.' }
            : flashMsg === 'priority'
              ? { kind: 'ok' as const, text: 'Priority updated.' }
              : flashMsg === 'error'
                ? { kind: 'err' as const, text: 'Action failed. Please try again.' }
                : null

  const content = renderTicketPage({
    ticket,
    messages,
    user,
    canReply,
    canInternal,
    canPriority,
    canClaim,
    allowedNextStatuses,
  })

  res
    .status(200)
    .type('html')
    .send(
      staffLayout({
        title: ticket.subject,
        user,
        activePage: 'inbox',
        content,
        flash,
      }),
    )
}

// ── POST /tickets/:id/reply ──────────────────────────────────────────

export async function postReply(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  const ticketId = String(req.params.id ?? '')
  const body = String(req.body?.body ?? '').trim()

  if (!hasPermission(user.preset, 'support:ticket:reply')) {
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'perm.deny',
      denyReason: 'support:ticket:reply',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.status(403).type('html').send('<p>Forbidden.</p>')
    return
  }

  if (!body) {
    res.redirect(`/tickets/${encodeURIComponent(ticketId ?? '')}?msg=error`)
    return
  }

  try {
    await addMessage(db, {
      ticketId,
      senderType: 'agent',
      senderUserId: user.userId,
      body,
    })
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.reply',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=replied`)
  } catch (err) {
    const sm = err instanceof SupportError ? err : null
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.reply',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { error: sm?.code ?? (err as Error).message },
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=error`)
  }
}

// ── POST /tickets/:id/internal-note ───────────────────────────────────

export async function postInternalNote(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  const ticketId = String(req.params.id ?? '')
  const body = String(req.body?.body ?? '').trim()

  if (!hasPermission(user.preset, 'support:ticket:internal_note')) {
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'perm.deny',
      denyReason: 'support:ticket:internal_note',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.status(403).type('html').send('<p>Forbidden.</p>')
    return
  }

  if (!body) {
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=error`)
    return
  }

  try {
    await addMessage(db, {
      ticketId,
      senderType: 'agent_internal_note',
      senderUserId: user.userId,
      body,
    })
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.internal_note',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=note`)
  } catch (err) {
    const sm = err instanceof SupportError ? err : null
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.internal_note',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { error: sm?.code ?? (err as Error).message },
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=error`)
  }
}

// ── POST /tickets/:id/status ──────────────────────────────────────────

export async function postStatus(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  const ticketId = String(req.params.id ?? '')
  const newStatus = String(req.body?.status ?? '') as SupportStatus

  if (!ALLOWED_STATUSES.includes(newStatus)) {
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=error`)
    return
  }

  // Permission check: full vs partial.
  const hasFull = hasPermission(user.preset, 'support:ticket:status_change')
  const hasPartial = hasPermission(user.preset, 'support:ticket:status_change_partial')
  const allowed =
    hasFull ||
    (hasPartial && PARTIAL_STATUSES.includes(newStatus))

  if (!allowed) {
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'perm.deny',
      denyReason: hasPartial
        ? 'support:ticket:status_change'
        : 'support:ticket:status_change_partial',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { attempted_status: newStatus },
    }).catch(() => {})
    res.status(403).type('html').send('<p>Forbidden.</p>')
    return
  }

  try {
    await setStatus(db, ticketId, newStatus, user.userId)
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.status_change',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { new_status: newStatus },
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=status`)
  } catch (err) {
    const sm = err instanceof SupportError ? err : null
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.status_change',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { error: sm?.code ?? (err as Error).message, attempted_status: newStatus },
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=error`)
  }
}

// ── POST /tickets/:id/priority ────────────────────────────────────────

export async function postPriority(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  const ticketId = String(req.params.id ?? '')
  const newPriority = String(req.body?.priority ?? '') as SupportPriority

  if (!ALLOWED_PRIORITIES.includes(newPriority)) {
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=error`)
    return
  }

  if (!hasPermission(user.preset, 'support:ticket:priority_change')) {
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'perm.deny',
      denyReason: 'support:ticket:priority_change',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.status(403).type('html').send('<p>Forbidden.</p>')
    return
  }

  try {
    await setPriority(db, ticketId, newPriority, user.userId)
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.priority_change',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { new_priority: newPriority },
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=priority`)
  } catch (err) {
    const sm = err instanceof SupportError ? err : null
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.priority_change',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { error: sm?.code ?? (err as Error).message },
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=error`)
  }
}

// ── POST /tickets/:id/claim ───────────────────────────────────────────

export async function postClaim(
  req: Request,
  res: Response,
  db: any,
): Promise<void> {
  if (!req.staffUser) {
    res.redirect('/login')
    return
  }
  const user = req.staffUser
  const ticketId = String(req.params.id ?? '')

  if (!hasPermission(user.preset, 'support:ticket:claim')) {
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'perm.deny',
      denyReason: 'support:ticket:claim',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.status(403).type('html').send('<p>Forbidden.</p>')
    return
  }

  try {
    await claimTicket(db, ticketId, user.userId)
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.claim',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=claimed`)
  } catch (err) {
    const sm = err instanceof SupportError ? err : null
    logStaffAction(db, {
      actorUserId: user.userId,
      actorPreset: user.preset,
      action: 'ticket.claim',
      targetTicketId: ticketId,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] ?? null) as string | null,
      details: { error: sm?.code ?? (err as Error).message },
    }).catch(() => {})
    res.redirect(`/tickets/${encodeURIComponent(ticketId)}?msg=error`)
  }
}

// ── Renderers ─────────────────────────────────────────────────────────

function renderTicketPage(args: {
  ticket: Awaited<ReturnType<typeof listTicketsForAgent>>[number]
  messages: Awaited<ReturnType<typeof listMessagesForAgent>>
  user: NonNullable<Request['staffUser']>
  canReply: boolean
  canInternal: boolean
  canPriority: boolean
  canClaim: boolean
  allowedNextStatuses: readonly SupportStatus[]
}): string {
  const { ticket, messages, user } = args
  const headline = renderHeadline({
    ticket,
    user,
    canPriority: args.canPriority,
    canClaim: args.canClaim,
    allowedNextStatuses: args.allowedNextStatuses,
  })
  const thread = renderThread(messages, user.userId)
  const composer = renderComposer({
    ticketId: ticket.id,
    status: ticket.status,
    canReply: args.canReply,
    canInternal: args.canInternal,
  })
  return `
    <div style="display:flex;gap:20px;flex-wrap:wrap">
      <div style="flex:1 1 640px;min-width:0">
        ${headline}
        <div style="margin-top:18px;max-height:60vh;overflow-y:auto;padding:6px 2px">
          ${thread}
        </div>
        ${composer}
      </div>
      ${renderSidePanel(ticket)}
    </div>
  `
}

function renderHeadline(args: {
  ticket: Awaited<ReturnType<typeof listTicketsForAgent>>[number]
  user: NonNullable<Request['staffUser']>
  canPriority: boolean
  canClaim: boolean
  allowedNextStatuses: readonly SupportStatus[]
}): string {
  const { ticket, canPriority, canClaim, allowedNextStatuses } = args
  const statusOptions = allowedNextStatuses
    .map((s) => `<option value="${esc(s)}" ${s === ticket.status ? 'selected' : ''}>${esc(readableStatus(s))}</option>`)
    .join('')
  const priorityOptions = ALLOWED_PRIORITIES
    .map((p) => `<option value="${esc(p)}" ${p === ticket.priority ? 'selected' : ''}>${esc(p)}</option>`)
    .join('')
  const canStatusChange = allowedNextStatuses.length > 0

  const claimBtn =
    canClaim && ticket.assignedAgentId !== args.user.userId
      ? `<form method="post" action="/tickets/${esc(ticket.id)}/claim" style="display:inline-block;margin:0">
           <button type="submit" class="btn btn-secondary">Claim</button>
         </form>`
      : ''

  return `
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div style="flex:1 1 auto;min-width:220px">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">${esc(ticket.shopName)} • ${esc(ticket.category)}</div>
        <div style="font-size:16px;font-weight:600;margin-top:2px">${esc(ticket.subject)}</div>
      </div>
      ${
        canStatusChange
          ? `<form method="post" action="/tickets/${esc(ticket.id)}/status" style="display:inline-flex;gap:6px;align-items:center;margin:0">
               <label style="margin:0;font-size:11px;color:var(--text-muted)">Status</label>
               <select name="status" onchange="this.form.submit()" style="width:auto;min-width:150px">${statusOptions}</select>
             </form>`
          : `<span class="pill pill-${pillSuffix(ticket.status)}">${esc(readableStatus(ticket.status))}</span>`
      }
      ${
        canPriority
          ? `<form method="post" action="/tickets/${esc(ticket.id)}/priority" style="display:inline-flex;gap:6px;align-items:center;margin:0">
               <label style="margin:0;font-size:11px;color:var(--text-muted)">Priority</label>
               <select name="priority" onchange="this.form.submit()" style="width:auto;min-width:110px">${priorityOptions}</select>
             </form>`
          : `<span class="pill pill-${ticket.priority === 'urgent' ? 'urgent' : ticket.priority === 'high' ? 'high' : ticket.priority === 'low' ? 'low' : 'normal'}">${esc(ticket.priority)}</span>`
      }
      ${claimBtn}
    </div>
  `
}

function renderThread(
  messages: Awaited<ReturnType<typeof listMessagesForAgent>>,
  currentUserId: string,
): string {
  if (messages.length === 0) {
    return `<div style="color:var(--text-muted);padding:24px;text-align:center">No messages yet.</div>`
  }
  return messages.map((m) => renderMessage(m, currentUserId)).join('')
}

function renderMessage(
  m: Awaited<ReturnType<typeof listMessagesForAgent>>[number],
  currentUserId: string,
): string {
  const isMe = m.senderUserId === currentUserId
  const isNote = m.senderType === 'agent_internal_note'
  const isSeller = m.senderType === 'seller'
  const isSystem = m.senderType === 'system'
  const isDeleted = m.deletedAt !== null

  // Bubble colors:
  //   me (agent)           → accent blue, right-aligned
  //   other agent          → gray bubble, left-aligned
  //   seller               → gray bubble, left-aligned, "from seller" label
  //   internal note        → yellow bubble, full-width ribbon, left-aligned
  //   system               → muted neutral, center-ish
  const align = isMe && !isNote ? 'flex-end' : 'flex-start'
  const bubbleStyle = isNote
    ? 'background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);color:var(--text);border-radius:8px;padding:10px 14px;max-width:92%;'
    : isSystem
      ? 'background:transparent;color:var(--text-muted);font-style:italic;font-size:12px;padding:4px 10px;'
      : isMe
        ? 'background:var(--accent);color:#fff;border-radius:18px 18px 4px 18px;padding:10px 14px;max-width:72%;'
        : 'background:var(--bg-hover);color:var(--text);border-radius:18px 18px 18px 4px;padding:10px 14px;max-width:72%;'

  const nameLine = isSystem
    ? ''
    : `<div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">${esc(m.senderDisplayName)}${isNote ? ' • Internal note' : isSeller ? ' (seller)' : ''} • ${esc(formatTime(m.createdAt))}</div>`

  const bodyHtml = isDeleted
    ? '<em style="opacity:.6">[message deleted]</em>'
    : esc(m.body).replaceAll('\n', '<br>')

  return `
    <div style="display:flex;justify-content:${align};margin:8px 0">
      <div style="max-width:92%">
        ${nameLine}
        <div style="${bubbleStyle}">${bodyHtml}</div>
      </div>
    </div>
  `
}

function renderComposer(args: {
  ticketId: string
  status: string
  canReply: boolean
  canInternal: boolean
}): string {
  if (args.status === 'closed' || args.status === 'merged') {
    return `<div style="margin-top:20px;color:var(--text-muted);font-size:13px;text-align:center;padding:16px">
      This ticket is ${esc(args.status)}. Reopen to continue the conversation.
    </div>`
  }
  if (!args.canReply && !args.canInternal) {
    return `<div style="margin-top:20px;color:var(--text-muted);font-size:13px;text-align:center">You don't have permission to post in this ticket.</div>`
  }
  return `
    <div style="margin-top:20px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:12px">
      <div style="display:flex;gap:6px;margin-bottom:8px">
        ${args.canReply ? `<button type="button" onclick="setMode('reply')" id="mode-reply" class="btn btn-secondary" style="font-size:12px">Reply to seller</button>` : ''}
        ${args.canInternal ? `<button type="button" onclick="setMode('note')" id="mode-note" class="btn btn-secondary" style="font-size:12px">Internal note</button>` : ''}
      </div>
      <form id="composer-form" method="post" action="/tickets/${esc(args.ticketId)}/reply" style="margin:0">
        <textarea id="composer-body" name="body" rows="3" placeholder="Write your message…" required style="margin-bottom:8px;resize:vertical"></textarea>
        <div style="display:flex;justify-content:flex-end">
          <button type="submit" class="btn" id="composer-submit">Send</button>
        </div>
      </form>
      <script>
        (function () {
          var form = document.getElementById('composer-form');
          var submit = document.getElementById('composer-submit');
          var mReply = document.getElementById('mode-reply');
          var mNote = document.getElementById('mode-note');
          var body = document.getElementById('composer-body');
          window.setMode = function (mode) {
            if (mode === 'note') {
              form.action = '/tickets/${esc(args.ticketId)}/internal-note';
              submit.textContent = 'Save note';
              body.placeholder = 'Internal note (not visible to seller)…';
              if (mNote) mNote.style.borderColor = 'var(--warn)';
              if (mReply) mReply.style.borderColor = '';
            } else {
              form.action = '/tickets/${esc(args.ticketId)}/reply';
              submit.textContent = 'Send';
              body.placeholder = 'Write your message…';
              if (mReply) mReply.style.borderColor = 'var(--accent)';
              if (mNote) mNote.style.borderColor = '';
            }
          };
          setMode('reply');
        }());
      </script>
    </div>
  `
}

function renderSidePanel(
  ticket: Awaited<ReturnType<typeof listTicketsForAgent>>[number],
): string {
  return `
    <aside style="flex:0 0 260px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;padding:14px">
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Details</div>
      <dl style="margin:0;font-size:12px">
        <dt style="color:var(--text-muted);margin-top:8px">Shop</dt>
        <dd style="margin:0">${esc(ticket.shopName)}</dd>
        <dt style="color:var(--text-muted);margin-top:8px">Opened by</dt>
        <dd style="margin:0">${esc(ticket.openerDisplayName)}</dd>
        <dt style="color:var(--text-muted);margin-top:8px">Category</dt>
        <dd style="margin:0">${esc(ticket.category)}</dd>
        <dt style="color:var(--text-muted);margin-top:8px">Assigned</dt>
        <dd style="margin:0">${esc(ticket.assignedAgentDisplayName ?? 'Unassigned')}</dd>
        <dt style="color:var(--text-muted);margin-top:8px">First response SLA</dt>
        <dd style="margin:0">${esc(formatTime(ticket.slaFirstResponseAt))}</dd>
        <dt style="color:var(--text-muted);margin-top:8px">Resolution SLA</dt>
        <dd style="margin:0">${esc(formatTime(ticket.slaResolutionAt))}</dd>
        <dt style="color:var(--text-muted);margin-top:8px">Opened</dt>
        <dd style="margin:0">${esc(formatTime(ticket.createdAt))}</dd>
        ${
          ticket.csatScore !== null
            ? `<dt style="color:var(--text-muted);margin-top:8px">CSAT</dt><dd style="margin:0">${esc(ticket.csatScore)} / 5</dd>`
            : ''
        }
      </dl>
    </aside>
  `
}

// ── helpers ───────────────────────────────────────────────────────────

async function loadTicketById(
  db: any,
  ticketId: string,
): Promise<Awaited<ReturnType<typeof listTicketsForAgent>>[number] | null> {
  const rows = await (db as any)
    .selectFrom('support_tickets as t')
    .innerJoin('shops as s', 's.id', 't.shop_id')
    .leftJoin('users as opener', 'opener.id', 't.opener_user_id')
    .leftJoin('support_agent_profiles as ap', 'ap.user_id', 't.assigned_agent_id')
    .where('t.id', '=', ticketId)
    .select([
      't.id as id',
      't.shop_id as shopId',
      's.name as shopName',
      's.slug as shopSlug',
      't.opener_user_id as openerUserId',
      'opener.name as openerDisplayName',
      't.category as category',
      't.subject as subject',
      't.status as status',
      't.priority as priority',
      't.assigned_agent_id as assignedAgentId',
      'ap.display_name as assignedAgentDisplayName',
      't.sla_first_response_at as slaFirstResponseAt',
      't.sla_resolution_at as slaResolutionAt',
      't.first_responded_at as firstRespondedAt',
      't.resolved_at as resolvedAt',
      't.closed_at as closedAt',
      't.csat_score as csatScore',
      't.last_message_at as lastMessageAt',
      't.unread_by_agent_count as unreadByAgentCount',
      't.created_at as createdAt',
      't.updated_at as updatedAt',
    ])
    .executeTakeFirst()
  if (!rows) return null
  return {
    id: String(rows.id),
    shopId: String(rows.shopId),
    shopName: String(rows.shopName),
    shopSlug: String(rows.shopSlug),
    openerUserId: String(rows.openerUserId),
    openerDisplayName: rows.openerDisplayName ?? 'Seller',
    category: rows.category,
    subject: String(rows.subject),
    status: rows.status,
    priority: rows.priority,
    assignedAgentId: rows.assignedAgentId ? String(rows.assignedAgentId) : null,
    assignedAgentDisplayName: rows.assignedAgentDisplayName,
    slaFirstResponseAt: String(rows.slaFirstResponseAt),
    slaResolutionAt: String(rows.slaResolutionAt),
    firstRespondedAt: rows.firstRespondedAt ? String(rows.firstRespondedAt) : null,
    resolvedAt: rows.resolvedAt ? String(rows.resolvedAt) : null,
    closedAt: rows.closedAt ? String(rows.closedAt) : null,
    csatScore: rows.csatScore,
    lastMessageAt: String(rows.lastMessageAt),
    unreadByAgentCount: Number(rows.unreadByAgentCount ?? 0),
    createdAt: String(rows.createdAt),
    updatedAt: String(rows.updatedAt),
  }
}

function pillSuffix(s: string): string {
  if (s === 'pending_seller') return 'pending-s'
  if (s === 'pending_agent') return 'pending-a'
  if (s === 'resolved') return 'resolved'
  if (s === 'closed') return 'closed'
  return 'open'
}

function readableStatus(s: string): string {
  if (s === 'pending_agent') return 'Waiting on us'
  if (s === 'pending_seller') return 'Waiting on seller'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Silence unused-import warning if bundlers tree-shake aggressively.
export { safeMessage }
