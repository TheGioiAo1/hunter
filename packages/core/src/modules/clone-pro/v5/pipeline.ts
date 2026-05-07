/**
 * Clone Pro v5 — pipeline orchestrator (phases ① → ⑨)
 *
 * Pure orchestrator. Delegates every side effect to injected scrapers,
 * persisters, and verify. Dependency injection keeps this unit-testable
 * without real HTTP/DB and lets real wiring live in `wired-runner.ts`.
 *
 * Phase map (spec §2):
 *   ① detect      — platform probe (Shopify-only in PR1)
 *   ② discover    — fetch homepage (seed for menu + theme + URL harvest)
 *   ③ scrape      — products + collections + pages + menu + theme tokens
 *   ④ validate    — R3 anti-mix guardrails + menu resolution flags
 *   ⑤ persist     — `persistAll(…)` runs inside `withSerializable`
 *   ⑥ asset_rehost — DEFERRED to PR3
 *   ⑦ preview     — mount preview subdomain
 *   ⑧ verify      — route-check every imported URL
 *   ⑨ grade       — weighted composite score + DESIGN.md export
 */

import type {
  Platform,
  ScrapedProduct,
  ScrapedCollection,
  ScrapedPage,
  MenuTree,
  ThemeTokens,
  PipelineContext,
  GradeResult,
} from './types.js'
import type { FlaggedMenuTree } from './validate/guardrails.js'
import {
  validateProducts,
  validateCollections,
  validatePages,
  validateMenuTree,
} from './validate/guardrails.js'
import { gradeClone } from './grader.js'
import { exportDesignMd } from './design-md-export.js'

export interface PipelineDeps {
  readonly scrapers: {
    readonly detectPlatform: (url: string) => Promise<Platform>
    readonly fetchHomepage: (url: string) => Promise<string>
    readonly scrapeProducts: (url: string) => Promise<readonly ScrapedProduct[]>
    readonly scrapeCollections: (url: string) => Promise<readonly ScrapedCollection[]>
    readonly scrapePages: (url: string) => Promise<readonly ScrapedPage[]>
    readonly parseMenu: (html: string, url: string) => MenuTree
    readonly extractTokens: (html: string) => ThemeTokens
  }
  readonly persisters: {
    readonly persistAll: (args: {
      shopId: string
      jobId: string
      products: readonly ScrapedProduct[]
      collections: readonly ScrapedCollection[]
      pages: readonly ScrapedPage[]
      menuTree: FlaggedMenuTree
      themeTokens: ThemeTokens
    }) => Promise<{
      productsInserted: number
      collectionsInserted: number
      pagesInserted: number
      menuItems: number
    }>
    readonly mountPreview: (jobId: string) => Promise<string>
  }
  readonly verify: {
    readonly routeCheck: (urls: readonly string[]) => Promise<{
      total: number
      passCount: number
      passRate: number
      failures: readonly { url: string; reason: string }[]
    }>
  }
}

export interface PipelineResult {
  readonly platform: Platform
  readonly previewUrl: string
  readonly grade: GradeResult
  readonly designMd: string
  readonly stats: {
    readonly productsImported: number
    readonly productsDiscovered: number
    readonly collectionsImported: number
    readonly pagesImported: number
    readonly menuItems: number
    readonly menuBroken: number
  }
}

