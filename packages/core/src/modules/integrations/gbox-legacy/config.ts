/**
 * CRUD service for `legacy_gbox_config` (migration 033).
 *
 * Singleton pattern — only one `is_active = true` row at a time. Saving
 * a new active row deactivates any existing one atomically.
 *
 * Passwords are encrypted with the same AES-256-GCM envelope used by
 * Lenful credentials (see fulfillment/lenful/crypto.ts) — one KEK to
 * rotate in prod, one to test in dev.
 */

import type { Kysely } from 'kysely'
import type { Database } from '../../../../../db/src/schema/tables.js'
import { encryptSecret, decryptSecret } from '../../fulfillment/lenful/crypto.ts'
import { invalidateToken } from './token-cache.ts'

export interface LegacyGboxConfigPublic {
  readonly id: string
  readonly label: string
  readonly master_email: string
  readonly master_shop_id: string
  readonly master_shop_name: string | null
  readonly auth_base: string
  readonly product_base: string
  readonly shop_base: string
  readonly is_active: boolean
  readonly last_login_at: string | null
  readonly last_login_status: string | null
  readonly last_error_at: string | null
  readonly last_error_msg: string | null
  readonly last_push_at: string | null
  readonly last_push_count: number
  readonly created_at: string
  readonly updated_at: string
}

/** Internal shape — includes the decrypted password. NEVER cross a process boundary. */
export interface LegacyGboxConfigResolved extends LegacyGboxConfigPublic {
  readonly master_password: string
}

const PUBLIC_COLUMNS = [
  'id',
  'label',
  'master_email',
  'master_shop_id',
  'master_shop_name',
  'auth_base',
  'product_base',
  'shop_base',
  'is_active',
  'last_login_at',
  'last_login_status',
  'last_error_at',
  'last_error_msg',
  'last_push_at',
  'last_push_count',
  'created_at',
  'updated_at',
] as const

export async function listConfigs(
  db: Kysely<Database>,
): Promise<ReadonlyArray<LegacyGboxConfigPublic>> {
  const rows = await db
    .selectFrom('legacy_gbox_config')
    .select(PUBLIC_COLUMNS as any)
    .orderBy('created_at', 'desc')
    .execute()
  return rows as unknown as ReadonlyArray<LegacyGboxConfigPublic>
}

export async function getConfigById(
  db: Kysely<Database>,
  id: string,
): Promise<LegacyGboxConfigPublic | null> {
  const row = await db
    .selectFrom('legacy_gbox_config')
    .select(PUBLIC_COLUMNS as any)
    .where('id', '=', id)
    .executeTakeFirst()
  return (row ?? null) as unknown as LegacyGboxConfigPublic | null
}

export async function getActiveConfig(
  db: Kysely<Database>,
): Promise<LegacyGboxConfigPublic | null> {
  const row = await db
    .selectFrom('legacy_gbox_config')
    .select(PUBLIC_COLUMNS as any)
    .where('is_active', '=', true)
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  return (row ?? null) as unknown as LegacyGboxConfigPublic | null
}

/**
 * Fetch the active config AND decrypt the master password.
 * Only use this inside the login path — never log the returned object.
 */
export async function getActiveConfigResolved(
  db: Kysely<Database>,
): Promise<LegacyGboxConfigResolved | null> {
  const row = await db
    .selectFrom('legacy_gbox_config')
    .selectAll()
    .where('is_active', '=', true)
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  if (!row) return null
  const password = decryptSecret(row.master_password_encrypted as Buffer)
  const { master_password_encrypted: _drop, ...rest } = row as any
  return { ...(rest as LegacyGboxConfigPublic), master_password: password }
}

export interface CreateConfigInput {
  readonly label: string
  readonly masterEmail: string
  readonly masterPassword: string
  readonly masterShopId: string
  readonly masterShopName?: string
  readonly authBase?: string
  readonly productBase?: string
  readonly shopBase?: string
  readonly createdBy?: string | null
}

