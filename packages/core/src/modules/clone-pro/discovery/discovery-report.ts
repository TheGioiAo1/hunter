/**
 * Clone Pro v4 — Discovery Report Generator (Phase 1.6)
 *
 * Generates a structured discovery report after the crawl + analysis phase.
 * This report is presented to the user for confirmation before proceeding
 * with the actual cloning pipeline.
 *
 * The report includes:
 *   - Site structure breakdown (page types and counts)
 *   - Template plan (what Liquid templates will be generated)
 *   - Asset inventory (CSS, JS, fonts, images)
 *   - Time/size estimates
 *   - Warnings about potential issues
 *   - A beautiful text report for human review
 */

import type { SiteMap, PageTypeStats } from './site-mapper.js'
import type { TemplateDetectionResult, DetectedTemplate } from './template-detector.js'
import type { AssetInventory, DiscoveredAsset } from './asset-scanner.js'

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Input data collected from the crawl + analysis phases */
export interface DiscoveryReportInput {
  /** Platform detection result */
  readonly platform: { platform: string; confidence: number }
  /** Full site map from the crawler */
  readonly siteMap: SiteMap
  /** Template detection results */
  readonly templates: TemplateDetectionResult
  /** Asset inventory from the scanner */
  readonly assets: AssetInventory
  /** Total crawl duration in milliseconds */
  readonly crawlDurationMs: number
  /** The original source URL that was crawled */
  readonly sourceUrl: string
}

/** The final discovery report presented to the user */
export interface DiscoveryReport {
  readonly sourceUrl: string
  readonly platform: string
  readonly platformConfidence: number
  readonly totalPages: number
  readonly pageTypeBreakdown: Record<string, number>
  readonly templateTypes: number
  readonly totalAssets: number
  readonly estimatedSizeMB: number
  readonly estimatedCloneTimeMinutes: number
  readonly warnings: string[]
  readonly textReport: string
  readonly clonePlan: ClonePlan
}

/** Plan describing what the clone operation will produce */
export interface ClonePlan {
  readonly templates: ClonePlanTemplate[]
  readonly assetsToDownload: number
  readonly dataToImport: {
    readonly products: number
    readonly collections: number
    readonly pages: number
    readonly blogPosts: number
    readonly menus: number
  }
}

/** A single template entry in the clone plan */
export interface ClonePlanTemplate {
  readonly templateName: string
  readonly sampleUrl: string
  readonly pageCount: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AVG_DOWNLOAD_SPEED_MBPS = 2
const TEMPLATE_GEN_OVERHEAD_SEC = 15
const PER_PAGE_PROCESSING_SEC = 0.5
const LARGE_SITE_THRESHOLD = 1000
const HIGH_JS_THRESHOLD = 15

const TRACKING_SCRIPT_PATTERNS: readonly RegExp[] = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /gtag/i,
  /ga\.js/i,
  /analytics\.js/i,
  /facebook\.net/i,
  /fbevents\.js/i,
  /connect\.facebook/i,
  /hotjar\.com/i,
  /clarity\.ms/i,
  /segment\.com/i,
  /mixpanel\.com/i,
  /amplitude\.com/i,
  /tiktok\.com.*analytics/i,
  /snap\.licdn\.com/i,
  /pinterest\.com.*pintrk/i,
]

/** Maps page types to human-readable labels (display order). */
const PAGE_TYPE_LABELS: Record<string, string> = {
  home: 'Homepage',
  product: 'Products',
  collection: 'Collections',
  'list-collections': 'Collections Index',
  page: 'Pages',
  blog: 'Blogs',
  'blog-post': 'Blog Posts',
  cart: 'Cart',
  search: 'Search',
  account: 'Account',
  login: 'Login',
  register: 'Register',
  policy: 'Policies',
  password: 'Password',
  '404': '404 Page',
  other: 'Other',
}

const DISPLAY_ORDER: readonly string[] = [
  'Homepage',
  'Collections',
  'Collections Index',
  'Products',
  'Pages',
  'Blogs',
  'Blog Posts',
  'Policies',
  'Account',
  'Login',
  'Register',
  'Cart',
  'Search',
  'Password',
  '404 Page',
  'Other',
]

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Generates a comprehensive discovery report from crawl + analysis data.
 *
 * @param input - Collected data from the discovery phase
 * @returns A complete discovery report with structured data and text output
 */
