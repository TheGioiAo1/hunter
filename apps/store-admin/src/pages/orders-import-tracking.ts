/**
 * Store Admin — Import Tracking Numbers (Sprint 5)
 *
 * GET  /admin/store/:slug/orders/import-tracking          — Upload form
 * POST /admin/store/:slug/orders/import-tracking/upload   — Parse CSV + preview
 * POST /admin/store/:slug/orders/import-tracking/confirm  — Apply tracking updates
 *
 * Bulk-attach tracking numbers to existing orders. Input is a simple
 * CSV with any of these header spellings (case-insensitive, auto-mapped):
 *
 *   Required (one of):
 *     - order_name / order / order id / name / #
 *     - order_number
 *
 *   Required:
 *     - tracking_number / tracking / awb
 *
 *   Optional:
 *     - tracking_company / carrier / shipping_carrier / courier
 *     - tracking_url / url
 *     - notify / notify_customer  (true/false, default true)
 *
 * Each matched order either gets a new fulfillment row created OR the
 * pending one updated with the tracking info. The order is then flipped
 * to `fulfillment_status = 'fulfilled'`. Rows that don't match an order
 * in this shop are listed as errors in the preview.
 *
 * Design mirrors `orders-import.ts` — 3-step wizard, in-memory session
 * store keyed by `shop:user:timestamp`, session expires after 30 min.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { notify } from '../lib/notify.js'
import { csrfStore, isProduction } from '../server.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrackingRow {
  row: number
  order_ref: string
  tracking_number: string
  tracking_company: string | null
  tracking_url: string | null
  notify: boolean
}

interface MatchedRow extends TrackingRow {
  order_id: string
  existing_fulfillment_id: string | null
  current_status: string | null
}

interface TrackingSession {
  matched: MatchedRow[]
  errors: Array<{ row: number; message: string }>
  timestamp: number
}

// ---------------------------------------------------------------------------
// Session store — same pattern as orders-import.ts
// ---------------------------------------------------------------------------

const trackingSessions = new Map<string, TrackingSession>()

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const [key, val] of trackingSessions) {
    if (val.timestamp < cutoff) trackingSessions.delete(key)
  }
}, 5 * 60 * 1000)

// ---------------------------------------------------------------------------
// CSV parser — minimal RFC-4180-ish, handles quoted values + commas inside
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  // Normalise line endings, strip BOM, drop trailing empty line.
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += ch
  }

  // Flush the last field / row if the file has no trailing newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  // Drop wholly-blank rows (a stray trailing newline produces one).
  return rows.filter((r) => r.some((c) => c.trim().length > 0))
}

// ---------------------------------------------------------------------------
// Header mapping — accept many common spellings
// ---------------------------------------------------------------------------

const ORDER_HEADERS = [
  'order_name',
  'order_number',
  'order',
  'order id',
  'order_id',
  'name',
  '#',
  'id',
]
const TRACKING_HEADERS = [
  'tracking_number',
  'tracking number',
  'tracking',
  'awb',
  'awb number',
]
const COMPANY_HEADERS = [
  'tracking_company',
  'tracking company',
  'carrier',
  'shipping_carrier',
  'shipping carrier',
  'courier',
]
const URL_HEADERS = ['tracking_url', 'tracking url', 'url']
const NOTIFY_HEADERS = ['notify', 'notify_customer', 'notify customer']

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ')
}

function mapHeaders(
  headers: string[],
): {
  orderIdx: number
  trackingIdx: number
  companyIdx: number
  urlIdx: number
  notifyIdx: number
} {
  const lower = headers.map(normaliseHeader)
  const findIdx = (candidates: string[]): number => {
    for (const c of candidates) {
      const i = lower.indexOf(c)
      if (i >= 0) return i
    }
    return -1
  }
  return {
    orderIdx: findIdx(ORDER_HEADERS),
    trackingIdx: findIdx(TRACKING_HEADERS),
    companyIdx: findIdx(COMPANY_HEADERS),
    urlIdx: findIdx(URL_HEADERS),
    notifyIdx: findIdx(NOTIFY_HEADERS),
  }
}

function parseBool(raw: string | undefined, fallback = true): boolean {
  if (raw === undefined || raw === null) return fallback
  const v = raw.trim().toLowerCase()
  if (v === '') return fallback
  if (['false', '0', 'no', 'n', 'off'].includes(v)) return false
  return true
}

// ---------------------------------------------------------------------------
// GET — Upload form
// ---------------------------------------------------------------------------

export async function getImportTracking(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken || ''
  const error = (req.query.error as string) || ''
  const success = (req.query.success as string) || ''

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Import tracking numbers</h1>
        <p class="page-subtitle">Bulk-attach tracking numbers to existing orders from a CSV file</p>
      </div>
      <a href="${base}/orders" class="btn btn-outline" style="font-size:13px">&larr; Back to Orders</a>
    </div>

    ${error ? `<div style="background:#7f1d1d;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(decodeURIComponent(error))}</div>` : ''}
    ${success ? `<div style="background:var(--s-success-bg,#065f46);color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(decodeURIComponent(success))}</div>` : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div class="card">
        <div class="card-header"><span>Upload CSV</span></div>
        <div class="card-body">
          <form method="post" action="${base}/orders/import-tracking/upload" enctype="multipart/form-data">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />

            <label id="dropzone" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:12px;border:2px dashed var(--s-border);border-radius:12px;padding:32px;text-align:center;transition:border-color .2s"
              ondragover="event.preventDefault();this.style.borderColor='var(--s-accent)'"
              ondragleave="this.style.borderColor='var(--s-border)'"
              ondrop="event.preventDefault();this.style.borderColor='var(--s-border)';document.getElementById('fileInput').files=event.dataTransfer.files;document.getElementById('fileName').textContent=event.dataTransfer.files[0]?.name||''">
              <svg width="40" height="40" viewBox="0 0 20 20" fill="none" stroke="var(--s-accent)" stroke-width="1.2"><path d="M10 13V3M6 7l4-4 4 4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
              <div>
                <span style="color:var(--s-accent);font-weight:600;font-size:14px">Click to upload</span>
                <span style="color:var(--s-text-muted);font-size:13px"> or drag and drop</span>
              </div>
              <div style="color:var(--s-text-dim);font-size:11px">CSV file, max 5 MB</div>
              <div id="fileName" style="color:var(--s-text);font-weight:500;font-size:13px"></div>
              <input type="file" name="file" id="fileInput" accept=".csv,.txt" style="display:none" onchange="document.getElementById('fileName').textContent=this.files[0]?.name||''" />
            </label>

            <div style="margin-top:16px">
              <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
                <input type="checkbox" name="notify_all" value="1" checked style="width:14px;height:14px;accent-color:var(--s-accent)" />
                <span>Notify customers by email when tracking is added</span>
              </label>
              <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px;margin-left:22px">
                Per-row <code>notify</code> column overrides this default.
              </div>
            </div>

            <button type="submit" class="btn btn-primary" style="width:100%;margin-top:16px;font-size:14px;padding:10px">
              Upload &amp; Preview
            </button>
          </form>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-header"><span>CSV format</span></div>
          <div class="card-body" style="font-size:13px;color:var(--s-text-muted)">
            <p style="margin:0 0 10px 0">
              First row is headers. Column order doesn't matter — we auto-map by header name.
            </p>
            <pre style="background:var(--s-bg);padding:12px;border-radius:6px;font-size:11px;overflow-x:auto;margin:0 0 10px 0;color:var(--s-text)">order_name,tracking_number,tracking_company,tracking_url
#1001,1Z999AA10123456784,UPS,https://ups.com/track?n=1Z...
#1002,9400111899223344556677,USPS,
#1003,TBA123456789000,Amazon Logistics,</pre>
            <p style="margin:0 0 6px 0;font-weight:600;color:var(--s-text)">Accepted header names</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.7">
              <li><strong>Order</strong>: order_name, order_number, order, name, #</li>
              <li><strong>Tracking</strong>: tracking_number, tracking, awb</li>
              <li><strong>Carrier</strong> (optional): tracking_company, carrier, courier</li>
              <li><strong>URL</strong> (optional): tracking_url, url</li>
              <li><strong>Notify</strong> (optional): notify, notify_customer</li>
            </ul>
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-header"><span>What happens on import</span></div>
          <div class="card-body" style="font-size:13px;color:var(--s-text-muted)">
            <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">
              <li>Match each row to an order by name/number in <em>${esc(store.name)}</em></li>
              <li>Create or update a fulfillment row with the tracking info</li>
              <li>Flip the order's fulfillment status to <strong>fulfilled</strong></li>
              <li>Customer-notification email is queued when <code>notify</code> is true</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  `

  res.send(
    sellerLayout({
      title: 'Import tracking numbers',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'orders',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /upload — Parse + preview
// ---------------------------------------------------------------------------

export async function postImportTrackingUpload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'

  // Issue a fresh CSRF token for the preview form (this handler is a POST,
  // so the global GET-only CSRF middleware never populates req.csrfToken).
  // See postOrderImportUpload for the full rationale.
  let csrfToken = ''
  try {
    csrfToken = await csrfStore.issue(res, isProduction())
  } catch (err) {
    console.error('[Tracking Import] Failed to issue CSRF token for preview:', err)
  }

  const file = (req as any).file as { buffer: Buffer; originalname?: string } | undefined
  if (!file) {
    res.redirect(
      `${base}/orders/import-tracking?error=${encodeURIComponent('No file uploaded')}`,
    )
    return
  }

  const notifyDefault = parseBool(req.body.notify_all, true)

  let rows: string[][]
  try {
    rows = parseCsv(file.buffer.toString('utf-8'))
  } catch (err: any) {
    res.redirect(
      `${base}/orders/import-tracking?error=${encodeURIComponent('CSV parse failed: ' + err.message)}`,
    )
    return
  }

  if (rows.length < 2) {
    res.redirect(
      `${base}/orders/import-tracking?error=${encodeURIComponent('CSV must contain a header row and at least one data row')}`,
    )
    return
  }

  const headers = rows[0]
  const map = mapHeaders(headers)
  if (map.orderIdx < 0 || map.trackingIdx < 0) {
    res.redirect(
      `${base}/orders/import-tracking?error=${encodeURIComponent('Missing required columns. Need one of [order_name, order_number, #, name] AND one of [tracking_number, tracking, awb]')}`,
    )
    return
  }

  // Parse data rows into TrackingRow
  const parsed: TrackingRow[] = []
  const errors: Array<{ row: number; message: string }> = []

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const orderRef = (r[map.orderIdx] ?? '').trim()
    const trackingNumber = (r[map.trackingIdx] ?? '').trim()
    if (!orderRef && !trackingNumber) continue // empty row
    if (!orderRef) {
      errors.push({ row: i + 1, message: 'Missing order reference' })
      continue
    }
    if (!trackingNumber) {
      errors.push({ row: i + 1, message: 'Missing tracking number' })
      continue
    }
    parsed.push({
      row: i + 1,
      order_ref: orderRef,
      tracking_number: trackingNumber,
      tracking_company:
        map.companyIdx >= 0 ? (r[map.companyIdx] ?? '').trim() || null : null,
      tracking_url:
        map.urlIdx >= 0 ? (r[map.urlIdx] ?? '').trim() || null : null,
      notify:
        map.notifyIdx >= 0
          ? parseBool(r[map.notifyIdx], notifyDefault)
          : notifyDefault,
    })
  }

  // Match each row to an order — single query by name IN (...)
  const refs = Array.from(new Set(parsed.map((p) => p.order_ref)))
  // Normalise — strip leading '#' since order.name conventionally stores it.
  const normalisedRefs = Array.from(
    new Set(refs.flatMap((r) => [r, r.replace(/^#/, ''), '#' + r.replace(/^#/, '')])),
  )

  const matchedOrders = normalisedRefs.length
    ? await db
        .selectFrom('orders')
        .select(['id', 'name', 'fulfillment_status'])
        .where('shop_id', '=', store.id)
        .where((eb) =>
          eb.or([
            eb('name', 'in', normalisedRefs),
            eb('order_number' as any, 'in', normalisedRefs.map((r) => Number(r)).filter((n) => !Number.isNaN(n)) as any),
          ]),
        )
        .execute()
        .catch(() => [] as Array<{ id: string; name: string; fulfillment_status: string | null }>)
    : []

  const byName = new Map<string, { id: string; fulfillment_status: string | null }>()
  for (const o of matchedOrders) {
    byName.set(o.name, { id: o.id, fulfillment_status: o.fulfillment_status })
    byName.set(o.name.replace(/^#/, ''), {
      id: o.id,
      fulfillment_status: o.fulfillment_status,
    })
  }

  // Pre-load any existing fulfillments for these orders so we can prefer
  // updating the pending row over creating a duplicate.
  const orderIds = Array.from(
    new Set(
      parsed
        .map((p) => byName.get(p.order_ref)?.id ?? byName.get(p.order_ref.replace(/^#/, ''))?.id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  )
  const existingFulfillments = orderIds.length
    ? await db
        .selectFrom('fulfillments')
        .select(['id', 'order_id', 'status', 'tracking_number'])
        .where('order_id', 'in', orderIds)
        .execute()
        .catch(() => [] as Array<{ id: string; order_id: string; status: string; tracking_number: string | null }>)
    : []

  const firstPendingByOrder = new Map<string, string>()
  for (const f of existingFulfillments) {
    if ((f.status === 'pending' || f.status === 'open') && !f.tracking_number) {
      if (!firstPendingByOrder.has(f.order_id)) {
        firstPendingByOrder.set(f.order_id, f.id)
      }
    }
  }

  const matched: MatchedRow[] = []
  for (const p of parsed) {
    const hit =
      byName.get(p.order_ref) ?? byName.get(p.order_ref.replace(/^#/, ''))
    if (!hit) {
      errors.push({ row: p.row, message: `Order "${p.order_ref}" not found` })
      continue
    }
    matched.push({
      ...p,
      order_id: hit.id,
      existing_fulfillment_id: firstPendingByOrder.get(hit.id) ?? null,
      current_status: hit.fulfillment_status,
    })
  }

  // Persist session for confirm step
  const sessionKey = `${store.id}:${user.id}:${Date.now()}`
  trackingSessions.set(sessionKey, {
    matched,
    errors,
    timestamp: Date.now(),
  })

  const previewRows = matched.slice(0, 50)

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Import tracking — Preview</h1>
        <p class="page-subtitle">Review matched orders before applying updates</p>
      </div>
      <a href="${base}/orders/import-tracking" class="btn btn-outline" style="font-size:13px">&larr; Upload different file</a>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px">
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-accent)">${rows.length - 1}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Rows parsed</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-success,#10b981)">${matched.length}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Matched</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:${errors.length > 0 ? 'var(--s-danger,#ef4444)' : 'var(--s-text-muted)'}">${errors.length}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Errors</div>
      </div>
    </div>

    ${errors.length > 0 ? `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span style="color:var(--s-danger,#ef4444)">Errors (${errors.length})</span></div>
        <div class="card-body" style="max-height:200px;overflow-y:auto;font-size:12px">
          ${errors.slice(0, 100).map((e) => `
            <div style="padding:4px 0;border-bottom:1px solid var(--s-border)">
              <span style="color:var(--s-danger,#ef4444);font-weight:600">Row ${e.row}</span>: ${esc(e.message)}
            </div>`).join('')}
          ${errors.length > 100 ? `<div style="padding:8px 0;color:var(--s-text-muted)">...and ${errors.length - 100} more</div>` : ''}
        </div>
      </div>
    ` : ''}

    ${matched.length > 0 ? `
      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span>Matched rows (${matched.length})</span></div>
        <div class="card-body" style="padding:0;overflow-x:auto">
          <table class="table" style="width:100%;font-size:13px">
            <thead>
              <tr>
                <th style="text-align:left;padding:8px 12px">Row</th>
                <th style="text-align:left;padding:8px 12px">Order</th>
                <th style="text-align:left;padding:8px 12px">Tracking #</th>
                <th style="text-align:left;padding:8px 12px">Carrier</th>
                <th style="text-align:left;padding:8px 12px">Notify</th>
                <th style="text-align:left;padding:8px 12px">Action</th>
              </tr>
            </thead>
            <tbody>
              ${previewRows.map((m) => `
                <tr>
                  <td style="padding:8px 12px;color:var(--s-text-muted)">${m.row}</td>
                  <td style="padding:8px 12px;font-weight:600">${esc(m.order_ref)}</td>
                  <td style="padding:8px 12px"><code style="font-size:12px">${esc(m.tracking_number)}</code></td>
                  <td style="padding:8px 12px">${esc(m.tracking_company || '—')}</td>
                  <td style="padding:8px 12px">${m.notify ? '<span style="color:var(--s-success,#10b981)">Yes</span>' : '<span style="color:var(--s-text-muted)">No</span>'}</td>
                  <td style="padding:8px 12px;font-size:12px;color:var(--s-text-muted)">${m.existing_fulfillment_id ? 'Update pending fulfillment' : 'Create new fulfillment'}</td>
                </tr>`).join('')}
              ${matched.length > 50 ? `<tr><td colspan="6" style="padding:8px 12px;color:var(--s-text-muted);text-align:center">…and ${matched.length - 50} more rows will be imported</td></tr>` : ''}
            </tbody>
          </table>
        </div>
      </div>

      <form method="post" action="${base}/orders/import-tracking/confirm" style="display:flex;gap:12px">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
        <input type="hidden" name="session_key" value="${esc(sessionKey)}" />
        <button type="submit" class="btn btn-primary" style="flex:1;font-size:14px;padding:12px">
          Apply tracking to ${matched.length} order${matched.length === 1 ? '' : 's'}
        </button>
        <a href="${base}/orders/import-tracking" class="btn btn-outline" style="font-size:14px;padding:12px">Cancel</a>
      </form>
    ` : `
      <div class="card" style="padding:24px;text-align:center">
        <p style="margin:0;color:var(--s-text-muted)">No rows matched any existing orders. Fix the errors above and re-upload.</p>
      </div>
    `}
  `

  res.send(
    sellerLayout({
      title: 'Import tracking — Preview',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'orders',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /confirm — Apply
// ---------------------------------------------------------------------------

export async function postImportTrackingConfirm(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const base = `/admin/store/${store.slug}`

  const sessionKey = (req.body.session_key as string) || ''
  const session = trackingSessions.get(sessionKey)
  if (!session) {
    res.redirect(
      `${base}/orders/import-tracking?error=${encodeURIComponent('Preview session expired. Please upload again.')}`,
    )
    return
  }

  let updated = 0
  let created = 0
  let failed = 0
  const nowIso = new Date().toISOString()

  try {
    await db.transaction().execute(async (trx) => {
      for (const m of session.matched) {
        try {
          if (m.existing_fulfillment_id) {
            await trx
              .updateTable('fulfillments')
              .set({
                tracking_number: m.tracking_number,
                tracking_company: m.tracking_company,
                tracking_url: m.tracking_url,
                status: 'success',
                shipped_at: nowIso,
                updated_at: nowIso,
              } as any)
              .where('id', '=', m.existing_fulfillment_id)
              .execute()
            updated++
          } else {
            await trx
              .insertInto('fulfillments')
              .values({
                order_id: m.order_id,
                status: 'success',
                tracking_number: m.tracking_number,
                tracking_company: m.tracking_company,
                tracking_url: m.tracking_url,
                shipped_at: nowIso,
              } as any)
              .execute()
            created++
          }

          // Flip the order to fulfilled
          await trx
            .updateTable('orders')
            .set({ fulfillment_status: 'fulfilled' } as any)
            .where('shop_id', '=', store.id)
            .where('id', '=', m.order_id)
            .execute()
        } catch (err: any) {
          console.error(
            `[import-tracking] row ${m.row} (${m.order_ref}) failed:`,
            err.message,
          )
          failed++
        }
      }
    })
  } catch (err: any) {
    trackingSessions.delete(sessionKey)
    res.redirect(
      `${base}/orders/import-tracking?error=${encodeURIComponent('Import failed: ' + err.message)}`,
    )
    return
  }

  trackingSessions.delete(sessionKey)

  const parts: string[] = []
  if (created > 0) parts.push(`${created} fulfillment${created === 1 ? '' : 's'} created`)
  if (updated > 0) parts.push(`${updated} updated`)
  if (failed > 0) parts.push(`${failed} failed`)
  const msg = parts.join(', ') || 'Nothing changed'

  // Bell-icon notification — fire-and-forget. Captures bulk tracking
  // imports in the activity feed alongside order imports/exports.
  if (created > 0 || updated > 0 || failed > 0) {
    notify(db, {
      shopId: store.id,
      userId: user?.id ?? null,
      type: 'tracking_imported',
      title: `Tracking import: ${msg}`,
      message: user ? `By ${user.name || user.email}` : null,
      resourceType: 'tracking_import',
      resourceId: null,
    })
  }

  res.redirect(
    `${base}/orders/import-tracking?success=${encodeURIComponent(msg)}`,
  )
}
