/**
 * Gbox Platform — Scaling Tier Math (Phase 3F)
 *
 * Single source of truth for the capacity targets the platform is
 * sized for. Every load harness, runbook, and capacity-planning doc
 * must reference these constants instead of hand-rolling the math,
 * so the stack can be re-targeted with a single edit here.
 *
 * Tiers reflect Thai's "aim high from day one" direction:
 *
 *   - `t100k`: initial Phase 3 ceiling — 100,000 orders/month. Safe
 *     on a single VPS with PM2 cluster + Redis + PgBouncer.
 *   - `t1m`  : 10x jump — 1,000,000 orders/month. Requires a read
 *     replica, Redis stock reservation (Phase 3G), and cross-worker
 *     cache invalidation (Phase 3H).
 *   - `t10m` : 100x jump — 10,000,000 orders/month. Requires a DB
 *     primary with partitioned orders table, Redis Cluster (or
 *     sharded cache), and a distributed k6 runner. A single k6
 *     process cannot physically generate the flash-sale peak for
 *     this tier.
 *
 * All derived numbers use the same conversion assumptions so the
 * tiers line up exactly — just scaled by 10x / 100x.
 *
 *   assumptions:
 *     conversionRate        = 2%     (pageviews per order = 50)
 *     peakMultiplier        = 10x    (dinner rush / payday)
 *     flashMultiplier       = 100x   (TikTok viral / flash sale)
 *     sessionDurationSec    = 5      (one browse iteration)
 *     checkoutDurationSec   = 5      (one checkout iteration)
 *
 *   derived (per tier):
 *     ordersPerSecAvg       = orders / 30 / 86_400
 *     ordersPerSecPeak      = ordersPerSecAvg * 10
 *     ordersPerSecFlash     = ordersPerSecAvg * 100
 *     pageviewsPerMonth     = orders / conversionRate
 *     pageviewsPerSecAvg    = pageviewsPerMonth / 30 / 86_400
 *     pageviewsPerSecPeak   = pageviewsPerSecAvg * 10
 *     pageviewsPerSecFlash  = pageviewsPerSecAvg * 100
 *
 *   VU count (Little's Law: concurrency = rate × duration):
 *     browseVUs   = pageviewsPerSec * sessionDurationSec
 *     checkoutVUs = ordersPerSec    * checkoutDurationSec
 *
 * A VU is NOT the same as a concurrent user — it's a k6 iteration
 * worker. 100 browse VUs each taking 5 seconds per iteration emit
 * 20 page-view requests per second, which is what we want at the
 * baseline tier.
 */

export type ScalingTierName = 't100k' | 't1m' | 't10m'

export interface ScalingTierMath {
  /** Human-readable name of the tier. */
  name: ScalingTierName
  /** Shipping label, e.g. "1M orders/month". */
  label: string
  /** Monthly order ceiling. */
  ordersPerMonth: number
  /** Average orders per second (monthly / 30d / 86,400s). */
  ordersPerSecAvg: number
  /** Peak orders per second (average × 10). */
  ordersPerSecPeak: number
  /** Flash-sale orders per second (average × 100). */
  ordersPerSecFlash: number
  /** Monthly pageviews (orders / conversionRate). */
  pageviewsPerMonth: number
  /** Average pageviews per second. */
  pageviewsPerSecAvg: number
  /** Peak pageviews per second. */
  pageviewsPerSecPeak: number
  /** Flash-sale pageviews per second. */
  pageviewsPerSecFlash: number
  /** k6 VU targets for each profile of the harness. */
  vus: {
    smoke: { browse: number; checkout: number }
    baseline: { browse: number; checkout: number }
    peak: { browse: number; checkout: number }
    flash: { browse: number; checkout: number }
    sustain: { browse: number; checkout: number }
  }
  /** Known bottlenecks hit at this tier — used by the capacity runbook. */
  bottlenecks: string[]
  /** Infrastructure prerequisites before this tier is even feasible. */
  prerequisites: string[]
}

const CONVERSION_RATE = 0.02
const PEAK_MULTIPLIER = 10
const FLASH_MULTIPLIER = 100
const SESSION_DURATION_SEC = 5
const CHECKOUT_DURATION_SEC = 5
const SECONDS_PER_MONTH = 30 * 86_400

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Compute all the derived numbers for a given monthly order ceiling.
 * Pure function — no side effects, no k6 / env dependencies — so it
 * can be imported from Vitest, docs generators, and the load harness
 * alike.
 */
