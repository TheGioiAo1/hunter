/**
 * Unit tests for the email analytics module (Phase 14 PR4).
 *
 * These tests focus on the data-shape / zero-division / zero-fill
 * logic — the parts of the module that are TypeScript, not SQL. The
 * actual Postgres queries are exercised end-to-end by the PR4 smoke
 * test (scripts/smoke-phase14-pr4.ts) against a live DB; unit-testing
 * Kysely's SQL generation here would just re-implement its tests.
 *
 * Tests:
 *   §1 lastNDays              — range math, UTC-anchored
 *   §2 pct policy             — zero-division, clamping, rounding
 *   §3 getEmailSummary        — aggregation + rate shape (Kysely fake)
 *   §4 getDailyEmailMetrics   — zero-fill for missing days
 *   §5 getTemplateBreakdown   — sort order, limit clamping
 */

import { describe, it, expect } from 'vitest'
import {
  getEmailSummary,
  getDailyEmailMetrics,
  getTemplateBreakdown,
  getTopTemplates,
  lastNDays,
} from './analytics.js'

// ---------------------------------------------------------------------------
// Kysely fake — minimal shape needed by the queries under test
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function makeDb(rows: Row[] | (() => Row[])): any {
  const get = () => (typeof rows === 'function' ? rows() : rows)
  const chain: any = {
    selectFrom: () => chain,
    select: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    executeTakeFirstOrThrow: async () => get()[0] ?? {},
    executeTakeFirst: async () => get()[0] ?? null,
    execute: async () => get(),
  }
  return chain
}

// ---------------------------------------------------------------------------
// §1 lastNDays
// ---------------------------------------------------------------------------

describe('lastNDays', () => {
  it('returns today for n=1', () => {
    const today = new Date('2026-05-15T12:00:00Z')
    const r = lastNDays(1, today)
    expect(r.since).toBe('2026-05-15')
    expect(r.until).toBe('2026-05-15')
  })

  it('returns a 7-day window inclusive', () => {
    const today = new Date('2026-05-15T12:00:00Z')
    const r = lastNDays(7, today)
    expect(r.since).toBe('2026-05-09')
    expect(r.until).toBe('2026-05-15')
  })

  it('handles 30-day window across month boundary', () => {
    const today = new Date('2026-05-01T12:00:00Z')
    const r = lastNDays(30, today)
    expect(r.since).toBe('2026-04-02')
    expect(r.until).toBe('2026-05-01')
  })

  it('clamps n <= 0 to today', () => {
    const today = new Date('2026-05-15T12:00:00Z')
    const r = lastNDays(0, today)
    expect(r.since).toBe('2026-05-15')
    expect(r.until).toBe('2026-05-15')
  })
})

// ---------------------------------------------------------------------------
// §2 Rate / summary shape
// ---------------------------------------------------------------------------

describe('getEmailSummary', () => {
  it('computes rates with bounce-aware delivered denominator', async () => {
    const db = makeDb([
      {
        sent: 100,
        bounced: 10,
        opens: 70,
        clicks: 30,
        unique_opens: 50,
        unique_clicks: 20,
      },
    ])
    const out = await getEmailSummary(db, 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    })
    expect(out.sent).toBe(100)
    expect(out.bounced).toBe(10)
    expect(out.delivered).toBe(90)           // sent - bounced
    expect(out.opens).toBe(70)
    expect(out.clicks).toBe(30)
    expect(out.uniqueOpens).toBe(50)
    expect(out.uniqueClicks).toBe(20)
    expect(out.openRate).toBe(55.56)          // 50/90
    expect(out.clickRate).toBe(22.22)         // 20/90
    expect(out.bounceRate).toBe(10)           // 10/100
    expect(out.clickThroughRate).toBe(40)     // 20/50
  })

  it('returns all-zero summary when table is empty (no NaN)', async () => {
    const db = makeDb([
      { sent: 0, bounced: 0, opens: 0, clicks: 0, unique_opens: 0, unique_clicks: 0 },
    ])
    const out = await getEmailSummary(db, 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    })
    expect(out.sent).toBe(0)
    expect(out.delivered).toBe(0)
    expect(out.openRate).toBe(0)
    expect(out.clickRate).toBe(0)
    expect(out.bounceRate).toBe(0)
    expect(out.clickThroughRate).toBe(0)
  })

  it('coerces string counts (pg BIGINT) into numbers', async () => {
    const db = makeDb([
      {
        sent: '42',
        bounced: '5',
        opens: '30',
        clicks: '10',
        unique_opens: '20',
        unique_clicks: '7',
      },
    ])
    const out = await getEmailSummary(db, 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    })
    expect(out.sent).toBe(42)
    expect(out.delivered).toBe(37)
    expect(typeof out.openRate).toBe('number')
    expect(Number.isFinite(out.openRate)).toBe(true)
  })

  it('clamps open rate to <=100 if counter drift', async () => {
    // Pathological data — unique_opens > delivered (shouldn't happen
    // but audit leniency). pct() clamps.
    const db = makeDb([
      {
        sent: 10,
        bounced: 0,
        opens: 1000,
        clicks: 500,
        unique_opens: 15,
        unique_clicks: 12,
      },
    ])
    const out = await getEmailSummary(db, 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    })
    expect(out.openRate).toBeLessThanOrEqual(100)
    expect(out.clickRate).toBeLessThanOrEqual(100)
  })
})

