/**
 * Gbox Platform — Daily Metrics Backfill (Phase 6 PR1)
 *
 * Walks a date range × shops and aggregates orders/refunds/visitors/
 * conversions into the `daily_metrics` table. Intended for:
 *
 *   1. First-time bootstrap after shipping Phase 6 PR1 (the nightly
 *      cron only rolls up yesterday — historical rows stay empty
 *      until this runs).
 *   2. Recovery when the cron was down for > 24h (the nightly only
 *      ever re-aggregates `yesterday`, so a 3-day outage needs
 *      `--days=3` here to catch up).
 *   3. Re-aggregation after a data fix (every call is idempotent via
 *      ON CONFLICT (shop_id, date) → DO UPDATE).
 *
 * Usage:
 *
 *   # Backfill last 30 days for every active shop:
 *   pnpm tsx scripts/ops/backfill-daily-metrics.ts --days=30
 *
 *   # Backfill a specific window for a single shop (dry-run):
 *   pnpm tsx scripts/ops/backfill-daily-metrics.ts \
 *     --since=2026-01-01 --until=2026-04-21 --shop-id=<uuid> --dry-run
 *
 * Flags:
 *   --days=N          Shortcut: backfill the last N days (UTC) through
 *                     yesterday. Conflicts with --since/--until.
 *   --since=ISODATE   Start date (YYYY-MM-DD, UTC) inclusive.
 *   --until=ISODATE   End date (YYYY-MM-DD, UTC) inclusive. Default:
 *                     yesterday UTC.
 *   --shop-id=<uuid>  Single shop. Default: all shops with status='active'.
 *   --dry-run         Resolve the date range + shop list and print what
 *                     would be rolled up, but don't write to daily_metrics.
 *   --help            This message.
 *
 * Exit codes:
 *   0  backfill complete (all shop × day combinations succeeded)
 *   1  bad arguments
 *   2  database error
 *   3  at least one shop × day rollup failed (check stderr for detail)
 */

import { rollupDay } from '@gbox/core/modules/analytics/daily-metrics.js'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  days: number | null
  since: string | null
  until: string | null
  shopId: string | null
  dryRun: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    days: null,
    since: null,
    until: null,
    shopId: null,
    dryRun: false,
  }
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg.startsWith('--days=')) {
      const v = Number(arg.slice('--days='.length))
      if (!Number.isInteger(v) || v <= 0) {
        console.error(`bad --days value: ${arg}`)
        process.exit(1)
      }
      opts.days = v
    } else if (arg.startsWith('--since=')) {
      opts.since = arg.slice('--since='.length)
    } else if (arg.startsWith('--until=')) {
      opts.until = arg.slice('--until='.length)
    } else if (arg.startsWith('--shop-id=')) {
      opts.shopId = arg.slice('--shop-id='.length)
    } else {
      console.error(`unknown arg: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }
  if (opts.days !== null && (opts.since || opts.until)) {
    console.error('--days is mutually exclusive with --since/--until')
    process.exit(1)
  }
  return opts
}

function printHelp(): void {
  console.log(`usage: backfill-daily-metrics [--days=N | --since=ISO --until=ISO]
                               [--shop-id=UUID] [--dry-run]

Idempotent — safe to re-run.`)
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function addDaysUtc(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Build the inclusive [since, until] list of ISO dates. */
export function buildDateRange(opts: {
  days: number | null
  since: string | null
  until: string | null
}): string[] {
  let since: string
  let until: string

  if (opts.days !== null) {
    until = yesterdayUtc()
    since = addDaysUtc(until, -(opts.days - 1))
  } else if (opts.since && opts.until) {
    since = opts.since
    until = opts.until
  } else if (opts.since) {
    since = opts.since
    until = yesterdayUtc()
  } else {
    // Nothing specified → default to last 7 days.
    until = yesterdayUtc()
    since = addDaysUtc(until, -6)
  }

  if (!isIsoDate(since)) {
    console.error(`bad --since: ${since} (expected YYYY-MM-DD)`)
    process.exit(1)
  }
  if (!isIsoDate(until)) {
    console.error(`bad --until: ${until} (expected YYYY-MM-DD)`)
    process.exit(1)
  }
  if (since > until) {
    console.error(`--since (${since}) is after --until (${until})`)
    process.exit(1)
  }

  const out: string[] = []
  let cursor = since
  while (cursor <= until) {
    out.push(cursor)
    cursor = addDaysUtc(cursor, 1)
  }
  return out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const dates = buildDateRange(opts)

  // Lazy DB import — keeps --help snappy.
  const { createDb } = await import('@gbox/db')
  const db = createDb()

  let exitCode = 0
  try {
    // ---- Resolve shop list ----
    const shopsQuery = db
      .selectFrom('shops')
      .select(['id', 'slug'])
      .where('status', '=', 'active')

    const shops = opts.shopId
      ? await shopsQuery.where('id', '=', opts.shopId).execute()
      : await shopsQuery.execute()

    if (shops.length === 0) {
      console.error(
        opts.shopId
          ? `no active shop found with id=${opts.shopId}`
          : 'no active shops in database',
      )
      process.exit(2)
    }

    console.log('== Daily metrics backfill ==')
    console.log(`  dates:    ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)`)
    console.log(`  shops:    ${shops.length}${opts.shopId ? ` (filtered to ${opts.shopId})` : ''}`)
    console.log(`  mode:     ${opts.dryRun ? 'DRY RUN' : 'LIVE WRITE'}`)
    console.log('')

    if (opts.dryRun) {
      console.log('dry-run — skipping writes. shops:')
      for (const s of shops.slice(0, 10)) console.log(`  - ${s.id} ${s.slug}`)
      if (shops.length > 10) console.log(`  … and ${shops.length - 10} more`)
      console.log('')
      console.log(`would roll up ${shops.length * dates.length} (shop × day) rows.`)
      return
    }

    // ---- Run the rollup grid ----
    let ok = 0
    let failed = 0
    const startedAt = Date.now()

    for (const shop of shops) {
      for (const iso of dates) {
        try {
          await rollupDay(db as any, shop.id, iso)
          ok++
          if (ok % 100 === 0) {
            console.log(`  … ${ok} rolled up`)
          }
        } catch (err: any) {
          failed++
          console.error(
            `  FAIL shop=${shop.slug ?? shop.id} date=${iso}: ${err.message ?? err}`,
          )
        }
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log('')
    console.log(`== Done ==`)
    console.log(`  rolled up: ${ok}`)
    console.log(`  failed:    ${failed}`)
    console.log(`  elapsed:   ${elapsed}s`)

    if (failed > 0) exitCode = 3
  } catch (err: any) {
    console.error('FATAL:', err.message ?? err)
    exitCode = 2
  } finally {
    await db.destroy()
  }

  process.exit(exitCode)
}

// Invoke when run directly. Wrapped so `buildDateRange` stays importable from
// the unit test without triggering main().
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
