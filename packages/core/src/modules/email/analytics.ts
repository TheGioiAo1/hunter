/**
 * Gbox Platform — Email analytics aggregations (Phase 14 PR4)
 *
 * Read-only queries that power the admin email analytics page
 * (`/admin/store/:slug/reports/email-analytics`). All of them lean on
 * the counters added to `email_deliveries` in migration 086:
 *
 *   open_count  (Generated<number>)   — cumulative opens per delivery
 *   click_count (Generated<number>)   — cumulative clicks per delivery
 *   opened_at   (timestamp | null)    — first-open time (existing)
 *   clicked_at  (timestamp | null)    — first-click time (existing)
 *
 * WHY THESE QUERIES READ FROM email_deliveries (NOT email_events)
 * ---------------------------------------------------------------
 * The dashboard needs "how many opens this week?" which is a trivial
 * SUM over a row-per-send table — O(N_sends). Deriving it from
 * email_events is a COUNT of row-per-hit — O(N_hits), typically 5-20×
 * larger. The events log is kept for the forensic path ("which IP
 * opened this email at what time?"); the counters are the fast path.
 *
 * BOUNCE-AWARE FROM DAY 1
 * -----------------------
 * `bounced_at IS NOT NULL` is honoured in every aggregation even though
 * PR4 doesn't emit bounces yet — PR4.B (bounce webhooks) will wire them
 * up. Writing the queries bounce-aware now means the dashboard won't
 * change its open-rate denominator overnight when PR4.B lands. See scope
 * doc §4.
 *
 * ZERO-DIVISION POLICY
 * --------------------
 * All rate calcs are in TypeScript (post-SQL), not via `CASE WHEN
 * sent=0 THEN 0 ELSE opens*100.0/sent END`. Doing it in code means
 * we ship exactly the same result shape regardless of row count and
 * the admin UI never sees NaN / Infinity.
 *
 * ISO DATES
 * ---------
 * All range inputs are ISO dates (YYYY-MM-DD), UTC-anchored. The admin
 * UI converts user tz → UTC before calling; the module never guesses.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DateRange {
  /** YYYY-MM-DD UTC, inclusive. */
  since: string
  /** YYYY-MM-DD UTC, inclusive. */
  until: string
}

export interface EmailSummary {
  sent: number
  delivered: number
  bounced: number
  opens: number
  clicks: number
  /** Unique deliveries that were opened at least once. */
  uniqueOpens: number
  /** Unique deliveries that were clicked at least once. */
  uniqueClicks: number
  /** opens / delivered, 0 when delivered=0. Percentage 0-100. */
  openRate: number
  /** clicks / delivered, 0 when delivered=0. Percentage 0-100. */
  clickRate: number
  /** bounced / sent, 0 when sent=0. Percentage 0-100. */
  bounceRate: number
  /** clicks / opens, 0 when opens=0. Percentage 0-100. */
  clickThroughRate: number
}

export interface DailyEmailMetric {
  /** YYYY-MM-DD UTC. */
  date: string
  sent: number
  delivered: number
  bounced: number
  opens: number
  clicks: number
}

