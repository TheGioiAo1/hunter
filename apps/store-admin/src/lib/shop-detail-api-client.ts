/**
 * Shop detail API — Gbox-Shop-Service GET/PUT /api/{shop_id}.
 * Tách khỏi shop-resolver.ts (resolver chỉ trả minimal fields cho auth).
 * Đây dùng cho Settings/General — full Shop model.
 */

import { ProductApiError } from './product-api-errors.js'
import { createApiContext, type ApiContext } from './product-api-client.js'
import { fetchJson } from './api-fetch-json.js'

export { ProductApiError }

const SHOP_BASE = (
  process.env.API_SHOP_BASE_URL || 'https://api-shop.gbox.co'
).replace(/\/+$/, '')

export interface ApiShop {
  id?: string
  user_id?: string
  favicon?: string
  logo?: string
  social_image?: string
  public_domain?: string
  private_domain?: string
  title?: string
  description?: string
  name?: string
  legal_name_of_business?: string
  phone?: string
  email?: string
  address?: string
  apartment?: string
  city?: string
  province?: string
  country_code?: string
  zip_code?: string
  work_time?: string
  timezone?: string
  prefix?: string
  suffix?: string
  currency?: string
  expired_at?: string
  active?: boolean
  language?: string
  create_date?: string
}

export { createApiContext }
export type { ApiContext }

const fetch$ = <T>(url: string, init: Parameters<typeof fetchJson>[1]) =>
  fetchJson<T>(url, init, 'Shop')

export async function getShopDetail(ctx: ApiContext): Promise<ApiShop | null> {
  try {
    const r = await fetch$<ApiShop | null>(`${SHOP_BASE}/api/${encodeURIComponent(ctx.shopId)}`, {
      method: 'GET',
      token: ctx.token,
    })
    if (!r || !(r as any).id) return null
    return r
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export async function updateShopDetail(
  ctx: ApiContext,
  body: Partial<ApiShop>,
): Promise<ApiShop | null> {
  try {
    return await fetch$<ApiShop>(`${SHOP_BASE}/api/${encodeURIComponent(ctx.shopId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      token: ctx.token,
    })
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export interface PublicDomainResult {
  status?: boolean | null
  message?: string | null
  id?: string
  public_domain?: string | null
}

/** PUT /api/{shopId}/public-domain?domain=xxx — ShopController.UpdatePublicDomain */
export async function setPublicDomain(
  ctx: ApiContext,
  domain: string,
): Promise<PublicDomainResult> {
  const url = `${SHOP_BASE}/api/${encodeURIComponent(ctx.shopId)}/public-domain?domain=${encodeURIComponent(domain)}`
  return fetch$<PublicDomainResult>(url, { method: 'PUT', token: ctx.token })
}

/** DELETE /api/{shopId}/public-domain — ShopController.DeletePublicDomain */
export async function deletePublicDomain(
  ctx: ApiContext,
): Promise<PublicDomainResult> {
  const url = `${SHOP_BASE}/api/${encodeURIComponent(ctx.shopId)}/public-domain`
  return fetch$<PublicDomainResult>(url, { method: 'DELETE', token: ctx.token })
}
