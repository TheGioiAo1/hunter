/**
 * Store Admin — Draft Order Create (API mode)
 *
 * Renders Shopify-style draft order page when local DB is unavailable.
 * Layout:
 *  - Left main: Products (search + line items table) / Payment (subtotal, tax,
 *    total, payment terms) / Timeline (comment input + events)
 *  - Right side: Notes / Customer card (contact, addresses) / Markets +
 *    Currency / Tags
 *
 * Submit posts to POST /admin/store/:slug/orders/drafts → server handler
 * (postDraftOrderCreate) routes to BE Order-Service POST /api/{shop_id}/insert-temp.
 *
 * Screenshot reference: shows draft #D1 with one line item (tets, đ100,000 × 1).
 *
 * Visual-only sections (BE wiring TBD):
 *  - Browse product picker modal
 *  - Tax % picker (currently fixed 10% VAT label)
 *  - Send invoice / payment reminders
 *  - Markets selector
 *  - Timeline events (only render the "you created this draft" line on detail)
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { createApiContext, getCustomerByIdOrEmail } from '../lib/customer-api-client.js'
import { createApiContext as createProductApiCtx, listProducts } from '../lib/product-api-client.js'
import type { ApiCustomer } from '../lib/customer-api-types.js'
import { listSubfees, TAX_NAME_PREFIX } from '../lib/subfee-api-client.js'
import { listShippings } from '../lib/shipping-api-client.js'
import { COUNTRY_NAME } from '../lib/country-data.js'

interface CountryRates {
  tax_rate: number     // sum of % across matching tax subfees
  tax_label: string    // e.g. "Vietnam VAT 50%"
  ship_name: string    // "<zone> / <method>"
  ship_price: number
}

/**
 * Pre-fetch tax subfees + shipping zones for the current shop and build a
 * country-keyed rates map. Used by the draft-order page to auto-apply
 * tax + shipping when the merchant picks a customer (mirrors the order
 * detail flow but client-side, no page reload).
 */
async function buildCountryRatesMap(req: Request): Promise<Record<string, CountryRates>> {
  const out: Record<string, CountryRates> = {}
  try {
    const ctx = createApiContext(req)
    const [subfeeRes, zones] = await Promise.all([
      listSubfees(ctx, { limit: 200 }).catch(() => ({ data: [] as any[] })),
      listShippings(ctx, {}).catch(() => [] as any[]),
    ])
    const taxList = (subfeeRes as any).data || []
    for (const sf of taxList) {
      if (!sf?.name || !String(sf.name).startsWith(TAX_NAME_PREFIX)) continue
      if (!Array.isArray(sf.country_codes)) continue
      const rate = Number(sf.first_item_price ?? sf.price ?? 0)
      if (rate <= 0) continue
      const region = String(sf.name).slice(TAX_NAME_PREFIX.length).trim() || ''
      for (const cc of sf.country_codes) {
        const code = String(cc).toUpperCase()
        if (!out[code]) out[code] = { tax_rate: 0, tax_label: '', ship_name: '', ship_price: 0 }
        out[code].tax_rate += rate
        out[code].tax_label = (region ? region + ' VAT ' : 'VAT ') + out[code].tax_rate + '%'
      }
    }
    for (const z of zones) {
      if (!Array.isArray(z?.shipping_methods) || z.shipping_methods.length === 0) continue
      if (!Array.isArray(z?.country_codes) || z.country_codes.length === 0) continue
      const m = z.shipping_methods.find((mm: any) => Number(mm.price ?? mm.first_item_price ?? 0) > 0) || z.shipping_methods[0]
      const price = Number(m?.price ?? m?.first_item_price ?? 0)
      const name = [z.name, m?.name].filter(Boolean).join(' / ') || 'Shipping'
      for (const cc of z.country_codes) {
        const code = String(cc).toUpperCase()
        if (!out[code]) out[code] = { tax_rate: 0, tax_label: '', ship_name: '', ship_price: 0 }
        if (!out[code].ship_name) {
          out[code].ship_name = name
          out[code].ship_price = price
        }
      }
    }
  } catch (e: any) {
    console.warn('[draft-new-rates] build map failed:', e?.message)
  }
  return out
}

/**
 * JSON proxy: GET /admin/store/:slug/orders/drafts/api/products?q=...
 * Used by the draft-order page client to autocomplete the product search box.
 * Calls BE Gbox-Product-Service GET /api/{shop_id} with keyword filter.
 */
export async function getDraftProductsSearch(req: Request, res: Response): Promise<void> {
  const q = (typeof req.query.q === 'string' ? req.query.q : '').trim()
  const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? '8')) || 8))
  try {
    const ctx = createProductApiCtx(req)
    const r = await listProducts(ctx, { keyword: q || undefined, limit, page: 1 })
    const items = (r.data ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      price: Number(p.variant_default?.price ?? 0),
      sku: p.variant_default?.sku ?? '',
      image: p.images?.[0]?.url || p.variant_default?.image_url || null,
    }))
    res.json({ data: items })
  } catch (err: any) {
    console.error('[draft-products-search] failed:', err?.message || err)
    res.status(500).json({ error: err?.message || 'search failed', data: [] })
  }
}

/**
 * JSON proxy: GET /admin/store/:slug/orders/drafts/api/customers?q=...
 * Used by draft-order page Customer card autocomplete.
 * Calls BE Gbox-Customer-Service GET /api/{shop_id} with keyword filter.
 */
export async function getDraftCustomersSearch(req: Request, res: Response): Promise<void> {
  const q = (typeof req.query.q === 'string' ? req.query.q : '').trim()
  const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? '8')) || 8))
  try {
    const ctx = createApiContext(req)
    const { listCustomers } = await import('../lib/customer-api-client.js')
    const r = await listCustomers(ctx, { keyword: q || undefined, limit, page: 1 })
    const items = (r.data ?? []).map((c: any) => ({
      id: c.id,
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      full_name: c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '(no name)',
      email: c.email || null,
      phone: c.phone || null,
      address_1: c.address_1 || null,
      address_2: c.address_2 || null,
      city: c.city || null,
      province: c.province || null,
      zip: c.zip || null,
      country_name: c.country_name || null,
    }))
    res.json({ data: items })
  } catch (err: any) {
    console.error('[draft-customers-search] failed:', err?.message || err)
    res.status(500).json({ error: err?.message || 'search failed', data: [] })
  }
}

export async function renderDraftOrderNewApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).send('Store context missing'); return }
  const user = req.storeUser ?? { name: '', email: '', role: '', storeRole: '' } as any
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`

  const customerId = typeof req.query.customer_id === 'string' ? req.query.customer_id : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''

  // Pre-fill customer if provided in query
  let customer: ApiCustomer | null = null
  if (customerId) {
    try {
      const ctx = createApiContext(req)
      customer = await getCustomerByIdOrEmail(ctx, customerId)
    } catch (err: any) {
      console.warn('[draft-new-api] customer prefetch failed:', err?.message)
    }
  }

  const csrf = String((req as any).csrfToken || '')
  const userInitials = ((user.name || user.email || 'U').slice(0, 2) || 'U').toUpperCase()

  // Pre-fetch country rates (tax + shipping) so the JS can auto-apply when
  // a customer is picked. Mirrors the server-side compute used by /orders/<id>.
  const ratesByCountry = await buildCountryRatesMap(req)
  const nameToCode: Record<string, string> = {}
  for (const [code, name] of Object.entries(COUNTRY_NAME)) {
    nameToCode[name.toLowerCase()] = code
  }

  const content = renderForm({
    base, csrf, customer, customerId, errorMsg, userInitials,
    storeName: store.name,
    ratesByCountry, nameToCode,
  })

  res.send(sellerLayout({
    title: 'Create draft order',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'orders',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ─────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────

interface RenderOpts {
  base: string
  csrf: string
  customer: ApiCustomer | null
  customerId: string
  errorMsg: string
  userInitials: string
  storeName: string
  ratesByCountry: Record<string, CountryRates>
  nameToCode: Record<string, string>
}

function renderForm(o: RenderOpts): string {
  const { base, csrf, customer, customerId, errorMsg, userInitials, storeName, ratesByCountry, nameToCode } = o
  // Draft display number (placeholder #D1 — BE assigns real number on save)
  const draftLabel = '#D1'
  const errorBanner = errorMsg
    ? `<div class="dn-banner dn-banner-error">${esc(decodeURIComponent(errorMsg))}</div>`
    : ''

  return `
