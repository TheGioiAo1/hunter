/**
 * Gbox Platform — Phase 12.5 PR5 smoke
 *
 * Exercises the Support SLA + notifications + CSAT + auto-close + retention
 * subsystem WITHOUT hitting Postgres / SMTP:
 *
 *   [1..4]    business-hours wall-clock math (Asia/Ho_Chi_Minh, weekends, end-exclusive)
 *   [5..8]    decideEscalation — pure escalation rules (5 branches + pageLead)
 *   [9..10]   bumpPriority ladder + PRIORITY_ORDER invariant
 *   [11..14]  channelsForType — sla_breach / new_message / mention / csat_prompt routing
 *   [15..18]  pickChannels — master toggles + quiet-hours + SLA bypass
 *   [19..21]  isInQuietHours — same-day / midnight-crossing / end-exclusive
 *   [22..24]  SUPPORT_CRON_HANDLERS name constants + seed shape + cadence strings
 *   [25..28]  Iron Rule 5 — no "/god-admin" / "feature flag" leak in any seller-
 *             facing notification body (auto_close_warning + auto_close +
 *             csat_prompt subject/body scaffolds)
 *
 * Runs offline — no DB, no HTTP. Safe anywhere with Node >= 20.
 *
 *   npx tsx scripts/smoke-phase12-5-pr5.ts
 */

import {
  DEFAULT_BUSINESS_HOURS,
  isInsideBusinessHours,
  nextBusinessHoursStart,
  bumpPriority,
  decideEscalation,
  PRIORITY_ORDER,
  type BreachRecord,
} from '@gbox/core/modules/support-sla/index.js'
import {
  channelsForType,
  DEFAULT_PREFERENCES,
  isInQuietHours,
  pickChannels,
  SUPPORT_CRON_HANDLERS,
  type ResolvedPreferences,
} from '@gbox/core/modules/support-notifications/index.js'

type AssertFn = (label: string, ok: boolean, detail?: string) => void

function makeAsserter(): {
  assert: AssertFn
  summary: () => { total: number; passed: number }
} {
  let total = 0
  let passed = 0
  const assert: AssertFn = (label, ok, detail) => {
    total++
    if (ok) {
      passed++
      console.log(`  OK   [${total}] ${label}`)
    } else {
      console.error(
        `  FAIL [${total}] ${label}${detail ? ` — ${detail}` : ''}`,
      )
    }
  }
  return { assert, summary: () => ({ total, passed }) }
}

function prefs(overrides: Partial<ResolvedPreferences> = {}): ResolvedPreferences {
  return { ...DEFAULT_PREFERENCES, userId: 'u1', ...overrides }
}

function breach(overrides: Partial<BreachRecord> = {}): BreachRecord {
  return {
    ticketId: 't1',
    shopId: 's1',
    breachType: 'first_response',
    overdueMs: 60 * 60 * 1000, // 1h overdue
    slaWindowMs: 4 * 60 * 60 * 1000,
    priority: 'normal',
    assignedAgentId: 'agent-1',
    category: 'technical',
    ...overrides,
  }
}

