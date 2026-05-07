/**
 * Gbox Platform — Custom Domain Service (Phase 6.3 / Landing Page System Phase 1A)
 *
 * CRUD + lifecycle around the `shop_domains` table. This is the "is
 * this hostname trusted for SNI + Host-header lookups" registry that
 * the storefront resolver, the checkout handoff, and the god-admin
 * SSL fleet dashboard all read from.
 *
 * The pure verification helpers live in `modules/ops/domain-verification.ts`
 * (token generator, TXT resolver contract, `verifyDomainTxt`) and the
 * pure SSL state machine lives in `modules/ops/ssl-cert.ts`
 * (`planCertAction`, `summariseSslFleet`). This module glues those
 * pure primitives to Postgres via Kysely and exposes the side-effectful
 * entry points the API routes + background workers call.
 *
 * Why split service vs. pure helpers? Two reasons:
 *
 *   1. The pure helpers are trivial to unit-test (no DB, no DNS, no
 *      HTTP). The service layer needs an in-memory Kysely or a real
 *      Postgres for its tests, which is more expensive. Keeping DB
 *      concerns isolated here means we can swap Kysely → Drizzle later
 *      without rewriting the token / verify logic.
 *   2. The storefront resolver middleware and the SSL cert planner
 *      can import the pure helpers directly and stay on Cloudflare
 *      Workers (no pg pool) if we ever move them to the edge.
 *
 * State machine (see also `VerificationStatus` below):
 *
 *   pending     → merchant added the domain, DNS not yet verified
 *     ↓ verifyPendingDomain()
 *   verified    → TXT record matched, ready for SSL provisioning
 *     ↓ markSslIssued() after Cloudflare SaaS active
 *   active      → DNS verified AND SSL issued (terminal happy state)
 *
 *   any → error (transient): lookup_error / mismatch / SSL failure —
 *         stored in `ssl_last_error`, still retried by the worker
 *   any → removed (DELETE): row deleted, Cloudflare custom hostname
 *         also torn down by the caller
 */

import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  buildVerificationInstructions,
  expectedTxtRecord,
  generateVerificationToken,
  verifyDomainTxt,
  type DnsTxtResolver,
  type VerificationInstructions,
  type VerifyDomainTxtResult,
} from '../ops/domain-verification.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The merchant-facing lifecycle of a `shop_domains` row, collapsed
 * from the (verified, ssl_provider, ssl_expires_at, ssl_last_error)
 * tuple so the admin UI can render a single badge per row.
 */
export type VerificationStatus =
  | 'pending' // not verified yet, waiting on DNS
  | 'verified' // DNS verified, SSL not provisioned yet
  | 'active' // DNS verified AND SSL live
  | 'error' // last verify/SSL attempt failed — still retried

/**
 * A row from `shop_domains` enriched with the derived
 * `verificationStatus` and ready-to-render DNS instructions. API
 * handlers return this shape verbatim so the admin UI doesn't have
 * to replicate the status-flattening logic.
 */
export interface DomainRecord {
  id: string
  shopId: string
  domain: string
  isPrimary: boolean
  verified: boolean
  verificationToken: string | null
  verificationMethod: string
  verifiedAt: Date | null
  sslProvider: string | null
  sslStatus: string | null
  sslIssuedAt: Date | null
  sslExpiresAt: Date | null
  sslLastError: string | null
  createdAt: Date
  verificationStatus: VerificationStatus
  instructions: VerificationInstructions
  // Phase 1D — self-hosted ACME provisioning (migration 014). All
  // nullable for legacy rows that were created before the migration
  // was applied.
  certPath: string | null
  certKeyPath: string | null
  certChainPath: string | null
  acmeChallengeToken: string | null
  sslLastAttemptAt: Date | null
  renewalFailures: number
  sslStaging: boolean
}

export interface AddDomainInput {
  shopId: string
  domain: string
  /** Mark as primary immediately (unsets other primaries in the same shop). */
  makePrimary?: boolean
  /** Override the default token length (used only by tests). */
  tokenBytes?: number
}

export type AddDomainErrorCode =
  | 'invalid_format'
  | 'reserved_domain'
  | 'already_exists_in_shop'
  | 'already_claimed_by_other_shop'

export interface AddDomainError {
  ok: false
  code: AddDomainErrorCode
  message: string
}

export interface AddDomainSuccess {
  ok: true
  record: DomainRecord
}

export type AddDomainResult = AddDomainSuccess | AddDomainError

