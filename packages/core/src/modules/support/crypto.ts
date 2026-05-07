/**
 * Gbox Platform — Support Message Encryption at Rest
 *
 * Iron rule 1 compliance: seller ↔ support chat messages often contain
 * PII, account identifiers, payment details, order IDs — anything a
 * seller types into the help widget. Storing message body plaintext in
 * Postgres would mean a single DB dump leaks everyone's conversations.
 *
 * Wire format: AES-256-GCM with a per-row 12-byte random IV and the
 * 16-byte GCM auth tag. Identical shape to `oauth-token-crypto.ts` from
 * Phase 11 PR3 so ops + code review share one mental model.
 *
 *   support_messages.body_ciphertext   BYTEA  (1..N bytes)
 *   support_messages.body_iv           BYTEA  (12 bytes)
 *   support_messages.body_tag          BYTEA  (16 bytes)
 *   support_messages.body_key_version  SMALLINT (starts at 1)
 *
 * Key lives in `SUPPORT_MESSAGE_ENCRYPTION_KEY` env var, 32-byte hex.
 *
 * Rotation strategy: new env var value + bump
 * `SUPPORT_MESSAGE_KEY_CURRENT_VERSION`, keep the old key under
 * `SUPPORT_MESSAGE_ENCRYPTION_KEY_V1` so decrypt-on-read still works
 * while `scripts/ops/reencrypt-support.ts` runs. Once every row is on
 * the new version, retire the old env var.
 *
 * Why a dedicated module instead of reusing `oauth-token-crypto.ts`:
 *   - Different env var name → clearer blast radius
 *     (leaking oauth key doesn't leak chat, and vice versa)
 *   - Different test fixtures + error taxonomy
 *   - Row-level rotation with versioning (oauth rotates on leak only;
 *     support rotates quarterly on schedule)
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm' as const
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

export const SUPPORT_MESSAGE_KEY_ENV = 'SUPPORT_MESSAGE_ENCRYPTION_KEY'

/** The three pieces that together form an encrypted message body. */
export interface EncryptedMessage {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  keyVersion: number
}

/**
 * Parse a hex-encoded key into raw bytes. Throws loud on malformed
 * input so misconfiguration fails at app startup, not on the first
 * message send.
 */
export function parseMessageKey(hex: string): Buffer {
  if (typeof hex !== 'string' || hex.length === 0) {
    throw new Error(`${SUPPORT_MESSAGE_KEY_ENV} is empty`)
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`${SUPPORT_MESSAGE_KEY_ENV} must be hex`)
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `${SUPPORT_MESSAGE_KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    )
  }
  return buf
}

/**
 * Encrypt a plaintext message body. `null` plaintext is rejected
 * (unlike oauth tokens where null is a valid "no refresh token"
 * state) — a message with no body is a bug, not a valid state.
 */
export function encryptMessage(
  plaintext: string,
  key: Buffer,
  keyVersion = 1,
): EncryptedMessage {
  if (typeof plaintext !== 'string') {
    throw new Error('plaintext must be a string')
  }
  if (plaintext.length === 0) {
    throw new Error('plaintext is empty')
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes (got ${key.length})`)
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 32767) {
    throw new Error(`keyVersion must be a SMALLINT (1..32767), got ${keyVersion}`)
  }

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  if (tag.length !== TAG_BYTES) {
    throw new Error(`unexpected auth tag length: ${tag.length}`)
  }
  return { ciphertext, iv, tag, keyVersion }
}

/**
 * Decrypt a stored message body. Throws on auth-tag mismatch —
 * callers should treat that as "row was tampered with, do not use".
 * The ticket detail view should render a "[message unavailable]"
 * placeholder rather than expose the raw error to a seller.
 */
export function decryptMessage(
  encrypted: Omit<EncryptedMessage, 'keyVersion'>,
  key: Buffer,
): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`key must be ${KEY_BYTES} bytes (got ${key.length})`)
  }
  const { ciphertext, iv, tag } = encrypted
  if (iv.length !== IV_BYTES) throw new Error(`bad iv length: ${iv.length}`)
  if (tag.length !== TAG_BYTES) throw new Error(`bad tag length: ${tag.length}`)
  if (ciphertext.length === 0) throw new Error('ciphertext is empty')
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Key-rotation helper — decrypt with old, re-encrypt with new. No I/O.
 * The caller iterates `support_messages` rows, re-writes the triplet +
 * key version atomically, and optionally appends a
 * `support_message_edits` audit row.
 */
export function rotateMessage(
  encrypted: Omit<EncryptedMessage, 'keyVersion'>,
  oldKey: Buffer,
  newKey: Buffer,
  newKeyVersion: number,
): EncryptedMessage {
  const plaintext = decryptMessage(encrypted, oldKey)
  return encryptMessage(plaintext, newKey, newKeyVersion)
}

/**
 * Generate a fresh random key suitable for
 * `SUPPORT_MESSAGE_ENCRYPTION_KEY`. Used by the ops CLI that
 * bootstraps a new environment + by key-rotation tooling.
 */
export function generateMessageKey(): string {
  return randomBytes(KEY_BYTES).toString('hex')
}

/**
 * Resolve the key to use for **encrypting new messages** from process
 * env. Callers that need to decrypt an old-version row should use
 * `resolveKeyForVersion()` instead.
 */
export function resolveCurrentKey(
  env: NodeJS.ProcessEnv = process.env,
): { key: Buffer; version: number } {
  const hex = env[SUPPORT_MESSAGE_KEY_ENV]
  if (!hex) {
    throw new Error(`${SUPPORT_MESSAGE_KEY_ENV} is not set`)
  }
  const key = parseMessageKey(hex)
  const versionStr = env['SUPPORT_MESSAGE_KEY_CURRENT_VERSION'] ?? '1'
  const version = Number.parseInt(versionStr, 10)
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `SUPPORT_MESSAGE_KEY_CURRENT_VERSION must be a positive integer, got ${versionStr}`,
    )
  }
  return { key, version }
}

/**
 * Resolve the key for decrypting a row with a specific key version.
 * Version 1 maps to the base env var. Versions > 1 must have their
 * historical predecessor keys available under
 * `SUPPORT_MESSAGE_ENCRYPTION_KEY_V{n}` so re-encrypt migrations can
 * read old data while the current writer uses the new key.
 */
export function resolveKeyForVersion(
  version: number,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`invalid key version: ${version}`)
  }
  const envName =
    version === 1
      ? SUPPORT_MESSAGE_KEY_ENV
      : `${SUPPORT_MESSAGE_KEY_ENV}_V${version}`
  const hex = env[envName]
  if (!hex) {
    throw new Error(`key for version ${version} is not set (env ${envName})`)
  }
  return parseMessageKey(hex)
}
