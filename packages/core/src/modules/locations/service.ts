/**
 * Gbox Platform — Locations & Inventory Service
 *
 * Warehouse/store location management, inventory levels, adjustments,
 * and transfers.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

type Selectable<T> = { [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any> ? S : T[K] }

export type Location = Selectable<Database['locations']>
export type InventoryLevel = Selectable<Database['inventory_levels']>

export interface CreateLocationInput {
  name: string
  address?: string | null
  city?: string | null
  province?: string | null
  country?: string | null
  zip?: string | null
  phone?: string | null
  is_primary?: boolean
  active?: boolean
}

export interface UpdateLocationInput {
  name?: string
  address?: string | null
  city?: string | null
  province?: string | null
  country?: string | null
  zip?: string | null
  phone?: string | null
  is_primary?: boolean
  active?: boolean
}

export interface InventoryLevelWithItem extends InventoryLevel {
  sku: string | null
  variant_id: string
  tracked: boolean
}

// ---------------------------------------------------------------------------
// Location CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new location for a shop.
 */
export async function createLocation(
  db: Kysely<Database>,
  shopId: string,
  data: CreateLocationInput,
): Promise<Location> {
  const row = await db
    .insertInto('locations')
    .values({
      shop_id: shopId,
      name: data.name,
      address: data.address ?? null,
      city: data.city ?? null,
      province: data.province ?? null,
      country: data.country ?? null,
      zip: data.zip ?? null,
      phone: data.phone ?? null,
      is_primary: data.is_primary ?? false,
      active: data.active ?? true,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as Location
}

/**
 * Get a single location by ID.
 */
export async function getLocation(
  db: Kysely<Database>,
  locationId: string,
): Promise<Location | null> {
  const row = await db
    .selectFrom('locations')
    .selectAll()
    .where('id', '=', locationId)
    .executeTakeFirst()

  return (row as Location) ?? null
}

/**
 * Update a location.
 */
export async function updateLocation(
  db: Kysely<Database>,
  locationId: string,
  data: UpdateLocationInput,
): Promise<Location> {
  const row = await db
    .updateTable('locations')
    .set(data as any)
    .where('id', '=', locationId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return row as Location
}

/**
 * Delete a location. Fails if it has inventory levels referencing it.
 */
export async function deleteLocation(
  db: Kysely<Database>,
  locationId: string,
): Promise<void> {
  // Check for existing inventory levels
  const levelCount = await db
    .selectFrom('inventory_levels')
    .select(db.fn.countAll<number>().as('count'))
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow()

  if (Number(levelCount.count) > 0) {
    throw new Error(
      `Cannot delete location ${locationId}: it still has ${levelCount.count} inventory level(s). ` +
      'Transfer or remove inventory first.',
    )
  }

  await db.deleteFrom('locations').where('id', '=', locationId).execute()
}

/**
 * List all locations for a shop.
 */
export async function listLocations(
  db: Kysely<Database>,
  shopId: string,
): Promise<Location[]> {
  const rows = await db
    .selectFrom('locations')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('is_primary', 'desc')
    .orderBy('name', 'asc')
    .execute()

  return rows as Location[]
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * Get all inventory levels at a location, with item details.
 */
export async function getInventoryLevels(
  db: Kysely<Database>,
  locationId: string,
): Promise<InventoryLevelWithItem[]> {
  const rows = await db
    .selectFrom('inventory_levels as il')
    .innerJoin('inventory_items as ii', 'ii.id', 'il.inventory_item_id')
    .select([
      'il.inventory_item_id',
      'il.location_id',
      'il.available',
      'il.incoming',
      'il.committed',
      'il.updated_at',
      'ii.sku',
      'ii.variant_id',
      'ii.tracked',
    ])
    .where('il.location_id', '=', locationId)
    .execute()

  return rows as InventoryLevelWithItem[]
}

/**
 * Set the available quantity for an inventory item at a location.
 * Creates the inventory_level row if it does not exist.
 */
export async function setInventoryLevel(
  db: Kysely<Database>,
  inventoryItemId: string,
  locationId: string,
  quantity: number,
): Promise<InventoryLevel> {
  const existing = await db
    .selectFrom('inventory_levels')
    .selectAll()
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('inventory_levels')
      .set({ available: quantity, updated_at: new Date().toISOString() } as any)
      .where('inventory_item_id', '=', inventoryItemId)
      .where('location_id', '=', locationId)
      .execute()
  } else {
    await db
      .insertInto('inventory_levels')
      .values({
        inventory_item_id: inventoryItemId,
        location_id: locationId,
        available: quantity,
      })
      .execute()
  }

  const row = await db
    .selectFrom('inventory_levels')
    .selectAll()
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow()

  return row as InventoryLevel
}

/**
 * Adjust inventory by a delta (positive or negative).
 */
export async function adjustInventory(
  db: Kysely<Database>,
  inventoryItemId: string,
  locationId: string,
  adjustment: number,
): Promise<InventoryLevel> {
  // Ensure the level exists
  const existing = await db
    .selectFrom('inventory_levels')
    .selectAll()
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirst()

  if (!existing) {
    if (adjustment < 0) {
      throw new Error(
        `No inventory level exists for item ${inventoryItemId} at location ${locationId}`,
      )
    }
    // Create new level with the adjustment as initial available
    return setInventoryLevel(db, inventoryItemId, locationId, adjustment)
  }

  const newAvailable = Number(existing.available) + adjustment
  if (newAvailable < 0) {
    throw new Error(
      `Insufficient inventory: available=${existing.available}, adjustment=${adjustment}`,
    )
  }

  await db
    .updateTable('inventory_levels')
    .set({
      available: newAvailable,
      updated_at: new Date().toISOString(),
    } as any)
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .execute()

  const row = await db
    .selectFrom('inventory_levels')
    .selectAll()
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow()

  return row as InventoryLevel
}

/**
 * Transfer inventory from one location to another.
 */
export async function transferInventory(
  db: Kysely<Database>,
  inventoryItemId: string,
  fromLocationId: string,
  toLocationId: string,
  quantity: number,
): Promise<void> {
  if (quantity <= 0) {
    throw new Error('Transfer quantity must be positive')
  }

  if (fromLocationId === toLocationId) {
    throw new Error('Source and destination locations must be different')
  }

  // Verify source has enough
  const fromLevel = await db
    .selectFrom('inventory_levels')
    .selectAll()
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', fromLocationId)
    .executeTakeFirst()

  if (!fromLevel || Number(fromLevel.available) < quantity) {
    throw new Error(
      `Insufficient inventory at source location: available=${fromLevel?.available ?? 0}, requested=${quantity}`,
    )
  }

  // Deduct from source
  await db
    .updateTable('inventory_levels')
    .set({
      available: Number(fromLevel.available) - quantity,
      updated_at: new Date().toISOString(),
    } as any)
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', fromLocationId)
    .execute()

  // Add to destination (create if needed)
  const toLevel = await db
    .selectFrom('inventory_levels')
    .selectAll()
    .where('inventory_item_id', '=', inventoryItemId)
    .where('location_id', '=', toLocationId)
    .executeTakeFirst()

  if (toLevel) {
    await db
      .updateTable('inventory_levels')
      .set({
        available: Number(toLevel.available) + quantity,
        updated_at: new Date().toISOString(),
      } as any)
      .where('inventory_item_id', '=', inventoryItemId)
      .where('location_id', '=', toLocationId)
      .execute()
  } else {
    await db
      .insertInto('inventory_levels')
      .values({
        inventory_item_id: inventoryItemId,
        location_id: toLocationId,
        available: quantity,
      })
      .execute()
  }
}
