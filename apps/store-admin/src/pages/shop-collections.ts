/**
 * shop-collections.ts
 * Handlers cho trang Collections — wired vào BE CollectionController
 * (Gbox-Product-Service-V2). Replace handlers cũ trong collections.ts (vốn
 * dùng Categories collection) — thay bằng Collections riêng.
 */

import type { Request, Response } from 'express'
import { OpenAPI } from '../../../../packages/api-client/src/product/index.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { sellerLayout } from '../layouts/seller-layout.js'
import {
  createApiContext,
  listShopCollections,
  getShopCollection,
  createShopCollection,
  updateShopCollection,
  deleteShopCollection,
  bulkDeleteShopCollections,
  addProductToShopCollection,
  removeProductFromShopCollection,
  listProducts,
  ProductApiError,
} from '../lib/product-api-client.js'
import type { ShopCollection } from '../lib/collection-api-types.js'
import { renderShopCollectionListPage } from './shop-collection-list-render.js'
import { renderShopCollectionEditForm } from './shop-collection-edit-render.js'

function csrfStr(req: Request): string {
  const t = (req as any).csrfToken
  return typeof t === 'function' ? t() : (t ?? '')
}

function parseTags(s: string | undefined): string[] {
  if (!s) return []
  return s.split(',').map((t) => t.trim()).filter(Boolean)
}

function parseItemsFromBody(body: any): { product_id: string; product_name: string; product_image: string }[] {
  if (!body || typeof body !== 'object') return []
  // Express dùng `extended:false` (server.ts:580) → bracket-notation form names
  // (items[KEY][field]) KHÔNG decompose thành nested object, body có flat keys
  // dạng "items[KEY][field]". Match cả flat lẫn nested (forward-compat nếu config
  // chuyển sang extended:true).
  const grouped: Record<string, Record<string, string>> = {}
  const re = /^items\[([^\]]+)\]\[([^\]]+)\]$/
  for (const fullKey of Object.keys(body)) {
    const m = fullKey.match(re)
    if (!m) continue
    const [, itemKey, fieldName] = m
    grouped[itemKey] ??= {}
    grouped[itemKey][fieldName] = String(body[fullKey] ?? '')
  }
  if (body.items && typeof body.items === 'object') {
    for (const itemKey of Object.keys(body.items)) {
      const it = body.items[itemKey]
      if (!it || typeof it !== 'object') continue
      grouped[itemKey] ??= {}
      for (const fieldName of Object.keys(it)) {
        grouped[itemKey][fieldName] = String((it as any)[fieldName] ?? '')
      }
    }
  }
  // Dedupe theo product_id — picker mode='product' add toàn bộ variants thành các
  // key riêng (productId|variantSlug), nhưng collection chỉ track product-level.
  const seen = new Set<string>()
  const out: { product_id: string; product_name: string; product_image: string }[] = []
  for (const itemKey of Object.keys(grouped)) {
    const it = grouped[itemKey]
    const productId = (it.product_id ?? '').trim()
    if (!productId || seen.has(productId)) continue
    seen.add(productId)
    out.push({
      product_id: productId,
      product_name: (it.variant_name ?? '').trim(),
      product_image: '',
    })
  }
  return out
}

function buildPayload(body: any): ShopCollection {
  // checkbox status: gửi 'true' khi checked, undefined khi không
  const statusVal = body.status
  const status = statusVal === 'true' || statusVal === 'on' || statusVal === true
  return {
    name: String(body.name ?? '').trim(),
    slug: String(body.slug ?? '').trim() || undefined,
    description: body.description ?? '',
    body_html: body.body_html ?? '',
    status,
    image_url: body.image_url ?? '',
    seo_title: body.seo_title ?? '',
    seo_description: body.seo_description ?? '',
    sort_order: body.sort_order ?? 'manual',
    tags: parseTags(body.tags),
    products: parseItemsFromBody(body),
  }
}

// ---------------------------------------------------------------------------
// GET /products/collections — List
// ---------------------------------------------------------------------------

