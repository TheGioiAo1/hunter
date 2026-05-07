/**
 * Clone Pro — Universal Website Cloner Types
 *
 * Core type definitions for the Clone Pro pipeline. Designed so that
 * ANY website (not just Shopify) can be cloned with a single command.
 *
 * Architecture:
 *   User says "clone this website" →
 *   1. Detect platform (Shopify, WooCommerce, custom, static)
 *   2. Crawl structure (pages, products, collections, blog)
 *   3. Extract design (colors, fonts, layout, sections)
 *   4. Extract content (text, images, videos)
 *   5. Generate theme (Liquid templates matching source design)
 *   6. Import products + content
 *   7. Apply brand kit (colors, fonts, logo)
 *
 * AI Integration:
 *   Users can plug in their own AI API keys (OpenAI, Anthropic,
 *   Google) to power:
 *   - Intelligent layout recognition (screenshot → sections)
 *   - Content rewriting / localization
 *   - SEO optimization of cloned content
 *   - Smart image alt-text generation
 */

// ---------------------------------------------------------------------------
// Platform Detection
// ---------------------------------------------------------------------------

export type DetectedPlatform =
  | 'shopify'
  | 'woocommerce'
  | 'magento'
  | 'bigcommerce'
  | 'squarespace'
  | 'wix'
  | 'wordpress'
  | 'custom'
  | 'static'
  | 'unknown'

export interface PlatformDetectionResult {
  readonly platform: DetectedPlatform
  readonly confidence: number // 0-100
  readonly version?: string
  readonly evidence: readonly string[] // What clues led to this detection
}

// ---------------------------------------------------------------------------
// AI Provider Configuration (BYOK — Bring Your Own Key)
// ---------------------------------------------------------------------------

export type AIProvider = 'openai' | 'anthropic' | 'google' | 'none'

export interface AIProviderConfig {
  readonly provider: AIProvider
  readonly apiKey: string // Encrypted at rest via AES-256-GCM
  readonly model?: string // e.g. 'gpt-4o', 'claude-sonnet-4-20250514', 'gemini-2.0-flash'
  readonly baseUrl?: string // Custom endpoint for self-hosted models
  readonly maxTokens?: number
  readonly temperature?: number
}

export interface AICapabilities {
  /** Screenshot → structured layout analysis */
  readonly layoutAnalysis: boolean
  /** Generate alt-text for images */
  readonly imageAltText: boolean
  /** Rewrite/localize content */
  readonly contentRewriting: boolean
  /** SEO meta tag generation */
  readonly seoOptimization: boolean
  /** Smart section type detection from HTML */
  readonly sectionDetection: boolean
}

// ---------------------------------------------------------------------------
// Clone Job Configuration
// ---------------------------------------------------------------------------

export interface CloneProConfig {
  /** Source website URL to clone */
  readonly sourceUrl: string
  /** Target shop ID in our platform */
  readonly shopId: string
  /**
   * Optional storefront_clone_jobs.id. When set, the importer stamps
   * `clone_job_id` on every row it creates (products, pages, blog_posts,
   * collections, menus) so the store-admin can group them into
   * per-site tabs and the Discard action can cascade-delete them.
   *
   * Optional because tests construct CloneProConfig without a job row.
   * `runner.ts` always sets it in production.
   */
  readonly jobId?: string
  /** What to clone */
  readonly scope: CloneScope
  /** AI provider for intelligent cloning (optional) */
  readonly ai?: AIProviderConfig
  /** Max pages to crawl (safety limit) */
  readonly maxPages?: number
  /** Max products to import */
  readonly maxProducts?: number
  /** Whether to download and re-host images */
  readonly ingestMedia?: boolean
  /** Whether to extract and apply brand kit */
  readonly extractBrandKit?: boolean
  /** Whether to generate Liquid theme from design */
  readonly generateTheme?: boolean
  /** Locale for content (default: auto-detect) */
  readonly locale?: string
  /**
   * When present, skip every stage that runs BEFORE this one and
   * resume execution here. Only `apply_brand`, `seo_optimize`, and
   * `finalize` are valid resume points in V1 — they are the only
   * stages that read exclusively from the DB + config and therefore
   * don't need in-memory state from earlier stages. See `resume.ts`
   * for the full contract.
   */
  readonly resumeFromStage?: CloneStage
}

export interface CloneScope {
  readonly products: boolean
  readonly collections: boolean
  readonly pages: boolean
  readonly blog: boolean
  readonly navigation: boolean
  readonly theme: boolean
  readonly media: boolean
  readonly seo: boolean
}

export const DEFAULT_CLONE_SCOPE: CloneScope = {
  products: true,
  collections: true,
  pages: true,
  blog: false,
  navigation: true,
  theme: true,
  media: true,
  seo: true,
}

// ---------------------------------------------------------------------------
// Crawl Results
// ---------------------------------------------------------------------------

