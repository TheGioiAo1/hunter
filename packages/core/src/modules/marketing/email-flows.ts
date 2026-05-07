/**
 * Gbox Platform — Email flow engine (Stage 4.3)
 *
 * A pure library of automated-sequence definitions and scheduling
 * helpers. This module answers four questions and nothing else:
 *
 *   1. Which flow should a customer enter, given their segment?
 *      → `selectFlowForSegment(segment)`
 *   2. What are the steps of each flow (delay, subject, body)?
 *      → `FLOW_DEFINITIONS` / `getFlowDefinition(kind)`
 *   3. Which step is due to fire next, given when the customer
 *      enrolled and which step was last sent?
 *      → `nextStepDue({ flow, enrolledAt, lastSentStepId, now })`
 *   4. What does the final email look like after variable
 *      substitution?
 *      → `renderEmailStep(step, vars)`
 *
 * The caller (a future email worker) is responsible for:
 *   • persisting enrolments and last-sent step IDs
 *   • actually calling SMTP / SendGrid / Resend
 *   • unsubscribe handling
 *
 * We intentionally stay off the network here so this module is
 * trivially testable and Cloudflare-Workers-friendly.
 */

import type { CustomerSegment } from './segments.js'
export type { CustomerSegment }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailFlowKind =
  | 'welcome'
  | 'abandoned_cart'
  | 'post_purchase'
  | 'win_back'
  | 'vip_early_access'

export interface EmailFlowStep {
  /** Stable machine id — used to track which step was last sent. */
  id: string
  /**
   * Delay from enrolment before this step fires. The delay is
   * measured from the ENROLMENT timestamp, not from the previous
   * step, because that's how the caller actually stores the data
   * (one row per enrolment, plus `lastSentStepId`).
   */
  delayMinutes: number
  /** Mustache-style template — `{{var}}` tokens are substituted. */
  subject: string
  /** Mustache-style template — `{{var}}` tokens are substituted. */
  body: string
}

export interface EmailFlow {
  kind: EmailFlowKind
  /** Human-readable label for the admin UI. */
  label: string
  /** One-line description merchant can read before enabling. */
  description: string
  steps: EmailFlowStep[]
}

// ---------------------------------------------------------------------------
// Flow definitions
// ---------------------------------------------------------------------------

/**
 * Canonical flow definitions. Delays are deliberately conservative
 * — "24h after cart" beats "1h after cart" for deliverability and
 * doesn't feel like spam. Merchants can override these in a future
 * settings UI, but the defaults here are what ships if they do
 * nothing.
 */
