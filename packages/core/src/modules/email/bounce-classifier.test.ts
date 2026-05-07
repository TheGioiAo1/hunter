/**
 * Unit tests for email/bounce-classifier.ts
 *
 * Fixtures use the real SES notification shape documented at
 * https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html
 */

import { describe, expect, it } from 'vitest'
import { classifySesMessage } from './bounce-classifier.js'

// ---------------------------------------------------------------------------
// Fixtures — real SES notification shapes (trimmed to essentials)
// ---------------------------------------------------------------------------

function permanentBounce(overrides: Partial<any> = {}): any {
  return {
    notificationType: 'Bounce',
    mail: {
      timestamp: '2026-04-22T12:00:00.000Z',
      messageId: 'ses-permanent-bounce-msg-001',
      source: 'noreply@gbox.co',
      destination: ['dead@example.com'],
    },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [
        {
          emailAddress: 'dead@example.com',
          action: 'failed',
          status: '5.1.1',
          diagnosticCode: 'smtp; 550 5.1.1 user unknown',
        },
      ],
      timestamp: '2026-04-22T12:00:01.234Z',
      feedbackId: 'feedback-permanent-001',
      ...overrides,
    },
  }
}

function transientBounce(subType = 'General'): any {
  return {
    notificationType: 'Bounce',
    mail: {
      timestamp: '2026-04-22T12:00:00.000Z',
      messageId: 'ses-transient-bounce-msg-002',
      source: 'noreply@gbox.co',
      destination: ['full@example.com'],
    },
    bounce: {
      bounceType: 'Transient',
      bounceSubType: subType,
      bouncedRecipients: [
        {
          emailAddress: 'full@example.com',
          action: 'delayed',
          status: '4.2.2',
          diagnosticCode: 'smtp; 452 4.2.2 Mailbox full',
        },
      ],
      timestamp: '2026-04-22T12:00:01.234Z',
      feedbackId: 'feedback-transient-002',
    },
  }
}

function undeterminedBounce(): any {
  return {
    notificationType: 'Bounce',
    mail: {
      timestamp: '2026-04-22T12:00:00.000Z',
      messageId: 'ses-undetermined-bounce-msg-003',
      source: 'noreply@gbox.co',
      destination: ['mystery@example.com'],
    },
    bounce: {
      bounceType: 'Undetermined',
      bounceSubType: 'Undetermined',
      bouncedRecipients: [
        { emailAddress: 'mystery@example.com', action: 'failed' },
      ],
      timestamp: '2026-04-22T12:00:01.234Z',
    },
  }
}

function complaint(): any {
  return {
    notificationType: 'Complaint',
    mail: {
      timestamp: '2026-04-22T12:00:00.000Z',
      messageId: 'ses-complaint-msg-004',
      source: 'noreply@gbox.co',
      destination: ['angry@example.com'],
    },
    complaint: {
      complainedRecipients: [{ emailAddress: 'angry@example.com' }],
      complaintFeedbackType: 'abuse',
      timestamp: '2026-04-22T12:00:05.000Z',
      feedbackId: 'feedback-complaint-004',
    },
  }
}

function delivery(): any {
  return {
    notificationType: 'Delivery',
    mail: {
      timestamp: '2026-04-22T12:00:00.000Z',
      messageId: 'ses-delivery-msg-005',
      source: 'noreply@gbox.co',
      destination: ['happy@example.com'],
    },
    delivery: {
      timestamp: '2026-04-22T12:00:02.345Z',
      processingTimeMillis: 2345,
      recipients: ['happy@example.com'],
      smtpResponse: '250 2.6.0 ok',
      reportingMTA: 'a7-32.smtp-out.amazonses.com',
    },
  }
}

// ---------------------------------------------------------------------------
// classifySesMessage — happy paths
// ---------------------------------------------------------------------------

