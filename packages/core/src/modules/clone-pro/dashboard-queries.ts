/**
 * Clone-Pro Dashboard — read-side query helpers.
 *
 * Single place the store-admin and accounts UIs talk to for dashboard
 * data. Each helper targets the `storefront_clone_jobs` table (per the
 * 2026-04-17 pivot — see the design spec §7.1). If/when the backend
 * ever splits into a dedicated `clone_pro_jobs` table, swap the table
 * name in four places here and the UI is unaffected.
 *
 * Helpers:
 *
 *   - listActiveJobs       — cards shown above the fold on the index
 *                             page. Status ∈ {running, paused, failed}.
 *   - getReadyToPublishJobs — the green banner on the index page.
 *                             Status = succeeded, not yet published,
 *                             not discarded.
 *   - listJobHistory       — paginated table below the fold. Accepts
 *                             optional status + free-text filters.
 *   - getDashboardStats    — stats strip (total clones, published,
 *                             average grade, 30-day AI spend). Pulls
 *                             a narrow projection and aggregates in
 *                             JavaScript — at merchant scale (<10k
 *                             jobs per shop) this is cheaper than a
 *                             Postgres aggregation with GROUP BY and
 *                             avoids a second connection.
 *
 * The `DashboardJobRow` shape is the single projection every helper
 * returns; pages consume it directly without re-mapping.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export interface DashboardJobRow {
  id: string
  source_url: string
  status: string
  grade: string | null
  score: number | null
  current_phase: number
  phase_progress_pct: number
  substep: string | null
  cost_cents: number
  created_at: Date | string
  finished_at: Date | string | null
  published_at: Date | string | null
  error_code: string | null
  error_message: string | null
  page_count: number | null
}

/** Canonical projection used by every helper — one source of truth. */
const DASHBOARD_COLUMNS = [
  'id',
  'source_url',
  'status',
  'grade',
  'score',
  'current_phase',
  'phase_progress_pct',
  'substep',
  'cost_cents',
  'created_at',
  'finished_at',
  'published_at',
  'error_code',
  'error_message',
  'page_count',
] as const

/**
 * Active = anything the merchant still cares about surfacing above
 * the fold. `failed` belongs here because the merchant needs a
 * Resume CTA; completed-and-verified jobs are in the ready-banner
 * instead; history catches everything else.
 */
export async function listActiveJobs(
  db: Kysely<Database>,
  shopId: string,
): Promise<DashboardJobRow[]> {
  const rows = await (db as any)
    .selectFrom('storefront_clone_jobs')
    .where('shop_id', '=', shopId)
    .where('status', 'in', ['running', 'paused', 'failed'])
    .select(DASHBOARD_COLUMNS as unknown as string[])
    .orderBy('created_at', 'desc')
    .execute()
  return rows as DashboardJobRow[]
}

/**
 * Ready to publish = verification passed, merchant hasn't clicked
 * either Publish or Discard yet. Ordered by verification finish time
 * so newest appear first (merchants typically publish the clone they
 * just inspected, not an older one).
 */
export async function getReadyToPublishJobs(
  db: Kysely<Database>,
  shopId: string,
): Promise<DashboardJobRow[]> {
  const rows = await (db as any)
    .selectFrom('storefront_clone_jobs')
    .where('shop_id', '=', shopId)
    .where('status', '=', 'succeeded')
    .where('published_at', 'is', null)
    .where('discarded_at', 'is', null)
    .select(DASHBOARD_COLUMNS as unknown as string[])
    .orderBy('finished_at', 'desc')
    .execute()
  return rows as DashboardJobRow[]
}

export interface JobHistoryOptions {
  shopId: string
  statusFilter?: string
  search?: string
  limit: number
  offset: number
}

/**
 * History = the full paginated table beneath the active / ready
 * blocks. Filters are optional:
 *
 *   - statusFilter → exact status match (for the filter pill).
 *   - search       → case-insensitive substring match on source_url.
 *                    Uses ILIKE so 'shop2' matches 'https://Shop2.com'.
 *
 * Returns both the rows and a total count so the UI can render
 * "Showing 25 of 137" and pagination controls.
 */
export async function listJobHistory(
  db: Kysely<Database>,
  opts: JobHistoryOptions,
): Promise<{ rows: DashboardJobRow[]; total: number }> {
  const buildBase = () => {
    let q: any = (db as any)
      .selectFrom('storefront_clone_jobs')
      .where('shop_id', '=', opts.shopId)
    if (opts.statusFilter) q = q.where('status', '=', opts.statusFilter)
    if (opts.search) q = q.where('source_url', 'ilike', `%${opts.search}%`)
    return q
  }

  const rows = await buildBase()
    .select(DASHBOARD_COLUMNS as unknown as string[])
    .orderBy('created_at', 'desc')
    .limit(opts.limit)
    .offset(opts.offset)
    .execute()

  // Rebuild the filter chain for the count — reusing the same
  // builder from above would include limit/offset.
  const countRow = await buildBase()
    .select((eb: any) => eb.fn.countAll().as('n'))
    .executeTakeFirstOrThrow()

  return {
    rows: rows as DashboardJobRow[],
    total: Number((countRow as { n: number | string }).n ?? 0),
  }
}

export interface DashboardStats {
  total: number
  published: number
  avgGrade: string    // 'A' | 'B' | 'C' | 'D' | 'F' | '—'
  costCents30d: number
}

/**
 * Stats strip data. Pulls a narrow column set for every job in the
 * shop then aggregates in JS (simpler than a three-branch SQL). If a
 * shop ever grows past ~50k jobs this should move to SQL aggregation,
 * but that's a long way off for typical merchant usage.
 */
export async function getDashboardStats(
  db: Kysely<Database>,
  shopId: string,
): Promise<DashboardStats> {
  const rows = (await (db as any)
    .selectFrom('storefront_clone_jobs')
    .where('shop_id', '=', shopId)
    .select(['status', 'grade', 'cost_cents', 'published_at', 'created_at'])
    .execute()) as Array<{
    status: string
    grade: string | null
    cost_cents: number | null
    published_at: string | null
    created_at: string | Date
  }>

  const total = rows.length
  const published = rows.filter((r) => r.published_at != null).length
  const grades = rows.map((r) => r.grade).filter((g): g is string => !!g)
  const avgGrade = averageGradeLabel(grades)

  const cutoff = Date.now() - 30 * 24 * 3600_000
  const costCents30d = rows
    .filter((r) => {
      const t = r.created_at instanceof Date ? r.created_at.getTime() : new Date(r.created_at).getTime()
      return t >= cutoff
    })
    .reduce((s, r) => s + (r.cost_cents ?? 0), 0)

  return { total, published, avgGrade, costCents30d }
}

/**
 * Map a list of letter grades to an aggregate letter. Exported for
 * unit-testability. Buckets:
 *
 *   avg >= 3.5 → A
 *   avg >= 2.5 → B
 *   avg >= 1.5 → C
 *   avg >= 0.5 → D
 *   otherwise  → F
 *
 * Empty list → em-dash (stats strip displays "—" instead of "F").
 */
export function averageGradeLabel(grades: readonly string[]): string {
  if (grades.length === 0) return '—'
  const score: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 }
  const avg = grades.reduce((s, g) => s + (score[g] ?? 0), 0) / grades.length
  if (avg >= 3.5) return 'A'
  if (avg >= 2.5) return 'B'
  if (avg >= 1.5) return 'C'
  if (avg >= 0.5) return 'D'
  return 'F'
}
