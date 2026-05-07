/**
 * Clone Pro — Scrapers barrel export
 *
 * All HTML scrapers for the Clone Pro pipeline:
 * - Page scraper (about, contact, policies, FAQ, custom pages)
 * - Menu scraper (main nav + footer nav)
 * - Collection scraper (category pages + product links)
 * - Blog scraper (blog posts + listing discovery)
 */

export { scrapePage, scrapePages } from './page-scraper.js'
export type { ScrapedPage, PageType } from './page-scraper.js'

export { scrapeMenus } from './menu-scraper.js'
export type { ScrapedMenuItem, ScrapedMenus } from './menu-scraper.js'

export { scrapeCollections, scrapeCollectionUrls } from './collection-scraper.js'
export type { ScrapedCollection } from './collection-scraper.js'

export {
  scrapeBlogPosts,
  scrapeBlogPostUrls,
  discoverBlogPostUrls,
} from './blog-scraper.js'
export type { ScrapedBlogPost } from './blog-scraper.js'

// Phase 2: CSS/Design scrapers
export { extractFullCSS } from './css-extractor.js'
export type { ExtractedCSS, ButtonStyle, CardStyle } from './css-extractor.js'

export { scrapeHeroes } from './hero-scraper.js'
export type { ScrapedHero } from './hero-scraper.js'

export { scrapeBrand } from './brand-scraper.js'
export type { ScrapedBrand } from './brand-scraper.js'

// Pixel-perfect scrapers (v2)
export { scrapeFullCSS } from './full-css-scraper.js'
export type { FullCSSResult } from './full-css-scraper.js'

export { cloneHomepage } from './homepage-cloner.js'
export type { ClonedSection, HomepageCloneResult } from './homepage-cloner.js'

export { scrapeShopifyNav } from './shopify-nav-scraper.js'
export type { ShopifyNavResult } from './shopify-nav-scraper.js'

export { scrapeShopifyCollectionProducts } from './shopify-collection-products.js'
export type { CollectionProductMap } from './shopify-collection-products.js'

// Clone Pro v3: Full Asset Clone
export { downloadAllAssets } from './full-asset-downloader.js'
export type { DownloadedAsset, AssetDownloadResult } from './full-asset-downloader.js'

export { cloneJavaScript } from './js-cloner.js'
export type { ClonedScript, JSCloneResult } from './js-cloner.js'

export { rewriteUrlsToLocal, convertLazyToEager } from './homepage-cloner.js'
