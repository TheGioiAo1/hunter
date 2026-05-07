/**
 * Gbox Platform — Auth Service (Mongo edition)
 *
 * User management, sessions, API tokens, and shop role assignments.
 * Backing collections live in `Gbox-Users` (users / user_shops /
 * api_tokens) and `Gbox-Shops` (shops). Cross-DB joins are app-side
 * (Mongo doesn't allow $lookup across databases).
 *
 * Legacy `db: Kysely<...>` first parameter is preserved on each function
 * for source-compat with the dozens of callers still wiring it; the
 * value is ignored — the helpers fetch the proper Mongo handle from
 * `getMongoDb()`.
 */

import { randomBytes, createHash } from 'crypto'
import { nanoid } from 'nanoid'
import { getMongoDb } from '../db/mongo.js'
import type {
  ApiTokenDoc,
  ShopDoc,
  UserDoc,
  UserShopDoc,
} from '../db/types.js'

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
// Users
// ---------------------------------------------------------------------------

export async function createUser(
  _db: unknown,
  data: CreateUserInput,
): Promise<UserDoc> {
  const db = await getMongoDb('USERS')
  const now = new Date().toISOString()
  const doc: UserDoc = {
    _id: nanoid(),
    email: data.email,
    name: data.name ?? null,
    password_hash: null,
    role: 'staff',
    status: 'pending_verification',
    avatar_url: data.avatar_url ?? null,
    created_at: now,
    updated_at: now,
  }
  await db.collection<UserDoc>('users').insertOne(doc)
  return doc
}

export async function getUserByEmail(
  _db: unknown,
  email: string,
): Promise<UserDoc | null> {
  const db = await getMongoDb('USERS')
  return db.collection<UserDoc>('users').findOne({ email })
}

export async function getUserById(
  _db: unknown,
  id: string,
): Promise<UserDoc | null> {
  const db = await getMongoDb('USERS')
  return db.collection<UserDoc>('users').findOne({ _id: id })
}

// ---------------------------------------------------------------------------
// Sessions (token-based; cookies handled by session.ts. This helper is
// the legacy minimal API that other code paths import directly.)
// ---------------------------------------------------------------------------

export async function createSession(
  _db: unknown,
  userId: string,
  meta: SessionMeta = {},
) {
  const db = await getMongoDb('USERS')
  const token = generateToken()
  const tokenHash = hashToken(token)
  const expiresAt = new Date(
    Date.now() + (meta.expires_in_ms ?? DEFAULT_SESSION_TTL_MS),
  ).toISOString()

  const session = {
    _id: nanoid(),
    user_id: userId,
    token_hash: tokenHash,
    ip_address: meta.ip_address ?? null,
    user_agent: meta.user_agent ?? null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
    two_fa_verified: true,
  }
  await db.collection('sessions').insertOne(session)

  return { token, session }
}

export async function validateSession(_db: unknown, token: string) {
  const db = await getMongoDb('USERS')
  const tokenHash = hashToken(token)

  const session = await db.collection('sessions').findOne({
    token_hash: tokenHash,
    expires_at: { $gt: new Date().toISOString() },
  })
  if (!session) return null

  const user = await db
    .collection<UserDoc>('users')
    .findOne({ _id: session.user_id, status: 'active' })
  if (!user) return null

  return { user, session }
}

export async function deleteSession(_db: unknown, token: string): Promise<void> {
  const db = await getMongoDb('USERS')
  await db.collection('sessions').deleteOne({ token_hash: hashToken(token) })
}

// ---------------------------------------------------------------------------
// User-Shop assignment
// ---------------------------------------------------------------------------

export async function assignUserToShop(
  _db: unknown,
  userId: string,
  shopId: string,
  role: string = 'staff',
): Promise<void> {
  const db = await getMongoDb('USERS')
  await db
    .collection<UserShopDoc>('user_shops')
    .updateOne(
      { user_id: userId, shop_id: shopId },
      {
        $set: { role },
        $setOnInsert: {
          _id: nanoid(),
          user_id: userId,
          shop_id: shopId,
          created_at: new Date().toISOString(),
        },
      },
      { upsert: true },
    )
}

export async function getUserShops(_db: unknown, userId: string) {
  const usersDb = await getMongoDb('USERS')
  const shopsDb = await getMongoDb('SHOPS')

  const memberships = await usersDb
    .collection<UserShopDoc>('user_shops')
    .find({ user_id: userId })
    .toArray()
  if (memberships.length === 0) return []

  const shopIds = memberships.map((m) => m.shop_id)
  const shops = await shopsDb
    .collection<ShopDoc>('shops')
    .find({ _id: { $in: shopIds } })
    .toArray()

  const byId = new Map(shops.map((s) => [s._id, s]))
  return memberships
    .map((m) => {
      const s = byId.get(m.shop_id)
      if (!s) return null
      return { ...s, user_role: m.role }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

export async function createApiToken(
  _db: unknown,
  userId: string,
  shopId: string,
  input: CreateApiTokenInput,
) {
  const db = await getMongoDb('USERS')
  const token = `gbox_${generateToken()}`
  const tokenHash = hashToken(token)

  const row: ApiTokenDoc = {
    _id: nanoid(),
    user_id: userId,
    shop_id: shopId,
    name: input.label,
    token_hash: tokenHash,
    scopes: input.scopes ? JSON.stringify(input.scopes) : null,
    last_used_at: null,
    created_at: new Date().toISOString(),
  }
  await db.collection<ApiTokenDoc>('api_tokens').insertOne(row)

  return { token, api_token: row }
}

export async function validateApiToken(_db: unknown, token: string) {
  const usersDb = await getMongoDb('USERS')
  const shopsDb = await getMongoDb('SHOPS')
  const tokenHash = hashToken(token)

  const row = await usersDb
    .collection<ApiTokenDoc>('api_tokens')
    .findOne({ token_hash: tokenHash })
  if (!row) return null

  await usersDb
    .collection<ApiTokenDoc>('api_tokens')
    .updateOne(
      { _id: row._id },
      { $set: { last_used_at: new Date().toISOString() } },
    )

  const [user, shop] = await Promise.all([
    usersDb
      .collection<UserDoc>('users')
      .findOne({ _id: row.user_id, status: 'active' }),
    shopsDb.collection<ShopDoc>('shops').findOne({ _id: row.shop_id }),
  ])

  if (!user || !shop) return null

  return {
    user,
    shop,
    scopes: row.scopes ? (JSON.parse(row.scopes) as string[]) : [],
  }
}
