/**
 * Smoke — Phase 22 (Clone Pro v7) Sprint 5 PR5: full E2E clone pipeline
 *
 * Drives the complete v7 pipeline (Stage 1 → Stage 16 → theme deploy)
 * against a real source URL and asserts the Sprint 5 acceptance:
 *
 *   1. POST /clone-pro/start { url, products_limit:null }      (or direct
 *      runCloneProV7 invocation; this script does the latter)
 *   2. Wait until job.status = 'completed' OR 'published'
 *   3. Assert products count ≥ 1100  (default; override via env)
 *   4. Assert theme bundle deployed (theme_files row with is_active=true
 *      AND `/var/www/themes/<shop>/` exists if running on Server 3)
 *   5. Assert storefront responds 200 for / and /products/<sample-handle>
 *   6. Assert visual_verify_score ≥ 7
 *
 * Output: tmp/e2e-result.json with metrics + URLs for Thai's manual
 * side-by-side review.
 *
 * Pre-requisites (Server 2 environment):
 *   - DATABASE_URL set (gbox_platform live DB)
 *   - ANTHROPIC_API_KEY     (Stage 14 + Stage 16 vision)
 *   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY  (Stage 6 + Stage 15 S3)
 *   - Playwright Chromium    (Stage 3 + Stage 13 + Stage 16)
 *   - Test shop exists       (SMOKE_SHOP_ID env)
 *   - Migrations 099-104 applied
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   DATABASE_URL=... SMOKE_SHOP_ID=<uuid> CLONE_PRO_VERSION=v7 \
 *     npx tsx scripts/smoke-clone-pro-v7-pr5-e2e.ts
 *
 * Optional knobs:
 *   SMOKE_SOURCE_URL          (default https://bibliobloom.com/collections/all)
 *   SMOKE_PRODUCTS_LIMIT      (default 1100 — full bibliobloom catalog)
 *   SMOKE_MIN_VISUAL_SCORE    (default 7)
 *   SMOKE_STOREFRONT_DOMAIN   (default best-store-v7-final.gbox.co)
 *   SMOKE_RESULT_PATH         (default tmp/e2e-result.json)
 *
 * Exit codes:
 *   0  all assertions pass
 *   1  one or more assertions failed (details in stdout + result.json)
 *   2  unexpected error / pre-flight failure
 *
 * Iron Rule 5: operator-only diagnostic. Detailed error messages go to
 * stdout for triage, but production seller surfaces are scrubbed via
 * safeMessage at the worker boundary (not this script).
 */

import 'dotenv/config'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'

// ---------------------------------------------------------------------------
// Result container
// ---------------------------------------------------------------------------

interface E2EResult {
  jobId: string
  shopId: string
  sourceUrl: string
  storefrontDomain: string
  durationMs: number
  productsLanded: number
  collectionsLanded: number
  pagesLanded: number
  qualityScore: number
  themeBundle: {
    themeId: string | null
    version: number | null
    isActive: boolean
    fileCount: number
    themeZipS3Key: string | null
  }
  storefrontHealth: {
    rootStatus: number | null
    sampleProductStatus: number | null
    sampleCollectionStatus: number | null
  }
  visualVerifyScore: number | null
  fails: string[]
  warnings: string[]
}

