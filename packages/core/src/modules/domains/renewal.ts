/**
 * Gbox Platform — Certificate Renewal Loop
 * (Landing Page System Phase 1D)
 *
 * Daily batch that finds every `shop_domains` row whose Let's Encrypt
 * certificate is about to expire and asks lego to renew it. Mirrors
 * Shopify's own 30-days-before-expiry renewal policy.
 *
 * Why a separate module (not the orchestrator)?
 *
 *   - Provisioning (orchestrator) runs every ~30s with a small batch.
 *     Renewal runs once a day with a potentially large batch. Different
 *     cadences, different error handling, different alerts.
 *   - Renewal can degrade gracefully: if one cert fails, the existing
 *     cert keeps working until its real expiry. Provisioning has no
 *     "existing cert" fallback — failure means the merchant's shop is
 *     HTTP-only until we fix it.
 *
 * Alerting:
 *
 *   - First failure       → log warn, bump `renewal_failures`.
 *   - 3 consecutive fails → log error. The CLI wrapper's logger is
 *                           wired into PagerDuty/Slack in production.
 *   - Cert < 7 days left  → log error immediately regardless of
 *                           failure count — this is the "someone
 *                           needs to look at this NOW" threshold.
 */

import type { Kysely, RawBuilder } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { renewCertificate, type AcmeClientConfig } from './acme-client.js'
import {
  writeDomainServerBlock,
  type NginxWriterConfig,
} from './nginx-writer.js'
import { reloadNginx, type NginxReloaderConfig } from './nginx-reloader.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenewalConfig {
  acme: AcmeClientConfig
  nginxWriter: NginxWriterConfig
  nginxReloader?: NginxReloaderConfig
  /**
   * Days before expiry at which a cert becomes eligible for renewal.
   * Default 30 (Shopify-style). Lower this in tests to simulate.
   */
  renewalWindowDays?: number
  /**
   * Days left at which we fire the hard alert even if the renewal
   * succeeded on the previous pass. Default 7.
   */
  hardAlertDays?: number
  /** Injectable clock for tests. */
  nowImpl?: () => Date
  /** Reload nginx at most once at the end of the batch. Default true. */
  reloadOnce?: boolean
}

