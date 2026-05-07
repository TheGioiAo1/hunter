import { describe, it, expect } from 'vitest'
import { renderReadyBanner, readyBannerCss } from './ready-banner.js'
import type { DashboardJobRow } from '../../clone-pro/dashboard-queries.js'

const job: DashboardJobRow = {
  id: 'job-xyz-123',
  source_url: 'https://shop3.com',
  status: 'succeeded',
  grade: 'A',
  score: 92,
  current_phase: 3,
  phase_progress_pct: 100,
  substep: null,
  cost_cents: 65,
  created_at: new Date(),
  finished_at: new Date(),
  published_at: null,
  error_code: null,
  error_message: null,
  page_count: 48,
}

describe('ReadyBanner', () => {
  it('renders host + score', () => {
    const html = renderReadyBanner({ job, baseUrl: '/admin/store/s1', csrfToken: 'tok' })
    expect(html).toContain('shop3.com')
    expect(html).toContain('92')
  })
  it('uses clone-accent-gradient for background', () => {
    expect(
      renderReadyBanner({ job, baseUrl: '/admin/store/s1', csrfToken: 'tok' }),
    ).toContain('var(--clone-accent-gradient)')
  })
  it('has Preview link to detail page', () => {
    expect(
      renderReadyBanner({ job, baseUrl: '/admin/store/s1', csrfToken: 'tok' }),
    ).toContain('/admin/store/s1/clone-pro/job-xyz-123')
  })
  it('has Publish POST form with action = /publish', () => {
    const html = renderReadyBanner({ job, baseUrl: '/admin/store/s1', csrfToken: 'tok' })
    expect(html).toContain('method="post"')
    expect(html).toContain('/clone-pro/job-xyz-123/publish')
  })
  it('includes CSRF hidden input', () => {
    expect(
      renderReadyBanner({ job, baseUrl: '/admin/store/s1', csrfToken: 'sectok' }),
    ).toContain('value="sectok"')
  })
  it('escapes CSRF token', () => {
    expect(
      renderReadyBanner({ job, baseUrl: '/admin/store/s1', csrfToken: '"><img>' }),
    ).not.toContain('"><img>')
  })
  it('exports readyBannerCss', () => {
    expect(readyBannerCss).toMatch(/gbx-ready-banner/)
  })
})
