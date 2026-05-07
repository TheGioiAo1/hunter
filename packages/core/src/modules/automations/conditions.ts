/**
 * Gbox Platform — Condition AST + evaluator (Phase 14 PR3)
 *
 * Flow catalog entries declare zero or more conditions that must be
 * true before the runner dispatches. Conditions are stored as a
 * declarative JSON tree so merchants can override them from the admin
 * UI (via `automation_flows.conditions` JSONB column) without a code
 * deploy — same pattern as Shopify Flow's condition node.
 *
 * Deliberately NARROW: we support `eq`, `neq`, `gt`, `gte`, `lt`,
 * `lte`, `truthy`, `falsy`, `in`, `not_in`, `and`, `or`, `not`. Not a
 * full expression language, not a DSL, no user-defined functions, no
 * regex. If a condition can't be expressed in these ops, it belongs
 * in the flow's `preConditions` hook at the catalog level, not in a
 * merchant-editable JSON blob (which is an untrusted input).
 *
 * Scope limits
 * ------------
 *   - No field path dereferencing with array indexing or globs. Only
 *     dot-path (`event.totalPrice`, `context.customer.total_orders`).
 *   - No dynamic lookup or wildcard matches against untrusted keys.
 *   - No computed operators (e.g. regex-match). Evaluator is pure-
 *     function + side-effect-free so it can be unit-tested without
 *     touching the DB.
 *
 * Iron rule compliance
 * --------------------
 *   - Rule 1 (Security): the evaluator short-circuits on malformed
 *     nodes (unknown op → false) rather than throwing. A hostile
 *     merchant with admin-UI access couldn't cause a condition to
 *     crash the runner and skip the iron-rule-5 filter downstream.
 *   - Rule 5 (Seller UI never exposes god-admin): conditions evaluate
 *     against a `context` bag that the runner loads; the runner
 *     controls which context fields are populated and NEVER loads
 *     god-admin-only data (e.g. platform secrets). A condition trying
 *     to read `context.god_admin.*` gets `undefined` → falsy → flow
 *     skipped. Defense in depth — the template iron-rule-5 gate in
 *     send.ts is still the primary wall.
 */

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type ConditionLeaf =
  | { op: 'eq'; field: string; value: unknown }
  | { op: 'neq'; field: string; value: unknown }
  | { op: 'gt'; field: string; value: number }
  | { op: 'gte'; field: string; value: number }
  | { op: 'lt'; field: string; value: number }
  | { op: 'lte'; field: string; value: number }
  | { op: 'truthy'; field: string }
  | { op: 'falsy'; field: string }
  | { op: 'in'; field: string; values: readonly unknown[] }
  | { op: 'not_in'; field: string; values: readonly unknown[] }

export type ConditionNode =
  | ConditionLeaf
  | { op: 'and'; nodes: readonly ConditionNode[] }
  | { op: 'or'; nodes: readonly ConditionNode[] }
  | { op: 'not'; node: ConditionNode }

/**
 * Runner context bag passed to the evaluator. The runner populates
 * this per event — e.g. `{ event, shop, customer, order }`. Fields
 * not relevant to a given event are simply absent. The evaluator
 * treats missing fields as `undefined` (which is falsy / never
 * matches equality).
 */
export type ConditionContext = Record<string, unknown>

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a condition tree against a context bag. Returns `true` iff
 * the condition matches. Malformed nodes return `false` (fail-closed).
 */
