/**
 * Gbox Platform — Platform Weekly Roundup cron (Phase 14 PR6)
 *
 * Aggregates last week's platform-wide numbers + top-10 shops by GMV
 * and fires the `platform_weekly_roundup` email to the god-admin
 * mailbox.
 *
 * "Last week" = Monday 00:00 UTC → following Monday 00:00 UTC, based on
 * the invocation time. Meant to run at Monday 07:00 UTC (1h after
 * daily-digest on the same day).
 *
 * Dedup: `week:YYYY-WW` ISO week (Thursday rule; see emitters.ts).
 * Safe to re-run — second invocation for the same ISO week no-ops.
 *
 * Usage:
 *
 *   # Real send (production cron Mon 07:00 UTC):
 *   pnpm tsx scripts/ops/run-platform-weekly-roundup.ts
 *
 *   # Specific window + dry run:
 *   pnpm tsx scripts/ops/run-platform-weekly-roundup.ts \
 *     --week-start=2026-04-13 --dry-run
 *
 * Flags:
 *   --week-start=YYYY-MM-DD  Monday of the week to summarise (default:
 *                            the most-recent completed Monday in UTC).
 *   --dry-run                Compute + print, don't call the emitter.
 *   --help
 *
 * Exit codes:
 *   0  sent OR deduped
 *   1  bad arguments
 *   2  database / send error
 */

import { sql } from 'kysely'
import { emitPlatformWeeklyRoundup } from '@gbox/core/modules/platform-alerts/emitters.js'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  weekStart: string | null
  dryRun: boolean
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { weekStart: null, dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg.startsWith('--week-start=')) {
      const v = arg.slice('--week-start='.length)
      if (!ISO_DATE_RE.test(v)) {
        console.error(`bad --week-start: ${arg} (expected YYYY-MM-DD)`)
        process.exit(1)
      }
      opts.weekStart = v
    } else {
      console.error(`unknown arg: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`usage: run-platform-weekly-roundup [--week-start=YYYY-MM-DD] [--dry-run]

Sends the 'platform_weekly_roundup' email. Week is Monday→Monday UTC.
Dedup key is 'week:YYYY-WW' — safe to re-run.`)
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Return YYYY-MM-DD of the most recent Monday (UTC) strictly before
 * `now`. When `now` is Monday itself this returns the *previous*
 * Monday — we only send a roundup once the week is complete.
 */
export function previousMondayUtc(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ),
  )
  const dow = d.getUTCDay() // Sunday = 0, Monday = 1, …
  // days back to the most-recent-completed Monday.
  //   Mon=1 → 7 (go back a full week; "this Monday" isn't complete yet)
  //   Tue=2 → 1
  //   Sun=0 → 6
  const back = dow === 1 ? 7 : (dow + 6) % 7
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

/**
 * Format a Monday ISO date as "Apr 20, 2026" (month short + day + year).
 * Used as the email header. Keep locale-independent to avoid surprises
 * when the server env switches.
 */
export function formatWeekStart(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

function nextMondayIso(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 7)
  return d.toISOString().slice(0, 10)
}

function formatUsd(amount: number | string | null | undefined): string {
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

/**
 * Escape HTML-sensitive chars for the top-shops block. Shop names are
 * user-controlled (merchants pick their own), so we must escape — the
 * email renderer trusts this string.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const weekStartIso = opts.weekStart ?? previousMondayUtc()
  const nextMonday = nextMondayIso(weekStartIso)

  const { createDb } = await import('@gbox/db')
  const db = createDb()

  try {
    const start = `${weekStartIso}T00:00:00Z`
    const endExclusive = `${nextMonday}T00:00:00Z`

    // ---- GMV total across all shops for the week ----
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

    // ---- Top 10 shops by GMV ----
    const topShops = await db
      .selectFrom('orders as o')
      .innerJoin('shops as s', 's.id', 'o.shop_id')
      .select([
        's.name as shop_name',
        's.slug as shop_slug',
        sql<string>`COALESCE(SUM(o.total_price::numeric), 0)`.as('gmv'),
        db.fn.count<string>('o.id').as('order_count'),
      ])
      .where('o.created_at', '>=', start)
      .where('o.created_at', '<', endExclusive)
      .where((eb) =>
        eb.or([
          eb('o.cancelled_at', 'is', null),
          eb('o.cancelled_at', '>=', endExclusive),
        ]),
      )
      .groupBy(['s.id', 's.name', 's.slug'])
      .orderBy(sql`COALESCE(SUM(o.total_price::numeric), 0)`, 'desc')
      .limit(10)
      .execute()

    // Pre-render HTML — emitter passes it straight into the template
    // as `top_shops_html`. Keep markup simple + inline-style-only so it
    // renders in every mail client.
    const topShopsHtml =
      topShops.length === 0
        ? '<p style="color:#666;margin:0">No shops with orders this week.</p>'
        : '<ol style="margin:0;padding-left:20px;font-family:system-ui,sans-serif">' +
          topShops
            .map(
              (r: any) =>
                `<li style="margin:6px 0"><strong>${escapeHtml(
                  r.shop_name ?? r.shop_slug ?? 'Unknown',
                )}</strong> — ${formatUsd(r.gmv)} <span style="color:#888">(${Number(
                  r.order_count,
                )} orders)</span></li>`,
            )
            .join('') +
          '</ol>'

    const weekStart = formatWeekStart(weekStartIso)

    console.log('== Platform Weekly Roundup ==')
    console.log(`  week start:      ${weekStart} (${weekStartIso})`)
    console.log(`  GMV total:       ${gmvTotal}`)
    console.log(`  top shops:       ${topShops.length}`)
    console.log(`  mode:            ${opts.dryRun ? 'DRY RUN' : 'LIVE SEND'}`)
    console.log('')

    if (opts.dryRun) {
      console.log('dry-run — not calling sendPlatformAlert.')
      console.log('topShopsHtml preview:')
      console.log(topShopsHtml.slice(0, 500) + (topShopsHtml.length > 500 ? '…' : ''))
      return
    }

    const result = await emitPlatformWeeklyRoundup(db, {
      weekStart,
      gmvTotal,
      topShopsHtml,
    })

    if (result.sent) {
      console.log(`sent. alertType=${result.alertType} dedupKey=${result.dedupKey}`)
    } else {
      console.log(`not sent. reason=${result.reason} dedupKey=${result.dedupKey ?? ''}`)
    }
  } catch (err: any) {
    console.error('FATAL:', err.message ?? err)
    process.exitCode = 2
  } finally {
    await db.destroy()
  }
}

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