export function generateDiscoveryReport(input: DiscoveryReportInput): DiscoveryReport {
  const { platform, siteMap, templates, assets, crawlDurationMs, sourceUrl } = input

  // Build page type breakdown from siteMap.stats
  const pageTypeBreakdown = buildPageTypeBreakdown(siteMap.stats)
  const totalPages = siteMap.totalPages

  // Build clone plan from detected templates
  const clonePlan = buildClonePlan(templates, pageTypeBreakdown, siteMap)

  // Asset stats from inventory.summary
  const totalAssets = assets.summary.totalAssets
  const estimatedSizeMB = assets.summary.estimatedTotalSizeMB

  // Estimate clone time
  const estimatedCloneTimeMinutes = estimateCloneTime(
    totalPages,
    totalAssets,
    estimatedSizeMB,
    clonePlan.templates.length,
  )

  // Generate warnings
  const warnings = generateWarnings(siteMap, assets, pageTypeBreakdown, totalPages)

  // Build text report
  const textReport = buildTextReport({
    sourceUrl,
    platform: platform.platform,
    confidence: platform.confidence,
    totalPages,
    crawlDurationMs,
    pageTypeBreakdown,
    clonePlan,
    assetSummary: assets.summary,
    totalAssets,
    estimatedSizeMB,
    warnings,
    estimatedCloneTimeMinutes,
  })

  return {
    sourceUrl,
    platform: platform.platform,
    platformConfidence: platform.confidence,
    totalPages,
    pageTypeBreakdown,
    templateTypes: clonePlan.templates.length,
    totalAssets,
    estimatedSizeMB,
    estimatedCloneTimeMinutes,
    warnings,
    textReport,
    clonePlan,
  }
}

// ---------------------------------------------------------------------------
// Page Type Breakdown
// ---------------------------------------------------------------------------

/**
 * Converts PageTypeStats into a display-label-keyed record.
 */
function buildPageTypeBreakdown(stats: PageTypeStats): Record<string, number> {
  const result: Record<string, number> = {}

  for (const [type, count] of Object.entries(stats)) {
    if (type === 'total' || typeof count !== 'number' || count === 0) continue
    const label = PAGE_TYPE_LABELS[type] ?? 'Other'
    result[label] = (result[label] ?? 0) + count
  }

  return result
}

// ---------------------------------------------------------------------------
// Clone Plan Builder
// ---------------------------------------------------------------------------

/**
 * Builds the clone plan from detected templates.
 */
function buildClonePlan(
  templates: TemplateDetectionResult,
  pageBreakdown: Record<string, number>,
  siteMap: SiteMap,
): ClonePlan {
  const planTemplates: ClonePlanTemplate[] = []

  // Use detected templates
  for (const tpl of templates.templates) {
    planTemplates.push({
      templateName: tpl.templateName,
      sampleUrl: tpl.samplePage.url,
      pageCount: tpl.count,
    })
  }

  // If none detected, infer from page breakdown
  if (planTemplates.length === 0) {
    const typeToTemplate: Record<string, string> = {
      Homepage: 'templates/index.liquid',
      Products: 'templates/product.liquid',
      Collections: 'templates/collection.liquid',
      'Collections Index': 'templates/list-collections.liquid',
      Pages: 'templates/page.liquid',
      'Blog Posts': 'templates/article.liquid',
      Blogs: 'templates/blog.liquid',
      Policies: 'templates/page.policy.liquid',
      Cart: 'templates/cart.liquid',
      Search: 'templates/search.liquid',
      Account: 'templates/customers/account.liquid',
      Login: 'templates/customers/login.liquid',
      Register: 'templates/customers/register.liquid',
    }

    for (const [label, count] of Object.entries(pageBreakdown)) {
      const templateName = typeToTemplate[label]
      if (templateName && count > 0) {
        planTemplates.push({ templateName, sampleUrl: '', pageCount: count })
      }
    }
  }

  // Sort by page count descending
  planTemplates.sort((a, b) => b.pageCount - a.pageCount)

  return {
    templates: planTemplates,
    assetsToDownload: siteMap.totalPages > 0 ? Math.max(1, planTemplates.length) : 0,
    dataToImport: {
      products: pageBreakdown['Products'] ?? 0,
      collections: (pageBreakdown['Collections'] ?? 0) + (pageBreakdown['Collections Index'] ?? 0),
      pages: pageBreakdown['Pages'] ?? 0,
      blogPosts: pageBreakdown['Blog Posts'] ?? 0,
      menus: 2, // Assume header + footer
    },
  }
}

// ---------------------------------------------------------------------------
// Time Estimation
// ---------------------------------------------------------------------------

