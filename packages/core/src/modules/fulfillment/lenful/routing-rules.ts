/**
 * Lenful routing rules (Phase F4).
 *
 * A routing rule decides:
 *   1. Whether a given Gbox order should be auto-pushed to Lenful the
 *      moment it becomes paid.
 *   2. What the default shipping priority list should be for that
 *      order (the same format used by lenful_product_map, codes 0–8).
 *
 * Match dimensions
 * ----------------
 *   match_type       match_value            matches when…
 *   ----------       -----------            -------------
 *   all              (ignored)              always — catch-all fallback
 *   shop             shops.id               order.shop_id = value
 *   shop_slug        shops.slug             order.shop_slug = value
 *   country          ISO code (e.g. US)     ship_to country equals value
 *
 * Evaluation is priority-ordered — the lowest `priority` (closest to 0)
 * wins. `is_active = false` rules are skipped.
 *
 * The sweep runner walks unpushed paid orders and calls
 * `pushOrderToLenful` for each one that matches a rule with
 * `auto_push = true`. Bulk push respects the Lenful 2 req/s rate limit
 * via LenfulClient.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import { pushOrderToLenful } from './push-order.ts'

export interface RoutingRule {
  readonly id: string
  readonly priority: number
  readonly match_type: string
  readonly match_value: string
  readonly auto_push: boolean
  readonly default_shipping_priority: ReadonlyArray<number>
  readonly is_active: boolean
  readonly created_by: string | null
  readonly created_at: string
}

export async function listRoutingRules(
  db: Kysely<Database>,
): Promise<ReadonlyArray<RoutingRule>> {
  const rows = await db
    .selectFrom('lenful_routing_rules')
    .selectAll()
    .orderBy('priority', 'asc')
    .orderBy('created_at', 'asc')
    .execute()
  return rows.map((r: any) => ({
    id: r.id,
    priority: Number(r.priority ?? 100),
    match_type: r.match_type,
    match_value: r.match_value ?? '',
    auto_push: !!r.auto_push,
    default_shipping_priority: (r.default_shipping_priority as number[]) ?? [0, 1, 2],
    is_active: !!r.is_active,
    created_by: r.created_by ?? null,
    created_at: typeof r.created_at === 'string' ? r.created_at : String(r.created_at),
  }))
}

export interface CreateRoutingRuleInput {
  readonly priority: number
  readonly match_type: string
  readonly match_value: string
  readonly auto_push: boolean
  readonly default_shipping_priority: ReadonlyArray<number>
  readonly is_active?: boolean
  readonly created_by?: string | null
}

export async function createRoutingRule(
  db: Kysely<Database>,
  input: CreateRoutingRuleInput,
): Promise<string> {
  if (!input.match_type) throw new Error('match_type required')
  const row = await db
    .insertInto('lenful_routing_rules')
    .values({
      priority: Number.isFinite(input.priority) ? input.priority : 100,
      match_type: input.match_type,
      match_value: input.match_value || '',
      auto_push: input.auto_push,
      default_shipping_priority: Array.from(input.default_shipping_priority ?? [0, 1, 2]) as any,
      is_active: input.is_active ?? true,
      created_by: input.created_by ?? null,
    } as any)
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

export async function updateRoutingRule(
  db: Kysely<Database>,
  id: string,
  patch: Partial<CreateRoutingRuleInput>,
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (typeof patch.priority === 'number') set.priority = patch.priority
  if (typeof patch.match_type === 'string') set.match_type = patch.match_type
  if (typeof patch.match_value === 'string') set.match_value = patch.match_value
  if (typeof patch.auto_push === 'boolean') set.auto_push = patch.auto_push
  if (typeof patch.is_active === 'boolean') set.is_active = patch.is_active
  if (patch.default_shipping_priority) {
    set.default_shipping_priority = Array.from(patch.default_shipping_priority) as any
  }
  if (Object.keys(set).length === 0) return
  await db
    .updateTable('lenful_routing_rules')
    .set(set as any)
    .where('id', '=', id)
    .execute()
}

export async function deleteRoutingRule(
  db: Kysely<Database>,
  id: string,
): Promise<void> {
  await db.deleteFrom('lenful_routing_rules').where('id', '=', id).execute()
}

// ─── Evaluation ───────────────────────────────────────────────────

interface EvaluationOrder {
  readonly id: string
  readonly shop_id: string
  readonly shop_slug: string | null
  readonly financial_status: string | null
  readonly fulfillment_status: string | null
  readonly ship_country: string | null
}

function extractCountry(shippingAddress: unknown): string | null {
  if (!shippingAddress || typeof shippingAddress !== 'object') return null
  const a = shippingAddress as Record<string, any>
  const raw = a.country_code ?? a.country ?? a.countryCode ?? null
  if (!raw) return null
  return String(raw).toUpperCase()
}

/**
 * Apply the rule list to an order and return the winning rule (or null
 * if nothing matches). Used both by the auto-push sweep and by any
 * order-paid handler that wants to decide whether to push.
 */
export function evaluateRule(
  rules: ReadonlyArray<RoutingRule>,
  order: EvaluationOrder,
): RoutingRule | null {
  for (const rule of rules) {
    if (!rule.is_active) continue
    if (!ruleMatches(rule, order)) continue
    return rule
  }
  return null
}