export async function createConfig(
  db: Kysely<Database>,
  input: CreateConfigInput,
): Promise<string> {
  return await db.transaction().execute(async (tx) => {
    // Safety rail: only one is_active=true row at a time (partial
    // unique index in migration 033 enforces this, but deactivating
    // first avoids the constraint violation).
    await tx
      .updateTable('legacy_gbox_config')
      .set({ is_active: false, updated_at: new Date().toISOString() })
      .where('is_active', '=', true)
      .execute()

    const row = await tx
      .insertInto('legacy_gbox_config')
      .values({
        label: input.label,
        master_email: input.masterEmail,
        master_password_encrypted: encryptSecret(input.masterPassword),
        master_shop_id: input.masterShopId,
        master_shop_name: input.masterShopName ?? null,
        auth_base: input.authBase ?? 'https://api-auth.gbox.co',
        product_base: input.productBase ?? 'https://api-product.gbox.co',
        shop_base: input.shopBase ?? 'https://api-shop.gbox.co',
        is_active: true,
        created_by: input.createdBy ?? null,
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()

    // Any token we cached for this email under any previous (now stale)
    // config row is invalid — fresh creds mean we re-login on next push.
    invalidateToken(
      input.authBase ?? 'https://api-auth.gbox.co',
      input.masterEmail,
    )
    return row.id
  })
}

export interface UpdateConfigInput {
  readonly label?: string
  readonly masterEmail?: string
  readonly masterPassword?: string // if present → re-encrypt + invalidate cache
  readonly masterShopId?: string
  readonly masterShopName?: string | null
  readonly authBase?: string
  readonly productBase?: string
  readonly shopBase?: string
  readonly isActive?: boolean
}

export async function updateConfig(
  db: Kysely<Database>,
  id: string,
  input: UpdateConfigInput,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    if (input.isActive === true) {
      await tx
        .updateTable('legacy_gbox_config')
        .set({ is_active: false, updated_at: new Date().toISOString() })
        .where('is_active', '=', true)
        .where('id', '!=', id)
        .execute()
    }
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (input.label !== undefined) patch.label = input.label
    if (input.masterEmail !== undefined) patch.master_email = input.masterEmail
    if (input.masterPassword !== undefined) {
      patch.master_password_encrypted = encryptSecret(input.masterPassword)
    }
    if (input.masterShopId !== undefined) patch.master_shop_id = input.masterShopId
    if (input.masterShopName !== undefined) patch.master_shop_name = input.masterShopName
    if (input.authBase !== undefined) patch.auth_base = input.authBase
    if (input.productBase !== undefined) patch.product_base = input.productBase
    if (input.shopBase !== undefined) patch.shop_base = input.shopBase
    if (input.isActive !== undefined) patch.is_active = input.isActive

    await tx
      .updateTable('legacy_gbox_config')
      .set(patch as any)
      .where('id', '=', id)
      .execute()

    // Any password / email / authBase change invalidates the in-memory
    // token so the next push relogs in with the new creds.
    if (
      input.masterPassword !== undefined ||
      input.masterEmail !== undefined ||
      input.authBase !== undefined
    ) {
      const row = await tx
        .selectFrom('legacy_gbox_config')
        .select(['master_email', 'auth_base'])
        .where('id', '=', id)
        .executeTakeFirst()
      if (row) invalidateToken(row.auth_base, row.master_email)
    }
  })
}

export async function deleteConfig(
  db: Kysely<Database>,
  id: string,
): Promise<void> {
  // Soft delete — hard delete would cascade into legacy_gbox_push_log
  // which we keep for audit. Flipping is_active=false removes it from
  // the active-config lookup path.
  const row = await db
    .selectFrom('legacy_gbox_config')
    .select(['master_email', 'auth_base'])
    .where('id', '=', id)
    .executeTakeFirst()
  await db
    .updateTable('legacy_gbox_config')
    .set({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()
  if (row) invalidateToken(row.auth_base, row.master_email)
}

export async function markLoginOk(
  db: Kysely<Database>,
  id: string,
): Promise<void> {
  await db
    .updateTable('legacy_gbox_config')
    .set({
      last_login_at: new Date().toISOString(),
      last_login_status: 'ok',
      last_error_at: null,
      last_error_msg: null,
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()
}

export async function markLoginError(
  db: Kysely<Database>,
  id: string,
  status: 'auth_failed' | 'network_error',
  message: string,
): Promise<void> {
  await db
    .updateTable('legacy_gbox_config')
    .set({
      last_login_status: status,
      last_error_at: new Date().toISOString(),
      last_error_msg: message.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .execute()
}

export async function bumpPushCount(
  db: Kysely<Database>,
  id: string,
): Promise<void> {
  await db
    .updateTable('legacy_gbox_config')
    .set((eb) => ({
      last_push_at: new Date().toISOString(),
      last_push_count: eb('last_push_count', '+', 1),
      updated_at: new Date().toISOString(),
    }))
    .where('id', '=', id)
    .execute()
}