// ---------------------------------------------------------------------------
// §3 Daily zero-fill
// ---------------------------------------------------------------------------

describe('getDailyEmailMetrics', () => {
  it('zero-fills missing days between present ones', async () => {
    const db = makeDb([
      {
        date: '2026-05-01',
        sent: 5,
        bounced: 0,
        opens: 2,
        clicks: 1,
      },
      {
        date: '2026-05-03',
        sent: 10,
        bounced: 1,
        opens: 6,
        clicks: 3,
      },
    ])
    const out = await getDailyEmailMetrics(db, 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-03',
    })
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({
      date: '2026-05-01',
      sent: 5,
      delivered: 5,
      bounced: 0,
      opens: 2,
      clicks: 1,
    })
    expect(out[1]).toEqual({
      date: '2026-05-02',
      sent: 0,
      delivered: 0,
      bounced: 0,
      opens: 0,
      clicks: 0,
    })
    expect(out[2]).toEqual({
      date: '2026-05-03',
      sent: 10,
      delivered: 9,        // sent - bounced
      bounced: 1,
      opens: 6,
      clicks: 3,
    })
  })

  it('returns a fully zero-filled week when table is empty', async () => {
    const db = makeDb([])
    const out = await getDailyEmailMetrics(db, 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-07',
    })
    expect(out).toHaveLength(7)
    for (const d of out) {
      expect(d.sent).toBe(0)
      expect(d.delivered).toBe(0)
      expect(d.opens).toBe(0)
      expect(d.clicks).toBe(0)
    }
  })

  it('preserves ISO ordering regardless of input row order', async () => {
    const db = makeDb([
      { date: '2026-05-03', sent: 1, bounced: 0, opens: 0, clicks: 0 },
      { date: '2026-05-01', sent: 2, bounced: 0, opens: 0, clicks: 0 },
    ])
    const out = await getDailyEmailMetrics(db, 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-03',
    })
    expect(out.map((d) => d.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03'])
  })
})

// ---------------------------------------------------------------------------
// §4 Template breakdown — sort + limit
// ---------------------------------------------------------------------------

describe('getTemplateBreakdown', () => {
  const rows = [
    {
      template_key: 'order_confirmation',
      sent: 100, bounced: 2, opens: 60, clicks: 20, unique_opens: 50, unique_clicks: 15,
    },
    {
      template_key: 'abandoned_cart_recovery',
      sent: 40, bounced: 5, opens: 30, clicks: 10, unique_opens: 25, unique_clicks: 8,
    },
    {
      template_key: 'password_reset',
      sent: 60, bounced: 0, opens: 10, clicks: 1, unique_opens: 8, unique_clicks: 1,
    },
  ]

  it('sorts by sent DESC by default', async () => {
    const out = await getTemplateBreakdown(makeDb(rows), 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    })
    expect(out.map((r) => r.templateKey)).toEqual([
      'order_confirmation',
      'password_reset',
      'abandoned_cart_recovery',
    ])
  })

  it('sorts by open_rate when requested', async () => {
    const out = await getTemplateBreakdown(makeDb(rows), 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    }, { orderBy: 'open_rate' })
    // 25/35 (abandoned) vs 50/98 (order) vs 8/60 (password)
    expect(out[0].templateKey).toBe('abandoned_cart_recovery')
    expect(out[2].templateKey).toBe('password_reset')
  })

  it('sorts by click_rate when requested', async () => {
    const out = await getTemplateBreakdown(makeDb(rows), 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    }, { orderBy: 'click_rate' })
    // 8/35 (abandoned) = 22.86 vs 15/98 (order) = 15.31 vs 1/60 (password) = 1.67
    expect(out[0].templateKey).toBe('abandoned_cart_recovery')
    expect(out[2].templateKey).toBe('password_reset')
  })

  it('applies limit (clamped to 1..100)', async () => {
    const out = await getTemplateBreakdown(makeDb(rows), 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    }, { limit: 2 })
    expect(out).toHaveLength(2)
  })

  it('stable tie-break by template_key asc', async () => {
    // Two templates with identical sent counts.
    const tied = [
      { template_key: 'b', sent: 10, bounced: 0, opens: 0, clicks: 0, unique_opens: 0, unique_clicks: 0 },
      { template_key: 'a', sent: 10, bounced: 0, opens: 0, clicks: 0, unique_opens: 0, unique_clicks: 0 },
    ]
    const out = await getTemplateBreakdown(makeDb(tied), 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    })
    expect(out.map((r) => r.templateKey)).toEqual(['a', 'b'])
  })
})

describe('getTopTemplates', () => {
  it('is a thin wrapper with limit=5 default', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      template_key: `t_${i}`,
      sent: 100 - i,
      bounced: 0,
      opens: 0,
      clicks: 0,
      unique_opens: 0,
      unique_clicks: 0,
    }))
    const out = await getTopTemplates(makeDb(rows), 'shop_x', {
      since: '2026-05-01',
      until: '2026-05-31',
    })
    expect(out).toHaveLength(5)
    expect(out[0].templateKey).toBe('t_0')
  })
})
