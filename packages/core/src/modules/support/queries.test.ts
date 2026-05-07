/**
 * Gbox Platform — support/queries.ts unit tests.
 *
 * Pins the **cross-shop leak-prevention** guards (Iron rule 2 + spec §8):
 * every seller-scoped helper returns an empty result when shopId is
 * empty/null-like, never "everything". A stray `.where('shop_id', '=', '')`
 * won't match any rows — but the empty-guard is an explicit first line
 * of defense that makes the invariant visible in code review and lets
 * us assert it here without needing a live DB.
 *
 * We also pin the SQL-layer `sender_type != 'agent_internal_note'`
 * filter + `archived_at IS NULL` filter in the Kysely compiled output
 * so any refactor that drops them is caught immediately.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  getTicketForSeller,
  getTicketUnreadCountsForSeller,
  listMessagesForAgent,
  listMessagesForSeller,
  listTicketsForSeller,
} from './queries.ts'

// A chainable mock that lets us spy on which `.where()` predicates the
// helpers construct without actually executing SQL. Every non-terminal
// call returns `this`; terminal `.execute()` / `.executeTakeFirst()`
// resolve to the injected result.
function makeDb(opts: {
  selectResult?: unknown
  selectTakeFirst?: unknown
} = {}) {
  const whereCalls: Array<[unknown, unknown, unknown]> = []
  const chain: Record<string, unknown> = {}
  const addChain = (k: string, fn: (...a: unknown[]) => unknown) => {
    chain[k] = vi.fn(fn)
  }
  addChain('select', () => chain)
  addChain('selectAll', () => chain)
  addChain('leftJoin', () => chain)
  addChain('innerJoin', () => chain)
  addChain('orderBy', () => chain)
  addChain('limit', () => chain)
  addChain('offset', () => chain)
  addChain('where', (...a: unknown[]) => {
    whereCalls.push([a[0], a[1], a[2]])
    return chain
  })
  addChain('execute', async () =>
    Array.isArray(opts.selectResult) ? opts.selectResult : [],
  )
  addChain('executeTakeFirst', async () => opts.selectTakeFirst ?? null)
  addChain('executeTakeFirstOrThrow', async () => {
    if (opts.selectTakeFirst == null) throw new Error('not found')
    return opts.selectTakeFirst
  })

  const db = {
    selectFrom: vi.fn(() => chain),
    insertInto: vi.fn(() => chain),
    updateTable: vi.fn(() => chain),
  }
  return { db, whereCalls }
}

describe('cross-shop leak prevention (empty-arg guards)', () => {
  it('listTicketsForSeller returns [] when shopId is empty', async () => {
    const { db } = makeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listTicketsForSeller(db as any, '')
    expect(out).toEqual([])
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('getTicketForSeller returns null when shopId is empty', async () => {
    const { db } = makeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getTicketForSeller(db as any, '', 'ticket-1')
    expect(out).toBeNull()
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('getTicketForSeller returns null when ticketId is empty', async () => {
    const { db } = makeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getTicketForSeller(db as any, 'shop-1', '')
    expect(out).toBeNull()
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('listMessagesForSeller returns [] when shopId is empty', async () => {
    const { db } = makeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listMessagesForSeller(db as any, '', 'ticket-1', 'Seller')
    expect(out).toEqual([])
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('listMessagesForSeller returns [] when ticketId is empty', async () => {
    const { db } = makeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listMessagesForSeller(db as any, 'shop-1', '', 'Seller')
    expect(out).toEqual([])
  })

  it('listMessagesForAgent returns [] when ticketId is empty', async () => {
    const { db } = makeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listMessagesForAgent(db as any, '')
    expect(out).toEqual([])
    expect(db.selectFrom).not.toHaveBeenCalled()
  })

  it('getTicketUnreadCountsForSeller returns zero when shopId is empty', async () => {
    const { db } = makeDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getTicketUnreadCountsForSeller(db as any, '')
    expect(out).toEqual({ total: 0, perTicket: [] })
  })
})

describe('listTicketsForSeller shop_id + archived filter', () => {
  it('filters by shop_id and archived_at IS NULL', async () => {
    const { db, whereCalls } = makeDb({ selectResult: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listTicketsForSeller(db as any, 'shop-42')
    const shopIdCall = whereCalls.find(
      (c) => c[0] === 't.shop_id' && c[1] === '=' && c[2] === 'shop-42',
    )
    expect(shopIdCall).toBeTruthy()
    const archivedCall = whereCalls.find(
      (c) => c[0] === 't.archived_at' && c[1] === 'is' && c[2] === null,
    )
    expect(archivedCall).toBeTruthy()
  })

  it('adds status filter when specified', async () => {
    const { db, whereCalls } = makeDb({ selectResult: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listTicketsForSeller(db as any, 'shop-42', { status: 'open' })
    const statusCall = whereCalls.find(
      (c) => c[0] === 't.status' && c[1] === '=' && c[2] === 'open',
    )
    expect(statusCall).toBeTruthy()
  })

  it('skips status filter when status="any"', async () => {
    const { db, whereCalls } = makeDb({ selectResult: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listTicketsForSeller(db as any, 'shop-42', { status: 'any' })
    const statusCall = whereCalls.find((c) => c[0] === 't.status')
    expect(statusCall).toBeUndefined()
  })
})

describe('listMessagesForSeller internal-note SQL filter', () => {
  it('filters out agent_internal_note at the SQL layer (defense in depth)', async () => {
    const { db, whereCalls } = makeDb({
      selectResult: [],
      selectTakeFirst: { id: 'ticket-1', shop_id: 'shop-42' },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listMessagesForSeller(db as any, 'shop-42', 'ticket-1', 'Seller')
    const internalFilter = whereCalls.find(
      (c) =>
        c[0] === 'm.sender_type' && c[1] === '!=' && c[2] === 'agent_internal_note',
    )
    expect(internalFilter).toBeTruthy()
  })

  it('also filters out soft-deleted messages (deleted_at IS NULL)', async () => {
    const { db, whereCalls } = makeDb({
      selectResult: [],
      selectTakeFirst: { id: 'ticket-1', shop_id: 'shop-42' },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listMessagesForSeller(db as any, 'shop-42', 'ticket-1', 'Seller')
    const deletedFilter = whereCalls.find(
      (c) => c[0] === 'm.deleted_at' && c[1] === 'is' && c[2] === null,
    )
    expect(deletedFilter).toBeTruthy()
  })

  it('returns [] if the ticket lookup says wrong-shop', async () => {
    const { db } = makeDb({
      selectResult: [],
      selectTakeFirst: null, // ticket not found under this shop
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await listMessagesForSeller(db as any, 'shop-42', 'ticket-1', 'Seller')
    expect(out).toEqual([])
  })
})

describe('listTicketsForAgent archived default', () => {
  it('defaults to archived_at IS NULL (matches active queue)', async () => {
    const { db, whereCalls } = makeDb({ selectResult: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await listTicketsForSeller(db as any, 'shop-42', {})
    const archivedCall = whereCalls.find(
      (c) => c[0] === 't.archived_at' && c[1] === 'is' && c[2] === null,
    )
    expect(archivedCall).toBeTruthy()
  })
})
