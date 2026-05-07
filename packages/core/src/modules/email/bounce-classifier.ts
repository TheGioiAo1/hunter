/**
 * Gbox Platform — SES bounce/complaint classifier (Phase 14 PR4.B)
 *
 * Parses the inner SES message body (which lives inside
 * SnsEnvelope.Message as a JSON string) and classifies it into
 * Gbox-native event kinds. The webhook handler uses the output to
 * decide whether to suppress, which email_events rows to write, and
 * which recipients were affected.
 *
 * REFERENCE
 * ---------
 * Amazon SES notification contents (bounce, complaint, delivery):
 * https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html
 *
 * Pure function — no DB, no side effects. Unit-testable with fixtures.
 *
 * CLASSIFICATION MATRIX
 * ---------------------
 * | SES notificationType | bounceType    | bounceSubType   | Gbox kind | suppress |
 * |----------------------|---------------|-----------------|-----------|----------|
 * | Bounce               | Permanent     | any             | hard      | true     |
 * | Bounce               | Transient     | any             | soft      | false    |
 * | Bounce               | Undetermined  | any             | soft      | false    |
 * | Complaint            | —             | —               | complaint | true     |
 * | Delivery             | —             | —               | delivery  | false    |
 * | (other / unparsable) | —             | —               | unknown   | false    |
 *
 * Conservative stance on Undetermined: AWS says "we couldn't tell" —
 * we treat it as transient (don't suppress). If a specific recipient
 * keeps bouncing as Undetermined, the PR5 soft-bounce aggregator will
 * roll them up to a hard suppression after N strikes.
 *
 * IRON RULE 5
 * -----------
 * No god_admin mentions. Classifier returns structured data only;
 * no string messages suitable for UI display.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClassifiedKind = 'hard' | 'soft' | 'complaint' | 'delivery' | 'unknown'
export type SuppressionReason = 'hard_bounce' | 'complaint'

export interface ClassifiedRecipient {
  email: string
  emailLower: string
  diagnosticCode: string | null
  status: string | null
}

export interface ClassifiedEvent {
  kind: ClassifiedKind
  /** Gbox suppression reason if `suppress=true`, else null. */
  suppressionReason: SuppressionReason | null
  /** Did the event trigger a suppression? */
  suppress: boolean
  /** Raw SES bounceType (Permanent/Transient/Undetermined) for audit, null for non-bounces. */
  bounceType: string | null
  /** Raw SES bounceSubType (General/NoEmail/MailboxFull/...), null for non-bounces. */
  bounceSubType: string | null
  /** SES mail.messageId — matches email_deliveries.smtp_message_id. */
  sesMessageId: string | null
  /** Recipients this event applies to. */
  recipients: ClassifiedRecipient[]
  /** Human-readable event type (maps to email_events.event_type). */
  eventType: 'bounce' | 'complaint' | 'delivered' | null
  /** email_events.bounce_type column value (null for non-bounces or soft). */
  eventBounceType: 'hard' | 'soft' | 'transient' | null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the outer SES notification. `sesMessageBody` is the raw
 * string from SnsEnvelope.Message (which SES pre-serialized). We parse
 * it here so the caller doesn't need to know about SES internals.
 *
 * Returns `kind: 'unknown'` on parse failure rather than throwing —
 * the caller should still persist the raw payload to
 * ses_webhook_events for forensics even if we can't classify.
 */