${DRAFT_NEW_STYLE}
<div class="dn">
  <div class="dn-topbar">
    <span class="dn-check">✓</span>
    <h1>${draftLabel}</h1>
    <div class="dn-topbar-actions">
      <button type="button" class="dn-btn-light" disabled>Duplicate</button>
      <button type="button" class="dn-btn-light" disabled>Share</button>
      <button type="button" class="dn-more">More actions <span class="dn-chev">▾</span></button>
      <button type="button" class="dn-nav-btn" title="Previous">‹</button>
      <button type="button" class="dn-nav-btn" title="Next">›</button>
    </div>
  </div>
  <p class="dn-meta">Draft — not yet saved</p>
  ${errorBanner}

  <form method="POST" action="${base}/orders/drafts" id="dn-form">
    <input type="hidden" name="_csrf" value="${csrf}"/>
    ${customerId ? `<input type="hidden" name="customer_id" value="${esc(customerId)}"/>` : ''}
    ${customer?.email ? `<input type="hidden" name="email" value="${esc(customer.email)}"/>` : ''}

    <div class="dn-grid">
      <!-- ─────── LEFT MAIN ─────── -->
      <div class="dn-main">

        <!-- Products card -->
        <section class="dn-card">
          <div class="dn-card-head">
            <h3 class="dn-section">Products</h3>
            <button type="button" class="dn-icon-btn" title="More">⋯</button>
          </div>
          <div class="dn-prod-search-wrap">
            <div class="dn-prod-search">
              <span class="dn-search-icon">🔍</span>
              <input type="text" placeholder="Search products" class="dn-input dn-input-search" id="dn-prod-search" autocomplete="off"/>
              <button type="button" class="dn-btn-light dn-btn-inline" id="dn-browse">Browse</button>
              <button type="button" class="dn-btn-light dn-btn-inline" id="dn-add-custom">Add custom item</button>
            </div>
            <div class="dn-prod-results" id="dn-prod-results" hidden></div>
          </div>
          <div class="dn-table-wrap">
            <table class="dn-table">
              <colgroup>
                <col />
                <col style="width:110px" />
                <col style="width:130px" />
                <col style="width:40px" />
              </colgroup>
              <thead>
                <tr>
                  <th>Product</th>
                  <th class="dn-center">Quantity</th>
                  <th class="dn-num">Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="dn-items">
                <tr class="dn-empty-items"><td colspan="4" class="dn-empty-cell">No items yet — click <strong>Add custom item</strong> to add one</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- Payment card -->
        <section class="dn-card">
          <h3 class="dn-section">Payment</h3>
          <div class="dn-pay-row"><span class="dn-pay-label">Subtotal</span><span id="dn-sub-count" class="dn-pay-mid">0 items</span><span id="dn-subtotal" class="dn-pay-val">đ0</span></div>
          <div class="dn-pay-row"><a href="#" class="dn-link">Add discount</a><span class="dn-pay-mid">—</span><span class="dn-pay-val">đ0</span></div>
          <div class="dn-pay-row"><a href="#" class="dn-link" id="dn-ship-label">Add shipping or delivery</a><span class="dn-pay-mid" id="dn-ship-mid">—</span><span class="dn-pay-val" id="dn-ship-amt">đ0</span></div>
          <div class="dn-pay-row"><a href="#" class="dn-link">Estimated tax</a><span class="dn-pay-mid" id="dn-tax-label">0% VAT</span><span id="dn-tax" class="dn-pay-val">đ0</span></div>
          <div class="dn-pay-row dn-pay-total"><span class="dn-pay-label">Total</span><span></span><span id="dn-total" class="dn-pay-val"><strong>đ0</strong></span></div>

          <div class="dn-pay-terms">
            <label class="dn-checkbox-row">
              <input type="checkbox" name="payment_due_later" id="dn-due-later" checked/>
              <span>Payment due later</span>
            </label>
            <div class="dn-field" id="dn-terms-wrap">
              <label class="dn-label">Payment terms</label>
              <select name="payment_terms" class="dn-select">
                <option value="due_on_receipt" selected>Due on receipt</option>
                <option value="net_7">Net 7</option>
                <option value="net_15">Net 15</option>
                <option value="net_30">Net 30</option>
                <option value="net_60">Net 60</option>
              </select>
              <p class="dn-help">Payment due when invoice is sent. You'll be able to collect the balance from the order page.</p>
            </div>
            <div class="dn-info-card">
              <span class="dn-info-icon">ⓘ</span>
              <div class="dn-info-body">
                <div>Customers can receive automatic reminders for their orders when payment is due at a later date</div>
                <button type="button" class="dn-btn-light dn-btn-sm" style="margin-top:8px">Set up payment reminders</button>
              </div>
              <button type="button" class="dn-info-close" aria-label="Dismiss">×</button>
            </div>
          </div>

          <div class="dn-pay-actions">
            <button type="button" class="dn-btn-light" id="dn-send-invoice" disabled>Send invoice</button>
            <button type="submit" class="dn-btn-primary" id="dn-create" name="action" value="create" disabled>Create order</button>
          </div>
        </section>

        <!-- Timeline -->
        <section class="dn-card">
          <h3 class="dn-section">Timeline</h3>
          <div class="dn-comment">
            <div class="dn-avatar">${esc(userInitials)}</div>
            <div class="dn-comment-body">
              <input type="text" placeholder="Leave a comment..." class="dn-comment-input" id="dn-comment-input"/>
              <div class="dn-comment-toolbar">
                <div class="dn-comment-icons">
                  <button type="button" class="dn-icon-btn" title="Emoji">☺</button>
                  <button type="button" class="dn-icon-btn" title="Mention">@</button>
                  <button type="button" class="dn-icon-btn" title="Tag">#</button>
                  <button type="button" class="dn-icon-btn" title="Attach">🔗</button>
                </div>
                <button type="button" class="dn-btn-primary dn-btn-sm" id="dn-comment-post" disabled>Post</button>
              </div>
            </div>
          </div>
          <p class="dn-comment-foot">Only you and other staff can see comments</p>
        </section>
      </div>

      <!-- ─────── RIGHT SIDE ─────── -->
      <aside class="dn-side">

        <section class="dn-card">
          <div class="dn-card-head">
            <h3 class="dn-section">Notes</h3>
            <button type="button" class="dn-icon-btn" title="Edit notes" id="dn-notes-edit">✎</button>
          </div>
          <div id="dn-notes-view" class="dn-muted">No notes</div>
          <textarea name="note" id="dn-notes-input" rows="3" class="dn-input" style="display:none;resize:vertical" placeholder="Add a note (visible to staff)"></textarea>
        </section>

        <section class="dn-card">
          <div class="dn-card-head" style="position:relative">
            <h3 class="dn-section">Customer</h3>
            <button type="button" class="dn-icon-btn" id="dn-cust-more-btn" title="More" aria-haspopup="menu" aria-expanded="false">⋯</button>
            <div id="dn-cust-more-menu" role="menu" hidden style="position:absolute;top:32px;right:0;min-width:180px;background:var(--s-card,#1a1d24);border:1px solid var(--s-border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:30;padding:4px;font-size:13px">
              <button type="button" id="dn-cust-create-btn" role="menuitem" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;background:transparent;border:0;color:var(--s-text);cursor:pointer;border-radius:6px;text-align:left;font:inherit">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Create customer
              </button>
            </div>
          </div>
          <div class="dn-cust-search-wrap" id="dn-cust-search-wrap">
            <div class="dn-search">
              <span class="dn-search-icon">🔍</span>
              <input type="text" placeholder="Search or create customer" class="dn-input dn-input-search" id="dn-cust-search" autocomplete="off"/>
            </div>
            <div class="dn-cust-results" id="dn-cust-results" hidden></div>
          </div>
          <div id="dn-cust-info">${customer ? renderCustomer(customer) : ''}</div>
        </section>

        <!-- Quick-create customer modal -->
        <dialog id="qcModal" style="border:1px solid var(--s-border);border-radius:14px;padding:0;background:var(--s-card,#1a1d24);color:var(--s-text);max-width:600px;width:94vw;max-height:90vh">
          <div style="display:flex;flex-direction:column;max-height:90vh">
            <div style="padding:18px 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--s-border)">
              <h3 style="margin:0;font-size:17px;font-weight:700">Create customer</h3>
              <button type="button" id="qcCloseBtn" aria-label="Close" style="border:0;background:transparent;color:var(--s-text-muted);font-size:22px;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px">×</button>
            </div>
            <div style="padding:18px 22px;overflow-y:auto;flex:1">
              <div id="qcError" style="display:none;padding:8px 12px;background:rgba(239,68,68,.12);color:#fca5a5;border-radius:6px;font-size:12.5px;margin-bottom:12px"></div>

              <!-- ─── CUSTOMER OVERVIEW ─── -->
              <div style="background:var(--s-bg,#0f1318);border:1px solid var(--s-border);border-radius:10px;padding:16px;margin-bottom:14px">
                <h4 style="margin:0 0 12px;font-size:13.5px;font-weight:700">Customer Overview</h4>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                  <label><span class="qc-lbl">First name</span>
                    <input id="qcFirstName" type="text" maxlength="80" placeholder="John" class="qc-in"/>
                  </label>
                  <label><span class="qc-lbl">Last name</span>
                    <input id="qcLastName" type="text" maxlength="80" placeholder="Doe" class="qc-in"/>
                  </label>
                </div>
                <label style="display:block;margin-bottom:10px"><span class="qc-lbl">Email *</span>
                  <input id="qcEmail" type="email" required maxlength="120" placeholder="customer@example.com" class="qc-in"/>
                </label>
                <label style="display:block;margin-bottom:10px"><span class="qc-lbl">Phone</span>
                  <input id="qcPhone" type="text" maxlength="32" placeholder="+1 555-123-4567" class="qc-in"/>
                </label>
                <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12.5px;color:var(--s-text);cursor:pointer">
                  <input id="qcAcceptsMarketing" type="checkbox" style="width:14px;height:14px;cursor:pointer"/>
                  Customer agrees to receive marketing emails
                </label>
                <label style="display:block;margin-bottom:10px"><span class="qc-lbl">Tags (comma-separated)</span>
                  <input id="qcTags" type="text" maxlength="240" placeholder="vip, wholesale, newsletter" class="qc-in"/>
                </label>
                <label style="display:block"><span class="qc-lbl">Note</span>
                  <textarea id="qcNote" rows="3" maxlength="1000" placeholder="Internal notes about this customer" class="qc-in" style="resize:vertical"></textarea>
                </label>
              </div>

              <!-- ─── ADDRESS ─── -->
              <div style="background:var(--s-bg,#0f1318);border:1px solid var(--s-border);border-radius:10px;padding:16px">
                <h4 style="margin:0 0 12px;font-size:13.5px;font-weight:700">Address</h4>
                <label style="display:block;margin-bottom:10px"><span class="qc-lbl">Address</span>
                  <input id="qcAddress1" type="text" maxlength="200" placeholder="123 Main St" class="qc-in"/>
                </label>
                <label style="display:block;margin-bottom:10px"><span class="qc-lbl">Apartment, suite, etc.</span>
                  <input id="qcAddress2" type="text" maxlength="200" placeholder="Apt 4B" class="qc-in"/>
                </label>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                  <label><span class="qc-lbl">City</span>
                    <input id="qcCity" type="text" maxlength="100" placeholder="New York" class="qc-in"/>
                  </label>
                  <label><span class="qc-lbl">State / Province</span>
                    <input id="qcProvince" type="text" maxlength="100" placeholder="NY" class="qc-in"/>
                  </label>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                  <label><span class="qc-lbl">ZIP / Postal code</span>
                    <input id="qcZip" type="text" maxlength="20" placeholder="10001" class="qc-in"/>
                  </label>
                  <label><span class="qc-lbl">Country</span>
                    <select id="qcCountry" class="qc-in">
                      ${Object.entries(COUNTRY_NAME).map(([code, name]) => `<option value="${esc(code)}"${code === 'US' ? ' selected' : ''}>${esc(name)} (${esc(code)})</option>`).join('')}
                    </select>
                  </label>
                </div>
                <p style="font-size:11px;color:var(--s-text-dim);margin:6px 0 0">Stores standard ISO country code in DB to avoid typos.</p>
              </div>
            </div>
            <div style="padding:14px 22px;border-top:1px solid var(--s-border);display:flex;justify-content:flex-end;gap:8px;background:var(--s-card,#1a1d24)">
              <button type="button" id="qcCancelBtn" style="padding:8px 14px;border:1px solid var(--s-border);border-radius:7px;background:transparent;color:var(--s-text-muted);cursor:pointer;font-size:13px">Cancel</button>
              <button type="button" id="qcSubmitBtn" style="padding:8px 18px;border:0;border-radius:7px;background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff;cursor:pointer;font-size:13px;font-weight:500">Create customer</button>
            </div>
          </div>
        </dialog>
        <style>
          /* Center dialog + dim backdrop. Native <dialog> tự lock body scroll
             qua top-layer + ::backdrop, nhưng vài browser cũ vẫn có thanh
             cuộn ngoài → JS bổ sung khoá overflow body khi open. */
          dialog#qcModal { margin: auto; border-radius: 16px; box-shadow: 0 24px 48px rgba(0,0,0,.5); overflow: hidden; }
          dialog#qcModal::backdrop { background: rgba(15,23,42,.65); backdrop-filter: blur(2px); }
          /* Khoá scroll outer (cả html + body) khi modal mở — body inside modal
             vẫn scroll qua flex 1 + overflow-y:auto (đã set inline). */
          html.qc-modal-open, body.qc-modal-open { overflow: hidden !important; }
          .qc-lbl { display:block; font-size:12px; font-weight:600; margin-bottom:5px; color:var(--s-text-muted); }
          .qc-in { width:100%; padding:8px 10px; border:1px solid var(--s-border); border-radius:7px; background:var(--s-bg,#13161c); color:var(--s-text); font-size:14px; box-sizing:border-box; outline:none; font-family:inherit; }
          .qc-in:focus { border-color:var(--s-accent); }
        </style>
        <script>(function(){
          var moreBtn = document.getElementById('dn-cust-more-btn');
          var menu = document.getElementById('dn-cust-more-menu');
          var createBtn = document.getElementById('dn-cust-create-btn');
          var modal = document.getElementById('qcModal');
          var closeBtn = document.getElementById('qcCloseBtn');
          var cancelBtn = document.getElementById('qcCancelBtn');
          var submitBtn = document.getElementById('qcSubmitBtn');
          var emailEl = document.getElementById('qcEmail');
          var firstEl = document.getElementById('qcFirstName');
          var lastEl = document.getElementById('qcLastName');
          var phoneEl = document.getElementById('qcPhone');
          var countryEl = document.getElementById('qcCountry');
          var errEl = document.getElementById('qcError');
          var custInfo = document.getElementById('dn-cust-info');
          var custSearchWrap = document.getElementById('dn-cust-search-wrap');
          if (!moreBtn || !menu || !modal) return;

          function openMenu(){ menu.hidden = false; moreBtn.setAttribute('aria-expanded', 'true'); }
          function closeMenu(){ menu.hidden = true; moreBtn.setAttribute('aria-expanded', 'false'); }
          function showErr(msg){ errEl.style.display='block'; errEl.textContent = msg; }
          function clearErr(){ errEl.style.display='none'; errEl.textContent = ''; }
          function lockScroll(){
            document.documentElement.classList.add('qc-modal-open');
            document.body.classList.add('qc-modal-open');
          }
          function unlockScroll(){
            document.documentElement.classList.remove('qc-modal-open');
            document.body.classList.remove('qc-modal-open');
          }
          function openModal(){
            clearErr();
            modal.showModal();
            lockScroll();
            setTimeout(function(){ if(emailEl) emailEl.focus(); }, 30);
          }
          function closeModal(){
            modal.close();
            unlockScroll();
          }
          modal.addEventListener('close', unlockScroll);
          modal.addEventListener('cancel', unlockScroll);

          moreBtn.addEventListener('click', function(e){ e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); });
          createBtn.addEventListener('click', function(){ closeMenu(); openModal(); });
          document.addEventListener('click', function(e){
            if (menu.hidden) return;
            if (e.target === moreBtn || moreBtn.contains(e.target)) return;
            if (menu.contains(e.target)) return;
            closeMenu();
          });
          closeBtn.addEventListener('click', closeModal);
          cancelBtn.addEventListener('click', closeModal);

          submitBtn.addEventListener('click', async function(){
            clearErr();
            var $ = function(id){ var el = document.getElementById(id); return el ? (el.value || '').trim() : ''; };
            var $$ = function(id){ var el = document.getElementById(id); return !!(el && el.checked); };
            var payload = {
              email: $('qcEmail'),
              first_name: $('qcFirstName'),
              last_name: $('qcLastName'),
              phone: $('qcPhone'),
              accepts_marketing: $$('qcAcceptsMarketing'),
              tags: $('qcTags'),
              note: $('qcNote'),
              address_1: $('qcAddress1'),
              address_2: $('qcAddress2'),
              city: $('qcCity'),
              province: $('qcProvince'),
              zip: $('qcZip'),
              country_code: $('qcCountry').toUpperCase()
            };
            if (!payload.email) { showErr('Email là bắt buộc'); return; }
            if (!payload.first_name && !payload.last_name) { showErr('Cần ít nhất first hoặc last name'); return; }
            submitBtn.disabled = true; submitBtn.textContent = 'Saving…';
            try {
              var r = await fetch(${JSON.stringify(`${base}/api/customers/quick-create`)}, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(payload)
              });
              var data = await r.json().catch(function(){ return {}; });
              if (!r.ok) { showErr(data.error || ('HTTP ' + r.status)); return; }
              // Render customer info inline + ẩn search box
              if (custInfo) {
                var name = ((data.first_name || '') + ' ' + (data.last_name || '')).trim() || data.full_name || data.email || '(new)';
                custInfo.innerHTML = '<a href="#" class="dn-link dn-link-bold">' + name.replace(/[<>"&]/g, function(c){ return '&#' + c.charCodeAt(0) + ';'; }) + '</a>'
                  + '<div class="dn-muted-sm">No orders</div>'
                  + '<div class="dn-block"><div class="dn-block-label">Contact information</div>'
                  + '<a href="mailto:' + data.email + '" class="dn-link">' + data.email + '</a>'
                  + (payload.phone ? '<div>' + payload.phone + '</div>' : '')
                  + '</div>';
                // Inject hidden inputs để form submit có customer_id + email
                var hidId = document.querySelector('input[name="customer_id"]');
                if (!hidId) { hidId = document.createElement('input'); hidId.type = 'hidden'; hidId.name = 'customer_id'; custInfo.parentNode.appendChild(hidId); }
                hidId.value = data.id || '';
                var hidEmail = document.querySelector('input[name="email"]');
                if (!hidEmail) { hidEmail = document.createElement('input'); hidEmail.type = 'hidden'; hidEmail.name = 'email'; custInfo.parentNode.appendChild(hidEmail); }
                hidEmail.value = data.email || '';
              }
              if (custSearchWrap) custSearchWrap.style.display = 'none';
              closeModal();
            } catch (err) {
              showErr((err && err.message) || 'Network error');
            } finally {
              submitBtn.disabled = false; submitBtn.textContent = 'Create';
            }
          });
        })();</script>

        <section class="dn-card">
          <div class="dn-card-head">
            <h3 class="dn-section">Markets</h3>
            <button type="button" class="dn-icon-btn" title="Share">↗</button>
          </div>
          <div class="dn-pill-row">
            <span class="dn-pill"><span class="dn-pill-dot">🇻🇳</span> Vietnam</span>
          </div>
          <div class="dn-field" style="margin-top:14px">
            <label class="dn-label">Currency</label>
            <select name="currency" class="dn-select" id="dn-currency">
              <option value="USD" selected>US Dollar (USD $)</option>
              <option value="VND">Vietnamese Dong (VND đ)</option>
            </select>
          </div>
        </section>

        <section class="dn-card">
          <div class="dn-card-head">
            <h3 class="dn-section">Tags</h3>
            <button type="button" class="dn-icon-btn" title="Edit">✎</button>
          </div>
          <input type="text" name="tags" placeholder="Add tags (comma separated)" class="dn-input"/>
        </section>
      </aside>
    </div>
  </form>
</div>
<script>
window.__GBOX_RATES__ = ${JSON.stringify(ratesByCountry).replace(/</g, '\\u003c')};
window.__GBOX_NAME_TO_CODE__ = ${JSON.stringify(nameToCode).replace(/</g, '\\u003c')};
</script>
${DRAFT_NEW_SCRIPT}
${draftCustomerSnippet(customerId, customer)}
`
}

function renderCustomer(c: ApiCustomer): string {
  const name = c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '(no name)'
  const addr = [
    name,
    c.address_1,
    c.address_2,
    [c.city, c.zip].filter(Boolean).join(' '),
    c.country_name,
    c.phone,
  ].filter(Boolean) as string[]
  return `
    <a href="#" class="dn-link dn-link-bold">${esc(name)}</a>
    <div class="dn-muted-sm">No orders</div>

    <div class="dn-block">
      <div class="dn-block-label">Contact information</div>
      ${c.email ? `<a href="mailto:${esc(c.email)}" class="dn-link">${esc(c.email)}</a>` : ''}
      ${c.phone ? `<div>${esc(c.phone)}</div>` : ''}
    </div>

    <div class="dn-block">
      <div class="dn-block-label">Shipping address</div>
      ${addr.map(l => `<div>${esc(String(l))}</div>`).join('')}
      <a href="#" class="dn-link" style="display:inline-block;margin-top:6px">View map</a>
    </div>

    <div class="dn-block dn-block-last">
      <div class="dn-block-label">Billing address</div>
      <div class="dn-muted">Same as shipping address</div>
    </div>
  `
}

function renderCustomerEmpty(): string {
  return `
    <div class="dn-search">
      <span class="dn-search-icon">🔍</span>
      <input type="email" name="customer_search" placeholder="Search or create customer" class="dn-input dn-input-search"/>
    </div>
    <p class="dn-muted-sm" style="margin-top:8px">Customer will be linked once you select one above.</p>
  `
}

// Snippet to populate hidden line items as JS dynamic — also serializes
// shipping_address fields from the customer prefetch when present.
function draftCustomerSnippet(customerId: string, customer: ApiCustomer | null): string {
  if (!customer) return ''
  const ship = {
    address1: customer.address_1 || '',
    city: customer.city || '',
    province: customer.province || '',
    zip: customer.zip || '',
    country: customer.country_name || customer.country_code || '',
  }
  // Inject as hidden fields so postDraftOrderCreate can read them
  return `<script>
    (function(){
      var f = document.getElementById('dn-form');
      if (!f) return;
      var fields = ${JSON.stringify({
        shipping_address1: ship.address1,
        shipping_city: ship.city,
        shipping_province: ship.province,
        shipping_zip: ship.zip,
        shipping_country: ship.country,
      })};
      Object.keys(fields).forEach(function(k){
        if (!fields[k]) return;
        var i = document.createElement('input');
        i.type = 'hidden'; i.name = k; i.value = fields[k];
        f.appendChild(i);
      });
      // Auto-apply tax + shipping for the prefilled customer's country.
      if (typeof window.__GBOX_APPLY_RATES__ === 'function' && fields.shipping_country) {
        window.__GBOX_APPLY_RATES__(fields.shipping_country);
      }
    })();
  </script>`
}

// ─────────────────────────────────────────────
// Style + interactive script
// ─────────────────────────────────────────────

const DRAFT_NEW_STYLE = `<style>
/* Match gbox standard 2-col form pattern (customer-detail-api.ts):
   1100px max, centered, horizontal padding for mobile breathing room. */
.dn { color:var(--s-text); font-size:14px; max-width:1100px; margin:0 auto; padding:0 16px 80px; }
.dn-topbar { display:flex; align-items:center; gap:10px; padding:8px 0 4px; }
.dn-topbar h1 { margin:0; font-size:20px; font-weight:600; color:var(--s-text); }
.dn-check { width:24px; height:24px; border-radius:50%; background:var(--s-success); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:13px; }
.dn-topbar-actions { margin-left:auto; display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.dn-meta { margin:0 0 16px; font-size:12px; color:var(--s-text-muted); }

.dn-banner { padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:13px; }
.dn-banner-error { background:color-mix(in srgb, var(--s-danger) 15%, var(--s-card)); border:1px solid var(--s-danger); color:var(--s-text); }

.dn-grid { display:grid; grid-template-columns:1fr 320px; gap:14px; align-items:start; }
@media (max-width:980px) { .dn-grid { grid-template-columns:1fr; } }
.dn-main, .dn-side { display:flex; flex-direction:column; gap:14px; }

.dn-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px; box-shadow:var(--s-shadow); }
.dn-card-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.dn-section { font-size:13px; font-weight:600; margin:0 0 12px; color:var(--s-text); }
.dn-card-head .dn-section { margin-bottom:0; }
.dn-muted { color:var(--s-text-muted); font-size:13px; }
.dn-muted-sm { color:var(--s-text-muted); font-size:12px; margin-top:4px; }
.dn-link { color:var(--s-accent); text-decoration:none; }
.dn-link:hover { text-decoration:underline; }
.dn-link-bold { font-weight:600; }

/* Buttons */
.dn-btn-light { padding:7px 14px; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text); border-radius:8px; font-size:13px; cursor:pointer; font-family:inherit; line-height:1.4; }
.dn-btn-light:hover:not(:disabled) { background:var(--s-card-hover); }
.dn-btn-light:disabled { opacity:.55; cursor:not-allowed; }
.dn-btn-inline { padding:6px 12px; font-size:12px; }
.dn-btn-primary { padding:8px 18px; border:none; background:var(--s-accent); color:#fff; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; }
.dn-btn-primary:hover:not(:disabled) { background:var(--s-accent-hover); }
.dn-btn-primary:disabled { background:var(--s-border-light); color:var(--s-text-dim); cursor:not-allowed; }
.dn-btn-sm { padding:6px 12px; font-size:12px; }
.dn-more { padding:7px 12px; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text); border-radius:8px; font-size:13px; font-family:inherit; cursor:pointer; display:inline-flex; align-items:center; gap:4px; }
.dn-more:hover { background:var(--s-card-hover); }
.dn-chev { font-size:10px; color:var(--s-text-muted); }
.dn-nav-btn { width:28px; height:28px; padding:0; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text-muted); border-radius:6px; cursor:pointer; }
.dn-nav-btn:hover { background:var(--s-card-hover); color:var(--s-text); }
.dn-icon-btn { background:none; border:none; cursor:pointer; color:var(--s-text-muted); padding:4px 8px; border-radius:4px; font-size:14px; }
.dn-icon-btn:hover { background:var(--s-card-hover); color:var(--s-text); }

