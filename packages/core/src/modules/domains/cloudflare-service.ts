/**
 * Gbox Platform — Cloudflare Domain Service (Phase 2B Sprint 2)
 *
 * Replaces the Let's Encrypt + DNS TXT flow with the simpler Cloudflare
 * model. The seller points their domain at Cloudflare nameservers,
 * Cloudflare terminates SSL, and Gbox only confirms that the domain
 * is on Cloudflare and (optionally) that the DNS target matches
 * `shops.gbox.co`.
 *
 * Scope:
 *   - `addDomain`           — normalise + insert row, starts unverified.
 *   - `verifyViaCloudflare` — runs `detectCloudflare`, records the
 *                             resulting NS list + CF-proxied flag +
 *                             DNS target + last_checked_at timestamp,
 *                             and flips `verified=true` only when the
 *                             zone is confirmed on Cloudflare nameservers.
 *   - `setPrimary`          — transactionally swaps `is_primary` so
 *                             only one row per shop has it; the partial
 *                             unique index is a belt-and-suspenders
 *                             guard against concurrent writes.
 *   - `setRedirect`         — attaches `redirect_to_domain_id` (or
 *                             clears it). The target must belong to the
 *                             same shop + be verified; enforced here so
 *                             the UI doesn't have to re-check.
 *   - `removeDomain`        — DB cascade handles redirect cleanup
 *                             (ON DELETE SET NULL was chosen in the
 *                             migration for exactly this).
 *
 * SSL note: the legacy `ssl_status` / `ssl_provider` / `ssl_expires_at`
 * columns stay in the table but are no longer touched by this service.
 * Keeping them lets migration 036+ decide whether to drop or repurpose
 * them. The UI treats "verified=true on Cloudflare" as "SSL is live".
 *
 * Resolvers for `detectCloudflare` are injected by the caller so tests
 * can stub DNS without touching node:dns. The store-admin route wires
 * up `dns/promises` at call site.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import {
  detectCloudflare,
  type DetectCloudflareResult,
  type DnsNsResolver,
  type DnsCnameResolver,
  type DnsAResolver,
} from '../ops/cloudflare-detect.js'
import {
  detectARecord,
  type DetectARecordResult,
} from '../ops/a-record-detect.js'
import {
  generateVerificationToken,
} from '../ops/domain-verification.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** RFC 1035-ish domain check. Good enough for UI input; the real
 *  enforcement is the DB's unique index + Cloudflare's own parser. */
const DOMAIN_REGEX =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/

export interface ResolverBundle {
  readonly ns: DnsNsResolver
  readonly cname?: DnsCnameResolver
  readonly a?: DnsAResolver
}

export type AddDomainError =
  | 'invalid_domain'
  | 'gbox_subdomain_not_allowed'
  | 'already_claimed_by_other_shop'
  | 'already_added'

export type AddDomainResult =
  | { ok: true; id: string; domain: string }
  | { ok: false; error: AddDomainError }

export type VerifyDomainError =
  | 'not_found'
  | 'not_on_cloudflare'
  | 'lookup_error'

export type VerifyDomainResult =
  | {
      ok: true
      domain: string
      cloudflareProxied: true
      nameservers: readonly string[]
      dnsTarget: string | null
    }
  | {
      ok: false
      error: VerifyDomainError
      /** Populated on 'not_on_cloudflare' so the UI can show what the
       *  current NS list looks like. Empty on other errors. */
      nameservers?: readonly string[]
      dnsTarget?: string | null
      lookupErrorMessage?: string
    }

/**
 * Unified verification method label. Written to
 * `shop_domains.verification_method` so ops can tell how a domain
 * was verified without re-running DNS. Accepted values in v2:
 *   - 'cloudflare' — NS matches `*.ns.cloudflare.com`
 *   - 'a_record'   — A lookup matches `GBOX_PLATFORM_IP_V4`
 * Legacy values ('txt', 'http') may exist on older rows; the new
 * flow never writes those but they're kept for audit.
 */
export type VerificationMethod = 'cloudflare' | 'a_record'

export type VerifyDomainError2 =
  | 'not_found'
  | 'not_verified'
  | 'lookup_error'