export function classifySesMessage(sesMessageBody: unknown): ClassifiedEvent {
  let parsed: any
  try {
    if (typeof sesMessageBody === 'string') {
      parsed = JSON.parse(sesMessageBody)
    } else if (typeof sesMessageBody === 'object' && sesMessageBody !== null) {
      parsed = sesMessageBody
    } else {
      return unknownResult()
    }
  } catch {
    return unknownResult()
  }

  const notificationType = typeof parsed.notificationType === 'string' ? parsed.notificationType : null
  const sesMessageId = extractSesMessageId(parsed)

  if (notificationType === 'Bounce' && typeof parsed.bounce === 'object' && parsed.bounce !== null) {
    return classifyBounce(parsed.bounce, sesMessageId)
  }
  if (notificationType === 'Complaint' && typeof parsed.complaint === 'object' && parsed.complaint !== null) {
    return classifyComplaint(parsed.complaint, sesMessageId)
  }
  if (notificationType === 'Delivery' && typeof parsed.delivery === 'object' && parsed.delivery !== null) {
    return classifyDelivery(parsed.delivery, sesMessageId)
  }
  return unknownResult(sesMessageId)
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function unknownResult(sesMessageId: string | null = null): ClassifiedEvent {
  return {
    kind: 'unknown',
    suppressionReason: null,
    suppress: false,
    bounceType: null,
    bounceSubType: null,
    sesMessageId,
    recipients: [],
    eventType: null,
    eventBounceType: null,
  }
}

function extractSesMessageId(parsed: any): string | null {
  if (parsed && typeof parsed === 'object' && parsed.mail && typeof parsed.mail === 'object') {
    const mid = parsed.mail.messageId
    if (typeof mid === 'string' && mid.length > 0) return mid
  }
  return null
}

function classifyBounce(bounce: any, sesMessageId: string | null): ClassifiedEvent {
  const bounceType = typeof bounce.bounceType === 'string' ? bounce.bounceType : null
  const bounceSubType = typeof bounce.bounceSubType === 'string' ? bounce.bounceSubType : null
  const recipients = parseBouncedRecipients(bounce.bouncedRecipients)

  // Permanent → hard → suppress
  if (bounceType === 'Permanent') {
    return {
      kind: 'hard',
      suppressionReason: 'hard_bounce',
      suppress: true,
      bounceType,
      bounceSubType,
      sesMessageId,
      recipients,
      eventType: 'bounce',
      eventBounceType: 'hard',
    }
  }

  // Transient → soft → NO suppress (PR5 will aggregate repeat soft bounces)
  if (bounceType === 'Transient') {
    return {
      kind: 'soft',
      suppressionReason: null,
      suppress: false,
      bounceType,
      bounceSubType,
      sesMessageId,
      recipients,
      eventType: 'bounce',
      eventBounceType: 'soft',
    }
  }

  // Undetermined → conservative soft
  if (bounceType === 'Undetermined') {
    return {
      kind: 'soft',
      suppressionReason: null,
      suppress: false,
      bounceType,
      bounceSubType,
      sesMessageId,
      recipients,
      eventType: 'bounce',
      eventBounceType: 'transient',
    }
  }

  // Unknown bounceType (SES invented a new value, or missing)
  return {
    kind: 'unknown',
    suppressionReason: null,
    suppress: false,
    bounceType,
    bounceSubType,
    sesMessageId,
    recipients,
    eventType: 'bounce',
    eventBounceType: null,
  }
}

function classifyComplaint(complaint: any, sesMessageId: string | null): ClassifiedEvent {
  const recipients = parseComplainedRecipients(complaint.complainedRecipients)
  return {
    kind: 'complaint',
    suppressionReason: 'complaint',
    suppress: true,
    bounceType: null,
    bounceSubType: typeof complaint.complaintFeedbackType === 'string'
      ? complaint.complaintFeedbackType
      : null,
    sesMessageId,
    recipients,
    eventType: 'complaint',
    eventBounceType: null,
  }
}

function classifyDelivery(delivery: any, sesMessageId: string | null): ClassifiedEvent {
  const recipients = parseDeliveryRecipients(delivery.recipients)
  return {
    kind: 'delivery',
    suppressionReason: null,
    suppress: false,
    bounceType: null,
    bounceSubType: null,
    sesMessageId,
    recipients,
    eventType: 'delivered',
    eventBounceType: null,
  }
}

// ---------------------------------------------------------------------------
// Recipient parsers
// ---------------------------------------------------------------------------

function parseBouncedRecipients(raw: unknown): ClassifiedRecipient[] {
  if (!Array.isArray(raw)) return []
  const out: ClassifiedRecipient[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const email = typeof (r as any).emailAddress === 'string' ? (r as any).emailAddress : null
    if (!email) continue
    out.push({
      email,
      emailLower: email.toLowerCase(),
      diagnosticCode: typeof (r as any).diagnosticCode === 'string' ? (r as any).diagnosticCode : null,
      status: typeof (r as any).status === 'string' ? (r as any).status : null,
    })
  }
  return out
}

function parseComplainedRecipients(raw: unknown): ClassifiedRecipient[] {
  if (!Array.isArray(raw)) return []
  const out: ClassifiedRecipient[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const email = typeof (r as any).emailAddress === 'string' ? (r as any).emailAddress : null
    if (!email) continue
    out.push({
      email,
      emailLower: email.toLowerCase(),
      diagnosticCode: null,
      status: null,
    })
  }
  return out
}

function parseDeliveryRecipients(raw: unknown): ClassifiedRecipient[] {
  // SES Delivery format: recipients is array of strings, not objects
  if (!Array.isArray(raw)) return []
  const out: ClassifiedRecipient[] = []
  for (const r of raw) {
    if (typeof r !== 'string' || r.length === 0) continue
    out.push({
      email: r,
      emailLower: r.toLowerCase(),
      diagnosticCode: null,
      status: null,
    })
  }
  return out
}
