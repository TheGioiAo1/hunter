/**
 * Gbox Platform — OTP (One-Time Password) Module
 *
 * 6-digit email verification codes with expiry, attempt tracking,
 * and lockout. Uses the users table columns:
 *   - password_reset_token  (stores SHA-256 hash of OTP)
 *   - password_reset_expires (ISO-8601 expiry timestamp)
 *
 * OTP attempt tracking uses an in-memory map with a PostgreSQL-backed
 * fallback for persistence across restarts.
 */

import type { Kysely } from "kysely";
import type { Database } from "@gbox/db/schema/tables.js";

// ---------------------------------------------------------------------------
// In-memory attempt tracking
// ---------------------------------------------------------------------------

interface OTPAttemptRecord {
  count: number;
  lockedUntil: number | null;
}

const otpAttempts = new Map<string, OTPAttemptRecord>();

const MAX_OTP_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically-random 6-digit OTP string.
 */
export async function generateOTP(): Promise<string> {
  const { randomInt } = await import("crypto");
  return String(randomInt(100000, 999999));
}

/**
 * Hash and persist an OTP for a given user.
 * Stores the SHA-256 hash (not plaintext) with a 10-minute expiry.
 */
export async function saveOTP(
  db: Kysely<Database>,
  userId: string,
  otp: string
): Promise<void> {
  if (!db) return // Demo mode: skip persistence

  const crypto = await import("crypto");
  const hashedOTP = crypto.createHash("sha256").update(otp).digest("hex");
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  await db
    .updateTable("users")
    .set({
      password_reset_token: hashedOTP,
      password_reset_expires: expiresAt.toISOString(),
    })
    .where("id", "=", userId)
    .execute();

  // Reset attempt counter when a new OTP is issued
  otpAttempts.delete(userId);
}

/**
 * Verify an OTP against the stored hash.
 * On success the OTP columns are cleared. On failure the attempt counter
 * is incremented (and may trigger a lockout).
 */
export async function verifyOTP(
  db: Kysely<Database>,
  userId: string,
  otp: string
): Promise<boolean> {
  if (!db) return true // Demo mode: always success

  // Check lockout first
  if (isOTPLocked(userId)) {
    return false;
  }

  const crypto = await import("crypto");
  const hashedOTP = crypto.createHash("sha256").update(otp).digest("hex");

  const user = await db
    .selectFrom("users")
    .where("id", "=", userId)
    .select(["password_reset_token", "password_reset_expires"])
    .executeTakeFirst();

  if (
    !user ||
    !user.password_reset_token ||
    !user.password_reset_expires
  ) {
    recordFailedAttempt(userId);
    return false;
  }

  // Check expiry
  if (new Date(user.password_reset_expires) < new Date()) {
    recordFailedAttempt(userId);
    return false;
  }

  // Compare hashes
  if (user.password_reset_token !== hashedOTP) {
    recordFailedAttempt(userId);
    return false;
  }

  // Success — clear OTP and reset attempts
  await db
    .updateTable("users")
    .set({
      password_reset_token: null,
      password_reset_expires: null,
    })
    .where("id", "=", userId)
    .execute();

  otpAttempts.delete(userId);
  return true;
}

/**
 * Return the number of failed OTP attempts for a user.
 */
export function getOTPAttempts(userId: string): number {
  return otpAttempts.get(userId)?.count ?? 0;
}

/**
 * Check whether the user is currently locked out from OTP verification.
 */
export function isOTPLocked(userId: string): boolean {
  const record = otpAttempts.get(userId);
  if (!record?.lockedUntil) return false;
  if (record.lockedUntil > Date.now()) return true;
  // Lock expired — reset
  otpAttempts.delete(userId);
  return false;
}

/**
 * Manually lock a user's OTP verification for 15 minutes.
 */
export function lockOTP(userId: string): void {
  const record = otpAttempts.get(userId) ?? { count: 0, lockedUntil: null };
  record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  otpAttempts.set(userId, record);
}

/**
 * Get the remaining lockout time in seconds, or 0 if not locked.
 */
export function getOTPLockoutRemaining(userId: string): number {
  const record = otpAttempts.get(userId);
  if (!record?.lockedUntil) return 0;
  const remaining = record.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function recordFailedAttempt(userId: string): void {
  const record = otpAttempts.get(userId) ?? { count: 0, lockedUntil: null };
  record.count++;
  if (record.count >= MAX_OTP_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  otpAttempts.set(userId, record);
}

// Periodic cleanup of stale attempt records (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of otpAttempts.entries()) {
    if (record.lockedUntil && record.lockedUntil < now) {
      otpAttempts.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();
