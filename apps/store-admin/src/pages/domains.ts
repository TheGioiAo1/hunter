/**
 * Store Admin — Online Store > Domains
 *
 * API-mode: quản lý domain qua Shop API (API_SHOP_BASE_URL).
 * - shop.public_domain = custom domain seller đã kết nối
 * - Không dùng DB trực tiếp.
 *
 * Routes:
 *   GET  /online-store/domains          — render trang
 *   POST /online-store/domains          — thêm/đổi custom domain
 *   POST /online-store/domains/remove   — xoá custom domain
 */

import type { Request, Response } from 'express'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { createApiContext, getShopDetail, setPublicDomain, deletePublicDomain, ProductApiError } from '../lib/shop-detail-api-client.js'

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

function pill(
  text: string,
  opts: { bg: string; fg: string; weight?: string },
): string {
  return `<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:${
    opts.weight ?? '600'
  };background:${opts.bg};color:${opts.fg}">${esc(text)}</span>`
}

function alertBanner(kind: 'success' | 'error', msg: string): string {
  if (!msg) return ''
  const isOk = kind === 'success'
  const color = isOk ? '#22c55e' : '#ef4444'
  const bg = isOk ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)'
  const border = isOk ? 'rgba(34,197,94,.25)' : 'rgba(239,68,68,.25)'
  const iconPath = isOk
    ? '<path d="M4 8l3 3 5-5"/><circle cx="8" cy="8" r="7"/>'
    : '<circle cx="8" cy="8" r="7"/><path d="M8 4v5M8 11v1"/>'
  return `<div style="margin-bottom:16px;padding:12px 16px;border-radius:10px;background:${bg};border:1px solid ${border};color:${color};font-size:13px;font-weight:500;display:flex;align-items:center;gap:8px">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">${iconPath}</svg>
    ${esc(msg)}
  </div>`
}

function renderTabLink(opts: {
  href: string
  label: string
  active: boolean
}): string {
  const color = opts.active ? 'var(--s-accent)' : 'var(--s-text-secondary)'
  const weight = opts.active ? '600' : '500'
  const border = opts.active
    ? 'border-bottom:2px solid var(--s-accent);margin-bottom:-1px'
    : 'border-bottom:2px solid transparent;margin-bottom:-1px'
  return `
    <a href="${opts.href}"
       style="padding:10px 16px;font-size:13px;font-weight:${weight};color:${color};text-decoration:none;${border}">
      ${esc(opts.label)}
    </a>
  `
}

// ---------------------------------------------------------------------------
// Tab: Shop subdomain (read-only)
// ---------------------------------------------------------------------------

