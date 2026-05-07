/**
 * Gbox Platform — Per-shop tax registrations + rates.
 *
 * Phase 9 / PR2.
 *
 * Owns CRUD for `tax_registrations` and `tax_rates`. The admin UI, the
 * migration, and the smoke tests all go through this module — never
 * touch those tables from a handler directly.
 *
 * Key operations:
 *   - `listRegistrations(db, shopId)`            — all declared registrations
 *   - `enableRegistration(db, shopId, input)`    — idempotent upsert
 *   - `updateRegistration(db, shopId, id, ...)`  — shop-scoped update
 *   - `deleteRegistration(db, shopId, id)`       — shop-scoped delete
 *   - `listRatesForShop(db, shopId)`             — all tax_rates for shop
 *   - `seedRatesFromJurisdiction(db, shopId, input)`
 *       — create tax_rates row(s) from the seed catalog
 *   - `updateRate(db, shopId, id, patch)`        — shop-scoped update
 *   - `deleteRate(db, shopId, id)`               — shop-scoped delete
 *   - `reseedRateCatalog(db)`                    — idempotent global seed loader
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  TAX_RATE_SEED,
  seedRowFor,
  type JurisdictionKind,
  type TaxSeedRow,
} from './seed.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnableRegistrationInput {
  jurisdiction_kind: JurisdictionKind
  jurisdiction_code: string
  display_name?: string
  tax_number?: string | null
  collecting?: boolean
}

export interface UpdateRegistrationInput {
  collecting?: boolean
  tax_number?: string | null
  display_name?: string
}

export interface SeedRateFromJurisdictionInput {
  /** Which jurisdiction to pull the standard rate from. */
  jurisdiction_code: string
  /**
   * Optional explicit registration_id to link the new rate against.
   * When omitted, the service tries to find an existing registration
   * for this jurisdiction and links to it; if none exists it leaves
   * the rate unlinked (legal — merchants can add rates for
   * jurisdictions they aren't (yet) registered in).
   */
  registration_id?: string
  /** Override the default `applies_to_shipping` from the seed row. */
  applies_to_shipping?: boolean
  /** Override the default name from the seed row. */
  name?: string
}

export interface UpdateRateInput {
  name?: string
  rate?: string | number
  kind?: string
  applies_to_shipping?: boolean
  priority?: number
  compounded?: boolean
}

// ---------------------------------------------------------------------------
// Registrations CRUD
// ---------------------------------------------------------------------------

/**
 * List all tax registrations a shop has declared. Includes
 * paused (collecting=false) rows — the admin table shows them
 * with a "paused" badge so merchants can resume easily.
 */
export async function listRegistrations(
  db: Kysely<Database>,
  shopId: string,
) {
  return db
    .selectFrom('tax_registrations')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('jurisdiction_code', 'asc')
    .execute()
}

/**
 * Create (or re-activate) a tax_registrations row. Idempotent:
 * re-enabling an existing row flips `collecting = true` without
 * duplicating. Returns the (existing or new) row.
 */
