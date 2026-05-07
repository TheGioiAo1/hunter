/**
 * My Stores — JSON API for sidebar store-switcher dropdown.
 *
 * GET /admin/store/:slug/api/my-stores
 *
 * Decodes JWT từ cookie → lấy shopIds[]. Per shopId Promise.all gọi BE Shop
 * Service GET /api/{shop_id} → name + id. Trả về list để client render dropdown.
 *
 * Lazy load: layout chỉ fetch khi user mở dropdown lần đầu (giảm latency
 * page render — most visitors không bao giờ mở switcher).
 */

import type { Request, Response } from 'express'
import { getSessionTokenFromCookies } from '@gbox/core/modules/auth/session.js'
import { decodeJwtPayload, readUserFromJwt } from '../lib/shop-resolver.js'
import { getShopDetail, type ApiContext } from '../lib/shop-detail-api-client.js'

interface MyStore {
  id: string
  name: string
  privateDomain: string | null
  publicDomain: string | null
  isOnline: boolean
  isActive: boolean
}

export async function getMyStoresApi(req: Request, res: Response): Promise<void> {
  const cookieHeader = req.headers.cookie ?? ''
  const token = getSessionTokenFromCookies(cookieHeader)
  if (!token) { res.status(401).json({ error: 'auth' }); return }

  const claims = decodeJwtPayload(token)
  const user = claims ? readUserFromJwt(claims) : null
  if (!user || user.shopIds.length === 0) {
    res.status(200).json({ stores: [] })
    return
  }

  const currentShopId = req.store?.id ?? ''

  // Parallel fetch shop details. Cap số shops max 50 — phần lớn user có < 5,
  // upper bound bảo vệ render khỏi loop quá rộng nếu JWT có claim lạ.
  const shopIds = user.shopIds.slice(0, 50)
  const results = await Promise.all(
    shopIds.map(async (shopId): Promise<MyStore | null> => {
      try {
        const ctx: ApiContext = { shopId, token }
        const detail = await getShopDetail(ctx)
        const name = detail?.name?.trim() || `Shop ${shopId.slice(-6)}`
        const privateDomain = detail?.private_domain?.trim() || null
        const publicDomain = detail?.public_domain?.trim() || null
        return {
          id: shopId,
          name,
          privateDomain,
          publicDomain,
          isOnline: detail?.active === true && !!privateDomain,
          isActive: shopId === currentShopId,
        }
      } catch {
        return {
          id: shopId,
          name: `Shop ${shopId.slice(-6)}`,
          privateDomain: null,
          publicDomain: null,
          isOnline: false,
          isActive: shopId === currentShopId,
        }
      }
    }),
  )
  const stores = results.filter((s): s is MyStore => s !== null)
  res.status(200).json({ stores })
}
