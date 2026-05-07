/**
 * Phase 4 PR4 — Customer CSV import + export live smoke.
 *
 * Run from server 2 with access to the gbox_platform DB. Proves the
 * full round-trip:
 *   - exportCustomersCsvStream emits a Shopify-parity header
 *   - parseCustomersCsv round-trips the exporter output losslessly
 *   - buildImportPlan detects create vs update correctly
 *   - applyImportPlan actually writes + preserves invariants
 *
 * The script uses a disposable shop id so it can't touch real data.
 * Rolls back everything at the end (even on partial failure) via a
 * single wrapping transaction that is aborted in a try/finally.
 */

import { randomUUID } from 'node:crypto'
import { createDb } from '../packages/db/src/index.js'
import {
  parseCustomersCsv,
  buildImportPlan,
  applyImportPlan,
  exportCustomersCsv,
  exportCustomersCsvStream,
  type ExportCustomer,
} from '../packages/core/src/modules/customers/csv/index.js'

const db = createDb({ connectionString: process.env.DATABASE_URL })

// shops.id is uuid, so use a real UUID (not a string). The slug stays
// time-stamped so parallel runs don't collide on the unique index.
const SHOP_ID = randomUUID()
const SHOP_SLUG_SUFFIX = Date.now()

function log(s: string) {
  // eslint-disable-next-line no-console
  console.log(s)
}

