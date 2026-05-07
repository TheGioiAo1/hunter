/**
 * Clone Pro v4 — Verification Report Aggregator tests
 *
 * Locks down the scoring contract that the orchestrator and the admin
 * UI depend on:
 *
 *   - Weights sum to 100 and each category's contribution is correct.
 *   - Letter grades map to the right score bands (A ≥ 90, B ≥ 80, …).
 *   - Critical findings drop the grade to F regardless of score.
 *   - Skipped checks (score -1) are excluded from the weighted average.
 *   - Recommendations fire for the right failure modes.
 *   - Text report contains the expected structural headers.
 */

import { describe, it, expect } from 'vitest'
import { buildVerificationReport } from './report.js'
import type {
  CheckCategory,
  CheckResult,
  Finding,
  Severity,
} from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheck(
  category: CheckCategory,
  score: number,
  findings: readonly Finding[] = [],
): CheckResult {
  return {
    category,
    score,
    passed: score >= 70 && !findings.some((f) => f.severity === 'critical'),
    summary: `${category} score=${score}`,
    findings,
    durationMs: 1,
  }
}

function finding(
  category: CheckCategory,
  severity: Severity,
  message: string,
): Finding {
  return { category, severity, message }
}

/**
 * Build a full set of 5 checks with identical scores — the default base
 * when you just want to nudge one category and see what happens.
 */
