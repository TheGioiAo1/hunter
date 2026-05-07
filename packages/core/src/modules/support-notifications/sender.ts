/**
 * Gbox Platform — support notification sender (Phase 12.5 PR5).
 *
 * Single entry point for every support-system notification: SLA breach,
 * CSAT prompt, auto-close warning, new-message ping, @-mention, etc.
 * Callers (the SLA cron, the CSAT cron, the add-message handler, the
 * escalation engine) hand this function:
 *
 *   - the ticket + recipient user
 *   - the notification_type
 *   - a subject + body (pre-rendered plaintext)
 *
 * The sender then:
 *
 *   1. Looks up the user's preferences (`preferences.ts`) and applies
 *      quiet-hours / channel-toggle rules to pick the actual channel
 *      set for THIS specific notification type.
 *
 *   2. For EMAIL dispatch specifically: enforces Q2.10's 1/hour/ticket
 *      rate limit by reading `support_notifications_log` for the most
 *      recent row matching (ticket_id, notification_type, channel='email').
 *      If it's <1h ago, email is skipped (an `status='skipped'` row
 *      still lands in the log so the audit trail is honest).
 *
 *   3. For IN-APP: inserts a row into the existing `notifications` table
 *      (the global bell-icon drawer already knows how to render it).
 *
 *   4. For BROWSER_PUSH: MVP stub — just logs a `status='skipped'` row
 *      with a specific `error` tag so the PR6 follow-up that wires Web
 *      Push can find + retry. Real push delivery is deferred.
 *
 *   5. For EVERY channel attempt (sent or skipped or failed): appends
 *      one row to `support_notifications_log` — this table is the
 *      sole audit source of truth.
 *
 * Iron Rule 5: every error message a seller can see routes through the
 * global `safeMessage()` helper in the support module (we never leak
 * SMTP error text). Agent-facing logs preserve full detail for debug.
 *
 * SMTP errors DO NOT throw from this function (the caller — usually a
 * cron — must continue on to the next ticket). Instead, they land in
 * the log table with `status='failed'` and the error string.
 */

import type { Kysely } from 'kysely'
import type {
  Database,
  SupportNotificationChannel,
  SupportNotificationType,
} from '@gbox/db/schema/tables.js'
import { getNotificationPreferences, pickChannels } from './preferences.ts'
import { sendTemplatedEmail } from '../email/send.ts'

const EMAIL_RATE_LIMIT_MS = 60 * 60 * 1000 // 1 hour

// Notification types that go to a merchant email (shop-scoped delivery).
// All others are agent-internal (platform-scoped, audience='god_admin').
const SELLER_NOTIFICATION_TYPES: ReadonlySet<SupportNotificationType> = new Set([
  'new_message_to_seller',
  'sla_first_response_breach',
  'sla_resolution_breach',
  'csat_prompt',
  'auto_close_warning',
  'auto_close',
])

export interface SendNotificationInput {
  ticketId: string
  notificationType: SupportNotificationType
  recipientUserId: string
  /** Plain-text subject; used as in-app title + email subject. */
  subject: string
  /** Plain-text body; wrapped with minimal HTML for email. */
  body: string
  /** Optional click-through URL for in-app. */
  link?: string | null
  /** Override the now() — tests pass a fixed instant. */
  now?: Date
}

export interface SendNotificationResult {
  /** Number of channels that actually dispatched successfully. */
  sent: number
  /** Number of channels skipped (rate-limited, quiet-hours, etc). */
  skipped: number
  /** Number of channels that errored (SMTP / push provider). */
  failed: number
  /** Per-channel detail for tests + smoke assertions. */
  channels: Array<{
    channel: SupportNotificationChannel
    status: 'sent' | 'skipped' | 'failed'
    reason?: string
  }>
}

/**
 * Deliver a support notification on every enabled channel for the
 * recipient user. Tolerant of SMTP / channel failures (records + moves
 * on — never throws unless DB itself is down).
 */
