/**
 * Unit tests for the condition evaluator + JSONB validator
 * (Phase 14 PR3 — commit 4).
 *
 * Coverage target: every op branch + every failure mode of the
 * validator + fail-closed semantics for malformed input.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateCondition,
  validateConditionTree,
  type ConditionNode,
} from './conditions.js'

// ---------------------------------------------------------------------------
// evaluateCondition — happy paths
// ---------------------------------------------------------------------------

describe('evaluateCondition — primitives', () => {
  const ctx = {
    event: { totalPrice: 4995, currency: 'USD' },
    customer: { total_orders: 3, vip: true, email: 'p@t.test' },
  }

  it('returns true when condition is null (match-all)', () => {
    expect(evaluateCondition(null, ctx)).toBe(true)
    expect(evaluateCondition(undefined, ctx)).toBe(true)
  })

  it('eq matches deep-path values', () => {
    expect(evaluateCondition({ op: 'eq', field: 'event.currency', value: 'USD' }, ctx)).toBe(true)
    expect(evaluateCondition({ op: 'eq', field: 'event.currency', value: 'EUR' }, ctx)).toBe(false)
  })

  it('neq is eq inverted', () => {
    expect(evaluateCondition({ op: 'neq', field: 'event.currency', value: 'EUR' }, ctx)).toBe(true)
    expect(evaluateCondition({ op: 'neq', field: 'event.currency', value: 'USD' }, ctx)).toBe(false)
  })

  it('gt/gte/lt/lte compare numbers only (non-numbers fail closed)', () => {
    expect(evaluateCondition({ op: 'gt', field: 'event.totalPrice', value: 1000 }, ctx)).toBe(true)
    expect(evaluateCondition({ op: 'gte', field: 'event.totalPrice', value: 4995 }, ctx)).toBe(true)
    expect(evaluateCondition({ op: 'lt', field: 'event.totalPrice', value: 5000 }, ctx)).toBe(true)
    expect(evaluateCondition({ op: 'lte', field: 'event.totalPrice', value: 4995 }, ctx)).toBe(true)
    // Non-number field falls through to false.
    expect(evaluateCondition({ op: 'gt', field: 'customer.email', value: 1 }, ctx)).toBe(false)
  })

  it('truthy/falsy read JS truthiness', () => {
    expect(evaluateCondition({ op: 'truthy', field: 'customer.vip' }, ctx)).toBe(true)
    expect(evaluateCondition({ op: 'falsy', field: 'customer.missing' }, ctx)).toBe(true)
    expect(evaluateCondition({ op: 'falsy', field: 'customer.vip' }, ctx)).toBe(false)
  })

  it('in / not_in test membership', () => {
    const node: ConditionNode = {
      op: 'in',
      field: 'event.currency',
      values: ['USD', 'EUR', 'GBP'],
    }
    expect(evaluateCondition(node, ctx)).toBe(true)
    expect(
      evaluateCondition({ op: 'not_in', field: 'event.currency', values: ['EUR'] }, ctx),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

describe('evaluateCondition — combinators', () => {
  const ctx = { customer: { vip: true, total_orders: 5 } }

  it('and requires every child true', () => {
    const node: ConditionNode = {
      op: 'and',
      nodes: [
        { op: 'truthy', field: 'customer.vip' },
        { op: 'gte', field: 'customer.total_orders', value: 3 },
      ],
    }
    expect(evaluateCondition(node, ctx)).toBe(true)
    const failing: ConditionNode = {
      op: 'and',
      nodes: [
        { op: 'truthy', field: 'customer.vip' },
        { op: 'gte', field: 'customer.total_orders', value: 99 },
      ],
    }
    expect(evaluateCondition(failing, ctx)).toBe(false)
  })

  it('or allows any child true', () => {
    const node: ConditionNode = {
      op: 'or',
      nodes: [
        { op: 'gte', field: 'customer.total_orders', value: 99 },
        { op: 'truthy', field: 'customer.vip' },
      ],
    }
    expect(evaluateCondition(node, ctx)).toBe(true)
  })

  it('not inverts a child', () => {
    const node: ConditionNode = {
      op: 'not',
      node: { op: 'truthy', field: 'customer.vip' },
    }
    expect(evaluateCondition(node, ctx)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dot-path edge cases
// ---------------------------------------------------------------------------

describe('evaluateCondition — field dereferencing', () => {
  it('missing intermediate path returns undefined → falsy', () => {
    expect(
      evaluateCondition({ op: 'truthy', field: 'a.b.c.d' }, {}),
    ).toBe(false)
  })

  it('hitting a primitive mid-path returns undefined', () => {
    expect(
      evaluateCondition(
        { op: 'eq', field: 'customer.email.domain', value: 'gbox.co' },
        { customer: { email: 'p@t.test' } },
      ),
    ).toBe(false)
  })

  it('empty field path returns undefined', () => {
    expect(evaluateCondition({ op: 'truthy', field: '' }, { x: 1 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Date semantics
// ---------------------------------------------------------------------------

describe('evaluateCondition — Date equality', () => {
  it('compares Date objects by timestamp', () => {
    const a = new Date('2026-04-22')
    const b = new Date('2026-04-22')
    const c = new Date('2026-04-23')
    expect(
      evaluateCondition(
        { op: 'eq', field: 'd', value: b },
        { d: a },
      ),
    ).toBe(true)
    expect(
      evaluateCondition(
        { op: 'eq', field: 'd', value: c },
        { d: a },
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fail-closed semantics
// ---------------------------------------------------------------------------

describe('evaluateCondition — fail-closed', () => {
  it('unknown op returns false', () => {
    expect(
      evaluateCondition(
        { op: 'regex', field: 'customer.email', value: '.*' } as unknown as ConditionNode,
        { customer: { email: 'a@b.test' } },
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// validateConditionTree
// ---------------------------------------------------------------------------

describe('validateConditionTree', () => {
  it('accepts null / undefined (empty tree)', () => {
    expect(validateConditionTree(null)).toBeNull()
    expect(validateConditionTree(undefined)).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(validateConditionTree('not an object')).toMatch(/object/)
    expect(validateConditionTree(123)).toMatch(/object/)
  })

  it('rejects missing op', () => {
    expect(validateConditionTree({ field: 'x', value: 1 })).toMatch(/"op"/)
  })

  it('rejects malformed and/or/not', () => {
    expect(validateConditionTree({ op: 'and', nodes: 'oops' })).toMatch(/nodes/)
    expect(validateConditionTree({ op: 'or' })).toMatch(/nodes/)
    expect(validateConditionTree({ op: 'not' })).toMatch(/object/)
  })

  it('rejects non-numeric value for gt/gte/lt/lte', () => {
    expect(validateConditionTree({ op: 'gt', field: 'x', value: 'big' })).toMatch(/numeric/)
    expect(validateConditionTree({ op: 'gte', field: 'x', value: NaN })).toMatch(/numeric/)
  })

  it('accepts valid trees', () => {
    expect(
      validateConditionTree({
        op: 'and',
        nodes: [
          { op: 'gte', field: 'event.totalPrice', value: 500 },
          { op: 'eq', field: 'event.currency', value: 'USD' },
        ],
      }),
    ).toBeNull()
  })

  it('rejects deeply-nested trees (DoS guard)', () => {
    // Build a pathological tree 10 deep.
    let node: unknown = { op: 'truthy', field: 'x' }
    for (let i = 0; i < 10; i++) node = { op: 'not', node }
    expect(validateConditionTree(node)).toMatch(/deep/)
  })

  it('rejects unknown ops at validation time', () => {
    expect(validateConditionTree({ op: 'regex', field: 'x', value: '.*' })).toMatch(/unknown/)
  })
})
