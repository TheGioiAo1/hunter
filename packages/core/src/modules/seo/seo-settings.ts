/**
 * Gbox Platform — SEO Settings Service (Phase 8 PR3)
 *
 * Per-shop SEO preferences powering:
 *   • Storefront meta-tag defaults (canonical title template, description,
 *     og:image, twitter handle, fb url, google-site-verification).
 *   • Tracking snippet injection (GA4 measurement ID, GTM container ID).
 *   • The `robots_noindex` master kill switch (toggles every storefront
 *     response's `<meta name="robots">` + short-circuits sitemap/robots.txt).
 *   • The cached result of the last `scanShop()` run so the admin
 *     dashboard can render without re-crawling on every page load.
 *
 * Persistence: `shops.seo_settings` JSONB column (migration 064). Shape
 * documented there. Missing keys fall through to `DEFAULT_SEO_SETTINGS`.
 *
 * Tenancy: all entry points take `shopId`; cross-shop isolation is the
 * caller's responsibility at the handler layer.
 *
 * Iron rule 5: this module never emits any seller-facing copy. The admin
 * page that consumes it is responsible for user-facing strings; the
 * service layer just stores/retrieves raw preference values.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row in a scan report. Severity ordering:
 *   - error   → blocks indexing (missing title, missing canonical, 5xx)
 *   - warning → ranking impact (missing meta description, duplicate title)
 *   - info    → nice-to-have (missing alt text, thin content)
 *
 * `code` is a stable enum used by the admin UI to group + style issues;
 * `message` is the human-readable sentence shown to the merchant.
 * Neither is localised yet — we deal with that in a later phase.
 */
export interface SeoScanIssue {
  url: string
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
}

export interface SeoScanReport {
  pages_scanned: number
  score: number // 0–100
  issues: SeoScanIssue[]
}

/**
 * Effective settings after merging the merchant's persisted overrides
 * onto the platform defaults. Every field is non-nullable here so
 * callers in the meta-tags layer don't have to defensively coerce.
 *
 * Distinction from the JSONB shape: the raw column stores `null` where
 * the merchant has cleared a field; the merged type narrows those to
 * `null` (so the meta-tags helper can test `if (s.twitter_handle)`).
 */
export interface SeoSettings {
  default_title_template: string | null
  default_description: string | null
  default_og_image_url: string | null
  twitter_handle: string | null
  facebook_url: string | null
  google_analytics_id: string | null
  google_tag_manager_id: string | null
  google_site_verification: string | null
  robots_noindex: boolean
  last_scan_at: string | null
  last_scan_report: SeoScanReport | null
}

// ---------------------------------------------------------------------------
// Defaults + merge
// ---------------------------------------------------------------------------

export const DEFAULT_SEO_SETTINGS: SeoSettings = {
  default_title_template: null,
  default_description: null,
  default_og_image_url: null,
  twitter_handle: null,
  facebook_url: null,
  google_analytics_id: null,
  google_tag_manager_id: null,
  google_site_verification: null,
  robots_noindex: false,
  last_scan_at: null,
  last_scan_report: null,
}

/**
 * Trim + normalise a string field from the raw JSONB. Returns null when
 * the input is not a non-empty string, so the merged type can stay
 * strictly `string | null`.
 */
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Defensive validator for a scan report persisted inside the JSONB.
 * We do a shallow coerce: bad rows just collapse to an empty report so
 * an old / malformed blob can't crash the admin UI on read.
 */
function coerceScanReport(v: unknown): SeoScanReport | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const pages_scanned = typeof r.pages_scanned === 'number' ? r.pages_scanned : 0
  const score = typeof r.score === 'number' ? Math.max(0, Math.min(100, r.score)) : 0
  const rawIssues = Array.isArray(r.issues) ? r.issues : []
  const issues: SeoScanIssue[] = []
  for (const raw of rawIssues) {
    if (!raw || typeof raw !== 'object') continue
    const i = raw as Record<string, unknown>
    const url = str(i.url)
    const code = str(i.code)
    const message = str(i.message)
    const severity = i.severity
    if (!url || !code || !message) continue
    if (severity !== 'error' && severity !== 'warning' && severity !== 'info') continue
    issues.push({ url, severity, code, message })
  }
  return { pages_scanned, score, issues }
}

