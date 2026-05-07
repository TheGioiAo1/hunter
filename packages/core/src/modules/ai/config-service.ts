/**
 * Gbox Platform — AI Config Service
 *
 * Manages the `shop_ai_config` table, which holds per-shop
 * AI provider settings and encrypted API keys.
 *
 * Security:
 *   - API keys are encrypted with AES-256-GCM (same as pixel-service)
 *   - The KEK is derived from process.env.AI_ENCRYPTION_KEY or PIXEL_ENCRYPTION_KEY
 *   - Admin UI never displays decrypted keys — only shows "Configured" badge
 *   - Keys are decrypted in-memory only when making API calls
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'

// ─── Types ──────────────────────────────────────────────────────

export type AIProvider = 'openai' | 'anthropic' | 'google' | 'none'

export interface AIConfigPublic {
  readonly shopId: string
  readonly provider: AIProvider
  readonly hasOpenaiKey: boolean
  readonly hasAnthropicKey: boolean
  readonly hasGoogleKey: boolean
  readonly openaiModel: string
  readonly anthropicModel: string
  readonly googleModel: string
  readonly enabled: boolean
  /** ISO timestamp of last successful pingProvider, or null if never verified. Added in migration 093. */
  readonly verifiedAt: string | null
  /** Sanitized error from last failed pingProvider, or null. Added in migration 093. */
  readonly lastError: string | null
  /** Running spend tally in cents for the current billing window. Added in migration 093. */
  readonly monthlyCostUsdCents: number
}

export interface UpsertAIConfigInput {
  readonly provider?: AIProvider
  readonly openaiKey?: string | null
  readonly anthropicKey?: string | null
  readonly googleKey?: string | null
  readonly openaiModel?: string
  readonly anthropicModel?: string
  readonly googleModel?: string
  readonly enabled?: boolean
}

export interface DecryptedAIKeys {
  readonly openaiKey: string | null
  readonly anthropicKey: string | null
  readonly googleKey: string | null
}

// ─── AES-256-GCM Encryption ────────────────────────────────────

const ALGORITHM = 'aes-256-gcm'
const NONCE_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function encryptKey(plaintext: string, kek: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv(ALGORITHM, kek, nonce)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([nonce, authTag, encrypted])
}

function decryptKey(envelope: Buffer, kek: Buffer): string {
  if (envelope.length < NONCE_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext too short')
  }
  const nonce = envelope.subarray(0, NONCE_LENGTH)
  const authTag = envelope.subarray(NONCE_LENGTH, NONCE_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = envelope.subarray(NONCE_LENGTH + AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, kek, nonce)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

function resolveKek(): Buffer {
  const raw = process.env.AI_ENCRYPTION_KEY || process.env.PIXEL_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'AI_ENCRYPTION_KEY (or PIXEL_ENCRYPTION_KEY) env var is required. ' +
      'Set it to a 64-char hex string (32 bytes).',
    )
  }
  const key = Buffer.from(raw, 'hex')
  if (key.length !== 32) {
    throw new Error('Encryption key must be exactly 32 bytes (64 hex chars).')
  }
  return key
}

// ─── CRUD ───────────────────────────────────────────────────────

/**
 * Get AI config for a shop (public — no decrypted keys).
 * Returns null if no config exists.
 */
export async function getAIConfig(
  db: Kysely<any>,
  shopId: string,
): Promise<AIConfigPublic | null> {
  const row = await db
    .selectFrom('shop_ai_config')
    .select([
      'shop_id',
      'provider',
      'encrypted_openai_key',
      'encrypted_anthropic_key',
      'encrypted_google_key',
      'openai_model',
      'anthropic_model',
      'google_model',
      'enabled',
      // Migration 093 columns — may be absent on un-migrated DBs; default gracefully.
      'verified_at',
      'last_error',
      'monthly_cost_usd_cents',
    ])
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!row) return null

  // `verified_at` may be a Date object (pg driver) or ISO string; normalise to string.
  const verifiedAt: string | null =
    row.verified_at == null ? null
    : typeof row.verified_at === 'string' ? row.verified_at
    : (row.verified_at as Date).toISOString()

  return {
    shopId: row.shop_id,
    provider: row.provider as AIProvider,
    hasOpenaiKey: !!row.encrypted_openai_key,
    hasAnthropicKey: !!row.encrypted_anthropic_key,
    hasGoogleKey: !!row.encrypted_google_key,
    openaiModel: row.openai_model || 'gpt-4o-mini',
    anthropicModel: row.anthropic_model || 'claude-sonnet-4-20250514',
    googleModel: row.google_model || 'gemini-2.0-flash',
    enabled: row.enabled ?? false,
    verifiedAt,
    lastError: row.last_error ?? null,
    monthlyCostUsdCents: row.monthly_cost_usd_cents ?? 0,
  }
}

