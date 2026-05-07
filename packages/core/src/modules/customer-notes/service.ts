/**
 * Gbox Platform — Customer Notes Service (Phase 4 PR1)
 *
 * Append-only timeline notes attached to a customer. Mirrors Shopify's
 * "Notes" timeline section on the customer detail page — every note is
 * its own row with author attribution and a timestamp, as opposed to
 * the single overwriteable `customers.note` column.
 *
 * All queries are shop-scoped. A merchant can never observe, add, or
 * delete a note on a customer that does not belong to their shop —
 * the service layer treats cross-shop access as "not found" rather
 * than leaking 403 semantics.
 */

import type { Kysely } from 'kysely'
import type { Database, CustomerNoteTable } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Selectable<T> = {
  [K in keyof T]: T[K] extends import('kysely').ColumnType<infer S, any, any>
    ? S
    : T[K]
}

export type CustomerNote = Selectable<CustomerNoteTable>

export interface AddCustomerNoteInput {
  shop_id: string
  customer_id: string
  body: string
  author_user_id?: string | null
  author_name_snapshot?: string | null
}

// Shopify caps notes at 10k chars in admin UI; we match that here to keep
// payloads sane and to prevent a malicious merchant from dumping binary
// blobs into their own notes stream.
export const MAX_NOTE_LENGTH = 10_000
export const MIN_NOTE_LENGTH = 1

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

/**
 * Append a note to a customer's timeline.
 *
 * Returns the inserted row on success. Throws if:
 *   - body fails length validation
 *   - customer does not exist OR belongs to a different shop
 *
 * The shop-scope check is done as a single EXISTS-style lookup before the
 * insert; without it a malicious admin from shop A could dump notes onto
 * a customer from shop B just by guessing (or brute-forcing) a UUID.
 */
export async function addNote(
  db: Kysely<Database>,
  input: AddCustomerNoteInput,
): Promise<CustomerNote> {
  const body = (input.body ?? '').trim()
  if (body.length < MIN_NOTE_LENGTH) {
    throw new Error('Note body must not be empty')
  }
  if (body.length > MAX_NOTE_LENGTH) {
    throw new Error(
      `Note body must be ${MAX_NOTE_LENGTH} characters or fewer`,
    )
  }

  // Verify customer belongs to this shop. No join on insert — explicit
  // check keeps error semantics clean ("customer not found" vs. "insert
  // violated FK") and avoids a silently-successful cross-shop insert if
  // the FK happens to resolve.
  const customer = await db
    .selectFrom('customers')
    .select('id')
    .where('id', '=', input.customer_id)
    .where('shop_id', '=', input.shop_id)
    .executeTakeFirst()

  if (!customer) {
    throw new Error('Customer not found in this shop')
  }

  const inserted = await db
    .insertInto('customer_notes')
    .values({
      shop_id: input.shop_id,
      customer_id: input.customer_id,
      body,
      author_user_id: input.author_user_id ?? null,
      author_name_snapshot: input.author_name_snapshot ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()

  return inserted as CustomerNote
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListCustomerNotesInput {
  shop_id: string
  customer_id: string
  limit?: number
  offset?: number
}

/**
 * List notes for a customer, most-recent first.
 *
 * Shop-scoped — if the `customer_id` belongs to a different shop we
 * return an empty list rather than an error, matching Shopify's
 * "silently empty" behaviour for cross-shop detail lookups.
 */
export async function listNotes(
  db: Kysely<Database>,
  input: ListCustomerNotesInput,
): Promise<CustomerNote[]> {
  const limit = Math.min(Math.max(1, input.limit ?? 50), 250)
  const offset = Math.max(0, input.offset ?? 0)

  const rows = await db
    .selectFrom('customer_notes')
    .selectAll()
    .where('shop_id', '=', input.shop_id)
    .where('customer_id', '=', input.customer_id)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()

  return rows as CustomerNote[]
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteCustomerNoteInput {
  shop_id: string
  note_id: string
}

/**
 * Delete a note by id, but only if it belongs to the calling shop.
 * Returns true if a row was deleted, false otherwise (note was missing
 * or owned by another shop — caller should treat both as 404).
 */
export async function deleteNote(
  db: Kysely<Database>,
  input: DeleteCustomerNoteInput,
): Promise<boolean> {
  const result = await db
    .deleteFrom('customer_notes')
    .where('id', '=', input.note_id)
    .where('shop_id', '=', input.shop_id)
    .executeTakeFirst()

  return Number(result?.numDeletedRows ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Count (cheap helper for badges / pagination)
// ---------------------------------------------------------------------------

export async function countNotes(
  db: Kysely<Database>,
  shop_id: string,
  customer_id: string,
): Promise<number> {
  const row = await db
    .selectFrom('customer_notes')
    .select((eb) => eb.fn.countAll().as('count'))
    .where('shop_id', '=', shop_id)
    .where('customer_id', '=', customer_id)
    .executeTakeFirst()

  return Number(row?.count ?? 0)
}
