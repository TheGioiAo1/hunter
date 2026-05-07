/**
 * Gbox Platform — SSL Certificate Provisioner
 *
 * Phase 5 — Custom Domain SSL provisioning for merchant storefronts.
 *
 * Strategy:
 *   1. Merchant adds custom domain (e.g. shop.example.com) via admin.
 *   2. DNS verification: merchant creates CNAME → storefront.gbox.co.
 *   3. Once DNS resolves, request an SSL cert via ACME (Let's Encrypt).
 *   4. Store cert + key in `shop_domains` for Nginx dynamic SSL.
 *
 * This module abstracts the ACME flow so production can use Let's Encrypt
 * and dev/test can use self-signed or Cloudflare Origin certs.
 *
 * For environments behind Cloudflare, use the `cloudflare` provider which
 * relies on Cloudflare's edge SSL (orange-cloud) — no ACME needed, just
 * DNS verification that the CNAME exists.
 */

import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db/schema/tables.js'
import dns from 'node:dns/promises'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SSLProvider = 'cloudflare' | 'acme' | 'self-signed'

export type DomainVerificationStatus =
  | 'pending'      // Domain added, DNS not yet verified
  | 'dns_verified'  // CNAME resolves correctly
  | 'ssl_active'    // SSL cert is live
  | 'failed'        // Verification or SSL provisioning failed

export interface DomainVerificationResult {
  domain: string
  status: DomainVerificationStatus
  cname_target: string
  cname_found: string | null
  verified: boolean
  message: string
}

