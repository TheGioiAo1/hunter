/**
 * Gbox Platform — Edge Cache Headers (Phase 3D)
 *
 * Centralised helper for emitting `Cache-Control`, `CDN-Cache-Control`,
 * `Surrogate-Control`, and `Vary` headers so every response we send
 * to Cloudflare / nginx / the browser tells the same story about
 * freshness and re-use.
 *
 * Why a module instead of a pile of `res.set('Cache-Control', '...')`
 * calls scattered across handlers?
 *
 *   1. **Three layers, three headers.** Browsers read
 *      `Cache-Control`. Cloudflare (and any other modern CDN) ALSO
 *      reads `CDN-Cache-Control` when present, letting the edge
 *      cache aggressively even when we're telling the browser to
 *      revalidate. Older intermediate proxies read
 *      `Surrogate-Control` (from the ESI spec). Missing any of the
 *      three creates a hole where cache policy gets ignored.
 *
 *   2. **Preset policies.** Storefront routes, theme assets, admin
 *      pages, and API endpoints each want different TTLs. Picking
 *      the right preset by hand every time invites drift. Named
 *      presets keep the choices honest and documented in one place.
 *
 *   3. **SWR is a first-class thing.** `stale-while-revalidate`
 *      is the single biggest lever we have for high availability
 *      under traffic spikes — let the edge serve a slightly stale
 *      page while it refreshes in the background, instead of
 *      bouncing the user off. Every preset that opts into it does
 *      so explicitly.
 *
 *   4. **Vary never forgotten.** Personalised HTML that varies by
 *      `Accept-Language` or cookie HAS to set `Vary` or the CDN
 *      will serve the wrong language to the wrong user. The preset
 *      owns the Vary value so route code never has to remember.
 *
 * References:
 *   - https://developers.cloudflare.com/cache/concepts/cache-control/
 *   - https://web.dev/articles/stale-while-revalidate
 *   - https://docs.shopify.com/storefronts/performance  (SWR pattern
 *     for storefront HTML — matches the "dynamic_html_swr" preset)
 */

// ---------------------------------------------------------------------------
// Minimal response shape — keeps the module framework-agnostic so it
// can be called from Express, Hono, Worker, and tests alike.
// ---------------------------------------------------------------------------

export interface HeaderBag {
  set(name: string, value: string): void
}

// ---------------------------------------------------------------------------
// Policy type
// ---------------------------------------------------------------------------

export interface CachePolicy {
  /**
   * Which tier is allowed to cache. `public` = everyone (CDN +
   * browser). `private` = browser only. `no-store` = nobody (used
   * for logged-in admin and checkout forms).
   */
  scope: 'public' | 'private' | 'no-store'
  /**
   * How long a cached copy is considered fresh, in seconds.
   * `0` means "revalidate every time" — still allows the response
   * to be stored, just requires a conditional request on reuse.
   */
  maxAge: number
  /**
   * Edge-specific max-age in seconds. When present it goes into
   * `CDN-Cache-Control` + `Surrogate-Control`; this lets the CDN
   * cache for longer than the browser. Defaults to `maxAge`.
   */
  sMaxAge?: number
  /** Stale-while-revalidate window in seconds. `0` disables SWR. */
  staleWhileRevalidate?: number
  /** Stale-if-error window in seconds. Lets the edge serve stale on origin 5xx. */
  staleIfError?: number
  /** Mark as immutable — tells the browser not to revalidate. */
  immutable?: boolean
  /** Add `must-revalidate` — used with `maxAge: 0` for strict SWR on dynamic. */
  mustRevalidate?: boolean
  /** Vary header value (single string or joined list). */
  vary?: string | string[]
}

// ---------------------------------------------------------------------------
// Preset library
// ---------------------------------------------------------------------------

/**
 * Presets cover the six canonical response classes we ship. Add
 * new presets here (not inline at call sites) so policy stays
 * auditable in a single file.
 */
export const CACHE_PRESETS = {
  /**
   * Theme assets — CSS, JS bundles, fonts, images served from S3
   * / CloudFront. These are content-addressed (filename has a
   * fingerprint hash) so they never change under the same URL.
   * Browser + CDN cache for a full year, marked immutable so
   * revalidation requests never happen.
   */
  theme_asset_immutable: {
    scope: 'public',
    maxAge: 31_536_000, // 1 year
    sMaxAge: 31_536_000,
    immutable: true,
  } satisfies CachePolicy,

  /**
   * Storefront HTML for pages that don't vary by user (home,
   * collection, product). Short browser TTL so logged-in users
   * see their cart badge refresh quickly, longer edge TTL with
   * SWR so the origin rarely gets hit under load. `Vary:
   * Accept-Language, Cookie` keeps per-locale and logged-in
   * copies separate at the edge.
   */
  storefront_html_swr: {
    scope: 'public',
    maxAge: 0,
    sMaxAge: 60, // 1 min at the edge
    staleWhileRevalidate: 600, // 10 min SWR
    staleIfError: 86_400, // 24 hr stale-on-error
    mustRevalidate: true,
    vary: ['Accept-Language', 'Cookie'],
  } satisfies CachePolicy,

  /**
   * JSON API endpoints that are safe to cache briefly — product
   * listings, collection metadata, shop drop. Used by the
   * existing `api-cache.ts` middleware for the cheap hot reads.
   */
  api_short: {
    scope: 'public',
    maxAge: 30,
    sMaxAge: 60,
    staleWhileRevalidate: 300,
    staleIfError: 86_400,
    vary: 'Accept-Language',
  } satisfies CachePolicy,

  /**
   * JSON API endpoints for near-static data (shop settings,
   * navigation tree, theme config). Longer TTL since they
   * rarely change.
   */
  api_long: {
    scope: 'public',
    maxAge: 300,
    sMaxAge: 600,
    staleWhileRevalidate: 3_600,
    staleIfError: 86_400,
    vary: 'Accept-Language',
  } satisfies CachePolicy,

  /**
   * Personalised responses — cart JSON, customer drop, order
   * history. Browser may cache briefly, CDN must NOT. `private`
   * scope guarantees no intermediate proxy will intercept.
   */
  personalised_private: {
    scope: 'private',
    maxAge: 0,
    mustRevalidate: true,
    vary: 'Cookie',
  } satisfies CachePolicy,

  /**
   * Admin dashboard + checkout form + auth callbacks. Never
   * cache anywhere. Also gets `no-store` to prevent the BFCache
   * hole where a user's back-button shows a logged-in page to
   * the next person on the device.
   */
  no_store: {
    scope: 'no-store',
    maxAge: 0,
    vary: 'Cookie',
  } satisfies CachePolicy,
} as const

