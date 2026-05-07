/**
 * Gbox Platform — Customer Segments Service (Phase 4 PR2)
 *
 * Thin CRUD layer over `customer_segments` plus a `countMatchingCustomers`
 * helper the editor uses for the live "Preview count" button.
 *
 * All queries shop-scoped. Cross-shop access is treated as not-found
 * (silent 404 semantics), matching the pattern from customer-notes.
 */

import type { Kysely } from 'kysely'
import type {
  Database,
  CustomerSegmentTable,
} from '@gbox/db/schema/tables.js'

import {
  validateRuleSet,
  buildRuleWhere,
  MAX_NAME_LENGTH,
  type SegmentRuleSet,
} from './rules.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Selectable<T> = {
  [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any>
    ? S
    : T[K]
}

export type CustomerSegment = Selectable<CustomerSegmentTable>

export interface CreateSegmentInput {
  shop_id: string
  name: string
  rules: unknown // validated inside
}

export interface UpdateSegmentInput {
  shop_id: string
  id: string
  name?: string
  rules?: unknown
}

export interface ListSegmentsInput {
  shop_id: string
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseName(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) {
    throw new Error('Segment name is required')
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`Segment name must be ${MAX_NAME_LENGTH} chars or fewer`)
  }
  return trimmed
}

/**
 * Resolve a ruleset from either an already-parsed object or a JSON string
 * (handy for form submits). Throws on invalid.
 */
export function parseRules(raw: unknown): SegmentRuleSet {
  const parsed =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw)
          } catch {
            throw new Error('Rules JSON is invalid')
          }
        })()
      : raw
  return validateRuleSet(parsed)
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createSegment(
  db: Kysely<Database>,
  input: CreateSegmentInput,
): Promise<CustomerSegment> {
  const name = normaliseName(input.name)
  const rules = parseRules(input.rules)

  const inserted = await db
    .insertInto('customer_segments')
    .values({
      shop_id: input.shop_id,
      name,
      rules_json: JSON.stringify(rules) as any,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()

  return inserted as CustomerSegment
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateSegment(
  db: Kysely<Database>,
  input: UpdateSegmentInput,
): Promise<CustomerSegment | null> {
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (input.name !== undefined) {
    patch.name = normaliseName(input.name)
  }
  if (input.rules !== undefined) {
    patch.rules_json = JSON.stringify(parseRules(input.rules))
  }

  const row = await db
    .updateTable('customer_segments')
    .set(patch as any)
    .where('id', '=', input.id)
    .where('shop_id', '=', input.shop_id)
    .returningAll()
    .executeTakeFirst()

  return (row as CustomerSegment) ?? null
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteSegment(
  db: Kysely<Database>,
  input: { shop_id: string; id: string },
): Promise<boolean> {
  const result = await db
    .deleteFrom('customer_segments')
    .where('id', '=', input.id)
    .where('shop_id', '=', input.shop_id)
    .executeTakeFirst()
  return Number(result?.numDeletedRows ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listSegments(
  db: Kysely<Database>,
  input: ListSegmentsInput,
): Promise<CustomerSegment[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 50), 250)
  const offset = Math.max(0, input.offset ?? 0)

  const rows = await db
    .selectFrom('customer_segments')
    .selectAll()
    .where('shop_id', '=', input.shop_id)
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()

  return rows as CustomerSegment[]
}

export async function getSegment(
  db: Kysely<Database>,
  input: { shop_id: string; id: string },
): Promise<CustomerSegment | null> {
  const row = await db
    .selectFrom('customer_segments')
    .selectAll()
    .where('id', '=', input.id)
    .where('shop_id', '=', input.shop_id)
    .executeTakeFirst()
  return (row as CustomerSegment) ?? null
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Count customers matching a validated ruleset. Used by the editor's
 * "Preview count" button and, later, by marketing campaign targeting.
 *
 * The `rules` argument accepts either a parsed ruleset or raw JSON — we
 * validate both paths so callers can't smuggle arbitrary SQL in.
 */
export async function countMatchingCustomers(
  db: Kysely<Database>,
  shop_id: string,
  rules: unknown,
): Promise<number> {
  const ruleset = parseRules(rules)

  const row = await db
    .selectFrom('customers')
    .select((eb) => eb.fn.countAll().as('count'))
    .where('shop_id', '=', shop_id)
    .where((eb) => buildRuleWhere(eb, ruleset))
    .executeTakeFirst()

  return Number(row?.count ?? 0)
}