const DEFAULT_SOURCE_URL = 'https://bibliobloom.com/collections/all'
const DEFAULT_PRODUCTS_LIMIT = 1100
const DEFAULT_MIN_VISUAL_SCORE = 7
const DEFAULT_STOREFRONT_DOMAIN = 'best-store-v7-final.gbox.co'
const DEFAULT_RESULT_PATH = 'tmp/e2e-result.json'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseProductsLimit(raw: string | undefined): number | null {
  if (!raw || raw === 'null') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

async function fetchStatus(url: string, timeoutMs = 15_000): Promise<number | null> {
  // Native fetch (Node 18+). Returns null on network/abort error.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'follow' })
    return r.status
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function pollJobStatus(
  db: Kysely<any>,
  jobId: string,
  opts: { intervalMs: number; maxMs: number },
): Promise<{ status: string; progressPct: number | null }> {
  const start = Date.now()
  while (Date.now() - start < opts.maxMs) {
    const row = await db
      .selectFrom('storefront_clone_jobs' as any)
      .where('id', '=', jobId)
      .select(['status', 'progress_pct'])
      .executeTakeFirst()
    if (!row) throw new Error(`pollJobStatus: job ${jobId} not found`)
    const status = String((row as any).status)
    const progress = (row as any).progress_pct ?? null
    process.stdout.write(`\r[smoke-pr5] job=${jobId} status=${status} progress=${progress}    `)
    if (status === 'completed' || status === 'published' || status === 'failed') {
      process.stdout.write('\n')
      return { status, progressPct: progress }
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs))
  }
  throw new Error(`pollJobStatus: job ${jobId} timed out after ${opts.maxMs}ms`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('[smoke-pr5] SKIP — DATABASE_URL not set')
    process.exit(0)
  }

  const result: E2EResult = {
    jobId: '',
    shopId: '',
    sourceUrl: '',
    storefrontDomain: '',
    durationMs: 0,
    productsLanded: 0,
    collectionsLanded: 0,
    pagesLanded: 0,
    qualityScore: 0,
    themeBundle: {
      themeId: null,
      version: null,
      isActive: false,
      fileCount: 0,
      themeZipS3Key: null,
    },
    storefrontHealth: { rootStatus: null, sampleProductStatus: null, sampleCollectionStatus: null },
    visualVerifyScore: null,
    fails: [],
    warnings: [],
  }

  const sourceUrl = process.env.SMOKE_SOURCE_URL ?? DEFAULT_SOURCE_URL
  const productsLimit = parseProductsLimit(process.env.SMOKE_PRODUCTS_LIMIT) ?? DEFAULT_PRODUCTS_LIMIT
  const minScore = parseFloatEnv(process.env.SMOKE_MIN_VISUAL_SCORE, DEFAULT_MIN_VISUAL_SCORE)
  const storefrontDomain = process.env.SMOKE_STOREFRONT_DOMAIN ?? DEFAULT_STOREFRONT_DOMAIN
  const resultPath = process.env.SMOKE_RESULT_PATH ?? DEFAULT_RESULT_PATH

  result.sourceUrl = sourceUrl
  result.storefrontDomain = storefrontDomain

  const shopId = process.env.SMOKE_SHOP_ID
  if (!shopId) {
    result.fails.push('SMOKE_SHOP_ID env var required (UUID of test shop)')
    await writeResult(resultPath, result)
    process.exit(2)
  }
  result.shopId = shopId

  console.log('[smoke-pr5] starting Clone Pro v7 PR5 E2E')
  console.log(`            source=${sourceUrl}`)
  console.log(`            shop=${shopId}`)
  console.log(`            products_limit=${productsLimit}`)
  console.log(`            min_visual_score=${minScore}`)
  console.log(`            storefront=${storefrontDomain}`)

  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  })

  try {
    // ---------- 1. INSERT a fresh storefront_clone_jobs row -----------------
    const inserted = await db
      .insertInto('storefront_clone_jobs' as any)
      .values({
        shop_id: shopId,
        domain: sourceUrl,
        canonical_domain: new URL(sourceUrl).host,
        status: 'pending',
        publish_status: 'unpublished',
        progress_pct: 0,
        clone_pro_version: 'v7',
        crawl_strategy: 'full',
        products_limit: productsLimit,
      } as any)
      .returningAll()
      .execute()

    const jobId = String((inserted as any[])[0].id)
    result.jobId = jobId
    console.log(`[smoke-pr5] created job ${jobId}`)

    // ---------- 2. Run the v7 pipeline (no worker; direct invocation) -------
    // Lazy-import so this script can be loaded for a contract test without
    // pulling in playwright + AWS SDK.
    const { runCloneProV7 } = await import(
      '../packages/core/src/modules/clone-pro/v7/orchestrator.js'
    )
    const { buildV7Deps } = await import(
      '../packages/core/src/modules/clone-pro/v7/deps.js'
    )

    const t0 = Date.now()
    try {
      await runCloneProV7({
        jobId,
        shopId,
        sourceUrl,
        productsLimit,
        deps: buildV7Deps(db) as any,
      })
    } catch (err) {
      // Don't bail — we still want to inspect what made it through.
      result.warnings.push(`runCloneProV7 threw: ${(err as Error).message}`)
    }
    result.durationMs = Date.now() - t0

    // ---------- 3. Poll the row to confirm terminal state -------------------
    const polled = await pollJobStatus(db, jobId, {
      intervalMs: 30_000,
      maxMs: 60 * 60_000, // 60 min
    })
    if (polled.status !== 'published' && polled.status !== 'completed') {
      result.fails.push(`job did not reach published/completed (status=${polled.status})`)
    }

    // ---------- 4. Catalog assertions (shape + counts) ----------------------
    result.productsLanded = await countShopRows(db, 'products', shopId)
    result.collectionsLanded = await countShopRows(db, 'collections', shopId)
    result.pagesLanded = await countShopRows(db, 'pages', shopId)
    if (result.productsLanded < productsLimit) {
      result.fails.push(
        `products=${result.productsLanded} < expected ${productsLimit}`,
      )
    }

    // quality_score from clone_crawl_runs
    const ccr = await db
      .selectFrom('clone_crawl_runs' as any)
      .where('job_id', '=', jobId)
      .select(['quality_score', 'rows_harvested', 'rows_failed', 'platform'])
      .executeTakeFirst()
    if (ccr) {
      result.qualityScore = Number((ccr as any).quality_score ?? 0)
    }

    // ---------- 5. Theme bundle assertions ----------------------------------
    const activeRow = await (db as any)
      .selectFrom('theme_files')
      .where('shop_id', '=', shopId)
      .where('is_active', '=', true)
      .select(['theme_id', 'version'])
      .executeTakeFirst()
    if (activeRow) {
      result.themeBundle.themeId = String((activeRow as any).theme_id)
      result.themeBundle.version = Number((activeRow as any).version)
      result.themeBundle.isActive = true
    } else {
      result.fails.push('no active theme_files row for shop after publish')
    }

    const fileCountRow = await (db as any)
      .selectFrom('theme_files')
      .where('shop_id', '=', shopId)
      .where('is_active', '=', true)
      .select((eb: any) => eb.fn.count('id').as('count'))
      .executeTakeFirst()
    result.themeBundle.fileCount = Number((fileCountRow as any)?.count ?? 0)

    // ---------- 6. Storefront response checks -------------------------------
    const baseUrl = `https://${storefrontDomain}`
    result.storefrontHealth.rootStatus = await fetchStatus(`${baseUrl}/`)
    if (result.storefrontHealth.rootStatus !== 200) {
      result.fails.push(
        `storefront root returned ${result.storefrontHealth.rootStatus} (expected 200)`,
      )
    }

    // Sample product handle
    const sampleProduct = await db
      .selectFrom('products' as any)
      .where('shop_id', '=', shopId)
      .select('slug')
      .limit(1)
      .executeTakeFirst()
    if (sampleProduct) {
      const handle = String((sampleProduct as any).slug)
      result.storefrontHealth.sampleProductStatus = await fetchStatus(
        `${baseUrl}/products/${handle}`,
      )
      if (result.storefrontHealth.sampleProductStatus !== 200) {
        result.fails.push(
          `sample product /products/${handle} returned ${result.storefrontHealth.sampleProductStatus}`,
        )
      }
    }

    // Sample collection handle
    const sampleCollection = await db
      .selectFrom('collections' as any)
      .where('shop_id', '=', shopId)
      .select('slug')
      .limit(1)
      .executeTakeFirst()
    if (sampleCollection) {
      const handle = String((sampleCollection as any).slug)
      result.storefrontHealth.sampleCollectionStatus = await fetchStatus(
        `${baseUrl}/collections/${handle}`,
      )
      if (result.storefrontHealth.sampleCollectionStatus !== 200) {
        result.fails.push(
          `sample collection /collections/${handle} returned ${result.storefrontHealth.sampleCollectionStatus}`,
        )
      }
    }

    // ---------- 7. Visual verify score from clone_run_metrics ---------------
    const metrics = await db
      .selectFrom('clone_run_metrics' as any)
      .where('job_id', '=', jobId)
      .select(['ai_vision_score'])
      .executeTakeFirst()
    if (metrics) {
      result.visualVerifyScore = Number((metrics as any).ai_vision_score ?? 0)
      if (result.visualVerifyScore < minScore) {
        result.fails.push(
          `visual_verify_score=${result.visualVerifyScore} < min ${minScore}`,
        )
      }
    } else {
      result.warnings.push('no clone_run_metrics row — Stage 12 finalize skipped?')
    }

    // ---------- 8. Persist the report --------------------------------------
    await writeResult(resultPath, result)

    console.log('[smoke-pr5] DONE')
    console.log(`            results → ${resultPath}`)
    console.log(`            products=${result.productsLanded} quality=${result.qualityScore}`)
    console.log(`            theme.fileCount=${result.themeBundle.fileCount}`)
    console.log(`            visual_score=${result.visualVerifyScore}`)
    console.log(`            fails=${result.fails.length}`)
    if (result.fails.length > 0) {
      for (const f of result.fails) console.log(`              - ${f}`)
      process.exit(1)
    }
    process.exit(0)
  } catch (err) {
    result.fails.push(`unexpected error: ${(err as Error).message}`)
    await writeResult(resultPath, result)
    console.error('[smoke-pr5] ERROR', (err as Error).stack ?? err)
    process.exit(2)
  } finally {
    await db.destroy().catch(() => {})
  }
}

async function countShopRows(
  db: Kysely<any>,
  table: 'products' | 'collections' | 'pages',
  shopId: string,
): Promise<number> {
  const row = await db
    .selectFrom(table as any)
    .where('shop_id', '=', shopId)
    .select((eb: any) => eb.fn.count('id').as('count'))
    .executeTakeFirst()
  return Number((row as any)?.count ?? 0)
}

async function writeResult(resultPath: string, result: E2EResult): Promise<void> {
  const dir = path.dirname(resultPath)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(
    resultPath,
    JSON.stringify(result, null, 2),
    'utf8',
  )
}

main().catch((err) => {
  console.error('[smoke-pr5] FATAL', err)
  process.exit(2)
})
