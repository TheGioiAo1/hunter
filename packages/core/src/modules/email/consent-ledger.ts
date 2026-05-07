/**
 * Gbox Platform — Consent ledger (Phase 14 PR5)
 *
 * Append-only evidence store for GDPR Art. 7(1) demonstrability:
 * every opt-in, opt-out, renew, or implicit-opt-in writes a row to
 * `consent_events`. Never updated; never deleted. Each customer's
 * consent history is a chronological stream — the "current" state is
 * the latest row for the (shop, email, consent_type) triple.
 *
 * WHAT WE STORE
 * -------------
 *   - shop_id / customer_id / email_address_lower — who
 *   - consent_type ('marketing' | 'transactional' | 'analytics' | 'all')
 *   - action ('opt_in' | 'opt_out' | 'renew' | 'implicit_opt_in')
 *   - source ('checkout' | 'account_signup' | 'preference_center' | ...)
 *   - source_url (URL where the action happened)
 *   - ip_hash (sha256(ip + EMAIL_TRACKING_IP_SALT)) — never raw IP
 *   - user_agent_family (family-only, no version) — via userAgentFamily()
 *   - actor_user_id (the merchant staff who applied it, if any)
 *   - actor_role ('customer' | 'staff' | 'system' | 'import')
 *   - metadata (JSONB; PII-hygiene enforced below)
 *
 * PII HYGIENE
 * -----------
 * `metadata` is a JSONB free-form field for extras like "referrer
 * header" or "import batch id". It MUST NOT contain raw emails,
 * names, phone numbers, or addresses — those belong in dedicated
 * columns. `recordConsent()` rejects keys matching /email|phone|
 * address|name$/i at write time so a developer notices in smoke
 * tests rather than in a GDPR audit.
 *
 * IP HASHING
 * ----------
 * Mirrors `hashIp()` from tracking-recorder.ts but re-implemented
 * locally so rotating `EMAIL_TRACKING_IP_SALT` (via PR5 salt rotation)
 * affects both surfaces consistently. If the salt is missing, we
 * store NULL rather than use an insecure default — explicit test
 * guard asserts this.
 *
 * IRON RULE 5
 * -----------
 * No user-facing strings returned. Consumers compose their own copy.
 */

import crypto from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import { userAgentFamily, type UserAgentFamily } from './user-agent-family.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsentType = 'marketing' | 'transactional' | 'analytics' | 'all'
export type ConsentAction = 'opt_in' | 'opt_out' | 'renew' | 'implicit_opt_in'
export type ActorRole = 'customer' | 'staff' | 'system' | 'import'

export interface RecordConsentInput {
  shopId: string
  customerId?: string | null
  email: string                       // raw, lowercased internally
  consentType: ConsentType
  action: ConsentAction
  source: string                      // 'checkout' | 'account_signup' | ...
  sourceUrl?: string | null
  ip?: string | null                  // raw IP, hashed internally
  userAgent?: string | null           // raw UA header, reduced to family
  actorUserId?: string | null
  actorRole: ActorRole
  metadata?: Record<string, unknown>  // PII-hygiene enforced below
}

export type RecordConsentResult =
  | { ok: true; id: number; recordedAt: Date }
  | { ok: false; reason: 'invalid_metadata' | 'invalid_email' | 'db_error'; error: string }

export interface ConsentEventRow {
  id: number
  shopId: string
  customerId: string | null
  emailAddressLower: string
  consentType: ConsentType
  action: ConsentAction
  source: string
  sourceUrl: string | null
  ipHash: string | null
  userAgentFamily: UserAgentFamily | null
  actorUserId: string | null
  actorRole: ActorRole
  recordedAt: Date | string
  metadata: Record<string, unknown>
}

export interface ListConsentEventsInput {
  shopId: string
  email?: string
  customerId?: string
  consentType?: ConsentType
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

const DEFAULT_TRACKING_SALT = 'gbox-dev-ip-salt-insecure'

/**
 * Keys forbidden in `metadata` because they'd indicate PII leaking
 * into the free-form JSONB. Matched as a regex suffix or contains
 * check — `user_email`, `primary_phone`, `last_name`, `address1`
 * all trip the guard.
 */
const PII_KEY_PATTERN = /(^|_)(email|phone|address|name)(\d*$|$)/i

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function hashIpWithCurrentSalt(ip: string | null | undefined): string | null {
  if (!ip) return null
  // Mirror `hashIp()` from tracking-recorder.ts but purposely DON'T
  // fall back to EMAIL_TRACKING_SECRET — consent ledger is a legal
  // surface, and we want the salt rotation audit to be authoritative.
  // If the salt is missing, return null (store NO ip_hash) rather
  // than a weak default that would correlate across rotations.
  const salt = process.env.EMAIL_TRACKING_IP_SALT
  if (!salt) {
    // Intentional: null hash instead of a weak dev fallback. The
    // consent row is still written; just without an IP signal.
    return null
  }
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex')
}

/**
 * For testing only — same shape as hashIpWithCurrentSalt but uses
 * the dev fallback if `EMAIL_TRACKING_IP_SALT` isn't set. Not
 * exported from the public barrel; used only by smoke scripts that
 * need deterministic hashes.
 */
export function hashIpWithSaltForTest(ip: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex')
}

/**
 * Reject `metadata` keys that look like PII columns. Returns a list
 * of offending keys for the caller to report. Empty array means clean.
 */
export function detectPIIKeys(metadata: Record<string, unknown> | null | undefined): string[] {
  if (!metadata) return []
  const offenders: string[] = []
  const walk = (obj: unknown, path: string[]): void => {
    if (obj === null || typeof obj !== 'object') return
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (PII_KEY_PATTERN.test(key)) {
        offenders.push([...path, key].join('.'))
      }
      if (value !== null && typeof value === 'object') {
        walk(value, [...path, key])
      }
    }
  }
  walk(metadata, [])
  return offenders
}

function normaliseLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

function normaliseOffset(offset: number | undefined): number {
  if (offset == null || !Number.isFinite(offset) || offset < 0) return 0
  return Math.floor(offset)
}

function isValidEmail(email: string): boolean {
  // Intentionally lenient: we're storing an address the customer
  // already interacted with, not validating a signup form. A basic
  // shape check avoids inserting obvious garbage (empty strings,
  // pure whitespace, no @).
  if (typeof email !== 'string') return false
  const trimmed = email.trim()
  if (trimmed.length === 0 || trimmed.length > 320) return false
  return /@/.test(trimmed)
}

function rowToConsentEvent(row: any): ConsentEventRow {
  return {
    id: Number(row.id),
    shopId: row.shop_id,
    customerId: row.customer_id,
    emailAddressLower: row.email_address_lower,
    consentType: row.consent_type as ConsentType,
    action: row.action as ConsentAction,
    source: row.source,
    sourceUrl: row.source_url,
    ipHash: row.ip_hash,
    userAgentFamily: row.user_agent_family as UserAgentFamily | null,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role as ActorRole,
    recordedAt: row.recorded_at,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------------------
// recordConsent — primary write path
// ---------------------------------------------------------------------------

export async function recordConsent(
  db: Kysely<Database>,
  input: RecordConsentInput,
): Promise<RecordConsentResult> {
  // Validate metadata BEFORE touching the DB
  const offenders = detectPIIKeys(input.metadata)
  if (offenders.length > 0) {
    return {
      ok: false,
      reason: 'invalid_metadata',
      error: `metadata contains PII-looking keys: ${offenders.join(', ')}`,
    }
  }

  if (!isValidEmail(input.email)) {
    return { ok: false, reason: 'invalid_email', error: 'email must be a non-empty string containing "@"' }
  }

  const emailLower = input.email.trim().toLowerCase()
  const ipHash = hashIpWithCurrentSalt(input.ip ?? null)
  const uaFamily = userAgentFamily(input.userAgent)

  try {
    const row = await db
      .insertInto('consent_events')
      .values({
        shop_id: input.shopId,
        customer_id: input.customerId ?? null,
        email_address_lower: emailLower,
        consent_type: input.consentType,
        action: input.action,
        source: input.source,
        source_url: input.sourceUrl ?? null,
        ip_hash: ipHash,
        user_agent_family: uaFamily,
        actor_user_id: input.actorUserId ?? null,
        actor_role: input.actorRole,
        metadata: JSON.stringify(input.metadata ?? {}) as any,
      } as any)
      .returning(['id', 'recorded_at'])
      .executeTakeFirst()

    if (!row) {
      return { ok: false, reason: 'db_error', error: 'insert returned no row' }
    }

    return {
      ok: true,
      id: Number(row.id),
      recordedAt: (row.recorded_at as unknown) instanceof Date
        ? (row.recorded_at as unknown as Date)
        : new Date(String(row.recorded_at)),
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'db_error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// listConsentEvents — paginated read
// ---------------------------------------------------------------------------

export async function listConsentEvents(
  db: Kysely<Database>,
  input: ListConsentEventsInput,
): Promise<ConsentEventRow[]> {
  const limit = normaliseLimit(input.limit)
  const offset = normaliseOffset(input.offset)

  let query = db
    .selectFrom('consent_events')
    .selectAll()
    .where('shop_id', '=', input.shopId)
    .orderBy('recorded_at', 'desc')
    .limit(limit)
    .offset(offset)

  if (input.email) {
    query = query.where('email_address_lower', '=', input.email.trim().toLowerCase())
  }
  if (input.customerId) {
    query = query.where('customer_id', '=', input.customerId)
  }
  if (input.consentType) {
    query = query.where('consent_type', '=', input.consentType)
  }

  const rows = await query.execute()
  return rows.map(rowToConsentEvent)
}

// ---------------------------------------------------------------------------
// latestConsentFor — "what's the current state?"
// ---------------------------------------------------------------------------

/**
 * Return the most recent consent event for this (shop, email, type)
 * triple, or null if no events exist. The caller can inspect
 * `.action` to decide current state (opt_in/renew/implicit_opt_in =
 * currently consented; opt_out = currently withdrawn).
 */
export async function latestConsentFor(
  db: Kysely<Database>,
  params: { shopId: string; email: string; consentType: ConsentType },
): Promise<ConsentEventRow | null> {
  const row = await db
    .selectFrom('consent_events')
    .selectAll()
    .where('shop_id', '=', params.shopId)
    .where('email_address_lower', '=', params.email.trim().toLowerCase())
    .where('consent_type', '=', params.consentType)
    .orderBy('recorded_at', 'desc')
    .limit(1)
    .executeTakeFirst()

  return row ? rowToConsentEvent(row) : null
}

// ---------------------------------------------------------------------------
// countConsentEvents — admin KPI helper
// ---------------------------------------------------------------------------

export async function countConsentEvents(
  db: Kysely<Database>,
  params: { shopId: string; consentType?: ConsentType; sinceDays?: number },
): Promise<number> {
  let query = db
    .selectFrom('consent_events')
    .select(db.fn.count<string>('id').as('total'))
    .where('shop_id', '=', params.shopId)

  if (params.consentType) {
    query = query.where('consent_type', '=', params.consentType)
  }

  if (params.sinceDays != null && params.sinceDays > 0) {
    const days = Math.floor(params.sinceDays)
    query = query.where('recorded_at', '>=', sql<Date>`now() - make_interval(days => ${days})` as any)
  }

  const row = await query.executeTakeFirst()
  return row ? Number(row.total) : 0
}
