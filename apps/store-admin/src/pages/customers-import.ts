/**
 * Store Admin — Customer Import (upload → dry-run preview → commit)
 *
 * GET  /admin/store/:slug/customers/import           — upload form
 * POST /admin/store/:slug/customers/import/upload    — parse + plan + preview
 * POST /admin/store/:slug/customers/import/commit    — apply the plan
 *
 * Mirror of products-import.ts (PR 2 PR3) with a second step wired
 * in. Parse/validate/plan live in
 * `packages/core/src/modules/customers/csv/*` and are shared by the
 * REST API (pending). The seller never hits the DB until they click
 * "Commit import" on the preview page.
 *
 * Two-step state is held in an in-memory session map, same pattern as
 * orders-import.ts — cleared after 30 minutes or on successful commit.
 * Not suitable for horizontally-scaled dashboards; we'll swap to Redis
 * when/if store-admin ever runs multi-process.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  parseCustomersCsv,
  buildImportPlan,
  applyImportPlan,
  ParseError,
  type ImportPlan,
  type ValidationIssue,
} from '@gbox/core/modules/customers/csv/index.js'
import { notify } from '../lib/notify.js'

// ---------------------------------------------------------------------------
// In-memory preview session store
// ---------------------------------------------------------------------------

interface ImportSession {
  plan: ImportPlan
  fileName: string
  timestamp: number
}

const importSessions = new Map<string, ImportSession>()

// Cleanup entries older than 30 min so we don't leak RAM on a long-
// running dashboard. 5-min sweep is enough — the cost of holding a
// plan for a few extra minutes is tiny.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const [key, val] of importSessions) {
    if (val.timestamp < cutoff) importSessions.delete(key)
  }
}, 5 * 60 * 1000).unref?.()

// ---------------------------------------------------------------------------
// GET — upload form
// ---------------------------------------------------------------------------

export async function getCustomerImport(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'

  const errorParam = typeof req.query.error === 'string' ? req.query.error : ''
  const successParam = typeof req.query.success === 'string' ? req.query.success : ''

  const content = renderUploadPage({ base, error: errorParam, success: successParam, plan: null })

  res.send(sellerLayout({
    title: 'Import customers',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'customers',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST — parse + build dry-run plan + render preview
// ---------------------------------------------------------------------------

export async function postCustomerImportUpload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'

  const file = (req as any).file as
    | { buffer: Buffer; originalname: string; mimetype: string }
    | undefined
  if (!file || !file.buffer || file.buffer.length === 0) {
    res.redirect(`${base}/customers/import?error=no_file`)
    return
  }

  const name = file.originalname ?? 'upload.csv'
  const looksLikeCsv =
    /\.csv$/i.test(name) ||
    /text\/csv|text\/plain|application\/vnd\.ms-excel/i.test(file.mimetype ?? '')

  let plan: ImportPlan | null = null
  let parseError: string | null = null
  let sessionKey: string | null = null
  let parseNotes: Array<{ line: number; message: string }> = []

  try {
    const text = file.buffer.toString('utf8')
    const parsed = parseCustomersCsv(text)
    parseNotes = parsed.notes
    plan = await buildImportPlan(db, store.id, parsed.customers)

    // Store plan for commit step.
    sessionKey = `${store.id}:${user.id}:${Date.now()}`
    importSessions.set(sessionKey, {
      plan,
      fileName: name,
      timestamp: Date.now(),
    })
  } catch (err: any) {
    if (err instanceof ParseError) {
      parseError = `Line ${err.line}${err.column != null ? `, col ${err.column}` : ''}: ${err.message}`
    } else {
      console.error('[Customer Import Error]', err)
      parseError = err?.message ?? 'Failed to parse CSV'
    }
  }

  // Fire a preview-stage bell notification. Same rationale as
  // orders-import: failures should still surface in the bell even if
  // the seller never reaches the commit step.
  try {
    if (plan && !parseError) {
      const parts = [
        `${plan.stats.creating} create`,
        `${plan.stats.updating} update`,
      ]
      if (plan.stats.blocked > 0) parts.push(`${plan.stats.blocked} blocked`)
      if (plan.stats.warnings > 0) parts.push(`${plan.stats.warnings} warning${plan.stats.warnings === 1 ? '' : 's'}`)
      await notify(db, {
        shopId: store.id,
        userId: user.id,
        type: 'customers_import_previewed',
        title: `Import preview: ${parts.join(', ')}`,
        message: `File: ${name} • By ${user.name || user.email}`,
        resourceType: 'customer_import',
        resourceId: null,
      })
    } else if (parseError) {
      await notify(db, {
        shopId: store.id,
        userId: user.id,
        type: 'customers_import_failed',
        title: 'Customer import failed: parse error',
        message: `${parseError} • By ${user.name || user.email}`,
        resourceType: 'customer_import',
        resourceId: null,
      })
    }
  } catch {
    // Best-effort only — never block the UI on a notification failure.
  }

  const content = renderUploadPage({
    base,
    error: parseError,
    success: '',
    plan,
    fileName: name,
    looksLikeCsv,
    parseNotes,
    sessionKey,
  })

  res.send(sellerLayout({
    title: 'Import preview',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'customers',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST — commit the dry-run plan
// ---------------------------------------------------------------------------

export async function postCustomerImportCommit(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const sessionKey = typeof req.body?.session_key === 'string' ? req.body.session_key : ''

  const session = importSessions.get(sessionKey)
  if (!session) {
    res.redirect(`${base}/customers/import?error=${encodeURIComponent('Import session expired. Please upload again.')}`)
    return
  }

  try {
    const result = await applyImportPlan(db, store.id, session.plan)
    importSessions.delete(sessionKey)

    const successMsg = `Imported ${result.stats.created} created, ${result.stats.updated} updated, ${result.stats.skipped} skipped${result.stats.errored > 0 ? `, ${result.stats.errored} errored` : ''}`

    // Bell notification for the commit step.
    try {
      await notify(db, {
        shopId: store.id,
        userId: user.id,
        type: 'customers_imported',
        title: successMsg,
        message: `File: ${session.fileName} • By ${user.name || user.email}`,
        resourceType: 'customer_import',
        resourceId: null,
      })
    } catch {
      // Best-effort only.
    }

    res.redirect(`${base}/customers/import?success=${encodeURIComponent(successMsg)}`)
  } catch (err: any) {
    console.error('[Customer Import Commit Error]', err)
    try {
      await notify(db, {
        shopId: store.id,
        userId: user.id,
        type: 'customers_import_failed',
        title: 'Customer import failed during commit',
        message: `${err?.message ?? 'unknown error'} • By ${user.name || user.email}`,
        resourceType: 'customer_import',
        resourceId: null,
      })
    } catch {
      // Swallow — the redirect carries the actual user-facing error.
    }
    res.redirect(`${base}/customers/import?error=${encodeURIComponent('Import failed: ' + (err?.message ?? 'unknown error'))}`)
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface RenderOptions {
  base: string
  error: string | null
  success: string | null
  plan: ImportPlan | null
  fileName?: string
  looksLikeCsv?: boolean
  parseNotes?: Array<{ line: number; message: string }>
  sessionKey?: string | null
}

function renderUploadPage(opts: RenderOptions): string {
  const { base, error, success, plan, fileName, looksLikeCsv, parseNotes, sessionKey } = opts
  const hasPreview = plan !== null

  const errorBanner = error
    ? `<div class="card" style="background:#fff4f4;border:1px solid #f8d5d5;color:#a61b1b;padding:12px 16px;margin-bottom:16px;font-size:13px">
         <strong>Could not parse:</strong> ${esc(decodeErrorMessage(error))}
       </div>`
    : ''

  const successBanner = success
    ? `<div class="card" style="background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;padding:12px 16px;margin-bottom:16px;font-size:13px">
         <strong>Import complete:</strong> ${esc(safeDecode(success))}
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
    <form method="post" action="${base}/customers/import/upload" enctype="multipart/form-data">
      <div class="card">
        <div class="card-header"><span>Upload CSV</span></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <p style="margin:0;color:var(--s-text-secondary);font-size:13px">
            Upload a Shopify-compatible customers CSV. You'll see a full dry-run preview before anything is written.
            Email is the upsert key — rows with a matching email update the existing customer; new emails create new ones.
          </p>
          <input type="file" name="csv" accept=".csv,text/csv,text/plain" required
                 class="form-input" style="padding:8px" />
          <div style="color:var(--s-text-muted);font-size:11px">
            Max 20 MB. First row must be the header. Use the
            <a href="${base}/customers/export" style="color:var(--s-accent)">Export tool</a>
            to download a ready-made template.
          </div>
          <div>
            <button type="submit" class="btn btn-primary">Preview import</button>
          </div>
        </div>
      </div>
    </form>
  `

  const planSummary = hasPreview ? renderPlanSummary(plan!) : ''
  const planBody = hasPreview ? renderPlanDetails(plan!) : ''
  const commitForm = hasPreview && sessionKey ? renderCommitForm(base, plan!, sessionKey) : ''

  return `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <div>
        <h1 class="page-title" style="margin:0;font-size:22px;font-weight:700">Import customers</h1>
        <p class="page-subtitle" style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">
          Upload a CSV to preview changes. Nothing is saved until you click Commit.
        </p>
      </div>
      <a href="${base}/customers" class="btn btn-outline" style="font-size:13px">&larr; Back to customers</a>
    </div>

    ${errorBanner}
    ${successBanner}
    ${mimeWarning}
    ${notesSection}
    ${uploadForm}
    ${planSummary}
    ${planBody}
    ${commitForm}
  `
}

function renderPlanSummary(plan: ImportPlan): string {
  const cards: Array<{ label: string; value: number; color?: string }> = [
    { label: 'Creating', value: plan.stats.creating, color: 'var(--s-success)' },
    { label: 'Updating', value: plan.stats.updating, color: 'var(--s-accent)' },
    { label: 'Blocked', value: plan.stats.blocked, color: 'var(--s-danger, #d9534f)' },
    { label: 'Warnings', value: plan.stats.warnings, color: 'var(--s-warning)' },
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
              <th style="text-align:left;padding:8px 12px">Email</th>
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
                <td style="padding:8px 12px"><code style="font-size:11px">${esc(i.email ?? '')}</code></td>
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
      No customer rows parsed from the upload.
    </div>`
  }

  // Show at most 100 rows to keep the page snappy on huge CSVs.
  const preview = plan.items.slice(0, 100)
  const truncated = plan.items.length - preview.length

  return `
    <div style="margin-top:20px">
      <h3 style="margin:0 0 8px;font-size:14px;font-weight:600">Per-row plan</h3>
      <div class="card" style="padding:0;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:var(--s-muted-bg, rgba(0,0,0,0.04))">
              <th style="text-align:left;padding:8px 12px">Row</th>
              <th style="text-align:left;padding:8px 12px">Email</th>
              <th style="text-align:left;padding:8px 12px">Name</th>
              <th style="text-align:left;padding:8px 12px">Action</th>
              <th style="text-align:left;padding:8px 12px">Existing ID</th>
            </tr>
          </thead>
          <tbody>
            ${preview
              .map((it) => {
                const actionColor =
                  it.action === 'create'
                    ? 'var(--s-success)'
                    : it.action === 'update'
                      ? 'var(--s-accent)'
                      : 'var(--s-danger, #d9534f)'
                const fullName = [it.parsed.first_name, it.parsed.last_name]
                  .filter(Boolean)
                  .join(' ')
                return `
                  <tr style="border-top:1px solid var(--s-border)">
                    <td style="padding:8px 12px;font-variant-numeric:tabular-nums">${it.parsed.sourceRow}</td>
                    <td style="padding:8px 12px"><code style="font-size:11px">${esc(it.parsed.email ?? '')}</code></td>
                    <td style="padding:8px 12px">${esc(fullName)}</td>
                    <td style="padding:8px 12px;color:${actionColor};font-weight:600;text-transform:uppercase;font-size:11px">${esc(it.action)}</td>
                    <td style="padding:8px 12px;color:var(--s-text-muted);font-size:11px">${esc(it.existingCustomerId ?? '\u2014')}</td>
                  </tr>`
              })
              .join('')}
          </tbody>
        </table>
        ${truncated > 0
          ? `<div style="padding:8px 12px;font-size:11px;color:var(--s-text-muted);border-top:1px solid var(--s-border)">
               \u2026 ${truncated} more row${truncated === 1 ? '' : 's'} not shown here. All will be committed.
             </div>`
          : ''}
      </div>
    </div>
  `
}

function renderCommitForm(base: string, plan: ImportPlan, sessionKey: string): string {
  const writable = plan.stats.creating + plan.stats.updating
  if (writable === 0) {
    return `
      <div class="card" style="margin-top:24px;padding:14px;font-size:13px;color:var(--s-text-muted)">
        Nothing to commit — every row is blocked. Fix the errors above and re-upload.
      </div>
    `
  }
  return `
    <form method="post" action="${base}/customers/import/commit" style="margin-top:24px">
      <input type="hidden" name="session_key" value="${esc(sessionKey)}" />
      <div class="card">
        <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px">
          <div style="font-size:14px">
            <strong>${writable}</strong> row${writable === 1 ? '' : 's'} will be written
            (${plan.stats.creating} new, ${plan.stats.updating} updated)
            ${plan.stats.blocked > 0 ? `<span style="color:var(--s-danger,#d9534f)"> \u2014 ${plan.stats.blocked} blocked row${plan.stats.blocked === 1 ? '' : 's'} will be skipped</span>` : ''}
          </div>
          <button type="submit" class="btn btn-primary" style="font-size:14px;padding:10px 24px"
                  onclick="return confirm('Commit ${writable} customer change${writable === 1 ? '' : 's'} now?')">
            Commit import
          </button>
        </div>
      </div>
    </form>
  `
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeErrorMessage(raw: string): string {
  if (raw === 'no_file') return 'Please choose a CSV file to upload.'
  return safeDecode(raw)
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// Exposed for tests — lets the suite clear session state between runs
// instead of importing a private map.
export function __resetImportSessionsForTests(): void {
  importSessions.clear()
}
