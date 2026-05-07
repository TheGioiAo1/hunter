/**
 * Phase 9 PR1 — Shipping: carrier catalog + rate providers + checkout entry.
 *
 * Unit coverage lives in:
 *   - packages/core/src/modules/shipping/seed.test.ts       (24 cases)
 *   - packages/core/src/modules/shipping/providers.test.ts  (30 cases)
 *   - packages/core/src/modules/shipping/carriers.test.ts   (17 cases)
 *   - packages/core/src/modules/shipping/service.test.ts    (10 cases)
 *
 * This script verifies the live Postgres path — migration 066 shape,
 * seed table population, cross-shop tenancy on shipping_carriers,
 * seedRatesIntoZone copying the right slice of the catalog, the full
 * computeShippingRates merge (stored + provider), and the iron-rule-5
 * audit (no god-admin strings in carrier error paths).
 *
 * Run from server 2:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase9-pr1.ts
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 *
 * Coverage (assertions numbered below):
 *   [1]  Migration 066 — shipping_zones.kind exists
 *   [2]  Migration 066 — shipping_zones.region_code exists
 *   [3]  Migration 066 — shipping_rates.carrier_kind exists
 *   [4]  Migration 066 — shipping_rates.service_code exists
 *   [5]  Migration 066 — shipping_rates.weight_min_lb/_max_lb exist
 *   [6]  Migration 066 — shipping_rates.transit_days_min/_max exist
 *   [7]  Migration 066 — shipping_rates.currency exists (default 'USD')
 *   [8]  Migration 066 — shipping_carriers table exists
 *   [9]  Migration 066 — shipping_rate_seed table exists
 *   [10] reseedRateCatalog — populates the seed table (>= 100 rows)
 *   [11] reseedRateCatalog is idempotent (2nd call inserts 0)
 *   [12] enableCarrier inserts a new shipping_carriers row
 *   [13] enableCarrier is idempotent (flips enabled=true without dup)
 *   [14] enableCarrier rejects unknown kinds (no row inserted)
 *   [15] updateCarrier — cross-tenant guard (throws for other shop's row)
 *   [16] seedRatesIntoZone — copies USPS US rates into a zone
 *   [17] seedRatesIntoZone — rows are tagged with the right carrier_kind
 *   [18] seedRatesIntoZone — rejects cross-tenant zone IDs
 *   [19] computeShippingRates — returns stored rates for matching zone
 *   [20] computeShippingRates — adds provider quotes when carrier enabled
 *   [21] computeShippingRates — sorts combined offers by price ASC
 *   [22] computeShippingRates — weight bracket matching on migration-066 rows
 *   [23] computeShippingRates — swallows MissingCarrierCredentialsError
 *   [24] removeCarrierRatesFromZone — deletes only the named carrier
 *   [25] Iron rule 5 audit — no 'god admin' strings in error paths
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  reseedRateCatalog,
  enableCarrier,
  updateCarrier,
  seedRatesIntoZone,
  removeCarrierRatesFromZone,
} from '../packages/core/src/modules/shipping/carriers.js'
import { computeShippingRates } from '../packages/core/src/modules/shipping/service.js'
import {
  CARRIER_CATALOG,
  RATE_CATALOG,
} from '../packages/core/src/modules/shipping/seed.js'
import {
  createStubProvider,
  buildProviderForShopCarrier,
  MissingCarrierCredentialsError,
} from '../packages/core/src/modules/shipping/providers.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

const SUFFIX = Date.now()
const SHOP_A = randomUUID()
const SHOP_B = randomUUID()

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

let failed = 0
let total = 0
function assert(cond: boolean, msg: string) {
  total++
  if (cond) log(`  OK   ${msg}`)
  else {
    failed++
    log(`  FAIL ${msg}`)
  }
}

async function main() {
  log(`\n=== Phase 9 PR1 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed two shops for cross-shop isolation tests
  // -------------------------------------------------------------------------
  log('[0] Seeding two shops (A, B)')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p9-1a-${SUFFIX}`,
        name: 'PR1 Shop A',
        email: `p9-1a-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: SHOP_B,
        slug: `smoke-p9-1b-${SUFFIX}`,
        name: 'PR1 Shop B',
        email: `p9-1b-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
    ])
    .execute()

  // -------------------------------------------------------------------------
  // [1..9] Migration 066 shape
  // -------------------------------------------------------------------------
  log('\n[1..9] Migration 066 shape — columns + tables')

  const zoneCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'shipping_zones')
    .select(['column_name'])
    .execute()
  const zoneColSet = new Set(zoneCols.map((c: any) => c.column_name))
  assert(zoneColSet.has('kind'),           '[1] shipping_zones.kind exists')
  assert(zoneColSet.has('region_code'),    '[2] shipping_zones.region_code exists')

  const rateCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'shipping_rates')
    .select(['column_name', 'column_default'])
    .execute()
  const rateColMap = new Map<string, any>(
    rateCols.map((c: any) => [c.column_name, c.column_default]),
  )
  assert(rateColMap.has('carrier_kind'),     '[3] shipping_rates.carrier_kind exists')
  assert(rateColMap.has('service_code'),     '[4] shipping_rates.service_code exists')
  assert(rateColMap.has('weight_min_lb') && rateColMap.has('weight_max_lb'),
    '[5] shipping_rates.weight_min_lb / weight_max_lb exist')
  assert(rateColMap.has('transit_days_min') && rateColMap.has('transit_days_max'),
    '[6] shipping_rates.transit_days_min / transit_days_max exist')
  const currencyDefault = String(rateColMap.get('currency') ?? '')
  assert(rateColMap.has('currency') && currencyDefault.includes('USD'),
    `[7] shipping_rates.currency exists with default USD (got "${currencyDefault}")`)

  const carriersTbl = await (db as any)
    .selectFrom('information_schema.tables' as any)
    .where('table_name', '=', 'shipping_carriers')
    .select(['table_name'])
    .execute()
  assert(carriersTbl.length === 1, '[8] shipping_carriers table exists')

  const seedTbl = await (db as any)
    .selectFrom('information_schema.tables' as any)
    .where('table_name', '=', 'shipping_rate_seed')
    .select(['table_name'])
    .execute()
  assert(seedTbl.length === 1, '[9] shipping_rate_seed table exists')

  // -------------------------------------------------------------------------
  // [10..11] Reseed catalog + idempotency
  // -------------------------------------------------------------------------
  log('\n[10..11] reseedRateCatalog')

  const inserted1 = await reseedRateCatalog(db as any)
  log(`  info reseedRateCatalog first call inserted ${inserted1} rows (catalog has ${RATE_CATALOG.length})`)

  const seedCountRows = await (db as any).executeQuery({
    sql: 'SELECT COUNT(*)::int AS c FROM shipping_rate_seed',
    query: 'SELECT COUNT(*)::int AS c FROM shipping_rate_seed',
    parameters: [],
  }).catch(async () => {
    // Fallback for older Kysely shape — use selectFrom
    const rows = await (db as any)
      .selectFrom('shipping_rate_seed' as any)
      .select((eb: any) => [eb.fn.countAll().as('c')])
      .execute()
    return { rows: rows.map((r: any) => ({ c: Number(r.c) })) }
  })
  const seedCount = Number(seedCountRows.rows?.[0]?.c ?? 0)
  assert(seedCount >= 100,
    `[10] shipping_rate_seed has >= 100 rows after reseed (got ${seedCount})`)

  const inserted2 = await reseedRateCatalog(db as any)
  assert(inserted2 === 0,
    `[11] reseedRateCatalog idempotent — second call inserts 0 (got ${inserted2})`)

  // -------------------------------------------------------------------------
  // [12..15] enableCarrier / updateCarrier
  // -------------------------------------------------------------------------
  log('\n[12..15] Carrier CRUD')

  const uspsRow = await enableCarrier(db as any, SHOP_A, { kind: 'usps' })
  assert(uspsRow.kind === 'usps' && uspsRow.enabled === true,
    '[12] enableCarrier inserted a new row (enabled=true)')

  const uspsRow2 = await enableCarrier(db as any, SHOP_A, { kind: 'usps' })
  assert(uspsRow2.id === uspsRow.id,
    '[13] enableCarrier idempotent (same id on re-enable)')

  let rejectedUnknown = false
  try {
    await enableCarrier(db as any, SHOP_A, { kind: 'bogus_carrier' as any })
  } catch { rejectedUnknown = true }
  assert(rejectedUnknown, '[14] enableCarrier rejects unknown kind')

  let crossTenantBlocked = false
  try {
    await updateCarrier(db as any, SHOP_B, uspsRow.id, { enabled: false })
  } catch { crossTenantBlocked = true }
  assert(crossTenantBlocked,
    '[15] updateCarrier rejects cross-tenant carrier IDs')

  // -------------------------------------------------------------------------
  // [16..18] seedRatesIntoZone
  // -------------------------------------------------------------------------
  log('\n[16..18] seedRatesIntoZone')

  // Create a US zone for shop A
  const zoneA = await (db as any)
    .insertInto('shipping_zones')
    .values({
      shop_id: SHOP_A,
      name: 'US Zone',
      countries: JSON.stringify(['US']),
      kind: 'domestic',
      region_code: 'US',
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()

  const inserted = await seedRatesIntoZone(db as any, SHOP_A, {
    zone_id: zoneA.id,
    kind: 'usps',
  })
  assert(inserted >= 10,
    `[16] seedRatesIntoZone inserted >= 10 USPS rows (got ${inserted})`)

  const ratesInZone = await (db as any)
    .selectFrom('shipping_rates')
    .selectAll()
    .where('zone_id', '=', zoneA.id)
    .execute()
  const allUsps = ratesInZone.every((r: any) => r.carrier_kind === 'usps')
  assert(allUsps && ratesInZone.length >= 10,
    `[17] All seeded rows tagged carrier_kind=usps (${ratesInZone.length} rows)`)

  // Create a zone under shop B — shop A should not be able to seed into it.
  const zoneB = await (db as any)
    .insertInto('shipping_zones')
    .values({
      shop_id: SHOP_B,
      name: 'US Zone B',
      countries: JSON.stringify(['US']),
      kind: 'domestic',
      region_code: 'US',
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()

  let crossTenantSeed = false
  try {
    await seedRatesIntoZone(db as any, SHOP_A, {
      zone_id: zoneB.id,
      kind: 'usps',
    })
  } catch { crossTenantSeed = true }
  assert(crossTenantSeed,
    '[18] seedRatesIntoZone rejects cross-tenant zone IDs')

  // -------------------------------------------------------------------------
  // [19..23] computeShippingRates
  // -------------------------------------------------------------------------
  log('\n[19..23] computeShippingRates')

  // 19: stored rates for matching US zone
  const result19 = await computeShippingRates(
    db as any, SHOP_A,
    { country: 'US' },
    [{ variant_id: 'v1', quantity: 1, price: '30', weight: '2' }],
  )
  assert(result19.offers.length > 0,
    `[19] computeShippingRates returns stored USPS offers (${result19.offers.length} offers)`)

  // 20: provider quotes added alongside
  const storedCount = result19.offers.filter((o) => o.source === 'stored').length
  const providerCount = result19.offers.filter((o) => o.source === 'provider').length
  assert(storedCount > 0 && providerCount > 0,
    `[20] Offers include both stored (${storedCount}) + provider (${providerCount}) sources`)

  // 21: sorted ascending by price
  let sorted = true
  for (let i = 1; i < result19.offers.length; i++) {
    if (result19.offers[i].price < result19.offers[i - 1].price) {
      sorted = false
      break
    }
  }
  assert(sorted, '[21] Offers sorted ascending by price')

  // 22: weight bracket — 40lb should pick a heavier bracket
  const result22 = await computeShippingRates(
    db as any, SHOP_A,
    { country: 'US' },
    [{ variant_id: 'v1', quantity: 1, price: '30', weight: '40' }],
  )
  const heavyMatch = result22.offers.some((o) => o.source === 'stored' && o.price > 20)
  assert(heavyMatch,
    `[22] 40lb cart matches heavier weight bracket (${result22.offers.length} offers)`)

  // 23: live-rates without credentials → swallowed into errors[]
  await updateCarrier(db as any, SHOP_A, uspsRow.id, {
    use_live_rates: true,
    credentials_json: null,
  })
  const result23 = await computeShippingRates(
    db as any, SHOP_A,
    { country: 'US' },
    [{ variant_id: 'v1', quantity: 1, price: '30', weight: '2' }],
  )
  const hasCredError = result23.errors.some(
    (e) => e.carrier === 'usps' && /credentials/i.test(e.message),
  )
  assert(hasCredError,
    `[23] Missing-credentials error surfaced in result.errors (got ${result23.errors.length} errors)`)

  // Flip back for cleanup
  await updateCarrier(db as any, SHOP_A, uspsRow.id, {
    use_live_rates: false,
  })

  // -------------------------------------------------------------------------
  // [24] removeCarrierRatesFromZone
  // -------------------------------------------------------------------------
  log('\n[24] removeCarrierRatesFromZone')

  const before24 = (await (db as any)
    .selectFrom('shipping_rates')
    .selectAll()
    .where('zone_id', '=', zoneA.id)
    .execute()
  ).length

  const removed = await removeCarrierRatesFromZone(
    db as any, SHOP_A, zoneA.id, 'usps',
  )

  const after24 = (await (db as any)
    .selectFrom('shipping_rates')
    .selectAll()
    .where('zone_id', '=', zoneA.id)
    .execute()
  ).length

  assert(removed >= 10 && after24 === before24 - removed,
    `[24] removeCarrierRatesFromZone removed ${removed} rows (zone had ${before24} → ${after24})`)

  // -------------------------------------------------------------------------
  // [25] Iron rule 5 — no god-admin strings in carrier error paths
  // -------------------------------------------------------------------------
  log('\n[25] Iron rule 5 audit')

  const godAdmin = /god[_\s-]?admin/i
  const messages: string[] = []

  // Exception from missing creds
  try {
    buildProviderForShopCarrier({
      kind: 'usps',
      enabled: true,
      use_live_rates: true,
      credentials_json: null,
    })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }

  // Exception from unknown-kind stub factory
  try {
    createStubProvider('nonexistent' as any)
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }

  // Exception from enableCarrier with unknown kind
  try {
    await enableCarrier(db as any, SHOP_A, { kind: 'nonexistent' as any })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }

  // Exception from seedRatesIntoZone cross-tenant
  try {
    await seedRatesIntoZone(db as any, SHOP_A, {
      zone_id: zoneB.id,
      kind: 'usps',
    })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }

  const offenders = messages.filter((m) => godAdmin.test(m))
  assert(offenders.length === 0,
    `[25] No god-admin strings in error copy (scanned ${messages.length} messages)`)

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 9 PR1 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 9 PR1 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      // Delete in FK order: rates → zones → carriers → shops
      for (const shop of [SHOP_A, SHOP_B]) {
        const zones = await (db as any)
          .selectFrom('shipping_zones')
          .select(['id'])
          .where('shop_id', '=', shop)
          .execute()
        for (const z of zones) {
          await (db as any).deleteFrom('shipping_rates')
            .where('zone_id', '=', z.id).execute()
        }
        await (db as any).deleteFrom('shipping_zones')
          .where('shop_id', '=', shop).execute()
        await (db as any).deleteFrom('shipping_carriers')
          .where('shop_id', '=', shop).execute()
      }
      await (db as any).deleteFrom('shops')
        .where('id', 'in', [SHOP_A, SHOP_B])
        .execute()
      log('[cleanup] Done.')
    } catch (err) {
      console.error('[cleanup] failed:', err)
    }
    await (db as any).destroy()
  })
