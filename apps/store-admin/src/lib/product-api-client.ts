/**
 * Thin wrapper quanh generated CategoryService + ProductService cho
 * apps/store-admin. Mục tiêu:
 *  - Bind shop_id + JWT từ Express request (multi-tenant safe)
 *  - 8s timeout (nhỏ hơn server.requestTimeout 30s — handler kịp render fallback)
 *  - Typed errors thay raw fetch errors
 *
 * Why per-call OpenAPI.TOKEN: codegen client dùng module-level singleton.
 * Node single-threaded JS → set token sync ngay trước call, request builder
 * đọc nó sync trước await đầu tiên → không có race trong cùng event loop tick.
 * Reset trong finally tránh leak sang request khác nếu trace có await xen kẽ.
 */

import type { Request } from 'express'
import {
  CategoryService,
  ProductService,
  OpenAPI,
} from '../../../../packages/api-client/src/product/index.js'
import { getSessionTokenFromCookies } from '@gbox/core/modules/auth/session.js'
import { decodeJwtPayload, isShopId, readUserFromJwt } from './shop-resolver.js'
import { ProductApiError, toProductApiError } from './product-api-errors.js'
import type {
  Category,
  Product,
  CategoryListFilter,
  ProductListFilter,
  CategoryListResponse,
  ProductListResponse,
  BulkInventoryUpdate,
} from './product-api-types.js'

// Configure base URL once. ENV override cho local dev / staging.
OpenAPI.BASE = (process.env.API_PRODUCT_BASE_URL || 'https://api-product.gbox.co').replace(/\/+$/, '')

// BE Product POST có await Task.Delay(1000) + ValidateImageUrl re-download
// ảnh không match Lencam S3 pattern (mỗi ảnh +3-8s). Update tương tự. Reads
// vẫn fast (sub-1s) nên timeout 60s không ảnh hưởng UX list/get.
const TIMEOUT_MS = 60000

export interface ApiContext {
  shopId: string
  token: string
}

/**
 * Extract shop_id + JWT từ req. Throws ProductApiError('auth') khi thiếu.
 * Ưu tiên store.id (24-hex) → fallback JWT.Shops[0]. Phòng middleware demo
 * fallback đẩy slug-style vào store.id → BE filter MongoDB sai → empty.
 */
export function createApiContext(req: Request): ApiContext {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    throw new ProductApiError('auth', 'No session token in cookies')
  }
  let shopId = req.store?.id && isShopId(req.store.id) ? req.store.id : ''
  if (!shopId) {
    const claims = decodeJwtPayload(token)
    const jwtUser = claims ? readUserFromJwt(claims) : null
    if (jwtUser && jwtUser.shopIds.length > 0) shopId = jwtUser.shopIds[0]
  }
  if (!shopId) {
    throw new ProductApiError('auth', 'No valid shop_id (store.id not 24-hex and JWT has no Shops claim)')
  }
  return { shopId, token }
}

/**
 * Set token + race với timeout, map error, reset token.
 * fn() phải tự kick off request — không await trước khi gọi service.
 */
