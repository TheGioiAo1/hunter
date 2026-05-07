/**
 * Clone Pro v4 — Phase 2 (Execution) Orchestrator
 *
 * Consumes a Phase 1 `DiscoveryResult` and produces a cloned storefront in
 * the target shop. Unlike v3's 10-stage linear pipeline, v4 is driven by the
 * discovery output: every template, every asset, every content row is keyed
 * to something Phase 1 already found and classified.
 *
 * Sub-steps implemented here:
 *   2.1 Global Asset Download     — downloadAllAssets over the homepage HTML
 *   2.3 Layout Template           — cloneHomepage → header/footer/theme.liquid
 *   2.4 Per-Page-Type Cloning     — htmlToLiquid() for each detected template
 *   2.5 Content Import            — persistClonePages / BlogPosts / Collections
 *   2.6 Media Download            — piggy-backs on 2.1 asset download
 *   2.7 URL Rewriting             — rewriteUrlsToLocal over every template
 *   persistDynamicTheme           — writes everything to the `themes` table
 *
 * What's NOT in this sprint (tracked for follow-ups):
 *   2.2 Shared Component Extraction (header/footer are pulled from homepage
 *       for now; dedicated component detection across pages is v4.1)
 *   product import (Shopify-v3 path handles that via `cloneWebsite`; v4
 *       uses discovery.pages to import pages/collections/blog only)
 *
 * Contract:
 *   - Fire-and-forget safe — throws only for programmer errors; runtime
 *     failures are captured in `ExecutionResult.errors[]` and the pipeline
 *     continues. Callers (runner.ts) decide whether partial success counts
 *     as `succeeded` or `failed`.
 *   - Idempotent — re-running on the same shop/discovery replaces the
 *     theme. Content uses slug-based upsert so re-runs don't dupe pages.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { DiscoveryResult, CloneV4Callbacks } from './pipeline-v4.js'
import type { CloneProConfig } from './types.js'
import type { DetectedTemplate } from './discovery/template-detector.js'
import type { DiscoveredPage } from './discovery/deep-crawler.js'

import { htmlToLiquid, type TemplateChange } from './html-to-liquid.js'
import { downloadAllAssets, rewriteUrlsToLocal, cloneHomepage } from './scrapers/index.js'
import { persistDynamicTheme } from './theme-gen/persist-theme.js'
import { persistClonePages } from './persist/persist-pages.js'
import { persistCloneBlogPosts } from './persist/persist-blog.js'
import { persistCloneCollections } from './persist/persist-collections.js'
import { composeIndexJson } from './section-mapper/index.js'
import { getGboxDawnAsset } from '../themes/seed/gbox-dawn-bundle.js'
import type { ScrapedPage, ScrapedBlogPost, ScrapedCollection } from './scrapers/index.js'
import type { PageType as CrawlerPageType } from './discovery/deep-crawler.js'

/** Mapping from deep-crawler `PageType` → page-scraper `PageType`. */
type ScraperStaticPageType =
  | 'about'
  | 'contact'
  | 'policy'
  | 'faq'
  | 'terms'
  | 'shipping'
  | 'refund'
  | 'custom'

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  readonly themeId: string | null
  readonly templatesWritten: number
  readonly assetsDownloaded: number
  readonly assetsFailed: number
  readonly totalAssetBytes: number
  readonly pagesImported: number
  readonly blogPostsImported: number
  readonly collectionsImported: number
  /**
   * How many Gbox Dawn composable sections (hero / featured-collection
   * / image-with-text / newsletter) the section mapper recognised on
   * the source homepage. 0 means we fell back to seed defaults.
   */
  readonly homepageSectionsDetected: number
  readonly templateChanges: readonly { readonly templateName: string; readonly changes: readonly TemplateChange[] }[]
  readonly warnings: readonly string[]
  readonly errors: readonly ExecutionError[]
  readonly durationMs: number
}

