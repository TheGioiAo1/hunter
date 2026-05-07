/**
 * Store Admin — Order Export
 *
 * GET  /admin/store/:slug/orders/export          — Export settings page
 * POST /admin/store/:slug/orders/export/download  — Generate & download file
 *
 * Supports CSV (Shopify-compatible) and JSON formats. Merchants can
 * export current page, all matching filters, date range, or selected orders.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  generateOrdersExport,
  type FetchExportOrdersParams,
} from '../../../../packages/core/src/modules/orders/export/service.js'
import type { ExportOptions } from '../../../../packages/core/src/modules/orders/export/csv-exporter.js'
import { notify } from '../lib/notify.js'

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/orders/export — Export UI
// ---------------------------------------------------------------------------

export async function getOrderExport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken || ''

  // Get total count for display
  const countResult = await db.selectFrom('orders')
    .select(db.fn.count('id').as('count'))
    .where('shop_id', '=', store.id)
    .$call(q => (q as any).where((eb: any) =>
      eb.not(eb('tags', '@>', eb.val('{draft}')))
    ))
    .executeTakeFirst()
  const totalOrders = Number((countResult as any)?.count || 0)

  // Count by status for info
  const statusCounts = await db.selectFrom('orders')
    .select([
      'financial_status',
      'fulfillment_status',
      db.fn.count('id').as('count'),
    ])
    .where('shop_id', '=', store.id)
    .$call(q => (q as any).where((eb: any) =>
      eb.not(eb('tags', '@>', eb.val('{draft}')))
    ))
    .groupBy(['financial_status', 'fulfillment_status'])
    .execute()

  const unfulfilledCount = statusCounts
    .filter(s => !s.fulfillment_status || s.fulfillment_status === 'unfulfilled' || s.fulfillment_status === 'partial')
    .reduce((sum, s) => sum + Number(s.count), 0)
  const paidCount = statusCounts
    .filter(s => s.financial_status === 'paid')
    .reduce((sum, s) => sum + Number(s.count), 0)

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Export Orders</h1>
        <p class="page-subtitle">Download your orders as CSV or JSON</p>
      </div>
      <a href="${base}/orders" class="btn btn-outline" style="font-size:13px">&larr; Back to Orders</a>
    </div>

    <!-- Stats -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px">
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-accent)">${totalOrders}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Total Orders</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-warning)">${unfulfilledCount}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Unfulfilled</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-success)">${paidCount}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Paid</div>
      </div>
    </div>

    <form method="post" action="${base}/orders/export/download" id="exportForm">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <!-- LEFT: Export scope + format -->
        <div>
          <!-- What to export -->
          <div class="card">
            <div class="card-header"><span>What to export</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
                <input type="radio" name="scope" value="all" checked style="margin-top:2px;accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:600">All orders</div>
                  <div style="color:var(--s-text-muted);font-size:12px">${totalOrders} orders (excluding drafts)</div>
                </div>
              </label>
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
                <input type="radio" name="scope" value="date_range" style="margin-top:2px;accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:600">Date range</div>
                  <div style="color:var(--s-text-muted);font-size:12px">Export orders within a specific date range</div>
                </div>
              </label>
              <div id="dateRangeFields" style="display:none;margin-left:28px;display:flex;gap:12px">
                <div>
                  <label style="font-size:11px;color:var(--s-text-muted);display:block;margin-bottom:4px">From</label>
                  <input type="date" name="date_from" class="form-input" style="width:160px" />
                </div>
                <div>
                  <label style="font-size:11px;color:var(--s-text-muted);display:block;margin-bottom:4px">To</label>
                  <input type="date" name="date_to" class="form-input" style="width:160px" />
                </div>
              </div>
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
                <input type="radio" name="scope" value="unfulfilled" style="margin-top:2px;accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:600">Unfulfilled only</div>
                  <div style="color:var(--s-text-muted);font-size:12px">${unfulfilledCount} orders awaiting fulfillment</div>
                </div>
              </label>
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
                <input type="radio" name="scope" value="paid" style="margin-top:2px;accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:600">Paid only</div>
                  <div style="color:var(--s-text-muted);font-size:12px">${paidCount} paid orders</div>
                </div>
              </label>
            </div>
          </div>

          <!-- Format -->
          <div class="card" style="margin-top:20px">
            <div class="card-header"><span>Format</span></div>
            <div class="card-body" style="display:flex;gap:16px">
              <label style="flex:1;display:flex;align-items:center;gap:10px;cursor:pointer;padding:12px;border:2px solid var(--s-border);border-radius:8px;transition:border-color 0.2s" id="formatCsv">
                <input type="radio" name="format" value="csv" checked style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-size:14px;font-weight:600">CSV</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Shopify-compatible, Excel-ready</div>
                </div>
              </label>
              <label style="flex:1;display:flex;align-items:center;gap:10px;cursor:pointer;padding:12px;border:2px solid var(--s-border);border-radius:8px;transition:border-color 0.2s" id="formatJson">
                <input type="radio" name="format" value="json" style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-size:14px;font-weight:600">JSON</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Developer-friendly, full data</div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <!-- RIGHT: Include options -->
        <div>
          <div class="card">
            <div class="card-header"><span>Include in export</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="include_line_items" value="1" checked style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:500">Line items</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Product title, SKU, quantity, price, discount</div>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="include_customer" value="1" checked style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:500">Customer info</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Email, phone, customer ID</div>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="include_addresses" value="1" checked style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:500">Addresses</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Billing and shipping addresses</div>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="include_transactions" value="1" style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:500">Transactions</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Payment gateway, transaction ID, auth code</div>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="include_fulfillments" value="1" style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:500">Fulfillments</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Carrier, tracking number, shipped date</div>
                </div>
              </label>
            </div>
          </div>

          <!-- Export button -->
          <div class="card" style="margin-top:20px;padding:20px;text-align:center">
            <button type="submit" class="btn btn-primary" style="font-size:15px;padding:12px 32px;width:100%">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:8px"><path d="M10 3v10M6 9l4 4 4-4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
              Export Orders
            </button>
            <p style="font-size:11px;color:var(--s-text-muted);margin-top:8px">
              File will download immediately. Large exports (1000+) may take a few seconds.
            </p>
          </div>
        </div>
      </div>
    </form>

    <script>
    // Toggle date range fields visibility
    document.querySelectorAll('input[name="scope"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        var fields = document.getElementById('dateRangeFields');
        fields.style.display = this.value === 'date_range' ? 'flex' : 'none';
      });
    });
    // Highlight selected format
    document.querySelectorAll('input[name="format"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        document.getElementById('formatCsv').style.borderColor = 'var(--s-border)';
        document.getElementById('formatJson').style.borderColor = 'var(--s-border)';
        this.closest('label').style.borderColor = 'var(--s-accent)';
      });
    });
    // Initial state
    document.getElementById('formatCsv').style.borderColor = 'var(--s-accent)';
    document.getElementById('dateRangeFields').style.display = 'none';
    </script>
  `

  res.send(sellerLayout({
    title: 'Export Orders',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email, userRole: user.role, storeRole: user.storeRole,
    activePage: 'orders', content, theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /admin/store/:slug/orders/export/download — Generate & stream file
// ---------------------------------------------------------------------------

export async function postOrderExportDownload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const body = req.body || {}

  const format: 'csv' | 'json' = body.format === 'json' ? 'json' : 'csv'
  const scope = (body.scope || 'all') as FetchExportOrdersParams['scope']

  const includeLineItems = body.include_line_items === '1'
  const includeCustomer = body.include_customer === '1'
  const includeAddresses = body.include_addresses === '1'
  const includeTransactions = body.include_transactions === '1'
  const includeFulfillments = body.include_fulfillments === '1'

  const options: ExportOptions = {
    includeLineItems,
    includeCustomer,
    includeAddresses,
    includeTransactions,
    includeFulfillments,
  }

  try {
    // The core service now owns the fetch + format pipeline. Store-admin
    // just maps the form body to params and streams the result.
    const result = await generateOrdersExport(db, store.id, {
      scope,
      date_from: body.date_from || null,
      date_to: body.date_to || null,
      includeLineItems,
      includeTransactions,
      includeFulfillments,
      format,
      storeSlug: store.slug,
      options,
    })

    if (result.rowCount === 0) {
      const base = `/admin/store/${store.slug}`
      res.redirect(`${base}/orders/export?error=no_orders`)
      return
    }

    // Bell-icon notification — so the merchant can see in their activity
    // feed that an export happened (useful for auditing who downloaded
    // what, and as a "job completed" confirmation for long exports).
    // Wrapped in .catch() so a notifications-table failure can never
    // block the actual file download.
    const scopeLabel =
      scope === 'all' ? 'all orders' :
      scope === 'date_range' ? `${body.date_from || '?'} → ${body.date_to || '?'}` :
      scope === 'unfulfilled' ? 'unfulfilled orders' :
      scope === 'paid' ? 'paid orders' :
      String(scope)
    notify(db, {
      shopId: store.id,
      userId: user?.id ?? null,
      type: 'orders_exported',
      title: `Exported ${result.rowCount} order${result.rowCount === 1 ? '' : 's'} (${format.toUpperCase()})`,
      message: `Scope: ${scopeLabel}${user ? ` • By ${user.name || user.email}` : ''}`,
      resourceType: 'order_export',
      resourceId: null,
    })

    res.setHeader('Content-Type', result.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
    res.send(result.data)
  } catch (err: any) {
    console.error('[Order Export Error]', err)
    const base = `/admin/store/${store.slug}`
    res.redirect(`${base}/orders/export?error=${encodeURIComponent(err.message)}`)
  }
}
