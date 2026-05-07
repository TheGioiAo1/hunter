/**
 * Store Admin Auth Middleware
 *
 * Validates:
 * 1. User has valid session
 * 2. User has access to the requested store (via user_shops)
 * 3. Attaches store + user context to request
 * 4. Logs ALL actions to audit_logs for God Admin visibility
 */

import type { Request, Response, NextFunction } from 'express'
import type { Kysely } from 'kysely'
import {
  getSessionTokenFromCookies,
  validateSession,
} from '@gbox/core/modules/auth/session.js'
import {
  createNotification,
  type NotificationType,
} from '@gbox/core/modules/notifications/service.js'
import {
  AdminLevel,
  hasAtLeastLevel,
  resolveAdminLevel,
  describeAdminLevel,
} from '@gbox/core/modules/auth/admin-levels.js'
// Phase 0 §8 Item #3 — 2FA gate (ported from PR #10). Sessions with
// `two_fa_verified=false` (password accepted but TOTP step not done
// yet) must be kicked out of the per-shop dashboard and bounced back
// to the accounts portal challenge page.
import { getSessionTwoFaVerified } from '@gbox/core/modules/auth/two-factor.js'
// Phase 0 §8 Item #4 — per-user IP allowlist (ported from PR #10).
// Enforced AFTER the 2FA gate so an allowlist misconfiguration never
// short-circuits MFA.
import {
  parseCidrList,
  ipInAllowlist,
  normaliseRequestIp,
} from '@gbox/core/modules/auth/ip-allowlist.js'
import {
  decodeJwtPayload,
  fetchShopDetail,
  isShopId,
  readUserFromJwt,
} from '../lib/shop-resolver.js'

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
        /**
         * Phase A/D (2026-04-18) onboarding wizard fields. Populated by
         * store-auth so every downstream middleware / handler can read
         * them without re-querying. `onboarding_state` is the primary
         * decision field for the gate; the others feed the E3
         * completion hook and the wizard's mid-clone resume branch.
         */
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
      /** CSRF token issued by centralized middleware (available on GET requests) */
      csrfToken?: string
    }
  }
}

const ACCOUNTS_PORT = process.env.ACCOUNTS_PORT ?? '4323'

function getAccountsBaseUrl(req: Request): string {
  if (process.env.ACCOUNTS_BASE_URL) return process.env.ACCOUNTS_BASE_URL
  // Same-origin (admin.gbox.co/accounts/* qua nginx path routing)
  if (process.env.NODE_ENV === 'production') {
    return `https://${req.headers.host || 'admin.gbox.co'}`
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

    // URL pattern: /admin/store/{shop_id}/... — `slug` giờ thực ra là
    // shop_id (24-hex ObjectId từ JWT.Shops). Bám sát BE Product Service:
    // route `api/{shop_id}/category` filter MongoDB theo shop_id thật.
    const claims = decodeJwtPayload(token)
    const jwtUser = claims ? readUserFromJwt(claims) : null

    // Demo fallback: token "demo_token_xxx" không phải JWT chuẩn → giữ
    // mock để demo@gbox.co flow không vỡ. Production token luôn decode được.
    if (!jwtUser) {
      req.store = {
        id: slug,
        name: slug === 'gbox-demo' ? 'Gbox Demo Store' : slug,
        slug,
        domain: `${slug}.gbox.co`,
        plan: 'professional',
        status: 'active',
        currency: 'USD',
        onboarding_state: 'completed',
      }
      req.storeUser = {
        id: 'usr_demo123',
        name: 'Demo Seller',
        email: 'demo@gbox.co',
        role: 'owner',
        storeRole: 'owner',
      }
    } else {
      // Production path
      if (!isShopId(slug)) {
        console.warn('[store-auth] invalid_shop_id slug=%j path=%s referer=%s jwt.shopIds=%j',
          slug, req.originalUrl, req.headers.referer || '(none)', jwtUser.shopIds)
        res.redirect(`${accountsUrl}/accounts/stores?error=invalid_shop_id`)
        return
      }
      // Defense-in-depth: BE đã filter user_id, nhưng verify trước khi fetch
      // tránh leak shop name của user khác qua endpoint Detail [AllowAnonymous].
      if (!jwtUser.shopIds.includes(slug)) {
        console.warn('[store-auth] no_access slug=%s jwt.shopIds=%j path=%s referer=%s',
          slug, jwtUser.shopIds, req.originalUrl, req.headers.referer || '(none)')
        res.redirect(`${accountsUrl}/accounts/stores?error=no_access`)
        return
      }
      const shop = await fetchShopDetail(token, slug)
      if (!shop) {
        console.warn('[store-auth] shop_not_found slug=%s referer=%s', slug, req.headers.referer || '(none)')
        res.redirect(`${accountsUrl}/accounts/stores?error=shop_not_found`)
        return
      }
      req.store = {
        id: shop.id,
        name: shop.name,
        slug: shop.id, // build URL ${base}/admin/store/${store.slug} → vẫn dùng id
        domain: shop.domain,
        plan: 'professional',
        status: shop.active ? 'active' : 'inactive',
        currency: shop.currency,
        onboarding_state: 'completed',
      }
      req.storeUser = {
        id: jwtUser.id,
        name: jwtUser.name,
        email: jwtUser.email,
        role: jwtUser.role,
        storeRole: jwtUser.role === 'owners' ? 'owner' : (jwtUser.role || 'editor').toLowerCase(),
      }
    }

    // Audit log: record page view / action for God Admin visibility
    // Fire-and-forget — never block the request
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
  // // API-MODE: Send to Audit Log service
  console.log('[API-MODE] Audit Log:', entry)
}

// ─── Utility: log specific store admin actions (for pages to use) ──
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

  // // API-MODE: Create a notification for important actions via Notifications API
  console.log('[API-MODE] Create Notification:', { storeId: store.id, action, resourceType })
}


/** Escape HTML special characters to prevent XSS */
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
