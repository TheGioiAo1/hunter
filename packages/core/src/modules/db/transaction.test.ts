/**
 * Gbox Platform — Transaction Helper Unit Tests (Phase 15 PR1)
 *
 * Verifies:
 *   - withSerializable calls Kysely's setIsolationLevel('serializable')
 *   - Retryable serialization failures (SQLSTATE 40001, 40P01) are retried
 *   - Non-retryable errors bubble up immediately
 *   - Retries respect maxAttempts
 *   - Backoff hook fires for observability
 */

import { describe, it, expect, vi } from 'vitest'
import {
  withSerializable,
  isRetryableSerializationError,
} from './transaction.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Kysely instance whose `.transaction().setIsolationLevel(x)
 * .execute(fn)` chain invokes `fn` with a stub `trx`, possibly throwing a
 * custom error to simulate serialization failures.
 */
function makeMockDb(options: {
  /** Errors to throw on successive invocations (undefined = success). */
  errorSequence?: Array<Error | undefined>
  /** Value returned once fn succeeds (default 'ok'). */
  successValue?: unknown
}) {
  const errors = [...(options.errorSequence ?? [])]
  const execute = vi.fn(async (fn: (trx: unknown) => Promise<unknown>) => {
    if (errors.length > 0) {
      const nextErr = errors.shift()
      if (nextErr) throw nextErr
    }
    return fn({ __stub: true })
  })
  const setIsolationLevel = vi.fn(() => ({ execute }))
  const transaction = vi.fn(() => ({ setIsolationLevel }))
  return {
    db: { transaction } as any,
    spies: { transaction, setIsolationLevel, execute },
  }
}

function pgError(code: string, message = 'serialization conflict'): Error {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// isRetryableSerializationError
// ---------------------------------------------------------------------------

describe('isRetryableSerializationError', () => {
  it('returns true for SQLSTATE 40001 (serialization_failure)', () => {
    expect(isRetryableSerializationError(pgError('40001'))).toBe(true)
  })

  it('returns true for SQLSTATE 40P01 (deadlock_detected)', () => {
    expect(isRetryableSerializationError(pgError('40P01'))).toBe(true)
  })

  it('returns false for unique violation (23505)', () => {
    expect(isRetryableSerializationError(pgError('23505'))).toBe(false)
  })

  it('returns false for plain Error without code', () => {
    expect(isRetryableSerializationError(new Error('boom'))).toBe(false)
  })

  it('returns false for null / non-object', () => {
    expect(isRetryableSerializationError(null)).toBe(false)
    expect(isRetryableSerializationError(undefined)).toBe(false)
    expect(isRetryableSerializationError('not an error')).toBe(false)
  })

  it('returns true when code is nested under originalError (TypeORM-style)', () => {
    const err = new Error('wrapped') as any
    err.originalError = { code: '40001' }
    expect(isRetryableSerializationError(err)).toBe(true)
  })

  it('returns true when code is nested under cause (native ES style)', () => {
    const err = new Error('wrapped') as any
    err.cause = { code: '40P01' }
    expect(isRetryableSerializationError(err)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// withSerializable
// ---------------------------------------------------------------------------

describe('withSerializable', () => {
  it('invokes Kysely transaction with SERIALIZABLE isolation', async () => {
    const { db, spies } = makeMockDb({})
    const result = await withSerializable(db, async () => 'ok')
    expect(result).toBe('ok')
    expect(spies.transaction).toHaveBeenCalledTimes(1)
    expect(spies.setIsolationLevel).toHaveBeenCalledWith('serializable')
    expect(spies.execute).toHaveBeenCalledTimes(1)
  })

  it('passes trx handle to fn', async () => {
    const { db } = makeMockDb({})
    const fn = vi.fn(async () => 'ok')
    await withSerializable(db, fn)
    expect(fn).toHaveBeenCalledOnce()
    expect(fn.mock.calls[0][0]).toEqual({ __stub: true })
  })

  it('retries on SQLSTATE 40001 and succeeds on second attempt', async () => {
    const { db, spies } = makeMockDb({
      errorSequence: [pgError('40001'), undefined],
    })
    const result = await withSerializable(db, async () => 'ok', {
      baseDelayMs: 1, // keep test fast
    })
    expect(result).toBe('ok')
    expect(spies.execute).toHaveBeenCalledTimes(2)
  })

  it('retries on SQLSTATE 40P01 (deadlock) and succeeds', async () => {
    const { db, spies } = makeMockDb({
      errorSequence: [pgError('40P01'), undefined],
    })
    const result = await withSerializable(db, async () => 'ok', {
      baseDelayMs: 1,
    })
    expect(result).toBe('ok')
    expect(spies.execute).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting maxAttempts', async () => {
    const { db, spies } = makeMockDb({
      errorSequence: [
        pgError('40001'),
        pgError('40001'),
        pgError('40001'),
      ],
    })
    await expect(
      withSerializable(db, async () => 'ok', { baseDelayMs: 1 }),
    ).rejects.toThrow('serialization conflict')
    expect(spies.execute).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry non-retryable errors (bubbles up immediately)', async () => {
    const { db, spies } = makeMockDb({
      errorSequence: [pgError('23505', 'unique violation')],
    })
    await expect(
      withSerializable(db, async () => 'ok', { baseDelayMs: 1 }),
    ).rejects.toThrow('unique violation')
    expect(spies.execute).toHaveBeenCalledTimes(1)
  })

  it('respects custom maxAttempts', async () => {
    const { db, spies } = makeMockDb({
      errorSequence: [
        pgError('40001'),
        pgError('40001'),
        pgError('40001'),
        pgError('40001'),
        pgError('40001'),
      ],
    })
    await expect(
      withSerializable(db, async () => 'ok', {
        maxAttempts: 5,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow('serialization conflict')
    expect(spies.execute).toHaveBeenCalledTimes(5)
  })

  it('invokes onRetry hook between attempts for observability', async () => {
    const { db } = makeMockDb({
      errorSequence: [pgError('40001'), pgError('40001'), undefined],
    })
    const onRetry = vi.fn()
    await withSerializable(db, async () => 'ok', { baseDelayMs: 1, onRetry })
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][0]).toBe(1) // first retry attempt index
    expect(onRetry.mock.calls[1][0]).toBe(2)
    expect(isRetryableSerializationError(onRetry.mock.calls[0][1])).toBe(true)
  })

  it('does NOT invoke onRetry after the final failed attempt', async () => {
    const { db } = makeMockDb({
      errorSequence: [pgError('40001'), pgError('40001'), pgError('40001')],
    })
    const onRetry = vi.fn()
    await expect(
      withSerializable(db, async () => 'ok', {
        maxAttempts: 3,
        baseDelayMs: 1,
        onRetry,
      }),
    ).rejects.toThrow()
    // 3 attempts = 2 retry intervals = 2 onRetry calls (not 3)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('propagates fn thrown errors that are not retryable', async () => {
    const { db, spies } = makeMockDb({})
    await expect(
      withSerializable(db, async () => {
        throw new Error('business rule violation')
      }),
    ).rejects.toThrow('business rule violation')
    expect(spies.execute).toHaveBeenCalledTimes(1)
  })
})
