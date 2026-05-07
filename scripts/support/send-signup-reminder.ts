/**
 * Gbox Platform — Support tool: send signup reminder email.
 *
 * Companion to `reissue-signup-otp.ts`. Used after a wedged user has
 * been cleared via Option A of `docs/ops/stuck-signup-recovery.md`
 * (i.e. their `users` row was deleted) — this script invites them to
 * try signing up again. The body is platform-default English so the
 * outreach matches the rest of the Gbox surface; do NOT translate this
 * file into a localized variant without first putting the new locale
 * into a templated registry entry behind shop-locale resolution.
 *
 * What this script does:
 *
 *   1. Refuses to proceed if a `users` row already exists for the
 *      address — never email an active or already-pending account.
 *      That would either annoy a real seller or reveal that an account
 *      exists for that email (account-enumeration risk).
 *
 *   2. Sends a one-off HTML+text email via the legacy `sendEmail()`
 *      nodemailer wrapper (NOT the templated pipeline — this isn't a
 *      transactional template, it's a manual support gesture).
 *
 *   3. Records an `audit_logs` row with action='support_signup_reminder_sent'
 *      so the support trail is preserved.
 *
 * Iron Rule 5: the body never names internal paths, internal services,
 * or "Gbox support" with the slash-separated routing format. It points
 * at the public signup URL and offers a `Reply-To` mailto for help.
 *
 * Usage:
 *   npx tsx scripts/support/send-signup-reminder.ts \
 *     --email seller@example.com \
 *     --ticket SUPPORT-1234 \
 *     [--signup-url https://accounts.gbox.co/signup] \
 *     [--reason "post-PR8 cluster-A unblock — invite back"] \
 *     [--dry-run]
 *
 * Run from the gbox-platform repo root on server 1 (where DB + SMTP
 * creds + the `gbox` Postgres role are wired together).
 *
 * Exit codes:
 *   0 — email sent + audit row written
 *   1 — argument validation failed (missing --email or --ticket)
 *   2 — refused: user row already exists for this email
 *   3 — sendEmail threw (SMTP / transport problem); audit not written
 *   4 — audit_logs insert failed AFTER email was sent (the email is in
 *       flight; this exit is informational so ops knows trail is incomplete)
 *   5 — unexpected exception
 */

import 'dotenv/config'
import { createDb, destroyDb } from '../../packages/db/src/index.js'
import { sendEmail } from '../../packages/core/src/modules/email/service.js'

interface CliArgs {
  email: string
  ticket: string
  signupUrl: string
  reason: string
  dryRun: boolean
}

const DEFAULT_SIGNUP_URL =
  process.env.ACCOUNTS_BASE_URL?.replace(/\/+$/, '') + '/signup' ||
  'https://accounts.gbox.co/signup'

function parseArgs(argv: string[]): CliArgs | string {
  const out: Partial<CliArgs> = {
    reason: '',
    signupUrl: DEFAULT_SIGNUP_URL,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      out.dryRun = true
      continue
    }
    if (arg === '--email') out.email = argv[++i]
    else if (arg === '--ticket') out.ticket = argv[++i]
    else if (arg === '--signup-url') out.signupUrl = argv[++i]
    else if (arg === '--reason') out.reason = argv[++i]
    else return `Unknown arg: ${arg}`
  }
  if (!out.email) return 'Missing --email'
  if (!out.ticket) return 'Missing --ticket'
  return out as CliArgs
}

const SUBJECT = 'Finish creating your Gbox account'

function renderHtml(toEmail: string, signupUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:24px;background:#f5f5f5;color:#111}
  .container{max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  h1{font-size:22px;margin:0 0 12px}
  p{line-height:1.55;color:#374151;margin:12px 0}
  .cta{display:inline-block;margin:24px 0 8px;padding:14px 28px;background:#1e3a8a;color:#fff !important;text-decoration:none;border-radius:8px;font-weight:600}
  .footer{margin-top:32px;color:#9ca3af;font-size:12px}
  a.url{color:#2563eb;word-break:break-all}
</style></head><body><div class="container">
  <h1>Hi there,</h1>
  <p>We noticed you started creating a Gbox account a few days ago but didn't receive the verification code to finish. Sorry for the trouble — our system has been updated and is ready for you.</p>
  <p>Please open the link below to start the signup again. A fresh verification code will be sent to this email address within a minute after you submit the form.</p>
  <p style="text-align:center"><a class="cta" href="${signupUrl}">Finish signing up for Gbox</a></p>
  <p>Or open it directly: <a class="url" href="${signupUrl}">${signupUrl}</a></p>
  <p>If you no longer want to create an account, or this wasn't you, you can safely ignore this email.</p>
  <p>Need help? Just reply to this email and a Gbox support teammate will follow up.</p>
  <div class="footer">Automated message from Gbox · You're receiving this because there was a recent signup attempt with the address ${toEmail}.</div>
</div></body></html>`
}

function renderText(toEmail: string, signupUrl: string): string {
  return `Hi there,

We noticed you started creating a Gbox account a few days ago but didn't receive the verification code to finish. Sorry for the trouble — our system has been updated.

Please open the link below to start the signup again:
${signupUrl}

A fresh verification code will be sent to this email address within a minute after you submit the form.

If you no longer want to create an account, you can safely ignore this email.

Need help? Just reply to this email and a Gbox support teammate will follow up.

— Gbox

(Automated message · sent because of a recent signup attempt with ${toEmail})`
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`send-signup-reminder: ${parsed}`)
    console.error(
      `Usage: npx tsx scripts/support/send-signup-reminder.ts --email <addr> --ticket <id> [--signup-url <url>] [--reason "..."] [--dry-run]`,
    )
    return 1
  }
  const { email, ticket, signupUrl, reason, dryRun } = parsed
  const operator = process.env.USER ?? process.env.USERNAME ?? 'unknown-operator'

  const db = createDb()
  try {
    const existing = await db
      .selectFrom('users')
      .select(['id', 'status'])
      .where('email', '=', email)
      .executeTakeFirst()

    if (existing) {
      console.error(
        `Refusing to send: a users row already exists for ${email} ` +
          `(status='${existing.status}'). Use the normal /forgot-password ` +
          `flow if they need a password reset, or run Option A of ` +
          `docs/ops/stuck-signup-recovery.md first if they're wedged.`,
      )
      return 2
    }

    if (dryRun) {
      console.log(
        `[dry-run] Would email ${email} (signup_url=${signupUrl}, ` +
          `subject="${SUBJECT}").`,
      )
      return 0
    }

    let messageId: string
    try {
      messageId = await sendEmail({
        to: email,
        subject: SUBJECT,
        html: renderHtml(email, signupUrl),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`SMTP send failed for ${email}: ${msg}`)
      return 3
    }

    try {
      await db
        .insertInto('audit_logs')
        .values({
          action: 'support_signup_reminder_sent',
          user_id: null,
          resource_type: 'auth',
          resource_id: null,
          details: JSON.stringify({
            ticket,
            operator,
            recipient: email,
            message_id: messageId,
            signup_url: signupUrl,
            reason: reason || 'support reminder (no reason given)',
          }),
        } as never)
        .execute()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `OK: email sent (smtp_message_id=${messageId}) but audit_logs ` +
          `insert FAILED — ops trail incomplete. Reason: ${msg}`,
      )
      return 4
    }

    console.log(
      `OK: reminder sent to ${email} (smtp_message_id=${messageId}, ` +
        `signup_url=${signupUrl}). Audit row recorded.`,
    )
    return 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`send-signup-reminder: unexpected error: ${msg}`)
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
