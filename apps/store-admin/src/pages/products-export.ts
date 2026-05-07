/**
 * Store Admin — Product Export
 *
 * GET  /admin/store/:slug/products/export           — Export settings UI
 * POST /admin/store/:slug/products/export/download  — Generate + stream file
 *
 * Ships Shopify-compatible CSV (and raw JSON for developers). Rides on the
 * shared `generateProductsExport` pipeline in
 * `packages/core/src/modules/products/export/service.ts`, so the REST API
 * and the dashboard agree byte-for-byte on the output.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import {
  generateProductsExport,
  type FetchExportProductsParams,
  type ProductExportScope,
} from '@gbox/core/modules/products/export/service.js'
import { notify } from '../lib/notify.js'
import { createApiContext, listProducts } from '../lib/product-api-client.js'
import { ProductApiError } from '../lib/product-api-errors.js'

// ---------------------------------------------------------------------------
// GET /admin/store/:slug/products/export — Export UI
// ---------------------------------------------------------------------------

export async function getProductExport(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`
  const theme = (req as any).theme || 'dark'
  const csrfToken = (req as any).csrfToken || ''
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  // Total counts for the scope-picker labels. API mode: 1 listProducts call
  // (limit=1, đọc pagination.count). DB mode: aggregate query per scope.
  let total = 0, active = 0, draft = 0, archived = 0
  if (hasDb) {
    [total, active, draft, archived] = await Promise.all([
      countByStatus(db, store.id, null),
      countByStatus(db, store.id, 'active'),
      countByStatus(db, store.id, 'draft'),
      countByStatus(db, store.id, 'archived'),
    ])
  } else {
    try {
      const ctx = createApiContext(req)
      const [allResp, activeResp, draftResp] = await Promise.all([
        listProducts(ctx, { page: 1, limit: 1, fields: 'id', isCache: false }),
        listProducts(ctx, { page: 1, limit: 1, fields: 'id', isCache: false, published: true }),
        listProducts(ctx, { page: 1, limit: 1, fields: 'id', isCache: false, published: false }),
      ])
      total = Number(allResp?.pagination?.count ?? 0)
      active = Number(activeResp?.pagination?.count ?? 0)
      draft = Number(draftResp?.pagination?.count ?? 0)
      archived = 0  // BE Product schema không có archived flag riêng
    } catch (err) {
      console.warn('[products/export] count fetch failed:', err instanceof Error ? err.message : err)
    }
  }

  const errorParam = typeof req.query.error === 'string' ? req.query.error : ''

  const content = `
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
      <div>
        <h1 class="page-title" style="margin:0;font-size:22px;font-weight:700">Export products</h1>
        <p class="page-subtitle" style="margin:4px 0 0;color:var(--s-text-secondary);font-size:13px">Download products, variants, images, and custom data as CSV or JSON</p>
      </div>
      <a href="${base}/products" class="btn btn-outline" style="font-size:13px">&larr; Back to products</a>
    </div>

    ${errorParam ? `<div class="card" style="background:#fff4f4;border:1px solid #f8d5d5;color:#a61b1b;padding:12px 16px;margin-bottom:16px;font-size:13px">
      ${esc(decodeErrorMessage(errorParam))}
    </div>` : ''}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px">
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-accent)">${total}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Total products</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-success)">${active}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Active</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-warning)">${draft}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Draft</div>
      </div>
      <div class="card" style="padding:16px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:var(--s-text-muted)">${archived}</div>
        <div style="font-size:11px;color:var(--s-text-muted);margin-top:4px">Archived</div>
      </div>
    </div>

    <form method="post" action="${base}/products/export/download" id="pxForm">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}" />

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <!-- LEFT: scope + format -->
        <div>
          <div class="card">
            <div class="card-header"><span>What to export</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
                <input type="radio" name="scope" value="all" checked style="margin-top:2px;accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:600">All products</div>
                  <div style="color:var(--s-text-muted);font-size:12px">${total} products (active, draft, archived)</div>
                </div>
              </label>
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
                <input type="radio" name="scope" value="active" style="margin-top:2px;accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:600">Active only</div>
                  <div style="color:var(--s-text-muted);font-size:12px">${active} products published to the storefront</div>
                </div>
              </label>
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
                <input type="radio" name="scope" value="draft" style="margin-top:2px;accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:600">Drafts only</div>
                  <div style="color:var(--s-text-muted);font-size:12px">${draft} unpublished products</div>
                </div>
              </label>
              <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
                <input type="radio" name="scope" value="archived" style="margin-top:2px;accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:600">Archived only</div>
                  <div style="color:var(--s-text-muted);font-size:12px">${archived} archived products</div>
                </div>
              </label>
            </div>
          </div>

          <div class="card" style="margin-top:20px">
            <div class="card-header"><span>Filters (optional)</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
              <div>
                <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Vendor contains</label>
                <input type="text" name="vendor" class="form-input" placeholder="e.g. Acme" style="width:100%" />
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Product type equals</label>
                <input type="text" name="product_type" class="form-input" placeholder="e.g. Apparel" style="width:100%" />
              </div>
            </div>
          </div>

          <div class="card" style="margin-top:20px">
            <div class="card-header"><span>Format</span></div>
            <div class="card-body" style="display:flex;gap:16px">
              <label style="flex:1;display:flex;align-items:center;gap:10px;cursor:pointer;padding:12px;border:2px solid var(--s-accent);border-radius:8px" id="pxFmtCsv">
                <input type="radio" name="format" value="csv" checked style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-size:14px;font-weight:600">CSV</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Shopify-compatible, Excel-ready</div>
                </div>
              </label>
              <label style="flex:1;display:flex;align-items:center;gap:10px;cursor:pointer;padding:12px;border:2px solid var(--s-border);border-radius:8px" id="pxFmtJson">
                <input type="radio" name="format" value="json" style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-size:14px;font-weight:600">JSON</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Developer-friendly, full structure</div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <!-- RIGHT: include options + button -->
        <div>
          <div class="card">
            <div class="card-header"><span>Include in export</span></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="include_metafields" value="1" checked style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:500">Custom data (metafields)</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Product + variant metafields as Shopify-tagged columns</div>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="include_seo" value="1" checked style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:500">SEO title + description</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Custom &lt;title&gt; and meta description overrides</div>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="include_cost" value="1" checked style="accent-color:var(--s-accent)" />
                <div>
                  <div style="font-weight:500">Cost per item</div>
                  <div style="font-size:11px;color:var(--s-text-muted)">Internal cost — keep unchecked if sharing externally</div>
                </div>
              </label>
            </div>
          </div>

          <div class="card" style="margin-top:20px;padding:20px;text-align:center">
            <button type="submit" class="btn btn-primary" style="font-size:15px;padding:12px 32px;width:100%">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle;margin-right:8px"><path d="M10 3v10M6 9l4 4 4-4"/><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2"/></svg>
              Export products
            </button>
            <p style="font-size:11px;color:var(--s-text-muted);margin-top:8px">
              File will download immediately. Large exports (10k+) are capped — use the API for bigger jobs.
            </p>
          </div>
        </div>
      </div>
    </form>

    <script>
    // Highlight selected format
    document.querySelectorAll('input[name="format"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        document.getElementById('pxFmtCsv').style.borderColor = 'var(--s-border)';
        document.getElementById('pxFmtJson').style.borderColor = 'var(--s-border)';
        this.closest('label').style.borderColor = 'var(--s-accent)';
      });
    });
    </script>
  `

  res.send(sellerLayout({
    title: 'Export products',
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
// POST /admin/store/:slug/products/export/download — Generate + stream file
// ---------------------------------------------------------------------------

export async function postProductExportDownload(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser
  const body = (req.body || {}) as Record<string, string | string[] | undefined>
  const base = `/admin/store/${store.slug}`
  const hasDb = !!db && typeof (db as any).selectFrom === 'function'

  const format: 'csv' | 'json' = body.format === 'json' ? 'json' : 'csv'
  const scope = normalizeScope(body.scope)
  const includeMetafields = body.include_metafields === '1'
  const includeSeo = body.include_seo === '1'
  const includeCost = body.include_cost === '1'

  // API MODE — fetch toàn bộ products từ BE → render pipe-separated. Mỗi
  // field cách nhau '|'. Images join bằng ',' (URL list, BE không repeat).
  // 1 row / product. Variants/options/categories serialize JSON để giữ shape.
  if (!hasDb) {
    let ctx
    try { ctx = createApiContext(req) } catch {
      res.redirect(`${base}/products/export?error=auth_required`); return
    }
    try {
      const all = await fetchAllProductsForExport(ctx, scope)
      if (all.length === 0) { res.redirect(`${base}/products/export?error=no_products`); return }
      const psv = renderProductsAsPipeSeparated(all)
      const ts = new Date().toISOString().slice(0, 10)
      const filename = `products-${store.slug}-${ts}.psv`
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(psv)
    } catch (err) {
      if (err instanceof ProductApiError && err.kind === 'auth') {
        res.redirect('/accounts/login'); return
      }
      const msg = err instanceof Error ? err.message : 'export_failed'
      console.error('[products/export] API export failed:', msg)
      res.redirect(`${base}/products/export?error=${encodeURIComponent(msg)}`)
    }
    return
  }

  // DB MODE — legacy path (Phase 14 demo / dev-only)
  const params: FetchExportProductsParams & {
    format: 'csv' | 'json'
    storeSlug?: string
    options?: { includeSeo?: boolean; includeCost?: boolean; includeProductMetafields?: boolean; includeVariantMetafields?: boolean }
  } = {
    scope,
    vendor: typeof body.vendor === 'string' && body.vendor ? body.vendor : undefined,
    product_type:
      typeof body.product_type === 'string' && body.product_type ? body.product_type : undefined,
    includeMetafields,
    format,
    storeSlug: store.slug,
    options: {
      includeSeo,
      includeCost,
      includeProductMetafields: includeMetafields,
      includeVariantMetafields: includeMetafields,
    },
  }

  try {
    const result = await generateProductsExport(db, store.id, params)

    if (result.productCount === 0) {
      res.redirect(`${base}/products/export?error=no_products`)
      return
    }

    // Fire-and-forget activity-feed entry. Wrapped in a catch so a
    // notifications failure never blocks the actual file download.
    const scopeLabel =
      scope === 'all' ? 'all products' :
      scope === 'active' ? 'active products' :
      scope === 'draft' ? 'drafts' :
      scope === 'archived' ? 'archived' :
      scope === 'selected' ? 'selected products' :
      String(scope)

    try {
      await notify(db, {
        shopId: store.id,
        userId: user?.id ?? null,
        type: 'products_exported',
        title: `Exported ${result.productCount} product${result.productCount === 1 ? '' : 's'} (${format.toUpperCase()})`,
        message: `Scope: ${scopeLabel}${user ? ` • By ${user.name || user.email}` : ''}`,
        resourceType: 'product_export',
        resourceId: null,
      })
    } catch {
      // Intentional — notifications are best-effort.
    }

    res.setHeader('Content-Type', result.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
    res.send(result.data)
  } catch (err: any) {
    console.error('[Product Export Error]', err)
    res.redirect(`${base}/products/export?error=${encodeURIComponent(err.message ?? 'export_failed')}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SCOPES: ProductExportScope[] = ['all', 'active', 'draft', 'archived', 'collection', 'selected']

function normalizeScope(raw: unknown): ProductExportScope {
  if (typeof raw === 'string' && (VALID_SCOPES as string[]).includes(raw)) {
    return raw as ProductExportScope
  }
  return 'all'
}

async function countByStatus(
  db: Kysely<Database>,
  shopId: string,
  status: 'active' | 'draft' | 'archived' | null,
): Promise<number> {
  let q = db
    .selectFrom('products')
    .select(({ fn }) => fn.count<number>('id').as('c'))
    .where('shop_id', '=', shopId)
  if (status) q = q.where('status', '=', status)
  const row = await q.executeTakeFirst().catch(() => null)
  return row ? Number((row as any).c) || 0 : 0
}

function decodeErrorMessage(raw: string): string {
  const decoded = safeDecode(raw)
  if (decoded === 'no_products') return 'No products matched your filters. Try a different scope.'
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

// ---------------------------------------------------------------------------
// API mode helpers — fetch all products + render pipe-separated
// ---------------------------------------------------------------------------

/**
 * Paginate listProducts để lấy toàn bộ products. BE limit=100/page, scope
 * lọc qua `published` flag (BE không có archived flag riêng — bỏ qua scope đó).
 */
