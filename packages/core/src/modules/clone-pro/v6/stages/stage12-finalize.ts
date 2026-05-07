import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export interface Stage12Input {
  db: Kysely<Database>
  jobId: string
  shopId: string
  metrics: {
    pixelDiffPct: number
    cardinalityPct: number
    cardinalityProductsActual: number
    cardinalityProductsSource: number
    asset404Count: number
    aiCostUsdCents: number
    totalAssetBytes: number
    durationMs: number
    grade: { letter: string; score: number; perCheck: any }
  }
  designMd: string
  resultJson: Record<string, unknown>
}

export async function runStage12(input: Stage12Input): Promise<void> {
  // Persist metrics row
  await (input.db as any)
    .insertInto('clone_run_metrics')
    .values({
      job_id: input.jobId,
      pixel_diff_pct: String(input.metrics.pixelDiffPct),
      asset_404_count: input.metrics.asset404Count,
      catalog_products_actual: input.metrics.cardinalityProductsActual,
      catalog_products_source_estimate: input.metrics.cardinalityProductsSource,
      catalog_cardinality_pct: String(input.metrics.cardinalityPct),
      grade_letter: input.metrics.grade.letter,
      grade_score: input.metrics.grade.score,
      per_check_breakdown_json: JSON.stringify(input.metrics.grade.perCheck),
      total_ai_cost_usd_cents: input.metrics.aiCostUsdCents,
      total_asset_bytes: String(input.metrics.totalAssetBytes),
      duration_ms: input.metrics.durationMs,
    })
    .execute()

  // Persist DESIGN.md + result_json on the job row
  await (input.db as any)
    .updateTable('storefront_clone_jobs')
    .set({
      design_md: input.designMd,
      stages_json: JSON.stringify(input.resultJson),
    })
    .where('id', '=', input.jobId)
    .execute()
}
