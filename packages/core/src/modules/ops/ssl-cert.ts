/**
 * Gbox Platform — SSL/ACME State Machine (Phase 6.4)
 *
 * Pure-function planner that decides what `scripts/ops/renew-ssl-certs.sh`
 * should do with each `shop_domains` row. The script reads verified
 * domains from Postgres, asks `planCertAction` per row, then shells
 * out to certbot for any row tagged 'issue' or 'renew'.
 *
 * Why a separate state machine instead of just `if expires_soon then
 * renew`? Three reasons:
 *
 *   1. The god-admin "SSL fleet status" card needs the same logic to
 *      colour each row (healthy / expiring / expired / missing /
 *      unverified). Sharing the function guarantees the cron and the
 *      UI never disagree.
 *   2. Verification state matters as much as expiry. If a merchant
 *      added a domain but hasn't pointed DNS yet, the cron must skip
 *      it instead of pestering Let's Encrypt with rate-limited
 *      failures.
 *   3. Pure functions are trivial to unit-test. The actual ACME call
 *      lives in bash where it belongs (close to the certbot binary).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Subset of `shop_domains` columns the planner cares about. The cron
 * loads this shape from Postgres; the god-admin UI builds the same
 * shape from its API response.
 */
export interface ShopDomainCertState {
  domain: string
  /** True once DNS TXT verification has succeeded at least once. */
  verified: boolean
  /** Last successful issuance, or null if no cert has ever been issued. */
  sslIssuedAt: Date | null
  /** Cert notAfter, or null if no cert exists. */
  sslExpiresAt: Date | null
  /** Last error message from a failed renewal, or null. */
  sslLastError: string | null
}

export type CertActionKind =
  | 'wait_verification' // domain not verified yet → do nothing
  | 'issue' // verified + no cert → first issuance
  | 'renew' // cert in renewal window or already expired
  | 'skip' // cert is fresh, no work needed

export interface CertAction {
  action: CertActionKind
  /**
   * Days until the current cert expires. Negative if already expired,
   * null if no cert exists yet (for `issue` and `wait_verification`).
   */
  daysUntilExpiry: number | null
}

export interface PlanCertOptions {
  /** Defaults to `new Date()` so the cron doesn't have to inject. */
  now?: Date
  /**
   * Renew when the cert has fewer than this many days left. Defaults
   * to 30 — gives a 30-day buffer that comfortably absorbs a
   * weekend's worth of renewal failures before anything goes red.
   */
  renewBeforeDays?: number
}

export interface SslFleetSummary {
  total: number
  /** verified + cert > renewBeforeDays out */
  healthy: number
  /** verified + cert in renewal window but not yet expired */
  expiringSoon: number
  /** verified + cert past notAfter */
  expired: number
  /** verified + no cert at all yet */
  missing: number
  /** !verified — still waiting on the merchant's DNS */
  unverified: number
}

export interface SummariseFleetOptions {
  now?: Date
  renewBeforeDays?: number
}

// ---------------------------------------------------------------------------
// planCertAction
// ---------------------------------------------------------------------------

const DEFAULT_RENEW_BEFORE_DAYS = 30
const MS_PER_DAY = 86_400_000

export function planCertAction(
  state: ShopDomainCertState,
  opts: PlanCertOptions = {},
): CertAction {
  const now = opts.now ?? new Date()
  const renewBeforeDays = opts.renewBeforeDays ?? DEFAULT_RENEW_BEFORE_DAYS

  if (!state.verified) {
    return { action: 'wait_verification', daysUntilExpiry: null }
  }

  if (!state.sslExpiresAt) {
    return { action: 'issue', daysUntilExpiry: null }
  }

  // Round toward zero so a cert that expires "tomorrow" reads as
  // 1 day, not 0.999. This matches what humans would say.
  const days = Math.floor(
    (state.sslExpiresAt.getTime() - now.getTime()) / MS_PER_DAY,
  )

  if (days <= renewBeforeDays) {
    return { action: 'renew', daysUntilExpiry: days }
  }

  return { action: 'skip', daysUntilExpiry: days }
}

// ---------------------------------------------------------------------------
// summariseSslFleet
// ---------------------------------------------------------------------------

export function summariseSslFleet(
  fleet: ShopDomainCertState[],
  opts: SummariseFleetOptions = {},
): SslFleetSummary {
  const now = opts.now ?? new Date()
  const renewBeforeDays = opts.renewBeforeDays ?? DEFAULT_RENEW_BEFORE_DAYS

  const summary: SslFleetSummary = {
    total: fleet.length,
    healthy: 0,
    expiringSoon: 0,
    expired: 0,
    missing: 0,
    unverified: 0,
  }

  for (const row of fleet) {
    // Unverified domains are bucketed by status, not by cert state —
    // even if a stale cert exists, the domain isn't trusted right now
    // and shouldn't show up as "healthy".
    if (!row.verified) {
      summary.unverified++
      continue
    }

    if (!row.sslExpiresAt) {
      summary.missing++
      continue
    }

    const days = Math.floor(
      (row.sslExpiresAt.getTime() - now.getTime()) / MS_PER_DAY,
    )

    if (days < 0) {
      summary.expired++
    } else if (days <= renewBeforeDays) {
      summary.expiringSoon++
    } else {
      summary.healthy++
    }
  }

  return summary
}