export type VerifyDomainResult2 =
  | {
      ok: true
      method: VerificationMethod
      domain: string
      /** Non-null only when `method === 'a_record'` (the matched IP). */
      matchedIp: string | null
      /** Non-empty only when `method === 'cloudflare'`. */
      nameservers: readonly string[]
      /** Informational — whatever the CNAME/A probe found. */
      dnsTarget: string | null
    }
  | {
      ok: false
      error: VerifyDomainError2
      /** Detection objects, surfaced verbatim so the UI can render
       *  "expected X, got Y" messages without the service having to
       *  know about every message variant. */
      aRecord: DetectARecordResult
      cloudflare: DetectCloudflareResult
    }

export type SetPrimaryError = 'not_found' | 'not_verified'
export type SetPrimaryResult =
  | { ok: true; domainId: string }
  | { ok: false; error: SetPrimaryError }

export type SetRedirectError =
  | 'source_not_found'
  | 'target_not_found'
  | 'target_not_verified'
  | 'self_redirect_not_allowed'
  | 'primary_cannot_redirect'
export type SetRedirectResult =
  | { ok: true; sourceId: string; targetId: string | null }
  | { ok: false; error: SetRedirectError }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalises seller input: strip scheme, trailing slash, lowercase,
 *  trim whitespace. Leaves the rest for `DOMAIN_REGEX` to validate. */
export function normalizeDomainInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// addDomain
// ---------------------------------------------------------------------------

export async function addDomain(
  db: Kysely<Database>,
  input: { shopId: string; rawDomain: string },
): Promise<AddDomainResult> {
  const domain = normalizeDomainInput(input.rawDomain)

  if (!domain || !DOMAIN_REGEX.test(domain)) {
    return { ok: false, error: 'invalid_domain' }
  }

  // Sellers must add gbox.co subdomains as shop slugs, not custom
  // domains. If we let them, migrations 012/016 would start fighting
  // over ownership of the same host — the domain-resolution layer
  // already returns the default subdomain for slug-based lookups.
  if (domain.endsWith('.gbox.co') || domain === 'gbox.co') {
    return { ok: false, error: 'gbox_subdomain_not_allowed' }
  }

  // Global uniqueness check. Migration 035 added a unique index so
  // the DB would catch it anyway, but handling it here gives us a
  // clean typed error instead of a raw SQLSTATE to wrangle in the UI.
  const existing = await db
    .selectFrom('shop_domains')
    .select(['shop_id'])
    .where('domain', '=', domain)
    .executeTakeFirst()

  if (existing) {
    return {
      ok: false,
      error:
        existing.shop_id === input.shopId
          ? 'already_added'
          : 'already_claimed_by_other_shop',
    }
  }

  // We still generate a verification_token for legacy TXT-flow rows
  // that may have been created against old code paths. The Cloudflare
  // flow ignores it, but leaving it null breaks older admin tools that
  // expect every row to carry one.
  const token = generateVerificationToken()

  const inserted = await db
    .insertInto('shop_domains')
    .values({
      shop_id: input.shopId,
      domain,
      is_primary: false,
      verified: false,
      verification_token: token,
      verification_method: 'cloudflare',
      ssl_status: 'pending',
    } as any)
    .returning(['id'])
    .executeTakeFirstOrThrow()

  return { ok: true, id: inserted.id as string, domain }
}

// ---------------------------------------------------------------------------
// verifyViaCloudflare
// ---------------------------------------------------------------------------

/**
 * Re-checks a domain's NS records via Cloudflare detection. Writes
 * the results (nameservers / cloudflare_proxied / dns_target /
 * last_checked_at) to the row regardless of outcome — the UI uses
 * that metadata to show sellers what's currently set. Flips
 * `verified=true` only on success (all NS on Cloudflare).
 */