export interface RenewalLogger {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

const NOOP_LOGGER: RenewalLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface RenewalBatchSummary {
  candidates: number
  renewed: number
  alreadyFresh: number
  failed: number
  hardAlerts: number
  nginxReloaded: boolean
}

// ---------------------------------------------------------------------------
// Candidate query
// ---------------------------------------------------------------------------

interface RenewalCandidateRow {
  id: string
  shop_id: string
  domain: string
  ssl_expires_at: Date | string | null
  cert_path: string | null
  cert_key_path: string | null
  cert_chain_path: string | null
  is_primary: boolean | null
  renewal_failures: number | null
}

/**
 * Find every row whose expiry is within `windowDays` of `now`. The
 * query is driven by the partial index on `ssl_expires_at` added in
 * migration 014 so it stays O(log N) regardless of how many inactive
 * domains exist.
 */
export async function listRenewalCandidates(
  db: Kysely<Database>,
  nowDate: Date,
  windowDays: number,
): Promise<RenewalCandidateRow[]> {
  const cutoff = new Date(nowDate.getTime() + windowDays * 24 * 60 * 60 * 1000)
  const rows = (await db
    .selectFrom('shop_domains')
    .select([
      'id',
      'shop_id',
      'domain',
      'ssl_expires_at',
      'cert_path' as any,
      'cert_key_path' as any,
      'cert_chain_path' as any,
      'is_primary',
      'renewal_failures' as any,
    ])
    .where('ssl_expires_at', 'is not', null)
    .where('ssl_expires_at', '<=', cutoff as any)
    .where('cert_path' as any, 'is not', null)
    .orderBy('ssl_expires_at', 'asc')
    .execute()) as unknown as RenewalCandidateRow[]
  return rows
}

// ---------------------------------------------------------------------------
// runRenewalBatch
// ---------------------------------------------------------------------------

/**
 * One pass of the renewal cron. Safe to call repeatedly — lego
 * no-ops when a cert still has more than `--days` remaining, so
 * calling this every few hours is fine if the systemd timer is
 * offline.
 *
 * Returns a summary. Does not throw on per-row failures; each row
 * either succeeds, gets counted as failed (with the reason written
 * to `ssl_last_error`), or fires a hard alert via the logger.
 */
export async function runRenewalBatch(
  db: Kysely<Database>,
  config: RenewalConfig,
  logger: RenewalLogger = NOOP_LOGGER,
): Promise<RenewalBatchSummary> {
  const windowDays = config.renewalWindowDays ?? 30
  const hardAlertDays = config.hardAlertDays ?? 7
  const nowDate = (config.nowImpl ?? (() => new Date()))()
  const reloadOnce = config.reloadOnce !== false

  const candidates = await listRenewalCandidates(db, nowDate, windowDays)

  const summary: RenewalBatchSummary = {
    candidates: candidates.length,
    renewed: 0,
    alreadyFresh: 0,
    failed: 0,
    hardAlerts: 0,
    nginxReloaded: false,
  }

  if (candidates.length === 0) {
    logger.info('renewal.tick.empty')
    return summary
  }

  logger.info('renewal.tick.start', {
    candidates: candidates.length,
    windowDays,
    hardAlertDays,
  })

  let anyNewCert = false

  for (const row of candidates) {
    const expiresAt = row.ssl_expires_at ? new Date(row.ssl_expires_at as string) : null
    const daysLeft = expiresAt
      ? Math.floor((expiresAt.getTime() - nowDate.getTime()) / (24 * 60 * 60 * 1000))
      : Number.NaN

    // Hard alert threshold — log even if we're about to attempt renewal.
    // Helps surface "renewal has been silently failing for a week" to
    // operators who only skim for errors.
    if (!Number.isNaN(daysLeft) && daysLeft <= hardAlertDays) {
      summary.hardAlerts++
      logger.error('renewal.hard_alert', {
        domain: row.domain,
        daysLeft,
        failures: row.renewal_failures ?? 0,
      })
    }

    // Build SAN list matching the original issue: www.<domain> for
    // bare second-level domains.
    const sans: string[] = []
    const labels = row.domain.split('.')
    if (labels.length === 2 && !row.domain.startsWith('www.')) {
      sans.push(`www.${row.domain}`)
    }

    const result = await renewCertificate(config.acme, {
      domain: row.domain,
      sans,
      challenge: 'http01',
      renewalDays: windowDays,
    })

    if (!result.ok) {
      summary.failed++
      const failures = (row.renewal_failures ?? 0) + 1
      await db
        .updateTable('shop_domains')
        .set({
          renewal_failures: failures,
          ssl_last_error: `Renewal failed (${result.kind}): ${result.message}`.slice(0, 500),
          ssl_last_attempt_at: nowDate,
        } as any)
        .where('id', '=', row.id)
        .execute()
      const level = failures >= 3 ? 'error' : 'warn'
      logger[level]('renewal.failed', {
        domain: row.domain,
        kind: result.kind,
        failures,
        daysLeft,
      })
      continue
    }

    // Check whether lego actually issued a fresh cert or whether it
    // was a no-op (cert still has > windowDays left). The metadata's
    // issuedAt should advance on a real renewal.
    const newIssued = result.value.issuedAt
    const fresh =
      !expiresAt ||
      result.value.expiresAt.getTime() > expiresAt.getTime() + 60_000

    if (!fresh) {
      summary.alreadyFresh++
      logger.info('renewal.noop', { domain: row.domain, daysLeft })
      continue
    }

    // Rewrite the nginx server block with the refreshed cert paths
    // (they usually don't change but we re-emit for safety — lego
    // can change the layout between versions).
    try {
      await writeDomainServerBlock(config.nginxWriter, {
        domain: row.domain,
        aliases: sans,
        certPath: result.value.certPath,
        certKeyPath: result.value.keyPath,
        chainPath: result.value.chainPath,
        shopId: row.shop_id,
        canonicalRedirect: row.is_primary === true,
        canonicalHost: row.is_primary === true ? row.domain : undefined,
      })
    } catch (err) {
      summary.failed++
      const msg = err instanceof Error ? err.message : String(err)
      await db
        .updateTable('shop_domains')
        .set({
          ssl_last_error: `Renewal wrote cert but nginx-writer failed: ${msg}`.slice(0, 500),
          ssl_last_attempt_at: nowDate,
        } as any)
        .where('id', '=', row.id)
        .execute()
      logger.error('renewal.nginx_writer_failed', { domain: row.domain, error: msg })
      continue
    }

    anyNewCert = true
    summary.renewed++

    await db
      .updateTable('shop_domains')
      .set({
        ssl_issued_at: newIssued,
        ssl_expires_at: result.value.expiresAt,
        ssl_status: 'active',
        ssl_last_error: null,
        ssl_last_attempt_at: nowDate,
        renewal_failures: 0,
        cert_path: result.value.certPath,
        cert_key_path: result.value.keyPath,
        cert_chain_path: result.value.chainPath,
      } as any)
      .where('id', '=', row.id)
      .execute()

    logger.info('renewal.ok', {
      domain: row.domain,
      newExpiresAt: result.value.expiresAt.toISOString(),
      daysLeftBefore: daysLeft,
    })
  }

  // Single reload at the end, only if at least one cert actually
  // changed. Avoids pointless nginx reloads during quiet days.
  if (reloadOnce && anyNewCert) {
    const reloadResult = await reloadNginx(config.nginxReloader ?? {})
    summary.nginxReloaded = reloadResult.ok
    if (!reloadResult.ok) {
      logger.error('renewal.nginx_reload_failed', {
        kind: reloadResult.kind,
        message: reloadResult.message,
      })
    }
  }

  logger.info('renewal.tick.done', summary as unknown as Record<string, unknown>)
  return summary
}

// Exported for downstream smoke tests — building a raw count query
// via Kysely makes the test's assertion explicit.
export function renewalCandidatesCountQuery(
  nowDate: Date,
  windowDays: number,
): RawBuilder<unknown> {
  const cutoff = new Date(nowDate.getTime() + windowDays * 24 * 60 * 60 * 1000)
  return sql`
    SELECT COUNT(*)::int AS count
    FROM shop_domains
    WHERE ssl_expires_at IS NOT NULL
      AND ssl_expires_at <= ${cutoff.toISOString()}
      AND cert_path IS NOT NULL
  `
}
