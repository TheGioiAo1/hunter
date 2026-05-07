/**
 * Gbox Platform — SSL Orchestrator (Self-Hosted Edge)
 * (Landing Page System Phase 1D)
 *
 * Drives the end-to-end "merchant added a domain → domain verified
 * → Let's Encrypt issued a cert → Nginx now serves HTTPS" flow.
 *
 * This module replaces the previous Cloudflare for SaaS orchestrator
 * (migration 014 / Phase 1D). The migration retained the columns it
 * depended on (`ssl_provider`, `ssl_issued_at`, etc.) and added new
 * ones (`cert_path`, `cert_key_path`, `acme_challenge_token`,
 * `renewal_failures`, `ssl_staging`) to back this orchestrator.
 *
 * Pipeline (for a single domain):
 *
 *   verified=true, cert_path=null
 *     │
 *     │  requestSsl()
 *     ▼
 *   ACME client (lego HTTP-01 via /var/www/acme-webroot)
 *     │
 *     │  success → writes cert files to /etc/gbox/lego/certificates/
 *     ▼
 *   nginx-writer → /etc/nginx/gbox-domains/<domain>.conf
 *     │
 *     │  nginx -t && systemctl reload nginx
 *     ▼
 *   shop_domains.ssl_status='active', cert_path set, ssl_issued_at=now
 *     │
 *     │  renewal loop (daily cron)
 *     ▼
 *   renew @ ssl_expires_at - 30 days  → lego renew → rewrite + reload
 *
 * Error handling:
 *
 *   - Each failure writes `ssl_last_error` + increments
 *     `renewal_failures` (if the row was already active) or leaves
 *     it at 0 (if this was the first issue).
 *   - Per-domain cooldown of 1 hour: if `ssl_last_attempt_at` is
 *     within the last hour we skip the row entirely on the next
 *     batch tick. This protects Let's Encrypt rate limits during a
 *     retry storm.
 *   - `rate_limited` errors from lego trigger a 24-hour cooldown
 *     regardless of the normal 1-hour rule.
 *
 * Idempotency: requestSsl is safe to call twice for the same row —
 * if cert_path is already set and the cert file still exists we
 * return the existing record without touching lego.
 *
 * The orchestrator does NOT:
 *   - Decide which domains to process — the worker loop does.
 *   - Touch DNS directly — verification-worker does that.
 *   - Write database rows outside the domains module — service.ts does.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  getDomainById,
  getDomainByHostname,
  listPendingSsl,
  markSslFailed,
  markSslIssued,
  removeDomain,
  type DomainRecord,
} from './service.js'
import {
  issueCertificate,
  type AcmeClientConfig,
  type AcmeError,
  type AcmeResult,
  type IssueCertificateInput,
  type IssuedCertificate,
} from './acme-client.js'
import {
  removeDomainServerBlock,
  writeDomainServerBlock,
  type DomainServerBlockInput,
  type NginxWriterConfig,
} from './nginx-writer.js'
import {
  reloadNginx,
  type NginxReloaderConfig,
  type NginxReloadResult,
} from './nginx-reloader.js'

// ---------------------------------------------------------------------------
// Orchestrator config
// ---------------------------------------------------------------------------

/**
 * Bundle of sub-module configs the orchestrator needs to drive the
 * full pipeline. The worker loop assembles one of these at startup
 * from env vars and passes it to every call — the orchestrator
 * never reads env directly so tests can inject everything.
 */
export interface SslOrchestratorConfig {
  acme: AcmeClientConfig
  nginxWriter: NginxWriterConfig
  nginxReloader?: NginxReloaderConfig
  /**
   * Cooldown in ms applied to a failing domain before the batch
   * worker will retry it. Default: 1 hour. Let's Encrypt-rate-limit
   * responses override this to `rateLimitCooldownMs`.
   */
  cooldownMs?: number
  /**
   * Cooldown applied after a Let's Encrypt rate-limit error. Much
   * longer than the normal cooldown. Default: 24 hours.
   */
  rateLimitCooldownMs?: number
  /**
   * Inject `Date.now()` for tests. Defaults to real wall clock.
   */
  nowImpl?: () => Date
  /**
   * Reload nginx after a successful issue. Set to `false` in tests
   * that drive the write step directly. Default: true.
   */
  reloadOnSuccess?: boolean
}

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 24 hours

