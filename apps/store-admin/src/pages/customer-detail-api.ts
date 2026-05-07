/**
 * Store Admin — Customer Detail (API mode)
 *
 * Renders Shopify-style customer detail page when local DB is unavailable.
 * Hits BE Gbox-Customer-Service `GET /api/{shop_id}/{IdOrEmail}` and maps
 * Customer model fields directly to UI sections.
 *
 * Field references (BE Customer model — packages/api-client/src/customer/models/Customer.ts):
 *   - Header:        full_name (or first_name + last_name)
 *   - Contact:       email, phone
 *   - Default addr:  full_name, address_1, address_2, city, province, zip, country_name, phone
 *   - Customer since: created_at (relative time)
 *
 * Data NOT in BE Customer model — rendered as placeholder, TODO wire later:
 *   - amount_spent, orders_count → /customer-stats/{customer_id}
 *   - rfm_group → analytics service
 *   - timeline events → notes service (separate endpoint, requires DB or sub-API)
 *   - tags, notes, store_credit → not in BE Customer (custom fields path)
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { createApiContext, getCustomerByIdOrEmail, deleteCustomer } from '../lib/customer-api-client.js'
import { ProductApiError } from '../lib/product-api-errors.js'
import type { ApiCustomer } from '../lib/customer-api-types.js'

export async function renderCustomerDetailApi(
  req: Request,
  res: Response,
  customerId: string,
): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).send('Store context missing'); return }
  const user = req.storeUser ?? { name: '', email: '', role: '', storeRole: '' } as any
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfToken = (req as any).csrfToken || ''

  let customer: ApiCustomer | null = null
  let errorMsg: string | null = null

  try {
    const ctx = createApiContext(req)
    customer = await getCustomerByIdOrEmail(ctx, customerId)
  } catch (err: any) {
    errorMsg = err instanceof ProductApiError ? `${err.kind}: ${err.message}` : (err?.message ?? 'unknown')
    console.error('[customer-detail-api] fetch failed:', errorMsg)
  }

  if (!customer) {
    res.status(404).send(notFoundPage(base, customerId, errorMsg))
    return
  }

  const content = renderDetail(base, customer, csrfToken)

  res.send(sellerLayout({
    title: customerName(customer),
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

// ─────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────

function renderDetail(base: string, c: ApiCustomer, csrfToken: string): string {
  const name = customerName(c).toUpperCase()
  const initials = (customerName(c).slice(0, 2) || '?').toUpperCase()
  const userInitials = 'CP'  // logged-in user's initials — TODO: pass from sellerLayout
  const customerId = String(c.id || '')

  return `
    ${DETAIL_STYLE}
    <div class="cd">
      <div class="cd-topbar">
        <a href="${base}/customers" class="cd-crumb" title="Back">👤</a>
        <span class="cd-crumb-sep">›</span>
        <h1>${esc(name)}</h1>
        <div class="cd-topbar-actions">
          ${renderMoreActions(base, customerId, csrfToken)}
          <button type="button" class="cd-nav-btn" title="Previous">‹</button>
          <button type="button" class="cd-nav-btn" title="Next">›</button>
        </div>
      </div>

      ${renderStats(c)}

      <div class="cd-grid">
        <div class="cd-main">
          ${renderLastOrder(base, String(c.id || ''))}
          ${renderTimeline(userInitials, c)}
        </div>
        <aside class="cd-side">
          ${renderCustomerCard(c)}
          ${renderStoreCredit()}
          ${renderTags(c)}
          ${renderNotes(c)}
        </aside>
      </div>
    </div>
  `
}

// ─────────────────────────────────────────────
// More actions dropdown — Issue store credit / Merge / Request data /
// Erase / Delete. 4 mục đầu là stub coming-soon, Delete gọi API thật.
// ─────────────────────────────────────────────

function renderMoreActions(base: string, customerId: string, csrfToken: string): string {
  const iconCredit = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="5" width="15" height="10" rx="2"/><path d="M2.5 9h15"/></svg>'
  const iconMerge = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="6" r="2.5"/><circle cx="13" cy="6" r="2.5"/><path d="M5 16c.5-3 2.4-4.5 5-4.5s4.5 1.5 5 4.5"/></svg>'
  const iconDoc = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2h7l4 4v12H5z"/><path d="M12 2v4h4M7 9h6M7 12h6M7 15h4"/></svg>'
  const iconErase = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M11 4l5 5-7 7H4v-5z"/><path d="M9 6l5 5"/></svg>'
  const iconTrash = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 6h10M8 6V4h4v2M6 6v11a1 1 0 001 1h6a1 1 0 001-1V6M9 9v6M11 9v6"/></svg>'

  return `<div class="cd-more-wrap">
    <button type="button" class="cd-more" data-cd-more-toggle aria-haspopup="menu" aria-expanded="false">
      More actions <span class="cd-chev">▾</span>
    </button>
    <div class="cd-more-menu" data-cd-more-menu role="menu">
      <button type="button" class="cd-more-item" role="menuitem" onclick="gxComingSoon('Issue store credit')">${iconCredit} Issue store credit</button>
      <button type="button" class="cd-more-item" role="menuitem" onclick="gxComingSoon('Merge customer')">${iconMerge} Merge customer</button>
      <button type="button" class="cd-more-item" role="menuitem" onclick="gxComingSoon('Request customer data')">${iconDoc} Request customer data</button>
      <button type="button" class="cd-more-item" role="menuitem" onclick="gxComingSoon('Erase personal data')">${iconErase} Erase personal data</button>
      <button type="button" class="cd-more-item cd-more-danger" role="menuitem" data-cd-delete>${iconTrash} Delete customer</button>
    </div>
    <form id="cd-delete-form" method="POST" action="${base}/customers/${esc(customerId)}/delete" style="display:none">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />
    </form>
  </div>
  <script>
    (function(){
      var btn = document.querySelector('[data-cd-more-toggle]');
      var menu = document.querySelector('[data-cd-more-menu]');
      if (btn && menu) {
        btn.addEventListener('click', function(e){
          e.stopPropagation();
          var open = menu.classList.toggle('show');
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        document.addEventListener('click', function(){
          menu.classList.remove('show');
          btn.setAttribute('aria-expanded', 'false');
        });
        menu.addEventListener('click', function(e){ e.stopPropagation(); });
      }
      var del = document.querySelector('[data-cd-delete]');
      var form = document.getElementById('cd-delete-form');
      if (del && form) {
        del.addEventListener('click', function(){
          if (confirm('Are you sure you want to delete this customer? This action cannot be undone.')) {
            form.submit();
          }
        });
      }
    })();
  </script>`
}

function renderStats(c: ApiCustomer): string {
  // BE Customer model has no amount_spent/orders_count — render zero defaults.
  const amountSpent = 'đ0'
  const orders = 0
  const since = relativeSince(c.created_at)
  const rfm = '—'

  return `<section class="cd-stats">
    <div class="cd-stat"><div class="cd-stat-label">Amount spent</div><div class="cd-stat-val">${amountSpent}</div></div>
    <div class="cd-stat"><div class="cd-stat-label">Orders</div><div class="cd-stat-val">${orders}</div></div>
    <div class="cd-stat"><div class="cd-stat-label">Customer since</div><div class="cd-stat-val">${esc(since)}</div></div>
    <div class="cd-stat"><div class="cd-stat-label">RFM group</div><div class="cd-stat-val">${rfm}</div></div>
  </section>`
}

function renderLastOrder(base: string, customerId?: string): string {
  const createHref = `${base}/orders/drafts/new${customerId ? `?customer_id=${encodeURIComponent(customerId)}` : ''}`
  return `<section class="cd-card">
    <div class="cd-lastorder">
      <div>
        <h3 class="cd-card-title">Last order placed</h3>
        <p class="cd-muted">This customer hasn't placed any orders yet</p>
        <a href="${createHref}" class="cd-btn-light">Create order</a>
      </div>
      <div class="cd-lastorder-illust" aria-hidden="true">${ORDER_ILLUSTRATION}</div>
    </div>
  </section>`
}

function renderTimeline(userInitials: string, c: ApiCustomer): string {
  const created = relativeSince(c.created_at)
  return `<section class="cd-card">
    <h3 class="cd-card-title">Timeline</h3>
    <div class="cd-comment">
      <div class="cd-avatar cd-avatar-green">${esc(userInitials)}</div>
      <div class="cd-comment-body">
        <input type="text" placeholder="Leave a comment..." class="cd-comment-input" id="cd-comment-input"/>
        <div class="cd-comment-toolbar">
          <div class="cd-comment-icons">
            <button type="button" class="cd-icon-btn" title="Emoji">☺</button>
            <button type="button" class="cd-icon-btn" title="Mention">@</button>
            <button type="button" class="cd-icon-btn" title="Tag">#</button>
            <button type="button" class="cd-icon-btn" title="Attach">🔗</button>
          </div>
          <button type="button" class="cd-btn-primary cd-btn-sm" id="cd-comment-post" disabled>Post</button>
        </div>
      </div>
    </div>
    <p class="cd-comment-foot">Only you and other staff can see comments</p>
    <div class="cd-timeline">
      <div class="cd-timeline-day">Today</div>
      <div class="cd-timeline-event">
        <span class="cd-timeline-dot"></span>
        <span class="cd-timeline-text">You created this customer.</span>
        <span class="cd-timeline-time">${esc(created)}</span>
      </div>
    </div>
  </section>
  <script>
    (function(){
      var inp = document.getElementById('cd-comment-input');
      var btn = document.getElementById('cd-comment-post');
      if (inp && btn) {
        inp.addEventListener('input', function(){ btn.disabled = !inp.value.trim(); });
      }
    })();
  </script>`
}

function renderCustomerCard(c: ApiCustomer): string {
  const email = c.email || '—'
  const phone = c.phone || ''
  const lang = 'English'  // BE Customer model has no language field — TODO

  const addrLines = [
    customerName(c),
    // BE has no `company` — could use first part of address_2 if needed; left empty
    c.address_1,
    c.address_2,
    [c.city, c.zip].filter(Boolean).join(' '),
    c.country_name,
    c.phone,
  ].filter(Boolean) as string[]

  const hasEmail = !!c.email
  const hasSms = !!c.phone

  return `<section class="cd-card">
    <div class="cd-card-head">
      <h3 class="cd-card-title">Customer</h3>
      <button type="button" class="cd-icon-btn" title="More">⋯</button>
    </div>

    <div class="cd-block">
      <div class="cd-block-label">Contact information</div>
      ${hasEmail ? `<div class="cd-row"><a href="mailto:${esc(email)}" class="cd-link">${esc(email)}</a><button type="button" class="cd-icon-btn cd-icon-tiny" title="Copy" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(email)}')">⎘</button></div>` : '<div class="cd-muted">No email</div>'}
      ${phone ? `<div>${esc(phone)}</div>` : ''}
      <div class="cd-muted-sm">Will receive notifications in ${esc(lang)}</div>
    </div>

    <div class="cd-block">
      <div class="cd-block-label">Default address</div>
      ${addrLines.length > 0 ? addrLines.map(l => `<div>${esc(String(l))}</div>`).join('') : '<div class="cd-muted">No address</div>'}
    </div>

    <div class="cd-block">
      <div class="cd-block-label">Marketing</div>
      <div class="cd-marketing-pills">
        <span class="cd-pill ${hasEmail ? 'cd-pill-on' : ''}"><span class="cd-pill-dot"></span> Email</span>
        <span class="cd-pill ${hasSms ? 'cd-pill-on' : ''}"><span class="cd-pill-dot cd-pill-dot-off"></span> SMS</span>
      </div>
    </div>

    <div class="cd-block cd-block-last">
      <div class="cd-block-label">Tax details</div>
      <div>Collect tax</div>
    </div>
  </section>`
}

function renderStoreCredit(): string {
  // BE Customer model has no store_credit field — TODO when /store-credit API exists
  return `<section class="cd-card">
    <div class="cd-card-head">
      <h3 class="cd-card-title">Store credit</h3>
      <button type="button" class="cd-icon-btn" title="Edit">✎</button>
    </div>
    <div class="cd-muted">None</div>
  </section>`
}

function renderTags(_c: ApiCustomer): string {
  // BE Customer model has no tags field directly — would need customFields parse. Visual-only.
  return `<section class="cd-card">
    <div class="cd-card-head">
      <h3 class="cd-card-title">Tags</h3>
      <button type="button" class="cd-icon-btn" title="Edit">✎</button>
    </div>
    <input type="text" placeholder="Add tag" class="cd-input"/>
  </section>`
}

function renderNotes(_c: ApiCustomer): string {
  // BE has no notes field on Customer — would be a separate notes table/endpoint.
  return `<section class="cd-card">
    <div class="cd-card-head">
      <h3 class="cd-card-title">Notes</h3>
      <button type="button" class="cd-icon-btn" title="Edit">✎</button>
    </div>
    <div class="cd-muted">None</div>
  </section>`
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function customerName(c: ApiCustomer): string {
  return c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '(no name)'
}

function relativeSince(iso?: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (isNaN(t)) return '—'
  const diff = Math.max(0, Date.now() - t) / 1000
  if (diff < 60) return `Less than ${Math.floor(diff)} seconds`
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes`
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} days`
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} months`
  return `${Math.floor(diff / (86400 * 365))} years`
}

function notFoundPage(base: string, id: string, errorMsg: string | null): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;background:#0f172a;color:#e2e8f0">
    <h2>Customer not found</h2>
    <p>ID/email: <code>${esc(id)}</code></p>
    ${errorMsg ? `<p style="color:#fca5a5">${esc(errorMsg)}</p>` : ''}
    <a href="${base}/customers" style="color:#818cf8">‹ Back to Customers</a>
  </body></html>`
}

// ─────────────────────────────────────────────
// Style + asset
// ─────────────────────────────────────────────

const DETAIL_STYLE = `<style>
.cd { color:var(--s-text); font-size:14px; max-width:1100px; margin:0 auto; padding-bottom:80px; }
.cd-topbar { display:flex; align-items:center; gap:8px; padding:8px 4px 16px; }
.cd-topbar h1 { margin:0; font-size:20px; font-weight:600; color:var(--s-text); }
.cd-crumb { color:var(--s-text-muted); text-decoration:none; font-size:16px; }
.cd-crumb:hover { color:var(--s-text); }
.cd-crumb-sep { color:var(--s-text-muted); }
.cd-topbar-actions { margin-left:auto; display:flex; align-items:center; gap:8px; }
.cd-more-wrap { position:relative; display:inline-block; }
.cd-more { padding:7px 12px; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text); border-radius:8px; font-size:13px; font-family:inherit; cursor:pointer; display:inline-flex; align-items:center; gap:4px; }
.cd-more:hover { background:var(--s-card-hover); }
.cd-chev { font-size:10px; color:var(--s-text-muted); }
.cd-more-menu { position:absolute; top:calc(100% + 4px); left:0; min-width:230px; background:var(--s-card); border:1px solid var(--s-border); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.25); padding:6px; display:none; z-index:30; }
.cd-more-menu.show { display:block; }
.cd-more-item { width:100%; display:flex; align-items:center; gap:10px; padding:9px 12px; border:none; background:transparent; color:var(--s-text); font-size:13px; cursor:pointer; border-radius:6px; text-align:left; font-family:inherit; }
.cd-more-item:hover { background:var(--s-card-hover, var(--s-bg)); }
.cd-more-item svg { flex-shrink:0; color:var(--s-text-muted); }
.cd-more-danger { color:var(--s-danger, #ef4444); }
.cd-more-danger svg { color:var(--s-danger, #ef4444); }
.cd-more-danger:hover { background:color-mix(in srgb, var(--s-danger, #ef4444) 14%, var(--s-card)); }
.cd-nav-btn { width:28px; height:28px; padding:0; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text-muted); border-radius:6px; cursor:pointer; }
.cd-nav-btn:hover { background:var(--s-card-hover); color:var(--s-text); }

.cd-stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:0; margin-bottom:14px; background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; box-shadow:var(--s-shadow); overflow:hidden; }
@media (max-width:780px) { .cd-stats { grid-template-columns:repeat(2, 1fr); } }
.cd-stat { padding:14px 18px; border-right:1px solid var(--s-border); }
.cd-stat:last-child { border-right:none; }
.cd-stat-label { font-size:12px; color:var(--s-text-muted); margin-bottom:4px; text-decoration:underline; text-decoration-style:dotted; text-underline-offset:3px; }
.cd-stat-val { font-size:14px; color:var(--s-text); }

.cd-grid { display:grid; grid-template-columns:1fr 320px; gap:14px; align-items:start; }
@media (max-width:980px) { .cd-grid { grid-template-columns:1fr; } }
.cd-main, .cd-side { display:flex; flex-direction:column; gap:14px; }

.cd-card { background:var(--s-card); border:1px solid var(--s-border); border-radius:12px; padding:18px; box-shadow:var(--s-shadow); }
.cd-card-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.cd-card-title { margin:0 0 8px; font-size:13px; font-weight:600; color:var(--s-text); }
.cd-card-head .cd-card-title { margin-bottom:0; }
.cd-muted { color:var(--s-text-muted); font-size:13px; }
.cd-muted-sm { color:var(--s-text-muted); font-size:12px; margin-top:6px; }

/* Last order block */
.cd-lastorder { display:grid; grid-template-columns:1fr 140px; gap:16px; align-items:center; }
@media (max-width:540px) { .cd-lastorder { grid-template-columns:1fr; } .cd-lastorder-illust { display:none; } }
.cd-lastorder-illust { display:flex; justify-content:center; }

