/**
 * SSL Bootstrap — wire `requestSsl()` into the verify flow.
 *
 * The verify endpoint (`apps/store-admin/src/pages/domains.ts`) calls
 * `verifyDomain()` and gets back `{ ok: true, method: 'a_record' | 'cloudflare', ... }`.
 * On the `a_record` path we want to:
 *
 *   1. Build the ssl-orchestrator config from env vars.
 *   2. Fire `requestSsl(db, { shopId, domainId })` in the background
 *      so the seller's "Verify" click doesn't block waiting for lego.
 *   3. Log the result; failures show up in the UI as `ssl_status='failed'`
 *      with `ssl_last_error` populated, which the domains page already
 *      knows how to render.
 *
 * On the `cloudflare` path we DO NOT call ssl-orchestrator — Cloudflare
 * terminates TLS at their edge and the row is already
 * `ssl_status='active'`. Calling lego on a CF-proxied apex would just
 * burn rate-limit budget for no benefit.
 *
 * Gated by `GBOX_SSL_PROVISION_ENABLED`. The env var must be exactly
 * the literal string 'true' (case-insensitive) to enable provisioning.
 * Anything else — including 'false', 'no', '0', or unset — leaves the
 * function as a no-op. This is the kill-switch for dev / staging /
 * any environment without a public IP that Let's Encrypt can reach,
 * because lego will otherwise spin trying to validate a /.well-known
 * URL that 404s from the public internet.
 *
 * Why a separate module instead of inlining in cloudflare-service.ts:
 *   - Keeps `verifyDomain()` pure (no env reads, no spawn, no logger).
 *   - Lets the orchestrator wiring live next to the orchestrator code.
 *   - The kill-switch + config assembly logic is the only thing that
 *     changes between environments, so isolating it makes for a
 *     smaller diff when we move to public hosting.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { requestSsl, type SslOrchestratorConfig } from './ssl-orchestrator.js'

export interface SslBootstrapOptions {
  /**
   * Inject `requestSsl` for tests. Defaults to the real orchestrator.
   */
  requestSslImpl?: typeof requestSsl
  /**
   * Inject env reader for tests. Defaults to `process.env`.
   */
  envImpl?: NodeJS.ProcessEnv
  /**
   * Inject the logger sink. Defaults to `console.warn` / `console.info`.
   */
  loggerImpl?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/**
 * Whether the env enables real SSL provisioning. Exposed for tests.
 */
export function isSslProvisionEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.GBOX_SSL_PROVISION_ENABLED
  if (typeof raw !== 'string') return false
  return raw.toLowerCase() === 'true'
}

/**
 * Build the ssl-orchestrator config from env. Caller is responsible
 * for ensuring `GBOX_SSL_PROVISION_ENABLED=true` before calling this.
 *
 * Required env:
 *   GBOX_LETSENCRYPT_EMAIL  — account email for ACME
 *
 * Optional env (with defaults):
 *   GBOX_LEGO_PATH          — directory for lego state. Default /etc/gbox/lego
 *   GBOX_LEGO_BIN           — path to the lego binary. Default 'lego' on $PATH
 *   GBOX_ACME_WEBROOT       — webroot for HTTP-01. Default /var/www/acme-webroot
 *   GBOX_NGINX_DOMAINS_DIR  — where per-domain server blocks live. Default /etc/nginx/gbox-domains
 *   GBOX_STOREFRONT_UPSTREAM — proxy_pass target. Default http://127.0.0.1:4326
 *   GBOX_NGINX_BIN          — nginx binary path. Default 'nginx'
 *   GBOX_SYSTEMCTL_BIN      — systemctl binary path. Default 'systemctl'
 *   GBOX_NGINX_NO_SUDO      — '1' to skip sudo (Node already runs as root). Default off
 *   GBOX_LETSENCRYPT_STAGING — '1' for staging directory (test certs). Default off
 */
export function buildOrchestratorConfigFromEnv(env: NodeJS.ProcessEnv): SslOrchestratorConfig | null {
  const email = env.GBOX_LETSENCRYPT_EMAIL
  if (!email || typeof email !== 'string') return null

  const acme: SslOrchestratorConfig['acme'] = {
    accountEmail: email,
    legoPath: env.GBOX_LEGO_PATH ?? '/etc/gbox/lego',
    legoBinary: env.GBOX_LEGO_BIN ?? 'lego',
    webrootPath: env.GBOX_ACME_WEBROOT ?? '/var/www/acme-webroot',
    environment: env.GBOX_LETSENCRYPT_STAGING === '1' ? 'staging' : 'production',
  }
  const nginxWriter: SslOrchestratorConfig['nginxWriter'] = {
    domainsDir: env.GBOX_NGINX_DOMAINS_DIR ?? '/etc/nginx/gbox-domains',
    storefrontUpstream: env.GBOX_STOREFRONT_UPSTREAM ?? 'http://127.0.0.1:4326',
  }
  const nginxReloader: SslOrchestratorConfig['nginxReloader'] = {
    nginxBinary: env.GBOX_NGINX_BIN ?? 'nginx',
    systemctlBinary: env.GBOX_SYSTEMCTL_BIN ?? 'systemctl',
    noSudo: env.GBOX_NGINX_NO_SUDO === '1',
  }
  return { acme, nginxWriter, nginxReloader, reloadOnSuccess: true }
}

/**
 * Fire-and-forget SSL provisioning. Call this from the verify route's
 * `a_record` success path. Returns a Promise but the caller should
 * NOT await it — the orchestrator can take 30-90 seconds to issue a
 * cert, and the seller's verify response should not hang on it.
 *
 * The function's own error handling guarantees no exception escapes:
 *   - kill-switch off  → logs `info` and returns immediately
 *   - missing config   → logs `warn` and returns
 *   - orchestrator error → already persisted to ssl_last_error by
 *     the orchestrator itself; we just log and move on
 */
export async function bootstrapSslForDomain(
  db: Kysely<Database>,
  input: { shopId: string; domainId: string; domain: string },
  options: SslBootstrapOptions = {},
): Promise<void> {
  const env = options.envImpl ?? process.env
  const log = options.loggerImpl ?? {
    // eslint-disable-next-line no-console
    info: (...a: unknown[]) => console.log('[ssl-bootstrap]', ...a),
    // eslint-disable-next-line no-console
    warn: (...a: unknown[]) => console.warn('[ssl-bootstrap]', ...a),
  }

  if (!isSslProvisionEnabled(env)) {
    log.info(
      `skip ${input.domain} (${input.domainId}): GBOX_SSL_PROVISION_ENABLED is not 'true'`,
    )
    return
  }

  const config = buildOrchestratorConfigFromEnv(env)
  if (!config) {
    log.warn(
      `skip ${input.domain} (${input.domainId}): missing GBOX_LETSENCRYPT_EMAIL`,
    )
    return
  }

  try {
    const requestImpl = options.requestSslImpl ?? requestSsl
    const result = await requestImpl(
      db,
      { shopId: input.shopId, domainId: input.domainId },
      config,
    )

    if (result.ok) {
      log.info(
        `provisioned ${input.domain} → cert valid until ${result.certificate?.expiresAt?.toISOString?.() ?? 'unknown'}`,
      )
    } else {
      log.warn(
        `${input.domain} provisioning failed: code=${result.code} message=${result.message}`,
      )
    }
  } catch (err) {
    // Orchestrator should not throw — but if it does, swallow + log so
    // the verify route still returns a clean success to the seller.
    log.warn(
      `${input.domain} unexpected provisioning error: ${(err as Error).message}`,
    )
  }
}
