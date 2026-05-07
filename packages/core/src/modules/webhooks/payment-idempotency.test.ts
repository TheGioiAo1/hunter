/**
 * Gbox Platform — Payment Webhook Idempotency Unit Tests (Phase 15 PR2)
 *
 * Validates the dedup chokepoint used by every inbound payment gateway
 * webhook handler (PayPal, Stripe, Airwallex). Focus:
 *
 *   - recordInboundWebhook returns {isNew: true} when INSERT materializes
 *   - recordInboundWebhook returns {isNew: false} when gateway replays
 *     the same (gateway, event_id)
 *   - processInboundWebhook runs side-effects on first seen, skips on
 *     replay, marks result='error' on throw, always surfaces caller error
 *   - markWebhookProcessed + markWebhookIgnored flip result/processed_at
 *   - Iron Rule 5: no god-admin / path leaks in any code path
 *
 * The module uses Kysely's builder API (insertInto(...).onConflict(...)
 * .doNothing().returning('id').executeTakeFirst() + selectFrom / updateTable
 * for the other paths). We stub each chain method and capture the final
 * call payload per operation.
 */

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  recordInboundWebhook,
  markWebhookProcessed,
  markWebhookIgnored,
  processInboundWebhook,
} from './payment-idempotency.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Fake Kysely that records builder calls and returns canned terminal results.
// ---------------------------------------------------------------------------

interface InsertCall {
  table: string
  values: Record<string, unknown>
  onConflictColumns: string[] | null
  returning: string | null
}

interface SelectCall {
  table: string
  selected: string[]
  where: Array<[string, string, unknown]>
}

interface UpdateCall {
  table: string
  set: Record<string, unknown>
  where: Array<[string, string, unknown]>
}

interface Recorder {
  inserts: InsertCall[]
  selects: SelectCall[]
  updates: UpdateCall[]
  /** Canned results for executeTakeFirst / execute, shift'd per terminal. */
  insertResults: Array<{ id: number | bigint } | undefined>
  selectResults: Array<{ id: number | bigint } | undefined>
  /** When truthy, the next UPDATE execute() throws this error. */
  updateErrorOnCallIndex?: number
}

function makeFakeDb(rec: Recorder) {
  const insertChain = (): any => {
    let current: InsertCall = {
      table: '',
      values: {},
      onConflictColumns: null,
      returning: null,
    }
    const chain: any = {
      values(v: Record<string, unknown>) {
        current.values = v
        return chain
      },
      onConflict(builder: any) {
        const ocBuilder: any = {
          columns(cols: string[]) {
            current.onConflictColumns = cols
            return ocBuilder
          },
          doNothing() {
            return ocBuilder
          },
        }
        builder(ocBuilder)
        return chain
      },
      returning(col: string) {
        current.returning = col
        return chain
      },
      async executeTakeFirst() {
        rec.inserts.push(current)
        return rec.insertResults.shift()
      },
    }
    return chain
  }

  const selectChain = (): any => {
    const current: SelectCall = { table: '', selected: [], where: [] }
    const chain: any = {
      select(col: string) {
        current.selected.push(col)
        return chain
      },
      where(col: string, op: string, val: unknown) {
        current.where.push([col, op, val])
        return chain
      },
      async executeTakeFirst() {
        rec.selects.push(current)
        return rec.selectResults.shift()
      },
    }
    return chain
  }

  const updateChain = (): any => {
    const current: UpdateCall = { table: '', set: {}, where: [] }
    let thrownError: Error | null = null
    const chain: any = {
      set(v: Record<string, unknown>) {
        current.set = v
        return chain
      },
      where(col: string, op: string, val: unknown) {
        current.where.push([col, op, val])
        return chain
      },
      async execute() {
        rec.updates.push(current)
        if (
          rec.updateErrorOnCallIndex !== undefined &&
          rec.updates.length === rec.updateErrorOnCallIndex
        ) {
          thrownError = new Error('update db offline')
        }
        if (thrownError) throw thrownError
        return []
      },
    }
    return chain
  }

  return {
    insertInto(table: string) {
      const chain = insertChain()
      // Capture the table name so assertions can verify it.
      const wrapped: any = new Proxy(chain, {
        get(t, prop, r) {
          if (prop === 'values') {
            return (v: Record<string, unknown>) => {
              // First call wraps target current-call's table
              ;(t.values as any)(v)
              // Hack: stash table on the last insert after push
              // — easier: attach on the executeTakeFirst step.
              return wrapped
            }
          }
          return Reflect.get(t, prop, r)
        },
      })
      // Cleaner approach: override executeTakeFirst to tag table.
      const origExec = chain.executeTakeFirst
      chain.executeTakeFirst = async function () {
        const result = await origExec.apply(chain)
        if (rec.inserts.length > 0) {
          rec.inserts[rec.inserts.length - 1].table = table
        }
        return result
      }
      return chain
    },
    selectFrom(table: string) {
      const chain = selectChain()
      const origExec = chain.executeTakeFirst
      chain.executeTakeFirst = async function () {
        const result = await origExec.apply(chain)
        if (rec.selects.length > 0) {
          rec.selects[rec.selects.length - 1].table = table
        }
        return result
      }
      return chain
    },
    updateTable(table: string) {
      const chain = updateChain()
      const origExec = chain.execute
      chain.execute = async function () {
        const result = await origExec.apply(chain)
        if (rec.updates.length > 0) {
          rec.updates[rec.updates.length - 1].table = table
        }
        return result
      }
      return chain
    },
  } as any
}

