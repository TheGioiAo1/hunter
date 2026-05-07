#!/usr/bin/env node
/**
 * agent-daily-digest.ts — summarise yesterday's agent activity and
 * email it to the god admin.
 *
 * Scheduled via systemd timer / cron on server 1, typically at 06:00
 * GMT+7 (= 23:00 UTC previous day) so the overnight digest lands in
 * the owner's inbox before the workday starts.
 *
 * CLI:
 *   npx tsx scripts/cron/agent-daily-digest.ts \
 *     [--at=<iso>] \
 *     [--to=email@example.com] \
 *     [--dry-run] \
 *     [--window-hours=24]
 *
 * Exit codes:
 *   0 — digest built (and sent, unless --dry-run)
 *   1 — no sessions in the window (still "ok", no email sent)
 *   2 — failure (DB unreachable, email failed, bad args)
 *
 * Report line: single JSON object on the last non-empty stdout line,
 *   same convention as scripts/deploy/*.ts so monitoring can parse it.
 */

import { createDb, destroyDb } from '@gbox/db'
import type { Kysely } from 'kysely'
import type { Database } from '@gbox/db'

interface Args {
  at: Date
  to: string | null
  dryRun: boolean
  windowHours: number
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    at: new Date(),
    to: null,
    dryRun: false,
    windowHours: 24,
  }
  for (const a of argv) {
    if (a.startsWith('--at=')) {
      const iso = a.slice('--at='.length)
      const d = new Date(iso)
      if (isNaN(d.getTime())) throw new Error(`invalid --at: ${iso}`)
      out.at = d
    } else if (a.startsWith('--to=')) {
      out.to = a.slice('--to='.length)
    } else if (a === '--dry-run') {
      out.dryRun = true
    } else if (a.startsWith('--window-hours=')) {
      const n = parseInt(a.slice('--window-hours='.length), 10)
      if (!Number.isFinite(n) || n <= 0) throw new Error('--window-hours must be a positive integer')
      out.windowHours = n
    }
  }
  return out
}

export interface DigestStats {
  windowStart: string
  windowEnd: string
  sessionCount: number
  totalPrompts: number
  totalToolCalls: number
  totalToolCallsRejected: number
  totalApprovals: number
  totalApprovalsDenied: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: string
  topErrorReasons: Array<{ reason: string; count: number }>
}

/**
 * Collect stats from the agent_sessions table for the given window.
 *
 * We intentionally do NOT join to the conversation JSONB — the
 * digest is meant to be fast (< 200ms) and give a high-level view.
 * If Thai wants to dig in, he clicks through to the replay UI from
 * the email.
 */
export async function buildDigestStats(
  db: Kysely<Database>,
  windowStart: Date,
  windowEnd: Date,
): Promise<DigestStats> {
  const rows = await db
    .selectFrom('agent_sessions')
    .where('started_at', '>=', windowStart.toISOString() as unknown as never)
    .where('started_at', '<', windowEnd.toISOString() as unknown as never)
    .selectAll()
    .execute()

  let totalPrompts = 0
  let totalToolCalls = 0
  let totalToolCallsRejected = 0
  let totalApprovals = 0
  let totalApprovalsDenied = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostCents = 0 // sum in micro-dollars (6 d.p.) to avoid float drift
  const errorReasonCounts = new Map<string, number>()

  for (const r of rows) {
    totalPrompts += r.prompt_count
    totalToolCalls += r.tool_call_count
    totalToolCallsRejected += r.tool_call_rejected_count
    totalApprovals += r.approval_count
    totalApprovalsDenied += r.approval_denied_count
    totalInputTokens += r.total_input_tokens
    totalOutputTokens += r.total_output_tokens
    // cost_usd is NUMERIC(12,6) → arrives as a string. Parse defensively.
    const cost = Number(r.cost_usd)
    if (Number.isFinite(cost)) totalCostCents += Math.round(cost * 1_000_000)

    if (r.ended_reason && r.ended_reason !== 'complete') {
      errorReasonCounts.set(
        r.ended_reason,
        (errorReasonCounts.get(r.ended_reason) ?? 0) + 1,
      )
    }
  }

  const topErrorReasons = [...errorReasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }))

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    sessionCount: rows.length,
    totalPrompts,
    totalToolCalls,
    totalToolCallsRejected,
    totalApprovals,
    totalApprovalsDenied,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: (totalCostCents / 1_000_000).toFixed(6),
    topErrorReasons,
  }
}

export function renderDigestHtml(stats: DigestStats): string {
  const errRows = stats.topErrorReasons.length
    ? stats.topErrorReasons
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.reason)}</td><td style="text-align:right">${e.count}</td></tr>`,
        )
        .join('')
    : `<tr><td colspan="2" style="color:#999">No non-complete session endings.</td></tr>`

  return `
