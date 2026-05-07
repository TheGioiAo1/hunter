/**
 * Gbox Platform — Password Hash Migration Auditor (Phase 7.4)
 *
 * Surveys the users table, classifies every password_hash as
 * bcrypt / sha256 / empty / unknown, and prints a report. With
 * `--reset-stale=<days>` it will additionally fire forced-reset
 * emails for the SHA-256 rows that haven't logged in for that many
 * days (so the lazy upgrade can't reach them).
 *
 * Usage:
 *
 *   # Read-only audit (always safe to run):
 *   pnpm tsx scripts/ops/audit-password-hashes.ts
 *
 *   # Show which rows would be reset, but don't actually send:
 *   pnpm tsx scripts/ops/audit-password-hashes.ts --reset-stale=180 --dry-run
 *
 *   # Actually send the resets:
 *   pnpm tsx scripts/ops/audit-password-hashes.ts --reset-stale=180 --yes
 *
 * Flags:
 *   --reset-stale=<days>   Pick SHA-256 rows whose last_login_at is
 *                          older than <days> for forced reset.
 *   --batch=<n>            Cap the reset batch at n rows (default 100).
 *   --dry-run              Print the picked rows but don't send emails.
 *   --yes                  Required for non-dry-run sends. Two-step
 *                          safety lock to prevent accidental mass-resets.
 *
 * Exit codes:
 *   0  audit completed (and reset succeeded if requested)
 *   1  bad arguments
 *   2  database error
 */

import {
  classifyPasswordHash,
  summarizePasswordFleet,
  pickLegacyForReset,
  type PasswordRow,
} from '@gbox/core/modules/auth/password-migration.js'

// ---------------------------------------------------------------------------
// Argument parsing — keep it dependency-free, this is a 1-screen script
// ---------------------------------------------------------------------------

interface CliOptions {
  resetStaleDays: number | null
  batch: number
  dryRun: boolean
  confirmYes: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    resetStaleDays: null,
    batch: 100,
    dryRun: false,
    confirmYes: false,
  }
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--yes') opts.confirmYes = true
    else if (arg.startsWith('--reset-stale=')) {
      const v = Number(arg.slice('--reset-stale='.length))
      if (Number.isNaN(v) || v < 0) {
        console.error(`bad value for --reset-stale: ${arg}`)
        process.exit(1)
      }
      opts.resetStaleDays = v
    } else if (arg.startsWith('--batch=')) {
      const v = Number(arg.slice('--batch='.length))
      if (Number.isNaN(v) || v <= 0) {
        console.error(`bad value for --batch: ${arg}`)
        process.exit(1)
      }
      opts.batch = v
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`unknown arg: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`usage: audit-password-hashes [--reset-stale=DAYS] [--batch=N] [--dry-run] [--yes]

Read-only audit by default. Use --reset-stale + --yes to send forced
password reset emails to dormant SHA-256 rows.`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  // Lazy DB import — keeps `--help` snappy.
  const { createDb } = await import('@gbox/db')
  const db = createDb()

  let exitCode = 0
  try {
    // ---- Stage 1: load every users row -----------------------------------
    console.log('→ Loading users…')
    const dbRows = await db
      .selectFrom('users')
      .select(['id', 'email', 'password_hash', 'last_login_at'])
      .execute()
    const rows: PasswordRow[] = dbRows.map((r: any) => ({
      id: r.id,
      email: r.email,
      password_hash: r.password_hash,
      last_login_at: r.last_login_at ? new Date(r.last_login_at) : null,
    }))

    // ---- Stage 2: classify + summarise -----------------------------------
    const summary = summarizePasswordFleet(rows)
    console.log('')
    console.log('== Password hash fleet ==')
    console.log(`  total:    ${summary.total}`)
    console.log(`  bcrypt:   ${summary.bcrypt}`)
    console.log(`  sha256:   ${summary.sha256}    ← legacy, needs migration`)
    console.log(`  empty:    ${summary.empty}     (passkey-only / new accounts)`)
    console.log(`  unknown:  ${summary.unknown}`)
    console.log(`  migrated: ${summary.percentMigrated}%`)
    console.log('')

    if (summary.unknown > 0) {
      console.log(`WARN: ${summary.unknown} unknown hashes — investigate:`)
      for (const r of rows) {
        if (classifyPasswordHash(r.password_hash) === 'unknown') {
          console.log(`  - ${r.id} ${r.email}`)
        }
      }
      console.log('')
    }

    // ---- Stage 3: optional reset wave ------------------------------------
    if (opts.resetStaleDays === null) {
      console.log('Done (read-only audit). Pass --reset-stale=DAYS to send resets.')
      return
    }

    const picked = pickLegacyForReset(rows, {
      inactiveSinceDays: opts.resetStaleDays,
      maxBatchSize: opts.batch,
    })

    console.log(
      `Picked ${picked.length} dormant SHA-256 rows ` +
        `(>${opts.resetStaleDays} days inactive, batch cap ${opts.batch}):`,
    )
    for (const r of picked) {
      const last = r.last_login_at
        ? r.last_login_at.toISOString()
        : '(never logged in)'
      console.log(`  - ${r.id} ${r.email}  last_login=${last}`)
    }
    console.log('')

    if (opts.dryRun) {
      console.log('--dry-run set; no resets sent. Re-run with --yes to send.')
      return
    }
    if (!opts.confirmYes) {
      console.log(
        'Refusing to send resets without --yes. ' +
          'Pass --dry-run to preview or --yes to confirm.',
      )
      exitCode = 1
      return
    }

    // The actual "send forced reset" wiring is the merchant-onboarding
    // team's responsibility — they own the email templates + the
    // password_reset_tokens table. This script just hands off the row
    // ids; the import is done lazily so the auditor still works on a
    // box without that module installed yet.
    try {
      const mod = (await import(
        '@gbox/core/modules/auth/forced-reset.js' as string
      )) as { sendForcedResetEmails?: (ids: string[]) => Promise<void> }
      if (typeof mod.sendForcedResetEmails === 'function') {
        await mod.sendForcedResetEmails(picked.map((r) => r.id))
        console.log(`✓ Sent ${picked.length} forced-reset emails.`)
      } else {
        console.warn(
          'forced-reset module loaded but does not export sendForcedResetEmails',
        )
        exitCode = 2
      }
    } catch (err) {
      console.warn(
        'forced-reset module not present yet — cannot send emails. ' +
          'Install it and re-run.',
      )
      console.warn(`(import error: ${err instanceof Error ? err.message : err})`)
      exitCode = 2
    }
  } catch (err) {
    console.error('audit-password-hashes failed:', err)
    exitCode = 2
  } finally {
    await db.destroy()
  }
  process.exit(exitCode)
}

main()
