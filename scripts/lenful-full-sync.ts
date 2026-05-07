/**
 * Lenful Full Catalog Sync — CLI one-shot
 *
 * Hits the live Lenful V6 Seller API, walks every page of the product
 * listing, and upserts the entire catalog into the local
 * `lenful_catalog` table. Prints fetched/upserted/deactivated/errors
 * summary + a sampling of freshly upserted rows.
 *
 * Prerequisite
 * ------------
 * An active row in `lenful_credentials` is required. Add one via:
 *   GET  /god-admin/fulfillments/credentials/new
 *   POST /god-admin/fulfillments/credentials
 *
 * Run
 * ---
 *   node --import tsx scripts/lenful-full-sync.ts
 *
 * Env
 * ---
 *   DATABASE_URL (required) — e.g. postgresql://gbox:pw@localhost:5432/gbox_platform
 *   LENFUL_CREDENTIAL_ID (optional) — override which credential row to use.
 *                                     Defaults to the newest active row.
 *
 * Safe to run repeatedly — syncCatalogFromLive upserts by lenful_product_id
 * and soft-deletes stale rows (is_active = false).
 */

import 'dotenv/config'
import { createDb, destroyDb } from '../packages/db/src/index.ts'
import { syncCatalogFromLive } from '../packages/core/src/modules/fulfillment/lenful/catalog-sync.ts'

async function main(): Promise<number> {
  const db = createDb()

  // 1. Pick the credential row
  const override = (process.env.LENFUL_CREDENTIAL_ID || '').trim()
  let credId: string | null = null
  if (override) {
    const row = await db
      .selectFrom('lenful_credentials')
      .select(['id', 'user_name', 'is_active'])
      .where('id', '=', override)
      .executeTakeFirst()
    if (!row) {
      console.error(`[full-sync] credential id "${override}" not found`)
      return 1
    }
    if (!row.is_active) {
      console.error(`[full-sync] credential id "${override}" is inactive`)
      return 1
    }
    credId = row.id
    console.log(`[full-sync] using override credential: ${row.user_name} (${row.id})`)
  } else {
    const row = await db
      .selectFrom('lenful_credentials')
      .select(['id', 'user_name'])
      .where('is_active', '=', true)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (!row) {
      console.error('[full-sync] no active lenful_credentials row found.')
      console.error('              add one via /god-admin/fulfillments/credentials/new')
      return 2
    }
    credId = row.id
    console.log(`[full-sync] using newest active credential: ${row.user_name} (${row.id})`)
  }

  // 2. Pre-sync snapshot
  const before = await db
    .selectFrom('lenful_catalog')
    .select((eb) => [
      eb.fn.countAll<number>().as('total'),
      eb.fn.sum<number>(eb.case().when('is_active', '=', true).then(1).else(0).end()).as('active'),
    ])
    .executeTakeFirst()
  console.log(
    `[full-sync] before: total=${Number(before?.total ?? 0)} active=${Number(before?.active ?? 0)}`,
  )

  // 3. Run the sync
  const startedAt = Date.now()
  console.log('[full-sync] starting — this may take a few minutes at 2 req/s')
  const result = await syncCatalogFromLive(db, {
    credentialId: credId,
    triggeredBy: 'cli:lenful-full-sync',
    userId: null,
    // Rely on the new defaults (maxPages=500, pageSize=100 → 50k ceiling).
  })
  const elapsedMs = Date.now() - startedAt

  // 4. Post-sync snapshot
  const after = await db
    .selectFrom('lenful_catalog')
    .select((eb) => [
      eb.fn.countAll<number>().as('total'),
      eb.fn.sum<number>(eb.case().when('is_active', '=', true).then(1).else(0).end()).as('active'),
    ])
    .executeTakeFirst()

  console.log('')
  console.log('────────────────────────────────────────────────────')
  console.log(' Lenful full catalog sync — summary')
  console.log('────────────────────────────────────────────────────')
  console.log(` fetched     : ${result.fetched}`)
  console.log(` upserted    : ${result.upserted}`)
  console.log(` deactivated : ${result.deactivated}`)
  console.log(` errors      : ${result.errors.length}`)
  console.log(` before      : total=${Number(before?.total ?? 0)} active=${Number(before?.active ?? 0)}`)
  console.log(` after       : total=${Number(after?.total ?? 0)} active=${Number(after?.active ?? 0)}`)
  console.log(` elapsed     : ${(elapsedMs / 1000).toFixed(1)}s`)
  console.log('────────────────────────────────────────────────────')
  if (result.errors.length > 0) {
    console.log(' First errors (up to 5):')
    for (const e of result.errors.slice(0, 5)) {
      console.log(`   · ${e.lenful_product_id ?? '(unknown)'} — ${e.message.slice(0, 160)}`)
    }
    console.log('────────────────────────────────────────────────────')
  }

  // 5. Sample rows
  const sample = await db
    .selectFrom('lenful_catalog')
    .select(['lenful_product_id', 'title', 'base_price', 'currency', 'last_synced_at'])
    .orderBy('last_synced_at', 'desc')
    .limit(10)
    .execute()
  console.log(' Sample of 10 most-recently-synced rows:')
  for (const r of sample) {
    const title = (r.title ?? '').slice(0, 48).padEnd(48)
    const price = r.base_price != null ? `${r.base_price} ${r.currency}` : '—'
    console.log(`   · ${r.lenful_product_id.padEnd(22)} ${title} ${price}`)
  }

  return result.errors.length > 0 ? 3 : 0
}

main()
  .then(async (code) => {
    await destroyDb().catch(() => {})
    process.exit(code)
  })
  .catch(async (err) => {
    console.error('[full-sync] FATAL:', err)
    await destroyDb().catch(() => {})
    process.exit(99)
  })
