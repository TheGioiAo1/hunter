/**
 * Gbox Platform — Support tool: reissue signup OTP.
 *
 * Implements Option C of `docs/ops/stuck-signup-recovery.md`. Used when
 * a seller is wedged at `users.status='pending_verification'`, prefers
 * to keep their original row + audit lineage, and the in-process email
 * stack is known to be working (otherwise prefer Option A — delete +
 * resignup — which is simpler and unblocks them either way).
 *
 * What this script does:
 *
 *   1. Selects the user by email and asserts `status='pending_verification'`.
 *      Refuses to proceed if the user is already 'active' or 'disabled'.
 *
 *   2. Refuses to proceed if the most recent `email_deliveries` row for
 *      that address in the last hour is `status='failed'` with a
 *      `failed_reason` matching the bug-7 transport-misconfig pattern.
 *      That's an infra problem — issuing a fresh OTP won't help; the
 *      operator needs to fix SMTP creds first. Re-run the script after
 *      ops confirms transport is healthy.
 *
 *   3. Generates a fresh 6-digit OTP via `generateOTP()`, hashes it via
 *      `saveOTP()` so the existing OTP-verify flow accepts it, and
 *      sends it through `sendSignupOtpEmail()` — exactly the same path
 *      the in-process signup helper uses, so the operator gets the
 *      same diagnostics as a real signup.
 *
 *   4. Writes an `audit_logs` row with action='support_reissued_signup_otp'
 *      so the trail is preserved alongside the user's original
 *      'signup_started' event.
 *
 * Iron Rule 5: this script is internal tooling. The OTP plaintext is
 * NEVER printed — it goes only into the email body. The script's stdout
 * is safe for support to copy into a ticket; the OTP is not in it.
 *
 * Usage:
 *   npx tsx scripts/support/reissue-signup-otp.ts \
 *     --email seller@example.com \
 *     --ticket SUPPORT-1234 \
 *     [--reason "stuck OTP — Gmail rate limit window"] \
 *     [--dry-run]
 *
 * Run from the gbox-platform repo root on server 1 (the box where DB
 * connectivity + SMTP creds + the `gbox` Postgres role are all wired).
 *
 * Exit codes:
 *   0 — OTP issued + delivery row created (delivery may be 'queued' if
 *       SMTP is slow; the cron janitor will reap zombies after 10 min).
 *   1 — Argument validation failed (missing --email or --ticket).
 *   2 — User not found or not in pending_verification.
 *   3 — Refused due to recent transport-misconfig failure (fix SMTP first).
 *   4 — sendSignupOtpEmail returned ok:false; details printed.
 *   5 — Unexpected exception.
 */

import 'dotenv/config'
import { createDb, destroyDb } from '../../packages/db/src/index.js'
import { generateOTP, saveOTP } from '../../packages/core/src/modules/auth/otp.js'
import { sendSignupOtpEmail } from '../../apps/accounts/src/lib/send-signup-otp.js'

interface CliArgs {
  email: string
  ticket: string
  reason: string
  dryRun: boolean
}

function parseArgs(argv: string[]): CliArgs | string {
  const out: Partial<CliArgs> = { reason: '', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      out.dryRun = true
      continue
    }
    if (arg === '--email') out.email = argv[++i]
    else if (arg === '--ticket') out.ticket = argv[++i]
    else if (arg === '--reason') out.reason = argv[++i]
    else return `Unknown arg: ${arg}`
  }
  if (!out.email) return 'Missing --email'
  if (!out.ticket) return 'Missing --ticket'
  return out as CliArgs
}

const TRANSPORT_MISCONFIG_PATTERN =
  /transport_not_configured|EmailTransportMisconfiguredError|SMTP_HOST|SMTP_USER|SMTP_PASS|EMAIL_TRANSPORT/i

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`reissue-signup-otp: ${parsed}`)
    console.error(
      `Usage: npx tsx scripts/support/reissue-signup-otp.ts --email <addr> --ticket <id> [--reason "..."] [--dry-run]`,
    )
    return 1
  }
  const { email, ticket, reason, dryRun } = parsed
  const operator = process.env.USER ?? process.env.USERNAME ?? 'unknown-operator'

  const db = createDb()
  try {
    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'status', 'created_at'])
      .where('email', '=', email)
      .executeTakeFirst()

    if (!user) {
      console.error(`User not found for email=${email}.`)
      return 2
    }
    if (user.status !== 'pending_verification') {
      console.error(
        `User ${email} is in status='${user.status}', not 'pending_verification'. ` +
          `Use the normal /forgot-password flow if they need a password reset, ` +
          `or contact platform oncall if state is unexpected.`,
      )
      return 2
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const recentFailed = await db
      .selectFrom('email_deliveries')
      .select(['id', 'status', 'failed_reason', 'created_at'])
      .where('recipient_email', '=', email)
      .where('created_at', '>=', oneHourAgo)
      .where('status', '=', 'failed')
      .orderBy('created_at', 'desc')
      .executeTakeFirst()

    if (
      recentFailed?.failed_reason &&
      TRANSPORT_MISCONFIG_PATTERN.test(recentFailed.failed_reason)
    ) {
      console.error(
        `Refusing to issue: a recent send to ${email} failed with a ` +
          `transport-config error (${recentFailed.failed_reason}). ` +
          `Issuing a fresh OTP will fail the same way. Fix SMTP creds + ` +
          `restart gbox-accounts (see docs/ops/accounts-service-deployment.md), ` +
          `then re-run this script.`,
      )
      return 3
    }

    if (dryRun) {
      console.log(
        `[dry-run] Would reissue OTP for user.id=${user.id} email=${email}. ` +
          `Most recent failed delivery in last hour: ${
            recentFailed
              ? `${recentFailed.status} (${recentFailed.failed_reason ?? '-'})`
              : 'none'
          }.`,
      )
      return 0
    }

    const otp = await generateOTP()
    await saveOTP(db, user.id, otp)

    const sendResult = await sendSignupOtpEmail(db, {
      email,
      otp,
      userId: user.id,
      // resendNumber namespaced under 'support' so the idempotency key
      // can't collide with a real user-driven resend (which uses
      // 1-based numeric counters from `signup.ts`).
      resendNumber: -Math.floor(Date.now() / 1000),
    })

    await db
      .insertInto('audit_logs')
      .values({
        action: 'support_reissued_signup_otp',
        user_id: user.id,
        resource_type: 'auth',
        resource_id: user.id,
        details: JSON.stringify({
          reason: reason || 'support reissue (no reason given)',
          operator,
          ticket,
          email,
          delivery_ok: sendResult.ok,
          delivery_id: sendResult.deliveryId,
          send_reason: sendResult.ok ? null : sendResult.reason,
        }),
      })
      .execute()

    if (!sendResult.ok) {
      console.error(
        `OTP saved to user row, but send failed: reason=${sendResult.reason} ` +
          `error=${sendResult.error ?? '-'} delivery_id=${sendResult.deliveryId ?? '-'}. ` +
          `Audit row written. Investigate; re-run after SMTP is healthy.`,
      )
      return 4
    }

    console.log(
      `OK: reissued OTP for user.id=${user.id} email=${email} ` +
        `(delivery_id=${sendResult.deliveryId}, message=${sendResult.messageId ?? '-'}, ` +
        `provider=${sendResult.provider}). Audit row recorded.`,
    )
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`reissue-signup-otp: unexpected error: ${msg}`)
    return 5
  } finally {
    await destroyDb(db)
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(5)
  },
)
