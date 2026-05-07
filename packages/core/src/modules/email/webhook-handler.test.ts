/**
 * Unit tests for email/webhook-handler.ts — paths that do not touch DB.
 *
 * End-to-end DB integration (matchDelivery → persistEmailEvents →
 * persistSuppressions → finalizeAuditMatch → bounced_at update) is covered
 * in `scripts/smoke-phase14-pr4b.ts` against a live gbox_platform DB.
 *
 * What's testable here:
 *   1. confirmSnsSubscription — SSRF rejection branches (no network I/O
 *      needed; the allowlist check fires before https.get).
 *   2. handleSnsWebhook — envelope paths that return before any DB call:
 *      - SubscriptionConfirmation → subscribe_confirm
 *      - UnsubscribeConfirmation → subscribe_confirm
 *      - SubscriptionConfirmation missing SubscribeURL → missing_field
 *      - Unknown envelope Type → parse_failed
 *   3. handleGenericWebhook — pre-DB validation:
 *      - missing secret → missing_secret
 *      - bad HMAC → signature_invalid
 *
 * Why a Proxy DB: we guarantee the tested path touches zero DB by passing
 * a Kysely-shaped object whose every property access throws. If the code
 * ever grows a DB call on one of these branches, the test fails loudly
 * rather than silently swallowing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { SnsEnvelope } from './webhook-verify.js'
import {
  confirmSnsSubscription,
  handleGenericWebhook,
  handleSnsWebhook,
} from './webhook-handler.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A DB that screams if touched. Used to verify no-DB paths stay no-DB.
 */
const noDb: Kysely<Database> = new Proxy({} as Kysely<Database>, {
  get(_target, prop) {
    throw new Error(
      `DB should not be touched on this code path — tried to access "${String(prop)}"`,
    )
  },
})

/**
 * A CertFetcher that screams if called. Used to verify that the skip-verify
 * branch short-circuits before any network I/O.
 */
const noFetcher = {
  async fetchCert(_url: string): Promise<string> {
    throw new Error('CertFetcher should not be called when verify is skipped')
  },
}

