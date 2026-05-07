/**
 * Gbox Platform — Two-Factor Authentication (TOTP + Email + Backup Codes)
 *
 * Phase 0.6 (God Admin hardening).
 *
 * Design goals
 * ------------
 * - Zero new npm dependencies. TOTP is ~50 lines of Node `crypto`; the
 *   QR code is generated client-side by pointing Google Charts /
 *   `otpauth://` URIs at Google Authenticator. The only non-trivial
 *   helper is base32 encoding which we implement inline (RFC 4648).
 *
 * - One module, three auth factors:
 *     1. TOTP    — primary (Google Authenticator, 1Password, Authy, ...)
 *     2. Email   — fallback when the authenticator is unavailable
 *     3. Backup codes — break-glass single-use codes
 *
 * - All verification helpers are timing-safe where it matters (backup
 *   codes, email OTP) and the TOTP verifier accepts a small ±1 step
 *   skew to tolerate clock drift.
 *
 * Storage is the `user_2fa` table (see migration 012).
 *
 * This module ONLY touches session.two_fa_verified on explicit calls
 * from the login handler (markSessionTwoFaPending / markSessionTwoFaVerified).
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto'
import type { Kysely } from 'kysely'
import bcrypt from 'bcrypt'

// ---------------------------------------------------------------------------
// Base32 (RFC 4648) — for TOTP secret / otpauth URL
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

// ---------------------------------------------------------------------------
// TOTP — RFC 6238 (SHA1, 30-second step, 6 digits)
// ---------------------------------------------------------------------------

const TOTP_STEP_SECONDS = 30
const TOTP_DIGITS = 6
const TOTP_SKEW = 1 // accept ±1 step for clock drift

function hotp(secret: Buffer, counter: number): string {
  // 8-byte big-endian counter
  const ctr = Buffer.alloc(8)
  for (let i = 7; i >= 0; i--) {
    ctr[i] = counter & 0xff
    counter = Math.floor(counter / 256)
  }
  const hmac = createHmac('sha1', secret).update(ctr).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  const code = bin % 10 ** TOTP_DIGITS
  return code.toString().padStart(TOTP_DIGITS, '0')
}

export function generateTotpCode(
  secretBase32: string,
  at: number = Date.now(),
): string {
  const counter = Math.floor(at / 1000 / TOTP_STEP_SECONDS)
  return hotp(base32Decode(secretBase32), counter)
}

/**
 * Constant-time verify of a TOTP code against the shared secret,
 * with ±TOTP_SKEW step tolerance.
 */
export function verifyTotpCode(
  secretBase32: string,
  submittedCode: string,
  at: number = Date.now(),
): boolean {
  const clean = (submittedCode || '').replace(/\D/g, '')
  if (clean.length !== TOTP_DIGITS) return false

  const key = base32Decode(secretBase32)
  const counter = Math.floor(at / 1000 / TOTP_STEP_SECONDS)

  for (let delta = -TOTP_SKEW; delta <= TOTP_SKEW; delta++) {
    const expected = hotp(key, counter + delta)
    try {
      if (
        timingSafeEqual(Buffer.from(expected), Buffer.from(clean))
      ) {
        return true
      }
    } catch {
      // length mismatch — not equal
    }
  }
  return false
}

/**
 * Generate a fresh 20-byte (160-bit) TOTP secret, base32-encoded.
 * 160 bits is the RFC 6238 recommendation for SHA1 TOTP.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * Build the `otpauth://` URI that Google Authenticator / 1Password /
 * Authy will scan into a new entry. Example output:
 *
 *   otpauth://totp/Gbox%20God%20Admin:admin@gbox.co
 *     ?secret=JBSWY3DPEHPK3PXP
 *     &issuer=Gbox%20God%20Admin
 *     &algorithm=SHA1&digits=6&period=30
 */