function deriveTier(
  name: ScalingTierName,
  label: string,
  ordersPerMonth: number,
  bottlenecks: string[],
  prerequisites: string[],
): ScalingTierMath {
  const ordersPerSecAvg = ordersPerMonth / SECONDS_PER_MONTH
  const ordersPerSecPeak = ordersPerSecAvg * PEAK_MULTIPLIER
  const ordersPerSecFlash = ordersPerSecAvg * FLASH_MULTIPLIER

  const pageviewsPerMonth = ordersPerMonth / CONVERSION_RATE
  const pageviewsPerSecAvg = pageviewsPerMonth / SECONDS_PER_MONTH
  const pageviewsPerSecPeak = pageviewsPerSecAvg * PEAK_MULTIPLIER
  const pageviewsPerSecFlash = pageviewsPerSecAvg * FLASH_MULTIPLIER

  // Little's Law — concurrency = throughput * duration
  // (round up so we don't under-provision VUs).
  const browseBaselineVUs = Math.max(
    1,
    Math.ceil(pageviewsPerSecAvg * SESSION_DURATION_SEC),
  )
  const browsePeakVUs = Math.max(
    1,
    Math.ceil(pageviewsPerSecPeak * SESSION_DURATION_SEC),
  )
  const browseFlashVUs = Math.max(
    1,
    Math.ceil(pageviewsPerSecFlash * SESSION_DURATION_SEC),
  )

  const checkoutBaselineVUs = Math.max(
    1,
    Math.ceil(ordersPerSecAvg * CHECKOUT_DURATION_SEC),
  )
  const checkoutPeakVUs = Math.max(
    1,
    Math.ceil(ordersPerSecPeak * CHECKOUT_DURATION_SEC),
  )
  const checkoutFlashVUs = Math.max(
    1,
    Math.ceil(ordersPerSecFlash * CHECKOUT_DURATION_SEC),
  )

  return {
    name,
    label,
    ordersPerMonth,
    ordersPerSecAvg: round(ordersPerSecAvg),
    ordersPerSecPeak: round(ordersPerSecPeak),
    ordersPerSecFlash: round(ordersPerSecFlash),
    pageviewsPerMonth,
    pageviewsPerSecAvg: round(pageviewsPerSecAvg),
    pageviewsPerSecPeak: round(pageviewsPerSecPeak),
    pageviewsPerSecFlash: round(pageviewsPerSecFlash),
    vus: {
      smoke: { browse: 1, checkout: 1 },
      baseline: { browse: browseBaselineVUs, checkout: checkoutBaselineVUs },
      peak: { browse: browsePeakVUs, checkout: checkoutPeakVUs },
      flash: { browse: browseFlashVUs, checkout: checkoutFlashVUs },
      sustain: { browse: browseBaselineVUs, checkout: checkoutBaselineVUs },
    },
    bottlenecks,
    prerequisites,
  }
}

export const SCALING_TIERS: Record<ScalingTierName, ScalingTierMath> = {
  t100k: deriveTier(
    't100k',
    '100K orders/month',
    100_000,
    [
      'single Postgres primary (no replica needed)',
      'BullMQ in-process workers — sufficient at ~1.6 jobs/s peak',
      'single Redis instance — ~2 ops/s average',
    ],
    [
      'Phase 3A tiered cache',
      'Phase 3B cache-aside storefront',
      'Phase 3C order fan-out queue',
      'Phase 3D edge cache headers',
    ],
  ),
  t1m: deriveTier(
    't1m',
    '1M orders/month',
    1_000_000,
    [
      'pg_advisory_xact_lock serialisation on hot SKUs during flash sales',
      'single Redis instance nearing 20k ops/s — still fits but no headroom',
      'in-process BullMQ workers at ~16 jobs/s peak — OK but fragile on restart',
      'tiered cache local tier diverges without cross-worker invalidation',
    ],
    [
      'Phase 3G Redis stock reservation (replaces advisory locks in hot path)',
      'Phase 3H cross-worker cache invalidation (Redis pub/sub)',
      'Phase 3I read-replica wrapper for the Kysely query builder',
      '2× API servers behind a load balancer',
    ],
  ),
  t10m: deriveTier(
    't10m',
    '10M orders/month',
    10_000_000,
    [
      'single Postgres write path saturates — orders table needs partitioning',
      'Redis single-instance at 200k ops/s — must shard or use Redis Cluster',
      'BullMQ in-process workers at ~160 jobs/s peak — must move to dedicated worker process',
      'single k6 runner CANNOT generate the 150,000 browse-VU flash peak',
      'webhook fan-out queue competes with order fan-out queue on the same workers',
    ],
    [
      'Phase 3J standalone worker process cluster',
      'orders table time-range partitioning + pruning job',
      'Postgres read-replica pool (≥ 2 replicas)',
      'Redis Cluster or Sentinel with sharded keyspace',
      'distributed k6 runner (k6 Operator on Kubernetes or self-hosted cluster)',
      'per-tenant rate limiting to prevent noisy neighbours',
    ],
  ),
}

/**
 * Lookup helper with a loud error on typos — every caller in the
 * harness goes through this so a misspelled `TIER=1m` fails the run
 * instead of silently falling back to the smoke tier.
 */
export function getTier(name: string): ScalingTierMath {
  const lower = name.trim().toLowerCase()
  // Accept short aliases — users type `1m` not `t1m`.
  const alias: Record<string, ScalingTierName> = {
    t100k: 't100k',
    '100k': 't100k',
    t1m: 't1m',
    '1m': 't1m',
    t10m: 't10m',
    '10m': 't10m',
  }
  const key = alias[lower]
  if (!key) {
    const valid = Object.keys(SCALING_TIERS).join(', ')
    throw new Error(`Unknown scaling tier "${name}". Valid tiers: ${valid}`)
  }
  return SCALING_TIERS[key]
}

/**
 * Constants a harness or runbook can reference directly.
 */
export const SCALING_ASSUMPTIONS = {
  conversionRate: CONVERSION_RATE,
  peakMultiplier: PEAK_MULTIPLIER,
  flashMultiplier: FLASH_MULTIPLIER,
  sessionDurationSec: SESSION_DURATION_SEC,
  checkoutDurationSec: CHECKOUT_DURATION_SEC,
  secondsPerMonth: SECONDS_PER_MONTH,
} as const
