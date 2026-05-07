/**
 * Store-admin — `postMarkAllSeen` handler tests (April 2026 notification fix).
 *
 * POST /admin/store/:slug/notifications/mark-seen
 *
 * Thai reported the red bell badge never cleared even after the seller
 * opened the drawer — because nothing on the client ever told the server
 * those notifications had been seen. The existing `postMarkAllRead`
 * redirects to the full notifications page (form POST), so the bell-
 * drawer JS can't reuse it without navigating away.
 *
 * This handler is the JSON-returning sibling: fetch-friendly, same DB
 * update, no redirect. The drawer `toggleNotifDrawer` calls it the
 * instant the panel opens so the badge goes to zero immediately.
 *
 * Scope
 * -----
 *   - Shop-wide mark-as-read (not user-scoped). The bell drawer in
 *     server.ts `/notifications/recent` already queries shop-wide, so
 *     the write side has to match the read side.
 *   - Returns `{ok, marked, unreadCount}` so the client can both
 *     confirm success and optimistically update the badge text without
 *     a second round-trip to `/notifications/recent`.
 *
 * Not in scope
 * ------------
 *   - Per-notification mark-as-read — the existing `postMarkRead`
 *     covers the full-page notifications screen and is untouched.
 *   - Per-user filtering — we deliberately mirror the drawer's
 *     shop-wide read model. If we later split per-user streams we'll
 *     revisit both sides of the query in one go.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { postMarkAllSeen } from './notifications-admin.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeReq(opts: { shopId?: string; slug?: string } = {}) {
  return {
    store: {
      id: opts.shopId ?? 'shop-001',
      slug: opts.slug ?? 'acme',
      name: 'Acme',
    },
    storeUser: { id: 'user-1', name: 'Thai' },
  } as any
}

function makeRes() {
  const res: any = { _json: null, _status: 200 }
  res.json = vi.fn((body: any) => {
    res._json = body
    return res
  })
  res.status = vi.fn((code: number) => {
    res._status = code
    return res
  })
  return res
}

/**
 * Fake Kysely recorder for notifications-admin.postMarkAllSeen.
 *
 * Tracks every (op, col, val) tuple that the handler funnels through
 * the chainable query builder. The handler's expected shape is:
 *
 *   db.updateTable('notifications')
 *     .set({ read: true })
 *     .where('shop_id', '=', shop.id)
 *     .where('read', '=', false)
 *     .execute()
 *
 * plus a final selectFrom(...) to recompute unreadCount (always 0
 * immediately after the update, but we still exercise the read side
 * so the JSON payload can report it).
 */
function makeFakeDb() {
  const calls: any[] = []

  const upd: any = {}
  upd.set = (patch: any) => {
    calls.push({ op: 'set', patch })
    return upd
  }
  upd.where = (col: any, opArg: any, val: any) => {
    calls.push({ op: 'update-where', col, opArg, val })
    return upd
  }
  upd.execute = async () => [{ numUpdatedRows: BigInt(3) }]

  const sel: any = {}
  sel.select = (_anon: any) => sel
  sel.where = (col: any, opArg: any, val: any) => {
    calls.push({ op: 'select-where', col, opArg, val })
    return sel
  }
  sel.executeTakeFirst = async () => ({ count: 0 })

  return {
    _calls: calls,
    updateTable: (_name: string) => upd,
    selectFrom: (_name: string) => sel,
    fn: {
      count: (_col: any) => ({ as: (_label: any) => ({}) }),
    },
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('postMarkAllSeen (JSON bell-drawer mark-as-read)', () => {
  it('sets read = true on the notifications table', async () => {
    const req = makeReq()
    const res = makeRes()
    const db = makeFakeDb()
    await postMarkAllSeen(req, res, db)
    const setCall = db._calls.find((c: any) => c.op === 'set')
    expect(setCall).toBeDefined()
    expect(setCall.patch.read).toBe(true)
  })

  it('scopes the update by shop_id (never touches another tenant)', async () => {
    const req = makeReq({ shopId: 'shop-zz' })
    const res = makeRes()
    const db = makeFakeDb()
    await postMarkAllSeen(req, res, db)
    const shopWhere = db._calls.find(
      (c: any) => c.op === 'update-where' && c.col === 'shop_id',
    )
    expect(shopWhere).toBeDefined()
    expect(shopWhere.val).toBe('shop-zz')
  })

  it('only rewrites unread rows (where read = false) so the audit log stays minimal', async () => {
    const req = makeReq()
    const res = makeRes()
    const db = makeFakeDb()
    await postMarkAllSeen(req, res, db)
    const readWhere = db._calls.find(
      (c: any) => c.op === 'update-where' && c.col === 'read',
    )
    expect(readWhere).toBeDefined()
    expect(readWhere.val).toBe(false)
  })

  it('returns JSON (not a redirect) so the AJAX client can parse it', async () => {
    const req = makeReq()
    const res = makeRes()
    const db = makeFakeDb()
    await postMarkAllSeen(req, res, db)
    expect(res.json).toHaveBeenCalled()
    expect(res._json).toMatchObject({ ok: true, unreadCount: 0 })
  })

  it('exposes how many rows were marked so the client can show a toast if it wants to', async () => {
    const req = makeReq()
    const res = makeRes()
    const db = makeFakeDb()
    await postMarkAllSeen(req, res, db)
    // The fake db reports numUpdatedRows = 3n. The handler should
    // surface that under a friendly `marked` key.
    expect(res._json.marked).toBe(3)
  })

  it('rejects anonymous callers with 401 rather than silently no-op', async () => {
    const req = { store: null, storeUser: null } as any
    const res = makeRes()
    const db = makeFakeDb()
    await postMarkAllSeen(req, res, db)
    expect(res._status).toBe(401)
    expect(res._json).toMatchObject({ ok: false })
    // No DB write attempted.
    expect(db._calls.find((c: any) => c.op === 'set')).toBeUndefined()
  })
})
