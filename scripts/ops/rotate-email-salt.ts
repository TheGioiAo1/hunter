#!/usr/bin/env node
/**
 * rotate-email-salt.ts — rotate EMAIL_TRACKING_IP_SALT.
 *
 * Phase 14 PR5 — GDPR/Privacy pack.
 *
 * The Phase 15 admin UI for this operation is deferred; until then,
 * ops rotates via this CLI. The CLI does NOT mutate any env file or
 * secret store — it just records the rotation in
 * `email_tracking_salt_rotations` and prints the NEW salt ONCE, which
 * the operator must paste into the deployment's secret store before
 * restarting the API + tracking workers.
 *
 * CLI:
 *   npx tsx scripts/ops/rotate-email-salt.ts \
 *     --rotated-by=cli:<operator-handle> \
 *     [--reason="rotation rationale"] \
 *     [--force]           (bypass 1-hour rate limit)
 *     [--json]            (machine-readable output)
 *
 * Example:
 *   npx tsx scripts/ops/rotate-email-salt.ts \
 *     --rotated-by=cli:thai --reason="90-day schedule"
 *
 * Behaviour:
 *   1. Reads current `EMAIL_TRACKING_IP_SALT` from the environment.
 *   2. Checks the most recent rotation audit row — aborts if <1h ago
 *      unless --force.
 *   3. Generates a new 32-byte hex salt.
 *   4. Records sha256 hashes of old + new salt + rotated_by + reason
 *      in `email_tracking_salt_rotations`. Raw salts never touch the DB.
 *   5. Prints the new salt ONCE. After this run, the CLI cannot recall
 *      the value — the operator must copy it immediately.
 *
 * Exit codes:
 *   0 — rotated
 *   1 — bad args / validation failure
 *   2 — rate-limited (prints nextAllowedAt, exit non-zero so CI notices)
 *   3 — DB / unexpected error
 */

import 'dotenv/config'
import { createDb, destroyDb } from '@gbox/db'
import {
  rotateTrackingSalt,
  isValidRotatedBy,
} from '@gbox/core/modules/email/salt-rotation.js'

interface Args {
  rotatedBy: string
  reason: string | null
  force: boolean
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { rotatedBy: '', reason: null, force: false, json: false }
  for (const a of argv) {
    if (a.startsWith('--rotated-by=')) {
      out.rotatedBy = a.slice('--rotated-by='.length).trim()
    } else if (a.startsWith('--reason=')) {
      out.reason = a.slice('--reason='.length).trim() || null
    } else if (a === '--force') {
      out.force = true
    } else if (a === '--json') {
      out.json = true
    }
  }
  if (!out.rotatedBy) {
    throw new Error(
      'missing --rotated-by=<cli|cli:handle|admin:uuid|system>',
    )
  }
  if (!isValidRotatedBy(out.rotatedBy)) {
    throw new Error(
      `invalid --rotated-by value: ${out.rotatedBy} ` +
        `(accepted: "cli", "cli:<handle>", "admin:<uuid>", "system")`,
    )
  }
  return out
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(
      `[rotate-email-salt] bad args: ${err instanceof Error ? err.message : err}`,
    )
    return 1
  }

  const db = createDb()
  try {
    const result = await rotateTrackingSalt(db, {
      rotatedBy: args.rotatedBy,
      reason: args.reason,
      force: args.force,
    })

    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        if (args.json) {
          console.log(
            JSON.stringify({
              ok: false,
              reason: 'rate_limited',
              nextAllowedAt: result.nextAllowedAt,
            }),
          )
        } else {
          console.error(
            `[rotate-email-salt] rate-limited: last rotation < 1h ago.`,
          )
          console.error(`  Next allowed at: ${result.nextAllowedAt}`)
          console.error(`  Pass --force to override (emergency use only).`)
        }
        return 2
      }
      console.error(
        `[rotate-email-salt] rotation failed: ${result.error ?? result.reason}`,
      )
      return 3
    }

    if (args.json) {
      // Machine-readable path — emits the new salt. Caller must redact
      // before forwarding anywhere persistent.
      console.log(
        JSON.stringify({
          ok: true,
          rotation_id: result.rotationId,
          rotated_at: result.rotatedAt,
          new_salt: result.newSalt,
          new_salt_hash: result.newSaltHash,
          old_salt_hash: result.oldSaltHash,
          had_previous: result.hadPrevious,
        }),
      )
    } else {
      console.log(
        `[rotate-email-salt] Rotated (audit id ${result.rotationId})`,
      )
      console.log(`  Rotated at:     ${result.rotatedAt}`)
      console.log(`  Had previous:   ${result.hadPrevious}`)
      if (result.oldSaltHash) {
        console.log(`  Old salt hash:  ${result.oldSaltHash}`)
      }
      console.log(`  New salt hash:  ${result.newSaltHash}`)
      console.log('')
      console.log('  NEW SALT (show ONCE — paste into your secret store now):')
      console.log('')
      console.log(`    EMAIL_TRACKING_IP_SALT=${result.newSalt}`)
      console.log('')
      console.log(
        '  Next steps:',
      )
      console.log(
        '    1. Paste the value above into the deployment secret store.',
      )
      console.log(
        '    2. Restart the API + tracking workers to pick up the new salt.',
      )
      console.log(
        '    3. Old email_events.ip_hash rows become uncorrelatable to new ones —',
      )
      console.log(
        '       this is the intended GDPR property of salt rotation.',
      )
    }

    return 0
  } catch (err) {
    console.error(
      `[rotate-email-salt] uncaught: ${err instanceof Error ? err.stack : err}`,
    )
    return 3
  } finally {
    await destroyDb(db)
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      `[rotate-email-salt] uncaught: ${err instanceof Error ? err.stack : err}`,
    )
    process.exit(3)
  })
