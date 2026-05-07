/**
 * Gbox Platform — Domain Verification + SSL Provisioning Worker
 * (Landing Page System Phase 1D — self-hosted edge)
 *
 * Long-lived Node process that drains pending domain verifications
 * and drives Let's Encrypt provisioning on a timer. The CLI wrapper
 * for the pure worker modules in `packages/core/src/modules/domains/`.
 *
 * Two independent ticks:
 *
 *   - Verification tick every `VERIFY_INTERVAL_MS` (default 60s):
 *     walks `listPendingVerification` and runs BOTH the TXT
 *     ownership check AND the A-record-to-edge-IP check.
 *
 *   - SSL tick every `SSL_INTERVAL_MS` (default 30s):
 *     walks `listPendingSsl` and asks the self-hosted ACME
 *     orchestrator to issue certs via lego + write nginx configs
 *     + reload nginx.
 *
 * Deployment:
 *
 *   pm2 start scripts/ops/domains-worker-loop.ts \
 *     --name gbox-domains-worker \
 *     --interpreter tsx
 *
 * Environment variables (read once at startup):
 *
 *   DATABASE_URL                    — Postgres connection string
 *
 *   ACME_ACCOUNT_EMAIL              — Let's Encrypt account email
 *   ACME_LEGO_PATH                  — default /etc/gbox/lego
 *   ACME_LEGO_BINARY                — default `lego` on PATH
 *   ACME_ENVIRONMENT                — production (default) | staging
 *   ACME_WEBROOT_PATH               — default /var/www/acme-webroot
 *
 *   NGINX_DOMAINS_DIR               — default /etc/nginx/gbox-domains
 *   STOREFRONT_UPSTREAM             — e.g. http://127.0.0.1:4321
 *   NGINX_NO_SUDO                   — set to "1" when running as root (dev/bootstrap)
 *
 *   DOMAIN_WORKER_VERIFY_INTERVAL   — ms (default 60000)
 *   DOMAIN_WORKER_SSL_INTERVAL      — ms (default 30000)
 *   DOMAIN_WORKER_BATCH_SIZE        — rows per tick (default 25)
 *
 * Signal handling: SIGINT / SIGTERM trigger a graceful drain.
 */

import 'dotenv/config'
import { promises as dns } from 'node:dns'
import { createDb, destroyDb } from '@gbox/db'
import { runVerificationBatch } from '@gbox/core/modules/domains/verification-worker.js'
import { syncPendingSslBatch } from '@gbox/core/modules/domains/ssl-orchestrator.js'
import { loadActiveEdgeIpv4Set } from '@gbox/core/modules/domains/edge-nodes.js'
import type { AcmeClientConfig, AcmeEnvironment } from '@gbox/core/modules/domains/acme-client.js'
import type { NginxWriterConfig } from '@gbox/core/modules/domains/nginx-writer.js'
import type { NginxReloaderConfig } from '@gbox/core/modules/domains/nginx-reloader.js'
import type { DnsTxtResolver } from '@gbox/core/modules/ops/domain-verification.js'
import type { DnsARecordResolver } from '@gbox/core/modules/domains/verification-worker.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VERIFY_INTERVAL_MS = Number(process.env.DOMAIN_WORKER_VERIFY_INTERVAL ?? 60_000)
const SSL_INTERVAL_MS = Number(process.env.DOMAIN_WORKER_SSL_INTERVAL ?? 30_000)
const BATCH_SIZE = Number(process.env.DOMAIN_WORKER_BATCH_SIZE ?? 25)

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[domains-worker] Missing required env var: ${name}`)
    process.exit(1)
  }
  return v
}

const acmeConfig: AcmeClientConfig = {
  accountEmail: requireEnv('ACME_ACCOUNT_EMAIL'),
  legoPath: process.env.ACME_LEGO_PATH,
  legoBinary: process.env.ACME_LEGO_BINARY,
  environment: (process.env.ACME_ENVIRONMENT as AcmeEnvironment | undefined) ?? 'production',
  webrootPath: process.env.ACME_WEBROOT_PATH,
}

const nginxWriterConfig: NginxWriterConfig = {
  domainsDir: process.env.NGINX_DOMAINS_DIR,
  storefrontUpstream: requireEnv('STOREFRONT_UPSTREAM'),
}

const nginxReloaderConfig: NginxReloaderConfig = {
  noSudo: process.env.NGINX_NO_SUDO === '1',
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

type Level = 'info' | 'warn' | 'error'
function log(level: Level, event: string, fields?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: 'domains-worker',
    event,
    ...fields,
  }
  const sink = level === 'error' ? process.stderr : process.stdout
  sink.write(JSON.stringify(line) + '\n')
}
const logger = {
  info: (event: string, fields?: Record<string, unknown>) => log('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log('error', event, fields),
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

const txtResolver: DnsTxtResolver = async (host) => dns.resolveTxt(host)
const aResolver: DnsARecordResolver = async (host) => dns.resolve4(host)

// ---------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------

const db = createDb()
let shuttingDown = false
let verifyBusy = false
let sslBusy = false

async function verifyTick(): Promise<void> {
  if (shuttingDown || verifyBusy) return
  verifyBusy = true
  const started = Date.now()
  try {
    // Reload the active edge IP set every tick so adding a new edge
    // node via god-admin picks up on the next run without a restart.
    const edgeIpv4 = await loadActiveEdgeIpv4Set(db)
    const summary = await runVerificationBatch(db, {
      txtResolver,
      aResolver,
      edgeIpv4,
      batchSize: BATCH_SIZE,
      logger,
    })
    logger.info('verify_tick.done', {
      ...summary,
      durationMs: Date.now() - started,
    })
  } catch (err) {
    logger.error('verify_tick.crash', {
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    verifyBusy = false
  }
}

async function sslTick(): Promise<void> {
  if (shuttingDown || sslBusy) return
  sslBusy = true
  const started = Date.now()
  try {
    const summary = await syncPendingSslBatch(db, {
      config: {
        acme: acmeConfig,
        nginxWriter: nginxWriterConfig,
        nginxReloader: nginxReloaderConfig,
      },
      batchSize: BATCH_SIZE,
    })
    logger.info('ssl_tick.done', {
      ...summary,
      durationMs: Date.now() - started,
    })
  } catch (err) {
    logger.error('ssl_tick.crash', {
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    sslBusy = false
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

logger.info('startup', {
  verifyIntervalMs: VERIFY_INTERVAL_MS,
  sslIntervalMs: SSL_INTERVAL_MS,
  batchSize: BATCH_SIZE,
  acmeEnvironment: acmeConfig.environment,
  storefrontUpstream: nginxWriterConfig.storefrontUpstream,
  nginxNoSudo: nginxReloaderConfig.noSudo ?? false,
})

const verifyTimer = setInterval(verifyTick, VERIFY_INTERVAL_MS)
const sslTimer = setInterval(sslTick, SSL_INTERVAL_MS)

void verifyTick()
void sslTick()

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('shutdown.begin', { signal })

  clearInterval(verifyTimer)
  clearInterval(sslTimer)

  const deadline = Date.now() + 5000
  while ((verifyBusy || sslBusy) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  try {
    await destroyDb(db)
  } catch (err) {
    logger.error('shutdown.db_close_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  logger.info('shutdown.done')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', {
    error: err instanceof Error ? err.message : String(err),
  })
})
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  })
})
