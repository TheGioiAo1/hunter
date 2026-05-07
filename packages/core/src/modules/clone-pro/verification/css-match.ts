/**
 * Clone Pro v4 — CSS Class Match Score (Phase 3.5)
 *
 * This is the central pixel-perfect-fidelity metric. The whole point of
 * v4's "scrape real HTML + inject Liquid" approach is that the source
 * site's CSS keeps working verbatim. That only holds if the cloned
 * templates still use the same CSS classes.
 *
 * How we measure:
 *
 *   1. For each detected template, take the original sample HTML
 *      (what the discovery crawler saw) and extract every `class` value.
 *   2. Take the Liquid template we emitted and extract every `class` value.
 *   3. Compute Jaccard-like coverage: what fraction of source classes
 *      appear in the output?
 *
 *   source classes ∩ output classes      ← we kept these
 *   ──────────────────────────────
 *   source classes                        ← how many we should have kept
 *
 * We don't penalise the output for having NEW classes (it's fine — Liquid
 * helpers occasionally add utility classes like `product-card__link`).
 *
 * Scoring:
 *   - 100%  every source class survived
 *   - 80%   lost up to 20% of classes — most CSS still applies
 *   - < 50% lost majority — theme likely renders unstyled
 */

import * as cheerio from 'cheerio'
import type { DetectedTemplate } from '../discovery/template-detector.js'
import type { CheckResult, Finding } from './types.js'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface CssMatchInput {
  /** Discovery-time per-type template samples (source HTML). */
  readonly templates: readonly DetectedTemplate[]
  /** Phase 2 output: template file key → template body. */
  readonly writtenTemplates: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Per-template coverage row
// ---------------------------------------------------------------------------

interface CoverageRow {
  readonly templateName: string
  readonly pageType: string
  readonly sourceClassCount: number
  readonly keptClassCount: number
  readonly ratio: number
  readonly missingClasses: readonly string[]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runCssMatchCheck(input: CssMatchInput): CheckResult {
  const started = Date.now()
  const findings: Finding[] = []
  const rows: CoverageRow[] = []

  for (const tpl of input.templates) {
    const writtenBody = input.writtenTemplates[tpl.templateName]
    if (writtenBody === undefined) {
      // Covered by route-check; skip here.
      continue
    }

    const sourceClasses = extractClasses(tpl.samplePage.html)
    const outputClasses = extractClasses(writtenBody)

    const kept: string[] = []
    const missing: string[] = []
    for (const cls of sourceClasses) {
      if (outputClasses.has(cls)) kept.push(cls)
      else missing.push(cls)
    }

    const ratio = sourceClasses.size === 0 ? 1 : kept.length / sourceClasses.size
    rows.push({
      templateName: tpl.templateName,
      pageType: tpl.pageType,
      sourceClassCount: sourceClasses.size,
      keptClassCount: kept.length,
      ratio,
      missingClasses: missing.slice(0, 20), // cap so findings stay small
    })

    const percent = Math.round(ratio * 100)
    const severity: Finding['severity'] =
      ratio < 0.5 ? 'error' : ratio < 0.8 ? 'warning' : 'info'
    findings.push({
      category: 'css-match',
      severity,
      message: `${tpl.templateName}: ${kept.length}/${sourceClasses.size} source CSS classes preserved (${percent}%).`,
      context: {
        templateName: tpl.templateName,
        pageType: tpl.pageType,
        percent,
        sampleMissing: missing.slice(0, 5),
      },
    })
  }

  if (rows.length === 0) {
    return {
      category: 'css-match',
      score: 100,
      passed: true,
      summary: 'No templates available to compare.',
      findings: [{
        category: 'css-match',
        severity: 'info',
        message: 'No detected templates intersect with persisted templates.',
      }],
      durationMs: Date.now() - started,
    }
  }

  // Overall score: weighted average by source-class count. Templates with
  // more classes (complex product/collection pages) dominate the score.
  const totalSourceClasses = rows.reduce((a, r) => a + r.sourceClassCount, 0)
  const totalKept = rows.reduce((a, r) => a + r.keptClassCount, 0)
  const weightedRatio = totalSourceClasses === 0 ? 1 : totalKept / totalSourceClasses
  const score = Math.round(weightedRatio * 100)

  // Pass gate: ≥ 80% weighted coverage.
  const passed = score >= 80

  const lowestRow = rows.reduce((lo, r) => (r.ratio < lo.ratio ? r : lo), rows[0])
  const summary = score >= 95
    ? `Excellent CSS fidelity: ${score}% of source classes preserved.`
    : score >= 80
      ? `Good CSS fidelity: ${score}% of source classes preserved. Weakest: ${lowestRow.templateName} (${Math.round(lowestRow.ratio * 100)}%).`
      : `Weak CSS fidelity: only ${score}% of source classes preserved. Templates will render mostly unstyled.`

  return {
    category: 'css-match',
    score,
    passed,
    summary,
    findings,
    durationMs: Date.now() - started,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract every CSS class name from an HTML string. Uses cheerio so we
 * correctly parse quoted class attributes, escaped chars, and compound
 * class lists (class="a b c").
 *
 * Returns a Set because duplicates don't improve coverage.
 */
function extractClasses(html: string): Set<string> {
  const out = new Set<string>()
  if (!html || html.trim() === '') return out

  let $: cheerio.CheerioAPI
  try {
    $ = cheerio.load(html, { decodeEntities: false })
  } catch {
    return out
  }

  $('[class]').each((_, el) => {
    const raw = ($(el).attr('class') ?? '').trim()
    if (!raw) return
    for (const cls of raw.split(/\s+/)) {
      const normalized = cls.trim()
      if (!normalized) continue
      // Skip Liquid-interpolated classes — the source side will have
      // literal values while the output uses {{ expr }} — they're not
      // directly comparable.
      if (normalized.startsWith('{{') || normalized.startsWith('{%')) continue
      // Skip classes containing Liquid control characters
      if (normalized.includes('{{') || normalized.includes('{%') || normalized.includes('}}') || normalized.includes('%}')) continue
      out.add(normalized)
    }
  })
  return out
}

export const __internal = { extractClasses }
