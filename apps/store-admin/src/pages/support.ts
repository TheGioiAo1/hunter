/**
 * Store Admin — Support (seller-facing).
 *
 * Endpoints behind /admin/store/:slug/support/*:
 *   GET    /support                 — full inbox (tickets table, Messenger-ish)
 *   GET    /support/new             — new-ticket form
 *   POST   /support/new             — create ticket
 *   GET    /support/:ticketId       — thread view
 *   POST   /support/:ticketId/reply — add seller reply
 *   POST   /support/:ticketId/read  — mark-read (form redirect)
 *   POST   /support/:ticketId/csat  — submit CSAT rating
 *   GET    /support/api/unread      — JSON polling endpoint (widget + bell)
 *
 * Iron Rule 5 enforcement:
 *   Every catch branch runs the raw error through `safeMessage()` so
 *   sellers see "Please contact Gbox support." rather than stack
 *   traces, DB error codes, feature flag names, or any internal route.
 *   The diagnostic is still logged server-side via `console.error`
 *   (pino via logging middleware) so Thai can investigate.
 *
 * All mutations go through `@gbox/core/modules/support/service` so
 * invariants (event logging, counter bumps, AES-256-GCM encryption)
 * stay centralised.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  addMessage,
  createTicket,
  getTicketForSeller,
  getTicketUnreadCountsForSeller,
  listMessagesForSeller,
  listTicketsForSeller,
  markReadBySeller,
  safeMessage,
  submitCsat,
  SupportError,
  type SupportCategory,
} from '@gbox/core/modules/support/index.js'

// Category options shown in the new-ticket form. Mirrors the DB enum
// in `support_ticket_category` (migration 074).
const CATEGORY_OPTIONS: Array<{ value: SupportCategory; label: string }> = [
  { value: 'payment', label: 'Payment / billing (24/7 SLA)' },
  { value: 'technical', label: 'Technical issue' },
  { value: 'onboarding', label: 'Onboarding help' },
  { value: 'account', label: 'Account / access' },
  { value: 'product_order', label: 'Product or order question' },
  { value: 'other', label: 'Other' },
]

const CATEGORY_LABEL: Record<SupportCategory, string> = {
  payment: 'Payment',
  technical: 'Technical',
  onboarding: 'Onboarding',
  account: 'Account',
  product_order: 'Product/Order',
  other: 'Other',
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  pending_agent: 'Waiting on Gbox',
  pending_seller: 'Needs your reply',
  resolved: 'Resolved',
  closed: 'Closed',
  merged: 'Merged',
}

const STATUS_COLOR: Record<string, string> = {
  open: '#3b82f6',
  pending_agent: '#f59e0b',
  pending_seller: '#6366f1',
  resolved: '#10b981',
  closed: '#64748b',
  merged: '#94a3b8',
}

// ── GET /support — inbox ─────────────────────────────────────────

export async function getSupportTicketList(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme
  const base = `/admin/store/${esc(store.slug)}`

  const statusFilter = (req.query.status as string | undefined) || 'any'
  const created = req.query.created === '1'
  const csatSaved = req.query.csat === '1'

  let tickets: Array<Awaited<ReturnType<typeof listTicketsForSeller>>[number]> = []
  let loadError: string | null = null
  try {
    tickets = await listTicketsForSeller(db as any, store.id, {
      status: statusFilter as any,
      limit: 100,
    })
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    loadError = safe
    console.error('[support] listTicketsForSeller failed', { shopId: store.id, diagnostic })
  }

  const tabs = [
    { slug: 'any', label: 'All' },
    { slug: 'open', label: 'Open' },
    { slug: 'pending_seller', label: 'Needs your reply' },
    { slug: 'resolved', label: 'Resolved' },
    { slug: 'closed', label: 'Closed' },
  ]

  const rowsHtml = tickets.length === 0
    ? `
      <div style="padding:40px;text-align:center;color:var(--s-text-dim)">
        <div style="font-size:15px;margin-bottom:8px">No tickets yet.</div>
        <div style="font-size:13px">Open one whenever you need help — we reply in 2h for payment issues and 4h for everything else (business hours, Asia/Ho_Chi_Minh).</div>
        <div style="margin-top:16px"><a href="${base}/support/new" class="btn btn-primary">Open a ticket</a></div>
      </div>
    `
    : tickets.map((t) => {
        const unreadBadge = t.unreadCount > 0
          ? `<span class="badge" style="background:#ef4444;color:#fff;margin-left:8px">${t.unreadCount}</span>`
          : ''
        const statusColor = STATUS_COLOR[t.status] ?? '#64748b'
        const statusLabel = STATUS_LABEL[t.status] ?? t.status
        const lastSeen = formatWhen(t.lastMessageAt)
        return `
          <a href="${base}/support/${esc(t.id)}" style="display:block;padding:14px 16px;border-bottom:1px solid var(--s-border);text-decoration:none;color:inherit">
            <div style="display:flex;align-items:center;gap:12px">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
                  <span style="font-weight:${t.unreadCount > 0 ? '700' : '500'};color:var(--s-text)">${esc(t.subject)}</span>
                  <span class="badge badge-neutral" style="font-size:10px">${esc(CATEGORY_LABEL[t.category] ?? t.category)}</span>
                  ${unreadBadge}
                </div>
                <div style="font-size:12px;color:var(--s-text-muted)">
                  ${t.agentDisplayName ? esc(t.agentDisplayName) + ' · ' : ''}${esc(lastSeen)}
                </div>
              </div>
              <span class="badge" style="background:${statusColor};color:#fff">${esc(statusLabel)}</span>
            </div>
          </a>`
      }).join('\n')

  const flash = created
    ? successFlash('Ticket submitted. A Gbox agent will reply shortly.')
    : csatSaved
      ? successFlash('Thanks for the feedback!')
      : ''
  const errorFlash = loadError
    ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-danger);font-size:13px">${esc(loadError)}</div>`
    : ''

  const tabsHtml = tabs.map((t) => {
    const active = statusFilter === t.slug
    const href = t.slug === 'any' ? `${base}/support` : `${base}/support?status=${t.slug}`
    return `<a href="${href}" class="btn btn-sm ${active ? 'btn-primary' : 'btn-outline'}" style="text-decoration:none">${esc(t.label)}</a>`
  }).join('')

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Support</h1>
        <p class="page-subtitle">Talk to Gbox — we reply fast.</p>
      </div>
      <div>
        <a href="${base}/support/new" class="btn btn-primary">New ticket</a>
      </div>
    </div>

    ${flash}
    ${errorFlash}

    <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap">
      ${tabsHtml}
    </div>

    <div class="card">
      <div class="card-header">
        <span>Your tickets</span>
        <span style="font-size:12px;color:var(--s-text-dim)">${tickets.length} shown</span>
      </div>
      <div class="card-body" style="padding:0">
        ${rowsHtml}
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Support',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'support',
    content,
    theme: theme as 'dark' | 'light',
    cookieHeader: req.headers.cookie ?? null,
  }))
}

// ── GET /support/new — new-ticket form ───────────────────────────

export async function getSupportTicketNew(
  req: Request,
  res: Response,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme
  const base = `/admin/store/${esc(store.slug)}`
  const csrfField = csrfHiddenField(req.csrfToken!)
  const errorMsg = (req.query.error as string | undefined) ?? ''

  const categoryOptions = CATEGORY_OPTIONS.map(
    (c) => `<option value="${c.value}">${esc(c.label)}</option>`,
  ).join('')

  const errorBlock = errorMsg
    ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-danger);font-size:13px">${esc(errorMsg)}</div>`
    : ''

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">New support ticket</h1>
        <p class="page-subtitle">Describe what you need help with.</p>
      </div>
      <div><a href="${base}/support" class="btn btn-outline">Cancel</a></div>
    </div>

    ${errorBlock}

    <div class="card" style="max-width:720px">
      <div class="card-body">
        <form method="POST" action="${base}/support/new">
          ${csrfField}
          <div class="form-field">
            <label for="category">Category</label>
            <select id="category" name="category" required>
              ${categoryOptions}
            </select>
            <div class="form-help">Payment tickets follow a 24/7 clock; others use Asia/Ho_Chi_Minh business hours.</div>
          </div>
          <div class="form-field">
            <label for="subject">Subject</label>
            <input id="subject" name="subject" type="text" maxlength="120" required placeholder="Short summary (max 120 chars)">
          </div>
          <div class="form-field">
            <label for="body">Message</label>
            <textarea id="body" name="body" rows="8" maxlength="8000" required placeholder="Include store URL, order ID, and screenshots if relevant."></textarea>
            <div class="form-help">Max 8,000 characters. Encrypted at rest (AES-256-GCM).</div>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <a href="${base}/support" class="btn btn-outline">Cancel</a>
            <button type="submit" class="btn btn-primary">Submit ticket</button>
          </div>
        </form>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'New support ticket',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'support',
    content,
    theme: theme as 'dark' | 'light',
    cookieHeader: req.headers.cookie ?? null,
  }))
}

// ── POST /support/new — create ticket ────────────────────────────

export async function postSupportTicketCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${esc(store.slug)}`

  const category = (req.body?.category as string | undefined)?.trim() as SupportCategory | undefined
  const subject = ((req.body?.subject as string | undefined) ?? '').trim()
  const body = ((req.body?.body as string | undefined) ?? '').trim()

  try {
    const { ticketId } = await createTicket(db as any, {
      shopId: store.id,
      openerUserId: user.id,
      category: category ?? 'other',
      subject,
      body,
    })
    res.redirect(`${base}/support/${ticketId}?created=1`)
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.error('[support] createTicket failed', { shopId: store.id, diagnostic })
    // If it's a validation error (known code), surface the diagnostic
    // detail — those are safe to show (e.g. "subject too long"), they
    // don't leak architecture. Everything else collapses to the safe
    // canonical message.
    const surface = err instanceof SupportError && err.code === 'INVALID_INPUT'
      ? diagnostic
      : safe
    res.redirect(`${base}/support/new?error=${encodeURIComponent(surface)}`)
  }
}

// ── GET /support/:ticketId — thread view ─────────────────────────

export async function getSupportTicketDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme
  const ticketId = req.params.ticketId as string
  const base = `/admin/store/${esc(store.slug)}`
  const csrfField = csrfHiddenField(req.csrfToken!)
  const created = req.query.created === '1'
  const replied = req.query.replied === '1'
  const errorMsg = (req.query.error as string | undefined) ?? ''

  if (!ticketId) {
    res.redirect(`${base}/support`)
    return
  }

  let ticket: Awaited<ReturnType<typeof getTicketForSeller>> = null
  let messages: Awaited<ReturnType<typeof listMessagesForSeller>> = []
  let loadError: string | null = null
  try {
    ticket = await getTicketForSeller(db as any, store.id, ticketId)
    if (ticket) {
      messages = await listMessagesForSeller(db as any, store.id, ticketId, user.name || user.email)
      // Silently mark-read on view (best-effort; failure shouldn't block).
      await markReadBySeller(db as any, store.id, ticketId).catch((err) => {
        console.error('[support] markReadBySeller (on view) failed', { ticketId, err })
      })
    }
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    loadError = safe
    console.error('[support] getSupportTicketDetail load failed', { ticketId, diagnostic })
  }

  if (!ticket) {
    const msg = loadError ?? 'Ticket not found or you don\u2019t have access.'
    const content = `
      <div class="page-header">
        <div><h1 class="page-title">Support</h1></div>
        <div><a href="${base}/support" class="btn btn-outline">Back</a></div>
      </div>
      <div class="card">
        <div class="card-body" style="text-align:center;padding:40px;color:var(--s-text-dim)">
          ${esc(msg)}
        </div>
      </div>
    `
    res.send(sellerLayout({
      title: 'Support',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'support',
      content,
      theme: theme as 'dark' | 'light',
      cookieHeader: req.headers.cookie ?? null,
    }))
    return
  }

  const statusColor = STATUS_COLOR[ticket.status] ?? '#64748b'
  const statusLabel = STATUS_LABEL[ticket.status] ?? ticket.status
  const isClosed = ticket.status === 'closed' || ticket.status === 'merged'
  const csatAlreadySet = ticket.csatScore !== null && ticket.csatScore !== undefined

  const bubbles = messages.map((m) => renderMessageBubble(m)).join('\n')

  const flash = created
    ? successFlash('Ticket submitted. A Gbox agent will reply shortly.')
    : replied
      ? successFlash('Message sent.')
      : ''

  const errorBlock = errorMsg
    ? `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);border-radius:8px;padding:12px 16px;margin-bottom:16px;color:var(--s-danger);font-size:13px">${esc(errorMsg)}</div>`
    : ''

  const replyForm = isClosed
    ? `
      <div style="padding:16px;border-top:1px solid var(--s-border);background:var(--s-card-hover);color:var(--s-text-dim);font-size:13px;text-align:center;border-radius:0 0 8px 8px">
        This ticket is ${esc(statusLabel.toLowerCase())}. ${
          ticket.status === 'closed'
            ? 'You can reopen within 7 days by sending a new message — contact Gbox support to reopen.'
            : 'No further messages accepted.'
        }
      </div>
    `
    : `
      <form method="POST" action="${base}/support/${esc(ticket.id)}/reply" style="padding:16px;border-top:1px solid var(--s-border)">
        ${csrfField}
        <textarea name="body" rows="4" maxlength="8000" required placeholder="Type a reply..." style="width:100%;padding:10px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-family:inherit;font-size:14px;resize:vertical"></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button type="submit" class="btn btn-primary">Send reply</button>
        </div>
      </form>
    `

  const csatBlock = ticket.status === 'resolved' || ticket.status === 'closed'
    ? csatAlreadySet
      ? `
        <div class="card" style="margin-top:16px">
          <div class="card-body" style="text-align:center">
            <div style="font-size:13px;color:var(--s-text-dim);margin-bottom:6px">Your rating for this ticket</div>
            <div style="font-size:24px">${renderStars(ticket.csatScore ?? 0)}</div>
          </div>
        </div>
      `
      : renderCsatForm(base, ticket.id, csrfField)
    : ''

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${esc(ticket.subject)}</h1>
        <p class="page-subtitle">
          <span class="badge" style="background:${statusColor};color:#fff">${esc(statusLabel)}</span>
          <span class="badge badge-neutral" style="margin-left:6px">${esc(CATEGORY_LABEL[ticket.category] ?? ticket.category)}</span>
          ${ticket.agentDisplayName ? `<span style="margin-left:8px;color:var(--s-text-dim)">· ${esc(ticket.agentDisplayName)}</span>` : ''}
        </p>
      </div>
      <div><a href="${base}/support" class="btn btn-outline">Back to inbox</a></div>
    </div>

    ${flash}
    ${errorBlock}

    <div class="card" style="max-width:860px">
      <div class="card-body" style="padding:0">
        <div id="support-thread" style="max-height:560px;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px">
          ${bubbles || '<div style="text-align:center;padding:24px;color:var(--s-text-dim)">No messages yet.</div>'}
        </div>
        ${replyForm}
      </div>
    </div>

    ${csatBlock}

    <script>
      // Auto-scroll the thread to the bottom on load.
      (function () {
        var el = document.getElementById('support-thread')
        if (el) el.scrollTop = el.scrollHeight
      })()
    </script>
  `

  res.send(sellerLayout({
    title: `Support · ${ticket.subject}`,
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'support',
    content,
    theme: theme as 'dark' | 'light',
    cookieHeader: req.headers.cookie ?? null,
  }))
}

// ── POST /support/:ticketId/reply — add seller message ──────────

export async function postSupportMessageCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const ticketId = req.params.ticketId as string
  const base = `/admin/store/${esc(store.slug)}`
  const body = ((req.body?.body as string | undefined) ?? '').trim()

  if (!ticketId) {
    res.redirect(`${base}/support`)
    return
  }

  // Scope-check: if the ticket doesn't belong to this shop, getTicket
  // will return null and we bail without hitting addMessage. Guards
  // against a seller posting into another shop's ticket by guessing IDs.
  try {
    const ticket = await getTicketForSeller(db as any, store.id, ticketId)
    if (!ticket) {
      res.redirect(`${base}/support?error=${encodeURIComponent('Ticket not found.')}`)
      return
    }
    await addMessage(db as any, {
      ticketId,
      senderType: 'seller',
      senderUserId: user.id,
      body,
    })
    res.redirect(`${base}/support/${ticketId}?replied=1`)
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.error('[support] postSupportMessageCreate failed', { ticketId, diagnostic })
    const surface = err instanceof SupportError && err.code === 'INVALID_INPUT'
      ? diagnostic
      : safe
    res.redirect(`${base}/support/${ticketId}?error=${encodeURIComponent(surface)}`)
  }
}

// ── POST /support/:ticketId/read — explicit mark-read ───────────

export async function postSupportMarkRead(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const ticketId = req.params.ticketId as string
  const base = `/admin/store/${esc(store.slug)}`
  if (!ticketId) {
    res.redirect(`${base}/support`)
    return
  }
  try {
    await markReadBySeller(db as any, store.id, ticketId)
  } catch (err) {
    const { diagnostic } = safeMessage(err)
    console.error('[support] markReadBySeller failed', { ticketId, diagnostic })
  }
  res.redirect(`${base}/support/${ticketId}`)
}

// ── POST /support/:ticketId/csat — submit rating ────────────────

export async function postSupportCsat(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const ticketId = req.params.ticketId as string
  const base = `/admin/store/${esc(store.slug)}`
  if (!ticketId) {
    res.redirect(`${base}/support`)
    return
  }
  const ratingRaw = req.body?.rating as string | undefined
  const rating = Number.parseInt(ratingRaw ?? '', 10)
  const comment = ((req.body?.comment as string | undefined) ?? '').trim() || null

  try {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new SupportError('rating must be 1-5', 'INVALID_INPUT')
    }
    await submitCsat(db as any, store.id, ticketId, rating, comment, user.id)
    res.redirect(`${base}/support/${ticketId}?csat=1`)
  } catch (err) {
    const { safe, diagnostic } = safeMessage(err)
    console.error('[support] submitCsat failed', { ticketId, diagnostic })
    const surface = err instanceof SupportError && err.code === 'INVALID_INPUT'
      ? diagnostic
      : safe
    res.redirect(`${base}/support/${ticketId}?error=${encodeURIComponent(surface)}`)
  }
}

// ── GET /support/api/unread — JSON polling endpoint ─────────────
//
// The seller widget polls this every 3s while open. We keep the route
// CSRF-exempt at the middleware layer (session cookie + SameSite=Lax
// block cross-origin abuse) so the widget can fetch it without juggling
// a token in JS. Response shape pins the widget's rendering contract.
export async function getSupportUnreadCount(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store
  if (!store) {
    res.status(401).json({ ok: false, error: 'unauthorized' })
    return
  }
  try {
    const { total, perTicket } = await getTicketUnreadCountsForSeller(db as any, store.id)
    res.json({ ok: true, total, perTicket })
  } catch (err) {
    const { diagnostic } = safeMessage(err)
    console.error('[support] getTicketUnreadCountsForSeller failed', { shopId: store.id, diagnostic })
    // Don't leak the error to the widget; return 0 and let a subsequent
    // tick pick up the real count once the underlying issue is fixed.
    res.status(200).json({ ok: true, total: 0, perTicket: [] })
  }
}

// ── helpers ─────────────────────────────────────────────────────

function renderMessageBubble(m: {
  id: string
  senderType: 'seller' | 'agent' | 'system'
  senderDisplayName: string
  body: string
  isOwn: boolean
  createdAt: string
}): string {
  if (m.senderType === 'system') {
    return `
      <div style="text-align:center;padding:8px;color:var(--s-text-dim);font-size:12px">
        <em>${esc(m.body)}</em>
      </div>
    `
  }
  const align = m.isOwn ? 'flex-end' : 'flex-start'
  // #0084FF is the Messenger blue the seller-side spec pins to. Agent
  // bubbles use the neutral surface so "my messages" are unmistakably
  // the sender's own thread.
  const bg = m.isOwn ? '#0084FF' : 'var(--s-card-hover)'
  const color = m.isOwn ? '#ffffff' : 'var(--s-text)'
  const when = formatWhen(m.createdAt)
  return `
    <div style="display:flex;justify-content:${align}">
      <div style="max-width:72%;padding:10px 14px;border-radius:18px;background:${bg};color:${color};word-wrap:break-word">
        <div style="font-size:11px;opacity:.7;margin-bottom:4px">${esc(m.senderDisplayName)} · ${esc(when)}</div>
        <div style="font-size:14px;white-space:pre-wrap">${esc(m.body)}</div>
      </div>
    </div>
  `
}

function renderCsatForm(base: string, ticketId: string, csrfField: string): string {
  const stars = [1, 2, 3, 4, 5].map((n) =>
    `<label style="cursor:pointer;padding:4px 6px">
       <input type="radio" name="rating" value="${n}" required style="display:none" onchange="var lbls=this.closest('form').querySelectorAll('.csat-star');for(var i=0;i&lt;lbls.length;i++){lbls[i].style.color=(i&lt;${n})?'#f59e0b':'var(--s-text-dim)'}">
       <span class="csat-star" style="font-size:28px;color:var(--s-text-dim)">&#9733;</span>
     </label>`,
  ).join('')
  return `
    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <span>How did we do?</span>
      </div>
      <div class="card-body">
        <form method="POST" action="${base}/support/${esc(ticketId)}/csat">
          ${csrfField}
          <div style="text-align:center;margin-bottom:12px">${stars}</div>
          <div class="form-field">
            <label for="csat-comment">Optional comment</label>
            <textarea id="csat-comment" name="comment" rows="3" maxlength="500" placeholder="Tell us anything else..."></textarea>
          </div>
          <div style="display:flex;justify-content:flex-end">
            <button type="submit" class="btn btn-primary">Submit feedback</button>
          </div>
        </form>
      </div>
    </div>
  `
}

function renderStars(score: number): string {
  return Array.from({ length: 5 }, (_, i) =>
    i < score ? '<span style="color:#f59e0b">&#9733;</span>' : '<span style="color:var(--s-text-dim)">&#9733;</span>',
  ).join('')
}

function successFlash(msg: string): string {
  return `<div style="background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:var(--s-success);font-size:13px">${esc(msg)}</div>`
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso)
    const now = Date.now()
    const diff = now - d.getTime()
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

// Exposed for unit tests.
export const __testables = {
  renderMessageBubble,
  renderCsatForm,
  renderStars,
  successFlash,
  formatWhen,
  CATEGORY_OPTIONS,
  STATUS_LABEL,
  STATUS_COLOR,
}
