/**
 * Store Admin — Customer Export
 *
 * GET  /admin/store/:slug/customers/export           — Export settings UI
 * POST /admin/store/:slug/customers/export/download  — Stream CSV to browser
 *
 * Ships a Shopify-compatible customers CSV so a seller can move their
 * contact list to/from any other platform without losing structure.
 * Rides on the shared `exportCustomersCsvStream` in
 * `packages/core/src/modules/customers/csv/export.ts` so the parser
 * and exporter agree on header order, BOM handling, and tag/boolean
 * encoding byte-for-byte.
 *
 * The download is intentionally streamed: a shop with tens of
 * thousands of customers doesn't need the whole file in RAM before
 * the first byte leaves the server.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  exportCustomersCsvStream,
  type ExportCustomer,
  type ExportCustomerAddress,
} from '@gbox/core/modules/customers/csv/export.js'
import { notify } from '../lib/notify.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExportScope =
  | 'all'
  | 'marketing'
  | 'lifecycle_new'
  | 'lifecycle_returning'
  | 'lifecycle_at_risk'
  | 'lifecycle_churned'

const VALID_SCOPES: ExportScope[] = [
  'all',
  'marketing',
  'lifecycle_new',
  'lifecycle_returning',
  'lifecycle_at_risk',
  'lifecycle_churned',
]

// ---------------------------------------------------------------------------
// GET — Export settings UI
// ---------------------------------------------------------------------------

export async function getCustomerExport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken || ''

  // Counts are cheap — one aggregate row per scope. Even at 100k
  // customers this stays well under 50ms.
  const [total, marketing, lcNew, lcReturning, lcAtRisk, lcChurned] = await Promise.all([
    countCustomers(db, store.id, null),
    countCustomers(db, store.id, { accepts_marketing: true }),
    countCustomers(db, store.id, { lifecycle_stage: 'new' }),
    countCustomers(db, store.id, { lifecycle_stage: 'returning' }),
    countCustomers(db, store.id, { lifecycle_stage: 'at_risk' }),
    countCustomers(db, store.id, { lifecycle_stage: 'churned' }),
  ])

  const errorParam = typeof req.query.error === 'string' ? req.query.error : ''

  const content = `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <div>
        <h1 class="page-title" style="margin:0;font-size:22px;font-weight:700">Export customers</h1>
        <p class="page-subtitle" style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Download your customer list as a Shopify-compatible CSV.</p>
      </div>
      <a href="${base}/customers" class="btn btn-outline" style="font-size:13px">&larr; Back to customers</a>
    </div>

    ${errorParam ? `<div class="card" style="background:#fff4f4;border:1px solid #f8d5d5;color:#a61b1b;padding:12px 16px;margin-bottom:16px;font-size:13px">
      ${esc(decodeErrorMessage(errorParam))}
    </div>` : ''}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--s-accent)">${total}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Total</div>
      </div>
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--s-success)">${marketing}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Marketing opted-in</div>
      </div>
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700">${lcNew}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">New</div>
      </div>
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--s-success)">${lcReturning}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Returning</div>
      </div>
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--s-warning)">${lcAtRisk}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">At risk</div>
      </div>
      <div class="card" style="padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:var(--s-danger,#d9534f)">${lcChurned}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Churned</div>
      </div>
    </div>

    <form method="post" action="${base}/customers/export/download" id="cxForm">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />

      <div class="card">
        <div class="card-header"><span>What to export</span></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
          ${scopeRadio('all', 'All customers', `${total} customers`, true)}
          ${scopeRadio('marketing', 'Marketing opted-in only', `${marketing} customers accepting email marketing`)}
          ${scopeRadio('lifecycle_new', 'Lifecycle: New', `${lcNew} first-time buyers`)}
          ${scopeRadio('lifecycle_returning', 'Lifecycle: Returning', `${lcReturning} returning customers`)}
          ${scopeRadio('lifecycle_at_risk', 'Lifecycle: At risk', `${lcAtRisk} customers who haven't ordered recently`)}
          ${scopeRadio('lifecycle_churned', 'Lifecycle: Churned', `${lcChurned} lapsed customers`)}
        </div>
      </div>

      <div class="card" style="margin-top:20px;padding:20px;text-align:center">
        <button type="submit" class="btn btn-primary" style="font-size:15px;padding:12px 32px">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:8px"><path d="M10 3v10M6 9l4 4 4-4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
          Export customers (CSV)
        </button>
        <p style="font-size:11px;color:var(--s-text-muted);margin-top:8px">
          File downloads immediately. The CSV is Shopify-compatible — you can re-import it here or on any Shopify-clone platform.
        </p>
      </div>
    </form>
  `

  res.send(sellerLayout({
    title: 'Export customers',
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

function scopeRadio(value: string, title: string, subtitle: string, checked = false): string {
  return `
    <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
      <input type="radio" name="scope" value="${esc(value)}" ${checked ? 'checked' : ''} style="margin-top:2px;accent-color:var(--s-accent)" />
      <div>
        <div style="font-weight:600">${esc(title)}</div>
        <div style="color:var(--s-text-muted);font-size:12px">${esc(subtitle)}</div>
      </div>
    </label>
  `
}

// ---------------------------------------------------------------------------
// POST — Stream CSV download
// ---------------------------------------------------------------------------

export async function postCustomerExportDownload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const body = (req.body || {}) as Record<string, string | string[] | undefined>
  const base = `/admin/store/${store.slug}`

  const scope = normalizeScope(body.scope)

  try {
    // Fetch matching customers — single SELECT. Even at 10k rows this
    // is fast enough to stream without paging because we only need a
    // handful of scalar columns + 12 address cells. If a shop has
    // 100k+ customers we'd swap to a cursor; not worth the complexity
    // yet.
    const customers = await fetchCustomersForScope(db, store.id, scope)

    if (customers.length === 0) {
      res.redirect(`${base}/customers/export?error=no_customers`)
      return
    }

    const filename = `customers-${store.slug}-${new Date().toISOString().slice(0, 10)}.csv`

    // Set headers before the first write — once we start streaming we
    // can't change them.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    // The CSV may be large; tell proxies not to buffer.
    res.setHeader('X-Accel-Buffering', 'no')

    for await (const line of exportCustomersCsvStream(customers)) {
      res.write(line)
    }
    res.end()

    // Fire-and-forget activity feed. Wrapped so notifier failures
    // don't break the (already-streamed) download.
    try {
      await notify(db, {
        shopId: store.id,
        userId: user?.id ?? null,
        type: 'customers_exported',
        title: `Exported ${customers.length} customer${customers.length === 1 ? '' : 's'}`,
        message: `Scope: ${scopeLabel(scope)}${user ? ` • By ${user.name || user.email}` : ''}`,
        resourceType: 'customer_export',
        resourceId: null,
      })
    } catch {
      // Best-effort only.
    }
  } catch (err: any) {
    console.error('[Customer Export Error]', err)
    // If we already started writing headers/body we can't redirect;
    // fall through so the browser shows a truncated download instead
    // of a 500 page.
    if (!res.headersSent) {
      res.redirect(`${base}/customers/export?error=${encodeURIComponent(err.message ?? 'export_failed')}`)
    } else {
      try { res.end() } catch { /* already closed */ }
    }
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function countCustomers(
  db: Kysely<Database>,
  shopId: string,
  filter: { accepts_marketing?: boolean; lifecycle_stage?: string } | null,
): Promise<number> {
  let q = db
    .selectFrom('customers')
    .select(({ fn }) => fn.count<number>('id').as('c'))
    .where('shop_id', '=', shopId)

  if (filter?.accepts_marketing !== undefined) {
    q = q.where('accepts_marketing', '=', filter.accepts_marketing)
  }
  if (filter?.lifecycle_stage !== undefined) {
    q = q.where('lifecycle_stage', '=', filter.lifecycle_stage)
  }

  const row = await q.executeTakeFirst().catch(() => null)
  return row ? Number((row as any).c) || 0 : 0
}

