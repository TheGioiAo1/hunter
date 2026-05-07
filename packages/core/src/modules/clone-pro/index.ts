/**
 * Clone Pro — Universal Website Cloner
 *
 * One command to clone any website:
 *
 *   import { cloneWebsite } from '@gbox/core/modules/clone-pro'
 *   const result = await cloneWebsite(db, {
 *     sourceUrl: 'https://example-store.com',
 *     shopId: 'shop_abc123',
 *   })
 *
 * Architecture:
 *
 *   ┌──────────────┐     ┌───────────────┐     ┌────────────────┐
 *   │   Pipeline   │ ──> │   Crawlers    │ ──> │  Extractors    │
 *   │  (pipeline)  │     │  (universal)  │     │  (design/AI)   │
 *   └──────┬───────┘     └───────────────┘     └────────────────┘
 *          │
 *          │  ┌──────────────────┐     ┌──────────────────┐
 *          └> │   AI Bridge      │     │  Platform Detect │
 *             │  (BYOK: OpenAI,  │     │  (Shopify, Woo,  │
 *             │   Anthropic,     │     │   Magento, etc.) │
 *             │   Google, none)  │     └──────────────────┘
 *             └──────────────────┘
 *
 * Modules:
 *   - types.ts             Core type definitions
 *   - platform-detector.ts Auto-detect website platform
 *   - ai-bridge.ts         BYOK AI integration (3 providers)
 *   - design-extractor.ts  Extract colors/fonts/layout/sections
 *   - universal-crawler.ts Crawl any website (products, pages, nav)
 *   - pipeline.ts          One-command orchestrator
 */

// ── Pipeline (top-level entry point) ──────────────────────────────
export {
  cloneWebsite,
  type ClonePipelineCallbacks,
  type ClonePipelineResult,
} from './pipeline.js'

// ── Dashboard read helpers (index/detail/stats UI) ────────────────
export {
  listActiveJobs,
  getReadyToPublishJobs,
  listJobHistory,
  getDashboardStats,
  averageGradeLabel,
  type DashboardJobRow,
  type JobHistoryOptions,
  type DashboardStats,
} from './dashboard-queries.js'

// ── Runner (bridges cloneWebsite → storefront_clone_jobs table) ───
export {
  runCloneProJob,
  resumeCloneProJob,
  type RunCloneProJobInput,
  type RunCloneProJobResult,
  type ResumeCloneProJobResult,
} from './runner.js'

// ── Resume helpers ────────────────────────────────────────────────
export {
  CLONE_STAGES_ORDER,
  RESUMABLE_STAGES,
  isResumableStage,
  stageIsBefore,
  computeResumeFromStage,
} from './resume.js'

// ── Platform Detection ────────────────────────────────────────────
export {
  detectPlatform,
} from './platform-detector.js'

// ── AI Bridge (BYOK) ─────────────────────────────────────────────
export {
  createAIBridge,
  AIBridgeError,
  type AIBridge,
  type ContentRewriteOptions,
  type SeoMeta,
} from './ai-bridge.js'

// ── Design Extraction ─────────────────────────────────────────────
export {
  extractDesign,
  type DesignExtractorInput,
} from './design-extractor.js'

// ── Universal Crawler ─────────────────────────────────────────────
export {
  crawlWebsite,
  type CrawlResult,
  type CrawlError,
  type CrawlProgress,
} from './universal-crawler.js'

// ── Types ─────────────────────────────────────────────────────────
export type {
  // Platform
  DetectedPlatform,
  PlatformDetectionResult,
  // AI
  AIProvider,
  AIProviderConfig,
  AICapabilities,
  AILayoutAnalysis,
  AIContentAnalysis,
  // Config
  CloneProConfig,
  CloneScope,
  // Crawl
  CrawledPage,
  CrawledNavigation,
  NavigationItem,
  CrawledCollection,
  // Design
  ExtractedDesign,
  DetectedSection,
  DesignStyle,
  // Pipeline
  CloneStage,
  StageStatus,
  CloneStageResult,
  CloneProJob,
  CloneProResult,
} from './types.js'

export { DEFAULT_CLONE_SCOPE } from './types.js'

