#!/usr/bin/env node
/**
 * reset-test-data.ts — wipe test data system-wide, preserve god-admins.
 *
 * Run this between test passes when you want a clean platform but don't
 * want to re-seed god-admin accounts, platform settings, or the shipping
 * /tax catalogs. The script:
 *
 *   1. Snapshots row counts for every public table ("before" report).
 *   2. Deletes god-admin-adjacent rows that would otherwise hold users
 *      in place (sessions for non-god-admins, user_shops, user_2fa,
 *      oauth_accounts, audit_logs, staff_* fan-out).
 *   3. TRUNCATE ... RESTART IDENTITY CASCADE on every non-preserved
 *      table in a single statement. CASCADE handles FK-chained children
 *      (shops → products → variants → images, etc.); RESTART IDENTITY
 *      resets sequences so test runs don't leak ID drift into subsequent
 *      snapshots.
 *   4. DELETE FROM users WHERE is_default_admin = false.
 *   5. Re-counts every table and prints a before/after diff.
 *   6. Flushes Redis (cache + rate-limit + idle-timeout keys) to match.
 *
 * Preserved tables (never touched):
 *   - _migrations            (migration ledger; must match schema state)
 *   - users                  (god-admin rows handled manually)
 *   - platform_settings      (platform-level config)
 *   - shipping_rate_seed     (reference data seeded via migrations)
 *   - tax_rate_seed          (reference data seeded via migrations)
 *   - shipping_carriers      (catalog seeded via migrations)
 *
 * Usage:
 *
 *   # Preview — show plan + row counts, don't write:
 *   pnpm tsx scripts/ops/reset-test-data.ts --dry-run
 *
 *   # Execute:
 *   pnpm tsx scripts/ops/reset-test-data.ts --yes
 *
 *   # Execute without Redis flush (leave caches alone):
 *   pnpm tsx scripts/ops/reset-test-data.ts --yes --skip-redis
 *
 * Flags:
 *   --dry-run       Print plan + counts, don't execute.
 *   --yes           Required for non-dry-run writes (two-step lock).
 *   --skip-redis    Don't flush Redis on execute (default: flush).
 *
 * Exit codes:
 *   0  success
 *   1  bad arguments
 *   2  database / redis error
 */

import { createDb, destroyDb } from '../../packages/db/src/index.js'
import { sql } from 'kysely'
import { getRedis, closeRedis } from '@gbox/core/modules/cache/redis.js'

// ---------------------------------------------------------------------------
// Preserved tables — touched only indirectly (users: manual DELETE of
// non-god-admins; others: left fully intact).
// ---------------------------------------------------------------------------
const PRESERVED_TABLES = new Set<string>([
  '_migrations',
  'users',
  'platform_settings',
  'shipping_rate_seed',
  'tax_rate_seed',
  'shipping_carriers',
])

interface Args {
  dryRun: boolean
  confirmed: boolean
  skipRedis: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    dryRun: false,
    confirmed: false,
    skipRedis: false,
  }
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes') out.confirmed = true
    else if (a === '--skip-redis') out.skipRedis = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'See header comment in scripts/ops/reset-test-data.ts for usage.',
      )
      process.exit(0)
    }
  }
  if (!out.dryRun && !out.confirmed) {
    throw new Error('Refusing to write without --dry-run or --yes.')
  }
  return out
}

type RowCounts = Record<string, number>

