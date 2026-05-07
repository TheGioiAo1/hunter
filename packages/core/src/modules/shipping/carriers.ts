/**
 * Gbox Platform — Per-shop Carrier Configuration
 *
 * Phase 9 / PR1.
 *
 * Wraps `shipping_carriers` CRUD and the seed-into-rates action. The
 * admin UI, the migration, and the smoke tests all go through this
 * module — never touch `shipping_carriers` from a handler directly.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import type { CarrierKind } from './seed.js'
import {
  CARRIER_CATALOG,
  CARRIERS_BY_KIND,
  rateCatalogForCarrier,
} from './seed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnableCarrierInput {
  kind: CarrierKind
  display_name?: string    // override carrier's default if the merchant wants a custom label
  use_live_rates?: boolean
}

export interface UpdateCarrierInput {
  enabled?: boolean
  use_live_rates?: boolean
  display_name?: string
  credentials_json?: Record<string, unknown> | null
}

export interface SeedRatesIntoZoneInput {
  /** The shipping_zones.id to stamp the rates onto. */
  zone_id: string
  /** Which carrier's seed rows to pull in. */
  kind: CarrierKind
  /**
   * Region override — defaults to inferring from the zone's
   * `region_code`. Explicit when the merchant wants a non-standard
   * combo (e.g. "use US-ZONE-3 seed for my 'California only' zone").
   */
  region_code?: string
  /** Currency for the new rates; defaults to shop currency via caller. */
  currency?: string
}

// ---------------------------------------------------------------------------
// Carrier CRUD
// ---------------------------------------------------------------------------

/**
 * List carriers configured for a shop. Returns one row per enabled
 * (or disabled) carrier, ordered by the catalog's natural order.
 */
export async function listShopCarriers(
  db: Kysely<Database>,
  shopId: string,
) {
  const rows = await db
    .selectFrom('shipping_carriers')
    .selectAll()
    .where('shop_id', '=', shopId)
    .execute()

  // Sort using the catalog's natural order (USPS, UPS, FedEx, ...)
  const order = new Map(CARRIER_CATALOG.map((c, i) => [c.kind, i]))
  return rows.slice().sort(
    (a, b) => (order.get(a.kind as CarrierKind) ?? 99) - (order.get(b.kind as CarrierKind) ?? 99),
  )
}

/**
 * Merge the catalog with the shop's rows so the admin UI can render
 * "all carriers" with an "enabled" flag per row, even if the merchant
 * hasn't touched any of them. Rows NOT yet in the DB return a synthetic
 * row with enabled=false + id=null so the enable form knows which
 * endpoint to post to.
 */
export async function listCarriersMerged(
  db: Kysely<Database>,
  shopId: string,
) {
  const existing = await listShopCarriers(db, shopId)
  const byKind = new Map(existing.map((r) => [r.kind, r]))

  return CARRIER_CATALOG.map((meta) => {
    const row = byKind.get(meta.kind)
    if (row) {
      return {
        ...row,
        meta,
        configured: true as const,
      }
    }
    return {
      id: null,
      shop_id: shopId,
      kind: meta.kind,
      display_name: meta.display_name,
      enabled: false,
      use_live_rates: false,
      credentials_json: null,
      created_at: null,
      updated_at: null,
      meta,
      configured: false as const,
    }
  })
}

/**
 * Enable a carrier for a shop. Creates the row if it doesn't exist,
 * flips enabled=true otherwise. Idempotent.
 */
