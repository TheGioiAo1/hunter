/**
 * Gbox Platform — Cluster B bug 7 unit tests.
 *
 * Before: when `resolveTransport()` throws (e.g. NODE_ENV=production + no
 * SMTP creds → EmailTransportMisconfiguredError from Cluster B bug 6, or
 * EMAIL_TRANSPORT=gmail without creds → GmailSmtpTransport ctor throw),
 * the error bubbled up to the outer try/catch in `sendTemplatedEmail`
 * and was misclassified as `reason: 'db_write_failed'`. That gave ops
 * a wild-goose chase (they'd look at the Postgres logs when the real
 * problem was an env var).
 *
 * After: `classifyTransportResolutionError()` deterministically maps any
 * thrown value into `{ reason: 'transport_not_configured', error: <msg> }`,
 * and `sendTemplatedEmailInner` wraps `resolveTransport()` in try/catch
 * so the new reason appears in the return value instead of bubbling.
 *
 * This test covers the pure helper. Integration coverage lives in the
 * phase-14 pr1 smoke script (real DB + real transport env).
 */
import { describe, it, expect } from 'vitest'
import { classifyTransportResolutionError } from './send.js'
import { EmailTransportMisconfiguredError } from './transport.js'

describe('classifyTransportResolutionError (bug 7)', () => {
  it('maps EmailTransportMisconfiguredError to transport_not_configured', () => {
    const err = new EmailTransportMisconfiguredError(
      'Refusing silent console fallback in production.',
    )
    const result = classifyTransportResolutionError(err)
    expect(result.reason).toBe('transport_not_configured')
    expect(result.error).toBe('Refusing silent console fallback in production.')
  })

  it('maps a generic Error (e.g. GmailSmtpTransport ctor throw) to transport_not_configured', () => {
    // This is exactly what `new GmailSmtpTransport()` throws when
    // EMAIL_TRANSPORT=gmail but SMTP_HOST / SMTP_USER / SMTP_PASS are
    // unset — the ctor validates eagerly.
    const err = new Error('GmailSmtpTransport: SMTP_HOST is not set')
    const result = classifyTransportResolutionError(err)
    expect(result.reason).toBe('transport_not_configured')
    expect(result.error).toBe('GmailSmtpTransport: SMTP_HOST is not set')
  })

  it('maps a non-Error thrown value by stringifying it', () => {
    // Defensive: third-party modules sometimes throw non-Error values
    // (strings, plain objects, null). We must not crash on those.
    const result = classifyTransportResolutionError('kaboom')
    expect(result.reason).toBe('transport_not_configured')
    expect(result.error).toBe('kaboom')
  })

  it('never returns reason="db_write_failed" (regression guard)', () => {
    // The whole point of the fix — make sure the classifier never
    // confuses a config error with a DB error.
    const err = new EmailTransportMisconfiguredError('any msg')
    const result = classifyTransportResolutionError(err)
    expect(result.reason).not.toBe('db_write_failed')
  })
})
