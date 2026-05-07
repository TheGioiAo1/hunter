/**
 * God Admin — Lenful Credentials
 *
 *   GET  /god-admin/fulfillments/credentials                    — list
 *   GET  /god-admin/fulfillments/credentials/new                — new form
 *   POST /god-admin/fulfillments/credentials                    — create
 *   POST /god-admin/fulfillments/credentials/:id/test           — health check
 *   POST /god-admin/fulfillments/credentials/:id/delete         — soft delete
 *
 * Phase F0 — god admin owns Lenful integration end-to-end. This page
 * is where we paste the one-and-only Lenful seller login; the encrypted
 * row drives every subsequent API call.
 *
 * Access: god-admin middleware at the app level already gates everything
 * under /god-admin/* to level 0/1. We also CSRF every POST because these
 * writes touch a credential that can submit orders + spend wallet.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
import {
  listCredentials,
  createCredential,
  updateCredential,
  deleteCredential,
  LenfulClient,
  type LenfulCredentialPublic,
} from '../../../../packages/core/src/modules/fulfillment/lenful/index.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_lenful_creds' })

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
  if (!iso) return '-'
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

function statusBadge(cred: LenfulCredentialPublic): string {
  if (cred.is_active) {
    return `<span style="display:inline-block;padding:2px 10px;background:#10b98122;color:#10b981;border-radius:10px;font-size:11px;font-weight:600">ACTIVE</span>`
  }
  return `<span style="display:inline-block;padding:2px 10px;background:#64748b22;color:#94a3b8;border-radius:10px;font-size:11px;font-weight:600">DISABLED</span>`
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/credentials
// ---------------------------------------------------------------------------

export async function getCredentialsList(
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
    const creds = await listCredentials(db)

    const rows = creds.length
      ? creds
          .map(
            (c) => `
        <tr style="border-bottom:1px solid #1e293b">
          <td style="padding:12px">${statusBadge(c)}</td>
          <td style="padding:12px;font-weight:600">${esc(c.label)}</td>
          <td style="padding:12px;font-family:monospace;font-size:12px">${esc(c.user_name)}</td>
          <td style="padding:12px;font-family:monospace;font-size:12px">${esc(c.lenful_store_id || '-')}</td>
          <td style="padding:12px;font-size:12px;color:#94a3b8">${shortDate(c.last_login_at)}</td>
          <td style="padding:12px;font-size:12px;color:${c.last_error_msg ? '#ef4444' : '#64748b'}">${
                c.last_error_msg ? esc(c.last_error_msg.slice(0, 80)) : '—'
              }</td>
          <td style="padding:12px;white-space:nowrap">
            <form method="post" action="/god-admin/fulfillments/credentials/${esc(c.id)}/test" style="display:inline">
              ${csrfField}
              <button type="submit" style="padding:6px 12px;background:#3b82f6;border:none;color:#fff;border-radius:6px;font-size:11px;cursor:pointer;margin-right:4px">Test</button>
            </form>
            <form method="post" action="/god-admin/fulfillments/credentials/${esc(c.id)}/delete" style="display:inline" onsubmit="return confirm('Disable this credential? It will stop pushing orders to Lenful.')">
              ${csrfField}
              <button type="submit" style="padding:6px 12px;background:#ef444422;color:#ef4444;border:1px solid #ef444455;border-radius:6px;font-size:11px;cursor:pointer">Disable</button>
            </form>
          </td>
        </tr>`,
          )
          .join('')
      : `<tr><td colspan="7" style="padding:32px;text-align:center;color:#64748b">No Lenful credentials configured. Add one to start pushing orders.</td></tr>`

    const flashBanner = flash
      ? `<div style="padding:12px 16px;background:#10b98122;color:#10b981;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(flash)}</div>`
      : ''
    const errBanner = err
      ? `<div style="padding:12px 16px;background:#ef444422;color:#ef4444;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(err)}</div>`
      : ''

    const content = `
      <div class="page-header">
        <h1>Lenful Credentials</h1>
        <p style="color:#94a3b8;font-size:13px;margin:4px 0 0">Encrypted Lenful seller login used by Gbox to push POD orders for fulfillment.</p>
      </div>

      ${flashBanner}
      ${errBanner}

      <div class="card" style="padding:0;overflow:hidden">
        <div style="padding:16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1e293b">
          <div style="font-size:13px;color:#94a3b8">Only one credential may be active at a time. Activating a new credential disables the previous one.</div>
          <a href="/god-admin/fulfillments/credentials/new" style="padding:8px 16px;background:#3b82f6;color:#fff;border-radius:6px;font-size:13px;text-decoration:none;font-weight:600">+ Add credential</a>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#0f172a">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Status</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Label</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Username</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Store ID</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Last login</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Last error</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#94a3b8">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div style="margin-top:24px;padding:16px;background:#0f172a;border-radius:8px;border:1px solid #1e293b;font-size:12px;color:#94a3b8;line-height:1.7">
        <strong style="color:#e2e8f0">🔐 Security notes</strong><br>
        • Password is encrypted with AES-256-GCM before it hits Postgres.<br>
        • Bearer token is cached in the same row; rotated automatically on 401.<br>
        • Every call to Lenful is logged to <code>lenful_api_log</code> with the password field redacted.<br>
        • Deleting a credential is a soft delete — past orders keep their <code>credential_id</code> for audit.<br>
        • Set env var <code>LENFUL_ENCRYPTION_KEY</code> (64-char hex) before adding the first credential.
      </div>
    `

    res.send(
      godLayout({
        title: 'Lenful Credentials',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/credentials',
        content,
      }),
    )
  } catch (e) {
    console.error('[God Admin] Lenful credentials list error:', e)
    res.status(500).send(
      godLayout({
        title: 'Lenful Credentials',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/credentials',
        content: `<div class="card" style="padding:20px"><p style="color:#ef4444">Error: ${esc(
          String(e),
        )}</p></div>`,
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/credentials/new
// ---------------------------------------------------------------------------

export async function getCredentialsNew(
  req: Request,
  res: Response,
): Promise<void> {
  const user = req.godAdmin!.user
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)

  const content = `
    <div class="page-header">
      <a href="/god-admin/fulfillments/credentials" style="color:#94a3b8;text-decoration:none;font-size:13px">&larr; Back</a>
      <h1>New Lenful Credential</h1>
    </div>

    <form method="post" action="/god-admin/fulfillments/credentials" class="card" style="padding:24px;max-width:640px">
      ${csrfField}

      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Label</label>
        <input type="text" name="label" required value="Gbox Production" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px">
        <div style="font-size:11px;color:#64748b;margin-top:4px">Display-only identifier, e.g. "Gbox Production".</div>
      </div>

      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Lenful Username / Email</label>
        <input type="text" name="user_name" required autocomplete="off" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;font-family:monospace">
      </div>

      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Lenful Password</label>
        <input type="password" name="password" required autocomplete="new-password" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;font-family:monospace">
        <div style="font-size:11px;color:#64748b;margin-top:4px">Encrypted with AES-256-GCM before write. Never stored in plaintext, never logged.</div>
      </div>

      <div style="margin-bottom:16px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Lenful Store ID (UUID on Lenful side)</label>
        <input type="text" name="lenful_store_id" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;font-family:monospace">
        <div style="font-size:11px;color:#64748b;margin-top:4px">Required for order creation. Leave blank to auto-detect from /api/seller/me after first successful login.</div>
      </div>

      <div style="margin-bottom:24px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Store label (display only)</label>
        <input type="text" name="lenful_store_name" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px">
      </div>

      <div style="margin-bottom:24px">
        <label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:600">Base URL</label>
        <input type="url" name="base_url" value="https://s-lencam.lenful.com" style="width:100%;padding:10px 12px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:13px;font-family:monospace">
      </div>

      <div style="display:flex;gap:12px;border-top:1px solid #1e293b;padding-top:16px">
        <button type="submit" style="padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Save credential</button>
        <a href="/god-admin/fulfillments/credentials" style="padding:10px 20px;background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:6px;font-size:13px;text-decoration:none">Cancel</a>
      </div>
    </form>
  `

  res.send(
    godLayout({
      title: 'New Lenful Credential',
      userEmail: user.email,
      activePath: '/god-admin/fulfillments/credentials',
      content,
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/credentials
// ---------------------------------------------------------------------------

export async function postCredentialsCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/credentials?err=' + encodeURIComponent('CSRF token expired. Try again.'))
    return
  }
  const user = req.godAdmin!.user
  try {
    const body = (req.body || {}) as Record<string, string>
    const label = (body.label || '').trim()
    const userName = (body.user_name || '').trim()
    const password = body.password || ''
    const lenfulStoreId = (body.lenful_store_id || '').trim() || undefined
    const lenfulStoreName = (body.lenful_store_name || '').trim() || undefined
    const baseUrl = (body.base_url || 'https://s-lencam.lenful.com').trim()

    if (!label || !userName || !password) {
      res.redirect(
        '/god-admin/fulfillments/credentials/new?err=' +
          encodeURIComponent('Label, username and password are required.'),
      )
      return
    }

    const id = await createCredential(db, {
      label,
      userName,
      password,
      lenfulStoreId,
      lenfulStoreName,
      baseUrl,
      createdBy: user.id,
    })

    res.redirect(
      '/god-admin/fulfillments/credentials?msg=' +
        encodeURIComponent(`Credential "${label}" saved (id ${id.slice(0, 8)}). Click "Test" to verify login.`),
    )
  } catch (e: any) {
    console.error('[God Admin] Lenful credential create error:', e)
    const msg = e?.message || String(e)
    res.redirect(
      '/god-admin/fulfillments/credentials?err=' +
        encodeURIComponent('Save failed: ' + msg),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/credentials/:id/test
// ---------------------------------------------------------------------------

export async function postCredentialsTest(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/credentials?err=' + encodeURIComponent('CSRF token expired. Try again.'))
    return
  }
  const user = req.godAdmin!.user
  const credId = String(req.params.id ?? '')
  try {
    const client = new LenfulClient({
      db,
      credentialId: credId,
      triggeredBy: 'god-admin-test',
      userId: user.id,
    })
    const health = await client.healthCheck()
    if (health.ok) {
      const seller = health.seller
      const walletBal = health.wallet?.balance
      // Auto-detect lenful store id if blank and /me returned one
      const firstStore = Array.isArray(seller?.stores) && seller!.stores!.length > 0
        ? seller!.stores![0]
        : null
      if (firstStore?.id) {
        await updateCredential(db, credId, {
          lenfulStoreId: firstStore.id,
          lenfulStoreName: firstStore.name ?? undefined,
        })
      }
      res.redirect(
        '/god-admin/fulfillments/credentials?msg=' +
          encodeURIComponent(
            `OK — seller=${seller?.email || seller?.user_name || 'unknown'}` +
              (walletBal !== undefined ? ` | wallet=${walletBal}` : '') +
              (firstStore?.id ? ` | store=${firstStore.id}` : ''),
          ),
      )
      return
    }
    res.redirect(
      '/god-admin/fulfillments/credentials?err=' +
        encodeURIComponent('Health check failed: ' + (health.error || 'unknown')),
    )
  } catch (e: any) {
    console.error('[God Admin] Lenful credential test error:', e)
    res.redirect(
      '/god-admin/fulfillments/credentials?err=' +
        encodeURIComponent('Test failed: ' + (e?.message || String(e))),
    )
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/credentials/:id/delete
// ---------------------------------------------------------------------------

export async function postCredentialsDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/credentials?err=' + encodeURIComponent('CSRF token expired. Try again.'))
    return
  }
  const credId = String(req.params.id ?? '')
  try {
    await deleteCredential(db, credId)
    res.redirect(
      '/god-admin/fulfillments/credentials?msg=' +
        encodeURIComponent('Credential disabled.'),
    )
  } catch (e: any) {
    console.error('[God Admin] Lenful credential delete error:', e)
    res.redirect(
      '/god-admin/fulfillments/credentials?err=' +
        encodeURIComponent('Delete failed: ' + (e?.message || String(e))),
    )
  }
}
