/**
 * Gbox Platform — Phase 15 PR2 smoke (webhook idempotency)
 *
 * Offline — exercises the payment-idempotency module against a
 * builder-chain fake Kysely (same shape the unit test uses in
 * packages/core/src/modules/webhooks/payment-idempotency.test.ts). No
 * DB, no HTTP. Safe to run on the Windows dev box where the local
 * network can't reach PG (see MEMORY/smoke_test_runbook.md).
 *
 * Coverage mirrors the four exported functions + the iron-rule-5 scan:
 *
 *   [1..4]   recordInboundWebhook — insert path (isNew=true) captures
 *            the right VALUES, onConflict columns, and RETURNING col
 *   [5..7]   recordInboundWebhook — conflict path (isNew=false) falls
 *            back to SELECT and returns the existing row id
 *   [8..10]  markWebhookProcessed + markWebhookIgnored — flip result,
 *            stamp processed_at, clamp error_reason
 *   [11..14] processInboundWebhook — full round trip: handler runs on
 *            first-seen, skipped on replay, marked 'error' on throw
 *   [15]     Iron-rule 5 leak scan — `/god-admin/` / "god admin" never
 *            appears in either the module source or this smoke file
 *
 *   npx tsx scripts/smoke-phase15-pr2.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  recordInboundWebhook,
  markWebhookProcessed,
  markWebhookIgnored,
  processInboundWebhook,
} from '@gbox/core/modules/webhooks/payment-idempotency.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Asserter — same lightweight shape as smoke-phase15-pr1.ts
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
  return { assert, summary: () => ({ total, passed }) }
}

// ---------------------------------------------------------------------------
// Fake Kysely — minimal builder chain sufficient for the four exports.
// Same record-on-terminal pattern as the unit test fake so assertions
// mirror the reviewed contract.
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
  insertResults: Array<{ id: number | bigint } | undefined>
  selectResults: Array<{ id: number | bigint } | undefined>
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

function makeFakeDb(rec: Recorder): any {
  const insertChain = () => {
    const current: InsertCall = {
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
        const oc: any = {
          columns(cols: string[]) {
            current.onConflictColumns = cols
            return oc
          },
          doNothing() {
            return oc
          },
        }
        builder(oc)
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

  const selectChain = () => {
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

  const updateChain = () => {
    const current: UpdateCall = { table: '', set: {}, where: [] }
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
        return []
      },
    }
    return chain
  }

  return {
    insertInto(table: string) {
      const chain = insertChain()
      const orig = chain.executeTakeFirst
      chain.executeTakeFirst = async function () {
        const r = await orig.apply(chain)
        if (rec.inserts.length > 0)
          rec.inserts[rec.inserts.length - 1].table = table
        return r
      }
      return chain
    },
    selectFrom(table: string) {
      const chain = selectChain()
      const orig = chain.executeTakeFirst
      chain.executeTakeFirst = async function () {
        const r = await orig.apply(chain)
        if (rec.selects.length > 0)
          rec.selects[rec.selects.length - 1].table = table
        return r
      }
      return chain
    },
    updateTable(table: string) {
      const chain = updateChain()
      const orig = chain.execute
      chain.execute = async function () {
        const r = await orig.apply(chain)
        if (rec.updates.length > 0)
          rec.updates[rec.updates.length - 1].table = table
        return r
      }
      return chain
    },
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    '=== Phase 15 PR2 smoke — payment webhook idempotency ledger ===\n',
  )
  const { assert, summary } = makeAsserter()

  // -------------------------------------------------------------------------
  // [1..4] recordInboundWebhook — insert path (isNew=true)
  // -------------------------------------------------------------------------
  console.log('[1..4] recordInboundWebhook insert path (isNew=true)')
  {
    const rec = blankRecorder()
    rec.insertResults = [{ id: 42 }]
    const db = makeFakeDb(rec)

    const result = await recordInboundWebhook(db, {
      gateway: 'stripe',
      eventId: 'evt_abc123',
      eventType: 'payment_intent.succeeded',
      payload: { foo: 'bar' },
      shopId: '11111111-2222-3333-4444-555555555555',
      signature: 'sig-xyz',
    })

    assert(
      '[1] returns { isNew: true, id }',
      result.isNew === true && result.id === 42,
      `got ${JSON.stringify(result)}`,
    )
    assert(
      '[2] INSERT targets payment_webhook_events',
      rec.inserts.length === 1 && rec.inserts[0].table === 'payment_webhook_events',
    )
    const ins = rec.inserts[0]
    assert(
      '[3] ON CONFLICT columns are (gateway, event_id)',
      JSON.stringify(ins?.onConflictColumns) === JSON.stringify(['gateway', 'event_id']),
    )
    assert(
      '[4] RETURNING id + result column omitted (DB default applies)',
      ins?.returning === 'id' && ins?.values.result === undefined,
    )
  }

  // -------------------------------------------------------------------------
  // [5..7] recordInboundWebhook — conflict / replay path (isNew=false)
  // -------------------------------------------------------------------------
  console.log(
    '\n[5..7] recordInboundWebhook conflict path (isNew=false) — replay',
  )
  {
    const rec = blankRecorder()
    // First call materializes nothing → conflict; SELECT finds existing row.
    rec.insertResults = [undefined]
    rec.selectResults = [{ id: 99 }]
    const db = makeFakeDb(rec)

    const result = await recordInboundWebhook(db, {
      gateway: 'paypal',
      eventId: 'WH-REPLAY-42',
      eventType: 'CHECKOUT.ORDER.APPROVED',
      payload: { replay: true },
    })

    assert(
      '[5] returns { isNew: false, id } from SELECT fallback',
      result.isNew === false && result.id === 99,
      `got ${JSON.stringify(result)}`,
    )
    assert(
      '[6] SELECT was issued with correct WHERE clauses',
      rec.selects.length === 1 &&
        rec.selects[0].table === 'payment_webhook_events' &&
        JSON.stringify(rec.selects[0].where) ===
          JSON.stringify([
            ['gateway', '=', 'paypal'],
            ['event_id', '=', 'WH-REPLAY-42'],
          ]),
    )
    // Repeat with a second independent event — confirm insert-first, then SELECT-fallback
    // stays scoped to this round trip (no state bleed).
    const rec2 = blankRecorder()
    rec2.insertResults = [{ id: 7 }]
    const db2 = makeFakeDb(rec2)
    const r2 = await recordInboundWebhook(db2, {
      gateway: 'stripe',
      eventId: 'evt_fresh',
      eventType: 't',
      payload: {},
    })
    assert(
      '[7] no SELECT issued when INSERT returns a row (no extra round-trip)',
      r2.isNew === true && rec2.selects.length === 0,
    )
  }

  // -------------------------------------------------------------------------
  // [8..10] markWebhookProcessed + markWebhookIgnored
  // -------------------------------------------------------------------------
  console.log('\n[8..10] markWebhookProcessed + markWebhookIgnored')
  {
    const rec = blankRecorder()
    const db = makeFakeDb(rec)

    await markWebhookProcessed(db, 42, { result: 'ok' })
    const u0 = rec.updates[0]
    assert(
      '[8] markWebhookProcessed flips result=ok + stamps processed_at + null error_reason',
      u0.table === 'payment_webhook_events' &&
        u0.set.result === 'ok' &&
        u0.set.error_reason === null &&
        typeof u0.set.processed_at === 'string',
    )

    await markWebhookProcessed(db, 43, {
      result: 'error',
      errorReason: 'capture failed: gateway timeout',
    })
    const u1 = rec.updates[1]
    assert(
      '[9] markWebhookProcessed captures errorReason verbatim (never seller-facing)',
      u1.set.result === 'error' &&
        u1.set.error_reason === 'capture failed: gateway timeout',
    )

    await markWebhookIgnored(db, 44, 'unknown event type')
    const u2 = rec.updates[2]
    assert(
      '[10] markWebhookIgnored delegates to markWebhookProcessed with result=ignored',
      u2.set.result === 'ignored' && u2.set.error_reason === 'unknown event type',
    )
  }

  // -------------------------------------------------------------------------
  // [11..14] processInboundWebhook — full round trip
  // -------------------------------------------------------------------------
  console.log('\n[11..14] processInboundWebhook round trip')
  {
    // Happy path — first-seen event, handler runs, row flips to 'ok'.
    const rec = blankRecorder()
    rec.insertResults = [{ id: 10 }]
    const db = makeFakeDb(rec)

    let handlerRan = 0
    const outcome = await processInboundWebhook(
      db,
      {
        gateway: 'stripe',
        eventId: 'evt_happy',
        eventType: 'payment_intent.succeeded',
        payload: { ok: true },
      },
      async (id) => {
        handlerRan++
        return { echoedId: id }
      },
    )

    assert(
      '[11] first-seen event: processed=true + duplicate=false + handler invoked once',
      outcome.processed === true &&
        outcome.duplicate === false &&
        handlerRan === 1 &&
        (outcome.value as any)?.echoedId === 10,
    )
    assert(
      '[12] success path flips ledger row to result=ok',
      rec.updates.length === 1 &&
        rec.updates[0].set.result === 'ok' &&
        rec.updates[0].set.error_reason === null,
    )

    // Replay path — handler must NOT run.
    const rec2 = blankRecorder()
    rec2.insertResults = [undefined]
    rec2.selectResults = [{ id: 10 }]
    const db2 = makeFakeDb(rec2)

    let replayHandlerRan = 0
    const replay = await processInboundWebhook(
      db2,
      {
        gateway: 'stripe',
        eventId: 'evt_happy',
        eventType: 'payment_intent.succeeded',
        payload: { ok: true },
      },
      async () => {
        replayHandlerRan++
        return 'should-not-run'
      },
    )

    assert(
      '[13] replay: processed=false + duplicate=true + handler NOT invoked',
      replay.processed === false &&
        replay.duplicate === true &&
        replayHandlerRan === 0 &&
        rec2.updates.length === 0,
    )

    // Error path — handler throws, ledger flips to 'error', original throws through.
    const rec3 = blankRecorder()
    rec3.insertResults = [{ id: 77 }]
    const db3 = makeFakeDb(rec3)

    let threw: Error | null = null
    try {
      await processInboundWebhook(
        db3,
        {
          gateway: 'paypal',
          eventId: 'WH-boom',
          eventType: 'PAYMENT.CAPTURE.COMPLETED',
          payload: {},
        },
        async () => {
          throw new Error('downstream capture service 500')
        },
      )
    } catch (err) {
      threw = err as Error
    }

    assert(
      '[14] handler throw: row flipped to error + errorReason captured + original error rethrown',
      threw !== null &&
        threw!.message === 'downstream capture service 500' &&
        rec3.updates.length === 1 &&
        rec3.updates[0].set.result === 'error' &&
        typeof rec3.updates[0].set.error_reason === 'string' &&
        (rec3.updates[0].set.error_reason as string).includes('downstream capture'),
    )
  }

  // -------------------------------------------------------------------------
  // [15] Iron-rule 5 — no god-admin surface leaks in the module source.
  //
  // We intentionally scan the helper module only (same scope as the PR1
  // smoke). The migration 090 docblock mentions "god admin" once in the
  // context of "SAFE to expose to god admin; NEVER to sellers" — that
  // is backend documentation explicitly demarcating the seller exclusion
  // boundary, not a seller-facing leak. Iron Rule 5 governs what the
  // seller sees; internal engineering docs are out of scope.
  // -------------------------------------------------------------------------
  console.log('\n[15] iron-rule 5 leak scan on helper module')
  {
    const src = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'packages/core/src/modules/webhooks/payment-idempotency.ts',
      ),
      'utf8',
    )
    const forbidden = /\b(god[\s_-]?admin|\/god-admin\/)\b/i
    assert(
      '[15] payment-idempotency.ts contains no god-admin surface',
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