async function withApi<T>(ctx: ApiContext, fn: () => Promise<unknown>): Promise<T> {
  const prevToken = OpenAPI.TOKEN
  OpenAPI.TOKEN = ctx.token
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new ProductApiError('timeout', `Upstream API timed out after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        ),
      ),
    ])
    return result as T
  } catch (err) {
    throw toProductApiError(err)
  } finally {
    OpenAPI.TOKEN = prevToken
  }
}

// ===========================================================================
// Categories
// ===========================================================================

/**
 * BE bug workaround: CategoryService._FieldsDefault là instance field; nếu DI
 * đăng ký Singleton thì projection từ call trước "nhiễm" sang call sau →
 * response thiếu name/slug khi không truyền `fields`.
 * Default này force projection mỗi request. Caller (e.g. count với 'id') vẫn
 * override được. Bỏ default sau khi BE fix singleton state.
 */
const DEFAULT_CATEGORY_LIST_FIELDS =
  'id,shop_id,name,slug,description,seo_title,seo_description,image_url,create_date,update_date,status,display_detail,google_product_category'

export function listCategories(ctx: ApiContext, filter: CategoryListFilter = {}): Promise<CategoryListResponse> {
  return withApi(ctx, () =>
    CategoryService.getApiCategory({
      shopId: ctx.shopId,
      keyword: filter.keyword,
      page: filter.page ?? 1,
      limit: filter.limit ?? 25,
      status: filter.status,
      executeIds: filter.executeIds,
      sortBy: filter.sortBy,
      fields: filter.fields ?? DEFAULT_CATEGORY_LIST_FIELDS,
    }),
  )
}

export function getCategory(ctx: ApiContext, idOrSlug: string): Promise<Category> {
  return withApi(ctx, () => CategoryService.getApiCategory1({ shopId: ctx.shopId, idOrSlug }))
}

export function createCategory(ctx: ApiContext, payload: Category): Promise<Category> {
  return withApi(ctx, () => CategoryService.postApiCategory({ shopId: ctx.shopId, requestBody: payload }))
}

export function updateCategory(ctx: ApiContext, categoryId: string, payload: Category): Promise<Category> {
  return withApi(ctx, () =>
    CategoryService.putApiCategory({ shopId: ctx.shopId, categoryId, requestBody: payload }),
  )
}

export function deleteCategory(ctx: ApiContext, categoryId: string): Promise<{ status?: boolean; message?: string }> {
  return withApi(ctx, () => CategoryService.deleteApiCategory1({ shopId: ctx.shopId, categoryId }))
}

export function bulkDeleteCategories(
  ctx: ApiContext,
  ids: string[],
): Promise<{ status?: boolean; message?: string }> {
  return withApi(ctx, () => CategoryService.deleteApiCategory({ shopId: ctx.shopId, requestBody: ids }))
}

// ===========================================================================
// Products
// ===========================================================================

/**
 * Cùng workaround singleton _FieldsDefault như listCategories, áp cho
 * ProductService.cs:52,71,688,731. List view chỉ cần subset (không kéo
 * body_html / options / custom_fields nặng). Detail page có override.
 */
const DEFAULT_PRODUCT_LIST_FIELDS =
  'id,shop_id,name,slug,images,variant_default,variants,published,create_date,update_date,vendor,tags,categories,seo_title'

export function listProducts(ctx: ApiContext, filter: ProductListFilter = {}): Promise<ProductListResponse> {
  return withApi(ctx, () =>
    ProductService.getApi({
      shopId: ctx.shopId,
      page: filter.page ?? 1,
      limit: filter.limit ?? 25,
      published: filter.published,
      categorySlug: filter.categorySlug,
      categoryIds: filter.categoryIds,
      tags: filter.tags,
      productSku: filter.productSku,
      productIds: filter.productIds,
      excludeCategoryIds: filter.excludeCategoryIds,
      minPrice: filter.minPrice,
      maxPrice: filter.maxPrice,
      keyword: filter.keyword,
      fields: filter.fields ?? DEFAULT_PRODUCT_LIST_FIELDS,
      sortBy: filter.sortBy,
      isCache: filter.isCache ?? true,
    }),
  )
}

export function getProduct(ctx: ApiContext, idOrSlug: string): Promise<Product> {
  return withApi(ctx, () => ProductService.getApi1({ shopId: ctx.shopId, idOrSlug }))
}

export function createProduct(ctx: ApiContext, payload: Product): Promise<Product> {
  // BE POST /api/{shop_id} body=Product. Mirror updateProduct shape — caller
  // must pass full Product (BE replaces nested arrays nguyên khối).
  return withApi(ctx, () =>
    ProductService.postApi({ shopId: ctx.shopId, requestBody: payload }),
  )
}

export function updateProduct(ctx: ApiContext, productId: string, payload: Product): Promise<Product> {
  return withApi(ctx, () =>
    ProductService.putApi({ shopId: ctx.shopId, productId, requestBody: payload }),
  )
}

export function bulkUpdateInventory(
  ctx: ApiContext,
  skuMap: BulkInventoryUpdate,
): Promise<{ status?: boolean; message?: string }> {
  return withApi(ctx, () =>
    ProductService.putApiBulkUpdateInventory({ shopId: ctx.shopId, requestBody: skuMap }),
  )
}

export function getProductTags(ctx: ApiContext): Promise<string[]> {
  return withApi(ctx, () => ProductService.getApiTags({ shopId: ctx.shopId }))
}

// ===========================================================================
// Collections (BE: Gbox-Product-Service-V2/Controllers/CollectionController)
// Codegen api-client chưa có Collection — dùng raw fetch với OpenAPI.BASE.
// ===========================================================================

import type {
  ShopCollection,
  CollectionProductItem,
  CollectionListFilter,
  CollectionListResponse,
} from './collection-api-types.js'

async function fetchJson<T>(ctx: ApiContext, path: string, init: RequestInit = {}): Promise<T> {
  const url = `${OpenAPI.BASE}${path}`
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${ctx.token}`,
    ...((init.headers as Record<string, string>) ?? {}),
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { ...init, headers, signal: ctrl.signal })
    if (r.status === 401 || r.status === 403) throw new ProductApiError('auth', `HTTP ${r.status}`)
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new ProductApiError('http', `HTTP ${r.status}: ${body.slice(0, 200)}`)
    }
    return (await r.json()) as T
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new ProductApiError('timeout', `timeout ${TIMEOUT_MS}ms`)
    if (err instanceof ProductApiError) throw err
    throw new ProductApiError('http', err?.message || 'fetch failed')
  } finally {
    clearTimeout(timer)
  }
}

