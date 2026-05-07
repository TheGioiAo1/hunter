/**
 * Gbox Platform — Gift Card Cron seed tests (Phase 10 PR2 follow-up)
 *
 * Covers the idempotency contract of seedGiftCardCronTasks:
 *   1. When `cron_tasks` has NO row whose handler matches, we INSERT
 *      one with the expected 5-minute schedule (see cron.ts) and
 *      report inserted=1, existing=0.
 *   2. When the row already exists, we SKIP the insert and report
 *      inserted=0, existing=1. The existing row's schedule is NOT
 *      touched — operators can change cadence via the admin UI
 *      without the boot seed stomping them.
 *
 * Kysely is mocked via a small chainable proxy so this runs without
 * Postgres. Pattern mirrors `abandoned-cart-cron.test.ts` §mockDb.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  GIFT_CARD_CRON_HANDLERS,
  seedGiftCardCronTasks,
} from './cron.js'

// ---------------------------------------------------------------------------
// Chainable DB stub — tracks the `.values()` call so we can assert on it
// ---------------------------------------------------------------------------

interface InsertCapture {
  values: Array<Record<string, unknown>>
}

function chainable(selectResult: any, insertCapture: InsertCapture) {
  const obj: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'execute') {
          return vi.fn().mockResolvedValue(Array.isArray(selectResult) ? selectResult : [])
        }
        if (prop === 'executeTakeFirst') {
          return vi.fn().mockResolvedValue(selectResult ?? null)
        }
        if (prop === 'values') {
          return (payload: Record<string, unknown>) => {
            insertCapture.values.push(payload)
            return obj
          }
        }
        return vi.fn().mockReturnValue(obj)
      },
    },
  )
  return obj
}

function mockDb(existingRow: { id: string } | null) {
  const insertCapture: InsertCapture = { values: [] }
  const db = {
    selectFrom: vi.fn().mockReturnValue(chainable(existingRow, insertCapture)),
    insertInto: vi.fn().mockReturnValue(chainable(null, insertCapture)),
  } as any
  return { db, insertCapture }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('seedGiftCardCronTasks', () => {
  it('inserts the process_pending_gift_cards row when absent', async () => {
    const { db, insertCapture } = mockDb(null)
    const result = await seedGiftCardCronTasks(db)

    expect(result).toEqual({ inserted: 1, existing: 0 })
    expect(insertCapture.values).toHaveLength(1)
    const payload = insertCapture.values[0]!
    expect(payload.handler).toBe(GIFT_CARD_CRON_HANDLERS.PROCESS_PENDING)
    expect(payload.handler).toBe('process_pending_gift_cards')
    expect(payload.schedule).toBe('*/5 * * * *')
    expect(payload.status).toBe('active')
    expect(typeof payload.next_run_at).toBe('string')
    expect(payload.name).toBe('Process scheduled gift-card emails')
  })

  it('is idempotent — skips insert when row already exists', async () => {
    const { db, insertCapture } = mockDb({ id: 'existing-row-id' })
    const result = await seedGiftCardCronTasks(db)

    expect(result).toEqual({ inserted: 0, existing: 1 })
    expect(insertCapture.values).toHaveLength(0)
    expect(db.insertInto).not.toHaveBeenCalled()
  })
})

describe('GIFT_CARD_CRON_HANDLERS constant', () => {
  it('exposes PROCESS_PENDING matching the handler name registered in cron/service.ts', () => {
    // This test fails the day someone renames the handler in ONE place
    // without updating the other. The handler name is a cross-file
    // contract; tie it down here.
    expect(GIFT_CARD_CRON_HANDLERS.PROCESS_PENDING).toBe(
      'process_pending_gift_cards',
    )
  })
})
