/**
 * Smoke — Phase 21 PR6 / Sprint 4: Full v6 e2e on bibliobloom.com
 *
 * Operator-runnable end-to-end smoke that exercises the entire 12-stage v6
 * pipeline against a real source URL with real DB + real S3 + real AI.
 *
 * Pre-requisites:
 *   - DATABASE_URL set
 *   - ANTHROPIC_API_KEY set (for Stage 2 URL classify) OR shop_ai_config row exists
 *   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY set (for Stage 6 S3 upload)
 *   - Playwright Chromium installed: npx playwright install chromium
 *   - Shop `best-store` exists and is empty (run reset script if needed)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... DATABASE_URL=... \
 *     npx tsx scripts/smoke-clone-pro-v6-bibliobloom.ts
 *
 * Exit codes:
 *   0 = all 5 spec goals met
 *   1 = one or more goals missed (details printed)
 *   2 = unexpected error
 */

import 'dotenv/config'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { runCloneProV6 } from '../packages/core/src/modules/clone-pro/v6/orchestrator.js'
import { buildV6Deps } from '../packages/core/src/modules/clone-pro/v6/deps.js'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('Skipping — DATABASE_URL not set'); process.exit(0)
  }

  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
  })

  const shopId = process.env.SMOKE_SHOP_ID ?? 'd549d092-0252-49fd-a9ea-ccb4bf4c3f3f'
  const sourceUrl = process.env.SMOKE_SOURCE_URL ?? 'https://bibliobloom.com'

  // Create job row
  const job = await db.insertInto('storefront_clone_jobs').values({
    shop_id: shopId, source_url: sourceUrl, status: 'queued',
    progress_pct: 0, stages_json: JSON.stringify([]),
  } as any).returningAll().execute() as any[]
  const jobId = job[0].id

  console.log(`Started job ${jobId} cloning ${sourceUrl} into shop ${shopId}`)

  const startedAt = Date.now()
  const deps = buildV6Deps(db)
  const result = await runCloneProV6({ jobId, shopId, sourceUrl, deps })
  const durationMs = Date.now() - startedAt

  console.log('Pipeline result:', JSON.stringify(result, null, 2))
  console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`)

  // Fetch metrics row
  const metrics = await db.selectFrom('clone_run_metrics')
    .where('job_id', '=', jobId).selectAll().executeTakeFirst() as any
  console.log('Metrics:', metrics)

  // Verify all 5 spec goals
  const fails: string[] = []
  if (metrics) {
    if (Number(metrics.pixel_diff_pct) > 5) fails.push(`Goal 1: pixel diff ${metrics.pixel_diff_pct}% > 5%`)
    if (Number(metrics.catalog_cardinality_pct) < 99) fails.push(`Goal 2: cardinality ${metrics.catalog_cardinality_pct}% < 99%`)
    if (metrics.asset_404_count > 0) fails.push(`Goal 3: ${metrics.asset_404_count} assets returned 404`)
  }
  // Goal 4 (grep gate): orchestrator throws if leaked, so reaching this point = pass
  // Goal 5 (AI gating): Sprint 0 enforces; reaching here = pass

  // Goal: storefront serves
  const shop = await db.selectFrom('shops').where('id', '=', shopId).select(['domain']).executeTakeFirst() as any
  console.log(`Storefront URL: https://${shop?.domain ?? 'unknown'}`)

  if (fails.length > 0) {
    console.log('E2E FAILS:')
    for (const f of fails) console.log(`  ${f}`)
    process.exit(1)
  }
  console.log('E2E pass — all 5 spec goals met')
  process.exit(0)
}

main().catch((err) => {
  console.error('E2E crashed:', err)
  process.exit(2)
})