function ruleMatches(rule: RoutingRule, order: EvaluationOrder): boolean {
  switch (rule.match_type) {
    case 'all':
      return true
    case 'shop':
      return rule.match_value === order.shop_id
    case 'shop_slug':
      return rule.match_value === order.shop_slug
    case 'country':
      return (
        !!order.ship_country &&
        rule.match_value.toUpperCase() === order.ship_country.toUpperCase()
      )
    default:
      return false
  }
}

// ─── Auto-push sweep ──────────────────────────────────────────────

export interface AutoPushSweepResult {
  readonly scanned: number
  readonly matched: number
  readonly pushed: number
  readonly skipped: number
  readonly failed: number
  readonly errors: ReadonlyArray<string>
}

/**
 * One-shot sweep: walk paid, unfulfilled Gbox orders with no
 * `lenful_orders` row yet. For each, evaluate rules and, if a matching
 * rule has `auto_push = true`, call pushOrderToLenful.
 *
 * Returns a summary usable in the UI toast. Safe to call from a cron.
 */
export async function runAutoPushSweep(
  db: Kysely<Database>,
  opts: { triggeredBy?: string; userId?: string | null; limit?: number } = {},
): Promise<AutoPushSweepResult> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
  const rules = await listRoutingRules(db)
  if (rules.length === 0) {
    return { scanned: 0, matched: 0, pushed: 0, skipped: 0, failed: 0, errors: [] }
  }

  const candidates = await db
    .selectFrom('orders as o')
    .leftJoin('lenful_orders as lo', 'lo.gbox_order_id', 'o.id')
    .leftJoin('shops as s', 's.id', 'o.shop_id')
    .select([
      'o.id as id',
      'o.shop_id as shop_id',
      'o.financial_status as financial_status',
      'o.fulfillment_status as fulfillment_status',
      'o.shipping_address as shipping_address',
      's.slug as shop_slug',
    ])
    .where('lo.id', 'is', null)
    .where((eb) =>
      eb.or([
        eb('o.financial_status' as any, '=', 'paid'),
        eb('o.financial_status' as any, '=', 'authorized'),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb('o.fulfillment_status' as any, 'is', null),
        eb('o.fulfillment_status' as any, '=', 'unfulfilled'),
      ]),
    )
    .orderBy('o.created_at', 'desc')
    .limit(limit)
    .execute()

  const result = {
    scanned: candidates.length,
    matched: 0,
    pushed: 0,
    skipped: 0,
    failed: 0,
    errors: [] as string[],
  }

  for (const c of candidates as any[]) {
    const order: EvaluationOrder = {
      id: c.id,
      shop_id: c.shop_id,
      shop_slug: c.shop_slug ?? null,
      financial_status: c.financial_status ?? null,
      fulfillment_status: c.fulfillment_status ?? null,
      ship_country: extractCountry(c.shipping_address),
    }
    const rule = evaluateRule(rules, order)
    if (!rule) {
      result.skipped++
      continue
    }
    result.matched++
    if (!rule.auto_push) {
      result.skipped++
      continue
    }
    try {
      const outcome = await pushOrderToLenful(db, {
        gboxOrderId: order.id,
        triggeredBy: opts.triggeredBy ?? 'routing-sweep',
        userId: opts.userId ?? null,
      })
      if (outcome.ok) {
        result.pushed++
      } else {
        result.failed++
        result.errors.push(
          `${order.id.slice(0, 8)}: ${outcome.errorCode || '?'} ${outcome.errorMsg || ''}`,
        )
      }
    } catch (e: any) {
      result.failed++
      result.errors.push(`${order.id.slice(0, 8)}: ${e?.message ?? String(e)}`)
    }
  }

  return result
}

/**
 * Single-order eligibility check — lightweight wrapper for an
 * order.paid event handler that wants to know "push or not?".
 * Returns the matching rule (or null) and a `shouldPush` flag.
 */
export async function checkAutoPush(
  db: Kysely<Database>,
  orderId: string,
): Promise<{ shouldPush: boolean; rule: RoutingRule | null }> {
  const rules = await listRoutingRules(db)
  if (rules.length === 0) return { shouldPush: false, rule: null }
  const order = await db
    .selectFrom('orders as o')
    .leftJoin('shops as s', 's.id', 'o.shop_id')
    .select([
      'o.id as id',
      'o.shop_id as shop_id',
      'o.financial_status as financial_status',
      'o.fulfillment_status as fulfillment_status',
      'o.shipping_address as shipping_address',
      's.slug as shop_slug',
    ])
    .where('o.id', '=', orderId)
    .executeTakeFirst()
  if (!order) return { shouldPush: false, rule: null }
  const ev: EvaluationOrder = {
    id: (order as any).id,
    shop_id: (order as any).shop_id,
    shop_slug: (order as any).shop_slug ?? null,
    financial_status: (order as any).financial_status ?? null,
    fulfillment_status: (order as any).fulfillment_status ?? null,
    ship_country: extractCountry((order as any).shipping_address),
  }
  const rule = evaluateRule(rules, ev)
  return { shouldPush: !!rule?.auto_push, rule }
}
