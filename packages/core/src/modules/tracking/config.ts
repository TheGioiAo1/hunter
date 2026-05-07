/**
 * Tracking-pixel CRUD: list / create / update / delete a row in
 * `shop_tracking_pixels`. Tokens get AES-256-GCM encrypted before
 * INSERT via the shared KEK in fulfillment/lenful/crypto.ts — same
 * key material the rest of the platform uses, so ops only manages
 * one `PIXEL_ENCRYPTION_KEY` (fallback: `LENFUL_ENCRYPTION_KEY`).
 *
 * Public reads NEVER return the decrypted token — see
 * `listPixelsWithTokens` for the server-only variant.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { encryptSecret, decryptSecret } from '../fulfillment/lenful/crypto.ts'
import type {
  CanonicalEvent,
  CreateTrackingPixelInput,
  TrackingPixelPublic,
  TrackingPixelWithToken,
  TrackingProvider,
  UpdateTrackingPixelInput,
} from './types.ts'
import {
  CANONICAL_EVENTS,
  DEFAULT_ENABLED_EVENTS,
  TRACKING_PROVIDERS,
  providerNeedsToken,
} from './types.ts'

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isKnownProvider(x: string): x is TrackingProvider {
  return (TRACKING_PROVIDERS as readonly string[]).includes(x)
}

function isKnownEvent(x: string): x is CanonicalEvent {
  return (CANONICAL_EVENTS as readonly string[]).includes(x)
}

function cleanEvents(input: unknown): CanonicalEvent[] {
  if (!Array.isArray(input)) return []
  const out: CanonicalEvent[] = []
  for (const raw of input) {
    if (typeof raw === 'string' && isKnownEvent(raw) && !out.includes(raw)) {
      out.push(raw)
    }
  }
  return out
}

function rowToPublic(row: {
  id: string
  shop_id: string
  provider: string
  label: string
  pixel_id: string
  api_token_encrypted: Buffer | null
  events_enabled: unknown
  test_event_code: string | null
  is_active: boolean
  created_at: unknown
  updated_at: unknown
}): TrackingPixelPublic {
  return {
    id: row.id,
    shopId: row.shop_id,
    provider: (isKnownProvider(row.provider) ? row.provider : 'meta_pixel') as TrackingProvider,
    label: row.label,
    pixelId: row.pixel_id,
    hasApiToken: row.api_token_encrypted != null,
    eventsEnabled: cleanEvents(row.events_enabled),
    testEventCode: row.test_event_code,
    isActive: row.is_active,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

/** List every pixel row for a shop, newest first. Tokens hidden. */
export async function listPixels(
  db: Kysely<Database>,
  shopId: string,
): Promise<TrackingPixelPublic[]> {
  const rows = await db
    .selectFrom('shop_tracking_pixels')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('created_at', 'desc')
    .execute()
  return rows.map(rowToPublic)
}

/** Load a single pixel by id, scoped to shop. */
export async function getPixel(
  db: Kysely<Database>,
  shopId: string,
  pixelRowId: string,
): Promise<TrackingPixelPublic | null> {
  const row = await db
    .selectFrom('shop_tracking_pixels')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('id', '=', pixelRowId)
    .executeTakeFirst()
  return row ? rowToPublic(row) : null
}

/** Active rows only — used by storefront injector + dispatcher. */
export async function listActivePixels(
  db: Kysely<Database>,
  shopId: string,
): Promise<TrackingPixelPublic[]> {
  const rows = await db
    .selectFrom('shop_tracking_pixels')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('is_active', '=', true)
    .orderBy('created_at', 'asc')
    .execute()
  return rows.map(rowToPublic)
}

/**
 * Server-only: list active pixels WITH decrypted tokens. Do NOT
 * hand the result to anything that crosses a response boundary.
 * On decrypt failure the token is returned as null so one bad row
 * doesn't block the others.
 */
export async function listActivePixelsWithTokens(
  db: Kysely<Database>,
  shopId: string,
): Promise<TrackingPixelWithToken[]> {
  const rows = await db
    .selectFrom('shop_tracking_pixels')
    .selectAll()
    .where('shop_id', '=', shopId)
    .where('is_active', '=', true)
    .orderBy('created_at', 'asc')
    .execute()

  return rows.map((row) => {
    let apiToken: string | null = null
    if (row.api_token_encrypted) {
      try {
        apiToken = decryptSecret(row.api_token_encrypted as Buffer)
      } catch {
        apiToken = null
      }
    }
    return { ...rowToPublic(row), apiToken }
  })
}

