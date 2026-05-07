import { describe, it, expect } from 'vitest'
import { renderGradeBadge, gradeBadgeCss } from './grade-badge.js'

describe('GradeBadge', () => {
  it('renders the grade letter', () => {
    expect(renderGradeBadge({ grade: 'A' })).toMatch(/>A</)
  })
  it('uses grade-a token for A', () => {
    expect(renderGradeBadge({ grade: 'A' })).toContain('var(--grade-a)')
  })
  it('uses grade-f token for F', () => {
    expect(renderGradeBadge({ grade: 'F' })).toContain('var(--grade-f)')
  })
  it('renders size variants (sm, md, lg)', () => {
    expect(renderGradeBadge({ grade: 'B', size: 'sm' })).toMatch(/gbx-grade[^"]*sm/)
    expect(renderGradeBadge({ grade: 'B', size: 'lg' })).toMatch(/gbx-grade[^"]*lg/)
  })
  it('includes aria-label with score', () => {
    expect(renderGradeBadge({ grade: 'A', score: 92 })).toContain('aria-label="Grade A (92 of 100)"')
  })
  it('includes aria-label without score', () => {
    expect(renderGradeBadge({ grade: 'B' })).toContain('aria-label="Grade B"')
  })
  it('exports gradeBadgeCss with the three size classes', () => {
    expect(gradeBadgeCss).toMatch(/gbx-grade\.sm/)
    expect(gradeBadgeCss).toMatch(/gbx-grade\.md/)
    expect(gradeBadgeCss).toMatch(/gbx-grade\.lg/)
  })
})
