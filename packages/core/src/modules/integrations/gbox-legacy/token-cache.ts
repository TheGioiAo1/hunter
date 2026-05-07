/**
 * In-memory JWT cache for the legacy Gbox master account.
 *
 * Decision captured in the measurement-brain context: do NOT persist
 * JWTs. Every PM2 restart re-logs in on the next push; the legacy auth
 * service is fast enough (~500 ms) that the cost is negligible.
 *
 * TTL resolution
 * --------------
 *  1. Decode the JWT `exp` claim. If present and in the future, use it
 *     with a 60-second safety margin.
 *  2. Otherwise fall back to a 50-minute soft TTL.
 *
 * The cache is keyed on `authBase + '::' + email` so staging and prod
 * configs never share a token even if the process serves both.
 */

interface CacheEntry {
  token: string
  expiresAtMs: number
}

const cache = new Map<string, CacheEntry>()

const FALLBACK_TTL_MS = 50 * 60 * 1000 // 50 min
const EXP_SAFETY_MS = 60 * 1000 // refresh 60s before actual exp

function cacheKey(authBase: string, email: string): string {
  return `${authBase}::${email.toLowerCase()}`
}

/**
 * Extract the exp claim from an unverified JWT. We're not verifying the
 * signature — the legacy service does that — we just want to know when
 * to refresh our cached copy.
 */
function readJwtExpMs(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payloadRaw = parts[1]!
    // base64url → base64
    const padded =
      payloadRaw.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (payloadRaw.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const payload = JSON.parse(json)
    if (typeof payload?.exp === 'number' && payload.exp > 0) {
      return payload.exp * 1000 // seconds → ms
    }
    return null
  } catch {
    return null
  }
}

export function getCachedToken(authBase: string, email: string): string | null {
  const key = cacheKey(authBase, email)
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAtMs <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.token
}

export function storeToken(authBase: string, email: string, token: string): void {
  const expFromJwt = readJwtExpMs(token)
  const expiresAtMs = expFromJwt
    ? Math.max(Date.now() + 1000, expFromJwt - EXP_SAFETY_MS)
    : Date.now() + FALLBACK_TTL_MS
  cache.set(cacheKey(authBase, email), { token, expiresAtMs })
}

export function invalidateToken(authBase: string, email: string): void {
  cache.delete(cacheKey(authBase, email))
}

/** Exposed for test harnesses only — wipes every entry. */
export function __clearAllForTests(): void {
  cache.clear()
}