export async function runCloneProV5(
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  // ① Detect
  const platform = await deps.scrapers.detectPlatform(ctx.sourceUrl)
  if (platform === 'unknown') {
    throw new Error('Platform detection failed (unknown)')
  }
  if (platform !== 'shopify') {
    // v5 PR1 scope is Shopify-only; PR2 extends to woo/generic.
    throw new Error(`Platform '${platform}' not supported in PR1 (Shopify-only)`)
  }

  // ② Discover — homepage HTML seeds menu parsing + theme extraction.
  const homepageHtml = await deps.scrapers.fetchHomepage(ctx.sourceUrl)

  // ③ Scrape — sequence the 3 API-driven scrapers so test order is
  // deterministic; the network side effects are cheap to await in series
  // and the guardrails later don't care about wall-clock ordering.
  const rawProducts = ctx.scope.products
    ? await deps.scrapers.scrapeProducts(ctx.sourceUrl)
    : []
  const rawCollections = ctx.scope.collections
    ? await deps.scrapers.scrapeCollections(ctx.sourceUrl)
    : []
  const rawPages = ctx.scope.pages
    ? await deps.scrapers.scrapePages(ctx.sourceUrl)
    : []
  const menuTree: MenuTree = ctx.scope.menu
    ? deps.scrapers.parseMenu(homepageHtml, ctx.sourceUrl)
    : { handle: 'main-menu', nodes: [] }
  const themeTokens: ThemeTokens = ctx.scope.theme
    ? deps.scrapers.extractTokens(homepageHtml)
    : emptyTokens()

  // ④ Validate — R3 anti-mix guardrails + menu link resolution.
  const productsV = validateProducts(rawProducts)
  const collectionsV = validateCollections(rawCollections)
  const pagesV = validatePages(rawPages)

  // Build imported URL set so menu validation can mark unresolved links.
  const importedUrls = new Set<string>([
    ...productsV.accepted.map((p) => `${ctx.sourceUrl}/products/${p.handle}`),
    ...collectionsV.accepted.map(
      (c) => `${ctx.sourceUrl}/collections/${c.handle}`,
    ),
    ...pagesV.accepted.map((p) => p.url),
  ])
  const menuV = validateMenuTree(menuTree, importedUrls)

  // ⑤ Persist — the caller (`wired-runner`) wraps `persistAll` inside
  // `runCloneImport` → `withSerializable`. The orchestrator stays pure.
  const persistStats = await deps.persisters.persistAll({
    shopId: ctx.shopId,
    jobId: ctx.jobId,
    products: productsV.accepted,
    collections: collectionsV.accepted,
    pages: pagesV.accepted,
    menuTree: menuV.tree,
    themeTokens,
  })

  // ⑥ Asset rehost — DEFERRED (PR3 scope).

  // ⑦ Preview mount — returns the canonical preview URL (DNS/route
  // wiring happens in the worker).
  const previewUrl = await deps.persisters.mountPreview(ctx.jobId)

  // ⑧ Verify — route-check every imported URL after rewriting to preview.
  const routesToCheck = Array.from(importedUrls).map((u) =>
    rewriteToPreview(u, previewUrl),
  )
  const routeResult = await deps.verify.routeCheck(routesToCheck)

  // ⑨ Grade — weighted composite (route 40% + product 25% + css 15% +
  // page 10% + menu 10%). Divisors guard against div-by-zero for empty
  // buckets (policy: empty bucket = perfect score for that slot).
  const grade = gradeClone({
    routeCheckPct: routeResult.passRate,
    productCompletenessPct:
      rawProducts.length === 0
        ? 1
        : persistStats.productsInserted / rawProducts.length,
    cssTokenPct: themeTokenCoverage(themeTokens),
    pageBodyPct:
      pagesV.accepted.length === 0
        ? 1
        : pagesV.accepted.filter((p) => p.body_html.trim().length > 0).length /
          pagesV.accepted.length,
    menuResolutionPct:
      countNodes(menuTree.nodes) === 0
        ? 1
        : 1 - menuV.brokenCount / countNodes(menuTree.nodes),
  })

  // DESIGN.md export (D11). Uses sourceHost as the shop name heading;
  // Iron Rule 5 inside exportDesignMd ensures no internal tooling
  // surfaces in the generated markdown.
  const designMd = exportDesignMd({
    shopName: ctx.sourceHost,
    tokens: themeTokens,
  })

  return {
    platform,
    previewUrl,
    grade,
    designMd,
    stats: {
      productsImported: persistStats.productsInserted,
      productsDiscovered: rawProducts.length,
      collectionsImported: persistStats.collectionsInserted,
      pagesImported: persistStats.pagesInserted,
      menuItems: persistStats.menuItems,
      menuBroken: menuV.brokenCount,
    },
  }
}

function emptyTokens(): ThemeTokens {
  return {
    colors: { primary: null, secondary: null, background: null, text: null },
    typography: { heading_family: null, body_family: null, base_size_px: null },
    spacing: { base_px: null },
    radius_px: null,
    raw_css_vars: {},
  }
}

function themeTokenCoverage(t: ThemeTokens): number {
  const slots = [
    t.colors.primary,
    t.colors.secondary,
    t.colors.background,
    t.colors.text,
    t.typography.heading_family,
    t.typography.body_family,
    t.spacing.base_px,
    t.radius_px,
  ]
  return slots.filter((v) => v != null).length / slots.length
}

/**
 * Deep-count menu nodes (root + every descendant). Used by the grader
 * to compute menu_resolution_pct = 1 - brokenCount / totalNodes.
 */
function countNodes(
  nodes: readonly { children: readonly any[] }[],
): number {
  let n = 0
  for (const node of nodes) {
    n++
    if (node.children.length > 0) n += countNodes(node.children as any)
  }
  return n
}

function rewriteToPreview(sourceUrl: string, previewBase: string): string {
  try {
    const u = new URL(sourceUrl)
    return new URL(u.pathname + u.search, previewBase).toString()
  } catch {
    return sourceUrl
  }
}
