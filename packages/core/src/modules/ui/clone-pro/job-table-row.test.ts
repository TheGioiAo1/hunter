import { describe, it, expect } from 'vitest'
import { renderJobTableRow, jobTableRowCss } from './job-table-row.js'
import type { DashboardJobRow } from '../../clone-pro/dashboard-queries.js'

const base: DashboardJobRow = {
  id: 'abcdef1234567890',
  source_url: 'https://shop2.com/store',
  status: 'succeeded',
  grade: 'A',
  score: 92,
  current_phase: 3,
  phase_progress_pct: 100,
  substep: null,
  cost_cents: 72,
  created_at: new Date(Date.now() - 3600_000),
  finished_at: new Date(Date.now() - 3000_000),
  published_at: new Date(Date.now() - 2000_000),
  error_code: null,
  error_message: null,
  page_count: 48,
}

describe('JobTableRow', () => {
  it('renders a <tr>', () => {
    expect(renderJobTableRow({ job: base, baseUrl: '/admin/store/s1' })).toMatch(/^\s*<tr/)
  })
  it('shows short job id code', () => {
    expect(renderJobTableRow({ job: base, baseUrl: '/admin/store/s1' })).toContain('abcdef12')
  })
  it('shows hostname', () => {
    expect(renderJobTableRow({ job: base, baseUrl: '/admin/store/s1' })).toContain('shop2.com')
  })
  it('renders status pill using status token', () => {
    expect(
      renderJobTableRow({ job: base, baseUrl: '/admin/store/s1' }),
    ).toContain('var(--status-succeeded)')
  })
  it('includes GradeBadge (grade-a token)', () => {
    expect(renderJobTableRow({ job: base, baseUrl: '/admin/store/s1' })).toContain(
      'var(--grade-a)',
    )
  })
  it('renders em-dash when no grade', () => {
    expect(
      renderJobTableRow({
        job: { ...base, grade: null, score: null },
        baseUrl: '/admin/store/s1',
      }),
    ).toContain('—')
  })
  it('formats cost as dollars', () => {
    expect(renderJobTableRow({ job: base, baseUrl: '/admin/store/s1' })).toContain('$0.72')
  })
  it('renders View link to detail page', () => {
    expect(
      renderJobTableRow({ job: base, baseUrl: '/admin/store/s1' }),
    ).toContain('/admin/store/s1/clone-pro/abcdef1234567890')
  })
  it('escapes source URL', () => {
    expect(
      renderJobTableRow({
        job: { ...base, source_url: 'https://x.com/<img>' },
        baseUrl: '/admin/store/s1',
      }),
    ).not.toContain('<img>')
  })
  it('exports jobTableRowCss', () => {
    expect(jobTableRowCss).toMatch(/gbx-status-pill/)
  })
})
