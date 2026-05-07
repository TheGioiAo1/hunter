/**
 * Gbox Platform — Phase 11 PR2 smoke (smoke-matrix orchestrator)
 *
 * Validates the phase-smoke matrix harness — pure helpers + CLI shape.
 * Does NOT actually run the 32 per-phase smokes (that takes minutes and
 * requires a live DB). Running the matrix live is CI's job.
 *
 *   [1..5]   pure helpers (parse / discover / baseline build+merge / diff)
 *   [6..8]   baseline file shape + freshness
 *   [9..10]  CLI --dry-run exits 0 and lists every discovered smoke
 *   [11..12] iron rule 5 audit on formatter output + doc
 *
 * Runs offline.
 *
 *   npx tsx scripts/smoke-phase11-pr2.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as cp from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  buildBaseline,
  compareToBaseline,
  discoverSmokes,
  formatMatrixReport,
  mergeBaseline,
  parseSmokeName,
  type SmokeBaseline,
  type SmokeRunResult,
} from '@gbox/core/modules/ops/smoke-matrix.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'ops', 'smoke-baseline.json')
const MATRIX_DOC = path.join(REPO_ROOT, 'docs', 'ops', 'test-matrix.md')

type AssertFn = (label: string, ok: boolean, detail?: string) => void

function makeAsserter() {
  let total = 0
  let passed = 0
  const assert: AssertFn = (label, ok, detail) => {
    total++
    if (ok) {
      passed++
      console.log(`  OK   [${total}] ${label}`)
    } else {
      console.error(`  FAIL [${total}] ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }
  return { assert, summary: () => ({ total, passed }) }
}

async function main() {
  console.log('=== Phase 11 PR2 smoke — smoke-matrix orchestrator ===\n')
  const { assert, summary } = makeAsserter()

  // ---------------------------------------------------------------------------
  // [1..5] pure helpers
  // ---------------------------------------------------------------------------
  console.log('[1..5] pure helpers')
  {
    assert(
      '[1] parseSmokeName extracts phase/pr tuple',
      parseSmokeName('smoke-phase11-pr1')?.phase === 11 &&
        parseSmokeName('smoke-phase11-pr1')?.pr === 1,
    )
    const legacy = parseSmokeName('smoke-http-step-1-20')
    assert('[2] parseSmokeName rejects legacy step-based names', legacy === null)

    const discovered = discoverSmokes([
      'smoke-phase11-pr1.ts',
      'smoke-phase4-pr2.ts',
      'smoke-http-step-1-20.ts',
    ])
    assert(
      '[3] discoverSmokes filters legacy + sorts by (phase, pr)',
      discovered.length === 2 &&
        discovered[0].name === 'smoke-phase4-pr2' &&
        discovered[1].name === 'smoke-phase11-pr1',
    )

    const baseline = buildBaseline(discovered, '2026-04-21T00:00:00.000Z')
    assert(
      '[4] buildBaseline defaults every entry to expectedPass=true',
      baseline.entries.every((e) => e.expectedPass === true) && baseline.entries.length === 2,
    )

    const merged = mergeBaseline(
      {
        updatedAt: '2026-04-20T00:00:00.000Z',
        entries: [
          { name: 'smoke-phase4-pr2', expectedPass: false, note: 'flake' },
        ],
      },
      discovered,
      '2026-04-21T00:00:00.000Z',
    )
    const preserved = merged.entries.find((e) => e.name === 'smoke-phase4-pr2')
    assert(
      '[5] mergeBaseline preserves expectedPass=false + note on match',
      preserved?.expectedPass === false && preserved?.note === 'flake',
    )
  }

  // ---------------------------------------------------------------------------
  // [6..8] baseline file shape + freshness
  // ---------------------------------------------------------------------------
  console.log('\n[6..8] baseline file shape')
  {
    assert('[6] smoke-baseline.json exists', fs.existsSync(BASELINE_PATH))
    const raw = fs.readFileSync(BASELINE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as SmokeBaseline
    assert(
      '[7] baseline has updatedAt + non-empty entries array',
      typeof parsed.updatedAt === 'string' &&
        Array.isArray(parsed.entries) &&
        parsed.entries.length > 0,
    )
    // Every currently-on-disk smoke file should have a baseline row.
    const smokeFiles = fs
      .readdirSync(path.join(REPO_ROOT, 'scripts'))
      .filter((n) => n.startsWith('smoke-') && n.endsWith('.ts'))
      .map((n) => n.replace(/\.ts$/, ''))
      .filter((s) => parseSmokeName(s) !== null)
    const baselineNames = new Set(parsed.entries.map((e) => e.name))
    const missing = smokeFiles.filter((f) => !baselineNames.has(f))
    assert(
      `[8] every on-disk smoke has a baseline row (${smokeFiles.length} files, ${parsed.entries.length} baseline rows)`,
      missing.length === 0,
      missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    )
  }

  // ---------------------------------------------------------------------------
  // [9..10] CLI --dry-run
  // ---------------------------------------------------------------------------
  console.log('\n[9..10] CLI --dry-run exits 0')
  {
    let exit = -1
    let out = ''
    try {
      out = cp.execSync('npx tsx scripts/ops/smoke-matrix.ts --dry-run', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      exit = 0
    } catch (err: any) {
      exit = err.status ?? 1
      out = String(err.stdout ?? '') + String(err.stderr ?? '')
    }
    assert('[9] CLI --dry-run exits 0', exit === 0)
    assert(
      '[10] CLI output lists smoke-phase11-pr1 (sanity check)',
      out.includes('smoke-phase11-pr1'),
    )
  }

  // ---------------------------------------------------------------------------
  // [11..12] iron rule 5 audit
  // ---------------------------------------------------------------------------
  console.log('\n[11..12] iron rule 5 audit')
  {
    // Generate a sample report with regressions + info rows and scan.
    const results: SmokeRunResult[] = [
      { name: 'smoke-phase1-pr1', phase: 1, pr: 1, ok: false, exitCode: 1, durationMs: 50 },
      { name: 'smoke-phase2-pr1', phase: 2, pr: 1, ok: true, exitCode: 0, durationMs: 75 },
    ]
    const baseline: SmokeBaseline = {
      updatedAt: '2026-04-21T00:00:00.000Z',
      entries: [
        { name: 'smoke-phase1-pr1', expectedPass: true },
        { name: 'smoke-phase2-pr1', expectedPass: true },
      ],
    }
    const diff = compareToBaseline(baseline, results)
    const report = formatMatrixReport(results, diff)
    assert(
      '[11] formatMatrixReport output never mentions "god admin"',
      !/god[\s_-]*admin/i.test(report),
    )

    if (fs.existsSync(MATRIX_DOC)) {
      const doc = fs.readFileSync(MATRIX_DOC, 'utf8')
      assert(
        '[12] test-matrix.md references smoke-matrix.ts CLI + smoke-baseline.json',
        doc.includes('smoke-matrix.ts') && doc.includes('smoke-baseline.json'),
      )
    } else {
      assert('[12] test-matrix.md exists', false, `missing: ${MATRIX_DOC}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Wrap-up
  // ---------------------------------------------------------------------------
  const { total, passed } = summary()
  console.log('\n===============================')
  console.log(`   ${passed}/${total} assertions passed`)
  console.log('===============================\n')
  if (passed !== total) process.exit(1)
}

main().catch((err) => {
  console.error('[FAIL] PR2 smoke crashed:', err)
  process.exit(1)
})
