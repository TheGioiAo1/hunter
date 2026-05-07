/**
 * SP-01: Shared Session & Cookie System (Mongo edition)
 *
 * Session cookie shared across all admin/storefront subdomains.
 * Storage: MongoDB `Gbox-Users.sessions`. TTL: 30-day sliding window.
 *
 * Public API kept stable for callers; the legacy `db: Kysely<any>` first
 * argument is now ignored — pass `null` from migrating code, or omit it
 * via the new helpers (validateSessionMongo, …) once callers are updated.
 */

import { createHash, randomBytes } from 'crypto'
import { nanoid } from 'nanoid'
import { cacheGet, cacheSet, cacheDel } from '../cache/redis.js'
import { getMongoDb } from '../db/mongo.js'
import type { SessionDoc, UserDoc, UserShopDoc } from '../db/types.js'

// ============ TYPES ============

export interface SessionUser {
  id: string
  email: string
  name: string
  role: string
  avatarUrl: string | null
}

export interface SessionData {
  user: SessionUser
  shopId: string | null
  shopRole: string | null
  createdAt: string
  expiresAt: string
}

export interface SessionValidationResult {
  valid: boolean
  session: SessionData | null
  token: string | null
}

export interface CookieOptions {
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax' | 'strict' | 'none'
  maxAge: number
}

// ============ CONSTANTS ============

const SESSION_COOKIE_NAME = 'gbox_session'
const SESSION_TTL_DAYS = 30
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
const SLIDING_WINDOW_THRESHOLD_MS = 24 * 60 * 60 * 1000

// ============ TOKEN HELPERS ============

function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ============ COOKIE HELPERS ============

export function getSessionCookieOptions(isProduction: boolean): CookieOptions {
  const envDomain = (process.env.SESSION_COOKIE_DOMAIN ?? '').trim()
  return {
    domain: envDomain,
    path: '/',
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS / 1000,
  }
}

