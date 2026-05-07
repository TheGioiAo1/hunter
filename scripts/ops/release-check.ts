/**
 * Gbox Platform — Release Preflight Orchestrator (Phase 11 PR1)
 *
 * The single command `npx tsx scripts/ops/release-check.ts` is the
 * gate the deploy runbook runs BEFORE `scripts/deploy/deploy-production.sh`.
 * It bundles every sanity check the release bot needs in one pass and
 * exits 0 only when every branch is green.
 *
 * What it checks (each row in the report):
 *
 *   [migrations]   every file in packages/db/src/migrations/ is
 *                  registered in run.ts (and vice-versa). Uses the
 *                  pure `analyseLedger()` helper from
 *                  `@gbox/core/modules/ops/migration-ledger`.
 *
 *   [git]          working tree is clean (no uncommitted changes to
 *                  tracked files). Untracked files are allowed — the
 *                  repo carries a pile of them already and pruning them
 *                  is out of scope for a release gate.
 *
 *   [node]         node --version ≥ 20 (matches CI's pinned range).
 *
 * Why this lives in `scripts/ops/` and not `scripts/deploy/`:
 *   - The deploy/ folder is Thai's "this changes prod" surface — it
 *     runs swaps, talks to nginx, touches certs. This script is
 *     read-only, runs anywhere (laptop, CI, server 2), and feeds the
 *     deploy scripts a pass/fail signal.
 *
 * Exit codes: 0 = all green, 1 = at least one failure.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as cp from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  analyseLedger,
  formatLedgerReport,
  type LedgerReport,
} from '@gbox/core/modules/ops/migration-ledger.js'
import {
  analyseIronRule5,
  formatIronRule5Report,
  type FileInput,
} from '@gbox/core/modules/ops/iron-rule-5-lint.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')

interface CheckResult {
  name: string
  ok: boolean
  /** Short summary shown in the table. */
  summary: string
  /** Optional multi-line detail appended after the table on failure. */
  detail?: string
}

// ---------------------------------------------------------------------------
// [migrations] — ledger drift
// ---------------------------------------------------------------------------

function listMigrationFiles(): string[] {
  const dir = path.join(REPO_ROOT, 'packages', 'db', 'src', 'migrations')
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .filter((e) => e.name.endsWith('.ts'))
    .filter((e) => !e.name.endsWith('.test.ts'))
    .filter((e) => /^\d{3}_/.test(e.name)) // NNN_ stem only — skips run.ts / index.ts / helpers
    .map((e) => e.name.replace(/\.ts$/, ''))
}

function readRunTsSource(): string {
  return fs.readFileSync(
    path.join(REPO_ROOT, 'packages', 'db', 'src', 'migrations', 'run.ts'),
    'utf8',
  )
}

function checkMigrationLedger(): CheckResult {
  let report: LedgerReport
  try {
    report = analyseLedger({
      filesOnDisk: listMigrationFiles(),
      runTsSource: readRunTsSource(),
    })
  } catch (err) {
    return {
      name: 'migrations',
      ok: false,
      summary: 'introspection failed',
      detail: String(err),
    }
  }

  if (report.isClean) {
    return {
      name: 'migrations',
      ok: true,
      summary: `clean — ${report.filesOnDisk.length} migrations on disk, all registered`,
    }
  }

  const drifts: string[] = []
  if (report.missingRegistrations.length > 0) {
    drifts.push(`${report.missingRegistrations.length} unregistered`)
  }
  if (report.importedButNotInArray.length > 0) {
    drifts.push(`${report.importedButNotInArray.length} imported-but-not-in-array`)
  }
  if (report.orphanedRegistrations.length > 0) {
    drifts.push(`${report.orphanedRegistrations.length} orphaned`)
  }
  if (report.unacceptedCollisions.length > 0) {
    drifts.push(`${report.unacceptedCollisions.length} unaccepted-NNN-collision`)
  }

  return {
    name: 'migrations',
    ok: false,
    summary: `drift: ${drifts.join(', ')}`,
    detail: formatLedgerReport(report),
  }
}

// ---------------------------------------------------------------------------
// [git] — working tree clean
// ---------------------------------------------------------------------------

