/**
 * Store Admin — Products
 *
 * Shows: product listing, product detail/edit, new product form, create handler
 * Mirrors Shopify product management UX
 */

import { getSessionTokenFromCookies } from '@gbox/core/modules/auth/session.js'
import { decodeJwtPayload, isShopId, readUserFromJwt } from '../lib/shop-resolver.js'
import { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc as escLayout } from '../layouts/seller-layout.js'
import { notify, byActor } from '../lib/notify.js'
import { renderProductNewForm } from './product-new-form.js'
// Phase 14 API mode — postProductCreate dùng client wrapper thay raw fetch.
import { createApiContext, createProduct, listCategories } from '../lib/product-api-client.js'
import { ProductApiError } from '../lib/product-api-errors.js'
import { renderCategoryListView } from './category-list-view.js'
// CSRF: centralized in server.ts; pages use req.csrfToken + csrfHiddenField.
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
// Lenful catalog (Phase F8): seller-side "Lenful products" tab + one-click import.
import {
  listCatalog as listLenfulCatalog,
  listCatalogCategories as listLenfulCategories,
  getCatalogEntry as getLenfulCatalogEntry,
  syncCatalogFromLive as syncLenfulCatalogFromLive,
  type CatalogListRow as LenfulCatalogRow,
  type NormalizedVariant as LenfulNormVariant,
} from '@gbox/core/modules/fulfillment/lenful/catalog-sync.js'
// Legacy Gbox master-shop push (migration 033): "Add to store" no longer
// creates a local v4 product — it POSTs straight to api-product.gbox.co
// under a single god-admin-configured master account. See
// apps/god-admin/src/pages/integrations-gbox-legacy.ts for the config UI.
import {
  createLegacyProduct,
  mapLenfulEntryToLegacyProduct,
  recordPush,
  bumpPushCount,
  getActiveConfig as getLegacyGboxActiveConfig,
} from '@gbox/core/modules/integrations/gbox-legacy/index.js'
// Local v4 fallback for "Add to my store" when no legacy master config
// is wired (seen on fresh installs — see Iron Rule 5, never surface the
// god-admin setup path to sellers). The handler below branches on
// `getLegacyGboxActiveConfig(db)` presence: when null, we copy the
// Lenful catalog entry into a draft product in the seller's OWN shop
// instead of pushing to the legacy master.
import { copyCatalogEntryToLocalProduct } from '@gbox/core/modules/fulfillment/lenful/copy-to-local.js'
// Phase C2 — smart collection fan-out trigger. Every product mutation
// that could change a smart-collection membership (title/vendor/type/
// tags/status/price/inventory) calls this at the end of the handler.
// The helper is fail-open: if Redis is down the admin request still
// succeeds and the worker catches up on the next trigger.
import { enqueueSyncShopSmart } from '@gbox/core/modules/collections/enqueue-triggers.js'
// Phase 2 PR5 — multi-location inventory. The inline inventory_quantity
// field on the variants table sets a TOTAL across all locations. To keep
// the inventory_items/inventory_levels bridge in sync with the denormalized
// product_variants.inventory_quantity column we route every delta through
// updateInventory() and apply it to the shop's primary active location.
// (Single-location shops — the default — behave identically to before.)
import { updateInventory } from '@gbox/core/modules/products/service.js'
// Phase 2 PR1 + PR6 — metafields.
//   PR1 adds the sidebar "Custom data" card on product detail (add/edit/
//   delete arbitrary key/value pairs) and uses the aliased names below.
//   PR6 layers a bulk-edit "Custom field" tab + one-click SEO shortcut
//   card on top, both upserting via the same canonical service. Two
//   imports of the same underlying `setMetafield` export are fine — one
//   plain (PR6 call sites) and one aliased (PR1 sidebar call sites).
import { setMetafield } from '@gbox/core/modules/metafields/service.js'
import {
  listMetafields as listProductMetafields,
  setMetafield as setProductMetafield,
  deleteMetafieldById as deleteProductMetafieldById,
  VALUE_TYPES as METAFIELD_VALUE_TYPES,
  type Metafield as ProductMetafieldRow,
  type MetafieldValueType,
} from '@gbox/core/modules/metafields/service.js'

// ---------------------------------------------------------------------------
// Route param resolver — accept EITHER a UUID or a slug (handle).
//
// Why: collection pages link to `/products/<slug>` (see collections.ts,
// the `<a href="${base}/products/${p.slug || p.id}">` fragment) but the
// admin's product-detail routes historically assumed a UUID and fed
// req.params.productId straight into `where('id', '=', ...)`. PostgreSQL
// rejects non-UUID strings on a uuid column with
// "invalid input syntax for type uuid", which bubbles up as a 500 and
// renders the generic page-not-found.
//
// Fix: at the top of each handler, translate the raw param into a real
// UUID by testing for canonical 8-4-4-4-12 hex, and falling back to a
// slug lookup scoped to this shop. If nothing matches we return the
// zero UUID — a syntactically valid value that is guaranteed not to
// match any real row, so every handler's existing `if (!existing)`
// branch still fires and renders the proper 404 / redirect.
//
// Behaviour matches Shopify's admin, where slug-based product URLs are
// aliases for the canonical numeric-id URL rather than separate pages.
// ---------------------------------------------------------------------------

const PRODUCT_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Sentinel UUID that will never match a row. Using a valid UUID string
// (not '' or 'not-a-uuid') keeps PostgreSQL happy and lets the downstream
// `if (!existing)` 404 path fire naturally.
const PRODUCT_ID_MISS = '00000000-0000-0000-0000-000000000000'

export async function resolveProductId(
  shopId: string,
  productIdOrSlug: string,
): Promise<string> {
  const input = (productIdOrSlug ?? '').trim()
  if (!input) return PRODUCT_ID_MISS
  if (PRODUCT_ID_UUID_RE.test(input)) return input
  // // API-MODE: Call Shop API to resolve slug
  return PRODUCT_ID_MISS
}

// ---------------------------------------------------------------------------
// GET /products — Product listing with search, filters, pagination
// ---------------------------------------------------------------------------