describe('classifySesMessage — Permanent bounce', () => {
  it('classifies as hard + suppress=true', () => {
    const out = classifySesMessage(permanentBounce())
    expect(out.kind).toBe('hard')
    expect(out.suppress).toBe(true)
    expect(out.suppressionReason).toBe('hard_bounce')
    expect(out.eventType).toBe('bounce')
    expect(out.eventBounceType).toBe('hard')
    expect(out.bounceType).toBe('Permanent')
    expect(out.bounceSubType).toBe('General')
    expect(out.sesMessageId).toBe('ses-permanent-bounce-msg-001')
  })

  it('extracts recipient + diagnostic code', () => {
    const out = classifySesMessage(permanentBounce())
    expect(out.recipients).toHaveLength(1)
    expect(out.recipients[0].email).toBe('dead@example.com')
    expect(out.recipients[0].emailLower).toBe('dead@example.com')
    expect(out.recipients[0].status).toBe('5.1.1')
    expect(out.recipients[0].diagnosticCode).toContain('550 5.1.1')
  })

  it('lowercases mixed-case recipient', () => {
    const raw = permanentBounce()
    raw.bounce.bouncedRecipients[0].emailAddress = 'Dead@EXAMPLE.COM'
    const out = classifySesMessage(raw)
    expect(out.recipients[0].email).toBe('Dead@EXAMPLE.COM')      // preserved for display
    expect(out.recipients[0].emailLower).toBe('dead@example.com')  // normalized for hash
  })

  it('handles multiple bounced recipients', () => {
    const raw = permanentBounce()
    raw.bounce.bouncedRecipients.push({
      emailAddress: 'second@example.com',
      action: 'failed',
      status: '5.1.1',
      diagnosticCode: 'smtp; 550 5.1.1 also unknown',
    })
    const out = classifySesMessage(raw)
    expect(out.recipients).toHaveLength(2)
    expect(out.recipients.map((r) => r.email)).toContain('second@example.com')
  })
})

describe('classifySesMessage — Transient bounce', () => {
  it('classifies as soft + suppress=false (General)', () => {
    const out = classifySesMessage(transientBounce('General'))
    expect(out.kind).toBe('soft')
    expect(out.suppress).toBe(false)
    expect(out.suppressionReason).toBeNull()
    expect(out.eventBounceType).toBe('soft')
  })

  it('classifies MailboxFull as soft (no suppress)', () => {
    const out = classifySesMessage(transientBounce('MailboxFull'))
    expect(out.kind).toBe('soft')
    expect(out.suppress).toBe(false)
    expect(out.bounceSubType).toBe('MailboxFull')
  })

  it('classifies AttachmentRejected as soft', () => {
    const out = classifySesMessage(transientBounce('AttachmentRejected'))
    expect(out.kind).toBe('soft')
    expect(out.suppress).toBe(false)
  })
})

describe('classifySesMessage — Undetermined bounce', () => {
  it('classifies conservatively as soft (no suppress)', () => {
    const out = classifySesMessage(undeterminedBounce())
    expect(out.kind).toBe('soft')
    expect(out.suppress).toBe(false)
    expect(out.bounceType).toBe('Undetermined')
    // eventBounceType = 'transient' for Undetermined specifically (distinct audit signal)
    expect(out.eventBounceType).toBe('transient')
  })
})

describe('classifySesMessage — Complaint', () => {
  it('classifies as complaint + suppress=true', () => {
    const out = classifySesMessage(complaint())
    expect(out.kind).toBe('complaint')
    expect(out.suppress).toBe(true)
    expect(out.suppressionReason).toBe('complaint')
    expect(out.eventType).toBe('complaint')
    expect(out.bounceType).toBeNull()
    expect(out.bounceSubType).toBe('abuse')
    expect(out.sesMessageId).toBe('ses-complaint-msg-004')
  })

  it('extracts complained recipient', () => {
    const out = classifySesMessage(complaint())
    expect(out.recipients).toHaveLength(1)
    expect(out.recipients[0].email).toBe('angry@example.com')
  })
})