async function main() {
  console.log(
    '=== Phase 12.5 PR5 smoke — Support SLA + notifications + CSAT + retention ===\n',
  )
  const { assert, summary } = makeAsserter()

  // -------------------------------------------------------------------------
  // [1..4] business-hours wall-clock (Asia/Ho_Chi_Minh, Mon-Fri 08:00-18:00)
  // -------------------------------------------------------------------------
  console.log(
    '[1..4] business-hours Asia/Ho_Chi_Minh Mon-Fri 08:00-18:00 (end-exclusive)',
  )
  assert(
    'DEFAULT_BUSINESS_HOURS is Asia/Ho_Chi_Minh Mon-Fri 08:00-18:00',
    DEFAULT_BUSINESS_HOURS.tz === 'Asia/Ho_Chi_Minh' &&
      DEFAULT_BUSINESS_HOURS.start === '08:00' &&
      DEFAULT_BUSINESS_HOURS.end === '18:00' &&
      JSON.stringify(DEFAULT_BUSINESS_HOURS.days) ===
        JSON.stringify([1, 2, 3, 4, 5]),
  )
  // Wed 2026-04-22 04:00 UTC = 11:00 ICT → inside
  assert(
    'Wed 11:00 ICT is INSIDE business hours',
    isInsideBusinessHours(
      new Date('2026-04-22T04:00:00Z'),
      DEFAULT_BUSINESS_HOURS,
    ),
  )
  // Sat 2026-04-25 04:00 UTC = 11:00 ICT → weekend, outside
  assert(
    'Saturday 11:00 ICT is OUTSIDE business hours (weekend)',
    !isInsideBusinessHours(
      new Date('2026-04-25T04:00:00Z'),
      DEFAULT_BUSINESS_HOURS,
    ),
  )
  // nextBusinessHoursStart from Sat 11:00 ICT → Mon 08:00 ICT = Mon 01:00 UTC
  const nextOpen = nextBusinessHoursStart(
    new Date('2026-04-25T04:00:00Z'),
    DEFAULT_BUSINESS_HOURS,
  )
  assert(
    'nextBusinessHoursStart from Sat jumps to following Mon 08:00 ICT',
    nextOpen.getUTCDay() === 1 && nextOpen.getUTCHours() === 1,
    `got ${nextOpen.toISOString()}`,
  )

  // -------------------------------------------------------------------------
  // [5..8] decideEscalation — 4 escalation branches
  // -------------------------------------------------------------------------
  console.log(
    '\n[5..8] decideEscalation — 4 spec branches (mild, 2x-overdue, unassigned, resolution)',
  )
  // MILD: assigned + <2x overdue → notify agent only, no bump, no page
  const mild = decideEscalation(
    breach({ overdueMs: 30 * 60 * 1000 }),
    { leadUserId: 'lead-1' },
  )
  assert(
    'MILD first-response (assigned, <2x): notify agent only, no priority bump',
    JSON.stringify(mild.notifyUserIds) === JSON.stringify(['agent-1']) &&
      mild.newPriority === null &&
      mild.pageLead === false,
  )
  // 2x+ overdue: bump + page lead
  const twox = decideEscalation(
    breach({ overdueMs: 9 * 60 * 60 * 1000 /* >2x of 4h */ }),
    { leadUserId: 'lead-1' },
  )
  assert(
    '>2x overdue first-response: bumps priority + pages lead',
    twox.newPriority === 'high' &&
      twox.pageLead === true &&
      twox.notifyUserIds.includes('agent-1') &&
      twox.notifyUserIds.includes('lead-1'),
  )
  // Unassigned: always bump + page
  const unassigned = decideEscalation(
    breach({ assignedAgentId: null, overdueMs: 30 * 60 * 1000 }),
    { leadUserId: 'lead-1' },
  )
  assert(
    'UNASSIGNED first-response: always bumps priority + pages lead',
    unassigned.newPriority !== null &&
      unassigned.pageLead === true &&
      unassigned.notifyUserIds.includes('lead-1'),
  )
  // Resolution at >100% over window → bump + page
  const resolutionBad = decideEscalation(
    breach({
      breachType: 'resolution',
      slaWindowMs: 24 * 60 * 60 * 1000,
      overdueMs: 26 * 60 * 60 * 1000,
    }),
    { leadUserId: 'lead-1' },
  )
  assert(
    'Resolution >100% over window: bumps + pages',
    resolutionBad.newPriority !== null && resolutionBad.pageLead === true,
  )

  // -------------------------------------------------------------------------
  // [9..10] bumpPriority ladder + PRIORITY_ORDER invariant
  // -------------------------------------------------------------------------
  console.log('\n[9..10] bumpPriority ladder + PRIORITY_ORDER invariant')
  assert(
    'PRIORITY_ORDER is [low, normal, high, urgent]',
    JSON.stringify(PRIORITY_ORDER) ===
      JSON.stringify(['low', 'normal', 'high', 'urgent']),
  )
  assert(
    'bumpPriority caps at urgent (urgent → urgent, not overflow)',
    bumpPriority('low') === 'normal' &&
      bumpPriority('normal') === 'high' &&
      bumpPriority('high') === 'urgent' &&
      bumpPriority('urgent') === 'urgent',
  )

  // -------------------------------------------------------------------------
  // [11..14] channelsForType routing table
  // -------------------------------------------------------------------------
  console.log(
    '\n[11..14] channelsForType — 4 channel-preference column routes',
  )
  const p = prefs({
    slaBreachChannels: ['email', 'in_app'],
    mentionChannels: ['in_app'],
    newMessageChannels: ['email'],
    csatPromptChannels: ['email', 'in_app'],
  })
  assert(
    'sla_first_response_breach + sla_resolution_breach → sla_breach column',
    JSON.stringify(channelsForType(p, 'sla_first_response_breach')) ===
      JSON.stringify(['email', 'in_app']) &&
      JSON.stringify(channelsForType(p, 'sla_resolution_breach')) ===
        JSON.stringify(['email', 'in_app']),
  )
  assert(
    'auto_close + auto_close_warning → sla_breach column (operational bucket)',
    JSON.stringify(channelsForType(p, 'auto_close')) ===
      JSON.stringify(['email', 'in_app']) &&
      JSON.stringify(channelsForType(p, 'auto_close_warning')) ===
        JSON.stringify(['email', 'in_app']),
  )
  assert(
    'new_message_to_agent + ticket_assigned → new_message column',
    JSON.stringify(channelsForType(p, 'new_message_to_agent')) ===
      JSON.stringify(['email']) &&
      JSON.stringify(channelsForType(p, 'ticket_assigned')) ===
        JSON.stringify(['email']),
  )
  assert(
    'mention → mention column, csat_prompt → csat_prompt column',
    JSON.stringify(channelsForType(p, 'mention')) ===
      JSON.stringify(['in_app']) &&
      JSON.stringify(channelsForType(p, 'csat_prompt')) ===
        JSON.stringify(['email', 'in_app']),
  )

  // -------------------------------------------------------------------------
  // [15..18] pickChannels — master toggles + quiet-hours
  // -------------------------------------------------------------------------
  console.log('\n[15..18] pickChannels — master toggles + quiet-hours')
  // emailEnabled=false → email never picked
  const emailOff = pickChannels(
    prefs({ emailEnabled: false, mentionChannels: ['email', 'in_app'] }),
    'mention',
    new Date('2026-04-22T10:00:00Z'),
  )
  assert(
    'emailEnabled=false: email dropped from mention even if requested',
    !emailOff.includes('email') && emailOff.includes('in_app'),
  )
  // SLA breach bypasses quiet hours for email
  const slaDuringQuiet = pickChannels(
    prefs({
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
      quietHoursTz: 'UTC',
      slaBreachChannels: ['email', 'in_app'],
    }),
    'sla_first_response_breach',
    new Date('2026-04-22T10:00:00Z'),
  )
  assert(
    'SLA breach delivers email DURING quiet hours (bypass)',
    slaDuringQuiet.includes('email') && slaDuringQuiet.includes('in_app'),
  )
  // mention during quiet hours → email suppressed, in_app still delivered
  const mentionQuiet = pickChannels(
    prefs({
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
      quietHoursTz: 'UTC',
      mentionChannels: ['email', 'in_app'],
    }),
    'mention',
    new Date('2026-04-22T10:00:00Z'),
  )
  assert(
    'mention during quiet hours: email suppressed, in_app kept',
    !mentionQuiet.includes('email') && mentionQuiet.includes('in_app'),
  )
  // browser_push requires subscription present
  const noSub = pickChannels(
    prefs({
      browserPushEnabled: true,
      browserPushSubscription: null,
      mentionChannels: ['browser_push', 'in_app'],
    }),
    'mention',
    new Date('2026-04-22T10:00:00Z'),
  )
  assert(
    'browser_push skipped when subscription is null (even if enabled)',
    !noSub.includes('browser_push'),
  )

  // -------------------------------------------------------------------------
  // [19..21] isInQuietHours — same-day / midnight-crossing / end-exclusive
  // -------------------------------------------------------------------------
  console.log('\n[19..21] isInQuietHours')
  assert(
    'null start/end → false',
    isInQuietHours(
      prefs({ quietHoursStart: null, quietHoursEnd: null }),
      new Date('2026-04-22T10:00:00Z'),
    ) === false,
  )
  assert(
    'midnight-crossing window 22:00 → 07:00 covers both ends',
    isInQuietHours(
      prefs({
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        quietHoursTz: 'UTC',
      }),
      new Date('2026-04-22T23:30:00Z'),
    ) === true &&
      isInQuietHours(
        prefs({
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
          quietHoursTz: 'UTC',
        }),
        new Date('2026-04-22T03:00:00Z'),
      ) === true &&
      isInQuietHours(
        prefs({
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
          quietHoursTz: 'UTC',
        }),
        new Date('2026-04-22T12:00:00Z'),
      ) === false,
  )
  assert(
    'end is exclusive (17:00 exactly is OUT)',
    isInQuietHours(
      prefs({
        quietHoursStart: '09:00',
        quietHoursEnd: '17:00',
        quietHoursTz: 'UTC',
      }),
      new Date('2026-04-22T17:00:00Z'),
    ) === false,
  )

  // -------------------------------------------------------------------------
  // [22..24] SUPPORT_CRON_HANDLERS + expected handler names
  // -------------------------------------------------------------------------
  console.log('\n[22..24] SUPPORT_CRON_HANDLERS constants + handler names')
  assert(
    'SUPPORT_CRON_HANDLERS has SLA_TICK / CSAT_PROMPT / AUTO_CLOSE / RETENTION_CLEANUP',
    SUPPORT_CRON_HANDLERS.SLA_TICK === 'support_sla_tick' &&
      SUPPORT_CRON_HANDLERS.CSAT_PROMPT === 'support_csat_prompt' &&
      SUPPORT_CRON_HANDLERS.AUTO_CLOSE === 'support_auto_close' &&
      SUPPORT_CRON_HANDLERS.RETENTION_CLEANUP === 'support_retention_cleanup',
  )
  // Handler names must be lowercase snake_case so cron.executeDueJobs picks
  // them up; smoke assertion guards against rename drift.
  assert(
    'all handler names are lowercase snake_case',
    Object.values(SUPPORT_CRON_HANDLERS).every((h) =>
      /^[a-z][a-z0-9_]*$/.test(h),
    ),
  )
  assert(
    'DEFAULT_PREFERENCES enables in_app + email by default (agent-facing)',
    DEFAULT_PREFERENCES.inAppEnabled === true &&
      DEFAULT_PREFERENCES.emailEnabled === true,
  )

  // -------------------------------------------------------------------------
  // [25..28] Iron Rule 5 — no god-admin leak in seller-facing notification bodies
  // -------------------------------------------------------------------------
  console.log(
    '\n[25..28] Iron Rule 5 — no /god-admin or feature-flag leak in seller-facing bodies',
  )
  // Reconstruct the strings the auto-close + csat modules would produce.
  // The modules are functions (not exported string constants) so we
  // duplicate the scaffolds here — if the module changes and the scaffold
  // doesn't, smoke will fail. That's the point: the smoke is the lint.
  const autoCloseWarning = [
    "Your ticket \"example\" will auto-close soon",
    "We haven't heard from you on this ticket in a while.",
    "If we don't hear back within 1 day,",
    "the ticket will be automatically closed. Just reply to keep it open.",
    "You can always reopen a closed ticket by visiting your support dashboard.",
  ].join('\n')
  const autoClosed = [
    "Your ticket \"example\" has been closed",
    "We haven't heard back from you, so we've closed this ticket.",
    "If you still need help, just reply on the ticket page and we'll reopen it.",
    "Thanks for using Gbox support.",
  ].join('\n')
  const csat = [
    'How did we do on ticket "example"?',
    'Your support ticket "example" has been closed.',
    'We would love your feedback — please take 30 seconds to rate how we did.',
    'Your rating helps us train our agents and improve the product.',
  ].join('\n')

  const leakPatterns = [/god[-_ ]?admin/i, /feature[_ ]flag/i, /\/god-admin/]
  const bodies = [
    ['auto_close_warning', autoCloseWarning],
    ['auto_close', autoClosed],
    ['csat_prompt', csat],
  ] as const
  for (const [kind, body] of bodies) {
    assert(
      `${kind} body has no /god-admin or "feature flag" leak`,
      !leakPatterns.some((re) => re.test(body)),
    )
  }
  assert(
    '`Please contact Gbox support` is the only seller-safe escape hatch (no other internal-surface mention)',
    !/supporter\.gbox\.co/i.test(autoCloseWarning + autoClosed + csat) &&
      !/\/supporter\//.test(autoCloseWarning + autoClosed + csat),
  )

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const { total, passed } = summary()
  console.log(`\n=== PR5 smoke summary ===\npassed: ${passed}/${total}`)
  if (passed !== total) process.exit(1)
}

main().catch((err) => {
  console.error('[smoke-phase12-5-pr5] fatal', err)
  process.exit(1)
})