export interface VerifyDomainOptions {
  resolver: DnsTxtResolver
  /** Defaults to `new Date()` — tests inject a fixed clock. */
  now?: Date
}

export type VerifyDomainError =
  | { ok: false; code: 'not_found'; message: string }
  | { ok: false; code: 'no_token'; message: string }
  | { ok: false; code: 'dns_mismatch'; message: string; observed: string[] }
  | { ok: false; code: 'dns_not_found'; message: string }
  | { ok: false; code: 'dns_lookup_error'; message: string }

export type VerifyDomainResult =
  | { ok: true; record: DomainRecord }
  | VerifyDomainError

// ---------------------------------------------------------------------------
// Validation + constants
// ---------------------------------------------------------------------------

/**
 * RFC 1123 hostname regex, same as the one the store-admin UI uses so
 * client and server agree on what counts as a valid domain. Rejects
 * single-label names (`localhost`) and anything with a port / path.
 */
const DOMAIN_REGEX =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/

/**
 * Domains we never let merchants claim. `gbox.co` subdomains are
 * covered by the wildcard cert and shouldn't be added as custom
 * domains — they're already mounted. The second list protects us
 * from merchants accidentally pointing their production DNS at a
 * staging/localhost host.
 */
const RESERVED_SUFFIXES = ['gbox.co', 'lencam.com']
const RESERVED_EXACT = new Set([
  'localhost',
  'example.com',
  'example.org',
  'example.net',
])

export function normalizeDomain(raw: string): string {
  // Lowercase, trim whitespace, and strip the trailing dot that DNS
  // exports often include (`shop.example.com.`). These two normalizations
  // are idempotent and safe to apply on the write path.
  return raw.trim().toLowerCase().replace(/\.$/, '')
}

export function isValidDomainFormat(domain: string): boolean {
  return DOMAIN_REGEX.test(domain)
}

