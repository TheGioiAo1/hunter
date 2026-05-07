/**
 * God Admin — Legacy Gbox Integration
 *
 *   GET  /god-admin/integrations/gbox-legacy               — current config + recent pushes
 *   GET  /god-admin/integrations/gbox-legacy/new           — new-config form
 *   POST /god-admin/integrations/gbox-legacy               — create config
 *   GET  /god-admin/integrations/gbox-legacy/:id/edit      — edit form
 *   POST /god-admin/integrations/gbox-legacy/:id           — update config
 *   POST /god-admin/integrations/gbox-legacy/:id/test      — login health check
 *   POST /god-admin/integrations/gbox-legacy/:id/fetch-shop — auto-discover shop id
 *   POST /god-admin/integrations/gbox-legacy/:id/delete    — soft delete (is_active=false)
 *
 * One config at a time. This is the single master account whose JWT
 * pushes every Lenful product that any seller imports through the
 * "Add to store" button on /admin/store/:slug/products?source=lenful.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
import {
  listConfigs,
  getConfigById,
  createConfig,
  updateConfig,
  deleteConfig,
  loginLegacy,
  fetchMyShops,
  listRecentPushes,
  type LegacyGboxConfigPublic,
} from '../../../../packages/core/src/modules/integrations/gbox-legacy/index.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_legacy_gbox' })

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function esc(s: unknown): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(iso)
  }
}

function statusBadge(cfg: LegacyGboxConfigPublic): string {
  if (!cfg.is_active) {
    return `<span style="display:inline-block;padding:2px 10px;background:#64748b22;color:#94a3b8;border-radius:10px;font-size:11px;font-weight:600">DISABLED</span>`
  }
  const tone =
    cfg.last_login_status === 'ok'
      ? { bg: '#10b98122', fg: '#10b981', label: 'ACTIVE' }
      : cfg.last_login_status === 'auth_failed'
        ? { bg: '#ef444422', fg: '#ef4444', label: 'AUTH FAILED' }
        : cfg.last_login_status === 'network_error'
          ? { bg: '#f59e0b22', fg: '#f59e0b', label: 'NET ERROR' }
          : { bg: '#3b82f622', fg: '#3b82f6', label: 'UNTESTED' }
  return `<span style="display:inline-block;padding:2px 10px;background:${tone.bg};color:${tone.fg};border-radius:10px;font-size:11px;font-weight:600">${tone.label}</span>`
}

function banner(type: 'ok' | 'err', msg: string): string {
  const bg = type === 'ok' ? '#10b98122' : '#ef444422'
  const fg = type === 'ok' ? '#10b981' : '#ef4444'
  return `<div style="padding:12px 16px;background:${bg};color:${fg};border-radius:8px;margin-bottom:16px;font-size:13px">${esc(msg)}</div>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/integrations/gbox-legacy
// ---------------------------------------------------------------------------

export async function getIntegrationList(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)
  const flash = typeof req.query.msg === 'string' ? req.query.msg : ''
  const err = typeof req.query.err === 'string' ? req.query.err : ''

  try {
    const [configs, recent] = await Promise.all([
      listConfigs(db),
      listRecentPushes(db, 20),
    ])

    const rows = configs.length
      ? configs
          .map(
            (c) => `
        <tr style="border-bottom:1px solid #1e293b">
          <td style="padding:12px">${statusBadge(c)}</td>
          <td style="padding:12px;font-weight:600">${esc(c.label)}</td>
          <td style="padding:12px;font-family:monospace;font-size:12px">${esc(c.master_email)}</td>
          <td style="padding:12px;font-family:monospace;font-size:12px">${esc(c.master_shop_id)}${
            c.master_shop_name ? ` <span style="color:#94a3b8">(${esc(c.master_shop_name)})</span>` : ''
          }</td>
          <td style="padding:12px;font-size:12px;color:#94a3b8">${shortDate(c.last_login_at)}</td>
          <td style="padding:12px;font-size:12px;color:${c.last_error_msg ? '#ef4444' : '#64748b'}">${
            c.last_error_msg ? esc(c.last_error_msg.slice(0, 80)) : '—'
          }</td>
          <td style="padding:12px;text-align:right;font-size:12px">${Number(c.last_push_count ?? 0)}</td>
          <td style="padding:12px;white-space:nowrap">
            <form method="post" action="/god-admin/integrations/gbox-legacy/${esc(c.id)}/test" style="display:inline">
              ${csrfField}
              <button type="submit" style="padding:6px 12px;background:#3b82f6;border:none;color:#fff;border-radius:6px;font-size:11px;cursor:pointer;margin-right:4px">Test</button>
            </form>
            <a href="/god-admin/integrations/gbox-legacy/${esc(c.id)}/edit" style="display:inline-block;padding:6px 12px;background:#64748b22;color:#94a3b8;border:1px solid #475569;border-radius:6px;font-size:11px;text-decoration:none;margin-right:4px">Edit</a>
            <form method="post" action="/god-admin/integrations/gbox-legacy/${esc(c.id)}/delete" style="display:inline" onsubmit="return confirm('Disable this master config? No more products can be pushed until a new active config is created.')">
              ${csrfField}
              <button type="submit" style="padding:6px 12px;background:#ef444422;color:#ef4444;border:1px solid #ef444455;border-radius:6px;font-size:11px;cursor:pointer">Disable</button>
            </form>
          </td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="8" style="padding:32px;text-align:center;color:#64748b">No master config yet. Click "New config" to connect a legacy Gbox master account.</td></tr>`

    const pushRows = recent.length
      ? recent
          .map(
            (r) => `
        <tr style="border-bottom:1px solid #1e293b">
          <td style="padding:10px 12px;font-size:11px;color:#94a3b8">${shortDate(r.created_at)}</td>
          <td style="padding:10px 12px">
            ${
              r.success
                ? '<span style="display:inline-block;padding:1px 8px;background:#10b98122;color:#10b981;border-radius:8px;font-size:10px;font-weight:600">OK</span>'
                : '<span style="display:inline-block;padding:1px 8px;background:#ef444422;color:#ef4444;border-radius:8px;font-size:10px;font-weight:600">FAIL</span>'
            }
          </td>
          <td style="padding:10px 12px;font-size:11px;font-family:monospace">${r.http_status}</td>
          <td style="padding:10px 12px;font-size:12px">${esc((r.lenful_product_title ?? '—').slice(0, 40))}</td>
          <td style="padding:10px 12px;font-size:11px;font-family:monospace;color:#94a3b8">${esc(r.lenful_product_id)}</td>
          <td style="padding:10px 12px;font-size:11px;font-family:monospace;color:${r.legacy_product_id ? '#10b981' : '#64748b'}">${esc(r.legacy_product_id ?? '—')}</td>
          <td style="padding:10px 12px;font-size:11px;color:#94a3b8">${r.latency_ms != null ? `${r.latency_ms}ms` : '—'}</td>
          <td style="padding:10px 12px;font-size:11px;color:${r.error_message ? '#ef4444' : '#64748b'}">${esc((r.error_message ?? '').slice(0, 80))}</td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="8" style="padding:24px;text-align:center;color:#64748b;font-size:12px">No pushes yet.</td></tr>`

    const content = `
      <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div>
          <h1 style="margin:0">Legacy Gbox Integration</h1>
          <p style="color:#94a3b8;margin:4px 0 0;font-size:13px">
            Master account that receives every Lenful product a seller imports through the storefront.
          </p>
        </div>
        <a href="/god-admin/integrations/gbox-legacy/new" style="padding:10px 16px;background:#3b82f6;color:#fff;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none">+ New config</a>
      </div>

      ${flash ? banner('ok', flash) : ''}
      ${err ? banner('err', err) : ''}

      <div class="card" style="padding:0;margin-bottom:24px;overflow:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#0f172a;border-bottom:1px solid #1e293b;font-size:11px;color:#94a3b8;text-align:left">
              <th style="padding:10px 12px;font-weight:600">Status</th>
              <th style="padding:10px 12px;font-weight:600">Label</th>
              <th style="padding:10px 12px;font-weight:600">Master email</th>
              <th style="padding:10px 12px;font-weight:600">Master shop id</th>
              <th style="padding:10px 12px;font-weight:600">Last login</th>
              <th style="padding:10px 12px;font-weight:600">Last error</th>
              <th style="padding:10px 12px;font-weight:600;text-align:right">Pushes</th>
              <th style="padding:10px 12px;font-weight:600">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <h2 style="margin:24px 0 12px;font-size:16px">Recent pushes</h2>
      <div class="card" style="padding:0;overflow:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#0f172a;border-bottom:1px solid #1e293b;font-size:11px;color:#94a3b8;text-align:left">
              <th style="padding:10px 12px;font-weight:600">When</th>
              <th style="padding:10px 12px;font-weight:600">Result</th>
              <th style="padding:10px 12px;font-weight:600">HTTP</th>
              <th style="padding:10px 12px;font-weight:600">Title</th>
              <th style="padding:10px 12px;font-weight:600">Lenful id</th>
              <th style="padding:10px 12px;font-weight:600">Legacy id</th>
              <th style="padding:10px 12px;font-weight:600">Latency</th>
              <th style="padding:10px 12px;font-weight:600">Error</th>
            </tr>
          </thead>
          <tbody>${pushRows}</tbody>
        </table>
      </div>
    `

    res.send(
      godLayout({
        title: 'Legacy Gbox Integration',
        userEmail: user.email,
        activePath: '/god-admin/integrations/gbox-legacy',
        content,
      }),
    )
  } catch (e: any) {
    console.error('[god-admin] legacy-gbox list error:', e)
    res.status(500).send('Error loading page: ' + (e?.message ?? String(e)))
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/integrations/gbox-legacy/new | /:id/edit
// ---------------------------------------------------------------------------

export async function getIntegrationForm(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const isEdit = typeof req.params.id === 'string' && req.params.id.length > 0
  const existing = isEdit ? await getConfigById(db, req.params.id!) : null
  if (isEdit && !existing) {
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('Config not found'),
    )
    return
  }
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)
  const action = isEdit
    ? `/god-admin/integrations/gbox-legacy/${esc(existing!.id)}`
    : '/god-admin/integrations/gbox-legacy'
  const err = typeof req.query.err === 'string' ? req.query.err : ''

  const content = `
    <div class="page-header">
      <a href="/god-admin/integrations/gbox-legacy" style="color:#94a3b8;text-decoration:none;font-size:13px">&larr; Back</a>
      <h1>${isEdit ? 'Edit' : 'New'} Legacy Gbox Config</h1>
    </div>

    ${err ? banner('err', err) : ''}

    <form method="post" action="${action}" class="card" style="padding:24px;max-width:720px" autocomplete="off">
      ${csrfField}

      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Label</label>
        <input type="text" name="label" required value="${esc(existing?.label ?? 'Gbox Legacy Master')}" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px">
        <div style="font-size:11px;color:#64748b;margin-top:4px">Display-only. E.g. "Gbox Legacy Master — lamdiepanh1903".</div>
      </div>

      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Master email (legacy Gbox login)</label>
        <input type="email" name="master_email" required autocomplete="off" value="${esc(existing?.master_email ?? '')}" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;font-family:monospace">
        <div style="font-size:11px;color:#64748b;margin-top:4px">E.g. <span style="font-family:monospace">lamdiepanh1903@gmail.com</span></div>
      </div>

      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Master password ${isEdit ? '(leave blank to keep current)' : ''}</label>
        <input type="password" name="master_password" ${isEdit ? '' : 'required'} autocomplete="new-password" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;font-family:monospace">
        <div style="font-size:11px;color:#64748b;margin-top:4px">Encrypted with AES-256-GCM before write. Never stored in plaintext, never logged.</div>
      </div>

      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Master shop id</label>
        <div style="display:flex;gap:8px">
          <input type="text" name="master_shop_id" required value="${esc(existing?.master_shop_id ?? '')}" style="flex:1;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;font-family:monospace" placeholder="e.g. 121212121211212">
          ${
            isEdit
              ? `<button type="submit" formaction="/god-admin/integrations/gbox-legacy/${esc(existing!.id)}/fetch-shop" style="padding:10px 14px;background:#64748b33;color:#cbd5e1;border:1px solid #475569;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">Auto-fetch</button>`
              : ''
          }
        </div>
        <div style="font-size:11px;color:#64748b;margin-top:4px">
          The real legacy Gbox shop_id where every Lenful product lands.
          ${isEdit ? '<em>Auto-fetch</em> will log in with the current saved password and probe /api/shop/my + /api/user/me.' : 'You can save blank then click "Auto-fetch" on the edit page after testing login.'}
        </div>
      </div>

      <div style="margin-bottom:24px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Master shop name (display only)</label>
        <input type="text" name="master_shop_name" value="${esc(existing?.master_shop_name ?? '')}" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px">
      </div>

      <details style="margin-bottom:24px">
        <summary style="cursor:pointer;color:#94a3b8;font-size:12px;font-weight:600">Advanced — API base URLs (override for staging)</summary>
        <div style="margin-top:16px;padding:16px;background:#0f172a;border-radius:8px">
          <div style="margin-bottom:12px">
            <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:4px">Auth base</label>
            <input type="url" name="auth_base" value="${esc(existing?.auth_base ?? 'https://api-auth.gbox.co')}" style="width:100%;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px;font-family:monospace">
          </div>
          <div style="margin-bottom:12px">
            <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:4px">Product base</label>
            <input type="url" name="product_base" value="${esc(existing?.product_base ?? 'https://api-product.gbox.co')}" style="width:100%;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px;font-family:monospace">
          </div>
          <div>
            <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:4px">Shop base</label>
            <input type="url" name="shop_base" value="${esc(existing?.shop_base ?? 'https://api-shop.gbox.co')}" style="width:100%;padding:8px 10px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px;font-family:monospace">
          </div>
        </div>
      </details>

      <div style="display:flex;gap:12px;border-top:1px solid #1e293b;padding-top:16px">
        <button type="submit" style="padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">${isEdit ? 'Save changes' : 'Save config'}</button>
        <a href="/god-admin/integrations/gbox-legacy" style="padding:10px 20px;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;font-size:13px;text-decoration:none">Cancel</a>
      </div>
    </form>
  `

  res.send(
    godLayout({
      title: isEdit ? 'Edit Legacy Gbox Config' : 'New Legacy Gbox Config',
      userEmail: user.email,
      activePath: '/god-admin/integrations/gbox-legacy',
      content,
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /god-admin/integrations/gbox-legacy — create
// ---------------------------------------------------------------------------

export async function postIntegrationCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('CSRF token expired. Try again.'),
    )
    return
  }
  const user = req.godAdmin!.user
  const body = (req.body || {}) as Record<string, string>
  const label = (body.label || '').trim()
  const email = (body.master_email || '').trim()
  const password = body.master_password || ''
  const shopId = (body.master_shop_id || '').trim()
  const shopName = (body.master_shop_name || '').trim() || undefined
  const authBase = (body.auth_base || 'https://api-auth.gbox.co').trim()
  const productBase = (body.product_base || 'https://api-product.gbox.co').trim()
  const shopBase = (body.shop_base || 'https://api-shop.gbox.co').trim()

  if (!label || !email || !password || !shopId) {
    res.redirect(
      '/god-admin/integrations/gbox-legacy/new?err=' +
        encodeURIComponent(
          'Label, email, password and shop id are all required.',
        ),
    )
    return
  }

  try {
    const id = await createConfig(db, {
      label,
      masterEmail: email,
      masterPassword: password,
      masterShopId: shopId,
      masterShopName: shopName,
      authBase,
      productBase,
      shopBase,
      createdBy: user.id,
    })
    res.redirect(
      '/god-admin/integrations/gbox-legacy?msg=' +
        encodeURIComponent(
          `Saved config "${label}" (id ${id.slice(0, 8)}). Click "Test" to verify login.`,
        ),
    )
  } catch (e: any) {
    console.error('[god-admin] legacy-gbox create error:', e)
    res.redirect(
      '/god-admin/integrations/gbox-legacy/new?err=' +
        encodeURIComponent('Save failed: ' + (e?.message ?? String(e))),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/integrations/gbox-legacy/:id — update
// ---------------------------------------------------------------------------

export async function postIntegrationUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('CSRF token expired. Try again.'),
    )
    return
  }
  const id = String(req.params.id ?? '')
  const body = (req.body || {}) as Record<string, string>
  const label = (body.label || '').trim()
  const email = (body.master_email || '').trim()
  const password = body.master_password || '' // optional on update
  const shopId = (body.master_shop_id || '').trim()
  const shopName = (body.master_shop_name || '').trim()
  const authBase = (body.auth_base || '').trim() || undefined
  const productBase = (body.product_base || '').trim() || undefined
  const shopBase = (body.shop_base || '').trim() || undefined

  if (!label || !email || !shopId) {
    res.redirect(
      `/god-admin/integrations/gbox-legacy/${encodeURIComponent(id)}/edit?err=` +
        encodeURIComponent('Label, email and shop id are required.'),
    )
    return
  }

  try {
    await updateConfig(db, id, {
      label,
      masterEmail: email,
      masterPassword: password || undefined,
      masterShopId: shopId,
      masterShopName: shopName || null,
      authBase,
      productBase,
      shopBase,
      isActive: true, // re-activates on save
    })
    res.redirect(
      '/god-admin/integrations/gbox-legacy?msg=' +
        encodeURIComponent(`Updated config "${label}".`),
    )
  } catch (e: any) {
    console.error('[god-admin] legacy-gbox update error:', e)
    res.redirect(
      `/god-admin/integrations/gbox-legacy/${encodeURIComponent(id)}/edit?err=` +
        encodeURIComponent('Update failed: ' + (e?.message ?? String(e))),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/integrations/gbox-legacy/:id/test — login health check
// ---------------------------------------------------------------------------

export async function postIntegrationTest(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('CSRF token expired. Try again.'),
    )
    return
  }
  const id = String(req.params.id ?? '')
  const cfg = await getConfigById(db, id)
  if (!cfg) {
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('Config not found'),
    )
    return
  }
  // Resolve password (need decryption here)
  const { getActiveConfigResolved } = await import(
    '../../../../packages/core/src/modules/integrations/gbox-legacy/index.js'
  )
  const resolved = await getActiveConfigResolved(db)
  if (!resolved || resolved.id !== id) {
    // Not the active one — we can only test the active config because
    // only the active row participates in the token cache pool.
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('Only the active config can be tested. Activate it first.'),
    )
    return
  }
  const result = await loginLegacy(
    resolved.auth_base,
    resolved.master_email,
    resolved.master_password,
  )
  if (result.ok) {
    const { markLoginOk } = await import(
      '../../../../packages/core/src/modules/integrations/gbox-legacy/index.js'
    )
    await markLoginOk(db, id)
    res.redirect(
      '/god-admin/integrations/gbox-legacy?msg=' +
        encodeURIComponent(
          `Login OK — token received (${result.token!.length} chars). Cached in memory until JWT exp or 50 min.`,
        ),
    )
    return
  }
  const { markLoginError } = await import(
    '../../../../packages/core/src/modules/integrations/gbox-legacy/index.js'
  )
  await markLoginError(
    db,
    id,
    result.errorCode === 'auth_failed' ? 'auth_failed' : 'network_error',
    result.errorMessage ?? 'unknown',
  )
  res.redirect(
    '/god-admin/integrations/gbox-legacy?err=' +
      encodeURIComponent(`Login failed: ${result.errorMessage}`),
  )
}

// ---------------------------------------------------------------------------
// POST /god-admin/integrations/gbox-legacy/:id/fetch-shop
// ---------------------------------------------------------------------------

export async function postIntegrationFetchShop(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('CSRF token expired. Try again.'),
    )
    return
  }
  const id = String(req.params.id ?? '')
  const { getActiveConfigResolved, updateConfig: update } = await import(
    '../../../../packages/core/src/modules/integrations/gbox-legacy/index.js'
  )
  const resolved = await getActiveConfigResolved(db)
  if (!resolved || resolved.id !== id) {
    res.redirect(
      `/god-admin/integrations/gbox-legacy/${encodeURIComponent(id)}/edit?err=` +
        encodeURIComponent('Auto-fetch only works on the active config.'),
    )
    return
  }
  const login = await loginLegacy(
    resolved.auth_base,
    resolved.master_email,
    resolved.master_password,
  )
  if (!login.ok || !login.token) {
    res.redirect(
      `/god-admin/integrations/gbox-legacy/${encodeURIComponent(id)}/edit?err=` +
        encodeURIComponent(`Login failed: ${login.errorMessage}`),
    )
    return
  }
  const shops = await fetchMyShops({
    authBase: resolved.auth_base,
    shopBase: resolved.shop_base,
    token: login.token,
  })
  if (!shops.ok || shops.shops.length === 0) {
    res.redirect(
      `/god-admin/integrations/gbox-legacy/${encodeURIComponent(id)}/edit?err=` +
        encodeURIComponent(
          shops.errorMessage ?? 'No shops found for this account.',
        ),
    )
    return
  }
  const first = shops.shops[0]!
  await update(db, id, {
    masterShopId: first.id,
    masterShopName: first.name ?? null,
  })
  res.redirect(
    '/god-admin/integrations/gbox-legacy?msg=' +
      encodeURIComponent(
        `Shop id auto-fetched: ${first.id}${first.name ? ` (${first.name})` : ''} via ${shops.probedPath}. ${shops.shops.length} shop(s) visible in total.`,
      ),
  )
}

// ---------------------------------------------------------------------------
// POST /god-admin/integrations/gbox-legacy/:id/delete — soft delete
// ---------------------------------------------------------------------------

export async function postIntegrationDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('CSRF token expired. Try again.'),
    )
    return
  }
  const id = String(req.params.id ?? '')
  try {
    await deleteConfig(db, id)
    res.redirect(
      '/god-admin/integrations/gbox-legacy?msg=' +
        encodeURIComponent('Config disabled.'),
    )
  } catch (e: any) {
    console.error('[god-admin] legacy-gbox delete error:', e)
    res.redirect(
      '/god-admin/integrations/gbox-legacy?err=' +
        encodeURIComponent('Delete failed: ' + (e?.message ?? String(e))),
    )
  }
}
