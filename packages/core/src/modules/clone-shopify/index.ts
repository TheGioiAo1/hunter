/**
 * clone-shopify — Shopify storefront ingestion primitives.
 *
 * This module was promoted from `Clone_pro/packages/clone-core` in
 * Phase 3 of the storefront cloner work. Clone_pro continues to
 * consume it via its sister-monorepo `@gbox/core` file: reference.
 *
 * Responsibilities:
 *   - SSRF-safe fetcher with private-IP denylist + redirect re-check
 *   - Shopify /products.json paginator + normaliser
 *   - Shopify /sitemap.xml nested index walker
 *
 * The module is intentionally DB-free. Callers own the persist step.
 */
export {
  safeFetch,
  isPrivateOrReservedIp,
  SafeFetchError,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from './safe-fetch.js';

export {
  crawlShopifyProducts,
  normaliseProduct,
  ShopifyCrawlError,
  type ShopifyCrawlOptions,
  type ShopifyProductRaw,
  type ShopifyProductsPageRaw,
  type ShopifyVariantRaw,
  type ShopifyImageRaw,
} from './crawler-products.js';

export {
  walkSitemap,
  inferKindFromSitemapUrl,
  SitemapCrawlError,
  type SitemapCrawlOptions,
} from './crawler-sitemap.js';

export type {
  CloneJobStatus,
  CloneJobOptions,
  CloneProductDTO,
  CloneImageDTO,
  CloneVariantDTO,
  CloneSitemapNode,
} from './types.js';