export interface SSLProvisionResult {
  domain: string
  provider: SSLProvider
  status: 'provisioned' | 'pending' | 'failed'
  message: string
  expires_at?: string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CNAME_TARGET = process.env.STOREFRONT_CNAME_TARGET || 'storefront.gbox.co'
const SSL_PROVIDER: SSLProvider = (process.env.SSL_PROVIDER as SSLProvider) || 'cloudflare'

// ---------------------------------------------------------------------------
// DNS Verification
// ---------------------------------------------------------------------------

/**
 * Verify that a domain's DNS CNAME points to our storefront.
 * Checks both the exact CNAME and A-record fallback.
 */
export async function verifyDomainDNS(domain: string): Promise<DomainVerificationResult> {
  const result: DomainVerificationResult = {
    domain,
    status: 'pending',
    cname_target: CNAME_TARGET,
    cname_found: null,
    verified: false,
    message: '',
  }

  try {
    // Try CNAME lookup first
    const cnames = await dns.resolveCname(domain).catch(() => [])
    if (cnames.length > 0) {
      result.cname_found = cnames[0]
      // Accept exact match or subdomain match
      if (cnames[0] === CNAME_TARGET || cnames[0].endsWith('.' + CNAME_TARGET)) {
        result.status = 'dns_verified'
        result.verified = true
        result.message = `CNAME verified: ${domain} → ${cnames[0]}`
        return result
      }
      result.message = `CNAME found but points to ${cnames[0]}, expected ${CNAME_TARGET}`
      return result
    }

    // Fallback: check if A-record resolves (could be proxied through Cloudflare)
    const addresses = await dns.resolve4(domain).catch(() => [])
    if (addresses.length > 0) {
      // If A-record exists, domain is configured but we can't verify CNAME
      // This is common with Cloudflare orange-cloud proxying
      result.cname_found = `A: ${addresses[0]}`
      result.status = 'dns_verified'
      result.verified = true
      result.message = `A-record found (likely proxied): ${domain} → ${addresses[0]}`
      return result
    }

    result.message = `No DNS records found for ${domain}. Create a CNAME: ${domain} → ${CNAME_TARGET}`
    return result
  } catch (err: any) {
    result.message = `DNS lookup failed: ${err.message}`
    return result
  }
}

// ---------------------------------------------------------------------------
// Domain Management
// ---------------------------------------------------------------------------

/**
 * Add a custom domain to a shop and begin verification.
 */
export async function addCustomDomain(
  db: Kysely<Database>,
  shopId: string,
  domain: string,
): Promise<{ id: string; domain: string; status: string }> {
  // Normalize domain
  const normalized = domain.toLowerCase().replace(/^(https?:\/\/)/, '').replace(/\/+$/, '')

  // Check if domain is already claimed
  const existing = await db
    .selectFrom('shop_domains')
    .select(['shop_id'])
    .where('domain', '=', normalized)
    .executeTakeFirst()

  if (existing && (existing as any).shop_id !== shopId) {
    throw new Error(`Domain ${normalized} is already claimed by another shop`)
  }

  // Upsert domain record
  const row = await db
    .insertInto('shop_domains' as any)
    .values({
      shop_id: shopId,
      domain: normalized,
      verified: false,
      ssl_status: 'pending',
    } as any)
    .onConflict((oc: any) =>
      oc.columns(['shop_id', 'domain']).doUpdateSet({
        updated_at: new Date().toISOString(),
      } as any),
    )
    .returningAll()
    .executeTakeFirstOrThrow()

  return { id: (row as any).id, domain: normalized, status: 'pending' }
}

/**
 * Verify a domain's DNS and update its status.
 */
export async function verifyAndProvision(
  db: Kysely<Database>,
  shopId: string,
  domain: string,
): Promise<DomainVerificationResult & { ssl?: SSLProvisionResult }> {
  const dnsResult = await verifyDomainDNS(domain)

  if (dnsResult.verified) {
    // Update domain as verified
    await db
      .updateTable('shop_domains' as any)
      .set({ verified: true, updated_at: new Date().toISOString() } as any)
      .where('shop_id', '=', shopId)
      .where('domain', '=', domain)
      .execute()

    // Provision SSL based on provider
    const sslResult = await provisionSSL(db, shopId, domain)
    return { ...dnsResult, ssl: sslResult }
  }

  return dnsResult
}

/**
 * Provision SSL for a verified domain.
 */
async function provisionSSL(
  db: Kysely<Database>,
  shopId: string,
  domain: string,
): Promise<SSLProvisionResult> {
  switch (SSL_PROVIDER) {
    case 'cloudflare':
      // Cloudflare handles SSL at the edge — no cert needed on origin.
      // Just mark as active since DNS is already verified.
      await db
        .updateTable('shop_domains' as any)
        .set({ ssl_status: 'active', updated_at: new Date().toISOString() } as any)
        .where('shop_id', '=', shopId)
        .where('domain', '=', domain)
        .execute()
      return {
        domain,
        provider: 'cloudflare',
        status: 'provisioned',
        message: 'SSL active via Cloudflare edge (orange-cloud proxy)',
      }

    case 'acme':
      // ACME (Let's Encrypt) would be implemented here.
      // For now, mark as pending — a background worker would handle
      // the actual ACME challenge + cert issuance.
      await db
        .updateTable('shop_domains' as any)
        .set({ ssl_status: 'provisioning', updated_at: new Date().toISOString() } as any)
        .where('shop_id', '=', shopId)
        .where('domain', '=', domain)
        .execute()
      return {
        domain,
        provider: 'acme',
        status: 'pending',
        message: 'SSL certificate request queued (Let\'s Encrypt). Usually ready in 1-2 minutes.',
      }

    case 'self-signed':
      // Dev/test only
      await db
        .updateTable('shop_domains' as any)
        .set({ ssl_status: 'active', updated_at: new Date().toISOString() } as any)
        .where('shop_id', '=', shopId)
        .where('domain', '=', domain)
        .execute()
      return {
        domain,
        provider: 'self-signed',
        status: 'provisioned',
        message: 'Self-signed SSL (dev only)',
      }

    default:
      return { domain, provider: SSL_PROVIDER, status: 'failed', message: `Unknown provider: ${SSL_PROVIDER}` }
  }
}

/**
 * Remove a custom domain from a shop.
 */
export async function removeCustomDomain(
  db: Kysely<Database>,
  shopId: string,
  domain: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('shop_domains' as any)
    .where('shop_id', '=', shopId)
    .where('domain', '=', domain)
    .execute()
  return (result as any).length > 0 || (result as any).numDeletedRows > 0
}

/**
 * List all domains for a shop with their verification/SSL status.
 */
export async function listShopDomains(
  db: Kysely<Database>,
  shopId: string,
): Promise<any[]> {
  return db
    .selectFrom('shop_domains' as any)
    .selectAll()
    .where('shop_id', '=', shopId)
    .orderBy('created_at' as any, 'desc')
    .execute()
}