.cd-btn-light { display:inline-block; padding:7px 14px; border:1px solid var(--s-border); background:var(--s-card); color:var(--s-text); border-radius:8px; font-size:13px; cursor:pointer; text-decoration:none; margin-top:10px; }
.cd-btn-light:hover { background:var(--s-card-hover); }
.cd-btn-primary { background:var(--s-accent); color:#fff; border:none; border-radius:8px; padding:7px 14px; font-size:13px; cursor:pointer; font-family:inherit; }
.cd-btn-primary:disabled { background:var(--s-border-light); color:var(--s-text-dim); cursor:not-allowed; }
.cd-btn-primary:hover:not(:disabled) { background:var(--s-accent-hover); }
.cd-btn-sm { padding:6px 12px; font-size:12px; }

/* Comment input */
.cd-comment { display:flex; gap:10px; align-items:flex-start; }
.cd-avatar { width:32px; height:32px; border-radius:6px; display:inline-flex; align-items:center; justify-content:center; font-weight:600; font-size:12px; color:#fff; flex-shrink:0; }
.cd-avatar-green { background:#22c55e; }
.cd-comment-body { flex:1; border:1px solid var(--s-input-border); border-radius:8px; background:var(--s-input-bg); padding:8px 12px; }
.cd-comment-input { width:100%; border:none; outline:none; background:transparent; color:var(--s-text); font-size:13px; font-family:inherit; padding:4px 0 8px; }
.cd-comment-toolbar { display:flex; justify-content:space-between; align-items:center; padding-top:6px; border-top:1px solid var(--s-border); }
.cd-comment-icons { display:flex; gap:2px; }
.cd-icon-btn { background:none; border:none; cursor:pointer; color:var(--s-text-muted); padding:4px 8px; border-radius:4px; font-size:13px; }
.cd-icon-btn:hover { background:var(--s-card-hover); color:var(--s-text); }
.cd-icon-tiny { padding:2px 4px; font-size:12px; }
.cd-comment-foot { text-align:right; font-size:12px; color:var(--s-text-muted); margin:6px 0 0; }

/* Timeline */
.cd-timeline { margin-top:18px; padding-top:14px; border-top:1px solid var(--s-border); }
.cd-timeline-day { font-size:12px; color:var(--s-text-muted); margin-bottom:10px; }
.cd-timeline-event { display:flex; align-items:center; gap:10px; padding:6px 0; font-size:13px; }
.cd-timeline-dot { width:8px; height:8px; border-radius:50%; background:var(--s-text-muted); flex-shrink:0; }
.cd-timeline-text { flex:1; color:var(--s-text); }
.cd-timeline-time { color:var(--s-text-muted); font-size:12px; }

/* Right column blocks */
.cd-block { padding:12px 0; border-bottom:1px solid var(--s-border); font-size:13px; line-height:1.5; }
.cd-block-last { border-bottom:none; padding-bottom:0; }
.cd-block:first-of-type { padding-top:0; }
.cd-block-label { font-weight:600; font-size:12px; color:var(--s-text); margin-bottom:6px; }
.cd-row { display:flex; align-items:center; gap:6px; }
.cd-link { color:var(--s-accent); text-decoration:none; }
.cd-link:hover { text-decoration:underline; }

/* Marketing pills */
.cd-marketing-pills { display:flex; gap:8px; }
.cd-pill { display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:1px solid var(--s-border); border-radius:999px; font-size:12px; color:var(--s-text); background:var(--s-card-hover); }
.cd-pill-dot { width:8px; height:8px; border-radius:50%; background:var(--s-border-light); }
.cd-pill.cd-pill-on .cd-pill-dot:not(.cd-pill-dot-off) { background:var(--s-success); }
.cd-pill.cd-pill-on .cd-pill-dot-off { background:var(--s-text-muted); }

/* Tags input */
.cd-input { width:100%; padding:7px 10px; border:1px solid var(--s-input-border); border-radius:6px; background:var(--s-input-bg); color:var(--s-text); font-size:13px; outline:none; box-sizing:border-box; font-family:inherit; }
.cd-input:focus { border-color:var(--s-accent); }
</style>`

const ORDER_ILLUSTRATION = `<svg width="120" height="100" viewBox="0 0 120 100" fill="none" xmlns="http://www.w3.org/2000/svg" role="img">
  <circle cx="60" cy="55" r="45" fill="#cbd5e1" opacity=".25"/>
  <rect x="32" y="22" width="56" height="64" rx="4" fill="#fff" stroke="#cbd5e1" stroke-width="1.5"/>
  <rect x="38" y="32" width="32" height="4" rx="2" fill="#94a3b8"/>
  <rect x="38" y="42" width="44" height="3" rx="1.5" fill="#cbd5e1"/>
  <rect x="38" y="50" width="44" height="3" rx="1.5" fill="#cbd5e1"/>
  <rect x="38" y="58" width="36" height="3" rx="1.5" fill="#cbd5e1"/>
  <circle cx="76" cy="76" r="14" fill="#7dd3c0"/>
  <path d="M70 76 L74 80 L82 72" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

// ─────────────────────────────────────────────
// POST /admin/store/:slug/customers/:customerId/delete — xóa 1 customer
// qua BE Customer-Service DELETE /api/{shop_id} body=[id].
// ─────────────────────────────────────────────

export async function postCustomerDeleteApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).send('Store context missing'); return }
  const customerId = String(req.params.customerId || req.params.id || '')
  const listUrl = `/admin/store/${store.slug}/customers`
  if (!customerId) { res.redirect(listUrl); return }

  try {
    const ctx = createApiContext(req)
    await deleteCustomer(ctx, customerId)
    res.redirect(`${listUrl}?success=${encodeURIComponent('Customer deleted')}`)
  } catch (err: any) {
    const msg = err instanceof ProductApiError ? `${err.kind}: ${err.message}` : (err?.message ?? 'Delete failed')
    console.error('[customer-delete-api] failed:', msg)
    res.redirect(`${listUrl}/${encodeURIComponent(customerId)}?error=${encodeURIComponent(msg)}`)
  }
}
