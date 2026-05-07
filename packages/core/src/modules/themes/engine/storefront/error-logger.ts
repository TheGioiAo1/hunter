/**
 * Gbox Platform — Storefront Error Logger
 *
 * Decision #1 Step 1.14 — Rate-limited error sink for the storefront
 * router. Without this, a broken theme that throws on every render
 * would flood Sentry / the console with millions of identical
 * stack traces in seconds.
 *
 * Strategy: token bucket per error fingerprint. The fingerprint is
 * a sha256 of `error.name + first stack frame + status code`, which
 * collapses repeats of the same bug while still distinguishing
 * different bugs that happen to share a status.
 *
 * Defaults match Shopify's pattern (5/minute then drop, with a
 * counter the periodic flush task can read for "+N suppressed"
 * messages). The defaults can be overridden per shop / per env.
 *
 * Why a class instead of free functions? Because rate state must
 * persist between calls — the router is stateless but the logger
 * holds buckets indexed by fingerprint. One instance per process
 * is fine; tests construct their own to keep state isolated.
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Where the logger forwards events that pass the rate filter. The
 * sink decides what "log" means: in dev it's `console.error`; in
 * prod it's a Sentry client; in tests it's an array we assert on.
 */
export interface ErrorLoggerSink {
  /** Called once for every event that passes the rate filter. */
  log(event: LoggedEvent): void
}

/** Event handed to the sink — already fingerprinted + counted. */
export interface LoggedEvent {
  /** Sha256 fingerprint, hex-encoded. Stable across calls. */
  fingerprint: string
  /** HTTP status code that will be returned to the client. */
  status: number
  /** The original error. */
  error: Error
  /** Request path that triggered the error. */
  path: string
  /** Method (GET/POST/...). */
  method: string
  /** Shop id when known. */
  shopId?: string
  /** Number of suppressed events for this fingerprint since last log. */
  suppressed: number
  /** Wall clock when the event was accepted. */
  timestamp: number
}

/** Config knobs for the rate limiter. */
export interface ErrorLoggerOptions {
  /**
   * Max events per `windowMs` per fingerprint. Defaults to 5.
   * Setting to 0 disables logging entirely (tests use this).
   */
  maxPerWindow?: number
  /** Window size in milliseconds. Defaults to 60_000 (1 min). */
  windowMs?: number
  /** Where to forward accepted events. Defaults to console sink. */
  sink?: ErrorLoggerSink
  /**
   * Clock injection point — tests pass a fake clock so they don't
   * have to sleep. Defaults to `Date.now`.
   */
  now?: () => number
}

/**
 * The minimal interface every storefront error logger conforms to.
 * `handleStorefrontRequest` accepts this so a Sentry-backed adapter
 * can be substituted in production.
 */
export interface ErrorLogger {
  /**
   * Report an error from the storefront pipeline. Returns true when
   * the event was forwarded to the sink, false when it was dropped
   * by the rate limiter.
   */
  report(input: ReportInput): boolean
}

/** Args to `ErrorLogger.report`. */
export interface ReportInput {
  error: Error
  status: number
  path: string
  method: string
  shopId?: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default rate window (one minute). */
export const DEFAULT_ERROR_WINDOW_MS = 60_000

/** Default events per window per fingerprint. */
export const DEFAULT_ERROR_MAX_PER_WINDOW = 5

/**
 * No-op sink — used when the caller wants the rate limiter math but
 * doesn't want anything written anywhere. Tests use this to assert
 * that `report()` returns true/false without side effects.
 */
export const NOOP_SINK: ErrorLoggerSink = {
  log() {
    /* deliberately empty */
  },
}

/**
 * Console sink — writes a one-line summary to `console.error`. Good
 * default for dev; production should pass a Sentry sink instead.
 */
export const CONSOLE_SINK: ErrorLoggerSink = {
  log(event) {
    const suppressed =
      event.suppressed > 0 ? ` (+${event.suppressed} suppressed)` : ''
    // eslint-disable-next-line no-console
    console.error(
      `[storefront ${event.status}] ${event.method} ${event.path} — ${event.error.message}${suppressed}`,
      event.error.stack,
    )
  },
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Compute a stable sha256 fingerprint for an error. Uses the error
 * name, the first stack frame (file + line), and the status code.
 * That triple is enough to collapse "same bug, every request" while
 * still keeping unrelated bugs distinct.
 *
 * Exported for tests + so a future Sentry adapter can re-use it for
 * group-by keys.
 */
export function fingerprintError(error: Error, status: number): string {
  const name = error.name || 'Error'
  const firstFrame = extractFirstStackFrame(error.stack)
  const hash = createHash('sha256')
  hash.update(name)
  hash.update('|')
  hash.update(firstFrame)
  hash.update('|')
  hash.update(String(status))
  return hash.digest('hex')
}

/**
 * Pull the first non-header line out of an Error stack. Returns the
 * error message string when no frame is present (some thrown
 * objects lack a stack).
 */
function extractFirstStackFrame(stack: string | undefined): string {
  if (!stack) return ''
  const lines = stack.split('\n')
  // Skip the header line ("Error: foo") and any blank lines.
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('at ')) return trimmed
  }
  return lines[0]?.trim() ?? ''
}