export async function sendSupportNotification(
  db: Kysely<Database>,
  input: SendNotificationInput,
): Promise<SendNotificationResult> {
  const now = input.now ?? new Date()

  // 1. Load prefs + pick channels for this type.
  const prefs = await getNotificationPreferences(db, input.recipientUserId)
  const channels = pickChannels(prefs, input.notificationType, now)

  const result: SendNotificationResult = {
    sent: 0,
    skipped: 0,
    failed: 0,
    channels: [],
  }

  // Short-circuit if user has silenced all channels for this type.
  if (channels.length === 0) {
    await logRow(db, {
      ticketId: input.ticketId,
      notificationType: input.notificationType,
      recipientUserId: input.recipientUserId,
      recipientEmail: null,
      channel: 'in_app',
      status: 'skipped',
      error: 'user_silenced',
      now,
    })
    result.skipped++
    result.channels.push({
      channel: 'in_app',
      status: 'skipped',
      reason: 'user_silenced',
    })
    return result
  }

  // 2. Resolve recipient email (needed for email + audit denormalisation
  // in every channel row, even in-app — so post-hoc queries can answer
  // "who got this" without a join).
  const recipient = await db
    .selectFrom('users')
    .select(['email'])
    .where('id', '=', input.recipientUserId)
    .executeTakeFirst()
  const recipientEmail = recipient?.email ?? null

  // Resolve shop_id from the ticket for the in-app notifications row.
  const ticket = await db
    .selectFrom('support_tickets')
    .select(['shop_id'])
    .where('id', '=', input.ticketId)
    .executeTakeFirst()
  const shopId = ticket?.shop_id ?? null

  // 3. Dispatch per channel.
  for (const ch of channels) {
    if (ch === 'email') {
      if (!recipientEmail) {
        await logRow(db, {
          ticketId: input.ticketId,
          notificationType: input.notificationType,
          recipientUserId: input.recipientUserId,
          recipientEmail: null,
          channel: 'email',
          status: 'skipped',
          error: 'no_recipient_email',
          now,
        })
        result.skipped++
        result.channels.push({
          channel: 'email',
          status: 'skipped',
          reason: 'no_recipient_email',
        })
        continue
      }

      const recentEmail = await lastEmailSentAt(
        db,
        input.ticketId,
        input.notificationType,
      )
      if (recentEmail && now.getTime() - recentEmail.getTime() < EMAIL_RATE_LIMIT_MS) {
        await logRow(db, {
          ticketId: input.ticketId,
          notificationType: input.notificationType,
          recipientUserId: input.recipientUserId,
          recipientEmail,
          channel: 'email',
          status: 'skipped',
          error: 'rate_limited_1h',
          now,
        })
        result.skipped++
        result.channels.push({
          channel: 'email',
          status: 'skipped',
          reason: 'rate_limited_1h',
        })
        continue
      }

      {
        // Route through sendTemplatedEmail so every support notification
        // lands an audit row in email_deliveries (Phase 14 pipeline).
        // The two envelope templates (support_notification_seller /
        // support_notification_agent) use category='ops' → forced-send,
        // bypassing email_preferences opt-out. The support notification
        // sender's own 1-h/ticket/type rate-limit (checked above via
        // lastEmailSentAt) is the only delivery guard that applies.
        const isSellerNotif = SELLER_NOTIFICATION_TYPES.has(input.notificationType)
        const templateKey = isSellerNotif
          ? 'support_notification_seller'
          : 'support_notification_agent'
        const notifShopId = isSellerNotif ? shopId : null

        const bodyEscaped = escapeHtml(input.body).replace(/\n/g, '<br>')
        const ctaHtml = input.link
          ? `<div class="btn-wrap"><a class="btn" href="${escapeHtml(input.link)}">Open ticket</a></div>`
          : ''
        const ctaText = input.link ? `Open ticket: ${input.link}` : ''

        const emailResult = await sendTemplatedEmail(db, {
          templateKey,
          to: recipientEmail,
          shopId: notifShopId,
          variables: {
            heading: input.subject,
            body_html: bodyEscaped,
            body_text: input.body,
            cta_html: ctaHtml,
            cta_text: ctaText,
            shop_name: 'Gbox Support',
            unsubscribe_html: '',
            unsubscribe_text: '',
          },
          recipientUserId: input.recipientUserId,
        })

        if (emailResult.ok) {
          await logRow(db, {
            ticketId: input.ticketId,
            notificationType: input.notificationType,
            recipientUserId: input.recipientUserId,
            recipientEmail,
            channel: 'email',
            status: 'sent',
            error: null,
            now,
          })
          result.sent++
          result.channels.push({ channel: 'email', status: 'sent' })
        } else {
          const errMsg = emailResult.reason ?? 'send_failed'
          await logRow(db, {
            ticketId: input.ticketId,
            notificationType: input.notificationType,
            recipientUserId: input.recipientUserId,
            recipientEmail,
            channel: 'email',
            status: 'failed',
            error: errMsg.slice(0, 500),
            now,
          })
          result.failed++
          result.channels.push({
            channel: 'email',
            status: 'failed',
            reason: errMsg,
          })
        }
      }
      continue
    }

    if (ch === 'in_app') {
      try {
        if (shopId) {
          await db
            .insertInto('notifications')
            .values({
              shop_id: shopId,
              user_id: input.recipientUserId,
              type: notificationTypeToInApp(input.notificationType),
              title: input.subject,
              message: input.body,
              resource_type: 'support_ticket',
              resource_id: input.ticketId,
              category: 'system',
              link: input.link ?? null,
            } as any)
            .execute()
        }
        await logRow(db, {
          ticketId: input.ticketId,
          notificationType: input.notificationType,
          recipientUserId: input.recipientUserId,
          recipientEmail,
          channel: 'in_app',
          status: 'sent',
          error: null,
          now,
        })
        result.sent++
        result.channels.push({ channel: 'in_app', status: 'sent' })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        await logRow(db, {
          ticketId: input.ticketId,
          notificationType: input.notificationType,
          recipientUserId: input.recipientUserId,
          recipientEmail,
          channel: 'in_app',
          status: 'failed',
          error: errMsg.slice(0, 500),
          now,
        })
        result.failed++
        result.channels.push({
          channel: 'in_app',
          status: 'failed',
          reason: errMsg,
        })
      }
      continue
    }

    if (ch === 'browser_push') {
      // MVP stub — real push delivery lands in PR6.
      await logRow(db, {
        ticketId: input.ticketId,
        notificationType: input.notificationType,
        recipientUserId: input.recipientUserId,
        recipientEmail,
        channel: 'browser_push',
        status: 'skipped',
        error: 'browser_push_mvp_stub',
        now,
      })
      result.skipped++
      result.channels.push({
        channel: 'browser_push',
        status: 'skipped',
        reason: 'browser_push_mvp_stub',
      })
    }
  }

  return result
}

