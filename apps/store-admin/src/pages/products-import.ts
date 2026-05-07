/**
 * Store Admin — Product Import (dry-run preview)
 *
 * GET  /admin/store/:slug/products/import             — upload form + instructions
 * POST /admin/store/:slug/products/import/upload      — parse + validate + build dry-run plan
 *
 * Accepts a Shopify-compatible Products CSV and shows the seller exactly
 * what *would* happen if they committed the import: product-level
 * create/update counts, variant-level actions, and a row-by-row issue
 * log. Nothing is written to the database in this PR — the commit path
 * ships in a follow-up.
 *
 * The parser + validator + buildImportPlan pipeline all live in
 * packages/core/src/modules/products/import/ and are shared with the
 * REST API (pending).
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { parseCsv, ParseError } from '@gbox/core/modules/products/import/csv-parser.js'
import { buildImportPlan } from '@gbox/core/modules/products/import/service.js'
import type { ImportPlan } from '@gbox/core/modules/products/import/service.js'
import type { ValidationIssue } from '@gbox/core/modules/products/import/validator.js'
import { createApiContext, createProduct, updateProduct } from '../lib/product-api-client.js'
import { ProductApiError } from '../lib/product-api-errors.js'

// ---------------------------------------------------------------------------
// GET — upload form
// ---------------------------------------------------------------------------

export async function getProductImport(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'

  const errorParam = typeof req.query.error === 'string' ? req.query.error : ''

  const content = renderUploadPage({ base, error: errorParam, plan: null })

  res.send(
    sellerLayout({
      title: 'Import products',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST — parse + validate + plan preview
// ---------------------------------------------------------------------------

export async function postProductImportUpload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  const file = (req as any).file as { buffer: Buffer; originalname: string; mimetype: string } | undefined
  if (!file || !file.buffer || file.buffer.length === 0) {
    res.redirect(`${base}/products/import?error=no_file`)
    return
  }

  const name = file.originalname ?? 'upload.psv'
  const text = (() => {
    const raw = file.buffer.toString('utf8')
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  })()

  // Format detect — `.psv` ext hoặc header line dùng '|' separator → PSV mode.
  // PSV mode commit thẳng qua BE API (không preview như CSV legacy).
  const isPsv = /\.psv$/i.test(name) || (text.split('\n')[0] ?? '').includes('|')

  if (isPsv) {
    let ctx
    try { ctx = createApiContext(req) } catch {
      res.redirect(`${base}/products/import?error=auth_required`); return
    }
    let psvResult: PsvImportResult
    try {
      const rows = parsePsv(text)
      psvResult = await commitPsvImport(ctx, rows)
    } catch (err: any) {
      if (err instanceof ProductApiError && err.kind === 'auth') {
        res.redirect('/accounts/login'); return
      }
      const msg = err instanceof Error ? err.message : 'parse_failed'
      console.error('[products/import] PSV parse failed:', msg)
      res.redirect(`${base}/products/import?error=${encodeURIComponent(msg)}`)
      return
    }
    res.send(sellerLayout({
      title: 'Import result',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content: renderPsvResult(base, name, psvResult),
      theme: theme as 'dark' | 'light',
    }))
    return
  }

  // CSV legacy path — Shopify CSV preview (DB mode only).
  if (!hasDb) {
    res.redirect(`${base}/products/import?error=${encodeURIComponent('CSV import requires DB mode. Use PSV format from Export tool.')}`)
    return
  }
  const looksLikeCsv = /\.csv$/i.test(name) || /text\/csv|text\/plain|application\/vnd\.ms-excel/i.test(file.mimetype ?? '')

  let plan: ImportPlan | null = null
  let parseError: string | null = null
  let parseNotes: Array<{ line: number; message: string }> = []

  try {
    const parsed = parseCsv(text)
    parseNotes = parsed.notes
    plan = await buildImportPlan(store.id, parsed.products, db)
  } catch (err: any) {
    if (err instanceof ParseError) {
      parseError = `Line ${err.line}${err.column != null ? `, col ${err.column}` : ''}: ${err.message}`
    } else {
      console.error('[Product Import Error]', err)
      parseError = err?.message ?? 'Failed to parse CSV'
    }
  }

  const content = renderUploadPage({
    base,
    error: parseError,
    plan,
    fileName: name,
    looksLikeCsv,
    parseNotes,
  })

  res.send(
    sellerLayout({
      title: 'Import preview',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface RenderOptions {
  base: string
  error: string | null
  plan: ImportPlan | null
  fileName?: string
  looksLikeCsv?: boolean
  parseNotes?: Array<{ line: number; message: string }>
}

function renderUploadPage(opts: RenderOptions): string {
  const { base, error, plan, fileName, looksLikeCsv, parseNotes } = opts
  const hasPreview = plan !== null

  const errorBanner = error
    ? `<div class="card" style="background:#fff4f4;border:1px solid #f8d5d5;color:#a61b1b;padding:12px 16px;margin-bottom:16px;font-size:13px">
         <strong>Could not parse:</strong> ${esc(decodeErrorMessage(error))}
       </div>`
    : ''

  const mimeWarning =
    hasPreview && looksLikeCsv === false
      ? `<div class="card" style="background:#fff8e1;border:1px solid #f0d78a;color:#6a4800;padding:10px 14px;margin-bottom:16px;font-size:13px">
           <strong>Heads up:</strong> "${esc(fileName ?? '')}" doesn't look like a CSV file. If you uploaded an Excel
           workbook, export it to <em>CSV (Comma delimited)</em> first for best results.
         </div>`
      : ''

  const notesSection =
    parseNotes && parseNotes.length > 0
      ? `<div class="card" style="background:#f6f7f9;border:1px solid var(--s-border);padding:10px 14px;margin-bottom:16px;font-size:12px">
           <strong>Parser notes:</strong>
           <ul style="margin:6px 0 0 18px;padding:0">
             ${parseNotes.map((n) => `<li>Line ${n.line}: ${esc(n.message)}</li>`).join('')}
           </ul>
         </div>`
      : ''

  const uploadForm = `
    <form method="post" action="${base}/products/import/upload" enctype="multipart/form-data">
      <div class="card">
        <div class="card-header"><span>Upload PSV / CSV</span></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <p style="margin:0;color:var(--s-text-secondary);font-size:13px">
            <strong>PSV</strong> (.psv, pipe-separated, từ Export tool) — commits qua BE Product API ngay.<br/>
            <strong>CSV</strong> (Shopify format) — preview only (DB mode).
          </p>
          <input type="file" name="csv" accept=".psv,.csv,text/csv,text/plain" required
                 class="form-input" style="padding:8px" />
          <div style="color:var(--s-text-muted);font-size:11px">
            Max 20 MB. First row = header. Recommended workflow: export PSV với
            <a href="${base}/products/export" style="color:var(--s-accent)">Export tool</a>,
            sửa file (thêm/xóa/edit hàng), upload lại đây. Row có cột <code>id</code> → update; trống → create mới.
          </div>
          <div>
            <button type="submit" class="btn btn-primary">Upload &amp; commit</button>
          </div>
        </div>
      </div>
    </form>
  `

  const planSummary = hasPreview ? renderPlanSummary(plan!) : ''
  const planBody = hasPreview ? renderPlanDetails(plan!) : ''

  return `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <div>
        <h1 class="page-title" style="margin:0;font-size:22px;font-weight:700">Import products</h1>
        <p class="page-subtitle" style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">
          Upload a CSV to preview changes. This PR is read-only — the commit button arrives in the next release.
        </p>
      </div>
      <a href="${base}/products" class="btn btn-outline" style="font-size:13px">&larr; Back to products</a>
    </div>

    ${errorBanner}
    ${mimeWarning}
    ${notesSection}
    ${uploadForm}
    ${planSummary}
    ${planBody}
  `
}

function renderPlanSummary(plan: ImportPlan): string {
  const cards: Array<{ label: string; value: number; color?: string }> = [
    { label: 'Products creating', value: plan.stats.productsCreating, color: 'var(--s-success)' },
    { label: 'Products updating', value: plan.stats.productsUpdating, color: 'var(--s-accent)' },
    { label: 'Products blocked', value: plan.stats.productsBlocked, color: 'var(--s-danger, #d9534f)' },
    { label: 'Variants creating', value: plan.stats.variantsCreating },
    { label: 'Variants updating', value: plan.stats.variantsUpdating },
  ]

  return `
    <div style="margin-top:24px">
      <h2 style="margin:0 0 12px;font-size:16px;font-weight:600">Dry-run summary</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
        ${cards
          .map(
            (c) => `
          <div class="card" style="padding:14px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:${c.color ?? 'var(--s-text-primary)'}">${c.value}</div>
            <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">${esc(c.label)}</div>
          </div>`,
          )
          .join('')}
      </div>
    </div>
  `
}

function renderPlanDetails(plan: ImportPlan): string {
  const errorIssues = plan.issues.filter((i) => i.severity === 'error')
  const warningIssues = plan.issues.filter((i) => i.severity === 'warning')

  return `
    ${renderIssueTable(errorIssues, 'error')}
    ${renderIssueTable(warningIssues, 'warning')}
    ${renderPlanItemsTable(plan)}
  `
}

function renderIssueTable(issues: ValidationIssue[], kind: 'error' | 'warning'): string {
  if (issues.length === 0) return ''
  const title = kind === 'error' ? `Errors (${issues.length})` : `Warnings (${issues.length})`
  const color = kind === 'error' ? '#a61b1b' : '#8a5a00'
  const bg = kind === 'error' ? '#fff4f4' : '#fff8e1'
  const border = kind === 'error' ? '#f8d5d5' : '#f0d78a'

  return `
    <div style="margin-top:20px">
      <h3 style="margin:0 0 8px;font-size:14px;font-weight:600;color:${color}">${esc(title)}</h3>
      <div class="card" style="background:${bg};border:1px solid ${border};padding:0;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:rgba(0,0,0,0.04)">
              <th style="text-align:left;padding:8px 12px">Row</th>
              <th style="text-align:left;padding:8px 12px">Handle</th>
              <th style="text-align:left;padding:8px 12px">SKU</th>
              <th style="text-align:left;padding:8px 12px">Column</th>
              <th style="text-align:left;padding:8px 12px">Message</th>
            </tr>
          </thead>
          <tbody>
            ${issues
              .map(
                (i) => `
              <tr style="border-top:1px solid ${border}">
                <td style="padding:8px 12px;color:${color};font-variant-numeric:tabular-nums">${i.line}</td>
                <td style="padding:8px 12px"><code style="font-size:11px">${esc(i.handle)}</code></td>
                <td style="padding:8px 12px"><code style="font-size:11px">${esc(i.sku ?? '')}</code></td>
                <td style="padding:8px 12px">${esc(i.column ?? '')}</td>
                <td style="padding:8px 12px">${esc(i.message)}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `
}

function renderPlanItemsTable(plan: ImportPlan): string {
  if (plan.items.length === 0) {
    return `<div class="card" style="margin-top:20px;padding:14px;color:var(--s-text-muted);font-size:13px">
      No product rows parsed from the upload.
    </div>`
  }

  return `
    <div style="margin-top:20px">
      <h3 style="margin:0 0 8px;font-size:14px;font-weight:600">Per-product plan</h3>
      <div class="card" style="padding:0;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:var(--s-muted-bg, rgba(0,0,0,0.04))">
              <th style="text-align:left;padding:8px 12px">Handle</th>
              <th style="text-align:left;padding:8px 12px">Action</th>
              <th style="text-align:right;padding:8px 12px">Variants create</th>
              <th style="text-align:right;padding:8px 12px">Variants update</th>
              <th style="text-align:right;padding:8px 12px">Images</th>
              <th style="text-align:left;padding:8px 12px">Existing ID</th>
            </tr>
          </thead>
          <tbody>
            ${plan.items
              .map((it) => {
                const actionColor =
                  it.action === 'create'
                    ? 'var(--s-success)'
                    : it.action === 'update'
                      ? 'var(--s-accent)'
                      : 'var(--s-danger, #d9534f)'
                const vcreate = it.variantPlan.filter((v) => v.action === 'create').length
                const vupdate = it.variantPlan.filter((v) => v.action === 'update').length
                return `
                  <tr style="border-top:1px solid var(--s-border)">
                    <td style="padding:8px 12px"><code style="font-size:11px">${esc(it.handle)}</code></td>
                    <td style="padding:8px 12px;color:${actionColor};font-weight:600;text-transform:uppercase;font-size:11px">${esc(it.action)}</td>
                    <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums">${vcreate}</td>
                    <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums">${vupdate}</td>
                    <td style="padding:8px 12px;text-align:right;font-variant-numeric:tabular-nums">${it.parsed.images.length}</td>
                    <td style="padding:8px 12px;color:var(--s-text-muted);font-size:11px">${esc(it.existingProductId ?? '—')}</td>
                  </tr>`
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeErrorMessage(raw: string): string {
  if (raw === 'no_file') return 'Please choose a CSV/PSV file to upload.'
  if (raw === 'auth_required') return 'Session expired — please re-login.'
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// ---------------------------------------------------------------------------
// PSV (pipe-separated) — parse + commit qua BE Product API
// ---------------------------------------------------------------------------

interface PsvImportItem {
  line: number
  name: string
  ok: boolean
  action: 'create' | 'update'
  id?: string
  error?: string
}

interface PsvImportResult {
  total: number
  created: number
  updated: number
  failed: number
  items: PsvImportItem[]
}

/**
 * Parse PSV: line 1 = header, mỗi line tiếp theo = product. Field separator
 * '|', escape '\|'. Match exact format từ products-export.ts.
 */
function parsePsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length < 2) return []
  const headers = splitPsvLine(lines[0])
  const rows: Array<Record<string, string>> = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitPsvLine(lines[i])
    if (cells.length === 0 || cells.every((c) => !c)) continue
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cells[j] ?? ''
    rows.push(row)
  }
  return rows
}

function splitPsvLine(line: string): string[] {
  const cells: string[] = []
  let buf = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) {
      buf += line[i + 1]
      i++
      continue
    }
    if (c === '|') { cells.push(buf); buf = ''; continue }
    buf += c
  }
  cells.push(buf)
  return cells
}

/**
 * Build BE Product payload từ PSV row. Reverse các transform của export:
 * - tags: comma-split → string[]
 * - categories: comma-split names → [{name}]
 * - images: comma-split URLs → [{url}]
 * - options: 'Size:S,M;Color:Black,White' → [{name, values:[{name}, ...]}]
 * - variants: JSON.parse (giữ nguyên BE shape)
 * - variant_default: từ sku/price/old_price/base_cost/inventory cột riêng
 */
function buildPayloadFromPsvRow(row: Record<string, string>): any {
  const split = (s: string, sep = ','): string[] =>
    s ? s.split(sep).map((x) => x.trim()).filter(Boolean) : []

  const payload: any = {
    name: row.name || '',
    slug: row.slug || '',
    body_html: row.body_html || null,
    vendor: row.vendor || null,
    tags: split(row.tags || ''),
    seo_title: row.seo_title || null,
    seo_description: row.seo_description || null,
    published: row.published === 'true' || row.published === '1',
    images: split(row.images || '').map((url) => ({ url })),
    categories: split(row.categories || '').map((name) => ({ name })),
    variant_default: {
      sku: row.sku || null,
      price: row.price ? Number(row.price) || 0 : 0,
      old_price: row.old_price ? Number(row.old_price) || 0 : 0,
      base_cost: row.base_cost ? Number(row.base_cost) || 0 : 0,
      inventory: row.inventory ? parseInt(row.inventory, 10) || 0 : 0,
    },
  }
  // options: 'Size:S,M,L;Color:Black,White'
  if (row.options) {
    const opts = row.options.split(';').map((part) => {
      const [name, valStr] = part.split(':')
      const values = (valStr ?? '').split(',').map((v) => v.trim()).filter(Boolean)
      return { name: (name ?? '').trim(), values: values.map((v) => ({ name: v })) }
    }).filter((o) => o.name && o.values.length > 0)
    if (opts.length > 0) payload.options = opts
  }
  // variants: JSON
  if (row.variants) {
    try {
      const parsed = JSON.parse(row.variants)
      if (Array.isArray(parsed)) payload.variants = parsed
    } catch { /* ignore — BE skip variants block nếu không match options */ }
  }
  return payload
}

