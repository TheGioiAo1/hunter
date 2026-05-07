/**
 * Clone Pro v4 — Verification Report Aggregator (Phase 3.6)
 *
 * Collapses the five individual check results into a single
 * `VerificationReport` — a weighted score, letter grade, flattened
 * findings list, and actionable recommendations.
 *
 * Grading band (weights total 100):
 *   - CSS class match:       40   (the signature v4 promise)
 *   - Asset integrity:       25
 *   - Route coverage:        20
 *   - External dependencies: 10
 *   - Content completeness:  5
 *
 * CSS match dominates because without it, none of the other wins
 * matter — the storefront looks broken.
 *
 * Letter grades:
 *   A: 90–100   (production-ready)
 *   B: 80–89    (minor tweaks)
 *   C: 70–79    (usable, issues documented)
 *   D: 60–69    (not ready for public launch)
 *   F:  0–59    (requires manual intervention)
 *
 * CRITICAL findings prevent ANY passing grade, dropping the clone to F
 * regardless of raw score. This is a safety net — e.g. a site that
 * scored 95 but leaks tracking pixels shouldn't be greenlit to launch.
 */

import type {
  CheckCategory,
  CheckResult,
  Finding,
  Grade,
  Severity,
  VerificationReport,
} from './types.js'

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const WEIGHTS: Readonly<Record<CheckCategory, number>> = {
  'css-match': 40,
  'asset': 25,
  'route': 20,
  'dependency': 10,
  'content': 5,
}

