/**
 * Clone Pro — Crawlers barrel export
 *
 * Platform-specific and generic product crawlers:
 * - WooCommerce crawler (Store API → REST API → HTML fallback)
 * - HTML crawler (JSON-LD → OG → Microdata → DOM heuristics)
 */

export { crawlWooProducts } from './woo-crawler.js'
export { crawlHTMLProducts } from './html-crawler.js'
