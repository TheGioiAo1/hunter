/**
 * Gbox Platform — Two-Factor Authentication (TOTP + Email + Backup Codes)
 *
 * Mongo edition. Storage: `Gbox-Users.user_2fa` (one doc per user; `_id`
 * == user_id). Session 2FA flag lives on `Gbox-Users.sessions.two_fa_verified`.
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto'
import bcrypt from 'bcrypt'
import { getMongoDb } from '../db/mongo.js'
import type { TwoFactorDoc } from '../db/types.js'

// ---------------------------------------------------------------------------
// Base32 (RFC 4648)
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
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
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
// TOTP — RFC 6238
// ---------------------------------------------------------------------------

const TOTP_STEP_SECONDS = 30
const TOTP_DIGITS = 6
const TOTP_SKEW = 1

function hotp(secret: Buffer, counter: number): string {
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
  return (bin % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0')
}

export function generateTotpCode(secretBase32: string, at: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(at / 1000 / TOTP_STEP_SECONDS))
}

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
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true
    } catch {
      // length mismatch — not equal
    }
  }
  return false
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function buildOtpAuthUrl(params: {
  secretBase32: string
  label: string
  issuer?: string
}): string {
  const issuer = params.issuer ?? 'Gbox God Admin'
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

export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = []
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
  return Promise.all(codes.map((c) => bcrypt.hash(normalizeBackupCode(c), 10)))
}

function normalizeBackupCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '')
}

// ---------------------------------------------------------------------------
// Email OTP fallback
// ---------------------------------------------------------------------------

export const EMAIL_OTP_EXPIRY_MS = 10 * 60 * 1000
export const EMAIL_OTP_MAX_ATTEMPTS = 5

export function generateEmailOtp(): { code: string; hash: string; expiresAt: Date } {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000
  const code = n.toString().padStart(6, '0')
  const hash = createHash('sha256').update(code).digest('hex')
  return { code, hash, expiresAt: new Date(Date.now() + EMAIL_OTP_EXPIRY_MS) }
}

export function hashEmailOtp(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex')
}

// ---------------------------------------------------------------------------
// DB helpers
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

function rowFromDoc(doc: TwoFactorDoc): TwoFactorRow {
  return {
    user_id: doc.user_id,
    totp_secret: doc.totp_secret,
    enabled: doc.enabled,
    enabled_at: doc.enabled_at,
    backup_codes_hashes: doc.backup_codes_hashes ?? [],
    email_otp_hash: doc.email_otp_hash ?? null,
    email_otp_expires_at: doc.email_otp_expires_at ?? null,
    email_otp_attempts: doc.email_otp_attempts ?? 0,
    last_used_at: doc.last_used_at,
  }
}

export async function getTwoFactorRow(
  _db: unknown,
  userId: string,
): Promise<TwoFactorRow | null> {
  const db = await getMongoDb('USERS')
  const doc = await db
    .collection<TwoFactorDoc>('user_2fa')
    .findOne({ _id: userId })
  return doc ? rowFromDoc(doc) : null
}

export async function isTwoFactorEnabled(
  _db: unknown,
  userId: string,
): Promise<boolean> {
  const db = await getMongoDb('USERS')
  const doc = await db
    .collection<TwoFactorDoc>('user_2fa')
    .findOne({ _id: userId, enabled: true }, { projection: { _id: 1 } })
  return !!doc
}

export async function startTwoFactorEnrollment(
  _db: unknown,
  userId: string,
): Promise<{ secret: string }> {
  const db = await getMongoDb('USERS')
  const secret = generateTotpSecret()
  const now = new Date().toISOString()
  await db.collection<TwoFactorDoc>('user_2fa').updateOne(
    { _id: userId },
    {
      $set: {
        totp_secret: secret,
        enabled: false,
        enabled_at: null,
        updated_at: now,
      },
      $setOnInsert: {
        user_id: userId,
        backup_codes_hashes: [],
        email_otp_hash: null,
        email_otp_expires_at: null,
        email_otp_attempts: 0,
        last_used_at: null,
      },
    },
    { upsert: true },
  )
  return { secret }
}

export async function enableTwoFactor(
  _db: unknown,
  userId: string,
): Promise<{ backupCodes: string[] }> {
  const db = await getMongoDb('USERS')
  const backupCodes = generateBackupCodes()
  const hashes = await hashBackupCodes(backupCodes)
  const now = new Date().toISOString()

  await db.collection<TwoFactorDoc>('user_2fa').updateOne(
    { _id: userId },
    {
      $set: {
        enabled: true,
        enabled_at: now,
        backup_codes_hashes: hashes,
        updated_at: now,
      },
    },
  )
  return { backupCodes }
}

export async function disableTwoFactor(_db: unknown, userId: string): Promise<void> {
  const db = await getMongoDb('USERS')
  await db.collection<TwoFactorDoc>('user_2fa').deleteOne({ _id: userId })
}

export async function regenerateBackupCodes(
  _db: unknown,
  userId: string,
): Promise<string[]> {
  const db = await getMongoDb('USERS')
  const codes = generateBackupCodes()
  const hashes = await hashBackupCodes(codes)
  await db.collection<TwoFactorDoc>('user_2fa').updateOne(
    { _id: userId },
    {
      $set: {
        backup_codes_hashes: hashes,
        updated_at: new Date().toISOString(),
      },
    },
  )
  return codes
}

export async function consumeBackupCode(
  _db: unknown,
  userId: string,
  submittedCode: string,
): Promise<boolean> {
  const db = await getMongoDb('USERS')
  const row = await getTwoFactorRow(_db, userId)
  if (!row || !row.enabled) return false
  const normalized = normalizeBackupCode(submittedCode)

  for (let i = 0; i < row.backup_codes_hashes.length; i++) {
    const hash = row.backup_codes_hashes[i]
    if (!hash) continue
    // eslint-disable-next-line no-await-in-loop
    const match = await bcrypt.compare(normalized, hash)
    if (match) {
      const next = [...row.backup_codes_hashes]
      next[i] = null
      const now = new Date().toISOString()
      await db.collection<TwoFactorDoc>('user_2fa').updateOne(
        { _id: userId },
        {
          $set: {
            backup_codes_hashes: next,
            last_used_at: now,
            updated_at: now,
          },
        },
      )
      return true
    }
  }
  return false
}

export async function storeEmailOtp(
  _db: unknown,
  userId: string,
  hash: string,
  expiresAt: Date,
): Promise<void> {
  const db = await getMongoDb('USERS')
  await db.collection<TwoFactorDoc>('user_2fa').updateOne(
    { _id: userId },
    {
      $set: {
        email_otp_hash: hash,
        email_otp_expires_at: expiresAt.toISOString(),
        email_otp_attempts: 0,
        updated_at: new Date().toISOString(),
      },
    },
  )
}

export async function verifyEmailOtp(
  _db: unknown,
  userId: string,
  submittedCode: string,
): Promise<{ ok: boolean; reason?: 'expired' | 'too_many_attempts' | 'invalid' }> {
  const db = await getMongoDb('USERS')
  const row = await getTwoFactorRow(_db, userId)
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
  if (a.length === b.length) match = timingSafeEqual(a, b)

  if (!match) {
    await db.collection<TwoFactorDoc>('user_2fa').updateOne(
      { _id: userId },
      {
        $set: {
          email_otp_attempts: row.email_otp_attempts + 1,
          updated_at: new Date().toISOString(),
        },
      },
    )
    return { ok: false, reason: 'invalid' }
  }

  const now = new Date().toISOString()
  await db.collection<TwoFactorDoc>('user_2fa').updateOne(
    { _id: userId },
    {
      $set: {
        email_otp_hash: null,
        email_otp_expires_at: null,
        email_otp_attempts: 0,
        last_used_at: now,
        updated_at: now,
      },
    },
  )
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Session 2FA state helpers
// ---------------------------------------------------------------------------

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function markSessionTwoFaPending(
  _db: unknown,
  rawToken: string,
): Promise<void> {
  const db = await getMongoDb('USERS')
  await db
    .collection('sessions')
    .updateOne(
      { token_hash: hashSessionToken(rawToken) },
      { $set: { two_fa_verified: false } },
    )
}

export async function markSessionTwoFaVerified(
  _db: unknown,
  rawToken: string,
  userId: string,
): Promise<void> {
  const db = await getMongoDb('USERS')
  await db
    .collection('sessions')
    .updateOne(
      { token_hash: hashSessionToken(rawToken) },
      { $set: { two_fa_verified: true } },
    )
  await db
    .collection<TwoFactorDoc>('user_2fa')
    .updateOne(
      { _id: userId },
      { $set: { last_used_at: new Date().toISOString() } },
    )
}

export async function getSessionTwoFaVerified(
  _db: unknown,
  rawToken: string,
): Promise<boolean | null> {
  const db = await getMongoDb('USERS')
  const row = await db
    .collection('sessions')
    .findOne(
      { token_hash: hashSessionToken(rawToken) },
      { projection: { two_fa_verified: 1 } },
    )
  if (!row) return null
  return row.two_fa_verified ?? true
}
