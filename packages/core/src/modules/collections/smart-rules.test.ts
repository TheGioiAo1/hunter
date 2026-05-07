/**
 * Smart rules — unit tests (Phase C2)
 *
 * Covers two halves of the module:
 *
 *   1. VALIDATION / CANONICALISATION — pure helpers. Straight table-
 *      driven tests.
 *
 *   2. EVALUATOR — uses a Proxy-based fake Kysely builder that records
 *      the compiled SQL shape instead of actually running it. The
 *      Postgres smoke test for the real SQL lives in the worker test
 *      and runs on server 2 (the Windows dev box can't reach the test
 *      DB — see memory/smoke_test_runbook.md).
 *
 * We don't assert the exact SQL string (Kysely's compiler output has
 * whitespace + param-index quirks that make textual matches brittle).
 * Instead we assert STRUCTURE: how many parts the WHERE clause has,
 * whether it's AND or OR, and which operators the compiler picked.
 */

import { describe, it, expect } from 'vitest'
import {
  canonicaliseRules,
  evaluateSmartRules,
  isRulesNonEmpty,
  isSmartRuleCondition,
  isSmartRules,
  type SmartRules,
} from './smart-rules.js'

// ---------------------------------------------------------------------------
// 1. Validation / canonicalisation
// ---------------------------------------------------------------------------

describe('isSmartRules', () => {
  it('accepts well-formed rules (all mode, text condition)', () => {
    expect(
      isSmartRules({
        match: 'all',
        conditions: [{ field: 'title', op: 'contains', value: 'shirt' }],
      }),
    ).toBe(true)
  })

  it('accepts empty conditions array', () => {
    expect(isSmartRules({ match: 'any', conditions: [] })).toBe(true)
  })

  it('rejects missing match mode', () => {
    expect(isSmartRules({ conditions: [] })).toBe(false)
  })

  it('rejects unknown match mode', () => {
    expect(isSmartRules({ match: 'some', conditions: [] })).toBe(false)
  })

  it('rejects null / non-object / legacy array', () => {
    expect(isSmartRules(null)).toBe(false)
    expect(isSmartRules('nope')).toBe(false)
    expect(isSmartRules([])).toBe(false)
  })
})

describe('isSmartRuleCondition', () => {
  it('accepts text ops on text fields', () => {
    for (const op of [
      'equals', 'not_equals', 'starts_with', 'ends_with', 'contains', 'not_contains',
    ]) {
      expect(
        isSmartRuleCondition({ field: 'title', op, value: 'x' }),
        `text op ${op} should be accepted`,
      ).toBe(true)
    }
  })

  it('accepts numeric ops on numeric fields, with valid number value', () => {
    for (const op of ['greater_than', 'less_than', 'equals', 'not_equals']) {
      expect(
        isSmartRuleCondition({ field: 'price', op, value: '10.50' }),
      ).toBe(true)
      expect(
        isSmartRuleCondition({ field: 'inventory_quantity', op, value: '5' }),
      ).toBe(true)
    }
  })

  it('rejects numeric op with non-numeric value', () => {
    expect(
      isSmartRuleCondition({ field: 'price', op: 'greater_than', value: 'cheap' }),
    ).toBe(false)
  })

  it('rejects text op on numeric field', () => {
    expect(
      isSmartRuleCondition({ field: 'price', op: 'contains', value: '1' }),
    ).toBe(false)
  })

  it('rejects numeric op on text field', () => {
    expect(
      isSmartRuleCondition({ field: 'vendor', op: 'greater_than', value: '1' }),
    ).toBe(false)
  })

  it('tag field only allows equals / not_equals', () => {
    expect(
      isSmartRuleCondition({ field: 'tag', op: 'equals', value: 'sale' }),
    ).toBe(true)
    expect(
      isSmartRuleCondition({ field: 'tag', op: 'not_equals', value: 'sale' }),
    ).toBe(true)
    expect(
      isSmartRuleCondition({ field: 'tag', op: 'contains', value: 'sale' }),
    ).toBe(false)
  })
})

describe('canonicaliseRules', () => {
  it('returns null for non-object input (treat as manual)', () => {
    expect(canonicaliseRules(null)).toBeNull()
    expect(canonicaliseRules(undefined)).toBeNull()
    expect(canonicaliseRules('{}')).toBeNull()
  })

  it('defaults match mode to "all" when missing or bogus', () => {
    expect(canonicaliseRules({ conditions: [] })?.match).toBe('all')
    expect(canonicaliseRules({ match: 'some', conditions: [] })?.match).toBe('all')
  })

  it('trims whitespace and drops rows with empty field / op / value', () => {
    const out = canonicaliseRules({
      match: 'any',
      conditions: [
        { field: ' title ', op: ' contains ', value: ' shirt ' },
        { field: 'vendor', op: 'equals', value: '' },
        { field: '', op: 'equals', value: 'x' },
      ],
    })
    expect(out).toEqual({
      match: 'any',
      conditions: [{ field: 'title', op: 'contains', value: 'shirt' }],
    })
  })

  it('drops rows that violate field/op pairing', () => {
    const out = canonicaliseRules({
      match: 'all',
      conditions: [
        { field: 'price', op: 'contains', value: '10' }, // bad
        { field: 'price', op: 'greater_than', value: '10' }, // good
      ],
    })
    expect(out?.conditions).toEqual([
      { field: 'price', op: 'greater_than', value: '10' },
    ])
  })
})

