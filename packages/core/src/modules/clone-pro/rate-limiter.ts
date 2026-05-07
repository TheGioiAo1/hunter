/**
 * Phase 7 Step 7.3 — per-host crawler rate limiter.
 *
 * Contract: max `HOST_RATE_LIMIT` requests per second against any
 * single source host (default 5 → one slot every 200ms). The cap is
 * per clone-worker process; we don't need distributed throttling
 * because the global worker concurrency is small and jobs rarely
 * cluster on one host.
 *
 * Mechanism: a "next allowed request time" timestamp per host. Each
 * call peeks the timestamp, pushes it forward by `MIN_INTERVAL_MS`,
 * and sleeps until its slot is reached. The push happens
 * synchronously (before `await`) so concurrent calls don't all
 * collapse onto the same slot — each one reserves the next unique
 * window atomically.
 *
 * Caveats:
 *   - The minimum-interval model means a long-running fn holds up
 *     the host's next slot only by 200ms (not by the fn's duration).
 *     That's correct — rate limiting is about request _dispatch_
 *     rate, not about request _completion_ rate. If the source site
 *     is slow to respond, our crawler just waits.
 *   - Reset helper (`__resetRateLimitersForTest`) is internal-only;
 *     production code must never call it. Exported for Vitest so
 *     host state doesn't leak between tests.
 */

import { HOST_RATE_LIMIT } from './constants.js'

/**
 * Minimum milliseconds between consecutive requests to the same host.
 * At 5 req/s this is 200ms. Derived from `HOST_RATE_LIMIT` so env
 * overrides take effect at module-load time.
 */
export const MIN_INTERVAL_MS = Math.round(1000 / HOST_RATE_LIMIT)

/** Per-host state: the earliest timestamp the next request may fire. */
const nextSlotByHost = new Map<string, number>()

/**
 * Gate `fn()` through the per-host rate limiter. Returns whatever
 * `fn` resolves to; rejections propagate verbatim (no retry, no
 * swallow — the caller knows the URL and decides policy).
 *
 * @param host Hostname only (no scheme, no path). The caller
 *   extracts `new URL(url).hostname` — the limiter does not parse
 *   URLs so arbitrary key strings (e.g., "shopify-admin-api") can
 *   also be used to coalesce requests to a logical service.
 */
export async function rateLimitedFetch<T>(
  host: string,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now()
  const currentSlot = nextSlotByHost.get(host) ?? 0

  // Our slot is whichever is later: right now, or the next free
  // slot on this host. Reserve it immediately (synchronously,
  // before the await) so concurrent callers each walk forward by
  // MIN_INTERVAL_MS rather than stacking on the same timestamp.
  const mySlot = Math.max(now, currentSlot)
  nextSlotByHost.set(host, mySlot + MIN_INTERVAL_MS)

  const waitMs = mySlot - now
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  return fn()
}

/**
 * TEST-ONLY — clears all per-host state. Invoked in `afterEach`
 * blocks so one test's burst doesn't throttle the next test's
 * first call. Do not call from production code.
 */
export function __resetRateLimitersForTest(): void {
  nextSlotByHost.clear()
}
