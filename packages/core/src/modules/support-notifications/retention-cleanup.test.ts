/**
 * Tests for retention-cleanup.ts — covers:
 *   - archive mode stamps archived_at + archive_location on candidates
 *   - dry_run counts candidates without touching tickets
 *   - closed_at > cutoff tickets are ignored
 *   - already-archived tickets are ignored
 *   - open tickets are ignored (no closed_at)
 *   - a run row is written with counts + finish time
 *   - batchLimit caps the work per run
 */

import { describe, it, expect } from 'vitest'

const cleanup = await import('./retention-cleanup.ts')

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
    let orderCol: string | null = null
    let orderDir: 'asc' | 'desc' = 'asc'
    const chain: any = {
      select(_: string[]) {
        return chain
      },
      where(col: any, op: string, val: any) {
        const c = typeof col === 'string' ? col : String(col)
        if (op === 'is' && val === null) {
          rows = rows.filter((r) => r[c] == null)
        } else if (op === 'is not' && val === null) {
          rows = rows.filter((r) => r[c] != null)
        } else if (op === '=') {
          rows = rows.filter((r) => r[c] === val)
        } else if (op === '<') {
          rows = rows.filter((r) => r[c] != null && r[c] < val)
        }
        return chain
      },
      orderBy(col: string, dir: 'asc' | 'desc' = 'asc') {
        orderCol = col
        orderDir = dir
        return chain
      },
      limit(n: number) {
        if (orderCol) {
          rows = rows.slice().sort((a, b) => {
            const av = a[orderCol!]
            const bv = b[orderCol!]
            if (av === bv) return 0
            if (orderDir === 'desc') return av > bv ? -1 : 1
            return av > bv ? 1 : -1
          })
        }
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
        for (const row of arr) {
          t.rows.push({ ...row, id: row.id ?? `${tbl}-${t.rows.length + 1}` })
        }
        return chain
      },
      async execute() {},
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
    _tables: tables,
  }
  return kysely
}

// ── fixtures ────────────────────────────────────────────────────────────

function oldTicket(id: string, closedAt: string, overrides: Row = {}): Row {
  return {
    id,
    shop_id: 's1',
    subject: `ticket ${id}`,
    category: 'technical',
    status: 'closed',
    closed_at: closedAt,
    archived_at: null,
    archive_location: null,
    archive_manifest: null,
    ...overrides,
  }
}

// ── tests ──────────────────────────────────────────────────────────────

