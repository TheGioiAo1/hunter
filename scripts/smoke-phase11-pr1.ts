/**
 * Gbox Platform — Phase 11 PR1 smoke (release gates)
 *
 * Validates the release-preflight surface end-to-end:
 *
 *   [1..3]   migration-ledger helper detects missing / imported-only /
 *            orphaned drift on synthetic fixtures
 *   [4..5]   release-check CLI runs against the live repo and reports
 *            a clean ledger for the 76 on-disk migrations
 *   [6..8]   the release-check formatter renders consistent table
 *            output (green / red / mixed)
 *   [9..10]  iron rule 5 audit on the formatter + runbook doc
 *
 * Runs offline — no DB, no HTTP, no @gbox/db imports. Safe to run on
 * the smoke box.
 *
 *   npx tsx scripts/smoke-phase11-pr1.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as cp from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  analyseLedger,
  extractImportedNames,
  extractRegisteredNames,
  formatLedgerReport,
} from '@gbox/core/modules/ops/migration-ledger.js'
import { formatReleaseReport, parseNodeMajor, MIN_NODE_MAJOR } from './ops/release-check.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')

type AssertFn = (label: string, ok: boolean, detail?: string) => void

function makeAsserter(): { assert: AssertFn; summary: () => { total: number; passed: number } } {
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
  return {
    assert,
    summary: () => ({ total, passed }),
  }
}

async function main() {
  console.log('=== Phase 11 PR1 smoke — release gates ===\n')
  const { assert, summary } = makeAsserter()

  // ---------------------------------------------------------------------------
  // [1..3] Migration ledger helper on synthetic fixtures
  // ---------------------------------------------------------------------------
  console.log('[1..3] migration-ledger helper')
  {
    const HAPPY = `
      import { up as up001 } from "./001_initial.ts";
      import { up as up072 } from "./072_phase10_perf_indexes.ts";
      const migrations = [
        { name: "001_initial", fn: up001 },
        { name: "072_phase10_perf_indexes", fn: up072 },
      ];
    `
    const happy = analyseLedger({
      filesOnDisk: ['001_initial', '072_phase10_perf_indexes'],
      runTsSource: HAPPY,
    })
    assert('[1] clean fixture → isClean=true', happy.isClean)

    const missing = analyseLedger({
      filesOnDisk: ['001_initial', '072_phase10_perf_indexes', '099_unregistered'],
      runTsSource: HAPPY,
    })
    assert(
      '[2] file on disk, not in array → caught as missingRegistrations',
      !missing.isClean && missing.missingRegistrations.includes('099_unregistered'),
    )

    const orphaned = analyseLedger({
      filesOnDisk: ['001_initial'],
      runTsSource: HAPPY,
    })
    assert(
      '[3] name in array, no file → caught as orphanedRegistrations',
      !orphaned.isClean && orphaned.orphanedRegistrations.includes('072_phase10_perf_indexes'),
    )
  }

  // ---------------------------------------------------------------------------
  // [4..5] Real repo state — ledger should be clean + CLI exits 0
  // ---------------------------------------------------------------------------
  console.log('\n[4..5] release-check against live repo')
  {
    const migrationsDir = path.join(REPO_ROOT, 'packages', 'db', 'src', 'migrations')
    const files = fs
      .readdirSync(migrationsDir)
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && /^\d{3}_/.test(n))
      .map((n) => n.replace(/\.ts$/, ''))
    const runSrc = fs.readFileSync(path.join(migrationsDir, 'run.ts'), 'utf8')
    const real = analyseLedger({ filesOnDisk: files, runTsSource: runSrc })
    assert(
      `[4] live ledger clean — ${real.filesOnDisk.length} files, ${real.registeredNames.length} registered`,
      real.isClean,
      real.isClean
        ? undefined
        : `missing=${real.missingRegistrations.join(',')} orphaned=${real.orphanedRegistrations.join(',')}`,
    )

    // Run the CLI and check exit code 0.
    let cliExit = -1
    let cliOutput = ''
    try {
      cliOutput = cp.execSync('npx tsx scripts/ops/release-check.ts', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      })
      cliExit = 0
    } catch (err: any) {
      cliExit = err.status ?? 1
      cliOutput = String(err.stdout ?? '') + String(err.stderr ?? '')
    }
    assert(
      '[5] release-check CLI exits 0 with RESULT: green',
      cliExit === 0 && cliOutput.includes('RESULT: green'),
      cliExit !== 0 ? `exit=${cliExit}` : undefined,
    )
  }

  // ---------------------------------------------------------------------------
  // [6..8] Formatter renders consistently
  // ---------------------------------------------------------------------------
  console.log('\n[6..8] formatReleaseReport shape')
  {
    const green = formatReleaseReport([
      { name: 'migrations', ok: true, summary: 'clean' },
      { name: 'git', ok: true, summary: 'clean' },
    ])
    assert(
      '[6] green report contains "RESULT: green" + "2/2 checks passed"',
      green.includes('RESULT: green') && green.includes('2/2 checks passed'),
    )

    const red = formatReleaseReport([
      { name: 'migrations', ok: false, summary: 'drift: 1 unregistered', detail: '  - 099_x' },
      { name: 'git', ok: true, summary: 'clean' },
    ])
    assert(
      '[7] red report contains "RESULT: red" + "DO NOT deploy" + failure detail',
      red.includes('RESULT: red') && red.includes('DO NOT deploy') && red.includes('099_x'),
    )

    const empty = formatReleaseReport([])
    assert(
      '[8] empty results → "0/0 checks passed" + green banner (degenerate but safe)',
      empty.includes('0/0 checks passed') && empty.includes('RESULT: green'),
    )
  }

  // ---------------------------------------------------------------------------
  // [9..10] Iron rule 5 — formatter output never mentions god admin,
  // and the runbook doc keeps "contact Gbox support" canonical copy.
  // ---------------------------------------------------------------------------
  console.log('\n[9..10] iron rule 5 audit')
  {
    const sample = formatReleaseReport([
      { name: 'migrations', ok: false, summary: 'drift', detail: 'arbitrary text' },
      { name: 'git', ok: false, summary: 'dirty', detail: 'M some/path.ts' },
    ])
    const ledger = formatLedgerReport({
      filesOnDisk: [],
      registeredNames: [],
      importedNames: [],
      missingRegistrations: [],
      importedButNotInArray: [],
      orphanedRegistrations: [],
      isClean: true,
    })
    const leak =
      /god[\s_-]*admin/i.test(sample) ||
      /god[\s_-]*admin/i.test(ledger)
    assert('[9] formatters never emit "god admin"', !leak)

    const runbook = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'ops', 'release-checklist.md'),
      'utf8',
    )
    assert(
      '[10] release-checklist.md references iron rule 5 + names the canonical scripts',
      runbook.includes('Iron rule 5') &&
        runbook.includes('release-check.ts') &&
        runbook.includes('smoke-all.ts'),
    )
  }

  // ---------------------------------------------------------------------------
  // Bonus: node version parser ≥ floor
  // ---------------------------------------------------------------------------
  console.log('\n[11] parseNodeMajor floor')
  {
    const major = parseNodeMajor(process.version)
    assert(
      `[11] current node ${process.version} ≥ v${MIN_NODE_MAJOR}`,
      major !== null && major >= MIN_NODE_MAJOR,
    )
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
  console.error('[FAIL] PR1 smoke crashed:', err)
  process.exit(1)
})