function estimateCloneTime(
  totalPages: number,
  totalAssets: number,
  estimatedSizeMB: number,
  templateCount: number,
): number {
  const downloadTimeSec = estimatedSizeMB / AVG_DOWNLOAD_SPEED_MBPS
  const templateTimeSec = templateCount * TEMPLATE_GEN_OVERHEAD_SEC
  const pageTimeSec = totalPages * PER_PAGE_PROCESSING_SEC
  const baseOverheadSec = 30
  const totalSec = downloadTimeSec + templateTimeSec + pageTimeSec + baseOverheadSec
  return Math.max(1, Math.ceil(totalSec / 60))
}

// ---------------------------------------------------------------------------
// Warning Generation
// ---------------------------------------------------------------------------

function generateWarnings(
  siteMap: SiteMap,
  assets: AssetInventory,
  pageBreakdown: Record<string, number>,
  totalPages: number,
): string[] {
  const warnings: string[] = []

  // Check for orphan pages
  if (siteMap.orphanPages.length > 0) {
    warnings.push(`${siteMap.orphanPages.length} orphan page(s) not linked from any other page`)
  }

  // Check for external tracking scripts
  const trackingScripts = detectTrackingScripts(assets.assets)
  if (trackingScripts.length > 0) {
    warnings.push(
      `${trackingScripts.length} external tracking script(s) detected (${trackingScripts.join(', ')}) — won't be cloned`,
    )
  }

  // Missing page types
  if (!pageBreakdown['Blog Posts'] && !pageBreakdown['Blogs']) {
    warnings.push('No blog/articles found — blog template will be skipped')
  }
  if (!pageBreakdown['Products']) {
    warnings.push('No product pages found — product data import will be skipped')
  }
  if (!pageBreakdown['Collections']) {
    warnings.push('No collection pages found — collection import will be skipped')
  }

  // Very large site
  if (totalPages > LARGE_SITE_THRESHOLD) {
    warnings.push(`Very large site (${totalPages} pages) — cloning may take significantly longer`)
  }

  // Lots of JS (potential SPA)
  const jsCount = assets.summary.jsFiles
  if (jsCount > HIGH_JS_THRESHOLD) {
    warnings.push(
      `High JavaScript count (${jsCount} scripts) — site may be a SPA which is harder to clone`,
    )
  }

  // Template warnings from the detector
  for (const w of ([] as string[]).concat(/* templates.warnings if available */)) {
    if (w) warnings.push(w)
  }

  return warnings
}

/**
 * Detects known tracking/analytics scripts in the asset list.
 */
function detectTrackingScripts(assets: DiscoveredAsset[]): string[] {
  const detected = new Set<string>()

  const nameMap: Record<string, string> = {
    'google-analytics': 'Google Analytics',
    googletagmanager: 'Google Tag Manager',
    'facebook.net': 'Facebook Pixel',
    fbevents: 'Facebook Pixel',
    hotjar: 'Hotjar',
    'clarity.ms': 'Microsoft Clarity',
    segment: 'Segment',
    mixpanel: 'Mixpanel',
    amplitude: 'Amplitude',
    tiktok: 'TikTok Analytics',
    licdn: 'LinkedIn Insight',
    pinterest: 'Pinterest Tag',
  }

  for (const asset of assets) {
    const url = (asset.absoluteUrl ?? asset.url ?? '').toLowerCase()
    if (!url) continue

    for (const pattern of TRACKING_SCRIPT_PATTERNS) {
      if (pattern.test(url)) {
        for (const [keyword, name] of Object.entries(nameMap)) {
          if (url.includes(keyword)) {
            detected.add(name)
            break
          }
        }
        break
      }
    }
  }

  return [...detected]
}

// ---------------------------------------------------------------------------
// Text Report Builder
// ---------------------------------------------------------------------------

interface TextReportData {
  sourceUrl: string
  platform: string
  confidence: number
  totalPages: number
  crawlDurationMs: number
  pageTypeBreakdown: Record<string, number>
  clonePlan: ClonePlan
  assetSummary: AssetInventory['summary']
  totalAssets: number
  estimatedSizeMB: number
  warnings: string[]
  estimatedCloneTimeMinutes: number
}