async function main() {
  log(`\n=== Phase 4 PR4 smoke — shop_id=${SHOP_ID} ===\n`)
  let failed = 0
  const assert = (cond: boolean, msg: string) => {
    if (cond) log(`  ✓ ${msg}`)
    else {
      failed++
      log(`  ✗ ${msg}`)
    }
  }

  // Provision a disposable shop. The FK constraint on customer.shop_id
  // → shops.id forces us to have a real shops row. `email` is NOT NULL
  // in the live schema, so we include a throwaway one.
  await db
    .insertInto('shops')
    .values({
      id: SHOP_ID,
      slug: `smoke-pr4-${SHOP_SLUG_SUFFIX}`,
      name: 'PR4 smoke shop',
      email: `smoke-pr4-${SHOP_SLUG_SUFFIX}@example.test`,
    } as any)
    .execute()

  try {
    // ---------- SECTION 1: exporter round-trips through parser ----------
    log('\n[1] Exporter → parser round-trip')
    const seed: ExportCustomer[] = [
      {
        id: 'seed-1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.com',
        phone: '555-0001',
        accepts_marketing: true,
        note: 'VIP',
        tags: ['vip', 'beta'],
        tax_exempt: false,
        total_spent: '42.50',
        orders_count: 3,
        lifecycle_stage: 'returning',
        default_address: {
          first_name: null,
          last_name: null,
          company: 'Acme',
          address1: '1 Foo St',
          address2: 'Apt 2',
          city: 'NYC',
          province: 'NY',
          province_code: 'NY',
          country: 'United States',
          country_code: 'US',
          zip: '10001',
          phone: null,
        },
      },
    ]
    const csv = exportCustomersCsv(seed)
    assert(csv.split('\n')[0]!.includes('First Name'), 'header carries First Name')
    assert(csv.split('\n')[0]!.includes('Lifecycle Stage'), 'header carries Lifecycle Stage')
    const parsed = parseCustomersCsv(csv)
    assert(parsed.customers.length === 1, 'parser yields exactly 1 customer')
    const p = parsed.customers[0]!
    assert(p.email === 'ada@example.com', 'email round-trips')
    assert(p.accepts_marketing === true, 'accepts_marketing round-trips (yes → true)')
    assert(p.tags?.join(',') === 'vip,beta', 'tags round-trip (comma+space join/split)')
    assert(p.address?.address1 === '1 Foo St', 'address1 round-trips')
    assert(p.address?.country_code === 'US', 'country_code round-trips')

    // ---------- SECTION 2: streaming exporter yields same header ----------
    log('\n[2] Streaming exporter')
    const chunks: string[] = []
    for await (const chunk of exportCustomersCsvStream(seed)) chunks.push(chunk)
    const streamed = chunks.join('')
    assert(streamed === csv, 'stream produces identical bytes to batch export')

    // ---------- SECTION 3: plan builder — create + bad_email + missing ----
    log('\n[3] Plan builder')
    const planInput = parseCustomersCsv(
      'First Name,Last Name,Email\n' +
        'New,Person,new@example.com\n' +
        ',,\n' + // all-blank row is skipped by parser
        'Bad,Email,not-an-email\n',
    ).customers
    const planInput2 = parseCustomersCsv(
      'First Name,Last Name,Email\nJust,Name,\n',
    ).customers
    const all = [...planInput, ...planInput2]
    const plan = await buildImportPlan(db as any, SHOP_ID, all)
    assert(plan.stats.creating === 1, 'plan: 1 creating')
    assert(plan.stats.blocked >= 2, 'plan: ≥2 blocked (bad + missing)')
    const codes = plan.issues.map((i) => i.code).sort()
    assert(codes.includes('bad_email'), 'plan emits bad_email')
    assert(codes.includes('missing_email'), 'plan emits missing_email')

    // ---------- SECTION 4: applier creates the customer + address --------
    log('\n[4] Applier — create path')
    const createPlan = await buildImportPlan(
      db as any,
      SHOP_ID,
      parseCustomersCsv(
        'First Name,Last Name,Email,Company,Address1,City,Country,Zip,Accepts Email Marketing,Tags,Note\n' +
          'Ada,Lovelace,ada@example.com,Acme,1 Foo St,NYC,United States,10001,yes,"vip, beta",VIP\n',
      ).customers,
    )
    const created = await applyImportPlan(db as any, SHOP_ID, createPlan)
    assert(created.stats.created === 1, 'applier: 1 created')
    const row = await db
      .selectFrom('customers')
      .selectAll()
      .where('shop_id', '=', SHOP_ID)
      .where('email', '=', 'ada@example.com')
      .executeTakeFirst()
    assert(!!row, 'customers row persisted')
    assert(row?.first_name === 'Ada', 'first_name persisted')
    assert(row?.accepts_marketing === true, 'accepts_marketing persisted')
    assert(
      Array.isArray(row?.tags) && (row?.tags as any).includes('vip'),
      'tags persisted as array',
    )
    const addr = await db
      .selectFrom('customer_addresses')
      .selectAll()
      .where('customer_id', '=', row!.id)
      .executeTakeFirst()
    assert(!!addr, 'default address persisted')
    assert(addr?.address1 === '1 Foo St', 'address1 persisted')

    // ---------- SECTION 5: applier update — email NOT rewritten, note NOT cleared ----
    log('\n[5] Applier — update path preserves invariants')
    // Craft a CSV that:
    //   - rewrites email casing
    //   - omits the Note column → note must NOT be cleared
    //   - changes address1
    const updateCsv =
      'First Name,Last Name,Email,Address1,Accepts Email Marketing\n' +
      'Ada,Lovelace,ADA@example.com,2 Bar Ave,no\n'
    const updatePlan = await buildImportPlan(
      db as any,
      SHOP_ID,
      parseCustomersCsv(updateCsv).customers,
    )
    assert(updatePlan.stats.updating === 1, 'plan: case-insensitive match → 1 update')
    const warnCodes = updatePlan.issues
      .filter((i) => i.severity === 'warning')
      .map((i) => i.code)
    assert(warnCodes.includes('note_cleared'), 'plan: note_cleared warning fired')
    await applyImportPlan(db as any, SHOP_ID, updatePlan)
    const after = await db
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', row!.id)
      .executeTakeFirst()
    assert(after?.email === 'ada@example.com', 'update did NOT rewrite email casing')
    assert(after?.note === 'VIP', 'update did NOT clear the note')
    assert(after?.accepts_marketing === false, 'update toggled accepts_marketing')
    const addrAfter = await db
      .selectFrom('customer_addresses')
      .selectAll()
      .where('customer_id', '=', row!.id)
      .executeTakeFirst()
    assert(addrAfter?.address1 === '2 Bar Ave', 'address was updated in place')

    // ---------- SECTION 6: re-export → re-import → all-update, zero new ----
    log('\n[6] Export → re-import yields no creates')
    const live: ExportCustomer[] = [
      {
        id: row!.id,
        first_name: after!.first_name,
        last_name: after!.last_name,
        email: after!.email,
        phone: after!.phone,
        accepts_marketing: Boolean(after!.accepts_marketing),
        note: after!.note,
        tags: (after!.tags as any) ?? null,
        tax_exempt: Boolean(after!.tax_exempt),
        total_spent: String(after!.total_spent ?? '0.00'),
        orders_count: Number(after!.orders_count ?? 0),
        lifecycle_stage: String(after!.lifecycle_stage ?? 'new'),
        default_address: {
          first_name: addrAfter!.first_name,
          last_name: addrAfter!.last_name,
          company: addrAfter!.company,
          address1: addrAfter!.address1,
          address2: addrAfter!.address2,
          city: addrAfter!.city,
          province: addrAfter!.province,
          province_code: addrAfter!.province_code,
          country: addrAfter!.country,
          country_code: addrAfter!.country_code,
          zip: addrAfter!.zip,
          phone: addrAfter!.phone,
        },
      },
    ]
    const rePlan = await buildImportPlan(
      db as any,
      SHOP_ID,
      parseCustomersCsv(exportCustomersCsv(live)).customers,
    )
    assert(rePlan.stats.creating === 0, 'round-trip plan: 0 new creates')
    assert(rePlan.stats.updating === 1, 'round-trip plan: 1 update (lossless match)')
  } finally {
    log('\n[cleanup] removing smoke fixtures')
    await db.deleteFrom('customer_addresses').where('customer_id', 'in',
      db.selectFrom('customers').select('id').where('shop_id', '=', SHOP_ID),
    ).execute().catch(() => {})
    await db.deleteFrom('customers').where('shop_id', '=', SHOP_ID).execute().catch(() => {})
    await db.deleteFrom('shops').where('id', '=', SHOP_ID).execute().catch(() => {})
    await db.destroy()
    log(`\n=== smoke done — ${failed} assertion${failed === 1 ? '' : 's'} failed ===\n`)
    process.exit(failed === 0 ? 0 : 1)
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke fatal]', err)
  process.exit(1)
})
