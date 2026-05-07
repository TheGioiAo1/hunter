/**
 * God Admin — Lenful Design Library (Phase F1)
 *
 *   GET  /god-admin/fulfillments/designs          — list + search
 *   POST /god-admin/fulfillments/designs/sync     — pull latest from Lenful
 *
 * Designs are normally created implicitly when push-order sends a POD
 * artwork to Lenful — Lenful returns a `design_sku` which push-order
 * records in `lenful_order_items`. This page lets the god admin sync
 * the full Lenful design library on demand so designs created outside
 * the Gbox flow (or via legacy uploads) are discoverable.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '../../../../packages/db/src/index.js'
import { godLayout } from '../layouts/god-layout.js'
import { createCsrfStore } from '../../../../packages/core/src/modules/auth/csrf-express.js'
import {
  listDesignLibrary,
  upsertDesignRow,
  getActiveCredential,
  LenfulClient,
} from '../../../../packages/core/src/modules/fulfillment/lenful/index.js'

const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_lenful_designs' })

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
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return String(iso)
  }
}

// ---------------------------------------------------------------------------
// GET /god-admin/fulfillments/designs
// ---------------------------------------------------------------------------

export async function getDesigns(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const user = req.godAdmin!.user
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1)
  const search = String(req.query.q ?? '').trim()
  const csrfToken = await csrfStore.issue(res, isProduction())
  const csrfField = csrfStore.hiddenField(csrfToken)
  const flash = typeof req.query.msg === 'string' ? req.query.msg : ''
  const err = typeof req.query.err === 'string' ? req.query.err : ''

  try {
    const { rows, total } = await listDesignLibrary(db, { search, page, limit: 40 })
    const pageCount = Math.max(1, Math.ceil(total / 40))

    const cards = rows.length
      ? rows
          .map(
            (d) => `
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden">
          <div style="aspect-ratio:1/1;background:#020617;display:flex;align-items:center;justify-content:center;overflow:hidden">
            ${d.preview_url || d.front_link
              ? `<img src="${esc(d.preview_url || d.front_link || '')}" alt="${esc(d.title || d.lenful_design_sku)}" style="width:100%;height:100%;object-fit:cover" loading="lazy">`
              : `<div style="color:#475569;font-size:11px">no preview</div>`}
          </div>
          <div style="padding:10px 12px">
            <div style="font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(d.title || '')}">${esc(d.title || '(untitled)')}</div>
            <div style="font-size:10px;color:#94a3b8;font-family:monospace;margin-top:2px">${esc(d.lenful_design_sku)}</div>
            <div style="font-size:10px;color:#64748b;margin-top:4px">synced ${shortDate(d.last_synced_at)}</div>
          </div>
        </div>
          `,
          )
          .join('')
      : `<div style="grid-column:1/-1;padding:48px;text-align:center;color:#64748b">No designs synced yet. Click <strong>Sync from Lenful</strong> above.</div>`

    const prevPage = Math.max(1, page - 1)
    const nextPage = Math.min(pageCount, page + 1)

    const content = `
      <div style="padding:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <div>
            <h1 style="margin:0 0 4px;font-size:22px;color:#fff">Lenful Design Library</h1>
            <p style="margin:0;color:#94a3b8;font-size:13px">${total} designs • page ${page}/${pageCount}</p>
          </div>
          <form method="POST" action="/god-admin/fulfillments/designs/sync">
            ${csrfField}
            <button type="submit" style="padding:10px 20px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">
              Sync from Lenful
            </button>
          </form>
        </div>

        ${flash ? `<div style="padding:10px 14px;border:1px solid #10b98166;background:#10b98122;border-radius:10px;margin:12px 0;font-size:13px;color:#86efac">${esc(flash)}</div>` : ''}
        ${err ? `<div style="padding:10px 14px;border:1px solid #ef444466;background:#ef444422;border-radius:10px;margin:12px 0;font-size:13px;color:#fecaca">${esc(err)}</div>` : ''}

        <form method="GET" style="display:flex;gap:8px;margin-bottom:16px">
          <input type="text" name="q" value="${esc(search)}" placeholder="Search by title or design_sku…"
                 style="flex:1;max-width:360px;padding:10px 14px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#e2e8f0">
          <button type="submit" style="padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Search</button>
        </form>

        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px">
          ${cards}
        </div>

        <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
          ${page > 1 ? `<a href="?page=${prevPage}${search ? `&q=${encodeURIComponent(search)}` : ''}" style="padding:8px 16px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none">← Prev</a>` : ''}
          ${page < pageCount ? `<a href="?page=${nextPage}${search ? `&q=${encodeURIComponent(search)}` : ''}" style="padding:8px 16px;background:#1e293b;color:#cbd5e1;border-radius:6px;text-decoration:none">Next →</a>` : ''}
        </div>
      </div>
    `

    res.send(
      godLayout({
        title: 'Lenful Designs',
        userEmail: user.email,
        activePath: '/god-admin/fulfillments/designs',
        content,
      }),
    )
  } catch (e: any) {
    console.error('[god-admin] lenful designs error:', e)
    res.status(500).send('Error: ' + esc(e?.message ?? String(e)))
  }
}

// ---------------------------------------------------------------------------
// POST /god-admin/fulfillments/designs/sync
// ---------------------------------------------------------------------------

export async function postDesignsSync(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  if (!(await csrfStore.verify(req))) {
    res.redirect('/god-admin/fulfillments/designs?err=' + encodeURIComponent('CSRF expired.'))
    return
  }
  const user = req.godAdmin!.user
  try {
    const cred = await getActiveCredential(db)
    if (!cred) {
      res.redirect('/god-admin/fulfillments/designs?err=' + encodeURIComponent('No active credential.'))
      return
    }
    const client = new LenfulClient({
      db,
      credentialId: cred.id,
      triggeredBy: 'god-admin-designs-sync',
      userId: user.id,
    })

    // Pull up to 5 pages of designs (250 total). Lenful paginates; larger
    // syncs should run via cron in F5.
    let synced = 0
    for (let page = 1; page <= 5; page++) {
      const { items } = await client.listDesigns({ page, limit: 50 })
      if (items.length === 0) break
      for (const d of items) {
        const id = (d as any).id ?? (d as any).design_id
        const sku = (d as any).design_sku ?? (d as any).sku
        if (!id || !sku) continue
        await upsertDesignRow(db, {
          lenful_design_id: String(id),
          lenful_design_sku: String(sku),
          title: (d as any).title ?? (d as any).name ?? null,
          preview_url: (d as any).preview_url ?? (d as any).thumbnail ?? null,
          front_link: (d as any).front_link ?? null,
          back_link: (d as any).back_link ?? null,
          left_chest_link: (d as any).left_chest_link ?? null,
          right_chest_link: (d as any).right_chest_link ?? null,
          left_sleeve_link: (d as any).left_sleeve_link ?? null,
          right_sleeve_link: (d as any).right_sleeve_link ?? null,
          neck_link: (d as any).neck_link ?? null,
          raw: d,
        })
        synced++
      }
      if (items.length < 50) break
    }
    res.redirect(
      '/god-admin/fulfillments/designs?msg=' +
        encodeURIComponent(`Synced ${synced} designs from Lenful.`),
    )
  } catch (e: any) {
    console.error('[god-admin] lenful designs sync error:', e)
    res.redirect(
      '/god-admin/fulfillments/designs?err=' + encodeURIComponent(e?.message ?? String(e)),
    )
  }
}