function buildTextReport(data: TextReportData): string {
  const lines: string[] = []
  const W = 62

  // Header box
  lines.push(`\u2554${'═'.repeat(W)}\u2557`)
  lines.push(`\u2551${centerText('CLONE PRO v4 — DISCOVERY REPORT', W)}\u2551`)
  lines.push(`\u2560${'═'.repeat(W)}\u2563`)
  lines.push(`\u2551${padRight(`  Source:    ${data.sourceUrl}`, W)}\u2551`)
  lines.push(`\u2551${padRight(`  Platform:  ${capitalize(data.platform)} (confidence: ${data.confidence}%)`, W)}\u2551`)
  lines.push(`\u2551${padRight(`  Crawled:   ${data.totalPages} pages in ${formatDuration(data.crawlDurationMs)}`, W)}\u2551`)
  lines.push(`\u255A${'═'.repeat(W)}\u255D`)
  lines.push('')

  // Site Structure
  lines.push('SITE STRUCTURE')
  lines.push('─'.repeat(20))
  for (const label of DISPLAY_ORDER) {
    const count = data.pageTypeBreakdown[label]
    if (count != null && count > 0) {
      lines.push(`  ${padRight(`${label}:`, 22)}${String(count).padStart(5)}`)
    }
  }
  lines.push(`  ${'─'.repeat(27)}`)
  lines.push(`  ${padRight('Total:', 22)}${String(data.totalPages).padStart(5)}`)
  lines.push('')

  // Templates to Create
  lines.push('TEMPLATES TO CREATE')
  lines.push('─'.repeat(24))
  for (let i = 0; i < data.clonePlan.templates.length; i++) {
    const tpl = data.clonePlan.templates[i]!
    const num = `${i + 1}.`
    const sample = tpl.sampleUrl ? ` (sample: ${truncateUrl(tpl.sampleUrl)})` : ''
    const pages = `${tpl.pageCount} page${tpl.pageCount !== 1 ? 's' : ''}`
    lines.push(`  ${padRight(num, 4)}${padRight(tpl.templateName, 36)}${pages}${sample}`)
  }
  lines.push('')

  // Assets to Download
  lines.push('ASSETS TO DOWNLOAD')
  lines.push('─'.repeat(22))
  const assetRows: Array<[string, number]> = [
    ['CSS', data.assetSummary.cssFiles],
    ['JS', data.assetSummary.jsFiles],
    ['Fonts', data.assetSummary.fontFiles],
    ['Images', data.assetSummary.imageFiles],
  ]
  for (const [label, count] of assetRows) {
    if (count > 0) {
      lines.push(`  ${padRight(`${label}:`, 12)}${String(count).padStart(5)} file${count !== 1 ? 's' : ''}`)
    }
  }
  // Other = total - known
  const knownCount = assetRows.reduce((s, [, c]) => s + c, 0)
  const otherCount = data.totalAssets - knownCount
  if (otherCount > 0) {
    lines.push(`  ${padRight('Other:', 12)}${String(otherCount).padStart(5)} file${otherCount !== 1 ? 's' : ''}`)
  }
  lines.push(`  ${'─'.repeat(27)}`)
  lines.push(`  ${padRight('Total:', 12)}${String(data.totalAssets).padStart(5)} assets (~${data.estimatedSizeMB} MB)`)
  lines.push('')

  // External Domains
  if (data.assetSummary.externalDomains.length > 0) {
    lines.push('EXTERNAL DOMAINS')
    for (const domain of data.assetSummary.externalDomains.slice(0, 10)) {
      lines.push(`  - ${domain}`)
    }
    if (data.assetSummary.externalDomains.length > 10) {
      lines.push(`  ... and ${data.assetSummary.externalDomains.length - 10} more`)
    }
    lines.push('')
  }

  // Warnings
  if (data.warnings.length > 0) {
    lines.push('WARNINGS')
    for (const warning of data.warnings) {
      lines.push(`  - ${warning}`)
    }
    lines.push('')
  }

  // Estimated Time
  lines.push(`ESTIMATED CLONE TIME: ~${data.estimatedCloneTimeMinutes} minute${data.estimatedCloneTimeMinutes !== 1 ? 's' : ''}`)
  lines.push('')
  lines.push('Awaiting confirmation to proceed...')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// String Utilities
// ---------------------------------------------------------------------------

function centerText(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width)
  const leftPad = Math.floor((width - text.length) / 2)
  const rightPad = width - text.length - leftPad
  return ' '.repeat(leftPad) + text + ' '.repeat(rightPad)
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function capitalize(str: string): string {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str
}

function truncateUrl(url: string, maxLen = 40): string {
  if (url.length <= maxLen) return url
  try {
    const u = new URL(url)
    return u.pathname.length > maxLen ? u.pathname.slice(0, maxLen - 3) + '...' : u.pathname
  } catch {
    return url.slice(0, maxLen - 3) + '...'
  }
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec} second${totalSec !== 1 ? 's' : ''}`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  if (seconds === 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`
  return `${minutes}m ${seconds}s`
}
