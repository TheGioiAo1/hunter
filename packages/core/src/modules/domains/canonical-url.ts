/**
 * Canonical URL Resolver — pick the right hostname for a shop.
 *
 * Single source of truth for "what hostname should I use when I write
 * a URL for shop X?". Used by:
 *   - email senders (from address, links inside the body)
 *   - OAuth redirect_uri builders
 *   - sitemap.xml + robots.txt + canonical <link rel> in templates
 *   - storefront `{slug}.gbox.co → 301 → custom domain` middleware
 *
 * Resolution priority (Shopify-class):
 *   1. shops.primary_domain_id → shop_domains.domain WHERE verified=true
 *   2. <slug>.gbox.co (the platform-managed subdomain — always works,
 *      always served, never goes away)
 *
 * The fallback to {slug}.gbox.co is intentional. If a seller's primary
 * domain DNS breaks or their cert expires, internal mailers + OAuth
 * still work — we never paint ourselves into a corner where shop
 * communication breaks because the seller's apex went down.
 *
 * Returned values are always FULLY-QUALIFIED:
 *   - hostname (no protocol)
 *   - origin (https://hostname — protocol always https; no http
 *     option because we never want a sitemap entry to suggest http)
 *
 * The result is a tiny POJO so callers can pass it around freely.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

export interface CanonicalUrl {
  /** "tw3.store" or "best-store.gbox.co" — never includes scheme. */
  hostname: string
  /** "https://tw3.store" — for href / mailto attributes. */
  origin: string
  /**
   * Where this hostname came from. Tells callers whether they're on
   * the seller's preferred domain or the platform fallback so the
   * UI / logs can surface that distinction.
   */
  source: 'primary_domain' | 'platform_subdomain'
}

const PLATFORM_DOMAIN_SUFFIX = '.gbox.co'

export interface ResolveCanonicalOptions {
  /**
   * Override the platform domain suffix in tests. Default '.gbox.co'.
   * Set via GBOX_PLATFORM_DOMAIN_SUFFIX env in production if we ever
   * fork to a different umbrella TLD.
   */
  platformDomainSuffix?: string
}

/**
 * Resolve canonical URL for a shop given its slug + (optional)
 * primary_domain_id pointer + the shop_domains row that pointer
 * names. The shape is "give me everything you already have" so the
 * caller can fold this into existing per-request reads without
 * issuing extra queries.
 *
 * Returns the platform subdomain when:
 *   - the shop has no primary_domain_id, OR
 *   - the primary domain row is missing / not verified
 *
 * Returns the primary domain when both pointer + verified-row are present.
 */
export function resolveCanonicalUrlSync(
  shop: { slug: string; primary_domain_id?: string | null },
  primaryDomainRow: { domain: string; verified: boolean } | null | undefined,
  options: ResolveCanonicalOptions = {},
): CanonicalUrl {
  const suffix = options.platformDomainSuffix ?? PLATFORM_DOMAIN_SUFFIX

  if (
    shop.primary_domain_id &&
    primaryDomainRow &&
    primaryDomainRow.verified &&
    typeof primaryDomainRow.domain === 'string' &&
    primaryDomainRow.domain.length > 0
  ) {
    return {
      hostname: primaryDomainRow.domain,
      origin: `https://${primaryDomainRow.domain}`,
      source: 'primary_domain',
    }
  }

  const platformHost = `${shop.slug}${suffix}`
  return {
    hostname: platformHost,
    origin: `https://${platformHost}`,
    source: 'platform_subdomain',
  }
}

/**
 * Resolve canonical URL by shopId — does the DB read for callers that
 * don't already have the shop + primary domain row.
 *
 * Returns the platform subdomain on any error or missing row, never
 * throws. Iron Rule 5: a transient DB hiccup must not break email or
 * OAuth flows; the platform subdomain always works.
 */
export async function resolveCanonicalUrl(
  db: Kysely<Database>,
  shopId: string,
  options: ResolveCanonicalOptions = {},
): Promise<CanonicalUrl> {
  const suffix = options.platformDomainSuffix ?? PLATFORM_DOMAIN_SUFFIX

  try {
    const shop = (await (db as any)
      .selectFrom('shops')
      .select(['slug', 'primary_domain_id'])
      .where('id', '=', shopId)
      .executeTakeFirst()) as
      | { slug: string; primary_domain_id: string | null }
      | undefined

    if (!shop) {
      // Defensive: shouldn't happen for valid IDs but if it does, the
      // caller gets a benign default rather than an exception.
      return { hostname: '', origin: '', source: 'platform_subdomain' }
    }

    if (!shop.primary_domain_id) {
      const host = `${shop.slug}${suffix}`
      return { hostname: host, origin: `https://${host}`, source: 'platform_subdomain' }
    }

    const primaryRow = (await (db as any)
      .selectFrom('shop_domains')
      .select(['domain', 'verified'])
      .where('id', '=', shop.primary_domain_id)
      .executeTakeFirst()) as { domain: string; verified: boolean } | undefined

    return resolveCanonicalUrlSync(shop, primaryRow, options)
  } catch {
    // DB failure — fallback to platform subdomain reconstructed from a
    // separate query. We don't have the slug here so we re-attempt
    // a minimal read; if that fails too we return empty + 'platform'.
    try {
      const slugRow = (await (db as any)
        .selectFrom('shops')
        .select(['slug'])
        .where('id', '=', shopId)
        .executeTakeFirst()) as { slug: string } | undefined
      if (slugRow) {
        const host = `${slugRow.slug}${suffix}`
        return { hostname: host, origin: `https://${host}`, source: 'platform_subdomain' }
      }
    } catch {
      // give up
    }
    return { hostname: '', origin: '', source: 'platform_subdomain' }
  }
}

// Internal helper exported only for tests.
export const __test = { PLATFORM_DOMAIN_SUFFIX }
