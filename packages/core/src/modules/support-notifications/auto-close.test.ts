/**
 * Tests for auto-close.ts — covers the 6-day warning + 7-day close path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendSpy = vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0, channels: [] }))
vi.mock('./sender.ts', () => ({
  sendSupportNotification: (...args: unknown[]) => sendSpy(...(args as [])),
}))

const autoClose = await import('./auto-close.ts')

type Row = Record<string, any>

function makeDb(init: Partial<Record<string, Row[]>> = {}): any {
  const tables: Record<string, { rows: Row[] }> = {}
  for (const [k, v] of Object.entries(init)) tables[k] = { rows: v ?? [] }

  function ensure(n: string) {
    if (!tables[n]) tables[n] = { rows: [] }
    return tables[n]!
  }

  const selectChain = (tbl: string) => {
    let rows = ensure(tbl).rows.slice()
    const chain: any = {
      select(_: string[]) {
        return chain
      },
      where(col: any, op: string, val: any) {
        const c = typeof col === 'string' ? col : String(col)
        if (op === 'is' && val === null) rows = rows.filter((r) => r[c] == null)
        else if (op === 'is not' && val === null)
          rows = rows.filter((r) => r[c] != null)
        else if (op === '=') rows = rows.filter((r) => r[c] === val)
        else if (op === '<')
          rows = rows.filter((r) => r[c] != null && r[c] < val)
        return chain
      },
      orderBy() {
        return chain
      },
      limit(n: number) {
        rows = rows.slice(0, n)
        return chain
      },
      async execute() {
        return rows
      },
    }
    return chain
  }

  const updateChain = (tbl: string) => {
    const t = ensure(tbl)
    let filtered = t.rows
    let set: Row = {}
    const chain: any = {
      set(s: Row) {
        set = s
        return chain
      },
      where(col: string, op: string, val: any) {
        if (op === '=') filtered = filtered.filter((r) => r[col] === val)
        else if (op === 'is' && val === null)
          filtered = filtered.filter((r) => r[col] == null)
        return chain
      },
      async execute() {
        for (const r of filtered) Object.assign(r, set)
      },
    }
    return chain
  }

  const insertChain = (tbl: string) => {
    const t = ensure(tbl)
    const chain: any = {
      values(v: Row | Row[]) {
        const arr = Array.isArray(v) ? v : [v]
        for (const row of arr)
          t.rows.push({ ...row, id: row.id ?? `${tbl}-${t.rows.length + 1}` })
        return chain
      },
      async execute() {},
    }
    return chain
  }

  return {
    selectFrom: (t: string) => selectChain(t),
    updateTable: (t: string) => updateChain(t),
    insertInto: (t: string) => insertChain(t),
    _tables: tables,
  }
}

// ── fixtures ────────────────────────────────────────────────────────────

function pendingTicket(
  id: string,
  sinceDaysAgo: number,
  now: Date,
  overrides: Row = {},
): Row {
  return {
    id,
    shop_id: 's1',
    opener_user_id: 'seller-1',
    subject: 'hello world',
    status: 'pending_seller',
    pending_seller_since: new Date(
      now.getTime() - sinceDaysAgo * 24 * 60 * 60 * 1000,
    ).toISOString(),
    auto_close_warned_at: null,
    archived_at: null,
    closed_at: null,
    ...overrides,
  }
}

// ── tests ──────────────────────────────────────────────────────────────

describe('runAutoCloseTick — warning phase', () => {
  beforeEach(() => sendSpy.mockClear())

  it('warns a ticket that has been pending 6 days', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const t = pendingTicket('t1', 6.5, now) // between warn (6d) + close (7d)
    const db = makeDb({ support_tickets: [t], support_ticket_events: [] })
    const res = await autoClose.runAutoCloseTick(db as any, { now })
    expect(res.warned).toBe(1)
    expect(t.auto_close_warned_at).toBe(now.toISOString())
    const events = db._tables.support_ticket_events.rows
    expect(events.some((e: Row) => e.event_type === 'auto_close_warned')).toBe(
      true,
    )
    const call = (sendSpy.mock.calls[0] as unknown as [any, any])[1]!
    expect(call.notificationType).toBe('auto_close_warning')
  })

  it('does NOT warn a ticket <6 days old', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const t = pendingTicket('t1', 2, now)
    const db = makeDb({ support_tickets: [t], support_ticket_events: [] })
    const res = await autoClose.runAutoCloseTick(db as any, { now })
    expect(res.warned).toBe(0)
    expect(t.auto_close_warned_at).toBeNull()
  })

  it('does NOT re-warn an already-warned ticket', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const t = pendingTicket('t1', 6.5, now, {
      auto_close_warned_at: '2026-04-21T10:00:00Z',
    })
    const db = makeDb({ support_tickets: [t], support_ticket_events: [] })
    const res = await autoClose.runAutoCloseTick(db as any, { now })
    expect(res.warned).toBe(0)
  })
})

describe('runAutoCloseTick — close phase', () => {
  beforeEach(() => sendSpy.mockClear())

  it('closes a warned ticket that has been pending 7+ days', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const t = pendingTicket('t1', 8, now, {
      // Warning fired ~1.5 days ago — past the warningLeadDays=1 grace window.
      auto_close_warned_at: new Date(
        now.getTime() - 1.5 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    })
    const db = makeDb({ support_tickets: [t], support_ticket_events: [] })
    const res = await autoClose.runAutoCloseTick(db as any, { now })
    expect(res.closed).toBe(1)
    expect(t.status).toBe('closed')
    expect(t.closed_at).toBe(now.toISOString())
    expect(t.pending_seller_since).toBeNull()
    const events = db._tables.support_ticket_events.rows
    expect(events.some((e: Row) => e.event_type === 'auto_closed')).toBe(true)
    expect(events.some((e: Row) => e.event_type === 'status_changed')).toBe(
      true,
    )
    const call = (sendSpy.mock.calls[0] as unknown as [any, any])[1]!
    expect(call.notificationType).toBe('auto_close')
  })

  it('does NOT close a ticket that has NOT been warned yet', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const t = pendingTicket('t1', 8, now, {
      auto_close_warned_at: null,
    })
    const db = makeDb({ support_tickets: [t], support_ticket_events: [] })
    const res = await autoClose.runAutoCloseTick(db as any, { now })
    // It gets warned on this tick (stamped + close_rows requires NOT NULL
    // at SELECT time, so warning + close can't happen in the same tick).
    expect(res.warned).toBe(1)
    expect(res.closed).toBe(0)
    expect(t.status).toBe('pending_seller')
  })

  it('skips archived tickets', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const t = pendingTicket('t1', 8, now, {
      auto_close_warned_at: '2026-04-20T10:00:00Z',
      archived_at: '2026-04-21T00:00:00Z',
    })
    const db = makeDb({ support_tickets: [t], support_ticket_events: [] })
    const res = await autoClose.runAutoCloseTick(db as any, { now })
    expect(res.warned).toBe(0)
    expect(res.closed).toBe(0)
    expect(t.status).toBe('pending_seller')
  })
})
