/**
 * Store Admin — Inventory Management (Phase 05 — .NET API, single-location)
 *
 * Replaces the Kysely/multi-location implementation with a .NET API client.
 * Multi-location is a follow-up phase (no location table, no inventory_levels).
 *
 * Routes:
 *   GET  /admin/store/:slug/products/inventory
 *   POST /admin/store/:slug/products/inventory/adjust   (per-row +/-/=)
 *   POST /admin/store/:slug/products/inventory/bulk-set (bulk =N only)
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { logSellerAction } from '../middleware/store-auth.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import {
  createApiContext,
  listProducts,
  listCategories,
  getProduct,
  updateProduct,
  bulkUpdateInventory,
  ProductApiError,
} from '../lib/product-api-client.js'
import { injectAdminStyles } from '../components/shared-styles.js'
import { badge } from '../components/badge.js'
import { statCard } from '../components/stat-card.js'
import { emptyState } from '../components/empty-state.js'
import { pagination } from '../components/pagination.js'
import { filterToolbar } from '../components/filter-toolbar.js'
import { bulkActionBar } from '../components/bulk-action-bar.js'
import { parseAdjust } from '../lib/inventory-adjust-parser.js'
import type { Product } from '../lib/product-api-types.js'

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const LOW_STOCK_THRESHOLD = 10
const DEFAULT_PER_PAGE = 10
const MAX_PER_PAGE = 200

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VariantRow {
  productId: string
  productName: string
  productSlug: string
  variantId: string
  variantSlug: string
  variantTitle: string
  sku: string
  price: number
  onHand: number
  imageUrl: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenToRows(products: Product[]): VariantRow[] {
  const rows: VariantRow[] = []
  for (const p of products) {
    const variants = p.variants ?? []
    if (variants.length === 0) continue
    for (const v of variants) {
      // BE comment Product.cs:336: slug auto-gen từ name nếu null. Slug là
      // identifier chính cho variant (id có thể trống, sku có thể trống).
      const variantSlug = (v as any).slug ?? slugifyVariantName(v.name ?? '')
      rows.push({
        productId: p.id ?? '',
        productName: p.name ?? '',
        productSlug: p.slug ?? '',
        variantId: v.id ?? '',
        variantSlug,
        variantTitle: v.name ?? 'Default',
        sku: v.sku ?? '',
        price: Number(v.price ?? 0),
        onHand: Number(v.inventory ?? 0),
        imageUrl: p.images?.[0]?.url ?? '',
      })
    }
  }
  return rows
}

function slugifyVariantName(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function stockBadgeHtml(onHand: number): string {
  if (onHand <= 0) return badge({ label: 'Out of stock', variant: 'danger' })
  if (onHand <= LOW_STOCK_THRESHOLD) return badge({ label: 'Low stock', variant: 'warning' })
  return badge({ label: 'In stock', variant: 'success' })
}

function applyStockFilter(rows: VariantRow[], stockFilter: string): VariantRow[] {
  if (stockFilter === 'in-stock') return rows.filter((r) => r.onHand > LOW_STOCK_THRESHOLD)
  if (stockFilter === 'low') return rows.filter((r) => r.onHand > 0 && r.onHand <= LOW_STOCK_THRESHOLD)
  if (stockFilter === 'out') return rows.filter((r) => r.onHand <= 0)
  return rows
}

function applySort(rows: VariantRow[], sort: string): VariantRow[] {
  const copy = [...rows]
  switch (sort) {
    case 'name': copy.sort((a, b) => a.productName.localeCompare(b.productName)); break
    case 'sku': copy.sort((a, b) => a.sku.localeCompare(b.sku)); break
    case 'qty_asc': copy.sort((a, b) => a.onHand - b.onHand); break
    case 'qty_desc': copy.sort((a, b) => b.onHand - a.onHand); break
    case 'price': copy.sort((a, b) => a.price - b.price); break
    default: break
  }
  return copy
}

// ---------------------------------------------------------------------------
// GET /products/inventory
// ---------------------------------------------------------------------------

export async function getInventory(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}`
  const self = `${base}/products/inventory`

  const csrfToken = (req as any).csrfToken ?? ''
  const csrfField = csrfHiddenField(csrfToken)

  // Query params
  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const search = ((req.query.q as string) || '').trim()
  const stockFilter = ((req.query.stock as string) || 'all').toLowerCase()
  const categoryId = ((req.query.category as string) || '').trim()
  const sort = ((req.query.sort as string) || '').trim()
  const perPageRaw = parseInt(req.query.per_page as string)
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0
    ? Math.min(perPageRaw, MAX_PER_PAGE)
    : DEFAULT_PER_PAGE
  const flash = ((req.query.flash as string) || '').trim()
  const flashN = ((req.query.n as string) || '').trim()
  const errorMsg = ((req.query.error as string) || '').trim()

  let ctx
  try {
    ctx = createApiContext(req)
  } catch {
    res.redirect('/accounts/login')
    return
  }

  let allRows: VariantRow[] = []
  let categoryOptions: Array<{ value: string; label: string }> = []
  let apiError = ''

  try {
    const [productsResp, categoriesResp] = await Promise.all([
      listProducts(ctx, {
        keyword: search || undefined,
        categoryIds: categoryId || undefined,
        fields: 'id,name,slug,images,variants',
        page: 1,
        limit: 200,
        isCache: false,
      }),
      listCategories(ctx, { limit: 100 }),
    ])

    // BE GET /api/{shop_id} (Product list) trả thẳng { pagination, data: Product[] }.
    // Không có .data.products. Fallback giữ phòng shape thay đổi.
    const products = (
      Array.isArray((productsResp as any)?.data) ? (productsResp as any).data
      : Array.isArray((productsResp as any)?.data?.products) ? (productsResp as any).data.products
      : []
    ) as Product[]
    console.log('[Inventory] shop_id=%s products=%d', ctx.shopId, products.length)
    allRows = flattenToRows(products)
    categoryOptions = (categoriesResp?.data ?? []).map((c) => ({
      value: c.id ?? '',
      label: c.name ?? '',
    }))
  } catch (err) {
    if (err instanceof ProductApiError) {
      if (err.kind === 'auth') {
        res.redirect('/accounts/login')
        return
      }
      apiError = err.message
    } else {
      apiError = err instanceof Error ? err.message : 'Unknown error'
    }
  }

  // Pattern theo accounts/stores: trên API fail, render empty list (KHÔNG error
  // page) — UX nhất quán, user thấy "no data" với flash thay vì 500 / page broken.
  // apiError log đã ghi ở catch — chỉ surface qua flash banner.

  // Client-side stock filter (backend .NET doesn't support this)
  const filteredRows = applyStockFilter(applySort(allRows, sort), stockFilter)

  // Stats from all rows (after search/category filter, before stock filter)
  const totalVariants = allRows.length
  const inStockCount = allRows.filter((r) => r.onHand > LOW_STOCK_THRESHOLD).length
  const lowStockCount = allRows.filter((r) => r.onHand > 0 && r.onHand <= LOW_STOCK_THRESHOLD).length
  const outStockCount = allRows.filter((r) => r.onHand <= 0).length

  // Group filtered variants by product first → paginate by product (NOT variant).
  // User trải nghiệm: 10 products / page, mỗi card xổ ra full variants khi click.
  type ProductGroup = {
    productId: string
    productName: string
    productSlug: string
    imageUrl: string
    variants: VariantRow[]
  }
  const allGroups: ProductGroup[] = []
  const groupIndex = new Map<string, number>()
  for (const r of filteredRows) {
    const key = r.productId || r.productName
    let idx = groupIndex.get(key)
    if (idx === undefined) {
      idx = allGroups.length
      groupIndex.set(key, idx)
      allGroups.push({
        productId: r.productId,
        productName: r.productName,
        productSlug: r.productSlug,
        imageUrl: r.imageUrl,
        variants: [],
      })
    }
    allGroups[idx].variants.push(r)
  }

  const totalFiltered = filteredRows.length
  const totalGroups = allGroups.length
  const totalPages = Math.max(1, Math.ceil(totalGroups / perPage))
  const safePage = Math.min(page, totalPages)
  const groups = allGroups.slice((safePage - 1) * perPage, safePage * perPage)

  const paginationQuery: Record<string, string> = {}
  if (search) paginationQuery.q = search
  if (stockFilter !== 'all') paginationQuery.stock = stockFilter
  if (categoryId) paginationQuery.category = categoryId
  if (sort) paginationQuery.sort = sort
  if (perPage !== DEFAULT_PER_PAGE) paginationQuery.per_page = String(perPage)

  const flashHtml = flash === 'adjusted'
    ? `<div class="gx-flash gx-flash--success" role="alert">Inventory updated successfully.</div>`
    : flash === 'bulk-updated' && flashN
    ? `<div class="gx-flash gx-flash--success" role="alert">Bulk update applied to ${esc(flashN)} variant(s).</div>`
    : flash === 'partial'
    ? `<div class="gx-flash gx-flash--warning" role="alert">Some adjustments failed. Others succeeded.</div>`
    : flash === 'variant-created'
    ? `<div class="gx-flash gx-flash--success" role="alert">Variant created.</div>`
    : flash === 'variant-updated'
    ? `<div class="gx-flash gx-flash--success" role="alert">Variant updated.</div>`
    : flash === 'variant-deleted'
    ? `<div class="gx-flash gx-flash--success" role="alert">Variant deleted.</div>`
    : errorMsg
    ? `<div class="gx-flash gx-flash--danger" role="alert">${esc(errorMsg)}</div>`
    : apiError
    ? `<div class="gx-flash gx-flash--warning" role="alert">Không kết nối được Product API — hiển thị danh sách rỗng. (${esc(apiError)})</div>`
    : ''

  const statsHtml = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px">
    ${statCard({ label: 'Total Variants', value: totalVariants.toLocaleString() })}
    ${statCard({ label: 'In Stock', value: inStockCount.toLocaleString() })}
    ${statCard({ label: 'Low Stock (≤10)', value: lowStockCount.toLocaleString(), trend: lowStockCount > 0 ? 'down' : 'flat' })}
    ${statCard({ label: 'Out of Stock', value: outStockCount.toLocaleString(), trend: outStockCount > 0 ? 'down' : 'flat' })}
  </div>`

  const toolbarHtml = filterToolbar({
    searchPlaceholder: 'Search by name or SKU…',
    searchValue: search,
    formAction: self,
    filters: [
      {
        name: 'stock',
        label: 'Stock status',
        current: stockFilter !== 'all' ? stockFilter : '',
        options: [
          { value: 'in-stock', label: 'In stock' },
          { value: 'low', label: 'Low stock (≤10)' },
          { value: 'out', label: 'Out of stock' },
        ],
      },
      {
        name: 'category',
        label: 'Category',
        current: categoryId,
        options: categoryOptions,
      },
      {
        name: 'sort',
        label: 'Sort by',
        current: sort,
        options: [
          { value: 'name', label: 'Name A→Z' },
          { value: 'sku', label: 'SKU A→Z' },
          { value: 'qty_asc', label: 'Qty: low first' },
          { value: 'qty_desc', label: 'Qty: high first' },
          { value: 'price', label: 'Price' },
        ],
      },
    ],
  })

  const tableHtml = groups.length > 0
    ? `<div style="margin-bottom:14px;font-size:13px;color:var(--gx-muted);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <span>Page ${safePage}/${totalPages} — ${totalGroups} product${totalGroups !== 1 ? 's' : ''} match filter, ${totalFiltered} variant${totalFiltered !== 1 ? 's' : ''} total</span>
        <div style="display:inline-flex;align-items:center;gap:18px;flex-wrap:wrap">
          <form method="GET" action="${self}" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--gx-muted);margin:0">
            ${search ? `<input type="hidden" name="q" value="${esc(search)}" />` : ''}
            ${stockFilter !== 'all' ? `<input type="hidden" name="stock" value="${esc(stockFilter)}" />` : ''}
            ${categoryId ? `<input type="hidden" name="category" value="${esc(categoryId)}" />` : ''}
            ${sort ? `<input type="hidden" name="sort" value="${esc(sort)}" />` : ''}
            <label for="gx-per-page" style="cursor:pointer">Show</label>
            <input id="gx-per-page" type="number" name="per_page" min="1" max="${MAX_PER_PAGE}" value="${perPage}"
              aria-label="Products per page (1-${MAX_PER_PAGE})"
              style="width:64px;padding:5px 7px;border:1px solid var(--gx-border);border-radius:6px;background:var(--gx-card,#1a1d24);color:var(--gx-text);font-size:13px;font-variant-numeric:tabular-nums"
              onchange="this.form.submit()" />
            <span>per page</span>
          </form>
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="gx-select-all" aria-label="Select all variants on page" style="width:14px;height:14px;cursor:pointer" />
            <span>Select all</span>
          </label>
        </div>
       </div>
       <div style="display:flex;flex-direction:column;gap:14px">
       ${groups.map((g) => {
          const imgHtml = g.imageUrl
            ? `<img src="${esc(g.imageUrl)}" alt="" width="56" height="56" style="border-radius:8px;object-fit:cover;flex-shrink:0;border:1px solid var(--gx-border)" loading="lazy" />`
            : `<div style="width:56px;height:56px;border-radius:8px;background:linear-gradient(135deg,rgba(91,109,255,.08),rgba(91,109,255,.02));border:1px dashed rgba(91,109,255,.25);display:grid;place-items:center;flex-shrink:0;color:rgba(91,109,255,.6);font-size:22px">📦</div>`
          const productLink = g.productSlug
            ? `<a href="${base}/products/${esc(g.productSlug)}" style="color:var(--gx-text);text-decoration:none;font-weight:600;font-size:15px;line-height:1.3">${esc(g.productName)}</a>`
            : `<span style="font-weight:600;font-size:15px">${esc(g.productName)}</span>`
          const totalOnHand = g.variants.reduce((s, v) => s + v.onHand, 0)
          const outCount = g.variants.filter((v) => v.onHand <= 0).length
          const lowCount = g.variants.filter((v) => v.onHand > 0 && v.onHand <= LOW_STOCK_THRESHOLD).length
          const summaryPills = [
            `<span style="font-size:11.5px;padding:2px 9px;border-radius:10px;background:rgba(255,255,255,.06);color:var(--gx-muted)">${g.variants.length} variant${g.variants.length !== 1 ? 's' : ''}</span>`,
            `<span style="font-size:11.5px;padding:2px 9px;border-radius:10px;background:rgba(91,109,255,.12);color:#a3aeff;font-weight:500">Total: ${totalOnHand.toLocaleString()}</span>`,
            outCount > 0 ? `<span style="font-size:11.5px;padding:2px 9px;border-radius:10px;background:rgba(239,68,68,.12);color:#fca5a5;font-weight:500">${outCount} out</span>` : '',
            lowCount > 0 ? `<span style="font-size:11.5px;padding:2px 9px;border-radius:10px;background:rgba(234,179,8,.12);color:#facc15;font-weight:500">${lowCount} low</span>` : '',
          ].filter(Boolean).join('')

          // Button "+" tạo variant mới — góc phải header card. Dùng data-* để
          // pre-fill modal mode=create + product slug khi click.
          const addVariantBtn = g.productSlug
            ? `<button type="button" class="gx-add-variant-btn" data-mode="create" data-product-slug="${esc(g.productSlug)}" data-product-name="${esc(g.productName)}" aria-label="Add new variant" title="Add new variant"
                style="flex-shrink:0;width:36px;height:36px;border-radius:8px;border:1px solid rgba(91,109,255,.3);background:rgba(91,109,255,.08);color:#a3aeff;cursor:pointer;display:grid;place-items:center;font-size:18px;font-weight:600;line-height:1;transition:.15s"
                onmouseover="this.style.background='rgba(91,109,255,.18)';this.style.borderColor='#5b6dff'"
                onmouseout="this.style.background='rgba(91,109,255,.08)';this.style.borderColor='rgba(91,109,255,.3)'">+</button>`
            : ''

          return `<div class="gx-product-card gx-product-card--collapsed" data-product-id="${esc(g.productId)}" style="background:var(--gx-card,rgba(255,255,255,.02));border:1px solid var(--gx-border,rgba(255,255,255,.08));border-radius:12px;overflow:hidden">
            <div class="gx-product-card-header" role="button" tabindex="0" aria-expanded="false" aria-controls="gx-variants-${esc(g.productId)}" style="padding:14px 16px;display:flex;gap:14px;align-items:center;border-bottom:1px solid var(--gx-border);cursor:pointer;user-select:none">
              <span class="gx-chevron" aria-hidden="true" style="display:inline-block;font-size:11px;color:var(--gx-muted);transition:transform .15s ease;flex-shrink:0;width:14px;text-align:center">▶</span>
              ${imgHtml}
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${productLink}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${summaryPills}</div>
              </div>
              ${addVariantBtn}
            </div>
            <div class="gx-product-card-variants" id="gx-variants-${esc(g.productId)}" style="overflow-x:auto;padding-left:48px">
              <table style="width:100%;border-collapse:collapse;font-size:13.5px">
                <thead>
                  <tr style="background:rgba(255,255,255,.015);font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--gx-muted)">
                    <th style="width:32px;padding:8px 12px"></th>
                    <th style="padding:8px 12px;text-align:left;font-weight:600">Variant</th>
                    <th style="padding:8px 12px;text-align:left;font-weight:600">SKU</th>
                    <th style="padding:8px 12px;text-align:right;font-weight:600">Price</th>
                    <th style="padding:8px 12px;text-align:right;font-weight:600">Stock</th>
                    <th style="padding:8px 12px;font-weight:600">Status</th>
                    <th style="padding:8px 12px;text-align:right;font-weight:600;width:140px">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${g.variants.map((row) => {
                    const variantSlug = esc((row as any).variantSlug || '')
                    return `<tr style="border-top:1px solid var(--gx-border)">
                    <td style="padding:10px 12px">
                      <input class="gx-row-cb" type="checkbox" value="${esc(row.sku)}" aria-label="Select ${esc(row.sku)}" style="width:15px;height:15px;cursor:pointer" />
                    </td>
                    <td style="padding:10px 12px;color:var(--gx-text)">${esc(row.variantTitle)}</td>
                    <td style="padding:10px 12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--gx-muted)">${row.sku ? esc(row.sku) : '<span style="opacity:.4">—</span>'}</td>
                    <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums">${row.price > 0 ? `$${row.price.toFixed(2)}` : '<span style="opacity:.4">—</span>'}</td>
                    <td style="padding:10px 12px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums${row.onHand <= 0 ? ';color:#fca5a5' : row.onHand <= LOW_STOCK_THRESHOLD ? ';color:#facc15' : ''}">${row.onHand}</td>
                    <td style="padding:10px 12px">${stockBadgeHtml(row.onHand)}</td>
                    <td style="padding:10px 12px;text-align:center;white-space:nowrap">
                      <div style="display:inline-flex;align-items:center;gap:6px">
                        <button type="button" class="gx-edit-variant-btn"
                          data-mode="update" data-product-slug="${esc(g.productSlug)}" data-product-name="${esc(g.productName)}"
                          data-variant-slug="${variantSlug}" data-variant-name="${esc(row.variantTitle)}" data-variant-sku="${esc(row.sku)}"
                          data-variant-price="${row.price}" data-variant-inventory="${row.onHand}"
                          aria-label="Edit variant ${esc(row.variantTitle)}" title="Edit"
                          style="padding:5px 11px;font-size:12px;border-radius:6px;border:1px solid var(--gx-border);background:transparent;color:var(--gx-muted);cursor:pointer;min-height:28px"
                          onmouseover="this.style.color='var(--gx-text,#fff)';this.style.background='rgba(255,255,255,.06)'"
                          onmouseout="this.style.color='var(--gx-muted)';this.style.background='transparent'">Edit</button>
                        <form method="POST" action="${self}/variants/delete" style="display:inline" onsubmit="return confirm('Delete variant &quot;${esc(row.variantTitle).replace(/"/g, '&quot;')}&quot;?')">
                          ${csrfField}
                          <input type="hidden" name="product_slug" value="${esc(g.productSlug)}" />
                          <input type="hidden" name="variant_slug" value="${variantSlug}" />
                          <input type="hidden" name="variant_sku" value="${esc(row.sku)}" />
                          <button type="submit" aria-label="Delete variant ${esc(row.variantTitle)}" title="Delete"
                            style="padding:5px 11px;font-size:12px;border-radius:6px;border:1px solid rgba(239,68,68,.25);background:transparent;color:#fca5a5;cursor:pointer;min-height:28px"
                            onmouseover="this.style.background='rgba(239,68,68,.12)';this.style.borderColor='#ef4444'"
                            onmouseout="this.style.background='transparent';this.style.borderColor='rgba(239,68,68,.25)'">Delete</button>
                        </form>
                      </div>
                    </td>
                  </tr>`}).join('')}
                </tbody>
              </table>
            </div>
          </div>`
        }).join('')}
       </div>
       ${pagination({ page: safePage, totalPages, baseUrl: self, query: paginationQuery })}`
    : emptyState({
        title: search || stockFilter !== 'all' || categoryId
          ? 'No variants match your filters'
          : 'No products found',
        description: search || stockFilter !== 'all' || categoryId
          ? 'Try adjusting your search or filters.'
          : 'Add products to start managing inventory.',
        ctaHref: search || stockFilter !== 'all' || categoryId ? self : `${base}/products/new`,
        ctaLabel: search || stockFilter !== 'all' || categoryId ? 'Clear filters' : 'Add product',
        icon: '📦',
      })

  // Bulk-set quantity input shown above bar when selection active
  const bulkSetInputHtml = `<div id="gx-bulk-qty-wrap" style="display:none;position:fixed;bottom:72px;left:50%;transform:translateX(-50%);z-index:200;background:var(--gx-card);border:1px solid var(--gx-border);border-radius:8px;padding:12px 16px;box-shadow:0 4px 20px rgba(0,0,0,.4)">
    <label for="gx-bulk-qty" style="font-size:13px;display:block;margin-bottom:6px">Set all selected to quantity:</label>
    <input id="gx-bulk-qty" name="qty" type="number" min="0" max="999999" placeholder="e.g. 100"
      form="gx-bulk-form"
      style="width:120px;padding:6px 8px;border:1px solid var(--gx-border);border-radius:4px;background:var(--gx-card);color:var(--gx-text);font-size:14px;min-height:44px"
      aria-label="Bulk set quantity"
    />
  </div>
  <script>(function(){
    var bar = document.getElementById('gx-bulk-bar');
    var wrap = document.getElementById('gx-bulk-qty-wrap');
    if (!bar || !wrap) return;
    var obs = new MutationObserver(function(){
      wrap.style.display = bar.classList.contains('gx-bulk-bar--visible') ? 'block' : 'none';
    });
    obs.observe(bar, { attributes: true, attributeFilter: ['class'] });
  })();</script>`

  // Modal create/update variant — 1 dialog dùng cho cả 2 mode (mode=create|update)
  // BE pattern: GET product full → modify variants[] → PUT. Identifier dùng
  // variant slug (BE auto-gen từ name nếu null — Product.cs:336).
  const variantDialogHtml = `<dialog id="gx-variant-dlg" style="border:1px solid var(--gx-border);border-radius:12px;padding:0;background:var(--gx-card,#1a1d24);color:var(--gx-text);max-width:480px;width:92vw">
    <form method="POST" id="gx-variant-form" style="padding:20px 22px">
      ${csrfField}
      <input type="hidden" name="mode" value="create" />
      <input type="hidden" name="product_slug" value="" />
      <input type="hidden" name="orig_variant_slug" value="" />
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h2 id="gx-variant-dlg-title" style="margin:0;font-size:17px;font-weight:600">Add variant</h2>
        <button type="button" onclick="document.getElementById('gx-variant-dlg').close()" aria-label="Close" style="border:0;background:transparent;color:var(--gx-muted);font-size:22px;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px">×</button>
      </div>
      <p id="gx-variant-dlg-product" style="margin:0 0 16px;font-size:12.5px;color:var(--gx-muted)"></p>

      <label style="display:block;margin-bottom:12px">
        <span style="display:block;font-size:12.5px;font-weight:500;margin-bottom:5px;color:var(--gx-muted)">Variant name *</span>
        <input name="name" required maxlength="120" placeholder="e.g. Red / S"
          style="width:100%;padding:8px 10px;border:1px solid var(--gx-border);border-radius:7px;background:var(--gx-bg,#13161c);color:var(--gx-text);font-size:14px;box-sizing:border-box" />
      </label>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <label>
          <span style="display:block;font-size:12.5px;font-weight:500;margin-bottom:5px;color:var(--gx-muted)">SKU</span>
          <input name="sku" maxlength="64" placeholder="ABC123"
            style="width:100%;padding:8px 10px;border:1px solid var(--gx-border);border-radius:7px;background:var(--gx-bg,#13161c);color:var(--gx-text);font-size:13px;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace" />
        </label>
        <label>
          <span style="display:block;font-size:12.5px;font-weight:500;margin-bottom:5px;color:var(--gx-muted)">Price ($)</span>
          <input name="price" type="number" step="0.01" min="0" placeholder="0.00"
            style="width:100%;padding:8px 10px;border:1px solid var(--gx-border);border-radius:7px;background:var(--gx-bg,#13161c);color:var(--gx-text);font-size:14px;box-sizing:border-box" />
        </label>
      </div>

      <label style="display:block;margin-bottom:18px">
        <span style="display:block;font-size:12.5px;font-weight:500;margin-bottom:5px;color:var(--gx-muted)">Stock</span>
        <input name="inventory" type="number" step="1" min="0" placeholder="0"
          style="width:100%;padding:8px 10px;border:1px solid var(--gx-border);border-radius:7px;background:var(--gx-bg,#13161c);color:var(--gx-text);font-size:14px;box-sizing:border-box" />
      </label>

      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button type="button" onclick="document.getElementById('gx-variant-dlg').close()" style="padding:8px 14px;border:1px solid var(--gx-border);border-radius:7px;background:transparent;color:var(--gx-muted);cursor:pointer;font-size:13px">Cancel</button>
        <button type="submit" style="padding:8px 16px;border:0;border-radius:7px;background:linear-gradient(180deg,#5b6dff,#4854e0);color:#fff;cursor:pointer;font-size:13px;font-weight:500">Save</button>
      </div>
    </form>
  </dialog>
  <script>(function(){
    var dlg = document.getElementById('gx-variant-dlg')
    var form = document.getElementById('gx-variant-form')
    if (!dlg || !form) return
    function fill(btn) {
      var mode = btn.getAttribute('data-mode')
      form.mode.value = mode
      form.product_slug.value = btn.getAttribute('data-product-slug') || ''
      form.orig_variant_slug.value = btn.getAttribute('data-variant-slug') || ''
      form.name.value = btn.getAttribute('data-variant-name') || ''
      form.sku.value = btn.getAttribute('data-variant-sku') || ''
      form.price.value = btn.getAttribute('data-variant-price') || ''
      form.inventory.value = btn.getAttribute('data-variant-inventory') || ''
      var title = document.getElementById('gx-variant-dlg-title')
      var sub = document.getElementById('gx-variant-dlg-product')
      title.textContent = mode === 'create' ? 'Add variant' : 'Edit variant'
      var pname = btn.getAttribute('data-product-name') || ''
      sub.textContent = pname ? 'Product: ' + pname : ''
      form.action = '${self}/variants/' + (mode === 'create' ? 'create' : 'update')
    }
    document.querySelectorAll('.gx-add-variant-btn,.gx-edit-variant-btn').forEach(function(b){
      b.addEventListener('click', function(){ fill(b); dlg.showModal() })
    })
  })();</script>`

  const content = `
    ${injectAdminStyles()}
    <style>
      .gx-flash { padding:10px 16px; border-radius:6px; margin-bottom:16px; font-size:14px; }
      .gx-flash--success { background:rgba(34,197,94,.12); color:var(--gx-color-success); border:1px solid var(--gx-color-success); }
      .gx-flash--warning { background:rgba(245,158,11,.12); color:var(--gx-color-warning); border:1px solid var(--gx-color-warning); }
      .gx-flash--danger  { background:rgba(239,68,68,.12);  color:var(--gx-color-danger);  border:1px solid var(--gx-color-danger); }
      tr:hover td { background:rgba(255,255,255,.02); }
      .gx-product-card-header:hover { background: rgba(255,255,255,.02); }
      .gx-product-card-header:focus-visible { outline: 2px solid var(--gx-color-primary, #5b6dff); outline-offset: -2px; }
      .gx-product-card--collapsed > .gx-product-card-header { border-bottom: 0; }
      .gx-product-card--collapsed > .gx-product-card-variants { display: none; }
      .gx-product-card:not(.gx-product-card--collapsed) > .gx-product-card-header > .gx-chevron { transform: rotate(90deg); }
      @media (max-width: 640px) {
        .gx-product-card-variants { padding-left: 24px !important; }
      }
    </style>

    <div class="page-header" style="margin-bottom:24px">
      <div>
        <h1 class="page-title">Inventory</h1>
        <p class="page-subtitle">${totalVariants} variant${totalVariants !== 1 ? 's' : ''} in your store</p>
      </div>
      <a href="${base}/reports/inventory" class="btn btn-outline btn-sm">Inventory Analytics</a>
    </div>

    ${flashHtml}
    ${statsHtml}

    <div style="margin-bottom:16px">${toolbarHtml}</div>

    <div class="card" style="margin-bottom:80px">
      <div class="card-body" style="padding:16px">
        ${tableHtml}
      </div>
    </div>

    ${bulkActionBar({
      formAction: `${self}/bulk-set`,
      csrfToken: csrfToken,
      actions: [{ value: 'bulk-set', label: 'Set quantity to…' }],
    })}
    ${bulkSetInputHtml}
    ${variantDialogHtml}
    <script>(function(){
      function toggleCard(header){
        var card = header.closest('.gx-product-card')
        if (!card) return
        var collapsed = card.classList.toggle('gx-product-card--collapsed')
        header.setAttribute('aria-expanded', String(!collapsed))
      }
      function isInteractiveTarget(t){
        return !!(t && t.closest && t.closest('a, button, input, label, form'))
      }
      document.addEventListener('click', function(e){
        var header = e.target.closest && e.target.closest('.gx-product-card-header')
        if (!header) return
        if (isInteractiveTarget(e.target)) return
        toggleCard(header)
      })
      document.addEventListener('keydown', function(e){
        if (e.key !== 'Enter' && e.key !== ' ') return
        var header = e.target.closest && e.target.closest('.gx-product-card-header')
        if (!header || e.target !== header) return
        e.preventDefault()
        toggleCard(header)
      })
    })();</script>
  `

  res.send(
    sellerLayout({
      title: 'Inventory',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'inventory',
      content,
      theme: theme as 'dark' | 'light',
    }),
  )
}

// ---------------------------------------------------------------------------
// POST /products/inventory/adjust — per-row adjust (+/-/=)
// ---------------------------------------------------------------------------

export async function postAdjustInventory(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const base = `/admin/store/${store.slug}`
  const self = `${base}/products/inventory`

  const sku = ((req.body.sku as string) || '').trim()
  const adjustInput = ((req.body.adjust as string) || '').trim()
  const currentRaw = parseInt(req.body.current as string)

  if (!sku || !adjustInput) {
    res.redirect(self)
    return
  }

  let ctx
  try {
    ctx = createApiContext(req)
  } catch {
    res.redirect('/accounts/login')
    return
  }

  // Parse adjust expression; trust hidden `current` field for +/- (last-write-wins per spec)
  let targetQty: number
  try {
    const current = Number.isFinite(currentRaw) ? currentRaw : undefined
    const parsed = parseAdjust(adjustInput, current)
    targetQty = parsed.targetQty
  } catch (parseErr) {
    // If +/- and no current in form, fetch from API then re-parse
    if (!adjustInput.startsWith('=') && !Number.isFinite(currentRaw)) {
      try {
        // getProduct by SKU — use productSku filter
        const resp = await listProducts(ctx, { productSku: sku, limit: 1, isCache: false })
        const products = (resp?.data?.products ?? []) as Product[]
        const variant = products.flatMap((p) => p.variants ?? []).find((v) => v.sku === sku)
        const fetchedCurrent = Number(variant?.inventory ?? 0)
        const parsed = parseAdjust(adjustInput, fetchedCurrent)
        targetQty = parsed.targetQty
      } catch (fetchErr) {
        if (fetchErr instanceof ProductApiError && fetchErr.kind === 'auth') {
          res.redirect('/accounts/login')
          return
        }
        const msg = fetchErr instanceof Error ? fetchErr.message : 'Failed to fetch current inventory'
        res.redirect(`${self}?error=${encodeURIComponent(msg)}`)
        return
      }
    } else {
      const msg = parseErr instanceof Error ? parseErr.message : 'Invalid adjust input'
      res.redirect(`${self}?error=${encodeURIComponent(msg)}`)
      return
    }
  }

  try {
    await bulkUpdateInventory(ctx, { [sku]: targetQty })
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') {
      res.redirect('/accounts/login')
      return
    }
    const msg = err instanceof Error ? err.message : 'Inventory update failed'
    res.redirect(`${self}?error=${encodeURIComponent(msg)}`)
    return
  }

  // Audit log (non-critical)
  logSellerAction(req, 'inventory.adjust', 'sku', sku, {
    sku,
    targetQty,
    adjustInput,
    by: user?.id,
  }).catch(() => {/* ignore */})

  res.redirect(`${self}?flash=adjusted`)
}

