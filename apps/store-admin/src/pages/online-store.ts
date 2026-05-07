/**
 * Store Admin — Online Store Hub, Themes, and Files
 *
 * Overview dashboard, theme management, and file/asset management
 * Phase 7: Online Store management
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { listThemes } from '@gbox/core/modules/themes/service.js'
import { createApiContext, listPages } from '../lib/page-api-client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badge(label: string, color: string, bg: string): string {
  return `<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;background:${bg};color:${color}">${label}</span>`
}

function activeBadge(): string {
  return badge('Active', '#22c55e', 'rgba(34,197,94,.15)')
}

function inactiveBadge(): string {
  return badge('Inactive', '#eab308', 'rgba(234,179,8,.15)')
}

function comingSoonBadge(): string {
  return badge('Coming Soon', '#a78bfa', 'rgba(167,139,250,.15)')
}

function installedBadge(): string {
  return badge('Installed', '#6366f1', 'rgba(99,102,241,.15)')
}

// ---------------------------------------------------------------------------
// GET /online-store — Online Store Hub
// ---------------------------------------------------------------------------

export async function getOnlineStoreHub(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  try {
    const store = req.store!
    const user = req.storeUser!
    const theme = (req as any).theme || 'dark'
    const base = `/admin/store/${store.slug}`

    // store-admin chạy ở API mode → server.ts giữ `db = null`. Route binding
    // không wrap handler với db nên `db` arg = `next: NextFunction`. Bọc mỗi
    // query trong try/catch để API mode hiển thị tile với count=0 / domain=null
    // thay vì 500 toàn trang. Khi nào BE Page/Article Service expose count
    // endpoint thì swap fallback ở đây.
    const hasDb = !!db && typeof (db as any).selectFrom === 'function'

    let pageCount = 0
    let blogCount = 0
    let customDomain: string | null = null
    let privateDomain: string | null = null
    let storeStatus: string = (req.store as any)?.status || 'active'

    if (hasDb) {
      try {
        const pagesResult = await db.selectFrom('pages')
          .select(db.fn.countAll().as('count'))
          .where('shop_id', '=', store.id)
          .executeTakeFirst()
        pageCount = Number(pagesResult?.count || 0)
      } catch { /* graceful — table missing / wrong schema */ }
      try {
        const blogResult = await db.selectFrom('blog_posts')
          .select(db.fn.countAll().as('count'))
          .where('shop_id', '=', store.id)
          .executeTakeFirst()
        blogCount = Number(blogResult?.count || 0)
      } catch { /* graceful */ }
      try {
        const shop = await db.selectFrom('shops')
          .select(['domain', 'status'])
          .where('id', '=', store.id)
          .executeTakeFirst()
        customDomain = shop?.domain?.trim() || null
        storeStatus = shop?.status || 'active'
      } catch { /* graceful */ }
    } else {
      // API mode (db=null) → lấy pageCount từ Gbox-Page-Service.
      // Blog/shop chưa refactor sang BE → giữ default.
      try {
        const ctx = createApiContext(req)
        const r = await listPages(ctx, { page: 1, limit: 1, fields: 'id' })
        pageCount = Number(r.pagination?.count ?? 0)
      } catch { /* graceful — Page Service down */ }
      // Fetch shop detail from BE Shop Service to get private_domain (slug
      // shown to customers) + public_domain (custom domain). Falls back
      // gracefully if BE unreachable — display still uses store.slug.
      try {
        const shopApi = (process.env.API_SHOP_BASE_URL || 'https://api-shop.gbox.co').replace(/\/+$/, '')
        const cookieHeader = req.headers.cookie ?? ''
        const tokenMatch = cookieHeader.match(/(?:^|;\s*)gbox_session=([^;]+)/)
        const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : ''
        const r = await fetch(`${shopApi}/api/${encodeURIComponent(store.id)}?fields=id,private_domain,public_domain,active`, {
          method: 'GET',
          headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          signal: AbortSignal.timeout(8000),
        })
        if (r.ok) {
          const sd: any = await r.json().catch(() => null)
          privateDomain = (sd?.private_domain ?? '').toString().trim() || null
          customDomain = (sd?.public_domain ?? '').toString().trim() || customDomain
          if (sd && sd.active === false) storeStatus = 'inactive'
        }
      } catch { /* graceful — BE Shop down */ }
    }

    // Resolve the store URL shown in the Status card. Priority:
    //   1. public_domain (verified custom domain — full URL no platform suffix)
    //   2. private_domain (may be either bare slug "shop_ducnguyen" or full
    //      "shop_ducnguyen.gbox.co" — append `.gbox.co` only when missing
    //      so we don't end up with `…gbox.co.gbox.co`)
    //   3. store.slug.gbox.co (admin-routing slug, last-resort fallback)
    function buildHostUrl(raw: string, fallbackSuffix: string): string {
      const cleaned = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim()
      const hasDot = cleaned.includes('.')
      return hasDot ? `https://${cleaned}` : `https://${cleaned}${fallbackSuffix}`
    }
    const storeUrl = customDomain
      ? buildHostUrl(customDomain, '')
      : privateDomain
        ? buildHostUrl(privateDomain, '.gbox.co')
        : `https://${store.slug}.gbox.co`

    const content = `
      <div style="margin-bottom:24px">
        <h1 style="font-size:20px;font-weight:700;margin:0 0 4px">Online Store</h1>
        <p style="color:var(--s-text-secondary);font-size:13px;margin:0">Manage your store's online presence, themes, pages, and content.</p>
      </div>

      <!-- Status Card -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h3 class="card-title" style="margin:0;font-size:14px;font-weight:600">Store Status</h3></div>
        <div class="card-body">
          <div class="stats-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">
            <div class="stat-card" style="padding:16px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border)">
              <div style="font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Store URL</div>
              <a href="${esc(storeUrl)}" target="_blank" rel="noopener" style="font-size:13px;font-weight:600;color:var(--s-accent);text-decoration:none;word-break:break-all">${esc(storeUrl)}</a>
            </div>
            <div class="stat-card" style="padding:16px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border)">
              <div style="font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Status</div>
              <div style="font-size:13px">${storeStatus === 'active' ? activeBadge() : inactiveBadge()}</div>
            </div>
            <div class="stat-card" style="padding:16px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border)">
              <div style="font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Custom Domain</div>
              <div style="font-size:13px;font-weight:600;color:var(--s-text)">${customDomain ? esc(customDomain) : '<span style="color:var(--s-text-secondary)">None</span>'}</div>
            </div>
            <div class="stat-card" style="padding:16px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border)">
              <div style="font-size:11px;font-weight:600;color:var(--s-text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">SSL</div>
              <div style="font-size:13px">${activeBadge()}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Links Grid (9 sections — Phase 2B Sprint 1 layout) -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h3 class="card-title" style="margin:0;font-size:14px;font-weight:600">Manage your storefront</h3></div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">

            <!-- 1. Design (replaces old "Themes" as primary entry) -->
            <a href="${base}/online-store/design" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                <div style="display:flex;align-items:center;gap:12px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(99,102,241,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Design</div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">Clone a site or edit your theme</div>
                  </div>
                </div>
              </div>
            </a>

            <!-- 2. Pages -->
            <a href="${base}/online-store/pages" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                <div style="display:flex;align-items:center;gap:12px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(34,197,94,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Pages <span style="color:var(--s-text-secondary);font-weight:400">· ${pageCount}</span></div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">CMS pages (About, Contact, …)</div>
                  </div>
                </div>
              </div>
            </a>

            <!-- 3. Blog posts -->
            <a href="${base}/online-store/blog" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                <div style="display:flex;align-items:center;gap:12px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(234,179,8,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Blog posts <span style="color:var(--s-text-secondary);font-weight:400">· ${blogCount}</span></div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">Articles and news</div>
                  </div>
                </div>
              </div>
            </a>

            <!-- 4. Landing pages (Sprint 3 — stub) -->
            <a href="${base}/online-store/landing" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer;position:relative" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                ${comingSoonBadge()}
                <div style="display:flex;align-items:center;gap:12px;margin-top:8px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(239,68,68,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h7v7H3z"/><path d="M14 3h7v7h-7z"/><path d="M14 14h7v7h-7z"/><path d="M3 14h7v7H3z"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Landing pages</div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">Drag-drop campaign pages</div>
                  </div>
                </div>
              </div>
            </a>

            <!-- 5. Navigation -->
            <a href="${base}/online-store/navigation" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                <div style="display:flex;align-items:center;gap:12px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(168,85,247,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Navigation</div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">Menus and links</div>
                  </div>
                </div>
              </div>
            </a>

            <!-- 6. Preferences -->
            <a href="${base}/online-store/preferences" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                <div style="display:flex;align-items:center;gap:12px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(148,163,184,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Preferences</div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">SEO, favicon, password page</div>
                  </div>
                </div>
              </div>
            </a>

            <!-- 7. Domains -->
            <a href="${base}/online-store/domains" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                <div style="display:flex;align-items:center;gap:12px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(59,130,246,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Domains</div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">Custom domain + Cloudflare SSL</div>
                  </div>
                </div>
              </div>
            </a>

            <!-- 8. Watermark (Sprint 4 — stub) -->
            <a href="${base}/online-store/watermark" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer;position:relative" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                ${comingSoonBadge()}
                <div style="display:flex;align-items:center;gap:12px;margin-top:8px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(20,184,166,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#14b8a6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Watermark</div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">Auto-brand product images</div>
                  </div>
                </div>
              </div>
            </a>

            <!-- 9. Size charts (Sprint 4 — stub) -->
            <a href="${base}/online-store/size-charts" style="text-decoration:none;color:inherit">
              <div class="stat-card" style="padding:20px;border-radius:10px;background:var(--s-card-bg);border:1px solid var(--s-border);transition:border-color .15s;cursor:pointer;position:relative" onmouseover="this.style.borderColor='var(--s-accent)'" onmouseout="this.style.borderColor='var(--s-border)'">
                ${comingSoonBadge()}
                <div style="display:flex;align-items:center;gap:12px;margin-top:8px">
                  <div style="width:40px;height:40px;border-radius:10px;background:rgba(236,72,153,.12);display:flex;align-items:center;justify-content:center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
                  </div>
                  <div>
                    <div style="font-size:14px;font-weight:600">Size charts</div>
                    <div style="font-size:12px;color:var(--s-text-secondary)">Lenful-powered sizing</div>
                  </div>
                </div>
              </div>
            </a>

          </div>
        </div>
      </div>

      <!-- Files stays accessible but demoted to a secondary link -->
      <div style="display:flex;gap:8px;font-size:12px">
        <a href="${base}/online-store/files" style="color:var(--s-text-secondary);text-decoration:none">Files library →</a>
      </div>
    `

    res.send(sellerLayout({
      title: 'Online Store',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'online-store',
      theme,
      content,
    }))
  } catch (err) {
    console.error('getOnlineStoreHub error:', err)
    res.status(500).send('Internal server error')
  }
}

