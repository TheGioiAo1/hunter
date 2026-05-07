/**
 * Gbox Platform — Phase Smoke Matrix helpers (Phase 11 PR2)
 *
 * Pure pieces the `scripts/ops/smoke-matrix.ts` orchestrator uses to:
 *   - discover `scripts/smoke-phaseN-prM.ts` files
 *   - parse their phase/pr tuple from the filename
 *   - compare a fresh run against the committed baseline
 *   - render a grid report
 *
 * Everything here is I/O-free. Callers inject the file list + baseline
 * JSON + per-smoke results. That keeps unit tests fast and the CLI
 * layer thin.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmokeEntry {
  /** File stem, e.g. `smoke-phase11-pr1`. */
  name: string
  /** Major phase, parsed from filename (2..11+). */
  phase: number
  /** PR number within the phase (1..N). */
  pr: number
}

export interface SmokeRunResult extends SmokeEntry {
  /** Exit code of the child `npx tsx` invocation. 0 = pass. */
  exitCode: number
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /**
   * True iff the smoke passed. We accept a small grace window — exit 0
   * is pass, anything else (including signals, timeouts) is fail.
   */
  ok: boolean
  /** Optional note for the table row — e.g. `'skipped — DATABASE_URL unset'`. */
  note?: string
}

export interface SmokeBaselineEntry {
  name: string
  expectedPass: boolean
  /**
   * Free-form note — why this baseline exists or what it excuses.
   * Surfaced in the diff output so reviewers can tell at a glance
   * whether a red cell is known.
   */
  note?: string
}

export interface SmokeBaseline {
  /** When the baseline was last generated / refreshed. */
  updatedAt: string
  /** One entry per smoke file, keyed by file stem. */
  entries: SmokeBaselineEntry[]
}

export interface MatrixDiff {
  /** Smokes that ran red but the baseline said should pass. */
  regressions: SmokeRunResult[]
  /** Smokes that ran green that the baseline said should fail. */
  unexpectedPasses: SmokeRunResult[]
  /** Smokes present in results but absent from baseline. */
  missingFromBaseline: SmokeRunResult[]
  /** Baseline entries that didn't match any run result. */
  missingFromResults: SmokeBaselineEntry[]
  /** True iff regressions.length === 0 (unexpected passes + missing are warnings, not failures). */
  isClean: boolean
}

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

/**
 * Parse a smoke file stem into a `{ phase, pr }` tuple.
 *
 *   'smoke-phase11-pr1'     → { phase: 11,   pr: 1    }
 *   'smoke-phase7-pr5'      → { phase: 7,    pr: 5    }
 *   'smoke-phase12-5-pr2'   → { phase: 12.5, pr: 2    }   (decimal-phase PR)
 *   'smoke-phase14-pr1-5'   → { phase: 14,   pr: 1.5  }   (mid-PR hotfix/split)
 *   'smoke-phase14-pr4b'    → { phase: 14,   pr: 4.01 }   (alpha suffix; a=.01, b=.02…)
 *   'smoke-http-step-1-20'  → null                        (legacy naming, excluded)
 *
 * The canonical format is `smoke-phaseN[-M]-prP[-Q][ALPHA]`: an integer
 * phase optionally followed by `-M` (phase fraction, e.g. 12-5 → 12.5),
 * a PR integer, optionally `-Q` (PR fraction, e.g. pr1-5 → 1.5) OR a
 * single-letter alpha suffix (pr4b → 4.02). The alpha suffix lets
 * emergency follow-ups slot between two numbered PRs without renumbering
 * downstream baseline entries. `.ts` may or may not be included here.
 */
export function parseSmokeName(stem: string): { phase: number; pr: number } | null {
  // Canonical: phaseN[-M]-prP[-Q|alpha]
  const m = /^smoke-phase(\d+)(?:-(\d+))?-pr(\d+)(?:-(\d+))?([a-z])?$/.exec(stem)
  if (!m) return null
  const phaseStr = m[2] ? `${m[1]}.${m[2]}` : m[1]!
  // PR sort key: start with the integer PR. If a numeric suffix exists
  // (`pr1-5` → 1.5) use it; otherwise if an alpha suffix exists
  // (`pr4b` → 4.02) encode letters as hundredths so `a<b<c<…` sorts
  // between the integer PRs.
  let prNum = Number(m[3])
  if (m[4]) {
    prNum = Number(`${m[3]}.${m[4]}`)
  } else if (m[5]) {
    const ord = m[5].charCodeAt(0) - 'a'.charCodeAt(0) + 1 // a=1, b=2, …
    prNum = Number(m[3]) + ord / 100
  }
  return { phase: Number(phaseStr), pr: prNum }
}

/**
 * Given a raw list of filenames (with or without `.ts`), return sorted
 * `SmokeEntry`s matching the canonical `smoke-phaseN-prM[.ts]` pattern.
 * Legacy smoke files (`smoke-http-step-1-20.ts`, `smoke-liquid-*.ts`)
 * are silently filtered out — they're per-step probes not per-PR.
 */
export function discoverSmokes(filenames: readonly string[]): SmokeEntry[] {
  const entries: SmokeEntry[] = []
  for (const raw of filenames) {
    const stem = raw.replace(/\.ts$/, '')
    const parsed = parseSmokeName(stem)
    if (!parsed) continue
    entries.push({ name: stem, phase: parsed.phase, pr: parsed.pr })
  }
  entries.sort((a, b) => (a.phase - b.phase) || (a.pr - b.pr))
  return entries
}

// ---------------------------------------------------------------------------
// Baseline diff
// ---------------------------------------------------------------------------