export async function enableCarrier(
  db: Kysely<Database>,
  shopId: string,
  input: EnableCarrierInput,
) {
  const meta = CARRIERS_BY_KIND[input.kind]
  if (!meta) {
    throw new Error(`Unknown carrier kind: ${input.kind}`)
  }

  const existing = await db
    .selectFrom('shipping_carriers')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('kind', '=', input.kind)
    .executeTakeFirst()

  if (existing) {
    return db
      .updateTable('shipping_carriers')
      .set({
        enabled: true,
        use_live_rates: input.use_live_rates ?? existing.use_live_rates,
        display_name: input.display_name ?? existing.display_name,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  return db
    .insertInto('shipping_carriers')
    .values({
      shop_id: shopId,
      kind: input.kind,
      display_name: input.display_name ?? meta.display_name,
      enabled: true,
      use_live_rates: input.use_live_rates ?? false,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
}

/**
 * Update a carrier's config. Admin settings → per-carrier pencil.
 */
export async function updateCarrier(
  db: Kysely<Database>,
  shopId: string,
  carrierId: string,
  input: UpdateCarrierInput,
) {
  // Shop-scope guard — never let one shop edit another's carrier row.
  const existing = await db
    .selectFrom('shipping_carriers')
    .selectAll()
    .where('id', '=', carrierId)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!existing) {
    throw new Error('Carrier not found for this shop')
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.use_live_rates !== undefined) patch.use_live_rates = input.use_live_rates
  if (input.display_name !== undefined) patch.display_name = input.display_name
  if (input.credentials_json !== undefined) {
    patch.credentials_json =
      input.credentials_json == null
        ? null
        : JSON.stringify(input.credentials_json)
  }

  return db
    .updateTable('shipping_carriers')
    .set(patch as any)
    .where('id', '=', carrierId)
    .returningAll()
    .executeTakeFirstOrThrow()
}

/**
 * Disable a carrier without deleting its row. Rates previously seeded
 * into the shop's zones stay intact — the merchant can re-enable
 * anytime without re-seeding.
 */
export async function disableCarrier(
  db: Kysely<Database>,
  shopId: string,
  carrierId: string,
) {
  return updateCarrier(db, shopId, carrierId, { enabled: false })
}

// ---------------------------------------------------------------------------
// Seed catalog into a shop's zone (bulk rate copy)
// ---------------------------------------------------------------------------

/**
 * Copy rows from `shipping_rate_seed` into `shipping_rates` for a
 * specific zone. The merchant triggers this via
 * "Seed 2026 rates from <Carrier>" in the zone editor.
 *
 * We copy the USD rate directly unless the merchant specifies a
 * currency; FX conversion is out of scope for PR1 — the admin doc
 * says the seeded rates are in USD and the merchant can edit each
 * line after the copy.
 *
 * Returns the number of rate rows inserted.
 */
export async function seedRatesIntoZone(
  db: Kysely<Database>,
  shopId: string,
  input: SeedRatesIntoZoneInput,
): Promise<number> {
  // Shop-scope guard on the zone
  const zone = await db
    .selectFrom('shipping_zones')
    .select(['id', 'region_code'])
    .where('id', '=', input.zone_id)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!zone) {
    throw new Error('Zone not found for this shop')
  }

  const regionCode = input.region_code ?? zone.region_code ?? null

  // Filter the global seed catalog
  let seedRows = rateCatalogForCarrier(input.kind)
  if (regionCode) {
    seedRows = seedRows.filter((r) => r.region_code === regionCode)
  }

  if (seedRows.length === 0) return 0

  const currency = input.currency ?? 'USD'
  const now = new Date().toISOString()

  // Build rate inserts — each seed bracket becomes a weight_based rate
  const inserts = seedRows.map((s) => ({
    zone_id: input.zone_id,
    name: s.service_name,
    price: s.rate_usd.toFixed(2),
    type: 'weight_based',
    min_value: s.weight_min_lb.toFixed(3),
    max_value: s.weight_max_lb.toFixed(3),
    carrier_kind: s.carrier_kind,
    service_code: s.service_code,
    weight_min_lb: s.weight_min_lb.toFixed(3),
    weight_max_lb: s.weight_max_lb.toFixed(3),
    transit_days_min: s.transit_days_min,
    transit_days_max: s.transit_days_max,
    currency,
    created_at: now,
  }))

  await db.insertInto('shipping_rates').values(inserts as any).execute()
  return inserts.length
}

/**
 * Remove all seeded rates for a (zone, carrier) combo. Lets the
 * merchant toggle a carrier on/off on a single zone without touching
 * other zones.
 */
export async function removeCarrierRatesFromZone(
  db: Kysely<Database>,
  shopId: string,
  zoneId: string,
  kind: CarrierKind,
): Promise<number> {
  // Shop-scope guard
  const zone = await db
    .selectFrom('shipping_zones')
    .select('id')
    .where('id', '=', zoneId)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!zone) {
    throw new Error('Zone not found for this shop')
  }

  const result = await db
    .deleteFrom('shipping_rates')
    .where('zone_id', '=', zoneId)
    .where('carrier_kind', '=', kind)
    .executeTakeFirst()

  return Number((result as any)?.numDeletedRows ?? 0)
}

// ---------------------------------------------------------------------------
// Rate catalog reseed (admin "re-sync catalog" button)
// ---------------------------------------------------------------------------

/**
 * Re-insert the in-code `RATE_CATALOG` into `shipping_rate_seed`. The
 * migration runs this on up() and the admin calls it explicitly when
 * the catalog module is updated in a deploy.
 *
 * Uses ON CONFLICT DO NOTHING against the
 * (carrier_kind, service_code, region_code, weight bracket,
 * effective_date) composite unique so it's safe to run repeatedly.
 *
 * Returns the number of rows inserted (rows already present are
 * counted as 0).
 */
export async function reseedRateCatalog(
  db: Kysely<Database>,
): Promise<number> {
  // Dynamic import to avoid circular dep (seed.ts → providers.ts → carriers.ts)
  const { RATE_CATALOG } = await import('./seed.js')
  if (RATE_CATALOG.length === 0) return 0

  // Kysely doesn't have great ON CONFLICT support across mixed drivers,
  // so we write raw SQL for the upsert.
  const { sql } = await import('kysely')
  let inserted = 0
  for (const row of RATE_CATALOG) {
    const r = await sql<{ inserted: number }>`
      INSERT INTO shipping_rate_seed
        (carrier_kind, service_code, service_name, region_code,
         weight_min_lb, weight_max_lb, rate_usd,
         transit_days_min, transit_days_max)
      VALUES
        (${row.carrier_kind}, ${row.service_code}, ${row.service_name}, ${row.region_code},
         ${row.weight_min_lb}, ${row.weight_max_lb}, ${row.rate_usd},
         ${row.transit_days_min}, ${row.transit_days_max})
      ON CONFLICT (carrier_kind, service_code, region_code,
                   weight_min_lb, weight_max_lb, effective_date)
      DO NOTHING
      RETURNING 1 AS inserted
    `.execute(db as any)
    inserted += r.rows.length
  }
  return inserted
}
