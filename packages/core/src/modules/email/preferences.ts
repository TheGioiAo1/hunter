/**
 * Gbox Platform — Email Preferences (Phase 14 PR1)
 *
 * Two responsibilities:
 *
 *   1. `canSend()` — the gate every non-forced send goes through. Given
 *      a (template_key, shop_id, recipient_email), returns whether the
 *      recipient has opted in to that template's category. For forced-
 *      send categories (transactional, ops, platform, legal — see
 *      `registry.ts::isForcedSendCategory`) we skip the lookup and
 *      always allow.
 *
 *   2. Unsubscribe token lifecycle — generate a raw token (returned to
 *      the caller ONCE, stored nowhere), persist its SHA-256 hash, and
 *      resolve token → preference row on the public unsubscribe link.
 *      Raw tokens live only in the outbound email footer.
 *
 * DATA MODEL
 * ----------
 *   `email_preferences` is keyed by (shop_id, lower(email), category).
 *   shop_id NULL is the "platform" scope (for emails sent directly from
 *   accounts.gbox.co, e.g. login alerts, not tied to any shop). Partial
 *   unique indexes guarantee one row per key.
 *
 *   `subscribed=true` by default (opt-out model). GDPR compliance
 *   is enforced at the SEND SITE — if we're sending to an EU customer,
 *   marketing categories require a prior explicit opt-in (set
 *   subscribed=true only via a confirmed checkbox). The DB itself
 *   doesn't know the jurisdiction, so it trusts the application layer
 *   to do the right thing.
 *
 * IRON RULE 1 (Security)
 * ----------------------
 *   unsubscribe_token is 32 bytes of crypto.randomBytes, hex-encoded
 *   (64 chars). Only the SHA-256 hash reaches the DB. A stolen DB
 *   dump gives the attacker nothing they can click.
 */