export async function verifyViaCloudflare(
  db: Kysely<Database>,
  input: { shopId: string; domainId: string; resolvers: ResolverBundle },
): Promise<VerifyDomainResult> {
  const row = await db
    .selectFrom('shop_domains')
    .select(['id', 'domain'])
    .where('id', '=', input.domainId)
    .where('shop_id', '=', input.shopId)
    .executeTakeFirst()

  if (!row) {
    return { ok: false, error: 'not_found' }
  }

  const detection: DetectCloudflareResult = await detectCloudflare({
    domain: row.domain,
    nsResolver: input.resolvers.ns,
    ...(input.resolvers.cname ? { cnameResolver: input.resolvers.cname } : {}),
    ...(input.resolvers.a ? { aResolver: input.resolvers.a } : {}),
  })

  const nowIso = new Date().toISOString()

  // Build update patch shared across success + fail paths. We always
  // persist the observed state so the UI can display it — the flag
  // that gates "verified" is only the Cloudflare pass.
  const base = {
    nameservers: JSON.stringify(detection.nameservers) as any,
    cloudflare_proxied: detection.cloudflareProxied,
    dns_target: detection.dnsTarget,
    last_checked_at: nowIso,
    updated_at: nowIso,
  } as const

  if (detection.cloudflareProxied) {
    // Success: flip verified=true and set verified_at. verification_method
    // is already 'cloudflare' from addDomain; keep it that way.
    await db
      .updateTable('shop_domains')
      .set({
        ...base,
        verified: true,
        verified_at: nowIso,
        ssl_status: 'active', // Cloudflare terminates SSL for us
      } as any)
      .where('id', '=', input.domainId)
      .execute()

    return {
      ok: true,
      domain: row.domain,
      cloudflareProxied: true,
      nameservers: detection.nameservers,
      dnsTarget: detection.dnsTarget,
    }
  }

  // Not on Cloudflare — write the observed metadata but DO NOT flip
  // verified. If the row was previously verified and the seller moved
  // NS away, we leave `verified=true` alone: re-verify is manual, and
  // accidentally nuking a live domain because of a flaky DNS probe is
  // worse than showing stale state.
  await db
    .updateTable('shop_domains')
    .set(base as any)
    .where('id', '=', input.domainId)
    .execute()

  if (detection.lookupError) {
    return {
      ok: false,
      error: 'lookup_error',
      nameservers: detection.nameservers,
      dnsTarget: detection.dnsTarget,
      lookupErrorMessage: detection.lookupError,
    }
  }

  return {
    ok: false,
    error: 'not_on_cloudflare',
    nameservers: detection.nameservers,
    dnsTarget: detection.dnsTarget,
  }
}

// ---------------------------------------------------------------------------
// verifyDomain (unified)
// ---------------------------------------------------------------------------

/**
 * Tries the two verification paths in order and flips the row to
 * `verified=true` the moment one succeeds:
 *
 *   1. **A record** — the lower-friction Shopify-style setup. The
 *      seller points their apex (and optionally `www`) at our
 *      platform IP. We resolve A and check the answer against
 *      `platformIps`. If any match, we mark `method='a_record'`
 *      and store the matched IP in `dns_target`.
 *   2. **Cloudflare NS** — the seller moved their nameservers to
 *      Cloudflare. We walk up to the zone apex, check every NS
 *      against `*.ns.cloudflare.com`, and if every one matches we
 *      mark `method='cloudflare'` + `cloudflare_proxied=true` and
 *      rely on Cloudflare to terminate SSL.
 *
 * On failure we still persist what we OBSERVED (nameservers,
 * cloudflare_proxied, dns_target, last_checked_at) so the UI can
 * show sellers "here's what your domain currently looks like" —
 * identical contract to the original `verifyViaCloudflare`.
 *
 * This function is additive: `verifyViaCloudflare` still works for
 * any caller that only cares about the CF path.
 */