function buildQs(params: Record<string, unknown>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue
    usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export function listShopCollections(ctx: ApiContext, filter: CollectionListFilter = {}): Promise<CollectionListResponse> {
  const qs = buildQs({
    page: filter.page ?? 1,
    limit: filter.limit ?? 50,
    keyword: filter.keyword,
    product_id: filter.productId,
    status: filter.status,
    tags: filter.tags,
    fields: filter.fields,
    sort_by: filter.sortBy,
  })
  return fetchJson<CollectionListResponse>(ctx, `/api/${encodeURIComponent(ctx.shopId)}/collections/list${qs}`)
}

export function getShopCollection(ctx: ApiContext, idOrSlug: string): Promise<ShopCollection> {
  return fetchJson<ShopCollection>(ctx, `/api/${encodeURIComponent(ctx.shopId)}/collections/${encodeURIComponent(idOrSlug)}`)
}

export function checkShopCollectionSlug(
  ctx: ApiContext,
  slug: string,
  excludeId?: string,
): Promise<{ available: boolean; slug?: string; reason?: string }> {
  const qs = buildQs({ slug, exclude_id: excludeId })
  return fetchJson(ctx, `/api/${encodeURIComponent(ctx.shopId)}/collections/slug-check${qs}`)
}

export function createShopCollection(ctx: ApiContext, payload: ShopCollection): Promise<ShopCollection> {
  return fetchJson<ShopCollection>(ctx, `/api/${encodeURIComponent(ctx.shopId)}/collections`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateShopCollection(ctx: ApiContext, id: string, payload: ShopCollection): Promise<ShopCollection> {
  return fetchJson<ShopCollection>(ctx, `/api/${encodeURIComponent(ctx.shopId)}/collections/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteShopCollection(ctx: ApiContext, id: string): Promise<{ status?: boolean; message?: string }> {
  return fetchJson(ctx, `/api/${encodeURIComponent(ctx.shopId)}/collections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function bulkDeleteShopCollections(ctx: ApiContext, ids: string[]): Promise<{ status?: boolean; message?: string }> {
  return fetchJson(ctx, `/api/${encodeURIComponent(ctx.shopId)}/collections`, {
    method: 'DELETE',
    body: JSON.stringify(ids),
  })
}

export function addProductToShopCollection(
  ctx: ApiContext,
  collectionId: string,
  product: CollectionProductItem,
): Promise<ShopCollection> {
  return fetchJson<ShopCollection>(
    ctx,
    `/api/${encodeURIComponent(ctx.shopId)}/collections/${encodeURIComponent(collectionId)}/products`,
    { method: 'POST', body: JSON.stringify(product) },
  )
}

export function removeProductFromShopCollection(
  ctx: ApiContext,
  collectionId: string,
  productId: string,
): Promise<ShopCollection> {
  return fetchJson<ShopCollection>(
    ctx,
    `/api/${encodeURIComponent(ctx.shopId)}/collections/${encodeURIComponent(collectionId)}/products/${encodeURIComponent(productId)}`,
    { method: 'DELETE' },
  )
}

export function reorderShopCollectionProducts(
  ctx: ApiContext,
  collectionId: string,
  productIds: string[],
): Promise<ShopCollection> {
  return fetchJson<ShopCollection>(
    ctx,
    `/api/${encodeURIComponent(ctx.shopId)}/collections/${encodeURIComponent(collectionId)}/products/order`,
    { method: 'PUT', body: JSON.stringify(productIds) },
  )
}

// Re-export for convenience
export { ProductApiError } from './product-api-errors.js'
export type { Category, Product, ProductVariant, CategoryListFilter, ProductListFilter, BulkInventoryUpdate } from './product-api-types.js'
export type {
  ShopCollection,
  CollectionProductItem,
  CollectionListFilter,
  CollectionListResponse,
} from './collection-api-types.js'