function blankRecorder(): Recorder {
  return {
    inserts: [],
    selects: [],
    updates: [],
    insertResults: [],
    selectResults: [],
  }
}

// ---------------------------------------------------------------------------
// recordInboundWebhook
// ---------------------------------------------------------------------------

describe('recordInboundWebhook', () => {
  it('returns isNew=true and id when INSERT materializes the row', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 42 }]
    const db = makeFakeDb(rec)

    const result = await recordInboundWebhook(db, {
      gateway: 'stripe',
      eventId: 'evt_abc',
      eventType: 'payment_intent.succeeded',
      payload: { foo: 'bar' },
      shopId: '11111111-2222-3333-4444-555555555555',
      signature: 'sig-xyz',
    })

    expect(result).toEqual({ isNew: true, id: 42 })
    expect(rec.inserts).toHaveLength(1)
    const ins = rec.inserts[0]
    expect(ins.table).toBe('payment_webhook_events')
    expect(ins.values).toMatchObject({
      gateway: 'stripe',
      event_id: 'evt_abc',
      event_type: 'payment_intent.succeeded',
      shop_id: '11111111-2222-3333-4444-555555555555',
      signature: 'sig-xyz',
    })
    expect(ins.onConflictColumns).toEqual(['gateway', 'event_id'])
    expect(ins.returning).toBe('id')
    // No SELECT fallback needed when INSERT returned a row.
    expect(rec.selects).toHaveLength(0)
  })

  it('returns isNew=false and looks up existing id on conflict', async () => {
    const rec = blankRecorder()
    rec.insertResults = [undefined] // conflict → INSERT returns nothing
    rec.selectResults = [{ id: 99 }]
    const db = makeFakeDb(rec)

    const result = await recordInboundWebhook(db, {
      gateway: 'paypal',
      eventId: 'WH-duplicate',
      eventType: 'CHECKOUT.ORDER.APPROVED',
      payload: { duplicate: true },
    })

    expect(result).toEqual({ isNew: false, id: 99 })
    expect(rec.inserts).toHaveLength(1)
    expect(rec.selects).toHaveLength(1)
    const sel = rec.selects[0]
    expect(sel.table).toBe('payment_webhook_events')
    expect(sel.selected).toContain('id')
    expect(sel.where).toEqual([
      ['gateway', '=', 'paypal'],
      ['event_id', '=', 'WH-duplicate'],
    ])
  })

  it('throws when both INSERT and SELECT return nothing (schema drift)', async () => {
    const rec = blankRecorder()
    rec.insertResults = [undefined]
    rec.selectResults = [undefined]
    const db = makeFakeDb(rec)

    await expect(
      recordInboundWebhook(db, {
        gateway: 'airwallex',
        eventId: 'evt-ghost',
        eventType: 'payment.succeeded',
        payload: {},
      }),
    ).rejects.toThrow(/schema drift|0 rows/i)
  })

  it('serializes payload as JSON string', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 1 }]
    const db = makeFakeDb(rec)

    await recordInboundWebhook(db, {
      gateway: 'stripe',
      eventId: 'evt_json',
      eventType: 't',
      payload: { a: 1, b: [2, 3] },
    })

    expect(rec.inserts[0].values.raw_payload).toBe('{"a":1,"b":[2,3]}')
  })

  it('handles unserialisable payload (cyclic refs) without crashing', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 1 }]
    const db = makeFakeDb(rec)

    const cyclic: any = { ref: null }
    cyclic.ref = cyclic

    const out = await recordInboundWebhook(db, {
      gateway: 'stripe',
      eventId: 'evt_cyclic',
      eventType: 't',
      payload: cyclic,
    })

    expect(out).toEqual({ isNew: true, id: 1 })
    const serialized = rec.inserts[0].values.raw_payload as string
    expect(serialized).toContain('__serialization_failed')
  })

  it('accepts null shopId for platform-scoped events', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 7 }]
    const db = makeFakeDb(rec)

    const result = await recordInboundWebhook(db, {
      gateway: 'stripe',
      eventId: 'evt_platform',
      eventType: 'account.updated',
      payload: {},
      shopId: null,
    })

    expect(result.isNew).toBe(true)
    expect(rec.inserts[0].values.shop_id).toBeNull()
  })

  it('coerces BigInt id to JavaScript number', async () => {
    // Pg returns BIGSERIAL as string/BigInt depending on driver; the
    // helper must normalize so downstream code sees a plain number.
    const rec = blankRecorder()
    rec.insertResults = [{ id: BigInt(123) }]
    const db = makeFakeDb(rec)

    const result = await recordInboundWebhook(db, {
      gateway: 'stripe',
      eventId: 'evt',
      eventType: 't',
      payload: {},
    })

    expect(typeof result.id).toBe('number')
    expect(result.id).toBe(123)
  })

  it('omits result from INSERT so DB default (pending) applies', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 1 }]
    const db = makeFakeDb(rec)

    await recordInboundWebhook(db, {
      gateway: 'stripe',
      eventId: 'e',
      eventType: 't',
      payload: {},
    })
    // The ledger row is created with the DB default 'pending' — if we
    // ever set it explicitly in VALUES, a migration drift could silently
    // mark replays as 'ok'. Keep this assertion tight.
    expect(rec.inserts[0].values.result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// markWebhookProcessed
// ---------------------------------------------------------------------------

describe('markWebhookProcessed', () => {
  it('flips result to ok with no error_reason', async () => {
    const rec = blankRecorder()
    const db = makeFakeDb(rec)
    await markWebhookProcessed(db, 42, { result: 'ok' })
    expect(rec.updates).toHaveLength(1)
    const u = rec.updates[0]
    expect(u.table).toBe('payment_webhook_events')
    expect(u.set).toMatchObject({
      result: 'ok',
      error_reason: null,
    })
    expect(typeof u.set.processed_at).toBe('string')
    expect(u.where).toEqual([['id', '=', 42]])
  })

  it('stores error_reason for forensics', async () => {
    const rec = blankRecorder()
    const db = makeFakeDb(rec)
    await markWebhookProcessed(db, 7, {
      result: 'error',
      errorReason: 'downstream timed out',
    })
    expect(rec.updates[0].set.result).toBe('error')
    expect(rec.updates[0].set.error_reason).toBe('downstream timed out')
  })
})

// ---------------------------------------------------------------------------
// markWebhookIgnored
// ---------------------------------------------------------------------------

describe('markWebhookIgnored', () => {
  it('flips result to ignored with reason stored in error_reason', async () => {
    const rec = blankRecorder()
    const db = makeFakeDb(rec)
    await markWebhookIgnored(db, 55, 'event type not wired in this phase')
    expect(rec.updates[0].set.result).toBe('ignored')
    expect(rec.updates[0].set.error_reason).toBe(
      'event type not wired in this phase',
    )
  })
})

// ---------------------------------------------------------------------------
// processInboundWebhook
// ---------------------------------------------------------------------------

describe('processInboundWebhook', () => {
  it('runs handler and marks ok on first seen event', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 1 }]
    const db = makeFakeDb(rec)

    const handler = vi.fn(async (_id: number) => 'side-effect-result')
    const outcome = await processInboundWebhook(
      db,
      {
        gateway: 'stripe',
        eventId: 'evt_first',
        eventType: 'payment_intent.succeeded',
        payload: {},
      },
      handler,
    )

    expect(outcome).toEqual({
      processed: true,
      duplicate: false,
      value: 'side-effect-result',
      id: 1,
    })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0]).toBe(1)
    expect(rec.updates[0].set.result).toBe('ok')
  })

  it('skips handler and returns duplicate=true on replay', async () => {
    const rec = blankRecorder()
    rec.insertResults = [undefined]          // conflict
    rec.selectResults = [{ id: 2 }]           // existing row
    const db = makeFakeDb(rec)

    const handler = vi.fn(async () => 'should-not-run')
    const outcome = await processInboundWebhook(
      db,
      {
        gateway: 'paypal',
        eventId: 'WH-replay',
        eventType: 't',
        payload: {},
      },
      handler,
    )

    expect(outcome.processed).toBe(false)
    expect(outcome.duplicate).toBe(true)
    expect(outcome.value).toBeUndefined()
    expect(outcome.id).toBe(2)
    expect(handler).not.toHaveBeenCalled()
    expect(rec.updates).toHaveLength(0) // no UPDATE on dup path
  })

  it('marks result=error and rethrows when handler throws', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 3 }]
    const db = makeFakeDb(rec)

    const handler = vi.fn(async () => {
      throw new Error('fulfilment pipeline boom')
    })

    await expect(
      processInboundWebhook(
        db,
        {
          gateway: 'stripe',
          eventId: 'evt_err',
          eventType: 't',
          payload: {},
        },
        handler,
      ),
    ).rejects.toThrow(/fulfilment pipeline boom/)

    expect(handler).toHaveBeenCalledOnce()
    expect(rec.updates).toHaveLength(1)
    expect(rec.updates[0].set.result).toBe('error')
    expect(rec.updates[0].set.error_reason).toContain('fulfilment pipeline boom')
  })

  it('does not swallow original error if markWebhookProcessed itself fails', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 4 }]
    rec.updateErrorOnCallIndex = 1 // first UPDATE throws
    const db = makeFakeDb(rec)

    const handler = vi.fn(async () => {
      throw new Error('primary failure')
    })

    await expect(
      processInboundWebhook(
        db,
        {
          gateway: 'stripe',
          eventId: 'evt_double_fail',
          eventType: 't',
          payload: {},
        },
        handler,
      ),
    ).rejects.toThrow(/primary failure/)
    // The original handler error bubbles up even when the UPDATE path
    // also fails — the secondary failure is swallowed.
  })

  it('truncates long error_reason to 2000 chars', async () => {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 5 }]
    const db = makeFakeDb(rec)

    const long = 'x'.repeat(5000)
    const handler = async () => {
      throw new Error(long)
    }

    await expect(
      processInboundWebhook(
        db,
        {
          gateway: 'stripe',
          eventId: 'evt_long',
          eventType: 't',
          payload: {},
        },
        handler,
      ),
    ).rejects.toThrow()

    const reason = rec.updates[0].set.error_reason as string
    expect(typeof reason).toBe('string')
    expect(reason.length).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// Iron Rule 5 — no god-admin leaks in the source
// ---------------------------------------------------------------------------

describe('Iron Rule 5 — seller-facing leak safety', () => {
  it('module source code (excluding comments) contains no god-admin surface', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'payment-idempotency.ts'),
      'utf8',
    )
    const forbidden = /\b(god[\s_-]?admin|\/god-admin\/)\b/i
    // The doc-comment mentions "god admin" historically, but we migrated
    // to "platform-operator" wording for the public docstring in favor
    // of future-safe language. Any occurrence now (even in comments)
    // is a bug.
    expect(forbidden.test(src)).toBe(false)
  })
})
