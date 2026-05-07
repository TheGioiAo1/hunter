/**
 * Gbox Platform — Customer Segments Rule Engine Unit Tests
 *
 * Covers:
 *   - validateRuleSet:
 *       combinator whitelist
 *       empty rules rejection
 *       max-rules cap
 *       unknown field rejection
 *       disallowed op rejection
 *       value coercion (string / tags / number / timestamp / boolean)
 *       value-less ops (is_set / is_not_set)
 *   - SEGMENT_FIELD_SAFELIST shape invariants
 */

import { describe, it, expect } from 'vitest'
import {
  validateRuleSet,
  SEGMENT_FIELD_SAFELIST,
  SEGMENT_FIELD_NAMES,
  MAX_RULES_PER_SEGMENT,
} from './rules.js'

// ---------------------------------------------------------------------------
// SEGMENT_FIELD_SAFELIST shape
// ---------------------------------------------------------------------------

describe('SEGMENT_FIELD_SAFELIST', () => {
  it('exposes at least the six Phase 4 plan fields', () => {
    for (const f of [
      'email',
      'phone',
      'tags',
      'total_spent',
      'orders_count',
      'created_at',
    ]) {
      expect(SEGMENT_FIELD_NAMES).toContain(f)
    }
  })

  it('every field has at least one allowed op', () => {
    for (const name of SEGMENT_FIELD_NAMES) {
      expect(SEGMENT_FIELD_SAFELIST[name]!.ops.length).toBeGreaterThan(0)
    }
  })

  it('every field has a human label', () => {
    for (const name of SEGMENT_FIELD_NAMES) {
      const label = SEGMENT_FIELD_SAFELIST[name]!.label
      expect(typeof label).toBe('string')
      expect(label.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// validateRuleSet — structural
// ---------------------------------------------------------------------------

describe('validateRuleSet — structure', () => {
  it('rejects non-object input', () => {
    expect(() => validateRuleSet(null)).toThrow()
    expect(() => validateRuleSet('{}')).toThrow()
    expect(() => validateRuleSet(42)).toThrow()
    expect(() => validateRuleSet([])).toThrow()
  })

  it('rejects unknown combinator', () => {
    expect(() =>
      validateRuleSet({ combinator: 'xor', rules: [] }),
    ).toThrow(/combinator/i)
  })

  it('rejects non-array rules', () => {
    expect(() =>
      validateRuleSet({ combinator: 'and', rules: 'nope' }),
    ).toThrow(/array/i)
  })

  it('rejects empty rules', () => {
    expect(() =>
      validateRuleSet({ combinator: 'and', rules: [] }),
    ).toThrow(/at least one rule/i)
  })

  it('rejects more than MAX_RULES_PER_SEGMENT rules', () => {
    const rules = Array.from({ length: MAX_RULES_PER_SEGMENT + 1 }, () => ({
      field: 'email',
      op: 'is_set',
    }))
    expect(() => validateRuleSet({ combinator: 'and', rules })).toThrow(
      /at most/i,
    )
  })

  it('rejects a rule that is not an object', () => {
    expect(() =>
      validateRuleSet({ combinator: 'and', rules: ['oops'] }),
    ).toThrow(/Rule 1/i)
  })
})

// ---------------------------------------------------------------------------
// validateRuleSet — safelist enforcement
// ---------------------------------------------------------------------------

describe('validateRuleSet — safelist', () => {
  it('rejects an unknown field', () => {
    expect(() =>
      validateRuleSet({
        combinator: 'and',
        rules: [{ field: 'password_hash', op: 'equals', value: 'x' }],
      }),
    ).toThrow(/unknown field/i)
  })

  it('rejects a disallowed op for the field type', () => {
    // numeric op on a string field
    expect(() =>
      validateRuleSet({
        combinator: 'and',
        rules: [{ field: 'email', op: 'greater_than', value: 'x' }],
      }),
    ).toThrow(/not allowed/i)
  })

  it('accepts the happy path', () => {
    const out = validateRuleSet({
      combinator: 'and',
      rules: [
        { field: 'email', op: 'contains', value: '@gbox.co' },
        { field: 'total_spent', op: 'greater_than', value: 100 },
      ],
    })
    expect(out.combinator).toBe('and')
    expect(out.rules).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// validateRuleSet — value coercion
// ---------------------------------------------------------------------------

describe('validateRuleSet — value coercion', () => {
  it('trims string values and rejects empty strings', () => {
    const out = validateRuleSet({
      combinator: 'and',
      rules: [{ field: 'email', op: 'contains', value: '   hello   ' }],
    })
    expect(out.rules[0]!.value).toBe('hello')

    expect(() =>
      validateRuleSet({
        combinator: 'and',
        rules: [{ field: 'email', op: 'contains', value: '   ' }],
      }),
    ).toThrow(/value must not be empty/i)
  })

  it('rejects a missing value when the op requires one', () => {
    expect(() =>
      validateRuleSet({
        combinator: 'and',
        rules: [{ field: 'email', op: 'equals' }],
      }),
    ).toThrow(/value is required/i)
  })

  it('allows value-less ops is_set / is_not_set', () => {
    const out = validateRuleSet({
      combinator: 'or',
      rules: [
        { field: 'email', op: 'is_set' },
        { field: 'phone', op: 'is_not_set' },
      ],
    })
    expect(out.rules[0]!.value).toBeNull()
    expect(out.rules[1]!.value).toBeNull()
  })

  it('coerces numeric strings to numbers', () => {
    const out = validateRuleSet({
      combinator: 'and',
      rules: [{ field: 'orders_count', op: 'greater_than', value: '3' }],
    })
    expect(out.rules[0]!.value).toBe(3)
  })

  it('rejects non-numeric values for numeric fields', () => {
    expect(() =>
      validateRuleSet({
        combinator: 'and',
        rules: [
          { field: 'orders_count', op: 'greater_than', value: 'lots' },
        ],
      }),
    ).toThrow(/number/i)
  })

  it('normalises timestamps to ISO', () => {
    const out = validateRuleSet({
      combinator: 'and',
      rules: [{ field: 'created_at', op: 'after', value: '2026-01-01' }],
    })
    const iso = out.rules[0]!.value as string
    expect(iso.startsWith('2026-01-01')).toBe(true)
  })

  it('rejects invalid timestamps', () => {
    expect(() =>
      validateRuleSet({
        combinator: 'and',
        rules: [
          { field: 'created_at', op: 'after', value: 'not-a-date' },
        ],
      }),
    ).toThrow(/invalid date/i)
  })

  it('coerces common truthy / falsy strings for booleans', () => {
    const t = validateRuleSet({
      combinator: 'and',
      rules: [
        { field: 'accepts_marketing', op: 'equals', value: 'true' },
      ],
    })
    expect(t.rules[0]!.value).toBe(true)

    const f = validateRuleSet({
      combinator: 'and',
      rules: [
        { field: 'accepts_marketing', op: 'equals', value: '0' },
      ],
    })
    expect(f.rules[0]!.value).toBe(false)
  })
})
