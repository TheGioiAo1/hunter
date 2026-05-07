/**
 * Gbox Platform — Cluster C bug 8 unit tests.
 *
 * Before PR8, `beginDeliveryIdempotent` only SELECTed `id` on the
 * fast-path, so when the caller saw `inserted: false` it assumed the
 * previous attempt had succeeded. That was a lie for rows where the
 * prior status was 'queued' (zombie: crash between INSERT + send),
 * 'failed' (SMTP error), or 'skipped_*' (preference / suppression).
 *
 * The fast-path now reads status + smtp_message_id + provider +
 * failed_reason, and this pure classifier maps the prior row into the
 * exact `SendTemplatedEmailResult` shape the caller should return. The
 * symptom this used to cause: second signup OTP resend ran with the
 * same idempotency key as a prior failed send, user got `ok: true` but
 * no email arrived because nothing actually went to SMTP.
 */
import { describe, it, expect } from 'vitest'
import { resolveIdempotentPriorRow } from './send.js'

describe('resolveIdempotentPriorRow (bug 8)', () => {
  it('status=sent → ok:true with real messageId + provider', () => {
    const result = resolveIdempotentPriorRow({
      id: 42,
      status: 'sent',
      smtp_message_id: '<abc-123@gmail.com>',
      provider: 'gmail_smtp',
      failed_reason: null,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.deliveryId).toBe(42)
      expect(result.messageId).toBe('<abc-123@gmail.com>')
      expect(result.provider).toBe('gmail_smtp')
    }
  })

  it('status=sent with null provider → falls back to "other"', () => {
    // Historical rows from before the provider column was always set.
    const result = resolveIdempotentPriorRow({
      id: 43,
      status: 'sent',
      smtp_message_id: null,
      provider: null,
      failed_reason: null,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.provider).toBe('other')
      expect(result.messageId).toBeNull()
    }
  })

  it('status=failed → ok:false reason=transport_failed (regression guard)', () => {
    // Pre-bug-8: returned ok:true here — the caller would tell the user
    // the email was sent when the prior SMTP attempt actually blew up.
    const result = resolveIdempotentPriorRow({
      id: 44,
      status: 'failed',
      smtp_message_id: null,
      provider: 'gmail_smtp',
      failed_reason: 'SMTP 421 temporary reject',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.deliveryId).toBe(44)
      expect(result.reason).toBe('transport_failed')
      expect(result.error).toBe('SMTP 421 temporary reject')
    }
  })

  it('status=failed with null failed_reason → generic error string', () => {
    const result = resolveIdempotentPriorRow({
      id: 45,
      status: 'failed',
      smtp_message_id: null,
      provider: null,
      failed_reason: null,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('transport_failed')
      expect(result.error).toMatch(/prior attempt failed/i)
    }
  })

  it('status=queued (zombie) → ok:false with distinct error message', () => {
    // The worst case: prior process crashed between INSERT and markSent.
    // Telling the caller ok:true would be a bald-faced lie.
    const result = resolveIdempotentPriorRow({
      id: 46,
      status: 'queued',
      smtp_message_id: null,
      provider: null,
      failed_reason: null,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('transport_failed')
      expect(result.error).toMatch(/zombie|queued/i)
    }
  })

  it('status=skipped_pref → ok:false reason=skipped_pref (surface the original gate)', () => {
    const result = resolveIdempotentPriorRow({
      id: 47,
      status: 'skipped_pref',
      smtp_message_id: null,
      provider: null,
      failed_reason: 'unsubscribed',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('skipped_pref')
    }
  })

  it('status=skipped_suppressed → ok:false reason=skipped_suppressed', () => {
    const result = resolveIdempotentPriorRow({
      id: 48,
      status: 'skipped_suppressed',
      smtp_message_id: null,
      provider: null,
      failed_reason: 'suppressed:hard_bounce',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('skipped_suppressed')
    }
  })

  it('status=skipped_invalid → ok:false reason=iron_rule_5_blocked (platform-scope mismatch is the dominant case)', () => {
    const result = resolveIdempotentPriorRow({
      id: 49,
      status: 'skipped_invalid',
      smtp_message_id: null,
      provider: null,
      failed_reason: 'platform_scope_mismatch',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('iron_rule_5_blocked')
    }
  })

  it('status=bounced → ok:false reason=transport_failed', () => {
    const result = resolveIdempotentPriorRow({
      id: 50,
      status: 'bounced',
      smtp_message_id: null,
      provider: 'gmail_smtp',
      failed_reason: null,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('transport_failed')
      expect(result.error).toMatch(/bounced/i)
    }
  })

  it('never returns ok:true when prior status is anything other than sent', () => {
    // Regression guard: the whole point of the bug-8 fix.
    const nonSent: Array<
      'failed' | 'queued' | 'skipped_pref' | 'skipped_suppressed' | 'skipped_invalid' | 'bounced'
    > = [
      'failed',
      'queued',
      'skipped_pref',
      'skipped_suppressed',
      'skipped_invalid',
      'bounced',
    ]
    for (const status of nonSent) {
      const result = resolveIdempotentPriorRow({
        id: 1,
        status,
        smtp_message_id: null,
        provider: null,
        failed_reason: null,
      })
      expect(result.ok, `status=${status} must not be ok:true`).toBe(false)
    }
  })
})
