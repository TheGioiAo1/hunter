/**
 * agent-daily-digest.test.ts
 *
 * Covers the three pure parts: stats aggregation, subject rendering,
 * and HTML escape/rendering. Does NOT hit a real Postgres — we pass
 * a stub Kysely that returns canned rows from selectAll.
 */

import { describe, it, expect } from 'vitest'
import {
  buildDigestStats,
  renderDigestHtml,
  renderDigestSubject,
  type DigestStats,
} from './agent-daily-digest.ts'

/**
 * Minimal fake Kysely: we only need `.selectFrom('agent_sessions')
 * .where().where().selectAll().execute()` to return our canned rows.
 * Each intermediate call returns `this` so the chain works.
 */
function fakeDb(rows: Array<Record<string, unknown>>) {
  const chain = {
    where() {
      return chain
    },
    selectAll() {
      return chain
    },
    async execute() {
      return rows
    },
  }
  return {
    selectFrom(_: string) {
      return chain
    },
  } as unknown as Parameters<typeof buildDigestStats>[0]
}

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'aid-1',
    god_admin_id: 'god-1',
    started_at: '2026-04-09T00:00:00Z',
    ended_at: '2026-04-09T00:05:00Z',
    ended_reason: 'complete',
    prompt_count: 3,
    tool_call_count: 5,
    tool_call_rejected_count: 0,
    approval_count: 1,
    approval_denied_count: 0,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    cost_usd: '0.012500',
    conversation: [],
    compacted_context: null,
    compact_count: 0,
    system_prompt_version: 'sha256:abc',
    model: 'claude-opus-4-6',
    ...overrides,
  }
}

describe('buildDigestStats', () => {
  it('returns zeroes when no sessions in window', async () => {
    const db = fakeDb([])
    const stats = await buildDigestStats(
      db,
      new Date('2026-04-09T00:00:00Z'),
      new Date('2026-04-10T00:00:00Z'),
    )
    expect(stats.sessionCount).toBe(0)
    expect(stats.totalPrompts).toBe(0)
    expect(stats.totalCostUsd).toBe('0.000000')
    expect(stats.topErrorReasons).toEqual([])
  })

  it('sums across sessions and formats cost without float drift', async () => {
    const db = fakeDb([
      row({ cost_usd: '0.012500', prompt_count: 3 }),
      row({ cost_usd: '0.007500', prompt_count: 2 }),
      row({ cost_usd: '0.000001', prompt_count: 1 }),
    ])
    const stats = await buildDigestStats(
      db,
      new Date('2026-04-09T00:00:00Z'),
      new Date('2026-04-10T00:00:00Z'),
    )
    expect(stats.sessionCount).toBe(3)
    expect(stats.totalPrompts).toBe(6)
    expect(stats.totalCostUsd).toBe('0.020001')
  })

  it('ranks ended_reason values, excluding "complete"', async () => {
    const db = fakeDb([
      row({ ended_reason: 'complete' }),
      row({ ended_reason: 'complete' }),
      row({ ended_reason: 'killswitch' }),
      row({ ended_reason: 'timeout' }),
      row({ ended_reason: 'timeout' }),
      row({ ended_reason: 'error' }),
    ])
    const stats = await buildDigestStats(
      db,
      new Date('2026-04-09T00:00:00Z'),
      new Date('2026-04-10T00:00:00Z'),
    )
    expect(stats.topErrorReasons).toEqual([
      { reason: 'timeout', count: 2 },
      { reason: 'killswitch', count: 1 },
      { reason: 'error', count: 1 },
    ])
  })

  it('caps top error reasons at 5', async () => {
    const reasons = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const rows = reasons.map((r) => row({ ended_reason: r }))
    const db = fakeDb(rows)
    const stats = await buildDigestStats(
      db,
      new Date('2026-04-09T00:00:00Z'),
      new Date('2026-04-10T00:00:00Z'),
    )
    expect(stats.topErrorReasons).toHaveLength(5)
  })
})

describe('renderDigestSubject', () => {
  it('formats with date + session count + cost', () => {
    const stats: DigestStats = {
      windowStart: '2026-04-08T00:00:00.000Z',
      windowEnd: '2026-04-09T00:00:00.000Z',
      sessionCount: 12,
      totalPrompts: 48,
      totalToolCalls: 120,
      totalToolCallsRejected: 3,
      totalApprovals: 5,
      totalApprovalsDenied: 1,
      totalInputTokens: 50_000,
      totalOutputTokens: 20_000,
      totalCostUsd: '1.234567',
      topErrorReasons: [],
    }
    expect(renderDigestSubject(stats)).toBe('[Gbox Agent] 2026-04-09 — 12 sessions, $1.234567')
  })
})

describe('renderDigestHtml', () => {
  it('escapes HTML-sensitive characters in values', () => {
    const stats: DigestStats = {
      windowStart: '2026-04-08T00:00:00.000Z',
      windowEnd: '2026-04-09T00:00:00.000Z',
      sessionCount: 1,
      totalPrompts: 1,
      totalToolCalls: 0,
      totalToolCallsRejected: 0,
      totalApprovals: 0,
      totalApprovalsDenied: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: '0.000000',
      topErrorReasons: [{ reason: '<script>alert(1)</script>', count: 1 }],
    }
    const html = renderDigestHtml(stats)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('shows placeholder row when there are no error reasons', () => {
    const stats: DigestStats = {
      windowStart: '2026-04-08T00:00:00.000Z',
      windowEnd: '2026-04-09T00:00:00.000Z',
      sessionCount: 1,
      totalPrompts: 1,
      totalToolCalls: 0,
      totalToolCallsRejected: 0,
      totalApprovals: 0,
      totalApprovalsDenied: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: '0.000000',
      topErrorReasons: [],
    }
    const html = renderDigestHtml(stats)
    expect(html).toContain('No non-complete session endings.')
  })
})