/* Inputs */
.dn-input, .dn-select { width:100%; padding:8px 12px; border:1px solid var(--s-input-border); border-radius:8px; font-size:13px; background:var(--s-input-bg); color:var(--s-text); outline:none; box-sizing:border-box; font-family:inherit; }
.dn-input:focus, .dn-select:focus { border-color:var(--s-accent); }
.dn-label { display:block; font-size:12px; font-weight:500; color:var(--s-text-muted); margin-bottom:6px; }
.dn-field { margin-bottom:0; }
.dn-help { margin:6px 0 0; font-size:12px; color:var(--s-text-muted); }

/* Search input */
.dn-search, .dn-prod-search { position:relative; display:flex; gap:8px; align-items:center; margin-bottom:12px; }
.dn-search-icon { position:absolute; left:12px; top:50%; transform:translateY(-50%); color:var(--s-text-muted); pointer-events:none; }
.dn-input-search { padding-left:34px; flex:1; }

/* Customer autocomplete dropdown — same shape as product */
.dn-cust-search-wrap { position:relative; margin-bottom:12px; }
.dn-cust-results { position:absolute; top:42px; left:0; right:0; max-height:300px; overflow-y:auto; background:var(--s-card); border:1px solid var(--s-border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.18); z-index:20; }
.dn-cust-result { padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--s-border); }
.dn-cust-result:last-child { border-bottom:none; }
.dn-cust-result:hover { background:var(--s-card-hover); }
.dn-cust-result-name { color:var(--s-text); font-size:13px; font-weight:500; }
.dn-cust-result-meta { color:var(--s-text-muted); font-size:12px; margin-top:2px; }
.dn-cust-empty { padding:12px; text-align:center; color:var(--s-text-muted); font-size:12px; }