function renderShopSubdomainTab(opts: {
  slug: string
  createdAt?: string | null
}): string {
  const url = `https://${esc(opts.slug)}.gbox.co`
  return `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--s-border)">
        <span style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.05em">Domain</span>
        <span style="font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.05em">Status</span>
      </div>
      <div style="padding:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--s-text-secondary);flex-shrink:0">
            <circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.5 1.8 2.4 3.9 2.4 6s-.9 4.2-2.4 6M8 2c-1.5 1.8-2.4 3.9-2.4 6s.9 4.2 2.4 6"/>
          </svg>
          <div>
            <div style="font-family:monospace;font-size:14px;font-weight:600">${esc(opts.slug)}.gbox.co</div>
            <div style="font-size:11px;color:var(--s-text-secondary);margin-top:2px">Default subdomain · Cannot be removed</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <a href="${url}" target="_blank" rel="noopener noreferrer"
             style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--s-text-secondary);text-decoration:none">
            Open
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h8v8M14 2L6 10M2 6v8h8"/></svg>
          </a>
          <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:9999px;font-size:12px;font-weight:500;background:rgba(34,197,94,.12);color:#22c55e">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4"/></svg>
            Connected
          </span>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div style="padding:16px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div>
          <div style="font-size:14px;font-weight:600;margin-bottom:4px">Want a branded URL?</div>
          <div style="font-size:13px;color:var(--s-text-secondary)">
            Connect your own domain (e.g. <code style="padding:1px 5px;background:var(--s-input-bg);border-radius:4px;font-size:12px">www.mystore.com</code>)
            to make your storefront accessible from a custom URL.
          </div>
        </div>
        <a href="?tab=custom" class="btn btn-outline btn-sm" style="white-space:nowrap;font-size:12px">
          Connect existing domain →
        </a>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Tab: Custom domain
// ---------------------------------------------------------------------------

function renderCustomDomainTab(opts: {
  base: string
  csrfToken: string
  customDomain: string | null
}): string {
  const csrfField = csrfHiddenField(opts.csrfToken)

  if (!opts.customDomain) {
    return `
      ${renderAddDomainCard(opts.base, csrfField)}
      <div class="card">
        <div style="text-align:center;padding:48px 20px">
          <div style="width:48px;height:48px;border-radius:50%;background:var(--s-input-bg);display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
            <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--s-text-secondary)">
              <circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.5 1.8 2.4 3.9 2.4 6s-.9 4.2-2.4 6M8 2c-1.5 1.8-2.4 3.9-2.4 6s.9 4.2 2.4 6"/>
            </svg>
          </div>
          <div style="font-size:14px;font-weight:600;margin-bottom:6px">No custom domain yet</div>
          <div style="font-size:13px;color:var(--s-text-secondary);max-width:320px;margin:0 auto">
            Connect a domain you own to make your store accessible at a branded URL.
          </div>
        </div>
      </div>
    `
  }

  return `
    ${renderAddDomainCard(opts.base, csrfField, opts.customDomain)}

    <div class="card">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid var(--s-border)">
              <th style="text-align:left;padding:12px 16px;font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.05em">Domain</th>
              <th style="text-align:right;padding:12px 16px;font-size:12px;font-weight:600;color:var(--s-text-secondary);text-transform:uppercase;letter-spacing:.05em">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding:14px 16px;vertical-align:middle">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--s-text-secondary);flex-shrink:0">
                    <circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.5 1.8 2.4 3.9 2.4 6s-.9 4.2-2.4 6M8 2c-1.5 1.8-2.4 3.9-2.4 6s.9 4.2 2.4 6"/>
                  </svg>
                  <span style="font-family:monospace;font-size:14px;font-weight:600">${esc(opts.customDomain)}</span>
                  ${pill('Primary', { bg: 'rgba(99,102,241,.15)', fg: '#6366f1', weight: '700' })}
                </div>
              </td>
              <td style="padding:14px 16px;vertical-align:middle;text-align:right">
                <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px">
                  <a href="https://${esc(opts.customDomain)}" target="_blank" rel="noopener noreferrer"
                     style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--s-text-secondary);text-decoration:none">
                    Open
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h8v8M14 2L6 10M2 6v8h8"/></svg>
                  </a>
                  <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:9999px;font-size:12px;font-weight:500;background:rgba(34,197,94,.12);color:#22c55e">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4"/></svg>
                    Connected
                  </span>
                  <form method="POST" action="${opts.base}/online-store/domains/remove" style="display:inline"
                    onsubmit="return confirm('Remove ${esc(opts.customDomain)}?')">
                    ${csrfField}
                    <button type="submit" class="btn btn-outline btn-sm"
                      style="color:var(--s-danger);border-color:var(--s-danger);font-size:11px;padding:4px 10px">
                      Remove
                    </button>
                  </form>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `
}

function renderAddDomainCard(base: string, csrfField: string, currentDomain?: string): string {
  const isEdit = !!currentDomain
  return `
    <div class="card" id="add-domain" style="margin-bottom:16px">
      <div style="padding:16px;border-bottom:1px solid var(--s-border)">
        <h3 style="margin:0;font-size:14px;font-weight:600">
          ${isEdit ? 'Change domain' : 'Connect existing domain'}
        </h3>
        <p style="margin:6px 0 0;font-size:13px;color:var(--s-text-secondary)">
          ${isEdit
            ? 'Enter a new domain to replace the current one.'
            : "Enter a domain you already own. Point your DNS to this store first, then connect."}
        </p>
      </div>
      <div style="padding:16px">
        <form method="POST" action="${base}/online-store/domains" style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
          ${csrfField}
          <div style="flex:1;min-width:240px">
            <input type="text" name="domain"
              placeholder="example.com or www.mystore.com"
              value="${isEdit ? esc(currentDomain!) : ''}"
              required
              pattern="^(?:[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,}$"
              style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--s-border);border-radius:8px;font-size:13px;background:var(--s-input-bg);color:var(--s-text);outline:none">
          </div>
          <button type="submit" class="btn btn-primary" style="white-space:nowrap">
            ${isEdit ? 'Update domain' : 'Add domain'}
          </button>
        </form>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// GET /online-store/domains
// ---------------------------------------------------------------------------

