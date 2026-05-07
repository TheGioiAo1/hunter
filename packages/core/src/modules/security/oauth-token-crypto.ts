/**
 * OAuth token encryption-at-rest helpers.
 *
 * Iron rule 1 compliance: OAuth access/refresh tokens are secrets —
 * they authorise third-party API calls on a user's behalf and cannot
 * be stored plaintext. Shopify, Google, Microsoft, and GitHub OAuth
 * programmes all require encrypted storage of issued tokens.
 *
 * Wire format: AES-256-GCM with a per-row 12-byte random IV and the
 * 16-byte GCM auth tag. The encryption key comes from
 * `OAUTH_ENCRYPTION_KEY` (32-byte hex — 64 hex chars). Callers split
 * the three columns across the row so a DB dump on its own leaks
 * nothing useful.
 *
 * Rotation: generate a new key, run `reencryptAll(oldKey, newKey)`
 * with the helper below, swap the env var, restart. There is no
 * in-band key-id because the expected rotation cadence is "once per
 * leak" — not "every sprint".
 *
 * Why a dedicated module instead of a generic `encrypt()` util:
 *   - OAuth rows are the only secrets-at-rest we have on disk today;
 *     a single-purpose helper makes the call sites obvious and the
 *     test surface tight.
 *   - The column triplet (`_ciphertext`, `_iv`, `_tag`) is specific
 *     to this schema; a generic util would either pack them into one
 *     blob (hard to rotate) or force every caller to split manually.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm' as const
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** The three pieces that together form an encrypted token. */
export interface EncryptedToken {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
}

/**
 * Parse a hex-encoded key from `OAUTH_ENCRYPTION_KEY` (or any string).
 * Throws on malformed input so misconfiguration fails loud at startup,
 * not quietly on the first OAuth flow.
 */
export function parseOauthKey(hex: string): Buffer {
  if (typeof hex !== 'string' || hex.length === 0) {
    throw new Error('OAUTH_ENCRYPTION_KEY is empty')
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('OAUTH_ENCRYPTION_KEY must be hex')
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `OAUTH_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    )
  }
  return buf
}

/**
 * Encrypt a plaintext token. Returns the three column values the
 * `oauth_accounts` row needs. `null` plaintext → `null` encrypted
 * (so callers can blindly pass optional fields through).
 */
export function encryptToken(plaintext: string | null, key: Buffer): EncryptedToken | null {
  if (plaintext === null) return null
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes (got ${key.length})`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.length !== TAG_BYTES) {
    // Defensive — Node always returns 16 bytes for GCM, but guard
    // the invariant so a future crypto swap can't silently weaken.
    throw new Error(`unexpected auth tag length: ${tag.length}`)
  }
  return { ciphertext, iv, tag }
}

/**
 * Decrypt a stored token. Returns `null` if the encrypted triplet is
 * `null` (round-trip with `encryptToken(null)`). Throws on auth-tag
 * mismatch — callers should treat that as "row was tampered with,
 * do not use".
 */
export function decryptToken(
  encrypted: EncryptedToken | null,
  key: Buffer,
): string | null {
  if (encrypted === null) return null
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes (got ${key.length})`)
  }
  const { ciphertext, iv, tag } = encrypted
  if (iv.length !== IV_BYTES) throw new Error(`bad iv length: ${iv.length}`)
  if (tag.length !== TAG_BYTES) throw new Error(`bad tag length: ${tag.length}`)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Helper for key rotation — decrypts with `oldKey`, re-encrypts with
 * `newKey`. No I/O; the caller iterates `oauth_accounts` rows and
 * writes the result back.
 */
export function rotateToken(
  encrypted: EncryptedToken | null,
  oldKey: Buffer,
  newKey: Buffer,
): EncryptedToken | null {
  const plaintext = decryptToken(encrypted, oldKey)
  return encryptToken(plaintext, newKey)
}

/**
 * Generate a fresh random key suitable for `OAUTH_ENCRYPTION_KEY`.
 * Used by the ops CLI that bootstraps a new environment.
 */
export function generateOauthKey(): string {
  return randomBytes(KEY_BYTES).toString('hex')
}