export const FLOW_DEFINITIONS: Record<EmailFlowKind, EmailFlow> = {
  welcome: {
    kind: 'welcome',
    label: 'Welcome series',
    description:
      'Introduces new customers to the store and offers a first-order discount.',
    steps: [
      {
        id: 'welcome_1_intro',
        delayMinutes: 0,
        subject: 'Welcome to {{store_name}}, {{customer_name}}!',
        body:
          'Hi {{customer_name}},\n\nThanks for joining {{store_name}}. ' +
          'Here\'s 10% off your first order: {{discount_code}}\n\n— The {{store_name}} team',
      },
      {
        id: 'welcome_2_bestsellers',
        delayMinutes: 60 * 24 * 3, // 3 days
        subject: 'Our bestsellers, picked for you',
        body:
          'Hi {{customer_name}},\n\nIn case you missed it, these are the ' +
          'items our customers love most at {{store_name}}. Your 10% code ' +
          '{{discount_code}} still works.\n\n— The {{store_name}} team',
      },
    ],
  },

  abandoned_cart: {
    kind: 'abandoned_cart',
    label: 'Abandoned cart recovery',
    description:
      'Reminds shoppers about items left in their cart and sweetens the deal if they still hesitate.',
    steps: [
      {
        id: 'cart_1_reminder',
        delayMinutes: 60, // 1h
        subject: 'You left something behind at {{store_name}}',
        body:
          'Hi {{customer_name}},\n\nYour cart is still here: {{cart_url}}\n\n' +
          '— The {{store_name}} team',
      },
      {
        id: 'cart_2_discount',
        delayMinutes: 60 * 24, // 24h
        subject: 'Still thinking? Here\'s 10% off',
        body:
          'Hi {{customer_name}},\n\nWe saved your cart at {{store_name}}. ' +
          'Use {{discount_code}} at checkout: {{cart_url}}\n\n' +
          '— The {{store_name}} team',
      },
      {
        id: 'cart_3_last_call',
        delayMinutes: 60 * 24 * 3, // 3d
        subject: 'Last chance on your cart',
        body:
          'Hi {{customer_name}},\n\nYour cart expires soon. Finish at ' +
          '{{cart_url}} with code {{discount_code}}.\n\n— {{store_name}}',
      },
    ],
  },

  post_purchase: {
    kind: 'post_purchase',
    label: 'Post-purchase follow-up',
    description:
      'Thanks the customer, asks for a review, and suggests complementary products.',
    steps: [
      {
        id: 'post_1_thankyou',
        delayMinutes: 60, // 1h
        subject: 'Thanks for your order, {{customer_name}}!',
        body:
          'Hi {{customer_name}},\n\nWe\'re packing your order. You\'ll get ' +
          'a shipping email next.\n\n— {{store_name}}',
      },
      {
        id: 'post_2_review',
        delayMinutes: 60 * 24 * 7, // 7d
        subject: 'How did we do?',
        body:
          'Hi {{customer_name}},\n\nIf you loved {{product_title}}, would ' +
          'you mind leaving a quick review? It really helps small shops ' +
          'like {{store_name}}.\n\n— {{store_name}}',
      },
      {
        id: 'post_3_cross_sell',
        delayMinutes: 60 * 24 * 14, // 14d
        subject: 'You might also like...',
        body:
          'Hi {{customer_name}},\n\nBased on your last order, we think ' +
          'you\'ll like these. Use {{discount_code}} for 10% off your next ' +
          'order at {{store_name}}.\n\n— {{store_name}}',
      },
    ],
  },

  win_back: {
    kind: 'win_back',
    label: 'Win-back series',
    description:
      'Re-engages at-risk and inactive customers with a strong incentive to return.',
    steps: [
      {
        id: 'winback_1_miss',
        delayMinutes: 60 * 24, // 1d after enrolment
        subject: 'We miss you at {{store_name}}',
        body:
          'Hi {{customer_name}},\n\nIt\'s been a while. Here\'s 15% off ' +
          'to welcome you back: {{discount_code}}\n\n— {{store_name}}',
      },
      {
        id: 'winback_2_last_call',
        delayMinutes: 60 * 24 * 7, // 7d
        subject: 'Last call — {{discount_code}} expires soon',
        body:
          'Hi {{customer_name}},\n\nYour 15% off code {{discount_code}} ' +
          'expires in 48 hours. Shop {{store_name}} before it\'s gone.\n\n' +
          '— {{store_name}}',
      },
    ],
  },

  vip_early_access: {
    kind: 'vip_early_access',
    label: 'VIP early access',
    description:
      'Announces new drops and sales to VIP customers before everyone else.',
    steps: [
      {
        id: 'vip_1_welcome',
        delayMinutes: 0,
        subject: 'You\'re a VIP at {{store_name}} 🌟',
        body:
          'Hi {{customer_name}},\n\nAs a VIP, you get early access to ' +
          'every drop and a standing 15% discount: {{discount_code}}\n\n' +
          '— {{store_name}}',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// selectFlowForSegment
// ---------------------------------------------------------------------------

/**
 * Pure mapping from segment → flow. `returning` is intentionally
 * `null` — a happy repeat buyer doesn't need a scheduled sequence,
 * only the broadcast newsletter.
 */
export function selectFlowForSegment(
  segment: CustomerSegment,
): EmailFlowKind | null {
  switch (segment) {
    case 'prospect':
      return 'welcome'
    case 'new':
      return 'welcome'
    case 'vip':
      return 'vip_early_access'
    case 'at_risk':
      return 'win_back'
    case 'inactive':
      return 'win_back'
    case 'returning':
      return null
    default:
      return null
  }
}

export function getFlowDefinition(kind: EmailFlowKind): EmailFlow {
  return FLOW_DEFINITIONS[kind]
}

// ---------------------------------------------------------------------------
// nextStepDue
// ---------------------------------------------------------------------------

export interface NextStepDueInput {
  flow: EmailFlowKind
  enrolledAt: Date
  /** The `id` of the step we already sent, or `null` for none. */
  lastSentStepId: string | null
  now: Date
}

/**
 * Returns the next step that is due to fire, or `null` if no step
 * is ready (either the flow has no more steps, or the next step's
 * delay has not yet elapsed).
 *
 * Delays are computed from `enrolledAt`, NOT from the previous
 * step's send time. This matches how the caller stores state (one
 * row per enrolment + `lastSentStepId`) and is simpler to reason
 * about — the schedule is a function of enrolment, not send
 * history.
 */
export function nextStepDue(input: NextStepDueInput): EmailFlowStep | null {
  const flow = FLOW_DEFINITIONS[input.flow]
  if (!flow) return null

  const elapsedMinutes =
    (input.now.getTime() - input.enrolledAt.getTime()) / 60_000
  if (elapsedMinutes < 0) return null

  const lastIdx = input.lastSentStepId
    ? flow.steps.findIndex((s) => s.id === input.lastSentStepId)
    : -1

  for (let i = lastIdx + 1; i < flow.steps.length; i++) {
    const step = flow.steps[i]!
    if (elapsedMinutes >= step.delayMinutes) {
      return step
    }
    // steps are monotonically delayed; the first un-due step means
    // all subsequent ones are also un-due.
    return null
  }
  return null
}

// ---------------------------------------------------------------------------
// renderEmailStep
// ---------------------------------------------------------------------------

export type EmailRenderVars = Record<string, string | undefined>

export interface RenderedEmail {
  subject: string
  body: string
}

/**
 * Substitute `{{var}}` tokens in the step's subject and body with
 * values from `vars`. Unknown variables become empty strings so
 * the rendered output never leaks raw `{{discount_code}}` to a
 * customer's inbox.
 *
 * HTML-entity-escapes every substituted value so a hostile
 * `customer_name` can never smuggle a `<script>` tag into a
 * rendered email. The template text itself is trusted (it's owned
 * by the merchant / platform), only the variables are escaped.
 *
 * The implementation uses a single-pass regex replacer so a value
 * that happens to contain `{{store_name}}` is NOT re-expanded —
 * that would make the template engine reflective and exploitable.
 */
export function renderEmailStep(
  step: EmailFlowStep,
  vars: EmailRenderVars,
): RenderedEmail {
  return {
    subject: interpolate(step.subject, vars),
    body: interpolate(step.body, vars),
  }
}

function interpolate(template: string, vars: EmailRenderVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const raw = vars[key]
    if (raw === undefined || raw === null) return ''
    return escapeHtml(String(raw))
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