function fullCheckSet(score: number): Record<CheckCategory, CheckResult> {
  return {
    'css-match': makeCheck('css-match', score),
    asset: makeCheck('asset', score),
    route: makeCheck('route', score),
    dependency: makeCheck('dependency', score),
    content: makeCheck('content', score),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildVerificationReport — weighted score', () => {
  it('returns the same score when all checks score equally', () => {
    const report = buildVerificationReport({
      checks: fullCheckSet(95),
      durationMs: 100,
    })
    expect(report.overallScore).toBe(95)
    expect(report.grade).toBe('A')
    expect(report.passed).toBe(true)
  })

  it('weights css-match 40x heavier than content (5)', () => {
    // css-match 100, everything else 0 → overall ≈ 40 (just the 40% weight).
    const checks: Record<CheckCategory, CheckResult> = {
      'css-match': makeCheck('css-match', 100),
      asset: makeCheck('asset', 0),
      route: makeCheck('route', 0),
      dependency: makeCheck('dependency', 0),
      content: makeCheck('content', 0),
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    // Weighted: (100*40 + 0 + 0 + 0 + 0) / 100 = 40
    expect(report.overallScore).toBe(40)
    expect(report.grade).toBe('F')
  })

  it('excludes skipped checks (score -1) from the weighted average', () => {
    // If content was skipped, the remaining 95 weight should determine
    // the score — not mix a sentinel -1 into the math.
    const checks: Record<CheckCategory, CheckResult> = {
      'css-match': makeCheck('css-match', 100),
      asset: makeCheck('asset', 100),
      route: makeCheck('route', 100),
      dependency: makeCheck('dependency', 100),
      content: makeCheck('content', -1),
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.overallScore).toBe(100)
    expect(report.grade).toBe('A')
  })
})

describe('buildVerificationReport — letter grades', () => {
  const cases = [
    { score: 100, grade: 'A' },
    { score: 90, grade: 'A' },
    { score: 89, grade: 'B' },
    { score: 80, grade: 'B' },
    { score: 79, grade: 'C' },
    { score: 70, grade: 'C' },
    { score: 69, grade: 'D' },
    { score: 60, grade: 'D' },
    { score: 59, grade: 'F' },
    { score: 0, grade: 'F' },
  ] as const

  for (const { score, grade } of cases) {
    it(`score ${score} → grade ${grade}`, () => {
      const report = buildVerificationReport({
        checks: fullCheckSet(score),
        durationMs: 1,
      })
      expect(report.grade).toBe(grade)
    })
  }
})

describe('buildVerificationReport — critical veto', () => {
  it('drops grade to F when any critical finding exists, regardless of score', () => {
    const checks = fullCheckSet(95) // Would normally be A.
    // Splice in a critical finding on the dependency check.
    ;(checks.dependency as any) = {
      ...checks.dependency,
      findings: [finding('dependency', 'critical', 'Tracking pixel still loaded.')],
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    // The raw score is untouched — still 95.
    expect(report.overallScore).toBe(95)
    // But grade = F and passed = false because of the critical.
    expect(report.grade).toBe('F')
    expect(report.passed).toBe(false)
  })

  it('includes a "resolve critical findings" recommendation when vetoed', () => {
    const checks = fullCheckSet(95)
    ;(checks.dependency as any) = {
      ...checks.dependency,
      findings: [finding('dependency', 'critical', 'GTM still present')],
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.recommendations.some((r) => r.toLowerCase().includes('critical'))).toBe(true)
  })
})

describe('buildVerificationReport — findings sort order', () => {
  it('orders findings critical > error > warning > info', () => {
    const checks = fullCheckSet(80)
    ;(checks.route as any) = {
      ...checks.route,
      findings: [
        finding('route', 'info', 'info msg'),
        finding('route', 'error', 'error msg'),
        finding('route', 'warning', 'warning msg'),
        finding('route', 'critical', 'critical msg'),
      ],
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    const severities = report.findings.map((f) => f.severity)
    const critIdx = severities.indexOf('critical')
    const errIdx = severities.indexOf('error')
    const warnIdx = severities.indexOf('warning')
    const infoIdx = severities.indexOf('info')
    expect(critIdx).toBeLessThan(errIdx)
    expect(errIdx).toBeLessThan(warnIdx)
    expect(warnIdx).toBeLessThan(infoIdx)
  })
})

describe('buildVerificationReport — recommendations', () => {
  it('recommends re-running asset download when asset score < 80', () => {
    const checks = fullCheckSet(90)
    ;(checks.asset as any) = makeCheck('asset', 60)
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.recommendations.some((r) => r.toLowerCase().includes('asset-download timeout'))).toBe(true)
  })

  it('recommends tuning html-to-liquid selectors when css-match < 80', () => {
    const checks = fullCheckSet(90)
    ;(checks['css-match'] as any) = makeCheck('css-match', 55)
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.recommendations.some((r) => r.toLowerCase().includes('html-to-liquid'))).toBe(true)
  })

  it('recommends removing tracking hosts when dependency has critical findings', () => {
    const checks = fullCheckSet(90)
    ;(checks.dependency as any) = {
      ...checks.dependency,
      findings: [
        finding('dependency', 'critical', 'gtm present'),
        finding('dependency', 'critical', 'fbq present'),
      ],
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    // Grade is F (critical veto) — and we should see a specific rec.
    expect(report.recommendations.some((r) => r.toLowerCase().includes('tracking host'))).toBe(true)
  })

  it('recommends self-hosting when dependency has warnings', () => {
    const checks = fullCheckSet(85)
    ;(checks.dependency as any) = {
      ...checks.dependency,
      findings: [finding('dependency', 'warning', 'cdn.shopify.com still referenced')],
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.recommendations.some((r) => r.toLowerCase().includes('self-host'))).toBe(true)
  })

  it('recommends re-running content persistence when content score < 85', () => {
    const checks = fullCheckSet(90)
    ;(checks.content as any) = makeCheck('content', 50)
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.recommendations.some((r) => r.toLowerCase().includes('pages'))).toBe(true)
  })

  it('returns a "ready to preview" line when no issues trigger a rec', () => {
    const report = buildVerificationReport({
      checks: fullCheckSet(100),
      durationMs: 1,
    })
    expect(report.recommendations.length).toBe(1)
    expect(report.recommendations[0].toLowerCase()).toContain('ready to preview')
  })

  it('recommends regenerating templates when route findings include critical/error', () => {
    const checks = fullCheckSet(90)
    ;(checks.route as any) = {
      ...checks.route,
      findings: [
        finding('route', 'critical', 'layout/theme.liquid missing'),
        finding('route', 'error', 'templates/product.liquid missing'),
      ],
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.recommendations.some((r) => r.toLowerCase().includes('missing templates'))).toBe(true)
  })
})

describe('buildVerificationReport — text report', () => {
  it('includes header markers, per-check scores, and recommendations', () => {
    const report = buildVerificationReport({
      checks: fullCheckSet(92),
      durationMs: 1234,
      shopId: 'shop_abc',
      sourceUrl: 'https://example.com',
    })
    const text = report.textReport
    expect(text).toContain('VERIFICATION REPORT')
    expect(text).toContain('Overall Score:')
    expect(text).toContain('shop_abc')
    expect(text).toContain('https://example.com')
    expect(text).toContain('css-match')
    expect(text).toContain('Recommendations')
  })

  it('marks status BLOCKED when a critical finding is present', () => {
    const checks = fullCheckSet(95)
    ;(checks.dependency as any) = {
      ...checks.dependency,
      findings: [finding('dependency', 'critical', 'GTM present')],
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.textReport).toContain('BLOCKED')
  })

  it('shows PASS for A/B/C and FAIL for D/F without criticals', () => {
    const passed = buildVerificationReport({
      checks: fullCheckSet(85),
      durationMs: 1,
    })
    expect(passed.textReport).toContain('PASS')

    const failed = buildVerificationReport({
      checks: fullCheckSet(40),
      durationMs: 1,
    })
    expect(failed.textReport).toContain('FAIL')
  })
})

describe('buildVerificationReport — passed flag', () => {
  it('is true when score ≥ 70 and no criticals', () => {
    const report = buildVerificationReport({
      checks: fullCheckSet(70),
      durationMs: 1,
    })
    expect(report.passed).toBe(true)
  })

  it('is false when score is 69', () => {
    const report = buildVerificationReport({
      checks: fullCheckSet(69),
      durationMs: 1,
    })
    expect(report.passed).toBe(false)
  })

  it('is false when any critical finding is present even at score 100', () => {
    const checks = fullCheckSet(100)
    ;(checks.dependency as any) = {
      ...checks.dependency,
      findings: [finding('dependency', 'critical', 'x')],
    }
    const report = buildVerificationReport({ checks, durationMs: 1 })
    expect(report.passed).toBe(false)
  })
})