export async function getShopCollections(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/products/collections`

  const page = Math.max(1, parseInt(req.query.page as string) || 1)
  const search = ((req.query.q as string) || '').trim()
  const statusParam = ((req.query.status as string) || '').toLowerCase()
  const sort = ((req.query.sort as string) || 'create_date_desc').trim()
  const successMsg = (req.query.success as string) || ''
  const errorMsg = (req.query.error as string) || ''

  let collections: ShopCollection[] = []
  let totalCount = 0
  let publishedCount = 0
  let draftCount = 0
  let apiFailed = false

  try {
    const ctx = createApiContext(req)
    const statusFilter = statusParam === 'active' ? true : statusParam === 'draft' ? false : undefined
    // Explicit fields — BE singleton _FieldsDefault có thể skip `products` array
    // gây cột "Products" hiển thị 0. Liệt kê đủ field để render list + count đúng.
    const LIST_FIELDS = 'id,shop_id,name,slug,description,status,image_url,products,tags,create_date,update_date'
    const [listResp, pubResp, draftResp] = await Promise.allSettled([
      listShopCollections(ctx, { keyword: search || undefined, status: statusFilter, sortBy: sort, page, limit: 25, fields: LIST_FIELDS }),
      listShopCollections(ctx, { status: true, page: 1, limit: 1, fields: 'id' }),
      listShopCollections(ctx, { status: false, page: 1, limit: 1, fields: 'id' }),
    ])
    if (listResp.status === 'fulfilled') {
      const r = listResp.value
      collections = r?.data ?? []
      totalCount = Number(r?.pagination?.count ?? collections.length)
      const sample = collections[0] as any
      console.log('[ShopCollections] list shop_id=%s page=%d count=%d sample.products=%s',
        ctx.shopId, page, collections.length,
        sample ? `${Array.isArray(sample.products) ? sample.products.length : typeof sample.products}` : 'n/a')
    } else {
      apiFailed = true
      console.error('[ShopCollections] list failed:', listResp.reason)
      if (listResp.reason instanceof ProductApiError && listResp.reason.kind === 'auth') {
        res.redirect('/accounts/login'); return
      }
    }
    if (pubResp.status === 'fulfilled') publishedCount = Number(pubResp.value?.pagination?.count ?? 0)
    if (draftResp.status === 'fulfilled') draftCount = Number(draftResp.value?.pagination?.count ?? 0)
  } catch (err) {
    apiFailed = true
    console.error('[ShopCollections] setup failed:', err)
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / 25))
  const flash = errorMsg
    ? { type: 'error' as const, message: errorMsg }
    : successMsg
      ? { type: 'success' as const, message: successMsg }
      : apiFailed
        ? { type: 'error' as const, message: 'Failed to connect to Product API. Showing empty list.' }
        : undefined

  res.send(renderShopCollectionListPage({
    req, collections, totalCount, publishedCount, draftCount, page, totalPages,
    q: search, status: statusParam, sort, base, flash,
  }))
}

// ---------------------------------------------------------------------------
// GET /products/collections/new — Create form
// ---------------------------------------------------------------------------

export async function getCreateShopCollection(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}/products/collections`

  const content = renderShopCollectionEditForm({
    mode: 'create',
    formAction: base,
    csrfField: csrfHiddenField(csrfStr(req)),
    backHref: base,
    productsSearchUrl: `${base}/products-search`,
    slugCheckUrl: `${base}/slug-check`,
    flashError: typeof req.query.error === 'string' ? req.query.error : undefined,
  })
  res.send(sellerLayout({
    title: 'Create collection',
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email,
    userRole: user.role, storeRole: user.storeRole,
    activePage: 'collections', content, theme: theme as 'dark' | 'light',
  }))
}

