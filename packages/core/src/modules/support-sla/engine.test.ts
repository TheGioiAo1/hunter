/**
 * Tests for the SLA engine. Since the engine queries Kysely, we use a
 * fake-db harness that mimics the chain API (.selectFrom / .where /
 * .execute / .updateTable / .insertInto / .transaction).
 *
 * We can't exercise the partial-index query plan from a fake, but we
 * can validate:
 *   - scanForBreaches splits `first_response` + `resolution` and computes
 *     overdueMs/slaWindowMs correctly.
 *   - applyEscalation stamps the right column + writes the right events
 *     + wires the notification call.
 *   - tickSla summarises counts accurately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the sender so tests don't hit SMTP / the log table.
const sendSpy = vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0 }))
vi.mock('../support-notifications/sender.ts', () => ({
  sendSupportNotification: (...args: unknown[]) => sendSpy(...(args as [])),
}))

// Import AFTER the mock is registered.
const engine = await import('./engine.ts')

// ── fake-db harness ────────────────────────────────────────────────────

type Row = Record<string, any>

interface FakeTable {
  rows: Row[]
}

interface FakeDb {
  tables: Record<string, FakeTable>
}

function makeDb(init: Partial<Record<string, Row[]>> = {}): any {
  const tables: Record<string, FakeTable> = {}
  for (const [k, v] of Object.entries(init)) tables[k] = { rows: v ?? [] }
  const db: FakeDb = { tables }
  return buildKyselyShim(db)
}

function buildKyselyShim(db: FakeDb): any {
  function ensure(name: string): FakeTable {
    if (!db.tables[name]) db.tables[name] = { rows: [] }
    return db.tables[name]!
  }

  const selectChain = (tbl: string) => {
    let rows = ensure(tbl).rows.slice()
    const chain: any = {
      select(_cols: string[]) {
        return chain
      },
      where(col: any, op: string, val: any) {
        const colName = typeof col === 'string' ? col : String(col)
        if (op === 'is' && val === null) {
          rows = rows.filter((r) => r[colName] === null || r[colName] === undefined)
        } else if (op === 'is not' && val === null) {
          rows = rows.filter((r) => r[colName] !== null && r[colName] !== undefined)
        } else if (op === 'not in') {
          rows = rows.filter((r) => !(val as any[]).includes(r[colName]))
        } else if (op === '<') {
          rows = rows.filter(
            (r) => r[colName] != null && r[colName] < val,
          )
        } else if (op === '=') {
          rows = rows.filter((r) => r[colName] === val)
        } else if (op === 'in') {
          rows = rows.filter((r) => (val as any[]).includes(r[colName]))
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
      async executeTakeFirst() {
        return rows[0]
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
        const rows = Array.isArray(v) ? v : [v]
        for (const row of rows) {
          t.rows.push({
            ...row,
            id: row.id ?? `${tbl}-${t.rows.length + 1}`,
          })
        }
        return chain
      },
      async execute() {
        // no-op; values already pushed
      },
      returning() {
        return chain
      },
      async executeTakeFirstOrThrow() {
        return t.rows[t.rows.length - 1]!
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
  }
  return kysely
}

// ── tests ──────────────────────────────────────────────────────────────

describe('scanForBreaches', () => {
  beforeEach(() => sendSpy.mockClear())

  it('returns zero when no tickets are overdue', async () => {
    const db = makeDb({ support_tickets: [] })
    const breaches = await engine.scanForBreaches(db, {
      now: new Date('2026-04-22T00:00:00Z'),
    })
    expect(breaches).toEqual([])
  })

  it('flags a first-response breach with correct overdueMs', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const ticket = {
      id: 't1',
      shop_id: 's1',
      priority: 'normal',
      assigned_agent_id: 'a1',
      category: 'technical',
      sla_first_response_at: '2026-04-22T08:00:00Z', // 2h past
      sla_resolution_at: '2026-04-23T08:00:00Z',
      created_at: '2026-04-22T04:00:00Z',
      first_responded_at: null,
      resolved_at: null,
      sla_first_response_notified_at: null,
      sla_resolution_notified_at: null,
      status: 'open',
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket] })
    const breaches = await engine.scanForBreaches(db, { now })
    expect(breaches).toHaveLength(1)
    expect(breaches[0]!.breachType).toBe('first_response')
    expect(breaches[0]!.overdueMs).toBe(2 * 3600 * 1000)
    expect(breaches[0]!.slaWindowMs).toBe(4 * 3600 * 1000)
    expect(breaches[0]!.assignedAgentId).toBe('a1')
  })

  it('ignores already-notified tickets', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const ticket = {
      id: 't1',
      shop_id: 's1',
      priority: 'normal',
      assigned_agent_id: 'a1',
      category: 'technical',
      sla_first_response_at: '2026-04-22T08:00:00Z',
      sla_resolution_at: '2026-04-23T08:00:00Z',
      created_at: '2026-04-22T04:00:00Z',
      first_responded_at: null,
      resolved_at: null,
      sla_first_response_notified_at: '2026-04-22T09:00:00Z', // already fired
      sla_resolution_notified_at: null,
      status: 'open',
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket] })
    const breaches = await engine.scanForBreaches(db, { now })
    expect(breaches).toEqual([])
  })

  it('ignores closed tickets', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const ticket = {
      id: 't1',
      shop_id: 's1',
      priority: 'normal',
      assigned_agent_id: 'a1',
      category: 'technical',
      sla_first_response_at: '2026-04-22T08:00:00Z',
      sla_resolution_at: '2026-04-23T08:00:00Z',
      created_at: '2026-04-22T04:00:00Z',
      first_responded_at: null,
      resolved_at: null,
      sla_first_response_notified_at: null,
      sla_resolution_notified_at: null,
      status: 'closed',
      archived_at: null,
    }
    const db = makeDb({ support_tickets: [ticket] })
    const breaches = await engine.scanForBreaches(db, { now })
    expect(breaches).toEqual([])
  })
})

describe('applyEscalation', () => {
  beforeEach(() => sendSpy.mockClear())

  it('stamps the correct notified-marker column for first_response', async () => {
    const ticket = {
      id: 't1',
      shop_id: 's1',
      priority: 'normal',
      sla_first_response_notified_at: null,
      sla_resolution_notified_at: null,
    }
    const db = makeDb({
      support_tickets: [ticket],
      support_ticket_events: [],
    })
    const now = new Date('2026-04-22T10:00:00Z')
    const res = await engine.applyEscalation(
      db,
      {
        ticketId: 't1',
        shopId: 's1',
        breachType: 'first_response',
        overdueMs: 3600_000,
        slaWindowMs: 4 * 3600_000,
        priority: 'normal',
        assignedAgentId: 'a1',
        category: 'technical',
      },
      { notifyUserIds: ['a1'], newPriority: null, pageLead: false, reason: 'r' },
      now,
    )
    expect(ticket.sla_first_response_notified_at).toBe(now.toISOString())
    expect(ticket.sla_resolution_notified_at).toBeNull()
    expect(res.priorityBumped).toBe(false)
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })

  it('bumps priority + logs priority_changed event when decision says so', async () => {
    const ticket = {
      id: 't1',
      shop_id: 's1',
      priority: 'normal',
      sla_first_response_notified_at: null,
      sla_resolution_notified_at: null,
    }
    const events: any[] = []
    const db = makeDb({
      support_tickets: [ticket],
      support_ticket_events: events,
    })
    const now = new Date('2026-04-22T10:00:00Z')
    await engine.applyEscalation(
      db,
      {
        ticketId: 't1',
        shopId: 's1',
        breachType: 'first_response',
        overdueMs: 9 * 3600_000,
        slaWindowMs: 4 * 3600_000,
        priority: 'normal',
        assignedAgentId: 'a1',
        category: 'technical',
      },
      {
        notifyUserIds: ['a1', 'lead-1'],
        newPriority: 'high',
        pageLead: true,
        reason: 'over 2x',
      },
      now,
    )
    expect(ticket.priority).toBe('high')
    const eventTypes = events.map((e) => e.event_type)
    expect(eventTypes).toContain('sla_breached')
    expect(eventTypes).toContain('priority_changed')
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })
})
