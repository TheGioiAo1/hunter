/**
 * BE Subfee wrapper (Gbox-Order-Service /api/{shop_id}/subfee).
 * Used by Tax settings to persist per-region tax rates as subfees:
 *  - country_codes: [region.code]   ← which countries this fee applies to
 *  - name: "Tax — {region}"         ← FE marker so we can filter only tax subfees
 *  - price: rate                     ← BE stores as number (FE treats as %)
 *
 * BE routes:
 *   POST   /api/{shop_id}/subfee                        — create (Authorize)
 *   PUT    /api/{shop_id}/subfee/{subfee_id}            — update (Authorize)
 *   GET    /api/{shop_id}/subfee/{subfee_id}            — detail (AllowAnonymous)
 *   DELETE /api/{shop_id}/subfee/{subfee_id}            — delete one (Authorize)
 *   DELETE /api/{shop_id}/subfee  body=string[]         — delete many
 *   GET    /api/{shop_id}/subfee?country_code=VN        — list (AllowAnonymous)
 *   POST   /api/{shop_id}/subfee/checkout               — calc on cart
 */

import { ProductApiError } from './product-api-errors.js'
import { createApiContext, type ApiContext } from './product-api-client.js'

const ORDER_BASE = (process.env.API_ORDER_BASE_URL || 'https://api-order.gbox.co').replace(/\/+$/, '')
const TIMEOUT_MS = 8000

export { createApiContext, type ApiContext }

export interface BeEntityObject {
  entity_id?: string | null
  entity_name?: string | null
}

export interface BeSubFee {
  id?: string
  shop_id?: string
  name?: string | null
  description?: string | null
  country_codes?: string[] | null
  country_excluded?: boolean | null
  /** @deprecated BE filter không dùng ids nữa, dùng entities[] thay thế */
  ids?: string[] | null
  /** entity_id+entity_name pairs — null/[] = áp dụng tất cả */
  entities?: BeEntityObject[] | null
  /** 0 = category, 1 = product (int, không phải string) */
  entity?: 0 | 1 | null
  entity_excluded?: boolean | null
  first_item_price?: number | null
  second_item_price?: number | null
  /** Dùng để hiển thị, BE Calc() không dùng field này để tính */
  price?: number | null
  create_date?: string | null
  update_date?: string | null
}

export interface SubFeeListResponse {
  pagination?: { page?: number; limit?: number; count?: number }
  data?: BeSubFee[]
}

// Marker prefix on `name` so we can distinguish tax subfees from other types.
export const TAX_NAME_PREFIX = 'Tax — '

function shopBase(shopId: string): string {
  return `${ORDER_BASE}/api/${encodeURIComponent(shopId)}/subfee`
}

interface FetchInit extends Omit<RequestInit, 'signal'> {
  token?: string
}

async function fetchJson<T>(url: string, init: FetchInit): Promise<T> {
  const { token, headers, ...rest } = init
  let r: Response
  try {
    r = await fetch(url, {
      ...rest,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ProductApiError('timeout', `Subfee API timeout ${TIMEOUT_MS}ms`)
    }
    throw new ProductApiError('network', err?.message || 'fetch failed')
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new ProductApiError('http', `${r.status} ${r.statusText}${text ? ' — ' + text.slice(0, 200) : ''}`, r.status)
  }
  const ctype = r.headers.get('content-type') ?? ''
  if (!ctype.includes('json')) return {} as T
  return (await r.json()) as T
}

export async function listSubfees(
  ctx: ApiContext,
  opts: { country_code?: string; page?: number; limit?: number } = {},
): Promise<SubFeeListResponse> {
  const params = new URLSearchParams()
  if (opts.country_code) params.set('country_code', opts.country_code)
  params.set('page', String(opts.page ?? 1))
  params.set('limit', String(opts.limit ?? 50))
  return fetchJson<SubFeeListResponse>(`${shopBase(ctx.shopId)}?${params}`, {
    method: 'GET',
    token: ctx.token,
  })
}

export async function getSubfee(ctx: ApiContext, id: string): Promise<BeSubFee | null> {
  const r = await fetchJson<BeSubFee | null>(`${shopBase(ctx.shopId)}/${encodeURIComponent(id)}`, {
    method: 'GET',
    token: ctx.token,
  })
  return r ?? null
}

export async function createSubfee(ctx: ApiContext, body: BeSubFee): Promise<BeSubFee> {
  return fetchJson<BeSubFee>(`${shopBase(ctx.shopId)}`, {
    method: 'POST',
    token: ctx.token,
    body: JSON.stringify(body),
  })
}

export async function updateSubfee(ctx: ApiContext, id: string, body: BeSubFee): Promise<BeSubFee> {
  return fetchJson<BeSubFee>(`${shopBase(ctx.shopId)}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    token: ctx.token,
    body: JSON.stringify(body),
  })
}

export async function deleteSubfee(ctx: ApiContext, id: string): Promise<void> {
  await fetchJson<unknown>(`${shopBase(ctx.shopId)}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token: ctx.token,
  })
}

