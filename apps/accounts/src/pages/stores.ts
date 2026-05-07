/**
 * Gbox Accounts — Store Selector Page
 *
 * GET /stores — List all shops the user has access to
 * Requires valid session (redirect to /login if not authenticated)
 */

import type { Request, Response } from 'express'
import {
  getSessionTokenFromCookies,
  validateSession,
} from '@gbox/core/modules/auth/session.js'
import { createCsrfStore } from '@gbox/core/modules/auth/csrf-express.js'
import { authLayout } from '../layouts/auth-layout.js'

// CSRF cho delete-store form. Issue per page render → verify trên POST.
const csrfStore = createCsrfStore({ cookieName: 'gbox_csrf_stores_delete' })

// ---------------------------------------------------------------------------
// Module-level database client. Core modules are already updated to handle
// null db for demo/mock mode. Handlers are updated to remove the db parameter.
// ---------------------------------------------------------------------------

const db = null as any

// ---------------------------------------------------------------------------
// Gbox Shop Service — REST client (server-side fetch)
// Backend: D:\Gbox\Gbox-Shop-Service · ShopController.List → GET /api
// Doc: Authorization: Bearer <jwt>; query: page, limit, fields?, published?
// Response: { pagination, data: { shops, total_rows_active, total_rows_inactive } }
// ---------------------------------------------------------------------------

const API_SHOP_BASE = (
  process.env.API_SHOP_BASE_URL || 'https://api-shop.gbox.co'
).replace(/\/+$/, '')

interface ApiShop {
  id: string
  name?: string | null
  title?: string | null
  private_domain?: string | null
  public_domain?: string | null
  domain?: string | null
  active?: boolean | null
  currency?: string | null
}

interface ApiShopListResponse {
  pagination?: { page: number; limit: number; count: number }
  data?: {
    shops?: ApiShop[]
    total_rows_active?: number
    total_rows_inactive?: number
  }
}

interface RenderShop {
  shopId: string
  shopName: string
  shopSlug: string
  role: string
  domain: string | null
  active: boolean
}

/** Đoán slug từ private_domain "shop_demo.mylencam.com" → "demo". */
function deriveSlug(s: ApiShop): string {
  const dom = s.private_domain || s.public_domain || s.domain || ''
  if (!dom) return s.id
  const head = dom.split('.')[0] || s.id
  return head.replace(/^shop_/, '') || s.id
}

// Upstream timeout phải nhỏ hơn server.requestTimeout (30s in
// configureKeepAlive) để handler có cơ hội render fallback page trước
// khi Node cắt connection ("Empty reply from server").
const SHOP_API_TIMEOUT_MS = 8000

const SHOP_ID_RE = /^[a-f0-9]{24}$/i