// ── helpers ─────────────────────────────────────────────────────────────

async function lastEmailSentAt(
  db: Kysely<Database>,
  ticketId: string,
  notificationType: SupportNotificationType,
): Promise<Date | null> {
  const row = await db
    .selectFrom('support_notifications_log')
    .select(['sent_at'])
    .where('ticket_id', '=', ticketId)
    .where('notification_type', '=', notificationType)
    .where('channel', '=', 'email')
    .where('status', '=', 'sent')
    .orderBy('sent_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row?.sent_at ? new Date(row.sent_at) : null
}

interface LogRowInput {
  ticketId: string
  notificationType: SupportNotificationType
  recipientUserId: string | null
  recipientEmail: string | null
  channel: SupportNotificationChannel
  status: 'sent' | 'skipped' | 'failed'
  error: string | null
  now: Date
}

async function logRow(
  db: Kysely<Database>,
  input: LogRowInput,
): Promise<void> {
  try {
    await db
      .insertInto('support_notifications_log')
      .values({
        ticket_id: input.ticketId,
        notification_type: input.notificationType,
        recipient_user_id: input.recipientUserId,
        recipient_email: input.recipientEmail,
        channel: input.channel,
        status: input.status,
        error: input.error,
        sent_at: input.now.toISOString(),
      } as any)
      .execute()
  } catch {
    // Logging failure is non-fatal — we'd rather send the notif than
    // abort on an audit row write. Pino log upstream picks it up.
  }
}

/**
 * Map internal notification_type onto the `notifications.type` union
 * used by the in-app drawer. We deliberately avoid adding a new enum
 * literal for every support notification — the global notifications
 * table is a known-finite set and support events bucket as 'system'
 * via category + resource_type = 'support_ticket'.
 */
function notificationTypeToInApp(type: SupportNotificationType): string {
  // `notifications.type` is TEXT not an enum in DB; the core service
  // NotificationType union is for TypeScript only. We can write any
  // string here and the drawer will render under the `system` category.
  return `support_${type}`
}

/**
 * Minimal HTML-escaper used when building `body_html` and `cta_html`
 * variables to pass to `sendTemplatedEmail`. Prevents XSS from ticket
 * subject / body content being rendered in emails.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