function subscriptionConfirmation(overrides: Partial<SnsEnvelope> = {}): SnsEnvelope {
  return {
    Type: 'SubscriptionConfirmation',
    MessageId: 'msg-confirm-001',
    Timestamp: '2026-04-22T12:00:00.000Z',
    TopicArn: 'arn:aws:sns:us-east-1:111111111111:gbox-email-bounces',
    SignatureVersion: '1',
    Signature: 'placeholder-sig',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    Message: 'You have chosen to subscribe to...',
    SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc',
    Token: 'abc',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// confirmSnsSubscription — SSRF defense (no network)
// ---------------------------------------------------------------------------

describe('confirmSnsSubscription — rejects before opening a socket', () => {
  const originalAllowlist = process.env.EMAIL_WEBHOOK_SNS_CERT_HOST_ALLOWLIST

  afterEach(() => {
    if (originalAllowlist === undefined) {
      delete process.env.EMAIL_WEBHOOK_SNS_CERT_HOST_ALLOWLIST
    } else {
      process.env.EMAIL_WEBHOOK_SNS_CERT_HOST_ALLOWLIST = originalAllowlist
    }
  })

  it('rejects plain HTTP URLs', async () => {
    const r = await confirmSnsSubscription('http://sns.us-east-1.amazonaws.com/?X=1', 1_000)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
  })

  it('rejects file:// URLs', async () => {
    const r = await confirmSnsSubscription('file:///etc/passwd', 1_000)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
  })

  it('rejects HTTPS URLs that do not match the allowlist suffix', async () => {
    const r = await confirmSnsSubscription('https://evil.example.com/subscribe', 1_000)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
  })

  it('rejects amazonaws.com lookalikes', async () => {
    const r = await confirmSnsSubscription('https://amazonaws.com.evil.com/subscribe', 1_000)
    expect(r.ok).toBe(false)
  })

  it('rejects invalid URLs', async () => {
    const r = await confirmSnsSubscription('not a url', 1_000)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
  })

  it('rejects empty URL', async () => {
    const r = await confirmSnsSubscription('', 1_000)
    expect(r.ok).toBe(false)
  })

  it('honors custom allowlist env — rejects default amazonaws.com when not in list', async () => {
    process.env.EMAIL_WEBHOOK_SNS_CERT_HOST_ALLOWLIST = '.my-proxy.internal'
    const r = await confirmSnsSubscription('https://sns.us-east-1.amazonaws.com/?X=1', 1_000)
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// handleSnsWebhook — envelope paths that never reach the DB
// ---------------------------------------------------------------------------

describe('handleSnsWebhook — SubscriptionConfirmation routing (skipVerify)', () => {
  const originalSkip = process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    // Bypass signature verification so we can test envelope dispatch without
    // generating an RSA keypair. NODE_ENV=test (vitest default) means
    // shouldSkipSnsVerifyForTests returns true when EMAIL_WEBHOOK_SKIP_SNS_VERIFY='1'.
    process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY = '1'
  })

  afterEach(() => {
    if (originalSkip === undefined) delete process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY
    else process.env.EMAIL_WEBHOOK_SKIP_SNS_VERIFY = originalSkip
    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv
  })

  it('returns subscribe_confirm for a valid SubscriptionConfirmation', async () => {
    const r = await handleSnsWebhook(noDb, {
      envelope: subscriptionConfirmation(),
      certFetcher: noFetcher,
    })
    expect(r.ok).toBe(true)
    if (r.ok && r.outcome === 'subscribe_confirm') {
      expect(r.subscribeUrl).toMatch(/^https:\/\/sns\.us-east-1\.amazonaws\.com\//)
    } else {
      throw new Error(`expected subscribe_confirm, got ${JSON.stringify(r)}`)
    }
  })

  it('returns subscribe_confirm for UnsubscribeConfirmation', async () => {
    const r = await handleSnsWebhook(noDb, {
      envelope: subscriptionConfirmation({
        Type: 'UnsubscribeConfirmation',
        MessageId: 'msg-unsub-002',
      }),
      certFetcher: noFetcher,
    })
    expect(r.ok).toBe(true)
    if (r.ok && r.outcome === 'subscribe_confirm') {
      expect(r.subscribeUrl).toBeTruthy()
    } else {
      throw new Error(`expected subscribe_confirm, got ${JSON.stringify(r)}`)
    }
  })

  it('returns missing_field when SubscribeURL is absent', async () => {
    const envelope = subscriptionConfirmation()
    delete (envelope as Partial<SnsEnvelope>).SubscribeURL
    const r = await handleSnsWebhook(noDb, {
      envelope: envelope as SnsEnvelope,
      certFetcher: noFetcher,
    })
    expect(r).toEqual({ ok: false, reason: 'missing_field' })
  })

  it('returns parse_failed for unknown envelope Type', async () => {
    const r = await handleSnsWebhook(noDb, {
      envelope: {
        ...subscriptionConfirmation(),
        // Cast through unknown — the type system tries to protect us here,
        // but we're exercising a runtime branch for defense in depth.
        Type: 'Mystery' as unknown as SnsEnvelope['Type'],
      },
      certFetcher: noFetcher,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('parse_failed')
    }
  })
})

// ---------------------------------------------------------------------------
// handleGenericWebhook — pre-DB validation
// ---------------------------------------------------------------------------

describe('handleGenericWebhook — fails fast before DB', () => {
  it('rejects missing secret', async () => {
    const r = await handleGenericWebhook(noDb, {
      rawBody: '{"hello":"world"}',
      signatureBase64: 'any-sig',
      secret: '',
      shopIdHint: null,
    })
    expect(r).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('rejects bad HMAC signature', async () => {
    const r = await handleGenericWebhook(noDb, {
      rawBody: '{"notificationType":"Bounce"}',
      signatureBase64: 'not-the-right-signature',
      secret: 'some-secret',
      shopIdHint: null,
    })
    expect(r).toEqual({ ok: false, reason: 'signature_invalid' })
  })

  it('rejects empty signature', async () => {
    const r = await handleGenericWebhook(noDb, {
      rawBody: '{}',
      signatureBase64: '',
      secret: 'some-secret',
      shopIdHint: null,
    })
    expect(r).toEqual({ ok: false, reason: 'signature_invalid' })
  })
})