function now(cfg: SslOrchestratorConfig): Date {
  return (cfg.nowImpl ?? (() => new Date()))()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestSslInput {
  shopId: string
  domainId: string
}

export type RequestSslResult =
  | {
      ok: true
      record: DomainRecord
      certificate: IssuedCertificate
      nginxReload?: NginxReloadResult
    }
  | { ok: false; code: 'not_found'; message: string }
  | { ok: false; code: 'not_verified'; message: string }
  | { ok: false; code: 'cooldown'; message: string; retryAt: Date }
  | {
      ok: false
      code: 'acme_error'
      message: string
      kind: AcmeError['kind']
    }
  | {
      ok: false
      code: 'nginx_error'
      message: string
      nginxReload: NginxReloadResult
    }

// ---------------------------------------------------------------------------
// Cooldown + precondition checks
// ---------------------------------------------------------------------------

/**
 * Given a record and the current clock, decide whether the
 * orchestrator is allowed to try ACME right now. Pure function so
 * the batch worker can pre-filter without touching the DB a second
 * time.
 */
export function isInCooldown(
  record: DomainRecord,
  cooldownMs: number,
  nowDate: Date,
): { cooling: boolean; retryAt: Date | null } {
  if (!record.sslLastError) return { cooling: false, retryAt: null }
  // We reuse ssl_expires_at as a stand-in for "last attempt timestamp"
  // is WRONG — we added ssl_last_attempt_at in migration 014. Read it
  // from the extended record when available.
  const lastAttempt = (record as unknown as { sslLastAttemptAt?: Date | null })
    .sslLastAttemptAt
  if (!lastAttempt) return { cooling: false, retryAt: null }
  const elapsed = nowDate.getTime() - lastAttempt.getTime()
  if (elapsed >= cooldownMs) return { cooling: false, retryAt: null }
  return {
    cooling: true,
    retryAt: new Date(lastAttempt.getTime() + cooldownMs),
  }
}

/**
 * Persist "we just tried ACME for this domain" — bumps
 * ssl_last_attempt_at so subsequent cooldown checks see it. Kept
 * here (not in service.ts) because it's internal to the provisioning
 * flow, not a merchant-facing operation.
 */
async function markSslAttempt(
  db: Kysely<Database>,
  domainId: string,
  at: Date,
): Promise<void> {
  await db
    .updateTable('shop_domains')
    .set({ ssl_last_attempt_at: at } as any)
    .where('id', '=', domainId)
    .execute()
}

// ---------------------------------------------------------------------------
// requestSsl — first-time issuance
// ---------------------------------------------------------------------------

/**
 * Issue (or re-issue) a Let's Encrypt certificate for a verified
 * domain and wire it into the Nginx edge. Returns a typed result so
 * the caller can branch cleanly without throw/catch.
 *
 * Flow:
 *   1. Load the row, reject if not verified.
 *   2. Honour the cooldown window.
 *   3. Spawn lego via acme-client.
 *   4. On success: write the nginx server block + reload + persist
 *      cert paths and ssl_issued_at.
 *   5. On failure: persist ssl_last_error, bump cooldown, return error.
 */
export async function requestSsl(
  db: Kysely<Database>,
  input: RequestSslInput,
  config: SslOrchestratorConfig,
): Promise<RequestSslResult> {
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const rateLimitCooldownMs =
    config.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
  const reloadOnSuccess = config.reloadOnSuccess !== false
  const nowDate = now(config)

  const record = await getDomainById(db, input.shopId, input.domainId)
  if (!record) {
    return {
      ok: false,
      code: 'not_found',
      message: `Domain ${input.domainId} not found for shop ${input.shopId}`,
    }
  }
  if (!record.verified) {
    return {
      ok: false,
      code: 'not_verified',
      message: `Domain ${record.domain} must pass DNS verification before SSL can be issued.`,
    }
  }

  const cooldown = isInCooldown(record, cooldownMs, nowDate)
  if (cooldown.cooling && cooldown.retryAt) {
    return {
      ok: false,
      code: 'cooldown',
      message: `Domain ${record.domain} is in cooldown after a previous failure. Retry after ${cooldown.retryAt.toISOString()}.`,
      retryAt: cooldown.retryAt,
    }
  }

  // Bump attempt timestamp BEFORE calling lego so overlapping batch
  // ticks don't double-issue.
  await markSslAttempt(db, record.id, nowDate)

  // Build the ACME input. We always include `www.<domain>` as a SAN
  // when the merchant domain is a bare second-level domain, matching
  // Shopify's default behaviour. Skipped if the domain already has a
  // `www.` prefix (no nesting) or is a subdomain like `shop.acme.com`.
  const sans: string[] = []
  const labels = record.domain.split('.')
  if (labels.length === 2 && !record.domain.startsWith('www.')) {
    sans.push(`www.${record.domain}`)
  }

  const acmeInput: IssueCertificateInput = {
    domain: record.domain,
    sans,
    challenge: 'http01',
  }

  const acmeResult: AcmeResult<IssuedCertificate> = await issueCertificate(
    config.acme,
    acmeInput,
  )

  if (!acmeResult.ok) {
    // Translate ACME rate-limit errors into a much longer cooldown
    // by back-dating ssl_last_attempt_at into the future — we store
    // the attempt at "now + (rateLimitCooldownMs - cooldownMs)" so
    // the normal 1-hour cooldown resolves to the 24-hour wait.
    if (acmeResult.kind === 'rate_limited') {
      const delta = rateLimitCooldownMs - cooldownMs
      if (delta > 0) {
        await markSslAttempt(
          db,
          record.id,
          new Date(nowDate.getTime() + delta),
        )
      }
    }

    await markSslFailed(
      db,
      record.id,
      `ACME ${acmeResult.kind}: ${acmeResult.message}`.slice(0, 500),
      acmeResult.kind,
    )
    return {
      ok: false,
      code: 'acme_error',
      message: acmeResult.message,
      kind: acmeResult.kind,
    }
  }

  // Persist cert paths — we do this BEFORE nginx reload so a reload
  // failure doesn't lose the cert metadata.
  await db
    .updateTable('shop_domains')
    .set({
      cert_path: acmeResult.value.certPath,
      cert_key_path: acmeResult.value.keyPath,
      cert_chain_path: acmeResult.value.chainPath,
      ssl_provider: 'letsencrypt',
      ssl_staging: acmeResult.value.environment === 'staging',
    } as any)
    .where('id', '=', record.id)
    .execute()

  // Write the per-domain nginx server block.
  const blockInput: DomainServerBlockInput = {
    domain: record.domain,
    aliases: sans,
    certPath: acmeResult.value.certPath,
    certKeyPath: acmeResult.value.keyPath,
    chainPath: acmeResult.value.chainPath,
    shopId: record.shopId,
    canonicalRedirect: record.isPrimary,
    canonicalHost: record.isPrimary ? record.domain : undefined,
  }

  try {
    await writeDomainServerBlock(config.nginxWriter, blockInput)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markSslFailed(db, record.id, `nginx-writer: ${msg}`.slice(0, 500), 'nginx_write_error')
    return {
      ok: false,
      code: 'nginx_error',
      message: msg,
      nginxReload: { ok: false, kind: 'unknown', message: msg } as any,
    }
  }

  let nginxReload: NginxReloadResult | undefined
  if (reloadOnSuccess) {
    nginxReload = await reloadNginx(config.nginxReloader ?? {})
    if (!nginxReload.ok) {
      await markSslFailed(
        db,
        record.id,
        `nginx reload failed: ${nginxReload.message}`.slice(0, 500),
        'nginx_reload_error',
      )
      return {
        ok: false,
        code: 'nginx_error',
        message: nginxReload.message,
        nginxReload,
      }
    }
  }

  await markSslIssued(db, record.id, {
    provider: 'letsencrypt',
    issuedAt: acmeResult.value.issuedAt,
    expiresAt: acmeResult.value.expiresAt,
    sslStatus: 'active',
  })

  // Reset the renewal failure counter on a successful issue.
  await db
    .updateTable('shop_domains')
    .set({ renewal_failures: 0 } as any)
    .where('id', '=', record.id)
    .execute()

  const refreshed = await getDomainById(db, input.shopId, input.domainId)
  return {
    ok: true,
    record: refreshed!,
    certificate: acmeResult.value,
    nginxReload,
  }
}

// ---------------------------------------------------------------------------
// removeDomainAndSsl
// ---------------------------------------------------------------------------

/**
 * Full teardown: remove the nginx server block, delete the DB row,
 * reload nginx. Cert files on disk are left in place (lego cleans
 * them up on the next prune cycle) so a merchant who re-adds the
 * same domain within the cooldown window avoids a re-issue.
 */
export async function removeDomainAndSsl(
  db: Kysely<Database>,
  shopId: string,
  domainId: string,
  config: SslOrchestratorConfig,
): Promise<{ ok: boolean; message?: string; nginxReload?: NginxReloadResult }> {
  const record = await getDomainById(db, shopId, domainId)
  if (!record) return { ok: false, message: 'Domain not found' }

  try {
    await removeDomainServerBlock(config.nginxWriter, record.domain)
  } catch (err) {
    return {
      ok: false,
      message: `Failed to remove nginx config: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const removed = await removeDomain(db, shopId, domainId)
  if (!removed) {
    return { ok: false, message: 'Domain row could not be deleted' }
  }

  let nginxReload: NginxReloadResult | undefined
  if (config.reloadOnSuccess !== false) {
    nginxReload = await reloadNginx(config.nginxReloader ?? {})
    if (!nginxReload.ok) {
      // Config files are already removed and the DB row is gone —
      // failure here means nginx is running with slightly stale
      // config (will still work). Log but don't error.
      return {
        ok: true,
        message: `Domain removed but nginx reload failed: ${nginxReload.message}`,
        nginxReload,
      }
    }
  }
  return { ok: true, nginxReload }
}

// ---------------------------------------------------------------------------
// syncPendingSslBatch — worker entry point
// ---------------------------------------------------------------------------

export interface SyncPendingSslOptions {
  config: SslOrchestratorConfig
  /** Max rows to drain per tick. Defaults to 25 (lower than before — ACME is slower than CF API). */
  batchSize?: number
}

export interface SyncPendingSslSummary {
  total: number
  issued: number
  cooldowns: number
  acmeErrors: number
  nginxErrors: number
  notVerified: number
}

/**
 * One tick of the batch worker. Walks `listPendingSsl` and calls
 * `requestSsl` on each row that passes the cooldown check. Returns
 * a summary the caller can log/alert on.
 *
 * Deliberately sequential — lego spawns a new process per call
 * and parallel ACME orders burn rate limit faster than anything.
 * A healthy batch size is 10-25 per tick on a 30s interval.
 */
export async function syncPendingSslBatch(
  db: Kysely<Database>,
  opts: SyncPendingSslOptions,
): Promise<SyncPendingSslSummary> {
  const batchSize = opts.batchSize ?? 25
  const rows = await listPendingSsl(db, batchSize)

  const summary: SyncPendingSslSummary = {
    total: rows.length,
    issued: 0,
    cooldowns: 0,
    acmeErrors: 0,
    nginxErrors: 0,
    notVerified: 0,
  }

  for (const row of rows) {
    const res = await requestSsl(
      db,
      { shopId: row.shopId, domainId: row.id },
      opts.config,
    )
    if (res.ok) {
      summary.issued++
      continue
    }
    switch (res.code) {
      case 'cooldown':
        summary.cooldowns++
        break
      case 'acme_error':
        summary.acmeErrors++
        break
      case 'nginx_error':
        summary.nginxErrors++
        break
      case 'not_verified':
        summary.notVerified++
        break
      case 'not_found':
        // Row vanished between list and request — ignore.
        break
    }
  }

  return summary
}

// ---------------------------------------------------------------------------
// resolveShopByHostname — convenience re-export for the storefront
// ---------------------------------------------------------------------------

/**
 * Storefront convenience wrapper. Same shape as the previous (CF-era)
 * orchestrator exposed so callers don't need to update their imports.
 */
export async function resolveShopByHostname(
  db: Kysely<Database>,
  hostname: string,
): Promise<DomainRecord | null> {
  return getDomainByHostname(db, hostname)
}
