/**
 * Store Admin — SEO Settings (Phase 8 PR3d)
 *
 * Seller-facing control surface for the per-shop SEO preferences persisted
 * in `shops.seo_settings` (migration 064):
 *
 *   • **Meta defaults** — title template (with {shop_name}/{page_title}
 *     tokens), meta description, OG image, Twitter handle, Facebook URL.
 *   • **Tracking snippets** — GA4 measurement ID, GTM container ID,
 *     Google Site Verification string. Rendered into `<head>` by
 *     `buildHeadTags()` at storefront request time; the actual validation
 *     regex lives in `head-injection.ts`, so a bad ID here is simply
 *     dropped downstream rather than breaking the theme.
 *   • **robots_noindex** master kill switch — flips crawlability in
 *     `computeCrawlPolicy` + adds `<meta name="robots" content="noindex">`
 *     on every page.
 *   • **Run scan** — fetches the primary domain home + a sample of
 *     products/collections, runs `scanShop()`, stores the report via
 *     `recordScanReport()`, and renders the resulting issues list
 *     below the form. Cap of 30 URLs per scan so a "scan now" click
 *     doesn't hammer the merchant's own origin.
 *
 * Iron rule 5: none of the seller-visible strings mention god-admin,
 * platform config, or internal module names. Error paths resolve to
 * "Please contact Gbox support" when the failure isn't actionable by
 * the merchant (e.g. the shop has no primary domain configured).
 *
 * Route wiring sits in server.ts under `/admin/store/:slug/marketing/seo/*`.
 */

import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'
import { sellerLayout, esc } from '../layouts/seller-layout.js'
import { csrfHiddenField } from '@gbox/core/modules/auth/csrf.js'
import { notify, byActor } from '../lib/notify.js'
import { logSellerAction } from '../middleware/store-auth.js'
import {
  DEFAULT_SEO_SETTINGS,
  recordScanReport,
  resolveSettings,
  setShopSettings,
  type SeoScanReport,
  type SeoSettings,
} from '@gbox/core/modules/seo/seo-settings.js'
import { defaultSeoFetcher, scanShop } from '@gbox/core/modules/seo/scan.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hard cap on URLs per "Run scan" click — protects the merchant's origin. */
const SCAN_URL_CAP = 30

