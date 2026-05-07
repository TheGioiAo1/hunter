/**
 * Gbox Platform — Customer Segments Rule Engine (Phase 4 PR2)
 *
 * Pure rule grammar → Kysely WHERE tree. No DB dependency here so it is
 * trivially unit-testable and can be reused anywhere (marketing campaign
 * targeting, CSV export filter, etc).
 *
 * Grammar (flat, single-level):
 *
 *   type Rule     = { field, op, value? }
 *   type RuleSet  = { combinator: 'and' | 'or', rules: Rule[] }
 *
 * Safelist philosophy:
 *   - Every (field, op) pair the merchant can submit is enumerated below.
 *   - Anything outside the safelist throws before touching the DB —
 *     prevents SQL injection via crafted JSON and also prevents leaking
 *     columns the customer list page doesn't surface today (e.g.
 *     password_hash).
 */

import type { ExpressionBuilder } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuleCombinator = 'and' | 'or'

export type RuleFieldType = 'string' | 'number' | 'tags' | 'timestamp' | 'boolean'

export interface SegmentRule {
  field: string
  op: string
  value?: string | number | boolean | null
}

export interface SegmentRuleSet {
  combinator: RuleCombinator
  rules: SegmentRule[]
}

// ---------------------------------------------------------------------------
// Safelist
// ---------------------------------------------------------------------------

interface FieldSpec {
  type: RuleFieldType
  /** DB column name on `customers`. Kept separate from the UI field name
   *  so a future rename is a one-line change. */
  column: string
  /** Whether the column is nullable — affects `is_set` / `is_not_set`. */
  nullable: boolean
  /** Ops allowed for this field. */
  ops: readonly string[]
  /** Human label for the editor UI. */
  label: string
}

/**
 * Ops that every safelisted field inherits, based on type.
 */
const STRING_OPS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'is_set',
  'is_not_set',
] as const

const NUMBER_OPS = [
  'equals',
  'not_equals',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
] as const

const TIMESTAMP_OPS = [
  'before',
  'after',
  'on_or_before',
  'on_or_after',
] as const

const TAGS_OPS = ['contains', 'not_contains', 'is_set', 'is_not_set'] as const

const BOOLEAN_OPS = ['equals'] as const

/**
 * Fields a merchant can put in a rule. Nothing outside this map reaches SQL.
 *
 * Keep this in sync with the editor `<select>` in
 * apps/store-admin/src/pages/customer-segments.ts — renderFieldOptions().
 */
export const SEGMENT_FIELD_SAFELIST: Record<string, FieldSpec> = {
  email: {
    type: 'string',
    column: 'email',
    nullable: true,
    ops: STRING_OPS,
    label: 'Email',
  },
  phone: {
    type: 'string',
    column: 'phone',
    nullable: true,
    ops: STRING_OPS,
    label: 'Phone',
  },
  tags: {
    type: 'tags',
    column: 'tags',
    nullable: true,
    ops: TAGS_OPS,
    label: 'Tags',
  },
  total_spent: {
    type: 'number',
    column: 'total_spent',
    nullable: false,
    ops: NUMBER_OPS,
    label: 'Total spent',
  },
  orders_count: {
    type: 'number',
    column: 'orders_count',
    nullable: false,
    ops: NUMBER_OPS,
    label: 'Orders count',
  },
  created_at: {
    type: 'timestamp',
    column: 'created_at',
    nullable: false,
    ops: TIMESTAMP_OPS,
    label: 'Created at',
  },
  accepts_marketing: {
    type: 'boolean',
    column: 'accepts_marketing',
    nullable: false,
    ops: BOOLEAN_OPS,
    label: 'Accepts email marketing',
  },
} as const

export const SEGMENT_FIELD_NAMES = Object.keys(SEGMENT_FIELD_SAFELIST)

export const MAX_RULES_PER_SEGMENT = 20
export const MAX_NAME_LENGTH = 120

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  )
}

/**
 * Validate a ruleset top-to-bottom, throwing on the first problem. Merchant-
 * facing text — these bubble up through the POST handler to `?error=`.
 */
