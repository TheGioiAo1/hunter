/**
 * Webhooks — HMAC signing & verification (Shopify pattern)
 *
 * Outgoing webhooks are signed with `X-Gbox-Hmac-SHA256: base64(hmac)`.
 * Subscribers verify the signature before trusting the payload.
 *
 * Incoming partner webhooks (Stripe, PayPal, Shopify app) use similar
 * schemes; this helper exposes a `verifySignature` that accepts the
 * raw body + received signature + secret.
 *
 * Key rules:
 *   1. Sign the *exact* bytes of the body. Never re-serialize — even a
 *      space difference breaks the signature.
 *   2. Compare with `timingSafeEqual` — never `===` — to avoid timing
 *      side-channel attacks.
 *   3. Never log the secret. Log only the *signature* (it's public).
 *
 * # Secret rotation (Phase 0 §8 Item #2)
 *
 * Each shop can rotate its webhook secret via `rotateShopWebhookSecret`.
 * After a rotation:
 *
 *   - `webhook.secret`          — the new primary (used to sign new deliveries)
 *   - `webhook.secret.previous` — the old secret, kept for a grace window
 *   - `webhook.secret.rotated_at` — ISO timestamp of the rotation
 *
 * During the grace window (default 7 days) every outbound delivery
 * carries BOTH `X-Gbox-Hmac-SHA256` (new) and
 * `X-Gbox-Hmac-SHA256-Previous` (old) so merchants can flip their
 * verifier at their own pace. Once the grace window expires, the
 * previous header is dropped and the next access clears the stored
 * previous secret.
 */

import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

export const HMAC_HEADER = 'x-gbox-hmac-sha256'
export const HMAC_HEADER_PREVIOUS = 'x-gbox-hmac-sha256-previous'
export const SECRET_ROTATED_AT_HEADER = 'x-gbox-secret-rotated-at'

/**
 * Grace window after a rotation during which the previous secret is
 * still broadcast alongside the new one. Default 7 days. Configurable
 * via `GBOX_WEBHOOK_ROTATION_GRACE_DAYS`.
 */
export function getRotationGraceDays(): number {
  const raw = process.env.GBOX_WEBHOOK_ROTATION_GRACE_DAYS
  if (!raw) return 7
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 7
  return n
}

/**
 * Compute the canonical signature of a payload body with a secret.
 * Returns base64-encoded HMAC-SHA256.
 */
export function signBody(secret: string, body: string | Buffer): string {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  return crypto.createHmac('sha256', secret).update(data).digest('base64')
}

/**
 * Verify a received signature against a recomputed one, in constant
 * time. Returns true iff the signature matches.
 */