/* Product autocomplete dropdown */
.dn-prod-search-wrap { position:relative; }
.dn-prod-results { position:absolute; top:42px; left:0; right:0; max-height:340px; overflow-y:auto; background:var(--s-card); border:1px solid var(--s-border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.18); z-index:20; }
.dn-prod-result { display:flex; gap:10px; align-items:center; padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--s-border); }
.dn-prod-result:last-child { border-bottom:none; }
.dn-prod-result:hover, .dn-prod-result.dn-active { background:var(--s-card-hover); }
.dn-prod-result-img { width:36px; height:36px; border-radius:6px; object-fit:cover; background:var(--s-card-hover); flex-shrink:0; }
.dn-prod-result-img-placeholder { width:36px; height:36px; border-radius:6px; background:var(--s-card-hover); display:inline-flex; align-items:center; justify-content:center; color:var(--s-text-muted); font-size:14px; flex-shrink:0; }
.dn-prod-result-info { flex:1; min-width:0; }
.dn-prod-result-name { color:var(--s-text); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dn-prod-result-meta { color:var(--s-text-muted); font-size:11px; margin-top:2px; }
.dn-prod-result-price { color:var(--s-text); font-size:13px; font-weight:500; flex-shrink:0; }
.dn-prod-empty { padding:12px; text-align:center; color:var(--s-text-muted); font-size:12px; }

/* Products table */
.dn-table-wrap { overflow-x:auto; border-top:1px solid var(--s-border); margin-top:8px; }
.dn-table { width:100%; border-collapse:collapse; font-size:13px; table-layout:fixed; }
.dn-table thead th { text-align:left; padding:10px 12px; font-weight:500; color:var(--s-text-muted); font-size:12px; border-bottom:1px solid var(--s-border); }
.dn-table tbody td { padding:12px; border-bottom:1px solid var(--s-border); vertical-align:middle; }
.dn-table tbody tr:last-child td { border-bottom:none; }
.dn-num { text-align:right; }
.dn-center { text-align:center; }
.dn-empty-cell { text-align:center; padding:30px 12px; color:var(--s-text-muted); font-size:13px; }
.dn-item-thumb { width:40px; height:40px; border-radius:6px; background:var(--s-card-hover); display:inline-flex; align-items:center; justify-content:center; color:var(--s-text-muted); font-size:14px; flex-shrink:0; }
.dn-item-thumb-img { width:40px; height:40px; border-radius:6px; object-fit:cover; background:var(--s-card-hover); flex-shrink:0; }
.dn-item-info { display:flex; align-items:center; gap:10px; min-width:0; }
.dn-item-info > div { min-width:0; flex:1; }
.dn-item-name { color:var(--s-text); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dn-item-meta { color:var(--s-text-muted); font-size:12px; margin-top:2px; }
.dn-qty-input { width:84px; padding:6px 8px; border:1px solid var(--s-input-border); border-radius:6px; background:var(--s-input-bg); color:var(--s-text); font-size:13px; text-align:center; outline:none; box-sizing:border-box; }
.dn-row-total { display:inline-block; min-width:0; }
.dn-row-del { background:none; border:none; color:var(--s-text-muted); cursor:pointer; padding:4px 8px; border-radius:4px; font-size:14px; line-height:1; }
.dn-row-del:hover { color:var(--s-danger); background:var(--s-card-hover); }

/* Payment rows */
.dn-pay-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; padding:10px 0; border-bottom:1px solid var(--s-border); align-items:center; font-size:13px; }
.dn-pay-row:last-of-type { border-bottom:none; }
.dn-pay-label { color:var(--s-text); }
.dn-pay-mid { color:var(--s-text-muted); font-size:12px; }
.dn-pay-val { text-align:right; color:var(--s-text); }
.dn-pay-info { color:var(--s-text-muted); font-size:11px; cursor:help; }
.dn-pay-total { font-weight:600; padding:14px 0 4px; border-top:1px solid var(--s-border); }

/* Payment terms */
.dn-pay-terms { margin-top:18px; padding-top:14px; border-top:1px solid var(--s-border); }
.dn-checkbox-row { display:inline-flex; align-items:center; gap:8px; cursor:pointer; user-select:none; margin-bottom:12px; font-size:13px; }
.dn-checkbox-row input { width:16px; height:16px; accent-color:var(--s-accent); }
.dn-info-card { display:flex; gap:10px; padding:12px 14px; background:color-mix(in srgb, var(--s-info, #3b82f6) 10%, var(--s-card)); border:1px solid color-mix(in srgb, var(--s-info, #3b82f6) 35%, transparent); border-radius:8px; margin-top:14px; position:relative; font-size:12px; }
.dn-info-icon { color:var(--s-info, #3b82f6); flex-shrink:0; font-size:14px; }
.dn-info-body { flex:1; color:var(--s-text); }
.dn-info-close { background:none; border:none; cursor:pointer; color:var(--s-text-muted); padding:0 6px; font-size:18px; line-height:1; }
.dn-pay-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:18px; }

/* Comment */
.dn-comment { display:flex; gap:10px; align-items:flex-start; }
.dn-avatar { width:32px; height:32px; border-radius:6px; background:#22c55e; color:#fff; display:inline-flex; align-items:center; justify-content:center; font-weight:600; font-size:12px; flex-shrink:0; }
.dn-comment-body { flex:1; border:1px solid var(--s-input-border); border-radius:8px; background:var(--s-input-bg); padding:8px 12px; }
.dn-comment-input { width:100%; border:none; outline:none; background:transparent; color:var(--s-text); font-size:13px; font-family:inherit; padding:4px 0 8px; }
.dn-comment-toolbar { display:flex; justify-content:space-between; align-items:center; padding-top:6px; border-top:1px solid var(--s-border); }
.dn-comment-icons { display:flex; gap:2px; }
.dn-comment-foot { text-align:right; font-size:12px; color:var(--s-text-muted); margin:6px 0 0; }

/* Right blocks */
.dn-block { padding:12px 0; border-bottom:1px solid var(--s-border); font-size:13px; line-height:1.5; }
.dn-block-last { border-bottom:none; padding-bottom:0; }
.dn-block-label { font-weight:600; font-size:12px; color:var(--s-text); margin-bottom:6px; }

.dn-pill-row { display:flex; flex-wrap:wrap; gap:8px; }
.dn-pill { display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:1px solid var(--s-border); border-radius:999px; font-size:12px; color:var(--s-text); background:var(--s-card-hover); }
</style>`

const DRAFT_NEW_SCRIPT = `<script>
(function(){
  var form = document.getElementById('dn-form');
  if (!form) return;
  var itemsBody = document.getElementById('dn-items');
  var emptyRow = itemsBody.querySelector('.dn-empty-items');
  var subtotalEl = document.getElementById('dn-subtotal');
  var subCountEl = document.getElementById('dn-sub-count');
  var taxEl = document.getElementById('dn-tax');
  var taxLabelEl = document.getElementById('dn-tax-label');
  var shipLabelEl = document.getElementById('dn-ship-label');
  var shipMidEl = document.getElementById('dn-ship-mid');
  var shipAmtEl = document.getElementById('dn-ship-amt');
  var totalEl = document.getElementById('dn-total');
  var createBtn = document.getElementById('dn-create');
  var sendInvBtn = document.getElementById('dn-send-invoice');
  var counter = 0;

  // Country-driven tax + shipping rates (server-side prebuild). Mirrors the
  // /orders/<id> render flow but lives client-side so picking a customer
  // updates totals without a page reload.
  var RATES = window.__GBOX_RATES__ || {};
  var NAME_TO_CODE = window.__GBOX_NAME_TO_CODE__ || {};
  var currentTaxRate = 0;          // fraction (0.10 = 10%)
  var currentTaxLabel = '0% VAT';
  var currentShipName = '';
  var currentShipPrice = 0;
  var currentCountryCode = '';

  function resolveCountryCode(ref){
    if (!ref) return '';
    var raw = String(ref).trim();
    if (!raw) return '';
    if (raw.length === 2) return raw.toUpperCase();
    return NAME_TO_CODE[raw.toLowerCase()] || raw.toUpperCase();
  }
  function applyRatesForCountry(ref){
    var code = resolveCountryCode(ref);
    currentCountryCode = code;
    var info = code ? RATES[code] : null;
    if (info) {
      currentTaxRate = (Number(info.tax_rate) || 0) / 100;
      currentTaxLabel = info.tax_label || (info.tax_rate ? info.tax_rate + '% VAT' : '0% VAT');
      currentShipName = info.ship_name || '';
      currentShipPrice = Number(info.ship_price) || 0;
    } else {
      currentTaxRate = 0;
      currentTaxLabel = '0% VAT';
      currentShipName = '';
      currentShipPrice = 0;
    }
    if (taxLabelEl) taxLabelEl.textContent = currentTaxLabel;
    if (shipLabelEl) shipLabelEl.textContent = currentShipName ? 'Shipping' : 'Add shipping or delivery';
    if (shipMidEl) shipMidEl.textContent = currentShipName || '—';
    // shipAmtEl text refreshed in recalc()
    // Sync hidden inputs so POST /orders/drafts persists with the same picks
    ensureHidden('shipping_method_name', currentShipName);
    ensureHidden('shipping_price', currentShipPrice ? String(currentShipPrice) : '');
    ensureHidden('tax_rate_pct', currentTaxRate ? String(currentTaxRate * 100) : '');
  }

  function currentCurrency(){
    var sel = document.getElementById('dn-currency');
    return sel ? sel.value : 'USD';
  }
  function fmt(n){
    var cur = currentCurrency();
    var sign = cur === 'VND' ? 'đ' : '$';
    var num = cur === 'VND' ? Math.round(n) : (Math.round(n * 100) / 100);
    return sign + num.toLocaleString('en-US', { minimumFractionDigits: cur === 'VND' ? 0 : 2, maximumFractionDigits: cur === 'VND' ? 0 : 2 });
  }
  function recalc(){
    var rows = itemsBody.querySelectorAll('.dn-item-row');
    var sub = 0; var qtyTotal = 0;
    rows.forEach(function(r){
      var p = parseFloat(r.dataset.price || '0');
      var q = parseInt(r.querySelector('input[type=number]').value || '1', 10);
      sub += p * q;
      qtyTotal += q;
      var totalCell = r.querySelector('.dn-row-total');
      if (totalCell) totalCell.textContent = fmt(p * q);
    });
    var tax = sub * currentTaxRate;
    var ship = currentShipPrice;
    subtotalEl.textContent = fmt(sub);
    subCountEl.textContent = qtyTotal + (qtyTotal === 1 ? ' item' : ' items');
    taxEl.textContent = fmt(tax);
    if (shipAmtEl) shipAmtEl.textContent = fmt(ship);
    totalEl.innerHTML = '<strong>' + fmt(sub + tax + ship) + '</strong>';
    var hasItems = rows.length > 0;
    if (createBtn) createBtn.disabled = !hasItems;
    if (sendInvBtn) sendInvBtn.disabled = !hasItems;
    emptyRow.style.display = hasItems ? 'none' : '';
  }

  function addItem(title, price, image){
    counter += 1;
    var idx = counter;
    var row = document.createElement('tr');
    row.className = 'dn-item-row';
    row.dataset.price = String(price);
    var thumb = image
      ? '<img src="' + escapeHtml(image) + '" class="dn-item-thumb-img" alt=""/>'
      : '<span class="dn-item-thumb">📦</span>';
    row.innerHTML =
      '<td>'
        + '<div class="dn-item-info">'
          + thumb
          + '<div>'
            + '<div class="dn-item-name">' + escapeHtml(title) + '</div>'
            + '<div class="dn-item-meta">đ' + Number(price).toLocaleString('en-US') + '</div>'
          + '</div>'
        + '</div>'
        + '<input type="hidden" name="item' + idx + '_title" value="' + escapeHtml(title) + '"/>'
        + '<input type="hidden" name="item' + idx + '_price" value="' + price + '"/>'
        + (image ? '<input type="hidden" name="item' + idx + '_image" value="' + escapeHtml(image) + '"/>' : '')
      + '</td>'
      + '<td class="dn-center"><input type="number" name="item' + idx + '_qty" value="1" min="1" class="dn-qty-input"/></td>'
      + '<td class="dn-num"><span class="dn-row-total">' + fmt(price) + '</span></td>'
      + '<td class="dn-center"><button type="button" class="dn-row-del" title="Remove">×</button></td>';
    itemsBody.appendChild(row);
    row.querySelector('input[type=number]').addEventListener('input', recalc);
    row.querySelector('.dn-row-del').addEventListener('click', function(){
      row.remove(); recalc();
    });
    recalc();
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }

  // "Add custom item" — prompt for title + price
  document.getElementById('dn-add-custom').addEventListener('click', function(){
    var title = window.prompt('Item title?');
    if (!title) return;
    var priceStr = window.prompt('Price (number)?', '0');
    var price = parseFloat(priceStr || '0') || 0;
    addItem(title.trim(), price);
  });

  // Product search via BE proxy: /orders/drafts/api/products?q=
  var search = document.getElementById('dn-prod-search');
  var results = document.getElementById('dn-prod-results');
  var browseBtn = document.getElementById('dn-browse');
  var searchTimer = null;
  var lastQuery = null;

  function renderResults(items){
    if (!items || items.length === 0) {
      results.innerHTML = '<div class="dn-prod-empty">No products found</div>';
      results.hidden = false;
      return;
    }
    results.innerHTML = items.map(function(it){
      var img = it.image
        ? '<img src="' + escapeHtml(it.image) + '" class="dn-prod-result-img" alt=""/>'
        : '<span class="dn-prod-result-img-placeholder">📦</span>';
      var meta = it.sku ? 'SKU ' + escapeHtml(it.sku) : '';
      return '<div class="dn-prod-result" data-pid="' + escapeHtml(it.id) + '" data-pname="' + escapeHtml(it.name) + '" data-pprice="' + Number(it.price) + '" data-pimg="' + escapeHtml(it.image || '') + '">'
        + img
        + '<div class="dn-prod-result-info">'
          + '<div class="dn-prod-result-name">' + escapeHtml(it.name) + '</div>'
          + (meta ? '<div class="dn-prod-result-meta">' + meta + '</div>' : '')
        + '</div>'
        + '<div class="dn-prod-result-price">đ' + Number(it.price).toLocaleString('en-US') + '</div>'
      + '</div>';
    }).join('');
    results.hidden = false;
  }

  async function fetchProducts(q){
    if (q === lastQuery) return;
    lastQuery = q;
    try {
      var url = window.location.pathname.replace(/\\/orders\\/drafts\\/new$/, '/orders/drafts/api/products') + '?q=' + encodeURIComponent(q || '') + '&limit=8';
      var r = await fetch(url, { credentials: 'same-origin', headers: { 'accept': 'application/json' } });
      if (!r.ok) { results.innerHTML = '<div class="dn-prod-empty">Search failed (HTTP ' + r.status + ')</div>'; results.hidden = false; return; }
      var json = await r.json();
      renderResults(json.data || []);
    } catch (e) {
      results.innerHTML = '<div class="dn-prod-empty">Error: ' + escapeHtml(String(e.message || e)) + '</div>';
      results.hidden = false;
    }
  }

  if (search) {
    search.addEventListener('input', function(){
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function(){ fetchProducts(search.value.trim()); }, 250);
    });
    search.addEventListener('focus', function(){
      if (search.value.trim() || results.children.length) results.hidden = false;
    });
    document.addEventListener('click', function(e){
      if (!e.target.closest('.dn-prod-search-wrap')) results.hidden = true;
    });
  }
  if (browseBtn) {
    browseBtn.addEventListener('click', function(){
      lastQuery = null;  // force refetch
      fetchProducts('');
    });
  }
  if (results) {
    results.addEventListener('click', function(e){
      var row = e.target.closest('.dn-prod-result');
      if (!row) return;
      addItem(row.dataset.pname, parseFloat(row.dataset.pprice) || 0, row.dataset.pimg || '');
      results.hidden = true;
      search.value = '';
      lastQuery = null;
    });
  }

  // ─── Customer autocomplete ───
  var custSearch = document.getElementById('dn-cust-search');
  var custResults = document.getElementById('dn-cust-results');
  var custInfo = document.getElementById('dn-cust-info');
  var custTimer = null;
  var custLastQ = null;

  function ensureHidden(name, value){
    var existing = form.querySelector('input[type=hidden][name="' + name + '"]');
    if (existing) { existing.value = value || ''; return; }
    var i = document.createElement('input');
    i.type = 'hidden'; i.name = name; i.value = value || '';
    form.appendChild(i);
  }
  function clearShippingHiddens(){
    ['customer_id','email','shipping_address1','shipping_city','shipping_province','shipping_zip','shipping_country']
      .forEach(function(n){
        var el = form.querySelector('input[type=hidden][name="' + n + '"]');
        if (el) el.value = '';
      });
  }
  function selectCustomer(c){
    clearShippingHiddens();
    ensureHidden('customer_id', c.id);
    if (c.email) ensureHidden('email', c.email);
    if (c.address_1) ensureHidden('shipping_address1', c.address_1);
    if (c.city) ensureHidden('shipping_city', c.city);
    if (c.province) ensureHidden('shipping_province', c.province);
    if (c.zip) ensureHidden('shipping_zip', c.zip);
    if (c.country_name) ensureHidden('shipping_country', c.country_name);

    // Auto-apply tax + shipping based on the customer's country (mirrors
    // /orders/<id> server-side compute). Falls back to 0% / no shipping
    // when the country has no configured zone or tax subfee.
    applyRatesForCountry(c.country_code || c.country_name);
    recalc();

    // Render the selected customer in the right panel
    var addrLines = [
      c.full_name,
      c.address_1,
      c.address_2,
      [c.city, c.zip].filter(Boolean).join(' '),
      c.country_name,
      c.phone,
    ].filter(Boolean);
    var html = ''
      + '<a href="#" class="dn-link dn-link-bold">' + escapeHtml(c.full_name || '(no name)') + '</a>'
      + '<div class="dn-muted-sm">No orders</div>'
      + '<div class="dn-block">'
        + '<div class="dn-block-label">Contact information</div>'
        + (c.email ? '<a href="mailto:' + escapeHtml(c.email) + '" class="dn-link">' + escapeHtml(c.email) + '</a>' : '')
        + (c.phone ? '<div>' + escapeHtml(c.phone) + '</div>' : '')
      + '</div>'
      + '<div class="dn-block">'
        + '<div class="dn-block-label">Shipping address</div>'
        + addrLines.map(function(l){ return '<div>' + escapeHtml(l) + '</div>'; }).join('')
      + '</div>'
      + '<div class="dn-block dn-block-last">'
        + '<div class="dn-block-label">Billing address</div>'
        + '<div class="dn-muted">Same as shipping address</div>'
      + '</div>';
    custInfo.innerHTML = html;
    custResults.hidden = true;
    custSearch.value = c.full_name || c.email || '';
    custLastQ = null;
  }

  function renderCustResults(items){
    if (!items || items.length === 0) {
      custResults.innerHTML = '<div class="dn-cust-empty">No customers found</div>';
      custResults.hidden = false;
      return;
    }
    custResults.innerHTML = items.map(function(c, idx){
      var meta = [c.email, c.phone].filter(Boolean).join(' · ');
      return '<div class="dn-cust-result" data-cidx="' + idx + '">'
        + '<div class="dn-cust-result-name">' + escapeHtml(c.full_name) + '</div>'
        + (meta ? '<div class="dn-cust-result-meta">' + escapeHtml(meta) + '</div>' : '')
      + '</div>';
    }).join('');
    custResults.hidden = false;
    // Stash items array for click handler
    custResults.dataset.payload = JSON.stringify(items);
  }

  async function fetchCustomers(q){
    if (q === custLastQ) return;
    custLastQ = q;
    try {
      var url = window.location.pathname.replace(/\\/orders\\/drafts\\/new$/, '/orders/drafts/api/customers') + '?q=' + encodeURIComponent(q || '') + '&limit=8';
      var r = await fetch(url, { credentials: 'same-origin', headers: { 'accept': 'application/json' } });
      if (!r.ok) { custResults.innerHTML = '<div class="dn-cust-empty">Search failed (HTTP ' + r.status + ')</div>'; custResults.hidden = false; return; }
      var json = await r.json();
      renderCustResults(json.data || []);
    } catch (e) {
      custResults.innerHTML = '<div class="dn-cust-empty">Error: ' + escapeHtml(String(e.message || e)) + '</div>';
      custResults.hidden = false;
    }
  }

  if (custSearch) {
    custSearch.addEventListener('input', function(){
      clearTimeout(custTimer);
      custTimer = setTimeout(function(){ fetchCustomers(custSearch.value.trim()); }, 250);
    });
    custSearch.addEventListener('focus', function(){
      if (custSearch.value.trim() || custResults.children.length) custResults.hidden = false;
      else fetchCustomers('');  // show top results on first focus
    });
    document.addEventListener('click', function(e){
      if (!e.target.closest('#dn-cust-search-wrap')) custResults.hidden = true;
    });
  }
  if (custResults) {
    custResults.addEventListener('click', function(e){
      var row = e.target.closest('.dn-cust-result');
      if (!row) return;
      var items = JSON.parse(custResults.dataset.payload || '[]');
      var c = items[parseInt(row.dataset.cidx, 10)];
      if (c) selectCustomer(c);
    });
  }

  // Notes pencil reveal
  var notesEdit = document.getElementById('dn-notes-edit');
  var notesView = document.getElementById('dn-notes-view');
  var notesInput = document.getElementById('dn-notes-input');
  if (notesEdit && notesView && notesInput) {
    notesEdit.addEventListener('click', function(){
      notesView.style.display = 'none';
      notesInput.style.display = 'block';
      notesInput.focus();
    });
    notesInput.addEventListener('blur', function(){
      if (!notesInput.value.trim()) {
        notesView.style.display = 'block';
        notesInput.style.display = 'none';
      }
    });
  }

  // Comment Post enable/disable
  var commentInp = document.getElementById('dn-comment-input');
  var commentBtn = document.getElementById('dn-comment-post');
  if (commentInp && commentBtn) {
    commentInp.addEventListener('input', function(){ commentBtn.disabled = !commentInp.value.trim(); });
  }

  // Re-render totals + per-row totals when currency changes
  var currencySel = document.getElementById('dn-currency');
  if (currencySel) currencySel.addEventListener('change', recalc);

  // Expose for the customer prefetch snippet (runs AFTER this IIFE) so it
  // can apply rates for an initially-resolved customer.
  window.__GBOX_APPLY_RATES__ = function(ref){
    applyRatesForCountry(ref);
    recalc();
  };

  // Initial state
  recalc();
})();
</script>`