// Sum to 100 — guard the constant so refactors don't silently break scoring.
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0)
if (TOTAL_WEIGHT !== 100) {
  throw new Error(`[verification/report] WEIGHTS must sum to 100, got ${TOTAL_WEIGHT}`)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildReportInput {
  readonly checks: Readonly<Record<CheckCategory, CheckResult>>
  /** Total duration of all checks combined. */
  readonly durationMs: number
  /** Optional context for the text report header. */
  readonly shopId?: string
  readonly sourceUrl?: string
}

export function buildVerificationReport(input: BuildReportInput): VerificationReport {
  const { checks } = input

  // ── 1. Weighted overall score ────────────────────────────────────────
  let weightedSum = 0
  let weightUsed = 0
  for (const [cat, weight] of Object.entries(WEIGHTS) as Array<[CheckCategory, number]>) {
    const result = checks[cat]
    if (!result || result.score < 0) continue // skipped
    weightedSum += result.score * weight
    weightUsed += weight
  }
  const overallScore = weightUsed === 0 ? 0 : Math.round(weightedSum / weightUsed)

  // ── 2. Flatten + sort findings by severity then category ────────────
  const severityOrder: Record<Severity, number> = {
    critical: 0,
    error: 1,
    warning: 2,
    info: 3,
  }
  const allFindings: Finding[] = []
  for (const result of Object.values(checks)) {
    if (!result) continue
    allFindings.push(...result.findings)
  }
  allFindings.sort((a, b) => {
    const s = severityOrder[a.severity] - severityOrder[b.severity]
    if (s !== 0) return s
    return a.category.localeCompare(b.category)
  })

  // ── 3. Critical findings veto any passing grade ─────────────────────
  const hasCritical = allFindings.some((f) => f.severity === 'critical')

  // ── 4. Grade from score (with critical veto) ────────────────────────
  let grade: Grade
  if (hasCritical) {
    grade = 'F'
  } else if (overallScore >= 90) grade = 'A'
  else if (overallScore >= 80) grade = 'B'
  else if (overallScore >= 70) grade = 'C'
  else if (overallScore >= 60) grade = 'D'
  else grade = 'F'

  // ── 5. Recommendations ──────────────────────────────────────────────
  const recommendations = buildRecommendations(checks, allFindings, hasCritical)

  // ── 6. Text report ──────────────────────────────────────────────────
  const textReport = renderTextReport({
    checks,
    overallScore,
    grade,
    findings: allFindings,
    recommendations,
    hasCritical,
    shopId: input.shopId,
    sourceUrl: input.sourceUrl,
    durationMs: input.durationMs,
  })

  return {
    overallScore,
    grade,
    checks,
    findings: allFindings,
    recommendations,
    textReport,
    durationMs: input.durationMs,
    passed: !hasCritical && overallScore >= 70,
  }
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function buildRecommendations(
  checks: Readonly<Record<CheckCategory, CheckResult>>,
  findings: readonly Finding[],
  hasCritical: boolean,
): string[] {
  const recs: string[] = []

  if (hasCritical) {
    recs.push('Resolve all CRITICAL findings before launching — the storefront is not safe to serve in its current state.')
  }

  const routeFails = findings.filter(
    (f) => f.category === 'route' && (f.severity === 'critical' || f.severity === 'error'),
  )
  if (routeFails.length > 0) {
    recs.push(`Generate missing templates (${routeFails.length}) — either re-run Phase 2 with a richer discovery set, or hand-edit the theme.`)
  }

  const assetScore = checks.asset?.score ?? 100
  if (assetScore < 80 && assetScore >= 0) {
    recs.push('Re-run Phase 2 with a longer asset-download timeout; some CSS/font files did not arrive.')
  }

  const cssScore = checks['css-match']?.score ?? 100
  if (cssScore < 80 && cssScore >= 0) {
    recs.push('CSS class preservation is weak — inspect the affected templates and tune the html-to-liquid selectors to match the source structure.')
  }

  const dependencyFindings = findings.filter((f) => f.category === 'dependency')
  const trackingHits = dependencyFindings.filter((f) => f.severity === 'critical')
  if (trackingHits.length > 0) {
    recs.push(`Remove ${trackingHits.length} tracking host(s) still referenced in templates (gtm/fbq/klaviyo, etc).`)
  }
  const selfHostHits = dependencyFindings.filter((f) => f.severity === 'warning')
  if (selfHostHits.length > 0) {
    recs.push('Self-host remaining external CDN assets (Shopify CDN, unpkg, cdnjs) to remove third-party dependencies.')
  }

  const contentScore = checks.content?.score ?? 100
  if (contentScore < 85 && contentScore >= 0) {
    recs.push('Some pages / blog posts / collections failed to persist — inspect Phase 2 errors[] for the failing slugs.')
  }

  if (recs.length === 0) {
    recs.push('No recommendations — the clone is ready to preview.')
  }
  return recs
}

// ---------------------------------------------------------------------------
// Text report
// ---------------------------------------------------------------------------

function renderTextReport(input: {
  checks: Readonly<Record<CheckCategory, CheckResult>>
  overallScore: number
  grade: Grade
  findings: readonly Finding[]
  recommendations: readonly string[]
  hasCritical: boolean
  shopId?: string
  sourceUrl?: string
  durationMs: number
}): string {
  const lines: string[] = []
  lines.push('')
  lines.push('═══════════════════════════════════════════════════════════════════')
  lines.push('                  CLONE PRO v4 — VERIFICATION REPORT')
  lines.push('═══════════════════════════════════════════════════════════════════')
  if (input.sourceUrl) lines.push(`Source:   ${input.sourceUrl}`)
  if (input.shopId) lines.push(`Shop:     ${input.shopId}`)
  lines.push(`Duration: ${Math.round(input.durationMs)}ms`)
  lines.push('')
  lines.push(`Overall Score:  ${input.overallScore}/100`)
  lines.push(`Grade:          ${input.grade}${input.hasCritical ? ' (critical findings present)' : ''}`)
  lines.push(`Status:         ${input.hasCritical ? 'BLOCKED' : input.overallScore >= 70 ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push('── Per-check scores ────────────────────────────────────────────────')
  for (const cat of ['css-match', 'asset', 'route', 'dependency', 'content'] as const) {
    const c = input.checks[cat]
    if (!c) continue
    const weight = WEIGHTS[cat]
    const scoreText = c.score < 0 ? '  —' : `${String(c.score).padStart(3)}/100`
    const passMark = c.score < 0 ? '·' : c.passed ? '✓' : '✗'
    lines.push(
      `  ${passMark} ${cat.padEnd(12)} ${scoreText}  (weight ${String(weight).padStart(2)})  ${c.summary}`,
    )
  }
  lines.push('')

  // Top findings (up to 10 by severity)
  const topFindings = input.findings
    .filter((f) => f.severity === 'critical' || f.severity === 'error' || f.severity === 'warning')
    .slice(0, 10)
  if (topFindings.length > 0) {
    lines.push('── Top findings ────────────────────────────────────────────────────')
    for (const f of topFindings) {
      const marker = f.severity === 'critical'
        ? '!!'
        : f.severity === 'error'
          ? 'EE'
          : 'WW'
      lines.push(`  [${marker}] (${f.category}) ${f.message}`)
    }
    lines.push('')
  }

  lines.push('── Recommendations ─────────────────────────────────────────────────')
  for (const r of input.recommendations) {
    lines.push(`  • ${r}`)
  }
  lines.push('')
  lines.push('═══════════════════════════════════════════════════════════════════')
  return lines.join('\n')
}

export const __internal = { WEIGHTS }
