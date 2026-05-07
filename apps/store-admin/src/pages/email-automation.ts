/**
 * Store Admin — Email Automation (Gbox Email Service)
 *
 * Seller UI trên giao diện Gbox Email Service (api-email.gbox.co).
 * Templates được lưu trong MongoDB của email service, render bằng
 * RazorEngine với @Model.xxx syntax.
 *
 * Routes:
 *   GET  /settings/email-templates                   → list
 *   GET  /settings/email-templates/:sys_name         → editor
 *   POST /settings/email-templates/:sys_name/save    → update (PUT /api/{shop})
 *   POST /settings/email-templates/:sys_name/reset   → recover to default
 *   POST /settings/email-templates/clone             → clone from default shop
 *
 * API base: process.env.API_EMAIL_BASE_URL (default https://api-email.gbox.co)
 * Auth: Bearer JWT từ session cookie (same token dùng cho tất cả gbox microservices)
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { fetchJson } from '../lib/api-fetch-json.js'
import { getSessionTokenFromCookies } from '@gbox/core/modules/auth/session.js'

const EMAIL_BASE = (process.env.API_EMAIL_BASE_URL ?? 'https://api-email.gbox.co').replace(/\/+$/, '')

function getEmailApiToken(req: Request): string {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) throw Object.assign(new Error('No session'), { status: 401 })
  return token
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailTemplate {
  id?: string
  sys_name?: string
  shop_id?: string
  name?: string
  subject?: string
  body?: string
  bbc_email?: string
  status?: boolean
  delay?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shopBase(shopId: string): string {
  return `${EMAIL_BASE}/api/${encodeURIComponent(shopId)}`
}

function banner(kind: 'ok' | 'error', text: string): string {
  const bg = kind === 'ok' ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)'
  const bd = kind === 'ok' ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'
  const cl = kind === 'ok' ? '#22c55e' : '#ef4444'
  return `<div style="padding:10px 14px;border-radius:8px;background:${bg};border:1px solid ${bd};color:${cl};font-size:13px;margin-bottom:16px">${esc(text)}</div>`
}

function label(t: EmailTemplate): string {
  return t.name ?? t.sys_name ?? '(unnamed)'
}

function statusBadge(on: boolean | undefined): string {
  return on !== false
    ? `<span class="badge badge-success">On</span>`
    : `<span class="badge badge-warning">Off</span>`
}

function delayLabel(secs: number | undefined): string {
  if (!secs) return '—'
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${(secs / 3600).toFixed(1)}h`
}

// Template variables available in RazorEngine body (@Model.xxx)
const ORDER_SYS_PREFIXES = ['order', 'abandoned', 'shipping', 'checkout', 'fulfil']

function templateVars(sys_name: string): { order: boolean } {
  const s = (sys_name ?? '').toLowerCase()
  return { order: ORDER_SYS_PREFIXES.some((p) => s.includes(p)) }
}

const ORDER_VARS = [
  '@Model.order_number',
  '@Model.billing_address.full_name',
  '@Model.billing_address.email',
  '@Model.billing_address.phone',
  '@Model.shipping_address.full_name',
  '@Model.shipping_address.full_address',
  '@Model.line_items[i].product_name',
  '@Model.line_items[i].quantity',
  '@Model.line_items[i].total',
  '@Model.subtotal_price',
  '@Model.tax',
  '@Model.total_price',
  '@Model.currency',
  '@Model.shipping_method.name',
  '@Model.shipping_method.price',
  '@Model.payment_method.name',
  '@Model.payment_method.amount',
  '@Model.status',
  '@Model.create_date',
]

const USER_VARS = [
  '@Model.email',
  '@Model.first_name',
  '@Model.last_name',
  '@Model.phone',
  '@Model.link',
  '@Model.created_at',
]

function varPanel(sys_name: string): string {
  const { order } = templateVars(sys_name)
  const vars = order ? ORDER_VARS : USER_VARS
  const context = order ? 'Order' : 'User'
  return `
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span style="font-weight:600">Available variables</span>
        <span style="margin-left:8px;color:var(--s-text-dim);font-size:12px">${context} context · Razor @Model syntax</span>
      </div>
      <div class="card-body">
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${vars.map((v) => `<code style="background:var(--s-bg-alt);border:1px solid var(--s-border);padding:2px 7px;border-radius:4px;font-size:12px;color:var(--s-text-dim)">${esc(v)}</code>`).join('')}
        </div>
        <p style="margin:10px 0 0;font-size:12px;color:var(--s-text-dim)">
          Use <code>@Model.property</code> directly in the HTML body. For loop over line items:
          <code>@foreach(var item in Model.line_items) &#123; ... &#125;</code>
        </p>
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/settings/email-templates
// ---------------------------------------------------------------------------

export async function getEmailAutomationList(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const saved = typeof req.query.saved === 'string' ? req.query.saved : null
  const err = typeof req.query.err === 'string' ? req.query.err : null

  let templates: EmailTemplate[] = []
  let apiErr = ''

  try {
    const token = getEmailApiToken(req)
    templates = await fetchJson<EmailTemplate[]>(
      `${shopBase(store.id)}?fields=id,sys_name,name,subject,status,delay`,
      { method: 'GET', token },
      'Email',
    )
  } catch (e: any) {
    apiErr = e?.status === 401 ? 'Session expired — please sign in again.' : 'Could not load email templates. Try refreshing.'
  }

  const savedMsg =
    saved === 'cloned' ? 'Default templates cloned to your store.' :
    saved === '1' ? 'Saved.' :
    null

  const flash = savedMsg ? banner('ok', savedMsg) : err ? banner('error', decodeURIComponent(err)) : ''

  const isEmpty = !apiErr && templates.length === 0

  const cloneForm = `
    <form method="POST" action="${base}/settings/email-templates/clone" style="display:inline">
      ${csrfHiddenField(req.csrfToken ?? '')}
      <button class="btn" type="submit" style="font-size:13px">Clone default templates</button>
    </form>`

  let tableHtml = ''
  if (!apiErr && !isEmpty) {
    const rows = templates.map((t) => `
      <tr>
        <td style="font-weight:500">${esc(label(t))}</td>
        <td style="color:var(--s-text-dim);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.subject ?? '—')}</td>
        <td>${statusBadge(t.status)}</td>
        <td style="color:var(--s-text-dim)">${esc(delayLabel(t.delay))}</td>
        <td>
          <a class="btn ghost" style="font-size:12px;padding:4px 10px" href="${base}/settings/email-templates/${encodeURIComponent(t.sys_name ?? '')}">Edit</a>
        </td>
      </tr>`).join('')

    tableHtml = `
      <div class="card">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-weight:600">${templates.length} template${templates.length === 1 ? '' : 's'}</span>
          ${cloneForm}
        </div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Delay</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>`
  }

  const emptyState = isEmpty ? `
    <div class="card" style="text-align:center;padding:48px 24px">
      <div style="font-size:32px;margin-bottom:12px">📧</div>
      <p style="font-weight:600;margin:0 0 6px">No email templates yet</p>
      <p style="color:var(--s-text-dim);font-size:14px;margin:0 0 20px">Clone the default templates to start customising your store emails.</p>
      ${cloneForm}
    </div>` : ''

  const errState = apiErr ? banner('error', apiErr) : ''

  const content = `
    <div class="page-header" style="margin-bottom:20px">
      <div class="breadcrumb" style="font-size:13px;color:var(--s-text-dim);margin-bottom:6px">
        <a href="${base}/settings" style="color:var(--s-text-dim)">Settings</a>
        <span style="margin:0 6px">›</span>Email templates
      </div>
      <h1 style="margin:0;font-size:20px">Email templates</h1>
      <p style="margin:4px 0 0;color:var(--s-text-dim);font-size:14px">
        Customise the emails sent to your customers. Templates use Razor syntax with order/user context.
      </p>
    </div>
    ${flash}${errState}${tableHtml}${emptyState}`

  res.send(
    sellerLayout({
      title: 'Email templates',
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
// GET /admin/store/:slug/settings/email-templates/:sys_name
// ---------------------------------------------------------------------------

export async function getEmailAutomationEditor(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const sysName = String(req.params.sys_name || '').trim()
  const saved = typeof req.query.saved === 'string' ? req.query.saved : null
  const err = typeof req.query.err === 'string' ? req.query.err : null

  if (!sysName) {
    res.redirect(`${base}/settings/email-templates`)
    return
  }

  let tmpl: EmailTemplate | null = null
  let apiErr = ''

  try {
    const token = getEmailApiToken(req)
    tmpl = await fetchJson<EmailTemplate>(
      `${shopBase(store.id)}/${encodeURIComponent(sysName)}`,
      { method: 'GET', token },
      'Email',
    )
  } catch (e: any) {
    if (e?.status === 404) {
      res.redirect(`${base}/settings/email-templates?err=${encodeURIComponent('Template not found.')}`)
      return
    }
    apiErr = e?.status === 401 ? 'Session expired — please sign in again.' : 'Could not load template. Try refreshing.'
  }

  const flash = saved ? banner('ok', 'Template saved.') : err ? banner('error', decodeURIComponent(err)) : ''

  const statusOn = tmpl?.status !== false

  const form = tmpl ? `
    <form method="POST" action="${base}/settings/email-templates/${encodeURIComponent(sysName)}/save">
      ${csrfHiddenField(req.csrfToken ?? '')}
      <input type="hidden" name="id" value="${esc(tmpl.id ?? '')}">

      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span style="font-weight:600">Status</span></div>
        <div class="card-body" style="display:flex;align-items:center;gap:14px">
          <label class="toggle-label" style="display:flex;align-items:center;gap:10px;cursor:pointer">
            <input type="checkbox" name="status" value="true" ${statusOn ? 'checked' : ''}
              style="width:16px;height:16px;accent-color:var(--s-accent)">
            <span style="font-size:14px">
              ${statusOn ? 'Active — this email will be sent' : 'Inactive — this email is disabled'}
            </span>
          </label>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span style="font-weight:600">Subject</span></div>
        <div class="card-body">
          <input name="subject" type="text" class="form-control"
            value="${esc(tmpl.subject ?? '')}"
            placeholder="Email subject line"
            style="width:100%;max-width:600px">
          <p style="margin:6px 0 0;font-size:12px;color:var(--s-text-dim)">
            You can use Razor variables here too, e.g. <code>Order #@Model.order_number is confirmed</code>
          </p>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;padding-bottom:0;border-bottom:none">
          <span style="font-weight:600">Body (HTML)</span>
          <div id="etab-btns" style="display:flex;border:1px solid var(--s-border);border-radius:6px;overflow:hidden;font-size:12px">
            <button type="button" id="etab-code"
              onclick="etabShow('code')"
              style="padding:4px 14px;background:var(--s-accent);color:#fff;border:0;cursor:pointer;font-size:12px">Code</button>
            <button type="button" id="etab-preview"
              onclick="etabShow('preview')"
              style="padding:4px 14px;background:transparent;color:var(--s-text-dim);border:0;cursor:pointer;font-size:12px">Preview</button>
          </div>
        </div>
        <div id="etab-pane-code" class="card-body">
          <textarea id="etab-body" name="body" class="form-control" rows="22"
            placeholder="HTML email body — use @Model.xxx for dynamic data"
            style="width:100%;font-family:monospace;font-size:13px;resize:vertical">${esc(tmpl.body ?? '')}</textarea>
          <p style="margin:6px 0 0;font-size:12px;color:var(--s-text-dim)">
            Razor syntax: <code>@Model.order_number</code>, <code>@Model.billing_address.full_name</code>, …
          </p>
        </div>
        <div id="etab-pane-preview" style="display:none;padding:0;border-top:1px solid var(--s-border)">
          <div style="padding:8px 16px;font-size:12px;color:var(--s-text-dim);background:var(--s-bg-alt);border-bottom:1px solid var(--s-border)">
            Raw HTML · <code>@Model.xxx</code> placeholders shown as-is
          </div>
          <iframe id="etab-frame"
            sandbox="allow-same-origin"
            style="display:block;width:100%;min-height:540px;border:0;background:#f9f9f9">
          </iframe>
        </div>
      </div>
      <script>
      (function(){
        function etabShow(tab) {
          var isCode = tab === 'code';
          document.getElementById('etab-pane-code').style.display = isCode ? '' : 'none';
          document.getElementById('etab-pane-preview').style.display = isCode ? 'none' : '';
          document.getElementById('etab-code').style.background = isCode ? 'var(--s-accent)' : 'transparent';
          document.getElementById('etab-code').style.color = isCode ? '#fff' : 'var(--s-text-dim)';
          document.getElementById('etab-preview').style.background = isCode ? 'transparent' : 'var(--s-accent)';
          document.getElementById('etab-preview').style.color = isCode ? 'var(--s-text-dim)' : '#fff';
          if (!isCode) {
            var html = document.getElementById('etab-body').value;
            document.getElementById('etab-frame').srcdoc = html || '<p style="font-family:sans-serif;color:#999;padding:40px;text-align:center">No HTML content yet.</p>';
          }
        }
        window.etabShow = etabShow;
      })();
      </script>

      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span style="font-weight:600">Advanced</span></div>
        <div class="card-body" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:600px">
          <div>
            <label style="display:block;font-size:13px;margin-bottom:5px;color:var(--s-text-dim)">BCC email</label>
            <input name="bbc_email" type="email" class="form-control"
              value="${esc(tmpl.bbc_email ?? '')}"
              placeholder="admin@yourstore.com">
          </div>
          <div>
            <label style="display:block;font-size:13px;margin-bottom:5px;color:var(--s-text-dim)">Send delay (seconds)</label>
            <input name="delay" type="number" min="0" class="form-control"
              value="${esc(String(tmpl.delay ?? 0))}"
              placeholder="0">
          </div>
        </div>
      </div>

      ${varPanel(sysName)}

      <div class="actions" style="display:flex;gap:10px;align-items:center">
        <button type="submit" class="btn">Save changes</button>
        <a class="btn ghost" href="${base}/settings/email-templates">Back to list</a>
        <div style="flex:1"></div>
        <form method="POST" action="${base}/settings/email-templates/${encodeURIComponent(sysName)}/reset"
          style="display:inline;margin:0"
          onsubmit="return confirm('Reset this template to the default? Your changes will be lost.')">
          ${csrfHiddenField(req.csrfToken ?? '')}
          <button type="submit" class="btn ghost" style="color:#ef4444;border-color:rgba(239,68,68,.4)">
            Reset to default
          </button>
        </form>
      </div>
    </form>` : ''

  const content = `
    <div class="page-header" style="margin-bottom:20px">
      <div class="breadcrumb" style="font-size:13px;color:var(--s-text-dim);margin-bottom:6px">
        <a href="${base}/settings" style="color:var(--s-text-dim)">Settings</a>
        <span style="margin:0 6px">›</span>
        <a href="${base}/settings/email-templates" style="color:var(--s-text-dim)">Email templates</a>
        <span style="margin:0 6px">›</span>${esc(tmpl ? label(tmpl) : sysName)}
      </div>
      <h1 style="margin:0;font-size:20px">${esc(tmpl ? label(tmpl) : sysName)}</h1>
      <p style="margin:4px 0 0;color:var(--s-text-dim);font-size:13px">sys_name: <code>${esc(sysName)}</code></p>
    </div>
    ${flash}
    ${apiErr ? banner('error', apiErr) : ''}
    ${form}`

  res.send(
    sellerLayout({
      title: tmpl ? label(tmpl) : sysName,
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
// POST /admin/store/:slug/settings/email-templates/:sys_name/save
// ---------------------------------------------------------------------------

export async function postEmailAutomationSave(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const sysName = String(req.params.sys_name || '').trim()
  const backToEditor = `${base}/settings/email-templates/${encodeURIComponent(sysName)}`

  if (!sysName) {
    res.redirect(`${base}/settings/email-templates`)
    return
  }

  const body: EmailTemplate = {
    id: String(req.body.id ?? '').trim() || undefined,
    sys_name: sysName,
    shop_id: store.id,
    subject: String(req.body.subject ?? '').trim(),
    body: String(req.body.body ?? ''),
    bbc_email: String(req.body.bbc_email ?? '').trim() || undefined,
    status: req.body.status === 'true',
    delay: Number(req.body.delay ?? 0) || 0,
  }

  try {
    const token = getEmailApiToken(req)
    await fetchJson<EmailTemplate>(
      shopBase(store.id),
      { method: 'PUT', token, body: JSON.stringify(body) },
      'Email',
    )
    res.redirect(`${backToEditor}?saved=1`)
  } catch (e: any) {
    const msg = e?.status === 401 ? 'Session expired.' : 'Could not save template. Please try again.'
    res.redirect(`${backToEditor}?err=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/settings/email-templates/:sys_name/reset
// ---------------------------------------------------------------------------

export async function postEmailAutomationReset(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const sysName = String(req.params.sys_name || '').trim()
  const backToList = `${base}/settings/email-templates`

  if (!sysName) {
    res.redirect(backToList)
    return
  }

  try {
    const token = getEmailApiToken(req)
    await fetchJson<unknown>(
      `${shopBase(store.id)}/recover`,
      { method: 'POST', token, body: JSON.stringify([sysName]) },
      'Email',
    )
    res.redirect(`${backToList}?saved=1`)
  } catch (e: any) {
    const msg = e?.status === 401 ? 'Session expired.' : 'Could not reset template. Please try again.'
    res.redirect(`${backToList}?err=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/settings/email-templates/clone
// ---------------------------------------------------------------------------

export async function postEmailAutomationClone(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const backToList = `${base}/settings/email-templates`

  try {
    const token = getEmailApiToken(req)
    await fetchJson<unknown>(
      `${shopBase(store.id)}/clone-email`,
      { method: 'POST', token },
      'Email',
    )
    res.redirect(`${backToList}?saved=cloned`)
  } catch (e: any) {
    const msg = e?.status === 401 ? 'Session expired.' : 'Could not clone templates. Please try again.'
    res.redirect(`${backToList}?err=${encodeURIComponent(msg)}`)
  }
}