export function verifySignature(
  secret: string,
  body: string | Buffer,
  receivedSignature: string,
): boolean {
  const expected = signBody(secret, body)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(receivedSignature, 'utf8')
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Bundle describing the signing material for a shop at a point in time.
 *
 * - `current` is always populated.
 * - `previous` is set only when the shop rotated within the grace
 *   window. During that time every delivery includes BOTH signatures.
 * - `rotatedAt` is the ISO timestamp of the most recent rotation (or
 *   null if the shop has never rotated).
 * - `graceRemainingMs` is how much longer `previous` should be sent.
 *   0 or negative means the grace window has expired and callers should
 *   drop the previous header.
 */
export interface ShopWebhookSecretBundle {
  current: string
  previous: string | null
  rotatedAt: string | null
  graceRemainingMs: number
}

/**
 * Derive a per-shop webhook secret (legacy convenience wrapper).
 *
 * Priority:
 *   1. `shop_settings` row with key = 'webhook.secret' (merchant-visible).
 *   2. HMAC(GBOX_WEBHOOK_ROOT, shopId) — deterministic fallback so
 *      existing shops immediately get a strong secret without extra
 *      setup.
 *
 * The fallback is stable as long as GBOX_WEBHOOK_ROOT env var is stable.
 * Rotating the env var invalidates all unset-secret shops at once, which
 * is exactly the behaviour we want for emergency rotation.
 *
 * For Phase 0 §8 Item #2 — call `getShopWebhookSecretBundle` instead
 * when you need to sign an outbound request so the previous-secret
 * grace window is honoured.
 */
export async function getShopWebhookSecret(
  db: Kysely<Database>,
  shopId: string,
): Promise<string> {
  const bundle = await getShopWebhookSecretBundle(db, shopId)
  return bundle.current
}

/**
 * Read the full signing bundle for a shop (current + optional previous
 * + rotation metadata).
 *
 * Looks up three `shop_settings` keys in a single query:
 *   - `webhook.secret`          → current
 *   - `webhook.secret.previous` → previous (during grace window)
 *   - `webhook.secret.rotated_at`
 *
 * Falls back to the HMAC(GBOX_WEBHOOK_ROOT, shopId) derivation when no
 * explicit row exists, same as legacy `getShopWebhookSecret`.
 */
export async function getShopWebhookSecretBundle(
  db: Kysely<Database>,
  shopId: string,
): Promise<ShopWebhookSecretBundle> {
  const rows = await db
    .selectFrom('shop_settings')
    .select(['key', 'value'])
    .where('shop_id', '=', shopId)
    .where('key', 'in', [
      'webhook.secret',
      'webhook.secret.previous',
      'webhook.secret.rotated_at',
    ])
    .execute()

  const byKey = new Map<string, unknown>()
  for (const r of rows) {
    byKey.set(r.key, r.value as unknown)
  }

  const current =
    extractSecret(byKey.get('webhook.secret')) ??
    deriveFallbackSecret(shopId)

  const previousRaw = extractSecret(byKey.get('webhook.secret.previous'))
  const rotatedAt = extractIsoString(byKey.get('webhook.secret.rotated_at'))

  const graceMs = getRotationGraceDays() * 24 * 60 * 60 * 1000
  const graceRemainingMs = rotatedAt
    ? Math.max(
        0,
        new Date(rotatedAt).getTime() + graceMs - Date.now(),
      )
    : 0
  const previous = previousRaw && graceRemainingMs > 0 ? previousRaw : null

  return {
    current,
    previous,
    rotatedAt,
    graceRemainingMs,
  }
}

function extractSecret(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.length >= 16) return value
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { secret?: unknown }).secret === 'string'
  ) {
    const s = (value as { secret: string }).secret
    return s.length >= 16 ? s : null
  }
  return null
}

function extractIsoString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { value?: unknown }).value === 'string'
  ) {
    return (value as { value: string }).value
  }
  return null
}

function deriveFallbackSecret(shopId: string): string {
  const root =
    process.env.GBOX_WEBHOOK_ROOT ||
    process.env.SESSION_SECRET ||
    'gbox-dev-webhook-root-do-not-use-in-prod'
  return crypto.createHmac('sha256', root).update(shopId).digest('hex')
}

/**
 * Generate a cryptographically-strong webhook secret. 48 hex bytes
 * (~384 bits of entropy) — comfortably above the 256-bit HMAC key
 * strength and still short enough to paste into a dashboard.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(48).toString('hex')
}

/**
 * Result of a successful rotation.
 */
export interface RotationResult {
  /** Freshly-generated secret now stored at `webhook.secret`. */
  newSecret: string
  /** The secret that was there before — may be null if never set. */
  previousSecret: string | null
  /** ISO timestamp of the rotation (stored under `webhook.secret.rotated_at`). */
  rotatedAt: string
  /** Grace window expiry timestamp (rotatedAt + grace days). */
  graceExpiresAt: string
}

/**
 * Rotate the webhook signing secret for a shop.
 *
 * Steps (all inside a single transaction so a crash mid-rotation can't
 * leave the shop with a half-updated secret pair):
 *
 *   1. Read the current `webhook.secret` value if any.
 *   2. Upsert a new random secret at `webhook.secret`.
 *   3. Copy the old value to `webhook.secret.previous` so outbound
 *      deliveries can include both signatures during the grace window.
 *   4. Stamp `webhook.secret.rotated_at` with the current ISO timestamp.
 *
 * The caller is responsible for logging an audit event and surfacing
 * the new secret to the merchant exactly once — we NEVER re-emit it
 * after the transaction returns because that's the only time we can
 * be sure the row hasn't been re-rotated by a racing caller.
 */
