/**
 * Clone Pro — One-Command Pipeline (v2 — Pixel-Perfect)
 *
 * The holy grail: user says "clone this website" → everything happens
 * automatically. This v2 pipeline uses the source site's ACTUAL CSS and
 * HTML structure instead of regenerating from tokens — giving pixel-perfect
 * visual fidelity.
 *
 * Pipeline stages (10 total):
 *   1.  detect          → Platform detection
 *   2.  crawl           → Products + sitemap + homepage HTML
 *   3.  extract_design  → Full CSS clone + homepage sections + nav + brand
 *   4.  extract_content → Pages + blog + collections scraping
 *   5.  generate_theme  → Build Liquid theme from cloned CSS/HTML
 *   6.  import_data     → Write products/pages/blog/menus/collections/SEO to DB
 *   7.  ingest_media    → (future: download + re-host images)
 *   8.  apply_brand     → Brand kit extraction
 *   9.  seo_optimize    → (future: AI SEO)
 *  10.  finalize        → Result summary
 */

import crypto from 'crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type {
  CloneProConfig,
  CloneProResult,
  CloneStage,
  CloneStageResult,
  ExtractedDesign,
} from './types.js'
import { crawlWebsite, type CrawlResult } from './universal-crawler.js'
import { extractDesign } from './design-extractor.js'
import { createAIBridge } from './ai-bridge.js'
import { optimizeSeoForShop } from './ai-seo-optimizer.js'
import { optimizeAltTextForShop } from './ai-alt-text-optimizer.js'
import {
  CLONE_STAGES_ORDER,
  RESUMABLE_STAGES,
  stageIsBefore,
} from './resume.js'
import { persistCloneProducts } from '../storefront-clone/persist-products.js'
import { extractAndPersistBrandKit } from '../storefront-clone/brand-kit-extractor.js'

// Scrapers (Phase 1-2 originals)
import { scrapePages, type ScrapedPage } from './scrapers/page-scraper.js'
import { scrapeBlogPosts, type ScrapedBlogPost } from './scrapers/blog-scraper.js'
import { scrapeMenus, type ScrapedMenus } from './scrapers/menu-scraper.js'
import { scrapeCollections, type ScrapedCollection } from './scrapers/collection-scraper.js'
import { extractFullCSS, type ExtractedCSS } from './scrapers/css-extractor.js'
import { scrapeHeroes, type ScrapedHero } from './scrapers/hero-scraper.js'
import { scrapeBrand, type ScrapedBrand } from './scrapers/brand-scraper.js'

// NEW: Pixel-perfect scrapers
import { scrapeFullCSS, type FullCSSResult } from './scrapers/full-css-scraper.js'
import { cloneHomepage, rewriteUrlsToLocal, convertLazyToEager, type HomepageCloneResult } from './scrapers/homepage-cloner.js'
import { scrapeShopifyNav } from './scrapers/shopify-nav-scraper.js'
import { scrapeShopifyCollectionProducts } from './scrapers/shopify-collection-products.js'

// Clone Pro v3: Full Asset Clone
import { downloadAllAssets, type AssetDownloadResult } from './scrapers/full-asset-downloader.js'
import { cloneJavaScript, type JSCloneResult } from './scrapers/js-cloner.js'

// Persistence
import { persistClonePages } from './persist/persist-pages.js'
import { persistCloneBlogPosts } from './persist/persist-blog.js'
import { persistCloneMenus } from './persist/persist-menus.js'
import { persistCloneCollections } from './persist/persist-collections.js'
import { persistCloneSEO } from './persist/persist-seo.js'

// Theme
import { generateThemeFromDesign } from './theme-gen/template-generator.js'
import { persistCloneTheme, persistDynamicTheme, type DynamicThemeAssets } from './theme-gen/persist-theme.js'

// Design Library — D2 emit hook writes a DESIGN.md row for each
// successful clone so the /design-library gallery's "My Clones" tab
// has real data. The hook is try/catch-wrapped inside emitCloneEntry
// so a DB hiccup on the auxiliary write doesn't fail an otherwise-
// successful clone.
import { emitCloneEntry } from '../design-library/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClonePipelineCallbacks {
  /** Called when a stage starts/completes */
  onStageUpdate?: (stage: CloneStageResult) => void
  /** Called with overall progress (0-100) */
  onProgress?: (pct: number, message: string) => void
  /** Called when an error occurs (non-fatal stages continue) */
  onError?: (stage: CloneStage, error: Error) => void
}

export interface ClonePipelineResult {
  readonly stages: readonly CloneStageResult[]
  readonly result: CloneProResult
  readonly design?: ExtractedDesign
  readonly crawl?: CrawlResult
  readonly themeId?: string
}

// Stage → progress % mapping
const STAGE_PROGRESS: Record<CloneStage, number> = {
  detect: 5,
  crawl: 25,
  extract_design: 45,
  extract_content: 55,
  generate_theme: 70,
  import_data: 85,
  ingest_media: 90,
  apply_brand: 93,
  seo_optimize: 96,
  finalize: 100,
}

// Stages that are non-fatal (pipeline continues if they fail)
const NON_FATAL_STAGES: Set<CloneStage> = new Set([
  'extract_design',
  'extract_content',
  'generate_theme',
  'ingest_media',
  'apply_brand',
  'seo_optimize',
])

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

/**
 * Clone a website with a single function call.
 * v2: Uses source site's actual CSS and HTML for pixel-perfect cloning.
 */