/**
 * Commit từng row sequentially (BE Product POST có Task.Delay 1s — parallel
 * sẽ stress server và rate-limit). Match by `id` → update, else → create.
 */
async function commitPsvImport(
  ctx: ReturnType<typeof createApiContext>,
  rows: Array<Record<string, string>>,
): Promise<PsvImportResult> {
  const result: PsvImportResult = { total: rows.length, created: 0, updated: 0, failed: 0, items: [] }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const line = i + 2 // header = line 1
    const id = (row.id || '').trim()
    const name = row.name || row.slug || `(line ${line})`
    if (!row.name) {
      result.failed++
      result.items.push({ line, name, ok: false, action: 'create', error: 'Missing required field: name' })
      continue
    }
    try {
      const payload = buildPayloadFromPsvRow(row)
      if (id) {
        await updateProduct(ctx, id, payload)
        result.updated++
        result.items.push({ line, name, ok: true, action: 'update', id })
      } else {
        const created = await createProduct(ctx, payload)
        result.created++
        result.items.push({ line, name, ok: true, action: 'create', id: (created as any)?.id })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      result.failed++
      result.items.push({ line, name, ok: false, action: id ? 'update' : 'create', id, error: msg })
      console.error('[products/import] line=%d name=%s FAILED:', line, name, msg)
    }
  }
  return result
}

