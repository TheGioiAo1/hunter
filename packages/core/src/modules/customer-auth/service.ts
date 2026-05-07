/**
 * Gbox Platform — Customer authentication (Decision #4)
 *
 * Magic-link + 6-digit OTP authentication for storefront customers.
 * Completely separate from merchant `auth` module — uses
 * `customer_otp_codes` + `customer_sessions` tables added in migration
 * 007. The merchant `users` / `sessions` tables are NEVER touched here.
 *
 * Why magic link first?
 *   PRINCIPLES.md P3 — "treat merchant email as a potential typo".
 *   The same logic applies (more strongly) to customers: a buyer who
 *   has to remember a password churns harder than one who clicks a
 *   link in their inbox. Password is supported as a fallback for
 *   migrated stores but never required.
 *
 * Token rules:
 *   - magic_link: 32 random bytes, hex-encoded → 64-char URL token.
 *     Stored as SHA-256 hash; the plaintext only ever lives in the
 *     email body and the user's clipboard.
 *   - otp_6:      6-digit decimal, generated via crypto.randomInt.
 *     Stored as SHA-256 hash. Max 5 attempts before the row is locked.
 *
 * Session cookie:
 *   - 64 random hex chars, SHA-256 hashed at rest.
 *   - 30-day sliding expiry (refreshed on each request).
 *   - HttpOnly, Secure, SameSite=Lax, Path=/.
 *   - Cookie name: `gbox_customer_session`. Distinct from the merchant
 *     cookie name on purpose so a single browser can be logged in as
 *     both a merchant (admin tab) and a customer (storefront tab)
 *     without collision.
 */

import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CUSTOMER_COOKIE_NAME = 'gbox_customer_session'
export const SESSION_TTL_DAYS = 30
export const MAGIC_LINK_TTL_MINUTES = 15
export const OTP_TTL_MINUTES = 10
export const MAX_OTP_ATTEMPTS = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IssueCodeResult {
  /** Plaintext token to embed in the email magic link. Never log this. */
  magicLinkToken: string
  /** Plaintext 6-digit code, for fallback paste flow. Never log this. */
  otpCode: string
  /** Server time when both expire. */
  expiresAt: Date
}

export interface VerifyResult {
  customer_id: string
  shop_id: string
  /** Plaintext session token to set in the cookie. Never log this. */
  sessionToken: string
  /** Cookie expiry to set on Set-Cookie. */
  sessionExpiresAt: Date
  /** True iff the customer row was just created during this verification. */
  newCustomer: boolean
}

export class CustomerAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message)
    this.name = 'CustomerAuthError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex')
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Step 1 — issue a magic-link + OTP for the given shop+email.
// ---------------------------------------------------------------------------

/**
 * Generate a magic-link token + a 6-digit OTP for the given shop+email
 * and persist BOTH in `customer_otp_codes`. Two rows are written so the
 * customer can either click the link OR paste the code, whichever
 * arrives first.
 *
 * NOTE: this function does NOT send the email. Email delivery is the
 * caller's responsibility (typically via the BullMQ email-send queue).
 * This separation lets tests inspect the plaintext tokens without
 * pulling in an SMTP transport.
 */
export async function issueLoginCode(
  db: Kysely<Database>,
  shopId: string,
  emailRaw: string,
  ip?: string,
): Promise<IssueCodeResult> {
  if (!emailRaw || !emailRaw.includes('@')) {
    throw new CustomerAuthError('invalid_email', 'Invalid email address')
  }
  const email = normalizeEmail(emailRaw)

  const magicLinkToken = randomHex(32) // 64-char URL token
  const otpCode = String(crypto.randomInt(100000, 1_000_000)) // 6 digits

  const magicExpires = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60_000)
  const otpExpires = new Date(Date.now() + OTP_TTL_MINUTES * 60_000)

  // Insert both code rows. They are looked up independently so the user
  // can race the email link against the pasted code without invalidating
  // each other.
  await db
    .insertInto('customer_otp_codes')
    .values([
      {
        shop_id: shopId,
        email,
        kind: 'magic_link',
        code_hash: sha256(magicLinkToken),
        expires_at: magicExpires.toISOString(),
        ip_address: ip ?? null,
      },
      {
        shop_id: shopId,
        email,
        kind: 'otp_6',
        code_hash: sha256(otpCode),
        expires_at: otpExpires.toISOString(),
        ip_address: ip ?? null,
      },
    ] as any)
    .execute()

  return {
    magicLinkToken,
    otpCode,
    expiresAt: magicExpires,
  }
}

