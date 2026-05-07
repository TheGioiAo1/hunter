/**
 * Design Library — clone slug derivation (Phase D2).
 *
 * Build a stable, URL-safe slug for a CLONE entry in
 * `design_library_entries`. Shape:
 *
 *   <sanitized-hostname>-<short-job-id>
 *
 * Example: `https://www.airbnb.com/` + job id
 * `6df3a4b1-c290-4f22-a0ce-deadbeef1234` → `airbnb-com-6df3a4b1`.
 *
 * Requirements met:
 *   - Unique per clone job within a shop. The Postgres partial unique
 *     index `idx_design_library_clone_slug` on
 *     `(shop_id, slug) WHERE source='clone'` surfaces any collision
 *     as a DB error — good, because a collision indicates either a
 *     caller bug (double-firing the hook) or the ~10^9 birthday case.
 *   - Stable — same `(sourceUrl, jobId)` → same slug. That makes
 *     retries idempotent if the pipeline ever re-enters the emit hook.
 *   - Human-readable for the D4 gallery URL
 *     (`/design-library/my-clones/airbnb-com-6df3a4b1`).
 *   - URL-safe: lowercase alphanumerics + hyphens only. No unicode
 *     or percent-encoding concerns for routes.
 *
 * When `jobId` is omitted (test harness, dev REPL), we fall back to
 * 4 bytes of cryptographic randomness (8 hex chars) so the slug is
 * still unique per call. That branch should never fire in production —
 * `runner.ts` always passes `jobId` through.
 */

import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a clone slug from the cloned URL and the pipeline's job id.
 * The output is guaranteed to be non-empty and URL-safe.
 */
export function deriveCloneSlug(
  sourceUrl: string,
  jobId?: string,
): string {
  const host = sanitizeHostname(sourceUrl)
  // `|| 'clone'` — covers the rare case where sourceUrl is empty or
  // only has unsanitisable bytes. The caller's URL validator normally
  // catches this before we're invoked.
  const base = host || 'clone'
  const suffix = shortIdSuffix(jobId)
  return `${base}-${suffix}`
}

// ---------------------------------------------------------------------------
// Helpers (exported only as internal for tests)
// ---------------------------------------------------------------------------

/**
 * Pull a hostname out of a URL and turn it into slug-safe form:
 *   - Lowercase
 *   - `www.` prefix stripped (so `airbnb` and `www.airbnb` collapse)
 *   - Non-alphanumerics become single hyphens
 *   - Leading/trailing hyphens trimmed
 *   - Capped at 64 chars so pathological hostnames don't blow up the
 *     gallery URL
 *
 * Returns an empty string if nothing useful survives — the caller
 * handles that via the `|| 'clone'` fallback in `deriveCloneSlug`.
 */
export function sanitizeHostname(sourceUrl: string): string {
  let host = ''
  try {
    host = new URL(sourceUrl).hostname
  } catch {
    // Strip protocol + path manually — same fallback shape as
    // `serialize-design-md.ts :: safeHostname`.
    host = sourceUrl
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/[/?#].*$/, '')
  }
  return host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * Convert a jobId (UUID-ish) into an 8-char URL-safe suffix. When
 * `jobId` is missing, invalid, or would reduce to nothing after
 * sanitization, fall back to 8 hex chars of randomness.
 *
 * We intentionally keep this deterministic for well-formed UUIDs so
 * a retry of the emit hook with the same jobId produces the same
 * slug — the partial unique index then treats a retry as a no-op
 * (insertCloneEntry will raise a DB error, which the hook catches).
 */
function shortIdSuffix(jobId: string | undefined): string {
  if (jobId) {
    // Scrub to URL-safe chars — UUID dashes are removed, and any
    // non-alnum in a weird jobId string is stripped rather than
    // percent-encoded.
    const sanitized = jobId.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (sanitized.length >= 8) return sanitized.slice(0, 8)
    if (sanitized.length > 0) {
      // Short IDs (rare — caller passed something that's not a UUID).
      // Pad with randomness so the slug suffix is always exactly 8 chars
      // and unique across repeats.
      const padded = sanitized + randomBytes(4).toString('hex')
      return padded.slice(0, 8)
    }
  }
  return randomBytes(4).toString('hex')
}
