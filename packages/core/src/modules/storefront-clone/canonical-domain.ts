/**
 * Canonical-domain derivation for storefront clone jobs.
 *
 * A "canonical domain" is the normalised hostname we use to dedupe
 * clone jobs across different-but-equivalent source URLs:
 *
 *   https://www.bibliobloom.com/shop      → bibliobloom.com
 *   https://bibliobloom.com/               → bibliobloom.com
 *   https://BIBLIOBLOOM.com/products/tea   → bibliobloom.com
 *   https://bibliobloom.com:443            → bibliobloom.com
 *
 * Rules (all locked in the 2026-04-17 Phase 6 spec):
 *   1. Protocol must be http: or https:. Other schemes return null
 *      so the caller can 400 upstream — we never clone a
 *      javascript:/ftp:/data: URL.
 *   2. Hostname is lowercased.
 *   3. Leading "www." is stripped (so `www.X` and `X` never produce
 *      two jobs under the UNIQUE index from migration 045).
 *   4. Port, path, query, and fragment are discarded — they're
 *      merchant intent noise, not identity.
 *   5. Invalid / unparseable URLs return null. The shared DB index is
 *      partial (WHERE canonical_domain IS NOT NULL) so NULL rows
 *      don't participate in the UNIQUE constraint — they're the
 *      "legacy / unknown" bucket from pre-migration-041 jobs.
 *
 * This helper is the JS counterpart to the SQL regex in migration
 * 041's backfill step:
 *
 *     lower(substring(source_url from '^(?:https?://)?(?:www\\.)?([^/?#]+)'))
 *
 * The JS version uses the built-in URL parser instead of a regex so
 * IPv6 literals, user:password@host shapes, and weirdly-encoded
 * hostnames parse consistently. For strings that the URL parser
 * refuses (the exact same shapes the SQL regex would fall back on)
 * we return null and the caller ends up with the "canonical_domain
 * is NULL" state that's always been allowed.
 *
 * Pure function, no I/O, safe for use inside hot paths.
 */

export function canonicalDomainFromUrl(
  sourceUrl: string | null | undefined,
): string | null {
  if (!sourceUrl) return null
  const trimmed = String(sourceUrl).trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  return host || null
}