export type CachePresetName = keyof typeof CACHE_PRESETS

// ---------------------------------------------------------------------------
// Serialiser
// ---------------------------------------------------------------------------

/**
 * Build the `Cache-Control` value from a policy. Separate from
 * `applyCachePolicy` so tests can assert on the exact string
 * without poking a fake response.
 */
export function buildCacheControl(policy: CachePolicy): string {
  if (policy.scope === 'no-store') {
    return 'no-store'
  }

  const parts: string[] = [policy.scope]

  if (policy.scope === 'public') {
    parts.push(`max-age=${Math.max(0, policy.maxAge)}`)
    const sMaxAge = policy.sMaxAge ?? policy.maxAge
    parts.push(`s-maxage=${Math.max(0, sMaxAge)}`)
  } else {
    // private — only browser max-age matters
    parts.push(`max-age=${Math.max(0, policy.maxAge)}`)
  }

  if (policy.staleWhileRevalidate && policy.staleWhileRevalidate > 0) {
    parts.push(`stale-while-revalidate=${policy.staleWhileRevalidate}`)
  }
  if (policy.staleIfError && policy.staleIfError > 0) {
    parts.push(`stale-if-error=${policy.staleIfError}`)
  }
  if (policy.mustRevalidate) {
    parts.push('must-revalidate')
  }
  if (policy.immutable) {
    parts.push('immutable')
  }
  return parts.join(', ')
}

/**
 * Build the `CDN-Cache-Control` / `Surrogate-Control` value. Same
 * as `Cache-Control` but:
 *   - `private` becomes `no-store` (CDN must not cache private)
 *   - `maxAge` is replaced by `sMaxAge` so the edge uses the edge TTL
 *   - removes `must-revalidate` which is browser-only
 */
export function buildEdgeCacheControl(policy: CachePolicy): string | null {
  if (policy.scope === 'private') return 'no-store'
  if (policy.scope === 'no-store') return 'no-store'

  const sMaxAge = policy.sMaxAge ?? policy.maxAge
  const parts: string[] = ['public', `max-age=${Math.max(0, sMaxAge)}`]
  if (policy.staleWhileRevalidate && policy.staleWhileRevalidate > 0) {
    parts.push(`stale-while-revalidate=${policy.staleWhileRevalidate}`)
  }
  if (policy.staleIfError && policy.staleIfError > 0) {
    parts.push(`stale-if-error=${policy.staleIfError}`)
  }
  if (policy.immutable) {
    parts.push('immutable')
  }
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Stamp every cache-related header on a response (or any
 * `HeaderBag`) based on the given policy or preset name.
 *
 * Usage:
 *
 *   // Storefront handler
 *   applyCachePolicy(res, 'storefront_html_swr')
 *
 *   // Theme asset handler
 *   applyCachePolicy(res, 'theme_asset_immutable')
 *
 *   // Custom policy
 *   applyCachePolicy(res, { scope: 'public', maxAge: 10, sMaxAge: 30 })
 */
export function applyCachePolicy(
  res: HeaderBag,
  policyOrName: CachePolicy | CachePresetName,
): void {
  const policy: CachePolicy =
    typeof policyOrName === 'string' ? CACHE_PRESETS[policyOrName] : policyOrName

  const browser = buildCacheControl(policy)
  res.set('Cache-Control', browser)

  const edge = buildEdgeCacheControl(policy)
  if (edge) {
    res.set('CDN-Cache-Control', edge)
    res.set('Surrogate-Control', edge)
  }

  if (policy.vary) {
    const varyValue = Array.isArray(policy.vary)
      ? policy.vary.join(', ')
      : policy.vary
    res.set('Vary', varyValue)
  }
}

/**
 * Tiny convenience wrapper: the Express middleware shape.
 *
 *   app.get('/assets/*', cacheHeaders('theme_asset_immutable'), handler)
 */
export function cacheHeaders(
  policyOrName: CachePolicy | CachePresetName,
): (_req: unknown, res: HeaderBag, next: () => void) => void {
  return function cacheHeadersMiddleware(_req, res, next) {
    applyCachePolicy(res, policyOrName)
    next()
  }
}
