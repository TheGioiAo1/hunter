#!/usr/bin/env node
/**
 * reset-god-admin-session.ts — emergency god-admin session hygiene tool.
 *
 * Three things the ops runbook needs when something smells wrong with a
 * god-admin login (stolen cookie, forgotten password, "am I still logged
 * in on a device I don't remember?"):
 *
 *   1. Set a new password for the god-admin accounts (bcrypt hash).
 *   2. Nuke every active session row for role='owner' users.
 *   3. Evict the matching Redis cache + idle-timeout keys so a stolen
 *      cookie can't ride the 5-minute cache window.
 *
 * All three are idempotent and order-independent.
 *
 * Usage:
 *
 *   # Dry run — show what would change:
 *   pnpm tsx scripts/ops/reset-god-admin-session.ts --dry-run
 *
 *   # Purge all god-admin sessions (no password change):
 *   pnpm tsx scripts/ops/reset-god-admin-session.ts --purge-sessions --yes
 *
 *   # Full reset (password + sessions + cache):
 *   pnpm tsx scripts/ops/reset-god-admin-session.ts \
 *     --new-password='<redacted>' --purge-sessions --yes
 *
 *   # Target a specific email only:
 *   pnpm tsx scripts/ops/reset-god-admin-session.ts \
 *     --email=buithai3107@gmail.com --new-password='<redacted>' --yes
 *
 * Flags:
 *   --new-password=<str>   New plaintext password. Will be bcrypt-hashed.
 *                          If omitted, password is NOT changed (you can
 *                          still run with --purge-sessions alone).
 *   --email=<addr>         Restrict to one god-admin email. Default: ALL
 *                          users with role='owner' AND is_default_admin.
 *   --purge-sessions       DELETE all sessions for the matched users.
 *   --dry-run              Print plan, don't write anything.
 *   --yes                  Required for non-dry-run writes. Two-step lock.
 *
 * Exit codes:
 *   0  success
 *   1  bad arguments
 *   2  database / redis error
 */

import bcrypt from 'bcrypt'
import { createDb, destroyDb } from '../../packages/db/src/index.js'
import { cacheDelPattern, closeRedis } from '@gbox/core/modules/cache/redis.js'

interface Args {
  newPassword: string | null
  email: string | null
  purgeSessions: boolean
  dryRun: boolean
  confirmed: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    newPassword: null,
    email: null,
    purgeSessions: false,
    dryRun: false,
    confirmed: false,
  }
  for (const a of argv) {
    if (a.startsWith('--new-password=')) out.newPassword = a.slice('--new-password='.length)
    else if (a.startsWith('--email=')) out.email = a.slice('--email='.length).toLowerCase()
    else if (a === '--purge-sessions') out.purgeSessions = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes') out.confirmed = true
    else if (a === '--help' || a === '-h') {
      console.log(
        "See header comment in scripts/ops/reset-god-admin-session.ts for usage.",
      )
      process.exit(0)
    }
  }
  if (!out.newPassword && !out.purgeSessions) {
    throw new Error(
      'Nothing to do. Pass --new-password=<...> and/or --purge-sessions.',
    )
  }
  if (!out.dryRun && !out.confirmed) {
    throw new Error('Refusing to write without --dry-run or --yes.')
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const db = createDb()

  try {
    // ------------------------------------------------------------------
    // 1. Find matching god-admin rows
    // ------------------------------------------------------------------
    let q = db
      .selectFrom('users')
      .select(['id', 'email', 'is_default_admin'])
      .where('role', '=', 'owner')
      .where('is_default_admin', '=', true)
    if (args.email) q = q.where('email', '=', args.email)

    const users = await q.execute()
    if (users.length === 0) {
      console.log('No god-admin rows match — nothing to do.')
      return
    }

    console.log(`Matched ${users.length} god-admin row(s):`)
    for (const u of users) console.log(`  - ${u.email} (${u.id})`)

    // ------------------------------------------------------------------
    // 2. Password reset
    // ------------------------------------------------------------------
    if (args.newPassword) {
      const hash = await bcrypt.hash(args.newPassword, 12)
      console.log(
        `\nWould update password_hash (bcrypt $2b$12$) for ${users.length} row(s).`,
      )
      if (!args.dryRun) {
        await db
          .updateTable('users')
          .set({ password_hash: hash })
          .where(
            'id',
            'in',
            users.map((u) => u.id),
          )
          .execute()
        console.log('  ✓ password_hash updated')
      }
    }

    // ------------------------------------------------------------------
    // 3. Session purge (DB)
    // ------------------------------------------------------------------
    if (args.purgeSessions) {
      const countQ = db
        .selectFrom('sessions')
        .select((eb) => eb.fn.countAll().as('n'))
        .where(
          'user_id',
          'in',
          users.map((u) => u.id),
        )
      const { n } = (await countQ.executeTakeFirstOrThrow()) as { n: string | number }
      const beforeCount = typeof n === 'string' ? parseInt(n, 10) : n

      console.log(`\nWould DELETE ${beforeCount} session row(s).`)
      if (!args.dryRun) {
        await db
          .deleteFrom('sessions')
          .where(
            'user_id',
            'in',
            users.map((u) => u.id),
          )
          .execute()
        console.log('  ✓ sessions purged')
      }

      // ------------------------------------------------------------------
      // 4. Redis eviction: session:<hash> + god-idle:<hash>
      //
      // We can't compute the per-session hashes without iterating the
      // deleted rows; simpler to nuke every key with a matching prefix.
      // There are rarely more than a few hundred across a platform of
      // this size, so a single SCAN+DEL round is fine.
      // ------------------------------------------------------------------
      if (!args.dryRun) {
        try {
          const s = await cacheDelPattern('session:*')
          const g = await cacheDelPattern('god-idle:*')
          console.log(`  ✓ redis evicted: session:* (${s}), god-idle:* (${g})`)
        } catch (err) {
          console.warn(
            '  ! redis eviction failed (continuing):',
            (err as Error).message,
          )
        }
      } else {
        console.log('  (would also evict redis session:* + god-idle:* keys)')
      }
    }

    if (args.dryRun) {
      console.log('\nDry run — no changes written.')
    } else {
      console.log('\nDone.')
    }
  } finally {
    await destroyDb(db).catch(() => {})
    await closeRedis().catch(() => {})
  }
}

const isDirect = process.argv[1]?.endsWith('reset-god-admin-session.ts')
if (isDirect) {
  void main().catch((err) => {
    console.error('reset-god-admin-session failed:', (err as Error).message)
    process.exit(2)
  })
}

export { parseArgs }
