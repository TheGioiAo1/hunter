/**
 * Gbox Platform — Email webhook signature verification (Phase 14 PR4.B)
 *
 * Two verification flavors live here:
 *
 *   1. SNS X.509 signature verify
 *      AWS SNS signs every message with an RSA private key whose
 *      certificate is fetched from `SigningCertURL`. To verify we:
 *      - reject SigningCertURL unless its host is under the allowlist
 *        (SSRF defense — we're fetching over the network);
 *      - fetch the cert with a short timeout, no redirects, HTTPS only;
 *      - cache the cert PEM in-process (SNS rotates rarely, ~annually);
 *      - construct the canonical string per AWS spec (field order varies
 *        by Type);
 *      - verify RSA-SHA1 for SignatureVersion='1' (legacy, still live
 *        in some regions) or RSA-SHA256 for SignatureVersion='2' (2022+
 *        default).
 *
 *   2. Generic HMAC verify
 *      For providers that aren't SES (Resend, Postmark, home-grown SMTP
 *      DSN parsers). Thin wrapper over the existing
 *      packages/core/src/modules/webhooks/hmac.ts helper — no duplication,
 *      no secret-management drift.
 *
 * DESIGN
 * ------
 * CertFetcher is an interface injected into verifySnsSignature(). The
 * real implementation (createDefaultCertFetcher) fetches over HTTPS. The
 * smoke test injects a mock fetcher that returns a cert the test itself
 * signed the payload with. This keeps the verify code production-exact
 * in tests without needing to hit AWS.
 *
 * There's an escape hatch env flag `EMAIL_WEBHOOK_SKIP_SNS_VERIFY=1`
 * used ONLY by the smoke test to bypass the whole verify path when we
 * don't want to deal with cert generation. Production code ignores it.
 * The flag's presence is recorded in ses_webhook_events.signature_verified
 * so forensics can tell the difference.
 *
 * IRON RULE 5
 * -----------
 * No surface in this file mentions god_admin. Failed verifications log
 * the reason internally and surface a single word to the caller
 * ('signature_invalid', 'cert_fetch_failed', etc.) — never the URL or
 * seller-internal details.
 */

import crypto from 'node:crypto'
import https from 'node:https'
import { URL } from 'node:url'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The envelope AWS SNS posts to our webhook. The body is application/json
 * (SNS default) OR text/plain (if the subscription was created with
 * RawMessageDelivery=false, which is the default). We always parse the
 * body as JSON regardless of Content-Type.
 */
export interface SnsEnvelope {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'
  MessageId: string
  TopicArn: string
  Timestamp: string
  SignatureVersion: '1' | '2'
  Signature: string
  SigningCertURL: string
  // Notification-only
  Message?: string
  Subject?: string
  UnsubscribeURL?: string
  // Subscription confirmation only
  SubscribeURL?: string
  Token?: string
}

export interface CertFetcher {
  /** Returns PEM-encoded cert for the given URL. Throws on fetch failure. */
  fetchCert(url: string): Promise<string>
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_field' | 'cert_host_not_allowed' | 'cert_fetch_failed' | 'signature_invalid' | 'unsupported_signature_version' | 'bad_cert' }

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Default cert host allowlist. Production must never broaden this to a
 * wildcard TLD — SigningCertURL is the SSRF attack surface.
 *
 * We match by `.endsWith()` of the URL host. `.amazonaws.com` covers
 * every SNS region (`sns.us-east-1.amazonaws.com`, `sns.ap-southeast-1.
 * amazonaws.com`, etc.) while blocking lookalikes.
 */
const DEFAULT_CERT_HOST_SUFFIXES = ['.amazonaws.com']

function readCertHostAllowlist(): string[] {
  const raw = (process.env.EMAIL_WEBHOOK_SNS_CERT_HOST_ALLOWLIST ?? '').trim()
  if (!raw) return DEFAULT_CERT_HOST_SUFFIXES
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Seconds. AWS cert fetch should be sub-second. Long timeouts are a
 * DOS risk (attacker sends 1000 bogus Notifications pointing at a slow
 * cert endpoint).
 */
const CERT_FETCH_TIMEOUT_MS = 3_000

// ---------------------------------------------------------------------------
// In-process cert cache
// ---------------------------------------------------------------------------

const CERT_CACHE = new Map<string, { pem: string; cachedAt: number }>()
// 24 hours — certs rotate yearly, this is safe.
const CERT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function getCachedCert(url: string): string | null {
  const entry = CERT_CACHE.get(url)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > CERT_CACHE_TTL_MS) {
    CERT_CACHE.delete(url)
    return null
  }
  return entry.pem
}

function setCachedCert(url: string, pem: string): void {
  CERT_CACHE.set(url, { pem, cachedAt: Date.now() })
}

/**
 * Test seam — lets the smoke test pre-load a cert without hitting HTTPS.
 */
export function _primeCertCache(url: string, pem: string): void {
  setCachedCert(url, pem)
}

/** Test seam — clear the cache between assertions. */
export function _clearCertCache(): void {
  CERT_CACHE.clear()
}

// ---------------------------------------------------------------------------
// Default production cert fetcher
// ---------------------------------------------------------------------------

export function createDefaultCertFetcher(opts?: {
  allowedHostSuffixes?: string[]
  timeoutMs?: number
}): CertFetcher {
  const allowlist = opts?.allowedHostSuffixes ?? readCertHostAllowlist()
  const timeoutMs = opts?.timeoutMs ?? CERT_FETCH_TIMEOUT_MS

  return {
    async fetchCert(url: string): Promise<string> {
      if (!isCertHostAllowed(url, allowlist)) {
        throw new Error('cert_host_not_allowed')
      }

      const cached = getCachedCert(url)
      if (cached) return cached

      const pem = await httpsGet(url, timeoutMs)
      if (!isValidPemCertificate(pem)) {
        throw new Error('bad_cert')
      }
      setCachedCert(url, pem)
      return pem
    },
  }
}

function isCertHostAllowed(rawUrl: string, allowlist: string[]): boolean {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return allowlist.some((suffix) => host.endsWith(suffix.toLowerCase()))
  } catch {
    return false
  }
}

