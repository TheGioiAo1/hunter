/**
 * Gbox Platform — Domain Verification (Phase 6.3)
 *
 * Pure helpers for the custom-domain provisioning flow. The merchant
 * adds a domain in god-admin → we generate a random token → they
 * publish it as a DNS TXT record under `_gbox-verify.<domain>` → a
 * background job (or a manual "Verify now" button) calls
 * `verifyDomainTxt` to confirm the record is live before we hand the
 * domain to the ACME helper for SSL issuance.
 *
 * Why a separate `_gbox-verify.<domain>` subdomain instead of TXT on
 * the apex? Two reasons:
 *   1. Apex TXT is often crowded (SPF, DKIM, DMARC, Google site verify,
 *      etc.) and merchants accidentally clobber records.
 *   2. A dedicated subdomain means we can leave the verification
 *      record in place forever as a "this domain belongs to gbox"
 *      breadcrumb without polluting the apex.
 *
 * The resolver is injected so tests don't need real DNS and the
 * production caller can swap node:dns for a custom resolver (e.g.
 * Cloudflare DoH) without touching this file.
 */

import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolver contract: given a hostname, return the TXT record set as
 * an array of arrays. Each outer entry is one TXT record; each inner
 * array is the segments DNS split that record into (TXT records
 * longer than 255 bytes are chunked on the wire). This matches the
 * shape `dns/promises.resolveTxt()` returns natively.
 */
export type DnsTxtResolver = (host: string) => Promise<string[][]>

export interface VerifyDomainTxtInput {
  domain: string
  token: string
  resolver: DnsTxtResolver
}

export type VerifyDomainTxtReason =
  | 'invalid_token'
  | 'not_found'
  | 'mismatch'
  | 'lookup_error'

/**
 * Verification result. Flattened (rather than a discriminated union)
 * because the consumers — a god-admin Express handler, an audit log
 * writer, and a renewal cron — all want to read fields without first
 * narrowing on `ok`. The optional fields are populated based on which
 * branch fired:
 *
 *   ok: true                 → matchedRecord set
 *   reason: 'mismatch'       → observedRecords set
 *   reason: 'lookup_error'   → error set
 */
export interface VerifyDomainTxtResult {
  ok: boolean
  reason?: VerifyDomainTxtReason
  matchedRecord?: string
  observedRecords?: string[]
  error?: string
}

export interface VerificationInstructions {
  recordType: 'TXT'
  recordHost: string
  recordValue: string
  /** Doc link merchants can follow if their DNS provider's UI is unfamiliar. */
  helpUrl: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix on the TXT record value. Lets us distinguish our records from
 *  arbitrary text the merchant might have on the same name. */
const TXT_PREFIX = 'gbox-site-verification='

/** Subdomain we look up. Keeps the apex clean — see file header. */
const VERIFY_SUBDOMAIN = '_gbox-verify'

/** Default token length in bytes. 32 bytes → 64 hex chars → ~256 bits
 *  of entropy, which is plenty for an unguessable challenge. */
const DEFAULT_TOKEN_BYTES = 32

const HELP_URL =
  'https://docs.gbox.co/admin/domains/verify-dns-txt'

// ---------------------------------------------------------------------------
// generateVerificationToken
// ---------------------------------------------------------------------------

/**
 * Returns a random hex string suitable for use as a one-time DNS
 * verification challenge. Defaults to 32 random bytes (64 hex chars).
 */
export function generateVerificationToken(
  byteLength: number = DEFAULT_TOKEN_BYTES,
): string {
  return randomBytes(byteLength).toString('hex')
}

// ---------------------------------------------------------------------------
// expectedTxtRecord
// ---------------------------------------------------------------------------

/** Renders the full TXT value the merchant must publish. */
export function expectedTxtRecord(token: string): string {
  return `${TXT_PREFIX}${token}`
}

// ---------------------------------------------------------------------------
// buildVerificationInstructions
// ---------------------------------------------------------------------------

/**
 * Bundles the strings the god-admin UI displays in the "Add a domain"
 * wizard. Strips a trailing dot from the merchant-supplied domain so
 * the UI shows `_gbox-verify.shop.example.com` even if they pasted
 * `shop.example.com.` from a DNS export.
 */
export function buildVerificationInstructions(input: {
  domain: string
  token: string
}): VerificationInstructions {
  const cleanDomain = stripTrailingDot(input.domain)
  return {
    recordType: 'TXT',
    recordHost: `${VERIFY_SUBDOMAIN}.${cleanDomain}`,
    recordValue: expectedTxtRecord(input.token),
    helpUrl: HELP_URL,
  }
}

// ---------------------------------------------------------------------------
// verifyDomainTxt
// ---------------------------------------------------------------------------

/**
 * Looks up the verification TXT record for `domain` and checks
 * whether it matches the expected value derived from `token`.
 *
 * Result vocabulary (machine-readable so the renewal cron and the UI
 * can branch on it):
 *
 *   ok: true                       → record present + value matches
 *   reason: 'invalid_token'        → caller passed an empty token; we
 *                                    refuse to even hit DNS
 *   reason: 'not_found'            → resolver returned an empty list
 *                                    OR threw NXDOMAIN/ENOTFOUND
 *   reason: 'mismatch'             → records exist but none match
 *   reason: 'lookup_error'         → any other DNS failure (SERVFAIL,
 *                                    timeout, refused, …) — caller
 *                                    should retry rather than mark
 *                                    the domain unverified
 */
export async function verifyDomainTxt(
  input: VerifyDomainTxtInput,
): Promise<VerifyDomainTxtResult> {
  // Defensive: an empty token would match a stray `gbox-site-verification=`
  // record on someone else's domain. Refuse before we even hit DNS.
  if (!input.token || input.token.trim() === '') {
    return { ok: false, reason: 'invalid_token' }
  }

  const expected = expectedTxtRecord(input.token)
  const host = `${VERIFY_SUBDOMAIN}.${stripTrailingDot(input.domain)}`

  let records: string[][]
  try {
    records = await input.resolver(host)
  } catch (err) {
    // node:dns surfaces NXDOMAIN as either `ENOTFOUND` or
    // `ENODATA` depending on the resolver path. Both mean "the
    // record genuinely isn't there", which is operationally
    // distinct from "the lookup itself failed". The UI shows
    // "not found yet — DNS may still be propagating", whereas a
    // lookup_error shows "couldn't reach DNS, try again".
    const code = (err as { code?: string }).code
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { ok: false, reason: 'not_found' }
    }
    return {
      ok: false,
      reason: 'lookup_error',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (!records || records.length === 0) {
    return { ok: false, reason: 'not_found' }
  }

  // DNS chunks TXT records longer than 255 bytes into multiple
  // string segments. The canonical record is the concatenation, so
  // join each tuple before comparing.
  const flattened = records.map((segments) => segments.join(''))

  for (const record of flattened) {
    if (record === expected) {
      return { ok: true, matchedRecord: record }
    }
  }

  return { ok: false, reason: 'mismatch', observedRecords: flattened }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stripTrailingDot(domain: string): string {
  return domain.endsWith('.') ? domain.slice(0, -1) : domain
}
