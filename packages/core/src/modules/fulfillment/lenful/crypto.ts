/**
 * Lenful credential encryption helpers.
 *
 * Same envelope format as packages/core/src/modules/ai/config-service.ts:
 *   [ 12-byte nonce | 16-byte auth tag | ciphertext ]
 *
 * KEK resolution order:
 *   1. process.env.LENFUL_ENCRYPTION_KEY
 *   2. process.env.AI_ENCRYPTION_KEY
 *   3. process.env.PIXEL_ENCRYPTION_KEY
 *
 * Key must be 64 hex chars (32 bytes).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const NONCE_LENGTH = 12
const AUTH_TAG_LENGTH = 16

let cachedKek: Buffer | null = null

export function resolveKek(): Buffer {
  if (cachedKek) return cachedKek
  const raw =
    process.env.LENFUL_ENCRYPTION_KEY ||
    process.env.AI_ENCRYPTION_KEY ||
    process.env.PIXEL_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'LENFUL_ENCRYPTION_KEY (or AI_ENCRYPTION_KEY / PIXEL_ENCRYPTION_KEY) env var is required. ' +
        'Set it to a 64-char hex string (32 bytes).',
    )
  }
  const key = Buffer.from(raw, 'hex')
  if (key.length !== 32) {
    throw new Error('LENFUL_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars).')
  }
  cachedKek = key
  return key
}

export function encryptSecret(plaintext: string): Buffer {
  const kek = resolveKek()
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv(ALGORITHM, kek, nonce)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([nonce, authTag, encrypted])
}

export function decryptSecret(envelope: Buffer): string {
  const kek = resolveKek()
  if (envelope.length < NONCE_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Lenful ciphertext too short')
  }
  const nonce = envelope.subarray(0, NONCE_LENGTH)
  const authTag = envelope.subarray(NONCE_LENGTH, NONCE_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = envelope.subarray(NONCE_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, kek, nonce)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

/** Redact fields that must never hit the api_log table. */
export function redactRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) }
  for (const key of Object.keys(clone)) {
    if (/pass(word)?|token|secret|key/i.test(key)) {
      clone[key] = '[REDACTED]'
    }
  }
  return clone
}