async function fetchAllProductsForExport(
  ctx: ReturnType<typeof createApiContext>,
  scope: ProductExportScope,
): Promise<any[]> {
  const all: any[] = []
  // Fields đầy đủ — BE projection nếu thiếu sẽ trả null fields → export rỗng.
  const FIELDS = 'id,shop_id,name,slug,vendor,tags,body_html,images,variant_default,variants,options,categories,seo_title,seo_description,published,create_date,update_date'
  const PAGE_LIMIT = 100
  let publishedFilter: boolean | undefined = undefined
  if (scope === 'active') publishedFilter = true
  else if (scope === 'draft') publishedFilter = false

  for (let page = 1; page <= 200; page++) {
    const r = await listProducts(ctx, {
      page, limit: PAGE_LIMIT, fields: FIELDS, isCache: false,
      ...(publishedFilter !== undefined ? { published: publishedFilter } : {}),
    })
    const data = r?.data ?? []
    if (!Array.isArray(data) || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE_LIMIT) break
  }
  return all
}

/**
 * Pipe-separated value (PSV) format. Header row + 1 row per product.
 * Field separator '|'. Field nội tại có '|' → escape '\|'. Newline → space.
 * Nested arrays/objects (categories, images, options, variants) → join string
 * hoặc JSON.stringify giữ shape.
 */