export async function getDomains(req: Request, res: Response): Promise<void> {
  try {
    const store = req.store!
    const user = req.storeUser!
    const theme = (req as any).theme || 'dark'
    const base = `/admin/store/${store.slug}`
    const csrfToken = req.csrfToken!

    const successMsg = ((req.query.success as string) || '').trim()
    const errorMsg = ((req.query.error as string) || '').trim()
    const activeTab = String(req.query.tab ?? 'shop') === 'custom' ? 'custom' : 'shop'

    // Fetch custom domain từ Shop API
    let customDomain: string | null = null
    try {
      const ctx = createApiContext(req)
      const shop = await getShopDetail(ctx)
      const raw = shop?.public_domain ?? ''
      // Chỉ lấy nếu khác subdomain mặc định
      customDomain = raw && !raw.endsWith('.gbox.co') ? raw : null
    } catch {
      // API lỗi → vẫn render page với empty state
    }

    const shopTab = renderShopSubdomainTab({ slug: store.slug })
    const customTab = renderCustomDomainTab({ base, csrfToken, customDomain })

    const content = `
      <!-- Page header -->
      <div style="margin-bottom:24px">
        <div style="margin-bottom:8px">
          <a href="${base}/online-store"
             style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--s-text-secondary);text-decoration:none">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4L6 8l4 4"/></svg>
            Online Store
          </a>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <h1 style="font-size:22px;font-weight:700;margin:0">Domains</h1>
          <a href="${base}/online-store/domains?tab=custom#add-domain"
             class="btn btn-primary" style="white-space:nowrap;font-size:13px">
            Connect existing domain
          </a>
        </div>
      </div>

      ${alertBanner('success', successMsg)}
      ${alertBanner('error', errorMsg)}

      <!-- Tab switcher -->
      <div style="display:flex;gap:0;border-bottom:1px solid var(--s-border);margin-bottom:24px">
        ${renderTabLink({ href: `${base}/online-store/domains?tab=shop`, label: 'Shop subdomain', active: activeTab === 'shop' })}
        ${renderTabLink({ href: `${base}/online-store/domains?tab=custom`, label: `Custom domain${customDomain ? ' (1)' : ''}`, active: activeTab === 'custom' })}
      </div>

      <div id="domains-tab">
        ${activeTab === 'shop' ? shopTab : customTab}
      </div>
    `

    res.send(
      sellerLayout({
        title: 'Domains',
        storeName: store.name,
        storeSlug: store.slug,
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
        storeRole: user.storeRole,
        activePage: 'domains',
        content,
        theme: theme as 'dark' | 'light',
      }),
    )
  } catch (err) {
    console.error('[domains] getDomains error:', err)
    res.status(500).send('Internal server error')
  }
}

// ---------------------------------------------------------------------------
// POST /online-store/domains — Add / update custom domain
// ---------------------------------------------------------------------------

export async function postAddDomain(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store/domains`
  const redirectTo = `${base}?tab=custom`

  const rawDomain = ((req.body.domain as string) || '').trim().toLowerCase().replace(/^https?:\/\//, '')

  if (!rawDomain || !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(rawDomain)) {
    res.redirect(`${redirectTo}&error=${encodeURIComponent('Invalid domain format. Enter e.g. www.mystore.com')}`)
    return
  }

  if (rawDomain.endsWith('.gbox.co')) {
    res.redirect(`${redirectTo}&error=${encodeURIComponent('gbox.co subdomains are reserved. Use a custom domain.')}`)
    return
  }

  try {
    const ctx = createApiContext(req)
    const result = await setPublicDomain(ctx, rawDomain)
    if (!result.status) {
      const msg = result.message || 'Failed to connect domain. Please try again.'
      res.redirect(`${redirectTo}&error=${encodeURIComponent(msg)}`)
      return
    }
    res.redirect(`${redirectTo}&success=${encodeURIComponent(`Domain ${rawDomain} connected successfully.`)}`)
  } catch (err) {
    console.error('[domains] postAddDomain error:', err)
    const msg = err instanceof ProductApiError
      ? ((err.body as any)?.message ?? 'Failed to connect domain. Please try again.')
      : 'Failed to connect domain. Please try again.'
    res.redirect(`${redirectTo}&error=${encodeURIComponent(msg)}`)
  }
}

// ---------------------------------------------------------------------------
// POST /online-store/domains/remove — Remove custom domain
// ---------------------------------------------------------------------------

export async function postRemoveDomain(req: Request, res: Response): Promise<void> {
  const store = req.store!
  const base = `/admin/store/${store.slug}/online-store/domains`
  const redirectTo = `${base}?tab=custom`

  try {
    const ctx = createApiContext(req)
    await deletePublicDomain(ctx)
    res.redirect(`${redirectTo}&success=${encodeURIComponent('Custom domain removed.')}`)
  } catch (err) {
    console.error('[domains] postRemoveDomain error:', err)
    const msg = err instanceof ProductApiError
      ? ((err.body as any)?.message ?? 'Failed to remove domain. Please try again.')
      : 'Failed to remove domain. Please try again.'
    res.redirect(`${redirectTo}&error=${encodeURIComponent(msg)}`)
  }
}
