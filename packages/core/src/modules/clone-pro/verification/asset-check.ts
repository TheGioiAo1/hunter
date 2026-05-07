/**
 * Clone Pro v4 — Asset Integrity Check (Phase 3.2)
 *
 * Phase 1 (asset scanner) says "these N assets exist on the source."
 * Phase 2 (asset downloader) says "I downloaded X, Y failed."
 * This check compares the two and flags the gap.
 *
 * Key principle: a 100% download rate is the target, but most real clones
 * hit 90–99% because of tracking pixels, signed URLs, and dead external
 * images. We weight by asset tier:
 *
 *   - Critical (CSS, fonts): 70% of the score
 *   - High (JS): 20% of the score
 *   - Media (images, video): 10% of the score
 *
 * Missing a single stylesheet tanks the score dramatically — that's the
 * right call: a site with missing CSS is visually broken, while a site
 * missing a few images is still recognisable.
 */

import type { AssetInventory } from '../discovery/asset-scanner.js'
import type { CheckResult, Finding } from './types.js'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface AssetCheckInput {
  /** Phase 1 asset scan — what we expected to download. */
  readonly inventory: AssetInventory
  /** Phase 2 execution tallies. */
  readonly stats: {
    readonly assetsDownloaded: number
    readonly assetsFailed: number
    readonly totalAssetBytes: number
  }
  /**
   * Optional: URLs that WERE downloaded, keyed by absolute URL. When
   * provided, we can compute per-tier coverage instead of just a total.
   * When absent, we fall back to a flat `downloaded / expected` ratio.
   */
  readonly downloadedUrls?: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

const TIER_WEIGHTS = {
  critical: 70,
  high: 20,
  media: 10,
} as const

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runAssetCheck(input: AssetCheckInput): CheckResult {
  const started = Date.now()
  const findings: Finding[] = []

  const expected = input.inventory.summary.totalAssets
  const downloaded = input.stats.assetsDownloaded
  const failed = input.stats.assetsFailed

  if (expected === 0) {
    return {
      category: 'asset',
      score: 100,
      passed: true,
      summary: 'No assets needed — nothing to verify.',
      findings: [{
        category: 'asset',
        severity: 'info',
        message: 'Discovery found 0 assets; asset integrity not applicable.',
      }],
      durationMs: Date.now() - started,
    }
  }

  // ── Tier-based scoring when we know which URLs landed ───────────────
  let score: number
  if (input.downloadedUrls) {
    const criticalCoverage = coverageOf(input.inventory.criticalAssets, input.downloadedUrls)
    const highCoverage = coverageOf(input.inventory.highPriorityAssets, input.downloadedUrls)
    const mediaCoverage = coverageOf(input.inventory.mediaAssets, input.downloadedUrls)

    score = Math.round(
      criticalCoverage.ratio * TIER_WEIGHTS.critical +
        highCoverage.ratio * TIER_WEIGHTS.high +
        mediaCoverage.ratio * TIER_WEIGHTS.media,
    )

    // Emit tier-specific findings.
    emitTierFinding(findings, 'critical', criticalCoverage)
    emitTierFinding(findings, 'high', highCoverage)
    emitTierFinding(findings, 'media', mediaCoverage)
  } else {
    // ── Fallback: simple ratio from stats ─────────────────────────────
    const totalAttempted = downloaded + failed
    const ratio = totalAttempted === 0 ? 0 : downloaded / totalAttempted
    score = Math.round(ratio * 100)
    if (failed > 0) {
      findings.push({
        category: 'asset',
        severity: failed / Math.max(1, totalAttempted) > 0.2 ? 'error' : 'warning',
        message: `${failed} of ${totalAttempted} asset downloads failed (${Math.round((1 - ratio) * 100)}%).`,
        context: { failed, total: totalAttempted },
      })
    }
  }

  // ── Critical-miss callouts regardless of tier data ──────────────────
  if (expected > downloaded + failed) {
    findings.push({
      category: 'asset',
      severity: 'warning',
      message: `Discovery found ${expected} assets but execution only attempted ${downloaded + failed}.`,
      context: { expected, attempted: downloaded + failed },
    })
  }

  // Pass gate: no critical-tier failure and overall score ≥ 80.
  const hasCriticalFailure = findings.some(
    (f) => f.severity === 'critical' || f.severity === 'error',
  )
  const passed = !hasCriticalFailure && score >= 80

  const summary = `${downloaded}/${expected} assets downloaded (${score}% fidelity, ${Math.round(input.stats.totalAssetBytes / 1024)} KB).`

  return {
    category: 'asset',
    score,
    passed,
    summary,
    findings,
    durationMs: Date.now() - started,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TierCoverage {
  readonly total: number
  readonly hit: number
  readonly missed: number
  readonly ratio: number // 0..1
  readonly missingUrls: readonly string[]
}

function coverageOf(
  assets: ReadonlyArray<{ absoluteUrl: string }>,
  downloaded: ReadonlySet<string>,
): TierCoverage {
  if (assets.length === 0) {
    return { total: 0, hit: 0, missed: 0, ratio: 1, missingUrls: [] }
  }
  const missing: string[] = []
  let hit = 0
  for (const a of assets) {
    if (downloaded.has(a.absoluteUrl)) {
      hit++
    } else {
      missing.push(a.absoluteUrl)
    }
  }
  return {
    total: assets.length,
    hit,
    missed: missing.length,
    ratio: hit / assets.length,
    missingUrls: missing,
  }
}

function emitTierFinding(findings: Finding[], tier: 'critical' | 'high' | 'media', cov: TierCoverage): void {
  if (cov.total === 0) return
  if (cov.ratio === 1) {
    findings.push({
      category: 'asset',
      severity: 'info',
      message: `${tierLabel(tier)} assets: ${cov.hit}/${cov.total} — all present.`,
      context: { tier, total: cov.total },
    })
    return
  }
  const severity = tier === 'critical' ? 'critical' : tier === 'high' ? 'error' : 'warning'
  findings.push({
    category: 'asset',
    severity,
    message: `${tierLabel(tier)} assets: ${cov.hit}/${cov.total} downloaded (${cov.missed} missing).`,
    context: {
      tier,
      missed: cov.missed,
      // Truncate the missing list so the UI doesn't drown in URLs when a
      // CDN is wholly unreachable.
      sampleMissing: cov.missingUrls.slice(0, 5),
    },
  })
}

function tierLabel(tier: 'critical' | 'high' | 'media'): string {
  switch (tier) {
    case 'critical':
      return 'Critical (CSS/fonts)'
    case 'high':
      return 'High-priority (JS)'
    case 'media':
      return 'Media (images/video)'
  }
}
