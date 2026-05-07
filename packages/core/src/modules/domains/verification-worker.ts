/**
 * Gbox Platform — Domain Verification Worker
 * (Landing Page System Phase 1A/1D)
 *
 * Background drainer for pending domain verifications. The long-lived
 * process (or cron, depending on deployment) calls `runVerificationBatch`
 * on a timer. This function fetches every unverified domain, runs both
 * checks the Shopify-style edge flow requires:
 *
 *   1. DNS TXT ownership check  — the merchant published our random
 *      token under `_gbox-verify.<domain>`. Proves they control DNS.
 *
 *   2. DNS A record check       — the merchant's apex (and `www.`)
 *      A record actually resolves to one of our active edge public
 *      IPs. Proves HTTP-01 challenge will succeed later.
 *
 * Both MUST pass before we flip `verified=true`. Skipping the A-record
 * check would mean the orchestrator fires a Let's Encrypt order that
 * immediately fails "unauthorized" at the HTTP-01 step — wasting rate
 * limit budget and confusing the merchant.
 *
 * The worker is split into a pure function + a CLI wrapper so we can
 * unit-test the batch logic without booting a process. The CLI wrapper
 * lives in `scripts/ops/domains-worker-loop.ts` and only provides the
 * timer + logger + signal handling.
 *
 * Design:
 *
 *   - Both resolvers are injected so tests don't hit DNS and the CLI
 *     wrapper can swap between `node:dns` and a DoH client at runtime.
 *   - The edge IPs set is passed in by the caller (loaded once per
 *     batch from `loadActiveEdgeIpv4Set`) — no DB reads per row.
 *   - The service layer already knows how to persist success
 *     (`verifyPendingDomain`), so the TXT step just calls through;
 *     the A-record step's failure path writes `ssl_last_error`
 *     directly.
 *   - Sequential drain, not parallel: keeps DNS query volume low and
 *     makes the per-tick timing predictable for logging.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { listPendingVerification, verifyPendingDomain } from './service.js'
import type { DnsTxtResolver } from '../ops/domain-verification.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Resolves `domain` to its IPv4 A record set. Same shape as
 * `dns.promises.resolve4()`. Returning `[]` or throwing `ENOTFOUND`
 * is treated as "not yet propagated".
 */
export type DnsARecordResolver = (host: string) => Promise<string[]>

export interface VerificationBatchOptions {
  txtResolver: DnsTxtResolver
  aResolver: DnsARecordResolver
  /**
   * Active edge public IPv4 set. Loaded once per batch by the CLI
   * wrapper via `loadActiveEdgeIpv4Set()` and reused for every row.
   * Anything in here counts as "points at us".
   */
  edgeIpv4: Set<string>
  /** Maximum rows to drain in one tick. Defaults to 50. */
  batchSize?: number
  /** Injected clock for deterministic tests. */
  now?: Date
  logger?: VerificationLogger
}

export interface VerificationLogger {
  info: (event: string, fields?: Record<string, unknown>) => void
  warn: (event: string, fields?: Record<string, unknown>) => void
  error: (event: string, fields?: Record<string, unknown>) => void
}

export interface VerificationBatchSummary {
  total: number
  verified: number
  stillPending: number
  failed: number
  notFound: number
  aRecordMissing: number
  errors: number
}

const NOOP_LOGGER: VerificationLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

// ---------------------------------------------------------------------------
// A-record check
// ---------------------------------------------------------------------------

export type ARecordCheckResult =
  | { ok: true; matchedIp: string }
  | { ok: false; reason: 'not_found'; observed: string[] }
  | { ok: false; reason: 'mismatch'; observed: string[] }
  | { ok: false; reason: 'lookup_error'; error: string }

/**
 * Look up `domain`'s A records and compare them against the set of
 * active edge IPs. Any intersection counts as a match — a domain
 * with multiple A records (round-robin) passes as soon as one of
 * them is ours.
 *
 * Pure function (resolver + IP set are injected) so the batch loop
 * is unit-testable without touching DNS.
 */
