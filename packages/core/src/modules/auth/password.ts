/**
 * Gbox Platform — Password Hashing Module
 *
 * bcrypt-based password hashing with legacy SHA-256 migration support.
 * Per IRON RULE #1: ALL passwords hashed with bcrypt (NOT SHA-256).
 */

import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

/**
 * Hash a plaintext password using bcrypt.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Supports legacy SHA-256 hashes for migration: if the hash doesn't look
 * like a bcrypt hash, we check it as SHA-256. On match the caller should
 * re-hash with bcrypt and update the database.
 */
export async function verifyPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  // Support legacy SHA-256 hashes (migration path)
  if (!hash.startsWith("$2b$") && !hash.startsWith("$2a$")) {
    const crypto = await import("crypto");
    const sha256 = crypto
      .createHash("sha256")
      .update(plaintext)
      .digest("hex");
    // Use timing-safe comparison to prevent timing attacks on legacy hashes
    const sha256Buf = Buffer.from(sha256, 'hex');
    const hashBuf = Buffer.from(hash, 'hex');
    if (sha256Buf.length === hashBuf.length && crypto.timingSafeEqual(sha256Buf, hashBuf)) {
      return true; // Legacy hash matches — caller should upgrade
    }
    return false;
  }
  return bcrypt.compare(plaintext, hash);
}

/**
 * Check whether a stored hash is a legacy (non-bcrypt) format.
 */
export function isLegacyHash(hash: string): boolean {
  return !hash.startsWith("$2b$") && !hash.startsWith("$2a$");
}

/**
 * Validate password strength requirements.
 *
 * Rules:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one digit
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (password.length < 10)
    errors.push("Password must be at least 10 characters");
  if (!/[A-Z]/.test(password))
    errors.push("Password must contain an uppercase letter");
  if (!/[0-9]/.test(password))
    errors.push("Password must contain a number");
  if (!/[^A-Za-z0-9]/.test(password))
    errors.push("Password must contain a special character");
  return { valid: errors.length === 0, errors };
}
