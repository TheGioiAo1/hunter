/**
 * Store Admin — Campaigns (Phase 8 PR1)
 *
 * Full CRUD + lifecycle UI for email marketing campaigns. Replaces the
 * Phase 7 read-only shell. The cron driver in `core/modules/marketing/
 * campaigns-cron.ts` picks up scheduled campaigns every 5 min; this file
 * is the merchant-facing surface that creates and edits them.
 *
 * Routes (wired in server.ts):
 *   GET  /admin/store/:slug/marketing/campaigns              → list
 *   GET  /admin/store/:slug/marketing/campaigns/new          → create form
 *   GET  /admin/store/:slug/marketing/campaigns/:id          → edit / detail
 *   POST /admin/store/:slug/marketing/campaigns/create       → insert
 *   POST /admin/store/:slug/marketing/campaigns/:id/update   → patch
 *   POST /admin/store/:slug/marketing/campaigns/:id/schedule → draft → scheduled
 *   POST /admin/store/:slug/marketing/campaigns/:id/cancel   → scheduled → draft
 *   POST /admin/store/:slug/marketing/campaigns/:id/delete   → hard delete
 *
 * Readonly lock: campaigns in terminal states (`sent`, `failed`, `sending`)
 * render as a stats card instead of a form. Only `draft` and `scheduled`
 * are editable. Attempts to mutate a terminal row are rejected server-side
 * by `updateCampaign` which returns `immutable_status`.
 *
 * Seller-facing error on SMTP-not-configured (from cron): "Please contact
 * Gbox support." — satisfies CLAUDE.md Rule 5 (no god-admin leak).
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { logSellerAction } from '../middleware/store-auth.js'
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  scheduleCampaign,
  cancelScheduled,
  type CampaignRow,
  type CampaignStatus,
} from '@gbox/core/modules/marketing/campaigns.js'

// ---------------------------------------------------------------------------
// Labels / flash dictionary
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const STATUS_BADGES: Record<CampaignStatus, string> = {
  draft: 'badge-secondary',
  scheduled: 'badge-info',
  sending: 'badge-warning',
  sent: 'badge-success',
  failed: 'badge-danger',
  cancelled: 'badge-secondary',
}

const FLASH_MESSAGES: Record<string, string> = {
  campaign_created: 'Campaign created.',
  campaign_updated: 'Campaign updated.',
  campaign_deleted: 'Campaign deleted.',
  campaign_scheduled: 'Campaign scheduled.',
  campaign_cancelled: 'Schedule cancelled — back to draft.',
  name_required: 'Campaign name is required.',
  name_too_long: 'Campaign name is too long (max 255 characters).',
  subject_required: 'Subject line is required.',
  subject_too_long: 'Subject line is too long (max 500 characters).',
  body_required: 'Email body is required.',
  not_found: 'Campaign not found.',
  immutable_status: 'This campaign has already been sent — edits are locked.',
  not_deletable: 'Only draft or cancelled campaigns can be deleted.',
  wrong_status: 'Campaign is in the wrong state for this action.',
  send_at_required: 'Please pick a date & time to send.',
  send_at_in_past: 'Send time must be in the future.',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flashBanner(req: Request): string {
  const ok = req.query.ok ? String(req.query.ok) : ''
  const err = req.query.error ? String(req.query.error) : ''
  if (ok) {
    const msg = FLASH_MESSAGES[ok] || ok
    return `<div class="alert alert-success" style="margin-bottom:16px;padding:12px 16px;border-radius:8px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);color:#059669;font-size:14px">✓ ${esc(msg)}</div>`
  }
  if (err) {
    const msg = FLASH_MESSAGES[err] || err
    return `<div class="alert alert-danger" style="margin-bottom:16px;padding:12px 16px;border-radius:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#dc2626;font-size:14px">✗ ${esc(msg)}</div>`
  }
  return ''
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function safeRedirect(
  res: Response,
  base: string,
  path: string,
  flash: { ok?: string; error?: string },
): void {
  const q: string[] = []
  if (flash.ok) q.push(`ok=${encodeURIComponent(flash.ok)}`)
  if (flash.error) q.push(`error=${encodeURIComponent(flash.error)}`)
  const qs = q.length > 0 ? `?${q.join('&')}` : ''
  res.redirect(`${base}/marketing/campaigns${path}${qs}`)
}

function datetimeLocalValue(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // datetime-local needs YYYY-MM-DDTHH:MM in local time
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// GET /marketing/campaigns — list page with tabs + search + pagination
// ---------------------------------------------------------------------------

export async function getCampaignsList(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const tab = (req.query.tab ? String(req.query.tab) : 'all').toLowerCase()
  const search = req.query.q ? String(req.query.q).trim() : ''
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = 20
  const offset = (page - 1) * pageSize

  const statusFilter: CampaignStatus[] | undefined = (() => {
    switch (tab) {
      case 'draft':
        return ['draft']
      case 'scheduled':
        return ['scheduled', 'sending']
      case 'sent':
        return ['sent']
      case 'failed':
        return ['failed', 'cancelled']
      default:
        return undefined
    }
  })()

  const { rows, total } = await listCampaigns(db as any, store.id, {
    status: statusFilter,
    search,
    limit: pageSize,
    offset,
  })

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'draft', label: 'Drafts' },
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'sent', label: 'Sent' },
    { key: 'failed', label: 'Failed' },
  ]

  const qsFor = (overrides: Record<string, string | number>): string => {
    const params: Record<string, string> = {}
    if (tab && tab !== 'all') params.tab = tab
    if (search) params.q = search
    if (page > 1) params.page = String(page)
    Object.assign(params, overrides as Record<string, string>)
    const kv = Object.entries(params)
      .filter(([, v]) => v !== '' && v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
    return kv ? `?${kv}` : ''
  }

  const content = `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px">
      <div>
        <a href="${base}/marketing" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; Marketing
        </a>
        <h1 class="page-title">Campaigns</h1>
        <p class="page-subtitle">Send email campaigns to your subscribers.</p>
      </div>
      <div>
        <a href="${base}/marketing/campaigns/new" class="btn btn-primary">+ New campaign</a>
      </div>
    </div>

    ${flashBanner(req)}

    <div class="card" style="margin-bottom:16px">
      <div class="card-header" style="padding:0 16px">
        <div style="display:flex;gap:4px;overflow-x:auto">
          ${tabs
            .map(
              (t) => `
                <a href="${base}/marketing/campaigns${t.key === 'all' ? '' : `?tab=${t.key}`}"
                   style="padding:12px 16px;font-size:14px;font-weight:500;text-decoration:none;border-bottom:2px solid ${tab === t.key ? 'var(--s-accent)' : 'transparent'};color:${tab === t.key ? 'var(--s-accent)' : 'var(--s-text-dim)'};white-space:nowrap">
                  ${esc(t.label)}
                </a>`,
            )
            .join('')}
        </div>
      </div>
      <div class="card-body" style="padding:12px 16px;border-top:1px solid var(--s-border)">
        <form method="GET" action="${base}/marketing/campaigns" style="display:flex;gap:8px">
          ${tab !== 'all' ? `<input type="hidden" name="tab" value="${esc(tab)}">` : ''}
          <input type="search" name="q" value="${esc(search)}" placeholder="Search by name or subject…" class="input" style="flex:1;min-width:0">
          <button type="submit" class="btn btn-outline">Search</button>
          ${search ? `<a href="${base}/marketing/campaigns${tab !== 'all' ? `?tab=${tab}` : ''}" class="btn btn-ghost">Clear</a>` : ''}
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-body" style="padding:0">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th style="text-align:right">Recipients</th>
                <th style="text-align:right">Opens</th>
                <th style="text-align:right">Clicks</th>
                <th>Scheduled / Sent</th>
              </tr>
            </thead>
            <tbody>
              ${
                rows.length === 0
                  ? `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--s-text-dim)">
                       <div style="font-size:28px;margin-bottom:8px">📭</div>
                       <div style="font-weight:600;margin-bottom:4px">${search ? 'No campaigns match your search.' : 'No campaigns yet'}</div>
                       <div style="font-size:13px">${search ? 'Try a different search term.' : 'Click "New campaign" to send your first email.'}</div>
                     </td></tr>`
                  : rows.map((r) => renderRow(base, r)).join('')
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    ${
      totalPages > 1
        ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;font-size:13px;color:var(--s-text-dim)">
             <div>Page ${page} of ${totalPages} — ${total} total</div>
             <div style="display:flex;gap:8px">
               ${page > 1 ? `<a href="${base}/marketing/campaigns${qsFor({ page: page - 1 })}" class="btn btn-outline btn-sm">&larr; Previous</a>` : ''}
               ${page < totalPages ? `<a href="${base}/marketing/campaigns${qsFor({ page: page + 1 })}" class="btn btn-outline btn-sm">Next &rarr;</a>` : ''}
             </div>
           </div>`
        : ''
    }
  `

  res.send(
    sellerLayout({
      title: 'Campaigns',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'marketing',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

function renderRow(base: string, r: CampaignRow): string {
  const stamp =
    r.sent_at != null
      ? `Sent ${formatDate(r.sent_at)}`
      : r.scheduled_at != null
        ? `Scheduled ${formatDate(r.scheduled_at)}`
        : formatDate(r.created_at)
  return `
    <tr>
      <td>
        <a href="${base}/marketing/campaigns/${esc(r.id)}" style="font-weight:600;color:var(--s-text);text-decoration:none">
          ${esc(r.name)}
        </a>
        <div style="font-size:12px;color:var(--s-text-dim);margin-top:2px">${esc(r.subject)}</div>
      </td>
      <td><span class="badge ${STATUS_BADGES[r.status]}">${STATUS_LABELS[r.status]}</span></td>
      <td style="text-align:right">${r.recipient_count}</td>
      <td style="text-align:right">${r.opened_count}</td>
      <td style="text-align:right">${r.clicked_count}</td>
      <td style="font-size:12px;color:var(--s-text-dim)">${esc(stamp)}</td>
    </tr>
  `
}

// ---------------------------------------------------------------------------
// GET /marketing/campaigns/new or /:id — create + edit share a renderer
// ---------------------------------------------------------------------------

export async function getCampaignEditor(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrf = String((req as any).csrfToken || '')

  const id = req.params.id ? String(req.params.id) : ''
  const isNew = !id || id === 'new'

  let row: CampaignRow | null = null
  if (!isNew) {
    row = await getCampaign(db as any, store.id, id)
    if (!row) {
      safeRedirect(res, base, '', { error: 'not_found' })
      return
    }
  }

  const editable =
    isNew || (row && (row.status === 'draft' || row.status === 'scheduled'))
  const terminal =
    !isNew && row && (row.status === 'sent' || row.status === 'failed' || row.status === 'sending')

  const title = isNew ? 'New campaign' : `Edit: ${row!.name}`
  const formAction = isNew
    ? `${base}/marketing/campaigns/create`
    : `${base}/marketing/campaigns/${esc(id)}/update`

  const statsCard =
    !isNew && row
      ? `
        <div class="card" style="margin-bottom:20px">
          <div class="card-header">
            <span>Delivery stats</span>
            <span class="badge ${STATUS_BADGES[row.status]}" style="margin-left:auto">${STATUS_LABELS[row.status]}</span>
          </div>
          <div class="card-body">
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">
              <div>
                <div class="stat-label">Recipients</div>
                <div class="stat-value">${row.recipient_count}</div>
              </div>
              <div>
                <div class="stat-label">Opened</div>
                <div class="stat-value">${row.opened_count}</div>
                <div style="font-size:12px;color:var(--s-text-dim)">${row.recipient_count > 0 ? ((row.opened_count / row.recipient_count) * 100).toFixed(1) : '0.0'}% open rate</div>
              </div>
              <div>
                <div class="stat-label">Clicked</div>
                <div class="stat-value">${row.clicked_count}</div>
                <div style="font-size:12px;color:var(--s-text-dim)">${row.recipient_count > 0 ? ((row.clicked_count / row.recipient_count) * 100).toFixed(1) : '0.0'}% click rate</div>
              </div>
              <div>
                <div class="stat-label">Sent at</div>
                <div style="font-weight:600;font-size:14px">${esc(formatDate(row.sent_at))}</div>
              </div>
            </div>
            ${
              row.error
                ? `<div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);font-size:13px;color:#dc2626">
                     <strong>Delivery error:</strong> ${esc(row.error)}
                   </div>`
                : ''
            }
          </div>
        </div>`
      : ''

  const formDisabled = terminal ? 'disabled' : ''

  const scheduleBlock =
    !isNew && row && row.status === 'draft'
      ? `
        <div class="card" style="margin-bottom:20px">
          <div class="card-header"><span>Schedule send</span></div>
          <div class="card-body">
            <form method="POST" action="${base}/marketing/campaigns/${esc(id)}/schedule" style="display:flex;gap:12px;align-items:flex-end">
              ${csrfHiddenField(csrf)}
              <div style="flex:1">
                <label class="form-label">Send at</label>
                <input type="datetime-local" name="send_at" required class="input" style="width:100%">
              </div>
              <button type="submit" class="btn btn-primary">Schedule</button>
            </form>
            <div style="margin-top:8px;font-size:12px;color:var(--s-text-dim)">Campaign will be sent within 5 minutes of the scheduled time (cron tick rate).</div>
          </div>
        </div>`
      : !isNew && row && row.status === 'scheduled'
        ? `
        <div class="card" style="margin-bottom:20px">
          <div class="card-header"><span>Scheduled for ${esc(formatDate(row.scheduled_at))}</span></div>
          <div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
            <div style="font-size:13px;color:var(--s-text-dim)">Campaign will dispatch on the next cron tick after this time. You can still edit name/subject/body until it starts sending.</div>
            <form method="POST" action="${base}/marketing/campaigns/${esc(id)}/cancel">
              ${csrfHiddenField(csrf)}
              <button type="submit" class="btn btn-outline">Cancel schedule</button>
            </form>
          </div>
        </div>`
        : ''

  const deleteBlock =
    !isNew && row && (row.status === 'draft' || row.status === 'cancelled')
      ? `
        <div class="card" style="margin-top:20px;border-color:rgba(239,68,68,.3)">
          <div class="card-header" style="color:#dc2626"><span>Danger zone</span></div>
          <div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
            <div style="font-size:13px;color:var(--s-text-dim)">Permanently delete this campaign. Can't be undone.</div>
            <form method="POST" action="${base}/marketing/campaigns/${esc(id)}/delete" onsubmit="return confirm('Delete this campaign? This cannot be undone.')">
              ${csrfHiddenField(csrf)}
              <button type="submit" class="btn btn-danger">Delete campaign</button>
            </form>
          </div>
        </div>`
      : ''

  const content = `
    <div class="page-header" style="margin-bottom:20px">
      <a href="${base}/marketing/campaigns" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
        &larr; Campaigns
      </a>
      <h1 class="page-title">${esc(title)}</h1>
      ${!isNew && row ? `<p class="page-subtitle">Created ${esc(formatDate(row.created_at))}</p>` : ''}
    </div>

    ${flashBanner(req)}
    ${statsCard}
    ${scheduleBlock}

    ${
      terminal
        ? ''
        : `
    <div class="card" id="aiAssistCard" style="margin-bottom:20px;border:1px dashed var(--s-border)">
      <div class="card-header" style="display:flex;align-items:center;gap:10px">
        <span style="font-size:16px">&#10024;</span>
        <span>AI assist <span style="color:var(--s-text-dim);font-weight:400;font-size:12px">(uses your configured provider from Settings &gt; AI)</span></span>
      </div>
      <div class="card-body">
        <div class="form-row" style="margin-bottom:12px">
          <label class="form-label" for="aiGoal">Campaign goal</label>
          <input type="text" id="aiGoal" class="input" style="width:100%"
                 placeholder="e.g. announce spring sale, recover abandoned carts, winback dormant customers">
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:220px">
            <label class="form-label" for="aiSegment">Audience segment</label>
            <input type="text" id="aiSegment" class="input" style="width:100%"
                   placeholder="all_subscribers, repeat_customers, abandoned_carts">
          </div>
          <div style="flex:1;min-width:180px">
            <label class="form-label" for="aiIncentive">Incentive (optional)</label>
            <input type="text" id="aiIncentive" class="input" style="width:100%"
                   placeholder="10% off, free shipping">
          </div>
        </div>
        <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
          <button type="button" id="aiSuggestBtn" class="btn btn-primary">Generate with AI</button>
          <span id="aiMsg" style="font-size:12px;color:var(--s-text-dim)"></span>
        </div>
      </div>
    </div>
    <script>
      (function(){
        var btn = document.getElementById('aiSuggestBtn'); if (!btn) return;
        var msgEl = document.getElementById('aiMsg');
        btn.addEventListener('click', function(){
          var goal = (document.getElementById('aiGoal').value || '').trim();
          if (!goal) { msgEl.textContent = 'Please enter a goal first.'; return; }
          btn.disabled = true; msgEl.textContent = 'Thinking…';
          var csrfEl = document.querySelector('input[name="csrf_token"]');
          fetch('${base}/api/ai/campaign-suggestion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfEl ? csrfEl.value : '' },
            body: JSON.stringify({
              campaignGoal: goal,
              segmentLabel: (document.getElementById('aiSegment').value || '').trim(),
              incentive: (document.getElementById('aiIncentive').value || '').trim(),
              locale: document.documentElement.getAttribute('lang') || 'en',
            }),
          })
          .then(function(r){ return r.json(); })
          .then(function(data){
            btn.disabled = false;
            if (!data || !data.ok) { msgEl.textContent = (data && data.error) || 'AI request failed.'; return; }
            if (data.campaign && data.campaign.subject_lines && data.campaign.subject_lines.length) {
              document.getElementById('subject').value = data.campaign.subject_lines[0];
            }
            if (data.campaign && data.campaign.body_html) {
              document.getElementById('body_html').value = data.campaign.body_html;
            }
            msgEl.textContent = 'Filled subject + body. Review before saving.';
          })
          .catch(function(){ btn.disabled = false; msgEl.textContent = 'AI request failed. Please try again.'; });
        });
      })();
    </script>`
    }

    <div class="card">
      <div class="card-header"><span>${terminal ? 'Campaign content (read-only)' : 'Campaign content'}</span></div>
      <div class="card-body">
        <form method="POST" action="${formAction}">
          ${csrfHiddenField(csrf)}

          <div class="form-row" style="margin-bottom:16px">
            <label class="form-label" for="name">Internal name <span style="color:#dc2626">*</span></label>
            <input type="text" id="name" name="name" maxlength="255" required ${formDisabled}
                   value="${esc(row?.name ?? '')}"
                   class="input" style="width:100%"
                   placeholder="e.g. Spring sale — loyal customers">
            <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">Only visible to you. Not shown to recipients.</div>
          </div>

          <div class="form-row" style="margin-bottom:16px">
            <label class="form-label" for="subject">Subject line <span style="color:#dc2626">*</span></label>
            <input type="text" id="subject" name="subject" maxlength="500" required ${formDisabled}
                   value="${esc(row?.subject ?? '')}"
                   class="input" style="width:100%"
                   placeholder="e.g. 20% off everything — this weekend only">
          </div>

          <div class="form-row" style="margin-bottom:16px">
            <label class="form-label" for="audience_segment">Audience (tag)</label>
            <input type="text" id="audience_segment" name="audience_segment" ${formDisabled}
                   value="${esc(row?.audience_segment ?? '')}"
                   class="input" style="width:100%"
                   placeholder="Leave empty to send to all subscribers">
            <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">Matches customers whose tag list contains this value. Always filtered to subscribers only (accepts_marketing = true).</div>
          </div>

          <div class="form-row" style="margin-bottom:16px">
            <label class="form-label" for="body_html">Email body (HTML) <span style="color:#dc2626">*</span></label>
            <textarea id="body_html" name="body_html" rows="14" required ${formDisabled}
                      class="input" style="width:100%;font-family:ui-monospace,monospace;font-size:13px;line-height:1.5"
                      placeholder="<p>Hi there — our spring sale starts now…</p>">${esc(row?.body_html ?? '')}</textarea>
            <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">HTML allowed. Plain text is also fine.</div>
          </div>

          ${
            terminal
              ? `<div style="padding:12px 16px;border-radius:8px;background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);font-size:13px;color:var(--s-text-dim)">This campaign has already been sent and is read-only. To send a new one with the same content, create a new campaign.</div>`
              : `<div style="display:flex;gap:12px;margin-top:20px">
                   <button type="submit" class="btn btn-primary">${isNew ? 'Create campaign' : 'Save changes'}</button>
                   <a href="${base}/marketing/campaigns" class="btn btn-outline">Cancel</a>
                 </div>`
          }
        </form>
      </div>
    </div>

    ${deleteBlock}
  `

  res.send(
    sellerLayout({
      title,
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'marketing',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /marketing/campaigns/create
// ---------------------------------------------------------------------------

export async function postCreateCampaign(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${esc(store.slug)}`

  const body = req.body ?? {}
  const result = await createCampaign(db as any, store.id, {
    name: String(body.name ?? ''),
    subject: String(body.subject ?? ''),
    body_html: String(body.body_html ?? ''),
    audience_segment: body.audience_segment ? String(body.audience_segment).trim() || null : null,
    created_by: user.id ?? null,
  })

  if (!result.ok) {
    safeRedirect(res, base, '/new', { error: result.error })
    return
  }

  await logSellerAction(db, req, 'create', 'campaign', result.campaign.id, {
    name: result.campaign.name,
  })

  safeRedirect(res, base, `/${result.campaign.id}`, { ok: 'campaign_created' })
}

// ---------------------------------------------------------------------------
// POST /marketing/campaigns/:id/update
// ---------------------------------------------------------------------------

export async function postUpdateCampaign(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${esc(store.slug)}`
  const id = String(req.params.id || '')

  const body = req.body ?? {}
  const result = await updateCampaign(db as any, store.id, id, {
    name: body.name !== undefined ? String(body.name) : undefined,
    subject: body.subject !== undefined ? String(body.subject) : undefined,
    body_html: body.body_html !== undefined ? String(body.body_html) : undefined,
    audience_segment:
      body.audience_segment !== undefined
        ? String(body.audience_segment).trim() || null
        : undefined,
  })

  if (!result.ok) {
    safeRedirect(res, base, `/${id}`, { error: result.error })
    return
  }

  await logSellerAction(db, req, 'update', 'campaign', id, {
    name: result.campaign.name,
  })

  safeRedirect(res, base, `/${id}`, { ok: 'campaign_updated' })
}

// ---------------------------------------------------------------------------
// POST /marketing/campaigns/:id/delete
// ---------------------------------------------------------------------------

export async function postDeleteCampaign(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${esc(store.slug)}`
  const id = String(req.params.id || '')

  const result = await deleteCampaign(db as any, store.id, id)
  if (!result.ok) {
    safeRedirect(res, base, `/${id}`, { error: result.error })
    return
  }

  await logSellerAction(db, req, 'delete', 'campaign', id, {})

  safeRedirect(res, base, '', { ok: 'campaign_deleted' })
}

// ---------------------------------------------------------------------------
// POST /marketing/campaigns/:id/schedule
// ---------------------------------------------------------------------------

export async function postScheduleCampaign(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${esc(store.slug)}`
  const id = String(req.params.id || '')

  const sendAt = String(req.body?.send_at ?? '').trim()
  if (!sendAt) {
    safeRedirect(res, base, `/${id}`, { error: 'send_at_required' })
    return
  }

  const parsed = new Date(sendAt)
  if (Number.isNaN(parsed.getTime())) {
    safeRedirect(res, base, `/${id}`, { error: 'send_at_required' })
    return
  }

  const result = await scheduleCampaign(db as any, store.id, id, parsed)
  if (!result.ok) {
    safeRedirect(res, base, `/${id}`, { error: result.error })
    return
  }

  await logSellerAction(db, req, 'schedule', 'campaign', id, {
    scheduled_at: result.campaign.scheduled_at,
  })

  safeRedirect(res, base, `/${id}`, { ok: 'campaign_scheduled' })
}

// ---------------------------------------------------------------------------
// POST /marketing/campaigns/:id/cancel — scheduled → draft
// ---------------------------------------------------------------------------

export async function postCancelCampaign(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${esc(store.slug)}`
  const id = String(req.params.id || '')

  const result = await cancelScheduled(db as any, store.id, id)
  if (!result.ok) {
    safeRedirect(res, base, `/${id}`, { error: result.error })
    return
  }

  await logSellerAction(db, req, 'cancel_schedule', 'campaign', id, {})

  safeRedirect(res, base, `/${id}`, { ok: 'campaign_cancelled' })
}