function renderPsvResult(base: string, fileName: string, r: PsvImportResult): string {
  const itemRows = r.items.map((it) => `
    <tr style="border-top:1px solid var(--s-border)">
      <td style="padding:6px 10px;font-variant-numeric:tabular-nums">${it.line}</td>
      <td style="padding:6px 10px"><code style="font-size:11px">${esc(it.name)}</code></td>
      <td style="padding:6px 10px;font-weight:600;text-transform:uppercase;font-size:11px;color:${it.ok ? 'var(--s-success)' : 'var(--s-danger,#d9534f)'}">${esc(it.action)}${it.ok ? ' OK' : ' FAIL'}</td>
      <td style="padding:6px 10px"><code style="font-size:11px">${esc(it.id ?? '—')}</code></td>
      <td style="padding:6px 10px;color:var(--s-danger,#d9534f);font-size:11px">${esc(it.error ?? '')}</td>
    </tr>
  `).join('')
  return `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <div>
        <h1 class="page-title" style="margin:0;font-size:22px;font-weight:700">Import result</h1>
        <p class="page-subtitle" style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">From <code>${esc(fileName)}</code></p>
      </div>
      <a href="${base}/products" class="btn btn-outline" style="font-size:13px">&larr; Back to products</a>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px">
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700">${r.total}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Total rows</div>
      </div>
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--s-success)">${r.created}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Created</div>
      </div>
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--s-accent)">${r.updated}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Updated</div>
      </div>
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--s-danger,#d9534f)">${r.failed}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Failed</div>
      </div>
    </div>

    <div class="card" style="padding:0;overflow:hidden">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="background:rgba(0,0,0,0.04)">
            <th style="text-align:left;padding:8px 10px">Line</th>
            <th style="text-align:left;padding:8px 10px">Name</th>
            <th style="text-align:left;padding:8px 10px">Action</th>
            <th style="text-align:left;padding:8px 10px">ID</th>
            <th style="text-align:left;padding:8px 10px">Error</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>
    </div>

    <div style="margin-top:16px">
      <a href="${base}/products/import" class="btn btn-outline" style="font-size:13px">Import another file</a>
    </div>
  `
}
