/**
 * Gbox Platform — Metafields Service (Shopify Metafields pattern)
 *
 * Metafields are arbitrary key-value extensions attached to any owner
 * resource (shop, product, variant, order, customer, collection, ...).
 *
 * Scope: `(shop_id, owner_type, owner_id, namespace, key)` is unique.
 *
 * A merchant's custom SEO fields, B2B wholesale prices, subscription
 * flags, etc. all live here instead of forcing schema migrations for
 * every merchant's hobby horse.
 */

import type { Kysely } from 'kysely'
import type { Database, MetafieldTable } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Selectable<T> = {
  [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any>
    ? S
    : T[K]
}

export type Metafield = Selectable<MetafieldTable>

export type MetafieldOwnerType =
  | 'shop'
  | 'product'
  | 'variant'
  | 'order'
  | 'customer'
  | 'collection'
  | 'page'
  | 'blog_post'

export type MetafieldValueType =
  | 'single_line_text_field'
  | 'multi_line_text_field'
  | 'number_integer'
  | 'number_decimal'
  | 'boolean'
  | 'json'
  | 'date'
  | 'date_time'
  | 'url'
  | 'color'
  | 'reference'

export const OWNER_TYPES: readonly MetafieldOwnerType[] = [
  'shop',
  'product',
  'variant',
  'order',
  'customer',
  'collection',
  'page',
  'blog_post',
] as const

export const VALUE_TYPES: readonly MetafieldValueType[] = [
  'single_line_text_field',
  'multi_line_text_field',
  'number_integer',
  'number_decimal',
  'boolean',
  'json',
  'date',
  'date_time',
  'url',
  'color',
  'reference',
] as const

export interface SetMetafieldInput {
  shop_id: string
  owner_type: MetafieldOwnerType
  owner_id: string
  namespace: string
  key: string
  value: unknown
  value_type?: MetafieldValueType
  description?: string | null
}

export interface GetMetafieldInput {
  shop_id: string
  owner_type: MetafieldOwnerType
  owner_id: string
  namespace: string
  key: string
}

export interface UpdateMetafieldByIdInput {
  shop_id: string
  value?: unknown
  value_type?: MetafieldValueType
  description?: string | null
}

// ---------------------------------------------------------------------------
// Validation — Shopify rules
//   - namespace: 3-255 chars, alphanumeric + underscore/hyphen
//   - key: 3-64 chars, alphanumeric + underscore/hyphen
//   - value: serialized JSON ≤ 5 MB (Shopify parity)
//   - value_type: must be one of the MetafieldValueType enum
// ---------------------------------------------------------------------------

const NAMESPACE_RE = /^[a-zA-Z0-9_-]{3,255}$/
const KEY_RE = /^[a-zA-Z0-9_-]{3,64}$/

/** Shopify caps metafield size at 5 MB of serialized JSON. */
export const MAX_VALUE_BYTES = 5 * 1024 * 1024

function validateNamespaceKey(namespace: string, key: string): void {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(
      `Invalid metafield namespace "${namespace}" — must be 3-255 chars, alphanumeric/underscore/hyphen`,
    )
  }
  if (!KEY_RE.test(key)) {
    throw new Error(
      `Invalid metafield key "${key}" — must be 3-64 chars, alphanumeric/underscore/hyphen`,
    )
  }
}

function validateValueType(valueType: string | undefined): void {
  if (valueType === undefined) return
  if (!(VALUE_TYPES as readonly string[]).includes(valueType)) {
    throw new Error(
      `Invalid metafield value_type "${valueType}" — must be one of: ${VALUE_TYPES.join(', ')}`,
    )
  }
}

function serializeValue(value: unknown): string {
  const serialized = JSON.stringify(value)
  // JSON.stringify returns undefined for e.g. functions — reject those.
  if (serialized === undefined) {
    throw new Error(
      'Invalid metafield value — must be JSON-serializable (no functions, no Symbol, no BigInt)',
    )
  }
  const byteLength = Buffer.byteLength(serialized, 'utf8')
  if (byteLength > MAX_VALUE_BYTES) {
    throw new Error(
      `Metafield value too large (${byteLength} bytes) — max ${MAX_VALUE_BYTES} bytes (5 MB)`,
    )
  }
  return serialized
}

// ---------------------------------------------------------------------------
// CRUD — by tuple (shop_id, owner_type, owner_id, namespace, key)
// ---------------------------------------------------------------------------

/**
 * Upsert a metafield by tuple. Returns the stored row.
 *
 * On update path, `value_type` is preserved if caller omits it.
 * On insert path, `value_type` defaults to `'single_line_text_field'`.
 */