export async function checkARecord(
  domain: string,
  resolver: DnsARecordResolver,
  edgeIpv4: Set<string>,
): Promise<ARecordCheckResult> {
  let records: string[]
  try {
    records = await resolver(domain)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { ok: false, reason: 'not_found', observed: [] }
    }
    return {
      ok: false,
      reason: 'lookup_error',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (!records || records.length === 0) {
    return { ok: false, reason: 'not_found', observed: [] }
  }

  for (const ip of records) {
    if (edgeIpv4.has(ip)) {
      return { ok: true, matchedIp: ip }
    }
  }

  return { ok: false, reason: 'mismatch', observed: records }
}

// ---------------------------------------------------------------------------
// runVerificationBatch
// ---------------------------------------------------------------------------

/**
 * Drain one batch of pending domain verifications. Returns a summary
 * the caller can log / alert on. Never throws — unexpected errors
 * from individual rows are caught, logged as `error`, and counted in
 * the `errors` field so one bad row doesn't kill the tick.
 *
 * Per-row flow:
 *
 *   1. Run the TXT ownership check via `verifyPendingDomain()`.
 *      → On failure, persist the reason (service layer handles it)
 *        and move on. A-record check is skipped.
 *
 *   2. If TXT passed, run the A-record check. If it fails, we
 *      immediately re-flip the row back to unverified and stash the
 *      reason in `ssl_last_error` so the merchant sees "points at
 *      the wrong IP" instead of a confused "verified but SSL won't
 *      issue".
 *
 *   3. Only rows where BOTH checks pass stay verified and become
 *      candidates for the SSL orchestrator on the next tick.
 */
export async function runVerificationBatch(
  db: Kysely<Database>,
  opts: VerificationBatchOptions,
): Promise<VerificationBatchSummary> {
  const logger = opts.logger ?? NOOP_LOGGER
  const batchSize = opts.batchSize ?? 50

  const rows = await listPendingVerification(db, batchSize)

  const summary: VerificationBatchSummary = {
    total: rows.length,
    verified: 0,
    stillPending: 0,
    failed: 0,
    notFound: 0,
    aRecordMissing: 0,
    errors: 0,
  }

  if (rows.length === 0) {
    logger.info('domain_verifier.tick.empty')
    return summary
  }

  if (opts.edgeIpv4.size === 0) {
    logger.warn('domain_verifier.no_edge_ips', {
      note: 'edge_nodes table has no active rows — A-record check will reject every domain. Populate edge_nodes before running.',
    })
  }

  logger.info('domain_verifier.tick.start', {
    batchSize: rows.length,
    edgeIpCount: opts.edgeIpv4.size,
  })

  for (const row of rows) {
    try {
      const result = await verifyPendingDomain(db, row.shopId, row.id, {
        resolver: opts.txtResolver,
        now: opts.now,
      })

      if (!result.ok) {
        switch (result.code) {
          case 'dns_not_found':
            summary.notFound++
            logger.info('domain_verifier.txt_not_found', { domain: row.domain })
            break
          case 'dns_mismatch':
            summary.failed++
            logger.warn('domain_verifier.txt_mismatch', {
              domain: row.domain,
              observed: result.observed,
            })
            break
          case 'dns_lookup_error':
            summary.failed++
            logger.warn('domain_verifier.txt_lookup_error', {
              domain: row.domain,
              message: result.message,
            })
            break
          case 'no_token':
            summary.failed++
            logger.warn('domain_verifier.no_token', { domain: row.domain })
            break
          case 'not_found':
            summary.stillPending++
            break
        }
        continue
      }

      // TXT passed — now the A-record check. Failure here rolls the
      // row back to unverified so the orchestrator doesn't waste a
      // Let's Encrypt order on a domain that can't complete HTTP-01.
      const aCheck = await checkARecord(row.domain, opts.aResolver, opts.edgeIpv4)
      if (!aCheck.ok) {
        summary.aRecordMissing++
        const message = formatARecordError(row.domain, aCheck, opts.edgeIpv4)
        logger.warn('domain_verifier.a_record_failed', {
          domain: row.domain,
          reason: aCheck.reason,
          observed: 'observed' in aCheck ? aCheck.observed : [],
        })
        await db
          .updateTable('shop_domains')
          .set({
            verified: false,
            verified_at: null,
            ssl_last_error: message,
          } as any)
          .where('id', '=', row.id)
          .execute()
        continue
      }

      summary.verified++
      logger.info('domain_verifier.verified', {
        domain: row.domain,
        shopId: row.shopId,
        matchedIp: aCheck.matchedIp,
      })
    } catch (err) {
      summary.errors++
      logger.error('domain_verifier.row_error', {
        domain: row.domain,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('domain_verifier.tick.done', summary as unknown as Record<string, unknown>)
  return summary
}

// ---------------------------------------------------------------------------
// Error message formatter
// ---------------------------------------------------------------------------

/**
 * Render a merchant-facing error string for an A-record failure.
 * Shown in the store-admin wizard as `ssl_last_error` so the
 * merchant sees *exactly* what record they need to fix.
 *
 * Kept separate so the language can evolve without the core
 * batch-loop logic shifting.
 */
export function formatARecordError(
  domain: string,
  result: ARecordCheckResult & { ok: false },
  edgeIpv4: Set<string>,
): string {
  const edgeList = [...edgeIpv4].sort().join(', ') || '(no active edge IPs)'
  switch (result.reason) {
    case 'not_found':
      return `No A record found for ${domain}. Create an A record pointing to ${edgeList} and wait for DNS to propagate.`
    case 'mismatch':
      return `A record for ${domain} resolves to ${result.observed.join(', ')}, which is not a Gbox edge IP. Update the record to point to ${edgeList}.`
    case 'lookup_error':
      return `DNS lookup for ${domain} failed (${result.error}). Will retry automatically.`
  }
}
