/**
 * Unit tests for measurement-queries.ts (M4 — Analytics Dashboards v2)
 *
 * Focuses on the pure helpers that do merge / bucket / offset math.
 * The outer `get*` functions are thin DB wrappers — they are covered
 * by the storefront-admin smoke test after deployment.
 */

import { describe, it, expect } from 'vitest'
import {
  mergeTrafficSources,
  buildFunnel,
  monthDiff,
  buildCohortReport,
} from './measurement-queries.js'

describe('mergeTrafficSources', () => {
  it('joins sessions + orders on (source, medium)', () => {
    const sessions = [
      { source: 'google', medium: 'cpc', sessions: 100, pageviews: 240 },
      { source: 'facebook', medium: 'social', sessions: 40, pageviews: 65 },
    ]
    const orders = [
      { source: 'google', medium: 'cpc', orders: 10, revenue: 1200.5 },
    ]
    const rows = mergeTrafficSources(sessions, orders, 50)
    expect(rows).toHaveLength(2)
    const google = rows.find((r) => r.source === 'google')!
    expect(google.sessions).toBe(100)
    expect(google.pageviews).toBe(240)
    expect(google.orders).toBe(10)
    expect(google.revenue).toBe(1200.5)
    expect(google.conversionRate).toBeCloseTo(0.1)
    const fb = rows.find((r) => r.source === 'facebook')!
    expect(fb.orders).toBe(0)
    expect(fb.conversionRate).toBe(0)
  })

  it('surfaces orders whose UTM never appeared in page_views', () => {
    // e.g. imported orders or historical orders from before page_views
    // table existed.
    const sessions = [{ source: 'google', medium: 'cpc', sessions: 10, pageviews: 10 }]
    const orders = [
      { source: 'google', medium: 'cpc', orders: 1, revenue: 50 },
      { source: 'csv-import', medium: '(none)', orders: 3, revenue: 300 },
    ]
    const rows = mergeTrafficSources(sessions, orders, 50)
    expect(rows).toHaveLength(2)
    const csv = rows.find((r) => r.source === 'csv-import')!
    expect(csv.sessions).toBe(0)
    expect(csv.pageviews).toBe(0)
    expect(csv.orders).toBe(3)
    expect(csv.revenue).toBe(300)
    expect(csv.conversionRate).toBe(0)  // can't compute rate without sessions
  })

  it('sorts by sessions desc, then revenue desc', () => {
    const sessions = [
      { source: 'a', medium: 'x', sessions: 5, pageviews: 5 },
      { source: 'b', medium: 'x', sessions: 10, pageviews: 10 },
      { source: 'c', medium: 'x', sessions: 10, pageviews: 10 },
    ]
    const orders = [
      { source: 'b', medium: 'x', orders: 1, revenue: 50 },
      { source: 'c', medium: 'x', orders: 1, revenue: 200 },
    ]
    const rows = mergeTrafficSources(sessions, orders, 50)
    // Tied on sessions (10 each): 'c' has higher revenue so it wins the tie.
    expect(rows.map((r) => r.source)).toEqual(['c', 'b', 'a'])
  })

  it('respects the limit', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => ({
      source: `src-${i}`,
      medium: 'm',
      sessions: 20 - i,
      pageviews: 20 - i,
    }))
    const rows = mergeTrafficSources(sessions, [], 5)
    expect(rows).toHaveLength(5)
    expect(rows[0]!.source).toBe('src-0')
    expect(rows[4]!.source).toBe('src-4')
  })

  it('returns empty array when both inputs are empty', () => {
    expect(mergeTrafficSources([], [], 50)).toEqual([])
  })
})

