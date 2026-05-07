/**
 * Gbox Platform — OTP (One-Time Password) Module (Mongo edition)
 *
 * 6-digit email verification codes with expiry, attempt tracking, and
 * lockout. Uses `Gbox-Users.users`:
 *   - password_reset_token  (SHA-256 hash of OTP)
 *   - password_reset_expires (ISO-8601 expiry)
 *
 * Attempt tracking remains in-memory; lockout is per-process.
 */

import { getMongoDb } from '../db/mongo.js'
import type { UserDoc } from '../db/types.js'

interface OTPAttemptRecord {
  count: number
  lockedUntil: number | null
}

const otpAttempts = new Map<string, OTPAttemptRecord>()

const MAX_OTP_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000
const OTP_EXPIRY_MS = 10 * 60 * 1000

export async function generateOTP(): Promise<string> {
  const { randomInt } = await import('crypto')
  return String(randomInt(100000, 999999))
}

export async function saveOTP(
  _db: unknown,
  userId: string,
  otp: string,
): Promise<void> {
  const db = await getMongoDb('USERS')
  const crypto = await import('crypto')
  const hashedOTP = crypto.createHash('sha256').update(otp).digest('hex')
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS).toISOString()

  await db.collection<UserDoc>('users').updateOne(
    { _id: userId },
    {
      $set: {
        password_reset_token: hashedOTP,
        password_reset_expires: expiresAt,
        updated_at: new Date().toISOString(),
      },
    },
  )

  otpAttempts.delete(userId)
}

export async function verifyOTP(
  _db: unknown,
  userId: string,
  otp: string,
): Promise<boolean> {
  if (isOTPLocked(userId)) return false

  const db = await getMongoDb('USERS')
  const crypto = await import('crypto')
  const hashedOTP = crypto.createHash('sha256').update(otp).digest('hex')

  const user = await db
    .collection<UserDoc>('users')
    .findOne(
      { _id: userId },
      { projection: { password_reset_token: 1, password_reset_expires: 1 } },
    )

  if (!user || !user.password_reset_token || !user.password_reset_expires) {
    recordFailedAttempt(userId)
    return false
  }

  if (new Date(user.password_reset_expires) < new Date()) {
    recordFailedAttempt(userId)
    return false
  }

  if (user.password_reset_token !== hashedOTP) {
    recordFailedAttempt(userId)
    return false
  }

  await db.collection<UserDoc>('users').updateOne(
    { _id: userId },
    {
      $set: {
        password_reset_token: null,
        password_reset_expires: null,
        updated_at: new Date().toISOString(),
      },
    },
  )

  otpAttempts.delete(userId)
  return true
}

export function getOTPAttempts(userId: string): number {
  return otpAttempts.get(userId)?.count ?? 0
}

export function isOTPLocked(userId: string): boolean {
  const record = otpAttempts.get(userId)
  if (!record?.lockedUntil) return false
  if (record.lockedUntil > Date.now()) return true
  otpAttempts.delete(userId)
  return false
}

export function lockOTP(userId: string): void {
  const record = otpAttempts.get(userId) ?? { count: 0, lockedUntil: null }
  record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS
  otpAttempts.set(userId, record)
}

export function getOTPLockoutRemaining(userId: string): number {
  const record = otpAttempts.get(userId)
  if (!record?.lockedUntil) return 0
  const remaining = record.lockedUntil - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

function recordFailedAttempt(userId: string): void {
  const record = otpAttempts.get(userId) ?? { count: 0, lockedUntil: null }
  record.count++
  if (record.count >= MAX_OTP_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS
  }
  otpAttempts.set(userId, record)
}

setInterval(() => {
  const now = Date.now()
  for (const [key, record] of otpAttempts.entries()) {
    if (record.lockedUntil && record.lockedUntil < now) {
      otpAttempts.delete(key)
    }
  }
}, 5 * 60 * 1000).unref()
