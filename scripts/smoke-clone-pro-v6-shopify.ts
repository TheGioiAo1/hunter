/**
 * Smoke — Phase 21 PR2 / Sprint 2A: Stage 4 bucket scrapers vs Shopify dev store
 *
 * Operator-runnable smoke that walks Stages 1-4 against hydrogen-preview.myshopify.com
 * (or SMOKE_SOURCE_URL override) and asserts non-zero products + collections extracted.
 *
 * Usage:
 *   npx tsx scripts/smoke-clone-pro-v6-shopify.ts
 *
 * Optional:
 *   SMOKE_SOURCE_URL=https://your-shopify-store.myshopify.com (default: hydrogen-preview)
 */

import 'dotenv/config'
import { discoverUrls } from '../packages/core/src/modules/clone-pro/v6/stages/stage1-sitemap.js'
import { classifyUrlsByPattern } from '../packages/core/src/modules/clone-pro/v6/stages/stage2-classify-urls.js'
import { renderUrls } from '../packages/core/src/modules/clone-pro/v6/stages/stage3-headless-render.js'
import { dispatchBucketScrapers } from '../packages/core/src/modules/clone-pro/v6/stages/stage4-bucket-scrapers.js'
import { productShopifyScraper } from '../packages/core/src/modules/clone-pro/v6/scrapers/product-shopify.js'
import { productGenericScraper } from '../packages/core/src/modules/clone-pro/v6/scrapers/product-generic.js'
import { collectionShopifyScraper } from '../packages/core/src/modules/clone-pro/v6/scrapers/collection-shopify.js'
import { collectionGenericScraper } from '../packages/core/src/modules/clone-pro/v6/scrapers/collection-generic.js'
import { pageScraper } from '../packages/core/src/modules/clone-pro/v6/scrapers/page-scraper.js'
import { blogScraper } from '../packages/core/src/modules/clone-pro/v6/scrapers/blog-scraper.js'
import { menuScraper } from '../packages/core/src/modules/clone-pro/v6/scrapers/menu-scraper.js'
import { themeTokenScraper } from '../packages/core/src/modules/clone-pro/v6/scrapers/theme-token-scraper.js'

async function main() {
  const sourceUrl = process.env.SMOKE_SOURCE_URL ?? 'https://hydrogen-preview.myshopify.com'
  console.log(`Stage 1: discovering URLs from ${sourceUrl}`)
  const d = await discoverUrls({ sourceUrl, maxBfsPages: 50, maxBfsDepth: 2 })
  console.log(`  → ${d.urls.length} URLs (sitemap=${d.sitemapFound})`)

  const sample = d.urls.slice(0, 20).map((u) => u.sourceUrl)
  if (sample.length === 0) {
    console.log('FAIL — no URLs discovered')
    process.exit(1)
  }

  console.log(`Stage 2: classifying ${sample.length} URLs (Shopify pattern shortcut)`)
  const classifications = classifyUrlsByPattern(sample)

  let chromium: any
  try {
    const playwright = await import('playwright')
    chromium = playwright.chromium
  } catch (err) {
    console.log('Playwright not installed; run `npx playwright install chromium` and retry')
    process.exit(0)
  }

  console.log('Stage 3: rendering with Playwright Chromium...')
  const browser = await chromium.launch({ headless: true })
  try {
    const urls = sample.map((u, i) => ({ id: `q${i}`, sourceUrl: u }))
    const rendered = await renderUrls({ browser, urls, uploadScreenshot: async () => 'sha-placeholder' })

    const pagesWithClass = rendered
      .filter((p: any) => !p.error)
      .map((p: any) => ({
        ...p,
        classification: classifications[p.sourceUrl] ?? ('other' as const),
      }))

    console.log(`Stage 4: dispatching ${pagesWithClass.length} rendered pages to bucket scrapers`)
    const r = await dispatchBucketScrapers({
      pages: pagesWithClass,
      isShopify: true,
      scrapers: {
        products: [productShopifyScraper, productGenericScraper],
        collections: [collectionShopifyScraper, collectionGenericScraper],
        pages: [pageScraper],
        blog: [blogScraper],
        menu: menuScraper,
        theme: themeTokenScraper,
      },
    })

    console.log(`  products=${r.products.length} collections=${r.collections.length} pages=${r.pages.length} blog=${r.blogPosts.length} menu=${r.menu ? 'yes' : 'no'} theme=${r.themeTokens ? 'yes' : 'no'} errors=${r.errors.length}`)

    if (r.products.length === 0 && r.collections.length === 0) {
      console.log('FAIL — no products or collections extracted')
      process.exit(1)
    }

    console.log('Smoke pass — Stage 4 produces typed DTOs from Shopify HTML')
    process.exit(0)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('Smoke failed:', err)
  process.exit(2)
})