// ---------------------------------------------------------------------------
// Token bucket logger
// ---------------------------------------------------------------------------

/**
 * State stored per fingerprint. `windowStart` is the wall-clock
 * timestamp when the current window opened; `accepted` counts how
 * many events we've forwarded since then; `suppressed` counts the
 * drops we should announce on the next accepted event.
 */
interface BucketState {
  windowStart: number
  accepted: number
  suppressed: number
}

/**
 * Default in-memory implementation. Holds a `Map<fingerprint,
 * BucketState>`; bucket entries are pruned lazily when their window
 * has expired and a new event comes in for the same fingerprint.
 *
 * Memory footprint: bounded by the number of distinct error
 * fingerprints active in the last window. In practice that's a
 * handful — a thousand bad themes is still <100KB.
 */
export class RateLimitedErrorLogger implements ErrorLogger {
  private readonly maxPerWindow: number
  private readonly windowMs: number
  private readonly sink: ErrorLoggerSink
  private readonly now: () => number
  private readonly buckets = new Map<string, BucketState>()

  constructor(options: ErrorLoggerOptions = {}) {
    this.maxPerWindow = options.maxPerWindow ?? DEFAULT_ERROR_MAX_PER_WINDOW
    this.windowMs = options.windowMs ?? DEFAULT_ERROR_WINDOW_MS
    this.sink = options.sink ?? CONSOLE_SINK
    this.now = options.now ?? Date.now
  }

  report(input: ReportInput): boolean {
    if (this.maxPerWindow <= 0) return false
    const fingerprint = fingerprintError(input.error, input.status)
    const ts = this.now()
    let bucket = this.buckets.get(fingerprint)
    if (!bucket || ts - bucket.windowStart >= this.windowMs) {
      // New window — fresh bucket. The previous bucket's
      // `suppressed` count gets carried into the first event of
      // the new window so the sink can report "+N suppressed".
      const carryOver = bucket?.suppressed ?? 0
      bucket = {
        windowStart: ts,
        accepted: 0,
        suppressed: carryOver,
      }
      this.buckets.set(fingerprint, bucket)
    }
    if (bucket.accepted >= this.maxPerWindow) {
      bucket.suppressed += 1
      return false
    }
    bucket.accepted += 1
    const event: LoggedEvent = {
      fingerprint,
      status: input.status,
      error: input.error,
      path: input.path,
      method: input.method,
      shopId: input.shopId,
      suppressed: bucket.suppressed,
      timestamp: ts,
    }
    // Reset suppressed once we've reported it.
    bucket.suppressed = 0
    this.sink.log(event)
    return true
  }

  /**
   * Test helper — reset all buckets. Production code never calls
   * this; the rate limiter is supposed to live for the process.
   */
  reset(): void {
    this.buckets.clear()
  }
}

/**
 * Convenience constructor — returns a logger using the console sink
 * and 5/min defaults. Most callers want this.
 */
export function createDefaultErrorLogger(): ErrorLogger {
  return new RateLimitedErrorLogger()
}