export async function postCreateShopCollection(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/products/collections`
  const payload = buildPayload(req.body)
  console.log('[ShopCollections] create name=%s slug=%s products=%d',
    payload.name, payload.slug, (payload.products ?? []).length)
  if (!payload.name) {
    res.redirect(`${base}/new?error=${encodeURIComponent('Title is required')}`); return
  }
  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }
  try {
    const created = await createShopCollection(ctx, payload)
    res.redirect(`${base}/${created.id}/edit?success=${encodeURIComponent('Collection created')}`)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
    const msg = err instanceof Error ? err.message : 'Create failed'
    res.redirect(`${base}/new?error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// GET /products/collections/:id/edit
// ---------------------------------------------------------------------------

export async function getEditShopCollection(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${store.slug}/products/collections`
  const id = String(req.params.id || '')

  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }
  let collection: ShopCollection | null = null
  try { collection = await getShopCollection(ctx, id) } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
  }
  if (!collection) {
    res.redirect(`${base}?error=${encodeURIComponent('Collection not found')}`); return
  }

  const successMsg = typeof req.query.success === 'string' ? req.query.success : ''
  const errorMsg = typeof req.query.error === 'string' ? req.query.error : ''

  const content = renderShopCollectionEditForm({
    mode: 'edit',
    formAction: `${base}/${id}/update`,
    csrfField: csrfHiddenField(csrfStr(req)),
    backHref: base,
    productsSearchUrl: `${base}/products-search`,
    slugCheckUrl: `${base}/slug-check`,
    collection,
    flashError: errorMsg || (successMsg ? '' : ''),
  })
  res.send(sellerLayout({
    title: `Edit ${collection.name ?? 'collection'}`,
    storeName: store.name, storeSlug: store.slug,
    userName: user.name, userEmail: user.email,
    userRole: user.role, storeRole: user.storeRole,
    activePage: 'collections', content, theme: theme as 'dark' | 'light',
  }))
}

export async function postUpdateShopCollection(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/products/collections`
  const id = String(req.params.id || '')
  const payload = buildPayload(req.body)
  console.log('[ShopCollections] update id=%s products=%d', id, (payload.products ?? []).length)
  if (!payload.name) {
    res.redirect(`${base}/${id}/edit?error=${encodeURIComponent('Title is required')}`); return
  }
  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }
  try {
    await updateShopCollection(ctx, id, payload)
    res.redirect(`${base}/${id}/edit?success=${encodeURIComponent('Collection updated')}`)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
    const msg = err instanceof Error ? err.message : 'Update failed'
    res.redirect(`${base}/${id}/edit?error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /products/collections/:id/delete
// POST /products/collections/bulk (body ids[])
// ---------------------------------------------------------------------------

export async function postDeleteShopCollection(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/products/collections`
  const id = String(req.params.id || '')
  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }
  try {
    await deleteShopCollection(ctx, id)
    res.redirect(`${base}?success=${encodeURIComponent('Collection deleted')}`)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
    const msg = err instanceof Error ? err.message : 'Delete failed'
    res.redirect(`${base}?error=${encodeURIComponent(msg)}`)
  }
}

export async function postBulkShopCollections(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/products/collections`
  const ids = ([] as string[]).concat(req.body['ids[]'] || req.body.ids || []).filter(Boolean) as string[]
  if (ids.length === 0) {
    res.redirect(`${base}?error=${encodeURIComponent('No collections selected')}`); return
  }
  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }
  try {
    await bulkDeleteShopCollections(ctx, ids)
    res.redirect(`${base}?success=${encodeURIComponent(`Deleted ${ids.length} collection(s)`)}`)
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.redirect('/accounts/login'); return }
    const msg = err instanceof Error ? err.message : 'Bulk delete failed'
    res.redirect(`${base}?error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// JSON endpoints (cho picker + slug-check FE)
// ---------------------------------------------------------------------------

export async function getShopCollectionsProductsSearch(req: Request, res: Response): Promise<void> {
  let ctx
  try { ctx = createApiContext(req) } catch { res.status(401).json({ error: 'auth' }); return }
  const q = ((req.query.q as string) || '').trim()
  try {
    // Copy nguyên pattern fetch của inventory.ts (đã verify works ở cùng shop):
    // fields tối thiểu (id,name,slug,images,variants), limit=200, isCache=false.
    // Drop variant_default + published — picker xử lý products có variants[] đủ.
    const productsResp = await listProducts(ctx, {
      keyword: q || undefined,
      fields: 'id,name,slug,images,variants',
      page: 1,
      limit: 200,
      isCache: false,
    })
    // BE GET /api/{shop_id} (Product list) trả thẳng { pagination, data: Product[] }.
    // Không có .data.products. Fallback giữ phòng shape thay đổi.
    const raw = (
      Array.isArray((productsResp as any)?.data) ? (productsResp as any).data
      : Array.isArray((productsResp as any)?.data?.products) ? (productsResp as any).data.products
      : []
    ) as any[]
    console.log('[ShopCollections] products-search shop_id=%s q=%s products=%d', ctx.shopId, q, raw.length)
    const products = raw.map((p) => {
      const firstImg = Array.isArray(p.images) && p.images.length > 0
        ? (p.images.find((i: any) => i?.position === 0 || i?.position == null)?.url ?? p.images[0]?.url ?? '')
        : (p.variant_default?.image_url ?? '')
      const allVariants = Array.isArray(p.variants) && p.variants.length > 0
        ? p.variants
        : (p.variant_default ? [p.variant_default] : [])
      const variants = allVariants.map((v: any) => ({
        id: v.id ?? '',
        slug: v.slug ?? (v.name ? String(v.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : ''),
        name: v.name ?? 'Default',
        sku: v.sku ?? '',
        image_url: v.image_url ?? '',
        price: Number(v.price ?? 0),
        inventory: Number(v.inventory ?? 0),
      }))
      const totalInv = variants.reduce((s: number, v: any) => s + v.inventory, 0)
      return {
        id: p.id || p.slug,
        name: p.name || p.slug || 'Unnamed',
        slug: p.slug || '',
        image_url: firstImg,
        available: totalInv,
        available_at_destination: totalInv,
        variants,
      }
    })
    res.json({ products })
  } catch (err) {
    if (err instanceof ProductApiError && err.kind === 'auth') { res.status(401).json({ error: 'auth' }); return }
    res.status(500).json({ error: 'fetch_failed', message: err instanceof Error ? err.message : 'Unknown' })
  }
}

export async function getShopCollectionSlugCheck(req: Request, res: Response): Promise<void> {
  let ctx
  try { ctx = createApiContext(req) } catch { res.status(401).json({ error: 'auth' }); return }
  const slug = ((req.query.slug as string) || '').trim()
  const excludeId = ((req.query.exclude_id as string) || '').trim() || undefined
  if (!slug) { res.json({ available: false, reason: 'empty' }); return }
  try {
    const apiBase = (process.env.API_PRODUCT_BASE_URL || 'https://api-product.gbox.co').replace(/\/+$/, '')
    const url = `${apiBase}/api/${encodeURIComponent(ctx.shopId)}/collections/slug-check?slug=${encodeURIComponent(slug)}${excludeId ? `&exclude_id=${encodeURIComponent(excludeId)}` : ''}`
    const r = await fetch(url, { headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' } })
    if (!r.ok) { res.status(r.status).json({ error: 'be_error' }); return }
    const data = await r.json()
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err instanceof Error ? err.message : 'Unknown' })
  }
}

// ---------------------------------------------------------------------------
// Add / Remove product (for product detail screen integration)
// ---------------------------------------------------------------------------

export async function postShopCollectionProductAdd(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/products/collections`
  const id = String(req.params.id || '')
  const productId = String(req.body.product_id || '').trim()
  const productName = String(req.body.product_name || '').trim()
  const productImage = String(req.body.product_image || '').trim()
  if (!productId) {
    res.redirect(`${base}/${id}/edit?error=${encodeURIComponent('Missing product_id')}`); return
  }
  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }
  try {
    await addProductToShopCollection(ctx, id, { product_id: productId, product_name: productName, product_image: productImage })
    res.redirect(`${base}/${id}/edit?success=${encodeURIComponent('Product added')}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Add failed'
    res.redirect(`${base}/${id}/edit?error=${encodeURIComponent(msg)}`)
  }
}

export async function postShopCollectionProductRemove(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/products/collections`
  const id = String(req.params.id || '')
  const productId = String(req.params.product_id || req.body.product_id || '').trim()
  if (!productId) {
    res.redirect(`${base}/${id}/edit?error=${encodeURIComponent('Missing product_id')}`); return
  }
  let ctx
  try { ctx = createApiContext(req) } catch { res.redirect('/accounts/login'); return }
  try {
    await removeProductFromShopCollection(ctx, id, productId)
    res.redirect(`${base}/${id}/edit?success=${encodeURIComponent('Product removed')}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Remove failed'
    res.redirect(`${base}/${id}/edit?error=${encodeURIComponent(msg)}`)
  }
}

// Re-export OpenAPI để force module init nếu cần
export { OpenAPI }