import { randomBytes, createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import type {
  Database,
  EmailPreferenceCategory,
  EmailPreferenceSource,
  EmailTemplateCategory,
} from '@gbox/db/schema/tables.js'
import { getTemplate, isForcedSendCategory } from './registry.js'

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------
//
// Templates use the 7-category enum `EmailTemplateCategory`, but
// `email_preferences` uses a 7-category enum that swaps out forced-send
// categories (transactional / ops / platform / legal) for finer-grained
// opt-in buckets (newsletter / back_in_stock / price_drop / abandoned_cart).
//
// This mapper is the bridge: given a template category + key, return
// the preference category to check, or null if it's forced-send and
// shouldn't check at all.

/**
 * Map template → preference category, or null if no check needed.
 *
 * Three special cases:
 *   - `back_in_stock` template → `back_in_stock` pref
 *   - `price_drop`    template → `price_drop` pref
 *   - `newsletter_broadcast`   → `newsletter` pref
 *   - `abandoned_cart_*`       → `abandoned_cart` pref
 *   - everything else in marketing → `marketing`
 *   - lifecycle / reviews → their own buckets
 */
export function mapTemplateToPrefCategory(
  templateKey: string,
): EmailPreferenceCategory | null {
  const spec = getTemplate(templateKey)
  if (!spec) return null
  if (isForcedSendCategory(spec.category)) return null

  // Template-key overrides for the sub-categories.
  if (templateKey === 'back_in_stock') return 'back_in_stock'
  if (templateKey === 'price_drop') return 'price_drop'
  if (templateKey === 'newsletter_broadcast') return 'newsletter'
  if (templateKey.startsWith('abandoned_cart') || templateKey === 'abandoned_checkout_recovery') {
    return 'abandoned_cart'
  }

  // Default: bucket by the template's own category.
  switch (spec.category) {
    case 'marketing':
      return 'marketing'
    case 'lifecycle':
      return 'lifecycle'
    case 'reviews':
      return 'reviews'
    default:
      // transactional / ops / platform / legal are handled above by
      // isForcedSendCategory. This branch shouldn't be reachable; we
      // return null so a misclassified future template fails-closed
      // to "send anyway" rather than silently dropping.
      return null
  }
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** Generate a fresh 32-byte hex token (64 chars). */
export function generateUnsubscribeToken(): string {
  return randomBytes(32).toString('hex')
}

/** SHA-256 of the raw token, hex-encoded. Stored in `unsubscribe_token_hash`. */
export function hashUnsubscribeToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

// ---------------------------------------------------------------------------
// canSend() gate
// ---------------------------------------------------------------------------

export interface CanSendInput {
  templateKey: string
  /** null for platform-level (accounts.gbox.co) emails. */
  shopId: string | null
  recipientEmail: string
}

export type CanSendReason =
  | 'allowed'                    // send it
  | 'forced'                     // transactional / ops / platform / legal
  | 'unknown_template'           // registry miss — fail closed (don't send)
  | 'unsubscribed'               // preferences row has subscribed=false
  | 'suppressed'                 // hard-bounce / complaint block (PR4 territory)
  | 'frequency_capped'           // PR1.5: over max_per_day / max_per_week
  | 'quiet_hours'                // PR1.5: inside recipient's quiet window

export interface CanSendResult {
  allowed: boolean
  reason: CanSendReason
  /** The preference row id, if we looked one up. */
  preferenceId: string | null
}

/**
 * Central "should we send?" check. Callers SHOULD call this and only
 * actually send when `allowed=true`. When `allowed=false` the caller
 * should log a `skipped_pref` delivery row so ops can still see intent.
 *
 * Behaviour:
 *   - Unknown template → BLOCK. This is defensive: if a future caller
 *     passes a template_key that isn't in the registry, we'd rather
 *     drop the send than spray with no audit trail.
 *   - Forced-send category → ALLOW (no DB hit).
 *   - No preference row exists → ALLOW (default opt-in). We only
 *     create rows when the customer explicitly unsubscribes or is
 *     asked to confirm (double-opt-in flows) — this keeps the table
 *     small and matches Shopify's behaviour.
 *   - Preference row with subscribed=false → BLOCK.
 *   - PR1.5: frequency cap — when row has max_per_day / max_per_week
 *     set, count sends in the last 24h / 7d from `email_deliveries`
 *     and block if at the cap.
 *   - PR1.5: quiet hours — when row has quiet_hours_start + _end set,
 *     check current time against the window and block if inside.
 *     Block returns `reason='quiet_hours'` so the caller can decide
 *     to defer vs drop.
 */
export async function canSend(
  db: Kysely<Database>,
  input: CanSendInput,
): Promise<CanSendResult> {
  const spec = getTemplate(input.templateKey)
  if (!spec) {
    return { allowed: false, reason: 'unknown_template', preferenceId: null }
  }

  const prefCat = mapTemplateToPrefCategory(input.templateKey)
  if (prefCat === null) {
    // Forced-send (transactional / ops / platform / legal).
    return { allowed: true, reason: 'forced', preferenceId: null }
  }

  // Look up by lower(email) — matches the partial UNIQUE index in
  // migration 083 so the index actually gets used.
  const lowerEmail = input.recipientEmail.trim().toLowerCase()

  let query = db
    .selectFrom('email_preferences')
    .select([
      'id',
      'subscribed',
      'max_per_day',
      'max_per_week',
      'quiet_hours_start',
      'quiet_hours_end',
      'quiet_hours_timezone',
    ])
    .where('category', '=', prefCat)
    // Kysely: reference `lower(email)` — postgres handles the partial
    // index match. We coerce to lower here so non-normalized callers
    // still hit.
    .where((eb) => eb.fn<string>('lower', ['email']), '=', lowerEmail)

  if (input.shopId === null) {
    query = query.where('shop_id', 'is', null)
  } else {
    query = query.where('shop_id', '=', input.shopId)
  }

  const row = await query.executeTakeFirst()

  if (!row) {
    // Default opt-in — no row means "never changed from the default".
    return { allowed: true, reason: 'allowed', preferenceId: null }
  }

  if (row.subscribed === false) {
    return { allowed: false, reason: 'unsubscribed', preferenceId: row.id }
  }

  // ---- PR1.5 — quiet hours check ----
  // Both columns must be set; if one is NULL we treat as "not configured"
  // (matches the migration's defensive policy).
  if (row.quiet_hours_start && row.quiet_hours_end) {
    const tz = row.quiet_hours_timezone ?? 'UTC'
    if (isInsideQuietHours(new Date(), row.quiet_hours_start, row.quiet_hours_end, tz)) {
      return { allowed: false, reason: 'quiet_hours', preferenceId: row.id }
    }
  }

  // ---- PR1.5 — frequency cap check ----
  // Count successful sends in the relevant window. We count ONLY
  // `status='sent'` rows (retries that failed don't count against the
  // cap). Per-category bucket keeps "1 marketing/day" separate from
  // "1 lifecycle/day".
  if (row.max_per_day != null || row.max_per_week != null) {
    const since = new Date()
    since.setDate(since.getDate() - 7) // 7d window covers both checks

    let countQuery = db
      .selectFrom('email_deliveries as d')
      .innerJoin('email_template_registry as r', 'r.template_key', 'd.template_key')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .select((eb) => eb.fn.max('d.created_at').as('last_created_at'))
      .where('d.status', '=', 'sent')
      .where((eb) => eb.fn<string>('lower', ['d.recipient_email']), '=', lowerEmail)
      .where('d.created_at', '>=', since.toISOString())
      .where((eb) =>
        // Count non-forced-send sends only: marketing / lifecycle / reviews.
        // These are the three template categories that map to the pref
        // buckets we actually cap (newsletter/abandoned_cart/back_in_stock/
        // price_drop all live under template.category='marketing' or
        // 'lifecycle'). A conservative over-count (cap sooner) is fine
        // — the customer asked for a cap. A later PR can denormalise
        // pref_category onto deliveries for exact per-bucket accounting.
        eb.or([
          eb('r.category', '=', 'marketing'),
          eb('r.category', '=', 'lifecycle'),
          eb('r.category', '=', 'reviews'),
        ]),
      )
    if (input.shopId === null) {
      countQuery = countQuery.where('d.shop_id', 'is', null)
    } else {
      countQuery = countQuery.where('d.shop_id', '=', input.shopId)
    }

    const stats = await countQuery.executeTakeFirst()
    if (stats) {
      const totalInWeek = Number(stats.count ?? 0)
      if (row.max_per_week != null && totalInWeek >= row.max_per_week) {
        return { allowed: false, reason: 'frequency_capped', preferenceId: row.id }
      }
      if (row.max_per_day != null) {
        // Narrow the already-joined set by issuing a second (cheaper) count
        // scoped to the last 24h. We could do this in one query with two
        // COUNT expressions + FILTER but Kysely's ergonomics for filter
        // counts aren't worth the complexity.
        const dayAgo = new Date()
        dayAgo.setDate(dayAgo.getDate() - 1)
        let dayQuery = db
          .selectFrom('email_deliveries as d')
          .innerJoin('email_template_registry as r', 'r.template_key', 'd.template_key')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('d.status', '=', 'sent')
          .where((eb) => eb.fn<string>('lower', ['d.recipient_email']), '=', lowerEmail)
          .where('d.created_at', '>=', dayAgo.toISOString())
          .where((eb) =>
            eb.or([
              eb('r.category', '=', 'marketing'),
              eb('r.category', '=', 'lifecycle'),
              eb('r.category', '=', 'reviews'),
            ]),
          )
        if (input.shopId === null) {
          dayQuery = dayQuery.where('d.shop_id', 'is', null)
        } else {
          dayQuery = dayQuery.where('d.shop_id', '=', input.shopId)
        }
        const dayStats = await dayQuery.executeTakeFirst()
        const totalInDay = Number(dayStats?.count ?? 0)
        if (totalInDay >= row.max_per_day) {
          return { allowed: false, reason: 'frequency_capped', preferenceId: row.id }
        }
      }
    }
  }

  return { allowed: true, reason: 'allowed', preferenceId: row.id }
}

// ---------------------------------------------------------------------------
// Quiet-hours helper
// ---------------------------------------------------------------------------

/**
 * Return true if `now` falls inside the quiet-hours window expressed
 * in `tz` (IANA name). Handles window-crosses-midnight correctly:
 *   start=22:00 end=08:00 → quiet between 22:00 and 08:00 next day
 *   start=10:00 end=18:00 → quiet between 10:00 and 18:00 same day
 *
 * We rely on `Intl.DateTimeFormat` with the user-supplied zone to get
 * the local hour/minute. Bad zone names fall back to UTC (the
 * `Intl.DateTimeFormat` constructor throws for invalid zones, which
 * we catch — callers shouldn't see a crash because a stored zone
 * went stale).
 */
export function isInsideQuietHours(
  now: Date,
  startTime: string,   // 'HH:MM:SS' from postgres TIME
  endTime: string,     // 'HH:MM:SS'
  tz: string,          // IANA or 'UTC'
): boolean {
  const start = parseHHMMSS(startTime)
  const end = parseHHMMSS(endTime)
  if (start === null || end === null) return false

  // Extract hour+minute+second in the recipient's timezone.
  let localMinutes: number
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const parts = fmt.formatToParts(now)
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
    const ss = Number(parts.find((p) => p.type === 'second')?.value ?? '0')
    // Intl returns 24 for midnight when hour12=false. Normalise.
    localMinutes = ((hh === 24 ? 0 : hh) * 60 * 60 + mm * 60 + ss)
  } catch {
    // Bad TZ name — fall back to UTC.
    localMinutes = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()
  }

  if (start === end) {
    // Degenerate: zero-length window. Treat as "no quiet hours".
    return false
  }

  if (start < end) {
    // Same-day window: start <= now < end.
    return localMinutes >= start && localMinutes < end
  }
  // Wraps midnight: quiet from start→24:00 OR 00:00→end.
  return localMinutes >= start || localMinutes < end
}

function parseHHMMSS(s: string): number | null {
  // Postgres TIME comes back as 'HH:MM:SS' or 'HH:MM:SS.ffffff'.
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = m[3] ? Number(m[3]) : 0
  if (h < 0 || h > 24 || min < 0 || min > 59 || sec < 0 || sec > 59) return null
  return h * 3600 + min * 60 + sec
}

// ---------------------------------------------------------------------------
// Upsert + unsubscribe + resubscribe
// ---------------------------------------------------------------------------

export interface UpsertPrefInput {
  shopId: string | null
  email: string
  category: EmailPreferenceCategory
  subscribed: boolean
  source: EmailPreferenceSource
  customerId?: string | null
}

/**
 * INSERT-or-UPDATE a preference row. If the row exists, we update
 * `subscribed` + `unsubscribed_at` + `source` + `customer_id` (keep
 * existing customer_id if the upsert doesn't pass one).
 *
 * Returns the preference row's id. Also returns the raw unsubscribe
 * token IF we created a new row — the caller is responsible for
 * including it in the outbound email footer. On UPDATE we DON'T
 * rotate the token (the old one still works, which matches Shopify).
 */
export async function upsertPreference(
  db: Kysely<Database>,
  input: UpsertPrefInput,
): Promise<{ id: string; rawToken: string | null; inserted: boolean }> {
  const lowerEmail = input.email.trim().toLowerCase()

  // Find existing row (matches the partial-unique index).
  let query = db
    .selectFrom('email_preferences')
    .select(['id'])
    .where('category', '=', input.category)
    .where((eb) => eb.fn<string>('lower', ['email']), '=', lowerEmail)
  if (input.shopId === null) {
    query = query.where('shop_id', 'is', null)
  } else {
    query = query.where('shop_id', '=', input.shopId)
  }
  const existing = await query.executeTakeFirst()

  if (existing) {
    await db
      .updateTable('email_preferences')
      .set({
        subscribed: input.subscribed,
        unsubscribed_at: input.subscribed ? null : new Date().toISOString(),
        source: input.source,
        ...(input.customerId !== undefined ? { customer_id: input.customerId } : {}),
      })
      .where('id', '=', existing.id)
      .execute()
    return { id: existing.id, rawToken: null, inserted: false }
  }

  // Fresh row — mint a token.
  const rawToken = generateUnsubscribeToken()
  const tokenHash = hashUnsubscribeToken(rawToken)

  const inserted = await db
    .insertInto('email_preferences')
    .values({
      shop_id: input.shopId,
      customer_id: input.customerId ?? null,
      email: input.email.trim(),
      category: input.category,
      subscribed: input.subscribed,
      unsubscribe_token_hash: tokenHash,
      source: input.source,
      unsubscribed_at: input.subscribed ? null : new Date().toISOString(),
    })
    .returning(['id'])
    .executeTakeFirstOrThrow()

  return { id: inserted.id, rawToken, inserted: true }
}

/** Flip `subscribed=false` for the row identified by raw token. */
export async function unsubscribeByToken(
  db: Kysely<Database>,
  rawToken: string,
): Promise<{ found: boolean; preferenceId: string | null; email: string | null; category: EmailPreferenceCategory | null }> {
  const hash = hashUnsubscribeToken(rawToken)
  const row = await db
    .selectFrom('email_preferences')
    .select(['id', 'email', 'category', 'subscribed'])
    .where('unsubscribe_token_hash', '=', hash)
    .executeTakeFirst()
  if (!row) return { found: false, preferenceId: null, email: null, category: null }

  if (row.subscribed !== false) {
    await db
      .updateTable('email_preferences')
      .set({
        subscribed: false,
        unsubscribed_at: new Date().toISOString(),
        source: 'footer_optout',
      })
      .where('id', '=', row.id)
      .execute()
  }

  return {
    found: true,
    preferenceId: row.id,
    email: row.email,
    category: row.category,
  }
}

/**
 * Resubscribe (user changes their mind). Safe to call even if already
 * subscribed — it's a no-op in that case.
 */
export async function resubscribeByToken(
  db: Kysely<Database>,
  rawToken: string,
): Promise<{ found: boolean; preferenceId: string | null }> {
  const hash = hashUnsubscribeToken(rawToken)
  const row = await db
    .selectFrom('email_preferences')
    .select(['id', 'subscribed'])
    .where('unsubscribe_token_hash', '=', hash)
    .executeTakeFirst()
  if (!row) return { found: false, preferenceId: null }

  if (row.subscribed !== true) {
    await db
      .updateTable('email_preferences')
      .set({
        subscribed: true,
        unsubscribed_at: null,
        source: 'api',
        subscribed_at: new Date().toISOString(),
      })
      .where('id', '=', row.id)
      .execute()
  }

  return { found: true, preferenceId: row.id }
}

// ---------------------------------------------------------------------------
// Build unsubscribe URL
// ---------------------------------------------------------------------------

/**
 * Compose the public unsubscribe link that goes into the email footer.
 * Base URL comes from `EMAIL_UNSUBSCRIBE_BASE_URL` (preferred) or
 * `ACCOUNTS_BASE_URL` or the hard default.
 *
 * The endpoint lives at /accounts/unsubscribe?token=… — see
 * apps/accounts/src/pages/unsubscribe.ts (later in PR1).
 */
export function buildUnsubscribeUrl(rawToken: string): string {
  const base =
    process.env.EMAIL_UNSUBSCRIBE_BASE_URL?.trim() ||
    process.env.ACCOUNTS_BASE_URL?.trim() ||
    'https://accounts.gbox.co'
  // Strip trailing slash to avoid //unsubscribe.
  const cleaned = base.replace(/\/+$/, '')
  return `${cleaned}/accounts/unsubscribe?token=${encodeURIComponent(rawToken)}`
}

/**
 * Compose the public "Manage preferences" link — the preference-center
 * companion to `buildUnsubscribeUrl`. Uses the same env + token, just a
 * different path. Shipped in PR1.5 so marketing/lifecycle/reviews
 * footers can offer finer-grained control than a one-click unsub.
 */
export function buildPreferenceCenterUrl(rawToken: string): string {
  const base =
    process.env.EMAIL_UNSUBSCRIBE_BASE_URL?.trim() ||
    process.env.ACCOUNTS_BASE_URL?.trim() ||
    'https://accounts.gbox.co'
  const cleaned = base.replace(/\/+$/, '')
  return `${cleaned}/accounts/email-preferences?token=${encodeURIComponent(rawToken)}`
}

/**
 * Small convenience — mark an existing row's `last_email_sent_at`. Used
 * by `delivery-log.ts` right after a successful send so frequency-cap
 * cron jobs can query "when did we last hit this recipient?".
 */
export async function touchLastSent(
  db: Kysely<Database>,
  preferenceId: string,
): Promise<void> {
  await db
    .updateTable('email_preferences')
    .set({ last_email_sent_at: new Date().toISOString() })
    .where('id', '=', preferenceId)
    .execute()
}

// ---------------------------------------------------------------------------
// Preference center (PR1.5 — customer-facing)
// ---------------------------------------------------------------------------
//
// The preference center lives at accounts.gbox.co/accounts/email-preferences
// ?token=<raw>. The token resolves to ONE preference row (the one that
// sent the email with the link in its footer), but the page shows the
// full constellation of rows for that (shop, email) pair so the
// recipient can opt out of multiple categories at once. We identify
// that pair from the token's row, then fan out to list all sibling
// rows.

export interface PreferenceCenterPrefRow {
  id: string
  category: EmailPreferenceCategory
  subscribed: boolean
  max_per_day: number | null
  max_per_week: number | null
  quiet_hours_start: string | null
  quiet_hours_end: string | null
  quiet_hours_timezone: string | null
  last_email_sent_at: string | null
}

export interface PreferenceCenterView {
  found: boolean
  email: string | null
  shopId: string | null
  /** The single row the token points at — used to validate tokens + as UI focus. */
  focusedCategory: EmailPreferenceCategory | null
  /** All rows for (shop, email) so the customer can opt out of everything at once. */
  preferences: PreferenceCenterPrefRow[]
}

/**
 * Resolve a raw token → preference-center view. Used by
 * GET /accounts/email-preferences?token=X. Returns `found: false` on
 * any token mismatch; the page then renders the generic "we couldn't
 * find your preferences" copy (same fail-closed leak-free pattern as
 * /accounts/unsubscribe).
 */
export async function getPreferenceCenterView(
  db: Kysely<Database>,
  rawToken: string,
): Promise<PreferenceCenterView> {
  const hash = hashUnsubscribeToken(rawToken)
  const anchor = await db
    .selectFrom('email_preferences')
    .select(['id', 'shop_id', 'email', 'category'])
    .where('unsubscribe_token_hash', '=', hash)
    .executeTakeFirst()

  if (!anchor) {
    return {
      found: false,
      email: null,
      shopId: null,
      focusedCategory: null,
      preferences: [],
    }
  }

  // Collect every row for (shop_id, lower(email)). We don't filter by
  // category — the point is to expose all buckets so the customer can
  // unsubscribe from multiple at once.
  const lowerEmail = anchor.email.trim().toLowerCase()
  let q = db
    .selectFrom('email_preferences')
    .select([
      'id',
      'category',
      'subscribed',
      'max_per_day',
      'max_per_week',
      'quiet_hours_start',
      'quiet_hours_end',
      'quiet_hours_timezone',
      'last_email_sent_at',
    ])
    .where((eb) => eb.fn<string>('lower', ['email']), '=', lowerEmail)
  if (anchor.shop_id === null) {
    q = q.where('shop_id', 'is', null)
  } else {
    q = q.where('shop_id', '=', anchor.shop_id)
  }
  const rows = await q.execute()

  return {
    found: true,
    email: anchor.email,
    shopId: anchor.shop_id,
    focusedCategory: anchor.category,
    preferences: rows.map((r) => ({
      id: r.id,
      category: r.category,
      subscribed: r.subscribed,
      max_per_day: r.max_per_day,
      max_per_week: r.max_per_week,
      quiet_hours_start: r.quiet_hours_start,
      quiet_hours_end: r.quiet_hours_end,
      quiet_hours_timezone: r.quiet_hours_timezone,
      last_email_sent_at: r.last_email_sent_at,
    })),
  }
}

export interface UpdateFrequencyCapInput {
  preferenceId: string
  maxPerDay?: number | null
  maxPerWeek?: number | null
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
  quietHoursTimezone?: string | null
}

/**
 * Update frequency-cap / quiet-hours settings for one preference row.
 * Called by POST /accounts/email-preferences. Fields omitted from the
 * input are left unchanged; explicitly passing `null` clears the cap.
 *
 * Validation is intentionally minimal here; the UI layer should
 * already have validated ranges + timezone name before calling us.
 * Bad zone names won't crash runtime (canSend falls back to UTC) but
 * they'll silently misbehave — UI is where to catch them.
 */
export async function updateFrequencyCap(
  db: Kysely<Database>,
  input: UpdateFrequencyCapInput,
): Promise<{ updated: boolean }> {
  const set: Record<string, unknown> = {}
  if (input.maxPerDay !== undefined) set.max_per_day = input.maxPerDay
  if (input.maxPerWeek !== undefined) set.max_per_week = input.maxPerWeek
  if (input.quietHoursStart !== undefined) set.quiet_hours_start = input.quietHoursStart
  if (input.quietHoursEnd !== undefined) set.quiet_hours_end = input.quietHoursEnd
  if (input.quietHoursTimezone !== undefined) set.quiet_hours_timezone = input.quietHoursTimezone

  if (Object.keys(set).length === 0) return { updated: false }

  const result = await db
    .updateTable('email_preferences')
    .set(set)
    .where('id', '=', input.preferenceId)
    .executeTakeFirst()

  return { updated: (result.numUpdatedRows ?? 0n) > 0n }
}

/**
 * Bulk-update `subscribed` per category for a (shop, email) pair via
 * raw token. Used by the preference center "Save preferences" button
 * that POSTs an array of `{category, subscribed}` toggles.
 *
 * Only rows that already exist for the (shop, email) pair are updated
 * — the preference center UI should only ever toggle categories the
 * view returned in the first place. Returns the count of rows that
 * actually changed state.
 */
export async function bulkUpdateSubscriptionsByToken(
  db: Kysely<Database>,
  rawToken: string,
  updates: Array<{ category: EmailPreferenceCategory; subscribed: boolean }>,
): Promise<{ found: boolean; changed: number }> {
  const hash = hashUnsubscribeToken(rawToken)
  const anchor = await db
    .selectFrom('email_preferences')
    .select(['shop_id', 'email'])
    .where('unsubscribe_token_hash', '=', hash)
    .executeTakeFirst()
  if (!anchor) return { found: false, changed: 0 }

  const lowerEmail = anchor.email.trim().toLowerCase()
  const now = new Date().toISOString()
  let changed = 0

  for (const u of updates) {
    let q = db
      .updateTable('email_preferences')
      .set({
        subscribed: u.subscribed,
        unsubscribed_at: u.subscribed ? null : now,
        source: 'footer_optout',
      })
      .where('category', '=', u.category)
      .where((eb) => eb.fn<string>('lower', ['email']), '=', lowerEmail)
    if (anchor.shop_id === null) {
      q = q.where('shop_id', 'is', null)
    } else {
      q = q.where('shop_id', '=', anchor.shop_id)
    }
    const r = await q.executeTakeFirst()
    changed += Number(r.numUpdatedRows ?? 0n)
  }

  return { found: true, changed }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
// Callers outside this module commonly need the template category enum
// to decide UI labels — re-export so they don't have to import from
// the db package.
export type { EmailPreferenceCategory, EmailTemplateCategory }