// ── Scrapers (Phase 1: cheerio-based HTML scrapers) ──────────────
export {
  scrapePage,
  scrapePages,
  scrapeMenus,
  scrapeCollections,
  scrapeCollectionUrls,
  scrapeBlogPosts,
  scrapeBlogPostUrls,
  discoverBlogPostUrls,
  extractFullCSS,
  scrapeHeroes,
  scrapeBrand,
} from './scrapers/index.js'

// ── Persistence (Phase 4: content persistence layer) ─────────────
export {
  persistClonePages,
  persistCloneBlogPosts,
  persistCloneMenus,
  persistCloneCollections,
  persistCloneSEO,
} from './persist/index.js'

export type {
  PersistPagesResult,
  PersistBlogResult,
  PersistMenusResult,
  PersistCollectionsResult,
  CloneSEOData,
} from './persist/index.js'

// ── Theme Generator (Phase 5: Liquid theme from design data) ─────
export {
  generateThemeFromDesign,
  persistCloneTheme,
} from './theme-gen/index.js'

export type {
  ThemeTemplateSet,
  ThemeGeneratorInput,
} from './theme-gen/index.js'

// ── Crawlers (Phase 3: multi-platform product crawlers) ──────────
export {
  crawlWooProducts,
  crawlHTMLProducts,
} from './crawlers/index.js'

export type {
  ScrapedPage,
  PageType,
  ScrapedMenuItem,
  ScrapedMenus,
  ScrapedCollection,
  ScrapedBlogPost,
  ExtractedCSS,
  ButtonStyle,
  CardStyle,
  ScrapedHero,
  ScrapedBrand,
} from './scrapers/index.js'

// ── Clone Pro v4 — Three-Phase Pipeline ─────────────────────────
export {
  cloneWebsiteV4,
  runDiscovery,
  runExecution,
  runVerification,
  type CloneV4Phase,
  type PhaseStatus,
  type CloneV4Callbacks,
  type DiscoveryResult,
  type CloneV4Result,
  type ExecutionResult,
} from './pipeline-v4.js'

// ── v4 Execution Orchestrator ──────────────────────────────────
export type { ExecutionError } from './execution-v4.js'

// ── v4 HTML → Liquid Templatizer ──────────────────────────────
export { htmlToLiquid } from './html-to-liquid.js'
export type {
  TemplateChange,
  TemplatizeOptions,
  TemplatizeResult,
} from './html-to-liquid.js'

// ── v4 Verification (Phase 3) ─────────────────────────────────
export {
  runVerification as runVerificationChecks,
  runRouteCheck,
  runAssetCheck,
  runContentCheck,
  runDependencyCheck,
  runCssMatchCheck,
  buildVerificationReport,
} from './verification/index.js'

export type {
  CheckCategory,
  CheckResult,
  Finding,
  Grade,
  Severity,
  VerificationReport,
  RunVerificationInput,
  RouteCheckInput,
  AssetCheckInput,
  ContentCheckInput,
  DependencyCheckInput,
  CssMatchInput,
  BuildReportInput,
} from './verification/index.js'

// ── v4 Section Mapper (Gbox Dawn) ───────────────────────────────
export {
  composeIndexJson,
  getSectionCatalog,
  getSectionDef,
  sectionsInBucket,
  mainSectionForPageType,
  parseSectionSchema,
  detectHero,
  detectFeaturedCollection,
  detectImageWithText,
  detectNewsletter,
} from './section-mapper/index.js'

export type {
  SectionId,
  SectionBucket,
  SectionSetting,
  SectionSchema,
  SectionDef,
  SectionCatalog,
  DetectedSection,
  IndexJson,
  IndexJsonSection,
  ComposeIndexJsonInput,
  ComposeIndexJsonResult,
} from './section-mapper/index.js'

// ── v4 Discovery Module ─────────────────────────────────────────
export {
  deepCrawl,
  buildSiteMap,
  printSiteMap,
  detectTemplates,
  scanAssets,
  printAssetInventory,
  generateDiscoveryReport,
} from './discovery/index.js'

export type {
  DeepCrawlOptions,
  CrawlEvent,
  DiscoveredPage,
  SiteMap,
  SiteMapNode,
  PageTypeStats,
  TemplateDetectionResult,
  DetectedTemplate,
  TemplateCandidate,
  AssetInventory,
  DiscoveredAsset,
  AssetType,
  DiscoveryReport,
  DiscoveryReportInput,
  ClonePlan,
  ClonePlanTemplate,
} from './discovery/index.js'