// ---------------------------------------------------------------------------
// Step 2 — verify a code and create a session.
// ---------------------------------------------------------------------------

/**
 * Internal: claim an unconsumed otp_codes row for the given shop+email+kind.
 * Increments `attempts` on every wrong guess and refuses once attempts
 * reach MAX_OTP_ATTEMPTS. Returns the matching row or throws.
 */
async function claimCodeRow(
  db: Kysely<Database>,
  shopId: string,
  email: string,
  kind: 'magic_link' | 'otp_6',
  plaintextCode: string,
): Promise<{ id: string }> {
  const codeHash = sha256(plaintextCode)
  const now = new Date().toISOString()

  // Look up the most-recent unconsumed code for this shop+email+kind.
  // We ALWAYS fetch by (shop, email, kind) — never by code_hash alone —
  // so attackers can't probe across email accounts.
  const row = await db
    .selectFrom('customer_otp_codes')
    .select(['id', 'code_hash', 'expires_at', 'attempts'])
    .where('shop_id', '=', shopId)
    .where('email', '=', email)
    .where('kind', '=', kind)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .orderBy('created_at', 'desc')
    .executeTakeFirst()

  if (!row) {
    throw new CustomerAuthError(
      'code_not_found',
      'Code expired or never issued. Please request a new one.',
      400,
    )
  }

  if (row.attempts >= MAX_OTP_ATTEMPTS) {
    throw new CustomerAuthError(
      'too_many_attempts',
      'Too many failed attempts. Please request a new code.',
      429,
    )
  }

  if (row.code_hash !== codeHash) {
    // Wrong guess — increment attempts and reject.
    await db
      .updateTable('customer_otp_codes')
      .set({ attempts: (row.attempts ?? 0) + 1 })
      .where('id', '=', row.id)
      .execute()

    throw new CustomerAuthError('invalid_code', 'Incorrect code', 400)
  }

  // Match — mark consumed atomically. If two requests race, only one wins.
  const update = await db
    .updateTable('customer_otp_codes')
    .set({ consumed_at: now })
    .where('id', '=', row.id)
    .where('consumed_at', 'is', null)
    .executeTakeFirst()

  if (Number(update.numUpdatedRows) === 0) {
    throw new CustomerAuthError(
      'code_already_used',
      'This code was already used',
      400,
    )
  }

  return { id: row.id }
}

/**
 * Verify a magic link token (from email URL) and create a customer
 * session. Returns the new session token + customer info.
 */
