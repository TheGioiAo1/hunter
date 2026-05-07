/**
 * Smoke — Phase 21 PR4 / Sprint 3A: L17 re-clone preserves seller edits
 *
 * Operator-runnable. Verifies the L17 contract: when a seller edits a row
 * (source='edited'), a subsequent re-clone MUST NOT overwrite it. Other
 * source='clone' rows ARE refreshed.
 *
 * This is the canonical end-to-end test for the L17 mandate (spec §7.1).
 *
 * Usage:
 *   DATABASE_URL=postgres://... SMOKE_SHOP_ID=<shop-uuid> npx tsx scripts/smoke-clone-pro-v6-persisters.ts
 *
 * Skips gracefully when DATABASE_URL is missing.
 */

import 'dotenv/config'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { productsPersister } from '../packages/core/src/modules/clone-pro/v6/persisters/products.js'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('Skipping — DATABASE_URL not set')
    process.exit(0)
  }
  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
  })
  const shopId = process.env.SMOKE_SHOP_ID ?? 'd549d092-0252-49fd-a9ea-ccb4bf4c3f3f'

  // Pre-clean
  await db.deleteFrom('products').where('shop_id', '=', shopId)
    .where('slug', 'in', ['smoke-a', 'smoke-b', 'smoke-c']).execute()

  const round1Dtos = ['smoke-a', 'smoke-b', 'smoke-c'].map((h) => ({
    sourceHandle: h, sourceUrl: `https://x.com/products/${h}`, title: `Product ${h.toUpperCase()}`,
    bodyHtml: '<p>desc</p>', vendor: 'Acme', productType: null, tags: [],
    variants: [{ sourceVariantId: `${h}-v1`, title: 'Default', price: '9.99', compareAtPrice: null, sku: `sku-${h}`, optionValues: {}, available: true }],
    options: [], images: [], seo: { title: null, description: null },
  }))

  console.log('Round 1: clone 3 products')
  const r1 = await productsPersister.persist({ db, shopId, jobId: 'smoke-r1', dtos: round1Dtos })
  console.log('  ', r1)
  if (r1.inserted !== 3) {
    console.log('FAIL — Round 1 expected 3 inserts')
    process.exit(1)
  }

  console.log("Simulating seller edit on 'smoke-b'")
  await db.updateTable('products')
    .set({ title: 'Seller Title', source: 'edited', title_edited_at: new Date().toISOString() } as any)
    .where('shop_id', '=', shopId).where('slug', '=', 'smoke-b').execute()

  console.log('Round 2: re-clone same 3 products')
  const r2 = await productsPersister.persist({ db, shopId, jobId: 'smoke-r2', dtos: round1Dtos })
  console.log('  ', r2)

  if (r2.skippedEdited !== 1) {
    console.log(`FAIL — expected skippedEdited=1, got ${r2.skippedEdited}`)
    process.exit(1)
  }
  if (r2.updated !== 2) {
    console.log(`FAIL — expected updated=2 for the clone-sourced rows, got ${r2.updated}`)
    process.exit(1)
  }

  const productB = await db.selectFrom('products')
    .where('shop_id', '=', shopId).where('slug', '=', 'smoke-b').selectAll().executeTakeFirst() as any
  if (productB?.title !== 'Seller Title') {
    console.log(`FAIL — seller edit overwritten; product B title = ${productB?.title}`)
    process.exit(1)
  }

  console.log('Smoke pass — L17 contract honored: re-clone preserves seller edits')
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(2) })
