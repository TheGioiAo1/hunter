/**
 * Clone Pro v4 — Phase 3 (Verification) types
 *
 * Verification is the sanity pass that turns "we clicked the button" into
 * "the clone actually works." It runs AFTER discovery and execution and
 * answers five questions:
 *
 *   1. Route coverage — did the theme emit a template for every page type
 *      we discovered? (→ `routeCheck`)
 *   2. Asset integrity — did every discovered asset successfully land in
 *      the theme or object store? (→ `assetCheck`)
 *   3. Content completeness — are the pages/blog/collections we expected
 *      actually in the database? (→ `contentCheck`)
 *   4. External dependency audit — do the cloned templates still reference
 *      third-party hostnames (cdn.shopify.com, fontawesome, google fonts,
 *      stripe.js, etc.)? These need a follow-up to self-host or replace.
 *      (→ `dependencyCheck`)
 *   5. CSS class match — do the cloned templates use the same CSS classes
 *      as the source so the downloaded stylesheet applies? This is the
 *      single most important pixel-perfect-fidelity metric. (→ `cssCheck`)
 *
 * Each check produces:
 *   - `score`      A 0–100 number (higher = better). -1 means "skipped".
 *   - `passed`     Boolean — true if score ≥ checkThreshold and no critical
 *                  issues were detected.
 *   - `findings[]` Detail rows to present in the admin UI.
 *
 * The orchestrator aggregates all checks into a `VerificationReport` with
 * an overall grade (A/B/C/D/F) and actionable recommendations.
 *
 * Contract with callers:
 *   - Verification NEVER throws for data-shape issues — broken data just
 *     lowers the score and emits a critical finding.
 *   - Verification DOES throw if the database is unreachable; that's a
 *     programmer/infrastructure bug the caller can't meaningfully recover
 *     from mid-report.
 */

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/** Finding severity. `critical` blocks a passing grade regardless of score. */
export type Severity = 'info' | 'warning' | 'error' | 'critical'

// ---------------------------------------------------------------------------
// Check categories
// ---------------------------------------------------------------------------

export type CheckCategory =
  | 'route'
  | 'asset'
  | 'content'
  | 'dependency'
  | 'css-match'

// ---------------------------------------------------------------------------
// Finding — a single observation inside a check
// ---------------------------------------------------------------------------

export interface Finding {
  /** Which check produced this finding. */
  readonly category: CheckCategory
  /** How serious the issue is. */
  readonly severity: Severity
  /** Short human-readable summary. */
  readonly message: string
  /** Optional extra context (URL, asset key, selector, etc.). */
  readonly context?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Per-check result
// ---------------------------------------------------------------------------

export interface CheckResult {
  readonly category: CheckCategory
  /** Score 0–100. -1 means the check was skipped (e.g. no discovery data). */
  readonly score: number
  /** True if score meets threshold and no `critical` finding exists. */
  readonly passed: boolean
  /** Human-readable one-line summary. */
  readonly summary: string
  /** All findings — filter by severity in the UI. */
  readonly findings: readonly Finding[]
  /** Milliseconds spent on this check. */
  readonly durationMs: number
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

/** Overall grade computed from the weighted average of all check scores. */
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface VerificationReport {
  /** Overall weighted score 0–100. */
  readonly overallScore: number
  /** Letter grade derived from `overallScore`. */
  readonly grade: Grade
  /** Individual check results keyed by category for quick lookup. */
  readonly checks: Readonly<Record<CheckCategory, CheckResult>>
  /** All findings across every check, flattened and sorted by severity. */
  readonly findings: readonly Finding[]
  /** Actionable plain-English recommendations. */
  readonly recommendations: readonly string[]
  /** Plain-text multiline summary suitable for CLI output / email. */
  readonly textReport: string
  /** Total wall-clock time spent verifying. */
  readonly durationMs: number
  /** Did the clone pass the quality gate? (overallScore ≥ 70 && no critical) */
  readonly passed: boolean
}
