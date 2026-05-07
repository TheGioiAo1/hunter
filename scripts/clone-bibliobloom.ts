/**
 * One-shot script: Clone bibliobloom.com → tw3.store (shop: diepanhtest)
 *
 * Usage (from project root, on server 2):
 *   node --import tsx scripts/clone-bibliobloom.ts
 */

import pg from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { createStorefrontCloneJob } from '../packages/core/src/modules/storefront-clone/job-store.js'
import { runStorefrontClone } from '../packages/core/src/modules/storefront-clone/run.js'

const SHOP_ID = '8baf2545-d37c-4d57-a6f7-601e0b234b6a'
const USER_ID = 'acab45a6-cc7b-4219-95c3-d24690c90383'
const SOURCE_URL = 'https://bibliobloom.com'

async function main() {
  console.log('🔌 Connecting to database...')
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: 'postgresql://gbox:GboxPlatform2026@localhost:5432/gbox_platform',
      }),
    }),
  })

  try {
    // 1. Create clone job
    console.log(`📋 Creating clone job for ${SOURCE_URL} → shop ${SHOP_ID}...`)
    const job = await createStorefrontCloneJob(db, {
      shopId: SHOP_ID,
      sourceUrl: SOURCE_URL,
      createdBy: USER_ID,
    })
    console.log(`✅ Job created: ${job.id}`)

    // 2. Run the clone pipeline
    console.log('🚀 Starting clone pipeline...')
    console.log('   Stage: products → crawl Shopify /products.json')
    console.log('   Stage: brand_kit → extract colors/fonts from CSS')
    console.log('')

    const result = await runStorefrontClone(db, {
      shopId: SHOP_ID,
      jobId: job.id,
      sourceUrl: SOURCE_URL,
      maxProducts: 2000,
      extractBrandKit: true,
      // No objectStore → media ingest skipped (Phase 3.A behavior)
    })

    console.log('')
    console.log('═══════════════════════════════════════════════════')
    console.log('  ✅ CLONE COMPLETED SUCCESSFULLY')
    console.log('═══════════════════════════════════════════════════')
    console.log(`  Job ID:           ${result.jobId}`)
    console.log(`  Products inserted: ${result.productsInserted}`)
    console.log(`  Products updated:  ${result.productsUpdated}`)
    console.log(`  Variants written:  ${result.variantsWritten}`)
    console.log(`  Images written:    ${result.imagesWritten}`)
    console.log('═══════════════════════════════════════════════════')
  } catch (err: any) {
    console.error('❌ Clone failed:', err.message)
    console.error(err.stack)
    process.exitCode = 1
  } finally {
    await db.destroy()
    console.log('🔌 Database connection closed.')
  }
}

main()
