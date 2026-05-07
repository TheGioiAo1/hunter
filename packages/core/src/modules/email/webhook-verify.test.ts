/**
 * Unit tests for email/webhook-verify.ts
 *
 * Strategy: generate a real RSA keypair in-memory, sign a canonical
 * SNS string with the private key, then verify via the library using
 * an injected CertFetcher that returns the public key PEM.
 *
 * `crypto.createPublicKey()` accepts both full X.509 certs and raw
 * public key PEMs — the library doesn't require a cert-wrapped key,
 * so we can test the whole verify path without building X.509 certs
 * by hand (which would require `node-forge` or equivalent).
 *
 * The default production fetcher (createDefaultCertFetcher) rejects
 * raw public key PEMs via isValidPemCertificate() — but the verify
 * function itself only cares about the key material. Tests inject a
 * bypass fetcher; production never does.
 */

import crypto from 'node:crypto'
import { describe, expect, it, beforeAll, afterEach } from 'vitest'
import {
  buildCanonicalString,
  verifySnsSignature,
  verifyHmacSignature,
  shouldSkipSnsVerifyForTests,
  _clearCertCache,
  createDefaultCertFetcher,
  type SnsEnvelope,
  type CertFetcher,
} from './webhook-verify.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let KEYS: { privateKeyPem: string; publicKeyPem: string }

function generateTestKeypair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { privateKeyPem: privateKey as string, publicKeyPem: publicKey as string }
}

function signCanonical(canonical: string, algo: 'RSA-SHA1' | 'RSA-SHA256'): string {
  const signer = crypto.createSign(algo)
  signer.update(canonical, 'utf8')
  return signer.sign(KEYS.privateKeyPem, 'base64')
}

function makeEnvelope(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  const base: SnsEnvelope = {
    Type: 'Notification',
    MessageId: 'msg-abc-123',
    TopicArn: 'arn:aws:sns:us-east-1:000000000000:gbox-email-events',
    Timestamp: '2026-04-22T12:00:00.000Z',
    SignatureVersion: '2',
    Signature: '', // filled in by sign helper
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem',
    Message: '{"notificationType":"Bounce","bounce":{"bounceType":"Permanent"}}',
    ...overrides,
  }
  return base
}

function makeFetcher(pem: string): CertFetcher {
  return {
    async fetchCert(_url: string): Promise<string> {
      return pem
    },
  }
}

beforeAll(() => {
  KEYS = generateTestKeypair()
})

afterEach(() => {
  _clearCertCache()
})

// ---------------------------------------------------------------------------
// buildCanonicalString
// ---------------------------------------------------------------------------