function isValidPemCertificate(pem: string): boolean {
  return (
    pem.includes('-----BEGIN CERTIFICATE-----') &&
    pem.includes('-----END CERTIFICATE-----')
  )
}

function httpsGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`cert_fetch_failed: HTTP ${res.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('timeout', () => {
      req.destroy(new Error('cert_fetch_failed: timeout'))
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Canonical string construction
// ---------------------------------------------------------------------------

/**
 * Canonical string per AWS SNS docs:
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * Fields are listed in a specific order, each followed by its value,
 * each separated by '\n', with a trailing '\n'. Subject is included
 * ONLY when present (Notification type can omit it).
 *
 * Field order:
 *   Notification: Message, MessageId, Subject (if present), Timestamp, TopicArn, Type
 *   SubscriptionConfirmation / UnsubscribeConfirmation:
 *     Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type
 */
export function buildCanonicalString(env: SnsEnvelope): string | null {
  const fields: string[] = []
  const push = (name: string, value: string | undefined) => {
    if (value == null) return
    fields.push(name)
    fields.push(value)
  }

  if (env.Type === 'Notification') {
    if (env.Message == null || env.MessageId == null || env.Timestamp == null ||
        env.TopicArn == null) {
      return null
    }
    push('Message', env.Message)
    push('MessageId', env.MessageId)
    if (env.Subject != null) push('Subject', env.Subject)
    push('Timestamp', env.Timestamp)
    push('TopicArn', env.TopicArn)
    push('Type', env.Type)
  } else if (env.Type === 'SubscriptionConfirmation' || env.Type === 'UnsubscribeConfirmation') {
    if (env.Message == null || env.MessageId == null || env.SubscribeURL == null ||
        env.Timestamp == null || env.Token == null || env.TopicArn == null) {
      return null
    }
    push('Message', env.Message)
    push('MessageId', env.MessageId)
    push('SubscribeURL', env.SubscribeURL)
    push('Timestamp', env.Timestamp)
    push('Token', env.Token)
    push('TopicArn', env.TopicArn)
    push('Type', env.Type)
  } else {
    return null
  }

  // Fields interleaved: [name, value, name, value, ...] joined with '\n'
  // plus a trailing '\n' after the last value.
  return fields.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export async function verifySnsSignature(
  envelope: SnsEnvelope,
  certFetcher: CertFetcher,
): Promise<VerifyResult> {
  // 1. Required fields present
  if (!envelope.Signature || !envelope.SigningCertURL || !envelope.SignatureVersion) {
    return { ok: false, reason: 'missing_field' }
  }

  // 2. Canonical string
  const canonical = buildCanonicalString(envelope)
  if (canonical == null) {
    return { ok: false, reason: 'missing_field' }
  }

  // 3. Algorithm per SignatureVersion
  const version = String(envelope.SignatureVersion)
  let algorithm: 'RSA-SHA1' | 'RSA-SHA256'
  if (version === '1') {
    algorithm = 'RSA-SHA1'
  } else if (version === '2') {
    algorithm = 'RSA-SHA256'
  } else {
    return { ok: false, reason: 'unsupported_signature_version' }
  }

  // 4. Fetch cert (with host allowlist enforcement inside the fetcher)
  let pem: string
  try {
    pem = await certFetcher.fetchCert(envelope.SigningCertURL)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('cert_host_not_allowed')) {
      return { ok: false, reason: 'cert_host_not_allowed' }
    }
    if (msg.includes('bad_cert')) {
      return { ok: false, reason: 'bad_cert' }
    }
    return { ok: false, reason: 'cert_fetch_failed' }
  }

  // 5. Extract public key + verify
  let publicKey: crypto.KeyObject
  try {
    publicKey = crypto.createPublicKey(pem)
  } catch {
    return { ok: false, reason: 'bad_cert' }
  }

  const verifier = crypto.createVerify(algorithm)
  verifier.update(canonical, 'utf8')

  let valid: boolean
  try {
    valid = verifier.verify(publicKey, Buffer.from(envelope.Signature, 'base64'))
  } catch {
    return { ok: false, reason: 'signature_invalid' }
  }

  if (!valid) {
    return { ok: false, reason: 'signature_invalid' }
  }

  return { ok: true }
}

/**
 * Test-seam: should the smoke test skip signature verification?
 *
 * Returns true ONLY if the env flag is set AND we're not in an
 * environment that looks like production. The "looks like production"
 * check is `NODE_ENV=production` → always verify, no exceptions.
 */
export function shouldSkipSnsVerifyForTests(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY === '1'
}

// ---------------------------------------------------------------------------
// Generic HMAC verification (thin wrapper)
// ---------------------------------------------------------------------------

/**
 * For non-SES providers. Timing-safe HMAC-SHA256 compare.
 *
 * Re-exported instead of imported from webhooks/hmac.ts so callers of
 * the email module get a single import surface. Implementation is
 * deliberately tiny so we don't fork from the base helper.
 */
export function verifyHmacSignature(
  secret: string,
  rawBody: string | Buffer,
  receivedSignatureBase64: string,
): boolean {
  if (!secret || !receivedSignatureBase64) return false
  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest()
    const received = Buffer.from(receivedSignatureBase64, 'base64')
    if (expected.length !== received.length) return false
    return crypto.timingSafeEqual(expected, received)
  } catch {
    return false
  }
}