export async function rotateShopWebhookSecret(
  db: Kysely<Database>,
  shopId: string,
  opts: { seedSecret?: string } = {},
): Promise<RotationResult> {
  const newSecret = opts.seedSecret ?? generateWebhookSecret()
  if (newSecret.length < 32) {
    throw new Error(
      'rotateShopWebhookSecret: seedSecret must be at least 32 chars',
    )
  }

  const rotatedAt = new Date().toISOString()
  const graceMs = getRotationGraceDays() * 24 * 60 * 60 * 1000
  const graceExpiresAt = new Date(Date.now() + graceMs).toISOString()

  const previousSecret = await db.transaction().execute(async (trx) => {
    // 1. Read current
    const currentRow = await trx
      .selectFrom('shop_settings')
      .select(['value'])
      .where('shop_id', '=', shopId)
      .where('key', '=', 'webhook.secret')
      .executeTakeFirst()
    const previous = extractSecret(currentRow?.value as unknown)

    // 2. Upsert new primary
    await upsertSetting(trx, shopId, 'webhook.secret', newSecret)

    // 3. Upsert previous (if any)
    if (previous) {
      await upsertSetting(
        trx,
        shopId,
        'webhook.secret.previous',
        previous,
      )
    } else {
      // No previous secret — clear any stale row so a later rotation
      // doesn't accidentally resurrect a half-deleted previous.
      await trx
        .deleteFrom('shop_settings')
        .where('shop_id', '=', shopId)
        .where('key', '=', 'webhook.secret.previous')
        .execute()
    }

    // 4. Stamp rotated_at
    await upsertSetting(trx, shopId, 'webhook.secret.rotated_at', rotatedAt)

    return previous
  })

  return {
    newSecret,
    previousSecret,
    rotatedAt,
    graceExpiresAt,
  }
}

/**
 * Best-effort JSONB upsert into `shop_settings`. Delete-then-insert
 * rather than ON CONFLICT so we don't need a named unique constraint
 * in the schema — the composite PK already enforces uniqueness on
 * (shop_id, key) in migration 001.
 */
async function upsertSetting(
  trx: Kysely<Database>,
  shopId: string,
  key: string,
  value: string,
): Promise<void> {
  await trx
    .deleteFrom('shop_settings')
    .where('shop_id', '=', shopId)
    .where('key', '=', key)
    .execute()

  await trx
    .insertInto('shop_settings')
    .values({
      shop_id: shopId,
      key,
      value: JSON.stringify(value),
    })
    .execute()
}

/**
 * Clear the previous-secret row once the grace window has expired.
 * Called from the daily cron job (alongside audit-log prune) so
 * expired previous secrets don't sit around indefinitely.
 */
export async function clearExpiredPreviousSecrets(
  db: Kysely<Database>,
): Promise<{ cleared: number }> {
  const graceMs = getRotationGraceDays() * 24 * 60 * 60 * 1000
  const cutoffIso = new Date(Date.now() - graceMs).toISOString()

  // Find every shop whose last rotation is older than the grace window.
  const expired = await db
    .selectFrom('shop_settings')
    .select(['shop_id', 'value'])
    .where('key', '=', 'webhook.secret.rotated_at')
    .execute()

  const shopsToClear: string[] = []
  for (const row of expired) {
    const iso = extractIsoString(row.value as unknown)
    if (iso && iso < cutoffIso) {
      shopsToClear.push(row.shop_id)
    }
  }

  if (shopsToClear.length === 0) {
    return { cleared: 0 }
  }

  const res = await db
    .deleteFrom('shop_settings')
    .where('shop_id', 'in', shopsToClear)
    .where('key', '=', 'webhook.secret.previous')
    .execute()

  // Kysely's delete returns numUpdatedOrDeletedRows on most drivers.
  const cleared =
    typeof (res as { numAffectedRows?: bigint }).numAffectedRows === 'bigint'
      ? Number((res as { numAffectedRows: bigint }).numAffectedRows)
      : shopsToClear.length

  return { cleared }
}