export function evaluateCondition(
  node: ConditionNode | undefined | null,
  context: ConditionContext,
): boolean {
  // No condition = match everything. Flow-catalog entries with empty
  // conditions hit this path; we don't force callers to pass an
  // identity true-node.
  if (node == null) return true

  switch (node.op) {
    case 'and':
      return node.nodes.every((n) => evaluateCondition(n, context))
    case 'or':
      return node.nodes.some((n) => evaluateCondition(n, context))
    case 'not':
      return !evaluateCondition(node.node, context)
    case 'eq':
      return strictEq(getField(context, node.field), node.value)
    case 'neq':
      return !strictEq(getField(context, node.field), node.value)
    case 'gt': {
      const v = getField(context, node.field)
      return typeof v === 'number' && v > node.value
    }
    case 'gte': {
      const v = getField(context, node.field)
      return typeof v === 'number' && v >= node.value
    }
    case 'lt': {
      const v = getField(context, node.field)
      return typeof v === 'number' && v < node.value
    }
    case 'lte': {
      const v = getField(context, node.field)
      return typeof v === 'number' && v <= node.value
    }
    case 'truthy':
      return Boolean(getField(context, node.field))
    case 'falsy':
      return !getField(context, node.field)
    case 'in':
      return node.values.includes(getField(context, node.field))
    case 'not_in':
      return !node.values.includes(getField(context, node.field))
    default: {
      // Unknown op — unreachable under sound TS, but be defensive for
      // merchant-supplied JSONB that might ship new ops. Fail closed.
      return false
    }
  }
}

/**
 * Dot-path lookup on the context bag. Supports `event.totalPrice`,
 * `customer.total_orders`, etc. Returns `undefined` on any intermediate
 * null / non-object — same semantics as `interpolate()` in send.ts /
 * email-preview.ts.
 */
function getField(ctx: ConditionContext, path: string): unknown {
  if (!path) return undefined
  const keys = path.split('.')
  let value: unknown = ctx
  for (const k of keys) {
    if (value == null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[k]
  }
  return value
}

/**
 * Strict equality with JSON-comparable semantics: primitives via `===`,
 * Dates via ISO-string match, everything else via `===`. We do NOT do
 * deep object equality — flow conditions shouldn't need it, and adding
 * it widens the attack surface on merchant-supplied JSONB.
 */
function strictEq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime()
  }
  return a === b
}

// ---------------------------------------------------------------------------
// Schema validation (for merchant-supplied override JSONB)
// ---------------------------------------------------------------------------

/**
 * Runtime validator for merchant-supplied condition JSON. Called from
 * the /settings/automations admin page before persisting an override.
 * Returns `null` on success (valid), or a string describing the first
 * rejection reason on failure.
 *
 * NOT a replacement for the evaluator's fail-closed semantics — it's
 * a UX layer to reject obvious garbage at save time so merchants get
 * an actionable error instead of a silently-skipping flow.
 */
export function validateConditionTree(
  node: unknown,
  depth = 0,
  maxDepth = 8,
): string | null {
  if (depth > maxDepth) return 'condition tree too deep'
  if (node === null || node === undefined) return null // empty = match-all

  if (typeof node !== 'object') return 'condition must be an object'
  const n = node as Record<string, unknown>
  if (typeof n.op !== 'string') return 'condition missing "op"'

  switch (n.op) {
    case 'and':
    case 'or': {
      if (!Array.isArray(n.nodes)) return `${n.op} requires "nodes" array`
      for (const child of n.nodes) {
        const err = validateConditionTree(child, depth + 1, maxDepth)
        if (err) return err
      }
      return null
    }
    case 'not':
      if (n.node === null || n.node === undefined) {
        return 'not requires "node" object'
      }
      return validateConditionTree(n.node, depth + 1, maxDepth)
    case 'eq':
    case 'neq':
      if (typeof n.field !== 'string') return `${n.op} requires "field" string`
      if (!('value' in n)) return `${n.op} requires "value"`
      return null
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (typeof n.field !== 'string') return `${n.op} requires "field" string`
      if (typeof n.value !== 'number' || Number.isNaN(n.value)) {
        return `${n.op} requires numeric "value"`
      }
      return null
    case 'truthy':
    case 'falsy':
      if (typeof n.field !== 'string') return `${n.op} requires "field" string`
      return null
    case 'in':
    case 'not_in':
      if (typeof n.field !== 'string') return `${n.op} requires "field" string`
      if (!Array.isArray(n.values)) return `${n.op} requires "values" array`
      return null
    default:
      return `unknown op: ${n.op}`
  }
}
