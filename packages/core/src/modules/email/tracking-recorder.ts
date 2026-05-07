/**
 * Gbox Platform — Email tracking recorder (Phase 14 PR4)
 *
 * DB-facing side of the tracking pipeline. `tracking.ts` is pure crypto
 * + URL plumbing; this module owns the "a hit just happened" writes:
 *
 *   recordOpen(db, token, meta)   — bumps open_count + inserts email_events
 *   recordClick(db, token, url, m)— bumps click_count + inserts email_events
 *
 * Both are best-effort. A DB error NEVER propagates to the route — the
 * recipient sees the pixel / redirect regardless. We log server-side
 * (via pino once wired) but keep the public surface silent.
 *
 * IP hashing
 * ----------
 * Raw IPs are never stored. We hash via SHA-256(ip + salt) where the
 * salt comes from EMAIL_TRACKING_IP_SALT. Rotating the salt is part of
 * PR5 (GDPR pack) — for PR4 a stable salt is fine, we just need the
 * "unique-opens by IP" counting to work within a reporting window.
 *
 * Anti-enumeration
 * ----------------
 * An invalid token returns `{ ok: false, reason: 'not_found' }` but the
 * route swallows the reason and still responds with a pixel/redirect.
 * Don't surface the reason to the caller; it's here for ops logging
 * only.
 */

import crypto from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'

import { verifyTrackingToken, decodeClickTarget } from './tracking.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HitMeta {
  /** Client IP as a string (IPv4 or IPv6). Null if not available. */
  ip: string | null
  /** Raw UA header. Truncated to 500 chars before storage. */
  userAgent: string | null
}

export type RecordResult =
  | { ok: true; deliveryId: number }
  | { ok: false; reason: 'not_found' | 'invalid_token' | 'db_error' }

// ---------------------------------------------------------------------------
// IP hashing
// ---------------------------------------------------------------------------

/**
 * Hash an IP with the tracking salt. Returns null if no IP (we don't
 * hash null). Same function shape as the other `*_hash` helpers in the
 * codebase for consistency.
 *
 * Salt precedence:
 *   1. EMAIL_TRACKING_IP_SALT (explicit)
 *   2. EMAIL_TRACKING_SECRET  (re-use — acceptable for PR4; PR5 splits)
 *   3. 'gbox-dev-ip-salt-insecure' (dev fallback, loud)
 */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const salt =
    process.env.EMAIL_TRACKING_IP_SALT ??
    process.env.EMAIL_TRACKING_SECRET ??
    'gbox-dev-ip-salt-insecure'
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex')
}

// ---------------------------------------------------------------------------
// Delivery lookup
// ---------------------------------------------------------------------------

/**
 * Look up a delivery row by tracking token. Returns the row id + any
 * columns the recorder needs downstream, or null.
 *
 * The token is validated via HMAC BEFORE we hit the DB — saves a round
 * trip on garbage tokens and narrows the attack surface (the partial
 * UNIQUE index guarantees there's at most one row per token, but a
 * brute-forced token could still collide on 128 bits of entropy).
 *
 * We can't verify HMAC without the delivery_id though — catch-22. The
 * shape check (32 hex chars) short-circuits the most obvious garbage,
 * and the DB lookup then happens for plausible tokens. If the lookup
 * hits, we HMAC-verify post-hoc.
 */
async function loadDeliveryByToken(
  db: Kysely<Database>,
  token: string,
): Promise<{
  id: number
  template_key: string
  shop_id: string | null
  opened_at: string | null
  clicked_at: string | null
} | null> {
  if (!isValidTokenShape(token)) return null
  const row = await db
    .selectFrom('email_deliveries')
    .select(['id', 'template_key', 'shop_id', 'opened_at', 'clicked_at'])
    .where('tracking_token', '=', token)
    .executeTakeFirst()
  if (!row) return null
  // Post-hoc HMAC verify. If this fails, the row's token somehow
  // doesn't match what we would mint — either a DB anomaly (someone
  // wrote a bogus token column directly) or a collision. Fail closed.
  if (!verifyTrackingToken(token, row.id)) return null
  return row
}

function isValidTokenShape(t: unknown): t is string {
  return typeof t === 'string' && /^[0-9a-f]{32}$/i.test(t)
}

// ---------------------------------------------------------------------------
// Open recorder
// ---------------------------------------------------------------------------

/**
 * Record an open-pixel hit. Bumps the counter and appends an
 * email_events row. Idempotency: every open increments — duplicate
 * opens are EXPECTED (Gmail Image Proxy caches, client re-opens email,
 * forwarders, etc.). The `opened_at` field tracks the *first* hit.
 */
export async function recordOpen(
  db: Kysely<Database>,
  token: string,
  meta: HitMeta,
): Promise<RecordResult> {
  const row = await loadDeliveryByToken(db, token)
  if (!row) return { ok: false, reason: 'not_found' }

  const ua = truncate(meta.userAgent ?? null, 500)
  const ipHash = hashIp(meta.ip)

  try {
    // Bump counter + set opened_at if it was null (first hit).
    await db
      .updateTable('email_deliveries')
      .set((eb) => ({
        open_count: eb('open_count', '+', 1),
        opened_at:
          row.opened_at == null
            ? new Date().toISOString()
            : row.opened_at,
      }))
      .where('id', '=', row.id)
      .execute()

    // Append event row. Never throws on duplicates — each hit is a
    // distinct audit entry.
    await db
      .insertInto('email_events')
      .values({
        delivery_id: row.id,
        event_type: 'open',
        user_agent: ua,
        ip_hash: ipHash,
        clicked_url: null,
        bounce_type: null,
        raw_payload: null,
      })
      .execute()

    return { ok: true, deliveryId: row.id }
  } catch {
    return { ok: false, reason: 'db_error' }
  }
}

// ---------------------------------------------------------------------------
// Click recorder
// ---------------------------------------------------------------------------

/**
 * Record a click-redirect hit. Decodes the URL from the `u` param (via
 * tracking.ts::decodeClickTarget), rejects javascript:/data:/file: and
 * malformed URLs. Returns the safe target URL so the route can 302 to
 * it; null target → route must redirect to `/` instead.
 */
export type ClickResult =
  | { ok: true; deliveryId: number; target: string }
  | { ok: false; reason: 'not_found' | 'invalid_token' | 'invalid_target' | 'db_error' }

export async function recordClick(
  db: Kysely<Database>,
  token: string,
  encodedTarget: string,
  meta: HitMeta,
): Promise<ClickResult> {
  const target = decodeClickTarget(encodedTarget)
  if (!target) return { ok: false, reason: 'invalid_target' }

  const row = await loadDeliveryByToken(db, token)
  if (!row) return { ok: false, reason: 'not_found' }

  const ua = truncate(meta.userAgent ?? null, 500)
  const ipHash = hashIp(meta.ip)

  try {
    await db
      .updateTable('email_deliveries')
      .set((eb) => ({
        click_count: eb('click_count', '+', 1),
        clicked_at:
          row.clicked_at == null
            ? new Date().toISOString()
            : row.clicked_at,
      }))
      .where('id', '=', row.id)
      .execute()

    await db
      .insertInto('email_events')
      .values({
        delivery_id: row.id,
        event_type: 'click',
        user_agent: ua,
        ip_hash: ipHash,
        clicked_url: truncate(target, 2048),
        bounce_type: null,
        raw_payload: null,
      })
      .execute()

    return { ok: true, deliveryId: row.id, target }
  } catch {
    return { ok: false, reason: 'db_error' }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string | null, max: number): string | null {
  if (s == null) return null
  return s.length <= max ? s : s.slice(0, max)
}
