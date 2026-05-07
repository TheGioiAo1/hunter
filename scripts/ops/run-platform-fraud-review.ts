/**
 * Gbox Platform — Platform Fraud Review cron (Phase 14 PR6)
 *
 * Scans the last 24h of orders for per-shop fraud clusters and fires
 * the `platform_fraud_review` alert to the god-admin mailbox for each
 * shop that crosses the heuristic threshold.
 *
 * Heuristics (any one trips the alert):
 *
 *   H1. `fraud_score_cluster`: 3+ orders with fraud_score >= 75 in 24h.
 *       Signal that the fraud engine is seeing a spike on this shop.
 *   H2. `risk_level_high_cluster`: 3+ orders with risk_level='high' in
 *       24h, ignoring fraud_score (fallback for shops where the fraud
 *       engine hasn't scored yet).
 *   H3. `payment_failure_burst`: 5+ transactions with status='failed'
 *       in 24h. Commonly precedes a card-testing attack.
 *
 * Dedup: `shop:<uuid>:YYYY-MM-DD` — one alert per shop per calendar day.
 * A shop that trips every heuristic gets ONE email listing all flags.
 *
 * Usage:
 *
 *   # Real send (production cron at 03:00 UTC):
 *   pnpm tsx scripts/ops/run-platform-fraud-review.ts
 *
 *   # Specific window + dry run:
 *   pnpm tsx scripts/ops/run-platform-fraud-review.ts \
 *     --since=2026-04-21T00:00:00Z --dry-run
 *
 * Flags:
 *   --since=ISO      Start of the 24h window (default: 24h ago).
 *   --dry-run        Compute + print, don't call the emitter.
 *   --help
 *
 * Exit codes:
 *   0  all shop alerts processed (sent OR deduped)
 *   1  bad arguments
 *   2  database error
 *   3  at least one per-shop send failed
 */

import { sql } from 'kysely'
import { emitPlatformFraudReview } from '@gbox/core/modules/platform-alerts/emitters.js'

// ---------------------------------------------------------------------------
// Tunables (match spec doc §3c env var defaults)
// ---------------------------------------------------------------------------

