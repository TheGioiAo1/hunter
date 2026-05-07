/**
 * Phase 9 PR2 — Tax: seed catalog + registrations + rates + checkout entry.
 *
 * Unit coverage lives in:
 *   - packages/core/src/modules/tax/seed.test.ts          (31 cases)
 *   - packages/core/src/modules/tax/providers.test.ts     (24 cases)
 *   - packages/core/src/modules/tax/registrations.test.ts (25 cases)
 *   - packages/core/src/modules/tax/service.test.ts       (18 cases)
 *
 * This script verifies the live Postgres path — migration 067 shape,
 * seed table population, cross-shop tenancy on tax_registrations +
 * tax_rates, B2B reverse-charge classification, and the iron-rule-5
 * audit (no god-admin strings in tax error paths).
 *
 * Run from server 2:
 *
 *   DATABASE_URL=postgresql://gbox:GboxPlatform2026@192.168.1.13:5432/gbox_platform \
 *     npx tsx scripts/smoke-phase9-pr2.ts
 *
 * Cleans up every seeded row in finally{} so the script is re-runnable.
 *
 * Coverage (assertions numbered below):
 *   [1]  Migration 067 — shops.tax_inclusive_pricing exists
 *   [2]  Migration 067 — shops.tax_shipping exists
 *   [3]  Migration 067 — shops.tax_id_vat / tax_id_ein exist
 *   [4]  Migration 067 — tax_registrations table exists
 *   [5]  Migration 067 — tax_rates table exists
 *   [6]  Migration 067 — tax_rate_seed table exists
 *   [7]  Migration 067 — order_line_items.tax_lines / total_tax exist
 *   [8]  reseedRateCatalog — populates the seed table (>= TAX_RATE_SEED.length)
 *   [9]  reseedRateCatalog is idempotent (2nd call inserts 0)
 *   [10] enableRegistration inserts a new tax_registrations row
 *   [11] enableRegistration is idempotent (flips collecting back on)
 *   [12] updateRegistration — cross-tenant guard
 *   [13] deleteRegistration — cross-tenant guard
 *   [14] seedRatesFromJurisdiction — inserts a tax_rates row linked to reg
 *   [15] seedRatesFromJurisdiction — stores correct rate from seed (CA=0.0725)
 *   [16] computeTaxForCart — US-CA destination → stub CA sales tax
 *   [17] computeTaxForCart — DE destination → stub German VAT 19%
 *   [18] computeTaxForCart — custom tax_rates row overrides stub
 *   [19] computeTaxForCart — EU cross-border B2B → reverse-charge zero-rated
 *   [20] computeTaxForCart — same-country EU B2B → regular VAT (no RC)
 *   [21] computeTaxForCart — tax-inclusive pricing back-solves ex-tax
 *   [22] computeTaxForCart — live + no creds → errors[] (no throw)
 *   [23] computeTaxForCart — zero-rate state (OR) returns empty tax_lines
 *   [24] deleteRegistration cascades tax_rates via FK
 *   [25] Iron rule 5 audit — no 'god admin' strings in tax error paths
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  reseedRateCatalog,
  enableRegistration,
  updateRegistration,
  deleteRegistration,
  seedRatesFromJurisdiction,
} from '../packages/core/src/modules/tax/registrations.js'
import { computeTaxForCart } from '../packages/core/src/modules/tax/service.js'
import {
  buildTaxProviderForShop,
  MissingTaxCredentialsError,
} from '../packages/core/src/modules/tax/providers.js'
import { TAX_RATE_SEED } from '../packages/core/src/modules/tax/seed.js'

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
  log(`\n=== Phase 9 PR2 smoke — suffix=${SUFFIX} ===\n`)

  // -------------------------------------------------------------------------
  // [0] Seed two shops for cross-shop isolation tests
  // -------------------------------------------------------------------------
  log('[0] Seeding two shops (A, B)')
  await (db as any)
    .insertInto('shops')
    .values([
      {
        id: SHOP_A,
        slug: `smoke-p9-2a-${SUFFIX}`,
        name: 'PR2 Shop A',
        email: `p9-2a-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
      {
        id: SHOP_B,
        slug: `smoke-p9-2b-${SUFFIX}`,
        name: 'PR2 Shop B',
        email: `p9-2b-${SUFFIX}@example.test`,
        status: 'active',
        plan: 'free',
      },
    ])
    .execute()

  // -------------------------------------------------------------------------
  // [1..7] Migration 067 shape
  // -------------------------------------------------------------------------
  log('\n[1..7] Migration 067 shape — columns + tables')

  const shopCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'shops')
    .select(['column_name'])
    .execute()
  const shopColSet = new Set(shopCols.map((c: any) => c.column_name))
  assert(shopColSet.has('tax_inclusive_pricing'),
    '[1] shops.tax_inclusive_pricing exists')
  assert(shopColSet.has('tax_shipping'),
    '[2] shops.tax_shipping exists')
  assert(
    shopColSet.has('tax_id_vat') && shopColSet.has('tax_id_ein'),
    '[3] shops.tax_id_vat + tax_id_ein exist',
  )

  const regTbl = await (db as any)
    .selectFrom('information_schema.tables' as any)
    .where('table_name', '=', 'tax_registrations')
    .select(['table_name'])
    .execute()
  assert(regTbl.length === 1, '[4] tax_registrations table exists')

  const rateTbl = await (db as any)
    .selectFrom('information_schema.tables' as any)
    .where('table_name', '=', 'tax_rates')
    .select(['table_name'])
    .execute()
  assert(rateTbl.length === 1, '[5] tax_rates table exists')

  const seedTbl = await (db as any)
    .selectFrom('information_schema.tables' as any)
    .where('table_name', '=', 'tax_rate_seed')
    .select(['table_name'])
    .execute()
  assert(seedTbl.length === 1, '[6] tax_rate_seed table exists')

  const liCols = await (db as any)
    .selectFrom('information_schema.columns' as any)
    .where('table_name', '=', 'order_line_items')
    .select(['column_name'])
    .execute()
  const liColSet = new Set(liCols.map((c: any) => c.column_name))
  assert(
    liColSet.has('tax_lines') && liColSet.has('total_tax'),
    '[7] order_line_items.tax_lines + total_tax exist',
  )

  // -------------------------------------------------------------------------
  // [8..9] Reseed catalog + idempotency
  // -------------------------------------------------------------------------
  log('\n[8..9] reseedRateCatalog')

  const inserted1 = await reseedRateCatalog(db as any)
  log(`  info reseedRateCatalog first call inserted ${inserted1} rows ` +
      `(catalog has ${TAX_RATE_SEED.length})`)

  const seedCountRows = await (db as any)
    .selectFrom('tax_rate_seed' as any)
    .select((eb: any) => [eb.fn.countAll().as('c')])
    .execute()
  const seedCount = Number(seedCountRows[0]?.c ?? 0)
  // Catalog is 51 US + 27 EU + 3 UK/NO/CH + 6 other = 87 rows today.
  // Anchor on TAX_RATE_SEED.length so growth doesn't break this.
  assert(seedCount >= TAX_RATE_SEED.length,
    `[8] tax_rate_seed has >= ${TAX_RATE_SEED.length} rows after reseed (got ${seedCount})`)

  const inserted2 = await reseedRateCatalog(db as any)
  assert(inserted2 === 0,
    `[9] reseedRateCatalog idempotent — second call inserts 0 (got ${inserted2})`)

  // -------------------------------------------------------------------------
  // [10..13] Registrations CRUD + tenancy
  // -------------------------------------------------------------------------
  log('\n[10..13] Registrations CRUD')

  const regA = await enableRegistration(db as any, SHOP_A, {
    jurisdiction_kind: 'us_state',
    jurisdiction_code: 'US-CA',
    tax_number: 'CA-REG-123',
  })
  assert(
    regA.jurisdiction_code === 'US-CA' && regA.collecting === true,
    '[10] enableRegistration inserted a new row (collecting=true)',
  )

  // Toggle collecting=false, then re-enable → same id, flipped back on
  await updateRegistration(db as any, SHOP_A, regA.id, { collecting: false })
  const regA2 = await enableRegistration(db as any, SHOP_A, {
    jurisdiction_kind: 'us_state',
    jurisdiction_code: 'US-CA',
  })
  assert(regA2.id === regA.id && regA2.collecting === true,
    '[11] enableRegistration idempotent (same id + flipped collecting=true)')

  let crossTenantUpd = false
  try {
    await updateRegistration(db as any, SHOP_B, regA.id, { collecting: false })
  } catch { crossTenantUpd = true }
  assert(crossTenantUpd, '[12] updateRegistration rejects cross-tenant IDs')

  let crossTenantDel = false
  try {
    await deleteRegistration(db as any, SHOP_B, regA.id)
  } catch { crossTenantDel = true }
  assert(crossTenantDel, '[13] deleteRegistration rejects cross-tenant IDs')

  // -------------------------------------------------------------------------
  // [14..15] seedRatesFromJurisdiction
  // -------------------------------------------------------------------------
  log('\n[14..15] seedRatesFromJurisdiction')

  const rateCA = await seedRatesFromJurisdiction(db as any, SHOP_A, {
    jurisdiction_code: 'US-CA',
  })
  assert(rateCA.registration_id === regA.id,
    '[14] seedRatesFromJurisdiction linked to existing registration')
  assert(String(rateCA.rate) === '0.0725',
    `[15] seedRatesFromJurisdiction stored CA rate=0.0725 (got ${rateCA.rate})`)

  // -------------------------------------------------------------------------
  // [16..23] computeTaxForCart
  // -------------------------------------------------------------------------
  log('\n[16..23] computeTaxForCart')

  // Clear the custom rate to test the stub path in [16]
  await (db as any).deleteFrom('tax_rates')
    .where('id', '=', rateCA.id).execute()

  const r16 = await computeTaxForCart(db as any, SHOP_A,
    { country: 'US', province_code: 'CA' },
    [{ quantity: 1, price: 100 }],
  )
  assert(
    r16.tax_lines.length === 1
    && r16.tax_lines[0].jurisdiction_code === 'US-CA'
    && Math.abs(r16.total_tax - 7.25) < 0.01,
    `[16] US-CA stub returns 7.25 (got ${r16.total_tax})`,
  )

  const r17 = await computeTaxForCart(db as any, SHOP_A,
    { country: 'DE' },
    [{ quantity: 1, price: 100 }],
  )
  assert(
    r17.tax_lines.length === 1
    && r17.tax_lines[0].rate === 0.19
    && Math.abs(r17.total_tax - 19) < 0.01,
    `[17] DE stub returns German VAT 19% = 19 (got ${r17.total_tax})`,
  )

  // Re-seed with a custom override rate for CA
  const override = await seedRatesFromJurisdiction(db as any, SHOP_A, {
    jurisdiction_code: 'US-CA',
    name: 'CA Override 10%',
  })
  await (db as any).updateTable('tax_rates')
    .set({ rate: '0.10' })
    .where('id', '=', override.id)
    .execute()

  const r18 = await computeTaxForCart(db as any, SHOP_A,
    { country: 'US', province_code: 'CA' },
    [{ quantity: 1, price: 100 }],
  )
  assert(
    r18.tax_lines.length === 1
    && r18.tax_lines[0].name === 'CA Override 10%'
    && Math.abs(r18.total_tax - 10) < 0.01,
    `[18] Custom rate overrides stub (got ${r18.tax_lines[0]?.name} = ${r18.total_tax})`,
  )

  // Clean up the override rate so the rest of the tests use stub path
  await (db as any).deleteFrom('tax_rates')
    .where('id', '=', override.id).execute()

  // [19] EU cross-border B2B → reverse-charge
  const r19 = await computeTaxForCart(db as any, SHOP_A,
    { country: 'FR', vat_id: 'FR12345678901' },
    [{ quantity: 1, price: 100 }],
    { shop: { origin_country: 'DE' } },
  )
  assert(
    r19.tax_lines.length === 1
    && r19.tax_lines[0].kind === 'vat_reverse_charge'
    && r19.total_tax === 0,
    '[19] EU cross-border B2B emits vat_reverse_charge zero-rated line',
  )

  // [20] Same-country EU B2B → normal VAT (no reverse-charge)
  const r20 = await computeTaxForCart(db as any, SHOP_A,
    { country: 'DE', vat_id: 'DE123456789' },
    [{ quantity: 1, price: 100 }],
    { shop: { origin_country: 'DE' } },
  )
  assert(
    r20.tax_lines.length === 1
    && r20.tax_lines[0].kind === 'vat'
    && Math.abs(r20.total_tax - 19) < 0.01,
    `[20] Same-country EU B2B still charges VAT (got ${r20.tax_lines[0]?.kind})`,
  )

  // [21] Tax-inclusive pricing (EU style)
  const r21 = await computeTaxForCart(db as any, SHOP_A,
    { country: 'DE' },
    [{ quantity: 1, price: 119 }],
    { shop: { tax_inclusive_pricing: true } },
  )
  assert(
    Math.abs(r21.subtotal_inc_tax - 119) < 0.01
    && r21.subtotal_ex_tax < 119,
    `[21] Tax-inclusive back-solves (ex=${r21.subtotal_ex_tax}, inc=${r21.subtotal_inc_tax})`,
  )

  // [22] Live + no creds → errors[] (no throw)
  const r22 = await computeTaxForCart(db as any, SHOP_A,
    { country: 'US', province_code: 'CA' },
    [{ quantity: 1, price: 100 }],
    { shop: { use_live_rates: true, credentials_json: null } },
  )
  assert(
    r22.tax_lines.length === 0
    && r22.errors.length > 0
    && /credentials/i.test(r22.errors[0].message),
    `[22] Live+no creds surfaced as errors[] (got ${r22.errors.length} errors)`,
  )

  // [23] Zero-rate state (OR) returns empty tax_lines
  const r23 = await computeTaxForCart(db as any, SHOP_A,
    { country: 'US', province_code: 'OR' },
    [{ quantity: 1, price: 100 }],
  )
  assert(
    r23.tax_lines.length === 0 && r23.total_tax === 0,
    `[23] Oregon (zero-rate) returns empty tax_lines (got ${r23.tax_lines.length})`,
  )

  // -------------------------------------------------------------------------
  // [24] deleteRegistration cascades to tax_rates
  // -------------------------------------------------------------------------
  log('\n[24] deleteRegistration cascade')

  // Create a fresh registration + rate pair on shop B
  const regB = await enableRegistration(db as any, SHOP_B, {
    jurisdiction_kind: 'eu_country',
    jurisdiction_code: 'DE',
  })
  const rateB = await seedRatesFromJurisdiction(db as any, SHOP_B, {
    jurisdiction_code: 'DE',
  })
  assert(rateB.registration_id === regB.id,
    '  pre: seeded rate linked to reg B')

  await deleteRegistration(db as any, SHOP_B, regB.id)
  const leftover = await (db as any)
    .selectFrom('tax_rates')
    .selectAll()
    .where('id', '=', rateB.id)
    .execute()
  assert(leftover.length === 0,
    `[24] FK cascade removed linked rate after reg delete (got ${leftover.length} leftover)`)

  // -------------------------------------------------------------------------
  // [25] Iron rule 5 — no god-admin strings in tax error paths
  // -------------------------------------------------------------------------
  log('\n[25] Iron rule 5 audit')

  const godAdmin = /god[_\s-]?admin/i
  const messages: string[] = []

  // MissingTaxCredentialsError message
  try {
    buildTaxProviderForShop({
      use_live_rates: true,
      credentials_json: null,
    })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }

  // Live + creds → not-implemented message
  try {
    buildTaxProviderForShop({
      use_live_rates: true,
      credentials_json: { api_key: 'fake' },
    })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }

  // Unknown jurisdiction for seedRatesFromJurisdiction
  try {
    await seedRatesFromJurisdiction(db as any, SHOP_A, {
      jurisdiction_code: 'XX',
    })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }

  // Cross-tenant registration ID
  try {
    await updateRegistration(db as any, SHOP_B, regA.id, { collecting: false })
  } catch (e: any) {
    messages.push(e.message ?? String(e))
  }

  const offenders = messages.filter((m) => godAdmin.test(m))
  assert(offenders.length === 0,
    `[25] No god-admin strings in error copy (scanned ${messages.length} messages)`)

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  log(`\n=== Phase 9 PR2 smoke: ${total - failed}/${total} passed (${failed} failed) ===\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error('Phase 9 PR2 smoke — fatal error:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    log('\n[cleanup] Removing seeded rows')
    try {
      for (const shop of [SHOP_A, SHOP_B]) {
        // rates depend on registrations via FK (ON DELETE CASCADE),
        // but orphan rows can exist too — delete rates explicitly first.
        await (db as any).deleteFrom('tax_rates')
          .where('shop_id', '=', shop).execute()
        await (db as any).deleteFrom('tax_registrations')
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