export interface ExecutionError {
  readonly step: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run Phase 2 (Execution) — turn a discovery result into a cloned storefront.
 *
 * Progress is emitted on `cb.onProgress` with 0–100% spanning the whole
 * execution phase. The caller is expected to remap this into its own
 * progress band (the v3 pipeline's runner already handles this).
 */
export async function runExecution(
  db: Kysely<Database>,
  config: CloneProConfig,
  discovery: DiscoveryResult,
  cb?: CloneV4Callbacks,
): Promise<ExecutionResult> {
  const started = Date.now()
  const shopId = config.shopId
  const errors: ExecutionError[] = []
  const warnings: string[] = []
  const templateChanges: { templateName: string; changes: readonly TemplateChange[] }[] = []

  cb?.onPhaseUpdate?.('execution', 'running', 'Starting execution phase...')
  cb?.onProgress?.(0, 'Execution: preparing theme assets...')

  // ── 2.1/2.6 Global Asset Download ────────────────────────────────
  // We run `downloadAllAssets` against the homepage because its URL-scan
  // coverage is the widest of any single page (nav, hero, featured sections,
  // footer — they all live there). Other pages referencing the same CDN URLs
  // will share the rewrite map and won't re-download.
  const homepage = pickHomepage(discovery.pages, config.sourceUrl)
  let rewriteMap = new Map<string, string>()
  let assetsDownloaded = 0
  let assetsFailed = 0
  let totalAssetBytes = 0

  if (homepage && config.ingestMedia !== false) {
    cb?.onProgress?.(5, 'Execution: downloading global assets...')
    try {
      const download = await downloadAllAssets(homepage.html, config.sourceUrl, shopId, {
        maxConcurrency: 5,
        maxFileSize: 10 * 1024 * 1024,
      })
      rewriteMap = download.rewriteMap
      assetsDownloaded = download.stats.downloaded
      assetsFailed = download.stats.failed
      totalAssetBytes = download.stats.totalBytes
      cb?.onProgress?.(
        25,
        `Execution: downloaded ${assetsDownloaded} assets (${Math.round(totalAssetBytes / 1024)} KB)`,
      )
    } catch (err) {
      errors.push({ step: '2.1-assets', message: (err as Error).message })
      cb?.onError?.('execution', err as Error)
    }
  } else if (!homepage) {
    warnings.push('No homepage in discovery.pages — skipping global asset download.')
  }

  // ── 2.3 Layout Template (header / footer / theme.liquid) ─────────
  // Reuse the existing homepage-cloner for the layout split. It emits a
  // layout.liquid with {{ content_for_layout }} + separate header/footer
  // section snippets — exactly what the v4 themed templates plug into.
  const templates: Record<string, string> = {}
  let layoutOk = false

  if (homepage) {
    cb?.onProgress?.(30, 'Execution: extracting layout + header/footer...')
    try {
      const layout = cloneHomepage(homepage.html, config.sourceUrl)
      templates['layout/theme.liquid'] = layout.layoutTemplate
      templates['sections/header.liquid'] = wrapSectionSchema('header', layout.headerHtml)
      templates['sections/footer.liquid'] = wrapSectionSchema('footer', layout.footerHtml)
      templates['templates/index.liquid'] = layout.indexTemplate
      // Persist each Shopify-style section the homepage cloner extracted.
      for (const section of layout.sections) {
        templates[`sections/${section.id}.liquid`] = wrapSectionSchema(section.id, section.html)
      }
      layoutOk = true
    } catch (err) {
      errors.push({ step: '2.3-layout', message: (err as Error).message })
      cb?.onError?.('execution', err as Error)
    }
  }

  // ── 2.3b Semantic Section Mapping → Gbox Dawn index.json ─────────
  // Build a Shopify-style templates/index.json by semantically matching
  // homepage blocks to Gbox Dawn's composable sections (hero /
  // featured-collection / image-with-text / newsletter). Also seeds the
  // referenced Dawn section files so the storefront can render them.
  //
  // This runs alongside the cloneHomepage output — Shopify's convention
  // is that .json takes precedence over .liquid, so storefronts get the
  // schema-driven sections and merchants can edit them via the theme
  // editor. templates/index.liquid stays as a readable fallback.
  let homepageSectionsDetected = 0
  if (homepage && layoutOk) {
    cb?.onProgress?.(35, 'Execution: mapping homepage to Gbox Dawn sections...')
    try {
      const composed = composeIndexJson({
        homepageHtml: homepage.html,
        baseUrl: config.sourceUrl,
      })
      homepageSectionsDetected = composed.detected.length
      templates['templates/index.json'] = JSON.stringify(composed.indexJson, null, 2)

      // Seed every Dawn section referenced by the composed index.json.
      // Some of these may clash with cloneHomepage's raw section output
      // (e.g. a `sections/hero.liquid` baked from source HTML); the
      // schema-driven Dawn version wins so settings round-trip through
      // the admin editor cleanly.
      for (const sectionId of composed.indexJson.order) {
        const key = `sections/${sectionId}.liquid`
        const dawn = getGboxDawnAsset(key)
        if (dawn) templates[key] = dawn.source
      }

      if (composed.fellBackToDefaults) {
        warnings.push(
          'Homepage section mapping: no recognisable sections — using Gbox Dawn defaults.',
        )
      }
    } catch (err) {
      errors.push({ step: '2.3b-section-map', message: (err as Error).message })
      cb?.onError?.('execution', err as Error)
    }
  }

  // ── 2.4 Per-Page-Type Cloning (Scrape → Templatize) ──────────────
  cb?.onProgress?.(40, 'Execution: templatizing detected pages...')
  for (const [idx, tpl] of discovery.templates.templates.entries()) {
    // Skip 'home' — cloneHomepage already emitted templates/index.liquid.
    // Also skip templates that we've already produced via the homepage path.
    if (tpl.pageType === 'home' && templates['templates/index.liquid']) continue

    try {
      const result = htmlToLiquid(tpl.samplePage.html, tpl.pageType as CrawlerPageType, {
        sourceUrl: config.sourceUrl,
        keepHeaderFooter: false,
      })
      // Wrap the body fragment inside the layout's content slot. layout.liquid
      // already renders <html>/<head>/<body> + header/footer, so each
      // templates/*.liquid just needs the body-fragment content.
      templates[tpl.templateName] = result.template
      templateChanges.push({ templateName: tpl.templateName, changes: result.changes })
      for (const w of result.warnings) warnings.push(`[${tpl.templateName}] ${w}`)
    } catch (err) {
      errors.push({
        step: `2.4-templatize:${tpl.pageType}`,
        message: (err as Error).message,
      })
    }

    // Smooth progress across templates (40–60%)
    const pct = 40 + Math.round(((idx + 1) / discovery.templates.templates.length) * 20)
    cb?.onProgress?.(Math.min(60, pct), `Execution: templatized ${tpl.pageType} (${tpl.templateName})`)
  }

  // ── 2.7 URL Rewriting (global asset URLs → local paths) ──────────
  if (rewriteMap.size > 0) {
    cb?.onProgress?.(65, 'Execution: rewriting asset URLs in templates...')
    for (const key of Object.keys(templates)) {
      try {
        templates[key] = rewriteUrlsToLocal(templates[key], rewriteMap)
      } catch (err) {
        errors.push({ step: `2.7-rewrite:${key}`, message: (err as Error).message })
      }
    }
  }

  // ── Persist the theme (templates + binaries) ──────────────────────
  let themeId: string | null = null
  const jobId = config.jobId ?? null
  cb?.onProgress?.(70, 'Execution: persisting theme...')
  try {
    if (Object.keys(templates).length > 0) {
      themeId = await persistDynamicTheme(
        db,
        shopId,
        { templates, binaries: {} },
        `Clone of ${new URL(config.sourceUrl).hostname}`,
      )

      // Phase 4.1 — Clone Library: stamp `source_clone_job_id` on the theme
      // row so the Clone Library can resolve "which job produced this
      // theme" in a single lookup. We do this as a follow-up UPDATE rather
      // than extending `persistDynamicTheme`'s signature so existing
      // callers (theme seed, manual theme creation) are unaffected. The
      // stamp is best-effort: if it fails, the theme is still valid —
      // the Library just can't tie it back to this job.
      if (themeId && jobId) {
        try {
          await (db as any)
            .updateTable('themes')
            .set({ source_clone_job_id: jobId })
            .where('id', '=', themeId)
            .execute()
        } catch (stampErr) {
          warnings.push(
            `Could not stamp source_clone_job_id on theme: ${(stampErr as Error).message}`,
          )
        }
      }
    } else {
      warnings.push('No templates produced — skipping theme persistence.')
    }
  } catch (err) {
    errors.push({ step: 'persist-theme', message: (err as Error).message })
    cb?.onError?.('execution', err as Error)
  }

  // ── 2.5 Content Import (pages / blog / collections) ──────────────
  // jobId (declared above for the theme stamping step) is threaded
  // through so imported rows get stamped with clone_job_id (feeds the
  // source-site tabs UX in the admin; null for tests / legacy callers
  // that don't have a job row).
  cb?.onProgress?.(80, 'Execution: importing pages / blog posts / collections...')
  const pagesImported = await importPages(db, shopId, discovery.pages, errors, jobId)
  const blogPostsImported = await importBlogPosts(db, shopId, discovery.pages, errors, jobId)
  const collectionsImported = await importCollections(db, shopId, discovery.pages, errors, jobId)

  cb?.onProgress?.(100, 'Execution complete.')
  cb?.onPhaseUpdate?.(
    'execution',
    errors.length === 0 ? 'succeeded' : 'failed',
    errors.length === 0
      ? `Cloned ${Object.keys(templates).length} templates, ${assetsDownloaded} assets, ${pagesImported + blogPostsImported + collectionsImported} content rows.`
      : `Execution finished with ${errors.length} errors.`,
  )

  return {
    themeId: layoutOk ? themeId : themeId,
    templatesWritten: Object.keys(templates).length,
    assetsDownloaded,
    assetsFailed,
    totalAssetBytes,
    pagesImported,
    blogPostsImported,
    collectionsImported,
    homepageSectionsDetected,
    templateChanges,
    warnings,
    errors,
    durationMs: Date.now() - started,
  }
}

// ---------------------------------------------------------------------------
// Content Import Helpers
// ---------------------------------------------------------------------------

async function importPages(
  db: Kysely<Database>,
  shopId: string,
  pages: readonly DiscoveredPage[],
  errors: ExecutionError[],
  jobId: string | null,
): Promise<number> {
  const pagePages = pages.filter((p) => p.pageType === 'page' || p.pageType === 'policy')
  if (pagePages.length === 0) return 0

  const scraped: ScrapedPage[] = pagePages.map((p) => toScrapedPage(p))
  try {
    const result = await persistClonePages(db, shopId, scraped, jobId)
    return result.inserted + result.updated
  } catch (err) {
    errors.push({ step: '2.5-pages', message: (err as Error).message })
    return 0
  }
}

async function importBlogPosts(
  db: Kysely<Database>,
  shopId: string,
  pages: readonly DiscoveredPage[],
  errors: ExecutionError[],
  jobId: string | null,
): Promise<number> {
  const posts = pages.filter((p) => p.pageType === 'blog-post')
  if (posts.length === 0) return 0

  const scraped: ScrapedBlogPost[] = posts.map((p) => toScrapedBlogPost(p))
  try {
    const result = await persistCloneBlogPosts(db, shopId, scraped, jobId)
    return result.inserted
  } catch (err) {
    errors.push({ step: '2.5-blog', message: (err as Error).message })
    return 0
  }
}

async function importCollections(
  db: Kysely<Database>,
  shopId: string,
  pages: readonly DiscoveredPage[],
  errors: ExecutionError[],
  jobId: string | null,
): Promise<number> {
  const colls = pages.filter((p) => p.pageType === 'collection')
  if (colls.length === 0) return 0

  const scraped: ScrapedCollection[] = colls.map((p) => toScrapedCollection(p))
  try {
    // No product map in v4 flow — pass empty map; collections will be
    // created without product associations, which merchants can edit later.
    const result = await persistCloneCollections(db, shopId, scraped, new Map(), jobId)
    return result.inserted + result.updated
  } catch (err) {
    errors.push({ step: '2.5-collections', message: (err as Error).message })
    return 0
  }
}

// ---------------------------------------------------------------------------
// DiscoveredPage → Scraper DTO conversions
// ---------------------------------------------------------------------------

/** Best-effort slug derivation from a URL's pathname. */
function urlToSlug(url: string): string {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, '')
    const last = pathname.split('/').pop() ?? ''
    return last
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  } catch {
    return 'untitled'
  }
}