const HIGH_RISK_THRESHOLD = Number(process.env.HIGH_RISK_ORDER_THRESHOLD ?? '75')
const FRAUD_CLUSTER_MIN = 3 // H1 + H2
const PAYMENT_FAILURE_BURST_MIN = 5 // H3

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  since: string | null
  dryRun: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { since: null, dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg.startsWith('--since=')) {
      opts.since = arg.slice('--since='.length)
      // Loose ISO check — trust JS Date.parse otherwise.
      if (Number.isNaN(Date.parse(opts.since))) {
        console.error(`bad --since: ${arg}`)
        process.exit(1)
      }
    } else {
      console.error(`unknown arg: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }
  return opts
}

function printHelp(): void {
  console.log(`usage: run-platform-fraud-review [--since=ISO] [--dry-run]

Scans the last 24h of orders for per-shop fraud clusters + fires the
'platform_fraud_review' email once per flagged shop.`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function twentyFourHoursAgoIso(): string {
  const d = new Date()
  d.setUTCHours(d.getUTCHours() - 24)
  return d.toISOString()
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const since = opts.since ?? twentyFourHoursAgoIso()

  const { createDb } = await import('@gbox/db')
  const db = createDb()

  let exitCode = 0
  try {
    // ---- H1: fraud_score_cluster (>= threshold) ----
    const fraudClusters = await db
      .selectFrom('orders as o')
      .innerJoin('shops as s', 's.id', 'o.shop_id')
      .select([
        's.id as shop_id',
        's.name as shop_name',
        db.fn.count<string>('o.id').as('hit_count'),
      ])
      .where('o.created_at', '>=', since)
      .where('o.fraud_score', '>=', HIGH_RISK_THRESHOLD)
      .groupBy(['s.id', 's.name'])
      .having(sql`COUNT(o.id) >= ${FRAUD_CLUSTER_MIN}`)
      .execute()

    // ---- H2: risk_level_high_cluster ----
    const riskLevelClusters = await db
      .selectFrom('orders as o')
      .innerJoin('shops as s', 's.id', 'o.shop_id')
      .select([
        's.id as shop_id',
        's.name as shop_name',
        db.fn.count<string>('o.id').as('hit_count'),
      ])
      .where('o.created_at', '>=', since)
      .where('o.risk_level', '=', 'high')
      .groupBy(['s.id', 's.name'])
      .having(sql`COUNT(o.id) >= ${FRAUD_CLUSTER_MIN}`)
      .execute()

    // ---- H3: payment_failure_burst ----
    // transactions.created_at gates the burst window. Join to orders +
    // shops so we can group by shop.
    const paymentBursts = await db
      .selectFrom('transactions as t')
      .innerJoin('orders as o', 'o.id', 't.order_id')
      .innerJoin('shops as s', 's.id', 'o.shop_id')
      .select([
        's.id as shop_id',
        's.name as shop_name',
        db.fn.count<string>('t.id').as('hit_count'),
      ])
      .where('t.created_at', '>=', since)
      .where('t.status', '=', 'failed')
      .groupBy(['s.id', 's.name'])
      .having(sql`COUNT(t.id) >= ${PAYMENT_FAILURE_BURST_MIN}`)
      .execute()

    // ---- Merge: one alert per shop, listing every tripped heuristic ----
    type FlaggedShop = {
      shopId: string
      shopName: string
      flags: string[]
    }
    const bag: Record<string, FlaggedShop> = {}

    for (const r of fraudClusters as any[]) {
      bag[r.shop_id] = bag[r.shop_id] ?? {
        shopId: r.shop_id,
        shopName: r.shop_name ?? 'Unknown',
        flags: [],
      }
      bag[r.shop_id].flags.push(`fraud_score_cluster (${r.hit_count})`)
    }
    for (const r of riskLevelClusters as any[]) {
      bag[r.shop_id] = bag[r.shop_id] ?? {
        shopId: r.shop_id,
        shopName: r.shop_name ?? 'Unknown',
        flags: [],
      }
      bag[r.shop_id].flags.push(`risk_level_high_cluster (${r.hit_count})`)
    }
    for (const r of paymentBursts as any[]) {
      bag[r.shop_id] = bag[r.shop_id] ?? {
        shopId: r.shop_id,
        shopName: r.shop_name ?? 'Unknown',
        flags: [],
      }
      bag[r.shop_id].flags.push(`payment_failure_burst (${r.hit_count})`)
    }

    const flaggedShops = Object.values(bag)

    console.log('== Platform Fraud Review ==')
    console.log(`  since:               ${since}`)
    console.log(`  threshold:           fraud_score >= ${HIGH_RISK_THRESHOLD}`)
    console.log(`  H1 fraud clusters:   ${fraudClusters.length}`)
    console.log(`  H2 risk clusters:    ${riskLevelClusters.length}`)
    console.log(`  H3 payment bursts:   ${paymentBursts.length}`)
    console.log(`  distinct shops:      ${flaggedShops.length}`)
    console.log(`  mode:                ${opts.dryRun ? 'DRY RUN' : 'LIVE SEND'}`)
    console.log('')

    if (flaggedShops.length === 0) {
      console.log('no shops flagged — nothing to send.')
      return
    }

    if (opts.dryRun) {
      for (const s of flaggedShops) {
        console.log(`  would alert: shop=${s.shopName} (${s.shopId})`)
        for (const f of s.flags) console.log(`    - ${f}`)
      }
      return
    }

    let sent = 0
    let deduped = 0
    let failed = 0
    for (const s of flaggedShops) {
      try {
        const heuristic = s.flags.join(', ')
        // Evidence URL points the on-call at the god-admin order list
        // filtered to this shop + last 24h. Phase 17 may add a dedicated
        // fraud-cluster page; for now this is the fastest drill-in.
        const evidenceUrl = `/god-admin/orders?shop_id=${encodeURIComponent(
          s.shopId,
        )}&risk=high&since=${encodeURIComponent(since)}`
        const result = await emitPlatformFraudReview(db, {
          shopId: s.shopId,
          shopName: s.shopName,
          heuristic,
          evidenceUrl,
        })
        if (result.sent) {
          sent++
          console.log(`  SENT  shop=${s.shopName}`)
        } else if (result.reason === 'deduped') {
          deduped++
          console.log(`  DEDUP shop=${s.shopName}`)
        } else {
          console.log(`  SKIP  shop=${s.shopName} reason=${result.reason}`)
        }
      } catch (err: any) {
        failed++
        console.error(
          `  FAIL  shop=${s.shopName}: ${err?.message ?? err}`,
        )
      }
    }

    console.log('')
    console.log(`== Done ==`)
    console.log(`  sent:    ${sent}`)
    console.log(`  deduped: ${deduped}`)
    console.log(`  failed:  ${failed}`)

    if (failed > 0) exitCode = 3
  } catch (err: any) {
    console.error('FATAL:', err.message ?? err)
    exitCode = 2
  } finally {
    await db.destroy()
  }

  process.exit(exitCode)
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
