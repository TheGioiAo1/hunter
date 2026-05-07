/**
 * Smoke — Phase 22 (Clone Pro v7) Sprint 2 PR2: bulk-catalog e2e
 * against bibliobloom.com (classic Shopify, ~1100+ products).
 *
 * Sprint 2 Task 2.9. Drives runCloneProV7 end-to-end against a real
 * Shopify storefront and asserts the spec acceptance criteria from
 * phase-02-pipeline-integration.md §Acceptance:
 *
 *   - 200 products land in DB (default sample) OR specify SMOKE_PRODUCTS_LIMIT
 *   - quality_score ≥ 0.95 in clone_crawl_runs row
 *   - ≥70% of products have ≥1 variant
 *   - ≥90% of products have ≥3 images
 *   - ≥90% of products have description ≥200 chars
 *   - clone_crawl_runs row written with platform / config_used /
 *     duration_ms populated
 *
 * Pre-requisites:
 *   - DATABASE_URL set
 *   - ANTHROPIC_API_KEY (for Stage 2 URL classify) OR shop_ai_config row exists
 *   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (for Stage 6 S3 upload)
 *   - Playwright Chromium installed: npx playwright install chromium
 *   - Test shop exists (SMOKE_SHOP_ID env var) — recommend creating
 *     `best-store-v7` per the plan.
 *   - Migrations 099, 100, 103 applied.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   DATABASE_URL=... CLONE_PRO_VERSION=v7 \
 *     npx tsx scripts/smoke-clone-pro-v7-pr2.ts
 *
 * Optional env knobs:
 *   SMOKE_SOURCE_URL    — defaults to https://bibliobloom.com/collections/all
 *   SMOKE_PRODUCTS_LIMIT — defaults to 200 (set 'null' for full crawl)
 *   SMOKE_SHOP_ID       — UUID of test shop
 *
 * Exit codes:
 *   0 = all spec goals met
 *   1 = one or more goals missed (details printed)
 *   2 = unexpected error
 *
 * Iron Rule 5: this script is operator-only — it prints stage names +
 * raw error details to stdout for diagnostic purposes. Seller-facing
 * surfaces (worker logs / DB rows) scrub these via safeMessage.
 */

import 'dotenv/config'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { runCloneProV7 } from '../packages/core/src/modules/clone-pro/v7/orchestrator.js'
import { buildV7Deps } from '../packages/core/src/modules/clone-pro/v7/deps.js'

