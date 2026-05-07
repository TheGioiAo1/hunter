/**
 * Gbox Platform — Certificate Renewal CLI
 * (Landing Page System Phase 1D)
 *
 * Single-shot daily renewal batch. Invoked by the systemd timer
 * `gbox-domains-renewal.timer` (see ops/edge/systemd/). Exits with
 * code 0 on success, 1 on unhandled error.
 *
 * Why a one-shot instead of a long-lived process? Cron semantics are
 * simpler for the monitoring story — the timer logs its own success
 * and PagerDuty wakes someone up if the timer doesn't run. A
 * long-lived process would need separate health-check instrumentation.
 *
 * Env:
 *
 *   DATABASE_URL                — Postgres connection string
 *   ACME_ACCOUNT_EMAIL          — Let's Encrypt account email
 *   ACME_LEGO_PATH              — default /etc/gbox/lego
 *   ACME_LEGO_BINARY            — default `lego` on PATH
 *   ACME_ENVIRONMENT            — production (default) | staging
 *   ACME_WEBROOT_PATH           — default /var/www/acme-webroot
 *   NGINX_DOMAINS_DIR           — default /etc/nginx/gbox-domains
 *   STOREFRONT_UPSTREAM         — e.g. http://127.0.0.1:4321
 *   RENEWAL_WINDOW_DAYS         — default 30
 *   RENEWAL_HARD_ALERT_DAYS     — default 7
 */

import 'dotenv/config'
import { createDb, destroyDb } from '@gbox/db'
import { runRenewalBatch } from '@gbox/core/modules/domains/renewal.js'
import type { AcmeClientConfig, AcmeEnvironment } from '@gbox/core/modules/domains/acme-client.js'
import type { NginxWriterConfig } from '@gbox/core/modules/domains/nginx-writer.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[domains-renewal] Missing required env var: ${name}`)
    process.exit(1)
  }
  return v
}

type Level = 'info' | 'warn' | 'error'
function log(level: Level, event: string, fields?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: 'domains-renewal',
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

async function main(): Promise<number> {
  const db = createDb()
  try {
    logger.info('startup', {
      environment: acmeConfig.environment,
      legoPath: acmeConfig.legoPath ?? '/etc/gbox/lego',
      domainsDir: nginxWriterConfig.domainsDir ?? '/etc/nginx/gbox-domains',
    })
    const summary = await runRenewalBatch(
      db,
      {
        acme: acmeConfig,
        nginxWriter: nginxWriterConfig,
        renewalWindowDays: Number(process.env.RENEWAL_WINDOW_DAYS ?? 30),
        hardAlertDays: Number(process.env.RENEWAL_HARD_ALERT_DAYS ?? 7),
        reloadOnce: true,
      },
      logger,
    )
    logger.info('done', summary as unknown as Record<string, unknown>)
    return 0
  } catch (err) {
    logger.error('crash', { error: err instanceof Error ? err.message : String(err) })
    return 1
  } finally {
    try {
      await destroyDb(db)
    } catch {
      // ignore — process is exiting
    }
  }
}

main().then((code) => process.exit(code))
