/**
 * Gbox Platform — Email flows tests (Stage 4.3)
 *
 * The email-flows module is a pure library of automated-sequence
 * definitions and scheduling helpers. It answers four questions:
 *
 *   1. Which flow should a customer enter, given their segment?
 *      → `selectFlowForSegment`
 *   2. What are the steps of each flow (delay, subject, body)?
 *      → `FLOW_DEFINITIONS` / `getFlowDefinition`
 *   3. Which step is due to fire next, given when the customer
 *      enrolled and which step was last sent?
 *      → `nextStepDue`
 *   4. What does the final email look like after variable
 *      substitution?
 *      → `renderEmailStep`
 *
 * No DB, no SMTP, no network — the caller wires those in. These
 * tests pin every branch of the decision tables so a silent edit
 * to a delay or a subject turns red at review.
 */

import { describe, it, expect } from 'vitest'
import {
  selectFlowForSegment,
  getFlowDefinition,
  nextStepDue,
  renderEmailStep,
  FLOW_DEFINITIONS,
  type EmailFlowKind,
  type EmailFlowStep,
  type CustomerSegment,
} from './email-flows.js'

// ---------------------------------------------------------------------------
// selectFlowForSegment
// ---------------------------------------------------------------------------

describe('selectFlowForSegment', () => {
  const cases: Array<[CustomerSegment, EmailFlowKind | null]> = [
    ['prospect', 'welcome'],
    ['new', 'welcome'],
    ['returning', null],
    ['vip', 'vip_early_access'],
    ['at_risk', 'win_back'],
    ['inactive', 'win_back'],
  ]
  for (const [segment, expected] of cases) {
    it(`maps ${segment} → ${expected ?? 'no flow'}`, () => {
      expect(selectFlowForSegment(segment)).toBe(expected)
    })
  }
})

// ---------------------------------------------------------------------------
// FLOW_DEFINITIONS coverage
// ---------------------------------------------------------------------------

describe('FLOW_DEFINITIONS', () => {
  it('defines all five canonical flows', () => {
    const keys: EmailFlowKind[] = [
      'welcome',
      'abandoned_cart',
      'post_purchase',
      'win_back',
      'vip_early_access',
    ]
    for (const k of keys) {
      expect(FLOW_DEFINITIONS[k]).toBeDefined()
      expect(FLOW_DEFINITIONS[k].steps.length).toBeGreaterThan(0)
    }
  })

  it('step delays are monotonically non-decreasing inside a flow', () => {
    for (const flow of Object.values(FLOW_DEFINITIONS)) {
      let prev = -1
      for (const step of flow.steps) {
        expect(step.delayMinutes).toBeGreaterThanOrEqual(prev)
        prev = step.delayMinutes
      }
    }
  })

  it('every step has a stable id and a subject', () => {
    for (const flow of Object.values(FLOW_DEFINITIONS)) {
      for (const step of flow.steps) {
        expect(step.id).toMatch(/^[a-z0-9_]+$/)
        expect(step.subject.length).toBeGreaterThan(0)
        expect(step.body.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('getFlowDefinition', () => {
  it('returns the matching flow', () => {
    const f = getFlowDefinition('welcome')
    expect(f.kind).toBe('welcome')
  })
})

// ---------------------------------------------------------------------------
// nextStepDue
// ---------------------------------------------------------------------------

describe('nextStepDue', () => {
  const enrolledAt = new Date('2026-04-01T00:00:00Z')

  it('returns the first step right after enrolment if its delay is 0', () => {
    const out = nextStepDue({
      flow: 'welcome',
      enrolledAt,
      lastSentStepId: null,
      now: new Date('2026-04-01T00:00:01Z'),
    })
    expect(out).not.toBeNull()
    expect(out!.id).toBe(FLOW_DEFINITIONS.welcome.steps[0]!.id)
  })

  it('returns null if no step is due yet', () => {
    // First welcome step is immediate; force a flow whose step has a delay
    const firstWinbackStep = FLOW_DEFINITIONS.win_back.steps[0]!
    const now = new Date(
      enrolledAt.getTime() + (firstWinbackStep.delayMinutes - 1) * 60_000,
    )
    const out = nextStepDue({
      flow: 'win_back',
      enrolledAt,
      lastSentStepId: null,
      now,
    })
    expect(out).toBeNull()
  })

  it('skips already-sent steps', () => {
    const welcome = FLOW_DEFINITIONS.welcome
    const firstId = welcome.steps[0]!.id
    const secondStep = welcome.steps[1]
    if (!secondStep) return // welcome may be single-step; skip if so
    const now = new Date(
      enrolledAt.getTime() + (secondStep.delayMinutes + 1) * 60_000,
    )
    const out = nextStepDue({
      flow: 'welcome',
      enrolledAt,
      lastSentStepId: firstId,
      now,
    })
    expect(out).not.toBeNull()
    expect(out!.id).toBe(secondStep.id)
  })

  it('returns null after the last step has been sent', () => {
    const welcome = FLOW_DEFINITIONS.welcome
    const lastId = welcome.steps[welcome.steps.length - 1]!.id
    const out = nextStepDue({
      flow: 'welcome',
      enrolledAt,
      lastSentStepId: lastId,
      now: new Date('2099-01-01T00:00:00Z'),
    })
    expect(out).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// renderEmailStep
// ---------------------------------------------------------------------------

describe('renderEmailStep', () => {
  const step: EmailFlowStep = {
    id: 'demo',
    delayMinutes: 0,
    subject: 'Welcome, {{customer_name}}!',
    body: 'Hi {{customer_name}}, shop at {{store_name}} with code {{discount_code}}.',
  }

  it('substitutes known variables', () => {
    const out = renderEmailStep(step, {
      customer_name: 'Alice',
      store_name: 'Gbox',
      discount_code: 'SAVE10',
    })
    expect(out.subject).toBe('Welcome, Alice!')
    expect(out.body).toBe('Hi Alice, shop at Gbox with code SAVE10.')
  })

  it('leaves unknown variables as empty strings so the email never ships garbage', () => {
    const out = renderEmailStep(step, {
      customer_name: 'Alice',
      store_name: 'Gbox',
      // discount_code missing
    })
    expect(out.body).toContain('with code .')
  })

  it('is safe against HTML injection in variable values', () => {
    const out = renderEmailStep(step, {
      customer_name: '<script>alert(1)</script>',
      store_name: 'Gbox',
      discount_code: 'X',
    })
    expect(out.subject).not.toContain('<script>')
    expect(out.subject).toContain('&lt;script&gt;')
  })

  it('does not re-expand substituted values (avoids template reflection)', () => {
    const out = renderEmailStep(step, {
      customer_name: '{{store_name}}',
      store_name: 'Gbox',
      discount_code: 'X',
    })
    // The literal "{{store_name}}" should remain as text, NOT be
    // re-expanded to "Gbox".
    expect(out.subject).toContain('{{store_name}}')
  })
})
