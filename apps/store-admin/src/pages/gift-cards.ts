/**
 * Store Admin — Gift Cards Management
 *
 * Full gift card CRUD with real DB integration.
 * Uses @gbox/core/modules/gift-cards/service.
 *
 * ## Phase 10 PR2
 *
 * - Create form now collects recipient_email / recipient_name /
 *   sender_name / personal_message / send_at (optional).
 * - On create, if recipient_email is present and send_at is in the
 *   past (or blank), we immediately deliver via `deliverGiftCardNow`.
 *   Future-dated sends are picked up by the cron.
 * - New detail page: /gift-cards/:giftCardId — shows the card + code,
 *   full delivery state, and a "Send email now" button.
 * - New route: POST /gift-cards/:giftCardId/send-email — triggers
 *   `deliverGiftCardNow` and reports the outcome in a flash param.
 *
 * All error copy on this page routes through a generic "Please contact
 * Gbox support" fallback when an exception doesn't map to a known
 * user-actionable case (Iron Rule 5 — no god-admin surface leaked).
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  listGiftCards,
  createGiftCard,
  disableGiftCard,
  getGiftCardById,
  updateGiftCard,
} from '@gbox/core/modules/gift-cards/service.js'
import { deliverGiftCardNow } from '@gbox/core/modules/gift-cards/email.js'
import { notify, byActor } from '../lib/notify.js'
import { safeFlashMessage } from '../lib/gift-cards-flash.js'
import { renderGiftCardProductForm } from './gift-card-product-form.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMaskedCode(code: string): string {
  return code.length > 4 ? '••••••••••••' + code.slice(-4) : code
}

function parseSendAt(raw: string | undefined | null): string | null {
  if (!raw) return null
  const d = new Date(raw)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// GET /gift-cards — Gift Cards list with real data
// ---------------------------------------------------------------------------

export async function getGiftCards(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'

  try {
  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const perPage = 25

  // DB is optional in local dev (apps point to remote APIs only). Treat any
  // DB failure as "no gift cards" so the empty state renders cleanly instead
  // of a 500. Real DB errors are still logged for triage.
  let giftCards: any[] = []
  let total = 0
  try {
    const result = await listGiftCards(db, store.id, { limit: perPage, offset: (page - 1) * perPage })
    giftCards = result.giftCards as any[]
    total = result.total
  } catch (dbErr: any) {
    console.warn('[gift-cards] DB unavailable, rendering empty state:', dbErr?.message || dbErr)
  }

  // Compute stats
  const activeCards = giftCards.filter((gc: any) => !gc.disabled_at && (!gc.expires_at || new Date(gc.expires_at) > new Date()))
  const totalOutstanding = activeCards.reduce((sum: number, gc: any) => sum + parseFloat(gc.balance || '0'), 0)
  const totalRedeemed = giftCards.reduce((sum: number, gc: any) => sum + (parseFloat(gc.initial_value || '0') - parseFloat(gc.balance || '0')), 0)

  const tableRows = giftCards.length === 0
    ? `<tr><td colspan="7" style="text-align:center;padding:48px 12px;color:var(--s-text-secondary)">
        <div style="font-weight:600;font-size:14px;color:var(--s-text-primary);margin-bottom:4px">No gift cards yet</div>
        <div style="font-size:13px">Create your first gift card using the button above.</div>
       </td></tr>`
    : giftCards.map((gc: any) => {
        const isDisabled = !!gc.disabled_at
        const isExpired = gc.expires_at && new Date(gc.expires_at) < new Date()
        const status = isDisabled ? 'Disabled' : isExpired ? 'Expired' : 'Active'
        const statusClass = isDisabled ? 'badge-danger' : isExpired ? 'badge-warning' : 'badge-success'
        const code = gc.code || ''
        const maskedCode = formatMaskedCode(code)
        const recipient = gc.recipient_email ? esc(gc.recipient_email) : '-'
        const emailState = gc.recipient_email
          ? (gc.email_sent_at ? `<span style="color:#34d399">Sent</span>` : `<span style="color:#f59e0b">Pending</span>`)
          : `<span style="color:var(--s-text-secondary)">Internal</span>`
        return `<tr style="border-bottom:1px solid var(--s-border)">
          <td style="padding:10px 12px;font-family:monospace;font-size:13px">
            <a href="/admin/store/${esc(store.slug)}/gift-cards/${esc(gc.id)}" style="color:var(--s-text-primary);text-decoration:none">${esc(maskedCode)}</a>
          </td>
          <td style="padding:10px 12px">$${esc(gc.initial_value)}</td>
          <td style="padding:10px 12px;font-weight:600">$${esc(gc.balance)}</td>
          <td style="padding:10px 12px"><span class="badge ${statusClass}" style="font-size:11px">${status}</span></td>
          <td style="padding:10px 12px;font-size:12px;color:var(--s-text-secondary)">${recipient}</td>
          <td style="padding:10px 12px;font-size:12px">${emailState}</td>
          <td style="padding:10px 12px;font-size:12px;color:var(--s-text-secondary)">${gc.expires_at ? new Date(gc.expires_at).toLocaleDateString() : 'Never'}</td>
          <td style="padding:10px 12px">
            ${!isDisabled ? `<form method="POST" action="/admin/store/${esc(store.slug)}/gift-cards/${esc(gc.id)}/disable" style="display:inline">
              <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
              <button type="submit" class="btn btn-sm" style="font-size:11px;padding:4px 10px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:4px;color:var(--s-text-secondary);cursor:pointer" onclick="return confirm('Disable this gift card?')">Disable</button>
            </form>` : ''}
          </td>
        </tr>`
      }).join('')

  const totalPages = Math.ceil(total / perPage)
  const pagination = total > perPage ? `
    <div style="display:flex;justify-content:center;gap:8px;margin-top:16px">
      ${page > 1 ? `<a href="?page=${page - 1}" class="btn btn-sm" style="font-size:12px;padding:6px 12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);text-decoration:none">&laquo; Prev</a>` : ''}
      <span style="padding:6px 12px;font-size:12px;color:var(--s-text-secondary)">Page ${page} of ${totalPages}</span>
      ${page < totalPages ? `<a href="?page=${page + 1}" class="btn btn-sm" style="font-size:12px;padding:6px 12px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:6px;color:var(--s-text-primary);text-decoration:none">Next &raquo;</a>` : ''}
    </div>
  ` : ''

  const flash = typeof req.query.success === 'string' ? `<div class="banner" style="background:#064e3b;color:#d1fae5;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px">✓ ${esc(req.query.success)}</div>` :
    typeof req.query.error === 'string' ? `<div class="banner" style="background:#7f1d1d;color:#fecaca;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(req.query.error)}</div>` : ''

  const base = `/admin/store/${esc(store.slug)}`
  const isEmpty = total === 0

  // ─────────────────────────────────────────────
  // Header — same shape for both states; Export disabled when empty
  // ─────────────────────────────────────────────
  const header = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <h1 style="margin:0;font-size:20px;font-weight:600;display:inline-flex;align-items:center;gap:8px">
        <span style="font-size:18px">🎁</span> Gift cards
      </h1>
      <button type="button" ${isEmpty ? 'disabled' : ''}
        style="padding:7px 14px;border-radius:8px;font-size:13px;font-weight:500;border:1px solid var(--s-border);background:var(--s-card);color:var(--s-text);cursor:${isEmpty ? 'not-allowed' : 'pointer'};opacity:${isEmpty ? '.55' : '1'}">
        Export
      </button>
    </div>
  `

  // ─────────────────────────────────────────────
  // Empty state — Shopify-style centered card
  // ─────────────────────────────────────────────
  const emptyState = `
    ${header}
    <div style="background:var(--s-card);border:1px solid var(--s-border);border-radius:12px;padding:64px 24px;text-align:center;box-shadow:var(--s-shadow)">
      <div style="width:96px;height:96px;margin:0 auto 24px;border-radius:50%;background:color-mix(in srgb, #14b8a6 18%, var(--s-card));display:flex;align-items:center;justify-content:center">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#14b8a6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="8" width="18" height="13" rx="1"/>
          <path d="M3 12h18"/>
          <path d="M12 8v13"/>
          <path d="M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 12 5 12 8c0-3 2.5-5 4.5-5a2.5 2.5 0 0 1 0 5"/>
        </svg>
      </div>
      <h2 style="margin:0 0 10px;font-size:16px;font-weight:600;color:var(--s-text)">Start selling gift cards</h2>
      <p style="margin:0 auto 24px;max-width:420px;font-size:13px;line-height:1.5;color:var(--s-text-muted)">
        Add gift card products to sell or create gift cards and send them directly to your customers.
      </p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:28px">
        <a href="${base}/products/gift-cards/new"
          style="padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;border:1px solid var(--s-border-light);background:var(--s-card);color:var(--s-text);text-decoration:none">
          Create gift card
        </a>
        <a href="${base}/products/gift-cards/product/new"
          style="padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;border:none;background:var(--s-accent);color:#fff;text-decoration:none">
          Add gift card product
        </a>
      </div>
      <p style="margin:0;font-size:12px;color:var(--s-text-muted)">
        By using gift cards, you agree to our <a href="${base}/settings/legal" style="color:var(--s-text);text-decoration:underline">Terms of Service</a>
      </p>
    </div>
    <p style="margin:24px 0 0;text-align:center;font-size:12px;color:var(--s-text-muted)">
      <a href="https://help.gbox.co/gift-cards" target="_blank" rel="noopener" style="color:var(--s-text-muted);text-decoration:underline">Learn more about gift cards</a>
    </p>
  `

  // ─────────────────────────────────────────────
  // List state — original stats + table layout (preserved)
  // ─────────────────────────────────────────────
  const listState = `
    <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <div>
        <h1 style="margin:0;font-size:22px;font-weight:700">Gift Cards</h1>
        <p style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Manage gift cards for ${esc(store.name)}</p>
      </div>
      <a href="${base}/gift-cards/new" class="btn btn-primary" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
        Create Gift Card
      </a>
    </div>

    <div class="stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px">
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Total Issued</div>
        <div style="font-size:28px;font-weight:700;color:var(--s-text-primary)">${total}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Active</div>
        <div style="font-size:28px;font-weight:700;color:#34d399">${activeCards.length}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Outstanding Balance</div>
        <div style="font-size:28px;font-weight:700;color:var(--s-text-primary)">$${totalOutstanding.toFixed(2)}</div>
      </div>
      <div class="stat-card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
        <div style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Total Redeemed</div>
        <div style="font-size:28px;font-weight:700;color:#a855f7">$${totalRedeemed.toFixed(2)}</div>
      </div>
    </div>

    <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:24px">
      <h2 class="card-title" style="margin:0 0 16px;font-size:17px;font-weight:700">Issued Gift Cards</h2>
      <div class="data-table" style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid var(--s-border)">
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Code</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Initial</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Balance</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Status</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Recipient</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Email</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Expires</th>
              <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--s-text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Actions</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      ${pagination}
    </div>
  `

  const content = `${flash}${isEmpty ? emptyState : listState}`

  res.send(sellerLayout({
    title: 'Gift Cards',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'products',
    content,
    theme: theme as 'dark' | 'light',
  }))
  } catch (err: any) {
    console.error('[gift-cards] getGiftCards error:', err.message)
    const base = `/admin/store/${store.slug}`
    res.status(500).send(`
      <!DOCTYPE html><html><head><title>Error</title></head>
      <body style="font-family:sans-serif;padding:40px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#ef4444;">Gift Cards Error</h1>
        <p>Please contact Gbox support if this persists.</p>
        <a href="${base}/products" style="color:#3b82f6;">&larr; Back to Products</a>
      </body></html>
    `)
  }
}

// ---------------------------------------------------------------------------
// GET /gift-cards/new — Create gift card form (now with recipient fields)
// ---------------------------------------------------------------------------

export async function getCreateGiftCard(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrf = esc((req as any).csrfToken || '')

  // Auto-generated 16-char lowercase alphanumeric code (matches Shopify pattern)
  const autoCode = generateGiftCardCode()

  const content = `
    <style>
      .gc-form { max-width:1024px; margin:0 auto; padding-bottom:80px; color:var(--s-text); }
      .gc-topbar { display:flex; align-items:center; gap:8px; margin:0 4px 16px; font-size:14px; }
      .gc-topbar .gc-crumb { color:var(--s-text-muted); text-decoration:none; }
      .gc-topbar .gc-crumb:hover { color:var(--s-text); }
      .gc-topbar h1 { margin:0; font-size:18px; font-weight:600; color:var(--s-text); }
      .gc-grid { display:grid; grid-template-columns:1fr 320px; gap:16px; align-items:start; }
      @media (max-width:1100px) { .gc-grid { grid-template-columns:1fr; } }
      .gc-col { display:flex; flex-direction:column; gap:14px; }
      .gc-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px; box-shadow:var(--s-shadow); }
      .gc-card-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
      .gc-section { font-size:13px; font-weight:600; color:var(--s-text); margin:0; }
      .gc-field { margin-bottom:14px; }
      .gc-field:last-child { margin-bottom:0; }
      .gc-label { display:block; font-size:12px; font-weight:500; color:var(--s-text-muted); margin-bottom:6px; }
      .gc-input, .gc-select { width:100%; padding:8px 12px; border:1px solid var(--s-input-border); border-radius:8px; font-size:14px; background:var(--s-input-bg); color:var(--s-text); outline:none; box-sizing:border-box; font-family:inherit; }
      .gc-input:focus { border-color:var(--s-accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--s-accent) 25%, transparent); }
      .gc-input-mono { font-family:ui-monospace,Menlo,Consolas,monospace; }
      .gc-input-prefixwrap { position:relative; }
      .gc-input-prefix { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--s-text-muted); font-size:14px; pointer-events:none; }
      .gc-input-with-prefix { padding-left:26px; }
      .gc-row-2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
      .gc-pill-btn { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border:1px solid var(--s-input-border); border-radius:8px; background:var(--s-input-bg); color:var(--s-text); font-size:13px; cursor:pointer; font-family:inherit; }
      .gc-pill-btn:hover { background:var(--s-card-hover); }
      .gc-help { margin:6px 0 0; font-size:12px; color:var(--s-text-muted); }
      .gc-search { position:relative; }
      .gc-search-icon { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--s-text-muted); }
      .gc-search input { padding-left:34px; }
      .gc-icon-btn { background:none; border:none; cursor:pointer; color:var(--s-text-muted); padding:4px; border-radius:4px; }
      .gc-icon-btn:hover { background:var(--s-card-hover); color:var(--s-text); }
      .gc-muted { color:var(--s-text-muted); font-size:13px; }
      .gc-actions { position:sticky; bottom:0; display:flex; justify-content:flex-end; padding:12px 0; margin-top:16px; background:linear-gradient(to top, var(--s-bg) 60%, transparent); }
      .gc-btn-primary { background:var(--s-accent); color:#fff; border:none; padding:9px 22px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; transition:background .15s; font-family:inherit; }
      .gc-btn-primary:hover { background:var(--s-accent-hover); }
    </style>

    <div class="gc-form">
      <div class="gc-topbar">
        <a href="${base}/products/gift-cards" class="gc-crumb" title="Back">🎁</a>
        <span class="gc-crumb">›</span>
        <h1>Create gift card</h1>
      </div>

      <form method="POST" action="${base}/gift-cards" id="gc-create-form">
        <input type="hidden" name="_csrf" value="${csrf}" />
        <input type="hidden" name="currency" value="VND" />
        <input type="hidden" name="sender_name" value="${esc(store.name)}" />

        <div class="gc-grid">
          <!-- LEFT — Gift card details -->
          <div class="gc-col">
            <section class="gc-card">
              <h3 class="gc-section" style="margin-bottom:14px">Gift card details</h3>

              <div class="gc-field">
                <label class="gc-label" for="gc-code">Gift card code</label>
                <input id="gc-code" type="text" name="code" value="${esc(autoCode)}" class="gc-input gc-input-mono" autocomplete="off"/>
              </div>

              <div class="gc-row-2">
                <div class="gc-field" style="margin-bottom:0">
                  <label class="gc-label" for="gc-initial">Initial value</label>
                  <div class="gc-input-prefixwrap">
                    <span class="gc-input-prefix">đ</span>
                    <input id="gc-initial" type="number" name="initial_value" min="0" step="1" value="10" required class="gc-input gc-input-with-prefix"/>
                  </div>
                </div>
                <div class="gc-field" style="margin-bottom:0">
                  <label class="gc-label">Expiry date</label>
                  <button type="button" class="gc-pill-btn" id="gc-expiry-btn">
                    <span style="font-size:14px">📅</span> <span id="gc-expiry-label">Doesn't expire</span>
                  </button>
                  <input type="hidden" name="expires_at" id="gc-expiry-input" value=""/>
                  <p class="gc-help">Gift card expiration laws can vary by country</p>
                </div>
              </div>
            </section>
          </div>

          <!-- RIGHT — Customer + Notes -->
          <aside class="gc-col">
            <section class="gc-card">
              <h3 class="gc-section" style="margin-bottom:12px">Customer</h3>
              <div class="gc-search">
                <span class="gc-search-icon">🔍</span>
                <input type="email" name="recipient_email" placeholder="Search or create customer" class="gc-input" autocomplete="off"/>
              </div>
            </section>

            <section class="gc-card">
              <div class="gc-card-head">
                <h3 class="gc-section">Notes</h3>
                <button type="button" class="gc-icon-btn" id="gc-notes-edit" title="Edit notes">✎</button>
              </div>
              <div id="gc-notes-view" class="gc-muted">No notes</div>
              <textarea name="note" id="gc-notes-input" rows="3" class="gc-input" style="display:none;resize:vertical" placeholder="Add a note (not shown to recipient)"></textarea>
            </section>
          </aside>
        </div>

        <div class="gc-actions">
          <button type="submit" class="gc-btn-primary">Save</button>
        </div>
      </form>
    </div>

    <script>
      (function(){
        // Expiry toggle: cycle "Doesn't expire" -> date picker -> back
        var btn = document.getElementById('gc-expiry-btn');
        var label = document.getElementById('gc-expiry-label');
        var hidden = document.getElementById('gc-expiry-input');
        if (btn) {
          btn.addEventListener('click', function(){
            // Replace pill with native date input on first click
            if (btn.dataset.mode !== 'date') {
              btn.dataset.mode = 'date';
              var d = document.createElement('input');
              d.type = 'date';
              d.name = 'expires_at';
              d.className = 'gc-input';
              d.style.maxWidth = '200px';
              d.addEventListener('change', function(){ hidden.value = d.value; });
              btn.replaceWith(d);
              if (hidden.parentNode) hidden.parentNode.removeChild(hidden);
              d.focus();
            }
          });
        }

        // Notes: click pencil to reveal textarea
        var notesBtn = document.getElementById('gc-notes-edit');
        var notesView = document.getElementById('gc-notes-view');
        var notesInput = document.getElementById('gc-notes-input');
        if (notesBtn && notesView && notesInput) {
          notesBtn.addEventListener('click', function(){
            notesView.style.display = 'none';
            notesInput.style.display = 'block';
            notesInput.focus();
          });
          notesInput.addEventListener('blur', function(){
            if (!notesInput.value.trim()) {
              notesView.style.display = 'block';
              notesInput.style.display = 'none';
            }
          });
        }
      })();
    </script>
  `

  res.send(sellerLayout({
    title: 'Create gift card',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'products',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// Generate a Shopify-style 16-char lowercase alphanumeric gift card code.
// Uses crypto.randomInt for unbiased distribution; falls back to Math.random
// if crypto is unavailable for any reason (extremely unlikely in Node).
function generateGiftCardCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  try {
    // Lazy require so this file stays browser-friendly if ever bundled.
    const { randomInt } = require('node:crypto') as typeof import('node:crypto')
    for (let i = 0; i < 16; i++) out += chars[randomInt(0, chars.length)]
  } catch {
    for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)]
  }
  return out
}

// ---------------------------------------------------------------------------
// GET /products/gift-cards/product/new — Add gift card product form
// (Shopify-style; posts to existing /products with product_type=gift_card)
// ---------------------------------------------------------------------------

export async function getCreateGiftCardProduct(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const csrf = String((req as any).csrfToken || '')

  const content = renderGiftCardProductForm({ base, csrf, storeName: store.name })

  res.send(sellerLayout({
    title: 'Create gift card product',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'products',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /gift-cards — Create (now accepts recipient + optional immediate send)
// ---------------------------------------------------------------------------

export async function postCreateGiftCard(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const {
    initial_value,
    code,
    currency,
    expires_at,
    note,
    recipient_email,
    recipient_name,
    sender_name,
    personal_message,
    send_at,
  } = req.body

  try {
    const parsedSendAt = parseSendAt(send_at)
    const hasRecipient = typeof recipient_email === 'string' && recipient_email.trim().length > 0
    // If there's a recipient and no explicit future send_at, queue immediate send.
    const effectiveSendAt = hasRecipient
      ? (parsedSendAt && new Date(parsedSendAt) > new Date() ? parsedSendAt : new Date().toISOString())
      : null

    const card = await createGiftCard(db, store.id, {
      initialValue: initial_value,
      code: code || undefined,
      currency: currency || 'USD',
      note: note || null,
      expiresAt: expires_at || null,
      recipientEmail: hasRecipient ? String(recipient_email).trim() : null,
      recipientName: typeof recipient_name === 'string' && recipient_name.trim() ? recipient_name.trim() : null,
      senderName: typeof sender_name === 'string' && sender_name.trim() ? sender_name.trim() : store.name,
      personalMessage: typeof personal_message === 'string' && personal_message.trim() ? personal_message.trim() : null,
      sendAt: effectiveSendAt,
    })

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'gift_card_created',
      title: `Gift card created: ${(currency || 'USD')} ${initial_value}`,
      message: [hasRecipient ? `To ${String(recipient_email).trim()}` : null, byActor(user)].filter(Boolean).join(' • '),
      resourceType: 'gift_card',
      resourceId: card.id,
    })

    // If the recipient is set AND the scheduled time is now / in the past,
    // fire-and-report the email immediately. We don't throw on send failure —
    // the cron will retry on the next tick.
    if (hasRecipient && effectiveSendAt && new Date(effectiveSendAt) <= new Date()) {
      const outcome = await deliverGiftCardNow(db, card.id).catch((err) => ({
        giftCardId: card.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        recipient: recipient_email,
      }))
      if (outcome.ok) {
        res.redirect(`/admin/store/${store.slug}/gift-cards?success=Gift+card+created+and+emailed`)
        return
      } else {
        res.redirect(`/admin/store/${store.slug}/gift-cards/${card.id}?error=${encodeURIComponent('Gift card created, but email failed. Try again from the detail page.')}`)
        return
      }
    }

    res.redirect(`/admin/store/${store.slug}/gift-cards?success=Gift+card+created`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/gift-cards/new?error=${encodeURIComponent(safeFlashMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// GET /gift-cards/:giftCardId — Detail page
// ---------------------------------------------------------------------------

export async function getGiftCardDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const id = req.params.giftCardId

  try {
    const card = await getGiftCardById(db, id) as any
    if (!card || card.shop_id !== store.id) {
      res.redirect(`/admin/store/${store.slug}/gift-cards?error=${encodeURIComponent('Gift card not found.')}`)
      return
    }

    const isDisabled = !!card.disabled_at
    const isExpired = card.expires_at && new Date(card.expires_at) < new Date()
    const status = isDisabled ? 'Disabled' : isExpired ? 'Expired' : 'Active'
    const statusColor = isDisabled ? '#ef4444' : isExpired ? '#f59e0b' : '#34d399'
    const flash = typeof req.query.success === 'string' ? `<div class="banner" style="background:#064e3b;color:#d1fae5;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px">✓ ${esc(req.query.success)}</div>` :
      typeof req.query.error === 'string' ? `<div class="banner" style="background:#7f1d1d;color:#fecaca;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(req.query.error)}</div>` : ''

    const deliveryBlock = card.recipient_email ? `
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px;margin-bottom:16px">
        <h3 style="margin:0 0 12px;font-size:14px;font-weight:700">Delivery</h3>
        <dl style="display:grid;grid-template-columns:160px 1fr;gap:8px 16px;font-size:13px;margin:0">
          <dt style="color:var(--s-text-secondary)">Recipient Email</dt><dd style="margin:0">${esc(card.recipient_email)}</dd>
          <dt style="color:var(--s-text-secondary)">Recipient Name</dt><dd style="margin:0">${esc(card.recipient_name || '-')}</dd>
          <dt style="color:var(--s-text-secondary)">Sender</dt><dd style="margin:0">${esc(card.sender_name || store.name)}</dd>
          <dt style="color:var(--s-text-secondary)">Scheduled</dt><dd style="margin:0">${card.send_at ? esc(new Date(card.send_at).toLocaleString()) : '-'}</dd>
          <dt style="color:var(--s-text-secondary)">Email Sent</dt><dd style="margin:0">${card.email_sent_at ? `<span style="color:#34d399">✓ ${esc(new Date(card.email_sent_at).toLocaleString())}</span>` : `<span style="color:#f59e0b">Pending</span>`}</dd>
          ${card.personal_message ? `<dt style="color:var(--s-text-secondary)">Message</dt><dd style="margin:0;white-space:pre-wrap">${esc(card.personal_message)}</dd>` : ''}
        </dl>
        ${!isDisabled ? `
        <form method="POST" action="/admin/store/${esc(store.slug)}/gift-cards/${esc(card.id)}/send-email" style="margin-top:14px">
          <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
          <button type="submit" class="btn btn-primary" style="padding:8px 16px;font-size:13px;font-weight:600;border-radius:6px">${card.email_sent_at ? 'Resend email' : 'Send email now'}</button>
        </form>` : ''}
      </div>
    ` : `
      <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px;margin-bottom:16px">
        <h3 style="margin:0 0 8px;font-size:14px;font-weight:700">Delivery</h3>
        <p style="margin:0;font-size:13px;color:var(--s-text-secondary)">Internal card — no recipient on file. Copy the code above and share it manually.</p>
      </div>
    `

    const content = `
      ${flash}
      <div class="page-header" style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <a href="/admin/store/${esc(store.slug)}/gift-cards" style="color:var(--s-text-secondary);text-decoration:none;font-size:13px">&larr; Gift Cards</a>
      </div>

      <div style="display:grid;grid-template-columns:2fr 1fr;gap:20px;align-items:start">
        <div>
          <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:24px;margin-bottom:16px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px">
              <div>
                <div style="font-size:12px;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:1px">Code</div>
                <div style="font-family:monospace;font-size:22px;font-weight:700;margin-top:4px;letter-spacing:2px">${esc(card.code)}</div>
              </div>
              <span class="badge" style="font-size:12px;padding:4px 10px;background:var(--s-bg);border:1px solid var(--s-border);border-radius:999px;color:${statusColor};font-weight:600">${status}</span>
            </div>
            <dl style="display:grid;grid-template-columns:160px 1fr;gap:8px 16px;font-size:13px;margin:0">
              <dt style="color:var(--s-text-secondary)">Initial value</dt><dd style="margin:0">$${esc(card.initial_value)}</dd>
              <dt style="color:var(--s-text-secondary)">Current balance</dt><dd style="margin:0;font-weight:700">$${esc(card.balance)}</dd>
              <dt style="color:var(--s-text-secondary)">Redeemed total</dt><dd style="margin:0">$${esc((card.redeemed_amount ?? '0.00'))}</dd>
              <dt style="color:var(--s-text-secondary)">Currency</dt><dd style="margin:0">${esc(card.currency)}</dd>
              <dt style="color:var(--s-text-secondary)">Created</dt><dd style="margin:0">${esc(new Date(card.created_at).toLocaleString())}</dd>
              <dt style="color:var(--s-text-secondary)">Expires</dt><dd style="margin:0">${card.expires_at ? esc(new Date(card.expires_at).toLocaleString()) : 'Never'}</dd>
              <dt style="color:var(--s-text-secondary)">Last redeemed</dt><dd style="margin:0">${card.last_redeemed_at ? esc(new Date(card.last_redeemed_at).toLocaleString()) : '-'}</dd>
              ${card.note ? `<dt style="color:var(--s-text-secondary)">Internal note</dt><dd style="margin:0;white-space:pre-wrap">${esc(card.note)}</dd>` : ''}
            </dl>
          </div>
          ${deliveryBlock}
        </div>

        <div>
          ${!isDisabled ? `
          <div class="card" style="background:var(--s-surface);border:1px solid var(--s-border);border-radius:10px;padding:20px">
            <h3 style="margin:0 0 10px;font-size:14px;font-weight:700">Danger zone</h3>
            <p style="margin:0 0 12px;font-size:12px;color:var(--s-text-secondary)">Disable this gift card so it can no longer be redeemed. The code cannot be reused.</p>
            <form method="POST" action="/admin/store/${esc(store.slug)}/gift-cards/${esc(card.id)}/disable">
              <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
              <button type="submit" class="btn btn-sm" style="padding:8px 14px;font-size:12px;background:var(--s-bg);border:1px solid #7f1d1d;border-radius:6px;color:#fca5a5;cursor:pointer;font-weight:600" onclick="return confirm('Disable this gift card?')">Disable gift card</button>
            </form>
          </div>` : `
          <div class="card" style="background:var(--s-surface);border:1px solid #7f1d1d;border-radius:10px;padding:20px">
            <h3 style="margin:0 0 6px;font-size:14px;font-weight:700;color:#fca5a5">Disabled</h3>
            <p style="margin:0;font-size:12px;color:var(--s-text-secondary)">Disabled on ${esc(new Date(card.disabled_at).toLocaleString())}.</p>
          </div>`}
        </div>
      </div>
    `

    res.send(sellerLayout({
      title: `Gift Card ${card.code.slice(-4)}`,
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }))
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/gift-cards?error=${encodeURIComponent(safeFlashMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// POST /gift-cards/:giftCardId/send-email — Send / resend delivery
// ---------------------------------------------------------------------------

export async function postSendGiftCardEmail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const id = req.params.giftCardId

  try {
    // Verify scope before delivery — `deliverGiftCardNow` doesn't filter by shop.
    const card = await getGiftCardById(db, id) as any
    if (!card || card.shop_id !== store.id) {
      res.redirect(`/admin/store/${store.slug}/gift-cards?error=${encodeURIComponent('Gift card not found.')}`)
      return
    }

    const outcome = await deliverGiftCardNow(db, id)
    if (outcome.ok) {
      notify(db, {
        shopId: store.id,
        userId: user?.id,
        type: 'gift_card_emailed',
        title: 'Gift card email sent',
        message: [`To ${outcome.recipient}`, byActor(user)].filter(Boolean).join(' • '),
        resourceType: 'gift_card',
        resourceId: id,
      })
      res.redirect(`/admin/store/${store.slug}/gift-cards/${id}?success=Email+sent`)
    } else {
      res.redirect(`/admin/store/${store.slug}/gift-cards/${id}?error=${encodeURIComponent('Could not send the email. Please try again.')}`)
    }
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/gift-cards/${id}?error=${encodeURIComponent(safeFlashMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// POST /gift-cards/:id/update — Partial patch (recipient, note, expiry)
// ---------------------------------------------------------------------------

export async function postUpdateGiftCard(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const id = req.params.giftCardId

  try {
    const card = await getGiftCardById(db, id) as any
    if (!card || card.shop_id !== store.id) {
      res.redirect(`/admin/store/${store.slug}/gift-cards?error=${encodeURIComponent('Gift card not found.')}`)
      return
    }

    const {
      recipient_email,
      recipient_name,
      sender_name,
      personal_message,
      send_at,
      note,
      expires_at,
    } = req.body

    await updateGiftCard(db, id, {
      recipientEmail: typeof recipient_email === 'string' ? (recipient_email.trim() || null) : undefined,
      recipientName: typeof recipient_name === 'string' ? (recipient_name.trim() || null) : undefined,
      senderName: typeof sender_name === 'string' ? (sender_name.trim() || null) : undefined,
      personalMessage: typeof personal_message === 'string' ? (personal_message.trim() || null) : undefined,
      sendAt: typeof send_at === 'string' ? parseSendAt(send_at) : undefined,
      note: typeof note === 'string' ? (note.trim() || null) : undefined,
      expiresAt: typeof expires_at === 'string' ? (expires_at.trim() || null) : undefined,
    })

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'gift_card_updated',
      title: 'Gift card updated',
      message: byActor(user),
      resourceType: 'gift_card',
      resourceId: id,
    })

    res.redirect(`/admin/store/${store.slug}/gift-cards/${id}?success=Gift+card+updated`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/gift-cards/${id}?error=${encodeURIComponent(safeFlashMessage(err))}`)
  }
}

// ---------------------------------------------------------------------------
// POST /gift-cards/:id/disable — Disable a gift card
// ---------------------------------------------------------------------------

export async function postDisableGiftCard(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  try {
    const card = await getGiftCardById(db, req.params.giftCardId) as any
    if (!card || card.shop_id !== store.id) {
      res.redirect(`/admin/store/${store.slug}/gift-cards?error=${encodeURIComponent('Gift card not found.')}`)
      return
    }
    await disableGiftCard(db, req.params.giftCardId)
    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'gift_card_disabled',
      title: `Gift card disabled`,
      message: byActor(user),
      resourceType: 'gift_card',
      resourceId: req.params.giftCardId,
    })
    res.redirect(`/admin/store/${store.slug}/gift-cards?success=Gift+card+disabled`)
  } catch (err: any) {
    res.redirect(`/admin/store/${store.slug}/gift-cards?error=${encodeURIComponent(safeFlashMessage(err))}`)
  }
}

// `safeFlashMessage` is re-exported from ../lib/gift-cards-flash.ts to
// keep the smoke test's import graph free of the full admin server (which
// transitively pulls in the AI SDK via other pages' handlers). The smoke
// imports the symbol from that dep-free module directly.