/**
 * Pure merge: raw JSONB → effective settings. Shared by the service,
 * the admin form, and the storefront meta-tag helper so they can't
 * drift.
 */
export function mergeSettings(raw: unknown): SeoSettings {
  const out: SeoSettings = { ...DEFAULT_SEO_SETTINGS }
  if (!raw || typeof raw !== 'object') return out

  const r = raw as Record<string, unknown>
  out.default_title_template = str(r.default_title_template)
  out.default_description = str(r.default_description)
  out.default_og_image_url = str(r.default_og_image_url)
  out.twitter_handle = str(r.twitter_handle)
  out.facebook_url = str(r.facebook_url)
  out.google_analytics_id = str(r.google_analytics_id)
  out.google_tag_manager_id = str(r.google_tag_manager_id)
  out.google_site_verification = str(r.google_site_verification)
  if (typeof r.robots_noindex === 'boolean') out.robots_noindex = r.robots_noindex
  out.last_scan_at = str(r.last_scan_at)
  out.last_scan_report = coerceScanReport(r.last_scan_report)
  return out
}

/**
 * Expand a title template against a concrete page. Recognised tokens:
 *   {page_title}     — the page's own <title>
 *   {shop_name}      — the shop's display name
 *   {resource_title} — alias of {page_title} kept for backwards-compat
 *
 * Unknown tokens are left intact so the merchant can spot typos in their
 * template. Callers always pass a non-null template (the meta-tags
 * helper short-circuits first when template is null).
 */
export function applyTitleTemplate(
  template: string,
  vars: { page_title: string; shop_name: string },
): string {
  return template
    .replace(/\{page_title\}/g, vars.page_title)
    .replace(/\{resource_title\}/g, vars.page_title)
    .replace(/\{shop_name\}/g, vars.shop_name)
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function resolveSettings(
  db: Kysely<Database>,
  shopId: string,
): Promise<SeoSettings> {
  const row = await (db as any)
    .selectFrom('shops')
    .where('id', '=', shopId)
    .select('seo_settings')
    .executeTakeFirst()
  return mergeSettings(row?.seo_settings)
}

/**
 * Full-replace persist. Accepts a complete `SeoSettings` object —
 * admin form collects the whole thing, validates, and submits. We
 * don't do partial merge here (that's the merchant form's job) so
 * writes are predictable.
 *
 * Does NOT stamp `last_scan_at` / `last_scan_report`; those are owned
 * by `recordScanReport()` so the admin form can't accidentally wipe
 * a scan result. We preserve the incoming report values if present,
 * but if the caller omits them we leave what's already stored.
 */
export async function setShopSettings(
  db: Kysely<Database>,
  shopId: string,
  next: SeoSettings,
): Promise<SeoSettings> {
  // Load current so we can keep the scan fields the admin form doesn't touch.
  const current = await resolveSettings(db, shopId)

  const toWrite: SeoSettings = {
    ...next,
    last_scan_at: next.last_scan_at ?? current.last_scan_at,
    last_scan_report: next.last_scan_report ?? current.last_scan_report,
  }

  await (db as any)
    .updateTable('shops')
    .set({
      seo_settings: JSON.stringify(toWrite),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', shopId)
    .execute()
  return toWrite
}

/**
 * Persist a scan report without disturbing the merchant's other
 * preferences. Stamps `last_scan_at` to `now` unless the caller
 * provides a specific timestamp (useful for tests).
 */
export async function recordScanReport(
  db: Kysely<Database>,
  shopId: string,
  report: SeoScanReport,
  now: Date = new Date(),
): Promise<SeoSettings> {
  const current = await resolveSettings(db, shopId)
  const merged: SeoSettings = {
    ...current,
    last_scan_at: now.toISOString(),
    last_scan_report: report,
  }
  await (db as any)
    .updateTable('shops')
    .set({
      seo_settings: JSON.stringify(merged),
      updated_at: now.toISOString(),
    })
    .where('id', '=', shopId)
    .execute()
  return merged
}