function toScrapedPage(page: DiscoveredPage): ScrapedPage {
  const slug = urlToSlug(page.url)
  const { content, metaDescription, ogImage } = extractPageFields(page.html)
  return {
    url: page.url,
    title: page.title || slug,
    slug,
    body_html: content,
    meta_title: page.title || null,
    meta_description: metaDescription,
    og_image: ogImage,
    author: null,
    published_at: null,
    page_type: mapPageTypeForPageScraper(page.url, page.pageType),
  }
}

function toScrapedBlogPost(page: DiscoveredPage): ScrapedBlogPost {
  const slug = urlToSlug(page.url)
  const { content, ogImage, excerpt, publishedAt, author } = extractBlogFields(page.html)
  return {
    url: page.url,
    title: page.title || slug,
    slug,
    body_html: content,
    excerpt,
    author,
    image_url: ogImage,
    tags: [],
    published_at: publishedAt,
  }
}

function toScrapedCollection(page: DiscoveredPage): ScrapedCollection {
  const slug = urlToSlug(page.url)
  const { content, ogImage } = extractPageFields(page.html)
  return {
    url: page.url,
    title: page.title || slug,
    slug,
    description: content,
    image_url: ogImage,
    product_urls: [],
  }
}

/**
 * Map the deep-crawler `PageType` (broader — 15 values) onto the
 * page-scraper `PageType` (narrower — 8 values) so ScrapedPage types
 * line up with what `persistClonePages` expects.
 *
 * Policies keep their specific subtype when the URL hints at it; everything
 * else falls back to 'custom'.
 */
