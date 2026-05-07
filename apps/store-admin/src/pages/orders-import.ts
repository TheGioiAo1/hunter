/**
 * Store Admin — Order Import Wizard
 *
 * GET  /admin/store/:slug/orders/import               — Import wizard (upload + preview)
 * POST /admin/store/:slug/orders/import/upload         — Upload file, parse, preview
 * POST /admin/store/:slug/orders/import/confirm        — Confirm & insert orders
 *
 * Multi-step wizard:
 *   Step 1: Upload CSV file (auto-detects Shopify / Amazon / TikTok / generic)
 *   Step 2: Preview parsed orders + column mapping + validation errors
 *   Step 3: Confirm import → batch insert → summary report
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  importFromCsv,
  validateOrders,
  PLATFORM_PARSERS,
  type NormalizedOrder,
  type ParseResult,
} from '../../../../packages/core/src/modules/orders/import/index.js'
import { persistImportedOrders } from '../../../../packages/core/src/modules/orders/import/service.js'
import { notify } from '../lib/notify.js'
import { csrfStore, isProduction } from '../server.js'

// In-memory session store for import previews (simple approach — production
// would use Redis or temp DB table). Keyed by `shopId:userId:timestamp`.
const importSessions = new Map<string, { result: ParseResult; validOrders: NormalizedOrder[]; timestamp: number }>()

// Cleanup old sessions (>30 min)
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const [key, val] of importSessions) {
    if (val.timestamp < cutoff) importSessions.delete(key)
  }
}, 5 * 60 * 1000)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMoney(val: number | string): string {
  return '$' + Number(val || 0).toFixed(2)
}

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/orders/import — Upload step
// ---------------------------------------------------------------------------

export async function getOrderImport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken || ''
  const error = req.query.error as string || ''
  const success = req.query.success as string || ''
  // Sprint 6 — pre-select platform from `?platform=etsy` / `?platform=ebay`
  // links in the Orders page Import dropdown.
  const preselectPlatform = (req.query.platform as string) || ''

  const platformList = PLATFORM_PARSERS.map(p =>
    `<span class="badge badge-muted" style="font-size:11px">${esc(p.label)}</span>`
  ).join(' ')

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Import Orders</h1>
        <p class="page-subtitle">Upload orders from CSV, Shopify, Amazon, TikTok, Etsy, or eBay</p>
      </div>
      <a href="${base}/orders" class="btn btn-outline" style="font-size:13px">&larr; Back to Orders</a>
    </div>

    ${error ? `<div style="background:#7f1d1d;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(decodeURIComponent(error))}</div>` : ''}
    ${success ? `<div style="background:var(--s-success-bg,#065f46);color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">${esc(decodeURIComponent(success))}</div>` : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <!-- Upload Card -->
      <div class="card">
        <div class="card-header">
          <span>Step 1: Upload File</span>
        </div>
        <div class="card-body">
          <form method="post" action="${base}/orders/import/upload" enctype="multipart/form-data" id="importForm">
            <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />

            <!-- Platform selector -->
            <div style="margin-bottom:16px">
              <label style="font-size:12px;color:var(--s-text-muted);display:block;margin-bottom:6px">Source platform (auto-detected if blank)</label>
              <select name="platform" class="form-input" style="width:100%">
                <option value=""${preselectPlatform === '' ? ' selected' : ''}>Auto-detect</option>
                <option value="csv"${preselectPlatform === 'csv' ? ' selected' : ''}>Generic CSV</option>
                ${PLATFORM_PARSERS.map(p => `<option value="${esc(p.platform)}"${preselectPlatform === p.platform ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
              </select>
            </div>

            <!-- File upload -->
            <div style="margin-bottom:16px">
              <label id="dropzone" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:12px;border:2px dashed var(--s-border);border-radius:12px;padding:32px;text-align:center;transition:border-color 0.2s" ondragover="event.preventDefault();this.style.borderColor='var(--s-accent)'" ondragleave="this.style.borderColor='var(--s-border)'" ondrop="event.preventDefault();this.style.borderColor='var(--s-border)';document.getElementById('fileInput').files=event.dataTransfer.files;document.getElementById('fileName').textContent=event.dataTransfer.files[0]?.name||''">
                <svg width="40" height="40" viewBox="0 0 20 20" fill="none" stroke="var(--s-accent)" stroke-width="1.2"><path d="M10 13V3M6 7l4-4 4 4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
                <div>
                  <span style="color:var(--s-accent);font-weight:600;font-size:14px">Click to upload</span>
                  <span style="color:var(--s-text-muted);font-size:13px"> or drag and drop</span>
                </div>
                <div style="color:var(--s-text-dim);font-size:11px">CSV, TSV files. Max 10MB.</div>
                <div id="fileName" style="color:var(--s-text);font-weight:500;font-size:13px"></div>
                <input type="file" name="file" id="fileInput" accept=".csv,.tsv,.txt" style="display:none" onchange="document.getElementById('fileName').textContent=this.files[0]?.name||''" />
              </label>
            </div>

            <button type="submit" class="btn btn-primary" style="width:100%;font-size:14px;padding:10px">
              Upload & Preview
            </button>
          </form>
        </div>
      </div>

      <!-- Info Card -->
      <div>
        <div class="card">
          <div class="card-header"><span>Supported Platforms</span></div>
          <div class="card-body">
            <div style="display:flex;flex-direction:column;gap:12px">
              <div style="display:flex;align-items:center;gap:10px;font-size:13px">
                <span style="font-size:20px">📄</span>
                <div>
                  <div style="font-weight:600">Generic CSV</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Auto-maps columns by header name. Works with any CSV export.</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;font-size:13px">
                <span style="font-size:20px">🛍</span>
                <div>
                  <div style="font-weight:600">Shopify</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Direct 1:1 mapping from Shopify CSV export format.</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;font-size:13px">
                <span style="font-size:20px">📦</span>
                <div>
                  <div style="font-weight:600">Amazon</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Amazon Seller Central order reports (CSV/TSV).</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;font-size:13px">
                <span style="font-size:20px">🎵</span>
                <div>
                  <div style="font-weight:600">TikTok Shop</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">TikTok Shop seller center order export.</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;font-size:13px">
                <span style="font-size:20px">🧵</span>
                <div>
                  <div style="font-weight:600">Etsy</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Etsy Seller Dashboard → Download Data → Orders.csv.</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;font-size:13px">
                <span style="font-size:20px">🛒</span>
                <div>
                  <div style="font-weight:600">eBay</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">eBay Seller Hub → Orders → Download Report.</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <div class="card-header"><span>How it works</span></div>
          <div class="card-body" style="font-size:13px;color:var(--s-text-muted)">
            <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px">
              <li><strong>Upload</strong> your CSV/TSV file</li>
              <li><strong>Preview</strong> — we auto-detect the platform and show parsed orders</li>
              <li><strong>Review</strong> any validation errors or warnings</li>
              <li><strong>Confirm</strong> — orders are imported with "imported" tag</li>
            </ol>
            <div style="margin-top:12px;padding:8px 12px;background:var(--s-bg);border-radius:6px;font-size:12px">
              <strong>Duplicate detection:</strong> Orders with the same external ID + platform won't be imported twice.
            </div>
          </div>
        </div>
      </div>
    </div>
  `

  res.send(sellerLayout({
    title: 'Import Orders',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
    activePage: 'orders', content, theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/orders/import/upload — Parse & preview
// ---------------------------------------------------------------------------

export async function postOrderImportUpload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'

  // Issue a fresh CSRF token for the preview form.
  //
  // Why: the global GET middleware in server.ts only issues tokens on GET
  // requests. This handler is a POST (multipart upload), so `req.csrfToken`
  // is never populated — the preview form would render with an empty _csrf
  // field, and clicking "Confirm Import" would fail verification with 403.
  //
  // Fix: mint a fresh token here so the preview page always has a valid
  // token bound to the current response's Set-Cookie.
  let csrfToken = ''
  try {
    csrfToken = await csrfStore.issue(res, isProduction())
  } catch (err) {
    console.error('[Order Import] Failed to issue CSRF token for preview:', err)
  }

  const file = (req as any).file
  if (!file) {
    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'orders_import_failed',
      title: 'Order import failed',
      message: `No file uploaded • By ${user.name || user.email}`,
      resourceType: 'order_import',
      resourceId: null,
    })
    res.redirect(`${base}/orders/import?error=${encodeURIComponent('No file uploaded')}`)
    return
  }

  const csvText = file.buffer.toString('utf-8')
  const forcePlatform = req.body.platform || undefined

  try {
    // Parse
    const result = importFromCsv(csvText, forcePlatform || undefined)

    // Validate
    const { valid, errors: valErrors } = validateOrders(result.orders)
    const allErrors = [...result.errors, ...valErrors]

    // Check for duplicates in DB
    const externalIds = valid.map(o => o.external_id).filter(Boolean)
    let existingCount = 0
    if (externalIds.length > 0) {
      const existingOrders = await db.selectFrom('orders')
        .select(['id'])
        .where('shop_id', '=', store.id)
        .where('external_id' as any, 'in', externalIds)
        .execute()
        .catch(() => [])
      existingCount = existingOrders.length
    }

    // Bell-icon notification for the upload/preview step. We emit BOTH
    // here and in the confirm step because:
    //   - If parsing/validation rejects everything (e.g. 38 rows all
    //     "Order has no line items"), the user never reaches confirm and
    //     would otherwise get no bell feedback.
    //   - Merchants expect every meaningful action in the store to show
    //     up in the notification drawer, not just successful completions.
    // The type slug differs (`orders_import_previewed` vs `orders_imported`)
    // so the two steps are distinguishable in the notifications feed.
    if (valid.length === 0 && allErrors.length > 0) {
      notify(db, {
        shopId: store.id,
        userId: user.id,
        type: 'orders_import_failed',
        title: `Order import failed: ${allErrors.length} error${allErrors.length === 1 ? '' : 's'}`,
        message: `File: ${file.originalname || 'upload.csv'} • Platform: ${result.platform} • By ${user.name || user.email}`,
        resourceType: 'order_import',
        resourceId: null,
      })
    } else {
      const parts: string[] = [`${valid.length} valid`]
      if (existingCount > 0) parts.push(`${existingCount} duplicates`)
      if (allErrors.length > 0) parts.push(`${allErrors.length} error${allErrors.length === 1 ? '' : 's'}`)
      notify(db, {
        shopId: store.id,
        userId: user.id,
        type: 'orders_import_previewed',
        title: `Import preview: ${parts.join(', ')}`,
        message: `File: ${file.originalname || 'upload.csv'} • Platform: ${result.platform} • By ${user.name || user.email}`,
        resourceType: 'order_import',
        resourceId: null,
      })
    }

    // Store in session for confirm step
    const sessionKey = `${store.id}:${user.id}:${Date.now()}`
    importSessions.set(sessionKey, { result, validOrders: valid, timestamp: Date.now() })

    // Preview page
    const previewRows = valid.slice(0, 20) // Show first 20

    const content = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Import Preview</h1>
          <p class="page-subtitle">Review parsed orders before importing</p>
        </div>
        <a href="${base}/orders/import" class="btn btn-outline" style="font-size:13px">&larr; Upload Different File</a>
      </div>

      <!-- Stats -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px">
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--s-accent)">${result.totalRows}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Rows Parsed</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--s-success)">${valid.length}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Valid Orders</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:${allErrors.length > 0 ? 'var(--s-danger)' : 'var(--s-success)'}">${allErrors.length}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Errors</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--s-warning)">${existingCount}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Already Exist</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:14px;font-weight:700;color:var(--s-accent)">${esc(result.platform.toUpperCase())}</div>
          <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Detected Platform</div>
        </div>
      </div>

      ${allErrors.length > 0 ? `
        <div class="card" style="margin-bottom:20px">
          <div class="card-header">
            <span style="color:var(--s-danger)">Errors (${allErrors.length})</span>
          </div>
          <div class="card-body" style="max-height:200px;overflow-y:auto;font-size:12px">
            ${allErrors.slice(0, 50).map(e => `
              <div style="padding:4px 0;border-bottom:1px solid var(--s-border)">
                <span style="color:var(--s-danger);font-weight:600">Row ${e.row}</span>
                ${e.field ? `<span style="color:var(--s-text-muted)"> — ${esc(e.field)}</span>` : ''}
                <span>: ${esc(e.message)}</span>
              </div>
            `).join('')}
            ${allErrors.length > 50 ? `<div style="padding:8px 0;color:var(--s-text-muted)">...and ${allErrors.length - 50} more errors</div>` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Preview Table -->
      <div class="card" style="margin-bottom:20px">
        <div class="card-header">
          <span>Order Preview (first ${Math.min(20, valid.length)})</span>
          <span class="badge badge-muted">${valid.length} total</span>
        </div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>External ID</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th style="text-align:right">Total</th>
                  <th>Payment</th>
                  <th>Fulfillment</th>
                </tr>
              </thead>
              <tbody>
                ${previewRows.map(o => `
                  <tr>
                    <td style="font-family:monospace;font-size:12px">${esc(o.external_id)}</td>
                    <td style="font-size:12px">${o.created_at ? new Date(o.created_at).toLocaleDateString() : '-'}</td>
                    <td style="font-size:12px">${esc(o.email || '-')}</td>
                    <td style="font-size:12px">${o.line_items.length} item${o.line_items.length !== 1 ? 's' : ''}</td>
                    <td style="text-align:right;font-weight:600;font-size:12px">${fmtMoney(o.total_price || 0)}</td>
                    <td style="font-size:12px"><span class="badge ${o.financial_status === 'paid' ? 'badge-success' : 'badge-warning'}" style="font-size:10px">${esc(o.financial_status || 'pending')}</span></td>
                    <td style="font-size:12px"><span class="badge ${o.fulfillment_status === 'fulfilled' ? 'badge-success' : 'badge-warning'}" style="font-size:10px">${esc(o.fulfillment_status || 'unfulfilled')}</span></td>
                  </tr>
                `).join('')}
                ${valid.length === 0 ? '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--s-text-muted)">No valid orders to import</td></tr>' : ''}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Confirm Import -->
      ${valid.length > 0 ? `
        <form method="post" action="${base}/orders/import/confirm">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
          <input type="hidden" name="session_key" value="${esc(sessionKey)}" />
          <div class="card">
            <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px">
              <div style="font-size:14px">
                <strong>${valid.length - existingCount}</strong> new orders will be imported
                ${existingCount > 0 ? `<span style="color:var(--s-warning)"> (${existingCount} duplicates will be skipped)</span>` : ''}
              </div>
              <button type="submit" class="btn btn-primary" style="font-size:14px;padding:10px 24px">
                Confirm Import
              </button>
            </div>
          </div>
        </form>
      ` : ''}
    `

    res.send(sellerLayout({
      title: 'Import Preview',
      storeName: store.name, storeSlug: store.slug,
      userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
      activePage: 'orders', content, theme: theme as 'dark' | 'light',
    }))
  } catch (err: any) {
    console.error('[Order Import] Parse error:', err)
    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'orders_import_failed',
      title: 'Order import failed: parse error',
      message: `${err.message} • By ${user.name || user.email}`,
      resourceType: 'order_import',
      resourceId: null,
    })
    res.redirect(`${base}/orders/import?error=${encodeURIComponent('Parse error: ' + err.message)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/orders/import/confirm — Insert orders
// ---------------------------------------------------------------------------

export async function postOrderImportConfirm(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const sessionKey = req.body.session_key

  const session = importSessions.get(sessionKey)
  if (!session) {
    res.redirect(`${base}/orders/import?error=${encodeURIComponent('Import session expired. Please upload again.')}`)
    return
  }

  const { validOrders } = session
  importSessions.delete(sessionKey) // Consume session

  try {
    // Delegate to shared core service — same code path the REST API
    // uses, so insert semantics (tags, line items, transactions,
    // fulfillments, timeline event, dedup on external_id) are
    // identical across UI and API.
    const { imported, skipped, errors, errorMessages } = await persistImportedOrders(
      db,
      store.id,
      validOrders,
      { userId: user.id },
    )

    const successMsg = `Successfully imported ${imported} orders` +
      (skipped > 0 ? `, skipped ${skipped} duplicates` : '') +
      (errors > 0 ? `, ${errors} errors` : '')

    if (errors > 0 && errorMessages.length > 0) {
      console.error('[Order Import] Partial failures:', errorMessages)
    }

    // Bell-icon notification — so the import result shows up in the
    // notifications drawer alongside other store events. Fire-and-forget;
    // a failed insert must not break the redirect.
    if (imported > 0 || skipped > 0 || errors > 0) {
      const parts: string[] = []
      if (imported > 0) parts.push(`${imported} imported`)
      if (skipped > 0) parts.push(`${skipped} skipped`)
      if (errors > 0) parts.push(`${errors} errors`)
      const summary = parts.join(', ')
      notify(db, {
        shopId: store.id,
        userId: user.id,
        type: 'orders_imported',
        title: `Import complete: ${summary}`,
        message: `By ${user.name || user.email}`,
        resourceType: 'order_import',
        resourceId: null,
      })
    }

    res.redirect(`${base}/orders/import?success=${encodeURIComponent(successMsg)}`)
  } catch (err: any) {
    console.error('[Order Import] Confirm error:', err)
    res.redirect(`${base}/orders/import?error=${encodeURIComponent('Import failed: ' + err.message)}`)
  }
}