export async function verifyDomain(
  db: Kysely<Database>,
  input: {
    shopId: string
    domainId: string
    resolvers: ResolverBundle
    platformIps: readonly string[]
  },
): Promise<VerifyDomainResult2> {
  const row = await db
    .selectFrom('shop_domains')
    .select(['id', 'domain'])
    .where('id', '=', input.domainId)
    .where('shop_id', '=', input.shopId)
    .executeTakeFirst()

  if (!row) {
    // Match `verifyViaCloudflare`'s "not_found" contract — the empty
    // detection objects are harmless placeholders since the UI only
    // reads them in the error path.
    return {
      ok: false,
      error: 'not_found',
      aRecord: {
        matched: false,
        observedIps: [],
        platformIps: input.platformIps,
      },
      cloudflare: {
        cloudflareProxied: false,
        nameservers: [],
        dnsTarget: null,
      },
    }
  }

  // --- Path 1: A record ---------------------------------------------------
  // Try this first because it's the lower-friction seller flow and
  // avoids firing an NS query when the answer is already obvious
  // from the A record.
  const aRecord = input.resolvers.a
    ? await detectARecord({
        domain: row.domain,
        aResolver: input.resolvers.a,
        platformIps: input.platformIps,
      })
    : // No A resolver wired — can't evaluate this path. Produces a
      // harmless non-match result so the CF path still runs.
      ({
        matched: false,
        observedIps: [],
        platformIps: input.platformIps,
      } satisfies DetectARecordResult)

  const nowIso = new Date().toISOString()

  if (aRecord.matched) {
    // Prefer the matched IP (the one that hit `platformIps`) as the
    // `dns_target` so ops can tell at a glance which origin answered.
    const matched = aRecord.observedIps.find((ip) =>
      aRecord.platformIps.includes(ip),
    )
    const matchedIp = matched ?? aRecord.observedIps[0] ?? null

    await db
      .updateTable('shop_domains')
      .set({
        verified: true,
        verified_at: nowIso,
        verification_method: 'a_record',
        // Reset any leftover Cloudflare metadata from a previous
        // attempt, so the row is coherent with the method we just
        // used. `nameservers` stays at whatever we last observed.
        cloudflare_proxied: false,
        dns_target: matchedIp,
        last_checked_at: nowIso,
        updated_at: nowIso,
        // A record path means the seller is serving over our origin
        // — we'll issue SSL ourselves later (acme.sh). For now mark
        // pending so the UI can surface the right status pill.
        ssl_status: 'pending',
      } as any)
      .where('id', '=', input.domainId)
      .execute()

    return {
      ok: true,
      method: 'a_record',
      domain: row.domain,
      matchedIp,
      nameservers: [],
      dnsTarget: matchedIp,
    }
  }

  // --- Path 2: Cloudflare NS ---------------------------------------------
  const cloudflare = await detectCloudflare({
    domain: row.domain,
    nsResolver: input.resolvers.ns,
    ...(input.resolvers.cname ? { cnameResolver: input.resolvers.cname } : {}),
    ...(input.resolvers.a ? { aResolver: input.resolvers.a } : {}),
  })

  if (cloudflare.cloudflareProxied) {
    await db
      .updateTable('shop_domains')
      .set({
        verified: true,
        verified_at: nowIso,
        verification_method: 'cloudflare',
        nameservers: JSON.stringify(cloudflare.nameservers) as any,
        cloudflare_proxied: true,
        dns_target: cloudflare.dnsTarget,
        last_checked_at: nowIso,
        updated_at: nowIso,
        ssl_status: 'active', // Cloudflare terminates SSL for us
      } as any)
      .where('id', '=', input.domainId)
      .execute()

    return {
      ok: true,
      method: 'cloudflare',
      domain: row.domain,
      matchedIp: null,
      nameservers: cloudflare.nameservers,
      dnsTarget: cloudflare.dnsTarget,
    }
  }

  // --- Both paths failed — persist observed state + return --------------
  await db
    .updateTable('shop_domains')
    .set({
      nameservers: JSON.stringify(cloudflare.nameservers) as any,
      cloudflare_proxied: cloudflare.cloudflareProxied,
      // Prefer the A-record observed IP for `dns_target` when the
      // seller has DNS set up but wrong — helps them spot typos.
      dns_target:
        aRecord.observedIps.length > 0
          ? aRecord.observedIps.join(',')
          : cloudflare.dnsTarget,
      last_checked_at: nowIso,
      updated_at: nowIso,
    } as any)
    .where('id', '=', input.domainId)
    .execute()

  // DNS infra unreachable (NXDOMAIN / SERVFAIL on both paths) vs
  // "DNS answered but nothing matches" (plain not_verified). Sellers
  // on propagation delays get a clearer "try again in a minute"
  // message for the former.
  const bothLookupsFailed =
    Boolean(aRecord.lookupError) && Boolean(cloudflare.lookupError)

  return {
    ok: false,
    error: bothLookupsFailed ? 'lookup_error' : 'not_verified',
    aRecord,
    cloudflare,
  }
}

// ---------------------------------------------------------------------------
// setPrimary
// ---------------------------------------------------------------------------

/**
 * Sets `is_primary=true` on the given domain and clears it on every
 * other domain in the same shop. Implemented as two updates because
 * Kysely's dialect doesn't ship with a portable "update rows to
 * mutually exclusive booleans in one statement" — the partial unique
 * index is our safety net against concurrent writers racing.
 */
