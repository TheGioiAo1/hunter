/**
 * Tests for csat-auto-prompt.ts — covers the batch selection filters
 * (status=closed, csat_prompted_at IS NULL, csat_rated_at IS NULL,
 * closed_at < now - delay) and the stamp+event+send wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendSpy = vi.fn(async () => ({
  sent: 1,
  skipped: 0,
  failed: 0,
  channels: [],
}))
vi.mock('./sender.ts', () => ({
  sendSupportNotification: (...args: unknown[]) => sendSpy(...(args as [])),
}))

const csat = await import('./csat-auto-prompt.ts')

// ── fake-db harness ────────────────────────────────────────────────────

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
        const colName = typeof col === 'string' ? col : String(col)
        if (op === 'is' && val === null) {
          rows = rows.filter((r) => r[colName] == null)
        } else if (op === 'is not' && val === null) {
          rows = rows.filter((r) => r[colName] != null)
        } else if (op === '=') {
          rows = rows.filter((r) => r[colName] === val)
        } else if (op === '<') {
          rows = rows.filter((r) => r[colName] != null && r[colName] < val)
        } else if (op === 'not in') {
          rows = rows.filter((r) => !(val as any[]).includes(r[colName]))
        }
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
        else if (op === 'is' && val === null) {
          filtered = filtered.filter((r) => r[col] == null)
        }
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
        for (const row of arr) {
          t.rows.push({ ...row, id: row.id ?? `${tbl}-${t.rows.length + 1}` })
        }
        return chain
      },
      async execute() {
        // noop — pushed
      },
    }
    return chain
  }

  const kysely: any = {
    selectFrom: (t: string) => selectChain(t),
    updateTable: (t: string) => updateChain(t),
    insertInto: (t: string) => insertChain(t),
    transaction() {
      return {
        async execute(fn: (trx: any) => Promise<any>) {
          return fn(kysely)
        },
      }
    },
    _tables: tables,
  }
  return kysely
}

// ── tests ──────────────────────────────────────────────────────────────

describe('runCsatPrompts', () => {
  beforeEach(() => sendSpy.mockClear())

  it('returns zero when no closed tickets exist', async () => {
    const db = makeDb({ support_tickets: [] })
    const res = await csat.runCsatPrompts(db, {
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(res.prompted).toBe(0)
    expect(res.failed).toBe(0)
  })

  it('prompts a ticket that closed >60min ago', async () => {
    const ticket = {
      id: 't1',
      shop_id: 's1',
      opener_user_id: 'seller-1',
      subject: 'My order',
      status: 'closed',
      closed_at: '2026-04-22T08:00:00Z', // 2h ago
      csat_prompted_at: null,
      csat_rated_at: null,
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket], support_ticket_events: [] })
    const res = await csat.runCsatPrompts(db, {
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(res.prompted).toBe(1)
    expect(ticket.csat_prompted_at).toBe('2026-04-22T10:00:00.000Z')
    expect(sendSpy).toHaveBeenCalledTimes(1)
    const call = (sendSpy.mock.calls[0] as unknown as [any, any])[1]!
    expect(call.notificationType).toBe('csat_prompt')
    expect(call.recipientUserId).toBe('seller-1')
    expect(call.link).toContain('csat=1')
    // event row written
    expect(db._tables.support_ticket_events.rows).toHaveLength(1)
    expect(db._tables.support_ticket_events.rows[0].event_type).toBe(
      'csat_prompted',
    )
  })

  it('skips a ticket closed <60min ago (below the delay threshold)', async () => {
    const ticket = {
      id: 't1',
      shop_id: 's1',
      opener_user_id: 'seller-1',
      subject: 'fresh',
      status: 'closed',
      closed_at: '2026-04-22T09:45:00Z', // 15min ago
      csat_prompted_at: null,
      csat_rated_at: null,
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket] })
    const res = await csat.runCsatPrompts(db, {
      now: new Date('2026-04-22T10:00:00Z'),
      delayMinutes: 60,
    })
    expect(res.prompted).toBe(0)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('skips already-prompted tickets', async () => {
    const ticket = {
      id: 't1',
      shop_id: 's1',
      opener_user_id: 'seller-1',
      subject: 'x',
      status: 'closed',
      closed_at: '2026-04-22T08:00:00Z',
      csat_prompted_at: '2026-04-22T09:00:00Z',
      csat_rated_at: null,
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket] })
    const res = await csat.runCsatPrompts(db, {
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(res.prompted).toBe(0)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('skips tickets that seller already rated', async () => {
    const ticket = {
      id: 't1',
      shop_id: 's1',
      opener_user_id: 'seller-1',
      subject: 'x',
      status: 'closed',
      closed_at: '2026-04-22T08:00:00Z',
      csat_prompted_at: null,
      csat_rated_at: '2026-04-22T09:30:00Z',
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket] })
    const res = await csat.runCsatPrompts(db, {
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(res.prompted).toBe(0)
  })

  it('skips non-closed tickets', async () => {
    const ticket = {
      id: 't1',
      shop_id: 's1',
      opener_user_id: 'seller-1',
      subject: 'still open',
      status: 'open',
      closed_at: null,
      csat_prompted_at: null,
      csat_rated_at: null,
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket] })
    const res = await csat.runCsatPrompts(db, {
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(res.prompted).toBe(0)
  })

  it('skips archived tickets', async () => {
    const ticket = {
      id: 't1',
      shop_id: 's1',
      opener_user_id: 'seller-1',
      subject: 'old',
      status: 'closed',
      closed_at: '2026-04-22T08:00:00Z',
      csat_prompted_at: null,
      csat_rated_at: null,
      archived_at: '2026-04-22T09:00:00Z',
    }
    const db = makeDb({ support_tickets: [ticket] })
    const res = await csat.runCsatPrompts(db, {
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(res.prompted).toBe(0)
  })

  it('aggregates failures without throwing', async () => {
    sendSpy.mockRejectedValueOnce(new Error('boom'))
    const ticket = {
      id: 't1',
      shop_id: 's1',
      opener_user_id: 'seller-1',
      subject: 'x',
      status: 'closed',
      closed_at: '2026-04-22T08:00:00Z',
      csat_prompted_at: null,
      csat_rated_at: null,
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket], support_ticket_events: [] })
    const res = await csat.runCsatPrompts(db, {
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(res.failed).toBe(1)
    expect(res.errors[0]!.error).toContain('boom')
  })
})
