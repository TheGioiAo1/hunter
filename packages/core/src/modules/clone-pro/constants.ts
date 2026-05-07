/**
 * Clone Pro — shared constants.
 *
 * Central home for values that crawler + runner + tests all need to
 * agree on. Anything site-identifying (User-Agent, bot URL), anything
 * tuneable by env (rate caps), and anything we want to grep for in
 * one place lives here.
 *
 * Phase 7 Step 7.3 — pinned the `GboxCloneBot/4.0` User-Agent. Sites
 * that want to block or allowlist our crawler can target the stable
 * `GboxCloneBot` token in their `robots.txt`. The `+https://gbox.co/bot`
 * disclosure URL is the Google-style convention for "who owns this
 * crawler, how do I complain/opt out" — we'll host a one-page
 * disclosure there in Phase 8+.
 */

/**
 * The stable User-Agent string every clone-pro HTTP request sends.
 *
 * Format follows Google's crawler disclosure convention:
 *   `<BotName>/<Version> (+<disclosure-url>)`
 *
 * The token `GboxCloneBot` is what we match in robots.txt and what
 * sites will see in their access logs. Bumping the version after a
 * crawl-behaviour change is optional but signals "our new behaviour
 * starts here" to anyone inspecting logs historically.
 */
export const CLONE_BOT_USER_AGENT = 'GboxCloneBot/4.0 (+https://gbox.co/bot)'

/**
 * The robots.txt User-Agent token we match against. This is the
 * lowercase-insensitive name WITHOUT the version or URL suffix —
 * `robots-parser` matches the bare token from `User-agent: …` lines.
 */
export const CLONE_BOT_UA_TOKEN = 'GboxCloneBot'

/**
 * Rate-limit cap — max concurrent outbound requests per source host
 * per clone-worker process. Phase 7 spec §3.7 locks this at 5 req/s.
 *
 * Env override: `CLONE_HOST_RATE_LIMIT` — useful for integration
 * smoke tests that want to drop the cap to 1 to get deterministic
 * ordering, or for ops to tighten if we see abuse complaints.
 */
export const HOST_RATE_LIMIT = Number(process.env.CLONE_HOST_RATE_LIMIT) || 5

/**
 * Feature flag — if set to any falsy string (`false`, `0`, empty),
 * the `RobotsGuard` short-circuits `isAllowed()` to `true` for every
 * URL. Default: robots enforcement IS ON. This is the rollback escape
 * hatch documented in Phase 7 spec §8.
 *
 * Evaluated lazily (at call time, not at import time) so tests and
 * ops scripts that set the env var AFTER the module loads still see
 * the updated value. The perf cost is negligible — one string read
 * per crawled URL.
 */
export function isRobotsEnforced(): boolean {
  const raw = process.env.CLONE_ROBOTS_ENFORCED
  if (raw === undefined) return true
  return !['false', '0', ''].includes(String(raw).toLowerCase())
}