function renderProductsAsPipeSeparated(products: any[]): string {
  const headers = [
    'id', 'name', 'slug', 'published', 'vendor', 'tags',
    'body_html', 'seo_title', 'seo_description', 'categories', 'images',
    'sku', 'price', 'old_price', 'base_cost', 'inventory',
    'options', 'variants', 'create_date', 'update_date',
  ]
  const rows: string[] = [headers.join('|')]
  for (const p of products) {
    const vd = p?.variant_default ?? {}
    const cats = Array.isArray(p?.categories)
      ? p.categories.map((c: any) => c?.name ?? '').filter(Boolean).join(',')
      : ''
    const imgs = Array.isArray(p?.images)
      ? p.images.map((img: any) => img?.url ?? '').filter(Boolean).join(',')
      : ''
    const tags = Array.isArray(p?.tags) ? p.tags.join(',') : ''
    const opts = Array.isArray(p?.options)
      ? p.options
          .map((o: any) => {
            const vals = Array.isArray(o?.values)
              ? o.values.map((v: any) => v?.name ?? '').filter(Boolean).join(',')
              : ''
            return `${o?.name ?? ''}:${vals}`
          })
          .join(';')
      : ''
    const variantsJson = Array.isArray(p?.variants) && p.variants.length > 0
      ? JSON.stringify(p.variants.map((v: any) => ({
          name: v?.name ?? null,
          sku: v?.sku ?? null,
          price: v?.price ?? null,
          old_price: v?.old_price ?? null,
          inventory: v?.inventory ?? null,
          image_url: v?.image_url ?? null,
        })))
      : ''
    const row = [
      p?.id ?? '',
      p?.name ?? '',
      p?.slug ?? '',
      p?.published === true ? 'true' : 'false',
      p?.vendor ?? '',
      tags,
      stripHtml(p?.body_html ?? ''),
      p?.seo_title ?? '',
      p?.seo_description ?? '',
      cats,
      imgs,
      vd?.sku ?? '',
      vd?.price ?? '',
      vd?.old_price ?? '',
      vd?.base_cost ?? '',
      vd?.inventory ?? '',
      opts,
      variantsJson,
      p?.create_date ?? '',
      p?.update_date ?? '',
    ].map(pipeEscape).join('|')
    rows.push(row)
  }
  return rows.join('\n')
}

function pipeEscape(v: any): string {
  if (v === null || v === undefined) return ''
  return String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}

function stripHtml(s: string): string {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}