describe('classifySesMessage — Delivery', () => {
  it('classifies as delivery + suppress=false', () => {
    const out = classifySesMessage(delivery())
    expect(out.kind).toBe('delivery')
    expect(out.suppress).toBe(false)
    expect(out.suppressionReason).toBeNull()
    expect(out.eventType).toBe('delivered')
    expect(out.eventBounceType).toBeNull()
  })

  it('extracts recipients from string array', () => {
    const out = classifySesMessage(delivery())
    expect(out.recipients.map((r) => r.email)).toEqual(['happy@example.com'])
  })
})

// ---------------------------------------------------------------------------
// classifySesMessage — input variants
// ---------------------------------------------------------------------------

describe('classifySesMessage — input handling', () => {
  it('accepts JSON-string input (SNS wire format)', () => {
    const json = JSON.stringify(permanentBounce())
    const out = classifySesMessage(json)
    expect(out.kind).toBe('hard')
  })

  it('accepts object input (pre-parsed)', () => {
    const out = classifySesMessage(permanentBounce())
    expect(out.kind).toBe('hard')
  })

  it('returns unknown on invalid JSON', () => {
    const out = classifySesMessage('not valid json {')
    expect(out.kind).toBe('unknown')
    expect(out.suppress).toBe(false)
  })

  it('returns unknown on null', () => {
    const out = classifySesMessage(null)
    expect(out.kind).toBe('unknown')
  })

  it('returns unknown on number', () => {
    const out = classifySesMessage(42 as any)
    expect(out.kind).toBe('unknown')
  })

  it('returns unknown on empty string', () => {
    const out = classifySesMessage('')
    expect(out.kind).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// classifySesMessage — malformed payloads
// ---------------------------------------------------------------------------

describe('classifySesMessage — malformed payloads', () => {
  it('returns unknown on notificationType mismatch', () => {
    const out = classifySesMessage({
      notificationType: 'SomethingNew',
      mail: { messageId: 'abc' },
    })
    expect(out.kind).toBe('unknown')
    expect(out.sesMessageId).toBe('abc')
  })

  it('returns unknown when Bounce payload missing bounce object', () => {
    const out = classifySesMessage({
      notificationType: 'Bounce',
      mail: { messageId: 'abc' },
    })
    expect(out.kind).toBe('unknown')
  })

  it('returns unknown+structured fallback when bounceType is unexpected', () => {
    const out = classifySesMessage({
      notificationType: 'Bounce',
      mail: { messageId: 'abc' },
      bounce: {
        bounceType: 'MysteriousNewType',
        bounceSubType: 'Whatever',
        bouncedRecipients: [{ emailAddress: 'x@y.com' }],
      },
    })
    expect(out.kind).toBe('unknown')
    expect(out.eventType).toBe('bounce')  // still a bounce-ish event
    expect(out.eventBounceType).toBeNull() // but we don't know how to classify
    expect(out.suppress).toBe(false)
    expect(out.recipients).toHaveLength(1)
  })

  it('tolerates missing bouncedRecipients array', () => {
    const out = classifySesMessage({
      notificationType: 'Bounce',
      mail: { messageId: 'abc' },
      bounce: { bounceType: 'Permanent', bounceSubType: 'General' },
    })
    expect(out.kind).toBe('hard')
    expect(out.recipients).toEqual([])
  })

  it('tolerates malformed recipient entries (non-object)', () => {
    const out = classifySesMessage({
      notificationType: 'Bounce',
      mail: { messageId: 'abc' },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: ['just a string', null, { emailAddress: 'ok@example.com' }, { /* no email */ }],
      },
    })
    expect(out.recipients).toHaveLength(1)
    expect(out.recipients[0].email).toBe('ok@example.com')
  })

  it('tolerates missing mail object', () => {
    const out = classifySesMessage({
      notificationType: 'Bounce',
      bounce: { bounceType: 'Permanent', bounceSubType: 'General' },
    })
    expect(out.kind).toBe('hard')
    expect(out.sesMessageId).toBeNull()
  })

  it('tolerates missing messageId in mail', () => {
    const out = classifySesMessage({
      notificationType: 'Bounce',
      mail: { source: 'x@y.com' },
      bounce: { bounceType: 'Permanent', bounceSubType: 'General' },
    })
    expect(out.sesMessageId).toBeNull()
  })
})
