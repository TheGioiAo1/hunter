/**
 * Gbox Platform — support-ai config store (Phase 12.5 PR4).
 *
 * Reads + writes the three pieces of runtime config support-ai
 * needs from `platform_settings`:
 *
 *   ai_support_anthropic_api_key     (secret, encrypted at rest)
 *   ai_support_enabled               (boolean, master kill switch)
 *   ai_support_monthly_budget_cents  (number, default 20000 = $200)
 *
 * The key is AES-256-GCM encrypted using
 * `SUPPORT_AI_ENCRYPTION_KEY` env var (32 bytes hex). If the env
 * var is absent we fall back to `OAUTH_ENCRYPTION_KEY` — both are
 * 32-byte hex keys and it lets a single-key bootstrap work. The
 * fallback is logged (single warn line per process lifetime) so
 * the operator knows to either set the dedicated key or accept the
 * reuse.
 *
 * Why store it encrypted when `platform_settings` is already
 * god-admin-only?
 *   - Iron Rule 1: secrets at rest are always encrypted, regardless
 *     of the access-control layer. A DB dump shared with a vendor
 *     for replication testing shouldn't leak live Anthropic credits.
 *   - If a future migration promotes the table to a wider audience
 *     (e.g. per-shop AI keys), the encryption stays correct.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

const ALGO = 'aes-256-gcm' as const
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/** Wire format for an encrypted Anthropic key stored in JSONB. */
export interface EncryptedKeyBlob {
  readonly v: 1
  readonly ct: string // hex ciphertext
  readonly iv: string // hex iv
  readonly tag: string // hex auth tag
}

function resolveEncryptionKey(): Buffer {
  const primary = process.env.SUPPORT_AI_ENCRYPTION_KEY
  const fallback = process.env.OAUTH_ENCRYPTION_KEY
  const hex = primary && primary.length > 0 ? primary : fallback ?? ''
  if (!hex) {
    throw new Error(
      'Missing SUPPORT_AI_ENCRYPTION_KEY (or fallback OAUTH_ENCRYPTION_KEY) — cannot encrypt Anthropic key',
    )
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('SUPPORT_AI_ENCRYPTION_KEY must be hex')
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `SUPPORT_AI_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    )
  }
  return buf
}

/**
 * Encrypt a plaintext Anthropic key. Returns the blob shape that
 * goes into `platform_settings.value` as JSONB. Called on POST
 * from /god-admin/settings/ai.
 */
export function encryptAnthropicKey(plaintext: string): EncryptedKeyBlob {
  const key = resolveEncryptionKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Unexpected GCM tag length (${tag.length})`)
  }
  return {
    v: 1,
    ct: ciphertext.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  }
}

/**
 * Decrypt a blob back to plaintext. Throws if the tag doesn't
 * verify (wrong key, tampered ciphertext, truncated blob).
 */
export function decryptAnthropicKey(blob: EncryptedKeyBlob | null | undefined): string {
  if (!blob || blob.v !== 1) return ''
  const key = resolveEncryptionKey()
  const iv = Buffer.from(blob.iv, 'hex')
  const ct = Buffer.from(blob.ct, 'hex')
  const tag = Buffer.from(blob.tag, 'hex')
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Check that an arbitrary JSONB shape conforms to EncryptedKeyBlob.
 * Used when reading back from the DB — platform_settings stores
 * JSONB so TypeScript alone can't guarantee the shape.
 */
export function isEncryptedKeyBlob(v: unknown): v is EncryptedKeyBlob {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return (
    b.v === 1 &&
    typeof b.ct === 'string' &&
    typeof b.iv === 'string' &&
    typeof b.tag === 'string'
  )
}

// ---------------------------------------------------------------------------
// Platform settings row keys
// ---------------------------------------------------------------------------

export const AI_KEY_SETTING = 'ai_support_anthropic_api_key'
export const AI_ENABLED_SETTING = 'ai_support_enabled'
export const AI_BUDGET_SETTING = 'ai_support_monthly_budget_cents'

/**
 * Read the three config values in one round-trip.
 *
 * Fail-soft: missing rows return the MVP defaults
 * (empty key = AI off, enabled=true, budget=$200) so the caller
 * still gets a valid object and can decide to disable based on
 * `.anthropicApiKey === ''`.
 */
export async function readAISupportConfig(db: any): Promise<{
  anthropicApiKey: string
  enabled: boolean
  capCents: number
}> {
  try {
    const rows = await (db as any)
      .selectFrom('platform_settings')
      .select(['key', 'value'])
      .where('key', 'in', [AI_KEY_SETTING, AI_ENABLED_SETTING, AI_BUDGET_SETTING])
      .execute()
    const byKey: Record<string, unknown> = {}
    for (const r of rows) byKey[String(r.key)] = r.value

    let anthropicApiKey = ''
    const rawBlob = byKey[AI_KEY_SETTING]
    if (isEncryptedKeyBlob(rawBlob)) {
      try {
        anthropicApiKey = decryptAnthropicKey(rawBlob)
      } catch {
        anthropicApiKey = ''
      }
    }

    const enabled = byKey[AI_ENABLED_SETTING] === false ? false : true
    const rawCap = byKey[AI_BUDGET_SETTING]
    const capCents =
      typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0
        ? Math.floor(rawCap)
        : 20_000

    return { anthropicApiKey, enabled, capCents }
  } catch {
    return { anthropicApiKey: '', enabled: true, capCents: 20_000 }
  }
}
