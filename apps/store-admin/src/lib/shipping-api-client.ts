/**
 * Shipping API client — wrapper fetch cho Gbox-Shipping-Service.
 * BASE URL: ENV `API_SHIPPING_BASE_URL` (default `https://api-shipping.gbox.co`).
 *
 * Routes (BE Swagger):
 *   GET    /api/{shop_id}                    — list (field/keyword)
 *   GET    /api/{shop_id}/{shipping_id}      — detail
 *   POST   /api/{shop_id}?shipping_id=       — create or update (truyền id để update)
 *   PUT    /api/{shop_id}/{shipping_id}      — update
 *   DELETE /api/{shop_id}/{shipping_id}      — delete
 */

import { ProductApiError } from './product-api-errors.js'
import { createApiContext, type ApiContext } from './product-api-client.js'
import { fetchJson } from './api-fetch-json.js'
import type { ApiShipping, ListShippingsOpts } from './shipping-api-types.js'

const SHIPPING_BASE = (
  process.env.API_SHIPPING_BASE_URL || 'https://api-shipping.gbox.co'
).replace(/\/+$/, '')

function shopBase(shopId: string): string {
  return `${SHIPPING_BASE}/api/${encodeURIComponent(shopId)}`
}

const fetch$ = <T>(url: string, init: Parameters<typeof fetchJson>[1]) =>
  fetchJson<T>(url, init, 'Shipping')

export { createApiContext }
export type { ApiContext }

export async function listShippings(
  ctx: ApiContext,
  opts: ListShippingsOpts = {},
): Promise<ApiShipping[]> {
  const params = new URLSearchParams()
  if (opts.field) params.set('field', opts.field)
  if (opts.keyword) params.set('keyword', opts.keyword)
  const qs = params.toString()
  const r = await fetch$<ApiShipping[] | { data?: ApiShipping[] } | null>(
    `${shopBase(ctx.shopId)}${qs ? '?' + qs : ''}`,
    { method: 'GET', token: ctx.token },
  )
  if (Array.isArray(r)) return r
  if (r && Array.isArray((r as any).data)) return (r as any).data
  return []
}

export async function getShipping(
  ctx: ApiContext,
  shippingId: string,
): Promise<ApiShipping | null> {
  try {
    const r = await fetch$<ApiShipping | null>(
      `${shopBase(ctx.shopId)}/${encodeURIComponent(shippingId)}`,
      { method: 'GET', token: ctx.token },
    )
    if (!r || !(r as any).id) return null
    return r
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export async function createShipping(
  ctx: ApiContext,
  body: Partial<ApiShipping>,
): Promise<ApiShipping> {
  return fetch$<ApiShipping>(shopBase(ctx.shopId), {
    method: 'POST',
    body: JSON.stringify(body),
    token: ctx.token,
  })
}

export async function updateShipping(
  ctx: ApiContext,
  shippingId: string,
  body: Partial<ApiShipping>,
): Promise<ApiShipping | null> {
  try {
    return await fetch$<ApiShipping>(
      `${shopBase(ctx.shopId)}/${encodeURIComponent(shippingId)}`,
      { method: 'PUT', body: JSON.stringify(body), token: ctx.token },
    )
  } catch (err: any) {
    if (err instanceof ProductApiError && err.status === 404) return null
    throw err
  }
}

export async function deleteShipping(
  ctx: ApiContext,
  shippingId: string,
): Promise<void> {
  await fetch$<unknown>(
    `${shopBase(ctx.shopId)}/${encodeURIComponent(shippingId)}`,
    { method: 'DELETE', token: ctx.token },
  )
}