/** Express query-string helper — strings sometimes arrive as arrays. */
function firstStr(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

/**
 * Return the trimmed string or null. Used when turning `<input>` values
 * back into `SeoSettings` — we want empty-string inputs to clear the
 * field, not persist `""`.
 */
function formStrOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Build the sample URL list for a scan: the home page + up to 10
 * published products + up to 10 published collections. Deliberately
 * small — the merchant can re-run the button for a fresh sample; we
 * keep the scan predictable + quick.
 */
async function buildScanUrls(
  db: Kysely<Database>,
  shopId: string,
): Promise<{ baseUrl: string; urls: string[] } | null> {
  // Shop primary domain — no domain means no storefront URL to scan.
  const row = await (db as any)
    .selectFrom('shops')
    .leftJoin('shop_domains', 'shop_domains.id', 'shops.primary_domain_id')
    .where('shops.id', '=', shopId)
    .select(['shop_domains.domain as primary_domain'])
    .executeTakeFirst()
  const domain: string | null = row?.primary_domain ?? null
  if (!domain) return null

  const baseUrl = `https://${domain}`
  const urls: string[] = [`${baseUrl}/`]

  // Published products — status='active' + published_at not null.
  const products = await (db as any)
    .selectFrom('products')
    .where('shop_id', '=', shopId)
    .where('status', '=', 'active')
    .where('published_at', 'is not', null)
    .select('slug')
    .limit(10)
    .execute()
  for (const p of products) {
    if (typeof p.slug === 'string' && p.slug.length > 0) {
      urls.push(`${baseUrl}/products/${encodeURIComponent(p.slug)}`)
    }
  }

  // Published collections.
  const collections = await (db as any)
    .selectFrom('collections')
    .where('shop_id', '=', shopId)
    .where('published', '=', true)
    .select('slug')
    .limit(10)
    .execute()
  for (const c of collections) {
    if (typeof c.slug === 'string' && c.slug.length > 0) {
      urls.push(`${baseUrl}/collections/${encodeURIComponent(c.slug)}`)
    }
  }

  return { baseUrl, urls: urls.slice(0, SCAN_URL_CAP) }
}

/**
 * Render the "last scan report" card. Empty state when no scan has
 * been run yet. Score colour mirrors the abandoned-cart recovery rate
 * card's palette so the dashboard looks consistent.
 */
function renderScanReport(
  report: SeoScanReport | null,
  lastScanAt: string | null,
): string {
  if (!report) {
    return `
      <div class="card" style="margin-top:20px">
        <div class="card-body" style="padding:18px">
          <div style="font-weight:600;font-size:14px;margin-bottom:6px">Last scan</div>
          <div style="font-size:12px;color:var(--s-text-dim)">
            No scan has been run yet. Click "Run scan" to analyse your storefront.
          </div>
        </div>
      </div>`
  }

  const score = report.score
  const scoreColor =
    score >= 80
      ? 'var(--s-success)'
      : score >= 50
        ? 'var(--s-warning)'
        : 'var(--s-danger, #ef4444)'
  const whenLabel = lastScanAt
    ? new Date(lastScanAt).toLocaleString()
    : 'unknown'

  // Group issues by severity for a clean visual hierarchy.
  const errs = report.issues.filter((i) => i.severity === 'error')
  const warns = report.issues.filter((i) => i.severity === 'warning')
  const infos = report.issues.filter((i) => i.severity === 'info')

  const sectionCard = (
    title: string,
    color: string,
    items: typeof report.issues,
  ): string => {
    if (items.length === 0) return ''
    const rows = items
      .map(
        (i) => `
        <div style="padding:10px 12px;border-top:1px solid var(--s-border);font-size:12px">
          <div style="font-weight:500">${esc(i.message)}</div>
          <div style="color:var(--s-text-dim);margin-top:3px;word-break:break-all">${esc(i.url)}</div>
        </div>
      `,
      )
      .join('')
    return `
      <div style="margin-top:14px">
        <div style="font-size:12px;font-weight:600;color:${color};margin-bottom:4px">
          ${esc(title)} (${items.length})
        </div>
        <div style="border:1px solid var(--s-border);border-radius:6px;overflow:hidden">
          ${rows}
        </div>
      </div>
    `
  }

  return `
    <div class="card" style="margin-top:20px">
      <div class="card-body" style="padding:18px">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:12px">
          <div>
            <div style="font-weight:600;font-size:14px">Last scan</div>
            <div style="font-size:12px;color:var(--s-text-dim);margin-top:3px">
              ${esc(String(report.pages_scanned))} page${report.pages_scanned === 1 ? '' : 's'} checked &middot; ${esc(whenLabel)}
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:28px;font-weight:700;color:${scoreColor};line-height:1">${esc(String(score))}</div>
            <div style="font-size:11px;color:var(--s-text-dim);margin-top:2px">SEO score</div>
          </div>
        </div>
        ${sectionCard('Errors', 'var(--s-danger, #ef4444)', errs)}
        ${sectionCard('Warnings', 'var(--s-warning, #eab308)', warns)}
        ${sectionCard('Info', 'var(--s-text-dim)', infos)}
        ${report.issues.length === 0
          ? '<div style="margin-top:10px;font-size:12px;color:var(--s-success)">No issues found on the sampled pages. Nice work.</div>'
          : ''}
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// GET /marketing/seo/settings
// ---------------------------------------------------------------------------

export async function getSeoSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const theme = (req as any).theme || 'dark'
  const base = `/admin/store/${esc(store.slug)}`
  const csrfToken = req.csrfToken || ''

  // Cross-package Kysely drift — see CLAUDE-EXTENDED.md. `db as any` at
  // the callsite is the sanctioned workaround.
  const settings = await resolveSettings(db as any, store.id)

  const ok = firstStr(req.query.ok) || ''
  const err = firstStr(req.query.err) || ''

  // Input helper — empty null becomes an empty string, trailing null-safe.
  const val = (s: string | null): string => (s === null ? '' : esc(s))

  const content = `
    <div class="page-header">
      <div>
        <a href="${base}/marketing/seo" style="color:var(--s-text-dim);text-decoration:none;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:4px">
          &larr; SEO overview
        </a>
        <h1 class="page-title">SEO settings</h1>
        <p class="page-subtitle">Search engine defaults and tracking snippets for <strong>${esc(store.name)}</strong>.</p>
      </div>
    </div>

    ${ok ? `<div class="alert alert-success" style="margin-bottom:16px">${esc(decodeURIComponent(ok))}</div>` : ''}
    ${err ? `<div class="alert alert-error" style="margin-bottom:16px">${esc(decodeURIComponent(err))}</div>` : ''}

    <form id="seo-settings-form"
      method="POST"
      action="${base}/marketing/seo/settings"
      style="margin-bottom:24px">
      ${csrfHiddenField(csrfToken)}

      <!-- META DEFAULTS -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-body" style="padding:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 14px 0">Meta defaults</h3>

          <div style="margin-bottom:14px">
            <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Title template</label>
            <input type="text"
              name="default_title_template"
              value="${val(settings.default_title_template)}"
              placeholder="{page_title} &ndash; {shop_name}"
              class="form-input"
              style="width:100%" />
            <div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">
              Tokens: <code>{page_title}</code>, <code>{shop_name}</code>.
              Leave blank to use each page's own title.
            </div>
          </div>

          <div style="margin-bottom:14px">
            <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Default description</label>
            <textarea name="default_description"
              rows="3"
              placeholder="Short description shown on search-engine result pages."
              class="form-input"
              style="width:100%;font-family:inherit">${val(settings.default_description)}</textarea>
            <div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">
              Used when a specific page has no meta description. Aim for 120&ndash;160 characters.
            </div>
          </div>

          <div style="margin-bottom:14px">
            <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Default social share image (OG)</label>
            <input type="url"
              name="default_og_image_url"
              value="${val(settings.default_og_image_url)}"
              placeholder="https://cdn.example.com/og-default.jpg"
              class="form-input"
              style="width:100%" />
            <div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">
              Recommended size: 1200&times;630. Used as a fallback when a specific page has no image.
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Twitter handle</label>
              <input type="text"
                name="twitter_handle"
                value="${val(settings.twitter_handle)}"
                placeholder="@yourshop"
                class="form-input"
                style="width:100%" />
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Facebook page URL</label>
              <input type="url"
                name="facebook_url"
                value="${val(settings.facebook_url)}"
                placeholder="https://www.facebook.com/yourshop"
                class="form-input"
                style="width:100%" />
            </div>
          </div>
        </div>
      </div>

      <!-- TRACKING -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-body" style="padding:18px">
          <h3 style="font-size:14px;font-weight:600;margin:0 0 14px 0">Analytics &amp; tracking</h3>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Google Analytics 4 measurement ID</label>
              <input type="text"
                name="google_analytics_id"
                value="${val(settings.google_analytics_id)}"
                placeholder="G-XXXXXXXXXX"
                class="form-input"
                style="width:100%;font-family:monospace" />
              <div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">
                Format: <code>G-</code> plus 10 letters/digits.
              </div>
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Google Tag Manager container ID</label>
              <input type="text"
                name="google_tag_manager_id"
                value="${val(settings.google_tag_manager_id)}"
                placeholder="GTM-XXXXXX"
                class="form-input"
                style="width:100%;font-family:monospace" />
              <div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">
                Format: <code>GTM-</code> plus 6&ndash;10 letters/digits.
              </div>
            </div>
          </div>

          <div>
            <label style="display:block;font-size:12px;font-weight:500;margin-bottom:4px">Google Site Verification token</label>
            <input type="text"
              name="google_site_verification"
              value="${val(settings.google_site_verification)}"
              placeholder="Paste the token from Search Console"
              class="form-input"
              style="width:100%;font-family:monospace" />
            <div style="font-size:11px;color:var(--s-text-dim);margin-top:4px">
              Alphanumeric + dashes/underscores, 10&ndash;200 characters. Values that don't match are ignored.
            </div>
          </div>
        </div>
      </div>

      <!-- INDEXING -->
      <div class="card" style="margin-bottom:16px">
        <div class="card-body" style="padding:18px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
            <div>
              <div style="font-weight:600;font-size:14px">Hide from search engines</div>
              <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">
                When on, every storefront page renders <code>noindex, nofollow</code>
                and the sitemap / robots.txt respond as closed.
                Use this while the store is in preview or under maintenance.
              </div>
            </div>
            <label style="position:relative;width:44px;height:24px;cursor:pointer;flex-shrink:0">
              <input type="checkbox" name="robots_noindex" value="1" ${settings.robots_noindex ? 'checked' : ''} style="opacity:0;width:0;height:0;position:absolute" />
              <div style="position:absolute;inset:0;border-radius:12px;background:${settings.robots_noindex ? 'rgba(239,68,68,.8)' : 'var(--s-border)'};transition:background .2s">
                <div style="position:absolute;top:2px;${settings.robots_noindex ? 'right:2px' : 'left:2px'};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:all .2s"></div>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:10px">
        <button type="submit" class="btn btn-primary">Save changes</button>
        <a href="${base}/marketing/seo" class="btn btn-outline">Cancel</a>
      </div>
    </form>

    <!-- RUN SCAN — separate form so "Save changes" and "Run scan" buttons
         submit to different endpoints. Save and scan are intentionally
         independent: you don't have to save your form edits before
         scanning the currently-published storefront. -->
    <form method="POST" action="${base}/marketing/seo/scan">
      ${csrfHiddenField(csrfToken)}
      <div class="card">
        <div class="card-body" style="padding:18px;display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div>
            <div style="font-weight:600;font-size:14px">Run SEO scan now</div>
            <div style="font-size:12px;color:var(--s-text-dim);margin-top:4px">
              Crawls your home page plus a sample of up to 20 products and collections,
              then shows every issue (missing title, duplicate title, missing alt text,
              404s, etc.) found on the live storefront. Takes a few seconds.
            </div>
          </div>
          <button type="submit" class="btn btn-outline">Run scan</button>
        </div>
      </div>
    </form>

    ${renderScanReport(settings.last_scan_report, settings.last_scan_at)}
  `

  res.send(sellerLayout({
    title: 'SEO settings',
    storeName: store.name,
    storeSlug: store.slug,
    userName: user.name,
    userEmail: user.email,
    userRole: user.role,
    storeRole: user.storeRole,
    activePage: 'marketing',
    content,
    theme: theme as 'dark' | 'light',
  }))
}

// ---------------------------------------------------------------------------
// POST /marketing/seo/settings
// ---------------------------------------------------------------------------

export async function postSeoSettings(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  try {
    const body = req.body as Record<string, unknown>

    // All 9 string fields trim-then-null. `robots_noindex` is a checkbox.
    const next: SeoSettings = {
      ...DEFAULT_SEO_SETTINGS,
      default_title_template: formStrOrNull(body.default_title_template),
      default_description: formStrOrNull(body.default_description),
      default_og_image_url: formStrOrNull(body.default_og_image_url),
      twitter_handle: formStrOrNull(body.twitter_handle),
      facebook_url: formStrOrNull(body.facebook_url),
      google_analytics_id: formStrOrNull(body.google_analytics_id),
      google_tag_manager_id: formStrOrNull(body.google_tag_manager_id),
      google_site_verification: formStrOrNull(body.google_site_verification),
      robots_noindex:
        body.robots_noindex === '1' ||
        body.robots_noindex === 'on' ||
        body.robots_noindex === true,
      // `setShopSettings` preserves these automatically — passing null
      // explicitly tells it to keep the currently-stored values.
      last_scan_at: null,
      last_scan_report: null,
    }

    await setShopSettings(db as any, store.id, next)

    logSellerAction(db, req, 'update', 'settings', 'seo_settings', {
      robots_noindex: next.robots_noindex,
      ga_set: !!next.google_analytics_id,
      gtm_set: !!next.google_tag_manager_id,
    }).catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'app_installed',
      title: 'SEO settings updated',
      message: byActor(user),
      resourceType: 'settings',
      resourceId: null,
    })

    const okMsg = encodeURIComponent('SEO settings saved.')
    res.redirect(`${base}/marketing/seo/settings?ok=${okMsg}`)
  } catch (e) {
    console.error('[seo-settings] save failed:', e)
    const errMsg = encodeURIComponent(
      'Failed to save settings. Please try again or contact Gbox support.',
    )
    res.redirect(`${base}/marketing/seo/settings?err=${errMsg}`)
  }
}

// ---------------------------------------------------------------------------
// POST /marketing/seo/scan
//
// Fetches the primary domain home + sample products/collections,
// runs scanShop, persists the report via recordScanReport, and
// redirects back to the settings page (where the report card renders
// the result).
//
// Safety:
//   - SCAN_URL_CAP protects against someone pointing this at a shop with
//     10k products (scan is serial + fetches hit the merchant's own origin).
//   - scanShop never throws per page — transport failures become
//     `fetch_failed` issues in the report.
//   - Iron rule 5: if the shop has no primary domain we say "Please set
//     a primary domain first" instead of leaking the domain-config path.
// ---------------------------------------------------------------------------

export async function postSeoScan(
  req: Request,
  res: Response,
  db: Kysely<Database>,
): Promise<void> {
  const store = req.store!
  const user = req.storeUser!
  const base = `/admin/store/${store.slug}`

  try {
    const sample = await buildScanUrls(db as any, store.id)
    if (!sample) {
      const errMsg = encodeURIComponent(
        'Please set a primary domain for your storefront before running a scan.',
      )
      res.redirect(`${base}/marketing/seo/settings?err=${errMsg}`)
      return
    }

    const report = await scanShop({
      urls: sample.urls,
      fetcher: defaultSeoFetcher,
      maxUrls: SCAN_URL_CAP,
    })

    await recordScanReport(db as any, store.id, report)

    logSellerAction(db, req, 'run', 'seo_scan', store.id, {
      pages_scanned: report.pages_scanned,
      score: report.score,
      issues: report.issues.length,
    }).catch(() => {})

    notify(db, {
      shopId: store.id,
      userId: user.id,
      type: 'app_installed',
      title: `SEO scan complete — score ${report.score}`,
      message: `${report.pages_scanned} pages checked, ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'} found. ${byActor(user)}`,
      resourceType: 'seo_scan',
      resourceId: null,
    })

    const okMsg = encodeURIComponent(
      `Scan complete. Score: ${report.score}/100, ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'} found.`,
    )
    res.redirect(`${base}/marketing/seo/settings?ok=${okMsg}`)
  } catch (e) {
    console.error('[seo-settings] scan failed:', e)
    const errMsg = encodeURIComponent(
      'The scan could not complete. Please try again or contact Gbox support.',
    )
    res.redirect(`${base}/marketing/seo/settings?err=${errMsg}`)
  }
}