export interface CrawledPage {
  readonly url: string
  readonly title: string
  readonly type: 'home' | 'product' | 'collection' | 'page' | 'blog' | 'blog_post' | 'cart' | 'other'
  readonly html: string
  readonly statusCode: number
  readonly headers: Record<string, string>
  readonly crawledAt: string
}

export interface CrawledNavigation {
  readonly items: readonly NavigationItem[]
}

export interface NavigationItem {
  readonly label: string
  readonly url: string
  readonly children: readonly NavigationItem[]
}

export interface CrawledCollection {
  readonly handle: string
  readonly title: string
  readonly description: string
  readonly imageUrl: string | null
  readonly productCount: number
}

// ---------------------------------------------------------------------------
// Design Extraction
// ---------------------------------------------------------------------------

export interface ExtractedDesign {
  /** Color palette extracted from CSS/inline styles */
  readonly palette: {
    primary: string
    secondary: string
    accent: string
    background: string
    surface: string
    text: string
    textMuted: string
    border: string
    success: string
    error: string
    warning: string
  }
  /** Typography configuration */
  readonly typography: {
    headingFamily: string
    bodyFamily: string
    headingWeight: string
    bodyWeight: string
    baseSize: string
    lineHeight: string
    /** Google Fonts URLs detected */
    googleFontsUrls: readonly string[]
  }
  /** Layout information */
  readonly layout: {
    maxWidth: string
    containerPadding: string
    sectionGap: string
    gridColumns: number
    hasAnnouncement: boolean
    hasStickyHeader: boolean
    hasHero: boolean
    hasMegaMenu: boolean
    footerColumns: number
  }
  /** Detected sections in order of appearance */
  readonly sections: readonly DetectedSection[]
  /** Overall design style classification */
  readonly style: DesignStyle
}

export interface DetectedSection {
  readonly type: string // 'header', 'hero', 'featured-products', 'testimonials', etc.
  readonly position: number // Order on page (0-based)
  readonly estimatedHeight: string // CSS height estimate
  readonly classes: readonly string[] // Source CSS classes
  readonly aiDescription?: string // AI-generated description (when AI enabled)
}

export type DesignStyle =
  | 'minimal'
  | 'modern'
  | 'classic'
  | 'brutalist'
  | 'luxury'
  | 'playful'
  | 'editorial'
  | 'organic'
  | 'industrial'
  | 'retro'

// ---------------------------------------------------------------------------
// Clone Pipeline Stages
// ---------------------------------------------------------------------------

export type CloneStage =
  | 'detect'        // Platform detection
  | 'crawl'         // Crawl pages + sitemap
  | 'extract_design' // Extract colors, fonts, layout
  | 'extract_content' // Extract products, collections, pages
  | 'generate_theme' // Generate Liquid theme
  | 'import_data'    // Import products + content to DB
  | 'ingest_media'   // Download + re-host images
  | 'apply_brand'    // Apply brand kit to theme
  | 'seo_optimize'   // Generate SEO meta tags
  | 'finalize'       // Final checks + activate theme

export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface CloneStageResult {
  readonly stage: CloneStage
  readonly status: StageStatus
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly message?: string
  readonly data?: Record<string, unknown>
  readonly errorCode?: string
}

// ---------------------------------------------------------------------------
// Clone Job (Full Pipeline)
// ---------------------------------------------------------------------------

export interface CloneProJob {
  readonly id: string
  readonly shopId: string
  readonly sourceUrl: string
  readonly platform: DetectedPlatform
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly config: CloneProConfig
  readonly stages: readonly CloneStageResult[]
  readonly progressPct: number
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly result?: CloneProResult
  readonly errorCode?: string
  readonly errorMessage?: string
}

export interface CloneProResult {
  readonly platform: DetectedPlatform
  readonly pagesScraped: number
  readonly productsImported: number
  readonly collectionsImported: number
  readonly pagesImported: number
  readonly imagesIngested: number
  readonly themeGenerated: boolean
  readonly brandKitApplied: boolean
  readonly seoOptimized: boolean
  readonly duration_ms: number
}

// ---------------------------------------------------------------------------
// AI Analysis Results
// ---------------------------------------------------------------------------

export interface AILayoutAnalysis {
  /** Detected sections from screenshot analysis */
  readonly sections: readonly {
    type: string
    description: string
    boundingBox?: { x: number; y: number; width: number; height: number }
  }[]
  /** Overall design assessment */
  readonly designNotes: string
  /** Suggested Gbox theme sections to use */
  readonly suggestedSections: readonly string[]
  /** Confidence score 0-100 */
  readonly confidence: number
}

export interface AIContentAnalysis {
  /** Target audience assessment */
  readonly targetAudience: string
  /** Brand voice/tone */
  readonly brandVoice: string
  /** Key value propositions detected */
  readonly valueProps: readonly string[]
  /** Suggested improvements */
  readonly suggestions: readonly string[]
}
