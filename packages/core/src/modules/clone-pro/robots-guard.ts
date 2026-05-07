/**
 * Phase 7 Step 7.3 — `robots.txt` enforcement.
 *
 * Every clone job creates one `RobotsGuard` pinned to the source
 * origin. Before the crawler fetches any URL it asks the guard
 * `isAllowed(url)`. A `false` answer means SKIP + warn — it doesn't
 * fail the job. Sites without a robots.txt (404) are treated as
 * fully open; sites whose robots.txt is unreachable for any other
 * reason are treated as fully open too (fail-open). We never promote
 * a transient network blip into a terminal clone failure.
 *
 * Caching: one guard = one fetch. `load()` is idempotent — calling
 * it multiple times is safe but only one HTTP round-trip happens per
 * instance. Crawler code can sprinkle `await guard.load()` at the
 * top of every stage without worrying about traffic.
 *
 * Rollback: setting `CLONE_isRobotsEnforced()=false` short-circuits
 * `isAllowed()` to `true` and skips the robots.txt fetch entirely —
 * useful if a merchant owns a site that blocks bots by default.
 * Owner sign-off required per Phase 7 spec §8.
 */

import robotsParser from 'robots-parser'

import { safeFetch } from '../clone-shopify/safe-fetch.js'
import {
  CLONE_BOT_UA_TOKEN,
  CLONE_BOT_USER_AGENT,
  isRobotsEnforced,
} from './constants.js'

/** Minimal shape of the `robots-parser` result we depend on. */
interface RobotsParserResult {
  isAllowed(url: string, ua?: string): boolean | undefined
}

export class RobotsGuard {
  private readonly origin: string
  private parser: RobotsParserResult | null = null
  private loaded = false
  private loadingPromise: Promise<void> | null = null

  /**
   * @param sourceUrl Any URL on the source site. Only the origin
   *   (`scheme://host[:port]`) is retained — the path/query are
   *   discarded because `robots.txt` is always at the origin root.
   */
  constructor(sourceUrl: string) {
    // Fall back to an empty-ish origin on parse error. We never want
    // the constructor to throw — callers treat the guard as "always
    // available", and a bad source URL is the runner's problem to
    // surface, not ours.
    let parsed: URL | null = null
    try {
      parsed = new URL(sourceUrl)
    } catch {
      parsed = null
    }
    this.origin = parsed ? parsed.origin : ''
  }

  /**
   * Fetch + parse the site's robots.txt. Idempotent — safe to call
   * at the top of every crawler stage; only one network round-trip
   * happens per instance.
   *
   * Rules for the resulting state:
   *   - Flag off → we DO NOT fetch (bypass).
   *   - 2xx with body → parse; UA-specific rules for GboxCloneBot
   *     are used when `isAllowed()` is called.
   *   - 404 → no restrictions (allow everything).
   *   - Other HTTP or network errors → fail open (allow everything,
   *     log a warn for observability).
   */
  async load(): Promise<void> {
    if (this.loaded) return
    if (this.loadingPromise) return this.loadingPromise
    if (!isRobotsEnforced()) {
      // Rollback escape hatch — we skip the fetch AND leave the
      // parser null so `isAllowed()` short-circuits to true.
      this.loaded = true
      return
    }
    if (!this.origin) {
      // Bad source URL → nothing we can enforce against. Mark loaded
      // so callers don't retry, but leave parser null (= allow-all).
      this.loaded = true
      return
    }

    this.loadingPromise = (async () => {
      const robotsUrl = `${this.origin}/robots.txt`
      try {
        const res = await safeFetch(robotsUrl, {
          userAgent: CLONE_BOT_USER_AGENT,
          // Small body cap — robots.txt spec recommends 500 KiB max
          // and most are < 10 KiB. A 1 MB cap is still SSRF-safe and
          // protects against a pathological response.
          maxBytes: 1_048_576,
          timeoutMs: 10_000,
        })

        if (res.statusCode === 404) {
          // No robots.txt published → everything allowed.
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // 5xx / 403 / etc → log and fail open. Blocking a clone
          // because the source site has a broken robots.txt would
          // be a bad trade-off.
          console.warn(
            `[robots-guard] ${robotsUrl} returned HTTP ${res.statusCode}; failing open`,
          )
          return
        }

        const body = res.body.toString('utf8')
        try {
          this.parser = robotsParser(robotsUrl, body) as RobotsParserResult
        } catch (parseErr) {
          // robots-parser is tolerant, but if it ever does throw on
          // garbage content we still want to fail open.
          console.warn(
            `[robots-guard] parse error for ${robotsUrl}:`,
            (parseErr as Error).message,
          )
          this.parser = null
        }
      } catch (err) {
        // Network error, SSRF reject, timeout — log and fail open.
        console.warn(
          `[robots-guard] failed to fetch ${robotsUrl}: ${(err as Error).message}`,
        )
      } finally {
        this.loaded = true
        this.loadingPromise = null
      }
    })()

    return this.loadingPromise
  }

  /**
   * Answer whether the clone crawler is allowed to fetch `url` under
   * this site's robots.txt, evaluated against our pinned UA token
   * (`GboxCloneBot`).
   *
   * Rules:
   *   - Flag off (`CLONE_isRobotsEnforced()=false`) → always allow.
   *   - Not loaded yet → fail open (allow). Crawlers should call
   *     `load()` first, but we don't want to block on a forgotten
   *     await — they'd skip every URL otherwise.
   *   - URL from a different origin than the guard → allow. The
   *     guard only speaks for its own host; cross-origin CDN URLs
   *     aren't ours to gate.
   *   - Parser loaded + `isAllowed(url, GboxCloneBot)` returns false
   *     → block.
   *   - Anything else → allow.
   */
  isAllowed(url: string): boolean {
    if (!isRobotsEnforced()) return true
    if (!this.parser) return true

    let target: URL
    try {
      target = new URL(url)
    } catch {
      // Can't parse the URL → let the downstream fetch reject it;
      // the guard's job is robots.txt, not URL validation.
      return true
    }
    if (target.origin !== this.origin) return true

    // `robots-parser` returns `boolean | undefined`; undefined means
    // "no rule matched" which is equivalent to allow. `=== false`
    // makes that explicit.
    return this.parser.isAllowed(url, CLONE_BOT_UA_TOKEN) !== false
  }
}