export function serializeSessionCookie(token: string, options: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    ...(options.domain ? [`Domain=${options.domain}`] : []),
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite.charAt(0).toUpperCase() + options.sameSite.slice(1)}`,
  ]
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!cookieHeader) return cookies
  for (const pair of cookieHeader.split(';')) {
    const [key, ...val] = pair.trim().split('=')
    if (key) cookies[key.trim()] = val.join('=').trim()
  }
  return cookies
}

export function getSessionTokenFromCookies(cookieHeader: string): string | null {
  const cookies = parseCookies(cookieHeader)
  return cookies[SESSION_COOKIE_NAME] || null
}

export function clearSessionCookie(isProduction: boolean): string {
  const opts = getSessionCookieOptions(isProduction)
  const domainPart = opts.domain ? `Domain=${opts.domain}; ` : ''
  return `${SESSION_COOKIE_NAME}=; ${domainPart}Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly${opts.secure ? '; Secure' : ''}`
}

// ============ SESSION CRUD (Mongo) ============

/**
 * Create a new session for a user.
 * Returns the raw token (set in cookie) — only opportunity to capture it.
 *
 * Legacy `db` arg accepted for source-compat; ignored in Mongo edition.
 */
export async function createSession(
  _db: unknown,
  userId: string,
  meta: { ipAddress?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken()
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  const nowIso = new Date().toISOString()

  const db = await getMongoDb('USERS')
  const doc: SessionDoc = {
    _id: nanoid(),
    user_id: userId,
    token_hash: tokenHash,
    ip_address: meta.ipAddress ?? null,
    user_agent: meta.userAgent ?? null,
    expires_at: expiresAt.toISOString(),
    created_at: nowIso,
    two_fa_verified: true,
  }
  await db.collection<SessionDoc>('sessions').insertOne(doc)

  return { token, expiresAt }
}

/**
 * Validate a session token. Sliding window: extends if < 1 day remaining.
 * Returns user data when valid; null otherwise.
 */
export async function validateSession(
  _db: unknown,
  token: string,
): Promise<SessionValidationResult> {
  if (!token) return { valid: false, session: null, token: null }

  const tokenHash = hashToken(token)
  const cacheKey = `session:${tokenHash}`

  const cached = await cacheGet<{
    session: SessionData
    status: string
    sessionId: string
    expiresAt: string
  }>(cacheKey)
  if (cached) {
    if (new Date(cached.expiresAt) < new Date()) {
      await cacheDel(cacheKey)
      return { valid: false, session: null, token: null }
    }
    if (cached.status === 'disabled') {
      await cacheDel(cacheKey)
      await deleteSessionByHash(tokenHash)
      return { valid: false, session: null, token: null }
    }
    return { valid: true, session: cached.session, token }
  }

  const db = await getMongoDb('USERS')
  const sess = await db.collection<SessionDoc>('sessions').findOne({
    token_hash: tokenHash,
    expires_at: { $gt: new Date().toISOString() },
  })
  if (!sess) return { valid: false, session: null, token: null }

  const user = await db
    .collection<UserDoc>('users')
    .findOne({ _id: sess.user_id })
  if (!user) return { valid: false, session: null, token: null }

  if (user.status === 'disabled') {
    await deleteSessionByHash(tokenHash)
    return { valid: false, session: null, token: null }
  }

  // Sliding window
  const expiresAt = new Date(sess.expires_at)
  const remaining = expiresAt.getTime() - Date.now()
  if (remaining < SLIDING_WINDOW_THRESHOLD_MS) {
    const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
    await db
      .collection<SessionDoc>('sessions')
      .updateOne({ _id: sess._id }, { $set: { expires_at: newExpiresAt } })
    sess.expires_at = newExpiresAt
  }

  const session: SessionData = {
    user: {
      id: user._id,
      email: user.email,
      name: user.name ?? '',
      role: user.role,
      avatarUrl: user.avatar_url ?? null,
    },
    shopId: null,
    shopRole: null,
    createdAt: sess.created_at,
    expiresAt: sess.expires_at,
  }

  await cacheSet(
    cacheKey,
    {
      session,
      status: user.status,
      sessionId: sess._id,
      expiresAt: sess.expires_at,
    },
    300,
  )

  return { valid: true, session, token }
}

/**
 * Validate session AND check shop access. Owners (role=owner) bypass the
 * per-shop ACL check.
 */
export async function validateSessionWithShop(
  _db: unknown,
  token: string,
  shopId: string,
): Promise<SessionValidationResult> {
  const result = await validateSession(_db, token)
  if (!result.valid || !result.session) return result

  const db = await getMongoDb('USERS')
  const access = await db.collection<UserShopDoc>('user_shops').findOne({
    user_id: result.session.user.id,
    shop_id: shopId,
  })

  if (!access) {
    if (result.session.user.role === 'owner') {
      result.session.shopId = shopId
      result.session.shopRole = 'owner'
      return result
    }
    return { valid: false, session: null, token: null }
  }

  result.session.shopId = shopId
  result.session.shopRole = access.role
  return result
}

/**
 * List shops a user can access. Cross-DB (Gbox-Users.user_shops →
 * Gbox-Shops.shops) so we do an app-side join.
 */
export async function getUserShops(
  _db: unknown,
  userId: string,
): Promise<
  Array<{ shopId: string; shopName: string; shopSlug: string; role: string; domain: string | null }>
> {
  const usersDb = await getMongoDb('USERS')
  const shopsDb = await getMongoDb('SHOPS')

  const memberships = await usersDb
    .collection<UserShopDoc>('user_shops')
    .find({ user_id: userId })
    .toArray()
  if (memberships.length === 0) return []

  const shopIds = memberships.map((m) => m.shop_id)
  const shops = await shopsDb
    .collection('shops')
    .find({ _id: { $in: shopIds }, status: 'active' })
    .toArray()

  const shopById = new Map(shops.map((s: any) => [s._id, s]))
  return memberships
    .map((m) => {
      const s = shopById.get(m.shop_id)
      if (!s) return null
      return {
        shopId: s._id,
        shopName: s.name,
        shopSlug: s.slug,
        role: m.role,
        domain: s.domain ?? null,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.shopName.localeCompare(b.shopName))
}

export async function deleteSession(_db: unknown, token: string): Promise<void> {
  const tokenHash = hashToken(token)
  await cacheDel(`session:${tokenHash}`)
  await deleteSessionByHash(tokenHash)
}

async function deleteSessionByHash(tokenHash: string): Promise<void> {
  const db = await getMongoDb('USERS')
  await db.collection<SessionDoc>('sessions').deleteOne({ token_hash: tokenHash })
}

/**
 * Delete every session belonging to `userId`. Pass `exceptToken` to keep
 * one alive (e.g. the tab the user just changed their password in).
 */
export async function deleteAllUserSessions(
  _db: unknown,
  userId: string,
  exceptToken?: string,
): Promise<number> {
  const db = await getMongoDb('USERS')
  const filter: Record<string, unknown> = { user_id: userId }
  if (exceptToken && exceptToken.length > 0) {
    filter.token_hash = { $ne: hashToken(exceptToken) }
  }
  const result = await db.collection<SessionDoc>('sessions').deleteMany(filter)
  return result.deletedCount ?? 0
}

export async function cleanExpiredSessions(_db: unknown): Promise<number> {
  const db = await getMongoDb('USERS')
  const result = await db
    .collection<SessionDoc>('sessions')
    .deleteMany({ expires_at: { $lt: new Date().toISOString() } })
  return result.deletedCount ?? 0
}

export async function getUserSessions(
  _db: unknown,
  userId: string,
): Promise<
  Array<{
    id: string
    ipAddress: string | null
    userAgent: string | null
    createdAt: string
    expiresAt: string
  }>
> {
  const db = await getMongoDb('USERS')
  const rows = await db
    .collection<SessionDoc>('sessions')
    .find({ user_id: userId, expires_at: { $gt: new Date().toISOString() } })
    .sort({ created_at: -1 })
    .toArray()

  return rows.map((r) => ({
    id: r._id,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }))
}