export function validateRuleSet(input: unknown): SegmentRuleSet {
  if (!isPlainObject(input)) {
    throw new Error('Rules must be an object with combinator + rules[]')
  }
  const combinator = input.combinator
  if (combinator !== 'and' && combinator !== 'or') {
    throw new Error('Combinator must be "and" or "or"')
  }
  const rawRules = input.rules
  if (!Array.isArray(rawRules)) {
    throw new Error('Rules must be an array')
  }
  if (rawRules.length === 0) {
    throw new Error('At least one rule is required')
  }
  if (rawRules.length > MAX_RULES_PER_SEGMENT) {
    throw new Error(
      `A segment may have at most ${MAX_RULES_PER_SEGMENT} rules`,
    )
  }

  const rules: SegmentRule[] = rawRules.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new Error(`Rule ${index + 1} must be an object`)
    }
    const field = typeof raw.field === 'string' ? raw.field : ''
    const op = typeof raw.op === 'string' ? raw.op : ''
    const spec = SEGMENT_FIELD_SAFELIST[field]
    if (!spec) {
      throw new Error(`Rule ${index + 1}: unknown field "${field}"`)
    }
    if (!spec.ops.includes(op)) {
      throw new Error(
        `Rule ${index + 1}: op "${op}" is not allowed for ${spec.label}`,
      )
    }
    const value = coerceValue(spec, op, raw.value, index + 1)
    return { field, op, value }
  })

  return { combinator, rules }
}

function coerceValue(
  spec: FieldSpec,
  op: string,
  raw: unknown,
  ruleNum: number,
): SegmentRule['value'] {
  // value-less ops — is_set / is_not_set for nullable columns.
  if (op === 'is_set' || op === 'is_not_set') {
    return null
  }

  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`Rule ${ruleNum}: value is required`)
  }

  switch (spec.type) {
    case 'string': {
      if (typeof raw !== 'string') {
        throw new Error(`Rule ${ruleNum}: value must be a string`)
      }
      const trimmed = raw.trim()
      if (!trimmed) {
        throw new Error(`Rule ${ruleNum}: value must not be empty`)
      }
      if (trimmed.length > 500) {
        throw new Error(`Rule ${ruleNum}: value must be 500 chars or fewer`)
      }
      return trimmed
    }
    case 'tags': {
      if (typeof raw !== 'string') {
        throw new Error(`Rule ${ruleNum}: tag value must be a string`)
      }
      const trimmed = raw.trim()
      if (!trimmed) {
        throw new Error(`Rule ${ruleNum}: tag value must not be empty`)
      }
      if (trimmed.length > 120) {
        throw new Error(`Rule ${ruleNum}: tag value must be 120 chars or fewer`)
      }
      return trimmed
    }
    case 'number': {
      const n =
        typeof raw === 'number' ? raw : Number.parseFloat(String(raw))
      if (!Number.isFinite(n)) {
        throw new Error(`Rule ${ruleNum}: value must be a number`)
      }
      return n
    }
    case 'timestamp': {
      // Accept ISO-8601 or YYYY-MM-DD.
      const s = String(raw).trim()
      if (!s) {
        throw new Error(`Rule ${ruleNum}: date is required`)
      }
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) {
        throw new Error(`Rule ${ruleNum}: invalid date`)
      }
      return d.toISOString()
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      const s = String(raw).toLowerCase()
      if (s === 'true' || s === '1' || s === 'yes') return true
      if (s === 'false' || s === '0' || s === 'no') return false
      throw new Error(`Rule ${ruleNum}: value must be true or false`)
    }
  }
}

// ---------------------------------------------------------------------------
// Kysely compiler
// ---------------------------------------------------------------------------

/**
 * Compose a ruleset onto a Kysely ExpressionBuilder. The caller is expected
 * to have already scoped the query to `shop_id` — this function only adds
 * the rule-derived WHEREs.
 *
 * Returns an expression the caller plugs into `.where((eb) => ...)`.
 */