function mapPageTypeForPageScraper(
  url: string,
  crawlerType: string,
): ScraperStaticPageType {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return ''
    }
  })()
  if (crawlerType === 'policy') {
    if (/shipping|delivery/.test(path)) return 'shipping'
    if (/refund|return|exchange/.test(path)) return 'refund'
    if (/terms|tos/.test(path)) return 'terms'
    return 'policy'
  }
  if (/\babout\b/.test(path)) return 'about'
  if (/\bcontact\b/.test(path)) return 'contact'
  if (/\bfaq\b/.test(path)) return 'faq'
  if (/\bterms\b/.test(path)) return 'terms'
  if (/\bshipping\b/.test(path)) return 'shipping'
  if (/\brefund|\breturn/.test(path)) return 'refund'
  return 'custom'
}

// ---------------------------------------------------------------------------
// Small HTML helpers — local copies to avoid bloating the deep-crawler module
// ---------------------------------------------------------------------------

interface ExtractedFields {
  content: string
  metaDescription: string | null
  ogImage: string | null
}

interface ExtractedBlogFields extends ExtractedFields {
  excerpt: string | null
  publishedAt: string | null
  author: string | null
}

function extractPageFields(html: string): ExtractedFields {
  // Deliberately regex-based rather than cheerio-based: this runs on every
  // page and we want to keep the cost low. Robustness not critical — the
  // result feeds into upsert-by-slug persistence that's resilient to thin
  // data.
  const metaDescription = matchMeta(html, ['name="description"', 'property="og:description"'])
  const ogImage = matchMeta(html, ['property="og:image"', 'name="twitter:image"'])
  // Extract body content area heuristically: <main>, <article>, or <body>.
  const bodyMatch =
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ??
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const content = bodyMatch ? stripScriptsRegex(bodyMatch[1].trim()) : ''
  return { content, metaDescription, ogImage }
}