export async function verifyMagicLink(
  db: Kysely<Database>,
  shopId: string,
  emailRaw: string,
  token: string,
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<VerifyResult> {
  if (!emailRaw || !token) {
    throw new CustomerAuthError('missing_params', 'email and token are required')
  }
  const email = normalizeEmail(emailRaw)
  await claimCodeRow(db, shopId, email, 'magic_link', token)
  return finalizeLogin(db, shopId, email, ctx)
}

/**
 * Verify a 6-digit OTP and create a customer session.
 */
export async function verifyOtpCode(
  db: Kysely<Database>,
  shopId: string,
  emailRaw: string,
  code: string,
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<VerifyResult> {
  if (!emailRaw || !code) {
    throw new CustomerAuthError('missing_params', 'email and code are required')
  }
  const email = normalizeEmail(emailRaw)
  await claimCodeRow(db, shopId, email, 'otp_6', code)
  return finalizeLogin(db, shopId, email, ctx)
}

// ---------------------------------------------------------------------------
// Common finalization: upsert customer + create session.
// ---------------------------------------------------------------------------

async function finalizeLogin(
  db: Kysely<Database>,
  shopId: string,
  email: string,
  ctx: { ip?: string; userAgent?: string },
): Promise<VerifyResult> {
  const now = new Date()
  const nowIso = now.toISOString()

  // Upsert customer row (find or create + bump last_login_at).
  const existing = await db
    .selectFrom('customers')
    .select(['id'])
    .where('shop_id', '=', shopId)
    .where('email', '=', email)
    .executeTakeFirst()

  let customerId: string
  let newCustomer = false

  if (existing) {
    customerId = existing.id
    await db
      .updateTable('customers')
      .set({
        last_login_at: nowIso,
        email_verified_at: nowIso,
        verified_email: true,
      })
      .where('id', '=', customerId)
      .execute()
  } else {
    const created = await db
      .insertInto('customers')
      .values({
        shop_id: shopId,
        email,
        verified_email: true,
        email_verified_at: nowIso,
        last_login_at: nowIso,
      } as any)
      .returning('id')
      .executeTakeFirstOrThrow()
    customerId = created.id
    newCustomer = true
  }

  // Mint a fresh session.
  const sessionToken = randomHex(32) // 64-char hex
  const sessionExpires = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000)
  await db
    .insertInto('customer_sessions')
    .values({
      customer_id: customerId,
      shop_id: shopId,
      token_hash: sha256(sessionToken),
      expires_at: sessionExpires.toISOString(),
      ip_address: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
    } as any)
    .execute()

  return {
    customer_id: customerId,
    shop_id: shopId,
    sessionToken,
    sessionExpiresAt: sessionExpires,
    newCustomer,
  }
}

// ---------------------------------------------------------------------------
// Session lookup + revoke
// ---------------------------------------------------------------------------

export interface CustomerSessionInfo {
  customer_id: string
  shop_id: string
  expires_at: Date
}

/**
 * Look up an active session by its plaintext token. Returns null on
 * miss/expiry. Updates `last_used_at` so dashboards can show "active
 * sessions". Does NOT extend the expires_at — sessions are fixed-window
 * by default to keep revocation simple.
 */
export async function getSessionByToken(
  db: Kysely<Database>,
  token: string,
): Promise<CustomerSessionInfo | null> {
  if (!token || token.length < 32) return null
  const tokenHash = sha256(token)
  const now = new Date().toISOString()

  const row = await db
    .selectFrom('customer_sessions')
    .select(['customer_id', 'shop_id', 'expires_at'])
    .where('token_hash', '=', tokenHash)
    .where('expires_at', '>', now)
    .executeTakeFirst()

  if (!row) return null

  // Best-effort: bump last_used_at without blocking the request path.
  void db
    .updateTable('customer_sessions')
    .set({ last_used_at: now } as any)
    .where('token_hash', '=', tokenHash)
    .execute()
    .catch(() => undefined)

  return {
    customer_id: row.customer_id,
    shop_id: row.shop_id,
    expires_at: new Date(row.expires_at as any),
  }
}

/**
 * Revoke (logout) a single session by its plaintext token.
 */
export async function revokeSession(
  db: Kysely<Database>,
  token: string,
): Promise<void> {
  if (!token) return
  await db
    .deleteFrom('customer_sessions')
    .where('token_hash', '=', sha256(token))
    .execute()
}

/**
 * Revoke EVERY session for a customer. Used by the merchant dashboard
 * "log this customer out everywhere" action and by password change.
 */
export async function revokeAllSessions(
  db: Kysely<Database>,
  customerId: string,
): Promise<number> {
  const result = await db
    .deleteFrom('customer_sessions')
    .where('customer_id', '=', customerId)
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}