// ---------------------------------------------------------------------------
// POST /products/inventory/bulk-set — bulk absolute set (=N only)
// ---------------------------------------------------------------------------

export async function postBulkSetInventory(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}`
  const self = `${base}/products/inventory`

  // ids[] injected by bulk-action-bar script; qty is from the inline input
  const rawIds = req.body['ids[]']
  const skus: string[] = Array.isArray(rawIds)
    ? rawIds.map((s: string) => s.trim()).filter(Boolean)
    : typeof rawIds === 'string' && rawIds.trim()
    ? [rawIds.trim()]
    : []

  const qtyRaw = parseInt(req.body.qty as string)

  if (skus.length === 0 || !Number.isFinite(qtyRaw) || qtyRaw < 0 || qtyRaw > 999_999) {
    res.redirect(`${self}?error=${encodeURIComponent('Invalid bulk-set input')}`)
    return
  }

  let ctx
  try {
    ctx = createApiContext(req)
  } catch {
    res.redirect('/accounts/login')
    return
  }

  const skuMap: Record<string, number> = {}
  for (const sku of skus) skuMap[sku] = qtyRaw

  try {
    await bulkUpdateInventory(ctx, skuMap)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') {
      res.redirect('/accounts/login')
      return
    }
    const msg = err instanceof Error ? err.message : 'Bulk update failed'
    res.redirect(`${self}?error=${encodeURIComponent(msg)}`)
    return
  }

  res.redirect(`${self}?flash=bulk-updated&n=${skus.length}`)
}

// ---------------------------------------------------------------------------
// Variant CRUD — pattern BE: GET product full → modify variants[] → PUT.
// BE không có endpoint riêng cho variant; mọi thay đổi qua PUT product
// (ProductController.PutAsync — Models/Lencam/Product.cs nested variants).
// ---------------------------------------------------------------------------

async function loadProductForVariantEdit(
  req: Request,
  res: Response,
  productSlug: string,
  self: string,
): Promise<{ ctx: ReturnType<typeof createApiContext>; product: Product } | null> {
  let ctx
  try {
    ctx = createApiContext(req)
  } catch {
    res.redirect('/accounts/login')
    return null
  }
  if (!productSlug) {
    res.redirect(`${self}?error=${encodeURIComponent('Missing product_slug')}`)
    return null
  }
  try {
    const product = await getProduct(ctx, productSlug)
    if (!product || !product.id) {
      res.redirect(`${self}?error=${encodeURIComponent('Product not found')}`)
      return null
    }
    return { ctx, product }
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') {
      res.redirect('/accounts/login')
      return null
    }
    const msg = err instanceof Error ? err.message : 'Failed to load product'
    res.redirect(`${self}?error=${encodeURIComponent(msg)}`)
    return null
  }
}

function buildVariantFromForm(body: any): {
  name: string
  slug: string
  sku: string
  price: number
  inventory: number
} | null {
  const name = ((body.name as string) || '').trim()
  if (!name) return null
  return {
    name,
    slug: slugifyVariantName(name),
    sku: ((body.sku as string) || '').trim(),
    price: Math.max(0, Number(body.price) || 0),
    inventory: Math.max(0, Math.floor(Number(body.inventory) || 0)),
  }
}

async function saveProduct(
  req: Request,
  res: Response,
  ctx: ReturnType<typeof createApiContext>,
  product: Product,
  self: string,
  successFlash: string,
): Promise<void> {
  try {
    await updateProduct(ctx, product.id ?? '', product)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') {
      res.redirect('/accounts/login')
      return
    }
    const msg = err instanceof Error ? err.message : 'Update failed'
    res.redirect(`${self}?error=${encodeURIComponent(msg)}`)
    return
  }
  res.redirect(`${self}?flash=${successFlash}`)
}

export async function postCreateVariant(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const self = `/admin/store/${store.slug}/products/inventory`
  const productSlug = ((req.body.product_slug as string) || '').trim()
  const variantData = buildVariantFromForm(req.body)
  if (!variantData) {
    res.redirect(`${self}?error=${encodeURIComponent('Variant name is required')}`)
    return
  }
  const loaded = await loadProductForVariantEdit(req, res, productSlug, self)
  if (!loaded) return
  const { ctx, product } = loaded
  const existing = product.variants ?? []
  if (existing.some((v) => (v.slug ?? slugifyVariantName(v.name ?? '')) === variantData.slug)) {
    res.redirect(`${self}?error=${encodeURIComponent('Variant name conflict (slug already exists)')}`)
    return
  }
  product.variants = [...existing, variantData as any]
  await saveProduct(req, res, ctx, product, self, 'variant-created')
}

export async function postUpdateVariant(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const self = `/admin/store/${store.slug}/products/inventory`
  const productSlug = ((req.body.product_slug as string) || '').trim()
  const origSlug = ((req.body.orig_variant_slug as string) || '').trim()
  const variantData = buildVariantFromForm(req.body)
  if (!variantData || !origSlug) {
    res.redirect(`${self}?error=${encodeURIComponent('Missing variant info')}`)
    return
  }
  const loaded = await loadProductForVariantEdit(req, res, productSlug, self)
  if (!loaded) return
  const { ctx, product } = loaded
  const variants = product.variants ?? []
  const idx = variants.findIndex((v) => (v.slug ?? slugifyVariantName(v.name ?? '')) === origSlug)
  if (idx < 0) {
    res.redirect(`${self}?error=${encodeURIComponent('Variant not found')}`)
    return
  }
  variants[idx] = { ...variants[idx], ...variantData } as any
  product.variants = variants
  await saveProduct(req, res, ctx, product, self, 'variant-updated')
}

export async function postDeleteVariant(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const self = `/admin/store/${store.slug}/products/inventory`
  const productSlug = ((req.body.product_slug as string) || '').trim()
  const variantSlug = ((req.body.variant_slug as string) || '').trim()
  if (!productSlug || !variantSlug) {
    res.redirect(`${self}?error=${encodeURIComponent('Missing required fields')}`)
    return
  }
  const loaded = await loadProductForVariantEdit(req, res, productSlug, self)
  if (!loaded) return
  const { ctx, product } = loaded
  const before = product.variants ?? []
  const after = before.filter((v) => (v.slug ?? slugifyVariantName(v.name ?? '')) !== variantSlug)
  if (after.length === before.length) {
    res.redirect(`${self}?error=${encodeURIComponent('Variant not found')}`)
    return
  }
  product.variants = after
  await saveProduct(req, res, ctx, product, self, 'variant-deleted')
}