async function fetchShopsFromApi(token: string): Promise<RenderShop[]> {
  const url = `${API_SHOP_BASE}/api?page=1&limit=250`
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(SHOP_API_TIMEOUT_MS),
    })
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `timeout after ${SHOP_API_TIMEOUT_MS}ms`
      : err?.message || String(err)
    console.error(`[Stores] Shop API fetch failed (${reason}) — falling back to empty list`)
    return []
  }
  if (!resp.ok) {
    console.error(
      `[Stores] Shop API ${resp.status} ${resp.statusText} — falling back to empty list`,
    )
    return []
  }
  const json = (await resp.json().catch(() => ({}))) as ApiShopListResponse
  const list = json?.data?.shops ?? []
  console.log('[Stores] BE returned %d shops; ids: %j', list.length, list.map((s) => s?.id))
  return list
    .filter((s): s is ApiShop => {
      // BE Shop.id là Mongo ObjectId 24-hex. EmitDefaultValue=false → BE
      // có thể omit `id` khi null. Skip để không build URL /admin/store/undefined
      // gây middleware redirect ?error=invalid_shop_id.
      if (!s || !s.id || !SHOP_ID_RE.test(s.id)) {
        console.warn('[Stores] Skip shop với id không phải 24-hex:', s?.id, 'name:', s?.name)
        return false
      }
      return true
    })
    .map((s) => {
      const domain = s.public_domain || s.private_domain || s.domain || null
      const slug = deriveSlug(s)
      return {
        shopId: s.id!,
        shopName: s.name || s.title || slug,
        shopSlug: slug,
        role: 'owner',
        domain,
        active: s.active === true,
      }
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getStoreAdminPort(): string {
  return process.env.STORE_ADMIN_PORT ?? '4325'
}

function getAdminUrl(shopId: string, reqHost: string): string {
  const base = process.env.STORE_ADMIN_BASE_URL
  if (base) return `${base}/admin/store/${shopId}`
  if (isProduction()) return `https://admin.gbox.co/admin/store/${shopId}`
  // In dev, store-admin runs on a separate port — use same hostname as the request
  const hostname = reqHost.split(':')[0]
  return `http://${hostname}:${getStoreAdminPort()}/admin/store/${shopId}`
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const ICON_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
const ICON_DELETE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'

function renderStoreCardV2(s: RenderShop, reqHost: string, csrfToken: string): string {
  const initial = (s.shopName.charAt(0) || '?').toUpperCase()
  const isOnline = s.active === true && !!s.domain
  const dotColor = isOnline ? '#22c55e' : '#ef4444'
  const dotShadow = isOnline ? '0 0 6px rgba(34,197,94,.55)' : 'none'
  const dotTitle = isOnline ? 'Online' : (s.active ? 'No domain' : 'Inactive shop')
  const domainHtml = s.domain
    ? escapeHtml(s.domain)
    : '<em style="color:#94a3b8;font-style:italic">no domain</em>'
  const adminUrl = getAdminUrl(s.shopId, reqHost)
  const storeUrl = s.domain ? `https://${s.domain}` : null

  const openBtn = storeUrl
    ? `<a href="${escapeAttr(storeUrl)}" target="_blank" rel="noopener" class="store-icon-btn" title="Open store" aria-label="Open store">${ICON_OPEN}</a>`
    : `<span class="store-icon-btn disabled" title="No domain" aria-label="No domain">${ICON_OPEN}</span>`
  // Delete button — confirm 2-bước qua dialog. POST CSRF-protected.
  const escName = escapeHtml(s.shopName).replace(/'/g, "\\'")
  const deleteBtn = `<form method="POST" action="/accounts/stores/${escapeAttr(s.shopId)}/delete" style="display:inline;margin:0" onsubmit="return confirm('Xóa shop &quot;${escName}&quot;? Hành động này KHÔNG thể hoàn tác.')">
    ${csrfStore.hiddenField(csrfToken)}
    <button type="submit" class="store-icon-btn danger" title="Delete shop" aria-label="Delete shop">${ICON_DELETE}</button>
  </form>`

  // Active shop → cả card click navigate vào admin. Inactive → không click.
  // Open/Delete button có e.stopPropagation trong JS handler để không trigger nav.
  const cardCls = s.active ? 'store-card-v2 clickable' : 'store-card-v2 inactive'
  const cardData = s.active ? ` data-switch-href="${escapeAttr(adminUrl)}" role="link" tabindex="0"` : ''
  return `
    <div class="${cardCls}"${cardData}>
      <div class="store-card-avatar">${escapeHtml(initial)}</div>
      <div class="store-card-info">
        <div class="store-card-name">
          <span class="store-card-dot" style="background:${dotColor};box-shadow:${dotShadow}" title="${dotTitle}"></span>
          ${escapeHtml(s.shopName)}
        </div>
        <div class="store-card-domain">${domainHtml}</div>
      </div>
      <div class="store-card-actions">${openBtn}${deleteBtn}</div>
    </div>
  `
}

function decodeStoresError(code: string): string {
  switch (code) {
    case 'invalid_shop_id':
      return 'Shop ID không hợp lệ (phải là 24-hex Mongo ObjectId). Có thể link cũ hoặc shop đã bị xóa. Hãy chọn lại shop từ danh sách.'
    case 'no_access':
      return 'Bạn không có quyền truy cập shop đó. JWT chưa có shop_id này — hãy logout và login lại.'
    case 'shop_not_found':
      return 'Không tìm thấy shop trên BE Shop Service (có thể đã bị xóa). Chọn shop khác.'
    case 'csrf_invalid':
      return 'Form session hết hạn. Reload trang rồi thử lại.'
    case 'delete_failed':
      return 'Xóa shop thất bại — kiểm tra log container để biết chi tiết.'
    default:
      if (code.startsWith('delete_failed_')) {
        return `Xóa shop thất bại (BE trả HTTP ${code.replace('delete_failed_', '')}).`
      }
      return code
  }
}

function renderStores(
  userName: string,
  shops: RenderShop[],
  reqHost: string,
  errorParam: string,
  csrfToken: string,
): string {
  const shopCards = shops.map((s) => renderStoreCardV2(s, reqHost, csrfToken)).join('')
  const errorBanner = errorParam
    ? `<div style="margin-bottom:16px;padding:12px 14px;background:#fff4f4;border:1px solid #f8d5d5;color:#a61b1b;border-radius:8px;font-size:13px"><strong>Lỗi:</strong> ${escapeHtml(decodeStoresError(errorParam))}</div>`
    : ''

  const styles = `<style>
    /* Store card v2 — compact 1-row layout với avatar, dot xanh/đỏ, 2 icon button */
    .store-card-v2 {
      display: flex; align-items: center; gap: 12px;
      background: #ffffff; border: 1.5px solid #e2e8f0;
      border-radius: 12px; padding: 14px 16px;
      transition: border-color .15s, box-shadow .15s;
    }
    .store-card-v2:hover { border-color: #6366f1; box-shadow: 0 4px 12px rgba(99,102,241,.10); }
    .store-card-v2.clickable { cursor: pointer; }
    .store-card-v2.clickable:hover { background: #fafbff; }
    .store-card-v2.clickable:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
    .store-card-v2.inactive { opacity: .7; background: #f8fafc; }
    .store-card-avatar {
      width: 40px; height: 40px; border-radius: 8px;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      display: grid; place-items: center;
      font-weight: 700; font-size: 16px; color: #fff; flex-shrink: 0;
    }
    .store-card-v2.inactive .store-card-avatar { background: linear-gradient(135deg, #94a3b8, #64748b); }
    .store-card-info { flex: 1; min-width: 0; }
    .store-card-name {
      font-size: 14.5px; font-weight: 600; color: #0f172a;
      display: flex; align-items: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .store-card-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; flex-shrink: 0; }
    .store-card-domain {
      font-size: 12px; color: #64748b;
      font-family: ui-monospace, Menlo, monospace;
      margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .store-card-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .store-icon-btn {
      width: 36px; height: 36px;
      display: grid; place-items: center;
      border-radius: 8px;
      border: 1.5px solid #e2e8f0;
      background: #ffffff; color: #64748b;
      text-decoration: none; cursor: pointer;
      transition: .15s;
    }
    .store-icon-btn:hover { border-color: #6366f1; color: #6366f1; background: #eef2ff; }
    .store-icon-btn.primary { background: linear-gradient(180deg, #5b6dff, #4854e0); border-color: transparent; color: #fff; }
    .store-icon-btn.primary:hover { background: linear-gradient(180deg, #6577ff, #5260e8); border-color: transparent; }
    .store-icon-btn.disabled { opacity: .35; pointer-events: none; cursor: not-allowed; }
    .store-icon-btn.danger { color: #ef4444; }
    .store-icon-btn.danger:hover { background: #fef2f2; border-color: #ef4444; color: #b91c1c; }
    button.store-icon-btn { font: inherit; }
    /* Container scroll khi > 5 shop. 1 card ~72px + gap 10px → 5 × 72 + 4 × 10 = 400px. */
    .store-list-scroll {
      display: flex; flex-direction: column; gap: 10px;
      margin-top: 16px;
      max-height: 400px;
      overflow-y: auto;
      padding-right: 6px;
    }
    .store-list-scroll::-webkit-scrollbar { width: 8px; }
    .store-list-scroll::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 4px; }
    .store-list-scroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
    .store-list-scroll::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
  </style>`

  return authLayout({
    title: 'Your stores',
    wide: true,
    content: `
      ${styles}
      ${errorBanner}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div>
          <h1>Your stores</h1>
          <p class="subtitle">Welcome back, ${escapeHtml(userName)}</p>
        </div>
        <a href="/accounts/create-store" class="btn btn-primary" style="width:auto;padding:10px 20px">
          + New store
        </a>
      </div>

      ${
        shops.length === 0
          ? `
        <div style="text-align:center;padding:40px 0">
          <p style="color:#64748b;margin-bottom:16px">You don't have any stores yet.</p>
          <a href="/accounts/create-store" class="btn btn-primary" style="width:auto;display:inline-flex;padding:10px 24px">
            Create your first store
          </a>
        </div>
      `
          : `<div class="store-list-scroll">${shopCards}</div>`
      }

      <div class="text-center mt-24">
        <a href="/accounts/account" class="link text-sm">Account settings</a>
        <span class="text-sm" style="margin:0 8px;color:#cbd5e1">|</span>
        <a href="/accounts/logout" class="link text-sm">Log out</a>
      </div>

      <script>(function(){
        // Card click → navigate. Bỏ qua khi click vào button/form/a (Open/Delete).
        document.querySelectorAll('.store-card-v2.clickable').forEach(function(card){
          var href = card.getAttribute('data-switch-href');
          if (!href) return;
          card.addEventListener('click', function(e){
            if (e.target.closest('a, button, form, input, label')) return;
            window.location.href = href;
          });
          card.addEventListener('keydown', function(e){
            if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
              e.preventDefault();
              window.location.href = href;
            }
          });
        });
      })();</script>
    `,
  })
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function getStores(
  req: Request,
  res: Response,
): Promise<void> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    res.redirect('/accounts/login')
    return
  }

  // Demo mode: validateSession có thể fail vì db null. Không block —
  // ưu tiên gọi Shop API; nếu API trả 401 thì user redirect login từ
  // 401-handler client-side (out of scope) hoặc thấy danh sách rỗng.
  const result = await validateSession(db, token).catch(() => null)
  const userName = result?.session?.user?.name || 'there'

  let shops: RenderShop[] = []
  try {
    shops = await fetchShopsFromApi(token)
  } catch (err) {
    console.error('[Stores] fetchShopsFromApi failed:', err)
  }

  const reqHost = req.headers.host || 'localhost:4323'
  const errorParam = typeof req.query.error === 'string' ? req.query.error.slice(0, 100) : ''
  const csrfToken = await csrfStore.issue(res, isProduction())
  res.send(renderStores(userName, shops, reqHost, errorParam, csrfToken))
}

// ---------------------------------------------------------------------------
// POST /accounts/stores/:shopId/delete — xóa shop qua BE Shop Service.
// ---------------------------------------------------------------------------

const SHOP_ID_RE_DEL = /^[a-f0-9]{24}$/i

export async function postDeleteStore(
  req: Request,
  res: Response,
): Promise<void> {
  const token = getSessionTokenFromCookies(req.headers.cookie ?? '')
  if (!token) {
    res.redirect('/accounts/login')
    return
  }
  if (!(await csrfStore.verify(req))) {
    res.redirect('/accounts/stores?error=csrf_invalid')
    return
  }
  const shopId = String(req.params.shopId ?? '')
  if (!SHOP_ID_RE_DEL.test(shopId)) {
    res.redirect('/accounts/stores?error=invalid_shop_id')
    return
  }

  try {
    const r = await fetch(`${API_SHOP_BASE}/api/${encodeURIComponent(shopId)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(SHOP_API_TIMEOUT_MS),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      console.error(`[Stores] DELETE shop_id=${shopId} → HTTP ${r.status}: ${body.slice(0, 200)}`)
      res.redirect(`/accounts/stores?error=${encodeURIComponent('delete_failed_' + r.status)}`)
      return
    }
  } catch (err: any) {
    console.error('[Stores] DELETE failed:', err?.message || err)
    res.redirect('/accounts/stores?error=delete_failed')
    return
  }

  res.redirect('/accounts/stores')
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
