/**
 * Gbox Platform — ACME Client (lego wrapper)
 * (Landing Page System Phase 1D)
 *
 * Thin, injectable wrapper around the `lego` ACME client binary. This
 * is how Gbox's edge obtains Let's Encrypt certificates for every
 * merchant custom domain and for the platform's own wildcard.
 *
 * Why lego and why spawn?
 *
 *   1. lego is a single Go binary — no runtime, no pip, no npm tree
 *      to audit. Drops straight onto the edge host and runs.
 *   2. Spawning via `child_process.spawn` lets us swap in a fake
 *      implementation for tests (injected `spawnImpl`) so the
 *      orchestrator can unit-test the full "verify → issue → write
 *      nginx → reload" flow without touching Let's Encrypt.
 *   3. lego supports both HTTP-01 (webroot) and DNS-01 (Cloudflare
 *      provider, for the wildcard `*.gbox.co` cert) with the same
 *      CLI surface, so the same wrapper handles both.
 *
 * State machine this module *does not* own:
 *   - When to issue / renew / retry — lives in `ssl-orchestrator.ts`
 *   - How to persist certificate metadata — lives in `service.ts`
 *   - How to reload nginx after a successful issue — lives in
 *     `nginx-reloader.ts`
 *
 * This module only owns: "given these inputs, spawn lego and return
 * a parsed result". No DB, no disk mutation beyond what lego itself
 * writes, no nginx signals. Tiny surface area by design.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Let's Encrypt has two API endpoints:
 *   - production: real certs, hard rate limits (50 certs/week/domain)
 *   - staging:    fake CA, generous limits, safe for smoke tests
 *
 * The orchestrator defaults to `staging` on the first issue attempt
 * for a given domain, then rotates to `production` after a successful
 * staging order. This prevents runaway retry storms from burning
 * production quota while still exercising the full flow.
 */
export type AcmeEnvironment = 'production' | 'staging'

/**
 * HTTP-01 validates by serving a token file over plain HTTP at
 * `/.well-known/acme-challenge/<token>`. DNS-01 validates by
 * publishing a TXT record under `_acme-challenge.<domain>`. We use
 * HTTP-01 for per-merchant certs (fully automatic once DNS A
 * records exist) and DNS-01 for the platform wildcard (required —
 * Let's Encrypt refuses wildcards over HTTP-01).
 */
export type AcmeChallenge = 'http01' | 'dns01'

/**
 * Configuration for a single lego invocation. The orchestrator
 * builds one of these per domain (or one for the wildcard).
 */
export interface AcmeClientConfig {
  /** Where lego stores account keys and certs. Defaults to `/etc/gbox/lego`. */
  legoPath?: string
  /**
   * Absolute path to the `lego` binary. Defaults to `lego` on PATH,
   * which is fine for the edge host but tests inject a fake.
   */
  legoBinary?: string
  /** ACME account email. Required by Let's Encrypt ToS acceptance. */
  accountEmail: string
  /** production or staging (default production — orchestrator overrides). */
  environment?: AcmeEnvironment
  /**
   * For HTTP-01 only: absolute path to the webroot directory Nginx
   * serves `/.well-known/acme-challenge/` from. lego writes tokens
   * here. Defaults to `/var/www/acme-webroot`.
   */
  webrootPath?: string
  /**
   * For DNS-01 only: DNS provider name (e.g. `cloudflare`). The
   * provider's credentials must be in process env — lego reads them
   * directly from there. See lego docs for the env var naming.
   */
  dnsProvider?: string
  /** Injectable spawn for tests. Defaults to node:child_process.spawn. */
  spawnImpl?: typeof nodeSpawn
  /** Injectable fs.readFile for tests. */
  readFileImpl?: typeof fs.readFile
  /** Injectable fs.stat for tests. */
  statImpl?: typeof fs.stat
  /** Max seconds to wait for lego to exit. Defaults to 120. */
  timeoutSeconds?: number
}

export interface IssueCertificateInput {
  /** Primary hostname for the cert. e.g. `thaibeotit.com`. */
  domain: string
  /** Optional additional SANs. e.g. `['www.thaibeotit.com']`. */
  sans?: string[]
  /** http01 (default) or dns01. */
  challenge?: AcmeChallenge
}