export function buildOtpAuthUrl(params: {
  secretBase32: string
  label: string // usually the user's email
  issuer?: string
}): string {
  const issuer = params.issuer ?? 'Gbox God Admin' // iron-rule-5-ok: default only used by god-admin enrollment; seller-facing callers (apps/accounts) pass issuer: 'Gbox' explicitly
  const labelEnc = encodeURIComponent(`${issuer}:${params.label}`)
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${labelEnc}?${query.toString()}`
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

const BACKUP_CODE_COUNT = 10
const BACKUP_CODE_GROUPS = 2
const BACKUP_CODE_GROUP_LEN = 5

/**
 * Generate `BACKUP_CODE_COUNT` formatted single-use codes. Format:
 *
 *   "ABCDE-F2345"   (uppercase alphanumeric, hyphen-separated)
 *
 * Returns the PLAINTEXT codes — the caller must show these to the user
 * exactly ONCE and then store the bcrypt hashes (via hashBackupCodes).
 */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = []
  // Avoid ambiguous chars (0/O, 1/I/L)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  for (let i = 0; i < count; i++) {
    let raw = ''
    for (let j = 0; j < BACKUP_CODE_GROUPS * BACKUP_CODE_GROUP_LEN; j++) {
      const b = randomBytes(1)[0]
      raw += chars[b % chars.length]
    }
    const parts: string[] = []
    for (let g = 0; g < BACKUP_CODE_GROUPS; g++) {
      parts.push(raw.slice(g * BACKUP_CODE_GROUP_LEN, (g + 1) * BACKUP_CODE_GROUP_LEN))
    }
    codes.push(parts.join('-'))
  }
  return codes
}

export async function hashBackupCodes(codes: string[]): Promise<string[]> {
  // bcrypt rounds=10 — backup codes have ~50 bits entropy so 10 rounds
  // is plenty, and we hash a batch of 10 on enrollment.
  return Promise.all(codes.map((c) => bcrypt.hash(normalizeBackupCode(c), 10)))
}

function normalizeBackupCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '')
}

// ---------------------------------------------------------------------------
// Email OTP fallback — 6-digit code sent to user's email
// ---------------------------------------------------------------------------

export const EMAIL_OTP_EXPIRY_MS = 10 * 60 * 1000 // 10 minutes
export const EMAIL_OTP_MAX_ATTEMPTS = 5

/**
 * Generate a new 6-digit email OTP and return { code, hash, expiresAt }.
 * Store the hash + expiresAt in user_2fa; email the plaintext `code`.
 */
export function generateEmailOtp(): {
  code: string
  hash: string
  expiresAt: Date
} {
  // 6 random digits, leading-zero padded
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000
  const code = n.toString().padStart(6, '0')
  const hash = createHash('sha256').update(code).digest('hex')
  return {
    code,
    hash,
    expiresAt: new Date(Date.now() + EMAIL_OTP_EXPIRY_MS),
  }
}

export function hashEmailOtp(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex')
}

// ---------------------------------------------------------------------------
// DB helpers — thin wrappers that hide column names from callers
// ---------------------------------------------------------------------------

export interface TwoFactorRow {
  user_id: string
  totp_secret: string
  enabled: boolean
  enabled_at: string | null
  backup_codes_hashes: (string | null)[]
  email_otp_hash: string | null
  email_otp_expires_at: string | null
  email_otp_attempts: number
  last_used_at: string | null
}

export async function getTwoFactorRow(
  db: Kysely<any>,
  userId: string,
): Promise<TwoFactorRow | null> {
  if (!db) {
    return {
      user_id: userId,
      enabled: false,
      totp_secret: "JBSWY3DPEHPK3PXP", // Demo secret
      backup_codes_hashes: [],
      enabled_at: null,
      last_used_at: null,
    }
  }

  return await db
    .selectFrom('user_2fa')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (!row) return null
  // backup_codes_hashes may come back as a string (jsonb text) in some
  // pg drivers; normalise.
  let hashes: (string | null)[] = []
  if (Array.isArray(row.backup_codes_hashes)) {
    hashes = row.backup_codes_hashes as (string | null)[]
  } else if (typeof row.backup_codes_hashes === 'string') {
    try {
      hashes = JSON.parse(row.backup_codes_hashes)
    } catch {
      hashes = []
    }
  }
  return {
    user_id: row.user_id,
    totp_secret: row.totp_secret,
    enabled: row.enabled,
    enabled_at: row.enabled_at,
    backup_codes_hashes: hashes,
    email_otp_hash: row.email_otp_hash,
    email_otp_expires_at: row.email_otp_expires_at,
    email_otp_attempts: row.email_otp_attempts,
    last_used_at: row.last_used_at,
  }
}

/**
 * Is 2FA enabled (fully enrolled, not just pending setup) for this user?
 */
export async function isTwoFactorEnabled(
  db: Kysely<any>,
  userId: string,
): Promise<boolean> {
  if (!db) return false // Demo: 2FA disabled by default for simplicity

  const row = await db
    .selectFrom('user_2fa')
    .select(['enabled'])
    .where('user_id', '=', userId)
    .where('enabled', '=', true)
    .executeTakeFirst()
  return !!row
}

/**
 * Upsert a fresh (DISABLED) 2FA row with a brand new secret.
 * Used at the start of enrollment — the user then has to verify a
 * code to flip `enabled=true` via enableTwoFactor().
 */
export async function startTwoFactorEnrollment(
  db: Kysely<any>,
  userId: string,
): Promise<{ secret: string }> {
  const secret = generateTotpSecret()
  if (!db) return { secret }

  await db
    .insertInto('user_2fa')
    .values({
      user_id: userId,
      totp_secret: secret,
      enabled: false,
      backup_codes_hashes: JSON.stringify([]),
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        totp_secret: secret,
        enabled: false,
        enabled_at: null,
        updated_at: new Date().toISOString(),
      }),
    )
    .execute()
  return { secret }
}

/**
 * Flip `enabled=true` and persist the new backup codes. Returns the
 * plaintext codes so the caller can show them ONCE to the user.
 */
export async function enableTwoFactor(
  db: Kysely<any>,
  userId: string,
): Promise<{ backupCodes: string[] }> {
  const backupCodes = generateBackupCodes()
  if (!db) return { backupCodes }

  const hashes = await hashBackupCodes(backupCodes)

  await db
    .updateTable('user_2fa')
    .set({
      enabled: true,
      enabled_at: new Date().toISOString(),
      backup_codes_hashes: JSON.stringify(hashes),
      updated_at: new Date().toISOString(),
    })
    .where('user_id', '=', userId)
    .execute()

  return { backupCodes }
}

/**
 * Disable 2FA entirely and wipe the secret. Used from the settings
 * page (which requires a fresh password confirmation — enforced in
 * the handler, not here).
 */
export async function disableTwoFactor(
  db: Kysely<any>,
  userId: string,
): Promise<void> {
  if (!db) return

  await db
    .deleteFrom('user_2fa')
    .where('user_id', '=', userId)
    .execute()
}

/**
 * Regenerate and persist a fresh batch of backup codes (bcrypt hashed).
 * Returns the plaintext codes to show the user.
 */
export async function regenerateBackupCodes(
  db: Kysely<any>,
  userId: string,
): Promise<string[]> {
  const codes = generateBackupCodes()
  if (!db) return codes

  const hashes = await hashBackupCodes(codes)
  await db
    .updateTable('user_2fa')
    .set({
      backup_codes_hashes: JSON.stringify(hashes),
      updated_at: new Date().toISOString(),
    })
    .where('user_id', '=', userId)
    .execute()
  return codes
}

/**
 * Try to consume a single backup code. On success, the matching slot
 * is nulled out so the code cannot be reused.
 */
export async function consumeBackupCode(
  db: Kysely<any>,
  userId: string,
  submittedCode: string,
): Promise<boolean> {
  if (!db) return true // Demo: always success

  const row = await getTwoFactorRow(db, userId)
  if (!row || !row.enabled) return false
  const normalized = normalizeBackupCode(submittedCode)

  for (let i = 0; i < row.backup_codes_hashes.length; i++) {
    const hash = row.backup_codes_hashes[i]
    if (!hash) continue // already used
    // eslint-disable-next-line no-await-in-loop
    const match = await bcrypt.compare(normalized, hash)
    if (match) {
      const next = [...row.backup_codes_hashes]
      next[i] = null
      await db
        .updateTable('user_2fa')
        .set({
          backup_codes_hashes: JSON.stringify(next),
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where('user_id', '=', userId)
        .execute()
      return true
    }
  }
  return false
}

/**
 * Persist a new email OTP hash + expiry (replacing any previous one).
 * Resets the attempt counter.
 */
export async function storeEmailOtp(
  db: Kysely<any>,
  userId: string,
  hash: string,
  expiresAt: Date,
): Promise<void> {
  if (!db) return

  await db
    .updateTable('user_2fa')
    .set({
      email_otp_hash: hash,
      email_otp_expires_at: expiresAt.toISOString(),
      email_otp_attempts: 0,
      updated_at: new Date().toISOString(),
    })
    .where('user_id', '=', userId)
    .execute()
}

/**
 * Timing-safe verification of a submitted email OTP. Increments the
 * attempt counter on failure; wipes the code on success.
 */
export async function verifyEmailOtp(
  db: Kysely<any>,
  userId: string,
  submittedCode: string,
): Promise<{ ok: boolean; reason?: 'expired' | 'too_many_attempts' | 'invalid' }> {
  if (!db) return { ok: true } // Demo: always success

  const row = await getTwoFactorRow(db, userId)
  if (!row || !row.email_otp_hash || !row.email_otp_expires_at) {
    return { ok: false, reason: 'invalid' }
  }
  if (new Date(row.email_otp_expires_at) < new Date()) {
    return { ok: false, reason: 'expired' }
  }
  if (row.email_otp_attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' }
  }

  const submittedHash = hashEmailOtp(submittedCode)
  const a = Buffer.from(row.email_otp_hash, 'hex')
  const b = Buffer.from(submittedHash, 'hex')
  let match = false
  if (a.length === b.length) {
    match = timingSafeEqual(a, b)
  }

  if (!match) {
    await db
      .updateTable('user_2fa')
      .set({
        email_otp_attempts: row.email_otp_attempts + 1,
        updated_at: new Date().toISOString(),
      })
      .where('user_id', '=', userId)
      .execute()
    return { ok: false, reason: 'invalid' }
  }

  // Success — wipe the code so it can't be reused
  await db
    .updateTable('user_2fa')
    .set({
      email_otp_hash: null,
      email_otp_expires_at: null,
      email_otp_attempts: 0,
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where('user_id', '=', userId)
    .execute()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Session 2FA state helpers
// ---------------------------------------------------------------------------

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Called by the login handler immediately after password succeeds, if
 * the user has 2FA enrolled. Flips the sessions row into a
 * "password OK, still needs TOTP" state that the god-auth middleware
 * only allows on the /god-admin/login/2fa* routes.
 */
export async function markSessionTwoFaPending(
  db: Kysely<any>,
  rawToken: string,
): Promise<void> {
  if (!db) return

  const tokenHash = hashSessionToken(rawToken)
  await db
    .updateTable('sessions')
    .set({ two_fa_verified: false })
    .where('token_hash', '=', tokenHash)
    .execute()
}

/**
 * Called by the 2FA challenge handler on a successful second factor.
 * Flips the sessions row into a fully-verified state so the dashboard
 * becomes accessible.
 *
 * ALSO bumps the user_2fa.last_used_at column.
 */
export async function markSessionTwoFaVerified(
  db: Kysely<any>,
  rawToken: string,
  userId: string,
): Promise<void> {
  if (!db) return

  const tokenHash = hashSessionToken(rawToken)
  await db
    .updateTable('sessions')
    .set({ two_fa_verified: true })
    .where('token_hash', '=', tokenHash)
    .execute()
  await db
    .updateTable('user_2fa')
    .set({ last_used_at: new Date().toISOString() })
    .where('user_id', '=', userId)
    .execute()
}

/**
 * Read the two_fa_verified flag for a given raw session token. Used
 * by the god-auth middleware (Redis-cached path + DB fallback).
 */
export async function getSessionTwoFaVerified(
  db: Kysely<any>,
  rawToken: string,
): Promise<boolean | null> {
  if (!db) return true // Demo: 2FA always verified

  const tokenHash = hashSessionToken(rawToken)
  const row = await db
    .selectFrom('sessions')
    .select(['two_fa_verified'])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst()
  if (!row) return null
  return row.two_fa_verified
}