interface SmokeResult {
  jobId: string
  durationMs: number
  productsLanded: number
  qualityScore: number
  productsWithVariants: number
  productsWith3PlusImages: number
  productsWithLongDescription: number
  fails: string[]
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('Skipping — DATABASE_URL not set')
    process.exit(0)
  }

  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  })

  const shopId =
    process.env.SMOKE_SHOP_ID ?? 'd549d092-0252-49fd-a9ea-ccb4bf4c3f3f'
  const sourceUrl =
    process.env.SMOKE_SOURCE_URL ?? 'https://bibliobloom.com/collections/all'
  const productsLimit = parseProductsLimit(process.env.SMOKE_PRODUCTS_LIMIT)

  console.log(
    `[smoke-v7-pr2] shop=${shopId} url=${sourceUrl} limit=${productsLimit}`,
  )

  // Create job row.
  const jobInsert = (await db
    .insertInto('storefront_clone_jobs')
    .values({
      shop_id: shopId,
      source_url: sourceUrl,
      status: 'running',
      progress_pct: 0,
      stages_json: JSON.stringify([]),
      products_limit: productsLimit,
      crawl_strategy: productsLimit == null ? 'full' : 'sample',
      clone_pro_version: 'v7',
    } as any)
    .returningAll()
    .execute()) as any[]
  const jobId = jobInsert[0].id as string

  console.log(`[smoke-v7-pr2] started job ${jobId}`)

  const startedAt = Date.now()
  const deps = buildV7Deps(db)
  let result: Awaited<ReturnType<typeof runCloneProV7>>
  try {
    result = await runCloneProV7({
      jobId,
      shopId,
      sourceUrl,
      productsLimit,
      deps,
    })
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[smoke-v7-pr2] pipeline crashed: ${msg}`)
    await markJobFailed(db, jobId, msg)
    process.exit(2)
  }
  const durationMs = Date.now() - startedAt

  console.log(`[smoke-v7-pr2] pipeline finished in ${(durationMs / 1000).toFixed(1)}s`)
  console.log(`[smoke-v7-pr2] stage4: ${JSON.stringify(result.stage4)}`)
  console.log(`[smoke-v7-pr2] stage10 grade: ${result.stage10.letter} (${result.stage10.score})`)

  // Fetch the audit row.
  const crawlRun = (await db
    .selectFrom('clone_crawl_runs')
    .where('job_id', '=', jobId)
    .selectAll()
    .executeTakeFirst()) as any
  console.log(`[smoke-v7-pr2] clone_crawl_runs row:`, crawlRun)

  // Catalog assertions — count actual rows in DB.
  const rows = (await db
    .selectFrom('products')
    .where('shop_id', '=', shopId)
    .where('clone_job_id', '=', jobId)
    .selectAll()
    .execute()) as any[]

  const productIds = rows.map((r) => r.id as string)

  let productsWithVariants = 0
  let productsWith3PlusImages = 0
  let productsWithLongDescription = 0

  for (const row of rows) {
    const desc = String(row.body_html ?? '')
    if (desc.length >= 200) productsWithLongDescription++
  }
  if (productIds.length > 0) {
    const variantCounts = (await db
      .selectFrom('product_variants')
      .where('product_id', 'in', productIds)
      .select((eb: any) => [
        eb.fn.count('id').as('cnt'),
        'product_id',
      ])
      .groupBy('product_id')
      .execute()) as any[]
    productsWithVariants = variantCounts.filter((c) => Number(c.cnt) >= 1).length

    const imageCounts = (await db
      .selectFrom('product_images')
      .where('product_id', 'in', productIds)
      .select((eb: any) => [
        eb.fn.count('id').as('cnt'),
        'product_id',
      ])
      .groupBy('product_id')
      .execute()) as any[]
    productsWith3PlusImages = imageCounts.filter((c) => Number(c.cnt) >= 3).length
  }

  const qualityScore = crawlRun ? Number(crawlRun.quality_score) : 0

  const fails: string[] = []
  const productsLanded = rows.length

  // Goal 1: ≥190 products (95% of 200) — accept ≥95% of requested if explicit.
  const expectedFloor = productsLimit == null ? 1000 : Math.floor(productsLimit * 0.95)
  if (productsLanded < expectedFloor) {
    fails.push(
      `products landed ${productsLanded} < expected ${expectedFloor} (${productsLimit ?? 'full'} requested × 0.95)`,
    )
  }

  // Goal 2: quality_score ≥ 0.95
  if (qualityScore < 0.95) {
    fails.push(`quality_score ${qualityScore} < 0.95`)
  }

  // Goal 3: ≥70% products have ≥1 variant
  const variantPct = productsLanded > 0 ? productsWithVariants / productsLanded : 0
  if (variantPct < 0.7) {
    fails.push(`variants pct ${(variantPct * 100).toFixed(1)}% < 70%`)
  }

  // Goal 4: ≥90% products have ≥3 images
  const imagePct = productsLanded > 0 ? productsWith3PlusImages / productsLanded : 0
  if (imagePct < 0.9) {
    fails.push(`images-≥3 pct ${(imagePct * 100).toFixed(1)}% < 90%`)
  }

  // Goal 5: ≥90% products have description ≥200 chars
  const descPct = productsLanded > 0 ? productsWithLongDescription / productsLanded : 0
  if (descPct < 0.9) {
    fails.push(`description-≥200 pct ${(descPct * 100).toFixed(1)}% < 90%`)
  }

  // Goal 6: clone_crawl_runs row exists with platform + config_used populated
  if (!crawlRun) {
    fails.push('no clone_crawl_runs row written')
  } else {
    if (!crawlRun.platform) fails.push('clone_crawl_runs.platform is NULL')
    if (!crawlRun.config_used) fails.push('clone_crawl_runs.config_used is NULL')
    if (!Number.isFinite(Number(crawlRun.duration_ms))) {
      fails.push('clone_crawl_runs.duration_ms is NULL')
    }
  }

  const summary: SmokeResult = {
    jobId,
    durationMs,
    productsLanded,
    qualityScore,
    productsWithVariants,
    productsWith3PlusImages,
    productsWithLongDescription,
    fails,
  }
  console.log('[smoke-v7-pr2] summary:', summary)

  if (fails.length > 0) {
    console.error('[smoke-v7-pr2] FAILS:')
    for (const f of fails) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('[smoke-v7-pr2] PASS — all spec goals met')
  process.exit(0)
}

function parseProductsLimit(raw: string | undefined): number | null {
  if (raw == null || raw === '') return 200
  if (raw.toLowerCase() === 'null' || raw.toLowerCase() === 'none') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 200
}

async function markJobFailed(
  db: Kysely<any>,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await db
      .updateTable('storefront_clone_jobs')
      .set({
        status: 'failed',
        error_message: errorMessage.slice(0, 1000),
        finished_at: new Date().toISOString(),
      } as any)
      .where('id', '=', jobId)
      .execute()
  } catch {
    // best-effort
  }
}

main().catch((err) => {
  console.error('[smoke-v7-pr2] unexpected error:', err)
  process.exit(2)
})
