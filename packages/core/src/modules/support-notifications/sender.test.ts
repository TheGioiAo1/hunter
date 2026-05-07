/**
 * Tests for sender.ts — covers the 5 dispatch paths:
 *   1. user_silenced short-circuit
 *   2. email rate-limit skip within 1h of prior sent row
 *   3. email successful send writes status='sent' log row
 *   4. in_app insert into `notifications` + log row
 *   5. browser_push MVP stub writes status='skipped' with tag
 *   6. SMTP failure logs status='failed' instead of throwing
 *   7. missing recipient email skips with 'no_recipient_email'
 *
 * Uses the same fake-db shim as engine.test.ts + vi.mock on sendTemplatedEmail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTemplatedEmailSpy = vi.fn(async () => ({
  ok: true as const,
  deliveryId: 1,
  messageId: 'test-id',
  provider: 'console' as const,
}))
vi.mock('../email/send.ts', () => ({
  sendTemplatedEmail: (...args: unknown[]) => sendTemplatedEmailSpy(...(args as [])),
}))

const sender = await import('./sender.ts')

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
  return { kysely: buildShim(db), db }
}

function buildShim(db: FakeDb): any {
  function ensure(name: string): FakeTable {
    if (!db.tables[name]) db.tables[name] = { rows: [] }
    return db.tables[name]!
  }

  const selectChain = (tbl: string) => {
    let rows = ensure(tbl).rows.slice()
    let orderBy: { col: string; dir: 'asc' | 'desc' } | null = null
    const chain: any = {
      select(_cols: string[]) {
        return chain
      },
      selectAll() {
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
        } else if (op === 'in') {
          rows = rows.filter((r) => (val as any[]).includes(r[colName]))
        } else if (op === 'not in') {
          rows = rows.filter((r) => !(val as any[]).includes(r[colName]))
        }
        return chain
      },
      orderBy(col: string, dir: 'asc' | 'desc' = 'asc') {
        orderBy = { col, dir }
        return chain
      },
      limit(n: number) {
        if (orderBy) {
          rows = rows.slice().sort((a, b) => {
            const av = a[orderBy!.col]
            const bv = b[orderBy!.col]
            if (av === bv) return 0
            if (orderBy!.dir === 'desc') return av > bv ? -1 : 1
            return av > bv ? 1 : -1
          })
        }
        rows = rows.slice(0, n)
        return chain
      },
      async execute() {
        return rows
      },
      async executeTakeFirst() {
        if (orderBy) {
          rows = rows.slice().sort((a, b) => {
            const av = a[orderBy!.col]
            const bv = b[orderBy!.col]
            if (av === bv) return 0
            if (orderBy!.dir === 'desc') return av > bv ? -1 : 1
            return av > bv ? 1 : -1
          })
        }
        return rows[0]
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
        // values already pushed
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

  return {
    selectFrom: (t: string) => selectChain(t),
    insertInto: (t: string) => insertChain(t),
    updateTable: (t: string) => updateChain(t),
  }
}

// ── shared fixtures ────────────────────────────────────────────────────

function seedBase(
  overrides: Partial<{
    users: Row[]
    tickets: Row[]
    prefs: Row[]
    log: Row[]
    notifications: Row[]
  }> = {},
) {
  return makeDb({
    users: overrides.users ?? [
      { id: 'u1', email: 'agent1@gbox.co' },
    ],
    support_tickets: overrides.tickets ?? [
      { id: 't1', shop_id: 's1' },
    ],
    support_notification_preferences: overrides.prefs ?? [],
    support_notifications_log: overrides.log ?? [],
    notifications: overrides.notifications ?? [],
  })
}

// ── tests ──────────────────────────────────────────────────────────────

describe('sendSupportNotification — user_silenced short-circuit', () => {
  beforeEach(() => sendTemplatedEmailSpy.mockClear())

  it('logs a single skipped row when user has disabled all channels for this type', async () => {
    const { kysely, db } = seedBase({
      prefs: [
        {
          user_id: 'u1',
          in_app_enabled: false,
          email_enabled: false,
          browser_push_enabled: false,
          new_message_channels: [],
          mention_channels: [],
          sla_breach_channels: [],
          csat_prompt_channels: [],
          quiet_hours_start: null,
          quiet_hours_end: null,
          quiet_hours_tz: 'UTC',
          browser_push_subscription: null,
        },
      ],
    })
    const res = await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 'hi',
      body: 'body',
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(res.sent).toBe(0)
    expect(res.skipped).toBe(1)
    expect(res.failed).toBe(0)
    expect(res.channels[0]!.reason).toBe('user_silenced')
    expect(db.tables.support_notifications_log!.rows).toHaveLength(1)
    expect(db.tables.support_notifications_log!.rows[0]!.error).toBe(
      'user_silenced',
    )
    expect(sendTemplatedEmailSpy).not.toHaveBeenCalled()
  })
})

describe('sendSupportNotification — email path', () => {
  beforeEach(() => sendTemplatedEmailSpy.mockClear())

  it('sends email and logs status=sent when no recent email', async () => {
    const { kysely, db } = seedBase()
    const res = await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 'You were mentioned',
      body: 'Click here',
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(sendTemplatedEmailSpy).toHaveBeenCalledTimes(1)
    const call = (sendTemplatedEmailSpy.mock.calls[0] as unknown as [any, any])[1]!
    expect(call.to).toBe('agent1@gbox.co')
    expect(call.variables.heading).toBe('You were mentioned')
    expect(call.variables.body_html).toContain('Click here')

    const logs = db.tables.support_notifications_log!.rows
    const emailLog = logs.find((r: any) => r.channel === 'email')!
    expect(emailLog.status).toBe('sent')
    expect(emailLog.error).toBeNull()
    expect(res.sent).toBeGreaterThan(0)
  })

  it('skips email with rate_limited_1h when a prior email was sent <1h ago', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const recent = new Date('2026-04-22T09:30:00Z').toISOString() // 30m ago
    const { kysely, db } = seedBase({
      log: [
        {
          ticket_id: 't1',
          notification_type: 'mention',
          channel: 'email',
          status: 'sent',
          sent_at: recent,
        },
      ],
    })
    const res = await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 's',
      body: 'b',
      now,
    })
    expect(sendTemplatedEmailSpy).not.toHaveBeenCalled()
    const logs = db.tables.support_notifications_log!.rows
    const skip = logs.find(
      (r: any) => r.channel === 'email' && r.status === 'skipped',
    )!
    expect(skip.error).toBe('rate_limited_1h')
    expect(res.channels.some((c) => c.reason === 'rate_limited_1h')).toBe(true)
  })

  it('allows email when the prior email was sent >1h ago', async () => {
    const now = new Date('2026-04-22T10:00:00Z')
    const old = new Date('2026-04-22T08:00:00Z').toISOString() // 2h ago
    const { kysely } = seedBase({
      log: [
        {
          ticket_id: 't1',
          notification_type: 'mention',
          channel: 'email',
          status: 'sent',
          sent_at: old,
        },
      ],
    })
    await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 's',
      body: 'b',
      now,
    })
    expect(sendTemplatedEmailSpy).toHaveBeenCalledTimes(1)
  })

  it('logs status=failed on SMTP error and does not throw', async () => {
    sendTemplatedEmailSpy.mockResolvedValueOnce({
      ok: false as const,
      deliveryId: null,
      reason: 'SMTP 550 rejected',
      error: 'SMTP 550 rejected',
    })
    const { kysely, db } = seedBase()
    const res = await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 's',
      body: 'b',
      now: new Date('2026-04-22T10:00:00Z'),
    })
    const failedLog = db.tables.support_notifications_log!.rows.find(
      (r: any) => r.channel === 'email' && r.status === 'failed',
    )!
    expect(failedLog).toBeDefined()
    expect(failedLog.error).toContain('SMTP 550 rejected')
    expect(res.failed).toBeGreaterThan(0)
  })

  it('skips email when recipient has no email on file', async () => {
    const { kysely, db } = seedBase({
      users: [{ id: 'u1', email: null }],
    })
    await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 's',
      body: 'b',
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(sendTemplatedEmailSpy).not.toHaveBeenCalled()
    const skip = db.tables.support_notifications_log!.rows.find(
      (r: any) => r.channel === 'email' && r.status === 'skipped',
    )!
    expect(skip.error).toBe('no_recipient_email')
  })
})

describe('sendSupportNotification — in_app path', () => {
  beforeEach(() => sendTemplatedEmailSpy.mockClear())

  it('inserts row into notifications table + logs status=sent', async () => {
    const { kysely, db } = seedBase({
      prefs: [
        {
          user_id: 'u1',
          in_app_enabled: true,
          email_enabled: false,
          browser_push_enabled: false,
          new_message_channels: [],
          mention_channels: ['in_app'],
          sla_breach_channels: [],
          csat_prompt_channels: [],
          quiet_hours_start: null,
          quiet_hours_end: null,
          quiet_hours_tz: 'UTC',
          browser_push_subscription: null,
        },
      ],
    })
    const res = await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 'Hey',
      body: 'hi',
      link: '/supporter/tickets/t1',
      now: new Date('2026-04-22T10:00:00Z'),
    })
    const notifs = db.tables.notifications!.rows
    expect(notifs).toHaveLength(1)
    expect(notifs[0]!.shop_id).toBe('s1')
    expect(notifs[0]!.user_id).toBe('u1')
    expect(notifs[0]!.type).toBe('support_mention')
    expect(notifs[0]!.resource_type).toBe('support_ticket')
    expect(notifs[0]!.resource_id).toBe('t1')
    expect(notifs[0]!.category).toBe('system')
    expect(notifs[0]!.link).toBe('/supporter/tickets/t1')

    const logs = db.tables.support_notifications_log!.rows
    const log = logs.find((r: any) => r.channel === 'in_app')!
    expect(log.status).toBe('sent')
    expect(res.sent).toBe(1)
  })
})

describe('sendSupportNotification — browser_push MVP stub', () => {
  beforeEach(() => sendTemplatedEmailSpy.mockClear())

  it('logs skipped with browser_push_mvp_stub tag', async () => {
    const { kysely, db } = seedBase({
      prefs: [
        {
          user_id: 'u1',
          in_app_enabled: false,
          email_enabled: false,
          browser_push_enabled: true,
          new_message_channels: [],
          mention_channels: ['browser_push'],
          sla_breach_channels: [],
          csat_prompt_channels: [],
          quiet_hours_start: null,
          quiet_hours_end: null,
          quiet_hours_tz: 'UTC',
          browser_push_subscription: { endpoint: 'https://push.example/abc' },
        },
      ],
    })
    const res = await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 's',
      body: 'b',
      now: new Date('2026-04-22T10:00:00Z'),
    })
    const log = db.tables.support_notifications_log!.rows.find(
      (r: any) => r.channel === 'browser_push',
    )!
    expect(log.status).toBe('skipped')
    expect(log.error).toBe('browser_push_mvp_stub')
    expect(res.skipped).toBe(1)
  })
})

describe('sendSupportNotification — SLA breach bypasses quiet hours', () => {
  beforeEach(() => sendTemplatedEmailSpy.mockClear())

  it('delivers email even during quiet hours for sla_first_response_breach', async () => {
    const { kysely } = seedBase({
      prefs: [
        {
          user_id: 'u1',
          in_app_enabled: true,
          email_enabled: true,
          browser_push_enabled: false,
          new_message_channels: [],
          mention_channels: ['email', 'in_app'],
          sla_breach_channels: ['email', 'in_app'],
          csat_prompt_channels: [],
          quiet_hours_start: '00:00',
          quiet_hours_end: '23:59',
          quiet_hours_tz: 'UTC',
          browser_push_subscription: null,
        },
      ],
    })
    await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'sla_first_response_breach',
      recipientUserId: 'u1',
      subject: 'SLA breach',
      body: 'overdue',
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(sendTemplatedEmailSpy).toHaveBeenCalledTimes(1)
  })

  it('suppresses email during quiet hours for regular mention', async () => {
    const { kysely, db } = seedBase({
      prefs: [
        {
          user_id: 'u1',
          in_app_enabled: true,
          email_enabled: true,
          browser_push_enabled: false,
          new_message_channels: [],
          mention_channels: ['email', 'in_app'],
          sla_breach_channels: [],
          csat_prompt_channels: [],
          quiet_hours_start: '00:00',
          quiet_hours_end: '23:59',
          quiet_hours_tz: 'UTC',
          browser_push_subscription: null,
        },
      ],
    })
    await sender.sendSupportNotification(kysely as any, {
      ticketId: 't1',
      notificationType: 'mention',
      recipientUserId: 'u1',
      subject: 'ping',
      body: 'body',
      now: new Date('2026-04-22T10:00:00Z'),
    })
    expect(sendTemplatedEmailSpy).not.toHaveBeenCalled()
    // in_app still lands
    expect(db.tables.notifications!.rows).toHaveLength(1)
  })
})