export function buildRuleWhere(
  eb: ExpressionBuilder<Database, 'customers'>,
  ruleset: SegmentRuleSet,
) {
  const clauses = ruleset.rules.map((rule) => buildRuleClause(eb, rule))
  return ruleset.combinator === 'and' ? eb.and(clauses) : eb.or(clauses)
}

function buildRuleClause(
  eb: ExpressionBuilder<Database, 'customers'>,
  rule: SegmentRule,
) {
  const spec = SEGMENT_FIELD_SAFELIST[rule.field]
  if (!spec) {
    // validateRuleSet should have caught this, but belt-and-braces.
    throw new Error(`Unknown field "${rule.field}"`)
  }
  const col = `customers.${spec.column}` as any

  switch (spec.type) {
    case 'string':
      return buildStringClause(eb, col, rule)
    case 'tags':
      return buildTagsClause(eb, rule)
    case 'number':
      return buildNumberClause(eb, col, rule)
    case 'timestamp':
      return buildTimestampClause(eb, col, rule)
    case 'boolean':
      return eb(col, '=', rule.value as boolean)
  }
}

function buildStringClause(
  eb: ExpressionBuilder<Database, 'customers'>,
  col: any,
  rule: SegmentRule,
) {
  const v = rule.value as string | null
  switch (rule.op) {
    case 'equals':
      return eb(col, '=', v)
    case 'not_equals':
      return eb(col, '!=', v)
    case 'contains':
      return eb(col, 'ilike', `%${escapeLike(v ?? '')}%`)
    case 'not_contains':
      return eb(col, 'not ilike' as any, `%${escapeLike(v ?? '')}%`)
    case 'starts_with':
      return eb(col, 'ilike', `${escapeLike(v ?? '')}%`)
    case 'ends_with':
      return eb(col, 'ilike', `%${escapeLike(v ?? '')}`)
    case 'is_set':
      return eb(col, 'is not', null as any)
    case 'is_not_set':
      return eb(col, 'is', null as any)
  }
  throw new Error(`Unreachable string op: ${rule.op}`)
}

function buildNumberClause(
  eb: ExpressionBuilder<Database, 'customers'>,
  col: any,
  rule: SegmentRule,
) {
  const v = rule.value as number
  switch (rule.op) {
    case 'equals':
      return eb(col, '=', v)
    case 'not_equals':
      return eb(col, '!=', v)
    case 'greater_than':
      return eb(col, '>', v)
    case 'greater_than_or_equal':
      return eb(col, '>=', v)
    case 'less_than':
      return eb(col, '<', v)
    case 'less_than_or_equal':
      return eb(col, '<=', v)
  }
  throw new Error(`Unreachable number op: ${rule.op}`)
}

function buildTimestampClause(
  eb: ExpressionBuilder<Database, 'customers'>,
  col: any,
  rule: SegmentRule,
) {
  const v = rule.value as string
  switch (rule.op) {
    case 'before':
      return eb(col, '<', v)
    case 'after':
      return eb(col, '>', v)
    case 'on_or_before':
      return eb(col, '<=', v)
    case 'on_or_after':
      return eb(col, '>=', v)
  }
  throw new Error(`Unreachable timestamp op: ${rule.op}`)
}

function buildTagsClause(
  eb: ExpressionBuilder<Database, 'customers'>,
  rule: SegmentRule,
) {
  // customers.tags is a Postgres text[] — use the array-contains operator
  // `@>` so the planner can hit a GIN index if one ever gets added.
  switch (rule.op) {
    case 'contains':
      return sql<boolean>`customers.tags @> ARRAY[${rule.value as string}]::text[]`
    case 'not_contains':
      return sql<boolean>`NOT (customers.tags @> ARRAY[${rule.value as string}]::text[])`
    case 'is_set':
      return eb('customers.tags' as any, 'is not', null as any)
    case 'is_not_set':
      return eb('customers.tags' as any, 'is', null as any)
  }
  throw new Error(`Unreachable tags op: ${rule.op}`)
}

/**
 * Escape LIKE / ILIKE wildcards so a merchant typing "50%" means the literal
 * string and not "ends in 50 then anything".
 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}