/**
 * Compute total tax for an order (FE convention).
 *
 * Why we don't use BE /subfee/checkout: BE SubFeeService.Calc treats
 * `first_item_price` as a flat $ amount per item (`first + second*(qty-1)`),
 * but FE convention stores it as a RATE %. The two semantics conflict and
 * BE Calc returns 0 for our records. Instead we list tax subfees for the
 * country, sum their rates, and multiply subtotal here. BE Order.Calc keeps
 * whatever `order.tax` we send untouched (only `order.subfee` is recomputed),
 * so the value persists correctly through create/update.
 *
 * @returns { rate, amount } where rate is sum of % rates and amount = subtotal * rate / 100
 */
export async function computeOrderTax(
  ctx: ApiContext,
  countryCode: string,
  subtotal: number,
): Promise<{ rate: number; amount: number }> {
  if (!countryCode || !subtotal || subtotal <= 0) return { rate: 0, amount: 0 }
  try {
    const r = await listSubfees(ctx, { country_code: countryCode, limit: 50 })
    const ratePct = (r.data || [])
      .filter(f => typeof f.name === 'string' && f.name.startsWith(TAX_NAME_PREFIX))
      .reduce((sum, t) => sum + (Number((t as any).first_item_price ?? (t as any).price ?? 0)), 0)
    const amount = Math.round(subtotal * ratePct) / 100
    return { rate: ratePct, amount }
  } catch (err: any) {
    console.warn('[tax-compute] failed:', err?.message)
    return { rate: 0, amount: 0 }
  }
}

// ─── Tax-specific helpers (FE convention) ───

/**
 * Find tax subfee for a given region (by country code). Tax subfees are
 * marked by name starting with TAX_NAME_PREFIX so we don't collide with
 * shipping/other subfees that may also use country_code filter.
 *
 * Nếu BE có nhiều record cho cùng region (do upsert lỡ tạo trùng), chọn
 * record có update_date/create_date mới nhất — đảm bảo FE luôn hiển thị
 * giá trị save cuối.
 */
export async function findTaxSubfeeByRegion(
  ctx: ApiContext,
  countryCode: string,
): Promise<BeSubFee | null> {
  const r = await listSubfees(ctx, { country_code: countryCode, limit: 50 })
  const ccLower = countryCode.toLowerCase()
  const matches = (r.data || []).filter(f =>
    typeof f.name === 'string' &&
    f.name.startsWith(TAX_NAME_PREFIX) &&
    Array.isArray(f.country_codes) &&
    f.country_codes.some(c => c.toLowerCase() === ccLower),
  )
  if (matches.length === 0) return null
  if (matches.length > 1) {
    console.warn('[subfee] duplicate tax subfees for region', countryCode, 'count=', matches.length, 'ids=', matches.map(m => m.id))
  }
  matches.sort((a, b) => {
    const ta = new Date(a.update_date || a.create_date || 0).getTime()
    const tb = new Date(b.update_date || b.create_date || 0).getTime()
    return tb - ta
  })
  return matches[0]
}

/**
 * Like findTaxSubfeeByRegion but returns ALL matches — useful for cleanup
 * (delete duplicates) or diagnostics.
 */
export async function findAllTaxSubfeesByRegion(
  ctx: ApiContext,
  countryCode: string,
): Promise<BeSubFee[]> {
  const r = await listSubfees(ctx, { country_code: countryCode, limit: 50 })
  const ccLower2 = countryCode.toLowerCase()
  return (r.data || []).filter(f =>
    typeof f.name === 'string' &&
    f.name.startsWith(TAX_NAME_PREFIX) &&
    Array.isArray(f.country_codes) &&
    f.country_codes.some(c => c.toLowerCase() === ccLower2),
  )
}

/**
 * Upsert tax subfee for a region. price = tax rate (FE treats as %).
 *
 * Nếu phát hiện duplicates (BE đã có nhiều subfee cùng region từ lần upsert
 * trước bị lỗi), xóa hết bản dư rồi update bản mới nhất → đảm bảo idempotent.
 */
export async function upsertTaxSubfee(
  ctx: ApiContext,
  opts: { regionCode: string; regionName: string; rate: number; description?: string },
): Promise<BeSubFee> {
  const matches = await findAllTaxSubfeesByRegion(ctx, opts.regionCode)
  matches.sort((a, b) => {
    const ta = new Date(a.update_date || a.create_date || 0).getTime()
    const tb = new Date(b.update_date || b.create_date || 0).getTime()
    return tb - ta
  })
  const keep = matches[0]
  const dupes = matches.slice(1)
  for (const d of dupes) {
    if (d.id) {
      try { await deleteSubfee(ctx, d.id) }
      catch (e: any) { console.warn('[subfee] delete duplicate failed', d.id, e?.message) }
    }
  }
  const body: BeSubFee = {
    name: `${TAX_NAME_PREFIX}${opts.regionName}`,
    description: opts.description ?? `Tax rate ${opts.rate}% for ${opts.regionName}`,
    country_codes: [opts.regionCode],
    country_excluded: false,
    price: opts.rate,
    // BE Calc() dùng first_item_price — price field không tham gia tính toán
    first_item_price: opts.rate,
    // entity=0 (category) + entities=null → Calc() sẽ match qua nhánh category,
    // áp dụng cho tất cả sản phẩm (kể cả item không có category).
    // Nếu không set entity, BuildFilter bỏ qua tax subfee hoàn toàn.
    entity: 0,
    entities: null,
    entity_excluded: false,
  }
  if (keep?.id) {
    return updateSubfee(ctx, keep.id, { ...keep, ...body })
  }
  return createSubfee(ctx, body)
}
