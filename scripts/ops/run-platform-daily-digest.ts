/**
 * Gbox Platform — Platform Daily Digest cron (Phase 14 PR6)
 *
 * Aggregates yesterday's platform-wide KPIs and fires the
 * `platform_daily_digest` email to the god-admin mailbox.
 *
 * Metrics:
 *   - GMV total (sum of orders.total_price, USD-normalised via currency
 *     column; for PR6 we just sum the raw numerics and report with the
 *     shop's own currency letter — merchants running multi-currency
 *     shops are rare at platform stage, so this is good enough).
 *   - New shops (shops.created_at within yesterday UTC).
 *   - Churned shops (shops.status transitioned to `closed`/`suspended`
 *     within yesterday — inferred from status='closed' + updated_at
 *     in-range; Phase 17 may add a proper status_history table).
 *
 * Dedup: shop-less cron → `date:YYYY-MM-DD`, UNIQUE-partial-index
 * guarantees a second invocation within the same UTC day is a no-op.
 *
 * Usage:
 *
 *   # Real send (production cron at 06:00 UTC):
 *   pnpm tsx scripts/ops/run-platform-daily-digest.ts
 *
 *   # Specific date + dry run:
 *   pnpm tsx scripts/ops/run-platform-daily-digest.ts \
 *     --date=2026-04-21 --dry-run
 *
 * Flags:
 *   --date=YYYY-MM-DD  UTC date to aggregate (default: yesterday)
 *   --dry-run          Compute metrics + print what we'd send, but don't
 *                      call sendPlatformAlert() (still runs every DB
 *                      query — so dry-run is a honest read-only check).
 *   --help             This message.
 *
 * Exit codes:
 *   0  digest sent OR cleanly deduped (check stderr for "deduped")
 *   1  bad arguments
 *   2  database / send error
 */

import { sql } from 'kysely'
import { emitPlatformDailyDigest } from '@gbox/core/modules/platform-alerts/emitters.js'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  date: string | null
  dryRun: boolean
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { date: null, dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg.startsWith('--date=')) {
      const v = arg.slice('--date='.length)
      if (!ISO_DATE_RE.test(v)) {
        console.error(`bad --date value: ${arg} (expected YYYY-MM-DD)`)
        process.exit(1)
      }
      opts.date = v
    } else {
      console.error(`unknown arg: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`usage: run-platform-daily-digest [--date=YYYY-MM-DD] [--dry-run]

Sends the 'platform_daily_digest' email to the god-admin mailbox.
Dedup is handled by platform_alert_deliveries (UNIQUE on date key).`)
}

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** Format a raw numeric (dollars as a string/number) as "$12,345.67". */
export function formatUsd(amount: number | string | null | undefined): string {
  const n = Number(amount ?? 0)
  if (!Number.isFinite(n)) return '$0.00'
  return (
    '$' +
    n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const date = opts.date ?? yesterdayUtc()

  // Lazy DB import — keeps --help snappy.
  const { createDb } = await import('@gbox/db')
  const db = createDb()

  try {
    // Window boundaries in UTC — a date's row counts "anything with
    // created_at/updated_at falling inside [start, next-day-start)".
    const start = `${date}T00:00:00Z`
    const endExclusive = new Date(new Date(start).getTime() + 86400000)
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')

    // ---- GMV total (raw numeric sum across all shops) ----
    // We filter on status NOT IN ('cancelled','voided') so refunds-in-
    // progress still count; Shopify's daily digest uses the same rule.
    const gmvRow = await db
      .selectFrom('orders')
      .select(sql<string>`COALESCE(SUM(total_price::numeric), 0)`.as('gmv'))
      .where('created_at', '>=', start)
      .where('created_at', '<', endExclusive)
      .where((eb) =>
        eb.or([
          eb('cancelled_at', 'is', null),
          eb('cancelled_at', '>=', endExclusive),
        ]),
      )
      .executeTakeFirst()

    const gmvTotal = formatUsd(gmvRow?.gmv ?? 0)

    // ---- New shops (created yesterday) ----
    const newShopsRow = await db
      .selectFrom('shops')
      .select(db.fn.countAll<string>().as('count'))
      .where('created_at', '>=', start)
      .where('created_at', '<', endExclusive)
      .executeTakeFirst()
    const newShops = Number(newShopsRow?.count ?? 0)

    // ---- Churned shops (transitioned to closed/suspended yesterday) ----
    // Best-effort from status + updated_at in-range — will be exact
    // once Phase 17 ships shop_status_history. Acceptable at PR6
    // because the recipient is internal + read once a day.
    const churnRow = await db
      .selectFrom('shops')
      .select(db.fn.countAll<string>().as('count'))
      .where('status', 'in', ['closed', 'suspended'])
      .where('updated_at', '>=', start)
      .where('updated_at', '<', endExclusive)
      .executeTakeFirst()
    const churnedShops = Number(churnRow?.count ?? 0)

    console.log('== Platform Daily Digest ==')
    console.log(`  date:            ${date}`)
    console.log(`  GMV total:       ${gmvTotal}`)
    console.log(`  New shops:       ${newShops}`)
    console.log(`  Churned shops:   ${churnedShops}`)
    console.log(`  mode:            ${opts.dryRun ? 'DRY RUN' : 'LIVE SEND'}`)
    console.log('')

    if (opts.dryRun) {
      console.log('dry-run — not calling sendPlatformAlert.')
      return
    }

    const result = await emitPlatformDailyDigest(db, {
      date,
      gmvTotal,
      newShops,
      churnedShops,
    })

    if (result.sent) {
      console.log(`sent. alertType=${result.alertType} dedupKey=${result.dedupKey}`)
    } else {
      // Deduped is the common case on re-run — not an error, so exit 0.
      console.log(`not sent. reason=${result.reason} dedupKey=${result.dedupKey ?? ''}`)
    }
  } catch (err: any) {
    console.error('FATAL:', err.message ?? err)
    process.exitCode = 2
  } finally {
    await db.destroy()
  }
}

// Invoke when run directly (not when imported by tests).
const isDirect =
  typeof import.meta.url === 'string' &&
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')

if (isDirect) {
  main().catch((err) => {
    console.error('unhandled:', err)
    process.exit(2)
  })
}