<!doctype html>
<html>
<body style="font-family: -apple-system, system-ui, sans-serif; color:#222; max-width:640px; margin:0 auto; padding:24px">
  <h1 style="font-size:20px; margin:0 0 4px 0">Gbox Agent — Daily Digest</h1>
  <p style="color:#666; margin:0 0 20px 0">
    Window: ${escapeHtml(stats.windowStart)} → ${escapeHtml(stats.windowEnd)}
  </p>

  <table style="width:100%; border-collapse:collapse; margin-bottom:20px">
    <tr><td style="padding:6px 0; color:#666">Sessions</td><td style="padding:6px 0; text-align:right; font-weight:600">${stats.sessionCount}</td></tr>
    <tr><td style="padding:6px 0; color:#666">Prompts</td><td style="padding:6px 0; text-align:right">${stats.totalPrompts}</td></tr>
    <tr><td style="padding:6px 0; color:#666">Tool calls</td><td style="padding:6px 0; text-align:right">${stats.totalToolCalls} <span style="color:#c00">(${stats.totalToolCallsRejected} rejected)</span></td></tr>
    <tr><td style="padding:6px 0; color:#666">Approvals</td><td style="padding:6px 0; text-align:right">${stats.totalApprovals} <span style="color:#c00">(${stats.totalApprovalsDenied} denied)</span></td></tr>
    <tr><td style="padding:6px 0; color:#666">Input tokens</td><td style="padding:6px 0; text-align:right">${stats.totalInputTokens.toLocaleString()}</td></tr>
    <tr><td style="padding:6px 0; color:#666">Output tokens</td><td style="padding:6px 0; text-align:right">${stats.totalOutputTokens.toLocaleString()}</td></tr>
    <tr><td style="padding:6px 0; color:#666">Estimated cost</td><td style="padding:6px 0; text-align:right; font-weight:600">$${escapeHtml(stats.totalCostUsd)}</td></tr>
  </table>

  <h2 style="font-size:16px; margin:0 0 8px 0">Top error reasons</h2>
  <table style="width:100%; border-collapse:collapse; margin-bottom:20px">
    ${errRows}
  </table>

  <p style="color:#666; font-size:12px; margin-top:24px">
    — <a href="http://192.168.1.13/god-admin/agent/sessions">View all sessions in the dashboard →</a>
  </p>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderDigestSubject(stats: DigestStats): string {
  const date = stats.windowEnd.slice(0, 10)
  return `[Gbox Agent] ${date} — ${stats.sessionCount} sessions, $${stats.totalCostUsd}`
}

/**
 * Wire the stats builder + renderer + mailer. Injectable for tests.
 */
export interface DigestDeps {
  db: Kysely<Database>
  sendMail?: (opts: { to: string; subject: string; html: string }) => Promise<void>
  /** Override "now" for deterministic tests. */
  now?: Date
}

export async function runDigest(
  args: Args,
  deps: DigestDeps,
): Promise<{ ok: boolean; stats: DigestStats; sent: boolean }> {
  const windowEnd = args.at
  const windowStart = new Date(windowEnd.getTime() - args.windowHours * 60 * 60 * 1000)

  const stats = await buildDigestStats(deps.db, windowStart, windowEnd)

  if (stats.sessionCount === 0) {
    return { ok: true, stats, sent: false }
  }

  if (args.dryRun || !args.to) {
    return { ok: true, stats, sent: false }
  }

  const subject = renderDigestSubject(stats)
  const html = renderDigestHtml(stats)

  const sender = deps.sendMail ?? defaultSendMail
  await sender({ to: args.to, subject, html })

  return { ok: true, stats, sent: true }
}

async function defaultSendMail(opts: {
  to: string
  subject: string
  html: string
}): Promise<void> {
  // Lazy-import the core email module so this script runs even on
  // servers that haven't installed nodemailer yet (they'll fall back
  // to --dry-run as documented in the runbook).
  const mod = (await import('../../packages/core/src/modules/email/service.ts')) as {
    sendEmail: (o: { to: string; subject: string; html: string }) => Promise<string>
  }
  await mod.sendEmail(opts)
}

function emit(report: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(report) + '\n')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const db = createDb()
  try {
    const result = await runDigest(args, { db })
    emit({
      script: 'agent-daily-digest',
      ok: result.ok,
      sent: result.sent,
      to: args.to,
      dryRun: args.dryRun,
      stats: result.stats,
    })
    process.exit(result.stats.sessionCount === 0 ? 1 : 0)
  } finally {
    await destroyDb(db)
  }
}

const isDirect = process.argv[1]?.endsWith('agent-daily-digest.ts')
if (isDirect) {
  void main().catch((err) => {
    emit({
      script: 'agent-daily-digest',
      ok: false,
      error: (err as Error).message,
    })
    process.exit(2)
  })
}