/**
 * Fetch customers for a scope plus their default address, folded into
 * the `ExportCustomer` shape the pure exporter accepts. One SELECT
 * for customers + one SELECT for addresses, joined in memory.
 */
async function fetchCustomersForScope(
  db: Kysely<Database>,
  shopId: string,
  scope: ExportScope,
): Promise<ExportCustomer[]> {
  let custQ = db
    .selectFrom('customers')
    .select([
      'id',
      'first_name',
      'last_name',
      'email',
      'phone',
      'accepts_marketing',
      'note',
      'tags',
      'tax_exempt',
      'total_spent',
      'orders_count',
      'lifecycle_stage',
    ])
    .where('shop_id', '=', shopId)
    .orderBy('created_at', 'asc')

  if (scope === 'marketing') {
    custQ = custQ.where('accepts_marketing', '=', true)
  } else if (scope.startsWith('lifecycle_')) {
    custQ = custQ.where('lifecycle_stage', '=', scope.slice('lifecycle_'.length))
  }

  const rows = await custQ.execute()
  if (rows.length === 0) return []

  const customerIds = rows.map((r) => r.id as string)

  // Pull default addresses — prefer is_default=true, else oldest.
  // One row per customer by keeping the first encountered in the
  // ordered result.
  const addrRows = await db
    .selectFrom('customer_addresses')
    .select([
      'customer_id',
      'first_name',
      'last_name',
      'company',
      'address1',
      'address2',
      'city',
      'province',
      'province_code',
      'country',
      'country_code',
      'zip',
      'phone',
      'is_default',
      'created_at',
    ])
    .where('customer_id', 'in', customerIds)
    .orderBy('customer_id', 'asc')
    .orderBy('is_default', 'desc')
    .orderBy('created_at', 'asc')
    .execute()

  const addrByCustomer = new Map<string, ExportCustomerAddress>()
  for (const a of addrRows) {
    if (addrByCustomer.has(a.customer_id)) continue
    addrByCustomer.set(a.customer_id, {
      first_name: a.first_name,
      last_name: a.last_name,
      company: a.company,
      address1: a.address1,
      address2: a.address2,
      city: a.city,
      province: a.province,
      province_code: a.province_code,
      country: a.country,
      country_code: a.country_code,
      zip: a.zip,
      phone: a.phone,
    })
  }

  return rows.map((r) => ({
    id: r.id as string,
    first_name: r.first_name,
    last_name: r.last_name,
    email: r.email,
    phone: r.phone,
    accepts_marketing: Boolean(r.accepts_marketing),
    note: r.note,
    tags: (r.tags as string[] | null) ?? null,
    tax_exempt: Boolean(r.tax_exempt),
    total_spent: (r.total_spent as string | null) ?? null,
    orders_count: r.orders_count != null ? Number(r.orders_count) : null,
    lifecycle_stage: (r.lifecycle_stage as string | null) ?? null,
    default_address: addrByCustomer.get(r.id as string) ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeScope(raw: unknown): ExportScope {
  if (typeof raw === 'string' && (VALID_SCOPES as string[]).includes(raw)) {
    return raw as ExportScope
  }
  return 'all'
}

function scopeLabel(scope: ExportScope): string {
  switch (scope) {
    case 'all': return 'all customers'
    case 'marketing': return 'marketing opted-in'
    case 'lifecycle_new': return 'lifecycle: new'
    case 'lifecycle_returning': return 'lifecycle: returning'
    case 'lifecycle_at_risk': return 'lifecycle: at risk'
    case 'lifecycle_churned': return 'lifecycle: churned'
  }
}

function decodeErrorMessage(raw: string): string {
  const decoded = safeDecode(raw)
  if (decoded === 'no_customers') return 'No customers matched your scope. Try a different selection.'
  if (decoded === 'export_failed') return 'Export failed. Please try again.'
  return `Export failed: ${decoded}`
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