describe('buildFunnel', () => {
  it('computes pctOfPrior and pctOfTop for each stage', () => {
    const rows = buildFunnel(1000, 300, 150, 50)
    expect(rows).toHaveLength(4)

    expect(rows[0]!.stage).toBe('visitors')
    expect(rows[0]!.count).toBe(1000)
    expect(rows[0]!.pctOfPrior).toBe(1)
    expect(rows[0]!.pctOfTop).toBe(1)

    expect(rows[1]!.stage).toBe('add_to_cart')
    expect(rows[1]!.count).toBe(300)
    expect(rows[1]!.pctOfPrior).toBeCloseTo(0.3)
    expect(rows[1]!.pctOfTop).toBeCloseTo(0.3)

    expect(rows[2]!.pctOfPrior).toBeCloseTo(0.5)  // 150/300
    expect(rows[2]!.pctOfTop).toBeCloseTo(0.15)   // 150/1000

    expect(rows[3]!.stage).toBe('purchase')
    expect(rows[3]!.pctOfPrior).toBeCloseTo(50 / 150)
    expect(rows[3]!.pctOfTop).toBeCloseTo(0.05)
  })

  it('handles zero visitors without dividing by zero', () => {
    const rows = buildFunnel(0, 0, 0, 0)
    for (const row of rows) {
      expect(row.pctOfPrior).toBe(0)
      expect(row.pctOfTop).toBe(0)
    }
  })

  it('still works when a downstream stage exceeds the prior stage', () => {
    // Can happen when the events table is sparse or data was backfilled
    // out of order — we shouldn't blow up, just show the real numbers.
    const rows = buildFunnel(100, 80, 120, 20)
    expect(rows[2]!.count).toBe(120)
    expect(rows[2]!.pctOfPrior).toBe(1.5)
  })
})

describe('monthDiff', () => {
  it('returns 0 for the same month', () => {
    expect(monthDiff('2026-04-01', '2026-04-15')).toBe(0)
  })

  it('returns 1 for consecutive months in the same year', () => {
    expect(monthDiff('2026-04-01', '2026-05-01')).toBe(1)
  })

  it('handles year boundaries', () => {
    expect(monthDiff('2025-12-01', '2026-02-01')).toBe(2)
  })

  it('returns negative when order is before cohort', () => {
    expect(monthDiff('2026-04-01', '2026-03-01')).toBe(-1)
  })
})

describe('buildCohortReport', () => {
  it('builds retention grid with month-0 always equal to cohort size', () => {
    const customerCohort = new Map<string, string>([
      ['c1', '2026-01-01'],
      ['c2', '2026-01-01'],
      ['c3', '2026-02-01'],
    ])
    const orders = [
      // Jan cohort activity
      { customer_id: 'c1', order_month: '2026-01-01' },
      { customer_id: 'c2', order_month: '2026-01-01' },
      // c1 returns in February
      { customer_id: 'c1', order_month: '2026-02-01' },
      // Feb cohort activity
      { customer_id: 'c3', order_month: '2026-02-01' },
    ]

    const report = buildCohortReport(customerCohort, orders, 3)
    expect(report.cohorts).toHaveLength(2)

    const jan = report.cohorts[0]!
    expect(jan.month).toBe('2026-01-01')
    expect(jan.size).toBe(2)
    // offset 0: both c1 and c2 bought in Jan → 2 customers, 100% retention
    expect(jan.retention[0]!.customers).toBe(2)
    expect(jan.retention[0]!.rate).toBe(1)
    // offset 1: only c1 came back → 1 customer, 50%
    expect(jan.retention[1]!.customers).toBe(1)
    expect(jan.retention[1]!.rate).toBe(0.5)
    // offset 2: nobody → 0%
    expect(jan.retention[2]!.customers).toBe(0)
    expect(jan.retention[2]!.rate).toBe(0)

    const feb = report.cohorts[1]!
    expect(feb.month).toBe('2026-02-01')
    expect(feb.size).toBe(1)
    expect(feb.retention[0]!.customers).toBe(1)
  })

  it('drops orders outside the maxOffset window', () => {
    const customerCohort = new Map([['c1', '2026-01-01']])
    const orders = [
      { customer_id: 'c1', order_month: '2026-01-01' },
      { customer_id: 'c1', order_month: '2027-06-01' },  // offset 17, out of range
    ]
    const report = buildCohortReport(customerCohort, orders, 12)
    const jan = report.cohorts[0]!
    expect(jan.retention).toHaveLength(13)       // 0..12 inclusive
    expect(jan.retention[12]!.customers).toBe(0)
  })

  it('ignores orders from customers not in the cohort map', () => {
    // e.g. customer whose first order was outside our 12-month
    // cohort window — they show up in orderRows but not
    // customerCohort.
    const customerCohort = new Map([['c1', '2026-01-01']])
    const orders = [
      { customer_id: 'c1', order_month: '2026-01-01' },
      { customer_id: 'c99', order_month: '2026-01-01' },  // stranger
    ]
    const report = buildCohortReport(customerCohort, orders, 3)
    expect(report.cohorts[0]!.retention[0]!.customers).toBe(1)
  })

  it('sets rate to 0 for empty cohorts without dividing by zero', () => {
    const report = buildCohortReport(new Map(), [], 3)
    expect(report.cohorts).toEqual([])
    expect(report.maxOffset).toBe(3)
  })
})
