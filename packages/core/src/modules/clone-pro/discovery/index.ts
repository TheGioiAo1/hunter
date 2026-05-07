/**
 * Clone Pro v4 — Discovery Module (Phase 1)
 *
 * Complete site reconnaissance before cloning:
 *   1.2 Deep Crawl     → Follow every internal link
 *   1.3 Site Map        → Build hierarchical tree
 *   1.4 Template Detect → Find page types & best samples
 *   1.5 Asset Scan      → Inventory all CSS/JS/fonts/images
 *   1.6 Report          → Human-readable discovery report
 *
 * @module clone-pro/discovery
 */

// ── Deep Crawler (Phase 1.2) ────────────────────────────────────
export {
  deepCrawl,
  type DeepCrawlOptions,
  type CrawlEvent,
  type DiscoveredPage,
  type PageType,
} from './deep-crawler.js'

// ── Site Mapper (Phase 1.3) ─────────────────────────────────────
export {
  buildSiteMap,
  printSiteMap,
  type SiteMap,
  type SiteMapNode,
  type PageTypeStats,
} from './site-mapper.js'

// ── Template Detector (Phase 1.4) ───────────────────────────────
export {
  detectTemplates,
  type TemplateDetectionResult,
  type DetectedTemplate,
  type TemplateCandidate,
} from './template-detector.js'

// ── Asset Scanner (Phase 1.5) ───────────────────────────────────
export {
  scanAssets,
  printAssetInventory,
  type AssetInventory,
  type DiscoveredAsset,
  type AssetType,
} from './asset-scanner.js'

// ── Discovery Report (Phase 1.6) ────────────────────────────────
export {
  generateDiscoveryReport,
  type DiscoveryReport,
  type DiscoveryReportInput,
  type ClonePlan,
  type ClonePlanTemplate,
} from './discovery-report.js'
