/**
 * HTTP fetch with rotating User-Agent + exponential-backoff retry.
 *
 * Wraps `got` (~/+~/+~ kept on 5xx, immediate fail on 4xx-other-than-429).
 * UA pool ported from Lonspy `uaDesktop.txt` — 10 modern Chrome/Edge/Firefox
 * agents on Windows + macOS so a target site sees a realistic browser-like
 * spread.
 *
 * Iron Rule 5: errors propagate raw to the orchestrator, which pipes through
 * `safeMessage()` before any seller-facing surface. This module never
 * composes a user-visible string.
 */
import got from 'got'
import pRetry, { AbortError } from 'p-retry'

/** Production-class desktop UAs — rotated per attempt. */
export const UA_POOL_DESKTOP: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:122.0) Gecko/20100101 Firefox/122.0',
] as const

export function pickUserAgent(): string {
  return UA_POOL_DESKTOP[Math.floor(Math.random() * UA_POOL_DESKTOP.length)]
}

export interface HttpFetchOptions {
  /** Request timeout in ms (default 30_000). */
  timeoutMs?: number
  /** Total number of attempts (default 3). */
  retries?: number
  /** Initial backoff in ms (default 2000). */
  minTimeoutMs?: number
  /** Backoff multiplier (default 2 → exponential). */
  factor?: number
}

interface HttpError {
  response?: { statusCode?: number }
}

/**
 * Fetch HTML with rotating UA + retry-with-backoff.
 * Throws after exhausting `retries`. 4xx errors abort retry immediately
 * (404/410/451 — page is gone / blocked, retry won't help).
 */
export async function httpFetchHtml(url: string, opts: HttpFetchOptions = {}): Promise<string> {
  const retries = opts.retries ?? 3
  const minTimeoutMs = opts.minTimeoutMs ?? 2000
  const factor = opts.factor ?? 2
  const timeoutMs = opts.timeoutMs ?? 30_000

  return pRetry(
    async () => {
      const ua = pickUserAgent()
      try {
        const res = await got(url, {
          headers: {
            'user-agent': ua,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
          },
          timeout: { request: timeoutMs },
          retry: { limit: 0 }, // p-retry owns retry logic — disable got's built-in
          throwHttpErrors: true,
        })
        return res.body
      } catch (e) {
        // 4xx (except 429) → permanent: abort retry chain immediately.
        const status = (e as HttpError).response?.statusCode
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw new AbortError(e instanceof Error ? e.message : String(e))
        }
        throw e
      }
    },
    {
      retries: Math.max(0, retries - 1),
      minTimeout: minTimeoutMs,
      factor,
      maxRetryTime: 60_000,
    },
  )
}