export interface IssuedCertificate {
  /** Primary domain. */
  domain: string
  /** Absolute path to the PEM cert file lego wrote. */
  certPath: string
  /** Absolute path to the PEM private key file. */
  keyPath: string
  /** Absolute path to the issuer / chain file (may equal certPath on some layouts). */
  chainPath: string
  /** When the cert was issued (from lego metadata or filesystem mtime). */
  issuedAt: Date
  /** When the cert expires — parsed from lego's JSON metadata file. */
  expiresAt: Date
  /** `staging` if the order ran against staging, else `production`. */
  environment: AcmeEnvironment
  /** Raw lego stdout, retained for debugging / audit. */
  stdout: string
}

/** Classification of the ACME failure so the orchestrator can branch. */
export type AcmeErrorKind =
  | 'rate_limited' // Let's Encrypt 429 — back off hard
  | 'dns_not_ready' // A record not yet propagated, retry
  | 'unauthorized' // HTTP-01 token not reachable
  | 'invalid_input' // bad domain / bad CLI flags
  | 'config_error' // webroot missing, provider env missing
  | 'timeout' // lego exceeded timeout
  | 'binary_missing' // lego not on PATH
  | 'unknown'

export interface AcmeError {
  ok: false
  kind: AcmeErrorKind
  message: string
  exitCode?: number | null
  stdout?: string
  stderr?: string
}

export type AcmeResult<T> = { ok: true; value: T } | AcmeError

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LEGO_PATH = '/etc/gbox/lego'
const DEFAULT_LEGO_BINARY = 'lego'
const DEFAULT_WEBROOT = '/var/www/acme-webroot'
const DEFAULT_TIMEOUT_SECONDS = 120

const ACME_PRODUCTION_URL = 'https://acme-v02.api.letsencrypt.org/directory'
const ACME_STAGING_URL =
  'https://acme-staging-v02.api.letsencrypt.org/directory'

// ---------------------------------------------------------------------------
// CLI arg builder
// ---------------------------------------------------------------------------

/**
 * Build the lego command line for a single issue. Returned as a
 * tuple so callers can pass it straight to spawn and so tests can
 * assert on the exact shape of the command without re-parsing a
 * string.
 *
 * Shape:
 *   lego --path <legoPath>
 *        --email <accountEmail>
 *        --server <url>           (staging only, omitted for prod)
 *        --accept-tos
 *        --http --http.webroot <webroot>   (for http01)
 *        --dns <provider>                   (for dns01)
 *        --domains <d1> [--domains <d2> ...]
 *        run
 */
export function buildLegoArgs(
  config: AcmeClientConfig,
  input: IssueCertificateInput,
): string[] {
  const challenge = input.challenge ?? 'http01'
  const environment = config.environment ?? 'production'
  const legoPath = config.legoPath ?? DEFAULT_LEGO_PATH
  const webroot = config.webrootPath ?? DEFAULT_WEBROOT

  const args: string[] = [
    '--path',
    legoPath,
    '--email',
    config.accountEmail,
    '--accept-tos',
  ]

  if (environment === 'staging') {
    args.push('--server', ACME_STAGING_URL)
  } else {
    // lego defaults to production; pass explicitly so tests can
    // tell which env we asked for from the argv alone.
    args.push('--server', ACME_PRODUCTION_URL)
  }

  if (challenge === 'http01') {
    args.push('--http', '--http.webroot', webroot)
  } else {
    if (!config.dnsProvider) {
      throw new Error(
        `buildLegoArgs: dnsProvider is required when challenge=dns01 (domain ${input.domain})`,
      )
    }
    args.push('--dns', config.dnsProvider)
  }

  const allDomains = [input.domain, ...(input.sans ?? [])]
  for (const d of allDomains) {
    args.push('--domains', d)
  }

  args.push('run')
  return args
}

/**
 * Same as issue, but builds the argv for a renewal. lego renewal
 * takes the same `--domains` flag, swaps `run` for `renew`, and
 * accepts `--days` to force renewal when the cert has N or fewer
 * days remaining (we use 30 to match Shopify's posture).
 */