export interface TemplateBreakdown {
  templateKey: string
  sent: number
  delivered: number
  bounced: number
  opens: number
  clicks: number
  uniqueOpens: number
  uniqueClicks: number
  openRate: number
  clickRate: number
  bounceRate: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Divide safely and format as a 0-100 percentage rounded to 2dp. Zero
 * denominator → 0, never NaN. Clamped to [0,100] defensively in case
 * counters ever drift > sent (shouldn't, but audit leniency).
 */
function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0
  const raw = (numerator / denominator) * 100
  const clamped = Math.max(0, Math.min(100, raw))
  return Math.round(clamped * 100) / 100
}

/**
 * Wrap a shop-scoped WHERE. Platform-level sends (shop_id NULL) are
 * never surfaced in shop analytics — the admin page is per-shop.
 */
function forShop<T extends { where: any }>(qb: T, shopId: string): T {
  return qb.where('email_deliveries.shop_id', '=', shopId) as T
}

/**
 * Same but applied to the raw table expression without the prefix.
 * Used by queries that don't alias / join.
 */
function forShopSimple<T extends { where: any }>(qb: T, shopId: string): T {
  return qb.where('shop_id', '=', shopId) as T
}

// ---------------------------------------------------------------------------
// §1 Summary — headline KPIs
// ---------------------------------------------------------------------------

/**
 * One-row summary of the email funnel for a shop over a date range.
 * Powers the top-of-page cards on the analytics report.
 *
 * "Sent" counts all rows with `status='sent'`. "Bounced" counts rows
 * where `bounced_at` has been stamped (PR4.B will flip these). The
 * derivation is:
 *
 *   delivered = sent - bounced
 *   opens     = SUM(open_count)
 *   clicks    = SUM(click_count)
 *   uniqueOpens  = COUNT(*) WHERE opened_at IS NOT NULL
 *   uniqueClicks = COUNT(*) WHERE clicked_at IS NOT NULL
 */
export async function getEmailSummary(
  db: Kysely<Database>,
  shopId: string,
  range: DateRange,
): Promise<EmailSummary> {
  const row = await forShopSimple(
    db
      .selectFrom('email_deliveries')
      .select([
        sql<number>`COUNT(*) FILTER (WHERE status = 'sent')`.as('sent'),
        sql<number>`COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)`.as('bounced'),
        sql<number>`COALESCE(SUM(open_count), 0)`.as('opens'),
        sql<number>`COALESCE(SUM(click_count), 0)`.as('clicks'),
        sql<number>`COUNT(*) FILTER (WHERE opened_at IS NOT NULL)`.as('unique_opens'),
        sql<number>`COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)`.as('unique_clicks'),
      ]),
    shopId,
  )
    .where(sql<string>`DATE(created_at AT TIME ZONE 'UTC')`, '>=', range.since)
    .where(sql<string>`DATE(created_at AT TIME ZONE 'UTC')`, '<=', range.until)
    .executeTakeFirstOrThrow()

  const sent = Number(row.sent) || 0
  const bounced = Number(row.bounced) || 0
  const opens = Number(row.opens) || 0
  const clicks = Number(row.clicks) || 0
  const uniqueOpens = Number(row.unique_opens) || 0
  const uniqueClicks = Number(row.unique_clicks) || 0
  const delivered = Math.max(0, sent - bounced)

  return {
    sent,
    delivered,
    bounced,
    opens,
    clicks,
    uniqueOpens,
    uniqueClicks,
    openRate: pct(uniqueOpens, delivered),
    clickRate: pct(uniqueClicks, delivered),
    bounceRate: pct(bounced, sent),
    clickThroughRate: pct(uniqueClicks, uniqueOpens),
  }
}

// ---------------------------------------------------------------------------
// §2 Daily time series — for the chart
// ---------------------------------------------------------------------------

/**
 * One row per UTC date in the range, zero-filled for days with no
 * activity so the chart line renders continuously instead of jumping
 * across gaps.
 *
 * The SQL returns only days with at least one send; the JS layer pads
 * the missing days to `{sent:0, opens:0, ...}` before returning.
 */
export async function getDailyEmailMetrics(
  db: Kysely<Database>,
  shopId: string,
  range: DateRange,
): Promise<DailyEmailMetric[]> {
  const rows = await forShopSimple(
    db
      .selectFrom('email_deliveries')
      .select([
        sql<string>`DATE(created_at AT TIME ZONE 'UTC')::text`.as('date'),
        sql<number>`COUNT(*) FILTER (WHERE status = 'sent')`.as('sent'),
        sql<number>`COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)`.as('bounced'),
        sql<number>`COALESCE(SUM(open_count), 0)`.as('opens'),
        sql<number>`COALESCE(SUM(click_count), 0)`.as('clicks'),
      ]),
    shopId,
  )
    .where(sql<string>`DATE(created_at AT TIME ZONE 'UTC')`, '>=', range.since)
    .where(sql<string>`DATE(created_at AT TIME ZONE 'UTC')`, '<=', range.until)
    .groupBy(sql`DATE(created_at AT TIME ZONE 'UTC')`)
    .orderBy(sql`DATE(created_at AT TIME ZONE 'UTC')`, 'asc')
    .execute()

  // Build a map keyed by date for O(1) zero-fill.
  const byDate = new Map<string, DailyEmailMetric>()
  for (const r of rows) {
    const sent = Number(r.sent) || 0
    const bounced = Number(r.bounced) || 0
    byDate.set(r.date, {
      date: r.date,
      sent,
      delivered: Math.max(0, sent - bounced),
      bounced,
      opens: Number(r.opens) || 0,
      clicks: Number(r.clicks) || 0,
    })
  }

  // Walk the range inclusive and zero-fill.
  const out: DailyEmailMetric[] = []
  let cursor = new Date(`${range.since}T00:00:00Z`)
  const end = new Date(`${range.until}T00:00:00Z`)
  while (cursor.getTime() <= end.getTime()) {
    const iso = cursor.toISOString().slice(0, 10)
    out.push(
      byDate.get(iso) ?? {
        date: iso,
        sent: 0,
        delivered: 0,
        bounced: 0,
        opens: 0,
        clicks: 0,
      },
    )
    cursor = new Date(cursor.getTime() + 86_400_000)
  }
  return out
}

// ---------------------------------------------------------------------------
// §3 Template breakdown — per-template performance
// ---------------------------------------------------------------------------

/**
 * Top-N template performance table. Default sort is `sent DESC` so the
 * highest-volume templates lead — admins usually want "what went out
 * most" at the top. Pass `orderBy: 'open_rate'` or `'click_rate'` to
 * see performance instead of volume.
 *
 * `limit` defaults to 20 — enough to show most-used templates in a
 * shop without blowing up the SQL response size; the UI offers a
 * "show all" link that bumps limit to 100.
 */
export async function getTemplateBreakdown(
  db: Kysely<Database>,
  shopId: string,
  range: DateRange,
  opts: {
    limit?: number
    orderBy?: 'sent' | 'open_rate' | 'click_rate'
  } = {},
): Promise<TemplateBreakdown[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 20))

  const rows = await forShopSimple(
    db
      .selectFrom('email_deliveries')
      .select([
        'template_key',
        sql<number>`COUNT(*) FILTER (WHERE status = 'sent')`.as('sent'),
        sql<number>`COUNT(*) FILTER (WHERE bounced_at IS NOT NULL)`.as('bounced'),
        sql<number>`COALESCE(SUM(open_count), 0)`.as('opens'),
        sql<number>`COALESCE(SUM(click_count), 0)`.as('clicks'),
        sql<number>`COUNT(*) FILTER (WHERE opened_at IS NOT NULL)`.as('unique_opens'),
        sql<number>`COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)`.as('unique_clicks'),
      ]),
    shopId,
  )
    .where(sql<string>`DATE(created_at AT TIME ZONE 'UTC')`, '>=', range.since)
    .where(sql<string>`DATE(created_at AT TIME ZONE 'UTC')`, '<=', range.until)
    .groupBy('template_key')
    .execute()

  // Map + compute rates in code (see "ZERO-DIVISION POLICY" header).
  const mapped: TemplateBreakdown[] = rows.map((r) => {
    const sent = Number(r.sent) || 0
    const bounced = Number(r.bounced) || 0
    const opens = Number(r.opens) || 0
    const clicks = Number(r.clicks) || 0
    const uniqueOpens = Number(r.unique_opens) || 0
    const uniqueClicks = Number(r.unique_clicks) || 0
    const delivered = Math.max(0, sent - bounced)
    return {
      templateKey: r.template_key,
      sent,
      delivered,
      bounced,
      opens,
      clicks,
      uniqueOpens,
      uniqueClicks,
      openRate: pct(uniqueOpens, delivered),
      clickRate: pct(uniqueClicks, delivered),
      bounceRate: pct(bounced, sent),
    }
  })

  // Sort in TS so limit + tie-breaking is deterministic.
  const sortKey = opts.orderBy ?? 'sent'
  mapped.sort((a, b) => {
    const av =
      sortKey === 'sent'
        ? a.sent
        : sortKey === 'open_rate'
          ? a.openRate
          : a.clickRate
    const bv =
      sortKey === 'sent'
        ? b.sent
        : sortKey === 'open_rate'
          ? b.openRate
          : b.clickRate
    if (av !== bv) return bv - av
    // Stable tie-breaker: template_key asc so two templates with equal
    // sends show alphabetically.
    return a.templateKey.localeCompare(b.templateKey)
  })

  return mapped.slice(0, limit)
}

// ---------------------------------------------------------------------------
// §4 Top templates — shorthand for "show me my winners"
// ---------------------------------------------------------------------------

/**
 * Top N templates by a specific metric. Thin wrapper over
 * getTemplateBreakdown for the ergonomic case where the UI needs
 * exactly one sorted list.
 */
export async function getTopTemplates(
  db: Kysely<Database>,
  shopId: string,
  range: DateRange,
  metric: 'sent' | 'open_rate' | 'click_rate' = 'sent',
  limit = 5,
): Promise<TemplateBreakdown[]> {
  return getTemplateBreakdown(db, shopId, range, {
    orderBy: metric,
    limit,
  })
}

// ---------------------------------------------------------------------------
// §5 Range helpers for the UI
// ---------------------------------------------------------------------------

/**
 * Build a DateRange for "last N days" ending today (UTC). Used by the
 * admin report's default view + the "7d / 30d / 90d" quick filters.
 */
export function lastNDays(n: number, today: Date = new Date()): DateRange {
  const end = today.toISOString().slice(0, 10)
  const start = new Date(
    today.getTime() - Math.max(0, n - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10)
  return { since: start, until: end }
}

// Silence unused-var lint — `forShop` is exported for future callers.
void forShop
