/**
 * Gbox Platform — Smart collection rules (Phase C2)
 *
 * A "smart" collection is one whose membership is derived from rules
 * rather than hand-curated. Shopify has this feature with the name
 * "automated collection"; we call it "smart collection" to avoid the
 * ambiguity with storefront-theme-automations in the clone-pro stack.
 *
 * This module owns two things:
 *
 *   1. The canonical TYPE definition of a rule set, so the JsonB
 *      `collections.rules` column is no longer an amorphous blob. The
 *      type drives both the form serializer (store-admin) and the
 *      evaluator (this file + the BullMQ worker).
 *
 *   2. The EVALUATOR — `evaluateSmartRules(db, shopId, rules)` — which
 *      turns a rule set into the concrete set of product ids that
 *      should be in the collection right now. The BullMQ worker calls
 *      this, diffs against the current `collection_products` rows, and
 *      issues the minimum INSERT/DELETE.
 *
 * The six supported fields match Shopify's (sans product_metafield
 * which we defer to C3):
 *
 *   - title                    text   (equals, not_equals, starts_with, ends_with, contains, not_contains)
 *   - product_type             text   (equals, not_equals)
 *   - vendor                   text   (equals, not_equals)
 *   - tag                      text   (equals, not_equals)           // list membership
 *   - variants.price           number (greater_than, less_than, equals, not_equals)
 *   - variants.inventory_quantity  number (greater_than, less_than, equals, not_equals)
 *
 * Match mode: 'all' → AND (every condition must pass), 'any' → OR
 * (at least one condition must pass). This mirrors Shopify's
 * disjunctive/conjunctive toggle.
 *
 * Draft + archived products are ALWAYS excluded — Shopify parity.
 */

import { sql, type Kysely } from 'kysely'

// ---------------------------------------------------------------------------
// Types — single source of truth for the rules JSON shape.
// ---------------------------------------------------------------------------

export type SmartRuleField =
  | 'title'
  | 'product_type'
  | 'vendor'
  | 'tag'
  | 'price'
  | 'inventory_quantity'

export type TextOp =
  | 'equals'
  | 'not_equals'
  | 'starts_with'
  | 'ends_with'
  | 'contains'
  | 'not_contains'

export type NumericOp =
  | 'greater_than'
  | 'less_than'
  | 'equals'
  | 'not_equals'

export type TagOp = 'equals' | 'not_equals'

/**
 * A single condition row. `value` is always stored as string for JSON
 * stability; the evaluator casts to number where relevant.
 */
export interface SmartRuleCondition {
  field: SmartRuleField
  op: TextOp | NumericOp | TagOp
  value: string
}

export interface SmartRules {
  match: 'all' | 'any'
  conditions: SmartRuleCondition[]
}

// ---------------------------------------------------------------------------
// Validation + canonicalisation. Used by the handler when parsing
// form input and by the worker before evaluation.
// ---------------------------------------------------------------------------

const TEXT_FIELDS = new Set<SmartRuleField>(['title', 'product_type', 'vendor'])
const TAG_FIELDS = new Set<SmartRuleField>(['tag'])
const NUMERIC_FIELDS = new Set<SmartRuleField>(['price', 'inventory_quantity'])

const TEXT_OPS: ReadonlySet<string> = new Set<TextOp>([
  'equals',
  'not_equals',
  'starts_with',
  'ends_with',
  'contains',
  'not_contains',
])
const TAG_OPS: ReadonlySet<string> = new Set<TagOp>(['equals', 'not_equals'])
const NUMERIC_OPS: ReadonlySet<string> = new Set<NumericOp>([
  'greater_than',
  'less_than',
  'equals',
  'not_equals',
])

/**
 * True if `v` is a well-formed SmartRules value. Empty rules arrays
 * are ALLOWED (a smart collection with no conditions simply has no
 * products); we use the `match` field + "is this an object" check to
 * tell smart-but-empty from legacy-manual.
 */
export function isSmartRules(v: unknown): v is SmartRules {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (o.match !== 'all' && o.match !== 'any') return false
  if (!Array.isArray(o.conditions)) return false
  return o.conditions.every(isSmartRuleCondition)
}