export async function getProducts(
  req: Request,
  res: Response,
): Promise<void> {
  // Tab "List Category" — same /products route, different view. Branch
  // early so the products fetch below doesn't run for nothing.
  if ((req.query.source as string) === 'category') {
    return renderCategoryListView(req, res)
  }

  const db = null as any
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  // Query params
  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const perPage = 20
  const search = ((req.query.q as string) || '').trim()
  const statusFilter = ((req.query.status as string) || 'all').toLowerCase()

  // API-MODE: Fetch from Products API
  const cloneSources: any[] = []
  let totalProducts = 0
  let activeCount = 0
  let draftCount = 0
  let archivedCount = 0
  let manualCount = 0
  let products: any[] = []
  let filteredTotal = 0
  let totalPages = 0
  let bulkCollections: any[] = []

  const apiBase = (process.env.API_PRODUCT_BASE_URL || 'https://api-product.gbox.co').replace(/\/+$/, '')
  {
    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)

    // Resolve shop_id ưu tiên: store.id (24-hex) → JWT.Shops[0] fallback. Phòng
    // trường hợp middleware mock đẩy slug-style vào store.id → BE filter sai.
    let resolvedShopId = isShopId(store.id) ? store.id : ''
    if (!resolvedShopId && token) {
      const claims = decodeJwtPayload(token)
      const jwtUser = claims ? readUserFromJwt(claims) : null
      if (jwtUser && jwtUser.shopIds.length > 0) resolvedShopId = jwtUser.shopIds[0]
    }
    if (!resolvedShopId) {
      console.warn('[Products] no valid shop_id. store.id=%s', store.id)
    }

    const listPayload: any = {}
    if (search) listPayload.keyword = search
    if (statusFilter !== 'all') listPayload.published = (statusFilter === 'active')

    const LIST_FIELDS = 'id,name,slug,vendor,tags,images,variant_default,variants,published,create_date,update_date,categories,review_summary'

    const url = `${apiBase}/api/${encodeURIComponent(resolvedShopId)}/list?page=${page}&limit=${perPage}&fields=${encodeURIComponent(LIST_FIELDS)}`
    console.log('[Products] POST %s body=%s', url, JSON.stringify(listPayload))
    const bodyStr = JSON.stringify(listPayload)
    let r: Response | null = null
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: bodyStr,
        signal: AbortSignal.timeout(12000),
      })
    } catch (err: any) {
      console.error('[Products] fetch error:', err?.name, err?.message)
    }

    if (!r) {
      console.warn('[Products] no response (network/timeout). url=%s', url)
    } else if (!r.ok) {
      const errBody = await r.text().catch(() => '')
      console.error('[Products] BE %d %s. url=%s body=%s', r.status, r.statusText, url, errBody.slice(0, 500))
    } else {
      const data = await r.json()
      const rawList = Array.isArray(data?.data) ? data.data : []
      console.log('[Products] OK shop_id=%s count=%d', resolvedShopId, rawList.length)
      products = rawList.map((p: any) => {
        // variants array là biến thể đầy đủ; variant_default là biến thể fallback
        // khi product không có option (giá + sku ở variant_default).
        const allVariants = Array.isArray(p.variants) && p.variants.length > 0
          ? p.variants
          : (p.variant_default ? [p.variant_default] : [])
        const prices = allVariants.map((v: any) => Number(v.price || 0)).filter((n: number) => n > 0)
        const categoryNames: string[] = Array.isArray(p.categories)
          ? p.categories.map((c: any) => c?.name).filter(Boolean)
          : []
        return {
          id: p.id || p.slug,
          title: p.name || p.slug || 'Unnamed',
          slug: p.slug || '',
          variant_count: allVariants.length,
          status: p.published === true ? 'active' : 'draft',
          // Field đúng theo Product.cs:375 là `inventory` (bool tracking ở
          // inventory_tracking; số lượng ở inventory). Cũ map nhầm inventory_quantity.
          total_inventory: allVariants.reduce((sum: number, v: any) => sum + Number(v.inventory ?? 0), 0),
          product_type: '',
          vendor: p.vendor || '',
          tags: Array.isArray(p.tags) ? p.tags : [],
          categories: categoryNames,
          image_url: Array.isArray(p.images) && p.images.length > 0
            ? (p.images.find((i: any) => i?.position === 0 || i?.position == null)?.url ?? p.images[0]?.url ?? '')
            : (p.variant_default?.image_url ?? ''),
          create_date: p.create_date ?? null,
          update_date: p.update_date ?? null,
          min_price: prices.length ? Math.min(...prices) : 0,
          max_price: prices.length ? Math.max(...prices) : 0,
        }
      })
      // BE pagination shape (Models/Pagination.cs): { page, limit, count, total_page }
      const pag = data?.pagination
      filteredTotal = Number(pag?.count ?? products.length)
      totalPages = Math.max(1, Number(pag?.total_page ?? Math.ceil(filteredTotal / perPage)))
      totalProducts = filteredTotal
      // Đếm theo status thực tế của trang hiện tại — chính xác hơn hardcode.
      activeCount = products.filter((p: any) => p.status === 'active').length
      draftCount = products.length - activeCount
    }
  }

  const source = (req.query.source as string) || 'all'


  // Build filter URL helper — preserves source across tab clicks.
  function filterUrl(params: Record<string, string>): string {
    const p = new URLSearchParams()
    if (params.status && params.status !== 'all') p.set('status', params.status)
    if (params.q) p.set('q', params.q)
    if (params.page && params.page !== '1') p.set('page', params.page)
    if (source !== 'all') p.set('source', source)
    const qs = p.toString()
    return `${base}/products${qs ? '?' + qs : ''}`
  }

  // Source-tab URL helper — changes source, resets page, keeps search.
  function sourceUrl(target: 'all' | 'manual' | 'lenful' | string): string {
    const p = new URLSearchParams()
    if (target !== 'all') p.set('source', target)
    if (search) p.set('q', search)
    // Keep status filter when switching sources so the seller stays on
    // "Active" while flipping between sites — less surprising than a
    // hard reset.
    if (statusFilter !== 'all') p.set('status', statusFilter)
    const qs = p.toString()
    return `${base}/products${qs ? '?' + qs : ''}`
  }

  function statusBadge(status: string): string {
    if (status === 'active') return '<span class="badge badge-success">Active</span>'
    if (status === 'draft') return '<span class="badge badge-warning">Draft</span>'
    if (status === 'archived') return '<span class="badge badge-danger">Archived</span>'
    return `<span class="badge">${esc(status)}</span>`
  }

  function fmtMoney(n: number): string {
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  function priceRange(min: string | number | null, max: string | number | null): string {
    const lo = Number(min ?? 0)
    const hi = Number(max ?? 0)
    if (lo === 0 && hi === 0) return `<span style="color:var(--s-text-muted);font-weight:400">—</span>`
    if (lo === hi) return fmtMoney(lo)
    return `<span>${fmtMoney(lo)}<span style="color:var(--s-text-muted);font-weight:400"> – ${fmtMoney(hi)}</span></span>`
  }

  const tabClass = (s: string) => statusFilter === s ? 'tab active' : 'tab'

  // Success / error banners driven by ?success= / ?error= redirects
  // from bulk actions, rename, and similar mutating POST handlers.
  const successMsg = typeof req.query.success === 'string' ? req.query.success : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''
  const bannerHtml = successMsg
    ? `<div class="gbx-flash gbx-flash-success" role="status">${esc(successMsg)}</div>`
    : errorMsg
      ? `<div class="gbx-flash gbx-flash-error" role="alert">${esc(errorMsg)}</div>`
      : ''

  const content = `
    ${bannerHtml}
    <div class="page-header">
      <div>
        <h1 class="page-title">Products</h1>
        <p class="page-subtitle">${filteredTotal} product${filteredTotal !== 1 ? 's' : ''} found</p>
      </div>
      <div style="display:flex;gap:8px">
        <a href="${base}/products/import" class="btn btn-outline" title="Preview a CSV upload before changing anything">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="margin-right:6px"><path d="M8 14V6M5 9l3-3 3 3"/><path d="M2 2v1a1 1 0 001 1h10a1 1 0 001-1V2"/></svg>
          Import
        </a>
        <a href="${base}/products/export" class="btn btn-outline" title="Download products, variants and custom data as CSV or JSON">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="margin-right:6px"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M2 12v1a1 1 0 001 1h10a1 1 0 001-1v-1"/></svg>
          Export
        </a>
        <a href="${base}/products/new" class="btn btn-primary">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
          Add product
        </a>
      </div>
    </div>

    <!-- SOURCE TABS (My products | Lenful catalog | List Category) — level 1 -->
    <div class="source-tabs">
      <a href="${sourceUrl('all')}" class="source-tab${source === 'all' || source === 'manual' ? ' active' : ''}">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 4l6-2 6 2v8l-6 2-6-2V4zM2 4l6 2 6-2M8 6v8"/></svg>
        My products
      </a>
      <a href="${base}/products?source=lenful" class="source-tab${source === 'lenful' ? ' active' : ''}">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 2v12M2 8h12"/></svg>
        Lenful products
        <span class="source-tab-pill">POD</span>
      </a>
      <a href="${base}/products?source=category" class="source-tab">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 3h5v5H2zM9 3h5v5H9zM2 10h5v4H2zM9 10h5v4H9z"/></svg>
        List Category
      </a>
    </div>

    ${cloneSources.length > 0 ? (() => {
      // -------------------------------------------------------------
      // PHASE 2 — Source-site tab strip (level 2).
      //
      // Layout:
      //   [ All (N) ]  [ Manual (N) ]  [ bibliobloom.com (N) ✏️ ]
      //   [ shopify.com (N) ✏️ ]  [ More ▼ ]
      //
      // Rules:
      //   - "All" is always first and maps to source=all (no filter).
      //   - "Manual" only appears when there's at least one clone
      //     source on the shop (otherwise it's redundant with All).
      //   - Up to 5 most-recent clone-source tabs render inline; the
      //     rest live behind a "More ▼" dropdown. Cutoff is 5 because
      //     6+ tabs start to wrap on a 1280px viewport — tuned by
      //     experimenting with the dashboard at common laptop widths.
      //   - Each clone-source tab has a pencil icon that opens the
      //     rename modal. The icon is position:absolute so it doesn't
      //     affect tab width computation (which we do with JS for the
      //     overflow menu — see renameTabModal below).
      //   - The active tab gets `.site-tab.active` so the pencil icon
      //     becomes visible; on non-active tabs it's hidden until
      //     hover for a less noisy default view.
      // -------------------------------------------------------------
      const MAX_INLINE = 5
      const inline = cloneSources.slice(0, MAX_INLINE)
      const overflow = cloneSources.slice(MAX_INLINE)
      const renameIcon = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8-4 1 1-4 8-8z"/></svg>`
      const renderSiteTab = (c: CloneSource) => {
        return `
        <a href="${sourceUrl(c.id)}" class="site-tab${source === c.id ? ' active' : ''}" data-source-id="${esc(c.id)}">
          <span class="site-tab-dot"></span>
          <span class="site-tab-label">${esc(cloneSourceLabel(c))}</span>
          <span class="site-tab-count">${c.product_count}</span>
          <button type="button" class="site-tab-edit" title="Rename this source"
                  data-source-id="${esc(c.id)}" data-source-label="${esc(cloneSourceLabel(c))}"
                  onclick="event.preventDefault();event.stopPropagation();openRenameModalFrom(this)">
            ${renameIcon}
          </button>
        </a>`
      }

      return `
      <div class="site-tabs" role="tablist" aria-label="Filter products by source site">
        <a href="${sourceUrl('all')}" class="site-tab${source === 'all' ? ' active' : ''}">
          <span class="site-tab-label">All</span>
          <span class="site-tab-count">${totalProducts}</span>
        </a>
        <a href="${sourceUrl('manual')}" class="site-tab${source === 'manual' ? ' active' : ''}">
          <span class="site-tab-label">Manual</span>
          <span class="site-tab-count">${manualCount}</span>
        </a>
        ${inline.map(renderSiteTab).join('')}
        ${overflow.length > 0 ? `
          <div class="site-tab-more">
            <button type="button" class="site-tab site-tab-more-btn" onclick="toggleSiteTabMore(this)" aria-haspopup="true" aria-expanded="false">
              More
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 4l3 3 3-3"/></svg>
            </button>
            <div class="site-tab-more-menu" role="menu">
              ${overflow.map((c) => `
                <a href="${sourceUrl(c.id)}" role="menuitem" class="site-tab-more-item${source === c.id ? ' active' : ''}">
                  <span class="site-tab-dot"></span>
                  <span>${esc(cloneSourceLabel(c))}</span>
                  <span class="site-tab-count">${c.product_count}</span>
                  <button type="button" class="site-tab-edit" title="Rename this source"
                          data-source-id="${esc(c.id)}" data-source-label="${esc(cloneSourceLabel(c))}"
                          onclick="event.preventDefault();event.stopPropagation();openRenameModalFrom(this)">
                    ${renameIcon}
                  </button>
                </a>`).join('')}
            </div>
          </div>
        ` : ''}
      </div>
      `
    })() : ''}

    <!-- POLARIS-INSPIRED STYLES (scoped to this page) -->
    <style>
      .pl-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
      .pl-stat{padding:14px 16px;background:var(--gx-surface,rgba(255,255,255,.03));border:1px solid var(--gx-border,rgba(255,255,255,.06));border-radius:10px;display:flex;align-items:center;gap:12px;transition:.15s}
      .pl-stat:hover{border-color:rgba(91,109,255,.25)}
      .pl-stat-icon{width:36px;height:36px;border-radius:9px;display:grid;place-items:center;font-size:16px;flex-shrink:0}
      .pl-stat-icon-total{background:rgba(91,109,255,.12);color:#7c8aff}
      .pl-stat-icon-active{background:rgba(34,197,94,.12);color:#4ade80}
      .pl-stat-icon-draft{background:rgba(234,179,8,.12);color:#facc15}
      .pl-stat-icon-arch{background:rgba(148,163,184,.12);color:#94a3b8}
      .pl-stat-label{font-size:11px;color:var(--gx-muted,#9aa0a6);text-transform:uppercase;letter-spacing:.05em;font-weight:500;margin:0 0 1px}
      .pl-stat-val{font-size:20px;font-weight:600;color:var(--gx-text,#e8eaf0);line-height:1.1;font-variant-numeric:tabular-nums}

      .pl-toolbar{background:var(--gx-surface,rgba(255,255,255,.02));border:1px solid var(--gx-border,rgba(255,255,255,.06));border-radius:12px 12px 0 0;border-bottom:0;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
      .pl-tabs{display:flex;gap:4px;background:rgba(255,255,255,.04);border:1px solid var(--gx-border,rgba(255,255,255,.06));border-radius:9px;padding:3px;width:fit-content;max-width:100%;overflow-x:auto}
      .pl-tab{padding:7px 14px;border-radius:6px;font-size:13px;font-weight:500;color:var(--gx-muted,#9aa0a6);text-decoration:none;display:inline-flex;align-items:center;gap:7px;line-height:1;white-space:nowrap;transition:.15s}
      .pl-tab:hover{color:var(--gx-text,#e8eaf0)}
      .pl-tab-active{background:var(--gx-bg,#1a1d24);color:var(--gx-text,#fff);box-shadow:0 1px 2px rgba(0,0,0,.15)}
      .pl-tab-count{font-size:11px;background:rgba(255,255,255,.1);padding:1px 7px;border-radius:10px;color:inherit;font-variant-numeric:tabular-nums;min-width:20px;text-align:center}

      .pl-search-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .pl-search{position:relative;flex:1;min-width:240px}
      .pl-search input{width:100%;padding:9px 12px 9px 36px;background:var(--gx-bg,#13161c);border:1px solid var(--gx-border,rgba(255,255,255,.08));border-radius:8px;font-size:13.5px;color:var(--gx-text,#e8eaf0);transition:.15s;box-sizing:border-box;outline:none}
      .pl-search input:focus{border-color:#5b6dff;box-shadow:0 0 0 3px rgba(91,109,255,.15)}
      .pl-search input::placeholder{color:var(--gx-muted,#7a8089)}
      .pl-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--gx-muted,#7a8089);pointer-events:none}
      .pl-clear{padding:6px 10px;font-size:12px;color:var(--gx-muted,#9aa0a6);text-decoration:none;border-radius:6px;border:1px solid var(--gx-border,rgba(255,255,255,.08));background:transparent;cursor:pointer}
      .pl-clear:hover{color:var(--gx-text,#fff);background:rgba(255,255,255,.04)}
    </style>

    <!-- STATS — Polaris icon cards -->
    <div class="pl-stats">
      <div class="pl-stat"><div class="pl-stat-icon pl-stat-icon-total">📦</div><div><div class="pl-stat-label">Total products</div><div class="pl-stat-val">${totalProducts.toLocaleString()}</div></div></div>
      <div class="pl-stat"><div class="pl-stat-icon pl-stat-icon-active">✓</div><div><div class="pl-stat-label">Active</div><div class="pl-stat-val">${activeCount.toLocaleString()}</div></div></div>
      <div class="pl-stat"><div class="pl-stat-icon pl-stat-icon-draft">✎</div><div><div class="pl-stat-label">Draft</div><div class="pl-stat-val">${draftCount.toLocaleString()}</div></div></div>
      <div class="pl-stat"><div class="pl-stat-icon pl-stat-icon-arch">🗄</div><div><div class="pl-stat-label">Archived</div><div class="pl-stat-val">${archivedCount.toLocaleString()}</div></div></div>
    </div>

    <!-- TOOLBAR — pill tabs + search -->
    <div class="pl-toolbar">
      <div class="pl-tabs" role="tablist" aria-label="Lọc theo trạng thái">
        <a href="${filterUrl({ q: search, status: 'all' })}" class="pl-tab${statusFilter === 'all' ? ' pl-tab-active' : ''}" role="tab">All<span class="pl-tab-count">${totalProducts.toLocaleString()}</span></a>
        <a href="${filterUrl({ q: search, status: 'active' })}" class="pl-tab${statusFilter === 'active' ? ' pl-tab-active' : ''}" role="tab">Active<span class="pl-tab-count">${activeCount.toLocaleString()}</span></a>
        <a href="${filterUrl({ q: search, status: 'draft' })}" class="pl-tab${statusFilter === 'draft' ? ' pl-tab-active' : ''}" role="tab">Draft<span class="pl-tab-count">${draftCount.toLocaleString()}</span></a>
        <a href="${filterUrl({ q: search, status: 'archived' })}" class="pl-tab${statusFilter === 'archived' ? ' pl-tab-active' : ''}" role="tab">Archived<span class="pl-tab-count">${archivedCount.toLocaleString()}</span></a>
      </div>

      <form method="GET" action="${base}/products" class="pl-search-row">
        <div class="pl-search">
          <svg class="pl-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
          <input type="search" name="q" value="${esc(search)}" placeholder="Search products by name, SKU, vendor…" autocomplete="off">
        </div>
        ${statusFilter !== 'all' ? `<input type="hidden" name="status" value="${esc(statusFilter)}">` : ''}
        ${search ? `<a href="${filterUrl({ status: statusFilter })}" class="pl-clear">Clear</a>` : ''}
      </form>
    </div>

    <!-- BULK ACTION BAR (hidden until selection) -->
    <div class="bulk-bar" id="bulkBar" style="display:none" data-filtered-total="${filteredTotal}" data-per-page="${perPage}">
      <div class="bulk-bar-inner">
        <span class="bulk-count"><span id="bulkCount">0</span> selected</span>
        <form method="POST" action="${base}/products/bulk" id="bulkForm" style="display:flex;gap:8px;align-items:center">
          ${csrfHiddenField(req.csrfToken!)}
          <input type="hidden" name="ids" id="bulkIds">
          <!-- Filter scope: passed through so server can resolve 'ALL'
               against the same filter the user is viewing. The
               source value is one of 'all' | 'manual' | <jobId>,
               mirroring the active site-tab. Without this the
               "Delete all" action would blow away the whole shop
               even when the user is viewing bibliobloom.com. -->
          <input type="hidden" name="status" value="${esc(statusFilter)}">
          <input type="hidden" name="q" value="${esc(search)}">
          <input type="hidden" name="source" value="${esc(source)}">
          <select name="action" class="bulk-select" id="bulkAction">
            <option value="">Actions</option>
            <option value="activate">Set as active</option>
            <option value="draft">Set as draft</option>
            <option value="archive">Archive</option>
            <option value="delete">Delete</option>
            <!-- Phase 2 PR6 — "edit" is intercepted by JS (openBulkEditModal)
                 so the form never POSTs to /products/bulk; the modal's own
                 form submits to /products/bulk/edit instead. The option
                 sits here purely for menu discovery. -->
            <option value="edit">Edit fields…</option>
          </select>
          <button type="submit" class="btn btn-primary btn-sm">Apply</button>
        </form>
        <button type="button" class="btn btn-outline btn-sm" onclick="clearSelection()">Deselect all</button>
        <!-- Select-all-across-pages banner. Toggled by JS when the
             user picks the header checkbox AND filteredTotal > perPage. -->
        <div class="bulk-all-banner" id="bulkAllBanner">
          <span id="bulkAllMsg"></span>
          <button type="button" id="bulkAllToggle" onclick="toggleSelectAllPages()"></button>
        </div>
      </div>
    </div>

    <!-- DELETE CONFIRMATION MODAL (destructive only) -->
    <div class="gbx-modal-overlay" id="deleteModal" onclick="if(event.target===this) closeDeleteModal()">
      <div class="gbx-modal" role="dialog" aria-labelledby="deleteModalTitle" aria-modal="true">
        <h2 class="gbx-modal-title" id="deleteModalTitle">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
          Delete products?
        </h2>
        <p>You are about to permanently delete <strong id="deleteModalCount">0</strong> product<span id="deleteModalPlural">s</span><span id="deleteModalScope"></span>.</p>
        <p class="muted">This will also remove all associated variants, images, and collection memberships. This action cannot be undone.</p>
        <label class="gbx-modal-ack">
          <input type="checkbox" id="deleteAckBox" onchange="document.getElementById('deleteConfirmBtn').disabled = !this.checked">
          <span>I understand this action is permanent and cannot be undone.</span>
        </label>
        <div class="gbx-modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeDeleteModal()">Cancel</button>
          <button type="button" class="btn btn-danger" id="deleteConfirmBtn" disabled onclick="confirmDelete()">Delete products</button>
        </div>
      </div>
    </div>

    <!-- ════════════════════════════════════════════════════════════════
         BULK EDIT MODAL (Phase 2 PR6)
         Tabs: Tags / Pricing / Collections / Status / Custom field
         The modal owns its own <form> that POSTs to /products/bulk/edit.
         Each tab writes a distinct editMode + tab-specific fields; the
         active tab's fields are the only ones the server reads.
    ═════════════════════════════════════════════════════════════════ -->
    <div class="gbx-modal-overlay" id="bulkEditModal" onclick="if(event.target===this) closeBulkEditModal()">
      <form class="gbx-modal gbx-modal-wide" role="dialog" aria-labelledby="bulkEditTitle" aria-modal="true"
            method="POST" id="bulkEditForm" action="${base}/products/bulk/edit">
        ${csrfHiddenField(req.csrfToken!)}
        <input type="hidden" name="ids" id="bulkEditIds">
        <input type="hidden" name="statusFilter" value="${esc(statusFilter)}">
        <input type="hidden" name="q" value="${esc(search)}">
        <input type="hidden" name="source" value="${esc(source)}">
        <input type="hidden" name="editMode" id="bulkEditMode" value="tag_add">
        <h2 class="gbx-modal-title" id="bulkEditTitle">
          Edit <strong id="bulkEditCount">0</strong> product<span id="bulkEditPlural">s</span>
        </h2>
        <nav class="bulk-tabs" role="tablist">
          <button type="button" role="tab" class="bulk-tab active" data-tab="tags">Tags</button>
          <button type="button" role="tab" class="bulk-tab" data-tab="pricing">Pricing</button>
          <button type="button" role="tab" class="bulk-tab" data-tab="collections">Collections</button>
          <button type="button" role="tab" class="bulk-tab" data-tab="status">Status</button>
          <button type="button" role="tab" class="bulk-tab" data-tab="metafield">Custom field</button>
        </nav>

        <!-- TAGS -->
        <div class="bulk-panel" data-panel="tags">
          <label class="bulk-radio-row">
            <input type="radio" name="tagMode" value="tag_add" checked>
            <span>Add tags</span>
          </label>
          <label class="bulk-radio-row">
            <input type="radio" name="tagMode" value="tag_remove">
            <span>Remove tags</span>
          </label>
          <label class="pd-label">Tag list (comma-separated)</label>
          <input type="text" name="tags" class="pd-input pd-input-sm" placeholder="e.g. summer, clearance" autocomplete="off">
          <p class="pd-side-help">Tags are deduplicated across products automatically. Empty tag names are ignored.</p>
        </div>

        <!-- PRICING -->
        <div class="bulk-panel" data-panel="pricing" hidden>
          <label class="bulk-radio-row">
            <input type="radio" name="priceTarget" value="price" checked>
            <span>Price</span>
          </label>
          <label class="bulk-radio-row">
            <input type="radio" name="priceTarget" value="compare">
            <span>Compare-at price</span>
          </label>
          <div class="bulk-inline">
            <select name="adjustType" class="pd-input pd-input-sm">
              <option value="percent">Percent (%)</option>
              <option value="amount">Fixed amount ($)</option>
            </select>
            <input type="number" name="adjustValue" step="0.01" class="pd-input pd-input-sm" placeholder="e.g. 10 or -5">
            <select name="rounding" class="pd-input pd-input-sm">
              <option value="floor" selected>Round down (floor)</option>
              <option value="round">Round nearest</option>
              <option value="ceil">Round up (ceil)</option>
            </select>
          </div>
          <p class="pd-side-help">Negative values reduce the price. Adjustments apply to every variant. Values are clamped at $0 (no negative prices).</p>
        </div>

        <!-- COLLECTIONS -->
        <div class="bulk-panel" data-panel="collections" hidden>
          <label class="bulk-radio-row">
            <input type="radio" name="collMode" value="collection_add" checked>
            <span>Add to collections</span>
          </label>
          <label class="bulk-radio-row">
            <input type="radio" name="collMode" value="collection_remove">
            <span>Remove from collections</span>
          </label>
          <label class="pd-label">Collections</label>
          <select name="collectionIdsMulti" multiple size="6" class="pd-input pd-input-sm" style="min-height:140px">
            ${bulkCollections.map((c: { id: string; title: string }) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}
          </select>
          <input type="hidden" name="collectionIds" id="bulkCollectionIds">
          <p class="pd-side-help">Hold Ctrl/Cmd to select multiple collections. Smart-collection membership is recomputed automatically after save.</p>
        </div>

        <!-- STATUS -->
        <div class="bulk-panel" data-panel="status" hidden>
          <label class="pd-label">Set status to</label>
          <select name="status" class="pd-input pd-input-sm">
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
          <p class="pd-side-help">Same as the one-click actions above, but from the unified edit modal so every bulk change lives in one place.</p>
        </div>

        <!-- METAFIELD -->
        <div class="bulk-panel" data-panel="metafield" hidden>
          <div class="bulk-inline">
            <input type="text" name="mfNamespace" class="pd-input pd-input-sm" placeholder="namespace (e.g. seo)" pattern="[a-zA-Z0-9_-]{3,255}">
            <span class="bulk-dot">.</span>
            <input type="text" name="mfKey" class="pd-input pd-input-sm" placeholder="key (e.g. title)" pattern="[a-zA-Z0-9_-]{3,64}">
          </div>
          <label class="pd-label" style="margin-top:10px">Value</label>
          <textarea name="mfValue" rows="3" class="pd-input pd-input-sm" placeholder="Custom field value"></textarea>
          <label class="pd-label" style="margin-top:10px">Type</label>
          <select name="mfValueType" class="pd-input pd-input-sm">
            <option value="single_line_text_field">Single-line text</option>
            <option value="multi_line_text_field">Multi-line text</option>
            <option value="number_integer">Integer</option>
            <option value="number_decimal">Decimal</option>
            <option value="boolean">Boolean</option>
            <option value="json">JSON</option>
            <option value="url">URL</option>
            <option value="date">Date</option>
            <option value="date_time">Date &amp; time</option>
          </select>
          <p class="pd-side-help">Writes the same (namespace, key, value) metafield on every selected product.</p>
        </div>

        <div class="bulk-preview" id="bulkPreview">
          <strong>Preview:</strong> <span id="bulkPreviewText">This will update <span id="bulkPreviewCount">0</span> products.</span>
        </div>

        <div class="gbx-modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeBulkEditModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" id="bulkEditApply">Apply to selection</button>
        </div>
      </form>
    </div>

    <!-- RENAME SOURCE-TAB MODAL (pencil icon → edit label) -->
    <div class="gbx-modal-overlay" id="renameModal" onclick="if(event.target===this) closeRenameModal()">
      <form class="gbx-modal" role="dialog" aria-labelledby="renameModalTitle" aria-modal="true"
            method="POST" id="renameForm" action="">
        ${csrfHiddenField(req.csrfToken!)}
        <h2 class="gbx-modal-title info" id="renameModalTitle">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2l3 3-8 8-4 1 1-4 8-8z"/></svg>
          Rename source
        </h2>
        <p class="muted">Give this imported site a friendlier label for the tab. Leave blank to reset to the domain name.</p>
        <label class="gbx-field" for="renameInput">Tab label</label>
        <input type="text" name="label" id="renameInput" class="gbx-field-input" maxlength="60" placeholder="e.g. Bibliobloom Tea Shop">
        <div class="gbx-modal-actions">
          <button type="button" class="btn btn-outline" onclick="closeRenameModal()">Cancel</button>
          <button type="submit" class="btn btn-accent">Save</button>
        </div>
      </form>
    </div>

    <!-- PRODUCTS TABLE — merge với toolbar phía trên (border-top:0, radius bottom) -->
    <div class="card" style="border-top:0;border-radius:0 0 12px 12px;margin-bottom:20px">
      <div class="card-body" style="padding:0">
        ${products.length > 0 ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:32px;padding-left:16px"><input type="checkbox" id="selectAll" onchange="toggleAll(this.checked)" class="bulk-check"></th>
                  <th style="width:36%">Product</th>
                  <th>Status</th>
                  <th>Stock</th>
                  <th>Tags</th>
                  <th>Vendor</th>
                  <th style="text-align:right">Price</th>
                  <th style="width:80px"></th>
                </tr>
              </thead>
              <tbody>
                ${products.map((p: any) => {
                  const thumbHtml = p.image_url
                    ? `<img src="${esc(p.image_url)}" alt="" loading="lazy" style="width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)">`
                    : `<div style="width:48px;height:48px;border-radius:8px;background:linear-gradient(135deg,rgba(91,109,255,.08),rgba(91,109,255,.02));border:1px dashed rgba(91,109,255,.25);display:grid;place-items:center;flex-shrink:0;color:rgba(91,109,255,.6);font-size:20px">📦</div>`

                  // Tên category trên cùng product (BE comment Product.cs:151:
                  // "Sản phẩm này nằm trong categories nào" — array nested Category).
                  const cats = Array.isArray(p.categories) ? p.categories.slice(0, 2) : []
                  const catPills = cats.length
                    ? cats.map((n: string) => `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(91,109,255,.12);color:#a3aeff;font-weight:500;letter-spacing:.02em">${esc(n)}</span>`).join('')
                    : ''
                  const moreCats = (p.categories?.length ?? 0) > 2
                    ? `<span style="font-size:10px;color:var(--s-text-muted)">+${p.categories.length - 2}</span>`
                    : ''
                  const metaRow = (cats.length || moreCats)
                    ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:5px;align-items:center">${catPills}${moreCats}</div>`
                    : ''

                  // Tags pills — phân biệt với categories (màu xám trung tính).
                  const tags = Array.isArray(p.tags) ? p.tags.slice(0, 3) : []
                  const tagsHtml = tags.length
                    ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${tags.map((t: string) => `<span style="font-size:10.5px;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.05);color:var(--s-text-muted)">${esc(t)}</span>`).join('')}${(p.tags.length > 3) ? `<span style="font-size:10px;color:var(--s-text-muted);align-self:center">+${p.tags.length - 3}</span>` : ''}</div>`
                    : `<span style="color:var(--s-text-muted);font-size:12px">—</span>`

                  // Inventory: dot màu (đỏ khi 0, vàng khi <10, xanh OK).
                  const stock = Number(p.total_inventory ?? 0)
                  const stockColor = stock <= 0 ? 'var(--s-danger,#f87171)' : stock < 10 ? '#facc15' : '#4ade80'
                  const stockText = stock <= 0 ? 'Out of stock' : `${stock.toLocaleString()} in stock`
                  const stockHtml = `<span style="display:inline-flex;align-items:center;gap:6px;font-size:13px"><span style="width:7px;height:7px;border-radius:50%;background:${stockColor};display:inline-block"></span>${stockText}</span>`

                  return `
                  <tr class="product-row" data-id="${esc(p.id)}">
                    <td style="padding-left:16px"><input type="checkbox" class="bulk-check row-check" value="${esc(p.id)}" onchange="updateBulk()"></td>
                    <td>
                      <div style="display:flex;gap:12px;align-items:flex-start">
                        ${thumbHtml}
                        <div style="min-width:0;flex:1">
                          <a href="${base}/products/${esc(p.id)}" style="color:var(--s-text,#e8eaf0);text-decoration:none;font-weight:600;font-size:14px;display:block;line-height:1.35">${esc(p.title)}</a>
                          <div style="font-size:11.5px;color:var(--s-text-muted);margin-top:3px;display:flex;gap:8px;align-items:center">
                            <span>${Number(p.variant_count)} variant${Number(p.variant_count) !== 1 ? 's' : ''}</span>
                            ${p.slug ? `<span style="opacity:.5">•</span><span style="font-family:ui-monospace,Menlo,monospace;font-size:11px">${esc(p.slug)}</span>` : ''}
                          </div>
                          ${metaRow}
                        </div>
                      </div>
                    </td>
                    <td>${statusBadge(p.status)}</td>
                    <td>${stockHtml}</td>
                    <td>${tagsHtml}</td>
                    <td style="color:var(--s-text-muted);font-size:13px">${esc(p.vendor || '—')}</td>
                    <td style="text-align:right;font-weight:600;font-size:14px">${priceRange(p.min_price, p.max_price)}</td>
                    <td style="text-align:right;padding-right:16px;width:100px">
                      <a href="${base}/products/${esc(p.id)}" title="View & edit" style="display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:6px;color:var(--s-text-muted);text-decoration:none;font-size:13px;transition:.15s" onmouseover="this.style.background='rgba(255,255,255,.06)';this.style.color='var(--s-text,#fff)'" onmouseout="this.style.background='';this.style.color='var(--s-text-muted)'">Edit</a>
                    </td>
                  </tr>
                `}).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div style="text-align:center;padding:60px 20px;color:var(--s-text-muted)">
            <svg width="48" height="48" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1" style="margin:0 auto 16px;display:block;opacity:.4"><path d="M7 2l3 3 3-3M4 5h12l-1 12H5L4 5z"/></svg>
            <h3 style="font-size:16px;font-weight:600;color:var(--s-text);margin-bottom:8px">${search ? 'No products found' : 'No products yet'}</h3>
            <p style="font-size:13px;margin-bottom:16px">${search ? 'Try adjusting your search or filters.' : 'Start by adding your first product to the store.'}</p>
            ${!search ? `<a href="${base}/products/new" class="btn btn-primary">Add product</a>` : ''}
          </div>
        `}
      </div>
    </div>

    <style>
      /* -------------------------------------------------------------
       * Bulk action bar
       *
       * The bar's background is an indigo accent (same in both light
       * and dark theme), so the "inside" elements are styled against
       * indigo — white-ish pills & tokens that read well on the
       * accent colour regardless of which theme is active.
       *
       * Historical bug: the old styles only set color:#fff on the
       * select element, which inherits to option children. In light
       * mode browsers the native dropdown popup paints itself white,
       * so white text on white = invisible options. Fixed by
       * explicitly restoring dark-on-white colours on option so the
       * expanded popup is readable in any OS theme.
       * ----------------------------------------------------------- */
      .bulk-bar {
        position:sticky; top:0; z-index:50; margin-bottom:12px;
        background:var(--s-accent); border-radius:10px; padding:10px 16px;
        animation:slideDown .2s ease;
        box-shadow:0 2px 8px rgba(99,102,241,.18);
      }
      @keyframes slideDown { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
      .bulk-bar-inner {
        display:flex; align-items:center; gap:12px; flex-wrap:wrap;
      }
      .bulk-count { color:#fff; font-size:13px; font-weight:600; }
      .bulk-count strong { font-weight:700; }
      .bulk-select {
        padding:6px 28px 6px 10px; border-radius:6px; font-size:12px;
        border:1px solid rgba(255,255,255,.45);
        background:rgba(255,255,255,.15);
        color:#fff; cursor:pointer;
        -webkit-appearance:none; appearance:none;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10' fill='none' stroke='%23fff' stroke-width='1.5'%3E%3Cpath d='M2 4l3 3 3-3'/%3E%3C/svg%3E");
        background-repeat:no-repeat; background-position:right 8px center;
      }
      .bulk-select option {
        /* Explicit dark-on-white so the OS-rendered popup stays
         * readable in both light and dark browser themes. */
        color:#111827; background:#fff;
      }
      .bulk-bar .btn-primary {
        background:#fff; color:var(--s-accent); border:1px solid #fff;
        font-weight:600;
      }
      .bulk-bar .btn-primary:hover { background:rgba(255,255,255,.9); }
      .bulk-bar .btn-outline {
        color:#fff; border:1px solid rgba(255,255,255,.45);
        background:transparent;
      }
      .bulk-bar .btn-outline:hover { background:rgba(255,255,255,.12); }
      .bulk-check { width:16px; height:16px; cursor:pointer; accent-color:var(--s-accent); }
      .product-row.selected { background:rgba(99,102,241,.06); }
      /* "Select all 138 across all pages" banner. Lives inside the
       * bulk-bar, full width, shown only when filteredTotal > perPage. */
      .bulk-all-banner {
        flex-basis:100%;
        font-size:12px; color:rgba(255,255,255,.92);
        padding:6px 2px 2px;
        border-top:1px dashed rgba(255,255,255,.25);
        margin-top:2px;
        display:none;
      }
      .bulk-all-banner.show { display:flex; align-items:center; gap:8px; }
      .bulk-all-banner button {
        background:transparent; border:none; color:#fff;
        text-decoration:underline; font-weight:600; cursor:pointer;
        padding:0; font-size:12px;
      }
      .bulk-all-banner button:hover { opacity:.85; }

      /* -------------------------------------------------------------
       * Delete-all confirmation modal (destructive, requires explicit
       * acknowledgement checkbox). English-only copy per product spec.
       * ----------------------------------------------------------- */
      .gbx-modal-overlay {
        position:fixed; inset:0; background:rgba(0,0,0,.55);
        z-index:9999; display:none; align-items:center; justify-content:center;
        animation:modalFade .15s ease;
      }
      .gbx-modal-overlay.show { display:flex; }
      @keyframes modalFade { from { opacity:0; } to { opacity:1; } }
      .gbx-modal {
        background:var(--s-card); color:var(--s-text);
        border:1px solid var(--s-border);
        border-radius:12px; padding:24px; max-width:480px; width:92%;
        box-shadow:0 20px 48px rgba(0,0,0,.3);
        animation:modalSlide .18s ease;
      }
      @keyframes modalSlide { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
      .gbx-modal-title {
        display:flex; align-items:center; gap:10px;
        font-size:17px; font-weight:700; margin:0 0 12px;
        color:var(--s-danger, #dc2626);
      }
      .gbx-modal-title svg { flex-shrink:0; }
      .gbx-modal p { margin:0 0 10px; font-size:14px; line-height:1.55; }
      .gbx-modal .muted { color:var(--s-text-muted); font-size:13px; }
      .gbx-modal-ack {
        display:flex; align-items:flex-start; gap:10px;
        padding:12px; margin:14px 0 4px;
        background:color-mix(in srgb, var(--s-danger, #dc2626) 8%, transparent);
        border:1px solid color-mix(in srgb, var(--s-danger, #dc2626) 24%, transparent);
        border-radius:8px;
        font-size:13px; font-weight:500;
        cursor:pointer; user-select:none;
      }
      .gbx-modal-ack input[type=checkbox] {
        margin-top:2px; width:16px; height:16px;
        accent-color:var(--s-danger, #dc2626);
      }
      .gbx-modal-actions {
        display:flex; gap:8px; justify-content:flex-end; margin-top:16px;
      }
      .gbx-modal .btn-danger {
        background:var(--s-danger, #dc2626); color:#fff;
        border:1px solid var(--s-danger, #dc2626); font-weight:600;
      }
      .gbx-modal .btn-danger:disabled {
        opacity:.45; cursor:not-allowed;
      }
      .gbx-modal .btn-danger:not(:disabled):hover {
        filter:brightness(.95);
      }

      /* -------------------------------------------------------------
       * Bulk Edit modal — Phase 2 PR6
       * ----------------------------------------------------------- */
      .gbx-modal-wide { max-width:640px; }
      .bulk-tabs {
        display:flex; gap:2px; margin:12px -4px 14px;
        border-bottom:1px solid var(--s-border, #e5e7eb);
      }
      .bulk-tab {
        padding:8px 14px; background:transparent; border:0;
        color:var(--s-text-muted, #6b7280); font-weight:600; font-size:13px;
        cursor:pointer; border-bottom:2px solid transparent;
        margin-bottom:-1px; border-radius:6px 6px 0 0;
      }
      .bulk-tab:hover { color:var(--s-text, #111); background:rgba(99,102,241,.05); }
      .bulk-tab.active {
        color:var(--s-accent, #6366f1);
        border-bottom-color:var(--s-accent, #6366f1);
      }
      .bulk-panel { padding:4px 0; min-height:180px; }
      .bulk-radio-row {
        display:flex; align-items:center; gap:8px;
        padding:6px 0; font-size:13px; cursor:pointer;
      }
      .bulk-inline {
        display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px;
      }
      .bulk-inline .pd-input-sm { flex:1 1 auto; min-width:120px; }
      .bulk-dot { color:var(--s-text-muted); font-weight:700; }
      .bulk-preview {
        margin-top:14px; padding:10px 12px;
        background:color-mix(in srgb, var(--s-accent, #6366f1) 6%, transparent);
        border:1px solid color-mix(in srgb, var(--s-accent, #6366f1) 20%, transparent);
        border-radius:8px;
        font-size:13px;
      }

      /* Source tabs — My products vs Lenful POD catalog */
      .source-tabs {
        display:flex; gap:4px; margin:0 0 20px;
        border-bottom:1px solid var(--border, #e5e7eb); padding-bottom:0;
      }
      .source-tab {
        display:inline-flex; align-items:center; gap:8px;
        padding:10px 18px; border-radius:8px 8px 0 0;
        font-size:14px; font-weight:600;
        color:var(--s-text-muted, #6b7280); text-decoration:none;
        border:1px solid transparent; border-bottom:none;
        margin-bottom:-1px;
        transition:background .12s, color .12s;
      }
      .source-tab:hover { color:var(--s-text, #111); background:rgba(99,102,241,.05); }
      .source-tab.active {
        color:var(--s-accent, #6366f1);
        background:var(--s-card, #fff);
        border-color:var(--border, #e5e7eb);
        border-bottom:1px solid var(--s-card, #fff);
      }
      .source-tab svg { opacity:.75; }
      .source-tab.active svg { opacity:1; }
      .source-tab-pill {
        display:inline-block; padding:1px 8px; border-radius:10px;
        background:linear-gradient(135deg,#8b5cf6,#6366f1); color:#fff;
        font-size:10px; font-weight:700; letter-spacing:.4px;
      }

      /* -------------------------------------------------------------
       * PHASE 2 — Source-site tab strip (.site-tabs).
       *
       * Sits between the top-level source tabs (My products vs Lenful)
       * and the stats / search / status tabs. Each tab represents one
       * clone source (bibliobloom.com, shopify.com, etc) plus two
       * synthetic tabs: "All" and "Manual".
       *
       * The active tab gets a subtle indigo chip; hover shows the
       * pencil-edit button on clone-source tabs (hidden by default
       * so the default view stays calm). The More ▼ overflow is a
       * position:absolute dropdown aligned right-of-button.
       * ----------------------------------------------------------- */
      .site-tabs {
        display:flex; flex-wrap:wrap; gap:6px;
        margin:-8px 0 20px; padding:4px 0;
        align-items:center;
      }
      .site-tab {
        display:inline-flex; align-items:center; gap:6px;
        padding:6px 12px; border-radius:999px;
        font-size:12px; font-weight:600; line-height:1;
        color:var(--s-text-muted, #6b7280); text-decoration:none;
        border:1px solid var(--border, #e5e7eb);
        background:var(--s-card, #fff);
        transition:background .12s, color .12s, border-color .12s;
        position:relative;
        cursor:pointer;
      }
      .site-tab:hover {
        color:var(--s-text, #111);
        background:color-mix(in srgb, var(--s-accent, #6366f1) 8%, transparent);
        border-color:color-mix(in srgb, var(--s-accent, #6366f1) 30%, var(--border, #e5e7eb));
      }
      .site-tab.active {
        color:#fff;
        background:var(--s-accent, #6366f1);
        border-color:var(--s-accent, #6366f1);
      }
      .site-tab.active .site-tab-count {
        background:rgba(255,255,255,.22); color:#fff;
      }
      .site-tab-count {
        display:inline-block; padding:1px 7px; border-radius:8px;
        font-size:11px; font-weight:700; line-height:1.4;
        background:var(--s-surface-2, rgba(0,0,0,.05));
        color:var(--s-text-muted, #6b7280);
      }
      .site-tab-dot {
        display:inline-block; width:6px; height:6px; border-radius:50%;
        background:var(--s-accent, #6366f1); opacity:.6;
      }
      .site-tab.active .site-tab-dot { background:#fff; opacity:1; }
      .site-tab-edit {
        display:inline-flex; align-items:center; justify-content:center;
        background:transparent; border:none; color:inherit;
        padding:2px; margin-left:2px; border-radius:4px;
        cursor:pointer; opacity:0;
        transition:opacity .12s, background .12s;
      }
      .site-tab:hover .site-tab-edit,
      .site-tab.active .site-tab-edit {
        opacity:.75;
      }
      .site-tab-edit:hover {
        opacity:1 !important;
        background:color-mix(in srgb, currentColor 18%, transparent);
      }
      /* "More ▼" overflow dropdown */
      .site-tab-more { position:relative; }
      .site-tab-more-btn {
        /* Same pill styling as .site-tab for consistency */
        display:inline-flex; align-items:center; gap:4px;
        padding:6px 10px; border-radius:999px;
        font-size:12px; font-weight:600;
        color:var(--s-text-muted, #6b7280);
        border:1px solid var(--border, #e5e7eb);
        background:var(--s-card, #fff);
        cursor:pointer;
      }
      .site-tab-more-btn:hover {
        color:var(--s-text, #111);
        background:color-mix(in srgb, var(--s-accent, #6366f1) 8%, transparent);
      }
      .site-tab-more-menu {
        display:none;
        position:absolute; top:calc(100% + 4px); right:0; z-index:30;
        min-width:220px; padding:6px;
        background:var(--s-card, #fff);
        border:1px solid var(--border, #e5e7eb);
        border-radius:10px;
        box-shadow:0 8px 24px rgba(0,0,0,.12);
      }
      .site-tab-more.open .site-tab-more-menu { display:block; }
      .site-tab-more-item {
        display:flex; align-items:center; gap:8px;
        padding:8px 10px; border-radius:6px;
        font-size:13px; font-weight:500; text-decoration:none;
        color:var(--s-text, #111);
        position:relative;
      }
      .site-tab-more-item:hover {
        background:color-mix(in srgb, var(--s-accent, #6366f1) 10%, transparent);
      }
      .site-tab-more-item.active {
        background:color-mix(in srgb, var(--s-accent, #6366f1) 16%, transparent);
        color:var(--s-accent, #6366f1);
      }
      .site-tab-more-item .site-tab-count { margin-left:auto; }
      .site-tab-more-item .site-tab-edit { opacity:.5; }
      .site-tab-more-item:hover .site-tab-edit { opacity:1; }

      /* -------------------------------------------------------------
       * Rename-source modal (pencil icon → edit tab label).
       * Reuses the .gbx-modal-overlay / .gbx-modal chrome from the
       * delete-confirm modal above so visual language stays consistent.
       * ----------------------------------------------------------- */
      .gbx-modal .gbx-modal-title.info { color:var(--s-accent, #6366f1); }
      .gbx-modal label.gbx-field {
        display:block; font-size:12px; font-weight:600;
        color:var(--s-text-muted, #6b7280); margin:12px 0 6px;
      }
      .gbx-modal input[type=text].gbx-field-input {
        width:100%; padding:10px 12px; font-size:14px;
        border:1px solid var(--border, #e5e7eb); border-radius:8px;
        background:var(--s-surface, #fff); color:var(--s-text, #111);
        outline:none;
      }
      .gbx-modal input[type=text].gbx-field-input:focus {
        border-color:var(--s-accent, #6366f1);
        box-shadow:0 0 0 3px color-mix(in srgb, var(--s-accent, #6366f1) 18%, transparent);
      }
      .gbx-modal .btn-accent {
        background:var(--s-accent, #6366f1); color:#fff;
        border:1px solid var(--s-accent, #6366f1); font-weight:600;
      }
      .gbx-modal .btn-accent:hover { filter:brightness(.95); }

      /* -------------------------------------------------------------
       * Flash banners (success / error) driven by ?success= / ?error=
       * query params from redirect responses. Colored bar at the top
       * of the page; auto-fades after 4s via the JS below.
       * ----------------------------------------------------------- */
      .gbx-flash {
        display:flex; align-items:center; gap:8px;
        padding:10px 14px; margin:0 0 16px; border-radius:8px;
        font-size:13px; font-weight:500; line-height:1.4;
        animation:flashIn .2s ease;
      }
      @keyframes flashIn { from { opacity:0; transform:translateY(-4px);} to { opacity:1; transform:translateY(0);} }
      .gbx-flash-success {
        color:#065f46;
        background:#d1fae5;
        border:1px solid #a7f3d0;
      }
      [data-theme="dark"] .gbx-flash-success {
        color:#a7f3d0;
        background:rgba(34,197,94,.12);
        border-color:rgba(34,197,94,.3);
      }
      .gbx-flash-error {
        color:#991b1b;
        background:#fee2e2;
        border:1px solid #fecaca;
      }
      [data-theme="dark"] .gbx-flash-error {
        color:#fecaca;
        background:rgba(239,68,68,.12);
        border-color:rgba(239,68,68,.3);
      }
    </style>

    <script>
    /* ---------------------------------------------------------------
     * Bulk selection state machine.
     *
     * Two selection modes:
     *   - 'page'  (default): ids = comma-separated UUIDs from visible
     *                         row checkboxes. Count = checkboxes checked.
     *   - 'all'   (escalation): ids = 'ALL'. Count = filteredTotal (from
     *                         data-filtered-total on .bulk-bar). Server
     *                         resolves against current filter.
     *
     * The "Select all N across all pages" banner only shows when the
     * user has selected every visible row AND filteredTotal > perPage
     * (i.e. there's something to escalate to).
     * ------------------------------------------------------------- */
    var bulkMode = 'page'; // 'page' | 'all'

    function bulkMeta() {
      var bar = document.getElementById('bulkBar');
      return {
        total: parseInt(bar.getAttribute('data-filtered-total') || '0', 10),
        perPage: parseInt(bar.getAttribute('data-per-page') || '20', 10),
      };
    }

    function toggleAll(checked) {
      document.querySelectorAll('.row-check').forEach(function(cb){
        cb.checked = checked;
        cb.closest('tr').classList.toggle('selected', checked);
      });
      // Toggling the header checkbox always returns us to 'page' mode;
      // the user opts into 'all' mode explicitly via the banner link.
      bulkMode = 'page';
      updateBulk();
    }

    function updateBulk() {
      var checks = Array.prototype.slice.call(document.querySelectorAll('.row-check:checked'));
      var bar = document.getElementById('bulkBar');
      var count = document.getElementById('bulkCount');
      var ids = document.getElementById('bulkIds');
      var banner = document.getElementById('bulkAllBanner');
      var bannerMsg = document.getElementById('bulkAllMsg');
      var bannerToggle = document.getElementById('bulkAllToggle');
      var selectAll = document.getElementById('selectAll');
      var meta = bulkMeta();
      var allRows = document.querySelectorAll('.row-check');
      var allChecked = checks.length === allRows.length && checks.length > 0;

      if (checks.length === 0) {
        bar.style.display = 'none';
        banner.classList.remove('show');
        bulkMode = 'page';
        if (selectAll) selectAll.checked = false;
        return;
      }

      bar.style.display = 'block';
      if (selectAll) selectAll.checked = allChecked;

      // Row styling follows checkbox state regardless of mode.
      allRows.forEach(function(cb){
        cb.closest('tr').classList.toggle('selected', cb.checked);
      });

      if (bulkMode === 'all') {
        // Escalated: all filtered products across every page.
        count.textContent = meta.total;
        ids.value = 'ALL';
        bannerMsg.textContent = 'All ' + meta.total + ' products matching your current filter are selected.';
        bannerToggle.textContent = 'Select only this page';
        banner.classList.add('show');
      } else {
        // Standard: only the checkboxes visible on this page.
        count.textContent = checks.length;
        ids.value = checks.map(function(c){ return c.value; }).join(',');
        // Offer escalation only when the user has all visible rows
        // checked AND there are more products off-page.
        if (allChecked && meta.total > meta.perPage) {
          bannerMsg.textContent = checks.length + ' on this page are selected.';
          bannerToggle.textContent = 'Select all ' + meta.total + ' products matching this filter';
          banner.classList.add('show');
        } else {
          banner.classList.remove('show');
        }
      }
    }

    function toggleSelectAllPages() {
      if (bulkMode === 'all') {
        // Revert to 'page' mode — keep the current page's checkboxes
        // checked but stop including off-page rows.
        bulkMode = 'page';
      } else {
        bulkMode = 'all';
      }
      updateBulk();
    }

    function clearSelection() {
      document.querySelectorAll('.row-check').forEach(function(cb){
        cb.checked = false;
        cb.closest('tr').classList.remove('selected');
      });
      var selectAll = document.getElementById('selectAll');
      if (selectAll) selectAll.checked = false;
      bulkMode = 'page';
      document.getElementById('bulkBar').style.display = 'none';
      document.getElementById('bulkAllBanner').classList.remove('show');
    }

    /* ---------------------------------------------------------------
     * Delete confirmation modal.
     *
     * Intercepts the bulk form submit. For non-destructive actions
     * (activate/draft/archive) we submit immediately — they're
     * reversible. For 'delete' we require the user to tick the
     * "I understand" checkbox before the Delete button activates.
     * ------------------------------------------------------------- */
    (function(){
      var form = document.getElementById('bulkForm');
      if (!form) return;
      form.addEventListener('submit', function(e){
        var action = document.getElementById('bulkAction').value;
        if (action === '') {
          e.preventDefault();
          alert('Please choose a bulk action.');
          return;
        }
        if (action === 'edit') {
          // Phase 2 PR6 — hijack the form submit and open the bulk
          // edit modal instead. The modal owns its own form with a
          // dedicated action URL, so nothing further happens here.
          e.preventDefault();
          openBulkEditModal();
          return;
        }
        if (action !== 'delete') return; // non-destructive → submit
        e.preventDefault();
        openDeleteModal();
      });
    })();

    /* ---------------------------------------------------------------
     * Bulk edit modal — Phase 2 PR6
     *
     * openBulkEditModal() is called when the bulk action select is
     * set to "edit" and the Apply button is clicked. It:
     *   1. Copies the current selection ids from bulkIds hidden
     *      input to bulkEditIds (same ALL convention for scope).
     *   2. Shows the modal and activates the Tags tab by default.
     *
     * Tab clicks swap the visible panel and rewrite the hidden
     * editMode field to match the tab + its radio (tag_add vs
     * tag_remove, price_adjust vs compare_adjust, etc.).
     * ------------------------------------------------------------- */
    function openBulkEditModal() {
      var ids = document.getElementById('bulkIds').value;
      if (!ids) { alert('No products selected.'); return; }
      var meta = bulkMeta();
      var count = ids === 'ALL'
        ? meta.total
        : ids.split(',').filter(function(s){ return s; }).length;
      if (count <= 0) return;
      document.getElementById('bulkEditIds').value = ids;
      document.getElementById('bulkEditCount').textContent = count;
      document.getElementById('bulkEditPlural').textContent = count === 1 ? '' : 's';
      document.getElementById('bulkPreviewCount').textContent = count;
      // Reset to Tags tab
      switchBulkTab('tags');
      document.getElementById('bulkEditModal').classList.add('show');
    }

    function closeBulkEditModal() {
      document.getElementById('bulkEditModal').classList.remove('show');
    }

    /**
     * Swap the visible bulk-edit panel + keep the hidden editMode
     * hidden input in sync with the tab + its active sub-option.
     */
    function switchBulkTab(name) {
      var tabs = document.querySelectorAll('.bulk-tab');
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        t.classList.toggle('active', t.getAttribute('data-tab') === name);
      }
      var panels = document.querySelectorAll('.bulk-panel');
      for (var j = 0; j < panels.length; j++) {
        var p = panels[j];
        p.hidden = p.getAttribute('data-panel') !== name;
      }
      // Derive editMode from the active tab
      var modeInput = document.getElementById('bulkEditMode');
      if (name === 'tags') {
        var tagR = document.querySelector('input[name="tagMode"]:checked');
        modeInput.value = tagR ? tagR.value : 'tag_add';
      } else if (name === 'pricing') {
        var prR = document.querySelector('input[name="priceTarget"]:checked');
        modeInput.value = prR && prR.value === 'compare' ? 'compare_adjust' : 'price_adjust';
      } else if (name === 'collections') {
        var cR = document.querySelector('input[name="collMode"]:checked');
        modeInput.value = cR ? cR.value : 'collection_add';
      } else if (name === 'status') {
        modeInput.value = 'status_set';
      } else if (name === 'metafield') {
        modeInput.value = 'metafield_set';
      }
    }

    /* Tab click delegation + radio-driven editMode sync. Wired in an
     * IIFE so we can listen once on the modal and cover all tabs +
     * sub-options without attaching per-element handlers. */
    (function(){
      var modal = document.getElementById('bulkEditModal');
      if (!modal) return;
      modal.addEventListener('click', function(e){
        var tab = e.target.closest && e.target.closest('.bulk-tab');
        if (tab) { switchBulkTab(tab.getAttribute('data-tab')); return; }
      });
      modal.addEventListener('change', function(e){
        if (!e.target) return;
        var name = e.target.getAttribute('name');
        if (name === 'tagMode' || name === 'priceTarget' || name === 'collMode') {
          var active = document.querySelector('.bulk-tab.active');
          if (active) switchBulkTab(active.getAttribute('data-tab'));
        }
      });
      // Before submit: pack the multi-select into comma-separated hidden input.
      var form = document.getElementById('bulkEditForm');
      if (form) {
        form.addEventListener('submit', function(){
          var multi = form.querySelector('select[name="collectionIdsMulti"]');
          if (multi) {
            var vals = [];
            for (var i = 0; i < multi.options.length; i++) {
              if (multi.options[i].selected) vals.push(multi.options[i].value);
            }
            document.getElementById('bulkCollectionIds').value = vals.join(',');
          }
        });
      }
    })();

    function openDeleteModal() {
      var count;
      var scope = '';
      var ids = document.getElementById('bulkIds').value;
      var meta = bulkMeta();
      if (ids === 'ALL') {
        count = meta.total;
        scope = ' matching your current filter';
      } else {
        count = ids.split(',').filter(function(s){ return s; }).length;
      }
      if (count <= 0) return;
      document.getElementById('deleteModalCount').textContent = count;
      document.getElementById('deleteModalPlural').textContent = count === 1 ? '' : 's';
      document.getElementById('deleteModalScope').textContent = scope;
      document.getElementById('deleteAckBox').checked = false;
      document.getElementById('deleteConfirmBtn').disabled = true;
      document.getElementById('deleteModal').classList.add('show');
    }

    function closeDeleteModal() {
      document.getElementById('deleteModal').classList.remove('show');
    }

    function confirmDelete() {
      document.getElementById('deleteModal').classList.remove('show');
      document.getElementById('bulkForm').submit();
    }

    /* ---------------------------------------------------------------
     * Rename-source modal (pencil icon on each site-tab).
     *
     * openRenameModal(jobId, currentLabel) pre-fills the text input
     * with the current label and sets the form action to the
     * per-job rename endpoint. The server redirects back with
     * ?success=... on save so the tab rerenders with the new name.
     * ------------------------------------------------------------- */
    function openRenameModalFrom(btn) {
      openRenameModal(
        btn.getAttribute('data-source-id') || '',
        btn.getAttribute('data-source-label') || '',
      );
    }
    function openRenameModal(jobId, currentLabel) {
      var modal = document.getElementById('renameModal');
      if (!modal) return;
      var form = document.getElementById('renameForm');
      var input = document.getElementById('renameInput');
      form.action = ${JSON.stringify(base + '/clone-pro/')} + encodeURIComponent(jobId) + '/rename';
      input.value = currentLabel || '';
      modal.classList.add('show');
      // Defer focus to after the animation or the browser refuses to focus
      // while the element is still display:none.
      setTimeout(function(){ input.focus(); input.select(); }, 60);
    }
    function closeRenameModal() {
      document.getElementById('renameModal').classList.remove('show');
    }

    /* ---------------------------------------------------------------
     * More ▼ overflow dropdown for site-tabs.
     * ------------------------------------------------------------- */
    function toggleSiteTabMore(btn) {
      var wrap = btn.closest('.site-tab-more');
      if (!wrap) return;
      var isOpen = wrap.classList.toggle('open');
      btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
    /* Click outside to close More menu */
    document.addEventListener('click', function(e){
      var openMenu = document.querySelector('.site-tab-more.open');
      if (!openMenu) return;
      if (!openMenu.contains(e.target)) {
        openMenu.classList.remove('open');
        var btn = openMenu.querySelector('.site-tab-more-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    });

    /* Esc key closes open modals / overflow menu */
    document.addEventListener('keydown', function(e){
      if (e.key !== 'Escape') return;
      closeDeleteModal();
      closeRenameModal();
      var openMenu = document.querySelector('.site-tab-more.open');
      if (openMenu) openMenu.classList.remove('open');
    });
    </script>

    <!-- PAGINATION -->
    ${totalPages > 1 ? `
    <div style="display:flex;justify-content:center;align-items:center;gap:8px;margin-top:20px">
      ${page > 1 ? `<a href="${filterUrl({ q: search, status: statusFilter, page: String(page - 1) })}" class="btn btn-outline btn-sm">&laquo; Previous</a>` : `<span class="btn btn-outline btn-sm" style="opacity:.4;cursor:default">&laquo; Previous</span>`}
      <span style="font-size:13px;color:var(--text-secondary);padding:0 12px">Page ${page} of ${totalPages}</span>
      ${page < totalPages ? `<a href="${filterUrl({ q: search, status: statusFilter, page: String(page + 1) })}" class="btn btn-outline btn-sm">Next &raquo;</a>` : `<span class="btn btn-outline btn-sm" style="opacity:.4;cursor:default">Next &raquo;</span>`}
    </div>
    ` : ''}
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Products',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'products',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// Lenful catalog tab — renders the "Lenful products" grid for one-click import
// ---------------------------------------------------------------------------
//
// Sits under the same /products route behind ?source=lenful. Shows a 4-col
// grid of cards built from the `lenful_catalog` cache (populated via cron /
// "Sync now" button). Each card has a one-click "Add to my store" form that
// POSTs to /products/lenful/import and creates a brand-new draft Gbox product
// (with full multi-variant replay) the seller can then edit.
//
// IMPORTANT: no "already added" disable — sellers can import the same Lenful
// product repeatedly with different designs, so the button always works.

async function renderLenfulCatalogTab(
  req: Request,
  res: Response,
): Promise<void> {
  const db = null as any
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const perPage = 48
  const search = ((req.query.q as string) || '').trim()
  const categoryFilter = ((req.query.cat as string) || '').trim() || undefined

  // // API-MODE: Fetch from Lenful Catalog API
  const catalog: any[] = []
  const total = 0
  const totalPages = Math.ceil(total / perPage) || 1
  const categories: any[] = []
  const lastSynced = null

  function catalogUrl(params: Record<string, string>): string {

    const p = new URLSearchParams()
    p.set('source', 'lenful')
    if (params.q) p.set('q', params.q)
    if (params.cat) p.set('cat', params.cat)
    if (params.page && params.page !== '1') p.set('page', params.page)
    return `${base}/products?${p.toString()}`
  }

  function formatPrice(p: string | null, currency: string): string {
    if (p == null || p === '') return '—'
    const n = Number(p)
    if (Number.isNaN(n)) return '—'
    if (currency === 'USD') return `$${n.toFixed(2)}`
    return `${n.toFixed(2)} ${currency}`
  }

  function humanAge(iso: string | null): string {
    if (!iso) return 'never'
    const ms = Date.now() - new Date(iso).getTime()
    if (ms < 0) return 'just now'
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    return `${d}d ago`
  }

  const catPills = categories
    .map((c) => {
      const isActive = categoryFilter === c.slug
      return `<a href="${catalogUrl({ q: search, cat: isActive ? '' : c.slug })}" class="lf-pill ${isActive ? 'active' : ''}">${esc(c.name)} <span>${c.count}</span></a>`
    })
    .join('')

  // Flash banner for the /products/lenful/import redirect — shows push
  // result without a full page-load of error detail pages. See the
  // handler in postProductImportFromLenful for the query shape.
  const pushed = typeof req.query.pushed === 'string' ? req.query.pushed : ''
  const pushError = typeof req.query.error === 'string' ? req.query.error : ''
  const pushErrorMsg = typeof req.query.error_msg === 'string' ? req.query.error_msg : ''
  const legacyIdOut = typeof req.query.legacy_id === 'string' ? req.query.legacy_id : ''
  let flashBanner = ''
  if (pushed === '1') {
    flashBanner = `
      <div style="display:flex;gap:12px;align-items:center;padding:12px 16px;margin-bottom:14px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.25);border-radius:10px;font-size:13px;color:#065f46">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        <div style="flex:1">
          <strong>Pushed to Gbox master shop.</strong>
          ${legacyIdOut ? `Legacy product id <code style="font-family:ui-monospace,Menlo,monospace">${esc(legacyIdOut)}</code>.` : ''}
        </div>
      </div>`
  } else if (pushError === 'no_master_config') {
    // Iron Rule 5: never surface god-admin paths to sellers. The misconfig is
    // a platform-level issue; sellers should be told to contact Gbox support,
    // not pointed at an internal admin route they cannot access.
    flashBanner = `
      <div style="display:flex;gap:12px;align-items:center;padding:12px 16px;margin-bottom:14px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:10px;font-size:13px;color:#78350f">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div style="flex:1">
          <strong>Product push is not available yet.</strong>
          Gbox fulfillment integration is still being set up for your store.
          Please <a href="mailto:support@gbox.co" style="color:#b45309;text-decoration:underline">contact Gbox support</a>
          and we will enable it for you.
        </div>
      </div>`
  } else if (pushError && pushError !== 'missing_id' && pushError !== 'not_found') {
    // Iron Rule 5: do NOT reference any internal diagnostic surface (push log,
    // admin console, /god-admin/*). The diagnostic detail is in pushErrorMsg
    // if present; otherwise we nudge the seller to support.
    flashBanner = `
      <div style="display:flex;gap:12px;align-items:center;padding:12px 16px;margin-bottom:14px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:10px;font-size:13px;color:#7f1d1d">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        <div style="flex:1">
          <strong>Push failed (${esc(pushError)}).</strong>
          ${pushErrorMsg ? esc(pushErrorMsg) : 'If this keeps happening, please <a href="mailto:support@gbox.co" style="color:#991b1b;text-decoration:underline">contact Gbox support</a>.'}
        </div>
      </div>`
  }

  const gridHtml = catalog.length === 0
    ? `
        <div style="text-align:center;padding:80px 20px;color:var(--s-text-muted, #6b7280)">
          <svg width="56" height="56" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1" style="margin:0 auto 16px;display:block;opacity:.35"><circle cx="10" cy="10" r="7"/><path d="M10 5v5l3 2"/></svg>
          <h3 style="font-size:16px;font-weight:600;color:var(--s-text);margin-bottom:8px">No Lenful products ${search ? 'match your search' : 'cached yet'}</h3>
          <p style="font-size:13px;margin-bottom:16px;max-width:440px;margin-left:auto;margin-right:auto">
            ${search
              ? 'Try a different search term or clear filters.'
              : 'The Lenful catalog cache is empty. Click "Sync now" to pull the latest catalog from your Gbox fulfillment partner.'}
          </p>
          <form method="POST" action="${base}/products/lenful/sync-now" style="display:inline-block">
            ${csrfHiddenField(req.csrfToken!)}
            <button type="submit" class="btn btn-primary">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="margin-right:6px"><path d="M3 8a5 5 0 019-3l2-2M14 8a5 5 0 01-9 3l-2 2M14 2v4h-4M2 14v-4h4"/></svg>
              Sync Lenful catalog
            </button>
          </form>
        </div>
      `
    : `
        <div class="lf-list">
          <div class="lf-list-head">
            <div class="lf-list-head-thumb"></div>
            <div class="lf-list-head-title">Product</div>
            <div class="lf-list-head-price">Base price</div>
            <div class="lf-list-head-action"></div>
          </div>
          ${catalog.map((c) => renderLenfulRow(c, base, req.csrfToken!)).join('')}
        </div>
      `

  const content = `
    <div class="page-header">
      <div>
        <h1 class="page-title">Products</h1>
        <p class="page-subtitle">${total} Lenful product${total !== 1 ? 's' : ''} available · last synced ${humanAge(lastSynced)}</p>
      </div>
      <div style="display:flex;gap:8px">
        <form method="POST" action="${base}/products/lenful/sync-now" style="display:inline">
          ${csrfHiddenField(req.csrfToken!)}
          <button type="submit" class="btn btn-outline" title="Pull the latest catalog from Lenful (rate-limited to 2 req/sec)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" style="margin-right:6px"><path d="M3 8a5 5 0 019-3l2-2M14 8a5 5 0 01-9 3l-2 2M14 2v4h-4M2 14v-4h4"/></svg>
            Sync now
          </button>
        </form>
        <a href="${base}/products/new" class="btn btn-primary">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
          Add product
        </a>
      </div>
    </div>

    <!-- SOURCE TABS (My products | Lenful catalog) -->
    <div class="source-tabs">
      <a href="${base}/products" class="source-tab">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 4l6-2 6 2v8l-6 2-6-2V4zM2 4l6 2 6-2M8 6v8"/></svg>
        My products
      </a>
      <a href="${base}/products?source=lenful" class="source-tab active">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 2v12M2 8h12"/></svg>
        Lenful products
        <span class="source-tab-pill">POD</span>
      </a>
    </div>

    ${flashBanner}

    <!-- LENFUL INTRO BANNER -->
    <div class="lf-banner">
      <div class="lf-banner-icon">
        <svg width="26" height="26" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7h14v10H3zM6 7V4a4 4 0 018 0v3"/><circle cx="10" cy="12" r="1.5"/></svg>
      </div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:700;color:var(--s-text);margin-bottom:2px">Gbox Print-on-Demand Catalog (powered by Lenful)</div>
        <div style="font-size:12px;color:var(--s-text-muted)">Click "Add to store" to push the product straight into the Gbox master shop on gbox.co — every variant, image, and option comes with it.</div>
      </div>
    </div>

    <!-- SEARCH + CATEGORY PILLS -->
    <div class="card" style="margin-bottom:18px">
      <div class="card-body" style="padding:14px 20px">
        <form method="GET" action="${base}/products" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <input type="hidden" name="source" value="lenful">
          ${categoryFilter ? `<input type="hidden" name="cat" value="${esc(categoryFilter)}">` : ''}
          <div style="flex:1;min-width:260px;position:relative">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#6b7280" stroke-width="1.5" style="position:absolute;left:10px;top:50%;transform:translateY(-50%)"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
            <input type="text" name="q" value="${esc(search)}" placeholder="Search Lenful catalog (title, SKU, category)..." style="width:100%;padding:8px 12px 8px 34px;border:1px solid var(--border);border-radius:8px;font-size:13px;outline:none">
          </div>
          <button type="submit" class="btn btn-outline btn-sm">Search</button>
          ${search || categoryFilter ? `<a href="${catalogUrl({})}" class="btn btn-outline btn-sm" style="color:var(--danger)">Clear</a>` : ''}
        </form>
        ${categories.length > 0 ? `
          <div class="lf-pills">
            <a href="${catalogUrl({ q: search })}" class="lf-pill ${!categoryFilter ? 'active' : ''}">All categories <span>${total}</span></a>
            ${catPills}
          </div>
        ` : ''}
      </div>
    </div>

    ${gridHtml}

    <!-- PAGINATION -->
    ${totalPages > 1 ? `
    <div style="display:flex;justify-content:center;align-items:center;gap:8px;margin-top:20px">
      ${page > 1 ? `<a href="${catalogUrl({ q: search, cat: categoryFilter ?? '', page: String(page - 1) })}" class="btn btn-outline btn-sm">&laquo; Previous</a>` : `<span class="btn btn-outline btn-sm" style="opacity:.4;cursor:default">&laquo; Previous</span>`}
      <span style="font-size:13px;color:var(--text-secondary);padding:0 12px">Page ${page} of ${totalPages}</span>
      ${page < totalPages ? `<a href="${catalogUrl({ q: search, cat: categoryFilter ?? '', page: String(page + 1) })}" class="btn btn-outline btn-sm">Next &raquo;</a>` : `<span class="btn btn-outline btn-sm" style="opacity:.4;cursor:default">Next &raquo;</span>`}
    </div>
    ` : ''}

    <style>
      .source-tabs {
        display:flex; gap:4px; margin:0 0 20px;
        border-bottom:1px solid var(--border, #e5e7eb); padding-bottom:0;
      }
      .source-tab {
        display:inline-flex; align-items:center; gap:8px;
        padding:10px 18px; border-radius:8px 8px 0 0;
        font-size:14px; font-weight:600;
        color:var(--s-text-muted, #6b7280); text-decoration:none;
        border:1px solid transparent; border-bottom:none;
        margin-bottom:-1px;
        transition:background .12s, color .12s;
      }
      .source-tab:hover { color:var(--s-text, #111); background:rgba(99,102,241,.05); }
      .source-tab.active {
        color:var(--s-accent, #6366f1);
        background:var(--s-card, #fff);
        border-color:var(--border, #e5e7eb);
        border-bottom:1px solid var(--s-card, #fff);
      }
      .source-tab svg { opacity:.75; }
      .source-tab.active svg { opacity:1; }
      .source-tab-pill {
        display:inline-block; padding:1px 8px; border-radius:10px;
        background:linear-gradient(135deg,#8b5cf6,#6366f1); color:#fff;
        font-size:10px; font-weight:700; letter-spacing:.4px;
      }
      /* Banner */
      .lf-banner {
        display:flex; gap:14px; align-items:center;
        padding:14px 18px; margin-bottom:16px;
        background:linear-gradient(135deg, rgba(139,92,246,.08), rgba(99,102,241,.08));
        border:1px solid rgba(99,102,241,.2); border-radius:12px;
      }
      .lf-banner-icon {
        width:44px; height:44px; display:flex; align-items:center; justify-content:center;
        background:linear-gradient(135deg,#8b5cf6,#6366f1); color:#fff;
        border-radius:10px; flex-shrink:0;
      }
      /* Category pills */
      .lf-pills {
        display:flex; gap:6px; flex-wrap:wrap; margin-top:12px; padding-top:12px;
        border-top:1px dashed var(--border, #e5e7eb);
      }
      .lf-pill {
        display:inline-flex; align-items:center; gap:6px;
        padding:5px 12px; border-radius:16px; font-size:12px; font-weight:500;
        color:var(--s-text-muted, #6b7280); text-decoration:none;
        background:var(--s-card-muted, rgba(0,0,0,.04));
        border:1px solid transparent;
      }
      .lf-pill:hover { background:rgba(99,102,241,.08); color:var(--s-accent); }
      .lf-pill.active {
        background:var(--s-accent, #6366f1); color:#fff; border-color:var(--s-accent);
      }
      .lf-pill span {
        display:inline-block; min-width:18px; padding:0 5px; text-align:center;
        background:rgba(255,255,255,.25); border-radius:10px; font-size:10px; font-weight:700;
      }
      .lf-pill:not(.active) span { background:rgba(0,0,0,.06); }
      /* ShopBase-style list layout — compact rows with small thumbnail, full
         product name, SKU/category meta, price, and a single action button */
      .lf-list {
        display:flex; flex-direction:column;
        background:var(--s-card, #fff); border:1px solid var(--border, #e5e7eb);
        border-radius:12px; overflow:hidden;
      }
      .lf-list-head {
        display:flex; align-items:center; gap:14px;
        padding:10px 16px;
        background:var(--s-card-muted, rgba(0,0,0,.03));
        border-bottom:1px solid var(--border, #e5e7eb);
        font-size:11px; font-weight:700; letter-spacing:.04em;
        color:var(--s-text-muted, #6b7280); text-transform:uppercase;
      }
      .lf-list-head-thumb { width:56px; flex:none; }
      .lf-list-head-title { flex:1; min-width:0; }
      .lf-list-head-price { width:100px; text-align:right; }
      .lf-list-head-action { width:130px; flex:none; text-align:right; }
      @media (max-width: 700px) {
        .lf-list-head-price, .lf-list-head-action { display:none; }
      }
      .lf-row {
        display:flex; align-items:center; gap:14px;
        padding:10px 16px;
        border-bottom:1px solid var(--border, #e5e7eb);
        transition:background .12s;
      }
      .lf-row:last-child { border-bottom:none; }
      .lf-row:hover { background:rgba(99,102,241,.05); }
      .lf-row-thumb {
        width:56px; height:56px; flex:none;
        border-radius:8px; overflow:hidden;
        background:var(--s-card-muted, #f3f4f6);
        position:relative;
      }
      .lf-row-thumb img {
        width:100%; height:100%; object-fit:cover; display:block;
      }
      .lf-row-thumb-empty {
        display:flex; align-items:center; justify-content:center;
        width:100%; height:100%; color:#9ca3af;
      }
      .lf-row-body {
        flex:1; min-width:0;
        display:flex; flex-direction:column; gap:3px;
      }
      .lf-row-title {
        font-size:13px; font-weight:600; color:var(--s-text, #111);
        line-height:1.4;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
        overflow:hidden; word-break:break-word;
      }
      .lf-row-meta {
        display:flex; align-items:center; gap:8px; flex-wrap:wrap;
        font-size:11px; color:var(--s-text-muted, #6b7280);
      }
      .lf-row-sku {
        font-family:ui-monospace,Menlo,monospace; font-size:10px; opacity:.85;
      }
      .lf-row-cat {
        padding:1px 8px; background:rgba(0,0,0,.05);
        border-radius:10px; font-size:10px;
      }
      .lf-row-variant { font-size:10px; opacity:.75; }
      .lf-row-pod {
        font-size:9px; font-weight:700; letter-spacing:.3px;
        padding:2px 6px; border-radius:4px;
        background:linear-gradient(135deg,#8b5cf6,#6366f1); color:#fff;
      }
      .lf-row-price {
        width:100px; flex:none; text-align:right;
        font-size:14px; font-weight:700; color:var(--s-text, #111);
      }
      .lf-row-price small {
        display:block; font-size:10px; font-weight:500;
        color:var(--s-text-muted);
      }
      .lf-row-action { width:130px; flex:none; display:flex; justify-content:flex-end; }
      .lf-row-action form { margin:0; }
      .lf-row-import-btn {
        padding:7px 14px; border-radius:6px;
        font-size:12px; font-weight:600; cursor:pointer;
        border:1px solid var(--s-accent, #6366f1);
        background:var(--s-accent, #6366f1); color:#fff;
        display:inline-flex; align-items:center; gap:5px;
        transition:background .12s, transform .12s;
        white-space:nowrap;
      }
      .lf-row-import-btn:hover { background:#4f46e5; }
      .lf-row-import-btn:active { transform:translateY(1px); }
      .lf-row-import-btn[disabled] { opacity:.55; cursor:wait; }
      @media (max-width: 700px) {
        .lf-row { padding:10px 12px; gap:10px; }
        .lf-row-price, .lf-row-action { display:none; }
        .lf-row-title { -webkit-line-clamp:3; }
      }
    </style>

    <script>
    // Submit handler that disables the button + shows spinner text while the
    // server creates the draft. We don't intercept the submit — native POST
    // + redirect pattern keeps this trivially consistent with CSRF rotation.
    document.querySelectorAll('form.lf-import-form').forEach(function(f) {
      f.addEventListener('submit', function() {
        var btn = f.querySelector('button');
        if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
      });
    });
    </script>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Lenful products',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'products',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

/** Renders one Lenful catalog ROW — list layout, compact. */
function renderLenfulRow(
  c: LenfulCatalogRow,
  base: string,
  csrfToken: string,
): string {
  const title = c.title || c.lenful_product_sku
  const priceDisplay = c.base_price != null
    ? (c.currency === 'USD' ? `$${Number(c.base_price).toFixed(2)}` : `${Number(c.base_price).toFixed(2)} ${c.currency}`)
    : '—'
  const thumb = c.thumbnail_url
    ? `<img src="${esc(c.thumbnail_url)}" alt="${esc(title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'lf-row-thumb-empty\\'><svg width=\\'24\\' height=\\'24\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'1.5\\'><rect x=\\'3\\' y=\\'3\\' width=\\'18\\' height=\\'18\\' rx=\\'2\\'/><circle cx=\\'9\\' cy=\\'9\\' r=\\'1.5\\'/><path d=\\'M21 15l-5-5L5 21\\'/></svg></div>';">`
    : `<div class="lf-row-thumb-empty"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></div>`

  return `
    <div class="lf-row">
      <div class="lf-row-thumb">${thumb}</div>
      <div class="lf-row-body">
        <div class="lf-row-title" title="${esc(title)}">${esc(title)}</div>
        <div class="lf-row-meta">
          <span class="lf-row-pod">POD</span>
          <span class="lf-row-sku">${esc(c.lenful_product_sku)}</span>
          ${c.category_name ? `<span class="lf-row-cat">${esc(c.category_name)}</span>` : ''}
          ${c.variant_count > 1 ? `<span class="lf-row-variant">${c.variant_count} variants</span>` : ''}
        </div>
      </div>
      <div class="lf-row-price">${priceDisplay}<small>base</small></div>
      <div class="lf-row-action">
        <form method="POST" action="${base}/products/lenful/import" class="lf-import-form">
          <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
          <input type="hidden" name="lenful_product_id" value="${esc(c.lenful_product_id)}">
          <button type="submit" class="lf-row-import-btn" title="Import as draft into your store">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8 3v10M3 8h10"/></svg>
            Add to store
          </button>
        </form>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// GET /products/:id — Product detail / edit page (ShopBase parity)
// ---------------------------------------------------------------------------
//
// Layout mirrors the ShopBase admin product editor 1:1, for both physical
// dropship products and POD (print-on-demand) products. POD detection is a
// best-effort heuristic on tags/product_type/vendor — when we later persist
// a `fulfillment_service` on products we'll switch to that.
//
// Left column:  Title • Description • Set as Home page • Media •
//               Personalization (POD) • Variant options (+ grouping) •
//               Variants table • Search engine listing preview
// Right column: Product availability • Organization (Type, Vendor,
//               Collections, Tags) • Fulfillment services (Unmanaged /
//               Printhub + Map product) • Online store template • Reviews
//               • Bundles • Quantity discounts • Facebook Pixel & CAPI
// Footer:       Delete product (left)  Save (right)

function isPodProduct(product: { product_type: string | null; vendor: string | null; tags: string[] | null }): boolean {
  const hay = `${product.product_type ?? ''} ${product.vendor ?? ''} ${(product.tags ?? []).join(' ')}`.toLowerCase()
  return /\b(pod|print\s*on\s*demand|printhub|print\s*hub|t-?shirt|apparel|hoodie|mug|poster|wicked|loser)\b/.test(hay)
}

function productStatusBadge(status: string): string {
  if (status === 'active') return '<span class="badge badge-success">Active</span>'
  if (status === 'draft') return '<span class="badge badge-warning">Draft</span>'
  if (status === 'archived') return '<span class="badge badge-danger">Archived</span>'
  return `<span class="badge badge-neutral">${esc(status)}</span>`
}

/**
 * Render rows for the "Custom data" sidebar card.
 *
 * Keeps the value preview short (60 chars) so big JSON blobs don't blow up
 * the right column. Each row has an inline "Delete" form (CSRF-protected,
 * POST /products/:id/metafields/:metafieldId/delete). Edit goes through the
 * REST API from the client — we ship a tiny inline script near the modal.
 */
function renderProductMetafields(
  metafields: ProductMetafieldRow[],
  productId: string,
  base: string,
  csrfField: string,
): string {
  if (!metafields.length) {
    return '<p class="pd-side-help pd-mf-empty">No custom fields yet. Add one to store merchant-specific data on this product.</p>'
  }
  return metafields
    .map((mf) => {
      const raw = typeof mf.value === 'string' ? mf.value : JSON.stringify(mf.value)
      const preview = raw.length > 60 ? raw.slice(0, 57) + '…' : raw
      return `
        <div class="pd-mf-row" data-mf-id="${esc(mf.id)}">
          <div class="pd-mf-row-main">
            <div class="pd-mf-tuple">${esc(mf.namespace)}<span class="pd-mf-sep">.</span>${esc(mf.key)}</div>
            <div class="pd-mf-type">${esc(mf.value_type)}</div>
            <div class="pd-mf-value" title="${esc(raw)}">${esc(preview)}</div>
          </div>
          <form class="pd-mf-del" method="POST" action="${base}/products/${encodeURIComponent(productId)}/metafields/${encodeURIComponent(mf.id)}/delete" onsubmit="return confirm('Delete custom field ${esc(mf.namespace)}.${esc(mf.key)}?')">
            ${csrfField}
            <button type="submit" class="pd-mf-del-btn" aria-label="Delete ${esc(mf.namespace)}.${esc(mf.key)}">✕</button>
          </form>
        </div>
      `
    })
    .join('')
}

export async function getProductDetail(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  const productIdRaw = String(req.params.productId ?? req.params.id ?? '')

  if (!hasDb) {
    const apiBase = process.env.API_PRODUCT_BASE_URL
    if (!apiBase) {
      res.status(500).send('Missing API_PRODUCT_BASE_URL')
      return
    }

    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)

    const r = await fetch(`${apiBase}/api/${encodeURIComponent(store.id)}/${encodeURIComponent(productIdRaw)}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(12000),
    }).catch(() => null)

    if (!r || !r.ok) {
      res.redirect(`${base}/products?error=${encodeURIComponent('Product not found')}`)
      return
    }

    const data = await r.json()
    const p = data.data || data

    const product = {
      id: p.id || p.slug,
      title: p.name || p.slug || 'Unnamed',
      slug: p.slug || '',
      body_html: p.body_html || '',
      vendor: p.vendor || '',
      product_type: '',
      status: p.published ? 'active' : 'draft',
      tags: Array.isArray(p.tags) ? p.tags : [],
      seo_title: p.seo_title || '',
      seo_description: p.seo_description || '',
    }

    const variants = Array.isArray(p.variants) ? p.variants : (p.variant_default ? [p.variant_default] : [])
    const images = Array.isArray(p.images) ? p.images : []
    const allCollections = Array.isArray(p.categories) ? p.categories : []

    // Fetch full categories list from BE so the dropdown shows every option
    // (BE: GET /api/{shop_id}/category, anonymous, returns { data: [...] }).
    let allCategories: Array<{ id: string; name: string; slug?: string }> = []
    try {
      const catRes = await fetch(`${apiBase}/api/${encodeURIComponent(store.id)}/category`, {
        method: 'GET',
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(10000),
      })
      if (catRes.ok) {
        const cd: any = await catRes.json().catch(() => null)
        const arr = Array.isArray(cd?.data) ? cd.data : (Array.isArray(cd) ? cd : [])
        allCategories = arr
          .filter((c: any) => c?.id)
          .map((c: any) => ({ id: String(c.id), name: String(c.name || c.slug || c.id), slug: c.slug }))
      }
    } catch (e: any) {
      console.warn('[product-detail] categories list failed:', e?.message)
    }
    const productCollections = allCollections.map((c: any) => ({ collection_id: c.id || c.slug }))
    const tagRows: any[] = []
    const primaryDomain = { domain: store.slug }
    const shopLocations = [{ id: 'default', name: 'Default', is_primary: true }]
    const productMetafields: any[] = []
    const variantMetafieldCounts: Record<string, number> = {}

    // Mock rendering UI components for API mode...
    // The rest of the file relies heavily on these arrays. We mapped the basic properties to make the template happy.
    // Note: Some actions in the UI (like adding variants, adding images) might still post to Postgres-only endpoints.

    const csrfToken = req.csrfToken!
    const csrfField = csrfHiddenField(csrfToken)
    const successMsg = typeof req.query.success === 'string' ? req.query.success : ''
    const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''

    const bannerHtml = successMsg
      ? `<div class="gbx-flash gbx-flash-success" role="status">${esc(successMsg)}</div>`
      : errorMsg
        ? `<div class="gbx-flash gbx-flash-error" role="alert">${esc(errorMsg)}</div>`
        : ''

    // Default variant pulled out for pricing / inventory / SKU fields.
    const vd = (p as any).variant_default || (variants[0] ?? {})
    const vdPrice = Number((vd as any).price ?? 0)
    const vdOldPrice = Number((vd as any).old_price ?? 0)
    const vdBaseCost = Number((vd as any).base_cost ?? 0)
    const vdInventory = Number((vd as any).inventory ?? 0)
    const vdSku = String((vd as any).sku ?? '')
    const vdBarcode = String((vd as any).barcode ?? '')
    const firstCategoryId = (allCollections[0] as any)?.id ?? ''
    const imageUrls = images
      .map((im: any) => im?.url || im?.src || (typeof im === 'string' ? im : ''))
      .filter(Boolean)
      .slice(0, 8)

    const content = `
      ${bannerHtml}
      <div style="max-width:1200px;margin:0 auto">
        <!-- Topbar -->
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px">
          <a href="${base}/products" style="color:var(--s-text-muted);text-decoration:none;font-size:18px;line-height:1" title="Back to products">&larr;</a>
          <h1 style="margin:0;font-size:18px;font-weight:600;color:var(--s-text)">${esc(product.title)}</h1>
          <span class="badge ${product.status === 'active' ? 'badge-success' : 'badge-warning'}" style="font-size:11px;padding:2px 10px;border-radius:999px">${product.status === 'active' ? 'Active' : 'Draft'}</span>
          <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
            <button type="button" class="btn btn-outline" style="font-size:12px;padding:5px 12px" onclick="gxComingSoon('Duplicate product')">Duplicate</button>
            <button type="button" class="btn btn-outline" style="font-size:12px;padding:5px 12px" onclick="gxComingSoon('Preview product')">Preview</button>
            <button type="button" class="btn btn-outline" style="font-size:12px;padding:5px 12px" onclick="gxComingSoon('Share')">Share</button>
            <form method="POST" action="${base}/products/${encodeURIComponent(product.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this product permanently?')">
              ${csrfField}
              <button type="submit" class="btn btn-outline" style="font-size:12px;padding:5px 12px;color:var(--s-danger);border-color:var(--s-danger)">Delete</button>
            </form>
          </div>
        </div>

        <form method="POST" action="${base}/products/${encodeURIComponent(product.id)}/update" id="prod-edit-form">
          ${csrfField}
          <div style="display:grid;grid-template-columns:1fr 320px;gap:18px;align-items:start">
            <!-- LEFT MAIN -->
            <div style="display:flex;flex-direction:column;gap:14px">
              <!-- Title + Description -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <label style="display:block;font-size:12px;color:var(--s-text-muted);margin-bottom:6px">Title</label>
                  <input type="text" name="title" value="${esc(product.title)}" required class="form-input" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:14px">
                  <label style="display:block;font-size:12px;color:var(--s-text-muted);margin:14px 0 6px">Description</label>
                  <textarea name="body_html" rows="6" style="width:100%;padding:10px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;resize:vertical;font-family:inherit">${esc(product.body_html || '')}</textarea>
                </div>
              </div>

              <!-- Media -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--s-text)">Media</div>
                  <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(120px, 1fr));gap:10px">
                    ${imageUrls.map((u: string, i: number) => `<div class="prod-media-item" data-idx="${i}" style="position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;background:var(--s-card-hover);border:1px solid var(--s-border)"><img src="${esc(u)}" alt="" style="width:100%;height:100%;object-fit:cover"><button type="button" class="prod-media-del" data-idx="${i}" title="Remove image" style="position:absolute;top:6px;right:6px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(0,0,0,.6);color:#fff;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center">×</button></div>`).join('')}
                    <label id="prod-media-trigger" for="prod-media-input" title="Upload image" style="aspect-ratio:1;border:1px dashed var(--s-border);border-radius:8px;background:var(--s-bg);color:var(--s-text-muted);font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center">+</label>
                    <input id="prod-media-input" type="file" accept="image/*" style="display:none" data-upload-url="${base}/products/${encodeURIComponent(product.id)}/media-upload">
                  </div>
                  ${imageUrls.length === 0 ? '<p style="margin:10px 0 0;font-size:12px;color:var(--s-text-muted)">No media yet</p>' : ''}
                  <p id="prod-media-status" style="margin:10px 0 0;font-size:12px;color:var(--s-text-muted);display:none"></p>
                </div>
              </div>
              <script>
                (function(){
                  var inp = document.getElementById('prod-media-input');
                  var status = document.getElementById('prod-media-status');
                  var removeBase = ${JSON.stringify(`${base}/products/${encodeURIComponent(product.id)}/media-remove`)};
                  if (!inp) return;
                  inp.addEventListener('change', async function(){
                    if (!inp.files || !inp.files[0]) return;
                    var f = inp.files[0];
                    if (f.size > 5 * 1024 * 1024) { alert('Image too large (max 5MB)'); inp.value = ''; return; }
                    if (status) { status.style.display = 'block'; status.textContent = 'Uploading ' + f.name + '...'; }
                    var fd = new FormData(); fd.append('file', f);
                    try {
                      var r = await fetch(inp.dataset.uploadUrl, { method: 'POST', body: fd, credentials: 'same-origin' });
                      var d = await r.json().catch(function(){ return null; });
                      if (r.ok && d && d.ok) {
                        if (status) status.textContent = 'Uploaded. Reloading...';
                        setTimeout(function(){ window.location.reload(); }, 400);
                      } else {
                        if (status) status.textContent = 'Upload failed: ' + ((d && d.error) || ('HTTP ' + r.status));
                      }
                    } catch (e) {
                      if (status) status.textContent = 'Upload error: ' + (e.message || e);
                    } finally { inp.value = ''; }
                  });
                  // Delete media — click × button on each thumbnail
                  document.querySelectorAll('.prod-media-del').forEach(function(btn){
                    btn.addEventListener('click', async function(ev){
                      ev.preventDefault();
                      if (!confirm('Remove this image?')) return;
                      var idx = btn.getAttribute('data-idx');
                      btn.disabled = true;
                      if (status) { status.style.display = 'block'; status.textContent = 'Removing image...'; }
                      try {
                        var r = await fetch(removeBase + '?index=' + encodeURIComponent(idx), { method: 'POST', credentials: 'same-origin' });
                        var d = await r.json().catch(function(){ return null; });
                        if (r.ok && d && d.ok) {
                          if (status) status.textContent = 'Removed. Reloading...';
                          setTimeout(function(){ window.location.reload(); }, 400);
                        } else {
                          if (status) status.textContent = 'Remove failed: ' + ((d && d.error) || ('HTTP ' + r.status));
                          btn.disabled = false;
                        }
                      } catch (e) {
                        if (status) status.textContent = 'Remove error: ' + (e.message || e);
                        btn.disabled = false;
                      }
                    });
                  });
                })();
              </script>

              <!-- Category -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <label style="display:block;font-size:13px;font-weight:600;color:var(--s-text);margin-bottom:6px">Category</label>
                  <select name="category_id" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px">
                    <option value="">— No category —</option>
                    ${allCategories.map((c) => `<option value="${esc(c.id)}" ${c.id === firstCategoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
                  </select>
                  <p style="margin:6px 0 0;font-size:11px;color:var(--s-text-muted)">Used for search filters and category-based collections.</p>
                </div>
              </div>

              <!-- Price -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--s-text)">Pricing</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
                    <div>
                      <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Price</label>
                      <input type="number" name="price" value="${vdPrice}" step="0.01" min="0" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px">
                    </div>
                    <div>
                      <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Compare-at price</label>
                      <input type="number" name="compare_at_price" value="${vdOldPrice}" step="0.01" min="0" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px">
                    </div>
                    <div>
                      <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Cost per item</label>
                      <input type="number" name="cost_per_item" value="${vdBaseCost}" step="0.01" min="0" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px">
                    </div>
                  </div>
                </div>
              </div>

              <!-- Inventory -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--s-text)">Inventory</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                    <div>
                      <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Available</label>
                      <input type="number" name="inventory" value="${vdInventory}" step="1" min="0" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px">
                    </div>
                    <div>
                      <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">SKU</label>
                      <input type="text" name="sku" value="${esc(vdSku)}" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;font-family:monospace">
                    </div>
                  </div>
                  <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Barcode (ISBN, UPC, GTIN…)</label>
                  <input type="text" name="barcode" value="${esc(vdBarcode)}" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;font-family:monospace">
                </div>
              </div>

              <!-- Variants placeholder -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--s-text)">Variants</div>
                  <button type="button" onclick="gxComingSoon('Variant options')" style="background:none;border:none;color:var(--s-accent);font-size:13px;cursor:pointer;padding:0">+ Add options like size or color</button>
                </div>
              </div>

              <!-- Search engine listing -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--s-text)">Search engine listing</div>
                  <p style="margin:0 0 10px;font-size:12px;color:var(--s-text-muted)">Add a title and description to see how this product might appear in a search engine listing.</p>
                  <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Page title</label>
                  <input type="text" name="seo_title" value="${esc(product.seo_title || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;margin-bottom:10px">
                  <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Meta description</label>
                  <textarea name="seo_description" rows="3" style="width:100%;padding:10px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;resize:vertical;margin-bottom:10px">${esc(product.seo_description || '')}</textarea>
                  <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">URL slug</label>
                  <input type="text" name="slug" value="${esc(product.slug || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;font-family:monospace">
                </div>
              </div>
            </div>

            <!-- RIGHT SIDEBAR -->
            <aside style="display:flex;flex-direction:column;gap:14px">
              <!-- Status -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <label style="display:block;font-size:13px;font-weight:600;color:var(--s-text);margin-bottom:6px">Status</label>
                  <select name="status" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px">
                    <option value="active" ${product.status === 'active' ? 'selected' : ''}>Active</option>
                    <option value="draft" ${product.status !== 'active' ? 'selected' : ''}>Draft</option>
                  </select>
                </div>
              </div>

              <!-- Publishing -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--s-text)">Publishing</div>
                  <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--s-text);margin-bottom:6px">
                    <input type="checkbox" name="avail_listing" value="1" ${product.status === 'active' ? 'checked' : ''}> Online Store
                  </label>
                  <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--s-text-muted)">
                    <input type="checkbox" disabled> Point of Sale
                  </label>
                </div>
              </div>

              <!-- Product organization -->
              <div class="card">
                <div class="card-body" style="padding:18px">
                  <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--s-text)">Product organization</div>
                  <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Vendor</label>
                  <input type="text" name="vendor" value="${esc(product.vendor || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px;margin-bottom:10px">
                  <label style="display:block;font-size:11px;color:var(--s-text-muted);margin-bottom:4px">Tags (comma separated)</label>
                  <input type="text" name="tags" value="${esc((product.tags || []).join(', '))}" style="width:100%;padding:8px 12px;border:1px solid var(--s-input-border);border-radius:8px;background:var(--s-input-bg);color:var(--s-text);font-size:13px">
                </div>
              </div>
            </aside>
          </div>

          <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:10px">
            <a href="${base}/products" style="padding:9px 22px;font-size:13px;border-radius:8px;background:var(--s-card);border:1px solid var(--s-border);color:var(--s-text);text-decoration:none">Cancel</a>
            <button type="submit" style="padding:9px 22px;font-size:13px;font-weight:600;border-radius:8px;background:var(--s-accent);color:#fff;border:1px solid var(--s-accent);cursor:pointer">Save</button>
          </div>
        </form>
      </div>
    `

    res.send(sellerLayout({
      title: `${product.title} - ${store.name}`,
      storeSlug: store.slug,
      storeName: store.name,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      content,
      theme: 'light',
    }))
    return
  }

  const productId = await resolveProductId(
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )

  const [product, variants, images, allCollections, productCollections, tagRows, primaryDomain, shopLocations, productMetafields] = await Promise.all([
    db.selectFrom('products')
      .selectAll()
      .where('id', '=', productId)
      .where('shop_id', '=', store.id)
      .executeTakeFirst(),

    db.selectFrom('product_variants')
      .selectAll()
      .where('product_id', '=', productId)
      .orderBy('position', 'asc')
      .execute(),

    db.selectFrom('product_images')
      .selectAll()
      .where('product_id', '=', productId)
      .orderBy('position', 'asc')
      .execute(),

    db.selectFrom('collections')
      .select(['id', 'title'])
      .where('shop_id', '=', store.id)
      .orderBy('title', 'asc')
      .execute(),

    db.selectFrom('collection_products')
      .select('collection_id')
      .where('product_id', '=', productId)
      .execute(),

    // Distinct tags across the shop — feeds the "View all tags" popover and the
    // collection/tag typeaheads so Store Admin stays self-contained.
    db.selectFrom('products')
      .select('tags')
      .where('shop_id', '=', store.id)
      .where('tags', 'is not', null)
      .execute(),

    // Primary verified domain for the "View on storefront" button. Falls back
    // to legacy shops.domain column below. Storefront is Host-header routed
    // (see memory: nginx_routing.md + dev_platform_domain.md), so a
    // path-based /s/:slug URL does NOT work — we need the actual public host.
    db.selectFrom('shop_domains')
      .select('domain')
      .where('shop_id', '=', store.id)
      .where('verified', '=', true)
      .orderBy('is_primary', 'desc')
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst(),

    // Phase 2 PR5 — active locations for this shop. Used by the
    // "Inventory by location" panel below the variants table. Shops with
    // a single location (the seeded Default) see no new UI — this query
    // is cheap even on single-location shops.
    db.selectFrom('locations')
      .select(['id', 'name', 'is_primary'])
      .where('shop_id', '=', store.id)
      .where('active', '=', true)
      .orderBy('is_primary', 'desc')
      .orderBy('name', 'asc')
      .execute(),

    // Phase 2 PR1 — metafields for this product. Loaded in the same Promise.all
    // so the sidebar "Custom data" card renders with zero extra round-trips.
    listProductMetafields(db as any, store.id, 'product', productId),
  ])

  // Phase 2 PR1 — aggregate metafield counts for each variant in one query so
  // the variant rows can show a "3 custom" badge without N+1 lookups. The
  // query is shop-scoped defensively even though variant ids are UUIDs.
  const variantIds = variants.map((v: any) => v.id as string)
  const variantMetafieldCounts: Record<string, number> = {}
  if (variantIds.length > 0) {
    const rows = await db
      .selectFrom('metafields')
      .select(['owner_id', db.fn.count<number>('id').as('c')])
      .where('shop_id', '=', store.id)
      .where('owner_type', '=', 'variant')
      .where('owner_id', 'in', variantIds)
      .groupBy('owner_id')
      .execute()
      .catch(() => [] as Array<{ owner_id: string; c: number }>)
    for (const r of rows as Array<{ owner_id: string; c: number | string }>) {
      variantMetafieldCounts[r.owner_id] = Number(r.c) || 0
    }
  }

  if (!product) {
    const theme = (req as any).theme || 'dark'
    res.status(404).send(sellerLayout({
      title: 'Product Not Found',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'products',
      theme: theme as 'dark' | 'light',
      content: `
        <div class="page-header">
          <div>
            <h1 class="page-title">Product not found</h1>
            <p class="page-subtitle">The product you are looking for does not exist or has been deleted.</p>
          </div>
        </div>
        <a href="${base}/products" class="btn btn-outline">&larr; Back to products</a>
      `,
    }))
    return
  }

  // ── Derived data ──────────────────────────────────────────────────
  const tags: string[] = Array.isArray(product.tags) ? product.tags : []
  const selectedCollectionIds = new Set(productCollections.map((c: any) => c.collection_id))
  const isPod = isPodProduct(product)
  const successFlag = firstStr(req.query.success) || ''
  const errorFlag = firstStr(req.query.error) || ''

  // Aggregate all tags across the shop so "View all tags" + typeahead suggest
  // from real data rather than hard-coded strings.
  const allTagsSet = new Set<string>()
  for (const row of tagRows) {
    const rowTags = Array.isArray((row as any).tags) ? ((row as any).tags as string[]) : []
    for (const t of rowTags) if (t) allTagsSet.add(t)
  }
  const allTags = Array.from(allTagsSet).sort((a, b) => a.localeCompare(b))

  // Build option groups from variants
  type OptGroup = { name: string; values: string[] }
  const optionGroups: OptGroup[] = []
  for (let idx = 0; idx < 3; idx++) {
    const key = `option${idx + 1}` as 'option1' | 'option2' | 'option3'
    const values = Array.from(
      new Set(
        variants
          .map((v: any) => v[key])
          .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0),
      ),
    )
    if (values.length > 0) {
      // Heuristic for the option name — ShopBase exports put them as
      // "Color" / "Size" / "Style" etc. Until we store option names on
      // the variant row, we infer from value shape.
      let name = `Option ${idx + 1}`
      const sample = values[0]!.toLowerCase()
      if (/^(s|m|l|xl|xxl|[2-6]xl)$/i.test(sample)) name = 'Size'
      else if (/black|white|red|blue|green|pink|grey|gray|yellow|purple|brown|beige|beach/.test(sample)) name = 'Color'
      else if (idx === 0 && isPod) name = 'Style'
      else if (idx === 0) name = 'Color'
      else if (idx === 1) name = 'Size'
      optionGroups.push({ name, values })
    }
  }

  const csrfToken = (req as any).csrfToken ?? ''
  const csrfField = csrfHiddenField(csrfToken)
  const createdLabel = new Date(product.created_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

  // ── Phase 2 PR5 — per-location inventory levels for this product's
  // variants. Loaded only when the shop has 2+ active locations; on
  // single-location shops the panel is hidden and the extra query skipped.
  const multiLocation = shopLocations.length > 1
  type VariantLevel = { variant_id: string; location_id: string; available: number }
  let variantLevels: VariantLevel[] = []
  if (multiLocation && variants.length > 0) {
    const variantIdList = variants.map((v: any) => v.id)
    const rows = await db
      .selectFrom('inventory_levels as il')
      .innerJoin('inventory_items as ii', 'ii.id', 'il.inventory_item_id')
      .select(['ii.variant_id', 'il.location_id', 'il.available'])
      .where('ii.variant_id', 'in', variantIdList)
      .execute()
    variantLevels = rows.map((r) => ({
      variant_id: r.variant_id,
      location_id: r.location_id,
      available: Number(r.available ?? 0),
    }))
  }
  /** level[variantId][locationId] = available qty (0 when no level row exists). */
  const levelMap = new Map<string, Map<string, number>>()
  for (const lvl of variantLevels) {
    let m = levelMap.get(lvl.variant_id)
    if (!m) {
      m = new Map()
      levelMap.set(lvl.variant_id, m)
    }
    m.set(lvl.location_id, lvl.available)
  }

  // Strip HTML for SEO description preview (max 160 chars)
  const seoDescPreview = (product.seo_description || product.body_html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 160)
  // Resolve public storefront URL for the View button.
  //  1. Primary verified custom domain (shop_domains table)
  //  2. Legacy shops.domain column
  //  3. Null → render as disabled chip pointing at the Domains settings page
  const publicHost: string | null = primaryDomain?.domain || store.domain || null
  const storefrontUrl: string | null = publicHost
    ? `https://${publicHost}/products/${product.slug}`
    : null
  const hideAction = product.status === 'active' ? 'Hide product' : 'Show product'

  // ── Page content ──────────────────────────────────────────────────
  const content = `
    ${successFlag ? `<div class="pd-flash pd-flash-ok">${esc(decodeURIComponent(successFlag))}</div>` : ''}
    ${errorFlag ? `<div class="pd-flash pd-flash-err">${esc(decodeURIComponent(errorFlag))}</div>` : ''}

    <div class="pd-topbar">
      <a href="${base}/products" class="pd-back">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 15l-5-5 5-5"/></svg>
        PRODUCTS
      </a>
      <h1 class="pd-title">${esc(product.title)}</h1>
      <div class="pd-topbar-actions">
        <form method="POST" action="${base}/products/${encodeURIComponent(product.id)}/duplicate" class="pd-inline-form">
          ${csrfField}
          <button type="submit" class="pd-chip-btn" title="Duplicate this product">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="6" y="6" width="11" height="11" rx="1.5"/><path d="M3 14V4a1 1 0 0 1 1-1h10"/></svg>
            Duplicate
          </button>
        </form>
        ${storefrontUrl
          ? `<a href="${esc(storefrontUrl)}" target="_blank" rel="noopener" class="pd-chip-btn" title="View on storefront (${esc(publicHost!)})">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="10" cy="10" r="2.5"/></svg>
              View
            </a>`
          : `<a href="${base}/online-store/domains" class="pd-chip-btn pd-chip-btn-muted" title="No storefront domain configured. Click to set one up in Domains settings.">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="10" cy="10" r="2.5"/></svg>
              View
            </a>`
        }
        <form method="POST" action="${base}/products/${encodeURIComponent(product.id)}/status-toggle" class="pd-inline-form">
          ${csrfField}
          <button type="submit" class="pd-chip-btn" title="${esc(hideAction)}">
            ${
              product.status === 'active'
                ? '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 10s3-5 8-5c2 0 3.7.8 5 1.8M18 10s-3 5-8 5c-2 0-3.7-.8-5-1.8M3 3l14 14"/></svg>'
                : '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="10" cy="10" r="2.5"/></svg>'
            }
            ${esc(hideAction)}
          </button>
        </form>
        ${productStatusBadge(product.status)}
      </div>
    </div>

    <!--
      HTML5 gotcha: browsers do NOT allow nested <form> elements. The HTML parser
      ignores inner <form> start tags but the FIRST </form> closes the outer form
      element — which would orphan every input after it and break Save entirely.
      To avoid that we keep the main form EMPTY (self-closed right after its
      hidden fields) and wire each editable input to it via form="pdMainForm".
      Nested action forms (media URL, variant add, variant inline updates, etc.)
      then sit as siblings in the DOM and work independently.
    -->
    <form id="pdMainForm" method="POST" action="${base}/products/${encodeURIComponent(product.id)}/update" class="pd-form">
      ${csrfField}
      <input type="hidden" name="_return" value="detail">
    </form>

    <div class="pd-form-outer">
      <div class="pd-grid">
        <!-- ════════════════ LEFT COLUMN ════════════════ -->
        <div class="pd-left">

          <!-- Title -->
          <section class="pd-card">
            <label class="pd-label">Title</label>
            <input type="text" name="title" form="pdMainForm" value="${esc(product.title)}" class="pd-input" maxlength="255" required>
            <div class="pd-counter"><span id="titleCounter">${product.title.length}</span> / 255</div>
          </section>

          <!-- Description -->
          <section class="pd-card">
            <div class="pd-label-row">
              <label class="pd-label">Description</label>
              <span class="pd-hint" title="Rich text editor">?</span>
              <button type="button" id="pdAiGenDesc"
                      style="margin-left:auto;padding:4px 10px;border:1px solid var(--s-border);background:transparent;border-radius:6px;font-size:12px;color:var(--s-text-dim);cursor:pointer"
                      title="Generate 3 description variants with AI">&#10024; Generate with AI</button>
            </div>
            <div id="pdAiVariants" hidden style="margin-bottom:10px;padding:10px;border-radius:8px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.2)">
              <div style="font-size:12px;color:var(--s-text-dim);margin-bottom:6px" id="pdAiVariantsMsg">Pick a variant to use:</div>
              <div id="pdAiVariantsList" style="display:flex;flex-direction:column;gap:6px"></div>
            </div>
            <script>
              (function(){
                var btn = document.getElementById('pdAiGenDesc'); if (!btn) return;
                var panel = document.getElementById('pdAiVariants');
                var list = document.getElementById('pdAiVariantsList');
                var msg = document.getElementById('pdAiVariantsMsg');
                btn.addEventListener('click', function(){
                  var titleEl = document.querySelector('input[name="title"]');
                  var title = titleEl ? titleEl.value.trim() : '';
                  if (!title) { alert('Add a product title first.'); return; }
                  btn.disabled = true; panel.hidden = false; msg.textContent = 'Generating…'; list.innerHTML = '';
                  var csrfEl = document.querySelector('input[name="csrf_token"]');
                  fetch(window.location.pathname.replace(/\\/products\\/.*$/, '/api/ai/product-description'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfEl ? csrfEl.value : '' },
                    body: JSON.stringify({ productTitle: title, category: '', keywords: [], tone: 'friendly', locale: document.documentElement.getAttribute('lang') || 'en' }),
                  })
                  .then(function(r){ return r.json(); })
                  .then(function(data){
                    btn.disabled = false;
                    if (!data || !data.ok) { msg.textContent = (data && data.error) || 'AI request failed.'; return; }
                    msg.textContent = 'Click a variant to use it:';
                    (data.variants || []).forEach(function(variant, i){
                      var b = document.createElement('button');
                      b.type = 'button';
                      b.textContent = 'Variant ' + (i+1) + ' — ' + variant.slice(0, 80) + (variant.length > 80 ? '…' : '');
                      b.style.cssText = 'padding:8px 10px;border:1px solid var(--s-border);background:transparent;border-radius:6px;text-align:left;cursor:pointer;font-size:13px;color:var(--s-text)';
                      b.addEventListener('click', function(){
                        var ed = document.getElementById('pdRtEditor');
                        var field = document.getElementById('pdBodyField');
                        if (ed) ed.innerText = variant;
                        if (field) field.value = variant;
                        msg.textContent = 'Applied variant ' + (i+1) + '. Remember to save.';
                      });
                      list.appendChild(b);
                    });
                  })
                  .catch(function(){ btn.disabled = false; msg.textContent = 'AI request failed. Please try again.'; });
                });
              })();
            </script>
            <div class="pd-rt-toolbar">
              <select class="pd-rt-select" disabled title="Paragraph style"><option>Paragraph</option></select>
              <span class="pd-rt-sep"></span>
              <button type="button" class="pd-rt-btn" data-cmd="bold" title="Bold"><b>B</b></button>
              <button type="button" class="pd-rt-btn" data-cmd="italic" title="Italic"><i>I</i></button>
              <button type="button" class="pd-rt-btn" data-cmd="underline" title="Underline"><u>U</u></button>
              <button type="button" class="pd-rt-btn" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
              <span class="pd-rt-sep"></span>
              <button type="button" class="pd-rt-btn" title="Text color">A<span class="pd-rt-swatch"></span></button>
              <button type="button" class="pd-rt-btn" title="Highlight"><svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor"><path d="M4 14l6-6 6 6-6 6z"/></svg></button>
              <span class="pd-rt-sep"></span>
              <button type="button" class="pd-rt-btn" data-cmd="justifyLeft" title="Align left"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h14M3 9h10M3 13h14M3 17h10"/></svg></button>
              <button type="button" class="pd-rt-btn" data-cmd="justifyCenter" title="Center"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h14M6 9h8M3 13h14M6 17h8"/></svg></button>
              <button type="button" class="pd-rt-btn" data-cmd="justifyRight" title="Align right"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h14M7 9h10M3 13h14M7 17h10"/></svg></button>
              <span class="pd-rt-sep"></span>
              <button type="button" class="pd-rt-btn" data-cmd="insertOrderedList" title="Numbered list"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 5h10M7 10h10M7 15h10M3 4v2M3 9h2v.5l-2 1V12h3M3 14h2v1h-1v1h1v1H3"/></svg></button>
              <button type="button" class="pd-rt-btn" data-cmd="insertUnorderedList" title="Bullet list"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="4" cy="5" r="1.2"/><circle cx="4" cy="10" r="1.2"/><circle cx="4" cy="15" r="1.2"/><path d="M8 5h9M8 10h9M8 15h9"/></svg></button>
              <span class="pd-rt-sep"></span>
              <button type="button" class="pd-rt-btn" title="Link"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 11a4 4 0 0 0 5.5 0l3-3a4 4 0 0 0-5.5-5.5L9 4M12 9a4 4 0 0 0-5.5 0l-3 3a4 4 0 0 0 5.5 5.5L11 16"/></svg></button>
              <button type="button" class="pd-rt-btn" title="Image"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="14" height="12" rx="1"/><circle cx="7" cy="8" r="1.2"/><path d="M3 14l4-4 4 4 3-3 3 3"/></svg></button>
              <button type="button" class="pd-rt-btn" title="Video"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="13" height="12" rx="1"/><path d="M15 8l3-2v8l-3-2z"/></svg></button>
              <span class="pd-rt-sep"></span>
              <select class="pd-rt-select" disabled title="Size"><option>System font</option></select>
              <select class="pd-rt-select" disabled title="Font size"><option>14px</option></select>
              <span class="pd-rt-spacer"></span>
              <button type="button" class="pd-rt-btn" title="Clear formatting"><svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h12M8 6v10M12 6v10M6 16h8"/></svg></button>
              <button type="button" class="pd-rt-btn" title="View HTML">&lt;/&gt;</button>
            </div>
            <div class="pd-rt-surface" id="pdRtSurface">
              <div contenteditable="true" id="pdRtEditor" class="pd-rt-content">${product.body_html ?? ''}</div>
              <textarea name="body_html" form="pdMainForm" id="pdBodyField" hidden>${esc(product.body_html ?? '')}</textarea>
            </div>
          </section>

          <!-- Set as Home page -->
          <section class="pd-card">
            <div class="pd-label-row">
              <label class="pd-label">Set as Home page <span class="pd-hint" title="Assign this product page as the home page of a connected domain">?</span></label>
            </div>
            <p class="pd-help">Select a domain to assign this page as the Home page for the specified domain. <a href="${base}/online-store/domains" class="pd-learn">Learn more</a></p>
            <a href="${base}/online-store/domains" class="pd-secondary-btn">Select domain</a>
          </section>

          <!-- Media -->
          <section class="pd-card" id="pdMediaCard">
            <div class="pd-section-header">
              <h3 class="pd-section-title">Media (${images.length} / 500)</h3>
              <div class="pd-link-group">
                <a href="#pdAddMediaUrl" class="pd-link" id="pdToggleMediaUrl">Add media from URL</a>
                <a href="${base}/content/files" class="pd-link">Add media</a>
              </div>
            </div>

            <!-- Add media from URL (outside main form — separate POST) -->
            <form method="POST" action="${base}/products/${encodeURIComponent(product.id)}/media" class="pd-media-url-form" id="pdAddMediaUrl" hidden>
              ${csrfField}
              <input type="url" name="src" placeholder="https://cdn.example.com/image.jpg" class="pd-input pd-input-sm" required>
              <input type="text" name="alt" placeholder="Alt text (optional)" class="pd-input pd-input-sm">
              <button type="submit" class="pd-secondary-btn pd-secondary-btn-sm">Add</button>
            </form>

            ${
              images.length > 0
                ? `
              <div class="pd-media-grid">
                ${images
                  .map(
                    (img, i) => `
                  <div class="pd-media-tile${i === 0 ? ' pd-media-primary' : ''}">
                    <img src="${esc(img.src)}" alt="${esc(img.alt || '')}" loading="lazy">
                    <form method="POST" action="${base}/products/${encodeURIComponent(product.id)}/media/${encodeURIComponent(img.id)}/delete" class="pd-media-remove" onsubmit="return confirm('Remove this media?')">
                      ${csrfField}
                      <button type="submit" title="Remove media" aria-label="Remove media">×</button>
                    </form>
                  </div>
                `,
                  )
                  .join('')}
              </div>
            `
                : `
              <div class="pd-media-empty">
                <svg width="40" height="40" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l4-4 3 3 4-5 5 6"/></svg>
                <p>Upload images or videos for your product.</p>
                <p style="font-size:11px;margin-top:4px">Click <strong>Add media from URL</strong> above to get started.</p>
              </div>
            `
            }
          </section>

          ${
            isPod
              ? `
          <!-- Personalization (POD only) — placeholder until buyer-side customizer ships.
               Post Phase F0, fulfillment is handled centrally by Gbox via Lenful, so the
               old links to /fulfillments are gone. The section remains so the POD UX
               still hints the feature is coming. -->
          <section class="pd-card">
            <h3 class="pd-section-title">Personalization <span class="pd-badge-coming">Coming soon</span></h3>
            <p class="pd-help">Letting buyers personalize a POD product boosts conversion. This will be configurable once the storefront customizer ships.</p>
            <div class="pd-pill-group">
              <span class="pd-pill pd-pill-disabled" aria-disabled="true">Custom option</span>
              <span class="pd-pill pd-pill-disabled" aria-disabled="true">Preview image</span>
              <span class="pd-pill pd-pill-disabled" aria-disabled="true">Print file</span>
            </div>
          </section>
          `
              : ''
          }

          <!-- Variant options -->
          <section class="pd-card">
            <h3 class="pd-section-title">Variant options</h3>
            ${
              optionGroups.length === 0
                ? `<p class="pd-help">This product has no options yet. Options like Color, Size, or Style let you sell variants with different prices or inventory. Add your first variant below to create options.</p>`
                : optionGroups
                    .map(
                      (g) => `
              <div class="pd-option">
                <div class="pd-option-header">
                  <span class="pd-option-name">${esc(g.name)}</span>
                  <a href="#pdVariantTable" class="pd-mini-btn">Edit</a>
                </div>
                <div class="pd-option-values">
                  ${g.values.map((v) => `<span class="pd-value-pill">${esc(v)}</span>`).join('')}
                </div>
              </div>
            `,
                    )
                    .join('')
            }
            ${
              optionGroups.length >= 2
                ? `
              <div class="pd-group-toggle">
                <label class="pd-check">
                  <input type="checkbox" id="pdGroupToggle">
                  <span>Group your variants by this option</span>
                </label>
                <select class="pd-rt-select" id="pdGroupBy">
                  ${optionGroups.map((g, i) => `<option value="${i}">${esc(g.name)}</option>`).join('')}
                </select>
              </div>
            `
                : ''
            }
          </section>

          <!-- Variants table -->
          <section class="pd-card" id="pdVariantTable">
            <div class="pd-section-header">
              <h3 class="pd-section-title">Variants (${variants.length} / 500)</h3>
              <div class="pd-link-group">
                <a href="#" class="pd-link" id="pdReorderVariants">Reorder variants</a>
                <a href="#" class="pd-link" id="pdEditOptions">Edit options</a>
                <a href="#pdAddVariantForm" class="pd-link" id="pdToggleAddVariant">Add variant</a>
              </div>
            </div>
            ${
              optionGroups.length > 0
                ? `
              <div class="pd-var-select-bar">
                <span class="pd-muted">Select:</span>
                ${optionGroups
                  .map(
                    (g) => `<a href="#" class="pd-mini-link" data-var-filter="${esc(g.name)}">${esc(g.name)}</a>`,
                  )
                  .join('<span class="pd-var-sep">·</span>')}
                ${
                  optionGroups.length > 0
                    ? `<span class="pd-var-sep">·</span>` +
                      optionGroups
                        .flatMap((g) => g.values)
                        .map((v) => `<a href="#" class="pd-mini-link" data-var-value="${esc(v)}">${esc(v)}</a>`)
                        .join('<span class="pd-var-sep">·</span>')
                    : ''
                }
              </div>
            `
                : ''
            }

            <!-- Add variant form (hidden until "Add variant" clicked; posts to its own endpoint) -->
            <form method="POST" action="${base}/products/${encodeURIComponent(product.id)}/variants" class="pd-var-add-form" id="pdAddVariantForm" hidden>
              ${csrfField}
              <div class="pd-var-add-row">
                ${optionGroups
                  .map(
                    (g, i) => `
                  <div class="pd-var-add-field">
                    <label>${esc(g.name)}</label>
                    <input type="text" name="option${i + 1}" placeholder="${esc(g.values[0] || g.name)}">
                  </div>
                `,
                  )
                  .join('')}
                ${
                  optionGroups.length === 0
                    ? `
                  <div class="pd-var-add-field">
                    <label>Title</label>
                    <input type="text" name="title" placeholder="Default Title" required>
                  </div>
                `
                    : ''
                }
                <div class="pd-var-add-field">
                  <label>Price</label>
                  <input type="number" step="0.01" min="0" name="price" placeholder="0.00" required>
                </div>
                <div class="pd-var-add-field">
                  <label>SKU</label>
                  <input type="text" name="sku" placeholder="SKU">
                </div>
                <div class="pd-var-add-field">
                  <label>Inventory</label>
                  <input type="number" step="1" name="inventory_quantity" value="0">
                </div>
                <div class="pd-var-add-field">
                  <button type="submit" class="btn btn-primary btn-sm">Add variant</button>
                </div>
              </div>
            </form>

            ${
              variants.length > 0
                ? `
            <div class="pd-var-tablewrap">
              <table class="pd-var-table">
                <thead>
                  <tr>
                    <th class="pd-var-check"><input type="checkbox" id="pdVarSelectAll"></th>
                    <th class="pd-var-img"></th>
                    ${optionGroups.map((g) => `<th>${esc(g.name)}</th>`).join('')}
                    <th class="pd-right">Inventory</th>
                    <th class="pd-right">Price</th>
                    <th>SKU</th>
                    <th>Variant Tag</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="pdVarTbody">
                  ${variants
                    .map((v: any) => {
                      const opts: string[] = [v.option1, v.option2, v.option3].filter(
                        (x): x is string => typeof x === 'string' && x.length > 0,
                      )
                      while (opts.length < optionGroups.length) opts.push('')
                      const invClass = Number(v.inventory_quantity) <= 0 ? ' pd-inv-zero' : ''
                      const updateAction = `${base}/products/${encodeURIComponent(product.id)}/variants/${encodeURIComponent(v.id)}/update`
                      const deleteAction = `${base}/products/${encodeURIComponent(product.id)}/variants/${encodeURIComponent(v.id)}/delete`
                      return `
                    <tr data-variant-id="${esc(v.id)}" data-option1="${esc(v.option1 ?? '')}" data-option2="${esc(v.option2 ?? '')}" data-option3="${esc(v.option3 ?? '')}">
                      <td class="pd-var-check"><input type="checkbox" class="pd-var-rowcheck" value="${esc(v.id)}"></td>
                      <td class="pd-var-img">
                        ${
                          v.image_url
                            ? `<img src="${esc(v.image_url)}" alt="">`
                            : `<div class="pd-var-noimg"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4h12v12H4z"/><circle cx="8" cy="8" r="1.5"/><path d="M4 14l4-4 3 3 3-3 2 2"/></svg></div>`
                        }
                      </td>
                      ${opts.map((o) => `<td class="pd-var-opt">${esc(o)}</td>`).join('')}
                      <td class="pd-right${invClass}">
                        <form method="POST" action="${updateAction}" class="pd-var-inline">
                          ${csrfField}
                          <input type="hidden" name="field" value="inventory_quantity">
                          <input type="number" step="1" name="value" value="${Number(v.inventory_quantity)}" class="pd-var-cell-input">
                        </form>
                      </td>
                      <td class="pd-right">
                        <form method="POST" action="${updateAction}" class="pd-var-inline">
                          ${csrfField}
                          <input type="hidden" name="field" value="price">
                          <input type="number" step="0.01" min="0" name="value" value="${Number(v.price).toFixed(2)}" class="pd-var-cell-input">
                        </form>
                      </td>
                      <td class="pd-var-sku">
                        <form method="POST" action="${updateAction}" class="pd-var-inline">
                          ${csrfField}
                          <input type="hidden" name="field" value="sku">
                          <input type="text" name="value" value="${esc(v.sku || '')}" class="pd-var-cell-input pd-var-cell-mono" placeholder="SKU">
                        </form>
                      </td>
                      <td class="pd-var-tag">${
                        variantMetafieldCounts[v.id]
                          ? `<span class="pd-var-mf-badge" title="${variantMetafieldCounts[v.id]} custom field${variantMetafieldCounts[v.id] === 1 ? '' : 's'}">${variantMetafieldCounts[v.id]} custom</span>`
                          : '&nbsp;'
                      }</td>
                      <td class="pd-var-edit">
                        <form method="POST" action="${deleteAction}" class="pd-inline-form" onsubmit="return confirm('Delete this variant? This cannot be undone.')">
                          ${csrfField}
                          <button type="submit" class="pd-icon-btn" title="Delete variant">
                            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h12M7 6V4h6v2M6 6l1 11h6l1-11"/></svg>
                          </button>
                        </form>
                      </td>
                    </tr>
                  `
                    })
                    .join('')}
                </tbody>
              </table>
            </div>
            `
                : `
            <p class="pd-help" style="margin-top:8px">No variants yet. Use <strong>Add variant</strong> above to create one.</p>
            `
            }
          </section>

          <!-- Shipping & customs (PR4 — migration 054 fields)
               Kept as a <details> block because the fields are low-traffic
               (most sellers only fill them once per variant) and would
               bloat the main variants table on products with many options. -->
          ${variants.length > 0 ? `
          <section class="pd-card" id="pdVariantCustomsCard">
            <details class="pd-details">
              <summary class="pd-section-header" style="cursor:pointer;list-style:none">
                <h3 class="pd-section-title">
                  Shipping &amp; customs
                  <svg class="pd-details-caret" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:6px;vertical-align:middle"><path d="M5 8l5 5 5-5"/></svg>
                </h3>
                <span class="pd-help" style="margin-left:auto">HS code, country of origin, and backorder policy per variant.</span>
              </summary>
              <div style="margin-top:12px;overflow-x:auto">
                <table class="pd-var-table">
                  <thead>
                    <tr>
                      <th>Variant</th>
                      <th style="min-width:140px">Barcode (ISBN/UPC/GTIN)</th>
                      <th style="min-width:140px" title="Harmonized System code — used on shipping labels and customs forms. 6–10 digits typical.">HS code</th>
                      <th style="min-width:90px" title="ISO 3166-1 alpha-2, e.g. VN, US, CN.">Country</th>
                      <th style="min-width:140px" title="When an item is out of stock: 'Deny' blocks orders, 'Continue' allows backorders.">Inventory policy</th>
                      <th style="min-width:120px" title="Whether Gbox tracks inventory for this variant. Leave blank to disable tracking.">Tracking</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${variants
                      .map((v: any) => {
                        const updateAction = `${base}/products/${encodeURIComponent(product.id)}/variants/${encodeURIComponent(v.id)}/update`
                        const title = [v.option1, v.option2, v.option3]
                          .filter((x): x is string => typeof x === 'string' && x.length > 0)
                          .join(' · ') || v.title || 'Default variant'
                        const policy = v.inventory_policy === 'continue' ? 'continue' : 'deny'
                        const tracked = v.inventory_management ? String(v.inventory_management) : ''
                        return `
                        <tr data-variant-id="${esc(v.id)}">
                          <td style="font-size:12px;color:var(--s-text)">${esc(title)}</td>
                          <td>
                            <form method="POST" action="${updateAction}" class="pd-var-inline">
                              ${csrfField}
                              <input type="hidden" name="field" value="barcode">
                              <input type="text" name="value" value="${esc(v.barcode || '')}" class="pd-var-cell-input pd-var-cell-mono" placeholder="Scan or type" maxlength="64">
                            </form>
                          </td>
                          <td>
                            <form method="POST" action="${updateAction}" class="pd-var-inline">
                              ${csrfField}
                              <input type="hidden" name="field" value="hs_code">
                              <input type="text" name="value" value="${esc(v.hs_code || '')}" class="pd-var-cell-input pd-var-cell-mono" placeholder="e.g. 6109.10" maxlength="14">
                            </form>
                          </td>
                          <td>
                            <form method="POST" action="${updateAction}" class="pd-var-inline">
                              ${csrfField}
                              <input type="hidden" name="field" value="country_of_origin">
                              <input type="text" name="value" value="${esc(v.country_of_origin || '')}" class="pd-var-cell-input pd-var-cell-mono" placeholder="VN" maxlength="2" pattern="[A-Za-z]{2}" style="text-transform:uppercase">
                            </form>
                          </td>
                          <td>
                            <form method="POST" action="${updateAction}" class="pd-var-inline">
                              ${csrfField}
                              <input type="hidden" name="field" value="inventory_policy">
                              <select name="value" class="pd-var-cell-input" onchange="this.form.submit()">
                                <option value="deny"${policy === 'deny' ? ' selected' : ''}>Deny (out of stock)</option>
                                <option value="continue"${policy === 'continue' ? ' selected' : ''}>Continue (backorder)</option>
                              </select>
                            </form>
                          </td>
                          <td>
                            <form method="POST" action="${updateAction}" class="pd-var-inline">
                              ${csrfField}
                              <input type="hidden" name="field" value="inventory_management">
                              <select name="value" class="pd-var-cell-input" onchange="this.form.submit()">
                                <option value=""${!tracked ? ' selected' : ''}>Not tracked</option>
                                <option value="gbox"${tracked === 'gbox' ? ' selected' : ''}>Gbox</option>
                              </select>
                            </form>
                          </td>
                        </tr>
                        `
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>
            </details>
          </section>
          ` : ''}

          <!-- Phase 2 PR5 — Inventory by location
               Only rendered for shops with 2+ active locations so single-location
               shops see no UX change (the "Inventory" input on the variants
               table above remains the single source of truth for them).

               For multi-location shops: per-variant per-location qty with inline
               +/- controls. Every write goes through the same
               /products/inventory/adjust endpoint that the Inventory page uses —
               which in turn routes through updateInventory() so the
               inventory_levels bridge AND the denormalized pv.inventory_quantity
               stay in lockstep. -->
          ${multiLocation && variants.length > 0 ? `
          <section class="pd-card" id="pdInventoryByLocationCard">
            <details class="pd-details" open>
              <summary class="pd-section-header" style="cursor:pointer;list-style:none">
                <h3 class="pd-section-title">
                  Inventory by location
                  <svg class="pd-details-caret" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:6px;vertical-align:middle"><path d="M5 8l5 5 5-5"/></svg>
                </h3>
                <span class="pd-help" style="margin-left:auto">Stock at each of your ${shopLocations.length} active locations.</span>
              </summary>
              <div style="margin-top:12px;overflow-x:auto">
                <table class="pd-var-table pd-inv-loc-table">
                  <thead>
                    <tr>
                      <th style="min-width:140px">Variant</th>
                      ${shopLocations.map((l: any) => `<th style="text-align:right;min-width:120px">${esc(l.name)}${l.is_primary ? ' <span class="pd-inv-loc-primary" title="Primary location">●</span>' : ''}</th>`).join('')}
                      <th style="text-align:right;min-width:90px">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${variants
                      .map((v: any) => {
                        const title = [v.option1, v.option2, v.option3]
                          .filter((x): x is string => typeof x === 'string' && x.length > 0)
                          .join(' · ') || v.title || 'Default variant'
                        const adjustAction = `${base}/products/inventory/adjust`
                        const levels = levelMap.get(v.id) ?? new Map<string, number>()
                        // Sum from the bridge table when it's populated;
                        // otherwise fall back to the denormalized column so
                        // legacy variants (created before any level row
                        // existed) still show a sensible total.
                        let bridgeSum = 0
                        let hasLevels = false
                        for (const qty of levels.values()) {
                          bridgeSum += qty
                          hasLevels = true
                        }
                        const totalQty = hasLevels ? bridgeSum : Number(v.inventory_quantity ?? 0)
                        return `
                        <tr data-variant-id="${esc(v.id)}">
                          <td style="font-size:12px;color:var(--s-text)">${esc(title)}</td>
                          ${shopLocations
                            .map((loc: any) => {
                              const qty = levels.get(loc.id) ?? 0
                              return `
                                <td style="text-align:right">
                                  <form method="POST" action="${adjustAction}" class="pd-inv-adjust" style="display:inline-flex;align-items:center;gap:4px;justify-content:flex-end">
                                    ${csrfField}
                                    <input type="hidden" name="variantId" value="${esc(v.id)}">
                                    <input type="hidden" name="locationId" value="${esc(loc.id)}">
                                    <input type="hidden" name="reason" value="product_detail_adjust">
                                    <button type="submit" name="adjustment" value="-1" class="btn btn-outline btn-sm pd-inv-pm" title="Decrease by 1 at ${esc(loc.name)}">&minus;</button>
                                    <span style="min-width:32px;text-align:center;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600">${qty}</span>
                                    <button type="submit" name="adjustment" value="1" class="btn btn-outline btn-sm pd-inv-pm" title="Increase by 1 at ${esc(loc.name)}">+</button>
                                  </form>
                                </td>
                              `
                            })
                            .join('')}
                          <td style="text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${totalQty}</td>
                        </tr>
                        `
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>
              <p class="pd-help" style="margin-top:10px;font-size:11px">
                Need to move stock between locations? Go to
                <a href="${base}/products/inventory" class="pd-link">Inventory</a>
                or
                <a href="${base}/settings/locations" class="pd-link">Locations</a>.
              </p>
            </details>
          </section>
          <style>
            .pd-inv-loc-table .pd-inv-pm { width:24px; height:24px; padding:0; display:inline-flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; }
            .pd-inv-loc-primary { color:var(--s-accent); font-size:10px; margin-left:4px; }
          </style>
          ` : ''}

          <!-- Search engine listing -->
          <section class="pd-card" id="pdSeoCard">
            <div class="pd-section-header">
              <h3 class="pd-section-title">Search engine listing preview</h3>
              <a href="#" class="pd-link" id="pdToggleSeoEdit">Edit website SEO</a>
            </div>
            <div class="pd-seo-preview" id="pdSeoPreview">
              <div class="pd-seo-title">${esc(product.seo_title || product.title)}</div>
              <div class="pd-seo-url">https://${esc(publicHost || store.slug + '.example.com')}/products/${esc(product.slug)}</div>
              <div class="pd-seo-desc">${esc(seoDescPreview)}</div>
            </div>
            <div class="pd-seo-editor" id="pdSeoEditor" hidden>
              <label class="pd-label">Page title</label>
              <input type="text" name="seo_title" form="pdMainForm" value="${esc(product.seo_title ?? '')}" class="pd-input pd-input-sm" maxlength="70" placeholder="${esc(product.title)}">
              <div class="pd-counter"><span id="seoTitleCounter">${(product.seo_title ?? '').length}</span> / 70</div>

              <label class="pd-label" style="margin-top:10px">Meta description</label>
              <textarea name="seo_description" form="pdMainForm" class="pd-input pd-input-sm" rows="3" maxlength="320" placeholder="${esc(seoDescPreview || 'Write a description for search engines...')}">${esc(product.seo_description ?? '')}</textarea>
              <div class="pd-counter"><span id="seoDescCounter">${(product.seo_description ?? '').length}</span> / 320</div>

              <label class="pd-label" style="margin-top:10px">URL handle</label>
              <div class="pd-url-wrap">
                <span class="pd-url-prefix">/products/</span>
                <input type="text" name="slug" form="pdMainForm" value="${esc(product.slug)}" class="pd-input pd-input-sm" pattern="[a-z0-9\\-]+" title="Lowercase letters, numbers and dashes only">
              </div>
            </div>

            <!-- Phase 2 PR6 — SEO metafield shortcut.
                 Shopify storefront themes increasingly read product
                 metafields (e.g. {{ product.metafields.seo.title }})
                 for richer structured data. This shortcut upserts the
                 seo.title / seo.description / seo.handle metafields in
                 one click, pre-filled from the native SEO fields above,
                 so sellers don't have to do the "Add custom field"
                 dance three times. The native columns are left
                 untouched (the preview still renders from them). -->
            <div class="pd-seo-shortcut">
              <button type="button" class="btn btn-outline btn-sm" id="pdSeoShortcutBtn">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><path d="M12 2H4a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2z"/><path d="M5 8h6M8 5v6"/></svg>
                Mirror to metafields (seo.title, seo.description, seo.handle)
              </button>
            </div>
          </section>

          <!-- SEO SHORTCUT MODAL -->
          <div class="gbx-modal-overlay" id="pdSeoShortcutModal" onclick="if(event.target===this) closeSeoShortcut()">
            <form class="gbx-modal" role="dialog" aria-labelledby="pdSeoShortcutTitle" aria-modal="true"
                  method="POST" action="${base}/products/${esc(product.id)}/seo-shortcut">
              ${csrfHiddenField(req.csrfToken!)}
              <h2 class="gbx-modal-title info" id="pdSeoShortcutTitle">SEO metafield shortcut</h2>
              <p class="muted">Writes three metafields in the <code>seo</code> namespace so storefront themes can read them. Leave any field blank to skip it.</p>
              <label class="pd-label">seo.title</label>
              <input type="text" name="seoTitle" maxlength="255" class="pd-input pd-input-sm" value="${esc(product.seo_title || product.title || '')}">
              <label class="pd-label" style="margin-top:8px">seo.description</label>
              <textarea name="seoDescription" maxlength="500" rows="3" class="pd-input pd-input-sm">${esc(product.seo_description ?? '')}</textarea>
              <label class="pd-label" style="margin-top:8px">seo.handle</label>
              <input type="text" name="seoHandle" maxlength="255" class="pd-input pd-input-sm" value="${esc(product.slug ?? '')}">
              <div class="gbx-modal-actions">
                <button type="button" class="btn btn-outline" onclick="closeSeoShortcut()">Cancel</button>
                <button type="submit" class="btn btn-primary">Save metafields</button>
              </div>
            </form>
          </div>
          <style>
            .pd-seo-shortcut { margin-top:14px; padding-top:12px; border-top:1px dashed var(--s-border, #e5e7eb); }
            .gbx-modal-title.info { color:var(--s-accent, #6366f1); }
            .gbx-modal code { background:rgba(99,102,241,.1); padding:1px 6px; border-radius:4px; font-size:12px; }
          </style>
        </div>

        <!-- ════════════════ RIGHT COLUMN ════════════════ -->
        <div class="pd-right-col">

          <!-- Product availability -->
          <section class="pd-card pd-compact">
            <h4 class="pd-side-title">Product availability</h4>
            <p class="pd-side-help">Manage the availability of this product in these channels</p>
            <label class="pd-check pd-check-block">
              <input type="checkbox" name="avail_listing" form="pdMainForm" value="1" ${product.status !== 'archived' ? 'checked' : ''}>
              <span>
                <strong>Online store listing pages</strong>
                <em>Homepage, collection page, search page…</em>
              </span>
            </label>
            <label class="pd-check pd-check-block">
              <input type="checkbox" name="avail_sitemap" form="pdMainForm" value="1" ${product.status === 'active' ? 'checked' : ''}>
              <span>
                <strong>Search Engine Bot Crawlers, Sitemap files</strong>
              </span>
            </label>
          </section>

          <!-- Organization -->
          <section class="pd-card pd-compact">
            <h4 class="pd-side-title">Organization</h4>

            <label class="pd-side-label">Product type</label>
            <input type="text" name="product_type" form="pdMainForm" value="${esc(product.product_type ?? '')}" class="pd-input pd-input-sm" placeholder="Product type" list="pdProductTypes">
            <datalist id="pdProductTypes">
              <option value="T-Shirt"></option>
              <option value="Hoodie"></option>
              <option value="Mug"></option>
              <option value="Poster"></option>
              <option value="Accessory"></option>
            </datalist>

            <label class="pd-side-label">Vendor</label>
            <input type="text" name="vendor" form="pdMainForm" value="${esc(product.vendor ?? '')}" class="pd-input pd-input-sm" placeholder="${esc(store.name)}">

            <label class="pd-side-label">Collections</label>
            <div class="pd-coll-wrap" id="pdCollWrap">
              <div class="pd-coll-selected" id="pdCollSelected">
                ${Array.from(selectedCollectionIds)
                  .map((cid) => {
                    const c = allCollections.find((x: any) => x.id === cid) as any
                    return c
                      ? `<span class="pd-coll-chip" data-cid="${esc(cid)}">${esc(c.title)} <button type="button" aria-label="remove" data-remove-coll="${esc(cid)}">×</button></span>`
                      : ''
                  })
                  .join('')}
              </div>
              <div class="pd-coll-input-wrap">
                <input type="text" id="pdCollSearch" class="pd-input pd-input-sm" placeholder="Search for collections" autocomplete="off">
                <div class="pd-coll-dropdown" id="pdCollDropdown" hidden></div>
              </div>
              <input type="hidden" name="collection_ids" form="pdMainForm" id="pdCollHidden" value="${Array.from(selectedCollectionIds).join(',')}">
              <p class="pd-side-help">
                Add this product to a collection so it's easy to find in your store.
                <a href="${base}/products/collections/new" class="pd-learn">+ New</a>
              </p>
            </div>

            <label class="pd-side-label">Tags <a href="${base}/products?q=" class="pd-link pd-link-inline" id="pdViewAllTags">View all tags</a></label>
            <input type="text" name="tags" form="pdMainForm" id="pdTagsInput" value="${esc(tags.join(', '))}" class="pd-input pd-input-sm" placeholder="Vintage, cotton, summer" list="pdAllTags">
            <datalist id="pdAllTags">
              ${allTags.map((t) => `<option value="${esc(t)}"></option>`).join('')}
            </datalist>
          </section>

          <!-- Fulfillment services -->
          <section class="pd-card pd-compact">
            <h4 class="pd-side-title">Fulfillment services</h4>
            ${
              isPod
                ? `
              <div class="pd-fulfill-row">
                <div class="pd-fulfill-logo pd-fulfill-logo-printhub">LF</div>
                <div class="pd-fulfill-body">
                  <div class="pd-fulfill-name">Lenful (managed by Gbox)</div>
                  <div class="pd-fulfill-sub">Gbox pushes every paid POD order to Lenful automatically. You don't need to map products or upload files.</div>
                </div>
              </div>
            `
                : `
              <div class="pd-fulfill-row">
                <div class="pd-fulfill-body">
                  <div class="pd-fulfill-name">Unmanaged</div>
                  <div class="pd-fulfill-sub">Non-POD products are fulfilled by you. Manage each order from the Orders page.</div>
                </div>
              </div>
            `
            }
          </section>

          <!-- Online store theme template -->
          <section class="pd-card pd-compact">
            <h4 class="pd-side-title">Online store</h4>
            <p class="pd-side-help">Your current theme is ${isPod ? '<strong>Imprimé – V2.0.0</strong>' : '<strong>Chic</strong>'}. Assign a template from it to define how the product is displayed. <a href="${base}/online-store/themes" class="pd-learn">Learn more</a></p>
            <label class="pd-side-label">Theme template</label>
            <select class="pd-input pd-input-sm" name="template_suffix" form="pdMainForm">
              <option value="" ${!product.template_suffix ? 'selected' : ''}>Default</option>
              <option value="featured" ${product.template_suffix === 'featured' ? 'selected' : ''}>Featured</option>
              <option value="sale" ${product.template_suffix === 'sale' ? 'selected' : ''}>Sale</option>
            </select>
            <a href="${base}/online-store/themes" class="pd-link pd-link-block">+ Create a new template</a>
          </section>

          <!-- Reviews -->
          <section class="pd-card pd-compact">
            <div class="pd-side-title-row">
              <h4 class="pd-side-title">Reviews</h4>
              <span class="pd-side-note">Your reviews are ready <svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 10l4 4 8-8"/></svg></span>
            </div>
            <div class="pd-review-row"><span>Total reviews:</span> <strong>0</strong></div>
            <div class="pd-review-row"><span>Average rating:</span> <strong>0.00</strong></div>
            <a href="${base}/products/reviews" class="pd-secondary-btn pd-secondary-btn-sm">Import reviews</a>
          </section>

          <!-- Bundles -->
          <section class="pd-card pd-compact">
            <h4 class="pd-side-title">Bundles</h4>
            <p class="pd-side-help">Create an attractive combo with this product to sell more.</p>
            <a href="${base}/discounts/new?type=bundle&product=${encodeURIComponent(product.id)}" class="pd-secondary-btn pd-secondary-btn-sm">Create bundle</a>
          </section>

          <!-- Quantity discounts -->
          <section class="pd-card pd-compact">
            <h4 class="pd-side-title">Quantity discounts</h4>
            <p class="pd-side-help">Set up discounts to encourage buyers to buy in bulk.</p>
            <a href="${base}/discounts/new?type=volume&product=${encodeURIComponent(product.id)}" class="pd-secondary-btn pd-secondary-btn-sm">Add discounts</a>
          </section>

          <!-- Custom data (metafields) -->
          <section class="pd-card pd-compact" id="pdMetafieldsCard">
            <div class="pd-side-title-row">
              <h4 class="pd-side-title">Custom data</h4>
              <button type="button" id="pdMfAddBtn" class="pd-link pd-link-inline" aria-label="Add custom field">+ Add</button>
            </div>
            <p class="pd-side-help">Custom fields (Shopify metafields) you can read from themes, storefront API, and automations. Namespace.key tuples are unique per product.</p>
            <div class="pd-mf-list" id="pdMfList">
              ${renderProductMetafields(productMetafields, product.id, base, csrfField)}
            </div>
          </section>

          <!-- Facebook Pixel & CAPI -->
          <section class="pd-card pd-compact">
            <h4 class="pd-side-title">Facebook Pixel &amp; Conversion API</h4>
            <p class="pd-side-help">Gbox will send tracking events related to this product via both Facebook Pixel and Conversions API. Configure pixel credentials at the store level — the same pixel fires on every product page.</p>
            <a href="${base}/storefront-clone/pixels" class="pd-secondary-btn pd-secondary-btn-sm">Configure pixel</a>
            <p class="pd-side-help" style="margin-top:8px">This feature will only work after you finish setting up Facebook tracking for your store in <a href="${base}/settings" class="pd-learn">Preference settings</a>. <a href="${base}/storefront-clone/pixels" class="pd-learn">Learn more</a></p>
          </section>
        </div>
      </div>

      <!-- Metafield modal (hidden until +Add clicked) -->
      <div class="pd-mf-modal" id="pdMfModal" hidden>
        <div class="pd-mf-modal-backdrop" data-close-mf-modal></div>
        <form class="pd-mf-modal-panel" method="POST" action="${base}/products/${encodeURIComponent(product.id)}/metafields">
          ${csrfField}
          <div class="pd-mf-modal-header">
            <h3>Add custom field</h3>
            <button type="button" class="pd-mf-modal-close" data-close-mf-modal aria-label="Close">×</button>
          </div>
          <div class="pd-mf-modal-body">
            <label class="pd-side-label">Namespace</label>
            <input type="text" name="namespace" class="pd-input pd-input-sm" placeholder="custom" required pattern="[a-zA-Z0-9_-]{3,255}" title="3-255 chars, alphanumeric/underscore/hyphen">
            <p class="pd-side-help">3-255 chars. Use a vendor prefix like "my_app" to avoid collisions.</p>

            <label class="pd-side-label">Key</label>
            <input type="text" name="key" class="pd-input pd-input-sm" placeholder="care_instructions" required pattern="[a-zA-Z0-9_-]{3,64}" title="3-64 chars, alphanumeric/underscore/hyphen">

            <label class="pd-side-label">Type</label>
            <select name="value_type" class="pd-input pd-input-sm" required>
              ${METAFIELD_VALUE_TYPES.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
            </select>

            <label class="pd-side-label">Value</label>
            <textarea name="value" class="pd-input pd-input-sm" rows="4" placeholder="Machine wash cold, tumble dry low." required></textarea>
            <p class="pd-side-help">Max 5&nbsp;MB. For JSON type, paste valid JSON (e.g. <code>{"size":"L"}</code>).</p>

            <label class="pd-side-label">Description (optional)</label>
            <input type="text" name="description" class="pd-input pd-input-sm" placeholder="Shown to staff when editing">
          </div>
          <div class="pd-mf-modal-footer">
            <button type="button" class="btn btn-outline" data-close-mf-modal>Cancel</button>
            <button type="submit" class="btn btn-primary">Save custom field</button>
          </div>
        </form>
      </div>

      <!-- Footer actions -->
      <div class="pd-footer">
        <div class="pd-footer-left">
          <div class="pd-created">Created ${esc(createdLabel)}</div>
        </div>
        <div class="pd-footer-right">
          <button type="submit" form="pdDeleteForm" formaction="${base}/products/${encodeURIComponent(product.id)}/delete" class="btn btn-danger">Delete product</button>
          <button type="submit" form="pdMainForm" class="btn btn-primary">Save</button>
        </div>
      </div>
    </div><!-- /.pd-form-outer -->

    <!-- Hidden delete form so the red button can POST without the main form's fields -->
    <form id="pdDeleteForm" method="POST" action="${base}/products/${encodeURIComponent(product.id)}/delete" style="display:none">
      ${csrfField}
      <input type="hidden" name="confirm" value="1">
    </form>

    <style>
      /* ===== ShopBase-parity product detail ===== */
      .pd-flash { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
      .pd-flash-ok { background: rgba(34,197,94,.12); color: #4ade80; border: 1px solid rgba(34,197,94,.3); }
      .pd-flash-err { background: rgba(239,68,68,.12); color: #f87171; border: 1px solid rgba(239,68,68,.3); }

      .pd-topbar {
        display: flex; align-items: center; gap: 16px;
        padding: 8px 0 16px; flex-wrap: wrap;
      }
      .pd-back {
        display: inline-flex; align-items: center; gap: 6px;
        color: var(--s-text-muted); text-decoration: none;
        font-size: 11px; font-weight: 700; letter-spacing: .06em;
      }
      .pd-back:hover { color: var(--s-text); }
      .pd-title { margin: 0; font-size: 22px; font-weight: 700; color: var(--s-text); flex: 1; min-width: 240px; }
      .pd-topbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .pd-chip-btn {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 6px 10px; border-radius: 6px; font-size: 12px; font-weight: 500;
        background: var(--s-card); color: var(--s-text); border: 1px solid var(--s-border);
        text-decoration: none; cursor: pointer;
      }
      .pd-chip-btn:hover { border-color: var(--s-border-light); }
      .pd-chip-btn-muted { opacity: 0.55; font-style: italic; }
      .pd-chip-btn-muted:hover { opacity: 0.85; }

      .pd-form { display: block; }
      .pd-grid {
        display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px;
        align-items: start;
      }
      @media (max-width: 1100px) { .pd-grid { grid-template-columns: 1fr; } }

      .pd-left { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
      .pd-right-col { display: flex; flex-direction: column; gap: 16px; }

      .pd-card {
        background: var(--s-card); border: 1px solid var(--s-border);
        border-radius: 10px; padding: 16px 18px;
      }
      .pd-compact { padding: 14px 16px; }

      .pd-label { display: block; font-size: 12px; font-weight: 600; color: var(--s-text); margin-bottom: 6px; }
      .pd-label-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
      .pd-hint {
        display: inline-flex; align-items: center; justify-content: center;
        width: 14px; height: 14px; border-radius: 50%;
        background: var(--s-border); color: var(--s-text-muted); font-size: 10px;
      }
      .pd-input {
        width: 100%; padding: 8px 12px;
        background: var(--s-bg); color: var(--s-text);
        border: 1px solid var(--s-border); border-radius: 6px;
        font-size: 13px; outline: none;
      }
      .pd-input:focus { border-color: var(--s-accent, #6366f1); }
      .pd-input-sm { padding: 7px 10px; font-size: 12px; }
      .pd-counter { font-size: 11px; color: var(--s-text-muted); margin-top: 4px; text-align: right; }
      .pd-help { font-size: 12px; color: var(--s-text-muted); margin: 6px 0 10px; line-height: 1.5; }
      .pd-learn { color: var(--s-accent, #6366f1); text-decoration: none; }
      .pd-learn:hover { text-decoration: underline; }

      .pd-secondary-btn {
        padding: 7px 14px; border-radius: 6px; font-size: 12px; font-weight: 500;
        background: var(--s-card); color: var(--s-text); border: 1px solid var(--s-border-light);
        cursor: pointer;
      }
      .pd-secondary-btn:disabled { opacity: .6; cursor: not-allowed; }
      .pd-secondary-btn-sm { padding: 6px 12px; font-size: 11px; }

      /* Rich-text toolbar */
      .pd-rt-toolbar {
        display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
        background: var(--s-bg); border: 1px solid var(--s-border);
        border-radius: 6px 6px 0 0; padding: 5px 6px;
        border-bottom: none;
      }
      .pd-rt-btn {
        min-width: 24px; height: 24px; padding: 0 6px;
        background: transparent; border: 0; border-radius: 3px;
        color: var(--s-text); cursor: pointer; font-size: 12px;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .pd-rt-btn:hover { background: var(--s-border); }
      .pd-rt-swatch { width: 8px; height: 2px; background: currentColor; display: inline-block; margin-left: 2px; }
      .pd-rt-select {
        height: 24px; padding: 0 4px; font-size: 11px;
        background: transparent; color: var(--s-text); border: 0; border-radius: 3px;
      }
      .pd-rt-select:disabled { color: var(--s-text-muted); }
      .pd-rt-sep { width: 1px; height: 16px; background: var(--s-border); margin: 0 4px; }
      .pd-rt-spacer { flex: 1; }
      .pd-rt-surface {
        background: var(--s-bg); border: 1px solid var(--s-border);
        border-radius: 0 0 6px 6px;
      }
      .pd-rt-content {
        min-height: 260px; padding: 12px 14px; font-size: 13px; line-height: 1.6; color: var(--s-text);
        outline: none;
      }
      .pd-rt-content:empty::before { content: 'Description'; color: var(--s-text-muted); }
      .pd-rt-content img { max-width: 100%; height: auto; border-radius: 4px; }

      /* Section header w/ link group */
      .pd-section-header {
        display: flex; justify-content: space-between; align-items: flex-end;
        margin-bottom: 10px; gap: 12px;
      }
      .pd-section-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--s-text); }
      .pd-link-group { display: flex; gap: 14px; }
      .pd-link {
        font-size: 12px; color: var(--s-accent, #6366f1); text-decoration: none;
      }
      .pd-link:hover { text-decoration: underline; }
      .pd-link-inline { float: right; }
      .pd-link-block { display: block; margin-top: 8px; font-size: 12px; color: var(--s-accent, #6366f1); text-decoration: none; }
      .pd-mini-btn {
        padding: 3px 10px; font-size: 11px;
        background: transparent; color: var(--s-accent, #6366f1);
        border: 0; cursor: pointer;
      }

      /* Media */
      .pd-media-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
        gap: 10px;
      }
      .pd-media-tile {
        aspect-ratio: 1; border: 1px solid var(--s-border); border-radius: 6px;
        overflow: hidden; background: var(--s-bg);
      }
      .pd-media-primary { grid-column: span 2; grid-row: span 2; }
      .pd-media-tile img { width: 100%; height: 100%; object-fit: cover; }
      .pd-media-empty {
        border: 1.5px dashed var(--s-border-light);
        border-radius: 8px; padding: 30px;
        text-align: center; color: var(--s-text-muted);
      }
      .pd-media-empty svg { margin-bottom: 8px; opacity: .4; }
      .pd-media-empty p { margin: 0; font-size: 13px; }

      /* Personalization pills */
      .pd-pill-group { display: flex; gap: 10px; flex-wrap: wrap; }
      .pd-pill {
        padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 500;
        background: var(--s-bg); color: var(--s-text); border: 1px solid var(--s-border);
        cursor: pointer; text-decoration: none; display: inline-block;
      }
      .pd-pill:disabled, .pd-pill-disabled { opacity: .55; cursor: not-allowed; pointer-events: none; }
      .pd-badge-coming {
        display: inline-block; margin-left: 8px; padding: 2px 8px;
        font-size: 10px; font-weight: 600; text-transform: uppercase;
        background: rgba(99, 102, 241, 0.12); color: #818cf8;
        border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 10px;
        vertical-align: middle;
      }

      /* Variant options */
      .pd-option { padding: 10px 0; border-top: 1px solid var(--s-border); }
      .pd-option:first-of-type { border-top: 0; }
      .pd-option-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
      .pd-option-name { font-size: 12px; font-weight: 600; color: var(--s-text); }
      .pd-option-values { display: flex; flex-wrap: wrap; gap: 6px; }
      .pd-value-pill {
        padding: 4px 10px; border-radius: 4px; font-size: 11px;
        background: var(--s-bg); color: var(--s-text); border: 1px solid var(--s-border);
      }
      .pd-group-toggle {
        margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--s-border);
        display: flex; align-items: center; gap: 12px;
      }
      .pd-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--s-text); cursor: pointer; }
      .pd-check input[type="checkbox"] { margin: 0; }
      .pd-check-block { display: flex; align-items: flex-start; margin-top: 8px; gap: 8px; }
      .pd-check-block strong { display: block; font-size: 12px; color: var(--s-text); font-weight: 600; }
      .pd-check-block em { display: block; font-size: 11px; color: var(--s-text-muted); font-style: normal; margin-top: 2px; }

      /* Variants table */
      .pd-var-select-bar {
        display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
        padding: 8px 0; font-size: 11px;
      }
      .pd-muted { color: var(--s-text-muted); }
      .pd-mini-link { color: var(--s-accent, #6366f1); text-decoration: none; font-size: 11px; }
      .pd-mini-link:hover { text-decoration: underline; }
      .pd-var-sep { color: var(--s-border-light); }
      .pd-var-tablewrap { overflow-x: auto; margin: 0 -18px -16px; }
      .pd-var-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .pd-var-table thead th {
        text-align: left; padding: 8px 10px; font-size: 11px; font-weight: 600;
        color: var(--s-text-muted); border-bottom: 1px solid var(--s-border);
        white-space: nowrap;
      }
      .pd-var-table tbody td {
        padding: 10px; border-bottom: 1px solid var(--s-border);
        color: var(--s-text);
      }
      .pd-var-check { width: 32px; text-align: center; }
      .pd-var-img { width: 44px; }
      .pd-var-img img, .pd-var-noimg {
        width: 32px; height: 32px; border-radius: 4px;
        background: var(--s-bg); border: 1px solid var(--s-border);
        object-fit: cover; display: flex; align-items: center; justify-content: center;
        color: var(--s-text-muted);
      }
      .pd-var-opt { color: var(--s-text); }
      .pd-right { text-align: right; }
      .pd-inv-zero { color: #ef4444; }
      .pd-var-sku { color: var(--s-text-muted); font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
      .pd-var-tag { color: var(--s-text-muted); }
      .pd-var-mf-badge {
        display: inline-flex;
        align-items: center;
        height: 20px;
        padding: 0 8px;
        border-radius: 10px;
        background: #eef2ff;
        color: #3730a3;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.2px;
        line-height: 1;
        white-space: nowrap;
      }
      .pd-var-edit { width: 36px; text-align: center; }
      .pd-icon-btn {
        width: 24px; height: 24px; padding: 0; border-radius: 4px;
        background: transparent; color: var(--s-text-muted); border: 0; cursor: pointer;
      }
      .pd-icon-btn:hover { background: var(--s-border); color: var(--s-text); }

      /* SEO preview */
      .pd-seo-preview {
        padding: 12px 14px; border: 1px solid var(--s-border);
        border-radius: 6px; background: var(--s-bg);
      }
      .pd-seo-title { font-size: 15px; color: #818cf8; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pd-seo-url { font-size: 11px; color: #86efac; margin-bottom: 4px; }
      .pd-seo-desc { font-size: 12px; color: var(--s-text-muted); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

      /* Right sidebar */
      .pd-side-title { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--s-text); }
      .pd-side-title-row { display: flex; justify-content: space-between; align-items: center; }
      .pd-side-note { font-size: 11px; color: #4ade80; display: inline-flex; align-items: center; gap: 4px; }
      .pd-side-help { font-size: 11px; color: var(--s-text-muted); margin: 0 0 10px; line-height: 1.5; }
      .pd-side-label { display: block; font-size: 11px; font-weight: 600; color: var(--s-text); margin: 10px 0 4px; }

      .pd-coll-wrap { }
      .pd-coll-selected { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
      .pd-coll-chip {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 8px; border-radius: 4px;
        background: var(--s-bg); border: 1px solid var(--s-border);
        font-size: 11px; color: var(--s-text);
      }
      .pd-coll-chip button {
        background: transparent; border: 0; color: var(--s-text-muted); cursor: pointer;
        font-size: 14px; line-height: 1; padding: 0;
      }

      .pd-fulfill-row { display: flex; gap: 10px; }
      .pd-fulfill-logo {
        width: 32px; height: 32px; border-radius: 6px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 11px; color: #fff;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
      }
      .pd-fulfill-logo-printhub { background: linear-gradient(135deg, #818cf8, #a78bfa); }
      .pd-fulfill-body { flex: 1; }
      .pd-fulfill-name { font-size: 12px; font-weight: 600; color: var(--s-text); }
      .pd-fulfill-sub { font-size: 11px; color: var(--s-text-muted); margin: 3px 0 8px; line-height: 1.4; }

      .pd-review-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--s-text-muted); margin-bottom: 4px; }
      .pd-review-row strong { color: var(--s-text); font-weight: 600; }

      /* Inline forms (topbar actions, variant cells, media remove) */
      .pd-inline-form { display: inline-flex; margin: 0; }
      .pd-inline-form button { font: inherit; }

      /* Media URL form */
      .pd-media-url-form {
        display: flex; gap: 8px; align-items: center;
        padding: 10px 12px; margin-bottom: 10px;
        background: var(--s-bg); border: 1px solid var(--s-border);
        border-radius: 6px; flex-wrap: wrap;
      }
      .pd-media-url-form .pd-input { flex: 1; min-width: 180px; }
      .pd-media-tile { position: relative; }
      .pd-media-remove {
        position: absolute; top: 4px; right: 4px; margin: 0;
      }
      .pd-media-remove button {
        width: 20px; height: 20px; border-radius: 50%;
        background: rgba(0,0,0,.65); color: #fff;
        border: 0; cursor: pointer; font-size: 14px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      }
      .pd-media-remove button:hover { background: rgba(239,68,68,.85); }

      /* Variant inline cells */
      .pd-var-inline { display: inline-block; margin: 0; }
      .pd-var-cell-input {
        width: 90px; padding: 4px 6px; font-size: 12px;
        background: transparent; color: var(--s-text);
        border: 1px solid transparent; border-radius: 4px;
        text-align: inherit; outline: none;
      }
      .pd-var-cell-input:focus {
        background: var(--s-bg); border-color: var(--s-accent, #6366f1);
      }
      .pd-var-cell-input:hover { border-color: var(--s-border); }
      .pd-var-cell-mono { font-family: ui-monospace, Menlo, monospace; width: 120px; }
      .pd-saved-flash { background: rgba(34,197,94,.15) !important; border-color: #4ade80 !important; }
      .pd-save-err { background: rgba(239,68,68,.15) !important; border-color: #f87171 !important; }

      /* Add variant form */
      .pd-var-add-form {
        margin: 10px 0 14px; padding: 12px 14px;
        background: var(--s-bg); border: 1px dashed var(--s-border-light);
        border-radius: 6px;
      }
      .pd-var-add-row {
        display: flex; gap: 10px; flex-wrap: wrap; align-items: end;
      }
      .pd-var-add-field { display: flex; flex-direction: column; min-width: 110px; flex: 1; }
      .pd-var-add-field label {
        font-size: 10px; font-weight: 600; color: var(--s-text-muted);
        text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px;
      }
      .pd-var-add-field input {
        padding: 6px 10px; font-size: 12px;
        background: var(--s-card); color: var(--s-text);
        border: 1px solid var(--s-border); border-radius: 4px;
        outline: none;
      }
      .pd-var-add-field input:focus { border-color: var(--s-accent, #6366f1); }

      /* Filter active state */
      .pd-filter-active { font-weight: 700; text-decoration: underline; }

      /* Collection typeahead dropdown */
      .pd-coll-input-wrap { position: relative; }
      .pd-coll-dropdown {
        position: absolute; top: calc(100% + 2px); left: 0; right: 0;
        max-height: 220px; overflow-y: auto; z-index: 20;
        background: var(--s-card); border: 1px solid var(--s-border);
        border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.2);
      }
      .pd-coll-opt {
        padding: 7px 10px; font-size: 12px; color: var(--s-text);
        cursor: pointer;
      }
      .pd-coll-opt:hover { background: var(--s-bg); }
      .pd-coll-empty { padding: 10px; font-size: 11px; color: var(--s-text-muted); text-align: center; }

      /* SEO editor */
      .pd-seo-editor { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--s-border); }
      .pd-url-wrap {
        display: flex; align-items: center;
        background: var(--s-bg); border: 1px solid var(--s-border); border-radius: 6px;
        padding: 0 0 0 10px; overflow: hidden;
      }
      .pd-url-prefix { font-size: 11px; color: var(--s-text-muted); font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
      .pd-url-wrap .pd-input {
        border: 0; background: transparent; padding-left: 4px;
      }
      .pd-url-wrap .pd-input:focus { box-shadow: inset 0 -1px 0 var(--s-accent, #6366f1); }

      /* Footer */
      .pd-footer {
        display: flex; justify-content: space-between; align-items: center;
        margin-top: 20px; padding: 16px 0;
        border-top: 1px solid var(--s-border);
      }
      .pd-created { font-size: 11px; color: var(--s-text-muted); }
      .pd-footer-right { display: flex; gap: 10px; }

      /* Custom data (metafields) sidebar card */
      .pd-mf-list { display: flex; flex-direction: column; gap: 6px; }
      .pd-mf-empty { margin: 0; }
      .pd-mf-row {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border-radius: 6px;
        background: var(--s-bg); border: 1px solid var(--s-border);
      }
      .pd-mf-row-main { flex: 1; min-width: 0; }
      .pd-mf-tuple {
        font-size: 12px; font-weight: 600; color: var(--s-text);
        word-break: break-all;
      }
      .pd-mf-sep { color: var(--s-text-muted); margin: 0 2px; }
      .pd-mf-type {
        display: inline-block; padding: 1px 6px; margin-top: 2px;
        background: var(--s-border); color: var(--s-text-muted);
        border-radius: 3px; font-size: 10px; font-family: ui-monospace, monospace;
      }
      .pd-mf-value {
        font-size: 11px; color: var(--s-text-muted);
        margin-top: 3px; word-break: break-all;
        font-family: ui-monospace, monospace;
      }
      .pd-mf-del { flex-shrink: 0; }
      .pd-mf-del-btn {
        background: transparent; border: 1px solid var(--s-border);
        color: var(--s-text-muted); width: 22px; height: 22px;
        border-radius: 4px; cursor: pointer; font-size: 12px;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .pd-mf-del-btn:hover { color: #f87171; border-color: #f87171; }

      /* Metafield "add" modal */
      .pd-mf-modal {
        position: fixed; inset: 0; z-index: 1000;
        display: flex; align-items: center; justify-content: center;
      }
      .pd-mf-modal[hidden] { display: none; }
      .pd-mf-modal-backdrop {
        position: absolute; inset: 0; background: rgba(0,0,0,.5);
      }
      .pd-mf-modal-panel {
        position: relative; width: 480px; max-width: calc(100vw - 32px);
        max-height: calc(100vh - 80px); overflow-y: auto;
        background: var(--s-card); border: 1px solid var(--s-border);
        border-radius: 12px; padding: 0;
      }
      .pd-mf-modal-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px; border-bottom: 1px solid var(--s-border);
      }
      .pd-mf-modal-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
      .pd-mf-modal-close {
        background: transparent; border: none; color: var(--s-text-muted);
        font-size: 22px; cursor: pointer; line-height: 1;
      }
      .pd-mf-modal-body { padding: 16px 20px; }
      .pd-mf-modal-body .pd-side-label { margin-top: 10px; }
      .pd-mf-modal-body .pd-side-label:first-child { margin-top: 0; }
      .pd-mf-modal-footer {
        display: flex; justify-content: flex-end; gap: 8px;
        padding: 12px 20px; border-top: 1px solid var(--s-border);
      }
    </style>

    <script>
      (function(){
        // ── Title counter ───────────────────────────────────────────
        // NOTE: title input lives OUTSIDE the main <form> element now (it uses
        // form="pdMainForm" attribute instead), so we query it by name directly.
        var titleInput = document.querySelector('input[name="title"][form="pdMainForm"]')
        var titleCounter = document.getElementById('titleCounter')
        if (titleInput && titleCounter) {
          titleInput.addEventListener('input', function(){
            titleCounter.textContent = titleInput.value.length
          })
        }

        // ── Rich-text: sync contenteditable → hidden textarea ───────
        var editor = document.getElementById('pdRtEditor')
        var bodyField = document.getElementById('pdBodyField')
        var form = document.getElementById('pdMainForm')
        if (form && editor && bodyField) {
          form.addEventListener('submit', function(){
            bodyField.value = editor.innerHTML
          })
        }
        document.querySelectorAll('.pd-rt-btn[data-cmd]').forEach(function(btn){
          btn.addEventListener('click', function(e){
            e.preventDefault()
            if (editor) editor.focus()
            try { document.execCommand(btn.getAttribute('data-cmd'), false) } catch (_) {}
          })
        })

        // ── Delete confirmation ─────────────────────────────────────
        var deleteBtn = document.querySelector('.pd-footer .btn-danger')
        if (deleteBtn) {
          deleteBtn.addEventListener('click', function(e){
            if (!confirm('Permanently delete this product and all its variants? This cannot be undone.')) {
              e.preventDefault()
            }
          })
        }

        // ── SEO editor toggle + counters ────────────────────────────
        var seoToggle = document.getElementById('pdToggleSeoEdit')
        var seoEditor = document.getElementById('pdSeoEditor')
        if (seoToggle && seoEditor) {
          seoToggle.addEventListener('click', function(e){
            e.preventDefault()
            if (seoEditor.hasAttribute('hidden')) seoEditor.removeAttribute('hidden')
            else seoEditor.setAttribute('hidden', '')
          })
        }

        // Phase 2 PR6 — SEO metafield shortcut.
        // The shortcut button opens a modal pre-filled from the native
        // seo_title / seo_description / slug inputs so merchants can
        // mirror to metafields in one click. Values stay editable in
        // the modal in case they want to override.
        var seoShortcutBtn = document.getElementById('pdSeoShortcutBtn')
        if (seoShortcutBtn) {
          seoShortcutBtn.addEventListener('click', function(){
            var titleInput = document.querySelector('input[name="seo_title"]')
            var descInput = document.querySelector('textarea[name="seo_description"]')
            var handleInput = document.querySelector('input[name="slug"]')
            var modal = document.getElementById('pdSeoShortcutModal')
            if (!modal) return
            var modalTitle = modal.querySelector('input[name="seoTitle"]')
            var modalDesc = modal.querySelector('textarea[name="seoDescription"]')
            var modalHandle = modal.querySelector('input[name="seoHandle"]')
            if (modalTitle && titleInput && titleInput.value) modalTitle.value = titleInput.value
            if (modalDesc && descInput && descInput.value) modalDesc.value = descInput.value
            if (modalHandle && handleInput && handleInput.value) modalHandle.value = handleInput.value
            modal.classList.add('show')
          })
        }
        window.closeSeoShortcut = function(){
          var m = document.getElementById('pdSeoShortcutModal')
          if (m) m.classList.remove('show')
        }
        var seoTitleInput = document.querySelector('input[name="seo_title"]')
        var seoTitleCounter = document.getElementById('seoTitleCounter')
        if (seoTitleInput && seoTitleCounter) {
          seoTitleInput.addEventListener('input', function(){
            seoTitleCounter.textContent = seoTitleInput.value.length
          })
        }
        var seoDescInput = document.querySelector('textarea[name="seo_description"]')
        var seoDescCounter = document.getElementById('seoDescCounter')
        if (seoDescInput && seoDescCounter) {
          seoDescInput.addEventListener('input', function(){
            seoDescCounter.textContent = seoDescInput.value.length
          })
        }
        // Live SEO preview mirror
        var seoPreviewTitle = document.querySelector('#pdSeoPreview .pd-seo-title')
        var seoPreviewDesc = document.querySelector('#pdSeoPreview .pd-seo-desc')
        var seoPreviewUrl = document.querySelector('#pdSeoPreview .pd-seo-url')
        var slugInput = document.querySelector('input[name="slug"]')
        if (titleInput && seoPreviewTitle) {
          titleInput.addEventListener('input', function(){
            if (seoTitleInput && !seoTitleInput.value) {
              seoPreviewTitle.textContent = titleInput.value
            }
          })
        }
        if (seoTitleInput && seoPreviewTitle) {
          seoTitleInput.addEventListener('input', function(){
            seoPreviewTitle.textContent = seoTitleInput.value || (titleInput ? titleInput.value : '')
          })
        }
        if (seoDescInput && seoPreviewDesc) {
          seoDescInput.addEventListener('input', function(){
            seoPreviewDesc.textContent = seoDescInput.value
          })
        }
        if (slugInput && seoPreviewUrl) {
          slugInput.addEventListener('input', function(){
            var host = seoPreviewUrl.textContent.split('/products/')[0]
            seoPreviewUrl.textContent = host + '/products/' + slugInput.value
          })
        }

        // ── Media URL form toggle ───────────────────────────────────
        var mediaToggle = document.getElementById('pdToggleMediaUrl')
        var mediaForm = document.getElementById('pdAddMediaUrl')
        if (mediaToggle && mediaForm) {
          mediaToggle.addEventListener('click', function(e){
            e.preventDefault()
            if (mediaForm.hasAttribute('hidden')) {
              mediaForm.removeAttribute('hidden')
              var first = mediaForm.querySelector('input[name="src"]')
              if (first) first.focus()
            } else {
              mediaForm.setAttribute('hidden', '')
            }
          })
        }

        // ── Add variant form toggle ─────────────────────────────────
        var addVariantToggle = document.getElementById('pdToggleAddVariant')
        var addVariantForm = document.getElementById('pdAddVariantForm')
        if (addVariantToggle && addVariantForm) {
          addVariantToggle.addEventListener('click', function(e){
            e.preventDefault()
            if (addVariantForm.hasAttribute('hidden')) {
              addVariantForm.removeAttribute('hidden')
              var firstField = addVariantForm.querySelector('input[type="text"], input[type="number"]')
              if (firstField) firstField.focus()
            } else {
              addVariantForm.setAttribute('hidden', '')
            }
          })
        }

        // ── Variant inline auto-save (blur → fetch POST) ────────────
        document.querySelectorAll('.pd-var-inline .pd-var-cell-input').forEach(function(input){
          var original = input.value
          input.addEventListener('focus', function(){ original = input.value })
          input.addEventListener('blur', function(){
            if (input.value === original) return
            var f = input.closest('form')
            if (!f) return
            var fd = new FormData(f)
            fetch(f.action, { method: 'POST', body: fd, credentials: 'same-origin' })
              .then(function(r){
                if (r.ok) {
                  input.classList.add('pd-saved-flash')
                  setTimeout(function(){ input.classList.remove('pd-saved-flash') }, 900)
                  original = input.value
                } else {
                  input.classList.add('pd-save-err')
                  setTimeout(function(){ input.classList.remove('pd-save-err') }, 1500)
                }
              })
              .catch(function(){
                input.classList.add('pd-save-err')
                setTimeout(function(){ input.classList.remove('pd-save-err') }, 1500)
              })
          })
          input.addEventListener('keydown', function(e){
            if (e.key === 'Enter') { e.preventDefault(); input.blur() }
          })
        })

        // ── Variant filter links (data-var-value) ───────────────────
        document.querySelectorAll('[data-var-value]').forEach(function(link){
          link.addEventListener('click', function(e){
            e.preventDefault()
            var val = link.getAttribute('data-var-value')
            var active = link.classList.contains('pd-filter-active')
            document.querySelectorAll('[data-var-value]').forEach(function(l){ l.classList.remove('pd-filter-active') })
            document.querySelectorAll('#pdVarTbody tr').forEach(function(tr){
              if (active) { tr.style.display = '' ; return }
              var match = (tr.getAttribute('data-option1') === val) ||
                          (tr.getAttribute('data-option2') === val) ||
                          (tr.getAttribute('data-option3') === val)
              tr.style.display = match ? '' : 'none'
            })
            if (!active) link.classList.add('pd-filter-active')
          })
        })

        // ── Select all variants checkbox ────────────────────────────
        var varAll = document.getElementById('pdVarSelectAll')
        if (varAll) {
          varAll.addEventListener('change', function(){
            document.querySelectorAll('.pd-var-rowcheck').forEach(function(cb){ cb.checked = varAll.checked })
          })
        }

        // ── Group variants client-side reorder ──────────────────────
        var groupToggle = document.getElementById('pdGroupToggle')
        var groupBy = document.getElementById('pdGroupBy')
        function applyVariantGrouping() {
          var tbody = document.getElementById('pdVarTbody')
          if (!tbody) return
          var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'))
          if (!groupToggle || !groupToggle.checked) {
            // restore DOM order by data-original-pos
            rows.sort(function(a, b){
              return parseInt(a.getAttribute('data-original-pos') || '0', 10) - parseInt(b.getAttribute('data-original-pos') || '0', 10)
            })
          } else {
            var key = 'data-option' + (parseInt(groupBy ? groupBy.value : '0', 10) + 1)
            rows.sort(function(a, b){
              var av = a.getAttribute(key) || ''
              var bv = b.getAttribute(key) || ''
              if (av === bv) return parseInt(a.getAttribute('data-original-pos') || '0', 10) - parseInt(b.getAttribute('data-original-pos') || '0', 10)
              return av.localeCompare(bv)
            })
          }
          rows.forEach(function(r){ tbody.appendChild(r) })
        }
        // Tag original positions
        var tbodyInit = document.getElementById('pdVarTbody')
        if (tbodyInit) {
          Array.prototype.slice.call(tbodyInit.querySelectorAll('tr')).forEach(function(r, i){
            r.setAttribute('data-original-pos', String(i))
          })
        }
        if (groupToggle) groupToggle.addEventListener('change', applyVariantGrouping)
        if (groupBy) groupBy.addEventListener('change', applyVariantGrouping)

        // ── Collection typeahead ────────────────────────────────────
        var collSearch = document.getElementById('pdCollSearch')
        var collDropdown = document.getElementById('pdCollDropdown')
        var collSelected = document.getElementById('pdCollSelected')
        var collHidden = document.getElementById('pdCollHidden')
        var allCollections = ${JSON.stringify(allCollections.map((c: any) => ({ id: c.id, title: c.title })))}

        function selectedCollIds() {
          if (!collHidden || !collHidden.value) return []
          return collHidden.value.split(',').filter(Boolean)
        }
        function renderDropdown(filter) {
          if (!collDropdown) return
          var selected = selectedCollIds()
          var q = (filter || '').toLowerCase().trim()
          var matches = allCollections.filter(function(c){
            if (selected.indexOf(c.id) !== -1) return false
            if (!q) return true
            return c.title.toLowerCase().indexOf(q) !== -1
          }).slice(0, 8)
          if (matches.length === 0) {
            collDropdown.innerHTML = '<div class="pd-coll-empty">No collections match.</div>'
          } else {
            collDropdown.innerHTML = matches.map(function(c){
              return '<div class="pd-coll-opt" data-cid="' + c.id + '">' + c.title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>'
            }).join('')
          }
          collDropdown.removeAttribute('hidden')
        }
        function addCollection(cid) {
          var c = allCollections.find(function(x){ return x.id === cid })
          if (!c) return
          var selected = selectedCollIds()
          if (selected.indexOf(cid) !== -1) return
          selected.push(cid)
          if (collHidden) collHidden.value = selected.join(',')
          var chip = document.createElement('span')
          chip.className = 'pd-coll-chip'
          chip.setAttribute('data-cid', cid)
          chip.innerHTML = c.title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + ' <button type="button" aria-label="remove" data-remove-coll="' + cid + '">×</button>'
          if (collSelected) collSelected.appendChild(chip)
          if (collSearch) { collSearch.value = ''; collSearch.focus() }
          renderDropdown('')
        }
        function removeCollection(cid) {
          var selected = selectedCollIds().filter(function(x){ return x !== cid })
          if (collHidden) collHidden.value = selected.join(',')
          if (collSelected) {
            var chip = collSelected.querySelector('[data-cid="' + cid + '"]')
            if (chip) chip.remove()
          }
        }
        if (collSearch) {
          collSearch.addEventListener('focus', function(){ renderDropdown(collSearch.value) })
          collSearch.addEventListener('input', function(){ renderDropdown(collSearch.value) })
          collSearch.addEventListener('blur', function(){
            setTimeout(function(){ if (collDropdown) collDropdown.setAttribute('hidden', '') }, 200)
          })
        }
        if (collDropdown) {
          collDropdown.addEventListener('mousedown', function(e){
            var target = e.target
            while (target && target !== collDropdown) {
              if (target.classList && target.classList.contains('pd-coll-opt')) {
                e.preventDefault()
                addCollection(target.getAttribute('data-cid'))
                return
              }
              target = target.parentNode
            }
          })
        }
        if (collSelected) {
          collSelected.addEventListener('click', function(e){
            var t = e.target
            if (t && t.getAttribute && t.getAttribute('data-remove-coll')) {
              removeCollection(t.getAttribute('data-remove-coll'))
            }
          })
        }

        // ── Custom data (metafields) modal ──────────────────────────
        var mfAdd = document.getElementById('pdMfAddBtn')
        var mfModal = document.getElementById('pdMfModal')
        function openMfModal(){ if (mfModal) mfModal.hidden = false }
        function closeMfModal(){ if (mfModal) mfModal.hidden = true }
        if (mfAdd) mfAdd.addEventListener('click', openMfModal)
        if (mfModal) {
          mfModal.addEventListener('click', function(e){
            var t = e.target
            if (t && t.getAttribute && t.getAttribute('data-close-mf-modal') !== null) closeMfModal()
          })
          // Escape to close
          document.addEventListener('keydown', function(e){
            if (e.key === 'Escape' && !mfModal.hidden) closeMfModal()
          })
        }
      })()
    </script>
  `

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: esc(product.title),
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'products',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// Helper used by detail page
// ---------------------------------------------------------------------------

function firstStr(v: any): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

// ---------------------------------------------------------------------------
// POST /products/:id/update — Save product detail edits
// ---------------------------------------------------------------------------

export async function postProductUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  // In API mode, productId from params is typically the slug.
  const productIdRaw = String(req.params.productId ?? req.params.id ?? '')

  if (!hasDb) {
    const apiBase = process.env.API_PRODUCT_BASE_URL
    if (!apiBase) {
      res.redirect(`${base}/products?error=${encodeURIComponent('Missing API_PRODUCT_BASE_URL')}`)
      return
    }

    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)

    const body = req.body as Record<string, string | string[]>
    const title = (firstStr(body.title) ?? '').trim()
    const bodyHtml = firstStr(body.body_html) ?? ''
    const vendor = (firstStr(body.vendor) ?? '').trim()
    const rawTags = firstStr(body.tags) ?? ''
    const parsedTags = rawTags.split(',').map((t) => t.trim()).filter(Boolean)

    if (!title) {
      res.redirect(`${base}/products/${encodeURIComponent(productIdRaw)}?error=${encodeURIComponent('Title is required')}`)
      return
    }

    // Status select wins over checkbox legacy field; fallback to checkbox.
    const statusFromSelect = (firstStr(body.status) ?? '').toLowerCase()
    const availListing = firstStr(body.avail_listing) === '1'
    const availSitemap = firstStr(body.avail_sitemap) === '1'
    const nextStatus = statusFromSelect === 'active' || statusFromSelect === 'draft'
      ? statusFromSelect
      : (availListing || availSitemap ? 'active' : 'draft')

    const seoTitle = (firstStr(body.seo_title) ?? '').trim() || null
    const seoDesc = (firstStr(body.seo_description) ?? '').trim() || null

    // Variant defaults pulled from form. We patch variant_default in-place
    // and leave the rest of the variants array untouched on PUT (BE merges).
    const priceNum = Number(firstStr(body.price) ?? 0) || 0
    const oldPriceNum = Number(firstStr(body.compare_at_price) ?? 0) || 0
    const baseCostNum = Number(firstStr(body.cost_per_item) ?? 0) || 0
    const inventoryNum = Number(firstStr(body.inventory) ?? 0) || 0
    const skuVal = (firstStr(body.sku) ?? '').trim()
    const barcodeVal = (firstStr(body.barcode) ?? '').trim()
    const categoryId = (firstStr(body.category_id) ?? '').trim()

    // GET current product first so we can merge — BE PUT replaces the whole
    // document, so any field we omit (images, variants, options, custom_fields…)
    // gets cleared. We spread the existing product into the payload and only
    // override the fields the form actually edits.
    let existingProduct: Record<string, any> = {}
    try {
      const getRes = await fetch(`${apiBase}/api/${encodeURIComponent(store.id)}/${encodeURIComponent(productIdRaw)}`, {
        method: 'GET',
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(10000),
      })
      if (getRes.ok) {
        const gd: any = await getRes.json().catch(() => null)
        existingProduct = (gd?.data || gd || {}) as Record<string, any>
      }
    } catch { /* fall through with empty base — last-resort */ }

    // Merge variant_default so we don't drop fields the form doesn't expose
    // (e.g. variant id, image_url, options snapshot).
    const mergedVariantDefault = {
      ...(existingProduct.variant_default || {}),
      price: priceNum,
      old_price: oldPriceNum,
      base_cost: baseCostNum,
      inventory: inventoryNum,
      sku: skuVal || null,
      barcode: barcodeVal || null,
    }

    let payload: Record<string, any> = {
      ...existingProduct,
      name: title,
      body_html: bodyHtml || null,
      vendor: vendor || null,
      tags: parsedTags.length > 0 ? parsedTags : null,
      published: nextStatus === 'active',
      seo_title: seoTitle,
      seo_description: seoDesc,
      variant_default: mergedVariantDefault,
    }

    if (categoryId) {
      payload.categories = [{ id: categoryId }]
    }

    const rawSlug = (firstStr(body.slug) ?? '').trim().toLowerCase()
    if (rawSlug) {
      const cleaned = rawSlug.replace(/[^a-z0-9\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
      if (cleaned) {
        payload.slug = cleaned
      }
    }

    const r = await fetch(`${apiBase}/api/${encodeURIComponent(store.id)}/${encodeURIComponent(productIdRaw)}`, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    })

    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      res.redirect(`${base}/products/${encodeURIComponent(productIdRaw)}?error=${encodeURIComponent(`Update failed: HTTP ${r.status} ${txt.substring(0, 100)}`)}`)
      return
    }

    res.redirect(`${base}/products/${encodeURIComponent(payload.slug || productIdRaw)}?success=${encodeURIComponent('Product updated via API')}`)
    return
  }

  const productId = await resolveProductId(
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )

  // Confirm the product belongs to this shop before touching it.
  const existing = await db
    .selectFrom('products')
    .select(['id', 'status', 'published_at', 'slug'])
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  if (!existing) {
    res.redirect(`${base}/products?error=product_not_found`)
    return
  }

  const body = req.body as Record<string, string | string[]>
  const title = (firstStr(body.title) ?? '').trim()
  const bodyHtml = firstStr(body.body_html) ?? ''
  const productType = (firstStr(body.product_type) ?? '').trim()
  const vendor = (firstStr(body.vendor) ?? '').trim()
  const rawTags = firstStr(body.tags) ?? ''
  const parsedTags = rawTags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  if (!title) {
    res.redirect(`${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Title is required')}`)
    return
  }

  // Availability toggles → derived status.
  // Both ON  → active
  // Listing ON, sitemap OFF → active (but unindexed — not yet differentiated)
  // Both OFF → draft
  const availListing = firstStr(body.avail_listing) === '1'
  const availSitemap = firstStr(body.avail_sitemap) === '1'
  const nextStatus = availListing || availSitemap ? 'active' : 'draft'
  const nextPublishedAt =
    nextStatus === 'active'
      ? existing.published_at ?? new Date().toISOString()
      : null

  // SEO overrides
  const rawSeoTitle = firstStr(body.seo_title) ?? ''
  const rawSeoDesc = firstStr(body.seo_description) ?? ''
  const seoTitle = rawSeoTitle.trim() || null
  const seoDesc = rawSeoDesc.trim() || null

  // Template suffix
  const rawTemplate = (firstStr(body.template_suffix) ?? '').trim()
  const templateSuffix = rawTemplate || null

  // Slug — only touch if provided and different from current. Rerun the
  // slugify rules so user input can't land us in a 404 loop.
  const rawSlug = (firstStr(body.slug) ?? '').trim().toLowerCase()
  let nextSlug: string | undefined
  if (rawSlug && rawSlug !== existing.slug) {
    const cleaned = rawSlug
      .replace(/[^a-z0-9\-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    if (cleaned) {
      // Guard against collisions with another product in the same shop.
      const collision = await db
        .selectFrom('products')
        .select('id')
        .where('shop_id', '=', store.id)
        .where('slug', '=', cleaned)
        .where('id', '!=', productId)
        .executeTakeFirst()
      nextSlug = collision ? `${cleaned}-${Date.now()}` : cleaned
    }
  }

  const updateSet: Record<string, unknown> = {
    title,
    body_html: bodyHtml || null,
    product_type: productType || null,
    vendor: vendor || null,
    tags: parsedTags.length > 0 ? parsedTags : null,
    status: nextStatus,
    published_at: nextPublishedAt,
    seo_title: seoTitle,
    seo_description: seoDesc,
    template_suffix: templateSuffix,
    updated_at: new Date().toISOString(),
  }
  if (typeof nextSlug === 'string') updateSet.slug = nextSlug

  await db
    .updateTable('products')
    .set(updateSet as any)
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .execute()

  // Collections diff — if the hidden field was sent we sync memberships.
  const collectionIdsRaw = firstStr(body.collection_ids)
  if (typeof collectionIdsRaw === 'string') {
    const desiredIds = collectionIdsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    // Only touch collections that belong to this shop (defence in depth).
    const valid = desiredIds.length
      ? await db
          .selectFrom('collections')
          .select('id')
          .where('shop_id', '=', store.id)
          .where('id', 'in', desiredIds)
          .execute()
      : []
    const validIds = new Set(valid.map((r: any) => r.id))

    await db
      .deleteFrom('collection_products')
      .where('product_id', '=', productId)
      .execute()

    if (validIds.size > 0) {
      await db
        .insertInto('collection_products')
        .values(
          Array.from(validIds).map((cid) => ({
            product_id: productId,
            collection_id: cid,
            position: 0,
          })),
        )
        .execute()
    }
  }

  // Audit log (best-effort)
  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'update',
      resource_type: 'product',
      resource_id: productId,
      details: JSON.stringify({ title, status: nextStatus }),
    })
    .execute()
    .catch(() => {})

  notify(db, {
    shopId: store.id,
    userId: user.id,
    type: 'product_updated',
    title: `Product updated: ${title}`,
    message: byActor(user),
    resourceType: 'product',
    resourceId: productId,
  })

  // Phase C2 — fan-out smart-collection re-eval. A product edit can
  // change title/vendor/type/tags/status, all of which are matchable
  // rule fields, so we trigger every smart collection in the shop.
  // BullMQ's idempotent jobId collapses duplicate fires for the same
  // collection if the merchant saves back-to-back.
  await enqueueSyncShopSmart(db as any, store.id, 'product-update')

  res.redirect(
    `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent('Product saved.')}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/delete — Delete a single product + variants + images
// ---------------------------------------------------------------------------

export async function postProductDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  const productIdRaw = String(req.params.productId ?? req.params.id ?? '')

  if (!hasDb) {
    const apiBase = process.env.API_PRODUCT_BASE_URL
    if (!apiBase) {
      res.redirect(`${base}/products?error=${encodeURIComponent('Missing API_PRODUCT_BASE_URL')}`)
      return
    }

    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)

    const r = await fetch(`${apiBase}/api/${encodeURIComponent(store.id)}/${encodeURIComponent(productIdRaw)}`, {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(12000),
    })

    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      res.redirect(`${base}/products/${encodeURIComponent(productIdRaw)}?error=${encodeURIComponent(`Delete failed: HTTP ${r.status} ${txt.substring(0, 100)}`)}`)
      return
    }

    res.redirect(`${base}/products?success=${encodeURIComponent('Product deleted via API')}`)
    return
  }

  const productId = await resolveProductId(
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )

  const existing = await db
    .selectFrom('products')
    .select(['id', 'title'])
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  if (!existing) {
    res.redirect(`${base}/products?error=product_not_found`)
    return
  }

  await db
    .deleteFrom('product_variants')
    .where('product_id', '=', productId)
    .execute()
  await db
    .deleteFrom('product_images')
    .where('product_id', '=', productId)
    .execute()
  await db
    .deleteFrom('collection_products')
    .where('product_id', '=', productId)
    .execute()
  await db
    .deleteFrom('products')
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .execute()

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'delete',
      resource_type: 'product',
      resource_id: productId,
      details: JSON.stringify({ title: existing.title }),
    })
    .execute()
    .catch(() => {})

  notify(db, {
    shopId: store.id,
    userId: user.id,
    type: 'product_deleted',
    title: `Product deleted: ${existing.title}`,
    message: byActor(user),
    resourceType: 'product',
    resourceId: null,
  })

  // Phase C2 — deletion removes the product from every smart
  // collection whose rules would otherwise include it, so trigger
  // re-eval across the shop. The FK on collection_products cascades
  // the junction row automatically, but smart collections still need
  // to observe the "nothing matches anymore" state so their `kept`
  // counter updates correctly.
  await enqueueSyncShopSmart(db as any, store.id, 'product-delete')

  res.redirect(
    `${base}/products?success=${encodeURIComponent(`Deleted "${existing.title}".`)}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/metafields — Add/upsert a custom field on this product
//
// Form fields: namespace, key, value, value_type, description
// Redirects back to the product detail on success. Validation errors come
// from the service as Error messages — we propagate them as query-string
// flash messages so the seller sees them without losing their work.
// ---------------------------------------------------------------------------

export async function postProductMetafieldAdd(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const productId = await resolveProductId(
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )

  // Sanity — product must belong to this shop. We don't 404 here; if the
  // FK is wrong the service's upsert will simply insert an orphan row, so
  // guard explicitly.
  const existing = await db
    .selectFrom('products')
    .select('id')
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()
  if (!existing) {
    res.redirect(`${base}/products?error=product_not_found`)
    return
  }

  const body = req.body ?? {}
  const namespace = String(body.namespace ?? '').trim()
  const key = String(body.key ?? '').trim()
  const rawValue = typeof body.value === 'string' ? body.value : String(body.value ?? '')
  const valueTypeInput = String(body.value_type ?? 'single_line_text_field').trim() as MetafieldValueType
  const description = typeof body.description === 'string' && body.description.trim()
    ? body.description.trim()
    : null

  // If the seller picked value_type=json, try to parse — otherwise the service
  // would store the raw string wrapped in JSON quotes. For all other types we
  // pass the raw string through (service wraps it itself).
  let parsedValue: unknown = rawValue
  if (valueTypeInput === 'json') {
    try {
      parsedValue = JSON.parse(rawValue)
    } catch {
      res.redirect(
        `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Invalid JSON in custom field value')}`,
      )
      return
    }
  } else if (valueTypeInput === 'number_integer') {
    const n = parseInt(rawValue, 10)
    if (Number.isNaN(n)) {
      res.redirect(
        `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Value must be an integer')}`,
      )
      return
    }
    parsedValue = n
  } else if (valueTypeInput === 'number_decimal') {
    const n = parseFloat(rawValue)
    if (Number.isNaN(n)) {
      res.redirect(
        `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Value must be a number')}`,
      )
      return
    }
    parsedValue = n
  } else if (valueTypeInput === 'boolean') {
    parsedValue = rawValue === 'true' || rawValue === '1' || rawValue === 'on'
  }

  try {
    await setProductMetafield(db as any, {
      shop_id: store.id,
      owner_type: 'product',
      owner_id: productId,
      namespace,
      key,
      value: parsedValue,
      value_type: valueTypeInput,
      description,
    })
  } catch (err: any) {
    const msg = err?.message || 'Failed to save custom field'
    res.redirect(
      `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent(msg)}`,
    )
    return
  }

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'metafield.upsert',
      resource_type: 'product',
      resource_id: productId,
      details: JSON.stringify({ namespace, key, value_type: valueTypeInput }),
    })
    .execute()
    .catch(() => {})

  res.redirect(
    `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent(`Added custom field ${namespace}.${key}`)}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/metafields/:metafieldId/delete — Delete a custom field
// ---------------------------------------------------------------------------

export async function postProductMetafieldDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const productId = await resolveProductId(
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )
  const metafieldId = String(req.params.metafieldId ?? '')

  const deleted = await deleteProductMetafieldById(db as any, store.id, metafieldId)

  if (deleted) {
    await db
      .insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: 'metafield.delete',
        resource_type: 'product',
        resource_id: productId,
        details: JSON.stringify({ metafield_id: metafieldId }),
      })
      .execute()
      .catch(() => {})
    res.redirect(
      `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent('Custom field deleted')}`,
    )
  } else {
    res.redirect(
      `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Custom field not found')}`,
    )
  }
}

// ---------------------------------------------------------------------------
// POST /products/:id/status-toggle — Flip status between active/draft
// ---------------------------------------------------------------------------

export async function postProductStatusToggle(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  // Accept UUID or slug — see resolveProductId() above. Collection pages
  // link by slug so `/products/<slug>` must not 500 on the uuid cast.
  const productId = await resolveProductId(
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )

  const existing = await db
    .selectFrom('products')
    .select(['id', 'status', 'title', 'published_at'])
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  if (!existing) {
    res.redirect(`${base}/products?error=product_not_found`)
    return
  }

  const nextStatus = existing.status === 'active' ? 'draft' : 'active'
  const nextPublishedAt =
    nextStatus === 'active'
      ? existing.published_at ?? new Date().toISOString()
      : null

  await db
    .updateTable('products')
    .set({
      status: nextStatus,
      published_at: nextPublishedAt,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .execute()

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'update',
      resource_type: 'product',
      resource_id: productId,
      details: JSON.stringify({ status: nextStatus }),
    })
    .execute()
    .catch(() => {})

  // Phase C2 — status toggle flips `products.status`, and every smart
  // collection scopes `.where('status', '=', 'active')` in the
  // evaluator. So active→draft pulls the product out of every smart
  // collection it was in, and draft→active may pull it back in.
  await enqueueSyncShopSmart(db as any, store.id, 'product-status')

  const msg = nextStatus === 'active' ? 'Product is now visible.' : 'Product hidden.'
  res.redirect(
    `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent(msg)}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/duplicate — Clone product + variants + images
// ---------------------------------------------------------------------------

export async function postProductDuplicate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  // Accept UUID or slug — see resolveProductId() above. Collection pages
  // link by slug so `/products/<slug>` must not 500 on the uuid cast.
  const productId = await resolveProductId(
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )

  const source = await db
    .selectFrom('products')
    .selectAll()
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  if (!source) {
    res.redirect(`${base}/products?error=product_not_found`)
    return
  }

  const copyTitle = `${source.title} (copy)`
  // Build a unique slug (append timestamp if collides)
  const baseSlug = `${source.slug}-copy`
  const slugCollision = await db
    .selectFrom('products')
    .select('id')
    .where('shop_id', '=', store.id)
    .where('slug', '=', baseSlug)
    .executeTakeFirst()
  const copySlug = slugCollision ? `${baseSlug}-${Date.now()}` : baseSlug

  const newProduct = await db
    .insertInto('products')
    .values({
      shop_id: store.id,
      title: copyTitle,
      slug: copySlug,
      body_html: source.body_html ?? null,
      vendor: source.vendor ?? null,
      product_type: source.product_type ?? null,
      status: 'draft', // always land as draft so duplicates don't auto-publish
      tags: source.tags ?? null,
      template_suffix: source.template_suffix ?? null,
      seo_title: source.seo_title ?? null,
      seo_description: source.seo_description ?? null,
      published_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Copy variants
  const sourceVariants = await db
    .selectFrom('product_variants')
    .selectAll()
    .where('product_id', '=', productId)
    .execute()

  if (sourceVariants.length > 0) {
    await db
      .insertInto('product_variants')
      .values(
        sourceVariants.map((v: any) => ({
          product_id: newProduct.id,
          title: v.title,
          price: v.price,
          compare_at_price: v.compare_at_price,
          cost: v.cost,
          sku: v.sku ? `${v.sku}-COPY` : null,
          barcode: null,
          inventory_quantity: 0,
          weight: v.weight,
          weight_unit: v.weight_unit,
          option1: v.option1,
          option2: v.option2,
          option3: v.option3,
          position: v.position,
          image_url: v.image_url,
          requires_shipping: v.requires_shipping,
          taxable: v.taxable,
        })),
      )
      .execute()
  } else {
    // Guarantee at least a default variant
    await db
      .insertInto('product_variants')
      .values({
        product_id: newProduct.id,
        title: 'Default',
        price: '0',
        inventory_quantity: 0,
        position: 0,
      })
      .execute()
  }

  // Copy images
  const sourceImages = await db
    .selectFrom('product_images')
    .selectAll()
    .where('product_id', '=', productId)
    .execute()
  if (sourceImages.length > 0) {
    await db
      .insertInto('product_images')
      .values(
        sourceImages.map((img: any) => ({
          product_id: newProduct.id,
          src: img.src,
          alt: img.alt,
          width: img.width,
          height: img.height,
          position: img.position,
          srcset_json: img.srcset_json,
        })),
      )
      .execute()
  }

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'create',
      resource_type: 'product',
      resource_id: newProduct.id,
      details: JSON.stringify({ duplicated_from: productId }),
    })
    .execute()
    .catch(() => {})

  notify(db, {
    shopId: store.id,
    userId: user.id,
    type: 'product_created',
    title: `Product duplicated: ${copyTitle}`,
    message: byActor(user),
    resourceType: 'product',
    resourceId: newProduct.id,
  })

  // Phase C2 — duplicates land as draft, so they should NOT show up
  // in any smart collection right away (status='active' filter). But
  // we still trigger a re-eval: (1) it's free thanks to job
  // idempotency and (2) if the merchant toggles to active without
  // editing anything else, the draft→active hook catches it anyway.
  // Triggering here keeps the invariant simple: any product
  // mutation → one fan-out call.
  await enqueueSyncShopSmart(db as any, store.id, 'product-duplicate')

  res.redirect(
    `${base}/products/${encodeURIComponent(newProduct.id)}?success=${encodeURIComponent('Product duplicated.')}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/media — Add a product image from URL
// ---------------------------------------------------------------------------

export async function postProductMediaAdd(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  // Accept UUID or slug — see resolveProductId() above. Collection pages
  // link by slug so `/products/<slug>` must not 500 on the uuid cast.
  const productId = await resolveProductId(
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )

  const src = (firstStr((req.body as any).src) ?? '').trim()
  const alt = (firstStr((req.body as any).alt) ?? '').trim()

  if (!src || !/^https?:\/\//i.test(src)) {
    res.redirect(
      `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Media URL must start with http:// or https://')}`,
    )
    return
  }

  const product = await db
    .selectFrom('products')
    .select('id')
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()
  if (!product) {
    res.redirect(`${base}/products?error=product_not_found`)
    return
  }

  // Append to end
  const maxRow = await db
    .selectFrom('product_images')
    .select(db.fn.max('position').as('max_pos'))
    .where('product_id', '=', productId)
    .executeTakeFirst()
  const nextPosition = Number((maxRow as any)?.max_pos ?? -1) + 1

  await db
    .insertInto('product_images')
    .values({
      product_id: productId,
      src,
      alt: alt || null,
      position: nextPosition,
    })
    .execute()

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'create',
      resource_type: 'product_image',
      resource_id: productId,
      details: JSON.stringify({ src }),
    })
    .execute()
    .catch(() => {})

  res.redirect(
    `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent('Media added.')}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/media/:mediaId/delete — Remove a product image
// ---------------------------------------------------------------------------

export async function postProductMediaDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  // Accept UUID or slug — see resolveProductId() above. Collection pages
  // link by slug so `/products/<slug>` must not 500 on the uuid cast.
  const productId = await resolveProductId(
    db,
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )
  const mediaId = String(req.params.mediaId ?? '')

  // Defense: confirm the image really belongs to a product in this shop.
  const image = await db
    .selectFrom('product_images as pi')
    .innerJoin('products as p', 'p.id', 'pi.product_id')
    .select(['pi.id'])
    .where('pi.id', '=', mediaId)
    .where('pi.product_id', '=', productId)
    .where('p.shop_id', '=', store.id)
    .executeTakeFirst()

  if (!image) {
    res.redirect(
      `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Media not found.')}`,
    )
    return
  }

  await db
    .deleteFrom('product_images')
    .where('id', '=', mediaId)
    .where('product_id', '=', productId)
    .execute()

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'delete',
      resource_type: 'product_image',
      resource_id: mediaId,
    })
    .execute()
    .catch(() => {})

  res.redirect(
    `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent('Media removed.')}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/variants — Add a new variant
// ---------------------------------------------------------------------------

export async function postProductVariantAdd(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  // Accept UUID or slug — see resolveProductId() above. Collection pages
  // link by slug so `/products/<slug>` must not 500 on the uuid cast.
  const productId = await resolveProductId(
    db,
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )

  const product = await db
    .selectFrom('products')
    .select('id')
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()
  if (!product) {
    res.redirect(`${base}/products?error=product_not_found`)
    return
  }

  const body = req.body as Record<string, string>
  const option1 = (firstStr(body.option1) ?? '').trim() || null
  const option2 = (firstStr(body.option2) ?? '').trim() || null
  const option3 = (firstStr(body.option3) ?? '').trim() || null
  const rawPrice = firstStr(body.price) ?? '0'
  const priceNum = parseFloat(rawPrice)
  const price = Number.isFinite(priceNum) && priceNum >= 0 ? priceNum.toFixed(2) : '0.00'
  const sku = (firstStr(body.sku) ?? '').trim() || null
  const rawInv = firstStr(body.inventory_quantity) ?? '0'
  const inventory = parseInt(rawInv, 10) || 0

  // Variant title = option values joined, or "Default Title" if none
  const titleFromOptions = [option1, option2, option3].filter(Boolean).join(' / ')
  const variantTitle = titleFromOptions || (firstStr(body.title) ?? '').trim() || 'Default Title'

  // Duplicate-option guard (matches ShopBase behavior)
  if (option1 || option2 || option3) {
    const dupe = await db
      .selectFrom('product_variants')
      .select('id')
      .where('product_id', '=', productId)
      .where((eb) => eb.and([
        option1 ? eb('option1', '=', option1) : eb('option1', 'is', null),
        option2 ? eb('option2', '=', option2) : eb('option2', 'is', null),
        option3 ? eb('option3', '=', option3) : eb('option3', 'is', null),
      ]))
      .executeTakeFirst()
    if (dupe) {
      res.redirect(
        `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('A variant with these options already exists.')}`,
      )
      return
    }
  }

  // Next position = max + 1
  const posRow = await db
    .selectFrom('product_variants')
    .select(db.fn.max('position').as('max_pos'))
    .where('product_id', '=', productId)
    .executeTakeFirst()
  const nextPos = Number((posRow as any)?.max_pos ?? -1) + 1

  await db
    .insertInto('product_variants')
    .values({
      product_id: productId,
      title: variantTitle,
      price,
      sku,
      inventory_quantity: inventory,
      option1,
      option2,
      option3,
      position: nextPos,
    })
    .execute()

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'create',
      resource_type: 'product_variant',
      resource_id: productId,
      details: JSON.stringify({ title: variantTitle, price, sku }),
    })
    .execute()
    .catch(() => {})

  // Phase C2 — variant price + inventory affect the `price` and
  // `inventory_quantity` smart rules (evaluated via EXISTS on
  // product_variants), so adding a variant can broaden or narrow
  // the match set.
  await enqueueSyncShopSmart(db as any, store.id, 'variant-add')

  res.redirect(
    `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent('Variant added.')}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/variants/:variantId/update — Inline per-field update
// ---------------------------------------------------------------------------

export async function postProductVariantUpdate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  // Accept UUID or slug — see resolveProductId() above. Collection pages
  // link by slug so `/products/<slug>` must not 500 on the uuid cast.
  const productId = await resolveProductId(
    db,
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )
  const variantId = String(req.params.variantId ?? '')

  const body = req.body as Record<string, string>
  const field = (firstStr(body.field) ?? '').trim()
  const value = firstStr(body.value) ?? ''

  // Defense: confirm the variant belongs to a product in this shop.
  const variant = await db
    .selectFrom('product_variants as pv')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .select(['pv.id'])
    .where('pv.id', '=', variantId)
    .where('pv.product_id', '=', productId)
    .where('p.shop_id', '=', store.id)
    .executeTakeFirst()
  if (!variant) {
    if (req.xhr || req.get('accept')?.includes('application/json')) {
      res.status(404).json({ ok: false, error: 'variant_not_found' })
      return
    }
    res.redirect(
      `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Variant not found.')}`,
    )
    return
  }

  // Whitelist fields
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  /**
   * Phase 2 PR5: inventory_quantity is special. Setting it via this inline
   * input is semantically "set the total across all locations". We capture
   * the target value here and then after the switch we compute the delta
   * against the current DB value and route the adjustment through
   * updateInventory() — which updates both the inventory_levels bridge
   * (on the shop's primary active location) AND the denormalized
   * product_variants.inventory_quantity column. This keeps single-location
   * shops behaving exactly as before while preventing the denormalized
   * column from drifting away from sum(inventory_levels.available) on
   * multi-location shops.
   */
  let invTarget: number | null = null
  switch (field) {
    case 'price': {
      const n = parseFloat(value)
      if (!Number.isFinite(n) || n < 0) {
        if (req.xhr || req.get('accept')?.includes('application/json')) {
          res.status(400).json({ ok: false, error: 'invalid_price' })
          return
        }
        res.redirect(
          `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Price must be a non-negative number.')}`,
        )
        return
      }
      update.price = n.toFixed(2)
      break
    }
    case 'inventory_quantity': {
      const n = parseInt(value, 10)
      if (!Number.isFinite(n)) {
        if (req.xhr || req.get('accept')?.includes('application/json')) {
          res.status(400).json({ ok: false, error: 'invalid_inventory' })
          return
        }
        res.redirect(
          `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Inventory must be an integer.')}`,
        )
        return
      }
      // Defer the write — we compute a delta against the current value
      // after the switch and route it through updateInventory() so the
      // inventory_levels bridge stays consistent.
      invTarget = n
      break
    }
    case 'sku':
      update.sku = value.trim() || null
      break
    case 'compare_at_price': {
      const t = value.trim()
      if (!t) {
        update.compare_at_price = null
      } else {
        const n = parseFloat(t)
        if (!Number.isFinite(n) || n < 0) {
          if (req.xhr || req.get('accept')?.includes('application/json')) {
            res.status(400).json({ ok: false, error: 'invalid_compare_at_price' })
            return
          }
          res.redirect(
            `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Compare-at price must be a non-negative number.')}`,
          )
          return
        }
        update.compare_at_price = n.toFixed(2)
      }
      break
    }
    // ---------------------------------------------------------------------
    // Migration 054 — Variant deep fields (PR4).
    //
    // - barcode: free text (UPC, EAN, ISBN — no format enforced here)
    // - hs_code: 6–14 chars of digits/dots (Harmonized System / HTS / CN8)
    // - country_of_origin: ISO 3166-1 alpha-2, uppercased
    // - inventory_policy: 'deny' | 'continue' — backorder control
    // - inventory_management: 'gbox' | '' — tracked vs not
    //
    // These are pre-validated at the app layer AND checked by CHECK
    // constraints on the column (so the DB rejects malformed data
    // even if a future call-site skips the switch).
    // ---------------------------------------------------------------------
    case 'barcode':
      update.barcode = value.trim() || null
      break
    case 'hs_code': {
      const t = value.trim()
      if (!t) {
        update.hs_code = null
      } else if (t.length > 14) {
        if (req.xhr || req.get('accept')?.includes('application/json')) {
          res.status(400).json({ ok: false, error: 'invalid_hs_code' })
          return
        }
        res.redirect(
          `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('HS code must be 14 characters or fewer.')}`,
        )
        return
      } else {
        update.hs_code = t
      }
      break
    }
    case 'country_of_origin': {
      const t = value.trim().toUpperCase()
      if (!t) {
        update.country_of_origin = null
      } else if (!/^[A-Z]{2}$/.test(t)) {
        if (req.xhr || req.get('accept')?.includes('application/json')) {
          res.status(400).json({ ok: false, error: 'invalid_country_of_origin' })
          return
        }
        res.redirect(
          `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Country of origin must be a 2-letter ISO code (e.g. VN, US, CN).')}`,
        )
        return
      } else {
        update.country_of_origin = t
      }
      break
    }
    case 'inventory_policy': {
      const t = value.trim().toLowerCase()
      if (t !== 'deny' && t !== 'continue') {
        if (req.xhr || req.get('accept')?.includes('application/json')) {
          res.status(400).json({ ok: false, error: 'invalid_inventory_policy' })
          return
        }
        res.redirect(
          `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Inventory policy must be "deny" or "continue".')}`,
        )
        return
      }
      update.inventory_policy = t
      break
    }
    case 'inventory_management': {
      const t = value.trim().toLowerCase()
      // Empty string / 'none' / 'null' all mean "not tracked" → NULL.
      // Non-empty values pass through so integrations can later add
      // 'amazon', 'tiktok', etc. without a schema change.
      update.inventory_management = t && t !== 'none' && t !== 'null' ? t : null
      break
    }
    default: {
      if (req.xhr || req.get('accept')?.includes('application/json')) {
        res.status(400).json({ ok: false, error: 'unknown_field' })
        return
      }
      res.redirect(
        `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Unknown variant field.')}`,
      )
      return
    }
  }

  // Phase 2 PR5 — inventory_quantity takes the bridge path; every other
  // field uses the direct UPDATE.
  if (invTarget !== null) {
    // Read the current qty so we can compute a delta.
    const curRow = await db
      .selectFrom('product_variants')
      .select(['inventory_quantity'])
      .where('id', '=', variantId)
      .executeTakeFirst()
    const oldQty = Number(curRow?.inventory_quantity ?? 0)
    const delta = invTarget - oldQty

    // Resolve primary active location (falls back to any active location).
    const primary = await db
      .selectFrom('locations')
      .select(['id'])
      .where('shop_id', '=', store.id)
      .where('active', '=', true)
      .orderBy('is_primary', 'desc')
      .orderBy('created_at', 'asc')
      .limit(1)
      .executeTakeFirst()

    if (delta !== 0) {
      if (primary) {
        try {
          await updateInventory(db, variantId, primary.id, delta)
        } catch (err) {
          // Typically "Insufficient inventory" when adjusting below 0.
          const msg = err instanceof Error ? err.message : 'Inventory adjustment failed'
          if (req.xhr || req.get('accept')?.includes('application/json')) {
            res.status(400).json({ ok: false, error: 'inventory_adjust_failed', message: msg })
            return
          }
          res.redirect(
            `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent(msg)}`,
          )
          return
        }
      } else {
        // No active location at all — legacy direct write so the seller
        // isn't blocked on platform-level config. The bridge is out of
        // sync but will reconcile once a location is added.
        await db
          .updateTable('product_variants')
          .set({ inventory_quantity: invTarget, updated_at: new Date().toISOString() })
          .where('id', '=', variantId)
          .where('product_id', '=', productId)
          .execute()
      }
    } else {
      // No-op adjustment, just bump updated_at for consistency.
      await db
        .updateTable('product_variants')
        .set({ updated_at: new Date().toISOString() })
        .where('id', '=', variantId)
        .where('product_id', '=', productId)
        .execute()
    }
    // Make the final value available to the XHR JSON response below.
    update.inventory_quantity = invTarget
  } else {
    await db
      .updateTable('product_variants')
      .set(update as any)
      .where('id', '=', variantId)
      .where('product_id', '=', productId)
      .execute()
  }

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'update',
      resource_type: 'product_variant',
      resource_id: variantId,
      details: JSON.stringify({ field, value }),
    })
    .execute()
    .catch(() => {})

  // Phase C2 — inline variant edits hit price/inventory, both of
  // which drive smart-collection membership. Fire AFTER the DB
  // update so the worker reads the new values. We kick off the
  // fan-out BEFORE responding (fire-and-forget inside the helper)
  // so the XHR path still gets its JSON without waiting on Redis.
  await enqueueSyncShopSmart(db as any, store.id, `variant-${field}`)

  if (req.xhr || req.get('accept')?.includes('application/json')) {
    res.json({ ok: true, field, value: update[field] })
    return
  }
  res.redirect(
    `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent('Variant updated.')}`,
  )
}

// ---------------------------------------------------------------------------
// POST /products/:id/variants/:variantId/delete — Remove variant
// ---------------------------------------------------------------------------

export async function postProductVariantDelete(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  // Accept UUID or slug — see resolveProductId() above. Collection pages
  // link by slug so `/products/<slug>` must not 500 on the uuid cast.
  const productId = await resolveProductId(
    db,
    store.id,
    String(req.params.productId ?? req.params.id ?? ''),
  )
  const variantId = String(req.params.variantId ?? '')

  // Defense: confirm variant belongs to a product in this shop.
  const variant = await db
    .selectFrom('product_variants as pv')
    .innerJoin('products as p', 'p.id', 'pv.product_id')
    .select(['pv.id'])
    .where('pv.id', '=', variantId)
    .where('pv.product_id', '=', productId)
    .where('p.shop_id', '=', store.id)
    .executeTakeFirst()
  if (!variant) {
    res.redirect(
      `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Variant not found.')}`,
    )
    return
  }

  // Do not allow deleting the last variant — ShopBase/Shopify require at
  // least one variant per product.
  const countRow = await db
    .selectFrom('product_variants')
    .select(db.fn.count('id').as('n'))
    .where('product_id', '=', productId)
    .executeTakeFirst()
  const remaining = Number((countRow as any)?.n ?? 0)
  if (remaining <= 1) {
    res.redirect(
      `${base}/products/${encodeURIComponent(productId)}?error=${encodeURIComponent('Cannot delete the last variant.')}`,
    )
    return
  }

  await db
    .deleteFrom('product_variants')
    .where('id', '=', variantId)
    .where('product_id', '=', productId)
    .execute()

  await db
    .insertInto('audit_logs')
    .values({
      shop_id: store.id,
      user_id: user.id,
      action: 'delete',
      resource_type: 'product_variant',
      resource_id: variantId,
    })
    .execute()
    .catch(() => {})

  // Phase C2 — removing a variant may drop the product out of a
  // price or inventory rule's EXISTS match. Re-run the fan-out.
  await enqueueSyncShopSmart(db as any, store.id, 'variant-delete')

  res.redirect(
    `${base}/products/${encodeURIComponent(productId)}?success=${encodeURIComponent('Variant removed.')}`,
  )
}

// ---------------------------------------------------------------------------
// GET /products/new — New product form
// ---------------------------------------------------------------------------

export async function getProductNew(
  req: Request,
  res: Response,
  _db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const csrfToken = req.csrfToken!
  const csrfField = csrfHiddenField(csrfToken)

  // Fetch categories từ BE — dropdown trong form. Silent fail → empty list.
  let categories: Array<{ id: string; name: string }> = []
  try {
    const ctx = createApiContext(req)
    const r = await listCategories(ctx, { limit: 100 })
    categories = (r.data ?? [])
      .map((c) => ({ id: String(c.id ?? ''), name: String(c.name ?? '') }))
      .filter((c) => c.id && c.name)
  } catch (err) {
    console.warn('[products/new] listCategories failed:', err instanceof Error ? err.message : err)
  }

  // Flash banner từ ?error / ?success — nếu thiếu user submit fail nhưng
  // không thấy gì → tưởng button không hoạt động.
  const errorMsg = typeof req.query.error === 'string' ? req.query.error.slice(0, 500) : ''
  const successMsg = typeof req.query.success === 'string' ? req.query.success.slice(0, 500) : ''
  const flash = errorMsg
    ? { type: 'error' as const, message: errorMsg }
    : successMsg
      ? { type: 'success' as const, message: successMsg }
      : null

  const content = renderProductNewForm(base, csrfField, categories, flash)

  const theme = (req as any).theme || 'dark'
  res.send(sellerLayout({
    title: 'Add product',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'products',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /products — Create product + default variant, redirect
// ---------------------------------------------------------------------------

export async function postProductCreate(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const base = `/admin/store/${store.slug}`
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  // CSRF validated by centralized middleware in server.ts.

  const {
    title,
    body_html,
    vendor,
    product_type,
    tags: rawTags,
    status,
    price,
    compare_at_price,
    sku,
    inventory_quantity,
    category_id,
    category_name,
    options_json,
  } = req.body as Record<string, string>

  if (!title || !title.trim()) {
    res.redirect(`${base}/products/new?error=title_required`)
    return
  }

  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'product'

  const parsedTags = rawTags
    ? rawTags.split(',').map(t => t.trim()).filter(Boolean)
    : []

  if (!hasDb) {
    // API MODE — flow tách step để debug timeout/400 cụ thể từ stage nào.
    // STEP 1 ctx-init  → STEP 2 upload-images (sequential, log per file)
    // → STEP 3 create-product (timing). Mỗi step fail surface step name + reason.
    const tStart = Date.now()
    const failTo = (step: string, idx: number | null, reason: string) => {
      const idxStr = idx !== null ? `[${idx}]` : ''
      const msg = `[step:${step}${idxStr}] ${reason}`
      console.error(`[products/new] FAIL t+${Date.now() - tStart}ms ${msg}`)
      res.redirect(`${base}/products/new?error=${encodeURIComponent(msg)}`)
    }

    // STEP 1: ctx-init (parse session cookie + shop_id)
    let ctx
    try {
      ctx = createApiContext(req)
      console.log('[products/new] STEP=ctx-init OK shop_id=%s', ctx.shopId)
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'auth'
      console.error('[products/new] STEP=ctx-init FAILED:', reason)
      res.redirect('/accounts/login')
      return
    }

    // STEP 2: upload media — sequential, log timing per file
    const files = ((req.files as any) || []) as Array<{ buffer: Buffer; mimetype: string; originalname: string; size: number }>
    const shopApi = (process.env.API_SHOP_BASE_URL || 'https://api-shop.gbox.co').replace(/\/+$/, '')
    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)
    const uploadedUrls: string[] = []
    const uploadErrors: string[] = []
    console.log('[products/new] STEP=upload-images count=%d', files.length)
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const tFile = Date.now()
      if (!file?.buffer) { uploadErrors.push(`#${i} no buffer`); continue }
      if (file.size > 20 * 1024 * 1024) { uploadErrors.push(`#${i} too big (${file.size}B > 20MB)`); continue }
      try {
        const fd = new FormData()
        fd.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname)
        const r = await fetch(`${shopApi}/api/${encodeURIComponent(ctx.shopId)}/images`, {
          method: 'POST',
          headers: token ? { authorization: `Bearer ${token}` } : {},
          body: fd as any,
          signal: AbortSignal.timeout(20000),
        })
        if (!r.ok) {
          const text = await r.text().catch(() => '')
          uploadErrors.push(`#${i} HTTP ${r.status} ${text.slice(0, 100)}`)
          console.warn('[products/new] STEP=upload-images idx=%d FAILED HTTP %d in %dms', i, r.status, Date.now() - tFile)
          continue
        }
        const data: any = await r.json().catch(() => null)
        const url = data?.url
        if (url) {
          uploadedUrls.push(url)
          console.log('[products/new] STEP=upload-images idx=%d OK in %dms url=%s', i, Date.now() - tFile, url)
        } else {
          uploadErrors.push(`#${i} no url in response`)
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown'
        uploadErrors.push(`#${i} ${reason}`)
        console.error('[products/new] STEP=upload-images idx=%d FAILED in %dms err=%s', i, Date.now() - tFile, reason)
      }
    }
    if (files.length > 0 && uploadedUrls.length === 0) {
      // Tất cả ảnh fail → user chắc chắn muốn dừng để biết tại sao thay vì
      // tiếp tục create không có ảnh (gây hiểu lầm "save xong sao thiếu ảnh?")
      failTo('upload-images', null, `all ${files.length} files failed: ${uploadErrors.slice(0, 3).join('; ')}`)
      return
    }

    // Step 2: build payload (BE Product field names) + attach images
    const payload: any = {
      name: title.trim(),
      slug,
      body_html: body_html?.trim() || null,
      vendor: vendor?.trim() || null,
      tags: parsedTags.length > 0 ? parsedTags : null,
      published: status === 'active',
      variant_default: {
        price: parseFloat(price || '0') || 0,
        old_price: compare_at_price ? (parseFloat(compare_at_price) || 0) : null,
        sku: sku?.trim() || null,
        inventory: parseInt(inventory_quantity || '0') || 0,
      },
    }
    if (uploadedUrls.length > 0) payload.images = uploadedUrls.map((url) => ({ url }))

    // Categories REQUIRED bởi BE (ProductService.ValidateAsync). BE dùng
    // category.name để CheckExistsAndCreate — id chỉ informational. Fail sớm
    // FE-side với message rõ thay vì timeout 60s rồi BE 400 generic.
    const catId = category_id?.trim() || ''
    const catName = category_name?.trim() || ''
    if (!catName) {
      failTo('validate', null, 'Category is required (BE: "Categories are required"). Please pick a category from the dropdown.')
      return
    }
    payload.categories = [catId ? { id: catId, name: catName } : { name: catName }]

    // Variant options + cross-product variants. BE flow:
    //   1. ValidateAsync line 1580: chỉ process variants block khi options +
    //      variants ĐỒNG THỜI có và pass ValidatedOptionVariants.
    //   2. ValidatedOptionVariants line 1531-1540: standardVariant gen từ options
    //      qua CreateVariants — match bằng slug (auto từ name.ToSlug) và name.
    //   3. → FE PHẢI pass variants[] với name = "S/Black" join values theo
    //      cross-product, BE auto-slug từ name → so sánh khớp.
    if (options_json?.trim()) {
      try {
        const parsed = JSON.parse(options_json)
        if (Array.isArray(parsed)) {
          const opts = parsed
            .filter((o: any) => o && typeof o.name === 'string' && Array.isArray(o.values))
            .map((o: any) => ({
              name: String(o.name).trim(),
              values: o.values
                .map((v: any) => String(v).trim())
                .filter(Boolean),
            }))
            .filter((o: any) => o.name && o.values.length > 0)

          if (opts.length > 0) {
            // Schema hợp lệ — set options vào payload (values là object[]).
            payload.options = opts.map((o: any) => ({
              name: o.name,
              values: o.values.map((v: string) => ({ name: v })),
            }))

            // Cross-product variants — match BE CreateVariants line 1361 algorithm.
            const cross = (arr: string[][]): string[][] =>
              arr.length === 0 ? [[]] : arr[0].flatMap((v) => cross(arr.slice(1)).map((r) => [v, ...r]))
            const valuesMatrix = opts.map((o: any) => o.values as string[])
            const combos = cross(valuesMatrix)
            const basePrice = parseFloat(price || '0') || 0
            const baseInv = parseInt(inventory_quantity || '0') || 0
            const baseSku = sku?.trim() || ''
            payload.variants = combos.map((combo: string[]) => ({
              name: combo.join('/'),
              full_name: combo.map((v, i) => `${opts[i].name}: ${v}`).join('/'),
              option_values: combo,
              options: combo.map((v, i) => {
                const dict: Record<string, string> = {}
                dict[opts[i].name.toLowerCase().replace(/[^a-z0-9]+/g, '-')] = v
                return dict
              }),
              sku: baseSku,
              gtin: '',
              price: basePrice,
              old_price: 0,
              base_cost: 0,
              inventory: baseInv,
              inventory_tracking: false,
              allow_out_of_stock: false,
              image_url: '',
              status: true,
            }))
          }
        }
      } catch (e) {
        console.warn('[products/new] invalid options_json:', e instanceof Error ? e.message : e)
      }
    }

    // STEP 3: create product (BE Product Service POST /api/{shop_id})
    const tCreate = Date.now()
    console.log('[products/new] STEP=create-product shop_id=%s name=%s images=%d options=%d payload_size=%d',
      ctx.shopId, payload.name, payload.images?.length ?? 0, payload.options?.length ?? 0,
      JSON.stringify(payload).length)
    try {
      const created = await createProduct(ctx, payload)
      const elapsed = Date.now() - tCreate
      const newId = (created as any)?.id || (created as any)?.data?.id
      console.log('[products/new] STEP=create-product OK id=%s slug=%s in %dms (total %dms)',
        newId, (created as any)?.slug, elapsed, Date.now() - tStart)
      if (!newId) {
        const dump = JSON.stringify(created)?.slice(0, 200)
        failTo('create-product', null, `BE 200 nhưng no id returned: ${dump}`)
        return
      }
      const partialNote = uploadErrors.length > 0
        ? ` (${uploadedUrls.length}/${files.length} media uploaded; ${uploadErrors.length} failed: ${uploadErrors.slice(0, 2).join(', ')})`
        : uploadedUrls.length > 0 ? ` with ${uploadedUrls.length} media` : ''
      res.redirect(`${base}/products/${newId}?success=${encodeURIComponent('Product created' + partialNote)}`)
    } catch (err) {
      const elapsed = Date.now() - tCreate
      const reason = err instanceof Error ? err.message : 'unknown'
      console.error('[products/new] STEP=create-product FAILED in %dms err=%s', elapsed, reason)
      if (err instanceof ProductApiError && err.kind === 'auth') {
        res.redirect('/accounts/login'); return
      }
      failTo('create-product', null, `${reason} (after ${elapsed}ms)`)
    }
    return
  }

  // Check for slug collision, append suffix if needed
  const existing = await db.selectFrom('products')
    .select('id')
    .where('shop_id', '=', store.id)
    .where('slug', '=', slug)
    .executeTakeFirst()

  const finalSlug = existing ? `${slug}-${Date.now()}` : slug

  // Create product
  const product = await db.insertInto('products')
    .values({
      shop_id: store.id,
      title: title.trim(),
      slug: finalSlug,
      body_html: body_html?.trim() || null,
      vendor: vendor?.trim() || null,
      product_type: product_type?.trim() || null,
      status: status === 'active' ? 'active' : 'draft',
      tags: parsedTags.length > 0 ? parsedTags : null,
      published_at: status === 'active' ? new Date().toISOString() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Create default variant
  await db.insertInto('product_variants')
    .values({
      product_id: product.id,
      title: 'Default',
      price: String(parseFloat(price || '0') || 0),
      compare_at_price: compare_at_price ? String(parseFloat(compare_at_price) || 0) : null,
      sku: sku?.trim() || null,
      inventory_quantity: parseInt(inventory_quantity || '0') || 0,
      position: 0,
    })
    .execute()

  notify(db, {
    shopId: store.id,
    userId: user?.id,
    type: 'product_created',
    title: `Product created: ${title.trim()}`,
    message: [sku ? `SKU ${sku}` : null, byActor(user)].filter(Boolean).join(' • '),
    resourceType: 'product',
    resourceId: product.id,
  })

  // Phase C2 — a newly created active product may match smart
  // collection rules right away. Drafts don't (evaluator filters
  // status='active') but we trigger regardless to keep the
  // "any product mutation → one fan-out" invariant.
  await enqueueSyncShopSmart(db as any, store.id, 'product-create')

  res.redirect(`${base}/products/${product.id}`)
}

// ---------------------------------------------------------------------------
// POST /products/bulk — Bulk actions (activate, draft, archive, delete)
// ---------------------------------------------------------------------------

export async function postProductBulk(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  // Body shape:
  //   ids     — comma-separated product UUIDs, OR the literal string 'ALL'
  //             meaning "every product matching the current filter".
  //   action  — activate | draft | archive | delete
  //   status  — filter scope for ALL (optional; mirrors the UI tab)
  //   q       — search scope for ALL (optional; mirrors the search box)
  //   source  — source-site scope for ALL (Phase 2). One of:
  //             'all' | 'manual' | <clone_job_id>. Defaults to 'all'.
  //             Must be applied to the ALL resolution AND to the
  //             WHERE clause of every UPDATE/DELETE so a
  //             scope-narrowed bulk action can't leak into other
  //             sources' products even if the client sends bogus ids.
  const { ids, action, status: statusFilter, q: searchQ, source: sourceParam } = req.body as {
    ids: string
    action: string
    status?: string
    q?: string
    source?: string
  }
  const rawSourceEarly = ((req.body as { source?: string }).source ?? '').trim()
  if (!ids || !action) {
    const p = new URLSearchParams()
    if (rawSourceEarly && rawSourceEarly !== 'all' && rawSourceEarly !== 'store') {
      p.set('source', rawSourceEarly)
    }
    const qs = p.toString()
    res.redirect(`${base}/products${qs ? '?' + qs : ''}`)
    return
  }

  // Resolve `source` into one of: 'all' | 'manual' | 'job'.
  // We validate job UUIDs against this shop's clone jobs below so a
  // crafted request can't delete products that belong to a different
  // shop's job id.
  //
  // Phase 5 (migration 044) removed the 'orphan' mode: the FK on
  // products.clone_job_id with ON DELETE SET NULL means an orphan row
  // is physically impossible. Stale `?source=__orphan__` bookmarks
  // fall back to 'all' via the default branch.
  const rawSource = (sourceParam ?? '').trim()
  const sourceMode: 'all' | 'manual' | 'job' =
    rawSource === '' || rawSource === 'all' || rawSource === 'store'
      ? 'all'
      : rawSource === 'manual'
        ? 'manual'
        : 'job'

  // If a job id was supplied, verify it belongs to this shop. Invalid
  // or cross-shop ids are coerced back to 'all' (fail-open on scope
  // widening would be bad; we fail-CLOSED on scope widening — if the
  // id is unknown we DON'T run the action, we redirect with an error).
  let scopedJobId: string | null = null
  if (sourceMode === 'job') {
    const row = await (db as any)
      .selectFrom('storefront_clone_jobs')
      .select('id')
      .where('id', '=', rawSource)
      .where('shop_id', '=', store.id)
      .executeTakeFirst()
    if (!row) {
      res.redirect(
        `${base}/products${preserveSource(undefined, 'error', 'Unknown source site.')}`,
      )
      return
    }
    scopedJobId = rawSource
  }

  // Helper to apply the source filter to any query builder.
  function applyBulkSourceFilter<Q extends { where: (...args: any[]) => Q }>(
    q: Q,
    col: string = 'clone_job_id',
  ): Q {
    if (sourceMode === 'manual') return q.where(col, 'is', null)
    if (sourceMode === 'job' && scopedJobId) return q.where(col, '=', scopedJobId)
    return q
  }

  // --------------------------------------------------------------------
  // Resolve the target product ID set.
  //   - 'ALL' means we look up every product in the shop that matches
  //     the current UI filter (status + search + source-site). This
  //     unblocks the "Select all 138 across all pages" flow so the
  //     user can nuke a whole site's products without 7 page-clicks.
  //   - Otherwise we trust the comma-separated UUID list from the
  //     client, scoped by shop_id + source at query-time (below).
  // --------------------------------------------------------------------
  let productIds: string[]
  if (ids === 'ALL') {
    let q = db.selectFrom('products').select('id').where('shop_id', '=', store.id)
    q = applyBulkSourceFilter(q)
    const normalisedStatus = (statusFilter ?? 'all').toLowerCase()
    if (normalisedStatus !== 'all') {
      q = q.where('status', '=', normalisedStatus)
    }
    const search = (searchQ ?? '').trim()
    if (search) {
      q = q.where((eb) =>
        eb.or([
          eb('title', 'ilike', `%${search}%`),
          eb('vendor', 'ilike', `%${search}%`),
          eb('product_type', 'ilike', `%${search}%`),
        ]),
      )
    }
    const rows = await q.execute()
    productIds = rows.map((r) => r.id)
  } else {
    productIds = ids.split(',').filter(Boolean)
  }

  if (productIds.length === 0) {
    res.redirect(`${base}/products${preserveSource(rawSource, 'error', 'No products matched the selection.')}`)
    return
  }

  try {
    switch (action) {
      case 'activate': {
        let u = db.updateTable('products')
          .set({ status: 'active', published_at: new Date().toISOString() })
          .where('shop_id', '=', store.id)
          .where('id', 'in', productIds)
        u = applyBulkSourceFilter(u)
        await u.execute()
        break
      }

      case 'draft': {
        let u = db.updateTable('products')
          .set({ status: 'draft' })
          .where('shop_id', '=', store.id)
          .where('id', 'in', productIds)
        u = applyBulkSourceFilter(u)
        await u.execute()
        break
      }

      case 'archive': {
        let u = db.updateTable('products')
          .set({ status: 'archived' })
          .where('shop_id', '=', store.id)
          .where('id', 'in', productIds)
        u = applyBulkSourceFilter(u)
        await u.execute()
        break
      }

      case 'delete': {
        // Must clear junction tables BEFORE the parent DELETE, otherwise
        // any product that's still referenced by collection_products
        // hits a FK violation and Postgres rolls back the entire batch.
        // The single-delete handler (postProductDelete) does this in the
        // right order — the bulk path was missing collection_products
        // and swallowing the error, which is why "delete all products"
        // silently did nothing.
        //
        // When a source-site filter is active, we re-resolve
        // productIds against the filter first so the junction-table
        // deletes don't accidentally touch rows outside the scope —
        // e.g. if the client sent ids from another source by mistake.
        let effectiveIds = productIds
        if (sourceMode !== 'all') {
          let q = db.selectFrom('products')
            .select('id')
            .where('shop_id', '=', store.id)
            .where('id', 'in', productIds)
          q = applyBulkSourceFilter(q)
          const rows = await q.execute()
          effectiveIds = rows.map((r) => r.id)
          if (effectiveIds.length === 0) {
            res.redirect(
              `${base}/products${preserveSource(rawSource, 'success', 'Nothing to delete in the current scope.')}`,
            )
            return
          }
        }
        await db.deleteFrom('collection_products')
          .where('product_id', 'in', effectiveIds)
          .execute()
        await db.deleteFrom('product_variants')
          .where('product_id', 'in', effectiveIds)
          .execute()
        await db.deleteFrom('product_images')
          .where('product_id', 'in', effectiveIds)
          .execute()
        let del = db.deleteFrom('products')
          .where('shop_id', '=', store.id)
          .where('id', 'in', effectiveIds)
        del = applyBulkSourceFilter(del)
        await del.execute()
        // Overwrite productIds so audit log + notification counts are
        // accurate (using the scoped set, not the raw client list).
        productIds = effectiveIds
        break
      }

      default:
        res.redirect(`${base}/products${preserveSource(rawSource, 'error', 'Unknown bulk action.')}`)
        return
    }

    // Audit log
    await db.insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: action === 'delete' ? 'delete' : 'update',
        resource_type: 'product',
        resource_id: productIds[0],
        details: JSON.stringify({ bulk: true, count: productIds.length, action, scope: ids === 'ALL' ? 'all_filtered' : 'ids' }),
      })
      .execute()
      .catch(() => {})

    // Notification
    const notifTitle = action === 'delete'
      ? `${productIds.length} product(s) deleted`
      : `${productIds.length} product(s) ${action}d`
    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'products_bulk_updated',
      title: notifTitle,
      message: byActor(user),
      resourceType: 'product',
      resourceId: null,
    })

    // Phase C2 — bulk activate/draft/archive/delete all touch
    // `products.status` or remove rows entirely, both of which change
    // smart-collection membership for every affected product. One
    // fan-out call covers the whole batch thanks to BullMQ's
    // per-collection jobId idempotency.
    await enqueueSyncShopSmart(db as any, store.id, `product-bulk-${action}`)

    const successMsg = action === 'delete'
      ? `Deleted ${productIds.length} product${productIds.length !== 1 ? 's' : ''}.`
      : `Updated ${productIds.length} product${productIds.length !== 1 ? 's' : ''}.`
    res.redirect(`${base}/products${preserveSource(rawSource, 'success', successMsg)}`)
    return
  } catch (err: any) {
    // Log the FULL error (message + code + detail) so we can diagnose
    // FK / constraint failures in pm2 logs instead of just seeing a
    // silent redirect like the old handler did.
    console.error('[products bulk action failed]', {
      action,
      scope: ids === 'ALL' ? 'all_filtered' : 'ids',
      count: productIds.length,
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      constraint: err?.constraint,
    })
    res.redirect(`${base}/products${preserveSource(rawSource, 'error', 'Bulk action failed. Check server logs for details.')}`)
    return
  }
}

/**
 * Build the query-string suffix for a bulk-action redirect that
 * preserves the merchant's active source-site tab AND attaches
 * either ?success=... or ?error=... for the banner.
 *
 * Example:
 *   preserveSource('abc-123', 'success', 'Deleted 42 products.')
 *   → '?source=abc-123&success=Deleted%2042%20products.'
 */
function preserveSource(
  source: string | undefined,
  kind: 'success' | 'error',
  message: string,
): string {
  const p = new URLSearchParams()
  const s = (source ?? '').trim()
  if (s && s !== 'all' && s !== 'store') p.set('source', s)
  p.set(kind, message)
  return `?${p.toString()}`
}

// ---------------------------------------------------------------------------
// POST /products/bulk/edit — Phase 2 PR6: bulk field edit (multi-tab modal)
// ---------------------------------------------------------------------------
//
// Bulk field editing across a selection of products. Unlike postProductBulk
// (which only toggles status/deletes), this endpoint mutates content:
//
//   editMode                        | body fields
//   ─────────────────────────────── | ──────────────────────────────────────
//   tag_add / tag_remove            | tags (comma-separated list of tags)
//   price_adjust / compare_adjust   | adjustType ('percent'|'amount')
//                                   | adjustValue (signed number, e.g. +10, -5)
//                                   | rounding    ('floor'|'round'|'ceil')
//   collection_add / collection_rem | collectionIds (comma-separated UUIDs)
//   status_set                      | status ('active'|'draft'|'archived')
//   metafield_set                   | mfNamespace, mfKey, mfValue, mfValueType
//
// Scope resolution mirrors postProductBulk: `ids` is either a comma-list
// of product UUIDs or the literal 'ALL' (all filtered). Cross-shop ids
// are implicitly rejected because every query is scoped by shop_id.
//
// All writes run as plain SQL inside a try/catch — no outer transaction
// because Kysely doesn't give us BEGIN/COMMIT at this call site and the
// operations are idempotent for the merchant's mental model (a partial
// failure just shows up as "updated N of M"). We still log the full
// error server-side like the sibling bulk handler.

export async function postProductBulkEdit(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  const body = req.body as {
    ids?: string
    editMode?: string
    tags?: string
    adjustType?: string
    adjustValue?: string
    rounding?: string
    collectionIds?: string
    status?: string
    mfNamespace?: string
    mfKey?: string
    mfValue?: string
    mfValueType?: string
    source?: string
    q?: string
    statusFilter?: string
  }

  const rawSource = (body.source ?? '').trim()
  const redirect = (kind: 'success' | 'error', msg: string) =>
    res.redirect(`${base}/products${preserveSource(rawSource, kind, msg)}`)

  const editMode = (body.editMode ?? '').trim()
  if (!body.ids || !editMode) {
    redirect('error', 'Missing selection or edit mode.')
    return
  }

  // Resolve target set. Mirror postProductBulk scope resolution.
  let productIds: string[]
  if (body.ids === 'ALL') {
    let q = db.selectFrom('products').select('id').where('shop_id', '=', store.id)
    const statusF = (body.statusFilter ?? 'all').toLowerCase()
    if (statusF !== 'all') q = q.where('status', '=', statusF)
    const search = (body.q ?? '').trim()
    if (search) {
      q = q.where((eb) =>
        eb.or([
          eb('title', 'ilike', `%${search}%`),
          eb('vendor', 'ilike', `%${search}%`),
          eb('product_type', 'ilike', `%${search}%`),
        ]),
      )
    }
    const rows = await q.execute()
    productIds = rows.map((r) => r.id)
  } else {
    productIds = body.ids.split(',').map((x) => x.trim()).filter(Boolean)
    // Scope-filter client-supplied ids to this shop. Cross-shop ids are
    // silently dropped (Shopify-parity: fail-closed on scope widening,
    // don't leak "that id exists but isn't yours" through a 4xx).
    if (productIds.length > 0) {
      const rows = await db
        .selectFrom('products')
        .select('id')
        .where('shop_id', '=', store.id)
        .where('id', 'in', productIds)
        .execute()
      productIds = rows.map((r) => r.id)
    }
  }

  if (productIds.length === 0) {
    redirect('error', 'No products matched the selection.')
    return
  }

  let updatedCount = 0
  try {
    switch (editMode) {
      // ─── tag_add / tag_remove ────────────────────────────────────────
      //
      // Tags live as `products.tags text[]`. We can't use a single
      // SQL UPDATE with array_cat because we need to dedupe — two
      // merchants adding the same tag twice shouldn't leave a
      // duplicated entry. Instead: read → merge → write per product.
      // For bulk of ~1000 products this is ~1000 round-trips which is
      // acceptable (< 3s on local PG); if it becomes a hotspot we can
      // move to CASE WHEN array_remove/array_append in one statement.
      case 'tag_add':
      case 'tag_remove': {
        const tagList = (body.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        if (tagList.length === 0) {
          redirect('error', 'No tags provided.')
          return
        }
        const rows = await db
          .selectFrom('products')
          .select(['id', 'tags'])
          .where('shop_id', '=', store.id)
          .where('id', 'in', productIds)
          .execute()
        for (const row of rows) {
          const current = Array.isArray(row.tags) ? [...(row.tags as string[])] : []
          let next: string[]
          if (editMode === 'tag_add') {
            const set = new Set<string>(current)
            for (const t of tagList) set.add(t)
            next = Array.from(set)
          } else {
            const removeSet = new Set(tagList)
            next = current.filter((t) => !removeSet.has(t))
          }
          await db
            .updateTable('products')
            .set({ tags: next.length > 0 ? (next as any) : null })
            .where('id', '=', row.id)
            .execute()
          updatedCount++
        }
        break
      }

      // ─── price_adjust / compare_adjust ───────────────────────────────
      //
      // Applies to EVERY variant of EVERY selected product. Semantics:
      //   adjustType='percent'  → new = old * (1 + value/100)
      //   adjustType='amount'   → new = old + value
      //   rounding: 'floor' (default, Shopify convention), 'round', 'ceil'
      // Negative prices are clamped to 0 — we don't want to quietly
      // flip a merchant's price to -$3.20 if they typo'd the sign.
      case 'price_adjust':
      case 'compare_adjust': {
        const adjustType = (body.adjustType ?? 'percent').trim()
        const raw = Number.parseFloat(body.adjustValue ?? '')
        if (!Number.isFinite(raw) || raw === 0) {
          redirect('error', 'Adjustment value must be a non-zero number.')
          return
        }
        if (adjustType !== 'percent' && adjustType !== 'amount') {
          redirect('error', 'Invalid adjustment type.')
          return
        }
        const roundingMode = (body.rounding ?? 'floor').trim()
        const applyRounding = (n: number): number => {
          // Work in cents to avoid FP drift, then apply chosen rounding.
          const cents = n * 100
          if (roundingMode === 'round') return Math.round(cents) / 100
          if (roundingMode === 'ceil') return Math.ceil(cents) / 100
          return Math.floor(cents) / 100
        }
        const col = editMode === 'price_adjust' ? 'price' : 'compare_at_price'
        const variantRows = await db
          .selectFrom('product_variants')
          .select(['id', col])
          .where('product_id', 'in', productIds)
          .execute()
        for (const v of variantRows) {
          const oldStr = (v as any)[col]
          if (oldStr == null) continue
          const old = Number.parseFloat(oldStr)
          if (!Number.isFinite(old)) continue
          const next = adjustType === 'percent' ? old * (1 + raw / 100) : old + raw
          const clamped = next < 0 ? 0 : applyRounding(next)
          await db
            .updateTable('product_variants')
            .set({ [col]: clamped.toFixed(2) } as any)
            .where('id', '=', v.id)
            .execute()
        }
        updatedCount = productIds.length
        break
      }

      // ─── collection_add / collection_remove ──────────────────────────
      //
      // collectionIds is a comma-list of collection UUIDs. We scope them
      // to this shop (cross-shop ids silently dropped) then upsert or
      // delete rows in the `collection_products` junction.
      case 'collection_add':
      case 'collection_remove': {
        const wantedIds = (body.collectionIds ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        if (wantedIds.length === 0) {
          redirect('error', 'No collections selected.')
          return
        }
        const colRows = await db
          .selectFrom('collections')
          .select('id')
          .where('shop_id', '=', store.id)
          .where('id', 'in', wantedIds)
          .execute()
        const scopedIds = colRows.map((r) => r.id)
        if (scopedIds.length === 0) {
          redirect('error', 'No valid collections in selection.')
          return
        }
        if (editMode === 'collection_add') {
          // INSERT … ON CONFLICT DO NOTHING equivalent: build every
          // (product_id, collection_id) pair, skip existing rows.
          const existing = await db
            .selectFrom('collection_products')
            .select(['product_id', 'collection_id'])
            .where('product_id', 'in', productIds)
            .where('collection_id', 'in', scopedIds)
            .execute()
          const seen = new Set(existing.map((r) => `${r.product_id}:${r.collection_id}`))
          const rows: { product_id: string; collection_id: string }[] = []
          for (const pid of productIds) {
            for (const cid of scopedIds) {
              if (!seen.has(`${pid}:${cid}`)) {
                rows.push({ product_id: pid, collection_id: cid })
              }
            }
          }
          if (rows.length > 0) {
            await db.insertInto('collection_products').values(rows as any).execute()
          }
        } else {
          await db
            .deleteFrom('collection_products')
            .where('product_id', 'in', productIds)
            .where('collection_id', 'in', scopedIds)
            .execute()
        }
        updatedCount = productIds.length
        break
      }

      // ─── status_set ──────────────────────────────────────────────────
      //
      // Mirrors postProductBulk but routed through the Edit modal so
      // merchants have ONE entry point for field-level bulk changes.
      case 'status_set': {
        const s = (body.status ?? '').trim().toLowerCase()
        if (s !== 'active' && s !== 'draft' && s !== 'archived') {
          redirect('error', 'Invalid status.')
          return
        }
        const patch: Record<string, unknown> = { status: s }
        if (s === 'active') patch.published_at = new Date().toISOString()
        await db
          .updateTable('products')
          .set(patch as any)
          .where('shop_id', '=', store.id)
          .where('id', 'in', productIds)
          .execute()
        updatedCount = productIds.length
        break
      }

      // ─── metafield_set ───────────────────────────────────────────────
      //
      // Upsert the same (namespace, key, value) on every selected
      // product. Validation + JSON encoding happens inside setMetafield
      // so invalid keys bomb out early — we catch and report.
      case 'metafield_set': {
        const ns = (body.mfNamespace ?? '').trim()
        const key = (body.mfKey ?? '').trim()
        const val = body.mfValue ?? ''
        const valueType = (body.mfValueType ?? 'single_line_text_field').trim() as any
        if (!ns || !key) {
          redirect('error', 'Namespace and key are required.')
          return
        }
        // For JSON types we parse so the service doesn't double-encode;
        // for primitives we leave the raw string and let setMetafield
        // stringify it. Best-effort: on parse failure we surface the
        // error instead of storing malformed JSON.
        let parsed: unknown = val
        if (valueType === 'json') {
          try {
            parsed = JSON.parse(val)
          } catch {
            redirect('error', 'Custom field value is not valid JSON.')
            return
          }
        } else if (valueType === 'number_integer') {
          const n = Number.parseInt(val, 10)
          if (!Number.isFinite(n)) {
            redirect('error', 'Custom field value must be an integer.')
            return
          }
          parsed = n
        } else if (valueType === 'number_decimal') {
          const n = Number.parseFloat(val)
          if (!Number.isFinite(n)) {
            redirect('error', 'Custom field value must be a number.')
            return
          }
          parsed = n
        } else if (valueType === 'boolean') {
          parsed = val === 'true' || val === '1' || val === 'on'
        }
        for (const pid of productIds) {
          await setMetafield(db, {
            shop_id: store.id,
            owner_type: 'product',
            owner_id: pid,
            namespace: ns,
            key,
            value: parsed,
            value_type: valueType,
          })
          updatedCount++
        }
        break
      }

      default:
        redirect('error', 'Unknown edit mode.')
        return
    }

    // Audit + notify + smart-collection fan-out mirror postProductBulk.
    await db
      .insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: 'update',
        resource_type: 'product',
        resource_id: productIds[0],
        details: JSON.stringify({
          bulk: true,
          count: productIds.length,
          editMode,
          scope: body.ids === 'ALL' ? 'all_filtered' : 'ids',
        }),
      })
      .execute()
      .catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'products_bulk_updated',
      title: `${updatedCount} product(s) updated (${editMode})`,
      message: byActor(user),
      resourceType: 'product',
      resourceId: null,
    })

    // Tag/price/status changes can all swap smart-collection memberships
    // (tag-based rules, price-range rules, published-status rules). Fire
    // the fan-out once per bulk regardless of edit mode.
    await enqueueSyncShopSmart(db as any, store.id, `product-bulk-edit-${editMode}`)

    redirect(
      'success',
      `Updated ${updatedCount} product${updatedCount !== 1 ? 's' : ''}.`,
    )
    return
  } catch (err: any) {
    console.error('[products bulk edit failed]', {
      editMode,
      count: productIds.length,
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
    })
    redirect(
      'error',
      `Bulk edit failed: ${err?.message ?? 'unknown error'}`,
    )
  }
}

// ---------------------------------------------------------------------------
// POST /products/:productId/seo-shortcut — Phase 2 PR6: one-click SEO metafields
// ---------------------------------------------------------------------------
//
// Shopify themes increasingly read `product.metafields.seo.title` etc.
// for richer structured-data output instead of the legacy `seo_title`
// column. Rather than make merchants do the full "Add custom field" dance
// three times, the shortcut pre-fills a small modal with the product's
// current seo_title / seo_description / slug and upserts all three in
// the `seo` namespace on submit. Values persist as metafields; the
// native `products.seo_title` / `seo_description` / `slug` columns are
// left untouched so the "Search engine listing preview" keeps working.

export async function postProductSeoShortcut(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const productId = await resolveProductId(store.id, String(req.params.productId ?? ''))

  // Scope check: confirm the product belongs to this shop before writing
  // metafields against its id. resolveProductId can return PRODUCT_ID_MISS
  // for unknown handles, which would otherwise sneak a metafield row
  // onto a nonsense owner_id.
  const product = await db
    .selectFrom('products')
    .select(['id'])
    .where('id', '=', productId)
    .where('shop_id', '=', store.id)
    .executeTakeFirst()

  if (!product) {
    res.redirect(`${base}/products`)
    return
  }

  const body = req.body as {
    seoTitle?: string
    seoDescription?: string
    seoHandle?: string
  }

  const fields: { key: string; value: string }[] = []
  if (typeof body.seoTitle === 'string' && body.seoTitle.trim()) {
    fields.push({ key: 'title', value: body.seoTitle.trim() })
  }
  if (typeof body.seoDescription === 'string' && body.seoDescription.trim()) {
    fields.push({ key: 'description', value: body.seoDescription.trim() })
  }
  if (typeof body.seoHandle === 'string' && body.seoHandle.trim()) {
    fields.push({ key: 'handle', value: body.seoHandle.trim() })
  }

  if (fields.length === 0) {
    res.redirect(`${base}/products/${productId}?error=SEO+shortcut+needs+at+least+one+field.`)
    return
  }

  try {
    for (const f of fields) {
      await setMetafield(db, {
        shop_id: store.id,
        owner_type: 'product',
        owner_id: productId,
        namespace: 'seo',
        key: f.key,
        value: f.value,
        value_type: f.key === 'description' ? 'multi_line_text_field' : 'single_line_text_field',
      })
    }

    await db
      .insertInto('audit_logs')
      .values({
        shop_id: store.id,
        user_id: user.id,
        action: 'update',
        resource_type: 'product',
        resource_id: productId,
        details: JSON.stringify({ seo_shortcut: true, keys: fields.map((f) => f.key) }),
      })
      .execute()
      .catch(() => {})

    res.redirect(
      `${base}/products/${productId}?success=${encodeURIComponent(
        `SEO metafields saved (${fields.map((f) => `seo.${f.key}`).join(', ')}).`,
      )}`,
    )
  } catch (err: any) {
    console.error('[seo shortcut failed]', { productId, message: err?.message })
    res.redirect(
      `${base}/products/${productId}?error=${encodeURIComponent(
        `SEO shortcut failed: ${err?.message ?? 'unknown error'}`,
      )}`,
    )
  }
}

// ---------------------------------------------------------------------------
// POST /products/lenful/import — One-click push to legacy Gbox master shop
// ---------------------------------------------------------------------------
//
// Migration 033 changed this handler's contract. Historical behaviour
// (create a v4 draft product + lenful_product_map row locally) is gone —
// we now funnel every click to ONE master legacy Gbox shop owned by a
// god-admin-configured account. Reasoning documented in migration 033.
//
// Flow:
//   1. Load the Lenful catalog entry (same as before)
//   2. Map it to a LegacyProductPayload (see gbox-legacy/product-map.ts)
//   3. POST to api-product.gbox.co via createLegacyProduct()
//      (login-on-demand + in-memory JWT cache handled there)
//   4. Write a row to legacy_gbox_push_log for audit
//   5. On success: bump the config push counter + notification
//   6. Redirect back to the Lenful tab with a banner message
//
// Re-import is still allowed — every call generates fresh SKUs so the
// legacy side doesn't reject on uniqueness.

export async function postProductImportFromLenful(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const base = `/admin/store/${store.slug}`

  const lenfulProductId = String((req.body as any)?.lenful_product_id || '').trim()
  if (!lenfulProductId) {
    res.redirect(`${base}/products?source=lenful&error=missing_id`)
    return
  }

  // 1. Load full catalog entry (see dbCore note in renderLenfulCatalogTab)
  const entry = await getLenfulCatalogEntry(db as any, lenfulProductId)
  if (!entry) {
    res.redirect(`${base}/products?source=lenful&error=not_found`)
    return
  }

  // 2. Branch on legacy master config presence.
  //    - Config exists → push to api-product.gbox.co (migration 033 flow).
  //    - No config    → copy into a draft product in the seller's OWN
  //                     shop so the "Add to my store" button works even
  //                     before a god-admin wires the master shop.
  //                     Iron Rule 5: the seller never sees "god admin"
  //                     anywhere — the local path is the user-facing
  //                     default; the legacy push becomes an optimization
  //                     that kicks in once the platform is configured.
  const legacyConfig = await getLegacyGboxActiveConfig(db)

  if (!legacyConfig) {
    // ── Local draft path ────────────────────────────────────────────
    const copy = await copyCatalogEntryToLocalProduct(db, {
      shopId: store.id,
      entry,
      userId: user?.id ?? null,
    })

    if (!copy.ok) {
      const qs = new URLSearchParams({
        source: 'lenful',
        error: copy.errorCode,
        error_msg: (copy.errorMessage ?? '').slice(0, 200),
      })
      res.redirect(`${base}/products?${qs.toString()}`)
      return
    }

    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'product_created',
      title: `Imported from Lenful: ${entry.title ?? entry.lenful_product_sku}`,
      message: [
        `${copy.variantCount} variant${copy.variantCount === 1 ? '' : 's'}`,
        `${copy.imageCount} image${copy.imageCount === 1 ? '' : 's'}`,
        'draft',
        byActor(user),
      ]
        .filter(Boolean)
        .join(' • '),
      resourceType: 'product',
      resourceId: copy.productId,
    })

    // Kick the smart-collection fan-out so the new draft appears in
    // any matching automated collections immediately.
    try {
      await enqueueSyncShopSmart({ shopId: store.id, productId: copy.productId })
    } catch (qErr: any) {
      console.warn(
        '[Lenful → local] smart-collection enqueue failed:',
        qErr?.message,
      )
    }

    // Land the seller on the product detail page so they can review,
    // edit pricing, and publish — same UX as hand-creating a product.
    res.redirect(
      `${base}/products/${copy.slug}?source=lenful&imported=1&status=draft`,
    )
    return
  }

  // ── Legacy master-shop push path ────────────────────────────────
  // 3. Map Lenful normalized entry → legacy Gbox product payload
  const payload = mapLenfulEntryToLegacyProduct(entry)

  // 4. POST to the active master shop (login on demand)
  const push = await createLegacyProduct({ db, product: payload })

  // 5. Audit log (best-effort — never block the response on a log write)
  try {
    if (push.ok) {
      await recordPush(db, {
        configId: push.config.id,
        triggeredByUserId: user?.id ?? null,
        triggeredFromShopId: store.id,
        lenfulProductId: entry.lenful_product_id,
        lenfulProductSku: entry.lenful_product_sku,
        lenfulProductTitle: entry.title,
        legacyShopId: push.config.master_shop_id,
        legacyProductId: push.result.legacyProductId,
        httpStatus: push.result.status,
        success: true,
        errorMessage: null,
        latencyMs: push.result.latencyMs,
      })
      await bumpPushCount(db, push.config.id)
    } else if (push.config) {
      await recordPush(db, {
        configId: push.config.id,
        triggeredByUserId: user?.id ?? null,
        triggeredFromShopId: store.id,
        lenfulProductId: entry.lenful_product_id,
        lenfulProductSku: entry.lenful_product_sku,
        lenfulProductTitle: entry.title,
        legacyShopId: push.config.master_shop_id,
        legacyProductId: push.result?.legacyProductId ?? null,
        httpStatus: push.result?.status ?? 0,
        success: false,
        errorMessage: push.errorMessage,
        latencyMs: push.result?.latencyMs ?? null,
      })
    }
  } catch (logErr: any) {
    console.warn('[Lenful → Legacy] push-log insert failed:', logErr?.message)
  }

  // 6. Error branches
  if (!push.ok) {
    // `no_config` shouldn't happen here (we checked above), but if the
    // config row was deleted between `getLegacyGboxActiveConfig` and
    // `createLegacyProduct` — race — fall through with a generic
    // "contact support" message that does NOT leak any god-admin path.
    // See Iron Rule 5 in CLAUDE.md.
    if (push.errorCode === 'no_config') {
      res.redirect(
        `${base}/products?source=lenful&error=no_fulfillment_backend`,
      )
      return
    }
    const qs = new URLSearchParams({
      source: 'lenful',
      error: push.errorCode,
      error_msg: (push.errorMessage ?? '').slice(0, 200),
    })
    res.redirect(`${base}/products?${qs.toString()}`)
    return
  }

  // 7. Success — notify + redirect back to the catalog grid so the
  //    seller can queue another product immediately.
  notify(db, {
    shopId: store.id,
    userId: user?.id,
    type: 'product_created',
    title: `Pushed to Gbox master: ${entry.title ?? entry.lenful_product_sku}`,
    message: [
      push.result.legacyProductId
        ? `legacy id ${push.result.legacyProductId}`
        : `HTTP ${push.result.status}`,
      `${push.result.latencyMs}ms`,
      byActor(user),
    ]
      .filter(Boolean)
      .join(' • '),
    resourceType: 'product',
    resourceId: push.result.legacyProductId ?? push.config.id,
  })

  const qs = new URLSearchParams({
    source: 'lenful',
    pushed: '1',
    legacy_id: push.result.legacyProductId ?? '',
  })
  res.redirect(`${base}/products?${qs.toString()}`)
}

// NOTE: `buildLenfulImportDescription` and `escHtml` below are retained
// as module-local helpers even though the Lenful import no longer calls
// them directly. The product-map module in @gbox/core uses its own body
// template; these remain available for any future v4-side body rendering
// (e.g. a seller-facing preview of what was pushed). Safe to remove if
// /*#__PURE__*/ tree-shaking ever becomes a concern for this app.

/**
 * Build the imported-product description using a Gbox-theme-inspired
 * template: hero blurb, "What's inside" bullets, options summary,
 * ship/quality reassurance footer. All text is seller-editable once
 * they land on the product detail page.
 */
function buildLenfulImportDescription(args: {
  title: string
  description: string | null
  category_name: string | null
  options: ReadonlyArray<{ name: string; values: ReadonlyArray<string> }>
  base_price: number | null
  currency: string
  lenful_sku: string
}): string {
  const hero = args.description
    ? args.description.trim()
    : `Premium ${args.category_name || 'print-on-demand'} product, crafted on demand and shipped directly from our fulfillment partner. Add your own design, your own price, and start selling today.`

  const optionRows = args.options
    .map(
      (o) =>
        `<li><strong>${escHtml(o.name)}:</strong> ${o.values
          .map(escHtml)
          .join(' • ')}</li>`,
    )
    .join('')

  return `
<div class="gbox-product-description">
  <p>${escHtml(hero)}</p>

  ${
    args.options.length > 0
      ? `<h3>Available options</h3>
  <ul>
    ${optionRows}
  </ul>`
      : ''
  }

  <h3>Why you'll love it</h3>
  <ul>
    <li><strong>Print-on-demand</strong> — no inventory risk, no upfront cost</li>
    <li><strong>Ships worldwide</strong> — fulfilled through Gbox's global partner network</li>
    <li><strong>Quality guaranteed</strong> — every order is inspected before it leaves the warehouse</li>
    <li><strong>Custom designs welcome</strong> — upload your artwork and we'll handle the rest</li>
  </ul>

  <h3>Shipping & handling</h3>
  <p>Orders are produced on demand and typically ship within 3–5 business days. Tracking is emailed as soon as your order leaves our facility.</p>

  <!-- Imported from Lenful SKU: ${escHtml(args.lenful_sku)} — edit this description to match your brand voice -->
</div>
  `.trim()
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// POST /products/lenful/sync-now — Manual refresh of the Lenful catalog cache
// ---------------------------------------------------------------------------
//
// Triggers a full walk of the Lenful /api/product endpoint and upserts every
// row into `lenful_catalog`. Respects the 2 req/s rate limit in the client.
// If no active Lenful credential exists, falls back silently so the button
// still works in dev against the seeded mock data (which doesn't need sync).

export async function postLenfulCatalogSyncNow(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const base = `/admin/store/${store.slug}`

  // Find the active Lenful credential. If none exists, just redirect back —
  // seeded mock data doesn't need a live sync.
  const credRow = await db
    .selectFrom('lenful_credentials')
    .select(['id'])
    .where('is_active', '=', true)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()

  if (!credRow) {
    res.redirect(`${base}/products?source=lenful&msg=no_credential`)
    return
  }

  try {
    const result = await syncLenfulCatalogFromLive(db as any, {
      credentialId: credRow.id,
      triggeredBy: `seller-sync:${user?.id ?? 'anon'}`,
      userId: user?.id ?? null,
    })
    notify(db, {
      shopId: store.id,
      userId: user?.id,
      type: 'lenful_catalog_synced',
      title: `Synced Lenful catalog: ${result.upserted} products`,
      message: [
        `${result.fetched} fetched`,
        `${result.upserted} upserted`,
        result.deactivated > 0 ? `${result.deactivated} deactivated` : null,
        result.errors.length > 0 ? `${result.errors.length} errors` : null,
        byActor(user),
      ]
        .filter(Boolean)
        .join(' • '),
      resourceType: 'product',
      resourceId: null,
    })
    const q = new URLSearchParams({
      source: 'lenful',
      msg: 'sync_ok',
      upserted: String(result.upserted),
    })
    res.redirect(`${base}/products?${q.toString()}`)
  } catch (err: any) {
    console.error('[Lenful sync] failed:', err?.message)
    const q = new URLSearchParams({
      source: 'lenful',
      error: 'sync_failed',
      msg: err?.message?.slice(0, 120) ?? 'unknown',
    })
    res.redirect(`${base}/products?${q.toString()}`)
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// POST /products/:productId/media-upload — Upload image (multipart) to S3 via
// BE Shop Service Images endpoint, then append URL to product.images[] via
// BE Product PUT. JSON-only response so the client can reload on success.
//
// BE chain:
//   1. POST {API_SHOP_BASE_URL}/api/{shop_id}/images  (multipart file=)
//      → returns { url: 'https://...' }  (Amazon S3 public URL)
//   2. GET  {API_PRODUCT_BASE_URL}/api/{shop_id}/{product_id}  → current product
//   3. PUT  {API_PRODUCT_BASE_URL}/api/{shop_id}/{product_id}  body={...product, images:[..., {url}]}
// ---------------------------------------------------------------------------
export async function postProductMediaUploadApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).json({ ok: false, error: 'Store missing' }); return }
  const productId = String(req.params.productId ?? req.params.id ?? '')
  if (!productId) { res.status(400).json({ ok: false, error: 'productId required' }); return }
  const file = (req as any).file as { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined
  if (!file?.buffer) { res.status(400).json({ ok: false, error: 'No file uploaded' }); return }
  if (file.size > 5 * 1024 * 1024) { res.status(400).json({ ok: false, error: 'File too large (max 5MB)' }); return }

  const shopApi = (process.env.API_SHOP_BASE_URL || 'https://api-shop.gbox.co').replace(/\/+$/, '')
  const productApi = (process.env.API_PRODUCT_BASE_URL || 'https://api-product.gbox.co').replace(/\/+$/, '')
  const cookieHeader = req.headers.cookie ?? ''
  const token = getSessionTokenFromCookies(cookieHeader)

  // Step 1: upload to BE Shop Service Images endpoint (S3-backed)
  let uploadUrl = ''
  try {
    const fd = new FormData()
    fd.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname)
    const r = await fetch(`${shopApi}/api/${encodeURIComponent(store.id)}/images`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: fd as any,
      signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      res.status(502).json({ ok: false, error: `S3 upload failed: HTTP ${r.status} ${text.slice(0, 200)}` })
      return
    }
    const data: any = await r.json().catch(() => null)
    uploadUrl = data?.url || ''
    if (!uploadUrl) { res.status(502).json({ ok: false, error: 'Upload OK but no URL returned' }); return }
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message || 'S3 upload failed' })
    return
  }

  // Step 2: GET current product, append URL to images, PUT back.
  try {
    const getRes = await fetch(`${productApi}/api/${encodeURIComponent(store.id)}/${encodeURIComponent(productId)}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10000),
    })
    if (!getRes.ok) { res.status(502).json({ ok: false, error: 'Failed to load product' }); return }
    const prodPayload: any = await getRes.json().catch(() => null)
    const product = prodPayload?.data || prodPayload
    if (!product?.id) { res.status(502).json({ ok: false, error: 'Product not found' }); return }
    const existingImages = Array.isArray(product.images) ? product.images : []
    const newImages = [...existingImages, { url: uploadUrl }]
    const putRes = await fetch(`${productApi}/api/${encodeURIComponent(store.id)}/${encodeURIComponent(productId)}`, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...product, images: newImages }),
      signal: AbortSignal.timeout(15000),
    })
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => '')
      res.status(502).json({ ok: false, error: `Product update failed: HTTP ${putRes.status} ${text.slice(0, 200)}` })
      return
    }
    res.json({ ok: true, url: uploadUrl })
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message || 'Product update failed' })
  }
}

// ---------------------------------------------------------------------------
// POST /products/:productId/media-remove?index=N — Remove an image from
// product.images[] (API mode). Index-based because BE images don't carry an
// id we can reference. JSON-only response so the client can reload on success.
// ---------------------------------------------------------------------------
export async function postProductMediaRemoveApi(req: Request, res: Response): Promise<void> {
  const store = req.store
  if (!store) { res.status(404).json({ ok: false, error: 'Store missing' }); return }
  const productId = String(req.params.productId ?? req.params.id ?? '')
  if (!productId) { res.status(400).json({ ok: false, error: 'productId required' }); return }
  const idxRaw = String((req.query.index ?? (req.body as any)?.index) ?? '')
  const idx = parseInt(idxRaw, 10)
  if (!Number.isFinite(idx) || idx < 0) { res.status(400).json({ ok: false, error: 'Invalid index' }); return }

  const productApi = (process.env.API_PRODUCT_BASE_URL || 'https://api-product.gbox.co').replace(/\/+$/, '')
  const cookieHeader = req.headers.cookie ?? ''
  const token = getSessionTokenFromCookies(cookieHeader)

  try {
    const getRes = await fetch(`${productApi}/api/${encodeURIComponent(store.id)}/${encodeURIComponent(productId)}`, {
      method: 'GET',
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10000),
    })
    if (!getRes.ok) { res.status(502).json({ ok: false, error: 'Failed to load product' }); return }
    const prodPayload: any = await getRes.json().catch(() => null)
    const product = prodPayload?.data || prodPayload
    if (!product?.id) { res.status(404).json({ ok: false, error: 'Product not found' }); return }
    const images = Array.isArray(product.images) ? product.images.slice() : []
    if (idx >= images.length) { res.status(400).json({ ok: false, error: 'Index out of range' }); return }
    images.splice(idx, 1)

    const putRes = await fetch(`${productApi}/api/${encodeURIComponent(store.id)}/${encodeURIComponent(productId)}`, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...product, images }),
      signal: AbortSignal.timeout(15000),
    })
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => '')
      res.status(502).json({ ok: false, error: `Product update failed: HTTP ${putRes.status} ${text.slice(0, 200)}` })
      return
    }
    res.json({ ok: true, removedIndex: idx })
  } catch (err: any) {
    res.status(502).json({ ok: false, error: err?.message || 'Remove failed' })
  }
}
