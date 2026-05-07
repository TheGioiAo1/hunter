/**
 * Gbox Platform — signup OTP helper tests (Phase 14 PR8 big-bang fix)
 *
 * Covers bugs 1–4 of the email-system 10-bug list:
 *   Bug 1 — SMTP_GBOX_URL not configured: no longer relevant (we no longer
 *           depend on the external relay).
 *   Bug 2 — signup bypassed `@gbox/core/modules/email`: the new helper
 *           funnels through `sendTemplatedEmail` from core.
 *   Bug 3 — silent `[OTP-FALLBACK]` plaintext log: must NEVER appear
 *           regardless of success / failure.
 *   Bug 4 — `sendSignupOtpEmail()` return value ignored: helper now returns
 *           a typed, structured result so the caller can branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Freeze the captured log lines for bug 3 assertions.
const capturedLogs: string[] = []
let originalConsoleLog: typeof console.log
let originalConsoleError: typeof console.error

beforeEach(() => {
  capturedLogs.length = 0
  originalConsoleLog = console.log
  originalConsoleError = console.error
  console.log = (...args: unknown[]) => {
    capturedLogs.push(['log', ...args.map(String)].join(' '))
  }
  console.error = (...args: unknown[]) => {
    capturedLogs.push(['err', ...args.map(String)].join(' '))
  }
})

// Mock the core email module. The helper under test is supposed to call
// `sendTemplatedEmail(db, { templateKey: 'email_verify_otp', ... })`.
const sendTemplatedEmailMock = vi.fn()
vi.mock('@gbox/core/modules/email/send.js', () => ({
  sendTemplatedEmail: (db: unknown, input: unknown) => sendTemplatedEmailMock(db, input),
}))

// Import AFTER vi.mock so the helper picks up the stub.
import { sendSignupOtpEmail } from './send-signup-otp.js'

describe('sendSignupOtpEmail (bugs 1-4)', () => {
  beforeEach(() => {
    sendTemplatedEmailMock.mockReset()
    // Restore console each test to prevent cross-test bleed if a test forgets.
    if (originalConsoleLog) console.log = originalConsoleLog
    if (originalConsoleError) console.error = originalConsoleError
  })

  it('calls sendTemplatedEmail with email_verify_otp template + correct variables', async () => {
    sendTemplatedEmailMock.mockResolvedValueOnce({
      ok: true,
      deliveryId: 42,
      messageId: '<smtp-msg-id>',
      provider: 'gmail_smtp',
    })

    const db = { __fakeDb: true } as unknown as Parameters<typeof sendSignupOtpEmail>[0]
    const result = await sendSignupOtpEmail(db, {
      email: 'jane@example.com',
      otp: '123456',
      userId: 'user-uuid',
    })

    expect(sendTemplatedEmailMock).toHaveBeenCalledTimes(1)
    const [passedDb, payload] = sendTemplatedEmailMock.mock.calls[0]
    expect(passedDb).toBe(db)
    expect(payload).toMatchObject({
      templateKey: 'email_verify_otp',
      to: 'jane@example.com',
      shopId: null, // signup is pre-shop, must be platform-scoped
      variables: {
        otp_code: '123456',
        expires_minutes: 10,
      },
      idempotencyKey: 'signup:user-uuid',
      recipientUserId: 'user-uuid',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.deliveryId).toBe(42)
      expect(result.messageId).toBe('<smtp-msg-id>')
      expect(result.provider).toBe('gmail_smtp')
    }
  })

  it('uses a resend-scoped idempotency key when resendNumber is provided', async () => {
    sendTemplatedEmailMock.mockResolvedValueOnce({
      ok: true,
      deliveryId: 43,
      messageId: null,
      provider: 'gmail_smtp',
    })
    const db = {} as unknown as Parameters<typeof sendSignupOtpEmail>[0]
    await sendSignupOtpEmail(db, {
      email: 'jane@example.com',
      otp: '234567',
      userId: 'user-uuid',
      resendNumber: 2,
    })
    const payload = sendTemplatedEmailMock.mock.calls[0][1]
    expect(payload.idempotencyKey).toBe('signup:user-uuid:resend-2')
  })

  it('Bug 4: surfaces a failure result so the caller can branch', async () => {
    sendTemplatedEmailMock.mockResolvedValueOnce({
      ok: false,
      deliveryId: null,
      reason: 'transport_failed',
      error: 'SMTP 421 temporary reject',
    })
    const db = {} as unknown as Parameters<typeof sendSignupOtpEmail>[0]
    const result = await sendSignupOtpEmail(db, {
      email: 'jane@example.com',
      otp: '234567',
      userId: 'user-uuid',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('transport_failed')
    }
  })

  it('Bug 3: NEVER logs the plaintext OTP to stdout, even on failure', async () => {
    sendTemplatedEmailMock.mockResolvedValueOnce({
      ok: false,
      deliveryId: null,
      reason: 'db_write_failed',
      error: 'connection refused',
    })

    // Re-hook console spies for THIS test.
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      capturedLogs.push(['log', ...args.map(String)].join(' '))
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      capturedLogs.push(['err', ...args.map(String)].join(' '))
    })

    try {
      const db = {} as unknown as Parameters<typeof sendSignupOtpEmail>[0]
      await sendSignupOtpEmail(db, {
        email: 'jane@example.com',
        otp: 'SEKRETT',
        userId: 'user-uuid',
      })

      const joined = capturedLogs.join('\n')
      expect(joined).not.toMatch(/OTP-FALLBACK/i)
      expect(joined).not.toContain('SEKRETT')
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('Bug 2: never throws even when core send throws (no-throw contract)', async () => {
    sendTemplatedEmailMock.mockRejectedValueOnce(new Error('kaboom'))
    const db = {} as unknown as Parameters<typeof sendSignupOtpEmail>[0]
    const result = await sendSignupOtpEmail(db, {
      email: 'jane@example.com',
      otp: '123456',
      userId: 'user-uuid',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Internal throws map to db_write_failed (mirrors core module contract).
      expect(result.reason).toBe('db_write_failed')
      expect(result.error).toContain('kaboom')
    }
  })

  it('Bug 2: recipientUserId is passed through so deliveries table links to the user', async () => {
    sendTemplatedEmailMock.mockResolvedValueOnce({
      ok: true,
      deliveryId: 44,
      messageId: 'x',
      provider: 'gmail_smtp',
    })
    const db = {} as unknown as Parameters<typeof sendSignupOtpEmail>[0]
    await sendSignupOtpEmail(db, {
      email: 'jane@example.com',
      otp: '234567',
      userId: 'the-user-id',
    })
    const payload = sendTemplatedEmailMock.mock.calls[0][1]
    expect(payload.recipientUserId).toBe('the-user-id')
  })
})