describe('runRetentionCleanup — archive mode (default)', () => {
  it('archives tickets closed >1 year ago', async () => {
    const t1 = oldTicket('t1', '2024-01-01T00:00:00Z') // ~2y ago
    const t2 = oldTicket('t2', '2024-06-01T00:00:00Z') // ~1y10mo ago
    const db = makeDb({
      support_tickets: [t1, t2],
      support_retention_runs: [],
    })
    const res = await cleanup.runRetentionCleanup(db, {
      now: new Date('2026-04-22T00:00:00Z'),
    })
    expect(res.mode).toBe('archive')
    expect(res.candidatesFound).toBe(2)
    expect(res.ticketsArchived).toBe(2)
    expect(t1.archived_at).toBe('2026-04-22T00:00:00.000Z')
    expect(t1.archive_location).toBe('local_soft')
    expect(t2.archived_at).toBe('2026-04-22T00:00:00.000Z')
    // run row finalised
    const run = db._tables.support_retention_runs.rows[0]!
    expect(run.run_finished_at).toBe('2026-04-22T00:00:00.000Z')
    expect(run.tickets_archived).toBe(2)
    expect(run.candidates_found).toBe(2)
  })

  it('skips tickets that closed inside the retention window', async () => {
    const fresh = oldTicket('t1', '2026-03-01T00:00:00Z') // 1.5mo ago
    const old = oldTicket('t2', '2024-01-01T00:00:00Z') // 2y ago
    const db = makeDb({
      support_tickets: [fresh, old],
      support_retention_runs: [],
    })
    const res = await cleanup.runRetentionCleanup(db, {
      now: new Date('2026-04-22T00:00:00Z'),
    })
    expect(res.ticketsArchived).toBe(1)
    expect(fresh.archived_at).toBeNull()
    expect(old.archived_at).toBe('2026-04-22T00:00:00.000Z')
  })

  it('skips already-archived tickets', async () => {
    const already = oldTicket('t1', '2024-01-01T00:00:00Z', {
      archived_at: '2025-04-01T00:00:00Z',
    })
    const fresh = oldTicket('t2', '2024-01-02T00:00:00Z')
    const db = makeDb({
      support_tickets: [already, fresh],
      support_retention_runs: [],
    })
    const res = await cleanup.runRetentionCleanup(db, {
      now: new Date('2026-04-22T00:00:00Z'),
    })
    expect(res.candidatesFound).toBe(1)
    expect(res.ticketsArchived).toBe(1)
    expect(already.archived_at).toBe('2025-04-01T00:00:00Z') // unchanged
  })

  it('skips tickets without a closed_at (still open)', async () => {
    const open = oldTicket('t1', null as any)
    open.closed_at = null
    const db = makeDb({
      support_tickets: [open],
      support_retention_runs: [],
    })
    const res = await cleanup.runRetentionCleanup(db, {
      now: new Date('2026-04-22T00:00:00Z'),
    })
    expect(res.candidatesFound).toBe(0)
    expect(res.ticketsArchived).toBe(0)
  })

  it('records a run row even when there are zero candidates', async () => {
    const db = makeDb({
      support_tickets: [],
      support_retention_runs: [],
    })
    const res = await cleanup.runRetentionCleanup(db, {
      now: new Date('2026-04-22T00:00:00Z'),
    })
    expect(res.candidatesFound).toBe(0)
    expect(db._tables.support_retention_runs.rows).toHaveLength(1)
    expect(db._tables.support_retention_runs.rows[0].run_finished_at).toBe(
      '2026-04-22T00:00:00.000Z',
    )
  })
})

describe('runRetentionCleanup — dry_run mode', () => {
  it('counts candidates without touching tickets', async () => {
    const t = oldTicket('t1', '2024-01-01T00:00:00Z')
    const db = makeDb({
      support_tickets: [t],
      support_retention_runs: [],
    })
    const res = await cleanup.runRetentionCleanup(db, {
      now: new Date('2026-04-22T00:00:00Z'),
      mode: 'dry_run',
    })
    expect(res.mode).toBe('dry_run')
    expect(res.candidatesFound).toBe(1)
    expect(res.ticketsArchived).toBe(0)
    // Ticket untouched.
    expect(t.archived_at).toBeNull()
    // Run row archive_location is null in dry_run.
    expect(db._tables.support_retention_runs.rows[0].archive_location).toBeNull()
  })
})

describe('runRetentionCleanup — batchLimit', () => {
  it('caps work at batchLimit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      oldTicket(`t${i}`, '2024-01-01T00:00:00Z'),
    )
    const db = makeDb({
      support_tickets: rows,
      support_retention_runs: [],
    })
    const res = await cleanup.runRetentionCleanup(db, {
      now: new Date('2026-04-22T00:00:00Z'),
      batchLimit: 3,
    })
    expect(res.candidatesFound).toBe(3)
    expect(res.ticketsArchived).toBe(3)
    const archivedCount = rows.filter((r) => r.archived_at != null).length
    expect(archivedCount).toBe(3)
  })
})

describe('runRetentionCleanup — custom retention window', () => {
  it('honours a shorter retentionMs override', async () => {
    const veryRecent = oldTicket('t1', '2026-04-15T00:00:00Z') // 7d ago
    const db = makeDb({
      support_tickets: [veryRecent],
      support_retention_runs: [],
    })
    // retention window = 1 day → 7-day-old ticket is eligible
    const res = await cleanup.runRetentionCleanup(db, {
      now: new Date('2026-04-22T00:00:00Z'),
      retentionMs: 24 * 60 * 60 * 1000,
    })
    expect(res.ticketsArchived).toBe(1)
    expect(veryRecent.archived_at).toBe('2026-04-22T00:00:00.000Z')
  })
})