function extractBlogFields(html: string): ExtractedBlogFields {
  const base = extractPageFields(html)
  const excerpt = matchMeta(html, ['property="og:description"', 'name="description"'])
  // published_at: <time datetime="2024-…"> or <meta property="article:published_time">
  const timeMatch = html.match(/<time[^>]*datetime="([^"]+)"/i)
  const metaTime = html.match(/<meta\s+[^>]*property="article:published_time"[^>]*content="([^"]+)"/i)
  const publishedAt = timeMatch?.[1] ?? metaTime?.[1] ?? null
  // author: <meta name="author"> or <a rel="author">
  const authorMeta = html.match(/<meta\s+[^>]*name="author"[^>]*content="([^"]+)"/i)
  const authorLink = html.match(/<[^>]*rel="author"[^>]*>([^<]+)<\//i)
  const author = authorMeta?.[1]?.trim() ?? authorLink?.[1]?.trim() ?? null
  return { ...base, excerpt, publishedAt, author }
}

function matchMeta(html: string, attributeMatchers: string[]): string | null {
  for (const matcher of attributeMatchers) {
    const re = new RegExp(`<meta\\s+[^>]*${matcher}[^>]*content="([^"]+)"`, 'i')
    const m = html.match(re)
    if (m?.[1]) return m[1].trim()
    // Also try the content-before-name form.
    const reAlt = new RegExp(`<meta\\s+[^>]*content="([^"]+)"[^>]*${matcher}`, 'i')
    const mAlt = html.match(reAlt)
    if (mAlt?.[1]) return mAlt[1].trim()
  }
  return null
}

function stripScriptsRegex(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * Pick the homepage DiscoveredPage from the crawl output. Prefer the exact
 * match of `config.sourceUrl`; fall back to the first page with
 * `pageType === 'home'`.
 */
function pickHomepage(
  pages: readonly DiscoveredPage[],
  sourceUrl: string,
): DiscoveredPage | null {
  const normalized = normaliseUrl(sourceUrl)
  for (const p of pages) {
    if (normaliseUrl(p.url) === normalized) return p
  }
  for (const p of pages) {
    if (p.pageType === 'home') return p
  }
  return pages[0] ?? null
}

function normaliseUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.origin + u.pathname).replace(/\/+$/, '')
  } catch {
    return url
  }
}

/**
 * Wrap a bare HTML section fragment in Shopify-style `{% schema %}` boilerplate
 * so it can be referenced as a `{% section 'xxx' %}` from theme.liquid.
 * We keep the schema minimal — the admin UI will let merchants edit these.
 */
function wrapSectionSchema(name: string, html: string): string {
  return `${html}

{% schema %}
{
  "name": "${name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}",
  "settings": []
}
{% endschema %}`
}
