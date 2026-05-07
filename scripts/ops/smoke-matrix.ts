/**
 * Gbox Platform — Phase Smoke Matrix CLI (Phase 11 PR2)
 *
 * Discovers every `scripts/smoke-phaseN-prM.ts`, runs them sequentially
 * via `npx tsx`, and diffs the pass/fail outcomes against the committed
 * baseline (`scripts/ops/smoke-baseline.json`). Designed to be the
 * second gate the release runbook runs (after `release-check.ts` in
 * PR1), and the CI nightly regression catcher.
 *
 *   npx tsx scripts/ops/smoke-matrix.ts                 # report, compare vs baseline
 *   npx tsx scripts/ops/smoke-matrix.ts --dry-run       # discover-only, skip execution
 *   npx tsx scripts/ops/smoke-matrix.ts --update-baseline
 *                                                       # refresh baseline from fresh discovery
 *   npx tsx scripts/ops/smoke-matrix.ts --only phase11  # run a single phase subset
 *
 * Live DB is required for most smokes. Typical invocation from server 2:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/ops/smoke-matrix.ts
 *
 * Exit codes: 0 = no regressions, 1 = at least one expectedPass smoke
 * failed. Unexpected-pass / missing-baseline rows are treated as INFO
 * (they print, but don't fail the gate).
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
  type SmokeBaseline,
  type SmokeEntry,
  type SmokeRunResult,
} from '@gbox/core/modules/ops/smoke-matrix.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SMOKE_DIR = path.join(REPO_ROOT, 'scripts')
const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'ops', 'smoke-baseline.json')

// ---------------------------------------------------------------------------
// Arg parsing — intentionally tiny (no `commander` dep)
// ---------------------------------------------------------------------------

interface Args {
  dryRun: boolean
  updateBaseline: boolean
  only?: string
  timeoutMs: number
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    dryRun: false,
    updateBaseline: false,
    timeoutMs: 120_000, // 2 min per smoke — generous; most run in <10s
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--update-baseline') args.updateBaseline = true
    else if (a === '--only') args.only = argv[++i]
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i])
  }
  return args
}

// ---------------------------------------------------------------------------
// Discovery from disk
// ---------------------------------------------------------------------------

function listSmokeFiles(): string[] {
  return fs.readdirSync(SMOKE_DIR).filter((n) => n.startsWith('smoke-') && n.endsWith('.ts'))
}

function loadBaseline(): SmokeBaseline {
  if (!fs.existsSync(BASELINE_PATH)) {
    return { updatedAt: '1970-01-01T00:00:00.000Z', entries: [] }
  }
  const raw = fs.readFileSync(BASELINE_PATH, 'utf8')
  return JSON.parse(raw) as SmokeBaseline
}

function saveBaseline(b: SmokeBaseline): void {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function runSmoke(entry: SmokeEntry, timeoutMs: number): SmokeRunResult {
  const start = Date.now()
  const rel = path.join('scripts', `${entry.name}.ts`)
  // Force NODE_ENV=test so the Phase 14 PR4b/PR5/PR6/PR7 smokes' own
  // "do not run in production" guard doesn't trip. The API server on
  // server 2 runs with NODE_ENV=production in the shell (PM2), and we
  // inherit that env here — without this override every newer smoke
  // short-circuits with "must not run with NODE_ENV=production".
  // Anything else (DATABASE_URL / REDIS_URL / ADMIN_TOKEN etc.) is
  // still inherited from the caller.
  const r = cp.spawnSync('npx', ['tsx', rel], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: timeoutMs,
    shell: process.platform === 'win32', // Windows needs shell for npx
    env: { ...process.env, NODE_ENV: 'test' },
  })
  const durationMs = Date.now() - start
  const exitCode =
    r.status !== null
      ? r.status
      : r.signal
        ? 124 // conventional "timed out" exit
        : 1
  return {
    ...entry,
    exitCode,
    durationMs,
    ok: exitCode === 0,
    note: r.signal ? `signal ${r.signal}` : undefined,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const files = listSmokeFiles()
  let entries = discoverSmokes(files)

  if (args.only) {
    // Strip `phase` prefix and accept dash-separated fractional phase
    // (e.g. `phase12-5` or `12-5` → 12.5) alongside integer phases.
    const want = args.only.replace(/^phase/i, '').replace('-', '.')
    const phase = Number(want)
    if (!Number.isFinite(phase)) {
      console.error(`[FAIL] --only expects 'phaseN', 'N', or 'phaseN-M' (decimal), got: ${args.only}`)
      process.exit(2)
    }
    entries = entries.filter((e) => e.phase === phase)
  }

  console.log(`  Gbox Platform — Phase Smoke Matrix`)
  console.log('-'.repeat(60))
  console.log(`  Discovered ${entries.length} smoke(s) (from ${files.length} files)`)

  if (entries.length === 0) {
    console.log('  (nothing to run)')
    process.exit(0)
  }

  if (args.dryRun) {
    console.log('  (--dry-run) listing only:')
    for (const e of entries) console.log(`   - ${e.name}`)
    if (args.updateBaseline) {
      const prev = loadBaseline()
      const merged = mergeBaseline(prev, entries, new Date().toISOString())
      saveBaseline(merged)
      console.log(`\n[ok] baseline refreshed from discovery → ${path.relative(REPO_ROOT, BASELINE_PATH)}`)
    }
    process.exit(0)
  }

  const results: SmokeRunResult[] = []
  for (const e of entries) {
    process.stdout.write(`  Running ${e.name} ...`)
    const r = runSmoke(e, args.timeoutMs)
    results.push(r)
    process.stdout.write(` ${r.ok ? 'OK' : 'FAIL'} (${r.durationMs}ms)\n`)
  }
  console.log('')

  const baseline = loadBaseline()
  const diff = compareToBaseline(baseline, results)
  console.log(formatMatrixReport(results, diff))

  if (args.updateBaseline) {
    const merged = mergeBaseline(baseline, entries, new Date().toISOString())
    saveBaseline(merged)
    console.log(`\n[ok] baseline refreshed → ${path.relative(REPO_ROOT, BASELINE_PATH)}`)
  }

  process.exit(diff.isClean ? 0 : 1)
}

// Only run when invoked directly
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[FAIL] smoke-matrix crashed:', err)
    process.exit(1)
  })
}

// Named exports for reuse + tests
export { listSmokeFiles, loadBaseline, saveBaseline, parseArgs }
