import { describe, it, expect } from 'vitest'
import { renderJobCard, jobCardCss } from './job-card.js'
import type { DashboardJobRow } from '../../clone-pro/dashboard-queries.js'

const base: DashboardJobRow = {
  id: 'abc123',
  source_url: 'https://shop2.com',
  status: 'running',
  grade: null,
  score: null,
  current_phase: 2,
  phase_progress_pct: 45,
  substep: 'Mapping sections',
  cost_cents: 28,
  created_at: new Date(Date.now() - 60_000),
  finished_at: null,
  published_at: null,
  error_code: null,
  error_message: null,
  page_count: null,
}

describe('JobCard', () => {
  it('running variant shows progress bar + percentage', () => {
    const html = renderJobCard({ job: base, variant: 'running', baseUrl: '/admin/store/s1' })
    expect(html).toContain('45%')
    expect(html).toMatch(/width:45%/)
  })
  it('running variant has role=progressbar with aria-valuenow', () => {
    const html = renderJobCard({ job: base, variant: 'running', baseUrl: '/admin/store/s1' })
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="45"')
  })
  it('failed variant shows error message + Resume button', () => {
    const html = renderJobCard({
      job: { ...base, status: 'failed', error_message: 'cloudflare blocked' },
      variant: 'failed',
      baseUrl: '/admin/store/s1',
    })
    expect(html).toContain('cloudflare blocked')
    expect(html).toContain('Resume from')
  })
  it('paused variant uses amber accent', () => {
    expect(
      renderJobCard({
        job: { ...base, status: 'paused' },
        variant: 'paused',
        baseUrl: '/admin/store/s1',
      }),
    ).toContain('var(--status-paused)')
  })
  it('links to detail page', () => {
    expect(
      renderJobCard({ job: base, variant: 'running', baseUrl: '/admin/store/s1' }),
    ).toContain('/admin/store/s1/clone-pro/abc123')
  })
  it('shows Cancel button for running', () => {
    expect(
      renderJobCard({ job: base, variant: 'running', baseUrl: '/admin/store/s1' }),
    ).toContain('Cancel')
  })
  it('escapes source URL host in title', () => {
    expect(
      renderJobCard({
        job: { ...base, source_url: 'https://evil.com/<img>' },
        variant: 'running',
        baseUrl: '/admin/store/s1',
      }),
    ).not.toContain('<img>')
  })
  it('exports jobCardCss', () => {
    expect(jobCardCss).toMatch(/gbx-job-card/)
  })
})
