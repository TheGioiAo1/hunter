/**
 * Gbox Platform — support-ai usage tracker (Phase 12.5 PR4).
 *
 * Writes one `support_ai_usage` row per Anthropic invocation so we
 * can:
 *   - enforce the $200/month budget cap (see budget.ts)
 *   - show "this ticket cost $X" in the agent timeline
 *   - back-test whether pickModel() is selecting Opus on the right
 *     subset of tickets (audit analytics: "what % of tickets hit
 *     Opus? which surfaces dominate the bill?")
 *   - reconcile against the Anthropic invoice each month
 *
 * Schema (migration 081):
 *   support_ai_usage(
 *     id              BIGSERIAL,
 *     occurred_at     TIMESTAMPTZ,
 *     month_key       VARCHAR(7)   -- 'YYYY-MM' for rollup partition
 *     surface         VARCHAR(40)  -- 'suggest_reply' | 'summarize' | 'categorize' | 'sentiment'
 *     model           VARCHAR(20)  -- 'sonnet-4-5' | 'opus-4'
 *     input_tokens    INTEGER
 *     output_tokens   INTEGER
 *     cost_cents      INTEGER
 *     ticket_id       UUID NULL    -- some surfaces operate cross-ticket
 *     shop_id         UUID NULL    -- god-admin ticket bulk-actions are shop-less
 *     actor_user_id   UUID NULL
 *     error           TEXT NULL    -- null on success
 *   )
 *
 * Why BIGSERIAL instead of UUID for the PK?
 *   Pure append-only table with no cross-table FKs (ticket_id is a
 *   weak pointer — ON DELETE SET NULL). Serial saves ~12 bytes per
 *   row and gives the cron cleanup a natural `WHERE id < X` pattern.
 *
 * Why `month_key` as a separate column instead of deriving from
 * `occurred_at` at query time?
 *   Rollup queries are hot-path (every AI surface invocation hits
 *   them). A partial index on `(month_key, cost_cents)` gives us
 *   the monthly sum in one index scan without date arithmetic.
 */

import type { SupportAiModel } from './pick-model.ts'
import { computeCostCents } from './pick-model.ts'
import { monthKey } from './budget.ts'

/**
 * The four AI surfaces — one literal union so the DB column domain
 * is enforced at the TS layer. Adding a fifth surface means adding
 * here, in pick-model.ts (optional tuning), and in the migration
 * CHECK if we ever add one.
 */
export type AISurface =
  | 'suggest_reply'
  | 'summarize_thread'
  | 'auto_categorize'
  | 'sentiment_flag'

/**
 * What the caller supplies on every invocation.
 *
 * Success case: pass inputTokens/outputTokens from the Anthropic
 * response.usage object, plus the model and surface.
 *
 * Error case: pass inputTokens=0, outputTokens=0, error='...'.
 * We still insert the row so error-rate dashboards work.
 */
export interface LogAIUsageInput {
  readonly surface: AISurface
  readonly model: SupportAiModel
  readonly inputTokens: number
  readonly outputTokens: number
  readonly ticketId?: string | null
  readonly shopId?: string | null
  readonly actorUserId?: string | null
  readonly error?: string | null
  /** Only override for tests that freeze time. */
  readonly occurredAt?: Date
}

/**
 * Insert one usage row. Computed cost cents are derived from the
 * price sheet so callers can't pass a wrong value.
 *
 * Non-throwing by design — a bookkeeping write MUST NEVER block a
 * support agent's suggest-reply click. If the insert fails (DB
 * down, disk full) the caller gets `{ ok: false, error }` back and
 * continues serving the reply. The error is logged via pino
 * upstream; there's no retry loop here because:
 *   1. A suggest-reply call is interactive — user retries by clicking
 *      again if the DB was flaky.
 *   2. A cron-fired sentiment batch has its own retry envelope.
 *   3. Background queueing for "try this write again" is premature
 *      for MVP — revisit if we see >0.1% loss.
 */
export async function logAIUsage(
  db: any,
  input: LogAIUsageInput,
): Promise<{ ok: true; costCents: number } | { ok: false; error: string }> {
  const occurredAt = input.occurredAt ?? new Date()
  const costCents = computeCostCents(input.model, input.inputTokens, input.outputTokens)

  try {
    await (db as any)
      .insertInto('support_ai_usage')
      .values({
        occurred_at: occurredAt.toISOString(),
        month_key: monthKey(occurredAt),
        surface: input.surface,
        model: input.model,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        cost_cents: costCents,
        ticket_id: input.ticketId ?? null,
        shop_id: input.shopId ?? null,
        actor_user_id: input.actorUserId ?? null,
        error: input.error ?? null,
      })
      .execute()
    return { ok: true, costCents }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Monthly spend roll-up — one scalar integer representing cents
 * burned in the given month. Used by the budget gate + god-admin
 * display.
 *
 * Null-safe: if no rows match (fresh month, never used AI), returns
 * 0 rather than null. Callers don't need to handle undefined.
 */
export async function getMonthlySpendCents(
  db: any,
  month: string = monthKey(),
): Promise<number> {
  try {
    const row = await (db as any)
      .selectFrom('support_ai_usage')
      .select((eb: any) =>
        eb.fn.sum<number>('cost_cents').as('total'),
      )
      .where('month_key', '=', month)
      .executeTakeFirst()
    if (!row) return 0
    const n = Number(row.total ?? 0)
    return Number.isFinite(n) ? n : 0
  } catch {
    // Same fail-soft philosophy as logAIUsage — never block the
    // agent workflow on a rollup query failure. Return 0 so the
    // gate falls through to "ok" (the alternative would be to
    // fail-closed, but we'd rather serve a potentially over-budget
    // call than black-hole the entire AI surface during a DB blip).
    return 0
  }
}

/**
 * Per-surface breakdown for the god-admin dashboard card.
 * Returns { suggest_reply: 1200, summarize_thread: 340, ... } where
 * values are cents. Missing surfaces are present with 0 so the UI
 * doesn't have to fill in defaults.
 */
export async function getMonthlySurfaceBreakdown(
  db: any,
  month: string = monthKey(),
): Promise<Record<AISurface, number>> {
  const zeroed: Record<AISurface, number> = {
    suggest_reply: 0,
    summarize_thread: 0,
    auto_categorize: 0,
    sentiment_flag: 0,
  }
  try {
    const rows = await (db as any)
      .selectFrom('support_ai_usage')
      .select(['surface'])
      .select((eb: any) => eb.fn.sum<number>('cost_cents').as('total'))
      .where('month_key', '=', month)
      .groupBy('surface')
      .execute()
    for (const r of rows) {
      const s = String(r.surface)
      if (s in zeroed) {
        ;(zeroed as Record<string, number>)[s] = Number(r.total ?? 0)
      }
    }
    return zeroed
  } catch {
    return zeroed
  }
}
