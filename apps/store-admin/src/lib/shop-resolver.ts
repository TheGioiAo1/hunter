/**
 * Shop resolver — bám sát backend C# (Auth + Shop Service):
 *  - JWT từ cookie `gbox_session` chứa claims: NameIdentifier, Email,
 *    FirtName (sic), LastName, Role, Shops (JSON-stringified shop_ids[]).
 *    Source: Gbox-Auth-Service/Services/TokenService.cs#CreateToken.
 *  - shop_id ở URL là ObjectId 24-hex; verify bằng JWT.Shops trước khi
 *    fetch detail từ api-shop/api/{shop_id} (BE: ShopController/Detail).
 *
 * Decode-only (không verify signature) — BE C# verify khi nhận request.
 */

import { cacheGet, cacheSet } from '@gbox/core/modules/cache/redis.js'

const API_SHOP_BASE = (
  process.env.API_SHOP_BASE_URL || 'https://api-shop.gbox.co'
).replace(/\/+$/, '')

const SHOP_API_TIMEOUT_MS = 8000
const SHOP_CACHE_TTL_SECONDS = 300

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i

export interface JwtClaims {
  [k: string]: unknown
  Shops?: string
}

export interface ResolvedUser {
  id: string
  email: string
  name: string
  role: string
  shopIds: string[]
}

export interface ResolvedShop {
  id: string
  name: string
  domain: string | null
  publicDomain: string | null
  privateDomain: string | null
  active: boolean
  currency: string
}

export function isShopId(value: string): boolean {
  return OBJECT_ID_RE.test(value)
}

/** Decode JWT payload (middle segment). Không verify — BE verify. */
export function decodeJwtPayload(token: string): JwtClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const obj = JSON.parse(json)
    return obj && typeof obj === 'object' ? (obj as JwtClaims) : null
  } catch {
    return null
  }
}

/**
 * Trích User + shopIds[] từ claims. Auth Service dùng ClaimTypes.* nên
 * key là URI dài (`http://schemas.xmlsoap.org/...`); một số JWT lib
 * map về tên ngắn (`nameid`, `email`, `role`). Đọc cả hai để chắc.
 */
export function readUserFromJwt(claims: JwtClaims): ResolvedUser | null {
  const get = (...keys: string[]): string => {
    for (const k of keys) {
      const v = claims[k]
      if (typeof v === 'string' && v.length > 0) return v
    }
    return ''
  }

  const id = get(
    'nameid',
    'sub',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
  )
  const email = get(
    'email',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  )
  const role = get(
    'role',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/role',
  )
  const firstName = get('FirtName', 'FirstName')
  const lastName = get('LastName')
  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || email

  if (!id) return null

  let shopIds: string[] = []
  const rawShops = claims['Shops']
  if (typeof rawShops === 'string') {
    try {
      const parsed = JSON.parse(rawShops)
      if (Array.isArray(parsed)) {
        shopIds = parsed.filter((s): s is string => typeof s === 'string' && isShopId(s))
      }
    } catch {
      // Shops claim malformed — treat as empty (user effectively no access).
    }
  }

  return { id, email, name, role, shopIds }
}

interface ApiShopResponse {
  id?: string
  name?: string | null
  title?: string | null
  private_domain?: string | null
  public_domain?: string | null
  domain?: string | null
  active?: boolean | null
  currency?: string | null
}

/**
 * Fetch shop detail từ Shop Service. Cache theo shop_id (5p).
 * BE [AllowAnonymous] nhưng vẫn gửi Bearer để consistent + future-proof.
 */
export async function fetchShopDetail(token: string, shopId: string): Promise<ResolvedShop | null> {
  const cacheKey = `store-admin:shop:${shopId}`
  const cached = await cacheGet<ResolvedShop>(cacheKey)
  if (cached) return cached

  const url = `${API_SHOP_BASE}/api/${encodeURIComponent(shopId)}`
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(SHOP_API_TIMEOUT_MS),
    })
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `timeout after ${SHOP_API_TIMEOUT_MS}ms`
      : err?.message || String(err)
    console.error(`[shop-resolver] Shop API fetch failed (${reason})`)
    return null
  }
  if (!resp.ok) {
    console.error(`[shop-resolver] Shop API ${resp.status} ${resp.statusText} for shop ${shopId}`)
    return null
  }

  const json = (await resp.json().catch(() => null)) as ApiShopResponse | null
  if (!json || !json.id) return null

  const resolved: ResolvedShop = {
    id: json.id,
    name: json.name || json.title || json.private_domain || json.id,
    domain: json.public_domain || json.private_domain || json.domain || null,
    publicDomain: json.public_domain ?? null,
    privateDomain: json.private_domain ?? null,
    active: json.active ?? true,
    currency: json.currency || 'USD',
  }
  await cacheSet(cacheKey, resolved, SHOP_CACHE_TTL_SECONDS)
  return resolved
}
