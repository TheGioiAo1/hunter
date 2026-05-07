/**
 * Gbox Platform — Auth Service
 *
 * User management, sessions, API tokens, and shop role assignments.
 */

import { randomBytes, createHash } from 'crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  email: string
  name?: string | null
  avatar_url?: string | null
}

export interface SessionMeta {
  ip_address?: string | null
  user_agent?: string | null
  expires_in_ms?: number
}

export interface CreateApiTokenInput {
  label: string
  scopes?: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a new user.
 */
export async function createUser(
  db: Kysely<Database>,
  data: CreateUserInput,
) {
  const user = await db
    .insertInto('users')
    .values({
      email: data.email,
      name: data.name ?? null,
      avatar_url: data.avatar_url ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return user
}

/**
 * Look up a user by email.
 */
export async function getUserByEmail(
  db: Kysely<Database>,
  email: string,
) {
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst()

  return user ?? null
}

/**
 * Create a session for a user. Returns the raw token (to be sent to the
 * client) along with the session row.
 */
export async function createSession(
  db: Kysely<Database>,
  userId: string,
  meta: SessionMeta = {},
) {
  const token = generateToken()
  const tokenHash = hashToken(token)
  const expiresAt = new Date(
    Date.now() + (meta.expires_in_ms ?? DEFAULT_SESSION_TTL_MS),
  ).toISOString()

  const session = await db
    .insertInto('sessions')
    .values({
      user_id: userId,
      token_hash: tokenHash,
      ip_address: meta.ip_address ?? null,
      user_agent: meta.user_agent ?? null,
      expires_at: expiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return { token, session }
}

/**
 * Validate a session token. Returns the user and session if valid, or null.
 */
export async function validateSession(
  db: Kysely<Database>,
  token: string,
) {
  const tokenHash = hashToken(token)

  const session = await db
    .selectFrom('sessions')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .where('expires_at', '>', new Date().toISOString())
    .executeTakeFirst()

  if (!session) return null

  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', session.user_id)
    .where('status', '=', 'active')
    .executeTakeFirst()

  if (!user) return null

  return { user, session }
}

/**
 * Delete (invalidate) a session by its raw token.
 */
export async function deleteSession(
  db: Kysely<Database>,
  token: string,
): Promise<void> {
  const tokenHash = hashToken(token)
  await db
    .deleteFrom('sessions')
    .where('token_hash', '=', tokenHash)
    .execute()
}

/**
 * Assign a user to a shop with a given role.
 */
export async function assignUserToShop(
  db: Kysely<Database>,
  userId: string,
  shopId: string,
  role: string = 'staff',
): Promise<void> {
  await db
    .insertInto('user_shops')
    .values({
      user_id: userId,
      shop_id: shopId,
      role,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'shop_id']).doUpdateSet({ role } as any),
    )
    .execute()
}

/**
 * Get all shops for a user, including their role in each.
 */
export async function getUserShops(
  db: Kysely<Database>,
  userId: string,
) {
  const rows = await db
    .selectFrom('user_shops')
    .innerJoin('shops', 'shops.id', 'user_shops.shop_id')
    .selectAll('shops')
    .select('user_shops.role as user_role')
    .where('user_shops.user_id', '=', userId)
    .execute()

  return rows
}

/**
 * Create an API token for a user + shop combination.
 * Returns the raw token (only shown once) and the stored row.
 */
export async function createApiToken(
  db: Kysely<Database>,
  userId: string,
  shopId: string,
  input: CreateApiTokenInput,
) {
  const token = `gbox_${generateToken()}`
  const tokenHash = hashToken(token)

  const row = await db
    .insertInto('api_tokens')
    .values({
      user_id: userId,
      shop_id: shopId,
      name: input.label,
      token_hash: tokenHash,
      scopes: input.scopes ? JSON.stringify(input.scopes) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return { token, api_token: row }
}

/**
 * Validate an API token. Returns the user, shop, and scopes if valid.
 */
export async function validateApiToken(
  db: Kysely<Database>,
  token: string,
) {
  const tokenHash = hashToken(token)

  const row = await db
    .selectFrom('api_tokens')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst()

  if (!row) return null

  // Update last_used_at
  await db
    .updateTable('api_tokens')
    .set({ last_used_at: new Date().toISOString() } as any)
    .where('id', '=', row.id)
    .execute()

  const [user, shop] = await Promise.all([
    db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', row.user_id)
      .where('status', '=', 'active')
      .executeTakeFirst(),
    db
      .selectFrom('shops')
      .selectAll()
      .where('id', '=', row.shop_id)
      .executeTakeFirst(),
  ])

  if (!user || !shop) return null

  return {
    user,
    shop,
    scopes: (row.scopes ?? []) as string[],
  }
}