export async function setMetafield(
  db: Kysely<Database>,
  input: SetMetafieldInput,
): Promise<Metafield> {
  validateNamespaceKey(input.namespace, input.key)
  validateValueType(input.value_type)

  const serialized = serializeValue(input.value)

  // Try update first (hot path for merchants editing existing fields).
  // IMPORTANT: only overwrite value_type if caller explicitly passed one —
  // otherwise preserve the existing value_type. Same for description.
  const updateSet: Record<string, unknown> = {
    value: serialized,
    updated_at: new Date().toISOString(),
  }
  if (input.value_type !== undefined) updateSet.value_type = input.value_type
  if (input.description !== undefined) updateSet.description = input.description

  const updated = await db
    .updateTable('metafields')
    .set(updateSet as any)
    .where('shop_id', '=', input.shop_id)
    .where('owner_type', '=', input.owner_type)
    .where('owner_id', '=', input.owner_id)
    .where('namespace', '=', input.namespace)
    .where('key', '=', input.key)
    .returningAll()
    .executeTakeFirst()

  if (updated) return updated as Metafield

  // Insert (not found path).
  const inserted = await db
    .insertInto('metafields')
    .values({
      shop_id: input.shop_id,
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      namespace: input.namespace,
      key: input.key,
      value: serialized as any,
      value_type: input.value_type ?? 'single_line_text_field',
      description: input.description ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()

  return inserted as Metafield
}

/**
 * Get a single metafield by its unique tuple. Returns null if not set.
 */
export async function getMetafield(
  db: Kysely<Database>,
  input: GetMetafieldInput,
): Promise<Metafield | null> {
  const row = await db
    .selectFrom('metafields')
    .selectAll()
    .where('shop_id', '=', input.shop_id)
    .where('owner_type', '=', input.owner_type)
    .where('owner_id', '=', input.owner_id)
    .where('namespace', '=', input.namespace)
    .where('key', '=', input.key)
    .executeTakeFirst()

  return (row as Metafield | undefined) ?? null
}

/**
 * List all metafields for an owner (optionally filtered by namespace).
 */
export async function listMetafields(
  db: Kysely<Database>,
  shop_id: string,
  owner_type: MetafieldOwnerType,
  owner_id: string,
  namespace?: string,
): Promise<Metafield[]> {
  let q = db
    .selectFrom('metafields')
    .selectAll()
    .where('shop_id', '=', shop_id)
    .where('owner_type', '=', owner_type)
    .where('owner_id', '=', owner_id)

  if (namespace) q = q.where('namespace', '=', namespace)

  const rows = await q.orderBy('namespace').orderBy('key').execute()
  return rows as Metafield[]
}

/**
 * Delete a metafield by its unique tuple. Returns true if a row was deleted.
 */
export async function deleteMetafield(
  db: Kysely<Database>,
  input: GetMetafieldInput,
): Promise<boolean> {
  const result = await db
    .deleteFrom('metafields')
    .where('shop_id', '=', input.shop_id)
    .where('owner_type', '=', input.owner_type)
    .where('owner_id', '=', input.owner_id)
    .where('namespace', '=', input.namespace)
    .where('key', '=', input.key)
    .executeTakeFirst()

  return Number(result?.numDeletedRows ?? 0) > 0
}

// ---------------------------------------------------------------------------
// CRUD — by ID (shop-scoped; for REST /metafields/:id endpoints)
// ---------------------------------------------------------------------------

/**
 * Get a metafield by its primary key, scoped to a shop (prevents cross-shop leaks).
 * Returns null if not found or belongs to a different shop.
 */
export async function getMetafieldById(
  db: Kysely<Database>,
  shop_id: string,
  id: string,
): Promise<Metafield | null> {
  const row = await db
    .selectFrom('metafields')
    .selectAll()
    .where('id', '=', id)
    .where('shop_id', '=', shop_id)
    .executeTakeFirst()

  return (row as Metafield | undefined) ?? null
}

/**
 * Update a metafield by its primary key, scoped to a shop.
 * Returns the updated row, or null if not found / not owned by shop.
 *
 * Only `value`, `value_type`, and `description` are mutable via this path.
 * Namespace/key/owner are immutable — to "rename" a metafield, delete + re-create.
 */
export async function updateMetafieldById(
  db: Kysely<Database>,
  id: string,
  input: UpdateMetafieldByIdInput,
): Promise<Metafield | null> {
  validateValueType(input.value_type)

  const updateSet: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (input.value !== undefined) {
    updateSet.value = serializeValue(input.value)
  }
  if (input.value_type !== undefined) updateSet.value_type = input.value_type
  if (input.description !== undefined) updateSet.description = input.description

  const updated = await db
    .updateTable('metafields')
    .set(updateSet as any)
    .where('id', '=', id)
    .where('shop_id', '=', input.shop_id)
    .returningAll()
    .executeTakeFirst()

  return (updated as Metafield | undefined) ?? null
}

/**
 * Delete a metafield by its primary key, scoped to a shop.
 * Returns true iff a row owned by this shop was deleted.
 */
export async function deleteMetafieldById(
  db: Kysely<Database>,
  shop_id: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('metafields')
    .where('id', '=', id)
    .where('shop_id', '=', shop_id)
    .executeTakeFirst()

  return Number(result?.numDeletedRows ?? 0) > 0
}