/**
 * Upsert AI config for a shop. Only non-undefined fields are updated.
 * API keys are encrypted before storage.
 */
export async function upsertAIConfig(
  db: Kysely<any>,
  shopId: string,
  input: UpsertAIConfigInput,
): Promise<void> {
  const kek = resolveKek()

  // Build the values object, only including provided fields
  const values: Record<string, any> = { shop_id: shopId }

  if (input.provider !== undefined) values.provider = input.provider
  if (input.enabled !== undefined) values.enabled = input.enabled
  if (input.openaiModel !== undefined) values.openai_model = input.openaiModel
  if (input.anthropicModel !== undefined) values.anthropic_model = input.anthropicModel
  if (input.googleModel !== undefined) values.google_model = input.googleModel

  // Encrypt keys if provided (non-empty string)
  if (input.openaiKey) {
    values.encrypted_openai_key = encryptKey(input.openaiKey, kek)
  }
  if (input.anthropicKey) {
    values.encrypted_anthropic_key = encryptKey(input.anthropicKey, kek)
  }
  if (input.googleKey) {
    values.encrypted_google_key = encryptKey(input.googleKey, kek)
  }

  // Check if row exists
  const existing = await db
    .selectFrom('shop_ai_config')
    .select('shop_id')
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (existing) {
    // Update only provided fields
    const updateSet: Record<string, any> = {}
    if ('provider' in values) updateSet.provider = values.provider
    if ('enabled' in values) updateSet.enabled = values.enabled
    if ('openai_model' in values) updateSet.openai_model = values.openai_model
    if ('anthropic_model' in values) updateSet.anthropic_model = values.anthropic_model
    if ('google_model' in values) updateSet.google_model = values.google_model
    if ('encrypted_openai_key' in values) updateSet.encrypted_openai_key = values.encrypted_openai_key
    if ('encrypted_anthropic_key' in values) updateSet.encrypted_anthropic_key = values.encrypted_anthropic_key
    if ('encrypted_google_key' in values) updateSet.encrypted_google_key = values.encrypted_google_key

    if (Object.keys(updateSet).length > 0) {
      await db
        .updateTable('shop_ai_config')
        .set(updateSet)
        .where('shop_id', '=', shopId)
        .execute()
    }
  } else {
    // Insert with defaults
    if (!values.provider) values.provider = 'none'
    if (values.enabled === undefined) values.enabled = false
    await db
      .insertInto('shop_ai_config')
      .values(values)
      .execute()
  }
}

/**
 * Get decrypted AI keys for a shop (for making API calls).
 * Only call this on the server side, never expose to client.
 */
export async function getDecryptedAIKeys(
  db: Kysely<any>,
  shopId: string,
): Promise<{ provider: AIProvider; keys: DecryptedAIKeys; model: string } | null> {
  const row = await db
    .selectFrom('shop_ai_config')
    .select([
      'provider',
      'encrypted_openai_key',
      'encrypted_anthropic_key',
      'encrypted_google_key',
      'openai_model',
      'anthropic_model',
      'google_model',
      'enabled',
    ])
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!row || !row.enabled) return null

  let kek: Buffer
  try {
    kek = resolveKek()
  } catch {
    return null
  }

  const provider = row.provider as AIProvider
  const keys: DecryptedAIKeys = {
    openaiKey: row.encrypted_openai_key ? decryptKey(row.encrypted_openai_key, kek) : null,
    anthropicKey: row.encrypted_anthropic_key ? decryptKey(row.encrypted_anthropic_key, kek) : null,
    googleKey: row.encrypted_google_key ? decryptKey(row.encrypted_google_key, kek) : null,
  }

  const model =
    provider === 'openai' ? (row.openai_model || 'gpt-4o-mini') :
    provider === 'anthropic' ? (row.anthropic_model || 'claude-sonnet-4-20250514') :
    provider === 'google' ? (row.google_model || 'gemini-2.0-flash') : ''

  return { provider, keys, model }
}

/**
 * Remove AI keys for a specific provider.
 */
export async function clearAIKey(
  db: Kysely<any>,
  shopId: string,
  provider: 'openai' | 'anthropic' | 'google',
): Promise<void> {
  const column =
    provider === 'openai' ? 'encrypted_openai_key' :
    provider === 'anthropic' ? 'encrypted_anthropic_key' :
    'encrypted_google_key'

  await db
    .updateTable('shop_ai_config')
    .set({ [column]: null })
    .where('shop_id', '=', shopId)
    .execute()
}