export function isSmartRuleCondition(v: unknown): v is SmartRuleCondition {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const field = o.field as SmartRuleField
  const op = o.op as string
  const value = o.value
  if (typeof field !== 'string' || typeof op !== 'string' || typeof value !== 'string') {
    return false
  }

  if (TEXT_FIELDS.has(field)) return TEXT_OPS.has(op)
  if (TAG_FIELDS.has(field)) return TAG_OPS.has(op)
  if (NUMERIC_FIELDS.has(field)) {
    if (!NUMERIC_OPS.has(op)) return false
    // Numeric value must parse cleanly. We accept '' only if we're
    // about to reject the whole row, but here we want strict.
    const n = Number(value)
    return Number.isFinite(n)
  }
  return false
}

/**
 * Canonicalise a raw form-decoded payload into SmartRules. Trims
 * whitespace, drops incomplete rows, defaults match mode.
 *
 * Returns `null` if the input doesn't look like a smart rules payload
 * at all (caller should treat the collection as manual).
 */
export function canonicaliseRules(raw: unknown): SmartRules | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const match = o.match === 'any' ? 'any' : 'all'
  const rawConds = Array.isArray(o.conditions) ? o.conditions : []

  const clean: SmartRuleCondition[] = []
  for (const c of rawConds) {
    if (!c || typeof c !== 'object') continue
    const co = c as Record<string, unknown>
    const field = String(co.field ?? '').trim() as SmartRuleField
    const op = String(co.op ?? '').trim()
    const value = String(co.value ?? '').trim()
    if (!field || !op || !value) continue
    const row: SmartRuleCondition = { field, op: op as any, value }
    if (!isSmartRuleCondition(row)) continue
    clean.push(row)
  }
  return { match, conditions: clean }
}

/**
 * `collections.rules` is JsonB — it can hold either a legacy-shape
 * array (clone-pro importer) or a SmartRules object. This helper
 * tells the admin UI which shape we've got.
 */
export function isRulesNonEmpty(rules: unknown): boolean {
  if (isSmartRules(rules)) return rules.conditions.length > 0
  if (Array.isArray(rules)) return rules.length > 0
  return false
}

// ---------------------------------------------------------------------------
// Evaluator. Pure SQL via Kysely — no JS-side filtering so big shops
// don't have to stream every product through the Node process.
//
// The query strategy:
//
//   - Start from `products` scoped by shop_id and status='active'.
//   - For each condition, emit a WHERE clause. Text/vendor/type read
//     product columns; tag reads the `tags` text[]; price + inventory
//     need a correlated EXISTS against `product_variants`.
//   - Combine with AND (match='all') or OR (match='any').
//   - Return `string[]` of product ids.
//
// Draft + archived are excluded; this matches Shopify's storefront
// behaviour where only live products appear in smart collections.
// ---------------------------------------------------------------------------

/**
 * Evaluate a smart rules set against the products table and return
 * the set of product ids that currently match.
 *
 * Empty conditions array → returns [] (a smart collection with no
 * rules has no members, matching Shopify UX).
 */
export async function evaluateSmartRules(
  db: Kysely<any>,
  shopId: string,
  rules: SmartRules,
): Promise<string[]> {
  if (rules.conditions.length === 0) return []

  // Bind-params for each condition, collected in order so the builder
  // can consume them positionally when emitting SQL via `sql``.
  let q = db
    .selectFrom('products')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('status', '=', 'active')

  // Kysely's eb builder lets us compose AND / OR inside a `.where()`.
  // `match: 'all'` nests every condition under `eb.and`, `any` uses
  // `eb.or`. A single flat call is easier to read than many chained
  // `.where()`s and matches the mental model of the UI.
  q = q.where((eb: any) => {
    const parts = rules.conditions.map((c) => buildConditionExpr(eb, c))
    if (rules.match === 'any') return eb.or(parts)
    return eb.and(parts)
  })

  const rows = await q.execute()
  return rows.map((r: any) => r.id as string)
}

