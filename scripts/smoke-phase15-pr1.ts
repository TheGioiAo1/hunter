/**
 * Gbox Platform — Phase 15 PR1 smoke (transaction isolation)
 *
 * Validates the `withSerializable` wrapper that protects checkout-critical
 * paths against oversell + double-charge under concurrent load:
 *
 *   [1..3]   withSerializable invokes Kysely with SERIALIZABLE + passes
 *            the transactional handle to the caller
 *   [4..6]   retry path: SQLSTATE 40001 + 40P01 are retried, other codes
 *            are not
 *   [7..9]   exhaustion path: maxAttempts is respected, final error
 *            bubbles up unchanged, onRetry observability hook fires
 *   [10..11] integration: createOrder wires up the wrapper so a
 *            downstream consumer sees setIsolationLevel('serializable')
 *            in the transaction chain
 *   [12]     iron-rule check: the helper module does not leak
 *            god-admin strings to any error message
 *
 * Runs offline — no DB, no HTTP. Safe to run on the smoke box.
 *
 *   npx tsx scripts/smoke-phase15-pr1.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  withSerializable,
  isRetryableSerializationError,
} from '@gbox/core/modules/db/transaction.js'
import { createOrder } from '@gbox/core/modules/orders/service.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Asserter
// ---------------------------------------------------------------------------

type AssertFn = (label: string, ok: boolean, detail?: string) => void

function makeAsserter(): {
  assert: AssertFn
  summary: () => { total: number; passed: number }
} {
  let total = 0
  let passed = 0
  const assert: AssertFn = (label, ok, detail) => {
    total++
    if (ok) {
      passed++
      console.log(`  OK   [${total}] ${label}`)
    } else {
      console.error(
        `  FAIL [${total}] ${label}${detail ? ` — ${detail}` : ''}`,
      )
    }
  }
  return {
    assert,
    summary: () => ({ total, passed }),
  }
}

// ---------------------------------------------------------------------------
// Mock Kysely that can simulate serialization conflicts.
// ---------------------------------------------------------------------------

function pgError(code: string, message = `pg error ${code}`): Error {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

function makeMockDb(errorSequence: Array<Error | undefined> = []) {
  const queue = [...errorSequence]
  const calls: Array<{ op: string; arg?: unknown }> = []
  const execute = async (fn: (trx: unknown) => Promise<unknown>) => {
    calls.push({ op: 'execute' })
    if (queue.length > 0) {
      const nextErr = queue.shift()
      if (nextErr) throw nextErr
    }
    return fn({ __stub: true })
  }
  const setIsolationLevel = (level: string) => {
    calls.push({ op: 'setIsolationLevel', arg: level })
    return { execute }
  }
  const transaction = () => {
    calls.push({ op: 'transaction' })
    return { setIsolationLevel }
  }
  return {
    db: { transaction } as any,
    calls,
  }
}

function makeOrderMockDb() {
  // Minimal mock sufficient for createOrder path — every chained builder
  // returns a proxy that resolves to `{ id: 'stub' }` on the terminal call.
  const chainable = (result: any): any =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return undefined
          if (prop === 'execute') return async () => [result]
          if (prop === 'executeTakeFirst') return async () => result
          if (prop === 'executeTakeFirstOrThrow')
            return async () => result ?? { id: 'stub' }
          return () => chainable(result)
        },
      },
    )

  const innerDb: any = {
    insertInto: () => chainable({ id: 'order-stub', shop_id: 'shop-a' }),
    selectFrom: () => chainable({ orders_count: 0 }),
    updateTable: () => chainable(null),
    deleteFrom: () => chainable(null),
  }

  const calls: Array<{ op: string; arg?: unknown }> = []
  const execute = async (fn: (trx: unknown) => Promise<unknown>) => {
    calls.push({ op: 'execute' })
    return fn(innerDb)
  }
  const setIsolationLevel = (level: string) => {
    calls.push({ op: 'setIsolationLevel', arg: level })
    return { execute }
  }
  const transaction = () => {
    calls.push({ op: 'transaction' })
    return { setIsolationLevel }
  }
  return {
    db: { transaction } as any,
    calls,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Phase 15 PR1 smoke — transaction isolation (SERIALIZABLE) ===\n')
  const { assert, summary } = makeAsserter()

  // -------------------------------------------------------------------------
  // [1..3] Happy path + SERIALIZABLE + trx handle
  // -------------------------------------------------------------------------
  console.log('[1..3] withSerializable happy path')
  {
    const { db, calls } = makeMockDb([])
    let passedTrx: unknown = null
    const result = await withSerializable(db, async (trx) => {
      passedTrx = trx
      return 'ok'
    })
    assert('[1] returns caller result unchanged', result === 'ok')
    assert(
      '[2] passed transactional handle to caller',
      passedTrx !== null && (passedTrx as any).__stub === true,
    )
    const isoCall = calls.find((c) => c.op === 'setIsolationLevel')
    assert(
      '[3] Kysely chain set isolationLevel="serializable"',
      !!isoCall && isoCall.arg === 'serializable',
    )
  }

  // -------------------------------------------------------------------------
  // [4..6] Retry classification
  // -------------------------------------------------------------------------
  console.log('\n[4..6] retry classification')
  {
    assert(
      '[4] 40001 (serialization_failure) is retryable',
      isRetryableSerializationError(pgError('40001')),
    )
    assert(
      '[5] 40P01 (deadlock_detected) is retryable',
      isRetryableSerializationError(pgError('40P01')),
    )
    assert(
      '[6] 23505 (unique_violation) is NOT retryable',
      !isRetryableSerializationError(pgError('23505')),
    )
  }

  // -------------------------------------------------------------------------
  // [7..9] Exhaustion + observability
  // -------------------------------------------------------------------------
  console.log('\n[7..9] retry exhaustion + onRetry hook')
  {
    // Retry until success on attempt 2
    const { db, calls } = makeMockDb([pgError('40001'), undefined])
    const result = await withSerializable(db, async () => 'ok', { baseDelayMs: 1 })
    assert('[7] retry-then-success recovers transparently', result === 'ok')
    const executeCount = calls.filter((c) => c.op === 'execute').length
    assert('[7b] execute called exactly 2 times', executeCount === 2, `got ${executeCount}`)

    // maxAttempts respected
    const { db: db2 } = makeMockDb([
      pgError('40001'),
      pgError('40001'),
      pgError('40001'),
    ])
    let thrown: Error | null = null
    try {
      await withSerializable(db2, async () => 'ok', { baseDelayMs: 1 })
    } catch (err) {
      thrown = err as Error
    }
    assert(
      '[8] exhausting maxAttempts propagates the final error',
      thrown !== null && thrown.message.includes('40001'),
    )

    // onRetry fires (maxAttempts - 1) times
    const { db: db3 } = makeMockDb([
      pgError('40001'),
      pgError('40001'),
      undefined,
    ])
    const attempts: number[] = []
    await withSerializable(db3, async () => 'ok', {
      baseDelayMs: 1,
      onRetry: (n) => attempts.push(n),
    })
    assert(
      '[9] onRetry invoked for each retry attempt (2 retries → 2 calls)',
      attempts.length === 2 && attempts[0] === 1 && attempts[1] === 2,
    )
  }

  // -------------------------------------------------------------------------
  // [10..11] createOrder integration
  // -------------------------------------------------------------------------
  console.log('\n[10..11] createOrder integration')
  {
    const { db, calls } = makeOrderMockDb()
    const result = await createOrder(db, 'shop-a', {
      line_items: [{ title: 'Test', quantity: 1, price: '10.00' }],
    })
    assert(
      '[10] createOrder returns an object with line_items array',
      !!result && Array.isArray((result as any).line_items),
    )
    const iso = calls.find((c) => c.op === 'setIsolationLevel')
    assert(
      '[11] createOrder transaction set to SERIALIZABLE',
      !!iso && iso.arg === 'serializable',
    )
  }

  // -------------------------------------------------------------------------
  // [12] Iron-rule 5 — no god-admin leaks in the helper source
  // -------------------------------------------------------------------------
  console.log('\n[12] iron-rule 5 leak scan on helper module')
  {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/core/src/modules/db/transaction.ts'),
      'utf8',
    )
    const forbidden = /\b(god[\s_-]?admin|\/god-admin\/)\b/i
    assert(
      '[12] transaction.ts contains no god-admin surface',
      !forbidden.test(src),
    )
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const { total, passed } = summary()
  console.log(`\n=== ${passed}/${total} checks passed ===`)
  if (passed !== total) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Smoke crashed:', err)
  process.exit(1)
})