async function countAllTables(
  db: ReturnType<typeof createDb>,
): Promise<RowCounts> {
  const res = await sql<{ table_name: string }>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `.execute(db)
  const counts: RowCounts = {}
  for (const { table_name } of res.rows) {
    try {
      const r = await sql<{ n: string }>`
        SELECT COUNT(*)::text AS n FROM ${sql.id(table_name)}
      `.execute(db)
      counts[table_name] = Number(r.rows[0]?.n ?? '0')
    } catch (err) {
      // Some tables may have permission issues; treat as 0.
      counts[table_name] = -1
    }
  }
  return counts
}

function formatCountsDiff(before: RowCounts, after: RowCounts | null): string {
  const tables = Object.keys(before).sort()
  const rows: string[] = []
  let totalBefore = 0
  let totalAfter = 0
  for (const t of tables) {
    const b = before[t] ?? 0
    const a = after ? (after[t] ?? 0) : null
    totalBefore += b
    if (after) totalAfter += a ?? 0
    if (b === 0 && (a === null || a === 0)) continue
    const marker = PRESERVED_TABLES.has(t) ? '[preserve]' : '          '
    if (after === null) {
      rows.push(`  ${marker} ${t.padEnd(40)} ${String(b).padStart(8)}`)
    } else {
      const delta = a !== null ? a - b : 0
      const deltaStr = delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${delta})`
      rows.push(
        `  ${marker} ${t.padEnd(40)} ${String(b).padStart(8)} -> ${String(a).padStart(8)}${deltaStr}`,
      )
    }
  }
  const header = after
    ? `  ${'           '}${'table'.padEnd(40)} ${'before'.padStart(8)}    ${'after'.padStart(8)}\n`
    : `  ${'           '}${'table'.padEnd(40)} ${'rows'.padStart(8)}\n`
  const footer = after
    ? `\n  Total rows: ${totalBefore} -> ${totalAfter} (delta ${totalAfter - totalBefore})`
    : `\n  Total rows: ${totalBefore}`
  return header + rows.join('\n') + footer
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const db = createDb()

  try {
    // ------------------------------------------------------------------
    // Step 0 — sanity: at least one god-admin must exist, else refuse
    // (running reset without any god-admin would lock us out entirely).
    // ------------------------------------------------------------------
    const godAdmins = await db
      .selectFrom('users')
      .select(['id', 'email'])
      .where('is_default_admin', '=', true)
      .execute()

    if (godAdmins.length === 0) {
      throw new Error(
        'No god-admin rows found (users.is_default_admin=true). Refusing to ' +
          'wipe — you would be locked out. Re-seed god admin before running.',
      )
    }

    console.log(`God-admin rows to preserve (${godAdmins.length}):`)
    for (const g of godAdmins) console.log(`  - ${g.email} (${g.id})`)

    // ------------------------------------------------------------------
    // Step 1 — snapshot counts
    // ------------------------------------------------------------------
    console.log('\nCounting rows in all public tables…')
    const before = await countAllTables(db)
    const totalTables = Object.keys(before).length
    const totalRows = Object.values(before).reduce((a, b) => a + Math.max(b, 0), 0)
    console.log(`  ${totalTables} tables, ${totalRows} total rows`)

    // Work out which tables will be truncated (all non-preserved).
    const allTables = Object.keys(before).sort()
    const truncateTargets = allTables.filter((t) => !PRESERVED_TABLES.has(t))
    console.log(
      `\nWould TRUNCATE ${truncateTargets.length} table(s) (CASCADE + RESTART IDENTITY):`,
    )
    for (const t of truncateTargets) {
      const n = before[t] ?? 0
      if (n > 0) console.log(`  - ${t.padEnd(40)} (${n} rows)`)
    }

    // Show non-zero preserved tables for transparency.
    const preservedNonZero = [...PRESERVED_TABLES].filter(
      (t) => (before[t] ?? 0) > 0,
    )
    if (preservedNonZero.length > 0) {
      console.log('\nPreserving (will NOT be touched):')
      for (const t of preservedNonZero) {
        const n = before[t] ?? 0
        console.log(`  - ${t.padEnd(40)} (${n} rows)`)
      }
    }

    console.log(
      `\nAlso: DELETE FROM users WHERE is_default_admin = false ` +
        `(${(before.users ?? 0) - godAdmins.length} row(s))`,
    )
    if (!args.skipRedis) {
      console.log('Also: Redis FLUSHALL')
    } else {
      console.log('Skipping Redis flush (--skip-redis)')
    }

    if (args.dryRun) {
      console.log('\n---\nDry run — no changes written.')
      console.log('\n' + formatCountsDiff(before, null))
      return
    }

    // ------------------------------------------------------------------
    // Step 2 — execute TRUNCATE CASCADE
    //
    // Single statement with all target tables; PG figures out cascade
    // order internally. Wrapped in a single transaction so any FK
    // surprise rolls back cleanly.
    // ------------------------------------------------------------------
    console.log('\nExecuting TRUNCATE (CASCADE, RESTART IDENTITY)…')
    await db.transaction().execute(async (tx) => {
      const idList = truncateTargets.map((t) => sql.id(t))
      const joined = sql.join(idList, sql`, `)
      await sql`TRUNCATE ${joined} RESTART IDENTITY CASCADE`.execute(tx)
      console.log(`  ✓ truncated ${truncateTargets.length} tables`)

      // DELETE non-god-admin users. sessions, user_shops, etc. were
      // already truncated above; users row cleanup is the last step.
      const delRes = await tx
        .deleteFrom('users')
        .where('is_default_admin', '=', false)
        .executeTakeFirst()
      console.log(`  ✓ deleted ${delRes.numDeletedRows ?? 0n} non-god-admin user(s)`)
    })

    // ------------------------------------------------------------------
    // Step 3 — Redis flush
    // ------------------------------------------------------------------
    if (!args.skipRedis) {
      try {
        const r = await getRedis()
        await r.flushAll()
        console.log('  ✓ redis FLUSHALL complete')
      } catch (err) {
        console.warn(
          '  ! redis flush failed (continuing):',
          (err as Error).message,
        )
      }
    }

    // ------------------------------------------------------------------
    // Step 4 — post-counts
    // ------------------------------------------------------------------
    console.log('\nRecounting…')
    const after = await countAllTables(db)
    console.log('\n' + formatCountsDiff(before, after))
    console.log('\nDone.')
  } finally {
    await destroyDb(db).catch(() => {})
    await closeRedis().catch(() => {})
  }
}

const isDirect = process.argv[1]?.endsWith('reset-test-data.ts')
if (isDirect) {
  void main().catch((err) => {
    console.error('reset-test-data failed:', (err as Error).message)
    process.exit(2)
  })
}

export { parseArgs, PRESERVED_TABLES }