describe('buildCanonicalString', () => {
  it('builds Notification canonical with standard fields', () => {
    const env = makeEnvelope()
    const canonical = buildCanonicalString(env)
    expect(canonical).not.toBeNull()
    // Notification field order: Message, MessageId, Timestamp, TopicArn, Type
    // With trailing newline after last value.
    expect(canonical).toBe(
      'Message\n' +
      '{"notificationType":"Bounce","bounce":{"bounceType":"Permanent"}}\n' +
      'MessageId\n' +
      'msg-abc-123\n' +
      'Timestamp\n' +
      '2026-04-22T12:00:00.000Z\n' +
      'TopicArn\n' +
      'arn:aws:sns:us-east-1:000000000000:gbox-email-events\n' +
      'Type\n' +
      'Notification\n',
    )
  })

  it('includes Subject in Notification canonical when present', () => {
    const env = makeEnvelope({ Subject: 'Amazon SES Email Event' })
    const canonical = buildCanonicalString(env)!
    // Subject slots between MessageId and Timestamp
    const lines = canonical.split('\n')
    const subjectIdx = lines.indexOf('Subject')
    expect(subjectIdx).toBeGreaterThan(0)
    expect(lines[subjectIdx + 1]).toBe('Amazon SES Email Event')
    // Order: Message, MessageId, Subject, Timestamp, TopicArn, Type
    expect(lines.indexOf('MessageId')).toBeLessThan(subjectIdx)
    expect(lines.indexOf('Timestamp')).toBeGreaterThan(subjectIdx)
  })

  it('omits Subject from Notification canonical when absent', () => {
    const env = makeEnvelope({ Subject: undefined })
    const canonical = buildCanonicalString(env)!
    expect(canonical).not.toContain('Subject\n')
  })

  it('builds SubscriptionConfirmation canonical with required extras', () => {
    const env = makeEnvelope({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&...',
      Token: 'tok-xyz',
      Message: 'You have chosen to subscribe to the topic ...',
    })
    const canonical = buildCanonicalString(env)!
    // Order: Message, MessageId, SubscribeURL, Timestamp, Token, TopicArn, Type
    const lines = canonical.split('\n')
    expect(lines.indexOf('SubscribeURL')).toBeGreaterThan(lines.indexOf('MessageId'))
    expect(lines.indexOf('Token')).toBeGreaterThan(lines.indexOf('Timestamp'))
    expect(canonical.endsWith('Type\nSubscriptionConfirmation\n')).toBe(true)
  })

  it('returns null when Notification is missing required fields', () => {
    const env = makeEnvelope({ Message: undefined })
    expect(buildCanonicalString(env)).toBeNull()
  })

  it('returns null when SubscriptionConfirmation is missing Token', () => {
    const env = makeEnvelope({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://...',
      Token: undefined,
    })
    expect(buildCanonicalString(env)).toBeNull()
  })

  it('returns null for unknown Type', () => {
    const env = makeEnvelope({ Type: 'SomethingWeird' as any })
    expect(buildCanonicalString(env)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// verifySnsSignature — happy path
// ---------------------------------------------------------------------------

describe('verifySnsSignature — RSA-SHA256 (version 2)', () => {
  it('verifies a correctly-signed Notification', async () => {
    const env = makeEnvelope()
    const canonical = buildCanonicalString(env)!
    env.Signature = signCanonical(canonical, 'RSA-SHA256')

    const result = await verifySnsSignature(env, makeFetcher(KEYS.publicKeyPem))
    expect(result).toEqual({ ok: true })
  })

  it('rejects a tampered Message', async () => {
    const env = makeEnvelope()
    const canonical = buildCanonicalString(env)!
    env.Signature = signCanonical(canonical, 'RSA-SHA256')

    // Mutate Message AFTER signing
    env.Message = '{"notificationType":"Bounce","bounce":{"bounceType":"Transient"}}'

    const result = await verifySnsSignature(env, makeFetcher(KEYS.publicKeyPem))
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' })
  })

  it('rejects when signature is base64-garbage', async () => {
    const env = makeEnvelope({ Signature: 'notABase64Signature==' })
    const result = await verifySnsSignature(env, makeFetcher(KEYS.publicKeyPem))
    expect(result.ok).toBe(false)
  })
})

describe('verifySnsSignature — RSA-SHA1 (version 1, legacy)', () => {
  it('verifies a correctly-signed v1 Notification', async () => {
    const env = makeEnvelope({ SignatureVersion: '1' })
    const canonical = buildCanonicalString(env)!
    env.Signature = signCanonical(canonical, 'RSA-SHA1')

    const result = await verifySnsSignature(env, makeFetcher(KEYS.publicKeyPem))
    expect(result).toEqual({ ok: true })
  })

  it('rejects v1-signed payload claimed as v2', async () => {
    const env = makeEnvelope({ SignatureVersion: '2' })
    const canonical = buildCanonicalString(env)!
    env.Signature = signCanonical(canonical, 'RSA-SHA1') // wrong algo

    const result = await verifySnsSignature(env, makeFetcher(KEYS.publicKeyPem))
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' })
  })
})

describe('verifySnsSignature — error branches', () => {
  it('rejects missing Signature field', async () => {
    const env = makeEnvelope({ Signature: '' })
    const result = await verifySnsSignature(env, makeFetcher(KEYS.publicKeyPem))
    expect(result).toEqual({ ok: false, reason: 'missing_field' })
  })

  it('rejects missing SigningCertURL field', async () => {
    const env = makeEnvelope({ SigningCertURL: '' })
    const result = await verifySnsSignature(env, makeFetcher(KEYS.publicKeyPem))
    expect(result).toEqual({ ok: false, reason: 'missing_field' })
  })

  it('rejects unsupported SignatureVersion', async () => {
    // Must provide a non-empty Signature so we reach the version check
    // instead of short-circuiting on missing_field.
    const env = makeEnvelope({
      SignatureVersion: '3' as any,
      Signature: 'placeholder-signature-bytes',
    })
    const result = await verifySnsSignature(env, makeFetcher(KEYS.publicKeyPem))
    expect(result).toEqual({ ok: false, reason: 'unsupported_signature_version' })
  })

  it('surfaces cert_fetch_failed when the fetcher throws', async () => {
    const env = makeEnvelope()
    const canonical = buildCanonicalString(env)!
    env.Signature = signCanonical(canonical, 'RSA-SHA256')

    const failing: CertFetcher = {
      async fetchCert() {
        throw new Error('connection refused')
      },
    }
    const result = await verifySnsSignature(env, failing)
    expect(result).toEqual({ ok: false, reason: 'cert_fetch_failed' })
  })

  it('surfaces cert_host_not_allowed when fetcher rejects host', async () => {
    const env = makeEnvelope({
      SigningCertURL: 'https://evil.example.com/cert.pem',
    })
    const canonical = buildCanonicalString(env)!
    env.Signature = signCanonical(canonical, 'RSA-SHA256')

    const strictFetcher: CertFetcher = {
      async fetchCert() {
        throw new Error('cert_host_not_allowed')
      },
    }
    const result = await verifySnsSignature(env, strictFetcher)
    expect(result).toEqual({ ok: false, reason: 'cert_host_not_allowed' })
  })

  it('surfaces bad_cert when createPublicKey fails', async () => {
    const env = makeEnvelope()
    const canonical = buildCanonicalString(env)!
    env.Signature = signCanonical(canonical, 'RSA-SHA256')

    const badFetcher: CertFetcher = {
      async fetchCert() {
        return 'not-a-real-pem'
      },
    }
    const result = await verifySnsSignature(env, badFetcher)
    expect(result).toEqual({ ok: false, reason: 'bad_cert' })
  })
})

// ---------------------------------------------------------------------------
// createDefaultCertFetcher — host allowlist
// ---------------------------------------------------------------------------

describe('createDefaultCertFetcher — SSRF defense', () => {
  it('rejects non-HTTPS URL', async () => {
    const fetcher = createDefaultCertFetcher({ allowedHostSuffixes: ['.amazonaws.com'] })
    await expect(
      fetcher.fetchCert('http://sns.us-east-1.amazonaws.com/cert.pem'),
    ).rejects.toThrow(/cert_host_not_allowed/)
  })

  it('rejects host not in allowlist', async () => {
    const fetcher = createDefaultCertFetcher({ allowedHostSuffixes: ['.amazonaws.com'] })
    await expect(
      fetcher.fetchCert('https://evil.example.com/cert.pem'),
    ).rejects.toThrow(/cert_host_not_allowed/)
  })

  it('rejects look-alike host (amazonaws.com.evil.com)', async () => {
    const fetcher = createDefaultCertFetcher({ allowedHostSuffixes: ['.amazonaws.com'] })
    // hostname = "amazonaws.com.evil.com" — .endsWith(".amazonaws.com") is false
    // (correctly — the suffix must be a SUFFIX of the full host)
    await expect(
      fetcher.fetchCert('https://amazonaws.com.evil.com/cert.pem'),
    ).rejects.toThrow(/cert_host_not_allowed/)
  })

  it('rejects malformed URL', async () => {
    const fetcher = createDefaultCertFetcher({ allowedHostSuffixes: ['.amazonaws.com'] })
    await expect(fetcher.fetchCert('not://a url')).rejects.toThrow(/cert_host_not_allowed/)
  })

  // Note: we do NOT test the HTTPS fetch success path here because it
  // would hit a real AWS endpoint. The smoke test (with a local mock
  // fetcher) covers the end-to-end happy path.
})

// ---------------------------------------------------------------------------
// verifyHmacSignature
// ---------------------------------------------------------------------------

describe('verifyHmacSignature — generic HMAC', () => {
  const SECRET = 'generic-webhook-secret-s0meth1ng-l0ng'
  const BODY = JSON.stringify({ event: 'bounce', email: 'dead@example.com' })

  function signBody(secret: string, body: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('base64')
  }

  it('verifies a correctly-signed body', () => {
    const sig = signBody(SECRET, BODY)
    expect(verifyHmacSignature(SECRET, BODY, sig)).toBe(true)
  })

  it('rejects a signature with wrong secret', () => {
    const sig = signBody('wrong-secret', BODY)
    expect(verifyHmacSignature(SECRET, BODY, sig)).toBe(false)
  })

  it('rejects a signature over a different body', () => {
    const sig = signBody(SECRET, 'different body')
    expect(verifyHmacSignature(SECRET, BODY, sig)).toBe(false)
  })

  it('rejects when signature is empty', () => {
    expect(verifyHmacSignature(SECRET, BODY, '')).toBe(false)
  })

  it('rejects when secret is empty', () => {
    expect(verifyHmacSignature('', BODY, 'whatever')).toBe(false)
  })

  it('rejects when signature is not valid base64 (length mismatch)', () => {
    expect(verifyHmacSignature(SECRET, BODY, 'short')).toBe(false)
  })

  it('works with Buffer body', () => {
    const body = Buffer.from(BODY, 'utf8')
    const sig = signBody(SECRET, BODY)
    expect(verifyHmacSignature(SECRET, body, sig)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shouldSkipSnsVerifyForTests
// ---------------------------------------------------------------------------

describe('shouldSkipSnsVerifyForTests', () => {
  const origNodeEnv = process.env.NODE_ENV
  const origSkip = process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY

  function restore() {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = origNodeEnv
    if (origSkip === undefined) delete process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY
    else process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY = origSkip
  }

  it('is false by default (no env flag)', () => {
    delete process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY
    process.env.NODE_ENV = 'test'
    try {
      expect(shouldSkipSnsVerifyForTests()).toBe(false)
    } finally {
      restore()
    }
  })

  it('is true when flag set AND NODE_ENV != production', () => {
    process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY = '1'
    process.env.NODE_ENV = 'test'
    try {
      expect(shouldSkipSnsVerifyForTests()).toBe(true)
    } finally {
      restore()
    }
  })

  it('is FALSE even with flag set when NODE_ENV=production (prod override)', () => {
    process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY = '1'
    process.env.NODE_ENV = 'production'
    try {
      expect(shouldSkipSnsVerifyForTests()).toBe(false)
    } finally {
      restore()
    }
  })
})
