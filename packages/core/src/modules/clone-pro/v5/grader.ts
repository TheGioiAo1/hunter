/**
 * Clone Pro v5 — weighted composite grader
 *
 * Weights (spec §9):
 *   route_check        40%
 *   product_complete   25%
 *   css_token          15%
 *   page_body          10%
 *   menu_resolution    10%
 *
 * Bands: A ≥90 · B ≥75 · C ≥60 · D ≥45 · F <45
 */

import type { GradeResult } from './types.js'

export interface GradeInput {
  readonly routeCheckPct: number          // 0..1
  readonly productCompletenessPct: number
  readonly cssTokenPct: number
  readonly pageBodyPct: number
  readonly menuResolutionPct: number
}

export function gradeClone(input: GradeInput): GradeResult {
  const score =
    input.routeCheckPct * 40 +
    input.productCompletenessPct * 25 +
    input.cssTokenPct * 15 +
    input.pageBodyPct * 10 +
    input.menuResolutionPct * 10

  const letter: GradeResult['letter'] =
    score >= 90 ? 'A' :
    score >= 75 ? 'B' :
    score >= 60 ? 'C' :
    score >= 45 ? 'D' : 'F'

  const warnings: string[] = []
  if (input.routeCheckPct < 0.85) warnings.push(`Route check below target (${Math.round(input.routeCheckPct * 100)}% of URLs reachable)`)
  if (input.productCompletenessPct < 0.90) warnings.push(`Some products were not imported (${Math.round(input.productCompletenessPct * 100)}% coverage)`)
  if (input.cssTokenPct < 0.60) warnings.push(`Limited design-token extraction (${Math.round(input.cssTokenPct * 100)}%). Consider theme override.`)
  if (input.pageBodyPct < 0.80) warnings.push(`Some pages have empty body content`)
  if (input.menuResolutionPct < 0.75) warnings.push(`${Math.round((1 - input.menuResolutionPct) * 100)}% of menu links are unresolved`)

  return {
    score: Math.round(score * 100) / 100,
    letter,
    breakdown: {
      route_check_pct: input.routeCheckPct,
      product_completeness_pct: input.productCompletenessPct,
      css_token_pct: input.cssTokenPct,
      page_body_pct: input.pageBodyPct,
      menu_resolution_pct: input.menuResolutionPct,
    },
    warnings,
  }
}