// ---------------------------------------------------------------------------
// GET /online-store/themes — Theme Management
// ---------------------------------------------------------------------------

export async function getThemes(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  try {
    const store = req.store!
    const user = req.storeUser!
    const theme = (req as any).theme || 'dark'
    const base = `/admin/store/${store.slug}`

    // Load real themes from database
    let dbThemes: any[] = []
    try {
      dbThemes = await listThemes(db, store.id)
    } catch { /* graceful — table may not exist yet */ }

    const activeTheme = dbThemes.find((t: any) => t.role === 'main') || dbThemes[0]
    const otherThemes = dbThemes.filter((t: any) => t !== activeTheme)
    const colors = ['#6366f1', '#22c55e', '#ef4444', '#3b82f6', '#8b5cf6', '#f59e0b']

    const themeCards = dbThemes.map((t: any, i: number) => {
      const isActive = t.role === 'main'
      const color = colors[i % colors.length]
      return `
        <div class="card" style="overflow:hidden">
          <div style="height:100px;background:${color};display:flex;align-items:center;justify-content:center">
            <span style="font-size:18px;font-weight:800;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:2px">${esc(t.name || 'Theme')}</span>
          </div>
          <div style="padding:16px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-size:14px;font-weight:600">${esc(t.name || 'Untitled')}</div>
              ${isActive ? activeBadge() : badge('Unpublished', '#6b7280', '#f3f4f6')}
            </div>
            <p style="font-size:12px;color:var(--s-text-secondary);margin:0 0 12px">Role: ${esc(t.role || 'unpublished')}</p>
            <div style="display:flex;gap:6px">
              <a href="${base}/online-store/themes/${esc(t.id)}/editor" class="btn btn-outline btn-sm" style="font-size:11px;text-decoration:none;flex:1;text-align:center">Edit Code</a>
              ${!isActive ? `
                <form method="POST" action="${base}/online-store/themes/${esc(t.id)}/activate" style="margin:0;flex:1">
                  <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
                  <button type="submit" class="btn btn-primary btn-sm" style="font-size:11px;width:100%">Activate</button>
                </form>
              ` : ''}
            </div>
          </div>
        </div>
      `
    }).join('')

    const content = `
      <div style="margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <h1 style="font-size:20px;font-weight:700;margin:0 0 4px">Themes</h1>
            <p style="color:var(--s-text-secondary);font-size:13px;margin:0">${dbThemes.length} theme${dbThemes.length !== 1 ? 's' : ''} installed</p>
          </div>
          <a href="${base}/online-store" class="btn btn-outline btn-sm" style="font-size:12px;text-decoration:none">Back to Online Store</a>
        </div>
      </div>

      ${activeTheme ? `
      <!-- Current Theme -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h3 class="card-title" style="margin:0;font-size:14px;font-weight:600">Current Theme</h3></div>
        <div class="card-body">
          <div style="display:flex;gap:24px;align-items:flex-start">
            <div style="width:200px;height:140px;border-radius:10px;background:#6366f1;display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <span style="font-size:16px;font-weight:800;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:2px">Preview</span>
            </div>
            <div style="flex:1">
              <div style="font-size:18px;font-weight:700;margin-bottom:4px">${esc(activeTheme.name || 'Active Theme')}</div>
              <div style="display:flex;gap:12px;margin-bottom:12px">
                <span style="font-size:12px;color:var(--s-text-secondary)">ID: ${esc(String(activeTheme.id).slice(0, 8))}</span>
                <span style="font-size:12px;color:var(--s-text-secondary)">|</span>
                ${activeBadge()}
              </div>
              <div style="display:flex;gap:8px">
                <a href="${base}/online-store/themes/${esc(activeTheme.id)}/editor" class="btn btn-primary btn-sm" style="font-size:12px;text-decoration:none">Edit Code</a>
                <form method="POST" action="${base}/online-store/themes/${esc(activeTheme.id)}/duplicate" style="margin:0">
                  <input type="hidden" name="_csrf" value="${esc((req as any).csrfToken || '')}" />
                  <button type="submit" class="btn btn-outline btn-sm" style="font-size:12px">Duplicate</button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
      ` : ''}

      <!-- All Themes -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header"><h3 class="card-title" style="margin:0;font-size:14px;font-weight:600">${dbThemes.length > 0 ? 'All Themes' : 'No Themes Installed'}</h3></div>
        <div class="card-body">
          ${dbThemes.length > 0 ? `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px">
              ${themeCards}
            </div>
          ` : `
            <p style="color:var(--s-text-secondary);font-size:13px;text-align:center;padding:32px">
              No themes installed yet. Install a theme to start customizing your storefront.
            </p>
          `}
        </div>
      </div>
    `

    res.send(sellerLayout({
      title: 'Themes',
      storeName: store.name,
      storeSlug: store.slug,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      storeRole: user.storeRole,
      activePage: 'online-store',
      theme,
      content,
    }))
  } catch (err) {
    console.error('getThemes error:', err)
    res.status(500).send('Internal server error')
  }
}
