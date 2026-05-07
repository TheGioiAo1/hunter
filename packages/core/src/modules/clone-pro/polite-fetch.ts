/**
 * Phase 7 Step 7.3 — `politeFetch` is the front door every clone-pro
 * outbound HTTP request should go through.
 *
 * Responsibilities, in fixed order:
 *
 *   1. Ask the `RobotsGuard` (if supplied). A `false` answer means
 *      SKIP: we return `{ skipped: true, reason: 'robots' }` and
 *      never issue the fetch. The caller logs a warning and moves
 *      on. Robots denial is NOT a job failure.
 *
 *   2. Pace the request through `rateLimitedFetch`, keyed by the
 *      URL's hostname. 5 req/s per host ceiling (env-overridable).
 *
 *   3. Delegate to `safeFetch` with our pinned GboxCloneBot UA
 *      (`CLONE_BOT_USER_AGENT`). Callers may still override other
 *      safe-fetch options (timeout, size cap, method) via
 *      `fetchOptions`, but the UA is always forced — we don't want
 *      different crawler paths advertising different identities.
 *
 * Call sites that haven't been wired with a guard yet can omit it.
 * Rate-limit + UA still apply; only the robots check is bypassed.
 * That's the migration path — we sprinkle `politeFetch` in over
 * time without a single big-bang rewrite.
 */

import {
  safeFetch,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from '../clone-shopify/safe-fetch.js'
import { CLONE_BOT_USER_AGENT } from './constants.js'
import { rateLimitedFetch } from './rate-limiter.js'
import { RobotsGuard } from './robots-guard.js'

export interface PoliteFetchOptions {
  /**
   * Optional robots.txt enforcement. If omitted the robots check is
   * skipped (legacy crawler call sites) — rate-limit + UA still
   * apply. Preferred usage: instantiate ONE guard per clone job and
   * thread it through every crawler stage.
   */
  readonly robots?: RobotsGuard

  /**
   * Passthrough options to `safeFetch`. UA is always forced to
   * `CLONE_BOT_USER_AGENT` regardless of what the caller sets here.
   */
  readonly fetchOptions?: SafeFetchOptions
}

/**
 * Either a normal safe-fetch response OR a skip record. Check
 * `skipped` first; non-skipped responses carry `statusCode` + body.
 */
export type PoliteFetchResult =
  | (SafeFetchResponse & { skipped?: false })
  | {
      readonly skipped: true
      readonly reason: 'robots'
      readonly url: string
    }

export async function politeFetch(
  url: string,
  options: PoliteFetchOptions = {},
): Promise<PoliteFetchResult> {
  // Step 1: robots gate.
  if (options.robots && !options.robots.isAllowed(url)) {
    return { skipped: true, reason: 'robots', url }
  }

  // Step 2: per-host rate limit. Extract hostname — cheap and the
  // URL constructor already normalises case.
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    // If the URL is unparseable we let safeFetch reject it with its
    // own `bad_url` code. Rate-limit under an empty key so we don't
    // burn budget against an invalid input.
  }

  // Step 3: fetch with forced UA.
  return rateLimitedFetch(host, () =>
    safeFetch(url, {
      ...options.fetchOptions,
      userAgent: CLONE_BOT_USER_AGENT,
    }),
  )
}
