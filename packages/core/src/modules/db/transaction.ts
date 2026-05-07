/**
 * Gbox Platform — Transaction Helpers
 *
 * Phase 15 PR1 — Risk #2 (data integrity): explicit transaction isolation
 * for critical sections that cannot tolerate race conditions. Wraps Kysely's
 * transaction builder with:
 *
 *   1. `SERIALIZABLE` isolation level (defeats most concurrency bugs on
 *      checkout + inventory + customer-counter paths).
 *   2. Automatic retry on serialization failure (`40001`) or deadlock
 *      (`40P01`). Exponential backoff with jitter: ~100ms / ~300ms / ~900ms.
 *   3. Pass-through of the transactional `Kysely` instance to the caller.
 *
 * Why SERIALIZABLE?
 *   The Shopify checkout contract: inventory reservation + payment capture
 *   + order insert MUST be atomic OR the transaction aborts cleanly. At
 *   `READ COMMITTED` (Postgres default), two concurrent checkouts of the
 *   last unit can both see `stock_available = 1`, both deduct, and both
 *   succeed — classic oversell. `SERIALIZABLE` forces the second
 *   transaction to abort with `40001`; the retry wrapper then re-reads the
 *   (now-empty) stock and fails cleanly with a business-level "out of
 *   stock" error instead of a physical oversell.
 *
 * Why retries?
 *   `SERIALIZABLE` rejects any transaction that *could* have produced an
 *   incorrect interleaving, not just those that actually did. Under load,
 *   benign conflicts (two checkouts on different products that happen to
 *   touch the same customer row) also abort with `40001`. Auto-retry hides
 *   that noise from callers.
 *
 * Usage:
 *
 *   return withSerializable(db, async (trx) => {
 *     // all reads + writes here see a consistent snapshot; conflicts
 *     // trigger retry transparently
 *   })
 */

import type { Kysely, Transaction } from 'kysely'

/** Postgres SQLSTATE codes that indicate a retryable serialization conflict. */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01'])

/** Max retry attempts before propagating the serialization failure. */
const DEFAULT_MAX_ATTEMPTS = 3

/** Base delay in milliseconds — doubled on each retry. */
const DEFAULT_BASE_DELAY_MS = 100

export interface WithSerializableOptions {
  /** Max attempts including the initial try. Default 3. */
  maxAttempts?: number
  /** Base delay before first retry; doubled each time. Default 100. */
  baseDelayMs?: number
  /** Optional hook invoked before each retry attempt (for logging/metrics). */
  onRetry?: (attempt: number, error: Error) => void
}

/**
 * Run `fn` inside a `SERIALIZABLE` transaction, retrying transparently on
 * serialization failure or deadlock up to `maxAttempts` times.
 *
 * The caller receives a transactional `Kysely` — all queries issued via
 * this handle join the same snapshot. Throw inside `fn` to roll back.
 */
export async function withSerializable<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
  opts: WithSerializableOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS

  let lastError: Error | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(fn)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (!isRetryableSerializationError(lastError) || attempt === maxAttempts) {
        throw lastError
      }
      opts.onRetry?.(attempt, lastError)
      await sleepWithJitter(baseDelayMs * Math.pow(3, attempt - 1))
    }
  }

  // Unreachable — the for-loop either returns or throws — but satisfy TS.
  throw lastError ?? new Error('withSerializable: exhausted retries')
}

/**
 * Return true if `err` is a Postgres error whose SQLSTATE indicates a
 * serialization or deadlock conflict that can be safely retried.
 */
export function isRetryableSerializationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  // pg driver surfaces SQLSTATE under `code`; some wrappers add `sqlState`
  // or expose `.originalError.code`. Check all common shapes.
  const candidates: unknown[] = [
    (err as { code?: unknown }).code,
    (err as { sqlState?: unknown }).sqlState,
    (err as { originalError?: { code?: unknown } }).originalError?.code,
    (err as { cause?: { code?: unknown } }).cause?.code,
  ]
  return candidates.some(
    (c) => typeof c === 'string' && RETRYABLE_SQLSTATES.has(c),
  )
}

/**
 * Sleep for `ms` milliseconds +/- 20% jitter. Jitter desynchronises
 * retry storms so competing transactions don't re-collide in lockstep.
 */
async function sleepWithJitter(ms: number): Promise<void> {
  const jitter = ms * 0.2 * (Math.random() - 0.5) * 2 // ±20%
  const delay = Math.max(10, Math.round(ms + jitter))
  await new Promise((resolve) => setTimeout(resolve, delay))
}
