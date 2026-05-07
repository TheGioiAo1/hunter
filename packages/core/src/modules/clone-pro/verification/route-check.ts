/**
 * Clone Pro v4 — Route Coverage Check (Phase 3.1)
 *
 * For every page type the discovery crawler saw, make sure the cloned
 * theme actually emitted a Liquid template that will handle it. The CSS
 * can be pixel-perfect, but if a merchant's customer hits /collections/sale
 * and there's no `templates/collection.liquid`, Shopify-style fallback
 * will 404 them.
 *
 * Score:
 *   - 100   every discovered page type has a matching template
 *   - 80    all non-critical types covered; `other` / `account` may be missing
 *   - ≤ 50  one of the critical types (product / collection / page / cart)
 *           is missing
 *
 * The critical/optional partition is opinionated but matches Shopify's
 * "required templates" list. Merchants can still pass verification without
 * `cart.liquid` if they don't run checkout through the cloned theme, so
 * missing `cart` is a warning, not critical.
 */

import type { DiscoveryResult } from '../pipeline-v4.js'
import type { PageType } from '../discovery/deep-crawler.js'
import type { CheckResult, Finding } from './types.js'

// ---------------------------------------------------------------------------
// What counts as "must have"
// ---------------------------------------------------------------------------

/** Page types that MUST have a template for the clone to be usable. */
const CRITICAL_PAGE_TYPES: readonly PageType[] = ['product', 'collection', 'page']

/** Page types that SHOULD have a template but don't block a pass. */
const IMPORTANT_PAGE_TYPES: readonly PageType[] = ['blog', 'blog-post', 'cart', 'search']

/** Page types that are optional — missing doesn't hurt the score. */
const OPTIONAL_PAGE_TYPES: readonly PageType[] = [
  'account', 'login', 'register', 'password', '404', 'other',
]

// ---------------------------------------------------------------------------
// PageType → template file key (matches template-detector.ts mapping)
// ---------------------------------------------------------------------------

const TEMPLATE_KEY_BY_PAGE_TYPE: Record<PageType, string> = {
  'home': 'templates/index.liquid',
  'product': 'templates/product.liquid',
  'collection': 'templates/collection.liquid',
  'list-collections': 'templates/list-collections.liquid',
  'page': 'templates/page.liquid',
  'blog': 'templates/blog.liquid',
  'blog-post': 'templates/article.liquid',
  'cart': 'templates/cart.liquid',
  'search': 'templates/search.liquid',
  'account': 'templates/customers/account.liquid',
  'login': 'templates/customers/login.liquid',
  'register': 'templates/customers/register.liquid',
  'policy': 'templates/page.policy.liquid',
  'password': 'templates/password.liquid',
  '404': 'templates/404.liquid',
  'other': 'templates/page.liquid',
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RouteCheckInput {
  /** Phase 1 discovery output — tells us which page types exist on the source. */
  readonly discovery: DiscoveryResult
  /** Keys of templates that Phase 2 actually persisted (e.g. 'templates/product.liquid'). */
  readonly writtenTemplateKeys: readonly string[]
}

/**
 * Run the route coverage check.
 *
 * The function is pure and synchronous — every input is already in memory
 * by the time we get here, and we don't want I/O during verification
 * reporting.
 */
export function runRouteCheck(input: RouteCheckInput): CheckResult {
  const started = Date.now()
  const findings: Finding[] = []

  const discoveredTypes = new Set<PageType>(
    input.discovery.pages.map((p) => p.pageType),
  )
  const writtenKeys = new Set(input.writtenTemplateKeys)

  // ── Missing critical templates — fail the check hard ────────────────
  let criticalMissing = 0
  for (const pt of CRITICAL_PAGE_TYPES) {
    if (!discoveredTypes.has(pt)) continue
    const expected = TEMPLATE_KEY_BY_PAGE_TYPE[pt]
    if (!writtenKeys.has(expected)) {
      criticalMissing++
      findings.push({
        category: 'route',
        severity: 'critical',
        message: `Missing critical template "${expected}" for discovered page type "${pt}".`,
        context: { pageType: pt, expectedTemplate: expected },
      })
    }
  }

  // ── Missing important templates — warning-level ─────────────────────
  let importantMissing = 0
  for (const pt of IMPORTANT_PAGE_TYPES) {
    if (!discoveredTypes.has(pt)) continue
    const expected = TEMPLATE_KEY_BY_PAGE_TYPE[pt]
    if (!writtenKeys.has(expected)) {
      importantMissing++
      findings.push({
        category: 'route',
        severity: 'warning',
        message: `Missing template "${expected}" for "${pt}" pages — storefront will 404 on these routes.`,
        context: { pageType: pt, expectedTemplate: expected },
      })
    }
  }

  // ── Optional templates — info-level ─────────────────────────────────
  for (const pt of OPTIONAL_PAGE_TYPES) {
    if (!discoveredTypes.has(pt)) continue
    const expected = TEMPLATE_KEY_BY_PAGE_TYPE[pt]
    if (!writtenKeys.has(expected)) {
      findings.push({
        category: 'route',
        severity: 'info',
        message: `Optional template "${expected}" for "${pt}" is missing — merchants can add later.`,
        context: { pageType: pt, expectedTemplate: expected },
      })
    }
  }

  // ── Homepage — special case: needs templates/index.liquid ────────────
  const hasHome = discoveredTypes.has('home') || input.discovery.pages.length > 0
  if (hasHome && !writtenKeys.has('templates/index.liquid')) {
    criticalMissing++
    findings.push({
      category: 'route',
      severity: 'critical',
      message: 'Missing homepage template "templates/index.liquid" — storefront has no root page.',
    })
  }

  // ── Layout — a theme without layout/theme.liquid can't render anything ─
  if (!writtenKeys.has('layout/theme.liquid')) {
    criticalMissing++
    findings.push({
      category: 'route',
      severity: 'critical',
      message: 'Missing "layout/theme.liquid" — templates will render without <html>/<head>/<body>.',
    })
  }

  // ── Scoring ─────────────────────────────────────────────────────────
  let score: number
  if (discoveredTypes.size === 0) {
    // Nothing discovered — we can't score coverage, but also nothing was
    // lost. Return 100 with an info finding so the check is "passed" but
    // surfaces the unusual situation.
    score = 100
    findings.push({
      category: 'route',
      severity: 'info',
      message: 'No pages discovered — route coverage not applicable.',
    })
  } else if (criticalMissing > 0) {
    // Each critical miss takes a big chunk off; floor at 0.
    score = Math.max(0, 100 - criticalMissing * 30 - importantMissing * 10)
  } else if (importantMissing > 0) {
    score = Math.max(60, 100 - importantMissing * 10)
  } else {
    score = 100
  }

  // Passing gate: no criticals + score ≥ 70.
  const passed = criticalMissing === 0 && score >= 70

  const summary = criticalMissing > 0
    ? `${criticalMissing} critical template(s) missing — storefront will not render all page types.`
    : importantMissing > 0
      ? `${importantMissing} non-critical template(s) missing.`
      : `All ${discoveredTypes.size} discovered page types are covered.`

  return {
    category: 'route',
    score,
    passed,
    summary,
    findings,
    durationMs: Date.now() - started,
  }
}

// ---------------------------------------------------------------------------
// Exposed for tests
// ---------------------------------------------------------------------------

export const __internal = {
  CRITICAL_PAGE_TYPES,
  IMPORTANT_PAGE_TYPES,
  OPTIONAL_PAGE_TYPES,
  TEMPLATE_KEY_BY_PAGE_TYPE,
}