export async function cloneWebsite(
  db: Kysely<Database>,
  config: CloneProConfig,
  callbacks?: ClonePipelineCallbacks,
): Promise<ClonePipelineResult> {
  const stages: CloneStageResult[] = []
  const startTime = Date.now()

  // Create AI bridge (no-op if no AI config provided)
  const ai = createAIBridge(config.ai)

  // Resume short-circuit (see `resume.ts`). If the caller wants to
  // resume a partially-completed job, we run only the tail stages —
  // earlier ones are recorded as `skipped` for audit but don't execute.
  if (config.resumeFromStage) {
    if (!RESUMABLE_STAGES.has(config.resumeFromStage)) {
      throw new Error(
        `Cannot resume from stage '${config.resumeFromStage}'. ` +
          `V1 resume only supports: ${Array.from(RESUMABLE_STAGES).join(', ')}.`,
      )
    }
    return runResumedCloneTail(db, config, callbacks, ai, stages, startTime)
  }

  let crawlResult: CrawlResult | undefined
  let design: ExtractedDesign | undefined
  let productsImported = 0
  let collectionsImported = 0
  let pagesImported = 0
  let imagesIngested = 0
  let themeGenerated = false
  let brandKitApplied = false
  let seoOptimized = false
  let themeId: string | undefined

  // Scraped data holders
  let scrapedPages: ScrapedPage[] = []
  let scrapedBlog: ScrapedBlogPost[] = []
  let scrapedMenus: ScrapedMenus = { main_menu: [], footer_menu: [] }
  let scrapedCollections: ScrapedCollection[] = []

  // NEW: Pixel-perfect data holders
  let fullCss: FullCSSResult | undefined
  let homepageClone: HomepageCloneResult | undefined
  let brand: ScrapedBrand = { logo_url: null, logo_alt: null, favicon_url: null, apple_touch_icon: null, site_name: null }
  let isShopify = false

  // Clone Pro v3: Full Asset Clone data holders
  let downloadedAssets: AssetDownloadResult | undefined
  let clonedJS: JSCloneResult | undefined

  // ══════════════════════════════════════════════════════════════════
  // Stage 1: Detect Platform
  // ══════════════════════════════════════════════════════════════════
  const detectResult = await runStage('detect', stages, callbacks, async () => {
    const detection = await import('./platform-detector.js').then(m =>
      m.detectPlatform(config.sourceUrl),
    )
    isShopify = detection.platform === 'shopify'
    return { platform: detection.platform, confidence: detection.confidence }
  })

  // ══════════════════════════════════════════════════════════════════
  // Stage 2: Crawl (Products + Sitemap + Homepage)
  // ══════════════════════════════════════════════════════════════════
  crawlResult = await runStage('crawl', stages, callbacks, async () => {
    const result = await crawlWebsite(config, (p) => {
      callbacks?.onProgress?.(
        STAGE_PROGRESS.detect + (p.current / Math.max(p.total, 1)) * (STAGE_PROGRESS.crawl - STAGE_PROGRESS.detect),
        p.message,
      )
    })
    return result
  })

  if (!crawlResult) {
    // Fatal: can't proceed without crawl data
    return buildResult(stages, startTime, {
      productsImported, collectionsImported, pagesImported,
      imagesIngested, themeGenerated, brandKitApplied, seoOptimized,
      platform: detectResult?.platform ?? 'unknown',
      pagesScraped: 0,
    }, design, crawlResult)
  }

  const homepageHtml = crawlResult.homepage.html

  // ══════════════════════════════════════════════════════════════════
  // Stage 3: Extract Design (FULL CSS + Homepage Sections + Nav + Brand)
  // ══════════════════════════════════════════════════════════════════
  if (config.scope.theme) {
    await runStage('extract_design', stages, callbacks, async () => {
      // 3a. Download ALL CSS from source (pixel-perfect)
      callbacks?.onProgress?.(27, 'Downloading source CSS...')
      try {
        fullCss = await scrapeFullCSS(homepageHtml, config.sourceUrl)
        callbacks?.onProgress?.(32, `Downloaded ${fullCss.stats.stylesheetCount} stylesheets, ${fullCss.stats.fontCount} fonts (${(fullCss.stats.totalCssBytes / 1024).toFixed(0)}KB CSS)`)
      } catch (err) {
        console.warn('[pipeline] Full CSS scrape failed, will fallback to tokens:', (err as Error).message)
      }

      // 3b. Clone homepage sections (preserve HTML structure)
      callbacks?.onProgress?.(34, 'Cloning homepage sections...')
      try {
        homepageClone = cloneHomepage(homepageHtml, config.sourceUrl)
        callbacks?.onProgress?.(36, `Cloned ${homepageClone.sections.length} homepage sections`)
      } catch (err) {
        console.warn('[pipeline] Homepage clone failed:', (err as Error).message)
      }

      // 3c. Brand identity
      callbacks?.onProgress?.(38, 'Extracting brand identity...')
      brand = scrapeBrand(homepageHtml, config.sourceUrl)

      // 3d. Navigation (Shopify-specific or generic)
      callbacks?.onProgress?.(40, 'Extracting navigation...')
      if (isShopify) {
        try {
          const navResult = scrapeShopifyNav(homepageHtml, config.sourceUrl)
          if (navResult.menus.main_menu.length > 0 || navResult.menus.footer_menu.length > 0) {
            scrapedMenus = navResult.menus
          }
        } catch { /* fall through to generic */ }
      }
      // Fallback to generic menu scraper if Shopify nav didn't work
      if (scrapedMenus.main_menu.length === 0) {
        scrapedMenus = scrapeMenus(homepageHtml, config.sourceUrl)
      }
      callbacks?.onProgress?.(42, `Found ${scrapedMenus.main_menu.length} main menu + ${scrapedMenus.footer_menu.length} footer items`)

      // 3e. Also extract design tokens for compatibility/fallback
      try {
        design = await extractDesign({
          html: homepageHtml,
          url: config.sourceUrl,
          ai,
        })
      } catch { /* non-critical */ }

      return {
        fullCss: fullCss ? { stylesheets: fullCss.stats.stylesheetCount, fonts: fullCss.stats.fontCount, cssBytes: fullCss.stats.totalCssBytes } : null,
        homepageSections: homepageClone?.sections.length ?? 0,
        brand: brand.site_name,
        mainMenu: scrapedMenus.main_menu.length,
        footerMenu: scrapedMenus.footer_menu.length,
      }
    })
  } else {
    skipStage('extract_design', stages, callbacks)
  }

  // ══════════════════════════════════════════════════════════════════
  // Stage 4: Extract Content (Pages + Blog + Collections)
  // ══════════════════════════════════════════════════════════════════
  await runStage('extract_content', stages, callbacks, async () => {
    const sitemap = crawlResult!.sitemap

    // Scrape pages
    if (config.scope.pages) {
      const pageUrls = sitemap
        .filter(n => n.kind === 'page')
        .slice(0, config.maxPages ?? 50)
        .map(n => n.url)
      if (pageUrls.length > 0) {
        scrapedPages = await scrapePages(pageUrls, { concurrency: 3 })
        callbacks?.onProgress?.(48, `Scraped ${scrapedPages.length} pages`)
      }
    }

    // Scrape blog
    if (config.scope.blog) {
      scrapedBlog = await scrapeBlogPosts(sitemap, config.sourceUrl, {
        concurrency: 3,
        maxPosts: 50,
      })
      callbacks?.onProgress?.(50, `Scraped ${scrapedBlog.length} blog posts`)
    }

    // Scrape collections (from sitemap)
    if (config.scope.collections) {
      scrapedCollections = await scrapeCollections(sitemap, config.sourceUrl, {
        concurrency: 3,
      })
      callbacks?.onProgress?.(52, `Scraped ${scrapedCollections.length} collections`)
    }

    return {
      pages: scrapedPages.length,
      blog: scrapedBlog.length,
      collections: scrapedCollections.length,
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // Stage 5: Generate Theme (Pixel-Perfect or Fallback)
  // ══════════════════════════════════════════════════════════════════
  if (config.generateTheme) {
    await runStage('generate_theme', stages, callbacks, async () => {
      const themeName = `Clone: ${brand.site_name || new URL(config.sourceUrl).hostname}`

      // ── PIXEL-PERFECT PATH: use source CSS + cloned HTML sections ──
      if (fullCss && homepageClone) {
        callbacks?.onProgress?.(58, 'Building pixel-perfect theme from source CSS...')

        const templates: Record<string, string> = {}
        const binaries: Record<string, Buffer> = {}

        // Layout
        templates['layout/theme.liquid'] = homepageClone.layoutTemplate

        // Index — references all cloned sections
        templates['templates/index.liquid'] = homepageClone.indexTemplate

        // Header & Footer — preserved source HTML
        templates['sections/header.liquid'] = homepageClone.headerHtml
        templates['sections/footer.liquid'] = homepageClone.footerHtml

        // Cloned homepage sections
        for (const section of homepageClone.sections) {
          templates[`sections/${section.id}.liquid`] = section.html
        }

        // Product/Collection/Page/Blog/Cart — use base templates (styled by source CSS)
        const { readFileSync } = await import('fs')
        const { join, dirname } = await import('path')
        const { fileURLToPath } = await import('url')
        const __dirname = dirname(fileURLToPath(import.meta.url))
        const templatesDir = join(__dirname, 'theme-gen', 'base-templates')

        const baseTemplates = ['product', 'collection', 'page', 'blog', 'cart']
        for (const name of baseTemplates) {
          try {
            templates[`templates/${name}.liquid`] = readFileSync(join(templatesDir, `${name}.liquid`), 'utf-8')
          } catch { /* skip missing */ }
        }

        // Product card snippet
        try {
          templates['snippets/product-card.liquid'] = readFileSync(join(templatesDir, 'product-card.liquid'), 'utf-8')
        } catch { /* skip */ }

        // CSS — the source site's ACTUAL CSS (pixel-perfect!)
        templates['assets/style.css'] = fullCss.css

        // JS — basic interactivity
        templates['assets/script.js'] = generateScriptJS()

        // Binary assets (fonts, CSS images)
        for (const [path, buffer] of fullCss.binaryAssets) {
          binaries[path] = buffer
        }

        callbacks?.onProgress?.(64, `Saving pixel-perfect theme (${Object.keys(templates).length} templates, ${Object.keys(binaries).length} assets)...`)

        themeId = await persistDynamicTheme(db, config.shopId, { templates, binaries }, themeName)
        themeGenerated = true

        // Phase 4.1 — Clone Library: stamp `source_clone_job_id` on the
        // theme so the Library can map "job → theme" in one lookup.
        // Best-effort; non-fatal (the theme still works without it).
        await stampThemeSourceJobId(db, themeId, config.jobId ?? null)

        return {
          mode: 'pixel-perfect',
          themeId,
          themeName,
          templateCount: Object.keys(templates).length,
          binaryCount: Object.keys(binaries).length,
          cssSizeKB: (fullCss.stats.totalCssBytes / 1024).toFixed(0),
          sectionsCloned: homepageClone.sections.length,
        }
      }

      // ── FALLBACK PATH: generate from extracted tokens ──────────────
      callbacks?.onProgress?.(58, 'Generating theme from design tokens (fallback)...')

      let cssData: ExtractedCSS | undefined
      try {
        cssData = await extractFullCSS(homepageHtml, config.sourceUrl)
      } catch { /* empty */ }

      if (cssData) {
        const heroes = scrapeHeroes(homepageHtml, config.sourceUrl)
        const templateSet = generateThemeFromDesign({
          design: cssData,
          heroes,
          brand,
          menus: scrapedMenus,
        })
        themeId = await persistCloneTheme(db, config.shopId, templateSet, themeName)
        themeGenerated = true

        // Phase 4.1 — Clone Library: stamp the job id on the theme so
        // the Library can resolve it back to the originating job.
        await stampThemeSourceJobId(db, themeId, config.jobId ?? null)

        return { mode: 'token-based', themeId, themeName }
      }

      return { mode: 'skipped', reason: 'No CSS data available' }
    })
  } else {
    skipStage('generate_theme', stages, callbacks)
  }

  // ══════════════════════════════════════════════════════════════════
  // Stage 6: Import Data (Products + Pages + Blog + Menus + Collections + SEO)
  // ══════════════════════════════════════════════════════════════════
  if (config.scope.products && crawlResult.products.length > 0) {
    await runStage('import_data', stages, callbacks, async () => {
      callbacks?.onProgress?.(72, `Importing ${crawlResult!.products.length} products...`)

      // Stamp the REAL job id, not a fresh random UUID. The previous
      // `crypto.randomUUID()` was a copy-paste mistake — products.
      // clone_job_id has an FK to storefront_clone_jobs(id), so a UUID
      // not in that table fails the constraint immediately
      // ("violates foreign key constraint fk_products_clone_job_id").
      // Use config.jobId, which the runner always sets in production
      // (types.ts comment: "runner.ts always sets it"); fall back to
      // null for tests / legacy callers without a job row, matching
      // how persistClonePages, persistCloneBlogPosts, etc. handle it.
      // Production incident 2026-04-25: import_data stage failed on
      // every clone-pro run for the new seller (job ae5e9acc-…).
      const result = await persistCloneProducts(db, {
        shopId: config.shopId,
        cloneJobId: config.jobId ?? null,
        sourceBaseUrl: config.sourceUrl,
        products: crawlResult!.products,
      })
      productsImported = result.inserted + result.updated

      // Persist scraped pages
      if (scrapedPages.length > 0) {
        callbacks?.onProgress?.(74, `Saving ${scrapedPages.length} pages...`)
        const pageResult = await persistClonePages(db, config.shopId, scrapedPages, config.jobId ?? null)
        pagesImported = pageResult.inserted + pageResult.updated
      }

      // Persist blog posts
      if (scrapedBlog.length > 0) {
        callbacks?.onProgress?.(76, `Saving ${scrapedBlog.length} blog posts...`)
        await persistCloneBlogPosts(db, config.shopId, scrapedBlog, config.jobId ?? null)
      }

      // Persist menus
      if (scrapedMenus.main_menu.length > 0 || scrapedMenus.footer_menu.length > 0) {
        callbacks?.onProgress?.(77, `Saving menus (${scrapedMenus.main_menu.length} main + ${scrapedMenus.footer_menu.length} footer)...`)
        await persistCloneMenus(db, config.shopId, scrapedMenus, config.jobId ?? null)
      }

      // Persist collections
      let collectionsToSave = scrapedCollections
      if (collectionsToSave.length === 0 && crawlResult!.collections.length > 0) {
        collectionsToSave = crawlResult!.collections.map(c => ({
          url: `${config.sourceUrl.replace(/\/$/, '')}/collections/${c.handle}`,
          title: c.title,
          slug: c.handle,
          description: c.description || null,
          image_url: c.imageUrl || null,
          product_urls: [],
        }))
      }

      if (collectionsToSave.length > 0) {
        callbacks?.onProgress?.(78, `Saving ${collectionsToSave.length} collections...`)
        const productUrlMap = new Map<string, string>()
        await persistCloneCollections(db, config.shopId, collectionsToSave, productUrlMap, config.jobId ?? null)
        collectionsImported = collectionsToSave.length
      }

      // Link products to collections (Shopify-specific)
      if (isShopify && collectionsToSave.length > 0 && productsImported > 0) {
        callbacks?.onProgress?.(80, 'Linking products to collections...')
        try {
          await linkShopifyCollectionProducts(
            db,
            config.sourceUrl,
            config.shopId,
            collectionsToSave.map(c => c.slug),
          )
          callbacks?.onProgress?.(82, 'Products linked to collections')
        } catch (err) {
          console.warn('[pipeline] Collection-product linking failed:', (err as Error).message)
        }
      }

      // Persist SEO data
      if (config.scope.seo) {
        callbacks?.onProgress?.(83, 'Saving SEO metadata...')
        const heroes = scrapeHeroes(homepageHtml, config.sourceUrl)
        await persistCloneSEO(db, config.shopId, {
          meta_title: brand.site_name || new URL(config.sourceUrl).hostname,
          meta_description: '',
          og_image: heroes[0]?.image_url || null,
          favicon_url: brand.favicon_url,
          site_name: brand.site_name,
          social_links: {},
        })
      }

      return {
        products: productsImported,
        pages: pagesImported,
        blog: scrapedBlog.length,
        collections: collectionsImported,
        menus: scrapedMenus.main_menu.length + scrapedMenus.footer_menu.length,
      }
    })
  } else {
    skipStage('import_data', stages, callbacks)
  }

  // ══════════════════════════════════════════════════════════════════
  // Stage 7: Ingest Media — Download ALL assets + JS locally (v3)
  // ══════════════════════════════════════════════════════════════════
  if (config.ingestMedia) {
    await runStage('ingest_media', stages, callbacks, async () => {
      const { mkdirSync, writeFileSync } = await import('fs')
      const { join, dirname } = await import('path')

      // Base directory for this shop's cloned assets
      const assetsDir = join(process.cwd(), 'clone-assets', config.shopId)

      callbacks?.onProgress?.(86, 'Downloading all images from source...')

      // 7a. Download ALL images/media from homepage HTML
      try {
        downloadedAssets = await downloadAllAssets(
          homepageHtml,
          config.sourceUrl,
          config.shopId,
          { maxConcurrency: 5, maxFileSize: 15 * 1024 * 1024 },
        )

        // Save downloaded assets to filesystem
        for (const asset of downloadedAssets.assets) {
          const filePath = join(process.cwd(), asset.localPath)
          const dir = dirname(filePath)
          mkdirSync(dir, { recursive: true })
          writeFileSync(filePath, asset.buffer)
        }

        callbacks?.onProgress?.(89, `Downloaded ${downloadedAssets.stats.downloaded} images (${(downloadedAssets.stats.totalBytes / 1024 / 1024).toFixed(1)}MB)`)
        imagesIngested = downloadedAssets.stats.downloaded
      } catch (err) {
        console.warn('[pipeline] Asset download failed:', (err as Error).message)
      }

      // 7b. Clone JavaScript (keep theme JS, strip tracking)
      callbacks?.onProgress?.(90, 'Downloading theme JavaScript...')
      try {
        clonedJS = await cloneJavaScript(homepageHtml, config.sourceUrl, config.shopId)

        // Save external JS files to filesystem
        for (const script of clonedJS.scripts) {
          if (script.type === 'external' && script.buffer && script.localPath) {
            const filePath = join(process.cwd(), script.localPath)
            const dir = dirname(filePath)
            mkdirSync(dir, { recursive: true })
            writeFileSync(filePath, script.buffer)
          }
        }

        callbacks?.onProgress?.(91, `Cloned ${clonedJS.stats.kept} scripts (stripped ${clonedJS.stats.stripped})`)
      } catch (err) {
        console.warn('[pipeline] JS clone failed:', (err as Error).message)
      }

      // 7c. Rewrite theme templates with local URLs
      if (downloadedAssets && themeId) {
        callbacks?.onProgress?.(92, 'Rewriting asset URLs to local paths...')

        // Expand rewrite map with HTML entity variants (&amp; for &)
        // and protocol-relative variants (// for https://)
        const rewriteMap = new Map(downloadedAssets.rewriteMap)
        for (const [url, local] of downloadedAssets.rewriteMap) {
          // Add &amp; variant (HTML entities in attributes)
          if (url.includes('&')) {
            rewriteMap.set(url.replace(/&/g, '&amp;'), local)
          }
          // Add protocol-relative variant
          if (url.startsWith('https://')) {
            rewriteMap.set('//' + url.slice('https://'.length), local)
            // Also with &amp;
            if (url.includes('&')) {
              rewriteMap.set('//' + url.slice('https://'.length).replace(/&/g, '&amp;'), local)
            }
          }
        }

        // Update all Liquid templates in DB with local URLs
        const templates = await db
          .selectFrom('theme_assets')
          .select(['id', 'key', 'value'])
          .where('theme_id', '=', themeId)
          .where('key', 'like', '%.liquid')
          .execute()

        for (const tmpl of templates) {
          if (!tmpl.value || typeof tmpl.value !== 'string') continue
          if (!tmpl.key.endsWith('.liquid')) continue

          let updated = rewriteUrlsToLocal(tmpl.value, rewriteMap)
          updated = convertLazyToEager(updated)

          if (updated !== tmpl.value) {
            await db
              .updateTable('theme_assets')
              .set({ value: updated, updated_at: new Date().toISOString() } as any)
              .where('id', '=', tmpl.id)
              .execute()
          }
        }

        callbacks?.onProgress?.(93, 'Asset URLs rewritten to local paths')
      }

      // 7d. Add cloned JS references to layout template
      if (clonedJS && themeId) {
        const layoutRow = await db
          .selectFrom('theme_assets')
          .select(['id', 'value'])
          .where('theme_id', '=', themeId)
          .where('key', '=', 'layout/theme.liquid')
          .executeTakeFirst()

        if (layoutRow?.value) {
          let layout = layoutRow.value as string

          // Build script tags for cloned JS
          const scriptTags: string[] = []

          // Add Swiper CSS from CDN (needed for carousels)
          const swiperCssTag = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css">'
          // Add Swiper JS from CDN
          const swiperJsTag = '<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>'

          for (const script of clonedJS.scripts) {
            if (script.type === 'external' && script.localPath) {
              scriptTags.push(`<script src="${script.localPath}"></script>`)
            } else if (script.type === 'inline' && script.source.trim()) {
              // Only include substantive inline scripts (>50 chars)
              if (script.source.trim().length > 50) {
                scriptTags.push(`<script>${script.source}</script>`)
              }
            }
          }

          // Inject before </head> for CSS, before </body> for JS
          if (!layout.includes('swiper')) {
            layout = layout.replace('</head>', `  ${swiperCssTag}\n</head>`)
          }

          const jsBlock = [swiperJsTag, ...scriptTags].join('\n  ')
          layout = layout.replace('</body>', `  ${jsBlock}\n</body>`)

          await db
            .updateTable('theme_assets')
            .set({ value: layout, updated_at: new Date().toISOString() } as any)
            .where('id', '=', layoutRow.id)
            .execute()
        }
      }

      return {
        images: downloadedAssets ? {
          found: downloadedAssets.stats.found,
          downloaded: downloadedAssets.stats.downloaded,
          failed: downloadedAssets.stats.failed,
          totalMB: (downloadedAssets.stats.totalBytes / 1024 / 1024).toFixed(1),
        } : null,
        javascript: clonedJS ? {
          total: clonedJS.stats.total,
          kept: clonedJS.stats.kept,
          stripped: clonedJS.stats.stripped,
        } : null,
      }
    })
  } else {
    skipStage('ingest_media', stages, callbacks)
  }

  // ══════════════════════════════════════════════════════════════════
  // Stage 8: Apply Brand Kit
  // ══════════════════════════════════════════════════════════════════
  if (config.extractBrandKit) {
    await runStage('apply_brand', stages, callbacks, async () => {
      try {
        const brandKit = await extractAndPersistBrandKit(db, {
          sourceUrl: config.sourceUrl,
          shopId: config.shopId,
        })
        brandKitApplied = true
        return brandKit
      } catch {
        return { status: 'brand_kit_extraction_failed' }
      }
    })
  } else {
    skipStage('apply_brand', stages, callbacks)
  }

  // ══════════════════════════════════════════════════════════════════
  // Stage 9: SEO Optimize (AI-powered)
  //
  // Runs two AI enrichment passes back-to-back:
  //
  //   9a. Batch SEO title + description for products/pages/collections/
  //       blog_posts that are missing seo_title or seo_description.
  //   9b. Batch alt-text for product_images whose `alt` is empty.
  //
  // Both gated on the `seo` scope flag plus the relevant provider
  // capability. Goes through the same AIBridge used earlier in the
  // pipeline — NoOp provider returns empty strings, which count as
  // failures and leave the rows untouched. Idempotent: anything with
  // existing merchant-edited values is left alone.
  // ══════════════════════════════════════════════════════════════════
  if (config.scope.seo && (ai.capabilities.seoOptimization || ai.capabilities.imageAltText)) {
    await runStage('seo_optimize', stages, callbacks, async () => {
      // 9a: titles + descriptions
      let seoResult: Awaited<ReturnType<typeof optimizeSeoForShop>> | null = null
      if (ai.capabilities.seoOptimization) {
        seoResult = await optimizeSeoForShop({
          db,
          shopId: config.shopId,
          ai,
          maxItemsPerEntity: config.maxProducts ?? 100,
          onProgress: (done, total, label) => {
            // 9a occupies 95-97%; 9b takes 97-99%; finalize owns 100%.
            const base = 95
            const span = 2
            const pct = total > 0 ? base + Math.floor((done / total) * span) : base
            callbacks?.onProgress?.(pct, `SEO: ${label}`)
          },
        })
      }

      // 9b: image alt text
      let altResult: Awaited<ReturnType<typeof optimizeAltTextForShop>> | null = null
      if (ai.capabilities.imageAltText) {
        altResult = await optimizeAltTextForShop({
          db,
          shopId: config.shopId,
          ai,
          onProgress: (done, total, label) => {
            const base = 97
            const span = 2
            const pct = total > 0 ? base + Math.floor((done / total) * span) : base
            callbacks?.onProgress?.(pct, `Alt-text: ${label}`)
          },
        })
      }

      const totalOptimized =
        (seoResult
          ? seoResult.productsOptimized +
            seoResult.pagesOptimized +
            seoResult.collectionsOptimized +
            seoResult.blogPostsOptimized
          : 0) + (altResult ? altResult.optimized : 0)
      seoOptimized = totalOptimized > 0

      return {
        status: 'seo_optimized',
        seo: seoResult
          ? {
              productsOptimized: seoResult.productsOptimized,
              pagesOptimized: seoResult.pagesOptimized,
              collectionsOptimized: seoResult.collectionsOptimized,
              blogPostsOptimized: seoResult.blogPostsOptimized,
              failed: seoResult.failed,
            }
          : null,
        altText: altResult
          ? {
              optimized: altResult.optimized,
              failed: altResult.failed,
              total: altResult.total,
            }
          : null,
      }
    })
  } else {
    skipStage('seo_optimize', stages, callbacks)
  }

  // ══════════════════════════════════════════════════════════════════
  // Stage 10: Finalize
  // ══════════════════════════════════════════════════════════════════
  await runStage('finalize', stages, callbacks, async () => {
    callbacks?.onProgress?.(100, 'Clone complete!')
    return {
      status: 'completed',
      summary: {
        platform: crawlResult!.platform,
        products: productsImported,
        pages: pagesImported,
        collections: collectionsImported,
        blogPosts: scrapedBlog.length,
        menuItems: scrapedMenus.main_menu.length + scrapedMenus.footer_menu.length,
        themeGenerated,
        themeId,
        mode: fullCss ? 'pixel-perfect' : 'token-based',
      },
    }
  })

  // ── Design Library emit (D2) ─────────────────────────────────────
  // Stamp a DESIGN.md row in `design_library_entries` so the merchant
  // sees this clone under `/design-library` → "My Clones". We do this
  // AFTER finalize succeeds — the row is only worth keeping for a
  // clone that actually completed — but BEFORE buildResult, so any
  // failure in the auxiliary write is swallowed (the clone job
  // itself is still a success; design-library is a secondary surface).
  // See `emitCloneEntry` in design-library/emit-pipeline.ts for skip
  // conditions + error handling.
  await emitCloneEntry(db, {
    design,
    sourceUrl: config.sourceUrl,
    shopId: config.shopId,
    jobId: config.jobId,
    themeId,
  })

  return buildResult(stages, startTime, {
    productsImported, collectionsImported, pagesImported,
    imagesIngested, themeGenerated, brandKitApplied, seoOptimized,
    platform: crawlResult.platform,
    pagesScraped: crawlResult.pages.length + scrapedPages.length,
  }, design, crawlResult, themeId)
}

// ---------------------------------------------------------------------------
// Resume path — tail-only clone execution
// ---------------------------------------------------------------------------

/**
 * Re-runs the resumable tail of the pipeline (`apply_brand`,
 * `seo_optimize`, `finalize`) without re-doing crawl / extract / import.
 *
 * Assumptions — if these don't hold, call the full `cloneWebsite` instead:
 *
 *   - Products, pages, collections, blog_posts, product_images are
 *     already in the DB from a previous run.
 *   - `config.sourceUrl` still points at the source site (used by
 *     brand kit extraction, which re-fetches the home page).
 *
 * The `stages` array is pre-populated with `skipped` entries for every
 * stage that runs before `config.resumeFromStage`, so the admin-UI
 * audit timeline still shows all 10 stages — just with earlier ones
 * marked as "skipped (resumed)".
 */
async function runResumedCloneTail(
  db: Kysely<Database>,
  config: CloneProConfig,
  callbacks: ClonePipelineCallbacks | undefined,
  ai: ReturnType<typeof createAIBridge>,
  stages: CloneStageResult[],
  startTime: number,
): Promise<ClonePipelineResult> {
  const resumeFrom = config.resumeFromStage!

  // Mark every stage before the resume point as skipped (audit only).
  for (const s of CLONE_STAGES_ORDER) {
    if (stageIsBefore(s, resumeFrom)) {
      skipStage(s, stages, callbacks)
    }
  }

  let brandKitApplied = false
  let seoOptimized = false

  // Stage 8: Apply Brand Kit (only if we're resuming from here).
  if (resumeFrom === 'apply_brand') {
    if (config.extractBrandKit) {
      await runStage('apply_brand', stages, callbacks, async () => {
        try {
          const brandKit = await extractAndPersistBrandKit(db, {
            sourceUrl: config.sourceUrl,
            shopId: config.shopId,
          })
          brandKitApplied = true
          return brandKit
        } catch {
          return { status: 'brand_kit_extraction_failed' }
        }
      })
    } else {
      skipStage('apply_brand', stages, callbacks)
    }
  } else if (stageIsBefore('apply_brand', resumeFrom)) {
    // Already marked skipped above in the pre-resume loop — nothing to do.
  }

  // Stage 9: SEO + alt-text (same as the non-resume path, just extracted).
  if (resumeFrom === 'apply_brand' || resumeFrom === 'seo_optimize') {
    if (
      config.scope.seo &&
      (ai.capabilities.seoOptimization || ai.capabilities.imageAltText)
    ) {
      await runStage('seo_optimize', stages, callbacks, async () => {
        let seoResult: Awaited<ReturnType<typeof optimizeSeoForShop>> | null = null
        if (ai.capabilities.seoOptimization) {
          seoResult = await optimizeSeoForShop({
            db,
            shopId: config.shopId,
            ai,
            maxItemsPerEntity: config.maxProducts ?? 100,
            onProgress: (done, total, label) => {
              const base = 95
              const span = 2
              const pct = total > 0 ? base + Math.floor((done / total) * span) : base
              callbacks?.onProgress?.(pct, `SEO: ${label}`)
            },
          })
        }
        let altResult: Awaited<ReturnType<typeof optimizeAltTextForShop>> | null = null
        if (ai.capabilities.imageAltText) {
          altResult = await optimizeAltTextForShop({
            db,
            shopId: config.shopId,
            ai,
            onProgress: (done, total, label) => {
              const base = 97
              const span = 2
              const pct = total > 0 ? base + Math.floor((done / total) * span) : base
              callbacks?.onProgress?.(pct, `Alt-text: ${label}`)
            },
          })
        }
        const totalOptimized =
          (seoResult
            ? seoResult.productsOptimized +
              seoResult.pagesOptimized +
              seoResult.collectionsOptimized +
              seoResult.blogPostsOptimized
            : 0) + (altResult ? altResult.optimized : 0)
        seoOptimized = totalOptimized > 0
        return { status: 'seo_optimized', resumed: true, seo: seoResult, altText: altResult }
      })
    } else {
      skipStage('seo_optimize', stages, callbacks)
    }
  }

  // Stage 10: Finalize — uses zero counters since we didn't run the
  // import stages this time. Callers who want fresh totals should
  // re-query the DB directly.
  await runStage('finalize', stages, callbacks, async () => {
    callbacks?.onProgress?.(100, 'Clone resume complete!')
    return {
      status: 'completed',
      resumed: true,
      resumedFromStage: resumeFrom,
    }
  })

  return buildResult(
    stages,
    startTime,
    {
      productsImported: 0,
      collectionsImported: 0,
      pagesImported: 0,
      imagesIngested: 0,
      themeGenerated: false,
      brandKitApplied,
      seoOptimized,
      platform: 'resumed',
      pagesScraped: 0,
    },
    undefined,
    undefined,
    undefined,
  )
}

// ---------------------------------------------------------------------------
// Shopify Collection-Product Linking
// ---------------------------------------------------------------------------

async function linkShopifyCollectionProducts(
  db: Kysely<Database>,
  sourceUrl: string,
  shopId: string,
  collectionHandles: string[],
): Promise<void> {
  // Fetch product→collection mappings from Shopify API
  const mapping = await scrapeShopifyCollectionProducts(
    sourceUrl,
    collectionHandles,
    250,
  )

  if (mapping.totalLinks === 0) return

  // Build handle→ID lookup for products and collections
  const products = await db
    .selectFrom('products')
    .select(['id', 'slug'])
    .where('shop_id', '=', shopId)
    .execute()
  const productBySlug = new Map(products.map(p => [p.slug, p.id]))

  const collections = await db
    .selectFrom('collections')
    .select(['id', 'slug'])
    .where('shop_id', '=', shopId)
    .execute()
  const collectionBySlug = new Map(collections.map(c => [c.slug, c.id]))

  // Insert collection_products links
  for (const [collHandle, productHandles] of mapping.links) {
    const collectionId = collectionBySlug.get(collHandle)
    if (!collectionId) continue

    // Clear existing links for this collection (re-clone safe)
    await db
      .deleteFrom('collection_products')
      .where('collection_id', '=', collectionId)
      .execute()

    let position = 0
    for (const prodHandle of productHandles) {
      const productId = productBySlug.get(prodHandle)
      if (!productId) continue

      try {
        await db
          .insertInto('collection_products')
          .values({ collection_id: collectionId, product_id: productId, position } as any)
          .execute()
        position++
      } catch { /* skip duplicates */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Clone Library — source-job stamp helper (Phase 4.1)
// ---------------------------------------------------------------------------

/**
 * Stamp `themes.source_clone_job_id` so the Clone Library can resolve
 * "which job produced this theme" in a single lookup, and so the
 * Discard cascade can reach orphaned themes when it tears a job down.
 *
 * This is deliberately a best-effort write:
 *   - If `jobId` is null (tests / legacy callers with no job row), we
 *     no-op silently.
 *   - If the UPDATE throws (FK constraint, network blip, race with a
 *     DELETE), we swallow the error and log — the theme itself is
 *     still a valid, usable row.
 *
 * We intentionally didn't extend `persistDynamicTheme`'s signature
 * because that function has unrelated callers (theme seed / manual
 * theme creation) where a clone-job id doesn't exist.
 */
async function stampThemeSourceJobId(
  db: Kysely<Database>,
  themeId: string | undefined,
  jobId: string | null,
): Promise<void> {
  if (!themeId || !jobId) return
  try {
    await (db as any)
      .updateTable('themes')
      .set({ source_clone_job_id: jobId })
      .where('id', '=', themeId)
      .execute()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[pipeline] stampThemeSourceJobId failed (non-fatal):',
      (err as Error).message,
    )
  }
}

// ---------------------------------------------------------------------------
// Script JS Generator
// ---------------------------------------------------------------------------

function generateScriptJS(): string {
  return `/* Gbox Clone Theme — JavaScript */
(function() {
  /* Product gallery thumbnail switching */
  document.querySelectorAll('.gallery-thumbs .thumb').forEach(function(thumb) {
    thumb.addEventListener('click', function() {
      var mainImg = document.getElementById('product-main-image');
      if (mainImg) {
        mainImg.src = this.dataset.image;
        document.querySelectorAll('.gallery-thumbs .thumb').forEach(function(t) { t.classList.remove('active'); });
        this.classList.add('active');
      }
    });
  });

  /* Sort by selector */
  var sortSelect = document.getElementById('sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', function() {
      var url = new URL(window.location.href);
      url.searchParams.set('sort_by', this.value);
      window.location.href = url.toString();
    });
  }

  /* Mobile menu toggle */
  var menuToggle = document.querySelector('.menu-toggle, [data-menu-toggle]');
  var mainNav = document.querySelector('.main-nav, .site-nav, [data-main-nav]');
  if (menuToggle && mainNav) {
    menuToggle.addEventListener('click', function() {
      mainNav.classList.toggle('open');
      this.classList.toggle('active');
    });
  }
})();
`
}

// ---------------------------------------------------------------------------
// Stage Runner
// ---------------------------------------------------------------------------

async function runStage<T>(
  stage: CloneStage,
  stages: CloneStageResult[],
  callbacks: ClonePipelineCallbacks | undefined,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const startedAt = new Date().toISOString()

  const stageEntry: CloneStageResult = {
    stage,
    status: 'running',
    startedAt,
    finishedAt: null,
  }
  stages.push(stageEntry)
  callbacks?.onStageUpdate?.(stageEntry)
  callbacks?.onProgress?.(STAGE_PROGRESS[stage] - 5, `Running: ${stage}...`)

  try {
    const result = await fn()
    const finishedEntry: CloneStageResult = {
      stage,
      status: 'succeeded',
      startedAt,
      finishedAt: new Date().toISOString(),
      data: result as any,
    }
    stages[stages.length - 1] = finishedEntry
    callbacks?.onStageUpdate?.(finishedEntry)
    callbacks?.onProgress?.(STAGE_PROGRESS[stage], `Completed: ${stage}`)
    return result
  } catch (err: any) {
    const isFatal = !NON_FATAL_STAGES.has(stage)
    const failedEntry: CloneStageResult = {
      stage,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      errorCode: err.code ?? 'unknown',
      message: err.message ?? String(err),
    }
    stages[stages.length - 1] = failedEntry
    callbacks?.onStageUpdate?.(failedEntry)
    callbacks?.onError?.(stage, err)

    if (isFatal) throw err
    return undefined
  }
}

function skipStage(
  stage: CloneStage,
  stages: CloneStageResult[],
  callbacks: ClonePipelineCallbacks | undefined,
): void {
  const entry: CloneStageResult = {
    stage,
    status: 'skipped',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    message: 'Skipped by configuration',
  }
  stages.push(entry)
  callbacks?.onStageUpdate?.(entry)
}

// ---------------------------------------------------------------------------
// Result Builder
// ---------------------------------------------------------------------------

function buildResult(
  stages: CloneStageResult[],
  startTime: number,
  stats: {
    platform: string
    pagesScraped: number
    productsImported: number
    collectionsImported: number
    pagesImported: number
    imagesIngested: number
    themeGenerated: boolean
    brandKitApplied: boolean
    seoOptimized: boolean
  },
  design?: ExtractedDesign,
  crawl?: CrawlResult,
  themeId?: string,
): ClonePipelineResult {
  return {
    stages,
    result: {
      platform: stats.platform as any,
      pagesScraped: stats.pagesScraped,
      productsImported: stats.productsImported,
      collectionsImported: stats.collectionsImported,
      pagesImported: stats.pagesImported,
      imagesIngested: stats.imagesIngested,
      themeGenerated: stats.themeGenerated,
      brandKitApplied: stats.brandKitApplied,
      seoOptimized: stats.seoOptimized,
      duration_ms: Date.now() - startTime,
    },
    design,
    crawl,
    themeId,
  }
}