function checkGitClean(): CheckResult {
  try {
    const out = cp.execSync('git status --porcelain=v1 --untracked-files=no', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    const lines = out.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      return { name: 'git', ok: true, summary: 'working tree clean (tracked files)' }
    }
    return {
      name: 'git',
      ok: false,
      summary: `${lines.length} uncommitted change(s)`,
      detail: lines.map((l) => `  ${l}`).join('\n'),
    }
  } catch (err) {
    return {
      name: 'git',
      ok: false,
      summary: 'git introspection failed',
      detail: String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// [iron-rule-5] — seller surfaces must not leak god-admin mentions
//
// CLAUDE.md Iron Rule 5. Scans the seller-facing app roots plus the
// shared `packages/core/src/modules` tree for string literals that
// contain `/god-admin`, "god admin" (any casing), or the seeded god-
// admin email addresses. Deliberately does NOT scan `apps/god-admin/`
// — that app legitimately displays "God Admin" in its own UI.
//
// See packages/core/src/modules/ops/iron-rule-5-lint.ts for the
// analyser + the exact match rules.
// ---------------------------------------------------------------------------

const IRON_RULE_5_SCAN_ROOTS: readonly string[] = [
  'apps/store-admin/src',
  'apps/storefront/src',
  'apps/checkout/src',
  'apps/accounts/src',
  'apps/supporter/src',
  'packages/core/src/modules',
]

const IRON_RULE_5_FILE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.astro',
  '.html',
]

function walkSourceFiles(rootAbs: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(rootAbs)) return out
  const stack: string[] = [rootAbs]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') {
          continue
        }
        stack.push(full)
      } else if (e.isFile()) {
        if (IRON_RULE_5_FILE_EXTENSIONS.some((ext) => e.name.endsWith(ext))) {
          out.push(full)
        }
      }
    }
  }
  return out
}

function checkIronRule5(): CheckResult {
  const files: FileInput[] = []
  for (const root of IRON_RULE_5_SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root)
    for (const file of walkSourceFiles(abs)) {
      try {
        const content = fs.readFileSync(file, 'utf8')
        files.push({
          path: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
          content,
        })
      } catch {
        /* unreadable — skip */
      }
    }
  }

  const report = analyseIronRule5({ files })

  if (report.isClean) {
    return {
      name: 'iron-rule-5',
      ok: true,
      summary: `clean — ${report.filesScanned} files scanned (${report.filesExcluded} excluded)`,
    }
  }

  return {
    name: 'iron-rule-5',
    ok: false,
    summary: `${report.hits.length} leak(s) in seller surfaces`,
    detail: formatIronRule5Report(report),
  }
}

// ---------------------------------------------------------------------------
// [node] — version check
// ---------------------------------------------------------------------------

export function parseNodeMajor(version: string): number | null {
  const m = /^v(\d+)\./.exec(version.trim())
  return m ? Number(m[1]) : null
}

export const MIN_NODE_MAJOR = 20

function checkNodeVersion(): CheckResult {
  const version = process.version
  const major = parseNodeMajor(version)
  if (major === null) {
    return {
      name: 'node',
      ok: false,
      summary: `could not parse version (${version})`,
    }
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name: 'node',
      ok: false,
      summary: `${version} < v${MIN_NODE_MAJOR} (minimum)`,
    }
  }
  return { name: 'node', ok: true, summary: `${version} ≥ v${MIN_NODE_MAJOR}` }
}

// ---------------------------------------------------------------------------
// Report formatter (pure — unit-testable, same pattern as smoke-probes)
// ---------------------------------------------------------------------------

export function formatReleaseReport(results: CheckResult[]): string {
  const lines: string[] = []
  lines.push('  Gbox Platform — Release Preflight Check')
  lines.push('-'.repeat(50))

  const nameWidth = Math.max(...results.map((r) => r.name.length)) + 2
  for (const r of results) {
    const marker = r.ok ? '[ok]  ' : '[FAIL]'
    const padded = r.name.padEnd(nameWidth, ' ')
    lines.push(`  ${marker} ${padded} ${r.summary}`)
  }

  const failures = results.filter((r) => !r.ok)
  if (failures.length > 0) {
    lines.push('')
    lines.push('Failure detail:')
    lines.push('-'.repeat(50))
    for (const f of failures) {
      lines.push(`[${f.name}] ${f.summary}`)
      if (f.detail) lines.push(f.detail)
      lines.push('')
    }
  }

  lines.push('-'.repeat(50))
  const passed = results.length - failures.length
  lines.push(`${passed}/${results.length} checks passed`)
  lines.push(failures.length === 0 ? 'RESULT: green — safe to proceed with deploy' : 'RESULT: red — DO NOT deploy')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main() {
  const results: CheckResult[] = [
    checkMigrationLedger(),
    checkIronRule5(),
    checkGitClean(),
    checkNodeVersion(),
  ]

  console.log(formatReleaseReport(results))

  const allGreen = results.every((r) => r.ok)
  process.exit(allGreen ? 0 : 1)
}

// Only run when invoked directly — not when imported (keeps the file
// unit-testable via the exported `formatReleaseReport`).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[FAIL] release-check crashed:', err)
    process.exit(1)
  })
}

// Named exports for reuse + tests
export {
  checkMigrationLedger,
  checkIronRule5,
  checkGitClean,
  checkNodeVersion,
  listMigrationFiles,
  readRunTsSource,
  walkSourceFiles,
  IRON_RULE_5_SCAN_ROOTS,
  IRON_RULE_5_FILE_EXTENSIONS,
}
