/**
 * Gbox Accounts — Signup OTP Email Sender (Phase 14 PR8)
 *
 * Thin wrapper around `@gbox/core/modules/email/sendTemplatedEmail` to:
 *   - Encapsulate the `email_verify_otp` template wiring (mapping the
 *     otp variable).
 *   - Enforce the `shopId: null` platform-scoped auth (mandated by
 *     the template declared in `registry.ts`).
 *   - `idempotencyKey` is derived from `userId` (+ resendNumber) so
 *     concurrent resends don't fire off duplicate emails.
 *
 * Contract:
 *   - NEVER throws — any internal failure is converted to
 *     `{ ok: false, reason: 'db_write_failed', error }`.
 *   - NEVER logs the plaintext OTP to stdout (security — the prior
 *     `[OTP-FALLBACK]` line was a P0 violation of Iron Rule 1).
 *   - Returns a typed, discriminated-union result so callers MUST
 *     handle the failure branch (compile-time safety).
 *
 * Replaces the HTTP relay shim `apps/accounts/src/lib/smtp-gbox.ts`, which
 * was deleted in the same PR.
 */
import { sendTemplatedEmail } from '@gbox/core/modules/email/send.js'

/** How many minutes before the saved OTP row expires. Mirrors `saveOTP()`. */
const OTP_EXPIRES_MINUTES = 10

export interface SendSignupOtpInput {
  email: string
  otp: string
  userId: string
  /**
   * 1-based resend counter. `undefined` for the initial signup send.
   * Threads into the idempotency key so the second resend can't collide
   * with the first.
   */
  resendNumber?: number
}

export type SendSignupOtpResult =
  | { ok: true; deliveryId: string }
  | {
      ok: false
      reason:
        | 'template_not_found'
        | 'preference_denied'
        | 'transport_error'
        | 'db_write_failed'
      error?: string
    }

function buildIdempotencyKey(userId: string, resendNumber?: number): string {
  return resendNumber !== undefined
    ? `signup:${userId}:resend-${resendNumber}`
    : `signup:${userId}`
}

/**
 * Send the 6-digit signup verification OTP. Pure: only side effects are
 * via core `sendTemplatedEmail`. Never throws.
 */
export async function sendSignupOtpEmail(
  db: any,
  input: SendSignupOtpInput,
): Promise<SendSignupOtpResult> {
  try {
    const result = await sendTemplatedEmail(db, {
      templateKey: 'email_verify_otp',
      to: input.email,
      // Signup happens BEFORE a shop exists. `email_verify_otp` is a
      // god_admin-audience template; the core module enforces shopId=null
      // for platform-owned templates (Iron Rule 5).
      shopId: null,
      variables: {
        otp_code: input.otp,
        expires_minutes: OTP_EXPIRES_MINUTES,
      },
      idempotencyKey: buildIdempotencyKey(input.userId, input.resendNumber),
    })

    if (result.ok) {
      return { ok: true, deliveryId: result.deliveryId }
    }

    // Map core reason codes to signup-specific ones.
    return {
      ok: false,
      reason: result.reason as any,
      error: result.error,
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'db_write_failed',
      error: (err as Error).message,
    }
  }
}
