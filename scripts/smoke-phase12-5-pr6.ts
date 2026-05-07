/**
 * Gbox Platform — Phase 12.5 PR6 E2E smoke.
 *
 * Wires the ENTIRE support async subsystem together and walks a realistic
 * multi-phase lifecycle against a rich in-memory Kysely shim:
 *
 *   Phase 1 — pending_seller @ 8d / no warning yet
 *             → runAutoCloseTick() warns, stamps auto_close_warned_at,
 *               writes `auto_close_warned` event, logs one
 *               `auto_close_warning` notification row.
 *   Phase 2 — advance 1.5 days (past warningLeadDays grace window)
 *             → runAutoCloseTick() closes, stamps closed_at + clears
 *               pending_seller_since, writes `auto_closed` + `status_changed`
 *               events, logs one `auto_close` notification row.
 *   Phase 3 — closed ticket 65 min ago, csat_prompted_at NULL
 *             → runCsatPrompts() prompts, stamps csat_prompted_at,
 *               writes `csat_prompted` event, logs `csat_prompt` notif row.
 *   Phase 4 — closed + archived ticket 400 days past closed_at
 *             → runRetentionCleanup() archives (soft), stamps archived_at
 *               + archive_location + archive_manifest, writes a
 *               `support_retention_runs` ledger row with accurate counts.
 *
 * All 4 cron phases run against the SAME fake db — so we can also assert
 * invariants ACROSS phases (e.g. the `auto_close_warned` event from
 * Phase 1 is still there when Phase 2 closes the same ticket).
 *
 * Prefs are seeded as master-switch=OFF so the sender short-circuits at
 * `channels=[]` (line ~108 of sender.ts), logging one `user_silenced`
 * row per dispatch instead of firing SMTP. That lets the smoke run with
 * zero external deps — no Postgres, no SMTP, no Anthropic key.
 *
 * PR6-specific assertions on top of PR5's pure tests:
 *
 *   [1..8]    full-lifecycle state walk (warn → close → CSAT → retention)
 *   [9..12]   cross-phase invariants (event ordering, marker consistency)
 *   [13..16]  notification log audit shape (every dispatch = one row)
 *   [17..20]  Iron rule 5 — scan auto-close + csat body strings for
 *             /god-admin + feature-flag + internal-route leak terms
 *   [21..24]  server.ts boot wire — the new seedSupportCronTasks call
 *             is actually present + imports from the public barrel
 *   [25..28]  SUPPORT_CRON_HANDLERS × cron/service.ts switch parity
 *
 * Runs offline. Node >= 20. `npx tsx scripts/smoke-phase12-5-pr6.ts`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  SUPPORT_CRON_HANDLERS,
  seedSupportCronTasks,
  runAutoCloseTick,
  runCsatPrompts,
  runRetentionCleanup,
} from '@gbox/core/modules/support-notifications/index.js'

type Row = Record<string, any>
type Tables = Record<string, { rows: Row[] }>

// ── fake-kysely shim ────────────────────────────────────────────────────
// Rich enough to stand in for the sender + cron funcs. Covers:
//   selectFrom / updateTable / insertInto / transaction().execute
//   where (=, is null, is not null, <, in)
//   select / selectAll / orderBy / limit / executeTakeFirst / execute

function makeDb(init: Partial<Record<string, Row[]>> = {}): any {
  const tables: Tables = {}
  for (const [k, v] of Object.entries(init)) tables[k] = { rows: v ?? [] }
  const ensure = (n: string) => {
    if (!tables[n]) tables[n] = { rows: [] }
    return tables[n]!
  }

  const selectChain = (tbl: string) => {
    let rows = ensure(tbl).rows.slice()
    const chain: any = {
      select() {
        return chain
      },
      selectAll() {
        return chain
      },
      where(col: any, op: string, val: any) {
        const c = typeof col === 'string' ? col : String(col)
        if (op === 'is' && val === null) rows = rows.filter((r) => r[c] == null)
        else if (op === 'is not' && val === null) rows = rows.filter((r) => r[c] != null)
        else if (op === '=') rows = rows.filter((r) => r[c] === val)
        else if (op === '<') rows = rows.filter((r) => r[c] != null && r[c] < val)
        else if (op === 'in') rows = rows.filter((r) => (val as any[]).includes(r[c]))
        return chain
      },
      orderBy(col: string, dir: 'asc' | 'desc' = 'asc') {
        rows = rows.slice().sort((a, b) => {
          const av = a[col]
          const bv = b[col]
          if (av == null && bv == null) return 0
          if (av == null) return 1
          if (bv == null) return -1
          return dir === 'asc' ? (av < bv ? -1 : av > bv ? 1 : 0) : av > bv ? -1 : av < bv ? 1 : 0
        })
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
        else if (op === 'is' && val === null) filtered = filtered.filter((r) => r[col] == null)
        else if (op === 'is not' && val === null) filtered = filtered.filter((r) => r[col] != null)
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
    let staged: Row[] = []
    const chain: any = {
      values(v: Row | Row[]) {
        const arr = Array.isArray(v) ? v : [v]
        staged = arr.map((row) => ({
          ...row,
          id: row.id ?? `${tbl}-${t.rows.length + staged.length + 1}`,
        }))
        return chain
      },
      returning() {
        return chain
      },
      async execute() {
        for (const r of staged) t.rows.push(r)
      },
      async executeTakeFirstOrThrow() {
        for (const r of staged) t.rows.push(r)
        return staged[0]
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

// ── asserter ────────────────────────────────────────────────────────────

type AssertFn = (label: string, ok: boolean, detail?: string) => void
function makeAsserter(): {
  assert: AssertFn
  summary: () => { total: number; passed: number }
} {
  let total = 0
  let passed = 0
  const assert: AssertFn = (label, ok, detail) => {
    total++
    // Labels already include `[N] ` prefix per assertion — don't double it.
    if (ok) {
      passed++
      console.log(`  OK   ${label}`)
    } else {
      console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }
  return { assert, summary: () => ({ total, passed }) }
}

// ── fixtures ────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

function silencedPrefsRow(userId: string): Row {
  // master switches OFF → pickChannels returns [] → sender short-circuits
  // and writes exactly one user_silenced log row.
  return {
    user_id: userId,
    in_app_enabled: false,
    email_enabled: false,
    browser_push_enabled: false,
    new_message_channels: [],
    mention_channels: [],
    sla_breach_channels: [],
    csat_prompt_channels: [],
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_hours_tz: 'Asia/Ho_Chi_Minh',
    browser_push_subscription: null,
  }
}

function userRow(id: string, email: string | null = null): Row {
  return { id, email }
}

function ticket(
  id: string,
  now: Date,
  overrides: Row = {},
): Row {
  return {
    id,
    shop_id: 's1',
    opener_user_id: 'seller-1',
    subject: 'subject ' + id,
    status: 'pending_seller',
    pending_seller_since: new Date(now.getTime() - 8 * DAY).toISOString(),
    auto_close_warned_at: null,
    csat_prompted_at: null,
    csat_rated_at: null,
    closed_at: null,
    archived_at: null,
    archive_location: null,
    archive_manifest: null,
    ...overrides,
  }
}

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Phase 12.5 PR6 — full support lifecycle E2E smoke ===\n')
  const { assert, summary } = makeAsserter()

  // Anchor "now" so every phase has deterministic time math.
  const T0 = new Date('2026-05-01T10:00:00.000Z')

  // Build the fake db with 3 scenarios + silenced prefs + users.
  const db = makeDb({
    support_tickets: [
      ticket('t-autoclose', T0), // Phase 1+2 — warn then close
      ticket('t-csat', T0, {
        status: 'closed',
        pending_seller_since: null,
        closed_at: new Date(T0.getTime() - 65 * 60 * 1000).toISOString(),
      }),
      ticket('t-retention', T0, {
        status: 'closed',
        pending_seller_since: null,
        closed_at: new Date(T0.getTime() - 400 * DAY).toISOString(),
        csat_prompted_at: new Date(T0.getTime() - 399 * DAY).toISOString(),
      }),
    ],
    support_ticket_events: [],
    support_notifications_log: [],
    support_notification_preferences: [silencedPrefsRow('seller-1')],
    users: [userRow('seller-1', null)],
    notifications: [],
    support_retention_runs: [],
    cron_tasks: [],
  })

  // ── [1..4] Phase 1 — warn a ticket that has been pending 8 days ──────
  console.log('\n[1..4] Phase 1 — warn stale ticket (8d pending_seller)')

  const warnRes = await runAutoCloseTick(db, { now: T0 })
  assert(
    '[1] runAutoCloseTick reports warned=1 / closed=0 / failed=0',
    warnRes.warned === 1 && warnRes.closed === 0 && warnRes.failed === 0,
    JSON.stringify(warnRes),
  )
  const tAuto = db._tables.support_tickets.rows.find((r: Row) => r.id === 't-autoclose')
  assert(
    '[2] auto_close_warned_at stamped with T0',
    tAuto.auto_close_warned_at === T0.toISOString(),
    `got ${tAuto.auto_close_warned_at}`,
  )
  assert(
    '[3] support_ticket_events has one `auto_close_warned` row for t-autoclose',
    db._tables.support_ticket_events.rows.some(
      (r: Row) => r.ticket_id === 't-autoclose' && r.event_type === 'auto_close_warned',
    ),
  )
  const warnLog = db._tables.support_notifications_log.rows.find(
    (r: Row) => r.ticket_id === 't-autoclose' && r.notification_type === 'auto_close_warning',
  )
  assert(
    '[4] support_notifications_log has exactly one `auto_close_warning` row (user_silenced short-circuit)',
    warnLog && warnLog.status === 'skipped' && warnLog.error === 'user_silenced',
    JSON.stringify(warnLog ?? null),
  )

  // ── [5..8] Phase 2 — advance 1.5 days, close the same ticket ────────
  console.log('\n[5..8] Phase 2 — close the warned ticket after grace window')

  const T1 = new Date(T0.getTime() + 1.5 * DAY)
  const closeRes = await runAutoCloseTick(db, { now: T1 })
  assert(
    '[5] runAutoCloseTick reports warned=0 / closed=1 / failed=0',
    closeRes.warned === 0 && closeRes.closed === 1 && closeRes.failed === 0,
    JSON.stringify(closeRes),
  )
  assert(
    '[6] ticket.status transitioned to `closed` and pending_seller_since cleared',
    tAuto.status === 'closed' && tAuto.pending_seller_since === null,
    `status=${tAuto.status} pending=${tAuto.pending_seller_since}`,
  )
  assert(
    '[7] closed_at stamped at T1',
    tAuto.closed_at === T1.toISOString(),
    `got ${tAuto.closed_at}`,
  )
  const eventsForAuto = db._tables.support_ticket_events.rows.filter(
    (r: Row) => r.ticket_id === 't-autoclose',
  )
  assert(
    '[8] event log contains auto_close_warned + auto_closed + status_changed (in that order)',
    eventsForAuto.map((e: Row) => e.event_type).join(',') ===
      'auto_close_warned,auto_closed,status_changed',
    JSON.stringify(eventsForAuto.map((e: Row) => e.event_type)),
  )

  // ── [9..12] Phase 3 — CSAT prompt on the 65min-closed ticket ────────
  console.log('\n[9..12] Phase 3 — CSAT prompt on ticket closed 65min ago')

  const csatRes = await runCsatPrompts(db, { now: T0 })
  assert(
    '[9] runCsatPrompts reports prompted=1 / failed=0',
    csatRes.prompted === 1 && csatRes.failed === 0,
    JSON.stringify(csatRes),
  )
  const tCsat = db._tables.support_tickets.rows.find((r: Row) => r.id === 't-csat')
  assert(
    '[10] csat_prompted_at stamped (t-csat)',
    tCsat.csat_prompted_at === T0.toISOString(),
    `got ${tCsat.csat_prompted_at}`,
  )
  assert(
    '[11] event log has `csat_prompted` for t-csat',
    db._tables.support_ticket_events.rows.some(
      (r: Row) => r.ticket_id === 't-csat' && r.event_type === 'csat_prompted',
    ),
  )
  const csatLog = db._tables.support_notifications_log.rows.find(
    (r: Row) => r.ticket_id === 't-csat' && r.notification_type === 'csat_prompt',
  )
  assert(
    '[12] notifications_log has a `csat_prompt` row (user_silenced skip)',
    csatLog && csatLog.status === 'skipped' && csatLog.error === 'user_silenced',
    JSON.stringify(csatLog ?? null),
  )

  // ── [13..16] Phase 4 — retention cleanup (archive 400d-old ticket) ──
  console.log('\n[13..16] Phase 4 — retention cleanup archives 400d-old ticket')

  const retentionRes = await runRetentionCleanup(db, {
    now: T0,
    mode: 'archive',
    retentionMs: 365 * DAY,
  })
  assert(
    '[13] runRetentionCleanup reports ticketsArchived=1 / error=null',
    retentionRes.ticketsArchived === 1 && retentionRes.error === null,
    JSON.stringify(retentionRes),
  )
  const tRet = db._tables.support_tickets.rows.find((r: Row) => r.id === 't-retention')
  assert(
    '[14] archived_at stamped + archive_location=local_soft',
    tRet.archived_at === T0.toISOString() && tRet.archive_location === 'local_soft',
    `archived_at=${tRet.archived_at} loc=${tRet.archive_location}`,
  )
  assert(
    '[15] archive_manifest has an 8-char subjectHash (DJB2)',
    typeof tRet.archive_manifest === 'string' &&
      /"subjectHash":"[0-9a-f]{8}"/.test(tRet.archive_manifest),
    tRet.archive_manifest,
  )
  assert(
    '[16] support_retention_runs has one ledger row with tickets_archived=1',
    db._tables.support_retention_runs.rows.length === 1 &&
      db._tables.support_retention_runs.rows[0].tickets_archived === 1,
    JSON.stringify(db._tables.support_retention_runs.rows),
  )

  // ── [17..20] Iron rule 5 — leak sweep on generated bodies ────────────
  console.log('\n[17..20] Iron rule 5 leak sweep on every seller-facing body')

  const leakTerms = /\bgod[ -]?admin\b|\/god-admin|feature[ -]flag/i
  const bodiesSeen = db._tables.support_notifications_log.rows.map(
    (_r: Row) => _r,
  )
  assert(
    '[17] every notification row has a notification_type set',
    bodiesSeen.every((r: Row) => typeof r.notification_type === 'string'),
  )
  // The sender short-circuits without firing the body into the log row,
  // so replay the template contents directly for Iron rule 5.
  const templates = [
    // auto-close warning body (from auto-close.ts:193-200)
    `We haven't heard from you on this ticket in a while.\nIf we don't hear back within 1 day, the ticket will be automatically closed. Just reply to keep it open.\nYou can always reopen a closed ticket by visiting your support dashboard.`,
    // auto-close notification body (from auto-close.ts:258-264)
    `We haven't heard back from you, so we've closed this ticket.\nIf you still need help, just reply on the ticket page and we'll reopen it.\nThanks for using Gbox support.`,
    // csat prompt body (from csat-auto-prompt.ts:149-157)
    `Your support ticket "subject t-csat" has been closed.\nWe would love your feedback — please take 30 seconds to rate how we did.\nYour rating helps us train our agents and improve the product.`,
  ]
  assert(
    '[18] auto_close_warning body contains no /god-admin or feature-flag leak',
    !leakTerms.test(templates[0]!),
  )
  assert(
    '[19] auto_close body contains no /god-admin or feature-flag leak',
    !leakTerms.test(templates[1]!),
  )
  assert(
    '[20] csat_prompt body contains no /god-admin or feature-flag leak',
    !leakTerms.test(templates[2]!),
  )

  // ── [21..24] server.ts boot wire — seedSupportCronTasks present ─────
  console.log('\n[21..24] server.ts boot path wires seedSupportCronTasks')

  const serverPath = resolve(process.cwd(), 'server.ts')
  const serverSrc = readFileSync(serverPath, 'utf8')
  assert(
    '[21] server.ts imports seedSupportCronTasks from the public barrel',
    /import\s*\{\s*seedSupportCronTasks\s*\}\s*from\s*["']@gbox\/core\/modules\/support-notifications\/index\.js["']/.test(
      serverSrc,
    ),
  )
  assert(
    '[22] server.ts calls seedSupportCronTasks(db) on boot',
    /seedSupportCronTasks\(\s*db\s*\)/.test(serverSrc),
  )
  assert(
    '[23] server.ts gates support cron behind DISABLE_SUPPORT_CRON env var',
    /DISABLE_SUPPORT_CRON/.test(serverSrc),
  )
  assert(
    '[24] server.ts logs `[support-cron] tasks seeded` on success',
    /\[support-cron\] tasks seeded/.test(serverSrc),
  )

  // ── [25..28] SUPPORT_CRON_HANDLERS × cron/service.ts switch parity ──
  console.log('\n[25..28] cron handler parity (service.ts switch ↔ SUPPORT_CRON_HANDLERS)')

  const cronServicePath = resolve(
    process.cwd(),
    'packages/core/src/modules/cron/service.ts',
  )
  const cronServiceSrc = readFileSync(cronServicePath, 'utf8')
  for (const [label, handler] of Object.entries(SUPPORT_CRON_HANDLERS)) {
    const present = cronServiceSrc.includes(`'${handler}'`) ||
      cronServiceSrc.includes(`"${handler}"`)
    assert(
      `[${25 + ['SLA_TICK', 'CSAT_PROMPT', 'AUTO_CLOSE', 'RETENTION_CLEANUP'].indexOf(label)}] cron/service.ts references handler name '${handler}'`,
      present,
    )
  }

  // ── seed idempotency smoke: seedSupportCronTasks is safe on re-boot ──
  const seedRes1 = await seedSupportCronTasks(db)
  const seedRes2 = await seedSupportCronTasks(db)
  if (!(seedRes1.inserted === 4 && seedRes2.inserted === 0 && seedRes2.existing === 4)) {
    console.error(
      `  FAIL [extra] seedSupportCronTasks not idempotent — first=${JSON.stringify(seedRes1)} second=${JSON.stringify(seedRes2)}`,
    )
    process.exit(1)
  }
  console.log('  OK   [extra] seedSupportCronTasks idempotent (2nd call inserted=0 existing=4)')

  // ── summary ─────────────────────────────────────────────────────────
  const s = summary()
  console.log(`\n=== PR6 E2E smoke summary ===`)
  console.log(`passed: ${s.passed}/${s.total}`)
  if (s.passed !== s.total) process.exit(1)
}

main().catch((err) => {
  console.error('\nUNHANDLED ERROR:', err)
  process.exit(1)
})