/**
 * Translate ONE condition into a Kysely expression. Split out so the
 * worker's unit tests can assert individual SQL fragments without
 * booting the whole evaluator.
 */
export function buildConditionExpr(eb: any, c: SmartRuleCondition): unknown {
  switch (c.field) {
    case 'title':
    case 'product_type':
    case 'vendor':
      return buildTextExpr(eb, c.field, c.op as TextOp, c.value)
    case 'tag':
      return buildTagExpr(eb, c.op as TagOp, c.value)
    case 'price':
      return buildVariantNumericExpr(eb, 'price', c.op as NumericOp, c.value)
    case 'inventory_quantity':
      return buildVariantNumericExpr(eb, 'inventory_quantity', c.op as NumericOp, c.value)
    default: {
      // Exhaustiveness check. Unreachable if isSmartRuleCondition
      // was run upstream.
      const _exhaust: never = c.field
      throw new Error(`Unknown smart rule field: ${_exhaust as string}`)
    }
  }
}

function buildTextExpr(eb: any, column: string, op: TextOp, value: string): unknown {
  // ILIKE is PostgreSQL-specific and the right choice here — case
  // insensitivity mirrors Shopify's behaviour ("black" matches both
  // "Black" and "black t-shirt").
  const col = `products.${column}`
  const v = escapeLike(value)
  switch (op) {
    case 'equals':
      return eb(col, 'ilike', value)
    case 'not_equals':
      return eb.or([
        eb(col, 'is', null),
        eb(col, 'not ilike', value),
      ])
    case 'starts_with':
      return eb(col, 'ilike', `${v}%`)
    case 'ends_with':
      return eb(col, 'ilike', `%${v}`)
    case 'contains':
      return eb(col, 'ilike', `%${v}%`)
    case 'not_contains':
      return eb.or([
        eb(col, 'is', null),
        eb(col, 'not ilike', `%${v}%`),
      ])
  }
}

function buildTagExpr(_eb: any, op: TagOp, value: string): unknown {
  // Tags live in a `text[]` column. Postgres array membership is the
  // @> operator ("contains"), with `ARRAY['x']` on the right. Tests
  // treat the returned object as opaque and assert on the generated
  // SQL via the compiler, not the expression tree shape.
  if (op === 'equals') {
    return sql`products.tags @> ARRAY[${sql.lit(value)}]::text[]`
  }
  // not_equals means "does NOT contain this tag" — covers NULL tags
  // and the "has other tags but not this one" case.
  return sql`(products.tags IS NULL OR NOT (products.tags @> ARRAY[${sql.lit(value)}]::text[]))`
}

function buildVariantNumericExpr(
  eb: any,
  column: 'price' | 'inventory_quantity',
  op: NumericOp,
  value: string,
): unknown {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    // Guard: if a bogus value slipped past canonicaliseRules, return
    // a tautologically-false expression so the whole rule never
    // matches.
    return eb.lit(false)
  }

  // Variants are 1:N with products. Shopify's rule is "ANY variant
  // matches" (i.e. a product with both $5 and $50 variants matches
  // "price < $10"), so we use EXISTS rather than a JOIN + DISTINCT.
  const opSym =
    op === 'greater_than' ? sql`>` :
    op === 'less_than'    ? sql`<` :
    op === 'equals'       ? sql`=` :
                            sql`<>`
  const num = sql.lit(n)

  // price is NUMERIC in the DB; CAST to numeric is a no-op but keeps
  // the expression portable if we ever swap the column type.
  const colExpr =
    column === 'price'
      ? sql`CAST(pv.price AS numeric)`
      : sql`pv.inventory_quantity`

  return sql`EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = products.id AND ${colExpr} ${opSym} ${num})`
}

/**
 * Escape PostgreSQL LIKE wildcard characters so merchant input like
 * "50% off" is matched literally rather than as "any 5 chars ending
 * with 'off'". % and _ get a backslash prefix; the ILIKE operator
 * treats '\' as the default escape.
 */
function escapeLike(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}