/** Create a new pixel row. GTM rows ignore apiToken (always null). */
export async function createPixel(
  db: Kysely<Database>,
  input: CreateTrackingPixelInput,
): Promise<TrackingPixelPublic> {
  if (!isKnownProvider(input.provider)) {
    throw new Error(`Unknown provider: ${input.provider}`)
  }
  const label = input.label.trim()
  const pixelId = input.pixelId.trim()
  if (!label) throw new Error('Label is required')
  if (!pixelId) throw new Error('Pixel ID is required')

  const events =
    input.eventsEnabled && input.eventsEnabled.length > 0
      ? cleanEvents(input.eventsEnabled)
      : [...DEFAULT_ENABLED_EVENTS]

  const tokenBuf =
    input.apiToken && providerNeedsToken(input.provider)
      ? encryptSecret(input.apiToken)
      : null

  const inserted = await db
    .insertInto('shop_tracking_pixels')
    .values({
      shop_id: input.shopId,
      provider: input.provider,
      label,
      pixel_id: pixelId,
      api_token_encrypted: tokenBuf,
      events_enabled: JSON.stringify(events),
      test_event_code: input.testEventCode ?? null,
      is_active: input.isActive ?? true,
      created_by: input.createdBy ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  return rowToPublic(inserted)
}

/**
 * Patch-style update. Fields left undefined are untouched. `apiToken`
 * has tri-state semantics: undefined = keep, null = clear, string =
 * replace.
 */
export async function updatePixel(
  db: Kysely<Database>,
  shopId: string,
  pixelRowId: string,
  input: UpdateTrackingPixelInput,
): Promise<TrackingPixelPublic | null> {
  const existing = await db
    .selectFrom('shop_tracking_pixels')
    .select(['id', 'provider'])
    .where('shop_id', '=', shopId)
    .where('id', '=', pixelRowId)
    .executeTakeFirst()
  if (!existing) return null

  const patch: Record<string, unknown> = {}

  if (input.label !== undefined) {
    const v = input.label.trim()
    if (!v) throw new Error('Label cannot be empty')
    patch.label = v
  }
  if (input.pixelId !== undefined) {
    const v = input.pixelId.trim()
    if (!v) throw new Error('Pixel ID cannot be empty')
    patch.pixel_id = v
  }
  if (input.eventsEnabled !== undefined) {
    patch.events_enabled = JSON.stringify(cleanEvents(input.eventsEnabled))
  }
  if (input.testEventCode !== undefined) {
    patch.test_event_code = input.testEventCode
  }
  if (input.isActive !== undefined) {
    patch.is_active = input.isActive
  }
  if (input.apiToken !== undefined) {
    if (input.apiToken === null) {
      patch.api_token_encrypted = null
    } else if (providerNeedsToken(existing.provider as TrackingProvider)) {
      patch.api_token_encrypted = encryptSecret(input.apiToken)
    }
    // GTM: token field ignored.
  }

  if (Object.keys(patch).length === 0) {
    return (await getPixel(db, shopId, pixelRowId))!
  }

  const updated = await db
    .updateTable('shop_tracking_pixels')
    .set(patch)
    .where('shop_id', '=', shopId)
    .where('id', '=', pixelRowId)
    .returningAll()
    .executeTakeFirstOrThrow()

  return rowToPublic(updated)
}

/** Hard delete — per Q3/Q4: no tombstones, leave no trace. */
export async function deletePixel(
  db: Kysely<Database>,
  shopId: string,
  pixelRowId: string,
): Promise<boolean> {
  const res = await db
    .deleteFrom('shop_tracking_pixels')
    .where('shop_id', '=', shopId)
    .where('id', '=', pixelRowId)
    .executeTakeFirst()
  return (res.numDeletedRows ?? 0n) > 0n
}

/** Convenience toggle — keeps is_active flips cheap from the UI. */
export async function setPixelActive(
  db: Kysely<Database>,
  shopId: string,
  pixelRowId: string,
  isActive: boolean,
): Promise<TrackingPixelPublic | null> {
  return updatePixel(db, shopId, pixelRowId, { isActive })
}
