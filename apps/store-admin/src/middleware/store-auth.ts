/**
 * Store Admin Auth Middleware (Mongo edition)
 *
 * Validates:
 * 1. Session cookie → Mongo Gbox-Users.sessions
 * 2. URL slug (shop_id) → Mongo Gbox-Shops.shops
 * 3. User has membership in shop → Gbox-Users.user_shops
 *    (owners/super-admins bypass via the role check)
 *
 * Audit logging is fire-and-forget — failures never block the request.
 */

import type { Request, Response, NextFunction } from 'express'

import {
  getSessionTokenFromCookies,
  validateSession,
} from '@gbox/core/modules/auth/session.js'
import { getMongoDb } from '@gbox/core/modules/db/mongo.js'
import type { ShopDoc, UserShopDoc } from '@gbox/core/modules/db/types.js'

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      store?: {
        id: string
        name: string
        slug: string
        domain: string | null
        plan: string
        status: string
        currency: string
        onboarding_state?: string | null
        onboarding_choice?: string | null
        onboarding_clone_job_id?: string | null
        onboarding_completed_at?: string | null
      }
      storeUser?: {
        id: string
        name: string
        email: string
        role: string      // owner | admin | staff
        storeRole: string // owner | admin | editor | viewer
      }
      csrfToken?: string
    }
  }
}

const ACCOUNTS_PORT = process.env.ACCOUNTS_PORT ?? '4323'

function getAccountsBaseUrl(req: Request): string {
  if (process.env.ACCOUNTS_URL) return process.env.ACCOUNTS_URL
  if (process.env.ACCOUNTS_BASE_URL) return process.env.ACCOUNTS_BASE_URL
  if (process.env.NODE_ENV === 'production') {
    // Default to same scheme/host the request came in on so this works
    // for huntershop.us, gbox.co, custom domains alike.
    return `https://${req.headers.host || 'admin.huntershop.us'}`
  }
  const host = (req.headers.host || 'localhost').split(':')[0]
  return `http://${host}:${ACCOUNTS_PORT}`
}

export function createStoreAuthMiddleware() {
  return async function storeAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const accountsUrl = getAccountsBaseUrl(req)
    const slug = String(req.params.slug ?? '')
    if (!slug) {
      res.status(400).send(renderError('Store not specified', 'No store id found in URL.', accountsUrl))
      return
    }

    const cookieHeader = req.headers.cookie ?? ''
    const token = getSessionTokenFromCookies(cookieHeader)

    if (!token) {
      res.redirect(`${accountsUrl}/accounts/login?return_to=${encodeURIComponent(req.originalUrl)}`)
      return
    }

    // 1. Validate session against Mongo
    const sessionResult = await validateSession(null, token)
    if (!sessionResult.valid || !sessionResult.session) {
      res.redirect(`${accountsUrl}/accounts/login?return_to=${encodeURIComponent(req.originalUrl)}`)
      return
    }
    const sessionUser = sessionResult.session.user

    // 2. Resolve shop by slug or _id
    const shopsDb = await getMongoDb('SHOPS')
    const shop = await shopsDb
      .collection<ShopDoc>('shops')
      .findOne({ $or: [{ _id: slug }, { slug }] })
    if (!shop) {
      res.redirect(`${accountsUrl}/accounts/stores?error=shop_not_found`)
      return
    }

    // 3. Check membership (owner role on user doc grants global access)
    let storeRole: string | null = null
    if (sessionUser.role === 'owner') {
      storeRole = 'owner'
    } else {
      const usersDb = await getMongoDb('USERS')
      const membership = await usersDb
        .collection<UserShopDoc>('user_shops')
        .findOne({ user_id: sessionUser.id, shop_id: shop._id }, { projection: { role: 1 } })
      if (!membership) {
        res.redirect(`${accountsUrl}/accounts/stores?error=no_access`)
        return
      }
      storeRole = membership.role
    }

    req.store = {
      id: shop._id,
      name: shop.name,
      slug: shop.slug,
      domain: shop.domain,
      plan: shop.plan ?? 'professional',
      status: shop.status === 'active' ? 'active' : 'inactive',
      currency: shop.currency ?? 'USD',
      onboarding_state: 'completed',
    }
    req.storeUser = {
      id: sessionUser.id,
      name: sessionUser.name,
      email: sessionUser.email,
      role: sessionUser.role,
      storeRole: (storeRole ?? 'viewer').toLowerCase(),
    }

    // Audit log: fire-and-forget
    const auditStore = req.store!
    const auditUser = req.storeUser!
    logStoreAction({
      shopId: auditStore.id,
      userId: auditUser.id,
      action: req.method === 'GET' ? 'page_view' : 'store_action',
      resourceType: 'store_admin',
      resourceId: auditStore.id,
      details: {
        method: req.method,
        path: req.path,
        userEmail: auditUser.email,
        storeRole: auditUser.storeRole,
        ip: req.ip || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
      },
      ip: req.ip || req.socket.remoteAddress || '',
    }).catch(() => {})

    // Read theme preference from cookie
    const themeMatch = cookieHeader.match(/gbox_theme=(dark|light)/)
    ;(req as any).theme = themeMatch ? themeMatch[1] : 'dark'

    next()
  }
}

// ─── Audit logging for store actions ────────────────────────────
interface StoreAuditEntry {
  shopId: string
  userId: string
  action: string
  resourceType: string
  resourceId: string
  details: Record<string, unknown>
  ip: string
}

async function logStoreAction(entry: StoreAuditEntry): Promise<void> {
  // Persist to Gbox-Users.audit_logs (fire-and-forget; caller .catch()s)
  const db = await getMongoDb('USERS')
  await db.collection('audit_logs').insertOne({
    user_id: entry.userId,
    shop_id: entry.shopId,
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId,
    details: JSON.stringify(entry.details),
    ip_address: entry.ip,
    created_at: new Date().toISOString(),
  })
}

/** Logger called from individual store-admin pages for important actions. */
export async function logSellerAction(
  req: Request,
  action: string,
  resourceType: string,
  resourceId: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const store = req.store
  const user = req.storeUser
  if (!store || !user) return

  logStoreAction({
    shopId: store.id,
    userId: user.id,
    action,
    resourceType,
    resourceId,
    details: {
      userEmail: user.email,
      storeRole: user.storeRole,
      ip: req.ip || req.socket.remoteAddress,
      ...extra,
    },
    ip: req.ip || req.socket.remoteAddress || '',
  }).catch(() => {})
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderError(title: string, message: string, accountsUrl: string = ''): string {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)
  const safeUrl = escapeHtml(accountsUrl)
  return `<!DOCTYPE html>
<html><head><title>${safeTitle} - Gbox Admin</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,sans-serif;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;color:#e2e8f0}
  .box{text-align:center;background:#1e293b;padding:48px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.3);max-width:420px;border:1px solid #334155}
  h1{font-size:20px;margin-bottom:8px;color:#f87171}
  p{color:#94a3b8;font-size:14px;margin-bottom:20px;line-height:1.6}
  a{color:#818cf8;text-decoration:none;font-size:14px}
  a:hover{text-decoration:underline}
</style></head>
<body><div class="box">
  <h1>${safeTitle}</h1>
  <p>${safeMessage}</p>
  <a href="${safeUrl}/accounts/stores">&larr; Back to stores</a>
</div></body></html>`
}