export function isReservedDomain(domain: string): boolean {
  if (RESERVED_EXACT.has(domain)) return true
  for (const suffix of RESERVED_SUFFIXES) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Row → DomainRecord mapper
// ---------------------------------------------------------------------------

/**
 * The raw shape Kysely returns from a `selectFrom('shop_domains')`
 * with all columns. We type it permissively because different test
 * fixtures surface Date vs. string vs. null depending on driver,
 * and converting once here is cheaper than sprinkling `as` casts.
 */
interface ShopDomainRow {
  id: string
  shop_id: string
  domain: string
  is_primary: boolean | null
  ssl_status: string | null
  verified: boolean | null
  created_at: Date | string | null
  verification_token: string | null
  verification_method: string | null
  verified_at: Date | string | null
  ssl_provider: string | null
  ssl_issued_at: Date | string | null
  ssl_expires_at: Date | string | null
  ssl_last_error: string | null
  // Migration 014 — may be missing in legacy fixtures, so all optional.
  cert_path?: string | null
  cert_key_path?: string | null
  cert_chain_path?: string | null
  acme_challenge_token?: string | null
  ssl_last_attempt_at?: Date | string | null
  renewal_failures?: number | null
  ssl_staging?: boolean | null
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null
  if (value instanceof Date) return value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Flatten the DB row's (verified, ssl_provider, ssl_last_error) tuple
 * into the single `VerificationStatus` the admin UI cares about.
 *
 * Error trumps active so a stale cert with a fresh SSL failure still
 * surfaces as `error` in the UI, making the worker's retry visible
 * instead of burying it under a green "active" badge.
 */
export function deriveVerificationStatus(row: {
  verified: boolean
  sslIssuedAt: Date | null
  sslLastError: string | null
}): VerificationStatus {
  if (row.sslLastError) return 'error'
  if (row.verified && row.sslIssuedAt) return 'active'
  if (row.verified) return 'verified'
  return 'pending'
}

export function mapRowToRecord(row: ShopDomainRow): DomainRecord {
  const verified = row.verified === true
  const sslIssuedAt = toDate(row.ssl_issued_at)
  const sslLastError = row.ssl_last_error ?? null

  const token = row.verification_token ?? ''
  const instructions = buildVerificationInstructions({
    domain: row.domain,
    token,
  })

  return {
    id: row.id,
    shopId: row.shop_id,
    domain: row.domain,
    isPrimary: row.is_primary === true,
    verified,
    verificationToken: row.verification_token,
    verificationMethod: row.verification_method ?? 'txt',
    verifiedAt: toDate(row.verified_at),
    sslProvider: row.ssl_provider,
    sslStatus: row.ssl_status,
    sslIssuedAt,
    sslExpiresAt: toDate(row.ssl_expires_at),
    sslLastError,
    createdAt: toDate(row.created_at) ?? new Date(0),
    verificationStatus: deriveVerificationStatus({
      verified,
      sslIssuedAt,
      sslLastError,
    }),
    instructions,
    certPath: row.cert_path ?? null,
    certKeyPath: row.cert_key_path ?? null,
    certChainPath: row.cert_chain_path ?? null,
    acmeChallengeToken: row.acme_challenge_token ?? null,
    sslLastAttemptAt: toDate(row.ssl_last_attempt_at ?? null),
    renewalFailures: typeof row.renewal_failures === 'number' ? row.renewal_failures : 0,
    sslStaging: row.ssl_staging === true,
  }
}

// ---------------------------------------------------------------------------
// addDomain
// ---------------------------------------------------------------------------

/**
 * Register a new custom domain for a shop. Generates the verification
 * token, inserts the row, and returns the `DomainRecord` including the
 * DNS instructions the merchant needs to paste into their registrar.
 *
 * Idempotency: if the merchant adds the same (shop_id, domain) twice,
 * we return `already_exists_in_shop` rather than the existing record
 * — the API handler can then decide whether to look the existing row
 * up and return it, vs. surface a "you already added this" error.
 * Choosing the loud path here keeps the create flow deterministic.
 *
 * Primary flag handling: `makePrimary` unsets any other primary row
 * in the same shop atomically (in the same transaction) before flagging
 * the new row. Shops must have at most one primary at a time.
 */
export async function addDomain(
  db: Kysely<Database>,
  input: AddDomainInput,
): Promise<AddDomainResult> {
  const domain = normalizeDomain(input.domain)

  if (!isValidDomainFormat(domain)) {
    return {
      ok: false,
      code: 'invalid_format',
      message: `"${domain}" is not a valid hostname`,
    }
  }

  if (isReservedDomain(domain)) {
    return {
      ok: false,
      code: 'reserved_domain',
      message: `"${domain}" is reserved and cannot be used as a custom domain`,
    }
  }

  // Same domain in same shop? Reject loudly.
  const existingInShop = await db
    .selectFrom('shop_domains')
    .select(['id'])
    .where('shop_id', '=', input.shopId)
    .where('domain', '=', domain)
    .executeTakeFirst()

  if (existingInShop) {
    return {
      ok: false,
      code: 'already_exists_in_shop',
      message: `"${domain}" is already linked to this store`,
    }
  }

  // Same domain in ANY other shop? Reject — hostnames must be globally
  // unique across the platform or the storefront resolver won't know
  // which shop to route the Host header to.
  const existingAnywhere = await db
    .selectFrom('shop_domains')
    .select(['id', 'shop_id'])
    .where('domain', '=', domain)
    .executeTakeFirst()

  if (existingAnywhere) {
    return {
      ok: false,
      code: 'already_claimed_by_other_shop',
      message: `"${domain}" is already claimed by another store`,
    }
  }

  const token = generateVerificationToken(input.tokenBytes)
  const id = randomUUID()
  const now = new Date()

  await db.transaction().execute(async (trx) => {
    if (input.makePrimary) {
      await trx
        .updateTable('shop_domains')
        .set({ is_primary: false })
        .where('shop_id', '=', input.shopId)
        .where('is_primary', '=', true)
        .execute()
    }

    await trx
      .insertInto('shop_domains')
      .values({
        id,
        shop_id: input.shopId,
        domain,
        is_primary: input.makePrimary === true,
        verified: false,
        verification_token: token,
        verification_method: 'txt',
        created_at: now,
      } as any)
      .execute()
  })

  const row = await db
    .selectFrom('shop_domains')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

  return { ok: true, record: mapRowToRecord(row as unknown as ShopDomainRow) }
}

// ---------------------------------------------------------------------------
// listDomains
// ---------------------------------------------------------------------------

export async function listDomains(
  db: Kysely<Database>,
  shopId: string,
): Promise<DomainRecord[]> {
  const rows = await db
    .selectFrom('shop_domains')
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('is_primary', 'desc')
    .orderBy('created_at', 'asc')
    .execute()

  return rows.map((r) => mapRowToRecord(r as unknown as ShopDomainRow))
}

export async function getDomainById(
  db: Kysely<Database>,
  shopId: string,
  domainId: string,
): Promise<DomainRecord | null> {
  const row = await db
    .selectFrom('shop_domains')
    .selectAll()
    .where('id', '=', domainId)
    .where('shop_id', '=', shopId)
    .executeTakeFirst()

  if (!row) return null
  return mapRowToRecord(row as unknown as ShopDomainRow)
}

export async function getDomainByHostname(
  db: Kysely<Database>,
  hostname: string,
): Promise<DomainRecord | null> {
  const row = await db
    .selectFrom('shop_domains')
    .selectAll()
    .where('domain', '=', normalizeDomain(hostname))
    .executeTakeFirst()

  if (!row) return null
  return mapRowToRecord(row as unknown as ShopDomainRow)
}

// ---------------------------------------------------------------------------
// removeDomain
// ---------------------------------------------------------------------------

/**
 * Delete a `shop_domains` row. Callers MUST tear down the matching
 * nginx server block separately (see `nginx-writer.ts`
 * `removeDomainServerBlock`) — this function does not touch external
 * resources so it stays pure-Postgres and trivially testable.
 *
 * Returns the removed record so the caller can log it or use its
 * cert paths to schedule on-disk cleanup if desired.
 */
export async function removeDomain(
  db: Kysely<Database>,
  shopId: string,
  domainId: string,
): Promise<DomainRecord | null> {
  const existing = await getDomainById(db, shopId, domainId)
  if (!existing) return null

  await db
    .deleteFrom('shop_domains')
    .where('id', '=', domainId)
    .where('shop_id', '=', shopId)
    .execute()

  return existing
}

// ---------------------------------------------------------------------------
// verifyPendingDomain
// ---------------------------------------------------------------------------

/**
 * Runs the TXT lookup for a pending domain and writes the outcome to
 * the row. This is the side-effectful wrapper around `verifyDomainTxt`
 * the API "Verify now" button and the background worker both call.
 *
 * On success:
 *   - sets `verified = true`
 *   - sets `verified_at = now`
 *   - clears `ssl_last_error`
 *   - leaves SSL fields alone (the CF SaaS step runs after this)
 *
 * On failure:
 *   - leaves `verified` as-is (usually still false)
 *   - writes a human-readable string to `ssl_last_error` (re-used for
 *     verify errors too — same column, single failure surface in UI)
 *   - returns a typed error so the HTTP handler can render the right
 *     "DNS not found" / "wrong value" / "try again" message
 *
 * The resolver is injected so tests run without DNS. Production code
 * passes `dns.promises.resolveTxt` bound to the default resolver.
 */
export async function verifyPendingDomain(
  db: Kysely<Database>,
  shopId: string,
  domainId: string,
  options: VerifyDomainOptions,
): Promise<VerifyDomainResult> {
  const record = await getDomainById(db, shopId, domainId)
  if (!record) {
    return {
      ok: false,
      code: 'not_found',
      message: `Domain ${domainId} not found for shop ${shopId}`,
    }
  }

  if (!record.verificationToken) {
    // Row exists but has no token — possible if an older migration
    // backfilled rows without verification. Regenerate one so the
    // merchant can recover without manual DB surgery.
    const token = generateVerificationToken()
    await db
      .updateTable('shop_domains')
      .set({ verification_token: token } as any)
      .where('id', '=', domainId)
      .execute()
    return {
      ok: false,
      code: 'no_token',
      message:
        'Verification token was missing — regenerated. Publish the new TXT record and try again.',
    }
  }

  const dnsResult: VerifyDomainTxtResult = await verifyDomainTxt({
    domain: record.domain,
    token: record.verificationToken,
    resolver: options.resolver,
  })

  const now = options.now ?? new Date()

  if (dnsResult.ok) {
    await db
      .updateTable('shop_domains')
      .set({
        verified: true,
        verified_at: now,
        ssl_last_error: null,
      } as any)
      .where('id', '=', domainId)
      .execute()

    const updated = await getDomainById(db, shopId, domainId)
    return { ok: true, record: updated! }
  }

  // Persist the human-readable reason so the UI and the worker see
  // the same failure. We keep `verified = false` rather than setting
  // it to true on retry — the only way out of the failure state is
  // a successful lookup.
  let errorMessage = 'Unknown verification error'
  let errorCode: VerifyDomainError['code'] = 'dns_lookup_error'

  switch (dnsResult.reason) {
    case 'not_found':
      errorCode = 'dns_not_found'
      errorMessage = `TXT record not found at _gbox-verify.${record.domain}. Add the record and wait a few minutes for DNS to propagate.`
      break
    case 'mismatch':
      errorCode = 'dns_mismatch'
      errorMessage = `TXT record found but value does not match. Expected "${expectedTxtRecord(
        record.verificationToken,
      )}".`
      break
    case 'invalid_token':
      errorCode = 'no_token'
      errorMessage = 'Verification token is invalid. Please regenerate.'
      break
    case 'lookup_error':
    default:
      errorCode = 'dns_lookup_error'
      errorMessage = `DNS lookup failed: ${dnsResult.error ?? 'unknown error'}. Try again in a moment.`
      break
  }

  await db
    .updateTable('shop_domains')
    .set({ ssl_last_error: errorMessage } as any)
    .where('id', '=', domainId)
    .execute()

  if (errorCode === 'dns_mismatch') {
    return {
      ok: false,
      code: 'dns_mismatch',
      message: errorMessage,
      observed: dnsResult.observedRecords ?? [],
    }
  }
  return { ok: false, code: errorCode, message: errorMessage }
}

// ---------------------------------------------------------------------------
// setPrimaryDomain
// ---------------------------------------------------------------------------

/**
 * Promote a verified domain to primary. No-op if already primary.
 * Will reject unverified domains because pointing the storefront's
 * canonical URL at a host that might not work is a bad idea — the
 * merchant's SEO takes a hit every time the primary flips.
 */
export async function setPrimaryDomain(
  db: Kysely<Database>,
  shopId: string,
  domainId: string,
): Promise<DomainRecord | null> {
  const record = await getDomainById(db, shopId, domainId)
  if (!record) return null
  if (!record.verified) {
    throw new Error(
      `Cannot set unverified domain ${record.domain} as primary. Verify DNS first.`,
    )
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('shop_domains')
      .set({ is_primary: false })
      .where('shop_id', '=', shopId)
      .where('is_primary', '=', true)
      .execute()

    await trx
      .updateTable('shop_domains')
      .set({ is_primary: true })
      .where('id', '=', domainId)
      .execute()
  })

  return getDomainById(db, shopId, domainId)
}

// ---------------------------------------------------------------------------
// markSslIssued / markSslFailed
// ---------------------------------------------------------------------------

/**
 * Worker callback when Cloudflare SaaS reports the cert is active.
 */
export async function markSslIssued(
  db: Kysely<Database>,
  domainId: string,
  payload: {
    provider: 'cloudflare_saas' | 'letsencrypt'
    issuedAt: Date
    expiresAt: Date
    sslStatus?: string
  },
): Promise<void> {
  await db
    .updateTable('shop_domains')
    .set({
      ssl_provider: payload.provider,
      ssl_issued_at: payload.issuedAt,
      ssl_expires_at: payload.expiresAt,
      ssl_status: payload.sslStatus ?? 'active',
      ssl_last_error: null,
    } as any)
    .where('id', '=', domainId)
    .execute()
}

export async function markSslFailed(
  db: Kysely<Database>,
  domainId: string,
  errorMessage: string,
  sslStatus?: string,
): Promise<void> {
  await db
    .updateTable('shop_domains')
    .set({
      ssl_last_error: errorMessage,
      ssl_status: sslStatus ?? 'error',
    } as any)
    .where('id', '=', domainId)
    .execute()
}

// ---------------------------------------------------------------------------
// listPendingVerification / listPendingSsl
// ---------------------------------------------------------------------------

/**
 * Rows the background verifier should retry: unverified AND not
 * rejected too recently. The worker calls this every N seconds and
 * runs `verifyPendingDomain` on each.
 */
export async function listPendingVerification(
  db: Kysely<Database>,
  limit = 50,
): Promise<DomainRecord[]> {
  const rows = await db
    .selectFrom('shop_domains')
    .selectAll()
    .where('verified', '=', false)
    .orderBy('created_at', 'asc')
    .limit(limit)
    .execute()
  return rows.map((r) => mapRowToRecord(r as unknown as ShopDomainRow))
}

/**
 * Rows ready for SSL provisioning: verified but no cert yet, OR
 * verified with a failing cert retry. The worker feeds these into
 * the Cloudflare SaaS adapter's create/poll loop.
 */
export async function listPendingSsl(
  db: Kysely<Database>,
  limit = 50,
): Promise<DomainRecord[]> {
  const rows = await db
    .selectFrom('shop_domains')
    .selectAll()
    .where('verified', '=', true)
    .where('ssl_issued_at', 'is', null)
    .orderBy('verified_at', 'asc')
    .limit(limit)
    .execute()
  return rows.map((r) => mapRowToRecord(r as unknown as ShopDomainRow))
}