export async function enableRegistration(
  db: Kysely<Database>,
  shopId: string,
  input: EnableRegistrationInput,
) {
  const code = input.jurisdiction_code.toUpperCase()
  const seed = seedRowFor(code)
  const displayName =
    input.display_name ?? seed?.name ?? code

  const existing = await db
    .selectFrom('tax_registrations')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('jurisdiction_code', '=', code)
    .executeTakeFirst()

  if (existing) {
    const updated = await db
      .updateTable('tax_registrations')
      .set({
        collecting: input.collecting ?? true,
        tax_number: input.tax_number ?? existing.tax_number,
        display_name: input.display_name ?? existing.display_name,
        updated_at: sql`now()` as any,
      })
      .where('id', '=', existing.id)
      .where('shop_id', '=', shopId)
      .returningAll()
      .executeTakeFirstOrThrow()
    return updated
  }

  const inserted = await db
    .insertInto('tax_registrations')
    .values({
      shop_id: shopId,
      jurisdiction_kind: input.jurisdiction_kind,
      jurisdiction_code: code,
      display_name: displayName,
      tax_number: input.tax_number ?? null,
      collecting: input.collecting ?? true,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
  return inserted
}

/**
 * Shop-scoped update. Throws when the row belongs to another shop.
 */
export async function updateRegistration(
  db: Kysely<Database>,
  shopId: string,
  id: string,
  patch: UpdateRegistrationInput,
) {
  const row = await db
    .selectFrom('tax_registrations')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw new Error('Registration not found')
  if (row.shop_id !== shopId) {
    throw new Error('Registration not found') // don't leak cross-tenant existence
  }

  const updated = await db
    .updateTable('tax_registrations')
    .set({
      collecting: patch.collecting ?? row.collecting,
      tax_number: patch.tax_number !== undefined ? patch.tax_number : row.tax_number,
      display_name: patch.display_name ?? row.display_name,
      updated_at: sql`now()` as any,
    })
    .where('id', '=', id)
    .where('shop_id', '=', shopId)
    .returningAll()
    .executeTakeFirstOrThrow()
  return updated
}

/**
 * Shop-scoped delete. Cascades to tax_rates via DB FK
 * (ON DELETE CASCADE on registration_id).
 */
export async function deleteRegistration(
  db: Kysely<Database>,
  shopId: string,
  id: string,
) {
  const row = await db
    .selectFrom('tax_registrations')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw new Error('Registration not found')
  if (row.shop_id !== shopId) {
    throw new Error('Registration not found')
  }

  await db
    .deleteFrom('tax_registrations')
    .where('id', '=', id)
    .where('shop_id', '=', shopId)
    .execute()
}

// ---------------------------------------------------------------------------
// Rates CRUD
// ---------------------------------------------------------------------------

/**
 * List all tax_rates for a shop, ordered by priority (higher runs first)
 * then jurisdiction_code.
 */
export async function listRatesForShop(
  db: Kysely<Database>,
  shopId: string,
) {
  return db
    .selectFrom('tax_rates')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('priority', 'desc')
    .orderBy('jurisdiction_code', 'asc')
    .execute()
}

/**
 * List rates for a specific jurisdiction_code within a shop.
 * Used at checkout to resolve the stack of applicable taxes.
 */
export async function listRatesForJurisdiction(
  db: Kysely<Database>,
  shopId: string,
  jurisdictionCode: string,
) {
  return db
    .selectFrom('tax_rates')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('jurisdiction_code', '=', jurisdictionCode.toUpperCase())
    .orderBy('priority', 'desc')
    .execute()
}

/**
 * Create a tax_rates row from a seed-catalog entry. Idempotent in the
 * sense that running it twice for the same (shop, jurisdiction) creates
 * two rows — merchants are expected to use the admin "replace" flow
 * if they want one rate per jurisdiction. Deliberate: some jurisdictions
 * legitimately have multiple rates (e.g. a state rate + a city rate the
 * merchant hand-added).
 */
export async function seedRatesFromJurisdiction(
  db: Kysely<Database>,
  shopId: string,
  input: SeedRateFromJurisdictionInput,
) {
  const code = input.jurisdiction_code.toUpperCase()
  const seed = seedRowFor(code)
  if (!seed) {
    throw new Error(`No seed rate for jurisdiction '${code}'`)
  }

  let registrationId = input.registration_id ?? null
  if (!registrationId) {
    const reg = await db
      .selectFrom('tax_registrations')
      .select(['id'])
      .where('shop_id', '=', shopId)
      .where('jurisdiction_code', '=', code)
      .executeTakeFirst()
    registrationId = reg?.id ?? null
  } else {
    // Guard: caller passed a registration_id — verify it belongs to this shop
    const reg = await db
      .selectFrom('tax_registrations')
      .select(['id'])
      .where('id', '=', registrationId)
      .where('shop_id', '=', shopId)
      .executeTakeFirst()
    if (!reg) {
      throw new Error('Registration not found')
    }
  }

  const name = input.name ?? seedDefaultName(seed)
  const appliesToShipping =
    input.applies_to_shipping ?? seed.applies_to_shipping

  const inserted = await db
    .insertInto('tax_rates')
    .values({
      shop_id: shopId,
      registration_id: registrationId,
      jurisdiction_code: code,
      name,
      rate: String(seed.rate),
      kind: seed.kind,
      applies_to_shipping: appliesToShipping,
      priority: 0,
      compounded: false,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()

  return inserted
}

/**
 * Shop-scoped rate update.
 */
export async function updateRate(
  db: Kysely<Database>,
  shopId: string,
  id: string,
  patch: UpdateRateInput,
) {
  const row = await db
    .selectFrom('tax_rates')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw new Error('Rate not found')
  if (row.shop_id !== shopId) throw new Error('Rate not found')

  const updated = await db
    .updateTable('tax_rates')
    .set({
      name: patch.name ?? row.name,
      rate: patch.rate !== undefined ? String(patch.rate) : row.rate,
      kind: patch.kind ?? row.kind,
      applies_to_shipping:
        patch.applies_to_shipping ?? row.applies_to_shipping,
      priority: patch.priority ?? row.priority,
      compounded: patch.compounded ?? row.compounded,
      updated_at: sql`now()` as any,
    })
    .where('id', '=', id)
    .where('shop_id', '=', shopId)
    .returningAll()
    .executeTakeFirstOrThrow()
  return updated
}

/**
 * Shop-scoped rate delete.
 */
export async function deleteRate(
  db: Kysely<Database>,
  shopId: string,
  id: string,
) {
  const row = await db
    .selectFrom('tax_rates')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw new Error('Rate not found')
  if (row.shop_id !== shopId) throw new Error('Rate not found')

  await db
    .deleteFrom('tax_rates')
    .where('id', '=', id)
    .where('shop_id', '=', shopId)
    .execute()
}

// ---------------------------------------------------------------------------
// Global seed catalog loader
// ---------------------------------------------------------------------------

/**
 * Populate the `tax_rate_seed` table with public 2026 rates. Idempotent
 * via `ON CONFLICT DO NOTHING` on the composite unique key
 * `(jurisdiction_code, kind, effective_date)`. Safe to run multiple
 * times — calling after a partial failure catches up, and calling
 * when fully seeded returns 0.
 *
 * Returns the number of rows inserted.
 */
export async function reseedRateCatalog(
  db: Kysely<Database>,
): Promise<number> {
  let inserted = 0
  for (const row of TAX_RATE_SEED) {
    // Raw SQL is cleaner than Kysely's raw insert with ON CONFLICT —
    // the constraint-name path here is identical to shipping_rate_seed.
    const result = await sql`
      INSERT INTO tax_rate_seed
        (jurisdiction_kind, jurisdiction_code, name, rate, kind,
         applies_to_shipping, effective_date)
      VALUES
        (${row.jurisdiction_kind}, ${row.jurisdiction_code}, ${row.name},
         ${row.rate}, ${row.kind}, ${row.applies_to_shipping}, '2026-01-01')
      ON CONFLICT (jurisdiction_code, kind, effective_date) DO NOTHING
      RETURNING id
    `.execute(db)
    inserted += result.rows.length
  }
  return inserted
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDefaultName(seed: TaxSeedRow): string {
  const pct = (seed.rate * 100).toFixed(
    Number.isInteger(seed.rate * 100) ? 0 : 1,
  )
  switch (seed.kind) {
    case 'sales': return `${seed.name} Sales Tax (${pct}%)`
    case 'vat':   return `${seed.name} VAT (${pct}%)`
    case 'gst':   return `${seed.name} GST (${pct}%)`
    default:      return `${seed.name} Tax (${pct}%)`
  }
}
