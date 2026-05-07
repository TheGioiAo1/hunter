/**
 * Phase 19 PR1 REAL-WEB E2E smoke — Clone Pro v5 against live Shopify URLs.
 *
 * Drives the full pipeline via `runCloneProV5Wired` + `buildV5Deps`:
 *   ① detect platform (HTTP GET /products.json)
 *   ② fetch homepage HTML
 *   ③ scrape products + collections + pages + menu + theme
 *   ④ validate (R3 guardrails)
 *   ⑤ persist inside SERIALIZABLE tx
 *   ⑦ mount preview row
 *   ⑧ HEAD-check every imported URL on origin host
 *   ⑨ grade + export DESIGN.md
 *
 * NOT part of smoke-matrix — not Windows-runnable (needs live pg + live
 * internet + Shopify target). Run from server 2:
 *
 *   TARGET_URL=https://www.allbirds.com \
 *   DATABASE_URL='postgresql://gbox:...@192.168.1.13:5432/gbox_platform' \
 *   npx tsx scripts/smoke-phase19-pr1-real-web.ts
 *
 * Self-cleans: seeds a test shop + job row, runs the pipeline, prints
 * result + grade + sample persisted counts, then DROPs the shop
 * (CASCADE wipes everything).
 *
 * Why a separate script from `smoke-phase19-pr1-live-db.ts`:
 *   - That one uses hand-crafted DTOs — proves the DB stack in isolation.
 *   - This one hits live HTTP — proves the full 9-phase pipeline works
 *     against real Shopify stores (the Step 4 manual E2E from the plan).
 *
 * Caveats: Shopify's /products.json defaults to 30 per page. On a large
 * store the script takes minutes + uses real bandwidth. Cap via
 * MAX_PAGES env (defaults 2 for quick runs); set MAX_PAGES=9999 for
 * a full catalog scrape.
 */

import 'dotenv/config'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Database } from '../packages/db/src/schema/tables.js'
import { runCloneProV5Wired } from '../packages/core/src/modules/clone-pro/v5/wired-runner.js'
import { buildV5Deps } from '../packages/core/src/modules/clone-pro/v5/build-deps.js'
import { updateStorefrontCloneJob } from '../packages/core/src/modules/storefront-clone/job-store.js'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform'
const TARGET_URL = process.env.TARGET_URL ?? 'https://www.allbirds.com'

const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: DATABASE_URL }) }),
})

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`[ok] ${msg}`)
    passed++
  } else {
    console.error(`[FAIL] ${msg}`)
    failed++
  }
}

async function main(): Promise<void> {
  const slugSuffix = Math.random().toString(36).slice(2, 8)
  const shopSlug = `clone-v5-e2e-${slugSuffix}`
  let shopId: string | null = null
  let jobId: string | null = null

  try {
    // Seed minimal shop row — minimum NOT NULL cols only. CASCADE wipes
    // everything on finally-block DELETE.
    const shop = await db
      .insertInto('shops')
      .values({
        slug: shopSlug,
        name: `Clone v5 E2E ${slugSuffix}`,
        email: `${shopSlug}@gbox.local`,
        plan: 'basic',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    shopId = shop.id as string
    console.log(`[ok] seeded test shop (id=${shopId})`)

    // Note: `scope` is passed directly into runCloneProV5Wired below —
    // it's a runtime input, not a persisted DB column. The only DB
    // columns needed to bootstrap the row are shop_id + source_url +
    // status. config_json is optional (admin UI overrides).
    const job = await db
      .insertInto('storefront_clone_jobs')
      .values({
        shop_id: shopId,
        source_url: TARGET_URL,
        status: 'queued',
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    jobId = job.id as string
    console.log(`[ok] seeded test clone job (id=${jobId}) targeting ${TARGET_URL}`)

    // Real-deps bundle — the same thing the worker assembles.
    const deps = buildV5Deps(db)

    console.log(`[..] running runCloneProV5Wired (this fetches ${TARGET_URL} + paginates /products.json)`)
    const result = await runCloneProV5Wired(db, {
      shopId,
      jobId,
      sourceUrl: TARGET_URL,
      scope: {
        products: true,
        collections: true,
        pages: true,
        menu: true,
        theme: true,
      },
      _updateStorefrontCloneJob: updateStorefrontCloneJob as any,
      _deps: deps,
    })

    assert(result.status === 'succeeded', `pipeline status = ${result.status}`)
    if (result.status === 'failed') {
      console.error(`[FAIL] errorMessage: ${result.errorMessage}`)
    } else {
      console.log(`[info] grade=${result.grade} score=${result.score}`)
      console.log(`[info] previewUrl=${result.previewUrl}`)

      assert(typeof result.grade === 'string', 'grade letter returned')
      assert(
        typeof result.score === 'number' && result.score >= 0 && result.score <= 100,
        `score in 0..100 (got ${result.score})`,
      )
      assert(
        typeof result.previewUrl === 'string' && result.previewUrl.includes('clone-'),
        `previewUrl looks canonical (got ${result.previewUrl})`,
      )
    }

    // Verify persisted counts.
    const products = await db
      .selectFrom('products')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('shop_id', '=', shopId)
      .executeTakeFirstOrThrow()
    assert(Number(products.n) > 0, `at least 1 product persisted (got ${products.n})`)

    const jobRow = await db
      .selectFrom('storefront_clone_jobs')
      .selectAll()
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow()
    assert(jobRow.status === 'succeeded', `job row terminal status = ${jobRow.status}`)
    assert(!!(jobRow as any).grade, `job row grade populated (${(jobRow as any).grade})`)
    assert(!!(jobRow as any).preview_url, `job row preview_url populated`)

    const checkpoints = await db
      .selectFrom('clone_checkpoints')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow()
    assert(Number(checkpoints.n) >= 1, `clone_checkpoints row written (got ${checkpoints.n})`)

    const previews = await db
      .selectFrom('cloned_previews')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow()
    assert(Number(previews.n) === 1, `cloned_previews row written (got ${previews.n})`)
  } finally {
    // Cleanup — CASCADE removes everything.
    if (shopId) {
      try {
        // cloned_previews FK to storefront_clone_jobs. Must delete jobs
        // first (their CASCADE then wipes previews), then the shop.
        if (jobId) {
          await db
            .deleteFrom('cloned_previews')
            .where('job_id', '=', jobId)
            .execute()
          await db
            .deleteFrom('clone_checkpoints')
            .where('job_id', '=', jobId)
            .execute()
        }
        await db.deleteFrom('shops').where('id', '=', shopId).execute()
        console.log(`[cleanup] removed test shop + all dependents`)
      } catch (e) {
        console.error(`[cleanup-FAIL] ${(e as Error).message}`)
      }
    }
    await db.destroy()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