describe('isRulesNonEmpty', () => {
  it('true for smart rules with >=1 condition', () => {
    expect(
      isRulesNonEmpty({
        match: 'all',
        conditions: [{ field: 'title', op: 'equals', value: 'x' }],
      }),
    ).toBe(true)
  })

  it('false for smart rules with 0 conditions', () => {
    expect(isRulesNonEmpty({ match: 'all', conditions: [] })).toBe(false)
  })

  it('true for legacy-shape array of >=1 elements (clone-pro importer)', () => {
    expect(isRulesNonEmpty([{ anything: 1 }])).toBe(true)
  })

  it('false for null / empty array / bare object', () => {
    expect(isRulesNonEmpty(null)).toBe(false)
    expect(isRulesNonEmpty([])).toBe(false)
    expect(isRulesNonEmpty({})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Evaluator — fake Kysely recorder.
//
// Minimal stub that records the shape of the query so tests can assert:
//   - the shop_id + status='active' WHERE clauses are present
//   - the conditions callback is invoked exactly once
//   - 'all' uses eb.and, 'any' uses eb.or
//   - each condition emits some expression (content not asserted here)
// ---------------------------------------------------------------------------

interface Recorder {
  table?: string
  selects: string[]
  whereCalls: Array<[any, any, any]>
  callbackWhereCalls: number
  combinator?: 'and' | 'or'
  partsCount?: number
  executeReturn: Array<{ id: string }>
}

function makeFakeDb(rec: Recorder) {
  const builder: any = {
    selectFrom(table: string) {
      rec.table = table
      return builder
    },
    select(col: string) {
      rec.selects.push(col)
      return builder
    },
    where(a: any, b?: any, c?: any) {
      if (typeof a === 'function') {
        rec.callbackWhereCalls++
        const eb: any = (col: string, op: string, val: any) => ({ kind: 'cmp', col, op, val })
        eb.and = (parts: any[]) => {
          rec.combinator = 'and'
          rec.partsCount = parts.length
          return { kind: 'and', parts }
        }
        eb.or = (parts: any[]) => {
          rec.combinator = 'or'
          rec.partsCount = parts.length
          return { kind: 'or', parts }
        }
        eb.lit = (v: any) => ({ kind: 'lit', v })
        a(eb)
      } else {
        rec.whereCalls.push([a, b, c])
      }
      return builder
    },
    async execute() {
      return rec.executeReturn
    },
  }
  return builder
}

describe('evaluateSmartRules', () => {
  it('returns [] for empty conditions (no DB call)', async () => {
    const rec: Recorder = { selects: [], whereCalls: [], callbackWhereCalls: 0, executeReturn: [] }
    const db = makeFakeDb(rec)
    const out = await evaluateSmartRules(db, 'shop-1', { match: 'all', conditions: [] })
    expect(out).toEqual([])
    // No DB work happened.
    expect(rec.table).toBeUndefined()
    expect(rec.callbackWhereCalls).toBe(0)
  })

  it('scopes by shop_id + status=active', async () => {
    const rec: Recorder = { selects: [], whereCalls: [], callbackWhereCalls: 0, executeReturn: [] }
    const db = makeFakeDb(rec)
    await evaluateSmartRules(db, 'shop-abc', {
      match: 'all',
      conditions: [{ field: 'title', op: 'equals', value: 'Hat' }],
    })
    expect(rec.table).toBe('products')
    expect(rec.selects).toContain('id')
    expect(rec.whereCalls).toContainEqual(['shop_id', '=', 'shop-abc'])
    expect(rec.whereCalls).toContainEqual(['status', '=', 'active'])
  })

  it('uses eb.and when match=all with 3 conditions', async () => {
    const rec: Recorder = { selects: [], whereCalls: [], callbackWhereCalls: 0, executeReturn: [] }
    const db = makeFakeDb(rec)
    const rules: SmartRules = {
      match: 'all',
      conditions: [
        { field: 'title', op: 'contains', value: 'shirt' },
        { field: 'vendor', op: 'equals', value: 'Nike' },
        { field: 'price', op: 'greater_than', value: '20' },
      ],
    }
    await evaluateSmartRules(db, 'shop-1', rules)
    expect(rec.combinator).toBe('and')
    expect(rec.partsCount).toBe(3)
  })

  it('uses eb.or when match=any', async () => {
    const rec: Recorder = { selects: [], whereCalls: [], callbackWhereCalls: 0, executeReturn: [] }
    const db = makeFakeDb(rec)
    await evaluateSmartRules(db, 'shop-1', {
      match: 'any',
      conditions: [
        { field: 'tag', op: 'equals', value: 'sale' },
        { field: 'inventory_quantity', op: 'less_than', value: '5' },
      ],
    })
    expect(rec.combinator).toBe('or')
    expect(rec.partsCount).toBe(2)
  })

  it('returns the product ids from the execute() rows', async () => {
    const rec: Recorder = {
      selects: [],
      whereCalls: [],
      callbackWhereCalls: 0,
      executeReturn: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
    }
    const db = makeFakeDb(rec)
    const out = await evaluateSmartRules(db, 'shop-1', {
      match: 'all',
      conditions: [{ field: 'title', op: 'equals', value: 'x' }],
    })
    expect(out).toEqual(['p1', 'p2', 'p3'])
  })
})