export function buildLegoRenewArgs(
  config: AcmeClientConfig,
  input: IssueCertificateInput & { renewalDays?: number },
): string[] {
  const base = buildLegoArgs(config, input)
  // Swap trailing 'run' for 'renew --days <n>'. We mutate the copy,
  // not the original, so tests can call buildLegoArgs and this
  // function independently.
  const copy = base.slice(0, -1)
  copy.push('renew')
  copy.push('--days', String(input.renewalDays ?? 30))
  return copy
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Pattern-match lego's stderr/stdout to figure out why it failed.
 * Kept pure so the orchestrator's tests can feed canned outputs and
 * assert on the returned kind without touching lego itself.
 *
 * Matching is deliberately loose — lego's error strings evolve
 * between versions and we'd rather catch a superset of rate-limit
 * errors than miss one.
 */
export function classifyLegoError(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): AcmeErrorKind {
  const combined = `${stdout}\n${stderr}`.toLowerCase()

  if (
    combined.includes('too many certificates') ||
    combined.includes('rate limit') ||
    combined.includes('429')
  ) {
    return 'rate_limited'
  }
  if (
    combined.includes('no such host') ||
    combined.includes('dns problem') ||
    combined.includes('nxdomain') ||
    combined.includes('could not find an a record')
  ) {
    return 'dns_not_ready'
  }
  if (
    combined.includes('unauthorized') ||
    combined.includes('fetching') ||
    combined.includes('challenge failed') ||
    combined.includes('connection refused') ||
    combined.includes('timeout during connect')
  ) {
    return 'unauthorized'
  }
  if (
    combined.includes('invalid email') ||
    combined.includes('no domains') ||
    combined.includes('invalid domain')
  ) {
    return 'invalid_input'
  }
  if (
    combined.includes('webroot') ||
    combined.includes('dns provider') ||
    combined.includes('missing required')
  ) {
    return 'config_error'
  }
  if (exitCode === null) {
    return 'timeout'
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runSpawn(
  spawnImpl: typeof nodeSpawn,
  binary: string,
  args: string[],
  opts: SpawnOptions & { timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnImpl(binary, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      // ENOENT (binary missing) surfaces here synchronously in some
      // Node versions — map to a consistent SpawnResult shape so the
      // caller only has one error path.
      resolve({
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // swallow — the close handler will still fire below.
      }
    }, opts.timeoutMs)

    child.on('error', (err) => {
      stderr += `\n${err.message}`
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: timedOut ? null : code,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Filesystem layout resolver
// ---------------------------------------------------------------------------

/**
 * lego writes certs to `<legoPath>/certificates/<domain>.{crt,key,issuer.crt,json}`.
 * Wildcard domains are sanitised to `_.gbox.co` — leading `*.` is
 * replaced with `_.`. We replicate that here so callers don't need
 * to know the convention.
 */
export function certificateFilePaths(
  legoPath: string,
  domain: string,
): {
  certPath: string
  keyPath: string
  chainPath: string
  metaPath: string
} {
  const safe = domain.replace(/^\*\./, '_.')
  const dir = path.posix.join(legoPath.replace(/\\/g, '/'), 'certificates')
  return {
    certPath: path.posix.join(dir, `${safe}.crt`),
    keyPath: path.posix.join(dir, `${safe}.key`),
    chainPath: path.posix.join(dir, `${safe}.issuer.crt`),
    metaPath: path.posix.join(dir, `${safe}.json`),
  }
}

/**
 * lego emits a JSON sidecar next to each cert with metadata
 * including the NotAfter / expiry. We prefer that over re-parsing
 * the X.509 cert because it's stable across lego versions and
 * avoids a dependency on a PEM parser.
 */
async function readCertMetadata(
  metaPath: string,
  readFileImpl: typeof fs.readFile,
): Promise<{ issuedAt: Date; expiresAt: Date } | null> {
  try {
    const raw = await readFileImpl(metaPath, 'utf8')
    const parsed = JSON.parse(raw as unknown as string) as {
      domain?: string
      certUrl?: string
      certStableUrl?: string
      notAfter?: string
      notBefore?: string
    }
    const expires = parsed.notAfter ? new Date(parsed.notAfter) : null
    const issued = parsed.notBefore ? new Date(parsed.notBefore) : null
    if (!expires || Number.isNaN(expires.getTime())) return null
    return {
      issuedAt:
        issued && !Number.isNaN(issued.getTime()) ? issued : new Date(),
      expiresAt: expires,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public: issueCertificate
// ---------------------------------------------------------------------------

/**
 * Spawn lego to order a new certificate for `input.domain`. Returns
 * a typed result — callers pattern-match on `ok` and react. Never
 * throws on normal ACME failures.
 *
 * On success the `IssuedCertificate` value includes absolute file
 * paths the caller should persist to `shop_domains.cert_path` etc.
 * and should hand to `nginx-writer.ts`.
 *
 * Note: lego silently skips the HTTP request when a valid cert
 * already exists on disk for the domain. Callers that want to force
 * re-issuance should delete the files first or use `renewCertificate`.
 */
export async function issueCertificate(
  config: AcmeClientConfig,
  input: IssueCertificateInput,
): Promise<AcmeResult<IssuedCertificate>> {
  const spawnImpl = config.spawnImpl ?? nodeSpawn
  const readFileImpl = config.readFileImpl ?? fs.readFile
  const legoPath = config.legoPath ?? DEFAULT_LEGO_PATH
  const binary = config.legoBinary ?? DEFAULT_LEGO_BINARY
  const timeoutMs = (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000

  let args: string[]
  try {
    args = buildLegoArgs(config, input)
  } catch (err) {
    return {
      ok: false,
      kind: 'config_error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const { exitCode, stdout, stderr, timedOut } = await runSpawn(
    spawnImpl,
    binary,
    args,
    { timeoutMs },
  )

  if (timedOut) {
    return {
      ok: false,
      kind: 'timeout',
      message: `lego exceeded ${timeoutMs / 1000}s while issuing ${input.domain}`,
      exitCode: null,
      stdout,
      stderr,
    }
  }

  if (exitCode !== 0) {
    // ENOENT surfaces as exitCode !== 0 with an error string in stderr.
    if (
      stderr.toLowerCase().includes('enoent') ||
      stderr.toLowerCase().includes('no such file or directory')
    ) {
      return {
        ok: false,
        kind: 'binary_missing',
        message: `lego binary not found at "${binary}" — install it or set AcmeClientConfig.legoBinary`,
        exitCode,
        stdout,
        stderr,
      }
    }
    return {
      ok: false,
      kind: classifyLegoError(exitCode, stdout, stderr),
      message:
        stderr.trim() ||
        stdout.trim() ||
        `lego exited with code ${exitCode} while issuing ${input.domain}`,
      exitCode,
      stdout,
      stderr,
    }
  }

  const paths = certificateFilePaths(legoPath, input.domain)
  const meta = await readCertMetadata(paths.metaPath, readFileImpl)
  if (!meta) {
    return {
      ok: false,
      kind: 'unknown',
      message: `lego reported success but metadata at ${paths.metaPath} was unreadable`,
      exitCode,
      stdout,
      stderr,
    }
  }

  return {
    ok: true,
    value: {
      domain: input.domain,
      certPath: paths.certPath,
      keyPath: paths.keyPath,
      chainPath: paths.chainPath,
      issuedAt: meta.issuedAt,
      expiresAt: meta.expiresAt,
      environment: config.environment ?? 'production',
      stdout,
    },
  }
}

// ---------------------------------------------------------------------------
// Public: renewCertificate
// ---------------------------------------------------------------------------

/**
 * Runs `lego renew` with the Shopify-style 30-day threshold (override
 * via `renewalDays`). lego no-ops if the cert still has more than
 * threshold days remaining — we treat that as success and let the
 * caller detect via the unchanged `expiresAt`.
 */
export async function renewCertificate(
  config: AcmeClientConfig,
  input: IssueCertificateInput & { renewalDays?: number },
): Promise<AcmeResult<IssuedCertificate>> {
  const spawnImpl = config.spawnImpl ?? nodeSpawn
  const readFileImpl = config.readFileImpl ?? fs.readFile
  const legoPath = config.legoPath ?? DEFAULT_LEGO_PATH
  const binary = config.legoBinary ?? DEFAULT_LEGO_BINARY
  const timeoutMs = (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000

  let args: string[]
  try {
    args = buildLegoRenewArgs(config, input)
  } catch (err) {
    return {
      ok: false,
      kind: 'config_error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  const { exitCode, stdout, stderr, timedOut } = await runSpawn(
    spawnImpl,
    binary,
    args,
    { timeoutMs },
  )

  if (timedOut) {
    return {
      ok: false,
      kind: 'timeout',
      message: `lego renew exceeded ${timeoutMs / 1000}s for ${input.domain}`,
      stdout,
      stderr,
    }
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      kind: classifyLegoError(exitCode, stdout, stderr),
      message: stderr.trim() || stdout.trim() || `lego renew exited ${exitCode}`,
      exitCode,
      stdout,
      stderr,
    }
  }

  const paths = certificateFilePaths(legoPath, input.domain)
  const meta = await readCertMetadata(paths.metaPath, readFileImpl)
  if (!meta) {
    return {
      ok: false,
      kind: 'unknown',
      message: `lego renew succeeded but metadata at ${paths.metaPath} unreadable`,
      stdout,
      stderr,
    }
  }

  return {
    ok: true,
    value: {
      domain: input.domain,
      certPath: paths.certPath,
      keyPath: paths.keyPath,
      chainPath: paths.chainPath,
      issuedAt: meta.issuedAt,
      expiresAt: meta.expiresAt,
      environment: config.environment ?? 'production',
      stdout,
    },
  }
}
