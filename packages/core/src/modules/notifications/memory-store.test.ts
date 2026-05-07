/**
 * Tests for the in-memory notification store (Phase 2 Step 2.11).
 *
 * These tests define the contract every backing store must honor —
 * when the Postgres implementation lands, it should be able to pass
 * the same asserts with the same inputs.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryNotificationStore } from './memory-store.js'
import type { NewNotification } from './types.js'

let store: MemoryNotificationStore

beforeEach(() => {
  store = new MemoryNotificationStore()
})

function makeInput(overrides: Partial<NewNotification> = {}): NewNotification {
  return {
    userId: 'user-1',
    kind: 'info',
    category: 'system',
    title: 'Welcome',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('create', () => {
  it('persists a new row with a generated id and timestamp', async () => {
    const row = await store.create(makeInput())
    expect(row.id).toBeDefined()
    expect(row.id.length).toBeGreaterThan(0)
    expect(row.read).toBe(false)
    expect(row.createdAt).toBeDefined()
    expect(() => new Date(row.createdAt)).not.toThrow()
  })

  it('defaults shopId to null', async () => {
    const row = await store.create(makeInput())
    expect(row.shopId).toBeNull()
  })

  it('preserves shopId when provided', async () => {
    const row = await store.create(makeInput({ shopId: 'shop-42' }))
    expect(row.shopId).toBe('shop-42')
  })

  it('generates a unique id for each row', async () => {
    const a = await store.create(makeInput())
    const b = await store.create(makeInput())
    expect(a.id).not.toBe(b.id)
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  it('returns empty for an unknown user', async () => {
    await store.create(makeInput({ userId: 'someone-else' }))
    const rows = await store.list('user-1')
    expect(rows).toEqual([])
  })

  it('filters to the requested user', async () => {
    await store.create(makeInput({ userId: 'user-1', title: 'A' }))
    await store.create(makeInput({ userId: 'user-2', title: 'B' }))
    const rows = await store.list('user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('A')
  })

  it('returns newest first', async () => {
    const a = await store.create(makeInput({ title: 'Old' }))
    // Force a different timestamp by advancing the clock one tick.
    await new Promise(r => setTimeout(r, 5))
    const b = await store.create(makeInput({ title: 'New' }))
    const rows = await store.list('user-1')
    expect(rows[0].id).toBe(b.id)
    expect(rows[1].id).toBe(a.id)
  })

  it('honors unreadOnly filter', async () => {
    const a = await store.create(makeInput({ title: 'A' }))
    await store.create(makeInput({ title: 'B' }))
    await store.markRead(a.id)
    const rows = await store.list('user-1', { unreadOnly: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('B')
  })

  it('honors category filter', async () => {
    await store.create(makeInput({ category: 'billing', title: 'Bill' }))
    await store.create(makeInput({ category: 'security', title: 'Sec' }))
    const rows = await store.list('user-1', { category: 'billing' })
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Bill')
  })

  it('clamps limit to [1, 100]', async () => {
    for (let i = 0; i < 5; i += 1) {
      await store.create(makeInput({ title: `N${i}` }))
    }
    const rows = await store.list('user-1', { limit: 2 })
    expect(rows).toHaveLength(2)
  })

  it('applies offset for simple pagination', async () => {
    for (let i = 0; i < 5; i += 1) {
      await store.create(makeInput({ title: `N${i}` }))
      await new Promise(r => setTimeout(r, 2))
    }
    const first = await store.list('user-1', { limit: 2, offset: 0 })
    const second = await store.list('user-1', { limit: 2, offset: 2 })
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(first[0].id).not.toBe(second[0].id)
  })
})

// ---------------------------------------------------------------------------
// get / remove
// ---------------------------------------------------------------------------

describe('get + remove', () => {
  it('get returns the row by id', async () => {
    const row = await store.create(makeInput())
    const fetched = await store.get(row.id)
    expect(fetched?.id).toBe(row.id)
  })

  it('get returns null for unknown id', async () => {
    expect(await store.get('nope')).toBeNull()
  })

  it('remove deletes the row and returns true', async () => {
    const row = await store.create(makeInput())
    expect(await store.remove(row.id)).toBe(true)
    expect(await store.get(row.id)).toBeNull()
  })

  it('remove returns false for unknown id', async () => {
    expect(await store.remove('nope')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// markRead / markAllRead
// ---------------------------------------------------------------------------

describe('markRead + markAllRead', () => {
  it('markRead flips the flag and returns true', async () => {
    const row = await store.create(makeInput())
    expect(row.read).toBe(false)
    expect(await store.markRead(row.id)).toBe(true)
    const fresh = await store.get(row.id)
    expect(fresh?.read).toBe(true)
  })

  it('markRead is idempotent', async () => {
    const row = await store.create(makeInput())
    await store.markRead(row.id)
    expect(await store.markRead(row.id)).toBe(true)
  })

  it('markRead returns false for unknown id', async () => {
    expect(await store.markRead('nope')).toBe(false)
  })

  it('markAllRead marks only the target user', async () => {
    await store.create(makeInput({ userId: 'user-1' }))
    await store.create(makeInput({ userId: 'user-1' }))
    await store.create(makeInput({ userId: 'user-2' }))
    const n = await store.markAllRead('user-1')
    expect(n).toBe(2)
    const u2 = await store.list('user-2', { unreadOnly: true })
    expect(u2).toHaveLength(1)
  })

  it('markAllRead returns 0 when nothing is unread', async () => {
    const row = await store.create(makeInput())
    await store.markRead(row.id)
    expect(await store.markAllRead('user-1')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

describe('summary', () => {
  it('returns zero counts for an unknown user', async () => {
    expect(await store.summary('ghost')).toEqual({ total: 0, unread: 0 })
  })

  it('counts total and unread per user', async () => {
    const a = await store.create(makeInput())
    await store.create(makeInput())
    await store.create(makeInput({ userId: 'other' }))
    expect(await store.summary('user-1')).toEqual({ total: 2, unread: 2 })
    await store.markRead(a.id)
    expect(await store.summary('user-1')).toEqual({ total: 2, unread: 1 })
  })
})

// ---------------------------------------------------------------------------
// clear (test helper)
// ---------------------------------------------------------------------------

describe('clear', () => {
  it('wipes all rows', async () => {
    await store.create(makeInput())
    await store.create(makeInput())
    store.clear()
    expect(await store.summary('user-1')).toEqual({ total: 0, unread: 0 })
  })
})
