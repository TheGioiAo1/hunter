/**
 * Lenful credential CRUD service.
 *
 * Business rule: only one active credential at a time (enforced by
 * a partial unique index in migration 030). Saving a new active
 * credential deactivates any existing ones atomically.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import { encryptSecret } from './crypto.ts'

export interface LenfulCredentialPublic {
  readonly id: string
  readonly label: string
  readonly user_name: string
  readonly base_url: string
  readonly is_active: boolean
  readonly lenful_seller_id: string | null
  readonly lenful_store_id: string | null
  readonly lenful_store_name: string | null
  readonly last_login_at: string | null
  readonly last_error_at: string | null
  readonly last_error_msg: string | null
  readonly created_at: string
  readonly updated_at: string
}

export async function listCredentials(
  db: Kysely<Database>,
): Promise<ReadonlyArray<LenfulCredentialPublic>> {
  const rows = await db
    .selectFrom('lenful_credentials')
    .select([
      'id',
      'label',
      'user_name',
      'base_url',
      'is_active',
      'lenful_seller_id',
      'lenful_store_id',
      'lenful_store_name',
      'last_login_at',
      'last_error_at',
      'last_error_msg',
      'created_at',
      'updated_at',
    ])
    .orderBy('created_at', 'desc')
    .execute()
  return rows as unknown as ReadonlyArray<LenfulCredentialPublic>
}

export async function getActiveCredential(
  db: Kysely<Database>,
): Promise<LenfulCredentialPublic | null> {
  const row = await db
    .selectFrom('lenful_credentials')
    .select([
      'id',
      'label',
      'user_name',
      'base_url',
      'is_active',
      'lenful_seller_id',
      'lenful_store_id',
      'lenful_store_name',
      'last_login_at',
      'last_error_at',
      'last_error_msg',
      'created_at',
      'updated_at',
    ])
    .where('is_active', '=', true)
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  return (row ?? null) as unknown as LenfulCredentialPublic | null
}

export interface CreateCredentialInput {
  readonly label: string
  readonly userName: string
  readonly password: string
  readonly baseUrl?: string
  readonly lenfulStoreId?: string
  readonly lenfulStoreName?: string
  readonly createdBy?: string | null
}

export async function createCredential(
  db: Kysely<Database>,
  input: CreateCredentialInput,
): Promise<string> {
  return await db.transaction().execute(async (tx) => {
    // Deactivate any currently-active credential first (partial unique
    // index allows only one is_active = true row).
    await tx
      .updateTable('lenful_credentials')
      .set({ is_active: false, updated_at: new Date().toISOString() })
      .where('is_active', '=', true)
      .execute()

    const row = await tx
      .insertInto('lenful_credentials')
      .values({
        label: input.label,
        user_name: input.userName,
        password_encrypted: encryptSecret(input.password),
        base_url: input.baseUrl ?? 'https://s-lencam.lenful.com',
        lenful_store_id: input.lenfulStoreId ?? null,
        lenful_store_name: input.lenfulStoreName ?? null,
        is_active: true,
        created_by: input.createdBy ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
}

export interface UpdateCredentialInput {
  readonly label?: string
  readonly userName?: string
  readonly password?: string
  readonly baseUrl?: string
  readonly lenfulStoreId?: string
  readonly lenfulStoreName?: string
  readonly isActive?: boolean
}

export async function updateCredential(
  db: Kysely<Database>,
  id: string,
  input: UpdateCredentialInput,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    if (input.isActive === true) {
      await tx
        .updateTable('lenful_credentials')
        .set({ is_active: false, updated_at: new Date().toISOString() })
        .where('is_active', '=', true)
        .where('id', '!=', id)
        .execute()
    }
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (input.label !== undefined) patch.label = input.label
    if (input.userName !== undefined) patch.user_name = input.userName
    if (input.password !== undefined) patch.password_encrypted = encryptSecret(input.password)
    if (input.baseUrl !== undefined) patch.base_url = input.baseUrl
    if (input.lenfulStoreId !== undefined) patch.lenful_store_id = input.lenfulStoreId
    if (input.lenfulStoreName !== undefined) patch.lenful_store_name = input.lenfulStoreName
    if (input.isActive !== undefined) patch.is_active = input.isActive
    // Clearing a cached token forces a fresh login on the next call.
    if (input.password !== undefined) {
      patch.bearer_token_encrypted = null
      patch.bearer_token_expires_at = null
    }
    await tx
      .updateTable('lenful_credentials')
      .set(patch as any)
      .where('id', '=', id)
      .execute()
  })
}

export async function deleteCredential(
  db: Kysely<Database>,
  id: string,
): Promise<void> {
  // We soft-delete by flipping is_active; hard delete would cascade
  // into lenful_orders.credential_id which we must keep for audit.
  await db
    .updateTable('lenful_credentials')
    .set({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()
}

export async function recordCredentialError(
  db: Kysely<Database>,
  id: string,
  message: string,
): Promise<void> {
  await db
    .updateTable('lenful_credentials')
    .set({
      last_error_at: new Date().toISOString(),
      last_error_msg: message.slice(0, 1000),
    })
    .where('id', '=', id)
    .execute()
}