export function compareToBaseline(
  baseline: SmokeBaseline,
  results: readonly SmokeRunResult[],
): MatrixDiff {
  const baselineByName = new Map<string, SmokeBaselineEntry>()
  for (const e of baseline.entries) baselineByName.set(e.name, e)

  const resultsByName = new Map<string, SmokeRunResult>()
  for (const r of results) resultsByName.set(r.name, r)

  const regressions: SmokeRunResult[] = []
  const unexpectedPasses: SmokeRunResult[] = []
  const missingFromBaseline: SmokeRunResult[] = []

  for (const r of results) {
    const b = baselineByName.get(r.name)
    if (!b) {
      missingFromBaseline.push(r)
      continue
    }
    if (b.expectedPass && !r.ok) regressions.push(r)
    if (!b.expectedPass && r.ok) unexpectedPasses.push(r)
  }

  const missingFromResults: SmokeBaselineEntry[] = []
  for (const b of baseline.entries) {
    if (!resultsByName.has(b.name)) missingFromResults.push(b)
  }

  return {
    regressions,
    unexpectedPasses,
    missingFromBaseline,
    missingFromResults,
    isClean: regressions.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Baseline builder
// ---------------------------------------------------------------------------

/**
 * Produce a fresh baseline from a list of discovered smokes. Every
 * entry defaults to `expectedPass=true` — the contract is that every
 * landed smoke is expected to be green. Callers that want to mark a
 * smoke as known-red override after the fact.
 */
export function buildBaseline(
  entries: readonly SmokeEntry[],
  updatedAt: string,
): SmokeBaseline {
  return {
    updatedAt,
    entries: entries
      .map((e) => ({ name: e.name, expectedPass: true }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/**
 * Merge a freshly discovered set into an existing baseline. Existing
 * entries keep their `expectedPass` + `note` (so hand-annotated known-red
 * rows don't get wiped by `--update-baseline`). New smokes are added
 * with `expectedPass=true`.
 */
export function mergeBaseline(
  prev: SmokeBaseline,
  entries: readonly SmokeEntry[],
  updatedAt: string,
): SmokeBaseline {
  const prevByName = new Map<string, SmokeBaselineEntry>()
  for (const e of prev.entries) prevByName.set(e.name, e)

  const next: SmokeBaselineEntry[] = []
  for (const e of entries) {
    const existing = prevByName.get(e.name)
    if (existing) {
      next.push(existing)
    } else {
      next.push({ name: e.name, expectedPass: true })
    }
  }
  next.sort((a, b) => a.name.localeCompare(b.name))
  return { updatedAt, entries: next }
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

export function formatMatrixReport(
  results: readonly SmokeRunResult[],
  diff: MatrixDiff,
): string {
  const lines: string[] = []
  lines.push('  Gbox Platform — Phase Smoke Matrix')
  lines.push('-'.repeat(60))

  if (results.length === 0) {
    lines.push('  (no smokes discovered — expected scripts/smoke-phaseN-prM.ts)')
    lines.push('-'.repeat(60))
    lines.push('0/0 smokes passed')
    return lines.join('\n')
  }

  // Group by phase for the grid
  const byPhase = new Map<number, SmokeRunResult[]>()
  for (const r of results) {
    const list = byPhase.get(r.phase) ?? []
    list.push(r)
    byPhase.set(r.phase, list)
  }

  const phases = [...byPhase.keys()].sort((a, b) => a - b)
  for (const phase of phases) {
    const rows = (byPhase.get(phase) ?? []).slice().sort((a, b) => a.pr - b.pr)
    const cells = rows.map((r) => {
      const mark = r.ok ? 'OK' : 'FAIL'
      return `PR${r.pr}:${mark}(${r.durationMs}ms)`
    })
    lines.push(`  Phase ${String(phase).padStart(2, ' ')}  ${cells.join('  ')}`)
  }

  lines.push('')
  if (diff.regressions.length > 0) {
    lines.push(`[REGRESSION] ${diff.regressions.length} smoke(s) failed that the baseline expected to pass:`)
    for (const r of diff.regressions) lines.push(`  - ${r.name} (exit=${r.exitCode})`)
    lines.push('')
  }
  if (diff.unexpectedPasses.length > 0) {
    lines.push(`[INFO] ${diff.unexpectedPasses.length} smoke(s) passed that the baseline marks as expected-fail:`)
    for (const r of diff.unexpectedPasses) lines.push(`  - ${r.name}`)
    lines.push('  → consider flipping expectedPass to true in smoke-baseline.json')
    lines.push('')
  }
  if (diff.missingFromBaseline.length > 0) {
    lines.push(`[INFO] ${diff.missingFromBaseline.length} smoke(s) ran but aren't in baseline:`)
    for (const r of diff.missingFromBaseline) lines.push(`  - ${r.name}`)
    lines.push('  → run with --update-baseline to add them')
    lines.push('')
  }
  if (diff.missingFromResults.length > 0) {
    lines.push(`[INFO] ${diff.missingFromResults.length} baseline entr(y/ies) had no matching run:`)
    for (const b of diff.missingFromResults) lines.push(`  - ${b.name}`)
    lines.push('')
  }

  const passed = results.filter((r) => r.ok).length
  lines.push('-'.repeat(60))
  lines.push(`${passed}/${results.length} smokes passed`)
  lines.push(
    diff.isClean
      ? 'RESULT: green — no regressions vs baseline'
      : 'RESULT: red — regressions vs baseline (see [REGRESSION] above)',
  )
  return lines.join('\n')
}