export async function setPrimary(
  db: Kysely<Database>,
  input: { shopId: string; domainId: string },
): Promise<SetPrimaryResult> {
  const target = await db
    .selectFrom('shop_domains')
    .select(['id', 'verified'])
    .where('id', '=', input.domainId)
    .where('shop_id', '=', input.shopId)
    .executeTakeFirst()

  if (!target) {
    return { ok: false, error: 'not_found' }
  }
  if (!target.verified) {
    // Can't promote an unverified domain — the storefront router
    // only accepts verified hosts, so this would break the shop.
    return { ok: false, error: 'not_verified' }
  }

  const nowIso = new Date().toISOString()

  // Clear existing primary first to avoid colliding with the partial
  // unique index when promoting the target.
  await db
    .updateTable('shop_domains')
    .set({ is_primary: false, updated_at: nowIso } as any)
    .where('shop_id', '=', input.shopId)
    .where('is_primary', '=', true)
    .execute()

  await db
    .updateTable('shop_domains')
    .set({
      is_primary: true,
      // Promoting to primary means "this is the front door" → clear any
      // redirect so the domain doesn't 301 its own traffic away.
      redirect_to_domain_id: null,
      updated_at: nowIso,
    } as any)
    .where('id', '=', input.domainId)
    .execute()

  return { ok: true, domainId: input.domainId }
}

// ---------------------------------------------------------------------------
// setRedirect
// ---------------------------------------------------------------------------

/**
 * Attach or clear the `redirect_to_domain_id` FK on a domain. Pass
 * `targetDomainId: null` to clear. The target must belong to the
 * same shop and be verified.
 */
export async function setRedirect(
  db: Kysely<Database>,
  input: {
    shopId: string
    sourceDomainId: string
    targetDomainId: string | null
  },
): Promise<SetRedirectResult> {
  const source = await db
    .selectFrom('shop_domains')
    .select(['id', 'is_primary'])
    .where('id', '=', input.sourceDomainId)
    .where('shop_id', '=', input.shopId)
    .executeTakeFirst()

  if (!source) {
    return { ok: false, error: 'source_not_found' }
  }

  // Primary domain is the front door. Letting it redirect would create
  // a loop (primary → other → primary → …) in the worst case, and
  // always confuse sellers. Setters must demote first.
  if (source.is_primary && input.targetDomainId !== null) {
    return { ok: false, error: 'primary_cannot_redirect' }
  }

  if (input.targetDomainId === null) {
    await db
      .updateTable('shop_domains')
      .set({
        redirect_to_domain_id: null,
        updated_at: new Date().toISOString(),
      } as any)
      .where('id', '=', input.sourceDomainId)
      .execute()
    return { ok: true, sourceId: input.sourceDomainId, targetId: null }
  }

  if (input.targetDomainId === input.sourceDomainId) {
    return { ok: false, error: 'self_redirect_not_allowed' }
  }

  const target = await db
    .selectFrom('shop_domains')
    .select(['id', 'verified'])
    .where('id', '=', input.targetDomainId)
    .where('shop_id', '=', input.shopId)
    .executeTakeFirst()

  if (!target) {
    return { ok: false, error: 'target_not_found' }
  }
  if (!target.verified) {
    return { ok: false, error: 'target_not_verified' }
  }

  await db
    .updateTable('shop_domains')
    .set({
      redirect_to_domain_id: input.targetDomainId,
      updated_at: new Date().toISOString(),
    } as any)
    .where('id', '=', input.sourceDomainId)
    .execute()

  return {
    ok: true,
    sourceId: input.sourceDomainId,
    targetId: input.targetDomainId,
  }
}

// ---------------------------------------------------------------------------
// removeDomain
// ---------------------------------------------------------------------------

/**
 * Deletes a domain row. Other rows that pointed at it via
 * `redirect_to_domain_id` have that FK set to NULL automatically
 * (ON DELETE SET NULL, declared in migration 035).
 *
 * Does NOT refuse to remove a primary — the UI shows a confirmation
 * dialog; after this call the shop simply has no primary and the
 * router falls back to the default subdomain.
 */
export async function removeDomain(
  db: Kysely<Database>,
  input: { shopId: string; domainId: string },
): Promise<{ ok: true; domain: string } | { ok: false; error: 'not_found' }> {
  const row = await db
    .selectFrom('shop_domains')
    .select(['id', 'domain'])
    .where('id', '=', input.domainId)
    .where('shop_id', '=', input.shopId)
    .executeTakeFirst()

  if (!row) {
    return { ok: false, error: 'not_found' }
  }

  await db
    .deleteFrom('shop_domains')
    .where('id', '=', input.domainId)
    .execute()

  return { ok: true, domain: row.domain }
}
